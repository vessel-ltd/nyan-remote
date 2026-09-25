// ★★ `/sessions?live=1` returns only "the active ones" (2026-08-31 / ARCHITECTURE §14.1.1.7).
//
// **Why**: measured, `GET /sessions` was 87% of the bandwidth. Of 70,891 B / 159 items per call,
// **only 2 were active**, and the rest was **unchanging history resent every 6.5 seconds**.
//
// ⚠️⚠️ **Do not write a test that filters a hand-built list** (false green). Here we
//    **lay down a real config dir and transcripts and call `sessions()`**,
//    and check **the values the API returns as is** (= the values the PWA reads).
// ⚠️ Same technique as `sessionsWaiting.test.ts`: the live session uses **our own pid**.

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { SessionSummary } from '../../../shared/types.ts'
import { loadConfig } from '../config.ts'
import { INFLIGHT_MAX_AGE_MS, inflightDir } from '../claude/inflight.ts'
import type { Ctx } from '../router.ts'
import { historyRev, resetSweepForTest, sessions } from './sessions.ts'

const LIVE_ID = '11111111-2222-3333-4444-555555555555'
const DEAD = ['aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002']

/** One transcript line. ⚠️ Under 1KB does not appear in the list (`MIN_BYTES`), so it is padded */
function line(at: string): string {
  return (
    JSON.stringify({
      type: 'user',
      cwd: '/tmp/proj',
      timestamp: at,
      message: { role: 'user', content: `テスト${'あ'.repeat(600)}` },
    }) + '\n'
  )
}

/**
 * ★ Build an environment with `withLive` live sessions and `DEAD.length` finished ones.
 * ⚠️ **The state directory is temp too** (never let it clean up the real `~/.nyan-remote`).
 */
async function fixture(t: { after: (fn: () => unknown) => void }, withLive: boolean) {
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-slist-state-'))
  const acct = await mkdtemp(join(tmpdir(), 'nyan-remote-slist-acct-'))
  const prevState = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  t.after(async () => {
    if (prevState === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prevState
    await rm(state, { recursive: true, force: true })
    await rm(acct, { recursive: true, force: true })
  })

  const projects = join(acct, 'projects', '-tmp-proj')
  await mkdir(projects, { recursive: true })
  await mkdir(join(acct, 'sessions'), { recursive: true })

  if (withLive) {
    // ⚠️ `procStart` is not written (if skipped on an environment without `/proc`, breakage would go unnoticed)
    await writeFile(
      join(acct, 'sessions', `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: LIVE_ID, cwd: '/tmp/proj', status: 'busy', kind: 'interactive' }),
    )
    await writeFile(join(projects, `${LIVE_ID}.jsonl`), line('2026-08-31T05:00:00.000Z'))
  }
  for (const id of DEAD) {
    await writeFile(join(projects, `${id}.jsonl`), line('2026-08-30T05:00:00.000Z'))
  }

  // ⚠️ Without `hookToken` it goes into refuse mode and **looks at the real `~/.claude*`**
  await writeFile(
    join(state, 'config.json'),
    JSON.stringify({ allowedLogins: ['t@example.com'], configDirs: [acct], hookToken: 'x'.repeat(40) }),
  )
  await loadConfig()
  // ⚠️ The cleanup interval (5 minutes) is one per process, so reset it for each test
  resetSweepForTest()
  return { state, acct }
}

/** ⚠️ Build the URL the same way the real `index.ts` does (`new URL(req.url, ...)`) */
function ctx(path: string): Ctx {
  return { url: new URL(path, 'http://localhost:7777') } as Ctx
}

test('★★★ ?live=1 returns only "the active ones", and history comes as just a count and revision', async (t) => {
  await fixture(t, true)
  const page = await sessions(ctx('/sessions?live=1'))
  assert.deepEqual(
    page.sessions.map((s) => s.sessionId),
    [LIVE_ID],
    'history is mixed into the body (this is the 87% of the bandwidth)',
  )
  assert.equal(page.sessions[0]?.live, true)
  // ★ Even when hidden, the count is needed (the number shown in the collapsed heading)
  assert.equal(page.history?.count, DEAD.length)
})

test('★★★ the default (no query) returns all items as before (do not break old PWAs)', async (t) => {
  // ⚠️⚠️ This is the real one (codex 2026-09-01, medium #1). Once **the default was made filtered**,
  //    producing a state where **the whole history vanished** for old PWAs (the Service Worker holds an old bundle / in a
  //    symmetric mesh only one side is new). ⇒ **The new side opts in**.
  await fixture(t, true)
  const page = await sessions()
  assert.deepEqual(
    page.sessions.map((s) => s.sessionId).sort(),
    [...DEAD, LIVE_ID].sort(),
    'the default is not all items (history vanishes on old PWAs)',
  )
  // ⚠️ The count is **the number of history items** regardless of filtering (not the total)
  assert.equal(page.history?.count, DEAD.length)
})

test('★★ always attach `history` (without it a new PWA misreads it as "old agent = all items")', async (t) => {
  await fixture(t, false)
  const page = await sessions(ctx('/sessions?live=1'))
  assert.deepEqual(page.sessions, [], 'rows are returned although nothing is alive')
  // ⚠️⚠️ **Do not omit `history`**. If omitted, the PWA reads it as "an old agent, so
  //    `sessions` is all items" = **history is shown as 0 items and the way to open it disappears**
  assert.equal(page.history?.count, DEAD.length, 'history is not attached (history becomes unreachable)')
  assert.match(page.history?.rev ?? '', /^[\w-]{16}$/, 'rev is not attached')
})

test('★★★ the history revision catches "contents changed while the count stayed the same"', async (t) => {
  // ⚠️⚠️ codex medium #2. At the limit (maxSessionsPerAccount), one enters and one is pushed out, so
  //    **the set changes while the count stays the same**. Deciding by count means new history is never fetched.
  const { acct } = await fixture(t, false)
  const before = await sessions(ctx('/sessions?live=1'))
  // Drop one and add another (same count)
  const projects = join(acct, 'projects', '-tmp-proj')
  await rm(join(projects, `${DEAD[0]}.jsonl`))
  await writeFile(join(projects, 'cccccccc-0000-0000-0000-000000000003.jsonl'), line('2026-08-29T05:00:00.000Z'))
  resetSweepForTest()
  const after = await sessions(ctx('/sessions?live=1'))
  assert.equal(after.history?.count, before.history?.count, 'the precondition broke (the count changed)')
  assert.notEqual(after.history?.rev, before.history?.rev, '★ the revision did not change (new history is never fetched)')
})

test('★ the same contents give the same revision (do not force a refetch every time)', async (t) => {
  await fixture(t, true)
  const a = await sessions(ctx('/sessions?live=1'))
  resetSweepForTest()
  const b = await sessions(ctx('/sessions?live=1'))
  assert.equal(a.history?.rev, b.history?.rev, 'the revision changes every time (history keeps being refetched)')
})

test('★★★ the cleanup decides on "all items" (deciding on the filtered list deletes history text)', async (t) => {
  // ⚠️⚠️ Computing `sweepInflight`'s `keep` after filtering **deletes "not yet written" text on the history side**.
  //    The set was once **widened** in codex 2026-08-21, medium #5, so kill mutations that narrow it.
  const { state } = await fixture(t, true)
  await mkdir(inflightDir(), { recursive: true })
  const path = join(inflightDir(), `${DEAD[0]}.jsonl`)
  await writeFile(path, JSON.stringify({ text: 'のこす' }) + '\n')
  // ★ Make it old (`sweepInflight` only deletes things past MAX_AGE, so leaving it new would be a false green)
  const old = new Date(Date.now() - INFLIGHT_MAX_AGE_MS - 60_000)
  await utimes(path, old, old)

  await sessions(ctx('/sessions?live=1'))
  await new Promise((r) => setTimeout(r, 50)) // the cleanup runs as void

  await assert.doesNotReject(stat(path), 'a history session\'s text was deleted (cleaning up with the filtered list)')
  assert.ok(state)
})

test('★★★ the cleanup runs even with 0 active sessions (filtering first means it never runs)', async (t) => {
  // ⚠️⚠️ The cleanup has a `sessions.length > 0` guard (so "nothing could be read" is not mixed
  //    with "0 items"). **Filtering first means that during all-idle periods
  //    it hits this guard and the cleanup never runs at all**.
  await fixture(t, false)
  await mkdir(inflightDir(), { recursive: true })
  const gone = join(inflightDir(), 'bbbbbbbb-0000-0000-0000-000000000009.jsonl')
  await writeFile(gone, JSON.stringify({ text: 'きえる' }) + '\n')
  const old = new Date(Date.now() - INFLIGHT_MAX_AGE_MS - 60_000)
  await utimes(gone, old, old)

  await sessions(ctx('/sessions?live=1'))
  await new Promise((r) => setTimeout(r, 50))

  await assert.rejects(stat(gone), 'the cleanup did not run (the filter-first mutation)')
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ The history revision itself (`historyRev`). ⚠️ The endpoint-level tests above
//    cannot produce "the order actually changes" or "same IDs, only the time changes", so check it directly.
// ─────────────────────────────────────────────────────────────────────────────

function hrow(id: string, at: string): SessionSummary {
  return {
    machine: 'M',
    account: '.claude',
    sessionId: id,
    cwd: '/tmp',
    project: 'tmp',
    title: id,
    titleSource: 'fallback',
    status: 'done',
    live: false,
    lastActivity: at,
    transcriptBytes: 1,
  }
}

test('★★★ the revision stays the same when the order changes (do not force a refetch every time)', () => {
  // ⚠️ `collectSessions` sorts by mtime, so **the same set can change order**.
  //    Depending on order would change the revision for identical contents and **refetch 61KB every time**
  const a = hrow('aaaa', '2026-08-30T00:00:00.000Z')
  const b = hrow('bbbb', '2026-08-31T00:00:00.000Z')
  assert.equal(historyRev([a, b]), historyRev([b, a]), 'the revision depends on the order')
})

test('★★★ even with the same ID, the revision changes when "the last active time" changes', () => {
  // ⚠️ Revived with `--resume` and finished again, **the ID stays the same and only the time is newer**.
  //    Building the revision from IDs alone would keep the PWA showing an old snapshot
  const before = historyRev([hrow('aaaa', '2026-08-30T00:00:00.000Z')])
  const after = historyRev([hrow('aaaa', '2026-08-31T09:00:00.000Z')])
  assert.notEqual(after, before, 'the revision ignores the time (old rows remain)')
})

test('★ even empty history gives a fixed-form string (never undefined)', () => {
  assert.match(historyRev([]), /^[\w-]{16}$/)
})

test('★★★ the revision also changes for the "away summary" appended after it ends', () => {
  // ⚠️⚠️ codex round 2, medium #2. `away_summary` is appended **about 3 minutes after** a session ends;
  //    `awaySummary` and `transcriptBytes` change while `lastActivity` stays as is.
  //    The inputs were `sessionId + lastActivity`, so a PWA that already fetched it
  //    **never received the summary**. ⇒ The revision is built from **the row itself**.
  const base = hrow('aaaa', '2026-08-30T00:00:00.000Z')
  const withSummary: SessionSummary = { ...base, awaySummary: '要約', transcriptBytes: 999 }
  assert.notEqual(historyRev([withSummary]), historyRev([base]), 'the revision ignores the appended summary')
})

test('★★ if a value shown on screen changes, the revision changes too (do not pick the inputs yourself)', () => {
  const base = hrow('aaaa', '2026-08-30T00:00:00.000Z')
  for (const [what, row] of [
    ['title', { ...base, title: 'べつの題名' }],
    ['status', { ...base, status: 'error' as const }],
    ['branch', { ...base, gitBranch: 'other' }],
    ['tokens', { ...base, contextTokens: 12345 }],
  ] as const) {
    assert.notEqual(historyRev([row]), historyRev([base]), `the revision does not change when ${what} changes`)
  }
})
