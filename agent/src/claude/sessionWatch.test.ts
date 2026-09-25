import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { differs, readStatuses, startSessionWatch } from './sessionWatch.ts'
import { liveSessions } from './sessionIndex.ts'

import type { ConfigDir } from './configDirs.ts'

const dirOf = (base: string): ConfigDir => ({
  account: '.claude-test',
  dir: base,
  projectsDir: join(base, 'projects'),
})

async function tempAccount(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'nyan-remote-watch-'))
  await mkdir(join(base, 'sessions'), { recursive: true })
  return base
}

/** Wait until the condition holds (fs.watch is async, so a fixed sleep is brittle) */
async function waitFor(cond: () => boolean, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return cond()
}

test('differs: same contents means no change / a changed value or count means change', () => {
  assert.equal(differs(new Map([['1.json', 'busy']]), new Map([['1.json', 'busy']])), false)
  assert.equal(differs(new Map([['1.json', 'idle']]), new Map([['1.json', 'busy']])), true)
  // A session was added / ended
  assert.equal(differs(new Map(), new Map([['1.json', 'busy']])), true)
  assert.equal(differs(new Map([['1.json', 'busy']]), new Map()), true)
})

test('readStatuses: skips broken JSON and non-JSON files', async () => {
  const base = await tempAccount()
  try {
    const s = join(base, 'sessions')
    await writeFile(join(s, '100.json'), JSON.stringify({ status: 'busy', name: 'x' }))
    await writeFile(join(s, '200.json'), '{ 壊れている')
    await writeFile(join(s, 'notes.txt'), 'json ではない')
    await writeFile(join(s, '300.json'), JSON.stringify({ name: 'status が無い' }))
    const map = await readStatuses(s)
    assert.equal(map.get('100.json'), 'busy')
    assert.equal(map.has('200.json'), false, 'broken JSON is not included')
    assert.equal(map.has('notes.txt'), false)
    assert.equal(map.get('300.json'), '?', 'entries without status are kept as ? (their existence counts)')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('★★ readStatuses: changes in the reason (waitingFor) also go into the snapshot', async () => {
  // ⚠️ Pointed out in the 2026-08-18 /code-review. The status can stay `waiting` while **only the reason changes**
  //    (an input prompt closes and an approval prompt opens, etc.); without it in the snapshot the screen
  //    **keeps showing the stale reason until the next poll (15 seconds)**.
  const base = await tempAccount()
  try {
    const s = join(base, 'sessions')
    await writeFile(join(s, '10.json'), JSON.stringify({ status: 'waiting', waitingFor: 'input needed' }))
    const before = await readStatuses(s)
    await writeFile(join(s, '10.json'), JSON.stringify({ status: 'waiting', waitingFor: 'permission prompt' }))
    const after = await readStatuses(s)
    assert.ok(differs(before, after), 'a changed reason must be detected as "changed"')
    // Entries without a reason are status only, as before
    await writeFile(join(s, '20.json'), JSON.stringify({ status: 'busy' }))
    assert.equal((await readStatuses(s)).get('20.json'), 'busy')
    // ⚠️ Reasons are ignored unless `waiting` (the API does not include them either, so picking them up **sends a signal
    //    although the screen does not change** / 2026-08-18 codex review, low #5)
    await writeFile(join(s, '30.json'), JSON.stringify({ status: 'busy', waitingFor: 'old' }))
    const b1 = await readStatuses(s)
    await writeFile(join(s, '30.json'), JSON.stringify({ status: 'busy', waitingFor: 'changed' }))
    const b2 = await readStatuses(s)
    assert.equal(differs(b1, b2), false, 'no signal when the reason changes while still busy')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('readStatuses: does not throw when the directory is missing', async () => {
  const map = await readStatuses(join(tmpdir(), 'nyan-remote-watch-ないディレクトリ', 'sessions'))
  assert.equal(map.size, 0)
})

test('★★ startSessionWatch: does not throw for an account without sessions/ (the agent would not start)', async () => {
  // ⚠️ Throwing here means **the agent itself does not start**. Starting up takes priority over immediacy
  const base = await mkdtemp(join(tmpdir(), 'nyan-remote-watch-none-'))
  try {
    let called = 0
    const w = startSessionWatch([dirOf(base)], () => called++)
    assert.equal(w.watched.length, 0)
    assert.equal(w.failed.length, 1, 'make it visible that watching failed')
    w.close()
    assert.equal(called, 0)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('startSessionWatch: does not crash with no targets', () => {
  const w = startSessionWatch([], () => {})
  assert.deepEqual(w.watched, [])
  w.close()
})

test('★★ startSessionWatch: notifies when a status changes (real inotify check)', async () => {
  const base = await tempAccount()
  const s = join(base, 'sessions')
  await writeFile(join(s, '100.json'), JSON.stringify({ status: 'idle' }))
  let called = 0
  const w = startSessionWatch([dirOf(base)], () => called++, { debounceMs: 30 })
  try {
    assert.equal(w.watched.length, 1)
    // Right after startup it "only builds the snapshot" and does not notify
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(called, 0, 'must not notify at startup')

    // ★ Same as a turn starting (idle → busy)
    await writeFile(join(s, '100.json'), JSON.stringify({ status: 'busy' }))
    assert.ok(await waitFor(() => called >= 1), 'a status change should notify')

    const afterFirst = called
    // ⚠️ Writes with unchanged contents do not notify (no storm even if another version writes frequently)
    await writeFile(join(s, '100.json'), JSON.stringify({ status: 'busy' }))
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(called, afterFirst, 'must not notify on a write with the same status')

    // Notify when a session is added
    await writeFile(join(s, '200.json'), JSON.stringify({ status: 'busy' }))
    assert.ok(await waitFor(() => called > afterFirst), 'a new session should notify')
  } finally {
    w.close()
    await rm(base, { recursive: true, force: true })
  }
})

test('★ startSessionWatch: no notifications after close (none fired at shutdown)', async () => {
  const base = await tempAccount()
  const s = join(base, 'sessions')
  try {
    let called = 0
    const w = startSessionWatch([dirOf(base)], () => called++, { debounceMs: 20 })
    w.close()
    await writeFile(join(s, '100.json'), JSON.stringify({ status: 'busy' }))
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(called, 0)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('★ startSessionWatch: does not swallow changes that arrive during seeding (2026-08-13 external review)', async () => {
  // ⚠️ Missing an idle → busy right after the watcher is set up means no immediate notification and a 15-second wait.
  //    Seeding is async, so a write during it cannot be classified as "before or after the read".
  //    → Lean toward re-fetching (costs only one extra fetch).
  const base = await tempAccount()
  const s = join(base, 'sessions')
  await writeFile(join(s, '100.json'), JSON.stringify({ status: 'idle' }))
  let called = 0
  // Write in the gap while seeding runs
  const w = startSessionWatch([dirOf(base)], () => called++, { debounceMs: 10 })
  await writeFile(join(s, '100.json'), JSON.stringify({ status: 'busy' }))
  try {
    assert.ok(await waitFor(() => called >= 1), 'a change during seeding should still notify')
  } finally {
    w.close()
    await rm(base, { recursive: true, force: true })
  }
})

test('★★ drops the live-session cache before announcing a change', async () => {
  // ⚠️ 2026-08-18 codex review, medium #1. Without dropping it, the `/sessions` re-fetched on the signal
  //    returns **values up to 2 seconds old**. The watcher's snapshot is already new, so **no second signal comes**,
  //    and the stale view stays until the next 15-second poll.
  //    ★ A test that "calls the function alone" is not enough here (we want to catch the wiring forgetting the call).
  const base = await tempAccount()
  const dir: ConfigDir = { account: '.claude-x', dir: base, projectsDir: join(base, 'projects') }
  const s = join(base, 'sessions')
  const write = (status: string, waitingFor: string) =>
    writeFile(
      join(s, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: 'watch-cache', status, waitingFor }),
    )

  await write('waiting', 'input needed')
  // Build the cache
  assert.equal((await liveSessions(dir)).agents[0]?.waitingFor, 'input needed')

  let fired = 0
  const w = startSessionWatch([dir], () => {
    fired++
  }, { debounceMs: 10 })
  try {
    await new Promise((r) => setTimeout(r, 60)) // wait for seeding to finish
    const firedAfterSeed = fired
    await write('waiting', 'permission prompt')
    // Wait for the signal (up to 1 second)
    for (let i = 0; i < 50 && fired === firedAfterSeed; i++) await new Promise((r) => setTimeout(r, 20))
    assert.ok(fired > firedAfterSeed, 'precondition: a changed reason sends a signal')
    // ★ When the receiver re-fetches, it gets **the new value** (= the cache was dropped)
    assert.equal((await liveSessions(dir)).agents[0]?.waitingFor, 'permission prompt')
  } finally {
    w.close()
    await rm(base, { recursive: true, force: true })
  }
})
