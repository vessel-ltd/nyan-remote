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

/**
 * ★ An Antigravity CLI (agy) row (2026-11-19 / docs/AGY.md). Like Codex, only what its own marks grant: list, thread
 * and follow (`agy-log-follow`), and — for an agy started through the relay (`sendRoute: 'keys'`) — sending
 * (`agy-send`), stopping (`agy-interrupt`) and auto-approve (`agy-auto-approve` / `autoApprove.ts` checks the relay).
 * Commands and clearing the input box stay off.
 */
export function isAgy(session: Pick<SessionSummary, 'tool'> | undefined): boolean {
  return session?.tool === 'agy'
}

/** agy mark → the Claude-side features the thread may use for an agy row */
const AGY_GRANTS: ReadonlyArray<readonly [AgentFeature, readonly AgentFeature[]]> = [
  ['agy-log-follow', ['log-follow']],
  // ★ 2026-11-20: the agent answers its cards with keys (the 24 h choice still needs the agent's own mark)
  ['agy-auto-approve', ['auto-approve', 'auto-approve-24h']],
  // ★ Compact only (`commandView` reads it for an agy row; `slash-commands` is never granted ⇒ no `exit` / `clear`)
  ['agy-compact', ['agy-compact']],
]

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
  if (isCodex(session) || isAgy(session)) {
    if (!features) return []
    const table = isCodex(session) ? CODEX_GRANTS : AGY_GRANTS
    return table.flatMap(([mark, grants]) => (features.includes(mark) ? grants.filter((g) => features.includes(g)) : []))
  }
  // ⚠️ A tool this PWA does not know (a newer agent): nothing, never Claude's actions
  if (session?.tool !== undefined) return []
  return features ? [...features] : undefined
}

/**
 * ★ Whether the stop button may show for this row (2026-11-15). ⚠️ `features` are the **agent's**.
 * Claude: a row we can deliver keys to (`sendRoute`) / Codex: an agent with `codex-interrupt` (the daemon stops the
 * turn; a Codex row never has a key route, and an old agent would hand its id to the Claude route).
 */
export function canStop(session: Pick<SessionSummary, 'tool' | 'sendRoute'>, features: readonly AgentFeature[] | undefined): boolean {
  if (isCodex(session)) return features?.includes('codex-interrupt') ?? false
  // ★ agy: one ESC through its relay, so only a row the relay announced
  // ⚠️ and only an agent that refuses it during a question (`agy-question`: an older one sent ESC, which skips it)
  if (isAgy(session)) return (features?.includes('agy-interrupt') ?? false) && (features?.includes('agy-question') ?? false) && session.sendRoute === 'keys'
  if (session.tool !== undefined) return false
  return session.sendRoute !== undefined
}

/** Whether the message box may send to this row. ⚠️ `features` are the **agent's** (not `actionFeatures`). */
export function canSendTo(
  session: Pick<SessionSummary, 'tool' | 'sendRoute'> | undefined,
  features: readonly AgentFeature[] | undefined,
): boolean {
  if (isCodex(session)) return features?.includes('codex-send') ?? false
  // ★ agy: typed through its relay (only a row the relay announced)
  if (isAgy(session)) return (features?.includes('agy-send') ?? false) && session?.sendRoute === 'keys'
  // ⚠️ Any tool this PWA does not know: no sending
  return session?.tool === undefined
}

/** ★ Whether files may be attached when sending to this row (agy: not yet — it would ask to read outside its folder) */
export function canAttachTo(session: Pick<SessionSummary, 'tool' | 'sendRoute'> | undefined, features: readonly AgentFeature[] | undefined): boolean {
  return !isAgy(session) && canSendTo(session, features)
}

/** What the message box says instead of sending (only for rows it cannot send to). */
export function sendBlockedNote(
  session: Pick<SessionSummary, 'tool' | 'sendRoute' | 'agyShared'> | undefined,
  features: readonly AgentFeature[] | undefined,
): string | undefined {
  if (canSendTo(session, features)) return undefined
  // ★ Two agys show this conversation: which one would get it cannot be told (restarting would not help)
  if (isAgy(session) && session?.agyShared) {
    return t(
      'この会話は2つの agy で開かれています。どちらに届くか決められないので、スマホからは送れません（PC で操作してください）',
      'This conversation is open in two agys. Which one would get it cannot be told, so it cannot be sent from the phone (use the PC)',
    )
  }
  if (isAgy(session) && features?.includes('agy-send')) {
    return t(
      'この agy は nyan-remote を通さずに起動しています。新しいターミナルで agy を起こし直すと、スマホから送れます',
      'This agy was not started through nyan-remote. Start agy again in a new terminal to send to it from the phone',
    )
  }
  if (!isCodex(session)) {
    return t(
      'このセッションへの送信は、まだスマホからできません（PC で入力してください）',
      'Sending to this session from the phone is not supported yet (type on the PC)',
    )
  }
  return t(
    'このマシンの nyan-remote は、Codex のセッションへの送信にまだ対応していません（PC で入力してください）',
    'nyan-remote on this machine cannot send to Codex sessions yet (type on the PC)',
  )
}
