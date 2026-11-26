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
  /** ★ End of the deciding subscription's current period (ms / 2026-09-27: "next renewal" / "Plus until" on the page) */
  subscriptionPeriodEnd?: number
  /** ★ The deciding subscription has a cancellation scheduled (at period end, or on `subscriptionCancelAt`) */
  subscriptionCancelling?: boolean
  /** ★ When a scheduled cancellation takes effect, if Stripe gave a date (ms). ⚠️ May be after several more renewals */
  subscriptionCancelAt?: number
  /**
   * ★★ How many times a re-read of subscriptions is requested (incremented on every webhook / codex round 27, high #4).
   *   ⚠️ The re-reader remembers the value before starting, and if it changed after writing, **reads again**.
   */
  syncWanted?: number
  /**
   * ★★ The `syncWanted` value the last finished re-read reflects (2026-11-26 / review ACC-1).
   *   ⚠️ `syncWanted > syncDone` = a re-read was asked for and never finished (a webhook got 503) ⇒ the hourly cron does it.
   */
  syncDone?: number
  /** ★ When the last re-read finished (ms). Paid accounts are re-read when it is older than `RECHECK_MS` */
  syncChecked?: number
  /** ★ When the hourly cron last tried this account (ms / the least recently tried go first) */
  syncTried?: number
  /** ★ Until when the cron re-reads this account hourly (set when a Checkout is handed out / `CHECKOUT_WATCH_MS`) */
  syncWatch?: number
  /** ★ The latest known end over every paid subscription (`SubscriptionSummary.paidThrough`) */
  paidThrough?: number
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

export type LeaseKind = 'checkout' | 'sync'

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
  subscriptionPeriodEnd?: number
  subscriptionCancelling?: boolean
  subscriptionCancelAt?: number
  /** ★ The latest known end over every paid subscription (`planOf` uses it; the fields above stay the one shown on the page) */
  paidThrough?: number
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
  /**
   * ★★ Two leases per account (2026-11-26 / codex): `checkout` serialises Checkouts (one purchase at a time), `sync` the
   *   subscription re-read (webhook and hourly cron). ⚠️ They never block each other: a loop of Checkouts used to hold the
   *   one lease and make every webhook and re-read busy. `writeSync` needs `sync`, `setCheckoutAttempt` needs `checkout`.
   */
  acquireLease(id: string, kind: LeaseKind, token: string, now: number, ttlMs: number): Promise<boolean>
  releaseLease(id: string, kind: LeaseKind, token: string): Promise<void>
  /** ★ Extend the lease (⚠️ only our own lease and only while it has not expired = false if expired) */
  renewLease(id: string, kind: LeaseKind, token: string, now: number, ttlMs: number): Promise<boolean>
  /** ★ Write / clear the in-progress Checkout attempt (⚠️ only while holding the lease) */
  setCheckoutAttempt(id: string, token: string, attempt: CheckoutAttempt | undefined, now: number): Promise<boolean>
  /** ★ Increment the requested re-read count by one */
  bumpSync(id: string): Promise<void>
  /**
   * ★★ Write the subscription state. ⚠️ **Only while holding the `sync` lease and while `syncWanted` is still `done`**
   *   (true if written; a notification that arrived during the read makes it false = read again)
   * @param done the `syncWanted` value read **before** reading Stripe (stored as `syncDone`)
   */
  writeSync(id: string, token: string, s: SubscriptionSummary, now: number, done: number): Promise<boolean>
  /**
   * ★★ Accounts the hourly cron re-reads from Stripe (2026-11-26 / review ACC-1: a missed webhook left a cancelled plan on Plus):
   *   a customer whose re-read was asked for and never finished, or watched after a Checkout (`syncWatch` ≥ now), or a paid
   *   status whose period (or `cancel_at`) ended before `now`, or an open status (`OPEN_STATUSES`: paid, `incomplete`,
   *   `unpaid`) whose last finished re-read is older than `recheckBefore` (or never happened).
   *   ⚠️ At most `limit`, **least recently tried first** (accounts that stay busy or failing cannot block the others).
   */
  syncCandidates(now: number, recheckBefore: number, limit: number): Promise<AccountRow[]>
  /** ★ Remember that the cron tried this account now (whatever the outcome) */
  markSyncTried(id: string, now: number): Promise<void>
  /** ★ Re-read hourly until `until` (never shortens an existing watch) */
  watchSync(id: string, until: number): Promise<void>
  /**
   * ★ Take a re-read slot: true (and `syncTried = now`) only if the last try was `gapMs` or more ago, **in one statement**
   *   (the thanks page / codex: failed reads left no mark, so reloads during a Stripe 429 kept calling Stripe)
   */
  claimSyncTry(id: string, now: number, gapMs: number): Promise<boolean>
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
  /** ★ The same for every account (the hourly cron / 2026-11-26 / review ACC-3: accounts nobody opens kept their rows) */
  pruneIdleMachines(lastSeenBefore: number): Promise<void>
  /** ★ Drop support marks older than this (they only count the day's sends / review ACC-2) */
  pruneSupportMarks(before: number): Promise<void>
  /** ★ Counts for the ops page (`/admin` / ops.ts) */
  stats(now: number): Promise<Stats>
  /** ★ Already alerted? (⚠️ each alert only once). `markAlert` returns true the first time */
  alerted(key: string): Promise<boolean>
  markAlert(key: string, now: number): Promise<boolean>
  /** ★ Number of support messages that day (counts `support:<acct>:<date>:` marks) */
  supportCount(accountId: string, date: string): Promise<number>
  /**
   * ★★ Reserve one of the day's contact slots **in one statement** (codex round 33: count-then-record let 8 parallel
   *   sends all through). ⚠️ true only if a slot was taken; release it with `releaseAlert` when the send fails.
   */
  reserveSupport(accountId: string, date: string, key: string, max: number, now: number): Promise<boolean>
  releaseAlert(key: string): Promise<void>
}

/**
 * ★★ How long after the period end a paid status is still believed without a fresh read (2026-11-26 / review ACC-1).
 *   Stripe moves the period forward at every renewal (even `past_due`), so a period end this far in the past means the
 *   webhook that changed it was missed. The hourly cron re-reads such accounts from the period end on (48 tries first).
 */
export const PLAN_GRACE_MS = 2 * 24 * 60 * 60 * 1000
/**
 * ★ Paid accounts are re-read from Stripe at least this often (codex: a cancellation after `past_due` retries, with its
 *   webhook lost, kept an annual Plus for up to a year; a paid row without a period end was never due).
 */
export const RECHECK_MS = 7 * 24 * 60 * 60 * 1000

/** ★ `paidThrough` of a paid subscription whose end is not known (no cut-off by date) */
export const NO_KNOWN_END = Number.MAX_SAFE_INTEGER

/** ★ The earliest known end of the deciding subscription (period end, or a scheduled `cancel_at` before it) */
export function paidUntil(a: Pick<AccountRow, 'subscriptionPeriodEnd' | 'subscriptionCancelAt'> | undefined): number | undefined {
  const ends = [a?.subscriptionPeriodEnd, a?.subscriptionCancelAt].filter((t): t is number => t !== undefined)
  return ends.length ? Math.min(...ends) : undefined
}

/**
 * ★★ The plan is decided from the Stripe subscription status (**this one place**).
 *   ⚠️ `past_due` (payment retrying) stays Plus (do not drop it right away / docs/BILLING.md §2.1).
 *   ⚠️⚠️ A paid status whose period ended more than `PLAN_GRACE_MS` ago is Free (review ACC-1: holding the account lease
 *   made every webhook 503, and the plan stayed Plus for good). ⚠️ `now` is required (no default = no forgotten clock).
 */
export function planOf(a: AccountRow | undefined, now: number): Plan {
  if (!paidStatus(a?.subscriptionStatus)) return 'free'
  // ★ Every paid subscription counts (two subscriptions: the one on the page may end before another / codex)
  // ⚠️ A row not re-read since this version has no `paidThrough`: no cut-off until it is (deploy.mjs asks for a re-read of
  //    every customer right after the deploy; the page's single date could belong to the shorter of two subscriptions)
  const end = a?.paidThrough
  return end !== undefined && end + PLAN_GRACE_MS < now ? 'free' : 'plus'
}

const paidStatus = (s: string | undefined) => s === 'active' || s === 'trialing' || s === 'past_due'
/** ⚠️ Subscriptions not yet ended (even if unpaid, do not let them buy another) */
export const OPEN_STATUSES = ['active', 'trialing', 'past_due', 'incomplete', 'unpaid'] as const

/**
 * ★★ Decide the account state from the subscription list (codex round 26, high #8).
 *   ⚠️ Overwriting one state per event meant that, with two subscriptions, **cancelling one also removed the other's Plus**.
 *   ⇒ Decide by the subscription in the best state, and count the live ones.
 */
export function summarize(subs: { id: string; status: string; periodEnd?: number; cancelling?: boolean; cancelAt?: number }[]): SubscriptionSummary {
  const rank = (s: string) => ['active', 'trialing', 'past_due', 'unpaid', 'incomplete'].indexOf(s)
  const open = subs.filter((s) => (OPEN_STATUSES as readonly string[]).includes(s.status))
  // ★ Among equally good ones, one that renews wins (two subscriptions, one of them cancelled: the page must not say "until")
  // ⚠️ Then the one paid for longer (two cancelling subscriptions: a monthly one listed first must not hide an annual one / codex)
  const best = [...open].sort(
    (a, b) =>
      rank(a.status) - rank(b.status) ||
      Number(a.cancelling === true) - Number(b.cancelling === true) ||
      (paidUntil({ subscriptionPeriodEnd: b.periodEnd, subscriptionCancelAt: b.cancelAt }) ?? Number.MAX_SAFE_INTEGER) -
        (paidUntil({ subscriptionPeriodEnd: a.periodEnd, subscriptionCancelAt: a.cancelAt }) ?? Number.MAX_SAFE_INTEGER),
  )[0]
  // ⚠️ A paid subscription whose end cannot be read counts as no known end (`NO_KNOWN_END` = never cut off by the date;
  //    the weekly re-check still reads it / codex: falling back to another subscription's date dropped Plus)
  const paidEnds = open.filter((s) => paidStatus(s.status)).map((s) => paidUntil({ subscriptionPeriodEnd: s.periodEnd, subscriptionCancelAt: s.cancelAt }) ?? NO_KNOWN_END)
  const paidThrough = paidEnds.length ? Math.max(...paidEnds) : undefined
  if (best) {
    // ★ Both dates are kept (the page decides the wording: a `cancel_at` after the period end still renews until then / codex)
    return {
      subscriptionId: best.id,
      subscriptionStatus: best.status,
      subscriptionCount: open.length,
      ...(best.periodEnd === undefined ? {} : { subscriptionPeriodEnd: best.periodEnd }),
      ...(best.cancelling ? { subscriptionCancelling: true } : {}),
      ...(best.cancelAt === undefined ? {} : { subscriptionCancelAt: best.cancelAt }),
      ...(paidThrough === undefined ? {} : { paidThrough }),
    }
  }
  const last = subs[0]
  return { ...(last ? { subscriptionId: last.id, subscriptionStatus: last.status } : {}), subscriptionCount: 0 }
}

/** For tests (⚠️ never used from production) */
export function memoryStore(): Store & { accounts: Map<string, AccountRow>; machines: Map<string, MachineRow> } {
  const accounts = new Map<string, AccountRow>()
  const machines = new Map<string, MachineRow>()
  const leases = new Map<string, { token: string; until: number }>()
  const lk = (id: string, kind: LeaseKind) => `${kind}:${id}`
  const alerts = new Set<string>()
  const alertTimes = new Map<string, number>()
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
    acquireLease: async (id, kind, token, now, ttl) => {
      const l = leases.get(lk(id, kind))
      if (!accounts.has(id) || (l && l.until >= now)) return false
      leases.set(lk(id, kind), { token, until: now + ttl })
      return true
    },
    releaseLease: async (id, kind, token) => {
      if (leases.get(lk(id, kind))?.token === token) leases.delete(lk(id, kind))
    },
    renewLease: async (id, kind, token, now, ttl) => {
      const l = leases.get(lk(id, kind))
      if (l?.token !== token || l.until < now) return false
      leases.set(lk(id, kind), { token, until: now + ttl })
      return true
    },
    setCheckoutAttempt: async (id, token, attempt, now) => {
      const a = accounts.get(id)
      const l = leases.get(lk(id, 'checkout'))
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
    writeSync: async (id, token, sum, now, done) => {
      const a = accounts.get(id)
      const l = leases.get(lk(id, 'sync'))
      if (!a || l?.token !== token || l.until < now || (a.syncWanted ?? 0) !== done) return false
      const { subscriptionId: _i, subscriptionStatus: _s, subscriptionPeriodEnd: _e, subscriptionCancelling: _c, subscriptionCancelAt: _a, paidThrough: _p, ...rest } = a
      accounts.set(id, { ...rest, ...sum, syncDone: done, syncChecked: now })
      return true
    },
    syncCandidates: async (now, recheckBefore, limit) =>
      [...accounts.values()]
        .filter((a) => {
          if (a.stripeCustomer === undefined) return false
          if ((a.syncWanted ?? 0) > (a.syncDone ?? 0)) return true
          if ((a.syncWatch ?? 0) >= now) return true
          if (!(OPEN_STATUSES as readonly string[]).includes(a.subscriptionStatus ?? '')) return false
          const end = paidUntil(a)
          return (paidStatus(a.subscriptionStatus) && end !== undefined && end < now) || (a.syncChecked ?? 0) < recheckBefore
        })
        .sort((x, y) => (x.syncTried ?? 0) - (y.syncTried ?? 0))
        .slice(0, limit),
    markSyncTried: async (id, now) => {
      const a = accounts.get(id)
      if (a) accounts.set(id, { ...a, syncTried: now })
    },
    watchSync: async (id, until) => {
      const a = accounts.get(id)
      if (a) accounts.set(id, { ...a, syncWatch: Math.max(a.syncWatch ?? 0, until) })
    },
    claimSyncTry: async (id, now, gap) => {
      const a = accounts.get(id)
      if (!a || (a.syncTried ?? 0) > now - gap) return false
      accounts.set(id, { ...a, syncTried: now })
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
        plus: as.filter((a) => planOf(a, now) === 'plus').length,
        duplicateSubs: as.filter((a) => (a.subscriptionCount ?? 0) > 1).length,
        machines: ms.length,
        machines24h: ms.filter((m) => m.lastSeen > now - 86400e3).length,
        machines7d: ms.filter((m) => m.lastSeen > now - 7 * 86400e3).length,
      }
    },
    alerted: async (key) => alerts.has(key),
    supportCount: async (acct, date) => [...alerts].filter((k) => k.startsWith(`support:${acct}:${date}:`)).length,
    reserveSupport: async (acct, date, key, max, now) => {
      if ([...alerts].filter((k) => k.startsWith(`support:${acct}:${date}:`)).length >= max) return false
      alerts.add(key)
      alertTimes.set(key, now)
      return true
    },
    releaseAlert: async (key) => {
      alerts.delete(key)
      alertTimes.delete(key)
    },
    markAlert: async (key, now) => {
      if (alerts.has(key)) return false
      alerts.add(key)
      alertTimes.set(key, now)
      return true
    },
    pruneMachines: async (acct, before) => {
      for (const [id, m] of machines) if (m.accountId === acct && m.lastSeen < before) machines.delete(id)
    },
    pruneIdleMachines: async (before) => {
      for (const [id, m] of machines) if (m.lastSeen < before) machines.delete(id)
    },
    pruneSupportMarks: async (before) => {
      for (const [k, at] of alertTimes) if (k.startsWith('support:') && at < before) {
        alerts.delete(k)
        alertTimes.delete(k)
      }
    },
  }
}

/**
 * ★★ Sign-ins grouped by **machine** (2026-09-27 / user report: "Machines 6/5" with 4 real machines).
 *   Each `nyan login` makes a passphrase row, so one PC signed in three times had three rows. The relay counts machines by key
 *   (`relay/src/ledger.ts`), so the page does too: rows with the same agent key are one machine; a row without a key yet
 *   (the agent was stopped at sign-in) is its own. Newest row first in each group; groups in the order of their first sign-in.
 */
export function machineGroups(rows: readonly MachineRow[]): { label: string; lastSeen: number; rows: MachineRow[] }[] {
  const groups = new Map<string, MachineRow[]>()
  for (const m of [...rows].sort((a, b) => a.created - b.created)) {
    const k = m.agentKey ? `k:${m.agentKey}` : `id:${m.id}`
    groups.set(k, [...(groups.get(k) ?? []), m])
  }
  return [...groups.values()].map((g) => {
    const newest = [...g].sort((a, b) => b.created - a.created)
    return { label: newest[0]!.label, lastSeen: Math.max(...g.map((m) => m.lastSeen)), rows: newest }
  })
}
