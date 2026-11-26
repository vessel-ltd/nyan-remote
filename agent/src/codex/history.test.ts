import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { LogEntry } from '../../../shared/types.ts'
import {
  EPOCH_STEP,
  itemEntries,
  JOURNAL_MAX,
  newEpoch,
  parseTurn,
  parseTurnsPage,
  ThreadJournal,
  turnEndEntry,
  turnsToEntries,
  type CodexTurn,
} from './history.ts'

/** ★ Real payloads from codex-cli 0.169.0 (see the `note` in the file). Not hand-written. */
const FIX = JSON.parse(readFileSync(new URL('./fixtures/history-0.169.0.json', import.meta.url), 'utf8')) as {
  exchanges: Record<string, { request: { params: Record<string, unknown> }; response: { result: unknown } }>
}
const page = (name: string) => parseTurnsPage(FIX.exchanges[name]!.response.result)!

const kinds = (entries: LogEntry[]): string[] => entries.map((e) => e.kind)

test('real pages parse: four turns, newest first, with the statuses the lab produced', () => {
  const p1 = page('turns_desc_full_page1')
  const p2 = page('turns_desc_full_page2')
  assert.deepEqual([...p1.turns, ...p2.turns].map((t) => t.status), ['failed', 'interrupted', 'completed', 'completed'])
  assert.equal(p1.skipped + p2.skipped, 0)
  // The cursor is passed back verbatim: page 2 was requested with exactly page 1's nextCursor
  assert.equal(typeof p1.nextCursor, 'string')
  assert.equal(FIX.exchanges['turns_desc_full_page2']!.request.params['cursor'], p1.nextCursor)
  assert.equal(p2.nextCursor, null)
})

test('real turns become entries: user, assistant, the command with its result, the closing lines', () => {
  const turns = [...page('turns_desc_full_page1').turns, ...page('turns_desc_full_page2').turns].reverse()
  const entries = turnsToEntries(turns)
  assert.deepEqual(kinds(entries), [
    // accept: user → commentary → command (+ result) → final answer
    'user', 'assistant', 'tool_use', 'tool_result', 'assistant',
    // decline: the declined command leaves no item
    'user', 'assistant', 'assistant',
    // interrupted
    'user', 'system',
    // failed
    'user', 'system',
  ])
  const use = entries[2]
  const result = entries[3]
  assert.ok(use?.kind === 'tool_use' && result?.kind === 'tool_result')
  assert.equal(use.name, 'command')
  assert.match(use.summary, /printf 'SYNTHETIC_COMMAND_OUTPUT/)
  assert.equal(result.forId, use.id, 'the result is paired with its command')
  assert.equal(result.ok, true)
  assert.equal(result.summary, 'SYNTHETIC_COMMAND_OUTPUT')
  assert.deepEqual(entries[0], { kind: 'user', at: entries[0]!.at, text: 'SYNTHETIC_USER_accept' })
  assert.match(String(entries[0]!.at), /^\d{4}-\d\d-\d\dT/)
  const failed = entries.at(-1)
  assert.ok(failed?.kind === 'system')
  assert.match(failed.text, /^Turn failed: /)
  assert.deepEqual(entries[9]?.kind === 'system' && entries[9].text, 'Turn interrupted')
})

test('a metadata-only page (itemsView notLoaded) parses to turns without items, not to an error', () => {
  const p = page('turns_desc_notLoaded_page1')
  assert.ok(p.turns.length > 0)
  assert.ok(p.turns.every((t) => t.items.length === 0))
})

function turn(id: string, status: string | undefined, items: Array<Record<string, unknown>>, over: Record<string, unknown> = {}): CodexTurn {
  return parseTurn({ id, status, items, error: null, ...over })!
}
const user = (id: string, text: string, done = true) => ({ type: 'userMessage', id, content: [{ type: 'text', text }], startedAtMs: 1000, ...(done ? { completedAtMs: 1000 } : {}) })
const agent = (id: string, text: string, done = true) => ({ type: 'agentMessage', id, text, ...(done ? { completedAtMs: 2000 } : {}) })
const cmd = (id: string, over: Record<string, unknown> = {}) => ({ type: 'commandExecution', id, command: 'ls', status: 'completed', aggregatedOutput: 'a\nb\n', exitCode: 0, completedAtMs: 3000, ...over })

test('parse: a failed turn with a plan or spend limit error is `limited`; nothing else is (2026-11-26)', () => {
  const t = (status: string, err: unknown) => parseTurn({ id: 't', status, items: [], error: err })!
  assert.equal(t('failed', { message: 'm', codexErrorInfo: 'usageLimitExceeded' }).limited, true)
  assert.equal(t('failed', { message: '', codexErrorInfo: 'organizationSpendLimitExceeded' }).limited, true, 'the message is not needed')
  assert.equal(t('interrupted', { message: 'm', codexErrorInfo: 'usageLimitExceeded' }).limited, undefined)
  assert.equal(t('failed', { message: 'm', codexErrorInfo: 'rateLimitExceeded' }).limited, undefined)
  assert.equal(t('failed', { message: 'm', codexErrorInfo: { usageLimitExceeded: null } }).limited, undefined)
  assert.equal(t('failed', 'usageLimitExceeded').limited, undefined)
  assert.equal(t('failed', null).limited, undefined)
})

test('parse: hostile shapes are skipped and counted, never thrown', () => {
  for (const bad of [null, 'x', [], {}, { id: 't' }, { id: '', items: [] }, { id: 5, items: [] }, { id: 't', items: 'x' }]) {
    assert.equal(parseTurn(bad), undefined, JSON.stringify(bad))
  }
  const t = parseTurn({ id: 't', status: 'weird', items: [null, 'x', {}, { id: 'a' }, { type: 'x' }, { id: '', type: 'x' }, user('u', 'hi')] })!
  assert.equal(t.status, undefined)
  assert.equal(t.items.length, 1)
  assert.equal(t.skipped, 6)
  for (const bad of [null, {}, { data: 'x' }]) assert.equal(parseTurnsPage(bad), undefined)
  const p = parseTurnsPage({ data: [null, { id: 't', items: [] }], nextCursor: 42 })!
  assert.equal(p.turns.length, 1)
  assert.equal(p.skipped, 1)
  assert.equal(p.nextCursor, null, 'a cursor that is not a string is "no more", not something to pass back')
})

test('items: a failed command is not ok; an unfinished one has no result; missing output still says how it ended', () => {
  const e = (raw: Record<string, unknown>) => itemEntries(parseTurn({ id: 't', items: [raw] })!.items[0]!)
  const failed = e(cmd('c', { exitCode: 2, aggregatedOutput: 'boom' }))
  assert.equal(failed[1]?.kind === 'tool_result' && failed[1].ok, false)
  const declinedLike = e(cmd('c', { status: 'declined', exitCode: null, aggregatedOutput: null }))
  assert.ok(declinedLike[1]?.kind === 'tool_result')
  assert.equal(declinedLike[1].ok, false)
  assert.equal(declinedLike[1].summary, '(declined)')
  assert.deepEqual(kinds(e(cmd('c', { status: 'inProgress', exitCode: null, completedAtMs: undefined }))), ['tool_use'])
  const silent = e(cmd('c', { aggregatedOutput: '' }))
  assert.equal(silent[1]?.kind === 'tool_result' && silent[1].summary, '(exit 0)')
  // ⚠️ exit 0 with a non-completed status is not a success
  assert.equal((e(cmd('c', { status: 'failed' }))[1] as { ok: boolean }).ok, false)
})

test('items: non-text user input is named, empty messages produce nothing, reasoning shows only a summary', () => {
  const e = (raw: Record<string, unknown>) => itemEntries(parseTurn({ id: 't', items: [raw] })!.items[0]!)
  assert.deepEqual(e({ type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'look' }, { type: 'image', url: 'data:…' }] }), [
    { kind: 'user', text: 'look\n[image]' },
  ])
  assert.deepEqual(e({ type: 'userMessage', id: 'u', content: 'nope' }), [])
  assert.deepEqual(e({ type: 'agentMessage', id: 'a', text: '   ' }), [])
  assert.deepEqual(e({ type: 'reasoning', id: 'r', summary: [], content: ['secret chain'] }), [])
  assert.deepEqual(e({ type: 'reasoning', id: 'r', summary: ['Plan the fix'] }), [{ kind: 'thinking', text: 'Plan the fix' }])
})

test('items: an unknown type becomes one folded line naming the type, without dumping the object', () => {
  const e = (raw: Record<string, unknown>) => itemEntries(parseTurn({ id: 't', items: [raw] })!.items[0]!)
  const web = e({ type: 'webSearch', id: 'w', query: 'node uds websocket', results: [{ huge: 'x'.repeat(5000) }] })
  assert.deepEqual(web, [{ kind: 'tool_use', name: 'webSearch', id: 'w', summary: 'node uds websocket', lines: 1, truncated: false }])
  const future = e({ type: 'somethingFromNextYear', id: 'f', payload: { a: 1 } })
  assert.deepEqual(future, [{ kind: 'tool_use', name: 'somethingFromNextYear', id: 'f', summary: '', lines: 0, truncated: false }])
})

test('long text is cut, and says so for tool output', () => {
  const e = (raw: Record<string, unknown>) => itemEntries(parseTurn({ id: 't', items: [raw] })!.items[0]!)
  const out = e(cmd('c', { aggregatedOutput: 'x'.repeat(10_000) }))[1]
  assert.ok(out?.kind === 'tool_result')
  assert.equal(out.truncated, true)
  assert.equal(out.summary.length, 4000)
  const msg = e(agent('a', 'y'.repeat(50_000)))[0]
  assert.ok(msg?.kind === 'assistant')
  assert.equal(msg.text.length, 20_000)
})

test('turnEndEntry: nothing for a normal end or a running turn', () => {
  assert.equal(turnEndEntry(turn('t', 'completed', [])), undefined)
  assert.equal(turnEndEntry(turn('t', 'inProgress', [])), undefined)
  assert.equal(turnEndEntry(turn('t', undefined, [])), undefined)
  assert.deepEqual(turnEndEntry(turn('t', 'failed', [])), { kind: 'system', text: 'Turn failed' })
})

test('journal: the real streaming turn shows only what is recorded, then the rest exactly once', () => {
  const j = new ThreadJournal(newEpoch(1_794_647_317_000))
  // Real: a turn in progress whose only recorded item is the user message
  const streaming = page('streaming_turn').turns
  assert.equal(j.ingest(streaming), 1)
  assert.deepEqual(kinds(j.all()), ['user'])
  const mark = j.tail
  // Same again: nothing new
  assert.equal(j.ingest(streaming), 0)
  // Later the same turn is over (interrupted) — from the real final pages
  const final = [...page('turns_desc_full_page1').turns].reverse().filter((t) => t.id === streaming[0]!.id)
  assert.equal(final.length, 1)
  assert.equal(j.ingest(final), 1)
  assert.deepEqual(kinds(j.since(mark)!), ['system'])
  assert.equal(j.ingest(final), 0, 'the closing line is added once')
})

test('journal: an unfinished item holds back the items after it, so the order shown is the order recorded', () => {
  const j = new ThreadJournal(EPOCH_STEP)
  const running = turn('t', 'inProgress', [user('u', 'go'), cmd('c', { status: 'inProgress', completedAtMs: undefined }), agent('a', 'after')])
  assert.equal(j.ingest([running]), 1)
  assert.deepEqual(kinds(j.all()), ['user'])
  const done = turn('t', 'completed', [user('u', 'go'), cmd('c'), agent('a', 'after')])
  j.ingest([done])
  assert.deepEqual(kinds(j.all()), ['user', 'tool_use', 'tool_result', 'assistant'])
})

test('journal: when the turn is over, items without a completion time are shown as they are', () => {
  const j = new ThreadJournal(EPOCH_STEP)
  j.ingest([turn('t', 'interrupted', [user('u', 'go', false), agent('a', 'partial', false)])])
  assert.deepEqual(kinds(j.all()), ['user', 'assistant', 'system'])
})

test('journal: a turn with a status this version does not know is treated as still running', () => {
  const j = new ThreadJournal(EPOCH_STEP)
  j.ingest([turn('t', 'paused', [user('u', 'go'), agent('a', 'x', false)])])
  assert.deepEqual(kinds(j.all()), ['user'])
})

const HALF = EPOCH_STEP / 2

test('journal: positions — follow and scroll-back are stable; other journals and nonsense are "not ours"', () => {
  const j = new ThreadJournal(5 * EPOCH_STEP)
  j.ingest([turn('t', 'completed', [user('u', 'a'), agent('x', 'b'), agent('y', 'c')])])
  const start = 5 * EPOCH_STEP + HALF
  assert.equal(j.front, start)
  assert.equal(j.tail, start + 3)
  assert.deepEqual(kinds(j.since(start)!), ['user', 'assistant', 'assistant'])
  assert.deepEqual(kinds(j.since(start + 1)!), ['assistant', 'assistant'])
  assert.deepEqual(j.since(j.tail), [])
  assert.deepEqual(j.latest(2), { entries: j.all().slice(1), from: start + 1 })
  assert.deepEqual(j.before(start + 1, 5), { entries: j.all().slice(0, 1), from: start })
  assert.deepEqual(j.before(j.tail, 2), { entries: j.all().slice(1), from: start + 1 })
  assert.deepEqual(j.before(start, 5), { entries: [], from: start })
  for (const bad of [j.tail + 1, 4 * EPOCH_STEP + HALF, 6 * EPOCH_STEP, 0, start + 0.5, Number.NaN]) {
    assert.equal(j.since(bad), undefined, `since ${bad}`)
    assert.equal(j.before(bad, 5), undefined, `before ${bad}`)
  }
})

test('journal: older turns go in front, positions of what was already shown do not move', () => {
  const j = new ThreadJournal(EPOCH_STEP)
  j.ingest([turn('new', 'completed', [user('u2', 'second'), agent('a2', 'reply2')])])
  const tail = j.tail
  const shownFrom = j.front
  assert.equal(j.prepend([turn('old', 'completed', [user('u1', 'first'), agent('a1', 'reply1')])]), 2)
  assert.equal(j.tail, tail)
  assert.equal(j.front, shownFrom - 2)
  assert.deepEqual(j.before(shownFrom, 10)!.entries.map((e) => (e.kind === 'user' || e.kind === 'assistant' ? e.text : '')), ['first', 'reply1'])
  // The same older turns again add nothing (no duplicates)
  assert.equal(j.prepend([turn('old', 'completed', [user('u1', 'first'), agent('a1', 'reply1')])]), 0)
  assert.equal(j.length, 4)
})

test('journal: bounded; positions stay valid after the front is dropped; no prepend after that', () => {
  const j = new ThreadJournal(EPOCH_STEP)
  const many = Array.from({ length: JOURNAL_MAX + 50 }, (_, i) => user(`u${i}`, `m${i}`))
  j.ingest([turn('t', 'completed', many)])
  assert.equal(j.length, JOURNAL_MAX)
  assert.equal(j.trimmed, true)
  assert.equal(j.tail, EPOCH_STEP + HALF + JOURNAL_MAX + 50)
  const last = j.since(j.tail - 1)!
  assert.deepEqual(last, [{ kind: 'user', at: last[0]!.at, text: `m${JOURNAL_MAX + 49}` }])
  // A position that pointed into the dropped part gets everything still held (the reader lost nothing we still have)
  assert.equal(j.since(EPOCH_STEP + HALF + 10)!.length, JOURNAL_MAX)
  assert.equal(j.prepend([turn('old', 'completed', [user('o', 'x')])]), -1)
})

test('journal: a prepend that would overflow is refused whole (never half an older page)', () => {
  const j = new ThreadJournal(EPOCH_STEP)
  j.ingest([turn('t', 'completed', Array.from({ length: JOURNAL_MAX - 1 }, (_, i) => user(`u${i}`, 'm')))])
  assert.equal(j.prepend([turn('old', 'completed', [user('o1', 'x'), user('o2', 'y')])]), -1)
  assert.equal(j.length, JOURNAL_MAX - 1)
})

test('epoch: a multiple of the step, inside the safe integer range, and increasing with the clock', () => {
  const a = newEpoch(1_794_647_317_000)
  const b = newEpoch(1_794_647_318_000)
  assert.equal(a % EPOCH_STEP, 0)
  assert.equal(b - a, EPOCH_STEP)
  assert.ok(Number.isSafeInteger(a + EPOCH_STEP - 1))
  assert.ok(Number.isSafeInteger(newEpoch(Date.UTC(2200, 0, 1))))
})

test('★ times a Date cannot hold are left out instead of throwing (codex review, medium #8)', () => {
  const t = parseTurn({ id: 'x', status: 'completed', completedAt: 1e100, items: [user('u', 'hi'), { ...agent('a', 'yo'), completedAtMs: 1e100 }] })!
  assert.equal(t.completedAt, undefined)
  assert.doesNotThrow(() => turnEndEntry(t))
  assert.doesNotThrow(() => turnsToEntries([t]))
  const bad = parseTurn({ id: 'y', status: 'completed', items: [{ ...user('u2', 'hi'), startedAtMs: 1e100 }] })!
  assert.doesNotThrow(() => turnsToEntries([bad]))
})

test('★ journal: an "interrupted" ending that turns out to be a failure is corrected once (third review, medium #4)', () => {
  const j = new ThreadJournal(EPOCH_STEP)
  j.ingest([turn('t', 'interrupted', [user('u', 'go')])])
  const mark = j.tail
  j.ingest([turn('t', 'failed', [user('u', 'go')], { error: { message: 'boom' } })])
  const added = j.since(mark)!
  assert.equal(added.length, 1)
  assert.ok(added[0]!.kind === 'system')
  assert.match(added[0]!.text, /^Turn failed/)
  // Never twice, and never the other way round
  assert.equal(j.ingest([turn('t', 'failed', [user('u', 'go')], { error: { message: 'boom' } })]), 0)
  assert.equal(j.ingest([turn('t', 'interrupted', [user('u', 'go')])]), 0)
  const k = new ThreadJournal(EPOCH_STEP)
  k.ingest([turn('t', 'failed', [user('u', 'go')])])
  assert.equal(k.ingest([turn('t', 'interrupted', [user('u', 'go')])]), 0)
  // An interrupted turn that stays interrupted (or completes) adds nothing more
  const m = new ThreadJournal(EPOCH_STEP)
  m.ingest([turn('t', 'interrupted', [user('u', 'go')])])
  assert.equal(m.ingest([turn('t', 'completed', [user('u', 'go')])]), 0)
})

test('★ a compaction item (no text in it) is one folded line that says it happened and how long it took (2026-11-16)', () => {
  const e = (raw: Record<string, unknown>) => itemEntries(parseTurn({ id: 't', items: [raw] })!.items[0]!)
  // ★ The shape measured on codex-cli 0.169.0 (`thread/compact/start` from a side connection / docs/CODEX.md §5.8)
  const done = e({ type: 'contextCompaction', id: 'c1', startedAtMs: 1794823799120, completedAtMs: 1794823805390 })
  assert.equal(done.length, 1)
  const d = done[0]!
  assert.ok(d.kind === 'meta')
  assert.match(d.label, /会話を圧縮しました（6秒）|Conversation compacted \(6s\)/)
  assert.equal(d.at, new Date(1794823799120).toISOString())
  assert.equal(d.summary, '', 'no summary is made up')
  // Not finished (its turn was interrupted): never "compacted"
  const unfinished = e({ type: 'contextCompaction', id: 'c2', startedAtMs: 1794823799120, completedAtMs: null })
  assert.ok(unfinished[0]?.kind === 'meta')
  assert.match(unfinished[0].label, /終わっていません|did not finish/)
  // No times at all: still says it happened, without a made-up length
  const bare = e({ type: 'contextCompaction', id: 'c3', completedAtMs: 5 })
  assert.ok(bare[0]?.kind === 'meta')
  assert.match(bare[0].label, /^(会話を圧縮しました|Conversation compacted)$/)
})

test('a compaction item with times a Date cannot hold: no made-up length, never "Infinity" (codex review, low)', () => {
  const e = (raw: Record<string, unknown>) => itemEntries(parseTurn({ id: 't', items: [raw] })!.items[0]!)
  for (const [startedAtMs, completedAtMs] of [
    [0, Infinity],
    [-5, 1000],
    [5000, 1000],
    [1e300, 2e300],
  ]) {
    const [entry] = e({ type: 'contextCompaction', id: 'c', startedAtMs, completedAtMs })
    assert.ok(entry?.kind === 'meta')
    assert.ok(!/Infinity|NaN|-\d/.test(entry.label), entry.label)
    assert.ok(!/（\d+秒）|\(\d+s\)/.test(entry.label), `${startedAtMs}/${completedAtMs}: ${entry.label}`)
  }
})

test('"finished" and the compaction label use the one time check: an out-of-range time is unfinished in both (codex round 3, low)', () => {
  for (const completedAtMs of [-1, 1e300, Infinity, null]) {
    const turn = parseTurn({ id: 't', items: [{ type: 'contextCompaction', id: 'c', startedAtMs: 0, completedAtMs }] })!
    assert.equal(turn.items[0]!.completed, false, String(completedAtMs))
  }
  const ok = parseTurn({ id: 't', items: [{ type: 'contextCompaction', id: 'c', startedAtMs: 1000, completedAtMs: 3000 }] })!
  assert.equal(ok.items[0]!.completed, true)
  const [entry] = itemEntries(ok.items[0]!)
  assert.ok(entry?.kind === 'meta')
  assert.match(entry.label, /（2秒）|\(2s\)/)
})

test('★★ a Codex user message longer than the cut says its whole length (2026-11-20)', () => {
  const [u] = itemEntries(parseTurn({ id: 't', items: [{ type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'y'.repeat(25_000) }] }] })!.items[0]!)
  assert.equal(u?.kind === 'user' && u.fullLength, 25_000)
  assert.equal(u?.kind === 'user' && u.text.length, 20_000)
})

test('★ journal.after: the position a cut catch-up continues from (codex review)', () => {
  const j = new ThreadJournal(EPOCH_STEP)
  j.ingest([turn('t', 'completed', [user('u', 'a'), agent('a', 'b'), agent('b', 'c')])])
  const from = j.front
  const all = j.since(from)!
  assert.equal(all.length, 3)
  assert.deepEqual(j.since(j.after(from, 2)), all.slice(2))
  assert.equal(j.after(from, 3), j.tail)
})
