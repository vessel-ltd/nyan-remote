/**
 * ★★ Decisions for the thread's "landing point" and "signal" (2026-08-19).
 *
 * ⚠️⚠️ **This used to live inside a `.tsx`, so mutation tests could not turn it red**
 *    (it cannot be imported from `node:test`). It was guarded by string matching,
 *    but codex showed that "a mutant reverting the boundary condition slips through".
 *    ⇒ Split: **the screen (`.tsx`) measures, this file (pure functions) decides**.
 *
 * All units are CSS px. `top` / `bottom` are `getBoundingClientRect()` values
 * (top of the screen is 0, downward is positive).
 */

/**
 * ★ Is "the boundary between the end of the log and the start of the cards" on screen?
 *
 * ⚠️⚠️ **Never drop `top >= 0`.** Without it, it is also true for **someone reading inside a card**
 *    (the boundary is above the screen), and the moment the next card arrives it **yanks them back several screens**
 *    (2026-08-19 codex review, medium #1).
 */
export function boundaryVisible(top: number | undefined, viewportH: number): boolean {
  if (top === undefined) return false
  return top >= 0 && top < viewportH
}

/** How the approval card area relates to the "actually visible range" */
export interface PermArea {
  /** Is any part within the visible range? */
  visible: boolean
  /** The **top** is clipped (the signal arrow becomes ↑) */
  clippedAbove: boolean
  /** The **bottom** is clipped (= unseen approval or answer buttons are below) */
  clippedBelow: boolean
}

/**
 * ★★ Does the approval card area fit within the "actually visible range"?
 *
 * ⚠️⚠️ **Do not use `0 … screen height` as the visible range** (2026-08-19 codex round 3, low #5).
 *    There is a **sticky bar** on top and a **permanent input box** at the bottom; what is behind them is not visible.
 *    ⇒ The caller passes `usableTop` / `usableBottom` **as measured**.
 * ⚠️⚠️ **Measure the approval cards themselves** (`.permswrap`). It used to measure "boundary to page end",
 *    so **sending an instruction stacked optimistic entries below and counted as "visible",
 *    and no signal appeared even when the cards scrolled away upward** (same review, medium #2).
 * ⚠️ When it cannot be measured, **`visible: true` (no signal)**. Erring towards showing would
 *    flash "Approval needed" for the instant before it is drawn.
 */
export function permArea(
  top: number | undefined,
  bottom: number | undefined,
  usableTop: number,
  usableBottom: number,
): PermArea {
  if (top === undefined || bottom === undefined) {
    return { visible: true, clippedAbove: false, clippedBelow: false }
  }
  return {
    visible: top < usableBottom && bottom > usableTop,
    clippedAbove: top < usableTop,
    clippedBelow: bottom > usableBottom,
  }
}

/**
 * ★ Whether to show the signal ("⚠ Approval needed (N)").
 *
 * **Hidden only when everything is within the visible range.** Shown if the top or the bottom is clipped.
 * ⚠️ It used to be "hide if any part is visible", so **it vanished for a tall card with only its bottom edge visible**
 *    (2026-08-19 codex round 3, low #5).
 */
export function needsPermSignal(area: PermArea, count: number): boolean {
  if (count === 0) return false
  return area.clippedAbove || area.clippedBelow
}

/**
 * ★ Which way to move when the signal is pressed.
 *
 * ⚠️⚠️ **Where it returns `down`, "re-centring on the boundary" makes the press do nothing**
 *    (2026-08-19 codex round 3, medium #3. **A regression I introduced**. Right after landing the boundary is already centred,
 *    so `settleView` does nothing = "one tap to the answer buttons" was a lie).
 */
export function signalTarget(area: PermArea): 'up' | 'down' {
  return area.clippedBelow ? 'down' : 'up'
}

/**
 * ★★ Did approval cards **increase**? (compared as a set of keys)
 *
 * ⚠️⚠️ Do not scroll when they decrease or are reordered. **You get yanked back the moment you answer**
 *    (2026-08-19 codex review, medium #1).
 */
export function addedKeys(prev: readonly string[], next: readonly string[]): number {
  const before = new Set(prev.map(baseKey))
  return next.filter((k) => !before.has(baseKey(k))).length
}

/**
 * ★★ Strip the **generation** from an approval key (2026-08-19 codex round 3, medium #1).
 *
 * The agent returns `keyOf(...)#<6 random bytes>` (`withGeneration` in `agent/src/permission.ts`,
 * **so an old card's "Allow" cannot go to a later request**).
 * ⚠️⚠️ Comparing keys as-is means **the same approval merely re-entering the hook counts as "increased"**,
 *    which **moves your reading position** even though the count did not change.
 * ⚠️ Even with the generation stripped, different approvals always differ in the `keyOf` content
 *    (tool, arguments, session, agent), so they are not confused.
 */
export function baseKey(key: string): string {
  const i = key.lastIndexOf('#')
  return i < 0 ? key : key.slice(0, i)
}
