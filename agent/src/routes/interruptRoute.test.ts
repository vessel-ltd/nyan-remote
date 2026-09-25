// ★★★ Tests that **actually execute** the "stop" endpoint (codex 2026-08-24 pointed out a "false green").
//
// ⚠️⚠️ The old `interrupt.test.ts` was only a **text search over the source**, so it
//    stayed green even with these mutations:
//      - reading the key from **the query / headers** instead of the body
//      - hard-coding `hasPendingApproval: () => false` (types even while an approval card is shown)
//      - falling back to the inbox on failure
//    ⇒ **Call the endpoint and look at the bytes that reached the socket, and at the inbox**.
//
// ⚠️ Authentication is the single place in index.ts (auth.ts), so building the Ctx by hand is fine here
//    (checking identity is not this endpoint's responsibility).

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
import { sessionClear, sessionInterrupt } from './interrupt.ts'
import { sessionMessage } from './message.ts'
import { config, configProblem, loadConfig } from '../config.ts'
import { discoverConfigDirs } from '../claude/configDirs.ts'
import { waitForDecision } from '../permission.ts'
import { HttpError, type Ctx } from '../router.ts'
import { aliveProcStartSync } from '../claude/sessionIndex.ts'

const ESC = '\x1b'
const RELAY = join(fileURLToPath(new URL('../../../scripts/', import.meta.url)), 'relay.py')
const hasPython = spawnSync('python3', ['-c', 'print(1)']).status === 0

/**
 * A Ctx for calling the endpoint.
 *
 * ★★ **Plant a "CR" in the body, query and headers** (= reading from any of them would show).
 */
function ctxOf(id: string): Ctx {
  const req = Readable.from(['{"key":"\\r","text":"\\r"}']) as unknown as IncomingMessage
  Object.assign(req, { headers: { 'content-type': 'application/json', 'x-key': '\r' } })
  return {
    req,
    res: {} as ServerResponse,
    url: new URL(`http://agent/sessions/${encodeURIComponent(id)}/interrupt?key=%0D`),
    params: { id },
    identity: { login: 'test@example.com', deviceId: '100.0.0.1', via: 'dev' },
  }
}

/** ★ A Ctx with a body (`sessionMessage` reads the body, so this is separate from `ctxOf`) */
function bodyCtx(id: string, text: string): Ctx {
  // ⚠️ `readJsonBody` concatenates Buffers, so streaming a string gives a TypeError
  const req = Readable.from([Buffer.from(JSON.stringify({ text }), 'utf8')]) as unknown as IncomingMessage
  Object.assign(req, { headers: { 'content-type': 'application/json' } })
  return {
    req,
    res: {} as ServerResponse,
    url: new URL(`http://agent/sessions/${encodeURIComponent(id)}/message`),
    params: { id },
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
  keysSock: string
  inboxSock: string
  chunks: string[]
  inboxChunks: string[]
  servers: Server[]
}

/**
 * Set up a state where the endpoint can run through the real config.
 *
 * ★ Write `configDirs` to config.json and go through `loadConfig()` (no mock to dodge
 *   `config()`'s exception = go through the real path).
 * ★ The index also gets **the inbox socket** (= set up a state where it could fall back, then check it does not).
 */
async function setup(sessionId: string, opts: { relay?: boolean; status?: string } = {}): Promise<Fixture> {
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-iroute-'))
  const account = await mkdtemp(join(tmpdir(), 'nyan-remote-iacct-'))
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  await mkdir(join(account, 'projects'), { recursive: true })
  await mkdir(join(account, 'sessions'), { recursive: true })
  await writeFile(
    join(state, 'config.json'),
    JSON.stringify({
      allowedLogins: ['test@example.com'],
      configDirs: [account],
      // ⚠️⚠️ **Always include `hookToken`** (I tripped on this myself on 2026-08-24). Without it the config is
      //    judged "corrupt" and goes into **refuse mode**, so `config().configDirs`
      //    falls to `null` ⇒ `discoverConfigDirs` **looks at the real `~/.claude*`**.
      //    = the test **could type ESC into a real conversation** (the prohibition at the top of this document).
      hookToken: 'x'.repeat(40),
    }),
  )
  await loadConfig()
  // ★ Safety valve: not in refuse mode, and looking **only at this working directory**
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
      sessionId,
      cwd: '/tmp',
      status: opts.status ?? 'busy',
      procStart: aliveProcStartSync(process.pid),
      // ★ The inbox destination (a state where it could fall back)
      messagingSocketPath: inboxSock,
    }),
  )
  if (opts.relay !== false) registerPane(process.pid, keysSock, state)
  return {
    state,
    keysSock,
    inboxSock,
    chunks: keys.chunks,
    inboxChunks: inbox.chunks,
    servers: [keys.server, inbox.server],
  }
}

test('★★★ calling the endpoint delivers only ESC + (if responding) Ctrl-U (the CR in body / query / headers is not used)', { skip: !hasPython }, async (t) => {
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  const f = await setup('sid-route')
  t.after(async () => {
    for (const s of f.servers) s.close()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(f.state, { recursive: true, force: true })
  })
  const res = await sessionInterrupt(ctxOf('sid-route'))
  assert.equal(res.ok, true)
  assert.ok(res.at.length > 0, 'no timestamp')
  // ★★ It was responding (index status busy), so the input box is also cleared after stopping (2026-09-24)
  assert.equal(res.cleared, true, '⚠️⚠️ stopped mid-response but did not clear the input box (the next keystrokes join the restored text)')
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(
    f.chunks.join(''),
    ESC + '\x15',
    `⚠️⚠️ something other than ESC and Ctrl-U arrived (reading bytes from the body or query): ${JSON.stringify(f.chunks)}`,
  )
  // ⚠️⚠️ They arrive as **separate writes** (arriving back to back, ESC is read as "Alt + Ctrl-U" and does not stop / confirmed on a real device)
  assert.equal(f.chunks[0], ESC, `⚠️⚠️ ESC and Ctrl-U arrived in a single write: ${JSON.stringify(f.chunks)}`)
  assert.deepEqual(f.inboxChunks, [], '⚠️⚠️ something was sent to the inbox')
})

test('★★ a session that is not responding gets ESC only (clearing the input box would only erase the PC\'s half-typed text / 2026-09-24)', { skip: !hasPython }, async (t) => {
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  const f = await setup('sid-idle', { status: 'idle' })
  t.after(async () => {
    for (const s of f.servers) s.close()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(f.state, { recursive: true, force: true })
  })
  const res = await sessionInterrupt(ctxOf('sid-idle'))
  assert.equal(res.ok, true)
  assert.equal(res.cleared, undefined)
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(f.chunks.join(''), ESC, `⚠️⚠️ cleared the input box although it was not responding: ${JSON.stringify(f.chunks)}`)
})

test('★★★ while an approval card is shown it refuses with 409 and writes not a single byte', { skip: !hasPython }, async (t) => {
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  const f = await setup('sid-perm-route')
  t.after(async () => {
    for (const s of f.servers) s.close()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(f.state, { recursive: true, force: true })
  })
  // ★ Raise a real approval marker (this store is what `hasPendingForSession` looks at)
  void waitForDecision(
    {
      key: 'k-route',
      sessionId: 'sid-perm-route',
      toolName: 'Bash',
      summary: 'ls',
      at: new Date().toISOString(),
      account: '.claude-test',
      project: 'p',
      machine: 'm',
    },
    () => {},
  )
  await assert.rejects(
    () => sessionInterrupt(ctxOf('sid-perm-route')),
    (err: unknown) => {
      assert.ok(err instanceof HttpError, `not an HttpError: ${String(err)}`)
      assert.equal(err.status, 409)
      assert.match(err.message, /承認/)
      return true
    },
  )
  await new Promise((r) => setTimeout(r, 150))
  assert.deepEqual(f.chunks, [], '⚠️⚠️ sends ESC during an approval card')
  assert.deepEqual(f.inboxChunks, [], '⚠️⚠️ falls back to the inbox')
})

test('★★★ a session that cannot take keystrokes is simply refused (no fallback to the inbox)', { skip: !hasPython }, async (t) => {
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  const f = await setup('sid-norelay-route', { relay: false })
  t.after(async () => {
    for (const s of f.servers) s.close()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(f.state, { recursive: true, force: true })
  })
  await assert.rejects(
    () => sessionInterrupt(ctxOf('sid-norelay-route')),
    (err: unknown) => {
      assert.ok(err instanceof HttpError)
      assert.equal(err.status, 409)
      // ★ It must be a reply to a "stop" request (rejects reuse of the keystroke wording)
      assert.match(err.message, /止められません/)
      return true
    },
  )
  await new Promise((r) => setTimeout(r, 150))
  assert.deepEqual(f.inboxChunks, [], '⚠️⚠️ sends to the inbox when it cannot stop (arrives as an instruction)')
})

test('★★★ a body starting with `/` never reaches the inbox, even for a session without keystrokes (codex 2026-08-24, high #2)', async (t) => {
  // ⚠️⚠️ **You cannot notice without executing the endpoint** (with only a test calling the pure function `inboxRefusal` directly,
  //    a mutation removing the call stayed green / it actually survived on 2026-08-24).
  //    ⇒ **Run `sessionMessage` with the real config** and check that nothing reaches the inbox socket.
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  // ★ Do not register the relay (= keystrokes fail with `no-relay`, taking the path that falls back to the inbox)
  const f = await setup('sid-inbox-slash', { relay: false })
  t.after(async () => {
    for (const s of f.servers) s.close()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(f.state, { recursive: true, force: true })
  })
  for (const text of ['/tes', '!ls', '\u200b/help']) {
    await assert.rejects(
      () => sessionMessage(bodyCtx('sid-inbox-slash', text)),
      (err: unknown) => {
        assert.ok(err instanceof HttpError, `not an HttpError: ${String(err)}`)
        assert.equal(err.status, 409, JSON.stringify(text))
        return true
      },
      `would hand it to the inbox: ${JSON.stringify(text)}`,
    )
  }
  await new Promise((r) => setTimeout(r, 200))
  assert.deepEqual(
    f.inboxChunks,
    [],
    `⚠️⚠️ it reached the inbox (the receiving model would execute it): ${JSON.stringify(f.inboxChunks)}`,
  )
})

test('★★ ordinary sentences still reach the inbox as before (better than not arriving / the mac escape hatch)', async (t) => {
  // ⚠️⚠️ The first version was a **loose reachability check** ("success unless it is the refusal message"), so
  //    **a mutation passing an empty string to the inbox stayed green** (named by codex on 2026-08-24 → it actually survived).
  //    ⇒ Look at **the route and the body that actually reached the inbox**.
  // ⚠️ This test does not need python (no relay is registered). `skip` was removed (same review, low #1)
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  const f = await setup('sid-inbox-ok', { relay: false })
  t.after(async () => {
    for (const s of f.servers) s.close()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(f.state, { recursive: true, force: true })
  })
  const res = await sessionMessage(bodyCtx('sid-inbox-ok', 'ふつうの指示です'))
  assert.equal(res.route, 'inbox', 'the inbox escape hatch is gone')
  // ⚠️ It reaches the socket a little later (`sendToSession` does not wait for a response)
  for (let i = 0; i < 50 && f.inboxChunks.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 20))
  }
  const seen = f.inboxChunks.join('')
  assert.match(seen, /ふつうの指示です/, `⚠️ the body did not reach the inbox: ${JSON.stringify(seen)}`)
  // ★ The receiver can see "who from" (kept in `origin.from`)
  assert.match(seen, /nyan-remote\(/, 'no sender identification')
})

test('★★★ sending a `/`-prefixed body via keystrokes puts `neutralized` on the wire (so the UI can say so)', { skip: !hasPython }, async (t) => {
  // ⚠️ The UI can say "a leading space was added" only because this flag arrives.
  //    ⚠️ Even if the flag is dropped, **the send itself succeeds**, so without a test it goes unnoticed (a silent rewrite).
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  const f = await setup('sid-neu')
  t.after(async () => {
    for (const s of f.servers) s.close()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(f.state, { recursive: true, force: true })
  })
  const res = await sessionMessage(bodyCtx('sid-neu', '/compact'))
  assert.equal(res.route, 'keys')
  assert.equal(res.neutralized, true, '⚠️ the flag is dropped (the UI would have rewritten it silently)')
  await new Promise((r) => setTimeout(r, 250))
  // ★ Also look at the bytes actually sent (one space + body + CR)
  assert.equal(f.chunks.join(''), ' /compact\r', JSON.stringify(f.chunks))
  assert.deepEqual(f.inboxChunks, [], 'it went to the inbox')
})

test('★ ordinary sentences do not raise the flag (do not say "rewritten" every time)', { skip: !hasPython }, async (t) => {
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  const f = await setup('sid-plainkeys')
  t.after(async () => {
    for (const s of f.servers) s.close()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(f.state, { recursive: true, force: true })
  })
  const res = await sessionMessage(bodyCtx('sid-plainkeys', 'ふつうの指示'))
  assert.equal(res.route, 'keys')
  assert.equal(res.neutralized, undefined)
  await new Promise((r) => setTimeout(r, 250))
  assert.equal(f.chunks.join(''), 'ふつうの指示\r')
})

test('★★★ clear-input endpoint: only Ctrl-U arrives, and during an approval card it is 409 and writes not a single byte', { skip: !hasPython }, async (t) => {
  // ⚠️⚠️ Structure tests (text search) alone let a mutation hard-coding `hasPendingApproval: () => false`
  //    stay green (confirmed with my own mutation on 2026-08-25). ⇒ Execute the endpoint.
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  const f = await setup('sid-clear-route')
  t.after(async () => {
    for (const s of f.servers) s.close()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(f.state, { recursive: true, force: true })
  })
  const res = await sessionClear(ctxOf('sid-clear-route'))
  assert.equal(res.ok, true)
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(f.chunks.join(''), '\x15', `the delivered bytes differ: ${JSON.stringify(f.chunks)}`)
  assert.deepEqual(f.inboxChunks, [], '⚠️⚠️ something was sent to the inbox')

  // ★ Raise a real approval marker (this store is what `hasPendingForSession` looks at)
  void waitForDecision(
    {
      key: 'k-clear',
      sessionId: 'sid-clear-route',
      toolName: 'Bash',
      summary: 'ls',
      at: new Date().toISOString(),
      account: '.claude-test',
      project: 'p',
      machine: 'm',
    },
    () => {},
  )
  const before = f.chunks.length
  await assert.rejects(
    () => sessionClear(ctxOf('sid-clear-route')),
    (err: unknown) => err instanceof HttpError && err.status === 409,
  )
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(f.chunks.length, before, '⚠️⚠️ touches the input box during an approval card')
})
