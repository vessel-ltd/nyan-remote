// ★★ The team routes (`nyan team …` / docs/TEAM.md §3–§4). Served **only on the team socket** (`teamSocket.ts`):
//    never on 127.0.0.1:7777, never through the relay. ⚠️ Who may call: whoever can open the socket = this OS user.
//
// Every route that acts for a leader takes `leader` (its Claude session id) and `pid` (the Claude process the CLI runs
// under) and checks them against the team's instance (`teamLedBy`) on every call.
// ★ A Codex lead (2026-11-27 / docs/TEAM.md §10) sends `codexThread` (its `CODEX_THREAD_ID`) and `codexHome` instead:
//   the agent makes the row id from them and the thread must be one its daemon lists.

import { createHash } from 'node:crypto'
import { t } from '../../../shared/i18n.ts'
import { looksLikeCommand, MAX_SEND_BYTES, type LogEntry, type PermissionRequest, type SessionSummary, type ToolUsage } from '../../../shared/types.ts'
import { config } from '../config.ts'
import { discoverConfigDirs } from '../claude/configDirs.ts'
import { findTarget, sendToSession } from '../claude/inbox.ts'
import { aliveProcStartFreshSync, sameProcStart } from '../claude/sessionIndex.ts'
import { isCodexSessionId, shortSessionId } from '../codex/ids.ts'
import { codexSessionPrefix } from '../codex/daemon.ts'
import { isQuiet, originOf, pendingWithMeta } from '../permission.ts'
import { TEAM_CONFIRM_MS, confirmOnPhone, teamCreateCard } from '../teamConfirm.ts'
import { machineName } from '../machine.ts'
import { sweepResolved } from '../permissionSweep.ts'
import { HttpError, readJsonBody, type Ctx } from '../router.ts'
import {
  allTeams,
  approvalsActive,
  createTeam,
  findMember,
  membershipOf,
  removeMember,
  teamActor,
  teamById,
  leaderLive,
  teamLedBy,
  teamView,
  MAX_TEAM_MEMBERS,
  TEAM_APPROVAL_DURATIONS,
  type CreateFailure,
  type Team,
  type TeamMember,
} from '../team.ts'
import { TEAM_FRAME_CLOSE, TEAM_FRAME_MARK, TEAM_SENDER, agyInstructionSent, sendTag, agyStateNow, asMemberData, cardText, endTeam, soleProcessSync, indexStatusNow, leaderMay, leaderSessionNow, liveMember, memberUnique, ownsCard, revealed, cardRef, teamDeps, tellLeader } from '../teamHooks.ts'
import { agyDelivery, agyDeliveryMessage } from '../agy/cards.ts'
import { AGY_DELIVERY_WAIT_MS, notifyPermission, settledWithin } from './permission.ts'
import { answerPermission, type AnswerBody } from './permission.ts'
import { codexMessage } from './message.ts'
import { codexLabelShared, codexLists, codexLog, codexRowsNow, codexSend, codexStatusKnown } from '../codex/run.ts'
import { AGY_PREFIX, conversationOf, transcriptPathOf } from '../agy/sessions.ts'
import { AGY_SEND_REFUSAL, defaultAgyKeysDeps, findAgyTarget, looksLikeAgyShortcut, sendToAgy } from '../agy/keys.ts'
import { agyEntries } from '../agy/log.ts'
import { lastTurnStart } from '../agy/pending.ts'
import type { TeamTool } from '../team.ts'
import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { readdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { sessions } from './sessions.ts'
import { readLogSlice } from '../claude/log.ts'
import { usage } from './usage.ts'
import { broadcast } from '../events.ts'

const WEEK_MINUTES = 7 * 24 * 60
/** `team read`: how many pages (100 entries each) it goes back at most before saying the read is incomplete */
const READ_PAGES_MAX = 200

interface LeaderBody {
  leader?: unknown
  pid?: unknown
  /** ★ A Codex lead: its thread id (`CODEX_THREAD_ID`) and its home (`CODEX_HOME`, absent = `~/.codex`) */
  codexThread?: unknown
  codexHome?: unknown
}

/** Who calls: a Claude session (and the process the CLI runs under) or a Codex row */
type Caller = { tool: 'claude'; sessionId: string; pid: number } | { tool: 'codex'; sessionId: string; pid?: undefined }

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * ★ Whether a Claude profile has nyan's turn-end hook (`notify.sh` on `Stop`): without it a member's turn ends are never
 *   heard, neither by the leader nor the phone (a profile made after `nyan update` / codex review r10). A warning only:
 *   unreadable ⇒ false (the lead is told to check).
 */
export function hasTurnEndHook(configDir: string, home = homedir()): boolean {
  const script = join(home, '.claude', 'hooks', 'notify.sh')
  // ★ Only the forms the installer writes (`install-permission-hook.mjs` NOTIFY_COMMAND / its path, bare or quoted): a
  //   moved profile's stale path also names notify.sh but runs nothing (codex review r12)
  const ours = new Set(['"$HOME/.claude/hooks/notify.sh"', script, `'${script.replaceAll("'", "'\\''")}'`])
  try {
    // ⚠️ The script must be a regular, runnable file (a stale entry reports nothing / codex review r11)
    if (!statSync(script).isFile()) return false
    accessSync(script, constants.X_OK)
    const o = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as { hooks?: Record<string, unknown> }
    // ★ Both turn ends: a finished turn (`Stop`) and a stop on an error or the plan limit (`StopFailure` / codex review r13)
    return ['Stop', 'StopFailure'].every((ev) => {
      const list = o.hooks?.[ev]
      return (
        Array.isArray(list) &&
        list.some((e) => {
          const hooks = e && typeof e === 'object' ? (e as { hooks?: unknown }).hooks : undefined
          return Array.isArray(hooks) && hooks.some((h) => !!h && typeof h === 'object' && (h as { type?: unknown }).type === 'command' && ours.has(String((h as { command?: unknown }).command)))
        })
      )
    })
  } catch {
    return false
  }
}

/** The same profile directory, however it was written (`configDirs` may end in `/` / codex review) */
function sameDir(a: string, b: string | undefined): boolean {
  return b !== undefined && resolve(a) === resolve(b)
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function leaderOf(o: LeaderBody): Caller {
  const thread = str(o.codexThread)
  if (thread !== undefined) {
    // ⚠️ Only the shape Codex gives (it becomes part of a row id we look up, never a path or a prefix)
    if (!THREAD_ID.test(thread)) throw new HttpError(400, t('Codex のスレッドが分かりません', 'The Codex thread is unknown.'))
    const home = str(o.codexHome)
    if (home !== undefined && !isAbsolute(home)) throw new HttpError(400, t('CODEX_HOME が絶対パスではありません', 'CODEX_HOME is not an absolute path.'))
    // ★ The same row id the daemon's line gives that thread (`codexHomes`: the resolved home path)
    return { tool: 'codex', sessionId: codexSessionPrefix(resolve(home ?? join(homedir(), '.codex'))) + thread }
  }
  const sessionId = str(o.leader)
  const pid = typeof o.pid === 'number' ? o.pid : Number(o.pid)
  if (!sessionId || !Number.isInteger(pid) || pid <= 0) {
    throw new HttpError(400, t('リーダーのセッションが分かりません（Claude Code の中から実行してください）', 'The leader session is unknown (run this inside Claude Code).'))
  }
  // ⚠️ A Codex row id is never accepted as a Claude leader (a Codex lead names its thread instead)
  if (isCodexSessionId(sessionId)) throw new HttpError(400, t('リーダーのセッションが分かりません', 'The leader session is unknown.'))
  return { tool: 'claude', sessionId, pid }
}

function fromQuery(ctx: Ctx): LeaderBody {
  const p = (k: string): string | undefined => ctx.url.searchParams.get(k) ?? undefined
  return { leader: p('leader'), pid: p('pid'), codexThread: p('codexThread'), codexHome: p('codexHome') }
}

/** ★ A Codex lead's thread is listed by its daemon now (the only proof of its life) */
function codexLeadListed(sessionId: string): boolean {
  return codexRowsNow().some((r) => r.sessionId === sessionId)
}

/** The team this caller leads, or a 404/409 that says what to do */
function ledTeam(o: LeaderBody): Team {
  const { sessionId, pid } = leaderOf(o)
  const r = teamLedBy(sessionId, pid, teamDeps())
  if (r.ok) return r.team
  if (r.reason === 'leader-gone' && r.ended) endTeam(r.ended, 'leader process gone')
  if (r.reason === 'not-this-leader') {
    throw new HttpError(409, t('このチームは同じセッションの別のプロセスが作ったものです', 'This team was made by another process of the same session.'))
  }
  throw new HttpError(404, t('このセッションが率いるチームはありません（/nyan-team で作ります）', 'This session leads no team (make one with /nyan-team).'))
}

function memberOf(team: Team, ref: unknown): TeamMember {
  const name = str(ref)
  if (!name) throw new HttpError(400, t('メンバーを指定してください（m1 など）', 'Name a member (m1, …).'))
  const m = findMember(team, name)
  if (m === 'ambiguous') throw new HttpError(400, t(`「${name}」に当たるメンバーが複数います`, `"${name}" matches more than one member.`))
  if (!m) throw new HttpError(404, t(`メンバー「${name}」はいません`, `No member "${name}".`))
  return m
}

function toolOf(row: SessionSummary): TeamTool {
  return row.tool === 'codex' ? 'codex' : row.tool === 'agy' ? 'agy' : 'claude'
}

/**
 * The short reference a candidate is picked by: never a list position (positions shift / codex review, medium #6).
 * ⚠️ A Codex thread id is a UUIDv7: its head is a timestamp, so threads started the same minute share their first
 *    8 characters (measured: four `astra` threads printed one ref). ⇒ Codex refs use the random tail.
 */
export function refOf(row: Pick<SessionSummary, 'sessionId'>): string {
  // ⚠️⚠️ Made by us, hex only (codex review r3, high #6): the leader types it into its own shell, and a session id is
  //    another program's text. A Claude id that is a plain UUID keeps its first 8 characters (the same as /status).
  if (!isCodexSessionId(row.sessionId) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.sessionId)) {
    return row.sessionId.slice(0, 8)
  }
  const kind = isCodexSessionId(row.sessionId) ? 'cx' : row.sessionId.startsWith(AGY_PREFIX) ? 'ag' : 'c'
  return `${kind}-${createHash('sha256').update(row.sessionId, 'utf8').digest('hex').slice(0, 8)}`
}

interface Candidate {
  ref: string
  tool: TeamTool
  account: string
  title: string
  project: string
  status: string
  model?: string
  effort?: string
  contextTokens?: number
  /** Claude: its inbox can be written to now (`nyan team send` reaches it). Codex / agy: absent */
  reachable?: true
  /** Weekly limit used (0–100) of that profile's login, when known. ⚠️ Kept for an older `nyan team` (use `limits`) */
  weeklyUsedPercent?: number
  /** ★ That login's plan-limit windows with their reset times, and when they were read (2026-11-19) */
  limits?: Limits
  /** Already in a team (`lead` / `member`) */
  team?: { id: string; role: 'lead' | 'member' }
}

/**
 * ★ A login's plan-limit windows as the team commands show them (2026-11-19): each window's use **and reset time**, and
 * when the numbers were read, so the lead can tell how stale they are. Longest window first.
 * ⚠️ Only what the tool reported (some plans have no 5-hour window); windows whose reset passed are already dropped.
 */
interface Limits {
  windows: { minutes: number; usedPercent: number; resetsAt: string }[]
  at: string
  /** ★ Other profiles logged in to the same account: one quota (codex review r4). Labels only, never the account */
  sameLoginAs?: string[]
}

export function limitsOf(u: { usage: ToolUsage[] }, tool: TeamTool, account: string): Limits | undefined {
  // ⚠️ Two homes can share a label (`work/.codex` and `personal/.codex`): then which login a row is cannot be told,
  //    so nothing is shown rather than another login's numbers (codex review r1)
  const found = u.usage.filter((x) => x.tool === tool && x.account === account)
  const own = found.length === 1 ? found[0] : undefined
  if (!own) return undefined
  // ★ Two profiles can be one account (measured: `.claude-r` and `.claude-rs`), so one quota: every profile of it shows
  //   the newest reading and names the others, or the lead would see 96% and 12% for the same 5 hours (codex review r4)
  const same = own.accountKey ? u.usage.filter((x) => x.tool === tool && x.accountKey === own.accountKey) : [own]
  // ⚠️ The newest reading wins even when it has no window left: an older one could bring back a window the plan no
  //    longer has (codex review r5)
  const got = [...same].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]
  if (!got || got.windows.length === 0) return undefined
  const windows = [...got.windows]
    .sort((a, b) => b.minutes - a.minutes)
    .map((w) => ({ minutes: w.minutes, usedPercent: Math.round(w.usedPercent), resetsAt: w.resetsAt }))
  const others = [...new Set(same.map((x) => x.account).filter((a) => a !== account))].sort()
  return { windows, at: got.at, ...(others.length ? { sameLoginAs: others } : {}) }
}

/**
 * The readings the team commands use. ⚠️ A Codex label shared by two watched homes is left out even when only one of
 * them has a reading (codex review r2): which home a row with that label belongs to cannot be told.
 */
async function teamUsage(): Promise<{ usage: ToolUsage[] }> {
  return withoutSharedLabels(await usage().catch(() => ({ usage: [] as ToolUsage[] })), codexLabelShared)
}

export function withoutSharedLabels(u: { usage: ToolUsage[] }, shared: (label: string) => boolean): { usage: ToolUsage[] } {
  return { usage: u.usage.filter((x) => !(x.tool === 'codex' && shared(x.account))) }
}

async function liveRows(): Promise<SessionSummary[]> {
  const page = await sessions()
  return page.sessions.filter((s) => s.live)
}

export async function teamCandidates(ctx: Ctx): Promise<{ candidates: Candidate[] }> {
  const { sessionId: self } = leaderOf(fromQuery(ctx))
  const [rows, u] = await Promise.all([liveRows(), teamUsage()])
  const dirs = await discoverConfigDirs(config().configDirs)
  const out: Candidate[] = []
  for (const row of rows) {
    if (row.sessionId === self) continue
    const tool = toolOf(row)
    // ★ agy (docs/TEAM.md §9): only a conversation nyan can type into (started through the relay, shown by one agy)
    if (tool === 'agy' && (row.sendRoute !== 'keys' || row.agyShared)) continue
    let reachable = false
    if (tool === 'claude') {
      const target = await findTarget(dirs, row.sessionId)
      if ('reason' in target) continue // not reachable now (no inbox, unverifiable, ambiguous): not a candidate
      reachable = true
    }
    const limits = limitsOf(u, tool, row.account)
    const week = limits?.windows.find((w) => w.minutes === WEEK_MINUTES)
    const led = allTeams().find((x) => x.leader.sessionId === row.sessionId)
    const inTeam = led ? { id: led.id, role: 'lead' as const } : membershipOf(row.sessionId) ? { id: membershipOf(row.sessionId)!.team.id, role: 'member' as const } : undefined
    out.push({
      ref: refOf(row),
      tool,
      account: row.account,
      title: revealed(row.title),
      project: revealed(row.project),
      status: row.status,
      ...(row.model ? { model: row.model } : {}),
      ...(row.effort ? { effort: row.effort } : {}),
      ...(row.contextTokens !== undefined ? { contextTokens: row.contextTokens } : {}),
      ...(reachable ? { reachable: true as const } : {}),
      ...(week ? { weeklyUsedPercent: week.usedPercent } : {}),
      ...(limits ? { limits } : {}),
      ...(inTeam ? { team: inTeam } : {}),
    })
  }
  return { candidates: out }
}

const CREATE_TEXT: Record<CreateFailure, () => string> = {
  'no-members': () => t('メンバーを1つ以上選んでください', 'Pick at least one member.'),
  'too-many': () => t('メンバーは8つまでです', 'At most 8 members.'),
  'duplicate-member': () => t('同じメンバーが2回あります', 'The same member is listed twice.'),
  'leader-is-member': () => t('自分自身はメンバーにできません', 'The leader cannot be its own member.'),
  'already-leading': () => t('このセッションはもうチームを率いています（nyan team disband で解散してから）', 'This session already leads a team (disband it first with nyan team disband).'),
  'leader-in-team': () => t('このセッションは別のチームのメンバーです', 'This session is a member of another team.'),
  'member-in-team': () => t('選んだセッションの1つが、もう別のチームに入っています', 'One of the picked sessions is already in another team.'),
  'member-is-leader': () => t('選んだセッションの1つは、別のチームのリーダーです', 'One of the picked sessions leads another team.'),
  'bad-duration': () => t('承認を任せる長さは 3h か 24h です', 'The approvals duration is 3h or 24h.'),
}

interface CreateBody extends LeaderBody {
  members?: unknown
  approvals?: unknown
}

/** Codex leads with a confirmation on the phone now, and when each was last declined (or went unanswered) */
const confirming = new Set<string>()
const refusedAt = new Map<string, number>()
/** After a "no" (or no answer), how long a lead waits before it may ask again */
const CONFIRM_PAUSE_MS = 60_000

/**
 * ⚠️ One confirmation at a time per lead, and a pause after a "no" (r15 #1: a prompt-injected Codex could fill the
 *    phone with cards and pushes). Checked before the lookups and again right before the card.
 */
function pacedConfirm(sessionId: string): void {
  if (confirming.has(sessionId)) throw new HttpError(409, t('このセッションのチーム作りの確認が、もうスマホに出ています', 'A team confirmation from this session is already on the phone.'))
  const wait = (refusedAt.get(sessionId) ?? 0) + CONFIRM_PAUSE_MS - Date.now()
  if (wait > 0) {
    throw new HttpError(409, t(`チーム作りが断られたばかりです。${Math.ceil(wait / 1000)}秒待ってから、利用者に聞いてやり直してください`, `The team was just declined. Wait ${Math.ceil(wait / 1000)} s, ask the user, then try again.`))
  }
}

/** ★ The one live session a candidate ref names (never the lead itself), or the 400/404 that says why */
function rowForRef(rows: SessionSummary[], ref: string, leadId: string): SessionSummary {
  // ⚠️ Matched only against our own refs (never a prefix of another program's id)
  if (!/^(c-|cx-|ag-)?[0-9a-f]{8}$/.test(ref)) throw new HttpError(400, t(`参照の形が違います: ${ref}`, `Not a candidate ref: ${ref}`))
  const hits = rows.filter((r) => r.sessionId !== leadId && refOf(r) === ref)
  if (hits.length === 0) throw new HttpError(404, t(`「${ref}」に当たる生きているセッションがありません（nyan team candidates で確かめて）`, `No live session matches "${ref}" (check with nyan team candidates).`))
  if (hits.length > 1) throw new HttpError(400, t(`「${ref}」に当たるセッションが複数あります`, `"${ref}" matches more than one session.`))
  return hits[0]!
}

/**
 * ★ Before a Codex lead's card goes up: what would fail anyway is said now, not after the human pressed "Allow"
 *   (`createTeam` judges it all again afterwards)
 */
function precheckCodexLead(leadId: string, picked: { sessionId: string }[], approvals: string | undefined): void {
  if (picked.length === 0) throw new HttpError(409, CREATE_TEXT['no-members']())
  if (picked.length > MAX_TEAM_MEMBERS) throw new HttpError(409, CREATE_TEXT['too-many']())
  if (new Set(picked.map((r) => r.sessionId)).size !== picked.length) throw new HttpError(409, CREATE_TEXT['duplicate-member']())
  if (approvals !== undefined && !Object.hasOwn(TEAM_APPROVAL_DURATIONS, approvals)) throw new HttpError(409, CREATE_TEXT['bad-duration']())
  for (const team of allTeams()) {
    if (team.leader.sessionId === leadId) throw new HttpError(409, CREATE_TEXT['already-leading']())
    if (team.members.some((m) => m.sessionId === leadId)) throw new HttpError(409, CREATE_TEXT['leader-in-team']())
  }
}

/** Synchronously: the process's own index entry names this session (its status is not required / r22 low #3) */
function indexNamesSession(configDir: string, pid: number, sessionId: string): boolean {
  try {
    const o = JSON.parse(readFileSync(join(configDir, 'sessions', `${pid}.json`), 'utf8')) as { sessionId?: unknown }
    return o.sessionId === sessionId
  } catch {
    return false
  }
}

type MemberIn = { sessionId: string; tool: TeamTool; account: string; pid?: number; procStart?: string; configDir?: string; busyAtJoin?: boolean }

/** ★ The member a picked row becomes: a Claude or agy member bound to its process instance now, or the 409 saying why */
async function bindMember(row: SessionSummary, ref: string, dirs: Awaited<ReturnType<typeof discoverConfigDirs>>): Promise<MemberIn> {
  const tool = toolOf(row)
  if (tool === 'claude') {
    // ★ Bind a Claude member to its process instance (codex review, high #1): a resume is another member
    const at = await findTarget(dirs, row.sessionId)
    const start = 'reason' in at ? undefined : aliveProcStartFreshSync(at.pid)
    if ('reason' in at || typeof start !== 'string') {
      throw new HttpError(409, t(`「${ref}」のセッションを確かめられません（いま繋がっていない）`, `Cannot verify the session "${ref}" (not reachable now).`))
    }
    return { sessionId: row.sessionId, tool, account: row.account, pid: at.pid, procStart: start, configDir: dirname(at.sessionsDir), ...(row.status === 'working' || row.status === 'waiting' ? { busyAtJoin: true } : {}) }
  } else if (tool === 'agy') {
    // ★ Bind an agy member to the agy process that shows the conversation now (the one keys would go to)
    const conv = conversationOf(row.sessionId)
    const at = conv === undefined || row.agyShared ? undefined : await findAgyTarget(conv, defaultAgyKeysDeps())
    const start = at === undefined || typeof at === 'string' ? undefined : aliveProcStartFreshSync(at.pid)
    if (at === undefined || typeof at === 'string' || typeof start !== 'string') {
      throw new HttpError(409, t(`「${ref}」の agy を確かめられません（中継を通して起動した agy で、1つだけが開いているときに選べます）`, `Cannot verify the agy "${ref}" (pick one started through the relay, open in one agy only).`))
    }
    // ⚠️ Its own state file (`pid-<pid>.json`) must name the conversation: every later check reads it (codex review:
    //    an agy with only the older per-conversation file was accepted, then shown as replaced and never usable)
    if (!agyStateNow({ tool, pid: at.pid, sessionId: row.sessionId })) {
      throw new HttpError(
        409,
        t(
          `「${ref}」の agy の状態がまだ読めません（更新の前から開いている agy など）。その agy で何か1つ送ってから、もう一度作ってください`,
          `Cannot read the state of the agy "${ref}" yet (an agy opened before an update, for example). Send it anything once, then create the team again.`,
        ),
      )
    }
    return { sessionId: row.sessionId, tool, account: row.account, pid: at.pid, procStart: start }
  }
  return { sessionId: row.sessionId, tool, account: row.account, ...(row.status === 'working' || row.status === 'waiting' ? { busyAtJoin: true } : {}) }
}

/** The same instance as when the human saw the card (tool, profile, process and its start) */
function sameBinding(a: MemberIn, b: MemberIn): boolean {
  return a.sessionId === b.sessionId && a.tool === b.tool && a.account === b.account && a.pid === b.pid && a.procStart === b.procStart && a.configDir === b.configDir
}

export async function teamCreate(ctx: Ctx): Promise<unknown> {
  // ★ The CLI going away (Codex interrupted it), tracked from the very start (codex review ② r3 #4): a card is never
  //   raised for it, a raised one is withdrawn, and an answered one makes no team.
  //   ⚠️ The response's `close`, never the request's: a request's `close` fires as soon as its body is read (Node 24,
  //      measured 2026-11-27: 2 ms after the body, while the client still waits)
  let cliGone = false
  let withdrawCard: (() => void) | undefined
  /** The team made, until the reply has gone out (a Codex lead only) */
  let unreported: Team | undefined
  const onGone = (): void => {
    if (ctx.res.writableEnded) return
    cliGone = true
    withdrawCard?.()
    // ⚠️ Made, but the command that asked was stopped before it heard so (r4 #3): the team does not stay behind it
    if (unreported && teamById(unreported.id) === unreported) endTeam(unreported, t('チームを作ったコマンドが止められた', 'the command that made it was stopped'))
  }
  ctx.res.once('close', onGone)
  ctx.req.once('aborted', onGone)
  const goneError = (): HttpError => new HttpError(409, t('コマンドが止められたので、チームは作りません', 'The command was stopped, so no team is made.'))
  const body = await readJsonBody<CreateBody>(ctx.req)
  const lead = leaderOf(body)
  const { sessionId } = lead
  const refs = Array.isArray(body.members) ? body.members.filter((x): x is string => typeof x === 'string' && x.length > 0) : []
  const approvals = body.approvals === undefined || body.approvals === null ? undefined : String(body.approvals)

  // ⚠️ A Codex lead: the cheap refusals before any lookup or scan (r16 #1, r17 #2: a flood of creates made every ref be
  //    looked up and the sessions be scanned)
  if (lead.tool === 'codex') {
    if (refs.length === 0) throw new HttpError(409, CREATE_TEXT['no-members']())
    if (refs.length > MAX_TEAM_MEMBERS) throw new HttpError(409, CREATE_TEXT['too-many']())
    if (new Set(refs).size !== refs.length) throw new HttpError(409, CREATE_TEXT['duplicate-member']())
    pacedConfirm(sessionId)
  }
  // ★ The leader instance: its live index entry must name the process the CLI runs under
  const dirs = await discoverConfigDirs(config().configDirs)
  let claudeLead: { pid: number; procStart: string; configDir: string } | undefined
  if (lead.tool === 'codex') {
    // ★ A Codex lead: a thread its daemon lists (one the phone shows), started in the Codex app or CLI
    if (!codexLeadListed(sessionId)) {
      throw new HttpError(
        409,
        t(
          'この Codex のセッションは nyan から見えていません（Codex のアプリか codex コマンドで開いたセッションから使ってください。codex exec は使えません）',
          'nyan does not see this Codex session (use it from a session opened in the Codex app or the codex command; codex exec is not supported).',
        ),
      )
    }
  } else {
    const target = await findTarget(dirs, sessionId)
    if ('reason' in target || target.pid !== lead.pid) {
      throw new HttpError(409, t('リーダーのセッションを確かめられません（Claude Code の中から実行してください）', 'Cannot verify the leader session (run this inside Claude Code).'))
    }
    const procStart = aliveProcStartFreshSync(lead.pid)
    if (typeof procStart !== 'string') throw new HttpError(409, t('リーダーのプロセスを確かめられません', 'Cannot verify the leader process.'))
    claudeLead = { pid: lead.pid, procStart, configDir: dirname(target.sessionsDir) }
  }

  let rows = await liveRows()
  const bindAll = async (): Promise<MemberIn[]> => {
    const out: MemberIn[] = []
    for (const ref of refs) out.push(await bindMember(rowForRef(rows, ref, sessionId), ref, dirs))
    return out
  }
  let members = await bindAll()
  // ★★ A Codex lead: the human says yes on the phone first (2026-11-27 / `teamConfirm.ts`). Every pick is bound to its
  //    instance before the card; after the answer all is read again and must be the very same instances (r3 #3).
  if (lead.tool === 'codex') {
    precheckCodexLead(sessionId, members, approvals)
    if (cliGone) throw goneError()
    pacedConfirm(sessionId)
    const leadRow = rows.find((r) => r.sessionId === sessionId)
    const info = teamCreateCard({
      machine: machineName(),
      lead: { sessionId, account: leadRow?.account ?? '', project: leadRow?.project ?? '', title: leadRow?.title ?? '' },
      members: refs.map((ref, i) => {
        const r = rows.find((x) => x.sessionId === members[i]!.sessionId)!
        return { ref, sessionId: r.sessionId, tool: toolOf(r), account: r.account, project: r.project, title: r.title }
      }),
      ...(approvals !== undefined ? { approvals } : {}),
      at: new Date().toISOString(),
    })
    console.log(`[team] create waits for the phone lead=${shortSessionId(sessionId)} members=${members.length}${approvals ? ` approvals=${approvals}` : ''}`)
    confirming.add(sessionId)
    const answer = await confirmOnPhone(
      info,
      (withdraw) => {
        withdrawCard = withdraw
        if (cliGone) withdraw()
      },
      {
        shown: (card) => {
          broadcast({ type: 'permissions-changed', machine: card.machine, at: card.at })
          void notifyPermission(card)
        },
        over: () => broadcast({ type: 'permissions-changed', machine: machineName(), at: new Date().toISOString() }),
      },
    )
    withdrawCard = undefined
    confirming.delete(sessionId)
    if (answer !== 'allow') refusedAt.set(sessionId, Date.now())
    console.log(`[team] create ${cliGone ? 'stopped (the command went away)' : answer} on the phone lead=${shortSessionId(sessionId)}`)
    if (cliGone) throw goneError()
    if (answer === 'deny') throw new HttpError(409, t('利用者がスマホでチーム作りを断りました', 'The user declined the team on the phone.'))
    if (answer === 'no-answer') {
      throw new HttpError(
        409,
        t(
          `スマホで答えがありませんでした（${TEAM_CONFIRM_MS / 60_000}分で取り下げ）。利用者に聞いてから、もう一度作ってください`,
          `No answer on the phone (withdrawn after ${TEAM_CONFIRM_MS / 60_000} minutes). Ask the user, then create the team again.`,
        ),
      )
    }
    // ⚠️ What follows reads the sessions as they are now, not as they were before the wait
    const seen = members
    rows = await liveRows()
    members = await bindAll()
    if (members.some((m, i) => !sameBinding(m, seen[i]!))) {
      throw new HttpError(409, t('選んだセッションが、確認のあいだに変わりました。もう一度作ってください', 'The picked sessions changed while waiting for the confirmation. Create the team again.'))
    }
    if (!codexLeadListed(sessionId)) {
      throw new HttpError(409, t('リーダーのセッションが変わりました。もう一度 /nyan-team から始めてください', 'The leader session changed. Start again from /nyan-team.'))
    }
  }
  const leaderRow = rows.find((r) => r.sessionId === sessionId)
  // ⚠️⚠️ No await from here to `createTeam`: the snapshot below is the grant's moment
  // ⚠️ Every Claude or agy member is still the very instance bound above — read synchronously, after the last await
  //    (r4 #4: one could end or move on while a later pick was looked up, before a team existed to hear of it), and
  //    **before** the baseline below (r5 #5: these reads can be slow on macOS — `ps` — and the baseline must be last)
  for (const m of members) {
    if (m.pid === undefined || m.procStart === undefined) continue
    const now = aliveProcStartFreshSync(m.pid)
    const same =
      typeof now === 'string' &&
      sameProcStart(now, m.procStart) &&
      (m.tool === 'agy' ? !!agyStateNow({ tool: 'agy', pid: m.pid, sessionId: m.sessionId }) : m.configDir !== undefined && indexNamesSession(m.configDir, m.pid, m.sessionId))
    if (!same) throw new HttpError(409, t('選んだセッションの1つが、いま変わりました。もう一度作ってください', 'One of the picked sessions just changed. Create the team again.'))
  }
  // ★ Approvals already waiting now stay with the human (`mayLeaderAnswer`, low #2)
  const waiting = pendingWithMeta().map((p) => originOf(p.info))
  // ★ Members waiting right now (a Codex wait may have no card yet: a join replays it later / r4 high #4)
  //    ⚠️ Codex rows read synchronously right here, after every await (a thread can start waiting while the Claude
  //    members were being looked up / r5 high #2); a Claude member with a card is covered by `waiting` (its keys)
  const codexNow = codexRowsNow()
  // ⚠️ Claude members: their own index entry, read synchronously right here (r13 high #1: a member could start
  //    waiting while the others were looked up). Unreadable ⇒ no grant (the state is not known).
  const claudeNow = new Map(members.filter((m) => m.tool === 'claude').map((m) => [m.sessionId, indexStatusNow(m)]))
  if (approvals !== undefined && [...claudeNow.values()].some((st) => st === undefined)) {
    throw new HttpError(409, t('選んだ Claude のセッションの様子をいま確かめられません。少し待ってからもう一度作ってください', 'Cannot read a Claude session’s state right now. Wait a moment and create the team again.'))
  }
  // ★ agy members are not listed here: each agy card carries the time of its own call (`PendingMeta.requestedAt`), so a
  //   call made before the grant stays the human's by that alone (agy review: a member held here missed later cards)
  const waitingNow = members
    .filter((m) => (m.tool === 'codex' ? codexNow.find((r) => r.sessionId === m.sessionId)?.status === 'waiting' : m.tool === 'claude' && claudeNow.get(m.sessionId) === 'waiting'))
    .map((m) => m.sessionId)
  // ⚠️ A grant needs every Codex member's state known now (a line reconnecting lists nothing: a wait that began then
  //    would replay later as "new" / r6 high #2)
  // ⚠️ Every Codex member must still be listed now (one that closed meanwhile would stay in a team nobody ends / r10 low #1)
  if (members.some((m) => m.tool === 'codex' && !codexNow.some((r) => r.sessionId === m.sessionId))) {
    throw new HttpError(409, t('選んだ Codex のセッションの1つが、いま開かれていません', 'One of the picked Codex sessions is not open right now.'))
  }
  if (approvals !== undefined && members.some((m) => m.tool === 'codex' && !codexStatusKnown(m.sessionId))) {
    throw new HttpError(409, t('Codex のセッションの様子をいま確かめられません。少し待ってからもう一度作ってください', 'Cannot read a Codex session’s state right now. Wait a moment and create the team again.'))
  }
  const cardless = waitingNow.filter((id) => !id.startsWith('codex-') && !id.startsWith(AGY_PREFIX) && !pendingWithMeta().some((p) => p.info.sessionId === id))
  // ⚠️ The leader itself, again, synchronously (r21 low #1: its session could end during the baseline reads)
  const leaderNow = claudeLead ? aliveProcStartFreshSync(claudeLead.pid) : undefined
  const leaderStill = claudeLead
    ? typeof leaderNow === 'string' && sameProcStart(leaderNow, claudeLead.procStart) && indexNamesSession(claudeLead.configDir, claudeLead.pid, sessionId)
    : codexLeadListed(sessionId)
  if (!leaderStill) {
    throw new HttpError(409, t('リーダーのセッションが変わりました。もう一度 /nyan-team から始めてください', 'The leader session changed. Start again from /nyan-team.'))
  }
  // ⚠️ Right before the team is made: the command that asked is still there (r3 #4)
  if (cliGone) throw goneError()
  const r = createTeam(
    claudeLead ? { sessionId, account: leaderRow?.account ?? '', ...claudeLead } : { tool: 'codex', sessionId, account: leaderRow?.account ?? '' },
    members,
    approvals,
    Date.now(),
    waiting,
    waitingNow,
    cardless,
  )
  if (!r.ok) throw new HttpError(409, CREATE_TEXT[r.reason]())
  if (lead.tool === 'codex') unreported = r.team
  console.log(
    `[team] created team=${r.team.id} lead=${shortSessionId(sessionId)} members=${r.team.members.map((m) => `${m.name}:${shortSessionId(m.sessionId)}`).join(',')}` +
      (r.team.approvals ? ` approvals=${r.team.approvals.duration}` : ''),
  )
  broadcast({ type: 'sessions-changed', at: new Date().toISOString() })
  // ★ agy stamps its calls to the second (measured: `2026-11-23T01:06:53Z` for a call made 0.6 s after a grant at
  //   53.421): a call in the grant's own second reads as before it and stays the human's. The leader's first
  //   instruction is sent after this reply ⇒ reply once the next second has begun, so its calls are judged after.
  if (r.team.approvals && r.team.members.some((m) => m.tool === 'agy')) await new Promise((res) => setTimeout(res, untilNextSecondMs(Date.now())))
  const out = await statusOf(r.team)
  // ⚠️ Stopped meanwhile: `onGone` ended the team; never reported as made
  if (cliGone) throw goneError()
  unreported = undefined
  return out
}

/** How long until the next whole second (+ a margin): an agy call's time has whole seconds only */
export function untilNextSecondMs(now: number): number {
  return 1000 - (now % 1000) + 20
}

async function statusOf(team: Team): Promise<unknown> {
  const [rows, u] = await Promise.all([liveRows(), teamUsage()])
  const dirs = await discoverConfigDirs(config().configDirs)
  const v = teamView(team)
  const members = []
  for (const m of v.members) {
    const row = rows.find((r) => r.sessionId === m.sessionId)
    let reachable = false
    let replaced = false
    if (m.tool === 'claude') {
      // ⚠️ Only the process the team was made with (a resume under the same id is a session the human never picked /
      //    r4 medium #10): otherwise no address, and the member is shown as replaced
      const target = await findTarget(dirs, m.sessionId)
      if (!('reason' in target) && target.pid === m.pid && liveMember(m)) reachable = true
      else replaced = true
    } else if (m.tool === 'agy') {
      // ★ No longer the recorded agy on this conversation (it exited, or the PC moved it elsewhere)
      if (!liveMember(m) || !agyStateNow(m)) replaced = true
    }
    const limits = limitsOf(u, m.tool, m.account)
    members.push({
      name: m.name,
      sessionId: m.sessionId,
      tool: m.tool,
      account: m.account,
      title: row ? revealed(row.title) : '',
      status: replaced ? 'replaced' : (row?.status ?? 'gone'),
      ...(reachable ? { reachable: true as const } : {}),
      ...(m.tool === 'claude' && m.configDir && !hasTurnEndHook(m.configDir) ? { noReports: true as const } : {}),
      ...(limits ? { limits } : {}),
    })
  }
  return {
    id: v.id,
    leader: { sessionId: v.leader.sessionId, tool: v.leader.tool ?? 'claude', account: v.leader.account, ...leaderLimits(u, v.leader.tool ?? 'claude', v.leader.account) },
    members,
    ...(v.approvals ? { approvals: { duration: v.approvals.duration, until: new Date(v.approvals.untilMs).toISOString(), active: v.approvals.untilMs > Date.now() } } : {}),
    createdAt: new Date(v.createdAtMs).toISOString(),
  }
}

/** The lead's own login's limits, since its work counts too */
function leaderLimits(u: { usage: ToolUsage[] }, tool: TeamTool, account: string): { limits?: Limits } {
  const limits = limitsOf(u, tool, account)
  return limits ? { limits } : {}
}

export async function teamStatus(ctx: Ctx): Promise<unknown> {
  return statusOf(ledTeam(fromQuery(ctx)))
}

/** ★ Every team on this machine (the human's view: `nyan team status` outside a session) */
export async function teamList(): Promise<unknown> {
  return { teams: await Promise.all(allTeams().map((x) => statusOf(x))) }
}

interface SendBody extends LeaderBody {
  member?: unknown
  text?: unknown
}

/**
 * ★ An instruction to a member of any tool (2026-11-27): Claude through its inbox, Codex through its daemon, agy typed
 *   into its TUI through its relay, only while it is idle (`sendToAgy`, docs/TEAM.md §9).
 * ⚠️⚠️ The body is checked **before** the frame is added: `[nyan-team] …` in front would hide a leading `/` or `!`
 *    (codex design review, medium #1).
 */
export async function teamSend(ctx: Ctx): Promise<unknown> {
  const body = await readJsonBody<SendBody>(ctx.req)
  const team = ledTeam(body)
  const member = memberOf(team, body.member)
  const text = typeof body.text === 'string' ? body.text : ''
  if (!text.trim()) throw new HttpError(400, t('本文が空です', 'The text is empty.'))
  if (looksLikeCommand(text)) throw new HttpError(400, t('/ や ! で始まる文は送れません', 'Text starting with / or ! cannot be sent.'))
  // ★ agy: this send's own tag in the frame (the safety net knows its prompt by it / docs/TEAM.md §9.2)
  const tag = member.tool === 'agy' ? ` ${sendTag()}` : ''
  // ★ Claude: the inbox says "from another session", and Claude then looks for someone to reply to — `nyan-team` is no
  //   session, and a guessed recipient got the work in an unrelated session (docs/ARCHITECTURE.md, the inbox's side
  //   effect / codex review r6). ⇒ Said in the frame: no reply message, the turn's last message is the report
  const noReply =
    member.tool === 'claude'
      ? t('\n（SendMessage などで返事を送らないでください。nyan-team は受け取れません。）', '\n(Do not send a reply with SendMessage or any other tool; nyan-team cannot receive it.)')
      : ''
  const framed = t(
    `${TEAM_FRAME_MARK}リーダー（${shortSessionId(team.leader.sessionId)}${tag}）からの指示:\n${text}\n\n${TEAM_FRAME_CLOSE.ja}${noReply}`,
    `${TEAM_FRAME_MARK}Instruction from the team lead (${shortSessionId(team.leader.sessionId)}${tag}):\n${text}\n\n${TEAM_FRAME_CLOSE.en}${noReply}`,
  )
  if (Buffer.byteLength(framed, 'utf8') > MAX_SEND_BYTES) throw new HttpError(400, t('長すぎます', 'Too long.'))
  // ⚠️ Asked right before the daemon write: still this team's member, the leader still the same (r6 medium #3)
  const stillOurs = (): boolean => teamById(team.id) === team && team.members.includes(member) && leaderLive(team, teamDeps()) && leaderSessionNow(team)
  if (member.tool === 'claude') {
    // ★ Claude: its inbox (the socket Claude's own SendMessage writes to), busy or idle — Claude queues it (2026-11-27 /
    //   every member is reached through nyan). ⚠️ Only the recorded process, in its own profile (a resume under the same
    //   id, or the same id in another profile, is not the member the human picked / r5 medium #3, r6 medium #4)
    if (!(await memberUnique(member))) throw new HttpError(409, REFUSAL_TEXT['member-gone']!())
    if (!stillOurs()) throw new HttpError(409, REFUSAL_TEXT['no-team']!())
    const dirs = (await discoverConfigDirs(config().configDirs)).filter((d) => sameDir(d.dir, member.configDir))
    const r = await sendToSession(dirs, member.sessionId, framed, {
      from: TEAM_SENDER,
      ...(member.pid !== undefined ? { pid: member.pid } : {}),
      ...(member.procStart !== undefined ? { procStart: member.procStart } : {}),
      // ⚠️ Right before the write: still the member's process and session (a `/clear` keeps the pid / codex review)
      guard: () => stillOurs() && liveMember(member) && soleProcessSync(member),
    })
    if (!r.ok) {
      console.log(`[team] send team=${team.id} to=${member.name} not delivered (${r.reason})`)
      throw new HttpError(409, r.message ?? REFUSAL_TEXT['member-gone']!())
    }
    console.log(`[team] send team=${team.id} to=${member.name} ${text.length} chars`)
    return { ok: true, at: new Date().toISOString() }
  }
  if (member.tool === 'agy') {
    // ⚠️ agy opens its shortcut list on a leading `?` (judged on the leader's own text, like `/` `!` above)
    if (looksLikeAgyShortcut(text)) throw new HttpError(400, AGY_SEND_REFUSAL['shortcut-like']()[1])
    // ⚠️ Only the recorded agy, still the only one on the conversation (a resume elsewhere, a second agy ⇒ refused)
    if (!(await memberUnique(member))) throw new HttpError(409, REFUSAL_TEXT['member-gone']!())
    if (!stillOurs()) throw new HttpError(409, REFUSAL_TEXT['no-team']!())
    // ⚠️⚠️ Bound to the member's own agy inside the queue and before each key (codex · agy review): a send waiting behind
    //    another operation must not type into a second agy that opened the conversation, or after the team ended
    // ★ The process checks (slow: `ps` on a Mac) once, on the first ask — inside the queue, before any screen read —
    //   then only the quick ones before each key (codex review: a slow check right before Enter let the PC open a
    //   subagent's dialog in between)
    let processes: boolean | undefined
    // ★ The safety net's baseline (docs/TEAM.md §9.2): the time and the conversation's last turn, taken at each check
    //   right before a key — the last one is just before Enter, inside the agy's queue (codex · agy review: taken before
    //   the queue, a short PC turn in between was taken for the sent one)
    const path = transcriptPathOf(conversationOf(member.sessionId)!)
    let sentAtMs = Date.now()
    let before = lastTurnStart(path)
    const mtimeOf = (): number | undefined => {
      try {
        return statSync(path).mtimeMs
      } catch {
        return undefined
      }
    }
    let beforeMtime = mtimeOf()
    const res = await sendToAgy(conversationOf(member.sessionId)!, framed, defaultAgyKeysDeps(), (target) => {
      processes ??= liveMember(member) && leaderLive(team, teamDeps())
      const ok = processes && target.pid === member.pid && teamById(team.id) === team && team.members.includes(member) && leaderSessionNow(team)
      if (ok) {
        sentAtMs = Date.now()
        before = lastTurnStart(path)
        beforeMtime = mtimeOf()
      }
      return ok
    }, { emptyBoxOnly: true })
    if (!res.ok) {
      console.log(`[team] send team=${team.id} to=${member.name} not typed (${res.reason})`)
      throw new HttpError(...AGY_SEND_REFUSAL[res.reason ?? 'unreachable']())
    }
    console.log(`[team] send team=${team.id} to=${member.name} ${text.length} chars`)
    // ★ The leader is owed how this turn ends, even if no "done" comes (docs/TEAM.md §9.2 / `agyTeamSafetyNet`)
    agyInstructionSent(member, sentAtMs, before, tag.trim(), beforeMtime)
    return { ok: true, at: new Date().toISOString() }
  }
  const res = await codexMessage(member.sessionId, framed, { lists: codexLists, send: (id, text, images) => codexSend(id, text, images, stillOurs) })
  if (!res) throw new HttpError(409, t('この Codex のセッションは、いま開かれていません。', 'This Codex session is not open right now.'))
  console.log(`[team] send team=${team.id} to=${member.name} ${text.length} chars`)
  return { ok: true, at: res.at }
}

export async function teamRead(ctx: Ctx): Promise<unknown> {
  const team = ledTeam(fromQuery(ctx))
  const member = memberOf(team, ctx.url.searchParams.get('member'))
  const n = Math.min(40, Math.max(1, Number(ctx.url.searchParams.get('last') ?? 10) || 10))
  let entries: LogEntry[]
  let incomplete = false
  if (member.tool === 'codex') {
    // ★ Back through the history until `n` messages are found or it ends (tool steps cannot hide them / r13–r14 low)
    entries = []
    let before: number | null = null
    for (let page = 0; page < READ_PAGES_MAX; page++) {
      const got = await codexLog(member.sessionId, { before, limit: 100 })
      if (!got) break
      entries = [...got.entries, ...entries]
      if (entries.filter(said).length >= n || got.cursor === null) break
      // ⚠️ A cursor that does not move would loop: stop and say the read is incomplete
      if (before !== null && got.cursor >= before) {
        incomplete = true
        break
      }
      before = got.cursor
      if (page === READ_PAGES_MAX - 1) incomplete = true
    }
  } else if (member.tool === 'agy') {
    // ★ The conversation's own transcript (one per conversation id). ⚠️ Not once the recorded agy is gone or moved on
    if (!liveMember(member) || !agyStateNow(member)) throw new HttpError(409, REFUSAL_TEXT['member-gone']!())
    entries = []
    const path = transcriptPathOf(conversationOf(member.sessionId)!)
    let before: number | undefined
    for (let page = 0; page < READ_PAGES_MAX; page++) {
      const got = await readLogSlice(path, 100, before, agyEntries).catch(() => undefined)
      if (!got) break
      entries = [...got.entries, ...entries]
      if (entries.filter(said).length >= n || got.cursor === null) break
      if (before !== undefined && got.cursor >= before) {
        incomplete = true
        break
      }
      before = got.cursor
      if (page === READ_PAGES_MAX - 1) incomplete = true
    }
  } else {
    // ⚠️⚠️ The member's own process and profile only (codex review r5, medium #3): the same id's transcript in another
    //    profile is not this member's work, and a resumed process is not the member the human picked
    if (!(await memberUnique(member))) throw new HttpError(409, REFUSAL_TEXT['member-gone']!())
    // ⚠️ Exactly one transcript with that id in the member's own profile directory (r6 medium #4)
    const dirs = (await discoverConfigDirs(config().configDirs)).filter((d) => sameDir(d.dir, member.configDir))
    const paths = await transcriptsOf(dirs, member.sessionId)
    if (paths.length > 1) throw new HttpError(409, t('この id の記録が複数あるので読めません', 'More than one transcript has this id; not read.'))
    entries = []
    if (paths[0]) {
      let before: number | undefined
      for (let page = 0; page < READ_PAGES_MAX; page++) {
        const got = await readLogSlice(paths[0], 100, before)
        entries = [...got.entries, ...entries]
        if (entries.filter(said).length >= n || got.cursor === null) break
        if (before !== undefined && got.cursor >= before) {
          incomplete = true
          break
        }
        before = got.cursor
        if (page === READ_PAGES_MAX - 1) incomplete = true
      }
    }
  }
  const lines: string[] = []
  // ⚠️ The history readers cut a very long message (Claude 8,000 / Codex 20,000 characters): said, never silent (r12 low)
  const cutAt = member.tool === 'codex' ? 20_000 : 8_000
  for (const e of entries.filter(said).slice(-n)) {
    lines.push(`${e.kind === 'user' ? 'USER' : 'ASSISTANT'}: ${e.text}${e.text.length >= cutAt ? t('\n（この発言は途中で切れているかもしれません）', '\n(this message may be cut)') : ''}`)
  }
  // ★ Whole messages (the report's cut points here for the rest / r11 low #1); bounded by the count asked for
  if (incomplete || lines.length < n) {
    lines.unshift(
      incomplete
        ? t('（履歴を読み切れませんでした。これより前もあります）', '(the history could not be read to the end; there is more before this)')
        : member.tool === 'codex'
          // ⚠️ The agent keeps only the newest part of a long Codex thread (r16 low): not proof that nothing came before
          ? t(`（見つかった発言は ${lines.length} 件だけです。長いスレッドは古い部分を保持していないことがあります）`, `(only ${lines.length} message(s) found; older parts of a long thread may not be kept)`)
          : t(`（見つかった発言は ${lines.length} 件だけです）`, `(only ${lines.length} message(s) found)`),
    )
  }
  return { member: member.name, text: asMemberData(member, lines.join('\n\n'), Number.POSITIVE_INFINITY) }
}

/** Every `<id>.jsonl` under these profiles' projects (not only the first) */
async function transcriptsOf(dirs: readonly { projectsDir: string }[], sessionId: string): Promise<string[]> {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return []
  const out: string[] = []
  for (const d of dirs) {
    let projects: string[] = []
    try {
      projects = await readdir(d.projectsDir)
    } catch {
      continue
    }
    for (const p of projects) {
      const path = join(d.projectsDir, p, `${sessionId}.jsonl`)
      try {
        if ((await stat(path)).isFile()) out.push(path)
      } catch {
        // not here
      }
    }
  }
  return out
}

function said(e: LogEntry): e is Extract<LogEntry, { kind: 'user' | 'assistant' }> {
  return (e.kind === 'user' || e.kind === 'assistant') && e.text.trim().length > 0
}

/** ★ The members' waiting approvals, and whether the leader may answer each (and why not) */
export async function teamPending(ctx: Ctx): Promise<unknown> {
  const team = ledTeam(fromQuery(ctx))
  // ★ Cards the PC already answered go first (the hook connection can stay open after a PC answer / r19 medium #1)
  await sweepResolved().catch(() => undefined)
  const out = []
  for (const { info } of pendingWithMeta()) {
    const member = team.members.find((m) => m.sessionId === info.sessionId)
    if (!member) continue
    // ⚠️ Not this member's card (another profile or tool with the same id): not listed at all — its contents are not
    //    the leader's to read (codex review r6, medium #1)
    if (!ownsCard(team, info)) continue
    // ⚠️ Not listed while in its quiet period, as on the phones (r30 medium #2)
    if (isQuiet(info.key)) continue
    const judged = leaderMay(team, info)
    const unique = await memberUnique(member)
    const may = unique ? judged : ({ ok: false, reason: 'member-gone' } as const)
    const shown = cardText(info)
    out.push({
      member: member.name,
      memberTool: member.tool,
      // ★ The name the leader answers with (never the key: it can carry ids the member's CLI chose / r2 high #4)
      ref: cardRef(info),
      tool: revealed(info.toolName),
      // ★ The whole input (a Claude card) or the command/patch (Codex), with its directory (`cardText` / r9 high #3)
      summary: revealed(shown.text),
      // ⚠️ Said, never dropped: what cannot be shown whole is the human's to answer; hidden characters are marked
      ...(shown.clipped || info.detailClipped ? { clipped: true } : {}),
      ...(info.hidden ? { hidden: true } : {}),
      ...(info.subagent ? { subagent: true } : {}),
      ...(info.interaction?.kind === 'question'
        ? {
            questions: info.interaction.questions.map((q) => ({
              question: revealed(q.question),
              multiSelect: q.multiSelect,
              // ★ With each option's description: the label alone ("A", "B") can hide what is chosen (r10 medium #5)
              options: q.options.map((o) => (o.description ? `${revealed(o.label)} — ${revealed(o.description)}` : revealed(o.label))),
            })),
          }
        : {}),
      mayAnswer: may.ok,
      ...(may.ok ? {} : { why: may.reason }),
      at: info.at,
    })
  }
  return { pending: out }
}

interface ApproveBody extends LeaderBody {
  ref?: unknown
  behavior?: unknown
  /** `"2"` = option 2 of the only question; `"1:3"` = option 3 of question 1 (numbers only / r2 high #4) */
  choices?: unknown
  feedback?: unknown
  notes?: unknown
}

/**
 * ★ Option numbers ⇒ the agent's own labels for that card (the leader never types a label: a label is member text and
 *   would be evaluated by the leader's shell inside quotes / codex review r2, high #4).
 */
export function answersFromChoices(
  info: Pick<PermissionRequest, 'interaction'>,
  choices: unknown,
): { ok: true; answers?: Record<string, string[]> } | { ok: false; reason: string } {
  if (choices === undefined) return { ok: true }
  const list = Array.isArray(choices) ? choices : [choices]
  if (list.length === 0) return { ok: true }
  const qs = info.interaction?.kind === 'question' ? info.interaction.questions : []
  // ⚠️ No prototype: a question named `constructor` or `__proto__` is just a question (r3 low #1)
  const out: Record<string, string[]> = Object.create(null) as Record<string, string[]>
  for (const c of list) {
    const m = /^(?:(\d+):)?(\d+)$/.exec(String(c))
    if (!m) return { ok: false, reason: t('選択肢は番号で指定します（2 か 1:3）', 'Choose options by number (2 or 1:3).') }
    const q = qs[m[1] ? Number(m[1]) - 1 : 0]
    const o = q?.options[Number(m[2]) - 1]
    if (!q || !o) return { ok: false, reason: t(`その番号の選択肢はありません: ${String(c)}`, `No such option: ${String(c)}`) }
    ;(out[q.question] ??= []).push(o.label)
  }
  return { ok: true, answers: out }
}

const REFUSAL_TEXT: Record<string, () => string> = {
  'not-member': () => t('この承認はチームのメンバーのものではありません', 'This approval is not a team member’s.'),
  'not-delegated': () => t('このチームでは承認を任されていません（人が答えます）', 'This team was not given the approvals (the human answers).'),
  expired: () => t('承認を任される期限が切れています（人が答えます）', 'The time to answer approvals is over (the human answers).'),
  'before-grant': () => t('任される前から待っていた承認です（人が答えます）', 'This approval was waiting before the grant (the human answers).'),
  plan: () => t('計画の承認は人が答えます', 'Plan approvals are answered by the human.'),
  'broken-question': () => t('この質問は読み取れないので人が答えます', 'This question cannot be read; the human answers.'),
  'member-gone': () => t('このメンバーはチームを作ったときのセッションではありません（人が答えます）', 'This member is no longer the session the team was made with (the human answers).'),
  quiet: () => t('まだ表示されていない承認です（少し待ってから）', 'Not shown yet (wait a moment).'),
  clipped: () => t('コマンドが長すぎて全体を見せられないので、人が答えます', 'The command is too long to show whole; the human answers.'),
  gone: () => t('もう答えられません（答え済み・取り下げ）', 'It can no longer be answered (answered or withdrawn).'),
  'no-team': () => t('チームはもうありません（解散したか、リーダーが終わった）', 'The team is gone (disbanded, or the leader ended).'),
}

export async function teamApprove(ctx: Ctx): Promise<unknown> {
  const body = await readJsonBody<ApproveBody>(ctx.req)
  const team = ledTeam(body)
  // ⚠️⚠️ Labels only (codex review, medium #6): a Codex question's note can become the whole answer (`isOther`) =
  //    free text from the leader. The phone may write notes; the leader may not.
  if (body.notes !== undefined) throw new HttpError(400, t('リーダーは選択肢の番号だけで答えます（書き足しはできません）', 'The leader answers with option numbers only (no notes).'))
  const ref = str(body.ref)
  if (!ref) throw new HttpError(400, t('答える承認（r…）を指定してください', 'Name the approval to answer (r…).'))
  // ★ Settle what the PC already answered before looking the card up (r19 medium #1); the final check below is on the
  //   exact card generation, with no await before the answer
  await sweepResolved().catch(() => undefined)
  const card = pendingWithMeta().find((p) => p.info.sessionId !== undefined && team.members.some((m) => m.sessionId === p.info.sessionId) && cardRef(p.info) === ref)
  if (!card) return { ok: false, reason: REFUSAL_TEXT['gone']!() }
  const member = team.members.find((m) => m.sessionId === card.info.sessionId)!
  // ⚠️⚠️ The member is still the only process with its id (r2 high #1). Checked before the answer; the guard below
  //    re-judges the very card the answer goes to
  if (!(await memberUnique(member))) return { ok: false, reason: REFUSAL_TEXT['member-gone']!() }
  const built = answersFromChoices(card.info, body.choices)
  if (!built.ok) return { ok: false, reason: built.reason }
  const agyQuestion = card.info.tool === 'agy' && card.info.interaction?.kind === 'question'
  const answer: AnswerBody = {
    key: card.info.key,
    ...(typeof body.behavior === 'string' ? { behavior: body.behavior } : {}),
    ...(built.answers ? { answers: built.answers } : {}),
    ...(typeof body.feedback === 'string' ? { feedback: body.feedback } : {}),
    // ★ An agy question is declined by skipping it (ESC per question; the turn goes on / docs/AGY.md §13)
    ...(agyQuestion && body.behavior === 'deny' ? { skip: true } : {}),
  }
  // ★ An agy card is answered by typing a key: the leader is told whether it went out, as the phone is (taken before
  //   answering: answering starts the typing / `permissionAnswer`)
  const delivery = card.info.tool === 'agy' ? agyDelivery(card.info.key) : undefined
  const r = answerPermission(answer, teamActor(team), (target) => {
    if (!target) return { ok: false, reason: REFUSAL_TEXT['gone']!() }
    // ⚠️⚠️ Judged again **now**, with no await before the answer (codex review r3, high #1): the team may have been
    //    disbanded, or its leader may have exited, while the member's uniqueness was being read
    if (teamById(team.id) !== team || !leaderLive(team, teamDeps()) || !leaderSessionNow(team)) return { ok: false, reason: REFUSAL_TEXT['no-team']!() }
    // ⚠️ Still the only process of its profile with that session, judged now (r27 medium #3: a second terminal could
    //    appear while the other profiles were being read)
    if ((member.tool === 'claude' || member.tool === 'agy') && !soleProcessSync(member)) return { ok: false, reason: REFUSAL_TEXT['member-gone']!() }
    const may = leaderMay(team, target)
    return may.ok ? { ok: true } : { ok: false, reason: REFUSAL_TEXT[may.reason]!() }
  }, () =>
    // ★ Asked again right before an agy key (codex review: a disband or the expiry during its settle wait typed it)
    // ⚠️ Quick checks only (file reads, memory): the process checks (`ps` on a Mac) ran in the guard above, at the
    //    answer. A slow check here sat between the card check and the key (codex review rounds 16-17)
    teamById(team.id) === team && team.members.includes(member) && leaderSessionNow(team) && approvalsActive(team),
  )
  if (!r.ok || !delivery) return r
  const d = await settledWithin(delivery, AGY_DELIVERY_WAIT_MS)
  if (d === 'slow') return { ...r, note: t('agy にキーを打っている途中です。nyan team pending で確かめてください', 'Still typing the key into agy; check with nyan team pending.') }
  if (d && !d.ok) return { ok: false, reason: agyDeliveryMessage(d.reason) }
  return r
}

interface MemberBody extends LeaderBody {
  member?: unknown
}

export async function teamRemove(ctx: Ctx): Promise<unknown> {
  const body = await readJsonBody<MemberBody>(ctx.req)
  const team = ledTeam(body)
  const member = memberOf(team, body.member)
  const left = removeMember(member.sessionId)
  if (left?.disbanded) endTeam(team, 'last member removed')
  console.log(`[team] removed team=${team.id} ${member.name}`)
  broadcast({ type: 'sessions-changed', at: new Date().toISOString() })
  return { ok: true, disbanded: left?.disbanded ?? false }
}

interface DisbandBody extends LeaderBody {
  team?: unknown
}

/**
 * ★ End a team. From the leader (its session) or by the human with the team id (`nyan team disband <id>` in a
 *   terminal: the human's way out, docs/TEAM.md §3). ⚠️ The socket is this user's only (`teamSocket.ts`).
 */
export async function teamDisband(ctx: Ctx): Promise<unknown> {
  const body = await readJsonBody<DisbandBody>(ctx.req)
  const id = str(body.team)
  const team = id ? teamById(id) : ledTeam(body)
  if (!team) throw new HttpError(404, t('そのチームはありません', 'No such team.'))
  endTeam(team, id ? 'disbanded by id' : 'disbanded by the leader')
  if (id) void tellLeader(team, t('[nyan-team] チームは人の操作で解散されました', '[nyan-team] The team was disbanded by the human.'), undefined, { final: true })
  return { ok: true }
}

