// ★★ Codex support, wired to the real world (2026-11-14 / docs/CODEX.md).
//
// The decisions live in `daemon.ts` / `threads.ts` (reachable from tests). This file only supplies the real socket,
// the real clock, and the config. ⚠️ Keep it that way: code here runs on the user's machine and nowhere else.
//
// ⚠️⚠️ **On unless `config.json` says `"codex": { "enabled": false }`** (2026-11-15 / user decision; what it does to
//    the user's Codex is said in the README, once in the log on the first connect, and in `nyan status` / `Config.codex`).

import { recordLimitStop } from '../usageHistory.ts'
import { codexMemberLimited } from '../teamHooks.ts'
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { CodexLineHealth, LogPage, NotifyFields, SessionSummary, ToolUsage } from '../../../shared/types.ts'
import { codexLoginBetween, codexUsageOf } from '../usage.ts'
import type { CodexConfig } from '../config.ts'
import { autoApproveFor } from '../autoApprove.ts'
import { askCodexQuestion, offerCodexCard, offerCodexFileChange } from './cards.ts'
import { codexSessionPrefix, startCodexDaemonLine, type CodexDaemonLine, type CodexSendResult, type CodexInterruptResult, type CodexHome, type DaemonDeps, type DaemonHooks, type SocketLook } from './daemon.ts'
import { CodexLogs, type CodexLogSource } from './log.ts'
import { itemEntries } from './history.ts'
import { ContextCache } from './context.ts'
import { CodexNotifier } from './notify.ts'
import { connectWsUds } from './wsUds.ts'
import { t } from '../../../shared/i18n.ts'
import { CODEX_START_MARK } from './marks.ts'

/** How often the follow watch looks at threads that are being viewed */
export const CODEX_FOLLOW_TICK_MS = 1500

/** What we call ourselves to the daemon. ⚠️ Not `codex-tui`, not an internal Codex name (docs/CODEX.md §4). */
export const DEFAULT_CLIENT_NAME = 'nyan-remote'

/** Where a Codex home's daemon listens (measured on 0.169.0; a symlink to the real socket) */
export function controlSocketOf(home: string): string {
  return join(home, 'app-server-control', 'app-server-control.sock')
}

/**
 * The homes to watch.
 * ⚠️ `id` is the resolved path (two homes can share a base name); `label` is only what the UI shows.
 * ⚠️ The same home listed twice is watched once (two lines to one daemon would double every row).
 */
export function codexHomes(
  cfg: CodexConfig | undefined,
  env: Record<string, string | undefined>,
  home: string,
  /** Told about a home that is not watched because its row ids would collide with an earlier home's */
  onRefused?: (label: string) => void,
): CodexHome[] {
  // ⚠️ Only an explicit `false` turns it off (absent = on)
  if (cfg?.enabled === false) return []
  const fromEnv = env['CODEX_HOME']
  const paths = cfg?.homes && cfg.homes.length > 0 ? cfg.homes : [fromEnv && fromEnv.startsWith('/') ? fromEnv : join(home, '.codex')]
  const seen = new Set<string>()
  const prefixes = new Set<string>()
  const out: CodexHome[] = []
  for (const p of paths) {
    const id = resolve(p)
    if (seen.has(id)) continue
    seen.add(id)
    // ⚠️⚠️ Two homes whose row ids would share a prefix are never both watched: their threads would share ids, and
    //    with them auto-approve and routing (second review, medium #2). Fail closed: the later one is not watched.
    const prefix = codexSessionPrefix(id)
    if (prefixes.has(prefix)) {
      onRefused?.(basename(id) || id)
      continue
    }
    prefixes.add(prefix)
    out.push({ id, label: basename(id) || id, socketPath: controlSocketOf(id) })
  }
  return out
}

/** Look at the socket without opening it. ⚠️ "Not there" and "not ours to look at" are different answers. */
export async function lookAtSocket(path: string, now: number = Date.now()): Promise<SocketLook> {
  try {
    // ★ `stat` follows the symlink: the age and identity are those of the **real** socket (it changes on a daemon restart)
    const st = await stat(path)
    if (!st.isSocket()) return { type: 'absent' }
    return { type: 'present', ageMs: Math.max(0, now - st.ctimeMs), key: `${st.dev}:${st.ino}` }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { type: 'absent' }
    return { type: 'denied', code: typeof code === 'string' ? code : 'unknown' }
  }
}

export async function realSocketPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // Same shape as a failed connect, so the loop treats "vanished between look and connect" like any other drop
    throw { reason: 'error', detail: typeof code === 'string' ? code : 'realpath' }
  }
}

const realDeps: DaemonDeps = {
  look: (path) => lookAtSocket(path),
  // ⚠️⚠️ Connect to the **real** socket, not to the symlink. A Unix socket address holds about 107 bytes, and
  //    `<home>/app-server-control/app-server-control.sock` exceeds that for a long home ⇒ `connect` fails with EINVAL
  //    (hit against the real binary on 2026-11-14). The daemon avoids the limit the same way: the entry in the home is
  //    a symlink to a short path under /tmp.
  connect: async (path, onMessage) => connectWsUds({ path: await realSocketPath(path), onMessage }),
  sleep: (ms, signal) =>
    new Promise<void>((done) => {
      if (signal.aborted) return done()
      const timer = setTimeout(finish, ms)
      function finish(): void {
        clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        done()
      }
      signal.addEventListener('abort', finish, { once: true })
    }),
  now: () => Date.now(),
  random: () => Math.random(),
  // ⚠️ Metadata only (the path is the daemon's; nothing is read from the file)
  fileSize: async (path) => {
    try {
      const st = await stat(path)
      return st.isFile() ? st.size : undefined
    } catch {
      return undefined
    }
  },
}

let lines: CodexDaemonLine[] = []
let enabled = false
let logs = new CodexLogs()

export interface StartCodexOptions {
  machine: string
  version: string
  hooks?: DaemonHooks
  env?: Record<string, string | undefined>
  home?: string
  /**
   * Send one notification (build the payload from the fields and push it). Returns how many devices got it.
   * ⚠️ Absent = no notifications for Codex threads (the list still works).
   */
  notify?: (row: SessionSummary, fields: NotifyFields, turn?: string, current?: () => boolean) => Promise<number>
  /**
   * Called when the set of Codex approval cards changed.
   * ⚠️ Absent = approvals are off: no thread is joined, no request from the daemon is answered (view-only).
   */
  cardsChanged?: () => void
  /** ★ Injected in tests */
  deps?: DaemonDeps
  /** ★ A row's status moved (row id, new status): teams clear a grant-time wait on its first real transition */
  onRowStatus?: (sessionId: string, to: string) => void
  /** ★ How many closed threads per home are listed as history (the config's `maxSessionsPerAccount`, as for Claude) */
  historyLimit?: number
}

/** Whether the one-time notice was logged since `startCodex` (= once per agent start: not again on a reconnect) */
let announced = false

/**
 * ★ Said once, on the first connect to a Codex daemon (2026-11-15 / user decision: on by default, so say it on the PC).
 * ⚠️ The name actually used (it can be changed in config.json).
 */
export function codexNotice(clientName: string): string {
  return t(
    `[codex] ★ Codex の daemon に「${clientName}」の名前で繋ぎました（この PC の Codex が送る User-Agent の末尾にこの名前が載ります）。` +
      `使わないなら ~/.nyan-remote/config.json に "codex": { "enabled": false } を書いて再起動してください`,
    `[codex] ★ Connected to the Codex daemon as "${clientName}" (this name now appears at the end of the User-Agent ` +
      `of this PC's Codex requests). To turn it off, put "codex": { "enabled": false } in ~/.nyan-remote/config.json and restart`,
  )
}

/** Start one line per home. Returns how many. ⚠️ Does nothing (and connects to nothing) when turned off. */
export function startCodex(cfg: CodexConfig | undefined, opts: StartCodexOptions): number {
  stopCodex()
  announced = false
  const homes = codexHomes(cfg, opts.env ?? process.env, opts.home ?? homedir(), (label) =>
    opts.hooks?.log?.(`[codex] ⚠️ not watching ${label}: its row ids would collide with another home's`),
  )
  // ★ The start of this run in the log: `nyan status` reads only the states logged after the last one (older lines
  //   are another run's). ⚠️ Fixed English, never translated (it is matched).
  opts.hooks?.log?.(`${CODEX_START_MARK}${homes.length} name=${cfg?.clientName ?? DEFAULT_CLIENT_NAME}`)
  enabled = homes.length > 0
  const deps = opts.deps ?? realDeps
  lines = homes.map((home) => {
    // ★ One notifier per line; it only ever sees that line's threads
    let notifier: CodexNotifier | undefined
    const line: CodexDaemonLine = startCodexDaemonLine({
      home,
      machine: opts.machine,
      ...(opts.historyLimit === undefined ? {} : { historyLimit: opts.historyLimit }),
      clientName: cfg?.clientName ?? DEFAULT_CLIENT_NAME,
      clientVersion: cfg?.clientVersion ?? opts.version,
      deps,
      hooks: {
        ...opts.hooks,
        onConnected: () => {
          opts.hooks?.onConnected?.()
          if (announced) return
          announced = true
          opts.hooks?.log?.(codexNotice(cfg?.clientName ?? DEFAULT_CLIENT_NAME))
        },
        // ⚠️ `change.thread.id` is the bare thread id (the notifier works per line); rows and auto-approve use the row id
        onStatus: (change) => {
          opts.hooks?.onStatus?.(change)
          opts.onRowStatus?.(line.sessionIdOf(change.thread.id), change.to)
          void notifier?.onStatus(change)
        },
        onSettle: (change) => void notifier?.onStatus(change, { quiet: true }),
        ...(opts.cardsChanged
          ? (() => {
              const cardDeps = { generation: () => line.generation(), changed: opts.cardsChanged, now: () => new Date(), ...(opts.hooks?.log ? { log: opts.hooks.log } : {}) }
              return {
                offerApproval: offerCodexCard(cardDeps),
                askQuestion: askCodexQuestion(cardDeps),
                offerFileChange: offerCodexFileChange(cardDeps),
              }
            })()
          : {}),
      },
    })
    const send = opts.notify
    if (send) {
      const never = new AbortController().signal
      notifier = new CodexNotifier({
        row: (id) => line.rows().find((r) => r.sessionId === line.sessionIdOf(id)),
        turns: (id, o) => line.turns(id, o),
        setOutcome: (id, outcome, mark) => line.setOutcome(id, outcome, mark),
        mark: (id) => line.mark(id),
        send,
        sleep: (ms) => deps.sleep(ms, never),
        autoApproving: (id) => autoApproveFor(line.sessionIdOf(id), deps.now()) !== undefined,
        // ★ Usage history (`usageHistory.ts`): the home's label is the login's, as in `GET /usage`
        // ⚠️ Not when two homes show the same label: they cannot be told apart (the history keeps neither's samples)
        onLimit: (id, turn) => {
          if (!codexLabelShared(home.label)) recordLimitStop('codex', home.label, `${id}:${turn}`)
          // ★ Teams: a member stopped at its limit is told to its leader (`teamHooks.ts`)
          codexMemberLimited(line.sessionIdOf(id), `${id}:${turn}`)
        },
        ...(opts.hooks?.log ? { log: opts.hooks.log } : {}),
      })
    }
    return line
  })
  return lines.length
}

export function stopCodex(): void {
  for (const l of lines) l.stop()
  lines = []
  enabled = false
  logs = new CodexLogs()
}

export function codexEnabled(): boolean {
  return enabled
}

const contexts = new ContextCache()

/**
 * The Codex rows: live ones, then closed threads as history (`live: false` / `closedThreads.ts`).
 * ★ A live row gets `contextTokens` from its rollout's tail when it can be read (`context.ts`; otherwise no chip).
 */
/** ★ Whether a Codex row is listed with a status we could read, right now (teams' grant / r7 high #2) */
export function codexStatusKnown(sessionId: string): boolean {
  const found = locate(sessionId)
  return found !== undefined && found.line.statusKnown(found.threadId)
}

/** ★ The live Codex rows as the lines hold them **now** (synchronous: teams snapshot who is waiting at a grant / r5 high #2) */
export function codexRowsNow(): SessionSummary[] {
  return lines.flatMap((l) => l.rows())
}

export async function codexRows(): Promise<SessionSummary[]> {
  const live = lines.flatMap((l) => l.rows())
  const paths = new Map(lines.flatMap((l) => [...l.rolloutPaths()]))
  const tokens = await contexts.lookup([...paths.values()])
  const withContext = live.map((r) => {
    const path = paths.get(r.sessionId)
    const n = path === undefined ? undefined : tokens.get(path)
    // ★ The model and effort of its newest turn (2026-11-17)
    const set = path === undefined ? undefined : contexts.settingsOf(path)
    return {
      ...r,
      ...(n === undefined ? {} : { contextTokens: n }),
      ...(set?.model ? { model: set.model } : {}),
      ...(set?.effort ? { effort: set.effort } : {}),
    }
  })
  return [...withContext, ...lines.flatMap((l) => l.historyRows())]
}

/**
 * ★ How old a Codex limits reading may be before `/usage` asks again. ⚠️ Each read goes from the daemon to OpenAI
 *   (measured ~0.5 s), so not on every list poll.
 */
export const CODEX_USAGE_TTL_MS = 60_000
/** How long `GET /usage` waits for a Codex read before answering with the last one (well under the phone's 10 s) */
export const CODEX_USAGE_WAIT_MS = 4_000

/** Per line: the last good reading, and the read in flight (one at a time) */
const usageOf = new WeakMap<CodexDaemonLine, { readAt: number; value: ToolUsage | undefined; inflight?: Promise<void> }>()

/** ★ Each Codex home's plan limits (`GET /usage`). A home that cannot be read now keeps its last good reading. */
export async function codexUsage(nowMs: number = Date.now()): Promise<ToolUsage[]> {
  await Promise.all(
    lines.map(async (line) => {
      let slot = usageOf.get(line)
      if (!slot) {
        slot = { readAt: 0, value: undefined }
        usageOf.set(line, slot)
      }
      if (nowMs - slot.readAt < CODEX_USAGE_TTL_MS) return
      const s = slot
      s.inflight ??= (async () => {
        try {
          // ★ Who is logged in, beside the numbers (as `/status` shows it). ⚠️⚠️ The limits answer names no login
          //    (`accountId` is not `account/read`'s `userId`) ⇒ the login is read **before and after** the limits and
          //    kept only when both reads agree (codex review: a login switch in between paired A's numbers with B).
          //    ⚠️ Not readable or not the same ⇒ the numbers alone.
          //    ⚠️ Residual (accepted): a switch A → B → A inside the ~0.5 s of the limits read still pairs B's numbers
          //       with A (the protocol has no login id on the limits answer).
          //    ★ Both go out at once (the "before" is sent first on the one line; the limits do not wait for it)
          const beforeP = line.account().catch(() => undefined)
          const limits = await line.rateLimits()
          const before = await beforeP
          const after = before === undefined ? undefined : await line.account().catch(() => undefined)
          const got = codexUsageOf(limits, Date.now())
          s.readAt = Date.now()
          if (got) s.value = { tool: 'codex', account: line.label, ...got, ...codexLoginBetween(before, after), at: new Date(s.readAt).toISOString() }
        } catch {
          // ⚠️ Never throws into the route: the last reading stays
        } finally {
          s.inflight = undefined
        }
      })()
      // ★ The phone's request waits at most `CODEX_USAGE_WAIT_MS` (codex review: a slow read pushed the whole answer,
      //   Claude's numbers included, past the phone's own 10 s timeout). The read goes on and is there next time.
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([s.inflight, new Promise<void>((r) => (timer = setTimeout(r, CODEX_USAGE_WAIT_MS)))])
      clearTimeout(timer)
    }),
  )
  const out: ToolUsage[] = []
  for (const line of lines) {
    const v = usageOf.get(line)?.value
    if (!v) continue
    // ⚠️ Windows whose reset passed since the reading are no longer true
    out.push({ ...v, windows: v.windows.filter((w) => Date.parse(w.resetsAt) > nowMs) })
  }
  return out
}

/** ★ Whether more than one watched home shows this label (`work/.codex` and `personal/.codex`): a row's label alone
 *  then cannot tell which login it is (the team commands show no limits for it / codex review r2) */
export function codexLabelShared(label: string): boolean {
  return lines.filter((l) => l.label === label).length > 1
}

/** ★ How old the history may be when the phone opens it (it is also read again whenever a thread closes) */
export const HISTORY_REFRESH_MS = 60_000

/** The phone asked for its history: read the closed threads again if the last read is older than a minute */
export function codexHistoryWanted(): void {
  for (const line of lines) line.refreshHistory(HISTORY_REFRESH_MS)
}

/**
 * The line and the bare thread id behind a row `sessionId`, if that row is listed right now.
 * ⚠️ The id names its home (`codexSessionPrefix`), so two homes listing the same thread id are never confused, and
 *    the line must also list the thread now (the form alone proves nothing).
 */
function locate(sessionId: string, history = false): { line: CodexDaemonLine; threadId: string } | undefined {
  for (const line of lines) {
    const threadId = line.threadOf(sessionId)
    // ⚠️ A history row only where it is asked for (reading the conversation); sending and stopping need a live row
    if (threadId !== undefined && (history ? line.knows(threadId) : line.lists(threadId))) return { line, threadId }
  }
  return undefined
}

/** The journal's view of a line: keyed by the row `sessionId`, read by the bare thread id */
function logSource(line: CodexDaemonLine): CodexLogSource {
  return {
    generation: () => line.generation(),
    turns: async (sessionId, o) => {
      const threadId = line.threadOf(sessionId)
      return threadId === undefined ? undefined : line.turns(threadId, o)
    },
  }
}

/** Whether some line lists this row (`sessionId` of a Codex row) right now */
export function codexLists(sessionId: string): boolean {
  return locate(sessionId) !== undefined
}

/** Send to a Codex row, or `undefined` if no line lists it right now (= not ours; the caller goes on). */
export async function codexSend(sessionId: string, text: string, images: readonly string[] = [], guard?: () => boolean): Promise<CodexSendResult | undefined> {
  const found = locate(sessionId)
  if (!found) return undefined
  return found.line.send(found.threadId, text, images, guard)
}

/** Compact an idle Codex row, or `undefined` if no line lists it right now (= not ours). */
export async function codexCompact(sessionId: string): Promise<CodexSendResult | undefined> {
  const found = locate(sessionId)
  if (!found) return undefined
  return found.line.compact(found.threadId)
}

/** Stop the running turn of a Codex row, or `undefined` if no line lists it right now (= not ours). */
export async function codexInterrupt(sessionId: string): Promise<CodexInterruptResult | undefined> {
  const found = locate(sessionId)
  if (!found) return undefined
  return found.line.interrupt(found.threadId)
}

/** The thread view of a Codex row or history row, or `undefined` if no line knows it right now. */
export async function codexLog(
  sessionId: string,
  opts: { before?: number | null; since?: number | null; limit?: number; until?: number },
): Promise<LogPage | undefined> {
  const found = locate(sessionId, true)
  if (!found) return undefined
  return logs.page(logSource(found.line), sessionId, found.line.label, opts)
}

/**
 * ★ The last words of **one** ended turn of a Codex row (teams' reports / `teamHooks.ts`), read fresh from the daemon.
 *   ⚠️ Only that turn is read in full, on a connection of its own (r18 medium #3, r20 medium #2: an unrelated huge turn
 *      next to it cannot make it unreadable): its position is found from the headers, then one full turn at that cursor.
 *   ⚠️ Strict (r20 medium #3): the turn must have ended and every item must have been read; otherwise undefined (a
 *      failure, retried later). `{ text: undefined }` = it ended and said nothing.
 */
export async function codexLastWords(sessionId: string, turnId: string): Promise<{ text: string | undefined } | undefined> {
  const found = locate(sessionId)
  if (!found) return undefined
  const heads = await found.line.turns(found.threadId, { limit: 50, headersOnly: true })
  const idx = heads?.turns.findIndex((x) => x.id === turnId) ?? -1
  if (!heads || idx < 0) return undefined
  let cursor: string | undefined
  if (idx > 0) {
    const before = await found.line.turns(found.threadId, { limit: idx, headersOnly: true })
    if (!before?.nextCursor) return undefined
    cursor = before.nextCursor
  }
  const page = await found.line.turnsAside(found.threadId, { limit: 1, ...(cursor === undefined ? {} : { cursor }) })
  const turn = page?.turns[0]
  if (!page || !turn || turn.id !== turnId || page.skipped > 0) return undefined
  if (turn.status !== 'completed' && turn.status !== 'failed' && turn.status !== 'interrupted') return undefined
  // ⚠️ A message item whose text is not a string would be dropped, and an earlier progress line would pass for the
  //    answer (r21 medium #2): a retryable failure instead
  if (turn.items.some((it) => it.type === 'agentMessage' && typeof it.raw.text !== 'string')) return undefined
  const entries = turn.items.flatMap((item) => itemEntries(item))
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (e.kind === 'assistant' && e.text.trim()) return { text: e.text }
  }
  return { text: undefined }
}

/**
 * ★ One round of the follow watch: of the threads someone is viewing right now, which ones grew?
 *
 * Why the agent polls: the daemon tells a connection that has not joined a thread only about **status** changes
 * (measured), but one Codex turn records dozens of items while the status stays "active". Asking the local daemon
 * every second or two costs nothing; the phone is told only when something new can be shown (`log-appended`), so
 * nothing crosses the relay while nothing changes.
 * ⚠️ Only threads that are being followed **and** are rows are read. A thread that is not active is read too
 *    (its last items settle a moment after it goes idle), which the per-thread throttle in `CodexLogs` keeps cheap.
 */
export async function codexFollowTick(followed: ReadonlySet<string>): Promise<string[]> {
  if (!enabled || followed.size === 0) return []
  const grown: string[] = []
  for (const line of lines) {
    const source = logSource(line)
    for (const row of line.rows()) {
      if (!followed.has(row.sessionId)) continue
      if (await logs.grew(source, row.sessionId)) grown.push(row.sessionId)
    }
  }
  return grown
}

/** `undefined` when Codex support is off (so `/health` does not grow a field for people who never turned it on) */
export function codexHealth(): CodexLineHealth[] | undefined {
  return enabled ? lines.map((l) => l.health()) : undefined
}
