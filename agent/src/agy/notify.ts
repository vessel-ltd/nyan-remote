// ★★ Push notifications for agy conversations (2026-11-20 / docs/AGY.md §9).
//
// Input: the rows of this machine's agys, looked at whenever a status file changes (`watch.ts`).
// Output: at most one push per turn and state — "needs you" (a card is up), "done", "failed" — in the list's words.
//
// The rules (the same as Codex's `codex/notify.ts` where they apply):
//  1. ⚠️⚠️ The words come from the row (`statusLabel(row.status)`): the list and the notification cannot disagree.
//  2. ⚠️⚠️ "Done" only when the turn ended with the model's answer (`pending.ts` `turnEnd(...).answered`). A turn
//     stopped with ESC, or ended by declining a card, also ends idle (agy sends nothing that tells them apart), and
//     its transcript ends without an answer ⇒ nothing is sent (someone stopped it by hand).
//  3. Only changes are told: the first look after the agent starts is the baseline — except a card waiting then, which
//     rings ("needs you" is always something to do; codex review: a card that appeared while the agent was down, or
//     whose auto-approve grant the restart ended, stayed silent). Accepted: a restart rings a still-waiting card again.
//  4. Same turn and same words ⇒ not sent again; for "needs you", same card (each card rings once, like a Claude
//     approval). ⚠️ Remembered only when a send succeeded. The turn is the last USER_INPUT's step.
//  4b. ★ A send that reached no device is tried again while the row stays in that state (at most every
//     `RETRY_MS`; codex review: a short push outage left a card waiting with no ring at all, since only changes are told).
//  5. Never conversation content: the title goes through `notificationText`, which only lets AI titles through.
//  6. ⚠️ A look that waited behind a slow push does not speak for a state a newer look no longer shows (codex review:
//     a "needs you" sent after the card had been declined on the PC). The newer look handles its own state.
//     ⚠️ Read again before every send (a send inside the same look can be the slow one).
//  7. A conversation that appears already answered rings "done" when the answer is newer than the previous look
//     (a first turn that started and ended between two looks / codex review); an old answer of a resumed
//     conversation does not.
//  9. ⚠️ No "done" when another agy wrote into the conversation during the turn (its visit mark / `agyOthersWrote`):
//     the shared transcript's last answer may be that agy's, while this one's turn was declined.
// 10. A long turn whose prompt is out of the transcript tail: the prompt is looked for further back (`lastTurnStart`,
//     cached by the file's size) when the rows are read, so every look knows the turn (codex review).
// 11. ★ A card the phone answered but whose key did not land comes back (`cards.ts` rule 4c) ⇒ `owe` rings "needs you"
//     again on a look that sees it waiting (the phone had closed the old one when it denied).
// 12. ★ A card auto-approve is answering (`cards.ts` rule 5b / `quiet`) does not ring "needs you". If its key does not
//     land, the card goes to the phone and `owe` rings it (rule 11).
//  8. ★ The rows come from each agy's own state (`agyOwnRows`: the agys holding their conversation's lock), not
//     from the per-conversation file a second agy on the same conversation can overwrite.

import type { NotifyFields, SessionSummary } from '../../../shared/types.ts'
import { statusLabel } from '../../../shared/types.ts'
import { conversationOf, transcriptPathOf } from './sessions.ts'
import { readTailRecords, turnEnd, type TurnEnd } from './pending.ts'

export interface AgyNotifyDeps {
  /** The listed agy rows now */
  rows(): Promise<SessionSummary[]>
  home: string
  /**
   * Build the payload (the one text builder) and send it. Returns how many devices got it.
   * @param current asked right before each device's send (`sendToAll`'s guard): false = the state moved on, not sent
   */
  send(row: SessionSummary, fields: NotifyFields, current?: () => boolean): Promise<number>
  tail?: (path: string) => Record<string, unknown>[]
  log?: (line: string) => void
  now?: () => number
  /**
   * ★ The row's state and turn right now, read from the files (the sender's guard: a look can be behind, or missed when
   * a file event was lost)
   */
  statusNow?: (sessionId: string) => { status: string; turn: number | undefined; card?: string } | undefined
  /** ★ Whether another agy wrote into this conversation since `since` (rule 9); undefined = cannot tell now. Absent = never */
  othersWrote?: (sessionId: string, since: number) => Promise<boolean | undefined> | boolean | undefined
  /** ★ The turn's prompt looked for further back, when the tail did not hold it (rule 10). Absent = not looked for */
  turnStart?: (sessionId: string) => { turn: number; at: number } | undefined
  /**
   * ★ Rule 12: whether this card (`cardOf`) is being answered by auto-approve. undefined = cannot tell now (held back
   * for the next looks, at most `QUIET_UNSURE_MAX`, then rung). Absent = never
   */
  quiet?: (sessionId: string, card: string) => boolean | undefined | Promise<boolean | undefined>
}

interface Sent {
  turn: number | undefined
  label: string
  /** For "needs you": which card (each card of a turn rings once / rule 4) */
  card?: string
}

const ACTIVE = new Set(['working', 'waiting'])
const MAX_REMEMBERED = 500
/** How long a conversation missing from the looks is still remembered (a lock probe that failed for a while) */
export const MISSING_KEEP_MS = 60_000
/** Rule 4b: how often a push that reached nobody is tried again */
export const RETRY_MS = 30_000

interface Snapshot {
  at: number
  items: { row: SessionSummary; end: TurnEnd }[]
}

interface Owed {
  status: string
  turn: number | undefined
  /** For "needs you": the card (what decides whether it is still the same one) */
  card?: string
  label: string
  nextAt: number
  /** Rule 12: how many looks in a row could not tell whether auto-approve is answering this card */
  unsure?: number
}

/** Rule 12: looks that may hold back a "needs you" while it cannot be told whether auto-approve answers it */
export const QUIET_UNSURE_MAX = 3

/**
 * ★ Whether the row's state belongs to the transcript's newest prompt. The prompt's time is whole seconds, so a state
 * written in the same second may be the previous turn's (a prompt queued while agy worked goes in the moment the
 * turn ends / codex review) ⇒ the newest turn's only when the model already wrote something after the prompt, or the
 * state was written a whole second later.
 */
/**
 * ★★ Which card a "needs you" is about: the write of the agy's own state file that said a card is up (`lastActivity` of
 * an own row). agy writes its state once per card and not again while it stays up (measured: unchanged for 20 s), and
 * no other agy writes that file — unlike the shared transcript, whose last call can be another agy's (codex review,
 * rounds 31–33). ⚠️ A terminal resize while a card is up may write it again: that card then rings once more.
 */
function cardOf(row: Pick<SessionSummary, 'status' | 'lastActivity'>): string | undefined {
  return row.status === 'waiting' ? row.lastActivity : undefined
}

function stateOfTurn(row: Pick<SessionSummary, 'lastActivity'>, end: TurnEnd | undefined): boolean {
  if (end?.turnAt === undefined) return true
  const at = Date.parse(row.lastActivity)
  return at >= end.turnAt + 1000 || (at >= end.turnAt && end.afterPrompt === true)
}

export class AgyNotifier {
  readonly #deps: AgyNotifyDeps
  /** session → its status and turn at the last look */
  #last: Map<string, { status: string; turn: number | undefined; card?: string; missingSince?: number }> | undefined
  #sent = new Map<string, Sent>()
  /** Rule 4b: session → the push still owed for its current state */
  #owed = new Map<string, Owed>()
  #chain: Promise<void> = Promise.resolve()
  /** The newest look asked for (rule 6) */
  #newest: Promise<Snapshot> | undefined
  /** When the previous applied look was taken (rule 7) */
  #lastAt: number | undefined
  /** Rule 11: session → the request to ring again (its number) */
  #ringAgain = new Map<string, { seq: number; nextAt: number; card: string | undefined; once?: true }>()
  #ringSeq = 0
  /** The newest snapshot's states, as soon as it is read (rule 6, the sender's guard) */
  #seen = new Map<string, { status: string; turn: number | undefined; card?: string }>()
  #seenAt = -Infinity

  constructor(deps: AgyNotifyDeps) {
    this.#deps = deps
  }

  /**
   * Rule 11: ring "needs you" again for this conversation (its card came back after a key that did not land). Sent on a
   * look that sees it waiting, past the "same turn, same words" rule; dropped once it is not waiting.
   */
  owe(sessionId: string, card: string, once = false): void {
    // ★ For that card (its own state write, as `cardOf`): another card is told in its own right (codex review)
    // ★ `once`: only if that card has not rung yet (an auto-answer that failed: a "needs you" already sent or on its
    //   way for it is enough / codex review: it rang twice)
    this.#ringAgain.set(sessionId, { seq: ++this.#ringSeq, nextAt: 0, card, ...(once ? { once: true } : {}) })
  }

  /**
   * Look once. ⚠️ The rows and transcripts are read **now**, and the looks are then handled one at a time in order
   * (codex review: read when the queue got to them, a slow push let two looks of a `done → working → done` both see
   * `done`, and the second turn's "done" was never sent).
   */
  look(): Promise<void> {
    const snap = this.#snapshot()
    this.#newest = snap
    const next = this.#chain.then(async () => this.#apply(await snap)).catch((err: unknown) => {
      this.#deps.log?.(`[agy] notify failed: ${err instanceof Error ? err.message : String(err)}`)
    })
    this.#chain = next
    return next
  }

  async #snapshot(): Promise<Snapshot> {
    const at = (this.#deps.now ?? Date.now)()
    const rows = await this.#deps.rows()
    const snap: Snapshot = {
      at,
      items: rows.map((row) => {
        const conv = conversationOf(row.sessionId)
        let end: TurnEnd = conv ? turnEnd((this.#deps.tail ?? readTailRecords)(transcriptPathOf(conv, this.#deps.home))) : { answered: false }
        // Rule 10: a long turn's prompt out of the tail ⇒ looked for further back (cached by the file's size)
        if (end.turn === undefined) {
          const deep = this.#deps.turnStart?.(row.sessionId)
          if (deep) end = { ...end, turn: deep.turn, turnAt: deep.at }
        }
        return { row, end }
      }),
    }
    // ★ The newest state seen, for the sender's guard (rule 6: a push already on its way stops when it moved on)
    if (at >= this.#seenAt) {
      this.#seenAt = at
      this.#seen = new Map(snap.items.map((x) => [x.row.sessionId, { status: x.row.status, turn: x.end.turn, card: cardOf(x.row) }]))
    }
    return snap
  }

  async #apply(snap: Snapshot): Promise<void> {
    const rows = snap.items.map((x) => x.row)
    const ends = new Map(snap.items.map((x) => [x.row.sessionId, x.end]))
    const before = this.#last
    // ★ The turn a state belongs to: the new prompt's only when the state was written after it (else the previous
    //   look's turn is kept, so the real change of that new turn is still news later)
    const now = new Map(
      rows.map((r) => {
        const e = ends.get(r.sessionId)
        const after = stateOfTurn(r, e)
        const card = cardOf(r)
        return [r.sessionId, { status: r.status, turn: after ? e?.turn : (before?.get(r.sessionId)?.turn ?? e?.turn), ...(card !== undefined ? { card } : {}) }] as const
      }),
    )
    // ★ A conversation missing from this look (a lock probe that failed, a file being rewritten) is carried over for a
    //   while instead of read as gone: otherwise its "working" was forgotten and the completion seen after it was not
    //   news, and owed pushes were dropped (codex review). Gone for `MISSING_KEEP_MS` ⇒ forgotten.
    const seenAt = (this.#deps.now ?? Date.now)()
    const kept = new Map<string, { status: string; turn: number | undefined; card?: string; missingSince?: number }>(now)
    for (const [id, was] of before ?? []) {
      if (now.has(id)) continue
      const since = was.missingSince ?? seenAt
      if (seenAt - since < MISSING_KEEP_MS) kept.set(id, { ...was, missingSince: since })
    }
    this.#last = kept
    const prevAt = this.#lastAt
    this.#lastAt = snap.at
    // Rule 3: the baseline tells only the cards waiting now
    const baseline = before === undefined
    const prior = before ?? new Map<string, { status: string; turn: number | undefined; card?: string }>()
    const nowMs = (this.#deps.now ?? Date.now)()
    // a push owed for a state or turn that is over is dropped (codex review: an old turn's "done" was retried after the
    // next turn had been stopped)
    for (const [id, o] of this.#owed) {
      // a conversation only missing for now keeps what it is owed
      if (!now.has(id) && kept.has(id)) continue
      const n = now.get(id)
      // ★ "needs you" by its card (a second agy's prompt can change the turn of the same card / codex review)
      const same = o.status === 'waiting' && o.card !== undefined ? n?.card === o.card : n?.turn === o.turn
      if (n?.status !== o.status || !same) this.#owed.delete(id)
    }
    // ⚠️ By the newest look, not this one (a queued older look must not drop a ring asked for since / codex review)
    for (const [id, ring] of this.#ringAgain) {
      const seen = this.#seen.get(id)
      // (a look not yet showing that card keeps it: the request can come before the look that sees the card)
      if (seen && (seen.status !== 'waiting' || seen.card !== ring.card) && seen.status !== 'working') this.#ringAgain.delete(id)
    }
    const latestOf = async (id: string): Promise<{ status: string; turn: number | undefined; card?: string } | undefined> => {
      const x = (this.#newest ? await this.#newest : snap).items.find((y) => y.row.sessionId === id)
      return x && { status: x.row.status, turn: x.end.turn, card: cardOf(x.row) }
    }
    // ★ For "needs you", the same card too (a queued alert for a card already answered is not sent for the next one)
    const sameCard = (a: string | undefined, b: string | undefined, to: string): boolean => to !== 'waiting' || a === b
    // ★ For "needs you" the card alone decides, not the turn (a look that could not read the transcript had another turn
    //   for the same card, and its push was dropped for good / codex review)
    const sameTurn = (a: number | undefined, b: number | undefined, to: string): boolean => to === 'waiting' || a === b
    for (const row of rows) {
      if (baseline && row.status !== 'waiting') continue
      const from = prior.get(row.sessionId)
      const to = row.status
      const end = ends.get(row.sessionId)
      if (!end || !conversationOf(row.sessionId)) continue
      const owed = this.#owed.get(row.sessionId)
      // ★ A new turn counts as news even when the state looks the same (codex review: a turn that started and ended
      //   between two looks — a missed file event, then the 5 s timer — showed `done` both times and was never told)
      //   ⚠️ Only when the state was written after the turn's prompt: a look between agy writing a new prompt and
      //      rewriting its state would pair the new turn with the old state (an old error told as the new turn's /
      //      codex review)
      const stateAfterTurn = stateOfTurn(row, end)
      const newTurn = from !== undefined && from.turn !== undefined && end.turn !== undefined && end.turn !== from.turn && stateAfterTurn
      const cardKey = cardOf(row)
      // ★ Another card while it still waits (the `working` between two cards was not seen / codex review)
      const newCard = to === 'waiting' && from?.status === 'waiting' && cardKey !== undefined && cardKey !== from.card
      // ★ For "needs you" the card alone decides (a second agy's prompt can make the same card look like a new turn's /
      //   codex review); other states go by turn
      const fresh = from === undefined || from.status !== to || (to === 'waiting' ? newCard : newTurn)
      // Rule 11
      let ring = to === 'waiting' ? this.#ringAgain.get(row.sessionId) : undefined
      if (ring?.once && ring.card !== undefined && this.#sent.get(row.sessionId)?.card === ring.card) {
        this.#ringAgain.delete(row.sessionId)
        ring = undefined
      }
      // ⚠️ A failed ring waits like any owed push (`RETRY_MS`), not every look; meanwhile the usual rules apply
      const again = ring && ring.nextAt <= nowMs && ring.card === now.get(row.sessionId)?.card ? ring : undefined
      if (again !== undefined) {
        // rings whatever was sent before
      } else if (!fresh) {
        // Rule 4b: the same state, with a push still owed for it
        if (!owed || owed.nextAt > nowMs) continue
      } else if (to === 'waiting' || to === 'error') {
        // fall through to send
      } else if (to === 'done' && from !== undefined && (ACTIVE.has(from.status) || newTurn)) {
        // Rule 2
        if (!end.answered) continue
      } else if (to === 'done' && from === undefined && end.answered && end.answeredAt !== undefined && prevAt !== undefined && end.answeredAt >= prevAt - 1000) {
        // Rule 7
      } else {
        continue
      }
      // Rule 12 (asked only for a "needs you" about to go out)
      if (to === 'waiting' && cardKey !== undefined && again === undefined && this.#deps.quiet) {
        const q = await this.#deps.quiet(row.sessionId, cardKey)
        const l = statusLabel(row.status)
        if (q === true) {
          // ★ Asked again on every look while the card waits: an auto-answer that fails without telling (its record
          //   dropped by a look that could not read the transcript) is then rung (codex review: it stayed silent)
          if (l) this.#owed.set(row.sessionId, { status: to, turn: now.get(row.sessionId)?.turn, card: cardKey, label: l, nextAt: nowMs })
          continue
        }
        // ⚠️ Cannot tell (the cards' lock probe failed): held back for the next looks, then rung (codex review: it rang
        //    for a card the next look auto-answered)
        if (q === undefined) {
          const was = this.#owed.get(row.sessionId)
          const n = (was?.card === cardKey ? (was.unsure ?? 0) : 0) + 1
          if (n <= QUIET_UNSURE_MAX && l) {
            this.#owed.set(row.sessionId, { status: to, turn: now.get(row.sessionId)?.turn, card: cardKey, label: l, nextAt: nowMs, unsure: n })
            continue
          }
        }
      }
      // Rule 9: a "done" read from a transcript another agy wrote into during this turn may be the other one's answer
      if (to === 'done') {
        if (end.turnAt === undefined) continue
        const others = this.#deps.othersWrote ? await this.#deps.othersWrote(row.sessionId, end.turnAt) : false
        if (others === true) continue
        if (others === undefined) {
          // ⚠️ Cannot tell now (a lock probe failed): tried again later, not dropped (codex review)
          const l = statusLabel(row.status)
          if (l) this.#owed.set(row.sessionId, { status: to, turn: now.get(row.sessionId)?.turn, label: l, nextAt: nowMs + RETRY_MS })
          continue
        }
      }
      const label = statusLabel(row.status)
      if (!label) continue
      // Rule 6
      const l = await latestOf(row.sessionId)
      if (!l) {
        // ⚠️ The newest look lacks it (a probe that failed): cannot tell ⇒ owed, tried again (not dropped / codex review)
        this.#owed.set(row.sessionId, { status: to, turn: now.get(row.sessionId)?.turn, ...(cardKey !== undefined ? { card: cardKey } : {}), label, nextAt: nowMs + RETRY_MS })
        continue
      }
      if (l.status !== to || !sameTurn(l.turn, end.turn, to) || !sameCard(l.card, cardKey, to)) continue
      // ★ The turn this state belongs to (not merely the newest prompt: a state written before it is the previous
      //   turn's, and is remembered under that turn / codex review)
      const turn = now.get(row.sessionId)?.turn
      const prev = this.#sent.get(row.sessionId)
      // ★ A card is told once; another card of the same turn is news (codex review: the open app closes a "needs you"
      //   that is over, so a second card deduplicated by turn was left without any alert)
      const card = to === 'waiting' ? cardKey : undefined
      const same = to === 'waiting' && card !== undefined ? prev?.card === card : prev?.turn === turn && prev?.card === card
      if (again === undefined && prev && prev.label === label && same) {
        this.#owed.delete(row.sessionId)
        continue
      }
      // ⚠️ What was owed when this send started: only that is settled by it (a newer `owe` made meanwhile stays)
      const owedAtStart = this.#owed.get(row.sessionId)

      let direct: { at: number; cur: ReturnType<NonNullable<AgyNotifyDeps['statusNow']>> } | undefined
      // ⚠️ A send that throws (a key file unreadable for a moment) counts as reaching nobody: it is owed (rule 4b)
      //    and the other rows of this look still go (codex review)
      const sent = await this.#deps
        .send(row, {
          title: row.title,
          titleSource: row.titleSource,
          sessionId: row.sessionId,
          project: row.project,
          machine: row.machine,
          account: row.account,
          label,
        }, () => {
          const n = this.#seen.get(row.sessionId)
          if (n?.status !== to || !sameTurn(n.turn, end.turn, to) || !sameCard(n.card, cardKey, to)) return false
          if (!this.#deps.statusNow) return true
          // ⚠️ The direct read once per send, reused for its devices for a second (a Mac's `lsof` per device stalled
          //    the agent / codex review)
          const t0 = (this.#deps.now ?? Date.now)()
          if (!direct || t0 - direct.at > 1000) direct = { at: t0, cur: this.#deps.statusNow(row.sessionId) }
          const cur = direct.cur
          return cur?.status === to && sameTurn(cur.turn, end.turn, to) && sameCard(cur.card, cardKey, to)
        })
        .catch((err: unknown) => {
          this.#deps.log?.(`[agy] notify failed: ${err instanceof Error ? err.message : String(err)}`)
          return 0
        })
      this.#deps.log?.(`[agy] ${row.project} — ${label} (push=${sent})`)
      if (sent > 0) {
        if (this.#owed.get(row.sessionId) === owedAtStart) this.#owed.delete(row.sessionId)
        // ⚠️ Only the ring asked for before this send started is done (an `owe` made meanwhile stays)
        if (again !== undefined && this.#ringAgain.get(row.sessionId) === again) this.#ringAgain.delete(row.sessionId)
        this.#sent.delete(row.sessionId)
        this.#sent.set(row.sessionId, { turn, label, ...(card ? { card } : {}) })
        if (this.#sent.size > MAX_REMEMBERED) this.#sent.delete(this.#sent.keys().next().value as string)
      } else {
        this.#owed.set(row.sessionId, { status: to, turn, ...(card !== undefined ? { card } : {}), label, nextAt: nowMs + RETRY_MS })
        if (again !== undefined && this.#ringAgain.get(row.sessionId) === again) again.nextAt = nowMs + RETRY_MS
      }
    }
  }
}
