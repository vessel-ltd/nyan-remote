// ★★ License tickets (2026-09-24 / billing / docs/BILLING.md). **The account Worker issues them, relay verifies them**.
//
// Shape: `<payload base64url>.<signature base64url>` (payload is JSON, signature is Ed25519).
//   ⚠️ Do not mimic the JWT shape (never create holes like "read `alg` and change how we verify" = there is only one shape).
// ★ relay **only verifies the signature** (it does not look up the account database = light, and relay keeps working if account is down).
// ⚠️ The private key exists only as an account Worker secret. The public key is `LICENSE_PUBLIC_KEY` (fine to publish).
// ⚠️ Values from outside ⇒ **never throw, never fall back to defaults** (refuse with a reason when unreadable).
// ⚠️ Do not write DOM type names (shared/ is type-checked from both agent and web / same as shared/crypto.ts).

import { fromBase64Url, toBase64Url } from './crypto.ts'

type Subtle = typeof globalThis.crypto.subtle
type Key = Awaited<ReturnType<Subtle['importKey']>>
type Bin = Parameters<Subtle['digest']>[1]

/** ★ Limits per plan (**this one table**. The pricing page, relay and the UI all read the same values) */
export const PLAN_LIMITS = {
  free: { maxMachines: 1, maxDevices: 2 },
  plus: { maxMachines: 5, maxDevices: 5 },
} as const

export type Plan = keyof typeof PLAN_LIMITS

export interface License {
  /**
   * ★ Version 3 (2026-09-24 / codex rounds 26-27): **carries the machine key `key` and the passphrase number `mid`**. ⚠️ Older versions are rejected
   *   (without the key it worked on another machine too; without the number, "a ticket from a removed passphrase" could only be told apart by comparing clocks).
   */
  v: 3
  /** Account id (assigned by the account Worker, not guessable) */
  acct: string
  /**
   * ★★ The **machine key** this ticket may be used with (the agent's public key = the key of the relay room). relay only lets it through when it matches the room key.
   *   ⚠️ One passphrase binds to exactly one key (account remembers the first key it was bound to).
   */
  key: string
  /**
   * ★★ The **passphrase number** that issued this ticket (account's `machines.id` / 2026-09-24 / codex round 27).
   *   ⚠️ When a machine is removed, relay remembers this number and rejects tickets carrying it (no clock comparison = no mistake on a re-login within the same second).
   *   ⚠️ Numbers are never reused (logging in again after removal gives a new number).
   */
  mid: string
  plan: Plan
  maxMachines: number
  maxDevices: number
  /** Issued-at and expiry times (seconds) */
  iat: number
  exp: number
}

/** ★ Ticket lifetime (a plan change takes effect within at most this long) */
export const LICENSE_TTL_SEC = 24 * 60 * 60
/** ⚠️ Allowance for clock skew (relay and account both run on Cloudflare, so clocks are nearly aligned) */
export const LICENSE_SKEW_SEC = 5 * 60
/** ⚠️ Do not read oversized tickets (hostile input) */
export const LICENSE_MAX_CHARS = 1024

/**
 * ★ Production public key (raw 32 bytes, base64url / created 2026-09-24 with `scripts/license-keygen.mjs`).
 *   ⚠️ Regenerating it makes every issued ticket fail (for up to 24 hours = until the next refresh). Only regenerate on a leak.
 *   ⚠️ Empty means **no ticket passes** (fail-closed).
 */
export const LICENSE_PUBLIC_KEY = 'eY9T3Mj7VSGLof2OCNTUwuzvncuTpkYS4Xr07wkBqZg'

const ED25519 = { name: 'Ed25519' } as const
const enc = new TextEncoder()

export async function importLicensePublicKey(raw: Uint8Array): Promise<Key> {
  return globalThis.crypto.subtle.importKey('raw', raw as Bin, ED25519, false, ['verify'])
}

/** ★ Issue (called only by the account Worker) */
export async function signLicense(l: License, privateKey: Key): Promise<string> {
  const body = toBase64Url(enc.encode(JSON.stringify(l)))
  const sig = new Uint8Array(await globalThis.crypto.subtle.sign(ED25519, privateKey, enc.encode(body) as Bin))
  return `${body}.${toBase64Url(sig)}`
}

export type LicenseCheck = { ok: true; license: License } | { ok: false; reason: 'malformed' | 'signature' | 'expired' | 'not-yet' }

/**
 * ★★ Verify (called by relay). ⚠️ Order: signature → shape → expiry (never look inside something whose signature fails).
 * @param now seconds
 */
export async function verifyLicense(token: unknown, publicKey: Key, now: number): Promise<LicenseCheck> {
  if (typeof token !== 'string' || token.length > LICENSE_MAX_CHARS) return { ok: false, reason: 'malformed' }
  const dot = token.indexOf('.')
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return { ok: false, reason: 'malformed' }
  const body = token.slice(0, dot)
  let sig: Uint8Array
  let payload: unknown
  try {
    sig = fromBase64Url(token.slice(dot + 1))
    const good = await globalThis.crypto.subtle.verify(ED25519, publicKey, sig as Bin, enc.encode(body) as Bin)
    if (!good) return { ok: false, reason: 'signature' }
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body)))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const l = asLicense(payload)
  if (!l) return { ok: false, reason: 'malformed' }
  if (l.iat > now + LICENSE_SKEW_SEC) return { ok: false, reason: 'not-yet' }
  if (l.exp + LICENSE_SKEW_SEC < now) return { ok: false, reason: 'expired' }
  return { ok: true, license: l }
}

/** ★ Shape of a passphrase number (account makes it as `m_` + random) */
export const MID_RE = /^m_[A-Za-z0-9_-]{8,32}$/

const posInt = (v: unknown, max: number): v is number => Number.isInteger(v) && (v as number) > 0 && (v as number) <= max

/** ★ Check the shape (⚠️ reject unknown plans and out-of-range numbers) */
export function asLicense(v: unknown): License | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const o = v as Record<string, unknown>
  if (o['v'] !== 3) return undefined
  if (typeof o['acct'] !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(o['acct'])) return undefined
  if (typeof o['key'] !== 'string' || !/^[A-Za-z0-9_-]{86,88}$/.test(o['key'])) return undefined
  if (typeof o['mid'] !== 'string' || !MID_RE.test(o['mid'])) return undefined
  if (o['plan'] !== 'free' && o['plan'] !== 'plus') return undefined
  if (!posInt(o['maxMachines'], 100) || !posInt(o['maxDevices'], 100)) return undefined
  if (!posInt(o['iat'], 2 ** 40) || !posInt(o['exp'], 2 ** 40) || (o['exp'] as number) <= (o['iat'] as number)) return undefined
  return {
    v: 3,
    acct: o['acct'],
    key: o['key'],
    mid: o['mid'],
    plan: o['plan'],
    maxMachines: o['maxMachines'] as number,
    maxDevices: o['maxDevices'] as number,
    iat: o['iat'] as number,
    exp: o['exp'] as number,
  }
}

/** ★ Build the ticket payload from a plan (limits come from `PLAN_LIMITS` = never written by hand) */
export function licenseFor(acct: string, key: string, mid: string, plan: Plan, now: number): License {
  return { v: 3, acct, key, mid, plan, ...PLAN_LIMITS[plan], iat: now, exp: now + LICENSE_TTL_SEC }
}
