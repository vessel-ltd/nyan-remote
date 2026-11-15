import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { LogEntry } from '../../../shared/types.ts'
import { parseTurn, parseTurnsPage, type TurnsPage } from './history.ts'
import { CodexLogs, FOLLOW_TURNS, MAX_CATCHUP_PAGES, PAGE_TURNS, REFRESH_MIN_MS, type CodexLogSource } from './log.ts'

const FIX = JSON.parse(readFileSync(new URL('./fixtures/history-0.169.0.json', import.meta.url), 'utf8')) as {
  exchanges: Record<string, { response: { result: unknown } }>
}
const real = (name: string): TurnsPage => parseTurnsPage(FIX.exchanges[name]!.response.result)!

/** A source that serves the real two pages (newest first), keyed by the real cursor */
function source() {
  const p1 = real('turns_desc_full_page1')
  const p2 = real('turns_desc_full_page2')
  const calls: Array<{ limit: number; cursor?: string }> = []
  const s = {
    gen: 1,
    down: false,
    first: p1 as TurnsPage,
    second: p2 as TurnsPage | undefined,
    calls,
    generation: () => s.gen,
    turns: async (_id: string, opts: { limit: number; cursor?: string }) => {
      calls.push(opts)
      if (s.down) return undefined
      if (opts.cursor === undefined) return s.first
      return opts.cursor === p1.nextCursor ? s.second : undefined
    },
  }
  return s satisfies CodexLogSource & Record<string, unknown>
}

function clock(start = 1_794_647_400_000) {
  const c = { now: start }
  return { c, now: () => c.now }
}

const kinds = (e: LogEntry[]): string[] => e.map((x) => x.kind)
/** Real page 1 (old → new): the interrupted turn, then the failed one */
const NEWEST = ['user', 'system', 'user', 'system']
/** Real page 2 (old → new): accept (with the command), then decline */
const OLDER = ['user', 'assistant', 'tool_use', 'tool_result', 'assistant', 'user', 'assistant', 'assistant']

test('open: the newest entries, old to new; scrolling up reads the older turns with the opaque cursor verbatim', async () => {
  const src = source()
  const logs = new CodexLogs(clock().now)
  const page = await logs.page(src, 't', '.codex', {})
  assert.deepEqual(src.calls, [{ limit: PAGE_TURNS }])
  assert.equal(page.sessionId, 't')
  assert.equal(page.account, '.codex')
  assert.deepEqual(kinds(page.entries), NEWEST)
  assert.equal(typeof page.cursor, 'number')

  const older = await logs.page(src, 't', '.codex', { before: page.cursor })
  assert.equal(src.calls[1]!.cursor, real('turns_desc_full_page1').nextCursor, 'the opaque cursor went back verbatim')
  assert.deepEqual(kinds(older.entries), OLDER)
  assert.equal(older.cursor, null, 'the real second page is the last one')
  assert.equal(older.tail, page.tail, 'reading older does not move the follow position')
})

test('★ pages are cut by entries, not by turns (a real thread was 374 entries in 10 turns)', async () => {
  const src = source()
  const logs = new CodexLogs(clock().now)
  const a = await logs.page(src, 't', '.codex', { limit: 3 })
  assert.deepEqual(kinds(a.entries), NEWEST.slice(-3))
  // The rest of what is already held comes without asking the daemon
  const b = await logs.page(src, 't', '.codex', { before: a.cursor, limit: 1 })
  assert.deepEqual(kinds(b.entries), NEWEST.slice(0, 1))
  assert.equal(src.calls.length, 1)
  // Now the journal is exhausted: the next page comes from the daemon's older turns, still cut to the limit
  const c = await logs.page(src, 't', '.codex', { before: b.cursor, limit: 3 })
  assert.equal(src.calls.length, 2)
  assert.deepEqual(kinds(c.entries), OLDER.slice(-3))
  const d = await logs.page(src, 't', '.codex', { before: c.cursor, limit: 100 })
  assert.deepEqual(kinds(d.entries), OLDER.slice(0, -3))
  assert.equal(d.cursor, null)
  assert.equal(src.calls.length, 2, 'what was fetched once is not fetched again')
  // Stitched together, nothing is missing and nothing repeats
  assert.deepEqual(kinds([...d.entries, ...c.entries, ...b.entries, ...a.entries]), [...OLDER, ...NEWEST])
})

test('follow: only what came after the position; nothing twice; the daemon is asked at most once per interval', async () => {
  const src = source()
  const { c, now } = clock()
  const logs = new CodexLogs(now)
  // Start while the newest turn is still running (the real streaming capture: one user message)
  src.first = real('streaming_turn')
  const open = await logs.page(src, 't', '.codex', {})
  assert.deepEqual(kinds(open.entries), ['user'])

  // Asked again at once: no second call to the daemon, nothing new
  const same = await logs.page(src, 't', '.codex', { since: open.tail })
  assert.deepEqual(same.entries, [])
  assert.equal(src.calls.length, 1)

  // Later the turn is over
  c.now += REFRESH_MIN_MS
  src.first = real('turns_desc_full_page1')
  const next = await logs.page(src, 't', '.codex', { since: open.tail })
  assert.deepEqual(src.calls.at(-1), { limit: FOLLOW_TURNS })
  // The interrupted turn closes, and the failed turn after it appears
  assert.deepEqual(kinds(next.entries), ['system', 'user', 'system'])
  c.now += REFRESH_MIN_MS
  const again = await logs.page(src, 't', '.codex', { since: next.tail })
  assert.deepEqual(again.entries, [])
  assert.equal(again.tail, next.tail)
})

test('grew: true only when something new became showable; the page that follows does not ask the daemon again', async () => {
  const src = source()
  const { c, now } = clock()
  const logs = new CodexLogs(now)
  src.first = real('streaming_turn')
  const open = await logs.page(src, 't', '.codex', {})
  c.now += REFRESH_MIN_MS
  assert.equal(await logs.grew(src, 't'), false, 'the same turn, nothing new recorded')
  c.now += REFRESH_MIN_MS
  src.first = real('turns_desc_full_page1')
  assert.equal(await logs.grew(src, 't'), true)
  const calls = src.calls.length
  // The phone, told by the signal, asks right away: it gets the new entries without another daemon call
  const next = await logs.page(src, 't', '.codex', { since: open.tail })
  assert.deepEqual(kinds(next.entries), ['system', 'user', 'system'])
  assert.equal(src.calls.length, calls)
  // Asked too soon again: throttled, and "nothing grew" (not an error)
  assert.equal(await logs.grew(src, 't'), false)
  assert.equal(src.calls.length, calls)
})

test('a reconnect starts a new journal: old positions get nothing (not the thread again), and the tail moves on', async () => {
  const src = source()
  const { c, now } = clock()
  const logs = new CodexLogs(now)
  const open = await logs.page(src, 't', '.codex', {})
  src.gen = 2
  c.now += 5000
  const after = await logs.page(src, 't', '.codex', { since: open.tail })
  assert.deepEqual(after.entries, [], 'the reader is not shown the whole thread a second time')
  assert.ok(after.tail > open.tail)
  // An old "older" position is not honoured either
  const stale = await logs.page(src, 't', '.codex', { before: open.cursor })
  assert.deepEqual([stale.entries, stale.cursor], [[], null])
  // Opening again gives the thread from the new journal
  const reopened = await logs.page(src, 't', '.codex', {})
  assert.deepEqual(kinds(reopened.entries), NEWEST)
})

test('two journals created in the same second do not share positions', async () => {
  const src = source()
  const logs = new CodexLogs(clock().now)
  const a = await logs.page(src, 'a', '.codex', {})
  const b = await logs.page(src, 'b', '.codex', {})
  assert.notEqual(Math.floor(a.tail / 1_000_000), Math.floor(b.tail / 1_000_000))
  // A position of thread a is "not ours" for thread b
  const cross = await logs.page(src, 'b', '.codex', { since: a.tail })
  assert.deepEqual(cross.entries, [])
  const crossBefore = await logs.page(src, 'b', '.codex', { before: a.cursor })
  assert.deepEqual([crossBefore.entries, crossBefore.cursor], [[], null])
})

test('the daemon cannot be read: the reader gets what is already known, and "older" can be retried', async () => {
  const src = source()
  const { c, now } = clock()
  const logs = new CodexLogs(now)
  src.down = true
  const empty = await logs.page(src, 't', '.codex', {})
  assert.deepEqual([empty.entries, empty.cursor], [[], null])
  src.down = false
  c.now += REFRESH_MIN_MS
  const open = await logs.page(src, 't', '.codex', {})
  assert.deepEqual(kinds(open.entries), NEWEST)
  src.down = true
  const older = await logs.page(src, 't', '.codex', { before: open.cursor })
  assert.deepEqual(older.entries, [])
  assert.equal(older.cursor, open.cursor, 'the same position comes back so the reader can try again')
  src.down = false
  const retry = await logs.page(src, 't', '.codex', { before: older.cursor })
  assert.deepEqual(kinds(retry.entries), OLDER)
})

test('a daemon whose older-cursor does not advance does not loop', async () => {
  const src = source()
  const logs = new CodexLogs(clock().now)
  const open = await logs.page(src, 't', '.codex', {})
  // A broken daemon: the older page is empty and hands back the cursor it was given
  src.second = { turns: [], nextCursor: real('turns_desc_full_page1').nextCursor, skipped: 0 }
  const older = await logs.page(src, 't', '.codex', { before: open.cursor })
  assert.deepEqual([older.entries, older.cursor], [[], null])
  assert.equal(src.calls.length, 2)
})

test('★ two readers asking for older entries at once do not lose the cursor (third review, medium #3)', async () => {
  const src = source()
  const p1 = real('turns_desc_full_page1')
  // The second page has a third one behind it
  src.second = { ...real('turns_desc_full_page2'), nextCursor: 'c3' }
  const third: TurnsPage = {
    turns: [parseTurn({ id: 'old', status: 'completed', error: null, items: [{ type: 'userMessage', id: 'u-old', content: [{ type: 'text', text: 'oldest' }] }] })!],
    nextCursor: null,
    skipped: 0,
  }
  const inner = src.turns
  src.turns = async (id, opts) => (opts.cursor === 'c3' ? (src.calls.push(opts), third) : inner(id, opts))
  const logs = new CodexLogs(clock().now)
  const open = await logs.page(src, 't', '.codex', {})
  // Two phones press "older" at the same moment
  const [a, b] = await Promise.all([
    logs.page(src, 't', '.codex', { before: open.cursor, limit: 1 }),
    logs.page(src, 't', '.codex', { before: open.cursor, limit: 1 }),
  ])
  assert.equal(src.calls.filter((c) => c.cursor === p1.nextCursor).length, 2, 'both asked for the same page')
  const from = Math.min(a.cursor ?? Infinity, b.cursor ?? Infinity)
  assert.notEqual(from, Infinity, 'still something older to offer')
  // Keep scrolling up: the third page is still reachable
  let cursor: number | null = from
  const seen: LogEntry[] = []
  for (let i = 0; i < 20 && cursor !== null; i++) {
    const p = await logs.page(src, 't', '.codex', { before: cursor, limit: 60 })
    seen.push(...p.entries)
    cursor = p.cursor
  }
  assert.ok(src.calls.some((c) => c.cursor === 'c3'), 'the page behind the shared one was read')
  assert.ok(seen.some((e) => e.kind === 'user' && e.text === 'oldest'))
})

test('★ two refreshes of the newest turns at once: the older answer arriving last does not land after the newer turns (fourth review, medium #4)', async () => {
  const mk = (n: number) => parseTurn({ id: `t${n}`, status: 'completed', error: null, items: [{ type: 'userMessage', id: `u${n}`, content: [{ type: 'text', text: `m${n}` }] }] })!
  const page = (from: number, to: number): TurnsPage => ({ turns: Array.from({ length: to - from + 1 }, (_, i) => mk(to - i)), nextCursor: null, skipped: 0 })
  let releaseA!: () => void
  const aHeld = new Promise<void>((r) => (releaseA = r))
  let calls = 0
  const src: CodexLogSource = {
    generation: () => 1,
    turns: async () => {
      calls++
      // A (first) was served when turns 1–5 were the newest, and answers last
      if (calls === 1) {
        await aHeld
        return page(1, 5)
      }
      return page(2, 6)
    },
  }
  const { c, now } = clock()
  const logs = new CodexLogs(now)
  const a = logs.page(src, 't', '.codex', {})
  c.now += REFRESH_MIN_MS * 2
  const b = logs.page(src, 't', '.codex', {})
  releaseA()
  await Promise.all([a, b])
  const later = await logs.page(src, 't', '.codex', {})
  const order = later.entries.map((e) => (e.kind === 'user' ? e.text : '?'))
  for (let i = 1; i < order.length; i++) assert.ok(Number(order[i]!.slice(1)) > Number(order[i - 1]!.slice(1)), `out of order: ${order.join(' ')}`)
})

/** A thread whose turns the test adds to; served newest first, `PAGE`-sized pages behind numeric cursors */
function growing() {
  const mk = (n: number) => parseTurn({ id: `t${n}`, status: 'completed', error: null, items: [{ type: 'userMessage', id: `u${n}`, content: [{ type: 'text', text: `m${n}` }] }] })!
  const g = {
    count: 0,
    /** Reads behind a cursor fail (the daemon refuses for a moment) */
    olderDown: false,
    calls: [] as Array<{ limit: number; cursor?: string }>,
    generation: () => 1,
    turns: async (_id: string, opts: { limit: number; cursor?: string }): Promise<TurnsPage | undefined> => {
      g.calls.push(opts)
      if (g.olderDown && opts.cursor !== undefined) return undefined
      // Newest first: start at the cursor (an index from the newest), take `limit`
      const from = opts.cursor === undefined ? 0 : Number(opts.cursor)
      const ids = Array.from({ length: g.count }, (_, i) => g.count - i).slice(from, from + opts.limit)
      const next = from + opts.limit < g.count ? String(from + opts.limit) : null
      return { turns: ids.map(mk), nextCursor: next, skipped: 0 }
    },
  }
  return g
}
const texts = (e: LogEntry[]): number[] => e.map((x) => (x.kind === 'user' ? Number(x.text.slice(1)) : -1))

test('★ more turns than one refresh reads pass between two refreshes: none goes missing, none out of order (fifth review, medium #3)', async () => {
  const g = growing()
  g.count = 5
  const { c, now } = clock()
  const logs = new CodexLogs(now)
  const open = await logs.page(g, 't', '.codex', {})
  assert.deepEqual(texts(open.entries), [1, 2, 3, 4, 5])
  // Five more turns while nobody looked; the follow reads only FOLLOW_TURNS
  g.count = 10
  c.now += REFRESH_MIN_MS * 2
  const follow = await logs.page(g, 't', '.codex', { since: open.tail })
  assert.deepEqual(texts(follow.entries), [6, 7, 8, 9, 10])
  // Reopening reads more again: still in order, nothing twice
  c.now += REFRESH_MIN_MS * 2
  const again = await logs.page(g, 't', '.codex', { limit: 100 })
  assert.deepEqual(texts(again.entries), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
})

test('too far behind to join up: a new journal from the newest turns (old positions get nothing), never a hole', async () => {
  const g = growing()
  g.count = 2
  const { c, now } = clock()
  const logs = new CodexLogs(now)
  const open = await logs.page(g, 't', '.codex', {})
  g.count = 2 + FOLLOW_TURNS + PAGE_TURNS * (MAX_CATCHUP_PAGES + 2)
  c.now += REFRESH_MIN_MS * 2
  const follow = await logs.page(g, 't', '.codex', { since: open.tail })
  assert.deepEqual(follow.entries, [], 'a position from the old journal gets nothing')
  const now2 = await logs.page(g, 't', '.codex', { limit: 1000 })
  const got = texts(now2.entries)
  for (let i = 1; i < got.length; i++) assert.equal(got[i], got[i - 1]! + 1, 'contiguous')
  assert.equal(got.at(-1), g.count)
  assert.notEqual(now2.cursor, null, 'what is older can still be read')
})

test('a catch-up read that fails takes nothing for now (the newest alone would leave a hole), and the next refresh joins up', async () => {
  const g = growing()
  g.count = 5
  const { c, now } = clock()
  const logs = new CodexLogs(now)
  const open = await logs.page(g, 't', '.codex', {})
  g.count = 10
  g.olderDown = true
  c.now += REFRESH_MIN_MS * 2
  const first = await logs.page(g, 't', '.codex', { since: open.tail })
  assert.deepEqual(first.entries, [])
  g.olderDown = false
  c.now += REFRESH_MIN_MS * 2
  const second = await logs.page(g, 't', '.codex', { since: open.tail })
  assert.deepEqual(texts(second.entries), [6, 7, 8, 9, 10])
})

test('an older-read in flight when a refresh starts a new journal gets the empty page of an expired position (sixth review, medium #2)', async () => {
  const g = growing()
  g.count = 10
  const { c, now } = clock()
  const logs = new CodexLogs(now)
  const open = await logs.page(g, 't', '.codex', {})
  assert.notEqual(open.cursor, null)
  // The older read is held until the refresh has started over
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  const inner = g.turns
  g.turns = async (id, opts) => {
    if (opts.cursor !== undefined && opts.limit === PAGE_TURNS && g.count === 10) {
      await held
    }
    return inner(id, opts)
  }
  const older = logs.page(g, 't', '.codex', { before: open.cursor, limit: 60 })
  g.count = 10 + FOLLOW_TURNS + PAGE_TURNS * (MAX_CATCHUP_PAGES + 2)
  c.now += REFRESH_MIN_MS * 2
  g.turns = async (id, opts) => inner(id, opts)
  await logs.page(g, 't', '.codex', { since: open.tail })
  release()
  const got = await older
  assert.deepEqual([got.entries, got.cursor], [[], null])
})
