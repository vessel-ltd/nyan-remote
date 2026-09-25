// SSE bus. One direction (server -> client) is enough (input goes via POST).
//
// ✅ 2026-08-11: confirmed on a real phone that SSE is not buffered through tailscale serve
//    (heartbeat n increased every 5 seconds). No need to switch to WebSocket.

import { hostname } from 'node:os'
import type { ServerResponse } from 'node:http'
import type { AgentEvent } from '../../shared/types.ts'

const HEARTBEAT_MS = 5000

/**
 * ★★ A subscriber. `follow` is set only for subscriptions that **follow that one session**
 *   (`GET /sessions/:id/follow` / 2026-09-23). ⚠️⚠️ Never send `broadcast` there
 *   (list notifications go to the `/events` subscription = do not deliver twice to the same device).
 */
interface Client {
  follow?: string
}
const clients = new Map<ServerResponse, Client>()
let timer: NodeJS.Timeout | null = null
let beat = 0

function write(res: ServerResponse, event: AgentEvent): void {
  try {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  } catch {
    clients.delete(res)
  }
}

export function broadcast(event: AgentEvent): void {
  for (const [res, c] of clients) if (c.follow === undefined) write(res, event)
}

/**
 * ★★ Tell "appended" **only** to subscribers following that session.
 * ⚠️⚠️ Devices not looking at it and background tabs do not get it (relay daily limit / HANDOFF 5.0-ce).
 */
export function notifyFollowers(sessionId: string, at = new Date().toISOString()): number {
  let n = 0
  for (const [res, c] of clients) {
    if (c.follow !== sessionId) continue
    write(res, { type: 'log-appended', sessionId, at })
    n++
  }
  return n
}

/** ★ Sessions currently being followed (the watcher looks only at these) */
export function followedSessions(): Set<string> {
  const out = new Set<string>()
  for (const c of clients.values()) if (c.follow !== undefined) out.add(c.follow)
  return out
}

export function clientCount(): number {
  return clients.size
}

function ensureHeartbeat(): void {
  if (timer) return
  timer = setInterval(() => {
    if (clients.size === 0) {
      clearInterval(timer!)
      timer = null
      return
    }
    beat++
    // ⚠️ Send heartbeat **to follow subscriptions too** (so middleboxes don't cut the local SSE).
    //    ★ It never reaches the relay (the tunnel drops it / `isHeartbeat` in `tunnel.ts`)
    const hb: AgentEvent = { type: 'heartbeat', n: beat, at: new Date().toISOString() }
    for (const res of clients.keys()) write(res, hb)
  }, HEARTBEAT_MS)
  timer.unref()
}

/** Start an SSE response and return the cleanup function for disconnect */
export function attach(res: ServerResponse, opts: { follow?: string } = {}): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Tell proxies not to buffer (nginx-specific, but harmless)
    'x-accel-buffering': 'no',
  })
  // Set the reconnect interval + send the first byte immediately to defeat buffering
  res.write('retry: 3000\n\n')
  clients.set(res, opts.follow === undefined ? {} : { follow: opts.follow })
  // ★ Send `hello` to follows too (the PWA refetches on it = picks up what was missed while reconnecting)
  write(res, { type: 'hello', machine: hostname(), at: new Date().toISOString() })
  ensureHeartbeat()

  const drop = () => {
    clients.delete(res)
  }
  res.on('close', drop)
  res.on('error', drop)
}
