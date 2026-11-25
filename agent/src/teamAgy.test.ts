// ★★ agy members of a team (2026-11-22 / docs/TEAM.md §9): who the member is now, its waits, its turn-end report.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, test } from 'node:test'
import { statusLabel, type PermissionRequest } from '../../shared/types.ts'
import { aliveProcStartFreshSync } from './claude/sessionIndex.ts'
import { createTeam, resetTeamsForTest } from './team.ts'
import { untilNextSecondMs } from './routes/team.ts'
import { answer, resetPending, waitForDecision } from './permission.ts'
import { agyCardsChanged, codexCardsChanged, agyInstructionSent, agyLastWords, agyPhoneFallback, agyPhoneMayRing, agyMemberDone, agyStateNow, agyTeamSafetyNet, agyTeamPcWaits, resetAgyReportedForTest, AGY_NET_GRACE_MS, AGY_PC_WAIT_MS, AGY_NET_NOT_STARTED_MS, leaderMay, memberIdentity, cardRef, soleProcessSync, type AgyDoneDeps, type AgyNetDeps } from './teamHooks.ts'

const root = mkdtempSync(join(tmpdir(), 'nr-team-agy-'))
const prevState = process.env['NYAN_REMOTE_STATE_DIR']
process.env['NYAN_REMOTE_STATE_DIR'] = root
mkdirSync(join(root, 'agy'), { recursive: true })
after(() => {
  if (prevState === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
  else process.env['NYAN_REMOTE_STATE_DIR'] = prevState
  rmSync(root, { recursive: true, force: true })
})
afterEach(() => {
  resetTeamsForTest()
  resetAgyReportedForTest()
})

const ME = process.pid
const START = String(aliveProcStartFreshSync(ME))
const CONV = '0f0e0d0c-0b0a-4909-8807-060504030201'
const OTHER = '11111111-2222-4333-8444-555555555555'
const AGY = `agy-${CONV}`
const LEADER_DIR = join(root, '.claude-r')
mkdirSync(join(LEADER_DIR, 'sessions'), { recursive: true })
writeFileSync(join(LEADER_DIR, 'sessions', `${ME}.json`), JSON.stringify({ pid: ME, sessionId: 'lead-x' }))
const LEADER = { sessionId: 'lead-x', account: '.claude-r', configDir: LEADER_DIR, pid: ME, procStart: START }
const member = { sessionId: AGY, tool: 'agy' as const, account: 'agy', pid: ME, procStart: START }

/** This agy's own state file (`pid-<pid>.json`), as the status line writes it */
function ownState(conv: string, over: Record<string, unknown> = {}): void {
  writeFileSync(
    join(root, 'agy', `pid-${ME}.json`),
    JSON.stringify({ nyanPid: ME, nyanBusyAt: 1, input: { conversation_id: conv, cwd: '/home/user/p', agent_state: 'idle', ...over } }),
  )
}

test('★ an agy member is its process while its own state names the conversation; another conversation is not it', () => {
  ownState(CONV)
  assert.ok(agyStateNow(member))
  assert.equal(soleProcessSync({ ...member, name: 'm1' }), true)
  ownState(OTHER)
  assert.equal(agyStateNow(member), undefined)
  assert.equal(soleProcessSync({ ...member, name: 'm1' }), false, 'moved to another conversation (a resume on the PC)')
  assert.equal(soleProcessSync({ ...member, name: 'm1', procStart: 'another-start' }), false, 'another process with the pid')
})

test('★ the last words: the final answer of a turn that ended answered; none when it ended on a call', () => {
  const tail = (recs: Record<string, unknown>[]) => () => recs
  const prompt = { type: 'USER_INPUT', step_index: 3, created_at: new Date(1000).toISOString() }
  assert.deepEqual(agyLastWords(AGY, tail([prompt, { type: 'PLANNER_RESPONSE', step_index: 4, content: '  Done: 3 files  ' }])), { text: 'Done: 3 files', answered: true, turn: 3, turnAt: 1000 })
  assert.deepEqual(agyLastWords(AGY, tail([prompt, { type: 'PLANNER_RESPONSE', step_index: 4, tool_calls: [{ name: 'run_command', args: {} }] }])), { text: undefined, answered: false, turn: 3, turnAt: 1000 })
  assert.equal(agyLastWords(AGY, tail([])), undefined, 'nothing read')
  assert.equal(agyLastWords('not-agy', tail([prompt])), undefined)
})

test('★★ a member\'s "done" goes to the leader; the phone rings (and is retried) when that does not get through', async () => {
  ownState(CONV)
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const done = statusLabel('done') as string
  let pushes = 0
  const push = async (): Promise<number> => (pushes++, 0)
  const told: string[] = []
  const deps = (over: Partial<AgyDoneDeps> = {}): AgyDoneDeps => ({
    locks: async () => [CONV],
    lastWords: () => ({ text: 'Sun Nov 22' }),
    tell: async (_t, text) => (told.push(text), true),
    ...over,
  })
  // other words, or not a member: the caller pushes as usual
  assert.equal(await agyMemberDone({ sessionId: AGY }, statusLabel('error') as string, push, deps()), undefined)
  assert.equal(await agyMemberDone({ sessionId: `agy-${OTHER}` }, done, push, deps()), undefined)
  // ★ told the leader with its last words: handled (1), no ring
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, push, deps()), 1)
  assert.equal(pushes, 0)
  assert.match(told[0]!, /m1[（ (]agy[）)][\s\S]*Sun Nov 22/)
  // ★ the leader not reached: the phone's own count comes back (0 ⇒ the notifier tries again)
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, push, deps({ tell: async () => false })), 0)
  assert.equal(pushes, 1)
  // the words unreadable: the leader is told so (and no retry tells it twice / codex review)
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, async () => 3, deps({ lastWords: () => undefined })), 1)
  assert.match(told.at(-1)!, /could not be read|読めませんでした/)
  // ⚠️⚠️ the recorded agy no longer holds the conversation (a `/new` on the PC; a second agy resumed it): not the member's
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, push, deps({ locks: async () => [OTHER] })), undefined)
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, push, deps({ locks: async () => undefined })), undefined)
  // the agy's own state moved to another conversation
  ownState(OTHER)
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, push, deps()), undefined)
})

test('★★ an agy card is judged by the call\'s own time: a call made before the grant stays with the human (codex review)', () => {
  ownState(CONV)
  const grant = Date.now()
  const r = createTeam(LEADER, [member], '3h', grant)
  assert.ok(r.ok)
  const card = (key: string, origin: string): PermissionRequest => ({
    key, origin, machine: 'pc-a', account: 'agy', project: 'p', sessionId: AGY, tool: 'agy', toolName: 'Bash', summary: 'date', at: new Date(grant + 5000).toISOString(),
  })
  const before = card('agy:b#1', 'agy:b')
  void waitForDecision(before, () => {}, { toolInput: { command: 'date' }, requestedAt: grant - 200, agyPid: ME })
  assert.equal((leaderMay(r.team, before) as { reason?: string }).reason, 'before-grant')
  const unknown = card('agy:u#1', 'agy:u')
  void waitForDecision(unknown, () => {}, { toolInput: { command: 'date' }, agyPid: ME })
  assert.equal((leaderMay(r.team, unknown) as { reason?: string }).reason, 'before-grant', 'no call time ⇒ the human')
  const after = card('agy:a#1', 'agy:a')
  void waitForDecision(after, () => {}, { toolInput: { command: 'date' }, requestedAt: grant + 100, agyPid: ME })
  assert.ok(leaderMay(r.team, after).ok)
  // ⚠️⚠️ a card another agy process raised on the same conversation (it resumed it) is not the member's (codex review)
  const stranger = card('agy:s#1', 'agy:s')
  void waitForDecision(stranger, () => {}, { toolInput: { command: 'date' }, requestedAt: grant + 100, agyPid: ME + 1 })
  assert.equal((leaderMay(r.team, stranger) as { reason?: string }).reason, 'not-member')
  resetPending()
})

test('★★ an agy card raised again with a new key (a state rewrite) is announced to the leader once (measured 2026-11-22)', async () => {
  ownState(CONV)
  const r = createTeam(LEADER, [member], '3h', Date.now() - 1000)
  assert.ok(r.ok)
  const told: string[] = []
  const deps = { tell: async (_t: unknown, text: string) => (told.push(text), true), unique: async () => true }
  const card = (key: string): PermissionRequest => ({
    key,
    origin: 'agy:same-call',
    machine: 'pc-a',
    account: 'agy',
    project: 'p',
    sessionId: AGY,
    tool: 'agy',
    toolName: 'Bash',
    summary: 'date',
    at: new Date().toISOString(),
  })
  void waitForDecision(card('agy:first#1'), () => {}, { toolInput: { command: 'date' }, requestedAt: Date.now(), agyPid: ME })
  agyCardsChanged(deps)
  void waitForDecision(card('agy:second#1'), () => {}, { toolInput: { command: 'date' }, requestedAt: Date.now(), agyPid: ME })
  agyCardsChanged(deps)
  await new Promise((res) => setTimeout(res, 30))
  assert.equal(told.length, 1)
  assert.match(told[0]!, /m1 \(agy\)|m1（agy）/)
  // ★ a notice that did not get through is tried again on the next change (agy review)
  const failing = { tell: async () => false, unique: async () => true }
  void waitForDecision({ ...card('agy:third#1'), origin: 'agy:other-call', subagent: {} }, () => {}, { toolInput: { command: 'date' }, requestedAt: Date.now(), agyPid: ME })
  agyCardsChanged(failing)
  await new Promise((res) => setTimeout(res, 30))
  agyCardsChanged(deps)
  await new Promise((res) => setTimeout(res, 30))
  assert.equal(told.length, 2)
  // ★ a subagent's card says so (the phone's card does; the leader could not tell / 2026-11-23)
  assert.doesNotMatch(told[0]!.split('\n')[0]!, /subagent|サブエージェント/)
  assert.match(told[1]!.split('\n')[0]!, /from a subagent|サブエージェントから/)
  resetPending()
})

test('★★ an agy that no longer holds the conversation\'s lock (a `/new` on the PC) is confirmed replaced, though its state file still names it', async () => {
  ownState(CONV)
  // this test process holds no agy lock at all: a probe that works and lacks the conversation
  assert.equal(await memberIdentity({ ...member, name: 'm1' }), 'replaced')
})

test('★★ a card withdrawn for a while and raised again is not announced again; once answered, it is (codex review)', async () => {
  ownState(CONV)
  const r = createTeam(LEADER, [member], '3h', Date.now() - 1000)
  assert.ok(r.ok)
  const told: string[] = []
  const deps = { tell: async (_t: unknown, text: string) => (told.push(text), true), unique: async () => true }
  const raise = (key: string): { withdraw?: () => void } => {
    const h: { withdraw?: () => void } = {}
    const info: PermissionRequest = { key, origin: 'agy:child-question', machine: 'pc-a', account: 'agy', project: 'p', sessionId: AGY, tool: 'agy', toolName: 'Bash', summary: 'date', at: new Date().toISOString() }
    void waitForDecision(info, (w) => (h.withdraw = w), { toolInput: { command: 'date' }, requestedAt: Date.now(), agyPid: ME })
    agyCardsChanged(deps)
    return h
  }
  const tick = () => new Promise((res) => setTimeout(res, 30))
  const first = raise('agy:q1#1')
  await tick()
  first.withdraw?.()
  agyCardsChanged(deps)
  raise('agy:q1#2')
  await tick()
  assert.equal(told.length, 1, 'withdrawn and back: told once')
  // answered (its key did not land, it comes back): the leader is told again
  assert.equal(answer('agy:q1#2', 'allow'), true)
  raise('agy:q1#3')
  await tick()
  assert.equal(told.length, 2)
  resetPending()
})

test('★★ the turn-end report carries this turn\'s words, read before the lock probe (codex review)', async () => {
  ownState(CONV)
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  let words = 'turn A'
  const told: string[] = []
  const got = await agyMemberDone({ sessionId: AGY }, statusLabel('done') as string, async () => 0, {
    // the next turn finishes while the lock is being probed
    locks: async () => ((words = 'turn B'), [CONV]),
    lastWords: () => ({ text: words }),
    tell: async (_t, text) => (told.push(text), true),
  })
  assert.equal(got, 1)
  assert.match(told[0]!, /turn A/)
  assert.doesNotMatch(told[0]!, /turn B/)
})

test('★★ a card re-keyed while the leader is being told is told again with its current ref (codex review)', async () => {
  ownState(CONV)
  const r = createTeam(LEADER, [member], '3h', Date.now() - 1000)
  assert.ok(r.ok)
  const raise = (key: string): { withdraw?: () => void } => {
    const h: { withdraw?: () => void } = {}
    const info: PermissionRequest = { key, origin: 'agy:rekeyed', machine: 'pc-a', account: 'agy', project: 'p', sessionId: AGY, tool: 'agy', toolName: 'Bash', summary: 'date', at: new Date().toISOString() }
    void waitForDecision(info, (w) => (h.withdraw = w), { toolInput: { command: 'date' }, requestedAt: Date.now(), agyPid: ME })
    return h
  }
  const first = raise('agy:k1#1')
  const told: string[] = []
  let calls = 0
  agyCardsChanged({
    unique: async () => true,
    tell: async (_t, text, guard) => {
      calls++
      if (calls === 1) {
        // agy rewrites its state while the inbox is being opened: the card comes back under a new key
        first.withdraw?.()
        raise('agy:k2#1')
      }
      if (guard && !guard()) return false
      told.push(text)
      return true
    },
  })
  await new Promise((res) => setTimeout(res, 30))
  assert.equal(told.length, 1)
  // ★ the ref is the call's (its origin), the same under either key: the leader's answer finds the card that waits now
  assert.ok(told[0]!.includes(cardRef({ key: 'agy:k2#1', origin: 'agy:rekeyed', tool: 'agy' })))
  assert.equal(cardRef({ key: 'agy:k1#1', origin: 'agy:rekeyed', tool: 'agy' }), cardRef({ key: 'agy:k2#1', origin: 'agy:rekeyed', tool: 'agy' }))
  resetPending()
})

test('★ a completion that is no longer the conversation\'s state is not reported to the leader (codex review)', async () => {
  ownState(CONV)
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const told: string[] = []
  const got = await agyMemberDone({ sessionId: AGY }, statusLabel('done') as string, async () => 0, {
    locks: async () => [CONV],
    lastWords: () => ({ text: 'turn B' }),
    tell: async (_t, text) => (told.push(text), true),
  }, () => false)
  assert.equal(got, undefined)
  assert.equal(told.length, 0)
})

test('★ an announcement that lost its mark (answered meanwhile, raised again) stops; the newer one tells (codex review)', async () => {
  ownState(CONV)
  const r = createTeam(LEADER, [member], '3h', Date.now() - 1000)
  assert.ok(r.ok)
  const raise = (key: string): void => {
    const info: PermissionRequest = { key, origin: 'agy:again', machine: 'pc-a', account: 'agy', project: 'p', sessionId: AGY, tool: 'agy', toolName: 'Bash', summary: 'date', at: new Date().toISOString() }
    void waitForDecision(info, () => {}, { toolInput: { command: 'date' }, requestedAt: Date.now(), agyPid: ME })
  }
  raise('agy:a1#1')
  const told: string[] = []
  let calls = 0
  const tell = async (_t: unknown, text: string, guard?: () => boolean): Promise<boolean> => {
    calls++
    if (calls === 1) {
      // answered while the first notice is being written; its key did not land, so it is raised again
      answer('agy:a1#1', 'allow')
      raise('agy:a1#2')
      agyCardsChanged({ unique: async () => true, tell: async (_x, t2) => (told.push(t2), true) })
      return false
    }
    if (guard && !guard()) return false
    told.push(text)
    return true
  }
  agyCardsChanged({ unique: async () => true, tell })
  await new Promise((res) => setTimeout(res, 40))
  assert.equal(told.length, 1, 'told once for the returned card')
  assert.equal(calls, 1, 'the old attempt did not try again')
  resetPending()
})

test('★ a team with agy members and approvals replies once the next whole second has begun (agy stamps calls to the second / measured)', () => {
  const grant = 1_763_859_613_421 // …:53.421
  const replyAt = grant + untilNextSecondMs(grant)
  assert.ok(replyAt >= Math.ceil(grant / 1000) * 1000, 'after the grant\'s second')
  // a call the leader starts after the reply is stamped with a later second than the grant: judged after it
  assert.ok(Math.floor(replyAt / 1000) * 1000 > grant)
  assert.ok(untilNextSecondMs(grant) <= 1020)
})

test('★★ Codex: two approvals of one item (one origin) are each announced — tracked by their exact keys (codex · agy review round 13)', async () => {
  const r = createTeam(LEADER, [{ sessionId: 'codex-0123456789abcdef-t1', tool: 'codex', account: '.codex' }], '3h', Date.now() - 1000)
  assert.ok(r.ok)
  const told: string[] = []
  const deps = { tell: async (_t: unknown, text: string) => (told.push(text), true), unique: async () => true }
  const raise = (key: string): void => {
    const info: PermissionRequest = { key, origin: 'codex:item-1', machine: 'pc-a', account: '.codex', project: 'p', sessionId: 'codex-0123456789abcdef-t1', tool: 'codex', toolName: 'Bash', summary: 'ls', at: new Date().toISOString() }
    void waitForDecision(info, () => {}, { toolInput: { command: 'ls' } })
  }
  raise('cx-1#1')
  codexCardsChanged(deps)
  await new Promise((res) => setTimeout(res, 30))
  // ★ not told again on the next change while it still waits
  codexCardsChanged(deps)
  await new Promise((res) => setTimeout(res, 30))
  assert.equal(told.length, 1)
  // the first one answered on the PC; the second sub-approval of the same item comes up
  answer('cx-1#1', 'allow')
  codexCardsChanged(deps)
  raise('cx-2#1')
  codexCardsChanged(deps)
  await new Promise((res) => setTimeout(res, 30))
  assert.equal(told.length, 2)
  resetPending()
})

// ★★ The safety net (2026-11-24 / docs/TEAM.md §9.2): a turn the leader sent whose end was never reported
/** This agy's state file written `at` (ms), idle unless said */
function stateAt(at: number, over: Record<string, unknown> = {}): void {
  ownState(CONV, over)
  utimesSync(join(root, 'agy', `pid-${ME}.json`), at / 1000, at / 1000)
}
/** A prompt: the leader's instruction (framed as `teamSend` does) unless `pc` */
const userInput = (step: number, at: number, pc = false): Record<string, unknown> => ({
  type: 'USER_INPUT',
  step_index: step,
  created_at: new Date(at).toISOString(),
  content: pc ? '<USER_REQUEST>\nhello from the PC' : '<USER_REQUEST>\n[nyan-team] Instruction from the team lead (lead-x):\ndo it\n\n(When done, sum up the result in the last message of this turn; the lead reads it.)\n</USER_REQUEST>',
})
const said = (step: number, text: string): Record<string, unknown> => ({ type: 'PLANNER_RESPONSE', step_index: step, content: text })
/** The turn starts a subagent (its launch and its result) */
const launch = (step: number): Record<string, unknown>[] => [
  { type: 'PLANNER_RESPONSE', step_index: step, tool_calls: [{ name: 'invoke_subagent', args: { Prompt: 'check' } }] },
  { type: 'GENERIC', step_index: step + 1, content: 'Created the following subagent' },
]
const call = (step: number): Record<string, unknown> => ({ type: 'PLANNER_RESPONSE', step_index: step, tool_calls: [{ name: 'run_command', args: { CommandLine: 'echo x' } }] })

/** The net's deps reading a rig (the same as `netRig`'s) */
function rigDeps(rig: ReturnType<typeof netRig>['rig']): AgyNetDeps {
  return {
    now: () => rig.clock,
    tail: () => rig.records,
    lastTurn: () => rig.lastTurn,
    transcriptMtime: () => rig.transcriptAt,
    transcriptSize: () => rig.transcriptSize,
    locks: async () => (rig.onLocks?.(), rig.locks),
    tell: async (_t, text, guard) => (rig.tellOk && (guard?.() ?? true) ? (rig.told.push(text), true) : false),
    waiting: () => rig.waiting,
    asking: () => false,
    questionWaitAt: () => rig.questionAt,
    questionCalls: () => rig.questionCalls,
    blockedWaits: () => rig.blocked,
    othersWrote: () => rig.others,
    childrenSettled: () => rig.settled,
  }
}

/** A rig: the transcript, its mtime, the clock and what the leader was told */
function netRig(records: Record<string, unknown>[], clock: number) {
  const rig = {
    records,
    clock,
    transcriptAt: 0,
    transcriptSize: 1000,
    waiting: false,
    others: false,
    settled: true,
    lastTurn: undefined as { turn: number; at: number } | undefined,
    tellOk: true,
    locks: [CONV],
    told: [] as string[],
    /** When the member's question wait began (undefined = none) */
    questionAt: undefined as number | undefined,
    /** The calls asking (undefined = unreadable: the time names the wait) */
    questionCalls: undefined as string[] | undefined,
    /** The subagents waiting on an approval on the PC, each with its start */
    blocked: [] as { since: number; id: number }[],
    /** Runs while the lock is probed (the PC acting meanwhile) */
    onLocks: undefined as (() => void) | undefined,
  }
  // ★ As `tellLeader`: its guard is asked right before the write
  const deps: AgyNetDeps = rigDeps(rig)
  /** Two looks `AGY_NET_GRACE_MS` apart */
  const looks = async (): Promise<void> => {
    await agyTeamSafetyNet(deps)
    rig.clock += AGY_NET_GRACE_MS
    await agyTeamSafetyNet(deps)
  }
  return { rig, deps, looks }
}

test('★★ safety net: a sent turn that ended unreported is told to the leader after the grace — once; the notifier\'s "done" for it then stays quiet', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const m = r.team.members[0]!
  const SENT = Date.now() - 60_000
  const TURN = SENT + 2000
  const { rig, deps, looks } = netRig([userInput(5, SENT - 30_000), said(6, 'old'), userInput(7, TURN), said(8, 'all 3 done')], TURN + 10_000)
  rig.transcriptAt = TURN + 4000
  stateAt(TURN + 5000)
  await looks()
  assert.equal(rig.told.length, 0, 'no instruction was sent')
  // ⚠️ the last turn before the send is step 7: nothing after it yet
  agyInstructionSent(m, SENT, { turn: 7, at: TURN })
  await looks()
  assert.equal(rig.told.length, 0, 'the turn before the send')
  agyInstructionSent(m, SENT, { turn: 5, at: SENT - 30_000 })
  // ★ ended, but not yet for the grace (the notifier speaks first when it works)
  await agyTeamSafetyNet(deps)
  rig.clock += AGY_NET_GRACE_MS - 1
  await agyTeamSafetyNet(deps)
  assert.equal(rig.told.length, 0, 'one ms short of the grace')
  rig.clock += 1
  await agyTeamSafetyNet(deps)
  assert.equal(rig.told.length, 1)
  assert.match(rig.told[0]!, /m1[（ (]agy[）)][\s\S]*all 3 done/)
  assert.doesNotMatch(rig.told[0]!, /\bold\b/)
  await looks()
  assert.equal(rig.told.length, 1, 'settled: never again')
  // ★ the notifier's late "done" for that turn: handled without telling (or ringing) twice
  let pushes = 0
  const done = await agyMemberDone({ sessionId: AGY }, statusLabel('done') as string, async () => (pushes++, 1), {
    locks: async () => [CONV],
    lastWords: () => ({ text: 'all 3 done', answered: true, answerAt: Infinity }),
    tell: async (_t, text) => (rig.told.push(text), true),
    turn: () => ({ turn: 7, at: TURN }),
  })
  assert.equal(done, 1)
  assert.equal(rig.told.length, 1)
  assert.equal(pushes, 0)
})

test('★★ safety net: a turn stopped without an answer (a declined card), an error, a stale state, a waiting card', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const m = r.team.members[0]!
  const SENT = Date.now() - 60_000
  const TURN = SENT + 1000
  // a declined command card: the call stays open, no card waits (measured 2026-11-24)
  const { rig, deps, looks } = netRig([userInput(9, TURN), call(10)], TURN + 30_000)
  agyInstructionSent(m, SENT, { turn: 8, at: SENT - 5000 })
  rig.transcriptAt = TURN + 2000
  // ⚠️ a state written before the send, or before the transcript's last write, is not its end
  stateAt(SENT - 1)
  await looks()
  stateAt(TURN + 1500)
  await looks()
  assert.equal(rig.told.length, 0, 'stale state')
  // ⚠️ a card waits (the leader or the human answers it first)
  stateAt(TURN + 3000)
  rig.waiting = true
  await looks()
  assert.equal(rig.told.length, 0, 'a card waits')
  rig.waiting = false
  // ⚠️ working again resets the time
  await agyTeamSafetyNet(deps)
  rig.clock += AGY_NET_GRACE_MS / 2
  stateAt(TURN + 3000, { agent_state: 'working' })
  await agyTeamSafetyNet(deps)
  stateAt(TURN + 4000)
  await agyTeamSafetyNet(deps)
  rig.clock += AGY_NET_GRACE_MS / 2 + 1
  await agyTeamSafetyNet(deps)
  assert.equal(rig.told.length, 0, 'ended for only half the grace since it worked')
  // ⚠️ the leader not reached: tried again after another grace, not on every look
  rig.tellOk = false
  rig.clock += AGY_NET_GRACE_MS
  await agyTeamSafetyNet(deps)
  rig.tellOk = true
  rig.clock += 1
  await agyTeamSafetyNet(deps)
  assert.equal(rig.told.length, 0, 'not on the very next look')
  rig.clock += AGY_NET_GRACE_MS
  await agyTeamSafetyNet(deps)
  assert.equal(rig.told.length, 1)
  assert.match(rig.told[0]!, /without an answer|答えを出さずに/)

  // ★ an error ends the turn too
  const SENT2 = rig.clock
  const TURN2 = SENT2 + 1000
  rig.records = [userInput(11, TURN2), { type: 'ERROR_MESSAGE', step_index: 12 }]
  rig.transcriptAt = TURN2 + 100
  agyInstructionSent(m, SENT2, { turn: 9, at: TURN })
  // ★ within the prompt's own second (whole seconds / codex · agy review): still its end
  stateAt(TURN2 + 200, { agent_state: 'error' })
  rig.clock = TURN2 + 5000
  await looks()
  assert.equal(rig.told.length, 2)
  assert.match(rig.told[1]!, /with an error|エラーで/)
})

test('★★ safety net: the sent turn, not a later one; past the tail; another agy; subagents unsure; the lock', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const m = r.team.members[0]!
  const SENT = Date.now() - 60_000
  const A = SENT + 1000
  // ★ the sent turn A stopped (declined), then someone started B on the PC: A is reported, not B (codex review)
  const { rig, looks } = netRig([userInput(3, A), call(4), userInput(5, A + 9000), said(6, 'B words')], A + 30_000)
  rig.transcriptAt = A + 10_000
  stateAt(A + 11_000, { agent_state: 'working' })
  agyInstructionSent(m, SENT, { turn: 1, at: SENT - 9000 })
  // ⚠️ the recorded agy no longer holds the conversation (a `/new` on the PC): not told
  rig.locks = [OTHER]
  await looks()
  assert.equal(rig.told.length, 0)
  rig.locks = [CONV]
  await looks()
  assert.equal(rig.told.length, 1)
  assert.match(rig.told[0]!, /without an answer|答えを出さずに/)
  assert.doesNotMatch(rig.told[0]!, /B words/)

  // ★ the prompt past the tail (a long turn): the last turn from the whole file
  const SENT2 = rig.clock
  rig.records = [{ type: 'GENERIC', step_index: 40, content: 'big' }, said(41, 'long done')]
  rig.lastTurn = { turn: 30, at: SENT2 + 1000 }
  rig.transcriptAt = SENT2 + 5000
  stateAt(SENT2 + 6000)
  agyInstructionSent(m, SENT2, { turn: 5, at: A + 9000 })
  rig.clock = SENT2 + 10_000
  await looks()
  assert.equal(rig.told.length, 2)
  assert.match(rig.told[1]!, /long done/)

  // ⚠️ another agy wrote into the conversation since the send: said so, not its words
  const SENT3 = rig.clock
  rig.records = [userInput(50, SENT3 + 1000), said(51, 'whose words')]
  rig.transcriptAt = SENT3 + 2000
  stateAt(SENT3 + 3000)
  rig.others = true
  agyInstructionSent(m, SENT3, { turn: 30, at: SENT2 + 1000 })
  rig.clock = SENT3 + 10_000
  await looks()
  assert.equal(rig.told.length, 3)
  assert.match(rig.told[2]!, /another agy|別の agy/)
  assert.doesNotMatch(rig.told[2]!, /whose words/)
  rig.others = false

  // ★ subagents not all settled: its words, with a caution
  const SENT4 = rig.clock
  rig.records = [userInput(60, SENT4 + 1000), ...launch(61), said(63, 'started the check')]
  rig.transcriptAt = SENT4 + 2000
  stateAt(SENT4 + 3000)
  rig.settled = false
  agyInstructionSent(m, SENT4, { turn: 50, at: SENT3 + 1000 })
  rig.clock = SENT4 + 10_000
  await looks()
  assert.equal(rig.told.length, 4)
  assert.match(rig.told[3]!, /started the check[\s\S]*subagents|started the check[\s\S]*サブエージェント/)
})

test('★★ safety net: the notifier\'s "done" settles what is owed; one the leader did not get leaves it owed; one in flight is waited for', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const m = r.team.members[0]!
  const SENT = Date.now() - 60_000
  const TURN = SENT + 1000
  const { rig, deps, looks } = netRig([userInput(3, TURN), said(4, 'ok')], TURN + 10_000)
  rig.transcriptAt = TURN + 2000
  stateAt(TURN + 4000)
  const doneDeps = (over: Partial<AgyDoneDeps> = {}): AgyDoneDeps => ({
    locks: async () => [CONV],
    lastWords: () => ({ text: 'ok', answered: true, answerAt: Infinity }),
    tell: async (_t, text) => (rig.told.push(text), true),
    turn: () => ({ turn: 3, at: TURN }),
    ...over,
  })
  const done = statusLabel('done') as string
  agyInstructionSent(m, SENT, { turn: 1, at: SENT - 5000 })
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, async () => 0, doneDeps()), 1)
  assert.equal(rig.told.length, 1)
  await looks()
  assert.equal(rig.told.length, 1, 'settled by the "done"')

  // ✅ words unreadable: no turn is taken (the whole file's may be a next one / codex review round 10) — the net tells
  //    the instruction's end too (accepted: told twice, not stuck)
  agyInstructionSent(m, SENT, { turn: 1, at: SENT - 5000 })
  rig.records = [userInput(5, TURN + 3000), said(6, 'ok2')]
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, async () => 0, doneDeps({ lastWords: () => undefined, turn: () => ({ turn: 5, at: TURN + 3000 }) })), 1)
  assert.equal(rig.told.length, 2)
  rig.transcriptAt = TURN + 3500
  await looks()
  assert.equal(rig.told.length, 3)
  rig.told.pop()

  // ⚠️ a "done" the leader did not get (the phone rang instead): still owed, the net tells the leader
  agyInstructionSent(m, SENT, { turn: 5, at: TURN + 3000 })
  rig.records = [userInput(7, TURN + 5000), said(8, 'ok3')]
  rig.transcriptAt = TURN + 5500
  stateAt(TURN + 6000)
  let pushes = 0
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, async () => (pushes++, 2), doneDeps({ tell: async () => false, turn: () => ({ turn: 7, at: TURN + 5000 }) })), 2)
  assert.equal(pushes, 1)
  await looks()
  assert.equal(rig.told.length, 3)
  assert.match(rig.told[2]!, /ok3/)

  // ★★ the net's write in flight when the "done" comes: the "done" waits for it — told once, and if the write fails
  //    the phone still rings (codex · agy review)
  agyInstructionSent(m, SENT, { turn: 7, at: TURN + 5000 })
  rig.records = [userInput(9, TURN + 7000), said(10, 'ok4')]
  rig.transcriptAt = TURN + 7500
  stateAt(TURN + 8000)
  const inFlight = async (netTold: boolean, doneTold: boolean): Promise<{ late: number | undefined; pushes: number; doneTells: number }> => {
    let release!: (v: boolean) => void
    const slow = new Promise<boolean>((res) => (release = res))
    const netDeps: AgyNetDeps = { ...deps, tell: async () => slow }
    await agyTeamSafetyNet(netDeps)
    rig.clock += AGY_NET_GRACE_MS
    const netDone = agyTeamSafetyNet(netDeps)
    await new Promise((res) => setTimeout(res, 10))
    let pushes = 0
    let doneTells = 0
    const late = agyMemberDone({ sessionId: AGY }, done, async () => (pushes++, 1), doneDeps({ turn: () => ({ turn: rig.records[0]!['step_index'] as number, at: Date.parse(rig.records[0]!['created_at'] as string) }), tell: async () => (doneTells++, doneTold) }))
    release(netTold)
    await netDone
    return { late: await late, pushes, doneTells }
  }
  // the net's write gets through: the "done" tells nothing more
  assert.deepEqual(await inFlight(true, true), { late: 1, pushes: 0, doneTells: 0 })
  // the net's write fails: the "done" tries the leader, and rings the phone when that fails too
  agyInstructionSent(m, SENT, { turn: 9, at: TURN + 7000 })
  rig.records = [userInput(11, TURN + 9000), said(12, 'ok5')]
  rig.transcriptAt = TURN + 9500
  stateAt(TURN + 10_000)
  assert.deepEqual(await inFlight(false, false), { late: 1, pushes: 1, doneTells: 1 })
})

test('★ safety net: with no turn read before the send, a turn dated before it is not the sent one; a tail at odds with the whole file waits', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const m = r.team.members[0]!
  const SENT = Date.now() - 60_000
  const { rig, looks } = netRig([userInput(3, SENT - 5000), said(4, 'before the send')], SENT + 10_000)
  rig.transcriptAt = SENT - 4000
  stateAt(SENT - 3000)
  agyInstructionSent(m, SENT)
  await looks()
  assert.equal(rig.told.length, 0, 'dated before the send')
  // ⚠️ the PC starts something while the lock is probed (a card opens): the end seen before is not told
  const SENT2 = SENT - 10_000
  agyInstructionSent(m, SENT2)
  rig.onLocks = () => (rig.waiting = true)
  await looks()
  assert.equal(rig.told.length, 0, 'changed during the probe')
  rig.onLocks = undefined
  rig.waiting = false
  rig.clock += AGY_NET_GRACE_MS
  await looks()
  assert.equal(rig.told.length, 1, 'then it is told')
  rig.told.length = 0
  agyInstructionSent(m, SENT)
  // ⚠️ the whole file says a turn began after the send, but the tail shows only an older prompt (read in between)
  rig.lastTurn = { turn: 5, at: SENT + 1000 }
  await looks()
  assert.equal(rig.told.length, 0)
})

test('★★ safety net round 2: a later turn\'s "done" does not settle the sent one; a "done" before the debt; `/rewind`; others while working; a superseded error or child; words changing', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const m = r.team.members[0]!
  const done = statusLabel('done') as string
  const SENT = Date.now() - 120_000
  const A = SENT + 1000
  const B = A + 5000
  // ★ A stopped (declined), then B ran on the PC and its "done" reached the leader: A is still told (codex review)
  const { rig, looks } = netRig([userInput(3, A), call(4), userInput(5, B), said(6, 'B words')], B + 20_000)
  rig.transcriptAt = B + 2000
  stateAt(B + 3000)
  agyInstructionSent(m, SENT, { turn: 1, at: SENT - 9000 })
  const doneDeps = (turn: { turn: number; at: number }, over: Partial<AgyDoneDeps> = {}): AgyDoneDeps => ({
    locks: async () => [CONV],
    lastWords: () => ({ text: 'x', answered: true, answerAt: Infinity }),
    tell: async (_t, text) => (rig.told.push(text), true),
    turn: () => turn,
    ...over,
  })
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, async () => 0, doneDeps({ turn: 5, at: B })), 1)
  assert.equal(rig.told.length, 1)
  await looks()
  assert.equal(rig.told.length, 2)
  assert.match(rig.told[1]!, /without an answer|答えを出さずに/)

  // ★ the "done" reached the leader before the debt was recorded (a fast turn): the net does not tell it again (agy review)
  const C = rig.clock
  rig.records = [userInput(7, C), said(8, 'fast')]
  rig.transcriptAt = C + 500
  stateAt(C + 600)
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, async () => 0, doneDeps({ turn: 7, at: C })), 1)
  agyInstructionSent(m, C - 200, { turn: 5, at: B })
  rig.clock = C + 5000
  await looks()
  assert.equal(rig.told.length, 3, 'only the "done"')
  // ⚠️ a reported turn's late "done" whose lock probe fails: still handled (no phone / codex review)
  let pushes = 0
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, async () => (pushes++, 1), doneDeps({ turn: 7, at: C }, { locks: async () => undefined })), 1)
  assert.equal(pushes, 0)
  // ★ after `/rewind` the same step comes back with a newer time: another turn (agy review)
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, async () => (pushes++, 1), doneDeps({ turn: 7, at: C + 60_000 })), 1)
  assert.equal(rig.told.length, 4)

  // ⚠️ another agy wrote, but the member still works: not yet (agy review)
  const D = rig.clock
  rig.records = [userInput(9, D), call(10)]
  rig.transcriptAt = D + 500
  stateAt(D + 600, { agent_state: 'working' })
  rig.others = true
  agyInstructionSent(m, D - 200, { turn: 7, at: C + 60_000 })
  rig.clock = D + 5000
  await looks()
  assert.equal(rig.told.length, 4, 'still working')
  rig.others = false

  // ★ a superseded turn that ended on an error says so; ⚠️ not while a child still runs (codex review)
  rig.records = [userInput(9, D), { type: 'ERROR_MESSAGE', step_index: 10 }, userInput(11, D + 3000), call(12)]
  stateAt(D + 4000, { agent_state: 'working', subagents: [{ status: 'running', role: 'r' }] })
  await looks()
  assert.equal(rig.told.length, 4, 'a child runs')
  stateAt(D + 4000, { agent_state: 'working' })
  rig.clock += AGY_NET_GRACE_MS
  await looks()
  assert.equal(rig.told.length, 5)
  assert.match(rig.told[4]!, /with an error|エラーで/)

  // ⚠️ the words change while the lock is probed (an interim answer replaced): the old words are not told (codex review)
  const E = rig.clock
  rig.records = [userInput(13, E), said(14, 'interim')]
  rig.transcriptAt = E + 500
  stateAt(E + 600)
  agyInstructionSent(m, E - 200, { turn: 11, at: D + 3000 })
  rig.clock = E + 5000
  rig.onLocks = () => (rig.records = [userInput(13, E), said(14, 'final')])
  await looks()
  assert.equal(rig.told.length, 5, 'changed during the probe')
  rig.onLocks = undefined
  rig.clock += AGY_NET_GRACE_MS
  await looks()
  assert.equal(rig.told.length, 6)
  assert.match(rig.told[5]!, /final/)
})

test('★ safety net: a "done" whose turn cannot be read settles nothing (the net tells it too); the subagents\' caution changing during the probe waits', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const m = r.team.members[0]!
  const SENT = Date.now() - 60_000
  const T = SENT + 1000
  const { rig, looks } = netRig([userInput(3, T), said(4, 'ok')], T + 10_000)
  rig.transcriptAt = T + 500
  stateAt(T + 600)
  agyInstructionSent(m, SENT, { turn: 1, at: SENT - 9000 })
  const tell = async (_t: unknown, text: string): Promise<boolean> => (rig.told.push(text), true)
  assert.equal(await agyMemberDone({ sessionId: AGY }, statusLabel('done') as string, async () => 0, { locks: async () => [CONV], lastWords: () => ({ text: 'ok' }), tell, turn: () => undefined }), 1)
  await looks()
  // ✅ accepted (codex review round 9): an undatable report cannot settle the instruction's debt (it may be a later
  //    turn's), so the net tells the instruction's end too
  assert.equal(rig.told.length, 2, 'the net tells it too')
  rig.told.length = 0
  // ⚠️ its subagents turn out unsettled while the lock is probed: the notice without the caution is not sent
  const U = rig.clock
  rig.records = [userInput(5, U), ...launch(6), said(8, 'checked')]
  rig.transcriptAt = U + 500
  stateAt(U + 600)
  agyInstructionSent(m, U - 200, { turn: 3, at: T })
  rig.clock = U + 5000
  rig.onLocks = () => (rig.settled = false)
  await looks()
  assert.equal(rig.told.length, 0)
  rig.onLocks = undefined
  rig.clock += AGY_NET_GRACE_MS
  await looks()
  assert.equal(rig.told.length, 1)
  assert.match(rig.told[0]!, /checked[\s\S]*(subagents|サブエージェント)/)
})

test('★★ safety net round 3: nothing read; state unreadable; a reported turn settles at once; another end restarts the grace; the net telling during the "done"\'s probe; the words\' own turn', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const m = r.team.members[0]!
  const done = statusLabel('done') as string
  const SENT = Date.now() - 300_000
  const A = SENT + 1000
  const { rig, deps, looks } = netRig([], A + 10_000)
  rig.lastTurn = { turn: 3, at: A }
  rig.transcriptAt = A + 500
  stateAt(A + 600)
  agyInstructionSent(m, SENT, { turn: 1, at: SENT - 9000 })
  // ⚠️ nothing read (a transient failure) is not a stop (agy review)
  await looks()
  assert.equal(rig.told.length, 0, 'nothing read')
  // ⚠️ its own state unreadable (another conversation named), even for a superseded turn: not yet (agy review)
  rig.records = [userInput(3, A), call(4), userInput(5, A + 3000), call(6)]
  ownState(OTHER)
  await looks()
  assert.equal(rig.told.length, 0, 'state unreadable')

  // ★ a reported turn settles the debt at once: a PC turn stopping right after is not told (agy review)
  const B = rig.clock
  rig.records = [userInput(7, B), said(8, 'B done')]
  rig.lastTurn = undefined
  rig.transcriptAt = B + 500
  stateAt(B + 600)
  agyInstructionSent(m, B - 200, { turn: 5, at: A + 3000 })
  const tell = async (_t: unknown, text: string): Promise<boolean> => (rig.told.push(text), true)
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, async () => 0, { locks: async () => [CONV], lastWords: () => ({ text: 'B done', turn: 7, turnAt: B }), tell, turn: () => ({ turn: 99, at: 0 }) }), 1)
  assert.equal(rig.told.length, 1)
  rig.clock = B + 2000
  await agyTeamSafetyNet(deps)
  // (B's prompt now past the tail: the PC turn is the first prompt the tail shows after the send)
  rig.records = [{ type: 'GENERIC', step_index: 8, content: 'big' }, userInput(9, B + 3000), call(10)]
  rig.transcriptAt = B + 3500
  stateAt(B + 4000)
  rig.clock = B + 6000
  await looks()
  assert.equal(rig.told.length, 1, 'the PC turn is not the debt')

  // ★ another end restarts the grace (agy review)
  const C = rig.clock + 1000
  rig.records = [userInput(11, C), said(12, 'interim')]
  rig.transcriptAt = C + 500
  stateAt(C + 600)
  agyInstructionSent(m, C - 200, { turn: 9, at: B + 3000 })
  rig.clock = C + 5000
  await agyTeamSafetyNet(deps)
  rig.clock += AGY_NET_GRACE_MS - 5000
  rig.records = [userInput(11, C), said(12, 'final')]
  await agyTeamSafetyNet(deps)
  rig.clock += 5000
  await agyTeamSafetyNet(deps)
  assert.equal(rig.told.length, 1, 'the new words were seen only 5 s ago')
  rig.clock += AGY_NET_GRACE_MS
  await agyTeamSafetyNet(deps)
  assert.equal(rig.told.length, 2)
  assert.match(rig.told[1]!, /final/)

  // ★ the net tells the turn while the "done"'s lock probe runs and that probe fails: no phone (codex review)
  const D = rig.clock + 1000
  rig.records = [userInput(13, D), said(14, 'D done')]
  rig.transcriptAt = D + 500
  stateAt(D + 600)
  agyInstructionSent(m, D - 200, { turn: 11, at: C })
  rig.clock = D + 5000
  await agyTeamSafetyNet(deps)
  rig.clock += AGY_NET_GRACE_MS
  let pushes = 0
  const got = await agyMemberDone({ sessionId: AGY }, done, async () => (pushes++, 1), {
    locks: async () => (await agyTeamSafetyNet(deps), undefined),
    lastWords: () => ({ text: 'D done', turn: 13, turnAt: D }),
    tell,
  })
  assert.equal(rig.told.length, 3, 'the net told it')
  assert.equal(got, 1)
  assert.equal(pushes, 0)
})

test('★★ safety net round 4: a "done" read past its turn; "cannot tell apart" only while quiet; a prompt that is not the instruction; the probe failing while the net writes', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const m = r.team.members[0]!
  const done = statusLabel('done') as string
  const SENT = Date.now() - 300_000
  const A = SENT + 1000
  const { rig, deps, looks } = netRig([userInput(3, A), said(4, 'A done')], A + 10_000)
  rig.transcriptAt = A + 500
  stateAt(A + 600)
  agyInstructionSent(m, SENT, { turn: 1, at: SENT - 9000 })
  const tell = async (_t: unknown, text: string): Promise<boolean> => (rig.told.push(text), true)
  // ⚠️ the "done" reads a turn that has not ended (the next prompt came in): nothing told, nothing marked (codex review)
  let pushes = 0
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, async () => (pushes++, 1), { locks: async () => [CONV], lastWords: () => ({ text: undefined, answered: false, turn: 5, turnAt: A + 2000 }), tell }), 0, 'nothing sent: the notifier drops it once the new turn shows')
  assert.equal(rig.told.length, 0)
  assert.equal(pushes, 0)

  // ⚠️ another agy's prompt after the sent one while the member's card is open: not yet (codex review)
  rig.records = [userInput(3, A), call(4), userInput(5, A + 3000, true), said(6, 'theirs')]
  rig.others = true
  rig.waiting = true
  await looks()
  assert.equal(rig.told.length, 0, 'a card is open')
  rig.waiting = false
  await looks()
  assert.equal(rig.told.length, 1)
  assert.match(rig.told[0]!, /cannot be told apart|区別できません/)
  rig.others = false

  // ⚠️ the first prompt after the send is not the instruction (a `/rewind` on the PC replaced it): said so (codex review)
  const B = rig.clock
  rig.records = [userInput(7, B, true), said(8, 'PC words')]
  rig.transcriptAt = B + 500
  stateAt(B + 600)
  agyInstructionSent(m, B - 200, { turn: 5, at: A + 3000 })
  rig.clock = B + 5000
  await looks()
  assert.equal(rig.told.length, 2)
  assert.match(rig.told[1]!, /cannot be told apart|区別できません/)
  assert.doesNotMatch(rig.told[1]!, /PC words/)

  // ★ the "done"'s probe fails while the net's write is under way and gets through: no phone (codex review)
  const C = rig.clock + 1000
  rig.records = [userInput(9, C), said(10, 'C done')]
  rig.transcriptAt = C + 500
  stateAt(C + 600)
  agyInstructionSent(m, C - 200, { turn: 7, at: B })
  rig.clock = C + 5000
  let release!: (v: boolean) => void
  const slow = new Promise<boolean>((res) => (release = res))
  const netDeps: AgyNetDeps = { ...deps, tell: async (_t, text) => ((await slow) ? (rig.told.push(text), true) : false) }
  await agyTeamSafetyNet(netDeps)
  rig.clock += AGY_NET_GRACE_MS
  const net = agyTeamSafetyNet(netDeps)
  await new Promise((res) => setTimeout(res, 10))
  const late = agyMemberDone({ sessionId: AGY }, done, async () => (pushes++, 1), { locks: async () => undefined, lastWords: () => ({ text: 'C done', answered: true, turn: 9, turnAt: C }), tell })
  release(true)
  await net
  assert.equal(await late, 1)
  assert.equal(pushes, 0)
  assert.equal(rig.told.length, 3)
})

test('★★ safety net round 5: a reported turn\'s late "done" with the leader unreadable; a `/rewind` to an earlier step; a replacing PC prompt reported first; a superseded turn\'s children', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const m = r.team.members[0]!
  const done = statusLabel('done') as string
  const SENT = Date.now() - 300_000
  const A = SENT + 1000
  const { rig, looks } = netRig([userInput(3, A), said(4, 'A done')], A + 10_000)
  rig.transcriptAt = A + 500
  stateAt(A + 600)
  agyInstructionSent(m, SENT, { turn: 1, at: SENT - 9000 })
  const tell = async (_t: unknown, text: string): Promise<boolean> => (rig.told.push(text), true)
  await looks()
  assert.equal(rig.told.length, 1)
  // ★ its late "done" while the leader's index cannot be read: handled, no phone (codex review)
  const leaderFile = join(LEADER_DIR, 'sessions', `${ME}.json`)
  writeFileSync(leaderFile, '{')
  let pushes = 0
  try {
    assert.equal(await agyMemberDone({ sessionId: AGY }, done, async () => (pushes++, 1), { locks: async () => [CONV], lastWords: () => ({ text: 'A done', answered: true, turn: 3, turnAt: A }), tell }), 1)
  } finally {
    writeFileSync(leaderFile, JSON.stringify({ pid: ME, sessionId: 'lead-x' }))
  }
  assert.equal(pushes, 0)

  // ★ a `/rewind` to an earlier step, then a PC prompt: said so (agy · codex review: it waited forever)
  const B = rig.clock
  rig.records = [userInput(2, B + 1000, true), call(3)]
  rig.transcriptAt = B + 1500
  stateAt(B + 1600)
  agyInstructionSent(m, B, { turn: 3, at: A })
  rig.clock = B + 5000
  await looks()
  assert.equal(rig.told.length, 2)
  assert.match(rig.told[1]!, /cannot be told apart|区別できません/)

  // ★ a PC prompt replaced the instruction and its "done" reached the leader first: still said so, and that turn stays
  //   unmarked by the net (codex · agy review)
  const C = rig.clock
  rig.records = [userInput(5, C + 1000, true), said(6, 'PC words')]
  rig.transcriptAt = C + 1500
  stateAt(C + 1600)
  agyInstructionSent(m, C, { turn: 3, at: B + 1000 })
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, async () => 0, { locks: async () => [CONV], lastWords: () => ({ text: 'PC words', answered: true, turn: 5, turnAt: C + 1000 }), tell }), 1)
  assert.equal(rig.told.length, 3)
  rig.clock = C + 5000
  await looks()
  assert.equal(rig.told.length, 4)
  assert.match(rig.told[3]!, /cannot be told apart|区別できません/)

  // ★ the sent turn answered "started the check", a child of it did not finish well, then a later prompt: the caution
  //   stays (codex review)
  const D = rig.clock
  rig.records = [userInput(7, D + 1000), ...launch(8), said(10, 'started the check'), userInput(11, D + 3000, true), call(12)]
  rig.transcriptAt = D + 3500
  // (the later turn's child finished well: a superseded turn's children cannot be told from it / codex review)
  stateAt(D + 3600, { agent_state: 'working', subagents: [{ status: 'completed', role: 'r' }] })
  agyInstructionSent(m, D, { turn: 5, at: C + 1000 })
  rig.clock = D + 5000
  await looks()
  assert.equal(rig.told.length, 5)
  assert.match(rig.told[4]!, /started the check[\s\S]*(subagents|サブエージェント)/)

  // ★ the net said "cannot tell apart" first: the PC turn's own "done" still reaches the leader (codex review)
  const E = rig.clock
  rig.records = [userInput(11, E + 1000, true), said(12, 'PC answer')]
  rig.transcriptAt = E + 1500
  stateAt(E + 1600)
  agyInstructionSent(m, E, { turn: 9, at: D + 3000 })
  rig.clock = E + 5000
  await looks()
  assert.equal(rig.told.length, 6)
  assert.match(rig.told[5]!, /cannot be told apart|区別できません/)
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, async () => 0, { locks: async () => [CONV], lastWords: () => ({ text: 'PC answer', answered: true, turn: 11, turnAt: E + 1000 }), tell }), 1)
  assert.equal(rig.told.length, 7)
  assert.match(rig.told[6]!, /PC answer/)
})

test('★★ safety net round 6: another agy on the instruction\'s own turn; a PC prompt quoting the frame; the sent turn removed by `/rewind`; the sent turn reported then replaced', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const m = r.team.members[0]!
  const done = statusLabel('done') as string
  const tell = async (_t: unknown, text: string): Promise<boolean> => (rig.told.push(text), true)
  const SENT = Date.now() - 300_000
  const A = SENT + 1000
  const { rig, looks } = netRig([userInput(3, A), said(4, 'A done')], A + 10_000)
  rig.transcriptAt = A + 500
  stateAt(A + 600)
  // ★ another agy wrote, but the "done" for the instruction's own turn reached the leader: settled, not told again (agy review)
  rig.others = true
  agyInstructionSent(m, SENT, { turn: 1, at: SENT - 9000 })
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, async () => 0, { locks: async () => [CONV], lastWords: () => ({ text: 'A done', answered: true, turn: 3, turnAt: A }), tell }), 1)
  await looks()
  assert.equal(rig.told.length, 1)
  // … and the net first, then that turn's "done": not told again (the net marks the instruction's own turn)
  const B = rig.clock
  rig.records = [userInput(5, B), said(6, 'B done')]
  rig.transcriptAt = B + 500
  stateAt(B + 600)
  agyInstructionSent(m, B - 200, { turn: 3, at: A })
  rig.clock = B + 5000
  await looks()
  assert.equal(rig.told.length, 2)
  assert.match(rig.told[1]!, /cannot be told apart|区別できません/)
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, async () => 0, { locks: async () => [CONV], lastWords: () => ({ text: 'B done', answered: true, turn: 5, turnAt: B }), tell }), 1)
  assert.equal(rig.told.length, 2)
  rig.others = false

  // ⚠️ a PC prompt that quotes the frame is not the instruction: its own tag is missing (codex review)
  const C = rig.clock
  rig.records = [userInput(7, C), said(8, 'what the frame means')]
  rig.transcriptAt = C + 500
  stateAt(C + 600)
  agyInstructionSent(m, C - 200, { turn: 5, at: B }, '#00c0ffee')
  rig.clock = C + 5000
  await looks()
  assert.equal(rig.told.length, 3)
  assert.match(rig.told[2]!, /cannot be told apart|区別できません/)
  assert.doesNotMatch(rig.told[2]!, /what the frame means/)

  // ★ the sent turn seen, then removed by `/rewind` with nothing typed after: said so once quiet (codex review)
  const D = rig.clock
  const tagged = (step: number, at: number): Record<string, unknown> => ({ ...userInput(step, at), content: '<USER_REQUEST>\n[nyan-team] Instruction from the team lead (lead-x #0badf00d):\ndo it\n\n(When done, sum up the result in the last message of this turn; the lead reads it.)\n</USER_REQUEST>' })
  rig.records = [tagged(9, D), call(10)]
  rig.transcriptAt = D + 500
  stateAt(D + 600, { agent_state: 'working' })
  agyInstructionSent(m, D - 200, { turn: 7, at: C }, '#0badf00d')
  rig.clock = D + 5000
  await looks()
  assert.equal(rig.told.length, 3, 'working')
  rig.records = [userInput(7, C), said(8, 'what the frame means')]
  rig.lastTurn = { turn: 7, at: C }
  stateAt(D + 2000)
  await looks()
  assert.equal(rig.told.length, 4)
  assert.match(rig.told[3]!, /cannot be told apart|区別できません/)
  rig.lastTurn = undefined

  // ★ the sent turn reported by its "done", then replaced on the PC before the net looked: settled, nothing more (codex review)
  const E = rig.clock
  rig.records = [tagged(11, E), said(12, 'E done')]
  rig.transcriptAt = E + 500
  stateAt(E + 600)
  agyInstructionSent(m, E - 200, { turn: 7, at: C }, '#0badf00d')
  await agyTeamSafetyNet({ ...rigDeps(rig), now: () => E + 1000 })
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, async () => 0, { locks: async () => [CONV], lastWords: () => ({ text: 'E done', answered: true, turn: 11, turnAt: E }), tell }), 1)
  assert.equal(rig.told.length, 5)
  rig.records = [userInput(11, E + 3000, true), said(12, 'PC replaced it')]
  rig.transcriptAt = E + 3500
  stateAt(E + 3600)
  rig.clock = E + 5000
  await looks()
  assert.equal(rig.told.length, 5, 'settled by the seen turn\'s report')

  // ★ a sent turn past the tail is seen too: removed afterwards, said so
  const F = rig.clock
  rig.records = [{ type: 'GENERIC', step_index: 20, content: 'big' }, call(21)]
  rig.lastTurn = { turn: 19, at: F }
  rig.transcriptAt = F + 500
  stateAt(F + 600, { agent_state: 'working' })
  agyInstructionSent(m, F - 200, { turn: 11, at: E + 3000 }, '#0badf00d')
  rig.clock = F + 5000
  await looks()
  rig.lastTurn = { turn: 11, at: E + 3000 }
  rig.records = [userInput(11, E + 3000, true), said(12, 'PC replaced it')]
  stateAt(F + 2000)
  await looks()
  assert.equal(rig.told.length, 6)
  assert.match(rig.told[5]!, /cannot be told apart|区別できません/)
})

test('★★ safety net round 7: the phone guard is for "done" only; a reported instruction turn removed before the net looked; a transient leader read while the net writes', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const m = r.team.members[0]!
  const done = statusLabel('done') as string
  const tell = async (_t: unknown, text: string): Promise<boolean> => (rig.told.push(text), true)
  const SENT = Date.now() - 300_000
  const A = SENT + 1000
  const TAG = '#feedc0de'
  const tagged = (step: number, at: number, suffix = ''): Record<string, unknown> => ({ ...userInput(step, at), content: `<USER_REQUEST>\n[nyan-team] Instruction from the team lead (lead-x ${TAG}):\ndo it\n\n(When done, sum up the result in the last message of this turn; the lead reads it.)${suffix}\n</USER_REQUEST>` })
  const { rig, deps, looks } = netRig([tagged(3, A), said(4, 'A done')], A + 10_000)
  rig.transcriptAt = A + 500
  stateAt(A + 600)
  agyInstructionSent(m, SENT, { turn: 1, at: SENT - 9000 }, TAG)
  // ★ the "done" reports it before the net ever looked; then the PC rewinds it and types something else (codex review)
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, async () => 0, { locks: async () => [CONV], lastWords: () => agyLastWords(AGY, () => rig.records), tell }), 1)
  assert.equal(rig.told.length, 1)
  rig.records = [userInput(3, A + 4000, true), said(4, 'PC')]
  rig.transcriptAt = A + 4500
  stateAt(A + 4600)
  await looks()
  assert.equal(rig.told.length, 1, 'settled by the instruction\'s reported turn')

  // ★ the phone guard: a reported turn's "done" does not ring; an error or a card always rings (codex · agy review)
  const turn3 = (): { turn: number; at: number } => ({ turn: 3, at: A })
  assert.equal(agyPhoneMayRing(AGY, done, turn3), false)
  assert.equal(agyPhoneMayRing(AGY, statusLabel('error') as string, turn3), true)
  assert.equal(agyPhoneMayRing(AGY, statusLabel('waiting') as string, turn3), true)
  assert.equal(agyPhoneMayRing(AGY, done, () => ({ turn: 5, at: A + 9000 })), true, 'another turn')
  assert.equal(agyPhoneMayRing(`agy-${OTHER}`, done, turn3), true, 'not a member')

  // ★ the leader's index unreadable for the "done" while the net is telling that turn: decided after it, no phone (agy review)
  const B = rig.clock
  rig.records = [userInput(5, B), said(6, 'B done')]
  rig.transcriptAt = B + 500
  stateAt(B + 600)
  agyInstructionSent(m, B - 200, { turn: 3, at: A + 4000 })
  rig.clock = B + 5000
  let release!: (v: boolean) => void
  const slow = new Promise<boolean>((res) => (release = res))
  const netDeps: AgyNetDeps = { ...deps, tell: async (_t, text) => ((await slow) ? (rig.told.push(text), true) : false) }
  await agyTeamSafetyNet(netDeps)
  rig.clock += AGY_NET_GRACE_MS
  const net = agyTeamSafetyNet(netDeps)
  await new Promise((res) => setTimeout(res, 10))
  const leaderFile = join(LEADER_DIR, 'sessions', `${ME}.json`)
  writeFileSync(leaderFile, '{')
  let late: Promise<number | undefined>
  try {
    late = agyMemberDone({ sessionId: AGY }, done, async () => 1, { locks: async () => [CONV], lastWords: () => ({ text: 'B done', answered: true, turn: 5, turnAt: B }), tell })
  } finally {
    writeFileSync(leaderFile, JSON.stringify({ pid: ME, sessionId: 'lead-x' }))
  }
  release(true)
  await net
  assert.equal(await late, 1)
  assert.equal(rig.told.length, 2)

  // ⚠️ a later PC turn's "done" is not the instruction's (no tag in its prompt): the stopped instruction is still told
  const C = rig.clock
  rig.records = [tagged(7, C), call(8), userInput(9, C + 3000, true), said(10, 'PC answer')]
  rig.transcriptAt = C + 3500
  stateAt(C + 3600)
  agyInstructionSent(m, C - 200, { turn: 5, at: B }, TAG)
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, async () => 0, { locks: async () => [CONV], lastWords: () => agyLastWords(AGY, () => rig.records), tell }), 1)
  assert.equal(rig.told.length, 3)
  rig.clock = C + 5000
  await looks()
  assert.equal(rig.told.length, 4)
  assert.match(rig.told[3]!, /without an answer|答えを出さずに/)

  // ⚠️ the instruction rewound away before the net looked, and the PC prompt that replaced it reported "done": that is
  //    not the instruction's report — "cannot tell apart" still comes
  const D = rig.clock
  agyInstructionSent(m, D - 200, { turn: 9, at: C + 3000 }, TAG)
  rig.records = [userInput(11, D + 2000, true), said(12, 'PC again')]
  rig.transcriptAt = D + 2500
  stateAt(D + 2600)
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, async () => 0, { locks: async () => [CONV], lastWords: () => agyLastWords(AGY, () => rig.records), tell }), 1)
  assert.equal(rig.told.length, 5)
  rig.clock = D + 5000
  await looks()
  assert.equal(rig.told.length, 6)
  assert.match(rig.told[5]!, /cannot be told apart|区別できません/)
})

test('★★ safety net round 8: a seen turn pushed past the tail by a later one; an instruction gone before it was seen; a quoted frame; a "done" whose whole-file turn is later than its words', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const m = r.team.members[0]!
  const done = statusLabel('done') as string
  const tell = async (_t: unknown, text: string): Promise<boolean> => (rig.told.push(text), true)
  const SENT = Date.now() - 300_000
  const A = SENT + 1000
  const TAG = '#a11ce5ed'
  const tagged = (step: number, at: number, prefix = '', suffix = ''): Record<string, unknown> => ({ ...userInput(step, at), content: `<USER_REQUEST>\n${prefix}[nyan-team] Instruction from the team lead (lead-x ${TAG}):\ndo it\n\n(When done, sum up the result in the last message of this turn; the lead reads it.)${suffix}\n</USER_REQUEST>` })
  const { rig, looks } = netRig([tagged(3, A), call(4)], A + 10_000)
  rig.transcriptAt = A + 500
  stateAt(A + 600, { agent_state: 'working' })
  agyInstructionSent(m, SENT, { turn: 1, at: SENT - 9000 }, TAG)
  await looks()
  // ⚠️ seen (3), then a PC turn pushes both prompts past the tail: its words are not the instruction's (codex · agy review)
  rig.records = [{ type: 'GENERIC', step_index: 30, content: 'big' }, said(31, 'B words')]
  rig.lastTurn = { turn: 5, at: A + 3000 }
  rig.transcriptAt = A + 4000
  stateAt(A + 4500)
  await looks()
  assert.equal(rig.told.length, 1)
  assert.match(rig.told[0]!, /cannot be told apart|区別できません/)
  assert.doesNotMatch(rig.told[0]!, /B words/)

  // ★ the instruction rewound away before the net saw it, nothing typed after: said so once quiet (codex review)
  const B = rig.clock
  rig.records = [userInput(5, A + 3000, true), said(6, 'old')]
  rig.lastTurn = { turn: 5, at: A + 3000 }
  agyInstructionSent(m, B, { turn: 5, at: A + 3000 }, TAG)
  rig.transcriptAt = B - 100
  stateAt(B + 3000)
  rig.clock = B + 5000
  await looks()
  assert.equal(rig.told.length, 1, 'nothing written after the send: not yet')
  rig.transcriptAt = B + 2000
  await looks()
  assert.equal(rig.told.length, 2)
  assert.match(rig.told[1]!, /cannot be told apart|区別できません/)
  rig.lastTurn = undefined

  // ⚠️ a PC question that quotes the frame (even with its tag) is not the instruction (codex review)
  const C = rig.clock
  rig.records = [tagged(7, C, 'why did this fail? ', '\nwhat went wrong?'), said(8, 'because')]
  rig.transcriptAt = C + 500
  stateAt(C + 600)
  agyInstructionSent(m, C - 200, { turn: 5, at: A + 3000 }, TAG)
  rig.clock = C + 5000
  await looks()
  assert.equal(rig.told.length, 3)
  assert.match(rig.told[2]!, /cannot be told apart|区別できません/)

  // ⚠️ the "done"'s words with their prompt past the tail, and the whole file's last turn began after them: not marked
  //    as that later turn (codex review) — its own "done" still reaches the leader
  const D = rig.clock
  rig.records = [tagged(7, D - 4000), said(8, 'A words')]
  rig.transcriptAt = D - 3500
  stateAt(D - 3400)
  agyInstructionSent(m, D - 5000, { turn: 5, at: A + 3000 }, TAG)
  assert.equal(
    await agyMemberDone({ sessionId: AGY }, done, async () => 0, { locks: async () => [CONV], lastWords: () => ({ text: 'A words', answered: true, answerAt: D }), tell, turn: () => ({ turn: 9, at: D + 2000 }) }),
    1,
  )
  assert.equal(rig.told.length, 4)
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, async () => 0, { locks: async () => [CONV], lastWords: () => ({ text: 'B words', answered: true, turn: 9, turnAt: D + 2000 }), tell }), 1)
  assert.equal(rig.told.length, 5)
  assert.match(rig.told[4]!, /B words/)
  // … and the debt is not settled by that undatable report: the net still tells the instruction's end
  rig.clock = D + 5000
  await looks()
  assert.equal(rig.told.length, 6)
  assert.match(rig.told[5]!, /A words/)
})

test('★★ safety net round 9: a PC draft before the instruction; the next prompt in the answer\'s second; a held-back phone push counts as handled', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const m = r.team.members[0]!
  const done = statusLabel('done') as string
  const tell = async (_t: unknown, text: string): Promise<boolean> => (rig.told.push(text), true)
  const SENT = Date.now() - 300_000
  const A = SENT + 1000
  const TAG = '#d4af7123'
  const tagged = (step: number, at: number, prefix: string): Record<string, unknown> => ({
    ...userInput(step, at),
    content: `<USER_REQUEST>\n${prefix}[nyan-team] Instruction from the team lead (lead-x ${TAG}):\ndo it\n\n(When done, sum up the result in the last message of this turn; the lead reads it.)\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nx\n</ADDITIONAL_METADATA>`,
  })
  // ★ the keys went after a draft typed on the PC: still the instruction (codex review)
  const { rig, looks } = netRig([tagged(3, A, 'half a thought '), call(4)], A + 10_000)
  rig.transcriptAt = A + 500
  stateAt(A + 600)
  agyInstructionSent(m, SENT, { turn: 1, at: SENT - 9000 }, TAG)
  await looks()
  assert.equal(rig.told.length, 1)
  assert.match(rig.told[0]!, /without an answer|答えを出さずに/)

  // ⚠️ the "done"'s words past the tail, the next prompt in the same second as the answer: not marked as that turn
  const B = rig.clock
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, async () => 0, { locks: async () => [CONV], lastWords: () => ({ text: 'A', answered: true, answerAt: B }), tell, turn: () => ({ turn: 9, at: B }) }), 1)
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, async () => 0, { locks: async () => [CONV], lastWords: () => ({ text: 'B', answered: true, turn: 9, turnAt: B }), tell }), 1)
  assert.equal(rig.told.length, 3, 'B\'s own "done" is not silenced')

  // ★ the phone push held back for a reported turn is handled (1); an error or nothing reported is pushed as usual
  const sent = async (n: number, guard: () => boolean): Promise<number> => (guard() ? n : 0)
  assert.equal(await agyPhoneFallback(AGY, done, (g) => sent(2, g), () => ({ turn: 9, at: B })), 1)
  assert.equal(await agyPhoneFallback(AGY, done, (g) => sent(2, g), () => ({ turn: 11, at: B + 9000 })), 2)
  assert.equal(await agyPhoneFallback(AGY, done, async () => 0, () => ({ turn: 11, at: B + 9000 })), 0, 'a failed push is tried again')
  assert.equal(await agyPhoneFallback(AGY, statusLabel('error') as string, (g) => sent(2, g), () => ({ turn: 9, at: B })), 2)
})

test('★★ safety net round 10: a closing tag inside the instruction; a "done" before the debt then a rewind; words not read at all; a last record larger than the tail', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const m = r.team.members[0]!
  const done = statusLabel('done') as string
  const tell = async (_t: unknown, text: string): Promise<boolean> => (rig.told.push(text), true)
  const SENT = Date.now() - 300_000
  const A = SENT + 1000
  const TAG = '#c105e7a6'
  const tagged = (step: number, at: number, body = 'do it'): Record<string, unknown> => ({
    ...userInput(step, at),
    content: `<USER_REQUEST>\n[nyan-team] Instruction from the team lead (lead-x ${TAG}):\n${body}\n\n(When done, sum up the result in the last message of this turn; the lead reads it.)\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nx\n</ADDITIONAL_METADATA>`,
  })
  // ★ the instruction's text has its own closing tag: still the instruction (codex · agy review)
  const { rig, looks } = netRig([tagged(3, A, 'explain </USER_REQUEST> here'), said(4, 'explained')], A + 10_000)
  rig.transcriptAt = A + 500
  stateAt(A + 600)
  agyInstructionSent(m, SENT, { turn: 1, at: SENT - 9000 }, TAG)
  await looks()
  assert.equal(rig.told.length, 1)
  assert.match(rig.told[0]!, /explained/)

  // ★ a fast turn's "done" reached the leader before the debt was recorded, then the PC rewound it: settled (codex review)
  const B = rig.clock
  rig.records = [tagged(5, B), said(6, 'fast')]
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, async () => 0, { locks: async () => [CONV], lastWords: () => agyLastWords(AGY, () => rig.records), tell }), 1)
  agyInstructionSent(m, B - 200, { turn: 3, at: A }, TAG)
  rig.records = [userInput(5, B + 2000, true), said(6, 'PC')]
  rig.transcriptAt = B + 2500
  stateAt(B + 2600)
  rig.clock = B + 5000
  await looks()
  assert.equal(rig.told.length, 2, 'only the "done"')

  // ⚠️ words not read at all: the whole file's last turn (maybe a next one) is not marked (codex review)
  const C = rig.clock
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, async () => 0, { locks: async () => [CONV], lastWords: () => undefined, tell, turn: () => ({ turn: 7, at: C }) }), 1)
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, async () => 0, { locks: async () => [CONV], lastWords: () => ({ text: 'C', answered: true, turn: 7, turnAt: C }), tell }), 1)
  assert.equal(rig.told.length, 4, 'turn 7\'s own "done" is not silenced')

  // ★ a last record larger than the tail, the member quiet after it: told that the result is too large (codex review)
  const D = rig.clock
  rig.records = []
  rig.transcriptSize = 3 * 1024 * 1024
  rig.lastTurn = { turn: 9, at: D + 1000 }
  rig.transcriptAt = D + 2000
  stateAt(D + 2500, { agent_state: 'working' })
  agyInstructionSent(m, D, { turn: 7, at: C }, TAG)
  rig.clock = D + 5000
  await looks()
  assert.equal(rig.told.length, 4, 'working')
  stateAt(D + 2500)
  rig.transcriptSize = 1000
  await looks()
  assert.equal(rig.told.length, 4, 'nothing read from a small file: a transient failure')
  rig.transcriptSize = 3 * 1024 * 1024
  await looks()
  assert.equal(rig.told.length, 5)
  assert.match(rig.told[4]!, /too large|大きすぎて/)
})

test('★★ safety net round 11: a later turn too large to read after the sent one; another agy with a large record; every prompt rewound away; an empty file', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const m = r.team.members[0]!
  const SENT = Date.now() - 300_000
  const A = SENT + 1000
  const TAG = '#b16b00b5'
  const tagged = (step: number, at: number): Record<string, unknown> => ({
    ...userInput(step, at),
    content: `<USER_REQUEST>\n[nyan-team] Instruction from the team lead (lead-x ${TAG}):\ndo it\n\n(When done, sum up the result in the last message of this turn; the lead reads it.)\n</USER_REQUEST>`,
  })
  const { rig, looks } = netRig([tagged(3, A), call(4)], A + 10_000)
  rig.transcriptAt = A + 500
  stateAt(A + 600, { agent_state: 'working' })
  agyInstructionSent(m, SENT, { turn: 1, at: SENT - 9000 }, TAG)
  await looks()
  // ⚠️ seen (3); then a PC turn whose last record is larger than the tail: not reported as the instruction (codex · agy review)
  rig.records = []
  rig.transcriptSize = 3 * 1024 * 1024
  rig.lastTurn = { turn: 5, at: A + 3000 }
  rig.transcriptAt = A + 4000
  stateAt(A + 4500)
  await looks()
  assert.equal(rig.told.length, 1)
  assert.match(rig.told[0]!, /cannot be told apart|区別できません/)

  // ⚠️ another agy wrote, the last record too large: "cannot tell apart", not "too large" (agy review)
  const B = rig.clock
  rig.lastTurn = { turn: 7, at: B + 1000 }
  rig.transcriptAt = B + 2000
  stateAt(B + 2500)
  rig.others = true
  agyInstructionSent(m, B, { turn: 5, at: A + 3000 }, TAG)
  rig.clock = B + 5000
  await looks()
  assert.equal(rig.told.length, 2)
  assert.match(rig.told[1]!, /cannot be told apart|区別できません/)
  rig.others = false

  // ★ seen, then every prompt rewound away (none left), nothing typed: said so (codex review)
  const C = rig.clock
  rig.transcriptSize = 1000
  rig.records = [tagged(9, C), call(10)]
  rig.lastTurn = { turn: 9, at: C }
  rig.transcriptAt = C + 500
  stateAt(C + 600, { agent_state: 'working' })
  agyInstructionSent(m, C - 200, { turn: 7, at: B + 1000 }, TAG)
  rig.clock = C + 5000
  await looks()
  rig.records = [{ type: 'SYSTEM_MESSAGE', step_index: 0 }]
  rig.lastTurn = undefined
  stateAt(C + 2000)
  await looks()
  assert.equal(rig.told.length, 3)
  assert.match(rig.told[2]!, /cannot be told apart|区別できません/)

  // ★ … and the same with the file left empty (codex review)
  const D = rig.clock
  rig.records = [tagged(11, D), call(12)]
  rig.lastTurn = { turn: 11, at: D }
  rig.transcriptAt = D + 500
  stateAt(D + 600, { agent_state: 'working' })
  agyInstructionSent(m, D - 200, { turn: 9, at: C }, TAG)
  rig.clock = D + 5000
  await looks()
  rig.records = []
  rig.transcriptSize = 0
  rig.lastTurn = undefined
  stateAt(D + 2000)
  await looks()
  assert.equal(rig.told.length, 4)
  // ⚠️ an unreadable file (no size) is not that: nothing told
  const E = rig.clock
  rig.records = [tagged(13, E), call(14)]
  rig.lastTurn = { turn: 13, at: E }
  rig.transcriptSize = 1000
  stateAt(E + 600, { agent_state: 'working' })
  agyInstructionSent(m, E - 200, { turn: 11, at: D }, TAG)
  rig.clock = E + 5000
  await looks()
  rig.records = []
  rig.transcriptSize = undefined as unknown as number
  rig.lastTurn = undefined
  stateAt(E + 2000)
  await looks()
  assert.equal(rig.told.length, 4)
})

test('★ safety net round 12: an instruction rewound away within a second of Enter, before the net saw it', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const m = r.team.members[0]!
  const SENT = Date.now() - 300_000
  const { rig, looks } = netRig([userInput(3, SENT - 5000, true), said(4, 'old')], SENT + 10_000)
  rig.lastTurn = { turn: 3, at: SENT - 5000 }
  // the file was last written before the keys; the rewind wrote it 800 ms after Enter
  rig.transcriptAt = SENT + 800
  stateAt(SENT + 900)
  agyInstructionSent(m, SENT, { turn: 3, at: SENT - 5000 }, '#0d0d0d0d', SENT - 4000)
  await looks()
  assert.equal(rig.told.length, 1)
  assert.match(rig.told[0]!, /cannot be told apart|区別できません/)
  // ⚠️ not written since the keys: nothing (the instruction may still be on its way)
  agyInstructionSent(m, SENT + 2000, { turn: 3, at: SENT - 5000 }, '#0e0e0e0e', SENT + 800)
  await looks()
  assert.equal(rig.told.length, 1)
})

test('★ safety net round 13: the send\'s tag before time; an instruction that never began', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const m = r.team.members[0]!
  const SENT = Date.now() - 300_000
  const TAG = '#7a97a970'
  const tagged = (step: number, at: number): Record<string, unknown> => ({
    ...userInput(step, at),
    content: `<USER_REQUEST>\n[nyan-team] Instruction from the team lead (lead-x ${TAG}):\ndo it\n\n(When done, sum up the result in the last message of this turn; the lead reads it.)\n</USER_REQUEST>`,
  })
  // ★ no turn read before the send, a PC prompt in the send's second came first: the tagged one is the instruction (codex review)
  const { rig, looks } = netRig([userInput(3, SENT, true), said(4, 'pc'), tagged(5, SENT + 1000), call(6)], SENT + 10_000)
  rig.transcriptAt = SENT + 1500
  stateAt(SENT + 1600)
  agyInstructionSent(m, SENT, undefined, TAG)
  await looks()
  assert.equal(rig.told.length, 1)
  assert.match(rig.told[0]!, /without an answer|答えを出さずに/)

  // ★ nothing written since the keys and the member quiet: after a minute, told it never began (codex review)
  const B = rig.clock
  rig.records = [tagged(5, SENT + 1000), call(6)]
  rig.lastTurn = { turn: 5, at: SENT + 1000 }
  agyInstructionSent(m, B, { turn: 5, at: SENT + 1000 }, '#11111111', SENT + 1500)
  rig.clock = B + AGY_NET_NOT_STARTED_MS - AGY_NET_GRACE_MS - 1
  await looks()
  assert.equal(rig.told.length, 1, 'not yet a minute')
  rig.clock = B + AGY_NET_NOT_STARTED_MS
  await looks()
  assert.equal(rig.told.length, 2)
  assert.match(rig.told[1]!, /not started|始めていません/)
})

test('★ safety net round 14→15: a late "done" whose words fail to read takes no turn (accepted: the net\'s report may be told again)', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const m = r.team.members[0]!
  const done = statusLabel('done') as string
  const SENT = Date.now() - 300_000
  const A = SENT + 1000
  const { rig, looks } = netRig([userInput(3, A), said(4, 'A done')], A + 10_000)
  rig.transcriptAt = A + 500
  stateAt(A + 600)
  agyInstructionSent(m, SENT, { turn: 1, at: SENT - 9000 })
  await looks()
  assert.equal(rig.told.length, 1)
  const tell = async (_t: unknown, text: string): Promise<boolean> => (rig.told.push(text), true)
  // the whole file's turn (maybe a next one) is not taken, even while the notifier says "still current" (it is cached)
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, async () => 0, { locks: async () => [CONV], lastWords: () => undefined, tell, turn: () => ({ turn: 5, at: A + 9000 }) }, () => true), 1)
  assert.equal(rig.told.length, 2)
  // … so turn 5's own "done" is not silenced
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, async () => 0, { locks: async () => [CONV], lastWords: () => ({ text: 'B', answered: true, turn: 5, turnAt: A + 9000 }), tell }), 1)
  assert.equal(rig.told.length, 3)
})

test('★★ safety net round 15: the reported turns outlive the team; no caution for a turn that started no subagent', async () => {
  const done = statusLabel('done') as string
  const SENT = Date.now() - 300_000
  const A = SENT + 1000
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const m = r.team.members[0]!
  const { rig, looks } = netRig([userInput(3, A), said(4, 'A done')], A + 10_000)
  rig.transcriptAt = A + 500
  // ★ an earlier turn used subagents, this one did not: no caution (agy review)
  stateAt(A + 600, { subagents: [{ status: 'failed', role: 'old' }] })
  rig.settled = false
  agyInstructionSent(m, SENT, { turn: 1, at: SENT - 9000 })
  await looks()
  assert.equal(rig.told.length, 1)
  assert.doesNotMatch(rig.told[0]!, /subagents|サブエージェント/)
  // ★ the team ends; the late "done" for that turn does not ring the phone (codex review)
  resetTeamsForTest()
  let pushed = 0
  const push = async (guard: () => boolean): Promise<number> => (guard() ? (pushed++, 1) : 0)
  assert.equal(await agyPhoneFallback(AGY, done, push, () => ({ turn: 3, at: A })), 1)
  assert.equal(pushed, 0)
  // … and a new team's leader is not told it again
  const r2 = createTeam(LEADER, [member], undefined)
  assert.ok(r2.ok)
  const told: string[] = []
  assert.equal(await agyMemberDone({ sessionId: AGY }, done, async () => 0, { locks: async () => [CONV], lastWords: () => ({ text: 'A done', answered: true, turn: 3, turnAt: A }), tell: async (_t, text) => (told.push(text), true) }), 1)
  assert.equal(told.length, 0)
})

test('★ safety net round 16: a stop or an error of a turn with subagents carries the caution; an error followed by a system message', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const m = r.team.members[0]!
  const SENT = Date.now() - 300_000
  const A = SENT + 1000
  // ★ a turn that started a worker, then stopped on a declined card: the caution comes with the stop (codex review)
  const { rig, looks } = netRig([userInput(3, A), ...launch(4), call(6)], A + 10_000)
  rig.transcriptAt = A + 500
  stateAt(A + 600)
  rig.settled = false
  agyInstructionSent(m, SENT, { turn: 1, at: SENT - 9000 })
  await looks()
  assert.equal(rig.told.length, 1)
  assert.match(rig.told[0]!, /without an answer|答えを出さずに/)
  assert.match(rig.told[0]!, /subagents|サブエージェント/)
  rig.settled = true

  // ★ a superseded turn whose error is followed by a child's system message: still an error (codex review)
  const B = rig.clock
  rig.records = [userInput(7, B), { type: 'ERROR_MESSAGE', step_index: 8 }, { type: 'SYSTEM_MESSAGE', step_index: 9 }, userInput(10, B + 3000, true), call(11)]
  rig.transcriptAt = B + 3500
  stateAt(B + 3600, { agent_state: 'working' })
  agyInstructionSent(m, B - 200, { turn: 3, at: A })
  rig.clock = B + 5000
  await looks()
  assert.equal(rig.told.length, 2)
  assert.match(rig.told[1]!, /with an error|エラーで/)
  assert.doesNotMatch(rig.told[1]!, /subagents|サブエージェント/)
})

test('★ safety net round 17/18: a child\'s message appended after the answer, with no new state, still ends the turn (whole seconds)', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const m = r.team.members[0]!
  // ★ whole seconds, as agy writes them; the answer and the idle state in the same second (codex · agy review)
  const SENT = Math.floor(Date.now() / 1000) * 1000 - 300_000
  const A = SENT + 1000
  const sys = (step: number, at: number): Record<string, unknown> => ({ type: 'SYSTEM_MESSAGE', step_index: step, created_at: new Date(at).toISOString() })
  const ans = (step: number, at: number, text: string): Record<string, unknown> => ({ ...said(step, text), created_at: new Date(at).toISOString() })
  const { rig, looks } = netRig([userInput(3, A), ans(4, A + 2000, 'A done'), sys(5, A + 2000)], A + 10_000)
  rig.transcriptAt = A + 2700
  stateAt(A + 2500)
  agyInstructionSent(m, SENT, { turn: 1, at: SENT - 9000 })
  await looks()
  assert.equal(rig.told.length, 1)
  assert.match(rig.told[0]!, /A done/)
  // ⚠️ the model's own record after the state, then a system one: not its end
  const B = rig.clock - (rig.clock % 1000)
  rig.records = [userInput(7, B), ans(8, B + 2000, 'B'), { ...call(9), created_at: new Date(B + 4000).toISOString() }, sys(10, B + 4000)]
  rig.transcriptAt = B + 4500
  stateAt(B + 2500)
  agyInstructionSent(m, B - 200, { turn: 3, at: A })
  rig.clock = B + 10_000
  await looks()
  assert.equal(rig.told.length, 1, 'a call after the state')
  // ⚠️ a state from before the send is not its end even with only system records after it
  rig.records = [userInput(7, B - 1000), ans(8, B - 1000, 'B'), sys(9, B)]
  stateAt(B - 300)
  rig.transcriptAt = B + 500
  agyInstructionSent(m, B - 100, { turn: 3, at: A })
  await looks()
  assert.equal(rig.told.length, 1, 'stale state')
  // ⚠️ the system records all older than the state's second: the later write is something not read yet
  const C = B + 20_000
  rig.records = [userInput(11, C), ans(12, C, 'C'), sys(13, C)]
  stateAt(C + 2500)
  rig.transcriptAt = C + 2700
  agyInstructionSent(m, C - 100, { turn: 7, at: B - 1000 })
  rig.clock = C + 10_000
  await looks()
  assert.equal(rig.told.length, 1, 'an older system record')
  // ★ an older system record, then a newer one after the state: its end (codex review)
  rig.records = [userInput(11, C), ans(12, C, 'C'), sys(13, C), sys(14, C + 3000)]
  rig.transcriptAt = C + 3200
  await looks()
  assert.equal(rig.told.length, 2)
  assert.match(rig.told[1]!, /C/)
})

test('★ safety net round 20: a record too large to read, then a child\'s message appended without a new state', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const m = r.team.members[0]!
  const SENT = Math.floor(Date.now() / 1000) * 1000 - 300_000
  const { rig, looks } = netRig([{ type: 'SYSTEM_MESSAGE', step_index: 9, created_at: new Date(SENT + 6000).toISOString() }], SENT + 10_000)
  rig.transcriptSize = 3 * 1024 * 1024
  rig.lastTurn = { turn: 5, at: SENT + 1000 }
  rig.transcriptAt = SENT + 6200
  stateAt(SENT + 5000)
  agyInstructionSent(m, SENT, { turn: 3, at: SENT - 9000 })
  await looks()
  assert.equal(rig.told.length, 1)
  assert.match(rig.told[0]!, /too large|大きすぎて/)
})

test('★★ safety net round 21: one state check for every path — a stale state with another agy; an oversized system record; a late system message after a dropped Enter or a rewind', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const m = r.team.members[0]!
  const SENT = Math.floor(Date.now() / 1000) * 1000 - 300_000
  const sys = (step: number, at: number): Record<string, unknown> => ({ type: 'SYSTEM_MESSAGE', step_index: step, created_at: new Date(at).toISOString() })
  // ⚠️ the idle state from before the send, the tagged turn working with no new state, another agy's visit: not told (codex review)
  const { rig, looks } = netRig([userInput(3, SENT + 1000), call(4)], SENT + 10_000)
  rig.transcriptAt = SENT + 2000
  stateAt(SENT - 500)
  rig.others = true
  agyInstructionSent(m, SENT, { turn: 1, at: SENT - 9000 })
  await looks()
  assert.equal(rig.told.length, 0, 'stale state')
  rig.others = false

  // ★ a system record larger than the tail after the idle state: told (codex review)
  const B = rig.clock - (rig.clock % 1000)
  rig.records = []
  rig.transcriptSize = 3 * 1024 * 1024
  rig.lastTurn = { turn: 5, at: B + 1000 }
  stateAt(B + 3000)
  rig.transcriptAt = B + 4000
  agyInstructionSent(m, B, { turn: 3, at: SENT + 1000 })
  rig.clock = B + 10_000
  await looks()
  assert.equal(rig.told.length, 1)
  rig.transcriptSize = 1000

  // ★ the Enter dropped, then a late system message without a new state: "not started" after a minute (agy review)
  const C = rig.clock - (rig.clock % 1000)
  rig.records = [userInput(7, C - 5000, true), { ...said(8, 'old'), created_at: new Date(C - 4500).toISOString() }, sys(9, C + 5000)]
  rig.lastTurn = { turn: 7, at: C - 5000 }
  stateAt(C - 4000)
  rig.transcriptAt = C + 5200
  agyInstructionSent(m, C, { turn: 7, at: C - 5000 }, '#22222222', C - 3500)
  rig.clock = C + 20_000
  await looks()
  assert.equal(rig.told.length, 1, 'not a minute yet')
  rig.clock = C + AGY_NET_NOT_STARTED_MS
  await looks()
  assert.equal(rig.told.length, 2)
  assert.match(rig.told[1]!, /not started|始めていません/)

  // ★ rewound away before the net saw it, then a system message without a new state: "cannot tell apart" (agy review)
  const D = rig.clock - (rig.clock % 1000)
  rig.records = [userInput(7, C - 5000, true), { ...said(8, 'old'), created_at: new Date(C - 4500).toISOString() }, sys(10, D + 4000)]
  stateAt(D + 3000)
  rig.transcriptAt = D + 4200
  agyInstructionSent(m, D, { turn: 7, at: C - 5000 }, '#33333333', D - 500)
  rig.clock = D + 10_000
  await looks()
  assert.equal(rig.told.length, 3)
  assert.match(rig.told[2]!, /cannot be told apart|区別できません/)

  // ★ every prompt rewound away, only a system message left after the idle state: "cannot tell apart"
  const E = rig.clock - (rig.clock % 1000)
  rig.records = [sys(1, E + 4000)]
  rig.lastTurn = undefined
  stateAt(E + 3000)
  rig.transcriptAt = E + 4200
  agyInstructionSent(m, E, { turn: 7, at: C - 5000 }, '#44444444', E - 500)
  rig.clock = E + 10_000
  await looks()
  assert.equal(rig.told.length, 4)
})

test('★ safety net round 22: a stalled phone push does not hold the member\'s report queue', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const m = r.team.members[0]!
  const SENT = Date.now() - 300_000
  const A = SENT + 1000
  const { rig, looks } = netRig([userInput(3, A), call(4)], A + 10_000)
  rig.transcriptAt = A + 500
  stateAt(A + 600)
  agyInstructionSent(m, SENT, { turn: 1, at: SENT - 9000 })
  // a "done" of an earlier turn that the leader did not get: its phone push never returns
  void agyMemberDone({ sessionId: AGY }, statusLabel('done') as string, () => new Promise<number>(() => {}), {
    locks: async () => [CONV],
    lastWords: () => ({ text: 'old', answered: true, turn: 1, turnAt: SENT - 9000 }),
    tell: async () => false,
  })
  await new Promise((res) => setTimeout(res, 10))
  await Promise.race([looks(), new Promise((_, rej) => setTimeout(() => rej(new Error('the net was held')), 2000))])
  assert.equal(rig.told.length, 1)
})

test('★ safety net round 23: the phone fallback is given the completion\'s own turn', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  ownState(CONV)
  const A = Date.now() - 100_000
  let got: { turn: number; at: number } | undefined
  assert.equal(
    await agyMemberDone({ sessionId: AGY }, statusLabel('done') as string, async (t) => ((got = t), 1), {
      locks: async () => [CONV],
      lastWords: () => ({ text: 'A', answered: true, turn: 3, turnAt: A }),
      tell: async () => false,
    }),
    1,
  )
  assert.deepEqual(got, { turn: 3, at: A })
})

test('★ safety net round 24: a failed lock probe hands the completion\'s own turn to the phone', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  ownState(CONV)
  const A = Date.now() - 100_000
  let got: { turn: number; at: number } | undefined
  assert.equal(
    await agyMemberDone({ sessionId: AGY }, statusLabel('done') as string, async (t) => ((got = t), 2), {
      locks: async () => undefined,
      lastWords: () => ({ text: 'A', answered: true, turn: 3, turnAt: A }),
      tell: async () => true,
    }),
    2,
  )
  assert.deepEqual(got, { turn: 3, at: A })
})

test('★★ the leader is told once when a member waits for an answer only the PC can give (docs/TEAM.md §9.3)', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const T = Date.now() - 60_000
  const { rig, deps } = netRig([userInput(3, T), call(4)], T + 10_000)
  stateAt(T + 1000)
  // a subagent's question with no card in the agent
  rig.questionAt = T + 2000
  await agyTeamPcWaits(deps)
  rig.clock += AGY_PC_WAIT_MS - 1
  await agyTeamPcWaits(deps)
  assert.equal(rig.told.length, 0, 'not yet')
  rig.clock += 1
  await agyTeamPcWaits(deps)
  assert.equal(rig.told.length, 1)
  assert.match(rig.told[0]!, /only the PC can answer|PC でしか答えられない/)
  assert.doesNotMatch(rig.told[0]!, /was notified|知らせました/, 'not claimed (the phone may not have been reached)')
  rig.clock += AGY_PC_WAIT_MS * 3
  await agyTeamPcWaits(deps)
  assert.equal(rig.told.length, 1, 'once per wait')
  // ★ a new wait is told again
  rig.questionAt = T + 50_000
  await agyTeamPcWaits(deps)
  rig.clock += AGY_PC_WAIT_MS
  await agyTeamPcWaits(deps)
  assert.equal(rig.told.length, 2)
  // ⚠️ a card for it in the agent (the leader's or the human's): not this
  rig.questionAt = T + 90_000
  rig.waiting = true
  await agyTeamPcWaits(deps)
  rig.clock += AGY_PC_WAIT_MS * 2
  await agyTeamPcWaits(deps)
  assert.equal(rig.told.length, 2)
  // … and once that card is gone (withdrawn), the time starts again from then
  rig.waiting = false
  await agyTeamPcWaits(deps)
  rig.clock += AGY_PC_WAIT_MS - 1
  await agyTeamPcWaits(deps)
  assert.equal(rig.told.length, 2, 'timed from when the card went')
  rig.clock += 1
  await agyTeamPcWaits(deps)
  assert.equal(rig.told.length, 3)
  rig.told.pop()
  // ⚠️ its own approval with no card yet, and the leader not reached: tried again after another while
  rig.questionAt = undefined
  stateAt(T + 95_000, { tool_confirmation_pending: true })
  rig.tellOk = false
  await agyTeamPcWaits(deps)
  rig.clock += AGY_PC_WAIT_MS
  await agyTeamPcWaits(deps)
  rig.tellOk = true
  rig.clock += 1
  await agyTeamPcWaits(deps)
  assert.equal(rig.told.length, 2)
  rig.clock += AGY_PC_WAIT_MS
  await agyTeamPcWaits(deps)
  assert.equal(rig.told.length, 3)
  // ⚠️ the recorded agy no longer holds the conversation: not told
  rig.questionAt = T + 120_000
  stateAt(T + 1000)
  rig.locks = [OTHER]
  await agyTeamPcWaits(deps)
  rig.clock += AGY_PC_WAIT_MS * 2
  await agyTeamPcWaits(deps)
  assert.equal(rig.told.length, 3)
})

test('★ PC-wait notice: a subagent\'s approval on the PC is told on its own, also behind a question already told (case 8)', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const T = Date.now() - 60_000
  const { rig, deps } = netRig([userInput(3, T), call(4)], T + 10_000)
  stateAt(T + 1000)
  // a child's question with no card, told
  rig.questionAt = T + 2000
  rig.questionCalls = ['kid-a:5:0:1']
  await agyTeamPcWaits(deps)
  rig.clock += AGY_PC_WAIT_MS
  await agyTeamPcWaits(deps)
  assert.equal(rig.told.length, 1)
  // another child blocks on a command (the wait time moves to it; the question's call stays)
  rig.blocked = [{ since: T + 40_000, id: 1 }]
  rig.questionAt = T + 40_000
  await agyTeamPcWaits(deps)
  rig.clock += AGY_PC_WAIT_MS
  await agyTeamPcWaits(deps)
  assert.equal(rig.told.length, 2, 'the approval is a wait of its own')
  rig.clock += AGY_PC_WAIT_MS * 3
  await agyTeamPcWaits(deps)
  assert.equal(rig.told.length, 2, 'once')
  // the question answered: the approval alone, its time also the wait time — not told again under another name
  rig.questionCalls = []
  await agyTeamPcWaits(deps)
  rig.clock += AGY_PC_WAIT_MS * 2
  await agyTeamPcWaits(deps)
  assert.equal(rig.told.length, 2)
  // ★ beta answered; gamma blocks, then delta 15 s later: gamma's time is not restarted by delta (codex review)
  rig.blocked = [{ since: T + 200_000, id: 2 }]
  rig.questionAt = T + 200_000
  await agyTeamPcWaits(deps)
  rig.clock += 15_000
  rig.blocked = [...rig.blocked, { since: T + 215_000, id: 3 }]
  rig.questionAt = T + 215_000
  await agyTeamPcWaits(deps)
  rig.clock += AGY_PC_WAIT_MS - 15_000
  await agyTeamPcWaits(deps)
  assert.equal(rig.told.length, 3, 'gamma told at its own 20 s')
  rig.clock += 15_000
  await agyTeamPcWaits(deps)
  assert.equal(rig.told.length, 4, 'delta at its own')
})

test('★ PC-wait notice: one wait told once — across state rewrites, overlapping questions, a passing card; and not when answered meanwhile', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const T = Date.now() - 60_000
  const { rig, deps } = netRig([userInput(3, T), call(4)], T + 10_000)
  const twice = async (): Promise<void> => {
    await agyTeamPcWaits(deps)
    rig.clock += AGY_PC_WAIT_MS
    await agyTeamPcWaits(deps)
  }
  // ★ its own approval: the state file rewritten (a resize) is the same wait (codex review)
  stateAt(T + 1000, { tool_confirmation_pending: true })
  await twice()
  assert.equal(rig.told.length, 1)
  stateAt(T + 5000, { tool_confirmation_pending: true })
  await twice()
  assert.equal(rig.told.length, 1, 'same call')
  // ★ question A told; B over it; B answered: A is not told again (codex review)
  stateAt(T + 6000)
  rig.questionAt = T + 7000
  await twice()
  assert.equal(rig.told.length, 2)
  rig.questionAt = T + 8000
  await twice()
  assert.equal(rig.told.length, 3)
  rig.questionAt = T + 7000
  await twice()
  assert.equal(rig.told.length, 3, 'A was told')
  // ★ a card that comes and goes does not make A new
  rig.waiting = true
  await twice()
  rig.waiting = false
  await twice()
  assert.equal(rig.told.length, 3)
  // ⚠️ answered while the leader's inbox is reached: not written (codex review)
  rig.questionAt = T + 9000
  await agyTeamPcWaits(deps)
  rig.clock += AGY_PC_WAIT_MS
  rig.onLocks = () => (rig.questionAt = undefined)
  await agyTeamPcWaits(deps)
  assert.equal(rig.told.length, 3)
})

test('★ PC-wait notice: a question wait named by its calls (a system record moving the time is the same wait); an approval past the tail is told too', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const T = Date.now() - 60_000
  const { rig, deps } = netRig([userInput(3, T), call(4)], T + 10_000)
  const twice = async (): Promise<void> => {
    await agyTeamPcWaits(deps)
    rig.clock += AGY_PC_WAIT_MS
    await agyTeamPcWaits(deps)
  }
  stateAt(T + 1000)
  rig.questionAt = T + 2000
  rig.questionCalls = ['k1:1:0:5']
  await twice()
  assert.equal(rig.told.length, 1)
  // a system record appended to the child's transcript: the time moves, the call does not (codex review)
  rig.questionAt = T + 3000
  await twice()
  assert.equal(rig.told.length, 1)
  // another call asking: a new wait
  rig.questionCalls = ['k1:1:0:5', 'k2:1:0:7']
  await twice()
  assert.equal(rig.told.length, 2)
  // ★ its own approval whose call is past the tail: told once (codex review: none was)
  rig.questionAt = undefined
  rig.records = [{ type: 'GENERIC', step_index: 9, content: 'big' }]
  stateAt(T + 9000, { tool_confirmation_pending: true })
  await twice()
  assert.equal(rig.told.length, 3)
  await twice()
  assert.equal(rig.told.length, 3)
})

test('★ PC-wait notice: per call — one of two told answered is not new; an unreadable approval told, over, then another: told again', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const T = Date.now() - 60_000
  const { rig, deps } = netRig([userInput(3, T), call(4)], T + 10_000)
  const twice = async (): Promise<void> => {
    await agyTeamPcWaits(deps)
    rig.clock += AGY_PC_WAIT_MS
    await agyTeamPcWaits(deps)
  }
  stateAt(T + 1000)
  rig.questionAt = T + 2000
  rig.questionCalls = ['a:1:0:5', 'b:1:0:7']
  await twice()
  assert.equal(rig.told.length, 1)
  // A answered: B alone is not a new wait (codex review)
  rig.questionCalls = ['b:1:0:7']
  await twice()
  assert.equal(rig.told.length, 1)
  // ★ an approval past the tail, told; over; a later one past the tail is told too (codex · agy review)
  rig.questionAt = undefined
  rig.questionCalls = undefined
  rig.records = [{ type: 'GENERIC', step_index: 9, content: 'big' }]
  stateAt(T + 9000, { tool_confirmation_pending: true })
  await twice()
  assert.equal(rig.told.length, 2)
  stateAt(T + 9500)
  await agyTeamPcWaits(deps)
  stateAt(T + 9800, { tool_confirmation_pending: true })
  await twice()
  assert.equal(rig.told.length, 3)
})

test('★ PC-wait notice: each wait timed on its own; a question and an approval both counted; an unread approval read at last is the same', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const T = Date.now() - 60_000
  const { rig, deps } = netRig([userInput(3, T), call(4)], T + 10_000)
  stateAt(T + 1000)
  rig.questionAt = T + 2000
  rig.questionCalls = ['a:1:0:5']
  await agyTeamPcWaits(deps)
  rig.clock += 15_000
  // B comes at 15 s: A is still told at 20 s (codex review: one timer restarted)
  rig.questionCalls = ['a:1:0:5', 'b:1:0:7']
  await agyTeamPcWaits(deps)
  rig.clock += 5_000
  await agyTeamPcWaits(deps)
  assert.equal(rig.told.length, 1, 'A at 20 s')
  rig.clock += 15_000
  await agyTeamPcWaits(deps)
  assert.equal(rig.told.length, 2, 'B at its own 20 s')
  // ★ an approval of its own beside the question, no card: told too (agy review: it was hidden behind the question)
  rig.records = [userInput(3, T), call(4)]
  stateAt(T + 3000, { tool_confirmation_pending: true })
  await agyTeamPcWaits(deps)
  rig.clock += AGY_PC_WAIT_MS
  await agyTeamPcWaits(deps)
  assert.equal(rig.told.length, 3)
  // ★ an approval told unread, then read (the same one): not told again (codex review)
  rig.questionAt = undefined
  rig.questionCalls = undefined
  stateAt(T + 4000)
  await agyTeamPcWaits(deps)
  rig.records = [{ type: 'GENERIC', step_index: 9, content: 'big' }]
  stateAt(T + 5000, { tool_confirmation_pending: true })
  await agyTeamPcWaits(deps)
  rig.clock += AGY_PC_WAIT_MS
  await agyTeamPcWaits(deps)
  assert.equal(rig.told.length, 4)
  rig.records = [userInput(10, T + 4500), call(11)]
  await agyTeamPcWaits(deps)
  rig.clock += AGY_PC_WAIT_MS * 2
  await agyTeamPcWaits(deps)
  assert.equal(rig.told.length, 4)
})

test('★ PC-wait notice: an approval told while readable, then pushed past the tail: the same one, not told again (codex review)', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const T = Date.now() - 60_000
  const { rig, deps } = netRig([userInput(3, T), call(4)], T + 10_000)
  stateAt(T + 1000, { tool_confirmation_pending: true })
  await agyTeamPcWaits(deps)
  rig.clock += AGY_PC_WAIT_MS
  await agyTeamPcWaits(deps)
  assert.equal(rig.told.length, 1)
  rig.records = [{ type: 'GENERIC', step_index: 9, content: 'big' }]
  await agyTeamPcWaits(deps)
  rig.clock += AGY_PC_WAIT_MS * 2
  await agyTeamPcWaits(deps)
  assert.equal(rig.told.length, 1)
})

test('★ PC-wait notice: a stale approval flag after the turn ended answered is not a wait (codex review)', async () => {
  const r = createTeam(LEADER, [member], undefined)
  assert.ok(r.ok)
  const T = Date.now() - 60_000
  const { rig, deps } = netRig([userInput(3, T), said(4, 'done')], T + 10_000)
  stateAt(T + 1000, { tool_confirmation_pending: true })
  await agyTeamPcWaits(deps)
  rig.clock += AGY_PC_WAIT_MS * 2
  await agyTeamPcWaits(deps)
  assert.equal(rig.told.length, 0)
})
