import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionStatus, SessionSummary } from '../../../shared/types.ts'
import {
  applyAutoApprove,
  bucketOf,
  groupSessions,
  showMachineFor,
  sortSessions,
  synthesizeRows,
} from './order.ts'
import { explainWait, statusView } from './status.ts'

const s = (
  sessionId: string,
  status: SessionStatus,
  live: boolean,
  lastActivity: string,
  machine = 'PC-A',
): SessionSummary =>
  ({
    machine,
    account: '.claude-r',
    sessionId,
    title: sessionId,
    project: 'proj',
    status,
    live,
    lastActivity,
    transcriptBytes: 2048,
  }) as SessionSummary

test('★ pending approvals always come to the very top, even from another machine', () => {
  // ⚠️ When split by machine, the second machine's pending approvals were buried at the bottom and missed
  const list = [
    s('a', 'working', true, '2026-08-12T02:00:00.000Z', 'PC-A'),
    s('b', 'done', true, '2026-08-12T02:10:00.000Z', 'PC-A'),
    s('c', 'waiting', true, '2026-08-12T01:00:00.000Z', 'PC-B'),
  ]
  const { attention } = groupSessions(list)
  assert.equal(attention[0]?.sessionId, 'c')
  assert.equal(attention[0]?.machine, 'PC-B')
})

test('waiting-for-you order is approval pending → abnormal exit → done', () => {
  const list = [
    s('done', 'done', true, '2026-08-12T03:00:00.000Z'),
    s('err', 'error', true, '2026-08-12T02:00:00.000Z'),
    s('wait', 'waiting', true, '2026-08-12T01:00:00.000Z'),
  ]
  assert.deepEqual(
    sortSessions(list).map((x) => x.sessionId),
    ['wait', 'err', 'done'],
  )
})

test('same status: newest first', () => {
  const list = [
    s('old', 'waiting', true, '2026-08-12T01:00:00.000Z'),
    s('new', 'waiting', true, '2026-08-12T05:00:00.000Z'),
  ]
  assert.deepEqual(
    sortSessions(list).map((x) => x.sessionId),
    ['new', 'old'],
  )
})

test('no process: goes to history even if a status label remains', () => {
  // The hook status remains, but an ended session must not be lifted to "waiting for you"
  assert.equal(bucketOf(s('x', 'waiting', false, '2026-08-12T01:00:00.000Z')), 'history')
  assert.equal(bucketOf(s('y', 'waiting', true, '2026-08-12T01:00:00.000Z')), 'attention')
})

test('responding / starting go to "running" (the leave-it-alone side)', () => {
  assert.equal(bucketOf(s('a', 'working', true, '2026-08-12T01:00:00.000Z')), 'running')
  assert.equal(bucketOf(s('b', 'idle', true, '2026-08-12T01:00:00.000Z')), 'running')
  assert.equal(bucketOf(s('c', 'rate-limited', true, '2026-08-12T01:00:00.000Z')), 'running')
})

test('★ running in the background is on the "running" side, below done and below responding', () => {
  // ⚠️ Do not put it in "waiting for you". No human answer is needed (it is just waiting for codex).
  //    ⚠️ But it is **not done**, so place it below done so it does not occupy the top section.
  assert.equal(bucketOf(s('a', 'background', true, '2026-08-12T01:00:00.000Z')), 'running')
  const list = [
    s('bg', 'background', true, '2026-08-12T03:00:00.000Z'),
    s('work', 'working', true, '2026-08-12T01:00:00.000Z'),
    s('done', 'done', true, '2026-08-12T02:00:00.000Z'),
  ]
  assert.deepEqual(
    sortSessions(list).map((x) => x.sessionId),
    ['done', 'work', 'bg'],
  )
})

test('history ignores status and is sorted newest first', () => {
  const list = [
    s('mid', 'done', false, '2026-08-12T02:00:00.000Z'),
    s('newest', 'unknown', false, '2026-08-12T04:00:00.000Z'),
    s('oldest', 'waiting', false, '2026-08-12T01:00:00.000Z'),
  ]
  assert.deepEqual(
    groupSessions(list).history.map((x) => x.sessionId),
    ['newest', 'mid', 'oldest'],
  )
})

test('does not crash on broken timestamps (order stays stable)', () => {
  const list = [s('b', 'done', true, 'これは時刻ではない'), s('a', 'done', true, 'これも違う')]
  assert.deepEqual(
    sortSessions(list).map((x) => x.sessionId),
    ['a', 'b'],
  )
})

// ── ★ The reason for "needs attention" (2026-08-18) ────────────────────────────────────
//
// ⚠️ The wording is unified in `waitingReason` in `shared/types.ts` (so it never disagrees with notifications).

test('★★ statusView: appends the reason in parentheses if present / unchanged otherwise', () => {
  assert.equal(statusView('waiting', true, 'permission prompt')?.label, '要対応（承認プロンプト）')
  assert.equal(statusView('waiting', true, 'input needed')?.label, '要対応（入力が必要）')
  // Without one, unchanged (do not invent a reason)
  assert.equal(statusView('waiting', true, undefined)?.label, '要対応')
  assert.equal(statusView('waiting', true, '  ')?.label, '要対応')
  // The color class does not change
  assert.equal(statusView('waiting', true, 'permission prompt')?.cls, 'waiting')
})

test('★ statusView: unknown reasons are shown as is (not dropped when new dialogs appear)', () => {
  assert.equal(statusView('waiting', true, 'brand new dialog')?.label, '要対応（brand new dialog）')
})

test('the reason is not attached to statuses other than "needs attention"', () => {
  assert.equal(statusView('working', true, 'permission prompt')?.label, '応答中')
  assert.equal(statusView('background', true, 'permission prompt')?.label, '背景で実行中')
})

test('★★ explainWait: splits into approval / non-approval / unknown', () => {
  // A permission prompt correctly gets the "nowhere to answer" explanation
  assert.deepEqual(explainWait('permission prompt', undefined), { kind: 'permission' })
  // ★ Without a reason, **do not assert** (old CLIs do not write waitingFor / codex medium #3)
  assert.deepEqual(explainWait(undefined, undefined), { kind: 'unknown' })
  assert.deepEqual(explainWait('   ', undefined), { kind: 'unknown' })
  // Non-approvals "do not reach the permission hook", so they get a different explanation
  assert.deepEqual(explainWait('input needed', undefined), { kind: 'other', label: '入力が必要' })
  assert.deepEqual(explainWait('goal proposal', undefined), { kind: 'other', label: '目標の提案' })
  assert.deepEqual(explainWait('brand new dialog', undefined), {
    kind: 'other',
    label: 'brand new dialog',
  })
})

test('★★ explainWait: an approval whose card died is called an approval, not "unknown"', () => {
  // ⚠️ This is **the most common shape** (agent restart, answered on the PC first, timeout).
  //    The CLI itself is not waiting, so there is no waitingFor, but `resolveStatus`
  //    attaches `lastEvent: 'Notification'` only to this shape (= the implementation distinguishes it).
  assert.deepEqual(explainWait(undefined, 'Notification'), { kind: 'permission' })
  // The shape with a live card (can arrive while hidden by quiet) gets the same explanation
  assert.deepEqual(explainWait(undefined, 'PermissionRequest'), { kind: 'permission' })
})

test('★ explainWait: does not assert on a lastEvent unrelated to approval', () => {
  // ⚠️ `Stop` / `StopFailure` signal "finished". They are unrelated to approval, so
  //    saying permission here is **false guidance** (makes you look for an approval that is not on the PC)
  assert.deepEqual(explainWait(undefined, 'Stop'), { kind: 'unknown' })
  assert.deepEqual(explainWait(undefined, 'StopFailure'), { kind: 'unknown' })
  // ★ If the CLI states a reason, it wins (not overridden by lastEvent)
  assert.deepEqual(explainWait('input needed', 'Notification'), {
    kind: 'other',
    label: '入力が必要',
  })
})

// ── ★ Placeholder rows built from cards, and whether to show machine names (2026-08-18; moved out of `main.tsx`)

test('★★ synthesized rows: a card with no row produces a "waiting for you" row', () => {
  const perms = [
    {
      key: 'k',
      machine: 'pc-b',
      account: '.claude-r',
      project: 'proj',
      sessionId: 'NEW',
      toolName: 'Bash',
      summary: 'npm test',
      at: '2026-08-18T05:00:00.000Z',
    },
  ]
  const rows = synthesizeRows(perms, [])
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.sessionId, 'NEW')
  assert.equal(rows[0]?.status, 'waiting')
  assert.equal(rows[0]?.title, '承認待ち · Bash')
  // ★★ `lastEvent` is **a value that shows it came from an approval**. This is what `explainWait` relies on
  assert.equal(rows[0]?.lastEvent, 'PermissionRequest')
  assert.equal(rows[0]?.machine, 'pc-b', 'keeps which machine (used for the machine-name decision)')

  // Not created when a row already exists (no duplicates)
  const existing = {
    machine: 'pc-b',
    account: '.claude-r',
    sessionId: 'NEW',
    cwd: '/x',
    project: 'proj',
    title: '本物',
    titleSource: 'ai' as const,
    status: 'working' as const,
    live: true,
    lastActivity: '2026-08-18T05:00:00.000Z',
    transcriptBytes: 1,
  }
  assert.deepEqual(synthesizeRows(perms, [existing]), [])
  // Cannot be created from a card without a sessionId
  assert.deepEqual(synthesizeRows([{ ...perms[0]!, sessionId: undefined }], []), [])
})

test('★★ machine names are shown with 2 or more machines (synthesized rows count)', () => {
  const row = (machine: string, sessionId: string) => ({
    machine,
    account: '.claude-r',
    sessionId,
    cwd: '/x',
    project: 'proj',
    title: 't',
    titleSource: 'ai' as const,
    status: 'idle' as const,
    live: true,
    lastActivity: '2026-08-18T05:00:00.000Z',
    transcriptBytes: 1,
  })
  assert.equal(showMachineFor([row('a', '1'), row('a', '2')]), false)
  assert.equal(showMachineFor([row('a', '1'), row('b', '2')]), true)
})

test('★★ the auto-approve mark also lands on synthesized rows (the only mechanism is `applyAutoApprove`)', () => {
  // ⚠️⚠️ 2026-09-07 codex high #2. **A session stopped at its first approval has no transcript**, so
  //    it is not in `/sessions` and `markAutoApprove`, which attaches the mark, never reaches it.
  //    ⇒ Without it, "you can turn it on but neither the bar nor the off button appears" = approving but cannot be stopped.
  const perm = {
    key: 'k1',
    machine: 'PC-A',
    account: '.claude-r',
    project: 'proj',
    sessionId: 'S1',
    toolName: 'Bash',
    summary: 'touch x',
    at: '2026-09-07T12:00:00.000Z',
  }
  const until = '2026-09-07T15:00:00.000Z'
  // ⚠️⚠️ **`synthesizeRows` does not carry the mark** (round 2 unified the mechanism into one).
  //    `applyAutoApprove` overlays the mark = independent of where the row came from (pending approval / `/sessions` / history).
  //    ⇒ "disappears once the approval is answered" and "not attached to cached history" are structurally gone
  const rows = applyAutoApprove(synthesizeRows([perm], []), [{ sessionId: 'S1', until }])
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0]!.autoApprove, { until }, 'the synthesized row has no mark')
  assert.equal(rows[0]!.title, '承認待ち · Bash', 'breaks the pending-approval title')

  // ★ A card for another session (having no row) creates **the whole row**
  const other = applyAutoApprove(synthesizeRows([perm], []), [{ sessionId: 'OTHER', until }])
  assert.equal(other.length, 2)
  assert.equal(other[0]!.autoApprove, undefined)
  assert.deepEqual(other[1]!.autoApprove, { until })
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ codex round 2 (2026-09-07 / read-only) — **holes created by the round-1 fixes**
// ─────────────────────────────────────────────────────────────────────────────

const MARK = { sessionId: 'S1', until: '2026-09-07T15:00:00.000Z', machine: 'PC-A' }

const permOf = (over: Record<string, unknown> = {}) => ({
  key: 'k1',
  machine: 'PC-A',
  account: '.claude-r',
  project: 'proj',
  sessionId: 'S1',
  toolName: 'Bash',
  summary: 'touch x',
  at: '2026-09-07T12:00:00.000Z',
  ...over,
})

const rowOf = (over: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    machine: 'PC-A',
    account: '.claude-r',
    sessionId: 'S1',
    cwd: '/home/x/proj',
    project: 'proj',
    title: 'proj',
    titleSource: 'fallback',
    status: 'idle',
    live: true,
    lastActivity: '2026-09-07T12:00:00.000Z',
    transcriptBytes: 0,
    ...over,
  }) as SessionSummary

test('★★ high #1 (round 2): the auto-approve row stays even after the pending approval is gone', () => {
  // ⚠️⚠️ Synthesized rows were built only from `perms`, so **the moment an approval was answered** (while the transcript
  //    had not yet appeared in `/sessions`) **both the bar and the off button vanished**. Auto-approve keeps approving.
  const rows = applyAutoApprove([], [MARK])
  assert.equal(rows.length, 1, '⚠️ the auto-approve row disappears without a pending approval')
  assert.equal(rows[0]!.sessionId, 'S1')
  assert.deepEqual(rows[0]!.autoApprove, { until: MARK.until })
  // ★ The name is unknown, so it falls back to the ID (**never show a false title**)
  assert.ok(!rows[0]!.title.includes('proj'))
})

test('★★ high #2 (round 2): the mark is overlaid on already-fetched (history) rows too', () => {
  // ⚠️⚠️ Collapsed history is not refetched, so **cached rows get no mark**.
  //    ⇒ The row exists but neither the bar nor the off button appears (the agent is approving)
  const stale = rowOf({ live: false, autoApprove: undefined })
  const rows = applyAutoApprove([stale], [MARK])
  assert.equal(rows.length, 1, 'rows increased (duplicate)')
  assert.deepEqual(rows[0]!.autoApprove, { until: MARK.until }, '⚠️ the already-fetched row gets no mark')
  // ★ Other values are left intact
  assert.equal(rows[0]!.title, 'proj')
  assert.equal(rows[0]!.live, false)
})

test('★★ medium #3 (round 2): no mark on the same sessionId on another machine', () => {
  // ⚠️⚠️ Marks were flattened across all endpoints and matched **by ID only**, so A's "on" landed on B's row
  //    (pressing off from the bar went to B = A stayed on)
  const onA = rowOf({ machine: 'PC-A' })
  const onB = rowOf({ machine: 'PC-B' })
  const rows = applyAutoApprove([onA, onB], [MARK])
  assert.deepEqual(rows[0]!.autoApprove, { until: MARK.until })
  assert.equal(rows[1]!.autoApprove, undefined, '⚠️ a row on another machine has the mark')
})

test('★ overlaying marks neither adds nor removes rows (existing rows win)', () => {
  const rows = applyAutoApprove([rowOf()], [MARK])
  assert.equal(rows.length, 1)
  // ★ With no marks (the agent removed them on expiry), nothing is added
  assert.deepEqual(applyAutoApprove([], []), [])
  // ★ A mark with no machine (old agent) is still matched by ID (**err toward showing**)
  const noMachine = applyAutoApprove([rowOf()], [{ sessionId: 'S1', until: MARK.until }])
  assert.deepEqual(noMachine[0]!.autoApprove, { until: MARK.until })
})

test('★ the synthesized (pending-approval) row and the auto-approve row are not duplicated', () => {
  const rows = applyAutoApprove(synthesizeRows([permOf()], []), [MARK])
  assert.equal(rows.length, 1, 'two rows for the same session')
  assert.deepEqual(rows[0]!.autoApprove, { until: MARK.until })
  assert.equal(rows[0]!.title, '承認待ち · Bash', 'overwrites the pending-approval title')
})
