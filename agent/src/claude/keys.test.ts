// The path that delivers text as keystrokes (§9.7.2).
//
// ★ No real Claude Code needed. **Start a UNIX socket server and observe the round trip**
//   (typing into the real thing puts text into a real conversation. Tests must never do that).
//
// ⚠️ Four things to protect here:
//   1. **Write not a single byte while an approval card is showing** (a digit could become a choice)
//   2. Do not stream `/` `!` or control characters as keystrokes (ESC getting through moves the choices)
//   3. Do not type into **a dead pid / a reused pid / a broken announcement**
//   4. ★ **Have relay.py actually write the announcement it writes, then read it**
//      (a test that passes hand-made JSON is a false green / VERIFY.md "mistake type 3")

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  MAX_KEYS_BYTES,
  findPane,
  sanitizeForKeys,
  sendKeysToSession,
  writeKeys,
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

/** Create a single CLI index entry. ★ procStart is taken **the same way the implementation reads it** (not written by hand) */
async function fakeIndex(
  pid: number,
  sessionId: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'nyan-remote-keys-'))
  await mkdir(join(base, 'sessions'), { recursive: true })
  const procStart = aliveProcStartSync(pid)
  await writeFile(
    join(base, 'sessions', `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd: '/tmp', status: 'idle', procStart, ...extra }),
  )
  return base
}

/**
 * A server pretending to be the keystroke endpoint. Accumulates received bytes in order.
 *
 * ⚠️⚠️ **Always close it in `t.after`** (I hit this myself on 2026-08-22). If an assert fails,
 *    `server.close()` is never reached and **the listener stays alive so `node --test` never finishes**.
 *    = **the test "hangs" instead of "failing"** (in CI the cause is invisible).
 */
function fakePane(
  path: string,
  opts: { dieAfterBody?: boolean } = {},
): Promise<{ server: Server; chunks: string[] }> {
  const chunks: string[] = []
  const server = createServer((sock) => {
    sock.setEncoding('utf8')
    sock.on('data', (d: string) => {
      chunks.push(d)
      // ★ Disconnect right after receiving the body = **the only way to produce `partial`**
      //   (review 2026-08-23: not a single test produced a `partial`)
      if (opts.dieAfterBody) sock.destroy()
    })
    sock.on('error', () => {})
  })
  return new Promise((resolve) => {
    server.listen(path, () => resolve({ server, chunks }))
  })
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return cond()
}

// ---------------------------------------------------------------- sanitize

test('★★★ a leading `/` `!` is neutralized with "one space" and sent as keystrokes (measured 2026-08-24)', () => {
  // ★★★ **Measured on the real machine (2.1.241) on 2026-08-24**:
  //    `␣/help` → "it was not executed because of the leading space; it arrived as a plain message"
  //    `␣!ls`   → "the leading space means the ! prefix has no effect"
  //    ⇒ **One space disables the CLI's command interpretation.**
  //
  // ⚠️⚠️ It used to "refuse and drop into the inbox". But the inbox **does more than add a frame**:
  //    the receiving model treats it as "a request from a peer" and **actually executes it** (measured: a `/tes`
  //    dropped into the inbox ran `make test` / `!ls` ran ls).
  //    And even **ordinary sentences** like "look at /home/..." were dropped.
  // ⇒ **Neither drop nor refuse. Add one space and send as keystrokes.**
  //    Running something as a real command happens only via the table (`SLASH_COMMANDS`) + a dedicated endpoint.
  const a = sanitizeForKeys('/compact')
  assert.ok(a.ok)
  if (a.ok) {
    assert.equal(a.value.text, ' /compact')
    assert.equal(a.value.neutralized, true)
  }
  const b = sanitizeForKeys('!ls')
  assert.ok(b.ok)
  if (b.ok) assert.equal(b.value.text, ' !ls')
  // ★ Ordinary sentences are left alone
  const c = sanitizeForKeys('これを見て')
  assert.ok(c.ok)
  if (c.ok) {
    assert.equal(c.value.text, 'これを見て')
    assert.ok(!c.value.neutralized)
  }
  // ★ Ordinary sentences starting with a path **can be sent** too (previously they fell into the inbox)
  const d = sanitizeForKeys('/home/user/webserv を見て')
  assert.ok(d.ok)
  if (d.ok) assert.equal(d.value.text, ' /home/user/webserv を見て')
})

test('★★★ neutralizing "drops leading whitespace and newlines first", then puts one space', () => {
  // ⚠️⚠️ Passing `\n/help` through gives **an empty line 1 and `/help` on line 2**.
  //    We have **not measured** whether the CLI looks at the start of the whole input or at line 1, so
  //    normalize to a form (` /help`) that puts `/` **neither at a line start nor at the input start**.
  for (const raw of ['  /compact', '\n/compact', '\t/compact', '\n\n  /compact']) {
    const r = sanitizeForKeys(raw)
    assert.ok(r.ok, raw)
    if (r.ok) assert.equal(r.value.text, ' /compact', JSON.stringify(raw))
  }
})

test('★★★ a leading invisible character does not slip past neutralization (2026-08-24)', () => {
  // ⚠️⚠️ `trimStart()` only drops Unicode **whitespace**. Measured (node):
  //    U+FEFF (BOM) / U+3000 (ideographic space) are dropped, but
  //    **U+200B (zero width) / U+200C / U+200D / U+2060 are not**.
  //    ⇒ With a naive check, `\u200b/help` looks like "an ordinary sentence" and **is sent as is**.
  //    Whether the CLI treats it as a command is **unmeasured**, so
  //    **always settle on** "the form measured to be safe" (one leading space, then `/`).
  // ★ Exhaustive (listing one by one always misses some. A VERIFY mistake type)
  const prefixes = [
    '',
    ' ',
    '  ',
    '\t',
    '\n',
    '\u00a0', // NBSP
    '\u3000', // ideographic (full-width) space
    '\ufeff', // BOM
    '\u200b', // zero-width space
    '\u200c',
    '\u200d',
    '\u2060', // word joiner
    ' \u200b \n\u2060',
  ]
  let checked = 0
  for (const p of prefixes) {
    for (const body of ['/compact', '!ls'] as const) {
      const r = sanitizeForKeys(`${p}${body}`)
      assert.ok(r.ok, `refused: ${JSON.stringify(p + body)}`)
      if (r.ok) {
        assert.equal(
          r.value.text,
          ` ${body}`,
          `⚠️⚠️ not in the form measured to be safe: ${JSON.stringify(p + body)} → ${JSON.stringify(r.value.text)}`,
        )
        assert.equal(r.value.neutralized, true)
      }
      checked += 1
    }
  }
  assert.equal(checked, prefixes.length * 2)
})

test('★ invisible characters "inside the body" are left alone (not silently removed)', () => {
  const r = sanitizeForKeys('あ\u200bい')
  assert.ok(r.ok)
  if (r.ok) {
    assert.equal(r.value.text, 'あ\u200bい', 'removed characters inside the body')
    assert.ok(!r.value.neutralized)
  }
})

test('★ a `/` on line 2 or later is left alone (do not break ordinary text)', () => {
  const r = sanitizeForKeys('これを見て\n/tmp のこと')
  assert.ok(r.ok)
  if (r.ok) {
    assert.equal(r.value.text, 'これを見て\n/tmp のこと')
    assert.ok(!r.value.neutralized)
  }
})
test('★ sanitizeForKeys: CR becomes a newline (dropping joins lines, passing it submits midway)', () => {
  const r = sanitizeForKeys('1行目\r\n2行目\r3行目')
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.value.text, '1行目\n2行目\n3行目')
  assert.equal(r.value.dropped, 0, 'CR is "converted", not "dropped"')
})

test('★★ sanitizeForKeys: control characters including ESC are dropped and counted', () => {
  const r = sanitizeForKeys('選択\x1b[Bを動かす\x07\x7f')
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.ok(!r.value.text.includes('\x1b'), 'a remaining ESC moves the choices')
  assert.equal(r.value.text, '選択[Bを動かす')
  assert.equal(r.value.dropped, 3, 'the three: ESC / BEL / DEL')
})

test('sanitizeForKeys: empty and too long', () => {
  assert.equal((sanitizeForKeys('') as { reason: string }).reason, 'empty')
  assert.equal((sanitizeForKeys('  \n ') as { reason: string }).reason, 'empty')
  assert.equal((sanitizeForKeys('\x00\x01') as { reason: string }).reason, 'empty', 'only control characters counts as empty')
  // ★ Use the implementation's own limit (do not hard-code 4096)
  const long = 'あ'.repeat(MAX_KEYS_BYTES) // 3 bytes per character
  assert.equal((sanitizeForKeys(long) as { reason: string }).reason, 'too-long')
})

// ---------------------------------------------------------------- findPane

test('findPane: a running session not started through the relay is no-relay (a normal branch)', async () => {
  const base = await fakeIndex(process.pid, 'S-1')
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-state-'))
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  const r = await findPane([dirOf(base)], 'S-1')
  assert.deepEqual(r, { reason: 'no-relay' })
  await rm(base, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

test('findPane: not in the index (dead) means not-found', async () => {
  const base = await mkdtemp(join(tmpdir(), 'nyan-remote-keys-none-'))
  await mkdir(join(base, 'sessions'), { recursive: true })
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-state-'))
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  const r = await findPane([dirOf(base)], 'S-1')
  assert.deepEqual(r, { reason: 'not-found' })
  await rm(base, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

test('★★ findPane: a broken announcement is broken (do not continue with defaults = fail-closed)', async () => {
  const base = await fakeIndex(process.pid, 'S-1')
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-state-'))
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  await mkdir(join(state, 'panes'), { recursive: true })
  await writeFile(join(state, 'panes', `${process.pid}.json`), '{ こわれた')
  const r = await findPane([dirOf(base)], 'S-1')
  assert.deepEqual(r, { reason: 'broken' })
  await rm(base, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

test('★★ findPane: do not type if the announcement procStart disagrees (pid reuse)', async () => {
  const base = await fakeIndex(process.pid, 'S-1')
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-state-'))
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  await mkdir(join(state, 'panes'), { recursive: true })
  await writeFile(
    join(state, 'panes', `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, procStart: '999999999', socket: '/tmp/nope.sock' }),
  )
  const r = await findPane([dirOf(base)], 'S-1')
  assert.deepEqual(r, { reason: 'unverified' })
  await rm(base, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

test('★★★ findPane: can read an announcement actually written by relay.py', { skip: !hasPython }, async () => {
  const base = await fakeIndex(process.pid, 'S-1')
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-state-'))
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  const sock = join(state, 'pane.sock')
  // ★ Do not build the JSON by hand. **Have relay.py's register() write it**
  //   (if the shape diverges this fails. The only way to avoid writing the same shape in two places)
  execFileSync(
    'python3',
    [
      '-c',
      [
        'import importlib.util,sys',
        `spec=importlib.util.spec_from_file_location('relay', ${JSON.stringify(RELAY)})`,
        'm=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
        `print(m.register(${process.pid}, ${JSON.stringify(sock)}))`,
      ].join('\n'),
    ],
    // ⚠️ Do not let it create `__pycache__` (it would land in the repository)
    { env: { ...process.env, NYAN_REMOTE_STATE_DIR: state, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8' },
  )
  const written = JSON.parse(await readFile(join(state, 'panes', `${process.pid}.json`), 'utf8'))
  assert.equal(written.pid, process.pid, 'relay.py writes the pid')
  assert.equal(written.socket, sock)

  const r = await findPane([dirOf(base)], 'S-1')
  assert.deepEqual(r, { sessionId: 'S-1', pid: process.pid, socketPath: sock })
  await rm(base, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

// ---------------------------------------------------------------- writeKeys

test('★ writeKeys: after writing the body, sends Enter (CR) separately', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-pane-'))
  const path = join(dir, 'p.sock')
  const { server, chunks } = await fakePane(path)
  t.after(() => server.close())
  const r = await writeKeys(path, '打鍵で入れた本文', { submitDelayMs: 30 })
  assert.equal(r.ok, true)
  assert.ok(await waitFor(() => chunks.join('').includes('\r')), 'CR arrives')
  assert.equal(chunks.join(''), '打鍵で入れた本文\r')
  assert.ok(chunks.length >= 2, 'body and CR arrive in separate writes (not absorbed by paste detection)')
  await rm(dir, { recursive: true, force: true })
})

test('writeKeys: an unreachable socket does not hang and gives unreachable (not a single byte written)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-pane-none-'))
  const r = await writeKeys(join(dir, 'いない.sock'), 'あ')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'unreachable')
  await rm(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------- end to end

test('★★ sendKeysToSession: writes not a single byte while an approval card is showing', async (t) => {
  const base = await fakeIndex(process.pid, 'S-1')
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-state-'))
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  await mkdir(join(state, 'panes'), { recursive: true })
  const sock = join(state, 'p.sock')
  const { server, chunks } = await fakePane(sock)
  t.after(() => server.close())
  await writeFile(
    join(state, 'panes', `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, procStart: aliveProcStartSync(process.pid), socket: sock }),
  )

  const blocked = await sendKeysToSession([dirOf(base)], 'S-1', '3番でいいよ', {
    hasPendingApproval: () => true,
  })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.reason, 'pending-approval')
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(chunks.length, 0, '⚠️ a digit could become an approval choice, so nothing may be written')

  // Without a card it arrives
  const sent = await sendKeysToSession([dirOf(base)], 'S-1', 'これは届く', {
    hasPendingApproval: () => false,
  })
  assert.equal(sent.ok, true)
  assert.ok(await waitFor(() => chunks.join('').includes('\r')))
  assert.equal(chunks.join(''), 'これは届く\r')

  await rm(base, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

test('★ sendKeysToSession: a record of the send is kept but the body is not written (§6.2)', async (t) => {
  const base = await fakeIndex(process.pid, 'S-1')
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-state-'))
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  await mkdir(join(state, 'panes'), { recursive: true })
  const sock = join(state, 'p.sock')
  const { server } = await fakePane(sock)
  t.after(() => server.close())
  await writeFile(
    join(state, 'panes', `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, procStart: aliveProcStartSync(process.pid), socket: sock }),
  )
  const secret = 'ひみつの指示ABC'
  const r = await sendKeysToSession([dirOf(base)], 'S-1', secret, { hasPendingApproval: () => false })
  assert.equal(r.ok, true)
  const log = await readFile(join(state, 'sent.jsonl'), 'utf8')
  assert.ok(!log.includes(secret), '⚠️ the body must not be in the record')
  assert.ok(log.includes('"route":"keys"'))
  assert.ok(log.includes(`"chars":${secret.length}`))
  await rm(base, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

// ─── ★★★ Holes found in the 2026-08-23 review (pointed out independently by 6 reviewers) ───

test('★★★ sanitize: putting one control character in front does not let `/` `!` through raw', () => {
  // ⚠️⚠️ This was **a hole that was actually open**. It used to be "check `/` `!` → then drop control characters",
  //    so `\x01/compact` became `/compact` and **the slash command was executed**.
  //    ⇒ Check against **the value the implementation finally produces** (mistake type 3 in VERIFY.md).
  // ★ On 2026-08-24 "refuse" became "neutralize with one space", so what we check changed too:
  //   **the final string does not start with `/` or `!`** (= does not run as a command).
  // ★ Exhaustive (listing one by one always misses some. C1 0x80-0x9f had been forgotten)
  const codes: number[] = []
  for (let c = 0x00; c <= 0x1f; c++) if (c !== 0x0a) codes.push(c)
  codes.push(0x7f)
  for (let c = 0x80; c <= 0x9f; c++) codes.push(c)
  let checked = 0
  for (const c of codes) {
    const p = String.fromCodePoint(c)
    for (const body of ['/compact', '!rm -rf /'] as const) {
      const r = sanitizeForKeys(`${p}${body}`)
      assert.ok(r.ok, `refused: ${JSON.stringify(p + body)}`)
      if (r.ok) {
        assert.equal(r.value.text, ` ${body}`, `not neutralized: ${JSON.stringify(p + body)}`)
        assert.equal(r.value.neutralized, true)
      }
      checked += 1
    }
  }
  // ★ Also check the count so zero cases cannot pass (31 of 0x00-0x1f + 0x7f + 32 of C1 = 64 × 2)
  assert.equal(checked, 128, `the exhaustive count changed: ${checked}`)
})

test('★ sanitize: ordinary text and "a `/` on line 2" pass (do not widen too far)', () => {
  // ⚠️ Widening this would make "ordinary text containing `/`" unsendable as keystrokes.
  //    The CLI interprets commands **only at the start of input**, so looking at the first line only is intended
  for (const ok of ['ふつうの文章', 'ok\n/clear', 'a/b を直して', '／全角は文字']) {
    const r = sanitizeForKeys(ok)
    assert.equal(r.ok, true, `refused: ${JSON.stringify(ok)}`)
  }
})

test('★★★ the 1 byte added by neutralizing does not count toward the limit (keep UI and agent in agreement)', () => {
  // ⚠️ The UI (Composer) checks the limit against the byte count of **what the user typed**.
  //    Counting the 1-byte space added by neutralizing would create, **only for `/`-leading text right at the limit**,
  //    "sendable on screen but refused by the agent". ⇒ Check the limit against what was typed
  const just = 'あ'.repeat(Math.floor((MAX_KEYS_BYTES - 1) / 3))
  const withSlash = sanitizeForKeys(`/${just}`)
  assert.ok(withSlash.ok, 'refused although within the limit')
  if (withSlash.ok) {
    assert.ok(Buffer.byteLength(withSlash.value.text, 'utf8') > MAX_KEYS_BYTES - 1)
  }
})

test('★★ sanitize: exactly at the limit boundary (refuse when 1 byte over)', () => {
  const just = 'あ'.repeat(Math.floor(MAX_KEYS_BYTES / 3)) // 'あ' is 3 bytes
  assert.equal(sanitizeForKeys(just).ok, true)
  const over = sanitizeForKeys(`${just}xxxx`)
  assert.equal(over.ok, false)
  if (!over.ok) assert.equal(over.reason, 'too-long')
})

test('★★★ findPane: do not type if the CLI is showing a dialog and waiting', { skip: !hasPython }, async (t) => {
  // ⚠️⚠️ The approval hook only sees **tool approvals**. CLI dialogs
  //    (`dialog open` / `input needed` / `sandbox request` / `worker request`)
  //    **never reach the hook**, so we typed with `hasPendingApproval` still false.
  //    Typing there turns the first character into a key press, and **a digit confirms a choice**.
  const pid = process.pid
  const base = await fakeIndex(pid, 'sid-waiting', { status: 'waiting', waitingFor: 'dialog open' })
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-state-'))
  t.after(async () => {
    await rm(base, { recursive: true, force: true })
    await rm(state, { recursive: true, force: true })
  })
  // Have **relay.py itself write** the announcement (not built by hand)
  const sock = join(state, 's.sock')
  execFileSync('python3', ['-c', `import sys; sys.path.insert(0,${JSON.stringify(join(RELAY, '..'))});
import importlib.util as u; spec=u.spec_from_file_location('r', ${JSON.stringify(RELAY)}); m=u.module_from_spec(spec); spec.loader.exec_module(m); m.register(${pid}, ${JSON.stringify(sock)})`], {
    env: { ...process.env, NYAN_REMOTE_STATE_DIR: state, PYTHONDONTWRITEBYTECODE: '1' },
  })
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  try {
    const r = await findPane([dirOf(base)], 'sid-waiting')
    assert.ok('reason' in r, `returned a keystroke target: ${JSON.stringify(r)}`)
    if ('reason' in r) assert.equal(r.reason, 'waiting')
  } finally {
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
  }
})

test('★★★ writeKeys: if an approval appears after the body, do not send CR (stop as partial)', async (t) => {
  // ⚠️ Approval was judged from **a value read once**, so if a card appeared during body → 120ms → CR,
  //    a digit we sent could confirm a choice (a window of up to 2 seconds)
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-late-'))
  const path = join(dir, 's.sock')
  const { server, chunks } = await fakePane(path)
  t.after(async () => {
    server.close()
    await rm(dir, { recursive: true, force: true })
  })
  const r = await writeKeys(path, 'これは本文', { submitDelayMs: 20, beforeSubmit: () => true })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'partial', 'did not abort (a CR may have been sent)')
  await new Promise((res) => setTimeout(res, 50))
  assert.ok(!chunks.join('').includes('\r'), `sent a CR: ${JSON.stringify(chunks)}`)
})

test('★★ a record is kept on failure too (⚠️ the body is not written)', async (t) => {
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-note-'))
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  t.after(async () => {
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(state, { recursive: true, force: true })
  })
  const { noteSent } = await import('./keys.ts')
  await noteSent('sid-x', 5, 1, 'partial')
  const body = await readFile(join(state, 'sent.jsonl'), 'utf8')
  assert.match(body, /"failure":"partial"/, 'no record of the failure')
  assert.match(body, /"chars":5/)
  assert.ok(!body.includes('本文'), 'the body leaked')
})

test('★★★ sendKeysToSession: failures are recorded too (through the whole wiring)', { skip: !hasPython }, async (t) => {
  // ⚠️⚠️ This is **the wiring test**. With only a test calling `noteSent` directly,
  //    removing the call from `sendKeysToSession` stays green (a mutation actually passed).
  // ⚠️ The failure is made with "no endpoint listening" (`partial` cannot be made by cutting the socket,
  //    because Node's write counts as success. `partial` itself is covered by the writeKeys test)
  const pid = process.pid
  const base = await fakeIndex(pid, 'sid-fail')
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-fail-'))
  const sock = join(state, 'nobody.sock') // ★ nobody is listening
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  t.after(async () => {
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(base, { recursive: true, force: true })
    await rm(state, { recursive: true, force: true })
  })
  execFileSync(
    'python3',
    [
      '-c',
      `import importlib.util as u; spec=u.spec_from_file_location('r', ${JSON.stringify(RELAY)}); m=u.module_from_spec(spec); spec.loader.exec_module(m); m.register(${pid}, ${JSON.stringify(sock)})`,
    ],
    { env: { ...process.env, NYAN_REMOTE_STATE_DIR: state, PYTHONDONTWRITEBYTECODE: '1' } },
  )
  const r = await sendKeysToSession([dirOf(base)], 'sid-fail', 'これは本文', {
    hasPendingApproval: () => false,
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'unreachable', `wrong reason: ${JSON.stringify(r)}`)
  const body = await readFile(join(state, 'sent.jsonl'), 'utf8')
  assert.match(body, /"failure":"unreachable"/, '⚠️ no record of the failure (the hole in rule 6)')
  assert.ok(!body.includes('これは本文'), 'the body leaked')
})

test('★★★ two concurrent sends do not merge into one prompt (serialized per session)', { skip: !hasPython }, async (t) => {
  // ⚠️⚠️ The relay piles bytes from multiple connections **into the same buffer without framing**, so
  //    another send slipping into the "body → 120ms → CR" gap gives `bodyAbodyB\r\r` (measured).
  //    ⇒ Check that the arrival order is **body,CR,body,CR** (body,body,CR,CR means merged)
  const pid = process.pid
  const base = await fakeIndex(pid, 'sid-serial')
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-serial-'))
  const sock = join(state, 's.sock')
  const { server, chunks } = await fakePane(sock)
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  t.after(async () => {
    server.close()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(base, { recursive: true, force: true })
    await rm(state, { recursive: true, force: true })
  })
  execFileSync(
    'python3',
    [
      '-c',
      `import importlib.util as u; spec=u.spec_from_file_location('r', ${JSON.stringify(RELAY)}); m=u.module_from_spec(spec); spec.loader.exec_module(m); m.register(${pid}, ${JSON.stringify(sock)})`,
    ],
    { env: { ...process.env, NYAN_REMOTE_STATE_DIR: state, PYTHONDONTWRITEBYTECODE: '1' } },
  )
  const ctx = { hasPendingApproval: () => false }
  const [a, b] = await Promise.all([
    sendKeysToSession([dirOf(base)], 'sid-serial', 'AAAA', ctx),
    sendKeysToSession([dirOf(base)], 'sid-serial', 'BBBB', ctx),
  ])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  await new Promise((res) => setTimeout(res, 80))
  const seen = chunks.join('')
  // ⚠️ Either may come first, but **there must be a CR in between**
  assert.ok(
    seen === 'AAAA\rBBBB\r' || seen === 'BBBB\rAAAA\r',
    `merged (became one instruction): ${JSON.stringify(seen)}`,
  )
})

test('★★ when part of the index cannot be read, do not conclude "not there"', async (t) => {
  // ⚠️⚠️ The CLI rewrites `sessions/<pid>.json` every time its state changes. Hitting that moment makes
  //    the index temporarily unreadable. Previously `skipped` was discarded, so live sessions got
  //    a false **`not-found`** hint (= "reopen on the PC to send").
  //    ★ The notification side treats the same input fail-closed (`hook.ts`); only the sending side was lax.
  const base = await mkdtemp(join(tmpdir(), 'nyan-remote-skip-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  await mkdir(join(base, 'sessions'), { recursive: true })
  // Put one broken index file (standing in for a file mid-write)
  await writeFile(join(base, 'sessions', '999999.json'), '{壊れている')
  const r = await findPane([dirOf(base)], 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
  assert.ok('reason' in r)
  if ('reason' in r) {
    assert.equal(r.reason, 'unverified', '⚠️ concluded "not there" although it merely could not be read')
  }
})

test('★ if the whole index can be read, saying "not there" is fine', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'nyan-remote-noskip-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  await mkdir(join(base, 'sessions'), { recursive: true })
  const r = await findPane([dirOf(base)], 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
  assert.ok('reason' in r)
  if ('reason' in r) assert.equal(r.reason, 'not-found')
})

test('★★ sweepPanes: removes only announcements and sockets of dead processes', async (t) => {
  // ⚠️ The relay removes its own in finally, but **that does not run on SIGKILL** (43 had piled up on a real machine).
  //    ⚠️⚠️ **Never remove live ones** (removing them kills keystrokes)
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-sweep-'))
  const sockDir = join(state, 'socks')
  await mkdir(join(state, 'panes'), { recursive: true })
  await mkdir(sockDir, { recursive: true })
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  t.after(async () => {
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(state, { recursive: true, force: true })
  })
  const live = process.pid
  const dead = 424242
  for (const [pid, sock] of [
    [live, join(sockDir, `keys-${live}.sock`)],
    [dead, join(sockDir, `keys-${dead}.sock`)],
  ] as const) {
    await writeFile(join(state, 'panes', `${pid}.json`), JSON.stringify({ pid, socket: sock }))
    await writeFile(sock, '')
  }
  // ★ Also place a "socket-only orphan" with no announcement
  await writeFile(join(sockDir, 'keys-999999.sock'), '')

  const { sweepPanes } = await import('./keys.ts')
  const r = await sweepPanes((pid) => (pid === live ? '123' : null))
  assert.equal(r.panes, 1, `wrong announcement cleanup count: ${JSON.stringify(r)}`)
  assert.equal(r.socks, 2, `wrong socket cleanup count (orphans must be removed too): ${JSON.stringify(r)}`)
  const panes = await readdir(join(state, 'panes'))
  assert.deepEqual(panes, [`${live}.json`], 'removed a live announcement / failed to keep it')
  const socks = await readdir(sockDir)
  assert.deepEqual(socks, [`keys-${live}.sock`], 'removed a live socket / failed to keep it')
})
