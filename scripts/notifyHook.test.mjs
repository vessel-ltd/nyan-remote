// ★★ `hooks/notify.sh` keeps its secrets off the command line (security audit 2026-09-28, F6).
//
// ⚠️⚠️ Process arguments are readable by other OS users (`/proc/<pid>/cmdline` is 0444 on Linux, `ps` on mac).
//    The hook token used to ride on curl's `-H` ⇒ another user on the PC could mint a pairing one-time and register a phone.
//    The Discord webhook URL (anyone holding it can post) and the body rode on argv too.
// ⇒ Run the real hook against local fake servers, hold the responses open, and read every curl's argv from `/proc` meanwhile.
//   Also check the servers **did** receive the token, the body and the webhook post (hiding them by not sending is not a fix).
// ⚠️ Linux only (`/proc`). Uses a synthetic token, never the real one.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const HOOK = process.env.NOTIFY_HOOK_UNDER_TEST ?? join(ROOT, 'hooks', 'notify.sh')

const TOKEN = 'audit-synthetic-token-Zq9'
const BODY_MARK = 'body-marker-7Hk2'
const WEBHOOK_MARK = 'webhook-secret-path-Xw4'

/** A server that records one request and answers only after `holdMs` (so curl stays alive to be inspected) */
function holdingServer(holdMs) {
  const got = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      got.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
      setTimeout(() => res.end('ok'), holdMs)
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, got, port: server.address().port })))
}

function curlArgvs() {
  const out = []
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`)
      if (argv.length === 0) continue
      const parts = argv.toString('utf8').split('\0')
      if (parts[0]?.endsWith('curl')) out.push({ pid, parts, argv: parts.join(' ') })
    } catch {
      // the process ended meanwhile
    }
  }
  return out
}

test('★★ notify.sh: token, body and webhook URL never appear in curl argv, yet all are delivered', { skip: !existsSync('/proc/self/cmdline') }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-notify-argv-'))
  const agent = await holdingServer(600)
  const discord = await holdingServer(600)
  try {
    writeFileSync(join(dir, 'token'), `${TOKEN}\n`, { mode: 0o600 })
    const payload = JSON.stringify({ hook_event_name: 'Stop', cwd: `/home/user/${BODY_MARK}` })
    const child = spawn('bash', [HOOK], {
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        CLAUDE_NOTIFY_ENV: join(dir, 'absent.env'),
        NYAN_REMOTE_TOKEN_FILE: join(dir, 'token'),
        NYAN_REMOTE_HOOK_URL: `http://127.0.0.1:${agent.port}/hook`,
        WEBHOOK_DEFAULT: `http://127.0.0.1:${discord.port}/${WEBHOOK_MARK}`,
        NOTIFY_HOST: 'pc-a',
      },
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    child.stdin.end(payload)
    const exited = new Promise((resolve) => child.on('exit', resolve))
    let seen = 0
    const pipes = new Set()
    let done = false
    exited.then(() => (done = true))
    while (!done) {
      for (const { pid, parts, argv } of curlArgvs()) {
        // ★ **Every** curl on the machine is checked for the markers (they are synthetic, so any hit is ours): a curl that
        //   dropped `--config` and put the token back on argv must not slip past (codex 2026-09-28 round 2)
        assert.ok(!argv.includes(TOKEN), `⚠️⚠️ the hook token is on curl's command line: ${argv}`)
        assert.ok(!argv.includes(BODY_MARK), `⚠️ the body is on curl's command line: ${argv}`)
        assert.ok(!argv.includes(WEBHOOK_MARK), `⚠️⚠️ the webhook URL is on curl's command line: ${argv}`)
        // ⚠️ The Discord curl carries no port on its command line (its URL is in the config) ⇒ ours are the ones with a config
        if (!parts.includes('--config')) continue
        seen += 1
        // ⚠️⚠️ ...and the config is a pipe, not a file (a config written to /tmp would keep the secrets off argv yet
        //    leave them in a readable file / codex 2026-09-28)
        const source = parts[parts.indexOf('--config') + 1] ?? ''
        const fd = /^\/dev\/fd\/(\d+)$/.exec(source)
        assert.ok(fd, `⚠️⚠️ curl's config is not a pipe from the hook: ${source}`)
        try {
          const target = readlinkSync(`/proc/${pid}/fd/${fd[1]}`)
          assert.match(target, /^pipe:/, `⚠️⚠️ curl's config is a file: ${target}`)
          pipes.add(pid)
        } catch (e) {
          if (e?.code !== 'ENOENT') throw e
          // the process ended meanwhile
        }
      }
      await new Promise((r) => setTimeout(r, 5))
    }
    assert.equal(await exited, 0)
    // ⚠️ Otherwise the scan proved nothing (curl ended before we looked)
    assert.ok(seen >= 2, `did not catch both curl processes while they ran (saw ${seen})`)
    assert.equal(pipes.size, 2, `⚠️ both curls (agent and webhook) must take their config from a pipe (checked ${pipes.size})`)

    assert.equal(agent.got.length, 1, 'the agent did not receive the hook')
    assert.equal(agent.got[0].headers['x-nyan-remote-token'], TOKEN)
    assert.equal(agent.got[0].headers['content-type'], 'application/json')
    assert.equal(agent.got[0].body, payload, 'the body must reach the agent byte for byte')

    assert.equal(discord.got.length, 1, 'the webhook did not receive the post')
    assert.equal(discord.got[0].url, `/${WEBHOOK_MARK}`)
    assert.match(JSON.parse(discord.got[0].body).content, new RegExp(BODY_MARK))
  } finally {
    agent.server.close()
    discord.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★ notify.sh (Discord) reads a plan limit by the same rule as the agent (isClaudeLimitStop)', async () => {
  const { CLAUDE_CREDITS_RAN_OUT, CLAUDE_NOT_A_LIMIT, isClaudeLimitStop } = await import('../shared/types.ts')
  const src = readFileSync(HOOK, 'utf8')
  const expr = src.match(/jq -r '(\(\(\.last_assistant_message[^']*)'/)?.[1]
  assert.ok(expr, 'the limit check is missing from notify.sh')
  for (const w of [...CLAUDE_NOT_A_LIMIT, CLAUDE_CREDITS_RAN_OUT]) assert.ok(expr.includes(`contains("${w}")`), `⚠️⚠️ notify.sh does not know "${w}"`)
  assert.equal((expr.match(/contains\(/g) ?? []).length, CLAUDE_NOT_A_LIMIT.length + 1, '⚠️⚠️ notify.sh has words the agent does not')
  const { execFileSync } = await import('node:child_process')
  const run = (o) => execFileSync('jq', ['-r', expr], { input: JSON.stringify(o) }).toString().trim()
  const cases = [
    { error: 'rate_limit', last_assistant_message: "You've hit your 5-hour limit · resets 7:40am" },
    { error: 'rate_limit', last_assistant_message: 'Usage is paused for your organization.' },
    { error: 'rate_limit', last_assistant_message: 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited' },
    { error: 'rate_limit', last_assistant_message: 'Claude is temporarily limiting requests to the usage page (Not Your Usage Limit)' },
    { error: 'rate_limit', last_assistant_message: 'Opus is experiencing high load. Switch to Sonnet.' },
    { error: 'rate_limit', last_assistant_message: 'API Error: Request rejected (429) · Too many requests, retry in 10 seconds' },
    { error: 'unknown', last_assistant_message: 'API Error: Usage credits ran out before the response was finished.' },
    { error: 'unknown', last_assistant_message: 'API Error: something else' },
    { error: 'server_error', last_assistant_message: "You've hit your limit" },
    { error: 'rate_limit' },
    { error: 'rate_limit', last_assistant_message: 42 },
  ]
  for (const c of cases) {
    assert.equal(run(c) === 'limit', isClaudeLimitStop(c.error, c.last_assistant_message), `⚠️⚠️ notify.sh and the agent disagree on ${JSON.stringify(c)}`)
  }
  assert.equal(run(cases[0]), 'limit')
  assert.equal(run(cases[2]), '')
})
