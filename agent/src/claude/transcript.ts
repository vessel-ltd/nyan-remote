// Derive a session's metadata from its transcript JSONL.
//
// ⚠️ Never parse the whole file. Files of 14MB have been measured.
//    Read only the first 8KB (cwd / gitBranch / version / the first user message) and
//    the last 64KB (title, permission mode, latest timestamp).
//
// Titles come in 3 layers (confirmed on real data on 2026-08-11):
//   custom-title.customTitle  … the name set with /rename. Highest priority
//   ai-title.aiTitle          … a summary title the AI generated
//   first user message        … when neither exists
//
// custom-title / ai-title are re-emitted on every write (measured: 31 times in 422 records),
// so they are almost always in the last 64KB. We still look at the head as a fallback.

import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import type { TitleSource } from '../../../shared/types.ts'

export const HEAD_BYTES = 8 * 1024
export const TAIL_BYTES = 64 * 1024
const TITLE_MAX = 70

export interface TranscriptMeta {
  sessionId: string
  file: string
  bytes: number
  mtimeMs: number
  cwd?: string
  gitBranch?: string
  cliVersion?: string
  title: string
  titleSource: TitleSource
  permissionMode?: string
  /** ISO8601. If unavailable, the caller uses mtime */
  lastActivity?: string
  /** Body of system/away_summary (one line on what happened while away) */
  awaySummary?: string
  /** ★ How much context (tokens) is currently in use. undefined if unknown */
  contextTokens?: number
}

type Rec = Record<string, unknown>

/**
 * Turn JSONL text into an array of records.
 * @param dropFirst when reading started mid-file, the first line is broken, so drop it
 * @param dropLast  when reading stopped mid-file, the last line is broken, so drop it
 */
export function parseLines(text: string, dropFirst = false, dropLast = false): Rec[] {
  let lines = text.split('\n')
  if (dropFirst && lines.length > 0) lines = lines.slice(1)
  if (dropLast && lines.length > 0) lines = lines.slice(0, -1)
  const out: Rec[] = []
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    try {
      const o = JSON.parse(t) as unknown
      if (o && typeof o === 'object') out.push(o as Rec)
    } catch {
      // Silently drop broken lines (can happen when reading mid-write)
    }
  }
  return out
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/** Search from the end and return the first value found (= the latest value) */
function lastOf(records: Rec[], type: string, key: string): string | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!
    if (r['type'] === type) {
      const v = str(r[key])
      if (v) return v
    }
  }
  return undefined
}

/** Extract displayable text from a user record. undefined when nothing can be extracted. */
export function extractUserText(rec: Rec): string | undefined {
  if (rec['type'] !== 'user' || rec['isSidechain'] === true || rec['isMeta'] === true) return undefined
  const message = rec['message']
  if (!message || typeof message !== 'object') return undefined
  const content = (message as Rec)['content']
  let text: string | undefined
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (block && typeof block === 'object' && (block as Rec)['type'] === 'text') {
        const t = str((block as Rec)['text'])
        if (t) parts.push(t)
      }
    }
    text = parts.join(' ')
  }
  if (!text) return undefined
  const trimmed = text.trim()
  if (!trimmed) return undefined
  // Not usable as a title: command wrappers, system-reminder, compaction resume text, tool results
  if (trimmed.startsWith('<')) return undefined
  if (trimmed.startsWith('Caveat:')) return undefined
  if (trimmed.includes('<system-reminder>')) return undefined
  if (trimmed.startsWith('This session is being continued')) return undefined
  if (trimmed.startsWith('Base directory for this skill')) return undefined
  return trimmed
}

function firstPromptTitle(records: Rec[]): string | undefined {
  for (const rec of records) {
    const t = extractUserText(rec)
    if (t) return t.split('\n')[0]!.trim()
  }
  return undefined
}

function clipTo(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

function clip(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > TITLE_MAX ? `${one.slice(0, TITLE_MAX - 1)}…` : one
}

export interface DeriveInput {
  sessionId: string
  headRecords: Rec[]
  tailRecords: Rec[]
}

export interface Derived {
  cwd?: string
  gitBranch?: string
  cliVersion?: string
  permissionMode?: string
  lastActivity?: string
  title: string
  titleSource: TitleSource
  /** Body of system/away_summary (one line on what happened while away) */
  awaySummary?: string
  /** ★ How much context (tokens) is currently in use. undefined if unknown */
  contextTokens?: number
}

/**
 * ★★ How much **context the session is currently using** (tokens). Added 2026-08-19.
 *
 * The source is `message.usage` on the transcript's assistant records. It is **exactly what was sent**,
 * so it is more accurate than estimating from the file's byte size (measured: estimate 1,771k vs. actual 674k).
 *
 * ⚠️⚠️ **Add three numbers.** `input_tokens` **excludes cached tokens**, so on its own it reads as 2:
 *   `input_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens`
 *
 * ⚠️ If nothing is found, return **`undefined`** (not 0 / no fail-open).
 *    The last 64KB may contain no assistant record (when a huge tool result sits at the end).
 * ⚠️ The value is from the **last completed request**. While responding, it is one turn behind.
 * ⚠️ The window size (1M / 200k) cannot be known from the transcript (`model` does not carry `[1m]`).
 *    **So we do not show a percentage** (we do not guess a window we do not know).
 */
export function contextTokensOf(records: Rec[]): number | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!
    // ⚠️⚠️ ★ **Do not look past the compact boundary** (2026-08-19 codex review, medium #2).
    //    Reproduced on real data: right after compaction the tail holds only the "pre-compaction assistant",
    //    so it **returned 901,602 (true value: 60,428 from the next response) = a 15x lie**.
    //    ⚠️ Do not show `compactMetadata.postTokens` (14,534) instead either.
    //    It is a **different metric**, 33k–56k smaller than the next input usage (excludes the system prompt etc.).
    //    ⇒ **Hide the chip until the next response** (`undefined`). The CLI's official statusLine also
    //    defines `current_usage: null` right after compaction.
    if (r['type'] === 'system' && r['subtype'] === 'compact_boundary') return undefined
    if (r['type'] !== 'assistant') continue
    // ⚠️⚠️ **Reject subagent (sidechain) records** (2026-08-19 `/code-review`, medium #2).
    //    I had written "we only look at `type` === `assistant`, so mixed-in records are not picked up",
    //    but **sidechain records also have `type` `assistant`**, so that guard never existed.
    //    ⚠️ The current CLI does not write sidechain records into the main file (measured), but
    //    other places in this repo (`extractUserText` / `log.ts`) **do not trust that and reject them**.
    if (r['isSidechain'] === true) continue
    const message = r['message']
    if (!message || typeof message !== 'object') continue
    const usage = (message as Rec)['usage']
    if (!usage || typeof usage !== 'object') continue
    const u = usage as Rec
    let total = sumUsage(u)
    // ⚠️ ★ **Some records have values only in `iterations`** (2026-08-19 codex review, medium #3).
    //    Two were found in real data (CLI 2.1.215. The top level was all 0, and
    //    the last `message` in `iterations` held 445,631).
    //    ⚠️ Do not sum all iterations. The **last message** is the closest to "the current input"
    if (total === 0 && Array.isArray(u['iterations'])) {
      const its = u['iterations']
      for (let j = its.length - 1; j >= 0 && total === 0; j--) {
        const it = its[j]
        if (!it || typeof it !== 'object') continue
        const ir = it as Rec
        if (ir['type'] !== 'message') continue
        total = sumUsage(ir)
      }
    }
    // ⚠️ Treat all-missing (= 0) as "unknown" and keep searching
    if (total > 0) return total
  }
  return undefined
}

/** ★ Sum the three input-side counts (`input_tokens` excludes cached tokens) */
function sumUsage(u: Rec): number {
  return ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
    .map((k) => (typeof u[k] === 'number' && Number.isFinite(u[k]) ? (u[k] as number) : 0))
    .reduce((a, b) => a + b, 0)
}

/** Return the content of the last system record whose subtype matches */
function lastSystemContent(records: Rec[], subtype: string): string | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!
    if (r['type'] === 'system' && r['subtype'] === subtype) {
      const v = str(r['content'])
      if (v) return v
    }
  }
  return undefined
}

/** A pure function with no file I/O. The target of unit tests. */
export function derive({ sessionId, headRecords, tailRecords }: DeriveInput): Derived {
  // cwd / gitBranch / version are on almost every message record
  let cwd: string | undefined
  let gitBranch: string | undefined
  let cliVersion: string | undefined
  for (const r of [...tailRecords, ...headRecords]) {
    cwd ??= str(r['cwd'])
    gitBranch ??= str(r['gitBranch'])
    cliVersion ??= str(r['version'])
    if (cwd && gitBranch && cliVersion) break
  }

  const permissionMode =
    lastOf(tailRecords, 'permission-mode', 'permissionMode') ??
    lastOf(headRecords, 'permission-mode', 'permissionMode')

  // ⚠️ Take "last activity" only from conversation records. Do not include system cleanup.
  //
  //    Measured (2026-08-11):
  //      12:40:29  Stop hook
  //      12:40:30  system/stop_hook_summary, turn_duration   ← 0.5s later
  //      12:43:36  system/away_summary                       ← ★3 minutes later
  //
  //    Counting system records makes the hook look "stale" once the summary is written,
  //    and the list's "done" / "awaiting approval" disappears (we actually shipped that bug).
  let lastActivity: string | undefined
  for (let i = tailRecords.length - 1; i >= 0 && !lastActivity; i--) {
    const r = tailRecords[i]!
    const t = r['type']
    if (t !== 'user' && t !== 'assistant' && t !== 'attachment') continue
    lastActivity = str(r['timestamp'])
  }

  // Title: custom > ai > first user message > fallback
  const custom =
    lastOf(tailRecords, 'custom-title', 'customTitle') ??
    lastOf(headRecords, 'custom-title', 'customTitle')
  const ai = lastOf(tailRecords, 'ai-title', 'aiTitle') ?? lastOf(headRecords, 'ai-title', 'aiTitle')
  const prompt = firstPromptTitle(headRecords) ?? firstPromptTitle(tailRecords)

  let title: string
  let titleSource: TitleSource
  if (custom) {
    title = clip(custom)
    titleSource = 'custom'
  } else if (ai) {
    title = clip(ai)
    titleSource = 'ai'
  } else if (prompt) {
    title = clip(prompt)
    titleSource = 'prompt'
  } else {
    title = cwd ? basename(cwd) : sessionId.slice(0, 8)
    titleSource = 'fallback'
  }

  const away =
    lastSystemContent(tailRecords, 'away_summary') ?? lastSystemContent(headRecords, 'away_summary')

  return {
    cwd,
    gitBranch,
    cliVersion,
    permissionMode,
    lastActivity,
    title,
    titleSource,
    awaySummary: away ? clipTo(away, 160) : undefined,
    // ⚠️ Look only at the tail (usage in the first 8KB is the value "right after start", not the current amount)
    contextTokens: contextTokensOf(tailRecords),
  }
}

/** Open a transcript file, read only its head and tail, and return its metadata. */
export async function readTranscriptMeta(file: string): Promise<TranscriptMeta> {
  const sessionId = basename(file).replace(/\.jsonl$/, '')
  const fh = await open(file, 'r')
  try {
    const st = await fh.stat()
    const size = st.size

    const headLen = Math.min(HEAD_BYTES, size)
    const headBuf = Buffer.alloc(headLen)
    if (headLen > 0) await fh.read(headBuf, 0, headLen, 0)
    const headTruncated = size > headLen
    const headRecords = parseLines(headBuf.toString('utf8'), false, headTruncated)

    let tailRecords: Rec[] = headRecords
    if (size > headLen) {
      const tailLen = Math.min(TAIL_BYTES, size)
      const start = size - tailLen
      const tailBuf = Buffer.alloc(tailLen)
      await fh.read(tailBuf, 0, tailLen, start)
      tailRecords = parseLines(tailBuf.toString('utf8'), start > 0, false)
    }

    const d = derive({ sessionId, headRecords, tailRecords })
    return {
      sessionId,
      file,
      bytes: size,
      mtimeMs: st.mtimeMs,
      ...d,
    }
  } finally {
    await fh.close()
  }
}
