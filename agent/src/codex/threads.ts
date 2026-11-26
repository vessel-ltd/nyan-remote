// ★★ Codex threads → rows of the session list (2026-11-14 / docs/CODEX.md §5).
//
// Pure: what the daemon said goes in (`thread/read`, `thread/started`, `thread/status/changed`, `thread/closed`),
// rows come out. No I/O here, so every decision below is reachable from tests.
//
// ⚠️⚠️ Everything from the daemon is another program's output ⇒ a thread that does not parse is **not shown**
//    (counted in `skipped`), never shown half-filled.
// ⚠️⚠️ **Only threads whose `threadSource` is `user` become rows** (measured on 0.169.0: the TUI's main thread is `user`,
//    the internal title generator is `thread_title`). ⚠️ `source` is **not** usable: a plain TUI reported `vscode`.
//    An unknown `threadSource` is hidden and counted, so a Codex update shows up in diagnostics instead of as mystery rows.
// ⚠️⚠️ **`idle` alone never means "done".** A thread is `done` only if **this connection saw it active** and then idle.
//    A thread that is already idle when we (re)connect is just `idle` — we do not know that a turn ended.
// ⚠️ A row means "the daemon can serve this thread", not "a TUI is open" (the daemon keeps a thread loaded ~1 minute
//    after the TUI exits; `thread/read` has no field for an open screen).

import { basename } from 'node:path'
import type { SessionStatus, SessionSummary, TitleSource } from '../../../shared/types.ts'

export type CodexStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; waitingOnApproval: boolean; waitingOnUserInput: boolean }

export interface CodexThread {
  id: string
  cwd: string
  name: string | null
  preview: string
  status: CodexStatus
  /** Unix seconds */
  updatedAt: number
  threadSource: string | null
  parentThreadId: string | null
  ephemeral: boolean
  gitBranch: string | null
  cliVersion: string | null
  /**
   * The rollout file on disk (the daemon's). ⚠️ Stays on the agent: read for the context chip only (`context.ts`),
   *    never put on a row.
   */
  path: string | null
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const strOrNull = (v: unknown): string | null | undefined => (v === null || v === undefined ? null : typeof v === 'string' ? v : undefined)

/** The largest time a JavaScript `Date` can hold, in ms (ECMA-262 §21.4.1.1) */
const MAX_DATE_MS = 8.64e15

/**
 * Whether `v` is a time in Unix seconds that a `Date` can hold.
 * ⚠️ `Number.isFinite` is not enough: `1e100` passes it and then `toISOString()` throws `RangeError` while the list is
 *    being built (codex review, medium #8).
 */
export function isUnixSeconds(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v * 1000) <= MAX_DATE_MS
}

/** ⚠️ An unknown status type is `undefined` (= "we cannot say"), never coerced to idle. Unknown flags are ignored. */
export function parseStatus(raw: unknown): CodexStatus | undefined {
  if (!isObject(raw)) return undefined
  switch (raw.type) {
    case 'notLoaded':
    case 'idle':
    case 'systemError':
      return { type: raw.type }
    case 'active': {
      if (!Array.isArray(raw.activeFlags)) return undefined
      return {
        type: 'active',
        waitingOnApproval: raw.activeFlags.includes('waitingOnApproval'),
        waitingOnUserInput: raw.activeFlags.includes('waitingOnUserInput'),
      }
    }
    default:
      return undefined
  }
}

export function parseThread(raw: unknown): CodexThread | undefined {
  if (!isObject(raw)) return undefined
  const { id, cwd, preview, updatedAt, ephemeral } = raw
  if (typeof id !== 'string' || id === '') return undefined
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) return undefined
  if (!isUnixSeconds(updatedAt)) return undefined
  if (typeof ephemeral !== 'boolean') return undefined
  const status = parseStatus(raw.status)
  if (!status) return undefined
  const name = strOrNull(raw.name)
  const threadSource = strOrNull(raw.threadSource)
  const parentThreadId = strOrNull(raw.parentThreadId)
  if (name === undefined || threadSource === undefined || parentThreadId === undefined) return undefined
  const git = raw.gitInfo
  const branch = isObject(git) && typeof git.branch === 'string' && git.branch !== '' ? git.branch : null
  return {
    id,
    cwd,
    name: name === '' ? null : name,
    preview: typeof preview === 'string' ? preview : '',
    status,
    updatedAt,
    threadSource,
    parentThreadId,
    ephemeral,
    gitBranch: branch,
    cliVersion: typeof raw.cliVersion === 'string' ? raw.cliVersion : null,
    path: typeof raw.path === 'string' && raw.path !== '' ? raw.path : null,
  }
}

/** The one place that decides "a person's thread". */
export function isUserThread(t: CodexThread): boolean {
  return t.threadSource === 'user' && t.parentThreadId === null
}

const TITLE_MAX = 80

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? ''
  const s = line.trim()
  return s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 1)}…` : s
}

/**
 * Title of the row.
 * ⚠️ `prompt` (the first user message) must never reach a push notification (CLAUDE.md §2); the notifier already
 *    refuses `prompt` titles, so the source is reported honestly here.
 */
export function titleOf(t: CodexThread): { title: string; titleSource: TitleSource } {
  if (t.name !== null) return { title: firstLine(t.name) || basename(t.cwd), titleSource: 'ai' }
  const p = firstLine(t.preview)
  if (p !== '') return { title: p, titleSource: 'prompt' }
  return { title: basename(t.cwd) || t.cwd, titleSource: 'fallback' }
}

/**
 * ★ One thread as a list row — the one shape for live rows (`ThreadBook.rows`) and history rows (`closedThreads.ts`).
 * `live: false` = history (the PWA's bucket is decided by `live` only / `isHistorySession`).
 */
export function threadRow(t: CodexThread, ctx: ThreadBookRowsContext, status: SessionStatus, live: boolean): SessionSummary {
  return {
    machine: ctx.machine,
    account: ctx.account,
    tool: 'codex',
    sessionId: ctx.idPrefix + t.id,
    cwd: t.cwd,
    project: basename(t.cwd) || t.cwd,
    ...titleOf(t),
    status,
    live,
    ...(t.gitBranch ? { gitBranch: t.gitBranch } : {}),
    ...(t.cliVersion ? { cliVersion: t.cliVersion } : {}),
    lastActivity: new Date(t.updatedAt * 1000).toISOString(),
    transcriptBytes: 0,
  }
}

/** Newest first; ties by id (stable order) */
export function sortRows(rows: SessionSummary[]): SessionSummary[] {
  return rows.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity) || a.sessionId.localeCompare(b.sessionId))
}

/**
 * How the last turn this connection watched ended, **as read back from the history** (`thread/turns/list`).
 * The thread status alone cannot say: a turn that failed or was interrupted also ends in `idle`.
 */
export type TurnOutcome = 'failed' | 'interrupted' | 'rate-limited'

export function statusOf(status: CodexStatus, sawActive: boolean, outcome?: TurnOutcome): SessionStatus {
  switch (status.type) {
    case 'active':
      return status.waitingOnApproval || status.waitingOnUserInput ? 'waiting' : 'working'
    case 'systemError':
      // ★ Codex puts a thread in `systemError` on any turn error, a plan limit included, until the next turn starts
      //   (`thread_status.rs`, 0.172.0). The notifier reads that turn and records 'rate-limited' when it was a limit.
      return outcome === 'rate-limited' ? 'rate-limited' : 'error'
    case 'idle':
      // ★ The list and the notification read the same thing: a failed turn is an error in both, an interrupted one
      //   is "idle" in the list and silent as a notification (someone stopped it by hand).
      if (outcome === 'failed') return 'error'
      // ★ A turn that failed at a plan or spend limit (`CodexTurn.limited`): "制限中", the same word as a Claude row.
      //   Cleared like the others when the thread goes active again (a retry after the reset).
      if (outcome === 'rate-limited') return 'rate-limited'
      if (outcome === 'interrupted') return 'idle'
      return sawActive ? 'done' : 'idle'
    case 'notLoaded':
      return 'unknown'
  }
}

/**
 * ★ The reason for "needs you", in the words the CLI uses for a Claude row (`SessionSummary.waitingFor` /
 *   `waitingReason`), so the list says why a Codex row waits the same way.
 * The daemon's flags are exactly two in 0.169.0 (approvals of commands and file changes / a question), and both can be
 * up at once: the approval is named then (it holds a command or a change back).
 * ⚠️ Nothing when neither flag is up (no reason is invented).
 */
export function waitingForOf(status: CodexStatus): string | undefined {
  if (status.type !== 'active') return undefined
  if (status.waitingOnApproval) return 'permission prompt'
  if (status.waitingOnUserInput) return 'input needed'
  return undefined
}

/** What a status change meant (for the notifier). `unknown-thread` = the book has no such thread ⇒ the caller reads it. */
export type StatusChange =
  | { type: 'unknown-thread' }
  | { type: 'ignored' } // not a user thread, or an unreadable status for a thread we do not list
  /** A listed thread said a status we cannot read ⇒ no send until a fresh read says more (the caller reads it) */
  | { type: 'unreadable'; thread: CodexThread }
  /**
   * `mark`: which status of the thread this change is about (`ThreadBook.mark`). A change keeps it while the status
   * stays the same; anything decided later for "this change" (an outcome, a notification) checks it is still current.
   */
  | { type: 'changed'; thread: CodexThread; from: SessionStatus; to: SessionStatus; status: CodexStatus; mark: number }

interface Entry {
  thread: CodexThread
  sawActive: boolean
  /** Cleared when the thread goes active again */
  outcome?: TurnOutcome
  /** Changes whenever the status does (`ThreadBook.mark`) */
  mark: number
  /**
   * ★ The daemon said a status we cannot read (third review, medium #1): **a send is refused** until a fresh read or a
   *   readable status. Only that: the row, its mark, approval cards and the notifier go on with the last status we
   *   could read (fourth review, medium #1–#2: withdrawing cards and renewing the mark here lost an approval card and a
   *   "failed" notification, because nothing gave them back when the status was readable again).
   */
  unsure?: true
}

function sameStatus(a: CodexStatus, b: CodexStatus): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'active' && b.type === 'active') return a.waitingOnApproval === b.waitingOnApproval && a.waitingOnUserInput === b.waitingOnUserInput
  return true
}

export interface ThreadBookRowsContext {
  machine: string
  /** Label of the Codex home (its base name). ⚠️ A label, not an identity. */
  account: string
  /**
   * Put in front of the thread id to make the row's `sessionId` (`codexSessionPrefix`).
   * ⚠️⚠️ The row's id must never be the bare thread id: auto-approve, routing and cleanup are keyed by `sessionId`, and a
   *    daemon can list a thread whose id equals a Claude session's (or the same id in two homes) — codex review, high #1.
   */
  idPrefix: string
}

/** How many recent status / close events are remembered for telling a stale read apart (only reads in flight need them) */
const MAX_TOUCHED = 2000

/**
 * The threads of **one connection generation**.
 *
 * ⚠️ A new connection gets a **new book** (`reset`): what the old connection saw (`sawActive`) says nothing about the
 *    time we were disconnected.
 */
export class ThreadBook {
  #threads = new Map<string, Entry>()
  /** Threads hidden because they are not a person's (by `threadSource`), for diagnostics */
  #hidden = new Map<string, string>()
  #unparsed = 0
  /** Ticks once per status / close event */
  #clock = 0
  /** Per thread: the clock of its latest status / close event (so a read that started earlier is known to be stale) */
  #touched = new Map<string, number>()
  /** The newest clock that was evicted from `#touched`: a read that started before it cannot be judged, so it is stale */
  #forgotten = -1
  /** ⚠️ Never reset (not even by `reset`): a mark from an old connection must never match a new entry */
  #marks = 0

  reset(): void {
    this.#threads.clear()
    this.#hidden.clear()
    this.#touched.clear()
    this.#unparsed = 0
  }

  /** Take this before sending `thread/read`, and hand it to `upsert` with the answer. */
  clock(): number {
    return this.#clock
  }

  #touch(threadId: string): void {
    this.#touched.delete(threadId)
    this.#touched.set(threadId, ++this.#clock)
    if (this.#touched.size > MAX_TOUCHED) {
      const [oldest, at] = this.#touched.entries().next().value as [string, number]
      this.#touched.delete(oldest)
      // ⚠️ Forgetting a tombstone must not make an old read look fresh (second review, medium #3)
      this.#forgotten = Math.max(this.#forgotten, at)
    }
  }

  /**
   * From `thread/read` (`readStartedAt` = `clock()` taken before sending it) or `thread/started` (no stamp: news).
   * Returns whether it is a row now.
   *
   * ⚠️⚠️ A read answers for the moment it was **served**. If a status change or a close arrived while it was in flight,
   *    its status is old news (codex review, high #2: a rename's read turned a working thread back into "done" and let
   *    a send through; a read in flight across `thread/closed` brought the row back). Then only the metadata is taken,
   *    and a thread that stopped being a row meanwhile stays gone.
   */
  upsert(raw: unknown, readStartedAt?: number): boolean {
    const t = parseThread(raw)
    if (!t) {
      this.#unparsed++
      return false
    }
    if (!isUserThread(t)) {
      this.#threads.delete(t.id)
      this.#hidden.set(t.id, t.threadSource ?? 'null')
      return false
    }
    if (readStartedAt !== undefined && ((this.#touched.get(t.id) ?? -1) > readStartedAt || this.#forgotten > readStartedAt)) {
      const cur = this.#threads.get(t.id)
      if (!cur) return false
      const thread: CodexThread = { ...t, status: cur.thread.status, updatedAt: Math.max(cur.thread.updatedAt, t.updatedAt) }
      this.#threads.set(t.id, { ...cur, thread })
      return true
    }
    if (t.status.type === 'notLoaded') {
      this.#threads.delete(t.id)
      return false
    }
    const prev = this.#threads.get(t.id)
    // ★ A fresh read is what clears "unsure". The mark stays when the status did not change (a rename's read, or the
    //   read after an unreadable status, must not make the notifier drop the turn it is settling).
    this.#threads.set(t.id, {
      thread: t,
      sawActive: (prev?.sawActive ?? false) || t.status.type === 'active',
      ...(prev?.outcome && t.status.type !== 'active' ? { outcome: prev.outcome } : {}),
      mark: prev && sameStatus(prev.thread.status, t.status) ? prev.mark : ++this.#marks,
    })
    return true
  }

  /** Which status of this thread is current (see `StatusChange.mark`); `undefined` = not a row */
  mark(threadId: string): number | undefined {
    return this.#threads.get(threadId)?.mark
  }

  /** Whether this thread is a row right now (a person's loaded thread) */
  isRow(threadId: string): boolean {
    return this.#threads.has(threadId)
  }

  /**
   * Whether this `thread/read` answer moves the status of a thread we **already list** (and is not stale).
   * ★ Then the caller applies it as a status change (`setStatus`) before `upsert`, so a read is never a quieter way to
   *   change a status than a notice (fifth review, medium #1–#2: after an unreadable notice the read was the only
   *   news of a turn ending, or of the thread being unloaded, and nothing — notifier, holds, cards — heard of it).
   * ⚠️ Not for a thread we do not list yet (the snapshot stays silent), and not for a stale read.
   */
  readMovesStatus(raw: unknown, readStartedAt: number): boolean {
    const t = parseThread(raw)
    if (!t || !isUserThread(t)) return false
    if ((this.#touched.get(t.id) ?? -1) > readStartedAt || this.#forgotten > readStartedAt) return false
    const cur = this.#threads.get(t.id)
    return cur !== undefined && !sameStatus(cur.thread.status, t.status)
  }

  /** Whether this thread is a row whose status says it waits on an approval right now */
  waitsOnApproval(threadId: string): boolean {
    const status = this.#threads.get(threadId)?.thread.status
    return status?.type === 'active' && status.waitingOnApproval
  }

  /** Whether this thread is a row whose status says it waits on an answer (a question) right now */
  waitsOnUserInput(threadId: string): boolean {
    const status = this.#threads.get(threadId)?.thread.status
    return status?.type === 'active' && status.waitingOnUserInput
  }

  /** Whether this thread is a row whose status says it waits on an approval or on an answer right now */
  waitsOnPerson(threadId: string): boolean {
    const status = this.#threads.get(threadId)?.thread.status
    return status?.type === 'active' && (status.waitingOnApproval || status.waitingOnUserInput)
  }

  /**
   * ★ Whether the turn running on this thread may be stopped from the phone (`turn/interrupt`).
   * `working`: a turn runs and nothing waits on a person / `waiting`: it waits on an approval or an answer
   * (answer the card first — same as Claude, where ESC would close the dialog; how the TUI takes an interrupt
   * while it asks is not measured) / `idle`: nothing runs (or the status cannot be named).
   */
  stoppable(threadId: string): 'working' | 'waiting' | 'idle' {
    const entry = this.#threads.get(threadId)
    if (!entry || entry.unsure || entry.thread.status.type !== 'active') return 'idle'
    const s = entry.thread.status
    return s.waitingOnApproval || s.waitingOnUserInput ? 'waiting' : 'working'
  }

  /**
   * Whether a new turn may be started on this thread: a row that is plainly idle.
   * ⚠️ Not while it works or waits (`turn/start` on an active turn adds to that turn — not built, not measured),
   *    and not for a status we cannot name.
   */
  acceptsInput(threadId: string): boolean {
    const entry = this.#threads.get(threadId)
    return entry !== undefined && !entry.unsure && entry.thread.status.type === 'idle'
  }

  /** ★ A listed row whose status could be read (not `unsure`): teams grant only on a known state (r7 high #2) */
  statusKnown(threadId: string): boolean {
    const entry = this.#threads.get(threadId)
    return entry !== undefined && !entry.unsure
  }

  has(threadId: string): boolean {
    return this.#threads.has(threadId) || this.#hidden.has(threadId)
  }

  /** From `thread/status/changed`. */
  setStatus(threadId: unknown, rawStatus: unknown, nowSec: number): StatusChange {
    if (typeof threadId !== 'string') return { type: 'ignored' }
    // ★ Even for a thread we do not list (yet): a read already in flight for it is older than this event
    this.#touch(threadId)
    if (this.#hidden.has(threadId)) return { type: 'ignored' }
    const entry = this.#threads.get(threadId)
    if (!entry) return { type: 'unknown-thread' }
    const status = parseStatus(rawStatus)
    if (!status) {
      // ⚠️⚠️ Not "ignored" (third review, medium #1): an idle row stayed sendable while the thread was in a state we
      //    could not name. ⇒ No send until a fresh read (the caller asks for it).
      this.#threads.set(threadId, { ...entry, unsure: true })
      return { type: 'unreadable', thread: entry.thread }
    }
    // ★ "from" is the last status we could read (an unreadable one in between does not erase that a turn was running)
    const from = statusOf(entry.thread.status, entry.sawActive, entry.outcome)
    if (status.type === 'notLoaded') {
      this.#threads.delete(threadId)
      return { type: 'changed', thread: entry.thread, from, to: 'unknown', status, mark: ++this.#marks }
    }
    // ★ A new turn starting clears "done" by itself: `active` maps to working/waiting regardless of `sawActive`
    const sawActive = entry.sawActive || status.type === 'active'
    const thread: CodexThread = { ...entry.thread, status, updatedAt: Math.max(entry.thread.updatedAt, nowSec) }
    // ⚠️ A new turn wipes how the previous one ended
    const outcome = status.type === 'active' ? undefined : entry.outcome
    // ★ The same status said again keeps its mark (a repeated notice must not orphan the change being settled)
    const mark = sameStatus(entry.thread.status, status) ? entry.mark : ++this.#marks
    this.#threads.set(threadId, { thread, sawActive, ...(outcome ? { outcome } : {}), mark })
    return { type: 'changed', thread, from, to: statusOf(status, sawActive, outcome), status, mark }
  }

  /**
   * Record how the turn that just ended really ended. Returns whether the row changed.
   * ⚠️ Only while the thread is idle (or in `systemError`) **in the same status the reader settled** (`mark`, third
   *    review, medium #2): a late answer about turn A must not land on turn B, which started and ended while A's
   *    history was being read.
   */
  setOutcome(threadId: string, outcome: TurnOutcome, mark: number): boolean {
    const entry = this.#threads.get(threadId)
    const type = entry?.thread.status.type
    if (!entry || entry.mark !== mark || (type !== 'idle' && type !== 'systemError') || entry.outcome === outcome) return false
    this.#threads.set(threadId, { ...entry, outcome })
    return true
  }

  /** From `thread/closed` (the daemon unloaded it). */
  close(threadId: unknown): void {
    if (typeof threadId !== 'string') return
    // ★ The tombstone: a read in flight must not bring the row back
    this.#touch(threadId)
    this.#threads.delete(threadId)
    this.#hidden.delete(threadId)
  }

  /** Row id → rollout path, for the threads listed now (the context chip / `context.ts`) */
  rolloutPaths(ctx: ThreadBookRowsContext): Map<string, string> {
    const out = new Map<string, string>()
    for (const { thread: t } of this.#threads.values()) if (t.path) out.set(ctx.idPrefix + t.id, t.path)
    return out
  }

  rows(ctx: ThreadBookRowsContext): SessionSummary[] {
    const out: SessionSummary[] = []
    for (const { thread: t, sawActive, outcome } of this.#threads.values()) {
      const row = threadRow(t, ctx, statusOf(t.status, sawActive, outcome), true)
      const why = waitingForOf(t.status)
      out.push(why ? { ...row, waitingFor: why } : row)
    }
    return sortRows(out)
  }

  /**
   * The rows that stand in a state worth a notification right now (waiting / error / rate-limited), as status changes
   * from "unknown".
   * ★ For a reconnect: a "needs you" that could not be sent while the line was down has no status change to carry it.
   */
  standing(): Array<Extract<StatusChange, { type: 'changed' }>> {
    const out: Array<Extract<StatusChange, { type: 'changed' }>> = []
    for (const { thread, sawActive, outcome, mark } of this.#threads.values()) {
      const to = statusOf(thread.status, sawActive, outcome)
      if (to === 'waiting' || to === 'error' || to === 'rate-limited') out.push({ type: 'changed', thread, from: 'unknown', to, status: thread.status, mark })
    }
    return out
  }

  /** For diagnostics: how many threads are hidden, by `threadSource`, and how many did not parse. */
  diagnostics(): { hidden: Record<string, number>; unparsed: number } {
    const hidden: Record<string, number> = {}
    for (const src of this.#hidden.values()) hidden[src] = (hidden[src] ?? 0) + 1
    return { hidden, unparsed: this.#unparsed }
  }
}
