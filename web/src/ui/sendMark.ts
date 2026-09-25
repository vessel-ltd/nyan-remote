// The mark for "how will what I send from the phone arrive" (per session / HANDOFF).
//
// ## Why it is needed
//
// Whether it arrives by keystrokes (no frame) or falls into the inbox (with an English frame) depends on
// **how the session was started** (via relay or not). Until now the screen only told you **after sending**
// (the receiving side shows a "from phone" mark), and ⚠️ **you could not tell before sending**.
//
// ⚠️⚠️ The frame is not just cosmetic: the receiver may interpret it as "from another session"
//    and **reply to an unrelated session** (ARCHITECTURE §9.7.2).
//
// ⚠️ **No mark for the good case (keystrokes).** A mark shown on every thread all the time stops being read.
// ⚠️ The decision is the agent's (`scanPanes`). This only **turns the received mark into text**.

import {
  looksLikeCommand,
  type KeysUnavailable,
  type SessionSummary,
} from '../../../shared/types.ts'
import { t } from '../../../shared/i18n.ts'

/**
 * Explanations of the reasons. ★ It is a `Record<KeysUnavailable, string>`, so **a new reason fails the type check**.
 *
 * ⚠️ Do not show internal terms (keystrokes / relay / pane). What matters to the user is
 *    only "how to fix it".
 */
// ⚠️ The text is getters (calls `t()` on every read = never at module top level / same shape as before)
export const KEYS_REASON_TEXT: Record<KeysUnavailable, string> = {
  get 'no-relay'() {
    return t(
      'このセッションは PC の新しい窓で開き直すと、枠なしで届くようになります',
      'Reopen this session in a new window on the PC and messages will arrive without the wrapper',
    )
  },
  get 'not-found'() {
    return t(
      'このセッションが見つかりません（PC 側で終了している可能性があります）',
      'This session was not found (it may have ended on the PC)',
    )
  },
  get broken() {
    return t(
      '受け渡しの窓口の情報が壊れています（PC の新しい窓で開き直してください）',
      'The hand-off information is broken (reopen the session in a new window on the PC)',
    )
  },
  get unverified() {
    return t(
      '受け渡し先を確かめられません（mac では常にこの状態になります）',
      'Cannot verify the hand-off target (always the case on mac)',
    )
  },
  get ambiguous() {
    return t('同じセッションが複数見つかっています', 'More than one copy of this session was found')
  },
  get waiting() {
    return t(
      'PC の画面でダイアログが開いています（閉じると枠なしで届きます）',
      'A dialog is open on the PC screen (close it and messages will arrive without the wrapper)',
    )
  },
}

/**
 * ★★ **Cases where the text overrides the route** (2026-08-24 codex high #2).
 *
 * ⚠️⚠️ The session mark (`sendRoute`) is "that session's **default** route";
 *    text starting with `/` or `!` **always falls into the inbox (= English frame)**
 *    (refused by keystrokes → dropped by `decideAfterKeys`).
 *    Letting the mark alone suggest "no frame" causes exactly the harm this mark is meant to prevent
 *    (the frame makes it reply to an unrelated session / §9.7.2).
 *
 * ⚠️ The **authority** is the agent (`sanitizeForKeys`). This is only a caution, so
 *    it just mirrors the same shape (**strip control characters, then look at the start**).
 * ⚠️ It looks at **the first non-whitespace character** (`trimStart()` also strips leading newlines, so
 *    `"\n/compact"` is `slash` = same result as the agent). Nothing after the line containing
 *    a non-whitespace character is examined (the CLI does not treat `/` on line 2+ as a command).
 *    ★ 2026-08-24 codex finding: the old comment said "only the first line", which
 *      contradicted `trimStart()`'s behaviour (**adding tests based on comments goes wrong**).
 */
export type PerMessageNote = 'slash' | 'bang' | null

/**
 * ★★ The decision is **`looksLikeCommand` in `shared/types.ts`** (one function shared with the agent).
 *
 * ⚠️⚠️ A hand-written check here **diverged from the agent** (2026-08-24 codex low #2:
 *    `​/help` got no caution on screen but the agent rewrote it =
 *    it failed the goal of "tell before sending").
 */
export function perMessageNote(text: string): PerMessageNote {
  const kind = looksLikeCommand(text)
  if (kind === '/') return 'slash'
  if (kind === '!') return 'bang'
  return null
}

/**
 * ★ Notice after sending (when it started with `/` `!`).
 *
 * ⚠️ **Never rewrite silently**. The agent sends it "as text with one space added", so
 *    the screen says it did not run as a command (otherwise it looks like "a command that does nothing").
 */
export const NEUTRALIZED_NOTE =
  '先頭に空白を1つ足して、文章として送りました（コマンドとしては実行されません）'

/** ★ `NEUTRALIZED_NOTE` in the screen language (⚠️ `t()` is not called at module top level ⇒ it is a function) */
export function neutralizedNote(): string {
  return t(NEUTRALIZED_NOTE, 'Added one leading space and sent it as text (it will not run as a command)')
}

export interface SendMark {
  /** Short label */
  label: string
  /** Its reason (one line) */
  note: string
  /** ★ The exact line shown on screen (⚠️ do not assemble it on the screen side) */
  text: string
}

/**
 * ★ Shown only when "a frame will be added".
 *
 * ⚠️⚠️ This is about **the session's default route**; **the text can override it**
 *    (`/` `!` get a frame even in `keys` sessions ⇒ `perMessageNote`).
 *
 * ⚠️ Without `sendRoute` (old agent / session not alive) **say nothing**
 *    (do not assert what we do not know).
 * ⚠️ Even for `inbox` with an unknown reason, **show the mark** (never stay silent about the frame).
 */
export function sendMark(session: SessionSummary | undefined): SendMark | null {
  if (!session || session.sendRoute !== 'inbox') return null
  const note = session.keysReason ? KEYS_REASON_TEXT[session.keysReason] : ''
  const label = t('⚠ 送ると英文の枠が付きます', '⚠ Sending adds an English wrapper')
  return { label, note, text: note ? t(`${label}。${note}`, `${label}. ${note}`) : label }
}
