// ★ Step 6 route of ③: the tunnel (`kind: 'relay'` / ARCHITECTURE §14.1.2.22).
//
// ★★ Uses **the same envelope as the agent side (`agent/src/tunnel.ts`)** (the single `shared/tunnel.ts`).
//   ⇒ All this file does is "number requests and match them to responses".
//
// ⚠️⚠️ **The carrier (WebSocket / relay) isn't written here.** `RelayCarrier` is passed in from outside,
//    so the same code runs for step 6-③ (CF Workers) and for test fakes.
//    ★ `discipline.test.ts` checks that **this file doesn't open a communication channel directly**
//      (⚠️ that guard checks strings, so writing the opener's name here trips it yourself).
//
// ★★ **Sending is serialized into one chain** (same reason as the agent side). The receiver's only replay defense is
//    "drop if the counter goes back", so **if sealing order and sending order swap, valid frames get dropped**.
//
// ⚠️ **Has a timeout** (10 seconds, same as `http.ts`). Even when no response returns, the tunnel's
//    socket doesn't necessarily close, so without it **the screen waits forever**.
//
// ⚠️ Not yet present (stated honestly / **not written ahead of time**):
//   ⬜ carrier reconnection (`EventSource` reconnects by itself, but for the tunnel it's the carrier's job = step 6-③)
//   ⬜ a `probeUrl` equivalent (reachability via relay is decided when `kind` is added in ④)

import type { Session } from '../../../shared/crypto.ts'
import { FRAME } from '../../../shared/crypto.ts'
import {
  decodeClose,
  decodeEvent,
  decodeResponse,
  encodeClose,
  encodeRequest,
} from '../../../shared/tunnel.ts'
import type { AgentEvent } from '../../../shared/types.ts'
import type { Wire, WireRequest, WireResponse } from './wire.ts'
import { t } from '../../../shared/i18n.ts'

/** Carrier that transports one envelope at a time (WebSocket / relay / test fake). ⚠️ **Must preserve order** */
export interface RelayCarrier {
  send(frame: Uint8Array): Promise<void> | void
}

export type RelayDeliver = { ok: true } | { ok: false; reason: string }

export interface RelayWire extends Wire {
  /** ★ Always answers (⚠️ for relay lines, `relayRoute` uses this to decide the list's fallback interval) */
  eventsLive(): boolean
  /**
   * Hand over one envelope received by the carrier.
   *
   * ⚠️⚠️ **Doesn't throw** (an exception inside the carrier's `onmessage` breaks the whole connection).
   *    ⇒ Returns a result, and the carrier decides "whether to close".
   */
  deliver(frame: Uint8Array): Promise<RelayDeliver>
  /**
   * ★ Wait until the send chain is empty.
   *
   * ⚠️ Why it's needed: requests are **sealed asynchronously** before sending, so unless the carrier
   *    waits for this before closing, **the last frame is lost** (same as the agent side's `Tunnel.flush`).
   */
  flush(): Promise<void>
  /**
   * The carrier dropped / the agent disconnected. **Fail every pending request**.
   *
   * ⚠️⚠️ Without calling it the screen waits until the timeout (10s) = **no reason is shown**.
   *    ★ For disconnects **with a reason** such as revocation, that text is shown on screen as-is.
   */
  fail(reason: string): void
}

/** ⚠️ Same as `http.ts` (if the wait time varied by route, behavior would look different to the user) */
const TIMEOUT_MS = 10_000

interface Pending {
  resolve(res: WireResponse): void
  reject(err: Error): void
  timer: ReturnType<typeof setTimeout>
}

export function relayWire(o: {
  /** Session obtained from the handshake (⚠️ after opening `confirm`) */
  session: Session
  carrier: RelayCarrier
  /** For tests (⚠️ not passed from screens) */
  timeoutMs?: number
  /**
   * ★★ **This route has died** (2026-09-15 / codex round 4, medium #6).
   *
   * ⚠️⚠️ Without this, **when the agent sends "close the whole tunnel"** (revocation etc.),
   *    `deliver` returns "handled correctly" = `{ok:true}`, so **the carrier doesn't notice**.
   *    ⇒ The carrier keeps the line open while the route stays dead = **it never reconnects**.
   * ⚠️ Called only once (`fail` may be called any number of times).
   */
  onDead?: (reason: string) => void
}): RelayWire {
  const timeoutMs = o.timeoutMs ?? TIMEOUT_MS
  /** ★ IDs just increase from 1 (⚠️ never reused = a late response can't hit another request) */
  let nextId = 1
  const pending = new Map<number, Pending>()
  const subscribers = new Map<number, (event: AgentEvent) => void>()
  /**
   * ★ `/events` subscriptions the agent accepted with 2xx (material for `eventsLive`).
   * ⚠️ Not removed on unsubscribe/close: the check ANDs with `subscribers.has`, so removed subscriptions don't count
   *    (adding a removal line would be an unkillable guard. IDs are per line, and the count is only the number of subscriptions)
   */
  const confirmedEvents = new Set<number>()
  const eventsIds = new Set<number>()
  /** ★ Reason for disconnection (⚠️ **once dead, never reopened**. The carrier makes a new `relayWire`) */
  let dead: string | undefined

  // ★★ Serialize sending into one chain (see the header)
  let sendChain: Promise<void> = Promise.resolve()

  function enqueueSend(type: number, plaintext: Uint8Array): Promise<void> {
    const run = sendChain.then(async () => {
      // ★★ **Don't send if it died while queued** (2026-09-15 / codex medium #2).
      //   ⚠️⚠️ If it died while the carrier was stuck, it **sealed and sent afterwards**.
      if (dead !== undefined) return
      const frame = await o.session.seal(type as Parameters<Session['seal']>[0], plaintext)
      await o.carrier.send(frame)
    })
    // ⚠️ Don't break the chain on failure (`chain` only carries "order")
    sendChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function settle(id: number, apply: (p: Pending) => void): void {
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    clearTimeout(p.timer)
    apply(p)
  }

  /**
   * ★ Disconnected. **Fail every pending request**.
   *
   * ⚠️ Subscription tables are **not** cleaned here (2026-09-15). After disconnecting it stops via two things:
   *    **not opening envelopes** (`deliver`) and **not sending** (`enqueueSend`), so
   *    adding cleanup would have **no observable difference** (= an unkillable guard).
   *    ★ A dead route is thrown away with its carrier (the containers' lifetime ends there).
   */
  function fail(reason: string): void {
    // ⚠️ Second time does nothing (⚠️⚠️ calling `onDead` twice makes the carrier close again)
    if (dead !== undefined) return
    dead = reason
    for (const id of [...pending.keys()]) settle(id, (p) => p.reject(new Error(reason)))
    // ★ **Always** tell the carrier (closing the line is the carrier's job / see above)
    o.onDead?.(reason)
  }

  async function request(r: WireRequest): Promise<WireResponse> {
    // ⚠️⚠️ If dead, **return the reason immediately** (don't make it wait 10s).
    //    ★ Not `if (dead)` (**an empty-string reason** would turn into "not dead" / codex medium #5).
    if (dead !== undefined) throw new Error(dead)
    const id = nextId++
    const wait = new Promise<WireResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        const reason = t('応答がありません（時間切れ）', 'No response (timed out)')
        reject(new Error(reason))
        // ★★ **A timeout throws away the whole line** (2026-09-24 / codex round 17, medium #2).
        //   ⚠️⚠️ If a line half-dies without a disconnect notice, not discarding it means **we keep sending to the same dead line**,
        //      and `eventsLive` keeps saying "alive" (= the list stays up to 5 min stale, approvals show late).
        //   ⇒ `fail` tells the carrier (`onDead` → closes the line), and the next request opens a new line (subscriptions are re-established).
        //   ⚠️ The request itself is **not resent** (keystrokes would be entered twice / ② in relayRoute).
        //   ★ A live agent answers within 10s (http also fails at the same 10s).
        // ★★ Requests stopped as collateral get **a different reason** (codex round 18, medium #5): they didn't time out themselves.
        //   The agent **doesn't execute** requests whose turn came after the line was discarded (`slot.gone` in `agent/src/relayLink.ts`),
        //   so if they hadn't started they never reached the PC. ⚠️ The one that had started is unknown ⇒ ask the user to check.
        fail(
          t(
            'ほかの要求が時間切れになったため、接続を張り直しました（この操作は PC で実行されていない可能性が高いですが、念のため画面で確かめてから送り直してください）',
            'Another request timed out, so the connection was reset (this action most likely did not run on the PC, but check the screen before sending it again)',
          ),
        )
      }, timeoutMs)
      // ⚠️ Shaped to work in both Node and the browser (`unref` isn't called)
      pending.set(id, { resolve, reject, timer })
    })
    // ★★ **Don't wait for the send to complete** (2026-09-15 / codex medium #2).
    //   ⚠️⚠️ Waiting means that while the carrier is stuck, **neither timeouts nor disconnects reach the caller**
    //      (and the waiter's reject becomes **unhandled**).
    //   ★ Only when sending fails is that ID failed (so it doesn't turn into a timeout).
    void enqueueSend(FRAME.request, encodeRequest({ id, ...r })).catch((err: unknown) => {
      settle(id, (p) => p.reject(err instanceof Error ? err : new Error(String(err))))
    })
    return await wait
  }

  function subscribe(on: (event: AgentEvent) => void, path = '/events'): () => void {
    // ⚠️ Being called after disconnection is harmless (requests aren't sent by `enqueueSend`,
    //    and events aren't opened by `deliver`). ★ Don't create a third entry point here.
    const id = nextId++
    subscribers.set(id, on)
    if (path === '/events') eventsIds.add(id)
    // ⚠️ `Wire.subscribe` must return the unsubscribe function synchronously, so the request is **fire-and-forget**.
    //    ★ On failure the subscription just disappears (`fail` shows the reason).
    void enqueueSend(FRAME.request, encodeRequest({ id, method: 'GET', path })).catch(
      () => undefined,
    )
    return () => {
      if (!subscribers.delete(id)) return
      // ⚠️ Tell the agent side "no longer needed" (otherwise **events keep flowing**)
      void enqueueSend(FRAME.close, encodeClose({ id })).catch(() => undefined)
    }
  }

  async function deliver(frame: Uint8Array): Promise<RelayDeliver> {
    // ⚠️ Don't open envelopes arriving after disconnection (⚠️ opening would only advance the counter)
    if (dead !== undefined) return { ok: false, reason: dead || t('接続が切れています', 'Disconnected') }
    let opened: Awaited<ReturnType<Session['open']>>
    try {
      opened = await o.session.open(frame)
    } catch (err) {
      // ⚠️⚠️ Tampering, replay or rewind. **This connection can no longer be trusted**
      const reason = err instanceof Error ? err.message : String(err)
      fail(reason)
      return { ok: false, reason }
    }

    if (opened.type === FRAME.response) {
      const decoded = decodeResponse(opened.plaintext)
      if (!decoded.ok) return { ok: false, reason: decoded.reason }
      const { id, status, body } = decoded.value
      // ★ Starting a subscription is also answered with a response (⚠️ stop the subscription if it failed)
      if (subscribers.has(id)) {
        if (status < 200 || status >= 300) subscribers.delete(id)
        else if (eventsIds.has(id)) confirmedEvents.add(id)
        return { ok: true }
      }
      settle(id, (p) => p.resolve({ status, ...(body === undefined ? {} : { body }) }))
      return { ok: true }
    }

    if (opened.type === FRAME.event) {
      const decoded = decodeEvent(opened.plaintext)
      if (!decoded.ok) return { ok: false, reason: decoded.reason }
      // ⚠️ Drop unknown IDs (arrived after unsubscribing)
      subscribers.get(decoded.value.id)?.(decoded.value.event as AgentEvent)
      return { ok: true }
    }

    if (opened.type === FRAME.close) {
      const decoded = decodeClose(opened.plaintext)
      if (!decoded.ok) return { ok: false, reason: decoded.reason }
      const { id, reason } = decoded.value
      // ⚠️⚠️ No ID = the whole tunnel (the contract in `shared/tunnel.ts`)
      if (id === undefined) {
        fail(reason ?? t('接続が切れました', 'Connection lost'))
        return { ok: true }
      }
      subscribers.delete(id)
      // ★ If a request is waiting, end it **with the reason** (don't turn it into a timeout)
      settle(id, (p) => p.reject(new Error(reason ?? t('打ち切られました', 'Aborted'))))
      return { ok: true }
    }

    // ⚠️⚠️ Only three kinds may come from the agent (`request` / `confirm` are **what we send**)
    return { ok: false, reason: t('この種別は受け付けません', 'This kind is not accepted') }
  }

  async function flush(): Promise<void> {
    // ⚠️ The chain only carries "order" (it swallows failures), so wait twice to catch **what was added inside**
    await sendChain
    await sendChain
  }

  /** ⚠️ Not alive if disconnected (once `dead` is set, envelopes are no longer opened) */
  function eventsLive(): boolean {
    return dead === undefined && [...confirmedEvents].some((id) => subscribers.has(id))
  }

  return { request, subscribe, eventsLive, deliver, flush, fail }
}
