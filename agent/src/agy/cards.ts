// ★★ agy approval cards on the phone (2026-11-20 / docs/AGY.md §9).
//
// The card lives in the same store as the Claude and Codex ones (`permission.ts`): the phone sees it in
// `/permissions` and answers through `/permission/answer`. The answer goes back as a fixed key through the agy's
// relay (`keys.ts` `answerAgyCard`: `1` allow, ESC deny), only while that same card is still up.
//
// The rules:
//  1. A card is raised only for an agy started through the relay (an answer must be typeable), and only for the call
//     kinds whose card was measured (`run_command` → Bash, `read_file` → Read). Other cards stay on the PC
//     (the thread says so). ⚠️ Fail-closed: a card whose options were not seen could have something else at `1`.
//  2. ⚠️⚠️ A card is named by the agy, the status file's time and the call (`AgyCardMark`). Any change of state
//     rewrites the status file, so an answer to an older card never lands on a newer one (checked again right before
//     the key goes out).
//  3. A card that is no longer up (answered on the PC, the turn stopped, the agy gone) is withdrawn from the phone.
//  4. An answered card is not raised again while the same card is still up (the status file needs a moment); if the key
//     could not go out, it is raised again on the next look; if it went out but the same card is still up after
//     `UNCONFIRMED_MS` (4c), it is raised again too.
//  5. No notification from here: the row turning "waiting" sends "needs you" (`notify.ts`), and a second push would
//     only stack on iOS.
//  5b. ★★ Auto-approve (2026-11-20 / docs/AGY.md §10): a card the phone could answer, of a conversation whose
//     auto-approve is on (`shouldAutoApprove`, the one place that decides), shown by the very agy process it was given
//     to (`grants.ts`: pid + relay start), is answered `1` here without going to the phone, and its "needs you" is not
//     rung (`autoAnswering`, read by the notifier). ⚠️ A card the phone cannot answer (an unmeasured kind) is never
//     typed at: it stays on the PC and rings as before.
//     ⚠️⚠️ A call that has ever been on the phone is never auto-answered (a person may have denied it there and the
//     key failed). Remembered by the call, not the status write (a resize rewrites that / codex review).
//     ⚠️ A key that did not go out, or a card still up after `UNCONFIRMED_MS`, falls back to the phone: the card is
//     raised there and "needs you" rings once if it has not rung yet (`reraised`).
//  6. ⚠️ The phone sends a behavior and nothing else (never a text to type).
//  7. ⚠️ No card while another running agy shows the same conversation (`agyShared`): they share its transcript, so
//     the card could be the other agy's (checked again right before the key / `keys.ts`).
//  8. ★★ The state comes from each agy's own file (`pid-<pid>.json`), and a card needs agy's own word that the process
//     shows that conversation: it holds `presence/<id>.lock` (`agyLocksOf`). A status line that stopped writing
//     (e.g. turned off before an update) then a `/resume` elsewhere moves the lock, so the old card is never answered.
//  9. ★★ The call must not be newer than the agy's "card is up" state (`callBeforeState`): agy writes the call before
//     it shows the card. A newer last call is another agy's (one that shared the conversation, declined, and left).

import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import type { PermissionRequest, SessionSummary } from '../../../shared/types.ts'
import { hasHidden } from '../../../shared/reveal.ts'
import { t } from '../../../shared/i18n.ts'
import { detailOf, hiddenIn, summarize, waitForDecision, withGeneration } from '../permission.ts'
import { shouldAutoApprove } from '../autoApprove.ts'
import { agyGrantOwner, type AgyGrantOwner } from './grants.ts'
import { aliveProcStartSync } from '../claude/sessionIndex.ts'
import { agyLocksOf, agyPaneOf, withLocksProbed, agyPidFiles, agyRow, agyShared, readAgyPidFile, sweepAgyPidFiles, transcriptPathOf, type AgyDeps, type AgyState } from './sessions.ts'
import { callBeforeState, readTailRecords, turnEnd, type PendingCall } from './pending.ts'
import type { AgyCardFailure, AgyCardMark, AgyChildApprovalMark, AgyQuestionAnswer, AgyQuestionFailure, AgyQuestionMark } from './keys.ts'
import { agyQuestionInteraction, parseAgyQuestion, questionTextsOf, skipSteps, type AgyAnswerPlan, type AgyQuestion, type AgyStep } from './questions.ts'
import { agyUnlisted, ownApprovalShows, childViewOf, dialogFits, inChildView, inputBoxOf, listAgy, parseApproval, previewAsks, respondOffered, parseBanner, parseDialog, parseSubagentList, readAgyScreen, sameQuestionText, viewOwnerOf } from './screen.ts'
import { AGY_QUESTION_TOOL, agyBlockedReadAt, agyBlockedWaits, agyCardAt, agyChildQuestions, agyPendingCall, agyQuestionAt, agyQuestionWaitAt } from './sessions.ts'

/** ★ The calls whose card was measured, as the tool and input the card helpers know. undefined = stays on the PC */
export function agyCardTool(call: Pick<PendingCall, 'name' | 'args'>): { toolName: string; input: Record<string, string> } | undefined {
  switch (call.name) {
    case 'run_command': {
      const command = call.args['CommandLine']
      // ★ Where it runs, when the call says (codex review: a `Cwd` elsewhere was shown as the agy's own folder)
      const cwd = call.args['Cwd']
      if (cwd !== undefined && typeof cwd !== 'string') return undefined
      return typeof command === 'string' && command.length > 0 ? { toolName: 'Bash', input: { command, ...(cwd ? { cwd } : {}) } } : undefined
    }
    case 'read_file': {
      const path = call.args['Path']
      return typeof path === 'string' && path.length > 0 ? { toolName: 'Read', input: { file_path: path } } : undefined
    }
    default:
      return undefined
  }
}

/** A directory longer than this is cut, and the card says it is not all there */
const CWD_MAX = 1000

export function agyCard(row: SessionSummary, mark: AgyCardMark, call: PendingCall, at: string): PermissionRequest | undefined {
  const tool = agyCardTool(call)
  if (!tool) return undefined
  const { toolName } = tool
  const { cwd: callCwd, ...input } = tool.input
  const detail = detailOf(toolName, input)
  const id = createHash('sha256')
    .update(['agy', row.sessionId, mark.pid, mark.stateMtimeMs, mark.step, mark.index].join('\0'), 'utf8')
    .digest('hex')
    .slice(0, 24)
  // ★ A command runs where the call says, else in the agy's folder (the status line's cwd): shown like a Codex card's
  const cwd = toolName === 'Bash' ? (callCwd ?? row.cwd) : undefined
  const cwdClipped = cwd !== undefined && cwd.length > CWD_MAX
  return {
    key: withGeneration(`agy:${id}`),
    // ★ The same call keeps its origin when the card is raised again (teams' first-seen time and ref / `permission.ts`).
    //   ⚠️ Bound to the call itself — its time and its exact input — not only its place: after a `/rewind` another
    //      command can take the same step and index (codex review: an old ref approved it)
    origin: `agy:${createHash('sha256').update([row.sessionId, mark.pid, mark.step, mark.index, mark.callAt, JSON.stringify(tool.input)].join('\0'), 'utf8').digest('hex').slice(0, 24)}`,
    machine: row.machine,
    account: row.account,
    project: row.project,
    sessionId: row.sessionId,
    toolName,
    tool: 'agy',
    summary: summarize(toolName, input),
    ...(detail ? { detail: detail.text, detailClipped: detail.clipped || cwdClipped } : cwdClipped ? { detailClipped: true } : {}),
    ...(cwd === undefined || cwd === '' ? {} : { cwd: cwd.slice(0, CWD_MAX) }),
    ...(hiddenIn(toolName, input) || (cwd !== undefined && hasHidden(cwd)) ? { hidden: true as const } : {}),
    at,
  }
}

export interface AgyCardDeps {
  /** Fresh deps for each look (`now` is read once per look) */
  agy(): AgyDeps
  /** This machine's name (the card's row) */
  machine: string
  /** @param stillWanted asked right before the byte goes out (auto-approve: still on) */
  answer(
    conversationId: string,
    mark: AgyCardMark,
    behavior: 'allow' | 'deny',
    stillWanted?: () => boolean,
  ): Promise<{ ok: true } | { ok: false; reason: AgyCardFailure }>
  /** The set of cards changed (tell the phones to read `/permissions` again) */
  changed(): void
  now(): Date
  tail?: (path: string) => Record<string, unknown>[]
  log?: (line: string) => void
  /**
   * ★ Types the phone's answer to a question (docs/AGY.md §13 / `keys.ts` `answerAgyQuestion`). Absent ⇒ no question
   *   cards (they stay on the PC).
   */
  answerQuestion?(
    conversationId: string,
    mark: AgyQuestionMark,
    answer: AgyQuestionAnswer,
    /** ★ The answer's own `Decision.stillValid` (a team's leader: still this team) */
    stillWanted?: () => boolean,
  ): Promise<{ ok: true; left?: true } | { ok: false; reason: AgyQuestionFailure }>
  /**
   * ★ Types the phone's answer to a subagent's command approval (agy 1.5.16+ / docs/AGY.md §19, case 8 /
   *   `keys.ts` `answerAgyChildApproval`). Absent ⇒ no such cards (they ring and stay on the PC).
   */
  answerChildApproval?(
    conversationId: string,
    mark: AgyChildApprovalMark,
    behavior: 'allow' | 'deny',
    stillWanted?: () => boolean,
  ): Promise<{ ok: true } | { ok: false; reason: AgyCardFailure }>
  /** ★ Reads an agy's screen through its relay (`readAgyScreen`; replaced in tests) */
  readScreen?: (socketPath: string) => Promise<string | undefined>
  /** Rule 4c (tests shorten it) */
  unconfirmedMs?: number
  /** (tests) `CA_ANSWERED_MS` */
  childAnsweredMs?: number
  /**
   * Rule 4c: a card shown again after its key did not land (the notifier owes a fresh "needs you").
   * @param card the card's state write (ISO time of the agy's own state file, as the notifier's `cardOf`)
   */
  reraised?: (conversationId: string, card: string, once?: boolean) => void
  /** (tests) The phone's wait for an answer (`AGY_DELIVERY_WAIT_MS`) */
  deliveryWaitMs?: number
}


/** How long an answered subagent approval still blocked on the list is not raised again (agy redraws, the key lands) */
export const CA_ANSWERED_MS = 30_000

/** Rule 4c: how long the same card may stay up after its key was written before it is shown again */
export const UNCONFIRMED_MS = 3000

interface Raised {
  id: string
  withdraw?: () => void
}

export type AgyDelivery = { ok: true; left?: true } | { ok: false; reason: AgyQuestionFailure }

/**
 * ★ Card key → whether its answer's key went out (codex review: the route said "ok" the moment the card was
 * answered, so a key that never reached agy looked delivered). The answer route takes this **before** answering and
 * waits for it (`routes/permission.ts`). Settles `undefined` when the card went away without an answer.
 */
const deliveries = new Map<string, Promise<AgyDelivery | undefined>>()

export function agyDelivery(key: string): Promise<AgyDelivery | undefined> | undefined {
  return deliveries.get(key)
}

/** What the phone is told when an answer's key did not go out */
/**
 * ★ How long the phone's answer waits for an agy answer to be typed (`permissionAnswer`). Short: a relay line runs its
 * requests one at a time, so every second here delays what is queued behind it (codex review: two long answers made a
 * Claude instruction time out on the phone and then run). Measured answers took 0.6–1.3 s; a later failure rings again.
 */
export const AGY_DELIVERY_WAIT_MS = 1500

export function agyDeliveryMessage(reason: AgyQuestionFailure): string {
  if (reason === 'partial') {
    return t(
      '答えの途中で質問が変わったため、最後まで打てませんでした。PC の画面で続きを答えてください。',
      'The question changed while the answer was being typed, so it was not finished. Finish it on the PC screen.',
    )
  }
  return reason === 'changed'
    ? t(
        'カードが変わりました（PC で答えたか、次のカードが出ています）。もう一度 見てから答えてください。',
        'The card changed (it was answered on the PC, or the next one is up). Look again before answering.',
      )
    : t('agy に届きませんでした。もう一度 押すか、PC で答えてください。', 'It did not reach agy. Press it again, or answer on the PC.')
}

/** The question's call itself (the same however many times it is looked at) */
const qCallId = (m: AgyQuestionMark): string => `${m.pid}:${m.child ?? ''}:${m.step}:${m.index}:${m.callAt}`
const qMarkId = (m: AgyQuestionMark): string => `q:${m.pid}:${m.child ?? ''}:${m.askedAt}:${m.step}:${m.index}:${m.callAt}`

/** ★ A question as a question card (docs/AGY.md §13): the questions and options, nothing to type on the phone */
export function agyQuestionCard(row: SessionSummary, mark: AgyQuestionMark, q: AgyQuestion, at: string): PermissionRequest {
  const id = createHash('sha256').update(['agy-question', row.sessionId, mark.pid, mark.child ?? '', mark.askedAt, mark.step, mark.index].join('\0'), 'utf8').digest('hex').slice(0, 24)
  const first = q.items[0]!.question
  return {
    key: withGeneration(`agy:${id}`),
    // ⚠️ Bound to the call itself (its time and its questions), as a card's (codex review)
    origin: `agy:${createHash('sha256').update(['agy-question', row.sessionId, mark.pid, mark.child ?? '', mark.step, mark.index, mark.callAt, JSON.stringify(q.items)].join('\0'), 'utf8').digest('hex').slice(0, 24)}`,
    machine: row.machine,
    account: row.account,
    project: row.project,
    sessionId: row.sessionId,
    toolName: 'AskUserQuestion',
    tool: 'agy',
    summary: first.length > 200 ? `${first.slice(0, 199)}…` : first,
    interaction: agyQuestionInteraction(q),
    // ★ A child's question: the card says it comes from a subagent (the PC shows only a banner for it)
    ...(mark.child !== undefined ? { subagent: {} } : {}),
    ...(q.items.some((x) => hasHidden(x.question, ...x.options)) ? { hidden: true as const } : {}),
    at,
  }
}

/**
 * ★★ A subagent's command approval as an approval card (agy 1.5.16+ / docs/AGY.md §19, case 8): a Bash card marked as a
 *   subagent's. ⚠️ Never answered by auto-approve (only a person or a team's leader).
 */
export function agyChildApprovalCard(row: SessionSummary, mark: AgyChildApprovalMark, call: PendingCall, at: string): PermissionRequest | undefined {
  const base = agyCard(row, { pid: mark.pid, stateMtimeMs: mark.askedAt, step: mark.step, index: mark.index, callAt: mark.callAt }, call, at)
  if (!base || base.toolName !== 'Bash') return undefined
  const id = createHash('sha256').update(['agy-child-approval', row.sessionId, mark.pid, mark.child, mark.askedAt, mark.step, mark.index].join('\0'), 'utf8').digest('hex').slice(0, 24)
  return {
    ...base,
    key: withGeneration(`agy:${id}`),
    // ⚠️ Bound to the call itself (its child, time and command), as a card's
    origin: `agy:${createHash('sha256').update(['agy-child-approval', row.sessionId, mark.pid, mark.child, mark.step, mark.index, mark.callAt, mark.command].join('\0'), 'utf8').digest('hex').slice(0, 24)}`,
    subagent: {},
  }
}

const caMarkId = (m: AgyChildApprovalMark): string => `ca:${m.pid}:${m.child}:${m.askedAt}:${m.step}:${m.index}:${m.callAt}`
const caCallId = (conv: string, m: AgyChildApprovalMark): string => `${conv}:${m.pid}:${m.child}:${m.step}:${m.index}:${m.callAt}`

/** ★ The card's name the notifier uses (`cardOf` / `agyCardAt`: its first state write, the same across agy's rewrites) */
const cardName = (conv: string, m: AgyCardMark): string => new Date(agyCardAt(m.pid, conv, { step: m.step, index: m.index, at: m.callAt }, m.stateMtimeMs)).toISOString()
const markId = (m: AgyCardMark): string => `${m.pid}:${m.stateMtimeMs}:${m.step}:${m.index}:${m.callAt}`
/** How many calls "on the phone" / "auto-tried" remember */
const CALL_MEMORY_MAX = 1024
/** The call itself (the same through a status rewrite such as a resize) */
const callId = (m: AgyCardMark): string => `${m.pid}:${m.step}:${m.index}:${m.callAt}`

export class AgyCards {
  readonly #deps: AgyCardDeps
  /** conversation → the card on the phone */
  #raised = new Map<string, Raised>()
  /** conversation → the card answered from the phone (rule 4) */
  #answered = new Map<string, string>()
  /**
   * conversation → the last card raised, by its mark. ★ The same card raised again (its key did not go out) keeps its
   * key, so the phone keeps the failure reason it showed on it (codex review: a fresh key hid it).
   */
  #lastInfo = new Map<string, { id: string; info: PermissionRequest }>()
  /** conversation → the card being answered by auto-approve (rule 5b): its mark id and its state write (ISO) */
  #auto = new Map<string, { id: string; card: string }>()
  /** The calls (`conversation:callId`) that have been on the phone (rule 5b: never auto-answered). Bounded, oldest out */
  #onPhone = new Set<string>()
  /** The conversations the last look could not tell about */
  #lastUnsure = new Set<string>()
  /** ★ The call each conversation's card is up for, as of the last look (rule 4c across a state rewrite) */
  #upCall = new Map<string, string>()
  /** ★ conversation → the question card on the phone (docs/AGY.md §13), by its mark id */
  #qRaised = new Map<string, Raised>()
  /** conversation → the question answered from the phone (not raised again while it stays up; rule 4 as cards) */
  #qAnswered = new Map<string, string>()
  /**
   * ★ Calls left to the PC for good (codex review): an answer typed only in part, or a several-key answer whose question
   *   is still up after it — raising it again would start over on a dialog that is no longer at its start. Bounded.
   */
  #qLeft = new Set<string>()
  /** Whether a look of questions has been made yet (the first one leaves what is already up to the PC) */
  #qLooked = false
  /**
   * ★ Calls whose answer is being typed now: never raised again meanwhile, whatever a look sees (codex review: a
   *   sibling's short call hid it for a look, the answered memory was dropped, and a second card was raised mid-answer)
   */
  #qTyping = new Set<string>()
  /** ★ conversation → the subagent approval card on the phone (docs/AGY.md §19, case 8), by its mark id */
  #caRaised = new Map<string, Raised & { mark: AgyChildApprovalMark }>()
  /**
   * conversation → the subagent approval answered from the phone (not raised again while the list still shows it).
   * ⚠️ For a while only (`CA_ANSWERED_MS`): one still blocked after that comes back, whatever the looks between could
   *    read (codex review: a list hidden past the confirmation's tries kept it off for good)
   */
  #caAnswered = new Map<string, string>()
  #caAnsweredAt = new Map<string, number>()
  /** ★ Subagent approval calls whose answer is being typed now: never raised again meanwhile (as `#qTyping` / agy review) */
  #caTyping = new Set<string>()
  /** conversation → how many children the list showed blocked on an approval, and at which look */
  #caBlocked = new Map<string, { look: number; blocked: number }>()
  /** The calls auto-approve has tried once (rule 5b: never a second time; the phone's after that). Bounded */
  #autoTried = new Set<string>()
  #run: Promise<void> | undefined
  #again = false
  /** How many looks have started (`fresh`) */
  #begun = 0
  /** Callers of `fresh` waiting for a look numbered above `after` */
  #waiters: { after: number; resolve: () => void }[] = []

  constructor(deps: AgyCardDeps) {
    this.#deps = deps
  }

  /**
   * Look at every agy once and bring the phone's cards in line. Overlapping calls fold into one more look.
   * ★ Settles only after a look that started after this call (the notifier asks `autoAnswering` right after it).
   */
  sync(): Promise<void> {
    if (this.#run) {
      this.#again = true
      return this.#run
    }
    const run = (async () => {
      try {
        do {
          this.#again = false
          const n = ++this.#begun
          try {
            await this.#look()
          } finally {
            this.#settle(n)
          }
        } while (this.#again)
      } finally {
        this.#run = undefined
        this.#settle(Infinity)
      }
    })()
    this.#run = run
    return run
  }

  /**
   * ★ Settles once one whole look that started after this call is done (not when the looks go idle: under a stream of
   * status updates they never do / codex review). Never rejects.
   */
  fresh(): Promise<void> {
    const after = this.#begun
    const done = new Promise<void>((resolve) => this.#waiters.push({ after, resolve }))
    void this.sync().catch(() => undefined)
    return done
  }

  #settle(n: number): void {
    const keep: { after: number; resolve: () => void }[] = []
    for (const w of this.#waiters) {
      if (n > w.after) w.resolve()
      else keep.push(w)
    }
    this.#waiters = keep
  }

  /**
   * ★ Rule 5b: whether this card (its first state write, ISO, as the notifier's `cardOf` / `cardName`) is being answered by auto-approve,
   * so its "needs you" is not rung.
   */
  autoAnswering(conversationId: string, card: string): boolean {
    return this.#auto.get(conversationId)?.card === card
  }

  /** Whether the last look could not tell about this conversation's card (a lock probe that failed) */
  unsureAbout(conversationId: string): boolean {
    return this.#lastUnsure.has(conversationId)
  }

  async #look(): Promise<void> {
    // ⚠️ Locks probed all at once without blocking (a Mac's `lsof` / `withLocksProbed`)
    const deps = await withLocksProbed(this.#deps.agy())
    void sweepAgyPidFiles(deps)
    const want = new Map<string, { state: AgyState; mark: AgyCardMark; call: PendingCall; relayAt: number; children?: true }>()
    const shared = new Set<string>()
    const unsure = new Set<string>()
    // ★ Each agy's own state file (a second agy on the conversation can neither take the card over nor hide it)
    for (const pid of agyPidFiles(deps.dir)) {
      if (!deps.isAgy(pid)) continue
      const f = readAgyPidFile(deps.dir, pid)
      if (!f?.state.confirmationPending) continue
      // ★ A child agent not finished: its question may be open on the PC and would take the `1` or the ESC (docs/AGY.md
      //   §11) ⇒ no card — except on agy 1.5.16+ with the screen, where the parent's own dialog is read open on the
      //   parent's view for this command (`ownApprovalShows`), here and again right before the key (`answerAgyCard`).
      //   ⚠️ Never auto-answered then (the phone or a team's leader only). The card stays on the PC otherwise.
      const children = f.state.subagentsActive
      if (children && !listAgy(f.state.version)) continue
      const conv = f.state.conversationId
      // Rule 1: only an agy whose relay checks out (the pane's process is this agy)
      const pane = await agyPaneOf(pid, deps.aliveProcStart ?? aliveProcStartSync)
      // ⚠️ A relay record that could not be read (or checked) now is "cannot tell", not "no relay" (codex review: one
      //    failed read rang for a card the next look auto-answered, and withdrew a phone card)
      if (pane === 'broken' || pane === 'unverified') {
        unsure.add(f.state.conversationId)
        continue
      }
      if (typeof pane === 'string' || f.mtimeMs < pane.startedAt) continue
      if (children && !pane.screen) continue
      // ★★ agy's own word that this process shows this conversation (rule 8)
      const locksOf = deps.locksOf ?? ((p: number) => agyLocksOf(p, deps.home))
      const locks = locksOf(pid)
      if (locks === undefined) {
        // ⚠️ Cannot tell now (a probe that failed): a card already on the phone stays as it is (withdrawing it gave it
        //    a new key on return, and a failure stored under the old one stuck / codex review); none is raised
        unsure.add(conv)
        continue
      }
      if (!locks.includes(conv)) continue
      const mtimeOf = (): { mtimeMs: number; size: number } | undefined => {
        try {
          return statSync(transcriptPathOf(conv, deps.home))
        } catch {
          return undefined
        }
      }
      const before = mtimeOf()
      const records = (this.#deps.tail ?? readTailRecords)(transcriptPathOf(conv, deps.home))
      // ⚠️ A transcript that cannot be read now (or is missing) while the state says a card is up: cannot tell, not "no
      //    card" (codex review: the timeout's re-ring was lost on such a look)
      if (records.length === 0) {
        unsure.add(conv)
        continue
      }
      const end = turnEnd(records)
      // ★ The transcript's time and size, the same before and after the read (it did not move under it); else the card
      //   is not named by this look (`agyCardAt` / codex review)
      const after = mtimeOf()
      const transcriptAt = before && after && before.mtimeMs === after.mtimeMs && before.size === after.size ? after.mtimeMs : undefined
      // ★ Rule 9: the call must be older than this agy's "card is up" state
      if (!end.pending || !callBeforeState(end.pending, f.mtimeMs)) continue
      if (children) {
        const command = end.pending.name === 'run_command' ? end.pending.args['CommandLine'] : undefined
        if (typeof command !== 'string' || command === '') continue
        const shown = await (this.#deps.readScreen ?? readAgyScreen)(pane.socketPath)
        // (a screen that cannot be read now: cannot tell — a card up stays as it is / agy review)
        if (shown === undefined) {
          unsure.add(conv)
          continue
        }
        if (!ownApprovalShows(shown, command)) continue
      }
      // Rule 7: another agy shows it too, or wrote into it during this card ⇒ the card could be the other one's
      const sharedNow = want.has(conv) || agyShared(deps.dir, conv, pid, deps.isAgy, locksOf, end.pending.at!)
      if (sharedNow === undefined) {
        unsure.add(conv)
        continue
      }
      if (sharedNow) {
        shared.add(conv)
        continue
      }
      // ★ The card's name, given here as the notifier would (`agyCardAt`: whichever of the two looks sees it first)
      agyCardAt(pid, conv, end.pending, f.mtimeMs, transcriptAt)
      want.set(conv, {
        state: f.state,
        mark: { pid, stateMtimeMs: f.mtimeMs, step: end.pending.step, index: end.pending.index, callAt: end.pending.at! },
        call: end.pending,
        relayAt: pane.startedAt,
        ...(children ? { children: true as const } : {}),
      })
    }
    for (const conv of shared) want.delete(conv)
    this.#lastUnsure = unsure
    // ⚠️ A conversation this look could not tell about keeps its last known call (codex review: one unreadable look at
    //    the timeout dropped the re-ring)
    this.#upCall = new Map([...[...this.#upCall].filter(([c]) => unsure.has(c) && !want.has(c)), ...[...want].map(([c, w]) => [c, callId(w.mark)] as const)])
    let changed = false
    // Rule 3: cards no longer up
    for (const [conv, r] of this.#raised) {
      const w = want.get(conv)
      if (w && markId(w.mark) === r.id) continue
      if (!w && unsure.has(conv)) continue
      this.#raised.delete(conv)
      r.withdraw?.()
      changed = true
    }
    for (const conv of this.#answered.keys()) {
      const w = want.get(conv)
      // ⚠️ Cannot tell now ⇒ kept (dropping it let an auto-answer whose key was lost be typed again / codex review)
      if (!w && unsure.has(conv)) continue
      if (!w || markId(w.mark) !== this.#answered.get(conv)) this.#answered.delete(conv)
    }
    for (const [conv, a] of this.#auto) {
      const w = want.get(conv)
      if (!w && unsure.has(conv)) continue
      if (!w || markId(w.mark) !== a.id) this.#auto.delete(conv)
    }
    // ⚠️ Remembered per call, never per conversation (a late failure of an older call overwrote the newer call's record
    //    / codex review), and never forgotten because a card is not seen now (a status file missing for a moment).
    //    A call never comes back, so only the oldest go when the bound is reached.
    for (const memory of [this.#onPhone, this.#autoTried]) {
      while (memory.size > CALL_MEMORY_MAX) memory.delete(memory.values().next().value as string)
    }
    for (const conv of this.#lastInfo.keys()) {
      const w = want.get(conv)
      if (!w && unsure.has(conv)) continue
      if (!w || markId(w.mark) !== this.#lastInfo.get(conv)!.id) this.#lastInfo.delete(conv)
    }
    for (const [conv, w] of want) {
      const id = markId(w.mark)
      if (this.#raised.has(conv) || this.#answered.get(conv) === id) continue
      // ★ The row as the list builds it, from this agy's own state (the list itself may not show it right now)
      const row = agyRow(w.state, { machine: this.#deps.machine, transcriptBytes: 0, lastActivity: this.#deps.now().toISOString(), sendRoute: 'keys', asking: false, outlived: false })
      const last = this.#lastInfo.get(conv)
      const info = last?.id === id ? last.info : agyCard(row, w.mark, w.call, this.#deps.now().toISOString())
      if (!info) {
        this.#deps.log?.(`[agy] a card the phone cannot answer (${w.call.name.slice(0, 40)}); left to the PC`)
        // remembered so the line is said once per card
        this.#answered.set(conv, id)
        continue
      }
      // ★ Rule 5b: auto-approve answers it here: never a call that has been on the phone, only for its owner process
      const owner = agyGrantOwner(conv)
      const mine = (o: AgyGrantOwner | undefined): boolean => o !== undefined && o.pid === w.mark.pid && o.startedAt === w.relayAt
      // ⚠️ Once per call: a call still up after its try (a status rewrite such as a resize gives it a new mark) is the
      //    phone's, never typed at again (codex review: a byte the relay dropped, then a resize, typed `1` twice)
      const call = `${conv}:${callId(w.mark)}`
      if (!w.children && !this.#onPhone.has(call) && !this.#autoTried.has(call) && mine(owner) && shouldAutoApprove(info, this.#deps.now().getTime())) {
        this.#autoTried.add(call)
        this.#answered.set(conv, id)
        this.#auto.set(conv, { id, card: cardName(conv, w.mark) })
        // ⚠️ Asked again right before the byte (an "off", the expiry or a new grant during the settle wait / codex review);
        //    and never once the call has gone to the phone meanwhile (a person may be denying it there / codex review)
        void this.#autoAnswer(
          conv,
          id,
          w.mark,
          () => !this.#onPhone.has(call) && agyGrantOwner(conv) === owner && shouldAutoApprove(info, this.#deps.now().getTime()),
        )
        continue
      }
      this.#onPhone.add(call)
      this.#lastInfo.set(conv, { id, info })
      const raised: Raised = { id }
      this.#raised.set(conv, raised)
      changed = true
      // ★ The card's whole input stays beside it (a team's leader judges by it / `teamHooks.ts` `cardText`)
      void this.#wait(conv, raised, info, w.mark, agyCardTool(w.call)?.input)
    }
    if (await this.#lookQuestions(deps, unsure)) changed = true
    if (await this.#lookChildApprovals(deps)) changed = true
    if (changed) this.#deps.changed()
  }

  /**
   * ★★ Questions (`ask_question` / docs/AGY.md §13), raised as question cards: only from an agy started through the
   * relay that holds the conversation's lock, alone on it, with no child agent running, and of a shape that was measured
   * (`parseAgyQuestion`). Never answered by auto-approve. Returns whether the set of cards changed.
   */
  async #lookQuestions(deps: AgyDeps, unsure: Set<string>): Promise<boolean> {
    if (!this.#deps.answerQuestion) return false
    const tail = this.#deps.tail ?? readTailRecords
    const locksOf = deps.locksOf ?? ((p: number) => agyLocksOf(p, deps.home))
    const want = new Map<string, { state: AgyState; mark: AgyQuestionMark; q: AgyQuestion }>()
    const shared = new Set<string>()
    const firstLook = !this.#qLooked
    for (const pid of agyPidFiles(deps.dir)) {
      if (!deps.isAgy(pid)) continue
      const f = readAgyPidFile(deps.dir, pid)
      if (!f) continue
      const conv = f.state.conversationId
      const path = transcriptPathOf(conv, deps.home)
      if (f.state.confirmationPending) continue
      const ownAt = f.state.agentState === 'tool_use' ? agyQuestionAt(f.state, f.mtimeMs, path, tail) : undefined
      const found = f.state.subagentsActive ? agyChildQuestions(f.state, conv, deps.home, tail) : undefined
      if (ownAt === undefined && !found?.asking.length) continue
      const pane = await agyPaneOf(pid, deps.aliveProcStart ?? aliveProcStartSync)
      if (pane === 'broken' || pane === 'unverified') {
        unsure.add(conv)
        continue
      }
      if (typeof pane === 'string' || f.mtimeMs < pane.startedAt) continue
      const locks = locksOf(pid)
      if (locks === undefined) {
        unsure.add(conv)
        continue
      }
      if (!locks.includes(conv)) continue
      // ★ A blind relay: the questions already up at this agent's first look are left to the PC (they still ring), every
      //   one of them: an agent before a restart may have typed part of an answer, and starting over on a half-done
      //   dialog would toggle off what it toggled on (codex review). With the screen the answer sees the dialog's state.
      if (firstLook && !pane.screen) {
        const ownCall = turnEnd(tail(path)).pending
        if (ownCall?.name === AGY_QUESTION_TOOL && ownCall.at !== undefined) this.#qLeft.add(`${conv}:${pid}::${ownCall.step}:${ownCall.index}:${ownCall.at}`)
        for (const k of found?.asking ?? []) {
          if (k.call.at !== undefined) this.#qLeft.add(`${conv}:${pid}:${k.child}:${k.call.step}:${k.call.index}:${k.call.at}`)
        }
      }
      let pick: { call: PendingCall; askedAt: number; child?: string } | undefined
      if (pane.screen) {
        // ★ With the screen (docs/AGY.md §14): the question the PC shows — its open dialog, else a subagent's banner
        // ⚠️ A running child whose call could not be read may ask the same text: no card (codex / agy review)
        if (found && !found.known) continue
        const seen = await this.#onScreen(pane.socketPath, ownAt !== undefined ? turnEnd(tail(path)).pending : undefined, ownAt, found?.asking ?? [], listAgy(f.state.version), pid)
        if (seen === 'unsure') {
          unsure.add(conv)
          continue
        }
        pick = seen
      } else if (ownAt !== undefined && !f.state.subagentsActive) {
        // its own question (no child running: a child's question could be the one open on the PC)
        pick = { call: turnEnd(tail(path)).pending!, askedAt: ownAt }
      } else if (ownAt === undefined && !listAgy(f.state.version) && f.state.agentState === 'idle' && found?.complete && found.asking.length === 1 && !found.asking[0]!.ambiguous) {
        // (a blind relay opens it with ctrl+k — ⚠️ never on agy 1.5.16+, where ctrl+k approves a subagent's command)
        // the question of its only asking child (ctrl+k opens the one the banner shows; every running child seen)
        const k = found.asking[0]!
        pick = { call: k.call, askedAt: k.askedAt, child: k.child }
      }
      if (!pick) continue
      // ⚠️ A subagent's question is answered only while the parent is idle (`sameChildQuestionNow`): a card raised while
      //    it works would be refused at every answer and raised again (agy review)
      if (pick.child !== undefined && f.state.agentState !== 'idle') continue
      const p = pick.call
      if (!p || p.at === undefined || (pick.child === undefined && !callBeforeState(p, f.mtimeMs))) continue
      const q = parseAgyQuestion(p, pane.screen)
      if (!q) continue
      const sharedNow = want.has(conv) || agyShared(deps.dir, conv, pid, deps.isAgy, locksOf, p.at)
      if (sharedNow === undefined) {
        unsure.add(conv)
        continue
      }
      if (sharedNow) {
        shared.add(conv)
        continue
      }
      want.set(conv, {
        state: f.state,
        mark: { pid, askedAt: pick.askedAt, step: p.step, index: p.index, callAt: p.at, ...(pick.child !== undefined ? { child: pick.child } : {}), ...(pane.screen ? { screen: true as const } : {}) },
        q,
      })
    }
    for (const conv of shared) want.delete(conv)
    this.#qLooked = true
    let changed = false
    for (const [conv, r] of this.#qRaised) {
      const w = want.get(conv)
      if (w && qMarkId(w.mark) === r.id) continue
      if (!w && unsure.has(conv)) continue
      this.#qRaised.delete(conv)
      r.withdraw?.()
      changed = true
    }
    for (const [conv, id] of this.#qAnswered) {
      const w = want.get(conv)
      if (!w && unsure.has(conv)) continue
      if (!w || qMarkId(w.mark) !== id) this.#qAnswered.delete(conv)
    }
    while (this.#qLeft.size > CALL_MEMORY_MAX) this.#qLeft.delete(this.#qLeft.values().next().value as string)
    for (const [conv, w] of want) {
      const id = qMarkId(w.mark)
      const callKey = `${conv}:${qCallId(w.mark)}`
      if (this.#qRaised.has(conv) || this.#qAnswered.get(conv) === id || this.#qLeft.has(callKey) || this.#qTyping.has(callKey)) continue
      const row = agyRow(w.state, { machine: this.#deps.machine, transcriptBytes: 0, lastActivity: new Date(w.mark.askedAt).toISOString(), sendRoute: 'keys', asking: true, outlived: false })
      const info = agyQuestionCard(row, w.mark, w.q, this.#deps.now().toISOString())
      const raised: Raised = { id }
      this.#qRaised.set(conv, raised)
      changed = true
      void this.#waitQuestion(conv, raised, info, w.mark, w.q)
    }
    return changed
  }

  /**
   * ★ Which question the PC shows (docs/AGY.md §14): the one whose dialog is open, else — on the parent's view — the one a
   * subagent's banner names. Only a question whose text no other asking one shares. 'unsure' = the screen cannot be read.
   */
  async #onScreen(
    socketPath: string,
    ownCall: PendingCall | undefined,
    ownAt: number | undefined,
    kids: readonly { child: string; call: PendingCall; askedAt: number }[],
    /** ★ agy 1.5.16+ (`listAgy`): a subagent's question only through the list, never the banner (ctrl+k approves there) */
    listOnly = false,
    /** The agy's pid (the calls found missing from its list / `agyUnlisted`) */
    pid = -1,
  ): Promise<{ call: PendingCall; askedAt: number; child?: string } | undefined | 'unsure'> {
    const screen = await (this.#deps.readScreen ?? readAgyScreen)(socketPath)
    if (screen === undefined) return 'unsure'
    const all: { call: PendingCall; askedAt: number; child?: string; q: AgyQuestion }[] = []
    // ★ The texts of every asking call, also ones the phone does not take: a dialog or banner fitting one of them is not
    //   told apart by its text (codex review); a call not readable at all ⇒ no card while it is up
    const texts: { call: PendingCall; text: string }[] = []
    for (const c of [...(ownCall && ownAt !== undefined ? [ownCall] : []), ...kids.map((k) => k.call)]) {
      const ts = questionTextsOf(c)
      if (ts === undefined) return undefined
      for (const text of ts) texts.push({ call: c, text })
    }
    // ★ No question of the chosen batch shares a text with another call's (the answer refuses that too: a card it would
    //   always refuse came back after each try / agy review), nor does the text shown
    const alone = (call: PendingCall, shown: string, q: AgyQuestion): boolean =>
      !texts.some((x) => x.call !== call && (sameQuestionText(shown, x.text) || q.items.some((it) => sameQuestionText(x.text, it.question))))
    if (ownCall && ownAt !== undefined) {
      const q = parseAgyQuestion(ownCall, true)
      if (q) all.push({ call: ownCall, askedAt: ownAt, q })
    }
    for (const k of kids) {
      const q = parseAgyQuestion(k.call, true)
      if (q) all.push({ call: k.call, askedAt: k.askedAt, child: k.child, q })
    }
    const one = <T>(xs: T[]): T | undefined => (xs.length === 1 ? xs[0] : undefined)
    const gone = (c: { child?: string; call: PendingCall }): boolean => agyUnlisted({ pid, child: c.child, step: c.call.step, index: c.call.index, callAt: c.call.at ?? -1 })
    const d = parseDialog(screen)
    if (d) {
      // ★★ The dialog's owner from the screen (a child's id in the header / the parent's view), and the dialog as the
      //    answer will check it (options, write-in row, ticks)
      const owner = viewOwnerOf(screen)
      if (owner === undefined) return undefined
      // ★ agy 1.5.16: a subagent's dialog is told by its owner first (its id in the header): a sibling's same text does
      //   not make it ambiguous (codex review)
      const byOwner = listOnly && typeof owner === 'object'
      const fitting = all.filter((c) => c.q.items.length === d.of && c.q.items[d.k - 1] !== undefined && dialogFits(d, c.q.items[d.k - 1]!) && (!byOwner || c.child?.toLowerCase() === owner.child))
      const hit = one(fitting)
      if (!hit || (!byOwner && !alone(hit.call, d.question, hit.q))) return undefined
      if (owner === 'parent' ? hit.child !== undefined : hit.child?.toLowerCase() !== owner.child) return undefined
      return hit && { call: hit.call, askedAt: hit.askedAt, ...(hit.child !== undefined ? { child: hit.child } : {}) }
    }
    if (inChildView(screen)) {
      // ★ The PC on a subagent's view with nothing open: the banner is not visible, so the card is the oldest asking
      //   child's question (ctrl+k opens the oldest queued one); the answer goes back to the parent's view first and
      //   checks the banner shows that question before opening it (`answerOnScreen`)
      // ⚠️ Only when the answer could go back (`answerOnScreen`): the viewed child named by its header, nothing pending
      //    there (agy / codex review: a card the answer always refused came back after each try)
      const viewed = childViewOf(screen)
      if (viewed === undefined) return undefined
      // ★ agy 1.5.16: the PC left on an asking subagent's view, its question closed ("a respond"): that question, opened
      //   right there with `a` by the answer (codex review: no card, the wait stranded on the PC)
      if (listOnly) {
        const here = all.find((c) => c.child?.toLowerCase() === viewed)
        const a = parseApproval(screen)
        // (its preview shows this very question: the answer checks the same before `a` / codex review)
        if (here && respondOffered(screen) && a?.tool === 'AskQuestion' && previewAsks(screen, here.q.items[0]!.question) && !gone(here)) return { call: here.call, askedAt: here.askedAt, child: here.child! }
      }
      if (agyPendingCall(transcriptPathOf(viewed, this.#deps.agy().home), this.#deps.tail ?? readTailRecords) !== null) return undefined
      // (agy 1.5.16+: the answer goes back to the parent's view and opens it from the list; ✅ accepted: a list it then
      //  cannot read — a narrow terminal — refuses, and the card comes back. Not offering it left the PC stranded on a
      //  subagent's view after an answer / codex review)
      // ★ The parent's own question (its dialog is drawn on the parent's view, where the answer goes first / agy review)
      const own = all.find((c) => c.child === undefined)
      if (own) return alone(own.call, own.q.items[0]!.question, own.q) ? { call: own.call, askedAt: own.askedAt } : undefined
      // ★ agy 1.5.16: the answer goes back and opens it from the list by its id — the list's rules (the oldest, ties by
      //   id, no text check / codex review: two asking the same stayed off while the PC showed a finished child)
      const kids = all.filter((c) => c.child !== undefined && !(listOnly && gone(c))).sort((a, b) => a.askedAt - b.askedAt || (listOnly ? (a.child! < b.child! ? -1 : 1) : 0))
      const oldest = kids[0]
      if (!oldest) return undefined
      if (listOnly) return { call: oldest.call, askedAt: oldest.askedAt, child: oldest.child! }
      if (kids[1] !== undefined && kids[1].askedAt === oldest.askedAt) return undefined
      if (!alone(oldest.call, oldest.q.items[0]!.question, oldest.q)) return undefined
      return { call: oldest.call, askedAt: oldest.askedAt, child: oldest.child! }
    }
    // ★★ agy 1.5.16: the parent's view lists its subagents (children and deeper / docs/AGY.md §19.2). The answer opens
    //    the very child from that list by its id and checks the question there before a key (`answerOnScreen`), so
    //    which one ctrl+k would open does not matter: the card is the oldest asking subagent's question, whatever its
    //    depth or a sibling's text (§19.1 cases 1–4)
    const rows = viewOwnerOf(screen) === 'parent' ? parseSubagentList(screen) : undefined
    if (rows !== undefined) {
      // (a call the list was walked for whole without finding it is left out: its card would never be answered / codex)
      // (ties broken by the child's id: two asking in the same tick both stayed off / codex review — the answer checks the id)
      const parsed = all.filter((c) => c.child !== undefined && !gone(c)).sort((a, b) => a.askedAt - b.askedAt || (a.child! < b.child! ? -1 : 1))
      // ⚠️ Only when every asking one is in the list (as many rows blocked on a question as calls asking — all of them,
      //    also ones the phone does not take): a killed one's leftover question is not, and its card could never be
      //    answered (codex · agy review)
      const listed = rows.filter((r) => r.blockedOn === 'AskQuestion').length
      // ⚠️ And the answer can go into the list: nothing typed in the PC's box (codex · agy review: a card the answer always
      //    refused came back after each try)
      const box = inputBoxOf(screen)
      if (parsed.length === 0 || listed !== kids.filter((k) => !gone(k)).length || box === undefined || box.some((l) => l.trim() !== '')) return undefined
      const oldest = parsed[0]!
      return { call: oldest.call, askedAt: oldest.askedAt, child: oldest.child! }
    }
    if (listOnly) return undefined
    const banner = parseBanner(screen)
    if (banner === undefined) return undefined
    const hit = one(all.filter((c) => c.child !== undefined && sameQuestionText(banner, c.q.items[0]!.question)))
    if (!hit || !alone(hit.call, banner, hit.q)) return undefined
    return hit && { call: hit.call, askedAt: hit.askedAt, child: hit.child! }
  }

  /**
   * ★ The name the notifier gives this conversation's wait now (`agyQuestionWaitAt`: the newest question asked, its own
   * or a child's), for a ring asked for a question: the answered one may be an older child's (codex review: a ring
   * named after it was dropped while a newer child's question was the wait). Its own time when not readable.
   */
  #waitNameOf(mark: AgyQuestionMark): string {
    const deps = this.#deps.agy()
    const f = readAgyPidFile(deps.dir, mark.pid)
    const at = f ? agyQuestionWaitAt(f.state, f.mtimeMs, deps.home) : undefined
    return new Date(at ?? mark.askedAt).toISOString()
  }

  /**
   * The name of this conversation's wait now when a question asked before `before` (epoch ms) still waits in it (see
   * `#waitNameOf`), else undefined. ⚠️ One asked later rang on its own (codex review: a follow-up rang twice).
   */
  #stillWaitingName(mark: AgyQuestionMark, before: number): string | undefined {
    const deps = this.#deps.agy()
    const f = readAgyPidFile(deps.dir, mark.pid)
    // ★ Also a subagent's approval still up (docs/AGY.md §19, case 8): opening the alert dismissed it too. It rings once
    //   here; the notifier does not ring the older name coming back (`notify.ts` `laterCard` / agy review)
    const at = f ? agyQuestionWaitAt(f.state, f.mtimeMs, deps.home) : undefined
    return at === undefined || at >= before ? undefined : new Date(at).toISOString()
  }

  async #waitQuestion(conv: string, raised: Raised, info: PermissionRequest, mark: AgyQuestionMark, q: AgyQuestion): Promise<void> {
    let settle!: (d: AgyDelivery | undefined) => void
    const mine = new Promise<AgyDelivery | undefined>((r) => (settle = r))
    deliveries.set(info.key, mine)
    const callKey = `${conv}:${qCallId(mark)}`
    try {
      // ★ The question itself stays on the agent: the route builds the keys from it (`questions.ts` rule 1)
      const decision = await waitForDecision(info, (withdraw) => (raised.withdraw = withdraw), {
        toolInput: q as unknown as Record<string, unknown>,
        // ★ The question's own time (`PendingMeta.requestedAt`): the earlier of the call and the ask
        requestedAt: Math.min(mark.callAt, mark.askedAt),
        agyPid: mark.pid,
      })
      if (!decision) return
      if (this.#qRaised.get(conv) === raised) this.#qRaised.delete(conv)
      this.#qAnswered.set(conv, raised.id)
      this.#deps.changed()
      const built = decision.updatedInput as { steps?: unknown; plan?: unknown } | undefined
      // ★ With the screen: what was chosen, typed against it; blind: the fixed keys (a question that does not fit them
      //   never had a card there)
      const answer: AgyQuestionAnswer = mark.screen
        ? decision.behavior === 'allow'
          ? { kind: 'plan', question: q, plan: (built?.plan as AgyAnswerPlan | undefined) ?? { items: [] } }
          : { kind: 'skip', question: q }
        : { kind: 'steps', steps: decision.behavior === 'allow' ? (Array.isArray(built?.steps) ? (built!.steps as AgyStep[]) : []) : skipSteps(q) }
      const steps = answer.kind === 'steps' ? answer.steps : []
      this.#qTyping.add(callKey)
      const started = Date.now()
      const res: AgyDelivery = await this.#deps.answerQuestion!(conv, mark, answer, decision.stillValid).catch(() => ({ ok: false as const, reason: 'unreachable' as const }))
      settle(res)
      // ⚠️ One line, nothing of the question or the answer
      this.#deps.log?.(`[agy] question ${decision.behavior === 'allow' ? 'answer' : 'skip'} conversation=${conv.slice(0, 8)} ${res.ok ? 'typed' : `not typed (${res.reason})`}`)
      if (!res.ok) {
        // ⚠️ Half typed: the PC shows it half answered; raising it again would start over ⇒ left to the PC for good (the
        //    phone is told so). Otherwise it comes back on the next look (if still up)
        //    ★ With the screen it may come back: the next answer reads the dialog's state and puts it right
        if (res.reason === 'partial' && !mark.screen) this.#qLeft.add(`${conv}:${qCallId(mark)}`)
        else if (this.#qAnswered.get(conv) === raised.id) this.#qAnswered.delete(conv)
        // ★ Past the phone's wait it was told "taken" (`permissionAnswer`): "needs you" rings again so the person looks
        //   (codex / agy review: the session waited with no alert)
        if (Date.now() - started >= (this.#deps.deliveryWaitMs ?? AGY_DELIVERY_WAIT_MS)) this.#deps.reraised?.(conv, this.#waitNameOf(mark))
        void this.sync()
        return
      }
      // ★ Only a one-key answer to the parent's own question may come back (nothing half done on the PC): any other is
      //   never raised again from now on, whatever the next looks see (codex review: a sibling's question hid it for a
      //   look, the memory below was dropped, and it came back over a half-done dialog)
      const again = mark.screen === true || (steps.length === 1 && mark.child === undefined)
      if (!again) this.#qLeft.add(`${conv}:${qCallId(mark)}`)
      setTimeout(() => {
        if (this.#qAnswered.get(conv) !== raised.id) {
          // ★ Answered. A question still waiting in this conversation (a second subagent's) rings again: the alert was
          //   named after the newest question, and opening it for the first one dismissed it (codex review)
          const other = this.#stillWaitingName(mark, started)
          if (other !== undefined) this.#deps.reraised?.(conv, other)
          return
        }
        this.#qAnswered.delete(conv)
        // still up: "needs you" rings again so the person looks (on the PC, unless it is shown again)
        this.#deps.log?.(`[agy] question conversation=${conv.slice(0, 8)} still up after the answer; ${again ? 'shown again' : 'left to the PC'}`)
        this.#deps.reraised?.(conv, this.#waitNameOf(mark))
        void this.sync()
      }, this.#deps.unconfirmedMs ?? UNCONFIRMED_MS).unref?.()
    } finally {
      // ★ Only now (after `#qLeft` got it above, in the same run): no look can raise it in between
      this.#qTyping.delete(callKey)
      settle(undefined)
      if (deliveries.get(info.key) === mine) deliveries.delete(info.key)
    }
  }

  /**
   * ★★ Subagents' command approvals (agy 1.5.16+ / docs/AGY.md §19, case 8), raised as approval cards. A child's
   *   transcript shows its call pending whether the command runs or waits for its approval; the parent's list tells the
   *   two apart only by count ⇒ a card only when the list, read on the parent's view, shows as many children blocked on
   *   an approval as there are calls pending (then every one of them waits). The oldest command is raised; one per
   *   conversation. ⚠️ Never auto-approved. Returns whether the set of cards changed.
   */
  async #lookChildApprovals(deps: AgyDeps): Promise<boolean> {
    if (!this.#deps.answerChildApproval) return false
    const tail = this.#deps.tail ?? readTailRecords
    const locksOf = deps.locksOf ?? ((p: number) => agyLocksOf(p, deps.home))
    const want = new Map<string, { state: AgyState; mark: AgyChildApprovalMark; call: PendingCall }>()
    /** conversations whose list could not be read now (the PC on another view): a card up stays while its call does */
    const unread = new Set<string>()
    const shared = new Set<string>()
    for (const pid of agyPidFiles(deps.dir)) {
      if (!deps.isAgy(pid)) continue
      const f = readAgyPidFile(deps.dir, pid)
      if (!f) continue
      const st = f.state
      const conv = st.conversationId
      // (the parent idle with nothing of its own up, children running, an agy with the list)
      if (st.confirmationPending || !st.subagentsActive || st.agentState !== 'idle' || !listAgy(st.version)) continue
      const found = agyChildQuestions(st, conv, deps.home, tail)
      if (!found.known) continue
      const calls = found.calls.filter((c) => c.call.at !== undefined && !agyUnlisted({ pid, child: c.child, step: c.call.step, index: c.call.index, callAt: c.call.at }))
      if (calls.length === 0) continue
      const pane = await agyPaneOf(pid, deps.aliveProcStart ?? aliveProcStartSync)
      if (pane === 'broken' || pane === 'unverified') {
        unread.add(conv)
        continue
      }
      if (typeof pane === 'string' || !pane.screen || f.mtimeMs < pane.startedAt) continue
      const locks = locksOf(pid)
      if (locks === undefined) {
        unread.add(conv)
        continue
      }
      if (!locks.includes(conv)) continue
      const oldest = Math.min(...calls.map((c) => c.call.at!))
      const sharedNow = want.has(conv) || agyShared(deps.dir, conv, pid, deps.isAgy, locksOf, oldest)
      if (sharedNow === undefined) {
        unread.add(conv)
        continue
      }
      if (sharedNow) {
        shared.add(conv)
        continue
      }
      const screen = await (this.#deps.readScreen ?? readAgyScreen)(pane.socketPath)
      const rows = screen !== undefined && !inChildView(screen) && viewOwnerOf(screen) === 'parent' && parseDialog(screen) === undefined ? parseSubagentList(screen) : undefined
      if (rows === undefined) {
        unread.add(conv)
        continue
      }
      // ★ Every pending call waits for its approval only when the counts match (fail-closed: no card otherwise)
      const blocked = rows.filter((r) => r.blockedOn !== undefined && r.blockedOn !== 'AskQuestion').length
      this.#caBlocked.set(conv, { look: this.#begun, blocked })
      if (blocked !== calls.length) continue
      // ⚠️ Something typed in the PC's box: the answer cannot go into the list (it would loop, answered "changed" each
      //    time, and hide the leader's PC-wait notice / agy review) ⇒ no card, as for questions
      const box = inputBoxOf(screen!)
      if (box === undefined || box.some((x) => x.trim() !== '')) continue
      const pick = [...calls].sort((a, b) => a.askedAt - b.askedAt || (a.child < b.child ? -1 : a.child > b.child ? 1 : 0))[0]!
      const command = pick.call.name === 'run_command' ? pick.call.args['CommandLine'] : undefined
      if (typeof command !== 'string' || command === '') continue
      want.set(conv, {
        state: st,
        mark: { pid, child: pick.child, askedAt: pick.askedAt, step: pick.call.step, index: pick.call.index, callAt: pick.call.at!, command },
        call: pick.call,
      })
    }
    for (const conv of shared) want.delete(conv)
    /** a card whose list could not be read now: kept while the child's call is still the one (its transcript unwritten) */
    const stillPending = (m: AgyChildApprovalMark): boolean => {
      const p = agyPendingCall(transcriptPathOf(m.child, deps.home), tail)
      return !!p && p.mtimeMs === m.askedAt && p.call.step === m.step && p.call.index === m.index && p.call.at === m.callAt
    }
    let changed = false
    for (const [conv, r] of this.#caRaised) {
      const w = want.get(conv)
      if (w && caMarkId(w.mark) === r.id) continue
      if (!w && unread.has(conv) && stillPending(r.mark)) continue
      this.#caRaised.delete(conv)
      r.withdraw?.()
      changed = true
    }
    for (const [conv, id] of this.#caAnswered) {
      const w = want.get(conv)
      if (!w && unread.has(conv)) continue
      if (!w || caMarkId(w.mark) !== id) this.#caAnswered.delete(conv)
    }
    for (const [conv, w] of want) {
      const id = caMarkId(w.mark)
      if (this.#caRaised.has(conv) || this.#caTyping.has(caCallId(conv, w.mark))) continue
      if (this.#caAnswered.get(conv) === id) {
        if (Date.now() - (this.#caAnsweredAt.get(conv) ?? 0) < (this.#deps.childAnsweredMs ?? CA_ANSWERED_MS)) continue
        this.#caAnswered.delete(conv)
      }
      const row = agyRow(w.state, { machine: this.#deps.machine, transcriptBytes: 0, lastActivity: new Date(w.mark.askedAt).toISOString(), sendRoute: 'keys', asking: true, outlived: false })
      const info = agyChildApprovalCard(row, w.mark, w.call, this.#deps.now().toISOString())
      if (!info) continue
      const raised = { id, mark: w.mark }
      this.#caRaised.set(conv, raised)
      changed = true
      void this.#waitChildApproval(conv, raised, info, w.mark, agyCardTool(w.call)?.input)
    }
    return changed
  }

  /** The name the notifier gives this conversation's wait now (`agyQuestionWaitAt`), else `fallback` */
  #waitNameOfConv(pid: number, fallback: number): string {
    const deps = this.#deps.agy()
    const f = readAgyPidFile(deps.dir, pid)
    const at = f ? agyQuestionWaitAt(f.state, f.mtimeMs, deps.home) : undefined
    return new Date(at ?? fallback).toISOString()
  }

  async #waitChildApproval(conv: string, raised: Raised, info: PermissionRequest, mark: AgyChildApprovalMark, toolInput?: Record<string, string>): Promise<void> {
    let settle!: (d: AgyDelivery | undefined) => void
    const mine = new Promise<AgyDelivery | undefined>((r) => (settle = r))
    deliveries.set(info.key, mine)
    try {
      const decision = await waitForDecision(info, (withdraw) => (raised.withdraw = withdraw), { ...(toolInput ? { toolInput } : {}), requestedAt: mark.callAt, agyPid: mark.pid })
      if (!decision) return
      if (this.#caRaised.get(conv) === raised) this.#caRaised.delete(conv)
      this.#caAnswered.set(conv, raised.id)
      this.#caAnsweredAt.set(conv, Date.now())
      this.#deps.changed()
      const behavior = decision.behavior === 'allow' ? 'allow' : 'deny'
      const started = Date.now()
      const typing = caCallId(conv, mark)
      this.#caTyping.add(typing)
      const res: AgyDelivery = await this.#deps.answerChildApproval!(conv, mark, behavior, decision.stillValid)
        .catch(() => ({ ok: false as const, reason: 'unreachable' as const }))
        .finally(() => this.#caTyping.delete(typing))
      settle(res)
      // ⚠️ One line, no command text
      this.#deps.log?.(`[agy] subagent card ${behavior} conversation=${conv.slice(0, 8)} ${res.ok ? 'typed' : `not typed (${res.reason})`}`)
      if (res.ok) {
        const answeredAt = Date.now()
        const answeredLook = this.#begun
        // ★ After a moment, with a look made since whose list was read: the same call still blocked there ⇒ the key did
        //   not take, it comes back (rule 4c, as a card's)
        //   ⚠️ Looked again (bounded) until a list is read: one unreadable look must not keep it off for good (codex review)
        const unconfirmed = this.#deps.unconfirmedMs ?? UNCONFIRMED_MS
        const giveUp = answeredAt + unconfirmed * 5
        const confirm = (): void => {
          void this.fresh().then(() => {
            const seen = this.#caBlocked.get(conv)
            if (seen === undefined || seen.look <= answeredLook) {
              if (Date.now() < giveUp && this.#caAnswered.get(conv) === raised.id) setTimeout(confirm, Math.max(20, unconfirmed / 3)).unref?.()
              return
            }
            if (this.#caAnswered.get(conv) === raised.id) {
              this.#caAnswered.delete(conv)
              this.#deps.log?.(`[agy] subagent card ${behavior} conversation=${conv.slice(0, 8)} still up after the key; shown again`)
              this.#deps.reraised?.(conv, this.#waitNameOfConv(mark.pid, mark.askedAt))
              void this.sync()
            }
          })
        }
        setTimeout(confirm, unconfirmed).unref?.()
        // ★ Another wait still up (a sibling's approval, a child's question) once the list was read since the answer —
        //   by `blocked.ts`, which reads it whatever the parent does and through wrapped rows ⇒ "needs you" rings again:
        //   opening the alert for this one dismissed it (codex · agy review). Asked for a while, then given up.
        const again = (): void => {
          const readAt = agyBlockedReadAt(conv)
          if (readAt === undefined || readAt <= answeredAt) {
            if (Date.now() < giveUp) setTimeout(again, Math.max(20, unconfirmed / 3)).unref?.()
            return
          }
          const deps = this.#deps.agy()
          const f = readAgyPidFile(deps.dir, mark.pid)
          if (!f) return
          const asking = agyChildQuestions(f.state, conv, deps.home, this.#deps.tail ?? readTailRecords).asking.length > 0
          if (agyBlockedWaits(f.state).length > 0 || asking) this.#deps.reraised?.(conv, this.#waitNameOfConv(mark.pid, mark.askedAt))
        }
        setTimeout(again, unconfirmed).unref?.()
      }
      if (!res.ok) {
        // not typed ⇒ it may come back on the next look (if the list still shows it)
        if (this.#caAnswered.get(conv) === raised.id) this.#caAnswered.delete(conv)
        // ★ Past the phone's wait it was told "taken": "needs you" rings again (as a card's)
        if (Date.now() - started >= (this.#deps.deliveryWaitMs ?? AGY_DELIVERY_WAIT_MS)) this.#deps.reraised?.(conv, this.#waitNameOfConv(mark.pid, mark.askedAt))
        void this.sync()
      }
    } finally {
      settle(undefined)
      if (deliveries.get(info.key) === mine) deliveries.delete(info.key)
    }
  }

  /** Rule 5b: type `1` for a card auto-approve passes; a key that does not land sends the card to the phone */
  async #autoAnswer(conv: string, id: string, mark: AgyCardMark, stillOn: () => boolean): Promise<void> {
    const res: AgyDelivery = await this.#deps.answer(conv, mark, 'allow', stillOn).catch(() => ({ ok: false as const, reason: 'unreachable' as const }))
    // ⚠️ One line, no command text
    this.#deps.log?.(`[agy] card allow (auto-approve) conversation=${conv.slice(0, 8)} ${res.ok ? 'typed' : `not typed (${res.reason})`}`)
    // ⚠️ Not tied to `#auto` still holding this try: a look that could not read the transcript for a moment drops it, and
    //    the card then stayed quiet with no fallback (codex review). Once per call.
    const toPhone = (): void => {
      if (this.#auto.get(conv)?.id === id) this.#auto.delete(conv)
      if (this.#onPhone.has(`${conv}:${callId(mark)}`)) return
      this.#onPhone.add(`${conv}:${callId(mark)}`)
      if (this.#answered.get(conv) === id) this.#answered.delete(conv)
      // `once`: it has not been on the phone; a "needs you" already sent for this card is enough (codex review: two)
      this.#deps.reraised?.(conv, cardName(conv, mark), true)
      void this.sync()
    }
    if (!res.ok) {
      // ⚠️ Every failure goes to the phone, `changed` too: it also covers "turned off meanwhile" and a final check that
      //    could not tell (a slow lock probe), where the card is still up (codex review: it stayed quiet and was typed
      //    later). A card that really went away is not raised (the look no longer sees it) and its ring is dropped.
      toPhone()
      return
    }
    setTimeout(() => {
      if (this.#answered.get(conv) !== id || this.#auto.get(conv)?.id !== id) return
      this.#deps.log?.(`[agy] card allow (auto-approve) conversation=${conv.slice(0, 8)} still up after the key; sent to the phone`)
      toPhone()
    }, this.#deps.unconfirmedMs ?? UNCONFIRMED_MS).unref?.()
  }

  async #wait(conv: string, raised: Raised, info: PermissionRequest, mark: AgyCardMark, toolInput?: Record<string, string>): Promise<void> {
    let settle!: (d: AgyDelivery | undefined) => void
    const mine = new Promise<AgyDelivery | undefined>((r) => (settle = r))
    deliveries.set(info.key, mine)
    try {
      await this.#answerOnce(conv, raised, info, mark, settle, toolInput)
    } finally {
      settle(undefined)
      // ⚠️ The same card raised again keeps its key: never remove the newer one's entry
      if (deliveries.get(info.key) === mine) deliveries.delete(info.key)
    }
  }

  async #answerOnce(conv: string, raised: Raised, info: PermissionRequest, mark: AgyCardMark, settle: (d: AgyDelivery) => void, toolInput?: Record<string, string>): Promise<void> {
    const decision = await waitForDecision(
      info,
      (withdraw) => {
        raised.withdraw = withdraw
      },
      // ★ With the call's own time: a team's leader judges "after the grant" by it (`PendingMeta.requestedAt`)
      { ...(toolInput ? { toolInput } : {}), requestedAt: mark.callAt, agyPid: mark.pid },
    )
    // withdrawn (rule 3) or replaced: nothing to type
    if (!decision) return
    if (this.#raised.get(conv) === raised) this.#raised.delete(conv)
    this.#answered.set(conv, raised.id)
    this.#deps.changed()
    const behavior = decision.behavior === 'allow' ? 'allow' : 'deny'
    const started = Date.now()
    // ★ A team's leader's answer is asked again right before the key (`Decision.stillValid`: the team still there)
    const res: AgyDelivery = await this.#deps.answer(conv, mark, behavior, decision.stillValid).catch(() => ({ ok: false as const, reason: 'unreachable' as const }))
    settle(res)
    // ⚠️ One line, no command text (the card and the PC's screen are the only traces of it)
    this.#deps.log?.(`[agy] card ${behavior} conversation=${conv.slice(0, 8)} ${res.ok ? 'typed' : `not typed (${res.reason})`}`)
    // ★ Answered with children running: a subagent's wait still up from before (an approval, a question) rings again
    //   once this card is gone — opening the alert for this card dismissed it, and the older wait's name does not ring
    //   by itself (codex · agy review)
    if (res.ok) {
      setTimeout(() => {
        const deps = this.#deps.agy()
        const f = readAgyPidFile(deps.dir, mark.pid)
        if (!f || f.state.confirmationPending || !f.state.subagentsActive) return
        const at = agyQuestionWaitAt(f.state, f.mtimeMs, deps.home)
        if (at !== undefined && at < started) this.#deps.reraised?.(conv, new Date(at).toISOString())
      }, this.#deps.unconfirmedMs ?? UNCONFIRMED_MS).unref?.()
    }
    if (!res.ok) {
      // Rule 4: not typed ⇒ the card may come back on the next look (if it is still up)
      if (this.#answered.get(conv) === raised.id) this.#answered.delete(conv)
      // ★ Past the phone's wait it was told "taken" (`permissionAnswer`): "needs you" rings again (agy review)
      if (Date.now() - started >= (this.#deps.deliveryWaitMs ?? AGY_DELIVERY_WAIT_MS)) this.#deps.reraised?.(conv, cardName(conv, mark))
      void this.sync()
      return
    }
    // ★ Rule 4c: a written key has no acknowledgement (the relay can still refuse the connection after the kernel took
    //   the byte). agy rewrites its state within ~50 ms of an answer, so the same card still up after
    //   `UNCONFIRMED_MS` did not get it: it comes back on the phone (codex review)
    setTimeout(() => {
      if (this.#answered.get(conv) !== raised.id) {
        // ★ The same call still up under a new mark (agy rewrote its state meanwhile: the card came back with a new key,
        //   and its name stays the same, so the notifier would not ring it / codex review): "needs you" again
        if (this.#upCall.get(conv) !== callId(mark)) return
        this.#deps.log?.(`[agy] card ${behavior} conversation=${conv.slice(0, 8)} still up after the key (rewritten); shown again`)
        this.#deps.reraised?.(conv, cardName(conv, mark))
        return
      }
      this.#answered.delete(conv)
      this.#deps.log?.(`[agy] card ${behavior} conversation=${conv.slice(0, 8)} still up after the key; shown again`)
      this.#deps.reraised?.(conv, cardName(conv, mark))
      void this.sync()
    }, this.#deps.unconfirmedMs ?? UNCONFIRMED_MS).unref?.()
  }
}
