// ★★ The path for the table's slash commands (`/compact` / `/exit`).
//
// ⚠️⚠️ This is **more dangerous than typing** (a real command runs, and `/exit` is irreversible).
//    The things to protect, listed first:
//
//   1. **The characters live in one place, the table** (`SLASH_COMMANDS`). The argument is only a `CommandId`, and
//      **there is no path that accepts a string** (free input can never get through)
//   2. ⚠️ **Do not go through `sanitizeForKeys`** (it adds a space and turns it into "just text" =
//      not executed). ⇒ Check the bytes that reach the socket (tests that pass hand-made values are a false green)
//   3. **Refuse while an approval card is up or while `waiting`**
//   4. **Refuse rapid repeats** (⚠️ **a separate bucket from "stop"**. ⚠️ Remember only successful sends)
//   5. **Never drop failures into the inbox** (a dropped `/compact` gets executed by the model as a request)
//   6. **Log only the id** (never the body = the characters sent)

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CONTROL_COOLDOWN_MS,
  SLASH_COMMANDS,
  sanitizeForKeys,
  sendCommandToSession,
  sendControlToSession,
} from './keys.ts'
import { aliveProcStartSync } from './sessionIndex.ts'
import type { ConfigDir } from './configDirs.ts'

const RELAY = join(fileURLToPath(new URL('../../../scripts/', import.meta.url)), 'relay.py')
const hasPython = spawnSync('python3', ['-c', 'print(1)']).status === 0

const dirOf = (base: string): ConfigDir => ({
  account: '.claude-test',
  dir: base,
  projectsDir: join(base, 'projects'),
})

async function fakeIndex(pid: number, sessionId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'nyan-remote-cmd-'))
  await mkdir(join(base, 'sessions'), { recursive: true })
  await writeFile(
    join(base, 'sessions', `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd: '/tmp', status: 'busy', procStart: aliveProcStartSync(pid), ...extra }),
  )
  return base
}

function fakePane(path: string): Promise<{ server: Server; chunks: string[] }> {
  const chunks: string[] = []
  const server = createServer((sock) => {
    sock.setEncoding('utf8')
    sock.on('data', (d: string) => chunks.push(d))
    sock.on('error', () => {})
  })
  return new Promise((resolve) => server.listen(path, () => resolve({ server, chunks })))
}

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

interface Fix {
  base: string
  state: string
  sock: string
  chunks: string[]
  server: Server
}

async function setup(sessionId: string, extra: Record<string, unknown> = {}): Promise<Fix> {
  const base = await fakeIndex(process.pid, sessionId, extra)
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-cmds-'))
  const sock = join(state, 'c.sock')
  const { server, chunks } = await fakePane(sock)
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  registerPane(process.pid, sock, state)
  return { base, state, sock, chunks, server }
}

function cleanup(t: { after: (fn: () => void | Promise<void>) => void }, f: Fix, prev: string | undefined): void {
  t.after(async () => {
    f.server.close()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(f.base, { recursive: true, force: true })
    await rm(f.state, { recursive: true, force: true })
  })
}

test('★★★ SLASH_COMMANDS: the table has exactly two entries, contains no CR, and is not neutralized', () => {
  assert.deepEqual(Object.keys(SLASH_COMMANDS), ['compact', 'exit'])
  for (const [id, text] of Object.entries(SLASH_COMMANDS)) {
    assert.ok(text.startsWith('/'), `${id} does not start with / (would not run)`)
    assert.ok(!text.includes('\r'), `${id} contains a CR (writeKeys sends that)`)
    assert.ok(!text.includes('\n'), `${id} contains an LF`)
    // ⚠️⚠️ This is the essence: **going through the free-input path turns it into something else** (a space is added)
    const via = sanitizeForKeys(text)
    assert.ok(via.ok && via.value.text !== text, `${id} is unchanged by sanitizeForKeys (the premise broke)`)
  }
})

test('★★★ /compact reaches the socket as "/compact" + CR (no space added)', { skip: !hasPython }, async (t) => {
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  const f = await setup('sid-cmd-ok')
  cleanup(t, f, prev)
  const r = await sendCommandToSession([dirOf(f.base)], 'sid-cmd-ok', 'compact', {
    hasPendingApproval: () => false,
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  await new Promise((res) => setTimeout(res, 400))
  assert.equal(
    f.chunks.join(''),
    '/compact\r',
    `⚠️⚠️ the bytes that arrived differ (with a space it would not run): ${JSON.stringify(f.chunks)}`,
  )
})

test('★★ writes not a single byte while an approval card is shown', { skip: !hasPython }, async (t) => {
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  const f = await setup('sid-cmd-perm')
  cleanup(t, f, prev)
  const r = await sendCommandToSession([dirOf(f.base)], 'sid-cmd-perm', 'exit', {
    hasPendingApproval: () => true,
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'pending-approval', JSON.stringify(r))
  await new Promise((res) => setTimeout(res, 150))
  assert.equal(f.chunks.length, 0, '⚠️⚠️ executed during an approval card')
})

test('★★ refuses when the CLI is showing a dialog and waiting', { skip: !hasPython }, async (t) => {
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  const f = await setup('sid-cmd-wait', { status: 'waiting' })
  cleanup(t, f, prev)
  const r = await sendCommandToSession([dirOf(f.base)], 'sid-cmd-wait', 'compact', {
    hasPendingApproval: () => false,
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'waiting', JSON.stringify(r))
  assert.equal(f.chunks.length, 0)
})

test('★★★ refuses rapid repeats (⚠️ a separate bucket from "stop")', { skip: !hasPython }, async (t) => {
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  const f = await setup('sid-cmd-fast')
  cleanup(t, f, prev)
  const ctx = { hasPendingApproval: () => false }
  let clock = 1_000_000
  const now = (): number => clock
  const first = await sendCommandToSession([dirOf(f.base)], 'sid-cmd-fast', 'compact', ctx, { now })
  assert.equal(first.ok, true, JSON.stringify(first))
  clock += CONTROL_COOLDOWN_MS - 1
  const second = await sendCommandToSession([dirOf(f.base)], 'sid-cmd-fast', 'exit', ctx, { now })
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'too-soon', JSON.stringify(second))
  // ★★★ **"Stop" is a separate bucket** (2026-08-25 codex, medium #3).
  //   ⚠️⚠️ They were shared, so **the emergency stop did not work for 1.5 seconds right after `/compact`**.
  //   The danger of two ESCs in a row is handled on the ESC side (rapid-repeat prevention can be independent per operation).
  const stop = await sendControlToSession([dirOf(f.base)], 'sid-cmd-fast', 'escape', ctx, { now })
  assert.equal(stop.ok, true, `⚠️⚠️ cannot stop right after a command: ${JSON.stringify(stop)}`)
  // ⚠️ Passes after waiting
  clock += CONTROL_COOLDOWN_MS
  const third = await sendCommandToSession([dirOf(f.base)], 'sid-cmd-fast', 'compact', ctx, { now })
  assert.equal(third.ok, true, JSON.stringify(third))
  await new Promise((res) => setTimeout(res, 400))
  assert.equal(
    f.chunks.join(''),
    '/compact\r\x1b/compact\r',
    `sent too much / did not send: ${JSON.stringify(f.chunks)}`,
  )
})

test('★★ does not remember failures (the first try right after a refusal is not dropped)', { skip: !hasPython }, async (t) => {
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  const f = await setup('sid-cmd-nofail', { status: 'waiting' })
  cleanup(t, f, prev)
  const ctx = { hasPendingApproval: () => false }
  const clock = 2_000_000
  const now = (): number => clock
  const bad = await sendCommandToSession([dirOf(f.base)], 'sid-cmd-nofail', 'compact', ctx, { now })
  assert.equal(bad.reason, 'waiting')
  // ⚠️ If a failure were remembered as "sent", this would be too-soon (= never delivered)
  const again = await sendCommandToSession([dirOf(f.base)], 'sid-cmd-nofail', 'compact', ctx, { now })
  assert.equal(again.reason, 'waiting', `remembers the failure: ${JSON.stringify(again)}`)
})

test('★★ the log holds only route:"command" and the id (not the characters sent)', { skip: !hasPython }, async (t) => {
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  const f = await setup('sid-cmd-note')
  cleanup(t, f, prev)
  const r = await sendCommandToSession([dirOf(f.base)], 'sid-cmd-note', 'exit', {
    hasPendingApproval: () => false,
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  const log = await readFile(join(f.state, 'sent.jsonl'), 'utf8')
  const line = log.trim().split('\n').at(-1) ?? ''
  const rec = JSON.parse(line) as Record<string, unknown>
  assert.equal(rec['route'], 'command')
  assert.equal(rec['id'], 'exit')
  assert.equal(rec['sessionId'], 'sid-cmd-note')
  // ⚠️⚠️ The characters sent themselves (`/exit`) are not written (keep the §6.2 shape)
  assert.ok(!line.includes('/exit'), `the body is in the log: ${line}`)
})

test('★ does not send to a session that is not running (not-found)', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'nyan-remote-cmdnf-'))
  await mkdir(join(base, 'sessions'), { recursive: true })
  t.after(() => rm(base, { recursive: true, force: true }))
  const r = await sendCommandToSession([dirOf(base)], 'sid-nope', 'compact', {
    hasPendingApproval: () => false,
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not-found', JSON.stringify(r))
})

test('★★★ writes not a single byte if an approval appears "after" the destination lookup (re-reads)', { skip: !hasPython }, async (t) => {
  // ⚠️⚠️ An approval can appear **during the destination lookup I/O** (the hook comes from another process).
  //    Deciding on a value read once would **type only the body** of `/compact` (the CR is
  //    stopped by `beforeSubmit`, so the command stays in the PC's input box = it runs when a person presses Enter).
  //    ⇒ `KeysContext` is a function, so it **can be re-read**. Check that it re-reads with
  //       a ctx that returns "false the first time, true afterwards".
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  const f = await setup('sid-cmd-late')
  cleanup(t, f, prev)
  let asked = 0
  const r = await sendCommandToSession([dirOf(f.base)], 'sid-cmd-late', 'compact', {
    hasPendingApproval: () => {
      asked += 1
      return asked > 1
    },
  })
  assert.ok(asked >= 2, `checked for approvals only once (asked=${asked})`)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'pending-approval', JSON.stringify(r))
  await new Promise((res) => setTimeout(res, 300))
  assert.deepEqual(
    f.chunks,
    [],
    `⚠️⚠️ typed only the body (the command stays in the PC's input box): ${JSON.stringify(f.chunks)}`,
  )
})

test('★★★ /exit also arrives exactly as in the table (a compact-only test stays green if the table is swapped)', { skip: !hasPython }, async (t) => {
  // ⚠️ The mutation named by codex on 2026-08-25: `exit: '/exit'` → `'/compact'`.
  //    Only the `/compact` side's delivered bytes were checked, so it stayed green.
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  const f = await setup('sid-cmd-exit')
  cleanup(t, f, prev)
  const r = await sendCommandToSession([dirOf(f.base)], 'sid-cmd-exit', 'exit', {
    hasPendingApproval: () => false,
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  await new Promise((res) => setTimeout(res, 400))
  assert.equal(f.chunks.join(''), '/exit\r', `the bytes that arrived differ: ${JSON.stringify(f.chunks)}`)
})

test('★★★ does not send CR if an approval appears "after" the body was written (= it stays in the input box)', { skip: !hasPython }, async (t) => {
  // ⚠️⚠️ **This window cannot be eliminated** (2026-08-25 codex, high #3. Reproduced by measurement).
  //    If an approval appears within the 120ms of "body → 120ms → CR", it stops **with only the body typed**
  //    (`beforeSubmit`). ⇒ `/exit` stays in the PC's input box and **runs when a person presses Enter**.
  //    ⇒ Since it cannot be eliminated, **the `partial` message says so** (the message test below).
  // ★ What we want to pin here is "**no CR was sent**" (= the wiring is alive).
  //    ⚠️ The existing test returned true on the 2nd check, so it never went through this window (the 3rd).
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  const f = await setup('sid-cmd-window')
  cleanup(t, f, prev)
  // ⚠️ Approvals are checked **4 times** (start, after the destination lookup, **right before writing the body**, right before CR).
  //    ★ The 3rd (right before writing the body) was added in 2026-08-25 codex round 7, medium #4.
  //    ⇒ To hit this window (body written but CR stopped), raise it on **the 4th**.
  let asked = 0
  const r = await sendCommandToSession([dirOf(f.base)], 'sid-cmd-window', 'exit', {
    hasPendingApproval: () => {
      asked += 1
      return asked >= 4
    },
  })
  assert.equal(asked, 4, `approval was not checked 4 times: ${asked}`)
  assert.equal(r.reason, 'partial', JSON.stringify(r))
  await new Promise((res) => setTimeout(res, 400))
  assert.equal(
    f.chunks.join(''),
    '/exit',
    `⚠️⚠️ sends CR (Enter lands on the approval card): ${JSON.stringify(f.chunks)}`,
  )
  // ⚠️ The message must say it "remains" (pressing Enter runs it, so it must not stay silent)
  assert.match(r.message ?? '', /残って/, `the partial message does not describe what happened: ${r.message}`)
  assert.match(r.message ?? '', /Enter/, `does not say pressing Enter will run it: ${r.message}`)
})

test('★★★ the command path in keys.ts knows nothing of the inbox (forbidden by structure / including dynamic import)', () => {
  // ⚠️⚠️ The mutation named by codex on 2026-08-25: right after a failure, add
  //    `await (await import('./inbox.ts')).sendToSession(...)`.
  //    The structural test of the endpoint (`routes/command.ts`) **only read that file**, so it stayed green.
  const src = readFileSync(new URL('./keys.ts', import.meta.url), 'utf8')
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n')
  assert.ok(!/inbox/i.test(code), '⚠️⚠️ keys.ts references the inbox')
  assert.ok(!/sendToSession\b/.test(code), '⚠️⚠️ calls the inbox send')
  // ⚠️ No dynamic import at all (having one opens a path to "add the inbox later")
  assert.ok(!/\bimport\s*\(/.test(code), '⚠️⚠️ has a dynamic import')
})

test('★★★ commands to the same session are serialized (nothing cuts in between body and CR)', { skip: !hasPython }, async (t) => {
  // ⚠️ The mutation named by codex: remove `serializeBySession(...)`.
  //    ★ **Deliberately build the dangerous interleaving** (merely calling concurrently stays green / lesson of 2026-08-24).
  //    ⇒ Fire the second **after the first body is written and before its CR** (inside the 120ms window).
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  const f = await setup('sid-cmd-serial')
  cleanup(t, f, prev)
  const ctx = { hasPendingApproval: () => false }
  // ⚠️ To avoid the rapid-repeat gate, pass **a separate clock per call** (what we want to see is the serialization).
  //   ⚠️⚠️ Advancing a single variable makes the first call's "sent time" **the already-advanced value**, so
  //      the second is refused as `too-soon` and **it nearly went green without checking serialization** (we actually hit this).
  const first = sendCommandToSession([dirOf(f.base)], 'sid-cmd-serial', 'compact', ctx, {
    now: () => 3_000_000,
  })
  await new Promise((res) => setTimeout(res, 60))
  const second = sendCommandToSession([dirOf(f.base)], 'sid-cmd-serial', 'exit', ctx, {
    now: () => 3_000_000 + 10 * CONTROL_COOLDOWN_MS,
  })
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.ok, true, JSON.stringify(a))
  assert.equal(b.ok, true, JSON.stringify(b))
  await new Promise((res) => setTimeout(res, 300))
  const seen = f.chunks.join('')
  // ⚠️⚠️ This is the point: **no other command got in between the body and the CR**
  assert.ok(!seen.includes('/compact/exit'), `⚠️⚠️ something cut in: ${JSON.stringify(seen)}`)
  assert.equal(seen, '/compact\r/exit\r', `unexpected delivered shape: ${JSON.stringify(seen)}`)
})

test('★★ a command passes right after "stop" (no shared bucket in the reverse direction either)', { skip: !hasPython }, async (t) => {
  // ⚠️ The mutation named by codex: add `lastCommandAt.set(...)` next to `lastControlAt.set(...)`
  //    (command→stop was measured, but **stop→command was not**)
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  const f = await setup('sid-cmd-rev')
  cleanup(t, f, prev)
  const ctx = { hasPendingApproval: () => false }
  const clock = 4_000_000
  const now = (): number => clock
  const stop = await sendControlToSession([dirOf(f.base)], 'sid-cmd-rev', 'escape', ctx, { now })
  assert.equal(stop.ok, true, JSON.stringify(stop))
  const cmd = await sendCommandToSession([dirOf(f.base)], 'sid-cmd-rev', 'compact', ctx, { now })
  assert.equal(cmd.ok, true, `⚠️ a command does not pass right after stopping: ${JSON.stringify(cmd)}`)
})

test('★★★ the retracted claim (fail-safe) has not crept back into comments', () => {
  // ⚠️⚠️ "Even if concatenated with the draft, it only adds a message = fail-safe" is **wrong** (a CR is sent at the end, so
  //    if the draft starts with `!` it runs in bash mode / 2026-08-25 codex, high #1).
  //    ★ This claim was **written back 3 times** (implementation comments, ARCHITECTURE, HANDOFF), so a machine checks it.
  // ⇒ Rule: any line containing these words must be **written together with "誤り" (wrong) or ⚠️** (= a retraction).
  // ★ English phrasings too (the comments were translated on 2026-09-25 — without these the guard only caught 'fail-safe')
  const claims = ['fail-safe', '発言が増えるだけ', '発言として送られるだけ', '発言が1つ増えるだけ', 'only adds a message', 'just adds a message', 'only sends a message', 'harmless extra message']
  for (const file of ['keys.ts', 'log.ts']) {
    const src = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    for (const [i, line] of src.split('\n').entries()) {
      for (const claim of claims) {
        if (!line.includes(claim)) continue
        assert.ok(
          line.includes('誤り') || line.includes('⚠️') || /\bwrong\b/i.test(line),
          `${file}:${i + 1}: the retracted claim is back: ${line.trim()}`,
        )
      }
    }
  }
})

test('★★★ returns "awaiting approval" if an approval appears right before writing the body (not disguised as unreachable)', { skip: !hasPython }, async (t) => {
  // ⚠️⚠️ 2026-08-25 codex round 8, medium #1. An approval found at `beforeWrite` (the 3rd check) was
  //    squashed into `unreachable` (safe since not a byte is written, but **the reason was a lie**:
  //    the screen said "the endpoint is not responding", HTTP 502, and the log said `unreachable`).
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  const f = await setup('sid-cmd-before')
  cleanup(t, f, prev)
  let asked = 0
  const r = await sendCommandToSession([dirOf(f.base)], 'sid-cmd-before', 'exit', {
    hasPendingApproval: () => {
      asked += 1
      // ★ 3rd = right before writing the body (1st = start / 2nd = after the destination lookup)
      return asked >= 3
    },
  })
  assert.equal(asked, 3, `not checked 3 times: ${asked}`)
  assert.equal(r.reason, 'pending-approval', `the reason is disguised: ${JSON.stringify(r)}`)
  await new Promise((res) => setTimeout(res, 300))
  assert.deepEqual(f.chunks, [], `must not write a single byte: ${JSON.stringify(f.chunks)}`)
})
