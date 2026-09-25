// ★★ Per-account ledger of "machines in use" (2026-09-24 / billing / docs/BILLING.md §2.2).
//   ⚠️ Decisions live only in these pure functions (the Account DO in `worker.ts` just wires reads and writes = runs from `npm test` / relay section of CLAUDE.md).
//
// ★ Machine counts are kept on the relay side (the agent is OSS, so counting there would get removed / §14.1.1.5).
// ★ Machines are identified by the agent's public key (the same value as the room key = information relay already sees).
// ⚠️ Machines not connected for a long time drop out of the slots (so a replaced or broken PC does not hold a slot forever).
//
// ★★ 2026-09-24 / codex round 26, high #3 and #4:
//   ① **Check the limit even for registered machines** (let through only the `max` oldest registrations). ⚠️ Without it, registering 5 on Plus → going back to Free keeps 5.
//      ⚠️ The time of a refused machine is **not updated** (it naturally drops out after 30 days while unusable).
//   ② **Tickets of a removed passphrase are rejected** (`revoked`). ⚠️ Without it, "remove A → connect B →
//      A re-registers with the ticket it still has" could be repeated to exceed the limit.
//   ★★ 2026-09-24 / codex round 27, medium #6 and #7: identification is by **passphrase number (`mid`)**. No clock comparison
//      (it used to compare "removal time" with the ticket's `iat` ⇒ wrongly refused a re-login in the same second, and let an old ticket through with skew from another clock).
//      ⚠️ Numbers are never reused ⇒ a ticket from a fresh login (a new number) looks for a free slot as usual, and the old number is refused until expiry.
//      ⚠️⚠️ If the record is full, **removal itself is refused** (silently dropping the record would let the old ticket through again).

/** One machine (milliseconds) */
export interface LedgerEntry {
  /** When first registered (⚠️ decides which ones pass when over the limit) */
  first: number
  /** When last let through (drops out after 30 days) */
  last: number
  /**
   * ★★ Passphrases using this slot (`mid` → last time let through / 2026-09-24 / codex round 28, high #3).
   *   ⚠️⚠️ The slot is freed **only when this becomes empty** (freeing by key alone removed the slot while a new passphrase,
   *      re-logged in on the same machine, was using it, and another machine got in = 2 machines on Free).
   */
  mids: Record<string, number>
}

/** ⚠️ Limit on passphrases remembered per machine (more than the account-side limit of 50) */
export const MIDS_MAX = 64

export interface Ledger {
  machines: Record<string, LedgerEntry>
  /** Numbers (`mid`) of removed passphrases → how long to remember (ms). ⚠️ Tickets with these numbers are rejected */
  revoked: Record<string, number>
}

/** ⚠️ Machines not connected for this long are not counted */
export const MACHINE_IDLE_MS = 30 * 24 * 60 * 60 * 1000
/** ⚠️ How long removed numbers are remembered (longer than the 24-hour ticket lifetime + clock allowance = old tickets expire meanwhile) */
export const REVOKED_KEEP_MS = 25 * 60 * 60 * 1000
/** ⚠️ Size limit of the ledger (do not let broken or malicious input inflate it) */
export const LEDGER_MAX = 200

/** ⚠️ `revoked` = a removed passphrase (kept apart from `machine-limit` = the fix differs: log in again) */
export type Claim = { ok: boolean; reason?: 'machine-limit' | 'revoked'; ledger: Ledger; count: number }
export type Release = { ok: true; ledger: Ledger } | { ok: false; ledger: Ledger }

const finite = (t: unknown): t is number => typeof t === 'number' && Number.isFinite(t)

/**
 * ★ Load (⚠️ also reads the pre-2026-09-24 shape `Record<key, last time>` = migration). Broken values are dropped.
 */
export function readLedger(raw: unknown): Ledger {
  const out: Ledger = { machines: {}, revoked: {} }
  if (typeof raw !== 'object' || raw === null) return out
  const o = raw as Record<string, unknown>
  const isNew = typeof o['machines'] === 'object' && o['machines'] !== null && !Array.isArray(o['machines'])
  const machines = (isNew ? o['machines'] : o) as Record<string, unknown>
  for (const [k, v] of Object.entries(machines)) {
    if (finite(v)) out.machines[k] = { first: v, last: v, mids: {} }
    else if (typeof v === 'object' && v !== null) {
      const e = v as Record<string, unknown>
      if (!finite(e['first']) || !finite(e['last'])) continue
      const mids: Record<string, number> = {}
      if (typeof e['mids'] === 'object' && e['mids'] !== null) for (const [m, t] of Object.entries(e['mids'] as Record<string, unknown>)) if (finite(t)) mids[m] = t
      out.machines[k] = { first: e['first'], last: e['last'], mids }
    }
  }
  const revoked = isNew && typeof o['revoked'] === 'object' && o['revoked'] !== null ? (o['revoked'] as Record<string, unknown>) : {}
  for (const [k, v] of Object.entries(revoked)) if (finite(v)) out.revoked[k] = v
  return out
}

/**
 * ★ May this machine (`key`) be used?
 *   - ticket from a removed passphrase (`mid`) ⇒ refuse
 *   - registered ⇒ pass if within the `max` oldest registrations (update the time). Otherwise refuse (time unchanged)
 *   - unregistered with a free slot ⇒ add and pass
 *   - unregistered with all slots full ⇒ refuse (ledger unchanged)
 * @param mid number of the passphrase that issued the ticket
 */
export function claimMachine(prev: Ledger, key: string, max: number, now: number, mid: string): Claim {
  const ledger = pruneLedger(prev, now)
  const count = Object.keys(ledger.machines).length
  if (mid in ledger.revoked) return { ok: false, reason: 'revoked', ledger, count }
  const found = ledger.machines[key]
  if (found) {
    const rank = Object.entries(ledger.machines)
      .sort(([ka, a], [kb, b]) => a.first - b.first || (ka < kb ? -1 : 1))
      .findIndex(([k]) => k === key)
    if (rank >= max) return { ok: false, reason: 'machine-limit', ledger, count }
    if (!(mid in found.mids) && Object.keys(found.mids).length >= MIDS_MAX) return { ok: false, reason: 'machine-limit', ledger, count }
    ledger.machines[key] = { first: found.first, last: now, mids: { ...found.mids, [mid]: now } }
    return { ok: true, ledger, count }
  }
  if (count >= max || count >= LEDGER_MAX) return { ok: false, reason: 'machine-limit', ledger, count }
  ledger.machines[key] = { first: now, last: now, mids: { [mid]: now } }
  return { ok: true, ledger, count: count + 1 }
}

/**
 * ★ Remove a passphrase ("remove" on the account page, `nyan logout`). Tickets with that number no longer pass.
 * @param keepSlot another passphrase of the same machine still remains (⇒ the slot is not freed)
 *   ⚠️ The ledger side also does not free it if another passphrase is still using this slot (do not decide on account's view alone / round 28, high #3)
 * ⚠️⚠️ Refuse if the record is full (`ok: false` = do not pretend it was removed)
 */
export function revokeCredential(prev: Ledger, key: string, mid: string, keepSlot: boolean, now: number): Release {
  const marked = markRevoked(prev, mid, now)
  if (!marked.ok) return marked
  return { ok: true, ledger: dropMid(marked.ledger, key, mid, keepSlot, now) }
}

/**
 * ★ ① Only record this number as "rejected" (⚠️ not yet removed from the slot owners / codex round 29, high #2:
 *   removing first let **another removal** see "no owner" and free the slot while the room notification was stalled).
 */
export function markRevoked(prev: Ledger, mid: string, now: number): Release {
  const ledger = pruneLedger(prev, now)
  if (!(mid in ledger.revoked) && Object.keys(ledger.revoked).length >= LEDGER_MAX) return { ok: false, ledger }
  ledger.revoked[mid] = now + REVOKED_KEEP_MS
  return { ok: true, ledger }
}

/** ★ ③ After it reached the room, remove the number from the slot owners, and free the slot if nobody remains */
export function dropMid(prev: Ledger, key: string, mid: string, keepSlot: boolean, now: number): Ledger {
  const ledger = pruneLedger(prev, now)
  const entry = ledger.machines[key]
  if (entry) {
    const { [mid]: _gone, ...mids } = entry.mids
    ledger.machines[key] = { ...entry, mids }
    if (!keepSlot && Object.keys(mids).length === 0) delete ledger.machines[key]
  }
  return ledger
}

/** ⚠️ Return a copy with old and broken values dropped (the original is unchanged) */
export function pruneLedger(prev: Ledger, now: number): Ledger {
  const src = readLedger(prev)
  const out: Ledger = { machines: {}, revoked: {} }
  for (const [k, e] of Object.entries(src.machines)) {
    if (now - e.last > MACHINE_IDLE_MS) continue
    // ⚠️ Passphrases unused for a long time are removed from slot owners (so passphrases account silently deleted do not keep slots filled)
    const mids = Object.fromEntries(Object.entries(e.mids).filter(([, t]) => now - t <= MACHINE_IDLE_MS))
    out.machines[k] = { ...e, mids }
  }
  for (const [k, until] of Object.entries(src.revoked)) if (until >= now) out.revoked[k] = until
  return out
}

/** ★ The hooks the removal procedure uses (wired by the Accounts DO in `worker.ts`) */
export interface ReleaseIo {
  read(): Promise<Ledger>
  write(l: Ledger): Promise<void>
  /** Remove the room's ticket (⚠️ throws on failure) */
  revokeRoom(): Promise<void>
  now(): number
}

/**
 * ★★ Procedure for removing a passphrase (codex rounds 26-27 / ⚠️ never put the decision in worker.ts = tests run here).
 *   ① record this number as "rejected" (from here on, the ticket at hand cannot re-register)
 *   → ② remove the room's ticket → ③ free the slot only after that succeeds.
 *   ⚠️⚠️ If ② fails, throw without freeing the slot (the room still has the ticket = freeing it would let another machine in / round 27, high #3).
 *   ⚠️ Same result no matter how many times it is called (account retries).
 */
export async function releaseCredential(io: ReleaseIo, key: string, mid: string): Promise<void> {
  const marked = markRevoked(await io.read(), mid, io.now())
  if (!marked.ok) throw new Error('revocation list full')
  await io.write(marked.ledger)
  await io.revokeRoom()
  // ⚠️ Remove only our own number (if another removal is stalled, its number remains and the slot is not freed)
  // ⚠️ Whether to free is decided only by the numbers left in the ledger (account's view goes stale while waiting / codex round 30, medium #2)
  await io.write(dropMid(await io.read(), key, mid, false, io.now()))
}
