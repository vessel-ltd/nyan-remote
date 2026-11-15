import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRpc, type Rpc, type ServerRequest } from './rpc.ts'

interface Harness {
  rpc: Rpc
  sent: unknown[]
  notes: Array<[string, unknown]>
  requests: ServerRequest[]
  failSend: { on: boolean }
}

function harness(timeoutMs = 1000): Harness {
  const sent: unknown[] = []
  const notes: Array<[string, unknown]> = []
  const requests: ServerRequest[] = []
  const failSend = { on: false }
  const rpc = createRpc({
    send: async (t, guard) => {
      if (failSend.on) throw new Error('down')
      // ★ Like the real line: asked right before writing
      if (!guard()) throw new Error('cancelled')
      sent.push(JSON.parse(t))
    },
    onNotification: (m, p) => notes.push([m, p]),
    onServerRequest: (r) => requests.push(r),
    timeoutMs,
  })
  return { rpc, sent, notes, requests, failSend }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

test('call: sends {id, method, params} without a jsonrpc field, and resolves with the matching result', async () => {
  const h = harness()
  const a = h.rpc.call('thread/loaded/list', { limit: 5 })
  const b = h.rpc.call('initialize')
  await tick()
  assert.deepEqual(h.sent, [
    { id: 1, method: 'thread/loaded/list', params: { limit: 5 } },
    { id: 2, method: 'initialize' },
  ])
  // Answers in the other order
  h.rpc.receive(JSON.stringify({ id: 2, result: { ok: 'b' } }))
  h.rpc.receive(JSON.stringify({ id: 1, result: { ok: 'a' } }))
  assert.deepEqual(await a, { ok: true, result: { ok: 'a' } })
  assert.deepEqual(await b, { ok: true, result: { ok: 'b' } })
})

test('call: an error response keeps code and message', async () => {
  const h = harness()
  const p = h.rpc.call('thread/turns/list')
  await tick()
  h.rpc.receive(JSON.stringify({ id: 1, error: { code: -32601, message: 'list_turns is not supported yet' } }))
  assert.deepEqual(await p, {
    ok: false,
    failure: { type: 'error', error: { code: -32601, message: 'list_turns is not supported yet' } },
  })
})

test('call: a malformed error object still ends the call as an error (no throw, no invented text)', async () => {
  const h = harness()
  const p = h.rpc.call('x')
  await tick()
  h.rpc.receive(JSON.stringify({ id: 1, error: 'boom' }))
  assert.deepEqual(await p, { ok: false, failure: { type: 'error', error: { code: 0, message: '' } } })
})

test('call: times out, and a late answer is dropped', async () => {
  const h = harness(20)
  const p = h.rpc.call('slow')
  assert.deepEqual(await p, { ok: false, failure: { type: 'timeout', written: true } })
  h.rpc.receive(JSON.stringify({ id: 1, result: 1 }))
  assert.equal(h.rpc.dropped, 1)
})

test('call: a failed send ends the call as send-failed', async () => {
  const h = harness()
  h.failSend.on = true
  assert.deepEqual(await h.rpc.call('x'), { ok: false, failure: { type: 'send-failed' } })
})

test('fail: ends every waiting call and every later call with the reason', async () => {
  const h = harness()
  const a = h.rpc.call('a')
  const b = h.rpc.call('b')
  await tick()
  h.rpc.fail('eof')
  h.rpc.fail('second reason is ignored')
  const closed = { ok: false, failure: { type: 'closed', reason: 'eof' } }
  assert.deepEqual(await a, closed)
  assert.deepEqual(await b, closed)
  assert.deepEqual(await h.rpc.call('c'), closed)
  assert.equal(await h.rpc.notify('n'), false)
  assert.equal(await h.rpc.respond(7, {}), false)
  assert.equal(h.sent.length, 2, 'nothing is sent after the line is gone')
})

test('receive: notifications and server requests are told apart; the request id keeps its type', () => {
  const h = harness()
  h.rpc.receive(JSON.stringify({ method: 'thread/status/changed', params: { threadId: 't' } }))
  h.rpc.receive(JSON.stringify({ id: 0, method: 'item/commandExecution/requestApproval', params: { a: 1 } }))
  h.rpc.receive(JSON.stringify({ id: '0', method: 'item/tool/requestUserInput' }))
  assert.deepEqual(h.notes, [['thread/status/changed', { threadId: 't' }]])
  assert.deepEqual(h.requests, [
    { id: 0, method: 'item/commandExecution/requestApproval', params: { a: 1 } },
    { id: '0', method: 'item/tool/requestUserInput', params: undefined },
  ])
  assert.equal(h.sent.length, 0, 'a server request is never answered by this layer')
})

test('respond: echoes the id as received', async () => {
  const h = harness()
  assert.equal(await h.rpc.respond('abc', { decision: 'decline' }), true)
  assert.equal(await h.rpc.respond(0, { decision: 'accept' }), true)
  assert.deepEqual(h.sent, [
    { id: 'abc', result: { decision: 'decline' } },
    { id: 0, result: { decision: 'accept' } },
  ])
})

test('receive: hostile shapes are counted and dropped, never thrown', async () => {
  const h = harness()
  const p = h.rpc.call('x')
  await tick()
  const bad = [
    'not json',
    '[]',
    'null',
    '"str"',
    '{}',
    JSON.stringify({ id: 1 }), // neither result nor error
    JSON.stringify({ id: '1', result: 'string id is not our numeric id' }),
    JSON.stringify({ id: 99, result: 'never issued' }),
    JSON.stringify({ id: { x: 1 }, method: 'bad-id-type' }),
    JSON.stringify({ id: 1.5, method: 'bad-id-number' }),
    JSON.stringify({ method: 42 }),
  ]
  for (const b of bad) assert.doesNotThrow(() => h.rpc.receive(b), b)
  assert.equal(h.rpc.dropped, bad.length)
  assert.deepEqual(h.notes, [])
  assert.deepEqual(h.requests, [])
  // The real answer still lands
  h.rpc.receive(JSON.stringify({ id: 1, result: 'real' }))
  assert.deepEqual(await p, { ok: true, result: 'real' })
})

test('receive: an answer that arrives before send() resolves is not lost', async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  // ★ Like the real line: the guard is asked, the bytes go out, then the send waits for drain
  const rpc = createRpc({
    send: async (_t, guard) => {
      if (!guard()) throw new Error('cancelled')
      await gate
    },
    onNotification: () => undefined,
    onServerRequest: () => undefined,
  })
  const p = rpc.call('x')
  rpc.receive(JSON.stringify({ id: 1, result: 'early' }))
  release()
  assert.deepEqual(await p, { ok: true, result: 'early' })
})

// ── codex review (2026-11-15), high #4 ────────────────────────────────────────────────────────────────────────

/** A line whose writes wait for `open()` (backpressure), asking the guard only when their turn comes */
function slowLine(timeoutMs: number) {
  const written: unknown[] = []
  let open!: () => void
  const gate = new Promise<void>((r) => (open = r))
  const rpc = createRpc({
    send: async (t, guard) => {
      await gate
      if (!guard()) throw new Error('cancelled')
      written.push(JSON.parse(t))
    },
    onNotification: () => undefined,
    onServerRequest: () => undefined,
    timeoutMs,
  })
  return { rpc, written, open }
}

test('★ call: a request that times out while queued is never written, and says so', async () => {
  const l = slowLine(20)
  const res = await l.rpc.call('turn/start', { threadId: 't' })
  assert.deepEqual(res, { ok: false, failure: { type: 'timeout', written: false } })
  l.open()
  await tick()
  assert.deepEqual(l.written, [], 'the "failed" request must not reach the daemon later')
})

test('call: the caller\'s guard is asked right before writing; "no" ends the call as cancelled, unwritten', async () => {
  const l = slowLine(1000)
  let ok = true
  const p = l.rpc.call('turn/start', {}, { guard: () => ok })
  ok = false
  l.open()
  assert.deepEqual(await p, { ok: false, failure: { type: 'cancelled' } })
  assert.deepEqual(l.written, [])
})

test('respond: the guard stops an answer that waited behind a slow line', async () => {
  const l = slowLine(1000)
  let ok = true
  const p = l.rpc.respond(5, { decision: 'accept' }, () => ok)
  ok = false
  l.open()
  assert.equal(await p, false)
  assert.deepEqual(l.written, [])
})
