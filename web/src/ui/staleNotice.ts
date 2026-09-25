// Only the decision whether to show "Please answer on the PC", extracted (so it can be tested).
//
// ⚠️⚠️ **This warning lies easily.** What appeared on a real device on 2026-08-14:
//   tap Allow on the phone → the mark disappears at once → **but the list state stays `waiting` for a few seconds**
//   → "This approval cannot be answered from the phone. Please answer on the PC" showed for 4–5 seconds.
//   **Right after answering it on the phone yourself.**
//
// The agent also drops the label now (`clearLabelIfSettled`), but the re-fetch round trip
// always remains, so **the screen keeps a grace period too**. With only one side it recurs depending on device and SSE state.
//
// ★ But **it must not be suppressed**. For approvals that truly cannot be answered (agent restart, timeout,
//   hook not installed), **telling you where to answer is this warning's job**. Show it once the grace period ends.

export const NO_ANSWERABLE_GRACE_MS = 6000

/**
 * @param noAnswerable "no answerable mark" and "state is waiting for approval"
 * @param staleSince   when it entered that state (null if it has not)
 */
export function shouldShowNoAnswerable(
  noAnswerable: boolean,
  staleSince: number | null,
  now: number,
  graceMs: number = NO_ANSWERABLE_GRACE_MS,
): boolean {
  if (!noAnswerable) return false
  if (staleSince === null) return false
  return now - staleSince > graceMs
}

/**
 * ★★ Resetting the grace period (2026-08-18 `/code-review`, medium #2).
 *
 * ⚠️ Holding `staleSince` in a ref **keeps the old time even when the target changes**.
 *    The hole that actually opened: jumping from A → B via the bar's second line, if A's grace had ended,
 *    **B's first render immediately showed "Please answer on the PC"**
 *    (B may have just been answered).
 *    `<Thread>` has no key, so **it is not recreated when the session changes**;
 *    hence **always recreate it here when the key changes**.
 *
 * @param key identifier of the target (session + endpoint, etc.). A change restarts the grace period
 * @param active whether we are in a state where the grace period should be counted
 */
export interface StaleGate {
  key: string
  since: number | null
}

export function armStale(prev: StaleGate, key: string, active: boolean, now: number): StaleGate {
  if (prev.key !== key) return { key, since: active ? now : null }
  if (!active) return prev.since === null ? prev : { key, since: null }
  return prev.since === null ? { key, since: now } : prev
}

/**
 * Whether to show it. **Do not wait if we came with information that already passed the grace period on another screen**.
 *
 * ⚠️ The bar's second line (grey = handle on the PC) is shown **only after its own 6-second grace period**.
 *    Waiting another 6 seconds after jumping from it means **the person who pressed it sees a screen with no reason
 *    for 6–9 seconds** (`⚠️ needsClock` ticks every 3 s, so up to 9 s).
 *    Having decided "press = the explanation appears" (ARCHITECTURE §9.12.1), we do not wait there
 *    (same-day `/code-review`, low #3).
 */
export function showStale(
  active: boolean,
  gate: StaleGate,
  now: number,
  confirmed: boolean,
): boolean {
  if (!active) return false
  if (confirmed) return true
  return shouldShowNoAnswerable(active, gate.since, now)
}

/**
 * ★★ **Lifetime** of the "jumped from grey" mark (2026-08-18 codex review, medium #1).
 *
 * ⚠️⚠️ Keyed only by session ID, **it skips the grace period for as long as that thread is open**.
 *    codex's repro: jump from grey to B → B's wait clears → **a new approval in the same B**
 *    is answered on the phone → the mark goes but `waiting` remains → the mark is still alive, so
 *    **it skips the grace period and immediately lies "Please answer on the PC"** (= exactly the lie of 2026-08-14).
 *
 * ★ The mark is needed **only right after the press**. The grace period at the destination starts counting on entry,
 *   so after it ends the result is the same without the mark. Hence **discard it at twice the grace period**
 *   (expiring right at the end would make it vanish once and reappear at that instant, so take a bit longer).
 */
export const CONFIRMED_WAIT_TTL_MS = 2 * NO_ANSWERABLE_GRACE_MS

export interface ConfirmedWait {
  sessionId: string
  /** When it was pressed */
  at: number
}

export function isConfirmedWait(
  mark: ConfirmedWait | null,
  sessionId: string,
  now: number,
): boolean {
  if (mark === null || mark.sessionId !== sessionId) return false
  return now - mark.at < CONFIRMED_WAIT_TTL_MS
}
