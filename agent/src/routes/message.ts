// Send text from the phone to a running session (M4-2 / ARCHITECTURE.md §9.10, §9.7.2).
//
// ⚠️ Authentication goes through the single place in index.ts (auth.ts). Do not look at identity here (CLAUDE.md discipline 3).
// ⚠️ Being POST, it rides the existing Origin check (CSRF) as is.
// ⚠️ No notification is sent. You sent it yourself so it is pointless, and there is
//    no reason to edge toward §6.2 "never put conversation content in notification bodies".
//
// ## There are two routes (2026-08-22)
//
//   keystrokes (keys.ts) … only sessions started through the relay. **No English frame is added**
//   inbox (inbox.ts) … reaches any session, but **the receiver adds a peer frame**
//
// ★ **Try keystrokes first; if that fails, fall back to the inbox** (a frame is better than not arriving).
// ⚠️⚠️ But **never fall back on `partial` (typed part-way)**, because it would arrive twice.
// ★★★ A body starting with `/` or `!` is **refused on every route** (2026-11-10 / see `sanitizeForKeys`).
//   ⚠️⚠️ Keystrokes: Claude Code 2.1.322 trims before looking for `/`, so the old "one leading space" ran it.
//   ⚠️⚠️ Inbox: the receiving model **executes it** as "a request from a peer" (measured: `/tes` ran make test).
//   ⇒ Nothing falls back to the inbox because of its content.

import { commandLikeMessage, typedForm, type MessageSendResult } from '../../../shared/types.ts'
import { config } from '../config.ts'
import { discoverConfigDirs } from '../claude/configDirs.ts'
import { failureMessage, sendToSession, validateText } from '../claude/inbox.ts'
import { codexInput, isCodexSessionId, type CodexSendResult } from '../codex/daemon.ts'
import { userText } from '../codex/history.ts'
import { shortSessionId } from '../codex/ids.ts'
import { codexLists, codexSend } from '../codex/run.ts'
import { sanitizeForKeys, sendKeysToSession, type KeysFailure } from '../claude/keys.ts'
import { broadcast } from '../events.ts'
import { hasPendingForSession } from '../permission.ts'
import { HttpError, readJsonBody, type Ctx } from '../router.ts'
import { ownerOf } from '../auth.ts'
import { attachmentLines, UploadError, uploads, type Attachment, type Reserved } from '../uploads.ts'
import { t } from '../../../shared/i18n.ts'
import { AGY_SEND_REFUSAL, sendToAgy } from '../agy/keys.ts'
import { AGY_PREFIX, conversationOf } from '../agy/sessions.ts'

interface Body {
  text?: unknown
  /** ★ Ids of files this device uploaded (`POST /uploads` … / `uploads.ts`). ⚠️ Ids only: the paths are the agent's */
  attachments?: unknown
}

/**
 * ★ The instruction with its files (2026-11-17). The files are named **before** the person's text (`attachmentLines`).
 * ⚠️ The person's own text is judged on its own first: `/` `!` at its start stays refused, even behind the file lines.
 */
export function withAttachments(text: string, files: readonly Attachment[]): string {
  if (files.length === 0) return text
  if (inboxRefusal(text)) throw new HttpError(400, commandLikeMessage())
  const said = text.trim() === '' ? t('添付したファイルを見てください。', 'Please look at the attached files.') : text
  return `${attachmentLines(files)}${said}`
}

/** ★ This device's files for this send, reserved (single use / `uploads.ts` rule 8) */
function reserveFiles(ctx: Ctx, ids: unknown): Reserved {
  try {
    return uploads.reserve(ownerOf(ctx.identity), ids)
  } catch (e) {
    if (e instanceof UploadError) throw new HttpError(e.status, e.message)
    throw e
  }
}

/** ★ The type lives in one place, `shared/types.ts` (so it never disagrees with the UI) */
export type MessageResult = MessageSendResult

/**
 * When keystrokes fail, decide **whether it may fall back to the inbox**.
 *
 * ⚠️⚠️ **Never fall back on `partial`** (a part-typed instruction would arrive twice).
 * ★ Why this is in one place: write "reasons it may fall back" in two places and,
 *   when a new reason is added, **it falls to the dangerous side** (we made the same mistake with the notification decision).
 */
export type RouteDecision =
  | { kind: 'fallback' } // fall back to the inbox (a frame is added, but it arrives)
  | { kind: 'error'; status: number } // caller's mistake / abort

export function decideAfterKeys(reason: KeysFailure | undefined): RouteDecision {
  switch (reason) {
    // ⚠️ Something already partly typed would arrive twice, so abort
    case 'partial':
      return { kind: 'error', status: 500 }
    // If the body itself is bad, the inbox gives the same result
    case 'empty':
    case 'too-long':
    // ⚠️⚠️ Starts with `/` `!`: the inbox is **worse** (the receiving model runs it as a peer's request)
    case 'command-like':
      return { kind: 'error', status: 400 }
    // ★ A long text this session's relay cannot take as a paste yet: said so (restart claude), not sent another way
    case 'long-needs-paste':
      return { kind: 'error', status: 409 }
    // Below here, "keystrokes were unavailable" only, so go to the inbox
    case 'pending-approval':
    // ★ The CLI shows a dialog and waits (`status:'waiting'`) → inbox.
    //   ⚠️ In the inbox it **does not become key input** (it is just queued as a framed message)
    case 'waiting':
    case 'not-found':
    case 'no-relay':
    case 'broken':
    case 'unverified':
    case 'ambiguous':
    case 'unreachable':
    case undefined:
      return { kind: 'fallback' }
  }
}

/**
 * ★★ **Is this a body that must not go to the inbox?** (codex 2026-08-24, high #2).
 *
 * ⚠️⚠️ Keystrokes can fail for route reasons **before** the body is looked at
 *    (`pending-approval` is checked first), and then it falls back to the inbox. What went there was
 *    **the original text**, so the receiving model executed it (measured: a `/tes` that fell into the
 *    inbox ran `make test`). ⇒ This guard is reachable and must stay.
 * ★ The decision uses `sanitizeForKeys`'s answer (do not write the leading-character check in two places).
 */
export function inboxRefusal(text: unknown): boolean {
  const clean = sanitizeForKeys(text)
  return !clean.ok && clean.reason === 'command-like'
}

/**
 * ★★ Send to a Codex thread (2026-11-15 / docs/CODEX.md §5.2). `undefined` when the id is not a Codex row.
 *
 * The text becomes a new turn on the daemon (`turn/start`): no keystrokes, no inbox, no frame.
 * ⚠️⚠️ The body is checked **before** the daemon is asked, and a body starting with `/` or `!` is refused like on
 *    every other route. Here nothing would run it (it would reach the model as plain words), but the phone must not
 *    learn that "a slash works on some rows".
 * ⚠️ Only an idle thread takes it. Working or waiting ⇒ 409 (adding to a running turn is not built).
 * ⚠️ The log line carries the length, never the text.
 */
export async function codexMessage(
  sessionId: string,
  text: string,
  /** ★ Injected in tests */
  codex: { lists(id: string): boolean; send(id: string, text: string, images?: readonly string[]): Promise<CodexSendResult | undefined> } = {
    lists: codexLists,
    send: codexSend,
  },
  /** ★ Files with it (`uploads.ts`): images as `localImage`, the others named in the text */
  files: readonly Attachment[] = [],
): Promise<MessageResult | undefined> {
  if (!codex.lists(sessionId)) {
    // ⚠️ A Codex row id that no line lists now (the thread closed, the line is down) is "not open" — never handed to
    //    the Claude routes (codex review, high #1: the two kinds of id must not mix)
    if (isCodexSessionId(sessionId)) throw new HttpError(409, t('この Codex のセッションは、いま開かれていません。', 'This Codex session is not open right now.'))
    return undefined
  }
  if (inboxRefusal(text)) throw new HttpError(400, commandLikeMessage())
  const images = files.filter((f) => f.kind === 'image').map((f) => f.path)
  const others = files.filter((f) => f.kind !== 'image')
  text = withAttachments(text, others)
  if (images.length > 0 && others.length === 0 && text.trim() === '') text = t('添付した画像を見てください。', 'Please look at the attached images.')
  const bad = validateText(text)
  if (bad) throw new HttpError(400, failureMessage(bad))
  const short = shortSessionId(sessionId)
  // ⚠️ The row can vanish between the two looks: that is "not open", never a fall-through to the Claude routes
  const res: CodexSendResult = (await codex.send(sessionId, text, images)) ?? { ok: false, reason: 'not-listed' }
  if (!res.ok) {
    console.log(`[codex] not sent thread=${short} reason=${res.reason}${res.detail ? ` (${res.detail})` : ''}`)
    switch (res.reason) {
      case 'busy':
        throw new HttpError(
          409,
          t(
            'Codex が応答中か、承認を待っています。終わってから送ってください。',
            'Codex is working or waiting for an approval. Send again when it has finished.',
          ),
        )
      case 'not-listed':
        throw new HttpError(409, t('この Codex のセッションは、いま開かれていません。', 'This Codex session is not open right now.'))
      case 'failed':
        throw new HttpError(409, t('Codex に送れませんでした。PC の画面を確認してください。', 'Could not send to Codex. Check the screen on the PC.'))
    }
  }
  const at = new Date().toISOString()
  broadcast({ type: 'sessions-changed', at })
  console.log(`[codex] sent to thread=${short} ${text.length} chars`)
  // ★ `keys`: in the thread it has the same shape as a keystroke send — a plain message of the person, no `via`
  //   (`web/src/ui/pending.ts` matches the sent bubble by this; an unknown value would never match).
  // ★ As the thread will show it (the same function the history uses: images become `[localImage]` lines)
  return { ok: true, at, route: 'keys', ...(files.length > 0 ? { delivered: userText(codexInput(text, images)) } : {}) }
}

export async function sessionMessage(ctx: Ctx): Promise<MessageResult> {
  const sessionId = ctx.params['id']
  if (!sessionId) throw new HttpError(400, t('session id が必要です', 'A session id is required.'))
  const body = await readJsonBody<Body>(ctx.req)
  const said = typeof body.text === 'string' ? body.text : ''
  // ★ Files with it: this device's finished uploads, reserved for this send (a concurrent send cannot use them too).
  //   Taken once the send went through; a failed send releases them for the retry
  const reserved = reserveFiles(ctx, body.attachments)
  try {
    const res = await deliver(sessionId, said, reserved.files)
    reserved.consume()
    return res
  } finally {
    reserved.release()
  }
}

/**
 * ★★ Send to an agy conversation (2026-11-20 / docs/AGY.md §8). `undefined` when the id is not an agy row.
 *
 * Typed into the agy TUI through its relay (`agy/keys.ts`), only while it is idle. ⚠️ Never another route: agy has no
 * inbox, and an `agy-` id must never reach the Claude routes. ⚠️ No files yet (agy would need an approval to read a
 * file outside its workspace). ⚠️ The log line carries the length, never the text.
 */
export async function agyMessage(
  sessionId: string,
  text: string,
  files: readonly Attachment[] = [],
  send: typeof sendToAgy = sendToAgy,
): Promise<MessageResult | undefined> {
  if (!sessionId.startsWith(AGY_PREFIX)) return undefined
  const conversationId = conversationOf(sessionId)
  if (!conversationId) throw new HttpError(...AGY_SEND_REFUSAL['not-open']())
  if (files.length > 0) throw new HttpError(400, t('agy にはまだファイルを送れません。', 'Files cannot be sent to agy yet.'))
  const res = await send(conversationId, text)
  const short = conversationId.slice(0, 8)
  if (!res.ok) {
    console.log(`[agy] not sent conversation=${short} reason=${res.reason}`)
    throw new HttpError(...AGY_SEND_REFUSAL[res.reason ?? 'unreachable']())
  }
  const at = new Date().toISOString()
  broadcast({ type: 'sessions-changed', at })
  console.log(`[agy] typed into conversation=${short} ${text.length} chars`)
  // ★ `delivered` = what agy records (it trims the request), so the phone's "sending" line clears
  return { ok: true, at, route: 'keys', ...(res.recorded !== undefined && res.recorded !== text ? { delivered: res.recorded } : {}) }
}

async function deliver(sessionId: string, said: string, files: readonly Attachment[]): Promise<MessageResult> {
  // ★ A Codex thread goes to its daemon (`codexMessage`); `undefined` = not a Codex row, so the Claude routes follow
  const viaCodex = await codexMessage(sessionId, said, undefined, files)
  if (viaCodex) return viaCodex
  // ★ An agy conversation is typed into its TUI (`agyMessage`); never the Claude routes
  const viaAgy = await agyMessage(sessionId, said, files)
  if (viaAgy) return viaAgy
  // ★ Claude reads a file given by its path in the text (measured: images and PDF, with its own Read tool)
  const text = withAttachments(said, files)

  const dirs = await discoverConfigDirs(config().configDirs)
  const short = sessionId.slice(0, 8)

  // ★ Keystrokes first. ⚠️ Whether an approval card is shown is **checked here and passed in** (keys.ts has no default)
  const keys = await sendKeysToSession(dirs, sessionId, text, {
    // ⚠️ **Pass a function** (a value read once goes stale; make it re-read before the body and before the CR)
    hasPendingApproval: () => hasPendingForSession(sessionId),
  })
  if (keys.ok) {
    const at = new Date().toISOString()
    broadcast({ type: 'sessions-changed', at })
    const extra = keys.dropped ? t(` 制御文字を${keys.dropped}個落とした`, ` dropped ${keys.dropped} control characters`) : ''
    console.log(
      t(
        `[keys] 打鍵で送りました session=${short} ${text.length}文字${extra}`,
        `[keys] Sent as keystrokes session=${short} ${text.length} chars${extra}`,
      ),
    )
    // ★ What the TUI got: attachment lines added, and the keystroke form (tabs as spaces, controls dropped / codex review)
    const typed = typedForm(text).text
    return { ok: true, at, route: 'keys', ...(typed !== said ? { delivered: typed } : {}) }
  }
  const decision = decideAfterKeys(keys.reason)
  if (decision.kind === 'error') throw new HttpError(decision.status, keys.message ?? t('送れませんでした', 'Could not send.'))
  // ⚠️⚠️ Never hand a body starting with `/` or `!` to the inbox (see `inboxRefusal` above)
  if (inboxRefusal(text)) {
    console.log(
      t(
        `[keys] 受信箱には渡さない（先頭が / か !） session=${short} 理由=${keys.reason}`,
        `[keys] Not handing to the inbox (starts with / or !) session=${short} reason=${keys.reason}`,
      ),
    )
    throw new HttpError(400, commandLikeMessage())
  }
  console.log(t(`[keys] 打鍵は使えません（${keys.reason}）→ 受信箱へ session=${short}`, `[keys] Keystrokes unavailable (${keys.reason}) → inbox session=${short}`))

  const result = await sendToSession(dirs, sessionId, text)
  if (!result.ok) {
    // ★ Split the status by reason. The UI shows the message as is
    //   400 = sent the wrong way (fixable) / 409 = the other side's state (wait or open it on the PC)
    const status = result.reason === 'empty' || result.reason === 'too-long' ? 400 : 409
    throw new HttpError(status, result.message ?? t('送れませんでした', 'Could not send.'))
  }

  // Make clients refetch the transcript right after sending (the queue-operation appears tens of ms later)
  const at = new Date().toISOString()
  broadcast({ type: 'sessions-changed', at })
  console.log(t(`[inbox] メッセージを送りました session=${short} ${text.length}文字`, `[inbox] Sent a message session=${short} ${text.length} chars`))
  return { ok: true, at, route: 'inbox', ...(files.length > 0 ? { delivered: text } : {}) }
}
