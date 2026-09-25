// ★★ The route (Wire) — discipline 2's "one layer" made **swappable** (2026-09-15 / step 6-② of ③).
//
// All 20 methods of `Transport` just "send one HTTP request and receive JSON", so
// **the route itself** is split out here. ⇒ Two implementations:
//
//   `http.ts`  … fetch + SSE (unchanged from v1; `kind: 'local'`)
//   `relay.ts` … tunnel (the envelope in `shared/tunnel.ts`; `kind: 'relay'`)
//
// ⚠️⚠️ **Don't create two `Transport` implementations.** Writing 20 methods twice means that when an endpoint is added
//    **one side is missing it** (a pattern this repo hit many times). ⇒ **Only this layer** is swapped.
//
// ★ The shape is **deliberately identical** to `TunnelRequest` / `TunnelResponse` in `shared/tunnel.ts`
//   (the tunnel side can put it straight into an envelope = no conversion code).
//
// ⚠️ Headers aren't here. **The route decides them** (fetch adds `application/json`;
//    for the tunnel the agent side adds fixed ones / ARCHITECTURE §14.1.2.22).

import type { AgentEvent } from '../../../shared/types.ts'

export interface WireRequest {
  /** ⚠️ The router only has these two (keep in sync with the table in `shared/tunnel.ts`) */
  method: 'GET' | 'POST'
  /** In the form `/sessions?live=1` (⚠️ the endpoint URL is held by the route) */
  path: string
  /** ★ POST body (JSON objects only) */
  body?: Record<string, unknown>
}

export interface WireResponse {
  status: number
  /** ★ Body (whatever parsed as JSON). ⚠️ `undefined` if unreadable */
  body?: unknown
}

export interface Wire {
  /**
   * Send one request and wait for the response.
   *
   * ⚠️⚠️ **Don't throw on status codes** (`AgentTransport` builds the reason = text lives in one place).
   * ⚠️ **Throw** on connection failure or timeout (= no response and an error response are different things).
   */
  request(r: WireRequest): Promise<WireResponse>
  /**
   * SSE subscription. ★ Returns an unsubscribe function.
   * ★ `path` is the subscription endpoint (default `/events`). `/sessions/:id/follow` (thread following) was added on 2026-09-23.
   * ⚠️ Only `transport/agent.ts` decides the endpoint (the screen can't pass arbitrary paths).
   */
  subscribe(on: (event: AgentEvent) => void, path?: string): () => void
  /**
   * ★★ **Whether the state-signal line (`/events`) is alive right now** (2026-09-24 / `ui/pollPlan.ts`).
   * If alive, the list's fallback polling stretches from 15s → 60s.
   * ⚠️⚠️ **`false` if unknown** (a missing implementation also counts as `false` = 15s as before / fail-closed).
   *    Saying `true` when it isn't alive leaves **the list up to 60 seconds stale**.
   */
  eventsLive?(): boolean
  /**
   * ★★ **The peer this line is bound to by key agreement** (2026-09-18 / codex round 8, low #7).
   *
   * ⚠️⚠️ **Absent = not bound** (fetch + SSE doesn't cryptographically verify the peer).
   * ★ Why this exists: `pairDevice` **guessed "is this relay" from the endpoint settings**, so
   *   setting only `kind:'relay'` and handing over an HTTP line **skipped the `/health` check and
   *   could send the one-time token to another host** (reproduced by codex).
   *   ⇒ **Make the authenticated target and the executed target the same value** (CLAUDE.md §2) =
   *     take the binding from **the line itself**. Don't guess from settings.
   */
  readonly boundAgentPublicKey?: string
}

/**
 * ★ Build the "reason shown on screen" from a response. **The text lives only here**.
 *
 * ⚠️ The agent returns failures as `{ error: '<Japanese>' }` (`json` in `router.ts`).
 *    Falls back to `HTTP <status>` only when the body is unreadable.
 */
export function wireErrorText(res: WireResponse): string {
  const body = res.body
  if (body !== null && typeof body === 'object' && 'error' in body) {
    const err = (body as { error?: unknown }).error
    if (typeof err === 'string' && err) return err
  }
  return `HTTP ${res.status}`
}

/** Is it 2xx (⚠️ the equivalent of `res.ok` kept in one place) */
export function wireOk(res: WireResponse): boolean {
  return res.status >= 200 && res.status < 300
}
