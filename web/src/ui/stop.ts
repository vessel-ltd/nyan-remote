// The single place that decides how "Stop" (ESC) looks.
//
// ★ Why the decision is confined here: writing "whether to show" inside the screen produces, as conditions grow,
//   **buttons you can press that do nothing** and **buttons that hide exactly when you most want to stop**
//   (same lesson as writing notification text in two places: 65 of 96 combinations disagreed).
//
// ⚠️ Refusal decisions (approval card showing, dialog open on the PC, repeated taps) belong to the **agent**
//   (`agent/src/routes/interrupt.ts`). The screen just shows its reason.

import type { SessionSummary } from '../../../shared/types.ts'
import { t } from '../../../shared/i18n.ts'

/** `sending` right after a press (⚠️ so ESC is not sent twice) */
export type StopPhase = 'ready' | 'sending'

export interface StopView {
  /** Show it in the menu? */
  show: boolean
  /** Pressing it sends nothing? */
  disabled: boolean
  label: string
}

/**
 * ★ Notice shown when sent.
 *
 * ⚠️ Do not say "Stopped". All we know is **that it arrived**; whether the CLI stopped
 *    is unknown until you look at the thread (`InterruptResult` carries no result for the same reason).
 */
export const STOP_SENT_NOTE =
  '止める合図（ESC）を送りました。止まらないときは少し待ってもう一度押してください'

/** ★ `STOP_SENT_NOTE` in the screen language (⚠️ `t()` is not called at module top level ⇒ it is a function) */
export function stopSentNote(cleared = false): string {
  // ★ If the input box was cleared too, say so (text being typed on the PC is lost too, so include how to restore / 2026-09-24)
  if (cleared) {
    return t(
      '止める合図（ESC）を送り、PC の入力欄も消しました（PC で打ちかけていた文も消えます。PC で Ctrl+Y を押すと戻せます）。止まらないときは少し待ってもう一度押してください',
      'Sent the stop signal (ESC) and cleared the input box on the PC (text being typed on the PC is cleared too; press Ctrl+Y on the PC to restore it). If it does not stop, wait a moment and press it again',
    )
  }
  return t(STOP_SENT_NOTE, 'Sent the stop signal (ESC). If it does not stop, wait a moment and press it again')
}

export function stopView(session: SessionSummary | undefined, phase: StopPhase): StopView {
  // Not in the list (= unknown whether alive) / not running ⇒ do not show
  if (!session || !session.live) return { show: false, disabled: true, label: t('⏹ 止める', '⏹ Stop') }
  // ★★ **Not shown for old agents' sessions** (2026-08-24; there is a period where old and new coexist).
  //
  // ⚠️⚠️ Old agents have no `POST /sessions/:id/interrupt`, so it would **404**
  //    (measured: sent to a machine on the old version, got 404). Do not make "a button that does nothing".
  // ★ How to tell: **alive but no `sendRoute`** = that agent does not return the mark
  //    = this version is not installed (dead sessions get no mark even on a new agent).
  if (!session.sendRoute) return { show: false, disabled: true, label: t('⏹ 止める', '⏹ Stop') }
  // ⚠️⚠️ **Do not hide based on state.** The list's state comes from the transcript and lags, so
  //    hiding it in a moment where it "does not look busy" means **it cannot be pressed when you most want to stop**.
  //    ⇒ Show it whenever alive; the agent does the refusing (approval card, dialog, repeated taps).
  if (phase === 'sending') return { show: true, disabled: true, label: t('⏹ 止めています…', '⏹ Stopping…') }
  return { show: true, disabled: false, label: t('⏹ 止める', '⏹ Stop') }
}
