// ★★ Scrolling back through the thread by "your own messages" (2026-09-24 / user request).
//
// ★ Just loading 60 more at a time on a long session, you lose track of how far back you are. Your own messages (= what you asked for)
//   are the clearest landmarks ⇒ "↑ My message" jumps to **the nearest own message above what you are looking at**.
//   If none is loaded, **load older ones until one is found**, then jump (with a cap).
// ⚠️ The decision lives here (`.tsx` has no behavioural tests). The screen only passes DOM positions.

import type { LogEntry } from '../../../shared/types.ts'

/**
 * ★ Is it your own message? (⚠️ `via:'peer'` inbox messages from another session are not yours. Those sent from the phone are.)
 * ⚠️ Background-task completion notices (`<task-notification>`) are also recorded as "you", but **you did not say them**
 *    ⇒ not a jump target (seen on 2026-09-24 in the real thing: the second press landed there).
 */
export function isMine(e: LogEntry): boolean {
  return e.kind === 'user' && e.via !== 'peer' && !e.text.trimStart().startsWith('<task-notification>')
}

/** ★ Cap on pages loaded per press (⚠️ even if a long stretch has no own messages, do not keep loading forever) */
export const MAX_SCROLLBACK_PAGES = 5

/** ★ Margin counted as "above" for what hides under the header bar (do not re-select a message sitting just under the bar) */
export const MINE_SLACK_PX = 8

/**
 * ★ The nearest own message above what you are looking at.
 * @param tops top edges of own messages (screen coordinates, document order)
 * @param viewTop top of the visible area (bottom of the sticky bar)
 * @returns index, or -1 if none (⇒ load more)
 */
export function pickPrevMine(tops: readonly number[], viewTop: number): number {
  for (let i = tops.length - 1; i >= 0; i--) {
    if (tops[i]! < viewTop - MINE_SLACK_PX) return i
  }
  return -1
}

/** ★ Keep loading? (⚠️ stop when an own message arrives, nothing older remains, or the cap is hit) */
export function keepLoading(page: { entries: readonly LogEntry[]; cursor: number | null }, pagesSoFar: number): boolean {
  if (page.cursor === null) return false
  if (pagesSoFar >= MAX_SCROLLBACK_PAGES) return false
  return !page.entries.some(isMine)
}

/**
 * ★★ **Stay where you were** after loading more above (2026-09-24).
 * ⚠️ iPhone Safari has no scroll anchoring ("keep position when content is added above"), so scroll back down by the added amount.
 *    Chrome keeps position itself, so disable that while loading and do it ourselves (no double movement / `Thread.tsx`).
 */
export function anchoredScrollY(before: { scrollY: number; height: number }, heightAfter: number): number {
  return before.scrollY + (heightAfter - before.height)
}

/**
 * ★ The first visible element (anchor for alignment / 2026-09-24 / codex round 19, medium #2).
 * @param bottoms bottom edges of `.thread`'s children (screen coordinates, document order)
 * @returns index, or -1 if none (⇒ align by the height difference)
 */
export function firstVisibleIndex(bottoms: readonly number[], viewTop: number): number {
  return bottoms.findIndex((b) => b > viewTop)
}

/**
 * ★★ When "↑ My message" is shown (2026-09-25 / user request).
 *   ⚠️ **Not at the bottom** (like "↓ Latest"): reading a long reply at the bottom, the button sat over the text.
 *   ⚠️ **And only with a message of yours above** the view — or older pages not loaded yet (one may be there; pressing reads them).
 */
export function showMineJump(o: { loading: boolean; atBottom: boolean; hasPrevMine: boolean; moreToLoad: boolean }): boolean {
  return !o.loading && !o.atBottom && (o.hasPrevMine || o.moreToLoad)
}

