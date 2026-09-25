/**
 * ★★ How the amount of context is shown (2026-08-19).
 *
 * ⚠️⚠️ **No percentage.** The window size (1M / 200k) cannot be known from the transcript
 *    (`model` does not carry `[1m]`, nor does `sessions/<pid>.json`; checked against the real files).
 *    ⇒ **Do not guess an unknown window** (this tool's discipline). Show the count only.
 * ⚠️ For the same reason, **no colour either**. "Orange above 600k" would assume a 1M window
 *    (a 200k-window session would never turn orange = the signal would not work).
 */

// ★ The implementation moved to `shared/types.ts` (agent-side notifications use the same rounding).
//   ⚠️ Keeping two copies means fixing only one makes **the list and the notification disagree** (same reason as `statusLabel`).
export { formatTokens } from '../../../shared/types.ts'
