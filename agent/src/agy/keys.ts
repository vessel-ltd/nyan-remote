// ★★ Typing into an agy TUI and stopping it, from the phone (2026-11-20 / docs/AGY.md §8).
//
// The way in is the same pty relay Claude uses (`scripts/relay.py`, started by the `~/.nyan-remote/bin/agy` shim):
// the relay announces `~/.nyan-remote/panes/<agy pid>.json`, and the agy's status line file
// (`~/.nyan-remote/agy/session-<id>.json`) names the same pid. The bytes go through `claude/keys.ts`'s writers
// (`writeKeys` / `writeControl`), so the socket rules (0600, same uid, paste handshake) are the same.
//
// ## What is different from Claude (measured on agy 1.5.12, 2026-11-20)
//
//   1. ⚠️⚠️ **Text is typed only while agy is idle.** On an approval card `y` approves, `n` declines, digits pick an
//      option and Enter takes option 1. agy says a card is up only through its status line (written at most every
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
import {
  AGY_PREFIX,
  agyPaneOf,
  defaultAgyDeps,
  liveAgy,
  parseAgyFile,
  transcriptPathOf,
  type AgyDeps,
  type AgyPane,
  type AgyPaneFailure,
  type AgyState,
} from './sessions.ts'

/** What agy's state allows: a send, a stop */
export type AgyGate = 'ok' | 'busy' | 'waiting' | 'unsure' | 'idle'

const WORKING = new Set(['working', 'tool_use', 'reviewing'])
const SETTLED = new Set(['idle', 'error'])

/**
 * ★ May text be typed now? (rules 1 and 2 above)
 * - a card is up ⇒ `waiting`; a turn runs ⇒ `busy`
 * - idle / error ⇒ `ok` only when the status line wrote it at or after the transcript's last write; else `unsure`
 * - anything else (starting, signing in, unknown) ⇒ `unsure`
 */
export function sendGate(
  s: Pick<AgyState, 'agentState' | 'confirmationPending'>,
  stateMtimeMs: number,
  transcriptMtimeMs: number | undefined,
): Exclude<AgyGate, 'idle'> {
  if (s.confirmationPending) return 'waiting'
  if (s.agentState && WORKING.has(s.agentState)) return 'busy'
  if (!s.agentState || !SETTLED.has(s.agentState)) return 'unsure'
  if (transcriptMtimeMs === undefined || stateMtimeMs < transcriptMtimeMs) return 'unsure'
  return 'ok'
}

/**
 * ★ May ESC be sent now? Only while a turn runs and no card is up (ESC on a card declines it: that is the card's own
 * answer, left to the PC / phase 3). Idle ⇒ nothing to stop (or `unsure` when the transcript moved past the status line).
 */
export function stopGate(
  s: Pick<AgyState, 'agentState' | 'confirmationPending'>,
  stateMtimeMs: number,
  transcriptMtimeMs: number | undefined,
): Exclude<AgyGate, 'busy'> {
  if (s.confirmationPending) return 'waiting'
  if (s.agentState && WORKING.has(s.agentState)) return 'ok'
  const settled = sendGate(s, stateMtimeMs, transcriptMtimeMs)
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

export type AgyTargetFailure = 'not-open' | AgyPaneFailure

export interface AgyKeysDeps extends AgyDeps {
  /** ⚠️ Right before typing: the uncached liveness (codex round 13 / same as Claude's `findPane`) */
  aliveProcStart: (pid: number) => string | null | undefined
  /** ★ Reads the state as of now (each gate). Replaced in tests to change it between the checks */
  readNow?: typeof readNow
}

export function defaultAgyKeysDeps(): AgyKeysDeps {
  return { ...defaultAgyDeps(), aliveProcStart: aliveProcStartFreshSync }
}

/** ★ The agy showing this conversation now, and its way in. ⚠️ Only the conversation its pid wrote last (`liveAgy`) */
export async function findAgyTarget(conversationId: string, deps: AgyKeysDeps): Promise<AgyTarget | AgyTargetFailure> {
  const live = await liveAgy(deps)
  const f = live.find((x) => x.state.conversationId === conversationId)
  if (!f) return 'not-open'
  const pane = await agyPaneOf(f.state.pid, deps.aliveProcStart)
  if (typeof pane === 'string') return pane
  // ⚠️ Written before this agy's relay registered ⇒ an earlier process with the same pid (codex review)
  if (f.mtimeMs < pane.startedAt) return 'not-open'
  return {
    conversationId,
    pid: f.state.pid,
    pane,
    dir: deps.dir,
    stateFile: join(deps.dir, `session-${conversationId}.json`),
    transcript: transcriptPathOf(conversationId, deps.home),
  }
}

/**
 * ★ The state as of now, read again (before the body, before Enter, before ESC). ⚠️ Synchronous: it runs inside the
 * socket's connect / timer callbacks. Anything unreadable, or a file now naming another pid ⇒ undefined (= refuse).
 */
export function readNow(target: Pick<AgyTarget, 'conversationId' | 'pid' | 'pane' | 'dir' | 'stateFile' | 'transcript'>):
  | { state: AgyState; stateMtimeMs: number; transcriptMtimeMs: number | undefined }
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
    return { state, stateMtimeMs, transcriptMtimeMs }
  } catch {
    return undefined
  }
}

const sendNow = (target: AgyTarget, read: typeof readNow): Exclude<AgyGate, 'idle'> => {
  const now = read(target)
  return now ? sendGate(now.state, now.stateMtimeMs, now.transcriptMtimeMs) : 'unsure'
}

const stopNow = (target: AgyTarget, read: typeof readNow): Exclude<AgyGate, 'busy'> => {
  const now = read(target)
  return now ? stopGate(now.state, now.stateMtimeMs, now.transcriptMtimeMs) : 'unsure'
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
  | 'unsure'
  | 'shortcut-like'
  | 'command-like'
  | 'empty'
  | 'too-long'
  | 'long-needs-paste'
  | 'unreachable'
  | 'partial'

export type AgyStopFailure = AgyTargetFailure | 'waiting' | 'unsure' | 'idle' | 'too-soon' | 'unreachable'

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
    const gate = sendNow(target, read)
    if (gate !== 'ok') return fail(gate)
    const typed = agyTyped(clean.value.text)
    const long = needsPaste(typed)
    if (long && !target.pane.paste) return fail('long-needs-paste')
    // ★ Looked at again right before the body and right before Enter (a card, a turn the PC started)
    let refusedBy: Exclude<AgyGate, 'idle' | 'ok'> | undefined
    const stopHere = (): boolean => {
      const g = sendNow(target, read)
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
  return serializeBySession(key, async () => {
    const prev = lastStopAt.get(key)
    if (prev !== undefined && now() - prev < AGY_STOP_COOLDOWN_MS) return failStop('too-soon')
    const target = await findAgyTarget(conversationId, deps)
    if (typeof target === 'string') return failStop(target)
    const gate = stopNow(target, read)
    if (gate !== 'ok') return failStop(gate)
    let refusedBy: Exclude<AgyGate, 'busy' | 'ok'> | undefined
    const res = await writeControl(target.pane.socketPath, CONTROL_KEYS.escape, {
      beforeWrite: () => {
        const g = stopNow(target, read)
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

