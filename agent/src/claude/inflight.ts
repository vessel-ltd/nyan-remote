// Read "the body that has not been written to the transcript yet".
//
// ★★ Why this is needed (measured 2026-08-21): the CLI writes the transcript in batches, and
//    **streaming stops while waiting for a human answer** (0 bytes for 93 seconds → +10KB the moment it is answered).
//    ⇒ The approval card's "explanation just before" is structurally always missing.
//    We read here what the `MessageDisplay` hook (`hooks/message-display.sh`) intercepted and left.
//
// ⚠️ When unreadable or absent, **undefined** (fail-closed). **Never fabricate content.**

import { open, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { clipToGrapheme } from './interaction.ts'
import { stateDir } from '../state.ts'

export { alreadyInTranscript } from '../../../shared/types.ts'

export interface Inflight {
  /** The body currently streaming (deltas joined in order) */
  text: string
  /** Whether the last delta was `final` (= the message is complete) */
  final: boolean
  /** The file's modification time */
  at: string
  /** Whether it was clipped at the limit */
  clipped?: boolean
  /**
   * ★ The transcript path the hook passed us.
   * ⚠️ Kept so the account can be determined even for **sessions without a transcript yet**
   *    (the case where the first turn goes into awaiting approval) (2026-08-21 codex, high #2).
   */
  transcriptPath?: string
}

/**
 * Read limit. ⚠️ **Read from the start** (2026-08-21 codex, medium #4).
 *
 * We used to read only the last 256KB, so **a large first record dropped the head of the body**,
 * and it was not even marked `clipped`, so the display "did not show that the head was missing".
 * ⇒ We show the first 8000 characters, so **reading from the start** is the natural choice.
 * ⚠️ Files larger than the limit are **given up entirely** (no guarantee we have the head / fail-closed).
 */
export const INFLIGHT_MAX_BYTES = 1024 * 1024
/** Display limit. Matches the transcript side (TEXT_MAX) */
export const INFLIGHT_MAX_CHARS = 8000
/**
 * Cleanup limit. ⚠️ Approvals can wait **24 hours** (the hook timeout). mtime does not advance meanwhile, so
 * with 24 hours we **could delete the body of an approval that is still waiting** (2026-08-21 `/code-review`, low #8).
 * ⚠️ Also, "sessions with not a single transcript line" do not appear in the live list, so leave margin.
 */
export const INFLIGHT_MAX_AGE_MS = 48 * 60 * 60 * 1000

export function inflightDir(): string {
  return join(stateDir(), 'inflight')
}

/**
 * ★★ Only accept the shape of a session ID. **Because a URL-derived value is used directly in a path**.
 * ⚠️ The hook side (bash) does the same check. Guard on both sides.
 */
export function isSessionId(raw: string): boolean {
  return /^[0-9a-fA-F-]{36}$/.test(raw)
}

export async function readInflight(sessionId: string): Promise<Inflight | undefined> {
  if (!isSessionId(sessionId)) return undefined
  try {
    const fh = await open(join(inflightDir(), `${sessionId}.jsonl`), 'r')
    try {
      const st = await fh.stat()
      if (st.size === 0) return undefined
      // ★★ **Do not give up even if it is large** (2026-08-21, both reviews). We show the first 8000 characters, so
      //    **reading the first 1MB and reporting `clipped`** is correct.
      //    ⚠️ We used to fall back to `undefined`, so **the moment a long line came, the whole body vanished**,
      //      and **with no signal at all** (= the "silently stops showing" shape).
      const readLen = Math.min(INFLIGHT_MAX_BYTES, st.size)
      const partial = st.size > readLen
      const buf = Buffer.alloc(readLen)
      // ⚠️ **Use only what was actually read** (2026-08-21 `/code-review`, low #5). `Buffer.alloc` zero-fills, so
      //    if the hook truncates between stat and read, **the rest is stringified as NULs and
      //    the newest delta breaks and is lost**.
      const { bytesRead } = await fh.read(buf, 0, readLen, 0)
      if (bytesRead === 0) return undefined
      const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n')
      let text = ''
      let final = false
      let mid: string | undefined
      let sawMid = false
      let nextIndex = 0
      let transcriptPath: string | undefined
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li]!
        if (!line.trim()) continue
        let rec: Record<string, unknown>
        try {
          rec = JSON.parse(line) as Record<string, unknown>
        } catch {
          // ⚠️⚠️ **Never skip a broken line and carry on** (2026-08-21 codex, high #3).
          //    A broken line in the middle means showing **an explanation with just that part missing**
          //    (e.g. only the sentence "do not run this" drops out).
          //    ★ Only the **last line** is tolerated (mid-write; it will be there on the next read).
          if (li === lines.length - 1 || lines.slice(li + 1).every((l) => !l.trim())) break
          return undefined
        }
        {
          // ★★ **When the message changes, discard and start counting again** (2026-08-21 `/code-review`, medium #4).
          //    Truncation relies on the `index: 0` write, so **if that one write is lost,
          //    the new body piles up as a continuation of the old one**, and the head stays old.
          //    Then `alreadyInTranscript` judges it "already there" and
          //    **the explanation right before the approval vanishes entirely** (a failure of this feature's very purpose).
          //    ⇒ Even if the file mixes several messages, use **only the last one**.
          // ★★ **Check that the line really belongs to this session** (same review, medium #6).
          //    ⚠️ If the hook's regex ever picks up another (nested) `session_id`,
          //      it is rejected here. **Do not rely on key order.**
          if (rec['session_id'] !== sessionId) return undefined
          if (typeof rec['transcript_path'] === 'string') transcriptPath = rec['transcript_path']
          const recMid = typeof rec['message_id'] === 'string' ? rec['message_id'] : undefined
          if (recMid !== undefined) {
            sawMid = true
            if (recMid !== mid) {
              mid = recMid
              text = ''
              final = false
              nextIndex = 0
            }
          } else if (sawMid) {
            // Lines with and without the marker are mixed = the format changed. **Discard the old part**
            text = ''
            final = false
            sawMid = false
            nextIndex = 0
          }
          // ★★ **If an index is skipped, give up entirely** (same review, high #3).
          //    An explanation with a gap is not "read" but **a lie**, so do not show it.
          const idx = rec['index']
          if (typeof idx !== 'number' || !Number.isInteger(idx)) return undefined
          // ★ Do **not discard** when the same index comes twice (2026-08-21 `/code-review`, low #3).
          //   Duplicates **lose nothing** (unlike gaps). ⚠️ It does not happen with the current CLI, but
          //   this is an undocumented interface, so do not turn "slight overlap" into "nothing shown"
          if (idx === nextIndex - 1) continue
          // ⚠️ The first is not index 0 (= head missing) / a gap in between → show nothing at all
          if (idx !== nextIndex) return undefined
          nextIndex = idx + 1
          if (typeof rec['delta'] === 'string') text += rec['delta']
          final = rec['final'] === true
        }
      }
      if (!text.trim()) return undefined
      const clipped = text.length > INFLIGHT_MAX_CHARS || partial
      return {
        // ⚠️ **Cut at a grapheme boundary** (2026-08-21 `/code-review`, low #9).
        //    A naive cut splits emoji, puts a lone surrogate into the JSON, and U+FFFD appears on screen
        text:
          text.length > INFLIGHT_MAX_CHARS
            ? `${clipToGrapheme(text, INFLIGHT_MAX_CHARS - 1)}…`
            : clipped
              ? `${text}…`
              : text,
        // ⚠️ If only part was read, do not claim it is "complete"
        final: partial ? false : final,
        ...(clipped ? { clipped } : {}),
        ...(transcriptPath ? { transcriptPath } : {}),
        at: st.mtime.toISOString(),
      }
    } finally {
      await fh.close()
    }
  } catch {
    // Absent (hook not installed) / unreadable → **show nothing**
    return undefined
  }
}

/**
 * Discard files that are no longer needed.
 *
 * ⚠️⚠️ **Never delete files of live sessions** (approvals can wait 24 hours, so
 *    deleting means "the body while waiting" vanishes = this feature's purpose vanishes).
 */
export async function sweepInflight(live: Set<string>, now = Date.now()): Promise<number> {
  let removed = 0
  try {
    for (const name of await readdir(inflightDir())) {
      if (!name.endsWith('.jsonl')) continue
      const id = name.slice(0, -6)
      if (live.has(id)) continue
      try {
        const st = await stat(join(inflightDir(), name))
        if (now - st.mtimeMs < INFLIGHT_MAX_AGE_MS) continue
        await unlink(join(inflightDir(), name))
        removed++
      } catch {
        // Failing to delete is not fatal
      }
    }
  } catch {
    // No directory (hook not installed) = do nothing
  }
  return removed
}
