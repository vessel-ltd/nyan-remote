// ★ The v1 route: fetch + SSE (`kind: 'local'` / see `wire.ts`).
//
// ⚠️⚠️ **Only this file may touch `fetch` and `EventSource`**
//    (checked mechanically by `web/src/discipline.test.ts`). Not the screens, of course, and
//    not even `agent.ts` (the `Transport` implementation) knows the route.
// ★ relay (tunnel) is `relay.ts`. Only the single `Wire` layer is swapped.

import { parseRelease, type BuildInfo } from '../../../shared/release.ts'
import type { AgentEvent } from '../../../shared/types.ts'
import type { Wire, WireRequest, WireResponse } from './wire.ts'
import { UnreachableError } from './unreachable.ts'
import { t } from '../../../shared/i18n.ts'

const TIMEOUT_MS = 10_000
/** Keep the reachability check short; waiting on it doesn't help */
const PROBE_TIMEOUT_MS = 5_000

export interface ProbeResult {
  ok: boolean
  /** Machine name of the responding agent. Used as the label */
  machine?: string
  accounts?: number
  /** Reason for failure (shown on screen) */
  detail?: string
  /** ★ Could not reach it at all (off / asleep): shown as a grey "Offline", not a red error (`unreachable.ts`) */
  unreachable?: boolean
}

/**
 * Check whether an agent is present at a URL not yet registered.
 *
 * ★ Discipline 2: why this lives here.
 *   Previously `web/src/ui/Endpoints.tsx` called `fetch` directly (a violation).
 *   When ③ swapped the route (`kind: tailscale | direct | webrtc`),
 *   **only the reachability check would have been left on the old HTTP route**. All traffic goes through this layer.
 */
export async function probeUrl(url: string): Promise<ProbeResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(`${url}/health`, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
      credentials: 'omit',
    })
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` }
    const body = (await res.json()) as { machine?: string; accounts?: unknown[] }
    return {
      ok: true,
      machine: typeof body.machine === 'string' ? body.machine : undefined,
      accounts: Array.isArray(body.accounts) ? body.accounts.length : undefined,
    }
  } catch (err) {
    // ★ A network error or our timeout = nothing answered (an HTTP error status above = something answered)
    const unreachable = err instanceof TypeError || (err instanceof DOMException && err.name === 'AbortError')
    return { ok: false, detail: err instanceof Error ? err.message : String(err), ...(unreachable ? { unreachable } : {}) }
  } finally {
    clearTimeout(timer)
  }
}


/**
 * ★★ The latest version served by the distribution origin (`/RELEASE` / 2026-09-24 / update notice).
 *   ⚠️ Ask **this app's distribution origin**, not the agent (the PWA on the public origin = same origin as the distributor).
 *      A PWA served by your own agent (X) has no `/RELEASE` ⇒ undefined (no notice).
 *   ⚠️ `no-store` (don't read an old version from the HTTP cache). The Service Worker **passes through** anything other than pages.
 *   ⚠️ Doesn't throw (undefined if unavailable = no notice / fail-quiet).
 */
export async function fetchLatestRelease(): Promise<BuildInfo | undefined> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch('/RELEASE', { signal: ctrl.signal, cache: 'no-store', credentials: 'omit' })
    if (!res.ok) return undefined
    return parseRelease(await res.text())
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * ★ The fetch + SSE route.
 *
 * ⚠️ Headers are added here (`application/json`). POST uses `content-type: application/json`
 *    **so that the CORS preflight always happens** (see agent/src/auth.ts).
 * ⚠️ `credentials: 'omit'` (no cookies = smaller CSRF target).
 */
/**
 * ★ How long since last receiving anything the signal line may still be called "alive".
 * ⚠️ The agent sends a heartbeat every 5s (only on the http line; the tunnel doesn't carry it) ⇒ 3 of them.
 * ⚠️⚠️ Don't rely on `OPEN` alone (codex round 17, medium #2): when TCP half-dies, `EventSource` stays `OPEN` and nothing arrives.
 */
export const EVENTS_STALE_MS = 15_000

export function httpWire(baseUrl: string, now: () => number = Date.now): Wire {
  /** ★ `/events` lines and the time each last received anything */
  const eventSources = new Map<EventSource, number | undefined>()
  return {
    async request(r: WireRequest): Promise<WireResponse> {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
      try {
        const res = await fetch(`${baseUrl}${r.path}`, {
          method: r.method,
          signal: ctrl.signal,
          credentials: 'omit',
          headers:
            r.method === 'POST'
              ? { 'content-type': 'application/json', accept: 'application/json' }
              : { accept: 'application/json' },
          ...(r.body === undefined ? {} : { body: JSON.stringify(r.body) }),
        })
        return { status: res.status, body: await readBody(res) }
      } catch (err) {
        // ★ No response at all (network error, or our timeout: on WSL a dead port hangs instead of refusing) = the machine is
        //   unreachable, shown as "offline" rather than as an error (`unreachable.ts`)
        if (err instanceof TypeError || (err instanceof DOMException && err.name === 'AbortError')) {
          throw new UnreachableError(t('繋がりません', 'Cannot reach it'))
        }
        throw err
      } finally {
        clearTimeout(timer)
      }
    },

    subscribe(on: (event: AgentEvent) => void, path = '/events'): () => void {
      const source = new EventSource(`${baseUrl}${path}`)
      // ★ Count only the state-signal line (thread following is unrelated to the list's fallback)
      if (path === '/events') eventSources.set(source, undefined)
      source.onmessage = (ev) => {
        if (eventSources.has(source)) eventSources.set(source, now())
        try {
          on(JSON.parse(ev.data as string) as AgentEvent)
        } catch {
          // Ignore broken events
        }
      }
      // EventSource reconnects automatically (the agent sends retry: 3000)
      return () => {
        eventSources.delete(source)
        source.close()
      }
    },

    // ⚠️ Reconnecting (`CONNECTING`) counts as not alive (signals during that time are missed)
    // ⚠️ A line that hasn't received anything yet also counts as not alive (`hello` arrives right after connecting)
    eventsLive: () =>
      [...eventSources].some(
        ([s, at]) => s.readyState === EventSource.OPEN && at !== undefined && now() - at < EVENTS_STALE_MS,
      ),
  }
}

/**
 * ★ Read the response body as JSON.
 *
 * ⚠️⚠️ **Unreadable is tolerated only on failure** (the agent returns failures as JSON, but
 *    an intermediate device may return an HTML error page ⇒ fall back to `HTTP <status>`).
 * ⚠️ Unreadable on success (2xx) is **a broken response**, so throw (silently passing `undefined` causes
 *    a distant TypeError at the caller like "`sessions` is missing").
 */
async function readBody(res: Response): Promise<unknown> {
  if (res.ok) return await res.json()
  try {
    return await res.json()
  } catch {
    return undefined
  }
}
