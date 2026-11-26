import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { statusLabel } from '../../../shared/types.ts'
import { validateCodexConfig } from '../config.ts'
import type { DaemonDeps } from './daemon.ts'
import { codexEnabled, codexLabelShared, codexFollowTick, codexHealth, codexHomes, codexNotice, codexRows, controlSocketOf, lookAtSocket, realSocketPath, startCodex, stopCodex } from './run.ts'
import { connectWsUds } from './wsUds.ts'

afterEach(() => stopCodex())

test('★ homes: on unless explicitly off (2026-11-15: on by default)', () => {
  const home = [{ id: '/home/user/.codex', label: '.codex', socketPath: '/home/user/.codex/app-server-control/app-server-control.sock' }]
  assert.deepEqual(codexHomes(undefined, {}, '/home/user'), home, 'no codex section')
  assert.deepEqual(codexHomes({}, {}, '/home/user'), home, 'a section without enabled')
  assert.deepEqual(codexHomes({ enabled: false, homes: ['/a/.codex'] }, {}, '/home/user'), [])
})

test('homes: default is ~/.codex, CODEX_HOME wins over it, configured homes win over both', () => {
  assert.deepEqual(codexHomes({ enabled: true }, {}, '/home/user'), [
    { id: '/home/user/.codex', label: '.codex', socketPath: '/home/user/.codex/app-server-control/app-server-control.sock' },
  ])
  assert.equal(codexHomes({ enabled: true }, { CODEX_HOME: '/data/codex-work' }, '/home/user')[0]!.id, '/data/codex-work')
  // A relative CODEX_HOME is not trusted to mean anything for a daemon started elsewhere
  assert.equal(codexHomes({ enabled: true }, { CODEX_HOME: 'relative' }, '/home/user')[0]!.id, '/home/user/.codex')
  const two = codexHomes({ enabled: true, homes: ['/a/.codex', '/b/.codex'] }, { CODEX_HOME: '/ignored' }, '/home/user')
  assert.deepEqual(
    two.map((h) => [h.id, h.label]),
    [
      ['/a/.codex', '.codex'],
      ['/b/.codex', '.codex'],
    ],
  )
})

test('homes: the same home written twice is watched once', () => {
  const homes = codexHomes({ enabled: true, homes: ['/a/.codex', '/a/.codex/', '/a/x/../.codex'] }, {}, '/home/user')
  assert.equal(homes.length, 1)
  assert.equal(controlSocketOf(homes[0]!.id), '/a/.codex/app-server-control/app-server-control.sock')
})

test('config: accepted and refused shapes', () => {
  assert.equal(validateCodexConfig(undefined), null)
  assert.equal(validateCodexConfig({ enabled: true }), null)
  assert.equal(validateCodexConfig({}), null, 'enabled may be left out (= on)')
  assert.equal(validateCodexConfig({ homes: ['/a'] }), null)
  assert.equal(validateCodexConfig({ enabled: false, homes: ['/a'], clientName: 'nyan-remote', clientVersion: '1.0' }), null)
  for (const bad of [
    null,
    [],
    'on',
    { enabled: 'yes' },
    { enabled: null },
    { enabled: true, homes: 'x' },
    { enabled: true, homes: ['relative'] },
    { enabled: true, clientName: '' },
    { enabled: true, clientName: 'bad\r\nheader' },
    { enabled: true, clientName: 'ねこ' },
    { enabled: true, clientName: 'x'.repeat(65) },
    { enabled: true, clientVersion: 5 },
  ]) {
    assert.equal(typeof validateCodexConfig(bad), 'string', JSON.stringify(bad))
  }
})

test('look: absent, a real socket (through a symlink, with its age), and a non-socket', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-codex-'))
  const server = createServer()
  try {
    assert.deepEqual(await lookAtSocket(join(dir, 'nope.sock')), { type: 'absent' })
    assert.deepEqual(await lookAtSocket(join(dir, 'no-dir', 'x.sock')), { type: 'absent' })

    const real = join(dir, 'real.sock')
    await new Promise<void>((r) => server.listen(real, r))
    const link = join(dir, 'link.sock')
    symlinkSync(real, link)
    const now = Date.now()
    const a = await lookAtSocket(link, now + 5000)
    assert.equal(a.type, 'present')
    if (a.type === 'present') {
      // ⚠️ The file time has sub-millisecond precision and `now` was read just before ⇒ allow a hair under 5000
      assert.ok(a.ageMs > 4990 && a.ageMs < 15_000, `age ${a.ageMs}`)
      const direct = await lookAtSocket(real, now)
      assert.equal(direct.type === 'present' && direct.key, a.key, 'the symlink and the socket are the same socket')
    }
    // A clock that is behind the file never yields a negative age (which would read as "settled long ago" after a wrap)
    const early = await lookAtSocket(real, 0)
    assert.equal(early.type === 'present' && early.ageMs, 0)

    const file = join(dir, 'plain')
    writeFileSync(file, 'x')
    assert.deepEqual(await lookAtSocket(file), { type: 'absent' })
    // A dangling symlink is "absent" (the daemon is gone), not an error
    symlinkSync(join(dir, 'gone'), join(dir, 'dangling.sock'))
    assert.deepEqual(await lookAtSocket(join(dir, 'dangling.sock')), { type: 'absent' })
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a socket behind a path longer than a socket address is reached through its real path', async () => {
  // ⚠️ Hit against the real binary: `<home>/app-server-control/app-server-control.sock` in a deep home is longer than
  //    sun_path (~107 bytes), and connecting to it fails with EINVAL. The daemon's own entry is a symlink to a short path.
  const short = mkdtempSync(join(tmpdir(), 'nc-'))
  const deep = mkdtempSync(join(tmpdir(), 'nyan-codex-deep-'))
  const server = createServer((sock) => sock.destroy())
  try {
    const real = join(short, 's')
    await new Promise<void>((r) => server.listen(real, r))
    const long = join(deep, 'x'.repeat(120))
    symlinkSync(real, long)
    assert.ok(Buffer.byteLength(long) > 108)
    // Directly: the address does not fit
    await assert.rejects(connectWsUds({ path: long, onMessage: () => undefined, handshakeTimeoutMs: 200 }), (e: unknown) => {
      assert.deepEqual(e, { reason: 'error', detail: 'EINVAL' })
      return true
    })
    assert.equal(await realSocketPath(long), real)
    // A path that vanished is reported in the shape of a failed connect
    await assert.rejects(realSocketPath(join(deep, 'gone')), (e: unknown) => {
      assert.deepEqual(e, { reason: 'error', detail: 'ENOENT' })
      return true
    })
  } finally {
    server.close()
    rmSync(short, { recursive: true, force: true })
    rmSync(deep, { recursive: true, force: true })
  }
})

const idleDeps: DaemonDeps = {
  look: async () => ({ type: 'absent' }),
  connect: async () => {
    throw new Error('must not connect')
  },
  sleep: (_ms, signal) => new Promise((r) => signal.addEventListener('abort', () => r(), { once: true })),
  now: () => 0,
  random: () => 0,
}

test('start: turned off starts nothing and reports nothing; no section means on', async () => {
  assert.equal(startCodex(undefined, { machine: 'pc-a', version: '1', deps: idleDeps, home: '/home/user' }), 1)
  stopCodex()
  assert.equal(startCodex({ enabled: false }, { machine: 'pc-a', version: '1', deps: idleDeps }), 0)
  assert.equal(codexEnabled(), false)
  assert.equal(codexHealth(), undefined)
  assert.deepEqual(await codexRows(), [])
})

test('start: enabled starts one line per home; stop turns it off again', async () => {
  const n = startCodex({ enabled: true, homes: ['/a/.codex', '/b/.codex'] }, { machine: 'pc-a', version: '1', deps: idleDeps })
  assert.equal(n, 2)
  // ★ two homes, one label: the team commands cannot tell which login a row is (codex review r2)
  assert.equal(codexLabelShared('.codex'), true)
  assert.equal(codexLabelShared('.other'), false)
  assert.equal(codexEnabled(), true)
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(
    codexHealth()?.map((h) => [h.home, h.state]),
    [
      ['.codex', 'no-daemon'],
      ['.codex', 'no-daemon'],
    ],
  )
  stopCodex()
  assert.equal(codexEnabled(), false)
  assert.equal(codexHealth(), undefined)
})

test('follow tick: nothing is read when Codex is off, when nobody is viewing, or for an id that is not a Codex row', async () => {
  assert.deepEqual(await codexFollowTick(new Set(['x'])), [], 'off')
  let connects = 0
  const deps: DaemonDeps = { ...idleDeps, connect: async () => { connects++; throw { reason: 'error', detail: 'ECONNREFUSED' } } }
  startCodex({ enabled: true, homes: ['/a/.codex'] }, { machine: 'pc-a', version: '1', deps })
  assert.deepEqual(await codexFollowTick(new Set()), [], 'nobody viewing')
  // A Claude session id (or anything else that is not one of our rows) is not ours to read
  assert.deepEqual(await codexFollowTick(new Set(['some-claude-session'])), [])
  assert.equal(connects, 0)
})

/** A daemon that answers `initialize` and an empty snapshot; `drop()` ends the current connection */
function answeringDeps(daemon: { threads?: Array<Record<string, unknown>>; turns?: Record<string, unknown> } = {}): {
  deps: DaemonDeps
  drop: () => void
  connects: () => number
  /** Push a notification on the current connection */
  emit: (method: string, params: unknown) => void
} {
  let connects = 0
  let end: (() => void) | undefined
  let push: ((text: string) => void) | undefined
  const deps: DaemonDeps = {
    look: async () => ({ type: 'present', ageMs: 60_000, key: 'a' }),
    connect: async (_path, onMessage) => {
      connects++
      push = onMessage
      const closed = new Promise<{ reason: 'eof' }>((r) => (end = () => r({ reason: 'eof' })))
      return {
        send: async (text, guard) => {
          if (guard && !guard()) throw new Error('ws-cancelled')
          const m = JSON.parse(text) as { id?: number; method: string }
          if (m.id === undefined) return
          const p = (m as { params?: { threadId?: string } }).params
          const threads = daemon.threads ?? []
          const result =
            m.method === 'initialize'
              ? { codexHome: '/home/user/.codex' }
              : m.method === 'thread/loaded/list'
                ? { data: threads.map((t) => t.id), nextCursor: null }
                : m.method === 'thread/read'
                  ? { thread: threads.find((t) => t.id === p?.threadId) }
                  : m.method === 'thread/turns/list' && daemon.turns
                    ? daemon.turns
                    : {}
          queueMicrotask(() => onMessage(JSON.stringify({ id: m.id, result })))
        },
        close: () => end?.(),
        closed,
      }
    },
    sleep: () => new Promise((r) => setImmediate(r)),
    now: () => 0,
    random: () => 0,
  }
  return { deps, drop: () => end?.(), connects: () => connects, emit: (method, params) => push?.(JSON.stringify({ method, params })) }
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000 && !cond(); i++) await new Promise((r) => setImmediate(r))
  assert.ok(cond(), `timed out waiting for: ${what}`)
}

test('★ the notice is logged once per agent start, on the first connect — not again on a reconnect (2026-11-15)', async () => {
  const d = answeringDeps()
  const logs: string[] = []
  startCodex(undefined, { machine: 'pc-a', version: '1', deps: d.deps, home: '/home/user', hooks: { log: (l) => logs.push(l) } })
  const notices = () => logs.filter((l) => l.includes('★'))
  await until(() => notices().length === 1, 'the notice')
  d.drop()
  await until(() => d.connects() === 2 && logs.filter((l) => l.endsWith(': connected')).length === 2, 'the reconnect')
  assert.equal(notices().length, 1, 'not again on a reconnect')
  // ⚠️ It says the name actually used and how to turn it off
  assert.equal(notices()[0], codexNotice('nyan-remote'))
  assert.match(codexNotice('nyan-remote'), /"enabled": false/)
  // A new agent start (startCodex) says it again
  startCodex({ clientName: 'other-name' }, { machine: 'pc-a', version: '1', deps: answeringDeps().deps, home: '/home/user', hooks: { log: (l) => logs.push(l) } })
  await until(() => notices().length === 2, 'the notice after a restart')
  assert.match(notices()[1]!, /other-name/)
})

test('★ a thread standing at a usage limit when the agent starts: the row says rate-limited and nothing rings at start', async () => {
  const thread = {
    id: 't1', parentThreadId: null, preview: 'p', ephemeral: false, updatedAt: 1000, status: { type: 'systemError' },
    cwd: '/home/user/proj', cliVersion: '0.172.0', source: 'vscode', threadSource: 'user', gitInfo: null, name: 'Fix login',
  }
  const turns = { data: [{ id: 'turn-1', status: 'failed', items: [], error: { message: 'm', codexErrorInfo: 'usageLimitExceeded' } }], nextCursor: null }
  const d = answeringDeps({ threads: [thread], turns })
  const sent: string[] = []
  const logs: string[] = []
  startCodex(undefined, {
    machine: 'pc-a', version: '1', deps: d.deps, home: '/home/user',
    notify: async (_row, fields) => { sent.push(fields.label); return 1 },
    hooks: { log: (l) => logs.push(l) },
  })
  const limited = async (): Promise<boolean> => (await codexRows()).some((r) => r.status === 'rate-limited')
  const untilAsync = async (cond: () => Promise<boolean>, what: string): Promise<void> => {
    for (let i = 0; i < 2000 && !(await cond()); i++) await new Promise((r) => setImmediate(r))
    assert.ok(await cond(), `timed out waiting for: ${what}`)
  }
  await untilAsync(limited, 'the quiet settle')
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r))
  assert.deepEqual(sent, [], 'nothing at start')
  d.drop()
  await until(() => d.connects() === 2 && logs.filter((l) => l.endsWith(': connected')).length === 2, 'the reconnect')
  await untilAsync(limited, 'the standing row read again')
  await until(() => sent.length >= 1, 'the reconnect tells it')
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r))
  // ⚠️ A reconnect tells standing rows once (as it told "failed" before): it does not know what was sent before it
  assert.deepEqual(sent, [statusLabel('rate-limited')], 'none at start; the reconnect tells it once')
  stopCodex()
})

test('★ live: a running thread that goes to systemError at a usage limit rings "rate-limited" once, and the row says so', async () => {
  const thread = {
    id: 't1', parentThreadId: null, preview: 'p', ephemeral: false, updatedAt: 1000, status: { type: 'idle' },
    cwd: '/home/user/proj', cliVersion: '0.172.0', source: 'vscode', threadSource: 'user', gitInfo: null, name: 'Fix login',
  }
  const turns = { data: [{ id: 'turn-1', status: 'failed', items: [], error: { message: 'm', codexErrorInfo: 'usageLimitExceeded' } }], nextCursor: null }
  const d = answeringDeps({ threads: [thread], turns })
  const sent: string[] = []
  startCodex(undefined, { machine: 'pc-a', version: '1', deps: d.deps, home: '/home/user', notify: async (_row, fields) => { sent.push(fields.label); return 1 } })
  await until(() => d.connects() === 1, 'connected')
  const rowsAre = async (status: string): Promise<boolean> => (await codexRows()).some((r) => r.status === status)
  for (let i = 0; i < 2000 && !(await rowsAre('idle')); i++) await new Promise((r) => setImmediate(r))
  d.emit('thread/status/changed', { threadId: 't1', status: { type: 'active', activeFlags: [] } })
  d.emit('thread/status/changed', { threadId: 't1', status: { type: 'systemError' } })
  for (let i = 0; i < 2000 && !(await rowsAre('rate-limited')); i++) await new Promise((r) => setImmediate(r))
  await until(() => sent.length >= 1, 'the push')
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r))
  assert.deepEqual(sent, [statusLabel('rate-limited')])
  assert.ok(await rowsAre('rate-limited'))
  stopCodex()
})

test('★ a PC without Codex logs its first state too (nyan status reads "no Codex" from it)', async () => {
  const logs: string[] = []
  startCodex(undefined, { machine: 'pc-a', version: '1', deps: idleDeps, home: '/home/user', hooks: { log: (l) => logs.push(l) } })
  await until(() => logs.length > 0, 'a log line')
  assert.deepEqual(logs, ['[codex] start: homes=1 name=nyan-remote', '[codex] /home/user/.codex: no-daemon'])
})
