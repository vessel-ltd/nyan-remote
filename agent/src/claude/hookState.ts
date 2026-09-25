// Remember the most recent hooks per session. They are the basis of the list's status display.
//
// Why this is needed: `claude agents --json` only returns busy / idle.
// "Awaiting approval" and "abnormal exit" are only knowable from hooks.
//
// ⚠️ Keep them per kind. Keeping only "the last hook" lets the idle notice (Notification/idle)
//    that fires a minute after the turn ends overwrite Stop, and "done" disappears (we actually hit this).
//
// ⚠️ This is "derived state this machine keeps about its own sessions", so it does not violate §7.3's
//    "no shared state on the server side" (each machine is the authority for its own sessions).
//
// Persistence is just reading the tail of hooks.jsonl at startup. No dedicated state file is added.

import { open } from 'node:fs/promises'
import type { HookEvent } from '../../../shared/types.ts'
import { statePath } from '../state.ts'

/** Tail size of hooks.jsonl read at startup. About 150B per event, so a few hundred events */
const SEED_BYTES = 128 * 1024

export interface SessionHooks {
  /** End of a turn. Stop → done / StopFailure → abnormal exit */
  stop?: { event: 'Stop' | 'StopFailure'; at: string }
  /** Asking for approval (idle notices are not included) */
  permission?: { at: string }
}

const bySession = new Map<string, SessionHooks>()

/**
 * @param fromLog whether we are restoring from `hooks.jsonl` at startup.
 *
 * ★★ **Restoring does not bring back "asking for approval"** (hit on a real machine on 2026-08-18).
 *
 *   The answer card (the hook's HTTP connection) **dies with the process**. Restoring it
 *   gives "needs attention with no way to answer", and since it is only cleared when "last activity overtakes it",
 *   **it stays stuck for the whole run of an already-approved long-running tool** (measured 21 minutes / hookState.test.ts).
 *
 *   ⚠️ Dropping this does not hide real approvals:
 *     - while the dialog is open, **the CLI itself says `waiting`** (see the notes in sessions.ts)
 *     - if the hook is alive, the **card** (`hasPendingApproval`) takes effect first
 *   ⚠️ `stop` (done / abnormal exit) is **a fact that has finished**, so it may be restored (that is what this mechanism is for).
 */
function apply(event: HookEvent, fromLog = false): void {
  if (!event.sessionId) return
  const cur = bySession.get(event.sessionId) ?? {}
  if (event.event === 'Stop' || event.event === 'StopFailure') {
    cur.stop = { event: event.event, at: event.at }
  } else if (!fromLog && event.event === 'Notification' && event.notice === 'permission') {
    cur.permission = { at: event.at }
  }
  // Notification/idle (idle notice) does not change state, so it does not overwrite Stop
  bySession.set(event.sessionId, cur)
}

export function noteHook(event: HookEvent): void {
  apply(event)
}

export function hooksFor(sessionId: string): SessionHooks | undefined {
  return bySession.get(sessionId)
}

/**
 * Remove the basis for "awaiting approval".
 *
 * ⚠️ Why this is needed: `Notification/permission` only tells us "approval is being requested",
 *   **never that it has been answered**. Clearing has to wait until "last activity is newer than the hook" =
 *   **the tool's result is written**.
 *   So **from right after approving on the PC until the tool finishes, it stays "needs attention"**.
 *   With long commands (running tests, etc.) this lasts minutes, and it was actually reported as
 *   "the list says needs attention while it is working" (2026-08-13).
 *
 * → Once `permissionSweep` confirms "that tool has already run", remove the basis here.
 */
export function clearPermission(sessionId: string | undefined): boolean {
  if (!sessionId) return false
  const cur = bySession.get(sessionId)
  if (!cur?.permission) return false
  delete cur.permission
  return true
}

/** Restore from the tail of hooks.jsonl at startup (so a process restart does not lose state) */
export async function seedHookState(): Promise<number> {
  let fh
  try {
    fh = await open(statePath('hooks.jsonl'), 'r')
  } catch {
    return 0
  }
  try {
    const st = await fh.stat()
    const len = Math.min(SEED_BYTES, st.size)
    if (len === 0) return 0
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, st.size - len)
    const text = buf.toString('utf8')
    // When reading started mid-file, the first line may be broken, so drop it
    const lines = (st.size > len ? text.slice(text.indexOf('\n') + 1) : text).split('\n')
    let n = 0
    for (const line of lines) {
      const t = line.trim()
      if (!t) continue
      try {
        const o = JSON.parse(t) as HookEvent
        if (o.sessionId && typeof o.event === 'string' && typeof o.at === 'string') {
          // ⚠️ Do not drop the second argument. Dropping it revives "needs attention that cannot be answered"
          apply(o, true)
          n++
        }
      } catch {
        // Drop broken lines
      }
    }
    return n
  } finally {
    await fh.close()
  }
}
