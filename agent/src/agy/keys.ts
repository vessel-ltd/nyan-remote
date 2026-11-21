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
} from '../claude/keys.ts'
import { callBeforeState, readTailRecords, turnEnd } from './pending.ts'
import {
  AGY_PREFIX,
  agyAsking,
  agyConversations,
  agyQuestionInTranscript,
  agyLocksOf,
  agyPaneOf,
  agyShared,
  readAgyPidFile,
  defaultAgyDeps,
  liveAgy,
  parseAgyFile,
  transcriptPathOf,
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
): Exclude<AgyGate, 'idle'> {
  if (s.confirmationPending) return 'waiting'
  if (asking) return 'asking'
  if (s.subagentsActive) return 'subagent'
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
): Exclude<AgyGate, 'busy'> {
  if (s.confirmationPending) return 'waiting'
  if (asking) return 'asking'
  if (s.subagentsActive) return 'subagent'
  if (s.agentState && WORKING.has(s.agentState)) return 'ok'
  const settled = sendGate(s, stateMtimeMs, transcriptMtimeMs, false)
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

const sendNow = (target: AgyTarget, read: typeof readNow, holds: LockCheck): Exclude<AgyGate, 'idle'> => {
  if (!holds(target.pid, target.conversationId)) return 'unsure'
  const now = read(target)
  return now ? sendGate(now.state, now.stateMtimeMs, now.transcriptMtimeMs, now.asking) : 'unsure'
}

const stopNow = (target: AgyTarget, read: typeof readNow, holds: LockCheck): Exclude<AgyGate, 'busy'> => {
  if (!holds(target.pid, target.conversationId)) return 'unsure'
  const now = read(target)
  return now ? stopGate(now.state, now.stateMtimeMs, now.transcriptMtimeMs, now.asking) : 'unsure'
}

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

export type AgyStopFailure = AgyTargetFailure | 'waiting' | 'asking' | 'subagent' | 'unsure' | 'idle' | 'too-soon' | 'unreachable'

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
      'agy の子（サブエージェント）が動いています。PC で子の質問を開いていると送った文がそこに入るため、子が終わるまでスマホからは送れません。',
      'An agy subagent is running. Text sent now could go into its question if it is open on the PC, so sending from the phone waits until it has finished.',
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
      'agy の子（サブエージェント）が動いています。PC で子の質問を開いていると止める合図がそれを飛ばすため、スマホからは止められません（PC で操作してください）。',
      'An agy subagent is running. A stop could skip its question if it is open on the PC, so it cannot be stopped from the phone (use the PC).',
    ),
  ],
  unsure: () => [409, t('agy の状態を確かめられませんでした。少し待ってからもう一度押してください。', 'Could not tell what agy is doing. Wait a moment and press it again.')],
  idle: () => [409, t('agy はいま応答していません（止めるものがありません）。', 'agy is not working right now (nothing to stop).')],
  'too-soon': () => [429, t('止める合図を送ったところです。', 'A stop was just sent.')],
  unreachable: () => [502, t('agy への入口が応答しません。', 'The way into agy is not responding.')],
}

const fail = <F extends AgySendFailure>(reason: F): AgyResult<F> => ({ ok: false, reason, message: AGY_SEND_REFUSAL[reason]()[1] })
const failStop = <F extends AgyStopFailure>(reason: F): AgyResult<F> => ({ ok: false, reason, message: AGY_STOP_REFUSAL[reason]()[1] })

/** ★ Type one message into the agy showing this conversation. ⚠️ Serialized with its stops (same chain key as the row id) */
export async function sendToAgy(
  conversationId: string,
  text: unknown,
  deps: AgyKeysDeps = defaultAgyKeysDeps(),
): Promise<AgyResult<AgySendFailure>> {
  const key = keyOf(conversationId)
  const read = deps.readNow ?? readNow
  const holds = lockCheck(deps)
  return serializeBySession(key, async () => {
    const clean = sanitizeForKeys(text)
    if (!clean.ok) {
      const r = clean.reason
      return fail(r === 'command-like' || r === 'empty' || r === 'too-long' ? r : 'empty')
    }
    if (looksLikeAgyShortcut(clean.value.text)) return fail('shortcut-like')
    const target = await findAgyTarget(conversationId, deps)
    if (typeof target === 'string') return fail(target)
    if (typedTooLong(clean.value.text)) return fail('too-long')
    const gate = sendNow(target, read, holds)
    if (gate !== 'ok') return fail(gate)
    const typed = agyTyped(clean.value.text)
    const long = needsPaste(typed)
    if (long && !target.pane.paste) return fail('long-needs-paste')
    // ★ Looked at again right before the body and right before Enter (a card, a turn the PC started)
    let refusedBy: Exclude<AgyGate, 'idle' | 'ok'> | undefined
    const stopHere = (): boolean => {
      const g = sendNow(target, read, holds)
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

/** ★ Do not send ESC twice within this (a double tap / two phones); remembered only when it was sent */
export const AGY_STOP_COOLDOWN_MS = 1500
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
  return serializeBySession(key, async () => {
    const prev = lastStopAt.get(key)
    if (prev !== undefined && now() - prev < AGY_STOP_COOLDOWN_MS) return failStop('too-soon')
    const target = await findAgyTarget(conversationId, deps)
    if (typeof target === 'string') return failStop(target)
    const gate = stopNow(target, read, holds)
    if (gate !== 'ok') return failStop(gate)
    let refusedBy: Exclude<AgyGate, 'busy' | 'ok'> | undefined
    const res = await writeControl(target.pane.socketPath, CONTROL_KEYS.escape, {
      beforeWrite: () => {
        const g = stopNow(target, read, holds)
        if (g === 'ok') return false
        refusedBy = g
        return true
      },
    })
    await noteControl(key, 'escape', res.ok ? undefined : res.reason)
    if (!res.ok) return failStop(res.reason === 'pending-approval' ? (refusedBy ?? 'unsure') : 'unreachable')
    lastStopAt.set(key, now())
    for (const [id, at] of lastStopAt) if (now() - at >= AGY_STOP_COOLDOWN_MS && id !== key) lastStopAt.delete(id)
    return { ok: true }
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
  return serializeBySession(keyOf(conv), async () => {
    if (!deps.isAgy(mark.pid)) return { ok: false, reason: 'not-open' }
    // ⚠️ The uncached liveness (a reused pid is the worst place to type)
    const pane = await agyPaneOf(mark.pid, deps.aliveProcStart)
    if (typeof pane === 'string') return { ok: false, reason: pane }
    const target = { conversationId: conv, pid: mark.pid, pane, dir: deps.dir, transcript: transcriptPathOf(conv, deps.home) }
    const locksOf = deps.locksOf ?? ((pid: number) => agyLocksOf(pid, deps.home))
    const checks = {
      holdsLock: (pid: number, c: string) => locksOf(pid)?.includes(c) ?? false,
      shared: (c: string, pid: number, since: number) => agyShared(deps.dir, c, pid, deps.isAgy, locksOf, since),
      tail,
    }
    if (!sameCardNow(target, mark, checks)) return { ok: false, reason: 'changed' }
    await new Promise((r) => setTimeout(r, deps.answerSettleMs ?? AGY_ANSWER_SETTLE_MS))
    const res = await writeControl(pane.socketPath, AGY_CARD_KEYS[behavior], {
      // ⚠️ `stillWanted` last: the card checks can take a while (a Mac's `lsof`), and an expiry during them counts
      beforeWrite: () => !sameCardNow(target, mark, checks) || (stillWanted !== undefined && !stillWanted()),
    })
    if (res.ok) return { ok: true }
    return { ok: false, reason: res.reason === 'pending-approval' ? 'changed' : 'unreachable' }
  })
}
