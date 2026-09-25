// Step 6-④-2 of ③: **the route via relay** (a `Wire` with reconnection and resubscription).
//
// ★ This is `httpWire`'s counterpart (see `wire.ts`). The only difference is that "the line can drop";
//   `AgentTransport`'s 20 methods **know nothing about it**.
//
// ★★ **After reconnecting, re-establish the open subscriptions**.
//   ⚠️⚠️ Without this, even when the line comes back **the screen stays silent** (it looks connected but
//      events never come again = the nastiest kind of breakage).
//
// ★★ **Requests are not retried** (only "the line" is reconnected).
//   ⚠️⚠️ Sending keystrokes (`POST /sessions/:id/message`) twice **puts the same instruction into the TUI twice**.
//      ⇒ When the line drops, that request is **failed with a reason** (the caller = a human decides).
//
// ★ It connects **when a request or subscription arrives** (lazy). ⚠️ No watchdog timer:
//   the screen refetches the list every 15 seconds, so **that request doubles as reconnection**
//   (= more tabs don't hit it all at once).
//
// ⚠️ Not yet present (stated honestly):
//   ⬜ automatic route selection (`relay` if `local` fails) is ④-2b
//   ⬜ backpressure and traffic measurement

import type { KeyPair } from '../../../shared/crypto.ts'
import type { AgentEvent } from '../../../shared/types.ts'
import type { Identity } from '../identity.ts'
import { connectRelayCarrier } from './relayCarrier.ts'
import type { Wire, WireRequest, WireResponse } from './wire.ts'
import { t } from '../../../shared/i18n.ts'

export type RelayRouteState = 'idle' | 'connecting' | 'open' | 'down'

export interface RelayRoute extends Wire {
  /** ★ Current state (⚠️ **the screen's "connected" is derived from this** / §14.1.2.28) */
  readonly state: RelayRouteState
  readonly lastError: string | undefined
  /** Close when switching endpoints (⚠️ no reconnection after this) */
  close(reason?: string): void
}

/** ⚠️ Hook swapped by tests (default is a real WebSocket) */
export interface RelayConnect {
  (a: {
    base: string
    agentPublicKey: string
    identity: KeyPair
    onDown: (reason: string) => void
  }): Promise<{ wire: Wire; close(reason?: string): void }>
}

interface Sub {
  on: (event: AgentEvent) => void
  /** ★ Subscription endpoint (⚠️ resubscribe at **the same endpoint**; dropping it turns following into the list subscription) */
  path: string
  /** ⚠️ Unsubscribe function on the current line (⚠️ invalid after reconnecting) */
  stop?: () => void
}

function text(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function relayRoute(o: {
  /** relay entrance (the QR's `r`) */
  base: string
  /** The peer agent's public key (the QR's `a`) */
  agentPublicKey: string
  /** ⚠️ This device's key (`identity.ts`). ★ **Read on every connect** (it can disappear) */
  identity: () => Promise<Identity>
  connect?: RelayConnect
  onState?: (state: RelayRouteState, lastError?: string) => void
}): RelayRoute {
  const connect: RelayConnect = o.connect ?? ((a) => connectRelayCarrier(a))
  /**
   * ★★ **The binding is copied once at creation** (2026-09-19 / codex round 9, low #4).
   *
   * ⚠️⚠️ It used to claim `boundAgentPublicKey` with the value at creation while **re-reading
   *    `o.agentPublicKey` on every connect**. ⇒ If the caller mutated the argument object,
   *    **the `pairDevice` check passed with claimed key A while the handshake was bound to key B**
   *    (codex reproduced it by recording the connector).
   * ⇒ **Make the published value and the value actually used one and the same** (= authenticated target and executed target).
   */
  const agentPublicKey = o.agentPublicKey
  let live: { wire: Wire; close(reason?: string): void } | undefined
  /** ⚠️ Connection in progress (★ **don't connect twice** for simultaneous requests) */
  let opening: Promise<Wire> | undefined
  let state: RelayRouteState = 'idle'
  let lastError: string | undefined
  let closed = false
  /** ★ Subscriptions made by the screen (⚠️ **outlive the line**) */
  const subs = new Map<number, Sub>()
  let nextSub = 1

  function setState(next: RelayRouteState, err?: string): void {
    state = next
    lastError = err
    o.onState?.(next, err)
  }

  /** ⚠️ The line dropped (★ subscriptions are **not removed**; they're re-established on the next connect) */
  function down(reason: string): void {
    live = undefined
    for (const s of subs.values()) s.stop = undefined
    setState('down', reason)
  }

  async function ensure(): Promise<Wire> {
    if (closed) throw new Error(t('この接続先は閉じています', 'This connection is closed'))
    if (live) return live.wire
    if (opening) return await opening
    const run = (async (): Promise<Wire> => {
      setState('connecting')
      // ⚠️⚠️ Key missing / broken / can't be saved = **must not connect** (show the reason as-is)
      const id = await o.identity()
      if (id.kind !== 'ok') throw new Error(t(`この端末の鍵が使えません（${id.reason}）`, `This device's key cannot be used (${id.reason})`))
      const conn = await connect({
        base: o.base,
        agentPublicKey,
        identity: id.pair,
        onDown: (reason) => down(reason),
      })
      // ⚠️ If closed while connecting, discard the opened line (don't keep it)
      if (closed) {
        conn.close(t('この接続先は閉じています', 'This connection is closed'))
        throw new Error(t('この接続先は閉じています', 'This connection is closed'))
      }
      live = conn
      setState('open')
      // ★★ **Re-establish the open subscriptions** (see the header)
      for (const s of subs.values()) {
        if (!s.stop) s.stop = conn.wire.subscribe(s.on, s.path)
      }
      return conn.wire
    })()
    opening = run
    try {
      return await run
    } catch (err) {
      setState('down', text(err))
      throw err
    } finally {
      // ⚠️ Always clear it on failure so the next request can reconnect
      if (opening === run) opening = undefined
    }
  }

  async function request(r: WireRequest): Promise<WireResponse> {
    const wire = await ensure()
    // ⚠️⚠️ **Not retried** (see the header; keystrokes would be entered twice)
    return await wire.request(r)
  }

  function subscribe(on: (event: AgentEvent) => void, path = '/events'): () => void {
    const key = nextSub++
    const entry: Sub = { on, path }
    subs.set(key, entry)
    // ⚠️ `Wire.subscribe` must return the unsubscribe function **synchronously** ⇒ connecting is fire-and-forget
    void ensure()
      .then((wire) => {
        // ⚠️ Do nothing if already unsubscribed or resubscribed (no double subscription)
        if (!subs.has(key) || entry.stop) return
        entry.stop = wire.subscribe(on, path)
      })
      .catch(() => undefined)
    return () => {
      if (!subs.delete(key)) return
      entry.stop?.()
      entry.stop = undefined
    }
  }

  function close(reason = t('接続先を切り替えました', 'Switched connections')): void {
    if (closed) return
    closed = true
    subs.clear()
    const conn = live
    live = undefined
    conn?.close(reason)
    setState('down', reason)
  }

  return {
    // ★★ **The peer this line is bound to** (= the handshake binds to this key via `z2`/`z4`).
    //   ⚠️⚠️ `pairDevice` looks at this. **Don't let it be guessed from settings** (codex round 8, low #7).
    boundAgentPublicKey: agentPublicKey,
    request,
    subscribe,
    // ⚠️ Only when a line exists and the signal subscription on it has been accepted (fail-closed)
    //   ★ On drop `down` clears `live`, so `state` isn't checked on top (it would be an unkillable guard)
    eventsLive: () => live?.wire.eventsLive?.() ?? false,
    close,
    get state() {
      return state
    },
    get lastError() {
      return lastError
    },
  }
}
