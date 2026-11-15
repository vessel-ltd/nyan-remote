// ★★ JSON-RPC for the Codex app-server (2026-11-14 / docs/CODEX.md §5).
//
// The wire is JSON-RPC 2.0 **without the `jsonrpc` field** (measured on codex-cli 0.169.0): one JSON object per
// WebSocket text message. Four shapes:
//   request       { id, method, params? }      either direction
//   response      { id, result } | { id, error: { code, message } }
//   notification  { method, params? }
//
// ⚠️⚠️ Everything that arrives is **another program's output** ⇒ never throw on it, never fill in defaults.
//    A message that is not one of the four shapes is counted and dropped.
// ⚠️⚠️ **A server request is never answered by this layer.** The caller answers (or deliberately does not).
//    Answering an unknown request with an error could fail a request the TUI would have answered (docs/CODEX.md §5).
// ⚠️ Request ids from the server are kept **as they came** (number or string): `1` and `"1"` are different ids.
// ⚠️⚠️ **A call that has ended is never written afterwards** (codex review, high #4). Writes queue behind backpressure;
//    a call that times out while queued would otherwise still reach the daemon later — a "failed" send that then runs.
//    ⇒ The line asks `guard` right before it writes; a call that has ended (or whose `guard` says no) is not written.
//    ★ A timeout says whether the request had been written (`written`): unwritten = it never will be; written = the
//    outcome is unknown.

export type RpcId = number | string

export interface RpcError {
  code: number
  message: string
}

/** How a call ended without a result */
export type RpcFailure =
  | { type: 'error'; error: RpcError } // the server answered with an error
  /** `written: false` ⇒ it was never handed to the line and never will be. `true` ⇒ the daemon may have acted on it. */
  | { type: 'timeout'; written: boolean }
  | { type: 'closed'; reason: string } // the line went away (or `fail()` was called)
  | { type: 'send-failed' }
  /** The caller's `guard` said no right before writing: not sent */
  | { type: 'cancelled' }

export type RpcResult = { ok: true; result: unknown } | { ok: false; failure: RpcFailure }

export interface ServerRequest {
  id: RpcId
  method: string
  params: unknown
}

export interface RpcOptions {
  /**
   * Hand one text message to the line. May reject (the call then ends as `send-failed` / `cancelled`).
   * ⚠️⚠️ The line must call `guard()` **right before** writing the bytes, and not write them if it returns false.
   */
  send: (text: string, guard: () => boolean) => Promise<void>
  onNotification: (method: string, params: unknown) => void
  onServerRequest: (req: ServerRequest) => void
  /** Default per-call timeout */
  timeoutMs?: number
}

export interface CallOptions {
  timeoutMs?: number
  /** Asked right before the request is written. False ⇒ not sent (`cancelled`). For "is this still the right thing to do". */
  guard?: () => boolean
}

export interface Rpc {
  call(method: string, params?: unknown, opts?: CallOptions): Promise<RpcResult>
  notify(method: string, params?: unknown): Promise<boolean>
  /**
   * Answer a server request. ⚠️ `id` must be the value received (type included).
   * `guard` is asked right before writing; false ⇒ not sent. Resolves whether it was written.
   */
  respond(id: RpcId, result: unknown, guard?: () => boolean): Promise<boolean>
  /** Feed one received text message. Never throws. */
  receive(text: string): void
  /** The line is gone: end every waiting call now. Later calls end immediately the same way. */
  fail(reason: string): void
  /** Messages dropped because they had no recognisable shape (for diagnostics) */
  readonly dropped: number
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isId(v: unknown): v is RpcId {
  return (typeof v === 'number' && Number.isSafeInteger(v)) || typeof v === 'string'
}

export function createRpc(opts: RpcOptions): Rpc {
  const defaultTimeout = opts.timeoutMs ?? 10_000
  let nextId = 1
  let dropped = 0
  let failed: string | undefined
  const pending = new Map<number, { settle: (r: RpcResult) => void; timer: ReturnType<typeof setTimeout> }>()

  const settle = (id: number, r: RpcResult): void => {
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    clearTimeout(p.timer)
    p.settle(r)
  }

  const sendObject = async (obj: unknown, guard: () => boolean = () => true): Promise<boolean> => {
    if (failed !== undefined) return false
    let written = false
    try {
      await opts.send(JSON.stringify(obj), () => {
        if (failed !== undefined || !guard()) return false
        written = true
        return true
      })
      return true
    } catch {
      return written
    }
  }

  return {
    get dropped() {
      return dropped
    },

    call(method, params, callOpts) {
      if (failed !== undefined) return Promise.resolve({ ok: false, failure: { type: 'closed', reason: failed } })
      const id = nextId++
      const userGuard = callOpts?.guard
      let written = false
      let refused = false
      return new Promise<RpcResult>((resolve) => {
        // ⚠️ Once settled (timed out), `pending` no longer has the id ⇒ the guard below says no and it is never written
        const timer = setTimeout(() => settle(id, { ok: false, failure: { type: 'timeout', written } }), callOpts?.timeoutMs ?? defaultTimeout)
        // ★ Registered before sending: an answer can arrive before `send` resolves
        pending.set(id, { settle: resolve, timer })
        const guard = (): boolean => {
          if (!pending.has(id)) return false
          if (userGuard && !userGuard()) {
            refused = true
            return false
          }
          written = true
          return true
        }
        void sendObject(params === undefined ? { id, method } : { id, method, params }, guard).then((sent) => {
          if (sent) return
          const failure: RpcFailure =
            failed !== undefined ? { type: 'closed', reason: failed } : refused ? { type: 'cancelled' } : { type: 'send-failed' }
          settle(id, { ok: false, failure })
        })
      })
    },

    notify(method, params) {
      return sendObject(params === undefined ? { method } : { method, params })
    },

    respond(id, result, guard) {
      return sendObject({ id, result }, guard)
    },

    receive(text) {
      let msg: unknown
      try {
        msg = JSON.parse(text)
      } catch {
        dropped++
        return
      }
      if (!isObject(msg)) {
        dropped++
        return
      }
      const hasMethod = typeof msg.method === 'string'
      const hasId = 'id' in msg
      if (hasMethod && hasId) {
        if (!isId(msg.id)) {
          dropped++
          return
        }
        opts.onServerRequest({ id: msg.id, method: msg.method as string, params: msg.params })
        return
      }
      if (hasMethod) {
        opts.onNotification(msg.method as string, msg.params)
        return
      }
      if (hasId) {
        // ⚠️ Our ids are numbers we issued. A string "1" is not our 1; an id we never issued (or already settled) is dropped.
        if (typeof msg.id !== 'number' || !pending.has(msg.id)) {
          dropped++
          return
        }
        if ('error' in msg) {
          const e = msg.error
          const error: RpcError = {
            code: isObject(e) && typeof e.code === 'number' ? e.code : 0,
            message: isObject(e) && typeof e.message === 'string' ? e.message : '',
          }
          settle(msg.id, { ok: false, failure: { type: 'error', error } })
          return
        }
        if ('result' in msg) {
          settle(msg.id, { ok: true, result: msg.result })
          return
        }
      }
      dropped++
    },

    fail(reason) {
      if (failed !== undefined) return
      failed = reason
      for (const id of [...pending.keys()]) settle(id, { ok: false, failure: { type: 'closed', reason } })
    },
  }
}
