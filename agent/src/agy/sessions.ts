// ★ Antigravity CLI (agy) sessions as list rows (2026-11-19 / docs/AGY.md §5).
//
// Source: `~/.nyan-remote/agy/session-<conversation id>.json`, written by `hooks/agy-statusline.sh` each time agy's
// agent state changes: `{ nyanPid, nyanBusyAt, input }` where `input` is what agy handed its status line command.
//
// ⚠️ A row is live only while its `nyanPid` is a running agy, and only the conversation that pid wrote last: one agy
//    process can move between conversations (`/new`, a resume), and the older file keeps the same pid.
// ⚠️ The status line's `transcript_path` is wrong in agy 1.5.12 (it names `~/.gemini/antigravity/…/transcript.jsonl`);
//    the real one is built from the id (`transcriptPathOf`).
// ⚠️ The e-mail address agy includes is removed by the relay before writing; nothing here reads or returns it.
// ⚠️ Row ids are `agy-<conversation id>` so they never meet a Claude session id or a Codex thread id.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { open, readdir, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { SessionStatus, SessionSummary, TitleSource, ToolUsage, UsageWindow } from '../../../shared/types.ts'
import type { PaneRecord } from '../claude/keys.ts'
import { aliveProcStartSync, sameProcStart } from '../claude/sessionIndex.ts'
import { readJsonFile, stateDir } from '../state.ts'
import { t } from '../../../shared/i18n.ts'
import { HttpError, type Ctx } from '../router.ts'

export const AGY_PREFIX = 'agy-'
/** The label shown where Claude shows its profile (`.claude-r`) */
export const AGY_ACCOUNT = 'agy'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_FILE_BYTES = 256 * 1024
/** Files of conversations whose agy is gone are removed after this long (nothing reads them) */
export const AGY_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000

export function agyDir(): string {
  return join(stateDir(), 'agy')
}

export function agyHome(home: string = homedir()): string {
  return join(home, '.gemini', 'antigravity-cli')
}

/** ★ The real transcript of a conversation (the status line's own path is wrong / measured 2026-11-19) */
export function transcriptPathOf(conversationId: string, home: string = homedir()): string {
  return join(agyHome(home), 'brain', conversationId, '.system_generated', 'logs', 'transcript_full.jsonl')
}

/** The conversation id inside a row id, or undefined if it is not an agy row id */
export function conversationOf(sessionId: string): string | undefined {
  if (!sessionId.startsWith(AGY_PREFIX)) return undefined
  const id = sessionId.slice(AGY_PREFIX.length)
  return UUID.test(id) ? id.toLowerCase() : undefined
}

/**
 * ★ The session actions agy rows do not have yet (send, stop, clear, commands, auto-approve) refuse their ids up
 * front. ⚠️ An older PWA reads an unknown tool as Claude and shows those buttons: auto-approve would otherwise be
 * saved and reported as on for a conversation it never reaches (codex review), and the others would try Claude's ways.
 */
export function notForAgy<R>(handler: (ctx: Ctx) => R): ((ctx: Ctx) => R) & { inner: (ctx: Ctx) => R } {
  const guarded = (ctx: Ctx): R => {
    const id = ctx.params['id']
    if (id && id.startsWith(AGY_PREFIX)) {
      throw new HttpError(400, t('agy のセッションには、まだスマホからこの操作はできません（PC で操作してください）', 'This is not available for agy sessions from the phone yet (use the PC).'))
    }
    return handler(ctx)
  }
  // ★ What it guards, so the route table's wiring test still sees which handler sits behind it
  return Object.assign(guarded, { inner: handler })
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** What the agent uses from one status line file. ⚠️ Only these fields are ever read */
export interface AgyState {
  conversationId: string
  pid: number
  /** When it was last seen working (epoch seconds; 0 = never) */
  busyAt: number
  cwd: string
  title?: string
  agentState?: string
  confirmationPending: boolean
  model?: string
  effort?: string
  contextPercent?: number
  contextTokens?: number
  mode?: string
  version?: string
  plan?: string
  quota: { bucket: string; remainingFraction: number; resetsAt: string }[]
}

/** ★ One file → its state, or undefined when it is not one of ours (wrong shape, id not matching the name) */
export function parseAgyFile(raw: unknown, fileId: string): AgyState | undefined {
  if (!isObj(raw) || !isObj(raw.input)) return undefined
  const pid = num(raw.nyanPid)
  const busyAt = num(raw.nyanBusyAt) ?? 0
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1) return undefined
  const i = raw.input
  const cid = str(i.conversation_id)
  if (!cid || !UUID.test(cid) || cid.toLowerCase() !== fileId.toLowerCase()) return undefined
  const cwd = str(i.cwd) ?? (isObj(i.workspace) ? str(i.workspace.current_dir) : undefined)
  if (!cwd) return undefined
  const model = isObj(i.model) ? i.model : undefined
  const ctx = isObj(i.context_window) ? i.context_window : undefined
  const used = ctx ? num(ctx.used_percentage) : undefined
  const inTok = ctx ? num(ctx.total_input_tokens) : undefined
  const quota: AgyState['quota'] = []
  if (isObj(i.quota)) {
    for (const [bucket, q] of Object.entries(i.quota)) {
      if (!isObj(q) || q.disabled === true) continue
      const frac = num(q.remaining_fraction)
      const reset = str(q.reset_time)
      if (frac === undefined || !reset || Number.isNaN(Date.parse(reset))) continue
      quota.push({ bucket, remainingFraction: frac, resetsAt: new Date(Date.parse(reset)).toISOString() })
    }
  }
  return {
    conversationId: cid.toLowerCase(),
    pid,
    busyAt,
    cwd,
    ...(str(i.conversation_title) ? { title: firstLine(str(i.conversation_title)!) } : {}),
    ...(str(i.agent_state) ? { agentState: str(i.agent_state) } : {}),
    confirmationPending: i.tool_confirmation_pending === true,
    ...(model && str(model.display_name) ? { model: str(model.display_name) } : {}),
    ...(model && str(model.effort) ? { effort: str(model.effort) } : {}),
    ...(used !== undefined && used >= 0 ? { contextPercent: Math.round(used) } : {}),
    ...(inTok !== undefined && inTok >= 0 ? { contextTokens: inTok } : {}),
    ...(str(i.cycle_mode) ? { mode: str(i.cycle_mode) } : {}),
    ...(str(i.version) ? { version: str(i.version) } : {}),
    ...(str(i.plan_tier) ? { plan: str(i.plan_tier) } : {}),
    quota,
  }
}

/**
 * ★ The list state, in the words a Claude row uses.
 * - a card is up ⇒ `waiting` (only while agy says so; the flag comes with `tool_use`)
 * - `working` / `tool_use` / `reviewing` ⇒ `working`
 * - `error` ⇒ `error`
 * - `idle` after a turn this conversation was seen working in ⇒ `done`; before any ⇒ `idle`
 * - `initializing` / `authenticating` / unknown ⇒ `idle`
 * ⚠️ A turn stopped with ESC or a declined card also ends `idle` after working, so it reads `done` (agy sends no
 *    signal that tells them apart: no Stop hook for either / measured 2026-11-19).
 */
export function agyStatus(s: Pick<AgyState, 'agentState' | 'confirmationPending' | 'busyAt'>): SessionStatus {
  if (s.confirmationPending) return 'waiting'
  switch (s.agentState) {
    case 'working':
    case 'tool_use':
    case 'reviewing':
      return 'working'
    case 'error':
      return 'error'
    case 'idle':
      return s.busyAt > 0 ? 'done' : 'idle'
    default:
      return 'idle'
  }
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? ''
  const t = line.trim()
  return t.length > 200 ? `${t.slice(0, 199)}…` : t
}

/** ★ The first request of a conversation, from the head of its transcript (agy wraps it in `<USER_REQUEST>`) */
export function promptTitle(head: string): string | undefined {
  for (const line of head.split('\n')) {
    if (!line.trim()) continue
    let rec: unknown
    try {
      rec = JSON.parse(line)
    } catch {
      return undefined // the head was cut mid-record: no title rather than a wrong one
    }
    if (!isObj(rec) || rec.type !== 'USER_INPUT' || typeof rec.content !== 'string') continue
    const t = firstLine(userRequestText(rec.content))
    if (t) return t
  }
  return undefined
}

/** The text the person typed, without agy's wrappers (`<USER_REQUEST>`, `<ADDITIONAL_METADATA>` …) */
export function userRequestText(content: string): string {
  const m = /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/.exec(content)
  return (m ? m[1]! : content).trim()
}

export interface AgyRowContext {
  machine: string
  /** Size of the transcript (0 = none yet) */
  transcriptBytes: number
  /** The first request, when the status line has no title */
  promptTitle?: string
  /** The file's time (when agy last changed state) */
  lastActivity: string
  /** ★ The agy went through the relay (its pane announcement checks out): the phone may type into it / stop it */
  sendRoute?: 'keys'
}

export function agyRow(s: AgyState, ctx: AgyRowContext): SessionSummary {
  const project = basename(s.cwd) || s.cwd
  const title: { title: string; titleSource: TitleSource } = s.title
    ? { title: s.title, titleSource: 'ai' }
    : ctx.promptTitle
      ? { title: ctx.promptTitle, titleSource: 'prompt' }
      : { title: project, titleSource: 'fallback' }
  const status = agyStatus(s)
  return {
    machine: ctx.machine,
    account: AGY_ACCOUNT,
    tool: 'agy',
    sessionId: AGY_PREFIX + s.conversationId,
    cwd: s.cwd,
    project,
    ...title,
    status,
    ...(status === 'waiting' ? { waitingFor: 'permission prompt' } : {}),
    live: true,
    ...(ctx.sendRoute ? { sendRoute: ctx.sendRoute } : {}),
    ...(s.mode ? { permissionMode: s.mode } : {}),
    ...(s.version ? { cliVersion: s.version } : {}),
    lastActivity: ctx.lastActivity,
    transcriptBytes: ctx.transcriptBytes,
    ...(s.model ? { model: s.model } : {}),
    ...(s.effort ? { effort: s.effort } : {}),
    ...(s.contextPercent !== undefined ? { contextPercent: s.contextPercent } : {}),
    ...(s.contextTokens !== undefined ? { contextTokens: s.contextTokens } : {}),
  }
}

/** Why a row has no way in (the pane announcement of its agy) */
export type AgyPaneFailure = 'no-relay' | 'broken' | 'unverified'

export interface AgyPane {
  socketPath: string
  /** The relay saw agy turn bracketed paste on */
  paste: boolean
  /**
   * ★ When the relay registered this agy (epoch ms). A status file written before it belongs to an earlier process that
   * had the same pid (codex review: a reused pid would tie an old conversation's idle file to a new agy)
   */
  startedAt: number
}

/**
 * ★ The relay's announcement for this agy pid, checked against the process (pid and start time).
 * ⚠️ Same checks as Claude's `scanPanes`: missing = not started through the relay; a pid or start time that does not
 *    match = never typed into (a reused pid is the worst place to type).
 */
export async function agyPaneOf(pid: number, aliveProcStart: (pid: number) => string | null | undefined): Promise<AgyPane | AgyPaneFailure> {
  const rec = await readJsonFile<PaneRecord>(join('panes', `${pid}.json`))
  if (rec.kind === 'missing') return 'no-relay'
  if (rec.kind === 'broken') return 'broken'
  const socketPath = typeof rec.value.socket === 'string' ? rec.value.socket : ''
  if (!socketPath || rec.value.pid !== pid) return 'broken'
  const actual = aliveProcStart(pid)
  const recStart = typeof rec.value.procStart === 'string' ? rec.value.procStart : undefined
  if (typeof actual !== 'string' || recStart === undefined || !sameProcStart(recStart, actual)) return 'unverified'
  const startedAt = rec.value.startedAt
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return 'broken'
  return { socketPath, paste: rec.value.paste === true, startedAt }
}

/** Is this pid a running agy? undefined = cannot tell (then not shown as live) */
export function isAgyProcess(pid: number): boolean {
  if (aliveProcStartSync(pid) === null) return false
  try {
    return readFileSync(`/proc/${pid}/comm`, 'utf8').trim() === 'agy'
  } catch {
    // ⚠️ No /proc (mac): the name from `ps`
    try {
      const out = execPsComm(pid)
      return basename(out.trim()) === 'agy'
    } catch {
      return false
    }
  }
}

function execPsComm(pid: number): string {
  return execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
}

export interface AgyFile {
  state: AgyState
  mtimeMs: number
}

export interface AgyDeps {
  dir: string
  home: string
  isAgy: (pid: number) => boolean
  now: number
  /** ★ For the pane check (the list: cached; typing: uncached / `agy/keys.ts`). Absent ⇒ the cached one */
  aliveProcStart?: (pid: number) => string | null | undefined
}

async function readSmallJson(path: string): Promise<unknown> {
  const fh = await open(path, 'r')
  try {
    const st = await fh.stat()
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return undefined
    const buf = Buffer.alloc(st.size)
    await fh.read(buf, 0, st.size, 0)
    return JSON.parse(buf.toString('utf8'))
  } finally {
    await fh.close()
  }
}

/** Every readable file, newest first. ⚠️ Never throws (a missing directory = no agy sessions) */
export async function readAgyFiles(dir: string): Promise<AgyFile[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const out: AgyFile[] = []
  for (const name of names) {
    const m = /^session-([0-9a-fA-F-]{36})\.json$/.exec(name)
    if (!m) continue
    const path = join(dir, name)
    try {
      const st = await stat(path)
      const state = parseAgyFile(await readSmallJson(path), m[1]!)
      if (state) out.push({ state, mtimeMs: st.mtimeMs })
    } catch {
      // one bad file never hides the others
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * ★ The live conversations: the newest file of each running agy pid. Files of gone agys older than a day are removed
 * (only our own `session-<uuid>.json` names, only when their pid is not a running agy).
 */
export async function liveAgy(deps: AgyDeps): Promise<AgyFile[]> {
  const files = await readAgyFiles(deps.dir)
  const seen = new Set<number>()
  const live: AgyFile[] = []
  for (const f of files) {
    if (seen.has(f.state.pid)) continue
    if (!deps.isAgy(f.state.pid)) {
      if (deps.now - f.mtimeMs > AGY_FILE_MAX_AGE_MS) void unlink(join(deps.dir, `session-${f.state.conversationId}.json`)).catch(() => undefined)
      continue
    }
    seen.add(f.state.pid)
    live.push(f)
  }
  return live
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

async function headOf(path: string, bytes = 64 * 1024): Promise<string | undefined> {
  try {
    const fh = await open(path, 'r')
    try {
      const buf = Buffer.alloc(bytes)
      const { bytesRead } = await fh.read(buf, 0, bytes, 0)
      return buf.subarray(0, bytesRead).toString('utf8')
    } finally {
      await fh.close()
    }
  } catch {
    return undefined
  }
}

/** Titles from transcript heads, kept while the conversation lives (the first request never changes) */
const titles = new Map<string, string>()

export function defaultAgyDeps(): AgyDeps {
  return { dir: agyDir(), home: homedir(), isAgy: isAgyProcess, now: Date.now() }
}

/** ★ The live agy rows for `/sessions` */
export async function agyRows(machine: string, deps: AgyDeps = defaultAgyDeps()): Promise<SessionSummary[]> {
  const live = await liveAgy(deps)
  const rows: SessionSummary[] = []
  for (const f of live) {
    const path = transcriptPathOf(f.state.conversationId, deps.home)
    const bytes = await sizeOf(path)
    // ★ Not listed before its first message, like Claude (whose list is built from transcripts): a send there is
    //   refused anyway (the gate needs the transcript) / user decision 2026-11-20. ⚠️ A turn that runs or waits on a
    //   card stays listed even then (never hide something that needs an answer)
    const status = agyStatus(f.state)
    if (bytes === 0 && status !== 'working' && status !== 'waiting') continue
    let title = titles.get(f.state.conversationId)
    if (title === undefined && !f.state.title && bytes > 0) {
      const head = await headOf(path)
      title = head ? promptTitle(head) : undefined
      if (title) titles.set(f.state.conversationId, title)
    }
    const pane = await agyPaneOf(f.state.pid, deps.aliveProcStart ?? aliveProcStartSync)
    // ⚠️ Written before this agy's relay registered ⇒ an earlier process with the same pid wrote it (not this agy's)
    if (typeof pane !== 'string' && f.mtimeMs < pane.startedAt) continue
    rows.push(
      agyRow(f.state, {
        machine,
        transcriptBytes: bytes,
        lastActivity: new Date(f.mtimeMs).toISOString(),
        ...(title ? { promptTitle: title } : {}),
        ...(typeof pane === 'string' ? {} : { sendRoute: 'keys' as const }),
      }),
    )
  }
  // forget titles of conversations no longer live (bounded)
  const keep = new Set(live.map((f) => f.state.conversationId))
  for (const id of titles.keys()) if (!keep.has(id)) titles.delete(id)
  return rows
}

/**
 * ★ The window length a quota bucket names (`gemini-5h`, `gemini-weekly`, `3p-weekly` …). undefined = not a window we
 * can name (it is not shown rather than guessed).
 */
export function bucketMinutes(bucket: string): number | undefined {
  if (/(^|-)weekly$/.test(bucket)) return 7 * 24 * 60
  const m = /(^|-)(\d+)h$/.exec(bucket)
  if (m) return Number(m[2]) * 60
  return undefined
}

/**
 * ★ agy's plan limits as one `ToolUsage` (the newest reading): the Gemini buckets (`gemini-5h`, `gemini-weekly`).
 * ⚠️ The other buckets (`3p-*` = other makers' models, `gemini-argon-…`) have the same lengths, and a window carries
 *    no name of its own (the phone and `nyan team` name it by its length), so showing them would print two "5 h"
 *    lines that cannot be told apart (codex review). They wait for a labelled window (docs/AGY.md §6).
 */
export function agyUsage(files: readonly AgyFile[], nowMs: number): ToolUsage | undefined {
  const f = files.find((x) => x.state.quota.length > 0)
  if (!f) return undefined
  const byLen = new Map<number, UsageWindow>()
  for (const q of f.state.quota) {
    const minutes = bucketMinutes(q.bucket)
    if (minutes === undefined || Date.parse(q.resetsAt) <= nowMs) continue
    if (!/^gemini-(\d+h|weekly)$/.test(q.bucket) || byLen.has(minutes)) continue
    byLen.set(minutes, { minutes, usedPercent: Math.max(0, Math.min(100, (1 - q.remainingFraction) * 100)), resetsAt: q.resetsAt })
  }
  if (byLen.size === 0) return undefined
  return {
    tool: 'agy',
    account: AGY_ACCOUNT,
    ...(f.state.plan ? { plan: f.state.plan } : {}),
    windows: [...byLen.values()],
    at: new Date(f.mtimeMs).toISOString(),
  }
}
