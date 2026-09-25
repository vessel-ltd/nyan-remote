// ★★ **Actually run** `pair.mjs` (2026-09-22).
//
// ⚠️⚠️ **It runs on users' machines yet had not a single test** (the same hole as `install.sh`).
//   And it actually broke: when `--image` was added, **it shipped with an import missing**.
//   `node --check` **only checks syntax**, so it passed, and neither `npm test` nor `npm run typecheck`
//   looked at this file at all ⇒ **the `ReferenceError` only appeared when run**.
//
// ★ We also measured catching it by type checking (2026-09-22): putting `scripts/` under `checkJs`
//   gives 274 existing errors with `strict:true` and 33 with `strictNullChecks` alone
//   (mostly noise from untyped JS and false errors from the missing DOM lib). ⇒ **Not now**.
//   Instead, **run the real thing** (this file). ⬜ Type checking separately.
//
// ★ How it runs: create a fake agent (answers only `/pair/token`) and a throwaway state directory, then
//   start **the script itself**.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { QR_TRAILING_LINES } from './lib/qrMode.mjs'

const SCRIPT = new URL('./pair.mjs', import.meta.url).pathname
const TOKEN = 'test-hook-token'

/** ★ Fake agent that answers only `/pair/token` (⚠️ checks the real hook token) */
async function fakeAgent(expiresInMs) {
  const seen = []
  const server = createServer((req, res) => {
    seen.push({ url: new URL(req.url, 'http://x').pathname, token: req.headers['x-nyan-remote-token'] })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        url: `nyan://pair?v=1&a=${'B'.repeat(87)}&t=${'T'.repeat(32)}&n=test`,
        expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
        machine: 'test-machine',
      }),
    )
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, seen, port: server.address().port }
}

function stateDir() {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-pair-test-'))
  writeFileSync(join(dir, 'hook-token'), TOKEN)
  return dir
}

/** ⚠️ `--image` waits for Enter, so **feed a newline on stdin** to finish it */
function run(args, env) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env: { ...process.env, NYAN_LANG: 'ja', NYAN_REMOTE_NO_OPEN: '1', ...env }, timeout: 20000 },
      // ⚠️⚠️ **Do not look only at `err.code`** — when killed by a timeout, `code` is `undefined` and
      //    `?? 0` **turns it into success** (noticed on 2026-09-22 when a mutation survived).
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, signal: err?.signal ?? null, stdout, stderr }),
    )
    child.stdin.end('\n')
  })
}

test('★★ `npm run pair` runs to completion (⚠️ kills a missing import)', async () => {
  const agent = await fakeAgent(300000)
  const dir = stateDir()
  try {
    const out = await run([], { NYAN_REMOTE_STATE_DIR: dir, NYAN_REMOTE_PORT: String(agent.port) })
    assert.equal(out.signal, null, `⚠️ killed by the timeout (still waiting): ${out.stderr}`)
    assert.equal(out.code, 0, `crashed: ${out.stderr}`)
    // ⚠️ It identifies with the hook token (= calls this machine's local-only endpoint correctly)
    assert.equal(agent.seen[0]?.token, TOKEN, 'did not send the hook token')
    assert.match(out.stdout, /nyan:\/\/pair/, 'did not print nyan://')
    // ⚠️⚠️ No exception text mixed in (this is where the `ReferenceError` showed up)
    assert.doesNotMatch(out.stderr, /ReferenceError|TypeError/, `an exception was printed: ${out.stderr}`)
  } finally {
    agent.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★ `--image` creates the image and removes it when done (⚠️ leaves no one-time token)', async () => {
  const agent = await fakeAgent(300000)
  const dir = stateDir()
  const base = mkdtempSync(join(tmpdir(), 'nyan-pair-base-'))
  try {
    // ★★ **Judge by elapsed time** (2026-09-23 / it was a false green).
    //   ⚠️⚠️ `out.signal` cannot tell: pair.mjs's **SIGTERM cleanup turns the kill into a "normal exit (0)"**,
    //      so even when killed by a timeout both signal and code look successful.
    //      In fact "does not exit after Enter until the deadline (5 min)" slipped past this check (codex round 13, low #5).
    const began = Date.now()
    const out = await run(['--image'], {
      NYAN_REMOTE_STATE_DIR: dir,
      NYAN_REMOTE_PORT: String(agent.port),
      TMPDIR: base,
    })
    assert.ok(Date.now() - began < 8000, `⚠️⚠️ does not exit after Enter (${Date.now() - began}ms = lingering until the deadline)`)
    assert.equal(out.code, 0, `crashed: ${out.stderr}`)
    assert.doesNotMatch(out.stderr, /ReferenceError|TypeError/, `an exception was printed: ${out.stderr}`)
    // ★ It says where the image is (⚠️ never create it silently)
    assert.match(out.stdout, /pair\.png/, 'did not print the image location')
    // ★★ ⚠️⚠️ **It is gone when finished** (the one-time token does not stay on disk)
    assert.deepEqual(imageDirs(base), [], '⚠️⚠️ temp files were left (the one-time token stays on disk)')
  } finally {
    agent.server.close()
    rmSync(dir, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

/**
 * ★★ **Give the child its own `TMPDIR`** (hit on 2026-09-22).
 *
 * ⚠️⚠️ It used to look into `os.tmpdir()` directly, so **it picked up temp directories created by
 *    other tests running in parallel and failed** (`npm test` runs files in parallel).
 *    = **it was a check against a shared namespace**.
 * ⇒ Create a parent directory per test and confine it there with `TMPDIR`
 *    (`os.tmpdir()` reads `TMPDIR` on POSIX). ⇒ Only look at **what our own child created**.
 */
function imageDirs(base) {
  return readdirSync(base).filter((f) => f.startsWith('nyan-pair-'))
}

test('★★ `--image` **waits** while scanning (⚠️ with `unref()` it exits without waiting)', async () => {
  // ⚠️⚠️ Hit for real: the timer was `unref()`'d, so it **removed the image itself and exited
  //    before it was opened** (= nothing was visible).
  // ★ So check that "it stays alive until the deadline even if nothing arrives on stdin".
  const agent = await fakeAgent(1500)
  const dir = stateDir()
  const began = Date.now()
  try {
    const out = await new Promise((resolve) => {
      // ⚠️⚠️ **Make stdin EOF immediately** (the `< /dev/null` or pipe shape).
      //    ★ This is the crux: leaving it open means **stdin itself keeps the process alive**, so
      //      the mutation that `unref()`s the timer **survives** (it actually survived on 2026-09-22).
      //      What I hit was the `< /dev/null` shape too = **test under the conditions that reproduce it**.
      const child = execFile(
        process.execPath,
        [SCRIPT, '--image'],
        {
          env: {
            ...process.env,
            NYAN_LANG: 'ja',
            NYAN_REMOTE_NO_OPEN: '1',
            NYAN_REMOTE_STATE_DIR: dir,
            NYAN_REMOTE_PORT: String(agent.port),
          },
          timeout: 20000,
        },
        (err, stdout, stderr) => resolve({ code: err?.code ?? 0, signal: err?.signal ?? null, stdout, stderr }),
      )
      child.stdin.end()
    })
    const took = Date.now() - began
    assert.equal(out.signal, null, `⚠️ killed by the timeout (still waiting): ${out.stderr}`)
    assert.equal(out.code, 0, `crashed: ${out.stderr}`)
    assert.ok(took >= 1200, `⚠️⚠️ exited without waiting (${took}ms) = removed before the image is seen`)
  } finally {
    agent.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★ removes the image on Ctrl-C too (⚠️ leaves no one-time token on disk)', async () => {
  // ⚠️⚠️ Checking only the normal-exit path is not enough (the explicit `cleanup()` covers that).
  //    Whether it remains **when stopped midway** decides the one-time token's exposure.
  const agent = await fakeAgent(300000)
  const dir = stateDir()
  const base = mkdtempSync(join(tmpdir(), 'nyan-pair-base-'))
  try {
    const child = execFile(process.execPath, [SCRIPT, '--image'], {
      env: {
        ...process.env,
        NYAN_LANG: 'ja',
        NYAN_REMOTE_NO_OPEN: '1',
        NYAN_REMOTE_STATE_DIR: dir,
        NYAN_REMOTE_PORT: String(agent.port),
        TMPDIR: base,
      },
      timeout: 20000,
    })
    const done = new Promise((r) => child.on('exit', r))
    // ★ Wait until the image exists (⚠️ killing it before then means this check sees nothing)
    let made = []
    for (let i = 0; i < 100 && made.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50))
      made = imageDirs(base)
    }
    assert.ok(made.length > 0, 'no image was created (this check is not testing anything)')
    child.kill('SIGINT')
    await done
    assert.deepEqual(imageDirs(base), [], '⚠️⚠️ the image remained after Ctrl-C (the one-time token stays on disk)')
  } finally {
    agent.server.close()
    rmSync(dir, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ New agents (returning an `id`): exit automatically once registered, cancel on Ctrl-C (2026-09-23)
// ─────────────────────────────────────────────────────────────────────────────

/** ★ Fake agent that returns an id. Returns `states` one at a time (then keeps returning the last one) */
async function fakeAgentV2(states, { issueDelayMs = 0, expiresInMs = 300000 } = {}) {
  const seen = []
  let i = 0
  const server = createServer(async (req, res) => {
    // ★ The CLI adds `?lang=` (tells the agent its language) ⇒ match on the path only and record the language separately
    const u = new URL(req.url, 'http://x')
    const path = u.pathname
    seen.push({ method: req.method, url: path, lang: u.searchParams.get('lang'), token: req.headers['x-nyan-remote-token'] })
    if (req.method === 'POST' && path === '/pair/token' && issueDelayMs > 0) {
      await new Promise((r) => setTimeout(r, issueDelayMs))
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.method === 'POST' && path === '/pair/token') {
      res.end(
        JSON.stringify({
          url: `nyan://pair?v=1&a=${'B'.repeat(87)}&t=${'T'.repeat(32)}&n=test`,
          token: 'T'.repeat(32),
          expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
          machine: 'test-machine',
          id: 'ID123',
        }),
      )
    } else if (req.method === 'GET' && path === '/pair/token/ID123') {
      res.end(JSON.stringify(states[Math.min(i++, states.length - 1)]))
    } else if (req.method === 'POST' && path === '/pair/token/ID123/cancel') {
      res.end(JSON.stringify({ cancelled: true }))
    } else {
      res.writeHead(404)
      res.end('{}')
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, seen, port: server.address().port }
}

test('★★ exits automatically once registered and says which device (removes the image too)', async () => {
  const waiting = { state: 'waiting', expiresAt: new Date(Date.now() + 300000).toISOString() }
  const agent = await fakeAgentV2([waiting, waiting, { state: 'registered', deviceId: 'abcd1234', label: 'スマホ', already: false }])
  const dir = stateDir()
  const base = mkdtempSync(join(tmpdir(), 'nyan-pair-base-'))
  try {
    const out = await run(['--image'], { NYAN_REMOTE_STATE_DIR: dir, NYAN_REMOTE_PORT: String(agent.port), TMPDIR: base })
    assert.equal(out.code, 0, `crashed: ${out.stderr}`)
    assert.match(out.stdout, /✅ 登録されました: スマホ（abcd1234）/)
    assert.deepEqual(imageDirs(base), [], '⚠️⚠️ temp files were left')
    // ⚠️⚠️ What we ask with is **the id**. The one-time token is in no query URL
    const polls = agent.seen.filter((s) => s.method === 'GET')
    assert.ok(polls.length >= 3, `did not keep asking: ${polls.length}`)
    for (const s of agent.seen) {
      assert.doesNotMatch(s.url, /TTTT/, '⚠️⚠️ put the one-time token in the URL')
      assert.equal(s.token, TOKEN, '⚠️ did not identify with the hook token (this machine\'s local-only endpoint)')
    }
  } finally {
    agent.server.close()
    rmSync(dir, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

test('★★ non-Japanese locales print English (⚠️ no Japanese for overseas users / 2026-09-24)', async () => {
  const waiting = { state: 'waiting', expiresAt: new Date(Date.now() + 300000).toISOString() }
  const agent = await fakeAgentV2([waiting, { state: 'registered', deviceId: 'abcd1234', label: 'phone', already: false }])
  const dir = stateDir()
  const base = mkdtempSync(join(tmpdir(), 'nyan-pair-base-'))
  try {
    const out = await run(['--image'], {
      NYAN_LANG: '',
      LC_ALL: '',
      LC_MESSAGES: '',
      LANG: 'C.UTF-8',
      NYAN_REMOTE_STATE_DIR: dir,
      NYAN_REMOTE_PORT: String(agent.port),
      TMPDIR: base,
    })
    assert.equal(out.code, 0, `crashed: ${out.stderr}`)
    assert.match(out.stdout, /✅ Registered: phone \(abcd1234\)/)
    assert.doesNotMatch(out.stdout + out.stderr, /[\u3040-\u30ff\u4e00-\u9fff]/, `⚠️⚠️ Japanese was printed: ${out.stdout}${out.stderr}`)
    // ★★ It asks the agent for English too (otherwise the agent answers reasons in **the machine's language** / codex round 22, medium #1)
    assert.ok(agent.seen.length > 0 && agent.seen.every((r) => r.lang === 'en'), JSON.stringify(agent.seen))
  } finally {
    agent.server.close()
    rmSync(dir, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

test('★★ Ctrl-C cancels the one-time token (removes the image too)', async () => {
  const waiting = { state: 'waiting', expiresAt: new Date(Date.now() + 300000).toISOString() }
  const agent = await fakeAgentV2([waiting])
  const dir = stateDir()
  const base = mkdtempSync(join(tmpdir(), 'nyan-pair-base-'))
  try {
    let stdout = ''
    const child = execFile(process.execPath, [SCRIPT, '--image'], {
      env: { ...process.env, NYAN_LANG: 'ja', NYAN_REMOTE_NO_OPEN: '1', NYAN_REMOTE_STATE_DIR: dir, NYAN_REMOTE_PORT: String(agent.port), TMPDIR: base },
      timeout: 20000,
    })
    child.stdout.on('data', (d) => (stdout += d))
    const done = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })))
    // ★ Stop once it is waiting (⚠️ killing it before then means this check sees nothing)
    for (let i = 0; i < 100 && !agent.seen.some((s) => s.method === 'GET'); i++) await new Promise((r) => setTimeout(r, 50))
    assert.ok(agent.seen.some((s) => s.method === 'GET'), 'never started waiting (not testing anything)')
    child.kill('SIGINT')
    const ended = await done
    assert.equal(ended.code, 130, `wrong way of ending: ${JSON.stringify(ended)}`)
    assert.ok(agent.seen.some((s) => s.method === 'POST' && s.url === '/pair/token/ID123/cancel'), '⚠️⚠️ did not send the cancellation')
    assert.match(stdout, /やめました/)
    assert.deepEqual(imageDirs(base), [], '⚠️⚠️ the image remained')
  } finally {
    agent.server.close()
    rmSync(dir, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})

test('★★★ cancelled, expired or failed: says so and exits 1', async () => {
  for (const [st, want] of [
    [{ state: 'expired' }, /期限が切れました/],
    [{ state: 'cancelled' }, /取り消されました/],
    [{ state: 'failed', reason: '保存に失敗しました' }, /登録に失敗しました: 保存に失敗しました/],
  ]) {
    const agent = await fakeAgentV2([st])
    const dir = stateDir()
    try {
      const out = await run([], { NYAN_REMOTE_STATE_DIR: dir, NYAN_REMOTE_PORT: String(agent.port) })
      assert.equal(out.code, 1, `${st.state}: wrong exit code: ${out.stderr}`)
      assert.match(out.stdout, want)
    } finally {
      agent.server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('★★ a Ctrl-C while issuing still cancels once the issue returns, then exits (codex round 15, medium #2)', async () => {
  // ⚠️⚠️ The handler used to be set up after the QR was printed, so a Ctrl-C before that exited **without sending a cancellation**
  const agent = await fakeAgentV2([{ state: 'waiting', expiresAt: new Date(Date.now() + 300000).toISOString() }], { issueDelayMs: 800 })
  const dir = stateDir()
  try {
    const child = execFile(process.execPath, [SCRIPT], {
      env: { ...process.env, NYAN_LANG: 'ja', NYAN_REMOTE_NO_OPEN: '1', NYAN_REMOTE_STATE_DIR: dir, NYAN_REMOTE_PORT: String(agent.port) },
      timeout: 20000,
    })
    const done = new Promise((r) => child.on('exit', (code) => r(code)))
    // ★ Stop right after requesting the issue (before it returns)
    for (let i = 0; i < 100 && !agent.seen.some((s) => s.url === '/pair/token'); i++) await new Promise((r) => setTimeout(r, 20))
    assert.ok(agent.seen.some((s) => s.url === '/pair/token'), 'never requested the issue (not testing anything)')
    const began = Date.now()
    child.kill('SIGINT')
    assert.equal(await done, 130)
    // ⚠️⚠️ **Judge by elapsed time** (even a timeout kill makes the SIGTERM cleanup send the cancellation and end with 130 = a false green)
    assert.ok(Date.now() - began < 5000, `⚠️⚠️ does not exit after Ctrl-C (${Date.now() - began}ms)`)
    assert.ok(
      agent.seen.some((s) => s.method === 'POST' && s.url === '/pair/token/ID123/cancel'),
      '⚠️⚠️ a Ctrl-C while issuing did not send the cancellation',
    )
  } finally {
    agent.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★★ keeps waiting while registering (waiting for the save; never says expired / codex round 15, medium #1)', async () => {
  const agent = await fakeAgentV2([
    { state: 'registering' },
    { state: 'registering' },
    { state: 'registered', deviceId: 'abcd1234', label: 'スマホ', already: false },
  ])
  const dir = stateDir()
  try {
    const out = await run([], { NYAN_REMOTE_STATE_DIR: dir, NYAN_REMOTE_PORT: String(agent.port) })
    assert.equal(out.code, 0, out.stdout)
    assert.match(out.stdout, /✅ 登録されました/)
  } finally {
    agent.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★★ the QR comes last (at most QR_TRAILING_LINES lines after it / codex round 15, low #5)', async () => {
  // ⚠️ With long guidance after it, even on a terminal judged "fits" the top of the QR scrolls off the screen
  const agent = await fakeAgentV2([{ state: 'registered', deviceId: 'abcd1234', label: 'スマホ', already: false }])
  const dir = stateDir()
  try {
    // ★ Not a terminal (pipe), so a text QR (⚠️ mac draws no QR, so this check would be empty ⇒ skip)
    if (process.platform === 'darwin') return
    const out = await run([], { NYAN_REMOTE_STATE_DIR: dir, NYAN_REMOTE_PORT: String(agent.port) })
    const lines = out.stdout.replace(/\n+$/, '').split('\n')
    // ⚠️ The last QR row is margin (spaces only), so detect it by **the color codes**, not block characters
    const lastQr = lines.findLastIndex((l) => l.includes('\u001b[30;107m'))
    assert.ok(lastQr > 0, 'no QR was printed (this check is not testing anything)')
    const after = lines.length - 1 - lastQr
    assert.ok(after <= QR_TRAILING_LINES, `⚠️⚠️ ${after} lines printed after the QR: ${JSON.stringify(lines.slice(lastQr + 1))}`)
    // ★ The URL and expiry come before the QR (⚠️ not removed)
    assert.ok(lines.findIndex((l) => l.startsWith('nyan://pair')) < lastQr)
  } finally {
    agent.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★★ expiry is decided by the agent\'s answer (succeeds if registered even when the local clock is past / codex round 16, medium #5)', async () => {
  // ⚠️⚠️ When registration finished just before expiry, it used to end with "expired" without asking again
  const agent = await fakeAgentV2(
    [{ state: 'waiting', expiresAt: new Date().toISOString() }, { state: 'registered', deviceId: 'abcd1234', label: 'スマホ', already: false }],
    { expiresInMs: -1000 },
  )
  const dir = stateDir()
  try {
    const out = await run([], { NYAN_REMOTE_STATE_DIR: dir, NYAN_REMOTE_PORT: String(agent.port) })
    assert.equal(out.code, 0, `⚠️⚠️ registered but ended as a failure: ${out.stdout}`)
    assert.match(out.stdout, /✅ 登録されました/)
  } finally {
    agent.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
