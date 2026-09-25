// ★★ Hit the account and billing decisions (`app.ts`) with fake GitHub / Stripe / storage (2026-09-24).
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { importLicensePublicKey, signLicense, verifyLicense, type License } from '../../shared/license.ts'
import { AGENT_KEY_HEADER, ATTEMPT_SETTLE_MS, handle, MACHINE_FORGET_MS, MACHINE_REFUSE_MS, MAX_MACHINE_CREDENTIALS, sha256b64, type Deps } from './app.ts'
import { makeSession, SESSION_COOKIE } from './session.ts'
import { memoryStore } from './store.ts'
import { StripeError } from './stripe.ts'

const ORIGIN = 'https://account.nyan-remote.app'
const T = 1_800_000_000_000

async function rig() {
  const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as unknown as {
    publicKey: Parameters<typeof crypto.subtle.exportKey>[1]
    privateKey: Parameters<typeof crypto.subtle.sign>[1]
  }
  const pub = await importLicensePublicKey(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)))
  const store = memoryStore()
  const calls: string[] = []
  const released: string[] = []
  let n = 0
  let clock = T
  // ★ Fake Stripe: one customer per idempotency key, subscriptions in a per-customer table (tests rewrite it)
  const customers = new Map<string, string>()
  const subs = new Map<string, { id: string; status: string }[]>()
  // ★ Checkout: one per idempotency key (⚠️ like the real one, a retry with the same key returns the same Checkout), with state
  const sessions = new Map<string, { customer: string; status: 'open' | 'expired' | 'complete'; key?: string; params?: string }>()
  const stripeHooks: {
    beforeList?: (customer: string) => Promise<void>
    sameKeyNewCustomer?: boolean
    /** Right before creating (⚠️ reproduces a Stripe slow enough for the lease to expire) */
    beforeCreate?: () => Promise<void>
    /** When trying to close, it had been paid just before (reproduces round 28, high #2) */
    paidBeforeExpire?: string
    /** A retry with the same key fails (⚠️ Stripe remembers and returns the earlier failure, 409 means still creating / round 29, medium #4) */
    replayStatus?: number
  } = {}
  const relay: { down?: boolean } = {}
  const d: Deps = {
    store,
    stripe: {
      createCustomer: async (_o, key) => {
        calls.push('customer')
        // ⚠️ `sameKeyNewCustomer` = Stripe when the idempotency key had no effect (expired after 24 hours etc.)
        if (stripeHooks.sameKeyNewCustomer || !customers.has(key)) customers.set(key, `cus_${customers.size + 1}`)
        return customers.get(key)!
      },
      createCheckout: async (o, key) => {
        await stripeHooks.beforeCreate?.()
        const found = [...sessions].find(([, v]) => v.key === key)
        if (found && stripeHooks.replayStatus) throw new StripeError('replay', stripeHooks.replayStatus)
        // ⚠️ Same as the real one: a different value with the same key is refused
        if (found && found[1].params !== JSON.stringify(o)) {
          calls.push('replay-mismatch')
          throw new StripeError('idempotency mismatch', 400)
        }
        if (found) return { id: found[0], url: `https://checkout.stripe.com/c/${found[0]}` }
        calls.push(`checkout:${o.price}:${o.customer}:${o.accountId}`)
        const id = `cs_test_${sessions.size + 1}`
        sessions.set(id, { customer: o.customer, status: 'open', key, params: JSON.stringify(o) })
        return { id, url: `https://checkout.stripe.com/c/${id}` }
      },
      createPortal: async () => 'https://billing.stripe.com/p/1',
      listSubscriptions: async (customer) => {
        const snapshot = [...(subs.get(customer) ?? [])]
        await stripeHooks.beforeList?.(customer)
        return snapshot
      },
      listOpenCheckouts: async (customer) => [...sessions].filter(([, v]) => v.customer === customer && v.status === 'open').map(([id]) => id),
      expireCheckout: async (id) => {
        calls.push(`expire:${id}`)
        const x = sessions.get(id)
        if (!x) throw new Error('no such session')
        if (stripeHooks.paidBeforeExpire === id) {
          x.status = 'complete'
          subs.set(x.customer, [...(subs.get(x.customer) ?? []), { id: 'sub_paid', status: 'active' }])
        }
        if (x.status === 'open') x.status = 'expired'
        return x.status
      },
    },
    github: {
      // ★ Only tokens of our app reveal their owner (`gho_elsewhere` = a real token another app holds)
      checkToken: async (tok) => (tok === 'gho_good' ? { id: 42, login: 'nyan' } : tok === 'gho_other' ? { id: 7, login: 'other' } : undefined),
      exchange: async (code) => (code === 'good-code' ? 'gho_good' : code === 'elsewhere' ? 'gho_elsewhere' : undefined),
    },
    signLicense: (l: License) => signLicense(l, keys.privateKey),
    releaseMachine: async (acct, key, mid) => {
      if (relay.down) throw new Error('relay down')
      released.push(`${acct}:${key}:${mid}`)
    },
    now: () => clock,
    // ★ Deterministic randomness (a different value each time = ids never collide)
    random: (len) => Uint8Array.from({ length: len }, (_, i) => (n++ * 31 + i * 7) & 255),
    config: {
      origin: ORIGIN,
      githubClientId: 'Ov23liR5gPIqJCohxOey',
      sessionSecret: 'test-session-secret-0123456789',
      webhookSecret: 'whsec_test',
      prices: { 'usd-month': 'price_um', 'usd-year': 'price_uy' },
    },
  }
  const call = (path: string, init: RequestInit = {}) => handle(new Request(`${ORIGIN}${path}`, init), d)
  return {
    d,
    store,
    calls,
    released,
    pub,
    call,
    subs,
    sessions,
    /** An open Checkout created in another tab or before this version */
    addOpenCheckout: (customer: string, id: string) => void sessions.set(id, { customer, status: 'open' }),
    openCount: () => [...sessions.values()].filter((v) => v.status === 'open').length,
    stripeHooks,
    relay,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

const KEY = 'A'.repeat(87)
const KEY2 = 'B'.repeat(87)

async function login(r: Awaited<ReturnType<typeof rig>>, token = 'gho_good', agentKey: string | null = KEY) {
  const res = await r.call('/api/login', { method: 'POST', body: JSON.stringify({ githubToken: token, label: 'PC-B', ...(agentKey ? { agentKey } : {}) }) })
  return { res, body: (await res.json()) as { credential: string; account: { id: string; plan: string } } }
}

const license = (r: Awaited<ReturnType<typeof rig>>, cred: string, key: string | null = KEY) =>
  r.call('/api/license', { headers: { authorization: `Bearer ${cred}`, ...(key ? { [AGENT_KEY_HEADER]: key } : {}) } })

test('★★ nyan login → passphrase → ticket (Free, signature verifies)', async () => {
  const r = await rig()
  const { res, body } = await login(r)
  assert.equal(res.status, 200)
  assert.equal(body.account.plan, 'free')
  // ⚠️⚠️ The passphrase itself is never stored (hash only)
  const saved = [...r.store.machines.values()][0]!
  assert.notEqual(saved.credHash, body.credential)
  assert.equal(saved.credHash, await sha256b64(body.credential))
  const lic = await license(r, body.credential)
  const got = (await lic.json()) as { license: string; plan: string; maxMachines: number }
  assert.equal(got.plan, 'free')
  assert.equal(got.maxMachines, 1)
  const v = await verifyLicense(got.license, r.pub, T / 1000)
  assert.ok(v.ok && v.license.acct === body.account.id)
  assert.ok(v.ok && v.license.key === KEY, '⚠️⚠️ the ticket is not addressed to the key of this machine')
  assert.ok(v.ok && v.license.mid === saved.id, '⚠️⚠️ the ticket has no passphrase number (relay could not tell it apart after removal)')
})

test('★★ unknown GitHub tokens and unknown passphrases are refused', async () => {
  const r = await rig()
  assert.equal((await login(r, 'gho_bad')).res.status, 401)
  const lic = await license(r, 'x'.repeat(43))
  assert.equal(lic.status, 401)
  assert.equal((await r.call('/api/license')).status, 401)
})

test('★★ a GitHub token given to another app cannot sign in (codex round 26, high #1)', async () => {
  const r = await rig()
  assert.equal((await login(r, 'gho_elsewhere')).res.status, 401, '⚠️⚠️ impersonated with a token of another app')
  const start = await r.call('/auth/github')
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!
  const cb = await r.call(`/auth/github/callback?code=elsewhere&state=${state}`, { headers: { cookie: `nr_oauth_state=${state}` } })
  assert.equal(cb.headers.get('location'), '/?e=login')
  assert.equal(r.store.accounts.size, 0)
})

test('★★ a passphrase binds only to the key it first stated (cannot be reused on another machine / codex round 26, high #3 and medium #9)', async () => {
  const r = await rig()
  // The agent was stopped = the key is unknown at sign-in
  const { body } = await login(r, 'gho_good', null)
  assert.equal((await license(r, body.credential, null)).status, 400, '⚠️ issued a ticket without the key being stated')
  assert.equal((await license(r, body.credential, KEY)).status, 200)
  assert.equal([...r.store.machines.values()][0]!.agentKey, KEY, '⚠️⚠️ the key could not be bound later (removing would not free the relay slot)')
  assert.equal((await license(r, body.credential, KEY2)).status, 409, '⚠️⚠️ issued a ticket for another machine with the same passphrase')
  assert.equal((await license(r, body.credential, KEY)).status, 200)
})

test('★★ the same GitHub account means the same account (a second machine joins the same account)', async () => {
  const r = await rig()
  const a = await login(r)
  const b = await login(r)
  assert.equal(a.body.account.id, b.body.account.id)
  assert.equal(r.store.machines.size, 2)
  assert.notEqual(a.body.credential, b.body.credential)
})

test('★★ machine passphrases up to the limit (no piling up disposable ones, not exceeded by concurrent calls / codex round 26, medium #10)', async () => {
  const r = await rig()
  for (let i = 0; i < MAX_MACHINE_CREDENTIALS - 1; i++) assert.equal((await login(r)).res.status, 200)
  const burst = await Promise.all(Array.from({ length: 10 }, () => login(r)))
  assert.equal(burst.filter((x) => x.res.status === 200).length, 1)
  assert.equal(r.store.machines.size, MAX_MACHINE_CREDENTIALS)
})

test('★★ passphrases unused for a long time disappear from the server (codex round 26, medium #12)', async () => {
  const r = await rig()
  const old = await login(r)
  r.advance(MACHINE_FORGET_MS + 1)
  await login(r)
  assert.equal((await license(r, old.body.credential)).status, 401)
  assert.equal(r.store.machines.size, 1)
})

test('★★ the body is counted while reading (never hold a huge body whole / codex round 26, medium #11)', async () => {
  const r = await rig()
  let pulled = 0
  const huge = () =>
    new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1
        c.enqueue(new Uint8Array(1024).fill(65))
        if (pulled > 1000) c.close()
      },
    }, { highWaterMark: 0 })
  const res = await r.call('/api/login', { method: 'POST', body: huge(), duplex: 'half' } as RequestInit)
  assert.equal(res.status, 400)
  assert.ok(pulled < 10, `⚠️⚠️ kept reading past the limit (${pulled} KB)`)
  pulled = 0
  const hook = await r.call('/stripe/webhook', { method: 'POST', body: huge(), duplex: 'half' } as RequestInit)
  assert.equal(hook.status, 400)
  assert.equal(pulled, 0, '⚠️ read the body without a signature header')
})

test('★★ logout discards the passphrase and also removes it from the relay ledger', async () => {
  const r = await rig()
  const { body } = await login(r)
  await r.call('/api/logout', { method: 'POST', headers: { authorization: `Bearer ${body.credential}` } })
  assert.equal(r.store.machines.size, 0)
  const mid = [...r.released][0]!.split(':')[2]
  assert.deepEqual(r.released, [`${body.account.id}:${KEY}:${mid}`])
  assert.equal((await license(r, body.credential)).status, 401)
})

test('★★ if relay cannot be reached, the passphrase is not deleted, 503 is returned, and it can be retried (codex round 27, high #3)', async () => {
  const r = await rig()
  const { body } = await login(r)
  r.relay.down = true
  const res = await r.call('/api/logout', { method: 'POST', headers: { authorization: `Bearer ${body.credential}` } })
  assert.equal(res.status, 503, '⚠️⚠️ answered "removed" although relay was not told')
  assert.equal(r.store.machines.size, 1, '⚠️⚠️ deleted the passphrase before relay was told (no way to retry)')
  // Same when removing from the page
  const cookie = await sessionCookie(r, body.account.id)
  const id = [...r.store.machines.values()][0]!.id
  const page = await r.call('/machines/revoke', { method: 'POST', body: new URLSearchParams({ id }), headers: { cookie, origin: ORIGIN } })
  assert.equal(page.headers.get('location'), '/?n=revoke-failed')
  assert.equal(r.store.machines.size, 1)
  assert.equal((await license(r, body.credential)).status, 200, '⚠️ tickets stopped although removal failed (contradicts "your sign-in is kept")')
  r.relay.down = false
  assert.equal((await r.call('/api/logout', { method: 'POST', headers: { authorization: `Bearer ${body.credential}` } })).status, 200)
  assert.equal(r.store.machines.size, 0)
})

test('★★ if a passphrase of the same machine remains, the relay ledger is not cleared', async () => {
  const r = await rig()
  const a = await login(r)
  await login(r)
  await r.call('/api/logout', { method: 'POST', headers: { authorization: `Bearer ${a.body.credential}` } })
  assert.equal(r.released.length, 1, '⚠️ the passphrase number was not sent to relay (that ticket keeps passing)')
  // ★ Whether to free the slot is decided by relay's ledger (not freed while a number in use remains / relay/src/ledger.test.ts)
})

// ── Web ──────────────────────────────────────────────────────────────────

async function sessionCookie(r: Awaited<ReturnType<typeof rig>>, acct: string) {
  return `${SESSION_COOKIE}=${await makeSession(r.d.config.sessionSecret, acct, T / 1000)}`
}

test('★★ Sign in with GitHub: refused if state does not match the cookie (nobody can push their sign-in onto someone else)', async () => {
  const r = await rig()
  const start = await r.call('/auth/github')
  assert.equal(start.status, 303)
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!
  const bad = await r.call(`/auth/github/callback?code=good-code&state=${state}`, { headers: { cookie: 'nr_oauth_state=other' } })
  assert.equal(bad.headers.get('location'), '/?e=login')
  const ok = await r.call(`/auth/github/callback?code=good-code&state=${state}`, { headers: { cookie: `nr_oauth_state=${state}` } })
  assert.equal(ok.headers.get('location'), '/')
  assert.match(ok.headers.get('set-cookie') ?? '', /nr_session=.+HttpOnly; Secure; SameSite=Lax/)
})

test('★★ page forms check Origin (other sites cannot trigger them)', async () => {
  const r = await rig()
  const { body } = await login(r)
  const cookie = await sessionCookie(r, body.account.id)
  const form = new URLSearchParams({ price: 'usd-year' })
  const evil = await r.call('/billing/checkout', { method: 'POST', body: form, headers: { cookie, origin: 'https://evil.example' } })
  assert.equal(evil.status, 403)
  const none = await r.call('/billing/checkout', { method: 'POST', body: form, headers: { cookie } })
  assert.equal(none.status, 403, '⚠️ passed without Origin')
  // ⚠️ Origin: null (depending on browser policy, attached even from our own page) is told apart by Sec-Fetch-Site
  const nullCross = await r.call('/billing/checkout', { method: 'POST', body: form, headers: { cookie, origin: 'null', 'sec-fetch-site': 'cross-site' } })
  assert.equal(nullCross.status, 403, '⚠️⚠️ triggered from elsewhere with Origin: null')
  const nullSame = await r.call('/billing/checkout', { method: 'POST', body: form, headers: { cookie, origin: 'null', 'sec-fetch-site': 'same-origin' } })
  assert.equal(nullSame.status, 303, '⚠️ refused Origin: null from our own page (the shape that became forbidden on a real device)')
  r.calls.length = 0
  const ok = await r.call('/billing/checkout', { method: 'POST', body: form, headers: { cookie, origin: ORIGIN } })
  assert.match(ok.headers.get('location') ?? '', /^https:\/\/checkout\.stripe\.com\/c\/cs_test_/)
  assert.deepEqual(r.calls.filter((c) => !c.startsWith('expire:')), [`checkout:price_uy:cus_1:${body.account.id}`], '⚠️ the second time does not recreate the customer')
  assert.equal(r.openCount(), 1, '★ the previous attempt is closed (only the last one can be paid)')
})

test('★★ starting a first purchase in two tabs at once still gives one customer (codex round 26, high #7)', async () => {
  const r = await rig()
  const { body } = await login(r)
  const cookie = await sessionCookie(r, body.account.id)
  const go = () => r.call('/billing/checkout', { method: 'POST', body: new URLSearchParams({ price: 'usd-month' }), headers: { cookie, origin: ORIGIN } })
  await Promise.all([go(), go()])
  const used = r.calls.filter((c) => c.startsWith('checkout:')).map((c) => c.split(':')[2])
  assert.deepEqual([...new Set(used)], ['cus_1'], '⚠️⚠️ created Checkouts with different customers (the paid one detaches from the account)')
  assert.equal(r.store.accounts.get(body.account.id)!.stripeCustomer, 'cus_1')
})

test('★★ even if the idempotency key has no effect, the customer bound first is used (D1 binds only when absent + reads again)', async () => {
  const r = await rig()
  const { body } = await login(r)
  await r.store.setCustomerIfNone(body.account.id, 'cus_first')
  r.store.accounts.set(body.account.id, { ...r.store.accounts.get(body.account.id)!, stripeCustomer: undefined })
  r.stripeHooks.sameKeyNewCustomer = true
  // Another tab bound first (here the bound state is created first, then this tab creates)
  const orig = r.d.stripe.createCustomer
  r.d.stripe.createCustomer = async (o, k) => {
    await r.store.setCustomerIfNone(body.account.id, 'cus_first')
    return await orig(o, k)
  }
  const cookie = await sessionCookie(r, body.account.id)
  await r.call('/billing/checkout', { method: 'POST', body: new URLSearchParams({ price: 'usd-month' }), headers: { cookie, origin: ORIGIN } })
  assert.equal(r.store.accounts.get(body.account.id)!.stripeCustomer, 'cus_first', '⚠️⚠️ overwrote the customer bound first')
  assert.deepEqual(r.calls.filter((c) => c.startsWith('checkout:')).map((c) => c.split(':')[2]), ['cus_first'])
})

test('★★ starting Checkout in two tabs at once creates only one (lease / codex round 27, high #2)', async () => {
  const r = await rig()
  const { body } = await login(r)
  const cookie = await sessionCookie(r, body.account.id)
  const go = () => r.call('/billing/checkout', { method: 'POST', body: new URLSearchParams({ price: 'usd-month' }), headers: { cookie, origin: ORIGIN } })
  let release!: () => void
  let entered!: () => void
  const inside = new Promise<void>((ok) => (entered = ok))
  const gate = new Promise<void>((ok) => (release = ok))
  r.stripeHooks.beforeList = () => (entered(), gate)
  const first = go()
  await inside
  const second = await go()
  assert.equal(second.headers.get('location'), '/?n=busy', '⚠️⚠️ the second went to create a Checkout while the first was still checking')
  release()
  await first
  r.stripeHooks.beforeList = undefined
  assert.equal(r.calls.filter((c) => c.startsWith('checkout:')).length, 1)
  // ★ The lease is returned (the next one can create)
  assert.match((await go()).headers.get('location') ?? '', /^https:\/\/checkout\.stripe\.com\/c\//)
})

test('★★ no second purchase while a subscription exists, and open Checkouts are closed (codex round 26, high #8)', async () => {
  const r = await rig()
  const { body } = await login(r)
  const cookie = await sessionCookie(r, body.account.id)
  const go = () => r.call('/billing/checkout', { method: 'POST', body: new URLSearchParams({ price: 'usd-month' }), headers: { cookie, origin: ORIGIN } })
  r.addOpenCheckout('cus_1', 'cs_test_a')
  await go()
  assert.ok(r.calls.includes('expire:cs_test_a'), '⚠️ did not close the Checkout of the old tab')
  r.subs.set('cus_1', [{ id: 'sub_1', status: 'incomplete' }])
  r.calls.length = 0
  const again = await go()
  assert.equal(again.headers.get('location'), 'https://billing.stripe.com/p/1', '⚠️⚠️ created a second Checkout although a subscription exists')
  assert.deepEqual(r.calls.filter((c) => c.startsWith('checkout:')), [])
})

test('★★ unknown prices cannot be chosen, and a machine of someone else cannot be removed', async () => {
  const r = await rig()
  const me = await login(r)
  const other = await login(r, 'gho_other')
  const cookie = await sessionCookie(r, me.body.account.id)
  const bad = await r.call('/billing/checkout', { method: 'POST', body: new URLSearchParams({ price: 'free-forever' }), headers: { cookie, origin: ORIGIN } })
  assert.equal(bad.headers.get('location'), '/?n=bad-price')
  const theirs = [...r.store.machines.values()].find((m) => m.accountId === other.body.account.id)!
  await r.call('/machines/revoke', { method: 'POST', body: new URLSearchParams({ id: theirs.id }), headers: { cookie, origin: ORIGIN } })
  assert.ok(r.store.machines.has(theirs.id), '⚠️⚠️ removed a machine belonging to someone else')
})

test('★★ account page: text from outside is escaped', async () => {
  const r = await rig()
  const { body } = await login(r)
  const m = [...r.store.machines.values()][0]!
  r.store.machines.set(m.id, { ...m, label: '<img src=x onerror=alert(1)>' })
  await r.store.updateLogin(body.account.id, '<b>x</b>')
  const page = await (await r.call('/', { headers: { cookie: await sessionCookie(r, body.account.id) } })).text()
  assert.doesNotMatch(page, /<img src=x/)
  assert.doesNotMatch(page, /<b>x<\/b>/)
  assert.match(page, /&lt;img/)
})

// ── Stripe webhooks ────────────────────────────────────────────────────

function signed(body: string, secret = 'whsec_test', t = T / 1000) {
  const sig = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
  return { 'stripe-signature': `t=${t},v1=${sig}` }
}

const hook = (r: Awaited<ReturnType<typeof rig>>, id: string, type = 'customer.subscription.updated', customer = 'cus_1') => {
  const e = JSON.stringify({ id, type, data: { object: { id: 'sub_x', customer, status: 'ignored' } } })
  return r.call('/stripe/webhook', { method: 'POST', body: e, headers: signed(e) })
}
const planNow = async (r: Awaited<ReturnType<typeof rig>>, cred: string) => ((await (await license(r, cred)).json()) as { plan: string }).plan

test('★★ webhook: with a valid signature, re-read subscriptions from Stripe and decide the plan; otherwise do nothing', async () => {
  const r = await rig()
  const { body } = await login(r)
  await r.store.setCustomerIfNone(body.account.id, 'cus_1')
  r.subs.set('cus_1', [{ id: 'sub_1', status: 'active' }])
  const e1 = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.created', data: { object: { customer: 'cus_1' } } })
  assert.equal((await r.call('/stripe/webhook', { method: 'POST', body: e1, headers: signed(e1, 'wrong') })).status, 400)
  assert.equal(r.store.accounts.get(body.account.id)!.subscriptionStatus, undefined, '⚠️⚠️ changed the plan despite a bad signature')
  assert.equal((await r.call('/stripe/webhook', { method: 'POST', body: e1, headers: signed(e1) })).status, 200)
  const lic = (await (await license(r, body.credential)).json()) as { plan: string; maxMachines: number }
  assert.equal(lic.plan, 'plus')
  assert.equal(lic.maxMachines, 5)
  // Cancellation (⚠️ event contents are not looked at = the list is authoritative)
  r.subs.set('cus_1', [{ id: 'sub_1', status: 'canceled' }])
  r.advance(1)
  await hook(r, 'evt_2', 'customer.subscription.deleted')
  assert.equal(await planNow(r, body.credential), 'free')
  // ★ Even if the same event is resent, the result is the same while the list is unchanged (idempotent)
  r.advance(1)
  await hook(r, 'evt_1', 'customer.subscription.created')
  assert.equal(await planNow(r, body.credential), 'free')
})

test('★★ webhook: old signatures (over 5 minutes) are refused, and payment retrying stays Plus', async () => {
  const r = await rig()
  const { body } = await login(r)
  await r.store.setCustomerIfNone(body.account.id, 'cus_1')
  r.subs.set('cus_1', [{ id: 'sub_1', status: 'past_due' }])
  const e = JSON.stringify({ id: 'evt_9', type: 'customer.subscription.updated', data: { object: { customer: 'cus_1' } } })
  assert.equal((await r.call('/stripe/webhook', { method: 'POST', body: e, headers: signed(e, 'whsec_test', T / 1000 - 301) })).status, 400)
  await r.call('/stripe/webhook', { method: 'POST', body: e, headers: signed(e) })
  assert.equal(await planNow(r, body.credential), 'plus')
})

test('★★ webhook: a failure midway returns 500 and is applied on resend (codex round 26, high #5)', async () => {
  const r = await rig()
  const { body } = await login(r)
  await r.store.setCustomerIfNone(body.account.id, 'cus_1')
  r.subs.set('cus_1', [{ id: 'sub_1', status: 'active' }])
  r.stripeHooks.beforeList = async () => {
    throw new Error('stripe down')
  }
  assert.equal((await hook(r, 'evt_1')).status, 500)
  r.stripeHooks.beforeList = undefined
  r.advance(1)
  assert.equal((await hook(r, 'evt_1')).status, 200)
  assert.equal(await planNow(r, body.credential), 'plus', '⚠️⚠️ the resend was dropped as "processed"')
})

test('★★ webhook: even when processed concurrently, the list whose read started later remains (codex round 26, high #6)', async () => {
  const r = await rig()
  const { body } = await login(r)
  await r.store.setCustomerIfNone(body.account.id, 'cus_1')
  // The first stops right after reading "active"
  r.subs.set('cus_1', [{ id: 'sub_1', status: 'active' }])
  let release!: () => void
  let entered!: () => void
  const inside = new Promise<void>((ok) => (entered = ok))
  const gate = new Promise<void>((ok) => (release = ok))
  r.stripeHooks.beforeList = () => (entered(), gate)
  const slow = hook(r, 'evt_old')
  await inside
  // Meanwhile it is cancelled, and the second reads "canceled" and writes first
  r.stripeHooks.beforeList = undefined
  r.subs.set('cus_1', [{ id: 'sub_1', status: 'canceled' }])
  // ⚠️ The same millisecond (the clock does not advance = reproduces round 27, high #4)
  const second = await hook(r, 'evt_new', 'customer.subscription.deleted')
  assert.equal(second.status, 503, '★ a notification arriving during a re-read gets 503 (Stripe resends)')
  release()
  assert.equal((await slow).status, 200)
  assert.equal(await planNow(r, body.credential), 'free', '⚠️⚠️ a stale active written late undid the cancellation')
})

test('★★ webhook: with two subscriptions, cancelling one does not lose Plus, and the page reports double billing (codex round 26, high #8)', async () => {
  const r = await rig()
  const { body } = await login(r)
  await r.store.setCustomerIfNone(body.account.id, 'cus_1')
  r.subs.set('cus_1', [
    { id: 'sub_m', status: 'active' },
    { id: 'sub_y', status: 'active' },
  ])
  await hook(r, 'evt_1')
  const page = await (await r.call('/', { headers: { cookie: await sessionCookie(r, body.account.id), 'accept-language': 'en' } })).text()
  assert.match(page, /2 subscriptions/)
  r.subs.set('cus_1', [
    { id: 'sub_m', status: 'canceled' },
    { id: 'sub_y', status: 'active' },
  ])
  r.advance(1)
  await hook(r, 'evt_2', 'customer.subscription.deleted')
  assert.equal(await planNow(r, body.credential), 'plus', '⚠️⚠️ cancelling one also removed the Plus of the other one still being paid')
  assert.equal(r.store.accounts.get(body.account.id)!.subscriptionCount, 1)
})

test('★★ webhook: an account with no bound customer yet is looked up from the mark we attached', async () => {
  const r = await rig()
  const { body } = await login(r)
  r.subs.set('cus_9', [{ id: 'sub_1', status: 'active' }])
  const e = JSON.stringify({ id: 'evt_c', type: 'checkout.session.completed', data: { object: { customer: 'cus_9', client_reference_id: body.account.id } } })
  await r.call('/stripe/webhook', { method: 'POST', body: e, headers: signed(e) })
  assert.equal(r.store.accounts.get(body.account.id)!.stripeCustomer, 'cus_9')
  assert.equal(await planNow(r, body.credential), 'plus')
})

test('★★ the Stripe list follows continuations (sync does not stop beyond 100 items / codex round 27, medium #8)', async () => {
  const { stripeApi } = await import('./stripe.ts')
  const pages = [
    { data: Array.from({ length: 100 }, (_, i) => ({ id: `sub_${i}`, status: 'canceled' })), has_more: true },
    { data: [{ id: 'sub_live', status: 'active' }], has_more: false },
  ]
  const seen: string[] = []
  const api = stripeApi('rk_test', async (url) => {
    seen.push(url)
    return new Response(JSON.stringify(pages.shift()))
  })
  const subs = await api.listSubscriptions('cus_1')
  assert.equal(subs.length, 101)
  assert.match(seen[1]!, /starting_after=sub_99/)
})

test('★★ a Checkout half-made by a previous holder whose lease expired is recovered with the same key and closed by the successor (codex round 28, high #1)', async () => {
  const r = await rig()
  const { body } = await login(r)
  const cookie = await sessionCookie(r, body.account.id)
  const go = () => r.call('/billing/checkout', { method: 'POST', body: new URLSearchParams({ price: 'usd-month' }), headers: { cookie, origin: ORIGIN } })
  // A stops right before creating (Stripe is slow) ⇒ the lease expires meanwhile
  let release!: () => void
  let entered!: () => void
  const inside = new Promise<void>((ok) => (entered = ok))
  const gate = new Promise<void>((ok) => (release = ok))
  r.stripeHooks.beforeCreate = () => (entered(), gate)
  const a = go()
  await inside
  r.stripeHooks.beforeCreate = undefined
  r.advance(31_000)
  const b = await go()
  assert.match(b.headers.get('location') ?? '', /cs_test_/)
  release()
  await a
  assert.equal(r.openCount(), 1, '⚠️⚠️ two payable Checkouts exist (double subscription)')
})

test('★★ if the old Checkout being closed had been paid, go to billing management without creating a second (codex round 28, high #2)', async () => {
  const r = await rig()
  const { body } = await login(r)
  const cookie = await sessionCookie(r, body.account.id)
  await r.store.setCustomerIfNone(body.account.id, 'cus_1')
  r.addOpenCheckout('cus_1', 'cs_test_old')
  r.stripeHooks.paidBeforeExpire = 'cs_test_old'
  r.calls.length = 0
  const res = await r.call('/billing/checkout', { method: 'POST', body: new URLSearchParams({ price: 'usd-month' }), headers: { cookie, origin: ORIGIN } })
  assert.equal(res.headers.get('location'), 'https://billing.stripe.com/p/1', '⚠️⚠️ created a second although the old Checkout was paid')
  assert.deepEqual(r.calls.filter((c) => c.startsWith('checkout:')), [])
})

test('★★ a long list is read to the end while extending the lease (codex round 28, medium #6)', async () => {
  const r = await rig()
  const { body } = await login(r)
  await r.store.setCustomerIfNone(body.account.id, 'cus_1')
  r.subs.set('cus_1', [{ id: 'sub_1', status: 'active' }])
  const orig = r.d.stripe.listSubscriptions
  r.d.stripe.listSubscriptions = async (c, onPage) => {
    // 3 pages, 20 seconds per page (60 in total, over the 30-second lease)
    for (let i = 0; i < 3; i++) {
      await onPage?.()
      r.advance(20_000)
    }
    return await orig(c)
  }
  assert.equal((await hook(r, 'evt_long')).status, 200, '⚠️⚠️ with a list longer than the lease, sync fails forever')
  assert.equal(await planNow(r, body.credential), 'plus')
})

test('★★ a passphrase being removed gets no ticket and no key is bound (codex round 28, medium #4)', async () => {
  const r = await rig()
  const { body } = await login(r, 'gho_good', null)
  const m = [...r.store.machines.values()][0]!
  await r.store.markDeleting(body.account.id, m.id)
  assert.equal((await license(r, body.credential)).status, 401, '⚠️⚠️ issued a ticket although it is being removed')
  assert.equal(r.store.machines.get(m.id)!.agentKey, undefined, '⚠️ bound a key while it was being removed')
})

test('★★ a passphrase about to be deleted (unused for 89 days) gets no ticket (codex round 28, medium #4)', async () => {
  const r = await rig()
  const { body } = await login(r)
  r.advance(MACHINE_REFUSE_MS + 1)
  assert.equal((await license(r, body.credential)).status, 401)
})

test('★★ a Checkout that could not be closed returns its current state (paid ⇒ complete)', async () => {
  const { stripeApi } = await import('./stripe.ts')
  const api = stripeApi('rk_test', async (url, init) =>
    init.method === 'POST' ? new Response('{}', { status: 400 }) : new Response(JSON.stringify({ id: 'cs_x', status: url.endsWith('cs_paid') ? 'complete' : 'open' })),
  )
  assert.equal(await api.expireCheckout('cs_paid'), 'complete')
  await assert.rejects(api.expireCheckout('cs_open'), '⚠️ claimed it was closed although it is still open')
})

test('★★ if removal starts while a ticket is being issued, refuse without binding the key (codex round 28, medium #4)', async () => {
  const r = await rig()
  const { body } = await login(r, 'gho_good', null)
  const m = [...r.store.machines.values()][0]!
  const bind = r.store.bindMachineKey
  // After the ticket side read the row and before binding the key, the remover set the mark
  r.store.bindMachineKey = async (id, key) => {
    await r.store.markDeleting(body.account.id, m.id)
    await bind(id, key)
  }
  assert.equal((await license(r, body.credential)).status, 401, '⚠️⚠️ issued a ticket although removal had started')
  assert.equal(r.store.machines.get(m.id)!.agentKey, undefined, '⚠️⚠️ bound a key after removal started (disagrees with the "no key" the remover read)')
})

/** ★ Build an attempt whose lease expired and whose created id could not be written (only key and values remain in D1) */
async function strandedAttempt(r: Awaited<ReturnType<typeof rig>>, acct: string) {
  const cookie = await sessionCookie(r, acct)
  await r.call('/billing/checkout', { method: 'POST', body: new URLSearchParams({ price: 'usd-month' }), headers: { cookie, origin: ORIGIN } })
  const a = r.store.accounts.get(acct)!
  const { checkoutSession: _s, ...rest } = a
  r.store.accounts.set(acct, rest)
  return cookie
}

test('★★ even if price settings change, the previous attempt is recovered with the values written down (codex round 29, medium #3)', async () => {
  const r = await rig()
  const { body } = await login(r)
  const cookie = await strandedAttempt(r, body.account.id)
  r.d.config.prices['usd-month'] = 'price_changed'
  const res = await r.call('/billing/checkout', { method: 'POST', body: new URLSearchParams({ price: 'usd-month' }), headers: { cookie, origin: ORIGIN } })
  assert.match(res.headers.get('location') ?? '', /cs_test_/, '⚠️⚠️ purchasing broke after changing settings')
  assert.ok(!r.calls.includes('replay-mismatch'), '⚠️ used current settings for the retry (Stripe refuses it)')
  assert.equal(r.openCount(), 1)
})

test('★★ if the retry is "a settled failure" (4xx), move on and close the previous Checkout (codex round 29, medium #4)', async () => {
  const r = await rig()
  const { body } = await login(r)
  const cookie = await strandedAttempt(r, body.account.id)
  r.stripeHooks.replayStatus = 400
  const res = await r.call('/billing/checkout', { method: 'POST', body: new URLSearchParams({ price: 'usd-month' }), headers: { cookie, origin: ORIGIN } })
  assert.match(res.headers.get('location') ?? '', /cs_test_/, '⚠️⚠️ the earlier failure keeps coming back and purchase is impossible')
  assert.equal(r.openCount(), 1, '⚠️⚠️ the Checkout of the previous attempt is still open (double subscription)')
})

test('★★ if the retry is 409 (the previous holder is still creating it), do not create and say "wait a moment"', async () => {
  const r = await rig()
  const { body } = await login(r)
  const cookie = await strandedAttempt(r, body.account.id)
  r.stripeHooks.replayStatus = 409
  const res = await r.call('/billing/checkout', { method: 'POST', body: new URLSearchParams({ price: 'usd-month' }), headers: { cookie, origin: ORIGIN } })
  assert.equal(res.headers.get('location'), '/?n=busy')
  assert.equal(r.openCount(), 1)
})

test('★★ if the retry outcome is unknown (5xx, network cut), keep the attempt and stop (codex round 30, high #1)', async () => {
  for (const status of [500, 0]) {
    const r = await rig()
    const { body } = await login(r)
    const cookie = await strandedAttempt(r, body.account.id)
    const key = r.store.accounts.get(body.account.id)!.checkoutKey
    if (status) r.stripeHooks.replayStatus = status
    else {
      const orig = r.d.stripe.createCheckout
      r.d.stripe.createCheckout = async (o, k) => {
        if (k === key) throw new TypeError('network')
        return await orig(o, k)
      }
    }
    const res = await r.call('/billing/checkout', { method: 'POST', body: new URLSearchParams({ price: 'usd-month' }), headers: { cookie, origin: ORIGIN } })
    assert.equal(res.headers.get('location'), '/?n=busy', `⚠️⚠️ moved on after a failure with unknown outcome (${status || 'network'}) (double subscription)`)
    assert.equal(r.store.accounts.get(body.account.id)!.checkoutKey, key, '⚠️ deleted the attempt (cannot be recovered next time)')
  }
})

test('★★ if the lease was lost right before creating, do not create; if the id cannot be written after creating, do not hand out the URL (codex round 30, high #1)', async () => {
  const r = await rig()
  const { body } = await login(r)
  const cookie = await sessionCookie(r, body.account.id)
  const renew = r.store.renewLease
  let n = 0
  // The lease is lost at the extension after writing the attempt (right before creating)
  r.store.renewLease = async (...a) => ((n += 1), r.stripeHooks.beforeCreate ? false : renew(...a))
  const setAttempt = r.store.setCheckoutAttempt
  r.store.setCheckoutAttempt = async (id, token, attempt, now) => {
    const ok = await setAttempt(id, token, attempt, now)
    if (attempt && !attempt.session) r.stripeHooks.beforeCreate = async () => {}
    return ok
  }
  const res = await r.call('/billing/checkout', { method: 'POST', body: new URLSearchParams({ price: 'usd-month' }), headers: { cookie, origin: ORIGIN } })
  assert.doesNotMatch(res.headers.get('location') ?? '', /cs_test_/, '⚠️⚠️ created a Checkout despite losing the lease')
  assert.equal(r.openCount(), 0)
})

test('★★ if the id cannot be written after creating (lease expired), that URL is not handed out (the next holder recovers and closes it)', async () => {
  const r = await rig()
  const { body } = await login(r)
  const cookie = await sessionCookie(r, body.account.id)
  const setAttempt = r.store.setCheckoutAttempt
  r.store.setCheckoutAttempt = async (id, token, attempt, now) => (attempt?.session ? false : setAttempt(id, token, attempt, now))
  const res = await r.call('/billing/checkout', { method: 'POST', body: new URLSearchParams({ price: 'usd-month' }), headers: { cookie, origin: ORIGIN } })
  assert.equal(res.headers.get('location'), '/?n=busy', '⚠️⚠️ handed out the URL of a Checkout the next holder will close')
})

test('★★ even if Stripe keeps returning the earlier 500, move on once enough time has passed (the previous Checkout is closed / codex round 31, medium #1)', async () => {
  const r = await rig()
  const { body } = await login(r)
  const cookie = await strandedAttempt(r, body.account.id)
  r.stripeHooks.replayStatus = 500
  const go = () => r.call('/billing/checkout', { method: 'POST', body: new URLSearchParams({ price: 'usd-month' }), headers: { cookie, origin: ORIGIN } })
  assert.equal((await go()).headers.get('location'), '/?n=busy', '★ does not move on right away (the previous creation may still be in progress)')
  r.advance(ATTEMPT_SETTLE_MS + 1)
  assert.match((await go()).headers.get('location') ?? '', /cs_test_/, '⚠️⚠️ purchase never comes back because of the earlier 500')
  assert.equal(r.openCount(), 1, '⚠️⚠️ the Checkout of the previous attempt was not closed (double subscription)')
})

// ── Ops watcher (ops.ts / 2026-09-25) ──────────────────────────────────

// ★ Most relay traffic is WebSocket messages (billed 20:1); `http` (1:1) is a small share, like production
const usageDay = (date: string, requests: number, http = 0) => ({ date, workers: { 'nyan-relay': 1000 }, errors: 0, durableObjects: requests - 1000, doMessages: requests - 1000 - http, activeSec: 60 })

test('★★ /admin: only allowed GitHub ids can view it (others and signed-out users get "does not exist")', async () => {
  const r = await rig()
  const me = await login(r)
  const other = await login(r, 'gho_other')
  assert.equal((await r.call('/admin')).status, 404)
  r.d.config.adminGithubIds = [42]
  assert.equal((await r.call('/admin', { headers: { cookie: await sessionCookie(r, other.body.account.id) } })).status, 404, '⚠️⚠️ showed it to a non-operator')
  r.d.ops = { usage: async () => [usageDay('2026-09-24', 350_000)] }
  const page = await (await r.call('/admin', { headers: { cookie: await sessionCookie(r, me.body.account.id) } })).text()
  assert.match(page, /Accounts<\/div><div class="big">2</)
  assert.match(page, /Machines<\/div><div class="big">2</)
  assert.match(page, /class="hot"/, '★ spike days are highlighted')
  assert.match(page, /This month/)
  assert.doesNotMatch(page, /nyan<|other</, '⚠️ showed personal names on the ops page')
  // ★ Reachable from the account page, and can go back to the landing site
  const acct = await (await r.call('/', { headers: { cookie: await sessionCookie(r, me.body.account.id) } })).text()
  assert.match(acct, /href="\/admin"/)
  assert.match(acct, /href="https:\/\/nyan-remote.app\/"/)
  const theirs = await (await r.call('/', { headers: { cookie: await sessionCookie(r, other.body.account.id) } })).text()
  assert.doesNotMatch(theirs, /href="\/admin"/)
})

test('★★ usage watcher (paid plan): kinds whose monthly projection exceeds the included amount, and daily spikes, each reported once', async () => {
  const { runOps } = await import('./app.ts')
  const r = await rig()
  const sent: string[] = []
  let fail = false
  // T is 2027-01-15. This month (15 days) the DO gets 70k per day ⇒ projection 2.17M > included 1M
  const date = new Date(T).toISOString().slice(0, 10)
  const month = date.slice(0, 7)
  let perDay = 20_000
  // ⚠️ Plain (1:1) Durable Object requests here — WebSocket messages would bill at 20:1 and stay under the included amount
  const days = () => Array.from({ length: Number(date.slice(8, 10)) }, (_, i) => usageDay(`${month}-${String(i + 1).padStart(2, '0')}`, perDay, perDay - 1000))
  r.d.ops = {
    usage: async () => days(),
    sendAlert: async (subject) => {
      if (fail) throw new Error('mail down')
      sent.push(subject)
    },
  }
  assert.equal(await runOps(r.d), 0, '★ stays silent while the projection fits the included amount')
  perDay = 70_000
  fail = true
  await assert.rejects(runOps(r.d))
  fail = false
  assert.equal(await runOps(r.d), 1, '⚠️⚠️ remembered "alerted" although sending failed')
  assert.match(sent[0]!, /Durable Object requests \(billed\) projected over the included amount/)
  assert.equal(await runOps(r.d), 0, '⚠️ sent several times in the same month')
  // ★ Spikes are reported separately
  perDay = 400_000
  assert.ok(Number(await runOps(r.d)) >= 1)
  assert.ok(sent.some((x) => /Unusual Cloudflare traffic today/.test(x)))
  r.d.ops = { usage: async () => [] }
  assert.equal(await runOps(r.d), 'off', '★ does nothing if there is no way to send')
})

test('★★ monthly projection and overage cost (a copy of public pricing)', async () => {
  const { monthUsage, PAID_INCLUDED } = await import('./ops.ts')
  const now = Date.UTC(2026, 8, 10, 12)
  // ★ WebSocket messages bill 20:1 (codex round 33): 100k messages a day = 5k billed requests a day
  const ws = monthUsage(Array.from({ length: 10 }, (_, i) => usageDay(`2026-09-${String(i + 1).padStart(2, '0')}`, 101_000)), now)
  assert.equal(ws.used.doRequests, 50_000, '⚠️⚠️ WebSocket messages counted as full requests')
  assert.equal(ws.projectedOverageUsd, 0)
  // plain requests bill 1:1
  const days = Array.from({ length: 10 }, (_, i) => usageDay(`2026-09-${String(i + 1).padStart(2, '0')}`, 101_000, 100_000))
  const m = monthUsage(days, now)
  assert.equal(m.days, 10)
  assert.equal(m.daysInMonth, 30)
  assert.equal(m.used.doRequests, 1_000_000)
  assert.equal(m.projected.doRequests, 3_000_000)
  assert.ok(m.projected.doRequests > PAID_INCLUDED.doRequests)
  // DO requests exceed by 2M × $0.15 = $0.30 (the rest fits the included amounts)
  assert.equal(m.projectedOverageUsd.toFixed(2), '0.30')
  assert.equal(monthUsage(days, Date.UTC(2026, 9, 1)).used.doRequests, 0, '⚠️ counted last month into this month')
})

test('★ group the Cloudflare answer by day, and throw on a wrong shape', async () => {
  const { parseUsage } = await import('./ops.ts')
  const days = parseUsage({
    data: {
      viewer: {
        accounts: [
          {
            w: [
              { sum: { requests: 5, errors: 1 }, dimensions: { date: '2026-09-24', scriptName: 'nyan-relay' } },
              { sum: { requests: 3, errors: 0 }, dimensions: { date: '2026-09-24', scriptName: 'nyan-account' } },
            ],
            d: [
              { sum: { requests: 100 }, dimensions: { date: '2026-09-24', type: 'hibernation' } },
              { sum: { requests: 7 }, dimensions: { date: '2026-09-24', type: 'http' } },
            ],
            p: [{ sum: { activeTime: 2_500_000 }, dimensions: { date: '2026-09-24' } }],
          },
        ],
      },
    },
  })
  assert.deepEqual(days, [{ date: '2026-09-24', workers: { 'nyan-relay': 5, 'nyan-account': 3 }, errors: 1, durableObjects: 107, doMessages: 100, activeSec: 3 }])
  assert.throws(() => parseUsage({ errors: [{}] }))
})

test('★★ /admin test email: operators only, sent on success, failed on failure', async () => {
  const r = await rig()
  const me = await login(r)
  const other = await login(r, 'gho_other')
  r.d.config.adminGithubIds = [42]
  const sent: string[] = []
  let fail = false
  r.d.ops = { usage: async () => [], sendAlert: async (s) => { if (fail) throw new Error('x'); sent.push(s) } }
  const post = async (acct: string) => r.call('/admin/test-alert', { method: 'POST', headers: { cookie: await sessionCookie(r, acct), origin: ORIGIN } })
  assert.equal((await post(other.body.account.id)).status, 404)
  assert.equal((await post(me.body.account.id)).headers.get('location'), '/admin?n=sent')
  fail = true
  assert.equal((await post(me.body.account.id)).headers.get('location'), '/admin?n=failed')
  assert.equal(sent.length, 1)
  const evil = await r.call('/admin/test-alert', { method: 'POST', headers: { cookie: await sessionCookie(r, me.body.account.id), origin: 'https://evil.example' } })
  assert.equal(evil.status, 403)
})

test('★★ support: signed-in users only, operator address hidden, reply-to shape checked, up to 5 a day', async () => {
  const r = await rig()
  const { body } = await login(r)
  const cookie = await sessionCookie(r, body.account.id)
  const sent: { subject: string; text: string; replyTo?: string }[] = []
  r.d.config.alertTo = 'operator@example.com'
  r.d.ops = { usage: async () => [], sendAlert: async (subject, text, replyTo) => void sent.push({ subject, text, ...(replyTo ? { replyTo } : {}) }) }
  const post = (f: Record<string, string>, c = cookie) => r.call('/support', { method: 'POST', body: new URLSearchParams(f), headers: { cookie: c, origin: ORIGIN } })
  // Not signed in ⇒ cannot send
  assert.equal((await r.call('/support', { method: 'POST', body: new URLSearchParams({ message: 'hi' }), headers: { origin: ORIGIN } })).headers.get('location'), '/')
  assert.equal((await post({ message: '  ' })).headers.get('location'), '/?n=support-empty#support')
  assert.equal((await post({ message: 'hi', email: 'a@b.c\r\nBcc: x@y.z' })).headers.get('location'), '/?n=support-email#support', '⚠️⚠️ accepted a reply-to that smuggles newlines into headers')
  assert.equal((await post({ message: 'Help with billing', email: 'user@example.com' })).headers.get('location'), '/?n=support-sent#support')
  assert.equal(sent[0]!.replyTo, 'user@example.com')
  assert.match(sent[0]!.text, /GitHub id 42/)
  assert.match(sent[0]!.text, /Help with billing/)
  assert.match(sent[0]!.text, /^Name: \(not given\)$/m, '★ the name is optional')
  // ★ An optional name goes into the body as one line (newlines and control characters flattened)
  await post({ message: 'with a name', name: 'Taro\r\nBcc: x@y.z' })
  assert.match(sent[1]!.text, /^Name: Taro Bcc: x@y\.z$/m)
  for (let i = 0; i < 3; i++) await post({ message: `m${i}` })
  assert.equal((await post({ message: 'sixth' })).headers.get('location'), '/?n=support-limit#support', '⚠️ sent beyond the daily limit')
  assert.equal(sent.length, 5)
  r.advance(86400e3)
  assert.equal((await post({ message: 'next day' })).headers.get('location'), '/?n=support-sent#support')
  // ★ The page has the form, and the operator address is not shown
  const page = await (await r.call('/', { headers: { cookie } })).text()
  assert.match(page, /action="\/support"/)
  assert.doesNotMatch(page, /operator@example\.com/, '⚠️⚠️ the operator address reached the page')
  // ★ Folded by default; an error opens it with the message inside; "sent" stays folded and says so below it
  assert.match(page, /<details id="support">/)
  assert.match(page, /name="name"(?![^>]*required)/, '★ the name field is optional')
  const err = await (await r.call('/?n=support-empty', { headers: { cookie } })).text()
  assert.match(err, /<details id="support" open>[\s\S]*The message is empty\.[\s\S]*<\/details>/)
  // ⚠️ Inherited properties are not notices (`constructor` printed the Object function / codex)
  for (const n of ['constructor', '__proto__', 'toString']) {
    const pg = await (await r.call(`/?n=${n}`, { headers: { cookie } })).text()
    assert.doesNotMatch(pg, /native code|\[object Object\]|<p class="card">undefined/, `n=${n}`)
  }
  const ok = await (await r.call('/?n=support-sent', { headers: { cookie } })).text()
  assert.match(ok, /<details id="support">[\s\S]*<\/details>\s*<p class="card">Sent\./)
  assert.equal(ok.match(/Sent\./g)?.length, 1, 'the sent notice shows once')
})

test('★★★ contact form: parallel sends cannot exceed 5 a day, and a failed send gives its slot back (codex round 33)', async () => {
  const r = await rig()
  const { body } = await login(r)
  const cookie = await sessionCookie(r, body.account.id)
  let sent = 0
  let fail = false
  r.d.ops = { usage: async () => [], sendAlert: async () => { if (fail) throw new Error('x'); await new Promise((ok) => setTimeout(ok, 5)); sent++ } }
  const post = (m: string) => r.call('/support', { method: 'POST', body: new URLSearchParams({ message: m }), headers: { cookie, origin: ORIGIN } })
  fail = true
  assert.equal((await post('fails')).headers.get('location'), '/?n=support-failed#support')
  fail = false
  const all = await Promise.all(Array.from({ length: 8 }, (_, i) => post(`m${i}`)))
  assert.equal(all.filter((x) => x.headers.get('location') === '/?n=support-sent#support').length, 5, '⚠️⚠️ parallel sends went over the daily limit (or a failed send used up a slot)')
  assert.equal(sent, 5)
})

test('★ the account pages are English only, with the cat and the favicon from the PWA origin (2026-09-25)', async () => {
  const r = await rig()
  const { body } = await login(r)
  const ja = { 'accept-language': 'ja-JP,ja;q=0.9' }
  for (const res of [await r.call('/', { headers: ja }), await r.call('/', { headers: { ...ja, cookie: await sessionCookie(r, body.account.id) } })]) {
    const page = await res.text()
    assert.match(page, /<html lang="en">/)
    assert.doesNotMatch(page, /[぀-ヿ一-鿿]/, '⚠️ Japanese text on the account page')
    assert.match(page, /<link rel="icon" href="https:\/\/app\.nyan-remote\.app\/icons\/favicon-64\.png">/)
    assert.match(page, /<img src="https:\/\/app\.nyan-remote\.app\/icons\/icon-any-192\.png"/)
    // ⚠️ The images must stay inside what the CSP allows
    assert.match(res.headers.get('content-security-policy') ?? '', /img-src https:\/\/app\.nyan-remote\.app[;\s]/)
  }
})
