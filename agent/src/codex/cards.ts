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
//    ⚠️ Only what becomes a card can pass: a command, or a file change whose diff was found (2026-11-16). Network
//       rules and extra permissions never reach this file, and a question is never auto-answered.
// ⚠️ No notification is sent from here: the thread's status change already sends "needs you" (`notify.ts`), and a
//    second one would only stack on iOS.

import { createHash } from 'node:crypto'
import type { PermissionRequest, SessionSummary } from '../../../shared/types.ts'
import { shouldAutoApprove } from '../autoApprove.ts'
import { hasHidden } from '../../../shared/reveal.ts'
import { detailOf, hiddenIn, summarize, waitForDecision, withGeneration } from '../permission.ts'
import { cardOrigin } from './origin.ts'
import { ASK_USER_QUESTION } from '../claude/interaction.ts'
import type { CodexApproval, PhoneDecision, QuestionReply } from './approvals.ts'
import { questionInteraction, type CodexAnswers, type CodexQuestion } from './questions.ts'
import { patchText, type CodexFileChange } from './fileChanges.ts'

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
function cardId(req: CodexApproval | CodexQuestion | CodexFileChange, row: SessionSummary, generation: number, kind: string): string {
  return createHash('sha256')
    .update([kind, row.sessionId, generation, typeof req.requestId, req.requestId, req.threadId, req.turnId, req.itemId].join('\0'), 'utf8')
    .digest('hex')
    .slice(0, 24)
}

export function codexCard(approval: CodexApproval, row: SessionSummary, generation: number, at: string): PermissionRequest {
  const input = { command: approval.command }
  const detail = detailOf(TOOL_NAME, input)
  const id = cardId(approval, row, generation, 'command')
  const cwd = approval.cwd
  const cwdClipped = cwd !== undefined && cwd.length > CWD_MAX
  return {
    key: withGeneration(`codex:${id}`),
    origin: cardOrigin(approval, row.sessionId, 'command'),
    machine: row.machine,
    account: row.account,
    // ★ The same project as the list row (not the request's cwd, which moves with `cd`)
    project: row.project,
    sessionId: row.sessionId,
    toolName: TOOL_NAME,
    tool: 'codex',
    summary: summarize(TOOL_NAME, input),
    ...(detail ? { detail: detail.text, detailClipped: detail.clipped || cwdClipped } : cwdClipped ? { detailClipped: true } : {}),
    // ★★ Where it runs (security review 2026-11-17, medium): the request's own directory, which can be anywhere —
    //    the row's project alone made a command in a sensitive directory look like one in the project.
    ...(cwd === undefined ? {} : { cwd: cwd.slice(0, CWD_MAX) }),
    // ★ Checked on the whole command and the whole directory (invisible / direction-changing characters; `shared/reveal.ts`)
    ...(hiddenIn(TOOL_NAME, input) || (cwd !== undefined && hasHidden(cwd)) ? { hidden: true as const } : {}),
    at,
  }
}

/** A directory longer than this is cut, and the card says it is not all there (`detailClipped`) */
const CWD_MAX = 1000

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
    // ★ The exact command (and where it runs) beside the card: a team's leader judges by this, not by the summary
    //   (whitespace is folded there / codex review r18, medium #2)
    const waiting = waitForDecision(info, onWithdraw, { toolInput: { command: approval.command, ...(approval.cwd === undefined ? {} : { cwd: approval.cwd }) } })
    deps.changed()
    const decision = await waiting
    deps.changed()
    if (!decision) return undefined
    // ⚠️ Only the behavior is read. `updatedInput` / `message` have nowhere to go and are dropped.
    return decision.behavior === 'allow' ? 'yes' : 'no'
  }
}

/**
 * ★ The card for one question (`questions.ts`). Shown like Claude's `AskUserQuestion` (same tool name, so the display
 *   helpers and auto-approve treat it as a question: ⚠️ auto-approve never answers it — `requiresInteraction`).
 * ⚠️ The ids stay on the agent: the card carries texts and labels only.
 */
export function codexQuestionCard(question: CodexQuestion, row: SessionSummary, generation: number, at: string): PermissionRequest {
  const input = { questions: question.questions.map((q) => ({ question: q.question })) }
  const detail = detailOf(ASK_USER_QUESTION, input)
  return {
    key: withGeneration(`codex:${cardId(question, row, generation, 'question')}`),
    origin: cardOrigin(question, row.sessionId, 'question'),
    machine: row.machine,
    account: row.account,
    project: row.project,
    sessionId: row.sessionId,
    toolName: ASK_USER_QUESTION,
    tool: 'codex',
    summary: summarize(ASK_USER_QUESTION, input),
    ...(detail ? { detail: detail.text, detailClipped: detail.clipped } : {}),
    interaction: questionInteraction(question),
    at,
  }
}

/** The `askQuestion` hook for a daemon line: show the card, wait, and pass on what the route built. */
export function askCodexQuestion(
  deps: CardDeps,
): (question: CodexQuestion, row: SessionSummary, onWithdraw: (withdraw: () => void) => void) => Promise<QuestionReply | undefined> {
  return async (question, row, onWithdraw) => {
    const info = codexQuestionCard(question, row, deps.generation(), deps.now().toISOString())
    // ★ The request itself is kept with the card: the route builds the answer from it (`buildCodexAnswers`), never
    //   from anything the phone sends
    const waiting = waitForDecision(info, onWithdraw, { toolInput: question })
    deps.changed()
    const decision = await waiting
    deps.changed()
    if (!decision) return undefined
    if (decision.behavior === 'deny') return { type: 'stop' }
    // ⚠️ An allow without what the route built is not an answer (an empty answer would resolve the question)
    const result = decision.updatedInput as CodexAnswers | undefined
    if (!result || typeof result.answers !== 'object' || result.answers === null) return undefined
    return { type: 'answers', result }
  }
}

/** Shown as the tool of a file-change card (`permission.ts` folds it to the patch text) */
export const FILE_CHANGE_TOOL = 'ApplyPatch'

/**
 * ★ The card for one file change: the files and the diff as the PC shows them (`fileChanges.ts` rule 1: only built
 *   when the diff was found). ⚠️ The whole text is checked for hidden characters; a long one is cut and flagged
 *   (the phone asks once more before a yes on what was not all shown).
 */
export function codexFileChangeCard(change: CodexFileChange, row: SessionSummary, generation: number, at: string): PermissionRequest {
  const input = { patch: patchText(change) }
  const detail = detailOf(FILE_CHANGE_TOOL, input)
  return {
    key: withGeneration(`codex:${cardId(change, row, generation, 'file')}`),
    origin: cardOrigin(change, row.sessionId, 'file'),
    machine: row.machine,
    account: row.account,
    project: row.project,
    sessionId: row.sessionId,
    toolName: FILE_CHANGE_TOOL,
    tool: 'codex',
    summary: summarize(FILE_CHANGE_TOOL, input),
    ...(detail ? { detail: detail.text, detailClipped: detail.clipped } : {}),
    ...(hiddenIn(FILE_CHANGE_TOOL, input) ? { hidden: true as const } : {}),
    at,
  }
}

/**
 * The `offerFileChange` hook for a daemon line. ★ Auto-approve applies, as for a command (and as for Claude's Edit):
 * a yes / no approval, decided in the same one place before the card is raised.
 */
export function offerCodexFileChange(
  deps: CardDeps,
): (change: CodexFileChange, row: SessionSummary, onWithdraw: (withdraw: () => void) => void) => Promise<PhoneDecision | undefined> {
  return async (change, row, onWithdraw) => {
    const info = codexFileChangeCard(change, row, deps.generation(), deps.now().toISOString())
    if (shouldAutoApprove(info, deps.now().getTime())) {
      // ⚠️ One line, no paths or diff
      deps.log?.(`[codex] file change allowed by auto-approve thread=${change.threadId.slice(0, 8)}`)
      return 'yes'
    }
    // ★ The exact patch beside the card (a team's leader judges by it / r18 medium #2)
    const waiting = waitForDecision(info, onWithdraw, { toolInput: { patch: patchText(change) } })
    deps.changed()
    const decision = await waiting
    deps.changed()
    if (!decision) return undefined
    return decision.behavior === 'allow' ? 'yes' : 'no'
  }
}
