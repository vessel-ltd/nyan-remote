// The endpoint that toggles auto-approve mode (`POST /sessions/:id/auto-approve`).
//
// ★ Why a dedicated endpoint: for the same reason as the `/command` table, it is **an endpoint that can fire only this operation**.
//   ⚠️ Authentication goes through the single place in index.ts (`auth.ts`). Do not look at identity here (discipline 3).
//   ⚠️ Being POST, it rides the existing Origin check (CSRF). **Never register it as GET**
//      (merely getting someone to follow a link would put another person's session on auto-approve).
//
// ⚠️⚠️ **Confirmation is the UI's responsibility** (the agent cannot confirm). This operation creates a state that
//   passes even arbitrary `Bash` commands, so the wording lives in one place: `web/src/ui/commands.ts`.

import { hostname } from 'node:os'
import { notificationText, type AutoApproveResult, type PushPayload } from '../../../shared/types.ts'
import { AUTO_APPROVE_DEFAULT, type AutoApproveEntry, setAutoApprove, toAutoApproveDuration } from '../autoApprove.ts'
import { broadcast } from '../events.ts'
import { withPendingPerms } from '../permission.ts'
import { sendToAll } from '../push.ts'
import { threadUrl } from '../pushUrl.ts'
import { HttpError, readJsonBody, type Ctx } from '../router.ts'
import { t } from '../../../shared/i18n.ts'

interface Body {
  on?: unknown
  /** ★ The duration's name (`'3h'` / `'24h'`). ⚠️ No length is accepted (the agent's table owns it) */
  duration?: unknown
}

export async function sessionAutoApprove(ctx: Ctx): Promise<AutoApproveResult> {
  const sessionId = ctx.params['id']
  if (!sessionId) throw new HttpError(400, t('session id が必要です', 'A session id is required.'))
  const body = await readJsonBody<Body>(ctx.req)
  // ⚠️⚠️ **Never silently interpret non-booleans** (turning `'false'` or `0` into "on" does
  //    the opposite of what the user meant. This is the only entry that can fall toward the dangerous side)
  if (body.on !== true && body.on !== false) {
    throw new HttpError(400, t('on は true か false です', '`on` must be true or false.'))
  }
  // ★★ The duration is received by **name**. If absent, 3 hours as before (old UI).
  //   ⚠️⚠️ **Unknown names are refused** (no default fallback: silently turning `'72h'` into 3 hours leaves the UI saying 72 hours)
  let duration = AUTO_APPROVE_DEFAULT
  if (body.duration !== undefined) {
    const d = toAutoApproveDuration(body.duration)
    if (!d) throw new HttpError(400, t('期限は 3h か 24h です', '`duration` must be 3h or 24h.'))
    duration = d
  }
  const res = await setAutoApprove(sessionId, body.on, Date.now(), duration)
  // ★ The list's marker (`SessionSummary.autoApprove`) changes, so announce it
  broadcast({ type: 'sessions-changed', at: new Date().toISOString() })
  if (!res.ok) return { ok: false, reason: res.reason, saved: res.saved }
  return { ok: true, ...(res.entry ? { until: res.entry.until } : {}), saved: true }
}

/**
 * ★★ Announce that it turned off automatically at expiry (just one notification).
 *
 * ⚠️ Why: if you forget it is on, you leave it thinking "it's still auto-passing".
 *    **Approvals stop the moment it expires**, so that is worth announcing.
 * ⚠️⚠️ Conversely, **do not send one per auto-passed approval** (iPhone ignores tag replacement, so they
 *    just pile up / CLAUDE.md §2).
 * ⚠️ Only identifiers and fixed vocabulary are included (§6.2). ⚠️ Always include `at`
 *    (adding `pendingPerms` to a payload without it breaks ordering in the sw).
 */
export const AUTO_APPROVE_OFF_LABEL = '自動承認 終了'

export function autoApproveOffPayload(entry: AutoApproveEntry, machine = hostname()): PushPayload {
  const text = notificationText({
    title: '',
    titleSource: 'fallback',
    sessionId: entry.id,
    project: '—',
    machine,
    account: '',
    label: AUTO_APPROVE_OFF_LABEL,
  })
  return {
    title: text.title,
    body: text.body,
    // ★ One slot per session (if the same session expires twice, replacing is fine)
    tag: `auto-approve:${machine}:${entry.id}`,
    url: threadUrl(entry.id),
    event: 'AutoApproveExpired',
    at: entry.until,
  }
}

export async function notifyAutoApproveExpired(entry: AutoApproveEntry): Promise<void> {
  try {
    const res = await sendToAll(withPendingPerms(autoApproveOffPayload(entry)))
    console.log(t(`[auto] 期限切れを通知 push=${res.sent} session=${entry.id.slice(0, 8)}`, `[auto] Notified expiry push=${res.sent} session=${entry.id.slice(0, 8)}`))
  } catch (err) {
    console.warn(t('[auto] 期限切れの通知に失敗: ', '[auto] Failed to notify expiry: ') + (err instanceof Error ? err.message : String(err)))
  }
}
