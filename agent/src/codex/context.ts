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
//  3. Only a number leaves this file. Nothing of the conversation is kept or sent.
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
export async function readContextTokens(path: string): Promise<{ size: number; mtimeMs: number; tokens: number | undefined } | undefined> {
  if (!isRolloutPath(path)) return undefined
  let fh: FileHandle | undefined
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    const st = await fh.stat()
    if (!st.isFile()) return undefined
    let tokens: number | undefined
    for (const bytes of TAILS) {
      const start = Math.max(0, st.size - bytes)
      const buf = Buffer.alloc(st.size - start)
      const { bytesRead } = await fh.read(buf, 0, buf.length, start)
      const r = readTailText(buf.subarray(0, bytesRead).toString('utf8'), start > 0)
      if (r.type === 'count') tokens = r.tokens
      if (r.type !== 'none' || start === 0) break
    }
    return { size: st.size, mtimeMs: st.mtimeMs, tokens }
  } catch {
    return undefined
  } finally {
    await fh?.close().catch(() => {})
  }
}

/** Rule 4: one entry per rollout, kept only for the paths asked about last time */
export class ContextCache {
  #seen = new Map<string, { size: number; mtimeMs: number; tokens: number | undefined }>()
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
    const next = new Map<string, { size: number; mtimeMs: number; tokens: number | undefined }>()
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
        next.set(path, got)
        if (got.tokens !== undefined) out.set(path, got.tokens)
      }),
    )
    this.#seen = next
    return out
  }
}
