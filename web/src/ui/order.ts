// Ordering of the list.
//
// ★ Do not split by machine. What you want to know is "is it done" and "is it asking for approval";
//   which PC is secondary (shown as a chip on the row). Splitting by machine always pushes the second
//   machine to the bottom of the screen, and you miss approvals waiting there (this actually hurt on 2026-08-12).
//
// ⚠️ Keep only pure functions here (so they can be tested independently of rendering).

import {
  isHistorySession,
  type PermissionRequest,
  type SessionStatus,
  type SessionSummary,
} from '../../../shared/types.ts'
import { t } from '../../../shared/i18n.ts'

/**
 * Split into three boxes.
 *   attention … waiting for you (approval pending, abnormal exit, turn finished)
 *   running   … running, so you can leave it alone
 *   history   … the process has ended
 */
export type Bucket = 'attention' | 'running' | 'history'

/** States waiting for your action. Only these come to the very top of the screen */
const ATTENTION: readonly SessionStatus[] = ['waiting', 'error', 'done']

export function bucketOf(s: SessionSummary): Bucket {
  // No process means history. Do not lift it up even if a status label remains.
  // ⚠️⚠️ **The rule lives in one place, `shared/types.ts`** (the agent filters with this rule by default).
  //    An independent implementation here **tries to put rows the agent did not return into the "running" box**
  //    = sessions vanish from the list (ARCHITECTURE §14.1.1.7).
  if (isHistorySession(s)) return 'history'
  return ATTENTION.includes(s.status) ? 'attention' : 'running'
}

/**
 * Priority within the same box. Smaller is higher.
 * Approval pending comes first, then abnormal exit. Done is "read and reply", so it sits above responding.
 */
const RANK: Record<SessionStatus, number> = {
  waiting: 0,
  error: 1,
  done: 2,
  working: 3,
  // ★ Running in the background is on the "leave it alone" side. Below responding (no reply for a while)
  background: 4,
  'rate-limited': 5,
  idle: 6,
  unknown: 7,
}

export function statusRank(status: SessionStatus): number {
  return RANK[status] ?? 9
}

/** Status priority → newest last activity first. Finally sessionId, for a stable order */
export function sortSessions(list: readonly SessionSummary[]): SessionSummary[] {
  return [...list].sort(
    (a, b) =>
      statusRank(a.status) - statusRank(b.status) ||
      (Date.parse(b.lastActivity) || 0) - (Date.parse(a.lastActivity) || 0) ||
      a.sessionId.localeCompare(b.sessionId),
  )
}

export interface Grouped {
  attention: SessionSummary[]
  running: SessionSummary[]
  history: SessionSummary[]
}

export function groupSessions(list: readonly SessionSummary[]): Grouped {
  const out: Grouped = { attention: [], running: [], history: [] }
  for (const s of list) out[bucketOf(s)].push(s)
  return {
    attention: sortSessions(out.attention),
    running: sortSessions(out.running),
    // For history, recency matters more than status, so sort by time only
    history: [...out.history].sort(
      (a, b) => (Date.parse(b.lastActivity) || 0) - (Date.parse(a.lastActivity) || 0),
    ),
  }
}

/**
 * ★ "Placeholder rows" built from pending cards (approvals with no `transcript` yet).
 *
 * ⚠️ If approval is pending on the first turn, there is no JSONL yet, so `/sessions` has no row
 *    (pointed out by the external review of 2026-08-13). The list only draws rows from sessions, so
 *    without these, **missing the Push means the approval cannot be reached from the PWA**.
 *
 * ⚠️⚠️ **Moved out of `main.tsx`** (2026-08-18 codex review, low #2).
 *    So that the list, the second line of the bar and the machine-name decision all see **the same set of rows**.
 *    Inside the screen code it could not be checked mechanically, and the bug "a machine with only
 *    synthesized rows shows no machine name" (same review, low #1) actually passed green.
 */
/**
 * ★★ The auto-approve mode mark (from `autoApprove` in `/permissions`).
 *
 * ⚠️ `machine` is used for matching **only when present** (old agents do not return it, so without it match by ID =
 *    **err toward showing**. Occasionally showing too much is better than hiding a dangerous state).
 */
export interface AutoApproveMark {
  sessionId: string
  /** Absolute time as ISO (the agent's own decision) */
  until: string
  machine?: string
}

/**
 * ★★ **Overlay** the auto-approve mark on list rows. **Create** the row if there is none (2026-09-07 codex round 2).
 *
 * ⚠️⚠️ **Why `synthesizeRows` (from pending approvals) is not enough.** The mark rode only on two paths,
 *    "synthesized pending-approval rows" and "the mark in `/sessions`", so in these two cases **both the bar and the off button vanished**
 *    (while the agent keeps approving = the worst state for this feature):
 *      high #1: the moment an approval is answered (while the transcript has not yet appeared in `/sessions`) → the synthesized row disappears
 *      high #2: collapsed **cached history rows** are not refetched, so they stay without the mark
 *    ⇒ **Make the mark the single source of visibility.** Do not depend on where a row came from.
 *
 * ⚠️ **Do not break** existing rows (title and status stay; only the mark is added).
 * ⚠️ When creating a row, write **only what is known** (title = first 8 chars of the ID. ⚠️ never show a false title).
 */
export function applyAutoApprove(
  rows: readonly SessionSummary[],
  marks: readonly AutoApproveMark[],
): SessionSummary[] {
  if (marks.length === 0) return [...rows]
  const hit = (s: SessionSummary): AutoApproveMark | undefined =>
    marks.find(
      // ⚠️⚠️ **Match the machine too** (with the same `sessionId` on two machines and only one on,
      //    the other got the mark = the bar's off went to **a different machine** / codex round 2, medium #3)
      (m) => m.sessionId === s.sessionId && (m.machine === undefined || m.machine === s.machine),
    )
  const out = rows.map((s) => {
    const m = hit(s)
    return m ? { ...s, autoApprove: { until: m.until } } : s
  })
  // ★ A mark that landed on no row creates the row itself (do not depend on where rows came from)
  for (const m of marks) {
    if (out.some((s) => s.sessionId === m.sessionId && (m.machine === undefined || m.machine === s.machine))) {
      continue
    }
    out.push({
      machine: m.machine ?? '',
      account: '',
      sessionId: m.sessionId,
      cwd: '',
      project: '—',
      // ⚠️ The name is unknown (no transcript). **Fall back to the ID**
      title: m.sessionId.slice(0, 8),
      titleSource: 'fallback' as const,
      status: 'idle' as const,
      // ★ Approvals can arrive (the decision does not look at the index), so set `live`.
      //   ⚠️ Setting this false would hide all of `commandView`, which is intended
      //   (no actions for a session we know nothing about). ⚠️ Only the auto-approve off is shown
      live: true,
      lastActivity: m.until,
      transcriptBytes: 0,
      autoApprove: { until: m.until },
    })
  }
  return out
}

export function synthesizeRows(
  perms: readonly PermissionRequest[],
  sessions: readonly SessionSummary[],
): SessionSummary[] {
  return [
    ...new Map(
      perms
        .filter((p) => p.sessionId && !sessions.some((s) => s.sessionId === p.sessionId))
        .map((p) => [
          p.sessionId as string,
          {
            machine: p.machine,
            account: p.account,
            ...(p.accountUnknown === true ? { accountUnknown: true as const } : {}),
            sessionId: p.sessionId as string,
            cwd: '',
            project: p.project,
            title: t(`承認待ち · ${p.toolName}`, `Approval needed · ${p.toolName}`),
            titleSource: 'fallback' as const,
            status: 'waiting' as const,
            live: true,
            lastActivity: p.at,
            transcriptBytes: 0,
            lastEvent: 'PermissionRequest',
          },
        ]),
    ).values(),
  ]
}

/**
 * Whether to show machine names (when there are 2 or more).
 *
 * ⚠️ **Count synthesized rows too** (same review, low #1). With normal sessions on the first machine and only
 *    "approval on the first turn" on the second, dropping synthesized rows looks like one machine and **you cannot tell which PC's approval it is**.
 */
export function showMachineFor(rows: readonly SessionSummary[]): boolean {
  return new Set(rows.map((s) => s.machine)).size > 1
}
