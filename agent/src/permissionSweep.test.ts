import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { abandon, abandonSession, fingerprint, listPending, resetPending, waitForDecision } from './permission.ts'
import { clearPermission, hooksFor, noteHook } from './claude/hookState.ts'
import { clearLabelIfSettled, executedAt, sweepResolved } from './permissionSweep.ts'

import type { PermissionRequest } from '../../shared/types.ts'

// ★★ What this test guards:
//
//   **Approving on the PC does not cut the hook's connection** (measured 2026-08-13). If nobody cleans up,
//   an already-answered card stays on the phone until timeout (24 hours) and does nothing when pressed.
//   → "It already ran" is judged by **whether that tool's `tool_result` was written** to the transcript.
//
// ⚠️ "The session's last activity is newer than the approval" cannot decide it. Tools are called in parallel
//    within one turn, so another Bash waiting while an auto-approved Read's result is written
//    is perfectly normal. Clearing on that basis **throws away a waiting approval**.

const assistantToolUse = (id: string, name: string, input: unknown, at = '2026-08-13T07:52:40.000Z') => ({
  type: 'assistant',
  timestamp: at,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
})

const userToolResult = (
  id: string,
  opts: { error?: boolean; at?: string } = {},
) => ({
  type: 'user',
  timestamp: opts.at ?? '2026-08-13T07:52:55.000Z',
  message: {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: id, is_error: opts.error === true, content: '結果' },
    ],
  },
})

test('★★ executedAt: only checks whether the latest tool_use has a result', () => {
  const records = [
    assistantToolUse('tu_1', 'Bash', { command: 'npm test' }),
    assistantToolUse('tu_2', 'Bash', { command: 'git push' }),
    userToolResult('tu_1'), // only the first has a result
  ]
  const done = executedAt(records)
  assert.equal(done.get(fingerprint('Bash', { command: 'npm test' })), Date.parse('2026-08-13T07:52:55.000Z'))
  // ★ this is the point. Something without a result must not be treated as executed (it would discard a waiting approval)
  assert.equal(done.get(fingerprint('Bash', { command: 'git push' })), null, 'null if there is no result')
})

test('★★ executedAt: null if the second run of the same command is unresolved (do not discard it using the first result)', () => {
  // ⚠️ 2026-08-13 external review finding. Running `npm test` twice in one turn is routine, and
  //    judging by "some tool_use with that fingerprint has a result" **immediately discards the second approval**.
  const fp = fingerprint('Bash', { command: 'npm test' })
  const done = executedAt([
    assistantToolUse('tu_1', 'Bash', { command: 'npm test' }, '2026-08-13T07:00:00.000Z'),
    userToolResult('tu_1', { at: '2026-08-13T07:00:10.000Z' }),
    // the second run. No result yet (= waiting for approval now)
    assistantToolUse('tu_2', 'Bash', { command: 'npm test' }, '2026-08-13T08:00:00.000Z'),
  ])
  assert.equal(done.get(fp), null, '★ null if the latest is unresolved. Must not be discarded')
})

test('executedAt: if the same command finished both times, the newer time', () => {
  const fp = fingerprint('Bash', { command: 'npm test' })
  const done = executedAt([
    assistantToolUse('tu_1', 'Bash', { command: 'npm test' }, '2026-08-13T07:00:00.000Z'),
    userToolResult('tu_1', { at: '2026-08-13T07:00:10.000Z' }),
    assistantToolUse('tu_2', 'Bash', { command: 'npm test' }, '2026-08-13T08:00:00.000Z'),
    userToolResult('tu_2', { at: '2026-08-13T08:00:10.000Z' }),
  ])
  assert.equal(done.get(fp), Date.parse('2026-08-13T08:00:10.000Z'))
})

test('★ executedAt: denied (is_error) ones count as executed too', () => {
  // a result is written even if "deny" is chosen on the PC. The card can be cleared either way
  const done = executedAt([
    assistantToolUse('tu_9', 'Bash', { command: 'rm -rf /' }),
    userToolResult('tu_9', { error: true }),
  ])
  assert.ok(done.has(fingerprint('Bash', { command: 'rm -rf /' })))
})

test('executedAt: recognised as the same even if argument key order differs', () => {
  const done = executedAt([
    assistantToolUse('tu_1', 'Bash', { command: 'ls', timeout: 5 }),
    userToolResult('tu_1'),
  ])
  assert.ok(done.has(fingerprint('Bash', { timeout: 5, command: 'ls' })))
})

test('executedAt: a result with an unreadable time is treated as "unresolved" (the premise is separating by time)', () => {
  // ⚠️ without a readable time we cannot tell "after the approval or not". Lean toward not discarding (null)
  const done = executedAt([
    assistantToolUse('tu_1', 'Bash', { command: 'ls' }),
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] } },
  ])
  assert.equal(done.get(fingerprint('Bash', { command: 'ls' })), null)
})

test('executedAt: does not crash on broken or unrelated records', () => {
  const done = executedAt([
    { type: 'system', subtype: 'away_summary', content: 'x' },
    { type: 'assistant', message: { content: 'ただの文字列' } },
    { type: 'user', message: {} },
    {},
    // a result whose matching tool_use is missing (cut off at the start)
    userToolResult('tu_missing'),
  ])
  assert.equal(done.size, 0)
})

// ── How cards are discarded ─────────────────────────────────────

const info = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  key: 'k1',
  machine: 'PC-A',
  account: '.claude-r',
  project: 'tmux-agent',
  toolName: 'Bash',
  summary: 'touch x',
  at: '2026-08-13T07:52:47.000Z',
  ...over,
})

test('★ abandon: discard without returning a decision (must not be deny)', async () => {
  resetPending()
  const p = waitForDecision(info(), () => {})
  assert.equal(abandon('k1'), true)
  // ⚠️ undefined = no decision. Returning deny for something already allowed on the PC does the opposite of the intent
  assert.equal(await p, undefined)
  assert.equal(listPending().length, 0)
  // the second time is false (already gone)
  assert.equal(abandon('k1'), false)
})

test('★★ abandonSession: when the turn ends, discard all of that session\'s cards', async () => {
  resetPending()
  const a = waitForDecision(info({ key: 'a', sessionId: 's1' }), () => {})
  const b = waitForDecision(info({ key: 'b', sessionId: 's1' }), () => {})
  const c = waitForDecision(info({ key: 'c', sessionId: 's2' }), () => {})

  assert.equal(abandonSession('s1'), 2)
  assert.equal(await a, undefined)
  assert.equal(await b, undefined)
  // ★ keep other sessions' cards
  assert.equal(listPending().length, 1)
  assert.equal(listPending()[0]?.key, 'c')
  resetPending()
  assert.equal(await c, undefined)
})

test('★★ abandonSession: keep those from sub-agents (teammates keep running after the main turn)', async () => {
  // ⚠️ the cause of `/code-review` hanging twice on a real device on 2026-08-16. Log sequence:
  //      approval request from a sub-agent → approval-wait notified → **cleared at turn end**
  //    → the notification arrives but **the thread has no approve button** (cannot recover while away).
  //    My comment "by the time Stop arrives it is certainly invalid" was wrong.
  resetPending()
  const main = waitForDecision(info({ key: 'm1', sessionId: 's1' }), () => {})
  const sub = waitForDecision(
    info({ key: 'sub1', sessionId: 's1', agentType: 'general-purpose' }),
    () => {},
  )

  assert.equal(abandonSession('s1'), 1, 'only the main one is cleared')
  assert.equal(await main, undefined)
  // ★ the sub-agent's approval stays alive = can be answered from the phone
  assert.deepEqual(listPending().map((p) => p.key), ['sub1'])
  resetPending()
  assert.equal(await sub, undefined)
})

test('abandonSession: does nothing without a sessionId (does not clear everything)', () => {
  resetPending()
  void waitForDecision(info({ key: 'x', sessionId: 's1' }), () => {})
  assert.equal(abandonSession(undefined), 0)
  assert.equal(listPending().length, 1)
  resetPending()
})

// ── Whether sub-agent approvals get cleared (a hole found on a real device on 2026-08-14) ──────

test('★★ sweepResolved: sub-agent approvals are cleared via "the sub-agent\'s transcript"', async () => {
  // ⚠️ this was today's biggest discovery.
  //    The hook's `transcript_path` points to **the main** transcript, but the sub-agent's
  //    `tool_use` / `tool_result` **are not written there** (a separate file).
  //    While only the main one was read, auto-approved sub-agent cards **were never cleared**, and
  //    the silencing "check again after 6 seconds" was **the same as not checking**
  //    (= however quickly it was auto-approved, a notification always went to the phone).
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-sweep-'))
  try {
    const main = join(dir, 'sess-1.jsonl')
    // the main transcript has **no record of this tool** (same situation as on the real device)
    await writeFile(main, `${JSON.stringify(assistantToolUse('tu_other', 'Read', { file_path: '/x' }))}\n`)

    const subs = join(dir, 'sess-1', 'subagents')
    await mkdir(subs, { recursive: true })
    await writeFile(
      join(subs, 'agent-a1.jsonl'),
      [
        JSON.stringify(assistantToolUse('tu_1', 'Bash', { command: 'git status' }, '2026-08-14T03:55:57.000Z')),
        JSON.stringify(userToolResult('tu_1', { at: '2026-08-14T03:56:03.000Z' })),
      ].join('\n') + '\n',
    )

    resetPending()
    const waiting = waitForDecision(
      info({ key: 'k-sub', sessionId: 's1', at: '2026-08-14T03:55:57.000Z' }),
      () => {},
      { transcriptPath: main, agentId: 'a1', toolInput: { command: 'git status' } },
    )
    assert.equal(await sweepResolved(), 1, '★ cleared by looking at the sub-agent\'s result')
    assert.equal(await waiting, undefined)
    assert.equal(listPending().length, 0)

    // ★★ the reverse check (avoids false green): without passing `agentId` = the same state as an implementation
    //    that reads only the main transcript, it **does not clear**. This difference is the substance of the fix
    resetPending()
    void waitForDecision(
      info({ key: 'k-sub2', sessionId: 's1', at: '2026-08-14T03:55:57.000Z' }),
      () => {},
      { transcriptPath: main, toolInput: { command: 'git status' } },
    )
    assert.equal(await sweepResolved(), 0, 'not found when reading only the main one (= the old behaviour)')
    assert.equal(listPending().length, 1)
    resetPending()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('★★ clearPermission: clearing also removes the basis for the "needs attention" label', () => {
  // ⚠️ without this, after approving on the PC **the list shows "needs attention" until the tool finishes**.
  //    The shape a user reported as "it says needs attention while working" (2026-08-13).
  noteHook({
    event: 'Notification',
    machine: 'PC-B',
    account: '.claude-s',
    project: 'p',
    sessionId: 's1',
    at: '2026-08-13T09:00:00.000Z',
    notice: 'permission',
  })
  assert.ok(hooksFor('s1')?.permission, 'recorded')
  assert.equal(clearPermission('s1'), true)
  assert.equal(hooksFor('s1')?.permission, undefined, 'cleared')
  // the second time is false / does not crash on an unknown session
  assert.equal(clearPermission('s1'), false)
  assert.equal(clearPermission('知らないID'), false)
  assert.equal(clearPermission(undefined), false)
})

test('★★ clearLabelIfSettled: the answering side drops "needs attention" (so no false warning is shown)', () => {
  // ⚠️ a lie seen on a real device on 2026-08-14: right after pressing approve on the phone, the card vanished but the state
  //    stayed `waiting`, and the thread showed "cannot be answered from the phone; answer on the PC"
  //    for 4–5 seconds. **Although I had just answered on the phone.**
  resetPending()
  noteHook({
    event: 'Notification',
    machine: 'PC-B',
    account: '.claude-s',
    project: 'p',
    sessionId: 'S-ans',
    at: '2026-08-14T04:57:00.000Z',
    notice: 'permission',
  })
  // do not clear while there are still waiting cards (only one of parallel approvals answered)
  void waitForDecision(info({ key: 'still', sessionId: 'S-ans' }), () => {})
  assert.equal(clearLabelIfSettled('S-ans'), false, 'not cleared while cards are still waiting')
  assert.ok(hooksFor('S-ans')?.permission)
  // drop it once everything is settled
  resetPending()
  assert.equal(clearLabelIfSettled('S-ans'), true)
  assert.equal(hooksFor('S-ans')?.permission, undefined)
  // does not crash on an unknown or unspecified session
  assert.equal(clearLabelIfSettled('知らないID'), false)
  assert.equal(clearLabelIfSettled(undefined), false)
})

test('clearPermission: does not clear the Stop record (does not break the done display)', () => {
  noteHook({
    event: 'Stop',
    machine: 'PC-B',
    account: '.claude-s',
    project: 'p',
    sessionId: 's2',
    at: '2026-08-13T09:00:00.000Z',
  })
  clearPermission('s2')
  assert.equal(hooksFor('s2')?.stop?.event, 'Stop')
})
