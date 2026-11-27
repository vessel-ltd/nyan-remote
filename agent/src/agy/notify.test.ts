import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NotifyFields, SessionSummary, SessionStatus } from '../../../shared/types.ts'
import { AgyNotifier, QUIET_UNSURE_MAX } from './notify.ts'

const A = '062a8f25-9451-42f3-ae93-34a208e99365'

function rig(opts: { quiet?: (sessionId: string, card: string) => boolean | undefined | Promise<boolean | undefined>; settled?: () => boolean } = {}) {
  let status: SessionStatus | undefined = 'idle'
  let wrote = '2026-11-20T00:00:10Z'
  let records: Record<string, unknown>[] = []
  let ok = 1
  let gate: Promise<void> | undefined
  let clock = 0
  const sent: NotifyFields[] = []
  const n = new AgyNotifier({
    rows: async () =>
      status
        ? [{ machine: 'pc-a', account: 'agy', tool: 'agy', sessionId: `agy-${A}`, cwd: '/home/user/p', project: 'p', title: 'Fix it', titleSource: 'ai', status, live: true, lastActivity: wrote } as SessionSummary]
        : [],
    home: '/home/user',
    send: async (_row, fields) => {
      if (ok < 0) throw new Error('vapid.json unreadable')
      if (ok > 0) sent.push(fields)
      if (gate) await gate
      return ok
    },
    tail: () => records,
    now: () => clock,
    ...(opts.quiet ? { quiet: opts.quiet } : {}),
    ...(opts.settled ? { childrenSettled: opts.settled } : {}),
  })
  return {
    n,
    sent,
    set(s: SessionStatus | undefined, r?: Record<string, unknown>[], at?: string) {
      status = s
      if (r) records = r
      if (at) wrote = at
    },
    fail(v: boolean | 'throw') {
      ok = v === 'throw' ? -1 : v ? 0 : 1
    },
    hold(p: Promise<void> | undefined) {
      gate = p
    },
    tick(ms: number) {
      clock += ms
    },
  }
}

const user = (step: number) => ({ step_index: step, type: 'USER_INPUT', created_at: '2026-11-20T00:00:00Z' })
const answered = (step: number) => [user(step), { step_index: step + 1, type: 'PLANNER_RESPONSE', content: 'Done.' }]
const asking = (step: number) => [user(step), { step_index: step + 1, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command', args: { CommandLine: 'ls' } }] }]

test('★★ a card rings "needs you", a finished turn rings "done", in the list’s words; the first look is the baseline', async () => {
  const r = rig()
  r.set('working', asking(0))
  await r.n.look()
  assert.equal(r.sent.length, 0, 'the state at start is not news (a waiting card is: below)')
  r.set('working')
  await r.n.look()
  r.set('waiting')
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['要対応'])
  assert.equal(r.sent[0]!.sessionId, `agy-${A}`)
  r.set('working')
  await r.n.look()
  r.set('done', answered(0))
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['要対応', '完了'])
  r.set('error')
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['要対応', '完了', '⚠ 異常終了'])
})

test('★ a turn stopped at a plan limit rings "制限中" once, like an error (2026-11-26)', async () => {
  const r = rig()
  await r.n.look()
  r.set('working', [user(0)])
  await r.n.look()
  r.set('rate-limited', [user(0), { step_index: 1, type: 'ERROR_MESSAGE', error: 'You have exhausted your quota on this model.' }])
  await r.n.look()
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['制限中'])
})

test('★ a row first seen at a limit rings only when its error is newer than the last look (a reopened old one stays quiet)', async () => {
  const look = async (r: ReturnType<typeof rig>) => {
    r.tick(5000)
    await r.n.look()
  }
  const limitErr = (at: string) => [user(0), { step_index: 1, type: 'ERROR_MESSAGE', created_at: at, error: 'You have exhausted your quota on this model.' }]
  // Reopened: the error is days old
  const old = rig()
  old.tick(Date.parse('2026-11-25T00:00:00Z'))
  old.set(undefined)
  await look(old)
  await look(old)
  // (agy writes a fresh status file on reopening)
  old.set('rate-limited', limitErr('2026-11-20T00:00:01Z'), '2026-11-25T00:00:12Z')
  await look(old)
  await look(old)
  assert.deepEqual(old.sent, [])
  // New: a first turn that stopped at the limit between two looks
  const fresh = rig()
  fresh.tick(Date.parse('2026-11-25T00:00:00Z'))
  fresh.set(undefined)
  await look(fresh)
  await look(fresh)
  fresh.set('rate-limited', limitErr('2026-11-25T00:00:12Z'))
  await look(fresh)
  await look(fresh)
  assert.deepEqual(fresh.sent.map((f) => f.label), ['制限中'])
  // A recent turn whose error carries no time rings too
  const recentTurn = rig()
  recentTurn.tick(Date.parse('2026-11-25T00:00:00Z'))
  recentTurn.set(undefined)
  await look(recentTurn)
  await look(recentTurn)
  recentTurn.set('rate-limited', [{ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-25T00:00:12Z' }, { step_index: 1, type: 'ERROR_MESSAGE', error: 'x' }])
  await look(recentTurn)
  assert.deepEqual(recentTurn.sent.map((f) => f.label), ['制限中'])
})

test('★ a reopened conversation that shows idle first, then its old limit, stays quiet; a new limit from idle rings', async () => {
  const look = async (r: ReturnType<typeof rig>) => {
    r.tick(5000)
    await r.n.look()
  }
  const limitErr = (at: string) => [user(0), { step_index: 1, type: 'ERROR_MESSAGE', created_at: at, error: 'You have exhausted your quota on this model.' }]
  for (const [errAt, want] of [['2026-11-20T00:00:01Z', []], ['2026-11-25T00:00:12Z', ['制限中']]] as const) {
    const r = rig()
    r.tick(Date.parse('2026-11-25T00:00:00Z'))
    r.set('idle', [user(0)])
    await look(r)
    await look(r)
    r.set('rate-limited', limitErr(errAt), '2026-11-25T00:00:12Z')
    await look(r)
    await look(r)
    assert.deepEqual(r.sent.map((f) => f.label), [...want], errAt)
  }
  // Whole seconds and the relay's delay: the previous look ran at …:01.200, the error was written at …:00.900 and
  // recorded as …:00 (codex)
  const edge = rig()
  edge.tick(Date.parse('2026-11-25T00:00:00Z') - 8800)
  edge.set(undefined)
  await look(edge)
  await look(edge)
  edge.set('rate-limited', limitErr('2026-11-25T00:00:00Z'), '2026-11-25T00:00:01Z')
  await look(edge)
  assert.deepEqual(edge.sent.map((f) => f.label), ['制限中'], 'the allowance')
  // The window's edges: an error 2.5 s before the previous look rings; 3.5 s before stays quiet
  for (const [before, want] of [[2500, ['制限中']], [3500, []]] as const) {
    const w = rig()
    w.tick(Date.parse('2026-11-25T00:00:00Z') + before - 10_000)
    w.set(undefined)
    await look(w)
    await look(w)
    w.set('rate-limited', limitErr('2026-11-25T00:00:00Z'), '2026-11-25T00:00:05Z')
    await look(w)
    assert.deepEqual(w.sent.map((f) => f.label), [...want], `${before} ms before`)
  }
  // Undated records with a fresh status file (reopened): quiet
  const r = rig()
  r.tick(Date.parse('2026-11-25T00:00:00Z'))
  r.set(undefined)
  await look(r)
  await look(r)
  r.set('rate-limited', [{ step_index: 0, type: 'USER_INPUT' }, { step_index: 1, type: 'ERROR_MESSAGE', error: 'Usage limit reached' }], '2026-11-25T00:00:12Z')
  await look(r)
  assert.deepEqual(r.sent, [])
})

test('★ a new prompt landing before agy rewrites its old error state: no "failed" after "rate-limited" (agy review)', async () => {
  const r = rig()
  r.tick(Date.parse('2026-11-25T00:00:00Z'))
  await r.n.look()
  r.set('working', [user(0)])
  r.tick(5000)
  await r.n.look()
  r.set('rate-limited', [user(0), { step_index: 1, type: 'ERROR_MESSAGE', created_at: '2026-11-25T00:00:08Z', error: 'Usage limit reached' }], '2026-11-25T00:00:08Z')
  r.tick(5000)
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['制限中'])
  // The person types again: the prompt is in the transcript, agy's state file is still the old `error`
  r.set('error', [user(0), { step_index: 1, type: 'ERROR_MESSAGE', error: 'Usage limit reached' }, { step_index: 2, type: 'USER_INPUT', created_at: '2026-11-25T00:01:00Z' }])
  r.tick(5000)
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['制限中'])
})

test('two turns that each stop at the limit ring once each; a new turn after a limit that fails otherwise rings "failed"', async () => {
  const r = rig()
  r.tick(Date.parse('2026-11-25T00:00:00Z'))
  await r.n.look()
  const stop = (step: number, at: string, words: string) => [{ step_index: step, type: 'USER_INPUT', created_at: at }, { step_index: step + 1, type: 'ERROR_MESSAGE', created_at: at, error: words }]
  for (const [step, at] of [[0, '2026-11-25T00:00:03Z'], [10, '2026-11-25T00:00:13Z']] as const) {
    r.set('working', [{ step_index: step, type: 'USER_INPUT', created_at: at }], at)
    r.tick(5000)
    await r.n.look()
    r.set('rate-limited', stop(step, at, 'Usage limit reached'), at)
    r.tick(5000)
    await r.n.look()
  }
  assert.deepEqual(r.sent.map((f) => f.label), ['制限中', '制限中'])
  // A third stop seen right after the second, no working look between (the state file rewritten after the prompt)
  r.set('rate-limited', stop(30, '2026-11-25T00:00:23Z', 'Usage limit reached'), '2026-11-25T00:00:25Z')
  r.tick(5000)
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['制限中', '制限中', '制限中'])
  // A new turn whose state file was written after its prompt, failing for another reason (no working look between)
  r.set('error', stop(20, '2026-11-25T00:00:30Z', 'No capacity available for model x on the server'), '2026-11-25T00:00:32Z')
  r.tick(5000)
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['制限中', '制限中', '制限中', '⚠ 異常終了'])
})

test('★★ a stopped turn or a declined card sends nothing (the transcript ends without an answer)', async () => {
  const r = rig()
  await r.n.look()
  r.set('working', [user(0)])
  await r.n.look()
  r.set('done')
  await r.n.look()
  assert.equal(r.sent.length, 0, 'stopped while thinking')
  r.set('waiting', asking(2))
  await r.n.look()
  r.set('done')
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['要対応'], 'declined at the card')
})

test('one ring per card: the same card seen again is quiet, the next turn rings again', async () => {
  const r = rig()
  await r.n.look()
  for (const s of ['waiting', 'working', 'waiting'] as const) {
    r.set(s, asking(0))
    await r.n.look()
  }
  assert.equal(r.sent.length, 1)
  r.set('working', asking(4))
  await r.n.look()
  // (each card is its own state write)
  r.set('waiting', undefined, '2026-11-20T00:01:00Z')
  await r.n.look()
  assert.equal(r.sent.length, 2)
})

test('a send that reached no device is not remembered (the same state rings next time)', async () => {
  const r = rig()
  await r.n.look()
  r.fail(true)
  r.set('waiting', asking(0))
  await r.n.look()
  r.fail(false)
  r.set('working')
  await r.n.look()
  r.set('waiting')
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['要対応'])
})

test('a conversation that appears already working, or goes from idle to done, is not "done" news', async () => {
  const r = rig()
  r.set(undefined)
  await r.n.look()
  r.set('done', answered(0))
  await r.n.look()
  r.set('idle')
  await r.n.look()
  r.set('done')
  await r.n.look()
  assert.equal(r.sent.length, 0)
})

test('a slow push does not swallow a turn that ends meanwhile (each look reads the rows when it is asked for)', async () => {
  const r = rig()
  r.set('done', answered(0))
  await r.n.look()
  let release!: () => void
  r.hold(new Promise<void>((res) => (release = res)))
  r.set('error')
  const first = r.n.look()
  // its push is on its way (blocked) before the next looks are asked for
  await new Promise((res) => setTimeout(res, 0))
  // while that push is still on its way: a whole turn (working → done)
  r.set('working', [user(2)])
  const second = r.n.look()
  r.set('done', answered(2))
  const third = r.n.look()
  r.hold(undefined)
  release()
  await Promise.all([first, second, third])
  assert.deepEqual(r.sent.map((f) => f.label), ['⚠ 異常終了', '完了'])
})

test('★ a push that reached nobody is tried again while the card is still up (every 30 s), then stops', async () => {
  const r = rig()
  await r.n.look()
  r.fail(true)
  r.set('waiting', asking(0))
  await r.n.look()
  r.fail(false)
  r.tick(10_000)
  await r.n.look()
  assert.equal(r.sent.length, 0, 'not before 30 s')
  r.tick(20_000)
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['要対応'])
  r.tick(60_000)
  await r.n.look()
  assert.equal(r.sent.length, 1, 'once delivered, not again')
  // a state left before the retry: nothing owed any more
  r.fail(true)
  r.set('working', asking(2))
  await r.n.look()
  r.set('waiting')
  await r.n.look()
  r.set('working')
  await r.n.look()
  r.fail(false)
  r.tick(60_000)
  await r.n.look()
  assert.equal(r.sent.length, 1)
})

test('★ a turn that started and ended between two looks still rings "done" (the turn moved on)', async () => {
  const r = rig()
  r.set('done', answered(0))
  await r.n.look()
  r.set('done', answered(4))
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['完了'])
  // a new turn stopped by hand: nothing
  r.set('done', [user(8)])
  await r.n.look()
  // a card of a new turn seen without its "working" (each card is its own state write)
  r.set('waiting', asking(10), '2026-11-20T00:01:00Z')
  await r.n.look()
  r.set('waiting', asking(12), '2026-11-20T00:02:00Z')
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['完了', '要対応', '要対応'])
})

test('★ a send that throws is owed like one that reached nobody (and does not stop the look)', async () => {
  const r = rig()
  await r.n.look()
  r.fail('throw')
  r.set('waiting', asking(0))
  await r.n.look()
  r.fail(false)
  r.tick(31_000)
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['要対応'])
})

test('★ a look held behind a slow push does not ring for a card already handled (the newer look wins)', async () => {
  const r = rig()
  r.set('done', answered(0))
  await r.n.look()
  let release!: () => void
  r.hold(new Promise<void>((res) => (release = res)))
  r.set('error')
  const first = r.n.look()
  // its push is on its way (blocked) before the next looks are asked for
  await new Promise((res) => setTimeout(res, 0))
  r.set('waiting', asking(2))
  const second = r.n.look()
  // declined on the PC before the push queue moved
  r.set('done', asking(2))
  const third = r.n.look()
  r.hold(undefined)
  release()
  await Promise.all([first, second, third])
  assert.deepEqual(r.sent.map((f) => f.label), ['⚠ 異常終了'])
})

test('★ a "done" still owed is dropped when the next turn starts (it would speak for the wrong turn)', async () => {
  const r = rig()
  r.set('working', [user(0)])
  await r.n.look()
  r.fail(true)
  r.set('done', answered(0))
  await r.n.look()
  r.fail(false)
  // the next turn started and was stopped between two looks
  r.set('done', [user(4)])
  await r.n.look()
  r.tick(60_000)
  await r.n.look()
  assert.equal(r.sent.length, 0)
})

test('★ a first turn that started and ended between two looks rings "done"; an old answer of a resumed one does not', async () => {
  const r = rig()
  r.set(undefined)
  await r.n.look()
  r.tick(5_000)
  // an answer older than the previous look (a conversation resumed with its old answer)
  r.set('done', [user(0), { step_index: 1, type: 'PLANNER_RESPONSE', content: 'Old.', created_at: new Date(-60_000).toISOString() }])
  await r.n.look()
  assert.equal(r.sent.length, 0)
  // the conversation goes away (and is forgotten after the grace for missing ones)
  r.set(undefined)
  await r.n.look()
  r.tick(61_000)
  await r.n.look()
  r.tick(5_000)
  // a new conversation whose first turn started and ended between two looks
  r.set('done', [user(0), { step_index: 1, type: 'PLANNER_RESPONSE', content: 'New.', created_at: new Date(70_000).toISOString() }])
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['完了'])
})

test('★ within one look, a second row’s push checks the newest look again (its card was declined meanwhile)', async () => {
  const B = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  let rows: SessionSummary[] = []
  const mk = (id: string, status: SessionStatus) => ({ machine: 'pc-a', account: 'agy', tool: 'agy', sessionId: `agy-${id}`, cwd: '/home/user/p', project: 'p', title: 'x', titleSource: 'ai', status, live: true, lastActivity: '' }) as SessionSummary
  let release!: () => void
  let gate: Promise<void> | undefined = new Promise<void>((res) => (release = res))
  const sent: string[] = []
  const n = new AgyNotifier({
    rows: async () => rows,
    home: '/home/user',
    send: async (row) => {
      sent.push(row.sessionId)
      if (gate) await gate
      return 1
    },
    tail: () => asking(0),
  })
  rows = [mk(A, 'working'), mk(B, 'working')]
  await n.look()
  rows = [mk(A, 'waiting'), mk(B, 'waiting')]
  const first = n.look()
  await new Promise((res) => setTimeout(res, 0))
  // A's push is on its way; B's card is declined on the PC
  rows = [mk(A, 'waiting'), mk(B, 'done')]
  const second = n.look()
  gate = undefined
  release()
  await Promise.all([first, second])
  assert.deepEqual(sent, [`agy-${A}`])
})

test('★ the sender is handed a guard that turns false when a newer look shows the state moved on', async () => {
  let rows: SessionSummary[] = []
  const mk = (status: SessionStatus) => ({ machine: 'pc-a', account: 'agy', tool: 'agy', sessionId: `agy-${A}`, cwd: '/home/user/p', project: 'p', title: 'x', titleSource: 'ai', status, live: true, lastActivity: '' }) as SessionSummary
  let guard: (() => boolean) | undefined
  let release!: () => void
  const gate = new Promise<void>((res) => (release = res))
  let clock = 0
  const n = new AgyNotifier({ rows: async () => rows, home: '/home/user', tail: () => asking(0), now: () => ++clock, send: async (_r, _f, current) => {
    guard = current
    await gate
    return current?.() ? 1 : 0
  } })
  rows = [mk('working')]
  await n.look()
  rows = [mk('waiting')]
  const first = n.look()
  await new Promise((res) => setTimeout(res, 0))
  assert.equal(guard?.(), true)
  // declined on the PC: the watcher's look reads it while the push is still being prepared
  rows = [mk('done')]
  const second = n.look()
  await new Promise((res) => setTimeout(res, 0))
  assert.equal(guard?.(), false)
  release()
  await Promise.all([first, second])
})

test('★ the guard also reads the state right now (a look can be up to 300 ms behind the files)', async () => {
  // (the card is the row's own state write: '' in this fixture)
  let now: { status: string; turn: number | undefined; card?: string } | undefined = { status: 'waiting', turn: 0, card: '' }
  let guard: (() => boolean) | undefined
  const row = (status: SessionStatus) => ({ machine: 'pc-a', account: 'agy', tool: 'agy', sessionId: `agy-${A}`, cwd: '/home/user/p', project: 'p', title: 'x', titleSource: 'ai', status, live: true, lastActivity: '' }) as SessionSummary
  let rows = [row('working')]
  let clock = 0
  const n = new AgyNotifier({ rows: async () => rows, home: '/home/user', now: () => clock, tail: () => asking(0), statusNow: () => now, send: async (_r, _f, current) => {
    guard = current
    return 1
  } })
  await n.look()
  rows = [row('waiting')]
  await n.look()
  assert.equal(guard?.(), true)
  now = { status: 'done', turn: 0 }
  clock += 1500 // (the direct read is reused for a second within one send)
  assert.equal(guard?.(), false)
  // ★ for "needs you" the card alone decides: the same card read with another turn (a transcript read that failed) is
  //   still this push's news (a new card would be another state write)
  now = { status: 'waiting', turn: 2, card: '' }
  clock += 1500 // (the direct read is reused for a second within one send)
  assert.equal(guard?.(), true)
  // ★ the same turn, but another card
  now = { status: 'waiting', turn: 0, card: '1/1' }
  clock += 1500 // (the direct read is reused for a second within one send)
  assert.equal(guard?.(), false)
})

test('★ no "done" when another agy wrote into the conversation during the turn (the answer may be the other one’s)', async () => {
  let others = true
  const row = (status: SessionStatus) => ({ machine: 'pc-a', account: 'agy', tool: 'agy', sessionId: `agy-${A}`, cwd: '/home/user/p', project: 'p', title: 'x', titleSource: 'ai', status, live: true, lastActivity: '' }) as SessionSummary
  let rows = [row('working')]
  let records: Record<string, unknown>[] = [user(0)]
  const sent: string[] = []
  const n = new AgyNotifier({ rows: async () => rows, home: '/home/user', tail: () => records, othersWrote: () => others, send: async (_r, f) => {
    sent.push(f.label)
    return 1
  } })
  await n.look()
  rows = [row('done')]
  records = answered(0)
  await n.look()
  assert.deepEqual(sent, [])
  others = false
  rows = [row('working')]
  records = [user(2)]
  await n.look()
  rows = [row('done')]
  records = answered(2)
  await n.look()
  assert.deepEqual(sent, ['完了'])
  // a turn whose start time is unknown is not trusted for "done" either
  rows = [row('working')]
  records = [{ step_index: 4, type: 'USER_INPUT' }]
  await n.look()
  rows = [row('done')]
  records = [{ step_index: 4, type: 'USER_INPUT' }, { step_index: 5, type: 'PLANNER_RESPONSE', content: 'ok' }]
  await n.look()
  assert.deepEqual(sent, ['完了'])
})

test('★ a long turn whose prompt is out of the tail still rings "done" (looked for further back)', async () => {
  const row = (status: SessionStatus) => ({ machine: 'pc-a', account: 'agy', tool: 'agy', sessionId: `agy-${A}`, cwd: '/home/user/p', project: 'p', title: 'x', titleSource: 'ai', status, live: true, lastActivity: '' }) as SessionSummary
  const tailOnly = [{ step_index: 900, type: 'GENERIC' }, { step_index: 901, type: 'PLANNER_RESPONSE', content: 'Done.' }]
  for (const deep of [true, false]) {
    let rows = [row('working')]
    const sent: string[] = []
    const n = new AgyNotifier({
      rows: async () => rows,
      home: '/home/user',
      tail: () => tailOnly,
      ...(deep ? { turnStart: () => ({ turn: 4, at: 1000 }) } : {}),
      othersWrote: () => false,
      send: async (_r, f) => {
        sent.push(f.label)
        return 1
      },
    })
    await n.look()
    rows = [row('done')]
    await n.look()
    assert.deepEqual(sent, deep ? ['完了'] : [], String(deep))
  }
})

test('★ owe: a card shown again after a key that did not land rings "needs you" again', async () => {
  const r = rig()
  r.set('working', asking(0))
  await r.n.look()
  r.set('waiting')
  await r.n.look()
  assert.equal(r.sent.length, 1)
  await r.n.look()
  assert.equal(r.sent.length, 1)
  r.n.owe(`agy-${A}`, '2026-11-20T00:00:10Z')
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['要対応', '要対応'])
  // not owed when it is not waiting any more
  r.set('working')
  await r.n.look()
  r.n.owe(`agy-${A}`, '2026-11-20T00:00:10Z')
  await r.n.look()
  assert.equal(r.sent.length, 2)
})

test('★ a long turn’s failed push is retried (its turn is known only from further back)', async () => {
  const row = (status: SessionStatus) => ({ machine: 'pc-a', account: 'agy', tool: 'agy', sessionId: `agy-${A}`, cwd: '/home/user/p', project: 'p', title: 'x', titleSource: 'ai', status, live: true, lastActivity: '' }) as SessionSummary
  let rows = [row('working')]
  let ok = 0
  let clock = 0
  const sent: string[] = []
  const n = new AgyNotifier({
    rows: async () => rows,
    home: '/home/user',
    now: () => clock,
    tail: () => [{ step_index: 900, type: 'PLANNER_RESPONSE', content: 'Done.' }],
    turnStart: () => ({ turn: 4, at: 1000 }),
    othersWrote: () => false,
    send: async (_r, f) => {
      if (ok) sent.push(f.label)
      return ok
    },
  })
  await n.look()
  rows = [row('done')]
  await n.look()
  ok = 1
  clock += 31_000
  await n.look()
  assert.deepEqual(sent, ['完了'])
})

test('★ an `owe` made while the earlier push is still going out is not settled by that push', async () => {
  const r = rig()
  r.set('working', asking(0))
  await r.n.look()
  let release!: () => void
  r.hold(new Promise<void>((res) => (release = res)))
  r.set('waiting')
  const first = r.n.look()
  await new Promise((res) => setTimeout(res, 0))
  // phone A denied, the key did not land, the card came back: a fresh "needs you" is owed
  r.n.owe(`agy-${A}`, '2026-11-20T00:00:10Z')
  r.hold(undefined)
  release()
  await first
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['要対応', '要対応'])
})

test('★ owe made before the waiting look is applied still rings; a failed ring is kept and tried again after 30 s', async () => {
  const r = rig()
  r.set('waiting', asking(0))
  r.set('working')
  await r.n.look()
  r.set('waiting')
  await r.n.look()
  assert.equal(r.sent.length, 1)
  // the second card of the same turn, while the previous applied look still says working
  r.set('working')
  await r.n.look()
  r.n.owe(`agy-${A}`, '2026-11-20T00:00:10Z')
  r.set('waiting')
  r.fail(true)
  await r.n.look()
  r.fail(false)
  await r.n.look()
  assert.equal(r.sent.length, 1, 'not on every look')
  r.tick(31_000)
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['要対応', '要対応'])
  await r.n.look()
  assert.equal(r.sent.length, 2, 'once')
})

test('★ a look between a new prompt and agy rewriting its state does not tell the old state as the new turn’s', async () => {
  const row = (status: SessionStatus, lastActivity: string) => ({ machine: 'pc-a', account: 'agy', tool: 'agy', sessionId: `agy-${A}`, cwd: '/home/user/p', project: 'p', title: 'x', titleSource: 'ai', status, live: true, lastActivity }) as SessionSummary
  let rows = [row('error', '2026-11-20T00:00:05Z')]
  let records: Record<string, unknown>[] = [{ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-20T00:00:00Z' }]
  const sent: string[] = []
  const n = new AgyNotifier({ rows: async () => rows, home: '/home/user', tail: () => records, send: async (_r, f) => {
    sent.push(f.label)
    return 1
  } })
  await n.look()
  // the new prompt is written; the state file still holds the old error
  records = [{ step_index: 4, type: 'USER_INPUT', created_at: '2026-11-20T00:01:00Z' }]
  await n.look()
  assert.deepEqual(sent, [])
  // the new turn fails for real (its state written after the prompt)
  rows = [row('error', '2026-11-20T00:01:03Z')]
  await n.look()
  assert.deepEqual(sent, ['⚠ 異常終了'])
})

test('★ a queued older look does not drop a ring asked for since (the newest look decides)', async () => {
  const B = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  const mk = (id: string, status: SessionStatus) => ({ machine: 'pc-a', account: 'agy', tool: 'agy', sessionId: `agy-${id}`, cwd: '/home/user/p', project: 'p', title: 'x', titleSource: 'ai', status, live: true, lastActivity: '' }) as SessionSummary
  let rows = [mk(A, 'working'), mk(B, 'working')]
  let gate: Promise<void> | undefined
  const sent: string[] = []
  const n = new AgyNotifier({ rows: async () => rows, home: '/home/user', tail: () => asking(0), send: async (row, f) => {
    sent.push(`${row.sessionId.slice(4, 5)}:${f.label}`)
    if (gate && row.sessionId === `agy-${B}`) await gate
    return 1
  } })
  await n.look()
  // A's first card rings
  rows = [mk(A, 'waiting'), mk(B, 'working')]
  await n.look()
  // B's push is slow and holds the queue; A goes working, then its second card of the same turn comes
  let release!: () => void
  gate = new Promise<void>((res) => (release = res))
  rows = [mk(A, 'waiting'), mk(B, 'error')]
  const a = n.look()
  await new Promise((res) => setTimeout(res, 0))
  rows = [mk(A, 'working'), mk(B, 'error')]
  const b = n.look()
  rows = [mk(A, 'waiting'), mk(B, 'error')]
  const c = n.look()
  await new Promise((res) => setTimeout(res, 0))
  // the phone denied A's second card, the key did not land, the card came back: ring A again
  n.owe(`agy-${A}`, '')
  gate = undefined
  release()
  await Promise.all([a, b, c])
  assert.deepEqual(sent, ['0:要対応', 'f:⚠ 異常終了', '0:要対応'])
})

test('★ a late retry of an old error is remembered under its own turn (the next turn’s real error still rings)', async () => {
  const row = (status: SessionStatus, lastActivity: string) => ({ machine: 'pc-a', account: 'agy', tool: 'agy', sessionId: `agy-${A}`, cwd: '/home/user/p', project: 'p', title: 'x', titleSource: 'ai', status, live: true, lastActivity }) as SessionSummary
  let rows = [row('working', '2026-11-20T00:00:01Z')]
  let records: Record<string, unknown>[] = [{ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-20T00:00:00Z' }]
  let ok = 0
  let clock = 0
  const sent: string[] = []
  const n = new AgyNotifier({ rows: async () => rows, home: '/home/user', now: () => clock, tail: () => records, send: async (_r, f) => {
    if (ok) sent.push(f.label)
    return ok
  } })
  await n.look()
  rows = [row('error', '2026-11-20T00:00:05Z')]
  await n.look()
  // the retry comes due after the next prompt was written but before agy rewrote its state
  ok = 1
  clock += 31_000
  records = [{ step_index: 4, type: 'USER_INPUT', created_at: '2026-11-20T00:01:00Z' }]
  await n.look()
  assert.deepEqual(sent, ['⚠ 異常終了'])
  // the next turn fails for real
  rows = [row('working', '2026-11-20T00:01:01Z')]
  await n.look()
  rows = [row('error', '2026-11-20T00:01:05Z')]
  await n.look()
  assert.deepEqual(sent, ['⚠ 異常終了', '⚠ 異常終了'])
})

test('★ a ring for an old card does not hold back the next turn’s card', async () => {
  const r = rig()
  r.set('working', asking(0))
  await r.n.look()
  r.set('waiting')
  await r.n.look()
  r.n.owe(`agy-${A}`, '2026-11-20T00:00:10Z')
  r.fail(true)
  await r.n.look()
  r.fail(false)
  // the old card was answered on the PC; a new turn reaches its own card (its own state write)
  r.set('working', asking(4))
  await r.n.look()
  r.set('waiting', undefined, '2026-11-20T00:01:00Z')
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['要対応', '要対応'])
})

test('★ a state in the same second as a new prompt is the previous turn’s until the model writes after the prompt', async () => {
  const row = (status: SessionStatus, lastActivity: string) => ({ machine: 'pc-a', account: 'agy', tool: 'agy', sessionId: `agy-${A}`, cwd: '/home/user/p', project: 'p', title: 'x', titleSource: 'ai', status, live: true, lastActivity }) as SessionSummary
  let rows = [row('working', '2026-11-20T00:00:01Z')]
  let records: Record<string, unknown>[] = [{ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-20T00:00:00Z' }]
  const sent: string[] = []
  const n = new AgyNotifier({ rows: async () => rows, home: '/home/user', tail: () => records, send: async (_r, f) => {
    sent.push(f.label)
    return 1
  } })
  await n.look()
  rows = [row('error', '2026-11-20T00:00:05.100Z')]
  await n.look()
  assert.deepEqual(sent, ['⚠ 異常終了'])
  // a queued prompt went in at .800 of the same second; the state file still holds turn 0's error
  records = [...records, { step_index: 1, type: 'ERROR_MESSAGE' }, { step_index: 2, type: 'USER_INPUT', created_at: '2026-11-20T00:00:05Z' }]
  await n.look()
  assert.deepEqual(sent, ['⚠ 異常終了'], 'not told again as the new turn’s')
  // the new turn errs for real (the model wrote after the prompt)
  records = [...records, { step_index: 3, type: 'ERROR_MESSAGE' }]
  rows = [row('working', '2026-11-20T00:00:05.300Z')]
  await n.look()
  rows = [row('error', '2026-11-20T00:00:05.900Z')]
  await n.look()
  assert.deepEqual(sent, ['⚠ 異常終了', '⚠ 異常終了'])
})

test('★ a second card in the same turn rings too (each card is told once)', async () => {
  const r = rig()
  const two = [user(0), { step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-20T00:00:01Z', tool_calls: [{ name: 'read_file', args: { Path: '/etc/hostname' } }, { name: 'run_command', args: { CommandLine: 'make' } }] }]
  r.set('working', two)
  await r.n.look()
  r.set('waiting')
  await r.n.look()
  r.set('working', [...two, { step_index: 2, type: 'GENERIC', content: 'Created At: 2026-11-20T00:00:01Z\nok' }], '2026-11-20T00:00:20Z')
  await r.n.look()
  r.set('waiting', undefined, '2026-11-20T00:00:21Z')
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['要対応', '要対応'])
})

test('★ a second card seen without the `working` between them still rings (two waiting looks, different cards)', async () => {
  const r = rig()
  const two = [user(0), { step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-20T00:00:01Z', tool_calls: [{ name: 'read_file', args: { Path: '/etc/hostname' } }, { name: 'run_command', args: { CommandLine: 'make' } }] }]
  r.set('working', two)
  await r.n.look()
  r.set('waiting')
  await r.n.look()
  r.set('waiting', [...two, { step_index: 2, type: 'GENERIC', content: 'Created At: 2026-11-20T00:00:01Z\nok' }], '2026-11-20T00:00:21Z')
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['要対応', '要対応'])
  await r.n.look()
  assert.equal(r.sent.length, 2, 'the same card is not told again')
})

test('★ a queued alert for a card answered meanwhile is not sent for the next card (only the next card’s own)', async () => {
  const B = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  const mk = (id: string, status: SessionStatus) => ({ machine: 'pc-a', account: 'agy', tool: 'agy', sessionId: `agy-${id}`, cwd: '/home/user/p', project: 'p', title: 'x', titleSource: 'ai', status, live: true, lastActivity: '2026-11-20T00:00:10Z' }) as SessionSummary
  const two = [user(0), { step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-20T00:00:01Z', tool_calls: [{ name: 'read_file', args: { Path: '/x' } }, { name: 'run_command', args: { CommandLine: 'make' } }] }]
  let rows = [mk(A, 'working'), mk(B, 'working')]
  let records: Record<string, unknown>[] = two
  let gate: Promise<void> | undefined
  const sent: string[] = []
  const n = new AgyNotifier({ rows: async () => rows, home: '/home/user', tail: () => records, send: async (row, f) => {
    sent.push(`${row.sessionId.slice(4, 5)}:${f.label}`)
    if (gate && row.sessionId === `agy-${B}`) await gate
    return 1
  } })
  await n.look()
  let release!: () => void
  gate = new Promise<void>((res) => (release = res))
  rows = [mk(A, 'working'), mk(B, 'error')]
  const a = n.look()
  await new Promise((res) => setTimeout(res, 0))
  // card 1 comes up (its alert queues behind B's), then is allowed on the PC and card 2 comes up
  rows = [mk(A, 'waiting'), mk(B, 'error')]
  const b = n.look()
  records = [...two, { step_index: 2, type: 'GENERIC', content: 'Created At: 2026-11-20T00:00:01Z\nok' }]
  rows = [mk(A, 'waiting'), mk(B, 'error')]
  const c = n.look()
  gate = undefined
  release()
  await Promise.all([a, b, c])
  assert.deepEqual(sent.filter((x) => x.startsWith('0')), ['0:要対応'])
})

test('★ another agy’s later call in the shared transcript is not a new card of this agy (no extra "needs you")', async () => {
  const r = rig()
  const mine = [user(0), { step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-20T00:00:01Z', tool_calls: [{ name: 'run_command', args: { CommandLine: 'make' } }] }]
  r.set('working', mine)
  await r.n.look()
  r.set('waiting')
  await r.n.look()
  // a second agy wrote its own call after this agy's state (the rig's state time is 00:00:10)
  r.set('waiting', [...mine, { step_index: 2, type: 'USER_INPUT', created_at: '2026-11-20T00:00:20Z' }, { step_index: 3, type: 'PLANNER_RESPONSE', created_at: '2026-11-20T00:00:30Z', tool_calls: [{ name: 'read_file', args: { Path: '/x' } }] }])
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['要対応'])
})

test('★ cards are not told apart while another agy writes into the conversation (one "needs you" per turn then)', async () => {
  const row = (status: SessionStatus) => ({ machine: 'pc-a', account: 'agy', tool: 'agy', sessionId: `agy-${A}`, cwd: '/home/user/p', project: 'p', title: 'x', titleSource: 'ai', status, live: true, lastActivity: '2026-11-20T00:00:10Z' }) as SessionSummary
  const two = [user(0), { step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-20T00:00:01Z', tool_calls: [{ name: 'read_file', args: { Path: '/x' } }, { name: 'run_command', args: { CommandLine: 'make' } }] }]
  let rows = [row('working')]
  let records: Record<string, unknown>[] = two
  const sent: string[] = []
  const n = new AgyNotifier({ rows: async () => rows, home: '/home/user', tail: () => records, othersWrote: () => true, send: async (_r, f) => {
    sent.push(f.label)
    return 1
  } })
  await n.look()
  rows = [row('waiting')]
  await n.look()
  // what looks like the next card (it may be the other agy's call)
  records = [...two, { step_index: 2, type: 'GENERIC', content: 'Created At: 2026-11-20T00:00:01Z\nok' }]
  await n.look()
  assert.deepEqual(sent, ['要対応'])
})

test('★ the same card is not told again when a second agy’s prompt makes it look like a new turn', async () => {
  const r = rig()
  r.set('working', asking(0))
  await r.n.look()
  r.set('waiting')
  await r.n.look()
  // another agy's prompt (and its model's write) after this agy's state: the turn changes, the card (own write) does not
  r.set('waiting', [...asking(0), { step_index: 5, type: 'USER_INPUT', created_at: '2026-11-20T00:00:05Z' }, { step_index: 6, type: 'PLANNER_RESPONSE', content: 'x' }])
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['要対応'])
})

test('★ a "needs you" that reached nobody is retried while the same card stays up, even if a second agy changed the turn', async () => {
  const r = rig()
  r.set('working', asking(0))
  await r.n.look()
  r.fail(true)
  r.set('waiting')
  await r.n.look()
  r.fail(false)
  // another agy's prompt and response after this agy's state (the turn changes; the card does not)
  r.set('waiting', [...asking(0), { step_index: 5, type: 'USER_INPUT', created_at: '2026-11-20T00:00:05Z' }, { step_index: 6, type: 'PLANNER_RESPONSE', content: 'x' }])
  r.tick(31_000)
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['要対応'])
})

test('★ a "done" whose other-writer check cannot be told now is tried again later, not dropped', async () => {
  const row = (status: SessionStatus) => ({ machine: 'pc-a', account: 'agy', tool: 'agy', sessionId: `agy-${A}`, cwd: '/home/user/p', project: 'p', title: 'x', titleSource: 'ai', status, live: true, lastActivity: '2026-11-20T00:00:10Z' }) as SessionSummary
  let rows = [row('working')]
  let tell: boolean | undefined = undefined
  let clock = 0
  const sent: string[] = []
  const n = new AgyNotifier({ rows: async () => rows, home: '/home/user', now: () => clock, tail: () => answered(0), othersWrote: async () => tell, send: async (_r, f) => {
    sent.push(f.label)
    return 1
  } })
  await n.look()
  rows = [row('done')]
  await n.look()
  assert.deepEqual(sent, [])
  tell = false
  clock += 31_000
  await n.look()
  assert.deepEqual(sent, ['完了'])
})

test('★ a conversation missing from one look (a failed probe) is remembered: its completion afterwards still rings', async () => {
  const r = rig()
  r.set('working', [user(0)])
  await r.n.look()
  r.set(undefined)
  r.tick(5_000)
  await r.n.look()
  r.set('done', answered(0))
  r.tick(5_000)
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['完了'])
  // gone for longer than the grace: forgotten (then it is a new conversation)
  r.set('working', [user(2)])
  await r.n.look()
  r.set(undefined)
  await r.n.look()
  r.tick(61_000)
  await r.n.look()
  r.set('done', answered(2))
  await r.n.look()
  assert.equal(r.sent.length, 1)
})

test('★ a push whose newest look lacks the row (a failed probe) is owed, not dropped', async () => {
  const r = rig()
  r.set('working', [user(0)])
  await r.n.look()
  // the "done" look is applied while a newer look (asked for meanwhile) misses the row
  r.set('done', answered(0))
  const first = r.n.look()
  r.set(undefined)
  const second = r.n.look()
  await Promise.all([first, second])
  assert.equal(r.sent.length, 0)
  r.set('done', answered(0))
  r.tick(31_000)
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['完了'])
})

test('★★ a card auto-approve is answering does not ring; the turn still rings "done"; a card handed to the phone rings', async () => {
  const quietFor = new Set<string>()
  const r = rig({ quiet: (id, card) => id === `agy-${A}` && quietFor.has(card) })
  await r.n.look()
  quietFor.add('2026-11-20T00:00:20Z')
  r.set('working', asking(0))
  await r.n.look()
  r.set('waiting', undefined, '2026-11-20T00:00:20Z')
  await r.n.look()
  assert.equal(r.sent.length, 0, 'answered by auto-approve: quiet')
  // ★ its key did not land: the card goes to the phone (`owe`) and rings
  quietFor.delete('2026-11-20T00:00:20Z')
  r.n.owe(`agy-${A}`, '2026-11-20T00:00:20Z')
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['要対応'])
  r.set('working')
  await r.n.look()
  r.set('done', answered(0), '2026-11-20T00:00:30Z')
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['要対応', '完了'])
  // a card not answered by auto-approve (another write) rings as usual
  r.set('waiting', asking(4), '2026-11-20T00:01:00Z')
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['要対応', '完了', '要対応'])
})

test('★ an auto-answer that fails while "quiet" is asked rings that card once, not twice', async () => {
  let r!: ReturnType<typeof rig>
  let quietCalls = 0
  r = rig({
    quiet: async (id, card) => {
      // the auto-answer fails during this question: the card is handed to the phone (owe) and is not quiet any more
      if (quietCalls++ === 0) {
        r.n.owe(id, card, true)
        void r.n.look()
      }
      return false
    },
  })
  await r.n.look()
  r.set('working', asking(0))
  await r.n.look()
  r.set('waiting', undefined, '2026-11-20T00:00:20Z')
  await r.n.look()
  await r.n.look()
  await r.n.look()
  assert.ok(quietCalls >= 1)
  assert.deepEqual(r.sent.map((f) => f.label), ['要対応'])
})

test('★ "cannot tell" whether auto-approve answers a card holds its "needs you" back a few looks: quiet if it then answers, rung if it never can tell', async () => {
  const answers: (boolean | undefined)[] = [undefined, true]
  const r = rig({ quiet: async () => (answers.length > 0 ? answers.shift() : true) })
  await r.n.look()
  r.set('working', asking(0))
  await r.n.look()
  r.set('waiting', undefined, '2026-11-20T00:00:20Z')
  await r.n.look()
  await r.n.look()
  await r.n.look()
  assert.equal(r.sent.length, 0, 'held back, then answered by auto-approve')
  // never able to tell ⇒ rung after QUIET_UNSURE_MAX looks
  const r2 = rig({ quiet: async () => undefined })
  await r2.n.look()
  r2.set('working', asking(0))
  await r2.n.look()
  r2.set('waiting', undefined, '2026-11-20T00:00:20Z')
  for (let i = 0; i < QUIET_UNSURE_MAX; i++) {
    await r2.n.look()
    assert.equal(r2.sent.length, 0, `look ${i + 1}`)
  }
  await r2.n.look()
  assert.deepEqual(r2.sent.map((f) => f.label), ['要対応'])
})

test('★ a card waiting when the agent starts rings (it may have appeared while the agent was down); other states do not', async () => {
  const r = rig()
  r.set('waiting', asking(0), '2026-11-20T00:00:20Z')
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['要対応'])
  await r.n.look()
  assert.equal(r.sent.length, 1, 'once')
  for (const s of ['done', 'error', 'working'] as const) {
    const r2 = rig()
    r2.set(s, answered(0))
    await r2.n.look()
    assert.equal(r2.sent.length, 0, s)
  }
})

test('★ a card auto-approve was answering is asked about again while it waits: rung once it is not answered any more', async () => {
  let answering = true
  const r = rig({ quiet: async () => answering })
  await r.n.look()
  r.set('working', asking(0))
  await r.n.look()
  r.set('waiting', undefined, '2026-11-20T00:00:20Z')
  await r.n.look()
  await r.n.look()
  assert.equal(r.sent.length, 0)
  // the auto-answer failed without a fallback (its record dropped): still waiting ⇒ rung
  answering = false
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['要対応'])
  await r.n.look()
  assert.equal(r.sent.length, 1)
})

test('★ a "needs you" is judged by its card, not the turn: a newer look reading another turn for the same card still lets it go', async () => {
  const sent: string[] = []
  const reads = [[{ step_index: 1, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command', args: { CommandLine: 'ls' } }] }], asking(0)]
  const n = new AgyNotifier({
    rows: async () => [{ machine: 'pc-a', account: 'agy', tool: 'agy', sessionId: `agy-${A}`, cwd: '/home/user/p', project: 'p', title: 'x', titleSource: 'ai', status: 'waiting', live: true, lastActivity: '2026-11-20T00:00:20Z' } as SessionSummary],
    home: '/home/user',
    // the first look could not read the prompt (no turn); the newer one did
    tail: () => (reads.length > 1 ? reads.shift()! : reads[0]!),
    now: () => 0,
    send: async (_r, f) => {
      sent.push(f.label)
      return 1
    },
  })
  // two looks at once: the first is judged against the newer one
  await Promise.all([n.look(), n.look()])
  assert.deepEqual(sent, ['要対応'])
})

test('★★ "idle" then "done" on the same answer (a child\'s closing record became readable) rings "done" once (codex review)', async () => {
  let settled = true
  const r = rig({ settled: () => settled })
  r.set('working', asking(0))
  await r.n.look()
  r.tick(5_000)
  const answered = [user(0), { step_index: 1, type: 'PLANNER_RESPONSE', content: 'You chose Blue.', created_at: new Date(1_000).toISOString() }]
  r.set('idle', answered)
  await r.n.look()
  assert.equal(r.sent.length, 0)
  r.tick(5_000)
  r.set('done', answered)
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['完了'])
  // a flap back and forth on that answer does not ring it again
  r.tick(5_000)
  r.set('idle', answered)
  await r.n.look()
  r.tick(5_000)
  r.set('done', answered)
  await r.n.look()
  assert.equal(r.sent.length, 1)
  // ⚠️ the same flip while the children are not confirmed to have finished well (a failed child gone from the index):
  //    not rung (codex review)
  settled = false
  const r3 = rig({ settled: () => settled })
  r3.set('working', asking(0))
  await r3.n.look()
  r3.tick(5_000)
  r3.set('idle', answered)
  await r3.n.look()
  r3.tick(5_000)
  r3.set('done', answered)
  await r3.n.look()
  assert.equal(r3.sent.length, 0)
  settled = true
  // ⚠️ an old turn's answer read `idle` from the start (an agent restart), or `done → idle → done`, is not armed: the
  //    flip of an old turn does not ring (agy review)
  const r4 = rig({ settled: () => true })
  // (the answer is well before the first look: rule 7 does not take it as new)
  r4.tick(60_000)
  r4.set('idle', answered)
  await r4.n.look()
  r4.tick(5_000)
  r4.set('done', answered)
  await r4.n.look()
  r4.tick(5_000)
  r4.set('idle', answered)
  await r4.n.look()
  r4.tick(5_000)
  r4.set('done', answered)
  await r4.n.look()
  assert.equal(r4.sent.length, 0)
  // ★ a whole new turn between two looks, first seen `idle` (a child's closing record pending), then `done`: rung
  //   (codex review)
  const r5 = rig({ settled: () => true })
  r5.tick(60_000)
  r5.set('done', answered)
  await r5.n.look()
  r5.tick(60_000)
  const next = [...answered, user(2), { step_index: 3, type: 'PLANNER_RESPONSE', content: 'You chose Cat.', created_at: new Date(3_000).toISOString() }]
  r5.set('idle', next, '2026-11-20T00:05:00Z')
  await r5.n.look()
  r5.tick(5_000)
  r5.set('done', next)
  await r5.n.look()
  assert.deepEqual(r5.sent.map((f) => f.label), ['完了'])
  // ★ a conversation's first turn, first seen already over (`idle`), then `done`: rung if its prompt came after the
  //   previous look (codex review)
  const r6 = rig({ settled: () => true })
  r6.set(undefined)
  await r6.n.look()
  r6.tick(Date.parse('2026-11-20T00:00:30Z'))
  r6.set('idle', answered, '2026-11-20T00:00:40Z')
  await r6.n.look()
  r6.tick(5_000)
  r6.set('done', answered)
  await r6.n.look()
  assert.deepEqual(r6.sent.map((f) => f.label), ['完了'])
  // ⚠️ …but not one whose prompt is older than the previous look (an old conversation appearing)
  const r7 = rig({ settled: () => true })
  r7.tick(Date.parse('2026-11-21T00:00:00Z'))
  r7.set(undefined)
  await r7.n.look()
  r7.tick(5_000)
  r7.set('idle', answered, '2026-11-20T00:00:40Z')
  await r7.n.look()
  r7.tick(5_000)
  r7.set('done', answered)
  await r7.n.look()
  assert.equal(r7.sent.length, 0)
  // ★ a `working` look whose transcript gave no turn (not written yet, or unreadable), then `idle`, then `done`: armed by
  //   the working look (agy review)
  const r8 = rig({ settled: () => true })
  r8.tick(Date.parse('2026-11-22T00:00:00Z'))
  r8.set('working', [])
  await r8.n.look()
  r8.tick(5_000)
  r8.set('idle', answered, '2026-11-22T00:00:04Z')
  await r8.n.look()
  r8.tick(5_000)
  r8.set('done', answered)
  await r8.n.look()
  assert.deepEqual(r8.sent.map((f) => f.label), ['完了'])
  // ★ an `idle` row with no turn, then a look that sees the first prompt while the state is still the old one (not
  //   this turn's yet): the turn is not taken as known, so its end seen `idle` then `done` rings (codex review)
  const r9 = rig({ settled: () => true })
  r9.tick(Date.parse('2026-11-19T23:59:50Z'))
  r9.set('idle', [], '2026-11-19T23:59:00Z')
  await r9.n.look()
  // (…and the same when the conversation was not listed at all before: codex review)
  const r10 = rig({ settled: () => true })
  r10.tick(Date.parse('2026-11-19T23:59:50Z'))
  r10.set(undefined)
  await r10.n.look()
  r10.tick(9_000)
  r10.set('idle', [user(0)], '2026-11-19T23:59:00Z')
  await r10.n.look()
  r10.tick(60_000)
  r10.set('idle', answered, '2026-11-20T00:00:40Z')
  await r10.n.look()
  r10.tick(5_000)
  r10.set('done', answered)
  await r10.n.look()
  assert.deepEqual(r10.sent.map((f) => f.label), ['完了'])
  r9.tick(9_000)
  r9.set('idle', [user(0)], '2026-11-19T23:59:00Z')
  await r9.n.look()
  r9.tick(60_000)
  r9.set('idle', answered, '2026-11-20T00:00:40Z')
  await r9.n.look()
  r9.tick(5_000)
  r9.set('done', answered)
  await r9.n.look()
  assert.deepEqual(r9.sent.map((f) => f.label), ['完了'])
  // ⚠️ another answer than the one the idle look stood on is not this rule's (rule 7 decides it by time)
  const r2 = rig({ settled: () => true })
  r2.set('working', asking(0))
  await r2.n.look()
  r2.tick(5_000)
  r2.set('idle', answered)
  await r2.n.look()
  r2.tick(60_000)
  r2.set('done', [user(0), { step_index: 3, type: 'PLANNER_RESPONSE', content: 'Old.', created_at: new Date(2_000).toISOString() }])
  await r2.n.look()
  assert.equal(r2.sent.length, 0)
})

test('★ "idle" (its children outlived its answer) to "done" rings "done" when the new answer is newer than the last look', async () => {
  const r = rig()
  r.set('working', asking(0))
  await r.n.look()
  r.tick(5_000)
  // the children are over and wrote after the parent's answer: idle, nothing sent
  r.set('idle', [user(0), { step_index: 1, type: 'PLANNER_RESPONSE', content: 'Started.', created_at: new Date(1_000).toISOString() }])
  await r.n.look()
  assert.equal(r.sent.length, 0)
  r.tick(5_000)
  // the parent answers after them, before a look sees it working
  r.set('done', [user(0), { step_index: 3, type: 'PLANNER_RESPONSE', content: 'The check failed.', created_at: new Date(9_000).toISOString() }])
  await r.n.look()
  assert.deepEqual(r.sent.map((f) => f.label), ['完了'])
})

test('★ an older wait left up after a newer one ends does not ring again (codex · agy review: a subagent approval behind an answered question)', async () => {
  const r = rig()
  r.set('working', asking(0))
  await r.n.look()
  // a subagent blocks on a command
  r.set('waiting', asking(0), '2026-11-20T00:00:20Z')
  await r.n.look()
  // a sibling asks a question (newer)
  r.set('waiting', asking(0), '2026-11-20T00:00:30Z')
  await r.n.look()
  assert.equal(r.sent.length, 2)
  // the question answered from the phone: the approval's older name is back
  r.set('waiting', asking(0), '2026-11-20T00:00:20Z')
  await r.n.look()
  assert.equal(r.sent.length, 2, 'not rung again for the approval')
  // a new wait later still rings
  r.set('waiting', asking(0), '2026-11-20T00:00:40Z')
  await r.n.look()
  assert.equal(r.sent.length, 3)
})

test('★ …but an older wait that never reached the phone still rings when the newer one ends (codex · agy review)', async () => {
  const r = rig()
  r.set('working', asking(0))
  await r.n.look()
  r.fail(true)
  r.set('waiting', asking(0), '2026-11-20T00:00:20Z')
  await r.n.look()
  r.set('waiting', asking(0), '2026-11-20T00:00:30Z')
  await r.n.look()
  assert.equal(r.sent.length, 0)
  // the newer one answered at the PC, the push works again: the older one rings
  r.fail(false)
  r.set('waiting', asking(0), '2026-11-20T00:00:20Z')
  await r.n.look()
  assert.equal(r.sent.length, 1)
})
