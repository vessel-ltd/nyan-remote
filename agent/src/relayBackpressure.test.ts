// Relay backpressure (`scripts/relay.py`).
//
// ★★ What it protects: **when the terminal stops reading, stop reading from the child.**
//
// ⚠️ Without it, behaviour differs from plain claude:
//    plain: "terminal does not read → the child's write blocks → the child stops".
//    with the relay: "the relay keeps reading and piling into its own buffer → the child keeps running".
//    Measured RSS grew to 14MB (2026-08-23). In theory it keeps growing as long as the terminal is frozen.
//
// ⚠️⚠️ **It cannot be verified through a channel that logs to the screen (stderr)** (that is the clogged side,
//    so the logs themselves clog). ⇒ Have it log to a file with `RELAY_LOG=<path>` and look there.
//
// Setup:
//   script (creates a pty) → relay.py → a child producing lots of output
//   script's stdout is **a pipe nobody reads** ⇒ the pty fills up and the relay's writes stop

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const RELAY = join(import.meta.dirname, '..', '..', 'scripts', 'relay.py')
const hasScript = spawnSync('script', ['--version']).status === 0
const hasPython = spawnSync('python3', ['-c', 'pass']).status === 0

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/**
 * A wait for cutting off. ⚠️ **Add `unref`**.
 * Without it, the timer remains even after it settles first and the test does not end
 * (hit twice on 2026-08-23; the tests ran 30 seconds and 60 seconds longer).
 */
const deadline = (ms: number) =>
  new Promise<void>((r) => {
    setTimeout(() => r(), ms).unref()
  })

test('★★ when the screen clogs, stop reading from the child (backpressure)', { skip: !hasScript || !hasPython }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-remote-bp-'))
  const logPath = join(dir, 'relay.log')
  const producer = join(dir, 'produce.sh')
  // a child spewing 50MB at once (⚠️ well above the limit)
  writeFileSync(producer, '#!/bin/sh\nhead -c 50000000 /dev/zero | tr "\\0" x\n')
  chmodSync(producer, 0o755)

  const proc = spawn('script', ['-qec', `python3 ${RELAY} -- ${producer}`, '/dev/null'], {
    // ⚠️ **do not read stdout**. This reproduces "the terminal froze"
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      ...process.env,
      NYAN_LANG: 'ja', // ★ the log lines are asserted in Japanese
      RELAY_LOG: logPath,
      RELAY_MAX_BUF: String(1024 * 1024), // 1MB (to make the test fast)
      NYAN_REMOTE_STATE_DIR: dir, // ⚠️ do not pollute the real panes/
    },
  })
  t.after(() => {
    try {
      proc.kill('SIGKILL')
    } catch {
      /* already finished */
    }
  })

  // wait until backpressure engages (if it never does, it keeps piling up = not fixed)
  let log = ''
  for (let i = 0; i < 60; i++) {
    await sleep(100)
    try {
      log = readFileSync(logPath, 'utf8')
    } catch {
      log = ''
    }
    if (log.includes('背圧 かけた')) break
  }
  assert.match(log, /背圧 かけた 溜まり=\d+バイト/, `backpressure never engaged (keeps piling up):\n${log}`)

  // ★ the buffered amount stops near the limit (does not grow without bound)
  const m = /背圧 かけた 溜まり=(\d+)バイト/.exec(log)
  const held = Number(m?.[1] ?? 0)
  assert.ok(held >= 1024 * 1024, `stopped before the limit: ${held}`)
  assert.ok(held < 8 * 1024 * 1024, `buffered far beyond the limit: ${held}`)
})

test('★ passes straight through while the terminal reads (backpressure does not get in the way)', { skip: !hasScript || !hasPython }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-remote-bp2-'))
  const logPath = join(dir, 'relay.log')
  const producer = join(dir, 'produce.sh')
  // spews 8MB (8× the 1MB limit), but this side **keeps reading**
  writeFileSync(producer, '#!/bin/sh\nhead -c 8000000 /dev/zero | tr "\\0" y\n')
  chmodSync(producer, 0o755)

  const proc = spawn('script', ['-qec', `python3 ${RELAY} -- ${producer}`, '/dev/null'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      ...process.env,
      NYAN_LANG: 'ja', // ★ the log lines are asserted in Japanese
      RELAY_LOG: logPath,
      RELAY_MAX_BUF: String(1024 * 1024),
      NYAN_REMOTE_STATE_DIR: dir,
    },
  })
  t.after(() => {
    try {
      proc.kill('SIGKILL')
    } catch {
      /* already finished */
    }
  })

  // ★ keep reading (= a normal terminal). Also check everything is received
  let bytes = 0
  proc.stdout.on('data', (b: Buffer) => {
    bytes += b.length
  })
  const code = await new Promise<number>((resolve) => {
    // ⚠️ without clearing the timer the test does not end for 30 seconds after resolving (hit this at first)
    const timer = setTimeout(() => resolve(-2), 30_000)
    proc.on('exit', (c) => {
      clearTimeout(timer)
      resolve(c ?? -1)
    })
  })
  assert.equal(code, 0, `did not finish passing through (code=${code})`)
  // ⚠️ the pty turns newlines into CRLF, so it **grows**. Check that it did not shrink
  assert.ok(bytes >= 8_000_000, `output was lost: ${bytes} bytes`)
  const log = (() => {
    try {
      return readFileSync(logPath, 'utf8')
    } catch {
      return ''
    }
  })()
  // ⚠️⚠️ "backpressure never engages once" **cannot be guaranteed** (if the CPU is busy the reader falls behind
  //    and legitimately exceeds the limit). I first asserted it, and it reproduced under load = flaky.
  //    ⇒ what is protected is **correctness** (everything arrives, exit code 0; checked above); here
  //    only loosely check "it is not needlessly stuck".
  const engaged = [...log.matchAll(/背圧 かけた/g)].length
  assert.ok(engaged <= 3, `backpressure engaged many times although reading continuously: ${engaged} times\n${log.slice(0, 300)}`)
})

test('★★★ not a single byte is dropped while backpressure is engaged (slow reader)', { skip: !hasScript || !hasPython }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-remote-bp3-'))
  const logPath = join(dir, 'relay.log')
  const producer = join(dir, 'produce.sh')
  const cap = 64 * 1024
  // ⚠️ spew 32× the limit (backpressure engages many times)
  const payload = Buffer.alloc(cap * 32, 0x7a) // 'z'
  writeFileSync(join(dir, 'payload'), payload)
  writeFileSync(producer, `#!/bin/sh\ncat ${join(dir, 'payload')}\n`)
  chmodSync(producer, 0o755)

  const proc = spawn('script', ['-qec', `python3 ${RELAY} -- ${producer}`, '/dev/null'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      ...process.env,
      NYAN_LANG: 'ja', // ★ the log lines are asserted in Japanese
      RELAY_LOG: logPath,
      RELAY_MAX_BUF: String(cap),
      NYAN_REMOTE_STATE_DIR: dir,
    },
  })
  t.after(() => {
    try {
      proc.kill('SIGKILL')
    } catch {
      /* already finished */
    }
  })

  // ★ read slowly on purpose (a pause per chunk) = a situation where backpressure engages.
  // ⚠️ at first I ran `read()` myself and **cut off without waiting for `end`**, missing 130,000 bytes
  //    (a bug in the test, not the relay). ⇒ **decide the end by the `end` event**
  const chunks: Buffer[] = []
  proc.stdout.on('data', (b: Buffer) => {
    chunks.push(b)
    proc.stdout.pause()
    setTimeout(() => proc.stdout.resume(), 1)
  })
  const ended = new Promise<void>((resolve) => proc.stdout.on('end', () => resolve()))
  await Promise.race([ended, deadline(60_000)])

  const got = Buffer.concat(chunks)
  assert.equal(got.length, payload.length, `dropped/added bytes: ${got.length} != ${payload.length}`)
  assert.ok(got.equals(payload), 'the contents changed (the way backpressure is applied is broken)')

  const log = readFileSync(logPath, 'utf8')
  assert.match(log, /背圧 かけた/, `backpressure should engage under these conditions:\n${log.slice(0, 400)}`)
  // ★ hysteresis: released **only after dropping to half** (no oscillation at the boundary)
  for (const m of log.matchAll(/背圧 はずした 溜まり=(\d+)バイト/g)) {
    assert.ok(Number(m[1]) <= cap / 2, `released above half: ${m[1]} > ${cap / 2}`)
  }
})
