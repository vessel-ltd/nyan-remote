// ★★ The endpoint that runs slash commands from the table (`/compact` / `/exit`) — HANDOFF 5.0-w.
//
// ## Why "a table + a dedicated endpoint"
//
// Free text (`/sessions/:id/message`) delivers a body starting with `/` or `!` **with one space prepended**,
// as plain text (= it never runs as a command). Break that and the phone's input box becomes
// **the TUI's command line** (`/exit` and `!rm` could both be typed).
// ⇒ What may run is **enumerated in a table**, and runs **only through this endpoint**.
//
// ## What this endpoint guards (⚠️ all by structure, not by branches)
//
//   1. ⚠️⚠️ **Take no characters from the body.** Only `id` is received; the characters sent
//      live in the agent-side table (`SLASH_COMMANDS`) (same reason approvals never accept `updatedInput`)
//   2. ⚠️⚠️ **Never fall back to the inbox.** This file does **not know** `inbox.ts`. A `/compact` that lands there
//      is **executed** by the receiving model as "a request from a peer" (measured 2026-08-24)
//   3. Refuse while an approval card is shown (the input is passed from here; `keys.ts` has no default for it)
//   4. ⚠️ Also refuse while the CLI shows a dialog and waits (`findPane` returns `waiting`)
//   5. ⚠️ **Confirmation is on the UI side** (the agent cannot confirm). `/exit` is **irreversible**
//      (the session disappears = pending approvals disappear too), so the wording is in `web/src/ui/commands.ts`
//
// ⚠️ Authentication goes through the single place in index.ts (auth.ts). Do not look at identity here (CLAUDE.md discipline 3).
// ⚠️ Being POST, it rides the existing Origin check (CSRF). **Never register it as GET**
//    (merely getting someone to follow a link could end another person's session).

import { SLASH_COMMANDS, sendCommandToSession, type CommandFailure } from '../claude/keys.ts'
import { discoverConfigDirs } from '../claude/configDirs.ts'
import type { CommandId, CommandResult } from '../../../shared/types.ts'
import { config } from '../config.ts'
import { broadcast } from '../events.ts'
import { hasPendingForSession } from '../permission.ts'
import { HttpError, readJsonBody, type Ctx } from '../router.ts'
import { t } from '../../../shared/i18n.ts'

/**
 * Failure category → HTTP. ★ It is a `Record<CommandFailure, number>`, so **a new reason fails the type check**.
 * ⚠️ The body text is built by `commandMessage` in `keys.ts` (do not write wording in two places).
 */
export const COMMAND_STATUS: Record<CommandFailure, number> = {
  // The other side's state (wait / look at the PC). ⇒ pressing again may succeed
  'pending-approval': 409,
  waiting: 409,
  'no-relay': 409,
  broken: 409,
  unverified: 409,
  ambiguous: 409,
  // ★ Rapid repeats (operations that poke the TUI: once per 1.5 s)
  'too-soon': 429,
  // That session no longer exists
  'not-found': 404,
  // The relay (window) does not respond / was cut off midway
  unreachable: 502,
  partial: 502,
}

/**
 * ★★ Extract `id` from the received body. **This is the only entry point.**
 *
 * ⚠️⚠️ Never pass `body.id` through as a string (that would make it
 *    "an endpoint where the phone can type any command"). Match it against the table's keys and
 *    **narrow it to `CommandId` before** passing it on.
 * ⚠️⚠️ **Take the whole body** (codex 2026-08-25, medium #1 / low #2). Two reasons:
 *    1. `body.id` **picks up inherited properties**. If `Object.prototype.id` is polluted,
 *       **an empty JSON `{}` becomes `/exit`** (reproduced). ⇒ require `Object.hasOwn`
 *    2. If the body is `null` (`JSON.parse('null')`), `body.id` is a **TypeError → 500**.
 *       ⇒ check "is it an object" here first (return 400)
 * ⚠️ Surrounding whitespace is **neither added nor trimmed** (`' compact '` is not in the table, so it is refused).
 */
export function toCommandId(body: unknown): CommandId | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  if (!Object.hasOwn(body, 'id')) return undefined
  const raw = (body as { id: unknown }).id
  if (typeof raw !== 'string') return undefined
  return Object.hasOwn(SLASH_COMMANDS, raw) ? (raw as CommandId) : undefined
}

export async function sessionCommand(ctx: Ctx): Promise<CommandResult> {
  const sessionId = ctx.params['id']
  if (!sessionId) throw new HttpError(400, t('session id が必要です', 'A session id is required.'))
  // ⚠️ Only the **id** is read from the body (the characters sent live in the table)
  const body = await readJsonBody<unknown>(ctx.req)
  const id = toCommandId(body)
  if (!id) throw new HttpError(400, t('知らないコマンドです', 'Unknown command.'))

  const dirs = await discoverConfigDirs(config().configDirs)
  const res = await sendCommandToSession(dirs, sessionId, id, {
    // ⚠️ **Pass a function** (a value read once goes stale; make it re-read after resolving the destination)
    hasPendingApproval: () => hasPendingForSession(sessionId),
  })
  if (!res.ok) {
    // ⚠️⚠️ Never fall back to the inbox here (point 2 above). **Return the reason and stop**
    const status = res.reason ? COMMAND_STATUS[res.reason] : 500
    throw new HttpError(status, res.message ?? t('実行できませんでした', 'Could not run the command.'))
  }
  // ★ Running it changes state (`/exit` removes it from the list). Make clients refetch
  const at = new Date().toISOString()
  broadcast({ type: 'sessions-changed', at })
  console.log(t(`[command] ${SLASH_COMMANDS[id]} を送りました session=${sessionId.slice(0, 8)}`, `[command] Sent ${SLASH_COMMANDS[id]} session=${sessionId.slice(0, 8)}`))
  return { ok: true, at, id }
}
