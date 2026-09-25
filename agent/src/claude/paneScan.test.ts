// ★★ Answer "can this session be reached from the phone without the frame" for **every entry in the list** (the HANDOFF marker).
//
// ⚠️⚠️ There is one thing to protect here: **never put the decision in two places.**
//    When `npm run keys` had its own implementation, it **disagreed with the real one (`findPane`) in 6 ways**,
//    and on mac it showed "✅ can type" while not a single keystroke could be sent (see the notes in keys-status.mjs).
//    ⇒ The list's marker is decided with **the same inputs in the same order** as `findPane`. Pinned by a differential test.

import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { findPane, resolvePane, scanPanes, type PaneEvidence } from './keys.ts'
import { aliveProcStartSync } from './sessionIndex.ts'
import type { ConfigDir } from './configDirs.ts'

const RELAY = join(fileURLToPath(new URL('../../../scripts/', import.meta.url)), 'relay.py')
const hasPython = spawnSync('python3', ['-c', 'print(1)']).status === 0

const dirOf = (base: string): ConfigDir => ({
  account: '.claude-test',
  dir: base,
  projectsDir: join(base, 'projects'),
})

async function indexEntry(
  base: string,
  pid: number,
  sessionId: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await mkdir(join(base, 'sessions'), { recursive: true })
  await writeFile(
    join(base, 'sessions', `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId,
      cwd: '/tmp',
      status: 'idle',
      procStart: aliveProcStartSync(pid),
      ...extra,
    }),
  )
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

test('★★ scanPanes: returns every session in one pass (can type / cannot type)', { skip: !hasPython }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'nyan-remote-scan-'))
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-scanst-'))
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  t.after(async () => {
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(base, { recursive: true, force: true })
    await rm(state, { recursive: true, force: true })
  })
  // Our own pid goes through the relay (it has an announcement). The other one is treated as launched bare
  const withRelay = process.pid
  const bare = 777777 // a pid that is not alive = cannot type even if it is in the index
  await indexEntry(base, withRelay, 'sid-relay')
  await indexEntry(base, bare, 'sid-bare')
  registerPane(withRelay, join(state, 'a.sock'), state)

  const scan = await scanPanes([dirOf(base)])
  const a = scan.bySession.get('sid-relay')
  assert.ok(a && !('reason' in a), `should be typeable: ${JSON.stringify(a)}`)
  // ★ A dead pid gets **no marker** even if it is in the index (it is gone, so it is not in the map)
  assert.equal(scan.bySession.get('sid-bare'), undefined)
  assert.equal(scan.skipped, 0)

  // ★ When asked about one, **look only at that one** (so the everyday serial path does not read every announcement).
  //   ⚠️ It is a performance narrowing, but **whether it works is visible in the shape** (nothing else is included).
  //   ⚠️⚠️ Making it visible needs **two live sessions** (a dead pid is not in the map
  //      even without the narrowing, so one entry would miss the mutation / 2026-08-24)
  const other = await mkdtemp(join(tmpdir(), 'nyan-remote-scan2-'))
  t.after(() => rm(other, { recursive: true, force: true }))
  await indexEntry(other, withRelay, 'sid-other')
  const both = await scanPanes([dirOf(base), dirOf(other)])
  assert.deepEqual([...both.bySession.keys()].sort(), ['sid-other', 'sid-relay'])
  const one = await scanPanes([dirOf(base), dirOf(other)], undefined, 'sid-relay')
  assert.deepEqual([...one.bySession.keys()], ['sid-relay'], '⚠️ asked about one but looked at all')
})

test('★★★ findPane and scanPanes always give the same answer (the decision is not in two places)', { skip: !hasPython }, async (t) => {
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-diffst-'))
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  const bases: string[] = []
  t.after(async () => {
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(state, { recursive: true, force: true })
    for (const b of bases) await rm(b, { recursive: true, force: true })
  })
  const pid = process.pid

  /** Set up one situation and ask both the same question */
  const compare = async (
    label: string,
    build: (base: string) => Promise<void>,
    sessionId: string,
  ): Promise<void> => {
    const base = await mkdtemp(join(tmpdir(), 'nyan-remote-diff-'))
    bases.push(base)
    await build(base)
    const one = await findPane([dirOf(base)], sessionId)
    const scan = await scanPanes([dirOf(base)])
    const many =
      scan.bySession.get(sessionId) ??
      (scan.skipped > 0 ? { reason: 'unverified' as const } : { reason: 'not-found' as const })
    assert.deepEqual(many, one, `${label}: the list marker and the typing decision disagree`)
  }

  // ① via relay (can type)
  await compare(
    'via relay',
    async (base) => {
      await indexEntry(base, pid, 'sid-ok')
      registerPane(pid, join(state, 'ok.sock'), state)
    },
    'sid-ok',
  )
  // ② launched bare (no-relay)
  await compare('launched bare', async (base) => indexEntry(base, pid, 'sid-plain'), 'sid-plain')
  // ③ the CLI shows a dialog and is waiting (waiting)
  await compare(
    'in a dialog',
    async (base) => {
      await indexEntry(base, pid, 'sid-dlg', { status: 'waiting' })
      registerPane(pid, join(state, 'dlg.sock'), state)
    },
    'sid-dlg',
  )
  // ④ the index is unreadable (unverified. ★ do not conclude "absent")
  await compare(
    'index is broken',
    async (base) => {
      await mkdir(join(base, 'sessions'), { recursive: true })
      await writeFile(join(base, 'sessions', '999999.json'), '{壊れている')
    },
    'sid-none',
  )
  // ⑤ nobody there at all (not-found)
  await compare(
    'index is empty',
    async (base) => {
      await mkdir(join(base, 'sessions'), { recursive: true })
    },
    'sid-nobody',
  )
  // ⑥ the announcement is broken (broken. ⚠️ do not fail open)
  await compare(
    'announcement is broken',
    async (base) => {
      await indexEntry(base, pid, 'sid-broken')
      await mkdir(join(state, 'panes'), { recursive: true })
      await writeFile(join(state, 'panes', `${pid}.json`), '{壊れている')
    },
    'sid-broken',
  )
})

/** A shape with exactly one input set (★ the default is "nothing known") */
const ev = (over: Partial<PaneEvidence> = {}): PaneEvidence => ({
  found: [],
  sawSession: false,
  unverified: false,
  broken: false,
  waiting: false,
  livePids: new Set(),
  ...over,
})
const target = { sessionId: 's', pid: 1, socketPath: '/tmp/x.sock' }

test('★★★ pins the priority order pairwise (⚠️ the on-screen message changes)', () => {
  // ⚠️⚠️ In the 2026-08-24 mutation run, **swapping them stayed green** (there was no test with both inputs set).
  //    The order is determined by "what the user should do next":
  //      type if possible > a dialog is open > broken > cannot verify > launched bare
  assert.deepEqual(resolvePane(ev({ found: [target, target] })), { reason: 'ambiguous' })
  // ★★ With two live processes, refuse **even if the destination is determined** (codex, medium #1)
  assert.deepEqual(resolvePane(ev({ found: [target], livePids: new Set([1, 2]) })), {
    reason: 'ambiguous',
  })
  // ★ Typing if possible beats the other flags (even with a dialog up, type if the destination is determined)
  assert.deepEqual(resolvePane(ev({ found: [target], waiting: true, broken: true })), target)
  assert.deepEqual(
    resolvePane(ev({ waiting: true, broken: true })),
    { reason: 'waiting' },
    '⚠️ must say "a dialog is open" before "broken" (looking at the PC fixes it)',
  )
  assert.deepEqual(resolvePane(ev({ broken: true, unverified: true })), { reason: 'broken' })
  assert.deepEqual(resolvePane(ev({ unverified: true, sawSession: true })), { reason: 'unverified' })
  assert.deepEqual(resolvePane(ev({ sawSession: true })), { reason: 'no-relay' })
  // ★ With nothing, "unknown" (the caller looks at skipped to decide not-found or unverified)
  assert.equal(resolvePane(ev()), undefined)
})

test('★★★ does not type when the same sessionId has "two live processes" (2026-08-24 codex, medium #1)', { skip: !hasPython }, async (t) => {
  // ⚠️⚠️ Opening `--resume` in another window can give **two live processes with the same sessionId**.
  //    If only one went through the relay, it used to treat that as "one destination found" and **typed into it**
  //    (confirmed by measurement: A=with relay / B=bare → types into A). ⚠️ The instance the user is looking at is
  //    the list's representative (`selectLive`), so **the text lands in a different window**.
  // ⇒ `ambiguous` (the same session more than once) **exists precisely for this**, so
  //    refuse **first** even if a destination was found.
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-dup-'))
  const a = await mkdtemp(join(tmpdir(), 'nyan-remote-dupa-'))
  const b = await mkdtemp(join(tmpdir(), 'nyan-remote-dupb-'))
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  // ★ Prepare a second "live process" (our own pid alone cannot make it)
  const other = spawn('sleep', ['30'], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 120))
  t.after(async () => {
    other.kill('SIGKILL')
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    for (const d of [state, a, b]) await rm(d, { recursive: true, force: true })
  })
  assert.ok(other.pid, 'sleep did not start')
  await indexEntry(a, process.pid, 'sid-dup') // via relay (creates the announcement)
  await indexEntry(b, other.pid!, 'sid-dup') // launched bare
  registerPane(process.pid, join(state, 'dup.sock'), state)

  const r = await findPane([dirOf(a), dirOf(b)], 'sid-dup')
  assert.deepEqual(
    r,
    { reason: 'ambiguous' },
    `⚠️⚠️ picks a target although two live processes exist: ${JSON.stringify(r)}`,
  )
  // ★ Check the other side too: if **only the index of an ended session remains**, do not refuse
  //   (only "live processes" are counted. Leftovers must not kill typing)
  const c = await mkdtemp(join(tmpdir(), 'nyan-remote-dupc-'))
  t.after(() => rm(c, { recursive: true, force: true }))
  await mkdir(join(c, 'sessions'), { recursive: true })
  await writeFile(
    join(c, 'sessions', '888888.json'),
    JSON.stringify({ pid: 888888, sessionId: 'sid-dup', cwd: '/tmp', procStart: '1' }),
  )
  const stale = await findPane([dirOf(a), dirOf(c)], 'sid-dup')
  assert.ok(!('reason' in stale), `⚠️ refuses just because a dead index remains: ${JSON.stringify(stale)}`)
})

test('★★ does not say "that session is not running" when the index is unreadable (wiring)', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'nyan-remote-eacces-'))
  const sessions = join(base, 'sessions')
  await mkdir(sessions, { recursive: true })
  await writeFile(join(sessions, '1234.json'), JSON.stringify({ pid: 1234, sessionId: 'sid-x' }))
  t.after(async () => {
    await chmod(sessions, 0o700).catch(() => {})
    await rm(base, { recursive: true, force: true })
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
  const r = await findPane([dirOf(base)], 'sid-x')
  assert.deepEqual(
    r,
    { reason: 'unverified' },
    `⚠️⚠️ concludes "not running" merely because it could not read: ${JSON.stringify(r)}`,
  )
})

test('★★★ does not type when the index procStart disagrees with /proc (pid reuse / codex finding)', { skip: !hasPython }, async (t) => {
  // ⚠️⚠️ Of the triple check (index / `/proc` / announcement), the tests only looked at
  //    **the announcement and `/proc`** (= removing the index-side comparison stayed green).
  //    A pid whose index `procStart` is stale is **a different process**, so typing into it is the worst case.
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-reuse-'))
  const base = await mkdtemp(join(tmpdir(), 'nyan-remote-reuseb-'))
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  t.after(async () => {
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(state, { recursive: true, force: true })
    await rm(base, { recursive: true, force: true })
  })
  // ★ Build the announcement with **the real values** (= the announcement side matches). Only the index disagrees
  registerPane(process.pid, join(state, 'r.sock'), state)
  await indexEntry(base, process.pid, 'sid-reuse', { procStart: '1' })
  const r = await findPane([dirOf(base)], 'sid-reuse')
  assert.ok('reason' in r, `⚠️⚠️ tries to type although the index procStart differs: ${JSON.stringify(r)}`)
  assert.equal(r.reason, 'not-found', JSON.stringify(r))
})

test('★★ when asked about one, **does not examine** other sessions (evidence of reduced I/O)', async (t) => {
  // ⚠️ A test that only looks at the shape of the result stays green even for an implementation that "reads everything then narrows" (codex finding).
  //    ⇒ Count **the pids whose liveness was checked** (only once if narrowed)
  const base = await mkdtemp(join(tmpdir(), 'nyan-remote-io-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  await indexEntry(base, 111111, 'sid-a')
  await indexEntry(base, 222222, 'sid-b')
  await indexEntry(base, 333333, 'sid-c')
  const asked: number[] = []
  const alive = (pid: number): string | null => {
    asked.push(pid)
    return null
  }
  await scanPanes([dirOf(base)], alive, 'sid-b')
  assert.deepEqual(asked, [222222], `⚠️ asked about one but examined all: ${JSON.stringify(asked)}`)
  asked.length = 0
  await scanPanes([dirOf(base)], alive)
  assert.equal(asked.length, 3, 'examines all when asked for all')
})

test('★★★ with unverifiable duplicates, it can still send to the determined destination (2026-08-24 codex, low)', { skip: !hasPython }, async (t) => {
  // ⚠️⚠️ **A hole my own fix nearly created**: when counting "live processes", also counting
  //    **ones whose procStart could not be matched** (indexes written by old CLIs, leftovers whose pid was
  //    reused by another process) makes **a healthy session `ambiguous`, so neither
  //    keystrokes nor ESC can be sent** (= it silently falls into the inbox).
  // ⇒ Count **only those that passed the triple check**. With unverifiable duplicates, prefer `found`.
  //    ★ Rationale: the current CLI always writes `procStart`, so unverifiable duplicates are
  //      far more likely "old leftovers + pid reuse". ⚠️ Measure before changing this.
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-unv-'))
  const a = await mkdtemp(join(tmpdir(), 'nyan-remote-unva-'))
  const b = await mkdtemp(join(tmpdir(), 'nyan-remote-unvb-'))
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  const other = spawn('sleep', ['30'], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 120))
  t.after(async () => {
    other.kill('SIGKILL')
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    for (const d of [state, a, b]) await rm(d, { recursive: true, force: true })
  })
  assert.ok(other.pid)
  await indexEntry(a, process.pid, 'sid-unv') // ★ passes the triple check (with relay)
  // ★ B: an index that is **alive but has no procStart** (old CLI / leftover from pid reuse)
  await mkdir(join(b, 'sessions'), { recursive: true })
  await writeFile(
    join(b, 'sessions', `${other.pid}.json`),
    JSON.stringify({ pid: other.pid, sessionId: 'sid-unv', cwd: '/tmp', status: 'idle' }),
  )
  registerPane(process.pid, join(state, 'unv.sock'), state)
  const r = await findPane([dirOf(a), dirOf(b)], 'sid-unv')
  assert.ok(
    !('reason' in r),
    `⚠️⚠️ unverifiable leftovers keep it from sending to the determined destination: ${JSON.stringify(r)}`,
  )
  assert.equal('pid' in r ? r.pid : 0, process.pid)
})
