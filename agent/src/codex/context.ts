// ★ How much context a Codex thread uses now, for the `ctx` chip a Claude row already has (2026-11-17).
//
// From the rust-v0.169.0 source (asked through codex exec; see docs/CODEX.md §5.9):
//   - No v2 request returns it to a connection that has not joined the thread (`thread/tokenUsage/updated` goes to
//     subscribers only, and we never join to read).
//   - The TUI's "% left" is built from the rollout's newest `token_count` event: `info.last_token_usage.total_tokens`
//     (not the running total). A compaction writes a new (estimated) one, so the number drops after it.
//
// The rules:
//  1. ⚠️⚠️ **The rollout is Codex's internal file, without a format version.** Anything off ⇒ `undefined` (no chip),
//     never a guess and never 0. A Codex update that changes the format makes the chip disappear, nothing worse.
//  2. Only the tail is read (a rollout grows to megabytes): 64 KB, then 1 MB when a big tool output fills the end.
//  3. Only a number (and the turn's model and effort names) leaves this file. Nothing of the conversation is kept or sent.
//  4. A read is redone only when the file's size or time changed (the list is asked for every few seconds).

import { constants } from 'node:fs'
import { open, stat, type FileHandle } from 'node:fs/promises'

const TAILS = [64 * 1024, 1024 * 1024] as const

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * What the tail says: a count, "stop" (the newest count cannot be read ⇒ an older one would be stale), or nothing yet
 * (look further back).
 */
export type TailReading = { type: 'count'; tokens: number } | { type: 'stop' } | { type: 'none' }

/**
 * The newest `token_count` in these lines, as `last_token_usage.total_tokens`.
 * `cut`: the text starts in the middle of the file, so its first line is part of a record and is skipped.
 * ⚠️ The text after the last newline is a record still being written: skipped (it is read once it is complete).
 * ⚠️⚠️ Only an event without `info` (rate limits only) is passed over. Any other count we cannot read is the newest
 *    one ⇒ `stop`, never the older number behind it (codex review, medium #1).
 */
export function readTailText(text: string, cut: boolean): TailReading {
  const lines = text.split('\n')
  lines.pop() // the unfinished record (or the empty string after the final newline)
  for (let i = lines.length - 1; i >= (cut ? 1 : 0); i--) {
    const line = lines[i]!
    // Cheap filter first: most lines are messages and tool output
    if (!line.includes('"token_count"')) continue
    let rec: unknown
    try {
      rec = JSON.parse(line)
    } catch {
      return { type: 'stop' }
    }
    if (!isObject(rec) || rec.type !== 'event_msg' || !isObject(rec.payload) || rec.payload.type !== 'token_count') continue
    const info = rec.payload.info
    if (info === null || info === undefined) continue
    const n = isObject(info) && isObject(info.last_token_usage) ? info.last_token_usage.total_tokens : undefined
    if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) return { type: 'count', tokens: n }
    return { type: 'stop' }
  }
  return { type: 'none' }
}

/** ★ The model and reasoning effort a turn ran with (2026-11-17 / the session list). Absent = unknown */
export interface TurnSettings {
  model?: string
  effort?: string
}

/**
 * The newest `turn_context` in these lines (written at each turn's start: `payload.model`, `payload.effort`).
 * `undefined` = none in this text (look further back). Same rules as `readTailText` for the cut first line and the
 * unfinished last one. ⚠️ A value of an unexpected shape is left out (never a guess).
 */
export function readTurnSettings(text: string, cut: boolean): TurnSettings | undefined {
  const lines = text.split('\n')
  lines.pop()
  for (let i = lines.length - 1; i >= (cut ? 1 : 0); i--) {
    const line = lines[i]!
    if (!line.includes('"turn_context"')) continue
    let rec: unknown
    try {
      rec = JSON.parse(line)
    } catch {
      return {}
    }
    if (!isObject(rec) || rec.type !== 'turn_context' || !isObject(rec.payload)) continue
    const { model, effort } = rec.payload
    return {
      ...(typeof model === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(model) ? { model } : {}),
      ...(typeof effort === 'string' && /^[a-z]{1,16}$/.test(effort) ? { effort } : {}),
    }
  }
  return undefined
}

/** `readTailText` on a whole file's text, as a number (tests and one-off checks) */
export function contextFromTail(text: string): number | undefined {
  const r = readTailText(text, false)
  return r.type === 'count' ? r.tokens : undefined
}

/** Whether a path from the daemon may be read as a rollout: absolute and a `.jsonl` file */
export function isRolloutPath(path: string): boolean {
  return path.startsWith('/') && path.endsWith('.jsonl') && !path.includes('\0')
}

/**
 * ⚠️⚠️ One descriptor for the check and the reads (codex review, medium #2): the path could turn into a FIFO between
 *    a `stat` and an `open`, and a blocking open would hold the whole list. ⇒ open non-blocking, never through a
 *    symlink (a rollout is a plain file), then `fstat` what was opened.
 */
export async function readContextTokens(
  path: string,
): Promise<ContextRead | undefined> {
  if (!isRolloutPath(path)) return undefined
  let fh: FileHandle | undefined
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    const st = await fh.stat()
    if (!st.isFile()) return undefined
    let tokens: number | undefined
    let counted = false
    let settings: TurnSettings | undefined
    let readFrom = st.size
    let doneTo = 0
    for (const bytes of TAILS) {
      const start = Math.max(0, st.size - bytes)
      const buf = Buffer.alloc(st.size - start)
      const { bytesRead } = await fh.read(buf, 0, buf.length, start)
      const got = buf.subarray(0, bytesRead)
      const text = got.toString('utf8')
      // ★ Byte offsets of the complete records this read looked at: from the first one after a cut line (or the start)
      //   to the end of the last finished one (the cache proves continuity with them / codex review round 2)
      const firstNl = got.indexOf(10)
      readFrom = start === 0 ? 0 : firstNl < 0 ? st.size : start + firstNl + 1
      doneTo = start + got.lastIndexOf(10) + 1
      if (!counted) {
        const r = readTailText(text, start > 0)
        if (r.type === 'count') tokens = r.tokens
        counted = r.type !== 'none'
      }
      // ★ The turn's settings sit at its start: a long turn may push them past the first tail (then the cache keeps
      //   the last ones it saw for this file)
      settings ??= readTurnSettings(text, start > 0)
      if ((counted && settings) || start === 0) break
    }
    return { size: st.size, mtimeMs: st.mtimeMs, tokens, ...(settings ? { settings } : {}), readFrom, doneTo }
  } catch {
    return undefined
  } finally {
    await fh?.close().catch(() => {})
  }
}

/** Rule 4: one entry per rollout, kept only for the paths asked about last time */
/**
 * One read of a rollout. `readFrom` / `doneTo`: the byte range of the complete records it looked at (a record
 * starting at `readFrom` or later and ending by `doneTo`)
 */
export interface ContextRead {
  size: number
  mtimeMs: number
  tokens: number | undefined
  settings?: TurnSettings
  readFrom: number
  doneTo: number
}

type Seen = ContextRead

export class ContextCache {
  #seen = new Map<string, Seen>()
  readonly #read: typeof readContextTokens
  readonly #stat: (path: string) => Promise<{ size: number; mtimeMs: number } | undefined>

  constructor(
    read: typeof readContextTokens = readContextTokens,
    statOf: (path: string) => Promise<{ size: number; mtimeMs: number } | undefined> = async (p) => {
      try {
        const st = await stat(p)
        return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : undefined
      } catch {
        return undefined
      }
    },
  ) {
    this.#read = read
    this.#stat = statOf
  }

  /** Tokens per path (absent = unknown). Paths not asked about are forgotten. */
  async lookup(paths: readonly string[]): Promise<Map<string, number>> {
    const next = new Map<string, Seen>()
    const out = new Map<string, number>()
    await Promise.all(
      [...new Set(paths)].filter(isRolloutPath).map(async (path) => {
        const known = this.#seen.get(path)
        if (known) {
          const st = await this.#stat(path)
          if (st && st.size === known.size && st.mtimeMs === known.mtimeMs) {
            next.set(path, known)
            if (known.tokens !== undefined) out.set(path, known.tokens)
            return
          }
        }
        const got = await this.#read(path)
        if (!got) return
        // ★ Settings not in the tail this time (a long turn): the last ones seen in this file stay — ⚠️ only when this
        //   read reached back over everything written since that file was last read (an unread gap could hold a new
        //   turn with other settings / codex review). Otherwise unknown.
        //   ⚠️ "Everything" is in records: this read must have looked at every record from the first one the last read
        //   did not finish (`doneTo`) on — a cut first line or an unfinished last one is not looked at (round 2)
        const continuous = known !== undefined && got.size >= known.size && got.readFrom <= known.doneTo
        const settings = got.settings ?? (continuous ? known.settings : undefined)
        next.set(path, { ...got, ...(settings ? { settings } : {}) })
        if (got.tokens !== undefined) out.set(path, got.tokens)
      }),
    )
    this.#seen = next
    return out
  }

  /** The model and effort last read for a path asked about in the last `lookup` */
  settingsOf(path: string): TurnSettings | undefined {
    return this.#seen.get(path)?.settings
  }
}
