import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CodexApprovals, JOIN_RETRY_MS, JOIN_TRIES, parseCommandApproval, type CodexApproval, type PhoneDecision } from './approvals.ts'
import type { RpcId, RpcResult, ServerRequest } from './rpc.ts'

// ★ Verbatim from codex-cli 0.169.0 (docs/codex-lab/history-samples.json). ⚠️ Note what is on offer: no `decline`.
const REAL: ServerRequest = JSON.parse(
  String.raw`{"method": "item/commandExecution/requestApproval", "id": 0, "params": {"kind": "command", "threadId": "01a1d950-d528-7173-9bf5-c8e05c8b43cc", "turnId": "01a1d950-d532-7830-987d-f8bf69e4c8f3", "itemId": "call_eaf27701f8db479f82372413b8398752", "startedAtMs": 1794647315821, "environmentId": "local", "reason": "Synthetic history sample command", "command": "/bin/bash -lc \"printf 'SYNTHETIC_COMMAND_OUTPUT\\\\n'\"", "cwd": "/tmp/nyan-codex-followup/history-066bbda5", "commandActions": [{"type": "unknown", "command": "printf 'SYNTHETIC_COMMAND_OUTPUT\\n'"}], "proposedExecpolicyAmendment": ["printf", "SYNTHETIC_COMMAND_OUTPUT\\n"], "availableDecisions": ["accept", {"acceptWithExecpolicyAmendment": {"execpolicy_amendment": ["printf", "SYNTHETIC_COMMAND_OUTPUT\\n"]}}, "cancel"]}}`,
) as ServerRequest
const T = '01a1d950-d528-7173-9bf5-c8e05c8b43cc'

function req(over: Record<string, unknown> = {}, id: RpcId = 0, method = REAL.method): ServerRequest {
  return { id, method, params: { ...(REAL.params as Record<string, unknown>), ...over } }
}

test('parse: the real request becomes an approval; its "no" is cancel because decline is not offered', () => {
  assert.deepEqual(parseCommandApproval(REAL), {
    requestId: 0,
    threadId: T,
    turnId: '01a1d950-d532-7830-987d-f8bf69e4c8f3',
    itemId: 'call_eaf27701f8db479f82372413b8398752',
    command: `/bin/bash -lc "printf 'SYNTHETIC_COMMAND_OUTPUT\\\\n'"`,
    cwd: '/tmp/nyan-codex-followup/history-066bbda5',
    no: 'cancel',
  })
})

test('parse: "no" is decline when offered, and when the list is absent', () => {
  assert.equal(parseCommandApproval(req({ availableDecisions: ['accept', 'decline', 'cancel'] }))?.no, 'decline')
  assert.equal(parseCommandApproval(req({ availableDecisions: undefined }))?.no, 'decline')
  assert.equal(parseCommandApproval(req({ availableDecisions: null }))?.no, 'decline')
})

test('parse: anything that is not a plain command with a yes and a no on offer is not ours', () => {
  const not = (r: ServerRequest, why: string): void => assert.equal(parseCommandApproval(r), undefined, why)
  not(req({}, 0, 'item/fileChange/requestApproval'), 'another method')
  not(req({}, 0, 'item/tool/requestUserInput'), 'a question')
  not({ id: 0, method: REAL.method, params: null }, 'no params')
  not(req({ kind: 'humanCommand' }), 'needs a capability we do not declare')
  not(req({ kind: 'writeStdin' }), 'not a command')
  not(req({ kind: undefined }), 'no kind')
  for (const k of ['threadId', 'turnId', 'itemId', 'command']) {
    not(req({ [k]: undefined }), `missing ${k}`)
    not(req({ [k]: '' }), `empty ${k}`)
    not(req({ [k]: 5 }), `non-string ${k}`)
  }
  not(req({ networkApprovalContext: { host: 'example.com', protocol: 'https' } }), 'a network rule')
  not(req({ additionalPermissions: { fileSystem: {} } }), 'extra permissions')
  not(req({ availableDecisions: ['acceptForSession', 'cancel'] }), 'no plain yes')
  not(req({ availableDecisions: ['accept'] }), 'no way to say no')
  not(req({ availableDecisions: ['accept', { decline: {} }] }), 'a no that is not the plain one')
  not(req({ availableDecisions: 'accept,cancel' }), 'not a list')
})

interface Offered {
  approval: CodexApproval
  decide: (d: PhoneDecision | undefined) => void
  withdrawn: boolean
}

function setup(waiting: string[] = [T]) {
  const calls: Array<{ method: string; params: unknown }> = []
  const responses: Array<{ id: RpcId; result: unknown }> = []
  const offered: Offered[] = []
  const state = {
    waiting: new Set(waiting),
    resumeOk: true,
    gate: Promise.resolve() as Promise<void>,
    immediate: undefined as PhoneDecision | undefined,
    /** A retry's wait: never over unless a test says so (so the other tests see exactly the joins they make) */
    sleep: (() => new Promise<void>(() => undefined)) as (ms: number) => Promise<void>,
    sleeps: [] as number[],
  }
  const a = new CodexApprovals({
    // ★ Like the real line: writes wait their turn (`gate`), and `guard` is asked only then
    call: async (method, params, guard): Promise<RpcResult> => {
      await state.gate
      if (guard && !guard()) return { ok: false, failure: { type: 'cancelled' } }
      calls.push({ method, params })
      if (method === 'thread/resume' && !state.resumeOk) return { ok: false, failure: { type: 'timeout', written: true } }
      return { ok: true, result: {} }
    },
    respond: async (id, result, guard) => {
      await state.gate
      if (!guard()) return false
      responses.push({ id, result })
      return true
    },
    isWaiting: (id) => state.waiting.has(id),
    sleep: (ms) => {
      state.sleeps.push(ms)
      return state.sleep(ms)
    },
    offer: (approval, onWithdraw) =>
      new Promise<PhoneDecision | undefined>((resolve) => {
        // ★ Auto-approve: decided at once, before any card exists
        if (state.immediate) return resolve(state.immediate)
        const o: Offered = { approval, decide: resolve, withdrawn: false }
        onWithdraw(() => {
          o.withdrawn = true
          resolve(undefined)
        })
        offered.push(o)
      }),
  })
  return { a, calls, responses, offered, state }
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

test('joins a waiting thread once, with the thread id and excludeTurns only', async () => {
  const s = setup()
  s.a.sync(T)
  s.a.sync(T)
  await tick()
  assert.deepEqual(s.calls, [{ method: 'thread/resume', params: { threadId: T, excludeTurns: true } }])
})

test('never joins a thread that is not waiting on an approval', async () => {
  const s = setup([])
  s.a.sync(T)
  await tick()
  assert.deepEqual(s.calls, [])
})

test('yes is sent as accept, to the id as it came', async () => {
  const s = setup()
  assert.equal(s.a.onServerRequest(REAL), true)
  assert.equal(s.a.cards, 1)
  s.offered[0]!.decide('yes')
  await tick()
  assert.deepEqual(s.responses, [{ id: 0, result: { decision: 'accept' } }])
  assert.equal(s.a.cards, 0)
})

test('no is sent as what the daemon offered: cancel here, decline when that is on offer', async () => {
  const s = setup()
  s.a.onServerRequest(REAL)
  s.a.onServerRequest(req({ availableDecisions: ['accept', 'decline'] }, 'b'))
  s.offered[0]!.decide('no')
  s.offered[1]!.decide('no')
  await tick()
  assert.deepEqual(s.responses, [
    { id: 0, result: { decision: 'cancel' } },
    { id: 'b', result: { decision: 'decline' } },
  ])
})

test('a request that is not ours, or for a thread that is not waiting, is left alone', async () => {
  const s = setup()
  assert.equal(s.a.onServerRequest(req({}, 1, 'item/fileChange/requestApproval')), false)
  assert.equal(s.a.onServerRequest(req({ threadId: 'someone-else' }, 2)), false)
  await tick()
  assert.equal(s.offered.length, 0)
  assert.deepEqual(s.responses, [])
})

test('answered on the PC (serverRequest/resolved): the card goes and nothing is sent', async () => {
  const s = setup()
  s.a.onServerRequest(REAL)
  // ⚠️ Another thread, another id, or junk must not take the card away
  s.a.onResolved({ threadId: 'other', requestId: 0 })
  s.a.onResolved({ threadId: T, requestId: '0' })
  s.a.onResolved({ threadId: T })
  s.a.onResolved(null)
  assert.equal(s.offered[0]!.withdrawn, false)
  s.a.onResolved({ threadId: T, requestId: 0 })
  await tick()
  assert.equal(s.offered[0]!.withdrawn, true)
  assert.deepEqual(s.responses, [])
  assert.equal(s.a.cards, 0)
})

test('the thread stops waiting: cards go without an answer, then we leave the thread', async () => {
  const s = setup()
  s.a.sync(T)
  await tick()
  s.a.onServerRequest(REAL)
  s.state.waiting.delete(T)
  s.a.sync(T)
  await tick()
  assert.equal(s.offered[0]!.withdrawn, true)
  assert.deepEqual(s.responses, [])
  assert.deepEqual(s.calls.map((c) => c.method), ['thread/resume', 'thread/unsubscribe'])
  assert.deepEqual(s.calls[1]!.params, { threadId: T })
})

test('stays joined while the thread still waits (a second approval needs no second join)', async () => {
  const s = setup()
  s.a.sync(T)
  await tick()
  s.a.onServerRequest(REAL)
  s.offered[0]!.decide('yes')
  await tick()
  assert.deepEqual(s.calls.map((c) => c.method), ['thread/resume'])
})

test('a failed join is not remembered as joined: the next change tries again', async () => {
  const s = setup()
  s.state.resumeOk = false
  s.a.sync(T)
  await tick()
  s.state.resumeOk = true
  s.a.sync(T)
  await tick()
  assert.deepEqual(s.calls.map((c) => c.method), ['thread/resume', 'thread/resume'])
})

test('the same request replayed replaces the card: one answer goes out, from the new card', async () => {
  const s = setup()
  s.a.onServerRequest(REAL)
  s.a.onServerRequest(REAL)
  assert.equal(s.offered[0]!.withdrawn, true)
  assert.equal(s.a.cards, 1)
  s.offered[0]!.decide('yes') // too late: already withdrawn
  s.offered[1]!.decide('no')
  await tick()
  assert.deepEqual(s.responses, [{ id: 0, result: { decision: 'cancel' } }])
})

test('request ids 1 and "1" are different cards', async () => {
  const s = setup()
  s.a.onServerRequest(req({}, 1))
  s.a.onServerRequest(req({}, '1'))
  assert.equal(s.a.cards, 2)
  assert.equal(s.offered[0]!.withdrawn, false)
})

test('the line ends: every card is withdrawn, nothing is sent, and nothing works afterwards', async () => {
  const s = setup()
  s.a.sync(T)
  await tick()
  s.a.onServerRequest(REAL)
  const before = s.calls.length
  s.a.dispose()
  await tick()
  assert.equal(s.offered[0]!.withdrawn, true)
  assert.deepEqual(s.responses, [])
  assert.equal(s.a.onServerRequest(req({}, 9)), false)
  s.a.sync(T)
  await tick()
  assert.equal(s.calls.length, before, 'no call after the line ended')
})

test('a decision that arrives after the line ended is not sent', async () => {
  const s = setup()
  let decide: (d: PhoneDecision) => void = () => undefined
  const a = new CodexApprovals({
    call: async () => ({ ok: true, result: {} }),
    respond: async (id, result) => {
      s.responses.push({ id, result })
      return true
    },
    isWaiting: () => true,
    sleep: () => new Promise<void>(() => undefined),
    // ⚠️ A store that ignores the withdrawal (must still not leak an answer onto a dead line)
    offer: () => new Promise<PhoneDecision>((r) => (decide = r)),
  })
  a.onServerRequest(REAL)
  a.dispose()
  decide('yes')
  await tick()
  assert.deepEqual(s.responses, [])
})

// ── codex review (2026-11-15), medium #5 ──────────────────────────────────────────────────────────────────────

test('★ an answer decided at once (auto-approve) is not sent when the thread stops waiting before it goes out', async () => {
  const s = setup()
  s.state.immediate = 'yes'
  s.a.sync(T)
  await tick()
  assert.equal(s.a.onServerRequest({ id: 7, method: REAL.method, params: REAL.params }), true)
  // Same tick as the decision: the thread is closed (or stops waiting) before the answer's continuation runs
  s.state.waiting.delete(T)
  s.a.sync(T)
  await tick()
  assert.deepEqual(s.responses, [])
  assert.equal(s.a.cards, 0)
})

test('★ an answer waiting behind a slow line is not written once the request was resolved elsewhere', async () => {
  const s = setup()
  s.a.sync(T)
  await tick()
  s.a.onServerRequest({ id: 7, method: REAL.method, params: REAL.params })
  let open!: () => void
  s.state.gate = new Promise((r) => (open = r))
  s.offered[0]!.decide('yes')
  await tick()
  // The TUI answered first; our accept is still queued
  s.a.onResolved({ threadId: T, requestId: 7 })
  open()
  await tick()
  assert.deepEqual(s.responses, [])
})

test('a join queued behind a slow line is not written once the thread stopped waiting', async () => {
  const s = setup()
  let open!: () => void
  s.state.gate = new Promise((r) => (open = r))
  s.a.sync(T)
  await tick()
  s.state.waiting.delete(T)
  open()
  await tick()
  assert.deepEqual(s.calls, [])
})

test('★ a join that fails is tried again while the thread still waits, a bounded number of times (ninth review, medium)', async () => {
  const s = setup()
  // ★ A real turn of the event loop (an endless retry then fails the count instead of hanging the run)
  s.state.sleep = () => new Promise<void>((r) => setImmediate(r))
  s.state.resumeOk = false
  s.a.sync(T)
  for (let i = 0; i < 10; i++) await tick()
  assert.equal(s.calls.filter((c) => c.method === 'thread/resume').length, JOIN_TRIES, 'tried again, but not forever')
  assert.deepEqual(s.state.sleeps, Array.from({ length: JOIN_TRIES - 1 }, (_, i) => JOIN_RETRY_MS * (i + 1)))
})

test('a retry joins once the line is free, and none is made for a thread that stopped waiting', async () => {
  const s = setup()
  let wake!: () => void
  s.state.sleep = () => new Promise<void>((r) => (wake = r))
  s.state.resumeOk = false
  s.a.sync(T)
  await tick()
  s.state.resumeOk = true
  wake()
  await tick()
  assert.deepEqual(s.calls.map((c) => c.method), ['thread/resume', 'thread/resume'])
  // Joined now: a further sync does not join again
  s.a.sync(T)
  await tick()
  assert.equal(s.calls.length, 2)

  const u = setup()
  u.state.sleep = () => new Promise<void>((r) => (wake = r))
  u.state.resumeOk = false
  u.a.sync(T)
  await tick()
  u.state.waiting.delete(T)
  wake()
  await tick()
  assert.deepEqual(u.calls.map((c) => c.method), ['thread/resume'], 'no retry once it stopped waiting')
})
