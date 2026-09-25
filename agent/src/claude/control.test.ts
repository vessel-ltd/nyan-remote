// ★★ The "stop" (ESC) path (HANDOFF hole #1).
//
// ⚠️⚠️ This is **a more dangerous interface than typing**, so list what it protects first:
//
//   1. **Bytes come from one table** (`CONTROL_KEYS`). ESC is **one byte**, with **no CR**
//      (sending ESC twice opens the "go back to a previous message" dialog = a different operation)
//   2. **The phone cannot choose bytes** (the interface takes no body. Same reason as `updatedInput`)
//   3. **Free text cannot produce ESC** (`sanitizeForKeys` drops it. ★ Check the bytes that reach
//      the socket = a test passing a hand-made string is a false green / VERIFY.md type 3)
//   4. **Refuse while an approval card is up and while `waiting`** (ESC closes the dialog = an unrequested rejection)
//   5. **Never drop failures into the inbox** (a "stop" would arrive as an "instruction").
//      ⇒ `partial` is removed from the type, and the interface does not bring in `inbox` either (forbidden by structure)
//   6. **Do not cut in while a body is being sent (body → 120ms → CR)** (ESC clears the input box)
//
// ★ The real Claude Code is not needed. We watch the round trip with a socket server (+ the real relay.py).
// ⚠️ Do not write raw control characters in source (git treats the file as binary / CLAUDE.md §5). Always `\x1b`.

import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CONTROL_COOLDOWN_MS,
  CONTROL_COOLDOWNS,
  CONTROL_KEYS,
  controlKeyOf,
  controlMessage,
  sendControlToSession,
  sendKeysToSession,
  writeControl,
} from './keys.ts'
import { aliveProcStartSync } from './sessionIndex.ts'
import type { ConfigDir } from './configDirs.ts'

const ESC = '\x1b'
const RELAY = join(fileURLToPath(new URL('../../../scripts/', import.meta.url)), 'relay.py')
const hasPython = spawnSync('python3', ['-c', 'print(1)']).status === 0
const hasScript = spawnSync('script', ['--version']).status === 0

const dirOf = (base: string): ConfigDir => ({
  account: '.claude-test',
  dir: base,
  projectsDir: join(base, 'projects'),
})

async function fakeIndex(
  pid: number,
  sessionId: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'nyan-remote-ctrl-'))
  await mkdir(join(base, 'sessions'), { recursive: true })
  const procStart = aliveProcStartSync(pid)
  await writeFile(
    join(base, 'sessions', `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd: '/tmp', status: 'busy', procStart, ...extra }),
  )
  return base
}

/** A server pretending to be the typing endpoint. ⚠️ Always close it with `t.after` (otherwise the test hangs) */
function fakePane(path: string): Promise<{ server: Server; chunks: string[] }> {
  const chunks: string[] = []
  const server = createServer((sock) => {
    sock.setEncoding('utf8')
    sock.on('data', (d: string) => chunks.push(d))
    sock.on('error', () => {})
  })
  return new Promise((resolve) => {
    server.listen(path, () => resolve({ server, chunks }))
  })
}

/** Create the announcement by calling only relay.py's `register` (★ made the real way) */
function registerPane(pid: number, sock: string, state: string): void {
  execFileSync(
    'python3',
    [
      '-c',
      `import importlib.util as u; spec=u.spec_from_file_location('r', ${JSON.stringify(RELAY)}); m=u.module_from_spec(spec); spec.loader.exec_module(m); m.register(${pid}, ${JSON.stringify(sock)})`,
    ],
    { env: { ...process.env, NYAN_REMOTE_STATE_DIR: state, PYTHONDONTWRITEBYTECODE: '1' } },
  )
}

async function poll<T>(fn: () => Promise<T | undefined>, ms = 8000): Promise<T | undefined> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const v = await fn()
    if (v !== undefined) return v
    await new Promise((r) => setTimeout(r, 40))
  }
  return undefined
}

test('★★★ CONTROL_KEYS: each is 1 byte with no CR (the table is the only source)', () => {
  assert.equal(CONTROL_KEYS.escape, ESC)
  // ★ Ctrl-U = clear the input box (added after measuring on 2026-08-25 / ARCHITECTURE §9.7.3.1)
  assert.equal(CONTROL_KEYS.clear, '\x15')
  // ⚠️ When adding more, fix this too (if it grows silently, "what can be sent" widens)
  assert.deepEqual(Object.keys(CONTROL_KEYS), ['escape', 'clear'])
  // ★★ **Intervals are also kept in a table** (⚠️ `clear` is 0 = "stop → clear right away" is not refused)
  assert.deepEqual(CONTROL_COOLDOWNS, { escape: 1500, clear: 0 })
  assert.deepEqual(Object.keys(CONTROL_COOLDOWNS), Object.keys(CONTROL_KEYS), 'the table keys are out of sync')
  for (const [name, bytes] of Object.entries(CONTROL_KEYS)) {
    assert.equal(bytes.length, 1, `${name} is not 1 byte (ESC twice is a different operation)`)
    assert.ok(!bytes.includes('\r'), `${name} contains CR (it would submit)`)
    assert.ok(!bytes.includes('\n'), `${name} contains LF`)
  }
})

test('★★ writeControl: only ESC arrives (no CR sent after it)', async (t) => {
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-wc-'))
  const sock = join(state, 'c.sock')
  const { server, chunks } = await fakePane(sock)
  t.after(async () => {
    server.close()
    await rm(state, { recursive: true, force: true })
  })
  const r = await writeControl(sock, CONTROL_KEYS.escape)
  assert.equal(r.ok, true, JSON.stringify(r))
  await poll(async () => (chunks.length > 0 ? true : undefined), 2000)
  // ★ Typing sends CR 120ms later. **Wait longer than that** and check nothing arrives
  await new Promise((res) => setTimeout(res, 400))
  assert.equal(
    chunks.join(''),
    ESC,
    `⚠️ something was sent after ESC (sending CR is a different operation): ${JSON.stringify(chunks)}`,
  )
})

test('★ writeControl: a socket with nobody listening is unreachable (not partial)', async (t) => {
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-wc2-'))
  t.after(() => rm(state, { recursive: true, force: true }))
  const r = await writeControl(join(state, 'nobody.sock'), CONTROL_KEYS.escape)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'unreachable')
})

test('★★ sendControlToSession: writes not a single byte while an approval card is up', { skip: !hasPython }, async (t) => {
  const pid = process.pid
  const base = await fakeIndex(pid, 'sid-perm')
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-cperm-'))
  const sock = join(state, 'c.sock')
  const { server, chunks } = await fakePane(sock)
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  t.after(async () => {
    server.close()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(base, { recursive: true, force: true })
    await rm(state, { recursive: true, force: true })
  })
  registerPane(pid, sock, state)
  const r = await sendControlToSession([dirOf(base)], 'sid-perm', 'escape', {
    hasPendingApproval: () => true,
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'pending-approval', JSON.stringify(r))
  await new Promise((res) => setTimeout(res, 150))
  assert.equal(chunks.length, 0, '⚠️⚠️ sent ESC during an approval card (an unrequested rejection)')
})

test('★★ sendControlToSession: refuses if the CLI is showing a dialog and waiting', { skip: !hasPython }, async (t) => {
  const pid = process.pid
  const base = await fakeIndex(pid, 'sid-wait', { status: 'waiting' })
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-cwait-'))
  const sock = join(state, 'c.sock')
  const { server, chunks } = await fakePane(sock)
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  t.after(async () => {
    server.close()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(base, { recursive: true, force: true })
    await rm(state, { recursive: true, force: true })
  })
  registerPane(pid, sock, state)
  const r = await sendControlToSession([dirOf(base)], 'sid-wait', 'escape', {
    hasPendingApproval: () => false,
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'waiting', JSON.stringify(r))
  assert.equal(chunks.length, 0, '⚠️ closes the dialog with ESC (an unrequested cancellation)')
})

test('★★★ does not send if an approval appears "after" finding the destination (re-reads)', { skip: !hasPython }, async (t) => {
  // ⚠️⚠️ An approval can appear **during the destination-finding I/O** (the hook comes from another process).
  //    Deciding from a value read once would **close with ESC** the approval card that appeared then (= an unrequested rejection).
  //    ⇒ `KeysContext` is a function, so it **can be re-read**. We check that it re-reads using
  //       a ctx that returns "false the first time, true from the second time on".
  const pid = process.pid
  const base = await fakeIndex(pid, 'sid-late')
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-clate-'))
  const sock = join(state, 'c.sock')
  const { server, chunks } = await fakePane(sock)
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  t.after(async () => {
    server.close()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(base, { recursive: true, force: true })
    await rm(state, { recursive: true, force: true })
  })
  registerPane(pid, sock, state)
  let calls = 0
  const r = await sendControlToSession([dirOf(base)], 'sid-late', 'escape', {
    hasPendingApproval: () => {
      calls += 1
      return calls > 1
    },
  })
  assert.ok(calls >= 2, `⚠️⚠️ checks for approvals only once (${calls} times)`)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'pending-approval', JSON.stringify(r))
  await new Promise((res) => setTimeout(res, 150))
  assert.equal(chunks.length, 0, '⚠️⚠️ closes with ESC an approval card that appeared midway')
})

test('★★★ does not send twice in a row (ESC twice opens the "go back" dialog)', { skip: !hasPython }, async (t) => {
  // ⚠️⚠️ Receiving ESC **twice in a row** makes the CLI show the "go back to a previous message" screen.
  //    Then it becomes `status:'waiting'` and **typing is refused too** (stuck until closed on the PC).
  //    ⇒ Debouncing on the screen is not enough (**two phones / double taps**). The agent refuses.
  // ⚠️ The CLI's "twice" window is unmeasured. This is a floor to **squash double taps**.
  const pid = process.pid
  const base = await fakeIndex(pid, 'sid-twice')
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-ctwice-'))
  const sock = join(state, 'c.sock')
  const { server, chunks } = await fakePane(sock)
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  t.after(async () => {
    server.close()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(base, { recursive: true, force: true })
    await rm(state, { recursive: true, force: true })
  })
  registerPane(pid, sock, state)
  const ctx = { hasPendingApproval: () => false }
  const first = await sendControlToSession([dirOf(base)], 'sid-twice', 'escape', ctx)
  const second = await sendControlToSession([dirOf(base)], 'sid-twice', 'escape', ctx)
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(second.ok, false, '⚠️⚠️ sent twice in a row (the history dialog opens)')
  assert.equal(second.reason, 'too-soon', JSON.stringify(second))
  await new Promise((res) => setTimeout(res, 150))
  assert.equal(chunks.join(''), ESC, `a second byte went out: ${JSON.stringify(chunks)}`)
})

test('★★★ remembers only successful sends (remembering a failure drops the next one)', { skip: !hasPython }, async (t) => {
  // ⚠️⚠️ The same trap we hit with notifications (`shouldSendLabel`). **Remembering a failure as "sent" means
  //    the ESC we really want to send right after is dropped as "repeated"** (it never arrives).
  const pid = process.pid
  const base = await fakeIndex(pid, 'sid-nofail')
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-cnofail-'))
  const dead = join(state, 'nobody.sock') // nobody is listening
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  t.after(async () => {
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(base, { recursive: true, force: true })
    await rm(state, { recursive: true, force: true })
  })
  const ctx = { hasPendingApproval: () => false }
  registerPane(pid, dead, state)
  const failed = await sendControlToSession([dirOf(base)], 'sid-nofail', 'escape', ctx)
  assert.equal(failed.reason, 'unreachable', JSON.stringify(failed))
  // ★ Bring the endpoint back up and send again **right away** (= passes if the failure was not remembered)
  const { server, chunks } = await fakePane(dead)
  t.after(() => server.close())
  const retry = await sendControlToSession([dirOf(base)], 'sid-nofail', 'escape', ctx)
  assert.equal(retry.ok, true, `⚠️⚠️ the failure was remembered (the next ESC was dropped): ${JSON.stringify(retry)}`)
  await new Promise((res) => setTimeout(res, 100))
  assert.equal(chunks.join(''), ESC)
})

test('★★ passes once enough time has passed (checked by passing a clock)', { skip: !hasPython }, async (t) => {
  const pid = process.pid
  const base = await fakeIndex(pid, 'sid-gap')
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-cgap-'))
  const sock = join(state, 'c.sock')
  const { server, chunks } = await fakePane(sock)
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  t.after(async () => {
    server.close()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(base, { recursive: true, force: true })
    await rm(state, { recursive: true, force: true })
  })
  registerPane(pid, sock, state)
  const ctx = { hasPendingApproval: () => false }
  let clock = 1_000_000
  const dirs = [dirOf(base)]
  const a = await sendControlToSession(dirs, 'sid-gap', 'escape', ctx, { now: () => clock })
  clock += CONTROL_COOLDOWN_MS + 1
  const b = await sendControlToSession(dirs, 'sid-gap', 'escape', ctx, { now: () => clock })
  assert.equal(a.ok, true, JSON.stringify(a))
  assert.equal(b.ok, true, `⚠️ does not pass even after waiting (cannot stop again): ${JSON.stringify(b)}`)
  await new Promise((res) => setTimeout(res, 150))
  assert.equal(chunks.join(''), `${ESC}${ESC}`)
})

test('★ sendControlToSession: a session not via relay is no-relay (not dropped into the inbox)', async (t) => {
  const base = await fakeIndex(process.pid, 'sid-norelay')
  t.after(() => rm(base, { recursive: true, force: true }))
  const r = await sendControlToSession([dirOf(base)], 'sid-norelay', 'escape', {
    hasPendingApproval: () => false,
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no-relay')
})

test('★★★ ESC does not cut in while a body is being sent (body → 120ms → CR)', { skip: !hasPython }, async (t) => {
  // ⚠️⚠️ Cutting in puts ESC in the middle of `AAAA`, **clearing the input box**, and the following CR submits empty.
  //    ⇒ Check by arrival order that it rides **the same serial queue** as typing (`serializeBySession`).
  const pid = process.pid
  const base = await fakeIndex(pid, 'sid-serial')
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-cser-'))
  const sock = join(state, 'c.sock')
  const { server, chunks } = await fakePane(sock)
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  t.after(async () => {
    server.close()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(base, { recursive: true, force: true })
    await rm(state, { recursive: true, force: true })
  })
  registerPane(pid, sock, state)
  const ctx = { hasPendingApproval: () => false }
  // ★★ **Deliberately create the dangerous interleaving** (learned from the 2026-08-24 mutation run).
  //    Just calling both at once lets the shorter ESC **arrive first and go green** (= a false green).
  //    ⇒ Throw it **after the body is written and before the CR** (inside the 120ms window).
  const keys = sendKeysToSession([dirOf(base)], 'sid-serial', 'AAAA', ctx)
  await new Promise((res) => setTimeout(res, 60))
  const ctrl = sendControlToSession([dirOf(base)], 'sid-serial', 'escape', ctx)
  const [a, b] = await Promise.all([keys, ctrl])
  assert.equal(a.ok, true, JSON.stringify(a))
  assert.equal(b.ok, true, JSON.stringify(b))
  await new Promise((res) => setTimeout(res, 150))
  const seen = chunks.join('')
  // ⚠️⚠️ This is the point: **no ESC between the body and the CR**
  //    (if it gets in, the input box is cleared and the following CR submits empty)
  assert.ok(
    !seen.includes(`AAAA${ESC}`),
    `⚠️⚠️ cuts in between the body and the CR: ${JSON.stringify(seen)}`,
  )
  // ★ Either order is fine (ESC first, or body + CR first)
  assert.ok(
    seen === `AAAA\r${ESC}` || seen === `${ESC}AAAA\r`,
    `⚠️ unexpected shape received: ${JSON.stringify(seen)}`,
  )
})

test('★★★ free text cannot produce ESC (checked by the bytes that reach the socket)', { skip: !hasPython }, async (t) => {
  const pid = process.pid
  const base = await fakeIndex(pid, 'sid-esc')
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-cesc-'))
  const sock = join(state, 'c.sock')
  const { server, chunks } = await fakePane(sock)
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  t.after(async () => {
    server.close()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(base, { recursive: true, force: true })
    await rm(state, { recursive: true, force: true })
  })
  registerPane(pid, sock, state)
  const r = await sendKeysToSession([dirOf(base)], 'sid-esc', `${ESC}${ESC}止めて`, {
    hasPendingApproval: () => false,
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  await new Promise((res) => setTimeout(res, 150))
  const seen = chunks.join('')
  assert.ok(!seen.includes(ESC), `⚠️⚠️ ESC from free text got through: ${JSON.stringify(seen)}`)
  assert.equal(seen, '止めて\r')
})

test('★★ the send is logged, but only the interface name (neither body nor raw bytes)', { skip: !hasPython }, async (t) => {
  const pid = process.pid
  const base = await fakeIndex(pid, 'sid-note')
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-cnote-'))
  const sock = join(state, 'c.sock')
  const { server } = await fakePane(sock)
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  t.after(async () => {
    server.close()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(base, { recursive: true, force: true })
    await rm(state, { recursive: true, force: true })
  })
  registerPane(pid, sock, state)
  const r = await sendControlToSession([dirOf(base)], 'sid-note', 'escape', {
    hasPendingApproval: () => false,
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  const body = await readFile(join(state, 'sent.jsonl'), 'utf8')
  assert.match(body, /"route":"control"/, '★ no log entry (rule 6)')
  assert.match(body, /"key":"escape"/)
  assert.ok(!body.includes(ESC), '⚠️ raw control characters written to the log')
})

test('★★ failures are logged too (through the whole wiring)', { skip: !hasPython }, async (t) => {
  const pid = process.pid
  const base = await fakeIndex(pid, 'sid-cfail')
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-cfail-'))
  const sock = join(state, 'nobody.sock') // ★ nobody is listening
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  t.after(async () => {
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(base, { recursive: true, force: true })
    await rm(state, { recursive: true, force: true })
  })
  registerPane(pid, sock, state)
  const r = await sendControlToSession([dirOf(base)], 'sid-cfail', 'escape', {
    hasPendingApproval: () => false,
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'unreachable', JSON.stringify(r))
  const body = await readFile(join(state, 'sent.jsonl'), 'utf8')
  assert.match(body, /"failure":"unreachable"/, '⚠️ no failure log entry')
  assert.match(body, /"route":"control"/)
})

test(
  '★★★ ESC reaches the child through relay.py (checked with a real pty)',
  { skip: !hasPython || !hasScript },
  async (t) => {
    // ⚠️⚠️ This is **the final check of the wiring**: socket → relay.py → pty → child.
    //    relay.py drops Ctrl-Z on stdin, but we check with the real thing that **it does not drop ESC from the injection point**
    //    (do not rely on our own comments / CLAUDE.md §2).
    const state = await mkdtemp(join(tmpdir(), 'nyan-remote-e2e-'))
    const out = join(state, 'got.hex')
    const ready = join(state, 'ready')
    const child = join(state, 'child.py')
    const prev = process.env['NYAN_REMOTE_STATE_DIR']
    process.env['NYAN_REMOTE_STATE_DIR'] = state
    await writeFile(
      child,
      [
        'import os, select, time, tty',
        // ★ Same raw mode as claude (in canonical mode ESC sits in the line buffer)
        'tty.setraw(0)',
        // ★★ Say "ready" **only after entering raw** (added after measuring on 2026-08-24).
        //    ⚠️⚠️ Python's `tty.setraw` uses `TCSAFLUSH`, so **input that arrived before it is discarded**.
        //    The announcement (`panes/<pid>.json`) appears right after fork, so typing immediately then
        //    **discards the ESC and leaves only the echo on screen** (measured: `OUT "^["`).
        //    ⇒ On real machines too, "keystrokes within 1 second of startup may not arrive" (recorded in HANDOFF)
        `open(${JSON.stringify(ready)}, "w").write("1")`,
        'buf = b""',
        'end = time.monotonic() + 8',
        'while time.monotonic() < end:',
        '    r, _, _ = select.select([0], [], [], 0.2)',
        '    if not r: continue',
        '    d = os.read(0, 1024)',
        '    if not d: break',
        '    buf += d',
        '    if b"\\x1b" in buf:',
        // ★ We also want to see no CR follows, so wait a bit and read again
        '        time.sleep(0.4)',
        '        r2, _, _ = select.select([0], [], [], 0)',
        '        if r2: buf += os.read(0, 1024)',
        '        break',
        `open(${JSON.stringify(out)}, "w").write(buf.hex())`,
      ].join('\n'),
    )
    const relayLog = join(state, 'relay.log')
    const proc = spawn('script', ['-qec', `python3 ${RELAY} -- python3 ${child}`, '/dev/null'], {
      env: {
        ...process.env,
        NYAN_REMOTE_STATE_DIR: state,
        RELAY_LOG: relayLog,
        PYTHONDONTWRITEBYTECODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // ★ On failure, output **what happened** (the inside of the pty is invisible, so without this you get lost)
    let seen = ''
    proc.stdout.on('data', (d: Buffer) => {
      seen += `OUT ${JSON.stringify(String(d))}\n`
    })
    proc.stderr.on('data', (d: Buffer) => {
      seen += `ERR ${JSON.stringify(String(d))}\n`
    })
    const why = async (): Promise<string> =>
      `${seen}RELAY_LOG=${await readFile(relayLog, 'utf8').catch(() => '(none)')}`
    const base = await mkdtemp(join(tmpdir(), 'nyan-remote-e2ei-'))
    t.after(async () => {
      proc.kill('SIGKILL')
      if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
      else process.env['NYAN_REMOTE_STATE_DIR'] = prev
      await rm(state, { recursive: true, force: true })
      await rm(base, { recursive: true, force: true })
    })

    // ★ relay itself writes the announcement (= we cannot choose the pid). Wait for it to appear
    const panes = join(state, 'panes')
    const rec = await poll(async () => {
      try {
        const names = await readdir(panes)
        if (names.length === 0) return undefined
        return JSON.parse(await readFile(join(panes, names[0]!), 'utf8')) as {
          pid: number
          socket: string
          procStart: string
        }
      } catch {
        return undefined
      }
    })
    assert.ok(rec, '⚠️ relay did not announce itself (the typing entry point is not up)')
    // ★ Wait for the child to enter raw (reason above. Without waiting, ESC is discarded and it is **a false red**)
    const up = await poll(async () =>
      (await readFile(ready, 'utf8').catch(() => undefined)) === undefined ? undefined : true,
    )
    assert.ok(up, `⚠️ the child did not start: ${await why()}`)
    // Build the CLI's index for that pid (normally the CLI writes it)
    await mkdir(join(base, 'sessions'), { recursive: true })
    await writeFile(
      join(base, 'sessions', `${rec.pid}.json`),
      JSON.stringify({
        pid: rec.pid,
        sessionId: 'sid-e2e',
        cwd: '/tmp',
        status: 'busy',
        procStart: rec.procStart,
      }),
    )

    const r = await sendControlToSession([dirOf(base)], 'sid-e2e', 'escape', {
      hasPendingApproval: () => false,
    })
    assert.equal(r.ok, true, JSON.stringify(r))
    const got = await poll(async () => {
      try {
        return await readFile(out, 'utf8')
      } catch {
        return undefined
      }
    })
    assert.equal(
      got,
      '1b',
      `⚠️⚠️ the bytes that reached the child differ (should be just one ESC): ${JSON.stringify(got)}\n${await why()}`,
    )
  },
)

/* ---- Clearing the input box (Ctrl-U / 2026-08-25) ---- */

test('★★★ clear sends only 1 byte of Ctrl-U (no CR)', { skip: !hasPython }, async (t) => {
  const pid = process.pid
  const base = await fakeIndex(pid, 'sid-clear')
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-clr-'))
  const sock = join(state, 'c.sock')
  const { server, chunks } = await fakePane(sock)
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  t.after(async () => {
    server.close()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(base, { recursive: true, force: true })
    await rm(state, { recursive: true, force: true })
  })
  registerPane(pid, sock, state)
  const ctx = { hasPendingApproval: () => false }
  const r = await sendControlToSession([dirOf(base)], 'sid-clear', 'clear', ctx)
  assert.equal(r.ok, true, JSON.stringify(r))
  await new Promise((res) => setTimeout(res, 400))
  assert.equal(chunks.join(''), '\x15', `the bytes received differ: ${JSON.stringify(chunks)}`)
})

test('★★★ clear does not refuse repeats ("stop → clear right away" must work)', { skip: !hasPython }, async (t) => {
  // ★ Measured (2026-08-25): both empty presses and repeats were harmless. ⇒ No interval here.
  //   ⚠️⚠️ Also check it **does not mix** with the ESC memory (if mixed, you cannot clear right after "stop")
  const pid = process.pid
  const base = await fakeIndex(pid, 'sid-clear2')
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-clr2-'))
  const sock = join(state, 'c.sock')
  const { server, chunks } = await fakePane(sock)
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  t.after(async () => {
    server.close()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(base, { recursive: true, force: true })
    await rm(state, { recursive: true, force: true })
  })
  registerPane(pid, sock, state)
  const ctx = { hasPendingApproval: () => false }
  const now = (): number => 5_000_000 // ★ not refused even with time frozen
  const stop = await sendControlToSession([dirOf(base)], 'sid-clear2', 'escape', ctx, { now })
  assert.equal(stop.ok, true, JSON.stringify(stop))
  for (let i = 0; i < 3; i++) {
    const r = await sendControlToSession([dirOf(base)], 'sid-clear2', 'clear', ctx, { now })
    assert.equal(r.ok, true, `attempt ${i + 1} was refused: ${JSON.stringify(r)}`)
  }
  // ⚠️ The 1.5-second gate for ESC is still alive (`clear` did not overwrite its memory)
  const again = await sendControlToSession([dirOf(base)], 'sid-clear2', 'escape', ctx, { now })
  assert.equal(again.reason, 'too-soon', `the ESC gate is gone: ${JSON.stringify(again)}`)
  await new Promise((res) => setTimeout(res, 400))
  assert.equal(chunks.join(''), `${ESC}\x15\x15\x15`, `unexpected shape received: ${JSON.stringify(chunks)}`)
})

test('★★ clear messages do not reuse the "stop" messages (★ every reason exhaustively)', () => {
  // ⚠️ The mutation codex named: revert only `broken` to `CONTROL_MESSAGE` (it checked only 4 reasons)
  const reasons = [
    'no-relay',
    'waiting',
    'not-found',
    'pending-approval',
    'broken',
    'unverified',
    'ambiguous',
    'unreachable',
    'too-soon',
  ] as const
  for (const r of reasons) {
    const stopMsg = controlMessage(r, 'escape')
    const clearMsg = controlMessage(r, 'clear')
    assert.notEqual(clearMsg, stopMsg, `the ${r} message is the same as "stop" (a different request)`)
    assert.ok(!clearMsg.includes('止め'), `the ${r} message talks about "stop": ${clearMsg}`)
  }
})

test('★★ does not touch the input box either while an approval card is up', { skip: !hasPython }, async (t) => {
  const pid = process.pid
  const base = await fakeIndex(pid, 'sid-clear3')
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-clr3-'))
  const sock = join(state, 'c.sock')
  const { server, chunks } = await fakePane(sock)
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  t.after(async () => {
    server.close()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(base, { recursive: true, force: true })
    await rm(state, { recursive: true, force: true })
  })
  registerPane(pid, sock, state)
  const r = await sendControlToSession([dirOf(base)], 'sid-clear3', 'clear', {
    hasPendingApproval: () => true,
  })
  assert.equal(r.reason, 'pending-approval', JSON.stringify(r))
  await new Promise((res) => setTimeout(res, 150))
  assert.equal(chunks.length, 0, '⚠️ touches the input box during an approval card')
})

test('★ the repeat memory is separate per key (so they do not mix the moment an interval is added)', () => {
  // ⚠️ `clear` has an interval of 0 now so there is no symptom, but **pin down the shape**
  //   (if not separated, the moment `clear` gets an interval, ESC's "twice in a row" judgement breaks)
  assert.notEqual(controlKeyOf('escape', 'sid'), controlKeyOf('clear', 'sid'), 'not separated by key')
  assert.notEqual(controlKeyOf('escape', 'a'), controlKeyOf('escape', 'b'), 'not separated by session')
  for (const key of Object.keys(CONTROL_KEYS)) assert.ok(controlKeyOf(key as never, 'sid').includes(key))
})

test('★★ even when sending fails, the "stop / clear" messages appear (typing messages do not leak)', async (t) => {
  // ⚠️ The message `writeControl` puts in is **for typing** (`failureMessage`), so returning it as-is
  //    shows "the **typing** endpoint is not responding" (an internal term = violates CLAUDE.md §2).
  const base = await fakeIndex(process.pid, 'sid-msg')
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-msg-'))
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  t.after(async () => {
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(base, { recursive: true, force: true })
    await rm(state, { recursive: true, force: true })
  })
  // ★ Do not create an announcement = rather than `no-relay` (a failure to find the destination),
  //   write only the announcement to create the state where **the socket is not there**
  registerPane(process.pid, join(state, 'nobody.sock'), state)
  for (const [key, word] of [
    ['escape', '打鍵'],
    ['clear', '打鍵'],
  ] as const) {
    const r = await sendControlToSession([dirOf(base)], 'sid-msg', key, {
      hasPendingApproval: () => false,
    })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'unreachable', JSON.stringify(r))
    assert.ok(!(r.message ?? '').includes(word), `the ${key} message shows an internal term: ${r.message}`)
    assert.equal(r.message, controlMessage('unreachable', key), `the ${key} message does not come from the table`)
  }
})

test('★★★ approvals are also checked "right before writing" (do not ignore ones that appear during connect)', { skip: !hasPython }, async (t) => {
  // ⚠️⚠️ 2026-08-25 codex round 7, medium #4 (reproduced by measurement). The caller's check was only **before `connect`**,
  //    so if an approval appeared during `connect` (async), **it wrote anyway**
  //    (ESC is **an unrequested rejection**, Ctrl-U **clears the option input**).
  // ★ Raise the approval right after the second check passes with `false` = the shape of one appearing during `connect`.
  const pid = process.pid
  const base = await fakeIndex(pid, 'sid-race')
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-race-'))
  const sock = join(state, 'c.sock')
  const { server, chunks } = await fakePane(sock)
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  t.after(async () => {
    server.close()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(base, { recursive: true, force: true })
    await rm(state, { recursive: true, force: true })
  })
  registerPane(pid, sock, state)
  for (const key of ['escape', 'clear'] as const) {
    chunks.length = 0
    let pending = false
    let calls = 0
    const r = await sendControlToSession([dirOf(base)], 'sid-race', key, {
      hasPendingApproval: () => {
        calls += 1
        // ★ The approval appears right after passing the second check (after finding the destination)
        if (calls === 2) setImmediate(() => { pending = true })
        return pending
      },
    })
    await new Promise((res) => setTimeout(res, 300))
    assert.equal(calls, 3, `${key}: the check did not run 3 times (start, after finding the destination, **right before writing**): ${calls}`)
    assert.equal(r.reason, 'pending-approval', `${key}: ${JSON.stringify(r)}`)
    assert.equal(chunks.length, 0, `⚠️⚠️ ${key}: writes although an approval appeared (${JSON.stringify(chunks)})`)
  }
})

test('★★ the gap between ESC and Ctrl-U exceeds the measured floor (too short and ESC has no effect / 2026-09-24)', async () => {
  const { STOP_CLEAR_GAP_MS } = await import('./keys.ts')
  // ⚠️ Measured: 5ms and 20ms did not stop it, 50ms and up did (Claude Code 2.1.281). ⇒ Guard at double the floor, 100ms
  assert.ok(STOP_CLEAR_GAP_MS >= 100, `⚠️⚠️ the gap is ${STOP_CLEAR_GAP_MS}ms (measured: 20ms or less, ESC had no effect)`)
})
