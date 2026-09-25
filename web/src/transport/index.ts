// ★ CLAUDE.md discipline 2: all communication goes through this one layer.
//    Screens only know Transport. Components must not use fetch / EventSource / WebSocket
//    directly.
//
//    ★ There is **only one** implementation (`Transport`), in `agent.ts`. What gets swapped is **the route (`Wire`)**:
//      `http.ts`  … fetch + SSE (v1 / `kind: 'local'`)
//      `relay.ts` … tunnel (step 6 of ③ / `kind: 'relay'`)
//    ⚠️⚠️ Don't create two `Transport` implementations (one side would end up missing some of the 20 methods)

import type {
  AutoApproveDuration,
  AutoApproveResult,
  CommandId,
  CommandResult,
  InterruptResult,
  MessageSendResult,
  AgentEvent,
  AgentHealth,
  LogPage,
  PeersResult,
  PermissionRequest,
  PushStatus,
  SessionSummary,
  SessionsPage,
  DevicesResult,
  HandshakeResult,
  PairResult,
  RevokeResult,
} from '../../../shared/types.ts'
import { endpointRoute, type AgentEndpoint } from '../endpoints.ts'
import { idbKeyStore, loadIdentity } from '../identity.ts'
import { AgentTransport } from './agent.ts'
import { relayRoute } from './relayRoute.ts'
import { probeUrl, type ProbeResult } from './http.ts'

// Reachability checks also go through this layer (discipline 2). In ③ the implementation is chosen by kind
export { fetchLatestRelease, probeUrl, type ProbeResult } from './http.ts'

/**
 * ★★ Reachability of an endpoint is checked **over the route currently in use** (2026-09-16 / step 6-④ of ③).
 *
 * ⚠️⚠️ `probeUrl` **always hits the local URL (the tailnet name)**, so an endpoint switched to relay
 *    **always shows "❌ no response" away from home**.
 *    ⇒ **Looks broken while working** (hit in practice: the list showed and messages could be sent, yet
 *      only the endpoints screen kept saying `Failed to fetch` / 2026-09-16).
 * ⚠️ Look at **the endpoint of the held `Transport`** (= the one actually in use).
 *    Something merely edited on screen is "not in use yet", so hitting local is correct.
 * ⚠️ **Use the held line** (opening a new one here eats a relay slot / `createTransports`).
 */
export async function probeEndpoint(
  e: AgentEndpoint,
  transports: readonly Transport[],
): Promise<ProbeResult> {
  const t = transports.find((x) => x.endpoint.id === e.id)
  if (t && endpointRoute(t.endpoint) === 'relay') {
    try {
      const h = await t.health()
      return {
        ok: true,
        ...(h.machine === undefined ? {} : { machine: h.machine }),
        ...(Array.isArray(h.accounts) ? { accounts: h.accounts.length } : {}),
      }
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
  }
  return probeUrl(e.url)
}

export interface LogQuery {
  /** Read before this byte offset (= older) */
  before?: number
  /** Read only what was appended from this byte offset on (live following) */
  since?: number
  limit?: number
}

export interface Transport {
  readonly endpoint: AgentEndpoint
  health(): Promise<AgentHealth>
  /**
   * List. ★ By default requests **only "running" ones** (`?live=1`; 87% of bandwidth was
   * resending history / ARCHITECTURE §14.1.1.7). Use `{ history: true }` when history is needed.
   *
   * ⚠️ Old agents don't return `history` = **`sessions` is everything** (`ui/history.ts` folds it).
   * ⚠️⚠️ **The argument can't be omitted** (mutation ⑤ from codex round 3, 2026-09-01). If it could,
   *    just rewriting to `t.listSessions()` would **make history permanently unavailable**,
   *    and not one test would fail (`.tsx` can't be hit by mutations). ⇒ **Fail at the type level.**
   */
  listSessions(opts: { history: boolean }): Promise<SessionsPage>
  getLog(sessionId: string, opts?: LogQuery): Promise<LogPage>
  /**
   * ★ Send an instruction to a running session (M4-2).
   * ⚠️ We only know it "arrived" (the inbox returns no response). Whether it was picked up is seen by
   *    a `via:'inbox'` message appearing in the thread (ARCHITECTURE §9.10).
   */
  /** ★ Returns `route` (used by the screen for matching / `ui/pending.ts`) */
  sendMessage(sessionId: string, text: string): Promise<MessageSendResult>
  /**
   * ★ Stop the response (send ESC once / HANDOFF hole 1).
   *
   * ⚠️⚠️ **The screen doesn't specify the bytes** (fixed in the agent's `CONTROL_KEYS`).
   *    An endpoint that could specify them becomes "an endpoint that remote-controls the TUI".
   * ⚠️ Not a guarantee that it "stopped" (only that it arrived). The agent returns failure reasons
   *    as text, so show them as-is.
   */
  interrupt(sessionId: string): Promise<InterruptResult>
  /**
   * ★ Run a table slash command (`/compact` / `/exit`).
   *
   * ⚠️⚠️ **Only the id is passed** (the text sent is fixed in the agent's `SLASH_COMMANDS`).
   *    An endpoint that accepts text turns "the phone's input box into the TUI's command line".
   * ⚠️ Confirmation is the screen's job (`ui/commands.ts`). `/exit` especially is irreversible.
   */
  runCommand(sessionId: string, id: CommandId): Promise<CommandResult>
  /**
   * ★★ Toggle auto-approve mode (per session, with an expiry / 2026-09-07).
   *
   * ⚠️⚠️ **`on` is only a boolean** (the agent doesn't interpret strings either). The duration
   *    **is decided by the agent** (no endpoint for passing a time from the screen = no de facto indefinite mode).
   * ⚠️ Confirmation is the screen's job (text in `ui/commands.ts`). When on, even arbitrary `Bash` commands
   *    pass automatically.
   */
  setAutoApprove(sessionId: string, on: boolean, duration?: AutoApproveDuration): Promise<AutoApproveResult>
  /**
   * ★ Clear the PC's input box (Ctrl-U). ⚠️ **No body** (the bytes sent are in the agent's table).
   * ⚠️ Why it's needed: pressing "stop" mid-response makes the CLI **put the typed text back in the input box**, so
   *    stopping `/compact` leaves `/compact` there, and the next keystrokes get concatenated with it.
   */
  clearInput(sessionId: string): Promise<InterruptResult>
  /** Start an SSE subscription and return an unsubscribe function */
  subscribe(on: (event: AgentEvent) => void): () => void
  /** ★ Whether the state-signal line is alive now (⚠️ `false` if unknown / `Wire.eventsLive`) */
  eventsLive(): boolean
  /**
   * ★★ Thread following (2026-09-23). `log-appended` arrives when that session's record or in-progress text grows.
   * ⚠️⚠️ Subscribe **only while viewing that thread** (don't stream to devices not looking / relay's daily limit).
   * ⚠️ `hello` also arrives (signal of subscribing/resubscribing ⇒ refetch the rest). ⚠️ Not subscribed on agents without the `log-follow` marker.
   */
  followLog(sessionId: string, on: (event: AgentEvent) => void): () => void

  /** Nodes in the same tailnet (candidates to add as endpoints / M3) */
  listPeers(): Promise<PeersResult>

  /**
   * ★ Pending approvals (M4-1). Only present while the hook is waiting.
   * `quiet` = ones from subagents that **show up a few seconds later** (not displayed, but not "absent")
   */
  /**
   * ⚠️ `pendingTags` is **the superset used for notification cleanup** (includes quietly waiting ones).
   *    ⚠️ Old agents don't return it, so it may be `undefined` (then the cleanup decision is unchanged).
   */
  listPermissions(): Promise<{
    permissions: PermissionRequest[]
    quiet: number
    pendingTags?: string[]
    /** ★ Time the list was taken (agent clock). Used for cleanup ordering */
    at?: string
    /**
     * ★★ Sessions in auto-approve mode (codex high #2, 2026-09-07).
     *
     * ⚠️⚠️ **The marker on `/sessions` alone isn't enough.** A session stopped at its first approval
     *    has no transcript and isn't in `/sessions` (the screen builds a **synthetic row** from the approval card),
     *    so a state was possible where **it could be turned on but neither the banner nor the off button showed**.
     *    ⇒ Pass the markers along the same path as the approval list and attach them to synthetic rows (`ui/order.ts`).
     * ⚠️ Old agents don't return it (`undefined`). Then nothing shows, as before.
     */
    autoApprove?: { id: string; until: string }[]
  }>
  /**
   * Approve / deny. ok:false means it timed out or was handled on the PC.
   *
   * ★ `answers` is for approvals that can't be answered yes/no (`AskUserQuestion`).
   *   Question text → chosen labels. ⚠️ **Never send `updatedInput` from the screen**
   *   (the agent builds it by matching against the original input / §9.11)
   */
  answerPermission(
    key: string,
    behavior: 'allow' | 'deny',
    answers?: Record<string, string[]>,
    /** ★ "Please change it like this" attached to a denial (equivalent to the PC's `3. Tell Claude what to change`) */
    feedback?: string,
  ): Promise<{ ok: boolean; reason?: string }>

  /**
   * ★★ Register this device (③'s device keys / ARCHITECTURE §14.1.2.16).
   *
   * ★★ **`agentPublicKey` (the agent public key from the QR) is required.**
   *   ⚠️⚠️ This layer **checks it against the endpoint's own `/health` right before sending and doesn't send on mismatch**
   *      (codex medium #7, 2026-09-08). Originally "the check is the caller's responsibility" was only written
   *      **in a comment**, so **it could be sent straight to the wrong endpoint**
   *      (a mutation changing `transports[at]` to `transports[0]` stayed green).
   *   ⇒ The convention promoted to an invariant (omitting it fails the type check; a mismatch is refused at runtime).
   * ⚠️ `token` is also required (the agent side can't omit it either).
   */
  pairDevice(body: {
    key: string
    token: string
    label: string
    /** ★ Agent public key from the QR. **Not sent unless it matches this endpoint's `/health`** */
    agentPublicKey: string
  }): Promise<PairResult>
  /** List of registered devices (★ includes breakage reasons and key problems) */
  listDevices(): Promise<DevicesResult>
  /** Revoke a registration. ⚠️ The handle is the public key (`key` returned by `listDevices`) */
  revokeDevice(key: string): Promise<RevokeResult>
  /**
   * ★★ Device-key handshake (the very first message of the step-6 tunnel).
   *
   * ⚠️ `init` is the base64url first message produced by `startHandshake()`.
   * ⚠️⚠️ **It isn't a `Session` until the returned `confirm` is opened**
   *    (`finishHandshake` → `accept()`). Opening it confirms "we reached the same key".
   */
  handshake(init: string): Promise<HandshakeResult>

  /** Push: VAPID public key and this device's subscription state */
  pushStatus(): Promise<PushStatus>
  registerPush(sub: PushSubscriptionJSON): Promise<{ deviceCount: number }>
  unregisterPush(endpoint: string): Promise<void>
  sendTestPush(): Promise<{ sent: number; pruned: number; failed: number }>
}

/**
 * ★ Build one endpoint (**the route is decided by `kind` in `endpoints.ts`** / step 6-④).
 *
 * ⚠️ `local` is fetch + SSE as before. `relay` is a line with a handshake (`relayRoute`).
 */
export function buildTransport(endpoint: AgentEndpoint): {
  transport: Transport
  /** ⚠️ Only for `relay` (it holds a line, so close it when discarding) */
  close?: () => void
} {
  if (endpointRoute(endpoint) === 'relay' && endpoint.relay) {
    const route = relayRoute({
      base: endpoint.relay.url,
      agentPublicKey: endpoint.relay.agentPublicKey,
      // ⚠️ This device's key is **read on every connect** (it can disappear / identity.ts)
      identity: () => loadIdentity(identityStore()),
    })
    return { transport: new AgentTransport(endpoint, route), close: () => route.close() }
  }
  return { transport: new AgentTransport(endpoint) }
}

/** ⚠️ Open IndexedDB **only when used** (don't touch it at load time) */
let store: ReturnType<typeof idbKeyStore> | undefined
function identityStore(): ReturnType<typeof idbKeyStore> {
  store ??= idbKeyStore()
  return store
}

interface Held {
  /** ⚠️ Marker of "same endpoint" (rebuilt when it changes) */
  sig: string
  transport: Transport
  close?: () => void
}

/** ★ Built endpoints (⚠️ **some hold lines, so they must be tracked**) */
const held = new Map<string, Held>()

function signature(e: AgentEndpoint): string {
  return JSON.stringify([
    e.url,
    endpointRoute(e),
    e.relay?.url ?? '',
    e.relay?.agentPublicKey ?? '',
  ])
}

/**
 * ★★ Build `Transport`s from the endpoint list. **Returns the same one for the same endpoint.**
 *
 * ⚠️⚠️ Rebuilding every time leaves relay lines **open and piling up** = eats relay's device slots (8)
 *    ourselves, and **real phones can't connect**.
 * ⚠️ Endpoints removed from the list or whose contents changed **have their lines closed**.
 */
export function createTransports(
  list: readonly AgentEndpoint[],
  make: (e: AgentEndpoint) => { transport: Transport; close?: () => void } = buildTransport,
): Transport[] {
  const out: Transport[] = []
  const keep = new Set<string>()
  for (const e of list) {
    keep.add(e.id)
    const sig = signature(e)
    const cur = held.get(e.id)
    if (cur && cur.sig === sig) {
      out.push(cur.transport)
      continue
    }
    // ⚠️ Contents changed (route switch, URL change) ⇒ close the old line
    cur?.close?.()
    const made = make(e)
    held.set(e.id, { sig, transport: made.transport, ...(made.close ? { close: made.close } : {}) })
    out.push(made.transport)
  }
  for (const [id, h] of [...held]) {
    if (keep.has(id)) continue
    h.close?.()
    held.delete(id)
  }
  return out
}

/** ⚠️ Build just one (for tests and callers without a list) */
export function createTransport(endpoint: AgentEndpoint): Transport {
  return buildTransport(endpoint).transport
}

/** ⚠️ For tests (★ clears the table) */
export function resetTransports(): void {
  for (const h of held.values()) h.close?.()
  held.clear()
}

/**
 * ★★ Connect **temporarily to an unknown URL** just for pairing (2026-09-16 / Y).
 *
 * ⚠️⚠️ **When served from the public origin, the endpoint list starts empty** (no agent on our own origin).
 *    ⇒ A throwaway `Transport` for verifying the QR's `u` and registering.
 * ⚠️ The route is always **`local`** (no relay material here = `endpointRoute` falls back to local).
 *    ⇒ **It's fetch, so it doesn't eat relay slots (8)** (doesn't break §14.1.2.32's "hold one").
 * ⚠️ **Not put** into the held table (`createTransports`) (added as an endpoint once registration succeeds).
 */
/**
 * ★★ **Connect via relay just for pairing** (step 7 of ③ / ARCHITECTURE §14.1.4).
 *
 * ⚠️⚠️ The key point: **no need to match public-key strings via `/health`** (codex round 7, high #1).
 *    The handshake is bound to the QR's public key (`z2`/`z4`), so **only the owner of that private key
 *    can create a session** = not a match of "values anyone who knows them can produce" but **a cryptographic guarantee**.
 *    ⇒ A fake host fails key agreement itself (the one-time token is inside the envelope and unreadable).
 *
 * ⚠️ **The line is throwaway** (the caller always `close()`s it). It isn't held because
 *    this peer is **not yet in** the endpoint list (§14.1.2.32's "hold one" is about
 *    endpoints in the list). ⚠️ Forgetting to close it eats a relay slot (8).
 * ⚠️ The agent side only allows **the pairing endpoint** and closes after returning one response (`auth.ts` / `tunnel.ts`).
 */
export function connectForRelayPairing(relay: { url: string; agentPublicKey: string }): {
  transport: Transport
  close: () => void
} {
  const endpoint: AgentEndpoint = {
    id: `pair:${relay.url}`,
    // ⚠️ The `local` route isn't used (we don't know this peer's entrance yet = empty is fine)
    url: '',
    label: relay.agentPublicKey.slice(0, 8),
    relay,
    kind: 'relay',
  }
  const built = buildTransport(endpoint)
  return { transport: built.transport, close: () => built.close?.() }
}

export function connectForPairing(url: string): {
  transport: Transport
  health: () => Promise<AgentHealth | undefined>
} {
  const built = buildTransport({ id: url, url, label: url })
  const transport = built.transport
  return {
    transport,
    // ⚠️ `undefined` if it can't be fetched (doesn't throw = the procedure can fall back to "send to no one")
    health: () => transport.health().catch(() => undefined),
  }
}
