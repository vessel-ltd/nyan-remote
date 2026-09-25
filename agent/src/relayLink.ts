// ③ stage 6 step ③b①: **the relay link** (agent side / ARCHITECTURE §14.1.2.26).
//
// ★ Only one job: **connect relay envelopes (`shared/relayFrame.ts`) to tunnels**.
//   Receives `opened` / `data` / `closed` and, **per connection number**, handshakes → hands off to `openTunnel`.
//
// ★★ **The tunnel's first message (the handshake) flows raw, not enveloped** (the core of ③'s design):
//
// ```
//   device → agent : [init]                 ← raw (the first message of `shared/crypto.ts`)
//   agent → device : [reply][confirm]       ← reply is raw, confirm is enveloped (in this order, first)
//   afterwards     : tunnel envelopes (`shared/tunnel.ts`)
// ```
//
//   ⚠️⚠️ The order is `acceptHandshake`'s contract (`reply` → `confirm` → any session frame).
//      If swapped, the device **discards the later-arriving `confirm` as a rollback** = the handshake never completes.
//      ⇒ **Put them on one line (WebSocket) in order**.
//
// ★★ **One chain per number** (`Slot.chain`).
//   ⚠️⚠️ The handshake is async, so without serialization **a `closed` arriving while the first message is
//      being processed finishes cleanup first** → the handshake then completes and **leaves a tunnel nobody discards**
//      (= a `/events` subscription lives forever). ⇒ Work for the same number always runs in order.
//
// ★★ **Never send a single byte to a number whose peer is gone** (guarded in one place, `sendTo`).
//   ⚠️⚠️ The relay **reuses connection numbers** (counting from live slots / `relay/src/worker.ts`).
//      An envelope addressed to a peer that left **reaches the next phone connected under the same number**. It cannot open it,
//      judges it "tampered with" and drops the connection = **an unrelated device breaks**.
//
// ⚠️ Not there yet (stated honestly / **not written ahead of time**):
//   ⬜ reconnecting (③b step ④). For now, when the link drops it just does `down()`
//   ⬜ backpressure (`bufferedAmount` is not looked at)
//   ★ proof of key ownership is in (`connectRelay` / §14.1.2.30)

import { pickBilingual, t } from '../../shared/i18n.ts'
import { relayProof, toBase64Url } from '../../shared/crypto.ts'
import type { RelayState } from '../../shared/types.ts'
import { decodeChallenge, encodeProof } from '../../shared/relayAuth.ts'
import {
  LICENSE_STATUS,
  RELAY_FRAME,
  RELAY_PING,
  RELAY_PING_MS,
  RELAY_PONG,
  decodeRelayFrame,
  encodeRelayFrame,
  relayUrl,
  type LicenseStatus,
} from '../../shared/relayFrame.ts'
import { acceptDeviceHandshake, isPairingConnection } from './auth.ts'
import { agentKey, agentPublicRaw } from './deviceKey.ts'
import type { Router } from './router.ts'
import { openTunnel, type Tunnel } from './tunnel.ts'

/** One link to the relay (⚠️ **must preserve order**. The real one is a WebSocket) */
export interface RelaySocket {
  send(bytes: Uint8Array): void | Promise<void>
  close(code?: number, reason?: string): void
}

export interface RelayLink {
  /**
   * Hands over one byte sequence received from the relay.
   *
   * ⚠️⚠️ **Never throws** (an exception inside the carrier's `onmessage` breaks the whole link).
   * ★ The promise returned resolves "when that number's chain is empty" (so tests can wait).
   */
  receive(bytes: Uint8Array): Promise<void>
  /** The link dropped / is being dropped. **Discards every tunnel** (⚠️ sends nothing) */
  down(reason?: string): Promise<void>
  /**
   * ★ Waits until every number's chain and the tunnels' sends are empty.
   *
   * ⚠️ Needed for the same reason as `Tunnel.flush`: events are enveloped **asynchronously** from inside `write`, so
   *    closing the link without waiting **loses the last frame**.
   */
  flush(): Promise<void>
  /** Number of tunnels open now (= phones that finished the handshake; for tests and diagnostics) */
  readonly openTunnels: number
  /** Number of phones the relay has connected (★ counted before the handshake too = watches that the table does not pile up) */
  readonly connections: number
}

interface Slot {
  /** ★ Serializes this number's work into one chain (see the header notes) */
  chain: Promise<void>
  tunnel?: Tunnel
  /** ⚠️ The peer is gone (`closed` / number reuse / link dropped). **Must not send** */
  gone?: boolean
  /** ⚠️ Untrusted (handshake refused / envelope tampered). Accept nothing until `closed` arrives */
  dead?: boolean
}

function text(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * ★★ How long a pairing-only connection is kept (2026-09-24 / codex round 18, high #1).
 * ⚠️⚠️ During `npm run pair` we answer handshakes even from unregistered devices, so the relay treats that link as "admitted".
 *    ⇒ Someone who knows the key could just handshake and stay silent, **occupying a relay slot even after the one-time token expired**.
 *    ⇒ When the deadline comes, send `drop` to the relay to have it closed (real pairing finishes within seconds).
 */
export const PAIRING_ONLY_TTL_MS = 30_000

/**
 * ★★ The license hand-off (2026-09-24 / billing / docs/BILLING.md). Held by `agent/src/account.ts`.
 * ⚠️ Sent only on links where the relay said `want` (old relays cut the whole agent link on anything but data).
 */
export interface Licensing {
  /** The license held now (⚠️ undefined if none = do not send) */
  current(): string | undefined
  /** Called when the license is renewed (⚠️ unsubscribe via the return value) */
  subscribe(fn: () => void): () => void
  /** Reports the relay's reply (`ok` / `machine-limit` …) (shown by `/health` and `nyan account`) */
  report(status: LicenseStatus): void
}

export function openRelayLink(o: {
  router: Router
  socket: RelaySocket
  /** ⚠️ For tests (default `PAIRING_ONLY_TTL_MS`) */
  pairingTtlMs?: number
  licensing?: Licensing
}): RelayLink {
  /** ★ connection number → one phone (⚠️ only numbers created by `opened` are accepted) */
  const slots = new Map<number, Slot>()
  /** ⚠️ Why the link dropped (`undefined` means alive. ★ Checked in a way that does not confuse it with an empty string) */
  let linkGone: string | undefined
  /**
   * ★★ The relay said it accepts `drop` (received `ready` / 2026-09-24).
   * ⚠️⚠️ Until this is set, **`drop` is not sent** (old relays cut the whole agent link on anything but data).
   */
  let canDrop = false
  /** ★ The relay said it accepts licenses (`want`). ⚠️ No license is sent until it is set */
  let offLicense: (() => void) | undefined

  function sendLicense(): void {
    const tok = o.licensing?.current()
    if (!tok || linkGone !== undefined) return
    void Promise.resolve()
      .then(() => o.socket.send(encodeRelayFrame({ type: RELAY_FRAME.license, connId: 0, payload: new TextEncoder().encode(tok) })))
      .catch(() => undefined)
  }

  /**
   * ★★ Asks the relay to "close the phone link for this number" (2026-09-24 / codex round 18, high #1).
   * ⚠️ Does nothing without `ready` (as before = left to the relay's deadline and eviction).
   * ⚠️ Does not throw even if it cannot send (if the link is down, the relay closes everything).
   */
  function dropConn(connId: number): void {
    if (!canDrop || linkGone !== undefined) return
    void Promise.resolve()
      .then(() => o.socket.send(encodeRelayFrame({ type: RELAY_FRAME.drop, connId })))
      .catch(() => undefined)
  }

  /**
   * ★★ **This is the only place that sends** (both raw handshake messages and tunnel envelopes go through it).
   *
   * ⚠️⚠️ Do not make "do not send if the peer is gone" **a caller's etiquette**
   *    (etiquette is always forgotten somewhere = runs into the "number reuse" in the header).
   * ★ Only `slot.gone` is checked (adding `linkGone` **only gives the same result** =
   *   a safeguard tests cannot kill / mutation M4 on 2026-09-15). When the link drops,
   *   `down()` **marks every number**, so one invariant is enough.
   */
  async function sendTo(slot: Slot, connId: number, payload: Uint8Array): Promise<void> {
    if (slot.gone) return
    await o.socket.send(encodeRelayFrame({ type: RELAY_FRAME.data, connId, payload }))
  }

  /** ⚠️ The chain only provides "order" (it swallows failures; if it broke, that number would stop from then on) */
  function queue(slot: Slot, job: () => Promise<void>): Promise<void> {
    slot.chain = slot.chain.then(job).then(
      () => undefined,
      (err: unknown) => {
        console.warn(t(`[relay] 処理に失敗しました: ${text(err)}`, `[relay] Processing failed: ${text(err)}`))
      },
    )
    return slot.chain
  }

  /**
   * ★ Cleans up a number whose peer is gone (⚠️⚠️ **sends nothing** / see the header notes).
   *
   * ★ Changing this to `close()` **stays green in tests** (the `gone` check in `sendTo` gives the same result /
   *   mutation M6 on 2026-09-15). `abandon()` is still called to prevent **someone looking only at the tunnel
   *   from calling `close()`** (= a safeguard on the "API easy to misuse" side).
   *   ⚠️ `abandon()` itself is checked by name in `agent/src/tunnel.test.ts` (mutations M16 / M17).
   */
  function retire(slot: Slot): Promise<void> {
    // ⚠️ the mark is set **synchronously** (so `sendTo` stops even while the handshake is running)
    slot.gone = true
    return queue(slot, async () => {
      slot.tunnel?.abandon()
      slot.tunnel = undefined
    })
  }

  /**
   * ★ Receives the first (raw) message and handshakes.
   *
   * ⚠️ The refusal reason is **not returned to the peer** (no plaintext channel outside envelopes = the peer notices by timeout).
   *    ⬜ Showing a reason would need a frame type telling the relay to "cut it" (none exists now).
   */
  async function handshake(connId: number, slot: Slot, init: Uint8Array): Promise<void> {
    let accepted: Awaited<ReturnType<typeof acceptDeviceHandshake>>
    try {
      accepted = await acceptDeviceHandshake(init)
    } catch (err) {
      // ⚠️ unregistered, revoked, or the agent key is broken. **This number is no longer accepted**
      slot.dead = true
      console.warn(t(`[relay] 握手を断りました（#${connId}）: ${text(err)}`, `[relay] Rejected handshake (#${connId}): ${text(err)}`))
      // ★ free the relay slot right away (⚠️ no reason returned = just close)
      dropConn(connId)
      return
    }
    // ★★ **in this order, before any session frame** (`acceptHandshake`'s contract)
    await sendTo(slot, connId, accepted.reply)
    await sendTo(slot, connId, accepted.confirm)
    slot.tunnel = openTunnel({
      connection: accepted.connection,
      router: o.router,
      sender: { send: (frame) => sendTo(slot, connId, frame) },
    })
    // ★★ pairing-only connections have a deadline (see the notes on `PAIRING_ONLY_TTL_MS`).
    //   ⚠️ when it comes, stop accepting this number (`dead`), discard the tunnel, and have the relay close it.
    if (isPairingConnection(accepted.connection)) {
      const timer = setTimeout(() => {
        if (slots.get(connId) !== slot || slot.gone || slot.dead) return
        slot.dead = true
        void queue(slot, async () => {
          slot.tunnel?.abandon()
          slot.tunnel = undefined
        })
        dropConn(connId)
      }, o.pairingTtlMs ?? PAIRING_ONLY_TTL_MS)
      // ⚠️ do not keep the process alive for this watcher
      ;(timer as { unref?: () => void }).unref?.()
    }
  }

  function receive(bytes: Uint8Array): Promise<void> {
    if (linkGone !== undefined) return Promise.resolve()
    const decoded = decodeRelayFrame(bytes)
    if (!decoded.ok) {
      // ⚠️⚠️ the relay is not keeping its promises = **this link cannot be trusted** (reconnecting is ③b step ④)
      return down(t(`relay からの封が読めません（${decoded.reason}）`, `Cannot read a frame from the relay (${decoded.reason})`))
    }
    const frame = decoded.value
    // ★★ the relay said it accepts `drop` (only sent to links that declared `c=1`)
    if (frame.type === RELAY_FRAME.ready) {
      canDrop = true
      return Promise.resolve()
    }
    // ★★ the license reply (only sent to links that declared `l=1` / 2026-09-24)
    if (frame.type === RELAY_FRAME.licenseResult) {
      const status = new TextDecoder().decode(frame.payload)
      if (!(LICENSE_STATUS as readonly string[]).includes(status)) return Promise.resolve()
      if (status === 'want') {
        // ★ once told it is accepted, send the current license, and resend whenever it is renewed
        if (!offLicense && o.licensing) offLicense = o.licensing.subscribe(sendLicense)
        sendLicense()
        return Promise.resolve()
      }
      o.licensing?.report(status as LicenseStatus)
      return Promise.resolve()
    }
    // ⚠️⚠️ licenses are issued by the agent (they never come from the relay)
    if (frame.type === RELAY_FRAME.license) return down(t('relay から来てはいけない種別です（license）', 'The relay sent a frame type it must not send (license)'))
    // ⚠️⚠️ `drop` is issued by the agent (it never comes from the relay) ⇒ it is not keeping its promises
    if (frame.type === RELAY_FRAME.drop) return down(t('relay から来てはいけない種別です（drop）', 'The relay sent a frame type it must not send (drop)'))
    const slot = slots.get(frame.connId)

    if (frame.type === RELAY_FRAME.opened) {
      slots.set(frame.connId, { chain: Promise.resolve() })
      // ⚠️ numbers are reused ⇒ if a previous occupant remains, discard it **without sending**
      return slot ? retire(slot) : Promise.resolve()
    }

    if (frame.type === RELAY_FRAME.closed) {
      if (!slot) return Promise.resolve()
      slots.delete(frame.connId)
      return retire(slot)
    }

    // ⚠️⚠️ **numbers whose `opened` we have not seen are not accepted** (accepting them would let a stray
    //    envelope that reached a closed number **come back to life as a new handshake**)
    if (!slot || slot.dead) return Promise.resolve()
    const payload = frame.payload
    // ⚠️ `decodeRelayFrame` requires content for `data`, but this closes the branch at the type level
    if (!payload) return Promise.resolve()

    return queue(slot, async () => {
      // ★★ **check inside the chain too** (2026-09-15 / codex round 4, medium #7).
      //   ⚠️⚠️ even if alive when queued, it may run **after earlier work refused it** (tampering, failed handshake)
      //      ⇒ without checking, **the handshake could be retried** on a refused number.
      // ★★ **do not run requests for a number whose peer is gone** (2026-09-24 / codex round 18, medium #5).
      //   ⚠️⚠️ requests are processed one at a time per number (`deliver` does not return until the response is sent), so requests
      //      queued behind a slow one were run **after the phone had dropped the link** (the phone shows "failed" but keystrokes land on the PC
      //      ⇒ if the user resends, **it goes in twice**). For `closed`, `retire` sets `gone` **synchronously**, so
      //      checking here gives "a request shown as failed does not run if it has not started".
      if (slot.dead || slot.gone) return
      const tunnel = slot.tunnel
      if (!tunnel) return await handshake(frame.connId, slot, payload)
      const result = await tunnel.deliver(payload)
      if (result.ok || !result.fatal) return
      // ⚠️⚠️ tampering, replay, or an unanswerable request. **The peer is still connected**, so tell the reason in an envelope
      //    (★ after that this number is not accepted = the path to retrying the handshake is closed too)
      slot.dead = true
      slot.tunnel = undefined
      await tunnel.close(result.reason).catch(() => undefined)
      // ★ after telling the reason in an envelope, have the relay close it too (same link order, so the reason arrives first)
      dropConn(frame.connId)
    })
  }

  async function flush(): Promise<void> {
    await Promise.all(
      [...slots.values()].map((slot) =>
        queue(slot, async () => {
          await slot.tunnel?.flush()
        }),
      ),
    )
  }

  async function down(reason?: string): Promise<void> {
    if (linkGone !== undefined) return
    linkGone = reason ?? t('relay の線が切れました', 'The relay link was lost')
    offLicense?.()
    offLicense = undefined
    const all = [...slots.values()]
    slots.clear()
    // ★★ **mark every number** here (the only invariant `sendTo` looks at / notes above)
    // ⚠️ closing is harmless no matter how many times it is called (it can also be called because it dropped)
    try {
      o.socket.close()
    } catch {
      // ⚠️ keep cleaning up (a subscription left open because it could not close is worse)
    }
    await Promise.all(all.map((slot) => retire(slot)))
  }

  return {
    receive,
    down,
    flush,
    get openTunnels() {
      return [...slots.values()].filter((s) => s.tunnel !== undefined).length
    },
    get connections() {
      return slots.size
    },
  }
}

/**
 * ★ Connects to the relay with a real WebSocket (agent → relay is **outbound only** = no certificate needed).
 *
 * ★★ **The first message is a challenge from the relay** (③b step ④a / `shared/relayAuth.ts`).
 *   The relay does not treat us as "the agent" until the proof is returned = **knowing the key alone does not let you claim it**.
 *   ⚠️ Same idea as the tunnel's first message (only the first exchange is raw = decided by phase).
 * ⚠️ Reconnecting is `keepRelayConnected` (this only opens one link). The caller decides in `onDown`.
 * ⚠️ Verification is `scripts/relay-smoke.mjs` (run against **the real relay**).
 */
/**
 * ★★ **Drop a link that returns no pong** (2026-09-19 / hit in practice).
 *
 * ⚠️⚠️ **Sending pings alone does not tell you it is alive.** Before the fix, `RELAY_PING` was sent every 45 seconds
 *    fire-and-forget, and the returned `RELAY_PONG` was **never looked at** (it was text, so the receiver discarded it).
 *    ⇒ When the link **half-dies** (TCP silently cut):
 *      - `ws.send()` does not throw (it just queues into the buffer)
 *      - `close` **does not come until the OS TCP timeout** (in practice it did not come for over 2 hours)
 *      - `keepRelayConnected` only acts on `onDown`, so it **does not reconnect**
 *      - `/health` says `open` = **it lies**
 *    ⇒ From the relay's view there is no agent, so **phone handshakes go nowhere and nothing appears in the log**
 *      (exactly the real-world symptom; the moment TCP finally died it reconnected within a second and "fixed itself").
 *
 * ★ The relay registers `setWebSocketAutoResponse(RELAY_PING → RELAY_PONG)`, so
 *   **a pong coming back is the only evidence that "this link is alive"** (§14.1.2.28).
 * ⚠️ Missing one or two is tolerated (dropping by mistake **disconnects phones on reconnect** / replacement in `room.ts`).
 */
export const PONG_GRACE = 2

/** ⚠️ The decision lives only here (`connectRelay` creates a real WebSocket, so it does not run from tests) */
export function pongOverdue(o: { lastPongAt: number; now: number; pingMs: number }): boolean {
  return o.now - o.lastPongAt > o.pingMs * PONG_GRACE
}

export function connectRelay(o: {
  /** Relay entry point (e.g. `wss://nyan-relay.example.workers.dev`) */
  base: string
  router: Router
  /** When the link drops (⚠️ the reconnect decision is the caller's) */
  onDown?: (reason: string) => void
  /** ⚠️ Ping interval (for tests and smoke. Never passed from the screen or production) */
  pingMs?: number
  /**
   * ⚠️ How to open the link (**for tests**; defaults to the real `WebSocket`).
   *
   * ★ Why it was added (2026-09-19 / codex round 10, high #1): this was a hard-coded `new WebSocket(url)`, so
   *   **cleanup of an unresponsive link never ran a single line from tests** (the same hole as `worker.ts`).
   *   ⇒ It had indeed missed that "just calling `close()` does not bring it back".
   */
  open?: (url: string) => WebSocket
  licensing?: Licensing
}): Promise<RelayLink> {
  // ⚠️ the key used to identify is **this agent's static key** (`deviceKey.ts`; throws if broken)
  // ★ `c=1`: declares it understands `ready` / `drop` (old relays ignore it = harmless)
  // ★ `l=1`: additionally understands licenses (2026-09-24). ⚠️ declared only when we have the license hand-off
  const url = relayUrl(o.base, 'agent', toBase64Url(agentPublicRaw()), { control: true, license: o.licensing !== undefined })
  const ws = (o.open ?? ((u: string) => new WebSocket(u)))(url)
  ws.binaryType = 'arraybuffer'
  const link = openRelayLink({
    router: o.router,
    // ⚠️ `ws.send` queues in order (= the order of the two handshake messages is preserved)
    socket: { send: (bytes) => ws.send(bytes), close: () => ws.close() },
    ...(o.licensing ? { licensing: o.licensing } : {}),
  })
  /** ⚠️ Time the last pong came back (★ the starting point is set at `open`) */
  let lastPongAt = 0
  return new Promise<RelayLink>((resolve, reject) => {
    // ⚠️ a failure before opening is returned as "could not connect"; after opening it goes to `onDown` (only once)
    let settled = false
    // ★★ **no envelopes are accepted until the proof is done** (the first message is the relay's challenge)
    let proved = false
    ws.addEventListener('message', (ev: MessageEvent) => {
      // ⚠️ text is not carried (the relay rejects text too. ★ the ping's pong arrives here)
      if (typeof ev.data === 'string') {
        // ★★ **a pong is the only evidence that "this link is alive"** (look before discarding / notes above)
        if (ev.data === RELAY_PONG) lastPongAt = Date.now()
        return
      }
      const bytes = new Uint8Array(ev.data as ArrayBuffer)
      if (proved) {
        void link.receive(bytes)
        return
      }
      const challenge = decodeChallenge(bytes)
      if (!challenge.ok) {
        // ⚠️⚠️ the first message is not a challenge = the peer is not the promised relay. **Hand over nothing**
        ws.close()
        return
      }
      proved = true
      void (async () => {
        try {
          // ⚠️ the private key is from `deviceKey.ts` (★ ECDH, not signing = do not add uses to the key)
          const tag = await relayProof(
            agentKey().privateKey,
            challenge.value.relayPublicRaw,
            challenge.value.nonce,
          )
          ws.send(encodeProof(tag))
        } catch {
          // ⚠️ the key is unusable, or it is closing. ⇒ close the link (the `close` handler cleans up)
          ws.close()
        }
      })()
    })
    // ★★ **pings that keep the link alive** (③b step ③ / `shared/relayFrame.ts`).
    //   ⚠️⚠️ sending a ping with content (the heartbeat in `events.ts`) means **the DO can never hibernate**.
    //      ⇒ keep it alive with a pair of **text** messages the relay answers by itself (does not wake it, not billed).
    //   ⚠️ the returned pong is **text**, so the receiver above discards it.
    let beat: ReturnType<typeof setInterval> | undefined
    const pingMs = o.pingMs ?? RELAY_PING_MS
    /**
     * ★★ **Clean up only once. Do not wait for the `close` event** (2026-09-19 / codex round 10, high #1).
     *
     * ⚠️⚠️ Before the fix, an unresponsive link only got `ws.close()`. **That does not bring it back**:
     *    calling `close()` on a black-holed link puts the WebSocket **into `CLOSING`, waiting for
     *    the peer's close reply**. The reply never comes, so **the `close` event never comes** =
     *    neither `onDown` nor `clearInterval` runs. ⇒ **The "does not recover until the TCP timeout" we wanted
     *    to fix was still there** (codex measured `readyState=2` / `onDown=0` over the equivalent of 15 minutes).
     * ⇒ **Complete the logical disconnect on our side** (sending is best-effort).
     * ⚠️ If a real `close` arrives later, **the second time does nothing** (stopped by `torn`).
     */
    let torn = false
    const tearDown = (reason: string) => {
      if (torn) return
      torn = true
      if (beat !== undefined) clearInterval(beat)
      void link.down(reason)
      if (!settled) {
        settled = true
        reject(new Error(reason))
        return
      }
      o.onDown?.(reason)
    }
    ws.addEventListener('open', () => {
      settled = true
      // ⚠️ use the moment it opened as the starting point (★ left at 0, the first tick always drops it)
      lastPongAt = Date.now()
      beat = setInterval(() => {
        // ★★ **drop a link with no reply** (⚠️ do not wait for the `close` event = notes above)
        if (pongOverdue({ lastPongAt, now: Date.now(), pingMs })) {
          console.warn(t('[relay] 合図の返事がありません。線を捨てて繋ぎ直します', '[relay] No reply to ping. Dropping the link and reconnecting'))
          // ⚠️ best-effort close. ⚠️⚠️ **never wait for the reply**
          try {
            ws.close()
          } catch {
            // ⚠️ proceed with cleanup even if it cannot close
          }
          tearDown(t('relay の線が無反応です（合図の返事がありません）', 'The relay link is unresponsive (no reply to ping)'))
          return
        }
        try {
          ws.send(RELAY_PING)
        } catch {
          // ⚠️ closing. The `close` handler does the cleanup
        }
      }, pingMs)
      // ⚠️ without this the agent process could not exit
      beat.unref?.()
      resolve(link)
    })
    ws.addEventListener('error', () => {
      // ⚠️ per spec `close` follows `error`, but **do not rely on implementations where it does not** (notes above)
      tearDown(
        settled
          ? t('relay の線でエラーが起きました', 'An error occurred on the relay link')
          : t(`relay に繋がりません（${url}）`, `Cannot connect to the relay (${url})`),
      )
    })
    ws.addEventListener('close', (ev: CloseEvent) => {
      // ⚠️⚠️ always go through cleanup (before or after opening). ★ `tearDown` stops the second time
      const detail = `${ev.code}${ev.reason ? `: ${pickBilingual(ev.reason)}` : ''}`
      tearDown(t(`relay の線が切れました（${detail}）`, `The relay link was lost (${detail})`))
    })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// ★★ ③b step ④: **reconnecting** (the agent comes back even if the relay goes down).
//
//   ⚠️⚠️ The relay is not in "the daily critical path" (Claude on the PC keeps working if it goes down), but
//      **if it stays down, the phone can never connect**. ⇒ Put a single watcher in place.
//   ★ Same shape as `Tunnel` / `RelayLink`: **the way to connect can be passed in** (tests pass a fake).
// ─────────────────────────────────────────────────────────────────────────────

/** ⚠️ The first wait (★ jitter applies, so in practice half to this value) */
const RETRY_MIN_MS = 1_000
/** ⚠️ The wait ceiling (never longer = do not keep it waiting long once it is back) */
const RETRY_MAX_MS = 60_000
/**
 * ★★ Staying connected this long counts as "settled" (= the next disconnect **starts over**).
 *
 * ⚠️⚠️ **Do not reset the wait to 0 merely on connecting**: against a relay that cuts right after connecting (during deploy,
 *    device limits, rejected by proof of ownership, etc.), it would **keep hammering with the minimum wait**.
 */
const STABLE_MS = 30_000

export interface RelayStatus {
  /** ⚠️ Words are **the same table** as `RelayState` in `shared/types.ts` (`off` is added by relayRun.ts) */
  state: Exclude<RelayState, 'off'>
  /** ★ Consecutive failures (⚠️ **reset to 0 on connecting**) */
  attempts: number
  /** Why it last dropped / could not connect (⚠️ shown on screen and in diagnostics) */
  lastError?: string
  /** Wait until the next attempt (⚠️ only when `waiting`) */
  waitMs?: number
}

export interface RelayKeeper {
  readonly status: RelayStatus
  /** ⚠️ The link connected now (**replaced when it drops** = do not hold on to it) */
  readonly link: RelayLink | undefined
  /** Stops the whole watcher (⚠️ stops **immediately** even while waiting) */
  stop(reason?: string): Promise<void>
}

/**
 * Keeps connecting to the relay.
 *
 * ⚠️⚠️ **Never remove the jitter**: with identical waits, the moment the relay comes back
 *    every agent hammers it **all at once** (and on failure, they all hit it again together).
 * ⚠️ **Reset the wait once connected** (otherwise after one failure it **always waits long**).
 * ⬜ PWA-side reconnecting is ④ (⚠️ subscriptions must be re-established, so decide it together with route selection).
 */
export function keepRelayConnected(o: {
  base: string
  router: Router
  /** ⚠️ Replaced **only for tests** (defaults to the real WebSocket) */
  connect?: (a: {
    base: string
    router: Router
    onDown: (reason: string) => void
  }) => Promise<RelayLink>
  minWaitMs?: number
  maxWaitMs?: number
  /** ⚠️ How long counts as "settled" (⚠️ making it shorter leans toward **hammering**) */
  stableMs?: number
  /** ⚠️ For tests (default `Math.random`) */
  random?: () => number
  /** ⚠️ Ping interval (for smoke. ⚠️ the default is fine / `shared/relayFrame.ts`) */
  pingMs?: number
  onStatus?: (s: RelayStatus) => void
  /** ★ The license hand-off (`account.ts`). ⚠️ Without it, stays at `c=1` (as before) */
  licensing?: Licensing
}): RelayKeeper {
  const minWait = o.minWaitMs ?? RETRY_MIN_MS
  const maxWait = o.maxWaitMs ?? RETRY_MAX_MS
  const stableMs = o.stableMs ?? STABLE_MS
  const random = o.random ?? Math.random
  const connect =
    o.connect ??
    ((a: { base: string; router: Router; onDown: (reason: string) => void }) =>
      connectRelay({ ...a, ...(o.pingMs === undefined ? {} : { pingMs: o.pingMs }), ...(o.licensing ? { licensing: o.licensing } : {}) }))

  let status: RelayStatus = { state: 'connecting', attempts: 0 }
  let link: RelayLink | undefined
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  /** ⚠️ The hook that **always** wakes whatever is waiting now (sleeping / waiting to drop) */
  let interrupt: (() => void) | undefined
  /**
   * ★★ **Do not make `stop()` wait while connecting** (2026-09-15 / codex round 4, medium #8).
   *
   * ⚠️⚠️ While waiting on `connect()` there is neither `interrupt` nor `link`, so
   *    even after stopping it **did not stop until connected, and came back to life as `open` afterwards**.
   */
  let signalStopped: () => void = () => undefined
  const stoppedSignal = new Promise<undefined>((resolve) => {
    signalStopped = () => resolve(undefined)
  })

  function set(next: RelayStatus): void {
    status = next
    o.onStatus?.(next)
  }

  /** ★ Doubling + **jitter** (somewhere from half to the full amount) */
  function waitMs(attempts: number): number {
    const capped = Math.min(maxWait, minWait * 2 ** Math.min(attempts - 1, 20))
    return Math.round(capped / 2 + random() * (capped / 2))
  }

  async function sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      interrupt = resolve
      timer = setTimeout(resolve, ms)
      // ⚠️ without this the agent process could not exit
      timer.unref?.()
    })
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    interrupt = undefined
  }

  const loop = (async () => {
    while (!stopped) {
      set({ state: 'connecting', attempts: status.attempts, ...pickError(status) })
      let fallen: (reason: string) => void = () => undefined
      const fell = new Promise<string>((resolve) => {
        fallen = resolve
      })
      // ⚠️ the display goes back to 0, but the original count is remembered **for the decision not to keep hammering**
      const attemptsBefore = status.attempts
      let opened: RelayLink | undefined
      try {
        opened = await Promise.race([
          connect({ base: o.base, router: o.router, onDown: (r) => fallen(r) }).then((l) => {
            // ⚠️ if stopped while waiting, **discard it on the spot** (leave no link)
            if (stopped) void l.down(t('止めました', 'Stopped'))
            return l
          }),
          // ★ if stopped, **do not wait for the connection** (notes above)
          stoppedSignal,
        ])
      } catch (err) {
        link = undefined
        if (stopped) break
        await backoff(status.attempts + 1, text(err))
        continue
      }
      // ⚠️ stopped / could not connect (= exited via the signal)
      if (stopped || !opened) break
      link = opened
      // ★★ connected ⇒ the visible "consecutive failures" is 0 (⚠️ showing a count while connected is a lie)
      const openedAt = Date.now()
      set({ state: 'open', attempts: 0 })
      interrupt = () => fallen(t('止めました', 'Stopped'))
      const reason = await fell
      interrupt = undefined
      link = undefined
      if (stopped) break
      // ★★ start over **only if it had settled** (⚠️ do not keep hammering a peer that cuts right after connecting)
      const settledLong = Date.now() - openedAt >= stableMs
      await backoff(settledLong ? 1 : attemptsBefore + 1, reason)
    }
    set({ state: 'stopped', attempts: status.attempts, ...pickError(status) })
  })().catch((err: unknown) => {
    // ⚠️ if the watcher crashes, **do not stay silent** (otherwise nobody notices reconnecting stopped)
    console.error(t(`[relay] 繋ぎ直しの見張りが落ちました: ${text(err)}`, `[relay] The reconnect watcher crashed: ${text(err)}`))
  })

  async function backoff(attempts: number, why: string): Promise<void> {
    const ms = waitMs(attempts)
    set({ state: 'waiting', attempts, lastError: why, waitMs: ms })
    await sleep(ms)
  }

  async function stop(reason = t('止めました', 'Stopped')): Promise<void> {
    if (stopped) return
    stopped = true
    // ⚠️⚠️ stop **immediately** even while waiting (sleeping, "waiting to drop", **and while connecting**)
    interrupt?.()
    signalStopped()
    await link?.down(reason)
    await loop
  }

  return {
    get status() {
      return status
    },
    get link() {
      return link
    },
    stop,
  }
}

function pickError(s: RelayStatus): { lastError?: string } {
  return s.lastError === undefined ? {} : { lastError: s.lastError }
}
