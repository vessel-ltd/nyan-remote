// ★★ The thread view of a Codex thread, in the shape the PWA already reads (`LogPage`) (2026-11-14 / docs/CODEX.md).
//
// The PWA's contract was made for a transcript file: a numeric `cursor` for "older" and a numeric `tail` for
// "what came after". Codex gives opaque string cursors per **turn** and no "changes since" ⇒ this file keeps a
// `ThreadJournal` per thread and hands out **positions in it** as both `cursor` and `tail`.
//
// ⚠️⚠️ Pages are cut by **entries**, not by turns. Measured on a real thread: 10 turns were 374 entries / 407 KB
//    (one Codex turn holds dozens of commands) — far too much for one page over the relay.
// ⚠️⚠️ All of it belongs to **one connection generation**. After a reconnect a thread starts a new journal with a new
//    epoch; a position from the old one gets **nothing** (and the current tail), never a replay of the whole thread.
//    The reader catches up when the thread is opened again. (Agent restarts and daemon restarts are the two causes.)
// ⚠️ A page that cannot be fetched is not an error to the reader: it gets what the journal already has.
// ⚠️ While a thread is being viewed the PWA asks every few seconds ⇒ the daemon is asked at most once per
//    `REFRESH_MIN_MS` per thread.

import type { LogPage } from '../../../shared/types.ts'
import { countWithin } from '../claude/log.ts'
import { EPOCH_STEP, newEpoch, ThreadJournal, turnsToEntries, type TurnsPage } from './history.ts'

/** Turns read from the daemon when a thread is opened, and each time older turns are needed */
export const PAGE_TURNS = 5
/** Turns re-read on follow (the newest ones; everything older is already in the journal) */
export const FOLLOW_TURNS = 3
export const REFRESH_MIN_MS = 1000
/** Entries per page when the reader does not say */
export const DEFAULT_ENTRIES = 60
/** Threads whose state is kept (least recently used is dropped) */
const MAX_THREADS = 50
/** How many extra pages a refresh reads back to join up with the journal before it starts over */
export const MAX_CATCHUP_PAGES = 10

export interface CodexLogSource {
  /** Changes on every (re)connect */
  generation(): number
  /** `undefined` = could not be read now (not connected, not a listed thread, or the daemon refused) */
  turns(threadId: string, opts: { limit: number; cursor?: string }): Promise<TurnsPage | undefined>
}

interface ThreadState {
  generation: number
  journal: ThreadJournal
  /** Opaque cursor to the turns older than everything in the journal. `null` = there are none (or they no longer join up) */
  older: string | null
  lastRefresh: number
  loaded: boolean
  /** The refresh in flight, if any (one at a time per journal) */
  refreshing?: Promise<void>
}

export class CodexLogs {
  #threads = new Map<string, ThreadState>()
  #lastEpoch = 0
  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  #state(source: CodexLogSource, threadId: string): ThreadState {
    const gen = source.generation()
    let s = this.#threads.get(threadId)
    if (!s || s.generation !== gen) {
      s = { generation: gen, journal: this.#newJournal(), older: null, lastRefresh: -Infinity, loaded: false }
    }
    // Move to the end (most recently used)
    this.#threads.delete(threadId)
    this.#threads.set(threadId, s)
    if (this.#threads.size > MAX_THREADS) this.#threads.delete(this.#threads.keys().next().value as string)
    return s
  }

  #newJournal(): ThreadJournal {
    // ★ Strictly increasing, even for two journals created within the same second
    const epoch = Math.max(newEpoch(this.#now()), this.#lastEpoch + EPOCH_STEP)
    this.#lastEpoch = epoch
    return new ThreadJournal(epoch)
  }

  /**
   * ⚠️⚠️ One refresh at a time per journal (fourth review, medium #4): two phones reading the newest turns at once, the
   *    older answer arriving last, appended its oldest turn **after** the newer ones (`ingest` appends what it has not
   *    seen) — for good. A reader that comes while a refresh is in flight waits for that one.
   */
  #refresh(source: CodexLogSource, threadId: string, s: ThreadState, limit: number): Promise<void> {
    if (s.refreshing) return s.refreshing
    const now = this.#now()
    if (now - s.lastRefresh < REFRESH_MIN_MS) return Promise.resolve()
    s.lastRefresh = now
    const run = (async () => {
      const page = await source.turns(threadId, { limit })
      if (!page) return
      /** Newest first */
      const turns = [...page.turns]
      let cursor = page.nextCursor
      if (s.loaded) {
        // ⚠️⚠️ Read back until the newest turns join up with what the journal holds (fifth review, medium #3): more
        //    turns than one refresh reads can pass between two refreshes (a thread not looked at for a while), and
        //    appending only the newest left the ones between missing — or put them after the newest once a later,
        //    longer read found them (`ingest` appends what it has not seen).
        let pages = 0
        while (!turns.some((t) => s.journal.knows(t.id)) && cursor !== null) {
          if (pages++ >= MAX_CATCHUP_PAGES) {
            // Too far behind to join up: start a new journal from here (old positions then get nothing, and the
            // reader catches up from the newest, as after a reconnect)
            s.journal = this.#newJournal()
            s.older = cursor
            break
          }
          const more = await source.turns(threadId, { limit: PAGE_TURNS, cursor })
          // Could not read the rest now: take nothing (the newest alone would leave a hole), try again next time
          if (!more) return
          turns.push(...more.turns)
          cursor = more.nextCursor === cursor ? null : more.nextCursor
        }
      }
      s.journal.ingest(turns.reverse())
      if (!s.loaded) {
        s.loaded = true
        s.older = cursor
      }
      if (s.journal.trimmed) s.older = null
    })()
    const mine = run.finally(() => {
      if (s.refreshing === mine) s.refreshing = undefined
    })
    s.refreshing = mine
    return mine
  }

  /** "Older" exists if the journal holds entries before `from`, or the daemon has turns older than the journal */
  #cursor(s: ThreadState, from: number): number | null {
    return from > s.journal.front || s.older !== null ? from : null
  }

  /**
   * Re-read the newest turns of a thread and say whether anything new became showable.
   * ★ For the follow signal: the agent asks the (local) daemon, and only tells the phone when this returns true.
   */
  async grew(source: CodexLogSource, threadId: string): Promise<boolean> {
    const s = this.#state(source, threadId)
    const before = s.journal.tail
    await this.#refresh(source, threadId, s, s.loaded ? FOLLOW_TURNS : PAGE_TURNS)
    return s.journal.tail > before
  }

  async page(
    source: CodexLogSource,
    threadId: string,
    account: string,
    opts: { before?: number | null; since?: number | null; limit?: number },
  ): Promise<LogPage> {
    const s = this.#state(source, threadId)
    const limit = opts.limit ?? DEFAULT_ENTRIES
    const base = { sessionId: threadId, account, bytes: 0 }

    if (opts.before !== null && opts.before !== undefined) {
      const position = opts.before
      const journal = s.journal
      /** "Nothing older" for a position that is not (or no longer) this journal's: an empty page, never a guess */
      const gone = (): LogPage => ({ ...base, entries: [], cursor: null, tail: s.journal.tail })
      if (journal.before(position, 0) === undefined) return gone()
      // Not enough held before that position: read older turns from the daemon and put them in front
      while (position - journal.front < limit && s.older !== null) {
        const asked = s.older
        const page = await source.turns(threadId, { limit: PAGE_TURNS, cursor: asked })
        // ⚠️⚠️ A refresh started a new journal meanwhile (sixth review, medium #2: too far behind to join up). The
        //    position is the old journal's ⇒ the same answer as for any expired position.
        if (s.journal !== journal) return gone()
        // Could not read now: the same position comes back as the cursor, so the reader can try again
        if (!page) break
        // ⚠️⚠️ Another reader moved the cursor while this page was read (third review, medium #3: two phones asking for
        //    older entries at once; the second compared its answer with the first one's new cursor, saw "no progress"
        //    and dropped the cursor for good). Its page is already in ⇒ judge again from where the cursor stands now.
        if (s.older !== asked) continue
        if (journal.prepend([...page.turns].reverse()) < 0) {
          s.older = null
          break
        }
        // ⚠️ A cursor that does not advance would loop forever
        s.older = page.nextCursor === s.older ? null : page.nextCursor
      }
      // ★ Cannot be `undefined`: the same journal owned this position above, and a journal's tail only grows
      const got = journal.before(position, limit)!
      return {
        ...base,
        entries: got.entries,
        cursor: got.entries.length === 0 && s.older !== null ? position : this.#cursor(s, got.from),
        tail: journal.tail,
      }
    }

    if (opts.since !== null && opts.since !== undefined) {
      await this.#refresh(source, threadId, s, s.loaded ? FOLLOW_TURNS : PAGE_TURNS)
      const all = s.journal.since(opts.since)
      if (!all) return { ...base, entries: [], cursor: null, tail: s.journal.tail }
      // ★ Cut to fit one relay frame; the phone asks again from where it stopped (`more` / codex review)
      const n = countWithin(all)
      if (n >= all.length) return { ...base, entries: all, cursor: null, tail: s.journal.tail }
      return { ...base, entries: all.slice(0, n), cursor: null, tail: s.journal.after(opts.since, n), more: true }
    }

    await this.#refresh(source, threadId, s, PAGE_TURNS)
    const got = s.journal.latest(limit)
    return { ...base, entries: got.entries, cursor: this.#cursor(s, got.from), tail: s.journal.tail }
  }
}
