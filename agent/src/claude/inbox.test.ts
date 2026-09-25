// Pushing into the inbox (M4-2).
//
// ★ The real Claude Code is not needed. **We stand up our own UNIX socket server and watch the round trip.**
//   (Pushing into the real one would inject instructions into a real conversation. Tests must never do that)
//
// ⚠️ The two main things to protect here:
//   1. **Never write to the socket of a dead pid** (worst case, the instruction lands in a different session)
//   2. **Do not hang when unable to connect** (CLAUDE.md §4 "a dead port does not fail immediately")

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  buildLines,
  failureMessage,
  findTarget,
  keyFilePath,
  readPeerToken,
  senderName,
  validateText,
  writeToSocket,
  MAX_TEXT_BYTES,
} from './inbox.ts'

import type { ConfigDir } from './configDirs.ts'

const dirOf = (base: string): ConfigDir => ({
  account: '.claude-test',
  dir: base,
  projectsDir: join(base, 'projects'),
})

async function tempAccount(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'nyan-remote-inbox-'))
  await mkdir(join(base, 'sessions'), { recursive: true })
  return base
}

/** A server pretending to be the inbox. Stores received lines as-is */
function fakeInbox(path: string): Promise<{ server: Server; lines: string[] }> {
  const lines: string[] = []
  const server = createServer((sock) => {
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('data', (d: string) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (line.trim()) lines.push(line)
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(path, () => resolve({ server, lines }))
  })
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return cond()
}

test('validateText: rejects empty and too-long input', () => {
  assert.equal(validateText('やっといて'), null)
  assert.equal(validateText(''), 'empty')
  assert.equal(validateText('   \n '), 'empty', 'whitespace only also counts as empty')
  assert.equal(validateText(undefined), 'empty')
  assert.equal(validateText('あ'.repeat(MAX_TEXT_BYTES)), 'too-long', 'measured in bytes (Japanese is 3 bytes)')
  assert.equal(validateText('a'.repeat(MAX_TEXT_BYTES)), null)
})

test('★ buildLines: newline-delimited JSON. Newlines in the body do not add lines', () => {
  const payload = buildLines('1行目\n2行目', { from: 'nyan-remote(test)' })
  const lines = payload.split('\n').filter(Boolean)
  assert.equal(lines.length, 1, 'one line even if the body has newlines')
  const o = JSON.parse(lines[0]!) as {
    type: string
    from: string
    message: { role: string; content: string }
  }
  assert.equal(o.type, 'user')
  assert.equal(o.message.role, 'user')
  assert.equal(o.message.content, '1行目\n2行目')
  // ★ Identify ourselves. It stays in the receiver's transcript as origin.from (measured 2026-08-13)
  assert.equal(o.from, 'nyan-remote(test)')
})

test('★ buildLines: sends auth first if a key exists', () => {
  // ⚠️ We cannot say "it will not break if it becomes mandatory" (pointed out in the 2026-08-14 external review).
  //    With a missing or broken key we **send unauthenticated**, and the socket returns nothing, so
  //    **we cannot tell if the receiver rejected it**. All we can do here is "send it if we have it"
  const lines = buildLines('やあ', { token: 'tok', from: 'x' }).split('\n').filter(Boolean)
  assert.equal(lines.length, 2)
  assert.deepEqual(JSON.parse(lines[0]!), { type: 'auth', token: 'tok' })
  assert.equal((JSON.parse(lines[1]!) as { type: string }).type, 'user')
})

test('senderName: includes the machine name', () => {
  assert.equal(senderName('pc-b'), 'nyan-remote(pc-b)')
})

test('keyFilePath / readPeerToken: <pid>.<sha256(socketPath)>.key (the shape measured on 2026-08-13)', async () => {
  const base = await tempAccount()
  try {
    const sessions = join(base, 'sessions')
    const sock = '/run/user/1000/cc-socks/3228.sock'
    const path = keyFilePath(sessions, 3228, sock)
    // Measured value: sha256 of /run/user/1000/cc-socks/3228.sock
    assert.ok(
      path.endsWith('3228.bf9ddcff0583e5b6d389570f29b659547b26fdcd77657500cf0da2081d2220e9.key'),
      path,
    )
    assert.equal(await readPeerToken(sessions, 3228, sock), undefined, 'undefined if absent (not required)')
    await writeFile(path, JSON.stringify({ peerToken: 'abc', procStart: '123' }))
    assert.equal(await readPeerToken(sessions, 3228, sock), 'abc')
    await writeFile(path, '壊れている')
    assert.equal(await readPeerToken(sessions, 3228, sock), undefined, 'does not throw even if broken')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('★★ writeToSocket: actually reaches the inbox (UDS round trip)', async () => {
  const base = await tempAccount()
  const sockPath = join(base, 'inbox.sock')
  const { server, lines } = await fakeInbox(sockPath)
  try {
    const r = await writeToSocket(sockPath, buildLines('テスト指示', { from: 'x' }))
    assert.equal(r.ok, true)
    assert.ok(await waitFor(() => lines.length > 0), 'must reach the inbox')
    assert.equal(
      (JSON.parse(lines[0]!) as { message: { content: string } }).message.content,
      'テスト指示',
    )
  } finally {
    server.close()
    await rm(base, { recursive: true, force: true })
  }
})

test('★★ writeToSocket: does not hang on an unreachable socket (missing / dead)', async () => {
  const base = await tempAccount()
  try {
    const started = Date.now()
    const r = await writeToSocket(join(base, 'いない.sock'), 'x\n')
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'unreachable')
    assert.ok(r.message, 'a reason can be shown on screen')
    // ⚠️ "Not being kept waiting" is the requirement. If this grows, it drags down approvals and list operations too
    assert.ok(Date.now() - started < 3000, `must give up quickly (${Date.now() - started}ms)`)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('★★ findTarget: does not send to a dead pid (pid reuse would reach another session)', async () => {
  const base = await tempAccount()
  try {
    const sessions = join(base, 'sessions')
    await writeFile(
      join(sessions, '4242.json'),
      JSON.stringify({
        pid: 4242,
        sessionId: 'S-dead',
        procStart: '1000',
        messagingSocketPath: '/run/user/1000/cc-socks/4242.sock',
      }),
    )
    // Dead
    const dead = await findTarget([dirOf(base)], 'S-dead', () => null)
    assert.deepEqual(dead, { reason: 'not-found' })
    // ★ Alive but different starttime = another process that reused the pid
    const reused = await findTarget([dirOf(base)], 'S-dead', () => '9999')
    assert.deepEqual(reused, { reason: 'not-found' }, 'must not send to a reused pid')
    // Alive and starttime matches
    const ok = await findTarget([dirOf(base)], 'S-dead', () => '1000')
    assert.ok(!('reason' in ok))
    assert.equal('reason' in ok ? null : ok.pid, 4242)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('★★ findTarget: does not send to a peer whose starttime cannot be verified (mac / pid reuse)', async () => {
  // ⚠️ Listing (selectLive) passes "alive but starttime unknown", but **writing does not**.
  //    Passing it could put the instruction into **another process** that reused the pid of an ended session
  //    (2026-08-14 external review, high. My comment "leave the guard to selectLive" was wrong)
  const base = await tempAccount()
  try {
    await writeFile(
      join(base, 'sessions', '4250.json'),
      JSON.stringify({
        pid: 4250,
        sessionId: 'S-mac',
        procStart: '1000',
        messagingSocketPath: '/tmp/x.sock',
      }),
    )
    // Alive but starttime unreadable (the mac case)
    assert.deepEqual(await findTarget([dirOf(base)], 'S-mac', () => undefined), {
      reason: 'unverified',
    })
    // Same when the index has no procStart
    await writeFile(
      join(base, 'sessions', '4251.json'),
      JSON.stringify({ pid: 4251, sessionId: 'S-noproc', messagingSocketPath: '/tmp/y.sock' }),
    )
    assert.deepEqual(await findTarget([dirOf(base)], 'S-noproc', () => '1000'), {
      reason: 'unverified',
    })
    assert.notEqual(failureMessage('unverified'), failureMessage('not-found'))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('★★ findTarget: does not send when the same sessionId is found more than once', async () => {
  // ⚠️ The API only takes sessionId, so with several matches we cannot decide which one it reaches.
  //    Silently picking the first means "the instruction lands in a different session than the tapped row" (external review, high)
  const a = await tempAccount()
  const b = await tempAccount()
  try {
    for (const [base, pid] of [[a, 4260], [b, 4261]] as const) {
      await writeFile(
        join(base, 'sessions', `${pid}.json`),
        JSON.stringify({
          pid,
          sessionId: 'S-dup',
          procStart: '1000',
          messagingSocketPath: `/tmp/${pid}.sock`,
        }),
      )
    }
    assert.deepEqual(await findTarget([dirOf(a), dirOf(b)], 'S-dup', () => '1000'), {
      reason: 'ambiguous',
    })
  } finally {
    await rm(a, { recursive: true, force: true })
    await rm(b, { recursive: true, force: true })
  }
})

test('★ findTarget: a live version without an inbox is distinguishable as "no inbox"', async () => {
  const base = await tempAccount()
  try {
    await writeFile(
      join(base, 'sessions', '4243.json'),
      JSON.stringify({ pid: 4243, sessionId: 'S-old', procStart: '1000' }), // no messagingSocketPath
    )
    const r = await findTarget([dirOf(base)], 'S-old', () => '1000')
    assert.deepEqual(r, { reason: 'no-inbox' })
    // ⚠️ The message shown on screen must differ ("not running" and "feature missing" are fixed differently)
    assert.notEqual(failureMessage('no-inbox'), failureMessage('not-found'))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('findTarget: skips accounts without an index while searching', async () => {
  const base = await tempAccount()
  const empty = await mkdtemp(join(tmpdir(), 'nyan-remote-inbox-none-'))
  try {
    await writeFile(
      join(base, 'sessions', '4244.json'),
      JSON.stringify({
        pid: 4244,
        sessionId: 'S-live',
        procStart: '1000',
        messagingSocketPath: '/tmp/x.sock',
      }),
    )
    const r = await findTarget([dirOf(empty), dirOf(base)], 'S-live', () => '1000')
    assert.ok(!('reason' in r))
  } finally {
    await rm(base, { recursive: true, force: true })
    await rm(empty, { recursive: true, force: true })
  }
})

// ★★ **Sending works on mac too (no `/proc`)** (2026-09-22 / got stuck on a real machine).
//
// ⚠️⚠️ Symptom: the screen said "cannot send because the session process cannot be verified".
//   The cause was `aliveProcStart` returning `undefined` (= cannot verify).
//   ⇒ It can now be read from `ps`, so check that **it passes in the same way**.
test('★★ on mac, sending works if the start time can be read (not unverified)', async () => {
  const base = await tempAccount()
  try {
    await writeFile(
      join(base, 'sessions', '67951.json'),
      JSON.stringify({
        pid: 67951,
        sessionId: 'S-mac',
        // ★ Value from a real machine (`lstart` in C locale, UTC)
        procStart: 'Mon Sep 21 23:12:13 2026',
        messagingSocketPath: '/tmp/cc.sock',
      }),
    )
    // ★ Read from `ps` (⚠️ passes even with different whitespace padding = `sameProcStart`)
    const ok = await findTarget([dirOf(base)], 'S-mac', () => 'Mon Sep 21 23:12:13  2026')
    assert.ok(!('reason' in ok), `refused: ${JSON.stringify(ok)}`)
    assert.equal('reason' in ok ? null : ok.pid, 67951)

    // ⚠️⚠️ **If it still cannot be read, refuse as before** (do not allow on our own / fail-closed)
    const no = await findTarget([dirOf(base)], 'S-mac', () => undefined)
    assert.deepEqual(no, { reason: 'unverified' })

    // ⚠️⚠️ **Refuse on mismatch** (pid reuse = typing into another process)
    const other = await findTarget([dirOf(base)], 'S-mac', () => 'Mon Sep 21 23:12:14 2026')
    assert.deepEqual(other, { reason: 'not-found' }, 'lets a mismatch through')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
