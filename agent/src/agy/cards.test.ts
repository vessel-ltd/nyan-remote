import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SessionSummary } from '../../../shared/types.ts'
import { answer, listPending, resetPending } from '../permission.ts'
import { resetAutoApprove, setAutoApprove } from '../autoApprove.ts'
import { resetAgyGrantOwners, setAgyGrantOwner } from './grants.ts'
import { answerPermission } from '../routes/permission.ts'
import { AgyCards, agyCard, agyCardTool, agyDelivery, agyDeliveryMessage, type AgyCardDeps } from './cards.ts'
import type { AgyCardMark } from './keys.ts'
import { transcriptPathOf } from './sessions.ts'

const A = '062a8f25-9451-42f3-ae93-34a208e99365'
const PID = 4242
const START = '123456'
const BASE = Math.floor(Date.now() / 1000)
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

const row = (over: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    machine: 'pc-a',
    account: 'agy',
    tool: 'agy',
    sessionId: `agy-${A}`,
    cwd: '/home/user/p',
    project: 'p',
    title: 'p',
    titleSource: 'fallback',
    status: 'waiting',
    live: true,
    sendRoute: 'keys',
    lastActivity: new Date().toISOString(),
    ...over,
  }) as SessionSummary

test('only the measured cards reach the phone: a command (Bash) and a file read (Read)', () => {
  assert.deepEqual(agyCardTool({ name: 'run_command', args: { CommandLine: 'ls -la', WaitMsBeforeAsync: 5000 } }), { toolName: 'Bash', input: { command: 'ls -la' } })
  assert.deepEqual(agyCardTool({ name: 'read_file', args: { Path: '/etc/hostname' } }), { toolName: 'Read', input: { file_path: '/etc/hostname' } })
  for (const name of ['write_file', 'edit_file', 'search_web', 'something_new']) assert.equal(agyCardTool({ name, args: { Path: '/x' } }), undefined, name)
  assert.equal(agyCardTool({ name: 'run_command', args: { CommandLine: 7 } }), undefined)
  assert.equal(agyCardTool({ name: 'run_command', args: { CommandLine: '' } }), undefined)
  assert.deepEqual(agyCardTool({ name: 'run_command', args: { CommandLine: 'ls', Cwd: '/srv/other' } }), { toolName: 'Bash', input: { command: 'ls', cwd: '/srv/other' } })
  assert.equal(agyCardTool({ name: 'run_command', args: { CommandLine: 'ls', Cwd: 7 } }), undefined)
})

test('a card: the agy row, the command and where it runs; the key changes with the status file, the origin does not', () => {
  const mark: AgyCardMark = { pid: PID, stateMtimeMs: 1000, step: 3, index: 1, callAt: (BASE - 60) * 1000 }
  const call = { step: 3, index: 1, name: 'run_command', args: { CommandLine: 'rm -rf build' } }
  const c = agyCard(row(), mark, call, '2026-11-20T00:00:00.000Z')!
  assert.equal(c.tool, 'agy')
  assert.equal(c.toolName, 'Bash')
  assert.equal(c.summary, 'rm -rf build')
  assert.equal(c.cwd, '/home/user/p')
  assert.equal(c.sessionId, `agy-${A}`)
  assert.equal(c.account, 'agy')
  assert.match(c.key, /^agy:/)
  const again = agyCard(row(), { ...mark, stateMtimeMs: 2000 }, call, '2026-11-20T00:00:00.000Z')!
  assert.notEqual(again.key.split('#')[0], c.key.split('#')[0])
  assert.equal(again.origin, c.origin)
  // ⚠️ a direction-changing character is flagged (the phone marks it)
  assert.equal(agyCard(row(), mark, { ...call, args: { CommandLine: 'cat a‮txt' } }, 'x')!.hidden, true)
  // ★ the call's own directory wins over the agy's folder (and is not part of the command text)
  const there = agyCard(row(), mark, { ...call, args: { CommandLine: 'rm -rf build', Cwd: '/srv/other' } }, 'x')!
  assert.equal(there.cwd, '/srv/other')
  assert.equal(there.summary, 'rm -rf build')
  assert.equal(agyCard(row(), mark, { ...call, args: { CommandLine: 'ls', Cwd: '/srv/\u202Eevil' } }, 'x')!.hidden, true)
  // a read: no directory
  assert.equal(agyCard(row(), mark, { ...call, name: 'read_file', args: { Path: '/etc/hostname' } }, 'x')!.cwd, undefined)
  assert.equal(agyCard(row(), mark, { ...call, name: 'write_file' }, 'x'), undefined)
})

interface Lab {
  deps: AgyCardDeps
  answers: { conv: string; mark: AgyCardMark; behavior: string }[]
  changes: () => number
  setState(over: Record<string, unknown>, mtimeSec?: number): void
  transcript: string
  result: { value: { ok: true } | { ok: false; reason: 'changed' } }
  logs: string[]
}

function lab(t: { after(fn: () => void): void }, opts: { pane?: boolean } = {}): Lab {
  const root = mkdtempSync(join(tmpdir(), 'nyan-agy-cards-'))
  const prev = process.env.NYAN_REMOTE_STATE_DIR
  process.env.NYAN_REMOTE_STATE_DIR = root
  const dir = join(root, 'agy')
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(root, 'panes'), { recursive: true })
  const home = join(root, 'home')
  const transcript = transcriptPathOf(A, home)
  mkdirSync(join(transcript, '..'), { recursive: true })
  writeFileSync(transcript, JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nhi\n</USER_REQUEST>' }) + '\n')
  writeFileSync(transcript, JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: new Date((BASE - 60) * 1000).toISOString(), tool_calls: [{ name: 'run_command', args: { CommandLine: 'ls' } }] }) + '\n', { flag: 'a' })
  const stateFile = join(dir, `session-${A}.json`)
  const setState = (over: Record<string, unknown>, mtimeSec = BASE): void => {
    const body = JSON.stringify({ nyanPid: PID, nyanBusyAt: BASE, input: { conversation_id: A, cwd: '/home/user/p', agent_state: 'tool_use', tool_confirmation_pending: true, ...over } })
    for (const f of [stateFile, join(dir, `pid-${PID}.json`)]) {
      writeFileSync(f, body)
      utimesSync(f, mtimeSec, mtimeSec)
    }
  }
  setState({})
  if (opts.pane !== false) {
    writeFileSync(join(root, 'panes', `${PID}.json`), JSON.stringify({ pid: PID, procStart: START, socket: join(root, 'k.sock'), startedAt: (BASE - 1000) * 1000, paste: true }))
  }
  t.after(() => {
    resetPending()
    if (prev === undefined) delete process.env.NYAN_REMOTE_STATE_DIR
    else process.env.NYAN_REMOTE_STATE_DIR = prev
    rmSync(root, { recursive: true, force: true })
  })
  const answers: Lab['answers'] = []
  let changes = 0
  const result: Lab['result'] = { value: { ok: true } }
  const logs: string[] = []
  const deps: AgyCardDeps = {
    agy: () => ({ dir, home, isAgy: (p) => p === PID, now: Date.now(), aliveProcStart: (p) => (p === PID ? START : null), locksOf: (p) => (p === PID ? [A] : []) }),
    machine: 'pc-a',
    answer: async (conv, mark, behavior) => {
      answers.push({ conv, mark, behavior })
      return result.value
    },
    changed: () => changes++,
    now: () => new Date('2026-11-20T00:00:00Z'),
    log: (l) => logs.push(l),
  }
  return { deps, answers, changes: () => changes, setState, transcript, result, logs }
}

const agyCards = () => listPending().filter((p) => p.tool === 'agy')

test('★★ a card up on the PC comes to the phone; the phone’s answer goes out once, for that card', async (t) => {
  const l = lab(t)
  const cards = new AgyCards(l.deps)
  await cards.sync()
  const [c] = agyCards()
  assert.equal(c?.summary, 'ls')
  assert.equal(l.changes(), 1)
  // the same card stays one card
  await cards.sync()
  assert.equal(agyCards().length, 1)
  assert.equal(answer(c!.key, 'allow'), true)
  await settle()
  assert.deepEqual(l.answers, [{ conv: A, mark: { pid: PID, stateMtimeMs: BASE * 1000, step: 1, index: 0, callAt: (BASE - 60) * 1000 }, behavior: 'allow' }])
  // ⚠️ rule 4: not raised again while the same card is still up (the status file has not moved yet)
  await cards.sync()
  assert.equal(agyCards().length, 0)
  assert.match(l.logs.join('\n'), /card allow conversation=062a8f25 typed/)
  assert.doesNotMatch(l.logs.join('\n'), /\bls\b/, 'no command text in the log')
})

test('★★ a card answered on the PC (or the turn moved on) is withdrawn; the next call is a new card', async (t) => {
  const l = lab(t)
  const cards = new AgyCards(l.deps)
  await cards.sync()
  const first = agyCards()[0]!
  // answered on the PC: agy is working again
  l.setState({ agent_state: 'working', tool_confirmation_pending: false }, BASE + 1)
  await cards.sync()
  assert.equal(agyCards().length, 0)
  assert.equal(answer(first.key, 'allow'), false, 'the old card cannot be answered')
  // the next card (status file written again)
  l.setState({}, BASE + 2)
  await cards.sync()
  const second = agyCards()[0]!
  assert.notEqual(second.key, first.key)
  assert.equal(l.answers.length, 0)
  // a deny is a deny
  answer(second.key, 'deny')
  await settle()
  assert.equal(l.answers[0]?.behavior, 'deny')
})

test('an answer whose key did not go out lets the card come back (when it is still up)', async (t) => {
  const l = lab(t)
  l.result.value = { ok: false, reason: 'changed' }
  const cards = new AgyCards(l.deps)
  await cards.sync()
  const key = agyCards()[0]!.key
  answer(key, 'allow')
  await settle()
  await cards.sync()
  assert.equal(agyCards().length, 1)
  // ★ the same key: the phone keeps the reason it showed on this card
  assert.equal(agyCards()[0]!.key, key)
  assert.match(l.logs.join('\n'), /not typed \(changed\)/)
})

test('no card: an agy not started through the relay, a card the phone cannot answer, a call already done', async (t) => {
  const noPane = lab(t, { pane: false })
  await new AgyCards(noPane.deps).sync()
  assert.equal(agyCards().length, 0)
  resetPending()

  const l = lab(t)
  appendFileSync(l.transcript, JSON.stringify({ step_index: 2, type: 'GENERIC', content: 'x' }) + '\n')
  appendFileSync(l.transcript, JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', created_at: new Date((BASE - 60) * 1000).toISOString(), tool_calls: [{ name: 'write_file', args: { Path: '/x', Content: 'y' } }] }) + '\n')
  const cards = new AgyCards(l.deps)
  await cards.sync()
  await cards.sync()
  assert.equal(agyCards().length, 0)
  assert.equal(l.logs.filter((x) => x.includes('cannot answer')).length, 1, 'said once per card')
  // every call has its result: nothing pending
  appendFileSync(l.transcript, JSON.stringify({ step_index: 4, type: 'GENERIC', content: 'x' }) + '\n')
  l.setState({}, BASE + 1)
  await cards.sync()
  assert.equal(agyCards().length, 0)
})

test('a denial with a reason is refused for an agy card (one key cannot carry it); without one it goes', async (t) => {
  const l = lab(t)
  await new AgyCards(l.deps).sync()
  const key = agyCards()[0]!.key
  const r = answerPermission({ key, behavior: 'deny', feedback: 'do X instead' }, 'test')
  assert.equal(r.ok, false)
  assert.match(r.reason ?? '', /reason|理由/)
  assert.equal(agyCards().length, 1, 'the card is still there')
  assert.equal(answerPermission({ key, behavior: 'deny' }, 'test').ok, true)
  await settle()
  assert.equal(l.answers[0]?.behavior, 'deny')
})

test('★ the answer route can wait for the key: delivered, not delivered (and why), or the card went away', async (t) => {
  const l = lab(t)
  const cards = new AgyCards(l.deps)
  await cards.sync()
  let key = agyCards()[0]!.key
  let d = agyDelivery(key)!
  answer(key, 'allow')
  assert.deepEqual(await d, { ok: true })
  await settle()
  assert.equal(agyDelivery(key), undefined, 'forgotten once settled')
  // a key that did not go out: the route says so
  l.result.value = { ok: false, reason: 'changed' }
  l.setState({}, BASE + 1)
  await cards.sync()
  key = agyCards()[0]!.key
  d = agyDelivery(key)!
  answer(key, 'deny')
  assert.deepEqual(await d, { ok: false, reason: 'changed' })
  assert.match(agyDeliveryMessage('changed'), /PC/)
  // withdrawn without an answer
  await settle()
  l.setState({ agent_state: 'working', tool_confirmation_pending: false }, BASE + 2)
  const before = agyCards()[0]
  assert.ok(before, 'the card came back after the failed key')
  const pendingDelivery = agyDelivery(before.key)
  await cards.sync()
  assert.equal(await pendingDelivery, undefined)
  assert.equal(agyCards().length, 0)
})

test('★ no card while another running agy shows the same conversation (the card could be the other one’s)', async (t) => {
  const l = lab(t)
  const deps = l.deps.agy()
  writeFileSync(join(deps.dir, 'pid-777.json'), JSON.stringify({ nyanPid: 777, nyanBusyAt: 0, input: { conversation_id: A, cwd: '/home/user/q', agent_state: 'idle' } }))
  // written before this card's call (it wrote nothing during the card)
  utimesSync(join(deps.dir, 'pid-777.json'), BASE - 120, BASE - 120)
  const both: AgyCardDeps = { ...l.deps, agy: () => ({ ...l.deps.agy(), isAgy: (p) => p === PID || p === 777 }) }
  await new AgyCards(both).sync()
  assert.equal(agyCards().length, 0)
  // ⚠️ that agy moved on (a `/new` at an empty prompt writes no file yet, but holds the new conversation's lock)
  const movedOn: AgyCardDeps = { ...both, agy: () => ({ ...both.agy(), locksOf: (p) => (p === PID ? [A] : p === 777 ? ['ffffffff-ffff-4fff-8fff-ffffffffffff'] : []) }) }
  await new AgyCards(movedOn).sync()
  assert.equal(agyCards().length, 1)
  resetPending()
  // ★ but an agy that wrote during this card and then left or moved on (its call or result may be in the transcript)
  //   still counts: its visit mark stays
  const visit = join(deps.dir, `visit-${A}-777`)
  writeFileSync(visit, '')
  utimesSync(visit, BASE - 10, BASE - 10)
  await new AgyCards({ ...l.deps, agy: () => ({ ...l.deps.agy(), isAgy: (p) => p === PID }) }).sync()
  assert.equal(agyCards().length, 0)
  await new AgyCards(movedOn).sync()
  assert.equal(agyCards().length, 0)
  // its visit was before this card's call: the card comes
  utimesSync(visit, BASE - 120, BASE - 120)
  await new AgyCards(l.deps).sync()
  assert.equal(agyCards().length, 1)
  // this agy's own visit mark never counts
  resetPending()
  const mine = join(deps.dir, `visit-${A}-${PID}`)
  writeFileSync(mine, '')
  await new AgyCards(l.deps).sync()
  assert.equal(agyCards().length, 1)
})

test('★★ a card needs agy’s own lock on the conversation; it comes from this agy’s own file (a second agy cannot hide it)', async (t) => {
  const l = lab(t)
  // a status line that stopped, then a `/resume` elsewhere: the lock moved
  await new AgyCards({ ...l.deps, agy: () => ({ ...l.deps.agy(), locksOf: () => ['ffffffff-ffff-4fff-8fff-ffffffffffff'] }) }).sync()
  assert.equal(agyCards().length, 0)
  await new AgyCards({ ...l.deps, agy: () => ({ ...l.deps.agy(), locksOf: () => undefined }) }).sync()
  assert.equal(agyCards().length, 0)
  // a second agy overwrote the conversation's file and exited: this agy's own file still says the card is up
  const deps = l.deps.agy()
  writeFileSync(join(deps.dir, `session-${A}.json`), JSON.stringify({ nyanPid: 777, nyanBusyAt: 0, input: { conversation_id: A, cwd: '/home/user/q', agent_state: 'idle' } }))
  await new AgyCards(l.deps).sync()
  assert.equal(agyCards().length, 1)
  assert.equal(agyCards()[0]!.cwd, '/home/user/p')
})

test('★★ a call newer than the agy’s "card is up" state is not its card (another agy left it behind)', async (t) => {
  const l = lab(t)
  // a second agy's turn: its call came after this agy's card (declined on the PC, then that agy left)
  appendFileSync(l.transcript, JSON.stringify({ step_index: 2, type: 'USER_INPUT', content: 'x' }) + '\n')
  appendFileSync(l.transcript, JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', created_at: new Date((BASE + 30) * 1000).toISOString(), tool_calls: [{ name: 'run_command', args: { CommandLine: 'rm -rf /tmp/x' } }] }) + '\n')
  await new AgyCards(l.deps).sync()
  assert.equal(agyCards().length, 0)
})

test('★ a key that went out but left the same card up (no acknowledgement) brings the card back', async (t) => {
  const l = lab(t)
  const reraised: string[] = []
  const cards = new AgyCards({ ...l.deps, unconfirmedMs: 40, reraised: (c, card) => reraised.push(`${c}@${card}`) })
  await cards.sync()
  answer(agyCards()[0]!.key, 'allow')
  await settle()
  await cards.sync()
  assert.equal(agyCards().length, 0, 'not at once')
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(agyCards().length, 1)
  assert.deepEqual(reraised, [`${A}@${new Date(BASE * 1000).toISOString()}`], 'the notifier is told which card (it owes a fresh "needs you")')
  assert.match(l.logs.join('\n'), /still up after the key; shown again/)
  // answered for real (the state moved): nothing comes back
  resetPending()
  const c2 = new AgyCards({ ...l.deps, unconfirmedMs: 40 })
  await c2.sync()
  answer(agyCards()[0]!.key, 'allow')
  await settle()
  l.setState({ agent_state: 'working', tool_confirmation_pending: false }, BASE + 5)
  await c2.sync()
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(agyCards().length, 0)
})

test('★ a lock probe that fails keeps the card on the phone as it is (same key), raising none new', async (t) => {
  const l = lab(t)
  const cards = new AgyCards(l.deps)
  await cards.sync()
  const unsure = new AgyCards({ ...l.deps, agy: () => ({ ...l.deps.agy(), locksOf: () => undefined }) })
  await unsure.sync()
  assert.equal(agyCards().length, 1, 'another instance raises none while it cannot tell')
  // the same instance, probe failing for a look: the card stays with its key
  const flaky = { fail: false }
  const c2deps: AgyCardDeps = { ...l.deps, agy: () => ({ ...l.deps.agy(), locksOf: (p: number) => (flaky.fail ? undefined : p === PID ? [A] : []) }) }
  resetPending()
  const c2 = new AgyCards(c2deps)
  await c2.sync()
  const k2 = agyCards()[0]!.key
  flaky.fail = true
  await c2.sync()
  flaky.fail = false
  await c2.sync()
  assert.equal(agyCards().length, 1)
  assert.equal(agyCards()[0]!.key, k2)
})

test('★ a second agy whose lock cannot be told keeps the card as it is (neither withdrawn nor re-keyed)', async (t) => {
  const l = lab(t)
  const deps = l.deps.agy()
  writeFileSync(join(deps.dir, 'pid-777.json'), JSON.stringify({ nyanPid: 777, nyanBusyAt: 0, input: { conversation_id: A, cwd: '/home/user/q', agent_state: 'idle' } }))
  utimesSync(join(deps.dir, 'pid-777.json'), BASE - 120, BASE - 120)
  const probe = { fail: false }
  const c = new AgyCards({ ...l.deps, agy: () => ({ ...l.deps.agy(), isAgy: (p) => p === PID || p === 777, locksOf: (p) => (p === PID ? [A] : probe.fail ? undefined : ['ffffffff-ffff-4fff-8fff-ffffffffffff']) }) })
  await c.sync()
  const key = agyCards()[0]!.key
  probe.fail = true
  await c.sync()
  probe.fail = false
  await c.sync()
  assert.equal(agyCards().length, 1)
  assert.equal(agyCards()[0]!.key, key)
})

// ── auto-approve (2026-11-20 / docs/AGY.md §10, rule 5b) ──────────────────────────────────────────────────────────

/** On, given to the lab's agy (its pid and relay registration, as the route sets it) */
async function autoOn(t: { after(fn: () => void): void }, owner = { pid: PID, startedAt: (BASE - 1000) * 1000 }): Promise<void> {
  resetAutoApprove()
  resetAgyGrantOwners()
  t.after(() => {
    resetAutoApprove()
    resetAgyGrantOwners()
  })
  setAgyGrantOwner(A, owner)
  const r = await setAutoApprove(`agy-${A}`, true)
  assert.equal(r.ok, true)
}

test('★★ auto-approve: a card the phone could answer is answered `1` here, never shown on the phone, and is quiet', async (t) => {
  const l = lab(t)
  await autoOn(t)
  const cards = new AgyCards({ ...l.deps, unconfirmedMs: 10_000 })
  await cards.sync()
  await settle()
  assert.equal(agyCards().length, 0, 'not on the phone')
  assert.equal(l.answers.length, 1)
  assert.equal(l.answers[0]!.behavior, 'allow')
  assert.equal(l.answers[0]!.mark.step, 1)
  assert.equal(cards.autoAnswering(A, new Date(BASE * 1000).toISOString()), true, 'the notifier does not ring it')
  assert.equal(cards.autoAnswering(A, new Date((BASE + 1) * 1000).toISOString()), false, 'another card is not quiet')
  assert.ok(l.logs.some((x) => /auto-approve/.test(x) && !/ls/.test(x)), 'logged, without the command')
  // the same card is typed once
  await cards.sync()
  await settle()
  assert.equal(l.answers.length, 1)
  // ★ the next card (the next call, a new state write) is answered too
  appendFileSync(l.transcript, JSON.stringify({ step_index: 2, type: 'GENERIC', content: `Created At: ${new Date((BASE - 50) * 1000).toISOString()}\nok` }) + '\n')
  appendFileSync(l.transcript, JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', created_at: new Date((BASE - 40) * 1000).toISOString(), tool_calls: [{ name: 'run_command', args: { CommandLine: 'pwd' } }] }) + '\n')
  l.setState({}, BASE + 5)
  await cards.sync()
  await settle()
  assert.equal(l.answers.length, 2)
  assert.equal(l.answers[1]!.mark.step, 3)
  // ⚠️ the same call again under a new state write (a resize after a byte the relay dropped): never typed twice — the phone's
  l.setState({}, BASE + 6)
  await cards.sync()
  await settle()
  assert.equal(l.answers.length, 2)
  assert.equal(agyCards().length, 1)
})

test('★★ auto-approve: a key that does not land sends that card to the phone (and rings it); it is not typed again', async (t) => {
  const l = lab(t)
  await autoOn(t)
  l.result.value = { ok: false, reason: 'unreachable' } as never
  const reraised: string[] = []
  const cards = new AgyCards({ ...l.deps, unconfirmedMs: 10_000, reraised: (c, card) => reraised.push(`${c}@${card}`) })
  await cards.sync()
  await settle()
  await cards.sync()
  await settle()
  assert.equal(l.answers.length, 1, 'typed once')
  assert.equal(agyCards().length, 1, 'now on the phone')
  assert.deepEqual(reraised, [`${A}@${new Date(BASE * 1000).toISOString()}`])
  assert.equal(cards.autoAnswering(A, new Date(BASE * 1000).toISOString()), false, 'it rings')
})

test('★★ auto-approve: a card still up after the key goes to the phone', async (t) => {
  const l = lab(t)
  await autoOn(t)
  const reraised: string[] = []
  const cards = new AgyCards({ ...l.deps, unconfirmedMs: 40, reraised: (c, card) => reraised.push(`${c}@${card}`) })
  await cards.sync()
  await new Promise((r) => setTimeout(r, 120))
  await cards.sync()
  assert.equal(l.answers.length, 1)
  assert.equal(agyCards().length, 1)
  assert.equal(reraised.length, 1)
})

test('★ auto-approve: a card the phone cannot answer is never typed at (it stays on the PC and is not quiet)', async (t) => {
  const l = lab(t)
  await autoOn(t)
  writeFileSync(
    l.transcript,
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nhi\n</USER_REQUEST>' }) +
      '\n' +
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: new Date((BASE - 60) * 1000).toISOString(), tool_calls: [{ name: 'browser_open', args: { Url: 'x' } }] }) +
      '\n',
  )
  const cards = new AgyCards(l.deps)
  await cards.sync()
  await settle()
  assert.equal(l.answers.length, 0)
  assert.equal(cards.autoAnswering(A, new Date(BASE * 1000).toISOString()), false)
})

test('auto-approve off (or another conversation’s): the card goes to the phone as before', async (t) => {
  const l = lab(t)
  resetAutoApprove()
  t.after(() => resetAutoApprove())
  await setAutoApprove('agy-ffffffff-ffff-4fff-8fff-ffffffffffff', true)
  const cards = new AgyCards(l.deps)
  await cards.sync()
  await settle()
  assert.equal(l.answers.length, 0)
  assert.equal(agyCards().length, 1)
})

test('★★ auto-approve: turned off (or expired) during the wait ⇒ nothing typed, the card goes to the phone and rings', async (t) => {
  const l = await (async () => lab(t))()
  await autoOn(t)
  const reraised: string[] = []
  let wanted: boolean | undefined
  const cards = new AgyCards({
    ...l.deps,
    unconfirmedMs: 10_000,
    reraised: (c, card) => reraised.push(`${c}@${card}`),
    answer: async (_c, _m, _b, stillWanted) => {
      await setAutoApprove(`agy-${A}`, false)
      wanted = stillWanted?.()
      return wanted ? { ok: true } : { ok: false, reason: 'changed' }
    },
  })
  await cards.sync()
  await settle()
  await cards.sync()
  assert.equal(wanted, false, 'asked right before the key')
  assert.equal(agyCards().length, 1, 'on the phone')
  assert.equal(reraised.length, 1)
})

test('★★ auto-approve never types at a card already shown on the phone (a denial whose key failed stays a denial)', async (t) => {
  const l = lab(t)
  const cards = new AgyCards({ ...l.deps, unconfirmedMs: 10_000 })
  await cards.sync()
  assert.equal(agyCards().length, 1)
  await autoOn(t)
  l.result.value = { ok: false, reason: 'unreachable' } as never
  answer(agyCards()[0]!.key, 'deny')
  await settle()
  await cards.sync()
  await settle()
  assert.deepEqual(l.answers.map((a) => a.behavior), ['deny'], 'never an allow')
  assert.equal(agyCards().length, 1, 'back on the phone')
})

test('★ auto-approve: a look that cannot tell keeps the typed card (it is not typed again, and still goes to the phone if it stays up)', async (t) => {
  const l = lab(t)
  await autoOn(t)
  const probe = { fail: false }
  const reraised: string[] = []
  const cards = new AgyCards({
    ...l.deps,
    unconfirmedMs: 60,
    reraised: (c) => reraised.push(c),
    agy: () => ({ ...l.deps.agy(), locksOf: (p: number) => (probe.fail ? undefined : p === PID ? [A] : []) }),
  })
  await cards.sync()
  await settle()
  probe.fail = true
  await cards.sync()
  probe.fail = false
  await cards.sync()
  await settle()
  assert.equal(l.answers.length, 1, 'typed once')
  await new Promise((r) => setTimeout(r, 120))
  await cards.sync()
  assert.equal(l.answers.length, 1)
  assert.equal(reraised.length, 1, 'handed to the phone')
  assert.equal(agyCards().length, 1)
})

test('★★ auto-approve types only into the agy process it was given to (same pid, same relay registration)', async (t) => {
  for (const owner of [{ pid: PID + 1, startedAt: (BASE - 1000) * 1000 }, { pid: PID, startedAt: (BASE - 999) * 1000 }]) {
    const l = lab(t)
    await autoOn(t, owner)
    const cards = new AgyCards(l.deps)
    await cards.sync()
    await settle()
    assert.equal(l.answers.length, 0, JSON.stringify(owner))
    assert.equal(agyCards().length, 1, 'on the phone instead')
    resetPending()
  }
})

test('★★ a denial whose key failed stays a denial through a status rewrite (a resize): the call is remembered, not the write', { timeout: 5000 }, async (t) => {
  const l = lab(t)
  const cards = new AgyCards({ ...l.deps, unconfirmedMs: 10_000 })
  await cards.sync()
  await autoOn(t)
  l.result.value = { ok: false, reason: 'unreachable' } as never
  answer(agyCards()[0]!.key, 'deny')
  await settle()
  // the terminal is resized: the same call, a new status write
  l.setState({}, BASE + 7)
  await cards.sync()
  await settle()
  assert.deepEqual(l.answers.map((a) => a.behavior), ['deny'])
  assert.equal(agyCards().length, 1)
})

test('★★ a denial whose key failed stays a denial while the status file is missing for a while (a full disk)', { timeout: 5000 }, async (t) => {
  const l = lab(t)
  const cards = new AgyCards({ ...l.deps, unconfirmedMs: 10_000 })
  await cards.sync()
  await autoOn(t)
  l.result.value = { ok: false, reason: 'unreachable' } as never
  answer(agyCards()[0]!.key, 'deny')
  await settle()
  const { rmSync: rm } = await import('node:fs')
  rm(join(l.deps.agy().dir, `pid-${PID}.json`))
  await cards.sync()
  l.setState({}, BASE + 9)
  await cards.sync()
  await settle()
  assert.deepEqual(l.answers.map((a) => a.behavior), ['deny'])
})

test('★★ a late failure of an older auto-answer never erases a newer call’s "was on the phone"', { timeout: 5000 }, async (t) => {
  const l = lab(t)
  await autoOn(t)
  let release!: (v: { ok: false; reason: 'changed' }) => void
  const first = new Promise<{ ok: false; reason: 'changed' }>((r) => (release = r))
  let calls = 0
  const cards = new AgyCards({
    ...l.deps,
    unconfirmedMs: 10_000,
    answer: async (conv, mark, behavior) => {
      l.answers.push({ conv, mark, behavior })
      return calls++ === 0 ? first : { ok: false, reason: 'unreachable' }
    },
  })
  await cards.sync()
  // auto-approve turned off; the PC answers call A; call B reaches the phone
  await setAutoApprove(`agy-${A}`, false)
  appendFileSync(l.transcript, JSON.stringify({ step_index: 2, type: 'GENERIC', content: `Created At: ${new Date((BASE - 50) * 1000).toISOString()}\nok` }) + '\n')
  appendFileSync(l.transcript, JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', created_at: new Date((BASE - 40) * 1000).toISOString(), tool_calls: [{ name: 'run_command', args: { CommandLine: 'pwd' } }] }) + '\n')
  l.setState({}, BASE + 5)
  await cards.sync()
  assert.equal(agyCards().length, 1, 'B on the phone')
  // A's attempt fails late
  release({ ok: false, reason: 'changed' })
  await settle()
  // on again; the phone's denial of B does not land
  await autoOn(t)
  answer(agyCards()[0]!.key, 'deny')
  await settle()
  await cards.sync()
  await settle()
  assert.ok(!l.answers.some((a) => a.mark.step === 3 && a.behavior === 'allow'), 'B is never auto-allowed')
})

test('★★ an auto-answer still waiting to type gives way once its call reaches the phone', { timeout: 5000 }, async (t) => {
  const l = lab(t)
  await autoOn(t)
  let wantedAtKey: boolean | undefined
  let go!: () => void
  const gate = new Promise<void>((r) => (go = r))
  const cards = new AgyCards({
    ...l.deps,
    unconfirmedMs: 10_000,
    answer: async (_c, _m, _b, stillWanted) => {
      await gate
      wantedAtKey = stillWanted?.()
      return wantedAtKey ? { ok: true } : { ok: false, reason: 'changed' }
    },
  })
  await cards.sync()
  // a look that cannot read the transcript drops the try; the next shows the call on the phone
  writeFileSync(l.transcript, '')
  await cards.sync()
  writeFileSync(
    l.transcript,
    JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nhi\n</USER_REQUEST>' }) +
      '\n' +
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: new Date((BASE - 60) * 1000).toISOString(), tool_calls: [{ name: 'run_command', args: { CommandLine: 'ls' } }] }) +
      '\n',
  )
  await cards.sync()
  assert.equal(agyCards().length, 1, 'on the phone')
  go()
  await settle()
  assert.equal(wantedAtKey, false, 'the waiting auto-answer does not type')
})

test('★ a relay record that cannot be read now is "cannot tell": the phone card stays, nothing new is decided', async (t) => {
  const l = lab(t)
  const cards = new AgyCards(l.deps)
  await cards.sync()
  const key = agyCards()[0]!.key
  const paneFile = join(process.env.NYAN_REMOTE_STATE_DIR!, 'panes', `${PID}.json`)
  const { readFileSync: read } = await import('node:fs')
  const good = read(paneFile, 'utf8')
  writeFileSync(paneFile, '{ broken')
  await cards.sync()
  assert.equal(agyCards().length, 1)
  assert.equal(agyCards()[0]!.key, key)
  assert.equal(cards.unsureAbout(A), true)
  writeFileSync(paneFile, good)
  await cards.sync()
  assert.equal(cards.unsureAbout(A), false)
  assert.equal(agyCards()[0]!.key, key)
})
