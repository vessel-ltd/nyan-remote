import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { codexSessionPrefix, nextBackoff, POLL_MS, SEND_HOLD_MS, SETTLE_MS, startCodexDaemonLine, type DaemonDeps, type DaemonHooks, type SocketLook } from './daemon.ts'
import type { StatusChange } from './threads.ts'
import type { WsClosed, WsUdsConnection } from './wsUds.ts'

function thread(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    parentThreadId: null,
    preview: `preview of ${id}`,
    ephemeral: false,
    updatedAt: 1000,
    status: { type: 'idle' },
    cwd: '/home/user/proj',
    cliVersion: '0.169.0',
    source: 'vscode',
    threadSource: 'user',
    gitInfo: null,
    name: null,
    turns: [],
    ...over,
  }
}

/** One fake daemon process: answers like the app-server, and lets the test push notifications / drop the line. */
class FakeDaemon {
  threads = new Map<string, Record<string, unknown>>()
  received: Array<Record<string, unknown>> = []
  connections = 0
  initializeError = false
  pageSize = 100
  /** A broken daemon that hands back the cursor it was given, forever */
  stuckCursor = false
  /** Server requests replayed to a connection that joins a thread */
  waitingRequests: Array<Record<string, unknown>> = []
  /** `turn/start` is taken but never answered (the outcome stays unknown to the caller) */
  silentTurnStart = false
  /** `turn/start` answers with this error instead of a turn */
  turnStartError: { code: number; message: string } | undefined
  /** `thread/turns/list` answers with this page (unset = the method is unknown, as right after a thread starts) */
  turnsPage: Record<string, unknown> | undefined
  /** Called as `thread/turns/list` is answered (a test can hold the next write from here) */
  onTurnsList: (() => void) | undefined
  /** `turn/interrupt` answers with this error instead of `{}` */
  interruptError: { code: number; message: string } | undefined
  /** Writes wait for this first (backpressure). ⚠️ Like the real line, `guard` is asked only when the write's turn comes. */
  gate: Promise<void> = Promise.resolve()
  /** `thread/read` answers wait for this (a read in flight) */
  readGate: Promise<void> = Promise.resolve()
  #push: ((text: string) => void) | undefined
  #end: ((why: WsClosed) => void) | undefined

  connect = async (_path: string, onMessage: (text: string) => void): Promise<WsUdsConnection> => {
    this.connections++
    this.#push = onMessage
    let over = false
    const closed = new Promise<WsClosed>((r) => {
      this.#end = (why) => {
        if (over) return
        over = true
        r(why)
      }
    })
    return {
      send: async (text, guard) => {
        await this.gate
        if (over) throw new Error('ws-closed')
        if (guard && !guard()) throw new Error('ws-cancelled')
        const msg = JSON.parse(text) as Record<string, unknown>
        this.received.push(msg)
        queueMicrotask(() => this.#answer(msg))
      },
      close: () => this.#end?.({ reason: 'local' }),
      closed,
    }
  }

  #answer(msg: Record<string, unknown>): void {
    if (typeof msg.method !== 'string' || !('id' in msg)) return
    const params = (msg.params ?? {}) as Record<string, unknown>
    const reply = (result: unknown): void => this.#push?.(JSON.stringify({ id: msg.id, result }))
    switch (msg.method) {
      case 'initialize':
        if (this.initializeError) this.#push?.(JSON.stringify({ id: msg.id, error: { code: -32600, message: 'no' } }))
        else reply({ userAgent: 'x', codexHome: '/home/user/.codex', platformFamily: 'unix', platformOs: 'linux' })
        break
      case 'thread/loaded/list': {
        const ids = [...this.threads.keys()]
        const start = typeof params.cursor === 'string' ? Number(params.cursor) : 0
        const end = start + this.pageSize
        if (this.stuckCursor) reply({ data: [], nextCursor: typeof params.cursor === 'string' ? params.cursor : 'c' })
        else reply({ data: ids.slice(start, end), nextCursor: end < ids.length ? String(end) : null })
        break
      }
      case 'thread/read': {
        // ★ What the daemon would serve now; the answer itself may be held back (`readGate`)
        const t = this.threads.get(String(params.threadId))
        if (t) void this.readGate.then(() => reply({ thread: t }))
        else this.#push?.(JSON.stringify({ id: msg.id, error: { code: -32600, message: 'not found' } }))
        break
      }
      case 'thread/resume':
        reply({ thread: this.threads.get(String(params.threadId)) })
        // ★ Like the real daemon: joining replays the requests that are waiting
        for (const r of this.waitingRequests) this.#push?.(JSON.stringify(r))
        break
      case 'thread/unsubscribe':
        reply({ status: 'unsubscribed' })
        break
      case 'thread/turns/list':
        this.onTurnsList?.()
        if (this.turnsPage) reply(this.turnsPage)
        else this.#push?.(JSON.stringify({ id: msg.id, error: { code: -32601, message: 'unknown' } }))
        break
      case 'turn/interrupt':
        if (this.interruptError) this.#push?.(JSON.stringify({ id: msg.id, error: this.interruptError }))
        else reply({})
        break
      case 'turn/start':
        if (this.silentTurnStart) break
        if (this.turnStartError) this.#push?.(JSON.stringify({ id: msg.id, error: this.turnStartError }))
        else reply({ turn: { id: 'turn-new', status: 'inProgress', items: [] } })
        break
      default:
        this.#push?.(JSON.stringify({ id: msg.id, error: { code: -32601, message: 'unknown' } }))
    }
  }

  notify(method: string, params: unknown): void {
    this.#push?.(JSON.stringify({ method, params }))
  }
  request(id: number | string, method: string, params: unknown): void {
    this.#push?.(JSON.stringify({ id, method, params }))
  }
  drop(why: WsClosed = { reason: 'eof' }): void {
    this.#end?.(why)
  }
  methods(): string[] {
    return this.received.map((m) => String(m.method))
  }
}

interface World {
  deps: DaemonDeps
  daemon: FakeDaemon
  sleeps: number[]
  socket: { look: SocketLook }
  clock: { now: number }
}

/** Virtual time: `sleep` advances the clock and yields once. The socket's age advances with the clock. */
function world(look: SocketLook = { type: 'present', ageMs: 60_000, key: 'a' }): World {
  const daemon = new FakeDaemon()
  const sleeps: number[] = []
  const socket = { look }
  const clock = { now: 1_000_000 }
  const deps: DaemonDeps = {
    look: async () => socket.look,
    connect: daemon.connect,
    sleep: (ms, signal) =>
      new Promise<void>((resolve) => {
        sleeps.push(ms)
        clock.now += ms
        if (socket.look.type === 'present') socket.look = { ...socket.look, ageMs: socket.look.ageMs + ms }
        if (signal.aborted) return resolve()
        setImmediate(resolve)
      }),
    now: () => clock.now,
    random: () => 1,
  }
  return { deps, daemon, sleeps, socket, clock }
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (cond()) return
    await new Promise((r) => setImmediate(r))
  }
  assert.fail(`timed out waiting for: ${what}`)
}

// ⚠️ Every line is stopped after its test **even when an assertion failed**. A line left running keeps the process
//    alive with its reconnect loop, so a failing test would hang instead of failing (found by mutating daemon.ts).
const started: Array<{ stop(): void }> = []
afterEach(() => {
  for (const l of started.splice(0)) l.stop()
})

type TestHooks = { changes?: StatusChange[]; onChange?: () => void; offerApproval?: DaemonHooks['offerApproval']; closed?: string[] }

function start(w: World, hooks: TestHooks = {}) {
  const line = startLine(w, hooks)
  started.push(line)
  return line
}

function startLine(w: World, hooks: TestHooks = {}, rpcTimeoutMs?: number) {
  return startCodexDaemonLine({
    ...(rpcTimeoutMs === undefined ? {} : { rpcTimeoutMs }),
    home: { id: 'default', label: '.codex', socketPath: '/x/app-server-control.sock' },
    machine: 'pc-a',
    clientName: 'nyan-remote',
    clientVersion: '1.2.3',
    deps: w.deps,
    hooks: {
      onStatus: (c) => hooks.changes?.push(c),
      ...(hooks.onChange ? { onChange: hooks.onChange } : {}),
      ...(hooks.offerApproval ? { offerApproval: hooks.offerApproval } : {}),
      ...(hooks.closed ? { onClosed: (id: string) => hooks.closed!.push(id) } : {}),
    },
  })
}

test('backoff: doubles from 1s, caps at 60s, jitter stays within 50–100% of the step', () => {
  assert.equal(nextBackoff(0, 1), 1000)
  assert.equal(nextBackoff(0, 0), 500)
  assert.equal(nextBackoff(1000, 1), 2000)
  assert.equal(nextBackoff(32_000, 1), 60_000)
  assert.equal(nextBackoff(60_000, 1), 60_000)
  assert.equal(nextBackoff(60_000, 0), 30_000)
})

test('connects, identifies as given, declares nothing experimental, and only reads', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1'))
  w.daemon.threads.set('title', thread('title', { threadSource: 'thread_title', ephemeral: true }))
  const line = start(w)
  await until(() => line.rows().length === 1, 'the snapshot')
  assert.deepEqual(w.daemon.received[0], {
    id: 1,
    method: 'initialize',
    params: {
      clientInfo: { name: 'nyan-remote', title: null, version: '1.2.3' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    },
  })
  assert.deepEqual(w.daemon.received[1], { method: 'initialized' })
  // ⚠️ The whole vocabulary of this layer. Anything else (resume, turn/start, config) must not appear.
  const allowed = new Set(['initialize', 'initialized', 'thread/loaded/list', 'thread/read'])
  for (const m of w.daemon.methods()) assert.ok(allowed.has(m), `unexpected method: ${m}`)
  // ⚠️ `thread/read` never asks for turns
  for (const m of w.daemon.received) if (m.method === 'thread/read') assert.deepEqual(m.params, { threadId: (m.params as { threadId: string }).threadId })

  const row = line.rows()[0]!
  // ⚠️ Never the bare thread id (codex review, high #1)
  assert.equal(row.sessionId, `${codexSessionPrefix('default')}t1`)
  assert.equal(line.threadOf(row.sessionId), 't1')
  assert.equal(row.tool, 'codex')
  assert.equal(row.machine, 'pc-a')
  assert.equal(row.account, '.codex')
  const h = line.health()
  assert.equal(h.state, 'connected')
  assert.deepEqual(h.hidden, { thread_title: 1 })
  line.stop()
  await line.done
  assert.equal(line.health().state, 'stopped')
})

test('no socket: waits and never connects (never starts a daemon)', async () => {
  const w = world({ type: 'absent' })
  const line = start(w)
  await until(() => w.sleeps.length >= 3, 'a few polls')
  assert.equal(w.daemon.connections, 0)
  assert.equal(line.health().state, 'no-daemon')
  assert.ok(w.sleeps.every((ms) => ms === POLL_MS))
  line.stop()
  await line.done
})

test('a young socket is not initialized until it has settled', async () => {
  const w = world({ type: 'present', ageMs: 200, key: 'fresh' })
  const line = start(w)
  await until(() => w.daemon.connections === 1, 'the connection')
  assert.equal(w.sleeps[0], SETTLE_MS - 200, 'the first thing it does is wait out the settle time')
  line.stop()
  await line.done
})

test('a socket that vanishes during the settle wait is not connected to', async () => {
  const w = world({ type: 'present', ageMs: 0, key: 'fresh' })
  const realSleep = w.deps.sleep
  w.deps.sleep = async (ms, signal) => {
    await realSleep(ms, signal)
    if (ms === SETTLE_MS) w.socket.look = { type: 'absent' }
  }
  const line = start(w)
  await until(() => line.health().state === 'no-daemon', 'the daemon going away')
  assert.equal(w.daemon.connections, 0)
  line.stop()
  await line.done
})

test('a socket we may not open is "denied", distinct from "no daemon", and is not connected to', async () => {
  const w = world({ type: 'denied', code: 'EACCES' })
  const line = start(w)
  await until(() => w.sleeps.length >= 1, 'one wait')
  const h = line.health()
  assert.equal(h.state, 'denied')
  assert.equal(h.detail, 'EACCES')
  assert.equal(w.daemon.connections, 0)
  line.stop()
  await line.done
})

test('status notifications update the row and reach the notifier; "done" needs an active we saw', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1'))
  const changes: StatusChange[] = []
  let changed = 0
  const line = start(w, { changes, onChange: () => changed++ })
  await until(() => line.rows().length === 1, 'the snapshot')
  assert.equal(line.rows()[0]!.status, 'idle')

  w.daemon.notify('thread/status/changed', { threadId: 't1', status: { type: 'active', activeFlags: [] } })
  w.daemon.notify('thread/status/changed', { threadId: 't1', status: { type: 'active', activeFlags: ['waitingOnApproval'] } })
  w.daemon.notify('thread/status/changed', { threadId: 't1', status: { type: 'idle' } })
  assert.deepEqual(
    changes.map((c) => (c.type === 'changed' ? [c.from, c.to] : c.type)),
    [
      ['idle', 'working'],
      ['working', 'waiting'],
      ['waiting', 'done'],
    ],
  )
  assert.equal(line.rows()[0]!.status, 'done')
  assert.ok(changed >= 3)
  line.stop()
  await line.done
})

test('a thread first heard of through a status change is read once and becomes a row', async () => {
  const w = world()
  const line = start(w)
  await until(() => line.health().state === 'connected' && w.daemon.methods().includes('thread/loaded/list'), 'connected')
  w.daemon.threads.set('late', thread('late', { status: { type: 'active', activeFlags: [] } }))
  w.daemon.notify('thread/status/changed', { threadId: 'late', status: { type: 'active', activeFlags: [] } })
  await until(() => line.rows().length === 1, 'the late thread')
  assert.equal(line.rows()[0]!.status, 'working')
  line.stop()
  await line.done
})

test('thread/started adds a row, thread/closed removes it', async () => {
  const w = world()
  const line = start(w)
  await until(() => line.health().state === 'connected', 'connected')
  w.daemon.notify('thread/started', { thread: thread('new') })
  assert.equal(line.rows().length, 1)
  w.daemon.notify('thread/closed', { threadId: 'new' })
  assert.equal(line.rows().length, 0)
  line.stop()
  await line.done
})

test('thread/closed tells the caller once, and only for a thread that was listed', async () => {
  const w = world()
  const closed: string[] = []
  const line = start(w, { closed })
  await until(() => line.health().state === 'connected', 'connected')
  w.daemon.notify('thread/started', { thread: thread('new') })
  // ⚠️ An id we never listed (it could be anything, e.g. a Claude session id) ends nothing
  w.daemon.notify('thread/closed', { threadId: 'never-listed' })
  w.daemon.notify('thread/closed', { threadId: 'new' })
  w.daemon.notify('thread/closed', { threadId: 'new' })
  assert.deepEqual(closed, [`${codexSessionPrefix('default')}new`], 'told with the row id')
  line.stop()
  await line.done
})

test('thread/name/updated re-reads a listed thread so the row takes the new name', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1', { status: { type: 'active', activeFlags: [] } }))
  const line = start(w)
  await until(() => line.rows().length === 1, 'the snapshot')
  w.daemon.threads.set('t1', thread('t1', { name: 'renamed', status: { type: 'active', activeFlags: [] } }))
  w.daemon.notify('thread/name/updated', { threadId: 't1', threadName: 'renamed' })
  await until(() => line.rows()[0]!.title === 'renamed', 'the new name')
  assert.equal(line.rows()[0]!.status, 'working')
  // ⚠️ A rename of a thread we do not list reads nothing (it never makes a thread appear)
  const reads = w.daemon.received.filter((m) => m.method === 'thread/read').length
  w.daemon.threads.set('other', thread('other', { name: 'x' }))
  w.daemon.notify('thread/name/updated', { threadId: 'other', threadName: 'x' })
  w.daemon.notify('thread/name/updated', { threadId: 7 })
  await new Promise((r) => setImmediate(r))
  assert.equal(w.daemon.received.filter((m) => m.method === 'thread/read').length, reads)
  assert.equal(line.rows().length, 1)
  line.stop()
  await line.done
})

const WAITING = { type: 'active', activeFlags: ['waitingOnApproval'] }
const approvalRequest = (id: number | string, threadId: string): Record<string, unknown> => ({
  id,
  method: 'item/commandExecution/requestApproval',
  params: { kind: 'command', threadId, turnId: 'turn-1', itemId: 'item-1', command: 'touch x', availableDecisions: ['accept', 'cancel'] },
})
const responsesOf = (w: World): Array<Record<string, unknown>> => w.daemon.received.filter((m) => !('method' in m))

test('approvals: a thread that starts waiting is joined, the replayed request becomes a card, and yes goes back as accept', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1', { status: { type: 'active', activeFlags: [] } }))
  const cards: Array<{ command: string; project: string; decide: (d: 'yes' | 'no' | undefined) => void }> = []
  const line = start(w, {
    offerApproval: (approval, row) =>
      new Promise((decide) => cards.push({ command: approval.command, project: row.project, decide })),
  })
  await until(() => line.rows().length === 1, 'the snapshot')
  assert.ok(!w.daemon.methods().includes('thread/resume'), 'not joined while it is not waiting')
  w.daemon.waitingRequests = [approvalRequest(7, 't1')]
  w.daemon.notify('thread/status/changed', { threadId: 't1', status: WAITING })
  await until(() => cards.length === 1, 'the card')
  assert.deepEqual(w.daemon.received.find((m) => m.method === 'thread/resume')!.params, { threadId: 't1', excludeTurns: true })
  assert.deepEqual({ command: cards[0]!.command, project: cards[0]!.project }, { command: 'touch x', project: 'proj' })
  assert.equal(line.health().unansweredRequests, 0)
  cards[0]!.decide('yes')
  await until(() => responsesOf(w).length === 1, 'the answer')
  assert.deepEqual(responsesOf(w), [{ id: 7, result: { decision: 'accept' } }])
  // The turn goes on ⇒ we leave the thread
  w.daemon.notify('serverRequest/resolved', { threadId: 't1', requestId: 7 })
  w.daemon.notify('thread/status/changed', { threadId: 't1', status: { type: 'active', activeFlags: [] } })
  await until(() => w.daemon.methods().includes('thread/unsubscribe'), 'leaving')
  line.stop()
  await line.done
})

test('approvals off (no hook): a waiting thread is never joined and its request is never answered', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1', { status: WAITING }))
  const line = start(w)
  await until(() => line.rows().length === 1, 'the snapshot')
  w.daemon.notify('thread/status/changed', { threadId: 't1', status: { type: 'active', activeFlags: [] } })
  w.daemon.notify('thread/status/changed', { threadId: 't1', status: WAITING })
  w.daemon.request(1, 'item/commandExecution/requestApproval', approvalRequest(1, 't1').params)
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
  assert.ok(!w.daemon.methods().includes('thread/resume'))
  assert.deepEqual(responsesOf(w), [])
  assert.equal(line.health().unansweredRequests, 1)
  line.stop()
  await line.done
})

test('approvals: a thread already waiting when we connect is joined from the snapshot', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1', { status: WAITING }))
  w.daemon.waitingRequests = [approvalRequest(1, 't1')]
  let offered = 0
  const line = start(w, { offerApproval: () => new Promise(() => offered++) })
  await until(() => offered === 1, 'the card')
  line.stop()
  await line.done
})

test('approvals: answered on the PC, or the line dropping, takes the card away without an answer', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1', { status: WAITING }))
  w.daemon.waitingRequests = [approvalRequest(1, 't1')]
  const withdrawn: number[] = []
  let n = 0
  const line = start(w, {
    offerApproval: (_a, _row, onWithdraw) =>
      new Promise((resolve) => {
        const mine = ++n
        onWithdraw(() => {
          withdrawn.push(mine)
          resolve(undefined)
        })
      }),
  })
  await until(() => n === 1, 'the card')
  w.daemon.notify('serverRequest/resolved', { threadId: 't1', requestId: 1 })
  await until(() => withdrawn.length === 1, 'withdrawn by the PC answer')
  // The request is still replayed after a reconnect (a new card on the new connection)
  w.daemon.drop()
  await until(() => n === 2, 'the card on the new connection')
  w.daemon.drop()
  await until(() => withdrawn.length === 2, 'withdrawn by the drop')
  assert.deepEqual(responsesOf(w), [])
  line.stop()
  await line.done
})

test('approvals: requests that are not a plain command are still never answered, joined or not', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1', { status: WAITING }))
  w.daemon.waitingRequests = [
    { id: 1, method: 'item/fileChange/requestApproval', params: { threadId: 't1', turnId: 'a', itemId: 'b' } },
    { id: 2, method: 'item/tool/requestUserInput', params: { threadId: 't1' } },
  ]
  let offered = 0
  const line = start(w, { offerApproval: () => new Promise(() => offered++) })
  await until(() => line.health().unansweredRequests === 2, 'both counted')
  assert.equal(offered, 0)
  assert.deepEqual(responsesOf(w), [])
  line.stop()
  await line.done
})

test('a server request is never answered (no result, no error), only counted', async () => {
  const w = world()
  const line = start(w)
  await until(() => line.health().state === 'connected' && w.daemon.methods().includes('thread/loaded/list'), 'connected')
  const before = w.daemon.received.length
  w.daemon.request(0, 'item/commandExecution/requestApproval', { threadId: 't', command: 'rm -rf /' })
  w.daemon.request('q', 'some/futureRequest', {})
  await new Promise((r) => setImmediate(r))
  assert.equal(w.daemon.received.length, before, 'nothing was sent in reply')
  assert.equal(line.health().unansweredRequests, 2)
  line.stop()
  await line.done
})

test('hostile notifications do not throw and do not change rows', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1'))
  const line = start(w)
  await until(() => line.rows().length === 1, 'the snapshot')
  for (const [m, p] of [
    ['thread/status/changed', null],
    ['thread/status/changed', 'x'],
    ['thread/status/changed', { threadId: 5, status: { type: 'idle' } }],
    ['thread/status/changed', { threadId: 't1', status: { type: 'mystery' } }],
    ['thread/started', { thread: 'nope' }],
    ['thread/closed', { threadId: {} }],
    ['never/heardOf', { a: 1 }],
  ] as Array<[string, unknown]>) {
    assert.doesNotThrow(() => w.daemon.notify(m, p), m)
  }
  assert.equal(line.rows().length, 1)
  assert.equal(line.rows()[0]!.status, 'idle')
  line.stop()
  await line.done
})

test('EOF: rows are dropped, it reconnects with growing waits, and the new generation remembers nothing', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1', { status: { type: 'active', activeFlags: [] } }))
  const line = start(w)
  await until(() => line.rows().length === 1, 'the snapshot')
  assert.equal(line.rows()[0]!.status, 'working')

  // The daemon restarts: bare EOF, and afterwards the thread is idle
  w.daemon.threads.set('t1', thread('t1', { status: { type: 'idle' } }))
  w.daemon.drop()
  await until(() => w.daemon.connections === 2 && line.rows().length === 1, 'the reconnect')
  // ⚠️ Not "done": this connection never saw it active
  assert.equal(line.rows()[0]!.status, 'idle')

  w.daemon.drop()
  await until(() => w.daemon.connections === 3, 'the second reconnect')
  w.daemon.drop()
  await until(() => w.daemon.connections === 4, 'the third reconnect')
  assert.deepEqual(w.sleeps.slice(0, 3), [1000, 2000, 4000])
  line.stop()
  await line.done
})

test('rows are gone the moment the line drops (not kept until the reconnect)', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1'))
  const line = start(w)
  await until(() => line.rows().length === 1, 'the snapshot')
  w.socket.look = { type: 'absent' }
  w.daemon.drop()
  await until(() => line.health().state === 'no-daemon', 'noticing the daemon is gone')
  assert.deepEqual(line.rows(), [])
  line.stop()
  await line.done
})

test('a line that stayed up long enough starts the backoff over', async () => {
  const w = world()
  const line = start(w)
  await until(() => line.health().state === 'connected', 'connected')
  w.daemon.drop()
  await until(() => w.daemon.connections === 2 && line.health().state === 'connected', 'reconnect 1')
  w.clock.now += 31_000
  w.daemon.drop()
  await until(() => w.daemon.connections === 3, 'reconnect 2')
  assert.deepEqual(w.sleeps.slice(0, 2), [1000, 1000])
  line.stop()
  await line.done
})

test('a refused initialize does not leave a half-open line, and is retried with backoff', async () => {
  const w = world()
  w.daemon.initializeError = true
  const line = start(w)
  await until(() => w.daemon.connections >= 2, 'a retry')
  assert.equal(line.rows().length, 0)
  assert.ok(!w.daemon.methods().includes('thread/loaded/list'), 'nothing is read on a line that did not initialize')
  assert.equal(line.health().detail, 'error:initialize:error')
  line.stop()
  await line.done
})

test('the snapshot follows cursors but not forever', async () => {
  const w = world()
  for (let i = 0; i < 7; i++) w.daemon.threads.set(`t${i}`, thread(`t${i}`, { updatedAt: 1000 + i }))
  w.daemon.pageSize = 3
  const line = start(w)
  await until(() => line.rows().length === 7, 'all pages')
  assert.equal(w.daemon.methods().filter((m) => m === 'thread/loaded/list').length, 3)
  line.stop()
  await line.done
})

test('a cursor that does not advance ends the snapshot at once (not after the page cap)', async () => {
  const w = world()
  w.daemon.stuckCursor = true
  const line = start(w)
  await until(() => w.daemon.methods().filter((m) => m === 'thread/loaded/list').length >= 2, 'two pages')
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  assert.equal(w.daemon.methods().filter((m) => m === 'thread/loaded/list').length, 2)
  line.stop()
  await line.done
})

test('turns: read only for a thread that is a row, with explicit order and view; a refusal is not remembered', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1'))
  w.daemon.threads.set('title', thread('title', { threadSource: 'thread_title', ephemeral: true }))
  const line = start(w)
  await until(() => line.rows().length === 1, 'the snapshot')
  const gen = line.generation()
  const before = w.daemon.received.length

  // Not a row (unknown, or hidden): the daemon is not asked at all
  assert.equal(await line.turns('nope', { limit: 5 }), undefined)
  assert.equal(await line.turns('title', { limit: 5 }), undefined)
  assert.equal(w.daemon.received.length, before)

  // The fake daemon does not know the method (as a real one says right after creating a thread): undefined, and we may ask again
  assert.equal(await line.turns('t1', { limit: 5 }), undefined)
  assert.equal(await line.turns('t1', { limit: 5, cursor: 'opaque' }), undefined)
  const sent = w.daemon.received.slice(before).map((m) => m.params)
  assert.deepEqual(sent, [
    { threadId: 't1', limit: 5, sortDirection: 'desc', itemsView: 'full' },
    { threadId: 't1', limit: 5, sortDirection: 'desc', itemsView: 'full', cursor: 'opaque' },
  ])

  // A reconnect is a new generation
  w.daemon.drop()
  await until(() => w.daemon.connections === 2 && line.rows().length === 1, 'the reconnect')
  assert.equal(line.generation(), gen + 1)
  line.stop()
  await line.done
  assert.equal(await line.turns('t1', { limit: 5 }), undefined, 'nothing is read on a stopped line')
})

test('stop: ends while waiting, closes the line, and the loop finishes', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1'))
  const line = start(w)
  await until(() => line.rows().length === 1, 'the snapshot')
  line.stop()
  await line.done
  assert.equal(line.health().state, 'stopped')
  assert.deepEqual(line.rows(), [])
  const n = w.daemon.connections
  await new Promise((r) => setImmediate(r))
  assert.equal(w.daemon.connections, n, 'no reconnect after stop')
})

test('★ send: an idle row gets a turn/start with the thread id and the text, and nothing else', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1'))
  const line = start(w)
  await until(() => line.rows().length === 1, 'the snapshot')
  assert.deepEqual(await line.send('t1', 'hello\nthere'), { ok: true })
  const sent = w.daemon.received.filter((m) => m.method === 'turn/start')
  assert.equal(sent.length, 1)
  // ⚠️⚠️ No model / sandbox / approval-policy / cwd override may ever ride along (each outlives the turn)
  assert.deepEqual(sent[0]!.params, { threadId: 't1', input: [{ type: 'text', text: 'hello\nthere' }] })
  line.stop()
  await line.done
})

test('send: a thread that works or waits, and an id that is not a row, are refused without asking the daemon', async () => {
  const w = world()
  w.daemon.threads.set('busy', thread('busy', { status: { type: 'active', activeFlags: [] } }))
  w.daemon.threads.set('waiting', thread('waiting', { status: WAITING }))
  w.daemon.threads.set('broken', thread('broken', { status: { type: 'systemError' } }))
  const line = start(w)
  await until(() => line.rows().length === 3, 'the snapshot')
  assert.deepEqual(await line.send('busy', 'x'), { ok: false, reason: 'busy' })
  assert.deepEqual(await line.send('waiting', 'x'), { ok: false, reason: 'busy' })
  assert.deepEqual(await line.send('broken', 'x'), { ok: false, reason: 'busy' })
  assert.deepEqual(await line.send('some-claude-session', 'x'), { ok: false, reason: 'not-listed' })
  assert.ok(!w.daemon.methods().includes('turn/start'))
  line.stop()
  await line.done
  assert.deepEqual(await line.send('busy', 'x'), { ok: false, reason: 'not-listed' }, 'after the line ended')
})

test('send: a refusal by the daemon is reported by kind and code only (its message could quote the text)', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1'))
  w.daemon.turnStartError = { code: -32600, message: 'cannot take "the secret text"' }
  const line = start(w)
  await until(() => line.rows().length === 1, 'the snapshot')
  assert.deepEqual(await line.send('t1', 'the secret text'), { ok: false, reason: 'failed', detail: 'error -32600' })
  line.stop()
  await line.done
})

// ── codex review (2026-11-15) ────────────────────────────────────────────────────────────────────────────────

/** A gate the test opens by hand */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((r) => (open = r))
  return { promise, open }
}

test('★ send: two sends at once — only the first reaches the daemon, the second is busy (high #3)', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1'))
  const line = start(w)
  await until(() => line.rows().length === 1, 'the snapshot')
  // Both phones saw "idle"; neither has heard back yet
  const a = line.send('t1', 'first')
  const b = line.send('t1', 'second')
  assert.deepEqual(await b, { ok: false, reason: 'busy' })
  assert.deepEqual(await a, { ok: true })
  assert.equal(w.daemon.received.filter((m) => m.method === 'turn/start').length, 1)
  // Still held after success: the status has not moved yet
  assert.deepEqual(await line.send('t1', 'third'), { ok: false, reason: 'busy' })
  // The turn starts and ends ⇒ judged from the status again
  w.daemon.notify('thread/status/changed', { threadId: 't1', status: { type: 'active', activeFlags: [] } })
  w.daemon.notify('thread/status/changed', { threadId: 't1', status: { type: 'idle' } })
  await until(() => line.rows()[0]!.status === 'done', 'the turn ended')
  assert.deepEqual(await line.send('t1', 'next'), { ok: true })
  line.stop()
  await line.done
})

test('send: the hold ends when the daemon refuses, and after SEND_HOLD_MS when the status never moves', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1'))
  w.daemon.turnStartError = { code: -32600, message: 'no' }
  const line = start(w)
  await until(() => line.rows().length === 1, 'the snapshot')
  assert.equal((await line.send('t1', 'x')).ok, false)
  w.daemon.turnStartError = undefined
  assert.deepEqual(await line.send('t1', 'x'), { ok: true }, 'a refusal does not hold the thread')
  assert.deepEqual(await line.send('t1', 'y'), { ok: false, reason: 'busy' })
  w.clock.now += SEND_HOLD_MS
  assert.deepEqual(await line.send('t1', 'y'), { ok: true }, 'the hold expires')
  line.stop()
  await line.done
})

test('★ send: a turn/start queued behind a slow line is not written once the thread is no longer idle (high #4)', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1'))
  const line = start(w)
  await until(() => line.rows().length === 1, 'the snapshot')
  const g = gate()
  w.daemon.gate = g.promise
  const p = line.send('t1', 'late')
  // The person types in the TUI meanwhile
  w.daemon.notify('thread/status/changed', { threadId: 't1', status: { type: 'active', activeFlags: [] } })
  g.open()
  assert.deepEqual(await p, { ok: false, reason: 'busy', detail: 'cancelled' })
  assert.ok(!w.daemon.methods().includes('turn/start'), 'never written')
  line.stop()
  await line.done
})

test('★ a read in flight does not undo a newer status (high #2): the rename is taken, "working" stays', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1'))
  const line = start(w)
  await until(() => line.rows().length === 1, 'the snapshot')
  const g = gate()
  w.daemon.readGate = g.promise
  // The daemon serves the read while the thread is still idle…
  w.daemon.threads.set('t1', thread('t1', { name: 'renamed' }))
  w.daemon.notify('thread/name/updated', { threadId: 't1', threadName: 'renamed' })
  await until(() => w.daemon.received.some((m) => m.method === 'thread/read' && (m.params as { threadId: string }).threadId === 't1' && w.daemon.received.filter((x) => x.method === 'thread/read').length >= 2), 'the read was sent')
  // …and a turn starts before its answer arrives
  w.daemon.notify('thread/status/changed', { threadId: 't1', status: { type: 'active', activeFlags: [] } })
  g.open()
  await until(() => line.rows()[0]!.title === 'renamed', 'the new name')
  assert.equal(line.rows()[0]!.status, 'working')
  assert.deepEqual(await line.send('t1', 'x'), { ok: false, reason: 'busy' })
  line.stop()
  await line.done
})

test('a read in flight across thread/closed does not bring the row back (high #2)', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1'))
  const line = start(w)
  await until(() => line.rows().length === 1, 'the snapshot')
  const g = gate()
  w.daemon.readGate = g.promise
  const reads = (): number => w.daemon.received.filter((m) => m.method === 'thread/read').length
  const before = reads()
  w.daemon.notify('thread/name/updated', { threadId: 't1', threadName: 'x' })
  await until(() => reads() > before, 'the read was sent')
  w.daemon.notify('thread/closed', { threadId: 't1' })
  g.open()
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))
  assert.deepEqual(line.rows(), [])
  line.stop()
  await line.done
})

test('a thread/read answer about another thread is not taken', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1'))
  // A broken daemon that answers with a different thread
  w.daemon.threads.set('t1', thread('other'))
  const line = start(w)
  await until(() => line.health().state === 'connected', 'connected')
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))
  assert.deepEqual(line.rows(), [])
  line.stop()
  await line.done
})

test('★ a reconnect tells the notifier about threads that still wait (medium #6), but the first connection does not', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1', { status: WAITING }))
  w.daemon.threads.set('t2', thread('t2'))
  const changes: StatusChange[] = []
  const line = start(w, { changes })
  await until(() => line.rows().length === 2, 'the snapshot')
  assert.equal(changes.length, 0, 'the agent just started: nothing was missed')
  w.daemon.drop()
  await until(() => w.daemon.connections === 2 && line.rows().length === 2, 'the reconnect')
  await until(() => changes.length === 1, 'the standing state')
  const c = changes[0]!
  assert.equal(c.type === 'changed' && c.thread.id, 't1')
  assert.equal(c.type === 'changed' && c.to, 'waiting')
  line.stop()
  await line.done
})

test('★ two homes listing the same thread id give two rows that never share an id (high #1)', async () => {
  const w = world()
  w.daemon.threads.set('same', thread('same'))
  // A second home with its own daemon, listing a thread with the very same id
  const w2 = world()
  w2.daemon.threads.set('same', thread('same'))
  const a = start(w)
  const b = startCodexDaemonLine({
    home: { id: '/home/user/other/.codex', label: '.codex', socketPath: '/y/app-server-control.sock' },
    machine: 'pc-a',
    clientName: 'nyan-remote',
    clientVersion: '1.2.3',
    deps: w2.deps,
  })
  started.push(b)
  await until(() => a.rows().length === 1 && b.rows().length === 1, 'both snapshots')
  const ia = a.rows()[0]!.sessionId
  const ib = b.rows()[0]!.sessionId
  assert.notEqual(ia, ib)
  assert.equal(a.threadOf(ia), 'same')
  assert.equal(a.threadOf(ib), undefined, "the other home's row is not this line's")
  assert.equal(a.threadOf('same'), undefined, 'a bare thread id is no row id')
  assert.equal(a.threadOf(codexSessionPrefix('default')), undefined)
  // ⚠️ And a Claude session id can never take this form
  assert.ok(!/^[0-9a-fA-F-]{36}$/.test(ia))
  a.stop()
  b.stop()
  await Promise.all([a.done, b.done])
})

// ── second review (2026-11-15) ───────────────────────────────────────────────────────────────────────────────

test('★ send: a queued send that saw a whole turn pass (active → idle) is not written next to a newer send (high #1)', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1'))
  const line = start(w)
  await until(() => line.rows().length === 1, 'the snapshot')
  const g = gate()
  w.daemon.gate = g.promise
  const a = line.send('t1', 'A')
  // A turn starts and ends in the TUI while A waits behind the slow line
  w.daemon.notify('thread/status/changed', { threadId: 't1', status: { type: 'active', activeFlags: [] } })
  w.daemon.notify('thread/status/changed', { threadId: 't1', status: { type: 'idle' } })
  const b = line.send('t1', 'B')
  g.open()
  assert.deepEqual(await a, { ok: false, reason: 'busy', detail: 'cancelled' })
  assert.deepEqual(await b, { ok: true })
  const texts = w.daemon.received.filter((m) => m.method === 'turn/start').map((m) => (m.params as { input: Array<{ text: string }> }).input[0]!.text)
  assert.deepEqual(texts, ['B'])
  line.stop()
  await line.done
})

test('★ send: written but unanswered ⇒ the thread stays held until its status moves, not just until time passes', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1'))
  const line = startLine(w, {}, 20)
  started.push(line)
  await until(() => line.rows().length === 1, 'the snapshot')
  w.daemon.silentTurnStart = true
  assert.deepEqual(await line.send('t1', 'x'), { ok: false, reason: 'failed', detail: 'timeout-unknown' })
  w.clock.now += SEND_HOLD_MS * 10
  assert.deepEqual(await line.send('t1', 'y'), { ok: false, reason: 'busy' }, 'time alone does not prove it was not taken')
  // The daemon did take it: the turn runs and ends
  w.daemon.silentTurnStart = false
  w.daemon.notify('thread/status/changed', { threadId: 't1', status: { type: 'active', activeFlags: [] } })
  w.daemon.notify('thread/status/changed', { threadId: 't1', status: { type: 'idle' } })
  await until(() => line.rows()[0]!.status === 'done', 'the turn ended')
  assert.deepEqual(await line.send('t1', 'z'), { ok: true })
  assert.equal(w.daemon.received.filter((m) => m.method === 'turn/start').length, 2)
  line.stop()
  await line.done
})

// ── third review (2026-11-15) ────────────────────────────────────────────────────────────────────────────────

test('★ an unreadable status: no send until a fresh read says idle again (third review, medium #1)', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1'))
  const line = start(w)
  await until(() => line.rows().length === 1, 'the snapshot')
  const g = gate()
  w.daemon.readGate = g.promise
  const reads = (): number => w.daemon.received.filter((m) => m.method === 'thread/read').length
  const before = reads()
  // e.g. a Codex update that adds a status, or `active` without its flags
  w.daemon.notify('thread/status/changed', { threadId: 't1', status: { type: 'active' } })
  await until(() => reads() > before, 'a fresh read was asked for')
  assert.deepEqual(await line.send('t1', 'x'), { ok: false, reason: 'busy' })
  assert.ok(!w.daemon.methods().includes('turn/start'))
  g.open()
  // A refused send has no side effect, so it can be tried until the read has answered
  let res = await line.send('t1', 'x')
  for (let i = 0; i < 200 && !res.ok; i++) {
    await new Promise((r) => setImmediate(r))
    res = await line.send('t1', 'x')
  }
  assert.deepEqual(res, { ok: true }, 'the read gave sending back')
  assert.equal(w.daemon.received.filter((m) => m.method === 'turn/start').length, 1)
  line.stop()
  await line.done
})

// ── fourth review (2026-11-15) ───────────────────────────────────────────────────────────────────────────────

test('★ an unreadable status does not take an approval card away (fourth review, medium #1)', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1', { status: WAITING }))
  w.daemon.waitingRequests = [approvalRequest(1, 't1')]
  const withdrawn: number[] = []
  let n = 0
  const line = start(w, {
    offerApproval: (_a, _row, onWithdraw) =>
      new Promise((resolve) => {
        const mine = ++n
        onWithdraw(() => {
          withdrawn.push(mine)
          resolve(undefined)
        })
      }),
  })
  await until(() => n === 1, 'the card')
  // In one chunk: a status we cannot read, then the readable "waiting" again
  w.daemon.notify('thread/status/changed', { threadId: 't1', status: { type: 'active' } })
  w.daemon.notify('thread/status/changed', { threadId: 't1', status: WAITING })
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r))
  assert.deepEqual(withdrawn, [], 'the card is still there for the approval the daemon still waits on')
  line.stop()
  await line.done
})

test('★ a held send whose outcome was unknown ends when a read (after an unreadable status) finds the turn running (fourth review, medium #3)', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1'))
  const line = startLine(w, {}, 20)
  started.push(line)
  await until(() => line.rows().length === 1, 'the snapshot')
  w.daemon.silentTurnStart = true
  assert.deepEqual(await line.send('t1', 'x'), { ok: false, reason: 'failed', detail: 'timeout-unknown' })
  w.daemon.silentTurnStart = false
  // The daemon took it; we only learn so from the read that follows an unreadable notice
  w.daemon.threads.set('t1', thread('t1', { status: { type: 'active', activeFlags: [] } }))
  w.daemon.notify('thread/status/changed', { threadId: 't1', status: { type: 'mystery' } })
  await until(() => line.rows()[0]!.status === 'working', 'the read saw the turn')
  w.daemon.notify('thread/status/changed', { threadId: 't1', status: { type: 'idle' } })
  await until(() => line.rows()[0]!.status === 'done', 'the turn ended')
  assert.deepEqual(await line.send('t1', 'z'), { ok: true })
  line.stop()
  await line.done
})

// ── fifth review (2026-11-15) ────────────────────────────────────────────────────────────────────────────────

test('★ a read that finds a turn ended (after an unreadable notice) is a status change: the notifier hears it (fifth review, medium #2)', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1', { status: { type: 'active', activeFlags: [] } }))
  const changes: StatusChange[] = []
  const line = start(w, { changes })
  await until(() => line.rows().length === 1, 'the snapshot')
  // The turn ends, but the notice is one we cannot read; the read that follows is the only news
  w.daemon.threads.set('t1', thread('t1', { status: { type: 'idle' } }))
  w.daemon.notify('thread/status/changed', { threadId: 't1', status: { type: 'mystery' } })
  await until(() => changes.length === 1, 'the status change from the read')
  const c = changes[0]!
  assert.ok(c.type === 'changed')
  assert.deepEqual([c.from, c.to], ['working', 'done'])
  assert.equal(line.rows()[0]!.status, 'done')
  line.stop()
  await line.done
})

test('★ a read that says the thread was unloaded drops the row, its held send and its card (fifth review, medium #1)', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1', { status: WAITING }))
  w.daemon.waitingRequests = [approvalRequest(1, 't1')]
  const withdrawn: number[] = []
  let n = 0
  const line = startLine(w, {
    offerApproval: (_a, _row, onWithdraw) =>
      new Promise((resolve) => {
        const mine = ++n
        onWithdraw(() => {
          withdrawn.push(mine)
          resolve(undefined)
        })
      }),
  }, 20)
  started.push(line)
  await until(() => n === 1, 'the card')
  w.daemon.threads.set('t1', thread('t1', { status: { type: 'notLoaded' } }))
  w.daemon.notify('thread/status/changed', { threadId: 't1', status: { type: 'mystery' } })
  await until(() => line.rows().length === 0, 'the row is gone')
  await until(() => withdrawn.length === 1, 'the card is withdrawn (it is never answered for an unlisted thread)')
  assert.deepEqual(responsesOf(w), [])
  line.stop()
  await line.done
})

test('a held send whose outcome was unknown ends when a read says the thread was unloaded (fifth review, medium #1)', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1'))
  const line = startLine(w, {}, 20)
  started.push(line)
  await until(() => line.rows().length === 1, 'the snapshot')
  w.daemon.silentTurnStart = true
  assert.deepEqual(await line.send('t1', 'x'), { ok: false, reason: 'failed', detail: 'timeout-unknown' })
  w.daemon.silentTurnStart = false
  w.daemon.threads.set('t1', thread('t1', { status: { type: 'notLoaded' } }))
  w.daemon.notify('thread/status/changed', { threadId: 't1', status: { type: 'mystery' } })
  await until(() => line.rows().length === 0, 'unloaded')
  // It is loaded again, idle
  w.daemon.threads.set('t1', thread('t1'))
  w.daemon.notify('thread/started', { thread: thread('t1') })
  await until(() => line.rows().length === 1, 'loaded again')
  assert.deepEqual(await line.send('t1', 'y'), { ok: true })
  line.stop()
  await line.done
})

// ── sixth review (2026-11-15) ────────────────────────────────────────────────────────────────────────────────

test('★ unloaded ends the row like a close does, exactly once, so auto-approve does not outlive it (sixth review, high #1)', async () => {
  for (const via of ['notice', 'read'] as const) {
    const w = world()
    w.daemon.threads.set('t1', thread('t1'))
    const closed: string[] = []
    const line = start(w, { closed })
    await until(() => line.rows().length === 1, 'the snapshot')
    w.daemon.threads.set('t1', thread('t1', { status: { type: 'notLoaded' } }))
    if (via === 'notice') w.daemon.notify('thread/status/changed', { threadId: 't1', status: { type: 'notLoaded' } })
    else w.daemon.notify('thread/status/changed', { threadId: 't1', status: { type: 'mystery' } })
    await until(() => line.rows().length === 0, `unloaded (${via})`)
    assert.deepEqual(closed, [line.sessionIdOf('t1')], via)
    // The close that follows ends nothing more
    w.daemon.notify('thread/closed', { threadId: 't1' })
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
    assert.deepEqual(closed, [line.sessionIdOf('t1')], `${via}: once`)
    line.stop()
    await line.done
  }
})

// ── stop (turn/interrupt / 2026-11-15) ─────────────────────────────────────────────────────────────────────────

const WORKING = { type: 'active', activeFlags: [] }
/** The newest turn, as `thread/turns/list` with `itemsView: 'notLoaded'` gives it (measured: `items` is empty) */
function newest(id: string, status: string): Record<string, unknown> {
  return { data: [{ id, items: [], status, error: null }], nextCursor: null }
}

test('★ interrupt: a working row — the newest turn is read, then exactly that turn is stopped, nothing else sent', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1', { status: WORKING }))
  w.daemon.turnsPage = newest('turn-9', 'inProgress')
  const line = start(w)
  await until(() => line.rows().length === 1, 'the snapshot')
  const before = w.daemon.received.length
  assert.deepEqual(await line.interrupt('t1'), { ok: true })
  const sent = w.daemon.received.slice(before).map((m) => ({ method: m.method, params: m.params }))
  assert.deepEqual(sent, [
    { method: 'thread/turns/list', params: { threadId: 't1', limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' } },
    // ⚠️⚠️ Named by id: a turn that started meanwhile is never the one stopped
    { method: 'turn/interrupt', params: { threadId: 't1', turnId: 'turn-9' } },
  ])
  line.stop()
  await line.done
})

test('interrupt: idle, waiting on a person, an error status, and an id that is not a row are refused without asking', async () => {
  const w = world()
  w.daemon.threads.set('idle', thread('idle'))
  w.daemon.threads.set('waiting', thread('waiting', { status: WAITING }))
  w.daemon.threads.set('asking', thread('asking', { status: { type: 'active', activeFlags: ['waitingOnUserInput'] } }))
  w.daemon.threads.set('broken', thread('broken', { status: { type: 'systemError' } }))
  w.daemon.turnsPage = newest('turn-1', 'inProgress')
  const line = start(w)
  await until(() => line.rows().length === 4, 'the snapshot')
  const before = w.daemon.received.length
  assert.deepEqual(await line.interrupt('idle'), { ok: false, reason: 'idle' })
  assert.deepEqual(await line.interrupt('waiting'), { ok: false, reason: 'waiting' })
  assert.deepEqual(await line.interrupt('asking'), { ok: false, reason: 'waiting' })
  assert.deepEqual(await line.interrupt('broken'), { ok: false, reason: 'idle' })
  assert.deepEqual(await line.interrupt('some-claude-session'), { ok: false, reason: 'not-listed' })
  assert.equal(w.daemon.received.length, before, 'the daemon is not asked')
  line.stop()
  await line.done
  w.daemon.threads.set('busy', thread('busy', { status: WORKING }))
  assert.deepEqual(await line.interrupt('busy'), { ok: false, reason: 'not-listed' }, 'after the line ended')
})

test('interrupt: an unreadable status is not "working" (no stop until a read names it)', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1', { status: WORKING }))
  w.daemon.turnsPage = newest('turn-1', 'inProgress')
  const line = start(w)
  await until(() => line.rows().length === 1, 'the snapshot')
  // The read-back never answers: the status stays unnamed
  w.daemon.readGate = new Promise(() => {})
  w.daemon.notify('thread/status/changed', { threadId: 't1', status: { type: 'mystery' } })
  await until(() => line.rows().length === 1 && w.daemon.methods().filter((m) => m === 'thread/read').length >= 2, 'the read-back asked')
  assert.deepEqual(await line.interrupt('t1'), { ok: false, reason: 'idle' })
  assert.ok(!w.daemon.methods().includes('turn/interrupt'))
  line.stop()
})

test('interrupt: the newest turn already ended (or none is readable) ⇒ idle, and no turn/interrupt', async () => {
  for (const page of [newest('turn-1', 'completed'), newest('turn-1', 'interrupted'), { data: [], nextCursor: null }, { nope: 1 }]) {
    const w = world()
    w.daemon.threads.set('t1', thread('t1', { status: WORKING }))
    w.daemon.turnsPage = page
    const line = start(w)
    await until(() => line.rows().length === 1, 'the snapshot')
    assert.deepEqual(await line.interrupt('t1'), { ok: false, reason: 'idle' }, JSON.stringify(page))
    assert.ok(!w.daemon.methods().includes('turn/interrupt'))
    line.stop()
    await line.done
  }
})

test('interrupt: two presses at once send one turn/interrupt (the second is too soon), and a later press may send again', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1', { status: WORKING }))
  w.daemon.turnsPage = newest('turn-1', 'inProgress')
  const line = start(w)
  await until(() => line.rows().length === 1, 'the snapshot')
  const a = line.interrupt('t1')
  const b = line.interrupt('t1')
  assert.deepEqual(await b, { ok: false, reason: 'too-soon' })
  assert.deepEqual(await a, { ok: true })
  assert.equal(w.daemon.methods().filter((m) => m === 'turn/interrupt').length, 1)
  assert.deepEqual(await line.interrupt('t1'), { ok: true }, 'the reservation ends with the call')
  line.stop()
  await line.done
})

test('★ interrupt: queued behind a slow line, it is not written once the thread waits on a person or went idle', async () => {
  for (const [status, reason] of [[WAITING, 'waiting'], [{ type: 'idle' }, 'idle']] as const) {
    const w = world()
    w.daemon.threads.set('t1', thread('t1', { status: WORKING }))
    w.daemon.turnsPage = newest('turn-1', 'inProgress')
    const line = start(w)
    await until(() => line.rows().length === 1, 'the snapshot')
    const g = gate()
    w.daemon.gate = g.promise
    const p = line.interrupt('t1')
    w.daemon.notify('thread/status/changed', { threadId: 't1', status })
    g.open()
    assert.deepEqual(await p, { ok: false, reason, detail: 'cancelled' })
    assert.ok(!w.daemon.methods().includes('turn/interrupt'), 'never written')
    line.stop()
    await line.done
  }
})

test('interrupt: a refusal by the daemon (or an unreadable turn list) is "failed", by kind and code only', async () => {
  const w = world()
  w.daemon.threads.set('t1', thread('t1', { status: WORKING }))
  const line = start(w)
  await until(() => line.rows().length === 1, 'the snapshot')
  assert.deepEqual(await line.interrupt('t1'), { ok: false, reason: 'failed', detail: 'error -32601' })
  w.daemon.turnsPage = newest('turn-1', 'inProgress')
  w.daemon.interruptError = { code: -32600, message: 'turn "the secret" is gone' }
  assert.deepEqual(await line.interrupt('t1'), { ok: false, reason: 'failed', detail: 'error -32600' })
  line.stop()
  await line.done
})

test('★ interrupt: the pressed turn ends and the next one starts while the turn read waits — the new turn is not stopped (round 11, high #1)', async () => {
  for (const when of ['before the read', 'before the write'] as const) {
    const w = world()
    w.daemon.threads.set('t1', thread('t1', { status: WORKING }))
    w.daemon.turnsPage = newest('turn-A', 'inProgress')
    const line = start(w)
    await until(() => line.rows().length === 1, 'the snapshot')
    const g = gate()
    if (when === 'before the read') w.daemon.gate = g.promise
    // 'before the write': the read goes through and names turn A; the interrupt's write is held
    else w.daemon.onTurnsList = () => (w.daemon.gate = g.promise)
    const p = line.interrupt('t1')
    await until(() => w.daemon.methods().includes('thread/turns/list') || when === 'before the read', 'the turn read')
    // Turn A ends; the PC starts turn B (still "working", but a different status run)
    w.daemon.notify('thread/status/changed', { threadId: 't1', status: { type: 'idle' } })
    w.daemon.notify('thread/status/changed', { threadId: 't1', status: WORKING })
    w.daemon.turnsPage = newest('turn-B', 'inProgress')
    await until(() => line.rows()[0]!.status === 'working', 'turn B runs')
    g.open()
    const res = await p
    assert.equal(res.ok, false, when)
    assert.ok(!w.daemon.methods().includes('turn/interrupt'), `never written (${when})`)
    line.stop()
    await line.done
  }
})
