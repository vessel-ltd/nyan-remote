import { createHash } from 'node:crypto'

import { isHistorySession, type LogPage, type SessionSummary, type SessionsPage } from '../../../shared/types.ts'
import { config } from '../config.ts'
import { discoverConfigDirs } from '../claude/configDirs.ts'
import { alreadyInTranscript, readInflight, sweepInflight, type Inflight } from '../claude/inflight.ts'
import { scanPanes, sweepPanes, type PaneScan } from '../claude/keys.ts'
import { hasPendingForSession, listPending } from '../permission.ts'
import { parseTranscriptPath } from './hook.ts'
import { readLogSince, readLogSlice } from '../claude/log.ts'
import { collectSessions, findTranscript } from '../claude/sessions.ts'
import { HttpError, type Ctx } from '../router.ts'
import { autoApproveFor } from '../autoApprove.ts'
import { ensureFollowWatch } from '../claude/follow.ts'
import { attach } from '../events.ts'
import { t } from '../../../shared/i18n.ts'

const DEFAULT_LIMIT = 60
const MAX_LIMIT = 300

/**
 * ★★ Shape it for the UI (**never expose `transcriptPath`** / `/code-review` 2026-08-21, low #4).
 *
 * ⚠️ It used to be returned as is, so **the host's absolute path was sent to the PWA every time**
 *    (`InflightMessage` does not declare it, so the type check passed too).
 */
export function forWire(i: Inflight): {
  text: string
  final: boolean
  at: string
  clipped?: boolean
} {
  return { text: i.text, final: i.final, at: i.at, ...(i.clipped ? { clipped: true } : {}) }
}

/**
 * ★★ Is that text "already stale"? (`/code-review` 2026-08-21, medium #1).
 *
 * ⚠️ When the hook stops (an escape hatch was set / an upgrade removed the endpoint / the disk filled up),
 *    **the previous message's file stays around**. After a few messages it also falls out of
 *    `alreadyInTranscript`'s matching, so **an old explanation shows above a new approval card**.
 *    ⇒ **Do not show text older than the newest time in the record** (both clocks are the same machine).
 * ⚠️ "While waiting for an approval" the record does not grow, so this check does not hide it (the intended use is preserved).
 */
export function isStale(inflight: Inflight, entries: { kind: string; text?: string; at?: string }[]): boolean {
  if (alreadyInTranscript(inflight.text, entries, inflight.final)) return true
  const at = Date.parse(inflight.at)
  if (Number.isNaN(at)) return true
  for (let i = entries.length - 1; i >= 0; i--) {
    const t = entries[i]?.at
    if (!t) continue
    const rec = Date.parse(t)
    // The record is newer = this text is already in the past
    return !Number.isNaN(rec) && rec > at
  }
  return false
}

/**
 * ★★ Copy the marker for "how a message from the phone would be delivered" (the per-session marker in HANDOFF).
 *
 * ⚠️⚠️ **No decision is made here.** The input is the answer of `scanPanes` (**the same function** that finds keystroke destinations);
 *    this just copies it. An independent implementation would disagree with the real one (`npm run keys` had 6 combinations).
 * ⚠️⚠️ **When unknown, fall to the `inbox` side** (fail-closed). Showing "probably keystroke-able"
 *    and then adding a frame goes as far as the receiver **replying to an unrelated session**.
 * ⚠️ Not added to sessions that are not alive (do not talk about routes for something you cannot send to).
 */
export function markSend(list: SessionSummary[], scan: PaneScan): SessionSummary[] {
  return list.map((s) => {
    if (!s.live) return s
    const hit = scan.bySession.get(s.sessionId)
    if (hit && !('reason' in hit)) return { ...s, sendRoute: 'keys' as const }
    // ⚠️ Not in the scan = unknown. If the index could not be read, do not conclude it is "absent"
    const reason = hit ? hit.reason : scan.skipped > 0 ? ('unverified' as const) : ('not-found' as const)
    return { ...s, sendRoute: 'inbox' as const, keysReason: reason }
  })
}

/**
 * ★★ Copy the auto-approve marker (2026-09-07).
 *
 * ⚠️⚠️ **No decision is made here** (it is in one place, `autoApproveFor`). Deciding "is it in effect" in two places
 *    leads to **the most dangerous disagreement**: "not shown on screen, yet passing".
 *
 * ⚠️⚠️ **Never hide it based on `live`** (codex 2026-09-07, high #3. **It did so at first**).
 *    Just because `sessions/<pid>.json` is **mid-write, corrupt or unreadable due to permissions**, the row becomes `live:false`,
 *    but **the allow decision does not look at the index**, so it keeps passing. ⇒ Hiding it means
 *    **"it passes, yet the banner and the off button disappear"** (the worst state for this feature).
 *    ★ "Sessions that are not alive get no approvals" is merely **the agent's guess**.
 *      Do not hide a dangerous state based on a guess (CLAUDE.md §2 "do not rely on your own comments").
 * ⚠️ Cost: history rows may get the marker too, so `historyRev` changes once (= history is refetched once).
 *    **Visibility matters more**, so this is accepted.
 */
export function markAutoApprove(list: SessionSummary[], now = Date.now()): SessionSummary[] {
  return list.map((s) => {
    const found = autoApproveFor(s.sessionId, now)
    return found ? { ...s, autoApprove: { until: found.until } } : s
  })
}

/** Cleanup interval. ⚠️ The list arrives every few seconds, so do not readdir every time */
const SWEEP_EVERY_MS = 5 * 60 * 1000
let lastSweep = 0

/**
 * ⚠️ For tests. `lastSweep` is **one per process** (the list arrives every few seconds, so no readdir every time).
 *    Checking twice in one test file that "the cleanup runs" makes the second one hit the interval.
 */
export function resetSweepForTest(): void {
  lastSweep = 0
}

/**
 * ★★ The history **revision**. ⚠️ Built from **the very rows passed to the PWA**.
 *
 * ⚠️⚠️ **A count is not enough** (codex round 1, medium #2). At the limit (`maxSessionsPerAccount`),
 *    one enters and one is pushed out, so **the contents change while the count stays the same**.
 * ⚠️⚠️ **Do not pick the inputs yourself** (codex round 2, medium #2). At first it was `sessionId + lastActivity`,
 *    but that missed the path where **`away_summary` is appended about 3 minutes after a session ends**
 *    (`awaySummary` and `transcriptBytes` change while `lastActivity` is deliberately
 *    left as is) ⇒ a PWA that already fetched it **never receives the summary**.
 *    ⇒ Use **the row's JSON itself** as input (= if anything shown on screen changes, the revision always changes).
 * ⚠️ Do not depend on ordering (`collectSessions` sorts by mtime, so the same set can change order).
 * ⚠️ The revision **is an outward value but not conversation content** (a hash, so it cannot be reversed / §6.2).
 */
export function historyRev(rows: readonly SessionSummary[]): string {
  const h = createHash('sha1')
  for (const s of [...rows].sort((a, b) => a.sessionId.localeCompare(b.sessionId))) {
    h.update(JSON.stringify(s))
    h.update('\0')
  }
  return h.digest('base64url').slice(0, 16)
}

/**
 * The list.
 *
 * ★★ **`?live=1` returns only "the active ones"** (2026-08-31 / ARCHITECTURE §14.1.1.7).
 *   Measured: `GET /sessions` was **87%** of the bandwidth (70,891 B per call / 159 items), of which
 *   **only 2 were active**. The other 157 were **unchanging history resent every 6.5 seconds**.
 *
 *   (no query) … all items as before (when the PWA opens "history", and **old PWAs**)
 *   ?live=1    … only the active ones + the history count and revision
 *
 * ⚠️⚠️ **Never make filtering the default** (done once on 2026-09-01 and reverted after codex medium #1).
 *    Old PWAs read no-query as all items, so **the whole history would vanish**.
 *    PWAs keep old bundles in the Service Worker, and in a symmetric mesh
 *    "only one side is new" always happens. ⇒ **The new side opts in**.
 * ⚠️ The history **count and revision are always returned** (whether filtered or not).
 */
export async function sessions(ctx?: Ctx): Promise<SessionsPage> {
  const cfg = config()
  const dirs = await discoverConfigDirs(cfg.configDirs)
  const { machine, sessions } = await collectSessions(dirs, cfg.maxSessionsPerAccount)
  // ★ Discard inflight entries that are no longer needed (those of live sessions are kept).
  //   ⚠️ It is done here because **this is the only place holding the list of live sessions**
  const now = Date.now()
  // ⚠️⚠️ **Do not clean up if nothing could be read** (codex 2026-08-21, medium #7).
  //    Mixing "no sessions" with "could not read" **deletes live sessions' text**.
  if (sessions.length > 0 && now - lastSweep > SWEEP_EVERY_MS) {
    lastSweep = now
    // ★★ The cleanup set needs more than "the display list" (codex 2026-08-21, medium #5).
    //    The list is **capped and only includes those with a transcript**, so
    //    **sessions waiting for approval without a transcript** are missing ⇒ their text would be deleted.
    //    ⇒ **Add the sessionIds of pending approvals**.
    const keep = new Set(sessions.map((s) => s.sessionId))
    for (const p of listPending()) if (p.sessionId) keep.add(p.sessionId)
    void sweepInflight(keep, now)
    // ★ Also clean up registrations nobody removed (leftovers of relays killed with SIGKILL).
    //   ⚠️ Only those whose "process is gone" are removed (`sweepPanes` in `keys.ts`)
    void sweepPanes()
  }
  // ★ Markers for all items are built from **one scan** (calling findPane per session would scan the index quadratically)
  const marked = markAutoApprove(markSend(sessions, await scanPanes(dirs)), now)
  // ⚠️⚠️ **Filtering comes after the cleanup** (`sweepInflight` / `sweepPanes` above decide on **all items**).
  //    Moving it earlier breaks two things:
  //      1) during periods with 0 active sessions (all idle) **the cleanup never runs**
  //         (it hits the `sessions.length > 0` guard)
  //      2) `keep` shrinks and **deletes "not yet written" text on the history side**
  //         (the set was widened once in codex 2026-08-21, medium #5. Do not narrow it)
  const historyRows = marked.filter(isHistorySession)
  const liveOnly = ctx?.url.searchParams.get('live') === '1'
  return {
    machine,
    sessions: liveOnly ? marked.filter((s) => !isHistorySession(s)) : marked,
    history: { count: historyRows.length, rev: historyRev(historyRows) },
  }
}

/**
 * The thread contents.
 *   ?before=<byte>  read before that byte offset (= the older side)
 *   ?since=<byte>   read only what was appended from that byte offset on (live follow)
 *   ?limit=<n>      number of items (default 60 / max 300)
 */
export async function sessionLog(ctx: Ctx): Promise<LogPage> {
  const sessionId = ctx.params['id']
  if (!sessionId) throw new HttpError(400, t('session id が必要です', 'A session id is required.'))

  const cfg = config()
  const dirs = await discoverConfigDirs(cfg.configDirs)
  const before = intOrNull(ctx.url.searchParams.get('before'))
  const found = await findTranscript(dirs, sessionId)
  if (!found) {
    // ★★ Even for **a session whose transcript has not a single line yet** (the shape where the first turn waits for approval),
    //    if there is "not yet written" text, **return a page with just that** (codex 2026-08-21, high #2).
    //    ⚠️ This used to be a 404, so **in the scene you want it most** (the first approval) no explanation appeared.
    // ⚠️ Reading backwards (before) stays 404 (there is nothing older).
    if (before === null) {
      const only = await readInflight(sessionId)
      // ⚠️⚠️ **Even without text, if an approval is pending, return an "empty" 200**
      //    (codex 2026-08-21, high #1). A 404 here is ignored by the UI as an exception, so
      //    `setInflight(undefined)` is never reached, and **the previous text stays as the next approval card's explanation**
      //    (meant as fail-closed, it turned into "keeps showing an old lie").
      if (only || hasPendingForSession(sessionId)) {
        // ★ The account is looked up with the shared function (same review, low #5. A hand-rolled `startsWith`
        //   check silently misses on trailing slashes, symlinks and `//`)
        const account = parseTranscriptPath(only?.transcriptPath).account ?? ''
        return {
          sessionId,
          account,
          entries: [],
          cursor: null,
          tail: 0,
          bytes: 0,
          ...(only ? { inflight: forWire(only) } : {}),
        }
      }
    }
    // ⚠️ It may "not be written yet". A session that waits for approval on its first turn
    //    has not written a single line of transcript (hit on a real device on 2026-08-12).
    //    Do not dead-end; say what to do next
    throw new HttpError(
      404,
      t('このセッションの記録はまだありません（開始直後か、承認待ちで止まっています）', 'This session has no transcript yet (it just started, or it is paused waiting for approval).'),
    )
  }

  const limit = clampInt(ctx.url.searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT)
  const since = intOrNull(ctx.url.searchParams.get('since'))

  const slice =
    since !== null
      ? await readLogSince(found.path, since)
      : await readLogSlice(found.path, limit, before ?? undefined)

  // ★★ Add "text not yet written" (the explanation while waiting for approval).
  // ⚠️ Not returned when reading backwards (before). It is **about now**, so attaching it to old pages mixes things up.
  // ⚠️ Not shown if it is already in the transcript (the same text would appear twice).
  //    ★ Also returned for since (live follow). ⇒ The UI replaces it each time with "the current inflight"
  const inflight = before === null ? await readInflight(sessionId) : undefined
  const showInflight = inflight && !isStale(inflight, slice.entries) ? forWire(inflight) : undefined

  return {
    sessionId,
    account: found.dir.account,
    entries: slice.entries,
    cursor: slice.cursor,
    tail: slice.tail,
    bytes: slice.bytes,
    ...(showInflight ? { inflight: showInflight } : {}),
  }
}

function intOrNull(raw: string | null): number | null {
  if (raw === null) return null
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : null
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw === null ? NaN : Number(raw)
  if (!Number.isInteger(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * ★★ Follow a thread (`GET /sessions/:id/follow` / 2026-09-23). Streams only "something was added" over SSE.
 *
 * ⚠️⚠️ A subscription opened **only by devices viewing that session** (separate from `/events` = never flows to devices not viewing it).
 *    No text is included (just a signal ⇒ the PWA fetches the diff with `GET /sessions/:id/log?since=`).
 * ⚠️ The id also becomes a path component (`inflight/<id>.jsonl`), so **only the same shape as records** is accepted.
 */
export function sessionFollow(ctx: Ctx): undefined {
  const sessionId = ctx.params['id']
  if (!sessionId || !/^[A-Za-z0-9._-]+$/.test(sessionId)) throw new HttpError(400, t('session id の形が正しくありません', 'The session id is malformed.'))
  attach(ctx.res, { follow: sessionId })
  ensureFollowWatch()
  return undefined // attach keeps holding the response
}
