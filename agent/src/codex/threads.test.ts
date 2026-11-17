import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isUserThread, parseStatus, parseThread, statusOf, ThreadBook, titleOf, waitingForOf, type CodexThread } from './threads.ts'

/** The fields measured on codex-cli 0.169.0 for a plain TUI's main thread (values are examples) */
function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '01a1d8d9-66fc-7823-968f-c97d7234176e',
    sessionId: '01a1d8d9-66fc-7823-968f-c97d7234176e',
    forkedFromId: null,
    parentThreadId: null,
    preview: 'Fix the login bug\nand add a test',
    ephemeral: false,
    modelProvider: 'openai',
    model: 'gpt-x',
    createdAt: 1_794_640_000,
    updatedAt: 1_794_643_000,
    status: { type: 'idle' },
    path: '/home/user/.codex/sessions/x.jsonl',
    cwd: '/home/user/proj',
    cliVersion: '0.169.0',
    source: 'vscode',
    threadSource: 'user',
    gitInfo: { branch: 'main', sha: 'abc', originUrl: null },
    name: null,
    turns: [],
    ...over,
  }
}

const CTX = { machine: 'pc-a', account: '.codex', idPrefix: '' }

test('parseStatus: the four known types; unknown types and shapes are undefined, never idle', () => {
  assert.deepEqual(parseStatus({ type: 'idle' }), { type: 'idle' })
  assert.deepEqual(parseStatus({ type: 'notLoaded' }), { type: 'notLoaded' })
  assert.deepEqual(parseStatus({ type: 'systemError' }), { type: 'systemError' })
  assert.deepEqual(parseStatus({ type: 'active', activeFlags: [] }), {
    type: 'active',
    waitingOnApproval: false,
    waitingOnUserInput: false,
  })
  assert.deepEqual(parseStatus({ type: 'active', activeFlags: ['waitingOnApproval', 'somethingNew'] }), {
    type: 'active',
    waitingOnApproval: true,
    waitingOnUserInput: false,
  })
  for (const bad of [undefined, null, 'idle', {}, { type: 'paused' }, { type: 'active' }, { type: 'active', activeFlags: 'x' }, []]) {
    assert.equal(parseStatus(bad), undefined, JSON.stringify(bad))
  }
})

test('parseThread: a real-shaped thread parses; each broken required field refuses the whole thread', () => {
  const t = parseThread(raw())
  assert.ok(t)
  assert.equal(t.cwd, '/home/user/proj')
  assert.equal(t.gitBranch, 'main')
  assert.equal(t.cliVersion, '0.169.0')
  const broken: Array<Record<string, unknown>> = [
    { id: '' },
    { id: 7 },
    { cwd: 'relative/path' },
    { cwd: null },
    { updatedAt: '1794643000' },
    { updatedAt: Number.NaN },
    { ephemeral: 'false' },
    { status: { type: 'mystery' } },
    { status: undefined },
    { name: 42 },
    { threadSource: {} },
    { parentThreadId: 5 },
  ]
  for (const over of broken) assert.equal(parseThread(raw(over)), undefined, JSON.stringify(over))
  for (const notObject of [null, undefined, 'x', 1, []]) assert.equal(parseThread(notObject), undefined)
})

test('isUserThread: only threadSource "user" with no parent (source is not consulted)', () => {
  const t = (over: Record<string, unknown>): CodexThread => parseThread(raw(over))!
  assert.equal(isUserThread(t({})), true)
  assert.equal(isUserThread(t({ source: 'cli' })), true)
  assert.equal(isUserThread(t({ source: 'exec' })), true)
  // Measured: the internal title thread
  assert.equal(isUserThread(t({ threadSource: 'thread_title', ephemeral: true })), false)
  assert.equal(isUserThread(t({ threadSource: null })), false)
  assert.equal(isUserThread(t({ threadSource: 'something_new' })), false)
  assert.equal(isUserThread(t({ parentThreadId: 'parent' })), false)
})

test('titleOf: name is "ai", the first non-empty preview line is "prompt", otherwise the project', () => {
  const t = (over: Record<string, unknown>): CodexThread => parseThread(raw(over))!
  assert.deepEqual(titleOf(t({ name: 'Login bug fix' })), { title: 'Login bug fix', titleSource: 'ai' })
  assert.deepEqual(titleOf(t({})), { title: 'Fix the login bug', titleSource: 'prompt' })
  assert.deepEqual(titleOf(t({ preview: '\n\n  second line  \n' })), { title: 'second line', titleSource: 'prompt' })
  assert.deepEqual(titleOf(t({ preview: '' })), { title: 'proj', titleSource: 'fallback' })
  assert.deepEqual(titleOf(t({ preview: '', name: '' })), { title: 'proj', titleSource: 'fallback' })
  const long = titleOf(t({ preview: 'x'.repeat(500) }))
  assert.equal(long.title.length, 80)
  assert.ok(long.title.endsWith('…'))
})

test('statusOf: idle is "done" only when this connection saw the thread active', () => {
  const active = (a: boolean, u: boolean) => ({ type: 'active' as const, waitingOnApproval: a, waitingOnUserInput: u })
  assert.equal(statusOf({ type: 'idle' }, false), 'idle')
  assert.equal(statusOf({ type: 'idle' }, true), 'done')
  assert.equal(statusOf(active(false, false), false), 'working')
  assert.equal(statusOf(active(true, false), true), 'waiting')
  assert.equal(statusOf(active(false, true), true), 'waiting')
  assert.equal(statusOf({ type: 'systemError' }, true), 'error')
  assert.equal(statusOf({ type: 'notLoaded' }, true), 'unknown')
})

test('waitingForOf: the reason a Codex row waits, in the CLI words (approval wins when both flags are up)', () => {
  const active = (flags: string[]) => ({ type: 'active', activeFlags: flags })
  const book = new ThreadBook()
  book.upsert(raw({ id: 'a', status: active(['waitingOnApproval']) }))
  book.upsert(raw({ id: 'q', status: active(['waitingOnUserInput']) }))
  book.upsert(raw({ id: 'b', status: active(['waitingOnUserInput', 'waitingOnApproval']) }))
  book.upsert(raw({ id: 'w', status: active([]) }))
  book.upsert(raw({ id: 'i' }))
  const by = new Map(book.rows(CTX).map((r) => [r.sessionId, r]))
  assert.equal(by.get('a')!.waitingFor, 'permission prompt')
  assert.equal(by.get('q')!.waitingFor, 'input needed')
  assert.equal(by.get('b')!.waitingFor, 'permission prompt')
  assert.equal(by.get('w')!.status, 'working')
  assert.ok(!('waitingFor' in by.get('w')!), 'no reason is invented while it works')
  assert.ok(!('waitingFor' in by.get('i')!))
  assert.equal(waitingForOf({ type: 'idle' }), undefined)
  assert.equal(waitingForOf({ type: 'notLoaded' }), undefined)
})

test('book: rows carry tool "codex", never the rollout path, and are ordered by activity', () => {
  const book = new ThreadBook()
  assert.equal(book.upsert(raw({ id: 'old', updatedAt: 100 })), true)
  assert.equal(book.upsert(raw({ id: 'new', updatedAt: 200, name: 'Named' })), true)
  const rows = book.rows(CTX)
  assert.deepEqual(
    rows.map((r) => r.sessionId),
    ['new', 'old'],
  )
  const r = rows[0]!
  assert.equal(r.tool, 'codex')
  assert.equal(r.machine, 'pc-a')
  assert.equal(r.account, '.codex')
  assert.equal(r.project, 'proj')
  assert.equal(r.live, true)
  assert.equal(r.status, 'idle')
  assert.equal(r.titleSource, 'ai')
  assert.equal(r.gitBranch, 'main')
  assert.equal(r.lastActivity, new Date(200_000).toISOString())
  assert.ok(!JSON.stringify(rows).includes('.jsonl'), 'the path on disk must not reach the wire')
})

test('book: internal, unknown-source and unparsable threads are hidden and counted', () => {
  const book = new ThreadBook()
  assert.equal(book.upsert(raw({ id: 'title', threadSource: 'thread_title', ephemeral: true })), false)
  assert.equal(book.upsert(raw({ id: 'future', threadSource: 'something_new' })), false)
  assert.equal(book.upsert(raw({ id: 'sub', parentThreadId: 'p' })), false)
  assert.equal(book.upsert({ id: 'broken' }), false)
  assert.deepEqual(book.rows(CTX), [])
  assert.deepEqual(book.diagnostics(), { hidden: { thread_title: 1, something_new: 1, user: 1 }, unparsed: 1 })
  // A status change for a hidden thread is ignored, not "unknown" (the caller must not re-read it forever)
  assert.deepEqual(book.setStatus('title', { type: 'idle' }, 1), { type: 'ignored' })
})

test('book: a thread that is already idle is "idle"; active → idle seen live is "done"; a new turn clears it', () => {
  const book = new ThreadBook()
  book.upsert(raw({ id: 't' }))
  assert.equal(book.rows(CTX)[0]!.status, 'idle')

  let c = book.setStatus('t', { type: 'active', activeFlags: [] }, 10)
  assert.ok(c.type === 'changed')
  assert.deepEqual([c.from, c.to], ['idle', 'working'])

  c = book.setStatus('t', { type: 'active', activeFlags: ['waitingOnApproval'] }, 11)
  assert.ok(c.type === 'changed')
  assert.deepEqual([c.from, c.to], ['working', 'waiting'])

  c = book.setStatus('t', { type: 'idle' }, 12)
  assert.ok(c.type === 'changed')
  assert.deepEqual([c.from, c.to], ['waiting', 'done'])
  assert.equal(book.rows(CTX)[0]!.status, 'done')

  c = book.setStatus('t', { type: 'active', activeFlags: [] }, 13)
  assert.ok(c.type === 'changed')
  assert.deepEqual([c.from, c.to], ['done', 'working'])

  c = book.setStatus('t', { type: 'systemError' }, 14)
  assert.ok(c.type === 'changed')
  assert.equal(c.to, 'error')
})

test('book: a thread first seen active becomes "done" when it goes idle', () => {
  const book = new ThreadBook()
  book.upsert(raw({ id: 't', status: { type: 'active', activeFlags: [] } }))
  assert.equal(book.rows(CTX)[0]!.status, 'working')
  book.setStatus('t', { type: 'idle' }, 1)
  assert.equal(book.rows(CTX)[0]!.status, 'done')
})

test('book: a re-read of the same thread keeps what this connection saw', () => {
  const book = new ThreadBook()
  book.upsert(raw({ id: 't', status: { type: 'active', activeFlags: [] } }))
  book.upsert(raw({ id: 't', status: { type: 'idle' }, name: 'Now named' }))
  const r = book.rows(CTX)[0]!
  assert.equal(r.status, 'done')
  assert.equal(r.title, 'Now named')
})

test('book: reset forgets what the old connection saw (an idle thread after reconnect is not "done")', () => {
  const book = new ThreadBook()
  book.upsert(raw({ id: 't', status: { type: 'active', activeFlags: [] } }))
  book.reset()
  assert.deepEqual(book.rows(CTX), [])
  book.upsert(raw({ id: 't', status: { type: 'idle' } }))
  assert.equal(book.rows(CTX)[0]!.status, 'idle')
})

test('book: status for a thread the book does not know asks the caller to read it', () => {
  const book = new ThreadBook()
  assert.deepEqual(book.setStatus('nope', { type: 'idle' }, 1), { type: 'unknown-thread' })
  assert.deepEqual(book.setStatus(42, { type: 'idle' }, 1), { type: 'ignored' })
})

test('★ book: an unreadable status takes away sending, and only that, until a fresh read (third review, medium #1)', () => {
  for (const bad of [{ type: 'mystery' }, { type: 'active' }, null]) {
    const book = new ThreadBook()
    book.upsert(raw({ id: 't', status: { type: 'idle' } }))
    assert.equal(book.acceptsInput('t'), true)
    const mark = book.mark('t')
    const c = book.setStatus('t', bad, 1)
    assert.equal(c.type, 'unreadable', JSON.stringify(bad))
    assert.equal(book.acceptsInput('t'), false, 'an idle row we can no longer read is not sendable')
    // ⚠️ Nothing else moves (fourth review, medium #1–#2): the row, its mark
    assert.equal(book.rows(CTX)[0]!.status, 'idle')
    assert.equal(book.mark('t'), mark)
    // ★ A fresh read (started after the unreadable notice) is what gives sending back
    const at = book.clock()
    assert.equal(book.upsert(raw({ id: 't', status: { type: 'idle' } }), at), true)
    assert.equal(book.acceptsInput('t'), true)
    assert.equal(book.mark('t'), mark, 'the same status read back keeps the mark (the notifier still settles)')
  }
})

test('book: while unsure, a waiting thread still waits (its card stays), and a stale read does not give sending back', () => {
  const book = new ThreadBook()
  book.upsert(raw({ id: 't', status: { type: 'active', activeFlags: ['waitingOnApproval'] } }))
  book.setStatus('t', { type: 'mystery' }, 1)
  assert.equal(book.waitsOnApproval('t'), true, 'nothing gives a withdrawn card back, so it is not withdrawn')
  const u = new ThreadBook()
  u.upsert(raw({ id: 't', status: { type: 'idle' } }))
  const before = u.clock()
  u.setStatus('t', { type: 'mystery' }, 1)
  // A read that started before the unreadable notice keeps the row unsure
  u.upsert(raw({ id: 't', status: { type: 'idle' } }), before)
  assert.equal(u.acceptsInput('t'), false)
  // A readable status does
  u.setStatus('t', { type: 'idle' }, 2)
  assert.equal(u.acceptsInput('t'), true)
})

test('book: a readable status after an unreadable one is a normal change, "from" the last status we could read', () => {
  const book = new ThreadBook()
  book.upsert(raw({ id: 't', status: { type: 'active', activeFlags: [] } }))
  book.setStatus('t', { type: 'mystery' }, 1)
  const c = book.setStatus('t', { type: 'idle' }, 2)
  assert.ok(c.type === 'changed')
  assert.equal(c.from, 'working', 'the turn that was running is not forgotten (the notifier still says "done")')
  assert.equal(c.to, 'done')
  assert.equal(book.acceptsInput('t'), true)
})

test('book: an unreadable status for a thread we do not list is still just ignored', () => {
  const book = new ThreadBook()
  assert.deepEqual(book.setStatus('nope', { type: 'mystery' }, 1), { type: 'unknown-thread' })
})

test('★ book: an outcome lands only on the status it was settled for (third review, medium #2)', () => {
  const book = new ThreadBook()
  book.upsert(raw({ id: 't', status: { type: 'active', activeFlags: [] } }))
  const a = book.setStatus('t', { type: 'idle' }, 1)
  assert.ok(a.type === 'changed')
  // Turn B starts and ends while A's history is being read
  book.setStatus('t', { type: 'active', activeFlags: [] }, 2)
  const b = book.setStatus('t', { type: 'idle' }, 3)
  assert.ok(b.type === 'changed')
  assert.notEqual(a.mark, b.mark)
  assert.equal(book.setOutcome('t', 'failed', a.mark), false, "A's late answer is refused")
  assert.equal(book.rows(CTX)[0]!.status, 'done', 'B stays done')
  assert.equal(book.setOutcome('t', 'failed', b.mark), true)
  assert.equal(book.rows(CTX)[0]!.status, 'error')
})

test('book: the mark stays when the same status is said again or a read (a rename) repeats it', () => {
  const book = new ThreadBook()
  book.upsert(raw({ id: 't', status: { type: 'active', activeFlags: [] } }))
  const a = book.setStatus('t', { type: 'idle' }, 1)
  assert.ok(a.type === 'changed')
  const again = book.setStatus('t', { type: 'idle' }, 2)
  assert.ok(again.type === 'changed')
  assert.equal(again.mark, a.mark)
  book.upsert(raw({ id: 't', name: 'Renamed', status: { type: 'idle' } }), book.clock())
  assert.equal(book.mark('t'), a.mark)
  assert.equal(book.setOutcome('t', 'failed', a.mark), true)
  // ⚠️ A mark never comes back after a reconnect (a new entry of the same thread gets a new one)
  book.reset()
  book.upsert(raw({ id: 't', status: { type: 'idle' } }))
  assert.notEqual(book.mark('t'), a.mark)
})

test('book: notLoaded and thread/closed remove the row', () => {
  const book = new ThreadBook()
  book.upsert(raw({ id: 'a' }))
  book.upsert(raw({ id: 'b' }))
  const c = book.setStatus('a', { type: 'notLoaded' }, 1)
  assert.ok(c.type === 'changed')
  assert.equal(c.to, 'unknown')
  book.close('b')
  book.close(123)
  assert.deepEqual(book.rows(CTX), [])
  // A read that says notLoaded does not create a row either
  assert.equal(book.upsert(raw({ id: 'c', status: { type: 'notLoaded' } })), false)
  assert.deepEqual(book.rows(CTX), [])
})

test('book: updatedAt moves forward on a status change and never backward', () => {
  const book = new ThreadBook()
  book.upsert(raw({ id: 't', updatedAt: 500 }))
  book.setStatus('t', { type: 'active', activeFlags: [] }, 400)
  assert.equal(book.rows(CTX)[0]!.lastActivity, new Date(500_000).toISOString())
  book.setStatus('t', { type: 'idle' }, 600)
  assert.equal(book.rows(CTX)[0]!.lastActivity, new Date(600_000).toISOString())
})

// ── codex review (2026-11-15) ────────────────────────────────────────────────────────────────────────────────

const PCTX = { machine: 'pc-a', account: '.codex', idPrefix: 'codex-00000000-' }

test('★ a time a Date cannot hold is not a thread, and the list still builds (medium #8)', () => {
  for (const updatedAt of [1e100, -1e100, 8.64e12 + 1]) assert.equal(parseThread(raw({ updatedAt })), undefined, String(updatedAt))
  assert.ok(parseThread(raw({ updatedAt: 8.64e12 })), 'the largest valid time')
  const book = new ThreadBook()
  assert.equal(book.upsert(raw({ id: 'bad', updatedAt: 1e100 })), false)
  assert.equal(book.upsert(raw({ id: 'good' })), true)
  assert.deepEqual(book.rows(PCTX).map((r) => r.sessionId), ['codex-00000000-good'])
})

test('★ a read that started before a status change keeps the newer status and takes the metadata (high #2)', () => {
  const book = new ThreadBook()
  book.upsert(raw({ id: 't' }))
  const stamp = book.clock()
  book.setStatus('t', { type: 'active', activeFlags: [] }, 1)
  // The read was served while the thread was still idle
  assert.equal(book.upsert(raw({ id: 't', name: 'renamed', status: { type: 'idle' } }), stamp), true)
  const row = book.rows(PCTX)[0]!
  assert.equal(row.title, 'renamed')
  assert.equal(row.status, 'working')
  assert.equal(book.acceptsInput('t'), false)
  // A read that started after the change is news
  const later = book.clock()
  book.upsert(raw({ id: 't', status: { type: 'idle' } }), later)
  assert.equal(book.acceptsInput('t'), true)
})

test('a read that started before thread/closed does not bring the row back; thread/started does', () => {
  const book = new ThreadBook()
  book.upsert(raw({ id: 't' }))
  const stamp = book.clock()
  book.close('t')
  assert.equal(book.upsert(raw({ id: 't' }), stamp), false)
  assert.deepEqual(book.rows(PCTX), [])
  assert.equal(book.upsert(raw({ id: 't' })), true, 'the daemon loads it again')
})

test('a read for a thread we did not list yet is stale if a status change for it arrived meanwhile', () => {
  const book = new ThreadBook()
  const stamp = book.clock()
  assert.deepEqual(book.setStatus('t', { type: 'active', activeFlags: [] }, 1), { type: 'unknown-thread' })
  assert.equal(book.upsert(raw({ id: 't' }), stamp), false, 'a newer read follows')
})

test('standing: rows that wait or failed, as changes from unknown', () => {
  const book = new ThreadBook()
  book.upsert(raw({ id: 'w', status: { type: 'active', activeFlags: ['waitingOnApproval'] } }))
  book.upsert(raw({ id: 'e', status: { type: 'systemError' } }))
  book.upsert(raw({ id: 'i' }))
  book.upsert(raw({ id: 'a', status: { type: 'active', activeFlags: [] } }))
  const s = book.standing().map((c) => [c.thread.id, c.from, c.to])
  assert.deepEqual(s.sort(), [['e', 'unknown', 'error'], ['w', 'unknown', 'waiting']])
})

test('★ forgetting old events does not make an old read look fresh (second review, medium #3)', () => {
  const book = new ThreadBook()
  book.upsert(raw({ id: 'T' }))
  const stamp = book.clock()
  book.close('T')
  // A flood of events for other threads pushes T's tombstone out
  for (let i = 0; i < 2500; i++) book.setStatus(`other-${i}`, { type: 'idle' }, 1)
  assert.equal(book.upsert(raw({ id: 'T' }), stamp), false)
  assert.equal(book.isRow('T'), false)
  // A read that started after the flood is news
  assert.equal(book.upsert(raw({ id: 'T' }), book.clock()), true)
})

test('book: the rollout path stays on the agent — given per row id for the context chip, never on a row', () => {
  const book = new ThreadBook()
  book.upsert(raw({ id: 't1' }))
  book.upsert(raw({ id: 't2', path: null }))
  const ctx = { ...CTX, idPrefix: 'codex:' }
  assert.deepEqual([...book.rolloutPaths(ctx)], [['codex:t1', '/home/user/.codex/sessions/x.jsonl']])
  assert.ok(!JSON.stringify(book.rows(ctx)).includes('.jsonl'))
})
