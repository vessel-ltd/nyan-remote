// Decides how to tell the user, while they are looking at a thread, about a "waiting on you" that happened in **another thread**.
//
// ★★ Why this is needed (2026-08-18 user request):
//
//   Back on the list, "waiting on you" is always at the top (`order.ts`). But **while you are
//   inside a thread you see nothing**. Approvals can pile up unnoticed, and even when noticed
//   it takes 3 steps: "back to the list -> find it -> open it".
//
// ★ Why a **single FIFO line** rather than a bell + badge:
//   - `Thread` **always scrolls to the bottom** when `sessionId` changes (Thread.tsx initial load).
//     The approval card is at the bottom of the thread, so **one tap shows the approval** for free.
//     A bell always takes 2 taps: "open -> choose"
//   - A bare count like "3" does not say **which session on which machine** (with 2 machines this is required).
//     One line can show the name and the tool, **and the count too** (= nothing a badge offers is lost)
//
// ⚠️⚠️ **Do not mix "approvals you can answer" with "needs-attention you cannot answer".**
//    Our `waiting` has 3 sources (`resolveStatus` in `agent/src/claude/sessions.ts`):
//      1. a live card (`PermissionRequest`)          -> **answerable from the phone**
//      2. the CLI's own dialog (`raw === 'waiting'`) -> only approvals reach the hook = not answerable
//      3. a remembered `Notification` (card is dead) -> not answerable (must go back to the PC)
//    Showing 2/3 in the same orange as 1 leaves **a dead end you can press but do nothing with at the head of the queue**.
//    Separate them, and give them different colors, wording and meaning of where tapping goes.

import type { PermissionRequest, SessionSummary } from '../../../shared/types.ts'
import { waitingReason } from '../../../shared/types.ts'
import { showMachineFor, synthesizeRows } from './order.ts'

/** The "card + which endpoint it came from" used by the list and thread (the shape `main.tsx` builds) */
export type PermAlert = PermissionRequest & { endpointId: string }

export interface ThreadAlert {
  /**
   * `permission` … there is an approval answerable from the phone (orange). Tapping jumps to the card
   * `attention`  … needs attention but not answerable (gray). Tapping only shows an explanation = a cue to go back to the PC
   */
  kind: 'permission' | 'attention'
  /** How many of the same kind (`permission`: number of cards / `attention`: number of sessions) */
  count: number
  /** Jump target */
  sessionId: string
  /** Name of the jump target */
  title: string
  /**
   * ★ Which machine. Set **only when there are 2 or more** (with 1 it carries no information, so omit it).
   *
   * ⚠️ Without it, seeing "承認 2 · git-push修正・Bash" does **not tell you which PC to go to**.
   *    The gray line (handle on the PC) is entirely that instruction, so it matters even more
   *    (2026-08-18 `/code-review` low #4. The list already showed it).
   */
  machine?: string
  /** Tool name if orange, reason if gray (absent if the CLI did not say) */
  detail?: string
}

/** The "gray candidates" for one endpoint */
export interface AttentionGroup {
  /** Number of that endpoint's "approvals that will appear in a few seconds" (`quiet` from `/permissions`) */
  quiet: number
  sessions: readonly SessionSummary[]
}

export interface AlertInput {
  /**
   * Pending approvals across all machines.
   * ⚠️ **Machines whose fetch failed are not included** (`markOffline` in `main.tsx`).
   *    So the count **can be too low**. Do not word it so that it reads as "all"
   */
  perms: readonly PermAlert[]
  /**
   * ★ Gray candidates (needs attention, not answerable). Received **grouped per endpoint**.
   *
   * ⚠️⚠️ Include **only sessions of machines whose card state we actually know**.
   *    Including a machine whose `/permissions` fetch failed would **say "handle on the PC"
   *    while a live card exists** (letting the unreadable through with a default = fail-open / CLAUDE.md).
   * ⚠️⚠️ **Keep `quiet` per endpoint** (2026-08-18 codex review, medium #2).
   *    Summed globally, **one machine's `quiet` hides an unrelated machine's gray line**.
   *    `quiet` does not say **which session it belongs to**, so
   *    treat it as "none of that endpoint's sessions are known yet" (fail-closed).
   */
  attention: readonly AttentionGroup[]
  /** All sessions, for name lookup (synthesized rows may be included) */
  sessions: readonly SessionSummary[]
  /** Whether to show machine names (when 2 or more. Same test as the list: `machines.size > 1`) */
  showMachine: boolean
  /** The thread currently open. **Its own items are not shown** (that is the job of the `承認 N 件 ↓` below) */
  openSessionId: string
}

/** Oldest first (FIFO). Unparsable times go **last** (so they do not squat at the head) */
function byOldest(a: string | undefined, b: string | undefined): number {
  const ta = a ? Date.parse(a) : NaN
  const tb = b ? Date.parse(b) : NaN
  if (Number.isNaN(ta) && Number.isNaN(tb)) return 0
  if (Number.isNaN(ta)) return 1
  if (Number.isNaN(tb)) return -1
  return ta - tb
}

/**
 * Picks the one item to show now. **If there is even one orange, no gray is shown** (orange is the urgent one).
 *
 * ⚠️ Returns only one. More lines would grow the bar and push the conversation down (it is sticky, so always).
 *    The count is conveyed by `count`, and **answering brings up the next one** (`main.tsx` refetches after an answer).
 */
export function nextAlert({
  perms,
  attention,
  sessions,
  showMachine,
  openSessionId,
}: AlertInput): ThreadAlert | null {
  /**
   * Name of the jump target.
   *
   * ⚠️ `title` is **never empty** (`transcript.ts` fills it with the basename of `cwd` -> the head of the ID).
   *    Synthesized rows also have `承認待ち · <tool name>`. And `main.tsx` passes
   *    **`merged` + synthesized rows**, so the target row is always found.
   * ⚠️⚠️ There used to be a two-step fallback "project name -> ID" here, but it is
   *    **unreachable in production** (only tests hit it = a false green / same day's `/code-review` low #5).
   *    Only the last-resort fallback for the type is kept.
   */
  const nameOf = (sessionId: string): string =>
    sessions.find((x) => x.sessionId === sessionId)?.title ?? sessionId.slice(0, 8)

  /**
   * ★ Do not append the tool name or reason if the name already contains it.
   *
   * ⚠️ A synthesized row is named `承認待ち · Bash`, so appending blindly gives
   *    **"承認待ち · Bash・Bash"** (same day's `/code-review` low #6. Reproduced on the test server).
   */
  const addDetail = (title: string, detail: string): { detail?: string } =>
    title.includes(detail) ? {} : { detail }

  // ── Orange: approvals answerable from the phone (in another thread)
  const answerable = perms
    .filter((p) => p.sessionId !== undefined && p.sessionId !== openSessionId)
    .sort((a, b) => byOldest(a.at, b.at) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const head = answerable[0]
  if (head?.sessionId !== undefined) {
    const title = nameOf(head.sessionId)
    return {
      kind: 'permission',
      count: answerable.length,
      sessionId: head.sessionId,
      title,
      ...(showMachine ? { machine: head.machine } : {}),
      ...addDetail(title, head.toolName),
    }
  }

  // ── Gray: status needs attention, but there is no answerable card
  //
  // ★ Reaching here guarantees "**zero cards in other threads**" (we returned above otherwise).
  //   So there is no need to "exclude sessions with a card" (it would be unreachable = code tests
  //   cannot distinguish. It actually survived mutation testing, so it was removed / 2026-08-18).
  //
  // ⚠️⚠️ **`quiet` (cards silently waiting a few seconds) is different**. It is not in `perms`, so
  //    ignoring it would show "something answerable in a few seconds" as the gray "handle on the PC".
  //    ⚠️ Exclude **only that endpoint** (judging by the sum also hides unrelated machines' gray lines / medium #2).
  const stuck = attention
    .filter((g) => g.quiet === 0)
    .flatMap((g) => g.sessions)
    .filter((s) => s.sessionId !== openSessionId && s.live && s.status === 'waiting')
    .sort((a, b) => byOldest(a.lastActivity, b.lastActivity) || a.sessionId.localeCompare(b.sessionId))
  const first = stuck[0]
  if (first) {
    const why = waitingReason(first.waitingFor)
    const title = nameOf(first.sessionId)
    return {
      kind: 'attention',
      count: stuck.length,
      sessionId: first.sessionId,
      title,
      ...(showMachine ? { machine: first.machine } : {}),
      // ⚠️ A reason only when the CLI states one. Otherwise omit it (do not invent one)
      ...(why ? addDetail(title, why) : {}),
    }
  }

  return null
}

/** State of one endpoint (only what is needed from `EndpointState` in `main.tsx`) */
export interface AlertSource {
  endpointId: string
  sessions: readonly SessionSummary[]
  /** Pending approvals returned by that endpoint (`/permissions`) */
  permissions: readonly PermissionRequest[]
  /** ★ Whether the pending-approval list **was fetched**. Distinguishes zero from "unknown" */
  permissionsKnown: boolean
  /** Number of "approvals appearing in a few seconds". ⚠️ If not fetched, it is **unknown**, not 0 */
  quietPermissions?: number
}

/**
 * ★★ Builds the `nextAlert` input from endpoint state (2026-08-18 codex review, low #2).
 *
 * ⚠️⚠️ **Having this inside the view (`.tsx`) was the problem.** It could not be checked by machine,
 *    so assembly bugs survived **with every test green**. Three actually did (medium #2, low #1):
 *      - `quiet` was summed globally (another machine's `quiet` hid unrelated gray lines)
 *      - a downed machine's `quiet` lingered and could hide gray lines **indefinitely**
 *      - a machine with only synthesized rows was left out of the machine-name decision
 */
export function buildAlertInput(
  sources: readonly AlertSource[],
  openSessionId: string,
): AlertInput {
  const perms: PermAlert[] = sources.flatMap((s) =>
    s.permissions.map((p) => ({ ...p, endpointId: s.endpointId })),
  )
  const merged = sources.flatMap((s) => s.sessions)
  const rows = [...merged, ...synthesizeRows(perms, merged)]
  return {
    perms,
    // ★ Only endpoints whose card state we actually know. `quiet` applies only to its own endpoint
    attention: sources
      .filter((s) => s.permissionsKnown)
      .map((s) => ({ quiet: s.quietPermissions ?? 0, sessions: s.sessions })),
    sessions: rows,
    showMachine: showMachineFor(rows),
    openSessionId,
  }
}
