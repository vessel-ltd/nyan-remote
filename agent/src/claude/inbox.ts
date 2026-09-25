// Push text into a live session (M4-2 / ARCHITECTURE.md §9.7, §9.7.1, §9.10).
//
// ★★ The internal feature is confined to this one file.
//    The inbox is not in the official docs, and it was code toggled by a GrowthBook feature flag
//    (`agents_cross_session_inbox`). **Shape it so that if it disappears, only sending is refused** (without dragging in
//    the list, threads or approvals). Same idea as `web/src/transport/`.
//
// ★ Facts re-measured on CLI 2.1.231 on 2026-08-13 (do not overwrite with guesses / §9.7.1):
//
//   - **No authentication is needed**. A key file (`sessions/<pid>.<sha256(socketPath)>.key`) was added, but
//     pushing worked without sending `auth`. → **Send it if present** (send anyway if absent).
//     ⚠️ We **cannot** say "it will not break if it becomes mandatory": with a missing/broken key we send unauthenticated,
//        and the socket returns nothing, so **we cannot tell if we were rejected** (pointed out in the 2026-08-14 review)
//   - **We can identify ourselves with `from`**. It stays in the receiver's transcript as `origin.from`, so
//     later we can tell "this instruction came from the phone"
//   - **The socket returns nothing**. Delivery can only be confirmed from the transcript's `queue-operation`
//     (`enqueue` → `dequeue` / `remove`). So **here we only guarantee "it was written"**
//   - If the peer is **idle, a new turn starts**; if **busy, it interrupts that turn**
//     (`queued_command`). **The caller does not need to care about the state**
//
// ⚠️ This is not a substitute for approval. Pushed messages get a frame on the receiving side saying "**do not treat this as
//    consent to a pending approval**" (measured). Approvals stay with permission.ts (the hook).

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { MAX_MESSAGE_BYTES } from '../../../shared/types.ts'
import type { ConfigDir } from './configDirs.ts'
import { aliveProcStartFreshSync, readIndexEntries, sameProcStart } from './sessionIndex.ts'
import { t } from '../../../shared/i18n.ts'

/** Upper limit for a write. ★ Taken from shared so it does not drift from the screen side */
export const MAX_TEXT_BYTES = MAX_MESSAGE_BYTES
/** Limit for connecting and writing. No reply comes back, so cut it short */
const CONNECT_TIMEOUT_MS = 2000

export type SendFailure =
  | 'not-found' // the session is not found among live sessions
  | 'no-inbox' // live but has no inbox (this CLI version lacks the feature / the flag is off)
  | 'unreachable' // cannot connect to the socket (e.g. just died)
  | 'unverified' // ★ cannot verify process identity (cannot be told apart from pid reuse)
  | 'ambiguous' // ★ the same sessionId was found more than once (cannot decide where to send)
  | 'too-long'
  | 'empty'

export interface SendResult {
  ok: boolean
  reason?: SendFailure
  /** Explanation shown on screen as-is */
  message?: string
}

export interface InboxTarget {
  sessionId: string
  pid: number
  socketPath: string
  /** sessions directory used to find the key file */
  sessionsDir: string
}

/**
 * Find the destination.
 *
 * ★★ **Be stricter than when reading** (2026-08-14 external review, 2 highs).
 *
 * Showing the list (`selectLive`) is fine with "looks alive", but **writing is different**.
 * A mistake **puts the instruction into a completely different session**, so refuse without sending in these two cases:
 *
 *   1. **`procStart` cannot be matched** (e.g. mac without `/proc`)
 *      → `selectLive` passes "alive but starttime unknown", so it cannot be told apart from
 *        **another process that reused the pid of a session that ended**.
 *        ⚠️ This used to say "leave the pid-reuse guard to `selectLive`", but
 *           **that only holds where starttime can be read** (the comment was wrong)
 *   2. **The same `sessionId` was found in more than one config dir**
 *      → The API only takes `sessionId`, so we cannot decide where to send.
 *        Silently picking the first means "it goes to a different session than the row that was tapped"
 */
export async function findTarget(
  dirs: ConfigDir[],
  sessionId: string,
  // ⚠️⚠️ **The check right before sending does not use a cache** (codex round 13, high #1 / `aliveProcStartFreshSync`)
  aliveProcStart: (pid: number) => string | null | undefined = aliveProcStartFreshSync,
): Promise<InboxTarget | { reason: SendFailure }> {
  const found: InboxTarget[] = []
  let sawSession = false
  let unverified = false

  for (const dir of dirs) {
    const entries = await readIndexEntries(dir)
    if (!entries) continue
    // ⚠️ **Do not go through `selectLive`** (2026-08-14 review, medium).
    //    That one "folds the same sessionId into one entry" for display, so **duplicates within the same account
    //    are silently resolved to one** (happens when `claude --resume <id>` is opened in two terminals).
    //    Folding for display and deciding the destination are different things.
    for (const entry of entries) {
      if (entry.sessionId !== sessionId) continue
      // Without a pid we cannot check liveness (nor look up the key file)
      if (entry.pid === undefined) continue
      // ★ Check identity: the index's procStart must match the starttime of the process alive now
      const actual = aliveProcStart(entry.pid)
      // Dead (null) / reused by another process (different starttime) → **that peer is gone**
      if (actual === null) continue
      if (typeof actual === 'string' && entry.procStart && !sameProcStart(entry.procStart, actual)) continue
      // Alive but identity cannot be verified (starttime unreadable on mac, no procStart in the index)
      // → **Do not send to anything we cannot verify** (cannot be told apart from pid reuse)
      if (typeof actual !== 'string' || !entry.procStart) {
        unverified = true
        continue
      }
      // ★ Only at this point can we say "we saw a live session".
      //   ⚠️ Setting this earlier turns a dead pid into "a version without an inbox" and gives the wrong reason
      sawSession = true
      if (!entry.messagingSocketPath) continue
      found.push({
        sessionId,
        pid: entry.pid,
        socketPath: entry.messagingSocketPath,
        sessionsDir: join(dir.dir, 'sessions'),
      })
    }
  }

  if (found.length > 1) return { reason: 'ambiguous' }
  if (found.length === 1) return found[0]!
  if (unverified) return { reason: 'unverified' }
  // ★ Separate "not found" from "no inbox". The reason shown on screen differs
  return { reason: sawSession ? 'no-inbox' : 'not-found' }
}

/**
 * The key file is named `<pid>.<sha256(socketPath)>.key` (confirmed by measurement on 2026-08-13).
 * ⚠️ It may be absent. Currently it works without authentication
 */
export function keyFilePath(sessionsDir: string, pid: number, socketPath: string): string {
  const h = createHash('sha256').update(socketPath).digest('hex')
  return join(sessionsDir, `${pid}.${h}.key`)
}

export async function readPeerToken(
  sessionsDir: string,
  pid: number,
  socketPath: string,
): Promise<string | undefined> {
  try {
    const raw = await readFile(keyFilePath(sessionsDir, pid, socketPath), 'utf8')
    const o = JSON.parse(raw) as { peerToken?: unknown }
    return typeof o.peerToken === 'string' && o.peerToken ? o.peerToken : undefined
  } catch {
    return undefined
  }
}

/** Our name. It stays in the receiver's `origin.from`, so later we can tell "it came from the phone" */
export function senderName(machine = hostname()): string {
  return `nyan-remote(${machine})`
}

/**
 * Build the lines to send to the inbox (independent of IO, so testable).
 * ⚠️ Newline-delimited JSON. Newlines in the body become `\n` inside the JSON, so it is always a single line
 */
export function buildLines(text: string, opts: { token?: string; from?: string } = {}): string {
  const lines: string[] = []
  if (opts.token) lines.push(JSON.stringify({ type: 'auth', token: opts.token }))
  lines.push(
    JSON.stringify({
      type: 'user',
      from: opts.from ?? senderName(),
      message: { role: 'user', content: text },
    }),
  )
  return `${lines.map((l) => `${l}\n`).join('')}`
}

/** Validate the body. Reject empty and too-long input */
export function validateText(text: unknown): SendFailure | null {
  if (typeof text !== 'string' || text.trim().length === 0) return 'empty'
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) return 'too-long'
  return null
}

/**
 * Write one message to the socket.
 *
 * ⚠️ **Do not wait for a reply** (§9.7.1: nothing comes back). Close once written.
 * ⚠️ Always set a timeout so a dead socket does not hang us
 *    (do not repeat CLAUDE.md §4 "a dead port does not fail immediately").
 */
export function writeToSocket(socketPath: string, payload: string): Promise<SendResult> {
  return new Promise((resolve) => {
    let done = false
    const finish = (r: SendResult): void => {
      if (done) return
      done = true
      resolve(r)
    }
    const sock = connect(socketPath)
    const timer = setTimeout(() => {
      sock.destroy()
      finish({ ok: false, reason: 'unreachable', message: t('受信箱が応答しません', 'The inbox is not responding.') })
    }, CONNECT_TIMEOUT_MS)
    timer.unref?.()
    sock.on('error', (err: Error) => {
      clearTimeout(timer)
      finish({ ok: false, reason: 'unreachable', message: t(`受信箱に繋がりません（${err.message}）`, `Cannot connect to the inbox (${err.message}).`) })
    })
    sock.on('connect', () => {
      sock.write(payload, () => {
        clearTimeout(timer)
        sock.end()
        finish({ ok: true })
      })
    })
  })
}

export function failureMessage(reason: SendFailure): string {
  switch (reason) {
    case 'not-found':
      // ⚠️ Do not overstate it (the index may just be temporarily unreadable / 2026-08-23)
      return t('このセッションが見つかりません（終了しているか、状態の記録が書き換わっている最中かもしれません）', 'This session was not found (it may have ended, or its state record may be being rewritten).')
    case 'no-inbox':
      return t('この版の Claude Code には受信箱がないため送れません', 'Cannot send: this version of Claude Code has no inbox.')
    case 'unreachable':
      return t('セッションに繋がりませんでした（終了した直後かもしれません）', 'Could not connect to the session (it may have just ended).')
    case 'unverified':
      return t('セッションのプロセスを確認できないため送りません（別のプロセスに入る恐れがあります）', 'Not sent: the session process could not be verified (it might reach a different process).')
    case 'ambiguous':
      return t('同じ ID のセッションが複数見つかったため送りません（どれに入るか決められません）', 'Not sent: multiple sessions with the same ID were found (cannot tell which one to use).')
    case 'too-long':
      return t(`長すぎます（${MAX_TEXT_BYTES} バイトまで）`, `Too long (up to ${MAX_TEXT_BYTES} bytes).`)
    case 'empty':
      return t('本文が空です', 'The message is empty.')
  }
}

/** Send. Success does not guarantee "it was queued" (confirm via the transcript's queue-operation) */
export async function sendToSession(
  dirs: ConfigDir[],
  sessionId: string,
  text: string,
): Promise<SendResult> {
  const bad = validateText(text)
  if (bad) return { ok: false, reason: bad, message: failureMessage(bad) }

  const target = await findTarget(dirs, sessionId)
  if ('reason' in target) {
    return { ok: false, reason: target.reason, message: failureMessage(target.reason) }
  }
  const token = await readPeerToken(target.sessionsDir, target.pid, target.socketPath)
  return writeToSocket(target.socketPath, buildLines(text, { token }))
}
