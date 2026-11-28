// ★ A Codex lead (2026-11-27 / docs/TEAM.md §10): bound to its row id, alive while its daemon lists the thread, told
//   through a queue that goes out as one new turn only when the lead is idle (user decision: never into its running turn).
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createTeam, leaderLive, resetTeamsForTest, sweepTeams, teamById, teamLedBy, type Team, type TeamDeps } from './team.ts'
import {
  codexLeadQueued,
  codexRowStatus,
  codexSnapshot,
  endTeam,
  flushCodexLead,
  resetCodexLeadQueuesForTest,
  sessionEnded,
  setCodexLeadDepsForTest,
  tellLeader,
} from './teamHooks.ts'

const PREFIX = 'codex-0123456789abcdef-'
const LEAD = `${PREFIX}01a21b76-a407-7fb2-ad45-77ed7bf38329`
const MEMBER = `${PREFIX}01a21b76-b0fc-7933-b930-80923d808092`
const settle = (): Promise<void> => new Promise((r) => setImmediate(r))

afterEach(() => {
  resetTeamsForTest()
  resetCodexLeadQueuesForTest()
  setCodexLeadDepsForTest(undefined)
})

function codexTeam(): Team {
  const r = createTeam({ tool: 'codex', sessionId: LEAD, account: '.codex' }, [{ sessionId: MEMBER, tool: 'codex', account: '.codex' }], undefined)
  assert.ok(r.ok)
  return r.team
}

function deps(listed: Set<string>): TeamDeps {
  return { procStart: () => null, sameProcStart: (a, b) => a === b, codexListed: (id) => listed.has(id) }
}

test('★ a Codex lead lives while its thread is listed; not listed refuses now but never ends the team', () => {
  const team = codexTeam()
  const listed = new Set([LEAD])
  assert.equal(leaderLive(team, deps(listed)), true)
  const ok = teamLedBy(LEAD, undefined, deps(listed))
  assert.ok(ok.ok && ok.team === team)
  listed.clear()
  assert.equal(leaderLive(team, deps(listed)), false)
  const r = teamLedBy(LEAD, undefined, deps(listed))
  assert.ok(!r.ok && r.reason === 'not-this-leader' && r.ended === undefined, 'a line reconnecting lists nothing: not "gone"')
  // ⚠️ "No process" (procStart null) is not a Codex lead's death: the sweep leaves it to the thread's close
  assert.deepEqual(sweepTeams(deps(listed), undefined).deadLeaders, [])
  assert.equal(leaderLive(team, { procStart: () => 'x', sameProcStart: () => true }), false, 'no lister ⇒ not alive (fail closed)')
})

test('★★ notices wait while the lead works and go out as one turn when it is idle', async () => {
  const team = codexTeam()
  const sent: string[] = []
  let busy = true
  setCodexLeadDepsForTest({
    listed: (id) => id === LEAD,
    send: async (id, text, guard) => {
      assert.equal(id, LEAD)
      if (busy) return { ok: false, reason: 'busy' }
      assert.equal(guard(), true)
      sent.push(text)
      return { ok: true }
    },
  })
  assert.equal(await tellLeader(team, '[nyan-team] m1 first'), true, 'queued = told')
  assert.equal(await tellLeader(team, '[nyan-team] m1 second'), true)
  await settle()
  assert.deepEqual(sent, [], 'never into a running turn')
  assert.deepEqual(codexLeadQueued(team), ['[nyan-team] m1 first', '[nyan-team] m1 second'])
  // the lead's status moves, but still working: nothing goes out
  codexRowStatus(LEAD, 'working')
  await settle()
  assert.deepEqual(sent, [])
  busy = false
  codexRowStatus(LEAD, 'done')
  await settle()
  assert.deepEqual(sent, ['[nyan-team] m1 first\n\n[nyan-team] m1 second'], 'both, in order, in one turn')
  assert.deepEqual(codexLeadQueued(team), [])
  // another member's status does not flush anything (and nothing waits)
  codexRowStatus(MEMBER, 'done')
  await settle()
  assert.equal(sent.length, 1)
})

test('★ a stale-prone notice (an approval) is dropped if it went stale while waiting; a report is not', async () => {
  const team = codexTeam()
  const sent: string[] = []
  let busy = true
  setCodexLeadDepsForTest({ listed: () => true, send: async (_id, text) => (busy ? { ok: false, reason: 'busy' } : (sent.push(text), { ok: true })) })
  let waiting = true
  let member = true
  assert.equal(await tellLeader(team, 'approval', () => waiting, { recheck: true }), true)
  assert.equal(await tellLeader(team, 'report', () => member), true)
  waiting = false // answered on the phone meanwhile
  member = false // the member left after its report was made
  busy = false
  await flushCodexLead(team)
  assert.deepEqual(sent, ['report'])
})

test('★ not told: a lead not listed, a guard false, or a team that ended; what was queued before it ended is kept (codex review ② r3 #5)', async () => {
  const team = codexTeam()
  let listed = false
  const sent: string[] = []
  setCodexLeadDepsForTest({ listed: () => listed, send: async (_id, text) => (sent.push(text), { ok: false, reason: 'busy' }) })
  assert.equal(await tellLeader(team, 'x'), false)
  listed = true
  assert.equal(await tellLeader(team, 'x', () => false), false)
  assert.equal(await tellLeader(team, 'kept'), true)
  endTeam(team, 'test')
  assert.equal(teamById(team.id), undefined)
  assert.deepEqual(codexLeadQueued(team), ['kept'], 'queued = told: still delivered to the open lead')
  assert.equal(await tellLeader(team, 'after'), false)
})

test('★ a complete snapshot without the lead\'s thread ends its team; one with it keeps it', () => {
  const team = codexTeam()
  codexSnapshot(PREFIX, new Set([LEAD, MEMBER]))
  assert.equal(teamById(team.id), team)
  codexSnapshot('codex-ffffffffffffffff-', new Set())
  assert.equal(teamById(team.id), team, 'another home says nothing about it')
  codexSnapshot(PREFIX, new Set([MEMBER]))
  assert.equal(teamById(team.id), undefined)
})

test('★ the guard right before the bytes: a team ended during the send is not told', async () => {
  const team = codexTeam()
  let seen: boolean | undefined
  setCodexLeadDepsForTest({
    listed: () => true,
    send: async (_id, _text, guard) => {
      endTeam(team, 'test')
      seen = guard()
      return { ok: false, reason: 'failed' }
    },
  })
  await tellLeader(team, 'x')
  await settle()
  assert.equal(seen, false)
})

test('★ a team\'s last word still reaches its Codex lead after the team is gone, with what waited; nothing new is queued (codex review ② r1 #11, r3 #5)', async () => {
  const team = codexTeam()
  const sent: string[] = []
  let busy = true
  setCodexLeadDepsForTest({ listed: () => true, send: async (_id, text) => (busy ? { ok: false, reason: 'busy' } : (sent.push(text), { ok: true })) })
  assert.equal(await tellLeader(team, 'report'), true)
  endTeam(team, 'test')
  assert.equal(await tellLeader(team, 'not final'), false)
  assert.equal(await tellLeader(team, 'the team ended', undefined, { final: true }), true)
  await settle()
  busy = false
  codexRowStatus(LEAD, 'done')
  await settle()
  assert.deepEqual(sent, ['report\n\nthe team ended'])
  assert.deepEqual(codexLeadQueued(team), [])
})

test('★ a stale approval waiting when the team ended is still dropped by its own check (only reports are kept)', async () => {
  const team = codexTeam()
  const sent: string[] = []
  let busy = true
  setCodexLeadDepsForTest({ listed: () => true, send: async (_id, text) => (busy ? { ok: false, reason: 'busy' } : (sent.push(text), { ok: true })) })
  await tellLeader(team, 'approval', () => teamById(team.id) === team, { recheck: true })
  await tellLeader(team, 'report')
  endTeam(team, 'test')
  busy = false
  await flushCodexLead(team)
  assert.deepEqual(sent, ['report'])
})

test('★ a notice queued from inside onStale survives the flush that dropped the stale one (codex review ② r3 #6)', async () => {
  const team = codexTeam()
  const sent: string[] = []
  let busy = true
  setCodexLeadDepsForTest({ listed: () => true, send: async (_id, text) => (busy ? { ok: false, reason: 'busy' } : (sent.push(text), { ok: true })) })
  let current = 'k1'
  const announce = (key: string): Promise<boolean> =>
    tellLeader(team, `card ${key}`, () => current === key, { recheck: true, onStale: () => void announce(current) })
  await announce('k1')
  current = 'k2'
  busy = false
  await flushCodexLead(team)
  await settle()
  await settle()
  assert.deepEqual(sent, ['card k2'])
  assert.deepEqual(codexLeadQueued(team), [])
})

test('★ a flush asked for during a send runs again when it settles (codex review ② r1 #12)', async () => {
  const team = codexTeam()
  const sent: string[] = []
  let release: (() => void) | undefined
  setCodexLeadDepsForTest({
    listed: () => true,
    send: async (_id, text) => {
      sent.push(text)
      if (sent.length === 1) await new Promise<void>((r) => (release = r))
      return { ok: true }
    },
  })
  await tellLeader(team, 'one')
  await settle()
  assert.deepEqual(sent, ['one'])
  await tellLeader(team, 'two') // arrives while 'one' is still being sent
  await settle()
  assert.deepEqual(sent, ['one'])
  release!()
  await settle()
  await settle()
  assert.deepEqual(sent, ['one', 'two'])
})

test('★ written but unanswered (timeout-unknown) is not sent again (codex review ② r1 #5)', async () => {
  const team = codexTeam()
  let calls = 0
  setCodexLeadDepsForTest({ listed: () => true, send: async () => (calls++, { ok: false, reason: 'failed', detail: 'timeout-unknown' }) })
  await tellLeader(team, 'x')
  await settle()
  await flushCodexLead(team)
  assert.equal(calls, 1)
  assert.deepEqual(codexLeadQueued(team), [])
})

test('★ written, then the line went away (closed-unknown) is not sent again either (codex review ② r2 #5)', async () => {
  const team = codexTeam()
  let calls = 0
  setCodexLeadDepsForTest({ listed: () => true, send: async () => (calls++, { ok: false, reason: 'failed', detail: 'closed-unknown' }) })
  await tellLeader(team, 'x')
  await settle()
  await flushCodexLead(team)
  assert.equal(calls, 1)
  assert.deepEqual(codexLeadQueued(team), [])
})

test('★ a lead whose thread is confirmed closed gets nothing more: its gone team\'s last word is dropped too (codex review ② r2 #4)', async () => {
  for (const close of ['ended', 'snapshot'] as const) {
    const team = codexTeam()
    let listed = true
    setCodexLeadDepsForTest({ listed: () => listed, send: async () => ({ ok: false, reason: 'busy' }) })
    endTeam(team, 'test')
    assert.equal(await tellLeader(team, 'the team ended', undefined, { final: true }), true)
    assert.deepEqual(codexLeadQueued(team), ['the team ended'])
    listed = false
    if (close === 'ended') sessionEnded(LEAD)
    else codexSnapshot(PREFIX, new Set([MEMBER]))
    assert.deepEqual(codexLeadQueued(team), [], close)
    resetTeamsForTest()
  }
})

test('★ a notice dropped as stale tells its sender (onStale), once (codex review ② r2 #6)', async () => {
  const team = codexTeam()
  let busy = true
  const sent: string[] = []
  setCodexLeadDepsForTest({ listed: () => true, send: async (_id, text) => (busy ? { ok: false, reason: 'busy' } : (sent.push(text), { ok: true })) })
  let still = true
  let stale = 0
  assert.equal(await tellLeader(team, 'card r1', () => still, { recheck: true, onStale: () => stale++ }), true)
  still = false
  busy = false
  await flushCodexLead(team)
  await flushCodexLead(team)
  assert.equal(stale, 1)
  assert.deepEqual(sent, [])
})

test('★ the team\'s last word waits while the lead is briefly unlisted (a reconnect), and goes when it is back (codex review ② r6 #3)', async () => {
  const team = codexTeam()
  let listed = false
  const sent: string[] = []
  setCodexLeadDepsForTest({ listed: () => listed, send: async (_id, text) => (listed ? (sent.push(text), { ok: true }) : { ok: false, reason: 'not-listed' }) })
  endTeam(team, 'test')
  assert.equal(await tellLeader(team, 'the team ended', undefined, { final: true }), true)
  assert.equal(await tellLeader(team, 'a report', undefined), false, 'only the last word waits for an unlisted lead')
  listed = true
  codexRowStatus(LEAD, 'idle')
  await settle()
  assert.deepEqual(sent, ['the team ended'])
})

test('★ a lead stopped on an error or a plan limit is not told (the phone rings instead); its last word still waits (codex review ② r9 #2)', async () => {
  const team = codexTeam()
  let stopped = true
  setCodexLeadDepsForTest({ listed: () => true, stopped: () => stopped, send: async () => ({ ok: false, reason: 'busy' }) })
  assert.equal(await tellLeader(team, 'm1 is done'), false)
  stopped = false
  assert.equal(await tellLeader(team, 'm1 is done'), true)
  stopped = true
  endTeam(team, 'test')
  assert.equal(await tellLeader(team, 'the team ended', undefined, { final: true }), true)
})

test('★ notices with no phone fallback (a member left, the delegation ended) still wait for a stopped lead (codex review ② r11 #1)', async () => {
  const team = codexTeam()
  setCodexLeadDepsForTest({ listed: () => true, stopped: () => true, send: async () => ({ ok: false, reason: 'busy' }) })
  assert.equal(await tellLeader(team, 'm2 left', undefined, { waitForStopped: true }), true)
  assert.equal(await tellLeader(team, 'm1 is done'), false)
  assert.deepEqual(codexLeadQueued(team), ['m2 left'])
})

test('★ a member\'s departure waits for a lead briefly unlisted (a reconnect) while its team lasts (codex review ② r12 #1)', async () => {
  const team = codexTeam()
  let listed = false
  const sent: string[] = []
  setCodexLeadDepsForTest({ listed: () => listed, send: async (_id, text) => (listed ? (sent.push(text), { ok: true }) : { ok: false, reason: 'not-listed' }) })
  assert.equal(await tellLeader(team, 'm2 left', undefined, { waitForStopped: true }), true)
  await settle()
  assert.deepEqual(sent, [])
  listed = true
  codexRowStatus(LEAD, 'idle')
  await settle()
  assert.deepEqual(sent, ['m2 left'])
})
