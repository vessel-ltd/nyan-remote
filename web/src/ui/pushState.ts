// ★★ Deciding the notification's "current state" (2026-09-24 / user decision: invisible normally, shown only when there is trouble).
//
// ★ The top of the list is meant for "sessions waiting on you" ⇒ **show nothing when healthy** (just 🔔 in the header).
// ⚠️⚠️ **Trouble states always show in the list** (folded into an "enabled" line while nothing arrived, for 3 days / 2026-08-21).
// ⚠️ The decision lives here only (the list banner, the header badge and the settings screen all read it).

import type { PushFailure } from '../../../shared/types.ts'
import { t } from '../../../shared/i18n.ts'

export type PushKind =
  /** Not available in this environment (a Safari tab on iPhone, etc.). ⚠️ No banner (do not nag where nothing can be fixed) */
  | 'unsupported'
  /** Denied in browser settings */
  | 'blocked'
  /** Sending fails (403 etc.; the subscription remains, so it looks "enabled") */
  | 'failing'
  /**
   * ★ Registration (creating the subscription / registering with the agent) failed (2026-09-24 / codex round 19, medium #3).
   * ⚠️⚠️ Do **not turn this into** "only some machines registered" (`partial`): the banner would vanish and the failed machine would get no notifications, leaving only "🔔 1/2".
   */
  | 'unregistered'
  /** The user "stopped" it (⚠️ an intention, so the banner does not nag) */
  | 'off'
  /** Not yet permitted */
  | 'unset'
  /** Registered with only some agents */
  | 'partial'
  /** Registered with all agents */
  | 'ok'

export function pushKind(s: {
  supported: boolean
  permission: NotificationPermission | 'unsupported'
  registered: number
  total: number
  failure: PushFailure | undefined
  off: boolean
  /** ★ Why registration failed on the last sync (`undefined` on success) */
  syncProblem?: string | undefined
}): PushKind {
  if (!s.supported || s.permission === 'unsupported') return 'unsupported'
  if (s.permission === 'denied') return 'blocked'
  // ⚠️⚠️ Check failure before "registered" (registered does not mean delivered)
  if (s.failure) return 'failing'
  // ⚠️⚠️ Check registration failure before "partially registered" too (keep the banner). ⚠️ Never set when the user stopped it, since no sync runs
  if (s.syncProblem) return 'unregistered'
  if (s.registered === 0) return s.off ? 'off' : 'unset'
  return s.registered < s.total ? 'partial' : 'ok'
}

/** ★ Whether to show a banner in the list (⚠️ only states that need action) */
/**
 * ★ Whether the list shows the one-line banner.
 * ⚠️ Nothing before the first pairing (`machines` 0): there is nothing to notify from yet, and the first-run guide is on screen
 *    (2026-09-26 / `ui/onboarding.ts`).
 */
export function showsBanner(kind: PushKind, machines: number): boolean {
  if (machines === 0) return false
  return kind === 'blocked' || kind === 'failing' || kind === 'unregistered' || kind === 'unset'
}

/** ★ Badge next to "⚙ Settings" in the header (`undefined` = none) */
export function pushBadge(kind: PushKind, registered: number, total: number): string | undefined {
  switch (kind) {
    case 'ok':
      return '🔔'
    case 'partial':
      return `🔔 ${registered}/${total}`
    case 'off':
    case 'unset':
    case 'blocked':
      return '🔕'
    case 'failing':
    case 'unregistered':
      return '⚠'
    case 'unsupported':
      return undefined
  }
}

/** ★ The single banner line in the list (only used when `showsBanner` is true) */
export function bannerText(kind: PushKind): string {
  switch (kind) {
    case 'failing':
      return t('⚠ 通知が届いていません', '⚠ Notifications are not arriving')
    case 'blocked':
      return t('🔕 通知がブラウザでブロックされています', '🔕 Notifications are blocked in the browser')
    case 'unregistered':
      return t('⚠ 一部のマシンに通知を登録できませんでした', '⚠ Could not register notifications with some machines')
    default:
      return t('🔕 通知が未設定です', '🔕 Notifications are not set up')
  }
}
