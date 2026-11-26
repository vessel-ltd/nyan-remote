// ★★ Push notifications for Codex threads (2026-11-14 / docs/CODEX.md §5).
//
// Input: status changes of listed threads (`thread/status/changed`, which reaches us without joining the thread).
// Output: at most one push per turn and state — "done", "needs you", "failed", "rate-limited" — in the same words as the list.
//
// The rules:
//  1. ⚠️⚠️ **The words come from the row** (`statusLabel(row.status)`), read after everything is settled. The list and
//     the notification can then not disagree (CLAUDE.md §2: deciding the state in two places always drifts).
//  2. ⚠️⚠️ **`idle` is not "done" until the history says so.** A failed or interrupted turn also ends in `idle`, and
//     right after the change the history can still say `interrupted / no error` for a turn that then becomes `failed`
//     (measured, ~0.5 s). ⇒ read the newest turn, retry a few times, and **if it never settles, send nothing**.
//  3. An **interrupted** turn sends nothing (someone stopped it by hand) and the row goes back to plain idle.
//  4. Same turn and same words ⇒ not sent again. ⚠️ Remembered **only when a send succeeded** (remembering a failure
//     would swallow the next identical state forever).
//  5. Never conversation content: the title goes through `notificationText`, which only lets AI titles through.
//  6. One thread's changes are handled one at a time, in order.
//  7. ★ While auto-approve is on for the thread, "needs you" waits a moment (`AUTO_GRACE_MS`) and is dropped when
//     the approval was answered meanwhile or a newer change arrived. Without this every auto-approved command would
//     push once (and stack on iOS). ⚠️ An approval that auto-approve does not answer still notifies, just later.
//  8. ⚠️⚠️ **Before it changes the row or sends, the change must still be the thread's current status** (`mark`, third review, medium #2).
//     A history read that answers late is about a turn that may already be followed by another one: its outcome must
//     not land on the newer turn, and it must not speak for it. The newer change is handled in its own right.
//  9. ★ A turn that failed at a plan or spend limit says "rate-limited" (2026-11-26). Codex shows such a thread as
//     `systemError` (any turn error does, until the next turn), so `systemError` reads the turn as well; when the read
//     does not say "limit" it is "failed" as before (it only waits for the turn to read as ended, a few reads at most).
//     ★ `quiet`: settle the row's words only, never send (the first connection: the agent just started).
//       ⚠️ Not "counted as told": that swallowed a real alert whose send had reached nobody (round 4). A reconnect may
//       therefore ring once for a limit that stood when the agent started (it rang "failed" there before).
//     ★ A turn once read as a limit stays one (`#limitTurns`): a reconnect's read that does not show it ended yet does
//       not turn the row back into "failed".

import type { NotifyFields, PushPayload, SessionSummary } from '../../../shared/types.ts'
import { statusLabel } from '../../../shared/types.ts'
import type { TurnsPage } from './history.ts'
import type { StatusChange, TurnOutcome } from './threads.ts'

/** How many times the newest turn is read while waiting for it to settle, and the pause between reads */
export const SETTLE_TRIES = 5
export const SETTLE_PAUSE_MS = 400
/** Rule 7: how long "needs you" waits while auto-approve is on */
export const AUTO_GRACE_MS = 2000

export interface CodexNotifyDeps {
  /** The row as the list shows it **now** (`undefined` = not listed any more) */
  row(threadId: string): SessionSummary | undefined
  turns(threadId: string, opts: { limit: number; headersOnly: true }): Promise<TurnsPage | undefined>
  /** `mark`: the change it was settled for (refused if the thread's status moved since) */
  setOutcome(threadId: string, outcome: TurnOutcome, mark: number): void
  /** Which status of the thread is current (`StatusChange.mark`); `undefined` = not listed */
  mark(threadId: string): number | undefined
  /** Build the payload from the fields (the one text builder) and send it. Returns how many devices got it. */
  /** @param turn the turn this change is about, when known (teams read that turn's last words / `teamHooks.ts`) */
  send(row: SessionSummary, fields: NotifyFields, turn?: string, current?: () => boolean): Promise<number>
  sleep(ms: number): Promise<void>
  /** Whether auto-approve is in effect for this thread right now (rule 7). Absent = never. */
  autoApproving?(threadId: string): boolean
  log?: (line: string) => void
}

type Changed = Extract<StatusChange, { type: 'changed' }>

interface Sent {
  turn: string | undefined
  label: string
}

const MAX_REMEMBERED = 500

export class CodexNotifier {
  readonly #deps: CodexNotifyDeps
  #chains = new Map<string, Promise<void>>()
  #sent = new Map<string, Sent>()
  /** Rule 9: per thread, the last turn a read confirmed as failed at a limit (a fact; it does not change) */
  #limitTurns = new Map<string, string>()
  /** Per thread: how many changes were fed (rule 7: "a newer change arrived") */
  #fed = new Map<string, number>()

  constructor(deps: CodexNotifyDeps) {
    this.#deps = deps
  }

  /**
   * Feed one status change. Returns when it has been handled (tests await it; the caller need not).
   * `quiet` (rule 9): settle the row's words, send nothing.
   */
  onStatus(change: Changed, opts: { quiet?: boolean } = {}): Promise<void> {
    const id = change.thread.id
    const seq = (this.#fed.get(id) ?? 0) + 1
    this.#fed.set(id, seq)
    const prev = this.#chains.get(id) ?? Promise.resolve()
    const next = prev.then(() => this.#handle(change, seq, opts.quiet === true)).catch((err: unknown) => {
      this.#deps.log?.(`[codex] notify failed: ${err instanceof Error ? err.message : String(err)}`)
    })
    this.#chains.set(id, next)
    void next.then(() => {
      if (this.#chains.get(id) === next) {
        this.#chains.delete(id)
        this.#fed.delete(id)
      }
    })
    return next
  }

  async #newestTurn(threadId: string): Promise<{ id: string; status: string | undefined; limited?: true } | undefined> {
    const page = await this.#deps.turns(threadId, { limit: 1, headersOnly: true })
    const t = page?.turns[0]
    return t ? { id: t.id, status: t.status, ...(t.limited ? { limited: true as const } : {}) } : undefined
  }

  async #handle(change: Changed, seq: number, quiet: boolean): Promise<void> {
    const id = change.thread.id
    const wasActive = change.from === 'working' || change.from === 'waiting'
    let turn: string | undefined
    /** What the row may say for this change to be worth a notification */
    let expected: readonly string[]
    /** How the turn ended, if the history says it did not simply complete */
    let outcome: TurnOutcome | undefined

    if (change.status.type === 'idle' && wasActive) {
      // Rule 2: what did the turn that just ended really do?
      // ⚠️ `completed` and `failed` are final. `interrupted` is believed only after every read said nothing better:
      //    it is also what a failing turn looks like for a moment.
      let last: { id: string; status: string | undefined; limited?: true } | undefined
      for (let i = 0; i < SETTLE_TRIES; i++) {
        if (i > 0) await this.#deps.sleep(SETTLE_PAUSE_MS)
        last = await this.#newestTurn(id)
        if (last?.status === 'completed' || last?.status === 'failed') break
      }
      const settled = last && (last.status === 'completed' || last.status === 'failed' || last.status === 'interrupted') ? last : undefined
      if (!settled) {
        this.#deps.log?.(`[codex] ${change.thread.id.slice(0, 8)}: the turn did not settle; no notification`)
        return
      }
      turn = settled.id
      if (settled.status === 'failed') outcome = settled.limited ? 'rate-limited' : 'failed'
      else if (settled.status === 'interrupted') outcome = 'interrupted'
      expected = ['done', 'error', 'rate-limited']
    } else if (change.status.type === 'systemError') {
      // Rule 9: the turn behind the error. ⚠️ The error comes before the turn ends: wait for it to read as failed.
      // ⚠️ Not `interrupted`: a failing turn reads so for a moment (rule 2), and a limit would then say "failed".
      // ⚠️ A read that fails ends the loop and keeps what an earlier one said (the turn id still matches
      //    `#limitTurns`): a daemon that does not answer costs one RPC timeout, not five. The loop also stops as soon
      //    as the status moves (a newer change waits behind this one).
      let last: { id: string; status: string | undefined; limited?: true } | undefined
      for (let i = 0; i < SETTLE_TRIES; i++) {
        if (i > 0) await this.#deps.sleep(SETTLE_PAUSE_MS)
        if (this.#deps.mark(id) !== change.mark) return
        const got = await this.#newestTurn(id)
        if (!got) break
        last = got
        if (last.status === 'failed' || last.status === 'completed') break
      }
      turn = last?.id
      if (last?.status === 'failed' && last.limited) {
        outcome = 'rate-limited'
        this.#limitTurns.delete(id)
        this.#limitTurns.set(id, last.id)
        if (this.#limitTurns.size > MAX_REMEMBERED) this.#limitTurns.delete(this.#limitTurns.keys().next().value as string)
      } else if (last !== undefined && this.#limitTurns.get(id) === last.id) {
        // ★ A turn already confirmed as a limit stays one when a later read (a reconnect's) does not show it ended yet
        outcome = 'rate-limited'
      }
      expected = ['error', 'rate-limited']
    } else if (change.to === 'waiting' || change.to === 'error' || change.to === 'rate-limited') {
      if (change.to === 'waiting' && this.#deps.autoApproving?.(id)) {
        // Rule 7
        await this.#deps.sleep(AUTO_GRACE_MS)
        if (this.#fed.get(id) !== seq) return
      }
      turn = (await this.#newestTurn(id))?.id
      expected = [change.to]
    } else {
      return
    }

    // Rule 8: every wait is behind us. The thread moved on meanwhile (a new turn, a reconnect) ⇒ this change is old
    // news, and the newer one is handled in its own right.
    if (this.#deps.mark(id) !== change.mark) return
    if (outcome) this.#deps.setOutcome(id, outcome, change.mark)
    // Rule 1: the words are the row's, now
    const row = this.#deps.row(id)
    if (!row) return
    // ⚠️ The row has moved on (a new turn started, an approval appeared): this change is old news, and the newer
    //    change is handled in its own right. Sending now would speak for the wrong turn.
    if (!expected.includes(row.status)) return
    const label = statusLabel(row.status)
    if (!label) return
    // Rule 9: quiet only settles the words
    if (quiet) return

    const prev = this.#sent.get(id)
    if (prev && prev.label === label && prev.turn === turn && turn !== undefined) return
    // ⚠️ Without a turn id we can only compare words (same as the Claude side when a Stop carries no id)
    if (prev && prev.label === label && turn === undefined) return
    const sent = await this.#deps.send(row, {
      title: row.title,
      titleSource: row.titleSource,
      sessionId: row.sessionId,
      project: row.project,
      machine: row.machine,
      account: row.account,
      label,
    }, turn, () => this.#deps.mark(id) === change.mark)
    this.#deps.log?.(`[codex] ${row.account} ${row.project} — ${label} (push=${sent})`)
    if (sent > 0) this.#remember(id, turn, label)
  }

  #remember(id: string, turn: string | undefined, label: string): void {
    this.#sent.delete(id)
    this.#sent.set(id, { turn, label })
    if (this.#sent.size > MAX_REMEMBERED) this.#sent.delete(this.#sent.keys().next().value as string)
  }
}

/** The payload for a Codex row. ⚠️ `build` is the Claude side's `toPushPayload`: one place builds the words and the tag. */
export function codexPayload(
  row: SessionSummary,
  fields: NotifyFields,
  at: string,
  build: (event: { event: string; machine: string; account: string; project: string; sessionId: string; at: string }, label: string, fields: NotifyFields) => PushPayload,
): PushPayload {
  return build({ event: 'Stop', machine: row.machine, account: row.account, project: row.project, sessionId: row.sessionId, at }, fields.label, fields)
}
