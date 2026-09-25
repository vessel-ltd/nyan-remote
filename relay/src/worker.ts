// Step 6 ③ of ③: the rendezvous (relay) itself — Cloudflare Workers + Durable Object.
//
// ★★ **Decisions live in `room.ts`** (2026-09-15 / codex round 4).
//   This is a thin layer that **only wires the Durable Object API to `Room`**:
//   accepting sockets, storing tags (`serializeAttachment`), key generation, the clock.
//   ⚠️⚠️ Do not add decisions here (**not a single line of it runs from `npm test`**).
//
// ★★ **It has exactly one job: pass ciphertext through as-is.**
//   relay only sees "from which public key to which public key", "size" and "time" (§14.1.2.7).
//   ⚠️ There is no way to read the contents (the keys were exchanged directly via QR, and relay does not hold them).
//
// ★★ **Do not lean on Durable Object-specific features** (§14.1.1.3).
//   ⚠️ All it uses is "hang two or more WebSockets and forward between them".
//     The Hibernation API is used **for billing**, but **it could be written the same way without it**.
//
// ⬜ **Not there yet (think about it before deploying)**:
//   ⬜ ⚠️ **Filling up the phone-side slots**: knowing the key lets anyone connect up to 8 as a device.
//      The agent refuses them at the handshake, but **the slots fill up** (⇒ real phones cannot connect).
//   ⬜ Daily bandwidth per key (the other half of the ToS measure in §14.1.1.4. The per-message limit is in)
//   ⬜ Three billing tiers (§14.1.1.5)

import { DurableObject } from 'cloudflare:workers'
import { ECDH_PARAMS, fromBase64Url, type Jwk } from '../../shared/crypto.ts'
import { RELAY_PING, RELAY_PONG, RELAY_V } from '../../shared/relayFrame.ts'
import { CHALLENGE_NONCE_BYTES, KEY_RE, Room, type ClaimResult, type RoomSocket, type Tag } from './room.ts'
import { importLicensePublicKey, LICENSE_PUBLIC_KEY, verifyLicense, type LicenseCheck } from '../../shared/license.ts'
import { claimMachine, readLedger, releaseCredential, type Ledger } from './ledger.ts'

export interface Env {
  RENDEZVOUS: DurableObjectNamespace<Rendezvous>
  /** ★ Per-account ledger of "machines in use" (2026-09-24 / billing / `ledger.ts`) */
  ACCOUNTS: DurableObjectNamespace<Accounts>
  /**
   * ★ After this time (ISO), phones are not let into rooms without a license ticket. ⚠️ Missing or unreadable = not required (during the grace period, as before)
   */
  LICENSE_REQUIRED_FROM?: string
  /** ★ `'1'` on a self-hosted relay (`wrangler.selfhost.jsonc`): no plans, no tickets */
  SELF_HOSTED?: string
}

/** ★ License ticket public key (⚠️ if empty, no ticket passes = fail-closed / `shared/license.ts`) */
let licenseKey: Promise<Awaited<ReturnType<typeof importLicensePublicKey>> | undefined> | undefined
function licensePublicKey() {
  licenseKey ??= LICENSE_PUBLIC_KEY
    ? importLicensePublicKey(fromBase64Url(LICENSE_PUBLIC_KEY)).catch(() => undefined)
    : Promise.resolve(undefined)
  return licenseKey
}

/**
 * ★★ Per-account ledger (one per `acct`). ⚠️ Decisions are in `ledger.ts` (this only wires reads and writes).
 */
export class Accounts extends DurableObject<Env> {
  /** ⚠️ `readLedger` also reads the pre-2026-09-24 shape (`Record<key, time>`) = written back in the new shape to the same place */
  async #read(): Promise<Ledger> {
    return readLedger(await this.ctx.storage.get('machines'))
  }

  /** @param mid number of the passphrase that issued the ticket */
  async claim(key: string, max: number, mid: string): Promise<ClaimResult> {
    const r = claimMachine(await this.#read(), key, max, Date.now(), mid)
    await this.ctx.storage.put('machines', r.ledger)
    return r.ok ? 'ok' : (r.reason ?? 'machine-limit')
  }

  /**
   * ★★ Remove a passphrase (from the account Worker / codex rounds 26-27). ⚠️ If this throws, account does not delete the passphrase (= can retry).
   *   ⚠️⚠️ Order: ① record this number as "rejected" (from here on, the ticket at hand cannot re-register)
   *   → ② remove the ticket of the room → ③ free the slot only after that succeeds. If ② fails, the slot is not freed (the room still has the ticket).
   *   ⚠️ Same result no matter how many times it is called (safe to retry).
   * @param acct this account (⚠️ the room only removes tickets of the same account and the same number)
   */
  async release(acct: string, key: string, mid: string): Promise<void> {
    await releaseCredential(
      {
        read: () => this.#read(),
        write: (l) => this.ctx.storage.put('machines', l),
        revokeRoom: () => this.env.RENDEZVOUS.getByName(key).revokeLicense(acct, mid),
        now: () => Date.now(),
      },
      key,
      mid,
    )
  }

  async list(): Promise<Ledger> {
    return await this.#read()
  }
}

export class Rendezvous extends DurableObject<Env> {
  /** ⚠️ Return **the same holder** for the same socket (so `Room` can tell them apart by identity) */
  #wrapped = new WeakMap<WebSocket, RoomSocket>()

  #room = new Room({
    sockets: (side) => this.ctx.getWebSockets(side).map((ws) => this.#wrap(ws)),
    newChallenge: async () => {
      const eph = (await crypto.subtle.generateKey(ECDH_PARAMS, true, [
        'deriveBits',
      ])) as CryptoKeyPair
      return {
        publicRaw: new Uint8Array(
          (await crypto.subtle.exportKey('raw', eph.publicKey)) as ArrayBuffer,
        ),
        jwk: (await crypto.subtle.exportKey('jwk', eph.privateKey)) as Jwk,
        nonce: crypto.getRandomValues(new Uint8Array(CHALLENGE_NONCE_BYTES)),
      }
    },
    importPrivate: (jwk) =>
      crypto.subtle.importKey('jwk', jwk as JsonWebKey, ECDH_PARAMS, false, ['deriveBits']),
    publicRaw: (key) => fromBase64Url(key),
    now: () => Date.now(),
    verifyLicense: async (token): Promise<LicenseCheck> => {
      const key = await licensePublicKey()
      if (!key) return { ok: false, reason: 'signature' }
      return await verifyLicense(token, key, Math.floor(Date.now() / 1000))
    },
    claimMachine: async (acct, key, max, mid) => {
      try {
        return (await this.env.ACCOUNTS.getByName(acct).claim(key, max, mid)) as ClaimResult
      } catch {
        // ⚠️ Cannot reach the ledger ⇒ do not let it through (treated like a room without a ticket = works as before during the grace period)
        return 'machine-limit'
      }
    },
    licenseRequired: () => {
      const from = Date.parse(this.env.LICENSE_REQUIRED_FROM ?? '')
      return Number.isFinite(from) && Date.now() >= from
    },
    selfHosted: () => this.env.SELF_HOSTED === '1',
  })

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // ★★ **relay itself answers the keepalive signal** (③ of ③b / `shared/relayFrame.ts`).
    //   ⚠️⚠️ Without it, connected peers could only send **signals with content**,
    //      waking the DO each time = **it could never hibernate** (exceeds the free tier).
    //   ★ Official: matching requests are answered "**without waking it and without incurring billable duration**".
    //   ⚠️ The constructor runs on every wake (= every return from hibernation), so this is enough here.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(RELAY_PING, RELAY_PONG))
  }

  /** ⚠️ Reading and writing tags uses the Durable Object API (`Room` only knows the shape) */
  #wrap(ws: WebSocket): RoomSocket {
    const found = this.#wrapped.get(ws)
    if (found) return found
    const socket: RoomSocket = {
      send: (bytes) => ws.send(bytes),
      close: (code, reason) => ws.close(code, reason),
      tag: () => (ws.deserializeAttachment() as Tag | null) ?? null,
      setTag: (tag) => ws.serializeAttachment(tag),
    }
    this.#wrapped.set(ws, socket)
    return socket
  }

  /** ★ A passphrase was removed from the account (from `Accounts.release` / `revokeLicense` in `room.ts`) */
  async revokeLicense(acct: string, mid: string): Promise<void> {
    this.#room.revokeLicense(acct, mid)
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const side = url.pathname.endsWith('/agent') ? 'agent' : 'device'
    const admit = side === 'agent' ? this.#room.admitAgent() : this.#room.admitDevice()
    if (!admit.ok) return new Response(admit.text, { status: admit.status })

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
    this.ctx.acceptWebSocket(server, [side])
    if (side === 'agent') {
      // ★ `c=1` = the agent announced it understands `drop` / `ready` (`relayUrl` in `shared/relayFrame.ts`)
      //   ★ `l=1` = it understands tickets too (2026-09-24 / codex round 26). ⚠️ `c=2` is a shape handed out briefly (still accepted):
      //     old relays only check `c === '1'`, so `c=2` lost `drop` / `ready` as well
      const c = url.searchParams.get('c')
      const control = c === '1' || c === '2'
      const licensing = c === '2' || (c === '1' && url.searchParams.get('l') === '1')
      await this.#room.startAgent(this.#wrap(server), url.searchParams.get('a') ?? '', control, licensing)
    } else {
      this.#room.startDevice(this.#wrap(server))
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.#room.onMessage(this.#wrap(ws), message)
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.#room.onClose(this.#wrap(ws))
    // ★★ **Reply** to a received close (2026-09-15 / codex round 4, medium #4).
    //   ⚠️ Without a reply the normal close never completes, and the peer sees 1006 (abnormal closure).
    //   ⚠️ 1005 / 1006 are **codes that cannot be sent**, so replace them with 1000.
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason)
    } catch {
      // ⚠️ Already closed from our side (= nothing to do)
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    // ⚠️ Go through the same cleanup as `close` (writing it on only one side leaks)
    this.#room.onClose(this.#wrap(ws))
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    // ★ Only `/v1/agent` / `/v1/device`. ⚠️ The version is in the path (keeps it replaceable)
    const matched = /^\/v(\d+)\/(agent|device)$/.exec(url.pathname)
    if (!matched) return new Response('not found', { status: 404 })
    if (matched[1] !== String(RELAY_V)) {
      return new Response('Unknown version / 知らない版です', { status: 426 })
    }
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Connect with WebSocket / websocket でつないでください', { status: 426 })
    }
    const key = url.searchParams.get('a') ?? ''
    // ⚠️ **Only the shape is checked** (ownership is proven in `room.ts`)
    if (!KEY_RE.test(key)) return new Response('Malformed key / 鍵の形が違います', { status: 400 })

    // ★★ **One room per agent public key** (= the rendezvous)
    return await env.RENDEZVOUS.getByName(key).fetch(request)
  },
} satisfies ExportedHandler<Env>
