import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveStatus } from './sessions.ts'

const ACT = '2026-08-11T12:40:00.000Z' // last activity of the conversation
const STOP = '2026-08-11T12:40:29.745Z' // Stop hook firing right after
const NOTICE = '2026-08-11T12:41:30.335Z' // idle notification firing a minute later still
const REPLY = '2026-08-11T12:45:22.433Z' // the user replied

test('resolveStatus: live and busy means responding (takes priority over Stop)', () => {
  const r = resolveStatus('busy', true, { stop: { event: 'Stop', at: STOP } }, ACT)
  assert.equal(r.status, 'working')
})

// ★★ "Awaiting approval takes priority over busy" was **revoked on 2026-08-18**.
//
//   The original reason: "approval requests happen mid-turn, so the process is still busy then".
//   ⚠️ This **was wrong**. In the CLI 2.1.234 implementation (`kZh` / `Bqw` / `hbg`),
//      if even one dialog is open, status is **`waiting`** (decided before `busy`,
//      `working: false`). So **it is never `busy` while an approval dialog is open**.
//
//   Real damage: after approving on the PC, while `codex exec` ran for 21 minutes, it was **"needs attention" the whole time**
//   (machine B / session `git-push fix` / measured. `/permissions` was empty = nothing to answer).
//
//   ★ Two grounds that we do not hide a real approval:
//     ① If our hook is installed, the **card** takes effect first (`hasPendingApproval`)
//     ② Even without it, while a dialog is open **the CLI itself says `waiting`**

test('★★ no card and CLI busy means "responding" (a stale Notification does not make it needs-attention)', () => {
  const r = resolveStatus('busy', true, { permission: { at: NOTICE } }, ACT)
  assert.equal(r.status, 'working', 'if a dialog were open the CLI would say waiting (not busy)')
})

test('★★ with a card it is awaiting approval even if busy (the most reliable evidence)', () => {
  const r = resolveStatus('busy', true, { permission: { at: NOTICE } }, ACT, true)
  assert.equal(r.status, 'waiting')
  assert.equal(r.lastEvent, 'PermissionRequest')
})

test('★★ even on a machine without the hook, an open dialog is caught via the CLI waiting', () => {
  const r = resolveStatus('waiting', true, { stop: { event: 'Stop', at: STOP } }, ACT)
  assert.equal(r.status, 'waiting')
})

test('★ merely running in the background, a stale Notification does not make it needs-attention', () => {
  // The real-machine shape: while an approved `codex exec` runs in the background
  const r = resolveStatus('shell', true, { permission: { at: NOTICE } }, ACT)
  assert.equal(r.status, 'background')
})

test('★ if the CLI is idle, keep it based on Notification (fallback for machines without the hook)', () => {
  const r = resolveStatus('idle', true, { permission: { at: NOTICE } }, ACT)
  assert.equal(r.status, 'waiting')
  assert.equal(r.lastEvent, 'Notification')
})

test('★ after approval, the tool result is written and it clears automatically', () => {
  // approval → tool runs → tool_result is written to the transcript → last activity overtakes the hook
  const afterApproval = '2026-08-11T12:41:40.000Z'
  const r = resolveStatus('busy', true, { permission: { at: NOTICE } }, afterApproval)
  assert.equal(r.status, 'working')
})

// ★★ Running in the background (a gap found by measurement on 2026-08-16)
//
//   The CLI writes 4 kinds of status: `["busy","shell","idle","waiting"]`.
//   For a long time we only looked at `busy`, and `shell` (= a background Bash is running)
//   **passed through as an unknown value and became "done"**.
//   Running codex exec in the background is exactly this, and the real machine showed "done".

test('★★ shell means "running in the background". Not done even if Stop arrived', () => {
  // ⚠️ The turn ends even while a background task runs, so Stop always arrives.
  //    Checking Stop first gives "done" (it actually did).
  const r = resolveStatus('shell', true, { stop: { event: 'Stop', at: STOP } }, ACT)
  assert.equal(r.status, 'background')
  assert.equal(r.lastEvent, undefined, 'the state is not based on a hook, so no lastEvent')
})

test('★ even when running in the background, an approval card makes awaiting approval win', () => {
  const r = resolveStatus('shell', true, { stop: { event: 'Stop', at: STOP } }, ACT, true)
  assert.equal(r.status, 'waiting')
})

test('shell without a process is not treated as background (done, as before)', () => {
  // ⚠️ If the process is dead, the background Bash died with it.
  //    Do not say "still running" based on a stale `shell` left in the record.
  const r = resolveStatus('shell', false, { stop: { event: 'Stop', at: STOP } }, ACT)
  assert.equal(r.status, 'done')
})

test('★★ StopFailure is not hidden by busy / shell (the side that must be noticed)', () => {
  // ⚠️ 2026-08-16 external review, medium #4. A hole introduced when `shell` was added.
  //    Merely something running in the background turned "abnormal end" into "running in the background".
  assert.equal(
    resolveStatus('shell', true, { stop: { event: 'StopFailure', at: STOP } }, ACT).status,
    'error',
  )
  assert.equal(
    resolveStatus('busy', true, { stop: { event: 'StopFailure', at: STOP } }, ACT).status,
    'error',
  )
})

test('a stale StopFailure does not linger (a reply clears it)', () => {
  assert.equal(
    resolveStatus('busy', true, { stop: { event: 'StopFailure', at: STOP } }, REPLY).status,
    'working',
  )
})

test('★ waiting (the CLI shows a dialog and waits) is not "done"', () => {
  // ⚠️ This too passed through as an "unknown value" and became done based on Stop.
  //    ⚠️ Not observed for real. Based on the CLI implementation (sandbox request / input needed / dialog open).
  const r = resolveStatus('waiting', true, { stop: { event: 'Stop', at: STOP } }, ACT)
  assert.equal(r.status, 'waiting')
})

test('resolveStatus: done if Stop is after the last activity', () => {
  const r = resolveStatus('idle', true, { stop: { event: 'Stop', at: STOP } }, ACT)
  assert.equal(r.status, 'done')
  assert.equal(r.lastEvent, 'Stop')
})

test('resolveStatus: StopFailure is an abnormal end', () => {
  const r = resolveStatus('idle', true, { stop: { event: 'StopFailure', at: STOP } }, ACT)
  assert.equal(r.status, 'error')
})

test('resolveStatus: an approval request takes priority over done', () => {
  const r = resolveStatus(
    'idle',
    true,
    { stop: { event: 'Stop', at: STOP }, permission: { at: NOTICE } },
    ACT,
  )
  assert.equal(r.status, 'waiting')
})

test('★ the idle notification (Notification/idle) does not clear done', () => {
  // hookState does not record Notifications other than permission, so
  // even if the idle notification fires a minute after the turn ends, stop remains and it stays "done".
  // An implementation that simply keeps "the last hook" loses done here (we actually hit this).
  const r = resolveStatus('idle', true, { stop: { event: 'Stop', at: STOP } }, ACT)
  assert.equal(r.status, 'done')
})

test('★ the away_summary write 3 minutes later does not clear "done" (the resolveStatus-side condition)', () => {
  // ⚠️ This test only checks that "done remains if lastActivity stays at the conversation time".
  //    **How lastActivity is built is transcript.ts's business**, and without going through it
  //    a regression cannot be detected (until 2026-08-13 these two lines were a false green with the same input as another test).
  //    → The real check is in transcript.test.ts, in the
  //       "derive: lastActivity is taken only from conversation records" test.
  //
  // What is checked here is the resolveStatus-side condition: the causality itself, that passing
  // the summary time (after STOP) as activity clears done.
  const AWAY = '2026-08-11T12:43:36.000Z' // system/away_summary written 3 minutes after Stop

  // With the correct input (the conversation's last activity), done remains
  assert.equal(resolveStatus('idle', true, { stop: { event: 'Stop', at: STOP } }, ACT).status, 'done')

  // ★ Passing the summary time as activity clears done = why the transcript side must not mix it in
  assert.notEqual(
    resolveStatus('idle', true, { stop: { event: 'Stop', at: STOP } }, AWAY).status,
    'done',
  )
})

test('resolveStatus: the state clears when the user replies', () => {
  const r = resolveStatus(
    'idle',
    true,
    { stop: { event: 'Stop', at: STOP }, permission: { at: NOTICE } },
    REPLY,
  )
  assert.equal(r.status, 'idle')
})

test('resolveStatus: treats the hook as valid within the 3-second tolerance', () => {
  // Stop fires right after the last write, but the order can be swapped
  const justAfter = '2026-08-11T12:40:31.000Z'
  const r = resolveStatus('idle', true, { stop: { event: 'Stop', at: STOP } }, justAfter)
  assert.equal(r.status, 'done')
})

test('resolveStatus: idle with no process and no hook (the UI shows ended via live=false)', () => {
  assert.equal(resolveStatus(undefined, false, undefined, ACT).status, 'idle')
})

test('resolveStatus: keeps StopFailure even after ending (so it gets noticed)', () => {
  const r = resolveStatus(undefined, false, { stop: { event: 'StopFailure', at: STOP } }, ACT)
  assert.equal(r.status, 'error')
})

// ── Clearing conditions of the state verdict (two bugs found in the 2026-08-12 external review) ──────────

const tAt = (sec: number) => new Date(Date.UTC(2026, 7, 12, 10, 0, sec)).toISOString()

test('★★ resolveStatus: does not stay awaiting approval even if activity stops right after approval (within 3 seconds)', () => {
  // ⚠️ The 3-second tolerance was also applied to awaiting approval, so when approval → tool result → turn end
  //    fit within 3 seconds, it got stuck at "awaiting approval" (it actually stays forever).
  const r = resolveStatus(
    'idle',
    true,
    { permission: { at: tAt(10) } },
    tAt(12), // activity 2 seconds after the approval = already approved
  )
  assert.notEqual(r.status, 'waiting', 'should be cleared')
})

test('★★ resolveStatus: a later Stop clears a stale awaiting approval', () => {
  const r = resolveStatus(
    'idle',
    true,
    {
      permission: { at: tAt(10) },
      stop: { at: tAt(20), event: 'Stop' },
    },
    tAt(5), // activity is older than both (= both satisfy the "after activity" condition)
  )
  assert.equal(r.status, 'done', 'Stop is newer, so it should be done')
})

test('resolveStatus: awaiting approval newer than Stop remains (approval → awaiting approval order is not cleared)', () => {
  // ⚠️ raw is set to idle (the CLI is not working). With busy / shell
  //    we know "no dialog is open", so those take priority (see the notes above)
  const r = resolveStatus(
    'idle',
    true,
    {
      permission: { at: tAt(30) },
      stop: { at: tAt(20), event: 'Stop' },
    },
    tAt(5),
  )
  assert.equal(r.status, 'waiting')
})

test('★ resolveStatus: does not fabricate state from a hook with an unreadable time', () => {
  const bad = resolveStatus('idle', true, { permission: { at: 'これは時刻ではない' } }, tAt(10))
  assert.notEqual(bad.status, 'waiting', 'an unreadable time must not be treated as "current"')

  const badStop = resolveStatus('idle', true, { stop: { at: 'x', event: 'StopFailure' } }, tAt(10))
  assert.notEqual(badStop.status, 'error')
})

test('resolveStatus: trusts the hook when the last activity is unreadable (it is the only clue, so keep it)', () => {
  const r = resolveStatus('idle', true, { permission: { at: tAt(10) } }, 'not-a-date')
  assert.equal(r.status, 'waiting')
})

test('★★ resolveStatus: ignores a stale Notification when busy (reversed on 2026-08-18)', () => {
  const r = resolveStatus('busy', true, { permission: { at: tAt(10) } }, tAt(5))
  assert.equal(r.status, 'working', 'CLI busy = no dialog open')
  // Only a card overrides busy
  const withCard = resolveStatus('busy', true, { permission: { at: tAt(10) } }, tAt(5), true)
  assert.equal(withCard.status, 'waiting')
})

test('resolveStatus: Stop has a tolerance (the hook can arrive before the transcript)', () => {
  // Activity time 1 second after Stop (events of the same instant looking reversed)
  const r = resolveStatus('idle', true, { stop: { at: tAt(10), event: 'Stop' } }, tAt(11))
  assert.equal(r.status, 'done')
})

// ── ★ The approval card is the top-priority evidence (2026-08-13) ────────────────────────────
//
// User report: **"the answer session on machine B is working, yet the list says needs attention"**.
//
// The cause is that `Notification/permission` only says "it is asking". Clearing does not happen until
// "the last activity overtakes the hook" = **that tool's result is written**, so
// **from right after approving on the PC until that tool finishes, it is needs-attention the whole time**.
// With long commands (running tests etc.) this lasts minutes.
//
// → Made the hook's card (which exists only while the connection is alive) the top-priority evidence.

test('★★ resolveStatus: with a card it is awaiting approval even if busy (approval happens mid-turn)', () => {
  const r = resolveStatus('busy', true, undefined, ACT, true)
  assert.equal(r.status, 'waiting')
  // Show that the evidence is the hook, not Notification
  assert.equal(r.lastEvent, 'PermissionRequest')
})

test('★★ resolveStatus: without a card, an already-answered approval does not hold it up', () => {
  // ⚠️ This is the shape of the reported bug. The permission hook remains but the card is gone.
  //    This change lets "no card = already answered" be the rule (the sweep clears the hook side too).
  const r = resolveStatus('busy', true, undefined, ACT, false)
  assert.equal(r.status, 'working')
})

test('★ resolveStatus: a card beats Stop (does not lose to the turn-end verdict)', () => {
  // Rare, but the next turn's approval can come right after Stop
  const r = resolveStatus('busy', true, { stop: { event: 'Stop', at: STOP } }, ACT, true)
  assert.equal(r.status, 'waiting')
})
