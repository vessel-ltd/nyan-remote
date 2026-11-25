import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AGY_CHILD_APPROVAL, waitingReason } from '../../../shared/types.ts'
import { localizeNotificationBody } from '../../../shared/i18n.ts'
import { approvalWaits, scanAgyBlocked } from './blocked.ts'
import { readSubagentEntries } from './screen.ts'
import { agyBlockedAt, agyBlockedWaits, agyOwnRows, agyQuestionWaitAt, noteAgyBlocked, readAgyPidFile, resetAgyBlockedForTest, type AgyDeps } from './sessions.ts'

const A = '062a8f25-9451-42f3-ae93-34a208e99365'
const PID = 4242
const START = '123456'
const BASE = Math.floor(Date.now() / 1000)

// ★ The parent's view of agy 1.5.16 with two subagents waiting on a command (measured 2026-11-25 / screen.test.ts)
const PARENT_LIST = " ┃ ● Bash(echo alpha-cmd)\n ┃\n ┃ ctrl+k approve · alt+j manage\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n>\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n> ● Agent(self: Beta Command Runner) · Gemini 4 Neon  Blocked · Bash · 37s\n  ● Agent(self: Alpha Command Runner) · Gemini 4 Neon  Blocked · Bash · 39s\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n? for shortcuts                                                      accept-edits · Gemini 4 Neon · high · 2 subagent(s)"
const RUNNING = PARENT_LIST.replace('Blocked · Bash · 37s', 'Echo beta-cmd · 1m4s').replace('Blocked · Bash · 39s', 'Echo alpha-cmd · 1m6s')
const ASKING = PARENT_LIST.replace('Blocked · Bash · 37s', 'Blocked · AskQuestion · 37s').replace('Blocked · Bash · 39s', 'Echo alpha-cmd · 1m6s')

interface Rig {
  deps: AgyDeps
  setState(over: Record<string, unknown>): void
  screen: { now: string | undefined }
}

function rig(t: { after(fn: () => void): void }, opts: { screen?: boolean; locks?: readonly string[] } = {}): Rig {
  resetAgyBlockedForTest()
  const root = mkdtempSync(join(tmpdir(), 'nyan-agy-blocked-'))
  const prev = process.env.NYAN_REMOTE_STATE_DIR
  process.env.NYAN_REMOTE_STATE_DIR = root
  const dir = join(root, 'agy')
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(root, 'panes'), { recursive: true })
  writeFileSync(join(root, 'panes', `${PID}.json`), JSON.stringify({ pid: PID, procStart: START, socket: join(root, 'k.sock'), startedAt: (BASE - 1000) * 1000, paste: true, screen: opts.screen !== false }))
  const setState = (over: Record<string, unknown>): void => {
    const body = JSON.stringify({ nyanPid: PID, nyanBusyAt: BASE, input: { conversation_id: A, cwd: '/home/user/p', agent_state: 'idle', version: '1.5.16', subagents: [{ status: 'running', role: 'x' }], ...over } })
    const f = join(dir, `pid-${PID}.json`)
    writeFileSync(f, body)
    utimesSync(f, BASE, BASE)
  }
  setState({})
  t.after(() => {
    resetAgyBlockedForTest()
    if (prev === undefined) delete process.env.NYAN_REMOTE_STATE_DIR
    else process.env.NYAN_REMOTE_STATE_DIR = prev
    rmSync(root, { recursive: true, force: true })
  })
  const screen: Rig['screen'] = { now: PARENT_LIST }
  const deps: AgyDeps = { dir, home: join(root, 'home'), isAgy: () => true, now: Date.now(), aliveProcStart: () => START, locksOf: () => [...(opts.locks ?? [A])] }
  return { deps, setState, screen }
}

const scan = (r: Rig): Promise<boolean> => scanAgyBlocked(r.deps, async () => r.screen.now)
const state = (r: Rig) => readAgyPidFile(r.deps.dir, PID)!.state

test('a list shows an approval wait: a child blocked on anything but a question', () => {
  assert.deepEqual(approvalWaits([{ name: 'a', blockedOn: 'Bash' }]), ['a'])
  assert.deepEqual(approvalWaits([{ name: 'a', blockedOn: 'AskQuestion' }, { name: 'b' }]), [])
  assert.deepEqual(approvalWaits([{ name: 'a', blockedOn: 'Read' }, { name: 'b', blockedOn: 'Bash' }]), ['a', 'b'])
  assert.deepEqual(approvalWaits([]), [])
})

test('★ counted, not named: one more blocked is a new wait; one fewer keeps the newer starts; a resize changes nothing', () => {
  resetAgyBlockedForTest()
  const s = { conversationId: A, pid: PID, subagentsActive: true }
  const starts = (): number[] => agyBlockedWaits(s).map((k) => k.since)
  assert.equal(noteAgyBlocked(A, PID, 1, 1000), true)
  assert.equal(agyBlockedAt(s), 1000)
  // the same count (a resize cut its name, its time ticked): nothing new
  assert.equal(noteAgyBlocked(A, PID, 1, 1500), false)
  assert.equal(agyBlockedAt(s), 1000)
  // ★ a second one, while the first still waits: a new wait (codex review)
  assert.equal(noteAgyBlocked(A, PID, 2, 2000), true)
  assert.equal(agyBlockedAt(s), 2000)
  assert.deepEqual(starts(), [1000, 2000])
  const ids = agyBlockedWaits(s).map((k) => k.id)
  // ★ one fewer: the newer start (and its number) stays — a leader may hear again, never not at all
  assert.equal(noteAgyBlocked(A, PID, 1, 3000), true)
  assert.deepEqual(starts(), [2000])
  assert.deepEqual(agyBlockedWaits(s).map((k) => k.id), [ids[1]])
  assert.equal(noteAgyBlocked(A, PID, 3, 4000), true)
  assert.deepEqual(starts(), [2000, 4000, 4000])
  assert.equal(new Set(agyBlockedWaits(s).map((k) => k.id)).size, 3, 'each its own number')
  // another agy process on the conversation: new
  assert.equal(noteAgyBlocked(A, PID + 1, 1, 6000), true)
  assert.equal(agyBlockedAt({ ...s, pid: PID + 1 }), 6000)
  assert.equal(agyBlockedAt(s), undefined)
  assert.equal(noteAgyBlocked(A, PID + 1, 0, 7000), true)
  assert.equal(agyBlockedAt({ ...s, pid: PID + 1 }), undefined)
  resetAgyBlockedForTest()
})

test('★ wrapped rows are joined (codex review: one long row hid the list); a menu in the list\'s place keeps the reading (agy review)', async (t) => {
  assert.deepEqual(readSubagentEntries(PARENT_LIST), [
    { name: 'self: Beta Command Runner', blockedOn: 'Bash' },
    { name: 'self: Alpha Command Runner', blockedOn: 'Bash' },
  ])
  // ★ the state is the row's end: words inside a running step are not it (codex review)
  for (const words of ['Searching for Blocked · Bash in logs · 6s', 'Searching logs for Blocked · Bash · 6s']) {
    const step = RUNNING.replace('Echo alpha-cmd · 1m6s', words)
    assert.deepEqual(readSubagentEntries(step)?.map((e) => e.blockedOn), [undefined, undefined], words)
  }
  // the state wrapped onto the next row whole: still the state
  const folded = PARENT_LIST.replace('  ● Agent(self: Alpha Command Runner) · Gemini 4 Neon  Blocked · Bash · 39s', '  ● Agent(self: Alpha Command Runner) · Gemini 4 Neon\n  Blocked · Bash · 39s')
  assert.deepEqual(readSubagentEntries(folded)?.[1], { name: 'self: Alpha Command Runner', blockedOn: 'Bash' })
  // ★ a row cut short anywhere is "cut" (what it waits on cannot be told / codex · agy review, rounds 8–9)
  const alpha = '  ● Agent(self: Alpha Command Runner) · Gemini 4 Neon  Blocked · Bash · 39s'
  for (const cutRow of ['  ● Agent(self: Alpha Command Runner) · Gemi…', '  ● Agent(self: Alpha Command Runner) · Gemini 4 Neon  Blo…', '  ● Agent(self: Alpha Command Runner) · Gemini 4 Neon  Blocked · …', '  ● Agent(self: Alpha Command Runner) · Gemini 4 Neon  Blocked · Ba…', '  ● Agent(self: Alpha Command Runner) · Gemini\n  4 Ne…']) {
    const e = readSubagentEntries(PARENT_LIST.replace(alpha, cutRow))?.[1]
    assert.equal(e?.cut, true, cutRow)
    assert.equal(e?.blockedOn, undefined, cutRow)
  }
  // a name cut short but its state and time whole: read
  const cutName = PARENT_LIST.replace(alpha, '  ● Agent(self: Alpha Comm…  Blocked · Bash · 44s')
  assert.equal(readSubagentEntries(cutName)?.[1]?.blockedOn, 'Bash')
  assert.equal(readSubagentEntries(cutName)?.[1]?.cut, undefined)
  const r = rig(t)
  // a long sibling row wraps while another child is blocked: still seen
  r.screen.now = PARENT_LIST.replace('  ● Agent(self: Alpha Command Runner) · Gemini 4 Neon  Blocked · Bash · 39s', '  ● Agent(self: Alpha Command Runner) · Gemini 4 Neon\n  Echo alpha-cmd and a long step · 1m6s')
  assert.equal(await scan(r), true)
  assert.equal(agyBlockedWaits(state(r)).length, 1)
  // the blocked row itself wraps between its words: the same wait
  const at = agyBlockedAt(state(r))
  r.screen.now = r.screen.now!.replace('  Blocked · Bash · 37s', '\n  Blocked\n  · Bash · 37s').replace('Gemini 4 Neon\n  Blocked', 'Gemini 4 Neon  Blocked')
  assert.deepEqual(readSubagentEntries(r.screen.now!)?.[0], { name: 'self: Beta Command Runner', blockedOn: 'Bash' })
  assert.equal(await scan(r), false)
  assert.equal(agyBlockedAt(state(r)), at)
  // the slash menu (or a dialog, the parent's own card) in the list's place: kept, and not new when the list is back
  const menu = PARENT_LIST.replace(/> ● Agent[^]*?(?=\n─)/, '  /compact  Compact the conversation now\n  /clear    Clear everything')
  assert.equal(readSubagentEntries(menu), undefined)
  r.screen.now = menu
  assert.equal(await scan(r), false)
  assert.equal(agyBlockedAt(state(r)), at)
  // approved: the row runs on (wrapped)
  r.screen.now = RUNNING.replace('  ● Agent(self: Beta Command Runner) · Gemini 4 Neon  Echo beta-cmd · 1m4s', '  ● Agent(self: Beta Command Runner) · Gemini 4 Neon\n  Echo beta-cmd and a long step · 1m4s')
  assert.equal(await scan(r), true)
  assert.equal(agyBlockedAt(state(r)), undefined)
})

test('★ the agy moved off the conversation (/new keeps the old id in its file): forgotten (agy review)', async (t) => {
  const r = rig(t)
  await scan(r)
  assert.ok(agyBlockedAt(state(r)) !== undefined)
  const moved: Rig = { ...r, deps: { ...r.deps, locksOf: () => ['another'] } }
  assert.equal(await scan(moved), true)
  assert.equal(agyBlockedAt(state(r)), undefined)
  // a lock that cannot be probed keeps it
  await scan(r)
  const at = agyBlockedAt(state(r))
  assert.equal(await scan({ ...r, deps: { ...r.deps, locksOf: () => undefined } }), false)
  assert.equal(agyBlockedAt(state(r)), at)
})

test('★★ a subagent waiting on a command: the row needs you (it rings), says why, and clears when it runs on (case 8)', async (t) => {
  const r = rig(t)
  assert.equal(await scan(r), true)
  const at = agyBlockedAt(state(r))
  assert.ok(at !== undefined)
  // the wait the notifier and the leader's notice go by
  assert.equal(agyQuestionWaitAt(state(r), BASE * 1000, r.deps.home), at)
  const rows = agyOwnRows('pc-a', r.deps)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.status, 'waiting')
  assert.equal(rows[0]!.waitingFor, AGY_CHILD_APPROVAL)
  assert.equal(rows[0]!.lastActivity, new Date(at).toISOString())
  assert.equal(waitingReason(AGY_CHILD_APPROVAL), 'サブエージェントの承認')
  assert.equal(localizeNotificationBody('要対応（サブエージェントの承認）', 'en'), 'Needs you (subagent approval)')
  // the same wait on the next look: no change, same name
  assert.equal(await scan(r), false)
  assert.equal(agyBlockedAt(state(r)), at)
  // approved at the PC: the list shows them running
  r.screen.now = RUNNING
  assert.equal(await scan(r), true)
  assert.equal(agyBlockedAt(state(r)), undefined)
  assert.equal(agyOwnRows('pc-a', r.deps)[0]!.status, 'working')
})

test('a subagent question is not this (it has its own card)', async (t) => {
  const r = rig(t)
  r.screen.now = ASKING
  assert.equal(await scan(r), false)
  assert.equal(agyBlockedAt(state(r)), undefined)
})

test('a child view, a dialog or an unreadable screen keeps the last reading; the children ending forgets it', async (t) => {
  const r = rig(t)
  await scan(r)
  const at = agyBlockedAt(state(r))
  assert.ok(at !== undefined)
  for (const s of [undefined, '  main › self\n  ID: 1788a5a6-a988-4356-bcaf-5f50e974aa73\n\n  a respond · shift+k kill · esc back']) {
    r.screen.now = s
    assert.equal(await scan(r), false)
    assert.equal(agyBlockedAt(state(r)), at)
  }
  r.setState({ subagents: [{ status: 'completed', role: 'x' }] })
  assert.equal(await scan(r), true)
  r.setState({})
  assert.equal(agyBlockedAt(state(r)), undefined)
})

test('not read: no screen from the relay, an older agy, another agy holding the conversation', async (t) => {
  for (const [opts, over] of [[{ screen: false }, {}], [{}, { version: '1.5.15' }], [{ locks: [] }, {}]] as const) {
    const r = rig(t, opts)
    r.setState(over)
    assert.equal(await scan(r), false)
    assert.equal(agyBlockedAt(state(r)), undefined)
  }
})

test('the wait belongs to the agy that showed it (another process on the same conversation does not inherit it)', async (t) => {
  const r = rig(t)
  await scan(r)
  assert.equal(agyBlockedAt({ ...state(r), pid: PID + 1 }), undefined)
  assert.equal(agyBlockedAt({ ...state(r), subagentsActive: false }), undefined)
})

test('★ a cut row never clears a wait, and the rows read whole still add one (codex · agy review, round 9)', async (t) => {
  const r = rig(t)
  const alpha = '  ● Agent(self: Alpha Command Runner) · Gemini 4 Neon  Blocked · Bash · 39s'
  const beta = '> ● Agent(self: Beta Command Runner) · Gemini 4 Neon  Blocked · Bash · 37s'
  // beta waits (read whole), alpha's row is cut: one wait seen
  r.screen.now = PARENT_LIST.replace(alpha, '  ● Agent(self: Alpha Command Runner) · Gemi…')
  assert.equal(await scan(r), true)
  assert.equal(agyBlockedWaits(state(r)).length, 1)
  const at = agyBlockedAt(state(r))
  // beta's row cut too (a narrower terminal): kept, not cleared
  r.screen.now = r.screen.now.replace(beta, '> ● Agent(self: Beta Command Runner) · Gemini 4 Neon  Blo…')
  assert.equal(await scan(r), false)
  assert.equal(agyBlockedAt(state(r)), at)
  // widened again, alpha too is seen waiting: one more (new)
  r.screen.now = PARENT_LIST
  assert.equal(await scan(r), true)
  assert.equal(agyBlockedWaits(state(r)).length, 2)
  // ★ both approved while alpha's row is cut: at most one can still wait (codex · agy review, round 10)
  r.screen.now = RUNNING.replace('  ● Agent(self: Alpha Command Runner) · Gemini 4 Neon  Echo alpha-cmd · 1m6s', '  ● Agent(self: Alpha Command Runner) · Gemi…')
  assert.equal(await scan(r), true)
  assert.equal(agyBlockedWaits(state(r)).length, 1)
  // the terminal widened, none waits: cleared — and the next one blocking is a new wait
  r.screen.now = RUNNING
  assert.equal(await scan(r), true)
  assert.equal(agyBlockedAt(state(r)), undefined)
  r.screen.now = RUNNING.replace('Echo beta-cmd · 1m4s', 'Blocked · Bash · 2s')
  assert.equal(await scan(r), true)
  assert.equal(agyBlockedWaits(state(r)).length, 1)
  // ✅ accepted: while a row is cut, one wait seen may be the cut one's or a new one's — the count stays (still "needs you")
})
