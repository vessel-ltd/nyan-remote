// ★★ The "stop" (ESC) endpoint — item 1 of HANDOFF "the holes left by not owning the session".
//
// ## Why a dedicated endpoint
//
// Keystrokes (`/sessions/:id/message`) are an endpoint for **text**, and `sanitizeForKeys` drops control characters.
// ESC cannot pass through it (if it did, **it would move the choice dialog**). So "stop" is sent
// **as a key, not as text**, and **only from this endpoint**.
//
// ## What this endpoint guards (⚠️ all by structure, not by branches)
//
//   1. ⚠️⚠️ **Never read the body.** The bytes sent are fixed in `CONTROL_KEYS` and cannot be chosen from the UI
//      (same reason approvals never accept `updatedInput`. An endpoint that lets you pick bytes
//      becomes "an endpoint that remote-controls the TUI")
//   2. ⚠️⚠️ **Never fall back to the inbox.** This file does **not know** `inbox.ts`.
//      Falling back would put "stop" **into the conversation as an instruction** (it would not stop, and would pollute the context)
//   3. Refuse while an approval card is shown (ESC closes the dialog = it becomes **an unrequested denial**).
//      The input is passed from here; `keys.ts` has no default for it
//   4. ⚠️ Also refuse while the CLI shows a dialog and waits (`findPane` returns `waiting`)
//
// ⚠️ Authentication goes through the single place in index.ts (auth.ts). Do not look at identity here (CLAUDE.md discipline 3).
// ⚠️ Being POST, it rides the existing Origin check (CSRF) as is. **Never register it as GET**
//    (merely getting someone to follow a link could stop another person's session).

import type { InterruptResult } from '../../../shared/types.ts'
import { config } from '../config.ts'
import { discoverConfigDirs } from '../claude/configDirs.ts'
import { sendControlToSession, sendStopToSession, type ControlFailure } from '../claude/keys.ts'
import { broadcast } from '../events.ts'
import { hasPendingForSession } from '../permission.ts'
import { HttpError, type Ctx } from '../router.ts'
import { t } from '../../../shared/i18n.ts'

/**
 * Failure category → HTTP.
 *
 * ★ It is a `Record<ControlFailure, number>`, so **a new reason fails the type check**
 *   (lesson from writing the notification decision in two places, where 65 of 96 combinations disagreed / HANDOFF 5.0-o).
 * ⚠️ The body text is built by `failureMessage` in `keys.ts` (do not write wording in two places).
 */
export const INTERRUPT_STATUS: Record<ControlFailure, number> = {
  // The other side's state (wait / look at the PC). ⇒ pressing again may succeed
  'pending-approval': 409,
  waiting: 409,
  'no-relay': 409,
  broken: 409,
  unverified: 409,
  ambiguous: 409,
  // ★ Rapid repeats (refused because ESC twice opens the "go back" screen)
  'too-soon': 429,
  // That session no longer exists
  'not-found': 404,
  // The relay (window) does not respond
  unreachable: 502,
}

/**
 * ★★ **Clear the PC's input box** (Ctrl-U / 2026-08-25).
 *
 * Why: **if you press "stop" mid-response, the CLI puts what was typed back into the input box**, so
 * stopping `/compact` leaves `/compact` there and **the next keystrokes get concatenated to it** (confirmed on a real device).
 *
 * ⚠️⚠️ **Never read the body** (same as `sessionInterrupt`; the key sent is fixed here).
 * ⚠️ **Why the endpoints are separate**: this one also keeps "bytes are never chosen from the UI"
 *    (passing a `key` to a single endpoint would make **an endpoint that can fire anything in the table**).
 * ⚠️ It also clears **a draft the person at the PC was typing**. So the confirmation is shown on the UI side
 *    (`web/src/ui/commands.ts`).
 */
export async function sessionClear(ctx: Ctx): Promise<InterruptResult> {
  const sessionId = ctx.params['id']
  if (!sessionId) throw new HttpError(400, t('session id が必要です', 'A session id is required.'))
  // ⚠️⚠️ **Never read the body**. Only `'clear'` is sent

  const dirs = await discoverConfigDirs(config().configDirs)
  const res = await sendControlToSession(dirs, sessionId, 'clear', {
    // ⚠️ **Pass a function** (a value read once goes stale)
    hasPendingApproval: () => hasPendingForSession(sessionId),
  })
  if (!res.ok) {
    // ⚠️⚠️ Never fall back to the inbox here (this endpoint does not know `inbox.ts` either)
    const status = res.reason ? INTERRUPT_STATUS[res.reason] : 500
    throw new HttpError(status, res.message ?? t('入力欄を消せませんでした', 'Could not clear the input box.'))
  }
  // ★ The input box's contents are not shown in the list, so `sessions-changed` is not broadcast (avoid needless refetches)
  const at = new Date().toISOString()
  // ⚠️ Do not write "cleared" (all we know is **that the relay window received it** / codex round 7, low #1)
  console.log(t(`[control] Ctrl-U を送りました session=${sessionId.slice(0, 8)}`, `[control] Sent Ctrl-U session=${sessionId.slice(0, 8)}`))
  return { ok: true, at }
}

export async function sessionInterrupt(ctx: Ctx): Promise<InterruptResult> {
  const sessionId = ctx.params['id']
  if (!sessionId) throw new HttpError(400, t('session id が必要です', 'A session id is required.'))
  // ⚠️⚠️ **Never read the body** (point 1 above). Only `'escape'` is sent

  const dirs = await discoverConfigDirs(config().configDirs)
  // ★★ If it was mid-response, also clear the input box after stopping (`sendStopToSession` / 2026-09-24)
  const res = await sendStopToSession(dirs, sessionId, {
    // ⚠️ **Pass a function** (a value read once goes stale; make it re-read after resolving the destination)
    hasPendingApproval: () => hasPendingForSession(sessionId),
  })
  if (!res.ok) {
    // ⚠️⚠️ Never fall back to the inbox here (point 2 above). **Return the reason and stop**
    const status = res.reason ? INTERRUPT_STATUS[res.reason] : 500
    throw new HttpError(status, res.message ?? t('止められませんでした', 'Could not stop.'))
  }
  // ★ State changes right after stopping (responding → idle). Make the list and thread refetch
  const at = new Date().toISOString()
  broadcast({ type: 'sessions-changed', at })
  console.log(
    t(
      `[control] ESC を送りました${res.cleared ? '（続けて Ctrl-U）' : ''} session=${sessionId.slice(0, 8)}`,
      `[control] Sent ESC${res.cleared ? ' (then Ctrl-U)' : ''} session=${sessionId.slice(0, 8)}`,
    ),
  )
  return { ok: true, at, ...(res.cleared ? { cleared: true } : {}) }
}
