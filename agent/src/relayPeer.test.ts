// ★★ How the relay verifies the keystroke peer (2026-09-23 / not a single character arrived on mac).
//
// ⚠️⚠️ mac has no `SO_PEERCRED`, so `peer_uid` was always `None` = **every connection was
//   silently closed**. The agent logs "sent by keystroke" as soon as the write succeeds, so
//   **it looked like success and nothing appeared on screen** (a consequence of the decision not to add ACKs).
// ★ mac's `getsockopt(LOCAL_PEERCRED)` cannot be called from Linux ⇒ pin **the parsing**, and
//   check with a real socket that **the Linux path has not changed**.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const RELAY = new URL('../../scripts/relay.py', import.meta.url).pathname

/** ★ **Loads** relay.py and calls functions (⚠️ main is not run) */
function py(code: string, env: Record<string, string> = {}): string {
  const prelude = [
    'import importlib.util, struct, sys, os, socket, json',
    `spec = importlib.util.spec_from_file_location("relay", ${JSON.stringify(RELAY)})`,
    'r = importlib.util.module_from_spec(spec); spec.loader.exec_module(r)',
  ].join('\n')
  return execFileSync('python3', ['-c', `${prelude}\n${code}`], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  }).trim()
}

test('★★★★ reads the uid from mac\'s struct xucred (checks the version)', () => {
  // ★ the real shape: u_int cr_version; uid_t cr_uid; short cr_ngroups; gid_t cr_groups[16]
  const out = py(`
ok = struct.pack("=IIhh16I", 0, 501, 1, 0, *([20] + [0]*15))
print(r.parse_xucred(ok))
print(r.parse_xucred(struct.pack("=IIhh16I", 1, 501, 1, 0, *([0]*16))))
print(r.parse_xucred(b"\\x00\\x00\\x00"))
print(r._XUCRED_SIZE, len(ok))
`)
  const [uid, badVersion, short, size] = out.split('\n')
  assert.equal(uid, '501', 'cannot read the uid from the correct shape')
  // ⚠️⚠️ **refuse if the version differs** (trusting positions alone reads another value as the uid = accepts someone else's keystrokes)
  assert.equal(badVersion, 'None', 'returns a uid although the version differs')
  assert.equal(short, 'None', 'reads it although it is too short')
  // ★ the requested size matches the struct (⚠️ too small and mac truncates it)
  const [want, got] = (size ?? '').split(' ')
  assert.equal(want, got, 'the xucred size does not match the struct')
})

test('★★★★ the Linux path is as before (a real socket yields our own uid)', () => {
  const out = py(`
a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
print(r.peer_uid(a), os.geteuid())
`)
  const [got, me] = out.split(' ')
  assert.equal(got, me, 'cannot get our own uid on Linux (broke the SO_PEERCRED path)')
})

test('★★★★ the rejection record is left next to the registration and does not end in .json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-relay-peer-'))
  try {
    const reg = join(dir, '4242.json')
    const out = py(`
r._REJECT_PATH = r.rejected_path_for(${JSON.stringify(reg)})
r.note_rejected(1000)
r.note_rejected(None)
print(r._REJECT_PATH)
`)
    // ⚠️ do not end in `.json` (so it is not mistaken for a registration)
    assert.equal(out, join(dir, '4242.rejected'))
    const j = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(j.count, 2, 'not counting')
    assert.ok(!('text' in j) && !('body' in j), 'writes the body (§6.2)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★★ no record when not registered (⚠️ no exception)', () => {
  const out = py(`
r._REJECT_PATH = None
r.note_rejected(1000)
print("ok")
`)
  assert.equal(out, 'ok')
})

test('★★★★ npm run keys reads the rejection record', async () => {
  // @ts-expect-error — plain .mjs (no types)
  const { readRejected } = await import('../../scripts/keys-status.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'nyan-relay-peer-'))
  try {
    py(`
r._REJECT_PATH = r.rejected_path_for(${JSON.stringify(join(dir, '77.json'))})
r.note_rejected(501)
`)
    assert.equal(readRejected(dir, 77)?.count, 1, 'cannot read the record')
    // ⚠️ undefined if absent (do not conclude "not rejected")
    assert.equal(readRejected(dir, 78), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★★★ a connection whose identity cannot be obtained is refused and recorded (⚠️ goes through the refusal path itself)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-relay-peer-'))
  try {
    const out = py(`
r._REJECT_PATH = r.rejected_path_for(${JSON.stringify(join(dir, '9.json'))})
r.peer_uid = lambda c: None   # ★ what happened on mac (identity unobtainable)
a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
conns = []
print(r.admit(a, conns), len(conns), a.fileno())
print(open(r._REJECT_PATH).read())
`)
    const [line1, line2] = out.split('\n')
    const [accepted, n, fd] = (line1 ?? '').split(' ')
    assert.equal(accepted, 'False', '⚠️⚠️ accepts a connection whose identity cannot be obtained (fail-open)')
    assert.equal(n, '0')
    assert.equal(fd, '-1', 'the refused connection was not closed')
    assert.equal(JSON.parse(line2 ?? '{}').count, 1, '⚠️⚠️ refused but no record (invisible from the screen)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★★ our own connections are accepted and leave no record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-relay-peer-'))
  try {
    const out = py(`
r._REJECT_PATH = r.rejected_path_for(${JSON.stringify(join(dir, '9.json'))})
a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
conns = []
print(r.admit(a, conns), len(conns), os.path.exists(r._REJECT_PATH))
`)
    assert.equal(out, 'True 1 False')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ★★ **Keystrokes go through the real relay and reach the child** (added 2026-09-23).
//
// ⚠️⚠️ There was **not a single one** of these: a mutation where the loop never calls `admit` (= accepts no keystrokes at all)
//   **slipped through with every test green**. What was hit on mac today was exactly that "accept nothing and stay silent" shape.
// ★ The real path: `script` (outer pty) → relay.py → (inner pty) → child.
//   The child just reads one line and writes it to a file. **If what was written to the socket shows up in the child's file, it arrived**.
import { spawn, spawnSync } from 'node:child_process'
import { connect } from 'node:net'
import { chmodSync, existsSync, writeFileSync } from 'node:fs'

const hasScript = spawnSync('script', ['--version']).status === 0
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('★★★★★ keystrokes written to the socket actually reach the child inside the relay', { skip: !hasScript }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-relay-e2e-'))
  const out = join(dir, 'got.txt')
  const sock = join(dir, 'k.sock')
  const child = join(dir, 'child.sh')
  // ⚠️ the inner pty is cooked, so CR becomes a newline via ICRNL and read returns
  writeFileSync(child, `#!/bin/sh\nIFS= read -r line\nprintf '%s' "$line" > ${JSON.stringify(out)}\nsleep 0.3\n`)
  chmodSync(child, 0o755)
  const proc = spawn('script', ['-qec', `python3 ${RELAY} --sock ${sock} -- ${child}`, '/dev/null'], {
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, NYAN_REMOTE_STATE_DIR: dir },
  })
  t.after(() => {
    try {
      proc.kill('SIGKILL')
    } catch {
      /* already finished */
    }
    rmSync(dir, { recursive: true, force: true })
  })

  // ★ wait until the injection socket exists (⚠️ connecting before that means this check sees nothing)
  for (let i = 0; i < 100 && !existsSync(sock); i++) await sleep(50)
  assert.ok(existsSync(sock), 'the relay\'s injection socket was not created (this check is idle)')
  // ⚠️ registration happens after setraw = anything typed before that may be discarded (see the note in relay.py)
  await sleep(300)

  await new Promise<void>((resolve, reject) => {
    const s = connect(sock, () => s.end('hello-from-phone\r', () => resolve()))
    s.on('error', reject)
  })

  let got = ''
  for (let i = 0; i < 100 && !got; i++) {
    await sleep(50)
    try {
      got = readFileSync(out, 'utf8')
    } catch {
      got = ''
    }
  }
  assert.equal(got, 'hello-from-phone', '⚠️⚠️ keystrokes written to the socket did not reach the child (silently discarded)')
})

test('★★★★ relay.py does not fall back to `ps` when `/proc` exists (⚠️ no waiting in the daily critical path)', () => {
  // ⚠️ asking about a dead pid on Linux ⇒ `/proc` exists but is unreadable ⇒ **None without calling ps**
  const out = py(`
called = []
real = r.subprocess.run
def spy(*a, **k):
    called.append(a)
    return real(*a, **k)
r.subprocess.run = spy
print(r.proc_start(0x7ffffff0), len(called))
`)
  assert.equal(out, 'None 0', '⚠️⚠️ launches ps although /proc exists')
})
