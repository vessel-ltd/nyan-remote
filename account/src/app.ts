// ★★ Account and billing decisions (2026-09-24 / docs/BILLING.md §2.1).
//   ⚠️ **All decisions live here** (`worker.ts` only wires Cloudflare's hooks = runs from `npm test` / same practice as relay).
//
// Endpoints:
//   POST /api/login      CLI (`nyan login`): GitHub token (obtained by the CLI via Device Flow) → machine passphrase
//   GET  /api/license    agent: passphrase (+ the agent's public key) → a ticket signed and addressed to that machine's key
//   POST /api/logout     CLI: discard the passphrase (also removed from relay's ledger)
//   GET  /               the account page ("Sign in with GitHub" if not signed in)
//   GET  /auth/github    → to GitHub / GET /auth/github/callback ← from GitHub
//   POST /billing/checkout, /billing/portal, /machines/revoke, /logout   page forms
//   POST /stripe/webhook from Stripe
//
// ⚠️⚠️ The GitHub token is **used once for verification only** and never stored. ⚠️ Passphrases are stored **as hashes only**.
// ⚠️ Page forms **check Origin** (letting cookies alone through would let other sites trigger them).

import { toBase64Url } from '../../shared/crypto.ts'
import { licenseFor, PLAN_LIMITS, type License } from '../../shared/license.ts'
import { adminPage, DEFAULT_SPIKE_DAILY, usageAlerts, type UsageDay } from './ops.ts'
import { accountPage, landingPage, type Lang } from './pages.ts'
import { cookieOf, makeSession, readSession, SESSION_COOKIE, SESSION_TTL_SEC, setCookie, STATE_COOKIE } from './session.ts'
import { OPEN_STATUSES, planOf, summarize, type AccountRow, type Store } from './store.ts'
import type { CheckoutParams, StripeApi } from './stripe.ts'
import { StripeError, verifyWebhook } from './stripe.ts'

/** ★ Prices are in US dollars only (2026-09-24 / user decision = chose simplicity. Card issuers convert yen cards) */
export const PRICE_CHOICES = ['usd-month', 'usd-year'] as const
export type PriceChoice = (typeof PRICE_CHOICES)[number]

export interface GithubApi {
  /**
   * ★★ If the token **was issued to our OAuth App**, its owner (2026-09-24 / codex round 26, high #1).
   *   ⚠️⚠️ Accepting anything that can read `/user` let **a token another app legitimately got from a user** impersonate that user
   *      (a machine passphrase and a Plus ticket could be obtained). ⇒ Verify with GitHub's "Check a token" (requires our client secret).
   *   ⚠️ Unreadable or belonging to another app ⇒ undefined
   */
  checkToken(token: string): Promise<{ id: number; login: string } | undefined>
  /** Web sign-in: code → token (⚠️ undefined on failure) */
  exchange(code: string): Promise<string | undefined>
}

export interface Deps {
  store: Store
  stripe: StripeApi
  github: GithubApi
  signLicense(l: License): Promise<string>
  /**
   * ★★ Tell relay "this passphrase (`mid`) was removed" (record in the ledger → remove the room ticket → free the slot).
   *   ⚠️⚠️ **Throws on failure** (codex round 27, high #3). The caller does not delete the passphrase = removing again retries.
   *   ⚠️ Whether to free the slot is decided by the ledger (freed if no number in use remains / round 30, medium #2: passing the view at removal start went stale).
   */
  releaseMachine(acct: string, agentKey: string, mid: string): Promise<void>
  /**
   * ★ Ops watcher (ops.ts). ⚠️ Without it, `/admin` shows usage as "not configured" and the watcher does nothing
   *   usage: Cloudflare usage (the last `days` days) / sendAlert: email to the operators (⚠️ throws on failure)
   */
  ops?: { usage(days: number): Promise<UsageDay[]>; sendAlert?(subject: string, text: string, replyTo?: string): Promise<void> }
  /** Milliseconds */
  now(): number
  random(n: number): Uint8Array
  config: {
    /** `https://account.nyan-remote.app` */
    origin: string
    githubClientId: string
    sessionSecret: string
    webhookSecret: string
    prices: Record<PriceChoice, string>
    /** ★ GitHub ids that may view `/admin` (⚠️ if empty, nobody can) */
    adminGithubIds?: number[]
    /** ★ Request count reported as a daily spike (worker + DO) */
    spikeDailyRequests?: number
    /** Where alerts go (display only = the real recipient is the send_email setting) */
    alertTo?: string
  }
}

/**
 * ★★ Hourly watcher (a / `scheduled` in `worker.ts` / `usageAlerts` in ops.ts). Sends each alert one by one, once only.
 *   ⚠️ Remember "alerted" only after sending succeeded (remembering a failure keeps it silent next time too).
 * @returns number sent (⚠️ 'off' if there is no way to send)
 */
export async function runOps(d: Deps): Promise<number | 'off'> {
  if (!d.ops?.sendAlert) return 'off'
  const days = await d.ops.usage(new Date(d.now()).getUTCDate())
  let sent = 0
  for (const a of usageAlerts(days, d.now(), d.config.spikeDailyRequests ?? DEFAULT_SPIKE_DAILY)) {
    if (await d.store.alerted(a.key)) continue
    await d.ops.sendAlert(a.subject, a.text)
    await d.store.markAlert(a.key, d.now())
    sent += 1
  }
  return sent
}

/** ⚠️ Limit on machine passphrases per account (do not let disposable ones pile up) */
export const MAX_MACHINE_CREDENTIALS = 50
/** ★ Passphrases of machines unused this long are deleted from the server (⚠️ longer than relay's 30-day ledger = the slot frees first) */
export const MACHINE_FORGET_MS = 90 * 24 * 60 * 60 * 1000
/**
 * ⚠️⚠️ Passphrases unused this long get no tickets even before being deleted (codex round 28, medium #4).
 *   Issuing a ticket at the same instant as deletion produced tickets escaping revocation ⇒ leave a one-day gap (passphrases deleted within it can no longer receive tickets).
 */
export const MACHINE_REFUSE_MS = MACHINE_FORGET_MS - 24 * 60 * 60 * 1000
/** ⚠️ Body size limit (counted while reading = never hold a huge body whole / codex round 26, medium #11) */
export const MAX_API_BODY = 4096
export const MAX_FORM_BODY = 4096
/** ★ Only the support form is larger (`SUPPORT_MAX_CHARS` characters × UTF-8) */
export const MAX_SUPPORT_BODY = 32 * 1024
export const SUPPORT_MAX_CHARS = 3000
/** ⚠️ This many per account per day (UTC) (do not let spam or accidental repeat clicks flood the operators' inbox) */
export const SUPPORT_PER_DAY = 5
const EMAIL_RE = /^[^\s@<>"',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/
export const MAX_WEBHOOK_BODY = 256 * 1024
/** ★ Account lease duration (long enough to read Stripe / create a Checkout) */
export const LEASE_MS = 30_000
/** ⚠️ Limit on repeated re-reads (if it keeps changing even so, 503 = Stripe resends) */
const SYNC_ROUNDS = 5

/** ★ Header in which the agent states its own public key (the same value as relay's room key) */
export const AGENT_KEY_HEADER = 'x-nyan-agent-key'

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // ⚠️ Own pages only, no scripts, not embeddable elsewhere
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src https://app.nyan-remote.app; form-action 'self' https://github.com https://checkout.stripe.com https://billing.stripe.com; frame-ancestors 'none'; base-uri 'none'",
      'x-content-type-options': 'nosniff',
      // ⚠️ Not `no-referrer` (then POSTs from our own pages carry `Origin: null` too, and every form is refused)
      'referrer-policy': 'same-origin',
      ...headers,
    },
  })
const redirect = (to: string, headers: Record<string, string> = {}) => new Response(null, { status: 303, headers: { location: to, ...headers } })

/** ★ Hash of the passphrase (the only thing stored in D1) */
export async function sha256b64(s: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s) as never)))
}

const langOf = (req: Request): Lang => (/^ja\b/i.test(req.headers.get('accept-language') ?? '') ? 'ja' : 'en')

function bearer(req: Request): string | undefined {
  const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.get('authorization') ?? '')
  return m?.[1]
}

/**
 * ⚠️ Page forms accept only what came from our own pages (other sites cannot trigger them).
 *   ★ `Origin` equal to ours ⇒ pass. With no `Origin` or `null`, look at `Sec-Fetch-Site: same-origin` set by the browser
 *     (cannot be forged from a page). ⚠️⚠️ With `Referrer-Policy: no-referrer` the browser adds `Origin: null` even to POSTs
 *     from our own page (on 2026-09-24 it turned into "forbidden" on a real device) ⇒ the policy is `same-origin`, and both are checked here.
 */
function sameOrigin(req: Request, origin: string): boolean {
  const o = req.headers.get('origin')
  if (o === origin) return true
  if (o !== null && o !== 'null') return false
  return req.headers.get('sec-fetch-site') === 'same-origin'
}

/**
 * ★★ Read the body up to `max` bytes (⚠️ stop reading and return undefined beyond it / codex round 26, medium #11).
 *   ⚠️ Checking the length after `text()` meant reading all 409,600 bytes before refusing.
 */
export async function readCapped(req: Request, max: number): Promise<string | undefined> {
  const len = Number(req.headers.get('content-length') ?? '0')
  if (!Number.isFinite(len) || len > max) return undefined
  if (!req.body) return ''
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      return undefined
    }
    chunks.push(value)
  }
  const all = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.byteLength
  }
  return new TextDecoder().decode(all)
}

async function readJson(req: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await readCapped(req, MAX_API_BODY)
    if (text === undefined) return undefined
    const v = JSON.parse(text) as unknown
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const cleanLabel = (v: unknown): string =>
  typeof v === 'string' ? v.replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 64) || 'machine' : 'machine'
const AGENT_KEY_RE = /^[A-Za-z0-9_-]{86,88}$/

/**
 * ★★ Remove a machine (passphrase) (`nyan logout`, "remove" on the page / codex rounds 26-27).
 *   ⚠️⚠️ Delete the passphrase **only after relay has been told** (the other way round, a relay failure left the ticket in the room
 *      while only the passphrase was deleted, and there was no way to remove it again). ⇒ `'failed'` on failure (the passphrase is kept).
 *   ★ relay records "tickets with this number are rejected" before removing it from the room, so tickets issued concurrently do not pass either (medium #5).
 *   ⚠️ If another passphrase of the same machine remains, the slot is not freed.
 */
async function removeMachine(d: Deps, acct: string, id: string): Promise<'ok' | 'missing' | 'failed'> {
  // ⚠️⚠️ Mark "being removed" first (codex round 28, medium #4). After this no key is bound and no ticket is issued ⇒
  //    the key read after marking is final (closes the gap where a key gets bound and a ticket issued after reading "no key")
  const m = await d.store.markDeleting(acct, id)
  if (!m) return 'missing'
  if (m.agentKey) {
    // ★ Our view (⚠️ relay's ledger also refuses to free the slot while a passphrase using it remains = not relying on our view alone)
    try {
      await d.releaseMachine(acct, m.agentKey, m.id)
    } catch (err) {
      console.error('[account] release', err instanceof Error ? err.message : String(err))
      await d.store.unmarkDeleting(acct, id).catch(() => undefined)
      return 'failed'
    }
  }
  await d.store.deleteMachine(acct, id)
  return 'ok'
}

/**
 * ★★ Process while holding the account lease (codex round 27, high #2 and #4). ⚠️ undefined if it cannot be acquired (someone else is processing).
 */
interface Lease {
  token: string
  /**
   * ★★ Extend the lease (before every Stripe call / codex round 28, medium #6). ⚠️ Throws if it is no longer ours (= stops there).
   *   ⚠️ One Stripe call is shorter than the lease (`STRIPE_TIMEOUT_MS`) ⇒ a call right after a successful extension ends within the lease.
   */
  renew(): Promise<void>
}

async function withLease<T>(d: Deps, acct: string, fn: (lease: Lease) => Promise<T>): Promise<T | undefined> {
  const token = toBase64Url(d.random(18))
  if (!(await d.store.acquireLease(acct, token, d.now(), LEASE_MS))) return undefined
  const renew = async () => {
    if (!(await d.store.renewLease(acct, token, d.now(), LEASE_MS))) throw new Error('lease lost')
  }
  try {
    return await fn({ token, renew })
  } finally {
    await d.store.releaseLease(acct, token).catch(() => undefined)
  }
}

/**
 * ★★ Re-read the subscription list from Stripe and write it to the account (codex round 26, high #5, #6 and #8 → rebuilt in round 27, high #4).
 *   ⚠️⚠️ Never overwrite with event contents (they arrive out of order, two in the same second, processed concurrently).
 *   ⚠️⚠️ Never compare by time (with two started in the same millisecond the older one won / round 27, high #4) ⇒ **only the one lease holder** reads and writes,
 *      and if a notification arrived while reading (`syncWanted` went up), it **reads again**.
 *   @returns true = finished writing / false = someone else is processing or it will not settle (⚠️ the webhook gets 503 = Stripe resends)
 *   ⚠️ Failures throw (the webhook gets 500).
 */
async function syncAccount(d: Deps, acct: AccountRow): Promise<boolean> {
  const customer = acct.stripeCustomer
  if (!customer) return true
  await d.store.bumpSync(acct.id)
  const done = await withLease(d, acct.id, async (lease) => {
    for (let round = 0; round < SYNC_ROUNDS; round++) {
      const before = (await d.store.accountById(acct.id))?.syncWanted
      const subs = await d.stripe.listSubscriptions(customer, lease.renew)
      await lease.renew()
      if (!(await d.store.writeSync(acct.id, lease.token, summarize(subs), d.now()))) throw new Error('lease lost')
      if ((await d.store.accountById(acct.id))?.syncWanted === before) return true
    }
    return false
  })
  return done === true
}

/**
 * ★★ Create a Checkout (inside the lease / codex rounds 26-28). ⚠️ The rules are the order itself:
 *   ① if a half-made attempt exists, recover and close it (the previous holder whose lease expired may have created it / round 28, high #1):
 *      if the id is known, close by id. If not, call again with the same key and **exactly the values written down** (same values even if settings changed / round 29, medium #3).
 *      ⚠️ If the retry gets 409 (the previous holder is still creating it), stop (busy).
 *      ⚠️ Any other failure (Stripe remembering the earlier failure, etc.) moves on (round 29, medium #4): if the previous attempt created a Checkout,
 *      it is closed as an open one in ②, and if paid it shows in the list in ③ ⇒ moving on to the next attempt cannot produce a second subscription.
 *   ② close open Checkouts **first** (⚠️ before the subscription list: if an old Checkout got paid after looking at the list,
 *      the "no subscription" judgement went stale and a second one was created / round 28, high #2). Anything paid before closing shows in the next list
 *   ③ read the subscription list (if one exists, even unpaid in progress, go to billing management)
 *   ④ write the new attempt's idempotency key to D1 **first**, then create (if it cannot be written, the lease was lost = do not create)
 *   ⚠️ Extend the lease before every Stripe call (stop there if it cannot be extended).
 */
async function startCheckout(d: Deps, acct: AccountRow, choice: PriceChoice, lease: Lease): Promise<string> {
  const params = (customer: string, price: PriceChoice): CheckoutParams => ({
    customer,
    price: d.config.prices[price],
    accountId: acct.id,
    successUrl: `${d.config.origin}/?n=thanks`,
    cancelUrl: `${d.config.origin}/`,
  })
  let customer = acct.stripeCustomer
  if (!customer) {
    // ⚠️⚠️ One customer (idempotency key + bind only when absent + read again / codex round 26, high #7)
    await lease.renew()
    const made = await d.stripe.createCustomer({ accountId: acct.id, githubLogin: acct.githubLogin }, `customer-${acct.id}`)
    await d.store.setCustomerIfNone(acct.id, made)
  }
  const now = await d.store.accountById(acct.id)
  customer = now?.stripeCustomer ?? customer
  if (!now || !customer) throw new Error('no customer')
  // ①
  if (now.checkoutKey) {
    let prevId = now.checkoutSession
    if (!prevId) {
      const prev = parseAttempt(now.checkoutParams)
      if (prev) {
        await lease.renew()
        try {
          prevId = (await d.stripe.createCheckout(prev.params, now.checkoutKey)).id
        } catch (err) {
          // ⚠️⚠️ Moving on is allowed only for **failures with a settled outcome** (4xx) (codex round 30, high #1).
          //    Network cuts, 5xx and 429 mean "it may have been created" ⇒ keep the attempt and stop (the next one recovers with the same key).
          //    ⚠️ 409 means "the previous holder is still creating it".
          const unknown = !(err instanceof StripeError) || err.status >= 500 || err.status === 409 || err.status === 429
          // ★ If enough time has passed, the previous creation has finished ⇒ move on (Stripe keeps returning the earlier 500 for the same key,
          //   so just waiting could not get out for 24 hours / round 31, medium #1). ⚠️ A Checkout made by the previous attempt is closed in ②, and shows in ③ if paid
          if (unknown && d.now() - prev.at < ATTEMPT_SETTLE_MS) throw new Busy()
          console.error('[account] checkout replay', err instanceof Error ? err.message : String(err))
        }
      }
    }
    if (prevId) {
      await lease.renew()
      await d.stripe.expireCheckout(prevId)
    }
  }
  if (!(await d.store.setCheckoutAttempt(acct.id, lease.token, undefined, d.now()))) throw new Error('lease lost')
  // ②
  for (const id of await d.stripe.listOpenCheckouts(customer, lease.renew)) {
    await lease.renew()
    await d.stripe.expireCheckout(id)
  }
  // ③
  const subs = await d.stripe.listSubscriptions(customer, lease.renew)
  if (subs.some((x) => (OPEN_STATUSES as readonly string[]).includes(x.status))) {
    await lease.renew()
    return await d.stripe.createPortal({ customer, returnUrl: `${d.config.origin}/` })
  }
  // ④
  const key = `checkout-${acct.id}-${toBase64Url(d.random(12))}`
  const p = params(customer, choice)
  await lease.renew()
  const stored = JSON.stringify({ params: p, at: d.now() })
  if (!(await d.store.setCheckoutAttempt(acct.id, lease.token, { key, params: stored }, d.now()))) throw new Error('lease lost')
  // ⚠️ Check the lease once more right before creating (if the response writing the attempt was late and the lease expired, the successor is recovering with the same key / round 30, high #1)
  await lease.renew()
  const made = await d.stripe.createCheckout(p, key)
  // ★ Write the created id (the next holder closes by id without calling again).
  // ⚠️ Could not write = the lease expired ⇒ the next holder recovers and closes this Checkout ⇒ do not hand out this URL
  if (!(await d.store.setCheckoutAttempt(acct.id, lease.token, { key, params: stored, session: made.id }, d.now()))) throw new Busy()
  return made.url
}

/** ★ The previous holder is still creating it (⚠️ the page says "wait a moment") */
class Busy extends Error {}

/** ⚠️ Even without knowing the outcome after creating, once this much time passes the previous creation has finished (Stripe calls are cut off at 10 s) */
export const ATTEMPT_SETTLE_MS = 10 * 60 * 1000

/** ⚠️ Values read from D1 (a wrong shape counts as absent = protected by ② and ③ without calling again) */
function parseAttempt(raw: string | undefined): { params: CheckoutParams; at: number } | undefined {
  try {
    const v = JSON.parse(raw ?? '') as { params?: Record<string, unknown>; at?: unknown }
    const p = v.params ?? {}
    const keys = ['customer', 'price', 'accountId', 'successUrl', 'cancelUrl'] as const
    return keys.every((k) => typeof p[k] === 'string') && typeof v.at === 'number' ? { params: p as unknown as CheckoutParams, at: v.at } : undefined
  } catch {
    return undefined
  }
}

/** ★ Look up our account from the GitHub account (create it if missing). ⚠️ Login names can change, so update every time */
async function upsertAccount(d: Deps, gh: { id: number; login: string }): Promise<AccountRow> {
  const found = await d.store.accountByGithub(gh.id)
  if (found) {
    if (found.githubLogin !== gh.login) await d.store.updateLogin(found.id, gh.login)
    return { ...found, githubLogin: gh.login }
  }
  const row: AccountRow = { id: `acct_${toBase64Url(d.random(12))}`, githubId: gh.id, githubLogin: gh.login, created: d.now() }
  await d.store.createAccount(row)
  return row
}

export async function handle(req: Request, d: Deps): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname
  const method = req.method
  try {
    // ── CLI and agent ───────────────────────────────────────────────────────
    if (method === 'POST' && path === '/api/login') {
      const body = await readJson(req)
      const token = typeof body?.['githubToken'] === 'string' ? body['githubToken'] : ''
      if (!token || token.length > 512) return json({ error: 'bad-request' }, 400)
      const gh = await d.github.checkToken(token)
      if (!gh) return json({ error: 'github' }, 401)
      const acct = await upsertAccount(d, gh)
      await d.store.pruneMachines(acct.id, d.now() - MACHINE_FORGET_MS)
      const credential = toBase64Url(d.random(32))
      // ★ The key may be unknown here (the agent was stopped) ⇒ bound on the first `/api/license`
      const agentKey = typeof body?.['agentKey'] === 'string' && AGENT_KEY_RE.test(body['agentKey']) ? body['agentKey'] : undefined
      const created = await d.store.createMachine(
        {
          id: `m_${toBase64Url(d.random(9))}`,
          accountId: acct.id,
          credHash: await sha256b64(credential),
          label: cleanLabel(body?.['label']),
          ...(agentKey ? { agentKey } : {}),
          created: d.now(),
          lastSeen: d.now(),
        },
        MAX_MACHINE_CREDENTIALS,
      )
      if (!created) return json({ error: 'too-many-machines' }, 409)
      // ⚠️ The passphrase is shown only this once
      return json({ credential, account: { id: acct.id, login: acct.githubLogin, plan: planOf(acct) } })
    }
    if (method === 'GET' && path === '/api/license') {
      const cred = bearer(req)
      const m = cred ? await d.store.machineByCred(await sha256b64(cred)) : undefined
      // ⚠️⚠️ No tickets for passphrases being removed or about to be deleted (do not make tickets escaping revocation / codex round 28, medium #4)
      if (!m || m.deleting || d.now() - m.lastSeen > MACHINE_REFUSE_MS) return json({ error: 'unknown-machine' }, 401)
      const acct = await d.store.accountById(m.accountId)
      if (!acct) return json({ error: 'unknown-machine' }, 401)
      // ★★ The ticket is addressed to **this machine's key** (codex round 26, high #3). ⚠️ One passphrase, one key (the first bound key wins)
      const key = req.headers.get(AGENT_KEY_HEADER) ?? ''
      if (!AGENT_KEY_RE.test(key)) return json({ error: 'need-agent-key' }, 400)
      if (!m.agentKey) {
        await d.store.bindMachineKey(m.id, key)
        // ⚠️ Read again (could not bind = another key was bound first, or it is being removed)
        const again = await d.store.machineById(m.id)
        if (!again || again.deleting) return json({ error: 'unknown-machine' }, 401)
        if (again.agentKey !== key) return json({ error: 'key-mismatch' }, 409)
      } else if (m.agentKey !== key) return json({ error: 'key-mismatch' }, 409)
      await d.store.touchMachine(m.id, d.now())
      const plan = planOf(acct)
      const lic = licenseFor(acct.id, key, m.id, plan, Math.floor(d.now() / 1000))
      return json({ license: await d.signLicense(lic), plan, login: acct.githubLogin, ...PLAN_LIMITS[plan], exp: lic.exp })
    }
    if (method === 'POST' && path === '/api/logout') {
      const cred = bearer(req)
      const m = cred ? await d.store.machineByCred(await sha256b64(cred)) : undefined
      if (!m) return json({ ok: true })
      // ⚠️ 503 if relay could not be told (the CLI keeps the sign-in = running it again retries / codex round 27, high #3)
      if ((await removeMachine(d, m.accountId, m.id)) === 'failed') return json({ error: 'relay' }, 503)
      return json({ ok: true })
    }

    // ── Stripe ──────────────────────────────────────────────────────────
    if (method === 'POST' && path === '/stripe/webhook') return await onWebhook(req, d)

    // ── Web sign-in ───────────────────────────────────────────────────
    if (method === 'GET' && path === '/auth/github') {
      const state = toBase64Url(d.random(18))
      const to = new URL('https://github.com/login/oauth/authorize')
      to.searchParams.set('client_id', d.config.githubClientId)
      to.searchParams.set('redirect_uri', `${d.config.origin}/auth/github/callback`)
      to.searchParams.set('state', state)
      to.searchParams.set('allow_signup', 'true')
      return redirect(to.toString(), { 'set-cookie': setCookie(STATE_COOKIE, state, 600) })
    }
    if (method === 'GET' && path === '/auth/github/callback') {
      const state = url.searchParams.get('state') ?? ''
      const code = url.searchParams.get('code') ?? ''
      // ⚠️ Refuse if state does not match the cookie (nobody can push their sign-in onto someone else)
      if (!state || state !== cookieOf(req, STATE_COOKIE) || !code) return redirect('/?e=login')
      const token = await d.github.exchange(code)
      const gh = token ? await d.github.checkToken(token) : undefined
      if (!gh) return redirect('/?e=login')
      const acct = await upsertAccount(d, gh)
      const session = await makeSession(d.config.sessionSecret, acct.id, Math.floor(d.now() / 1000))
      const h = new Headers({ location: '/' })
      h.append('set-cookie', setCookie(SESSION_COOKIE, session, SESSION_TTL_SEC))
      h.append('set-cookie', setCookie(STATE_COOKIE, '', 0))
      return new Response(null, { status: 303, headers: h })
    }

    // ── Pages ────────────────────────────────────────────────────────────
    const lang = langOf(req)
    const acctId = await readSession(d.config.sessionSecret, cookieOf(req, SESSION_COOKIE), Math.floor(d.now() / 1000))
    const acct = acctId ? await d.store.accountById(acctId) : undefined
    // ★★ Ops page (ops.ts). ⚠️ Only allowed GitHub ids; everyone else is told it "does not exist" (do not reveal that it exists)
    if (method === 'GET' && path === '/admin') {
      if (!acct || !(d.config.adminGithubIds ?? []).includes(acct.githubId)) return new Response('not found', { status: 404 })
      let usage: UsageDay[] | string
      try {
        // ★ This month (monthly projection) and the last two weeks (daily table)
        usage = d.ops ? await d.ops.usage(Math.max(14, new Date(d.now()).getUTCDate())) : 'not configured (no analytics token)'
      } catch (err) {
        usage = `could not read (${err instanceof Error ? err.message : String(err)})`
      }
      return html(
        adminPage({
          notice: url.searchParams.get('n') ?? undefined,
          stats: await d.store.stats(d.now()),
          usage,
          spikeDaily: d.config.spikeDailyRequests ?? DEFAULT_SPIKE_DAILY,
          now: d.now(),
          ...(d.config.alertTo ? { alertTo: d.config.alertTo } : {}),
        }),
      )
    }
    if (method === 'GET' && path === '/') {
      if (!acct) return html(landingPage(lang, url.searchParams.get('e') === 'login'))
      await d.store.pruneMachines(acct.id, d.now() - MACHINE_FORGET_MS)
      return html(
        accountPage(lang, {
          account: acct,
          plan: planOf(acct),
          machines: await d.store.machinesOf(acct.id),
          notice: url.searchParams.get('n') ?? undefined,
          admin: (d.config.adminGithubIds ?? []).includes(acct.githubId),
        }),
      )
    }
    if (method === 'POST') {
      if (!sameOrigin(req, d.config.origin)) return new Response('forbidden', { status: 403 })
      if (path === '/logout') return redirect('/', { 'set-cookie': setCookie(SESSION_COOKIE, '', 0) })
      // ★ Ops: send a test watcher email (⚠️ operators only, same-origin forms only = Origin is checked above)
      if (path === '/admin/test-alert') {
        if (!acct || !(d.config.adminGithubIds ?? []).includes(acct.githubId)) return new Response('not found', { status: 404 })
        if (!d.ops?.sendAlert) return redirect('/admin?n=no-mail')
        try {
          await d.ops.sendAlert('[nyan-remote] Test alert', `This is a test from https://account.nyan-remote.app/admin (${new Date(d.now()).toISOString()}).`)
          return redirect('/admin?n=sent')
        } catch (err) {
          console.error('[ops] test alert', err instanceof Error ? err.message : String(err))
          return redirect('/admin?n=failed')
        }
      }
      if (!acct) return redirect('/')
      const raw = await readCapped(req, path === '/support' ? MAX_SUPPORT_BODY : MAX_FORM_BODY)
      if (raw === undefined) return new Response('too large', { status: 413 })
      const form = new URLSearchParams(raw)
      if (path === '/billing/checkout') {
        const choice = String(form.get('price') ?? '')
        if (!(PRICE_CHOICES as readonly string[]).includes(choice)) return redirect('/?n=bad-price')
        // ⚠️⚠️ **Only the one lease holder** checks "no subscription, no open Checkout" and creates one (codex round 27, high #2:
        //    two tabs could both read "none" and each create a Checkout). If the lease cannot be acquired, "wait a moment".
        const to = await withLease(d, acct.id, (lease) => startCheckout(d, acct, choice as PriceChoice, lease)).catch((err) => {
          if (err instanceof Busy) return undefined
          throw err
        })
        return redirect(to ?? '/?n=busy')
      }
      if (path === '/billing/portal') {
        if (!acct.stripeCustomer) return redirect('/')
        return redirect(await d.stripe.createPortal({ customer: acct.stripeCustomer, returnUrl: `${d.config.origin}/` }))
      }
      // ★★ Support (2026-09-25 / user decision: the channel for paying users is a form only for signed-in users = no spam)
      //   ⚠️ The operators' address is never shown on the page (the recipient is the ALERT_TO secret). ⚠️ Up to 5 a day.
      //   ⚠️ Reply-to is only the address the user wrote (its shape is checked = no newlines smuggled into mail headers)
      if (path === '/support') {
        const message = String(form.get('message') ?? '').trim().slice(0, SUPPORT_MAX_CHARS)
        const email = String(form.get('email') ?? '').trim()
        if (!message) return redirect('/?n=support-empty#support')
        if (email && !EMAIL_RE.test(email)) return redirect('/?n=support-email#support')
        if (!d.ops?.sendAlert) return redirect('/?n=support-failed#support')
        const date = new Date(d.now()).toISOString().slice(0, 10)
        if ((await d.store.supportCount(acct.id, date)) >= SUPPORT_PER_DAY) return redirect('/?n=support-limit#support')
        const lines = [
          `From: ${acct.githubLogin} (GitHub id ${acct.githubId}, account ${acct.id}, plan ${planOf(acct)})`,
          `Reply to: ${email || '(not given — reply through GitHub)'}`,
          `Machines: ${(await d.store.machinesOf(acct.id)).length}`,
          '',
          message,
        ]
        try {
          await d.ops.sendAlert(`[nyan-remote support] ${acct.githubLogin}`, lines.join('\n'), email || undefined)
        } catch (err) {
          console.error('[support]', err instanceof Error ? err.message : String(err))
          return redirect('/?n=support-failed#support')
        }
        await d.store.markAlert(`support:${acct.id}:${date}:${toBase64Url(d.random(6))}`, d.now())
        return redirect('/?n=support-sent#support')
      }
      if (path === '/machines/revoke') {
        const r = await removeMachine(d, acct.id, String(form.get('id') ?? ''))
        return redirect(r === 'failed' ? '/?n=revoke-failed' : '/?n=revoked')
      }
    }
    return new Response('not found', { status: 404 })
  } catch (err) {
    // ⚠️ Contents are never exposed (log only)
    console.error('[account]', err instanceof Error ? err.message : String(err))
    return new Response('error', { status: 500 })
  }
}

/**
 * ★★ Stripe events (2026-09-24 / rebuilt in codex round 26, high #5 and #6).
 *   ⚠️ Do not read the body without a signature header; read the body only up to the limit.
 *   ⚠️⚠️ Events are only used as a signal of "which customer changed", and **state is re-read from Stripe** (`syncAccount`):
 *      - do not set the "processed" mark first (a failure midway made resends get dropped as "processed" and never applied)
 *      - do not compare by event time (out of order, same second, processed concurrently ⇒ the old state won in each case)
 *   ⇒ However many times and in whatever order they arrive, the list whose read started last remains (idempotent).
 */
async function onWebhook(req: Request, d: Deps): Promise<Response> {
  const sigHeader = req.headers.get('stripe-signature')
  if (!sigHeader) return new Response('bad signature', { status: 400 })
  const body = await readCapped(req, MAX_WEBHOOK_BODY)
  if (body === undefined) return new Response('too large', { status: 413 })
  if (!(await verifyWebhook(d.config.webhookSecret, sigHeader, body, Math.floor(d.now() / 1000)))) {
    return new Response('bad signature', { status: 400 })
  }
  let ev: { id?: unknown; type?: unknown; data?: { object?: Record<string, unknown> } }
  try {
    ev = JSON.parse(body) as typeof ev
  } catch {
    return new Response('bad body', { status: 400 })
  }
  if (typeof ev.id !== 'string' || typeof ev.type !== 'string') return new Response('bad body', { status: 400 })
  if (ev.type !== 'checkout.session.completed' && !ev.type.startsWith('customer.subscription.')) return json({ ok: true })
  const o = ev.data?.object ?? {}
  const customer = typeof o['customer'] === 'string' ? o['customer'] : undefined
  if (!customer) return json({ ok: true })
  let acct = await d.store.accountByCustomer(customer)
  if (!acct) {
    // ★ Customer not bound yet (right after creating a Checkout) ⇒ look it up from the mark we attached (the account id)
    const meta = o['metadata'] as Record<string, unknown> | undefined
    const hint = [o['client_reference_id'], meta?.['account']].find((v): v is string => typeof v === 'string')
    const byHint = hint ? await d.store.accountById(hint) : undefined
    if (byHint && !byHint.stripeCustomer) {
      await d.store.setCustomerIfNone(byHint.id, customer)
      acct = await d.store.accountByCustomer(customer)
    }
    if (!acct) {
      // ⚠️ A customer that cannot be bound to any account (log only = investigate by hand)
      console.error('[account] webhook: customer not linked to an account', ev.type)
      return json({ ok: true })
    }
  }
  // ⚠️ Someone else is re-reading, or it will not settle ⇒ 503 (Stripe resends = nothing is lost)
  if (!(await syncAccount(d, acct))) return json({ error: 'busy' }, 503)
  return json({ ok: true })
}
