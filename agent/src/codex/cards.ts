// ★★ A Codex approval as one of our approval cards (2026-11-14 / docs/CODEX.md §5).
//
// The card lives in the same store as the Claude ones (`permission.ts`): the phone sees it in `/permissions` and
// answers through `/permission/answer` like any other. What differs is where the decision goes — back to the Codex
// daemon as a plain yes / no (`approvals.ts`), not to a hook.
//
// ⚠️⚠️ The phone sends a behavior and nothing else. The command that runs is the one the daemon holds; nothing from
//    the phone is passed on (same reason the Claude side never accepts `updatedInput`).
// ★★ Auto-approve mode applies here too (2026-11-14 / user decision): while the thread's entry is in effect, the
//    command approval is answered "yes" without a card. The decision is `shouldAutoApprove`, the same one place as
//    for Claude. ⚠️ Decided **before** the card is raised (a card that is answered at once would still be announced).
//    ⚠️ Only what becomes a card can pass: file changes, network rules and questions never reach this file.
// ⚠️ No notification is sent from here: the thread's status change already sends "needs you" (`notify.ts`), and a
//    second one would only stack on iOS.

import { createHash } from 'node:crypto'
import type { PermissionRequest, SessionSummary } from '../../../shared/types.ts'
import { shouldAutoApprove } from '../autoApprove.ts'
import { detailOf, hiddenIn, summarize, waitForDecision, withGeneration } from '../permission.ts'
import type { CodexApproval, PhoneDecision } from './approvals.ts'

/** Shown as the tool of the card. The request is a shell command, and the display helpers know this name. */
const TOOL_NAME = 'Bash'

/**
 * The card for one approval.
 *
 * ⚠️ The key is bound to the row (its `sessionId` carries the home), the connection generation and all four ids
 *    (docs/CODEX.md §5): the same request id on a later connection is a different card. `withGeneration` adds the
 *    per-card secret part on top, as for Claude.
 * ⚠️⚠️ The card's `sessionId` is the **row's** (`codex-<home>-<thread>`), never the bare thread id: auto-approve is
 *    looked up by it, and a bare id could be a Claude session's (codex review, high #1).
 */
export function codexCard(approval: CodexApproval, row: SessionSummary, generation: number, at: string): PermissionRequest {
  const input = { command: approval.command }
  const detail = detailOf(TOOL_NAME, input)
  const id = createHash('sha256')
    .update(
      [row.sessionId, generation, typeof approval.requestId, approval.requestId, approval.threadId, approval.turnId, approval.itemId].join('\0'),
      'utf8',
    )
    .digest('hex')
    .slice(0, 24)
  return {
    key: withGeneration(`codex:${id}`),
    machine: row.machine,
    account: row.account,
    // ★ The same project as the list row (not the request's cwd, which moves with `cd`)
    project: row.project,
    sessionId: row.sessionId,
    toolName: TOOL_NAME,
    tool: 'codex',
    summary: summarize(TOOL_NAME, input),
    ...(detail ? { detail: detail.text, detailClipped: detail.clipped } : {}),
    // ★ Checked on the whole command (invisible / direction-changing characters; `shared/reveal.ts`)
    ...(hiddenIn(TOOL_NAME, input) ? { hidden: true as const } : {}),
    at,
  }
}

export interface CardDeps {
  generation(): number
  /** The set of cards changed (tell the phones to read `/permissions` again) */
  changed(): void
  now(): Date
  log?: (line: string) => void
}

/** The `offerApproval` hook for a daemon line: show the card, wait, and translate the answer. */
export function offerCodexCard(
  deps: CardDeps,
): (approval: CodexApproval, row: SessionSummary, onWithdraw: (withdraw: () => void) => void) => Promise<PhoneDecision | undefined> {
  return async (approval, row, onWithdraw) => {
    const info = codexCard(approval, row, deps.generation(), deps.now().toISOString())
    if (shouldAutoApprove(info, deps.now().getTime())) {
      // ⚠️ One line, no command text (same as the Claude side: this line and the thread are the only traces)
      deps.log?.(`[codex] allowed by auto-approve thread=${approval.threadId.slice(0, 8)}`)
      return 'yes'
    }
    const waiting = waitForDecision(info, onWithdraw)
    deps.changed()
    const decision = await waiting
    deps.changed()
    if (!decision) return undefined
    // ⚠️ Only the behavior is read. `updatedInput` / `message` have nowhere to go and are dropped.
    return decision.behavior === 'allow' ? 'yes' : 'no'
  }
}
