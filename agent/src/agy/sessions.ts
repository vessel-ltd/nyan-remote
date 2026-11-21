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

import { execFile, execFileSync } from 'node:child_process'
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { open, readdir, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { SessionStatus, SessionSummary, TitleSource, ToolUsage, UsageWindow } from '../../../shared/types.ts'
import type { PaneRecord } from '../claude/keys.ts'
import { aliveProcStartSync, sameProcStart } from '../claude/sessionIndex.ts'
import { readJsonFile, stateDir } from '../state.ts'
import { t } from '../../../shared/i18n.ts'
import { HttpError, type Ctx } from '../router.ts'
import { callBeforeState, readTailRecords, turnEnd, type PendingCall } from './pending.ts'

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
  /**
   * ★ A child agent (subagent) has not finished (docs/AGY.md §11): its questions go straight to the person, and a
   *   question opened on the PC (ctrl+k) takes typed text and ESC. The phone neither types nor stops meanwhile.
   */
  subagentsActive: boolean
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
    subagentsActive: subagentsActive(i.subagents),
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
 * The child states that are over (measured: `running` while it works, `completed` after; agy also names `idle`,
 * `killed`, `waiting`). ⚠️ Any other state, or an entry that cannot be read, counts as not finished (fail-closed).
 */
const SUBAGENT_DONE = new Set(['completed', 'killed', 'failed', 'cancelled', 'canceled', 'error', 'done', 'idle'])

export function subagentsActive(v: unknown): boolean {
  if (v === undefined || v === null) return false
  if (!Array.isArray(v)) return true
  return v.some((x) => !isObj(x) || typeof x.status !== 'string' || !SUBAGENT_DONE.has(x.status.toLowerCase()))
}

/** ★ The tool agy asks the person a question with (docs/AGY.md §11) */
export const AGY_QUESTION_TOOL = 'ask_question'

/** The last answer per transcript, kept while the file does not change (a question writes nothing while it is up) */
const askCache = new Map<string, { size: number; mtimeMs: number; pending: PendingCall | undefined }>()
const ASK_CACHE_MAX = 64

/**
 * ★★ Whether agy is asking the person a question now (`ask_question` / docs/AGY.md §11). agy's status line says only
 * `tool_use` (no `tool_confirmation_pending`), so the transcript tells. Measured on agy 1.5.13 (2026-11-21):
 *   - the question's PLANNER_RESPONSE is written, then the status file once (`tool_use`, ~50–250 ms later), and
 *     neither is written again while the question is up (20 s);
 *   - answering writes its GENERIC result (`A1: …`), so the call is no longer the pending one; ESC skips it
 *     ("User Skipped") and the turn goes on.
 * ⇒ asking = `tool_use`, no card, the transcript's pending call is `ask_question`, written before this state (rule 9 of
 *   the cards) and the transcript not written since this state (an older `tool_use` state of the call before).
 * ⚠️ Anything unclear ⇒ false (the row reads `working`, as before).
 */
export function agyAsking(
  s: Pick<AgyState, 'agentState' | 'confirmationPending'>,
  stateMtimeMs: number,
  transcript: string,
  tail: (path: string) => Record<string, unknown>[] = readTailRecords,
): boolean {
  return agyQuestionAt(s, stateMtimeMs, transcript, tail) !== undefined
}

/**
 * ★ `agyAsking`, giving the question's own time: the transcript's write that posed it (epoch ms). The notifier tells
 * questions apart by it, not by the status file's write: a background subagent's progress rewrites the status file
 * while the parent's question stays up, which rang the same question again (codex review). Nothing else writes the
 * transcript while the question is up.
 */
export function agyQuestionAt(
  s: Pick<AgyState, 'agentState' | 'confirmationPending'>,
  stateMtimeMs: number,
  transcript: string,
  tail: (path: string) => Record<string, unknown>[] = readTailRecords,
): number | undefined {
  if (s.confirmationPending || s.agentState !== 'tool_use') return undefined
  const q = questionCall(transcript, tail)
  return q !== undefined && q !== null && q.mtimeMs <= stateMtimeMs && callBeforeState(q.call, stateMtimeMs) ? q.mtimeMs : undefined
}

/**
 * ★ The transcript's pending call when it is a question, with the transcript's time; no ordering check against the
 * status line. ⚠️ For refusing ESC (`keys.ts` `stopGate`): the status file is written up to ~250 ms after the
 * question, and an ESC in that gap would skip it (codex review). Showing "needs you" still needs `agyAsking`.
 * undefined = cannot tell (the transcript could not be read: the caller refuses the ESC / codex review).
 */
export function agyQuestionInTranscript(transcript: string, tail: (path: string) => Record<string, unknown>[] = readTailRecords): boolean | undefined {
  const q = questionCall(transcript, tail)
  return q === undefined ? undefined : q !== null
}

/** The pending question; null = none; undefined = the transcript could not be read */
function questionCall(transcript: string, tail: (path: string) => Record<string, unknown>[]): { call: PendingCall; mtimeMs: number } | null | undefined {
  let st: { size: number; mtimeMs: number }
  try {
    st = statSync(transcript)
  } catch {
    return undefined
  }
  let hit = askCache.get(transcript)
  if (!hit || hit.size !== st.size || hit.mtimeMs !== st.mtimeMs) {
    const records = tail(transcript)
    const pending = turnEnd(records).pending
    // ⚠️ A read that gave nothing from a file that has bytes failed (e.g. out of file descriptors): not remembered,
    //    or the question would stay unseen while the file stays unchanged (codex review)
    if (records.length === 0) return undefined
    hit = { size: st.size, mtimeMs: st.mtimeMs, pending }
    askCache.delete(transcript)
    askCache.set(transcript, hit)
    if (askCache.size > ASK_CACHE_MAX) askCache.delete(askCache.keys().next().value as string)
  }
  const p = hit.pending
  return p !== undefined && p.name === AGY_QUESTION_TOOL ? { call: p, mtimeMs: st.mtimeMs } : null
}

/**
 * ★ The list state, in the words a Claude row uses.
 * - a card is up ⇒ `waiting` (only while agy says so; the flag comes with `tool_use`)
 * - ★ a question is up (`asking`, from `agyAsking`) ⇒ `waiting`
 * - `working` / `tool_use` / `reviewing` ⇒ `working`
 * - `error` ⇒ `error`
 * - `idle` after a turn this conversation was seen working in ⇒ `done`; before any ⇒ `idle`
 * - `initializing` / `authenticating` / unknown ⇒ `idle`
 * ⚠️ A turn stopped with ESC or a declined card also ends `idle` after working, so it reads `done` (agy sends no
 *    signal that tells them apart: no Stop hook for either / measured 2026-11-19).
 */
export function agyStatus(s: Pick<AgyState, 'agentState' | 'confirmationPending' | 'busyAt'>, asking: boolean): SessionStatus {
  if (s.confirmationPending || asking) return 'waiting'
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
  /** ★ A question is up (`agyAsking`). ⚠️ Required: a caller that forgets it would read the row as working */
  asking: boolean
}

export function agyRow(s: AgyState, ctx: AgyRowContext): SessionSummary {
  const project = basename(s.cwd) || s.cwd
  const title: { title: string; titleSource: TitleSource } = s.title
    ? { title: s.title, titleSource: 'ai' }
    : ctx.promptTitle
      ? { title: ctx.promptTitle, titleSource: 'prompt' }
      : { title: project, titleSource: 'fallback' }
  const status = agyStatus(s, ctx.asking)
  return {
    machine: ctx.machine,
    account: AGY_ACCOUNT,
    tool: 'agy',
    sessionId: AGY_PREFIX + s.conversationId,
    cwd: s.cwd,
    project,
    ...title,
    status,
    // ★ A question: the words a Codex question uses (the phone tells it apart from an approval)
    ...(status === 'waiting' ? { waitingFor: s.confirmationPending ? 'permission prompt' : 'input needed' } : {}),
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
  /** ★ The conversations whose lock the agy holds (`agyLocksOf`; replaced in tests) */
  locksOf?: (pid: number) => string[] | undefined
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

/** The pids that have their own state file (`pid-<pid>.json`, written by the status line relay) */
export function agyPidFiles(dir: string): number[] {
  try {
    return readdirSync(dir).flatMap((name) => {
      const m = /^pid-(\d+)\.json$/.exec(name)
      return m ? [Number(m[1])] : []
    })
  } catch {
    return []
  }
}

/**
 * ★ One agy's own state (`pid-<pid>.json`: the same content as the conversation's file, but only this agy writes it).
 * ⚠️ Synchronous (read right before an answer's key). Not a plain file, too big, unreadable, not ours ⇒ undefined.
 */
export function readAgyPidFile(dir: string, pid: number): AgyFile | undefined {
  const path = join(dir, `pid-${pid}.json`)
  try {
    const st = lstatSync(path)
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return undefined
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    const cid = isObj(raw) && isObj(raw.input) ? str(raw.input.conversation_id) : undefined
    const state = cid ? parseAgyFile(raw, cid) : undefined
    return state && state.pid === pid ? { state, mtimeMs: st.mtimeMs } : undefined
  } catch {
    return undefined
  }
}

/**
 * ★ Whether another agy shows this conversation, or wrote into it since `since`. Two agys on one conversation share its
 * transcript, so a call or a result after `since` could be the other one's (codex review).
 * - ★ another agy's visit mark (`visit-<id>-<pid>`, touched by its status line on every write while it shows this
 *   conversation, and kept when it moves elsewhere or exits) written at or after `since` ⇒ yes
 * - a running agy whose own file names this conversation and that holds no other conversation's lock (a second agy
 *   on this conversation), or that cannot be told ⇒ yes. Holding another conversation's lock = it moved there.
 * ⚠️ Synchronous. An unreadable directory counts as shared (fail-closed). undefined = cannot tell (a lock probe of
 * another claimant failed): acting on it is refused like shared; what is already shown is kept.
 */
export function agyShared(
  dir: string,
  conversationId: string,
  pid: number,
  isAgy: (pid: number) => boolean,
  locksOf: (pid: number) => string[] | undefined,
  since: number,
): boolean | undefined {
  try {
    readdirSync(dir)
  } catch {
    return true
  }
  const want = conversationId.toLowerCase()
  if (agyVisitedSince(dir, want, pid, since)) return true
  let unknown = false
  const withOwn = new Set(agyPidFiles(dir))
  for (const other of withOwn) {
    if (other === pid || !isAgy(other)) continue
    if (readAgyPidFile(dir, other)?.state.conversationId !== want) continue
    const locks = locksOf(other)
    // ⚠️ Cannot tell whether it moved on (a probe that failed): said so (the cards keep what they show / codex review)
    if (locks === undefined) {
      unknown = true
      continue
    }
    if (locks.some((c) => c !== want)) continue
    return true
  }
  // ★ An agy with an older relay (no own file) whose conversation file names this one (`agyConversations` counts it too).
  //   ⚠️ Whether that file is still its newest is not looked at here: counted as shared (fail-closed)
  try {
    const raw = JSON.parse(readFileSync(join(dir, `session-${want}.json`), 'utf8')) as unknown
    const other = parseAgyFile(raw, want)?.pid
    if (other !== undefined && other !== pid && !withOwn.has(other) && isAgy(other)) return true
  } catch {
    // no such file: nobody else
  }
  return unknown ? undefined : false
}

/**
 * ★ Whether an agy other than the one holding this conversation's lock wrote into it since `since` (a visit mark at or
 * after it). For "done": a shared transcript's last answer may be the other agy's (codex review). No holder (or it
 * cannot be told) ⇒ true (fail-closed).
 */
export function agyOthersWrote(
  dir: string,
  conversationId: string,
  since: number,
  isAgy: (pid: number) => boolean,
  locksOf: (pid: number) => string[] | undefined,
): boolean | undefined {
  const want = conversationId.toLowerCase()
  const claimants = agyPidFiles(dir).filter((p) => isAgy(p) && readAgyPidFile(dir, p)?.state.conversationId === want)
  // ⚠️ A claimant whose lock cannot be told ⇒ cannot tell (the caller tries again later instead of deciding / codex review)
  if (claimants.some((p) => locksOf(p) === undefined)) return undefined
  const holder = claimants.find((p) => locksOf(p)?.includes(want))
  if (holder === undefined) return true
  // ★ Only what another agy wrote counts here (its visit mark since then): one merely open and idle on it does not
  //   (codex review: a parked second terminal silenced every "done")
  return agyVisitedSince(dir, want, holder, since)
}

/** ★ Whether an agy other than `pid` wrote into this conversation since `since` (its visit mark). Unreadable ⇒ yes */
export function agyVisitedSince(dir: string, conversationId: string, pid: number, since: number): boolean {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return true
  }
  const want = conversationId.toLowerCase()
  for (const name of names) {
    const m = /^visit-([0-9a-fA-F-]{36})-(\d+)$/.exec(name)
    if (!m || m[1]!.toLowerCase() !== want || Number(m[2]) === pid) continue
    try {
      if (statSync(join(dir, name)).mtimeMs >= since) return true
    } catch {
      // gone meanwhile
    }
  }
  return false
}

/**
 * ★★ agy's own word for which conversation a process shows: it keeps `presence/<id>.lock` open for it (measured on
 * 1.5.13: the lock moves at `/new` — before the first prompt — and at `/resume`; a second agy on the same
 * conversation says "already open" and holds none). Linux reads `/proc/<pid>/fd`; elsewhere `lsof`.
 * @returns the conversation ids whose lock the process holds; undefined = cannot tell
 */
export function agyLocksOf(pid: number, home: string = homedir()): string[] | undefined {
  if (process.platform === 'linux') {
    let fds: string[]
    try {
      fds = readdirSync(`/proc/${pid}/fd`)
    } catch {
      return undefined
    }
    const paths: string[] = []
    for (const fd of fds) {
      try {
        paths.push(readlinkSync(`/proc/${pid}/fd/${fd}`))
      } catch {
        // closed meanwhile
      }
    }
    return lockIds(paths, home)
  }
  try {
    return lockIds(lsofNames(execFileSync('lsof', lsofArgs(pid), { ...LSOF_OPTS, stdio: ['ignore', 'pipe', 'ignore'] })), home)
  } catch {
    return undefined
  }
}

/**
 * ★ `agyLocksOf` without blocking: the background looks and the list use this (a Mac's `lsof` takes a while, and
 * several agys probed one after another blocked every other request / codex review). Linux's `/proc` is read as is.
 */
export function agyLocksOfAsync(pid: number, home: string = homedir()): Promise<string[] | undefined> {
  if (process.platform === 'linux') return Promise.resolve(agyLocksOf(pid, home))
  return new Promise((resolve) => {
    execFile('lsof', lsofArgs(pid), LSOF_OPTS, (err, out) => resolve(err ? undefined : lockIds(lsofNames(String(out)), home)))
  })
}

/**
 * ★ Deps whose `locksOf` answers from probes made beforehand, all at once and without blocking (`agyLocksOfAsync`), for
 * every running agy that has a state file. Deps that bring their own `locksOf` (tests) are returned as they are.
 */
export async function withLocksProbed(deps: AgyDeps): Promise<AgyDeps> {
  if (deps.locksOf) return deps
  const pids = new Set<number>(agyPidFiles(deps.dir).filter((p) => deps.isAgy(p)))
  for (const f of await readAgyFiles(deps.dir)) if (deps.isAgy(f.state.pid)) pids.add(f.state.pid)
  const probed = new Map(await Promise.all([...pids].map(async (p) => [p, await agyLocksOfAsync(p, deps.home)] as const)))
  return { ...deps, locksOf: (p) => (probed.has(p) ? probed.get(p) : agyLocksOf(p, deps.home)) }
}

const LSOF_OPTS = {
  encoding: 'utf8' as const,
  timeout: 3000,
  maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, PATH: `${process.env.PATH ?? ''}:/usr/sbin:/usr/bin` },
}
const lsofArgs = (pid: number): string[] => ['-a', '-p', String(pid), '-Fn']
const lsofNames = (out: string): string[] => out.split('\n').flatMap((l) => (l.startsWith('n') ? [l.slice(1)] : []))

/** The conversation ids of the presence locks among these open paths (also through a linked `~/.gemini`) */
function lockIds(paths: string[], home: string): string[] {
  const plain = join(agyHome(home), 'presence')
  let real = plain
  try {
    real = realpathSync(plain)
  } catch {
    // not there (yet): no lock can be held in it either
  }
  const dirs = [...new Set([plain, real])].map((d) => d + '/')
  return paths.flatMap((p) => {
    const dir = dirs.find((d) => p.startsWith(d))
    if (!dir) return []
    const m = /^([0-9a-fA-F-]{36})\.lock$/.exec(p.slice(dir.length))
    return m ? [m[1]!.toLowerCase()] : []
  })
}

/** ★ Whether the process holds this conversation's lock. ⚠️ Cannot tell ⇒ false (no card / no answer) */
export function agyHoldsLock(pid: number, conversationId: string, home: string = homedir()): boolean {
  return agyLocksOf(pid, home)?.includes(conversationId.toLowerCase()) ?? false
}

/**
 * ★ The rows as each agy's own state says, for the agys that hold their conversation's lock (notifications / codex
 * review: the per-conversation file can be overwritten by a second agy on the same conversation). One row per
 * conversation; a conversation two agys claim is left out.
 */
export function agyOwnRows(machine: string, deps: AgyDeps): SessionSummary[] {
  const locksOf = deps.locksOf ?? ((p: number) => agyLocksOf(p, deps.home))
  const byConv = new Map<string, SessionSummary | null>()
  // ⚠️ Every slow part (`lsof` on a Mac) first, then every file read: the states used are the ones read last, not one
  //    read before another agy's slow lock scan (codex review)
  const locks = new Map(agyPidFiles(deps.dir).filter((p) => deps.isAgy(p)).map((p) => [p, locksOf(p)] as const))
  for (const [pid, held] of locks) {
    const f = readAgyPidFile(deps.dir, pid)
    if (!f || !held?.includes(f.state.conversationId)) continue
    const id = f.state.conversationId
    // ★ A question's wait is named by its own transcript write (`agyQuestionAt`; the notifier's identity of a wait)
    const askedAt = agyQuestionAt(f.state, f.mtimeMs, transcriptPathOf(id, deps.home))
    const asking = askedAt !== undefined
    byConv.set(id, byConv.has(id) ? null : agyRow(f.state, { machine, transcriptBytes: 0, lastActivity: new Date(askedAt ?? f.mtimeMs).toISOString(), asking }))
  }
  return [...byConv.values()].filter((r): r is SessionSummary => r !== null)
}

/**
 * ★ The own row of one conversation (the sender guard's direct read): only the agys whose own file names it are probed
 * (usually one), the lock first and the file after. Two holding it ⇒ none.
 */
export function agyOwnRowOf(machine: string, deps: AgyDeps, conversationId: string): SessionSummary | undefined {
  const want = conversationId.toLowerCase()
  const locksOf = deps.locksOf ?? ((p: number) => agyLocksOf(p, deps.home))
  const candidates = agyPidFiles(deps.dir).filter((p) => deps.isAgy(p) && readAgyPidFile(deps.dir, p)?.state.conversationId === want)
  const holders = candidates.filter((p) => locksOf(p)?.includes(want))
  if (holders.length !== 1) return undefined
  const f = readAgyPidFile(deps.dir, holders[0]!)
  if (!f || f.state.conversationId !== want) return undefined
  const askedAt = agyQuestionAt(f.state, f.mtimeMs, transcriptPathOf(want, deps.home))
  return agyRow(f.state, { machine, transcriptBytes: 0, lastActivity: new Date(askedAt ?? f.mtimeMs).toISOString(), asking: askedAt !== undefined })
}

/** `pid-<n>.json` files of agys gone for a day, and visit marks a day old, are removed (only ours) */
export async function sweepAgyPidFiles(deps: AgyDeps): Promise<void> {
  let names: string[]
  try {
    names = await readdir(deps.dir)
  } catch {
    return
  }
  // ⚠️ A visit mark of a conversation a running agy shows is kept however old (it may still guard a card left up for
  //    days / codex review)
  const shown = new Set(
    agyPidFiles(deps.dir)
      .filter((p) => deps.isAgy(p))
      .flatMap((p) => readAgyPidFile(deps.dir, p)?.state.conversationId ?? []),
  )
  for (const name of names) {
    const own = /^pid-(\d+)\.json$/.exec(name)
    const visit = /^visit-([0-9a-fA-F-]{36})-\d+$/.exec(name)
    if (own ? deps.isAgy(Number(own[1])) : !visit || shown.has(visit[1]!.toLowerCase())) continue
    const path = join(deps.dir, name)
    try {
      const st = await stat(path)
      if (deps.now - st.mtimeMs > AGY_FILE_MAX_AGE_MS) await unlink(path)
    } catch {
      // gone meanwhile
    }
  }
}

/** Titles from transcript heads, kept while the conversation lives (the first request never changes) */
const titles = new Map<string, string>()

export function defaultAgyDeps(): AgyDeps {
  return { dir: agyDir(), home: homedir(), isAgy: isAgyProcess, now: Date.now() }
}

export interface AgyConversation {
  /** The state to go by: the showing agy's own file, else the per-conversation file (an agy with an older relay) */
  file: AgyFile
  /** ★ Which file it came from (read again from that same file: a move then shows as a mismatch) */
  source: 'own' | 'conversation'
  /** ★ Two running agys show it (agy allows that, with a warning): no send, stop or card for it (fail-closed) */
  contested: boolean
}

/**
 * ★★ The conversations the running agys show, each with the state to go by (codex review: the per-conversation file is
 * written by every agy on the conversation, so a second agy could overwrite it, take the Stop key, or — by exiting —
 * make the conversation vanish from the list).
 * - an agy's own file (`pid-<pid>.json`) names the conversation it shows; one that holds another conversation's lock
 *   has moved there (a `/new` at an empty prompt writes no file yet) and does not count
 * - one agy ⇒ its state; two or more ⇒ `contested`, the state of the one holding the lock (else the newest)
 * - an agy without an own file (an older relay) claims by its newest per-conversation file (`liveAgy`), and counts
 *   like any other (a mix of relay versions is contested too)
 */
export async function agyConversations(deps: AgyDeps): Promise<Map<string, AgyConversation>> {
  // ★ One claimant per running agy: its own file when it has one (only that: its per-conversation files may be stale,
  //   it may have moved on / codex review), else its newest per-conversation file (an agy with an older relay)
  const claims = new Map<string, (AgyFile & { source: AgyConversation['source'] })[]>()
  const add = (f: AgyFile, source: AgyConversation['source']): void => {
    const list = claims.get(f.state.conversationId) ?? []
    list.push({ ...f, source })
    claims.set(f.state.conversationId, list)
  }
  const withOwn = new Set<number>()
  for (const pid of agyPidFiles(deps.dir)) {
    if (!deps.isAgy(pid)) continue
    const own = readAgyPidFile(deps.dir, pid)
    if (!own) continue
    withOwn.add(pid)
    add(own, 'own')
  }
  for (const f of await liveAgy(deps)) if (!withOwn.has(f.state.pid)) add(f, 'conversation')
  const out = new Map<string, AgyConversation>()
  const locksOf = deps.locksOf ?? ((p: number) => agyLocksOf(p, deps.home))
  for (const [conv, list] of claims) {
    // ⚠️ Locks are read only when two claim it (a Mac's `lsof` is slow)
    const present = list.length < 2 ? list : list.filter((c) => !(locksOf(c.state.pid)?.some((l) => l !== conv) ?? false))
    if (present.length === 0) continue
    const pick = (c: (typeof present)[number]): Omit<AgyConversation, 'contested'> => ({ file: { state: c.state, mtimeMs: c.mtimeMs }, source: c.source })
    if (present.length === 1) {
      // ⚠️ A "card is up" state is believed only from the lock holder (a status line that stopped writing, then a move
      //    elsewhere, would keep an old card listed / codex review). Locks are read for waiting states only.
      //    ⚠️ Only a probe that shows it is NOT held hides it: "cannot tell" (a slow `lsof`) keeps it listed (hiding it
      //    made the phone close a live "needs you" / codex review). Acting on it still needs the lock (`findAgyTarget`).
      const locks = present[0]!.state.confirmationPending ? locksOf(present[0]!.state.pid) : undefined
      if (locks !== undefined && !locks.includes(conv)) continue
      out.set(conv, { ...pick(present[0]!), contested: false })
      continue
    }
    const holder = present.find((c) => locksOf(c.state.pid)?.includes(conv))
    out.set(conv, { ...pick(holder ?? present.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a))), contested: true })
  }
  return out
}

/**
 * ★ Whether the agy process an auto-approve grant was given to (`grants.ts`) still shows that conversation
 * (docs/AGY.md §10): running, the same relay registration (a reused pid has another), holding the conversation's lock
 * (a `/new` moves the lock at once while the status file still names the old conversation / codex review).
 * undefined = cannot tell now (a lock probe that failed): kept, ended once it can be told.
 */
export async function agyOwnerShows(owner: { pid: number; startedAt: number }, conversationId: string, deps: AgyDeps): Promise<boolean | undefined> {
  // ⚠️ Gone only when the process is known gone or known to be another (a probe that failed, e.g. out of file
  //    descriptors, is not proof / codex review)
  if (!deps.isAgy(owner.pid)) {
    const alive = (deps.aliveProcStart ?? aliveProcStartSync)(owner.pid)
    if (alive === null) return false
    if (alive === undefined) return undefined
    // the very process its relay registered (same start) ⇒ the name probe failed, not another process
    const same = await agyPaneOf(owner.pid, () => alive)
    // (a relay record that cannot be read either: cannot tell; another registration: gone)
    if (typeof same === 'string') return same === 'unverified' ? false : undefined
    return same.startedAt === owner.startedAt ? undefined : false
  }
  const pane = await agyPaneOf(owner.pid, deps.aliveProcStart ?? aliveProcStartSync)
  // ⚠️ A relay record that cannot be read while the agy runs is a read that failed (e.g. out of file descriptors), not
  //    a move: cannot tell (codex review: one failed read ended a live grant). Another registration = another run
  if (typeof pane === 'string') return undefined
  if (pane.startedAt !== owner.startedAt) return false
  const locks = (deps.locksOf ?? ((p: number) => agyLocksOf(p, deps.home)))(owner.pid)
  return locks === undefined ? undefined : locks.includes(conversationId.toLowerCase())
}

/** ★ The live agy rows for `/sessions` */
export async function agyRows(machine: string, given: AgyDeps = defaultAgyDeps()): Promise<SessionSummary[]> {
  const deps = await withLocksProbed(given)
  const conversations = [...(await agyConversations(deps)).values()]
  const locksOf = deps.locksOf ?? ((p: number) => agyLocksOf(p, deps.home))
  const holdsLock = (pid: number, conv: string): boolean => locksOf(pid)?.includes(conv) ?? false
  const live = conversations.map((c) => c.file)
  const rows: SessionSummary[] = []
  for (const { file: f, contested } of conversations) {
    const path = transcriptPathOf(f.state.conversationId, deps.home)
    const bytes = await sizeOf(path)
    // ★ Not listed before its first message, like Claude (whose list is built from transcripts): a send there is
    //   refused anyway (the gate needs the transcript) / user decision 2026-11-20. ⚠️ A turn that runs or waits on a
    //   card stays listed even then (never hide something that needs an answer)
    const asking = bytes > 0 && agyAsking(f.state, f.mtimeMs, path)
    const status = agyStatus(f.state, asking)
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
        asking,
        ...(title ? { promptTitle: title } : {}),
        // ⚠️ A conversation two agys show takes nothing from the phone (`agyConversations`), nor does one whose agy does
        //    not hold its lock (`findAgyTarget` refuses the same)
        ...(typeof pane === 'string' || contested || !holdsLock(f.state.pid, f.state.conversationId) ? {} : { sendRoute: 'keys' as const }),
      }),
    )
    if (contested) rows[rows.length - 1] = { ...rows[rows.length - 1]!, agyShared: true }
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
