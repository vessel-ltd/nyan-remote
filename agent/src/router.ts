// A tiny router on top of node:http. Why no Express: CLAUDE.md §2.
//
// About 8 routes, and it sits behind tailscale serve, so no TLS, compression or HTTP/2 needed.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Identity } from './auth.ts'
import { t } from '../../shared/i18n.ts'

export interface Ctx {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  params: Record<string, string>
  identity: Identity
}

export type Handler = (ctx: Ctx) => unknown | Promise<unknown>

interface Route {
  method: string
  /**
   * The string as registered (`/sessions/:id/log`).
   * ★ `match` returns this as is, so **traffic accounting does not need a second copy of the path table**
   *   (normalizing `/sessions/<uuid>/log` by hand always drifts when a route is added).
   * ⚠️ Do not rebuild it from `segments` (leading or repeated slashes can make it differ from the original).
   */
  pattern: string
  segments: string[]
  handler: Handler
}

export class HttpError extends Error {
  // ⚠️ parameter properties (constructor(readonly x: T)) cannot be used.
  //    Node's strip-only mode only erases types and does not transform.
  //    For the same reason no enum / namespace / decorator either (CLAUDE.md §5).
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** Reads the request body. Cut off at 256KB by default (enough even for M1 subscription records). */
export async function readBody(req: IncomingMessage, limit = 256 * 1024): Promise<string> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > limit) throw new HttpError(413, 'body too large')
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  // ★ Require Content-Type.
  //
  // ⚠️ Without this, a `text/plain` "simple request" avoids the preflight,
  //    and a POST arrives without ever passing the CORS check (found in the 2026-08-12 review).
  //    Requiring application/json makes the browser always send a preflight.
  //    notify.sh and the PWA both send application/json, so existing wiring does not break.
  const ct = req.headers['content-type']
  const type = (Array.isArray(ct) ? ct[0] : ct)?.split(';')[0]?.trim().toLowerCase()
  if (type !== 'application/json') {
    throw new HttpError(415, t('content-type は application/json にしてください', 'Set content-type to application/json.'))
  }
  const raw = await readBody(req)
  if (!raw) return {} as T
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'invalid json')
  }
  // ★★ **Check at the entry that it is an object** (2026-09-08 codex round 2, low).
  //   ⚠️⚠️ The type argument (`readJsonBody<Body>`) is **not a runtime check**, so a body of `null`,
  //      `[]`, a number or a string made the caller's `body.key` a `TypeError` and a **500**
  //      (measured on three routes: `/pair`, `/devices/revoke`, `/handshake`).
  //   ⇒ Turn it into a 400 in this one place (writing it per route always misses one).
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, t('本文は JSON オブジェクトにしてください', 'The request body must be a JSON object.'))
  }
  return parsed as T
}

/** ⚠️ `undefined` if it cannot be read (**never passed through raw**) */
function decodeSegment(part: string): string | undefined {
  try {
    return decodeURIComponent(part)
  } catch {
    return undefined
  }
}

function split(path: string): string[] {
  return path.split('/').filter(Boolean)
}

export class Router {
  private routes: Route[] = []
  /** Handler when no route matches (static serving) */
  fallback: Handler | null = null

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method, pattern, segments: split(pattern), handler })
    return this
  }

  get(pattern: string, handler: Handler): this {
    return this.add('GET', pattern, handler)
  }

  post(pattern: string, handler: Handler): this {
    return this.add('POST', pattern, handler)
  }

  match(
    method: string,
    path: string,
  ): { handler: Handler; params: Record<string, string>; pattern: string } | null {
    const parts = split(path)
    for (const route of this.routes) {
      if (route.method !== method && !(route.method === 'GET' && method === 'HEAD')) continue
      if (route.segments.length !== parts.length) continue
      const params: Record<string, string> = {}
      let ok = true
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i]!
        const part = parts[i]!
        if (seg.startsWith(':')) {
          // ★★ **Do not throw on malformed percent-encoding** (2026-09-15 / codex medium #1).
          //   ⚠️⚠️ `decodeURIComponent('%')` throws `URIError`, so
          //      `/sessions/%/log` alone — **only the peer's input** — made matching throw.
          //   ⇒ An unreadable segment "does not match" (= 404). **No such id exists**, so
          //     that is the honest answer. ⚠️ Do not put it into params raw (two interpretations).
          const value = decodeSegment(part)
          if (value === undefined) {
            ok = false
            break
          }
          params[seg.slice(1)] = value
        } else if (seg !== part) {
          ok = false
          break
        }
      }
      if (ok) return { handler: route.handler, params, pattern: route.pattern }
    }
    return null
  }
}
