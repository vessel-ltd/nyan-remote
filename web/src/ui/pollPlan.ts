// ★★ Schedule for re-fetching the list (2026-09-24 / user decision / HANDOFF 5.0-ci).
//
// ★ The list is **already event-driven** (the agent signals on state changes, hooks and approvals coming and going; the PWA re-fetches).
//   Polling every 15 s is **insurance** (for a missed signal, or a dropped line).
//   ⇒ Endpoints whose signal line is alive: **60 s**; otherwise **15 s**.
//   ⚠️⚠️ "Stop after a while without interaction" is **not adopted** (some devices are 24-hour monitors / user decision).
// ★★ **Back off on repeated failures** (30 s → 1 min → 2 min → 4 min → 5 min). Reset on success.
//   ⚠️ Measured: an unpaired device kept handshaking with machine B **every 15 s and being refused** (1,513 times overnight).
//   ⚠️ By design the reason a handshake was refused is not returned (no plaintext outside the envelope) ⇒ "not registered" and
//      "agent is down" cannot be told apart ⇒ **back off instead of stopping** (if it stops, it never comes back).
// ⚠️ **User actions** (send, confirm, refresh button) bypass this schedule (they go out immediately).

export const POLL_FAST_MS = 15_000
export const POLL_SLOW_MS = 60_000
export const POLL_MAX_BACKOFF_MS = 300_000
/**
 * ★ The tick at which the schedule is checked (⚠️ every interval is a multiple of it = lands on a tick).
 * ⚠️ So that clock jitter (`setInterval` can fire at 14,998 ms) does not delay by one tick,
 *    the check allows `POLL_SLACK_MS` of slack (without it 15 s turns into 30 s).
 */
export const POLL_TICK_MS = 15_000
export const POLL_SLACK_MS = 1_000

export interface PollState {
  /** When the last fetch **started** (ms). ⚠️ Absent = "never yet" = fetch now
   *  ⚠️ Using the end time would miss the next tick by the response time and delay by one tick */
  lastAt?: number
  /** Consecutive failures (0 on success) */
  failures: number
  /**
   * ★ Fetched, but part was missing (the approval list could not be fetched / codex round 17, medium #3).
   * ⚠️ Re-fetch in **15 s** even if the signal line is alive (do not leave approval cards empty for 60 s).
   * ⚠️ Not counted as a failure (do not stretch old agents without `/permissions` to 5 min = stays 15 s as before).
   */
  partial?: boolean
}

/** ★ Interval until the next fetch */
export function pollInterval(eventsLive: boolean, failures: number, partial = false): number {
  if (failures > 0) return Math.min(POLL_FAST_MS * 2 ** failures, POLL_MAX_BACKOFF_MS)
  return eventsLive && !partial ? POLL_SLOW_MS : POLL_FAST_MS
}

/** ★ Is it time to fetch now? */
export function isPollDue(s: PollState | undefined, eventsLive: boolean, now: number): boolean {
  if (!s || s.lastAt === undefined) return true
  return now - s.lastAt >= pollInterval(eventsLive, s.failures, s.partial) - POLL_SLACK_MS
}

/** ★ Remember how a fetch went (⚠️ success resets the failure count to 0) */
export function notePoll(
  s: PollState | undefined,
  ok: boolean,
  startedAt: number,
  o: { partial?: boolean } = {},
): PollState {
  return { lastAt: startedAt, failures: ok ? 0 : (s?.failures ?? 0) + 1, partial: ok && o.partial === true }
}
