import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SessionSummary } from '../../../shared/types.ts'
import { answer, listPending, pendingWithMeta, resetPending } from '../permission.ts'
import { resetAutoApprove, setAutoApprove } from '../autoApprove.ts'
import { resetAgyGrantOwners, setAgyGrantOwner } from './grants.ts'
import { answerPermission } from '../routes/permission.ts'
import { AgyCards, agyCard, agyCardTool, agyDelivery, agyDeliveryMessage, agyQuestionCard, type AgyCardDeps } from './cards.ts'
import type { AgyCardMark } from './keys.ts'
import { agyCardAt, agyOwnRows, resetAgyCardNamesForTest, transcriptPathOf } from './sessions.ts'
import { readTailRecords } from './pending.ts'
import { noteUnlisted, resetAgyUnlistedForTest } from './screen.ts'

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
  resetAgyCardNamesForTest()
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
    const body = JSON.stringify({ nyanPid: PID, nyanBusyAt: BASE, input: { conversation_id: A, cwd: '/home/user/p', agent_state: 'tool_use', tool_confirmation_pending: true, version: '1.5.14', ...over } })
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

test('★★ the notifier and the cards name one card alike when agy writes its state twice (each saw a different write)', async (t) => {
  const l = lab(t)
  await autoOn(t)
  utimesSync(l.transcript, BASE - 60, BASE - 60)
  // the notifier's look saw the first write…
  assert.equal(agyOwnRows('pc-a', l.deps.agy())[0]?.lastActivity, new Date(BASE * 1000).toISOString())
  // …the cards' first look the second (0.3 s later, the same call)
  l.setState({}, BASE + 0.3)
  const cards = new AgyCards({ ...l.deps, unconfirmedMs: 10_000 })
  await cards.sync()
  await settle()
  assert.equal(l.answers.length, 1)
  assert.equal(cards.autoAnswering(A, new Date(BASE * 1000).toISOString()), true, 'quiet under the name the notifier uses')
  assert.equal(agyOwnRows('pc-a', l.deps.agy())[0]?.lastActivity, new Date(BASE * 1000).toISOString())
})

test('★★ …and when the cards saw the first write and the notifier the second', async (t) => {
  const l = lab(t)
  // (another call than the other tests': the names given are kept for the whole run)
  appendFileSync(l.transcript, JSON.stringify({ step_index: 2, type: 'GENERIC', content: `Created At: ${new Date((BASE - 60) * 1000).toISOString()}\nran` }) + '\n')
  appendFileSync(l.transcript, JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', created_at: new Date((BASE + 10) * 1000).toISOString(), tool_calls: [{ name: 'run_command', args: { CommandLine: 'pwd' } }] }) + '\n')
  utimesSync(l.transcript, BASE + 10, BASE + 10)
  l.setState({}, BASE + 20)
  const cards = new AgyCards({ ...l.deps, unconfirmedMs: 10_000 })
  await cards.sync()
  assert.equal(agyCards().length, 1)
  l.setState({}, BASE + 20.3)
  assert.equal(agyOwnRows('pc-a', l.deps.agy())[0]?.lastActivity, new Date((BASE + 20) * 1000).toISOString())
})

test('★ a transcript that moved during the cards\' read does not name the card (codex review)', async (t) => {
  const l = lab(t)
  appendFileSync(l.transcript, JSON.stringify({ step_index: 2, type: 'GENERIC', content: `Created At: ${new Date((BASE - 60) * 1000).toISOString()}\nran` }) + '\n')
  appendFileSync(l.transcript, JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', created_at: new Date((BASE + 30) * 1000).toISOString(), tool_calls: [{ name: 'run_command', args: { CommandLine: 'whoami' } }] }) + '\n')
  utimesSync(l.transcript, BASE + 30, BASE + 30)
  l.setState({}, BASE + 40)
  // the read sees the call, and the file is written meanwhile (its time moves)
  const tail = (path: string): Record<string, unknown>[] => {
    const got = readTailRecords(path)
    utimesSync(path, BASE + 39, BASE + 39)
    return got
  }
  const cards = new AgyCards({ ...l.deps, unconfirmedMs: 10_000, tail })
  await cards.sync()
  assert.equal(agyCardAt(PID, A, { step: 3, index: 0, at: (BASE + 30) * 1000 }, (BASE + 41) * 1000), (BASE + 41) * 1000, 'not named by that look')
})

test('★★ a key that went out, then a state rewrite of the same card during the wait: "needs you" rings again (codex review)', async (t) => {
  const l = lab(t)
  const reraised: string[] = []
  const cards = new AgyCards({ ...l.deps, unconfirmedMs: 60, reraised: (c, card) => reraised.push(`${c}@${card}`) })
  await cards.sync()
  answer(agyCards()[0]!.key, 'allow')
  await settle()
  // agy rewrites its state for the same card (a resize): it comes back with a new key at once
  l.setState({}, BASE + 0.3)
  await cards.sync()
  await new Promise((r) => setTimeout(r, 100))
  assert.deepEqual(reraised, [`${A}@${new Date(BASE * 1000).toISOString()}`], 'told under the name the notifier uses')
  // ⚠️ …also when the look at the timeout could not tell (a lock probe that failed): the last known call is kept
  const r3: string[] = []
  let flaky = false
  resetPending()
  const c3 = new AgyCards({ ...l.deps, agy: () => ({ ...l.deps.agy(), locksOf: (p: number) => (flaky ? undefined : p === PID ? [A] : []) }), unconfirmedMs: 60, reraised: (c, card) => r3.push(`${c}@${card}`) })
  l.setState({}, BASE + 0.5)
  await c3.sync()
  answer(agyCards()[0]!.key, 'allow')
  await settle()
  l.setState({}, BASE + 0.6)
  await c3.sync()
  flaky = true
  await c3.sync()
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(r3.length, 1)
  // ⚠️ …and when the transcript cannot be read at the timeout (not "no card" / codex review)
  const r4: string[] = []
  let blind = false
  resetPending()
  const c4 = new AgyCards({ ...l.deps, tail: (p: string) => (blind ? [] : readTailRecords(p)), unconfirmedMs: 60, reraised: (c, card) => r4.push(`${c}@${card}`) })
  l.setState({}, BASE + 0.7)
  await c4.sync()
  answer(agyCards()[0]!.key, 'allow')
  await settle()
  l.setState({}, BASE + 0.8)
  await c4.sync()
  blind = true
  await c4.sync()
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(r4.length, 1)
  blind = false
  // ⚠️ answered for real (another call or no card): nothing
  const r2: string[] = []
  resetPending()
  const c2 = new AgyCards({ ...l.deps, unconfirmedMs: 60, reraised: (c, card) => r2.push(`${c}@${card}`) })
  l.setState({}, BASE + 1)
  await c2.sync()
  answer(agyCards()[0]!.key, 'allow')
  await settle()
  l.setState({ agent_state: 'working', tool_confirmation_pending: false }, BASE + 2)
  await c2.sync()
  await new Promise((r) => setTimeout(r, 100))
  assert.deepEqual(r2, [])
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

test('★★ a child agent running: no card on the phone and no auto-answer (its question may be open on the PC); it rings', async (t) => {
  const l = lab(t)
  await autoOn(t)
  l.setState({ subagents: [{ name: 'self', status: 'running' }] })
  const cards = new AgyCards({ ...l.deps, unconfirmedMs: 10_000 })
  await cards.sync()
  await settle()
  assert.equal(agyCards().length, 0, 'not on the phone')
  assert.equal(l.answers.length, 0, 'not typed at')
  assert.equal(cards.autoAnswering(A, new Date(BASE * 1000).toISOString()), false, 'not quiet: the notifier rings it')
  // the child done (a new state write): auto-approve answers it as before
  l.setState({ subagents: [{ name: 'self', status: 'completed' }] }, BASE + 1)
  await cards.sync()
  await settle()
  assert.equal(l.answers.length, 1)
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
  // agy rewrites its state for the same call (a new mark): the try is over and the call goes to the phone
  // (⚠️ a look that cannot read the transcript no longer drops it: that is "cannot tell" / codex review)
  l.setState({}, BASE + 0.5)
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

// ★★ Questions (ask_question / docs/AGY.md §13)
function questionLab(t: { after(fn: () => void): void }, over: Record<string, unknown> = {}) {
  const l = lab(t)
  const qs: { conv: string; mark: unknown; steps: unknown }[] = []
  const at = new Date((BASE - 60) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  writeFileSync(
    l.transcript,
    [
      { step_index: 0, type: 'USER_INPUT', created_at: at, content: '<USER_REQUEST>\nask\n</USER_REQUEST>' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: at,
        tool_calls: [{ name: 'ask_question', args: { questions: [{ is_multi_select: true, options: ['red', 'blue'], question: 'Which colors?' }] } }],
      },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  )
  utimesSync(l.transcript, BASE - 10, BASE - 10)
  l.setState({ tool_confirmation_pending: false, agent_state: 'tool_use', ...over }, BASE)
  const result: { value: { ok: true } | { ok: false; reason: 'changed' | 'partial' } } = { value: { ok: true } }
  const deps: AgyCardDeps = {
    ...l.deps,
    answerQuestion: async (conv, mark, answer) => {
      qs.push({ conv, mark, steps: answer.kind === 'steps' ? answer.steps : answer })
      return result.value
    },
  }
  /** ★ Cards that made their first look before the question came up (the first look leaves what is up to the PC) */
  const start = async (d: AgyCardDeps = deps): Promise<AgyCards> => {
    // (the question not written yet at that look)
    const asked = readFileSync(l.transcript, 'utf8')
    writeFileSync(l.transcript, JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nask\n</USER_REQUEST>' }) + '\n')
    l.setState({ tool_confirmation_pending: false, agent_state: 'working', ...over }, BASE - 1)
    const c = new AgyCards(d)
    await c.sync()
    writeFileSync(l.transcript, asked)
    utimesSync(l.transcript, BASE - 10, BASE - 10)
    l.setState({ tool_confirmation_pending: false, agent_state: 'tool_use', ...over }, BASE)
    return c
  }
  return { ...l, deps, qs, result, start }
}

test('★★ a question comes to the phone as a question card; the answer is typed as keys the agent built', async (t) => {
  const l = questionLab(t)
  const cards = await l.start()
  await cards.sync()
  const [c] = agyCards()
  assert.equal(c?.toolName, 'AskUserQuestion')
  assert.equal(c?.interaction?.kind, 'question')
  assert.equal(c?.summary, 'Which colors?')
  assert.equal(l.answers.length, 0, 'not a card answer')
  // ⚠️ the phone sends labels; a label that was not shown is refused, nothing typed
  assert.equal(answerPermission({ key: c!.key, behavior: 'allow', answers: { 'Which colors?': ['cherry'] } }, 'test').ok, false)
  const delivery = agyDelivery(c!.key)
  const r = answerPermission({ key: c!.key, behavior: 'allow', answers: { 'Which colors?': ['blue'] }, notes: { 'Which colors?': 'pink' } }, 'test')
  assert.equal(r.ok, true, r.reason)
  assert.deepEqual(await delivery, { ok: true })
  assert.equal(l.qs.length, 1)
  assert.deepEqual(l.qs[0]!.mark, { pid: PID, askedAt: (BASE - 10) * 1000, step: 1, index: 0, callAt: (BASE - 60) * 1000 })
  assert.deepEqual(l.qs[0]!.steps, [{ key: '2' }, { key: '3' }, { text: 'pink' }, { key: '\r' }])
  // not raised again while it stays up
  await cards.sync()
  assert.equal(agyCards().length, 0)
  assert.doesNotMatch(l.logs.join('\n'), /colors|blue|pink/, 'nothing of the question or the answer in the log')
})

test('★ a question skipped from the phone: one ESC; a reason cannot go with it; a bare deny (an older PWA’s "deny and stop") is refused', async (t) => {
  const l = questionLab(t)
  const cards = await l.start()
  await cards.sync()
  const [c] = agyCards()
  assert.equal(answerPermission({ key: c!.key, behavior: 'deny', feedback: 'no', skip: true }, 'test').ok, false)
  const bare = answerPermission({ key: c!.key, behavior: 'deny' }, 'test')
  assert.equal(bare.ok, false)
  assert.match(bare.reason ?? '', /更新|update/)
  assert.equal(answerPermission({ key: c!.key, behavior: 'deny', skip: true }, 'test').ok, true)
  await settle()
  assert.deepEqual(l.qs[0]!.steps, [{ key: '\x1b' }])
})

test('★★ question cards: none while a subagent runs, none from an agy without the relay; auto-approve never answers one', async (t) => {
  const child = questionLab(t, { subagents: [{ name: 'self', status: 'running' }] })
  await (await child.start()).sync()
  assert.equal(agyCards().length, 0)
  resetPending()
  const plain = questionLab(t)
  // (no relay record for this one)
  const noRelay: AgyCardDeps = { ...plain.deps, agy: () => ({ ...plain.deps.agy(), aliveProcStart: () => null }) }
  await (await plain.start(noRelay)).sync()
  assert.equal(agyCards().length, 0)
  resetPending()
  const l = questionLab(t)
  await autoOn(t)
  const cards = await l.start()
  await cards.sync()
  await settle()
  assert.equal(agyCards().length, 1, 'still on the phone')
  assert.equal(l.qs.length, 0, 'not typed at')
  assert.equal(cards.autoAnswering(A, new Date((BASE - 10) * 1000).toISOString()), false)
})

test('★ a question answer half typed is left to the PC (not raised again from the first question); a failed one comes back', async (t) => {
  const l = questionLab(t)
  const cards = await l.start()
  await cards.sync()
  l.result.value = { ok: false, reason: 'partial' }
  const [c] = agyCards()
  const d = agyDelivery(c!.key)
  answerPermission({ key: c!.key, behavior: 'allow', answers: { 'Which colors?': ['red'] } }, 'test')
  assert.deepEqual(await d, { ok: false, reason: 'partial' })
  assert.match(agyDeliveryMessage('partial'), /PC/)
  await cards.sync()
  assert.equal(agyCards().length, 0)
  // ⚠️ a look that does not see it for a moment does not make it new again (codex review)
  l.setState({ tool_confirmation_pending: false, agent_state: 'working' }, BASE + 1)
  await cards.sync()
  l.setState({ tool_confirmation_pending: false, agent_state: 'tool_use' }, BASE + 2)
  await cards.sync()
  assert.equal(agyCards().length, 0)
  // a key that did not go out at all: back on the next look
  resetPending()
  const m = questionLab(t)
  const again = await m.start()
  await again.sync()
  m.result.value = { ok: false, reason: 'changed' }
  const [c2] = agyCards()
  answerPermission({ key: c2!.key, behavior: 'allow', answers: { 'Which colors?': ['red'] } }, 'test')
  await settle()
  await again.sync()
  assert.equal(agyCards().length, 1)
})

test('★★ a lone child’s question comes to the phone (marked as a subagent’s); two asking at once stay on the PC', async (t) => {
  const l = questionLab(t)
  const iso = (sec: number): string => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const kid = (id: string, n: number, prompt = `p${n}`): void => {
    const p = transcriptPathOf(id, l.deps.agy().home)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(
      p,
      [
        { type: 'SYSTEM_MESSAGE', step_index: 0, created_at: iso(BASE - 35), content: `x\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=${iso(BASE - 35)} sender=${A} priority=MESSAGE_PRIORITY_HIGH content=${prompt}\n</SYSTEM_MESSAGE>` },
        { type: 'PLANNER_RESPONSE', step_index: 1, created_at: iso(BASE - 35), tool_calls: [{ name: 'ask_question', args: { questions: [{ question: `Child ${n}?`, options: ['a', 'b'] }] } }] },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    )
    utimesSync(p, BASE - 20 + n, BASE - 20 + n)
  }
  const K1 = '15bc1e2a-6a62-4f86-9bf9-dd03e99f6627'
  const K2 = '70039de1-d758-4556-afa8-5d36b9625540'
  const parent = (ids: string[]): void => {
    writeFileSync(
      l.transcript,
      [
        { type: 'USER_INPUT', step_index: 0, created_at: iso(BASE - 40), content: '<USER_REQUEST>\ngo\n</USER_REQUEST>' },
        { type: 'PLANNER_RESPONSE', step_index: 1, created_at: iso(BASE - 40), tool_calls: ids.map((_, i) => ({ name: 'invoke_subagent', args: { Prompt: `p${i}` } })) },
        ...ids.map((id, i) => ({ type: 'GENERIC', step_index: 2 + i, created_at: iso(BASE - 39), content: `Created the following subagent:\n{"conversationId": "${id}"}` })),
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    )
    utimesSync(l.transcript, BASE - 30, BASE - 30)
    l.setState({ tool_confirmation_pending: false, agent_state: 'idle', subagents: ids.map((_, i) => ({ name: 'self', role: `p${i}`, status: 'running' })) }, BASE)
  }
  // (the first look before anything asks: what is up then is left to the PC)
  l.setState({ tool_confirmation_pending: false, agent_state: 'working' }, BASE - 1)
  const cards = new AgyCards(l.deps)
  await cards.sync()
  kid(K1, 0)
  kid(K2, 1)
  parent([K1])
  await cards.sync()
  const [c] = agyCards()
  assert.equal(c?.summary, 'Child 0?')
  assert.deepEqual(c?.subagent, {})
  assert.equal(answerPermission({ key: c!.key, behavior: 'allow', answers: { 'Child 0?': ['b'] } }, 'test').ok, true)
  await settle()
  assert.deepEqual(l.qs[0]!.mark, { pid: PID, askedAt: (BASE - 20) * 1000, step: 1, index: 0, callAt: (BASE - 35) * 1000, child: K1 })
  assert.deepEqual(l.qs[0]!.steps, [{ key: '2' }])
  // two children asking at once: the PC (the row still rings)
  resetPending()
  const second = new AgyCards(l.deps)
  l.setState({ tool_confirmation_pending: false, agent_state: 'working' }, BASE - 1)
  await second.sync()
  parent([K1, K2])
  await second.sync()
  assert.equal(agyCards().length, 0)
})

test('★ a question already up at the agent’s first look is left to the PC (a previous agent may have typed part of it)', async (t) => {
  const l = questionLab(t)
  await new AgyCards(l.deps).sync()
  assert.equal(agyCards().length, 0)
  // ⚠️ also one the phone could not take at that look (a child running then): not raised once it could (codex review)
  resetPending()
  const k = questionLab(t, { subagents: [{ name: 'self', role: 'r', status: 'running' }] })
  const cards = new AgyCards(k.deps)
  await cards.sync()
  k.setState({ tool_confirmation_pending: false, agent_state: 'tool_use' }, BASE + 1)
  await cards.sync()
  assert.equal(agyCards().length, 0)
  resetPending()
  // a question that comes up later is raised
  const c = await l.start()
  await c.sync()
  assert.equal(agyCards().length, 1)
})

test('★ a several-key answer whose question is still up after it is left to the PC (and rings again); a one-key one comes back', async (t) => {
  const l = questionLab(t)
  const rang: string[] = []
  const cards = await l.start({ ...l.deps, unconfirmedMs: 20, reraised: (conv, card) => rang.push(`${conv}:${card}`) })
  await cards.sync()
  const [c] = agyCards()
  answerPermission({ key: c!.key, behavior: 'allow', answers: { 'Which colors?': ['red'] } }, 'test')
  await settle()
  // ⚠️ a look that does not see it (a sibling's question, a moment unread), then it is up again: still not raised
  //    (codex review: the memory was dropped and it came back over a half-done dialog)
  l.setState({ tool_confirmation_pending: false, agent_state: 'working' }, BASE + 1)
  await cards.sync()
  l.setState({ tool_confirmation_pending: false, agent_state: 'tool_use' }, BASE + 2)
  await cards.sync()
  assert.equal(agyCards().length, 0)
  await new Promise((r) => setTimeout(r, 80))
  assert.deepEqual(l.qs[0]!.steps, [{ key: '1' }, { key: '\r' }])
  assert.equal(rang.length, 1, 'rings again')
  await cards.sync()
  assert.equal(agyCards().length, 0, 'not raised again: the PC may be half way')
  // one key (a single-select option): raised again
  resetPending()
  const m = questionLab(t)
  const iso = new Date((BASE - 60) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  writeFileSync(
    m.transcript,
    JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: iso, tool_calls: [{ name: 'ask_question', args: { questions: [{ options: ['a', 'b'], question: 'Pick?' }] } }] }) + '\n',
  )
  utimesSync(m.transcript, BASE - 10, BASE - 10)
  const again = await m.start({ ...m.deps, unconfirmedMs: 20 })
  await again.sync()
  const [d] = agyCards()
  answerPermission({ key: d!.key, behavior: 'allow', answers: { 'Pick?': ['b'] } }, 'test')
  await new Promise((r) => setTimeout(r, 80))
  await again.sync()
  assert.deepEqual(m.qs[0]!.steps, [{ key: '2' }])
  assert.equal(agyCards().length, 1)
})

test('★ while an answer is being typed, a look that misses the question and the next that sees it raise no second card', async (t) => {
  const l = questionLab(t)
  let release!: () => void
  const slow: AgyCardDeps = {
    ...l.deps,
    answerQuestion: (conv, mark, answer) =>
      new Promise((resolve) => {
        l.qs.push({ conv, mark, steps: answer.kind === 'steps' ? answer.steps : answer })
        release = () => resolve({ ok: true })
      }),
  }
  const cards = await l.start(slow)
  await cards.sync()
  const [c] = agyCards()
  answerPermission({ key: c!.key, behavior: 'allow', answers: { 'Which colors?': ['red'] } }, 'test')
  await settle()
  assert.equal(l.qs.length, 1, 'typing')
  l.setState({ tool_confirmation_pending: false, agent_state: 'working' }, BASE + 1)
  await cards.sync()
  l.setState({ tool_confirmation_pending: false, agent_state: 'tool_use' }, BASE + 2)
  await cards.sync()
  assert.equal(agyCards().length, 0, 'no second card mid-answer')
  release()
  await settle()
  await cards.sync()
  assert.equal(agyCards().length, 0, 'a two-key answer stays with the PC after it')
})

// ★★ With the relay's screen (docs/AGY.md §14)
function withScreen(l: ReturnType<typeof questionLab>, screen: () => string): AgyCardDeps {
  const root = join(l.deps.agy().dir, '..')
  const pane = join(root, 'panes', `${PID}.json`)
  writeFileSync(pane, JSON.stringify({ ...JSON.parse(readFileSync(pane, 'utf8')), screen: true }))
  return { ...l.deps, readScreen: async () => screen() }
}

test('★★ screen: a batch, a long list, and a question up at the first look come to the phone when the screen shows them', async (t) => {
  const l = questionLab(t)
  const iso = new Date((BASE - 60) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const qs = [
    { question: 'Which fruit?', options: ['apple', 'banana'] },
    { question: 'Which number?', options: Array.from({ length: 11 }, (_, i) => `n${i + 1}`) },
  ]
  writeFileSync(l.transcript, JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: iso, tool_calls: [{ name: 'ask_question', args: { questions: qs } }] }) + '\n')
  utimesSync(l.transcript, BASE - 10, BASE - 10)
  let shown = 'Question 1/2: Which fruit?\n\n> 1. apple\n  2. banana\n  3. Write-in...\n\n  ↑/↓ Navigate · → Next · enter Select · esc Skip'
  const deps = withScreen(l, () => shown)
  // (the first look: with the screen, what is already up is not left to the PC)
  const cards = new AgyCards(deps)
  await cards.sync()
  const [c] = agyCards()
  assert.equal(c?.interaction?.kind === 'question' && c.interaction.questions.length, 2)
  const r = answerPermission({ key: c!.key, behavior: 'allow', answers: { 'Which fruit?': ['banana'], 'Which number?': ['n11'] } }, 'test')
  assert.equal(r.ok, true, r.reason)
  await settle()
  const sent = l.qs[0]!.steps as { kind: string; plan: { items: unknown[] } }
  assert.equal(sent.kind, 'plan')
  assert.deepEqual(sent.plan.items, [{ indexes: [1] }, { indexes: [10] }])
  assert.equal((l.qs[0]!.mark as { screen?: boolean }).screen, true)
  // ⚠️ a screen showing something else: no card
  resetPending()
  shown = 'Question 1/1: Something else?\n\n> 1. a\n  2. Write-in...\n\n  ↑/↓ Navigate · enter Select · esc Skip'
  await new AgyCards(deps).sync()
  assert.equal(agyCards().length, 0)
})

test('★★ screen: of two children asking, the one the banner shows comes to the phone (the other after it)', async (t) => {
  const l = questionLab(t)
  const iso = (sec: number): string => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const K1 = '15bc1e2a-6a62-4f86-9bf9-dd03e99f6627'
  const K2 = '70039de1-d758-4556-afa8-5d36b9625540'
  const kid = (id: string, n: number, question: string): void => {
    const p = transcriptPathOf(id, l.deps.agy().home)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(
      p,
      [
        { type: 'SYSTEM_MESSAGE', step_index: 0, created_at: iso(BASE - 35), content: `x\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=${iso(BASE - 35)} sender=${A} priority=MESSAGE_PRIORITY_HIGH content=p${n}\n</SYSTEM_MESSAGE>` },
        { type: 'PLANNER_RESPONSE', step_index: 1, created_at: iso(BASE - 35), tool_calls: [{ name: 'ask_question', args: { questions: [{ question, options: ['a', 'b'] }] } }] },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    )
    utimesSync(p, BASE - 20 + n, BASE - 20 + n)
  }
  kid(K1, 0, 'Which planet?')
  kid(K2, 1, 'Which moon?')
  writeFileSync(l.transcript, JSON.stringify({ type: 'USER_INPUT', step_index: 0, content: '<USER_REQUEST>\ngo\n</USER_REQUEST>' }) + '\n')
  utimesSync(l.transcript, BASE - 30, BASE - 30)
  l.setState({ tool_confirmation_pending: false, agent_state: 'idle', subagents: [{ name: 'self', role: 'p0', status: 'running' }, { name: 'self', role: 'p1', status: 'running' }] }, BASE)
  const banner = (q: string): string => [' ┃ self has a question', ' ┃', ` ┃ ? ${q}`, ' ┃ ctrl+k answer · alt+j manage', '>', '? for shortcuts'].join('\n')
  let shown = banner('Which moon?')
  // ⚠️ the parent working (a child's question is answered only while it is idle): no card yet
  l.setState({ tool_confirmation_pending: false, agent_state: 'working', subagents: [{ name: 'self', role: 'p0', status: 'running' }, { name: 'self', role: 'p1', status: 'running' }] }, BASE)
  await new AgyCards(withScreen(l, () => shown)).sync()
  assert.equal(agyCards().length, 0)
  l.setState({ tool_confirmation_pending: false, agent_state: 'idle', subagents: [{ name: 'self', role: 'p0', status: 'running' }, { name: 'self', role: 'p1', status: 'running' }] }, BASE)
  const cards = new AgyCards(withScreen(l, () => shown))
  await cards.sync()
  const [c] = agyCards()
  assert.equal(c?.summary, 'Which moon?')
  assert.deepEqual(c?.subagent, {})
  // the banner moves on (that one answered on the PC): the card follows it
  shown = banner('Which planet?')
  await cards.sync()
  assert.deepEqual(agyCards().map((x) => x.summary), ['Which planet?'])
  // the PC on a subagent's view whose header (its id) is not on the screen: the answer could not go back ⇒ no card
  shown = '  ↑/↓ scroll · pgup/pgdown page · ctrl+end bottom · ctrl+home top\n  ctrl+o expand · shift+k kill · esc back'
  await cards.sync()
  assert.equal(agyCards().length, 0)
  // ⚠️ the other child now asks a batch the phone does not take (duplicate options) starting with the same question:
  //    the banner could be either's, so no card (codex review)
  const p2 = transcriptPathOf(K2, l.deps.agy().home)
  appendFileSync(p2, JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 2, created_at: iso(BASE - 5), tool_calls: [{ name: 'ask_question', args: { questions: [{ question: 'Which planet?', options: ['a', 'b'] }, { question: 'Again?', options: ['y', 'y'] }] } }] }) + '\n')
  utimesSync(p2, BASE - 4, BASE - 4)
  shown = banner('Which planet?')
  resetPending()
  await new AgyCards(withScreen(l, () => shown)).sync()
  assert.equal(agyCards().length, 0)
  // (nor when the dialog open is one only that question's text fits)
  shown = 'Question 1/1: Which planet?\n\n> 1. a\n  2. b\n  3. Write-in...\n\n  ↑/↓ Navigate · enter Select · esc Skip'
  await new AgyCards(withScreen(l, () => shown)).sync()
  assert.equal(agyCards().length, 0)
})

test('★ the phone waits for an agy answer at most a few seconds (a relay line runs one request at a time); past it, taken', async (t) => {
  const { settledWithin, AGY_DELIVERY_WAIT_MS, permissionAnswer } = await import('../routes/permission.ts')
  const { Readable } = await import('node:stream')
  assert.ok(AGY_DELIVERY_WAIT_MS <= 2000, 'short: every second holds what a relay line has queued behind it')
  assert.equal(await settledWithin(new Promise(() => undefined), 20), 'slow')
  assert.deepEqual(await settledWithin(Promise.resolve({ ok: true }), 1000), { ok: true })
  // the route: a slow typing is told as taken (not failed); a quick failure is told as failed
  const l = questionLab(t)
  let finish!: (v: { ok: false; reason: 'partial' }) => void
  const cards = await l.start({ ...l.deps, answerQuestion: () => new Promise((r) => (finish = r)) })
  await cards.sync()
  const [c] = agyCards()
  const ctx = (body: unknown) =>
    ({ req: Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { headers: { 'content-type': 'application/json' } }), res: {}, url: new URL('http://agent/permission/answer'), params: {}, identity: { login: 'x', deviceId: 'd', via: 'device' } }) as never
  const slow = await permissionAnswer(ctx({ key: c!.key, behavior: 'allow', answers: { 'Which colors?': ['blue'] } }), 30)
  assert.equal(slow.ok, true)
  assert.equal(slow.at, undefined, 'not said to have taken effect')
  finish({ ok: false, reason: 'partial' })
})

/** Two children asking (K1 / K2, their prompts p0 / p1), the parent idle with both running */
function twoKids(l: ReturnType<typeof questionLab>, q1: unknown[], q2: unknown[] | undefined): { K1: string; K2: string } {
  const iso = (sec: number): string => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const K1 = '15bc1e2a-6a62-4f86-9bf9-dd03e99f6627'
  const K2 = '70039de1-d758-4556-afa8-5d36b9625540'
  const kid = (id: string, n: number, questions: unknown[] | undefined): void => {
    if (!questions) return
    const p = transcriptPathOf(id, l.deps.agy().home)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(
      p,
      [
        { type: 'SYSTEM_MESSAGE', step_index: 0, created_at: iso(BASE - 35), content: `x\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=${iso(BASE - 35)} sender=${A} priority=MESSAGE_PRIORITY_HIGH content=p${n}\n</SYSTEM_MESSAGE>` },
        { type: 'PLANNER_RESPONSE', step_index: 1, created_at: iso(BASE - 35), tool_calls: [{ name: 'ask_question', args: { questions } }] },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    )
    utimesSync(p, BASE - 20 + n, BASE - 20 + n)
  }
  kid(K1, 0, q1)
  kid(K2, 1, q2)
  writeFileSync(l.transcript, JSON.stringify({ type: 'USER_INPUT', step_index: 0, content: '<USER_REQUEST>\ngo\n</USER_REQUEST>' }) + '\n')
  utimesSync(l.transcript, BASE - 30, BASE - 30)
  l.setState({ tool_confirmation_pending: false, agent_state: 'idle', subagents: [{ name: 'self', role: 'p0', status: 'running' }, { name: 'self', role: 'p1', status: 'running' }] }, BASE)
  return { K1, K2 }
}

const childDialog = (id: string, rows: string): string => `  main › self\n  ● running\n  ID: ${id}\n  ────\nQuestion\n────\n\n${rows}\n\n  ↑/↓ Navigate · enter Select · esc Skip`

test('★★ screen: a child’s dialog goes to the child its header names; another’s id, a parent’s view, an unread child ⇒ no card', async (t) => {
  const l = questionLab(t)
  const { K1, K2 } = twoKids(l, [{ question: 'Which hill?', options: ['east', 'west'] }], [{ question: 'Which lake?', options: ['erie', 'huron'] }])
  let shown = childDialog(K1, 'Question 1/1: Which hill?\n\n> 1. east\n  2. west\n  3. Write-in...')
  await new AgyCards(withScreen(l, () => shown)).sync()
  assert.equal(agyCards()[0]?.summary, 'Which hill?')
  // the same dialog under the other child's id (it asks something else): not this one's
  resetPending()
  shown = childDialog(K2, 'Question 1/1: Which hill?\n\n> 1. east\n  2. west\n  3. Write-in...')
  await new AgyCards(withScreen(l, () => shown)).sync()
  assert.equal(agyCards().length, 0)
  // ⚠️ the options in another order: not the question the card would answer (the answer checks the same)
  resetPending()
  shown = childDialog(K1, 'Question 1/1: Which hill?\n\n> 1. west\n  2. east\n  3. Write-in...')
  await new AgyCards(withScreen(l, () => shown)).sync()
  assert.equal(agyCards().length, 0)
})

test('★★ screen: a running child whose transcript cannot be found keeps every card off (it may ask the same)', async (t) => {
  const l = questionLab(t)
  twoKids(l, [{ question: 'Which hill?', options: ['east', 'west'] }], undefined)
  const shown = [' ┃ self has a question', ' ┃', ' ┃ ? Which hill?', ' ┃ ctrl+k answer · alt+j manage', '>', '? for shortcuts'].join('\n')
  await new AgyCards(withScreen(l, () => shown)).sync()
  assert.equal(agyCards().length, 0)
})

test('★ screen: a batch sharing a later question with another child’s gets no card (the answer would refuse it)', async (t) => {
  const l = questionLab(t)
  const { K1 } = twoKids(
    l,
    [{ question: 'Auth: which way?', options: ['a', 'b'] }, { question: 'Run tests after?', options: ['y', 'n'] }],
    [{ question: 'Billing: which way?', options: ['a', 'b'] }, { question: 'Run tests after?', options: ['y', 'n'] }],
  )
  const shown = childDialog(K1, 'Question 1/2: Auth: which way?\n\n> 1. a\n  2. b\n  3. Write-in...').replace('enter Select', '→ Next · enter Select')
  await new AgyCards(withScreen(l, () => shown)).sync()
  assert.equal(agyCards().length, 0)
})

test('★★ an answer that fails after the phone was told "taken" rings "needs you" again', async (t) => {
  const l = questionLab(t)
  const reraised: string[] = []
  const cards = await l.start({
    ...l.deps,
    deliveryWaitMs: 20,
    reraised: (c, card) => reraised.push(`${c}@${card}`),
    answerQuestion: async () => (await new Promise((r) => setTimeout(r, 40)), { ok: false, reason: 'partial' }),
  })
  await cards.sync()
  assert.equal(answerPermission({ key: agyCards()[0]!.key, behavior: 'allow', answers: { 'Which colors?': ['blue'] } }, 'test').ok, true)
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(reraised.length, 1)
  // (a quick failure is told to the phone itself: no extra ring)
  const quick = await l.start({ ...l.deps, deliveryWaitMs: 10_000, reraised: (c, card) => reraised.push(`${c}@${card}`), answerQuestion: async () => ({ ok: false, reason: 'partial' }) })
  resetPending()
  await quick.sync()
  assert.equal(answerPermission({ key: agyCards()[0]!.key, behavior: 'allow', answers: { 'Which colors?': ['blue'] } }, 'test').ok, true)
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(reraised.length, 1)
})

test('★ a slow failure on an older child’s question rings under the name of the wait now (a newer child’s question)', async (t) => {
  const l = questionLab(t)
  twoKids(l, [{ question: 'Which hill?', options: ['east', 'west'] }], [{ question: 'Which lake?', options: ['erie', 'huron'] }])
  const shown = [' ┃ self has a question', ' ┃', ' ┃ ? Which hill?', ' ┃ ctrl+k answer · alt+j manage', '>', '? for shortcuts'].join('\n')
  const reraised: string[] = []
  const cards = new AgyCards({
    ...withScreen(l, () => shown),
    deliveryWaitMs: 10,
    reraised: (_c, card) => reraised.push(card),
    answerQuestion: async () => (await new Promise((r) => setTimeout(r, 30)), { ok: false, reason: 'partial' }),
  })
  await cards.sync()
  assert.equal(agyCards()[0]?.summary, 'Which hill?')
  assert.equal(answerPermission({ key: agyCards()[0]!.key, behavior: 'allow', answers: { 'Which hill?': ['west'] } }, 'test').ok, true)
  await new Promise((r) => setTimeout(r, 80))
  // K2's question (written a second later) is the wait now
  assert.deepEqual(reraised, [new Date((BASE - 19) * 1000).toISOString()])
})

test('★★ an approval card whose key fails after the phone was told "taken" rings "needs you" again', async (t) => {
  const l = lab(t)
  const reraised: string[] = []
  const slowFail = async () => (await new Promise((r) => setTimeout(r, 30)), { ok: false as const, reason: 'unreachable' as const })
  const cards = new AgyCards({ ...l.deps, deliveryWaitMs: 10, answer: slowFail, reraised: (c, card) => reraised.push(`${c}@${card}`) })
  await cards.sync()
  answer(agyCards()[0]!.key, 'allow')
  await new Promise((r) => setTimeout(r, 80))
  assert.deepEqual(reraised, [`${A}@${new Date(BASE * 1000).toISOString()}`])
  // a quick failure is told to the phone itself
  resetPending()
  const quick = new AgyCards({ ...l.deps, deliveryWaitMs: 10_000, answer: async () => ({ ok: false as const, reason: 'unreachable' as const }), reraised: (c, card) => reraised.push(`${c}@${card}`) })
  await quick.sync()
  answer(agyCards()[0]!.key, 'allow')
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(reraised.length, 1)
})

test('★★ screen: the PC on a subagent’s view with nothing open: the oldest asking sibling’s question comes to the phone', async (t) => {
  const l = questionLab(t)
  const { K1 } = twoKids(l, [{ question: 'Which hill?', options: ['east', 'west'] }], [{ question: 'Which lake?', options: ['erie', 'huron'] }])
  // the view of a third child, done (nothing pending there)
  const K3 = '2a378a7f-0000-4000-8000-000000000003'
  const p3 = transcriptPathOf(K3, l.deps.agy().home)
  mkdirSync(join(p3, '..'), { recursive: true })
  writeFileSync(p3, [{ type: 'SYSTEM_MESSAGE', step_index: 0, content: 'x' }, { type: 'PLANNER_RESPONSE', step_index: 1, content: 'Reported back.' }].map((r) => JSON.stringify(r)).join('\n') + '\n')
  const view = (id: string) => ['  main › self', '  ● running', `  ID: ${id}`, '  ────', '', '  ↑/↓ scroll · pgup/pgdown page · ctrl+end bottom · ctrl+home top', '  ctrl+o expand · shift+k kill · esc back', '      Gemini 4 Neon · high · 2 subagent(s)'].join('\n')
  await new AgyCards(withScreen(l, () => view(K3))).sync()
  // K1 asked a second before K2
  assert.equal(agyCards()[0]?.summary, 'Which hill?')
  assert.deepEqual(agyCards()[0]?.subagent, {})
  // ⚠️ the viewed child has something pending (its own question, a command): ESC there could skip or decline it ⇒ no card
  resetPending()
  await new AgyCards(withScreen(l, () => view(K1))).sync()
  assert.equal(agyCards().length, 0)
})

test('★ screen: on a subagent’s view, the oldest question is not raised when another asking call shares its text', async (t) => {
  const l = questionLab(t)
  twoKids(l, [{ question: 'Which hill?', options: ['east', 'west'] }], [{ question: 'Which hill?', options: ['north', 'south'] }])
  const K3 = '2a378a7f-0000-4000-8000-000000000003'
  const p3 = transcriptPathOf(K3, l.deps.agy().home)
  mkdirSync(join(p3, '..'), { recursive: true })
  writeFileSync(p3, [{ type: 'SYSTEM_MESSAGE', step_index: 0, content: 'x' }, { type: 'PLANNER_RESPONSE', step_index: 1, content: 'Reported back.' }].map((r) => JSON.stringify(r)).join('\n') + '\n')
  const view = ['  main › self', '  ● running', `  ID: ${K3}`, '  ────', '', '  ↑/↓ scroll · pgup/pgdown page · ctrl+end bottom · ctrl+home top', '  ctrl+o expand · shift+k kill · esc back', '      Gemini 4 Neon · high · 2 subagent(s)'].join('\n')
  await new AgyCards(withScreen(l, () => view)).sync()
  assert.equal(agyCards().length, 0)
})

test('★ screen: the parent’s own question while the PC shows a finished subagent’s view comes to the phone', async (t) => {
  const l = questionLab(t)
  const K3 = '2a378a7f-0000-4000-8000-000000000003'
  const p3 = transcriptPathOf(K3, l.deps.agy().home)
  mkdirSync(join(p3, '..'), { recursive: true })
  writeFileSync(p3, [{ type: 'SYSTEM_MESSAGE', step_index: 0, content: 'x' }, { type: 'PLANNER_RESPONSE', step_index: 1, content: 'Reported back.' }].map((r) => JSON.stringify(r)).join('\n') + '\n')
  const view = ['  main › self', '  ● done', `  ID: ${K3}`, '', '  ↑/↓ scroll · ctrl+home top', '  ctrl+o expand · shift+k kill · esc back', '      Gemini 4 Neon · high'].join('\n')
  const cards = await l.start(withScreen(l, () => view))
  await cards.sync()
  assert.equal(agyCards()[0]?.summary, 'Which colors?')
  assert.equal(agyCards()[0]?.subagent, undefined)
})

test('★★ after an answer from the phone, another question still waiting (a second subagent’s) rings "needs you" again', async (t) => {
  const l = questionLab(t)
  const { K1 } = twoKids(l, [{ question: 'Which hill?', options: ['east', 'west'] }], [{ question: 'Which lake?', options: ['erie', 'huron'] }])
  const banner = (q: string): string => [' ┃ self has a question', ' ┃', ` ┃ ? ${q}`, ' ┃ ctrl+k answer · alt+j manage', '>', '? for shortcuts'].join('\n')
  let shown = banner('Which hill?')
  const reraised: string[] = []
  const cards = new AgyCards({ ...withScreen(l, () => shown), unconfirmedMs: 80, reraised: (_c, card) => reraised.push(card) })
  await cards.sync()
  assert.equal(agyCards()[0]?.summary, 'Which hill?')
  assert.equal(answerPermission({ key: agyCards()[0]!.key, behavior: 'allow', answers: { 'Which hill?': ['west'] } }, 'test').ok, true)
  await settle()
  // K1 got its answer; the banner shows K2's question
  const p1 = transcriptPathOf(K1, l.deps.agy().home)
  appendFileSync(p1, JSON.stringify({ type: 'GENERIC', step_index: 2, content: 'A1: west' }) + '\n')
  shown = banner('Which lake?')
  await cards.sync()
  await new Promise((r) => setTimeout(r, 150))
  // K2 asked a second after K1: the wait's name now
  assert.deepEqual(reraised, [new Date((BASE - 19) * 1000).toISOString()])
})

test('★ after an answer from the phone with nothing else waiting, no extra "needs you"', async (t) => {
  const l = questionLab(t)
  const reraised: string[] = []
  const cards = await l.start({ ...l.deps, unconfirmedMs: 60, reraised: (_c, card) => reraised.push(card) })
  await cards.sync()
  assert.equal(answerPermission({ key: agyCards()[0]!.key, behavior: 'allow', answers: { 'Which colors?': ['blue'] } }, 'test').ok, true)
  await settle()
  // answered: the question is no longer pending
  appendFileSync(l.transcript, JSON.stringify({ step_index: 2, type: 'GENERIC', content: 'A1: blue' }) + '\n')
  l.setState({ tool_confirmation_pending: false, agent_state: 'working' }, BASE + 2)
  await cards.sync()
  await new Promise((r) => setTimeout(r, 120))
  assert.deepEqual(reraised, [])
})

test('★ a follow-up question asked after the phone’s answer rings on its own, not a second time from that answer', async (t) => {
  const l = questionLab(t)
  const reraised: string[] = []
  const cards = await l.start({ ...l.deps, unconfirmedMs: 80, reraised: (_c, card) => reraised.push(card) })
  await cards.sync()
  assert.equal(answerPermission({ key: agyCards()[0]!.key, behavior: 'allow', answers: { 'Which colors?': ['blue'] } }, 'test').ok, true)
  await settle()
  // answered; agy asks the next question at once
  const now = Date.now() / 1000 + 1
  appendFileSync(l.transcript, JSON.stringify({ step_index: 2, type: 'GENERIC', content: 'A1: blue' }) + '\n')
  appendFileSync(l.transcript, JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', created_at: new Date(now * 1000).toISOString(), tool_calls: [{ name: 'ask_question', args: { questions: [{ question: 'Which size?', options: ['s', 'm'] }] } }] }) + '\n')
  utimesSync(l.transcript, now, now)
  l.setState({ tool_confirmation_pending: false, agent_state: 'tool_use' }, now + 1)
  await cards.sync()
  await new Promise((r) => setTimeout(r, 150))
  assert.deepEqual(reraised, [])
})

test('★★ a card keeps its input, its call time and its agy beside it; an answer\'s later check reaches the key (teams / docs/TEAM.md §9)', async (t) => {
  const l = lab(t)
  const seen: (boolean | undefined)[] = []
  const cards = new AgyCards({
    ...l.deps,
    answer: async (_c, _m, _b, stillWanted) => {
      seen.push(stillWanted?.())
      return { ok: true }
    },
  })
  await cards.sync()
  const [c] = agyCards()
  const meta = pendingWithMeta().find((p) => p.info.key === c!.key)?.meta
  assert.deepEqual(meta?.toolInput, { command: 'ls' })
  assert.equal(meta?.requestedAt, (BASE - 60) * 1000)
  assert.equal(meta?.agyPid, PID)
  // ★ the answer's own "still valid" is asked right before the key (a team disbanded meanwhile ⇒ false)
  assert.equal(answer(c!.key, 'allow', { stillValid: () => false }), true)
  await settle()
  assert.deepEqual(seen, [false])
})

test('★★ a question answer carries its own "still valid" to the keys, and keeps its call time and agy (teams / codex review)', async (t) => {
  const l = questionLab(t)
  const asked: (boolean | undefined)[] = []
  const cards = await l.start({
    ...l.deps,
    answerQuestion: async (_c, _m, _a, stillWanted) => {
      asked.push(stillWanted?.())
      return { ok: true }
    },
  })
  await cards.sync()
  const [c] = agyCards()
  const meta = pendingWithMeta().find((p) => p.info.key === c!.key)?.meta
  assert.equal(meta?.requestedAt, Math.min((BASE - 60) * 1000, (BASE - 10) * 1000))
  assert.equal(meta?.agyPid, PID)
  assert.equal(answerPermission({ key: c!.key, behavior: 'allow', answers: { 'Which colors?': ['blue'] } }, 'team', undefined, () => false).ok, true)
  await settle()
  assert.deepEqual(asked, [false])
})

test('★★ an agy card\'s origin is its call: the same across a status rewrite, another for a different call at the same place (codex review)', () => {
  const row = { sessionId: `agy-${A}`, machine: 'pc-a', account: 'agy', project: 'p' } as unknown as Parameters<typeof agyCard>[0]
  const mark = { pid: PID, stateMtimeMs: BASE * 1000, step: 3, index: 0, callAt: (BASE - 60) * 1000 }
  const call = (cmd: string) => ({ name: 'run_command', args: { CommandLine: cmd } }) as unknown as Parameters<typeof agyCard>[2]
  const at = new Date().toISOString()
  const a = agyCard(row, mark, call('ls'), at)!
  // a status rewrite (a new state time): the same call, the same origin
  assert.equal(agyCard(row, { ...mark, stateMtimeMs: (BASE + 1) * 1000 }, call('ls'), at)!.origin, a.origin)
  // after a rewind: another command at the same step and index ⇒ another origin (another ref for the leader)
  assert.notEqual(agyCard(row, mark, call('rm -rf build'), at)!.origin, a.origin)
  assert.notEqual(agyCard(row, { ...mark, callAt: mark.callAt + 5000 }, call('ls'), at)!.origin, a.origin)
})

test('★ an agy question\'s origin is its call too (another question at the same place after a rewind is another origin)', () => {
  const row = { sessionId: `agy-${A}`, machine: 'pc-a', account: 'agy', project: 'p' } as unknown as Parameters<typeof agyQuestionCard>[0]
  const mark = { pid: PID, askedAt: (BASE - 10) * 1000, step: 3, index: 0, callAt: (BASE - 60) * 1000 }
  const q = (question: string) => ({ items: [{ question, options: ['a', 'b'], multi: false }] }) as unknown as Parameters<typeof agyQuestionCard>[2]
  const at = new Date().toISOString()
  const a = agyQuestionCard(row, mark, q('Deploy now?'), at)
  assert.equal(agyQuestionCard(row, { ...mark, askedAt: mark.askedAt + 1 }, q('Deploy now?'), at).origin, a.origin)
  assert.notEqual(agyQuestionCard(row, mark, q('Delete the branch?'), at).origin, a.origin)
  assert.notEqual(agyQuestionCard(row, { ...mark, callAt: mark.callAt + 5000 }, q('Deploy now?'), at).origin, a.origin)
})

test('★★ list (agy 1.5.16): the oldest asking subagent comes to the phone — a grandchild, or one of two asking the same (docs/AGY.md §19)', async (t) => {
  const l = questionLab(t)
  const iso = (sec: number): string => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const K1 = '15bc1e2a-6a62-4f86-9bf9-dd03e99f6627'
  const K2 = '70039de1-d758-4556-afa8-5d36b9625540'
  const G = '2b7c1e44-0d6e-4a55-9a1d-6c0f4b2f7a11'
  const kid = (id: string, parent: string, n: number, calls: Record<string, unknown>[], at: number): void => {
    const p = transcriptPathOf(id, l.deps.agy().home)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(
      p,
      [
        { type: 'SYSTEM_MESSAGE', step_index: 0, created_at: iso(BASE - 35), content: `x\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=${iso(BASE - 35)} sender=${parent} priority=MESSAGE_PRIORITY_HIGH content=p${n}\n</SYSTEM_MESSAGE>` },
        { type: 'PLANNER_RESPONSE', step_index: 1, created_at: iso(BASE - 35), tool_calls: calls },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    )
    utimesSync(p, at, at)
  }
  const ask = (question: string): Record<string, unknown> => ({ name: 'ask_question', args: { questions: [{ question, options: ['a', 'b'] }] } })
  // K1 coordinates (its own subagent G asks); K2 asks the same question G asks, later
  kid(K1, A, 0, [{ name: 'invoke_subagent', args: { Prompt: 'g' } }], BASE - 25)
  kid(G, K1, 9, [ask('Which planet?')], BASE - 20)
  kid(K2, A, 1, [ask('Which moon?')], BASE - 18)
  writeFileSync(l.transcript, JSON.stringify({ type: 'USER_INPUT', step_index: 0, content: '<USER_REQUEST>\ngo\n</USER_REQUEST>' }) + '\n')
  utimesSync(l.transcript, BASE - 30, BASE - 30)
  l.setState({ tool_confirmation_pending: false, agent_state: 'idle', subagents: [{ name: 'self', role: 'p0', status: 'running' }, { name: 'self', role: 'p1', status: 'running' }] }, BASE)
  const rule = '─'.repeat(40)
  const list = [' ┃ self has a question', ' ┃', ' ┃ ? Which planet?', ' ┃ ctrl+k answer · alt+j manage', rule, '>', rule,
    '  ● Agent(self: Coordinator) · Gemini 4 Neon  Delegating · 20s',
    '  ● Agent(self: Planet Asker) · Gemini 4 Neon  Blocked · AskQuestion · 15s',
    '  ● Agent(self: Planet Asker 2) · Gemini 4 Neon  Blocked · AskQuestion · 12s', rule, '? for shortcuts'].join('\n')
  const bannerOnly = list.split('\n').filter((x) => !x.includes('● Agent')).join('\n')
  // ★ the list: the oldest asking one — the grandchild's — is the card (the answer finds it in the list by its id)
  resetPending()
  await new AgyCards(withScreen(l, () => list)).sync()
  assert.deepEqual(agyCards().map((c) => [c.summary, c.subagent]), [['Which planet?', {}]])
  // ★ two asking the very same text (§19.1 case 4): still a card (the id tells them apart), where the banner gave none
  kid(K2, A, 1, [ask('Which planet?')], BASE - 18)
  resetPending()
  await new AgyCards(withScreen(l, () => bannerOnly)).sync()
  assert.equal(agyCards().length, 0)
  resetPending()
  await new AgyCards(withScreen(l, () => list)).sync()
  assert.deepEqual(agyCards().map((c) => c.summary), ['Which planet?'])
  // ⚠️ fewer rows asking than calls asking (a killed one's leftover question is not in the list): no card (codex · agy review)
  resetPending()
  await new AgyCards(withScreen(l, () => list.replace('Planet Asker 2) · Gemini 4 Neon  Blocked · AskQuestion', 'Planet Asker 2) · Gemini 4 Neon  Thinking'))).sync()
  assert.equal(agyCards().length, 0)
  // ⚠️ a listed one asks what the phone does not take, a killed one's leftover is not listed: counted over all calls
  //    (codex · agy review: the counts matched and the leftover's card came back after every failed answer)
  kid(K2, A, 1, [{ name: 'ask_question', args: { questions: [{ question: 'Twin?', options: ['x', 'x'] }] } }], BASE - 18)
  resetPending()
  await new AgyCards(withScreen(l, () => list.replace('Planet Asker) · Gemini 4 Neon  Blocked · AskQuestion', 'Planet Asker) · Gemini 4 Neon  Thinking'))).sync()
  assert.equal(agyCards().length, 0)
  kid(K2, A, 1, [ask('Which planet?')], BASE - 18)
  // ★ a call the list was walked for whole without finding it: not raised again; the next one is (codex review)
  const callOf = (id: string): { step: number; index: number; callAt: number } => ({ step: 1, index: 0, callAt: (BASE - 35) * 1000 })
  noteUnlisted({ pid: PID, child: G, ...callOf(G) })
  kid(K2, A, 1, [ask('Which moon?')], BASE - 18)
  resetPending()
  await new AgyCards(withScreen(l, () => list.replace('Planet Asker) · Gemini 4 Neon  Blocked · AskQuestion', 'Planet Asker) · Gemini 4 Neon  Thinking'))).sync()
  assert.deepEqual(agyCards().map((c) => c.summary), ['Which moon?'], "K2's, with G's left out")
  resetAgyUnlistedForTest()
  kid(K2, A, 1, [ask('Which planet?')], BASE - 18)
  // ⚠️ something typed in the PC's box (the answer could not go into the list): no card
  resetPending()
  await new AgyCards(withScreen(l, () => list.replace('\n>\n', '\n> half typed\n'))).sync()
  assert.equal(agyCards().length, 0)
  // ★ two asking the same text, the PC opened one's dialog: told by its owner (codex review)
  kid(K2, A, 1, [ask('Which planet?')], BASE - 18)
  const openOfK2 = ['  main › self', '  ● running · Gemini 4 Neon (High) · 9s · 3 steps', `  ID: ${K2}`, 'Question', '────', 'Question 1/1: Which planet?', '', '> 1. a', '  2. b', '  3. Write-in...', '', '  ↑/↓ Navigate · enter Select · esc Skip'].join('\n')
  l.setState({ tool_confirmation_pending: false, agent_state: 'idle', version: '1.5.16', subagents: [{ name: 'self', role: 'p0', status: 'running' }, { name: 'self', role: 'p1', status: 'running' }] }, BASE)
  resetPending()
  await new AgyCards(withScreen(l, () => openOfK2)).sync()
  assert.deepEqual(agyCards().map((c) => c.summary), ['Which planet?'])
  l.setState({ tool_confirmation_pending: false, agent_state: 'idle', subagents: [{ name: 'self', role: 'p0', status: 'running' }, { name: 'self', role: 'p1', status: 'running' }] }, BASE)
  resetPending()
  await new AgyCards(withScreen(l, () => openOfK2)).sync()
  assert.equal(agyCards().length, 0, 'before 1.5.16: ambiguous by text, as before')
  // ★ two asking in the same tick: one of them by id, not none (codex review)
  kid(K2, A, 1, [ask('Which moon?')], BASE - 20)
  resetPending()
  await new AgyCards(withScreen(l, () => list)).sync()
  assert.equal(agyCards().length, 1)
  // ⚠️⚠️ agy 1.5.16+ with the banner only (the list not readable): no card from the banner (ctrl+k approves there)
  kid(K2, A, 1, [ask('Which moon?')], BASE - 18)
  l.setState({ tool_confirmation_pending: false, agent_state: 'idle', version: '1.5.16', subagents: [{ name: 'self', role: 'p0', status: 'running' }, { name: 'self', role: 'p1', status: 'running' }] }, BASE)
  resetPending()
  await new AgyCards(withScreen(l, () => bannerOnly)).sync()
  assert.equal(agyCards().length, 0)
  // ★ agy 1.5.16+ with the PC on a finished subagent's view (left there after an answer): the card still comes — the
  //   answer goes back to the parent's view first (codex review round 5: not offering it stranded the PC there)
  const X = '3c9d2e55-1f7f-4b66-8b2e-7d1a5c3b8e22'
  const px = transcriptPathOf(X, l.deps.agy().home)
  mkdirSync(join(px, '..'), { recursive: true })
  writeFileSync(px, [{ type: 'SYSTEM_MESSAGE', step_index: 0, content: 'x' }, { type: 'PLANNER_RESPONSE', step_index: 1, content: 'Reported back.' }].map((r) => JSON.stringify(r)).join('\n') + '\n')
  const viewOfX = ['  main › self', '  ● done · Gemini 4 Neon (High) · 9s · 3 steps', `  ID: ${X}`, '', '  ↑/↓ scroll · pgup/pgdown page · ctrl+end bottom · ctrl+home top', '  ctrl+o expand · shift+k kill · esc back'].join('\n')
  resetPending()
  await new AgyCards(withScreen(l, () => viewOfX)).sync()
  assert.equal(agyCards().length, 1)
  // ★ … also when two ask the same text (1.5.16: told by id in the list / codex review)
  kid(K2, A, 1, [ask('Which planet?')], BASE - 18)
  resetPending()
  await new AgyCards(withScreen(l, () => viewOfX)).sync()
  assert.equal(agyCards().length, 1)
  kid(K2, A, 1, [ask('Which moon?')], BASE - 18)
  // ★ the PC left on an asking subagent's view, its question closed ("a respond"): that one (codex review)
  l.setState({ tool_confirmation_pending: false, agent_state: 'idle', version: '1.5.16', subagents: [{ name: 'self', role: 'p0', status: 'running' }, { name: 'self', role: 'p1', status: 'running' }] }, BASE)
  const viewOfK2 = ['  main › self', '  ● running · Gemini 4 Neon (High) · 9s · 3 steps', `  ID: ${K2}`, '  ⚠ Approval Required', '    AskQuestion', '      ? Which moon?', '', '  ↑/↓ scroll · pgup/pgdown page · ctrl+end bottom · ctrl+home top · ctrl+o expand · a respond · shift+k kill · esc back'].join('\n')
  resetPending()
  await new AgyCards(withScreen(l, () => viewOfK2)).sync()
  assert.deepEqual(agyCards().map((c) => c.summary), ['Which moon?'])
  l.setState({ tool_confirmation_pending: false, agent_state: 'idle', subagents: [{ name: 'self', role: 'p0', status: 'running' }, { name: 'self', role: 'p1', status: 'running' }] }, BASE)
  // (before 1.5.16 too, as before)
  l.setState({ tool_confirmation_pending: false, agent_state: 'idle', subagents: [{ name: 'self', role: 'p0', status: 'running' }, { name: 'self', role: 'p1', status: 'running' }] }, BASE)
  resetPending()
  await new AgyCards(withScreen(l, () => viewOfX)).sync()
  assert.equal(agyCards().length, 1)
})
