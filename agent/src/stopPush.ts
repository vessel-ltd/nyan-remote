// Sends the turn-end (`Stop`) notification "once the state has settled".
//
// ★★ Why delay it (measured 2026-08-16):
//
//   `Stop` only means "Claude's turn ended", **not that the work is done**.
//   If a background Bash (`codex exec`) or a sub-agent is running, it is not done yet.
//   But **when the hook arrives, the state has not been written yet**:
//
//     05:35:44.120  Stop hook received
//     05:35:44.777  CLI wrote status=shell   ← 657ms later
//
//   → Looking right away **misses it every time**. Wait a little, then read again.
//
// ⚠️ Only **sending** waits. The hook response is returned first
//    (`hooks/notify.sh` curls synchronously, so waiting would slow the end of every turn).
//
// ⚠️⚠️ **If the agent exits while waiting, the notification is lost** (2026-08-16 external review, high #1).
//    Notifications are this tool's reason to exist, so **always flush them on exit** (`flushStopPushes`).
//    ⚠️ A crash (SIGKILL, power loss) cannot be saved. It is stated that **a 1.5s window remains**.
//    A persistent queue conflicts with §7.3 (no send queue on the server), so it is not used.
//
// ⚠️ This layer owns only "when to send". **What to send is decided by the caller** (for testability).

import type { HookEvent } from '../../shared/types.ts'

/** Result of re-reading the state. ★ Distinguishes "could not read" from "finished" */
export type StatusProbe =
  // the session is alive (status is the raw value).
  // ★ waitingFor is set **only when the CLI says waiting** (so no reason is invented)
  | { kind: 'live'; status?: string; waitingFor?: string }
  | { kind: 'gone' } // no process ⇒ the background Bash died with it
  | { kind: 'unknown' } // ★ could not read / account unknown (must not jump to a conclusion)

export interface StopPushDeps {
  /** Re-read the state right before sending */
  probe: (event: HookEvent) => Promise<StatusProbe>
  /** Actually send (the text is decided by the caller) */
  send: (event: HookEvent, probe: StatusProbe) => Promise<void>
  /** Wait time (ms) */
  delayMs: number
  /** Timers. Replaced from tests */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

interface Waiting {
  event: HookEvent
  timer: unknown
}

/** Only one pending item per session. ⚠️ Items without a key (sessionId unknown) are not delayed */
const waiting = new Map<string, Waiting>()

/**
 * Schedules a turn-end notification.
 *
 * ★ If `Stop` for the same session arrives again, **the previous schedule is dropped**
 *   (the hook can fire multiple times; without dropping, `renotify: true` makes it **ring twice**
 *    / 2026-08-16 external review, medium #5).
 *
 * @returns whether it was scheduled (false = left to the caller to send immediately)
 */
export function scheduleStopPush(event: HookEvent, deps: StopPushDeps): boolean {
  const key = event.sessionId
  // ⚠️ without a sessionId duplicates cannot be detected. Return to the caller without delay (= send now)
  if (!key) return false

  const prev = waiting.get(key)
  if (prev) clearTimerOf(deps, prev.timer)

  const fire = () => {
    waiting.delete(key)
    void run(event, deps)
  }
  const timer = (deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms)))(fire, deps.delayMs)
  // ⚠️ no unref. **It is fine to hold up process exit** (waiting beats dropping a notification).
  //    The exit path is flushed explicitly by `flushStopPushes`
  waiting.set(key, { event, timer })
  return true
}

async function run(event: HookEvent, deps: StopPushDeps): Promise<void> {
  let probe: StatusProbe = { kind: 'unknown' }
  try {
    probe = await deps.probe(event)
  } catch {
    // ⚠️ do not treat "could not read" as "finished" (no fail-open / CLAUDE.md)
    probe = { kind: 'unknown' }
  }
  await deps.send(event, probe)
}

/**
 * ★★ Sends **all pending notifications now** (called on exit).
 *
 * ⚠️ Exiting without waiting here loses notifications. Always call it from shutdown in `index.ts`.
 */
export async function flushStopPushes(deps: StopPushDeps): Promise<number> {
  const pending = [...waiting.values()]
  waiting.clear()
  for (const w of pending) clearTimerOf(deps, w.timer)
  // ⚠️ keep sending the rest even if one fails
  await Promise.all(pending.map((w) => run(w.event, deps).catch(() => {})))
  return pending.length
}

/** ⚠️ Also accepts stand-in timers, so it is typed `unknown` (only real ones go to clearTimeout) */
function clearTimerOf(deps: StopPushDeps, timer: unknown): void {
  if (deps.clearTimer) {
    deps.clearTimer(timer)
    return
  }
  clearTimeout(timer as ReturnType<typeof setTimeout>)
}

/** Number currently pending (for logs and tests) */
export function pendingStopPushes(): number {
  return waiting.size
}
