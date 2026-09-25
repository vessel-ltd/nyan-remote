// ★★ Turns the agent-supplied parts of an approval card into text in the UI's language (2026-09-24 / i18n).
//
// ★ New agents send **structure** (`suggestionItems` / `subagent` / `accountUnknown`) ⇒ turned into text here via `t()`.
//   ⚠️ The agent's wording is not produced inside a phone request (it is queued in `/permissions` when the hook fires),
//      so the agent cannot know the UI's language. Rendering text is therefore the UI's job.
// ⚠️ **legacy**: old agents (without the structured fields) send only Japanese sentences.
//    Machines are updated one at a time, so both always coexist ⇒ **only when the structured fields are missing**, match the old sentence and translate it (`legacy*`).
//    The sentences matched against are `LEGACY_*` in `shared/types.ts` (the same values the agent produces = no drift).
//    Once old agents are gone, `legacy*` can be deleted wholesale.
// ⚠️ Unknown shapes (a future agent added a kind / broken values) must **not throw and not hide the card** (show a generic word).
// ⚠️ Display only. Text built here is **never sent back** (an approval answer is only the chosen label / CLAUDE.md §2).

import { t } from '../../../shared/i18n.ts'
import {
  LEGACY_DIRECTORY_PREFIX,
  LEGACY_MODE_PREFIX,
  LEGACY_MODE_SUFFIX,
  LEGACY_SUBAGENT_LABEL,
  LEGACY_UNKNOWN_ACCOUNT,
  type PermissionRequest,
} from '../../../shared/types.ts'

/** ★ Renders one suggestion. Takes `unknown` (never throws on future agent shapes or broken values) */
export function suggestionText(item: unknown): string {
  const o = item && typeof item === 'object' ? (item as Record<string, unknown>) : undefined
  const kind = o?.['kind']
  if (kind === 'addDirectories' && Array.isArray(o?.['directories'])) {
    const dirs = (o['directories'] as unknown[]).filter((d): d is string => typeof d === 'string')
    if (dirs.length > 0) {
      const list = dirs.join(', ')
      return t(`このディレクトリを許可: ${list}`, `Allow this directory: ${list}`)
    }
  } else if (kind === 'setMode' && typeof o?.['mode'] === 'string' && o['mode']) {
    const mode = o['mode']
    return t(`このセッションのモードを ${mode} にする`, `Set this session's mode to ${mode}`)
  } else if (kind === 'other' && typeof o?.['type'] === 'string' && o['type']) {
    // CLI kind names are shown as-is (same as the old text)
    return o['type']
  }
  // ★ fail-closed: an unknown kind gets a generic word (neither the card nor the row disappears)
  return t('ほかの候補', 'another option')
}

/** ★ Content of the card's "selectable on the PC" part. Uses the structured field if present, otherwise the old text (legacy) */
export function suggestionTexts(p: Pick<PermissionRequest, 'suggestions' | 'suggestionItems'>): string[] {
  if (Array.isArray(p.suggestionItems)) return p.suggestionItems.map(suggestionText)
  return Array.isArray(p.suggestions) ? p.suggestions.map(legacySuggestion) : []
}

/** ★ Requester tag (called only when it came from a subagent). Structured field if present, otherwise the old text (legacy) */
export function agentTypeLabel(p: Pick<PermissionRequest, 'agentType' | 'subagent'>): string {
  if (p.subagent && typeof p.subagent === 'object') {
    const type = p.subagent.type
    return typeof type === 'string' && type ? type : t('サブエージェント', 'Subagent')
  }
  return legacyAgentType(p.agentType ?? '')
}

/** ★ Account name. If the agent flagged it as unknown, use the UI's language; otherwise the old text (legacy) */
export function accountLabel(p: { account: string; accountUnknown?: true }): string {
  if (p.accountUnknown === true) return t('(不明)', '(unknown)')
  return legacyAccount(p.account)
}

// ---- legacy (matching old agents' Japanese sentences) ------------------------------------------------

/** ⚠️ legacy: old agents' `suggestions`. Returned as-is if the shape doesn't match (e.g. CLI kind names) */
export function legacySuggestion(s: string): string {
  if (typeof s !== 'string') return t('ほかの候補', 'another option')
  if (s.startsWith(LEGACY_DIRECTORY_PREFIX)) {
    const list = s.slice(LEGACY_DIRECTORY_PREFIX.length)
    return t(s, `Allow this directory: ${list}`)
  }
  if (s.startsWith(LEGACY_MODE_PREFIX) && s.endsWith(LEGACY_MODE_SUFFIX) && s.length > LEGACY_MODE_PREFIX.length + LEGACY_MODE_SUFFIX.length) {
    const mode = s.slice(LEGACY_MODE_PREFIX.length, s.length - LEGACY_MODE_SUFFIX.length)
    return t(s, `Set this session's mode to ${mode}`)
  }
  return s
}

/** ⚠️ legacy: old agents' `agentType` (only the default name used when `agent_type` is missing is translated) */
export function legacyAgentType(s: string): string {
  return s === LEGACY_SUBAGENT_LABEL ? t(s, 'Subagent') : s
}

/**
 * ⚠️ legacy: old agents' `account` (only the `(不明)` used when unknown is translated).
 * ★ The full-width `（不明）` is not matched (no agent has ever sent it / checked with `git log -S`).
 */
export function legacyAccount(s: string): string {
  return s === LEGACY_UNKNOWN_ACCOUNT ? t(s, '(unknown)') : s
}
