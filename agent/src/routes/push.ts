import type { PushStatus } from '../../../shared/types.ts'
import { asLang, currentLang, t } from '../../../shared/i18n.ts'
import { endpointTag } from '../../../shared/pushTag.ts'
import {
  addSubscription,
  hasSubscriptionFor,
  lastFailureForDevice,
  listSubscriptions,
  publicKey,
  removeSubscription,
  sendToAll,
  validateSubscription,
  type StoredSubscription,
} from '../push.ts'
import type { PushPayload } from '../../../shared/types.ts'
import { withPendingPerms } from '../permission.ts'
import { HttpError, readJsonBody, type Ctx } from '../router.ts'

/**
 * ★ **Show on screen** the reason when the key or subscription file is corrupt (external review 2026-08-14).
 *
 * ⚠️ Left as a plain `Error`, `index.ts` replaces it with `internal error`, so
 *    "why notifications do not work" becomes invisible from the phone (a comment claiming otherwise was wrong).
 *    Recovery needs the reason, so return it in the 503.
 */
async function orExplain<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof HttpError) throw err
    throw new HttpError(503, err instanceof Error ? err.message : String(err))
  }
}

export async function pushStatus(ctx: Ctx): Promise<PushStatus> {
  return orExplain(async () => {
    const subs = await listSubscriptions()
    // ★ Surface "subscribed but no notifications arrive" (a 403 does not delete the subscription, so it goes unnoticed)
    const lastFailure = await lastFailureForDevice(ctx.identity.deviceId)
    // ★★ **Markers for this device's endpoints** (codex round 13, high #3). `subscribed` means "any one at all", so
    //   even if registering the new endpoint failed, it was true while the old one remained, and **it was never resent**.
    // ★★ Call only **those registered in this screen's language** "registered" (2026-09-23).
    //   ⇒ Switching language on the phone makes it look "unregistered", and the PWA's existing re-registration (`planPush`) re-registers **in that language**.
    //   ⚠️ Records without a language (from before it was added) count as Japanese (no re-registration on a Japanese UI = no extra writes).
    const lang = currentLang()
    const endpointTags = await Promise.all(
      subs
        .filter((s) => s.deviceId === ctx.identity.deviceId && (asLang(s.lang) ?? 'ja') === lang)
        .map((s) => endpointTag(s.endpoint)),
    )
    return {
      publicKey: await publicKey(),
      subscribed: await hasSubscriptionFor(ctx.identity.deviceId),
      endpointTags,
      deviceCount: subs.length,
      ...(lastFailure ? { lastFailure } : {}),
    }
  })
}

interface SubscribeBody {
  endpoint?: string
  keys?: { p256dh?: string; auth?: string }
}

export async function pushSubscribe(ctx: Ctx): Promise<{ ok: true; deviceCount: number }> {
  const body = await readJsonBody<SubscribeBody>(ctx.req)
  const endpoint = body.endpoint
  const p256dh = body.keys?.p256dh
  const auth = body.keys?.auth
  // ★ Check down to the type. Back when only truthiness was checked, numbers and arrays could be saved;
  //   web-push then crashed on send, and `endpoint.slice()` in the catch crashed too, giving a 500
  if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') {
    throw new HttpError(400, t('endpoint と keys.p256dh / keys.auth（いずれも文字列）が必要です', '`endpoint` and `keys.p256dh` / `keys.auth` (all strings) are required.'))
  }
  const invalid = validateSubscription(endpoint, p256dh, auth)
  if (invalid) throw new HttpError(400, invalid)
  const ua = ctx.req.headers['user-agent']
  const sub: StoredSubscription = {
    endpoint,
    keys: { p256dh, auth },
    deviceId: ctx.identity.deviceId,
    login: ctx.identity.login,
    userAgent: typeof ua === 'string' ? ua.slice(0, 200) : undefined,
    createdAt: new Date().toISOString(),
    // ★ Keep the kind of identity (used to decide whether "one per device" may collapse them / codex round 14, medium #2)
    via: ctx.identity.via,
    // ★ Notification language = this request's language (the phone UI's language / `?lang=` in `serve.ts`)
    lang: currentLang(),
  }
  const deviceCount = await orExplain(() => addSubscription(sub))
  console.log(t(`[push] 購読を登録しました device=${sub.deviceId} 合計=${deviceCount}`, `[push] Registered a subscription device=${sub.deviceId} total=${deviceCount}`))
  return { ok: true, deviceCount }
}

export async function pushUnsubscribe(ctx: Ctx): Promise<{ ok: true }> {
  const body = await readJsonBody<{ endpoint?: string }>(ctx.req)
  if (!body.endpoint) throw new HttpError(400, t('endpoint が必要です', '`endpoint` is required.'))
  await orExplain(() => removeSubscription(body.endpoint as string))
  return { ok: true }
}

/** For connectivity checks. No conversation content is included (§6.2) */
/**
 * The connectivity-check payload. **Split out so tests can see it** (tests that pass hand-built values are a false green).
 *
 * ⚠️⚠️ Always include `at` (codex 2026-08-20, high #3). Without it the sw cannot decide the cleanup
 *    order (falling back to the device clock **removes live notifications**), and `withPendingPerms`
 *    does not attach the list either = **a cleanup opportunity is lost**.
 */
export function testPayload(now: Date, silent = false): PushPayload {
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return {
    title: 'nyan-remote',
    // ★ Make it obvious from the notification alone which one was sent (prevents mix-ups when measuring)
    body: `テスト通知${silent ? '（無音）' : '（音あり）'} ${hhmm}`,
    // ⚠️ **Use different tags** for with-sound / silent. With the same tag the later one replaces the earlier and
    //    **only one is visible, leading to a misdiagnosis of "not delivered"**
    tag: silent ? 'tmux-agent-test-silent' : 'tmux-agent-test',
    url: '/',
    event: 'test',
    at: now.toISOString(),
    ...(silent ? { silent: true } : {}),
  }
}

export async function pushTest(
  ctx?: Ctx,
): Promise<{ ok: true; sent: number; pruned: number; failed: number }> {
  const now = new Date()
  // ★ `silent` only when **explicitly true** (default is with sound). Any other body value is ignored
  let silent = false
  if (ctx) {
    const body = await readJsonBody<{ silent?: unknown }>(ctx.req).catch(() => ({}))
    silent = (body as { silent?: unknown }).silent === true
  }
  // ★ Make the test send the same shape too (pass through `withPendingPerms`).
  //   It does show a notification, so it satisfies the contract; it merely adds **one more chance for stale approval notifications to be cleaned up**
  const result = await orExplain(() => sendToAll(withPendingPerms(testPayload(now, silent))))
  console.log(
    t(
      `[push] テスト送信 silent=${silent} sent=${result.sent} pruned=${result.pruned} failed=${result.failed}`,
      `[push] Test send silent=${silent} sent=${result.sent} pruned=${result.pruned} failed=${result.failed}`,
    ),
  )
  return { ok: true, ...result }
}
