// Notice the moment a live session's state changes (= make "responding" immediate).
//
// ★ Why watching instead of a hook (decided after measuring on 2026-08-13):
//
//   Only "responding" lagged by up to 15 seconds, because no hook fires at the start of a turn.
//   Adding a `UserPromptSubmit` hook would make it immediate, but **it sits in series on the input path**.
//   And what we measured:
//
//     On WSL, **connecting to a dead 127.0.0.1 port does not fail immediately; it stays silent for 8+ seconds**
//     (localhost forwarding hands it to the Windows side and nobody answers)
//
//   → While the agent is stopped (we stop it during development), **input freezes on every keystroke**.
//     That violates CLAUDE.md §1.5 "do not break everyday work", so it was rejected.
//
// ★ Instead, watch `<CLAUDE_CONFIG_DIR>/sessions/`. Measured properties:
//
//   - `sessions/<pid>.json` **turns `busy` as soon as the turn starts** (the data is already fresh)
//   - **It is never written during a turn** (0 write events in 15 seconds)
//     → Twice per turn (start and end). Same frequency as the existing Stop hook, so no extra traffic
//
// ⚠️ **Never watch the transcript.** It is written continuously while responding, so it would certainly storm.
//    Watch only `sessions/` (small, written only on transitions).
//
// ⚠️ This mechanism only changes "**when to re-fetch**"; it does not change the status decision at all
//    (`resolveStatus` is untouched). If it breaks, it either "re-fetches too often" or
//    "does not re-fetch (= falls back to 15-second polling)"; **the status is never wrong**.

import { readdir, readFile } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { ConfigDir } from './configDirs.ts'
import { invalidateLiveSessions } from './sessionIndex.ts'

/** Coalesce bursts of writes into one */
const DEBOUNCE_MS = 300

export interface SessionWatch {
  close(): void
  /** Directories actually being watched */
  watched: string[]
  /** Directories that could not be watched (missing, no permission, etc.). These are left to 15-second polling */
  failed: string[]
}

/** pid → status from `sessions/<pid>.json`. Decisions are made only from diffs of this snapshot */
export type StatusMap = Map<string, string>

/**
 * Whether the snapshot changed.
 * ⚠️ Needed so we notify "only on change". Firing just because a file was touched would storm
 *    if some other CLI version wrote it frequently (a safety net).
 */
export function differs(a: StatusMap, b: StatusMap): boolean {
  if (a.size !== b.size) return true
  for (const [k, v] of a) {
    if (b.get(k) !== v) return true
  }
  return false
}

/**
 * Read the account's `sessions/` and build a pid → status snapshot.
 * ⚠️ Silently skip broken or vanished files (do not block startup).
 */
export async function readStatuses(sessionsDir: string): Promise<StatusMap> {
  const out: StatusMap = new Map()
  let names: string[]
  try {
    names = await readdir(sessionsDir)
  } catch {
    return out
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const text = await readFile(join(sessionsDir, name), 'utf8')
      const o = JSON.parse(text) as Record<string, unknown>
      const status = typeof o['status'] === 'string' ? o['status'] : '?'
      // ★ Also pick up changes in the reason (`waitingFor`) (pointed out in the 2026-08-18 /code-review).
      //   The status can stay `waiting` while **only the reason changes**
      //   (an input dialog closes and an approval prompt opens, etc.). We show it on screen, so
      //   without this **the stale reason stays until the next poll (15 seconds)**.
      //
      // ⚠️ **Only look at it when `waiting`** (same day's codex review, low #5). The API only includes a reason
      //    then, so picking it up otherwise **sends a signal although the screen does not change**
      const waitingFor = typeof o['waitingFor'] === 'string' ? o['waitingFor'] : ''
      out.set(name, status === 'waiting' && waitingFor ? `${status}/${waitingFor}` : status)
    } catch {
      // Mid-write or just deleted. Pick it up next time
    }
  }
  return out
}

/**
 * Start watching.
 *
 * @param onChange called when the status snapshot changes (to send `sessions-changed`)
 *
 * ⚠️⚠️ **Do not throw even if nothing can be watched.** Throwing here stops the agent from starting.
 *    If we cannot watch, we just fall back to "15-second polling as before", with no real harm.
 */
export function startSessionWatch(
  dirs: ConfigDir[],
  onChange: () => void,
  opts: { debounceMs?: number } = {},
): SessionWatch {
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS
  const watchers: FSWatcher[] = []
  const watched: string[] = []
  const failed: string[] = []
  const last = new Map<string, StatusMap>()
  let timer: NodeJS.Timeout | undefined
  let closed = false
  /**
   * Whether a change came in while building the initial snapshot.
   *
   * ⚠️ Seeding is async, so it can **swallow an `idle → busy` right after the watcher is set up**
   *   (pointed out in the 2026-08-13 external review). The seed stores busy as the initial value,
   *   the subsequent diff sees "no change", and no immediate notification goes out (it waits for 15-second polling).
   *   → Remember events that arrive during seeding and **always check once more after seeding**.
   */
  let seeding = true
  let dirtyWhileSeeding = false

  const check = async (fire: boolean): Promise<void> => {
    if (closed) return
    let changed = false
    for (const sessionsDir of watched) {
      const next = await readStatuses(sessionsDir)
      if (differs(last.get(sessionsDir) ?? new Map(), next)) changed = true
      last.set(sessionsDir, next)
    }
    // ⚠️ The first pass at startup only builds the snapshot. Firing here would always make it look
    //    like "every session changed" right after startup and trigger a wasted re-fetch
    if (changed && fire && !closed) {
      // ★★ Drop the 2-second cache before signalling (2026-08-18 codex review, medium #1).
      //   Otherwise the re-fetched `/sessions` returns **values up to 2 seconds old**,
      //   and since the watcher's snapshot is already new, **the stale view stays until the next 15-second poll**
      invalidateLiveSessions()
      onChange()
    }
  }

  const schedule = (): void => {
    if (closed) return
    // Changes arriving during seeding are always looked at after seeding (swallowing them loses the immediate notification)
    if (seeding) dirtyWhileSeeding = true
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void check(true)
    }, debounceMs)
    // ⚠️ Do not keep the process alive (forgetting unref means it will not exit on SIGTERM)
    timer.unref?.()
  }

  for (const dir of dirs) {
    const sessionsDir = join(dir.dir, 'sessions')
    try {
      const w = watch(sessionsDir, () => schedule())
      // ⚠️ Do not crash on errors while watching (directory removed, etc.)
      w.on('error', () => {})
      watchers.push(w)
      watched.push(sessionsDir)
    } catch {
      failed.push(sessionsDir)
    }
  }

  // Take the initial snapshot (so the first change is not mistaken for "everything changed").
  void check(false).then(() => {
    seeding = false
    if (!dirtyWhileSeeding || closed) return
    // ★ If a change came during seeding, **notify unconditionally**.
    //
    // ⚠️ Calling `check(true)` here is pointless. The seed has already put the new value (busy)
    //    into the snapshot, so no diff appears (I noticed this mistake while implementing).
    //    We cannot tell "before or after the seed's read", so lean toward re-fetching.
    //    The cost is only one extra fetch right after startup.
    invalidateLiveSessions()
    onChange()
  })

  return {
    close(): void {
      closed = true
      if (timer) clearTimeout(timer)
      for (const w of watchers) {
        try {
          w.close()
        } catch {
          // Keep shutting down even if one cannot be closed
        }
      }
    },
    watched,
    failed,
  }
}
