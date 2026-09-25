// Step 6-③b② of ③: **the PWA-side carrier** (connects to the relay, handshakes, and builds a `relayWire`).
//
// ★ It has one job: **give the route (`Wire` in `relay.ts`) a "real line"**.
//   `relay.ts` only knows envelope round trips, not lines (`RelayCarrier` is passed in from outside).
//
// ★★ **The tunnel's first message (handshake) is raw, not an envelope** (same contract as the agent side's `relayLink.ts`):
//
// ```
//   device → agent : [init]              ← raw (the first message of `shared/crypto.ts`)
//   agent → device : [reply][confirm]    ← in this order (⚠️ if swapped the handshake never completes)
//   afterwards     : tunnel envelopes (`shared/tunnel.ts`)
// ```
//
// ★★ **Buffer what arrives "from right after connecting"**.
//   ⚠️⚠️ Attaching the receiver after waiting **loses the first message that arrived** (actually hit in the relay smoke test).
//   ⇒ Attach the receiver first and process in order on **one chain** (the handshake is async, so without serialization
//      a `confirm` arriving while `reply` is being processed **gets dropped**).
//
// ⚠️⚠️ **Agent impersonation can't happen in principle** (the agent public key passed to `startHandshake` was
//    exchanged directly via QR / §14.1.2.5). ⇒ The relay only knows "from which key to which key".
//
// ⚠️ Not yet present (stated honestly / **not written ahead of time**):
//   ⬜ reconnection (④ of ③b; for now, on drop it shows the reason and ends)
//   ⬜ a `probeUrl` equivalent (reachability via relay is decided when `kind` is added in ④)
//   ⬜ backpressure (`bufferedAmount` isn't checked)

import {
  finishHandshake,
  fromBase64Url,
  startHandshake,
  type Handshake,
  type KeyPair,
  type PendingSession,
  type Session,
} from '../../../shared/crypto.ts'
import { RELAY_PING, RELAY_PING_MS, relayUrl } from '../../../shared/relayFrame.ts'
import { relayWire, type RelayWire } from './relay.ts'
import type { Wire } from './wire.ts'
import { pickBilingual, t } from '../../../shared/i18n.ts'

/** A line carrying one envelope at a time (⚠️ **must preserve order**. The real one is a WebSocket) */
export interface CarrierSocket {
  send(bytes: Uint8Array): void
  close(code?: number, reason?: string): void
}

/** ⚠️ Things that happen on the line (★ only the `WebSocket` events this file looks at) */
export interface LineEvent {
  data?: unknown
  code?: number
  reason?: string
}

/**
 * ★ **Minimal shape** of a real WebSocket (⚠️ only tests swap it).
 *
 * ⚠️⚠️ Without this, the wiring itself — "**buffer before open, close on drop, stop the heartbeat**" —
 *    could only be observed by the smoke test against a real relay (named by codex round 4).
 */
export interface CarrierLine {
  send(data: Uint8Array | string): void
  close(): void
  addEventListener(
    type: 'message' | 'open' | 'error' | 'close',
    listener: (ev: LineEvent) => void,
  ): void
}

export interface RelayCarrier {
  /**
   * The route after the handshake completes.
   *
   * ⚠️ Failures (refused, timed out, line dropped) **reject with a reason**
   *    = the text to show on screen goes in as-is.
   */
  readonly ready: Promise<Wire>
  /** Hand over one byte sequence received by the line (⚠️⚠️ **doesn't throw**; no exceptions inside the receiver) */
  receive(bytes: Uint8Array): void
  /** The line dropped (⚠️ we don't close it). ★ Ends pending requests **with the reason** */
  down(reason: string): void
  /**
   * ★ Wait until received envelopes **have been processed**.
   *
   * ⚠️ Needed for the same reason as `relayLink.flush`: receiving is processed async on one chain, so
   *    without waiting, "not yet reached the screen" gets misread as "didn't arrive".
   */
  flush(): Promise<void>
  /** Close from our side (= `down` + close the line) */
  close(reason?: string): void
}

/** ⚠️ Same as `http.ts` (if the wait time varied by route, behavior would look different to the user) */
const TIMEOUT_MS = 10_000

function text(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * ★ Handshake over a given line (**doesn't create the line itself** = tests can pass a fake line).
 *
 * ⚠️ `identity` is **this device's key** (`web/src/identity.ts`, `extractable: false`).
 * ⚠️ `agentPublicKey` is **the agent public key from the QR** (base64url).
 */
export function openRelayCarrier(o: {
  socket: CarrierSocket
  identity: KeyPair
  agentPublicKey: string
  /** ⚠️ Handshake wait and per-request wait (for tests; not passed from screens) */
  timeoutMs?: number
  onDown?: (reason: string) => void
}): RelayCarrier {
  /** ★ Where we are (⚠️ once `dead`, never comes back) */
  let phase: 'reply' | 'confirm' | 'open' | 'dead' = 'reply'
  let handshake: Handshake | undefined
  let pending: PendingSession | undefined
  let wire: RelayWire | undefined

  let settleReady!: (w: Wire) => void
  let breakReady!: (err: Error) => void
  const ready = new Promise<Wire>((resolve, reject) => {
    settleReady = resolve
    breakReady = reject
  })
  // ⚠️ Don't make it an "unhandled rejection" even if no one is waiting (the caller's `catch` still works)
  void ready.catch(() => undefined)

  // ⚠️⚠️ **The handshake has a timeout too** (otherwise, if the agent stays silent, **the screen waits forever**)
  const timer = setTimeout(() => {
    // ★ By design the agent doesn't return why it refused the handshake (no plaintext outside envelopes) ⇒ mention both likely causes
    //   (measured: an unregistered device was refused all night, yet the screen only said "timed out")
    down(
      t(
        '握手が終わりません（時間切れ）。このマシンにこの端末が登録されていないか、agent が止まっている可能性があります',
        'Handshake did not finish (timed out). This device may not be registered on this machine, or the agent may be stopped',
      ),
    )
  }, o.timeoutMs ?? TIMEOUT_MS)

  function down(reason: string): void {
    if (phase === 'dead') return
    const wasOpen = phase === 'open'
    phase = 'dead'
    clearTimeout(timer)
    // ★ If open, tell the route (pending requests end **with the reason** = no 10s wait)
    if (wasOpen) wire?.fail(reason)
    else breakReady(new Error(reason))
    o.onDown?.(reason)
  }

  function close(reason?: string): void {
    down(reason ?? t('接続を閉じました', 'Connection closed'))
    try {
      o.socket.close()
    } catch {
      // ⚠️ Even if closing fails, cleanup is done
    }
  }

  /**
   * ★★ One chain. **Its head is "send the first message"** (= structurally no branch processes a reply before sending).
   */
  let chain: Promise<void> = (async () => {
    // ⚠️⚠️ The key from the QR is **hostile input from the camera** (if unreadable, don't start the handshake)
    const agentRaw = fromBase64Url(o.agentPublicKey)
    handshake = await startHandshake(o.identity, agentRaw)
    o.socket.send(handshake.message)
  })().catch((err: unknown) => {
    down(t(`握手を始められません: ${text(err)}`, `Could not start the handshake: ${text(err)}`))
  })

  async function handle(bytes: Uint8Array): Promise<void> {
    if (phase === 'dead') return
    if (phase === 'reply') {
      try {
        pending = await finishHandshake(handshake as Handshake, bytes)
      } catch (err) {
        return down(t(`握手できませんでした: ${text(err)}`, `Handshake failed: ${text(err)}`))
      }
      phase = 'confirm'
      return
    }
    if (phase === 'confirm') {
      let session: Session
      try {
        // ★★ A `Session` can't be obtained without going through `accept` (§14.1.2.6, item 4)
        session = await (pending as PendingSession).accept(bytes)
      } catch (err) {
        return down(t(`確認できませんでした: ${text(err)}`, `Could not confirm: ${text(err)}`))
      }
      wire = relayWire({
        session,
        carrier: { send: (frame) => o.socket.send(frame) },
        ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
        // ★★ **If the route dies, close the line too** (2026-09-15 / codex round 4, medium #6).
        //   ⚠️⚠️ When the agent sends "close the whole tunnel" (revocation etc.), `deliver`
        //      handled it correctly and returns `{ok:true}` = **without this the carrier doesn't notice**.
        //      The line stays open while the route stays dead ⇒ **it never reconnects**.
        onDead: (reason) => close(reason),
      })
      phase = 'open'
      clearTimeout(timer)
      settleReady(wire)
      return
    }
    const result = await (wire as RelayWire).deliver(bytes)
    // ⚠️⚠️ An envelope breaking the contract (tampered, unknown kind). **Close the whole line**
    //    (`relay.ts` doesn't know the line, so only here can it be closed)
    if (!result.ok) close(result.reason)
  }

  function receive(bytes: Uint8Array): void {
    // ★ "Don't receive after it's over" is checked at the head of `handle` (⚠️ writing it here too gives
    //   **the same result** = an unkillable guard / mutation N8 on 2026-09-15)
    chain = chain.then(() => handle(bytes)).then(
      () => undefined,
      (err: unknown) => {
        down(t(`受け取れませんでした: ${text(err)}`, `Could not receive: ${text(err)}`))
      },
    )
  }

  async function flush(): Promise<void> {
    // ⚠️ The chain only carries "order" (it swallows failures), so wait twice to catch **what was added inside**
    await chain
    await chain
  }

  return { ready, receive, down, close, flush }
}

/**
 * ★ Connect to the relay with a real WebSocket.
 *
 * ⚠️⚠️ **Only this file may construct a WebSocket** (same position as `http.ts`;
 *    checked mechanically by `web/src/discipline.test.ts`). Neither `relay.ts` nor `agent.ts` knows the line.
 * ⚠️ **We can't tell precisely** why it fails to connect (the browser hides 503 / 429 before the upgrade)
 *    ⇒ the text includes "the agent may not be connected".
 */
export async function connectRelayCarrier(o: {
  /** relay entrance (e.g. `wss://nyan-relay.example.workers.dev`) */
  base: string
  /** Agent public key from the QR (base64url) */
  agentPublicKey: string
  identity: KeyPair
  timeoutMs?: number
  onDown?: (reason: string) => void
  /** ⚠️ Heartbeat interval (for tests and smoke; not passed from screens) */
  pingMs?: number
  /** ⚠️ For tests (default is a real WebSocket) */
  openLine?: (url: string) => CarrierLine
}): Promise<{ wire: Wire; close(reason?: string): void }> {
  const ws = (o.openLine ?? realLine)(relayUrl(o.base, 'device', o.agentPublicKey))

  // ★★ Buffer anything sent before open (⚠️ the handshake's first message may be ready before `open`)
  let live = false
  const queued: Uint8Array[] = []
  const carrier = openRelayCarrier({
    ...o,
    socket: {
      send: (bytes) => {
        if (live) ws.send(bytes)
        else queued.push(bytes)
      },
      close: () => ws.close(),
    },
  })
  // ★★ Attach the receiver **first** (⚠️ attaching later loses the first message that arrived)
  ws.addEventListener('message', (ev) => {
    // ⚠️ Text isn't carried (the relay also rejects text)
    if (typeof ev.data === 'string') return
    carrier.receive(new Uint8Array(ev.data as ArrayBuffer))
  })
  // ★★ **Keep-alive heartbeat** (③ of ③b / `shared/relayFrame.ts`).
  //   ⚠️⚠️ Sending a heartbeat with content every 5s means **the relay's DO can't hibernate**
  //      (= exceeds the free tier). ⇒ Keep it alive with a **text** pair the relay answers by itself.
  //   ⚠️ The returned pong is **text**, so the receiver above drops it (it isn't an envelope).
  let beat: ReturnType<typeof setInterval> | undefined
  ws.addEventListener('open', () => {
    live = true
    for (const bytes of queued.splice(0, queued.length)) ws.send(bytes)
    beat = setInterval(() => {
      try {
        ws.send(RELAY_PING)
      } catch {
        // ⚠️ Closing. Cleanup is done by the `close` listener
      }
    }, o.pingMs ?? RELAY_PING_MS)
  })
  ws.addEventListener('error', () => {
    // ⚠️ The browser hides the reason for refusals before the upgrade (503 / 429 / 402) ⇒ list the possible reasons (billing / 2026-09-24)
    carrier.down(
      t(
        'relay に繋がりません（agent が繋がっていない・スマホの台数の上限・PC で nyan login が要る、のどれかかもしれません）',
        'Cannot reach the relay (the agent may not be connected, the phone limit may be reached, or the PC may need nyan login)',
      ),
    )
  })
  ws.addEventListener('close', (ev) => {
    if (beat !== undefined) clearInterval(beat)
    // ★ The relay sends "English / Japanese", so show only the current language's side
    const why = ev.reason ? `: ${pickBilingual(ev.reason)}` : ''
    carrier.down(
      t(
        `relay の線が切れました（${ev.code ?? ''}${why}）` +
          '。agent が繋がっていないか、台数の上限かもしれません',
        `The relay connection dropped (${ev.code ?? ''}${why})` +
          '. The agent may not be connected, or the device limit may be reached',
      ),
    )
  })
  try {
    const wire = await carrier.ready
    return { wire, close: (reason) => carrier.close(reason) }
  } catch (err) {
    // ★★ **A line that failed the handshake is always closed** (2026-09-15 / codex round 4, medium #5).
    //   ⚠️⚠️ Otherwise, for a revoked device etc. **lines pile up with every request**, and
    //      **we eat relay's device slots (8) ourselves so real phones can't connect**.
    //      ⚠️ The heartbeat timer is also cleaned up by the `close` listener.
    carrier.close(t('握手できませんでした', 'Handshake failed'))
    throw err
  }
}

/** ★ The real line (⚠️ **the only place allowed to construct a WebSocket** / discipline.test.ts) */
function realLine(url: string): CarrierLine {
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    addEventListener: (type, listener) =>
      ws.addEventListener(type, (ev: Event) => listener(ev as unknown as LineEvent)),
  }
}
