// ★★ Typing into an agy TUI and stopping it, from the phone (2026-11-20 / docs/AGY.md §8).
//
// The way in is the same pty relay Claude uses (`scripts/relay.py`, started by the `~/.nyan-remote/bin/agy` shim):
// the relay announces `~/.nyan-remote/panes/<agy pid>.json`, and the agy's status line file
// (`~/.nyan-remote/agy/session-<id>.json`) names the same pid. The bytes go through `claude/keys.ts`'s writers
// (`writeKeys` / `writeControl`), so the socket rules (0600, same uid, paste handshake) are the same.
//
// ## What is different from Claude (measured on agy 1.5.12, 2026-11-20)
//
//   1. ⚠️⚠️ **Text is typed only while agy is idle.** On an approval card a digit picks an option at once, Enter takes
//      the option under the cursor and ESC cancels (agy 1.5.13; on 1.5.12 `y` / `n` answered too). agy says a card is up only through its status line (written at most every
//      300 ms after the change), so a card that appears while a turn runs can be up before we know. From idle no
//      card can appear before the model has answered (seconds), and the body + Enter take ~150 ms.
//      ⇒ working / waiting ⇒ refused (agy itself would queue it, but we could not keep it off a card).
//   2. ⚠️⚠️ **"Idle" counts only when the status line wrote it after the transcript's last step.** At a turn's end the
//      idle write came 0.2–0.75 s after the last transcript write (measured). A status line that stopped writing
//      (agy turns it off after 30 failures) would keep an old "idle" while a turn runs; the transcript moving past it
//      shows that ⇒ refused as "cannot tell".
//   3. ⚠️ A body whose first visible character is `?` is refused too: on an empty prompt `?` opens the shortcuts panel and
//      the rest of the text becomes keys inside it (measured: only one letter reached the prompt). `/` `!` as everywhere.
//   4. ★ One space goes after the body: Enter right after `@name` picks a file from the mention list, and Enter after a
//      trailing `\` inserts a newline — neither would send (measured; with the space both sent).
//   5. ★ Stop = one ESC, only while agy works. It does not put the text back into the input box (measured), so there is
//      no Ctrl-U after it. ESC on an idle prompt did nothing, twice in a row too.
//   6. ⚠️ Never falls back to anything (agy has no inbox; a refused text is said to be refused).
//
// ⚠️ Accepted: a panel the person opened on the PC (`/resume`, the shortcuts list) takes the typed keys; agy does not
//    report panels. A `/new` on the PC keeps the old row until the new conversation's first prompt (the status line
//    has no id before it), so text sent then starts the new conversation.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_MESSAGE_BYTES, commandLikeMessage, visibleHead } from '../../../shared/types.ts'
import { t } from '../../../shared/i18n.ts'
import { aliveProcStartFreshSync } from '../claude/sessionIndex.ts'
import {
  CONTROL_KEYS,
  failureMessage,
  needsPaste,
  noteControl,
  noteSent,
  pasteRequest,
  sanitizeForKeys,
  typedTooLong,
  serializeBySession,
  writeControl,
  writeKeys,
  writeSequence,
  openKeyLine,
  type KeyLine,
  type SequenceChunk,
} from '../claude/keys.ts'
import { callBeforeState, readTailRecords, turnEnd, type PendingCall } from './pending.ts'
import { parseAgyQuestion, questionTextsOf, type AgyAnswerPlan, type AgyQuestion, type AgyStep } from './questions.ts'
import { childViewOf, dialogFits, inChildView, inputBoxOf, inputRowOf, listAgy, listFocused, noteUnlisted, parseApproval, previewAsks, parseBanner, parseSubagentList, respondOffered, slashPicked, viewOwnerOf, parseDialog, readAgyScreen, sameQuestionText, showsQuestion, type FooterHint, type ScreenDialog } from './screen.ts'
import {
  AGY_PREFIX,
  AGY_QUESTION_TOOL,
  agyAsking,
  agyChildQuestions,
  agyPendingCall,
  agyConversations,
  agyQuestionInTranscript,
  agyLocksOf,
  agyLocksOfAsync,
  agyPaneOf,
  agyShared,
  readAgyPidFile,
  defaultAgyDeps,
  liveAgy,
  parseAgyFile,
  transcriptPathOf,
  withLocksProbed,
  type AgyDeps,
  type AgyPane,
  type AgyPaneFailure,
  type AgyState,
} from './sessions.ts'

/**
 * What agy's state allows: a send, a stop (★ `asking`: a question is up; `subagent`: a child agent has not finished —
 * its question may be open on the PC and would take the keys / docs/AGY.md §11)
 */
export type AgyGate = 'ok' | 'busy' | 'waiting' | 'asking' | 'subagent' | 'unsure' | 'idle'

const WORKING = new Set(['working', 'tool_use', 'reviewing'])
const SETTLED = new Set(['idle', 'error'])

/**
 * ★ May text be typed now? (rules 1 and 2 above)
 * - a card is up ⇒ `waiting`; a question is up ⇒ `asking` (typed text would go into its write-in); a turn runs ⇒ `busy`
 * - idle / error ⇒ `ok` only when the status line wrote it at or after the transcript's last write; else `unsure`
 * - anything else (starting, signing in, unknown) ⇒ `unsure`
 */
export function sendGate(
  s: Pick<AgyState, 'agentState' | 'confirmationPending' | 'subagentsActive'>,
  stateMtimeMs: number,
  transcriptMtimeMs: number | undefined,
  asking: boolean,
  /**
   * ★ The relay's screen shows the parent's view with its input box and nothing open (`parentViewShown`): text goes
   *   to the parent's prompt even while subagents run (measured 2026-11-22: the parent answered, the child ran on)
   */
  parentShown = false,
): Exclude<AgyGate, 'idle'> {
  if (s.confirmationPending) return 'waiting'
  if (asking) return 'asking'
  if (s.subagentsActive && !parentShown) return 'subagent'
  if (s.agentState && WORKING.has(s.agentState)) return 'busy'
  if (!s.agentState || !SETTLED.has(s.agentState)) return 'unsure'
  if (transcriptMtimeMs === undefined || stateMtimeMs < transcriptMtimeMs) return 'unsure'
  return 'ok'
}

/**
 * ★ May ESC be sent now? Only while a turn runs and no card is up (ESC on a card declines it: that is the card's own
 * answer, left to the PC / phase 3). Idle ⇒ nothing to stop (or `unsure` when the transcript moved past the status line).
 * ★ Not while a question is up: ESC skips it ("User Skipped") and the turn goes on without the answer (measured
 *   2026-11-21 / docs/AGY.md §11).
 */
export function stopGate(
  s: Pick<AgyState, 'agentState' | 'confirmationPending' | 'subagentsActive'>,
  stateMtimeMs: number,
  transcriptMtimeMs: number | undefined,
  asking: boolean,
  /** ★ As `sendGate`: on the parent's view, ESC interrupts the parent's turn only (the children run on / measured) */
  parentShown = false,
): Exclude<AgyGate, 'busy'> {
  if (s.confirmationPending) return 'waiting'
  if (asking) return 'asking'
  if (s.subagentsActive && !parentShown) return 'subagent'
  if (s.agentState && WORKING.has(s.agentState)) return 'ok'
  const settled = sendGate(s, stateMtimeMs, transcriptMtimeMs, false, parentShown)
  return settled === 'ok' ? 'idle' : 'unsure'
}

export interface AgyTarget {
  conversationId: string
  pid: number
  pane: AgyPane
  /** The status line files' directory (a newer file of the same pid = it moved to another conversation) */
  dir: string
  stateFile: string
  transcript: string
}

export type AgyTargetFailure = 'not-open' | 'shared' | AgyPaneFailure

export interface AgyKeysDeps extends AgyDeps {
  /** ⚠️ Right before typing: the uncached liveness (codex round 13 / same as Claude's `findPane`) */
  aliveProcStart: (pid: number) => string | null | undefined
  /** ★ Reads the state as of now (each gate). Replaced in tests to change it between the checks */
  readNow?: typeof readNow
  /** How long a card answer waits before its last check (`AGY_ANSWER_SETTLE_MS`; tests shorten it) */
  answerSettleMs?: number
  /** Between two keys of a question's answer (`AGY_QUESTION_STEP_MS`; tests shorten it) */
  questionStepMs?: number
  /** After ctrl+k opens a child's question (`AGY_CHILD_OPEN_MS`; tests shorten it) */
  childOpenMs?: number
  /** How long the back ESC waits for the answer to be recorded (`AGY_CHILD_BACK_WAIT_MS`; tests shorten it) */
  childBackWaitMs?: number
  /** ★ Reads the agy's screen through its relay (`readAgyScreen`; replaced in tests) */
  readScreen?: (socketPath: string) => Promise<string | undefined>
  /** ★ Opens the key line (`openKeyLine`; replaced in tests) */
  openKeyLine?: (socketPath: string) => Promise<KeyLine | undefined>
  /** How long a screen change is waited for after a key (`SCREEN_SETTLE_MS`; tests shorten it) */
  screenSettleMs?: number
  /** (tests) `AGY_COMPACT_DEADLINE_MS` */
  compactDeadlineMs?: number
  /** (tests) `AGY_STOP_CONFIRM_MS` */
  stopConfirmMs?: number
  /** (tests) `AGY_CLEAR_DEADLINE_MS` */
  clearDeadlineMs?: number
}

export function defaultAgyKeysDeps(): AgyKeysDeps {
  return { ...defaultAgyDeps(), aliveProcStart: aliveProcStartFreshSync }
}

/** ★ The agy showing this conversation now, and its way in. ⚠️ Only the conversation its pid wrote last (`liveAgy`) */
export async function findAgyTarget(conversationId: string, deps: AgyKeysDeps): Promise<AgyTarget | AgyTargetFailure> {
  // ★ The same view as the list (`agyConversations`): the showing agy's own state; two agys on it ⇒ refused
  const c = (await agyConversations(deps)).get(conversationId)
  if (!c) return 'not-open'
  if (c.contested) return 'shared'
  const f = c.file
  // ★★ Only the agy that holds the conversation's lock (agy's own word that it shows it): a sole claimant can still be a
  //    second agy, the lock holder not having written its own file yet (idle since an update / codex review)
  if (!(deps.locksOf ?? ((p: number) => agyLocksOf(p, deps.home)))(f.state.pid)?.includes(conversationId)) return 'shared'
  const pane = await agyPaneOf(f.state.pid, deps.aliveProcStart)
  if (typeof pane === 'string') return pane
  // ⚠️ Written before this agy's relay registered ⇒ an earlier process with the same pid (codex review)
  if (f.mtimeMs < pane.startedAt) return 'not-open'
  return {
    conversationId,
    pid: f.state.pid,
    pane,
    dir: deps.dir,
    // ★ Read again from the file it was found in (codex review: choosing again after the fact fell back to a stale
    //   conversation file when the agy had just moved; its own file then names the new conversation ⇒ refused)
    stateFile: c.source === 'own' ? join(deps.dir, `pid-${f.state.pid}.json`) : join(deps.dir, `session-${conversationId}.json`),
    transcript: transcriptPathOf(conversationId, deps.home),
  }
}

/**
 * ★ The state as of now, read again (before the body, before Enter, before ESC). ⚠️ Synchronous: it runs inside the
 * socket's connect / timer callbacks. Anything unreadable, or a file now naming another pid ⇒ undefined (= refuse).
 */
export function readNow(target: Pick<AgyTarget, 'conversationId' | 'pid' | 'pane' | 'dir' | 'stateFile' | 'transcript'>):
  | { state: AgyState; stateMtimeMs: number; transcriptMtimeMs: number | undefined; asking: boolean }
  | undefined {
  try {
    const stateMtimeMs = statSync(target.stateFile).mtimeMs
    const state = parseAgyFile(JSON.parse(readFileSync(target.stateFile, 'utf8')), target.conversationId)
    if (!state || state.pid !== target.pid || stateMtimeMs < target.pane.startedAt) return undefined
    // ⚠️ The same agy wrote another conversation's file since ⇒ it moved there (a resume on the PC / codex review)
    for (const name of readdirSync(target.dir)) {
      const m = /^session-([0-9a-fA-F-]{36})\.json$/.exec(name)
      if (!m || m[1]!.toLowerCase() === target.conversationId) continue
      const other = join(target.dir, name)
      const mtime = statSync(other, { throwIfNoEntry: false })?.mtimeMs
      if (mtime === undefined || mtime <= stateMtimeMs) continue
      let pid: unknown
      try {
        pid = (JSON.parse(readFileSync(other, 'utf8')) as { nyanPid?: unknown }).nyanPid
      } catch {
        return undefined // being rewritten: cannot tell
      }
      if (pid === target.pid) return undefined
    }
    let transcriptMtimeMs: number | undefined
    try {
      transcriptMtimeMs = statSync(target.transcript).mtimeMs
    } catch {
      transcriptMtimeMs = undefined
    }
    // ★ For ESC, a question already in the transcript counts before the status line says so (`agyQuestionInTranscript`)
    let asking = agyAsking(state, stateMtimeMs, target.transcript)
    if (!asking && !state.confirmationPending && state.agentState !== undefined && WORKING.has(state.agentState)) {
      const q = agyQuestionInTranscript(target.transcript)
      // ⚠️ A transcript that cannot be read while a turn runs: cannot tell whether a question is up ⇒ refused
      //    (an ESC would skip one / codex review)
      if (q === undefined) return undefined
      asking = q
    }
    return { state, stateMtimeMs, transcriptMtimeMs, asking }
  } catch {
    return undefined
  }
}

/** ★ The lock check of each gate (`findAgyTarget`): a `/resume` picked on the PC moves the lock before the status line
 *   writes (codex review). First, so the files are read last. */
type LockCheck = (pid: number, conversationId: string) => boolean

const sendNow = (target: AgyTarget, read: typeof readNow, holds: LockCheck, parentShown = false): Exclude<AgyGate, 'idle'> => {
  if (!holds(target.pid, target.conversationId)) return 'unsure'
  const now = read(target)
  return now ? sendGate(now.state, now.stateMtimeMs, now.transcriptMtimeMs, now.asking, parentShown) : 'unsure'
}

const stopNow = (target: AgyTarget, read: typeof readNow, holds: LockCheck, parentShown = false): Exclude<AgyGate, 'busy'> => {
  if (!holds(target.pid, target.conversationId)) return 'unsure'
  const now = read(target)
  return now ? stopGate(now.state, now.stateMtimeMs, now.transcriptMtimeMs, now.asking, parentShown) : 'unsure'
}

/**
 * ★ A send would not land as a plain prompt: the input box not readable as one row (a draft wrapped onto more rows,
 * the slash list pushing it off a short pane, something open over it — codex / agy review), or holding a draft that
 * starts like a command (`/`, `!`, `?`, also behind invisible characters): the text would be joined to it and run.
 */
export function unsafeDraft(screen: string | undefined): boolean {
  if (screen === undefined) return true
  const box = inputRowOf(screen)
  if (box === undefined) return true
  return /^[/!?]/.test(visibleHead(box))
}

/**
 * ★★ Whether the relay's screen shows the parent's view ready for a send or a stop while subagents run (docs/AGY.md
 * §15): no subagent header, not a subagent's view, no dialog open, its input box on the screen. ⚠️ A subagent's
 * question or approval opens only with ctrl+k (on its view): a send there would go into it, so that is refused.
 */
async function parentViewShown(target: AgyTarget, deps: AgyKeysDeps): Promise<boolean> {
  if (!target.pane.screen) return false
  const s = await (deps.readScreen ?? ((p: string) => readAgyScreen(p)))(target.pane.socketPath)
  if (s === undefined || s.trim() === '') return false
  return viewOwnerOf(s) === 'parent' && !inChildView(s) && parseDialog(s) === undefined && inputRowOf(s) !== undefined
}

/** (no lock probe: for a check whose key only leaves a subagent's view) */
const noProbe: LockCheck = () => true

const lockCheck = (deps: AgyKeysDeps): LockCheck => {
  const locksOf = deps.locksOf ?? ((p: number) => agyLocksOf(p, deps.home))
  return (pid, conv) => locksOf(pid)?.includes(conv) ?? false
}

/** ★ One key per conversation however the id is spelled (codex review: case variants made separate chains) */
const keyOf = (conversationId: string): string => AGY_PREFIX + conversationId.toLowerCase()

/** ★ Rule 3: the first visible character is `?` (the shortcuts panel on an empty prompt) */
export function looksLikeAgyShortcut(text: string): boolean {
  return visibleHead(text).startsWith('?')
}

/** ★ Rule 4: the text as typed (one space after it, unless it already ends in white space) */
export function agyTyped(text: string): string {
  return /\s$/.test(text) ? text : `${text} `
}

export type AgySendFailure =
  | AgyTargetFailure
  | 'busy'
  | 'waiting'
  | 'asking'
  | 'subagent'
  | 'unsure'
  | 'shortcut-like'
  | 'command-like'
  | 'empty'
  | 'too-long'
  | 'long-needs-paste'
  | 'unreachable'
  | 'partial'
  | 'answering'
  | 'child-view'
  | 'no-screen'
  | 'draft'
  | 'too-soon'

export type AgyStopFailure = AgyTargetFailure | 'waiting' | 'asking' | 'subagent' | 'unsure' | 'idle' | 'too-soon' | 'unreachable' | 'answering' | 'child-view' | 'not-stopped'

export interface AgyResult<F> {
  ok: boolean
  reason?: F
  message?: string
  dropped?: number
  /**
   * ★ On success: the text as agy records it (control characters dropped, CR as LF, trimmed both ends like
   *   `userRequestText`). The phone matches its "sending" line against this (codex review: agy drops leading spaces,
   *   so a send starting with a space never cleared).
   */
  recorded?: string
}

/** ★ What the phone is told (and the HTTP status), by reason. Records so a new reason fails the type check */
export const AGY_SEND_REFUSAL: Record<AgySendFailure, () => [number, string]> = {
  'not-open': () => [409, t('この agy の会話は、いま開かれていません。', 'This agy conversation is not open right now.')],
  shared: () => [
    409,
    t(
      'この会話は2つの agy で開かれています。どちらに届くか決められないので、スマホからは送れません（PC で操作してください）。',
      'This conversation is open in two agys. Which one would get it cannot be told, so it cannot be sent from the phone (use the PC).',
    ),
  ],
  'no-relay': () => [
    409,
    t(
      'この agy は nyan-remote を通さずに起動しています。新しいターミナルで agy を起こし直すと、スマホから送れます。',
      'This agy was not started through nyan-remote. Start agy again in a new terminal to send to it from the phone.',
    ),
  ],
  broken: () => [409, t('この agy への入口の記録が壊れています。agy を起こし直してください。', 'The record of the way into this agy is broken. Start agy again.')],
  unverified: () => [409, t('この agy を確かめられませんでした（送っていません）。少し待ってから送り直してください。', 'Could not verify this agy (nothing was sent). Wait a moment and send again.')],
  busy: () => [
    409,
    t('agy が応答中です。終わってから送るか、止めてから送ってください。', 'agy is working. Send when it has finished, or stop it first.'),
  ],
  waiting: () => [409, t('agy が承認を待っています。PC で答えてください。', 'agy is waiting for an approval. Please answer on the PC.')],
  asking: () => [
    409,
    t('agy が質問しています。PC で答えてください（スマホからはまだ答えられません）。', 'agy is asking a question. Please answer it on the PC (it can’t be answered from the phone yet).'),
  ],
  subagent: () => [
    409,
    t(
      'agy の子（サブエージェント）が動いていて、PC の画面が親の入力欄を出していないため送れません（子の質問を開いている・古い中継など）。PC で親の画面に戻すか、子が終わってから送ってください。',
      'An agy subagent is running and the PC does not show the main input box (a subagent’s question is open, or an older relay), so it cannot be sent. Go back to the main screen on the PC, or send when the subagent has finished.',
    ),
  ],
  unsure: () => [
    409,
    t('agy の状態を確かめられませんでした（送っていません）。少し待ってから送り直してください。', 'Could not tell what agy is doing (nothing was sent). Wait a moment and send again.'),
  ],
  'shortcut-like': () => [
    400,
    t(
      '`?` で始まる文は agy に送れません（PC でショートカットの一覧が開くため）。前に語を足してください。',
      'Messages starting with `?` cannot be sent to agy (it opens the shortcuts list on the PC). Add a word in front.',
    ),
  ],
  'command-like': () => [400, commandLikeMessage()],
  empty: () => [400, failureMessage('empty')],
  'too-long': () => [400, failureMessage('too-long')],
  'long-needs-paste': () => [
    409,
    t(
      `${MAX_MESSAGE_BYTES} バイトを超える文は、この agy にはまだ送れません。PC で agy を起こし直すと送れます。`,
      `Texts over ${MAX_MESSAGE_BYTES} bytes cannot be sent to this agy yet. Start agy again on the PC to send them.`,
    ),
  ],
  unreachable: () => [502, t('agy への入口が応答しません（送っていません）。', 'The way into agy is not responding (nothing was sent).')],
  partial: () => [500, failureMessage('partial')],
  answering: () => [
    409,
    t('スマホからの答えを agy に打っているところです。終わってから送り直してください。', 'An answer from the phone is being typed into agy. Send again when it is done.'),
  ],
  'no-screen': () => [
    409,
    t(
      'この agy は古い中継で動いているため、スマホからは圧縮できません。新しいターミナルで agy を起こし直すと使えます。',
      'This agy runs through an older relay, so it cannot be compacted from the phone. Start agy again in a new terminal to use it.',
    ),
  ],
  draft: () => [
    409,
    t(
      'PC の agy の入力欄に打ちかけの文があるか、入力欄が見えない状態です（つながって送られ、コマンドとして走るおそれがあるので、何もしていません）。PC で消すか閉じてから、もう一度してください。',
      'The agy input box on the PC holds unsent text or is not on the screen (this would be joined to it and could run as a command, so nothing was done). Clear or close it on the PC, then try again.',
    ),
  ],
  'too-soon': () => [429, t('圧縮の合図を送ったところです。', 'A compact was just sent.')],
  'child-view': () => [
    409,
    t(
      'PC が agy の子（サブエージェント）の画面を開いたままで、親の画面に戻せませんでした（送っていません）。PC で ESC を押して戻ってください。',
      'The PC shows an agy subagent’s screen and it could not be taken back to the main one (nothing was sent). Press ESC on the PC to go back.',
    ),
  ],
}

export const AGY_STOP_REFUSAL: Record<AgyStopFailure, () => [number, string]> = {
  'not-open': AGY_SEND_REFUSAL['not-open'],
  shared: () => [
    409,
    t('この会話は2つの agy で開かれています。スマホからは止められません（PC で操作してください）。', 'This conversation is open in two agys. It cannot be stopped from the phone (use the PC).'),
  ],
  'no-relay': () => [
    409,
    t(
      'この agy は nyan-remote を通さずに起動しています。新しいターミナルで agy を起こし直すと、スマホから止められます。',
      'This agy was not started through nyan-remote. Start agy again in a new terminal to stop it from the phone.',
    ),
  ],
  broken: AGY_SEND_REFUSAL.broken,
  unverified: () => [409, t('この agy を確かめられませんでした。少し待ってからもう一度押してください。', 'Could not verify this agy. Wait a moment and press it again.')],
  waiting: () => [
    409,
    t('agy が承認を待っています。PC で答えてください（止めるとその承認を断ることになります）。', 'agy is waiting for an approval. Please answer on the PC (stopping would decline it).'),
  ],
  asking: () => [
    409,
    t('agy が質問しています。PC で答えてください（止めるとその質問を飛ばして先に進みます）。', 'agy is asking a question. Please answer it on the PC (stopping would skip it and go on).'),
  ],
  subagent: () => [
    409,
    t(
      'agy の子（サブエージェント）が動いていて、PC の画面が親の画面になっていないため止められません（子の質問を開いている・古い中継など）。PC で操作してください。',
      'An agy subagent is running and the PC does not show the main screen (a subagent’s question is open, or an older relay), so it cannot be stopped from the phone. Use the PC.',
    ),
  ],
  unsure: () => [409, t('agy の状態を確かめられませんでした。少し待ってからもう一度押してください。', 'Could not tell what agy is doing. Wait a moment and press it again.')],
  idle: () => [409, t('agy はいま応答していません（止めるものがありません）。', 'agy is not working right now (nothing to stop).')],
  'too-soon': () => [429, t('止める合図を送ったところです。', 'A stop was just sent.')],
  unreachable: () => [502, t('agy への入口が応答しません。', 'The way into agy is not responding.')],
  answering: () => [409, t('スマホからの答えを agy に打っているところです。終わってからもう一度押してください。', 'An answer from the phone is being typed into agy. Press it again when it is done.')],
  'not-stopped': () => [
    409,
    t(
      '止める合図を送りましたが、agy はまだ応答中です（PC の入力欄で開いていた一覧や候補を閉じるのに使われたのかもしれません）。もう一度押してください。',
      'The stop was sent, but agy is still working (it may have closed a list or suggestions open in the PC’s input box). Press it again.',
    ),
  ],
  'child-view': () => [
    409,
    t(
      'PC が agy の子（サブエージェント）の画面を開いたままで、親の画面に戻せませんでした（止めていません）。PC で操作してください。',
      'The PC shows an agy subagent’s screen and it could not be taken back to the main one (nothing was stopped). Use the PC.',
    ),
  ],
}

const fail = <F extends AgySendFailure>(reason: F): AgyResult<F> => ({ ok: false, reason, message: AGY_SEND_REFUSAL[reason]()[1] })
const failStop = <F extends AgyStopFailure>(reason: F): AgyResult<F> => ({ ok: false, reason, message: AGY_STOP_REFUSAL[reason]()[1] })

/**
 * ★ Conversations an answer from the phone is being typed into: a send or a stop for them is refused at once rather
 * than queued behind it (codex review: a long batch held a stop, and the phone's relay line with it, past the 10 s
 * another request waits)
 */
const answering = new Map<string, number>()
async function whileAnswering<T>(key: string, fn: () => Promise<T>): Promise<T> {
  answering.set(key, (answering.get(key) ?? 0) + 1)
  try {
    return await fn()
  } finally {
    const n = (answering.get(key) ?? 1) - 1
    if (n <= 0) answering.delete(key)
    else answering.set(key, n)
  }
}

/**
 * ★★ Takes the PC back to the parent's view before a send or a stop (codex review: a message typed while an earlier
 * answer left a subagent's view on the PC went into that view, while the phone was told it was sent). Only through a
 * relay that shows the screen; the same conditions as an answer's going back (`answerOnScreen`): the view's child named
 * by its header, nothing open in it, nothing pending in its transcript; `may` (the send's or stop's own gate) right
 * before the key. 'ok' = on the parent's view (or nothing to read the screen with).
 */
async function leaveChildView(target: AgyTarget, deps: AgyKeysDeps, may: () => boolean): Promise<'ok' | 'child-view' | 'unsure'> {
  if (!target.pane.screen) return 'ok'
  const look = deps.readScreen ?? ((p: string) => readAgyScreen(p))
  const s = await look(target.pane.socketPath)
  if (s === undefined || s.trim() === '') return 'unsure'
  // ⚠️ "Not a child's view" only when the header says so too: a child's header with its footer clipped (a resize
  //    mid-redraw) is a child's view (codex / agy review)
  if (!inChildView(s)) return viewOwnerOf(s) === 'parent' ? 'ok' : 'child-view'
  const viewed = childViewOf(s)
  if (viewed === undefined || parseDialog(s) !== undefined) return 'child-view'
  const viewedT = transcriptPathOf(viewed, homeOf(target.transcript, target.conversationId) ?? deps.home)
  const pending = (): boolean => agyPendingCall(viewedT, readTailRecords) !== null
  if (pending()) return 'child-view'
  const res = await writeControl(target.pane.socketPath, SCREEN_KEYS.esc, { beforeWrite: () => !may() || pending() })
  if (!res.ok) return 'child-view'
  const end = Date.now() + (deps.screenSettleMs ?? SCREEN_SETTLE_MS)
  for (;;) {
    const x = await look(target.pane.socketPath)
    if (x !== undefined && x.trim() !== '' && !inChildView(x) && viewOwnerOf(x) === 'parent') return 'ok'
    if (Date.now() >= end) return 'child-view'
    await new Promise((r) => setTimeout(r, SCREEN_POLL_MS))
  }
}

/** ★ Type one message into the agy showing this conversation. ⚠️ Serialized with its stops (same chain key as the row id) */
export async function sendToAgy(
  conversationId: string,
  text: unknown,
  deps: AgyKeysDeps = defaultAgyKeysDeps(),
  /**
   * ★ Asked with the target found, inside the queue, and again right before the body and before Enter: false ⇒ nothing
   *   (more) typed, 'unsure'. A team's send passes "still the member's own agy, still this team" (docs/TEAM.md §9 /
   *   codex · agy review: a send queued behind another operation typed into a second agy that had opened it meanwhile).
   */
  stillWanted?: (target: Pick<AgyTarget, 'pid'>) => boolean,
): Promise<AgyResult<AgySendFailure>> {
  const key = keyOf(conversationId)
  const read = deps.readNow ?? readNow
  const holds = lockCheck(deps)
  if (answering.has(key)) return fail('answering')
  return serializeBySession(key, async () => {
    const clean = sanitizeForKeys(text)
    if (!clean.ok) {
      const r = clean.reason
      return fail(r === 'command-like' || r === 'empty' || r === 'too-long' ? r : 'empty')
    }
    if (looksLikeAgyShortcut(clean.value.text)) return fail('shortcut-like')
    const target = await findAgyTarget(conversationId, deps)
    if (typeof target === 'string') return fail(target)
    if (stillWanted && !stillWanted(target)) return fail('unsure')
    if (typedTooLong(clean.value.text)) return fail('too-long')
    // ★ Subagents running: allowed through a relay that shows the screen, once it shows the parent's view (below)
    //   (whether they run is read from the state file: no extra lock probe)
    const first = read(target)
    const withKids = first?.state.subagentsActive === true
    const gate = sendNow(target, () => first, holds, withKids)
    if (gate !== 'ok') return fail(gate)
    const typed = agyTyped(clean.value.text)
    const long = needsPaste(typed)
    if (long && !target.pane.paste) return fail('long-needs-paste')
    // (the state only, not the lock probe again: an ESC on a subagent's view only goes back, and a Mac's `lsof` per
    //  check added up past the phone's 10 s / codex review)
    // ⚠️ `stillWanted` (slow on a Mac) first, the state last, right before the ESC (agy review)
    const left = await leaveChildView(target, deps, () => (stillWanted?.(target) ?? true) && sendNow(target, read, noProbe, withKids) === 'ok')
    if (left !== 'ok') return fail(left)
    // ★ The slow lock probe first (without blocking), then the screen, then only quick checks right before each key: a
    //   card the parent opens meanwhile shows on the screen, which is read after the probe (codex review)
    const probe = withKids ? await probedChecks(deps, readTailRecords, target.pid) : undefined
    if (withKids && !(await parentViewShown(target, deps))) return fail('subagent')
    // ⚠️ A draft left in the box that starts like a command ("/", "!", "?"): the text would be joined to it and run as
    //    that command — "/" + "exit the tests" closes agy (codex review). Read on a relay that shows the screen.
    if (target.pane.screen && unsafeDraft(await (deps.readScreen ?? ((p: string) => readAgyScreen(p)))(target.pane.socketPath))) return fail('draft')
    const keyHolds: LockCheck = probe ? probe.holdsLock : holds
    // ★ Looked at again right before the body and right before Enter (a card, a turn the PC started)
    let refusedBy: Exclude<AgyGate, 'idle' | 'ok'> | undefined
    const stopHere = (): boolean => {
      if (stillWanted && !stillWanted(target)) {
        refusedBy = 'unsure'
        return true
      }
      const g = sendNow(target, read, keyHolds, withKids)
      if (g === 'ok') return false
      refusedBy = g
      return true
    }
    const res = await writeKeys(target.pane.socketPath, long ? pasteRequest(typed) : typed, {
      beforeWrite: stopHere,
      beforeSubmit: stopHere,
      pasteAck: long,
    })
    await noteSent(key, clean.value.text.length, clean.value.dropped, res.ok ? undefined : res.reason)
    if (res.ok) return { ok: true, dropped: clean.value.dropped, recorded: clean.value.text.trim() }
    // `writeKeys` calls a refusal before the body `pending-approval`: it is the state we read
    if (res.reason === 'pending-approval') return fail(refusedBy ?? 'unsure')
    if (res.reason === 'partial' || res.reason === 'unreachable' || res.reason === 'long-needs-paste') return fail(res.reason)
    return fail('unreachable')
  })
}

/**
 * ★★ agy's `/compact` from the phone (docs/AGY.md §12): the table command run through its own endpoint
 * (`/sessions/:id/command`), never from free text (a `/` start is refused there). Measured on 1.5.13 / 1.5.14: typing
 * `/compact` in the empty input box shows "> /compact  Compact the conversation now (…)" picked with "enter Select";
 * Enter runs it (no dialog); the transcript gets `USER_INPUT` "/compact" and a `CHECKPOINT` with the summary.
 * Only through a relay that shows the screen, and only on what it shows:
 *  - the same gate as a send (idle, no card, no question, no subagent), the PC taken back from a subagent's view;
 *  - ⚠️ the input box empty (a draft there would be sent with it as a prompt: "abc/compact");
 *  - Enter only once the box reads "/compact" and the list shows it picked (else stopped, "/compact" left in the box).
 */
export const AGY_COMPACT = { command: '/compact', about: 'Compact the conversation' } as const
/** Ctrl-U: clears agy's input box (and closes the slash list / measured 1.5.14) */
const AGY_COMPACT_CLEAR = '\x15'
export const AGY_COMPACT_COOLDOWN_MS = 3000
/** ★ No Enter after this long from the request (the phone gives a request 10 s: past it, it was told it failed / codex review) */
export const AGY_COMPACT_DEADLINE_MS = 8000
const lastCompactAt = new Map<string, number>()

export async function compactAgy(
  conversationId: string,
  deps: AgyKeysDeps = defaultAgyKeysDeps(),
  now: () => number = Date.now,
): Promise<AgyResult<AgySendFailure>> {
  const key = keyOf(conversationId)
  const read = deps.readNow ?? readNow
  const holds = lockCheck(deps)
  if (answering.has(key)) return fail('answering')
  const deadline = Date.now() + (deps.compactDeadlineMs ?? AGY_COMPACT_DEADLINE_MS)
  return serializeBySession(key, async () => {
    // ⚠️ Waited past its deadline behind another operation: the phone has been answered, nothing is done (codex review)
    if (Date.now() >= deadline) return fail('unsure')
    const prev = lastCompactAt.get(key)
    if (prev !== undefined && now() - prev < AGY_COMPACT_COOLDOWN_MS) return fail('too-soon')
    const target = await findAgyTarget(conversationId, deps)
    if (typeof target === 'string') return fail(target)
    if (!target.pane.screen) return fail('no-screen')
    const gate = sendNow(target, read, holds)
    if (gate !== 'ok') return fail(gate)
    const left = await leaveChildView(target, deps, () => Date.now() < deadline && sendNow(target, read, noProbe) === 'ok')
    if (left !== 'ok') return fail(left)
    const look = deps.readScreen ?? ((p: string) => readAgyScreen(p))
    const first = await look(target.pane.socketPath)
    if (first === undefined || first.trim() === '') return fail('unsure')
    const box = inputRowOf(first)
    if (box === undefined) return fail('unsure')
    if (box !== '') return fail('draft')
    const line = await (deps.openKeyLine ?? openKeyLine)(target.pane.socketPath)
    if (!line) return fail('unreachable')
    try {
      // ★ The lock probes made once, just before the first key, without blocking the agent (`probedChecks`): the Enter
      //   follows within moments, and a second probe per key (a Mac's lsof, ~2 s) used up the deadline (codex review).
      //   The state is read right before each key as with any send.
      const c = await probedChecks(deps, readTailRecords, target.pid)
      const refuse = (): boolean => sendNow(target, read, c.holdsLock) !== 'ok'
      const before = refuse
      if (Date.now() >= deadline) return fail('unsure')
      if (!(await line.write(AGY_COMPACT.command, before))) return fail('unsure')
      // ★ Stopped after typing: "/compact" is taken out of the box again (the box was empty before), so the next
      //   message from the phone is not added to it (codex review). Ctrl-U clears the box and closes the list
      //   (measured 1.5.14). ★ The box was seen empty before "/compact" was typed, so whatever is in it now is that
      //   (or someone typing on the PC at this very moment — accepted): the Ctrl-U is sent unless the box is seen
      //   holding something else. Also when it reads empty (agy stalled before taking the keys: the Ctrl-U goes after
      //   them) or cannot be read (a short pane pushed it off with the list) — every such case left "/compact" to be
      //   joined with the next message (codex review, three rounds).
      const takeBack = async (): Promise<AgyResult<AgySendFailure>> => {
        const s = await look(target.pane.socketPath)
        const box = s === undefined ? undefined : inputRowOf(s)
        if (box !== undefined && box !== AGY_COMPACT.command && box !== '') return fail('partial')
        if (!(await line.write(AGY_COMPACT_CLEAR))) return fail('partial')
        const end = Date.now() + (deps.screenSettleMs ?? SCREEN_SETTLE_MS)
        for (;;) {
          const x = await look(target.pane.socketPath)
          if (x !== undefined && inputRowOf(x) === '') return fail('unsure')
          if (Date.now() >= end) return fail('partial')
          await new Promise((r) => setTimeout(r, SCREEN_POLL_MS))
        }
      }
      const end = Date.now() + (deps.screenSettleMs ?? SCREEN_SETTLE_MS)
      for (;;) {
        const s = await look(target.pane.socketPath)
        if (s !== undefined && inputRowOf(s) === AGY_COMPACT.command && slashPicked(s, AGY_COMPACT.command, AGY_COMPACT.about)) break
        if (Date.now() >= end) return await takeBack()
        await new Promise((r) => setTimeout(r, SCREEN_POLL_MS))
      }
      const enter = refuse
      if (Date.now() >= deadline) return await takeBack()
      if (!(await line.write('\r', enter))) return await takeBack()
      lastCompactAt.set(key, now())
      for (const [id, at] of lastCompactAt) if (now() - at >= AGY_COMPACT_COOLDOWN_MS && id !== key) lastCompactAt.delete(id)
      return { ok: true }
    } finally {
      line.close()
    }
  })
}

/** ★ Do not send ESC twice within this (a double tap / two phones); remembered only when it was sent */
export const AGY_STOP_COOLDOWN_MS = 1500
/** ★ How long a stop waits for agy's state to leave "working" (measured ~85 ms after the ESC, 1.5.14) */
export const AGY_STOP_CONFIRM_MS = 1500
const lastStopAt = new Map<string, number>()

/** ★ Stop the turn the agy showing this conversation runs (one ESC) */
export async function stopAgy(
  conversationId: string,
  deps: AgyKeysDeps = defaultAgyKeysDeps(),
  now: () => number = Date.now,
): Promise<AgyResult<AgyStopFailure>> {
  const key = keyOf(conversationId)
  const read = deps.readNow ?? readNow
  const holds = lockCheck(deps)
  if (answering.has(key)) return failStop('answering')
  return serializeBySession(key, async () => {
    const prev = lastStopAt.get(key)
    if (prev !== undefined && now() - prev < AGY_STOP_COOLDOWN_MS) return failStop('too-soon')
    const target = await findAgyTarget(conversationId, deps)
    if (typeof target === 'string') return failStop(target)
    // ★ Subagents running: allowed once the screen shows the parent's view (ESC there stops the parent's turn only)
    const first = read(target)
    const withKids = first?.state.subagentsActive === true
    const gate = stopNow(target, () => first, holds, withKids)
    if (gate !== 'ok') return failStop(gate)
    // (an ESC on a subagent's view only goes back: the stop would not stop anything)
    const left = await leaveChildView(target, deps, () => stopNow(target, read, noProbe, withKids) === 'ok')
    if (left !== 'ok') return failStop(left)
    // ★ As a send: the lock probe first, then the screen, then quick checks right before the ESC (a parent's approval
    //   opened during a slow probe would be declined by it / codex review)
    const probe = withKids ? await probedChecks(deps, readTailRecords, target.pid) : undefined
    if (withKids && !(await parentViewShown(target, deps))) return failStop('subagent')
    const keyHolds: LockCheck = probe ? probe.holdsLock : holds
    let refusedBy: Exclude<AgyGate, 'busy' | 'ok'> | undefined
    const res = await writeControl(target.pane.socketPath, CONTROL_KEYS.escape, {
      beforeWrite: () => {
        const g = stopNow(target, read, keyHolds, withKids)
        if (g === 'ok') return false
        refusedBy = g
        return true
      },
    })
    await noteControl(key, 'escape', res.ok ? undefined : res.reason)
    if (!res.ok) return failStop(res.reason === 'pending-approval' ? (refusedBy ?? 'unsure') : 'unreachable')
    lastStopAt.set(key, now())
    // ★ Told as stopped only once agy's state leaves "working" (measured ~85 ms): an ESC something open in the PC's box
    //   took instead (the slash list, `@` suggestions …) leaves the turn running — said so, never a second ESC (what it
    //   would do on the PC is not known / codex review, user decision)
    const end = Date.now() + (deps.stopConfirmMs ?? AGY_STOP_CONFIRM_MS)
    for (;;) {
      // ⚠️ Only a state read and not working confirms it (an unreadable one does not / codex review)
      const s = read(target)?.state.agentState
      if (s !== undefined && !WORKING.has(s)) break
      if (Date.now() >= end) return failStop('not-stopped')
      await new Promise((r) => setTimeout(r, 50))
    }
    for (const [id, at] of lastStopAt) if (now() - at >= AGY_STOP_COOLDOWN_MS && id !== key) lastStopAt.delete(id)
    return { ok: true }
  })
}

/**
 * ★★ Clear the PC's input box of an agy from the phone (2026-11-22 / docs/AGY.md §16). Measured on 1.5.14 (tmux):
 *  - Ctrl-U deletes from the cursor to the start of its line (only that line of a draft of several lines; what is
 *    after the cursor stays), also while a turn runs (the turn goes on) and closes the slash list;
 *  - ctrl+end ("Go to bottom") puts the cursor at the end of the whole draft; Backspace at the start of a line joins
 *    it to the line above; Ctrl-U and Backspace on an empty box do nothing (idle or working).
 *  ⇒ ctrl+end once, then Ctrl-U + Backspace per row until the screen shows the box empty.
 * Only through a relay that shows the screen, only on the parent's view with its box on the screen (a key in a
 * dialog or a panel would be read as that dialog's key), never while a card or a question is up. Told as cleared only
 * once the screen shows the box empty.
 */
export const AGY_CLEAR_KEYS = { bottom: '\x1b[1;5F', row: '\x15\x7f' } as const
/**
 * ★ No more keys after this long from the request, and the last check (a lock probe: a Mac's lsof takes ~2 s) ends by
 * `AGY_CLEAR_ANSWER_MS`: the phone gives a request 10 s (agy review)
 */
export const AGY_CLEAR_DEADLINE_MS = 6000
export const AGY_CLEAR_ANSWER_MS = 9000
/** At most this many rounds (a round clears the rows the screen shows) */
const AGY_CLEAR_ROUNDS = 12

export type AgyClearFailure = AgyTargetFailure | 'waiting' | 'asking' | 'subagent' | 'unsure' | 'unreachable' | 'answering' | 'child-view' | 'no-screen' | 'no-box' | 'not-cleared'

export const AGY_CLEAR_REFUSAL: Record<AgyClearFailure, () => [number, string]> = {
  'not-open': AGY_SEND_REFUSAL['not-open'],
  shared: () => [
    409,
    t('この会話は2つの agy で開かれています。スマホからは入力欄を消せません（PC で操作してください）。', 'This conversation is open in two agys. Its input box cannot be cleared from the phone (use the PC).'),
  ],
  'no-relay': () => [
    409,
    t(
      'この agy は nyan-remote を通さずに起動しています。新しいターミナルで agy を起こし直すと、スマホから入力欄を消せます。',
      'This agy was not started through nyan-remote. Start agy again in a new terminal to clear its input box from the phone.',
    ),
  ],
  broken: AGY_SEND_REFUSAL.broken,
  unverified: AGY_STOP_REFUSAL.unverified,
  waiting: () => [409, t('agy が承認を待っています。PC で答えてください（消すキーがカードに入ってしまうため）。', 'agy is waiting for an approval. Please answer on the PC (the keys would go into the card).')],
  asking: () => [409, t('agy が質問しています。先に答えてください（消すキーが質問に入ってしまうため）。', 'agy is asking a question. Answer it first (the keys would go into the question).')],
  subagent: () => [
    409,
    t(
      'agy の子（サブエージェント）が動いていて、PC の画面が親の画面になっていないため消せません。PC で操作してください。',
      'An agy subagent is running and the PC does not show the main screen, so the input box cannot be cleared. Use the PC.',
    ),
  ],
  unsure: AGY_STOP_REFUSAL.unsure,
  unreachable: AGY_STOP_REFUSAL.unreachable,
  answering: AGY_STOP_REFUSAL.answering,
  'child-view': () => [
    409,
    t(
      'PC が agy の子（サブエージェント）の画面を開いたままで、親の画面に戻せませんでした（何も消していません）。PC で ESC を押して戻ってください。',
      'The PC shows an agy subagent’s screen and it could not be taken back to the main one (nothing was cleared). Press ESC on the PC to go back.',
    ),
  ],
  'no-screen': () => [
    409,
    t(
      'この agy は古い中継で動いているため、スマホからは入力欄を消せません。新しいターミナルで agy を起こし直すと使えます。',
      'This agy runs through an older relay, so its input box cannot be cleared from the phone. Start agy again in a new terminal to use it.',
    ),
  ],
  'no-box': () => [
    409,
    t(
      'PC の agy の画面に入力欄が見えません（一覧や設定の画面が開いている・画面が低すぎる、など）。何も打っていません。PC で閉じてからもう一度押してください。',
      'The agy input box is not on the PC’s screen (a list or a settings screen is open, or the window is too short). Nothing was typed. Close it on the PC and press again.',
    ),
  ],
  'not-cleared': () => [
    409,
    t(
      '消すキーを送りましたが、PC の入力欄が消えたことを確かめられませんでした。PC の画面を見てください。',
      'The keys to clear it were sent, but it could not be confirmed that the PC’s input box is empty. Check the screen on the PC.',
    ),
  ],
}

const failClear = <F extends AgyClearFailure>(reason: F): AgyResult<F> => ({ ok: false, reason, message: AGY_CLEAR_REFUSAL[reason]()[1] })

/** ★ May the box be cleared now? As a send (no card, no question, the parent's view with subagents) but also mid-turn */
const clearNow = (target: AgyTarget, read: typeof readNow, holds: LockCheck, parentShown: boolean): Exclude<AgyGate, 'idle' | 'busy'> => {
  const g = sendNow(target, read, holds, parentShown)
  return g === 'busy' ? 'ok' : g
}

/** ★ This agy's locks, probed now without blocking (only its own pid; an lsof cut at `by`): a lock check from it */
async function ownLockProbe(deps: AgyKeysDeps, target: AgyTarget, by: number): Promise<LockCheck> {
  const locks = deps.locksOf ? deps.locksOf(target.pid) : await agyLocksOfAsync(target.pid, deps.home, by - Date.now())
  return (pid, conv) => pid === target.pid && (locks?.includes(conv) ?? false)
}

export async function clearAgy(conversationId: string, deps: AgyKeysDeps = defaultAgyKeysDeps()): Promise<AgyResult<AgyClearFailure>> {
  const key = keyOf(conversationId)
  const read = deps.readNow ?? readNow
  const holds = lockCheck(deps)
  if (answering.has(key)) return failClear('answering')
  const deadline = Date.now() + (deps.clearDeadlineMs ?? AGY_CLEAR_DEADLINE_MS)
  const answerBy = deadline + AGY_CLEAR_ANSWER_MS - AGY_CLEAR_DEADLINE_MS
  return serializeBySession(key, async () => {
    // ⚠️ Waited past its deadline behind another operation: the phone has given up, nothing is done (codex review)
    if (Date.now() >= deadline) return failClear('unsure')
    const target = await findAgyTarget(conversationId, deps)
    if (typeof target === 'string') return failClear(target)
    if (!target.pane.screen) return failClear('no-screen')
    const first = read(target)
    const withKids = first?.state.subagentsActive === true
    // (no lock probe: `findAgyTarget` has just checked it, and it is probed again below without blocking / agy review)
    const gate = clearNow(target, () => first, noProbe, withKids)
    if (gate !== 'ok') return failClear(gate)
    // ⚠️ Back from a subagent's view only while the parent is idle: mid-turn, a person going back on the PC at that very
    //    moment would get the ESC on the parent, where it stops the turn (a send is idle-only anyway / codex review)
    const left = await leaveChildView(target, deps, () => Date.now() < deadline && sendNow(target, read, noProbe, withKids) === 'ok')
    if (left !== 'ok') return failClear(left)
    // ★ The slow lock probe of this agy only, once (without blocking), then the screen, then quick checks per key
    const holdsNow = await ownLockProbe(deps, target, deadline)
    if (Date.now() >= deadline || !holdsNow(target.pid, target.conversationId)) return failClear('unsure')
    const look = deps.readScreen ?? ((p: string) => readAgyScreen(p))
    const boxNow = async (): Promise<string[] | 'off' | undefined> => {
      const s = await look(target.pane.socketPath)
      if (s === undefined || s.trim() === '') return undefined
      // ⚠️ Only the parent's own view with nothing open over it (a key in a dialog is that dialog's key)
      if (viewOwnerOf(s) !== 'parent' || inChildView(s) || parseDialog(s) !== undefined) return 'off'
      // ⚠️ agy 1.5.16: the subagent list has the focus (a key there is the list's / codex · agy review)
      if (listFocused(s)) return 'off'
      return inputBoxOf(s) ?? 'off'
    }
    const empty = (b: string[]): boolean => b.length === 1 && b[0] === ''
    const stillHere = async (): Promise<boolean> => {
      if (Date.now() >= answerBy) return false
      const again = await ownLockProbe(deps, target, answerBy)
      return clearNow(target, read, again, withKids) === 'ok'
    }
    let box = await boxNow()
    if (box === undefined) return failClear('unsure')
    if (box === 'off') return failClear(withKids ? 'subagent' : 'no-box')
    // ★ Already empty: still only while this agy shows this conversation (a `/new` on the PC shows the new one's box)
    if (empty(box)) return (await stillHere()) ? { ok: true } : failClear('unsure')
    if (Date.now() >= deadline) return failClear('unsure')
    const line = await (deps.openKeyLine ?? openKeyLine)(target.pane.socketPath)
    if (!line) return failClear('unreachable')
    try {
      let refusedBy: Exclude<AgyGate, 'idle' | 'busy' | 'ok'> | undefined
      const refuse = (): boolean => {
        if (Date.now() >= deadline) return true
        const g = clearNow(target, read, holdsNow, withKids)
        if (g === 'ok') return false
        refusedBy = g
        return true
      }
      let sent = false
      const stopped = (): AgyResult<AgyClearFailure> => (sent ? failClear('not-cleared') : failClear(refusedBy ?? 'unsure'))
      if (!(await line.write(AGY_CLEAR_KEYS.bottom, refuse))) return stopped()
      sent = true
      let holds = holdsNow
      for (let round = 0; round < AGY_CLEAR_ROUNDS; round++) {
        // ★ Each further round only while this agy still shows this conversation (a `/resume` on the PC between rounds
        //   would put another conversation's box there / codex review)
        //   (the probe is what the check right before the keys looks at: a moved lock refuses them)
        if (round > 0) {
          holds = await ownLockProbe(deps, target, deadline)
          // ⚠️ The screen read again after that probe: a subagent's question opened on the PC meanwhile would take the
          //    keys (codex review)
          const again = await boxNow()
          if (!Array.isArray(again)) return failClear('not-cleared')
          if (empty(again)) return (await stillHere()) ? { ok: true } : failClear('not-cleared')
          box = again
        }
        const check = holds
        const refuseNow = (): boolean => {
          if (Date.now() >= deadline) return true
          return clearNow(target, read, check, withKids) !== 'ok'
        }
        // ★ One Ctrl-U + Backspace per row shown (a row wrapped from a long line only costs a key that does nothing)
        if (!(await line.write(AGY_CLEAR_KEYS.row.repeat(box.length), refuseNow))) return stopped()
        const before = box.join('\n')
        const end = Math.min(deadline, Date.now() + (deps.screenSettleMs ?? SCREEN_SETTLE_MS))
        for (;;) {
          const x = await boxNow()
          if (Array.isArray(x)) {
            // ★ Told as cleared only while this agy still shows this conversation (a probe taken now: a `/new` on the PC
            //   meanwhile moves the lock before the status line says so / codex review)
            if (empty(x)) return (await stillHere()) ? { ok: true } : failClear('not-cleared')
            if (x.join('\n') !== before) {
              box = x
              break
            }
          }
          if (Date.now() >= end) return failClear('not-cleared')
          await new Promise((r) => setTimeout(r, SCREEN_POLL_MS))
        }
      }
      return failClear('not-cleared')
    } finally {
      line.close()
    }
  })
}


/**
 * ★★ The keys that answer an agy approval card (measured on agy 1.5.13, 2026-11-20 / docs/AGY.md §9).
 * - `1` takes option 1 at once ("Yes, run command" / "Yes, allow access"); ⚠️ `y` did nothing on 1.5.13 (it did on
 *   1.5.12), and Enter takes whichever option the cursor is on (someone may have moved it on the PC).
 * - ESC cancels the card ("esc to cancel"): agy declines and stops the turn ("Interrupted"). The option numbers of
 *   "No" differ per card (4 for a command, 3 for a file), so no digit is used for it.
 * ⚠️⚠️ Fixed bytes only: nothing from the phone is typed (same as `CONTROL_KEYS`).
 */
export const AGY_CARD_KEYS: Record<'allow' | 'deny', string> = { allow: '1', deny: CONTROL_KEYS.escape }

/** Which card the phone answered: the agy, the status file's time and the call (`agy/pending.ts`) */
export interface AgyCardMark {
  pid: number
  stateMtimeMs: number
  step: number
  index: number
  /** When the call's response was written (`PendingCall.at`) */
  callAt: number
}

export type AgyCardFailure = AgyTargetFailure | 'changed' | 'unreachable'

/**
 * ★ A card answer waits this long after its first check, then checks again right before the key (codex review).
 * agy writes a state change to the status line file within a few hundred ms (at most one call per 300 ms). If the
 * card was answered on the PC just before the phone's answer, that write lands in this wait and the phone's key is
 * not sent (ESC would otherwise stop a command the PC had just allowed; `1` would sit in the input box).
 */
export const AGY_ANSWER_SETTLE_MS = 500

/** ★ Whether this card is still the one up now (this agy's own file, its lock, the transcript). ⚠️ Synchronous */
export function sameCardNow(
  target: Pick<AgyTarget, 'conversationId' | 'pid' | 'pane' | 'dir' | 'transcript'>,
  mark: AgyCardMark,
  checks: {
    holdsLock: (pid: number, conversationId: string) => boolean
    shared: (conversationId: string, pid: number, since: number) => boolean | undefined
    tail?: (path: string) => Record<string, unknown>[]
  },
): boolean {
  // ⚠️ The slow checks first (`lsof` on a Mac can take a while), the file reads last: the state the key acts on is the
  //    one read right before it (codex review)
  // ★★ agy's own word that this process shows this conversation (`cards.ts` rule 8)
  if (!checks.holdsLock(mark.pid, target.conversationId)) return false
  // ⚠️ Another agy on the same conversation (now, or during this card): the last call could be its (`cards.ts` rule 7)
  // (cannot tell counts as shared here: nothing is typed on a guess)
  if (checks.shared(target.conversationId, mark.pid, mark.callAt) !== false) return false
  const p = turnEnd((checks.tail ?? readTailRecords)(target.transcript)).pending
  if (p === undefined || p.step !== mark.step || p.index !== mark.index || p.at !== mark.callAt) return false
  // ★ The state file last of all (the transcript read can take a moment / codex review)
  const f = readAgyPidFile(target.dir, mark.pid)
  if (!f || f.state.conversationId !== target.conversationId || !f.state.confirmationPending) return false
  // ★ A child agent not finished: its question may be open on the PC and would take the key (docs/AGY.md §11)
  if (f.state.subagentsActive) return false
  if (f.mtimeMs !== mark.stateMtimeMs || f.mtimeMs < target.pane.startedAt) return false
  // ★ `cards.ts` rule 9: the call is not newer than this agy's "card is up" state
  return callBeforeState(p, f.mtimeMs)
}

/**
 * ★★ Answer the card the phone saw: `1` (allow) or ESC (deny), only while that same card is up.
 * ⚠️ Checked after the agy is found, and again right before the byte goes out after `AGY_ANSWER_SETTLE_MS`: a card
 *    answered on the PC meanwhile (the status file was rewritten) or a later card (another call) is never answered. ⚠️ Serialized with sends and
 *    stops (the same chain), so a stop cannot slip between the check and the key.
 */
export async function answerAgyCard(
  conversationId: string,
  mark: AgyCardMark,
  behavior: 'allow' | 'deny',
  deps: AgyKeysDeps = defaultAgyKeysDeps(),
  tail: (path: string) => Record<string, unknown>[] = readTailRecords,
  /**
   * ★ Asked right before the byte (with the card checks): false = no longer wanted, nothing typed (`changed`).
   * Auto-approve passes "still on for this card" (codex review: an "off" or the expiry during the settle wait typed `1`).
   */
  stillWanted?: () => boolean,
): Promise<{ ok: true } | { ok: false; reason: AgyCardFailure }> {
  const conv = conversationId.toLowerCase()
  return whileAnswering(keyOf(conv), () => serializeBySession(keyOf(conv), async () => {
    if (!deps.isAgy(mark.pid)) return { ok: false, reason: 'not-open' }
    // ⚠️ The uncached liveness (a reused pid is the worst place to type)
    const pane = await agyPaneOf(mark.pid, deps.aliveProcStart)
    if (typeof pane === 'string') return { ok: false, reason: pane }
    const target = { conversationId: conv, pid: mark.pid, pane, dir: deps.dir, transcript: transcriptPathOf(conv, deps.home) }
    // ⚠️ The slow probes (a Mac's `lsof`) made without blocking the agent, just before each check (agy review)
    if (!sameCardNow(target, mark, await probedChecks(deps, tail, mark.pid))) return { ok: false, reason: 'changed' }
    await new Promise((r) => setTimeout(r, deps.answerSettleMs ?? AGY_ANSWER_SETTLE_MS))
    // ★ The PC left on a subagent's view: back to the parent's first (there `1` is dropped and ESC only goes back —
    //   the card would be neither allowed nor declined / agy review)
    if (pane.screen) {
      const before = await probedChecks(deps, tail, mark.pid)
      // ⚠️ `stillWanted` (slow on a Mac) first, the card last (codex review, as before the key below)
      const left = await leaveChildView({ ...target, stateFile: '' }, deps, () => (stillWanted === undefined || stillWanted()) && sameCardNow(target, mark, before))
      if (left !== 'ok') return { ok: false, reason: 'changed' }
    }
    const checks = await probedChecks(deps, tail, mark.pid)
    const res = await writeControl(pane.socketPath, AGY_CARD_KEYS[behavior], {
      // ⚠️ The slow lock probes are done above (`checks`). `stillWanted` first — a team's guard probes processes (`ps` on
      //    a Mac) — and the card itself last, right before the byte (codex review: a card answered on the PC during
      //    those probes got the team's queued key)
      // ★ …and once more after it: still wanted when the card check (its own process probes) ends (codex review)
      beforeWrite: () => (stillWanted !== undefined && !stillWanted()) || !sameCardNow(target, mark, checks) || (stillWanted !== undefined && !stillWanted()),
    })
    if (res.ok) return { ok: true }
    return { ok: false, reason: res.reason === 'pending-approval' ? 'changed' : 'unreachable' }
  }))
}

/**
 * ★★ Which question the phone answered (docs/AGY.md §13): the agy, the transcript's write that posed it (nothing writes
 * the transcript while it is up; a subagent's progress can rewrite the status file, so that is not used), the call.
 */
export interface AgyQuestionMark {
  pid: number
  askedAt: number
  step: number
  index: number
  callAt: number
  /**
   * ★ A child agent's question (docs/AGY.md §13): the child's conversation id. `askedAt` / `step` / `index` / `callAt`
   *   are then of the child's transcript; the keys go through the parent's relay, opened with ctrl+k.
   */
  child?: string
  /** ★ Raised from what the relay's screen showed: answered against the screen (docs/AGY.md §14) */
  screen?: true
}

/**
 * ★ The keys around a child's answer (measured on agy 1.5.13): ctrl+k opens the question the parent's banner shows
 * (again: stays open), and after the answer the PC stays in the child's view; ESC there goes back to the parent's.
 * (ESC on the parent's idle prompt does nothing, measured with a child still asking.)
 */
export const AGY_CHILD_KEYS = { open: '\x0b', back: '\x1b' } as const
/** After ctrl+k, before the first answer key: agy switches to the child's view */
export const AGY_CHILD_OPEN_MS = 600
/** How long the back ESC waits for agy to record the child's answer (wall time) */
export const AGY_CHILD_BACK_WAIT_MS = 2000

export type AgyQuestionFailure = AgyCardFailure | 'partial'

/** Between two keys of one answer: agy redraws the next question (a digit on a single-select moves on at once) */
export const AGY_QUESTION_STEP_MS = 250

/** ★ Whether this question is still the one up now. ⚠️ Synchronous (right before each key) */
export function sameQuestionNow(
  target: Pick<AgyTarget, 'conversationId' | 'pid' | 'pane' | 'dir' | 'transcript'>,
  mark: AgyQuestionMark,
  checks: {
    holdsLock: (pid: number, conversationId: string) => boolean
    shared: (conversationId: string, pid: number, since: number) => boolean | undefined
    tail?: (path: string) => Record<string, unknown>[]
  },
  /**
   * ★ Whether to run the slow probes (the lock, another agy on it: `lsof` on a Mac). Between the keys of one answer only
   *   the file reads run (the question the same, this agy's state): a probe per key made a long answer outlast the
   *   phone's 10 s wait on a slow Mac (codex review). Run before the first key and before the last.
   */
  slow = true,
): boolean {
  // the slow checks first, the file reads last (as `sameCardNow`)
  if (slow && !checks.holdsLock(mark.pid, target.conversationId)) return false
  if (slow && checks.shared(target.conversationId, mark.pid, mark.callAt) !== false) return false
  if (mark.child !== undefined) return sameChildQuestionNow(target, mark as AgyQuestionMark & { child: string }, checks)
  let posed: number
  try {
    posed = statSync(target.transcript).mtimeMs
  } catch {
    return false
  }
  // ⚠️ Anything written since (an answer on the PC, a skip) ⇒ not the same question
  if (posed !== mark.askedAt) return false
  const p = turnEnd((checks.tail ?? readTailRecords)(target.transcript)).pending
  if (!p || p.name !== AGY_QUESTION_TOOL || p.step !== mark.step || p.index !== mark.index || p.at !== mark.callAt) return false
  const f = readAgyPidFile(target.dir, mark.pid)
  if (!f || f.state.conversationId !== target.conversationId || f.state.confirmationPending || f.state.agentState !== 'tool_use') return false
  // ★ A child agent's question may be the one open on the PC (§11) — blind; with the screen the dialog shown is checked
  if (f.state.subagentsActive && !mark.screen) return false
  if (f.mtimeMs < target.pane.startedAt || f.mtimeMs < mark.askedAt) return false
  return callBeforeState(p, f.mtimeMs)
}

/**
 * ★★ A child's question still the one ctrl+k opens: the parent idle with no card or question of its own, this child the
 * only one asking (and not one of two given the same prompt), its transcript not written since. ⚠️ Synchronous
 */
function sameChildQuestionNow(
  target: Pick<AgyTarget, 'conversationId' | 'pid' | 'pane' | 'dir' | 'transcript'>,
  mark: AgyQuestionMark & { child: string },
  checks: { tail?: (path: string) => Record<string, unknown>[] },
): boolean {
  const tail = checks.tail ?? readTailRecords
  const f = readAgyPidFile(target.dir, mark.pid)
  if (!f || f.state.conversationId !== target.conversationId || f.state.confirmationPending || f.state.agentState !== 'idle') return false
  if (f.mtimeMs < target.pane.startedAt) return false
  const home = homeOf(target.transcript, target.conversationId)
  if (home === undefined) return false
  const found = agyChildQuestions(f.state, target.conversationId, home, tail)
  const kids = found.asking
  // ★ With the screen, which question ctrl+k opens is read from the banner and the dialog (`answerOnScreen`): here only
  //   that this child still asks this very question. Blind: it must be the only one asking (and every child seen).
  const k = mark.screen ? kids.find((x) => x.child === mark.child) : found.complete && kids.length === 1 && !kids[0]!.ambiguous && kids[0]!.child === mark.child ? kids[0] : undefined
  if (!k) return false
  return k.askedAt === mark.askedAt && k.call.step === mark.step && k.call.index === mark.index && k.call.at === mark.callAt
}

/** The home a conversation's transcript path was built from (`transcriptPathOf`) */
function homeOf(transcript: string, conversationId: string): string | undefined {
  const tail = join('.gemini', 'antigravity-cli', 'brain', conversationId, '.system_generated', 'logs', 'transcript_full.jsonl')
  return transcript.endsWith(tail) ? transcript.slice(0, transcript.length - tail.length - 1) : undefined
}

/**
 * ★★ Type the phone's answer to an agy question (docs/AGY.md §13): the steps `questions.ts` built, one at a time, each
 * only while the same question is still up. ⚠️ Nothing from the phone is typed but the notes `questions.ts` cleaned.
 * A step that does not go out after the first one ⇒ `partial` (the PC shows the question half answered).
 */
export async function answerAgyQuestion(
  conversationId: string,
  mark: AgyQuestionMark,
  answer: AgyQuestionAnswer,
  deps: AgyKeysDeps = defaultAgyKeysDeps(),
  tail: (path: string) => Record<string, unknown>[] = readTailRecords,
  /**
   * ★ Asked after the settle wait and before each key of a fixed-key answer: false ⇒ nothing (more) typed. A team's
   *   leader passes "still this team" (`Decision.stillValid` / codex review: a disband during the wait still skipped
   *   the question). The answer typed against the screen asks it before each of its keys too.
   */
  stillWanted?: () => boolean,
): Promise<{ ok: true; left?: true } | { ok: false; reason: AgyQuestionFailure }> {
  const conv = conversationId.toLowerCase()
  return whileAnswering(keyOf(conv), () => serializeBySession(keyOf(conv), async () => {
    const steps = answer.kind === 'steps' ? answer.steps : []
    if (answer.kind === 'steps' && steps.length === 0) return { ok: false, reason: 'changed' }
    if (!deps.isAgy(mark.pid)) return { ok: false, reason: 'not-open' }
    const pane = await agyPaneOf(mark.pid, deps.aliveProcStart)
    if (typeof pane === 'string') return { ok: false, reason: pane }
    // ★ Typed against the screen only through a relay that shows it (an older one would type the request byte)
    if (answer.kind !== 'steps' && !pane.screen) return { ok: false, reason: 'changed' }
    const target = { conversationId: conv, pid: mark.pid, pane, dir: deps.dir, transcript: transcriptPathOf(conv, deps.home) }
    const locksOf = deps.locksOf ?? ((pid: number) => agyLocksOf(pid, deps.home))
    const checks = {
      holdsLock: (pid: number, c: string) => locksOf(pid)?.includes(c) ?? false,
      shared: (c: string, pid: number, since: number) => agyShared(deps.dir, c, pid, deps.isAgy, locksOf, since),
      tail,
    }
    // ⚠️ The slow probes (a Mac's `lsof`) without blocking the agent (codex / agy review)
    if (!sameQuestionNow(target, mark, await probedChecks(deps, tail, mark.pid))) return { ok: false, reason: 'changed' }
    // ★ An answer on the PC just before lands in this wait (as a card's)
    await new Promise((r) => setTimeout(r, deps.answerSettleMs ?? AGY_ANSWER_SETTLE_MS))
    if (stillWanted && !stillWanted()) return { ok: false, reason: 'changed' }
    if (answer.kind !== 'steps') return answerOnScreen({ ...target, stateFile: '' }, pane, mark, answer, checks, deps, tail, stillWanted)
    // ⚠️⚠️ A blind relay opens a subagent's question with ctrl+k: never on agy 1.5.16+ (it approves a command there)
    if (mark.child !== undefined && listAgy(readAgyPidFile(target.dir, mark.pid)?.state.version)) return { ok: false, reason: 'changed' }
    const stepMs = deps.questionStepMs ?? AGY_QUESTION_STEP_MS
    const openMs = deps.childOpenMs ?? AGY_CHILD_OPEN_MS
    // ⚠️ `stillWanted` (slow on a Mac) first, the question last
    const refuse = (slow: boolean) => (): boolean =>
      (stillWanted !== undefined && !stillWanted()) || !sameQuestionNow(target, mark, checks, slow) || (stillWanted !== undefined && !stillWanted())
    // ★ One connection for the whole answer (`writeSequence`): a child's question is opened first with ctrl+k (the
    //   parent's banner), and the PC is taken back to the parent's view after (ESC) — ⚠️ only once the whole answer went
    //   out, only into this same agy, and only while the child asks nothing: on an open question ESC skips it (codex
    //   review). Left out otherwise (the child's view stays on the PC).
    // ★ The slow probes run before the first key and before the last (`sameQuestionNow`'s `slow`)
    const keys = steps.map((step) => ('key' in step ? step.key : step.text))
    const chunks: SequenceChunk[] = []
    if (mark.child !== undefined) chunks.push({ bytes: AGY_CHILD_KEYS.open, pauseMs: 0, beforeWrite: refuse(true) })
    keys.forEach((bytes, i) => {
      const pauseMs = i === 0 ? (mark.child !== undefined ? openMs : 0) : stepMs
      const slow = i === keys.length - 1 || (i === 0 && mark.child === undefined)
      chunks.push({ bytes, pauseMs, beforeWrite: refuse(slow) })
    })
    if (mark.child !== undefined) {
      const childTranscript = transcriptPathOf(mark.child, homeOf(target.transcript, conv) ?? deps.home)
      // the parent's transcript as the answer starts: a new prompt typed on the PC meanwhile moves it (before the status
      // line says "working" / codex review)
      const parentAt = statSync(target.transcript, { throwIfNoEntry: false })?.mtimeMs
      chunks.push({
        bytes: AGY_CHILD_KEYS.back,
        // ★ Sent the moment agy has recorded the answer (asked every 100 ms): the child's next call needs the model to
        //   answer first (seconds), so the view is taken back before it can open (codex review: a fixed wait let a
        //   quick next call keep the PC on the child's view)
        pauseMs: 100,
        waitMs: deps.childBackWaitMs ?? AGY_CHILD_BACK_WAIT_MS,
        // ⚠️ Any pending call of the child: its next question, or an approval of its next command (ESC would decline it
        //    / codex review). The lock was probed right before the last answer key.
        // ⚠️ And only while the parent is still idle with nothing up (a new turn started on the PC meanwhile would be
        //    stopped by it / codex review)
        beforeWrite: () => {
          const f = readAgyPidFile(target.dir, mark.pid)
          if (!f || f.state.conversationId !== conv || f.state.agentState !== 'idle' || f.state.confirmationPending) return true
          if (parentAt === undefined || statSync(target.transcript, { throwIfNoEntry: false })?.mtimeMs !== parentAt) return true
          return agyPendingCall(childTranscript, tail) !== null
        },
        optional: true,
      })
    }
    const res = await writeSequence(pane.socketPath, chunks)
    if (res.ok) return { ok: true }
    // ★ Nothing of the answer went out (on a child, at most the ctrl+k: its view open, the question as it was) ⇒ it may
    //   come back; some of it ⇒ partial (the PC shows it half answered)
    const answerKeys = res.written - (mark.child !== undefined ? 1 : 0)
    if (answerKeys > 0) return { ok: false, reason: 'partial' }
    return { ok: false, reason: res.reason === 'refused' || res.written > 0 ? 'changed' : 'unreachable' }
  }))
}

/**
 * ★★ An answer typed against the screen (docs/AGY.md §14): what the phone chose (`plan`) or "skip", for the question the
 * card showed. Used when the agy's relay shows its screen (`AgyPane.screen`); a blind relay types fixed `steps`.
 */
export type AgyQuestionAnswer =
  | { kind: 'steps'; steps: readonly AgyStep[] }
  | { kind: 'plan'; question: AgyQuestion; plan: AgyAnswerPlan }
  | { kind: 'skip'; question: AgyQuestion }

/** Keys the screen-driven answer types (agy 1.5.13 defaults, measured 2026-11-21) */
export const SCREEN_KEYS = { down: '\x1b[B', up: '\x1b[A', left: '\x1b[D', right: '\x1b[C', space: ' ', enter: '\r', esc: '\x1b', open: '\x0b', respond: 'a' } as const
/** How long a screen change is waited for after a key */
/** ★ The write-in field shows about 4 rows (measured, agy 1.5.13 / 1.5.14): with 3 or more filled it may have scrolled */
const FIELD_FULL_ROWS = 3
/** ★ How much of a written answer is typed before the field is read again (well under what its rows show) */
const NOTE_PIECE = 40

/**
 * A written answer as compared with the field: one Unicode form, every space kept (codex review: "a  b" is not "a b");
 * only the ends trimmed (a field row is read trimmed). Row boundaries are handled by `fieldShows`.
 */
const noteText = (s: string): string => s.normalize('NFC').trim()

/**
 * ★ Whether the field's rows show this text (`noteText`): the whole of it, or (a field that scrolled) its end. A row
 * boundary stands for a space between words or for nothing inside CJK text (agy review: a Japanese note wrapped between
 * two characters never matched); inside a row every space counts. Returns how many characters of the text are shown.
 */
function fieldShows(rows: readonly string[], text: string, how: 'whole' | 'end'): number | undefined {
  const parts = rows.map(noteText).filter((r) => r !== '')
  if (parts.length === 0) return undefined
  const esc = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`${how === 'whole' ? '^' : ''}${parts.map(esc).join(' ?')}$`, 'u')
  const m = re.exec(text)
  return m ? text.length - m.index : undefined
}

/** The note in pieces of `NOTE_PIECE` characters (never splitting a character) */
function notePieces(note: string): string[] {
  const chars = Array.from(note)
  const out: string[] = []
  for (let i = 0; i < chars.length; i += NOTE_PIECE) out.push(chars.slice(i, i + NOTE_PIECE).join(''))
  return out
}
export const SCREEN_SETTLE_MS = 2000
const SCREEN_POLL_MS = 30

class Stop extends Error {
  readonly reason: 'changed' | 'partial'
  constructor(reason: 'changed' | 'partial') {
    super(reason)
    this.reason = reason
  }
}

/**
 * ★★ Types an answer while reading the screen before and after every key (docs/AGY.md §14). Each key is written only
 * while the same question is still up (`sameQuestionNow`; the slow probes before the first and the last), and only when
 * the screen shows what that key is for. Anything else stops it: nothing typed yet ⇒ `changed`, some ⇒ `partial`.
 */
/** The lock checks from probes made now, all at once and without blocking (`withLocksProbed`) */
async function probedChecks(deps: AgyKeysDeps, tail: (path: string) => Record<string, unknown>[], pid?: number): Promise<Parameters<typeof sameQuestionNow>[2]> {
  const probed = await withLocksProbed(deps)
  const base = probed.locksOf ?? ((p: number) => agyLocksOf(p, deps.home))
  // ★ This agy's locks taken now, before what follows (as `withLocksProbed` does for every agy it finds)
  const now = pid === undefined ? undefined : base(pid)
  const locksOf = (p: number): string[] | undefined => (p === pid ? now : base(p))
  return {
    holdsLock: (pid: number, c: string) => locksOf(pid)?.includes(c) ?? false,
    shared: (c: string, pid: number, since: number) => agyShared(deps.dir, c, pid, deps.isAgy, locksOf, since),
    tail,
  }
}

async function answerOnScreen(
  target: AgyTarget,
  pane: AgyPane,
  mark: AgyQuestionMark,
  answer: Exclude<AgyQuestionAnswer, { kind: 'steps' }>,
  checks: Parameters<typeof sameQuestionNow>[2],
  deps: AgyKeysDeps,
  tail: (path: string) => Record<string, unknown>[],
  /** ★ Asked before each key of the answer (a team's leader: still this team / codex review), then the question */
  stillWanted?: () => boolean,
): Promise<{ ok: true; left?: true } | { ok: false; reason: AgyQuestionFailure }> {
  const items = answer.question.items
  const unwanted = (): boolean => stillWanted !== undefined && !stillWanted()
  const settle = deps.screenSettleMs ?? SCREEN_SETTLE_MS
  const look = deps.readScreen ?? ((p: string) => readAgyScreen(p))
  const line = await (deps.openKeyLine ?? openKeyLine)(pane.socketPath)
  if (!line) return { ok: false, reason: 'unreachable' }
  let typed = 0
  /** a key, only while the same question is up (and the slow probes when `slow`) */
  const press = async (bytes: string, slow = false): Promise<void> => {
    // ★ The slow probes (a Mac's `lsof`) made just before, without blocking (codex review: a synchronous probe held the
    //   whole agent — and the phone's 6 s deadline — for seconds)
    const now = slow ? await probedChecks(deps, tail, mark.pid) : checks
    const ok = await line.write(bytes, () => unwanted() || !sameQuestionNow(target, mark, now, slow) || unwanted())
    if (!ok) throw new Stop(typed > 0 ? 'partial' : 'changed')
    typed++
  }
  /**
   * ★ A key that moves between views (the list, a subagent's view): not part of the answer (a stop here is `changed`).
   *   ⚠️ The slow probes first, then the screen read again and checked by `on`, then the key (codex · agy review: the
   *   screen read before a probe of seconds let the PC change it under the key)
   */
  const nav = async (bytes: string, on: (s: string) => boolean, slow = false): Promise<void> => {
    // ★ Every slow check (the lock, another agy on it — `ps` on a Mac) before the screen is read; only the quick ones
    //   between the screen and the key (codex review: the sharing probe ran after the screen and let a draft start)
    const now = slow ? await probedChecks(deps, tail, mark.pid) : checks
    if (!sameQuestionNow(target, mark, now, slow)) throw new Stop(typed > 0 ? 'partial' : 'changed')
    if (!on(await screen())) throw new Stop(typed > 0 ? 'partial' : 'changed')
    // ⚠️ Between the screen and the key only this agy's own state file (the children's scan above can take a while /
    //    codex review: a sibling's question opened during it took the ESC)
    const ok = await line.write(bytes, () => {
      if (unwanted()) return true
      const f = readAgyPidFile(target.dir, mark.pid)
      return !f || f.state.conversationId !== target.conversationId || f.state.agentState !== 'idle' || f.state.confirmationPending
    })
    if (!ok) throw new Stop(typed > 0 ? 'partial' : 'changed')
  }
  const screen = async (): Promise<string> => {
    const s = await look(pane.socketPath)
    if (s === undefined) throw new Stop(typed > 0 ? 'partial' : 'changed')
    return s
  }
  /** Waits for the screen to show what `want` accepts */
  const until = async <T>(want: (s: string) => T | undefined): Promise<T> => {
    const end = Date.now() + settle
    for (;;) {
      const got = want(await screen())
      if (got !== undefined) return got
      if (Date.now() >= end) throw new Stop(typed > 0 ? 'partial' : 'changed')
      await new Promise((r) => setTimeout(r, SCREEN_POLL_MS))
    }
  }
  /** ★ A key only where the footer says what it does (a changed meaning ⇒ nothing typed / codex review) */
  const need = (d: ScreenDialog, ...any: FooterHint[]): void => {
    if (!any.some((h) => d.hints.has(h))) throw new Stop(typed > 0 ? 'partial' : 'changed')
  }
  /** The other questions asked now (`otherQuestions`): a question cut short on the screen must not fit one of them */
  let otherTexts: string[] = []
  /** The dialog of question `i`, as the card showed it (text, options and the write-in row) */
  const dialogOf = (i: number) => (s: string): ScreenDialog | undefined => {
    const d = parseDialog(s)
    const it = items[i]!
    if (!d || d.of !== items.length || d.k !== i + 1 || !dialogFits(d, it)) return undefined
    if (otherTexts.some((o) => sameQuestionText(d.question, o))) return undefined
    // ★★ The dialog is in this question's view: the child's (its id in the header) or the parent's (no header) —
    //    a twin nobody could read cannot take the answer (codex review)
    const owner = viewOwnerOf(s)
    if (mark.child !== undefined ? typeof owner !== 'object' || owner.child !== mark.child.toLowerCase() : owner !== 'parent') return undefined
    return d
  }
  /** Any dialog of this batch is open (which question of it) */
  const batchAt = (s: string): number | undefined => {
    const d = parseDialog(s)
    if (!d || d.of !== items.length || d.k < 1 || d.k > items.length) return undefined
    return dialogOf(d.k - 1)(s) ? d.k - 1 : undefined
  }
  const moveTo = async (i: number, to: number): Promise<ScreenDialog> => {
    let d = await until(dialogOf(i))
    const at = d.options.findIndex((o) => o.cursor)
    if (at < 0) throw new Stop(typed > 0 ? 'partial' : 'changed')
    if (to !== at) need(d, '↑/↓ Navigate')
    // ★ One step at a time, each seen on the screen before the next (codex review: a burst of arrows went on after the
    //   dialog could no longer be read)
    const step = to > at ? 1 : -1
    for (let n = at; n !== to; n += step) {
      await press(step > 0 ? SCREEN_KEYS.down : SCREEN_KEYS.up)
      const next = n + step
      d = await until((s) => {
        const x = dialogOf(i)(s)
        return x && x.options[next]?.cursor ? x : undefined
      })
    }
    return d
  }
  const writeNote = async (i: number, note: string, last: boolean): Promise<void> => {
    const it = items[i]!
    const row = await moveTo(i, it.options.length)
    // (Enter on the write-in row opens the field: "enter Write-in"; a multi-select's footer says "enter Submit" there)
    need(row, 'enter Write-in', ...(it.multi ? (['enter Submit', 'enter Submit All'] as const) : []))
    await press(SCREEN_KEYS.enter)
    const opened = await until((s) => {
      const d = dialogOf(i)(s)
      return d?.writing ? d : undefined
    })
    // ⚠️ agy keeps what was typed in the field before (the PC's draft, an earlier try whose Enter never came): the note
    //    would be added to it (agy review). Only an earlier try of this note is gone on with (below); anything else stops.
    const whole = (d: ScreenDialog): boolean => (d.writtenRows ?? 0) < FIELD_FULL_ROWS
    const before = opened.writtenLines ?? []
    const pieces = notePieces(note)
    // ★ Text left in the field by an earlier try of this note (its Enter, or its later pieces, never came): when the
    //   field shows it whole and it is this note up to one of its pieces, typing goes on from there (codex review: a
    //   retry was refused for good). Anything else — the PC's draft — stops.
    let from = 0
    if (before.length > 0) {
      if (!whole(opened)) throw new Stop(typed > 0 ? 'partial' : 'changed')
      from = -1
      for (let p = pieces.length; p >= 1 && from < 0; p--) if (fieldShows(before, noteText(pieces.slice(0, p).join('')), 'whole') !== undefined) from = p
      if (from < 0) throw new Stop(typed > 0 ? 'partial' : 'changed')
    }
    let field = opened
    if (from < pieces.length) {
      // ★ Typed in pieces, each seen in the field before the next: a long note scrolls (the field shows its end), so
      //   every character is checked while its piece is the end shown (codex review: a "ß" dropped above the visible
      //   rows went unseen). A field with room shows the whole text, which must be what was typed exactly.
      let sent = pieces.slice(0, from).join('')
      for (const piece of pieces.slice(from)) {
        await press(piece)
        sent += piece
        const so = noteText(sent)
        const tail = noteText(piece).length
        field = await until((s) => {
          const d = dialogOf(i)(s)
          if (!d?.writing) return undefined
          const rows = d.writtenLines ?? []
          if (whole(d)) return fieldShows(rows, so, 'whole') !== undefined ? d : undefined
          const shown = fieldShows(rows, so, 'end')
          return shown !== undefined && shown >= tail ? d : undefined
        })
      }
    }
    need(field, 'enter Submit', 'enter Submit All')
    await press(SCREEN_KEYS.enter, last)
  }
  /**
   * ★★ agy 1.5.16 (docs/AGY.md §19.2): the subagent's view opened from the parent's list, told by its id, its question
   *    opened with `a`. Each other view opened on the way is left with `esc back` (its dialog is closed there: opening a
   *    view from the list never opens its dialog — measured). ⚠️ ctrl+k is not used (on an approval it approves).
   *    Returns the screen with this question's dialog open.
   */
  const openFromList = async (start: string): Promise<string> => {
    const child = mark.child!.toLowerCase()
    const listAt = (s: string): ReturnType<typeof parseSubagentList> => (!inChildView(s) && viewOwnerOf(s) === 'parent' && parseDialog(s) === undefined ? parseSubagentList(s) : undefined)
    // ⚠️ Nothing typed in the PC's box (the arrows would move in a draft instead)
    const emptyBox = (s: string): boolean => {
      const box = inputBoxOf(s)
      return box !== undefined && box.every((l) => l.trim() === '')
    }
    let rows = listAt(start)
    if (!rows || !emptyBox(start)) throw new Stop('changed')
    if (!rows.some((r) => r.focused)) {
      await nav(SCREEN_KEYS.down, (s) => listAt(s) !== undefined && emptyBox(s) && !listAt(s)!.some((r) => r.focused), true)
      rows = await until((s) => (listAt(s)?.some((r) => r.focused) ? listAt(s) : undefined))
    }
    // from the top, one row at a time (each seen focused before the next key)
    let at = rows.findIndex((r) => r.focused)
    while (at > 0) {
      const from = at
      await nav(SCREEN_KEYS.up, (s) => listAt(s)?.[from]?.focused === true)
      const want = at - 1
      rows = await until((s) => (listAt(s)?.[want]?.focused ? listAt(s) : undefined))
      at = want
    }
    // ★ Missing from the list only after a walk of a list that stayed the same, each row a different subagent (codex
    //   review: a row added meanwhile shifted the walk, one was opened twice and a live one was taken for missing)
    const startRows = rows.map((r) => r.name).join('\n')
    let moved = false
    const seen = new Set<string>()
    for (let i = 0; i < rows.length; i++) {
      if (i > 0) {
        await nav(SCREEN_KEYS.down, (s) => listAt(s)?.[i - 1]?.focused === true)
        await until((s) => (listAt(s)?.[i]?.focused ? true : undefined))
      }
      await nav(SCREEN_KEYS.enter, (s) => {
        const now = listAt(s)
        if (now !== undefined && now.map((r) => r.name).join('\n') !== startRows) moved = true
        return now?.[i]?.focused === true
      })
      const opened = await until((s) => (inChildView(s) && typeof viewOwnerOf(s) === 'object' ? s : undefined))
      seen.add(childViewOf(opened) ?? '')
      if (childViewOf(opened) === child) {
        // ★ Its question waits there, closed, and is this one (a long one wraps over several rows: joined)
        const fits = (s: string): boolean => childViewOf(s) === child && respondOffered(s) && previewAsks(s, items[0]!.question)
        await until((s) => (fits(s) ? true : undefined))
        await nav(SCREEN_KEYS.respond, fits, true)
        return await until((s) => (batchAt(s) !== undefined ? s : undefined))
      }
      // another subagent's view: back to the list (⚠️ only with nothing open there — ESC on an open question skips it;
      // its footer must say "esc back")
      const closed = (s: string): boolean => inChildView(s) && childViewOf(s) === childViewOf(opened) && parseDialog(s) === undefined && parseApproval(s)?.choices === undefined
      await nav(SCREEN_KEYS.esc, closed)
      await until((s) => (listAt(s)?.[i]?.focused ? true : undefined))
    }
    // ★ Every row opened and this one is not there (a killed one's leftover question): its card is not raised again
    //   while that call stays (codex review: it came back after every failed answer)
    const endRows = (listAt(await screen()) ?? []).map((r) => r.name).join('\n')
    if (!moved && endRows === startRows && seen.size === rows.length && !seen.has('')) noteUnlisted(mark)
    throw new Stop('changed')
  }
  try {
    // ★ No other question asked now has the same text (the screen tells questions apart by their text): checked here,
    //   at the answer, not only when the card was raised (codex review: a sibling asked the same question meanwhile)
    const others = otherQuestions(target, mark, deps, tail)
    if (others === undefined) throw new Stop('changed')
    // ★ A subagent's question: opened from the parent's banner with ctrl+k, unless its dialog is open already — or, on
    //   agy 1.5.16, from the parent's subagent list by its id (`openFromList`)
    let first = await screen()
    // ★★ The list (agy 1.5.16): the dialog is told by its owner's id, so a sibling asking the same text does not stop it
    //    (§19.1 case 4) — a subagent's question only; the parent's own and the banner's are told by their text as before
    const byList = (s: string): boolean => mark.child !== undefined && parseSubagentList(s) !== undefined
    /** Told on the parent's view (below): the list there, or the old way by text */
    const byText = (): void => {
      if (others.some((o) => items.some((x) => sameQuestionText(o, x.question)))) throw new Stop('changed')
      otherTexts = others
    }
    // (a dialog already open, or the parent's view now: decided here; a subagent's view: once back on the parent's)
    // ★ agy 1.5.16: this child's own dialog already open — told by its owner's id (`dialogOf`), not by text (codex review:
    //   a sibling asking the same text made it PC-only)
    const ownersDialog = mark.child !== undefined && batchAt(first) !== undefined && listAgy(readAgyPidFile(target.dir, mark.pid)?.state.version)
    if ((!inChildView(first) || batchAt(first) !== undefined) && !ownersDialog) {
      if (!byList(first)) byText()
    }
    // ★ agy 1.5.16: the PC already on this subagent's view, its question closed: opened right there with `a`
    if (mark.child !== undefined && batchAt(first) === undefined && childViewOf(first) === mark.child.toLowerCase() && respondOffered(first) && previewAsks(first, items[0]!.question)) {
      // (its preview shows this very question, checked again right before `a` / codex review)
      const here = (s: string): boolean => childViewOf(s) === mark.child!.toLowerCase() && respondOffered(s) && previewAsks(s, items[0]!.question)
      await nav(SCREEN_KEYS.respond, here, true)
      first = await until((s) => (batchAt(s) !== undefined ? s : undefined))
    }
    if (batchAt(first) === undefined && inChildView(first) && parseDialog(first) === undefined) {
      // ★★ The PC is on a subagent's view (an earlier answer left it there, or someone opened it) with nothing open in
      //    it: ESC there only goes back to the parent's view (its footer says "esc back"; it stops nothing — measured),
      //    then the parent's banner is read as below. This replaces taking the view back later: every way that record
      //    got lost left the siblings' questions off the phone (codex / agy review, four rounds / user decision).
      //    The parent is idle (`sameQuestionNow`), so the parent's view it lands on is never a working one.
      // ⚠️ The slow probes first, then the screen again, then the key: the viewed child may open a question or an
      //    approval meanwhile, and ESC would skip or decline it (codex / agy review). The viewed child must not be
      //    asking either (its question queued, not yet drawn).
      const now = await probedChecks(deps, tail, mark.pid)
      // ★ Every slow check (sharing, the children's scan — `ps` on a Mac) before the screen is read again; only quick
      //   file checks between it and the ESC (codex review: another child's question opened during them took it)
      if (!sameQuestionNow(target, mark, now, true)) throw new Stop('changed')
      const again = await screen()
      const viewed = childViewOf(again)
      if (!inChildView(again) || parseDialog(again) !== undefined || viewed === undefined) throw new Stop('changed')
      const viewedT = transcriptPathOf(viewed, homeOf(target.transcript, target.conversationId) ?? deps.home)
      // ⚠️ Any call pending there (a question, a command whose approval is about to be drawn — ESC would decline it), or
      //    none readable: not left (codex / agy review). A long command there keeps the sibling's answer waiting.
      const asking = (): boolean => agyPendingCall(viewedT, tail) !== null
      const ok = await line.write(SCREEN_KEYS.esc, () => {
        if (unwanted() || asking()) return true
        // (the parent's own question: its own transcript and state, read quickly; a subagent's: the parent idle)
        if (mark.child === undefined) return !sameQuestionNow(target, mark, now, false)
        const f = readAgyPidFile(target.dir, mark.pid)
        return !f || f.state.conversationId !== target.conversationId || f.state.agentState !== 'idle' || f.state.confirmationPending
      })
      if (!ok) throw new Stop('changed')
      typed++
      // (the parent's view: its banner for a subagent's question, the dialog for its own)
      first = await until((s) => (!inChildView(s) && viewOwnerOf(s) === 'parent' && (mark.child !== undefined ? (parseBanner(s) ?? parseSubagentList(s)) : batchAt(s)) !== undefined ? s : undefined))
    }
    const listed = byList(first)
    if (inChildView(first) === false && batchAt(first) === undefined && !listed && otherTexts !== others) byText()
    if (mark.child !== undefined && batchAt(first) === undefined && listed) first = await openFromList(first)
    if (mark.child !== undefined && batchAt(first) === undefined) {
      // ⚠️⚠️ agy 1.5.16+: never the banner's ctrl+k (it approves a subagent's command at once / codex · agy review)
      if (listAgy(readAgyPidFile(target.dir, mark.pid)?.state.version)) throw new Stop('changed')
      const banner = parseBanner(first)
      if (banner === undefined || inChildView(first) || !sameQuestionText(banner, items[0]!.question) || otherTexts.some((o) => sameQuestionText(banner, o))) throw new Stop('changed')
      await press(SCREEN_KEYS.open, true)
      first = await until((s) => (batchAt(s) !== undefined ? s : undefined))
    }
    // ★ The batch from its first question: one the PC went further in is taken back with ← (an open write-in field is
    //   left with ESC first: there it means "back", never "skip")
    const found = batchAt(first)
    if (found === undefined) throw new Stop('changed')
    let at: number = found
    if (dialogOf(at)(first)!.writing) {
      const open = at
      await press(SCREEN_KEYS.esc)
      await until((s) => (dialogOf(open)(s) && !dialogOf(open)(s)!.writing ? true : undefined))
    }
    while (at > 0) {
      need((await until(dialogOf(at)))!, '← Back')
      await press(SCREEN_KEYS.left)
      const back: number = at - 1
      await until((s) => (dialogOf(back)(s) && !dialogOf(back)(s)!.writing ? true : undefined))
      at = back
    }
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!
      const last = i === items.length - 1
      let d = await until(dialogOf(i))
      if (d.writing) {
        // (the footer says ESC goes back here: `parseDialog` reads no other)
        await press(SCREEN_KEYS.esc)
        d = await until((s) => {
          const x = dialogOf(i)(s)
          return x && !x.writing ? x : undefined
        })
      }
      if (answer.kind === 'skip') {
        // (ESC skips here: `parseDialog` reads a dialog without the field open only with the footer "esc Skip")
        await press(SCREEN_KEYS.esc, last)
      } else {
        const p = answer.plan.items[i]!
        if (!it.multi) {
          if (p.note !== undefined) await writeNote(i, p.note, last)
          else if (it.options.length + 1 <= 9) await press(String(p.indexes[0]! + 1), last)
          else {
            const on = await moveTo(i, p.indexes[0]!)
            need(on, 'enter Select', 'enter Submit', 'enter Submit All')
            await press(SCREEN_KEYS.enter, last)
          }
        } else {
          // ★ Toggle only what differs from the screen (ticks the PC left are put right), then check them all
          for (let j = 0; j < it.options.length; j++) {
            const want = p.indexes.includes(j)
            const now = await until(dialogOf(i))
            if (now.options[j]!.checked === want) continue
            // a digit toggles at once (and moves the cursor there); a long list is walked with the cursor
            if (it.options.length + 1 <= 9) await press(String(j + 1))
            else {
              need(await moveTo(i, j), 'space Toggle')
              await press(SCREEN_KEYS.space)
            }
            await until((s) => (dialogOf(i)(s)?.options[j]!.checked === want ? true : undefined))
          }
          const all = await until(dialogOf(i))
          if (all.options.slice(0, it.options.length).some((o, j) => o.checked !== p.indexes.includes(j))) throw new Stop(typed > 0 ? 'partial' : 'changed')
          if (p.note !== undefined) await writeNote(i, p.note, last)
          else {
            // ⚠️ Enter on the write-in row opens the field instead of submitting (codex review): off it first
            const off = all.options[it.options.length]!.cursor ? await moveTo(i, 0) : all
            if (last) need(off, 'enter Submit', 'enter Submit All')
            else need(off, '→ Next')
            await press(last ? SCREEN_KEYS.enter : SCREEN_KEYS.right, last)
          }
        }
      }
      // ★ The next question of the batch is up; after the last one, the dialog is gone (else it was not submitted)
      // ⚠️ "gone" = no row of this batch's questions left at all (an unread footer must not read as gone / codex review)
      if (!last) await until(dialogOf(i + 1))
      else await until((s) => (showsQuestion(s, items.map((x) => x.question), items.length) ? undefined : true))
    }
    if (mark.child !== undefined) {
      // ★ Back to the parent's view: only once the screen shows the child's view with no question open, the parent idle
      //   with nothing up, its transcript unchanged (a new prompt typed on the PC) — else left on the child's view
      const parentAt = statSync(target.transcript, { throwIfNoEntry: false })?.mtimeMs
      const childTranscript = transcriptPathOf(mark.child, homeOf(target.transcript, target.conversationId) ?? deps.home)
      // (and agy has recorded the answer: the child asks nothing now)
      const ready = await until((s) => (childViewOf(s) === mark.child!.toLowerCase() && parseDialog(s) === undefined && agyPendingCall(childTranscript, tail) === null ? true : undefined)).catch(() => false)
      let back = false
      if (ready === true) {
        back = await line.write(SCREEN_KEYS.esc, () => {
          const f = readAgyPidFile(target.dir, mark.pid)
          if (!f || f.state.conversationId !== target.conversationId || f.state.agentState !== 'idle' || f.state.confirmationPending) return true
          if (parentAt === undefined || statSync(target.transcript, { throwIfNoEntry: false })?.mtimeMs !== parentAt) return true
          return agyPendingCall(childTranscript, tail) !== null
        })
      }
      // ★ Left on the child's view (the parent was busy): the next answer to a subagent's question goes back first
      if (!back) return { ok: true, left: true }
      // ★ agy 1.5.16: back on the parent's view the list keeps the focus ⇒ ESC gives it back to the input box (only
      //   while the list has it, on the parent's view with nothing open, the parent idle — ESC there is the list's)
      if (listed) {
        // (agy redraws the parent's view after the ESC: waited for / agy review)
        const s = await until((x) => (!inChildView(x) && viewOwnerOf(x) === 'parent' ? x : undefined)).catch(() => undefined)
        if (s !== undefined && parseDialog(s) === undefined && listFocused(s)) {
          await line.write(SCREEN_KEYS.esc, () => {
            const f = readAgyPidFile(target.dir, mark.pid)
            if (!f || f.state.conversationId !== target.conversationId || f.state.agentState !== 'idle' || f.state.confirmationPending) return true
            // (a new prompt typed on the PC meanwhile: its turn is not stopped by it)
            return parentAt === undefined || statSync(target.transcript, { throwIfNoEntry: false })?.mtimeMs !== parentAt
          })
        }
      }
    }
    return { ok: true }
  } catch (err) {
    if (err instanceof Stop) return { ok: false, reason: err.reason }
    return { ok: false, reason: typed > 0 ? 'partial' : 'changed' }
  } finally {
    line.close()
  }
}

/**
 * ★ The texts of every other question asked now (the parent's own, the other subagents'), all of their batch: the
 * screen tells dialogs apart by text only, so one sharing a text with this batch (any question of either) stops it, and
 * a question cut short on the screen must not fit one of them. undefined = cannot be read.
 */
function otherQuestions(
  target: Pick<AgyTarget, 'conversationId' | 'dir' | 'transcript'>,
  mark: AgyQuestionMark,
  deps: AgyKeysDeps,
  tail: (path: string) => Record<string, unknown>[],
): string[] | undefined {
  const f = readAgyPidFile(target.dir, mark.pid)
  if (!f) return undefined
  const home = homeOf(target.transcript, target.conversationId) ?? deps.home
  const calls: PendingCall[] = []
  if (mark.child !== undefined) {
    const own = turnEnd(tail(target.transcript)).pending
    if (own?.name === AGY_QUESTION_TOOL) calls.push(own)
  }
  const kids = agyChildQuestions(f.state, target.conversationId, home, tail)
  // ⚠️ A running child whose call could not be read may ask the same: not answered (codex / agy review)
  if (f.state.subagentsActive && !kids.known) return undefined
  for (const k of kids.asking) if (k.child !== mark.child) calls.push(k.call)
  // ⚠️ Every question of every call, also one the phone does not take (`questionTextsOf`); one not readable stops it
  const out: string[] = []
  for (const c of calls) {
    const texts = questionTextsOf(c)
    if (texts === undefined) return undefined
    out.push(...texts)
  }
  return out
}

