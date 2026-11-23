// ★★ agy members of a team (2026-11-22 / docs/TEAM.md §9): who the member is now, its waits, its turn-end report.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, test } from 'node:test'
import { statusLabel, type PermissionRequest } from '../../shared/types.ts'
import { aliveProcStartFreshSync } from './claude/sessionIndex.ts'
import { createTeam, resetTeamsForTest } from './team.ts'
import { untilNextSecondMs } from './routes/team.ts'
import { answer, resetPending, waitForDecision } from './permission.ts'
import { agyCardsChanged, codexCardsChanged, agyLastWords, agyMemberDone, agyStateNow, leaderMay, memberIdentity, cardRef, soleProcessSync, type AgyDoneDeps } from './teamHooks.ts'

const root = mkdtempSync(join(tmpdir(), 'nr-team-agy-'))
const prevState = process.env['NYAN_REMOTE_STATE_DIR']
process.env['NYAN_REMOTE_STATE_DIR'] = root
mkdirSync(join(root, 'agy'), { recursive: true })
after(() => {
  if (prevState === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
  else process.env['NYAN_REMOTE_STATE_DIR'] = prevState
  rmSync(root, { recursive: true, force: true })
})
afterEach(() => resetTeamsForTest())

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
  assert.deepEqual(agyLastWords(AGY, tail([prompt, { type: 'PLANNER_RESPONSE', step_index: 4, content: '  Done: 3 files  ' }])), { text: 'Done: 3 files' })
  assert.deepEqual(agyLastWords(AGY, tail([prompt, { type: 'PLANNER_RESPONSE', step_index: 4, tool_calls: [{ name: 'run_command', args: {} }] }])), { text: undefined })
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
  void waitForDecision({ ...card('agy:third#1'), origin: 'agy:other-call' }, () => {}, { toolInput: { command: 'date' }, requestedAt: Date.now(), agyPid: ME })
  agyCardsChanged(failing)
  await new Promise((res) => setTimeout(res, 30))
  agyCardsChanged(deps)
  await new Promise((res) => setTimeout(res, 30))
  assert.equal(told.length, 2)
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
