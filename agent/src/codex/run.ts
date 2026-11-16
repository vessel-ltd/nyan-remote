// ★★ Codex support, wired to the real world (2026-11-14 / docs/CODEX.md).
//
// The decisions live in `daemon.ts` / `threads.ts` (reachable from tests). This file only supplies the real socket,
// the real clock, and the config. ⚠️ Keep it that way: code here runs on the user's machine and nowhere else.
//
// ⚠️⚠️ **On unless `config.json` says `"codex": { "enabled": false }`** (2026-11-15 / user decision; what it does to
//    the user's Codex is said in the README, once in the log on the first connect, and in `nyan status` / `Config.codex`).

import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { CodexLineHealth, LogPage, NotifyFields, SessionSummary } from '../../../shared/types.ts'
import type { CodexConfig } from '../config.ts'
import { autoApproveFor } from '../autoApprove.ts'
import { askCodexQuestion, offerCodexCard, offerCodexFileChange } from './cards.ts'
import { codexSessionPrefix, startCodexDaemonLine, type CodexDaemonLine, type CodexSendResult, type CodexInterruptResult, type CodexHome, type DaemonDeps, type DaemonHooks, type SocketLook } from './daemon.ts'
import { CodexLogs, type CodexLogSource } from './log.ts'
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
  notify?: (row: SessionSummary, fields: NotifyFields) => Promise<number>
  /**
   * Called when the set of Codex approval cards changed.
   * ⚠️ Absent = approvals are off: no thread is joined, no request from the daemon is answered (view-only).
   */
  cardsChanged?: () => void
  /** ★ Injected in tests */
  deps?: DaemonDeps
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
          void notifier?.onStatus(change)
        },
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

export function codexRows(): SessionSummary[] {
  return lines.flatMap((l) => l.rows())
}

/**
 * The line and the bare thread id behind a row `sessionId`, if that row is listed right now.
 * ⚠️ The id names its home (`codexSessionPrefix`), so two homes listing the same thread id are never confused, and
 *    the line must also list the thread now (the form alone proves nothing).
 */
function locate(sessionId: string): { line: CodexDaemonLine; threadId: string } | undefined {
  for (const line of lines) {
    const threadId = line.threadOf(sessionId)
    if (threadId !== undefined && line.lists(threadId)) return { line, threadId }
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
export async function codexSend(sessionId: string, text: string): Promise<CodexSendResult | undefined> {
  const found = locate(sessionId)
  if (!found) return undefined
  return found.line.send(found.threadId, text)
}

/** Stop the running turn of a Codex row, or `undefined` if no line lists it right now (= not ours). */
export async function codexInterrupt(sessionId: string): Promise<CodexInterruptResult | undefined> {
  const found = locate(sessionId)
  if (!found) return undefined
  return found.line.interrupt(found.threadId)
}

/** The thread view of a Codex row, or `undefined` if no line lists it right now. */
export async function codexLog(
  sessionId: string,
  opts: { before?: number | null; since?: number | null; limit?: number },
): Promise<LogPage | undefined> {
  const found = locate(sessionId)
  if (!found) return undefined
  return logs.page(logSource(found.line), sessionId, found.line.label, opts)
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
