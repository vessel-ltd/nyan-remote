// ★★ Which tool call an agy approval card is about, read from the transcript's end (2026-11-20 / docs/AGY.md §9).
//
// agy says a card is up only through its status line (`tool_confirmation_pending`), and says nothing about which call.
// Measured on agy 1.5.13 (2026-11-20):
//   - while a card is up, the transcript's last model step is the PLANNER_RESPONSE whose `tool_calls` hold the call;
//   - the calls of one response run strictly in order, and each call's result (a GENERIC record) is written before
//     the next call's card appears (a parallel [read_file, run_command]: the read's result 2 s before the card);
//   - a declined card writes nothing (the response stays the last record, its call without a result).
// ⇒ the card's call = `tool_calls[k]` of the last PLANNER_RESPONSE, where k = the GENERIC records after it.
// ⚠️ Tool calls carry no id. A card is therefore named by (step index, k) and, by the caller, the status file's time:
//    any state change in between (the PC answered; the next card) rewrites the status file.
// ⚠️ Anything unclear ⇒ undefined (no card on the phone; the PC still answers it).

import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs'

/** How much of the transcript's end is read (a call with a huge argument further back ⇒ no card) */
export const TAIL_BYTES = 2 * 1024 * 1024

export interface PendingCall {
  /** The PLANNER_RESPONSE's `step_index` */
  step: number
  /** Which of its calls (= how many results came after it) */
  index: number
  name: string
  args: Record<string, unknown>
  /** When its response was written (epoch ms from `created_at`, whole seconds); undefined = not said */
  at?: number
}

export interface TurnEnd {
  /** The last USER_INPUT's `step_index` (the turn), when it is in the read part */
  turn?: number
  /** When that USER_INPUT was written (epoch ms, whole seconds) */
  turnAt?: number
  /** ★ The model wrote after that USER_INPUT (a response, a tool result or an error: the turn has started producing) */
  afterPrompt?: true
  /** ★ The turn ended with the model's answer (not stopped, not declined, not an error) */
  answered: boolean
  /** When that answer was written (epoch ms, from its `created_at`; agy writes whole seconds) */
  answeredAt?: number
  pending?: PendingCall
}

/** The complete records at the end of the file. ⚠️ Synchronous (used right before a key is written). Never throws. */
export function readTailRecords(path: string, bytes = TAIL_BYTES): Record<string, unknown>[] {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    let got = 0
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got)
      if (n <= 0) break
      got += n
    }
    let text = buf.subarray(0, got).toString('utf8')
    // ⚠️ A half-written last line is not a record yet; a cut first line is not whole
    const end = text.lastIndexOf('\n')
    text = end < 0 ? '' : text.slice(0, end)
    if (start > 0) {
      const nl = text.indexOf('\n')
      text = nl < 0 ? '' : text.slice(nl + 1)
    }
    const out: Record<string, unknown>[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line) as unknown
        if (r && typeof r === 'object' && !Array.isArray(r)) out.push(r as Record<string, unknown>)
      } catch {
        // a broken line: skipped
      }
    }
    return out
  } catch {
    return []
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** ★ What the end of the transcript says: the turn, whether it ended answered, and the call still without a result */
export function turnEnd(records: readonly Record<string, unknown>[]): TurnEnd {
  let results = 0
  let turn: number | undefined
  let turnAt: number | undefined
  let afterPrompt = false
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!
    if (r['type'] === 'USER_INPUT') {
      turn = num(r['step_index'])
      const at = typeof r['created_at'] === 'string' ? Date.parse(r['created_at']) : NaN
      if (Number.isFinite(at)) turnAt = at
      // the model's own records only (a system reminder can follow the prompt before the turn produces anything)
      afterPrompt = records.slice(i + 1).some((x) => x['type'] === 'PLANNER_RESPONSE' || x['type'] === 'GENERIC' || x['type'] === 'ERROR_MESSAGE')
      break
    }
  }
  const withTurn = <T extends TurnEnd>(e: T): T => ({ ...e, ...(turnAt === undefined ? {} : { turnAt }), ...(afterPrompt ? { afterPrompt: true as const } : {}) })
  /** When each result's call was created (its content starts `Created At: <time>`); NaN = not said */
  const resultCalls: number[] = []
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!
    const type = r['type']
    if (type === 'GENERIC') {
      results++
      const m = typeof r['content'] === 'string' ? /^Created At: (\S+)/.exec(r['content']) : null
      resultCalls.push(m ? Date.parse(m[1]!) : NaN)
      continue
    }
    // the system's reminders sit between steps; they say nothing about the call
    if (type === 'SYSTEM_MESSAGE') continue
    if (type !== 'PLANNER_RESPONSE') return withTurn({ ...(turn === undefined ? {} : { turn }), answered: false })
    const calls = Array.isArray(r['tool_calls']) ? (r['tool_calls'] as unknown[]) : []
    if (calls.length === 0) {
      const at = typeof r['created_at'] === 'string' ? Date.parse(r['created_at']) : NaN
      return withTurn({ ...(turn === undefined ? {} : { turn }), answered: results === 0, ...(results === 0 && Number.isFinite(at) ? { answeredAt: at } : {}) })
    }
    const step = num(r['step_index'])
    const call = calls[results]
    if (step === undefined || results >= calls.length || !call || typeof call !== 'object') {
      return withTurn({ ...(turn === undefined ? {} : { turn }), answered: false })
    }
    const c = call as Record<string, unknown>
    const args = c['args']
    if (typeof c['name'] !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) {
      return withTurn({ ...(turn === undefined ? {} : { turn }), answered: false })
    }
    // ★★ Every result counted must be of a call this response made: its call cannot be older than the response
    //    (codex review: a second agy's slow tool result landing after it shifted k, so the phone showed the next call
    //    while `1` approved this one). One that is older, or that does not say ⇒ no card.
    const planAt = typeof r['created_at'] === 'string' ? Date.parse(r['created_at']) : NaN
    if (resultCalls.some((at) => !Number.isFinite(at) || !Number.isFinite(planAt) || at < planAt)) {
      return withTurn({ ...(turn === undefined ? {} : { turn }), answered: false })
    }
    return withTurn({
      ...(turn === undefined ? {} : { turn }),
      answered: false,
      pending: {
        step,
        index: results,
        name: c['name'],
        args: args as Record<string, unknown>,
        ...(typeof r['created_at'] === 'string' && Number.isFinite(Date.parse(r['created_at'])) ? { at: Date.parse(r['created_at']) } : {}),
      },
    })
  }
  return withTurn({ ...(turn === undefined ? {} : { turn }), answered: false })
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined
}

/**
 * ★★ Whether this call can be the card this agy's state shows (codex review): the call's response is written before
 * agy says a card is up, so it cannot be newer than the state file. A newer one is another agy's (a second agy on
 * the same conversation that left a declined call behind). ⚠️ No time ⇒ not trusted.
 */
export function callBeforeState(call: Pick<PendingCall, 'at'>, stateMtimeMs: number): boolean {
  return call.at !== undefined && call.at <= stateMtimeMs
}

/** How far back `lastTurnStart` looks for the turn's prompt */
export const TURN_SEARCH_BYTES = 64 * 1024 * 1024
const CHUNK = 1024 * 1024

/**
 * ★ The last USER_INPUT (the turn and when it started), looked for further back than the tail (a long turn's tool
 * results can push it out of `TAIL_BYTES` / codex review). Read backwards in chunks; only lines that name
 * `"USER_INPUT"` are parsed. ⚠️ Synchronous; used only when a notification is about to go out. Never throws.
 */
export function lastTurnStart(path: string, maxBytes = TURN_SEARCH_BYTES): { turn: number; at: number } | undefined {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    let end = size
    let carry = Buffer.alloc(0)
    while (end > 0 && size - end < maxBytes) {
      const start = Math.max(0, end - CHUNK)
      const buf = Buffer.alloc(end - start)
      let got = 0
      while (got < buf.length) {
        const n = readSync(fd, buf, got, buf.length - got, start + got)
        if (n <= 0) break
        got += n
      }
      const joined = Buffer.concat([buf.subarray(0, got), carry])
      // the part before the first newline may be cut: kept for the next (earlier) chunk
      const firstNl = start > 0 ? joined.indexOf(0x0a) : -1
      const whole = joined.subarray(firstNl + 1).toString('utf8')
      carry = firstNl >= 0 ? joined.subarray(0, firstNl) : Buffer.alloc(0)
      const lines = whole.split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!
        if (!line.includes('"USER_INPUT"')) continue
        try {
          const r = JSON.parse(line) as Record<string, unknown>
          if (r['type'] !== 'USER_INPUT') continue
          const turn = num(r['step_index'])
          const at = typeof r['created_at'] === 'string' ? Date.parse(r['created_at']) : NaN
          return turn !== undefined && Number.isFinite(at) ? { turn, at } : undefined
        } catch {
          // a half-written last line, or a broken one: look further back
        }
      }
      end = start
    }
    return undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

const turnCache = new Map<string, { size: number; found: { turn: number; at: number } | undefined }>()
const TURN_CACHE_MAX = 64

/**
 * ★ `lastTurnStart`, remembered by the file's size: a file that only grew is searched in its new part (with one chunk
 * of overlap for a line that straddles); a file that shrank (or is new) is searched again. Used on every look.
 */
export function lastTurnStartCached(path: string): { turn: number; at: number } | undefined {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    turnCache.delete(path)
    return undefined
  }
  const prev = turnCache.get(path)
  let found: { turn: number; at: number } | undefined
  if (prev && prev.size === size) return prev.found
  if (prev && prev.size < size) {
    found = lastTurnStart(path, size - Math.max(0, prev.size - CHUNK)) ?? prev.found
  } else {
    found = lastTurnStart(path)
  }
  turnCache.delete(path)
  turnCache.set(path, { size, found })
  if (turnCache.size > TURN_CACHE_MAX) turnCache.delete(turnCache.keys().next().value as string)
  return found
}
