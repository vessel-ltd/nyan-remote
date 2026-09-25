// ★★ Run `pending.mjs` (the guard that checks for pending approvals before a restart) **as the real thing** (2026-09-23).
//
// ⚠️⚠️ It used to identify only with the tailnet login name, so on relay-only machines (machine C, mac)
//   **it failed every time and checked nothing**. Worse, "cannot identify" and "approvals pending" shared
//   **the same exit code 1**, so the one-line update chained with `&&` could not tell them apart.
// ★ What this checks: ① the identification order (hook token → tailnet if refused) ② the exit code contract.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const SCRIPT = new URL('./pending.mjs', import.meta.url).pathname
const TOKEN = 'tok-123'
const LOGIN = 'k@example.com'

/**
 * ★ Fake agent that answers only `/permissions`.
 * @param accept which identification to accept ('token' / 'login' / 'none')
 */
async function fakeAgent(accept, permissions = []) {
  const seen = []
  const server = createServer((req, res) => {
    const token = req.headers['x-nyan-remote-token']
    const login = req.headers['tailscale-user-login']
    seen.push(token ? 'token' : login ? 'login' : 'none')
    const ok = (accept === 'token' && token === TOKEN) || (accept === 'login' && login === LOGIN)
    if (!ok) {
      res.writeHead(401).end('だめ')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ permissions, quiet: 0, autoApprove: [] }))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, seen, port: server.address().port }
}

function stateDir({ token = true, login = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-pending-test-'))
  if (token) writeFileSync(join(dir, 'hook-token'), TOKEN)
  writeFileSync(join(dir, 'config.json'), JSON.stringify(login ? { allowedLogins: [LOGIN] } : {}))
  return dir
}

function run(env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT], { env: { ...process.env, NYAN_LANG: 'ja', ...env }, timeout: 15000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (err.code ?? -1) : 0, stdout, stderr }),
    )
  })
}

async function withAgent(accept, opts, permissions, fn, env = {}) {
  const agent = await fakeAgent(accept, permissions)
  const dir = stateDir(opts)
  try {
    return await fn(await run({ NYAN_REMOTE_STATE_DIR: dir, NYAN_REMOTE_PORT: String(agent.port), ...env }), agent)
  } finally {
    agent.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('★★ relay-only machine (no tailnet) can still check with the hook token → 0', async () => {
  await withAgent('token', { token: true, login: false }, [], (out, agent) => {
    assert.equal(out.code, 0, `⚠️⚠️ not checked: ${out.stderr}`)
    assert.deepEqual(agent.seen, ['token'], 'did not identify with the hook token')
  })
})

test('★★ pending approvals give 1 (⚠️ never mixed with "cannot check")', async () => {
  const p = [{ at: new Date().toISOString(), account: '.claude', project: 'x', toolName: 'Bash', summary: 'ls' }]
  await withAgent('token', { token: true }, p, (out) => {
    assert.equal(out.code, 1)
    assert.match(out.stdout, /承認待ち 1 件/)
  })
})

test('★★ non-Japanese locales print English (same exit codes / 2026-09-24)', async () => {
  const p = [{ at: new Date().toISOString(), account: '.claude', project: 'x', toolName: 'Bash', summary: 'ls' }]
  const en = { NYAN_LANG: '', LC_ALL: '', LC_MESSAGES: '', LANG: 'C' }
  await withAgent(
    'token',
    { token: true },
    p,
    (out) => {
      assert.equal(out.code, 1)
      assert.match(out.stdout, /Pending approvals: 1/)
      assert.doesNotMatch(out.stdout + out.stderr, /[\u3040-\u30ff\u4e00-\u9fff]/, `⚠️⚠️ Japanese was printed: ${out.stdout}`)
    },
    en,
  )
  await withAgent('token', { token: true }, [], (out) => {
    assert.equal(out.code, 0)
    assert.match(out.stdout, /none ✔ safe to restart/)
  }, en)
})

test('★★ an old agent (refuses the token) gets a retry with the tailnet login name → 0', async () => {
  // ⚠️⚠️ The one-line update runs as "new pending.mjs × still-old agent". Without the retry the update stops
  await withAgent('login', { token: true, login: true }, [], (out, agent) => {
    assert.equal(out.code, 0, `did not retry the identification: ${out.stderr}`)
    assert.deepEqual(agent.seen, ['token', 'login'], 'wrong order (hook token → tailnet)')
  })
})

test('★★ refused both ways gives 3 (⚠️ not 1)', async () => {
  await withAgent('none', { token: true, login: true }, [], (out) => {
    assert.equal(out.code, 3, '⚠️⚠️ returns another exit code although it could not check')
  })
})

test('★★★ nothing to identify with gives 3', async () => {
  await withAgent('token', { token: false, login: false }, [], (out) => {
    assert.equal(out.code, 3)
    assert.match(out.stderr, /名乗る材料がありません/)
  })
})

test('★★★ cannot reach the agent gives 2 (stopped = no pending approvals either)', async () => {
  const dir = stateDir()
  try {
    // ⚠️ A port that should be unused (listened on and closed immediately)
    const probe = await fakeAgent('token')
    const port = probe.port
    await new Promise((r) => probe.server.close(r))
    const out = await run({ NYAN_REMOTE_STATE_DIR: dir, NYAN_REMOTE_PORT: String(port) })
    assert.equal(out.code, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ★★ codex round 13, medium #4: an exception on an unexpected response makes Node **exit with 1** =
//   indistinguishable from "approvals pending", which wrongly stopped install.sh's update.
async function rawAgent(handler) {
  const server = createServer(handler)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: server.address().port }
}

for (const [name, body] of [
  ['broken JSON', '{'],
  ['an empty object', '{}'],
  ['permissions that is not an array', '{"permissions":"x"}'],
]) {
  test(`★★ a response of ${name} gives 3 (⚠️ not 1 = "approvals pending")`, async () => {
    const agent = await rawAgent((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(body)
    })
    const dir = stateDir()
    try {
      const out = await run({ NYAN_REMOTE_STATE_DIR: dir, NYAN_REMOTE_PORT: String(agent.port) })
      assert.equal(out.code, 3, `⚠️⚠️ exit code ${out.code} (with 1, install.sh stops as "approvals pending"): ${out.stderr}`)
    } finally {
      agent.server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test('★★ an agent that does not respond gives 3 (⚠️ never say "stopped (2)")', async () => {
  // ⚠️ On WSL a dead port **does not fail immediately but hangs** = indistinguishable from a live agent that is stuck
  const agent = await rawAgent(() => {
    /* ★ never reply */
  })
  const dir = stateDir()
  try {
    const out = await run({ NYAN_REMOTE_STATE_DIR: dir, NYAN_REMOTE_PORT: String(agent.port) })
    assert.equal(out.code, 3, `⚠️⚠️ treats a timeout as "stopped": ${out.stderr}`)
  } finally {
    agent.server.closeAllConnections?.()
    agent.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ★★ Test the net (uncaught exceptions) itself. ⚠️ With inputs, **everything is caught earlier** so the net is never reached
//   (= a mutation making the net return 1 survived). ⇒ Replace `fetch` to raise "an unexpected exception" directly.
function preload(dir, bodyExpr) {
  const f = join(dir, 'preload.mjs')
  writeFileSync(
    f,
    `globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => (${bodyExpr}) })\n`,
  )
  return f
}
function runWith(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [...args, SCRIPT], { env: { ...process.env, NYAN_LANG: 'ja', ...env }, timeout: 15000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (err.code ?? -1) : 0, stdout, stderr }),
    )
  })
}

test('★★ an unexpected exception before presence is known gives 3 (⚠️ not 1 = "approvals pending")', async () => {
  const dir = stateDir()
  try {
    const f = preload(dir, `{ get permissions() { throw new Error('想定外') } }`)
    const out = await runWith(['--import', `file://${f}`], { NYAN_REMOTE_STATE_DIR: dir })
    assert.equal(out.code, 3, `⚠️⚠️ the net returned ${out.code}: ${out.stderr}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★ an exception after pending approvals are known gives 1 (⚠️ 3 would let install.sh proceed and kill the approval)', async () => {
  const dir = stateDir()
  try {
    const f = preload(dir, `{ permissions: [{}], get quiet() { throw new Error('想定外') } }`)
    const out = await runWith(['--import', `file://${f}`], { NYAN_REMOTE_STATE_DIR: dir })
    assert.equal(out.code, 1, `⚠️⚠️ returned ${out.code} although approvals exist (it would proceed): ${out.stderr}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★★ even with a malformed list, stops with 1 if something exists (does not crash while printing)', async () => {
  const agent = await rawAgent((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"permissions":[{}]}')
  })
  const dir = stateDir()
  try {
    const out = await run({ NYAN_REMOTE_STATE_DIR: dir, NYAN_REMOTE_PORT: String(agent.port) })
    assert.equal(out.code, 1)
    assert.match(out.stdout, /承認待ち 1 件/)
  } finally {
    agent.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★★ says why when the shape is wrong (⚠️ leaving it to the net hides the reason)', async () => {
  const agent = await rawAgent((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  const dir = stateDir()
  try {
    const out = await run({ NYAN_REMOTE_STATE_DIR: dir, NYAN_REMOTE_PORT: String(agent.port) })
    assert.equal(out.code, 3)
    assert.match(out.stderr, /応答の形が想定と違います/, 'crashed into the net without saying why')
  } finally {
    agent.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★ pending (quiet) approvals exist but printing crashes → still 1 (⚠️ codex round 14, high #1 = a regression of the net)', async () => {
  // ⚠️⚠️ The flag only looked at `permissions`, so an exception with `quiet > 0` gave 3 =
  //    install.sh **proceeded and killed a live approval** (the parent commit gave 1; the fix turned it into 3)
  const dir = stateDir()
  try {
    const f = preload(dir, `{ permissions: [], quiet: 1, get autoApprove() { throw new Error('想定外') } }`)
    const out = await runWith(['--import', `file://${f}`], { NYAN_REMOTE_STATE_DIR: dir })
    assert.equal(out.code, 1, `⚠️⚠️ pending approvals exist but got ${out.code}: ${out.stderr}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★★ does not crash when the auto-approve list is malformed (the input codex used)', async () => {
  const agent = await rawAgent((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"permissions":[],"quiet":1,"autoApprove":[null]}')
  })
  const dir = stateDir()
  try {
    const out = await run({ NYAN_REMOTE_STATE_DIR: dir, NYAN_REMOTE_PORT: String(agent.port) })
    assert.equal(out.code, 1, `pending approvals exist but got ${out.code}: ${out.stderr}`)
  } finally {
    agent.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
