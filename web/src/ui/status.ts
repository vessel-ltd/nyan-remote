import {
  statusLabel,
  waitingReason,
  type SessionStatus,
  type SessionSummary,
} from '../../../shared/types.ts'
import { currentLang, localizeNotificationBody } from '../../../shared/i18n.ts'

/**
 * ★ Rendered in the screen language (⚠️ `statusLabel` is unchanged = translated from the notification vocabulary table **right before display**)
 */
function loc(label: string): string {
  return localizeNotificationBody(label, currentLang())
}

/**
 * How state is shown. Colour and text map one-to-one.
 *   working      green (blinking)  claude agents --json says busy
 *   waiting      orange            Notification hook (approval / waiting for input)
 *   error        red               StopFailure hook
 *   done         blue              Stop hook (turn ended / waiting for input)
 *   idle         blue (faint)      process is alive
 *   ended        outline only      no process (history)
 */
export function statusView(
  status: SessionStatus,
  live: boolean,
  /**
   * ★ Reason for "needs attention" (the CLI's `waitingFor`; 2026-08-18).
   * ⚠️ Appended in parentheses only when present. **When absent, just "needs attention" as before**
   *    (we do not fabricate a reason)
   * ⚠️⚠️ **No `?`** (same-day codex review, medium #4). Making it optional means
   *    **dropping it at the call site still type-checks**, and the reason silently vanishes from the screen.
   */
  waitingFor: string | undefined,
): { label: string; cls: string } | null {
  // ⚠️ Text comes from `statusLabel` / `waitingReason` in `shared/types.ts`.
  //    Writing it here directly makes it **disagree with notifications (agent side)** (hit on 2026-08-16).
  switch (status) {
    case 'waiting': {
      const why = waitingReason(waitingFor)
      return { label: loc(why ? `${statusLabel(status)!}（${why}）` : statusLabel(status)!), cls: status }
    }
    case 'working':
    case 'error':
    case 'done':
      return { label: loc(statusLabel(status)!), cls: status }
    // ★ A background Bash (codex exec, a long test) is running. **Not done**
    case 'background':
      return { label: loc(statusLabel(status)!), cls: 'background' }
    case 'rate-limited':
      return { label: loc(statusLabel(status)!), cls: 'error' }
    default:
      // "Starting" carries little information, so show it only in the active group; history has the time
      return live ? { label: loc(statusLabel('idle')!), cls: 'idle' } : null
  }
}

/**
 * Whether the cat **runs** (or stands still). ⚠️ Not "whether it is shown" (a stopped cat is shown).
 *
 * ⚠️⚠️ **Do not copy the condition into callers** (if `Composer` decides on its own,
 *    the state and the picture disagree = it runs while stopped).
 * ⚠️ Only `working` runs: `background` is a mark meaning "no reply for a while",
 *    so running would make it indistinguishable from `working` (same reason `.dot.background` does not pulse).
 * ⚠️ It appears in **one place only**, above the input box (`Composer.tsx`). It used to be in list rows and the bar too,
 *    reverted on 2026-08-28. ⇒ **Do not revert this description to "three places use it"** (codex low #8).
 */
export function showNyan(cls: string): boolean {
  return cls === 'working'
}

/**
 * ★ The one line above the input box (where the CLI shows `✢ Cooking…`). 2026-08-28.
 *
 * ★★ **Shown in one place only** (user's choice on 2026-08-28). **Not** in list rows or the bar
 *    = both restored to their original look. ⚠️ **Do not add more** (the same picture moving in three places
 *    breaks "where should I look", and the list gains a rect per row).
 *
 * ★★ **The line is shown even when stopped. The cat stands still** (`running: false`).
 *    ⚠️⚠️ This is not taste but **also a height constraint**: `--pad-h` **always** reserves
 *       room for this line (`--busy-h`). Toggling it would waste the reserved room,
 *       so a still picture fills it.
 *    ⚠️ The run/stop decision is `showNyan`, in one place (do not copy it into `Composer`).
 *
 * ⚠️ Text and colour come from `statusView` (derived from `statusLabel` in `shared/types.ts`).
 *    Do **not invent other words** like "running" here.
 * ⚠️ When `statusView` is `null` (history of an ended session), omit the whole line
 *    = **do not default to "working"** (do not show a running cat for a target that cannot receive).
 */
export function composerBusy(
  /** ⚠️ Pass **the same inputs** as the bar (`ThreadBar`) (extracting only some is a source of disagreement) */
  session: SessionSummary | undefined,
): { label: string; cls: string; running: boolean } | null {
  if (!session) return null
  const view = statusView(session.status, session.live, session.waitingFor)
  if (!view) return null
  return {
    label: view.label,
    cls: view.cls,
    /**
     * ★★ **Do not run for sessions that are not alive** (2026-08-28 codex medium #1).
     *
     * ⚠️⚠️ The current agent's `resolveStatus` does `if (isLive && raw === 'busy')`, so
     *    `working` with `live: false` is **never produced**. But "the producer does that, so
     *    the receiver need not check" is exactly the inference CLAUDE.md forbids
     *    (**inferring meaning at the receiver from the stored shape**).
     * ⇒ **Check on the receiving side.** A cat running over an ended record is "a picture that lies about state",
     *    and the worst kind, since the target cannot receive. Fail closed (when in doubt, stop).
     */
    running: session.live && showNyan(view.cls),
  }
}

/**
 * ★ Wording that **does not misattribute the cause** when "it cannot be answered from the phone" (2026-08-18).
 *
 * ⚠️ The original text **asserted the cause**: "the return path was lost to an agent restart, timeout, etc.".
 *    But CLI dialogs include **more than approvals** (`input needed` /
 *    `sandbox request` / `dialog open` / `goal proposal`). Those
 *    **never reach the approval hook at all**, so "the return path was lost" is false
 *    (same-day /code-review finding).
 *
 * ⚠️⚠️ **"Reason unknown" is split out as a third case** (same-day codex review, medium #3).
 *    Old CLIs do not write `waitingFor`, so it **asserted "approval" with no reason**.
 *    When unknown, say it is unknown (same idea as no fail-open).
 */
export type WaitExplanation =
  /** An approval prompt. The "nowhere to answer" explanation is correct */
  | { kind: 'permission' }
  /** A non-approval dialog. A kind that never reaches us */
  | { kind: 'other'; label: string }
  /** The CLI gave no reason (old version / stale record). Do not assert */
  | { kind: 'unknown' }

export function explainWait(
  waitingFor: string | undefined,
  /**
   * ★ The most recent hook the state was based on (`SessionSummary.lastEvent`). Added 2026-08-18.
   *
   * ⚠️⚠️ **The most common case was shown with the least informative text.**
   *    A real case stuck at "needs attention" for 21 minutes (machine B / `git-push fix`) was
   *    **an approval mark killed by an agent restart, leaving only the `Notification` memory**.
   *    Here the CLI itself is not waiting, so there is no `waitingFor`, and the check above
   *    made it `unknown` ("we don't know what it is waiting for").
   *    But `resolveStatus` **attaches `lastEvent: 'Notification'` only in that shape**
   *    (from a CLI dialog, `lastEvent` is not attached / `agent/src/claude/sessions.ts`).
   *    ⇒ It is **a value the implementation distinguishes, not a guess**, so we can say "approval".
   *
   * ⚠️ **Not optional** (same reason as same-day codex review, medium #4). If it could be omitted,
   *    dropping it at the call site would type-check and the explanation would silently revert to the thin one.
   */
  lastEvent: string | undefined,
): WaitExplanation {
  const label = waitingReason(waitingFor)
  if (label) {
    if (waitingFor?.trim() === 'permission prompt') return { kind: 'permission' }
    return { kind: 'other', label: loc(label) }
  }
  // ★ If we know it comes from an approval, say so (`PermissionRequest` is the live-mark shape, but
  //   it can arrive while hidden by `quiet`, so treat it the same)
  if (lastEvent === 'Notification' || lastEvent === 'PermissionRequest') {
    return { kind: 'permission' }
  }
  return { kind: 'unknown' }
}
