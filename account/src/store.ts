// ★★ Storage interface for accounts (2026-09-24 / docs/BILLING.md §2.1).
//   The real one is D1 (`worker.ts`), tests use memory (`memoryStore`). ⚠️ Decisions go in `app.ts`; this only reads and writes.
//
// ⚠️ It keeps the minimum: GitHub id and login name, Stripe customer / subscription, the list of machines.
//    **No email, no password, no GitHub token** (keep nothing that could leak).
// ⚠️ Machine passphrases are stored **as hashes only** (`credHash`).

import type { Plan } from '../../shared/license.ts'
import type { Stats } from './ops.ts'

export interface AccountRow {
  /** An unguessable id (carried in the ticket's `acct`) */
  id: string
  githubId: number
  githubLogin: string
  stripeCustomer?: string
  /** The subscription that decided the plan (⚠️ with several, the one in the best state) */
  subscriptionId?: string
  /** Stripe subscription status (`active` / `past_due` / `canceled` …). ⚠️ A value decided from the subscription list */
  subscriptionStatus?: string
  /**
   * ★★ Number of live subscriptions (2026-09-24 / codex round 26, high #8). ⚠️ 2 or more = paying twice ⇒ the page tells the user.
   */
  subscriptionCount?: number
  /**
   * ★★ How many times a re-read of subscriptions is requested (incremented on every webhook / codex round 27, high #4).
   *   ⚠️ The re-reader remembers the value before starting, and if it changed after writing, **reads again**.
   */
  syncWanted?: number
  /**
   * ★★ The Checkout attempt currently in progress (idempotency key and price / 2026-09-24 / codex round 28, high #1).
   *   ⚠️ Written **before** creating ⇒ whoever takes over the lease calls again with the same key, recovers **the same Checkout**, closes it and then makes the next one.
   */
  checkoutKey?: string
  /** The exact values it was created with (JSON / ⚠️ a retry uses the same values even if settings change / codex round 29, medium #3) */
  checkoutParams?: string
  /** ★ The id of the created Checkout (⚠️ if known, close by id instead of calling again) */
  checkoutSession?: string
  created: number
}

/** ★ A half-made Checkout (`session` is written after it was created) */
export interface CheckoutAttempt {
  key: string
  params: string
  session?: string
}

/** ★ Values to write to the account, decided from the subscription list */
export interface SubscriptionSummary {
  subscriptionId?: string
  subscriptionStatus?: string
  subscriptionCount: number
}

export interface MachineRow {
  id: string
  accountId: string
  /** SHA-256 of the passphrase (base64url) */
  credHash: string
  label: string
  /** The agent's public key (the key in relay's ledger = told to relay when removing) */
  agentKey?: string
  /**
   * ★★ Being removed (2026-09-24 / codex round 28, medium #4). ⚠️ Once marked, no tickets are issued and no key is bound
   *   ⇒ the key the remover read and the key the ticket issuer uses always match (in the gap where they did not, tickets escaping revocation were issued).
   */
  deleting?: boolean
  created: number
  lastSeen: number
}

export interface Store {
  accountById(id: string): Promise<AccountRow | undefined>
  accountByGithub(githubId: number): Promise<AccountRow | undefined>
  accountByCustomer(customer: string): Promise<AccountRow | undefined>
  createAccount(row: AccountRow): Promise<void>
  /** ⚠️ Only the GitHub login name (billing values are written with their own dedicated conditional writes) */
  updateLogin(id: string, githubLogin: string): Promise<void>
  /** ★★ Bind a customer **only when there is none yet** (codex round 26, high #7). ⚠️ Read again after calling and use whichever remained */
  setCustomerIfNone(id: string, customer: string): Promise<void>
  /**
   * ★★ Per-account lease (2026-09-24 / codex round 27, high #2 and #4). Only one holder while reading Stripe / creating a Checkout.
   *   ⚠️ true if acquired. ⚠️ Time-limited (the lease of someone who crashed does not linger). ⚠️ The condition is inside a single statement (do not read then compare).
   */
  acquireLease(id: string, token: string, now: number, ttlMs: number): Promise<boolean>
  releaseLease(id: string, token: string): Promise<void>
  /** ★ Extend the lease (⚠️ only our own lease and only while it has not expired = false if expired) */
  renewLease(id: string, token: string, now: number, ttlMs: number): Promise<boolean>
  /** ★ Write / clear the in-progress Checkout attempt (⚠️ only while holding the lease) */
  setCheckoutAttempt(id: string, token: string, attempt: CheckoutAttempt | undefined, now: number): Promise<boolean>
  /** ★ Increment the requested re-read count by one */
  bumpSync(id: string): Promise<void>
  /** ★★ Write the subscription state. ⚠️ **Only while holding the lease** (true if written) */
  writeSync(id: string, token: string, s: SubscriptionSummary, now: number): Promise<boolean>
  machineByCred(credHash: string): Promise<MachineRow | undefined>
  machinesOf(accountId: string): Promise<MachineRow[]>
  /** ★★ Add one. ⚠️ Only when that account has fewer than `max` machines (**in a single operation** = concurrent calls cannot exceed it / codex round 26, medium #10) */
  createMachine(row: MachineRow, max: number): Promise<boolean>
  /** ★★ Bind the machine key **only when there is none yet and it is not being removed** (the first key bound wins / codex round 26, high #3 and medium #9) */
  bindMachineKey(id: string, agentKey: string): Promise<void>
  /** ★★ Mark as being removed and return the rows after marking (⚠️ only machines of that account) */
  markDeleting(accountId: string, id: string): Promise<MachineRow | undefined>
  /** ⚠️ If removal failed, unmark it (keeps the sign-in = keeps issuing tickets) */
  unmarkDeleting(accountId: string, id: string): Promise<void>
  machineById(id: string): Promise<MachineRow | undefined>
  touchMachine(id: string, now: number): Promise<void>
  /** ⚠️ Delete only machines of that account (never delete when given the id of someone else's machine) */
  deleteMachine(accountId: string, id: string): Promise<MachineRow | undefined>
  /** ★ Delete machines unused for a long time (⚠️ so passphrases do not linger on the server / codex round 26, medium #12) */
  pruneMachines(accountId: string, lastSeenBefore: number): Promise<void>
  /** ★ Counts for the ops page (`/admin` / ops.ts) */
  stats(now: number): Promise<Stats>
  /** ★ Already alerted? (⚠️ each alert only once). `markAlert` returns true the first time */
  alerted(key: string): Promise<boolean>
  markAlert(key: string, now: number): Promise<boolean>
  /** ★ Number of support messages that day (counts `support:<acct>:<date>:` marks) */
  supportCount(accountId: string, date: string): Promise<number>
}

/**
 * ★★ The plan is decided from the Stripe subscription status (**this one place**).
 *   ⚠️ `past_due` (payment retrying) stays Plus (do not drop it right away / docs/BILLING.md §2.1).
 */
export function planOf(a: AccountRow | undefined): Plan {
  return paidStatus(a?.subscriptionStatus) ? 'plus' : 'free'
}

const paidStatus = (s: string | undefined) => s === 'active' || s === 'trialing' || s === 'past_due'
/** ⚠️ Subscriptions not yet ended (even if unpaid, do not let them buy another) */
export const OPEN_STATUSES = ['active', 'trialing', 'past_due', 'incomplete', 'unpaid'] as const

/**
 * ★★ Decide the account state from the subscription list (codex round 26, high #8).
 *   ⚠️ Overwriting one state per event meant that, with two subscriptions, **cancelling one also removed the other's Plus**.
 *   ⇒ Decide by the subscription in the best state, and count the live ones.
 */
export function summarize(subs: { id: string; status: string }[]): SubscriptionSummary {
  const rank = (s: string) => ['active', 'trialing', 'past_due', 'unpaid', 'incomplete'].indexOf(s)
  const open = subs.filter((s) => (OPEN_STATUSES as readonly string[]).includes(s.status))
  const best = [...open].sort((a, b) => rank(a.status) - rank(b.status))[0]
  if (best) return { subscriptionId: best.id, subscriptionStatus: best.status, subscriptionCount: open.length }
  const last = subs[0]
  return { ...(last ? { subscriptionId: last.id, subscriptionStatus: last.status } : {}), subscriptionCount: 0 }
}

/** For tests (⚠️ never used from production) */
export function memoryStore(): Store & { accounts: Map<string, AccountRow>; machines: Map<string, MachineRow> } {
  const accounts = new Map<string, AccountRow>()
  const machines = new Map<string, MachineRow>()
  const leases = new Map<string, { token: string; until: number }>()
  const alerts = new Set<string>()
  const find = <T>(m: Map<string, T>, f: (v: T) => boolean) => [...m.values()].find(f)
  return {
    accounts,
    machines,
    accountById: async (id) => accounts.get(id),
    accountByGithub: async (g) => find(accounts, (a) => a.githubId === g),
    accountByCustomer: async (c) => find(accounts, (a) => a.stripeCustomer === c),
    createAccount: async (row) => void accounts.set(row.id, { ...row }),
    updateLogin: async (id, githubLogin) => {
      const a = accounts.get(id)
      if (a) accounts.set(id, { ...a, githubLogin })
    },
    setCustomerIfNone: async (id, stripeCustomer) => {
      const a = accounts.get(id)
      if (a && !a.stripeCustomer) accounts.set(id, { ...a, stripeCustomer })
    },
    acquireLease: async (id, token, now, ttl) => {
      const l = leases.get(id)
      if (!accounts.has(id) || (l && l.until >= now)) return false
      leases.set(id, { token, until: now + ttl })
      return true
    },
    releaseLease: async (id, token) => {
      if (leases.get(id)?.token === token) leases.delete(id)
    },
    renewLease: async (id, token, now, ttl) => {
      const l = leases.get(id)
      if (l?.token !== token || l.until < now) return false
      leases.set(id, { token, until: now + ttl })
      return true
    },
    setCheckoutAttempt: async (id, token, attempt, now) => {
      const a = accounts.get(id)
      const l = leases.get(id)
      if (!a || l?.token !== token || l.until < now) return false
      const { checkoutKey: _k, checkoutParams: _p, checkoutSession: _s, ...rest } = a
      accounts.set(id, {
        ...rest,
        ...(attempt ? { checkoutKey: attempt.key, checkoutParams: attempt.params, ...(attempt.session ? { checkoutSession: attempt.session } : {}) } : {}),
      })
      return true
    },
    bumpSync: async (id) => {
      const a = accounts.get(id)
      if (a) accounts.set(id, { ...a, syncWanted: (a.syncWanted ?? 0) + 1 })
    },
    writeSync: async (id, token, sum, now) => {
      const a = accounts.get(id)
      const l = leases.get(id)
      if (!a || l?.token !== token || l.until < now) return false
      const { subscriptionId: _i, subscriptionStatus: _s, ...rest } = a
      accounts.set(id, { ...rest, ...sum })
      return true
    },
    machineByCred: async (h) => find(machines, (m) => m.credHash === h),
    machinesOf: async (acct) => [...machines.values()].filter((m) => m.accountId === acct).sort((a, b) => a.created - b.created),
    createMachine: async (row, max) => {
      if ([...machines.values()].filter((m) => m.accountId === row.accountId).length >= max) return false
      machines.set(row.id, { ...row })
      return true
    },
    bindMachineKey: async (id, agentKey) => {
      const m = machines.get(id)
      if (m && !m.agentKey && !m.deleting) machines.set(id, { ...m, agentKey })
    },
    markDeleting: async (acct, id) => {
      const m = machines.get(id)
      if (!m || m.accountId !== acct) return undefined
      const marked = { ...m, deleting: true }
      machines.set(id, marked)
      return { ...marked }
    },
    unmarkDeleting: async (acct, id) => {
      const m = machines.get(id)
      if (m && m.accountId === acct) {
        const { deleting: _d, ...rest } = m
        machines.set(id, rest)
      }
    },
    machineById: async (id) => machines.get(id),
    touchMachine: async (id, now) => {
      const m = machines.get(id)
      if (m) machines.set(id, { ...m, lastSeen: now })
    },
    deleteMachine: async (acct, id) => {
      const m = machines.get(id)
      if (!m || m.accountId !== acct) return undefined
      machines.delete(id)
      return m
    },
    stats: async (now) => {
      const as = [...accounts.values()]
      const ms = [...machines.values()]
      return {
        accounts: as.length,
        accountsNew7d: as.filter((a) => a.created > now - 7 * 86400e3).length,
        plus: as.filter((a) => planOf(a) === 'plus').length,
        duplicateSubs: as.filter((a) => (a.subscriptionCount ?? 0) > 1).length,
        machines: ms.length,
        machines24h: ms.filter((m) => m.lastSeen > now - 86400e3).length,
        machines7d: ms.filter((m) => m.lastSeen > now - 7 * 86400e3).length,
      }
    },
    alerted: async (key) => alerts.has(key),
    supportCount: async (acct, date) => [...alerts].filter((k) => k.startsWith(`support:${acct}:${date}:`)).length,
    markAlert: async (key) => {
      if (alerts.has(key)) return false
      alerts.add(key)
      return true
    },
    pruneMachines: async (acct, before) => {
      for (const [id, m] of machines) if (m.accountId === acct && m.lastSeen < before) machines.delete(id)
    },
  }
}
