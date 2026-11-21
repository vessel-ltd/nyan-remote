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
import type { PermissionRequest, SessionSummary } from '../../../shared/types.ts'
import { hasHidden } from '../../../shared/reveal.ts'
import { t } from '../../../shared/i18n.ts'
import { detailOf, hiddenIn, summarize, waitForDecision, withGeneration } from '../permission.ts'
import { shouldAutoApprove } from '../autoApprove.ts'
import { agyGrantOwner, type AgyGrantOwner } from './grants.ts'
import { aliveProcStartSync } from '../claude/sessionIndex.ts'
import { agyLocksOf, agyPaneOf, withLocksProbed, agyPidFiles, agyRow, agyShared, readAgyPidFile, sweepAgyPidFiles, transcriptPathOf, type AgyDeps, type AgyState } from './sessions.ts'
import { callBeforeState, readTailRecords, turnEnd, type PendingCall } from './pending.ts'
import type { AgyCardFailure, AgyCardMark } from './keys.ts'

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
    // ★ The same call keeps its origin when the card is raised again (teams' first-seen time / `permission.ts`)
    origin: `agy:${createHash('sha256').update([row.sessionId, mark.pid, mark.step, mark.index].join('\0'), 'utf8').digest('hex').slice(0, 24)}`,
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
  /** Rule 4c (tests shorten it) */
  unconfirmedMs?: number
  /**
   * Rule 4c: a card shown again after its key did not land (the notifier owes a fresh "needs you").
   * @param card the card's state write (ISO time of the agy's own state file, as the notifier's `cardOf`)
   */
  reraised?: (conversationId: string, card: string, once?: boolean) => void
}

/** Rule 4c: how long the same card may stay up after its key was written before it is shown again */
export const UNCONFIRMED_MS = 3000

interface Raised {
  id: string
  withdraw?: () => void
}

export type AgyDelivery = { ok: true } | { ok: false; reason: AgyCardFailure }

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
export function agyDeliveryMessage(reason: AgyCardFailure): string {
  return reason === 'changed'
    ? t(
        'カードが変わりました（PC で答えたか、次のカードが出ています）。もう一度 見てから答えてください。',
        'The card changed (it was answered on the PC, or the next one is up). Look again before answering.',
      )
    : t('agy に届きませんでした。もう一度 押すか、PC で答えてください。', 'It did not reach agy. Press it again, or answer on the PC.')
}

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
   * ★ Rule 5b: whether this card (its state write, ISO, as the notifier's `cardOf`) is being answered by auto-approve,
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
    const want = new Map<string, { state: AgyState; mark: AgyCardMark; call: PendingCall; relayAt: number }>()
    const shared = new Set<string>()
    const unsure = new Set<string>()
    // ★ Each agy's own state file (a second agy on the conversation can neither take the card over nor hide it)
    for (const pid of agyPidFiles(deps.dir)) {
      if (!deps.isAgy(pid)) continue
      const f = readAgyPidFile(deps.dir, pid)
      if (!f?.state.confirmationPending) continue
      // ★ A child agent not finished: no card on the phone and no auto-answer (its question may be open on the PC and
      //   would take the `1` or the ESC / docs/AGY.md §11). The card stays on the PC and rings as any waiting row.
      if (f.state.subagentsActive) continue
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
      const end = turnEnd((this.#deps.tail ?? readTailRecords)(transcriptPathOf(conv, deps.home)))
      // ★ Rule 9: the call must be older than this agy's "card is up" state
      if (!end.pending || !callBeforeState(end.pending, f.mtimeMs)) continue
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
      want.set(conv, {
        state: f.state,
        mark: { pid, stateMtimeMs: f.mtimeMs, step: end.pending.step, index: end.pending.index, callAt: end.pending.at! },
        call: end.pending,
        relayAt: pane.startedAt,
      })
    }
    for (const conv of shared) want.delete(conv)
    this.#lastUnsure = unsure
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
      const row = agyRow(w.state, { machine: this.#deps.machine, transcriptBytes: 0, lastActivity: this.#deps.now().toISOString(), sendRoute: 'keys', asking: false })
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
      if (!this.#onPhone.has(call) && !this.#autoTried.has(call) && mine(owner) && shouldAutoApprove(info, this.#deps.now().getTime())) {
        this.#autoTried.add(call)
        this.#answered.set(conv, id)
        this.#auto.set(conv, { id, card: new Date(w.mark.stateMtimeMs).toISOString() })
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
      void this.#wait(conv, raised, info, w.mark)
    }
    if (changed) this.#deps.changed()
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
      this.#deps.reraised?.(conv, new Date(mark.stateMtimeMs).toISOString(), true)
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

  async #wait(conv: string, raised: Raised, info: PermissionRequest, mark: AgyCardMark): Promise<void> {
    let settle!: (d: AgyDelivery | undefined) => void
    const mine = new Promise<AgyDelivery | undefined>((r) => (settle = r))
    deliveries.set(info.key, mine)
    try {
      await this.#answerOnce(conv, raised, info, mark, settle)
    } finally {
      settle(undefined)
      // ⚠️ The same card raised again keeps its key: never remove the newer one's entry
      if (deliveries.get(info.key) === mine) deliveries.delete(info.key)
    }
  }

  async #answerOnce(conv: string, raised: Raised, info: PermissionRequest, mark: AgyCardMark, settle: (d: AgyDelivery) => void): Promise<void> {
    const decision = await waitForDecision(info, (withdraw) => {
      raised.withdraw = withdraw
    })
    // withdrawn (rule 3) or replaced: nothing to type
    if (!decision) return
    if (this.#raised.get(conv) === raised) this.#raised.delete(conv)
    this.#answered.set(conv, raised.id)
    this.#deps.changed()
    const behavior = decision.behavior === 'allow' ? 'allow' : 'deny'
    const res: AgyDelivery = await this.#deps.answer(conv, mark, behavior).catch(() => ({ ok: false as const, reason: 'unreachable' as const }))
    settle(res)
    // ⚠️ One line, no command text (the card and the PC's screen are the only traces of it)
    this.#deps.log?.(`[agy] card ${behavior} conversation=${conv.slice(0, 8)} ${res.ok ? 'typed' : `not typed (${res.reason})`}`)
    if (!res.ok) {
      // Rule 4: not typed ⇒ the card may come back on the next look (if it is still up)
      if (this.#answered.get(conv) === raised.id) this.#answered.delete(conv)
      void this.sync()
      return
    }
    // ★ Rule 4c: a written key has no acknowledgement (the relay can still refuse the connection after the kernel took
    //   the byte). agy rewrites its state within ~50 ms of an answer, so the same card still up after
    //   `UNCONFIRMED_MS` did not get it: it comes back on the phone (codex review)
    setTimeout(() => {
      if (this.#answered.get(conv) !== raised.id) return
      this.#answered.delete(conv)
      this.#deps.log?.(`[agy] card ${behavior} conversation=${conv.slice(0, 8)} still up after the key; shown again`)
      this.#deps.reraised?.(conv, new Date(mark.stateMtimeMs).toISOString())
      void this.sync()
    }, this.#deps.unconfirmedMs ?? UNCONFIRMED_MS).unref?.()
  }
}
