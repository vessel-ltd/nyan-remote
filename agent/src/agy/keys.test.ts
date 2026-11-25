import assert from 'node:assert/strict'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AGY_CARD_KEYS, AGY_CLEAR_KEYS, clearAgy, compactAgy, agyTyped, answerAgyCard, answerAgyChildApproval, answerAgyQuestion, type AgyChildApprovalMark, type AgyQuestionMark, findAgyTarget, looksLikeAgyShortcut, readNow, sendGate, sendToAgy, stopAgy, stopGate, type AgyKeysDeps } from './keys.ts'
import { agyCardAt, agyChildrenSettledFor, agyChildrenSettledSeen, agyOwnRowOf, resetAgyCardNamesForTest, agyOwnRows, agyRows, transcriptPathOf } from './sessions.ts'
import { readTailRecords } from './pending.ts'
import { parseAgyQuestion } from './questions.ts'
import { writeSequence } from '../claude/keys.ts'
import { agyUnlisted, resetAgyUnlistedForTest } from './screen.ts'

const A = '062a8f25-9451-42f3-ae93-34a208e99365'
const PID = 4242
const START = '123456'
// ⚠️ File times near now (files of a gone agy older than a day are removed by `liveAgy`)
const BASE = Math.floor(Date.now() / 1000)

test('gates: text only while idle and written after the transcript; ESC only while working; a card stops both', () => {
  const idle = { agentState: 'idle', confirmationPending: false, subagentsActive: false }
  assert.equal(sendGate(idle, 2000, 1000, false), 'ok')
  assert.equal(sendGate(idle, 2000, 2000, false), 'ok')
  // ⚠️ the transcript moved after the status line said idle (a status line that stopped writing)
  assert.equal(sendGate(idle, 1000, 2000, false), 'unsure')
  assert.equal(sendGate(idle, 2000, undefined, false), 'unsure')
  assert.equal(sendGate({ agentState: 'error', confirmationPending: false, subagentsActive: false }, 2, 1, false), 'ok')
  for (const s of ['working', 'tool_use', 'reviewing']) assert.equal(sendGate({ agentState: s, confirmationPending: false, subagentsActive: false }, 2, 1, false), 'busy')
  for (const s of ['initializing', 'authenticating', undefined, 'new-state']) {
    assert.equal(sendGate({ agentState: s, confirmationPending: false, subagentsActive: false }, 2, 1, false), 'unsure', String(s))
  }
  assert.equal(sendGate({ agentState: 'tool_use', confirmationPending: true, subagentsActive: false }, 2, 1, false), 'waiting')
  // stop
  assert.equal(stopGate({ agentState: 'working', confirmationPending: false, subagentsActive: false }, 1, 2, false), 'ok')
  assert.equal(stopGate({ agentState: 'tool_use', confirmationPending: true, subagentsActive: false }, 1, 2, false), 'waiting')
  assert.equal(stopGate(idle, 2, 1, false), 'idle')
  assert.equal(stopGate(idle, 1, 2, false), 'unsure')
  // ★ a question (docs/AGY.md §11): no text (it would go into the write-in), no ESC (it skips the question)
  assert.equal(sendGate({ agentState: 'tool_use', confirmationPending: false, subagentsActive: false }, 2, 1, true), 'asking')
  assert.equal(stopGate({ agentState: 'tool_use', confirmationPending: false, subagentsActive: false }, 2, 1, true), 'asking')
  // a card is still a card
  assert.equal(sendGate({ agentState: 'tool_use', confirmationPending: true, subagentsActive: false }, 2, 1, true), 'waiting')
  assert.equal(stopGate({ agentState: 'tool_use', confirmationPending: true, subagentsActive: false }, 2, 1, true), 'waiting')
  // ★ a child agent not finished (its question may be open on the PC and take the keys): neither text nor ESC
  assert.equal(sendGate({ ...idle, subagentsActive: true }, 2000, 1000, false), 'subagent')
  assert.equal(stopGate({ agentState: 'working', confirmationPending: false, subagentsActive: true }, 1, 2, false), 'subagent')
})

test('text: `?` first (the shortcuts panel) is told apart, also behind invisible characters; one space goes after', () => {
  assert.equal(looksLikeAgyShortcut('?why'), true)
  assert.equal(looksLikeAgyShortcut('  ​?why'), true)
  assert.equal(looksLikeAgyShortcut('why?'), false)
  assert.equal(agyTyped('look at @no'), 'look at @no ')
  assert.equal(agyTyped('ends with \\'), 'ends with \\ ')
  assert.equal(agyTyped('already '), 'already ')
  assert.equal(agyTyped('two\nlines\n'), 'two\nlines\n')
})

interface Lab {
  root: string
  deps: AgyKeysDeps
  stateFile: string
  transcript: string
  sock: string
  got: string[]
  server: Server
  setState(over: Record<string, unknown>, mtimeSec?: number): void
}

async function lab(t: { after(fn: () => void): void }, opts: { pane?: boolean; paste?: boolean; startedAt?: number } = {}): Promise<Lab> {
  resetAgyCardNamesForTest()
  const root = mkdtempSync(join(tmpdir(), 'nyan-agy-keys-'))
  const prev = process.env.NYAN_REMOTE_STATE_DIR
  process.env.NYAN_REMOTE_STATE_DIR = root
  const dir = join(root, 'agy')
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(root, 'panes'), { recursive: true })
  const home = join(root, 'home')
  const transcript = join(home, '.gemini', 'antigravity-cli', 'brain', A, '.system_generated', 'logs', 'transcript_full.jsonl')
  mkdirSync(join(transcript, '..'), { recursive: true })
  writeFileSync(transcript, '{"type":"USER_INPUT","source":"USER_EXPLICIT","content":"<USER_REQUEST>\\nhello\\n</USER_REQUEST>"}\n')
  utimesSync(transcript, BASE - 100, BASE - 100)
  const stateFile = join(dir, `session-${A}.json`)
  const setState = (over: Record<string, unknown>, mtimeSec = BASE): void => {
    const body = JSON.stringify({ nyanPid: PID, nyanBusyAt: 0, input: { conversation_id: A, cwd: '/home/user/p', agent_state: 'idle', version: '1.5.14', ...over } })
    // ★ the relay hook writes both: the conversation's file and this agy's own (`pid-<pid>.json`)
    for (const f of [stateFile, join(dir, `pid-${PID}.json`)]) {
      writeFileSync(f, body)
      utimesSync(f, mtimeSec, mtimeSec)
    }
  }
  setState({})
  const sock = join(root, 'k.sock')
  const got: string[] = []
  const server = createServer((c) => {
    let buf = ''
    c.on('data', (d) => {
      buf += d.toString('latin1')
      // ★ a paste request: answer like the relay
      if (buf.startsWith('\x00') && buf.includes('\x1b[201~') && !buf.includes('+sent')) {
        buf += '+sent'
        c.write(opts.paste === false ? '-' : '+')
      }
    })
    c.on('end', () => got.push(buf.replace('+sent', '')))
  })
  await new Promise<void>((r) => server.listen(sock, r))
  if (opts.pane !== false) {
    writeFileSync(join(root, 'panes', `${PID}.json`), JSON.stringify({ pid: PID, procStart: START, socket: sock, startedAt: opts.startedAt ?? (BASE - 1000) * 1000, paste: opts.paste ?? true }))
  }
  t.after(() => {
    server.close()
    if (prev === undefined) delete process.env.NYAN_REMOTE_STATE_DIR
    else process.env.NYAN_REMOTE_STATE_DIR = prev
    rmSync(root, { recursive: true, force: true })
  })
  const deps: AgyKeysDeps = { dir, home, isAgy: (p) => p === PID, now: Date.now(), aliveProcStart: (p) => (p === PID ? START : null), locksOf: (p) => (p === PID ? [A] : []) }
  return { root, deps, stateFile, transcript, sock, got, server, setState }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50))

test('★★ send: typed with one space, then Enter — only to an idle agy found through its pane', async (t) => {
  const l = await lab(t)
  const res = await sendToAgy(A, ' hello there', l.deps)
  assert.equal(res.ok, true, res.message)
  // ★ what agy records (trimmed): the phone matches its "sending" line against it
  assert.equal(res.recorded, 'hello there')
  await settle()
  assert.deepEqual(l.got, [' hello there \r'])
  // the row says it can be typed into
  const rows = await agyRows('pc-a', { ...l.deps })
  assert.equal(rows[0]?.sendRoute, 'keys')
})

test('★★ a team send is bound to its agy: another pid, or a change right before the keys, types nothing (docs/TEAM.md §9)', async (t) => {
  const l = await lab(t)
  const other = await sendToAgy(A, 'hello', l.deps, (target) => target.pid === target.pid + 1)
  assert.equal(other.reason, 'unsure')
  // wanted at the target, gone right before the body (the team ended while it waited / the agy moved)
  let asks = 0
  const late = await sendToAgy(A, 'hello', l.deps, () => ++asks <= 1)
  assert.equal(late.reason, 'unsure')
  await settle()
  assert.equal(l.got.join(''), '', 'not a byte')
  // gone right before Enter: the body stays in the box, never submitted (said as partial)
  asks = 0
  const half = await sendToAgy(A, 'hello', l.deps, () => ++asks <= 2)
  assert.equal(half.reason, 'partial')
  await settle()
  assert.equal(l.got.join(''), 'hello ', 'no Enter')
  const ok = await sendToAgy(A, 'hello', l.deps, () => true)
  assert.equal(ok.ok, true, ok.message)
})

test('★★ send refused (nothing written): busy, waiting, a stale idle, `?` / `/` first, unknown conversation, no relay', async (t) => {
  const l = await lab(t)
  const id = `agy-${A}`
  l.setState({ agent_state: 'working' })
  assert.equal((await sendToAgy(A, 'hi', l.deps)).reason, 'busy')
  l.setState({ agent_state: 'tool_use', tool_confirmation_pending: true })
  assert.equal((await sendToAgy(A, 'yes', l.deps)).reason, 'waiting')
  // ⚠️ idle written before the transcript's last write
  l.setState({}, BASE - 200)
  assert.equal((await sendToAgy(A, 'hi', l.deps)).reason, 'unsure')
  l.setState({})
  assert.equal((await sendToAgy(A, '?why', l.deps)).reason, 'shortcut-like')
  assert.equal((await sendToAgy(A, '/exit', l.deps)).reason, 'command-like')
  assert.equal((await sendToAgy(A, '   ', l.deps)).reason, 'empty')
  assert.equal((await sendToAgy('6c0298e8-77c4-406c-aa97-cbecdfd19c88', 'hi', l.deps)).reason, 'not-open')
  // the agy is gone
  assert.equal((await sendToAgy(A, 'hi', { ...l.deps, isAgy: () => false })).reason, 'not-open')
  // a reused pid (another start time) is never typed into
  assert.equal((await sendToAgy(A, 'hi', { ...l.deps, aliveProcStart: () => '999' })).reason, 'unverified')
  rmSync(join(l.root, 'panes', `${PID}.json`))
  assert.equal((await sendToAgy(A, 'hi', l.deps)).reason, 'no-relay')
  const rows = await agyRows('pc-a', { ...l.deps })
  assert.equal(rows[0]?.sendRoute, undefined)
  await settle()
  assert.deepEqual(l.got, [])
})

test('★★★ a card that comes up between the body and Enter: Enter is not sent (partial, never retried)', async (t) => {
  const l = await lab(t)
  // the card appears as soon as the body arrives
  l.server.removeAllListeners('connection')
  l.server.on('connection', (c) => {
    let buf = ''
    c.on('data', (d) => {
      buf += d.toString()
      l.setState({ agent_state: 'tool_use', tool_confirmation_pending: true }, BASE + 10)
    })
    c.on('close', () => l.got.push(buf))
  })
  const res = await sendToAgy(A, 'hello', l.deps)
  assert.equal(res.reason, 'partial')
  await settle()
  assert.deepEqual(l.got, ['hello '])
})

test('★★ one card whose state agy writes twice keeps one name (it rang twice / measured 1.5.15); a new call is a new card', async (t) => {
  const l = await lab(t)
  const iso = (sec: number): string => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const call = (step: number, at: number): string =>
    JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: step, created_at: iso(at), tool_calls: [{ name: 'run_command', args: { CommandLine: 'date' } }] }) + '\n'
  appendFileSync(l.transcript, call(1, BASE - 5))
  utimesSync(l.transcript, BASE - 5, BASE - 5)
  l.setState({ agent_state: 'tool_use', tool_confirmation_pending: true }, BASE + 0.905)
  const first = agyOwnRows('pc-a', l.deps)[0]?.lastActivity
  assert.equal(first, new Date((BASE + 0.905) * 1000).toISOString())
  // agy writes the same card's state again 0.3 s later: the same name (the notifier tells it once)
  l.setState({ agent_state: 'tool_use', tool_confirmation_pending: true }, BASE + 1.199)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.lastActivity, first)
  assert.equal(agyOwnRowOf('pc-a', l.deps, A)?.lastActivity, first)
  // ⚠️ answered, its result written before agy rewrites its state: that write keeps its name (agy review: it went back
  //    to its own time and rang the answered card)
  const before = readFileSync(l.transcript, 'utf8')
  appendFileSync(l.transcript, JSON.stringify({ type: 'GENERIC', step_index: 2, created_at: iso(BASE + 1), content: `Created At: ${iso(BASE - 5)}\nran` }) + '\n')
  utimesSync(l.transcript, BASE + 1.3, BASE + 1.3)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.lastActivity, first)
  writeFileSync(l.transcript, before)
  utimesSync(l.transcript, BASE - 5, BASE - 5)
  // ⚠️ two calls in one response: the first one's result moves the pending call to the second while the state still
  //    shows the first card (a look then must not give the second card the first one's name / codex review)
  appendFileSync(l.transcript, JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 2, created_at: iso(BASE + 2), tool_calls: [{ name: 'run_command', args: { CommandLine: 'a' } }, { name: 'run_command', args: { CommandLine: 'b' } }] }) + '\n')
  utimesSync(l.transcript, BASE + 2, BASE + 2)
  l.setState({ agent_state: 'tool_use', tool_confirmation_pending: true }, BASE + 2.5)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.lastActivity, new Date((BASE + 2.5) * 1000).toISOString())
  appendFileSync(l.transcript, JSON.stringify({ type: 'GENERIC', step_index: 3, created_at: iso(BASE + 3), content: `Created At: ${iso(BASE + 2)}\nran a` }) + '\n')
  utimesSync(l.transcript, BASE + 3, BASE + 3)
  agyOwnRows('pc-a', l.deps)
  l.setState({ agent_state: 'tool_use', tool_confirmation_pending: true }, BASE + 3.4)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.lastActivity, new Date((BASE + 3.4) * 1000).toISOString(), 'the second card is its own')
  // ⚠️ the second write seen first, then the first write seen late (a slow look), then the second again: one name
  //    throughout (codex review: the late look renamed it and it rang twice)
  const late = { step: 98, index: 0, at: (BASE + 40) * 1000 }
  assert.equal(agyCardAt(PID, A, late, (BASE + 41.3) * 1000, (BASE + 40) * 1000), (BASE + 41.3) * 1000)
  assert.equal(agyCardAt(PID, A, late, (BASE + 41) * 1000, (BASE + 40) * 1000), (BASE + 41.3) * 1000)
  assert.equal(agyCardAt(PID, A, late, (BASE + 41.3) * 1000, (BASE + 40) * 1000), (BASE + 41.3) * 1000)
  // ⚠️ a state written in the same clock tick as the transcript is not tied to its call (cannot be ordered / codex review)
  const tick = { step: 99, index: 0, at: (BASE + 50) * 1000 }
  assert.equal(agyCardAt(PID, A, tick, (BASE + 51) * 1000, (BASE + 51) * 1000), (BASE + 51) * 1000)
  assert.equal(agyCardAt(PID, A, tick, (BASE + 52) * 1000), (BASE + 52) * 1000, 'not named by that write')
  // ★ the next card (another call): its own name
  appendFileSync(l.transcript, JSON.stringify({ type: 'GENERIC', step_index: 4, created_at: iso(BASE + 3), content: 'ran b' }) + '\n' + call(5, BASE + 4))
  utimesSync(l.transcript, BASE + 4, BASE + 4)
  l.setState({ agent_state: 'tool_use', tool_confirmation_pending: true }, BASE + 5.5)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.lastActivity, new Date((BASE + 5.5) * 1000).toISOString())
})

test('★ a long text goes as one paste (only where the relay saw paste on)', async (t) => {
  const l = await lab(t)
  const long = 'x'.repeat(5000)
  const res = await sendToAgy(A, long, l.deps)
  assert.equal(res.ok, true, res.message)
  await settle()
  assert.equal(l.got[0], `\x00\x1b[200~${long} \x1b[201~\r`)
})

test('★ a long text to an agy whose relay never saw paste on is refused', async (t) => {
  const l = await lab(t, { paste: false })
  const res = await sendToAgy(A, 'x'.repeat(5000), l.deps)
  assert.equal(res.reason, 'long-needs-paste')
})

test('★★ stop: one ESC while working; refused when idle, on a card, and right after one was sent', async (t) => {
  const l = await lab(t)
  const id = `agy-${A}`
  let now = 10_000
  const clock = () => now
  assert.equal((await stopAgy(A, l.deps, clock)).reason, 'idle')
  l.setState({ agent_state: 'tool_use', tool_confirmation_pending: true })
  assert.equal((await stopAgy(A, l.deps, clock)).reason, 'waiting')
  l.setState({ agent_state: 'working' })
  stopsAfter(l, 1)
  assert.equal((await stopAgy(A, l.deps, clock)).ok, true)
  assert.equal((await stopAgy(A, l.deps, clock)).reason, 'too-soon')
  now += 2000
  // (working again: a new turn)
  stopsAfter(l, 2)
  assert.equal((await stopAgy(A, l.deps, clock)).ok, true)
  await settle()
  assert.deepEqual(l.got, ['\x1b', '\x1b'])
})

test('target: only the conversation its agy wrote last', async (t) => {
  const l = await lab(t)
  const B = '6c0298e8-77c4-406c-aa97-cbecdfd19c88'
  // the same agy moved on to another conversation (newer file; its own file says so too)
  for (const f of [`session-${B}.json`, `pid-${PID}.json`]) {
    writeFileSync(join(l.deps.dir, f), JSON.stringify({ nyanPid: PID, nyanBusyAt: 0, input: { conversation_id: B, cwd: '/home/user/p', agent_state: 'idle' } }))
    utimesSync(join(l.deps.dir, f), BASE + 10, BASE + 10)
  }
  // (its lock moved with it)
  const moved = { ...l.deps, locksOf: (p: number) => (p === PID ? [B] : []) }
  assert.equal(await findAgyTarget(A, moved), 'not-open')
  const b = await findAgyTarget(B, moved)
  assert.equal(typeof b === 'object' ? b.pid : b, PID)
  // ★ an agy that does not hold the conversation's lock (a second agy; the holder has not written its own file yet)
  assert.equal(await findAgyTarget(B, l.deps), 'shared')
})

test('★★ a question is up (ask_question / docs/AGY.md §11): stop and send are refused, not a byte; the row waits for input', async (t) => {
  const l = await lab(t)
  const iso = (sec: number): string => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  writeFileSync(
    l.transcript,
    [
      { type: 'USER_INPUT', step_index: 0, created_at: iso(BASE - 20), content: '<USER_REQUEST>\nask me\n</USER_REQUEST>' },
      { type: 'PLANNER_RESPONSE', step_index: 1, created_at: iso(BASE - 20), tool_calls: [{ name: 'ask_question', args: { questions: '[]' } }] },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  )
  utimesSync(l.transcript, BASE - 10, BASE - 10)
  // the status line says only `tool_use`, written after the question
  l.setState({ agent_state: 'tool_use' }, BASE)
  // ★ the gap before the status line catches up (the question written, the state still the call before's `tool_use`):
  //   no "needs you" yet, but ESC is already refused (it would skip the question / codex review)
  utimesSync(l.transcript, BASE + 1, BASE + 1)
  assert.equal((await agyRows('pc-a', l.deps))[0]?.status, 'working')
  assert.equal((await stopAgy(A, l.deps)).reason, 'asking')
  // ⚠️ the transcript unreadable at that moment (e.g. out of file descriptors): cannot tell ⇒ no ESC
  chmodSync(l.transcript, 0)
  // (a new time: not the read remembered above)
  utimesSync(l.transcript, BASE + 2, BASE + 2)
  try {
    assert.equal((await stopAgy(A, l.deps)).reason, 'unsure')
  } finally {
    chmodSync(l.transcript, 0o644)
  }
  utimesSync(l.transcript, BASE - 10, BASE - 10)
  const stopped = await stopAgy(A, l.deps)
  assert.equal(stopped.reason, 'asking')
  assert.match(stopped.message ?? '', /question|質問/)
  assert.equal((await sendToAgy(A, 'blue', l.deps)).reason, 'asking')
  const [row] = await agyRows('pc-a', l.deps)
  assert.equal(row?.status, 'waiting')
  assert.equal(row?.waitingFor, 'input needed')
  // ★ the notifier's rows (each agy's own file) and the guard's single read say the same: it rings "needs you"
  const [own] = agyOwnRows('pc-a', l.deps)
  assert.equal(own?.status, 'waiting')
  assert.equal(own?.waitingFor, 'input needed')
  assert.equal(agyOwnRowOf('pc-a', l.deps, A)?.status, 'waiting')
  // ★ the wait is named by the question's transcript write, not the status file's: a subagent's progress rewriting the
  //   status file while the question stays up is the same wait (it does not ring again / codex review)
  const named = own?.lastActivity
  assert.equal(named, new Date((BASE - 10) * 1000).toISOString())
  l.setState({ agent_state: 'tool_use', subagents: [{ name: 'self', status: 'running' }] }, BASE + 0.5)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.lastActivity, named)
  assert.equal(agyOwnRowOf('pc-a', l.deps, A)?.lastActivity, named)
  l.setState({ agent_state: 'tool_use' }, BASE)
  await settle()
  assert.equal(l.got.join(''), '')
  // ★ answered (its result written): working again, and stop goes through
  appendFileSync(l.transcript, JSON.stringify({ type: 'GENERIC', step_index: 2, created_at: iso(BASE - 19), content: `Created At: ${iso(BASE - 19)}\nA1: blue` }) + '\n')
  utimesSync(l.transcript, BASE + 1, BASE + 1)
  l.setState({ agent_state: 'working' }, BASE + 2)
  assert.equal((await agyRows('pc-a', l.deps))[0]?.status, 'working')
  // (not stopped for real: the cooldown is shared with the later tests)
  const tg = await findAgyTarget(A, l.deps)
  assert.ok(typeof tg === 'object')
  assert.equal(readNow(tg)?.asking, false)
})

test('★★ a child agent running (its question may be open on the PC): send and stop refused, not a byte; done ⇒ sends again', async (t) => {
  const l = await lab(t)
  l.setState({ subagents: [{ name: 'self', status: 'running' }] })
  const sent = await sendToAgy(A, '1', l.deps)
  assert.equal(sent.reason, 'subagent')
  assert.match(sent.message ?? '', /subagent|サブエージェント/)
  l.setState({ agent_state: 'working', subagents: [{ name: 'self', status: 'running' }] })
  assert.equal((await stopAgy(A, l.deps)).reason, 'subagent')
  await settle()
  assert.equal(l.got.join(''), '')
  l.setState({ subagents: [{ name: 'self', status: 'completed' }] })
  assert.equal((await sendToAgy(A, 'hello', l.deps)).ok, true)
})

test('★★★ the state changing between the first look and the socket write: not a byte is sent (send and stop)', async (t) => {
  const l = await lab(t)
  // first look: as on disk; every later look: a card is up
  const sequence = (later: Record<string, unknown>): typeof readNow => {
    let n = 0
    return (target) => {
      n += 1
      const now = readNow(target)
      if (!now || n === 1) return now
      return { ...now, state: { ...now.state, ...later } }
    }
  }
  const card = { agentState: 'tool_use', confirmationPending: true }
  const sent = await sendToAgy(A, 'yes please', { ...l.deps, readNow: sequence(card) })
  assert.equal(sent.reason, 'waiting')
  l.setState({ agent_state: 'working' })
  const stopped = await stopAgy(A, { ...l.deps, readNow: sequence(card) })
  assert.equal(stopped.reason, 'waiting')
  // a turn the PC started between the looks
  l.setState({})
  assert.equal((await sendToAgy(A, 'hi', { ...l.deps, readNow: sequence({ agentState: 'working' }) })).reason, 'busy')
  await settle()
  // connected, then closed without a byte
  assert.equal(l.got.join(''), '')
  assert.ok(l.got.length >= 1, 'the socket was reached (the refusal is the second look, not the first)')
})

test('★★ a reused pid: a status file written before this agy\'s relay registered is not this agy\'s (not listed, never typed into)', async (t) => {
  const l = await lab(t, { startedAt: (BASE + 60) * 1000 })
  assert.equal((await sendToAgy(A, 'hi', l.deps)).reason, 'not-open')
  assert.equal((await stopAgy(A, l.deps)).reason, 'not-open')
  assert.deepEqual(await agyRows('pc-a', { ...l.deps }), [])
  await settle()
  assert.deepEqual(l.got, [])
})

test('★★ the agy moved to another conversation after the lookup: refused', async (t) => {
  const l = await lab(t)
  const target = await findAgyTarget(A, l.deps)
  assert.equal(typeof target, 'object')
  if (typeof target !== 'object') return
  assert.ok(readNow(target))
  const B = '6c0298e8-77c4-406c-aa97-cbecdfd19c88'
  writeFileSync(join(l.deps.dir, `session-${B}.json`), JSON.stringify({ nyanPid: PID, nyanBusyAt: 0, input: { conversation_id: B, cwd: '/home/user/p', agent_state: 'idle' } }))
  utimesSync(join(l.deps.dir, `session-${B}.json`), BASE + 10, BASE + 10)
  assert.equal(readNow(target), undefined)
  // another agy's newer file does not matter
  writeFileSync(join(l.deps.dir, `session-${B}.json`), JSON.stringify({ nyanPid: PID + 1, nyanBusyAt: 0, input: { conversation_id: B, cwd: '/home/user/p', agent_state: 'idle' } }))
  utimesSync(join(l.deps.dir, `session-${B}.json`), BASE + 10, BASE + 10)
  assert.ok(readNow(target))
})

test('★★ the last look before writing: a file now naming another pid, or written before the pane, is refused (zero bytes)', async (t) => {
  const l = await lab(t)
  const target = await findAgyTarget(A, l.deps)
  assert.equal(typeof target, 'object')
  if (typeof target !== 'object') return
  assert.ok(readNow(target))
  // the file it reads (this agy's own) now names another process
  assert.equal(target.stateFile, join(l.deps.dir, `pid-${PID}.json`))
  writeFileSync(target.stateFile, JSON.stringify({ nyanPid: PID + 1, nyanBusyAt: 0, input: { conversation_id: A, cwd: '/home/user/p', agent_state: 'idle' } }))
  utimesSync(target.stateFile, BASE, BASE)
  assert.equal(readNow(target), undefined)
  // the pane registered after the file was written
  l.setState({})
  assert.equal(readNow({ ...target, pane: { ...target.pane, startedAt: (BASE + 60) * 1000 } }), undefined)
  assert.ok(readNow(target))
  await settle()
  assert.equal(l.got.join(''), '')
})

test('★★ a card is answered with `1` (allow) or ESC (deny), only while the same card is still up', async (t) => {
  const l = await lab(t)
  const call = { name: 'run_command', args: { CommandLine: 'ls -la' } }
  appendFileSync(l.transcript, JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: new Date((BASE - 60) * 1000).toISOString(), tool_calls: [call, { ...call }] }) + '\n')
  utimesSync(l.transcript, BASE - 50, BASE - 50)
  const up = { agent_state: 'tool_use', tool_confirmation_pending: true }
  l.setState(up)
  l.deps.answerSettleMs = 0
  const mark = { pid: PID, stateMtimeMs: BASE * 1000, step: 1, index: 0, callAt: (BASE - 60) * 1000 }
  // ★ a child agent running (its question may be open on the PC and would take the key): nothing typed
  l.setState({ ...up, subagents: [{ name: 'self', status: 'running' }] })
  assert.deepEqual(await answerAgyCard(A, mark, 'allow', l.deps), { ok: false, reason: 'changed' })
  l.setState(up)
  assert.deepEqual(await answerAgyCard(A, mark, 'allow', l.deps), { ok: true })
  assert.deepEqual(await answerAgyCard(A, mark, 'deny', l.deps), { ok: true })
  // ★ no longer wanted right before the byte (auto-approve turned off during the wait) ⇒ nothing typed
  let asked = 0
  assert.deepEqual(await answerAgyCard(A, mark, 'allow', l.deps, undefined, () => (asked++, false)), { ok: false, reason: 'changed' })
  assert.ok(asked > 0)
  // ★ the PC answers the card while that last check runs (a team's guard probes processes): nothing typed — the card is
  //   looked at after it (codex review 2026-11-22)
  assert.deepEqual(await answerAgyCard(A, mark, 'deny', l.deps, undefined, () => (l.setState(up, BASE + 2), true)), { ok: false, reason: 'changed' })
  l.setState(up)
  // ★ asked again after the card check too: a grant that ends during it types nothing (codex review round 17)
  let asks = 0
  assert.deepEqual(await answerAgyCard(A, mark, 'allow', l.deps, undefined, () => ++asks <= 1), { ok: false, reason: 'changed' })
  assert.equal(asks, 2)
  await settle()
  // (the refused ones connected and wrote nothing)
  assert.equal(l.got.join(''), '1\x1b')
  assert.deepEqual(AGY_CARD_KEYS, { allow: '1', deny: '\x1b' })
  // ⚠️ the status file was written again (answered on the PC, a new card): nothing is typed
  l.setState(up, BASE + 1)
  assert.deepEqual(await answerAgyCard(A, mark, 'allow', l.deps), { ok: false, reason: 'changed' })
  // the same file time, but the transcript moved on to the next call
  const later = { ...mark, stateMtimeMs: (BASE + 1) * 1000 }
  appendFileSync(l.transcript, JSON.stringify({ step_index: 2, type: 'GENERIC', content: `Created At: ${new Date((BASE - 60) * 1000).toISOString()}\ndone` }) + '\n')
  assert.deepEqual(await answerAgyCard(A, later, 'allow', l.deps), { ok: false, reason: 'changed' })
  assert.deepEqual(await answerAgyCard(A, { ...later, index: 1 }, 'allow', l.deps), { ok: true })
  // no card up any more / another agy / a pid that is not the card's
  l.setState({ agent_state: 'working' }, BASE + 2)
  assert.deepEqual(await answerAgyCard(A, { ...later, stateMtimeMs: (BASE + 2) * 1000, index: 1 }, 'allow', l.deps), { ok: false, reason: 'changed' })
  l.setState(up, BASE + 3)
  assert.deepEqual(await answerAgyCard(A, { ...later, stateMtimeMs: (BASE + 3) * 1000, index: 1, pid: PID + 1 }, 'allow', l.deps), { ok: false, reason: 'not-open' })
  // this agy's own file names another conversation
  assert.deepEqual(await answerAgyCard('6c0298e8-77c4-406c-aa97-cbecdfd19c88', { ...later, stateMtimeMs: (BASE + 3) * 1000, index: 1 }, 'allow', l.deps), { ok: false, reason: 'changed' })
  // ⚠️ the agy moved to another conversation between the check and the write (`/resume` on the PC; its lock moved):
  //    the byte never goes out
  let looks = 0
  const moves = { ...l.deps, locksOf: () => (++looks < 2 ? [A] : ['ffffffff-ffff-4fff-8fff-ffffffffffff']) }
  assert.deepEqual(await answerAgyCard(A, { ...later, stateMtimeMs: (BASE + 3) * 1000, index: 1 }, 'allow', moves), { ok: false, reason: 'changed' })
  assert.equal(looks, 2)
  // ⚠️ agy does not hold this conversation's lock at all (a status line that stopped, then a `/resume` elsewhere)
  assert.deepEqual(await answerAgyCard(A, { ...later, stateMtimeMs: (BASE + 3) * 1000, index: 1 }, 'allow', { ...l.deps, locksOf: () => undefined }), { ok: false, reason: 'changed' })
  await settle()
  // (the refused one connected and wrote nothing)
  assert.equal(l.got.join(''), '1\x1b1')
})

test('★★ a card answer waits before its last check: a PC answer just before it wins (nothing typed)', async (t) => {
  const l = await lab(t)
  appendFileSync(l.transcript, JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: new Date((BASE - 60) * 1000).toISOString(), tool_calls: [{ name: 'run_command', args: { CommandLine: 'make' } }] }) + '\n')
  utimesSync(l.transcript, BASE - 50, BASE - 50)
  l.setState({ agent_state: 'tool_use', tool_confirmation_pending: true })
  const mark = { pid: PID, stateMtimeMs: BASE * 1000, step: 1, index: 0, callAt: (BASE - 60) * 1000 }
  // the PC allowed it a moment ago; agy's status line writes "working" during the wait
  setTimeout(() => l.setState({ agent_state: 'working' }, BASE + 1), 30)
  const t0 = Date.now()
  assert.deepEqual(await answerAgyCard(A, mark, 'deny', { ...l.deps, answerSettleMs: 200 }), { ok: false, reason: 'changed' })
  assert.ok(Date.now() - t0 >= 190)
  await settle()
  assert.equal(l.got.join(''), '')
})

test('★ an answer is refused while another running agy shows the same conversation', async (t) => {
  const l = await lab(t)
  appendFileSync(l.transcript, JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: new Date((BASE - 60) * 1000).toISOString(), tool_calls: [{ name: 'run_command', args: { CommandLine: 'ls' } }] }) + '\n')
  utimesSync(l.transcript, BASE - 50, BASE - 50)
  l.setState({ agent_state: 'tool_use', tool_confirmation_pending: true })
  writeFileSync(join(l.deps.dir, 'pid-777.json'), JSON.stringify({ nyanPid: 777, nyanBusyAt: 0, input: { conversation_id: A, cwd: '/home/user/q', agent_state: 'idle' } }))
  const mark = { pid: PID, stateMtimeMs: BASE * 1000, step: 1, index: 0, callAt: (BASE - 60) * 1000 }
  const res = await answerAgyCard(A, mark, 'allow', { ...l.deps, answerSettleMs: 0, isAgy: (p) => p === PID || p === 777, locksOf: (p) => (p === PID ? [A] : []) })
  assert.deepEqual(res, { ok: false, reason: 'changed' })
  await settle()
  assert.equal(l.got.join(''), '')
})

test('★★ an answer is refused when the last call is newer than this agy’s card state (another agy’s call)', async (t) => {
  const l = await lab(t)
  appendFileSync(l.transcript, JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: new Date((BASE + 30) * 1000).toISOString(), tool_calls: [{ name: 'run_command', args: { CommandLine: 'ls' } }] }) + '\n')
  l.setState({ agent_state: 'tool_use', tool_confirmation_pending: true })
  const res = await answerAgyCard(A, { pid: PID, stateMtimeMs: BASE * 1000, step: 1, index: 0, callAt: (BASE - 60) * 1000 }, 'allow', { ...l.deps, answerSettleMs: 0 })
  assert.deepEqual(res, { ok: false, reason: 'changed' })
})

test('★ send and stop are refused while two running agys show the conversation (which one would get the key is unknown)', async (t) => {
  const l = await lab(t)
  writeFileSync(join(l.deps.dir, 'pid-777.json'), JSON.stringify({ nyanPid: 777, nyanBusyAt: 0, input: { conversation_id: A, cwd: '/home/user/q', agent_state: 'idle' } }))
  const two = { ...l.deps, isAgy: (p: number) => p === PID || p === 777, locksOf: (p: number) => (p === PID ? [A] : []) }
  assert.equal(await findAgyTarget(A, two), 'shared')
  assert.equal((await sendToAgy(A, 'hi', two)).reason, 'shared')
  assert.equal((await stopAgy(A, two)).reason, 'shared')
  await settle()
  assert.deepEqual(l.got, [])
  // the other agy moved to another conversation: back to normal
  const moved = { ...two, locksOf: (p: number) => (p === PID ? [A] : ['ffffffff-ffff-4fff-8fff-ffffffffffff']) }
  assert.notEqual(typeof (await findAgyTarget(A, moved)), 'string')
})

test('★ an agy that moved while its send was being looked up: the re-read of its own file refuses (no fallback)', async (t) => {
  const l = await lab(t)
  const target = await findAgyTarget(A, l.deps)
  assert.equal(typeof target, 'object')
  if (typeof target !== 'object') return
  assert.equal(target.stateFile, join(l.deps.dir, `pid-${PID}.json`))
  // it resumed another conversation: its own file names that one now; A's conversation file is still the old one
  writeFileSync(target.stateFile, JSON.stringify({ nyanPid: PID, nyanBusyAt: 0, input: { conversation_id: '6c0298e8-77c4-406c-aa97-cbecdfd19c88', cwd: '/home/user/p', agent_state: 'idle' } }))
  assert.equal(readNow(target), undefined)
  assert.equal(await findAgyTarget(A, l.deps), 'not-open')
})

test('★★ a `/resume` picked on the PC after the lookup (the lock moved, the files not yet): not a byte is sent', async (t) => {
  const l = await lab(t)
  let looks = 0
  // the lookup sees the lock on A; from the gate on, it is on another conversation
  const moving = { ...l.deps, locksOf: (p: number) => (p === PID && ++looks <= 1 ? [A] : ['6c0298e8-77c4-406c-aa97-cbecdfd19c88']) }
  const sent = await sendToAgy(A, 'hello', moving)
  assert.equal(sent.ok, false)
  looks = 0
  const stopped = await stopAgy(A, { ...moving, readNow: (tg: Parameters<typeof readNow>[0]) => {
    const r = readNow(tg)
    return r && { ...r, state: { ...r.state, agentState: 'working' } }
  } })
  assert.equal(stopped.ok, false)
  await settle()
  assert.equal(l.got.join(''), '')
})

test('★★ a question answer: the built steps typed in order, only while the same question is up; changed midway ⇒ partial', async (t) => {
  const l = await lab(t)
  const iso = (sec: number): string => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  writeFileSync(
    l.transcript,
    [
      { type: 'USER_INPUT', step_index: 0, created_at: iso(BASE - 20), content: '<USER_REQUEST>\nask\n</USER_REQUEST>' },
      { type: 'PLANNER_RESPONSE', step_index: 1, created_at: iso(BASE - 20), tool_calls: [{ name: 'ask_question', args: { questions: [] } }] },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  )
  utimesSync(l.transcript, BASE - 10, BASE - 10)
  l.setState({ agent_state: 'tool_use' }, BASE)
  l.deps.answerSettleMs = 0
  l.deps.questionStepMs = 5
  const mark = { pid: PID, askedAt: (BASE - 10) * 1000, step: 1, index: 0, callAt: (BASE - 20) * 1000 }
  const steps = [{ key: '2' }, { key: '3' }, { text: 'pink' }, { key: '\r' }]
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'steps', steps: steps }, l.deps), { ok: true })
  await settle()
  assert.equal(l.got.join(''), '23pink\r')
  // ⚠️ another question now (the transcript was written since): nothing typed
  l.got.length = 0
  assert.deepEqual(await answerAgyQuestion(A, { ...mark, askedAt: mark.askedAt - 1000 }, { kind: 'steps', steps: steps }, l.deps), { ok: false, reason: 'changed' })
  // ⚠️ a child agent running (its question may be the one open on the PC): nothing typed
  l.setState({ agent_state: 'tool_use', subagents: [{ name: 'self', status: 'running' }] }, BASE)
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'steps', steps: steps }, l.deps), { ok: false, reason: 'changed' })
  l.setState({ agent_state: 'tool_use' }, BASE)
  // ★ no longer wanted after the settle wait (a team disbanded meanwhile / codex review): nothing typed
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'steps', steps: steps }, l.deps, undefined, () => false), { ok: false, reason: 'changed' })
  // … and between its keys: the rest is not typed
  // (asked after the wait, then before and after each key's own check: the first key passes, the second does not)
  let wanted = 0
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'steps', steps: steps }, l.deps, undefined, () => ++wanted <= 3), { ok: false, reason: 'partial' })
  await settle()
  assert.equal(l.got.join(''), '2')
  l.got.length = 0
  // ⚠️ answered on the PC after the first key (the transcript written): the rest is not typed ⇒ partial
  let n = 0
  const tail = (p: string): Record<string, unknown>[] => {
    n += 1
    // (the first check and the one right before the first key pass; the PC answers during that last one)
    if (n === 2) utimesSync(l.transcript, BASE + 1, BASE + 1)
    return readTailRecords(p)
  }
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'steps', steps: steps }, l.deps, tail), { ok: false, reason: 'partial' })
  await settle()
  assert.equal(l.got.join(''), '2')
})

/** ★ A parent that started children (docs/AGY.md §13): its transcript names them, each child's transcript ends on a question */
function withChildren(l: Lab, kids: { id: string; prompt: string; asking: boolean; command?: boolean; running?: boolean; finished?: boolean; failed?: boolean; thinking?: boolean }[]): { askedAt: Map<string, number> } {
  const iso = (sec: number): string => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  writeFileSync(
    l.transcript,
    [
      { type: 'USER_INPUT', step_index: 0, created_at: iso(BASE - 40), content: '<USER_REQUEST>\nstart them\n</USER_REQUEST>' },
      { type: 'PLANNER_RESPONSE', step_index: 1, created_at: iso(BASE - 40), tool_calls: kids.map((k) => ({ name: 'invoke_subagent', args: { Prompt: k.prompt, Role: 'x' } })) },
      ...kids.map((k, i) => ({ type: 'GENERIC', step_index: 2 + i, created_at: iso(BASE - 39), content: `Created At: ${iso(BASE - 39)}\nCreated the following subagent:\n{\n  "conversationId":  "${k.id}"\n}` })),
      { type: 'PLANNER_RESPONSE', step_index: 9, created_at: iso(BASE - 38), content: 'Waiting.' },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  )
  utimesSync(l.transcript, BASE - 30, BASE - 30)
  const askedAt = new Map<string, number>()
  kids.forEach((k, i) => {
    const p = transcriptPathOf(k.id, l.deps.home)
    mkdirSync(join(p, '..'), { recursive: true })
    const recs: Record<string, unknown>[] = [
      // ★ a child's first record names its parent and its prompt (measured)
      { type: 'SYSTEM_MESSAGE', step_index: 0, created_at: iso(BASE - 35), content: `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=${iso(BASE - 35 + i)} sender=${A} priority=MESSAGE_PRIORITY_HIGH content=${k.prompt}\n</SYSTEM_MESSAGE>` },
      k.command
        ? { type: 'PLANNER_RESPONSE', step_index: 1, created_at: iso(BASE - 35), tool_calls: [{ name: 'run_command', args: { CommandLine: 'ls' } }] }
        : { type: 'PLANNER_RESPONSE', step_index: 1, created_at: iso(BASE - 35), tool_calls: [{ name: 'ask_question', args: { questions: [{ question: `Q${i}?`, options: ['a', 'b'] }] } }] },
    ]
    // (a child still thinking: its first record only)
    if (k.thinking) recs.splice(1)
    if (!k.asking && !k.command && !k.thinking) recs.push({ type: 'GENERIC', step_index: 2, created_at: iso(BASE - 34), content: `Created At: ${iso(BASE - 34)}\nA1: a` })
    if (k.finished) recs.push({ type: 'PLANNER_RESPONSE', step_index: 3, created_at: iso(BASE - 33), content: 'Reported back.' })
    if (k.failed) recs.push({ type: 'ERROR_MESSAGE', step_index: 3, created_at: iso(BASE - 33), error: 'quota' })
    writeFileSync(p, recs.map((r) => JSON.stringify(r)).join('\n') + '\n')
    utimesSync(p, BASE - 20 + i, BASE - 20 + i)
    askedAt.set(k.id, (BASE - 20 + i) * 1000)
  })
  l.setState({ agent_state: 'idle', subagents: kids.filter((k) => k.running !== false).map((k) => ({ name: 'self', role: k.prompt, status: 'running' })) }, BASE)
  return { askedAt }
}

const K1 = '15bc1e2a-6a62-4f86-9bf9-dd03e99f6627'
const K2 = '70039de1-d758-4556-afa8-5d36b9625540'
const K3 = '2a378a7f-0000-4000-8000-000000000003'

test('★★ a child agent’s question: the parent row waits for input; the notifier names it by the child’s question', async (t) => {
  const l = await lab(t)
  const { askedAt } = withChildren(l, [{ id: K1, prompt: 'ask about planets', asking: true }, { id: K2, prompt: 'ask about moons', asking: false }])
  const [row] = await agyRows('pc-a', l.deps)
  assert.equal(row?.status, 'waiting')
  assert.equal(row?.waitingFor, 'input needed')
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.lastActivity, new Date(askedAt.get(K1)!).toISOString())
  // ★ found from the child's own first record: the parent's transcript no longer naming it (a long turn pushed its
  //   launch out of the tail) changes nothing (codex review)
  writeFileSync(l.transcript, JSON.stringify({ type: 'USER_INPUT', step_index: 0, content: '<USER_REQUEST>\nx\n</USER_REQUEST>' }) + '\n')
  utimesSync(l.transcript, BASE - 30, BASE - 30)
  assert.equal((await agyRows('pc-a', l.deps))[0]?.status, 'waiting')
  // ⚠️ a child not running any more (its entry completed) does not count, even with a question left in its transcript
  l.setState({ agent_state: 'idle', subagents: [{ name: 'self', role: 'ask about planets', status: 'completed' }, { name: 'self', role: 'ask about moons', status: 'running' }] }, BASE)
  assert.notEqual((await agyRows('pc-a', l.deps))[0]?.status, 'waiting')
})

test('★★ a child’s answer: ctrl+k, the steps, ESC back — only while that child is the one asking and the parent is idle', async (t) => {
  const l = await lab(t)
  const { askedAt } = withChildren(l, [{ id: K1, prompt: 'ask about planets', asking: true }])
  l.deps.answerSettleMs = 0
  l.deps.questionStepMs = 5
  l.deps.childOpenMs = 5
  l.deps.childBackWaitMs = 400
  const mark = { pid: PID, askedAt: askedAt.get(K1)!, step: 1, index: 0, callAt: (BASE - 35) * 1000, child: K1 }
  const kid = transcriptPathOf(K1, l.deps.home)
  const asked = readFileSync(kid, 'utf8')
  // (agy records the answer after the digit: ESC back only once the question is gone)
  l.deps.childOpenMs = 150
  // (recorded a while after the answer: the ESC waits for it, asked every 100 ms)
  l.deps.childBackWaitMs = 800
  const recorded = setTimeout(() => appendFileSync(kid, JSON.stringify({ type: 'GENERIC', step_index: 2, content: 'A1: b' }) + '\n'), 500)
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'steps', steps: [{ key: '2' }] }, l.deps), { ok: true })
  clearTimeout(recorded)
  await settle()
  assert.equal(l.got.join(''), '\x0b2\x1b')
  // ★ one connection for the whole answer (the relay takes or loses it whole: a lost ctrl+k cannot let the rest land in
  //   the parent's prompt / codex review)
  assert.equal(l.got.length, 1)
  l.got.length = 0
  // ⚠️ the child asks for its next command's approval before the ESC: not sent (it would decline it / codex review)
  writeFileSync(kid, asked)
  utimesSync(kid, askedAt.get(K1)! / 1000, askedAt.get(K1)! / 1000)
  l.deps.childOpenMs = 150
  const approval = setTimeout(
    () =>
      appendFileSync(
        kid,
        JSON.stringify({ type: 'GENERIC', step_index: 2, content: 'A1: b' }) +
          '\n' +
          JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 3, created_at: new Date().toISOString(), tool_calls: [{ name: 'run_command', args: { CommandLine: 'rm x' } }] }) +
          '\n',
      ),
    225,
  )
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'steps', steps: [{ key: '2' }] }, l.deps), { ok: true })
  clearTimeout(approval)
  await settle()
  assert.equal(l.got.join(''), '\x0b2')
  l.got.length = 0
  // ⚠️ the child asks its next question before the ESC: not sent (it would skip that one / codex review)
  writeFileSync(kid, asked)
  utimesSync(kid, askedAt.get(K1)! / 1000, askedAt.get(K1)! / 1000)
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'steps', steps: [{ key: '2' }] }, l.deps), { ok: true })
  await settle()
  assert.equal(l.got.join(''), '\x0b2')
  l.got.length = 0
  l.deps.childOpenMs = 5
  // ⚠️ the question changed after ctrl+k opened it (answered on the PC): no answer key and ⚠️ no ESC (on an open
  //    question ESC skips it / codex review)
  l.deps.childOpenMs = 150
  setTimeout(() => utimesSync(transcriptPathOf(K1, l.deps.home), BASE - 5, BASE - 5), 60)
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'steps', steps: [{ key: '2' }] }, l.deps), { ok: false, reason: 'changed' })
  await settle()
  assert.equal(l.got.join(''), '\x0b')
  l.got.length = 0
  utimesSync(transcriptPathOf(K1, l.deps.home), askedAt.get(K1)! / 1000, askedAt.get(K1)! / 1000)
  l.deps.childOpenMs = 5
  // ⚠️ the parent working (ESC on its view would stop it): nothing typed
  l.setState({ agent_state: 'working', subagents: [{ name: 'self', role: 'ask about planets', status: 'running' }] }, BASE)
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'steps', steps: [{ key: '2' }] }, l.deps), { ok: false, reason: 'changed' })
  // ⚠️ two children asking (which one ctrl+k opens is not known for sure): nothing typed
  withChildren(l, [{ id: K1, prompt: 'ask about planets', asking: true }, { id: K2, prompt: 'ask about moons', asking: true }])
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'steps', steps: [{ key: '2' }] }, l.deps), { ok: false, reason: 'changed' })
  // ⚠️ a running child the parent's transcript does not name (pushed out of its tail): it may be asking too ⇒ nothing typed
  withChildren(l, [{ id: K1, prompt: 'ask about planets', asking: true }])
  l.setState({ agent_state: 'idle', subagents: [{ name: 'self', role: 'ask about planets', status: 'running' }, { name: 'self', role: 'an older child', status: 'running' }] }, BASE)
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'steps', steps: [{ key: '2' }] }, l.deps), { ok: false, reason: 'changed' })
  // ⚠️ another running child with a call of its own pending (its approval may be the one ctrl+k opens: the digit would
  //    approve its command / codex review): nothing typed
  withChildren(l, [{ id: K1, prompt: 'ask about planets', asking: true }, { id: K3, prompt: 'run ls', asking: false, command: true }])
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'steps', steps: [{ key: '2' }] }, l.deps), { ok: false, reason: 'changed' })
  // ⚠️ two children given the same prompt (which is which cannot be told): nothing typed
  withChildren(l, [{ id: K1, prompt: 'same', asking: true }, { id: K2, prompt: 'same', asking: false }])
  assert.deepEqual(await answerAgyQuestion(A, { ...mark }, { kind: 'steps', steps: [{ key: '2' }] }, l.deps), { ok: false, reason: 'changed' })
  await settle()
  assert.equal(l.got.join(''), '')
})

test('★ a child is found by its first record even with a prompt over 64 KiB', async (t) => {
  const l = await lab(t)
  const long = 'x'.repeat(70 * 1024)
  withChildren(l, [{ id: K1, prompt: long, asking: true }])
  assert.equal((await agyRows('pc-a', l.deps))[0]?.status, 'waiting')
})

test('★ children with the same prompt: a question of any of them rings (which one still runs cannot be told; never silence)', async (t) => {
  const l = await lab(t)
  // K1 (older, asking) and K2 (newer, finished first) share the prompt; one entry still runs (codex review: the newest
  // guess left K1's live question silent). Accepted the other way: a killed child's leftover question rings too.
  withChildren(l, [{ id: K1, prompt: 'same', asking: false, running: false }, { id: K2, prompt: 'same', asking: true }])
  // (and the other way round: whichever is listed first)
  assert.equal((await agyRows('pc-a', l.deps))[0]?.status, 'waiting')
  withChildren(l, [{ id: K1, prompt: 'same', asking: true }, { id: K2, prompt: 'same', asking: false, running: false }])
  assert.equal((await agyRows('pc-a', l.deps))[0]?.status, 'waiting')
})

test('★ a child asking behind the parent’s open question names a new wait (it rings too)', async (t) => {
  const l = await lab(t)
  const { askedAt } = withChildren(l, [{ id: K1, prompt: 'ask about planets', asking: true }])
  const iso = (sec: number): string => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  // the parent asks its own question (written before the child's)
  appendFileSync(l.transcript, JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 10, created_at: iso(BASE - 40), tool_calls: [{ name: 'ask_question', args: { questions: [{ question: 'P?', options: ['a'] }] } }] }) + '\n')
  utimesSync(l.transcript, BASE - 25, BASE - 25)
  l.setState({ agent_state: 'tool_use', subagents: [{ name: 'self', role: 'ask about planets', status: 'running' }] }, BASE)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.lastActivity, new Date(askedAt.get(K1)!).toISOString())
})

test('★ a child asking behind the parent’s open approval names a new wait (it rings); the approval keeps its own name before that', async (t) => {
  const l = await lab(t)
  const { askedAt } = withChildren(l, [{ id: K1, prompt: 'ask about planets', asking: true }])
  // the parent's card came up before the child asked: the child's question names the wait
  l.setState({ agent_state: 'tool_use', tool_confirmation_pending: true, subagents: [{ name: 'self', role: 'ask about planets', status: 'running' }] }, askedAt.get(K1)! / 1000 - 2)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.lastActivity, new Date(askedAt.get(K1)!).toISOString())
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.waitingFor, 'permission prompt')
  // the card came up after: its own state write names it (a new card rings)
  l.setState({ agent_state: 'tool_use', tool_confirmation_pending: true, subagents: [{ name: 'self', role: 'ask about planets', status: 'running' }] }, BASE + 5)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.lastActivity, new Date((BASE + 5) * 1000).toISOString())
})

test('★ an unrelated transcript cut in its first record (agy killed while writing it) does not keep child questions off the phone', async (t) => {
  const l = await lab(t)
  const { askedAt } = withChildren(l, [{ id: K1, prompt: 'ask about planets', asking: true }])
  const cut = transcriptPathOf('9b2f1c3e-0000-4000-8000-00000000000c', l.deps.home)
  mkdirSync(join(cut, '..'), { recursive: true })
  writeFileSync(cut, '{"type":"SYSTEM_MESSAGE","content":"half')
  // being written right now: cannot tell yet (no child answered from the phone)
  l.deps.answerSettleMs = 0
  l.deps.childOpenMs = 5
  l.deps.childBackWaitMs = 0
  const mark = { pid: PID, askedAt: askedAt.get(K1)!, step: 1, index: 0, callAt: (BASE - 35) * 1000, child: K1 }
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'steps', steps: [{ key: '2' }] }, l.deps), { ok: false, reason: 'changed' })
  // not written for over a minute: a cut file, not a child
  utimesSync(cut, BASE - 120, BASE - 120)
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'steps', steps: [{ key: '2' }] }, l.deps), { ok: true })
})

test('★ an earlier finished run of the same prompt does not keep the running one’s question off the phone', async (t) => {
  const l = await lab(t)
  const { askedAt } = withChildren(l, [{ id: K2, prompt: 'checklist', asking: false, finished: true, running: false }, { id: K1, prompt: 'checklist', asking: true }])
  l.deps.answerSettleMs = 0
  l.deps.childOpenMs = 5
  l.deps.childBackWaitMs = 0
  const mark = { pid: PID, askedAt: askedAt.get(K1)!, step: 1, index: 0, callAt: (BASE - 35) * 1000, child: K1 }
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'steps', steps: [{ key: '2' }] }, l.deps), { ok: true })
})

test('★ the slow probes (lock, another agy) run before the first and the last key of an answer only', async (t) => {
  const l = await lab(t)
  const iso = (sec: number): string => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  writeFileSync(
    l.transcript,
    [
      { type: 'USER_INPUT', step_index: 0, created_at: iso(BASE - 20), content: '<USER_REQUEST>\nask\n</USER_REQUEST>' },
      { type: 'PLANNER_RESPONSE', step_index: 1, created_at: iso(BASE - 20), tool_calls: [{ name: 'ask_question', args: { questions: [] } }] },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  )
  utimesSync(l.transcript, BASE - 10, BASE - 10)
  l.setState({ agent_state: 'tool_use' }, BASE)
  let probes = 0
  const deps = { ...l.deps, answerSettleMs: 0, questionStepMs: 1, locksOf: (p: number) => (probes++, p === PID ? [A] : []) }
  const mark = { pid: PID, askedAt: (BASE - 10) * 1000, step: 1, index: 0, callAt: (BASE - 20) * 1000 }
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'steps', steps: [{ key: '1' }, { key: '2' }, { key: '3' }, { key: '4' }, { key: '\r' }] }, deps), { ok: true })
  const per = probes
  probes = 0
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'steps', steps: [{ key: '1' }, { key: '\r' }] }, deps), { ok: true })
  // the same number of probes for five keys as for two
  assert.equal(per, probes)
  // ⚠️ the lock moved (a `/resume` on the PC) before the last key: the probe there catches it ⇒ partial, no Enter
  let moved = false
  const late = { ...deps, questionStepMs: 60, locksOf: (p: number) => (p === PID && !moved ? [A] : []) }
  await settle()
  l.got.length = 0
  setTimeout(() => (moved = true), 200)
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'steps', steps: [{ key: '1' }, { key: '2' }, { key: '3' }, { key: '4' }, { key: '\r' }] }, late), { ok: false, reason: 'partial' })
  await settle()
  assert.doesNotMatch(l.got.join(''), /\r/)
})

test('★ an earlier failed run of the same prompt does not keep the rerun’s question off the phone', async (t) => {
  const l = await lab(t)
  const { askedAt } = withChildren(l, [{ id: K2, prompt: 'checklist', asking: false, failed: true, running: false }, { id: K1, prompt: 'checklist', asking: true }])
  l.deps.answerSettleMs = 0
  l.deps.childOpenMs = 5
  l.deps.childBackWaitMs = 0
  const mark = { pid: PID, askedAt: askedAt.get(K1)!, step: 1, index: 0, callAt: (BASE - 35) * 1000, child: K1 }
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'steps', steps: [{ key: '2' }] }, l.deps), { ok: true })
})

test('★ children that wrote after the parent’s last answer: the parent is idle, not "done" (no false "done" when one failed)', async (t) => {
  const l = await lab(t)
  withChildren(l, [{ id: K1, prompt: 'check', asking: false, failed: true }])
  // the parent's answer ("Waiting.") at BASE - 38; the child wrote after it; every child is over now
  l.setState({ agent_state: 'idle', subagents: [{ name: 'self', role: 'check', status: 'failed' }] }, BASE)
  const raw = JSON.parse(readFileSync(join(l.deps.dir, `pid-${PID}.json`), 'utf8')) as { nyanBusyAt: number }
  raw.nyanBusyAt = BASE
  writeFileSync(join(l.deps.dir, `pid-${PID}.json`), JSON.stringify(raw))
  writeFileSync(join(l.deps.dir, `session-${A}.json`), JSON.stringify(raw))
  utimesSync(join(l.deps.dir, `pid-${PID}.json`), BASE, BASE)
  utimesSync(join(l.deps.dir, `session-${A}.json`), BASE, BASE)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'idle')
  // the parent answers after the child: "done"
  const iso = new Date((BASE - 5) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  appendFileSync(l.transcript, JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 20, created_at: iso, content: 'The check failed.' }) + '\n')
  utimesSync(l.transcript, BASE - 5, BASE - 5)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'done')
})

test('★ a sibling still thinking (no call yet) does not keep the asking child’s question off the phone', async (t) => {
  const l = await lab(t)
  const { askedAt } = withChildren(l, [{ id: K1, prompt: 'ask', asking: true }, { id: K3, prompt: 'think', asking: false, thinking: true }])
  l.deps.answerSettleMs = 0
  l.deps.childOpenMs = 5
  l.deps.childBackWaitMs = 0
  const mark = { pid: PID, askedAt: askedAt.get(K1)!, step: 1, index: 0, callAt: (BASE - 35) * 1000, child: K1 }
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'steps', steps: [{ key: '2' }] }, l.deps), { ok: true })
})

test('★ a child that failed later in the same second as the parent’s answer still keeps the parent from "done"', async (t) => {
  const l = await lab(t)
  withChildren(l, [{ id: K1, prompt: 'check', asking: false, failed: true }])
  const iso = new Date(BASE * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  appendFileSync(l.transcript, JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 20, created_at: iso, content: 'Started the check.' }) + '\n')
  // the answer written at .140, the child's failure at .920 of the same second
  utimesSync(l.transcript, BASE + 0.14, BASE + 0.14)
  utimesSync(transcriptPathOf(K1, l.deps.home), BASE + 0.92, BASE + 0.92)
  const raw = { nyanPid: PID, nyanBusyAt: BASE, input: { conversation_id: A, cwd: '/home/user/p', agent_state: 'idle', subagents: [{ name: 'self', role: 'check', status: 'failed' }] } }
  for (const f of [`pid-${PID}.json`, `session-${A}.json`]) {
    writeFileSync(join(l.deps.dir, f), JSON.stringify(raw))
    utimesSync(join(l.deps.dir, f), BASE + 2, BASE + 2)
  }
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'idle')
  // the child wrote before the answer (same second): done
  utimesSync(transcriptPathOf(K1, l.deps.home), BASE + 0.05, BASE + 0.05)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'done')
  // a child's message recorded after the answer (the parent has not answered it yet): not done
  appendFileSync(l.transcript, JSON.stringify({ type: 'SYSTEM_MESSAGE', step_index: 21, content: `x\n<SYSTEM_MESSAGE>\n[Message] timestamp=${new Date(BASE * 1000).toISOString()} sender=${K1} priority=MESSAGE_PRIORITY_HIGH content=failed\n</SYSTEM_MESSAGE>` }) + '\n')
  utimesSync(l.transcript, BASE + 1, BASE + 1)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'idle')
})

test('★★ a child that reported to the parent, then wrote its closing record after the parent’s answer: "done" (measured 2026-11-23)', async (t) => {
  const l = await lab(t)
  withChildren(l, [{ id: K1, prompt: 'ask', asking: false, finished: true }])
  const iso = new Date(BASE * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const message = (sender: string, step: number): string =>
    JSON.stringify({ type: 'SYSTEM_MESSAGE', step_index: step, content: `x\n<SYSTEM_MESSAGE>\n[Message] timestamp=${iso} sender=${sender} priority=MESSAGE_PRIORITY_HIGH content=The user chose: Blue\n</SYSTEM_MESSAGE>` }) + '\n'
  const answer = JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 21, created_at: iso, content: 'You chose Blue.' }) + '\n'
  // another launch in this turn (a sibling the parent started) and its result naming the child
  const launch = (prompt: string, id: string): string =>
    JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 18, created_at: iso, tool_calls: [{ name: 'invoke_subagent', args: { Prompt: prompt } }] }) +
    '\n' +
    JSON.stringify({ type: 'GENERIC', step_index: 19, created_at: iso, content: `Created At: ${iso}\nCreated the following subagent:\n{\n  "conversationId": "${id}"\n}` }) +
    '\n'
  // a child of this conversation that ran to its own answer
  const finishedChild = (id: string, prompt: string): string => {
    const path = transcriptPathOf(id, l.deps.home)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({ type: 'SYSTEM_MESSAGE', step_index: 0, created_at: iso, content: `x\n<SYSTEM_MESSAGE>\n[Message] timestamp=${iso} sender=${A} priority=MESSAGE_PRIORITY_HIGH content=${prompt}\n</SYSTEM_MESSAGE>` }) +
        '\n' +
        JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 1, created_at: iso, content: 'Done.' }) +
        '\n',
    )
    utimesSync(path, BASE - 1, BASE - 1)
    return path
  }
  const NOFILE = '5d2e3f40-0000-4000-8000-00000000000b'
  const raw = { nyanPid: PID, nyanBusyAt: BASE, input: { conversation_id: A, cwd: '/home/user/p', agent_state: 'idle', subagents: [{ name: 'self', role: 'ask', status: 'completed' }] } }
  for (const f of [`pid-${PID}.json`, `session-${A}.json`]) {
    writeFileSync(join(l.deps.dir, f), JSON.stringify(raw))
    utimesSync(join(l.deps.dir, f), BASE + 2, BASE + 2)
  }
  // (distinct times per case: the transcript cache keys on size and time)
  const parentAt = (sec: number): void => utimesSync(l.transcript, sec, sec)
  const childAt = (sec: number): void => utimesSync(transcriptPathOf(K1, l.deps.home), sec, sec)
  const base = readFileSync(l.transcript, 'utf8')
  // ⚠️ another agent's message (not this child's): the child's later write still keeps it from "done"
  writeFileSync(l.transcript, base + message(K2, 20) + answer)
  parentAt(BASE + 0.11)
  childAt(BASE + 0.84)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'idle')
  assert.equal(agyChildrenSettledFor(A, l.deps), false)
  // ★ the child's own report before the answer, the child's closing record 0.7 s after it: done
  writeFileSync(l.transcript, base + message(K1, 20) + answer)
  parentAt(BASE + 0.12)
  childAt(BASE + 0.84)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'done')
  // ★ and settled (the notifier's rule 7b may ring it)
  assert.equal(agyChildrenSettledFor(A, l.deps), true)
  // ⚠️ a child that has children of its own (a coordinator whose worker may fail later): not exempt (codex review)
  const g = transcriptPathOf(K3, l.deps.home)
  mkdirSync(join(g, '..'), { recursive: true })
  writeFileSync(g, JSON.stringify({ type: 'SYSTEM_MESSAGE', step_index: 0, created_at: iso, content: `x\n<SYSTEM_MESSAGE>\n[Message] timestamp=${iso} sender=${K1} priority=MESSAGE_PRIORITY_HIGH content=work\n</SYSTEM_MESSAGE>` }) + '\n')
  utimesSync(g, BASE - 1, BASE - 1)
  await new Promise((r) => setTimeout(r, 5))
  utimesSync(join(l.deps.home, '.gemini', 'antigravity-cli', 'brain'), BASE + 3, BASE + 3)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'idle')
  rmSync(join(g, '..', '..', '..'), { recursive: true })
  // ⚠️ …nor when ANOTHER child of the turn (one that closed before the answer) has a worker (codex review)
  writeFileSync(l.transcript, base + launch('coordinate', K2) + message(K1, 20) + answer)
  parentAt(BASE + 0.16)
  for (const f of [`pid-${PID}.json`, `session-${A}.json`]) {
    writeFileSync(join(l.deps.dir, f), JSON.stringify({ ...raw, input: { ...raw.input, subagents: [{ name: 'self', role: 'ask', status: 'completed' }, { name: 'self', role: 'coordinate', status: 'completed' }] } }))
    utimesSync(join(l.deps.dir, f), BASE + 2, BASE + 2)
  }
  const k2 = transcriptPathOf(K2, l.deps.home)
  mkdirSync(join(k2, '..'), { recursive: true })
  writeFileSync(k2, JSON.stringify({ type: 'SYSTEM_MESSAGE', step_index: 0, created_at: iso, content: `x\n<SYSTEM_MESSAGE>\n[Message] timestamp=${iso} sender=${A} priority=MESSAGE_PRIORITY_HIGH content=coordinate\n</SYSTEM_MESSAGE>` }) + '\n')
  utimesSync(k2, BASE - 1, BASE - 1)
  // (another id: a conversation's first record never changes, and it is remembered)
  const g2 = transcriptPathOf('4c1d2e3f-0000-4000-8000-00000000000a', l.deps.home)
  mkdirSync(join(g2, '..'), { recursive: true })
  writeFileSync(g2, JSON.stringify({ type: 'SYSTEM_MESSAGE', step_index: 0, created_at: iso, content: `x\n<SYSTEM_MESSAGE>\n[Message] timestamp=${iso} sender=${K2} priority=MESSAGE_PRIORITY_HIGH content=work\n</SYSTEM_MESSAGE>` }) + '\n')
  utimesSync(g2, BASE - 1, BASE - 1)
  utimesSync(join(l.deps.home, '.gemini', 'antigravity-cli', 'brain'), BASE + 5, BASE + 5)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'idle')
  // ★ the same coordinator in an EARLIER turn (not launched in this one): this turn is still exempt
  writeFileSync(l.transcript, base + message(K1, 20) + answer)
  parentAt(BASE + 0.17)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'done')
  rmSync(join(g2, '..', '..', '..'), { recursive: true })
  rmSync(join(k2, '..', '..', '..'), { recursive: true })
  for (const f of [`pid-${PID}.json`, `session-${A}.json`]) {
    writeFileSync(join(l.deps.dir, f), JSON.stringify(raw))
    utimesSync(join(l.deps.dir, f), BASE + 2, BASE + 2)
  }
  utimesSync(join(l.deps.home, '.gemini', 'antigravity-cli', 'brain'), BASE + 6, BASE + 6)
  writeFileSync(l.transcript, base + message(K1, 20) + answer)
  parentAt(BASE + 0.12)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'done')
  // ⚠️ a child whose own record started a worker (the worker gone from the index): not exempt (codex review)
  const k1 = transcriptPathOf(K1, l.deps.home)
  const k1Was = readFileSync(k1, 'utf8')
  const lines = k1Was.trimEnd().split('\n')
  lines.splice(1, 0, JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 1, created_at: iso, tool_calls: [{ name: 'invoke_subagent', args: { Prompt: 'work' } }] }))
  writeFileSync(k1, lines.join('\n') + '\n')
  childAt(BASE + 0.86)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'idle')
  writeFileSync(k1, k1Was)
  childAt(BASE + 0.84)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'done')
  // ⚠️ a child record that ends mid-line (an error being written, or cut by a failure: the tail read drops it): not exempt
  appendFileSync(k1, '{"type":"ERROR_MESSAGE","step_index":9,"err')
  childAt(BASE + 0.88)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'idle')
  writeFileSync(k1, k1Was)
  childAt(BASE + 0.84)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'done')
  // ⚠️ a child record larger than the tail read (a launch could be out of it): not exempt (codex review / user decision)
  const big = k1Was.trimEnd().split('\n')
  big.splice(1, 0, JSON.stringify({ type: 'GENERIC', step_index: 1, created_at: iso, content: `Created At: ${iso}\n${'x'.repeat(2 * 1024 * 1024 + 10)}` }))
  writeFileSync(k1, big.join('\n') + '\n')
  childAt(BASE + 0.87)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'idle')
  writeFileSync(k1, k1Was)
  childAt(BASE + 0.84)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'done')
  // ⚠️ a failed sibling of this turn (gone from the index; still in the parent's launches and the status line) beside
  //    the child that reported: not settled, and not "done" either (codex review)
  writeFileSync(l.transcript, base + launch('sibling', NOFILE) + message(K1, 20) + answer)
  parentAt(BASE + 0.18)
  for (const f of [`pid-${PID}.json`, `session-${A}.json`]) {
    writeFileSync(join(l.deps.dir, f), JSON.stringify({ ...raw, input: { ...raw.input, subagents: [{ name: 'self', role: 'ask', status: 'completed' }, { name: 'self', role: 'sibling', status: 'failed' }] } }))
    utimesSync(join(l.deps.dir, f), BASE + 2, BASE + 2)
  }
  assert.equal(agyChildrenSettledFor(A, l.deps), false)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'idle')
  // ⚠️ a sibling of this turn that ran to its own answer but never reported (stopped before reporting): not exempt, not
  //    settled (codex review); once it has reported too: done
  const k6id = '7f405162-0000-4000-8000-00000000000d'
  const k6 = finishedChild(k6id, 'quiet')
  utimesSync(join(l.deps.home, '.gemini', 'antigravity-cli', 'brain'), BASE + 9, BASE + 9)
  writeFileSync(l.transcript, base + launch('quiet', k6id) + message(K1, 20) + answer)
  parentAt(BASE + 0.23)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'idle')
  assert.equal(agyChildrenSettledFor(A, l.deps), false)
  writeFileSync(l.transcript, base + launch('quiet', k6id) + message(k6id, 20) + message(K1, 20) + answer)
  parentAt(BASE + 0.24)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'done')
  rmSync(join(k6, '..', '..', '..'), { recursive: true })
  utimesSync(join(l.deps.home, '.gemini', 'antigravity-cli', 'brain'), BASE + 10, BASE + 10)
  // ⚠️ a system notice after the parent's answer (children stopped by a restart: `sender=system`): not done (codex review)
  writeFileSync(l.transcript, base + message(K1, 20) + answer + JSON.stringify({ type: 'SYSTEM_MESSAGE', step_index: 22, content: `x\n<SYSTEM_MESSAGE>\n[Message] timestamp=${iso} sender=system priority=MESSAGE_PRIORITY_HIGH content=stopped\n</SYSTEM_MESSAGE>` }) + '\n')
  parentAt(BASE + 0.25)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'idle')
  // ⚠️ a launch whose result names no child (it may have failed to start): not exempt
  writeFileSync(l.transcript, base + JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 18, created_at: iso, tool_calls: [{ name: 'invoke_subagent', args: { Prompt: 'x' } }] }) + '\n' + message(K1, 20) + answer)
  parentAt(BASE + 0.22)
  for (const f of [`pid-${PID}.json`, `session-${A}.json`]) {
    writeFileSync(join(l.deps.dir, f), JSON.stringify(raw))
    utimesSync(join(l.deps.dir, f), BASE + 2, BASE + 2)
  }
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'idle')
  // ★ a child that failed in an EARLIER turn (not launched in this one): this turn is still done and settled (codex
  //   review / user decision: the status line keeps earlier turns' children)
  writeFileSync(l.transcript, base + message(K1, 20) + answer)
  parentAt(BASE + 0.19)
  assert.equal(agyChildrenSettledFor(A, l.deps), true)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'done')
  writeFileSync(l.transcript, base + message(K1, 20) + answer)
  parentAt(BASE + 0.12)
  for (const f of [`pid-${PID}.json`, `session-${A}.json`]) {
    writeFileSync(join(l.deps.dir, f), JSON.stringify(raw))
    utimesSync(join(l.deps.dir, f), BASE + 2, BASE + 2)
  }
  // ★ the notifier's rows read it in the same lock-verified pass (no second probe at send time / codex review)
  agyOwnRows('pc-a', l.deps)
  assert.equal(agyChildrenSettledSeen(A), true)
  agyOwnRows('pc-a', { ...l.deps, locksOf: () => [] })
  assert.equal(agyChildrenSettledSeen(A), true, 'a look that does not list it keeps the last read')
  // ⚠️ judged by the lock holder only (a stale file of an agy that moved on does not count / codex review)
  assert.equal(agyChildrenSettledFor(A, { ...l.deps, locksOf: () => [] }), false)
  assert.equal(agyChildrenSettledFor(A, l.deps), true)
  // (the child wrote before the answer: done; settled too — every child says `completed`, so an `idle` held while the
  //  children could not be listed may ring once readable / agy review)
  childAt(BASE + 0.05)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'done')
  assert.equal(agyChildrenSettledFor(A, l.deps), true)
  // ⚠️ …but not with a failed or killed child of this turn (codex review: one gone from the index rang "done")
  for (const f of [`pid-${PID}.json`, `session-${A}.json`]) {
    writeFileSync(join(l.deps.dir, f), JSON.stringify({ ...raw, input: { ...raw.input, subagents: [{ name: 'self', role: 'ask', status: 'completed' }, { name: 'self', role: 'other', status: 'failed' }] } }))
    utimesSync(join(l.deps.dir, f), BASE + 2, BASE + 2)
  }
  writeFileSync(l.transcript, base + launch('other', NOFILE) + message(K1, 20) + answer)
  parentAt(BASE + 0.2)
  assert.equal(agyChildrenSettledFor(A, l.deps), false)
  // (that failure in an earlier turn: settled)
  writeFileSync(l.transcript, base + message(K1, 20) + answer)
  parentAt(BASE + 0.12)
  assert.equal(agyChildrenSettledFor(A, l.deps), true)
  // ⚠️ a child of an EARLIER turn reporting in this one (this turn launched another): not exempt
  for (const f of [`pid-${PID}.json`, `session-${A}.json`]) {
    writeFileSync(join(l.deps.dir, f), JSON.stringify({ ...raw, input: { ...raw.input, subagents: [{ name: 'self', role: 'ask', status: 'completed' }, { name: 'self', role: 'other', status: 'completed' }] } }))
    utimesSync(join(l.deps.dir, f), BASE + 2, BASE + 2)
  }
  const k5 = finishedChild('6e3f4051-0000-4000-8000-00000000000c', 'other')
  utimesSync(join(l.deps.home, '.gemini', 'antigravity-cli', 'brain'), BASE + 7, BASE + 7)
  writeFileSync(l.transcript, base + JSON.stringify({ type: 'USER_INPUT', step_index: 17, created_at: iso, content: '<USER_REQUEST>\nnext\n</USER_REQUEST>' }) + '\n' + launch('other', '6e3f4051-0000-4000-8000-00000000000c') + message(K1, 20) + answer)
  parentAt(BASE + 0.21)
  childAt(BASE + 0.84)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'idle')
  childAt(BASE + 0.05)
  rmSync(join(k5, '..', '..', '..'), { recursive: true })
  utimesSync(join(l.deps.home, '.gemini', 'antigravity-cli', 'brain'), BASE + 8, BASE + 8)
  writeFileSync(l.transcript, base + message(K1, 20) + answer)
  parentAt(BASE + 0.12)
  for (const f of [`pid-${PID}.json`, `session-${A}.json`]) {
    writeFileSync(join(l.deps.dir, f), JSON.stringify(raw))
    utimesSync(join(l.deps.dir, f), BASE + 2, BASE + 2)
  }
  childAt(BASE + 0.84)
  // ⚠️ a report in an earlier turn does not count (a new request came after it)
  writeFileSync(l.transcript, base + message(K1, 20) + JSON.stringify({ type: 'USER_INPUT', step_index: 21, created_at: iso, content: '<USER_REQUEST>\nagain\n</USER_REQUEST>' }) + '\n' + answer)
  parentAt(BASE + 0.14)
  childAt(BASE + 0.84)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'idle')
  writeFileSync(l.transcript, base + message(K1, 20) + answer)
  parentAt(BASE + 0.13)
  // ⚠️ the children cannot all be listed now (a conversation folder being created): the row is not flipped for it
  //    (agy review: every finished parent turned "idle"), but rule 7b does not ring on it (codex review)
  const fresh = join(l.deps.home, '.gemini', 'antigravity-cli', 'brain', '3f0c1d2e-0000-4000-8000-00000000000f')
  mkdirSync(fresh, { recursive: true })
  // (the child that wrote after the answer is not exempt then: as before this exemption / codex review)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'idle')
  assert.equal(agyChildrenSettledFor(A, l.deps), false)
  rmSync(fresh, { recursive: true })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'done')
  assert.equal(agyChildrenSettledFor(A, l.deps), true)
  // ★ the status line says `killed` (an earlier run of the same prompt, or killed after its own answer): judged by the
  //   child's record, which ran to its answer — done (codex review: a retry under the same prompt lost the fix)
  for (const f of [`pid-${PID}.json`, `session-${A}.json`]) {
    writeFileSync(join(l.deps.dir, f), JSON.stringify({ ...raw, input: { ...raw.input, subagents: [{ name: 'self', role: 'ask', status: 'killed' }, { name: 'self', role: 'ask', status: 'completed' }] } }))
    utimesSync(join(l.deps.dir, f), BASE + 2, BASE + 2)
  }
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'done')
  for (const f of [`pid-${PID}.json`, `session-${A}.json`]) {
    writeFileSync(join(l.deps.dir, f), JSON.stringify(raw))
    utimesSync(join(l.deps.dir, f), BASE + 2, BASE + 2)
  }
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'done')
  // ⚠️ another agent's message after the child's own answer (a worker's failure it had not answered): not done
  const p0 = transcriptPathOf(K1, l.deps.home)
  const kid = readFileSync(p0, 'utf8')
  appendFileSync(p0, message(K2, 4))
  childAt(BASE + 0.85)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'idle')
  writeFileSync(p0, kid)
  // ⚠️ a child that failed after its report: not done
  writeFileSync(l.transcript, base + message(K1, 20) + answer)
  parentAt(BASE + 0.15)
  const p = transcriptPathOf(K1, l.deps.home)
  appendFileSync(p, JSON.stringify({ type: 'ERROR_MESSAGE', step_index: 4, created_at: iso, error: 'quota' }) + '\n')
  childAt(BASE + 0.84)
  assert.equal(agyOwnRows('pc-a', l.deps)[0]?.status, 'idle')
})

test('★ a status file over 256 KiB (long child prompts in `subagents[].role`) still gives the row', async (t) => {
  const l = await lab(t)
  const role = 'x'.repeat(40 * 1024)
  l.setState({ agent_state: 'idle', subagents: Array.from({ length: 8 }, (_, i) => ({ name: 'self', role: `${i}${role}`, status: 'running' })) }, BASE)
  assert.equal(agyOwnRows('pc-a', l.deps).length, 1)
})

test('★ two siblings with one prompt, both still thinking, do not keep a third child’s question off the phone', async (t) => {
  const l = await lab(t)
  const { askedAt } = withChildren(l, [
    { id: K2, prompt: 'independent check', asking: false, thinking: true },
    { id: K3, prompt: 'independent check', asking: false, thinking: true },
    { id: K1, prompt: 'confirm the target', asking: true },
  ])
  l.deps.answerSettleMs = 0
  l.deps.childOpenMs = 5
  l.deps.childBackWaitMs = 0
  const mark = { pid: PID, askedAt: askedAt.get(K1)!, step: 1, index: 0, callAt: (BASE - 35) * 1000, child: K1 }
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'steps', steps: [{ key: '2' }] }, l.deps), { ok: true })
})

test('★ a child started right after a look is found at once (the conversation list is read again when it grows)', async (t) => {
  const l = await lab(t)
  withChildren(l, [{ id: K1, prompt: 'first', asking: false, thinking: true }])
  assert.equal((await agyRows('pc-a', l.deps))[0]?.status, 'working')
  withChildren(l, [{ id: K1, prompt: 'first', asking: false, thinking: true }, { id: K3, prompt: 'second', asking: true }])
  assert.equal((await agyRows('pc-a', l.deps))[0]?.status, 'waiting')
})

test('★ a child folder made a moment ago without its transcript yet keeps child cards off; an old empty folder does not', async (t) => {
  const l = await lab(t)
  const { askedAt } = withChildren(l, [{ id: K1, prompt: 'ask', asking: true }])
  const fresh = join(l.deps.home, '.gemini', 'antigravity-cli', 'brain', '5d1e2c3b-0000-4000-8000-00000000000f')
  mkdirSync(fresh, { recursive: true })
  l.deps.answerSettleMs = 0
  l.deps.childOpenMs = 5
  l.deps.childBackWaitMs = 0
  const mark = { pid: PID, askedAt: askedAt.get(K1)!, step: 1, index: 0, callAt: (BASE - 35) * 1000, child: K1 }
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'steps', steps: [{ key: '2' }] }, l.deps), { ok: false, reason: 'changed' })
  utimesSync(fresh, BASE - 300, BASE - 300)
  // (the archive folder changes so the index is read again)
  mkdirSync(join(l.deps.home, '.gemini', 'antigravity-cli', 'brain', 'not-a-conversation'))
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'steps', steps: [{ key: '2' }] }, l.deps), { ok: true })
})

test('★ the back ESC waits for the parent to be idle (a new turn started on the PC is not stopped)', async (t) => {
  const l = await lab(t)
  const { askedAt } = withChildren(l, [{ id: K1, prompt: 'ask', asking: true }])
  const kid = transcriptPathOf(K1, l.deps.home)
  l.deps.answerSettleMs = 0
  l.deps.childOpenMs = 150
  l.deps.childBackWaitMs = 600
  const mark = { pid: PID, askedAt: askedAt.get(K1)!, step: 1, index: 0, callAt: (BASE - 35) * 1000, child: K1 }
  // the answer recorded, but the person started a new turn on the PC
  const later = setTimeout(() => {
    appendFileSync(kid, JSON.stringify({ type: 'GENERIC', step_index: 2, content: 'A1: b' }) + '\n')
    l.setState({ agent_state: 'working', subagents: [{ name: 'self', role: 'ask', status: 'running' }] }, BASE + 3)
  }, 225)
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'steps', steps: [{ key: '2' }] }, l.deps), { ok: true })
  clearTimeout(later)
  await settle()
  assert.equal(l.got.join(''), '\x0b2')
})

test('★ a grandchild’s question (a child’s own child) rings for the root, never as a card', async (t) => {
  const l = await lab(t)
  withChildren(l, [{ id: K1, prompt: 'coordinate', asking: false, thinking: true }])
  const iso = (sec: number): string => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const g = transcriptPathOf(K3, l.deps.home)
  mkdirSync(join(g, '..'), { recursive: true })
  writeFileSync(
    g,
    [
      { type: 'SYSTEM_MESSAGE', step_index: 0, content: `x\n<SYSTEM_MESSAGE>\n[Message] timestamp=${iso(BASE - 30)} sender=${K1} priority=MESSAGE_PRIORITY_HIGH content=work\n</SYSTEM_MESSAGE>` },
      { type: 'PLANNER_RESPONSE', step_index: 1, created_at: iso(BASE - 30), tool_calls: [{ name: 'ask_question', args: { questions: [{ question: 'G?', options: ['a', 'b'] }] } }] },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  )
  assert.equal((await agyRows('pc-a', l.deps))[0]?.status, 'waiting')
  const mark = { pid: PID, askedAt: statSync(g).mtimeMs, step: 1, index: 0, callAt: (BASE - 30) * 1000, child: K3 }
  l.deps.answerSettleMs = 0
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'steps', steps: [{ key: '2' }] }, l.deps), { ok: false, reason: 'changed' })
})

test('★★ agy 1.5.16 lists the grandchild in the parent\'s subagents too: its question is known and matched (measured 2026-11-25)', async (t) => {
  const l = await lab(t)
  withChildren(l, [{ id: K1, prompt: 'coordinate', asking: false, thinking: true }])
  const iso = (sec: number): string => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const g = transcriptPathOf(K3, l.deps.home)
  mkdirSync(join(g, '..'), { recursive: true })
  writeFileSync(
    g,
    [
      { type: 'SYSTEM_MESSAGE', step_index: 0, content: `x\n<SYSTEM_MESSAGE>\n[Message] timestamp=${iso(BASE - 30)} sender=${K1} priority=MESSAGE_PRIORITY_HIGH content=ask fruit\n</SYSTEM_MESSAGE>` },
      { type: 'PLANNER_RESPONSE', step_index: 1, created_at: iso(BASE - 30), tool_calls: [{ name: 'ask_question', args: { questions: [{ question: 'G?', options: ['a', 'b'] }] } }] },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  )
  const { agyChildQuestions } = await import('./sessions.ts')
  // as 1.5.16 writes it: the child and the grandchild, flat
  const q = agyChildQuestions({ activeSubagentRoles: ['coordinate', 'ask fruit'], version: '1.5.16' }, A, l.deps.home)
  assert.equal(q.known, true)
  assert.deepEqual(q.asking.map((a) => [a.child, a.ambiguous]), [[K3, false]])
  // as an older agy writes it: the direct child only (the grandchild nested, as before)
  const old = agyChildQuestions({ activeSubagentRoles: ['coordinate'], version: '1.5.15' }, A, l.deps.home)
  assert.equal(old.known, true)
  assert.deepEqual(old.asking.map((a) => [a.child, a.ambiguous]), [[K3, true]])
  // ⚠️ an older agy is never matched deeper (its blind ctrl+k path reads `ambiguous` / codex · agy review)
  assert.equal(agyChildQuestions({ activeSubagentRoles: ['coordinate', 'ask fruit'], version: '1.5.15' }, A, l.deps.home).known, false)
})

test('★ 1.5.16: a deeper one with a running prompt counts too — a killed leftover makes it ambiguous, never silent (codex · agy review)', async (t) => {
  const l = await lab(t)
  // K1 asks (direct, prompt "ask fruit"); K3 under K2 is a killed leftover with the same prompt, its question pending
  withChildren(l, [
    { id: K1, prompt: 'ask fruit', asking: true },
    { id: K2, prompt: 'coordinate', asking: false, finished: true, running: false },
  ])
  const iso = (sec: number): string => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const g = transcriptPathOf(K3, l.deps.home)
  mkdirSync(join(g, '..'), { recursive: true })
  writeFileSync(
    g,
    [
      { type: 'SYSTEM_MESSAGE', step_index: 0, content: `x\n<SYSTEM_MESSAGE>\n[Message] timestamp=${iso(BASE - 300)} sender=${K2} priority=MESSAGE_PRIORITY_HIGH content=ask fruit\n</SYSTEM_MESSAGE>` },
      { type: 'PLANNER_RESPONSE', step_index: 1, created_at: iso(BASE - 300), tool_calls: [{ name: 'ask_question', args: { questions: [{ question: 'Old?', options: ['a', 'b'] }] } }] },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  )
  const { agyChildQuestions } = await import('./sessions.ts')
  const q = agyChildQuestions({ activeSubagentRoles: ['ask fruit'], version: '1.5.16' }, A, l.deps.home)
  assert.equal(q.known, true)
  assert.deepEqual(q.asking.map((a) => [a.child, a.ambiguous]).sort(), [[K1, true], [K3, true]].sort())
  // ★ a finished direct child with the prompt does not hide a grandchild that runs with it (agy review)
  appendFileSync(transcriptPathOf(K1, l.deps.home), JSON.stringify({ type: 'GENERIC', step_index: 2, content: 'A1: a' }) + '\n' + JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 3, content: 'Reported back.' }) + '\n')
  const after = agyChildQuestions({ activeSubagentRoles: ['ask fruit'], version: '1.5.16' }, A, l.deps.home)
  assert.deepEqual(after.asking.map((a) => [a.child, a.ambiguous]), [[K3, false]])
})

test('★ the back ESC is not sent once the parent’s transcript moved (a new prompt typed on the PC, the status line not yet "working")', async (t) => {
  const l = await lab(t)
  const { askedAt } = withChildren(l, [{ id: K1, prompt: 'ask', asking: true }])
  const kid = transcriptPathOf(K1, l.deps.home)
  l.deps.answerSettleMs = 0
  l.deps.childOpenMs = 150
  l.deps.childBackWaitMs = 600
  const mark = { pid: PID, askedAt: askedAt.get(K1)!, step: 1, index: 0, callAt: (BASE - 35) * 1000, child: K1 }
  const later = setTimeout(() => {
    appendFileSync(kid, JSON.stringify({ type: 'GENERIC', step_index: 2, content: 'A1: b' }) + '\n')
    appendFileSync(l.transcript, JSON.stringify({ type: 'USER_INPUT', step_index: 30, content: '<USER_REQUEST>\nnext\n</USER_REQUEST>' }) + '\n')
  }, 225)
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'steps', steps: [{ key: '2' }] }, l.deps), { ok: true })
  clearTimeout(later)
  await settle()
  assert.equal(l.got.join(''), '\x0b2')
})

test('★ a killed child’s leftover question with a rerun of its prompt still thinking: no answer from the phone (ctrl+k could open nothing)', async (t) => {
  const l = await lab(t)
  // K1: killed while asking (its question left pending); K2: the rerun, thinking; one running entry for the prompt
  const { askedAt } = withChildren(l, [{ id: K1, prompt: 'same', asking: true, running: false }, { id: K2, prompt: 'same', asking: false, thinking: true }])
  l.deps.answerSettleMs = 0
  l.deps.childOpenMs = 5
  l.deps.childBackWaitMs = 0
  const mark = { pid: PID, askedAt: askedAt.get(K1)!, step: 1, index: 0, callAt: (BASE - 35) * 1000, child: K1 }
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'steps', steps: [{ key: '2' }] }, l.deps), { ok: false, reason: 'changed' })
  await settle()
  assert.equal(l.got.join(''), '')
})

test('★ a check that throws ends a key sequence as refused (never an unhandled rejection)', async (t) => {
  const l = await lab(t)
  const res = await writeSequence(l.sock, [
    { bytes: 'a', pauseMs: 0 },
    {
      bytes: 'b',
      pauseMs: 0,
      beforeWrite: () => {
        throw new Error('EIO')
      },
    },
  ])
  assert.deepEqual(res, { ok: false, reason: 'refused', written: 1 })
})

// ★★ Answers typed against the screen (docs/AGY.md §14): a model of agy's question dialog as measured on 1.5.13
//    (digits pick / toggle, ↑↓ move, space toggles, Enter picks / opens the write-in field / submits, → next, ← back,
//    ESC skips — or, in the field, goes back), drawn as the relay's screen shows it.
class FakeDialog {
  k = 0
  cursor = 0
  writing = false
  field = ''
  ticks: boolean[][]
  answers: string[] = []
  done = false
  view: 'parent' | 'child' = 'parent'
  banner?: string
  open = true
  keys: string[] = []
  readonly qs: { question: string; options: string[]; multi: boolean }[]
  constructor(qs: { question: string; options: string[]; multi: boolean }[]) {
    this.qs = qs
    this.ticks = qs.map((q) => q.options.map(() => false))
    this.answers = qs.map(() => '')
  }
  get q() {
    return this.qs[this.k]!
  }
  next(answer: string): void {
    this.answers[this.k] = answer
    this.writing = false
    this.field = ''
    this.cursor = 0
    if (this.k === this.qs.length - 1) this.done = true
    else this.k++
  }
  multiAnswer(extra = ''): string {
    return [...this.q.options.filter((_, j) => this.ticks[this.k]![j]), ...(extra ? [extra] : [])].join(', ')
  }
  /** The subagent whose view is shown */
  childId = K1
  /** The subagent whose question ctrl+k opens */
  askingChild = K1
  /** Where the open dialog is drawn: the parent's own question on its view, a subagent's on that child's */
  dialogView: 'parent' | 'child' = 'parent'
  /**
   * ★ agy 1.5.16's subagent list under the parent's input box (docs/AGY.md §19.2): set ⇒ drawn, and the keys below act
   *   as measured. `waits`: what each one's view shows waiting (its own question is the asking child's).
   */
  list?: { id: string; name: string; waits?: 'question' | 'approval' }[]
  /** The list's focused row; -1 = the input box */
  focus = -1
  /** Something typed in the PC's input box */
  draft = ''
  press(bytes: string): void {
    this.keys.push(bytes)
    if (this.list !== undefined && !this.open) {
      if (this.view === 'parent') {
        if (bytes === '\x1b[B') this.focus = Math.min(this.list.length - 1, this.focus + 1)
        else if (bytes === '\x1b[A') this.focus = Math.max(-1, this.focus - 1)
        else if (bytes === '\r' && this.focus >= 0) {
          this.view = 'child'
          this.childId = this.list[this.focus]!.id
        } else if (bytes === '\x1b' && this.focus >= 0) this.focus = -1
        return
      }
      if (bytes === '\x1b') this.view = 'parent'
      else if (bytes === 'a' && this.childId === this.askingChild) {
        this.open = true
        this.dialogView = 'child'
      } else if (bytes === 'a') this.openedOther = true
      return
    }
    // (the dialog is on the other view: only ESC, going back from a subagent's view)
    if (this.open && !this.done && this.view !== this.dialogView) {
      if (bytes === '\x1b' && this.view === 'child') this.view = 'parent'
      return
    }
    if (!this.open) {
      // ESC on a subagent's view goes back to the parent's; ctrl+k (on the parent's) opens the asking child's question
      if (bytes === '\x1b' && this.view === 'child') this.view = 'parent'
      else if (bytes === '\x0b' && this.view === 'parent' && this.banner !== undefined) {
        this.open = true
        this.view = 'child'
        this.dialogView = 'child'
        this.childId = this.askingChild
      }
      return
    }
    if (this.done) {
      if (bytes === '\x1b' && this.view === 'child') this.view = 'parent'
      else if (bytes === '\x1b' && this.list !== undefined && this.focus >= 0) this.focus = -1
      return
    }
    const n = this.q.options.length
    if (this.writing) {
      if (bytes === '\r') this.next(this.q.multi ? this.multiAnswer(this.field) : this.field)
      else if (bytes === '\x1b') this.writing = false
      else this.field += bytes
      return
    }
    if (/^[1-9]$/.test(bytes) && n + 1 <= 9) {
      const i = Number(bytes) - 1
      if (i === n) this.writing = true
      else if (this.q.multi) {
        this.ticks[this.k]![i] = !this.ticks[this.k]![i]
        this.cursor = i
      } else this.next(this.q.options[i]!)
      return
    }
    switch (bytes) {
      case '\x1b[B':
        this.cursor = Math.min(n, this.cursor + 1)
        break
      case '\x1b[A':
        this.cursor = Math.max(0, this.cursor - 1)
        break
      case ' ':
        if (this.q.multi && this.cursor < n) this.ticks[this.k]![this.cursor] = !this.ticks[this.k]![this.cursor]
        break
      case '\r':
        if (this.cursor === n) this.writing = true
        else if (this.q.multi) this.next(this.multiAnswer())
        else this.next(this.q.options[this.cursor]!)
        break
      case '\x1b[C':
        if (this.k < this.qs.length - 1) this.next(this.q.multi ? this.multiAnswer() : '')
        break
      case '\x1b[D':
        if (this.k > 0) {
          this.k--
          this.cursor = 0
        }
        break
      case '\x1b':
        this.next('User Skipped')
        break
    }
  }
  /** `a` pressed on another subagent's view (its dialog would have opened) */
  openedOther = false
  /** What the asking child's view shows it asks (its question by default) */
  shownQuestion?: string
  screen(): string {
    const lines: string[] = []
    if (this.list !== undefined && (!this.open || this.done) && this.view === 'parent') {
      const rule = '─'.repeat(60)
      if (this.banner !== undefined && !this.open) lines.push(' ┃ self has a question', ' ┃', ` ┃ ? ${this.banner}`, ' ┃', ' ┃ ctrl+k answer · alt+j manage')
      lines.push(rule, this.draft ? `> ${this.draft}` : '>', rule)
      this.list.forEach((r, i) => lines.push(`${this.focus === i ? '> ' : '  '}● Agent(self: ${r.name}) · Gemini 4 Neon  ${r.waits === 'question' ? 'Blocked · AskQuestion' : r.waits === 'approval' ? 'Blocked · Bash' : 'Thinking'} · 9s`))
      lines.push(rule, '? for shortcuts                                accept-edits · Gemini 4 Neon · high')
      return lines.join('\n')
    }
    if (this.list !== undefined && (!this.open || this.done) && this.view === 'child') {
      const row = this.list.find((r) => r.id === this.childId)
      const waits = this.done && this.childId === this.askingChild ? undefined : row?.waits
      lines.push('  main › self', '  ● running · Gemini 4 Neon (High) · 9s · 3 steps', `  ID: ${this.childId}`, '  ' + '─'.repeat(20))
      if (waits === 'question') lines.push('  ⚠ Approval Required', '    AskQuestion', `      ? ${this.childId === this.askingChild ? (this.shownQuestion ?? this.q.question) : 'Something else?'}`, '  ' + '─'.repeat(20))
      if (waits === 'approval') lines.push('  ⚠ Approval Required', '    Bash', '      make', '  ' + '─'.repeat(20))
      lines.push(`  ↑/↓ scroll · pgup/pgdown page · ctrl+end bottom · ctrl+home top · ctrl+o expand${waits ? ' · a respond' : ''} · shift+k kill · esc back`, '                                Gemini 4 Neon · high · 2 subagent(s)')
      return lines.join('\n')
    }
    if (!this.open || this.done || this.view !== this.dialogView) {
      // ★ as agy 1.5.13 draws a subagent's view at 80 columns (its id under the header, the footer wrapped)
      if (this.view === 'child') lines.push('  main › self', '  ● running · Gemini 4 Neon (High) · 9s · 3 steps', `  ID: ${this.childId}`, '', '  ? asked', '  ↑/↓ scroll · pgup/pgdown page · ctrl+end bottom · ctrl+home top', '  ctrl+o expand · shift+k kill · esc back', '                                Gemini 4 Neon · high · 1 subagent(s)')
      else {
        if (this.banner !== undefined && !this.open) lines.push(' ┃ self has a question', ' ┃', ` ┃ ? ${this.banner}`, ' ┃', ' ┃ ctrl+k answer · alt+j manage')
        lines.push('>', '? for shortcuts')
      }
      return lines.join('\n')
    }
    const q = this.q
    // ★ a subagent's dialog opens in its view, under its header (measured at 80×24)
    if (this.view === 'child') lines.push('  main › self', '  ● running · Gemini 4 Neon (High) · 7s · 3 steps', `  ID: ${this.childId}`, '  ────', '  (1–4 of 26 lines)', 'Question', '────', '')
    lines.push(`Question ${this.k + 1}/${this.qs.length}: ${q.question}`, '')
    q.options.forEach((o, j) => lines.push(`${this.cursor === j ? '>' : ' '} ${j + 1}. ${q.multi ? `[${this.ticks[this.k]![j] ? 'x' : ' '}] ` : ''}${o}`))
    lines.push(`${this.cursor === q.options.length ? '>' : ' '} ${q.options.length + 1}. Write-in...`)
    // ★ the footers as agy 1.5.13 draws them
    const last = this.k === this.qs.length - 1
    const batch = this.qs.length > 1
    const submit = last && batch ? 'enter Submit All' : q.multi ? 'enter Submit' : 'enter Select'
    if (this.writing) lines.push('  Your answer:', `  ${this.field}`, `  ${last && batch ? 'enter Submit All' : 'enter Submit'} · esc Back`)
    else {
      const enter = this.cursor === q.options.length && !q.multi ? 'enter Write-in' : submit
      const hints = ['↑/↓ Navigate', ...(this.k > 0 ? ['← Back'] : []), ...(!last ? ['→ Next'] : []), ...(q.multi ? ['space Toggle'] : []), enter, 'esc Skip']
      lines.push('', `  ${hints.join(' · ')}`)
    }
    return lines.join('\n')
  }
}

/** A lab whose agy asks `qs` (its relay shows the screen), answered through `FakeDialog` */
/** A subagent with nothing pending (its view may be the one on the PC) */
function idleChild(l: { deps: { home: string } }, id: string): void {
  const p = transcriptPathOf(id, l.deps.home)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, [{ type: 'SYSTEM_MESSAGE', step_index: 0, content: 'x' }, { type: 'PLANNER_RESPONSE', step_index: 1, content: 'Reported back.' }].map((r) => JSON.stringify(r)).join('\n') + '\n')
}

/** agy leaving "working" once it has taken `n` ESCs (measured ~85 ms after a stop's ESC) */
function stopsAfter(l: Lab, n: number): void {
  l.deps.readNow = (target) => {
    const now = readNow(target)
    const escs = l.got.join('').split('\x1b').length - 1
    return now && escs >= n ? { ...now, state: { ...now.state, agentState: 'idle' } } : now
  }
}

async function screenLab(t: { after(fn: () => void): void }, qs: { question: string; options: string[]; multi: boolean }[], child = false) {
  const l = await lab(t)
  const iso = (sec: number): string => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const call = { name: 'ask_question', args: { questions: qs.map((q) => ({ question: q.question, options: q.options, is_multi_select: q.multi })) } }
  let mark: AgyQuestionMark
  if (!child) {
    writeFileSync(
      l.transcript,
      [
        { type: 'USER_INPUT', step_index: 0, created_at: iso(BASE - 20), content: '<USER_REQUEST>\nask\n</USER_REQUEST>' },
        { type: 'PLANNER_RESPONSE', step_index: 1, created_at: iso(BASE - 20), tool_calls: [call] },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    )
    utimesSync(l.transcript, BASE - 10, BASE - 10)
    l.setState({ agent_state: 'tool_use' }, BASE)
    mark = { pid: PID, askedAt: (BASE - 10) * 1000, step: 1, index: 0, callAt: (BASE - 20) * 1000, screen: true }
  } else {
    const { askedAt } = withChildren(l, [{ id: K1, prompt: 'ask', asking: true }])
    const kid = transcriptPathOf(K1, l.deps.home)
    const recs = readFileSync(kid, 'utf8').trim().split('\n').map((x) => JSON.parse(x) as Record<string, unknown>)
    recs[1] = { ...recs[1], tool_calls: [call] }
    writeFileSync(kid, recs.map((r) => JSON.stringify(r)).join('\n') + '\n')
    utimesSync(kid, askedAt.get(K1)! / 1000, askedAt.get(K1)! / 1000)
    mark = { pid: PID, askedAt: askedAt.get(K1)!, step: 1, index: 0, callAt: (BASE - 35) * 1000, child: K1, screen: true }
  }
  const fake = new FakeDialog(qs)
  if (child) {
    fake.open = false
    fake.banner = qs[0]!.question
  }
  const question = parseAgyQuestion(call, true)!
  l.deps.answerSettleMs = 0
  l.deps.screenSettleMs = 300
  l.deps.readScreen = async () => fake.screen()
  l.deps.openKeyLine = async () => ({
    write: async (bytes, refuse) => {
      if (refuse?.()) return false
      fake.press(bytes)
      return true
    },
    close: () => undefined,
  })
  // the panes record says the relay shows the screen
  const pane = join(l.root, 'panes', `${PID}.json`)
  writeFileSync(pane, JSON.stringify({ ...JSON.parse(readFileSync(pane, 'utf8')), screen: true }))
  return { l, fake, mark, question }
}

const plan = (...items: { indexes: number[]; note?: string }[]) => ({ items })

/** The write-in field as agy shows it: wrapped at words to `width`, its last `rows` rows */
function fieldRows(text: string, width: number, rows: number): string[] {
  const out: string[] = []
  let row = ''
  for (const w of text.split(' ')) {
    if (row !== '' && row.length + 1 + w.length > width) {
      out.push(row)
      row = w
    } else row = row === '' ? w : `${row} ${w}`
  }
  out.push(row)
  return out.slice(-rows)
}

test('★★ screen: a batch (an option, ticks, a long list, a written answer) is typed against the dialog, checked at every step', async (t) => {
  const qs = [
    { question: 'Which fruit?', options: ['apple', 'banana'], multi: false },
    { question: 'Which colors?', options: ['red', 'blue', 'green'], multi: true },
    { question: 'Which number?', options: Array.from({ length: 11 }, (_, i) => `n${i + 1}`), multi: false },
    { question: 'Which tools?', options: ['saw', 'hammer'], multi: true },
  ]
  const { l, fake, mark, question } = await screenLab(t, qs)
  const res = await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [1] }, { indexes: [0, 2] }, { indexes: [10] }, { indexes: [0], note: 'nails' }) }, l.deps)
  assert.deepEqual(res, { ok: true })
  assert.equal(fake.done, true)
  assert.deepEqual(fake.answers, ['banana', 'red, green', 'n11', 'saw, nails'])
})

test('★★ screen: a dialog the PC left half done (a later question, ticks, an open field) is put right first', async (t) => {
  const qs = [
    { question: 'Which fruit?', options: ['apple', 'banana'], multi: false },
    { question: 'Which colors?', options: ['red', 'blue'], multi: true },
  ]
  const { l, fake, mark, question } = await screenLab(t, qs)
  // the PC: answered the first, ticked "red" on the second, opened the field, typed something and left
  fake.press('1')
  fake.press('1')
  fake.press('3')
  fake.press('x')
  fake.keys.length = 0
  const res = await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [1] }, { indexes: [1] }) }, l.deps)
  assert.deepEqual(res, { ok: true })
  assert.deepEqual(fake.answers, ['banana', 'blue'])
})

test('★★ screen: skip is one ESC per question, each seen on the screen', async (t) => {
  const qs = [
    { question: 'Which fruit?', options: ['apple'], multi: false },
    { question: 'Which colors?', options: ['red'], multi: true },
  ]
  const { l, fake, mark, question } = await screenLab(t, qs)
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'skip', question }, l.deps), { ok: true })
  assert.deepEqual(fake.answers, ['User Skipped', 'User Skipped'])
})

test('★★ screen: a skip stops between questions once it is no longer wanted (a team disbanded meanwhile / codex review)', async (t) => {
  const qs = [
    { question: 'Which fruit?', options: ['apple'], multi: false },
    { question: 'Which colors?', options: ['red'], multi: true },
  ]
  const { l, fake, mark, question } = await screenLab(t, qs)
  // (asked after the wait, then before and after each key's own check)
  let asked = 0
  const res = await answerAgyQuestion(A, mark, { kind: 'skip', question }, l.deps, undefined, () => ++asked <= 3)
  assert.equal(res.ok, false)
  // the first question skipped, the second one not
  assert.equal(fake.answers[0], 'User Skipped')
  assert.notEqual(fake.answers[1], 'User Skipped')
})

test('★★ screen: nothing typed when the screen shows another question (a different text, another batch, none)', async (t) => {
  const qs = [{ question: 'Which fruit?', options: ['apple', 'banana'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs)
  fake.qs[0] = { ...fake.qs[0]!, question: 'Which vegetable?' }
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [0] }) }, l.deps), { ok: false, reason: 'changed' })
  assert.deepEqual(fake.keys, [])
  fake.qs[0] = { ...fake.qs[0]!, question: 'Which fruit?', options: ['apple', 'cherry'] }
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [0] }) }, l.deps), { ok: false, reason: 'changed' })
  fake.open = false
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [0] }) }, l.deps), { ok: false, reason: 'changed' })
  assert.deepEqual(fake.keys, [])
})

test('★★ screen: a subagent’s question opened from the banner only when the banner shows it; back with ESC once on its view', async (t) => {
  const qs = [{ question: 'Which hill?', options: ['east', 'west'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs, true)
  // another question on the banner: nothing typed
  fake.banner = 'Which lake?'
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [1] }) }, l.deps), { ok: false, reason: 'changed' })
  assert.deepEqual(fake.keys, [])
  fake.banner = 'Which hill?'
  // (the child's answer is recorded, so the back ESC finds nothing pending)
  const kid = transcriptPathOf(K1, l.deps.home)
  const recorded = setTimeout(() => appendFileSync(kid, JSON.stringify({ type: 'GENERIC', step_index: 2, content: 'A1: west' }) + '\n'), 50)
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [1] }) }, l.deps), { ok: true })
  clearTimeout(recorded)
  assert.deepEqual(fake.answers, ['west'])
  assert.deepEqual(fake.keys, ['\x0b', '2', '\x1b'])
  assert.equal(fake.view, 'parent')
})

test('★★ screen: the last multi-select with the cursor left on the write-in row and the ticks already right is still submitted', async (t) => {
  const qs = [{ question: 'Which colors?', options: ['red', 'blue'], multi: true }]
  const { l, fake, mark, question } = await screenLab(t, qs)
  fake.press('1')
  fake.press('\x1b[B')
  fake.press('\x1b[B')
  fake.keys.length = 0
  assert.equal(fake.cursor, 2)
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [0] }) }, l.deps), { ok: true })
  assert.equal(fake.done, true)
  assert.deepEqual(fake.answers, ['red'])
})

test('★★ screen: a subagent asking the same question as this one makes the answer stop before any key', async (t) => {
  const qs = [{ question: 'Which hill?', options: ['east', 'west'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs, true)
  // a second child asking the very same question
  const iso = (sec: number): string => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const twin = transcriptPathOf(K3, l.deps.home)
  mkdirSync(join(twin, '..'), { recursive: true })
  writeFileSync(
    twin,
    [
      { type: 'SYSTEM_MESSAGE', step_index: 0, created_at: iso(BASE - 30), content: `x\n<SYSTEM_MESSAGE>\n[Message] timestamp=${iso(BASE - 30)} sender=${A} priority=MESSAGE_PRIORITY_HIGH content=twin\n</SYSTEM_MESSAGE>` },
      { type: 'PLANNER_RESPONSE', step_index: 1, created_at: iso(BASE - 30), tool_calls: [{ name: 'ask_question', args: { questions: [{ question: 'Which hill?', options: ['east', 'west'] }] } }] },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  )
  l.setState({ agent_state: 'idle', subagents: [{ name: 'self', role: 'ask', status: 'running' }, { name: 'self', role: 'twin', status: 'running' }] }, BASE)
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [1] }) }, l.deps), { ok: false, reason: 'changed' })
  assert.deepEqual(fake.keys, [])
})

test('★★ screen: the parent busy after a subagent’s answer — left on its view (said so); no ESC while the parent works', async (t) => {
  const qs = [{ question: 'Which hill?', options: ['east', 'west'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs, true)
  l.deps.screenSettleMs = 150
  const kid = transcriptPathOf(K1, l.deps.home)
  const later = setTimeout(() => {
    appendFileSync(kid, JSON.stringify({ type: 'GENERIC', step_index: 2, content: 'A1: west' }) + '\n')
    l.setState({ agent_state: 'working', subagents: [{ name: 'self', role: 'ask', status: 'running' }] }, BASE + 3)
  }, 20)
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [1] }) }, l.deps), { ok: true, left: true })
  clearTimeout(later)
  assert.equal(fake.view, 'child')
  assert.deepEqual(fake.keys, ['\x0b', '2'])
})

test('★★ screen: the PC left on a subagent’s view (nothing open there): the answer goes back first, checks the banner, then opens it', async (t) => {
  const qs = [{ question: 'Which hill?', options: ['east', 'west'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs, true)
  l.deps.screenSettleMs = 150
  // another child's view is on the PC, nothing open in it
  fake.view = 'child'
  fake.childId = K2
  idleChild(l, K2)
  const kid = transcriptPathOf(K1, l.deps.home)
  const recorded = setTimeout(() => appendFileSync(kid, JSON.stringify({ type: 'GENERIC', step_index: 2, content: 'A1: west' }) + '\n'), 50)
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [1] }) }, l.deps), { ok: true })
  clearTimeout(recorded)
  assert.deepEqual(fake.answers, ['west'])
  assert.deepEqual(fake.keys, ['\x1b', '\x0b', '2', '\x1b'])
})

test('★★ screen: back from a subagent’s view, the banner shows another question: nothing opened', async (t) => {
  const qs = [{ question: 'Which hill?', options: ['east', 'west'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs, true)
  l.deps.screenSettleMs = 150
  fake.view = 'child'
  fake.childId = K2
  idleChild(l, K2)
  fake.banner = 'Which lake?'
  // (only the view moved: told as "the card changed")
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [1] }) }, l.deps), { ok: false, reason: 'changed' })
  assert.deepEqual(fake.keys, ['\x1b'])
  assert.equal(fake.view, 'parent')
})

test('★★ screen: the parent’s own question while a subagent runs is answered (the dialog shown is checked)', async (t) => {
  const qs = [{ question: 'Which fruit?', options: ['apple', 'banana'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs)
  l.setState({ agent_state: 'tool_use', subagents: [{ name: 'self', role: 'busy', status: 'running' }] }, BASE)
  // ⚠️ the running child's transcript not found: it may ask the same ⇒ nothing typed
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [1] }) }, l.deps), { ok: false, reason: 'changed' })
  assert.deepEqual(fake.keys, [])
  // read: it runs a command (busy) ⇒ answered
  const iso = (sec: number): string => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const kid = transcriptPathOf(K2, l.deps.home)
  mkdirSync(join(kid, '..'), { recursive: true })
  writeFileSync(
    kid,
    [
      { type: 'SYSTEM_MESSAGE', step_index: 0, created_at: iso(BASE - 30), content: `x\n<SYSTEM_MESSAGE>\n[Message] timestamp=${iso(BASE - 30)} sender=${A} priority=MESSAGE_PRIORITY_HIGH content=busy\n</SYSTEM_MESSAGE>` },
      { type: 'PLANNER_RESPONSE', step_index: 1, created_at: iso(BASE - 30), tool_calls: [{ name: 'run_command', args: { CommandLine: 'make' } }] },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  )
  await new Promise((r) => setTimeout(r, 2100))
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [1] }) }, l.deps), { ok: true })
  assert.deepEqual(fake.answers, ['banana'])
})

test('★★ screen: a key whose meaning the footer does not give is not pressed (a multi-select footer without "space Toggle")', async (t) => {
  const qs = [{ question: 'Which colors?', options: Array.from({ length: 10 }, (_, i) => `c${i + 1}`), multi: true }]
  const { l, fake, mark, question } = await screenLab(t, qs)
  const draw = fake.screen.bind(fake)
  l.deps.readScreen = async () => draw().replace(' · space Toggle', '')
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [9] }) }, l.deps), { ok: false, reason: 'partial' })
  assert.equal(fake.ticks[0]!.some(Boolean), false, 'nothing ticked')
})

test('★★ screen: another subagent’s batch sharing only a later question also stops the answer (its dialog could be the one open)', async (t) => {
  const qs = [
    { question: 'Which hill?', options: ['east', 'west'], multi: false },
    { question: 'Which river?', options: ['a', 'b'], multi: false },
  ]
  const { l, fake, mark, question } = await screenLab(t, qs, true)
  const iso = (sec: number): string => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const twin = transcriptPathOf(K3, l.deps.home)
  mkdirSync(join(twin, '..'), { recursive: true })
  writeFileSync(
    twin,
    [
      { type: 'SYSTEM_MESSAGE', step_index: 0, created_at: iso(BASE - 30), content: `x\n<SYSTEM_MESSAGE>\n[Message] timestamp=${iso(BASE - 30)} sender=${A} priority=MESSAGE_PRIORITY_HIGH content=twin\n</SYSTEM_MESSAGE>` },
      { type: 'PLANNER_RESPONSE', step_index: 1, created_at: iso(BASE - 30), tool_calls: [{ name: 'ask_question', args: { questions: [{ question: 'Which lake?', options: ['x'] }, { question: 'Which river?', options: ['a', 'b'] }] } }] },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  )
  l.setState({ agent_state: 'idle', subagents: [{ name: 'self', role: 'ask', status: 'running' }, { name: 'self', role: 'twin', status: 'running' }] }, BASE)
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [0] }, { indexes: [1] }) }, l.deps), { ok: false, reason: 'changed' })
  assert.deepEqual(fake.keys, [])
})

test('★★ screen: arrows only where the footer says "↑/↓ Navigate"; after the last key the batch must be gone from the screen', async (t) => {
  const qs = [{ question: 'Which number?', options: Array.from({ length: 11 }, (_, i) => `n${i + 1}`), multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs)
  const draw = fake.screen.bind(fake)
  l.deps.readScreen = async () => draw().replace('↑/↓ Navigate · ', '')
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [10] }) }, l.deps), { ok: false, reason: 'changed' })
  assert.deepEqual(fake.keys, [])
  // the dialog left up after the last key with a footer not known: not "gone"
  l.deps.readScreen = async () => {
    const s = draw()
    return fake.done ? 'Question 1/1: Which number?\n  enter Confirm · esc Cancel' : s
  }
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [10] }) }, l.deps), { ok: false, reason: 'partial' })
})

test('★★ screen: a sibling batch the phone does not take (duplicate options) still counts as a twin of this question', async (t) => {
  const qs = [{ question: 'Which hill?', options: ['east', 'west'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs, true)
  const iso = (sec: number): string => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const twin = transcriptPathOf(K3, l.deps.home)
  mkdirSync(join(twin, '..'), { recursive: true })
  writeFileSync(
    twin,
    [
      { type: 'SYSTEM_MESSAGE', step_index: 0, created_at: iso(BASE - 30), content: `x\n<SYSTEM_MESSAGE>\n[Message] timestamp=${iso(BASE - 30)} sender=${A} priority=MESSAGE_PRIORITY_HIGH content=twin\n</SYSTEM_MESSAGE>` },
      { type: 'PLANNER_RESPONSE', step_index: 1, created_at: iso(BASE - 30), tool_calls: [{ name: 'ask_question', args: { questions: [{ question: 'Which hill?', options: ['east', 'west'] }, { question: 'Again?', options: ['y', 'y'] }] } }] },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  )
  l.setState({ agent_state: 'idle', subagents: [{ name: 'self', role: 'ask', status: 'running' }, { name: 'self', role: 'twin', status: 'running' }] }, BASE)
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [1] }) }, l.deps), { ok: false, reason: 'changed' })
  assert.deepEqual(fake.keys, [])
})

test('★★ screen: after a subagent’s answer, ESC only on that child’s view (another child’s view shown ⇒ left, said so)', async (t) => {
  const qs = [{ question: 'Which hill?', options: ['east', 'west'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs, true)
  l.deps.screenSettleMs = 150
  fake.banner = 'Which hill?'
  // the PC person switched to another child's view right after the answer
  const draw = fake.screen.bind(fake)
  l.deps.readScreen = async () => (fake.done ? draw().replace(K1, K2) : draw())
  const kid = transcriptPathOf(K1, l.deps.home)
  const recorded = setTimeout(() => appendFileSync(kid, JSON.stringify({ type: 'GENERIC', step_index: 2, content: 'A1: west' }) + '\n'), 20)
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [1] }) }, l.deps), { ok: true, left: true })
  clearTimeout(recorded)
  assert.deepEqual(fake.keys, ['\x0b', '2'])
})

test('★★ screen: ctrl+k opening another child’s dialog (its id in the header) takes no answer', async (t) => {
  const qs = [{ question: 'Which hill?', options: ['east', 'west'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs, true)
  l.deps.screenSettleMs = 150
  fake.banner = 'Which hill?'
  fake.askingChild = K2
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [1] }) }, l.deps), { ok: false, reason: 'partial' })
  assert.deepEqual(fake.keys, ['\x0b'])
  assert.equal(fake.done, false, 'nothing answered')
})

test('★★ screen: a written answer only into an empty field (what the PC left typed there would be added to)', async (t) => {
  const qs = [{ question: 'Which fruit?', options: ['apple', 'banana'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs)
  l.deps.screenSettleMs = 150
  // the PC opened the field, typed, and went back
  fake.press('3')
  fake.press('x')
  fake.press('\x1b')
  fake.keys.length = 0
  const res = await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [], note: 'pear' }) }, l.deps)
  assert.equal(res.ok, false)
  assert.ok(!fake.keys.includes('pear'), 'the note was not typed')
  assert.equal(fake.done, false)
})

test('★★ screen: a multi-select drawn without its ticks (a future agy) is not read, so no option is toggled', async (t) => {
  const qs = [{ question: 'Which colors?', options: ['red', 'blue'], multi: true }]
  const { l, fake, mark, question } = await screenLab(t, qs)
  l.deps.screenSettleMs = 150
  const draw = fake.screen.bind(fake)
  l.deps.readScreen = async () => draw().replace(/\[[ x]\] /g, '')
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [1] }) }, l.deps), { ok: false, reason: 'changed' })
  assert.deepEqual(fake.keys, [])
})

test('★★ screen: a retry after the Enter of a written answer never came: the same text left in the field is only submitted', async (t) => {
  const qs = [{ question: 'Which fruit?', options: ['apple', 'banana'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs)
  // the earlier try: field opened, note typed, then left (ESC back) without Enter
  fake.press('3')
  for (const ch of ['pear']) fake.press(ch)
  fake.press('\x1b')
  fake.keys.length = 0
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [], note: 'pear' }) }, l.deps), { ok: true })
  assert.deepEqual(fake.answers, ['pear'])
  assert.ok(!fake.keys.includes('pear'), 'not typed again')
})

test('★ screen: a long written answer whose field shows only its end is submitted once that end is shown', async (t) => {
  const qs = [{ question: 'Which fruit?', options: ['apple', 'banana'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs)
  const note = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ')
  const draw = fake.screen.bind(fake)
  // as agy draws the field: wrapped at words to 40 columns, the last 3 rows shown
  l.deps.readScreen = async () => draw().replace(/(  Your answer:\n  )(.*)\n/, (_m, a: string, f: string) => `${a}${fieldRows(f, 40, 3).join('\n  ')}\n`)
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [], note }) }, l.deps), { ok: true })
  assert.deepEqual(fake.answers, [note])
})

test('★ a running child whose transcript cannot be read now: its question is not known (no screen answer while so)', async (t) => {
  const l = await lab(t)
  withChildren(l, [
    { id: K1, prompt: 'p1', asking: true },
    { id: K2, prompt: 'p2', asking: true },
  ])
  const { agyChildQuestions } = await import('./sessions.ts')
  const kid2 = transcriptPathOf(K2, l.deps.home)
  const blind = (path: string) => (path === kid2 ? [] : readTailRecords(path))
  assert.equal(agyChildQuestions({ activeSubagentRoles: ['p1', 'p2'] }, A, l.deps.home, blind).known, false)
  assert.equal(agyChildQuestions({ activeSubagentRoles: ['p1', 'p2'] }, A, l.deps.home).known, true)
})

test('★★ screen: a field with room shows the whole text: a note agy changed (a dropped "ß") is not submitted', async (t) => {
  const qs = [{ question: 'Which fruit?', options: ['apple', 'banana'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs)
  l.deps.screenSettleMs = 150
  const note = 'ß stands for the German sharp s in this spelling example'
  const draw = fake.screen.bind(fake)
  l.deps.readScreen = async () => draw().replace('ß', '')
  const res = await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [], note }) }, l.deps)
  assert.deepEqual(res, { ok: false, reason: 'partial' })
  assert.equal(fake.done, false, 'no Enter')
})

test('★★ screen: a draft left in the field that differs only in spaces is not taken for the note', async (t) => {
  const qs = [{ question: 'Which fruit?', options: ['apple', 'banana'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs)
  l.deps.screenSettleMs = 150
  fake.press('3')
  fake.press('Use build cache')
  fake.press('\x1b')
  fake.keys.length = 0
  const res = await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [], note: 'Use buildcache' }) }, l.deps)
  assert.equal(res.ok, false)
  assert.equal(fake.done, false)
})

test('★★ screen: a long note is checked piece by piece — a character agy drops early (later scrolled away) stops it', async (t) => {
  const qs = [{ question: 'Which fruit?', options: ['apple', 'banana'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs)
  l.deps.screenSettleMs = 150
  const note = `Straße ${Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')}`
  const draw = fake.screen.bind(fake)
  l.deps.readScreen = async () => draw().replace(/(  Your answer:\n  )(.*)\n/, (_m, a: string, f: string) => `${a}${fieldRows(f.replace('ß', ''), 40, 3).join('\n  ')}\n`)
  const res = await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [], note }) }, l.deps)
  assert.deepEqual(res, { ok: false, reason: 'partial' })
  assert.equal(fake.done, false)
  assert.equal(fake.keys.filter((k) => k.length > 1 && !k.startsWith('\x1b')).length, 1, 'only the first piece typed')
})

test('★★ screen: arrows go one at a time, each seen; the dialog unreadable after one stops the rest', async (t) => {
  const qs = [{ question: 'Which number?', options: Array.from({ length: 20 }, (_, i) => `n${i + 1}`), multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs)
  l.deps.screenSettleMs = 150
  const draw = fake.screen.bind(fake)
  l.deps.readScreen = async () => (fake.keys.length > 0 ? 'Question 1/1: Which number?\n(resized)' : draw())
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [15] }) }, l.deps), { ok: false, reason: 'partial' })
  assert.deepEqual(fake.keys, ['\x1b[B'])
})

test('★ screen: a full field showing the note may hold more above it: not taken as the earlier try', async (t) => {
  const qs = [{ question: 'Which fruit?', options: ['apple', 'banana'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs)
  l.deps.screenSettleMs = 150
  const note = Array.from({ length: 15 }, (_, i) => `word${i}`).join(' ')
  const draw = fake.screen.bind(fake)
  l.deps.readScreen = async () => draw().replace(/(  Your answer:\n  )(.*)\n/, (_m, a: string, f: string) => `${a}${fieldRows(f, 40, 3).join('\n  ')}\n`)
  // the PC's draft: something more, then exactly the note (the field shows only its last 3 rows)
  fake.press('3')
  fake.press(`${'x'.repeat(40)} ${note}`)
  fake.press('\x1b')
  fake.keys.length = 0
  const res = await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [], note }) }, l.deps)
  assert.equal(res.ok, false)
  assert.equal(fake.done, false)
})

test('★★ screen: a Japanese note wrapped between two characters (no space at the row boundary) is seen and submitted', async (t) => {
  const qs = [{ question: 'Which fruit?', options: ['apple', 'banana'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs)
  const note = '既存のキャッシュは消さずに新しい設定ファイルだけを追加してテストを実行してください。それから結果を教えてください。'
  const draw = fake.screen.bind(fake)
  // agy wraps CJK text by width: 19 characters a row here, the last 3 rows shown
  const cjkRows = (f: string): string[] => (Array.from(f).join('').match(/.{1,19}/gu) ?? []).slice(-3)
  l.deps.readScreen = async () => draw().replace(/(  Your answer:\n  )(.*)\n/, (_m, a: string, f: string) => `${a}${cjkRows(f).join('\n  ')}\n`)
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [], note }) }, l.deps), { ok: true })
  assert.deepEqual(fake.answers, [note])
})

test('★ screen: a note with characters special in patterns (. * ? ( ) [ ] \\) is matched as text', async (t) => {
  const qs = [{ question: 'Which fruit?', options: ['apple', 'banana'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs)
  const note = 'use a.b* (or c?) [d] \\e $f ^g {h} |i'
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [], note }) }, l.deps), { ok: true })
  assert.deepEqual(fake.answers, [note])
})

test('★ screen: a draft that differs only in how many spaces is not taken for the note', async (t) => {
  const qs = [{ question: 'Which fruit?', options: ['apple', 'banana'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs)
  l.deps.screenSettleMs = 150
  fake.press('3')
  fake.press('Assert value === "a b"')
  fake.press('\x1b')
  fake.keys.length = 0
  const res = await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [], note: 'Assert value === "a  b"' }) }, l.deps)
  assert.equal(res.ok, false)
  assert.equal(fake.done, false)
})


test('★ screen: back from a subagent’s view, the parent’s view is waited for (agy redraws after the key)', async (t) => {
  const qs = [{ question: 'Which hill?', options: ['east', 'west'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs, true)
  l.deps.screenSettleMs = 300
  fake.view = 'child'
  fake.childId = K2
  idleChild(l, K2)
  const draw = fake.screen.bind(fake)
  // the first look after the ESC still shows the child's view
  let stale: string | undefined
  l.deps.readScreen = async () => {
    if (fake.keys.length === 1 && stale === undefined) {
      stale = 'x'
      fake.view = 'child'
      const old = draw()
      fake.view = 'parent'
      return old
    }
    return draw()
  }
  const kid = transcriptPathOf(K1, l.deps.home)
  const recorded = setTimeout(() => appendFileSync(kid, JSON.stringify({ type: 'GENERIC', step_index: 2, content: 'A1: west' }) + '\n'), 50)
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [1] }) }, l.deps), { ok: true })
  clearTimeout(recorded)
  assert.deepEqual(fake.answers, ['west'])
})

test('★★ screen: before going back from a subagent’s view, the slow probes run first; the viewed child starting to ask meanwhile stops it', async (t) => {
  const qs = [{ question: 'Which hill?', options: ['east', 'west'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs, true)
  l.deps.screenSettleMs = 150
  fake.view = 'child'
  fake.childId = K2
  const iso = (sec: number): string => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const viewed = transcriptPathOf(K2, l.deps.home)
  mkdirSync(join(viewed, '..'), { recursive: true })
  writeFileSync(viewed, JSON.stringify({ type: 'SYSTEM_MESSAGE', step_index: 0, created_at: iso(BASE - 30), content: 'x' }) + '\n')
  // right after the first look: the viewed child asks (its dialog not drawn yet)
  const draw = fake.screen.bind(fake)
  let looks = 0
  l.deps.readScreen = async () => {
    if (++looks === 1) appendFileSync(viewed, JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 1, created_at: iso(BASE), tool_calls: [{ name: 'ask_question', args: { questions: [{ question: 'Other?', options: ['y'] }] } }] }) + '\n')
    return draw()
  }
  const res = await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [1] }) }, l.deps)
  assert.deepEqual(res, { ok: false, reason: 'changed' })
  assert.deepEqual(fake.keys, [])
  assert.equal(fake.view, 'child')
})

test('★★ screen: a write-in stopped after its first piece is finished on the retry (the field shows that piece)', async (t) => {
  const qs = [{ question: 'Which fruit?', options: ['apple', 'banana'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs)
  const note = 'the first forty characters go in first, and then the rest of the note follows'
  const first = Array.from(note).slice(0, 40).join('')
  // the earlier try: the field opened, the first piece typed, then it stopped (and left the field)
  fake.press('3')
  fake.press(first)
  fake.press('\x1b')
  fake.keys.length = 0
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [], note }) }, l.deps), { ok: true })
  assert.deepEqual(fake.answers, [note])
  assert.ok(!fake.keys.includes(first), 'the first piece not typed again')
})

test('★★ screen: a dialog opening in the viewed child’s view during the slow probes is seen (the screen is read after them)', async (t) => {
  const qs = [{ question: 'Which hill?', options: ['east', 'west'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs, true)
  l.deps.screenSettleMs = 150
  fake.view = 'child'
  fake.childId = K2
  const draw = fake.screen.bind(fake)
  let looked = false
  l.deps.readScreen = async () => ((looked = true), draw())
  const locks = l.deps.locksOf!
  l.deps.locksOf = (p: number) => {
    // the viewed child's dialog opens while the probes run (after the first look)
    if (looked && !fake.open) {
      fake.open = true
      fake.dialogView = 'child'
    }
    return locks(p)
  }
  const res = await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [1] }) }, l.deps)
  assert.equal(res.ok, false)
  assert.ok(!fake.keys.includes('\x1b'), `no ESC into that dialog: ${JSON.stringify([res, fake.keys])}`)
})

test('★★ screen: the viewed child with a command pending (its approval may be about to be drawn): no ESC there', async (t) => {
  const qs = [{ question: 'Which hill?', options: ['east', 'west'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs, true)
  l.deps.screenSettleMs = 150
  fake.view = 'child'
  fake.childId = K2
  const p = transcriptPathOf(K2, l.deps.home)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, [{ type: 'SYSTEM_MESSAGE', step_index: 0, content: 'x' }, { type: 'PLANNER_RESPONSE', step_index: 1, tool_calls: [{ name: 'run_command', args: { CommandLine: 'make' } }] }].map((r) => JSON.stringify(r)).join('\n') + '\n')
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [1] }) }, l.deps), { ok: false, reason: 'changed' })
  assert.deepEqual(fake.keys, [])
})

/** The pane says the relay shows the screen; the screen is a subagent's view until an ESC came, then the parent's */
function childViewUntilEsc(l: Lab, child: string): void {
  const pane = join(l.root, 'panes', `${PID}.json`)
  writeFileSync(pane, JSON.stringify({ ...JSON.parse(readFileSync(pane, 'utf8')), screen: true }))
  const view = ['  main › self', '  ● running', `  ID: ${child}`, '', '  ↑/↓ scroll · ctrl+home top', '  ctrl+o expand · shift+k kill · esc back', '   Gemini 4 Neon · high'].join('\n')
  // (agy's parent view, its input box between two rules)
  l.deps.readScreen = async () => (l.got.some((x) => x.includes('\x1b')) ? ['  ok', '─'.repeat(60), '>', '─'.repeat(60), '? for shortcuts'].join('\n') : view)
  l.deps.screenSettleMs = 300
}

test('★★ send: the PC left on a (finished) subagent’s view: back to the parent’s view first, then the message', async (t) => {
  const l = await lab(t)
  idleChild(l, K2)
  childViewUntilEsc(l, K2)
  const res = await sendToAgy(A, 'hello there', l.deps)
  assert.equal(res.ok, true, res.message)
  await settle()
  assert.deepEqual(l.got, ['\x1b', 'hello there \r'])
})

test('★★ send / stop: a subagent’s view whose child has something pending is not left: nothing typed, said why', async (t) => {
  const l = await lab(t)
  const p = transcriptPathOf(K2, l.deps.home)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, [{ type: 'SYSTEM_MESSAGE', step_index: 0, content: 'x' }, { type: 'PLANNER_RESPONSE', step_index: 1, tool_calls: [{ name: 'run_command', args: { CommandLine: 'make' } }] }].map((r) => JSON.stringify(r)).join('\n') + '\n')
  childViewUntilEsc(l, K2)
  assert.equal((await sendToAgy(A, 'hello', l.deps)).reason, 'child-view')
  l.setState({ agent_state: 'working' })
  assert.equal((await stopAgy(A, l.deps)).reason, 'child-view')
  await settle()
  assert.deepEqual(l.got, [])
})

test('★★ stop: on a (finished) subagent’s view, back to the parent’s view first, then the stop', async (t) => {
  const l = await lab(t)
  idleChild(l, K2)
  childViewUntilEsc(l, K2)
  l.setState({ agent_state: 'working' })
  stopsAfter(l, 2)
  const res = await stopAgy(A, l.deps)
  assert.equal(res.ok, true, res.message)
  await settle()
  assert.deepEqual(l.got, ['\x1b', '\x1b'])
})

test('★★ while an answer from the phone is being typed, a send or a stop for that agy is refused at once (not queued)', async (t) => {
  const qs = [{ question: 'Which fruit?', options: ['apple', 'banana'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs)
  const draw = fake.screen.bind(fake)
  l.deps.readScreen = async () => (await new Promise((r) => setTimeout(r, 200)), draw())
  const answer = answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [1] }) }, l.deps)
  await new Promise((r) => setTimeout(r, 20))
  const at = Date.now()
  assert.equal((await sendToAgy(A, 'hello', l.deps)).reason, 'answering')
  assert.equal((await stopAgy(A, l.deps)).reason, 'answering')
  assert.ok(Date.now() - at < 100, 'at once')
  assert.deepEqual(await answer, { ok: true })
})

test('★ send: the parent starting to work after the screen was read: no ESC (checked right before the key)', async (t) => {
  const l = await lab(t)
  idleChild(l, K2)
  childViewUntilEsc(l, K2)
  const read = l.deps.readScreen!
  l.deps.readScreen = async (p) => {
    const s = await read(p)
    l.setState({ agent_state: 'working' })
    return s
  }
  assert.equal((await sendToAgy(A, 'hello', l.deps)).ok, false)
  await settle()
  assert.equal(l.got.join(''), '', 'nothing typed')
})

test('★★ screen: the parent’s own question while the PC shows a (finished) subagent’s view: back first, then its dialog', async (t) => {
  const qs = [{ question: 'Which fruit?', options: ['apple', 'banana'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs)
  idleChild(l, K2)
  fake.view = 'child'
  fake.childId = K2
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [1] }) }, l.deps), { ok: true })
  assert.deepEqual(fake.keys, ['\x1b', '2'])
  assert.deepEqual(fake.answers, ['banana'])
})

test('★★ send / stop: a subagent’s header with its footer clipped (a resize mid-redraw) is a subagent’s view, not the parent’s', async (t) => {
  const l = await lab(t)
  idleChild(l, K2)
  childViewUntilEsc(l, K2)
  const clipped = ['  main › self', '  ● running', `  ID: ${K2}`, '', '  ↑/↓ scroll · ctrl+home top'].join('\n')
  l.deps.readScreen = async () => clipped
  assert.equal((await sendToAgy(A, 'hello', l.deps)).reason, 'child-view')
  l.setState({ agent_state: 'working' })
  assert.equal((await stopAgy(A, l.deps, () => Date.now() + 1e7)).reason, 'child-view')
  await settle()
  assert.equal(l.got.join(''), '')
})

test('★★ a card answered while the PC shows a (finished) subagent’s view: back to the parent’s view first, then the key', async (t) => {
  const l = await lab(t)
  const call = { name: 'run_command', args: { CommandLine: 'ls -la' } }
  appendFileSync(l.transcript, JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: new Date((BASE - 60) * 1000).toISOString(), tool_calls: [call] }) + '\n')
  utimesSync(l.transcript, BASE - 50, BASE - 50)
  l.setState({ agent_state: 'tool_use', tool_confirmation_pending: true })
  l.deps.answerSettleMs = 0
  idleChild(l, K2)
  childViewUntilEsc(l, K2)
  const mark = { pid: PID, stateMtimeMs: BASE * 1000, step: 1, index: 0, callAt: (BASE - 60) * 1000 }
  assert.deepEqual(await answerAgyCard(A, mark, 'allow', l.deps), { ok: true })
  await settle()
  assert.deepEqual(l.got, ['\x1b', '1'])
})

test('★ send: after the ESC, a screen still headed by the child (its footer gone) is not the parent’s view', async (t) => {
  const l = await lab(t)
  idleChild(l, K2)
  childViewUntilEsc(l, K2)
  const before = await l.deps.readScreen!('')
  const clipped = ['  main › self', '  ● running', `  ID: ${K2}`, '', '  ↑/↓ scroll'].join('\n')
  l.deps.readScreen = async () => (l.got.some((x) => x.includes('\x1b')) ? clipped : before)
  assert.equal((await sendToAgy(A, 'hello', l.deps)).reason, 'child-view')
  await settle()
  assert.deepEqual(l.got, ['\x1b'])
})

test('★ a card answered while the PC shows a subagent’s view that cannot be left (its child has a call pending): nothing typed', async (t) => {
  const l = await lab(t)
  const call = { name: 'run_command', args: { CommandLine: 'ls -la' } }
  appendFileSync(l.transcript, JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: new Date((BASE - 60) * 1000).toISOString(), tool_calls: [call] }) + '\n')
  utimesSync(l.transcript, BASE - 50, BASE - 50)
  l.setState({ agent_state: 'tool_use', tool_confirmation_pending: true })
  l.deps.answerSettleMs = 0
  const p = transcriptPathOf(K2, l.deps.home)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, [{ type: 'SYSTEM_MESSAGE', step_index: 0, content: 'x' }, { type: 'PLANNER_RESPONSE', step_index: 1, tool_calls: [{ name: 'run_command', args: { CommandLine: 'make' } }] }].map((r) => JSON.stringify(r)).join('\n') + '\n')
  childViewUntilEsc(l, K2)
  const mark = { pid: PID, stateMtimeMs: BASE * 1000, step: 1, index: 0, callAt: (BASE - 60) * 1000 }
  assert.deepEqual(await answerAgyCard(A, mark, 'allow', l.deps), { ok: false, reason: 'changed' })
  await settle()
  assert.equal(l.got.join(''), '')
})

test('★ send: going back from a subagent’s view adds no lock probe (a Mac’s lsof per check adds up past the phone’s wait)', async (t) => {
  const count = async (child: boolean): Promise<number> => {
    const l = await lab(t)
    if (child) {
      idleChild(l, K2)
      childViewUntilEsc(l, K2)
    }
    const locks = l.deps.locksOf!
    let n = 0
    l.deps.locksOf = (p: number) => (n++, locks(p))
    assert.equal((await sendToAgy(A, 'hello', l.deps)).ok, true)
    return n
  }
  assert.equal(await count(true), await count(false))
})

/** A relay that shows agy's parent view: the box holds `draft`, and after "/compact" is typed the list shows it picked */
function compactScreen(l: Lab, draft = '', picked = true): void {
  const pane = join(l.root, 'panes', `${PID}.json`)
  writeFileSync(pane, JSON.stringify({ ...JSON.parse(readFileSync(pane, 'utf8')), screen: true }))
  const RULE = '─'.repeat(60)
  l.deps.screenSettleMs = 200
  l.deps.readScreen = async () => {
    // (Ctrl-U clears the box and closes the list)
    const all = l.got.join('')
    const typed = all.includes('/compact') && !all.endsWith('\x15')
    const box = typed ? `> ${draft}/compact` : draft ? `> ${draft}` : '>'
    const list = typed && picked ? ['> /compact  Compact the conversation now (summarize history to free up the context window)', '  ↑/↓ Navigate · enter Select · tab Complete'] : []
    return ['  ok', RULE, box, RULE, ...list, '? for shortcuts      auto · Gemini 4 Neon · high'].join('\n')
  }
  const written: string[] = []
  l.deps.openKeyLine = async () => ({
    write: async (bytes, refuse) => {
      if (refuse?.()) return false
      written.push(bytes)
      l.got.push(bytes)
      return true
    },
    close: () => undefined,
  })
}

test('★★ compact: "/compact" typed into the empty box, Enter only once the list shows it picked', async (t) => {
  const l = await lab(t)
  compactScreen(l)
  const res = await compactAgy(A, l.deps, () => Date.now() + 1e7)
  assert.equal(res.ok, true, res.message)
  assert.deepEqual(l.got, ['/compact', '\r'])
  // ⚠️ a second press right after: refused (a double tap must not type it into the running compaction)
  assert.equal((await compactAgy(A, l.deps, () => Date.now() + 1e7)).reason, 'too-soon')
})

test('★★ compact refused, nothing typed: a draft in the box, an older relay, agy working, the list not showing it', async (t) => {
  const l = await lab(t)
  compactScreen(l, 'abc')
  const later = (n: number) => () => Date.now() + n * 1e7
  assert.equal((await compactAgy(A, l.deps, later(2))).reason, 'draft')
  assert.deepEqual(l.got, [])
  // an older relay (no screen)
  const pane = join(l.root, 'panes', `${PID}.json`)
  writeFileSync(pane, JSON.stringify({ ...JSON.parse(readFileSync(pane, 'utf8')), screen: false }))
  assert.equal((await compactAgy(A, l.deps, later(3))).reason, 'no-screen')
  // working
  compactScreen(l)
  l.setState({ agent_state: 'working' })
  assert.equal((await compactAgy(A, l.deps, later(4))).reason, 'busy')
  assert.deepEqual(l.got, [])
  // the list never shows it picked (a narrow terminal wraps it): no Enter, and "/compact" taken out of the box again
  l.setState({})
  compactScreen(l, '', false)
  assert.equal((await compactAgy(A, l.deps, later(5))).reason, 'unsure')
  assert.deepEqual(l.got, ['/compact', '\x15'])
})

test('★★ compact: past its deadline (the phone gave up at 10 s) nothing more is typed; "/compact" taken back if it was', async (t) => {
  const l = await lab(t)
  compactScreen(l)
  l.deps.compactDeadlineMs = 0
  // ⚠️ past it in the queue: not even the screen read (codex review)
  let looked = 0
  const seen = l.deps.readScreen!
  l.deps.readScreen = async (p) => (looked++, seen(p))
  assert.equal((await compactAgy(A, l.deps, () => Date.now() + 6e7)).reason, 'unsure')
  assert.deepEqual(l.got, [])
  assert.equal(looked, 0)
  // the deadline passing while the list is awaited: no Enter, the box cleared
  compactScreen(l)
  l.deps.compactDeadlineMs = 60
  const read = l.deps.readScreen!
  l.deps.readScreen = async (p) => (l.got.length > 0 && (await new Promise((r) => setTimeout(r, 80))), read(p))
  assert.equal((await compactAgy(A, l.deps, () => Date.now() + 7e7)).reason, 'unsure')
  assert.deepEqual(l.got, ['/compact', '\x15'])
})

test('★ compact: stopped with more than "/compact" in the box (the PC person typed): it is not cleared (theirs too)', async (t) => {
  const l = await lab(t)
  compactScreen(l, '', false)
  const RULE = '─'.repeat(60)
  l.deps.readScreen = async () => ['  ok', RULE, l.got.length > 0 ? '> /compact and more' : '>', RULE, '? for shortcuts'].join('\n')
  assert.equal((await compactAgy(A, l.deps, () => Date.now() + 8e7)).reason, 'partial')
  assert.deepEqual(l.got, ['/compact'])
})

test('★ compact: one lock probe for both keys (a Mac’s lsof per key used up the deadline)', async (t) => {
  const count = async (compact: boolean): Promise<number> => {
    const l = await lab(t)
    compactScreen(l)
    const locks = l.deps.locksOf!
    let n = 0
    l.deps.locksOf = (p: number) => (n++, locks(p))
    if (compact) assert.equal((await compactAgy(A, l.deps, () => Date.now() + 9e7 + Math.random())).ok, true)
    else assert.equal((await sendToAgy(A, 'hello', l.deps)).ok, true)
    return n
  }
  // the target, the gate, then one probe for both keys (a send: the target, the gate, before the body, before Enter)
  assert.equal(await count(true), 3)
  assert.equal(await count(false), 4)
})

test('★★ compact: agy stalled (the box still empty after "/compact" was sent): Ctrl-U still goes after it, clearing it when agy takes them', async (t) => {
  const l = await lab(t)
  compactScreen(l)
  const RULE = '─'.repeat(60)
  // agy never shows what was typed (stalled)
  l.deps.readScreen = async () => ['  ok', RULE, '>', RULE, '? for shortcuts'].join('\n')
  assert.equal((await compactAgy(A, l.deps, () => Date.now() + 1e8)).reason, 'unsure')
  assert.deepEqual(l.got, ['/compact', '\x15'])
})

test('★★ compact: the box pushed off a short pane by the list (not readable): the Ctrl-U still goes after "/compact"', async (t) => {
  const l = await lab(t)
  compactScreen(l)
  const RULE = '─'.repeat(60)
  // before typing: the box empty; after: the list fills the pane, the box's rules are gone
  l.deps.readScreen = async () =>
    l.got.length === 0 ? ['  ok', RULE, '>', RULE, '? for shortcuts'].join('\n') : ['> /compact', '> /compact  Compact the conversation now (summarize', '  ↑/↓ Navigate · enter Select'].join('\n')
  assert.equal((await compactAgy(A, l.deps, () => Date.now() + 2e8)).reason, 'partial')
  assert.deepEqual(l.got, ['/compact', '\x15'])
})

/** The pane says the relay shows the screen; the screen is `screen` */
function withScreenPane(l: Lab, screen: () => string): void {
  const pane = join(l.root, 'panes', `${PID}.json`)
  writeFileSync(pane, JSON.stringify({ ...JSON.parse(readFileSync(pane, 'utf8')), screen: true }))
  l.deps.readScreen = async () => screen()
  l.deps.screenSettleMs = 200
}
const RULE60 = '─'.repeat(60)
const parentView = (extra: string[] = []): string => ['  hi', ...extra, RULE60, '>', RULE60, '  ● Agent(self: Runner)  Generating · 9s', '? for shortcuts      Gemini 4 Neon · high · 1 subagent(s)'].join('\n')

test('★★ send / stop while a subagent runs: through a relay showing the parent’s view (input box, nothing open)', async (t) => {
  const l = await lab(t)
  const kids = { subagents: [{ name: 'self', role: 'run', status: 'running' }] }
  l.setState(kids)
  withScreenPane(l, () => parentView())
  const res = await sendToAgy(A, 'hello there', l.deps)
  assert.equal(res.ok, true, res.message)
  await settle()
  assert.deepEqual(l.got, ['hello there \r'])
  // (a child's banner on the parent's view is fine: text goes to the parent's prompt)
  l.got.length = 0
  withScreenPane(l, () => parentView([' ┃ self has a question', ' ┃ ? Which hill?', ' ┃ ctrl+k answer · alt+j manage']))
  assert.equal((await sendToAgy(A, 'again', l.deps)).ok, true)
  // stop: the parent working, ESC once (it stops the parent's turn only)
  l.got.length = 0
  l.setState({ agent_state: 'working', ...kids })
  withScreenPane(l, () => parentView())
  stopsAfter(l, 1)
  const stop = await stopAgy(A, l.deps, () => Date.now() + 3e8)
  assert.equal(stop.ok, true, stop.message)
  await settle()
  assert.deepEqual(l.got, ['\x1b'])
})

test('★★ send / stop while a subagent runs: refused when the screen is not the parent’s ready view, or not readable', async (t) => {
  const l = await lab(t)
  const kids = { subagents: [{ name: 'self', role: 'run', status: 'running' }] }
  l.setState(kids)
  // an older relay (no screen)
  assert.equal((await sendToAgy(A, 'hello', l.deps)).reason, 'subagent')
  // a subagent's question open on the PC (its view, a dialog)
  withScreenPane(l, () => ['  main › self', '  ● running', `  ID: ${K2}`, '', 'Question 1/1: Which hill?', '> 1. east', '  2. west', '  3. Write-in...', '  ↑/↓ Navigate · enter Select · esc Skip'].join('\n'))
  assert.equal((await sendToAgy(A, 'hello', l.deps)).ok, false)
  // a dialog drawn while the input box still shows (whatever it is: text would go to it)
  withScreenPane(l, () => parentView(['Question 1/1: Which hill?', '> 1. east', '  2. Write-in...', '  ↑/↓ Navigate · enter Select · esc Skip']))
  assert.equal((await sendToAgy(A, 'hello', l.deps)).reason, 'subagent')
  // the parent's view without its input box (an overlay)
  withScreenPane(l, () => ['  hi', '  something drawn over it', '? for shortcuts'].join('\n'))
  assert.equal((await sendToAgy(A, 'hello', l.deps)).reason, 'subagent')
  l.setState({ agent_state: 'working', ...kids })
  assert.equal((await stopAgy(A, l.deps, () => Date.now() + 4e8)).reason, 'subagent')
  await settle()
  assert.equal(l.got.join(''), '')
})

test('★ send while a subagent runs adds no lock probe', async (t) => {
  const count = async (kids: boolean): Promise<number> => {
    const l = await lab(t)
    if (kids) l.setState({ subagents: [{ name: 'self', role: 'run', status: 'running' }] })
    withScreenPane(l, () => parentView())
    const locks = l.deps.locksOf!
    let n = 0
    l.deps.locksOf = (p: number) => (n++, locks(p))
    assert.equal((await sendToAgy(A, 'hello', l.deps)).ok, true)
    return n
  }
  // (one probe made before the screen read serves the checks right before each key)
  assert.ok((await count(true)) <= (await count(false)))
})

test('★★ stop while a subagent runs: the lock probe comes before the screen read (a card opening during it is seen)', async (t) => {
  const l = await lab(t)
  const kids = { subagents: [{ name: 'self', role: 'run', status: 'running' }] }
  l.setState({ agent_state: 'working', ...kids })
  let card = false
  withScreenPane(l, () => (card ? ['  hi', 'Command', 'Run this command?', '> 1. Yes, run command', '  4. No, cancel', '  ↑/↓ Navigate · tab Amend', 'esc to cancel'].join('\n') : parentView()))
  const locks = l.deps.locksOf!
  // the parent opens a command approval while the lock probe runs (its status file not rewritten yet)
  let n = 0
  l.deps.locksOf = (p: number) => (++n === 3 && (card = true), locks(p))
  assert.equal((await stopAgy(A, l.deps, () => Date.now() + 5e8)).reason, 'subagent')
  await settle()
  assert.equal(l.got.join(''), '')
})

test('★★ send: a draft in the PC’s box starting like a command ("/", "!", "?") refuses the send (it would run joined to it)', async (t) => {
  const l = await lab(t)
  for (const draft of ['/', '/ex', '!', '?', '\u200b/exit']) {
    withScreenPane(l, () => ['  hi', RULE60, `> ${draft}`, RULE60, '? for shortcuts'].join('\n'))
    assert.equal((await sendToAgy(A, 'exit the test container', l.deps)).reason, 'draft', draft)
  }
  // with subagents running too
  l.setState({ subagents: [{ name: 'self', role: 'run', status: 'running' }] })
  withScreenPane(l, () => ['  hi', RULE60, '> /', RULE60, '? for shortcuts'].join('\n'))
  assert.equal((await sendToAgy(A, 'exit', l.deps)).reason, 'draft')
  await settle()
  assert.equal(l.got.join(''), '')
  // an ordinary draft is joined as before (as for Claude)
  l.setState({})
  withScreenPane(l, () => ['  hi', RULE60, '> abc', RULE60, '? for shortcuts'].join('\n'))
  assert.equal((await sendToAgy(A, 'more', l.deps)).ok, true)
})

test('★★ send: the input box not readable as one row (a wrapped draft, the slash list pushing it off a short pane): refused', async (t) => {
  const l = await lab(t)
  // a short pane: "/" typed on the PC, the list pushed the box's rules off
  withScreenPane(l, () => ['> /', '> /compact  Compact the conversation now (summarize', '  ↑/↓ Navigate · enter Select'].join('\n'))
  assert.equal((await sendToAgy(A, 'exit the test container', l.deps)).reason, 'draft')
  // a draft wrapped onto a second row
  withScreenPane(l, () => ['  hi', RULE60, '> !rm -rf build && make', '  && make test', RULE60, '? for shortcuts'].join('\n'))
  assert.equal((await sendToAgy(A, 'go', l.deps)).reason, 'draft')
  await settle()
  assert.equal(l.got.join(''), '')
})

test('★ send: the screen readable at the first look but not when the draft is checked: refused (nothing typed)', async (t) => {
  const l = await lab(t)
  let looks = 0
  withScreenPane(l, () => ['  hi', RULE60, '>', RULE60, '? for shortcuts'].join('\n'))
  const read = l.deps.readScreen!
  l.deps.readScreen = async (p) => (++looks === 1 ? read(p) : undefined)
  assert.equal((await sendToAgy(A, 'hello', l.deps)).reason, 'draft')
  await settle()
  assert.equal(l.got.join(''), '')
})


test('★★ stop: told as stopped only once agy leaves "working"; an ESC taken by something open in the PC’s box is said so', async (t) => {
  const l = await lab(t)
  l.setState({ agent_state: 'working' })
  l.deps.stopConfirmMs = 200
  // agy stays working (the ESC closed the slash list or `@` suggestions on the PC)
  const res = await stopAgy(A, l.deps, () => Date.now() + 9e8)
  assert.equal(res.reason, 'not-stopped')
  await settle()
  assert.equal(l.got.join(''), '\x1b', 'one ESC, never a second')
  // it stops: told so
  l.got.length = 0
  stopsAfter(l, 1)
  assert.equal((await stopAgy(A, l.deps, () => Date.now() + 9.5e8)).ok, true)
})

test('★ stop: the state unreadable while confirming does not count as stopped', async (t) => {
  const l = await lab(t)
  l.setState({ agent_state: 'working' })
  l.deps.stopConfirmMs = 150
  // after the ESC, the status file cannot be read (the hook removed it on a failed write)
  l.deps.readNow = (target) => (l.got.join('').includes('\x1b') ? undefined : readNow(target))
  assert.equal((await stopAgy(A, l.deps, () => Date.now() + 9.9e8)).reason, 'not-stopped')
})

/**
 * ★ An agy input box as measured on 1.5.14: ctrl+end to the end of the draft, Ctrl-U deletes to the start of the line,
 * Backspace joins an empty line to the one above (nothing on an empty box). `cursorRow` = where the PC left the cursor.
 */
function boxScreen(l: Lab, lines: string[], opts: { ignore?: boolean; cursorRow?: number; under?: string[]; slow?: boolean } = {}): { written: string[] } {
  const pane = join(l.root, 'panes', `${PID}.json`)
  writeFileSync(pane, JSON.stringify({ ...JSON.parse(readFileSync(pane, 'utf8')), screen: true }))
  const RULE = '─'.repeat(60)
  l.deps.screenSettleMs = 150
  let box = [...lines]
  let row = opts.cursorRow ?? box.length - 1
  const press = (bytes: string): void => {
    if (opts.ignore) return
    for (let rest = bytes; rest.length > 0; ) {
      if (rest.startsWith(AGY_CLEAR_KEYS.bottom)) {
        row = box.length - 1
        rest = rest.slice(AGY_CLEAR_KEYS.bottom.length)
        continue
      }
      const k = rest[0]!
      rest = rest.slice(1)
      if (k === '\x15') box[row] = ''
      else if (k === '\x7f' && box[row] === '' && row > 0) {
        box.splice(row--, 1)
        // (agy lagging behind: one row per batch)
        if (opts.slow) return
      }
    }
  }
  l.deps.readScreen = async () =>
    ['  ok', RULE, `>${box[0] ? ` ${box[0]}` : ''}`, ...box.slice(1).map((x) => `  ${x}`), RULE, ...(opts.under ?? []), '? for shortcuts      auto · Gemini 4 Neon · high'].join('\n')
  const written: string[] = []
  l.deps.openKeyLine = async () => ({
    write: async (bytes, refuse) => {
      if (refuse?.()) return false
      written.push(bytes)
      press(bytes)
      return true
    },
    close: () => undefined,
  })
  return { written }
}

test('★★ clear: ctrl+end, then Ctrl-U + Backspace per row until the screen shows the box empty (one line, several, mid-turn)', async (t) => {
  const l = await lab(t)
  // "/co" left with the slash list open under the box
  const one = boxScreen(l, ['/co'], { under: ['> /codesearch    Search code', '  /config         Open settings panel', '  ↑/↓ Navigate · enter Select · tab Complete'] })
  assert.equal((await clearAgy(A, l.deps)).ok, true)
  assert.deepEqual(one.written, [AGY_CLEAR_KEYS.bottom, AGY_CLEAR_KEYS.row])
  // three lines, the cursor left on the first one by the PC
  const three = boxScreen(l, ['l1', 'l2', 'l3 end'], { cursorRow: 0 })
  assert.equal((await clearAgy(A, l.deps)).ok, true)
  assert.equal(three.written[0], AGY_CLEAR_KEYS.bottom)
  // ★ also while a turn runs (the turn goes on: measured)
  l.setState({ agent_state: 'working' })
  boxScreen(l, ['draft'])
  assert.equal((await clearAgy(A, l.deps)).ok, true)
  // already empty: nothing typed
  l.setState({})
  const none = boxScreen(l, [''])
  assert.equal((await clearAgy(A, l.deps)).ok, true)
  assert.deepEqual(none.written, [])
})

test('★★ clear refused, nothing typed: a card, an older relay, no box on the screen; keys agy ignores are not told as cleared', async (t) => {
  const l = await lab(t)
  const card = boxScreen(l, ['abc'])
  l.setState({ agent_state: 'tool_use', tool_confirmation_pending: true })
  assert.equal((await clearAgy(A, l.deps)).reason, 'waiting')
  assert.deepEqual(card.written, [])
  l.setState({})
  // a list or a panel over the box (no "> …" row closed by a rule): its keys would be that panel's
  const off = boxScreen(l, ['abc'])
  const read = l.deps.readScreen!
  l.deps.readScreen = async (p) => ((await read(p)) ?? '').split('\n').filter((r) => !r.startsWith('─')).join('\n')
  assert.equal((await clearAgy(A, l.deps)).reason, 'no-box')
  assert.deepEqual(off.written, [])
  // ⚠️ the keys sent but the box never seen empty
  const deaf = boxScreen(l, ['abc'], { ignore: true })
  assert.equal((await clearAgy(A, l.deps)).reason, 'not-cleared')
  assert.deepEqual(deaf.written, [AGY_CLEAR_KEYS.bottom, AGY_CLEAR_KEYS.row])
  // an older relay
  const pane = join(l.root, 'panes', `${PID}.json`)
  writeFileSync(pane, JSON.stringify({ ...JSON.parse(readFileSync(pane, 'utf8')), screen: false }))
  assert.equal((await clearAgy(A, l.deps)).reason, 'no-screen')
})

test('★ clear: a card that opens after the first key stops it (no key into the card), told as not cleared', async (t) => {
  const l = await lab(t)
  const k = boxScreen(l, ['abc'])
  const open = l.deps.openKeyLine!
  l.deps.openKeyLine = async (p) => {
    const line = (await open(p))!
    return {
      write: async (bytes, refuse) => {
        const ok = await line.write(bytes, refuse)
        if (bytes === AGY_CLEAR_KEYS.bottom) l.setState({ agent_state: 'tool_use', tool_confirmation_pending: true })
        return ok
      },
      close: () => line.close(),
    }
  }
  assert.equal((await clearAgy(A, l.deps)).reason, 'not-cleared')
  assert.deepEqual(k.written, [AGY_CLEAR_KEYS.bottom])
})

test('★ clear: past its deadline in the queue nothing is done; a conversation moved meanwhile (`/new` on the PC) is not told as cleared', async (t) => {
  const l = await lab(t)
  const late = boxScreen(l, ['abc'])
  l.deps.clearDeadlineMs = 0
  // ⚠️ not even the screen read (a subagent's view would otherwise be left with an ESC)
  let looked = 0
  const look = l.deps.readScreen!
  l.deps.readScreen = async (p) => (looked++, look(p))
  assert.equal((await clearAgy(A, l.deps)).reason, 'unsure')
  assert.deepEqual(late.written, [])
  assert.equal(looked, 0)
  delete l.deps.clearDeadlineMs
  // the lock moves to another conversation once the keys went (agy has not written its status line yet)
  const moved = boxScreen(l, ['abc'])
  const open = l.deps.openKeyLine!
  l.deps.openKeyLine = async (p) => {
    const line = (await open(p))!
    return {
      write: async (bytes, refuse) => {
        const ok = await line.write(bytes, refuse)
        if (bytes !== AGY_CLEAR_KEYS.bottom) l.deps.locksOf = () => ['11111111-2222-3333-4444-555555555555']
        return ok
      },
      close: () => line.close(),
    }
  }
  assert.equal((await clearAgy(A, l.deps)).reason, 'not-cleared')
  assert.deepEqual(moved.written, [AGY_CLEAR_KEYS.bottom, AGY_CLEAR_KEYS.row])
})

test('★ clear: an empty box is told as cleared only while this agy still shows this conversation', async (t) => {
  const l = await lab(t)
  const none = boxScreen(l, [''])
  l.deps.locksOf = (p) => (p === PID ? [A] : [])
  let probes = 0
  l.deps.locksOf = (p) => (p === PID ? (++probes > 2 ? ['11111111-2222-3333-4444-555555555555'] : [A]) : [])
  assert.equal((await clearAgy(A, l.deps)).reason, 'unsure')
  assert.deepEqual(none.written, [])
})

test('★★ clear from a subagent’s view: back to the parent only while it is idle (mid-turn an ESC landing on the parent would stop it)', async (t) => {
  const l = await lab(t)
  idleChild(l, K2)
  childViewUntilEsc(l, K2)
  l.setState({ agent_state: 'working' })
  assert.equal((await clearAgy(A, l.deps)).reason, 'child-view')
  await settle()
  assert.equal(l.got.join(''), '', 'no ESC')
  // idle: back first (the parent's box is empty there)
  l.setState({})
  assert.equal((await clearAgy(A, l.deps)).ok, true)
  await settle()
  assert.equal(l.got.join(''), '\x1b')
})

test('★ clear: a further round only while this agy still shows this conversation (a `/resume` on the PC between rounds)', async (t) => {
  const l = await lab(t)
  const k = boxScreen(l, ['l1', 'l2', 'l3'], { slow: true })
  const open = l.deps.openKeyLine!
  l.deps.openKeyLine = async (p) => {
    const line = (await open(p))!
    return {
      write: async (bytes, refuse) => {
        const ok = await line.write(bytes, refuse)
        if (bytes !== AGY_CLEAR_KEYS.bottom) l.deps.locksOf = () => ['11111111-2222-3333-4444-555555555555']
        return ok
      },
      close: () => line.close(),
    }
  }
  assert.equal((await clearAgy(A, l.deps)).reason, 'not-cleared')
  assert.deepEqual(k.written, [AGY_CLEAR_KEYS.bottom, AGY_CLEAR_KEYS.row.repeat(3)])
  // agy lagging, nothing moved: rounds until it is empty
  l.deps.locksOf = (p) => (p === PID ? [A] : [])
  const lag = boxScreen(l, ['l1', 'l2', 'l3'], { slow: true })
  const r = await clearAgy(A, l.deps)
  assert.equal(r.ok, true, `${r.reason} ${JSON.stringify(lag.written)}`)
  assert.ok(lag.written.length > 2)
})

test('★ clear: the screen is read again before each further round (a subagent’s question opened on the PC meanwhile gets no key)', async (t) => {
  const l = await lab(t)
  const k = boxScreen(l, ['l1', 'l2', 'l3'], { slow: true })
  const read = l.deps.readScreen!
  // after the first batch: the round's own check sees the box change, then the question is up
  let reads = -1
  l.deps.readScreen = async (p) => (reads >= 0 && ++reads >= 2 ? 'Question 1/1: Which?\n> 1. a\n  2. Write-in...\n  ↑/↓ Navigate · enter Select · esc Skip' : read(p))
  const open = l.deps.openKeyLine!
  l.deps.openKeyLine = async (p) => {
    const line = (await open(p))!
    return { write: async (bytes, refuse) => { const ok = await line.write(bytes, refuse); if (bytes !== AGY_CLEAR_KEYS.bottom) reads = 0; return ok }, close: () => line.close() }
  }
  assert.equal((await clearAgy(A, l.deps)).reason, 'not-cleared')
  assert.deepEqual(k.written, [AGY_CLEAR_KEYS.bottom, AGY_CLEAR_KEYS.row.repeat(3)])
})


// ★★ agy 1.5.16 (docs/AGY.md §19.2): a subagent's question opened from the parent's list by its id, never with ctrl+k
test('★★ list (1.5.16): the asking subagent is found in the list by its id, its question opened with `a` and answered', async (t) => {
  const qs = [{ question: 'Which hill?', options: ['east', 'west'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs, true)
  l.deps.screenSettleMs = 150
  idleChild(l, K2)
  // another subagent waits for an approval above it in the list; the asking one is K1
  fake.list = [
    { id: K2, name: 'Runner', waits: 'approval' },
    { id: K1, name: 'Asker', waits: 'question' },
  ]
  const kid = transcriptPathOf(K1, l.deps.home)
  const recorded = setTimeout(() => appendFileSync(kid, JSON.stringify({ type: 'GENERIC', step_index: 2, content: 'A1: west' }) + '\n'), 50)
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [1] }) }, l.deps), { ok: true })
  clearTimeout(recorded)
  assert.deepEqual(fake.answers, ['west'])
  // down into the list, K2's view opened and left, down, K1's view, `a`, the answer, back
  // (the last ESC gives the list's focus back to the input box)
  assert.deepEqual(fake.keys, ['\x1b[B', '\r', '\x1b', '\x1b[B', '\r', 'a', '2', '\x1b', '\x1b'])
  assert.equal(fake.focus, -1)
  assert.equal(fake.keys.includes('\x0b'), false, 'never ctrl+k (on an approval it approves)')
  assert.equal(fake.openedOther, false)
})

test('★★ list (1.5.16): a sibling asking the same text does not stop it (told by the id); the focus left mid-list starts from the top', async (t) => {
  const qs = [{ question: 'Which hill?', options: ['east', 'west'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs, true)
  l.deps.screenSettleMs = 150
  // a second child asks the very same question (§19.1 case 4)
  const iso = (sec: number): string => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const twin = transcriptPathOf(K3, l.deps.home)
  mkdirSync(join(twin, '..'), { recursive: true })
  writeFileSync(
    twin,
    [
      { type: 'SYSTEM_MESSAGE', step_index: 0, created_at: iso(BASE - 40), content: `x\n<SYSTEM_MESSAGE>\n[Message] timestamp=${iso(BASE - 40)} sender=${A} priority=MESSAGE_PRIORITY_HIGH content=ask\n</SYSTEM_MESSAGE>` },
      { type: 'PLANNER_RESPONSE', step_index: 1, created_at: iso(BASE - 35), tool_calls: [{ name: 'ask_question', args: { questions: [{ question: 'Which hill?', options: ['east', 'west'], is_multi_select: false }] } }] },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  )
  fake.list = [
    { id: K3, name: 'Asker', waits: 'question' },
    { id: K1, name: 'Asker', waits: 'question' },
  ]
  fake.focus = 1
  const kid = transcriptPathOf(K1, l.deps.home)
  const recorded = setTimeout(() => appendFileSync(kid, JSON.stringify({ type: 'GENERIC', step_index: 2, content: 'A1: east' }) + '\n'), 50)
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [0] }) }, l.deps), { ok: true })
  clearTimeout(recorded)
  assert.deepEqual(fake.answers, ['east'])
  assert.deepEqual(fake.keys, ['\x1b[A', '\r', '\x1b', '\x1b[B', '\r', 'a', '1', '\x1b', '\x1b'])
  assert.equal(fake.focus, -1)
  assert.equal(fake.openedOther, false)
})

test('★★ list (1.5.16): a draft in the PC\'s box, or the asking subagent not in the list: nothing opened', async (t) => {
  const qs = [{ question: 'Which hill?', options: ['east', 'west'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs, true)
  l.deps.screenSettleMs = 150
  idleChild(l, K2)
  fake.list = [
    { id: K2, name: 'Runner', waits: 'approval' },
    { id: K1, name: 'Asker', waits: 'question' },
  ]
  fake.draft = 'half typed'
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [1] }) }, l.deps), { ok: false, reason: 'changed' })
  assert.deepEqual(fake.keys, [])
  fake.draft = ''
  fake.list = [{ id: K2, name: 'Runner', waits: 'approval' }]
  assert.equal(agyUnlisted(mark), false)
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [1] }) }, l.deps), { ok: false, reason: 'changed' })
  assert.deepEqual(fake.keys, ['\x1b[B', '\r', '\x1b'])
  // ★ the whole list walked without it: remembered (its card is not raised again / codex review)
  assert.equal(agyUnlisted(mark), true)
  resetAgyUnlistedForTest()
  // ⚠️ the list changing during the walk (a row added): not remembered (codex review)
  fake.keys = []
  fake.view = 'parent'
  fake.focus = -1
  const press = fake.press.bind(fake)
  fake.press = (bytes: string) => {
    press(bytes)
    if (bytes === '\r' && fake.list!.length === 1) fake.list = [{ id: K3, name: 'Newer', waits: 'approval' }, ...fake.list!]
  }
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [1] }) }, l.deps), { ok: false, reason: 'changed' })
  assert.equal(agyUnlisted(mark), false)
  fake.press = press
  fake.list = [{ id: K2, name: 'Runner', waits: 'approval' }]
  assert.equal(fake.openedOther, false)
  assert.deepEqual(fake.answers, [''])
  // ⚠️ the PC types into its box right after the answer looked (before the first key): the key is not sent
  fake.keys = []
  fake.view = 'parent'
  fake.focus = -1
  fake.list = [{ id: K1, name: 'Asker', waits: 'question' }]
  const draw = fake.screen.bind(fake)
  let reads = 0
  l.deps.readScreen = async () => {
    if (++reads === 2) fake.draft = 'typed meanwhile'
    return draw()
  }
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [1] }) }, l.deps), { ok: false, reason: 'changed' })
  assert.deepEqual(fake.keys, [])
  fake.draft = ''
  l.deps.readScreen = async () => draw()
  // ⚠️ its view shows another question now (asked again meanwhile): `a` not pressed
  fake.keys = []
  fake.view = 'parent'
  fake.focus = -1
  fake.list = [{ id: K1, name: 'Asker', waits: 'question' }]
  fake.shownQuestion = 'Which lake?'
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [1] }) }, l.deps), { ok: false, reason: 'changed' })
  assert.equal(fake.keys.includes('a'), false)
})

test('★★ list (1.5.16): never ctrl+k on agy 1.5.16+ — the banner without a readable list, or a blind relay', async (t) => {
  const qs = [{ question: 'Which hill?', options: ['east', 'west'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs, true)
  l.deps.screenSettleMs = 150
  for (const f of [l.stateFile, join(l.deps.dir, `pid-${PID}.json`)]) {
    const raw = JSON.parse(readFileSync(f, 'utf8'))
    const at = statSync(f).mtimeMs / 1000
    writeFileSync(f, JSON.stringify({ ...raw, input: { ...raw.input, version: '1.5.16' } }))
    utimesSync(f, at, at)
  }
  // the banner is up, the list is not readable (a narrow terminal wrapped it): nothing pressed
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [1] }) }, l.deps), { ok: false, reason: 'changed' })
  assert.equal(fake.keys.includes('\x0b'), false)
  // a blind relay's fixed keys for a subagent's question start with ctrl+k: refused
  const blind = { ...mark, screen: undefined }
  delete (blind as { screen?: true }).screen
  assert.deepEqual(await answerAgyQuestion(A, blind, { kind: 'steps', steps: [{ key: '2' }] }, l.deps), { ok: false, reason: 'changed' })
  assert.equal(fake.keys.includes('\x0b'), false)
})

test('★ list (1.5.16): a question whose own text has a "? " row is still matched (a ternary / codex review)', async (t) => {
  const qs = [{ question: 'Keep a ? b : c as is?', options: ['yes', 'no'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs, true)
  l.deps.screenSettleMs = 150
  fake.list = [{ id: K1, name: 'Asker', waits: 'question' }]
  // the view shows it wrapped right before "? b"
  fake.shownQuestion = 'Keep a\n      ? b : c as is?'
  const kid = transcriptPathOf(K1, l.deps.home)
  const recorded = setTimeout(() => appendFileSync(kid, JSON.stringify({ type: 'GENERIC', step_index: 2, content: 'A1: yes' }) + '\n'), 50)
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [0] }) }, l.deps), { ok: true })
  clearTimeout(recorded)
  assert.deepEqual(fake.answers, ['yes'])
})

test('★ list (1.5.16): the PC left on the asking subagent\'s view with its question closed: `a` right there (codex review)', async (t) => {
  const qs = [{ question: 'Which hill?', options: ['east', 'west'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs, true)
  l.deps.screenSettleMs = 150
  fake.list = [{ id: K1, name: 'Asker', waits: 'question' }]
  fake.view = 'child'
  fake.childId = K1
  const kid = transcriptPathOf(K1, l.deps.home)
  const recorded = setTimeout(() => appendFileSync(kid, JSON.stringify({ type: 'GENERIC', step_index: 2, content: 'A1: west' }) + '\n'), 50)
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [1] }) }, l.deps), { ok: true })
  clearTimeout(recorded)
  assert.deepEqual(fake.answers, ['west'])
  assert.deepEqual(fake.keys, ['a', '2', '\x1b'])
})

test('★ list (1.5.16): a list that changes during the walk and comes back is not taken for "missing" (codex review)', async (t) => {
  const qs = [{ question: 'Which hill?', options: ['east', 'west'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs, true)
  l.deps.screenSettleMs = 150
  const K4 = '4d4d4d4d-1111-4222-8333-444444444444'
  const K5 = '5e5e5e5e-1111-4222-8333-444444444444'
  const K6 = '6f6f6f6f-1111-4222-8333-444444444444'
  fake.list = [
    { id: K2, name: 'Runner', waits: 'approval' },
    { id: K4, name: 'Other', waits: 'approval' },
  ]
  let enters = 0
  const press = fake.press.bind(fake)
  fake.press = (bytes: string) => {
    press(bytes)
    if (bytes !== '\r') return
    enters++
    // two rows appear above while the first is open, and are gone again while the second is
    if (enters === 1) fake.list = [{ id: K5, name: 'Temp', waits: 'approval' }, { id: K6, name: 'Temp2', waits: 'approval' }, ...fake.list!]
    else if (enters === 2) fake.list = fake.list!.filter((r) => r.id !== K5 && r.id !== K6)
  }
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [1] }) }, l.deps), { ok: false, reason: 'changed' })
  assert.equal(agyUnlisted(mark), false)
  resetAgyUnlistedForTest()
})

test('★ list (1.5.16): the direct `a` only when the preview shows this question (codex review)', async (t) => {
  const qs = [{ question: 'Which hill?', options: ['east', 'west'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs, true)
  l.deps.screenSettleMs = 150
  fake.list = [{ id: K1, name: 'Asker', waits: 'question' }]
  fake.view = 'child'
  fake.childId = K1
  fake.shownQuestion = 'Which lake?'
  const r = await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [1] }) }, l.deps)
  assert.equal(r.ok, false)
  assert.equal(fake.keys.includes('a'), false)
})

test('★ list (1.5.16): this child\'s own dialog already open, a sibling asking the same text: answered (told by its id / codex review)', async (t) => {
  const qs = [{ question: 'Which hill?', options: ['east', 'west'], multi: false }]
  const { l, fake, mark, question } = await screenLab(t, qs, true)
  l.deps.screenSettleMs = 150
  for (const f of [l.stateFile, join(l.deps.dir, `pid-${PID}.json`)]) {
    const raw = JSON.parse(readFileSync(f, 'utf8'))
    const at = statSync(f).mtimeMs / 1000
    writeFileSync(f, JSON.stringify({ ...raw, input: { ...raw.input, version: '1.5.16' } }))
    utimesSync(f, at, at)
  }
  const iso = (sec: number): string => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const twin = transcriptPathOf(K3, l.deps.home)
  mkdirSync(join(twin, '..'), { recursive: true })
  writeFileSync(
    twin,
    [
      { type: 'SYSTEM_MESSAGE', step_index: 0, created_at: iso(BASE - 40), content: `x\n<SYSTEM_MESSAGE>\n[Message] timestamp=${iso(BASE - 40)} sender=${A} priority=MESSAGE_PRIORITY_HIGH content=ask\n</SYSTEM_MESSAGE>` },
      { type: 'PLANNER_RESPONSE', step_index: 1, created_at: iso(BASE - 35), tool_calls: [{ name: 'ask_question', args: { questions: [{ question: 'Which hill?', options: ['east', 'west'], is_multi_select: false }] } }] },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  )
  // the PC has K1's dialog open on its view
  fake.open = true
  fake.view = 'child'
  fake.dialogView = 'child'
  fake.childId = K1
  const kid = transcriptPathOf(K1, l.deps.home)
  const recorded = setTimeout(() => appendFileSync(kid, JSON.stringify({ type: 'GENERIC', step_index: 2, content: 'A1: west' }) + '\n'), 50)
  assert.deepEqual(await answerAgyQuestion(A, mark, { kind: 'plan', question, plan: plan({ indexes: [1] }) }, l.deps), { ok: true })
  clearTimeout(recorded)
  assert.deepEqual(fake.answers, ['west'])
})

// ★★ agy 1.5.16: a subagent's command approval answered from the phone (docs/AGY.md §19, case 8)
/** The parent's list and the subagents' views as agy 1.5.16 draws them, for approvals (measured 2026-11-25) */
class FakeApprovals {
  view: 'parent' | 'child' = 'parent'
  focus = -1
  childId = ''
  /** the open approval dialog (in `childId`'s view) */
  open = false
  keys: string[] = []
  decided = new Map<string, string>()
  /** the choices the open dialog shows */
  choices = ['1. Yes, approve', '2. No, deny']
  /** a digit agy does not act on (dropped on the way) */
  dropDigits = false
  /** run when a digit decides (the child reporting to the parent, say) */
  onDecide?: () => void
  /** run when a subagent's view is opened from the list */
  onOpen?: (id: string) => void
  readonly list: { id: string; name: string; command?: string }[]
  constructor(list: { id: string; name: string; command?: string }[]) {
    this.list = list
  }
  press(bytes: string): void {
    this.keys.push(bytes)
    if (this.view === 'parent') {
      if (bytes === '\x1b[B') this.focus = Math.min(this.list.length - 1, this.focus + 1)
      else if (bytes === '\x1b[A') this.focus = Math.max(-1, this.focus - 1)
      else if (bytes === '\r' && this.focus >= 0) {
        this.view = 'child'
        this.childId = this.list[this.focus]!.id
        this.onOpen?.(this.childId)
      } else if (bytes === '\x1b' && this.focus >= 0) this.focus = -1
      return
    }
    const row = this.list.find((r) => r.id === this.childId)!
    if (this.open) {
      if ((bytes === '1' || bytes === '2') && this.dropDigits) return
      if (bytes === '1' || bytes === '2') {
        this.onDecide?.()
        this.decided.set(row.id, bytes)
        row.command = undefined
        this.open = false
      } else if (bytes === '\x1b') this.open = false
      return
    }
    if (bytes === '\x1b') this.view = 'parent'
    else if (bytes === 'a' && row.command !== undefined) this.open = true
  }
  screen(): string {
    const rule = '─'.repeat(60)
    if (this.view === 'parent') {
      const lines = [rule, '>', rule]
      this.list.forEach((r, i) => lines.push(`${this.focus === i ? '> ' : '  '}● Agent(self: ${r.name}) · Gemini 4 Neon  ${r.command !== undefined ? 'Blocked · Bash' : 'Thinking'} · 9s`))
      lines.push(rule, '? for shortcuts                                accept-edits · Gemini 4 Neon · high')
      return lines.join('\n')
    }
    const row = this.list.find((r) => r.id === this.childId)!
    const lines = ['  main › self', '  ● running · Gemini 4 Neon (High) · 9s · 3 steps', `  ID: ${this.childId}`, '  ' + '─'.repeat(20)]
    if (row.command !== undefined) {
      lines.push('  ⚠ Approval Required', this.open ? '    > Bash' : '    Bash', `      ${row.command}`)
      if (this.open) this.choices.forEach((c, i) => lines.push(`      ${i === 0 ? '> ' : '  '}${c}`))
      lines.push('  ' + '─'.repeat(20))
    }
    lines.push(
      this.open ? '  ↑/↓ navigate · / select · enter confirm · esc cancel' : `  ↑/↓ scroll · pgup/pgdown page · ctrl+end bottom · ctrl+home top · ctrl+o expand${row.command !== undefined ? ' · a respond' : ''} · shift+k kill · esc back`,
      '                                Gemini 4 Neon · high · 2 subagent(s)',
    )
    return lines.join('\n')
  }
}

async function approvalLab(t: { after(fn: () => void): void }, list: { id: string; name: string; command?: string }[]) {
  const l = await lab(t)
  const { askedAt } = withChildren(l, [
    { id: K1, prompt: 'run', asking: false, command: true },
    { id: K2, prompt: 'think', asking: false, thinking: true },
  ])
  l.setState({ agent_state: 'idle', version: '1.5.16', subagents: [{ name: 'self', role: 'run', status: 'running' }, { name: 'self', role: 'think', status: 'running' }] }, BASE)
  const fake = new FakeApprovals(list)
  l.deps.answerSettleMs = 0
  l.deps.screenSettleMs = 150
  l.deps.readScreen = async () => fake.screen()
  l.deps.openKeyLine = async () => ({
    write: async (bytes, refuse) => {
      if (refuse?.()) return false
      fake.press(bytes)
      return true
    },
    close: () => undefined,
  })
  const pane = join(l.root, 'panes', `${PID}.json`)
  writeFileSync(pane, JSON.stringify({ ...JSON.parse(readFileSync(pane, 'utf8')), screen: true }))
  const mark: AgyChildApprovalMark = { pid: PID, child: K1, askedAt: askedAt.get(K1)!, step: 1, index: 0, callAt: (BASE - 35) * 1000, command: 'ls' }
  return { l, fake, mark }
}

test('★★ subagent approval (1.5.16): opened from the list by its id, its command and choices checked, `1` approves', async (t) => {
  const { l, fake, mark } = await approvalLab(t, [
    { id: K2, name: 'Thinker' },
    { id: K1, name: 'Runner', command: 'ls' },
  ])
  assert.deepEqual(await answerAgyChildApproval(A, mark, 'allow', l.deps), { ok: true })
  assert.equal(fake.decided.get(K1), '1')
  // down, K2's view opened and left, down, K1's view, `a`, `1`, back, the list's focus back to the box
  assert.deepEqual(fake.keys, ['\x1b[B', '\r', '\x1b', '\x1b[B', '\r', 'a', '1', '\x1b', '\x1b'])
  assert.equal(fake.view, 'parent')
  assert.equal(fake.focus, -1)
  assert.equal(fake.keys.includes('\x0b'), false, 'never ctrl+k (it approves at once on 1.5.16)')
})

test('★ subagent approval: `2` denies; the PC already on its view answers there', async (t) => {
  const { l, fake, mark } = await approvalLab(t, [{ id: K1, name: 'Runner', command: 'ls' }])
  fake.view = 'child'
  fake.childId = K1
  assert.deepEqual(await answerAgyChildApproval(A, mark, 'deny', l.deps), { ok: true })
  assert.equal(fake.decided.get(K1), '2')
  assert.deepEqual(fake.keys, ['a', '2', '\x1b'])
})

test('★ subagent approval: nothing decided when the screen shows another command, other choices, or the parent is not idle', async (t) => {
  {
    const { l, fake, mark } = await approvalLab(t, [{ id: K1, name: 'Runner', command: 'rm -rf build' }])
    assert.deepEqual(await answerAgyChildApproval(A, mark, 'allow', l.deps), { ok: false, reason: 'changed' })
    assert.equal(fake.decided.size, 0)
    assert.equal(fake.keys.includes('a'), false, 'not even opened')
  }
  {
    const { l, fake, mark } = await approvalLab(t, [{ id: K1, name: 'Runner', command: 'ls' }])
    fake.choices = ['1. Yes, approve', '2. Yes, and always', '3. No, deny']
    assert.deepEqual(await answerAgyChildApproval(A, mark, 'deny', l.deps), { ok: false, reason: 'changed' })
    assert.equal(fake.decided.size, 0, 'no digit on unmeasured choices')
    assert.equal(fake.open, false, 'its dialog closed again (ESC cancels, deciding nothing)')
    assert.equal(fake.view, 'parent')
  }
  {
    const { l, fake, mark } = await approvalLab(t, [{ id: K1, name: 'Runner', command: 'ls' }])
    l.setState({ agent_state: 'tool_use', version: '1.5.16', subagents: [{ name: 'self', role: 'run', status: 'running' }] }, BASE)
    assert.deepEqual(await answerAgyChildApproval(A, mark, 'allow', l.deps), { ok: false, reason: 'changed' })
    assert.equal(fake.keys.length, 0)
  }
  {
    // ⚠️ an older agy (no list there, and ctrl+k does not approve): never
    const { l, fake, mark } = await approvalLab(t, [{ id: K1, name: 'Runner', command: 'ls' }])
    l.setState({ agent_state: 'idle', version: '1.5.15', subagents: [{ name: 'self', role: 'run', status: 'running' }] }, BASE)
    assert.deepEqual(await answerAgyChildApproval(A, mark, 'allow', l.deps), { ok: false, reason: 'changed' })
    assert.equal(fake.keys.length, 0)
  }
})

test('★ subagent approval: a call no longer the card\'s (answered on the PC, its transcript written) is not answered', async (t) => {
  const { l, fake, mark } = await approvalLab(t, [{ id: K1, name: 'Runner', command: 'ls' }])
  appendFileSync(transcriptPathOf(K1, l.deps.home), JSON.stringify({ type: 'GENERIC', step_index: 2, content: 'done' }) + '\n')
  assert.deepEqual(await answerAgyChildApproval(A, mark, 'allow', l.deps), { ok: false, reason: 'changed' })
  assert.equal(fake.keys.length, 0)
})

test('★ subagent approval: its dialog already open on the PC, but the parent working or the child\'s record rewritten: no digit', async (t) => {
  {
    const { l, fake, mark } = await approvalLab(t, [{ id: K1, name: 'Runner', command: 'ls' }])
    fake.view = 'child'
    fake.childId = K1
    fake.open = true
    l.setState({ agent_state: 'tool_use', version: '1.5.16', subagents: [{ name: 'self', role: 'run', status: 'running' }] }, BASE)
    assert.deepEqual(await answerAgyChildApproval(A, mark, 'allow', l.deps), { ok: false, reason: 'changed' })
    assert.equal(fake.decided.size, 0)
  }
  {
    const { l, fake, mark } = await approvalLab(t, [{ id: K1, name: 'Runner', command: 'ls' }])
    fake.view = 'child'
    fake.childId = K1
    fake.open = true
    // (written since the card: the same call may no longer be the one waiting)
    const kid = transcriptPathOf(K1, l.deps.home)
    utimesSync(kid, BASE - 5, BASE - 5)
    assert.deepEqual(await answerAgyChildApproval(A, mark, 'allow', l.deps), { ok: false, reason: 'changed' })
    assert.equal(fake.decided.size, 0)
  }
})

test('★ subagent approval: a digit that did not take is not "answered"; a child reporting meanwhile does not keep the PC on its view (codex · agy review)', async (t) => {
  {
    const { l, fake, mark } = await approvalLab(t, [{ id: K1, name: 'Runner', command: 'ls' }])
    fake.dropDigits = true
    assert.deepEqual(await answerAgyChildApproval(A, mark, 'allow', l.deps), { ok: false, reason: 'unreachable' })
    assert.equal(fake.decided.size, 0)
    // ★ what it opened is closed again (ESC cancels the dialog, `esc back` leaves the view): the list shows again
    assert.equal(fake.open, false)
    assert.equal(fake.view, 'parent')
  }
  {
    const { l, fake, mark } = await approvalLab(t, [
      { id: K2, name: 'Thinker' },
      { id: K1, name: 'Runner', command: 'ls' },
    ])
    // the child's report lands in the parent's transcript as the command is approved
    fake.onDecide = () => appendFileSync(l.transcript, JSON.stringify({ type: 'SYSTEM_MESSAGE', step_index: 20, content: 'x' }) + '\n')
    assert.deepEqual(await answerAgyChildApproval(A, mark, 'allow', l.deps), { ok: true })
    assert.equal(fake.view, 'parent', 'back on the parent\'s view, where the siblings\' approvals show')
  }
})

test('★ subagent approval: a stop mid-way closes what it opened — a team\'s access ending at the dialog, a walk stopped on another view (codex · agy review)', async (t) => {
  {
    const { l, fake, mark } = await approvalLab(t, [{ id: K1, name: 'Runner', command: 'ls' }])
    let wanted = true
    // the access ends once the dialog is open
    const read = l.deps.readScreen!
    l.deps.readScreen = async (p) => {
      if (fake.open) wanted = false
      return read(p)
    }
    assert.deepEqual(await answerAgyChildApproval(A, mark, 'allow', l.deps, undefined, () => wanted), { ok: false, reason: 'changed' })
    assert.equal(fake.decided.size, 0)
    assert.equal(fake.open, false, 'its dialog cancelled')
    assert.equal(fake.view, 'parent')
  }
  {
    const { l, fake, mark } = await approvalLab(t, [
      { id: K2, name: 'Thinker' },
      { id: K1, name: 'Runner', command: 'ls' },
    ])
    // the parent wakes while the walk is on K2's view (a sibling reported)
    fake.onOpen = (id) => {
      if (id === K2) l.setState({ agent_state: 'tool_use', version: '1.5.16', subagents: [{ name: 'self', role: 'run', status: 'running' }] }, BASE)
    }
    assert.deepEqual(await answerAgyChildApproval(A, mark, 'allow', l.deps), { ok: false, reason: 'changed' })
    assert.equal(fake.view, 'parent', 'not left on K2\'s view')
    assert.equal(fake.decided.size, 0)
  }
})

test('★ subagent approval: a failed screen read is read again (the PC goes back after the decision); a view the PC opened is not closed (codex · agy review)', async (t) => {
  {
    const { l, fake, mark } = await approvalLab(t, [
      { id: K2, name: 'Thinker' },
      { id: K1, name: 'Runner', command: 'ls' },
    ])
    // one failed read right after the decision
    const read = l.deps.readScreen!
    let dropped = false
    l.deps.readScreen = async (p) => {
      if (fake.decided.size > 0 && !dropped) {
        dropped = true
        return undefined
      }
      return read(p)
    }
    assert.deepEqual(await answerAgyChildApproval(A, mark, 'allow', l.deps), { ok: true })
    assert.equal(dropped, true)
    assert.equal(fake.view, 'parent')
  }
  {
    const { l, fake, mark } = await approvalLab(t, [
      { id: K2, name: 'Thinker' },
      { id: K1, name: 'Runner', command: 'ls' },
      { id: K3, name: 'Other' },
    ])
    // the PC person opens K3's view as the walk starts
    const read = l.deps.readScreen!
    l.deps.readScreen = async (p) => {
      if (fake.keys.length === 1 && fake.view === 'parent') {
        fake.view = 'child'
        fake.childId = K3
      }
      return read(p)
    }
    assert.deepEqual(await answerAgyChildApproval(A, mark, 'allow', l.deps), { ok: false, reason: 'changed' })
    assert.deepEqual([fake.view, fake.childId], ['child', K3], 'their view left as it is')
    assert.equal(fake.keys.includes('\x1b'), false)
  }
})

test('★ subagent approval: a view the walk opened and left, opened again by the PC person, is not closed (codex review)', async (t) => {
  const { l, fake, mark } = await approvalLab(t, [
    { id: K2, name: 'Thinker' },
    { id: K1, name: 'Runner', command: 'ls' },
  ])
  const read = l.deps.readScreen!
  l.deps.readScreen = async (p) => {
    // after the walk left K2 and moved down, the PC person opens K2 again
    if (fake.keys.length === 4 && fake.view === 'parent') {
      fake.view = 'child'
      fake.childId = K2
    }
    return read(p)
  }
  assert.deepEqual(await answerAgyChildApproval(A, mark, 'allow', l.deps), { ok: false, reason: 'changed' })
  assert.deepEqual([fake.view, fake.childId], ['child', K2])
  assert.deepEqual(fake.keys, ['\x1b[B', '\r', '\x1b', '\x1b[B'], 'no ESC of cleanup into their view')
})

test('★★ a parent\'s own card with a child running (1.5.16): typed only once its dialog is seen open for this command', async (t) => {
  const rule = '─'.repeat(40)
  const dialog = (command: string): string =>
    [' ┃ self needs approval for Bash', ' ┃', ' ┃ ● Bash(echo child)', ' ┃ ctrl+k approve', 'Command', rule, 'Requesting permission for:', `   ${command}`, 'Run this command?', '> 1. Yes, run command', '  4. No, cancel', 'esc to cancel                                        accept-edits · Gemini 4 Neon · high · 1 subagent(s)'].join('\n')
  const childView = '  main › self\n  ● running · Gemini 4 Neon (High) · 9s · 3 steps\n  ID: 15bc1e2a-6a62-4f86-9bf9-dd03e99f6627\n  ↑/↓ scroll · shift+k kill · esc back'
  for (const [version, shown, want] of [
    ['1.5.16', dialog('make'), '1'],
    // ⚠️ the PC on a child's view: nothing pressed (not even an ESC to go back / codex review)
    ['1.5.16', childView, ''],
    ['1.5.16', dialog('make clean'), ''],
    ['1.5.15', dialog('make'), ''],
  ] as const) {
    const l = await lab(t)
    // (the viewed child asks nothing: an ESC to go back would be allowed there — never sent with children running)
    idleChild(l, K1)
    appendFileSync(l.transcript, JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: new Date((BASE - 60) * 1000).toISOString(), tool_calls: [{ name: 'run_command', args: { CommandLine: 'make' } }] }) + '\n')
    utimesSync(l.transcript, BASE - 50, BASE - 50)
    l.setState({ agent_state: 'tool_use', tool_confirmation_pending: true, version, subagents: [{ name: 'self', status: 'running' }] })
    const pane = join(l.root, 'panes', `${PID}.json`)
    writeFileSync(pane, JSON.stringify({ ...JSON.parse(readFileSync(pane, 'utf8')), screen: true }))
    const mark = { pid: PID, stateMtimeMs: BASE * 1000, step: 1, index: 0, callAt: (BASE - 60) * 1000 }
    const res = await answerAgyCard(A, mark, 'allow', { ...l.deps, answerSettleMs: 0, readScreen: async () => shown })
    assert.deepEqual(res, want === '1' ? { ok: true } : { ok: false, reason: 'changed' }, `${version} ${shown.includes('make clean') ? 'other command' : ''}`)
    await settle()
    assert.equal(l.got.join(''), want)
  }
})
