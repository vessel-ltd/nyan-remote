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
// ★★ A body starting with `/` or `!` goes through **keystrokes "with one space prepended"** (changed 2026-08-24).
//   ⚠️⚠️ It used to be refused and dropped into the inbox, but the inbox **does more than add a frame**:
//      the receiving model **executes it** as "a request from a peer" (measured: `/tes` ran make test).
//      And even **ordinary sentences** like "look at /home/..." were being dropped there.
//   ⇒ Nothing falls back to the inbox because of its content any more.

import type { MessageSendResult } from '../../../shared/types.ts'
import { config } from '../config.ts'
import { discoverConfigDirs } from '../claude/configDirs.ts'
import { sendToSession } from '../claude/inbox.ts'
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
      return { kind: 'error', status: 400 }
    // Below here, "keystrokes were unavailable" only, so go to the inbox
    // ⚠️ `slash` / `bang` **no longer occur** (2026-08-24). Instead of refusing, we now
    //    **neutralize with one space and pass via keystrokes** (see `sanitizeForKeys`).
    //    ⇒ There is no longer a path that "falls back to the inbox because of content" (only route constraints remain).
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
 * ⚠️⚠️ Keystrokes are now neutralized with "one leading space", but **when keystrokes fail for route
 *    reasons** (`no-relay` / `waiting` / `pending-approval` / `unreachable`) it falls back to the inbox.
 *    What went there was **the original text**, so the accident of the receiving model executing it **was still
 *    there** (measured: a `/tes` that fell into the inbox ran `make test`).
 *    ⇒ **We wrote "fixed", but the same thing remained on another path** (mistake pattern 3 in VERIFY).
 *
 * ⚠️ Prepending a space and sending to the inbox is **not OK**: the space only disables **the CLI's command parsing**;
 *    **the model's interpretation remains** (the frame reads as "a request from a peer", so it tends to get executed).
 * ⇒ Instead of falling back, **refuse** (the UI shows how to rephrase).
 * ★ The decision uses `sanitizeForKeys`'s answer (do not write the leading-character check in two places;
 *   they actually disagreed on invisible characters).
 */
export function inboxRefusal(text: unknown): boolean {
  const clean = sanitizeForKeys(text)
  return clean.ok && clean.value.neutralized === true
}

export async function sessionMessage(ctx: Ctx): Promise<MessageResult> {
  const sessionId = ctx.params['id']
  if (!sessionId) throw new HttpError(400, t('session id が必要です', 'A session id is required.'))
  const body = await readJsonBody<Body>(ctx.req)
  const text = typeof body.text === 'string' ? body.text : ''

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
    // ★ Also log that it was neutralized (⚠️ never log the body)
    const neu = keys.neutralized
      ? t(' 先頭に空白を足した（コマンドとして走らせない）', ' prefixed a space (so it does not run as a command)')
      : ''
    console.log(
      t(
        `[keys] 打鍵で送りました session=${short} ${text.length}文字${extra}${neu}`,
        `[keys] Sent as keystrokes session=${short} ${text.length} chars${extra}${neu}`,
      ),
    )
    return { ok: true, at, route: 'keys', ...(keys.neutralized ? { neutralized: true } : {}) }
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
    throw new HttpError(
      409,
      t('このセッションはいま枠なしで渡せないため、`/` や `!` で始まる文は送れません（受け取った側が「別セッションからの依頼」として実行してしまうため）。言葉で頼むか、先頭に語を足してください（例:「パス /home/... を見て」）', 'This session cannot receive direct keystrokes right now, so messages starting with `/` or `!` cannot be sent (the receiver would run them as a request from another session). Phrase it in words, or add a word in front (e.g. "look at the path /home/...").'),
    )
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
