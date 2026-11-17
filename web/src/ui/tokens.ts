/**
 * ★★ How the amount of context is shown (2026-08-19).
 *
 * ⚠️⚠️ **No percentage.** The window size (1M / 200k) cannot be known from the transcript
 *    (`model` does not carry `[1m]`, nor does `sessions/<pid>.json`; checked against the real files).
 *    ⇒ **Do not guess an unknown window** (this tool's discipline). Show the count only.
 * ★ 2026-11-17: a percentage is shown **when the tool itself reports it** (Claude's status line
 *    `context_window.used_percentage`) — still never computed here.
 * ⚠️ For the same reason, **no colour either**. "Orange above 600k" would assume a 1M window
 *    (a 200k-window session would never turn orange = the signal would not work).
 */

import type { SessionSummary } from '../../../shared/types.ts'

// ★ The implementation moved to `shared/types.ts` (agent-side notifications use the same rounding).
//   ⚠️ Keeping two copies means fixing only one makes **the list and the notification disagree** (same reason as `statusLabel`).
export { formatTokens } from '../../../shared/types.ts'

/** The ctx chip: `ctx 212k · 21%`, `ctx 212k`, `ctx 21%`, or nothing */
export function ctxText(tokens: string | undefined, percent: number | undefined): string | undefined {
  const pct = percent === undefined ? undefined : `${Math.round(percent)}%`
  const parts = [tokens, pct].filter((x): x is string => Boolean(x))
  return parts.length > 0 ? `ctx ${parts.join(' · ')}` : undefined
}

/** The model chip: `Opus 5.5 · high`, the model alone, or nothing (an effort without a model is not shown alone) */
export function modelText(s: Pick<SessionSummary, 'model' | 'effort'>): string | undefined {
  if (!s.model) return undefined
  return s.effort ? `${s.model} · ${s.effort}` : s.model
}
