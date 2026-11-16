// ★★ What the UI may offer for a row, by the CLI it belongs to (2026-11-14 / docs/CODEX.md §6).
//
// Codex rows (`tool: 'codex'`) arrive from agents that have Codex support turned on. What can be done to them is
// built one action at a time, and **each action has its own feature mark** (`codex-…`).
//
// ⚠️⚠️ Decided here, in one place. Every action in the thread takes its features from `actionFeatures`, so a Codex
//    row cannot show a button whose endpoint would act on a Claude session id that does not exist (= a button that 404s).
// ⚠️ Fail-closed: nothing becomes available for a Codex row just because the agent has the Claude-side feature.
//    The table below names what a Codex mark lets through, under the name the thread already understands.

import type { AgentFeature, SessionSummary } from '../../../shared/types.ts'
import { t } from '../../../shared/i18n.ts'

export function isCodex(session: Pick<SessionSummary, 'tool'> | undefined): boolean {
  return session?.tool === 'codex'
}

/** Codex mark → the Claude-side features the thread may use for a Codex row */
const CODEX_GRANTS: ReadonlyArray<readonly [AgentFeature, readonly AgentFeature[]]> = [
  ['codex-log-follow', ['log-follow']],
  // ⚠️ The 24 h choice still needs the agent's own mark for it
  ['codex-auto-approve', ['auto-approve', 'auto-approve-24h']],
  // ★ Compact only (`commandView` reads it for a Codex row; `slash-commands` is never granted ⇒ no `exit` / `clear`)
  ['codex-compact', ['codex-compact']],
]

/** The features to use for **actions on this row**. A Codex row gets only what its own marks grant. */
export function actionFeatures(
  session: Pick<SessionSummary, 'tool'> | undefined,
  features: readonly AgentFeature[] | undefined,
): AgentFeature[] | undefined {
  if (isCodex(session)) {
    if (!features) return []
    return CODEX_GRANTS.flatMap(([mark, grants]) => (features.includes(mark) ? grants.filter((g) => features.includes(g)) : []))
  }
  return features ? [...features] : undefined
}

/**
 * ★ Whether the stop button may show for this row (2026-11-15). ⚠️ `features` are the **agent's**.
 * Claude: a row we can deliver keys to (`sendRoute`) / Codex: an agent with `codex-interrupt` (the daemon stops the
 * turn; a Codex row never has a key route, and an old agent would hand its id to the Claude route).
 */
export function canStop(session: Pick<SessionSummary, 'tool' | 'sendRoute'>, features: readonly AgentFeature[] | undefined): boolean {
  if (isCodex(session)) return features?.includes('codex-interrupt') ?? false
  return session.sendRoute !== undefined
}

/** Whether the message box may send to this row. ⚠️ `features` are the **agent's** (not `actionFeatures`). */
export function canSendTo(session: Pick<SessionSummary, 'tool'> | undefined, features: readonly AgentFeature[] | undefined): boolean {
  return !isCodex(session) || (features?.includes('codex-send') ?? false)
}

/** What the message box says instead of sending (only for rows it cannot send to). */
export function sendBlockedNote(
  session: Pick<SessionSummary, 'tool'> | undefined,
  features: readonly AgentFeature[] | undefined,
): string | undefined {
  if (canSendTo(session, features)) return undefined
  return t(
    'このマシンの nyan-remote は、Codex のセッションへの送信にまだ対応していません（PC で入力してください）',
    'nyan-remote on this machine cannot send to Codex sessions yet (type on the PC)',
  )
}
