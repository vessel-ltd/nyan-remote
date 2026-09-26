import { t } from '../../../shared/i18n.ts'

// ★ Which machine problems the list shows, and how (2026-09-26 / user decision).
//
// ★ A machine that cannot be reached at all (off, asleep, WSL not started) is a **state, not an error**:
//   it only lowers the "🖥 reachable/all" count on the Settings button (details on the connections page), and only after it has lasted `OFFLINE_GRACE_MS` (a relay reconnect or reopening the app
//   must not flash anything). Errors after actually reaching a machine stay a red line at the top.
// ⚠️ "Unreachable" is decided by the error's type in the transport (`transport/unreachable.ts`), never by its text.

export const OFFLINE_GRACE_MS = 30_000

export interface TroubleInput {
  label: string
  error?: string
  /** ★ The last failure could not reach the machine at all */
  offline?: boolean
  /** ★ When it first became unreachable (epoch ms). Kept across repeated failures, cleared on success */
  offlineSince?: number
}

/**
 * @returns `errors`: red, shown at once / `offline`: grey, once the grace has passed (oldest first)
 */
export function splitTrouble<T extends TroubleInput>(states: readonly T[], now: number): { errors: T[]; offline: T[] } {
  const errors = states.filter((s) => s.error && !s.offline)
  const offline = states
    .filter((s) => s.error && s.offline && s.offlineSince !== undefined && now - s.offlineSince >= OFFLINE_GRACE_MS)
    .sort((a, b) => (a.offlineSince ?? 0) - (b.offlineSince ?? 0))
  return { errors, offline }
}

/**
 * ★ The Settings button's machine count: reachable / all (always shown / 2026-09-26 / user decision).
 * ⚠️ "Reachable" = not offline past the grace period (a machine answering with an error still counts: it shows as a red line instead).
 */
export function machineCount(total: number, offline: number): string {
  return `🖥 ${Math.max(0, total - offline)}/${total}`
}

/** ★ What a screen reader says for the count (the emoji fraction alone does not say what it counts / codex) */
export function machineCountLabel(total: number, offline: number): string {
  const up = Math.max(0, total - offline)
  return t(`${total}台中 ${up}台に接続`, `${up} of ${total} machines reachable`)
}
