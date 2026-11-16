// ★★ Closed Codex threads as history rows (2026-11-16 / docs/CODEX.md §5.7), like Claude's ended sessions.
//
// Measured on codex-cli 0.169.0 (a separate connection; `thread/loaded/list` before and after every call):
//   - `thread/list`, `thread/read`, `thread/turns/list` and `thread/items/list` on a closed thread **do not load it**
//     (the loaded list stayed the same, no `thread/started`; 2–6 ms each). `thread/list` says `status: notLoaded`.
//   - `thread/list {useStateDbOnly:true}` returned the same 37 threads as the default (which scans the rollouts) in
//     9 ms instead of ~550 ms.
//   - ⚠️ `thread/list` gives `threadSource: null` for every thread; `thread/read` of the same thread gives `"user"`.
//     ⇒ A thread becomes a history row only after a `thread/read` said it is a user thread — **the same filter as the
//        live rows** (`isUserThread`). That answer is kept per thread (it never changes), so each is read once.
//
// The rules:
//  1. ⚠️⚠️ **Nothing here loads a thread** (only the four calls above; never `thread/resume`).
//  2. History = the listed user threads that are **not live rows** (the book), checked when the rows are built, so a
//     thread opened again moves at once and a closed one has no gap. ⚠️ Not decided by the listed status: the list may
//     still say loaded for a moment after `thread/closed` (the book has already dropped it).
//  3. At most `limit` rows (the same cap as Claude's sessions per account), newest first. ⚠️ The cap counts **history
//     rows**, not listed threads (codex review: internal threads used up a page and hid the user's): pages are read
//     until `limit` rows are found, at most `MAX_SCANNED` threads.
//  4. One refresh at a time; a refresh asked for meanwhile runs once after it. A failed list keeps the last rows.

import type { SessionSummary } from '../../../shared/types.ts'
import type { RpcResult } from './rpc.ts'
import { isUserThread, parseThread, sortRows, threadRow, type CodexThread, type ThreadBookRowsContext } from './threads.ts'

export interface ClosedThreadsDeps {
  /** A call on the line now (`undefined` = no line) */
  call(method: string, params: unknown): Promise<RpcResult> | undefined
  /** Whether this thread is a live row (the book) */
  isLive(threadId: string): boolean
  now(): number
  /** The rows changed (tell the phones) */
  changed(): void
  /** How many history rows at most */
  limit: number
}

/** ★ How many listed threads one refresh looks at, at most (rule 3) */
export const MAX_SCANNED = 600
/** How many pages one refresh reads, at most (hostile input: never follow cursors forever) */
const MAX_PAGES = 20

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export class ClosedThreads {
  readonly #deps: ClosedThreadsDeps
  #threads: CodexThread[] = []
  /** thread id → is it a user thread (from `thread/read`; never changes) */
  readonly #user = new Map<string, boolean>()
  #running: Promise<void> | undefined
  #again = false
  /** When the last refresh **began** (a failed one counts: the throttle must hold through errors / round 2) */
  #attemptedAt = Number.NEGATIVE_INFINITY

  constructor(deps: ClosedThreadsDeps) {
    this.#deps = deps
  }

  /** Read the list again (rule 4). Resolves when this refresh (or the one it joined) is over. */
  refresh(): Promise<void> {
    if (this.#running) {
      this.#again = true
      return this.#running
    }
    const run = (async () => {
      do {
        this.#again = false
        await this.#once().catch(() => undefined)
      } while (this.#again)
    })()
    this.#running = run
    void run.then(() => {
      if (this.#running === run) this.#running = undefined
    })
    return run
  }

  /**
   * Refresh when the last one **began** more than `ms` ago (the phone's list requests).
   * ⚠️ A refresh in flight is joined, never queued again (a slow or failing line must not turn every poll into one
   *    more refresh / codex round 2).
   */
  refreshIfOlder(ms: number): void {
    if (this.#running) return
    if (this.#deps.now() - this.#attemptedAt >= ms) void this.refresh()
  }

  async #once(): Promise<void> {
    this.#attemptedAt = this.#deps.now()
    const limit = this.#deps.limit
    const out: CodexThread[] = []
    /** ★ History rows found (live threads are kept but never count toward the cap / round 2) */
    let found = 0
    const seen = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES && found < limit && seen.size < MAX_SCANNED; page++) {
      const res = await this.#deps.call('thread/list', {
        limit,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        useStateDbOnly: true,
        ...(cursor === undefined ? {} : { cursor }),
      })
      // ⚠️ Rule 4: a failed list keeps the last rows (a partial one is not taken either)
      if (!res || !res.ok || !isObject(res.result) || !Array.isArray(res.result.data)) return
      for (const raw of res.result.data) {
        if (found >= limit || seen.size >= MAX_SCANNED) break
        const t = parseThread(raw)
        if (!t || seen.has(t.id)) continue
        seen.add(t.id)
        if (!(await this.#isUser(t.id))) continue
        // ★ A live one is kept (it becomes history the moment it closes) but does not use the cap
        out.push(t)
        if (!this.#deps.isLive(t.id)) found++
      }
      const next: unknown = res.result.nextCursor
      if (typeof next !== 'string' || next === '' || next === cursor) break
      cursor = next
    }
    // ★ Keep the answers only for threads still listed (bounded by the list)
    for (const id of [...this.#user.keys()]) if (!seen.has(id)) this.#user.delete(id)
    // ★ Always the fresh values; the phones are told only when something they show changed
    const changed = !sameThreads(this.#threads, out)
    this.#threads = out
    if (changed) this.#deps.changed()
  }

  /** Rule 2 / the live rows' filter. `false` when it cannot be read now (asked again on the next refresh). */
  async #isUser(threadId: string): Promise<boolean> {
    const known = this.#user.get(threadId)
    if (known !== undefined) return known
    const res = await this.#deps.call('thread/read', { threadId })
    const thread = res && res.ok && isObject(res.result) ? parseThread(res.result.thread) : undefined
    if (!thread || thread.id !== threadId) return false
    const user = isUserThread(thread)
    this.#user.set(threadId, user)
    return user
  }

  /**
   * ★ The history now: not live, newest first, capped. **The one selection** for both the rows and `has` (round 3:
   *   a thread past the cap was still readable by id). ⚠️ Capped here too: a live one kept by the last refresh may
   *   have closed since.
   */
  #current(): CodexThread[] {
    return this.#threads
      .filter((t) => !this.#deps.isLive(t.id))
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, this.#deps.limit)
  }

  /** Whether this thread is a history row now (rule 2: not while it is live; and within the cap) */
  has(threadId: string): boolean {
    return this.#current().some((t) => t.id === threadId)
  }

  rows(ctx: ThreadBookRowsContext): SessionSummary[] {
    // ★ Status `unknown`: the phone shows a history row by its time only
    return sortRows(this.#current().map((t) => threadRow(t, ctx, 'unknown', false)))
  }
}

/** Same threads with the same shown values (so an unchanged list does not tell the phones) */
function sameThreads(a: CodexThread[], b: CodexThread[]): boolean {
  if (a.length !== b.length) return false
  return a.every((t, i) => {
    const u = b[i]!
    return (
      t.id === u.id &&
      t.updatedAt === u.updatedAt &&
      t.name === u.name &&
      t.preview === u.preview &&
      t.cwd === u.cwd &&
      t.gitBranch === u.gitBranch &&
      t.cliVersion === u.cliVersion
    )
  })
}
