import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NotifyFields, SessionStatus, SessionSummary } from '../../../shared/types.ts'
import { notificationText, statusLabel } from '../../../shared/types.ts'
import { toPushPayload } from '../routes/hook.ts'
import { parseTurn, type TurnsPage } from './history.ts'
import { AUTO_GRACE_MS, CodexNotifier, codexPayload, SETTLE_PAUSE_MS, SETTLE_TRIES } from './notify.ts'
import { ThreadBook, type StatusChange } from './threads.ts'

type Changed = Extract<StatusChange, { type: 'changed' }>

function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 't1',
    parentThreadId: null,
    preview: 'the first thing the user typed',
    ephemeral: false,
    updatedAt: 1000,
    status: { type: 'idle' },
    cwd: '/home/user/proj',
    threadSource: 'user',
    gitInfo: null,
    name: 'Fix login',
    ...over,
  }
}

/** A real book (so the row and its words are the real ones) plus a scripted history */
function world() {
  const book = new ThreadBook()
  book.upsert(raw())
  const w = {
    /** ★ Swappable: a reconnect is a new book (what the old connection saw is gone) */
    book,
    /** What the newest turn looks like on each successive read (the last one repeats) */
    history: [] as Array<{ id: string; status: string; error?: unknown } | undefined>,
    reads: 0,
    sleeps: [] as number[],
    sent: [] as Array<{ row: SessionSummary; fields: NotifyFields }>,
    devices: 1,
    logs: [] as string[],
    auto: false,
    /** Runs inside each history read, before it answers (what happens while the read is out) */
    duringRead: undefined as (() => void) | undefined,
    /** Runs inside each sleep (what happens in the world while the notifier waits) */
    duringSleep: undefined as (() => void) | undefined,
  }
  const notifier = new CodexNotifier({
    row: (id) => w.book.rows({ machine: 'pc-a', account: '.codex', idPrefix: '' }).find((r) => r.sessionId === id),
    turns: async (_id, o): Promise<TurnsPage | undefined> => {
      // ★ The notifier never asks for the conversation (codex review 2026-11-17, medium)
      assert.equal(o.headersOnly, true)
      const t = w.history[Math.min(w.reads, w.history.length - 1)]
      w.reads++
      w.duringRead?.()
      // ★ Through the real parser (the turn as the daemon sends it), so `limited` is the one the code really makes
      const turn = t ? parseTurn({ id: t.id, status: t.status, items: [], ...(t.error === undefined ? {} : { error: t.error }) }) : undefined
      return turn ? { turns: [turn], nextCursor: null, skipped: 0 } : undefined
    },
    setOutcome: (id, outcome, mark) => void w.book.setOutcome(id, outcome, mark),
    mark: (id) => w.book.mark(id),
    send: async (row, fields) => {
      w.sent.push({ row, fields })
      return w.devices
    },
    sleep: async (ms) => {
      w.sleeps.push(ms)
      w.duringSleep?.()
    },
    autoApproving: (id) => w.auto && id === 't1',
    log: (l) => w.logs.push(l),
  })
  const set = (status: Record<string, unknown>): Changed => {
    const c = w.book.setStatus('t1', status, 2000)
    assert.ok(c.type === 'changed')
    return c
  }
  const active = (...flags: string[]) => set({ type: 'active', activeFlags: flags })
  const idle = () => set({ type: 'idle' })
  const rowStatus = (): SessionStatus => w.book.rows({ machine: 'pc-a', account: '.codex', idPrefix: '' })[0]!.status
  return { ...w, w, notifier, set, active, idle, rowStatus }
}

const labels = (x: { sent: Array<{ fields: NotifyFields }> }): string[] => x.sent.map((s) => s.fields.label)

test('a completed turn: one "done", in the list\'s words, with the row\'s fields', async () => {
  const x = world()
  x.w.history = [{ id: 'turn-1', status: 'completed' }]
  await x.notifier.onStatus(x.active())
  assert.equal(x.sent.length, 0, 'going active sends nothing')
  await x.notifier.onStatus(x.idle())
  assert.deepEqual(labels(x), [statusLabel('done')])
  const f = x.sent[0]!.fields
  assert.deepEqual(f, { title: 'Fix login', titleSource: 'ai', sessionId: 't1', project: 'proj', machine: 'pc-a', account: '.codex', label: '完了' })
  assert.equal(x.rowStatus(), 'done')
})

test('★ a failed turn that first reads as "interrupted / no error" is reported as failed, and the row says so too', async () => {
  const x = world()
  // Measured on 0.169.0: right after the change the history says interrupted, ~0.5 s later failed
  x.w.history = [{ id: 'turn-1', status: 'interrupted' }, { id: 'turn-1', status: 'failed' }]
  await x.notifier.onStatus(x.active())
  await x.notifier.onStatus(x.idle())
  assert.deepEqual(labels(x), [statusLabel('error')])
  assert.equal(x.rowStatus(), 'error', 'the list and the notification agree')
  assert.deepEqual(x.w.sleeps, [SETTLE_PAUSE_MS])
})

test('★ a turn that failed at a usage limit says "rate-limited" in the notification and the list (2026-11-26)', async () => {
  const x = world()
  // The shape a real failed turn has on 0.172.0 (`thread/turns/list`, itemsView notLoaded)
  const error = { message: "You've hit your usage limit.", codexErrorInfo: 'usageLimitExceeded', additionalDetails: null }
  x.w.history = [{ id: 'turn-1', status: 'interrupted' }, { id: 'turn-1', status: 'failed', error }]
  await x.notifier.onStatus(x.active())
  await x.notifier.onStatus(x.idle())
  assert.deepEqual(labels(x), [statusLabel('rate-limited')])
  assert.equal(x.rowStatus(), 'rate-limited', 'the list and the notification agree')
  // A re-read of the thread list keeps it; going active again (a retry after the reset) clears it
  x.w.book.upsert(raw())
  assert.equal(x.rowStatus(), 'rate-limited')
  x.w.history = [{ id: 'turn-2', status: 'completed' }]
  x.w.reads = 0
  await x.notifier.onStatus(x.active())
  assert.equal(x.rowStatus(), 'working')
  await x.notifier.onStatus(x.idle())
  assert.deepEqual(labels(x), [statusLabel('rate-limited'), statusLabel('done')])
  assert.equal(x.rowStatus(), 'done')
})

test('which errors are a limit: the plan and spend limits only; throttles, budgets, auth and connection errors stay "failed"', async () => {
  const cases: Array<[unknown, SessionStatus]> = [
    ['usageLimitExceeded', 'rate-limited'],
    ['apiKeySpendLimitExceeded', 'rate-limited'],
    ['projectSpendLimitExceeded', 'rate-limited'],
    ['organizationSpendLimitExceeded', 'rate-limited'],
    ['rateLimitExceeded', 'error'],
    ['sessionBudgetExceeded', 'error'],
    ['unauthorized', 'error'],
    ['serverOverloaded', 'error'],
    [{ responseTooManyFailedAttempts: { httpStatusCode: 429 } }, 'error'],
    [{ usageLimitExceeded: {} }, 'error'],
    [null, 'error'],
    [undefined, 'error'],
  ]
  for (const [info, want] of cases) {
    const x = world()
    x.w.history = [{ id: 'turn-1', status: 'failed', error: { message: 'm', ...(info === undefined ? {} : { codexErrorInfo: info }) } }]
    await x.notifier.onStatus(x.active())
    await x.notifier.onStatus(x.idle())
    assert.equal(x.rowStatus(), want, JSON.stringify(info))
    assert.deepEqual(labels(x), [statusLabel(want)], JSON.stringify(info))
  }
  // An interrupted turn carrying a limit error is still someone stopping it by hand: silent, plain idle
  const x = world()
  x.w.history = [{ id: 'turn-1', status: 'interrupted', error: { message: 'm', codexErrorInfo: 'usageLimitExceeded' } }]
  await x.notifier.onStatus(x.active())
  await x.notifier.onStatus(x.idle())
  assert.deepEqual(x.sent, [])
  assert.equal(x.rowStatus(), 'idle')
})

test('an interrupted turn sends nothing, after every read agreed, and the row is plain idle', async () => {
  const x = world()
  x.w.history = [{ id: 'turn-1', status: 'interrupted' }]
  await x.notifier.onStatus(x.active())
  await x.notifier.onStatus(x.idle())
  assert.deepEqual(x.sent, [])
  assert.equal(x.w.reads, SETTLE_TRIES, 'interrupted is believed only after all reads')
  assert.equal(x.rowStatus(), 'idle')
})

test('a turn that never settles (still inProgress, or unreadable) sends nothing', async () => {
  for (const history of [[{ id: 'turn-1', status: 'inProgress' }], [undefined], [{ id: 'turn-1', status: 'somethingNew' }]]) {
    const x = world()
    x.w.history = history
    await x.notifier.onStatus(x.active())
    await x.notifier.onStatus(x.idle())
    assert.deepEqual(x.sent, [], JSON.stringify(history))
    assert.equal(x.w.reads, SETTLE_TRIES)
    assert.ok(x.w.logs.some((l) => l.includes('did not settle')))
  }
})

test('waiting for approval sends "needs you" at once; the same wait is not sent twice', async () => {
  const x = world()
  x.w.history = [{ id: 'turn-1', status: 'inProgress' }]
  await x.notifier.onStatus(x.active())
  await x.notifier.onStatus(x.active('waitingOnApproval'))
  assert.deepEqual(labels(x), [statusLabel('waiting')])
  assert.deepEqual(x.w.sleeps, [], 'no settling for a wait')
  // The same state reported again (a second flag joins): same turn, same words
  await x.notifier.onStatus(x.active('waitingOnApproval', 'waitingOnUserInput'))
  assert.deepEqual(labels(x), [statusLabel('waiting')])
  // Answered, working again, then the turn completes
  await x.notifier.onStatus(x.active())
  x.w.history = [{ id: 'turn-1', status: 'completed' }]
  x.w.reads = 0
  await x.notifier.onStatus(x.idle())
  assert.deepEqual(labels(x), [statusLabel('waiting'), statusLabel('done')])
})

test('every turn gets its own "done" (the second turn is not swallowed as a repeat)', async () => {
  const x = world()
  for (const turn of ['turn-1', 'turn-2', 'turn-3']) {
    x.w.history = [{ id: turn, status: 'completed' }]
    x.w.reads = 0
    await x.notifier.onStatus(x.active())
    await x.notifier.onStatus(x.idle())
  }
  assert.deepEqual(labels(x), ['完了', '完了', '完了'])
})

test('a send that reached nobody is not remembered: the same state is sent again next time', async () => {
  const x = world()
  x.w.history = [{ id: 'turn-1', status: 'inProgress' }]
  x.w.devices = 0
  await x.notifier.onStatus(x.active('waitingOnApproval'))
  x.w.devices = 1
  await x.notifier.onStatus(x.active('waitingOnApproval', 'waitingOnUserInput'))
  assert.equal(x.sent.length, 2)
})

test('systemError: "failed" once the turn reads as ended, or after a few reads when it never does (rule 9)', async () => {
  const x = world()
  x.w.history = [{ id: 'turn-1', status: 'inProgress' }, { id: 'turn-1', status: 'failed', error: { message: 'm', codexErrorInfo: 'serverOverloaded' } }]
  await x.notifier.onStatus(x.active())
  await x.notifier.onStatus(x.set({ type: 'systemError' }))
  assert.deepEqual(labels(x), [statusLabel('error')])
  assert.deepEqual(x.w.sleeps, [SETTLE_PAUSE_MS])
  assert.equal(x.rowStatus(), 'error')
  // A turn that never reads as ended still says "failed" (the thread is in error whatever the turn says)
  const y = world()
  y.w.history = [{ id: 'turn-1', status: 'inProgress' }]
  await y.notifier.onStatus(y.active())
  await y.notifier.onStatus(y.set({ type: 'systemError' }))
  assert.deepEqual(labels(y), [statusLabel('error')])
  assert.equal(y.w.reads, SETTLE_TRIES)
})

test('★ systemError at a usage limit (how Codex 0.172.0 really ends such a turn): "rate-limited" in both places, once', async () => {
  const x = world()
  const error = { message: "You've hit your usage limit.", codexErrorInfo: 'usageLimitExceeded', additionalDetails: null }
  // The error arrives before the turn ends: the first read still says inProgress
  x.w.history = [{ id: 'turn-1', status: 'inProgress' }, { id: 'turn-1', status: 'failed', error }]
  await x.notifier.onStatus(x.active())
  await x.notifier.onStatus(x.set({ type: 'systemError' }))
  assert.deepEqual(labels(x), [statusLabel('rate-limited')])
  assert.equal(x.rowStatus(), 'rate-limited')
  // The same status said again, and a re-read of the list, change nothing and send nothing
  await x.notifier.onStatus(x.set({ type: 'systemError' }))
  x.w.book.upsert(raw({ status: { type: 'systemError' } }))
  assert.equal(x.rowStatus(), 'rate-limited')
  assert.deepEqual(labels(x), [statusLabel('rate-limited')])
  // A new turn (a retry after the reset) clears it
  await x.notifier.onStatus(x.active())
  assert.equal(x.rowStatus(), 'working')
})

test('two different turns of one thread that each hit the limit ring once each', async () => {
  const x = world()
  const error = { message: 'm', codexErrorInfo: 'usageLimitExceeded' }
  for (const id of ['turn-1', 'turn-2']) {
    x.w.history = [{ id, status: 'failed', error }]
    x.w.reads = 0
    await x.notifier.onStatus(x.active())
    await x.notifier.onStatus(x.set({ type: 'systemError' }))
  }
  assert.deepEqual(labels(x), [statusLabel('rate-limited'), statusLabel('rate-limited')])
})

test('★ systemError: an "interrupted" read on the way is not the end (a limit is still found, round 2 high)', async () => {
  const x = world()
  const error = { message: 'm', codexErrorInfo: 'usageLimitExceeded' }
  x.w.history = [{ id: 'turn-1', status: 'interrupted' }, { id: 'turn-1', status: 'failed', error }]
  await x.notifier.onStatus(x.active())
  await x.notifier.onStatus(x.set({ type: 'systemError' }))
  assert.deepEqual(labels(x), [statusLabel('rate-limited')])
  assert.equal(x.rowStatus(), 'rate-limited')
})

test('★ a reconnect whose read does not show the turn ended keeps a turn known as a limit "rate-limited" (round 3)', async () => {
  const x = world()
  const error = { message: 'm', codexErrorInfo: 'usageLimitExceeded' }
  x.w.history = [{ id: 'turn-1', status: 'failed', error }]
  await x.notifier.onStatus(x.active())
  await x.notifier.onStatus(x.set({ type: 'systemError' }))
  assert.deepEqual(labels(x), [statusLabel('rate-limited')])
  // A reconnect: a new book (the outcome is gone ⇒ the row says "failed"); the read sees the same turn, not ended yet
  x.w.book = new ThreadBook()
  x.w.book.upsert(raw({ status: { type: 'systemError' } }))
  assert.equal(x.rowStatus(), 'error')
  x.w.history = [{ id: 'turn-1', status: 'inProgress' }]
  x.w.reads = 0
  await x.notifier.onStatus(x.w.book.standing()[0]!)
  assert.deepEqual(labels(x), [statusLabel('rate-limited')], 'no second ring')
  assert.equal(x.rowStatus(), 'rate-limited', 'the known limit is put back on the row')
  // A different turn that fails while the reads say nothing still rings
  const y = world()
  y.w.history = [{ id: 'turn-1', status: 'failed', error }]
  await y.notifier.onStatus(y.active())
  await y.notifier.onStatus(y.set({ type: 'systemError' }))
  y.w.history = [{ id: 'turn-2', status: 'inProgress' }]
  y.w.reads = 0
  await y.notifier.onStatus(y.active())
  await y.notifier.onStatus(y.set({ type: 'systemError' }))
  assert.deepEqual(labels(y), [statusLabel('rate-limited'), statusLabel('error')])
})

test('★ systemError: a read that answers after a newer turn already failed does not speak; only the newer turn rings (round 5)', async () => {
  const x = world()
  x.w.history = [{ id: 'turn-A', status: 'failed', error: { message: 'm', codexErrorInfo: 'serverOverloaded' } }]
  x.w.duringRead = () => {
    // While A's read is out, turn B starts and fails at the limit
    x.w.duringRead = undefined
    x.active()
    x.set({ type: 'systemError' })
    x.w.history = [{ id: 'turn-B', status: 'failed', error: { message: 'm', codexErrorInfo: 'usageLimitExceeded' } }]
  }
  await x.notifier.onStatus(x.active())
  const a = x.notifier.onStatus(x.set({ type: 'systemError' }))
  await a
  await x.notifier.onStatus(x.w.book.standing()[0]!)
  assert.deepEqual(labels(x), [statusLabel('rate-limited')], 'nothing for A')
})

test('a rate-limited row that ended in idle is told by a reconnect like an "error" one (round 5)', async () => {
  const x = world()
  const error = { message: 'm', codexErrorInfo: 'usageLimitExceeded' }
  x.w.history = [{ id: 'turn-1', status: 'failed', error }]
  x.w.devices = 0
  await x.notifier.onStatus(x.active())
  await x.notifier.onStatus(x.idle())
  assert.equal(x.rowStatus(), 'rate-limited')
  x.w.devices = 1
  const standing = x.w.book.standing()
  assert.equal(standing.length, 1)
  await x.notifier.onStatus(standing[0]!)
  await x.notifier.onStatus(x.w.book.standing()[0]!)
  assert.deepEqual(labels(x), [statusLabel('rate-limited'), statusLabel('rate-limited')], 'the first reached nobody; told once more, then not again')
})

test('★ a read that fails keeps what the earlier reads said (a known limit turn is not lost to one missing answer, round 4)', async () => {
  const x = world()
  const error = { message: 'm', codexErrorInfo: 'usageLimitExceeded' }
  x.w.history = [{ id: 'turn-1', status: 'failed', error }]
  await x.notifier.onStatus(x.active())
  await x.notifier.onStatus(x.set({ type: 'systemError' }))
  // A reconnect: the same turn reads as not ended yet, then the last read gets no answer
  x.w.book = new ThreadBook()
  x.w.book.upsert(raw({ status: { type: 'systemError' } }))
  x.w.history = [{ id: 'turn-1', status: 'inProgress' }, undefined]
  x.w.reads = 0
  await x.notifier.onStatus(x.w.book.standing()[0]!)
  assert.equal(x.w.reads, 2, 'a read that gets no answer ends the loop (a hung daemon costs one timeout)')
  assert.deepEqual(labels(x), [statusLabel('rate-limited')], 'no second ring')
  assert.equal(x.rowStatus(), 'rate-limited')
})

test('★ quiet never swallows a new turn, and a read whose status moved stops at once (round 3 high, round 4)', async () => {
  const x = world()
  const error = { message: 'm', codexErrorInfo: 'usageLimitExceeded' }
  x.w.book.upsert(raw({ status: { type: 'systemError' } }))
  const startup = x.w.book.standing()[0]!
  // While the quiet read is out, a new turn starts and hits the limit at once
  x.w.history = [{ id: 'turn-1', status: 'inProgress' }, { id: 'turn-2', status: 'failed', error }]
  x.w.duringSleep = () => {
    x.w.duringSleep = undefined
    x.active()
    x.set({ type: 'systemError' })
  }
  await x.notifier.onStatus(startup, { quiet: true })
  assert.deepEqual(x.sent, [])
  assert.equal(x.w.reads, 1, 'no more reads once the status moved')
  await x.notifier.onStatus(x.w.book.standing()[0]!)
  assert.deepEqual(labels(x), [statusLabel('rate-limited')], 'the new turn rings')
})

test('★ quiet (the first connection): the words are settled, nothing is sent, nothing is counted as told (round 4)', async () => {
  const x = world()
  const error = { message: 'm', codexErrorInfo: 'usageLimitExceeded' }
  x.w.history = [{ id: 'turn-1', status: 'failed', error }]
  x.w.book.upsert(raw({ status: { type: 'systemError' } }))
  const standing = x.w.book.standing()
  assert.equal(standing.length, 1)
  await x.notifier.onStatus(standing[0]!, { quiet: true })
  assert.deepEqual(x.sent, [], 'quiet sends nothing')
  assert.equal(x.rowStatus(), 'rate-limited', 'but the list is right')
  // A reconnect feeds the standing rows again: told once (as "failed" was before), then not again
  await x.notifier.onStatus(x.w.book.standing()[0]!)
  await x.notifier.onStatus(x.w.book.standing()[0]!)
  assert.deepEqual(labels(x), [statusLabel('rate-limited')])
  // Not quiet: a standing limited row the notifier never told about is sent once
  const y = world()
  y.w.history = [{ id: 'turn-1', status: 'failed', error }]
  y.w.book.upsert(raw({ status: { type: 'systemError' } }))
  await y.notifier.onStatus(y.w.book.standing()[0]!)
  await y.notifier.onStatus(y.w.book.standing()[0]!)
  assert.deepEqual(labels(y), [statusLabel('rate-limited')])
})

test('idle without having been active (e.g. right after connecting) sends nothing', async () => {
  const x = world()
  x.book.upsert(raw({ id: 't1', status: { type: 'systemError' } }))
  x.w.history = [{ id: 'turn-0', status: 'completed' }]
  await x.notifier.onStatus(x.idle())
  assert.deepEqual(x.sent, [])
})

test('if a new turn has started by the time the old one is confirmed, nothing is sent for the old one', async () => {
  const x = world()
  x.w.history = [{ id: 'turn-1', status: 'completed' }]
  await x.notifier.onStatus(x.active())
  const ended = x.idle()
  // The user typed again before we handled the change
  x.active()
  await x.notifier.onStatus(ended)
  assert.deepEqual(x.sent, [], 'the row says working ⇒ "done" would contradict the list')
})

test('a thread that is no longer listed sends nothing', async () => {
  const x = world()
  x.w.history = [{ id: 'turn-1', status: 'completed' }]
  await x.notifier.onStatus(x.active())
  const ended = x.idle()
  x.book.close('t1')
  await x.notifier.onStatus(ended)
  assert.deepEqual(x.sent, [])
})

test('changes of one thread are handled in order, even when the first is still settling', async () => {
  const x = world()
  x.w.history = [{ id: 'turn-1', status: 'inProgress' }, { id: 'turn-1', status: 'inProgress' }, { id: 'turn-1', status: 'completed' }]
  await x.notifier.onStatus(x.active())
  const a = x.notifier.onStatus(x.idle())
  // Before `a` finishes, the next turn starts and asks for approval
  x.w.history.push({ id: 'turn-2', status: 'inProgress' })
  x.active()
  const b = x.notifier.onStatus(x.active('waitingOnApproval'))
  await Promise.all([a, b])
  // The old turn's "done" is dropped (the row had moved on); the wait is sent
  assert.deepEqual(labels(x), [statusLabel('waiting')])
})

test('two changes that end up describing the same turn produce one notification (handled one at a time)', async () => {
  const x = world()
  // Turn 1 ends; before its "done" is handled, turn 2 starts and ends too. Both changes then read "turn-2 completed".
  x.w.history = [{ id: 'turn-2', status: 'completed' }]
  x.active()
  const first = x.idle()
  x.active()
  const second = x.idle()
  await Promise.all([x.notifier.onStatus(first), x.notifier.onStatus(second)])
  // ⚠️ Handled concurrently, both would pass the "already sent?" check before either had sent
  assert.deepEqual(labels(x), ['完了'])
})

test('★ the payload: the real text builder; a prompt-derived title never reaches the notification', () => {
  const row: SessionSummary = {
    machine: 'pc-a', account: '.codex', tool: 'codex', sessionId: '01a1d8d9-66fc-7823-968f-c97d7234176e', cwd: '/home/user/proj', project: 'proj',
    title: 'please read ~/.ssh/id_rsa and fix it', titleSource: 'prompt', status: 'done', live: true, lastActivity: '2026-11-14T00:00:00.000Z', transcriptBytes: 0,
  }
  const fields: NotifyFields = { title: row.title, titleSource: row.titleSource, sessionId: row.sessionId, project: row.project, machine: row.machine, account: row.account, label: '完了' }
  const p = codexPayload(row, fields, '2026-11-14T00:00:00.000Z', toPushPayload)
  assert.ok(!JSON.stringify(p).includes('id_rsa'), 'what the user typed must not be in the notification')
  assert.deepEqual({ title: p.title, body: p.body }, notificationText(fields))
  // ★ One slot per thread: machine/account/thread id, no project (CLAUDE.md: the tag must not move)
  assert.equal(p.tag, 'pc-a/.codex/01a1d8d9-66fc-7823-968f-c97d7234176e')
  assert.equal(p.silent, undefined, '"done" rings')
  const named = codexPayload({ ...row, title: 'Fix login', titleSource: 'ai' }, { ...fields, title: 'Fix login', titleSource: 'ai' }, 'x', toPushPayload)
  assert.match(named.title, /Fix login/)
})

test('★ auto-approve on: "needs you" waits; an approval answered meanwhile sends nothing', async () => {
  const x = world()
  x.w.history = [{ id: 'turn-1', status: 'inProgress' }]
  x.w.auto = true
  await x.notifier.onStatus(x.active())
  // Auto-approve answers during the wait: the row is working again
  x.w.duringSleep = () => void x.book.setStatus('t1', { type: 'active', activeFlags: [] }, 2000)
  await x.notifier.onStatus(x.active('waitingOnApproval'))
  assert.deepEqual(x.w.sleeps, [AUTO_GRACE_MS])
  assert.deepEqual(labels(x), [])
})

test('auto-approve on: an approval it does not answer still sends "needs you", after the wait', async () => {
  const x = world()
  x.w.history = [{ id: 'turn-1', status: 'inProgress' }]
  x.w.auto = true
  await x.notifier.onStatus(x.active())
  await x.notifier.onStatus(x.active('waitingOnApproval'))
  assert.deepEqual(x.w.sleeps, [AUTO_GRACE_MS])
  assert.deepEqual(labels(x), [statusLabel('waiting')])
})

test('auto-approve on: when a newer change arrived during the wait, the old one stays silent (the newer one speaks)', async () => {
  const x = world()
  x.w.history = [{ id: 'turn-1', status: 'inProgress' }]
  x.w.auto = true
  await x.notifier.onStatus(x.active())
  let fed: Promise<void> | undefined
  x.w.duringSleep = () => {
    x.w.duringSleep = undefined
    // Answered, and the next command already waits: the row says "waiting" again, for a different approval
    x.active()
    fed = x.notifier.onStatus(x.active('waitingOnApproval', 'waitingOnUserInput'))
  }
  await x.notifier.onStatus(x.active('waitingOnApproval'))
  assert.deepEqual(labels(x), [], 'the first wait did not speak for the second')
  await fed
  assert.deepEqual(labels(x), [statusLabel('waiting')])
})

test('★ a late history answer about turn A does not land on turn B, and only B speaks (third review, medium #2)', async () => {
  const book = new ThreadBook()
  book.upsert(raw())
  const sent: string[] = []
  let releaseA!: () => void
  const aHeld = new Promise<void>((r) => (releaseA = r))
  let reads = 0
  let current = 'turn-A'
  const notifier = new CodexNotifier({
    row: (id) => book.rows({ machine: 'pc-a', account: '.codex', idPrefix: '' }).find((r) => r.sessionId === id),
    turns: async (): Promise<TurnsPage | undefined> => {
      reads++
      // A's first read: served while A was newest (failed), answered late
      if (reads === 1) {
        await aHeld
        return { turns: [{ id: 'turn-A', status: 'failed', items: [], skipped: 0 }], nextCursor: null, skipped: 0 }
      }
      return { turns: [{ id: current, status: 'completed', items: [], skipped: 0 }], nextCursor: null, skipped: 0 }
    },
    setOutcome: (id, outcome, mark) => void book.setOutcome(id, outcome, mark),
    mark: (id) => book.mark(id),
    send: async (_row, fields) => {
      sent.push(fields.label)
      return 1
    },
    sleep: async () => {},
  })
  const set = (status: Record<string, unknown>): Changed => {
    const c = book.setStatus('t1', status, 2000)
    assert.ok(c.type === 'changed')
    return c
  }
  void notifier.onStatus(set({ type: 'active', activeFlags: [] }))
  const a = notifier.onStatus(set({ type: 'idle' }))
  await new Promise((r) => setImmediate(r))
  // Turn B starts and completes while A's read is held
  current = 'turn-B'
  void notifier.onStatus(set({ type: 'active', activeFlags: [] }))
  const b = notifier.onStatus(set({ type: 'idle' }))
  releaseA()
  await a
  await b
  assert.deepEqual(sent, [statusLabel('done')], 'one "done" for B, no "failed" for A')
  assert.equal(book.rows({ machine: 'pc-a', account: '.codex', idPrefix: '' })[0]!.status, 'done')
})

test('a repeated idle notice during the settle does not drop the "done" (the mark stays for the same status)', async () => {
  const x = world()
  x.w.history = [{ id: 'turn-1', status: 'inProgress' }, { id: 'turn-1', status: 'completed' }]
  await x.notifier.onStatus(x.active())
  x.w.duringSleep = () => void x.book.setStatus('t1', { type: 'idle' }, 2001)
  await x.notifier.onStatus(x.idle())
  assert.deepEqual(labels(x), [statusLabel('done')])
})

test('★ an unreadable status while a turn settles: the read back keeps the mark, so "failed" still lands and is sent (fourth review, medium #2)', async () => {
  const x = world()
  x.w.history = [{ id: 'turn-1', status: 'interrupted' }, { id: 'turn-1', status: 'failed' }]
  await x.notifier.onStatus(x.active())
  x.w.duringSleep = () => {
    // During the settle: a status we cannot read, then the fresh read that says idle again
    x.book.setStatus('t1', { type: 'mystery' }, 2001)
    x.book.upsert(raw(), x.book.clock())
  }
  await x.notifier.onStatus(x.idle())
  assert.deepEqual(labels(x), [statusLabel('error')])
  assert.equal(x.rowStatus(), 'error')
})
