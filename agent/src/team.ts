// ★★ Teams (`/nyan-team` / docs/TEAM.md / 2026-11-19).
//
// One session (the leader) directs other sessions on this machine (the members), across profiles and across Claude
// Code / Codex. Claude ↔ Claude talk uses Claude's own cross-session messages (the leader is told each member's
// address); this module keeps who leads whom, bridges what Claude's messages cannot reach (Codex members), lets the
// leader answer its members' approvals when the user chose so, and keeps the members' turn-end pushes quiet.
//
// ⚠️⚠️ **Memory only** (docs/TEAM.md §4.2 / codex design review, high #5). No `teams.json`: an agent restart disbands
//    every team, and every delegated approval goes back to the human. ⇒ A grant cannot come back from a stale file, and
//    CLAUDE.md §2 gets no third exception.
// ⚠️⚠️ The leader is bound to **its process instance** (pid + start time), not only to its session id: a resumed
//    session with the same id is a different leader (high #5). Checked again on every call (`leaderLive`).
// ⚠️ Same-user sessions can already reach one another (the keystroke socket and the inbox let the same uid through), so
//    the leader's identity is not defended against the same user (docs/TEAM.md §6). What is defended: another OS user
//    (the team socket lives in the 0700 state directory / `teamSocket.ts`), a grant outliving its team or its expiry,
//    and decisions reserved for people (`ExitPlanMode`).

import { randomBytes } from 'node:crypto'
import type { PermissionRequest } from '../../shared/types.ts'
import { requiresInteraction } from './claude/interaction.ts'
import { shortSessionId } from './codex/ids.ts'

/** ★ How long the leader may answer its members' approvals. The UI/CLI sends the name only (like auto-approve) */
export const TEAM_APPROVAL_DURATIONS = { '3h': 3 * 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000 } as const
export type TeamApprovalDuration = keyof typeof TEAM_APPROVAL_DURATIONS


/** At most this many members (a leader reading eight threads is already a lot) */
export const MAX_TEAM_MEMBERS = 8

/** ★ agy (2026-11-22 / docs/TEAM.md §9): a member only (it has no inbox, so it cannot lead) */
export type TeamTool = 'claude' | 'codex' | 'agy'

export interface TeamLeader {
  sessionId: string
  /** Profile (base name of the config dir) */
  account: string
  /** ★ Its profile directory (hooks from another profile with the same base name are not this leader / r6 medium #2) */
  configDir?: string
  /** The leader's process and its start time: the instance the team belongs to */
  pid: number
  procStart: string
}

export interface TeamMember {
  /** Short name the leader uses (`m1`, `m2`, …) */
  name: string
  sessionId: string
  tool: TeamTool
  account: string
  /**
   * ★ A Claude member's process and its start time (codex review, high #1): a member that exits without `SessionEnd`
   *   and is resumed with the same session id is **another instance** — the leader must not answer its approvals.
   *   ★ An agy member: its agy process (the one that showed the conversation when the team was made).
   *   Absent for Codex members (their thread is checked against the daemon's live rows by `sweepTeams`).
   */
  pid?: number
  procStart?: string
  /**
   * ★ A Claude member's profile directory, as its index lives (codex review r6, high #1): two profiles can share a
   *   base name (`~/a/.claude`, `~/b/.claude`); a card is the member's only when its transcript is under this directory.
   */
  configDir?: string
}

export interface TeamApprovals {
  duration: TeamApprovalDuration
  /** Granted at (ms). ⚠️ Approvals that were already waiting before this stay with the human */
  grantedAtMs: number
  untilMs: number
  /**
   * ★ The approvals already waiting when the grant was made (their keys / codex review, low #2): a request registered
   *   in the same millisecond as the grant passed the time check. Stays with the human whatever its timestamp says.
   */
  preexisting: string[]
  /**
   * ★ Members that were already waiting when the grant was made (codex review r4, high #4): a Codex wait whose request
   *   is replayed by a join after the grant looks new by every timestamp. Their cards stay with the human until that
   *   wait is seen to end (`clearWaitingAtGrant`, from the sweep).
   */
  waitingAtGrant: string[]
  /**
   * ★ Of those, the Claude members waiting **with no card** at the grant (its hook may arrive a moment later / r12
   *   high #1): released only on a confirmed end of that wait (the sweep reads the session's status), never because
   *   "no grant-time card is pending".
   */
  cardlessAtGrant: string[]
}

export interface Team {
  id: string
  leader: TeamLeader
  members: TeamMember[]
  approvals?: TeamApprovals
  createdAtMs: number
}

export interface TeamDeps {
  /** The start time of a live process now (`null` = gone). ⚠️ Fresh, never cached (same as the inbox's last check) */
  procStart(pid: number): string | null | undefined
  sameProcStart(a: string, b: string): boolean
}

const teams = new Map<string, Team>()

export function resetTeamsForTest(): void {
  teams.clear()
}

export function allTeams(): Team[] {
  return [...teams.values()]
}

/** Copy a team for output (never hand out the stored object) */
export function teamView(team: Team): Team {
  return {
    ...team,
    leader: { ...team.leader },
    members: team.members.map((m) => ({ ...m })),
    ...(team.approvals ? { approvals: { ...team.approvals } } : {}),
  }
}

export type CreateFailure =
  | 'no-members'
  | 'too-many'
  | 'duplicate-member'
  | 'leader-is-member'
  | 'already-leading'
  | 'leader-in-team'
  | 'member-in-team'
  | 'member-is-leader'
  | 'bad-duration'

export function createTeam(
  leader: TeamLeader,
  members: readonly Omit<TeamMember, 'name'>[],
  approvals: string | undefined,
  now = Date.now(),
  /** Keys of the approvals waiting right now (they stay with the human) */
  preexistingKeys: readonly string[] = [],
  /** Members whose session is waiting right now (their cards stay with the human until that wait ends) */
  waitingAtGrant: readonly string[] = [],
  /** Of those, Claude members with no card at the grant */
  cardlessAtGrant: readonly string[] = [],
): { ok: true; team: Team } | { ok: false; reason: CreateFailure; sessionId?: string } {
  if (members.length === 0) return { ok: false, reason: 'no-members' }
  if (members.length > MAX_TEAM_MEMBERS) return { ok: false, reason: 'too-many' }
  let duration: TeamApprovalDuration | undefined
  if (approvals !== undefined) {
    // ⚠️ An unknown name is refused, never treated as 3h (the screen and the agent would disagree / same as auto-approve)
    if (!Object.hasOwn(TEAM_APPROVAL_DURATIONS, approvals)) return { ok: false, reason: 'bad-duration' }
    duration = approvals as TeamApprovalDuration
  }
  const seen = new Set<string>()
  for (const m of members) {
    if (seen.has(m.sessionId)) return { ok: false, reason: 'duplicate-member', sessionId: m.sessionId }
    seen.add(m.sessionId)
    if (m.sessionId === leader.sessionId) return { ok: false, reason: 'leader-is-member' }
  }
  // ⚠️ No chains: a leader is not a member elsewhere, a member is in one team only and leads none
  //    (orders cannot go round in a circle, and one approval has one leader who may answer it)
  for (const t of teams.values()) {
    if (t.leader.sessionId === leader.sessionId) return { ok: false, reason: 'already-leading' }
    if (t.members.some((m) => m.sessionId === leader.sessionId)) return { ok: false, reason: 'leader-in-team' }
    for (const m of members) {
      if (t.members.some((x) => x.sessionId === m.sessionId)) return { ok: false, reason: 'member-in-team', sessionId: m.sessionId }
      if (t.leader.sessionId === m.sessionId) return { ok: false, reason: 'member-is-leader', sessionId: m.sessionId }
    }
  }
  const team: Team = {
    id: randomBytes(4).toString('hex'),
    leader: { ...leader },
    members: members.map((m, i) => ({
      name: `m${i + 1}`,
      sessionId: m.sessionId,
      tool: m.tool,
      account: m.account,
      ...(m.pid !== undefined && m.procStart !== undefined ? { pid: m.pid, procStart: m.procStart } : {}),
      ...(m.configDir !== undefined ? { configDir: m.configDir } : {}),
    })),
    ...(duration
      ? { approvals: { duration, grantedAtMs: now, untilMs: now + TEAM_APPROVAL_DURATIONS[duration], preexisting: [...preexistingKeys], waitingAtGrant: [...waitingAtGrant], cardlessAtGrant: [...cardlessAtGrant] } }
      : {}),
    createdAtMs: now,
  }
  teams.set(team.id, team)
  return { ok: true, team }
}

/**
 * ★ Is that process the recorded instance? `same` / `gone` (exited, or its pid now another process: confirmed) /
 *   `unknown` (cannot tell now, e.g. `ps` failed on mac / codex review r9, medium #1). Only `same` gives authority;
 *   only `gone` ends anything.
 */
export function instanceState(pid: number, procStart: string, deps: TeamDeps): 'same' | 'gone' | 'unknown' {
  const now = deps.procStart(pid)
  if (now === null) return 'gone'
  if (typeof now !== 'string') return 'unknown'
  return deps.sameProcStart(now, procStart) ? 'same' : 'gone'
}

/** Whether the leader's process is the one the team was made with (pid reuse and resume are other leaders) */
export function leaderLive(team: Team, deps: TeamDeps): boolean {
  return instanceState(team.leader.pid, team.leader.procStart, deps) === 'same'
}

/**
 * ★ The team the caller leads, checked: the same session id **and** the same process instance.
 * ⚠️ A team whose leader is gone is reported with the team (`ended`): the caller ends it with `endTeam`, which also
 *    rings its held approvals. ⚠️ Not deleted here (deleting first left `endTeam` nothing to ring / codex review, medium #1).
 */
export function teamLedBy(
  sessionId: string,
  pid: number | undefined,
  deps: TeamDeps,
): { ok: true; team: Team } | { ok: false; reason: 'no-team' | 'not-this-leader' | 'leader-gone'; ended?: Team } {
  const team = [...teams.values()].find((t) => t.leader.sessionId === sessionId)
  if (!team) return { ok: false, reason: 'no-team' }
  const state = instanceState(team.leader.pid, team.leader.procStart, deps)
  // ⚠️ Ended only when confirmed gone; unknown ⇒ refused now, the team kept (r9 medium #1)
  if (state === 'gone') return { ok: false, reason: 'leader-gone', ended: team }
  if (state === 'unknown') return { ok: false, reason: 'not-this-leader' }
  // ⚠️ The CLI names the leader process it runs under; another process using the same session id is not the leader
  if (pid !== undefined && pid !== team.leader.pid) return { ok: false, reason: 'not-this-leader' }
  return { ok: true, team }
}

export function teamById(id: string): Team | undefined {
  return teams.get(id)
}

/** The team a session is a member of, and its member record */
export function membershipOf(sessionId: string | undefined): { team: Team; member: TeamMember } | undefined {
  if (!sessionId) return undefined
  for (const team of teams.values()) {
    const member = team.members.find((m) => m.sessionId === sessionId)
    if (member) return { team, member }
  }
  return undefined
}

export function teamLeadBySession(sessionId: string | undefined): Team | undefined {
  if (!sessionId) return undefined
  return [...teams.values()].find((t) => t.leader.sessionId === sessionId)
}

/** Find a member by its short name or a unique prefix of its session id */
export function findMember(team: Team, ref: string): TeamMember | undefined | 'ambiguous' {
  const byName = team.members.find((m) => m.name === ref)
  if (byName) return byName
  if (ref.length < 4) return undefined
  const hits = team.members.filter((m) => m.sessionId.startsWith(ref))
  if (hits.length > 1) return 'ambiguous'
  return hits[0]
}

export function disbandTeam(id: string): Team | undefined {
  const team = teams.get(id)
  if (!team) return undefined
  teams.delete(id)
  return team
}

/** Remove one member. The team ends with its last member. @returns what changed */
export function removeMember(sessionId: string): { team: Team; member: TeamMember; disbanded: boolean } | undefined {
  const found = membershipOf(sessionId)
  if (!found) return undefined
  found.team.members = found.team.members.filter((m) => m.sessionId !== sessionId)
  const disbanded = found.team.members.length === 0
  if (disbanded) teams.delete(found.team.id)
  return { ...found, disbanded }
}

/** Whether the members' approvals are delegated to the leader right now */
export function approvalsActive(team: Team, now = Date.now()): boolean {
  return team.approvals !== undefined && team.approvals.untilMs > now
}

/**
 * ★★ Whether this approval is one the team's leader may answer (`/team/approve`, and whether to hold the ring).
 *
 * All of these hold, or the human answers it:
 *   1. it belongs to a member of this team, and approvals are delegated and not expired
 *   2. it arrived after the grant (one that was already waiting stays with the person who saw it)
 *   3. not a plan approval (`ExitPlanMode` is the person's decision)
 *   4. a tool that needs a choice must carry its parsed choices (`interaction`): broken input never passes as a yes/no
 *      (both checks, as auto-approve does: `interaction` vanishes on broken input)
 */
export type DelegateRefusal =
  | 'not-member'
  | 'member-gone'
  | 'not-delegated'
  | 'expired'
  | 'before-grant'
  | 'plan'
  | 'broken-question'
  | 'clipped'
  /** a subagent card still in its quiet period */
  | 'quiet'

export function mayLeaderAnswer(
  team: Team,
  req: Pick<PermissionRequest, 'key' | 'sessionId' | 'toolName' | 'at' | 'interaction' | 'detailClipped' | 'tool' | 'account' | 'accountUnknown'>,
  now = Date.now(),
  /** ★ Whether the member is still the instance the team was made with (`memberLive`). Absent = not checked (tests) */
  live?: (m: TeamMember) => boolean,
): { ok: true; member: TeamMember } | { ok: false; reason: DelegateRefusal } {
  const member = team.members.find((m) => m.sessionId === req.sessionId)
  if (!member) return { ok: false, reason: 'not-member' }
  if (!cardFromMember(member, req)) return { ok: false, reason: 'not-member' }
  if (live && !live(member)) return { ok: false, reason: 'member-gone' }
  if (!team.approvals) return { ok: false, reason: 'not-delegated' }
  if (team.approvals.untilMs <= now) return { ok: false, reason: 'expired' }
  const at = Date.parse(req.at)
  // ⚠️ Strictly after the grant, and not one of the keys that were waiting then (low #2: same millisecond)
  if (
    !Number.isFinite(at) ||
    at <= team.approvals.grantedAtMs ||
    team.approvals.preexisting.includes(req.key) ||
    (req.sessionId !== undefined && team.approvals.waitingAtGrant.includes(req.sessionId))
  ) {
    return { ok: false, reason: 'before-grant' }
  }
  if (req.toolName === 'ExitPlanMode' || req.interaction?.kind === 'plan') return { ok: false, reason: 'plan' }
  if (requiresInteraction(req.toolName) && !req.interaction) return { ok: false, reason: 'broken-question' }
  // ⚠️⚠️ A command too long to show whole (the card and `nyan team pending` carry only its head): the leader would
  //    approve what it has not read (codex review, high #3) ⇒ the human answers it
  if (req.detailClipped) return { ok: false, reason: 'clipped' }
  return { ok: true, member }
}

/**
 * ⚠️⚠️ Whether a card comes from the member's own tool and profile (codex review r5, high #1): the same session id in
 *    another profile — one the agent does not even watch — is not this member. An unknown profile stays with the human.
 *    (The profile **directory** is checked by `teamHooks.ts` `ownsCard`, which has the card's transcript.)
 */
export function cardFromMember(member: TeamMember, req: Pick<PermissionRequest, 'tool' | 'account' | 'accountUnknown'>): boolean {
  if (member.tool === 'codex') return req.tool === 'codex'
  // ★ agy: its cards carry `tool: 'agy'` and the conversation's row id (which agy process: `teamHooks.ts` `memberIdentity`)
  if (member.tool === 'agy') return req.tool === 'agy'
  return req.tool !== 'codex' && req.tool !== 'agy' && !req.accountUnknown && req.account === member.account
}

/** ★ A Claude or agy member is the instance the team was made with (pid + start time). Codex members: see `sweepTeams` */
export function memberLive(m: TeamMember, deps: TeamDeps): boolean {
  if (m.pid === undefined || m.procStart === undefined) return true
  return instanceState(m.pid, m.procStart, deps) === 'same'
}

/** A Claude or agy member's process confirmed gone (only this removes it; unknown keeps it) */
export function memberGone(m: TeamMember, deps: TeamDeps): boolean {
  if (m.pid === undefined || m.procStart === undefined) return false
  return instanceState(m.pid, m.procStart, deps) === 'gone'
}

/**
 * ★★ Reconcile every team with what is alive (a timer, and before answering / codex review, high #1 · medium #1):
 *   a leader whose process is gone ends its team; a Claude member whose instance is gone, or a Codex member the daemon
 *   no longer serves, leaves it. Hooks can be missed (killed processes, the agent off when they ended).
 * @param codexLive the live Codex row ids now, or undefined when they cannot be known (then Codex members are kept)
 * @returns what to act on (the caller rings, tells the leader and logs)
 */
export function sweepTeams(deps: TeamDeps, codexLive: ReadonlySet<string> | undefined): { deadLeaders: Team[]; gone: string[] } {
  const deadLeaders: Team[] = []
  const gone: string[] = []
  for (const team of teams.values()) {
    // ⚠️ Only a confirmed exit ends a team or removes a member (unknown is retried next round / r9 medium #1)
    if (instanceState(team.leader.pid, team.leader.procStart, deps) === 'gone') {
      deadLeaders.push(team)
      continue
    }
    for (const m of team.members) {
      const isGone = m.tool === 'codex' ? (codexLive ? !codexLive.has(m.sessionId) : false) : memberGone(m, deps)
      if (isGone) gone.push(m.sessionId)
    }
  }
  return { deadLeaders, gone }
}

/** Who answered, for the journal: the team and the leader (Claude ids print 8 characters, Codex ids their full home part) */
export function teamActor(team: Team): string {
  return `team:${team.id}/${shortSessionId(team.leader.sessionId)}`
}

// ─── Expiry ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * End delegations whose time is up (called from a timer).
 * @returns the teams whose delegation just ended (the caller tells the leader)
 */
export function expireApprovals(now = Date.now()): Team[] {
  const ended: Team[] = []
  for (const team of teams.values()) {
    if (team.approvals && team.approvals.untilMs <= now) {
      team.approvals = undefined
      ended.push(team)
    }
  }
  return ended
}

/** ★ A member that was waiting at the grant is seen not waiting any more: its later cards may be the leader's */
export function clearWaitingAtGrant(team: Team, sessionId: string): void {
  if (!team.approvals) return
  team.approvals.waitingAtGrant = team.approvals.waitingAtGrant.filter((id) => id !== sessionId)
  team.approvals.cardlessAtGrant = team.approvals.cardlessAtGrant.filter((id) => id !== sessionId)
}

/**
 * ★ A request that was waiting at a grant is over (answered — not merely re-entered or withdrawn): it no longer keeps
 *   a fresh request with the same fingerprint human-only (r12 medium #1). Called from `permission.ts`.
 */
export function retirePreexisting(origin: string): void {
  for (const team of teams.values()) {
    if (team.approvals?.preexisting.includes(origin)) team.approvals.preexisting = team.approvals.preexisting.filter((o) => o !== origin)
  }
}
