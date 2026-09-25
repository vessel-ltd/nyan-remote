// ③ stage 6: the tunnel (agent side / ARCHITECTURE §14.1.2.22).
//
// ★ Only one job: **connect envelopes (`Session` frames) with "one request"**.
//   ⚠️⚠️ **The carrier (WebSocket / relay) is not written here.** It takes a `TunnelSender`,
//      so the same thing runs for stage 6 step ③ (CF Workers) and for test fakes.
//
// ★★ **Only the single path in `serve.ts` is used** (no second pipeline).
//   ⚠️ Writing the broken-config 503, CSRF, authentication and route matching in two places means **only one side gets fixed**.
//   ★ The tunnel differs in only two ways:
//      ① `allowStatic: false` (the tunnel is API only; it does not serve the PWA itself)
//      ② the request is marked with `markDeviceRequest` before passing through (= becomes `via:'device'`)
//
// ★★ **Headers are fixed by the agent** (read the notes in `shared/tunnel.ts`).
//   ⚠️⚠️ Not a single value from the peer goes into headers. If it could, it could **claim**
//      `tailscale-user-login` / `x-nyan-remote-token` / `origin`.
//
// ★★ **Sending is always serialized into one chain** (`sendChain`).
//   ⚠️⚠️ The receiver "discards when the counter goes back" (the only replay protection in `crypto.ts`), so
//      if **the send order differs from the sealing order, correct frames are discarded**.
//      `seal` decides the order internally, but **sending is the caller's responsibility**.
//
// ⚠️ Not there yet (stated honestly / **not written ahead of time**):
//   ⬜ traffic measurement (`beginMeasure` looks at the socket's `bytesWritten`, so tunnels cannot be measured)
//   ⬜ a timeout when a handler never responds (HTTP does not have one either; the PWA cuts at 10 seconds)
//   ⬜ there is no `user-agent`, so the push subscription label is empty (`routes/push.ts`)

import { EventEmitter } from 'node:events'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { FRAME, type Session } from '../../shared/crypto.ts'
import {
  TUNNEL_ORIGIN,
  type TunnelMethod,
  type TunnelRequest,
  decodeClose,
  decodeRequest,
  encodeClose,
  encodeEvent,
  encodeResponse,
} from '../../shared/tunnel.ts'
import {
  type DeviceConnection,
  isDeviceConnectionLive,
  isPairingConnection,
  markDeviceRequest,
} from './auth.ts'
import type { Router } from './router.ts'
import { handleRequest } from './serve.ts'
import { t } from '../../shared/i18n.ts'

/** A carrier of one envelope (WebSocket / relay / test fake). ⚠️ **Must preserve order** */
export interface TunnelSender {
  send(frame: Uint8Array): Promise<void> | void
}

export type DeliverResult =
  | { ok: true }
  /** ⚠️ If `fatal`, the carrier closes the connection (unanswerable / untrusted) */
  | { ok: false; fatal: boolean; reason: string }

export interface Tunnel {
  /** Processes one envelope from the peer. ⚠️ **Never throws** (returns a result) */
  deliver(frame: Uint8Array): Promise<DeliverResult>
  /**
   * ★ Waits until the send chain is empty.
   *
   * ⚠️ Why: events are sealed and sent **asynchronously** from inside `write`, so
   *    if the carrier closes the connection without waiting for this, **the last frame is lost**.
   */
  flush(): Promise<void>
  /** Closes from our side (stops every open subscription and tells the reason in an envelope) */
  close(reason?: string): Promise<void>
  /**
   * ★★ Cleanup when the peer **is already gone** (⚠️⚠️ **sends nothing**).
   *
   * ⚠️⚠️ Why nothing may be sent is the relay's own spec: **connection numbers are reused**, so
   *    an envelope addressed to a departed peer **reaches a new phone under the same number** (= the side receiving
   *    an envelope it cannot open judges it "tampered" and drops the connection = **an unrelated device breaks**).
   * ★ `close()` is only for "the peer is still connected, but we end it from our side".
   */
  abandon(): void
  /** Number of open subscriptions (tests and diagnostics) */
  readonly openStreams: number
}

/**
 * ★ Headers the agent attaches as fixed values. **This is all of them** (not a single peer value goes in).
 *
 * ⚠️ `content-type` is always attached to POST (`readJsonBody` requires it =
 *    without it, a bodiless POST becomes 415).
 * ⚠️⚠️ No `origin` (attaching it would let the peer influence the CSRF decision).
 *    ★ Without it, `rejectCrossOrigin` lets it through as "non-browser" = the peer has no decision input.
 */
export function tunnelHeaders(method: TunnelMethod): IncomingHttpHeaders {
  return {
    // ★★ the destination is built from the constant in `shared/tunnel.ts` (⚠️ so it is **the same value** as the route check)
    host: new URL(TUNNEL_ORIGIN).host,
    accept: 'application/json',
    ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
  }
}

/** A finished response. ⚠️ SSE is settled at `writeHead` (does not wait for `end`) */
type Completion =
  | { kind: 'body'; status: number; body?: unknown }
  | { kind: 'stream'; status: number }

/**
 * ★ A fake `ServerResponse`. **Receives the handler's output without going through `node:http`**.
 *
 * ⚠️ Extends `EventEmitter` (`attach` in `events.ts` uses `on('close')`, and
 *    `permission.ts` uses `once('close')`).
 * ⚠️ SSE (`text/event-stream`) gets many `write`s, so it is **cut at event boundaries** and
 *    turned into one frame each. ⚠️ `retry:` lines and comment lines have no `data:`, so they are dropped.
 */
class TunnelSink extends EventEmitter {
  /**
   * ★ The subscription was removed (the peer cancelled / we cut it). ⚠️ Check this right before sending
   *   (codex round 16, low #6: events queued before removal were sent after removal).
   */
  dropped = false
  headersSent = false
  status = 200
  #headers: Record<string, string> = {}
  #chunks: string[] = []
  #sse = false
  #buf = ''
  #onEvent: (event: unknown) => void
  #resolve: (c: Completion) => void = () => {}
  #settled = false
  done: Promise<Completion>

  constructor(onEvent: (event: unknown) => void) {
    super()
    this.#onEvent = onEvent
    this.done = new Promise<Completion>((resolve) => {
      this.#resolve = resolve
    })
  }

  /** ⚠️ Only once (comes from both `writeHead` and `end`) */
  #settle(c: Completion): void {
    if (this.#settled) return
    this.#settled = true
    this.#resolve(c)
  }

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.#headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value)
    return this
  }

  getHeader(name: string): string | undefined {
    return this.#headers[name.toLowerCase()]
  }

  writeHead(status: number, headers?: Record<string, string | number>): this {
    this.status = status
    for (const [k, v] of Object.entries(headers ?? {})) this.setHeader(k, v as string)
    this.headersSent = true
    // ★ for SSE, "the subscription started" is settled here (`end` never comes)
    if ((this.getHeader('content-type') ?? '').startsWith('text/event-stream')) {
      this.#sse = true
      this.#settle({ kind: 'stream', status })
    }
    return this
  }

  write(chunk: string | Uint8Array): boolean {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    if (!this.#sse) {
      this.#chunks.push(text)
      return true
    }
    this.#buf += text
    let at = this.#buf.indexOf('\n\n')
    while (at >= 0) {
      const block = this.#buf.slice(0, at)
      this.#buf = this.#buf.slice(at + 2)
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice('data: '.length))
        .join('\n')
      if (data) {
        try {
          this.#onEvent(JSON.parse(data))
        } catch {
          // ⚠️ a string we built ourselves, so reaching here is an implementation bug. **Just drop it**
          console.warn(t('[tunnel] イベントを JSON として読めませんでした（1件落としました）', '[tunnel] Could not parse an event as JSON (dropped 1)'))
        }
      }
      at = this.#buf.indexOf('\n\n')
    }
    return true
  }

  end(chunk?: string | Uint8Array): this {
    if (chunk !== undefined) this.write(chunk)
    this.headersSent = true
    this.#settle({ kind: 'body', status: this.status, body: parseBody(this.#chunks.join('')) })
    this.emit('close')
    return this
  }

  destroy(): this {
    this.emit('close')
    return this
  }

  /**
   * ★ If nothing has been written yet, settle with 500.
   *
   * ⚠️ "A handler that writes no response" is an implementation bug (over HTTP it leaves the connection open).
   *    ⇒ In the tunnel, **return a status and finish** (so the screen does not wait forever).
   */
  settleIfPending(): void {
    if (this.#settled) return
    console.warn(t('[tunnel] 応答を書かない口がありました（500 を返します）', '[tunnel] A handler did not write a response (returning 500)'))
    this.#settle({ kind: 'body', status: 500, body: { error: t('応答がありません', 'There was no response.') } })
  }
}

/**
 * ⚠️ Signals not sent through the tunnel (`AgentEvent` in `shared/types.ts`). **Decided only here**.
 *
 * ★ This is not "saving" but **a precondition** (§14.1.2.28): sending them keeps the relay's DO from
 *   hibernating and it does not fit in the free tier = the ③ route itself becomes impossible.
 */
function isHeartbeat(event: unknown): boolean {
  return (
    typeof event === 'object' &&
    event !== null &&
    (event as { type?: unknown }).type === 'heartbeat'
  )
}

/**
 * ★ Turns the body the handler wrote into a JSON value.
 *
 * ⚠️ **If it is not JSON, carry it as a string** (`TunnelResponse.body` is any JSON value).
 *    ⇒ Better to hand it over as is and let the screen show it than to "think it is JSON and deliver `undefined`".
 */
function parseBody(text: string): unknown {
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * ★ A fake `IncomingMessage`. **The body is a `Readable`** (`readBody` reads it with `for await`).
 *
 * ⚠️ The type hole (`as unknown as`) is confined to this one place. Other `node:http` members
 *    (`socket` / `httpVersion` / `rawHeaders`) are read nowhere in the agent
 *    (only `beginMeasure` in `traffic.ts` looks at `socket`, and it is not called for tunnels).
 */
function makeRequest(r: TunnelRequest): IncomingMessage {
  const body = r.body === undefined ? [] : [Buffer.from(JSON.stringify(r.body), 'utf8')]
  const stream = Readable.from(body) as unknown as {
    method: string
    url: string
    headers: IncomingHttpHeaders
  }
  stream.method = r.method
  // ★★ the destination is decided only here (`serve.ts` does `new URL(req.url, 'http://<host>')`).
  //   ⚠️⚠️ `shared/tunnel.ts` refuses paths starting with `//` or anything but `/`, so
  //      it cannot turn into another host here (`agent/src/tunnel.test.ts` measures this).
  stream.url = r.path
  stream.headers = tunnelHeaders(r.method)
  return stream as unknown as IncomingMessage
}

/**
 * Opens a tunnel.
 *
 * ⚠️⚠️ **Cannot be opened on a connection that did not pass the handshake (= revoked or fake)** (throws).
 *    ★ Refusing here guarantees that `deliver` **never throws on the peer's input**
 *      (= the carrier only needs to "look at the result").
 */
export function openTunnel(o: {
  connection: DeviceConnection
  router: Router
  sender: TunnelSender
}): Tunnel {
  if (!isDeviceConnectionLive(o.connection)) {
    throw new Error(t('この接続は握手を通っていません（または登録が失効しています）', 'This connection has not passed the handshake (or its registration was revoked)'))
  }
  const session: Session = o.connection.session
  /** ★ Open subscriptions (`id` → SSE receiver) */
  const streams = new Map<number, TunnelSink>()
  /**
   * ★★ **Numbers of requests currently going through the path** (2026-09-15 / codex medium #3).
   *
   * ⚠️⚠️ Subscriptions are put into `streams` **after** `handleRequest`, so a disconnect arriving
   *    in between could not be cleaned up, and **the subscription was registered afterwards and remained** (measured).
   *    ⇒ Remember "numbers cut while starting" and check right before registering.
   */
  const inflight = new Set<number>()
  /** ★ Numbers cut while starting (⚠️ only those in `inflight` are remembered = does not pile up) */
  const cancelled = new Set<number>()
  let closed = false

  // ★★ serialize sending into one chain (match the sealing order to the send order / header notes)
  let sendChain: Promise<void> = Promise.resolve()

  function enqueueSend(type: number, plaintext: Uint8Array): Promise<void> {
    const run = sendChain.then(async () => {
      const frame = await session.seal(type as Parameters<Session['seal']>[0], plaintext)
      await o.sender.send(frame)
    })
    // ⚠️ a failure does not break the chain (it only provides order / same shape as `enqueue` in `devices.ts`)
    sendChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * ★★ Sends one event. **Revocation is checked "right before sending"** (2026-09-15 / codex medium #4).
   *
   * ⚠️⚠️ When it was only checked at enqueue time, **a revocation while the carrier was clogged
   *    still got sealed and sent afterwards** (measured). ⇒ Check inside the chain (= right before sealing).
   * ⚠️ Do **not await** `closeStream` from here (it would wait on work queued after us = stall).
   */
  function enqueueEvent(id: number, event: unknown, live: () => boolean): Promise<void> {
    const run = sendChain.then(async () => {
      // ⚠️ do not send to a removed subscription (the peer discards the number, but it would be wasted traffic to a background tab / round 16, low #6)
      if (!live()) return
      if (!isDeviceConnectionLive(o.connection)) {
        void closeStream(id, t('この端末の登録は失効しています', 'This device\'s registration has been revoked.'))
        return
      }
      const frame = await session.seal(FRAME.event, encodeEvent({ id, event }))
      await o.sender.send(frame)
    })
    sendChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** ⚠️ **true only when actually removed** (so the disconnect is not sent twice) */
  function dropStream(id: number): boolean {
    const sink = streams.get(id)
    if (!sink) {
      // ★★ not registered yet but **in the middle of the path**: remember that it was cut
      //   (⚠️ otherwise it gets registered afterwards and the subscription remains / codex medium #3)
      if (inflight.has(id)) cancelled.add(id)
      return false
    }
    streams.delete(id)
    sink.dropped = true
    // ⚠️ `events.ts` removes the subscription with this (otherwise `write` keeps being called)
    sink.emit('close')
    return true
  }

  async function closeStream(id: number, reason?: string): Promise<void> {
    // ⚠️ if already removed, send nothing (prevents a disconnect per queued event)
    if (!dropStream(id)) return
    await enqueueSend(FRAME.close, encodeClose({ id, ...(reason ? { reason } : {}) })).catch(
      () => undefined,
    )
  }

  async function deliver(frame: Uint8Array): Promise<DeliverResult> {
    if (closed) return { ok: false, fatal: true, reason: t('このトンネルは閉じています', 'This tunnel is closed') }
    let opened: Awaited<ReturnType<Session['open']>>
    try {
      opened = await session.open(frame)
    } catch (err) {
      // ⚠️⚠️ tampering, replay, rollback. **We do not know which number to answer**, so close the whole connection
      return { ok: false, fatal: true, reason: err instanceof Error ? err.message : String(err) }
    }

    // ★ only two types may come from the peer.
    //   ⚠️⚠️ accepting `response` / `event` / `confirm` would let the peer create **the types the agent speaks**
    //      (harmless now, but it matters once per-type handling grows).
    if (opened.type === FRAME.close) {
      const decoded = decodeClose(opened.plaintext)
      if (!decoded.ok) return { ok: false, fatal: true, reason: decoded.reason }
      // ⚠️ no number = the whole tunnel (the contract in `shared/tunnel.ts`)
      if (decoded.value.id === undefined) {
        await close(decoded.value.reason)
        return { ok: true }
      }
      dropStream(decoded.value.id)
      return { ok: true }
    }
    if (opened.type !== FRAME.request) {
      return { ok: false, fatal: true, reason: t('この種別は受け付けません', 'This frame type is not accepted') }
    }

    const decoded = decodeRequest(opened.plaintext)
    if (!decoded.ok) {
      // ⚠️ broken down to the number, so **it cannot be answered** ⇒ close with a reason
      await enqueueSend(FRAME.close, encodeClose({ reason: decoded.reason })).catch(() => undefined)
      return { ok: false, fatal: true, reason: decoded.reason }
    }
    const request = decoded.value

    // ★★ if revoked mid-subscription, stop there (per-request authentication alone
    //   **does not apply revocation to a long-open `/events`** / continuation of §14.1.2.21)
    const sink = new TunnelSink((event) => {
      // ★★ **heartbeats are not put into envelopes** (③b step ③ / ARCHITECTURE §14.1.2.28).
      //   ⚠️⚠️ sending a signal every 5 seconds to the relay means **the DO can never hibernate**
      //      (one always-awake DO is about 10,800 GB-s/day = **two machines exceed the free tier**).
      //   ★ keeping the link alive is **the link's** job (`RELAY_PING` in `shared/relayFrame.ts`;
      //     the relay answers by itself, so the DO does not wake).
      //   ⚠️ screens that used heartbeats to see "connected" decide by **the link dropping** (`onDown`)
      //     (⬜ wired in ④). ⚠️⚠️ **the carrier must not make up heartbeats and mix them in**
      //     (the relay answers even without an agent, so it would be **a lie that the agent is alive**).
      if (isHeartbeat(event)) return
      void enqueueEvent(request.id, event, () => !sink.dropped)
    })

    inflight.add(request.id)
    const req = makeRequest(request)
    // ★★ **mark it before entering the path** (= the only entry to `via:'device'`).
    //   ⚠️ the mark is a `WeakMap` keyed by the request itself (`auth.ts`). Connections that did not pass the handshake throw.
    markDeviceRequest(req, o.connection)
    await handleRequest({
      router: o.router,
      req,
      res: sink as unknown as ServerResponse,
      // ⚠️⚠️ the tunnel is API only (the PWA itself is not put into envelopes)
      allowStatic: false,
    })

    // ⚠️⚠️ **a handler that writes no response stops here forever** (same over HTTP, but
    //    in the tunnel the number lingers). ⇒ if nothing is written by the end of the path, 500.
    sink.settleIfPending()
    const out = await sink.done
    inflight.delete(request.id)

    // ★★ **check for a disconnect when leaving the path too** (codex medium #3).
    //   ⚠️ skipping this registers a subscription **after** `close()` and it remains in `events.ts`.
    const stopped = closed || cancelled.delete(request.id)
    if (out.kind === 'stream') {
      if (stopped) {
        sink.dropped = true
        // ⚠️ remove it from `events.ts` (otherwise `write` keeps being called)
        sink.emit('close')
      } else {
        streams.set(request.id, sink)
      }
    }
    // ⚠️ nothing is sent after closing (`close()` has already sent the reason)
    if (closed) return { ok: true }
    try {
      await enqueueSend(
        FRAME.response,
        encodeResponse({
          id: request.id,
          status: out.status,
          ...(out.kind === 'body' && out.body !== undefined ? { body: out.body } : {}),
        }),
      )
    } catch (err) {
      // ⚠️⚠️ **never throw because sending failed** (do not break the carrier's receiver).
      //    ★ cannot send = this connection is unusable, so `fatal` (the carrier closes it).
      return { ok: false, fatal: true, reason: err instanceof Error ? err.message : String(err) }
    }
    // ★★ **a pairing-only connection is "one-shot"** (③ stage 7 / ARCHITECTURE §14.1.4).
    //
    // ⚠️⚠️ **success or failure is not looked at** (closing only on success would leave a connection
    //    **that can try the one-time token any number of times**). ⇒ close after returning one response. To retry, **reconnect**.
    // ⚠️ a **separate safeguard** from `authenticate`'s "only the pairing route passes":
    //    that one is "what it can do", this one is "how many times". ⇒ remove neither.
    // ⚠️ close **after sending** the response (closing first means the result never reaches the peer).
    if (isPairingConnection(o.connection)) {
      await close(t('ペアリングが終わりました', 'Pairing is complete.'))
    }
    return { ok: true }
  }

  /** ⚠️ **Cleanup that sends nothing** (notes above). `close()` is this plus "telling the reason" */
  function abandon(): void {
    closed = true
    for (const id of [...streams.keys()]) dropStream(id)
  }

  async function close(reason?: string): Promise<void> {
    abandon()
    await enqueueSend(FRAME.close, encodeClose({ ...(reason ? { reason } : {}) })).catch(
      () => undefined,
    )
    await flush()
  }

  async function flush(): Promise<void> {
    // ⚠️ the chain only provides "order" (it swallows failures), so wait twice to also catch **what was added inside**
    await sendChain
    await sendChain
  }

  return {
    deliver,
    flush,
    close,
    abandon,
    get openStreams() {
      return streams.size
    },
  }
}
