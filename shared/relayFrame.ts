// Step 6 ③ of ③: **the outer frame of the rendezvous (relay)** (ARCHITECTURE §14.1.1.3 / §14.1.2.25).
//
// ★★ This is **the layer relay is allowed to see**. The contents (the frame in `shared/tunnel.ts`) are already E2E-encrypted,
//   so relay only learns "from which public key to which public key", "size" and "time" (§14.1.2.7).
//
// ★★ **The agent talks to several phones over one wire** (symmetric mesh / §7).
//   ⇒ Only the agent-side wire is **multiplexed by connection number (connId)**. The phone-side wire is **bare**
//     (a phone only has its own single wire, so a number would be meaningless).
//
// ```
// agent  ↔ relay : [1B type][4B connection number][payload…]
// device ↔ relay : [payload…]                    ← relay adds and strips the number
// ```
//
// ⚠️⚠️ **Do not lean on Durable Object-specific features** (rule of §14.1.1.3).
//    As long as this sits on plain WebSocket, a self-hosted version can be written when needed.
//
// ⚠️ **No dependencies** (only `DataView` and `Uint8Array`). The agent, the PWA and the Worker all
//    read **this same file** (no three implementations).

/** Version of the outer frame. ⚠️ **Separate** from the inner one (`TUNNEL_V` in `shared/tunnel.ts`) */
import { t } from './i18n.ts'

export const RELAY_V = 1

/**
 * ★ Types carried on the agent-side wire.
 *
 * ⚠️ Types not in the table are dropped (same idea as `toFrameType` in `shared/crypto.ts`).
 */
export const RELAY_FRAME = {
  /** Carry the payload (an encrypted tunnel frame) as-is */
  data: 1,
  /** ★ A phone connected (the agent opens a new tunnel here) */
  opened: 2,
  /** ★ A phone disconnected (the agent discards that tunnel) */
  closed: 3,
  /**
   * ★★ agent → relay: "close the wire of the phone with this number" (2026-09-24 / codex round 18, high #1).
   * ⚠️⚠️ **Only send on a wire that received `ready`** (an old relay **cuts the whole agent wire** on anything but data).
   * Used when: a handshake was refused, or a pairing-only connection is still around past its deadline.
   */
  drop: 4,
  /**
   * ★★ relay → agent: "`drop` is accepted" (2026-09-24).
   * ⚠️⚠️ **Only sent to agents that connected with `c=1` in the URL** (an old agent **cuts the whole wire** on unknown types).
   * ⚠️ The connection number is **0 only** (addressed to no phone).
   */
  ready: 5,
  /**
   * ★★ agent → relay: license ticket (2026-09-24 / billing / docs/BILLING.md). Payload is the ticket string (UTF-8), number 0.
   * ⚠️⚠️ **Only send on a wire that received `want` in `licenseResult` from relay** (an old relay cuts the whole agent wire on anything but data).
   */
  license: 6,
  /**
   * ★★ relay → agent: reply about the ticket (payload is one of `LICENSE_STATUS`, number 0).
   * ⚠️⚠️ **Only sent to agents that connected with `c=2` in the URL** (an old agent cuts the whole wire on unknown types).
   *    The first message is `want` ("license tickets are accepted").
   */
  licenseResult: 7,
} as const

/** ★ Contents of the ticket reply (relay → agent) */
// ★ `revoked` = this machine was removed from the account page or with `nyan logout` (2026-09-24 / ⚠️ old agents silently drop unknown values)
export const LICENSE_STATUS = ['want', 'ok', 'invalid', 'expired', 'machine-limit', 'revoked'] as const
export type LicenseStatus = (typeof LICENSE_STATUS)[number]

/** ⚠️ Types carried with number 0 (addressed to no phone) */
const CONN_ZERO: readonly number[] = [RELAY_FRAME.ready, RELAY_FRAME.license, RELAY_FRAME.licenseResult]
/** ⚠️ Types that carry a payload (no payload on the others = never express the same meaning two ways) */
const WITH_PAYLOAD: readonly number[] = [RELAY_FRAME.data, RELAY_FRAME.license, RELAY_FRAME.licenseResult]
export type RelayFrameType = (typeof RELAY_FRAME)[keyof typeof RELAY_FRAME]

/** Header length (version 1B + type 1B + connection number 4B) */
export const RELAY_HEADER_BYTES = 6

/**
 * ★★ Per-message limit.
 *
 * ⚠️⚠️ **This is about the ToS, not performance** (§14.1.1.4). Being able to guarantee technically that
 *    "it cannot be repurposed for bulk transfer" is something to point to if anyone ever asks.
 * ★ The payload limit (`MAX_PAYLOAD_BYTES` = 256KB in `shared/tunnel.ts`) + crypto and framing overhead.
 *   ⚠️ **Never smaller than the payload** (if smaller, relay drops correct responses and it becomes
 *      "sometimes it does not work"). ⇒ Derived from one place.
 */
export const MAX_RELAY_BYTES = 320 * 1024

/**
 * ★★ **Keepalive signal for the wire** (③ of ③b / 2026-09-15).
 *
 * ⚠️⚠️ **This is the only thing sent as "text"** (everything else is bytes). The reason is that Cloudflare's
 *    **auto-response** (`setWebSocketAutoResponse`) only takes **a pair of strings**.
 *    ★ Official docs (checked 2026-09-15):
 *      "when a matching request arrives, the response is returned **without waking the hibernated WebSocket**
 *        and **without incurring billable duration**" (up to 2,048 characters each)
 *    ⇒ ⚠️⚠️ **Passing through the 5-second heartbeat of `events.ts` would keep the DO from ever hibernating**
 *      (one always-awake DO is about 10,800 GB-s/day = **two machines exceed the free tier**).
 *      ⇒ Signals with content are not passed through; the wire is kept alive by **this pair that relay answers by itself**.
 * ⚠️ Neither browsers nor Node's WebSocket **have a way to send a protocol ping**
 *    (adding `ws` goes against "zero runtime dependencies") ⇒ replaced with this application-level pair.
 * ⚠️ The receiver **ignores text** (only bytes are frames).
 */
export const RELAY_PING = 'nyan-ping'
export const RELAY_PONG = 'nyan-pong'

/**
 * Interval between signals.
 *
 * ⚠️ Shortening it **does not raise billing** (auto-response), but it can count toward **the number of requests**,
 *    so do not shorten it needlessly. ⚠️ Too long and NATs or middleboxes silently cut it.
 */
export const RELAY_PING_MS = 45_000

/** Upper bound of the connection number (4 bytes) */
const MAX_CONN_ID = 0xffffffff

export interface RelayFrame {
  type: RelayFrameType
  /** ★ Number for one phone wire (assigned by relay. ⚠️ never reused) */
  connId: number
  /** ⚠️ Only `data` has a payload */
  payload?: Uint8Array
}

export type RelayDecoded =
  | { ok: true; value: RelayFrame }
  | { ok: false; reason: string }

/**
 * Put it into the shape carried on the agent-side wire.
 *
 * ⚠️ **Only "sender-side mistakes" throw** (over the limit, number out of range).
 *    Receiving never throws (`decodeRelayFrame`).
 */
export function encodeRelayFrame(f: RelayFrame): Uint8Array {
  // ⚠️ `ready` / `license` / `licenseResult` use number 0 (addressed to no phone). The others are 1 or more (0 could not be told apart from "no number")
  const ok =
    CONN_ZERO.includes(f.type)
      ? f.connId === 0
      : Number.isInteger(f.connId) && f.connId >= 1 && f.connId <= MAX_CONN_ID
  if (!ok) {
    throw new Error(t('接続番号が範囲外です', 'Connection number out of range'))
  }
  const payload = f.payload ?? new Uint8Array(0)
  const out = new Uint8Array(RELAY_HEADER_BYTES + payload.length)
  if (out.length > MAX_RELAY_BYTES) throw new Error(t('relay の封が大きすぎます', 'Relay frame too large'))
  out[0] = RELAY_V
  out[1] = f.type
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(2, f.connId)
  out.set(payload, RELAY_HEADER_BYTES)
  return out
}

/**
 * Read from the agent-side wire.
 *
 * ⚠️⚠️ **Never throw, never fall back to defaults** (same contract as `shared/tunnel.ts`).
 *    The peer may be someone who is "just connected" (especially until relay has authentication).
 */
export function decodeRelayFrame(bytes: Uint8Array): RelayDecoded {
  if (bytes.length < RELAY_HEADER_BYTES) return { ok: false, reason: t('短すぎます', 'Too short') }
  if (bytes.length > MAX_RELAY_BYTES) return { ok: false, reason: t('大きすぎます', 'Too large') }
  if (bytes[0] !== RELAY_V) return { ok: false, reason: t('知らない版です', 'Unknown version') }
  const type = bytes[1]
  if (!isRelayFrameType(type)) return { ok: false, reason: t('知らない種別です', 'Unknown type') }
  const connId = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(2)
  if (CONN_ZERO.includes(type) ? connId !== 0 : connId < 1) {
    return { ok: false, reason: t('接続番号が正しくありません', 'Invalid connection number') }
  }
  // ⚠️ No payload on types that do not carry one (never express the same meaning two ways)
  const payload = bytes.slice(RELAY_HEADER_BYTES)
  const carries = WITH_PAYLOAD.includes(type)
  if (!carries && payload.length > 0) {
    return { ok: false, reason: t('この種別に中身は付きません', 'This type carries no payload') }
  }
  if (carries && payload.length === 0) {
    return { ok: false, reason: t('中身がありません', 'Missing payload') }
  }
  return {
    ok: true,
    value: { type, connId, ...(carries ? { payload } : {}) },
  }
}

function isRelayFrameType(x: number | undefined): x is RelayFrameType {
  return (
    x === RELAY_FRAME.data ||
    x === RELAY_FRAME.opened ||
    x === RELAY_FRAME.closed ||
    x === RELAY_FRAME.drop ||
    x === RELAY_FRAME.ready ||
    x === RELAY_FRAME.license ||
    x === RELAY_FRAME.licenseResult
  )
}

/**
 * ★ "Is this shape usable as a relay entry point?" **The only place that decides** (config, QR and UI all look at the same thing).
 *
 * ⚠️⚠️ **Never throws** (it comes from config files and from QR codes (the camera) = hostile input).
 */
export function isRelayBase(base: unknown): base is string {
  if (typeof base !== 'string' || base.length === 0 || base.length > 512) return false
  // ⚠️ **Reject fragments on the raw text** (2026-09-15 / codex round 4, low #10).
  //    `wss://x/#` has `u.hash === ''` so it passes the checks below, but `toString()` keeps the `#`, and
  //    **WebSocket rejects URLs with a fragment** (even an empty one gives `SyntaxError`).
  if (base.includes('#')) return false
  try {
    const u = new URL(base)
    // ⚠️ `ws:` / `wss:` only (★ `ws:` is for `127.0.0.1` during development. ⚠️ From an https PWA,
    //    `ws:` to anything but localhost is **refused by the browser as mixed content**)
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return false
    // ⚠️ Query and fragment are added by `relayUrl` (do not mix in what was passed)
    if (u.search !== '' || u.hash !== '') return false
    // ⚠️⚠️ No credentials in the URL (values from QR or config become the connection target as-is)
    if (u.username !== '' || u.password !== '') return false
    if (u.hostname === '') return false
    return true
  } catch {
    return false
  }
}

/**
 * ★ Build the rendezvous URL. **It must stay replaceable** (§14.1.1.3).
 *
 * ⚠️⚠️ Do not make a shape where **everyone is cut off** if relay is shut down =
 *    `endpoints.ts` holds the URL, and this only knows "how to build it".
 * ⚠️ The agent's public key goes into the query (exactly **the information relay may see** / §14.1.2.7).
 */
export function relayUrl(
  base: string,
  side: 'agent' | 'device',
  agentPublicKey: string,
  /**
   * ★★ The agent announces it understands `ready` / `drop` (`c=1` / 2026-09-24).
   * ⚠️ Old relays ignore unknown queries = announcing is harmless (conversely, sending `drop` without checking gets you cut).
   */
  o: { control?: boolean; license?: boolean } = {},
): string {
  const u = new URL(base)
  // ⚠️ Do not double the trailing slash (leave it to how `new URL` interprets it)
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/v${RELAY_V}/${side}`
  u.searchParams.set('a', agentPublicKey)
  // ★ `l=1` = understands license tickets in addition to `c=1` (2026-09-24). ⚠️ Tickets ride on top of `drop` / `ready`.
  //   ⚠️⚠️ Not `c=2` (codex round 26): old relays only check `c === '1'`, so it would lose `drop` / `ready` too
  if (o.control && side === 'agent') {
    u.searchParams.set('c', '1')
    if (o.license) u.searchParams.set('l', '1')
  }
  return u.toString()
}
