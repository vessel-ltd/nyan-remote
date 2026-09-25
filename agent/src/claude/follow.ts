// ★★ Watcher that signals thread follow-ups via notifications (2026-09-23 / HANDOFF 5.0-cf).
//
// ⚠️⚠️ Why: while a thread was open, the PWA asked for the rest of the transcript **every 3 seconds** (over relay
//    that is 2 messages per poll, request and response ⇒ 2,400/hour just by looking). Messages reaching the relay room
//    count toward the Workers daily limit (a 91% warning on 9/22).
//    ⇒ Signal only when something grew. Measured (3 days on machine A): even while responding, "coalescing within 0.5s"
//      gives a median of 4 per minute, 10 at the 90th percentile ⇒ sending only to devices that are watching: 40/min → about 14/min.
//
// ★ Only **followed sessions** are watched (`followedSessions` in `events.ts`).
//   ⚠️ Only **size and mtime** are checked (contents are not read = cheap even for a 14MB transcript / CLAUDE.md §5).
//   ⚠️⚠️ **Two files are watched**: the transcript, and the in-progress text (`inflight/<id>.jsonl`).
//      The latter **changes even when the transcript does not grow by a single byte**, e.g. while waiting for approval (Thread's `setInflight`).
// ★ Checked every second = at most one notification per second even under continuous writes (coalesces naturally).
// ★★ **The first tick also notifies** (2026-09-23 / codex round 16, medium #2). ⚠️ It used to "only remember", so anything
//    written in the ~1 second between the PWA finishing its `hello` fetch and the first tick **did not show until the next
//    write or the 60-second fallback**. ⇒ It just costs one extra fetch right after opening (cheaper than missing data).

import { stat as fsStat } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '../config.ts'
import { followedSessions, notifyFollowers } from '../events.ts'
import { discoverConfigDirs } from './configDirs.ts'
import { inflightDir } from './inflight.ts'
import { findTranscript } from './sessions.ts'

export interface FileSig {
  size: number
  mtimeMs: number
  ino: number
}

export interface FollowWatchDeps {
  /** Sessions being followed */
  sessions: () => Iterable<string>
  /** Path of that session's transcript (⚠️ undefined if it does not exist yet = look again next tick) */
  locateTranscript: (sessionId: string) => Promise<string | undefined>
  /** Path of the in-progress text (⚠️ may not exist) */
  inflightPath: (sessionId: string) => string
  /** ⚠️ undefined if missing (does not throw) */
  stat: (path: string) => Promise<FileSig | undefined>
  notify: (sessionId: string) => void
}

function sigText(s: FileSig | undefined): string {
  return s ? `${s.size}:${s.mtimeMs}:${s.ino}` : '-'
}

/**
 * ★ One watcher tick. Runs on **pure dependencies only** (the caller / tests drive the timer).
 * ⚠️ Memory of sessions no longer followed is dropped (do not accumulate).
 */
export function createFollowWatch(deps: FollowWatchDeps): { tick(): Promise<void> } {
  const last = new Map<string, string>()
  const where = new Map<string, string>()
  let running = false
  return {
    async tick() {
      // ⚠️ Do not overlap if the previous tick has not finished (do not notify the same session twice on a slow disk)
      if (running) return
      running = true
      try {
        const now = new Set(deps.sessions())
        for (const id of [...last.keys()]) if (!now.has(id)) last.delete(id)
        for (const id of [...where.keys()]) if (!now.has(id)) where.delete(id)
        for (const id of now) {
          let path = where.get(id)
          if (path === undefined) {
            path = await deps.locateTranscript(id)
            if (path !== undefined) where.set(id, path)
          }
          const t = path === undefined ? undefined : await deps.stat(path)
          // ⚠️ If the transcript can no longer be found (deleted / moved), look it up again next tick
          if (path !== undefined && t === undefined) where.delete(id)
          const sig = `${sigText(t)}|${sigText(await deps.stat(deps.inflightPath(id)))}`
          const prev = last.get(id)
          last.set(id, sig)
          if (prev !== sig) deps.notify(id)
        }
      } finally {
        running = false
      }
    },
  }
}

// ── Real wiring (timer, files, notifications) ────────────────────────────────────

/** ★ Watcher interval (⚠️ at most one notification per second = continuous writes coalesce naturally) */
export const FOLLOW_TICK_MS = 1000

let timer: NodeJS.Timeout | null = null
const live = createFollowWatch({
  sessions: followedSessions,
  locateTranscript: async (id) => {
    const dirs = await discoverConfigDirs(config().configDirs)
    return (await findTranscript(dirs, id))?.path
  },
  inflightPath: (id) => join(inflightDir(), `${id}.jsonl`),
  stat: async (p) => {
    try {
      const s = await fsStat(p)
      return { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino }
    } catch {
      return undefined
    }
  },
  notify: (id) => void notifyFollowers(id),
})

/**
 * ★ Start the watcher when a follow subscription arrives. ⚠️ **Stops** once no follows remain (does not keep spinning).
 * ⚠️ `unref` (do not let the watcher keep the agent from exiting).
 */
export function ensureFollowWatch(): void {
  if (timer) return
  timer = setInterval(() => {
    if (followedSessions().size === 0) {
      clearInterval(timer!)
      timer = null
      return
    }
    void live.tick().catch(() => undefined)
  }, FOLLOW_TICK_MS)
  timer.unref()
}
