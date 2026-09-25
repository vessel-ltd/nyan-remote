import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  indexDirFailure,
  shouldTrustIndex,
  invalidateLiveSessions,
  readIndexEntriesDetailed,
  liveSessions,
  parseIndexEntry,
  parseProcStart,
  selectLive,
  type IndexEntry,
} from './sessionIndex.ts'

const entry = (over: Partial<IndexEntry> = {}): IndexEntry => ({
  pid: 100,
  sessionId: 's-1',
  status: 'busy',
  procStart: '999',
  startedAt: 1,
  ...over,
})

test('parseIndexEntry: reads the shape of real data as is', () => {
  // The shape actually read from ~/.claude-r/sessions/9609.json on 2026-08-12
  const raw = {
    pid: 9609,
    sessionId: 'd659ffc7-c73f-48ba-81b6-74ef520bee34',
    cwd: '/home/user/nyan-remote',
    startedAt: 1786495820779,
    procStart: '92531',
    version: '2.1.227',
    peerProtocol: 1,
    kind: 'interactive',
    entrypoint: 'cli',
    messagingSocketPath: '/run/user/1000/cc-socks/9609.sock',
    name: 'nyan-remote-main',
    status: 'busy',
  }
  const e = parseIndexEntry(raw)
  assert.equal(e?.sessionId, 'd659ffc7-c73f-48ba-81b6-74ef520bee34')
  assert.equal(e?.pid, 9609)
  assert.equal(e?.status, 'busy')
  assert.equal(e?.name, 'nyan-remote-main')
  assert.equal(e?.procStart, '92531')
  assert.equal(e?.messagingSocketPath, '/run/user/1000/cc-socks/9609.sock')
})

test('parseIndexEntry: unusable without sessionId or pid', () => {
  assert.equal(parseIndexEntry({ pid: 1 }), null)
  assert.equal(parseIndexEntry({ sessionId: 's' }), null)
  assert.equal(parseIndexEntry({ sessionId: 's', pid: 0 }), null)
  assert.equal(parseIndexEntry(null), null)
  assert.equal(parseIndexEntry('nope'), null)
})

test('parseIndexEntry: normalizes procStart to a string even if written as a number', () => {
  assert.equal(parseIndexEntry({ sessionId: 's', pid: 1, procStart: 92531 })?.procStart, '92531')
})

test('★ selectLive: drops dead pids', () => {
  const live = selectLive([entry()], () => null)
  assert.deepEqual(live, [])
})

test('★★ selectLive: drops reused pids (keeps dead sessions from lingering as "responding")', () => {
  // The file says procStart=999, but the process now at that pid is a different one (different starttime)
  const live = selectLive([entry({ procStart: '999' })], () => '12345')
  assert.deepEqual(live, [])
})

test('selectLive: alive if starttime matches', () => {
  const live = selectLive([entry({ procStart: '999' })], () => '999')
  assert.equal(live.length, 1)
  assert.equal(live[0]?.sessionId, 's-1')
})

test('selectLive: where starttime is unavailable (mac etc.), passes on an existence check alone', () => {
  const live = selectLive([entry()], () => undefined)
  assert.equal(live.length, 1)
})

test('selectLive: does not compare when the file has no procStart', () => {
  const live = selectLive([entry({ procStart: undefined })], () => '12345')
  assert.equal(live.length, 1)
})

test('selectLive: if the same sessionId is under several pids, takes the one started later', () => {
  const old = entry({ pid: 100, startedAt: 1, cwd: '/old' })
  const now = entry({ pid: 200, startedAt: 2, cwd: '/new' })
  const live = selectLive([old, now], () => undefined)
  assert.equal(live.length, 1)
  assert.equal(live[0]?.cwd, '/new')
})

test('selectLive: different sessions are both kept', () => {
  const live = selectLive([entry({ sessionId: 'a' }), entry({ sessionId: 'b', pid: 101 })], () => undefined)
  assert.equal(live.length, 2)
})

test('selectLive: keeps messagingSocketPath (the M4 entry point)', () => {
  const live = selectLive([entry({ messagingSocketPath: '/run/x.sock' })], () => undefined)
  assert.equal(live[0]?.messagingSocketPath, '/run/x.sock')
})

test('★ parseProcStart: survives spaces and parentheses in comm', () => {
  // A shape that breaks a naive split(' '). Exists in the wild ("(Web Content)" etc.)
  const stat = `123 (my proc (x)) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 42531 999`
  //            pid  comm............ state=1 …… starttime is the 20th counting state as the 1st
  assert.equal(parseProcStart(stat), '42531')
})

test('parseProcStart: undefined on broken input', () => {
  assert.equal(parseProcStart('garbage'), undefined)
})

test('★ parseProcStart: reads our own /proc and matches (Linux only)', (t) => {
  let stat: string
  try {
    stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8')
  } catch {
    t.skip('no /proc in this environment')
    return
  }
  const value = parseProcStart(stat)
  assert.ok(value !== undefined, 'starttime must be available')
  // Reading twice gives the same value (= usable as a stable identifier)
  assert.equal(parseProcStart(readFileSync(`/proc/${process.pid}/stat`, 'utf8')), value)
  assert.match(String(value), /^\d+$/)
})

// ── ★★ How the 2-second cache meshes with instant updates (2026-08-18 codex review, medium #1) ────
//
// ⚠️ Even if the watcher spots a change and fires a signal, if `/sessions` returns a 2-second-old value
//    "instant update" is a lie (the watcher's copy is already new, so **no second signal comes**).

test('★★ invalidateLiveSessions: re-reads after dropping (instant update is not a lie)', async () => {
  const base = await mkdtemp(join(tmpdir(), 'nyan-remote-cache-'))
  try {
    const dir = { account: '.claude-x', dir: base, projectsDir: join(base, 'projects') }
    await mkdir(join(base, 'sessions'), { recursive: true })
    const write = (status: string, waitingFor?: string) =>
      writeFile(
        join(base, 'sessions', `${process.pid}.json`),
        JSON.stringify({
          pid: process.pid,
          sessionId: 'cache-test',
          status,
          ...(waitingFor !== undefined && { waitingFor }),
        }),
      )

    await write('waiting', 'input needed')
    const first = await liveSessions(dir)
    assert.equal(first.agents[0]?.waitingFor, 'input needed')

    await write('waiting', 'permission prompt')
    const cached = await liveSessions(dir)
    assert.equal(cached.agents[0]?.waitingFor, 'input needed', 'precondition: the cache holds for 2 seconds')

    invalidateLiveSessions()
    const fresh = await liveSessions(dir)
    assert.equal(fresh.agents[0]?.waitingFor, 'permission prompt', 'reads the new value after dropping')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('★★ counts index files that could not be read (to tell them apart from "gone")', async () => {
  // ⚠️⚠️ 2026-08-21 codex review, high #3. The skipped count was being dropped, so
  //    stepping on a single half-written `<pid>.json` made `probeStatus` return `gone`, and
  //    `resolveStatus` notified **"done" for a running session** based on the latest `Stop`.
  //    ⇒ Check with **the value the implementation produces** (`skipped`). A test that passes `unknown` by hand
  //      could not catch the mutant (ignore `skipped`).
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-index-'))
  try {
    const sessions = join(dir, 'sessions')
    await mkdir(sessions, { recursive: true })
    // One valid entry
    await writeFile(
      join(sessions, '111.json'),
      JSON.stringify({ pid: 111, sessionId: 'S-ok', cwd: '/x', status: 'busy' }),
      'utf8',
    )
    // Half-written (JSON is cut off)
    await writeFile(join(sessions, '222.json'), '{"pid":222,"sessionId":"S-hal', 'utf8')
    // Readable as JSON but the wrong shape
    await writeFile(join(sessions, '333.json'), '"ただの文字列"', 'utf8')

    const got = await readIndexEntriesDetailed({ dir, account: '.claude-x', projectsDir: join(dir, 'projects') })
    assert.ok(got, 'should be readable')
    assert.deepEqual(got.entries.map((e) => e.sessionId), ['S-ok'])
    assert.equal(got.skipped, 2, `skipped count does not match: ${got.skipped}`)

    // ★ 0 when everything was read (not falling to "always unknown")
    await rm(join(sessions, '222.json'))
    await rm(join(sessions, '333.json'))
    const clean = await readIndexEntriesDetailed({ dir, account: '.claude-x', projectsDir: join(dir, 'projects') })
    assert.equal(clean?.skipped, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('★★★ distinguishes an index directory that is "unreadable" from one that is "missing" (2026-08-24 codex medium #2)', async (t) => {
  // ⚠️⚠️ The invariant kept per file ("do not drop what could not be read") was
  //    **broken per directory**: every `readdir` exception was rounded to `null` (= this CLI has
  //    no index), so EACCES / EMFILE were treated like "no index", and
  //    keystrokes asserted **not-found (that session is not running)** (measured).
  const base = await mkdtemp(join(tmpdir(), 'nyan-remote-idx-'))
  const dir = { account: '.t', dir: base, projectsDir: join(base, 'projects') }
  const sessions = join(base, 'sessions')
  await mkdir(sessions, { recursive: true })
  await writeFile(join(sessions, '1234.json'), JSON.stringify({ pid: 1234, sessionId: 's-x' }))
  t.after(async () => {
    await chmod(sessions, 0o700).catch(() => {})
    await rm(base, { recursive: true, force: true })
  })

  // ★ Missing (this CLI has no index) is null as before
  const none = { account: '.t', dir: join(base, 'nope'), projectsDir: join(base, 'projects') }
  assert.equal(await readIndexEntriesDetailed(none), null)

  await chmod(sessions, 0o000)
  // ⚠️ chmod has no effect as root, so do not try there (no false green)
  let unreadable = false
  try {
    await readdir(sessions)
  } catch {
    unreadable = true
  }
  if (!unreadable) {
    t.skip('cannot create an unreadable directory in this environment (root)')
    return
  }
  const read = await readIndexEntriesDetailed(dir)
  assert.ok(read, '⚠️⚠️ treating merely unreadable the same as "no index"')
  assert.deepEqual(read.entries, [])
  assert.ok(read.skipped > 0, '⚠️ not counting the unreadable (it gets asserted as not-found)')
})

test('★★★ does not say "0 live sessions" when the index is unreadable (2026-08-24 codex medium #1)', async (t) => {
  // ⚠️⚠️ This is **a hole my own fix created**. Turning a `readdir` failure into `{entries:[],skipped:1}`
  //    made `liveSessions`, going through `readIndexEntries` (the thin API that drops skipped),
  //    answer **`available:true, agents:[]`** (= no live sessions).
  //    Before, it was `null` and fell to **the CLI fallback**.
  //    ⇒ The list asserts live sessions are "not running", and that lands in the 2-second cache.
  const base = await mkdtemp(join(tmpdir(), 'nyan-remote-live-'))
  const dir = { account: '.t', dir: base, projectsDir: join(base, 'projects') }
  const sessions = join(base, 'sessions')
  await mkdir(sessions, { recursive: true })
  await writeFile(
    join(sessions, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: 's-live', status: 'busy' }),
  )
  t.after(async () => {
    await chmod(sessions, 0o700).catch(() => {})
    await rm(base, { recursive: true, force: true })
    invalidateLiveSessions()
  })
  await chmod(sessions, 0o000)
  let unreadable = false
  try {
    await readdir(sessions)
  } catch {
    unreadable = true
  }
  if (!unreadable) {
    t.skip('cannot create an unreadable directory in this environment (root)')
    return
  }
  invalidateLiveSessions()
  const r = await liveSessions(dir)
  // ★ Must not say "the index answered" (= do not assert 0)
  assert.notEqual(r.source, 'index', '⚠️⚠️ answering "0" based on an unreadable index')
  // ⚠️ This directory has no .claude.json, so the CLI guard kicks in and nothing is executed
  assert.equal(r.available, false, 'should answer that the live state could not be obtained')
})

test('★★ pins the index directory failure classification exhaustively', () => {
  // ⚠️ Only "missing (old CLI)" is `missing`. Everything else falls to "unreadable".
  //    ⚠️⚠️ Mixing EMFILE (fd exhaustion) into `missing` **asserts "no session" on a transient
  //       failure** (this is the mutant codex named. It actually passed green).
  assert.equal(indexDirFailure('ENOENT'), 'missing')
  for (const code of ['ENOTDIR', 'EACCES', 'EPERM', 'EMFILE', 'ENFILE', 'ELOOP', 'EIO', undefined]) {
    assert.equal(indexDirFailure(code), 'unreadable', `${String(code)} is classified as missing`)
  }
})

test('★★★ does not assert 0 when "the readable entries are dead and the pid of the broken entry is alive"', async (t) => {
  // ⚠️⚠️ The previous fix looked at `entries.length === 0 && skipped > 0`, so
  //    **if even one entry was readable** (even a dead pid) it trusted the index:
  //      `111.json` = readable but a dead pid / `222.json` = broken mid-write (= actually running)
  //    ⇒ entries=1, skipped=1 so the index is adopted → `selectLive` is empty → asserts "0 running".
  // ⇒ **If zero are known to be alive and something was unreadable, fall back to the CLI.**
  const base = await mkdtemp(join(tmpdir(), 'nyan-remote-live2-'))
  const dir = { account: '.t', dir: base, projectsDir: join(base, 'projects') }
  const sessions = join(base, 'sessions')
  await mkdir(sessions, { recursive: true })
  // Readable but a dead pid
  await writeFile(
    join(sessions, '424242.json'),
    JSON.stringify({ pid: 424242, sessionId: 's-dead', status: 'idle', procStart: '1' }),
  )
  // ★★ Broken = content unknown. ⚠️ The dangerous shape is when **that pid is alive**
  //    (a half-written index = **actually a running session**).
  //    ⚠️⚠️ Originally this fixture used **a dead pid**, but that is just a "leftover" and
  //       did not represent the danger (found in 2026-08-24 codex medium #3. The tests contradicted each other).
  await writeFile(join(sessions, `${process.pid}.json`), '{壊れている')
  t.after(async () => {
    await rm(base, { recursive: true, force: true })
    invalidateLiveSessions()
  })
  invalidateLiveSessions()
  const r = await liveSessions(dir)
  assert.notEqual(r.source, 'index', '⚠️⚠️ answering "0" based on an index that is all dead')
  assert.equal(r.available, false)
})

test('★ uses the index if even one is alive (does not over-fall back)', async (t) => {
  // ⚠️ Pin the other side too: even with broken files mixed in, **if live ones are found**
  //    use the index (falling back to the CLI every time is heavy, and we would rather not touch `claude agents --json`)
  const base = await mkdtemp(join(tmpdir(), 'nyan-remote-live3-'))
  const dir = { account: '.t', dir: base, projectsDir: join(base, 'projects') }
  const sessions = join(base, 'sessions')
  await mkdir(sessions, { recursive: true })
  await writeFile(
    join(sessions, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: 's-live', status: 'busy' }),
  )
  await writeFile(join(sessions, '424245.json'), '{壊れている')
  t.after(async () => {
    await rm(base, { recursive: true, force: true })
    invalidateLiveSessions()
  })
  invalidateLiveSessions()
  const r = await liveSessions(dir)
  assert.equal(r.source, 'index')
  assert.equal(r.agents.length, 1)
})

test('★★★ does not fall back to the CLI for leftovers only (2026-08-24 codex medium #3)', () => {
  // ⚠️⚠️ The previous fix fell back to the CLI on "zero alive and something unreadable".
  //    ⇒ With just **one index of a dead pid + one broken index (also a dead pid)** left over,
  //      it kept spawning `claude agents --json` (up to 10 seconds) every time the 2-second cache expired
  //      = hitting the path we would rather not touch, every time (CLAUDE.md §5).
  // ⇒ Fall back **only when the pid of an unreadable file is alive (or unknown)**.
  const dead = (): null => null
  const alive = (): string => '123'
  const unknown = (): undefined => undefined

  // Leftovers only (the unreadable pid is dead too) ⇒ trust the index (no CLI fallback)
  assert.equal(shouldTrustIndex([], 1, [424243], dead), true)
  // The unreadable pid is alive ⇒ it may be that session ⇒ to the CLI
  assert.equal(shouldTrustIndex([], 1, [424243], alive), false)
  // Liveness unknown (mac) ⇒ do not assert ⇒ to the CLI
  assert.equal(shouldTrustIndex([], 1, [424243], unknown), false)
  // The whole directory was unreadable (pids unknown) ⇒ to the CLI
  assert.equal(shouldTrustIndex([], 1, [], dead), false)
  // If live ones are found, use the index (even if something was unreadable)
  assert.equal(shouldTrustIndex([entry()], 1, [424243], alive), true)
  // Nothing read but skipped is 0 too (= empty index) ⇒ trust the index
  assert.equal(shouldTrustIndex([], 0, [], dead), true)
})

test('★★ liveSessions does not fall back to the CLI with a leftovers-only index (wiring)', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'nyan-remote-live4-'))
  const dir = { account: '.t', dir: base, projectsDir: join(base, 'projects') }
  const sessions = join(base, 'sessions')
  await mkdir(sessions, { recursive: true })
  // Readable but dead + broken (also a dead pid)
  await writeFile(
    join(sessions, '424242.json'),
    JSON.stringify({ pid: 424242, sessionId: 's-dead', status: 'idle', procStart: '1' }),
  )
  await writeFile(join(sessions, '424243.json'), '{壊れている')
  t.after(async () => {
    await rm(base, { recursive: true, force: true })
    invalidateLiveSessions()
  })
  invalidateLiveSessions()
  const r = await liveSessions(dir)
  assert.equal(r.source, 'index', '⚠️ falling back to the CLI with leftovers only (hits the 10-second path every time)')
  assert.deepEqual(r.agents, [])
})

// ★★ **Process identity on mac** (2026-09-22 / got stuck on a real machine with "cannot verify the session's process").
//
// ⚠️⚠️ mac has no `/proc`, so starttime could not be read, and with `unverified`
//   **not a single character could be sent from the phone**. ⇒ Added a path that reads it from `ps`.
// ★ This path **can also run on Linux** (`ps` exists on both), so it is actually exercised here
//   = no "code that runs only on the user's machine".

test('★★ parses `ps -A -o pid=,lstart=`', async () => {
  const { parsePsSnapshot } = await import('./sessionIndex.ts')
  // ⚠️ The real shape (right-aligned with leading spaces / two spaces for a 1-digit day)
  const out = [
    '    1 Mon Sep 21 23:12:13 2026',
    ' 67951 Tue Sep  2 01:02:03 2026',
    '', // ⚠️ drops the trailing empty line
  ].join('\n')
  const map = parsePsSnapshot(out)
  assert.equal(map.get(1), 'Mon Sep 21 23:12:13 2026')
  // ⚠️ The double space of a 1-digit day is **collapsed** when stored (same collapsing as the comparing side)
  assert.equal(map.get(67951), 'Tue Sep 2 01:02:03 2026')
  assert.equal(map.size, 2, 'picked up an empty line')
})

test('★★ start-time comparison ignores only whitespace (⚠️ strict otherwise)', async () => {
  const { sameProcStart } = await import('./sessionIndex.ts')
  assert.equal(sameProcStart('Mon Sep  1 00:00:00 2026', 'Mon Sep 1 00:00:00 2026'), true)
  assert.equal(sameProcStart(' 8548392 ', '8548392'), true)
  // ⚠️⚠️ Loosening this misses pid reuse = **typing into a different process**
  assert.equal(sameProcStart('Mon Sep 1 00:00:00 2026', 'Mon Sep 1 00:00:01 2026'), false)
  assert.equal(sameProcStart('8548392', '8548393'), false)
})

test('★★ identity is available from the `ps` list without `/proc` (= the mac path)', async () => {
  const { resolveProcStart } = await import('./sessionIndex.ts')
  const none = () => undefined // ★ simulate an environment without `/proc`
  const snap = () => new Map([[42, 'Mon Sep 21 23:12:13 2026']])
  // ★ Simulate mac: an OS without `/proc` (hasProc = false)
  assert.equal(resolveProcStart(42, none, snap, false), 'Mon Sep 21 23:12:13 2026')

  // ⚠️ **Do not conclude** "not in the list = dead" (`ps` may have failed)
  //    ⇒ for our own live process it falls to `undefined` (unverifiable)
  assert.equal(resolveProcStart(process.pid, none, () => new Map(), false), undefined)
  // ★ Truly absent ones are null
  assert.equal(resolveProcStart(0x7ffffff0, none, () => new Map(), false), null)

  // ★ When `/proc` is readable it wins (the Linux path is unchanged)
  // ⚠️ Counting from 0 after `)`, index 19 is starttime (state, ppid, pgrp, session use 4)
  const stat = '7 (x) S 1 2 3' + ' 0'.repeat(15) + ' 999'
  assert.equal(resolveProcStart(7, () => stat, snap, true), '999')
})

test('★★ looks up our own identity with the real `ps` (⚠️ runs the mac path on Linux too)', async () => {
  const { parsePsSnapshot } = await import('./sessionIndex.ts')
  const { execFileSync } = await import('node:child_process')
  // ⚠️⚠️ **Pin the locale and time zone** (unpinned, it gets garbled on the user's terminal / measured)
  const out = execFileSync('ps', ['-A', '-o', 'pid=,lstart='], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    maxBuffer: 4 << 20,
  })
  const map = parsePsSnapshot(out)
  const mine = map.get(process.pid)
  assert.ok(mine, 'our own pid is not in the `ps` list (parsing is broken)')
  // ★ Check the shape too (⚠️ a mixed-in locale garbles weekday and month, so pin the C-locale shape)
  assert.match(
    mine,
    /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/,
    `not in the C-locale shape (locale pinning is not working): ${mine}`,
  )
})

test('★★ on an OS with `/proc`, does not spawn `ps` even when unreadable (⚠️ side effect of mac support)', async () => {
  const { resolveProcStart } = await import('./sessionIndex.ts')
  // ⚠️⚠️ It used to be "ps if unreadable" ⇒ even on Linux **a merely dead pid spawned ps -A**
  let called = 0
  const snap = () => {
    called++
    return new Map([[0x7ffffff0, 'Mon Sep 21 23:12:13 2026']])
  }
  // ★ Simulate Linux: `/proc` exists but that pid is unreadable (= dead)
  assert.equal(resolveProcStart(0x7ffffff0, () => undefined, snap, true), null)
  assert.equal(called, 0, '⚠️⚠️ spawning ps although /proc exists (an extra spawn on Linux)')
  // ★ On mac it looks it up (the path is not removed)
  assert.equal(resolveProcStart(0x7ffffff0, () => undefined, snap, false), 'Mon Sep 21 23:12:13 2026')
  assert.equal(called, 1)
})

// ★★ codex round 13, high #1: the identity check right before sending used, on mac, **a `ps` result up to 1 second old**.
//   If a pid dies and is reused within that second, the old start time is returned and **another process may be accepted**.
test('★★ the check right before sending does not cache (asks fresh every time)', async () => {
  const { freshSnapshot } = await import('./sessionIndex.ts')
  let n = 0
  const run = () => `  42 ${n++ === 0 ? 'Mon Sep 21 23:12:13 2026' : 'Tue Sep 22 01:00:00 2026'}\n`
  assert.equal(freshSnapshot(42, run).get(42), 'Mon Sep 21 23:12:13 2026')
  assert.equal(freshSnapshot(42, run).get(42), 'Tue Sep 22 01:00:00 2026', '⚠️⚠️ remembering the previous answer')
  // ⚠️ Empty if it cannot ask = unverifiable (falls toward not sending)
  assert.equal(freshSnapshot(42, () => { throw new Error('no ps') }).size, 0)
})

test('★★ the sending paths (findTarget / findPane) use the non-caching one (⚠️ wiring)', async () => {
  const { readFileSync } = await import('node:fs')
  for (const [file, fn] of [['inbox.ts', 'findTarget'], ['keys.ts', 'findPane']] as const) {
    const src = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    // ⚠️ **Look only at executed lines** (comments contain the same text / CLAUDE.md §2)
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
    const head = code.slice(code.indexOf(`export async function ${fn}(`))
    const sig = head.slice(0, head.indexOf('): Promise<'))
    assert.match(sig, /= aliveProcStartFreshSync/, `⚠️⚠️ ${fn} checks identity with the caching one (a 1-second-old answer)`)
  }
})

test('★★ on Linux the non-caching one gives the same answer (reads `/proc` directly)', async () => {
  const { aliveProcStartFreshSync, aliveProcStartSync } = await import('./sessionIndex.ts')
  assert.equal(aliveProcStartFreshSync(process.pid), aliveProcStartSync(process.pid))
})
