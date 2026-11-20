import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { agyTyped, findAgyTarget, looksLikeAgyShortcut, readNow, sendGate, sendToAgy, stopAgy, stopGate, type AgyKeysDeps } from './keys.ts'
import { agyRows } from './sessions.ts'

const A = '062a8f25-9451-42f3-ae93-34a208e99365'
const PID = 4242
const START = '123456'
// ⚠️ File times near now (files of a gone agy older than a day are removed by `liveAgy`)
const BASE = Math.floor(Date.now() / 1000)

test('gates: text only while idle and written after the transcript; ESC only while working; a card stops both', () => {
  const idle = { agentState: 'idle', confirmationPending: false }
  assert.equal(sendGate(idle, 2000, 1000), 'ok')
  assert.equal(sendGate(idle, 2000, 2000), 'ok')
  // ⚠️ the transcript moved after the status line said idle (a status line that stopped writing)
  assert.equal(sendGate(idle, 1000, 2000), 'unsure')
  assert.equal(sendGate(idle, 2000, undefined), 'unsure')
  assert.equal(sendGate({ agentState: 'error', confirmationPending: false }, 2, 1), 'ok')
  for (const s of ['working', 'tool_use', 'reviewing']) assert.equal(sendGate({ agentState: s, confirmationPending: false }, 2, 1), 'busy')
  for (const s of ['initializing', 'authenticating', undefined, 'new-state']) {
    assert.equal(sendGate({ agentState: s, confirmationPending: false }, 2, 1), 'unsure', String(s))
  }
  assert.equal(sendGate({ agentState: 'tool_use', confirmationPending: true }, 2, 1), 'waiting')
  // stop
  assert.equal(stopGate({ agentState: 'working', confirmationPending: false }, 1, 2), 'ok')
  assert.equal(stopGate({ agentState: 'tool_use', confirmationPending: true }, 1, 2), 'waiting')
  assert.equal(stopGate(idle, 2, 1), 'idle')
  assert.equal(stopGate(idle, 1, 2), 'unsure')
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
    writeFileSync(stateFile, JSON.stringify({ nyanPid: PID, nyanBusyAt: 0, input: { conversation_id: A, cwd: '/home/user/p', agent_state: 'idle', ...over } }))
    utimesSync(stateFile, mtimeSec, mtimeSec)
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
  const deps: AgyKeysDeps = { dir, home, isAgy: (p) => p === PID, now: Date.now(), aliveProcStart: (p) => (p === PID ? START : null) }
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
  assert.equal((await stopAgy(A, l.deps, clock)).ok, true)
  assert.equal((await stopAgy(A, l.deps, clock)).reason, 'too-soon')
  now += 2000
  assert.equal((await stopAgy(A, l.deps, clock)).ok, true)
  await settle()
  assert.deepEqual(l.got, ['\x1b', '\x1b'])
})

test('target: only the conversation its agy wrote last', async (t) => {
  const l = await lab(t)
  const B = '6c0298e8-77c4-406c-aa97-cbecdfd19c88'
  // the same agy moved on to another conversation (newer file)
  writeFileSync(join(l.deps.dir, `session-${B}.json`), JSON.stringify({ nyanPid: PID, nyanBusyAt: 0, input: { conversation_id: B, cwd: '/home/user/p', agent_state: 'idle' } }))
  utimesSync(join(l.deps.dir, `session-${B}.json`), BASE + 10, BASE + 10)
  assert.equal(await findAgyTarget(A, l.deps), 'not-open')
  const b = await findAgyTarget(B, l.deps)
  assert.equal(typeof b === 'object' ? b.pid : b, PID)
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
  // the file now names another process
  writeFileSync(l.stateFile, JSON.stringify({ nyanPid: PID + 1, nyanBusyAt: 0, input: { conversation_id: A, cwd: '/home/user/p', agent_state: 'idle' } }))
  utimesSync(l.stateFile, BASE, BASE)
  assert.equal(readNow(target), undefined)
  // the pane registered after the file was written
  l.setState({})
  assert.equal(readNow({ ...target, pane: { ...target.pane, startedAt: (BASE + 60) * 1000 } }), undefined)
  assert.ok(readNow(target))
  await settle()
  assert.equal(l.got.join(''), '')
})
