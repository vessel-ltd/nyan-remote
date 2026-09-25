// ★★ The decision to "fetch history separately" (2026-08-31 / ARCHITECTURE §14.1.1.7).
//
// **Why**: `GET /sessions` was 87% of the bandwidth. Measured 61,038 B / 130 rows, of which **only 1 was live**;
// the rest was **unchanging history re-sent every 9.2 seconds**.
// ⇒ By default the agent returns only "what is live" plus **the history count**; history is fetched when opened.
//
// ⚠️⚠️ **Keep only pure functions here** (in a `.tsx` it cannot be checked mechanically; in this repo
//    3 of 8 rounds had fixes that "had the shape but were semantically dead" / HANDOFF).
// ⚠️ **Do not write** the "is this history?" check here. Use `isHistorySession` from `shared/types.ts`
//    (unless it is the same rule as the agent's filtering, rows disappear from the list).

import { isHistorySession, type SessionSummary, type SessionsPage } from '../../../shared/types.ts'

export interface ListState {
  /** What is live (= what the agent returns by default) */
  sessions: SessionSummary[]
  /** History fetched so far. ★ Empty by default (not fetched until opened) */
  history: SessionSummary[]
  /** **Total** history count. ⚠️ Differs from `history.length` (while collapsed we hold 0 rows) */
  historyCount: number
  /**
   * ★★ The history **revision** the agent reported. ⚠️ `null` for old agents (that do not return `history`).
   *
   * ⚠️⚠️ **Do not compare by count** (codex medium #2). At the cap, one row enters and one is pushed out,
   *    so **the contents change while the count stays the same** ⇒ new history is never fetched.
   */
  rev: string | null
  /** ★ Revision of the history we hold (meaningless while `everFetched` is false) */
  loadedRev: string | null
  /**
   * ★★ **Whether history has been fetched at least once** (2026-09-01 codex round 2, medium #1).
   *
   * ⚠️⚠️ **Do not represent "never queried" as `rev === loadedRev === null`.**
   *    That makes "never fetched yet" and "old agent that reports no revision" the same shape,
   *    so **history is not fetched even if it is open at startup** (this actually happened).
   *    ⇒ Keep "fetched?" as a **separate flag** (same lesson as: never use a possible value as a sentinel).
   */
  everFetched: boolean
}

export const EMPTY_LIST: ListState = {
  sessions: [],
  history: [],
  historyCount: 0,
  rev: null,
  loadedRev: null,
  everFetched: false,
}

/**
 * Fold a response into the state.
 *
 * ⚠️⚠️ **Do not infer "did it include history" from the row count.** It cannot be told apart from the
 *    correct response "asked with `?history=1` but 0 history rows" ⇒ **pass whether we asked as an argument**
 *    (CLAUDE.md: "do not infer the receiver's meaning from the stored shape").
 * ⚠️ Old agents (no `history`) return **all rows** in `sessions`. Do not confuse with 0 rows.
 */
export function applyPage(
  page: SessionsPage,
  opts: { requestedHistory: boolean; prev: ListState },
): ListState {
  const rows = page.sessions ?? []
  const live = rows.filter((s) => !isHistorySession(s))
  const inPage = rows.filter(isHistorySession)
  // ★ Old agents return everything, so split here (the rule lives in one place in shared)
  const legacy = page.history === undefined
  if (legacy) {
    // ★ Old agents do not filter either, so **what just arrived is everything** (= already fetched)
    return {
      sessions: live,
      history: inPage,
      historyCount: inPage.length,
      rev: null,
      loadedRev: null,
      everFetched: true,
    }
  }
  const historyCount = page.history?.count ?? 0
  // ★ Even an agent that reports no revision (has `history` but no `rev`) **can at least compare counts**.
  //   ⚠️ Leaving it `null` makes it the same shape as an "old agent", and changes are never noticed.
  const rev = page.history?.rev ?? `n${historyCount}`
  if (opts.requestedHistory) {
    return { sessions: live, history: inPage, historyCount, rev, loadedRev: rev, everFetched: true }
  }
  // ⚠️ We did not ask, so **keep the previous history** (do not clear it on every response;
  //    clearing makes history vanish and reappear every 15 seconds while it is open)
  // ⚠️⚠️ **Do not put `rev` into `loadedRev`** (the mutation codex named on 2026-09-01).
  //    Doing so counts as "fetched" without fetching, and **new history is never fetched**
  return {
    sessions: live,
    history: opts.prev.history,
    historyCount,
    rev,
    loadedRev: opts.prev.loadedRev,
    everFetched: opts.prev.everFetched,
  }
}

/**
 * Rows used for display.
 *
 * ⚠️⚠️ **`--resume` revives a history session** (the same sessionId is in both).
 *    Without folding, **the same row appears twice**, so **the live one wins** (it is newer information).
 */
export function combineRows(s: ListState): SessionSummary[] {
  const liveIds = new Set(s.sessions.map((x) => x.sessionId))
  return [...s.sessions, ...s.history.filter((h) => !liveIds.has(h.sessionId))]
}

/**
 * Whether to fetch history.
 *
 * ★ **A history row's process has ended = it no longer changes**, so it is enough to refetch
 *   only when "the count does not match" (this relies on that property).
 *   ⇒ Even left open, it stays at 466 B until something is added.
 *
 * ⚠️ `missingOpenSession` … when the open thread's row is nowhere to be found.
 *    Happens when opening a history session from a notification / restoring on reload.
 *    Without fetching, it becomes **a thread with no title and no status**.
 */
export function shouldFetchHistory(o: {
  open: boolean
  missingOpenSession: boolean
  state: ListState
}): boolean {
  // ⚠️⚠️ **Do not make `missingOpenSession` unconditionally true** (a hole I found myself on 2026-09-01).
  //    If an old session ID that overflowed the list cap is left open, even after history is fetched
  //    we would keep fetching everything every time = **the 87% waste comes straight back**.
  //    ⇒ Limit it to "while not fully fetched" (give up if it is not found after fetching everything).
  if (!o.open && !o.missingOpenSession) return false
  // ★★ **If never fetched, fetch** (before looking at revisions). ⚠️ Mixing this into the revision compare
  //    means right after startup (no `rev` and no `loadedRev`) it says "same, so don't fetch", and
  //    **history is empty for up to 15 seconds until the next poll** (codex round 2, medium #1).
  if (!o.state.everFetched) return true
  return o.state.loadedRev !== o.state.rev
}

/**
 * How to fold when an endpoint goes down.
 *
 * ⚠️ Sessions on a down machine must not claim to be "running" (external review of 2026-08-12).
 *    Dropping `live` **moves them into the history box**, so **move where they are counted to history too**
 *    (otherwise only the number in the collapsed heading stays stale).
 * ⚠️ Called every 15 seconds, so it must **not keep growing** (`sessions` is emptied, so later calls add nothing).
 */
export function markOfflineList(s: ListState): ListState {
  const downgraded = s.sessions.map((x) => ({ ...x, live: false, status: 'idle' as const }))
  const known = new Set(s.history.map((h) => h.sessionId))
  const added = downgraded.filter((d) => !known.has(d.sessionId))
  // ⚠️ **Replace** ones already in history (codex low #1). If skipped, when a session revived by `--resume`
  //    goes down again, **the old snapshot** (the previous `lastActivity`) remains.
  const fresh = new Map(downgraded.map((d) => [d.sessionId, d]))
  return {
    sessions: [],
    history: [...s.history.map((h) => fresh.get(h.sessionId) ?? h), ...added],
    historyCount: s.historyCount + added.length,
    rev: s.rev,
    loadedRev: s.loadedRev,
    // ⚠️⚠️ **Withdraw "fetched"** (2026-09-01 codex round 2, medium #3).
    //    Rows made here were **added by us on our own**, so they do not match the agent's revision.
    //    If not withdrawn: disconnect during a live session under 1KB → added to our history →
    //    later the process ends but the agent does not list sessions under 1KB = **the revision does not change**
    //    ⇒ `loadedRev === rev` stays, it is never refetched, and **a ghost row remains forever**.
    everFetched: false,
  }
}

/**
 * ★★ Pick the endpoint that owns the session.
 *
 * ⚠️⚠️ **Look for live ones first** (2026-09-01 codex round 2, high #2).
 *    If the same `sessionId` exists "as history on A and as a `--resume`d live session on B",
 *    searching from the top with history mixed in **makes A the owner and keeps reading the old log**
 *    (polling does not fix it).
 * ⚠️ Nor decide by history alone (the previous high #1). `s.sessions` is live only, so
 *    opening history held by the second machine is not found and falls to `transports[0]`.
 * ⇒ Two stages: **search live across all endpoints → if not found, search history**.
 *
 * ⚠️ Do not write this inside a `.tsx` (it cannot be checked mechanically; in this repo a bug actually passed green).
 */
export function pickOwner<T extends ListState>(all: readonly T[], sessionId: string): T | undefined {
  return (
    all.find((s) => s.sessions.some((x) => x.sessionId === sessionId)) ??
    all.find((s) => s.history.some((x) => x.sessionId === sessionId))
  )
}

/**
 * ★ The row used for display. ⚠️ **Same priority as `pickOwner`** (live first).
 *    Written separately, you get "the owner is B, but the row shown is A's old history".
 */
export function pickRow<T extends ListState>(
  all: readonly T[],
  sessionId: string,
): SessionSummary | undefined {
  const owner = pickOwner(all, sessionId)
  if (!owner) return undefined
  return (
    owner.sessions.find((x) => x.sessionId === sessionId) ??
    owner.history.find((x) => x.sessionId === sessionId)
  )
}
