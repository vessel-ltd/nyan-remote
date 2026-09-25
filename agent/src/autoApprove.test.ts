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
  loadAutoApprove,
  resetAutoApprove,
  setAutoApproveExpiryHandler,
  setAutoApprove,
  shouldAutoApprove,
} from './autoApprove.ts'

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
