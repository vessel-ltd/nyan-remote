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
// ★ Three Durable Objects: `Rendezvous` (one per agent key = the room), `Accounts` (one per account = machines of a plan /
//   `ledger.ts`) and `Phones` (one per phone key = machines used on the free tier without sign-in / `phoneLedger.ts` / 2026-09-27).
// ⬜ **Not there yet**: daily bandwidth per key (the other half of the ToS measure in §14.1.1.4. The per-message limit is in)

import { DurableObject } from 'cloudflare:workers'
import { ECDH_PARAMS, fromBase64Url, type Jwk } from '../../shared/crypto.ts'
import { RELAY_PING, RELAY_PONG, RELAY_V } from '../../shared/relayFrame.ts'
import { CHALLENGE_NONCE_BYTES, KEY_RE, Room, type ClaimResult, type PhoneClaimResult, type RoomSocket, type Tag } from './room.ts'
import { importLicensePublicKey, LICENSE_PUBLIC_KEY, verifyLicense, type LicenseCheck } from '../../shared/license.ts'
import { claimMachine, readLedger, releaseCredential, type Ledger } from './ledger.ts'
import { claimRoom, readPhoneLedger } from './phoneLedger.ts'

export interface Env {
  RENDEZVOUS: DurableObjectNamespace<Rendezvous>
  /** ★ Per-account ledger of "machines in use" (2026-09-24 / billing / `ledger.ts`) */
  ACCOUNTS: DurableObjectNamespace<Accounts>
  /** ★ Per-phone ledger of "machines used on the free tier" (2026-09-27 / `phoneLedger.ts`) */
  PHONES: DurableObjectNamespace<Phones>
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

/**
 * ★★ Per-phone ledger (one per phone public key / 2026-09-27). ⚠️ Decisions are in `phoneLedger.ts` (this only wires reads and writes).
 */
export class Phones extends DurableObject<Env> {
  /**
   * @param dkey this phone's key (= this object's name; the room it moved away from is told which phone)
   * @param licensed the room has a plan ticket (⇒ released from this ledger instead of counted)
   * @param takeover move the free slot here (⇒ the rooms it leaves are told **before** the ledger is written, like `Accounts.release`)
   * ⚠️⚠️ The whole step is under `blockConcurrencyWhile`: the notification is an RPC (not a storage op), so without it a second claim
   *    of the same phone could read the ledger in between and the last write would win (two machines on the free tier).
   */
  async claim(dkey: string, agentKey: string, licensed: boolean, takeover: boolean): Promise<PhoneClaimResult> {
    return await this.ctx.blockConcurrencyWhile(async () => {
      const r = claimRoom(readPhoneLedger(await this.ctx.storage.get('rooms')), agentKey, licensed, Date.now(), undefined, takeover)
      // ⚠️ If a room cannot be told, throw (the caller answers `unavailable` and the phone tries again; the ledger stays as it was)
      for (const room of r.moved) await this.env.RENDEZVOUS.getByName(room).phoneFreeMoved(dkey)
      await this.ctx.storage.put('rooms', r.ledger)
      return r.ok ? 'ok' : 'machine-limit'
    })
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
    claimPhone: async (dkey, agentKey, licensed, takeover) => {
      try {
        return await this.env.PHONES.getByName(dkey).claim(dkey, agentKey, licensed, takeover)
      } catch {
        // ⚠️ Cannot reach the ledger ⇒ `room.ts` refuses a free-tier phone (fail-closed) and lets a licensed room carry on
        return 'unavailable'
      }
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

  /** ★ A phone moved its free slot to another machine (from `Phones.claim` / `phoneFreeMoved` in `room.ts`) */
  async phoneFreeMoved(dkey: string): Promise<void> {
    this.#room.phoneFreeMoved(dkey)
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
      // ★ `p=1` = the phone answers the key proof; `f=1` = it asks to move its free slot here (2026-09-27 / `relayUrl` in `shared/relayFrame.ts`)
      await this.#room.startDevice(this.#wrap(server), url.searchParams.get('p') === '1', url.searchParams.get('f') === '1')
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
