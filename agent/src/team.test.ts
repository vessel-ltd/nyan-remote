import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { PermissionRequest } from '../../shared/types.ts'
import {
  approvalsActive,
  clearWaitingAtGrant,
  createTeam,
  expireApprovals,
  findMember,
  MAX_TEAM_MEMBERS,
  mayLeaderAnswer,
  membershipOf,
  removeMember,
  resetTeamsForTest,
  teamActor,
  teamLedBy,
  TEAM_APPROVAL_DURATIONS,
  memberLive,
  sweepTeams,
  type TeamDeps,
} from './team.ts'

afterEach(() => {
  resetTeamsForTest()
})

const LEADER = { sessionId: 'lead-1', account: '.claude-r', pid: 4242, procStart: 'start-A' }
const m = (sessionId: string, tool: 'claude' | 'codex' = 'claude') => ({ sessionId, tool, account: '.claude-s' })
const alive = (start: string | null = 'start-A'): TeamDeps => ({ procStart: () => start, sameProcStart: (a, b) => a === b })

type Req = Pick<PermissionRequest, 'key' | 'sessionId' | 'toolName' | 'at' | 'interaction' | 'detailClipped' | 'tool' | 'account' | 'accountUnknown'>
function req(over: Partial<PermissionRequest> = {}): Req {
  return { key: 'k#1', sessionId: 'a', account: '.claude-s', toolName: 'Bash', at: new Date(2000).toISOString(), ...over }
}

test('★ create: names members m1…, refuses empty, too many, duplicates and self', () => {
  const r = createTeam(LEADER, [m('a'), m('b', 'codex')], undefined, 1000)
  assert.ok(r.ok)
  assert.deepEqual(r.team.members.map((x) => [x.name, x.sessionId, x.tool]), [['m1', 'a', 'claude'], ['m2', 'b', 'codex']])
  assert.equal(r.team.approvals, undefined)
  resetTeamsForTest()
  assert.deepEqual(createTeam(LEADER, [], undefined), { ok: false, reason: 'no-members' })
  const many = Array.from({ length: MAX_TEAM_MEMBERS + 1 }, (_, i) => m(`s${i}`))
  assert.equal((createTeam(LEADER, many, undefined) as { reason: string }).reason, 'too-many')
  assert.equal((createTeam(LEADER, [m('a'), m('a')], undefined) as { reason: string }).reason, 'duplicate-member')
  assert.equal((createTeam(LEADER, [m('lead-1')], undefined) as { reason: string }).reason, 'leader-is-member')
})

test('★★ create: no chains — one team per member, a leader is never a member, a member never leads', () => {
  assert.ok(createTeam(LEADER, [m('a')], undefined).ok)
  assert.equal((createTeam(LEADER, [m('b')], undefined) as { reason: string }).reason, 'already-leading')
  assert.equal((createTeam({ ...LEADER, sessionId: 'lead-2' }, [m('a')], undefined) as { reason: string }).reason, 'member-in-team')
  assert.equal((createTeam({ ...LEADER, sessionId: 'lead-2' }, [m('lead-1')], undefined) as { reason: string }).reason, 'member-is-leader')
  assert.equal((createTeam({ ...LEADER, sessionId: 'a' }, [m('c')], undefined) as { reason: string }).reason, 'leader-in-team')
})

test('★ create: the approvals duration is a name from the table; an unknown name is refused (never 3h by default)', () => {
  const r = createTeam(LEADER, [m('a')], '24h', 1000)
  assert.ok(r.ok)
  assert.deepEqual(r.team.approvals, { duration: '24h', grantedAtMs: 1000, untilMs: 1000 + TEAM_APPROVAL_DURATIONS['24h'], preexisting: [], waitingAtGrant: [], cardlessAtGrant: [] })
  resetTeamsForTest()
  assert.equal((createTeam(LEADER, [m('a')], '999h') as { reason: string }).reason, 'bad-duration')
  assert.equal((createTeam(LEADER, [m('a')], 'toString') as { reason: string }).reason, 'bad-duration')
})

test('★★ the leader is its process instance: another start time (resume / pid reuse) ends the team; another pid is refused', () => {
  createTeam(LEADER, [m('a')], '3h')
  assert.ok(teamLedBy('lead-1', 4242, alive()).ok)
  assert.equal((teamLedBy('lead-1', 9999, alive()) as { reason: string }).reason, 'not-this-leader')
  assert.equal((teamLedBy('other', 4242, alive()) as { reason: string }).reason, 'no-team')
  const gone = teamLedBy('lead-1', 4242, alive('start-B'))
  assert.equal((gone as { reason: string }).reason, 'leader-gone')
  // ⚠️ handed back to the caller to end (so its held approvals ring), not silently deleted here
  assert.ok((gone as { ended?: unknown }).ended)
  assert.equal((teamLedBy('lead-1', 4242, alive(null)) as { reason: string }).reason, 'leader-gone')
})

test('★★★ mayLeaderAnswer: member, delegated, not expired, after the grant, not a plan, not a broken question', () => {
  const r = createTeam(LEADER, [m('a')], '3h', 1000)
  assert.ok(r.ok)
  const team = r.team
  assert.ok(mayLeaderAnswer(team, req(), 2000).ok)
  assert.equal((mayLeaderAnswer(team, req({ sessionId: 'zz' }), 2000) as { reason: string }).reason, 'not-member')
  // ⚠️⚠️ the same id from another profile, an unknown profile, or another tool is not this member (r5 high #1)
  assert.equal((mayLeaderAnswer(team, req({ account: '.claude-b' }), 2000) as { reason: string }).reason, 'not-member')
  assert.equal((mayLeaderAnswer(team, req({ accountUnknown: true }), 2000) as { reason: string }).reason, 'not-member')
  assert.equal((mayLeaderAnswer(team, req({ tool: 'codex' }), 2000) as { reason: string }).reason, 'not-member')
  assert.equal((mayLeaderAnswer(team, req({ at: new Date(999).toISOString() }), 2000) as { reason: string }).reason, 'before-grant')
  // ⚠️ the grant's own millisecond is not "after" (low #2)
  assert.equal((mayLeaderAnswer(team, req({ at: new Date(1000).toISOString() }), 2000) as { reason: string }).reason, 'before-grant')
  // ⚠️⚠️ a command too long to show whole stays with the human (high #3)
  assert.equal((mayLeaderAnswer(team, req({ detailClipped: true }), 2000) as { reason: string }).reason, 'clipped')
  // ⚠️⚠️ a member that is not the instance the team was made with (high #1)
  assert.equal((mayLeaderAnswer(team, req(), 2000, () => false) as { reason: string }).reason, 'member-gone')
  assert.equal((mayLeaderAnswer(team, req({ at: 'garbage' }), 2000) as { reason: string }).reason, 'before-grant')
  assert.equal((mayLeaderAnswer(team, req(), 1000 + TEAM_APPROVAL_DURATIONS['3h']) as { reason: string }).reason, 'expired')
  assert.equal((mayLeaderAnswer(team, req({ toolName: 'ExitPlanMode' }), 2000) as { reason: string }).reason, 'plan')
  assert.equal((mayLeaderAnswer(team, req({ toolName: 'X', interaction: { kind: 'plan' } }), 2000) as { reason: string }).reason, 'plan')
  // ⚠️ AskUserQuestion whose input could not be parsed has no `interaction`: never answered as a yes/no
  assert.equal((mayLeaderAnswer(team, req({ toolName: 'AskUserQuestion' }), 2000) as { reason: string }).reason, 'broken-question')
  const q = { kind: 'question' as const, questions: [{ question: 'Q?', multiSelect: false, options: [{ label: 'A' }] }] }
  assert.ok(mayLeaderAnswer(team, req({ toolName: 'AskUserQuestion', interaction: q }), 2000).ok)
  resetTeamsForTest()
  const plain = createTeam(LEADER, [m('a')], undefined, 1000)
  assert.ok(plain.ok)
  assert.equal((mayLeaderAnswer(plain.team, req(), 2000) as { reason: string }).reason, 'not-delegated')
})

test('★ findMember: by name, by a unique id prefix (4+), ambiguous prefixes refused', () => {
  const r = createTeam(LEADER, [m('abcd-1'), m('abcd-2'), m('ffff-1')], undefined)
  assert.ok(r.ok)
  assert.equal((findMember(r.team, 'm2') as { sessionId: string }).sessionId, 'abcd-2')
  assert.equal((findMember(r.team, 'ffff') as { sessionId: string }).sessionId, 'ffff-1')
  assert.equal(findMember(r.team, 'abcd'), 'ambiguous')
  assert.equal(findMember(r.team, 'ff'), undefined)
})

test('★ removing the last member ends the team', () => {
  createTeam(LEADER, [m('a'), m('b')], undefined)
  assert.equal(removeMember('a')?.disbanded, false)
  assert.equal(removeMember('b')?.disbanded, true)
  assert.equal(membershipOf('b'), undefined)
  assert.equal(removeMember('nobody'), undefined)
})

test('★★ expiry ends the delegation', () => {
  const r = createTeam(LEADER, [m('a')], '3h', 1000)
  assert.ok(r.ok)
  assert.deepEqual(expireApprovals(2000), [])
  assert.ok(approvalsActive(r.team, 2000))
  const ended = expireApprovals(1000 + TEAM_APPROVAL_DURATIONS['3h'])
  assert.equal(ended.length, 1)
  assert.equal(r.team.approvals, undefined)
})

test('the journal names the team and the leader (a Codex id prints its home part, not 8 shared characters)', () => {
  const r = createTeam(LEADER, [m('a')], undefined)
  assert.ok(r.ok)
  assert.match(teamActor(r.team), /^team:[0-9a-f]{8}\/lead-1$/)
})

test('★ approvals already waiting at the grant stay with the human, whatever their timestamp', () => {
  const r = createTeam(LEADER, [m('a')], '3h', 1000, ['k#old'])
  assert.ok(r.ok)
  assert.equal((mayLeaderAnswer(r.team, req({ key: 'k#old' }), 2000) as { reason: string }).reason, 'before-grant')
  assert.ok(mayLeaderAnswer(r.team, req({ key: 'k#new' }), 2000).ok)
})

test('★★ sweep: a dead leader, a Claude member that is another instance, a Codex member the daemon no longer serves', () => {
  createTeam(LEADER, [{ ...m('a'), pid: 7, procStart: 'P7' }, m('cx', 'codex'), m('b')], undefined)
  const deps: TeamDeps = { procStart: (pid) => (pid === 4242 ? 'start-A' : pid === 7 ? 'P7-resumed' : null), sameProcStart: (x, y) => x === y }
  assert.deepEqual(sweepTeams(deps, new Set(['cx'])), { deadLeaders: [], gone: ['a'] })
  assert.deepEqual(sweepTeams(deps, new Set()), { deadLeaders: [], gone: ['a', 'cx'] })
  // the daemon state unknown (reconnecting): Codex members are kept
  assert.deepEqual(sweepTeams(deps, undefined).gone, ['a'])
  const dead = sweepTeams({ ...deps, procStart: () => null }, undefined)
  assert.equal(dead.deadLeaders.length, 1)
  assert.equal(memberLive({ name: 'm9', sessionId: 'z', tool: 'claude', account: '' }, deps), true)
})

test('★★ a member waiting at the grant keeps its cards with the human until that wait is seen to end (r4 high #4)', () => {
  const r = createTeam(LEADER, [m('a', 'codex'), m('b', 'codex')], '3h', 1000, [], ['a'])
  assert.ok(r.ok)
  assert.equal((mayLeaderAnswer(r.team, req({ sessionId: 'a', tool: 'codex' }), 2000) as { reason: string }).reason, 'before-grant')
  assert.ok(mayLeaderAnswer(r.team, req({ sessionId: 'b', tool: 'codex' }), 2000).ok)
  clearWaitingAtGrant(r.team, 'a')
  assert.ok(mayLeaderAnswer(r.team, req({ sessionId: 'a', tool: 'codex' }), 2000).ok)
})
