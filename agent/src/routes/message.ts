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

import { commandLikeMessage, type MessageSendResult } from '../../../shared/types.ts'
import { config } from '../config.ts'
import { discoverConfigDirs } from '../claude/configDirs.ts'
import { failureMessage, sendToSession, validateText } from '../claude/inbox.ts'
import { isCodexSessionId, type CodexSendResult } from '../codex/daemon.ts'
import { shortSessionId } from '../codex/ids.ts'
import { codexLists, codexSend } from '../codex/run.ts'
import { sanitizeForKeys, sendKeysToSession, type KeysFailure } from '../claude/keys.ts'
import { broadcast } from '../events.ts'
import { hasPendingForSession } from '../permission.ts'
import { HttpError, readJsonBody, type Ctx } from '../router.ts'
import { t } from '../../../shared/i18n.ts'

interface Body {
  text?: unknown
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
  codex: { lists(id: string): boolean; send(id: string, text: string): Promise<CodexSendResult | undefined> } = {
    lists: codexLists,
    send: codexSend,
  },
): Promise<MessageResult | undefined> {
  if (!codex.lists(sessionId)) {
    // ⚠️ A Codex row id that no line lists now (the thread closed, the line is down) is "not open" — never handed to
    //    the Claude routes (codex review, high #1: the two kinds of id must not mix)
    if (isCodexSessionId(sessionId)) throw new HttpError(409, t('この Codex のセッションは、いま開かれていません。', 'This Codex session is not open right now.'))
    return undefined
  }
  const bad = validateText(text)
  if (bad) throw new HttpError(400, failureMessage(bad))
  if (inboxRefusal(text)) throw new HttpError(400, commandLikeMessage())
  const short = shortSessionId(sessionId)
  // ⚠️ The row can vanish between the two looks: that is "not open", never a fall-through to the Claude routes
  const res: CodexSendResult = (await codex.send(sessionId, text)) ?? { ok: false, reason: 'not-listed' }
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
  return { ok: true, at, route: 'keys' }
}

export async function sessionMessage(ctx: Ctx): Promise<MessageResult> {
  const sessionId = ctx.params['id']
  if (!sessionId) throw new HttpError(400, t('session id が必要です', 'A session id is required.'))
  const body = await readJsonBody<Body>(ctx.req)
  const text = typeof body.text === 'string' ? body.text : ''

  // ★ A Codex thread goes to its daemon (`codexMessage`); `undefined` = not a Codex row, so the Claude routes follow
  const viaCodex = await codexMessage(sessionId, text)
  if (viaCodex) return viaCodex

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
    return { ok: true, at, route: 'keys' }
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
  return { ok: true, at, route: 'inbox' }
}
