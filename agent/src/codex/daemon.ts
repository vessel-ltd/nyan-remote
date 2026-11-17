// ★★ The line to one Codex app-server daemon (2026-11-14 / docs/CODEX.md §5).
//
// What it does: wait for the daemon's socket, connect, `initialize`, take a snapshot of the loaded threads, keep the
// thread book current from notifications, and reconnect when the line drops.
//
// The rules (each one measured or read in the 0.169.0 source; see docs/CODEX.md):
//  1. ⚠️⚠️ **Never start the daemon.** No socket ⇒ wait. The user's `codex` starts it.
//  2. ⚠️⚠️ **Never initialize a daemon whose socket is younger than `SETTLE_MS`.** The first originating client to
//     initialize a fresh daemon becomes its process-wide `originator`; if that is us, the user's TUI threads are no
//     longer first-party. Measured: at 0s we always won that race (bad), at ≥1s the TUI always did.
//     ⚠️ This **reduces** the race, it does not prevent it (a wait is not an ordering guarantee).
//     ⬜ Detecting afterwards that we lost it (a TUI thread whose originator is ours) is not built yet.
//  3. ⚠️⚠️ **Never pass feature or config overrides.** This layer only reads (`thread/loaded/list`, `thread/read`
//     without turns, `thread/turns/list` for a listed thread) and listens. The one exception is `approvals.ts`
//     (only when the caller gives `offerApproval`): it joins a thread that waits on an approval (or on an answer, when
//     `askQuestion` is given too), and leaves after. ★ For a file change it joins once more **with the history**, to
//     read the diff (`fileChanges.ts`; the rollout's size is checked first, once per request for the line).
//  4. ⚠️⚠️ **A server request is never answered here** (not with a result, not with an error). Counted only.
//     Only `approvals.ts` answers: the plain command approval, a question and a file change, with the phone's own
//     decision.
//  5. The line ends with a bare EOF (no close frame). A reconnect is a **new generation**: new book, nothing carried over.
//  6. Reconnect waits double with jitter, capped; they reset only after the line stayed up for a while.

import { createHash } from 'node:crypto'
import { codexSessionPrefix as prefixOf } from './ids.ts'
import type { CodexLineHealth, SessionSummary } from '../../../shared/types.ts'
import { CodexApprovals, type CodexApproval, type PhoneDecision, type QuestionReply } from './approvals.ts'
import type { CodexQuestion } from './questions.ts'
import { findChanges, MAX_ROLLOUT_BYTES, type CodexFileChange, type FileChange } from './fileChanges.ts'
import { parseTurnsPage, type TurnsPage } from './history.ts'
import { createRpc, type Rpc, type RpcFailure, type RpcResult } from './rpc.ts'
import { ThreadBook, type StatusChange, type TurnOutcome } from './threads.ts'
import type { WsClosed, WsUdsConnection } from './wsUds.ts'
import { ClosedThreads } from './closedThreads.ts'

/** Do not initialize a daemon whose socket is younger than this */
export const SETTLE_MS = 3000
/** How often to look for the socket while there is no daemon */
export const POLL_MS = 2000
const BACKOFF_FIRST_MS = 1000
const BACKOFF_MAX_MS = 60_000
/** The line must have stayed up this long for the backoff to start over */
const SETTLED_MS = 30_000
/**
 * After a `turn/start` was taken (or may have been), no second send goes to that thread until its status moves or
 * this long passes (codex review, high #3). Longer than an RPC timeout.
 */
export const SEND_HOLD_MS = 15_000
/** `account/read` answers from the daemon's own auth (measured 3 ms); longer than this ⇒ shown without the login */
export const ACCOUNT_READ_TIMEOUT_MS = 2_000
/** Bounds for the snapshot (hostile input: never follow cursors forever) */
const MAX_PAGES = 20
const MAX_THREADS = 500

export interface CodexHome {
  /** Stable id from our config (part of the row identity; ⚠️ not the base name: two homes can share one) */
  id: string
  /** What the UI shows as the account (the base name of the home) */
  label: string
  socketPath: string
}

/** The front of a Codex row's `sessionId` (`ids.ts`): `codex-<16 hex of the home id>-`, then the thread id. */
export function codexSessionPrefix(homeId: string): string {
  return prefixOf(homeId, (x) => createHash('sha256').update(x, 'utf8').digest('hex'))
}

export { isCodexSessionId } from './ids.ts'

export type SocketLook =
  | { type: 'absent' }
  /** `ageMs`: how long ago the socket itself was created; `key`: identity of this socket (changes when the daemon restarts) */
  | { type: 'present'; ageMs: number; key: string }
  /** It exists but we may not look at it (permissions). ⚠️ Not the same as absent. */
  | { type: 'denied'; code: string }

export interface DaemonDeps {
  look(path: string): Promise<SocketLook>
  connect(path: string, onMessage: (text: string) => void): Promise<WsUdsConnection>
  /** Resolves after `ms`, or early when `signal` aborts */
  sleep(ms: number, signal: AbortSignal): Promise<void>
  now(): number
  /** 0 ≤ x < 1 */
  random(): number
  /**
   * The size of a file in bytes (`undefined` = unknown). Used on a thread's rollout before its full history is asked
   * for (`fileChanges.ts` rule 2). ⚠️ Absent ⇒ file-change diffs are never fetched (no card).
   */
  fileSize?(path: string): Promise<number | undefined>
}

export type DaemonState =
  | { type: 'no-daemon' }
  | { type: 'denied'; code: string }
  | { type: 'settling' }
  | { type: 'connecting' }
  | { type: 'connected'; since: number; codexHome?: string }
  | { type: 'failed'; reason: string }
  | { type: 'stopped' }

export interface DaemonHooks {
  /** The set of rows or a row's status changed */
  onChange?: () => void
  /** One thread changed status (for notifications) */
  onStatus?: (change: Extract<StatusChange, { type: 'changed' }>) => void
  /**
   * Show an approval card and wait for the phone (see `ApprovalsDeps.offer`). `row` is the thread's row as listed.
   * ⚠️ Absent ⇒ approvals are off: no thread is ever joined and no server request is ever answered.
   */
  offerApproval?: (
    approval: CodexApproval,
    row: SessionSummary,
    onWithdraw: (withdraw: () => void) => void,
  ) => Promise<PhoneDecision | undefined>
  /**
   * The same for a file change with its diff (`fileChanges.ts`). Only with `offerApproval`.
   * ⚠️ Absent ⇒ file changes are never answered.
   */
  offerFileChange?: (
    change: CodexFileChange,
    row: SessionSummary,
    onWithdraw: (withdraw: () => void) => void,
  ) => Promise<PhoneDecision | undefined>
  /**
   * The same for a question (`item/tool/requestUserInput` / `questions.ts`). Only with `offerApproval`.
   * ⚠️ Absent ⇒ questions are never answered (and a thread that only waits on an answer is never joined).
   */
  askQuestion?: (
    question: CodexQuestion,
    row: SessionSummary,
    onWithdraw: (withdraw: () => void) => void,
  ) => Promise<QuestionReply | undefined>
  /** A listed thread was closed by the daemon (the Codex counterpart of a session ending). Gets the row's `sessionId`. */
  onClosed?: (sessionId: string) => void
  /**
   * ★ A complete list of the loaded threads was read (each connect, the first included). `prefix`: this home's row ids;
   * `loaded`: the row ids of every thread loaded now. Anything of this home that is not in it was closed — maybe while
   * the line was down or the agent was off, when no `thread/closed` could reach us (codex review 2026-11-17, high).
   * ⚠️ Only from a complete list (a partial one would end threads that are open).
   */
  onLoadedSnapshot?: (prefix: string, loaded: ReadonlySet<string>) => void
  /** The line has connected (initialized) to the daemon — each time, reconnects included */
  onConnected?: () => void
  log?: (line: string) => void
}

export interface DaemonOptions {
  home: CodexHome
  machine: string
  clientName: string
  clientVersion: string
  deps: DaemonDeps
  hooks?: DaemonHooks
  /** ★ Tests only: the RPC timeout (the default is rpc.ts's) */
  rpcTimeoutMs?: number
  /** ★ How many closed threads are listed as history (`closedThreads.ts`). Default 60 (Claude's per account). */
  historyLimit?: number
}

export type DaemonHealth = CodexLineHealth

export type CodexSendResult =
  | { ok: true }
  /** `not-listed`: no such row on this line now / `busy`: working or waiting / `failed`: the daemon did not take it */
  | { ok: false; reason: 'not-listed' | 'busy' | 'failed'; detail?: string }

export type CodexInterruptResult =
  | { ok: true }
  /**
   * `not-listed`: no such row on this line now / `idle`: no turn runs / `waiting`: it waits on an approval or an answer /
   * `too-soon`: a stop for this thread is already on its way / `failed`: the daemon did not take it
   */
  | { ok: false; reason: 'not-listed' | 'idle' | 'waiting' | 'too-soon' | 'failed'; detail?: string }

export interface CodexDaemonLine {
  /** Label of the home this line serves */
  readonly label: string
  /** The row `sessionId` of a thread of this line */
  sessionIdOf(threadId: string): string
  /** The thread id behind a row `sessionId` of this line, or `undefined` if the id is not this line's (by its form only) */
  threadOf(sessionId: string): string | undefined
  /** Whether this thread is a row right now */
  lists(threadId: string): boolean
  /** ★ Whether this thread is a row or a history row right now (its conversation may be read; nothing else) */
  knows(threadId: string): boolean
  /** ★ Closed threads as history rows (`live: false`) */
  historyRows(): SessionSummary[]
  /** ★ Read the closed threads again if the last read is older than `ms` (the phone opened its history) */
  refreshHistory(ms: number): void
  /** Changes on every (re)connect */
  generation(): number
  /**
   * Read the newest turns of a thread (or the page behind `cursor`). `undefined` when it cannot be read now.
   * ⚠️ Only for a thread that is **a row or a history row right now**: an id from outside never reaches the daemon.
   *    (Measured: `thread/turns/list` on a closed thread does not load it.)
   * `headersOnly`: the turns without their items (ids and statuses only). ⚠️⚠️ Used by every reader that does not show
   *    the conversation (codex review 2026-11-17, medium): a full newest turn can be megabytes, and one over the frame
   *    cap ends the whole line (every approval card with it) just to word a notification.
   */
  turns(threadId: string, opts: { limit: number; cursor?: string; headersOnly?: boolean }): Promise<TurnsPage | undefined>
  /**
   * Record how the turn that just ended really ended (read back from the history). Tells `onChange` if the row changed.
   * `mark`: the status change it was settled for (`StatusChange.mark`); a newer status of the thread refuses it.
   */
  setOutcome(threadId: string, outcome: TurnOutcome, mark: number): void
  /** Which status of this thread is current (`StatusChange.mark`), `undefined` = not a row of this connection */
  mark(threadId: string): number | undefined
  /**
   * ★ Say `text` to a thread as the person (starts a turn; measured: it shows in the TUI as a human message).
   * ⚠️⚠️ `turn/start` carries the thread id and the text, nothing else: no model, sandbox, approval-policy or cwd
   *    override (each of those lasts beyond this turn).
   * ⚠️ Only for a row that is idle right now. The caller validates the text.
   */
  send(threadId: string, text: string): Promise<CodexSendResult>
  /**
   * ★ Compact the thread's context (`thread/compact/start`; the TUI's own `/compact` / docs/CODEX.md §5.8).
   * ⚠️⚠️ Only for a row that is idle right now: the daemon aborts any running or waiting turn to compact
   *    (`abort_all_tasks(Replaced)`), so this is judged at the press and again right before the write (as `send`).
   * ⚠️ It shares `send`'s hold: a second press (or a send) is `busy` until the status moves.
   */
  compact(threadId: string): Promise<CodexSendResult>
  /**
   * ★ The account's plan limits (`account/rateLimits/read`: no thread is joined or loaded; the daemon asks its server,
   *   measured ~0.5 s). The raw result, or `undefined` when it cannot be read now (`usage.ts` parses it).
   */
  rateLimits(): Promise<unknown>
  /**
   * ★ Who is logged in (`account/read` with `refreshToken: false`: answered from the daemon's own auth, no network —
   *   measured 3 ms). The raw result, or `undefined` when it cannot be read now (`usage.ts` parses it).
   */
  account(): Promise<unknown>
  /**
   * ★ Stop the turn that runs on this thread now (measured: the TUI's turn ends `interrupted`, the TUI goes back to
   *   waiting and takes the next input / docs/CODEX.md §3).
   * ⚠️⚠️ Only **the turn that ran when asked**: `turn/interrupt` names it by id, so a turn that starts meanwhile is
   *    never stopped by this press. Not while it waits on a person (answer the card first).
   */
  interrupt(threadId: string): Promise<CodexInterruptResult>
  rows(): SessionSummary[]
  /** Row id → the thread's rollout path (stays on the agent; the context chip reads its tail) */
  rolloutPaths(): Map<string, string>
  health(): DaemonHealth
  stop(): void
  /** Resolves when the loop has ended (after `stop`) */
  readonly done: Promise<void>
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Why a stop was not sent after its status moved: the new state, and "idle" when a newer turn runs (it ended) */
function movedReason(now: 'working' | 'waiting' | 'idle'): 'waiting' | 'idle' {
  return now === 'waiting' ? 'waiting' : 'idle'
}

/** A failed call in a few words for the log: the kind and the code, never the daemon's message (it can quote text) */
function failureDetail(f: RpcFailure): string {
  return f.type === 'error' ? `error ${String(f.error.code)}` : f.type === 'timeout' ? (f.written ? 'timeout-unknown' : 'timeout-unsent') : f.type
}

/** ★ How many file-change lookups the line remembers at once (each one is a request still waiting) */
export const MAX_DIFF_LOOKUPS = 256

export function nextBackoff(prev: number, random: number): number {
  // ★ Jitter: 50%–100% of the step (applied to the wait, not to the stored step, so the doubling stays clean)
  return Math.round(backoffStep(prev) * (0.5 + random / 2))
}

function backoffStep(prev: number): number {
  return prev === 0 ? BACKOFF_FIRST_MS : Math.min(prev * 2, BACKOFF_MAX_MS)
}

export function startCodexDaemonLine(opts: DaemonOptions): CodexDaemonLine {
  const { home, deps, machine } = opts
  const hooks = opts.hooks ?? {}
  const book = new ThreadBook()
  const idPrefix = codexSessionPrefix(home.id)
  const rowsCtx = { machine, account: home.label, idPrefix }
  // ★ `liveRpc` is declared below; this is only called once a line is up
  const closed = new ClosedThreads({
    call: (method, params) => liveRpc?.call(method, params),
    isLive: (id) => book.isRow(id),
    now: () => deps.now(),
    changed: () => hooks.onChange?.(),
    limit: opts.historyLimit ?? 60,
  })
  /**
   * Rule for `send` (high #3): thread id → the one send that owns the thread now.
   * `token`: which send (a queued write checks it is still the owner — second review, high #1).
   * `until`: when it lapses; `undefined` = never by time (the daemon may have taken it and we do not know).
   */
  const holds = new Map<string, { token: object; until: number | undefined }>()
  /**
   * ★ Diffs looked up for file-change approvals, **once per request for the whole line** (`fileChanges.ts` rule 3):
   *   the full-history join replays the request, and a reply over the message limit drops the line — asking again
   *   on the replay or after the reconnect would loop.
   * ⚠️⚠️ **Never evicted while its request can still be replayed** (codex review 2026-11-16, medium: dropping the oldest
   *    made 65 waiting approvals each fetch again after a reconnect). An entry goes only when its thread stops waiting
   *    on an approval or closes (the request is over, nothing replays it). Full ⇒ no new lookup (no card; the PC).
   */
  const diffs = new Map<string, { threadId: string; changes: Promise<FileChange[] | undefined> }>()
  const forgetDiffs = (threadId: string): void => {
    for (const [k, v] of diffs) if (v.threadId === threadId) diffs.delete(k)
  }
  /** Threads a stop is on its way to (two presses send one `turn/interrupt`) */
  const stopping = new Set<string>()
  const abort = new AbortController()
  let state: DaemonState = { type: 'no-daemon' }
  let unanswered = 0
  let current: WsUdsConnection | undefined
  let liveRpc: Rpc | undefined
  let generation = 0

  /** Whether a state was logged yet (the first one is logged even when it is the starting `no-daemon`) */
  let stateLogged = false
  const setState = (s: DaemonState): void => {
    // ★ The first state is said too: on a PC without Codex the line stays `no-daemon` forever, and `nyan status` reads
    //   the state from the log (it must be able to say "no Codex" instead of "no state in the logs").
    const changed = s.type !== state.type || !stateLogged
    stateLogged = true
    state = s
    // ⚠️ The home's path, not its label: two homes can share a base name, and `nyan status` keeps states per home
    if (changed) hooks.log?.(`[codex] ${home.id}: ${s.type}${'reason' in s ? ` (${s.reason})` : 'code' in s ? ` (${s.code})` : ''}`)
  }

  /** One connected session. Returns when the line is over. */
  async function session(): Promise<WsClosed> {
    let rpc: Rpc | undefined
    // ★ Messages can arrive before `rpc` exists only in theory (we send first), but never drop them silently
    const early: string[] = []
    const conn = await deps.connect(home.socketPath, (text) => (rpc ? rpc.receive(text) : early.push(text)))
    current = conn
    // ★ Reads for threads we learn about from notifications run one at a time, in order
    let chain: Promise<void> = Promise.resolve()
    const offer = hooks.offerApproval
    const ask = hooks.askQuestion
    const offerFile = hooks.offerFileChange
    const fileSize = deps.fileSize
    /**
     * ★★ The full-history join on **a connection of its own** (codex review 2026-11-16, round 5, medium): the reply
     *    carries the pending diff, and deleting a large existing file puts that file's whole content in it — a short
     *    rollout does not bound the reply. A reply over the message limit then drops only this connection, never the
     *    line (whose other cards would go with it).
     * Measured the same day (`probe-diff.ts`): a separate connection joined a thread waiting on a file change with the
     * history, unsubscribed and closed; the PC's approval kept waiting and was answered there.
     * ⚠️ The request replayed to this connection is never answered (it has no `onServerRequest`).
     */
    const sideResume = async (threadId: string, still: () => boolean): Promise<unknown> => {
      let side: Rpc | undefined
      const early: string[] = []
      let conn: WsUdsConnection
      try {
        conn = await deps.connect(home.socketPath, (text) => (side ? side.receive(text) : early.push(text)))
      } catch {
        return undefined
      }
      try {
        const rpcSide = createRpc({
          ...(opts.rpcTimeoutMs === undefined ? {} : { timeoutMs: opts.rpcTimeoutMs }),
          send: (t, guard) => conn.send(t, guard),
          onServerRequest: () => undefined,
          onNotification: () => undefined,
        })
        side = rpcSide
        for (const t of early) rpcSide.receive(t)
        void conn.closed.then((why) => rpcSide.fail(why.reason))
        const init = await rpcSide.call('initialize', {
          clientInfo: { name: opts.clientName, title: null, version: opts.clientVersion },
          capabilities: { experimentalApi: false, requestAttestation: false },
        })
        if (!init.ok) return undefined
        await rpcSide.notify('initialized')
        const res = await rpcSide.call('thread/resume', { threadId, excludeTurns: false }, { guard: still })
        if (!res.ok) {
          hooks.log?.(`[codex] could not read a file change's diff (${failureDetail(res.failure)}; left to the PC)`)
          return undefined
        }
        // ★ Leave before closing, as measured
        await rpcSide.call('thread/unsubscribe', { threadId })
        return res.result
      } finally {
        conn.close()
      }
    }
    const fetchChanges = (threadId: string, turnId: string, itemId: string, live: () => boolean): Promise<FileChange[] | undefined> => {
      const k = [threadId, turnId, itemId].join('\0')
      const known = diffs.get(k)
      if (known) return known.changes
      if (diffs.size >= MAX_DIFF_LOOKUPS) {
        hooks.log?.('[codex] too many file changes waiting at once; this one is left to the PC')
        return Promise.resolve(undefined)
      }
      const p = (async (): Promise<FileChange[] | undefined> => {
        const r = rpc!
        // ⚠️ Rule 2: the rollout's size first (the reply carries the whole conversation)
        const read = await r.call('thread/read', { threadId })
        const thread = read.ok && isObject(read.result) ? read.result.thread : undefined
        if (!isObject(thread) || thread.id !== threadId) return undefined
        // ⚠️⚠️ This read is fresher than the book (codex review, medium): the PC may have answered and the notice not
        //    arrived yet. Not waiting on an approval here ⇒ no join (a resume on a thread that is not running loads it).
        const st = thread.status
        if (!isObject(st) || st.type !== 'active' || !Array.isArray(st.activeFlags) || !st.activeFlags.includes('waitingOnApproval')) {
          return undefined
        }
        const path = thread.path
        if (typeof path !== 'string' || !fileSize) return undefined
        const size = await fileSize(path)
        if (size === undefined || size > MAX_ROLLOUT_BYTES) {
          hooks.log?.(`[codex] a file change waits, but its thread is too long to read the diff (${size ?? '?'} bytes; left to the PC)`)
          return undefined
        }
        // ⚠️ Asked again right before writing: the request still has a card (answered on the PC ⇒ withdrawn; round 4,
        //    medium) and the thread still waits on an approval
        const still = (): boolean => live() && book.waitsOnApproval(threadId)
        if (!still()) return undefined
        const reply = await sideResume(threadId, still)
        return reply === undefined ? undefined : findChanges(reply, turnId, itemId)
      })().catch(() => undefined)
      diffs.set(k, { threadId, changes: p })
      return p
    }
    const rowOf = (threadId: string): SessionSummary | undefined => book.rows(rowsCtx).find((x) => x.sessionId === idPrefix + threadId)
    const approvals: CodexApprovals | undefined = offer
      ? new CodexApprovals({
          call: (method, params, guard) => rpc!.call(method, params, guard ? { guard } : undefined),
          respond: (id, result, guard) => rpc!.respond(id, result, guard),
          // ★ A thread that waits on an answer is joined only when questions are taken. A card asks for its own kind.
          isWaiting: (id, on) =>
            on === 'approval'
              ? book.waitsOnApproval(id)
              : on === 'answer'
                ? book.waitsOnUserInput(id)
                : ask
                  ? book.waitsOnPerson(id)
                  : book.waitsOnApproval(id),
          sleep: (ms) => deps.sleep(ms, abort.signal),
          offer: (approval, onWithdraw) => {
            const row = rowOf(approval.threadId)
            // ★ For the types only: `isWaiting` was just true, so the row exists
            return row ? offer(approval, row, onWithdraw) : Promise.resolve(undefined)
          },
          ...(offerFile && fileSize
            ? {
                fetchChanges,
                offerFileChange: (change: CodexFileChange, onWithdraw: (withdraw: () => void) => void) => {
                  const row = rowOf(change.threadId)
                  return row ? offerFile(change, row, onWithdraw) : Promise.resolve(undefined)
                },
              }
            : {}),
          ...(ask
            ? {
                ask: (question: CodexQuestion, onWithdraw: (withdraw: () => void) => void) => {
                  const row = rowOf(question.threadId)
                  return row ? ask(question, row, onWithdraw) : Promise.resolve(undefined)
                },
              }
            : {}),
          log: hooks.log,
        })
      : undefined
    // ★ The line is over ⇒ every card goes away (a reconnect makes new ones from the replay)
    void conn.closed.then(() => approvals?.dispose())
    /** ★ The one place a status change takes effect (from a notice, or from a read that moved it) */
    const statusChanged = (change: Extract<StatusChange, { type: 'changed' }>): void => {
      // ★ The thread moved: a send held back for it may be judged again from its status
      if (change.status.type !== 'idle') holds.delete(change.thread.id)
      hooks.onChange?.()
      hooks.onStatus?.(change)
      // ★ No longer waiting on an approval ⇒ its file-change requests are over (none can be replayed)
      if (!book.waitsOnApproval(change.thread.id)) forgetDiffs(change.thread.id)
      approvals?.sync(change.thread.id)
      // ⚠️⚠️ Unloaded is the end of the row, as much as `thread/closed` is (sixth review, high #1): the row is gone now, so a
      //    later `thread/closed` no longer finds it listed and would end nothing — auto-approve then outlived the thread
      //    and came back with it. Only a listed thread gets here (`setStatus` answers "changed" for rows only).
      if (change.status.type === 'notLoaded') {
        hooks.onClosed?.(idPrefix + change.thread.id)
        // ★ It is history now
        void closed.refresh()
      }
    }
    const readThread = async (r: Rpc, threadId: string): Promise<void> => {
      // ★ Stamped: a status change or a close that arrives while this read is in flight wins over its answer (high #2)
      const startedAt = book.clock()
      const res = await r.call('thread/read', { threadId })
      // ⚠️ The answer must be about the thread we asked for (another program's output)
      const thread = res.ok && isObject(res.result) ? res.result.thread : undefined
      if (!isObject(thread) || thread.id !== threadId) return
      // ★ A read that moves the status of a listed thread goes the same way as a notice (fourth review medium #3,
      //   fifth review medium #1–#2): holds, notifier and cards hear of it. `upsert` then takes only the metadata.
      if (book.readMovesStatus(thread, startedAt)) {
        const change = book.setStatus(threadId, thread.status, Math.floor(deps.now() / 1000))
        if (change.type === 'changed') statusChanged(change)
      }
      if (book.upsert(thread, startedAt)) {
        hooks.onChange?.()
        // ★ A thread that was already waiting when we connected has no status change to tell us
        approvals?.sync(threadId)
      }
    }

    rpc = createRpc({
      ...(opts.rpcTimeoutMs === undefined ? {} : { timeoutMs: opts.rpcTimeoutMs }),
      // ⚠️ The guard must reach the line: it is what keeps an ended or no-longer-valid request from being written
      send: (t, guard) => conn.send(t, guard),
      onServerRequest: (req) => {
        // ⚠️⚠️ Rule 4: not answered. The TUI (or nobody) answers; an error from us could fail a request it would have handled.
        if (!approvals?.onServerRequest(req)) unanswered++
      },
      onNotification: (method, params) => {
        if (!isObject(params)) return
        const r = rpc!
        switch (method) {
          case 'thread/started':
            if (book.upsert(params.thread)) hooks.onChange?.()
            break
          case 'thread/status/changed': {
            const change = book.setStatus(params.threadId, params.status, Math.floor(deps.now() / 1000))
            if (change.type === 'changed') {
              statusChanged(change)
            } else if (change.type === 'unreadable') {
              // ★ No send until a fresh read (third review, medium #1). Nothing else changes (see `Entry.unsure`).
              const id = change.thread.id
              chain = chain.then(() => readThread(r, id)).catch(() => undefined)
            } else if (change.type === 'unknown-thread' && typeof params.threadId === 'string') {
              const id = params.threadId
              chain = chain.then(() => readThread(r, id)).catch(() => undefined)
            }
            break
          }
          case 'thread/name/updated': {
            // ★ A rename (`/rename` in the TUI). Read the thread again so the title is built in one place.
            //   Only for rows we already list: a rename never makes a thread appear.
            const id = params.threadId
            if (typeof id === 'string' && book.isRow(id)) chain = chain.then(() => readThread(r, id)).catch(() => undefined)
            break
          }
          // ★ The saved threads changed: the history list is read again
          case 'thread/archived':
          case 'thread/unarchived':
          case 'thread/deleted':
            void closed.refresh()
            break
          case 'serverRequest/resolved':
            approvals?.onResolved(params)
            break
          case 'thread/closed':
          {
            // ⚠️ Asked before the row is dropped: only a thread we list ends anything (an id from the wire alone does not)
            const listed = typeof params.threadId === 'string' && book.isRow(params.threadId)
            book.close(params.threadId)
            if (typeof params.threadId === 'string') holds.delete(params.threadId)
            if (typeof params.threadId === 'string') forgetDiffs(params.threadId)
            hooks.onChange?.()
            if (typeof params.threadId === 'string') approvals?.sync(params.threadId)
            if (listed) hooks.onClosed?.(idPrefix + (params.threadId as string))
            // ★ It is history now (`closedThreads.ts`)
            if (listed) void closed.refresh()
          }
            break
          default:
            break
        }
      },
    })
    for (const t of early) rpc.receive(t)

    const live = rpc
    void conn.closed.then((why) => live.fail(why.reason))

    const init: RpcResult = await live.call('initialize', {
      clientInfo: { name: opts.clientName, title: null, version: opts.clientVersion },
      // ⚠️ Nothing experimental, no attestation, no human-approval capability (docs/CODEX.md §6)
      capabilities: { experimentalApi: false, requestAttestation: false },
    })
    if (!init.ok) {
      conn.close()
      const why = await conn.closed
      return why.reason === 'local' ? { reason: 'error', detail: `initialize:${init.failure.type}` } : why
    }
    await live.notify('initialized')
    const codexHome = isObject(init.result) && typeof init.result.codexHome === 'string' ? init.result.codexHome : undefined
    setState({ type: 'connected', since: deps.now(), ...(codexHome ? { codexHome } : {}) })
    hooks.onConnected?.()
    generation++
    liveRpc = live

    // Snapshot. ⚠️ Notifications that arrive meanwhile are applied as they come; a thread read twice is the same row.
    let cursor: string | null = null
    let seen = 0
    /** ★ The whole list was read (every page, under the bounds) */
    let complete = false
    /** The thread ids the list named (read or not) */
    const listed = new Set<string>()
    for (let page = 0; page < MAX_PAGES && seen < MAX_THREADS; page++) {
      const res: RpcResult = await live.call('thread/loaded/list', cursor === null ? {} : { cursor })
      if (!res.ok || !isObject(res.result) || !Array.isArray(res.result.data)) break
      for (const id of res.result.data) {
        if (typeof id !== 'string' || seen >= MAX_THREADS) continue
        seen++
        listed.add(id)
        if (!book.has(id)) await readThread(live, id)
      }
      const next: unknown = res.result.nextCursor
      if (typeof next !== 'string' || next === '') {
        complete = seen < MAX_THREADS
        break
      }
      if (next === cursor) break
      cursor = next
    }
    // ★ File-change lookups of threads that stopped waiting (or closed) while the line was down: no status change will
    //   come for them on this connection (codex review 2026-11-16, round 2, medium). Pruned only from a complete
    //   snapshot, and only what is **known**: a thread the complete list did not name (closed), or one that was read
    //   and does not wait on an approval. ⚠️ A listed thread whose read failed keeps its entry (round 3, medium: its
    //   status is unknown, and its replay must not fetch again).
    // ★ History: read the closed threads once the live ones are known (a thread in the book is never history)
    if (liveRpc === live) void closed.refresh()
    if (complete && liveRpc === live) {
      for (const { threadId } of [...diffs.values()]) {
        // ⚠️ A thread waiting now is never pruned, listed or not (round 4, medium: one that started during the
        //    snapshot was not in the list, and its live lookup was dropped)
        const gone = !book.waitsOnApproval(threadId) && (!listed.has(threadId) || book.has(threadId))
        if (gone) forgetDiffs(threadId)
      }
      // ⚠️ The threads that became rows during the snapshot count as loaded too (the list may predate them)
      const loaded = new Set<string>([...listed].map((id) => idPrefix + id))
      for (const r of book.rows(rowsCtx)) loaded.add(r.sessionId)
      hooks.onLoadedSnapshot?.(idPrefix, loaded)
    }
    hooks.onChange?.()
    // ★ A reconnect: a "needs you" that could not be sent while the line was down has no status change to carry it
    //   (codex review, medium #6). The notifier remembers what it already sent, so a thread told about is not told again.
    //   ⚠️ Not on the first connection: then nothing was missed by us (the agent just started).
    if (generation > 1 && liveRpc === live) for (const change of book.standing()) hooks.onStatus?.(change)

    return conn.closed
  }

  async function loop(): Promise<void> {
    let step = 0
    const sleep = (ms: number): Promise<void> => deps.sleep(ms, abort.signal)
    while (!abort.signal.aborted) {
      const look = await deps.look(home.socketPath)
      if (abort.signal.aborted) break
      if (look.type === 'absent') {
        setState({ type: 'no-daemon' })
        step = 0
        await sleep(POLL_MS)
        continue
      }
      if (look.type === 'denied') {
        setState({ type: 'denied', code: look.code })
        await sleep(POLL_MS * 5)
        continue
      }
      if (look.ageMs < SETTLE_MS) {
        // Rule 2. ⚠️ Look again afterwards (the socket may have been replaced while we waited)
        setState({ type: 'settling' })
        await sleep(SETTLE_MS - look.ageMs)
        continue
      }
      setState({ type: 'connecting' })
      const startedAt = deps.now()
      let why: WsClosed
      try {
        why = await session()
      } catch (err) {
        why = isObject(err) && typeof err.reason === 'string' ? (err as unknown as WsClosed) : { reason: 'error', detail: 'connect' }
      }
      current = undefined
      liveRpc = undefined
      book.reset()
      holds.clear()
      hooks.onChange?.()
      if (abort.signal.aborted) break
      setState({ type: 'failed', reason: why.detail ? `${why.reason}:${why.detail}` : why.reason })
      if (deps.now() - startedAt >= SETTLED_MS) step = 0
      const wait = nextBackoff(step, deps.random())
      step = backoffStep(step)
      await sleep(wait)
    }
    setState({ type: 'stopped' })
  }

  const done = loop()

  /**
   * ★ Start something on a thread that is an idle row right now: a turn (`send`) or a compaction (`compact`).
   * ⚠️⚠️ Both share one hold: a send and a compaction pressed at once are one press (the second is `busy`), and the
   *    daemon would let either one replace the other (`thread/compact/start` aborts any running turn / docs/CODEX.md §5.8).
   */
  async function startOnIdle(threadId: string, method: string, params: Record<string, unknown>): Promise<CodexSendResult> {
    const rpc = liveRpc
    if (!rpc || !book.isRow(threadId)) return { ok: false, reason: 'not-listed' }
    // ⚠️⚠️ Reserved **before the first await** (high #3): two phones sending at once both saw "idle", and the second
    //    `turn/start` then went into the first one's running turn. Held until the status moves (or `SEND_HOLD_MS`).
    const held = holds.get(threadId)
    if (held && (held.until === undefined || deps.now() < held.until)) return { ok: false, reason: 'busy' }
    if (!book.acceptsInput(threadId)) return { ok: false, reason: 'busy' }
    const mine = { token: {}, until: deps.now() + SEND_HOLD_MS as number | undefined }
    holds.set(threadId, mine)
    const owns = (): boolean => holds.get(threadId) === mine
    // ⚠️ Judged again right before the bytes go out (high #4): a turn/start queued behind a slow line is not
    //    written once the thread is no longer an idle row of this connection, or after the call has timed out.
    // ⚠️⚠️ And only while this send still owns the thread (second review, high #1): a status move ends the hold
    //    for good, so a queued send that saw active → idle meanwhile is not written next to a newer send.
    const res = await rpc.call(method, params, {
      guard: () => owns() && liveRpc === rpc && book.isRow(threadId) && book.acceptsInput(threadId),
    })
    if (res.ok) return { ok: true }
    const f = res.failure
    if (owns()) {
      // ★ Written and no answer: the daemon may have taken it. Time alone does not say it did not, so this hold
      //   lapses only when the thread's status moves (or it closes, or the line ends) — fail closed.
      if (f.type === 'timeout' && f.written) mine.until = undefined
      else holds.delete(threadId)
    }
    // ⚠️ Only the kind and the code: the daemon's message could quote the text
    const detail = failureDetail(f)
    return { ok: false, reason: f.type === 'cancelled' ? 'busy' : 'failed', detail }
  }

  return {
    label: home.label,
    sessionIdOf: (threadId) => idPrefix + threadId,
    threadOf: (sessionId) => (sessionId.startsWith(idPrefix) && sessionId.length > idPrefix.length ? sessionId.slice(idPrefix.length) : undefined),
    lists: (threadId) => book.isRow(threadId),
    knows: (threadId) => book.isRow(threadId) || closed.has(threadId),
    historyRows: () => closed.rows(rowsCtx),
    refreshHistory: (ms) => {
      if (liveRpc) closed.refreshIfOlder(ms)
    },
    generation: () => generation,
    turns: async (threadId, o) => {
      const rpc = liveRpc
      // ⚠️ A row or a history row only (never an id from outside)
      if (!rpc || !(book.isRow(threadId) || closed.has(threadId))) return undefined
      const res = await rpc.call('thread/turns/list', {
        threadId,
        limit: o.limit,
        // ★ Both stated explicitly (the defaults differ between turns and items; measured)
        sortDirection: 'desc',
        itemsView: o.headersOnly === true ? 'notLoaded' : 'full',
        ...(o.cursor === undefined ? {} : { cursor: o.cursor }),
      })
      // ⚠️ A refusal is not remembered: right after a thread is created this method answers -32601 and works later
      return res.ok ? parseTurnsPage(res.result) : undefined
    },
    setOutcome: (threadId, outcome, mark) => {
      if (book.setOutcome(threadId, outcome, mark)) hooks.onChange?.()
    },
    mark: (threadId) => book.mark(threadId),
    send: (threadId, text) => startOnIdle(threadId, 'turn/start', { threadId, input: [{ type: 'text', text }] }),
    compact: (threadId) => startOnIdle(threadId, 'thread/compact/start', { threadId }),
    rateLimits: async () => {
      const rpc = liveRpc
      if (!rpc) return undefined
      const res = await rpc.call('account/rateLimits/read', {})
      return res.ok ? res.result : undefined
    },
    account: async () => {
      const rpc = liveRpc
      if (!rpc) return undefined
      // ⚠️ Never a token refresh from here (that is the TUI's business). ⚠️ A short deadline: it is extra, and the
      //    numbers must not wait behind it (codex review: the default 10 s equals the phone's own timeout)
      const res = await rpc.call('account/read', { refreshToken: false }, { timeoutMs: ACCOUNT_READ_TIMEOUT_MS })
      return res.ok ? res.result : undefined
    },
    interrupt: async (threadId) => {
      const rpc = liveRpc
      if (!rpc || !book.isRow(threadId)) return { ok: false, reason: 'not-listed' }
      if (stopping.has(threadId)) return { ok: false, reason: 'too-soon' }
      const now = book.stoppable(threadId)
      if (now !== 'working') return { ok: false, reason: now }
      // ⚠️ Reserved before the first await (two phones pressing at once)
      stopping.add(threadId)
      // ★ The status the press saw. ⚠️⚠️ The turn read can wait behind a slow line: if the pressed turn ends and the
      //    PC starts the next one meanwhile, the read names the **new** turn (round 11, high #1). Any status move
      //    renews the mark, so a different mark at the write means "not the turn that ran when pressed".
      const pressed = book.mark(threadId)
      const samePress = (): boolean => liveRpc === rpc && book.isRow(threadId) && book.mark(threadId) === pressed && book.stoppable(threadId) === 'working'
      try {
        // ★ Which turn runs: the newest one, if it is still in progress (the status carries no turn id)
        const page = await rpc.call('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' })
        if (!page.ok) return { ok: false, reason: 'failed', detail: failureDetail(page.failure) }
        const last = parseTurnsPage(page.result)?.turns[0]
        if (!last || last.status !== 'inProgress') return { ok: false, reason: 'idle' }
        // ⚠️ Judged again right before the bytes go out: still this connection's row, still the status the press saw
        //    (working, same mark), and not after the call has timed out (same guard as `send`).
        const res = await rpc.call('turn/interrupt', { threadId, turnId: last.id }, { guard: samePress })
        if (res.ok) return { ok: true }
        if (res.failure.type === 'cancelled') {
          return { ok: false, reason: book.isRow(threadId) ? movedReason(book.stoppable(threadId)) : 'not-listed', detail: 'cancelled' }
        }
        return { ok: false, reason: 'failed', detail: failureDetail(res.failure) }
      } finally {
        stopping.delete(threadId)
      }
    },
    rows: () => book.rows(rowsCtx),
    rolloutPaths: () => book.rolloutPaths(rowsCtx),
    health: () => {
      const d = book.diagnostics()
      return {
        home: home.label,
        state: state.type,
        ...('reason' in state ? { detail: state.reason } : 'code' in state ? { detail: state.code } : {}),
        rows: book.rows(rowsCtx).length,
        hidden: d.hidden,
        unparsed: d.unparsed,
        unansweredRequests: unanswered,
      }
    },
    stop: () => {
      abort.abort()
      current?.close()
    },
    done,
  }
}
