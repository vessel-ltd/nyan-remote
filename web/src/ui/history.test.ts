import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { SessionSummary, SessionsPage } from '../../../shared/types.ts'
import {
  EMPTY_LIST,
  applyPage,
  combineRows,
  markOfflineList,
  pickOwner,
  pickRow,
  shouldFetchHistory,
  type ListState,
} from './history.ts'

function row(id: string, live: boolean, at = '2026-08-31T00:00:00.000Z'): SessionSummary {
  return {
    machine: 'M',
    account: '.claude',
    sessionId: id,
    cwd: '/tmp',
    project: 'tmp',
    title: id,
    titleSource: 'fallback',
    status: live ? 'working' : 'done',
    live,
    lastActivity: at,
    transcriptBytes: 1,
  }
}

const LIVE = row('live-1', true)
const H1 = row('hist-1', false)
const H2 = row('hist-2', false)
/** State after fetching 2 history rows */
const LOADED: ListState = { sessions: [], history: [H1, H2], historyCount: 2, rev: 'r2', loadedRev: 'r2', everFetched: true }

test('★★ a filtered response (live only) does not clear the history already fetched', () => {
  const page: SessionsPage = { machine: 'M', sessions: [LIVE], history: { count: 2, rev: 'r2' } }
  const next = applyPage(page, { requestedHistory: false, prev: LOADED })
  // ⚠️⚠️ Clearing it here makes history vanish and reappear every 15 seconds while open
  assert.deepEqual(next.history.map((s) => s.sessionId), ['hist-1', 'hist-2'])
  assert.deepEqual(next.sessions.map((s) => s.sessionId), ['live-1'])
  assert.equal(next.historyCount, 2)
})

test('★★ a filtered response does not advance the "fetched revision" (advancing it means new history is never fetched)', () => {
  // ⚠️⚠️ The mutation codex named on 2026-09-01 (`loadedRev: opts.prev.loadedRev` → `rev`).
  //    With it, "fetched" is claimed without fetching, and while the asserts below stay green
  //    **the third row is never fetched**.
  const page: SessionsPage = { machine: 'M', sessions: [LIVE], history: { count: 3, rev: 'r3' } }
  const next = applyPage(page, { requestedHistory: false, prev: LOADED })
  assert.equal(next.rev, 'r3', 'does not hold the revision the agent reported')
  assert.equal(next.loadedRev, 'r2', 'advances the "fetched revision" without fetching')
  assert.equal(
    shouldFetchHistory({ open: true, missingOpenSession: false, state: next }),
    true,
    '★ does not fetch new history',
  )
})

test('★★ a full response replaces the history and advances the revision', () => {
  const page: SessionsPage = { machine: 'M', sessions: [LIVE, H1, H2], history: { count: 2, rev: 'r2' } }
  const next = applyPage(page, { requestedHistory: true, prev: EMPTY_LIST })
  assert.deepEqual(next.history.map((s) => s.sessionId), ['hist-1', 'hist-2'])
  assert.equal(next.loadedRev, 'r2')
  // ★ Live sessions are not mixed into history
  assert.deepEqual(next.sessions.map((s) => s.sessionId), ['live-1'])
  assert.equal(shouldFetchHistory({ open: true, missingOpenSession: false, state: next }), false)
})

test('★★ remembers "fetched" even when asked and history is 0 rows (inferring from row count keeps fetching)', () => {
  // ⚠️⚠️ Judging "did it include history" by row count cannot tell a **correct 0 rows** from
  //    "did not ask", and `shouldFetchHistory` stays true forever
  const page: SessionsPage = { machine: 'M', sessions: [LIVE], history: { count: 0, rev: 'r0' } }
  const next = applyPage(page, { requestedHistory: true, prev: EMPTY_LIST })
  assert.equal(next.loadedRev, 'r0', 'treated as not fetched yet (fetches every time)')
  assert.equal(shouldFetchHistory({ open: true, missingOpenSession: false, state: next }), false)
})

test('★★ an old agent (no history) returns all rows in sessions (not confused with 0 rows)', () => {
  // ⚠️ While updating machines one by one, an "old agent" is always mixed in
  const page = { machine: 'M', sessions: [LIVE, H1, H2] } as SessionsPage
  const next = applyPage(page, { requestedHistory: false, prev: EMPTY_LIST })
  assert.deepEqual(next.history.map((s) => s.sessionId), ['hist-1', 'hist-2'], 'history disappeared')
  assert.equal(next.historyCount, 2)
  // ★ Never fetch again from an old agent (sending ?live=1 just returns the same thing)
  assert.equal(next.rev, null)
  assert.equal(next.loadedRev, null)
  assert.equal(shouldFetchHistory({ open: true, missingOpenSession: false, state: next }), false)
})

test('★★ a row revived by --resume is not shown twice (the live one wins)', () => {
  const revived = row('hist-1', true)
  const s: ListState = { ...LOADED, sessions: [revived] }
  const rows = combineRows(s)
  assert.deepEqual(rows.map((x) => x.sessionId), ['hist-1', 'hist-2'], 'the same row appears twice')
  assert.equal(rows[0]?.live, true, 'the old (ended) one wins')
})

test('★★ does not fetch while collapsed (this is what removes the 87%)', () => {
  const s: ListState = { ...EMPTY_LIST, historyCount: 129, rev: 'r' }
  assert.equal(shouldFetchHistory({ open: false, missingOpenSession: false, state: s }), false)
  assert.equal(shouldFetchHistory({ open: true, missingOpenSession: false, state: s }), true)
})

test('★★ same revision: no refetch / changed: refetch (not judged by count)', () => {
  assert.equal(shouldFetchHistory({ open: true, missingOpenSession: false, state: LOADED }), false)
  // ⚠️⚠️ **The contents change while the count stays the same** (pushed out at the cap / codex medium #2).
  //    Judging by count, this stays false and new history is never fetched
  assert.equal(
    shouldFetchHistory({ open: true, missingOpenSession: false, state: { ...LOADED, rev: 'r2b' } }),
    true,
    '★ judges by count (misses a same-count replacement)',
  )
})

test('★★ if the open thread row is nowhere, fetch even while collapsed', () => {
  // ⚠️ Happens when opening a history session from a notification / restoring on reload
  const s: ListState = { ...EMPTY_LIST, historyCount: 129, rev: 'r' }
  assert.equal(shouldFetchHistory({ open: false, missingOpenSession: true, state: s }), true)
})

test('★★ gives up if not found after fetching everything (does not keep fetching all rows)', () => {
  // ⚠️⚠️ An unconditional `return true` means just leaving open an old session ID that overflowed the list cap
  //    **brings the 87% waste straight back** (a hole I found myself on 2026-09-01)
  assert.equal(
    shouldFetchHistory({ open: false, missingOpenSession: true, state: LOADED }),
    false,
    'keeps fetching after fetching everything',
  )
})

test('★ "never fetched yet" is not represented by a possible value', () => {
  // ⚠️ Never use a possible value as a sentinel (same trap as tail in log.ts)
  assert.equal(EMPTY_LIST.loadedRev, null)
  assert.equal(EMPTY_LIST.rev, null)
})

test('★★ sessions of a down endpoint move to history and are counted there', () => {
  const s: ListState = { sessions: [LIVE], history: [H1], historyCount: 1, rev: 'r1', loadedRev: 'r1', everFetched: true }
  const off = markOfflineList(s)
  assert.deepEqual(off.sessions, [], 'still under "running" although down')
  assert.deepEqual(off.history.map((x) => x.sessionId), ['hist-1', 'live-1'])
  assert.equal(off.historyCount, 2, 'the number in the collapsed heading is stale')
  assert.equal(off.history[1]?.live, false)
})

test('★★ does not keep growing when called every 15 seconds while down', () => {
  let s: ListState = { sessions: [LIVE], history: [], historyCount: 0, rev: 'r0', loadedRev: 'r0', everFetched: true }
  for (let i = 0; i < 5; i++) s = markOfflineList(s)
  assert.equal(s.history.length, 1, `history keeps growing: ${s.history.length}`)
  assert.equal(s.historyCount, 1)
})

test('★★ reconnecting and going down again does not add the same row to history twice', () => {
  // ⚠️⚠️ The "does not keep growing" test **empties sessions on the first call**, so it never
  //    went through the duplicate guard (mutation #7 of 2026-09-01 survived).
  let s = markOfflineList({ sessions: [LIVE], history: [], historyCount: 0, rev: 'r0', loadedRev: 'r0', everFetched: true })
  assert.equal(s.history.length, 1)
  s = { ...s, sessions: [LIVE] }
  s = markOfflineList(s)
  assert.equal(s.history.length, 1, `the same row entered history twice: ${s.history.length}`)
  assert.equal(s.historyCount, 1, `the heading number was inflated: ${s.historyCount}`)
})

test('★★ revived then down again: the history row is replaced with the newer one', () => {
  // ⚠️ codex low #1. If skipped, **the old snapshot** (the previous `lastActivity`) remains and
  //    the list shows a stale "last active" time
  const old = row('hist-1', false, '2026-08-30T00:00:00.000Z')
  const revived = row('hist-1', true, '2026-08-31T12:00:00.000Z')
  const s: ListState = { sessions: [revived], history: [old], historyCount: 1, rev: 'r1', loadedRev: 'r1', everFetched: true }
  const off = markOfflineList(s)
  assert.equal(off.history.length, 1, 'added twice')
  assert.equal(
    off.history[0]?.lastActivity,
    '2026-08-31T12:00:00.000Z',
    'the old snapshot remains (a stale "last active" time is shown)',
  )
  assert.equal(off.history[0]?.live, false)
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ 2026-09-01 codex round 2 (2 high, 3 medium)
// ─────────────────────────────────────────────────────────────────────────────

test('★★ if history is open at startup, the first fetch includes history (not empty for 15 seconds)', () => {
  // ⚠️⚠️ "Never queried" was represented as `rev === loadedRev === null`, so right after startup
  //    it said "same, don't fetch" and **history was empty until the next poll** (codex medium #1).
  assert.equal(
    shouldFetchHistory({ open: true, missingOpenSession: false, state: EMPTY_LIST }),
    true,
    'does not fetch history right after startup (empty for 15 seconds)',
  )
})

test('★★ even an agent that reports no revision has its count changes watched (not treated as an old agent)', () => {
  // ⚠️ The version with `history` but no `rev` (bd59748). Leaving `rev` null makes it
  //    the same shape as an "old agent", and changes are never noticed
  const p1 = { machine: 'M', sessions: [LIVE], history: { count: 2 } } as unknown as SessionsPage
  const a = applyPage(p1, { requestedHistory: true, prev: EMPTY_LIST })
  assert.equal(a.everFetched, true)
  assert.equal(shouldFetchHistory({ open: true, missingOpenSession: false, state: a }), false)
  const p2 = { machine: 'M', sessions: [LIVE], history: { count: 3 } } as unknown as SessionsPage
  const b = applyPage(p2, { requestedHistory: false, prev: a })
  assert.equal(
    shouldFetchHistory({ open: true, missingOpenSession: false, state: b }),
    true,
    'does not fetch when the count grows on an agent that reports no revision',
  )
})

test('★★ rows added while down are refetched after reconnecting (no ghost rows)', () => {
  // ⚠️⚠️ codex medium #3. Disconnect during a live session under 1KB → added to our history →
  //    later the process ends but the agent does not list sessions under 1KB = **the revision does not change**
  //    ⇒ never refetched, and the row we made remains forever
  const s: ListState = { sessions: [LIVE], history: [H1], historyCount: 1, rev: 'r1', loadedRev: 'r1', everFetched: true }
  const off = markOfflineList(s)
  assert.equal(off.everFetched, false, 'still counted as "fetched" (a ghost row remains)')
  assert.equal(
    shouldFetchHistory({ open: true, missingOpenSession: false, state: { ...off, rev: 'r1' } }),
    true,
    'same revision so no refetch (a ghost row remains)',
  )
})

test('★★ the owner prefers the live one (does not keep reading an old log)', () => {
  // ⚠️⚠️ codex high #2. When the same sessionId exists "as history on A and as a --resumed live session on B",
  //    searching from the top with history mixed in **makes A the owner and keeps reading the old log**
  const A = { ...EMPTY_LIST, history: [row('same', false)] }
  const B = { ...EMPTY_LIST, sessions: [row('same', true)] }
  assert.equal(pickOwner([A, B], 'same'), B, 'the one holding history became the owner')
  assert.equal(pickRow([A, B], 'same')?.live, true, 'the row shown is the old history')
})

test('★★ with no live endpoint, search history (the previous high #1 must not come back)', () => {
  const A = { ...EMPTY_LIST, sessions: [row('other', true)] }
  const B = { ...EMPTY_LIST, history: [row('gone', false)] }
  assert.equal(pickOwner([A, B], 'gone'), B, 'did not find the endpoint holding the history')
  assert.equal(pickRow([A, B], 'gone')?.sessionId, 'gone')
  assert.equal(pickOwner([A, B], 'nowhere'), undefined)
})
