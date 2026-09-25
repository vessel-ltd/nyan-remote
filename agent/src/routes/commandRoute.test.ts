// ★★★ Tests that **actually execute** the table command endpoint (structure tests alone give a "false green").
//
// ⚠️⚠️ Searching the source text alone stays green even with these mutations:
//      - passing `body.id` straight to `writeKeys` without `toCommandId`
//      - hard-coding `hasPendingApproval: () => false` (runs even while an approval card is shown)
//      - falling back to the inbox on failure
//    ⇒ **Call the endpoint and look at the bytes that reached the socket, and at the inbox**.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sessionCommand } from './command.ts'
import { config, configProblem, loadConfig } from '../config.ts'
import { discoverConfigDirs } from '../claude/configDirs.ts'
import { waitForDecision } from '../permission.ts'
import { HttpError, type Ctx } from '../router.ts'
import { aliveProcStartSync } from '../claude/sessionIndex.ts'

const RELAY = join(fileURLToPath(new URL('../../../scripts/', import.meta.url)), 'relay.py')
const hasPython = spawnSync('python3', ['-c', 'print(1)']).status === 0

/**
 * A Ctx for calling the endpoint.
 *
 * ★★ **Plant "a different command" in the body, query and headers** (reading from any of them would show).
 */
function ctxOf(id: string, body: Record<string, unknown> = { id }, session = 'sid'): Ctx {
  const payload = { ...body, text: '/exit', keys: '/exit', command: '/exit' }
  const req = Readable.from([Buffer.from(JSON.stringify(payload), 'utf8')]) as unknown as IncomingMessage
  Object.assign(req, { headers: { 'content-type': 'application/json', 'x-command': '/exit' } })
  return {
    req,
    res: {} as ServerResponse,
    url: new URL(`http://agent/sessions/${session}/command?id=exit`),
    params: { id: session },
    identity: { login: 'test@example.com', deviceId: '100.0.0.1', via: 'dev' },
  }
}

function fakeSock(path: string): Promise<{ server: Server; chunks: string[] }> {
  const chunks: string[] = []
  const server = createServer((s) => {
    s.setEncoding('utf8')
    s.on('data', (d: string) => chunks.push(d))
    s.on('error', () => {})
  })
  return new Promise((resolve) => server.listen(path, () => resolve({ server, chunks })))
}

/** Let relay.py write its own registration (tests that pass hand-built JSON are a false green) */
function registerPane(pid: number, sock: string, state: string): void {
  execFileSync(
    'python3',
    [
      '-c',
      `import importlib.util as u; spec=u.spec_from_file_location('r', ${JSON.stringify(RELAY)}); m=u.module_from_spec(spec); spec.loader.exec_module(m); m.register(${pid}, ${JSON.stringify(sock)})`,
    ],
    { env: { ...process.env, NYAN_REMOTE_STATE_DIR: state, PYTHONDONTWRITEBYTECODE: '1' } },
  )
}

interface Fixture {
  state: string
  chunks: string[]
  inboxChunks: string[]
  servers: Server[]
}

async function setup(session = 'sid'): Promise<Fixture> {
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-croute-'))
  const account = await mkdtemp(join(tmpdir(), 'nyan-remote-cacct-'))
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  await mkdir(join(account, 'projects'), { recursive: true })
  await mkdir(join(account, 'sessions'), { recursive: true })
  await writeFile(
    join(state, 'config.json'),
    JSON.stringify({
      allowedLogins: ['test@example.com'],
      configDirs: [account],
      // ⚠️⚠️ **Always include `hookToken`**. Without it the config goes into refuse mode, `configDirs` falls to null and
      //    `discoverConfigDirs` **looks at the real `~/.claude*`** = it could type into a real conversation
      hookToken: 'x'.repeat(40),
    }),
  )
  await loadConfig()
  assert.equal(configProblem(), null, 'config is in refuse mode (it would look at the real config)')
  assert.deepEqual(config().configDirs, [account])
  assert.deepEqual(
    (await discoverConfigDirs(config().configDirs)).map((d) => d.dir),
    [account],
    '⚠️⚠️ looking at the real ~/.claude* (danger of typing into a real session)',
  )

  const keysSock = join(state, 'keys.sock')
  const inboxSock = join(state, 'inbox.sock')
  const keys = await fakeSock(keysSock)
  const inbox = await fakeSock(inboxSock)
  await writeFile(
    join(account, 'sessions', `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId: session,
      cwd: '/tmp',
      status: 'busy',
      procStart: aliveProcStartSync(process.pid),
      // ★ The inbox destination (set up a state where it could fall back, then check it does not)
      messagingSocketPath: inboxSock,
    }),
  )
  registerPane(process.pid, keysSock, state)
  return { state, chunks: keys.chunks, inboxChunks: inbox.chunks, servers: [keys.server, inbox.server] }
}

function teardown(t: { after: (fn: () => void | Promise<void>) => void }, f: Fixture, prev: string | undefined): void {
  t.after(async () => {
    for (const s of f.servers) s.close()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(f.state, { recursive: true, force: true })
  })
}

test('★★★ calling the endpoint delivers only the table text (other commands in body / query / headers are not used)', { skip: !hasPython }, async (t) => {
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  const f = await setup()
  teardown(t, f, prev)
  const res = await sessionCommand(ctxOf('compact'))
  assert.equal(res.ok, true)
  assert.equal(res.id, 'compact')
  assert.ok(res.at.length > 0, 'no timestamp')
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(
    f.chunks.join(''),
    '/compact\r',
    `⚠️⚠️ the delivered bytes differ (reading from the body or query): ${JSON.stringify(f.chunks)}`,
  )
  assert.deepEqual(f.inboxChunks, [], '⚠️⚠️ something was sent to the inbox')
})

test('★★★ an id not in the table is 400 and writes not a single byte', { skip: !hasPython }, async (t) => {
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  const f = await setup()
  teardown(t, f, prev)
  await assert.rejects(
    () => sessionCommand(ctxOf('clear', { id: 'clear' })),
    (err: unknown) => err instanceof HttpError && err.status === 400,
  )
  // ⚠️⚠️ If this breaks, it becomes "an endpoint where the phone can type any command"
  await new Promise((r) => setTimeout(r, 200))
  assert.deepEqual(f.chunks, [], `wrote something for an id not in the table: ${JSON.stringify(f.chunks)}`)
  assert.deepEqual(f.inboxChunks, [], 'fell back to the inbox')
})

test('★★★ while an approval card is shown it refuses with 409 and writes not a single byte', { skip: !hasPython }, async (t) => {
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  const f = await setup()
  teardown(t, f, prev)
  // ★ Raise a real approval marker (this store is what `hasPendingForSession` looks at)
  void waitForDecision(
    {
      key: 'k-cmd',
      sessionId: 'sid',
      toolName: 'Bash',
      summary: 'ls',
      at: new Date().toISOString(),
      account: '.claude-test',
      project: 'p',
      machine: 'm',
    },
    // ⚠️ The second argument is the "abort registration" (does nothing). ⚠️ The point is to raise the marker
    () => {},
  )
  await assert.rejects(
    () => sessionCommand(ctxOf('exit')),
    (err: unknown) => err instanceof HttpError && err.status === 409,
  )
  await new Promise((r) => setTimeout(r, 200))
  assert.deepEqual(f.chunks, [], '⚠️⚠️ ran during an approval card (the pending approval would vanish)')
  assert.deepEqual(f.inboxChunks, [], 'fell back to the inbox')
})

test('★★★ even when the relay window does not respond, it does not fall back to the inbox (ends with 502)', { skip: !hasPython }, async (t) => {
  // ⚠️⚠️ The mutation codex named on 2026-08-25: fall back to the inbox right after a `keys.ts` failure.
  //    It could not be killed because there was no "destination found but write fails" case.
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  // ⚠️ Use a different session name (approval markers are **shared per module**, so
  //    a leftover `sid` marker from an earlier test would get it refused as pending-approval)
  const f = await setup('sid-dead')
  teardown(t, f, prev)
  // ★ Close only the keystroke window (keep the registration = the destination is found but cannot connect)
  await new Promise<void>((r) => f.servers[0]!.close(() => r()))
  await assert.rejects(
    () => sessionCommand(ctxOf('exit', { id: 'exit' }, 'sid-dead')),
    (err: unknown) => err instanceof HttpError && err.status === 502,
  )
  await new Promise((r) => setTimeout(r, 200))
  assert.deepEqual(f.inboxChunks, [], '⚠️⚠️ fell back to the inbox on failure (the model would execute it)')
})
