// ★★ Per-phone ledger of "machines used on the free tier" (2026-09-27 / the free tier without sign-in / docs/BILLING.md §2.2).
//   ⚠️ Decisions live only in these pure functions (the Phones DO in `worker.ts` just wires reads and writes = runs from `npm test`).
//
// ★ Why per phone: without sign-in, relay sees only keys. Machine keys are free to make (so counting machines per account
//   needs an account), but **a phone's key is the phone's identity in the app**: a second key means a second app install,
//   which loses the one-screen view of every machine = the very thing the app is for. So "one machine per phone" is the free tier
//   that needs no account, and it is loose on purpose (CLAUDE.md §1.95).
// ★ Rooms with a plan ticket (signed-in machines) are not counted here (their limits live in the account ledger / `ledger.ts`);
//   connecting to one **releases** it from this ledger, so a machine that later signs in stops holding the phone's free slot.
// ⚠️ Rooms not used for a long time drop out (a replaced or broken PC does not hold the slot forever). Same period as machines.
// ⚠️⚠️ relay only trusts a phone key **after the phone proved it holds the private key** (`room.ts`); this file never sees that.

import { PLAN_LIMITS } from '../../shared/license.ts'
import { MACHINE_IDLE_MS } from './ledger.ts'

/** One machine (room) used on the free tier (milliseconds) */
export interface PhoneRoom {
  /** When first claimed (⚠️ decides which ones pass when over the limit) */
  first: number
  /** When last let through (drops out after `PHONE_IDLE_MS`) */
  last: number
}

export interface PhoneLedger {
  rooms: Record<string, PhoneRoom>
}

/** ⚠️ Rooms not used for this long are not counted (the same period as the account ledger's machines) */
export const PHONE_IDLE_MS = MACHINE_IDLE_MS
/** ⚠️ Size limit of the ledger (do not let broken or malicious input inflate it) */
export const PHONE_ROOMS_MAX = 20
/** ★ How many machines one phone may use for free (⚠️ from the plan table, never written by hand) */
export const FREE_MACHINES_PER_PHONE = PLAN_LIMITS.free.maxMachines

export type PhoneClaim = { ok: boolean; ledger: PhoneLedger }

const finite = (t: unknown): t is number => typeof t === 'number' && Number.isFinite(t)

/** ★ Load (⚠️ broken values are dropped; never throws) */
export function readPhoneLedger(raw: unknown): PhoneLedger {
  const out: PhoneLedger = { rooms: {} }
  if (typeof raw !== 'object' || raw === null) return out
  const rooms = (raw as Record<string, unknown>)['rooms']
  if (typeof rooms !== 'object' || rooms === null || Array.isArray(rooms)) return out
  for (const [k, v] of Object.entries(rooms as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) continue
    const e = v as Record<string, unknown>
    if (!finite(e['first']) || !finite(e['last'])) continue
    out.rooms[k] = { first: e['first'], last: e['last'] }
  }
  return out
}

/** ⚠️ Return a copy with old and broken values dropped (the original is unchanged) */
export function prunePhoneLedger(prev: PhoneLedger, now: number): PhoneLedger {
  const src = readPhoneLedger(prev)
  const out: PhoneLedger = { rooms: {} }
  for (const [k, e] of Object.entries(src.rooms)) if (now - e.last <= PHONE_IDLE_MS) out.rooms[k] = { ...e }
  return out
}

/**
 * ★ May this phone use this machine (`agentKey`) on the free tier?
 *   - `licensed` (the room has a plan ticket) ⇒ pass, and **release** the room from this ledger (it is counted by the account instead)
 *   - already claimed ⇒ pass if within the `max` oldest claims (update the time). Otherwise refuse (time unchanged)
 *   - not claimed with a free slot ⇒ add and pass
 *   - not claimed with all slots full ⇒ refuse (ledger unchanged apart from pruning)
 */
export function claimRoom(prev: PhoneLedger, agentKey: string, licensed: boolean, now: number, max: number = FREE_MACHINES_PER_PHONE): PhoneClaim {
  const ledger = prunePhoneLedger(prev, now)
  if (licensed) {
    delete ledger.rooms[agentKey]
    return { ok: true, ledger }
  }
  const found = ledger.rooms[agentKey]
  if (found) {
    const rank = Object.entries(ledger.rooms)
      .sort(([ka, a], [kb, b]) => a.first - b.first || (ka < kb ? -1 : 1))
      .findIndex(([k]) => k === agentKey)
    if (rank >= max) return { ok: false, ledger }
    ledger.rooms[agentKey] = { first: found.first, last: now }
    return { ok: true, ledger }
  }
  const count = Object.keys(ledger.rooms).length
  if (count >= max || count >= PHONE_ROOMS_MAX) return { ok: false, ledger }
  ledger.rooms[agentKey] = { first: now, last: now }
  return { ok: true, ledger }
}
