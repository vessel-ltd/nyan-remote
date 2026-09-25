// The one place that decides how the table's slash commands (`/compact` / `/exit`) appear.
//
// ★ Why the decision lives here is the same as `stop.ts`: if "show it or not" is written inside the screen,
//   you get **a button you can press that does nothing**.
//
// ⚠️⚠️ **Confirmation is the screen's job** (the agent cannot confirm). `/exit` in particular is irreversible
//   (the session disappears = **pending approvals disappear too**).
// ⚠️ The decision to refuse (approval card showing, dialog open on the PC, rapid repeats) belongs to the **agent**
//   (`agent/src/routes/command.ts`). The screen just shows the reason as-is.

import type { AgentFeature, CommandId, SessionSummary, AutoApproveDuration } from '../../../shared/types.ts'
import { t } from '../../../shared/i18n.ts'

/** `sending` right after a press (⚠️ never run twice on a double tap) */
export type CommandPhase = 'ready' | 'sending'

/**
 * ★★ Operations that show a confirmation dialog: **the table's commands + `clear`**.
 *
 * ⚠️ `clear` is **not** in `SLASH_COMMANDS` (the text sent as keystrokes) — it is a control key, so it lives on
 *    the `CONTROL_KEYS` side / `POST /sessions/:id/clear`. ⇒ Keep the types separate.
 * ⚠️ Both are **irreversible**, so both confirm (`clear` wipes the draft on the PC).
 */
export type ConfirmKind = CommandId | 'clear' | 'auto-approve'

/**
 * ★★★ **Only operations delivered by keystrokes (TUI).** `commandView` handles nothing else.
 *
 * ⚠️⚠️ Do not mix in `auto-approve`. `commandView` treats `sendRoute !== 'keys'` as "do not show", so mixing it in
 *    means **auto-approve cannot be turned off for a session that cannot take keystrokes**
 *    (the approval hook works regardless of keystrokes, so this is "still passing but cannot be turned off" = the worst shape).
 *    ⇒ Split by type (`autoApproveView` in `ui/autoApprove.ts` handles it).
 */
export type KeyedConfirmKind = Exclude<ConfirmKind, 'auto-approve'>

export interface CommandUi {
  /** Name shown in the menu */
  label: string
  /** Heading of the confirmation dialog */
  title: string
  /** Body of the confirmation dialog. ⚠️ **Say here that it is irreversible** */
  body: string
  /** Label of the button that runs it */
  ok: string
  /**
   * ★ Message shown once sent.
   *
   * ⚠️ **Do not write** "compacted" / "ended". All we know is **that it arrived**; whether it actually ran
   *    is only known from the thread (or from it leaving the list).
   */
  sent: string
}

/**
 * ★★ Extra note added to the confirmation dialog (⚠️ **differs per operation**, so it is a table).
 *
 * ⚠️ "The draft is sent along too" is irrelevant for `clear` (it sends nothing).
 *    ⇒ Showing the same note everywhere means **nobody reads it**.
 */
export function confirmNote(kind: ConfirmKind): string | undefined {
  // ⚠️ Only operations that send text to the TUI via keystrokes are subject to "the draft is sent along too".
  //    `clear` sends nothing / `auto-approve` **uses not a single keystroke** (it goes through the approval hook)
  return kind === 'clear' || kind === 'auto-approve' ? undefined : t(DRAFT_WARNING, DRAFT_WARNING_EN)
}

/**
 * ★★★ **If half-typed text is left in the PC input box, it is sent along too** (measured 2026-08-25).
 *
 * Keystrokes **append** to the input box, so if `いま` is left over, `いま/compact` is what gets sent.
 * ⚠️ We chose **not** to clear it **automatically before sending a command** (silently erasing the PC user's draft is worse).
 *    ★ A **manual button** (`clear`) is provided separately.
 *
 * ⚠️⚠️ **Writing "it only adds an extra message, so it is fail-safe" was wrong** (codex high #1, 2026-08-25).
 *    A CR is sent at the end, so **a draft starting with `!` runs in bash mode, and one starting with
 *    `/` runs that command**. ⇒ What we can guarantee is only "this button's command does not run";
 *    **nothing can be guaranteed about the draft**. Say exactly that.
 */
export const DRAFT_WARNING =
  '⚠️ PC の入力欄に打ちかけの文字が残っていると、それも一緒に送信されます（この操作は実行されません。⚠️ 打ちかけが `/` や `!` で始まっていると、そちらがコマンドとして実行されます）'

/** ★ English for `DRAFT_WARNING` (⚠️ never call `t()` at module top level ⇒ choose where it is used) */
const DRAFT_WARNING_EN =
  '⚠️ Anything left half-typed in the PC input box will be sent along with it (this action itself will not run. ⚠️ If the half-typed text starts with `/` or `!`, that will run as a command)'

/** ★ Wording per operation. `Record<ConfirmKind, …>`, so **adding one fails the type check** */
// ⚠️ Wording is held in getters (calls `t()` on every read = follows language switches / same shape as before)
export const COMMAND_UI: Record<ConfirmKind, CommandUi> = {
  compact: {
    get label() { return t('🗜 会話を圧縮する', '🗜 Compact conversation') },
    get title() { return t('会話を圧縮しますか？', 'Compact the conversation?') },
    get body() {
      return t(
        'これまでの会話を要約して短くします。⚠️ 元の会話には戻せません（要約はスレッドに残ります）。',
        'Summarizes the conversation so far to shorten it. ⚠️ You cannot go back to the original conversation (the summary stays in the thread).',
      )
    },
    get ok() { return t('圧縮する', 'Compact') },
    get sent() {
      return t('圧縮の合図を送りました。要約が出るまで少し待ってください', 'Sent the compact signal. Wait a moment for the summary to appear')
    },
  },
  clear: {
    get label() { return t('⌫ PC の入力欄を消す', '⌫ Clear PC input') },
    get title() { return t('PC の入力欄を消しますか？', 'Clear the PC input box?') },
    // ⚠️⚠️ "Stopping mid-response puts the typed text back in the input box", so this is needed after stopping `/compact`
    get body() {
      return t(
        'PC の入力欄に残っている文字を消します（Ctrl-U と同じ）。⚠️ PC で打ちかけていた下書きも消えます（戻せません）。',
        'Clears any text left in the PC input box (same as Ctrl-U). ⚠️ Any draft being typed on the PC is also lost (cannot be undone).',
      )
    },
    get ok() { return t('消す', 'Clear') },
    get sent() { return t('入力欄を消す合図を送りました', 'Sent the clear-input signal') },
  },
  'auto-approve': {
    get label() { return t('⚡ 自動承認をオンにする', '⚡ Turn on auto-approve') },
    get title() { return t('自動承認モードをオンにしますか？', 'Turn on auto-approve mode?') },
    // ⚠️⚠️ **Spell out what passes automatically** (per the user's decision on 2026-09-07, no exclusion list).
    //    Unless it says "arbitrary `Bash` commands run silently" rather than "skips approvals",
    //    what the person pressing it understands differs from what actually happens
    get body() {
      return t(
        'このセッションの「はい/いいえ」の承認を、選んだ時間だけ自動で許可します（選択肢つきの質問と' +
          'プラン承認は今までどおり止まります）。⚠️ コマンドの実行・ファイルの書き換え・Web 取得も' +
          '**中身を問わず**自動で通ります。PC の画面にも確認は出ません。',
        'Automatically allows this session\'s yes/no approvals for the chosen time (questions with choices and ' +
          'plan approvals still stop as before). ⚠️ Running commands, editing files and web fetches also ' +
          'go through automatically **regardless of content**. No confirmation appears on the PC screen either.',
      )
    },
    // ★ Duration is chosen (2026-09-24). ★ `ok` is 3 hours; 24 hours is `okLong` (only agents with the `auto-approve-24h` marker)
    get ok() { return t('3時間オンにする', 'Turn on for 3 hours') },
    get sent() {
      return t('自動承認をオンにしました（3時間後に自動で切れます）', 'Auto-approve is on (turns off automatically after 3 hours)')
    },
  },
  exit: {
    get label() { return t('⏏ セッションを終了する', '⏏ End session') },
    get title() { return t('このセッションを終了しますか？', 'End this session?') },
    // ⚠️⚠️ Always say that pending approvals disappear (the hook connection dies with the process)
    get body() {
      return t(
        'このセッションは終了します。⚠️ 取り返しがつきません（待っている承認も消えます）。続きは PC で開き直してください。',
        'This session will end. ⚠️ This cannot be undone (pending approvals are lost too). Reopen it on the PC to continue.',
      )
    },
    get ok() { return t('終了する', 'End') },
    get sent() {
      return t('終了の合図を送りました。一覧から消えるまで少し待ってください', 'Sent the end signal. Wait a moment for it to leave the list')
    },
  },
}

export interface CommandView {
  /** Whether to show it in the menu */
  show: boolean
  /** Whether pressing it sends nothing */
  disabled: boolean
  label: string
}

/**
 * ★★★ **Which session** the confirmation dialog was opened for.
 *
 * ★★ **The root fix is rebuilding via `<Thread key={endpoint:session}>`** (codex round 8, high #1, 2026-08-25).
 *    ⇒ The pattern where an async completion started before a switch breaks the post-switch screen **disappears structurally**.
 * ⚠️ The check here is **a backup to that** (so it is not wrong for one frame if the `key` is lost).
 *    ⚠️⚠️ In round 6 we thought "discard it in the switch's `useEffect`" fixed it, but
 *      **`useEffect` runs after paint**, so **it lingered for one frame** (keeping that lesson).
 * ⚠️ The name (`title`) alone is not enough (A and B can have the same name). **Compare by id.**
 */
export interface CommandTarget {
  id: ConfirmKind
  sessionId: string
  endpointId: string
  /** ★ Name of the auto-approve duration (⚠️ only for `auto-approve`; the length lives in the agent's table) */
  duration?: AutoApproveDuration
}

/** ★ Label of the 24-hour button (⚠️ shown only for agents with the `auto-approve-24h` marker / `Thread.tsx`) */
export function autoApproveLongLabel(): string {
  return t('24時間オンにする', 'Turn on for 24 hours')
}

/** ★ Which session (on which machine) it is for. ⚠️ `id` is not used for matching */
export interface Addressed {
  sessionId: string
  endpointId: string
}

/** ★ Does it belong to "the session open right now"? (⚠️ this is the only place that decides) */
export function isCurrentTarget(
  target: Addressed | undefined,
  sessionId: string,
  endpointId: string,
): boolean {
  if (!target) return false
  return target.sessionId === sessionId && target.endpointId === endpointId
}

/**
 * ★★★ **May the running marker be cleared?** (codex round 7, medium #2, 2026-08-25).
 *
 * ⚠️⚠️ Last time we thought it was fixed by "check with `isCurrentTarget(target, sessionId, endpointId)` after completion",
 *    but **`sessionId` is the closure value from the render that created `runCommand`**,
 *    so **the check always succeeded** (= it protected nothing; confirmed by measurement).
 * ⇒ **Compare against the current state** (look at `prev` via the functional form of `setRunning`).
 *    ⚠️ Even the same session and same operation can be a different run, so compare by a **per-run `token`**.
 */
export function releaseRunning<T extends { token: number }>(
  prev: T | undefined,
  token: number,
): T | undefined {
  // ★ Only clear the marker we set ourselves (do not clear someone else's run)
  return prev?.token === token ? undefined : prev
}

/**
 * ★★★ Put **the target's name** in the confirmation dialog's heading (codex high #2, 2026-08-25).
 *
 * ⚠️⚠️ The screen is **not remounted when switching sessions** (`<Thread>` has no `key`).
 *    Jumping to another session from a notification **left only the confirmation dialog behind**,
 *    so the target of "End" had been swapped.
 *    ⇒ The main fix is **carrying the target and not showing it if it does not match** (`isCurrentTarget`).
 *      The name is a third layer **for noticeability**, and ⚠️ **is not a safeguard by itself**
 *      (A and B can have the same name / codex round 6, high #1, 2026-08-25).
 */
export function confirmTitle(id: ConfirmKind, session: SessionSummary | undefined): string {
  const name = session?.title ?? session?.sessionId?.slice(0, 8)
  return name ? `${COMMAND_UI[id].title.replace(/[?？]$/, '')}: ${name}` : COMMAND_UI[id].title
}

/**
 * ★★★ The **agent-side endpoint** each operation needs (maps to `AgentHealth.features`).
 *
 * ⚠️⚠️ It is `Record<ConfirmKind, AgentFeature>`, so **adding an operation fails the type check**
 *    (= the marker mapping cannot be forgotten).
 */
export const NEEDS_FEATURE: Record<ConfirmKind, AgentFeature> = {
  compact: 'slash-commands',
  exit: 'slash-commands',
  clear: 'clear-input',
  'auto-approve': 'auto-approve',
}

export function commandView(
  session: SessionSummary | undefined,
  /** ⚠️ **Only operations delivered by keystrokes** (`auto-approve` is excluded by type; see above) */
  id: KeyedConfirmKind,
  phase: CommandPhase,
  /**
   * ★★★ Features that agent has (`features` from `/health`).
   *
   * ⚠️⚠️ **Do not reuse `sendRoute` as the marker for a new feature** (codex round 7, medium #3, 2026-08-25).
   *    `sendRoute` marks "can it be delivered by keystrokes" and **predates** `/command` and `/clear`.
   *    Measured: with an old-agent-like `{live:true, sendRoute:'keys'}` the button appeared, and pressing it gave **404**.
   * ⚠️ When unknown (`undefined` = old agents do not return it), **do not show it** (fail-closed).
   */
  features: readonly AgentFeature[] | undefined,
): CommandView {
  const ui = COMMAND_UI[id]
  // Not in the list (= unknown whether alive) / not running ⇒ do not show
  if (!session || !session.live) return { show: false, disabled: true, label: ui.label }
  // ★★★ **Do not show it to agents lacking that endpoint** (multiple machines update one by one, so they always coexist)
  if (!features?.includes(NEEDS_FEATURE[id])) return { show: false, disabled: true, label: ui.label }
  // ⚠️⚠️ **Show only for `keys`** (codex low #1, 2026-08-25).
  //   `sendRoute:'inbox'` = no keystroke target = the agent **always refuses with `no-relay`**.
  //  ★ "Stop" (`stop.ts`) is not hidden by state **because it is an emergency action**;
  //     this one is not an emergency, so **not showing it is correct** (there is a reason not to align the rules).
  if (session.sendRoute !== 'keys') return { show: false, disabled: true, label: ui.label }
  if (phase === 'sending') return { show: true, disabled: true, label: `${ui.label}…` }
  return { show: true, disabled: false, label: ui.label }
}
