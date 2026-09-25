// ★★ Stripe (2026-09-24 / docs/BILLING.md §2.1). ⚠️ No SDK (no new dependencies / CLAUDE.md §2) ⇒ call REST with fetch.
//   Used for: creating customers, creating Checkouts / closing open ones, creating the Customer Portal, reading subscription lists, verifying webhook signatures.
//   ⚠️ Restricted key permissions: Customers (write), Checkout Sessions (write), Customer portal (write), **Subscriptions (read)**.
// ⚠️ The secret key (`sk_…`) and webhook secret (`whsec_…`) are secrets only (never in code or logs).

import { sameBytes } from '../../shared/crypto.ts'

type Bin = Parameters<typeof crypto.subtle.digest>[1]
export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>

/** ★ A Stripe failure (⚠️ does not keep the other side's text = status code only. The caller tells 409 etc. apart) */
export class StripeError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/** ★ Values for creating a Checkout (⚠️ written to D1 as-is per attempt, and the same values are used on retry / codex round 29, medium #3) */
export interface CheckoutParams {
  customer: string
  price: string
  accountId: string
  successUrl: string
  cancelUrl: string
}

/** ⚠️ Limit for one Stripe call (well under the 30-second account lease) */
export const STRIPE_TIMEOUT_MS = 10_000

/** ★ One subscription (only id and status are read) */
export interface StripeSubscription {
  id: string
  status: string
}

export interface StripeApi {
  /**
   * ⚠️⚠️ One `idempotencyKey` per account (codex round 26, high #7): even when two tabs start at once, **the same customer** comes back
   *   (without it, two customers were created, and paying with the earlier one left it detached from the account).
   */
  createCustomer(o: { accountId: string; githubLogin: string }, idempotencyKey: string): Promise<string>
  /**
   * ★★ One `idempotencyKey` **per attempt**, written to D1 first (codex round 28, high #1): even if the lease expires and someone else takes over,
   *   calling again with the same key makes Stripe return **the same Checkout** ⇒ a creation of "unknown whether it was sent" can be recovered.
   */
  createCheckout(o: CheckoutParams, idempotencyKey: string): Promise<{ id: string; url: string }>
  createPortal(o: { customer: string; returnUrl: string }): Promise<string>
  /** ★ That customer's subscriptions (including cancelled ones). ⚠️ The plan is **decided from these** (event contents do not arrive in order / codex round 26, high #5 and #6) */
  /** @param onPage called after each page is read (lease extension / codex round 28, medium #6. ⚠️ stops reading if it throws) */
  listSubscriptions(customer: string, onPage?: () => Promise<void>): Promise<StripeSubscription[]>
  /** ★ Checkouts not yet paid (⚠️ closed before making a new one = old tabs cannot create a second subscription / high #8) */
  listOpenCheckouts(customer: string, onPage?: () => Promise<void>): Promise<string[]>
  /**
   * ★ Close it. ⚠️ If it could not be closed because it is already closed (`expired`) or paid (`complete`), return that (never throw)
   */
  expireCheckout(id: string): Promise<'expired' | 'complete'>
}

/** ⚠️ Page limit when walking a list (100 × 20 = 2000 items) */
export const LIST_PAGES = 20

/** ★ Stripe's form encoding (`metadata[x]=y` / `line_items[0][price]=…`) */
export function formEncode(o: Record<string, string>): string {
  return Object.entries(o)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
}

export function stripeApi(secretKey: string, f: Fetch = (u, i) => fetch(u, i)): StripeApi {
  const call = async (method: 'GET' | 'POST', path: string, body?: Record<string, string>, extra: Record<string, string> = {}): Promise<Record<string, unknown>> => {
    const res = await f(`https://api.stripe.com/v1/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${secretKey}`,
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...extra,
      },
      ...(body ? { body: formEncode(body) } : {}),
      // ⚠️ Finish one call faster than the lease expiry (codex round 28, medium #6)
      signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    // ⚠️ The failure details (the other side's error text) are never shown on screen (the caller only logs them)
    if (!res.ok) throw new StripeError(`stripe ${method} ${path.split('?')[0]} ${res.status}`, res.status)
    return json
  }
  const post = (path: string, body: Record<string, string>, extra?: Record<string, string>) => call('POST', path, body, extra)
  /**
   * ★ Read the whole list (following `starting_after` / codex round 27, medium #8: with one page only, customers with over 100 history entries
   *   failed every time with "there is more" and could never sync). ⚠️ Throws over the limit (never conclude "no subscription" from a partial read).
   */
  const list = async (path: string, onPage?: () => Promise<void>): Promise<Record<string, unknown>[]> => {
    const out: Record<string, unknown>[] = []
    let after: string | undefined
    for (let page = 0; page < LIST_PAGES; page++) {
      await onPage?.()
      const j = await call('GET', after ? `${path}&${formEncode({ starting_after: after })}` : path)
      const data = Array.isArray(j['data']) ? (j['data'] as Record<string, unknown>[]) : []
      out.push(...data)
      const last = data.at(-1)?.['id']
      if (j['has_more'] !== true) return out
      if (typeof last !== 'string') throw new Error('stripe list: no cursor')
      after = last
    }
    throw new Error(`stripe GET ${path.split('?')[0]}: too many`)
  }
  const str = (v: unknown, what: string) => {
    if (typeof v !== 'string' || !v) throw new Error(`stripe: no ${what}`)
    return v
  }
  return {
    createCustomer: async (o, idempotencyKey) =>
      str(
        (await post('customers', { 'metadata[account]': o.accountId, 'metadata[github]': o.githubLogin }, { 'idempotency-key': idempotencyKey })).id,
        'customer id',
      ),
    createCheckout: async (o, idempotencyKey) => {
      const j = await post(
        'checkout/sessions',
        {
            mode: 'subscription',
            customer: o.customer,
            client_reference_id: o.accountId,
            'line_items[0][price]': o.price,
            'line_items[0][quantity]': '1',
            'subscription_data[metadata][account]': o.accountId,
            success_url: o.successUrl,
            cancel_url: o.cancelUrl,
            allow_promotion_codes: 'true',
        },
        { 'idempotency-key': idempotencyKey },
      )
      return { id: str(j['id'], 'checkout id'), url: str(j['url'], 'checkout url') }
    },
    createPortal: async (o) => str((await post('billing_portal/sessions', { customer: o.customer, return_url: o.returnUrl })).url, 'portal url'),
    listSubscriptions: async (customer, onPage) =>
      (await list(`subscriptions?${formEncode({ customer, status: 'all', limit: '100' })}`, onPage)).flatMap((s) =>
        typeof s['id'] === 'string' && typeof s['status'] === 'string' ? [{ id: s['id'], status: s['status'] }] : [],
      ),
    listOpenCheckouts: async (customer, onPage) =>
      (await list(`checkout/sessions?${formEncode({ customer, status: 'open', limit: '100' })}`, onPage)).flatMap((s) =>
        typeof s['id'] === 'string' ? [s['id']] : [],
      ),
    expireCheckout: async (id) => {
      if (!/^cs_[A-Za-z0-9_]+$/.test(id)) throw new Error('stripe: bad checkout id')
      try {
        await post(`checkout/sessions/${id}/expire`, {})
        return 'expired'
      } catch (err) {
        // ⚠️ Not open (already closed or paid) means it cannot be closed ⇒ read the current state
        const now = await call('GET', `checkout/sessions/${id}`)
        if (now['status'] === 'expired' || now['status'] === 'complete') return now['status']
        throw err
      }
    },
  }
}

/** ⚠️ Allowed signature time skew (5 minutes, same as Stripe's default = do not accept resends of old events) */
export const WEBHOOK_TOLERANCE_SEC = 300

/**
 * ★★ Verify the webhook signature (`Stripe-Signature: t=…,v1=…`). HMAC-SHA256(`${t}.${body}`).
 * ⚠️ Compute over **the body text exactly as received** (re-serialising the JSON changes even one character and fails).
 * ⚠️ Never throws (false on mismatch).
 */
export async function verifyWebhook(secret: string, header: string | null, body: string, nowSec: number): Promise<boolean> {
  if (!secret || !header) return false
  let t: number | undefined
  const sigs: string[] = []
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2)
    if (k === 't' && v) t = Number(v)
    if (k === 'v1' && v) sigs.push(v)
  }
  if (t === undefined || !Number.isFinite(t) || Math.abs(nowSec - t) > WEBHOOK_TOLERANCE_SEC || sigs.length === 0) return false
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret) as Bin, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const want = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${body}`) as Bin))
  return sigs.some((s) => /^[0-9a-f]{64}$/.test(s) && sameBytes(want, hexBytes(s)))
}

function hexBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}
