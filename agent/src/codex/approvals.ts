// ★★ Approvals for Codex threads, on one connection to the daemon (2026-11-14 / docs/CODEX.md §5).
//
// How it works (each step measured on codex-cli 0.169.0; see docs/CODEX.md §3):
//   - A connection that only listens never receives approval requests. `thread/resume` (thread id and
//     `excludeTurns`, nothing else) joins the thread, and the daemon **replays** the requests that are waiting.
//   - Answering `accept` / `decline` from this connection closes the approval in the TUI too.
//   - When the TUI answers first, `serverRequest/resolved` arrives and our card must go away.
//
// The rules:
//  1. ⚠️⚠️ **Join only a thread that is waiting on an approval right now**, and leave (`thread/unsubscribe`) once it is
//     not and no card is left. `thread/resume` on a thread that is not running would load it.
//  2. ⚠️⚠️ **Only the plain command approval, a question (`questions.ts`) and a file change with its diff
//     (`fileChanges.ts`) become cards.** Everything else that
//     arrives after joining (a file change whose diff could not be read, network rules, extra permissions, kinds we do
//     not know) is **not answered**
//     — not with a result, not with an error. The TUI answers those.
//     ★ A question is answered with labels and notes the agent checks (`questions.ts`), or stopped: "stop" on the phone
//       sends `turn/interrupt` for the turn that asks (what ESC does in the TUI). ⚠️ Never an empty answer or an error
//       (both resolve the question as "no answer" and the model goes on).
//  3. ⚠️⚠️ **Only a plain yes or a plain no is ever sent, and only one the daemon offered** (`availableDecisions`).
//     Yes is `accept`. No is `decline` when offered, otherwise `cancel` — 0.169.0 offers `accept` / (a policy
//     amendment) / `cancel` for a plain command, and `cancel` is what "No" in the TUI sends: the command is denied
//     **and the turn is interrupted**. Nothing that lasts longer than this one command (`acceptForSession`,
//     policy amendments) is offered or built.
//  4. ⚠️⚠️ **A card belongs to this connection.** When the line ends every card is withdrawn; a reconnect makes new
//     ones from the replay (an old answer must never reach the same request id on a new connection).
//  5. A card that is withdrawn is never answered to the daemon (withdrawn = "decided elsewhere or gone").
//     ⚠️⚠️ **Withdrawing removes the card at once, and the answer is written only while the card is still there**
//     (`respond`'s guard, asked right before the bytes go out). A decision that was already made — auto-approve answers
//     at once — must not be sent after the thread closed or stopped waiting (codex review, medium #5).

import type { RpcId, RpcResult, ServerRequest } from './rpc.ts'
import { parseUserInput, type CodexAnswers, type CodexQuestion } from './questions.ts'
import { parseFileChangeRequest, type CodexFileChange, type FileChange } from './fileChanges.ts'

export const COMMAND_APPROVAL_METHOD = 'item/commandExecution/requestApproval'

/** A join that failed is tried again this many times in all (while the thread still waits), `JOIN_RETRY_MS × n` apart */
export const JOIN_TRIES = 4
export const JOIN_RETRY_MS = 1000

/** What may be sent to the daemon. ⚠️ Never widen this (rule 3). */
export type CodexDecision = 'accept' | 'decline' | 'cancel'
/** What the phone decides */
export type PhoneDecision = 'yes' | 'no'
/** What a card waits on */
export type WaitKind = 'approval' | 'answer'
/** What the phone does with a question: answers (built by the agent), or stop the turn that asks */
export type QuestionReply = { type: 'answers'; result: CodexAnswers } | { type: 'stop' }

/** One approval the phone can answer */
export interface CodexApproval {
  requestId: RpcId
  threadId: string
  turnId: string
  itemId: string
  /** The command exactly as the daemon sent it (shown to the person; never rewritten) */
  command: string
  cwd?: string
  /** What a "no" is sent as (rule 3: one of the answers the daemon offered) */
  no: 'decline' | 'cancel'
}

export interface ApprovalsDeps {
  /** `guard` is asked right before the request is written; false ⇒ not sent */
  call(method: string, params: unknown, guard?: () => boolean): Promise<RpcResult>
  /** `guard` is asked right before the answer is written; false ⇒ not sent */
  respond(id: RpcId, result: unknown, guard: () => boolean): Promise<boolean>
  /**
   * Whether this thread is a listed row whose status says it waits, right now: on an approval (`approval`), on an
   * answer (`answer`), or on whichever this line takes (absent; used to join and leave).
   * ⚠️ A card is judged by its own kind (codex review, 2026-11-16, medium): a thread can stop waiting on the answer
   *    while it still waits on an approval, and the question card must go then.
   */
  isWaiting(threadId: string, on?: WaitKind): boolean
  /** Resolves after `ms` (or early when the line is stopping) */
  sleep(ms: number): Promise<void>
  /**
   * Show the card and wait. Resolves with the phone's decision, or `undefined` when the card went away without one.
   * `onWithdraw` registers the function that takes the card away.
   */
  offer(approval: CodexApproval, onWithdraw: (withdraw: () => void) => void): Promise<PhoneDecision | undefined>
  /**
   * The same for a file change, once its diff was found. Absent ⇒ file changes are left to the PC.
   * ⚠️ Given together with `fetchChanges` only.
   */
  offerFileChange?(change: CodexFileChange, onWithdraw: (withdraw: () => void) => void): Promise<PhoneDecision | undefined>
  /** Find the diff of a pending file change (`undefined` = not found ⇒ no card / `fileChanges.ts` rule 1) */
  fetchChanges?(threadId: string, turnId: string, itemId: string, live: () => boolean): Promise<FileChange[] | undefined>
  /** The same for a question. Absent ⇒ questions are left to the PC (never answered). */
  ask?(question: CodexQuestion, onWithdraw: (withdraw: () => void) => void): Promise<QuestionReply | undefined>
  log?: (line: string) => void
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function present(v: unknown): boolean {
  return v !== undefined && v !== null
}

/**
 * Read a server request as an approval the phone can answer. `undefined` = not ours to answer (rule 2).
 *
 * ⚠️ Everything here is another program's output: a field that is missing or has the wrong type means "not ours",
 *    never a default.
 */
export function parseCommandApproval(req: ServerRequest): CodexApproval | undefined {
  if (req.method !== COMMAND_APPROVAL_METHOD || !isObject(req.params)) return undefined
  const p = req.params
  // ⚠️ `humanCommand` needs a capability we do not declare and a fresh human decision; `writeStdin` is not a command
  if (p.kind !== 'command') return undefined
  const threadId = text(p.threadId)
  const turnId = text(p.turnId)
  const itemId = text(p.itemId)
  const command = text(p.command)
  if (!threadId || !turnId || !itemId || !command) return undefined
  // ⚠️ These ask for more than "run this command once": a network rule, or permissions beyond the sandbox.
  //    A yes/no card would hide what is really being granted.
  if (present(p.networkApprovalContext) || present(p.additionalPermissions)) return undefined
  // ⚠️ Rule 3: a yes and a no must both be on offer. Absent list = the plain pair (the field is optional).
  let no: 'decline' | 'cancel' = 'decline'
  if (present(p.availableDecisions)) {
    const offered: unknown = p.availableDecisions
    if (!Array.isArray(offered) || !offered.includes('accept')) return undefined
    if (offered.includes('decline')) no = 'decline'
    else if (offered.includes('cancel')) no = 'cancel'
    else return undefined
  }
  const cwd = text(p.cwd)
  return { requestId: req.id, threadId, turnId, itemId, command, ...(cwd ? { cwd } : {}), no }
}

interface Card {
  threadId: string
  waitsOn: WaitKind
  withdraw: () => void
}

/** `1` and `"1"` are different request ids */
function idKey(id: RpcId): string {
  return `${typeof id}:${id}`
}

export class CodexApprovals {
  readonly #deps: ApprovalsDeps
  /** Threads we have joined with `thread/resume` */
  readonly #joined = new Set<string>()
  /** Per-thread chain: join / leave one at a time, in order */
  readonly #chains = new Map<string, Promise<void>>()
  readonly #cards = new Map<string, Card>()
  /** Per thread: how many joins in a row failed */
  readonly #joinFailures = new Map<string, number>()
  #disposed = false

  constructor(deps: ApprovalsDeps) {
    this.#deps = deps
  }

  /** The thread's status changed (or it was just read). Join or leave to match. */
  sync(threadId: string): void {
    // ★ No longer waiting on what the card waits for ⇒ the card is stale whether or not `serverRequest/resolved` came
    //   (e.g. the turn was interrupted). If a request is in fact still waiting, the status says so again and the join
    //   replays it.
    for (const [key, card] of [...this.#cards]) {
      if (card.threadId === threadId && !this.#deps.isWaiting(threadId, card.waitsOn)) this.#withdraw(key, card)
    }
    const prev = this.#chains.get(threadId) ?? Promise.resolve()
    const next = prev.then(() => this.#reconcile(threadId)).catch(() => undefined)
    this.#chains.set(threadId, next)
    void next.then(() => {
      if (this.#chains.get(threadId) === next) this.#chains.delete(threadId)
    })
  }

  async #reconcile(threadId: string): Promise<void> {
    if (this.#disposed) return
    // ⚠️ Looked up now, not when `sync` was called (the status may have moved on while we waited in the chain)
    const waiting = this.#deps.isWaiting(threadId)
    if (!waiting) this.#joinFailures.delete(threadId)
    if (waiting && !this.#joined.has(threadId)) {
      // ⚠️⚠️ Rule 1: these two fields only. No overrides, no history.
      // ⚠️ Asked again right before writing: a join queued behind a slow line must not go out for a thread that
      //    stopped waiting meanwhile (`thread/resume` on a thread that is not running would load it)
      const res = await this.#deps.call('thread/resume', { threadId, excludeTurns: true }, () => !this.#disposed && this.#deps.isWaiting(threadId))
      if (res.ok) {
        this.#joined.add(threadId)
        this.#joinFailures.delete(threadId)
        return
      }
      this.#deps.log?.(`[codex] could not join a thread waiting on an approval (${res.failure.type})`)
      // ⚠️⚠️ Try again while it still waits (codex 2026-11-15, ninth review, medium): a join that timed out behind a
      //    slow line was never written, and a thread that keeps waiting has no new status change to try again — the
      //    approval then never reached the phone. Bounded; `cancelled` = it stopped waiting or the line ended.
      const n = (this.#joinFailures.get(threadId) ?? 0) + 1
      if (res.failure.type === 'cancelled' || n >= JOIN_TRIES) {
        this.#joinFailures.delete(threadId)
        return
      }
      this.#joinFailures.set(threadId, n)
      // ★ `sync` looks at the thread again (and does nothing once the line is over or it stopped waiting)
      void this.#deps.sleep(JOIN_RETRY_MS * n).then(() => this.sync(threadId))
      return
    }
    if (!waiting && this.#joined.has(threadId) && !this.#hasCard(threadId)) {
      this.#joined.delete(threadId)
      await this.#deps.call('thread/unsubscribe', { threadId })
    }
  }

  /** Rule 5: the card is gone **before** anyone is told (so an answer already on its way finds it missing) */
  #withdraw(key: string, card: Card): void {
    if (this.#cards.get(key) === card) this.#cards.delete(key)
    card.withdraw()
  }

  #hasCard(threadId: string): boolean {
    for (const card of this.#cards.values()) if (card.threadId === threadId) return true
    return false
  }

  /**
   * A server request arrived. Returns whether it became a card (`false` = left unanswered for the TUI).
   */
  onServerRequest(req: ServerRequest): boolean {
    if (this.#disposed) return false
    const approval = parseCommandApproval(req)
    if (!approval) return this.#onQuestion(req) || this.#onFileChange(req)
    // ⚠️ Only for a thread we list and that says it is waiting (an id from the wire is not trusted on its own)
    if (!this.#deps.isWaiting(approval.threadId, 'approval')) return false
    const key = idKey(approval.requestId)
    // ★ The same request replayed (a second join) replaces the card; the old one ends without a decision
    const old = this.#cards.get(key)
    if (old) this.#withdraw(key, old)

    let withdrawFn: () => void = () => undefined
    const decided = this.#deps.offer(approval, (w) => {
      withdrawFn = w
    })
    const card: Card = { threadId: approval.threadId, waitsOn: 'approval', withdraw: () => withdrawFn() }
    this.#cards.set(key, card)
    // ★ Asked right before the bytes go out: still this card, and the thread still says it waits on an approval
    const live = (): boolean => !this.#disposed && this.#cards.get(key) === card && this.#deps.isWaiting(approval.threadId, 'approval')
    void decided.then(async (decision) => {
      // ⚠️ Rule 5: no decision, or the card was withdrawn / replaced / the line ended ⇒ say nothing to the daemon.
      //    ⚠️ The card stays in place while the answer waits to be written, so a withdrawal meanwhile still stops it.
      if (decision !== undefined && live()) {
        const sent: CodexDecision = decision === 'yes' ? 'accept' : approval.no
        await this.#deps.respond(approval.requestId, { decision: sent }, live)
      }
      if (this.#cards.get(key) === card) this.#cards.delete(key)
      if (!this.#disposed) this.sync(approval.threadId)
    })
    return true
  }

  /**
   * A file change (rule 2). The card is held while its diff is looked up; a replay or a withdrawal meanwhile means
   * it is never offered. No diff ⇒ nothing is shown and nothing is answered (the PC answers).
   */
  #onFileChange(req: ServerRequest): boolean {
    const offer = this.#deps.offerFileChange
    const fetch = this.#deps.fetchChanges
    if (!offer || !fetch) return false
    const request = parseFileChangeRequest(req)
    if (!request) return false
    if (!this.#deps.isWaiting(request.threadId, 'approval')) return false
    const key = idKey(request.requestId)
    const old = this.#cards.get(key)
    if (old) this.#withdraw(key, old)

    let withdrawFn: () => void = () => undefined
    const card: Card = { threadId: request.threadId, waitsOn: 'approval', withdraw: () => withdrawFn() }
    this.#cards.set(key, card)
    const live = (): boolean => !this.#disposed && this.#cards.get(key) === card && this.#deps.isWaiting(request.threadId, 'approval')
    const done = (): void => {
      if (this.#cards.get(key) === card) this.#cards.delete(key)
      if (!this.#disposed) this.sync(request.threadId)
    }
    void (async () => {
      // ★ "Is this request still shown?" by its id, not by this card: a replay replaces the card and shares the lookup
      const requestLive = (): boolean =>
        !this.#disposed && this.#cards.has(key) && this.#deps.isWaiting(request.threadId, 'approval')
      const changes = await fetch(request.threadId, request.turnId, request.itemId, requestLive).catch(() => undefined)
      // ⚠️ Withdrawn, replaced or no longer waiting while we looked ⇒ never offered
      if (!live()) return done()
      if (!changes) {
        this.#deps.log?.('[codex] a file change waits on an approval, but its diff could not be read (left to the PC)')
        return done()
      }
      const decision = await offer({ ...request, changes }, (w) => {
        withdrawFn = w
      })
      if (decision !== undefined && live()) {
        // ★ "No" is `cancel`: what "No" in the TUI sends (the patch is rejected and the turn stops)
        await this.#deps.respond(request.requestId, { decision: decision === 'yes' ? 'accept' : 'cancel' }, live)
      }
      done()
    })()
    return true
  }

  /** A question (rule 2). Same card life as an approval: replaced on replay, withdrawn when resolved or gone. */
  #onQuestion(req: ServerRequest): boolean {
    const ask = this.#deps.ask
    if (!ask) return false
    const question = parseUserInput(req)
    if (!question) return false
    if (!this.#deps.isWaiting(question.threadId, 'answer')) return false
    const key = idKey(question.requestId)
    const old = this.#cards.get(key)
    if (old) this.#withdraw(key, old)

    let withdrawFn: () => void = () => undefined
    const decided = ask(question, (w) => {
      withdrawFn = w
    })
    const card: Card = { threadId: question.threadId, waitsOn: 'answer', withdraw: () => withdrawFn() }
    this.#cards.set(key, card)
    // ★ Asked right before the bytes go out: still this card, and the thread still says it waits on an answer
    //   (a late Stop must not interrupt a turn whose question is over)
    const live = (): boolean => !this.#disposed && this.#cards.get(key) === card && this.#deps.isWaiting(question.threadId, 'answer')
    void decided.then(async (reply) => {
      if (reply !== undefined && live()) {
        if (reply.type === 'answers') {
          await this.#deps.respond(question.requestId, reply.result, live)
        } else {
          // ★ What ESC does in the TUI: the turn that asks ends `interrupted`, and the daemon resolves the question.
          //   ⚠️ Named by the turn that asks (a later turn is never stopped by this press). A stop that did not go
          //      through leaves the question to the PC (the thread still says it waits, so the list shows it).
          const res = await this.#deps.call('turn/interrupt', { threadId: question.threadId, turnId: question.turnId }, live)
          if (!res.ok) this.#deps.log?.(`[codex] could not stop the turn that asks (${res.failure.type})`)
        }
      }
      if (this.#cards.get(key) === card) this.#cards.delete(key)
      if (!this.#disposed) this.sync(question.threadId)
    })
    return true
  }

  /** `serverRequest/resolved`: somebody answered (the TUI, or us). */
  onResolved(params: unknown): void {
    if (!isObject(params)) return
    const id = params.requestId
    if (typeof id !== 'number' && typeof id !== 'string') return
    const key = idKey(id)
    const card = this.#cards.get(key)
    // ⚠️ The thread must match too (request ids are only unique per connection, and this is input from outside)
    if (card && card.threadId === params.threadId) this.#withdraw(key, card)
  }

  /** How many cards are showing (for diagnostics) */
  get cards(): number {
    return this.#cards.size
  }

  /** The line is over (rule 4). Nothing is sent. */
  dispose(): void {
    this.#disposed = true
    for (const [key, card] of [...this.#cards]) this.#withdraw(key, card)
    this.#cards.clear()
    this.#joined.clear()
    this.#joinFailures.clear()
  }
}
