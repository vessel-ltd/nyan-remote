// ★ The account Worker (2026-09-24 / docs/BILLING.md). ⚠️ **Decisions are in `app.ts`**. This only wires Cloudflare's hooks (D1, secrets, relay's ledger).
//   ⚠️ Only this file uses `cloudflare:workers` (does not run from `npm test` = no decisions here / same practice as relay).

import { fromBase64Url } from '../../shared/crypto.ts'
import { signLicense, type License } from '../../shared/license.ts'
import { EmailMessage } from 'cloudflare:email'
import { handle, PRICE_CHOICES, runOps, type Deps, type PriceChoice } from './app.ts'
import { parseUsage, USAGE_QUERY } from './ops.ts'
import type { AccountRow, MachineRow, Store } from './store.ts'
import { stripeApi } from './stripe.ts'

interface RelayAccounts {
  /** ⚠️ Throws on failure (account does not delete the passphrase = can retry) */
  release(acct: string, key: string, mid: string): Promise<void>
}

export interface Env {
  DB: D1Database
  /** ★ relay's Account DO (`script_name: nyan-relay`). A removed machine is removed from the ledger too */
  ACCOUNTS: DurableObjectNamespace<RelayAccounts & Rpc.DurableObjectBranded>
  ORIGIN: string
  GITHUB_CLIENT_ID: string
  PRICE_USD_MONTH: string
  PRICE_USD_YEAR: string
  // ── secret（`wrangler secret put`）──
  GITHUB_CLIENT_SECRET: string
  STRIPE_SECRET_KEY: string
  STRIPE_WEBHOOK_SECRET: string
  SESSION_SECRET: string
  /** Ed25519 private key (PKCS#8 base64url / `scripts/license-keygen.mjs`) */
  LICENSE_PRIVATE_KEY: string
  // ── Ops watcher (ops.ts / 2026-09-25) ──
  /** Cloudflare account id (fine to publish) */
  CF_ACCOUNT_ID?: string
  /** ⚠️ secret: read-only token (Account Analytics: Read). Without it, usage is not shown */
  CF_ANALYTICS_TOKEN?: string
  /** GitHub ids allowed to view `/admin` (comma-separated) */
  ADMIN_GITHUB_IDS?: string
  /** Request count reported as a daily spike */
  SPIKE_DAILY_REQUESTS?: string
  /** Sender (an address on a domain with Email Routing enabled / e.g. alerts@nyan-remote.app) */
  ALERT_FROM?: string
  /** ⚠️ secret: recipient (an address verified in Email Routing / never written in code) */
  ALERT_TO?: string
  /** ★ Sending via Email Routing (⚠️ without it, alerts only go to the log) */
  ALERT_EMAIL?: SendEmail
}

type Row = Record<string, unknown>
const toAccount = (r: Row | null): AccountRow | undefined =>
  r
    ? {
        id: String(r['id']),
        githubId: Number(r['github_id']),
        githubLogin: String(r['github_login']),
        ...(r['stripe_customer'] ? { stripeCustomer: String(r['stripe_customer']) } : {}),
        ...(r['subscription_id'] ? { subscriptionId: String(r['subscription_id']) } : {}),
        ...(r['subscription_status'] ? { subscriptionStatus: String(r['subscription_status']) } : {}),
        ...(r['subscription_count'] != null ? { subscriptionCount: Number(r['subscription_count']) } : {}),
        ...(r['sync_wanted'] != null ? { syncWanted: Number(r['sync_wanted']) } : {}),
        ...(r['checkout_key'] ? { checkoutKey: String(r['checkout_key']) } : {}),
        ...(r['checkout_params'] ? { checkoutParams: String(r['checkout_params']) } : {}),
        ...(r['checkout_session'] ? { checkoutSession: String(r['checkout_session']) } : {}),
        created: Number(r['created']),
      }
    : undefined
const toMachine = (r: Row | null): MachineRow | undefined =>
  r
    ? {
        id: String(r['id']),
        accountId: String(r['account_id']),
        credHash: String(r['cred_hash']),
        label: String(r['label']),
        ...(r['agent_key'] ? { agentKey: String(r['agent_key']) } : {}),
        ...(r['deleting'] ? { deleting: true } : {}),
        created: Number(r['created']),
        lastSeen: Number(r['last_seen']),
      }
    : undefined

function d1Store(db: D1Database): Store {
  const one = (sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args).first<Row>()
  const run = (sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args).run()
  return {
    accountById: async (id) => toAccount(await one('SELECT * FROM accounts WHERE id = ?', id)),
    accountByGithub: async (g) => toAccount(await one('SELECT * FROM accounts WHERE github_id = ?', g)),
    accountByCustomer: async (c) => toAccount(await one('SELECT * FROM accounts WHERE stripe_customer = ?', c)),
    createAccount: async (a) => {
      await run('INSERT INTO accounts (id, github_id, github_login, created) VALUES (?, ?, ?, ?)', a.id, a.githubId, a.githubLogin, a.created)
    },
    updateLogin: async (id, login) => {
      await run('UPDATE accounts SET github_login = ? WHERE id = ?', login, id)
    },
    // ⚠️⚠️ Put the condition inside the SQL (reading and comparing in JS lets two concurrent calls read the same stale value / codex round 26, high #6 and #7)
    setCustomerIfNone: async (id, customer) => {
      await run('UPDATE accounts SET stripe_customer = ? WHERE id = ? AND stripe_customer IS NULL', customer, id)
    },
    acquireLease: async (id, token, now, ttl) => {
      const r = await run(
        'UPDATE accounts SET lease_token = ?, lease_until = ? WHERE id = ? AND (lease_until IS NULL OR lease_until < ?)',
        token,
        now + ttl,
        id,
        now,
      )
      return (r.meta.changes ?? 0) > 0
    },
    releaseLease: async (id, token) => {
      await run('UPDATE accounts SET lease_token = NULL, lease_until = NULL WHERE id = ? AND lease_token = ?', id, token)
    },
    renewLease: async (id, token, now, ttl) => {
      const r = await run('UPDATE accounts SET lease_until = ? WHERE id = ? AND lease_token = ? AND lease_until >= ?', now + ttl, id, token, now)
      return (r.meta.changes ?? 0) > 0
    },
    setCheckoutAttempt: async (id, token, attempt, now) => {
      const r = await run(
        'UPDATE accounts SET checkout_key = ?, checkout_params = ?, checkout_session = ? WHERE id = ? AND lease_token = ? AND lease_until >= ?',
        attempt?.key ?? null,
        attempt?.params ?? null,
        attempt?.session ?? null,
        id,
        token,
        now,
      )
      return (r.meta.changes ?? 0) > 0
    },
    bumpSync: async (id) => {
      await run('UPDATE accounts SET sync_wanted = COALESCE(sync_wanted, 0) + 1 WHERE id = ?', id)
    },
    // ⚠️⚠️ Write only while holding the lease (never overwrite with a stale read after it expired and someone else took it)
    writeSync: async (id, token, sum, now) => {
      const r = await run(
        'UPDATE accounts SET subscription_id = ?, subscription_status = ?, subscription_count = ? WHERE id = ? AND lease_token = ? AND lease_until >= ?',
        sum.subscriptionId ?? null,
        sum.subscriptionStatus ?? null,
        sum.subscriptionCount,
        id,
        token,
        now,
      )
      return (r.meta.changes ?? 0) > 0
    },
    machineByCred: async (h) => toMachine(await one('SELECT * FROM machines WHERE cred_hash = ?', h)),
    machineById: async (id) => toMachine(await one('SELECT * FROM machines WHERE id = ?', id)),
    machinesOf: async (acct) =>
      ((await db.prepare('SELECT * FROM machines WHERE account_id = ? ORDER BY created').bind(acct).all<Row>()).results ?? []).flatMap(
        (r) => toMachine(r) ?? [],
      ),
    // ⚠️⚠️ Count and insert in one statement (codex round 26, medium #10: went from 49 to 59 with 10 in parallel)
    createMachine: async (m, max) => {
      const r = await run(
        'INSERT INTO machines (id, account_id, cred_hash, label, agent_key, created, last_seen) SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM machines WHERE account_id = ?) < ?',
        m.id,
        m.accountId,
        m.credHash,
        m.label,
        m.agentKey ?? null,
        m.created,
        m.lastSeen,
        m.accountId,
        max,
      )
      return (r.meta.changes ?? 0) > 0
    },
    bindMachineKey: async (id, key) => {
      await run('UPDATE machines SET agent_key = ? WHERE id = ? AND agent_key IS NULL AND deleting IS NULL', key, id)
    },
    // ⚠️ Mark first, then read (D1 applies one statement at a time in order ⇒ no key can be bound after this)
    markDeleting: async (acct, id) => {
      await run('UPDATE machines SET deleting = 1 WHERE id = ? AND account_id = ?', id, acct)
      return toMachine(await one('SELECT * FROM machines WHERE id = ? AND account_id = ?', id, acct))
    },
    unmarkDeleting: async (acct, id) => {
      await run('UPDATE machines SET deleting = NULL WHERE id = ? AND account_id = ?', id, acct)
    },
    touchMachine: async (id, now) => {
      await run('UPDATE machines SET last_seen = ? WHERE id = ?', now, id)
    },
    deleteMachine: async (acct, id) => {
      const m = toMachine(await one('DELETE FROM machines WHERE id = ? AND account_id = ? RETURNING *', id, acct))
      return m
    },
    pruneMachines: async (acct, before) => {
      await run('DELETE FROM machines WHERE account_id = ? AND last_seen < ?', acct, before)
    },
    stats: async (now) => {
      const a = await one(
        "SELECT COUNT(*) AS n, SUM(created > ?) AS new7, SUM(subscription_status IN ('active','trialing','past_due')) AS plus, SUM(subscription_count > 1) AS dup FROM accounts",
        now - 7 * 86400e3,
      )
      const m = await one('SELECT COUNT(*) AS n, SUM(last_seen > ?) AS d1, SUM(last_seen > ?) AS d7 FROM machines', now - 86400e3, now - 7 * 86400e3)
      const num = (v: unknown) => Number(v ?? 0)
      return {
        accounts: num(a?.['n']),
        accountsNew7d: num(a?.['new7']),
        plus: num(a?.['plus']),
        duplicateSubs: num(a?.['dup']),
        machines: num(m?.['n']),
        machines24h: num(m?.['d1']),
        machines7d: num(m?.['d7']),
      }
    },
    alerted: async (key) => (await one('SELECT key FROM ops_alerts WHERE key = ?', key)) !== null,
    supportCount: async (acct, date) =>
      Number((await one("SELECT COUNT(*) AS n FROM ops_alerts WHERE key LIKE ? ESCAPE '\\'", `support:${acct.replace(/[\\%_]/g, '\\$&')}:${date}:%`))?.['n'] ?? 0),
    markAlert: async (key, now) => {
      const r = await run('INSERT OR IGNORE INTO ops_alerts (key, at) VALUES (?, ?)', key, now)
      return (r.meta.changes ?? 0) > 0
    },
  }
}

/** ★ Cloudflare usage (GraphQL Analytics / ⚠️ read-only token) */
async function cfUsage(env: Env, days: number) {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) throw new Error('not configured')
  const since = new Date(Date.now() - (days - 1) * 86400e3).toISOString().slice(0, 10)
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: USAGE_QUERY, variables: { a: env.CF_ACCOUNT_ID, s: since } }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`analytics ${res.status}`)
  return parseUsage(await res.json())
}

/** ★ Email to the operators (Email Routing send_email / ⚠️ the body is English numbers only = no user information) */
async function sendAlert(env: Env, subject: string, text: string, replyTo?: string) {
  if (!env.ALERT_EMAIL || !env.ALERT_FROM || !env.ALERT_TO) {
    // ⚠️ Never pretend success when it could not be sent (it would remember "reported" and stay silent next time too)
    throw new Error('email is not configured')
  }
  const raw = [
    `From: nyan-remote <${env.ALERT_FROM}>`,
    `To: ${env.ALERT_TO}`,
    // ⚠️ No newlines in the subject (the caller checks the shape, but drop them here too)
    `Subject: ${subject.replace(/[\r\n]+/g, ' ')}`,
    ...(replyTo && !/[\r\n]/.test(replyTo) ? [`Reply-To: ${replyTo}`] : []),
    `Message-ID: <${crypto.randomUUID()}@${env.ALERT_FROM.split('@')[1]}>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    text,
  ].join('\r\n')
  await env.ALERT_EMAIL.send(new EmailMessage(env.ALERT_FROM, env.ALERT_TO, raw))
}

const GH_HEADERS = { 'user-agent': 'nyan-remote-account', accept: 'application/vnd.github+json' }

let signingKey: Promise<Parameters<typeof crypto.subtle.sign>[1]> | undefined

function deps(env: Env): Deps {
  signingKey ??= crypto.subtle.importKey('pkcs8', fromBase64Url(env.LICENSE_PRIVATE_KEY), { name: 'Ed25519' }, false, ['sign'])
  const prices = {
    'usd-month': env.PRICE_USD_MONTH,
    'usd-year': env.PRICE_USD_YEAR,
  } satisfies Record<PriceChoice, string>
  void PRICE_CHOICES
  return {
    store: d1Store(env.DB),
    stripe: stripeApi(env.STRIPE_SECRET_KEY),
    github: {
      // ★★ GitHub's "Check a token": asked with our client id / secret ⇒ tokens of other apps give 404 (codex round 26, high #1)
      checkToken: async (token) => {
        const res = await fetch(`https://api.github.com/applications/${encodeURIComponent(env.GITHUB_CLIENT_ID)}/token`, {
          method: 'POST',
          headers: {
            ...GH_HEADERS,
            'content-type': 'application/json',
            authorization: `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}`,
          },
          body: JSON.stringify({ access_token: token }),
        })
        if (!res.ok) return undefined
        const j = (await res.json()) as { user?: { id?: unknown; login?: unknown }; app?: { client_id?: unknown } }
        if (j.app?.client_id !== env.GITHUB_CLIENT_ID) return undefined
        const u = j.user
        return typeof u?.id === 'number' && typeof u.login === 'string' ? { id: u.id, login: u.login } : undefined
      },
      exchange: async (code) => {
        const res = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { ...GH_HEADERS, accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code }),
        })
        const j = (await res.json().catch(() => ({}))) as { access_token?: unknown }
        return typeof j.access_token === 'string' ? j.access_token : undefined
      },
    },
    signLicense: async (l: License) => signLicense(l, await signingKey!),
    releaseMachine: async (acct, key, mid) => {
      await env.ACCOUNTS.getByName(acct).release(acct, key, mid)
    },
    now: () => Date.now(),
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    config: {
      origin: env.ORIGIN,
      githubClientId: env.GITHUB_CLIENT_ID,
      sessionSecret: env.SESSION_SECRET,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      prices,
      adminGithubIds: (env.ADMIN_GITHUB_IDS ?? '')
        .split(',')
        .map((x) => Number(x.trim()))
        .filter((x) => Number.isInteger(x) && x > 0),
      ...(env.SPIKE_DAILY_REQUESTS ? { spikeDailyRequests: Number(env.SPIKE_DAILY_REQUESTS) } : {}),
      ...(env.ALERT_TO ? { alertTo: env.ALERT_TO } : {}),
    },
    ops: {
      usage: (days) => cfUsage(env, days),
      sendAlert: (subject, text, replyTo) => sendAlert(env, subject, text, replyTo),
    },
  }
}

export default {
  fetch: (request: Request, env: Env) => handle(request, deps(env)),
  // ★ Hourly watcher (a / `runOps` in `app.ts`)
  scheduled: async (_c: ScheduledController, env: Env) => {
    try {
      console.log('[ops]', await runOps(deps(env)))
    } catch (err) {
      console.error('[ops] failed', err instanceof Error ? err.message : String(err))
    }
  },
} satisfies ExportedHandler<Env>
