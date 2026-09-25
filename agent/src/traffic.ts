// ★★ Measures actual PWA ↔ agent traffic (2026-08-31).
//
// **Why**: once ③ makes `relay` the default, **every byte goes through Cloudflare**
// (⚠️ WebRTC was rejected, so it is not "relay only at first, then P2P" / ARCHITECTURE §14.1.1).
// ⇒ **Bandwidth becomes the main cost**, so pricing (§14.1.1.5) and relay limits (64KB per message /
// daily bandwidth per key) need real measurements.
//
// ★★ It is also **an input to protocol design**. Over the relay the RTT more than doubles, so
// "tunnel today's HTTP as is, or use a dedicated message format" cannot be decided
// without looking at **the number of round trips**.
//
// ⚠️⚠️ **Discipline check** (read before touching):
//  - **Never write bodies** (§6.2). Only **router patterns, counts and byte counts** are recorded.
//    ⚠️ Writing `/sessions/<uuid>/log` as is **leaves session IDs** ⇒ use the `pattern` the `router`
//    returns (**do not write your own normalization**; two copies always drift when a route is added)
//  - **fail-open**. If measurement fails, traffic continues (the agent sits in "the daily critical path")
//  - Do not remove **the escape hatch** (`NYAN_REMOTE_NO_MEASURE=1`) (same treatment as `relay.py`)
//  - This is **a different layer** from "no state needing a single writer on the server" (§7.3).
//    That is about display state the PWA reads; this is **a local measurement log** (the PWA does not read it)
//
// ⚠️ What can be measured is **plaintext size between the agent and `tailscale serve`** (the agent speaks plain HTTP,
// serve adds TLS). Encryption overhead over the relay is small too, so this is **a good enough approximation**.

import { t } from '../../shared/i18n.ts'
import { mkdir, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname } from 'node:path'

import { statePath } from './state.ts'

/** Escape hatch. ⚠️ Do not remove */
function disabled(): boolean {
  return process.env['NYAN_REMOTE_NO_MEASURE'] === '1'
}

export interface RouteTotals {
  /** Count (★ number of round trips; input to protocol design) */
  n: number
  /**
   * Bytes agent → client (responses).
   *
   * ⚠️⚠️ **The request side (`in`) cannot be measured here** (found by measuring on 2026-08-31).
   *    By the time the `createServer` callback runs, **the request headers have already been read**,
   *    so the `bytesRead` delta is always 0 for GET.
   * ⇒ **Do not report an unmeasurable number as 0** (it would be a false number).
   *    Total up/down volume is measured per connection instead (`ConnTotals`).
   */
  out: number
}

/** Remembers the router pattern. ⚠️ Do not add properties to `res` (it pollutes the type) */
const patterns = new WeakMap<ServerResponse, string>()

/** Aggregates (in memory). Written out and cleared every minute */
let totals = new Map<string, RouteTotals>()
/** Connections currently open (★ SSE is not counted until it closes, so this makes it visible) */
let open = 0

/**
 * Per-connection totals. ★ **This is the basis for pricing and relay limits** (both directions are available).
 * ⚠️ No per-pattern breakdown (one connection carries several requests). ⇒ Keep two tallies.
 */
export interface ConnTotals {
  /** Number of connections */
  n: number
  /** Total bytes agent → client */
  out: number
  /** Total bytes client → agent (★ the real upstream, headers included) */
  in: number
}
let conns: ConnTotals = { n: 0, out: 0, in: 0 }

/**
 * Measures the totals of one connection. Called from `server.on('connection', measureConnection)`.
 * ⚠️ When the socket closes, **add the cumulative totals as is** (not a delta; it is one connection's total).
 */
export function measureConnection(socket: {
  bytesWritten?: number
  bytesRead?: number
  on: (ev: string, fn: () => void) => unknown
}): void {
  if (disabled()) return
  try {
    conns.n += 1
    socket.on('close', () => {
      try {
        conns.out += typeof socket.bytesWritten === 'number' ? socket.bytesWritten : 0
        conns.in += typeof socket.bytesRead === 'number' ? socket.bytesRead : 0
      } catch {
        // fail-open
      }
    })
  } catch {
    // fail-open
  }
}

/**
 * Tells the pattern the router chose.
 * ⚠️ **Without this call it is recorded as `?`** (static serving and 404 are like that).
 */
export function notePattern(res: ServerResponse, pattern: string | undefined): void {
  if (disabled() || !pattern) return
  try {
    patterns.set(res, pattern)
  } catch {
    // fail-open
  }
}

/**
 * Starts measuring one request. ⚠️ **Waits until `close`** (SSE lasts for hours).
 *
 * ⚠️ Sockets are reused with keep-alive, so **remember the starting value and take the delta**
 * (`bytesWritten` is that socket's running total).
 */
export function beginMeasure(req: IncomingMessage, res: ServerResponse): void {
  if (disabled()) return
  try {
    const sock = req.socket
    // ⚠️ do not use a "possible value" as a sentinel: skip measuring if there is no socket / not a number
    const startOut = typeof sock?.bytesWritten === 'number' ? sock.bytesWritten : -1
    if (startOut < 0) return
    open += 1
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      try {
        open -= 1
        const out = Math.max(0, (sock.bytesWritten ?? startOut) - startOut)
        add(`${req.method ?? 'GET'} ${patterns.get(res) ?? '?'}`, out)
      } catch {
        // fail-open
      }
    }
    res.on('close', finish)
  } catch {
    // fail-open
  }
}

function add(key: string, out: number): void {
  const cur = totals.get(key)
  if (cur) {
    cur.n += 1
    cur.out += out
  } else {
    totals.set(key, { n: 1, out })
  }
}

/** Current aggregates. ★ Tests and `flush` look at the same thing (two copies would drift) */
export function snapshot(): { routes: Record<string, RouteTotals>; conns: ConnTotals; open: number } {
  return { routes: Object.fromEntries(totals), conns: { ...conns }, open }
}

/**
 * Writes one line to `~/.nyan-remote/traffic.jsonl` and clears the aggregates.
 * ⚠️ **Empty windows are not written** (do not create 1440 empty lines a day).
 */
export async function flush(now = new Date()): Promise<boolean> {
  if (disabled()) return false
  // ⚠️ some windows have connections but no finished request, so check both
  if (totals.size === 0 && conns.n === 0) return false
  const routes = Object.fromEntries(totals)
  const c = { ...conns }
  totals = new Map()
  conns = { n: 0, out: 0, in: 0 }
  // ⚠️⚠️ **Do not use `appendJsonl`** (2026-08-31). Its contract is to **swallow its own exceptions**,
  //    so it returns "true though nothing was written" ⇒ **a day of measuring with no data** goes unnoticed.
  //    ⇒ Write it here and return the failure. ⚠️ But **do not throw** (the agent sits in the daily critical path).
  //    ★ Leave the choice of state directory to `statePath` (do not write it in two places).
  try {
    const path = statePath('traffic.jsonl')
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, `${JSON.stringify({ at: now.toISOString(), routes, conns: c, open })}\n`, {
      flag: 'a',
      mode: 0o600,
    })
    return true
  } catch (err) {
    // ⚠️ **discard** the aggregates of a failed window (putting them back doubles the next window).
    //    ★ but **do not stay silent** (say it once; this is not a log that repeats every 0.7s)
    if (!warned) {
      warned = true
      console.warn(
        t('[traffic] 記録できません（計測だけ止まります）: ', '[traffic] Cannot record (only measurement stops): ') +
          (err instanceof Error ? err.message : String(err)),
      )
    }
    return false
  }
}

let warned = false

const FLUSH_MS = 60_000
let timer: NodeJS.Timeout | undefined

/** Starts writing out every minute. ⚠️ `unref()` it (so it does not hold up tests or process exit) */
export function startFlushing(): void {
  if (disabled() || timer) return
  timer = setInterval(() => void flush(), FLUSH_MS)
  timer.unref()
}

export function stopFlushingForTest(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}

export function resetForTest(): void {
  totals = new Map()
  conns = { n: 0, out: 0, in: 0 }
  open = 0
}
