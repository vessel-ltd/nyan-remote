// ★ Sign-in for the web account page (signed cookie / 2026-09-24).
//   Shape: `<payload base64url>.<HMAC-SHA256 base64url>`. Payload is `{ a: account id, e: expiry (seconds) }`.
//   ⚠️ No "signed in" table on the server (verifiable without touching D1).
//   ⚠️ Compare with `sameBytes` (no timing leak). ⚠️ Never throw (unreadable = "not signed in").

import { fromBase64Url, sameBytes, toBase64Url } from '../../shared/crypto.ts'

export const SESSION_COOKIE = 'nr_session'
export const STATE_COOKIE = 'nr_oauth_state'
/** ★ Sign-in lifetime (30 days) */
export const SESSION_TTL_SEC = 30 * 24 * 60 * 60

type Bin = Parameters<typeof crypto.subtle.digest>[1]
const enc = new TextEncoder()

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret) as Bin, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data) as Bin))
}

export async function makeSession(secret: string, acct: string, now: number): Promise<string> {
  const body = toBase64Url(enc.encode(JSON.stringify({ a: acct, e: now + SESSION_TTL_SEC })))
  return `${body}.${toBase64Url(await hmac(secret, body))}`
}

/** @returns account id (⚠️ bad signature, expired or broken ⇒ undefined) */
export async function readSession(secret: string, value: string | undefined, now: number): Promise<string | undefined> {
  if (!value || value.length > 512 || !secret) return undefined
  const dot = value.indexOf('.')
  if (dot <= 0) return undefined
  try {
    const body = value.slice(0, dot)
    if (!sameBytes(await hmac(secret, body), fromBase64Url(value.slice(dot + 1)))) return undefined
    const v = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as { a?: unknown; e?: unknown }
    if (typeof v.a !== 'string' || typeof v.e !== 'number' || v.e < now) return undefined
    return v.a
  } catch {
    return undefined
  }
}

/** ★ Read the cookie (⚠️ if the same name appears several times, the first one) */
export function cookieOf(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return undefined
}

/** ★ Write the cookie (⚠️ always HttpOnly, Secure, SameSite=Lax, path /) */
export function setCookie(name: string, value: string, maxAgeSec: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`
}
