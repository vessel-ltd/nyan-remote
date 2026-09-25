// The one place that decides how auto-approve mode looks (same role as `stop.ts` / `commands.ts`).
//
// ★★ This feature is the **opposite** of "stalls if you don't notice": **it keeps running if you don't notice**.
//   => The screen's job is to "keep showing that it is on" and to "turn it off in one tap".
//
// ⚠️⚠️ **Do not decide whether it is in effect using the device clock.**
//   `SessionSummary.autoApprove` is set **only when the agent, by its own clock, judges it still valid**
//   (`markAutoApprove` in `routes/sessions.ts`). Re-checking the expiry against the phone's clock
//   causes **"looks off but approvals still go through" for as long as the clocks disagree**
//   (the same trap as §2's "comparing with the device clock misjudges by the skew". Here it is **the dangerous direction**).
//   => **Decide only by the presence of the marker; the remaining time is only a hint** (do not hide it even at 0 or below).

import type { AgentFeature, SessionSummary } from '../../../shared/types.ts'
import { t } from '../../../shared/i18n.ts'
import { mdhhmm } from '../time.ts'

/** `sending` right after a tap (⚠️ a double tap must not fire twice) */
export type AutoApprovePhase = 'ready' | 'sending'

export interface AutoApproveView {
  /** Whether to show it in the menu */
  show: boolean
  /** Whether tapping does nothing */
  disabled: boolean
  /** Label shown in the menu */
  label: string
  /** Whether it is in effect now (= tapping turns it off) */
  on: boolean
}

/**
 * Approximate time remaining.
 *
 * ⚠️ **Do not return "—" even if it looks expired** (see above. Do not fail toward hiding).
 * ⚠️ No seconds (do not put text that changes every second in the banner).
 */
export function remainingText(until: string, now: number): string {
  const ms = Date.parse(until) - now
  // ⚠️ An unparsable expiry is reported as "unknown" (do not decide on our own that it expired)
  if (!Number.isFinite(ms)) return t('残り不明', 'Time left unknown')
  if (ms <= 60_000) return t('まもなく終了', 'Ending soon')
  const min = Math.floor(ms / 60_000)
  const h = Math.floor(min / 60)
  return h > 0 ? t(`残り ${h}時間${min % 60}分`, `${h}h ${min % 60}m left`) : t(`残り ${min}分`, `${min} min left`)
}

/**
 * ★ Message after turning it on (2026-09-24). States **the actual time it turns off** (so the screen need not remember 3h vs 24h).
 * ⚠️ Uses only the expiry returned by the agent (no adding to the device clock = same idea as the banner).
 */
export function autoApproveOnText(until: string | undefined): string {
  const at = mdhhmm(until)
  if (!at) return t('自動承認をオンにしました', 'Auto-approve is on')
  return t(`自動承認をオンにしました（${at} に自動で切れます）`, `Auto-approve is on (turns off automatically at ${at})`)
}

/** The one line for the banner (★ `null` means don't show it) */
export function autoApproveBanner(
  session: SessionSummary | undefined,
  now: number,
): { text: string } | null {
  const until = session?.autoApprove?.until
  if (!until) return null
  return { text: t(`⚡ 自動承認 中 · ${remainingText(until, now)}`, `⚡ Auto-approve on · ${remainingText(until, now)}`) }
}

/**
 * ★★★ How the menu item looks.
 *
 * ⚠️⚠️ **Do not condition on `sendRoute`** (this is where it differs from the actions in `commands.ts`).
 *    Auto-approve works through **the permission hook path**, so it is in effect even in sessions where
 *    keystrokes (the relay) are unavailable. Copying that condition gives the worst shape: **it cannot be turned off only in sessions without keystrokes**.
 * ⚠️ Not shown for agents without the feature marker (old ones) (fail-closed / `NEEDS_FEATURE`).
 * ⚠️ Not shown for sessions that are not live (no approvals arrive at all).
 *    ★ But **shown if the marker is set** (do not let the screen hide what the agent says is
 *      "in effect" = do not take away the means to turn it off).
 */
export function autoApproveView(
  session: SessionSummary | undefined,
  phase: AutoApprovePhase,
  features: readonly AgentFeature[] | undefined,
): AutoApproveView {
  const on = Boolean(session?.autoApprove)
  const label = on ? t('⚡ 自動承認をオフにする', '⚡ Turn off auto-approve') : t('⚡ 自動承認をオンにする', '⚡ Turn on auto-approve')
  if (!session) return { show: false, disabled: true, label, on }
  if (!features?.includes('auto-approve')) return { show: false, disabled: true, label, on }
  if (!session.live && !on) return { show: false, disabled: true, label, on }
  if (phase === 'sending') return { show: true, disabled: true, label: `${label}…`, on }
  return { show: true, disabled: false, label, on }
}

/**
 * ★★ Message when a toggle is refused (**one place**).
 *
 * ⚠️⚠️ **On and off mean opposite things**, so keep them separate. The agent can return `{ok:false}` with 200
 *    (state file corrupt / could not save):
 *      on  … **has not started approving** (stopped on the safe side)
 *      off … **stopped in memory but not saved** = comes back until expiry when the agent restarts
 *    => One shared message would **make the state unreadable** (the same as silently showing success).
 */
export function autoApproveError(on: boolean, reason: string | undefined): string {
  const why = reason ?? t('理由が返りませんでした', 'No reason was returned')
  return on
    ? t(`自動承認をオンにできませんでした（${why}）`, `Could not turn on auto-approve (${why})`)
    : t(
        `自動承認は止めましたが、保存できませんでした（${why}）。agent を再起動すると期限まで復活します`,
        `Auto-approve was stopped but could not be saved (${why}). If the agent restarts, it comes back until it expires`,
      )
}
