// Step 6 of ③: the contents of the tunnel (plaintext shape of a `Session` / ARCHITECTURE §14.1.2.22).
//
// ★★ **The agent and the PWA import this same file** (same reason as `shared/crypto.ts` =
//   two implementations always drift). ⚠️ **No dependencies** (JSON and TextEncoder only).
//
// ★ What it carries is **HTTP requests and responses** (no custom RPC).
//   ⇒ The PWA just plugs "a tunnel fetch" into `HttpTransport`, and
//     **the 20 methods are not written twice** (keeps discipline 2, "one communication layer").
//
// ★★ **The UI can pass only "the route (method and path) and the body". Not a single header is carried.**
//   ⚠️⚠️ If headers could be carried, the phone could **claim**
//     `tailscale-user-login` / `x-nyan-remote-token` / `origin` / `content-type`
//     = **the peer could forge the inputs to authentication and CSRF checks** (same reason we never accept
//     `updatedInput` on approvals / CLAUDE.md §2). ⇒ Headers are **fixed by the agent** (`agent/src/tunnel.ts`).
//   ★ Not "a convention" but **absent from the type** (`TunnelRequest` has no place for headers).
//
// ⚠️⚠️ **decode never throws and never falls back to defaults** (same contract as `shared/pairing.ts`).
//   Even a peer that passed the handshake is not guaranteed "not to send broken input" (implementation bugs, modified builds).
//   ⇒ Return `{ ok: false, reason }`, and the caller picks 400 or disconnect.
//   ⚠️ `reason` is **a category only** (no path or body = it flows into logs and the screen).

/** Version of the inner shape. ⚠️ **Separate** from the key agreement version (`V` in `crypto.ts`) */
import { t } from './i18n.ts'

export const TUNNEL_V = 1

/**
 * ★★ Only **the two methods in the table** are allowed (same idea as `CONTROL_KEYS`).
 *
 * ⚠️ With a free-form string, methods the router does not have would "hit no endpoint",
 *    only adding requests with nowhere to go (the tunnel is API-only / `agent/src/tunnel.ts`).
 */
export const TUNNEL_METHODS = ['GET', 'POST'] as const
export type TunnelMethod = (typeof TUNNEL_METHODS)[number]

/** Route length limit. ⚠️ Leaves room even for a long `?before=…` (measured queries are under 60 chars) */
export const MAX_PATH = 2048

/**
 * ★★ The "destination" inside the tunnel. **The agent builds its headers from this value too**
 *   (`tunnelHeaders` in `agent/src/tunnel.ts`).
 *
 * ⚠️⚠️ Writing separate names in two places makes **the checked value and the executed value disagree**
 *    (same shape as high #1 of 2026-09-08). ⇒ Build both from one constant.
 */
export const TUNNEL_ORIGIN = 'http://tunnel'

/**
 * Limit of one plaintext. ⚠️ **Same value as** `readBody` in `router.ts` (256KB)
 * (if only the tunnel were looser, the same endpoint would have two limits).
 */
export const MAX_PAYLOAD_BYTES = 256 * 1024

export interface TunnelRequest {
  /** Number that matches responses to requests (chosen by the device, echoed by the agent) */
  id: number
  method: TunnelMethod
  /** Shape like `/sessions?live=1`. ⚠️ **Always starts with exactly one `/`** (`//` would be another origin) */
  path: string
  /**
   * POST body. ★ **JSON objects only** (aligned with the invariant of `readJsonBody`).
   * ⚠️ Rejected if attached to a GET (never express the same meaning two ways).
   */
  body?: Record<string, unknown>
}

export interface TunnelResponse {
  id: number
  status: number
  /** ★ Any JSON value (some endpoints return arrays or `null`) */
  body?: unknown
}

/** One SSE event (agent → device). ⚠️ `id` is the number of the request that started the subscription */
export interface TunnelEvent {
  id: number
  event: unknown
}

/**
 * End of a subscription (from either side).
 *
 * ★★ **No `id` means "close the whole tunnel"** (= stop every open subscription).
 *   ⚠️ Why needed: a broken request **cannot even be read up to its number**, so it cannot be answered / on revocation
 *      we need to **give one reason and stop everything** (continuation of §14.1.2.21).
 */
export interface TunnelClose {
  id?: number
  /** ★ A category only (shown on screen) */
  reason?: string
}

export type Decoded<T> = { ok: true; value: T } | { ok: false; reason: string }

const enc = new TextEncoder()
const dec = new TextDecoder('utf-8', { fatal: true })

/** ⚠️ Plaintext is built here (no `JSON.stringify` scattered around) */
function pack(value: Record<string, unknown>): Uint8Array {
  const bytes = enc.encode(JSON.stringify(value))
  // ⚠️ **Check the limit on the sender too** (checking only on the receiver silently sends the unsendable and gets disconnected)
  if (bytes.length > MAX_PAYLOAD_BYTES) throw new Error(t('トンネルの平文が大きすぎます', 'Tunnel plaintext too large'))
  return bytes
}

/**
 * ★ Read a plaintext. ⚠️ **Cut by byte length before `JSON.parse`** (do not let it build a huge string).
 * ⚠️ Anything that is not valid UTF-8 is rejected too (`fatal: true`).
 */
function unpack(bytes: Uint8Array): Decoded<Record<string, unknown>> {
  if (bytes.length === 0) return { ok: false, reason: t('空です', 'Empty') }
  if (bytes.length > MAX_PAYLOAD_BYTES) return { ok: false, reason: t('大きすぎます', 'Too large') }
  let text: string
  try {
    text = dec.decode(bytes)
  } catch {
    return { ok: false, reason: t('UTF-8 として読めません', 'Not valid UTF-8') }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: t('JSON として読めません', 'Not valid JSON') }
  }
  if (!isPlainObject(parsed)) return { ok: false, reason: t('オブジェクトではありません', 'Not an object') }
  // ⚠️ **Reject unknown versions** (never silently read them with another meaning / CLAUDE.md §2)
  if (parsed['v'] !== TUNNEL_V) return { ok: false, reason: t('知らない版です', 'Unknown version') }
  return { ok: true, value: parsed }
}

/** ⚠️ Excludes arrays and `null` (`typeof null === 'object'`) */
function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/**
 * ★ Number. ⚠️ Positive integers only (rejects `NaN`, fractions, huge values, negatives).
 *    ⚠️ Read with `Object.hasOwn` (do not pick up inherited properties / codex 2026-08-25, medium #1).
 */
function readId(o: Record<string, unknown>): number | undefined {
  if (!Object.hasOwn(o, 'i')) return undefined
  const id = o['i']
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) return undefined
  return id
}

// ─────────────────────────────────────────────────────────────────────────────
// Requests (device → agent)
// ─────────────────────────────────────────────────────────────────────────────

export function encodeRequest(r: TunnelRequest): Uint8Array {
  return pack({
    v: TUNNEL_V,
    i: r.id,
    m: r.method,
    p: r.path,
    ...(r.body === undefined ? {} : { b: r.body }),
  })
}

export function decodeRequest(bytes: Uint8Array): Decoded<TunnelRequest> {
  const outer = unpack(bytes)
  if (!outer.ok) return outer
  const o = outer.value
  const id = readId(o)
  if (id === undefined) return { ok: false, reason: t('番号が正しくありません', 'Invalid id') }

  const method = o['m']
  // ★ Check against the table (no free-form strings)
  if (typeof method !== 'string' || !(TUNNEL_METHODS as readonly string[]).includes(method)) {
    return { ok: false, reason: t('使えないメソッドです', 'Method not allowed') }
  }
  const path = readPath(o['p'])
  if (!path.ok) return { ok: false, reason: path.reason }

  const hasBody = Object.hasOwn(o, 'b')
  if (hasBody && method !== 'POST') return { ok: false, reason: t('GET に本文は付けられません', 'GET cannot have a body') }
  if (hasBody && !isPlainObject(o['b'])) {
    return { ok: false, reason: t('本文は JSON オブジェクトにしてください', 'Body must be a JSON object') }
  }
  return {
    ok: true,
    value: {
      id,
      method: method as TunnelMethod,
      // ★ The re-parsed route (= the very value that gets executed)
      path: path.path,
      ...(hasBody ? { body: o['b'] as Record<string, unknown> } : {}),
    },
  }
}

/**
 * ★★ **Parse the route once and return that value**. The only place that decides "what gets executed".
 *
 * ★★ 2026-09-15 / codex low #6. It used to reject only things starting with `//`, but
 *   **backslashes slipped through**:
 *
 *     decodeRequest('/\evil/x') → ok
 *     new URL('/\evil/x', 'http://tunnel') → **host=evil, pathname=/x** (measured)
 *
 *   = "the checked value" and "the executed value" disagree (same shape as high #1 of 2026-09-08).
 *   ⇒ **Stopped enumerating** (adding "just `//`", "just `\`" always leaves something outside).
 *     ① check that the destination does not change ② **return the re-parsed value**
 *     ⇒ the value the agent gets from `new URL` is exactly the string returned here.
 * ⚠️ Reject raw control characters (they end up in logs and files / CLAUDE.md §5).
 * ⚠️ Cut at the limit (do not let it build long strings. ★ cut before passing to `new URL`).
 */
function readPath(path: unknown): { ok: true; path: string } | { ok: false; reason: string } {
  if (typeof path !== 'string' || path.length === 0) return { ok: false, reason: t('経路がありません', 'Missing path') }
  if (path.length > MAX_PATH) return { ok: false, reason: t('経路が長すぎます', 'Path too long') }
  if (/[\u0000-\u001f\u007f]/u.test(path)) {
    return { ok: false, reason: t('経路に制御文字が入っています', 'Path contains control characters') }
  }
  let url: URL
  try {
    url = new URL(path, TUNNEL_ORIGIN)
  } catch {
    return { ok: false, reason: t('経路として読めません', 'Cannot parse path') }
  }
  // ⚠️⚠️ Reject anything whose destination changes (both `//evil/x` and `/\evil/x` fail here)
  if (url.origin !== TUNNEL_ORIGIN) return { ok: false, reason: t('経路が別の宛先になります', 'Path resolves to a different destination') }
  // ★★ **Return the re-parsed value** (= exactly what the agent gets from `new URL`).
  //   ⇒ "the checked value" and "the executed value" become **the same** (generalisation of high #1 of 2026-09-08).
  //   ⚠️ Returning the original string would give two interpretations differing by percent-encoding or `/a/../b`.
  return { ok: true, path: `${url.pathname}${url.search}` }
}

// ─────────────────────────────────────────────────────────────────────────────
// Responses, events, disconnects (agent → device)
// ─────────────────────────────────────────────────────────────────────────────

export function encodeResponse(r: TunnelResponse): Uint8Array {
  return pack({
    v: TUNNEL_V,
    i: r.id,
    s: r.status,
    ...(r.body === undefined ? {} : { b: r.body }),
  })
}

export function decodeResponse(bytes: Uint8Array): Decoded<TunnelResponse> {
  const outer = unpack(bytes)
  if (!outer.ok) return outer
  const o = outer.value
  const id = readId(o)
  if (id === undefined) return { ok: false, reason: t('番号が正しくありません', 'Invalid id') }
  const status = o['s']
  // ★ Only the HTTP status code range (the UI uses it for a `res.ok`-like check)
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
    return { ok: false, reason: t('状態コードが正しくありません', 'Invalid status code') }
  }
  return {
    ok: true,
    value: { id, status, ...(Object.hasOwn(o, 'b') ? { body: o['b'] } : {}) },
  }
}

export function encodeEvent(e: TunnelEvent): Uint8Array {
  return pack({ v: TUNNEL_V, i: e.id, e: e.event })
}

export function decodeEvent(bytes: Uint8Array): Decoded<TunnelEvent> {
  const outer = unpack(bytes)
  if (!outer.ok) return outer
  const o = outer.value
  const id = readId(o)
  if (id === undefined) return { ok: false, reason: t('番号が正しくありません', 'Invalid id') }
  if (!Object.hasOwn(o, 'e')) return { ok: false, reason: t('イベントがありません', 'Missing event') }
  return { ok: true, value: { id, event: o['e'] } }
}

export function encodeClose(c: TunnelClose): Uint8Array {
  return pack({
    v: TUNNEL_V,
    ...(c.id === undefined ? {} : { i: c.id }),
    ...(c.reason === undefined ? {} : { r: c.reason }),
  })
}

/**
 * ★ **No** number means the whole tunnel (see above).
 * ⚠️⚠️ **Never turn "a broken number" into "none"** (reject `i: 0` or `i: 'x'` =
 *    prevents a request meant to stop one subscription from silently **stopping all of them**).
 */
export function decodeClose(bytes: Uint8Array): Decoded<TunnelClose> {
  const outer = unpack(bytes)
  if (!outer.ok) return outer
  const o = outer.value
  const hasId = Object.hasOwn(o, 'i')
  const id = readId(o)
  if (hasId && id === undefined) return { ok: false, reason: t('番号が正しくありません', 'Invalid id') }
  // ⚠️⚠️ **Reject a reason that is present but not a string** (2026-09-15 / codex low #7).
  //    Silently treating it as "no reason" **turns a disconnect into "a disconnect with no known reason"**
  //    (= one case of "never fall back to defaults").
  const hasReason = Object.hasOwn(o, 'r')
  const reason = o['r']
  if (hasReason && typeof reason !== 'string') return { ok: false, reason: t('理由が正しくありません', 'Invalid reason') }
  return {
    ok: true,
    value: {
      ...(id === undefined ? {} : { id }),
      ...(hasReason ? { reason: reason as string } : {}),
    },
  }
}
