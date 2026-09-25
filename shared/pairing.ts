// Building and reading the `nyan://pair?...` string carried in the QR (ARCHITECTURE §14.1.2.5).
//
// ★★ **The agent builds it and the PWA reads it. So it lives in one file.**
//   ⚠️ With two copies, fixing only one produces **a QR that silently cannot be read**.
//
// ★★ **The reader's input comes from the camera = hostile input.**
//   ⚠️⚠️ **Never throw, never silently fall back to defaults** (`undefined` when unreadable).
//   ⚠️ `n` (machine name) is **shown on screen**, so it is normalised at the entry.
//
// ⚠️ There is no secret here (`t` is one-time, and the QR itself is **an authenticated out-of-band channel**).
//    ⇒ That is why it can live in `shared/` and be imported by the PWA.
//
// ★ **relay's `r` was added on 2026-09-15** (step 6 ④ of ③).
//    ★ The reader **ignores unknown parameters**, so adding it is backward compatible
//      (old PWAs ignore `r` and try `local` = the new side opts in / lesson of §14.1.1.9).
//    ⚠️⚠️ But **if `r` is present and unreadable, the whole QR is rejected** ("unknown" and "broken" are
//      different things. Silently falling back to local means **nobody can tell why relay does not connect**).

import { t } from './i18n.ts'
import { PUBKEY_BYTES, fromBase64Url } from './crypto.ts'
import { isRelayBase } from './relayFrame.ts'

/** ⚠️ Pin down the host part too (`nyan://pair`). Other hosts are not read */
export const PAIR_SCHEME = 'nyan:'
const PAIR_HOST = 'pair'
const V = '1'

/** Machine name limit (for display. ⚠️ An outside string, so it is cut at the entry) */
export const MAX_MACHINE = 64

export interface PairPayload {
  /** base64url of the agent's raw public key (65B) */
  agentPublicKey: string
  /** One-time pairing code */
  token: string
  /** Machine name for display (★ optional. Never used for decisions) */
  machine: string
  /**
   * ★ relay entry point (`wss://…`). **If absent, `local` only** (§14.1.1).
   *
   * ⚠️ It is in the QR because, **for peers reachable only via relay**, `/health` cannot be
   *    fetched first (= avoids "you need a route to learn the route").
   */
  relayUrl?: string
  /**
   * ★★ The agent's **local entry point** (`https://…`. 2026-09-16 / to move toward Y).
   *
   * ⚠️⚠️ **When the PWA is served from the public origin, that screen has no agent at all**
   *    (its own origin is not a candidate = discipline 1). ⇒ **The first machine can only be added from a QR.**
   * ⚠️ `https` only (`tailscale serve` adds identity headers only on https).
   * ⚠️ Query, fragment and credentials are rejected (the value is used as the endpoint as-is).
   */
  agentUrl?: string
}

/**
 * ★ Is this shape usable as an endpoint? ⚠️ **Never throws** (used on the reading side).
 *
 * ⚠️⚠️ The trailing slash is dropped (`endpoints.ts` uses the URL as the id, so
 *    variation would turn **the same agent into two rows**).
 */
export function agentBase(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return undefined
  let u: URL
  try {
    u = new URL(value)
  } catch {
    return undefined
  }
  // ⚠️ http is not allowed (serve adds identity headers only on https / same call as auth.ts)
  if (u.protocol !== 'https:') return undefined
  if (u.username !== '' || u.password !== '') return undefined
  if (u.hostname === '') return undefined
  // ⚠️ Reject query and fragment (the value is used as the endpoint as-is, so anything appended is suspicious).
  //    ★ A check that looks for raw `?` `#` characters is **not added** (it would give the same result as this one =
  //      a guard no test can kill / CLAUDE.md "check whether it is reachable").
  if (u.search !== '' || u.hash !== '') return undefined
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
}

/**
 * Build the string carried in the QR.
 *
 * ⚠️ **Do not build what cannot be built** (broken inputs throw). The caller is the agent, so
 *    silently emitting a strange QR here would **show people a QR that cannot be read**.
 */
export function buildPairUrl(p: PairPayload): string {
  if (decodedLength(p.agentPublicKey) !== PUBKEY_BYTES) {
    throw new Error(t('agent の公開鍵の長さが違います', 'Wrong agent public key length'))
  }
  if (!p.token) throw new Error(t('ペアリングのワンタイムがありません', 'Pairing one-time code is missing'))
  const q = new URLSearchParams({ v: V, a: p.agentPublicKey, t: p.token })
  if (p.machine) q.set('n', p.machine)
  // ⚠️ **Never put an unusable relay into the QR** (do not show people an unreadable QR)
  if (p.relayUrl !== undefined) {
    if (!isRelayBase(p.relayUrl)) throw new Error(t('relay の入口の形が違います（ws:// か wss://）', 'Invalid relay URL format (ws:// or wss:// only)'))
    q.set('r', p.relayUrl)
  }
  // ⚠️ **Never put an unusable endpoint into the QR** (do not show people an unreadable QR)
  if (p.agentUrl !== undefined) {
    const clean = agentBase(p.agentUrl)
    if (clean === undefined) throw new Error(t('接続先の形が違います（https:// だけ）', 'Invalid connection URL format (https:// only)'))
    q.set('u', clean)
  }
  // ⚠️ Do not build it with `new URL()` (`nyan:` is not a known scheme, so
  //    host handling depends on the implementation). ⇒ **Build it as a string**
  return `${PAIR_SCHEME}//${PAIR_HOST}?${q.toString()}`
}

/**
 * Read it. **`undefined` if unreadable** (⚠️ never throw, never fall back to defaults).
 *
 * ⚠️ Unknown parameters are ignored (★ so relay's `r` could be added later).
 */
export function parsePairUrl(raw: string): PairPayload | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) return undefined
  const at = raw.indexOf('?')
  if (at < 0) return undefined
  // ⚠️ Check scheme and host **as text** (do not rely on how `new URL` interprets them)
  if (raw.slice(0, at) !== `${PAIR_SCHEME}//${PAIR_HOST}`) return undefined
  let q: URLSearchParams
  try {
    q = new URLSearchParams(raw.slice(at + 1))
  } catch {
    return undefined
  }
  // ⚠️⚠️ Check the version (unknown versions are not read, nor is a missing one)
  if (q.get('v') !== V) return undefined
  const agentPublicKey = q.get('a') ?? ''
  // ⚠️ Check it is "a length usable as a key" (never make a non-key the handshake target)
  if (decodedLength(agentPublicKey) !== PUBKEY_BYTES) return undefined
  const token = q.get('t') ?? ''
  // ⚠️⚠️ Do not read one without a one-time code (never reopen pairing / §14.1.2.5)
  if (!token) return undefined
  const relay = q.get('r')
  // ⚠️⚠️ **If present but unreadable, reject the whole QR** (do not silently fall back to local / see the header)
  if (relay !== null && !isRelayBase(relay)) return undefined
  const agent = q.get('u')
  // ⚠️⚠️ **If present but unreadable, reject the whole QR** (same rule as `r`. Silently dropping it leads to
  //    "it does not connect and nobody knows why")
  const agentUrl = agent === null ? undefined : agentBase(agent)
  if (agent !== null && agentUrl === undefined) return undefined
  return {
    agentPublicKey,
    token,
    machine: normalizeMachine(q.get('n') ?? ''),
    ...(relay === null ? {} : { relayUrl: relay }),
    ...(agentUrl === undefined ? {} : { agentUrl }),
  }
}

/** Decoded length of base64url. ⚠️ `-1` if it contains unreadable characters (never silently 0) */
function decodedLength(s: string): number {
  if (!s) return -1
  try {
    return fromBase64Url(s).length
  } catch {
    return -1
  }
}

/** ⚠️ A string shown on screen, so normalise it at the entry (drop control characters, cut the length) */
function normalizeMachine(n: string): string {
  return n.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '').trim().slice(0, MAX_MACHINE)
}
