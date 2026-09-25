// ★★ How the thread follows new output (2026-09-23 / HANDOFF 5.0-cf). The decision lives in `.ts` (`.tsx` has no runtime tests).
// ⚠️ Different from `ui/follow.ts` (whether an arriving page may be applied = `followAction`).
//
// - Agents with the `log-follow` marker: **follow via notifications** (`Transport.followLog`) + a slow backup poll (60 s)
// - Agents without it (old): 3-second polling as before
// ⚠️ Why the backup is needed: notifications can be missed (e.g. while the relay line is being re-established).
//    ★ On re-establishing, a `hello` arrives, so fetch the rest then as well (`shouldPull`).

import type { AgentEvent, AgentFeature } from '../../../shared/types.ts'

export const LEGACY_POLL_MS = 3000
export const FOLLOW_FALLBACK_MS = 60_000

export function followPlan(features: readonly AgentFeature[] | undefined): { follow: boolean; pollMs: number } {
  return features?.includes('log-follow') === true
    ? { follow: true, pollMs: FOLLOW_FALLBACK_MS }
    : { follow: false, pollMs: LEGACY_POLL_MS }
}

/** ★ Whether this notification should trigger fetching the rest (⚠️ not for another session's notification) */
export function shouldPull(event: AgentEvent, sessionId: string): boolean {
  if (event.type === 'hello') return true
  return event.type === 'log-appended' && event.sessionId === sessionId
}

/**
 * ★★ Run fetches **without overlapping and without missing any**.
 * ⚠️⚠️ If the next signal arrives while one is running, run **once more after it finishes**.
 *    (The original 3-second polling "dropped it if running", but with notifications, the appends for the dropped signal
 *     **would not appear until the next signal** = the last few lines of a response look stuck)
 * ⚠️ No matter how many arrive, only one extra run happens (that one run fetches up to the latest).
 */
export function coalesce(run: () => Promise<void>): (() => void) & { stop(): void } {
  let running = false
  let again = false
  let stopped = false
  const go = (): void => {
    // ⚠️ Do not run after stopping (codex round 16, low #4: a "one more later" ran after cleanup)
    if (stopped) return
    if (running) {
      again = true
      return
    }
    running = true
    void run()
      .catch(() => undefined)
      .finally(() => {
        running = false
        // ★ When stopped, `stop()` has already cleared `again` (do not double-check here)
        if (again) {
          again = false
          go()
        }
      })
  }
  return Object.assign(go, {
    stop(): void {
      stopped = true
      again = false
    },
  })
}
