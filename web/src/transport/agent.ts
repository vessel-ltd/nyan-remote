// **The only** `Transport` implementation (the route is swapped via `Wire` / see `wire.ts`).
//
// ⚠️⚠️ **Don't create another one for relay.** Writing 20 methods twice means when an endpoint is added,
//    **one side is missing it** (= this is what discipline 2 means).
// ⚠️ Calling an agent on another origin requires registering it in the agent's allowedOrigins (CORS).
//    This is a deliberate constraint. serve adds identity headers on the server side, so only CORS
//    stops "any website from reading /sessions" (agent/src/auth.ts).

import { currentLang, t, type Lang } from '../../../shared/i18n.ts'
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
  DevicesResult,
  HandshakeResult,
  PairResult,
  RevokeResult,
  PermissionRequest,
  PushStatus,
  SessionsPage,
} from '../../../shared/types.ts'
import type { AgentEndpoint } from '../endpoints.ts'
import { httpWire } from './http.ts'
import type { LogQuery, Transport } from './index.ts'
import { wireErrorText, wireOk, type Wire } from './wire.ts'

export class AgentTransport implements Transport {
  // ⚠️ Don't use a parameter property (`constructor(readonly endpoint: …)`).
  //    Node's strip-only mode can't handle it; importing directly gives
  //    ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX (the same thing we hit once in router.ts).
  //    Vite transforms it so only production happened to work, but it couldn't be imported from node:test,
  //    so not a single transport test could be written (found in the review on 2026-08-12).
  readonly endpoint: AgentEndpoint
  /** ★ The route. ⚠️ **Private** (don't create a way for screens to swap it) */
  #wire: Wire

  /**
   * ⚠️ Omitting `wire` gives **fetch + SSE** (as in v1).
   *    For ③'s relay, `createTransport` picks by `kind` in `endpoints.ts`.
   */
  constructor(endpoint: AgentEndpoint, wire: Wire = httpWire(endpoint.url)) {
    this.endpoint = endpoint
    this.#wire = wire
  }

  /**
   * ★★ **The only place requests are made** (all 20 methods go through here).
   *
   * ⚠️⚠️ Failure text is built in this one place (writing it per endpoint always drifts).
   */
  async #call<T>(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<T> {
    // ★★ **Tell the agent the screen language** (2026-09-23 / `shared/i18n.ts`). For this request only, the agent
    //   returns text (error reasons etc.) in that language. ⚠️ Added **only here** (per-endpoint means someone forgets).
    const res = await this.#wire.request({ method, path: withLang(path), ...(body === undefined ? {} : { body }) })
    if (!wireOk(res)) throw new Error(wireErrorText(res))
    return res.body as T
  }

  private get<T>(path: string): Promise<T> {
    return this.#call<T>('GET', path)
  }

  health(): Promise<AgentHealth> {
    return this.get<AgentHealth>('/health')
  }

  async listPermissions(): Promise<{
    permissions: PermissionRequest[]
    quiet: number
    pendingTags?: string[]
    at?: string
    autoApprove?: { id: string; until: string }[]
  }> {
    const body = await this.get<{
      permissions: PermissionRequest[]
      quiet?: number
      pendingTags?: unknown
      at?: unknown
      autoApprove?: unknown
    }>('/permissions')
    // ⚠️⚠️ **Dropping these here silently breaks notification cleanup** (codex medium #5, 2026-08-20).
    //    `pendingTags` (superset) wasn't passed through while only `main.tsx` was fixed, so
    //    **the app-side cleanup kept using `permissions` (the list without quiet ones)**.
    //    ★ The canary only looked at `main.tsx` = a false green. **Check the whole path end to end.**
    return {
      permissions: body.permissions ?? [],
      quiet: body.quiet ?? 0,
      // Old agents don't return it (undefined). Then the cleanup decision is unchanged
      pendingTags: Array.isArray(body.pendingTags)
        ? body.pendingTags.filter((t): t is string => typeof t === 'string')
        : undefined,
      at: typeof body.at === 'string' ? body.at : undefined,
      // ★★ Auto-approve markers. ⚠️ **Dropping these here means, for sessions without a transcript,
      //    "on, but neither the banner nor the off button shows"** (the same hole as `pendingTags` on 2026-08-20)
      autoApprove: Array.isArray(body.autoApprove)
        ? body.autoApprove.flatMap((a) => {
            const r = a as { id?: unknown; until?: unknown }
            return typeof r.id === 'string' && typeof r.until === 'string'
              ? [{ id: r.id, until: r.until }]
              : []
          })
        : undefined,
    }
  }

  answerPermission(
    key: string,
    behavior: 'allow' | 'deny',
    answers?: Record<string, string[]>,
    feedback?: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    return this.post<{ ok: boolean; reason?: string }>('/permission/answer', {
      key,
      behavior,
      ...(answers ? { answers } : {}),
      ...(feedback ? { feedback } : {}),
    })
  }

  /**
   * ★★ **Filtering is requested explicitly with `?live=1`** (ARCHITECTURE §14.1.1.7).
   *
   * ⚠️⚠️ **Never make filtering the agent's default** (codex medium #1, 2026-09-01).
   *    An old PWA (Service Worker holding an old bundle / only one side of the symmetric mesh updated)
   *    reads no-query as "everything", so **the entire history vanishes**.
   * ⚠️ `?live=1` is **ignored as an unknown query by old agents, which return everything**
   *    ⇒ it can't 404, so no `/health` marker is needed (the response's `history` acts as the marker).
   */
  async listSessions(opts: { history: boolean }): Promise<SessionsPage> {
    // ⚠️ Be **explicit** when asking for everything too (`?history=1`). Without a query,
    //    an agent from the version whose default was filtered (`bd59748`) **wouldn't return everything,
    //    and history could never be fetched** (codex round 2, high #1, 2026-09-01).
    //    ★ `?history=1` means everything in every version (new agents default to everything and just
    //      ignore unknown queries).
    const body = await this.get<SessionsPage>(`/sessions?${opts.history ? 'history=1' : 'live=1'}`)
    return { machine: body.machine, sessions: body.sessions ?? [], ...(body.history ? { history: body.history } : {}) }
  }

  getLog(sessionId: string, opts?: LogQuery): Promise<LogPage> {
    const q = new URLSearchParams()
    if (opts?.before !== undefined) q.set('before', String(opts.before))
    if (opts?.since !== undefined) q.set('since', String(opts.since))
    if (opts?.limit !== undefined) q.set('limit', String(opts.limit))
    const qs = q.toString()
    return this.get<LogPage>(`/sessions/${encodeURIComponent(sessionId)}/log${qs ? `?${qs}` : ''}`)
  }

  /** ★ Send an instruction (M4-2). The agent returns failure reasons as text, so show them as-is */
  sendMessage(sessionId: string, text: string): Promise<MessageSendResult> {
    return this.post<MessageSendResult>(
      `/sessions/${encodeURIComponent(sessionId)}/message`,
      { text },
    )
  }

  /**
   * ★ Stop (ESC). ⚠️ **No body** (the bytes sent are fixed in the agent's table).
   * ⚠️ Must be POST (GET wouldn't pass the CSRF check = just following a link could stop it).
   */
  interrupt(sessionId: string): Promise<InterruptResult> {
    return this.post<InterruptResult>(`/sessions/${encodeURIComponent(sessionId)}/interrupt`)
  }

  /**
   * ★ Table slash commands (`/compact` / `/exit`).
   * ⚠️⚠️ **The body is only the id** (the text sent is fixed in the agent's table).
   * ⚠️ Must be POST (with GET, just following a link could end the session).
   */
  runCommand(sessionId: string, id: CommandId): Promise<CommandResult> {
    return this.post<CommandResult>(`/sessions/${encodeURIComponent(sessionId)}/command`, { id })
  }

  /**
   * ★ Toggle auto-approve mode. ⚠️ **Only a boolean is passed** (the duration is decided by the agent).
   * ⚠️ Must be POST (with GET, just following a link could enable auto-approve).
   */
  setAutoApprove(sessionId: string, on: boolean, duration?: AutoApproveDuration): Promise<AutoApproveResult> {
    return this.post<AutoApproveResult>(
      `/sessions/${encodeURIComponent(sessionId)}/auto-approve`,
      // ★ The duration is **only a name** (lengths are in the agent's table). ⚠️ Not attached when turning off
      on && duration ? { on, duration } : { on },
    )
  }

  /** ★ Clear the PC's input box (Ctrl-U). ⚠️ **No body** (the bytes sent are in the agent's table) */
  clearInput(sessionId: string): Promise<InterruptResult> {
    return this.post<InterruptResult>(`/sessions/${encodeURIComponent(sessionId)}/clear`)
  }

  // ⚠️ A POST without a body still sends `{}` (`readJsonBody` requires content-type)
  private post<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    return this.#call<T>('POST', path, body ?? {})
  }

  listPeers(): Promise<PeersResult> {
    return this.get<PeersResult>('/peers')
  }

  // ★★ ③'s device keys (ARCHITECTURE §14.1.2.16).
  /**
   * ★★ **Right before sending, verify "this endpoint is the agent that showed the QR"**
   *   (codex medium #7, 2026-09-08).
   *
   * ⚠️⚠️ Originally "the check is the caller's responsibility" was only written **in a comment**, so
   *    the moment the screen picked the wrong endpoint **the one-time token leaked to another machine**
   *    (a mutation changing `transports[at]` to `transports[0]` stayed green).
   * ⚠️⚠️ **If it doesn't match, nothing goes out on the network** (only the one `/health`).
   * ⚠️ An (old) agent that returns no key also doesn't match = not sent (fail-closed).
   */
  async pairDevice(body: {
    key: string
    token: string
    label: string
    agentPublicKey: string
  }): Promise<PairResult> {
    const { agentPublicKey, ...rest } = body
    if (!agentPublicKey) return { ok: false, reason: t('QR の agent 公開鍵がありません', "The QR has no agent public key") }
    // ★★ **On a relay line, the handshake itself is bound to the QR key** (step 7 of ③ / §14.1.4).
    //
    // ⚠️⚠️ The `/health` string comparison **doesn't prove ownership** (codex round 7, high #1:
    //    a fake host just returning the real public key passed, and the one-time token was handed over).
    //    Via relay, `z2`/`z4` are bound to this key, so **once key agreement succeeds
    //    the peer owns the private key**. ⇒ This is stronger.
    // ⚠️ What's compared here are **two local values** (the QR key and the key this line is bound to),
    //    not values the peer can produce. ⇒ Not "a match of values anyone who knows them can produce".
    // ⚠️⚠️ On a pairing line, `/health` is **403** (the agent only allows the pairing endpoint).
    //    ⇒ Reverting to fetching `/health` here **always fails pairing**.
    // ★★ **The binding comes from the line itself** (2026-09-18 / codex round 8, low #7).
    //   ⚠️⚠️ It used to be guessed from `endpointRoute(this.endpoint)` (= **the endpoint settings**), so
    //      setting only `kind:'relay'` and handing over an HTTP line **skipped the `/health` check and
    //      could send the one-time token to another host** (codex reproduced it with a real `AgentTransport`).
    //   ⇒ **Make the authenticated target and the executed target the same value** (generalization in CLAUDE.md §2).
    const bound = this.#wire.boundAgentPublicKey
    if (bound !== undefined) {
      if (bound !== agentPublicKey) {
        return { ok: false, reason: t('この接続先は、その QR を出したマシンではありません', 'This connection is not the machine that showed that QR') }
      }
      return await this.post<PairResult>('/pair', rest)
    }
    let mine: string | undefined
    try {
      mine = (await this.health()).agentPublicKey
    } catch (err) {
      return { ok: false, reason: t(`接続先を確かめられません（${errText(err)}）`, `Cannot verify the connection (${errText(err)})`) }
    }
    // ⚠️⚠️ Return here without sending (**not a single request carrying the one-time token goes out**)
    if (!mine || mine !== agentPublicKey) {
      return { ok: false, reason: t('この接続先は、その QR を出したマシンではありません', 'This connection is not the machine that showed that QR') }
    }
    return await this.post<PairResult>('/pair', rest)
  }

  listDevices(): Promise<DevicesResult> {
    return this.get<DevicesResult>('/devices')
  }

  revokeDevice(key: string): Promise<RevokeResult> {
    return this.post<RevokeResult>('/devices/revoke', { key })
  }

  handshake(init: string): Promise<HandshakeResult> {
    return this.post<HandshakeResult>('/handshake', { init })
  }

  pushStatus(): Promise<PushStatus> {
    return this.get<PushStatus>('/push/status')
  }

  registerPush(sub: PushSubscriptionJSON): Promise<{ deviceCount: number }> {
    // ⚠️ `PushSubscriptionJSON` is "a JSON object with arbitrary keys", so copy it
    //    (rather than loosening the type, **fix the sent shape here**)
    return this.post<{ deviceCount: number }>('/push/subscribe', { ...sub })
  }

  async unregisterPush(endpoint: string): Promise<void> {
    await this.post('/push/unsubscribe', { endpoint })
  }

  sendTestPush(): Promise<{ sent: number; pruned: number; failed: number }> {
    return this.post<{ sent: number; pruned: number; failed: number }>('/push/test')
  }

  subscribe(on: (event: AgentEvent) => void): () => void {
    return this.#wire.subscribe(on)
  }

  eventsLive(): boolean {
    return this.#wire.eventsLive?.() ?? false
  }

  followLog(sessionId: string, on: (event: AgentEvent) => void): () => void {
    return this.#wire.subscribe(on, `/sessions/${encodeURIComponent(sessionId)}/follow`)
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** ★ Append `lang` to the path (`&` if a query already exists). ⚠️ Not used for decisions (only for choosing text) */
export function withLang(path: string, lang: Lang = currentLang()): string {
  return `${path}${path.includes('?') ? '&' : '?'}lang=${lang}`
}
