// Put text into a running session "as keystrokes" (ARCHITECTURE.md §9.7.2).
//
// ★★ Keep the dangerous parts inside this one file (same idea as `inbox.ts`).
//
// ## How this differs from the inbox (inbox.ts)
//
//   inbox … the CLI **judges it as coming from a peer and wraps it in an English frame**. The sender cannot remove the frame.
//            In exchange **the CLI disables slash commands**, and it **never counts as consent to an approval**
//   keys  … arrives as `origin.kind: "human"` (**no frame; indistinguishable from what a person typed**).
//            ⚠️⚠️ **That is why it is dangerous**: slash commands and `!` bash mode both go through, and
//            digit keys **can become a choice in an approval dialog**
//
// ## Rules this file enforces (agreed with the user on 2026-08-22. ⚠️ Do not bolt them on later)
//
//   1. **Do not type while an approval card is showing** (the caller passes the input. No default value)
//   2. A body starting with `/` is **refused** → the caller drops it into the inbox (safe there because it is disabled)
//   3. Same for a body starting with `!`
//   4. **Drop control characters** (⚠️ letting ESC through moves the choices / CR becomes a newline)
//   5. The socket is 0600 and `SO_PEERCRED` allows the same uid only (on the `scripts/relay.py` side)
//   6. **Keep a record of what was sent** (⚠️ never the body. Only identifiers and length / §6.2)
//
// ⚠️ **Never drop a `partial` into the inbox** (what was partly typed would arrive twice).

import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import {
  LEADING_INVISIBLE,
  MAX_MESSAGE_BYTES,
  isDroppedControl,
  looksLikeCommand,
  type CommandId,
  type KeysUnavailable,
} from '../../../shared/types.ts'
import { t } from '../../../shared/i18n.ts'
import { readJsonFile, stateDir } from '../state.ts'
import type { ConfigDir } from './configDirs.ts'
import { aliveProcStartFreshSync, aliveProcStartSync, readIndexEntriesDetailed, sameProcStart } from './sessionIndex.ts'

/** Upper limit for a write. ★ Same value as the inbox (taken from shared so it does not drift from the UI) */
export const MAX_KEYS_BYTES = MAX_MESSAGE_BYTES
/** Limit for connecting and writing. No reply comes back, so keep it short */
const CONNECT_TIMEOUT_MS = 2000
/**
 * The gap between writing the body and **sending Enter (CR)**.
 *
 * ★ Measured 2026-08-22 (2.1.239 / the real TUI): **it was submitted even with `0`** (a short single line).
 * ⚠️ Still, do not make the default 0. Paste detection **can vary with input size and timing**, so
 *    this is not a safeguard to remove on one observation (if the CR is absorbed into a long multi-line body,
 *    **it is not submitted and piles up in the input box** = from the phone it looks like "sent, but nothing happened").
 */
export const SUBMIT_DELAY_MS = 120

/**
 * **Reasons decided by target lookup (`findPane`) alone.** ★ Why they are kept closed here:
 * the "stop" (ESC) endpoint can only hit this set + connection failures, so
 * **`Record<ControlFailure, …>` is exhaustive** (= adding a reason fails the type check).
 */
/**
 * ★★ Uses **the same type as the marker shown on screen (`SessionSummary.keysReason`)**
 *    (`KeysUnavailable` in `shared/types.ts`). ⇒ The explanation table in the list is type-checked too.
 * ⚠️ Meaning: `not-found`=not there / `no-relay`=plain claude / `broken`=the announcement is broken
 *    (fail-closed) / `unverified`=identity cannot be confirmed (indistinguishable from pid reuse) /
 *    `ambiguous`=**two or more live processes** claim the same sessionId (or multiple targets) /
 *    `waiting`=the CLI is showing a dialog
 *    (a kind that **never reaches the approval hook**)
 */
export type PaneFailure = KeysUnavailable

/**
 * ★★ Failures that can happen with a control key (ESC).
 *
 * ⚠️⚠️ **There is no `partial`, on purpose** (only one byte is written once, so there is no "partway").
 *    ★ However, **it is not that "the type forbids the inbox"** (codex finding 2026-08-24.
 *      My comment overstated it). What the type removes is only **the reason to drop** (=
 *      the need to decide "it was partly written, so it cannot be dropped").
 *      What actually prevents dropping is that **the endpoint does not import `inbox.ts`**,
 *      and `routes/interrupt.test.ts` checks that mechanically.
 * ⚠️ Reasons from body checks (`empty` / `too-long` / `slash` / `bang`) are not included either (the endpoint takes no body).
 */
export type ControlFailure = PaneFailure | 'unreachable' | 'pending-approval' | 'too-soon'

/**
 * ★★ Failures that can happen with a table command (`/compact` / `/exit`).
 *
 * ⚠️ Unlike ESC, **there is a `partial`** (two steps "body → 120ms → CR", so there is a partway).
 * ⚠️⚠️ Even so, **do not drop it into the inbox**. A dropped `/compact` is
 *    received by the model as "a request from a peer" and **actually executed** (measured 2026-08-24:
 *    `/tes` ran `make test`). ⇒ The endpoint does not import `inbox.ts`.
 * ⚠️ Reasons from body checks (`empty` / `too-long`) are not included (**the endpoint takes no body**).
 */
export type CommandFailure = PaneFailure | 'unreachable' | 'partial' | 'pending-approval' | 'too-soon'

export type KeysFailure =
  | PaneFailure
  | 'unreachable' // cannot connect to the socket (★ not a single byte written)
  | 'partial' // ⚠️⚠️ written partway (dropping to the inbox would deliver it twice)
  | 'empty'
  | 'too-long'
  | 'pending-approval' // an approval card is showing (one held by the hook)
// ⚠️ `slash` / `bang` **no longer exist** (2026-08-24). Instead of refusing, we **neutralize with one space**
//    and send via keystrokes (neutralization confirmed by measurement / see `sanitizeForKeys`).
//    ⇒ The path "dropped into the inbox because of its content" is gone.
  // ⚠️ `too-soon` is a reason for control keys only (serializing is enough for keystrokes). Not part of `KeysFailure`

export interface KeysResult {
  ok: boolean
  reason?: KeysFailure
  /** Explanation shown on screen as is */
  message?: string
  /** Number of control characters dropped (when non-zero the caller may tell the user) */
  dropped?: number
  /**
   * ★ The start was `/` or `!`, so it was sent **as plain text with one space added**.
   * ⚠️ Returned so we **never rewrite silently** (the screen says so).
   */
  neutralized?: boolean
}

/** ★ Result of "stop". ⚠️ There is no `partial`, so there is no way to drop into the inbox */
export interface ControlResult {
  ok: boolean
  reason?: ControlFailure
  message?: string
  /** ★ The target was "responding" (`PaneTarget.busy`) */
  busy?: boolean
  /** ★ After stopping, the input box was cleared too (`sendStopToSession`) */
  cleared?: boolean
}

export interface PaneTarget {
  sessionId: string
  pid: number
  socketPath: string
  /**
   * ★ The index state was "responding" (`busy`) (2026-09-24 / input for deciding whether "stop" also clears the input box).
   * ⚠️ Not an input for display (the list is decided by `sessions.ts`).
   */
  busy?: boolean
}

/** `~/.nyan-remote/panes/<pid>.json` (written by `scripts/relay.py`) */
export interface PaneRecord {
  pid?: unknown
  procStart?: unknown
  socket?: unknown
  startedAt?: unknown
}

export interface KeysContext {
  /**
   * Whether an approval card is showing. ⚠️⚠️ **Required** (no default value). Forgetting to pass it
   * turns into "typing during an approval dialog". Same reason as `StateContext` for notifications.
   *
   * ★★ **Passed as a function** (changed 2026-08-23). A boolean is "a value read once" and goes stale:
   *    if an approval appears during target-lookup I/O → connect → body → 120ms → CR (min 120ms, max 2s),
   *    a digit we sent **could confirm a choice**. ⇒ **Re-read before the body and before the CR**.
   */
  hasPendingApproval: () => boolean
}

export function failureMessage(reason: KeysFailure): string {
  switch (reason) {
    case 'not-found':
      return t('そのセッションは動いていません', 'That session is not running.')
    case 'no-relay':
      return t('このセッションは打鍵で渡せません（relay 経由で起動していません）', 'Keystrokes cannot be sent to this session (it was not started through the relay).')
    case 'broken':
      return t('打鍵の宛先が壊れています', 'The keystroke target is broken.')
    case 'unverified':
      return t('打鍵の宛先を確かめられません', 'Could not verify the keystroke target.')
    case 'ambiguous':
      return t('同じセッションが複数見つかりました', 'Multiple sessions with the same ID were found.')
    case 'unreachable':
      return t('打鍵の窓口が応答しません', 'The keystroke endpoint is not responding.')
    case 'partial':
      // ⚠️ "Cancelled" was a lie (the body **remains** in the input box). Say what actually happened
      return t(
        '打鍵の途中で失敗しました。PC の入力欄に途中まで入っている可能性があります（二重に送らないため、こちらからは送り直しません）',
        'Sending keystrokes failed partway. The input box on the PC may contain partial text (it will not be resent, to avoid sending it twice).',
      )
    case 'waiting':
      return t('PC の画面でダイアログが開いています（打鍵はしません）', 'A dialog is open on the PC screen (no keystrokes were sent).')
    case 'empty':
      return t('本文が空です', 'The message is empty.')
    case 'too-long':
      return t('本文が長すぎます', 'The message is too long.')
    case 'pending-approval':
      return t('承認を待っている間は打鍵しません', 'Keystrokes are not sent while an approval is pending.')
  }
}

/**
 * ★★ Message for "could not stop". **Do not reuse the keystroke messages**.
 *
 * ⚠️⚠️ Reusing them yields text that makes no sense as a reply to "stop"
 *    (`no-relay` → "Keystrokes **cannot be sent** to this session" = unclear what was asked).
 * ⚠️ Do not expose internal terms (keystrokes / relay / socket). What matters to the user is only
 *    "what is happening now" and "how to fix it".
 * ★ It is `Record<ControlFailure, string>`, so **adding a reason fails the type check**.
 */
const CONTROL_MESSAGE: Record<ControlFailure, readonly [string, string]> = {
  // ⚠️ Receiving ESC twice in a row makes the CLI show the "go back to a previous message" screen
  'too-soon': ['続けて2回は止められません（少し待ってからもう一度）', 'You cannot stop twice in a row. Wait a moment and try again.'],
  'pending-approval': ['承認を待っている間は止められません（先に承認に答えてください）', 'Cannot stop while an approval is pending. Answer the approval first.'],
  waiting: ['PC の画面でダイアログが開いています（勝手に閉じないため、止めるのはやめました）', 'A dialog is open on the PC screen. Stopping was skipped so the dialog is not closed.'],
  'no-relay': ['このセッションは止められません（PC の新しい窓で開き直すと使えます）', 'This session cannot be stopped. Reopen it in a new terminal window on the PC to enable this.'],
  broken: ['受け渡しの窓口の情報が壊れているので止めませんでした（PC の新しい窓で開き直してください）', 'Did not stop: the handoff endpoint info is broken. Reopen the session in a new terminal window on the PC.'],
  unverified: ['受け渡し先を確かめられないので止めませんでした', 'Did not stop: could not verify the target.'],
  ambiguous: ['同じセッションが複数見つかったので止めませんでした', 'Did not stop: multiple sessions with the same ID were found.'],
  'not-found': ['そのセッションは動いていないので止めませんでした', 'Did not stop: that session is not running.'],
  unreachable: ['受け渡しの窓口が応答しません', 'The handoff endpoint is not responding.'],
}

/**
 * ★★ Message for "could not clear the input box". ⚠️ **Do not reuse the stop messages** (a different request).
 * ★ It is `Record<ControlFailure, string>`, so **adding a reason fails the type check**.
 */
const CLEAR_MESSAGE: Record<ControlFailure, readonly [string, string]> = {
  // ⚠️ `clear` has a 0 interval so it never gets here (present to fill the type)
  'too-soon': ['続けて送れません（少し待ってからもう一度）', 'Cannot send again so soon. Wait a moment and try again.'],
  'pending-approval': ['承認を待っている間は触りません（先に承認に答えてください）', 'Nothing is touched while an approval is pending. Answer the approval first.'],
  waiting: ['PC の画面でダイアログが開いています（勝手に触らないため、やめました）', 'A dialog is open on the PC screen. Skipped so the dialog is not disturbed.'],
  'no-relay': ['このセッションの入力欄は消せません（PC の新しい窓で開き直すと使えます）', "This session's input box cannot be cleared. Reopen it in a new terminal window on the PC to enable this."],
  broken: ['受け渡しの窓口の情報が壊れているので触りませんでした（PC の新しい窓で開き直してください）', 'Did nothing: the handoff endpoint info is broken. Reopen the session in a new terminal window on the PC.'],
  unverified: ['受け渡し先を確かめられないので触りませんでした', 'Did nothing: could not verify the target.'],
  ambiguous: ['同じセッションが複数見つかったので触りませんでした', 'Did nothing: multiple sessions with the same ID were found.'],
  'not-found': ['そのセッションは動いていません', 'That session is not running.'],
  // ⚠️ Do not use the same text as "stop" (it becomes unclear which request this answers)
  unreachable: ['受け渡しの窓口が応答しないので、入力欄は消せていません', 'The handoff endpoint is not responding, so the input box was not cleared.'],
}

/** ★ Separate messages per key (⚠️ never give a reply for something other than what was asked) */
export function controlMessage(reason: ControlFailure, key: ControlKey = 'escape'): string {
  return t(...(key === 'clear' ? CLEAR_MESSAGE[reason] : CONTROL_MESSAGE[reason]))
}

/**
 * ★★ Message when a table command did not run. ⚠️ **Do not reuse the stop messages** (a different request).
 * ★ It is `Record<CommandFailure, string>`, so **adding a reason fails the type check**.
 */
const COMMAND_MESSAGE: Record<CommandFailure, readonly [string, string]> = {
  'too-soon': ['続けて実行できません（少し待ってからもう一度）', 'Cannot run again so soon. Wait a moment and try again.'],
  'pending-approval': ['承認を待っている間は実行しません（先に承認に答えてください）', 'Commands are not run while an approval is pending. Answer the approval first.'],
  waiting: ['PC の画面でダイアログが開いています（勝手に触らないため実行しませんでした）', 'A dialog is open on the PC screen. The command was not run so the dialog is not disturbed.'],
  'no-relay': ['このセッションでは実行できません（PC の新しい窓で開き直すと使えます）', 'Commands cannot be run in this session. Reopen it in a new terminal window on the PC to enable this.'],
  broken: ['受け渡しの窓口の情報が壊れているので実行しませんでした（PC の新しい窓で開き直してください）', 'Not run: the handoff endpoint info is broken. Reopen the session in a new terminal window on the PC.'],
  unverified: ['受け渡し先を確かめられないので実行しませんでした', 'Not run: could not verify the target.'],
  ambiguous: ['同じセッションが複数見つかったので実行しませんでした', 'Not run: multiple sessions with the same ID were found.'],
  'not-found': ['そのセッションは動いていません', 'That session is not running.'],
  unreachable: ['受け渡しの窓口が応答しません', 'The handoff endpoint is not responding.'],
  // ⚠️⚠️ The body went in but Enter did not arrive = **the command text remains in the PC's input box**.
  //    If a person presses Enter there it **runs**, so say that much (codex 2026-08-25, high #3).
  partial:
    ['途中で失敗したので実行していません。⚠️ PC の入力欄にコマンドの文字が残っています（そのまま Enter を押すと実行されます）。二重に実行しないため、こちらからは送り直しません', 'Failed partway, so the command was not run. ⚠️ The command text remains in the input box on the PC (pressing Enter there will run it). It will not be resent, to avoid running it twice.'],
}

export function commandMessage(reason: CommandFailure): string {
  return t(...COMMAND_MESSAGE[reason])
}

/*
 * ★ The sequence of leading "invisible" characters and the test for dropped control characters are **the single copy in `shared/types.ts`**
 *   (`LEADING_INVISIBLE` / `isDroppedControl` / `looksLikeCommand`).
 *
 * ⚠️⚠️ They used to be written here, and **disagreed with the UI side (the warning while typing)**
 *    (codex 2026-08-24, low #2: `\u200b/help` gave no warning on screen but was rewritten by the agent).
 *    ⇒ Do not put "which characters count as the start" in two places.
 */

export interface Sanitized {
  text: string
  dropped: number
  /** ★ The start was `/` or `!`, so **one space was added** (= made into a form that does not run as a command) */
  neutralized?: boolean
}

/**
 * Convert into a form that is safe to send as keystrokes.
 *
 * ⚠️ **CR becomes a newline**. Dropping it joins lines; passing it through **submits midway and splits into two instructions**.
 * ⚠️ **Control characters including ESC are dropped**. If ESC gets through, the selection in a choice dialog moves.
 *
 * ## ★★★ A leading `/` or `!` is "neutralized with one space" rather than "refused" (2026-08-24)
 *
 * **Measured (2.1.241 / the real TUI)**:
 *   `␣/help` → "it was not executed because of the leading space; it arrived as a plain message"
 *   `␣!ls`   → "the leading space means the `!` prefix has no effect"
 * ⇒ **One space disables the CLI's command interpretation.**
 *
 * ⚠️⚠️ It used to "refuse and drop into the inbox", which was bad in two ways:
 *   1. The inbox **does more than add a frame**. The receiving model treats it as "a request from a peer" and
 *      **actually executes it** (measured: a dropped `/tes` ran `make test` / `!ls` ran ls)
 *   2. Even **ordinary sentences** like "look at /home/..." were dropped (because they start with `/`)
 * ⇒ **Neither drop nor refuse.** Running something as a real command happens only via
 *   the table (`SLASH_COMMANDS`) + a dedicated endpoint (never from free input).
 *
 * ⚠️ Normalization is "**drop leading whitespace and newlines, then** put one space". Sending `\n/help` as is
 *    gives **an empty line 1 and `/help` on line 2**; we have not measured whether the CLI looks at the start of input or at line 1,
 *    so we settle on a form that puts `/` **neither at a line start nor at the input start**.
 */
export function sanitizeForKeys(text: unknown): { ok: true; value: Sanitized } | { ok: false; reason: KeysFailure } {
  if (typeof text !== 'string' || text.trim().length === 0) return { ok: false, reason: 'empty' }

  // ★★★ **The order matters** (fixed 2026-08-23).
  //
  // ⚠️⚠️ It used to be "check `/` `!` → then drop control characters", so
  //    **every input whose result after dropping had a forbidden form got through** (measured):
  //      `\x01/compact` → `/compact` (the slash command runs)
  //      `\x00!rm -rf /` → `!rm -rf /` (enters bash mode)
  //      `\x1b/…` `\x9b/…` (C1 CSI) likewise
  //    ⇒ **Check against the value the implementation finally produces** (mistake type 3 in VERIFY.md).
  //    ⚠️ Four reviewers pointed this out independently. The tests only passed `'/compact'`, an
  //       **already clean string**, so we could not notice.
  const normalized = text.replace(/\r\n?/g, '\n')
  let dropped = 0
  let cleaned = ''
  for (const ch of normalized) {
    // ★ Which characters to drop is the single copy in shared (same rule as the UI)
    if (isDroppedControl(ch.codePointAt(0) ?? 0)) dropped += 1
    else cleaned += ch
  }
  if (cleaned.trim().length === 0) return { ok: false, reason: 'empty' }

  // ⚠️ Check the limit against **what the user typed** (excluding the 1 byte added by neutralizing. Including it
  //    would make "sendable on screen but refused by the agent" happen only for `/`-leading text right at the limit)
  if (Buffer.byteLength(cleaned, 'utf8') > MAX_KEYS_BYTES) return { ok: false, reason: 'too-long' }

  // ⚠️ What we look at is **the first "visible" character** (the test is shared `looksLikeCommand`).
  //    A `/` on line 2 or later is ignored (the CLI does not treat it as a command. Widening it breaks ordinary text)
  if (looksLikeCommand(cleaned)) {
    const head = cleaned.replace(LEADING_INVISIBLE, '')
    // ★ **Settle on the form measured to be safe** (one space + `/`).
    //   ⚠️ Drop leading invisible characters before adding it (keeping them gives "the char after the space is not `/`",
    //      and how the CLI handles that is unmeasured). ⚠️ Invisible characters **inside** the body are left alone.
    return { ok: true, value: { text: ` ${head}`, dropped, neutralized: true } }
  }
  return { ok: true, value: { text: cleaned, dropped } }
}

/** Inputs for one session (★ decided in one place: `resolvePane`) */
export interface PaneEvidence {
  found: PaneTarget[]
  sawSession: boolean
  unverified: boolean
  broken: boolean
  /** ★ The CLI is showing a dialog and waiting (a kind that never reaches the approval hook) */
  waiting: boolean
  /**
   * ★★★ **Live processes** claiming that sessionId (codex 2026-08-24, medium #1).
   *
   * ⚠️⚠️ Opening `--resume` in another window can give **two live processes with the same sessionId**.
   *    Previously we treated it as "one target found" and **typed into it** (measured). The instance the user
   *    is looking at is the list's representative (`selectLive`), so **text would land in another window**.
   * ⚠️ Dead ones and pid-reused ones are excluded (they would muddy the count).
   */
  livePids: Set<number>
}

export interface PaneScan {
  /** sessionId → keystroke target or reason. ⚠️ **Sessions that are not alive are not included** */
  bySession: Map<string, PaneTarget | { reason: PaneFailure }>
  /** ★ Number of index entries that could not be read (counted so we never conclude "not there") */
  skipped: number
}

/**
 * Produce an answer from the collected inputs. ★ **The order matters** (it changes the on-screen text).
 *
 * ⚠️ This is the only decision. `findPane` (keystroke target) and the list marker **always go through this**
 *    (when `npm run keys` had its own implementation, it disagreed with the real one in 6 cases).
 */
export function resolvePane(e: PaneEvidence): PaneTarget | { reason: PaneFailure } | undefined {
  // ★★ **Refuse first even if a target was found** (cannot decide which window it goes to / codex medium #1)
  if (e.livePids.size > 1) return { reason: 'ambiguous' }
  if (e.found.length > 1) return { reason: 'ambiguous' }
  if (e.found.length === 1) return e.found[0]!
  // ★ Report an open dialog before "broken"
  if (e.waiting) return { reason: 'waiting' }
  if (e.broken) return { reason: 'broken' }
  if (e.unverified) return { reason: 'unverified' }
  if (e.sawSession) return { reason: 'no-relay' }
  return undefined // ★ that session was not in the index (the caller looks at skipped to decide)
}

/**
 * ★★ Scan the index **only once** and build a view for **all sessions** (2026-08-24).
 *
 * ⚠️ The list (`/sessions`) comes every time, so calling `findPane` per session makes
 *    **the index scan quadratic in the count**. ⇒ One scan, the same decision function.
 */
export async function scanPanes(
  dirs: ConfigDir[],
  aliveProcStart: (pid: number) => string | null | undefined = aliveProcStartSync,
  /**
   * ★ When only one entry is wanted (`findPane`). The decision (`resolvePane`) goes through the same code, so
   *    it does not disagree with the list marker.
   * ⚠️ The narrowing happens **after parsing** (the `/proc` liveness check and reading the `panes/<pid>.json` announcement).
   *    The index JSON itself is **fully read** by `readIndexEntriesDetailed`
   *    (codex finding 2026-08-24. My comment said "which index is read", which was wrong).
   * ⚠️ Without it, sending one message **reads the announcements of all sessions** (makes the daily path heavier).
   */
  only?: string,
): Promise<PaneScan> {
  const evidence = new Map<string, PaneEvidence>()
  const take = (id: string): PaneEvidence => {
    let e = evidence.get(id)
    if (!e) {
      e = {
        found: [],
        sawSession: false,
        unverified: false,
        broken: false,
        waiting: false,
        livePids: new Set(),
      }
      evidence.set(id, e)
    }
    return e
  }
  let skipped = 0

  for (const dir of dirs) {
    // ★★ **Do not discard "could not read"** (2026-08-23). The CLI rewrites `sessions/<pid>.json`
    //    every time its state changes, so hitting that moment makes the index temporarily unreadable.
    //    ⚠️ We used to use `readIndexEntries` (the one that discards `skipped`), so
    //       live sessions were declared **`not-found`** (= "reopen on the PC to send").
    //       The notification side was fail-closed on the same input; only the sending side was lax.
    const read = await readIndexEntriesDetailed(dir)
    if (!read) continue
    if (read.skipped > 0) skipped += read.skipped
    const entries = read.entries
    for (const entry of entries) {
      if (!entry.sessionId) continue
      if (only !== undefined && entry.sessionId !== only) continue
      if (entry.pid === undefined) continue
      const e = take(entry.sessionId)
      const actual = aliveProcStart(entry.pid)
      if (actual === null) continue // dead
      if (typeof actual === 'string' && entry.procStart && !sameProcStart(entry.procStart, actual)) continue // pid reused
      if (typeof actual !== 'string' || !entry.procStart) {
        // alive but identity cannot be confirmed (mac etc.)
        e.unverified = true
        continue
      }
      // ★★ Only count **those that pass the triple check** (codex 2026-08-24, low).
      //
      // ⚠️⚠️ Counting merely "not dead" would make **an index written by an old CLI** and
      //    **leftovers whose pid was reused by another process** look like "a second live session",
      //    so **a healthy session becomes `ambiguous` and neither keystrokes nor ESC can be sent**
      //    (= silently falls into the inbox. A hole my fix almost created).
      // ★ For duplicates that cannot be confirmed, `found` (a confirmed target) wins.
      //   Reason: the current CLI always writes `procStart`, so an unconfirmable duplicate is
      //   far more likely "leftover + pid reuse". ⚠️ Measure before changing this.
      e.livePids.add(entry.pid)
      e.sawSession = true
      // ★★★ If the CLI is showing a dialog and waiting for a person, do not type (added 2026-08-23).
      //
      // ⚠️⚠️ The approval hook (`hasPendingApproval`) only sees **tool-call approvals**.
      //    CLI dialogs include `dialog open` / `input needed` / `sandbox request` /
      //    `worker request`, and **none of them reach the hook** (`web/src/ui/status.ts`
      //    said so, yet it was not wired into the keystroke side).
      //    Typing there turns the first character into a key press, and **a digit confirms a choice**.
      // ★ The input is **already at hand** (the index has `status` / `waitingFor`).
      if (entry.status === 'waiting') {
        e.waiting = true
        continue
      }

      const rec = await readJsonFile<PaneRecord>(join('panes', `${entry.pid}.json`))
      if (rec.kind === 'missing') continue // not started through the relay (a normal branch)
      if (rec.kind === 'broken') {
        // ⚠️ Do not fail open. If it is broken, do not type
        e.broken = true
        continue
      }
      const socketPath = typeof rec.value.socket === 'string' ? rec.value.socket : ''
      const recPid = typeof rec.value.pid === 'number' ? rec.value.pid : undefined
      const recStart = typeof rec.value.procStart === 'string' ? rec.value.procStart : undefined
      if (!socketPath || recPid !== entry.pid) {
        e.broken = true
        continue
      }
      // ★ The announcement's procStart must also match (rejects stale announcements left behind)
      if (recStart === undefined || typeof actual !== 'string' || !sameProcStart(recStart, actual)) {
        e.unverified = true
        continue
      }
      e.found.push({ sessionId: entry.sessionId, pid: entry.pid, socketPath, ...(entry.status === 'busy' ? { busy: true } : {}) })
    }
  }

  const bySession = new Map<string, PaneTarget | { reason: PaneFailure }>()
  for (const [id, e] of evidence) {
    const r = resolvePane(e)
    if (r) bySession.set(id, r)
  }
  return { bySession, skipped }
}

/**
 * Find the keystroke target.
 *
 * ★ The join key is the **pid**. The CLI's index (`sessions/<pid>.json`) maps sessionId → pid, and
 *   `panes/<pid>.json` (the announcement written by the relay) gives the socket.
 *
 * ⚠️ **Always cross-check procStart** (the index, `/proc` and the announcement).
 *    Never type into something we cannot confirm (typing into a reused pid is the worst case).
 * ★ The decision itself goes through **the same function** as `scanPanes` (`resolvePane`).
 */
export async function findPane(
  dirs: ConfigDir[],
  sessionId: string,
  // ⚠️⚠️ **The check right before sending does not use the cache** (codex round 13, high #1 / `aliveProcStartFreshSync`).
  //    ★ The list (`scanPanes` default) and cleanup (`sweepPanes`) keep the cache:
  //      the list calls it per entry so it is heavy, and cleanup with a stale answer only errs toward "keep, do not delete".
  aliveProcStart: (pid: number) => string | null | undefined = aliveProcStartFreshSync,
): Promise<PaneTarget | { reason: PaneFailure }> {
  const scan = await scanPanes(dirs, aliveProcStart, sessionId)
  const hit = scan.bySession.get(sessionId)
  if (hit) return hit
  // ⚠️ While some index entries were unreadable, do not conclude "not there" (it may be found on the next pass)
  if (scan.skipped > 0) return { reason: 'unverified' }
  return { reason: 'not-found' }
}

/**
 * Stream keystrokes to the socket. Body → (short wait) → CR.
 *
 * ⚠️ **A failure after even one byte was written is `partial`**. The caller **must not drop it into the inbox**.
 */
export function writeKeys(
  socketPath: string,
  text: string,
  /**
   * ⚠️⚠️ `beforeWrite` runs **after `connect`, right before writing the body** (codex round 7, medium #4, 2026-08-25).
   *    The caller's check only happened before `connect`, so **an approval appearing in between was ignored**.
   * ★ `beforeSubmit` is right before the CR (that one existed before). **Two steps, so check twice**.
   */
  opts: { submitDelayMs?: number; beforeWrite?: () => boolean; beforeSubmit?: () => boolean } = {},
): Promise<KeysResult> {
  const delay = opts.submitDelayMs ?? SUBMIT_DELAY_MS
  return new Promise((resolve) => {
    let done = false
    let wrote = false
    let timer: NodeJS.Timeout | undefined
    let submit: NodeJS.Timeout | undefined
    const finish = (r: KeysResult): void => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      if (submit) clearTimeout(submit)
      resolve(r)
    }
    const sock = connect(socketPath)
    timer = setTimeout(() => {
      sock.destroy()
      finish(
        wrote
          ? { ok: false, reason: 'partial', message: failureMessage('partial') }
          : { ok: false, reason: 'unreachable', message: failureMessage('unreachable') },
      )
    }, CONNECT_TIMEOUT_MS)

    sock.on('error', () => {
      sock.destroy()
      finish(
        wrote
          ? { ok: false, reason: 'partial', message: failureMessage('partial') }
          : { ok: false, reason: 'unreachable', message: failureMessage('unreachable') },
      )
    })
    sock.on('connect', () => {
      // ★★ Check right before writing the body (⚠️ removing it ignores an approval that appeared during `connect`)
      if (opts.beforeWrite?.() === true) {
        // ⚠️⚠️ **Call `finish` first** (if `destroy()` goes first, `'error'` wins with unreachable)
        finish({
          ok: false,
          reason: 'pending-approval',
          message: failureMessage('pending-approval'),
        })
        sock.destroy()
        return
      }
      sock.write(text, (err) => {
        if (err) return // picked up by the 'error' handler
        wrote = true
        // ★ Wait a little before Enter (so it is not absorbed by paste detection)
        submit = setTimeout(() => {
          // ★★ Check once more **right before** sending the CR (2026-08-23).
          //    ⚠️ If an approval card is showing here, **do not submit**. The body stays in the input box, so
          //       stop as `partial` (dropping to the inbox would deliver it twice)
          if (opts.beforeSubmit?.() === true) {
            sock.destroy()
            finish({ ok: false, reason: 'partial', message: failureMessage('partial') })
            return
          }
          sock.write('\r', () => {
            sock.end()
            finish({ ok: true })
          })
        }, delay)
      })
    })
  })
}

/**
 * Write the record (⚠️ **never the body**. Only identifiers and length / §6.2).
 *
 * ★ Keystrokes and control keys go through **the same one place** (two formats means one of them leaks the body).
 */
async function appendSent(fields: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(stateDir(), { recursive: true, mode: 0o700 })
    const line = JSON.stringify({ at: new Date().toISOString(), ...fields })
    await appendFile(join(stateDir(), 'sent.jsonl'), `${line}\n`, { mode: 0o600 })
  } catch {
    // Failing to record does not block sending
  }
}

/** Record of what was sent. ⚠️ **Never the body** (only identifiers and length / §6.2) */
export async function noteSent(
  sessionId: string,
  chars: number,
  dropped: number,
  failure?: KeysFailure,
): Promise<void> {
  await appendSent({
    sessionId,
    route: 'keys',
    // ⚠️ The unit is UTF-16 code units (an emoji counts as 2). Stated explicitly so the name does not mislead
    chars,
    dropped,
    // ★ Failures are recorded too (⚠️ `partial` is where a record matters most). Omitted on success
    ...(failure ? { failure } : {}),
  })
}

/**
 * ★ Record of a "stop". ⚠️ Write **only the key name** (`escape`).
 *
 * ⚠️ Do not write the raw byte (ESC). A terminal that opens the log **interprets it as an escape sequence**, and
 *    the purpose of the record is "when and which session was stopped", so the name is enough.
 */
export async function noteControl(
  sessionId: string,
  key: ControlKey,
  failure?: ControlFailure,
): Promise<void> {
  await appendSent({ sessionId, route: 'control', key, ...(failure ? { failure } : {}) })
}

/**
 * ★ Record of a table command. ⚠️ Write **only the id** (`compact`).
 *
 * ⚠️ Do not write the text sent (`/compact`). It is uniquely determined by the id, so no information is gained, and
 *    it keeps the "never write the body" form (§6.2).
 */
export async function noteCommand(
  sessionId: string,
  id: CommandId,
  failure?: CommandFailure,
): Promise<void> {
  await appendSent({ sessionId, route: 'command', id, ...(failure ? { failure } : {}) })
}

/**
 * ★★ Send **one at a time** per session (added 2026-08-23).
 *
 * ⚠️⚠️ The relay piles bytes arriving from multiple connections **into one buffer without framing**.
 *    Keystrokes are split into two writes, "body → 120ms → CR", so another send slipping into the gap gives
 *    **`bodyAbodyB\r\r`, and the two are submitted as one broken instruction**
 *    (measured: `AAAAAAAABBBBBBBB` + an empty Enter. Both got `ok`).
 * ⇒ **Serialize on the agent side** (smaller than adding framing to the relay, and it also orders the inbox side).
 * ⚠️ Serialization is **per session** (different sessions may run in parallel).
 */
const chains = new Map<string, Promise<unknown>>()

export function serializeBySession<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve()
  // ⚠️ A failure before does not stop later ones (`fn` is passed to both branches)
  const next = prev.then(fn, fn)
  const settled = next.then(
    () => {},
    () => {},
  )
  chains.set(key, settled)
  // ★ Clean up if we are the last (so the Map does not grow without bound)
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key)
  })
  return next
}

/**
 * Send one message as keystrokes. **If it cannot be sent, just return the reason** (the caller decides whether to switch to the inbox).
 *
 * ⚠️ `ctx` is required. The caller **must always pass** whether an approval card is showing.
 * ⚠️ Sends to the same session are **serialized** (`serializeBySession`).
 */
export async function sendKeysToSession(
  dirs: ConfigDir[],
  sessionId: string,
  text: unknown,
  ctx: KeysContext,
): Promise<KeysResult> {
  return serializeBySession(sessionId, () => sendKeysOnce(dirs, sessionId, text, ctx))
}

async function sendKeysOnce(
  dirs: ConfigDir[],
  sessionId: string,
  text: unknown,
  ctx: KeysContext,
): Promise<KeysResult> {
  // ★ Rule 1: do not type while waiting for an approval (a digit could become a choice)
  const pending = (): boolean => ctx.hasPendingApproval() === true
  if (pending()) {
    return { ok: false, reason: 'pending-approval', message: failureMessage('pending-approval') }
  }
  const clean = sanitizeForKeys(text)
  if (!clean.ok) return { ok: false, reason: clean.reason, message: failureMessage(clean.reason) }

  const target = await findPane(dirs, sessionId)
  if ('reason' in target) {
    return { ok: false, reason: target.reason, message: failureMessage(target.reason) }
  }
  // ⚠️ Check again **after** the target-lookup I/O (an approval may have appeared meanwhile)
  if (pending()) {
    return { ok: false, reason: 'pending-approval', message: failureMessage('pending-approval') }
  }
  const res = await writeKeys(target.socketPath, clean.value.text, {
    beforeWrite: pending,
    beforeSubmit: pending,
  })
  if (res.ok) {
    await noteSent(sessionId, clean.value.text.length, clean.value.dropped)
    return {
      ok: true,
      dropped: clean.value.dropped,
      ...(clean.value.neutralized ? { neutralized: true } : {}),
    }
  }
  // ★ Rule 6 (the record) is **needed on the failure side too**. ⚠️ The record we want most is `partial`
  //   (text has already been typed into the TUI), yet that was the one case without a record.
  //   ⚠️ Never write the body (only the reason and length)
  await noteSent(sessionId, clean.value.text.length, clean.value.dropped, res.reason)
  return res
}

/* ==================== "Stop" (ESC) ==================== */

/**
 * ★★★ **Table of control keys** that can be sent as keystrokes. ⚠️ **This is the only source** (hole 1 in HANDOFF).
 *
 * ⚠️⚠️ **Do not add to it lightly.** The keystroke endpoint is limited to "text"; only this table has keys that act as keys.
 *    The more we add, the closer it gets to "operate the TUI from the phone", and `sanitizeForKeys` means less.
 * ★ Three conditions for adding one (decided when `clear` was added on 2026-08-25):
 *    **(1) Measure on the real machine** (does it work, is firing it on empty harmless) **(2) Give it its own endpoint** (passing
 *    a key name to one endpoint makes "an endpoint that can fire anything in the table") **(3) Add its text and interval to the tables**.
 * ⚠️⚠️ **ESC is one byte, sent once**. Sending it twice in a row makes the CLI
 *    open the "go back to a previous message" dialog (= a different operation).
 * ⚠️ **No CR** (adding one makes an empty submit).
 */
export type ControlKey = 'escape' | 'clear'
export const CONTROL_KEYS: Record<ControlKey, string> = {
  // ESC = stop the response (same as pressing ESC once on the PC)
  escape: '\x1b',
  /**
   * ★★ Ctrl-U = **clear the PC's input box** (added 2026-08-25).
   *
   * Why it is needed: **pressing "stop" while responding makes the CLI put the typed text back in the input box**
   * (so it can be edited and resent). ⇒ Stopping `/compact` leaves `/compact` in the input box, and
   * **the next keystrokes are appended to it** (confirmed on the real machine / user report).
   *
   * ★ Measured (2026-08-25 / the real TUI):
   *   - sending it with text in the input box **empties it**
   *   - **sending it when empty is harmless** (nothing happens even when sent 4 times in a row)
   * ⚠️ Ctrl-C was ruled out (**twice exits the CLI** / different behaviour when empty).
   */
  clear: '\x15',
}

/**
 * ★★★ Per-key "do not send again within" interval. **It is a table, so additions fail the type check**.
 *
 * ⚠️⚠️ ESC is 1.5 s (**twice in a row opens the "go back to a previous message" screen**).
 * ★ `clear` is **0** (measured: repeated and empty sends are harmless. ⚠️ Putting an interval here
 *   would refuse "stop → clear the input box right away", **the most common sequence**).
 */
export const CONTROL_COOLDOWNS: Record<ControlKey, number> = {
  escape: 1500,
  clear: 0,
}

/**
 * ★★★ Interval for not sending ESC to the same session twice in a row.
 *
 * ⚠️⚠️ Receiving ESC **twice in a row** makes the CLI show the "go back to a previous message" screen.
 *    Once there, it becomes `status:'waiting'` and **keystrokes are refused too** (stuck until closed on the PC).
 * ⚠️ Debouncing on the screen is not enough (**two phones / double tap / resend**).
 * ⚠️ The CLI's window for "twice" is **unmeasured**. This is a floor to squash double taps
 *    (making it longer rules out "it did not stop, so press again", so it is short: 1.5 s).
 */
export const CONTROL_COOLDOWN_MS = 1500

/**
 * Time of the last **successful** send (★ **per key + session** / `controlKeyOf`).
 *
 * ⚠️⚠️ **Remember only when the send succeeded** (same trap as `shouldSendLabel` for notifications). Remembering a failure
 *    as "sent" makes the ESC you really want right after be discarded as "repeated", so
 *    **it never arrives**.
 */
const lastControlAt = new Map<string, number>()

/**
 * ★ Keyed per key (⚠️ do not pollute the ESC decision with `clear`).
 *
 * ⚠️ Right now `clear` has a 0 interval so it is never read or written = **no symptom even without separating**.
 *    We still separate them because **they would mix the moment an interval is added** (a successful `clear` would
 *    corrupt ESC's "twice in a row" decision). ⇒ The shape is pinned by a test.
 */
export const controlKeyOf = (key: ControlKey, sessionId: string): string => `${key}:${sessionId}`

/**
 * Send one control key to the socket.
 *
 * ⚠️⚠️ **`ok` means only "the relay's socket received it"** (codex finding 2026-08-24.
 *    Measured: **even a socket nobody reads returns `ok` in 3ms**).
 *    It does not guarantee that the CLI received it:
 *      - right after startup the CLI's `tty.setraw` (`TCSAFLUSH`) **discards buffered input**
 *      - it piles up while the relay applies backpressure (⚠️ but only when `to_child` exceeds
 *        **4MB** (`max_buf` in `relay.py`) = does not happen in practice)
 *    ⇒ The on-screen text also **does not say** "stopped" (`web/src/ui/stop.ts`).
 *    ⇒ We **decided not to add** an ACK (the relay replying once it actually wrote to the pty):
 *      the cost of adding protocol to the only component on the daily path outweighs it (§9.7.3).
 *
 * ★ Two reasons it is separate from `writeKeys`:
 *   1. **There is no CR step** (no body, so the second step of "body → 120ms → CR" is not needed)
 *   2. So **`partial` cannot happen** (one byte written once).
 *      ⇒ The path "meant to stop but arrived as an instruction" **disappears structurally**
 * ⚠️ We did not merge them with a `submit` switch because **getting that flag wrong puts a CR
 *    after the ESC** (= an empty submit). Kept separate, they cannot be mixed up.
 */
export function writeControl(
  socketPath: string,
  bytes: string,
  /**
   * ★★★ Check once more **right before writing** (codex round 7, medium #4, 2026-08-25. Reproduced by measurement).
   *
   * ⚠️⚠️ The caller's "is an approval card showing" check happened **only before `connect`**.
   *    `connect` is asynchronous, so **it wrote even if an approval appeared in between** (measured: Ctrl-U got through).
   *    ⇒ ESC on an approval card becomes **an unasked-for denial**, and Ctrl-U **erases the choice input**.
   * ⚠️ The window cannot be 0 (`write` itself is async), but it can be narrowed to **right before handing to the kernel**.
   */
  opts: { beforeWrite?: () => boolean } = {},
): Promise<ControlResult> {
  return new Promise((resolve) => {
    let done = false
    let timer: NodeJS.Timeout | undefined
    const finish = (r: ControlResult): void => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve(r)
    }
    const sock = connect(socketPath)
    timer = setTimeout(() => {
      sock.destroy()
      finish({ ok: false, reason: 'unreachable', message: failureMessage('unreachable') })
    }, CONNECT_TIMEOUT_MS)
    sock.on('error', () => {
      sock.destroy()
      finish({ ok: false, reason: 'unreachable', message: failureMessage('unreachable') })
    })
    sock.on('connect', () => {
      // ★★ Check right before writing (⚠️ removing it ignores an approval that appeared during `connect`)
      if (opts.beforeWrite?.() === true) {
        // ⚠️⚠️ **Call `finish` first**. If `destroy()` goes first, the `'error'` handler
        //    resolves first with `unreachable` (we actually hit this)
        finish({
          ok: false,
          reason: 'pending-approval',
          message: controlMessage('pending-approval'),
        })
        sock.destroy()
        return
      }
      sock.write(bytes, (err) => {
        if (err) return // picked up by the 'error' handler
        sock.end()
        finish({ ok: true })
      })
    })
  })
}

/**
 * ★★ Send "stop" once. **Even on failure it is not dropped into the inbox** (the caller has no such path either).
 *
 * ⚠️⚠️ Dropping it would put "please stop" **into the conversation as an instruction** (it does not stop, and pollutes the context).
 * ⚠️ Refusal conditions use the same inputs as keystrokes:
 *    - an approval card is showing (ESC closes the dialog = **an unasked-for denial**)
 *    - the CLI is showing a dialog and waiting (`findPane` refuses with `waiting`)
 * ⚠️ **Put it on the same serialization as keystrokes** (`serializeBySession`). Sending a body is
 *    two steps, "body → 120ms → CR", so an ESC in that gap
 *    **clears the input box and only the CR goes out** (an empty submit).
 */
/**
 * ★★ The gap between ESC and Ctrl-U (measured on the real machine 2026-09-24 / Claude Code 2.1.281).
 *
 * ⚠️⚠️ **Arriving back to back, ESC does not work**: with a 5ms or 20ms gap it is read as "Alt + Ctrl-U" and **the response does not stop**,
 *    and text sent afterwards was queued as "a waiting message". Sending both bytes in one write did the same.
 *    50ms and 100ms stopped and emptied all 3 times each ⇒ **150ms for a 3x margin**.
 * ★ After stopping, the original text returns to the input box in about 90ms. Keys are processed in arrival order, so it is always cleared afterwards within this gap.
 */
export const STOP_CLEAR_GAP_MS = 150

/**
 * ★★ "Stop": send ESC and, **if it was responding**, clear the input box with Ctrl-U 150ms later (2026-09-24 / user request).
 *
 * Why: stopping before the response appears (while thinking, during `/compact`) makes the CLI **put the sent text back in the input box**.
 *   Left there, the next text sent from the phone **is appended to it**, and for `/compact` Enter **reruns the compaction** (confirmed on the real machine).
 * ⚠️ Clear **only when it was responding** (ESC while idle does nothing ⇒ clearing would only erase what the PC user was typing).
 *    ⚠️ Text the PC user was typing during the response is also cleared (user accepted. Ctrl+Y on the PC brings it back).
 * ⚠️ Both are sent on **one serialization** (keystrokes slipping in between would erase their body / put characters right after the ESC).
 * ⚠️ If an approval appears in between, do not clear (`sendControlOnce` checks = rule 4).
 */
export async function sendStopToSession(
  dirs: ConfigDir[],
  sessionId: string,
  ctx: KeysContext,
  opts: { now?: () => number; gapMs?: number } = {},
): Promise<ControlResult> {
  return serializeBySession(sessionId, async () => {
    const esc = await sendControlOnce(dirs, sessionId, 'escape', ctx, opts)
    if (!esc.ok || !esc.busy) return esc
    await new Promise((r) => setTimeout(r, opts.gapMs ?? STOP_CLEAR_GAP_MS))
    const clear = await sendControlOnce(dirs, sessionId, 'clear', ctx, opts)
    return clear.ok ? { ...esc, cleared: true } : esc
  })
}

export async function sendControlToSession(
  dirs: ConfigDir[],
  sessionId: string,
  key: ControlKey,
  ctx: KeysContext,
  /** ⚠️ Replacing the clock is for tests only (defaults to the real clock). Decided only here */
  opts: { now?: () => number } = {},
): Promise<ControlResult> {
  return serializeBySession(sessionId, () => sendControlOnce(dirs, sessionId, key, ctx, opts))
}

async function sendControlOnce(
  dirs: ConfigDir[],
  sessionId: string,
  key: ControlKey,
  ctx: KeysContext,
  opts: { now?: () => number },
): Promise<ControlResult> {
  const now = opts.now ?? Date.now
  const pending = (): boolean => ctx.hasPendingApproval() === true
  const refuse = (reason: ControlFailure): ControlResult => ({
    ok: false,
    reason,
    message: controlMessage(reason, key),
  })
  if (pending()) return refuse('pending-approval')
  // ★ Refuse repeated sends (⚠️ inside the serialization, so no race). ★ The interval comes from **the per-key table**
  const cooldown = CONTROL_COOLDOWNS[key]
  const prev = lastControlAt.get(controlKeyOf(key, sessionId))
  if (cooldown > 0 && prev !== undefined && now() - prev < cooldown) {
    await noteControl(sessionId, key, 'too-soon')
    return refuse('too-soon')
  }

  const target = await findPane(dirs, sessionId)
  if ('reason' in target) {
    await noteControl(sessionId, key, target.reason)
    return refuse(target.reason)
  }
  // ⚠️ Check again **after** the target-lookup I/O (an approval may have appeared meanwhile)
  if (pending()) return refuse('pending-approval')

  const res = await writeControl(target.socketPath, CONTROL_KEYS[key], { beforeWrite: pending })
  await noteControl(sessionId, key, res.reason)
  if (res.ok && target.busy) res.busy = true
  // ★★ **Rebuild the message here** (2026-08-25 / noticed around codex round 7).
  //   ⚠️ The message `writeControl` puts in is **for keystrokes** (`failureMessage`), so
  //      "stop" showed "The keystroke endpoint is not responding" (an internal term = violates CLAUDE.md §2).
  //      ⇒ Pass it through the per-key table (`controlMessage(reason, key)`).
  if (!res.ok && res.reason) return refuse(res.reason)
  // ⚠️⚠️ Remember **only when the send succeeded** (remembering a failure discards the next attempt)
  if (res.ok && cooldown > 0) {
    lastControlAt.set(controlKeyOf(key, sessionId), now())
    // ★ Drop memories that are no longer needed (so the Map does not grow without bound)
    for (const [id, at] of lastControlAt) {
      if (id !== controlKeyOf(key, sessionId) && now() - at >= cooldown) lastControlAt.delete(id)
    }
  }
  return res
}

/* ==================== Table slash commands (`/compact` / `/exit`) ==================== */

/**
 * ★★ Interval for not sending commands back to back (⚠️ **a separate store from ESC**).
 *
 * ⚠️⚠️ It originally shared `lastControlAt`, so **for 1.5 s after `/compact` the
 *    emergency stop (ESC) did not work** (codex 2026-08-25, medium #3. Reproduced in a test).
 *    ⇒ Debouncing can be **independent per operation** (the danger of two ESCs in a row is owned by the ESC side).
 * ⚠️ Preventing interleaving (something slipping in while a body is being sent) is `serializeBySession`'s job;
 *    this one squashes "double tap on the same button / two phones".
 */
const lastCommandAt = new Map<string, number>()

/**
 * ★★★ Table of what can be typed from the phone **as a real command**. ⚠️ **This is the only source**.
 *
 * ⚠️⚠️ **Do not pass through `sanitizeForKeys`** (it would insert a space before `/` and make it
 *    "just text" = not executed). ⇒ This is **a path free input can never take**;
 *    only a `CommandId` can be passed. **Do not add a parameter that accepts a string.**
 * ⚠️ The conditions for adding entries are in `CommandId` in `shared/types.ts` ((1) non-interactive (2) visible effect).
 * ★ No CR here (`writeKeys` sends it as "body → 120ms → CR").
 */
export const SLASH_COMMANDS: Record<CommandId, string> = {
  compact: '/compact',
  exit: '/exit',
}

/**
 * ★★ Run a table command once.
 *
 * ⚠️⚠️ **Even on failure it is not dropped into the inbox** (the caller has no such path either). A dropped `/compact`
 *    is **executed as a request** by the receiving model (measured 2026-08-24).
 * ⚠️ Refusal conditions use the same inputs as "stop" (approval card / dialog / repeated / serialization).
 * ⚠️⚠️ **If half-typed text remains in the PC's input box, it is joined and not executed**
 *    (measured 2026-08-25: `いま` ("now") + `/compact` → `いま/compact` was sent as a plain message).
 *    ⇒ We **do not clear the input box** here (silently erasing the PC user's draft is worse).
 * ⚠️⚠️ **Writing "it is only sent as a message, so it is recoverable (fail-safe)" was wrong**
 *    (codex 2026-08-25, high #1). This endpoint **sends a CR** at the end, so
 *    **a draft starting with `!` runs in bash mode, and one starting with `/` runs that command**.
 *    ⇒ What we can guarantee is only that "**the table command is not executed**"; **the draft side cannot be guaranteed**.
 *    ★ The on-screen confirmation dialog says so (`DRAFT_WARNING` in `web/src/ui/commands.ts`).
 */
export async function sendCommandToSession(
  dirs: ConfigDir[],
  sessionId: string,
  id: CommandId,
  ctx: KeysContext,
  /** ⚠️ Replacing the clock is for tests only (defaults to the real clock) */
  opts: { now?: () => number } = {},
): Promise<CommandResultInternal> {
  return serializeBySession(sessionId, () => sendCommandOnce(dirs, sessionId, id, ctx, opts))
}

export interface CommandResultInternal {
  ok: boolean
  reason?: CommandFailure
  message?: string
}

async function sendCommandOnce(
  dirs: ConfigDir[],
  sessionId: string,
  id: CommandId,
  ctx: KeysContext,
  opts: { now?: () => number },
): Promise<CommandResultInternal> {
  const now = opts.now ?? Date.now
  const pending = (): boolean => ctx.hasPendingApproval() === true
  const refuse = (reason: CommandFailure): CommandResultInternal => ({
    ok: false,
    reason,
    message: commandMessage(reason),
  })
  if (pending()) return refuse('pending-approval')
  // ★ Refuse repeated sends (⚠️ **a separate store from ESC**. See `lastCommandAt` above)
  const prev = lastCommandAt.get(sessionId)
  if (prev !== undefined && now() - prev < CONTROL_COOLDOWN_MS) {
    await noteCommand(sessionId, id, 'too-soon')
    return refuse('too-soon')
  }

  const target = await findPane(dirs, sessionId)
  if ('reason' in target) {
    await noteCommand(sessionId, id, target.reason)
    return refuse(target.reason)
  }
  // ⚠️ Check again **after** the target-lookup I/O (an approval may have appeared meanwhile)
  if (pending()) return refuse('pending-approval')

  // ⚠️⚠️ Pass only **the table value** (not a string from the arguments)
  const res = await writeKeys(target.socketPath, SLASH_COMMANDS[id], {
    beforeWrite: pending,
    beforeSubmit: pending,
  })
  if (res.ok) {
    await noteCommand(sessionId, id)
    // ⚠️⚠️ Remember **only when the send succeeded** (remembering a failure discards the next attempt)
    lastCommandAt.set(sessionId, now())
    // ★ Drop memories that are no longer needed (so the Map does not grow without bound)
    for (const [id2, at] of lastCommandAt) {
      if (id2 !== sessionId && now() - at >= CONTROL_COOLDOWN_MS) lastCommandAt.delete(id2)
    }
    return { ok: true }
  }
  // ⚠️ The only reasons that get here are **a write failure or an approval** (the body is a table constant, so `empty` / `too-long`
  //    cannot happen). ⇒ Do not carry the type across; **fold into three** (do not leave a hole in the `Record`).
  // ⚠️⚠️ **Do not squash `pending-approval`** (codex round 8, medium #1, 2026-08-25).
  //    When `beforeWrite` (right before writing the body) found an approval, it also turned into `unreachable`,
  //    so the screen said "the endpoint is not responding", HTTP was 502 and the record said `unreachable`
  //    (**not a single byte was written, so it was safe, but the reason was a lie**).
  const reason: CommandFailure =
    res.reason === 'partial' || res.reason === 'pending-approval' ? res.reason : 'unreachable'
  await noteCommand(sessionId, id, reason)
  return { ok: false, reason, message: commandMessage(reason) }
}

/**
 * ★ Clean up announcements and sockets that were not cleaned up (2026-08-23).
 *
 * ⚠️ The relay removes its own announcement and socket in `finally`, but **that does not run on SIGKILL**
 *    (43 sockets had piled up on a real machine). Nothing is misdelivered (`findPane`'s triple check holds), but
 *    it muddies the view, so clean up periodically.
 * ⚠️⚠️ **The only condition for deleting is "that process is gone"** (deleting a live one kills keystrokes).
 * ⚠️ **The relay decides** where sockets live, so we do not build the path here
 *    (look only next to the actual path written in the announcement = do not put the decision in two places).
 */
export async function sweepPanes(
  aliveProcStart: (pid: number) => string | null | undefined = aliveProcStartSync,
): Promise<{ panes: number; socks: number }> {
  const dir = join(stateDir(), 'panes')
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return { panes: 0, socks: 0 }
  }
  let panes = 0
  let socks = 0
  const sockDirs = new Set<string>()
  for (const name of names) {
    const m = /^(\d+)\.json$/.exec(name)
    if (!m) continue
    const pid = Number(m[1])
    const rec = await readJsonFile<PaneRecord>(join('panes', name))
    const socket = rec.kind === 'ok' && typeof rec.value.socket === 'string' ? rec.value.socket : ''
    if (socket) sockDirs.add(dirname(socket))
    const actual = aliveProcStart(pid)
    // ⚠️ Do not touch ones whose liveness is unknown (mac)
    if (actual !== null) continue
    try {
      await unlink(join(dir, name))
      panes += 1
    } catch {
      /* vanished at the same time */
    }
    if (socket) {
      try {
        await unlink(socket)
        socks += 1
      } catch {
        /* already gone */
      }
    }
  }
  // ★ Also clean up where the announcement vanished first and **only the socket remains**.
  //   ⚠️ Look only at "the directories announcements pointed to" (do not duplicate how paths are decided)
  for (const d of sockDirs) {
    let entries: string[]
    try {
      entries = await readdir(d)
    } catch {
      continue
    }
    for (const name of entries) {
      const m = /^keys-(\d+)\.sock$/.exec(name)
      if (!m) continue
      if (aliveProcStart(Number(m[1])) !== null) continue
      try {
        await unlink(join(d, name))
        socks += 1
      } catch {
        /* already gone */
      }
    }
  }
  return { panes, socks }
}
