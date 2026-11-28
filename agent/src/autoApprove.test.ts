// Auto-approve mode decisions and the lifetime of its state.
//
// ★★ **Mutations targeted by name here** (each survives tests that cover only the happy path):
//   (1) pass approvals without a `sessionId` (remove `if (!req.sessionId)`)
//   (2) remove the `requiresInteraction` line (a broken `AskUserQuestion` gets auto-allowed)
//   (3) remove the `interaction` line (questions with choices and plan approvals get auto-allowed)
//   (4) drop the expiry comparison (passes even after expiry)
//   (5) treat an unreadable `until` as "no expiry" (the trap that `NaN` comparisons are always false)
//   (6) treat a broken state file as "on" (fail-open)
//   (7) store `until` as remaining time (**restart rewinds the 3 hours**)
//   (8) start passing even though saving "on" failed / save "off" without applying it to memory
//
// ★★ **Equivalent mutations (removing them does not change the result) are stated honestly.**
//   It is not "no guard because tests cannot kill it": **another guard produces the same result**,
//   so we do not add fake asserts here to make it green (CLAUDE.md "false green" / measured 2026-09-07):
//     - `if (!req.sessionId) return false` … today the `Map` lookup always misses, so the result is the same.
//       ⚠️ It is kept because it **becomes the only guard** once `scope: 'machine'` is added
//     - cleaning up expired entries at load … the decision side (`untilMs > now`) gives the same result.
//       ⚠️ It is kept so dead entries do not pile up in memory (cleanup, not a guard)
//   ⚠️ The "falls to on while broken" mutation was **made impossible by the type** (`Loaded`
//      cannot hold entries when broken). ⇒ No redundant `if (broken)` scattered around
//
// ★★ 5 high and 1 medium findings from codex (read-only) on 2026-09-07. **The tests below reproduce them**:
//   high #1: turning off while "on" is saving keeps allowing after the off succeeds (`active.set` after `await`)
//   high #4: the 3-hour cap is not validated at load (a tampered or broken file approaches unlimited)
//   high #5: if the expiry passes while stopped, the expiry notification **never fires** (requirement (4) silently fails)
//   medium #6: structural corruption that is still valid JSON (`entries` not an array) is treated as normal and overwrites the evidence

import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  AUTO_APPROVE_DURATIONS,
  AUTO_APPROVE_FILE,
  AUTO_APPROVE_MAX_MS,
  autoApproveBroken,
  autoApproveFor,
  autoApproveList,
  endCodexAutoApproveOutside,
  endSessionAutoApprove,
  loadAutoApprove,
  resetAutoApprove,
  setAutoApproveExpiryHandler,
  setAutoApprove,
  shouldAutoApprove,
} from './autoApprove.ts'
import { TEAM_CREATE_TOOL } from '../../shared/types.ts'

const SESSION = '960cbcc3-0c6e-435d-b024-1867c146dfa8'
/** ★ The default duration (no name passed = older screens). ⚠️ Different from the cap (`AUTO_APPROVE_MAX_MS` = 24 hours) */
const THREE_H = AUTO_APPROVE_DURATIONS['3h']
const OTHER = 'e2e96878-1111-2222-3333-444455556666'

/** Swap the state directory. ⚠️ So the real `~/.nyan-remote/` is never rewritten */
async function withStateDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-auto-'))
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = dir
  resetAutoApprove()
  t.after(async () => {
    resetAutoApprove()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

const bash = { sessionId: SESSION, toolName: 'Bash' }

test('★ passes only "yes/no" approvals of sessions turned on', async (t) => {
  await withStateDir(t)
  const now = Date.UTC(2026, 8, 7, 12, 0, 0)

  assert.equal(shouldAutoApprove(bash, now), false, 'must not pass before it is turned on')
  const res = await setAutoApprove(SESSION, true, now)
  assert.equal(res.ok, true)
  assert.equal(shouldAutoApprove(bash, now), true)

  // (1) Does not apply to other sessions (the core of being per session)
  assert.equal(shouldAutoApprove({ sessionId: OTHER, toolName: 'Bash' }, now), false)
  // (1) Do not pass approvals whose `sessionId` could not be determined (unexpected transcript_path shape)
  assert.equal(shouldAutoApprove({ sessionId: undefined, toolName: 'Bash' }, now), false)
  // ★★ A Codex lead's team confirmation is the human's alone, even on a session turned on (2026-11-27)
  assert.equal(shouldAutoApprove({ sessionId: SESSION, toolName: TEAM_CREATE_TOOL }, now), false)
})

test('★★★ stops questions with choices and plan approvals (looks at both criteria)', async (t) => {
  await withStateDir(t)
  const now = Date.UTC(2026, 8, 7, 12, 0, 0)
  await setAutoApprove(SESSION, true, now)

  // (3) Those with `interaction` attached
  assert.equal(
    shouldAutoApprove(
      {
        ...bash,
        toolName: 'AskUserQuestion',
        interaction: { kind: 'question', questions: [{ question: 'どれ？', multiSelect: false, options: [{ label: 'A' }] }] },
      },
      now,
    ),
    false,
    'must not auto-allow a question with choices',
  )
  assert.equal(
    shouldAutoApprove({ ...bash, toolName: 'ExitPlanMode', interaction: { kind: 'plan' } }, now),
    false,
    'must not auto-allow a plan approval',
  )

  // (2) ⚠️⚠️ **Stop by name even without `interaction`.**
  //   `describeInteraction` returns `undefined` for broken input (e.g. `questions` not an array),
  //   so relying only on whether `interaction` is present would let this through
  assert.equal(
    shouldAutoApprove({ ...bash, toolName: 'AskUserQuestion' }, now),
    false,
    'also stops a broken AskUserQuestion (no interaction)',
  )
  assert.equal(shouldAutoApprove({ ...bash, toolName: 'ExitPlanMode' }, now), false)

  // ★★ Pin the reverse too: **even for an unknown tool name, stop if `interaction` is attached.**
  //   ⚠️ MCP tools can also have `requiresUserInteraction`, but **it cannot be told from the hook payload**
  //      (measured, see the top of `claude/interaction.ts`). Relying only on the name table would let it through
  assert.equal(
    shouldAutoApprove({ ...bash, toolName: 'mcp__example__ask', interaction: { kind: 'plan' } }, now),
    false,
    'must not pass something with interaction based on the tool name',
  )
  // ⚠️ Control: the same name without `interaction` passes (= proof the above is not stopped by "name")
  assert.equal(shouldAutoApprove({ ...bash, toolName: 'mcp__example__ask' }, now), true)
})

test('★★ does not pass after the expiry (3 hours)', async (t) => {
  await withStateDir(t)
  const now = Date.UTC(2026, 8, 7, 12, 0, 0)
  await setAutoApprove(SESSION, true, now)

  // (4) Just before and just after the boundary
  assert.equal(shouldAutoApprove(bash, now + THREE_H - 1), true)
  assert.equal(shouldAutoApprove(bash, now + THREE_H), false, 'the expiry instant itself counts as expired')
  assert.equal(shouldAutoApprove(bash, now + THREE_H + 1000), false)
  // The on-screen mark uses the same decision (writing it in two places makes them diverge)
  assert.equal(autoApproveFor(SESSION, now)?.id, SESSION)
  assert.equal(autoApproveFor(SESSION, now + THREE_H), undefined)
  assert.deepEqual(autoApproveList(now + THREE_H), [])
})

test('★★★ the expiry is saved as an "absolute time" (no rewind on restart)', async (t) => {
  const dir = await withStateDir(t)
  const now = Date.UTC(2026, 8, 7, 12, 0, 0)
  await setAutoApprove(SESSION, true, now)

  // (7) **Look at the file the implementation actually wrote** (not a test that passes hand-made values)
  const raw = JSON.parse(await readFile(join(dir, AUTO_APPROVE_FILE), 'utf8')) as {
    v: number
    entries: { scope: string; id: string; until: string; at: string }[]
  }
  assert.equal(raw.v, 1)
  assert.equal(raw.entries.length, 1)
  assert.equal(raw.entries[0]!.id, SESSION)
  assert.equal(raw.entries[0]!.scope, 'session')
  assert.equal(
    Date.parse(raw.entries[0]!.until),
    now + THREE_H,
    'until is not written as an absolute time (remaining time would rewind on restart)',
  )

  // Even after a "restart" 2 hours later, 1 hour remains (it does not go back to 3 hours)
  const restart = now + 2 * 60 * 60 * 1000
  await loadAutoApprove(restart)
  assert.equal(shouldAutoApprove(bash, restart), true, 'not persisted')
  assert.equal(shouldAutoApprove(bash, restart + 61 * 60 * 1000), false, 'the expiry was rewound')
})

test('★★ expired entries are dropped at load', async (t) => {
  const dir = await withStateDir(t)
  const now = Date.UTC(2026, 8, 7, 12, 0, 0)
  await writeFile(
    join(dir, AUTO_APPROVE_FILE),
    JSON.stringify({
      v: 1,
      // ⚠️ Use a realistic `at` (`until <= at + 3 hours` is checked at load, so
      //    a very old `at` makes it **a broken file** = 2026-09-07 codex, high #4)
      entries: [
        { scope: 'session', id: SESSION, until: new Date(now - 1000).toISOString(), at: new Date(now - 60_000).toISOString() },
        { scope: 'session', id: OTHER, until: new Date(now + 60_000).toISOString(), at: new Date(now - 60_000).toISOString() },
      ],
    }),
  )
  await loadAutoApprove(now)
  assert.equal(shouldAutoApprove(bash, now), false, 'must not revive an expired entry')
  assert.equal(shouldAutoApprove({ sessionId: OTHER, toolName: 'Bash' }, now), true)
})

test('★★ malformed entries are treated as "broken" (an unreadable until does not become unlimited)', async (t) => {
  const dir = await withStateDir(t)
  const now = Date.UTC(2026, 8, 7, 12, 0, 0)
  // (5) Values for which `Date.parse` returns NaN. ⚠️ `NaN > now` is false, so pin that it **does not pass**
  await writeFile(
    join(dir, AUTO_APPROVE_FILE),
    JSON.stringify({
      v: 1,
      entries: [
        { scope: 'session', id: SESSION, until: 'こわれている', at: '2026-09-07T00:00:00.000Z' },
        { scope: 'machine', id: OTHER, until: new Date(now + 60_000).toISOString(), at: 'x' },
        { id: 'no-scope', until: new Date(now + 60_000).toISOString(), at: 'x' },
      ],
    }),
  )
  await loadAutoApprove(now)
  assert.deepEqual(autoApproveList(now), [], 'must not use any malformed entry')
  assert.equal(shouldAutoApprove(bash, now), false)
  // ★★ **The contract changed** on 2026-09-07 (codex, medium #6). It used to "drop only malformed entries and treat it as normal",
  //   but then **a later turn-on overwrites the evidence**.
  //   ⇒ A correct writer never produces these values, so **the whole thing is broken** (off + no writes)
  assert.ok(autoApproveBroken(), 'malformed entries treated as normal (evidence would be overwritten)')
})

test('★★★ a broken state file falls back to off and refuses writes', async (t) => {
  const dir = await withStateDir(t)
  const now = Date.UTC(2026, 8, 7, 12, 0, 0)
  await writeFile(join(dir, AUTO_APPROVE_FILE), '{ こわれた JSON')
  await loadAutoApprove(now)

  // (6) Not fail-open
  assert.ok(autoApproveBroken(), 'does not remember that it is broken')
  assert.equal(shouldAutoApprove(bash, now), false)
  const res = await setAutoApprove(SESSION, true, now)
  assert.equal(res.ok, false, 'writes even though broken (the evidence is lost)')
  assert.equal(shouldAutoApprove(bash, now), false, 'on even though it was refused')
  // ⚠️ Do not mix absolute paths or file contents into the refusal reason (§2)
  if (!res.ok) {
    assert.ok(!res.reason.includes('/'), `reason contains a path: ${res.reason}`)
    assert.ok(!res.reason.includes('こわれた'), `reason contains file contents: ${res.reason}`)
  }
  // The file is not overwritten (the material for recovery remains)
  assert.equal(await readFile(join(dir, AUTO_APPROVE_FILE), 'utf8'), '{ こわれた JSON')
})

test('★★★ "on" starts passing only after it is saved', async (t) => {
  const dir = await withStateDir(t)
  const now = Date.UTC(2026, 8, 7, 12, 0, 0)
  // (8) Make the state directory **a file** so writes fail (mkdir cannot succeed)
  const blocked = join(dir, 'blocked')
  await writeFile(blocked, 'これはファイル')
  process.env['NYAN_REMOTE_STATE_DIR'] = blocked

  const res = await setAutoApprove(SESSION, true, now)
  assert.equal(res.ok, false, 'returns success although saving failed')
  assert.equal(shouldAutoApprove(bash, now), false, 'starts passing although not saved')
})

test('★★ "off" stops without waiting for a save failure (and reports the failure)', async (t) => {
  const dir = await withStateDir(t)
  const now = Date.UTC(2026, 8, 7, 12, 0, 0)
  await setAutoApprove(SESSION, true, now)
  assert.equal(shouldAutoApprove(bash, now), true)

  // Set up a situation where only saving fails
  const blocked = join(dir, 'blocked')
  await writeFile(blocked, 'これはファイル')
  process.env['NYAN_REMOTE_STATE_DIR'] = blocked

  const res = await setAutoApprove(SESSION, false, now)
  assert.equal(res.ok, false, 'silently shows a save failure as success')
  if (!res.ok) assert.equal(res.saved, false)
  // ⚠️ Even so, **passing has stopped** (the safe direction)
  assert.equal(shouldAutoApprove(bash, now), false, 'keeps passing after being turned off')
})

test('★ turning off also removes it from the file', async (t) => {
  const dir = await withStateDir(t)
  const now = Date.UTC(2026, 8, 7, 12, 0, 0)
  await setAutoApprove(SESSION, true, now)
  await setAutoApprove(OTHER, true, now)
  await setAutoApprove(SESSION, false, now)
  assert.equal(shouldAutoApprove(bash, now), false)
  assert.equal(shouldAutoApprove({ sessionId: OTHER, toolName: 'Bash' }, now), true)

  const raw = JSON.parse(await readFile(join(dir, AUTO_APPROVE_FILE), 'utf8')) as {
    entries: { id: string }[]
  }
  assert.deepEqual(raw.entries.map((e) => e.id), [OTHER])
})

test('★ turning on the same session twice leaves one entry (expiry is reset)', async (t) => {
  const dir = await withStateDir(t)
  const now = Date.UTC(2026, 8, 7, 12, 0, 0)
  await setAutoApprove(SESSION, true, now)
  await setAutoApprove(SESSION, true, now + 60_000)
  const raw = JSON.parse(await readFile(join(dir, AUTO_APPROVE_FILE), 'utf8')) as {
    entries: { id: string; until: string }[]
  }
  assert.equal(raw.entries.length, 1, 'duplicate entries')
  assert.equal(Date.parse(raw.entries[0]!.until), now + 60_000 + THREE_H)
})

/**
 * ★ On expiry, announce "it expired" once (= **without the announcement nobody notices it expired**).
 *
 * ⚠️ The timer handles **only the announcement**. Whether it is in effect is always
 *    `untilMs > now`, so even if the timer is skipped it never keeps passing (the tests above).
 * ⚠️ While waiting, keep one **ref'd timer** (the entry timers are `unref`ed, so
 *    with nothing else Node could exit first).
 */
async function waitForExpiry(ms: number): Promise<string | undefined> {
  return await new Promise<string | undefined>((resolve) => {
    const sentinel = setTimeout(() => resolve(undefined), ms)
    setAutoApproveExpiryHandler((entry) => {
      clearTimeout(sentinel)
      resolve(entry.id)
    })
  })
}

/** Wait until the entries in the file reach `want` (★ saving runs asynchronously) */
async function entriesInFile(dir: string, ms: number): Promise<unknown[]> {
  const deadline = Date.now() + ms
  let last: unknown[] = []
  for (;;) {
    const raw = JSON.parse(await readFile(join(dir, AUTO_APPROVE_FILE), 'utf8')) as { entries?: unknown[] }
    last = raw.entries ?? []
    if (last.length === 0 || Date.now() > deadline) return last
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('★★ turns off automatically on expiry and announces it once', async (t) => {
  const dir = await withStateDir(t)
  const now = Date.now()
  await writeFile(
    join(dir, AUTO_APPROVE_FILE),
    JSON.stringify({
      v: 1,
      entries: [
        { scope: 'session', id: SESSION, until: new Date(now + 40).toISOString(), at: new Date(now).toISOString() },
      ],
    }),
  )
  await loadAutoApprove(now)
  assert.equal(shouldAutoApprove(bash, now), true, 'precondition: valid for 40ms')

  assert.equal(await waitForExpiry(500), SESSION, 'did not announce although it expired')
  assert.equal(shouldAutoApprove(bash, Date.now()), false)
  assert.deepEqual(autoApproveList(Date.now()), [], 'entries remain')
  // ★ Also gone from the file (not revived on restart).
  //   ⚠️ Saving runs **after the announcement** (so the notification is not delayed), so wait for the write
  assert.deepEqual(await entriesInFile(dir, 500), [], 'entries remain in the file')
})

test('★★★ an unreadable expiry does not trigger a "just expired" notification', async (t) => {
  // ⚠️⚠️ Mutation (5) from 2026-09-07. With `NaN` in `untilMs`, `ms <= 0` is **false**, and
  //    `setTimeout(fn, NaN)` is **treated as 1ms** and fires at once = one "expired" sent right after startup
  //    (the decision side is safe because `NaN > now` is false, but **the notification alone lies**).
  //    ⇒ Prevented by never creating the entry (`validEntry`).
  const dir = await withStateDir(t)
  const now = Date.now()
  await writeFile(
    join(dir, AUTO_APPROVE_FILE),
    JSON.stringify({
      v: 1,
      entries: [{ scope: 'session', id: SESSION, until: 'こわれている', at: new Date(now).toISOString() }],
    }),
  )
  await loadAutoApprove(now)
  assert.equal(await waitForExpiry(120), undefined, 'announces expiry of an entry that was never created')
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ Reproductions of the codex findings (2026-09-07 / read-only)
// ─────────────────────────────────────────────────────────────────────────────

test('★★★ high #1: turning off while "on" is saving, off wins (no revival)', async (t) => {
  const dir = await withStateDir(t)
  const now = Date.UTC(2026, 8, 7, 12, 0, 0)

  // ⚠️⚠️ **Fire both without an `await` in between** (double tap, two phones, pressing off again).
  //    If only saving is serialized, the rest of "on" (`active.set`) runs **after** the off and **revives it**
  const onP = setAutoApprove(SESSION, true, now)
  const offP = setAutoApprove(SESSION, false, now + 1)
  const [onRes, offRes] = await Promise.all([onP, offP])
  assert.equal(onRes.ok, true)
  assert.equal(offRes.ok, true)

  // ★ The last one was off ⇒ **must not pass**
  assert.equal(shouldAutoApprove(bash, now + 2), false, '⚠️ keeps allowing after being turned off')
  // ★ The saved contents and memory agree (nothing changes on restart)
  assert.deepEqual(await entriesInFile(dir, 500), [], 'entries remain in the file')
  assert.deepEqual(autoApproveList(now + 2), [])
})

test('★★★ high #1b: turning on two sessions at once saves both', async (t) => {
  const dir = await withStateDir(t)
  const now = Date.UTC(2026, 8, 7, 12, 0, 0)
  // ⚠️ Building the saved set from "its own continuation" **drops the other one**
  //    (2 in memory, 1 in the file = only one survives a restart)
  await Promise.all([setAutoApprove(SESSION, true, now), setAutoApprove(OTHER, true, now)])
  assert.equal(shouldAutoApprove(bash, now), true)
  assert.equal(shouldAutoApprove({ sessionId: OTHER, toolName: 'Bash' }, now), true)
  const raw = JSON.parse(await readFile(join(dir, AUTO_APPROVE_FILE), 'utf8')) as {
    entries: { id: string }[]
  }
  assert.deepEqual(raw.entries.map((e) => e.id).sort(), [SESSION, OTHER].sort(), 'missing from the file')
})

test('★★★ high #4: an expiry beyond the cap (24 hours) from `at` is not used (tampered or broken file)', async (t) => {
  const dir = await withStateDir(t)
  const now = Date.UTC(2026, 8, 7, 12, 0, 0)
  await writeFile(
    join(dir, AUTO_APPROVE_FILE),
    JSON.stringify({
      v: 1,
      entries: [
        {
          scope: 'session',
          id: SESSION,
          at: new Date(now).toISOString(),
          // ⚠️⚠️ Exceeds the cap by even 1 second (a value the normal path cannot produce / the cap became 24 hours on 2026-09-24)
          until: new Date(now + AUTO_APPROVE_MAX_MS + 1000).toISOString(),
        },
      ],
    }),
  )
  await loadAutoApprove(now)
  // ★ An entry beyond the cap is **not used** (= does not pass 4 hours later)
  assert.equal(
    shouldAutoApprove(bash, now + 4 * 60 * 60 * 1000),
    false,
    '⚠️ allows with an expiry beyond the cap',
  )
  // ⚠️ The state file is abnormal, so **fall back to off and do not write** (keep the evidence)
  assert.ok(autoApproveBroken(), 'treats an abnormal file as normal')
  assert.equal(shouldAutoApprove(bash, now), false)
})

test('★★★ high #5: if the expiry passed while stopped, announce once at startup', async (t) => {
  const dir = await withStateDir(t)
  const now = Date.now()
  const seen: string[] = []
  setAutoApproveExpiryHandler((e) => seen.push(e.id))
  // Turned on, then the agent stopped, and it started again after the expiry
  await writeFile(
    join(dir, AUTO_APPROVE_FILE),
    JSON.stringify({
      v: 1,
      entries: [
        {
          scope: 'session',
          id: SESSION,
          at: new Date(now - 4 * 60 * 60 * 1000).toISOString(),
          until: new Date(now - 60 * 60 * 1000).toISOString(),
        },
      ],
    }),
  )
  await loadAutoApprove(now)
  assert.deepEqual(seen, [SESSION], '⚠️ did not announce the expiry (requirement (4) fails)')
  assert.equal(shouldAutoApprove(bash, now), false)
  // ★★ **Remove it from the file** (otherwise the same notification fires on every restart)
  assert.deepEqual(await entriesInFile(dir, 500), [], 'the cleaned result was not saved')

  // ⚠️ No announcement on the second start
  seen.length = 0
  await loadAutoApprove(now + 1000)
  assert.deepEqual(seen, [], 'the same notification fires on every restart')
})

test('★★ medium #6: valid JSON with a broken structure is treated as "broken"', async (t) => {
  const dir = await withStateDir(t)
  const now = Date.UTC(2026, 8, 7, 12, 0, 0)
  for (const bad of [
    { v: 1, entries: '壊れた値' },
    { v: 2, entries: [] },
    { entries: [] },
    { v: 1, entries: [{ scope: 'session', id: SESSION, until: 'x', at: 'y' }] },
    // ⚠️⚠️ **Only `at` is unreadable** (`until` is valid). Letting this through turns the `at + 3 hours` check
    //    into a comparison with `NaN`, **always false = the cap stops working**
    //    (added because the mutation "remove the at check" slipped through on 2026-09-07)
    { v: 1, entries: [{ scope: 'session', id: SESSION, until: new Date(now + 60_000).toISOString(), at: 'こわれている' }] },
    { v: 1, entries: [{ scope: 'machine', id: SESSION, until: new Date(now + 1000).toISOString(), at: new Date(now).toISOString() }] },
  ]) {
    const text = JSON.stringify(bad)
    await writeFile(join(dir, AUTO_APPROVE_FILE), text)
    await loadAutoApprove(now)
    assert.ok(autoApproveBroken(), `treated as normal: ${text}`)
    assert.equal(shouldAutoApprove(bash, now), false)
    // ⚠️⚠️ **Do not write** (do not destroy the material for recovery)
    const res = await setAutoApprove(SESSION, true, now)
    assert.equal(res.ok, false, `could write although broken: ${text}`)
    assert.equal(await readFile(join(dir, AUTO_APPROVE_FILE), 'utf8'), text, `overwrote: ${text}`)
  }
})

test('★★ medium #4 (round 2): no announcement if the cleanup could not be saved (does not fire on every restart)', async (t) => {
  const dir = await withStateDir(t)
  const now = Date.now()
  const seen: string[] = []
  setAutoApproveExpiryHandler((e) => seen.push(e.id))
  // An entry that expired while stopped (the file is **readable**)
  const text = JSON.stringify({
    v: 1,
    entries: [
      {
        scope: 'session',
        id: SESSION,
        at: new Date(now - 4 * 60 * 60 * 1000).toISOString(),
        until: new Date(now - 60 * 60 * 1000).toISOString(),
      },
    ],
  })
  await writeFile(join(dir, AUTO_APPROVE_FILE), text)

  // ⚠️ Set up readable but **not writable** (make the state directory read-only)
  //   ⚠️ Always restore it before cleanup (restored below; putting it in `t.after` runs it **after** `rm` and gives ENOENT)
  await chmod(dir, 0o500)
  await loadAutoApprove(now)
  // ★ Allowing has stopped (the decision is in memory)
  assert.equal(shouldAutoApprove(bash, now), false)
  // ⚠️⚠️ **Do not announce** (the entry is still on disk, so announcing would fire every time)
  assert.deepEqual(seen, [], 'notifies although not saved (would fire on every restart)')
  // ★ The file is untouched (can retry on the next start)
  assert.equal(await readFile(join(dir, AUTO_APPROVE_FILE), 'utf8'), text)

  // ★ Once writable, announce once on that start
  await chmod(dir, 0o700)
  await loadAutoApprove(now + 1000)
  assert.deepEqual(seen, [SESSION], 'did not announce on retry')
  assert.deepEqual(await entriesInFile(dir, 500), [])
})

test('★★ the duration is chosen by name (3h / 24h), the cap is the longest in the table, unknown names are refused (2026-09-24)', async (t) => {
  await withStateDir(t)
  const { toAutoApproveDuration } = await import('./autoApprove.ts')
  const now = Date.UTC(2026, 8, 24, 12, 0, 0)
  assert.equal(AUTO_APPROVE_DURATIONS['3h'], 3 * 60 * 60 * 1000)
  assert.equal(AUTO_APPROVE_DURATIONS['24h'], 24 * 60 * 60 * 1000)
  assert.equal(AUTO_APPROVE_MAX_MS, AUTO_APPROVE_DURATIONS['24h'])
  const res = await setAutoApprove(SESSION, true, now, '24h')
  assert.ok(res.ok && res.entry)
  assert.equal(Date.parse(res.entry.until), now + AUTO_APPROVE_DURATIONS['24h'])
  assert.equal(shouldAutoApprove(bash, now + AUTO_APPROVE_DURATIONS['24h'] - 1), true)
  assert.equal(shouldAutoApprove(bash, now + AUTO_APPROVE_DURATIONS['24h']), false)
  // ★ After restart a 24-hour entry is not treated as broken (within the cap)
  resetAutoApprove()
  await loadAutoApprove(now + 60_000)
  assert.equal(autoApproveBroken(), undefined, '⚠️⚠️ read a 24-hour entry as "broken" (it would turn off on restart)')
  assert.equal(shouldAutoApprove(bash, now + 60_000), true)
  // ⚠️⚠️ Unknown names and raw lengths are refused (no fallback to the default)
  for (const bad of ['72h', 'forever', 86_400_000, '', null, 'constructor', '__proto__']) {
    assert.equal(toAutoApproveDuration(bad), undefined, String(bad))
  }
})

test('★★ SessionEnd stops auto-approve at once, even while the chain is busy saving another session (codex 2026-11-15, seventh review, high)', async (t) => {
  await withStateDir(t)
  assert.equal((await setAutoApprove(SESSION, true)).ok, true)
  // Another session's toggle is saving (not awaited) when SESSION ends
  const other = setAutoApprove(OTHER, true)
  // Let its section start (it takes the set to save from memory, SESSION included)
  await new Promise((r) => setImmediate(r))
  const ended = endSessionAutoApprove(SESSION)
  // ⚠️⚠️ Before the chain gets to it: an approval of the ended session must not pass any more
  assert.equal(shouldAutoApprove({ sessionId: SESSION, toolName: 'Bash' }), false)
  assert.equal(autoApproveFor(SESSION), undefined)
  assert.deepEqual(await ended, { ok: true, had: true })
  assert.equal((await other).ok, true)
  // ★ And the file agrees (the other toggle had taken its set from memory before the end)
  const stored = JSON.parse(await readFile(join(process.env['NYAN_REMOTE_STATE_DIR']!, AUTO_APPROVE_FILE), 'utf8')) as { entries: Array<{ id: string }> }
  assert.deepEqual(stored.entries.map((e) => e.id), [OTHER])
})

test('★★ an "on" still saving when the session ends never comes back, even while another save holds the chain (codex 2026-11-15, eighth review, high)', async (t) => {
  await withStateDir(t)
  // A is turned on (saving), B's toggle queues behind it, then A ends (its cleanup queues behind B)
  const onA = setAutoApprove(SESSION, true)
  const onB = setAutoApprove(OTHER, true)
  const ended = endSessionAutoApprove(SESSION)
  // Step through the chain: at no point may an approval of A pass
  let done = false
  void Promise.all([onA, onB, ended]).then(() => (done = true))
  for (let i = 0; i < 5000 && !done; i++) {
    assert.equal(shouldAutoApprove({ sessionId: SESSION, toolName: 'Bash' }), false, 'the ended session was auto-approved')
    // ★ Alternate: a turn of the event loop (an approval can arrive between two I/O steps), then a millisecond
    await new Promise((r) => (i % 2 === 0 ? setImmediate(r) : setTimeout(r, 1)))
  }
  assert.ok(done)
  assert.equal((await onA).ok, true, 'the phone is not told of a failure (the session simply ended)')
  assert.deepEqual(await ended, { ok: true, had: true }, 'the cancelled "on" counts, so the phone is told')
  assert.equal(autoApproveFor(SESSION), undefined)
  assert.ok(autoApproveFor(OTHER))
  // ★ The file agrees: a restart does not revive A
  const stored = JSON.parse(await readFile(join(process.env['NYAN_REMOTE_STATE_DIR']!, AUTO_APPROVE_FILE), 'utf8')) as { entries: Array<{ id: string }> }
  assert.deepEqual(stored.entries.map((e) => e.id), [OTHER])
})

test('an "on" asked after the session ended is a new start and takes effect', async (t) => {
  await withStateDir(t)
  assert.equal((await setAutoApprove(SESSION, true)).ok, true)
  const ended = endSessionAutoApprove(SESSION)
  const again = setAutoApprove(SESSION, true)
  await ended
  const r = await again
  assert.ok(r.ok && r.entry)
  assert.ok(autoApproveFor(SESSION))
})

test('an end that arrives while the "on" is being written: not taken, and the file is written again without it', async (t) => {
  await withStateDir(t)
  const on = setAutoApprove(SESSION, true)
  // Let its section start writing, then end the session (nothing else is queued to write after it)
  await new Promise((r) => setImmediate(r))
  const ended = endSessionAutoApprove(SESSION)
  assert.equal((await on).ok, true)
  assert.deepEqual(await ended, { ok: true, had: true })
  assert.equal(autoApproveFor(SESSION), undefined)
  const stored = JSON.parse(await readFile(join(process.env['NYAN_REMOTE_STATE_DIR']!, AUTO_APPROVE_FILE), 'utf8')) as { entries: Array<{ id: string }> }
  assert.deepEqual(stored.entries, [], 'a restart would revive it')
})

test('★★ a complete list of a Codex home ends the entries of its threads that are not loaded, and nothing else (codex review 2026-11-17, high)', async (t) => {
  await withStateDir(t)
  const prefix = 'codex-0123456789abcdef-'
  const open = prefix + 'open'
  const gone = prefix + 'gone'
  const otherHome = 'codex-fedcba9876543210-gone'
  for (const id of [open, gone, otherHome, SESSION]) assert.equal((await setAutoApprove(id, true)).ok, true)
  const r = await endCodexAutoApproveOutside(prefix, new Set([open]))
  assert.deepEqual(r, { ended: 1, failed: undefined })
  assert.equal(autoApproveFor(gone), undefined)
  assert.ok(autoApproveFor(open), 'a loaded thread keeps it')
  assert.ok(autoApproveFor(otherHome), 'another home is not this list')
  assert.ok(autoApproveFor(SESSION), 'a Claude session is never ended here')
  // ⚠️ A prefix that is not a Codex one ends nothing (a Claude id would match an empty prefix)
  assert.deepEqual(await endCodexAutoApproveOutside('', new Set()), { ended: 0, failed: undefined })
  assert.ok(autoApproveFor(SESSION))
  const stored = JSON.parse(await readFile(join(process.env['NYAN_REMOTE_STATE_DIR']!, AUTO_APPROVE_FILE), 'utf8')) as { entries: Array<{ id: string }> }
  assert.deepEqual(stored.entries.map((e) => e.id).sort(), [SESSION, open, otherHome].sort())
})

test('★★ an "on" still saving when a Codex snapshot leaves its thread out is cancelled; one asked after it is kept (codex review 2026-11-17, round 2, high)', async (t) => {
  await withStateDir(t)
  const prefix = 'codex-0123456789abcdef-'
  const gone = prefix + 'gone'
  const later = prefix + 'later'
  // Asked, not awaited: queued or saving when the snapshot comes
  const on = setAutoApprove(gone, true)
  const r = endCodexAutoApproveOutside(prefix, new Set())
  // An "on" asked after the snapshot is the phone's new wish (the thread was loaded again meanwhile)
  const onLater = setAutoApprove(later, true)
  assert.equal((await on).ok, true)
  assert.deepEqual(await r, { ended: 1, failed: undefined })
  assert.equal((await onLater).ok, true)
  assert.equal(autoApproveFor(gone), undefined, '⚠️⚠️ the pending "on" installed itself for the closed thread')
  assert.ok(autoApproveFor(later))
  const stored = JSON.parse(await readFile(join(process.env['NYAN_REMOTE_STATE_DIR']!, AUTO_APPROVE_FILE), 'utf8')) as { entries: Array<{ id: string }> }
  assert.deepEqual(stored.entries.map((e) => e.id), [later])
})

test('★★ an "off" stops passing the moment it is asked, even while it waits behind another session\'s save', async (t) => {
  await withStateDir(t)
  const X = '0d6d4d8c-1111-2222-3333-444455556666'
  const Y = '0d6d4d8c-7777-2222-3333-444455556666'
  await setAutoApprove(X, true)
  assert.equal(shouldAutoApprove({ sessionId: X, toolName: 'Bash' }), true)
  const y = setAutoApprove(Y, true)
  const off = setAutoApprove(X, false)
  // still queued behind Y's save: already not passing
  assert.equal(shouldAutoApprove({ sessionId: X, toolName: 'Bash' }), false)
  await Promise.all([y, off])
  assert.equal(shouldAutoApprove({ sessionId: X, toolName: 'Bash' }), false)
  assert.equal(shouldAutoApprove({ sessionId: Y, toolName: 'Bash' }), true)
  // a later "on" passes again
  await setAutoApprove(X, true)
  assert.equal(shouldAutoApprove({ sessionId: X, toolName: 'Bash' }), true)
})

test('★★ agy grants are memory only: never written, ignored when read back (an older agent could neither use nor end one)', async (t) => {
  const dir = await withStateDir(t)
  const AGY = 'agy-062a8f25-9451-42f3-ae93-34a208e99365'
  await setAutoApprove(AGY, true)
  await setAutoApprove(SESSION, true)
  assert.ok(autoApproveFor(AGY))
  const stored = JSON.parse(await readFile(join(dir, AUTO_APPROVE_FILE), 'utf8')) as { entries: { id: string }[] }
  assert.deepEqual(stored.entries.map((e) => e.id), [SESSION])
  // one written by hand is ignored on load
  const until = new Date(Date.now() + 60_000).toISOString()
  await writeFile(join(dir, AUTO_APPROVE_FILE), JSON.stringify({ v: 1, entries: [{ scope: 'session', id: AGY, until, at: new Date().toISOString() }] }))
  resetAutoApprove()
  await loadAutoApprove()
  assert.equal(autoApproveFor(AGY), undefined)
})

test('★ a memory-only (agy) grant turns on and off without touching the file (a full disk says nothing false)', async (t) => {
  const dir = await withStateDir(t)
  const AGY = 'agy-062a8f25-9451-42f3-ae93-34a208e99365'
  await setAutoApprove(SESSION, true)
  const before = await readFile(join(dir, AUTO_APPROVE_FILE), 'utf8')
  await chmod(dir, 0o500)
  t.after(() => chmod(dir, 0o700).catch(() => undefined))
  assert.equal((await setAutoApprove(AGY, true)).ok, true)
  assert.deepEqual(await setAutoApprove(AGY, false), { ok: true })
  assert.equal(autoApproveFor(AGY), undefined)
  await setAutoApprove(AGY, true)
  assert.deepEqual(await endSessionAutoApprove(AGY), { ok: true, had: true })
  await chmod(dir, 0o700)
  assert.equal(await readFile(join(dir, AUTO_APPROVE_FILE), 'utf8'), before)
})

test('★ an agy "off" with a broken state file is done (no "a restart revives it" warning)', async (t) => {
  const dir = await withStateDir(t)
  await writeFile(join(dir, AUTO_APPROVE_FILE), '{ broken')
  await loadAutoApprove()
  assert.ok(autoApproveBroken())
  assert.deepEqual(await setAutoApprove('agy-062a8f25-9451-42f3-ae93-34a208e99365', false), { ok: true })
  assert.equal((await setAutoApprove(SESSION, false)).ok, false, 'a Claude grant still says it could not save')
})
