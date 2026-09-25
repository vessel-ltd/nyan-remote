import assert from 'node:assert/strict'
import { shouldRing, statusLabel, UNKNOWN_LABEL } from '../../../shared/types.ts'
import { test } from 'node:test'
import { hasPermissionHook } from '../claude/permissionHook.ts'
import { holdQuiet, listPending, resetPending, waitForDecision } from '../permission.ts'
import { isKnownRawStatus, resolveStatus } from '../claude/sessions.ts'
import {
  classifyNotice,
  hasPendingApprovalFor,
  isPermissionNotice,
  labelFor,
  rememberLabel,
  resetLabelsForTest,
  settledLabel,
  parseTranscriptPath,
  shouldPushNotice,
  shouldSendLabel,
  toPushPayload,
} from './hook.ts'

import type { HookEvent } from '../../../shared/types.ts'

test('parseTranscriptPath: takes the account and session ID from transcript_path', () => {
  assert.deepEqual(
    parseTranscriptPath(
      '/home/user/.claude-r/projects/-home-user-nyan-remote/d659ffc7-c73f-48ba-81b6-74ef520bee34.jsonl',
    ),
    { account: '.claude-r', sessionId: 'd659ffc7-c73f-48ba-81b6-74ef520bee34' },
  )
  assert.deepEqual(parseTranscriptPath('/home/user/.claude/projects/-x/abc.jsonl'), {
    account: '.claude',
    sessionId: 'abc',
  })
  assert.deepEqual(parseTranscriptPath(undefined), {})
  assert.deepEqual(parseTranscriptPath('/tmp/whatever.jsonl'), {})
})

test('labelFor: same wording as notify.sh', () => {
  assert.equal(labelFor('Stop'), '完了')
  assert.equal(labelFor('StopFailure'), '⚠ 異常終了')
  assert.equal(labelFor('Notification'), '要対応')
  assert.equal(labelFor('SomethingNew'), 'SomethingNew')
})

test('toPushPayload: carries only identifiers and state (never leaks conversation content)', () => {
  const payload = toPushPayload({
    event: 'Stop',
    machine: 'PC-A',
    account: '.claude-r',
    project: 'answer-analytics',
    sessionId: 'abc-123',
    at: '2026-08-11T10:21:38.299Z',
  })

  // ★★ No title was passed, so it **falls back to the 8-char ID** (never show a false title / fail-closed)
  assert.equal(payload.title, 'abc-123')
  // The time is not put in the body (the Service Worker passes at to timestamp, and the OS shows it in the device TZ)
  // ★ Machine name and account are included (so the notification alone tells which machine and which account)
  // ★ The title fell back to the ID, so the project name is added as the 3rd line (prevents two indistinguishable cards)
  assert.equal(payload.body, '完了 · PC-A · claude-r\nanswer-analytics')
  assert.equal(payload.at, '2026-08-11T10:21:38.299Z')
  assert.equal(payload.tag, 'PC-A/.claude-r/answer-analytics/abc-123')
  assert.equal(payload.url, '/#/s/abc-123')

  // ★ No extra keys. Whenever this grows, always consider whether it violates §6.2
  //   ⚠️ `完了` (done) rings, so `silent` is not added
  assert.deepEqual(Object.keys(payload).sort(), ['at', 'body', 'event', 'tag', 'title', 'url'])

  // ★ Well below the 4KB limit
  assert.ok(JSON.stringify(payload).length < 512)
})

test('toPushPayload: without a sessionId it opens the root', () => {
  const payload = toPushPayload({
    event: 'Notification',
    machine: 'PC-A',
    account: '.claude',
    project: '—',
    at: '2026-08-11T23:05:00.000Z',
  })
  assert.equal(payload.url, '/')
  // ★ No sessionId and no title = the 1st line is `—`, and the project is also `—`, so no 3rd line
  assert.equal(payload.title, '—')
  assert.equal(payload.body, '要対応 · PC-A · claude')
  // ★ The default account (`.claude`) drops the leading dot to `claude`
  assert.ok(!payload.body.includes('.claude'), `the dot remains: ${payload.body}`)
})

test('★★ toPushPayload: notifications for the same session collapse into one slot even across kinds (replaced)', () => {
  // ★ User request 2026-08-20. Within one turn, "完了" (done, Stop) and the "要対応" (needs attention) about 1 minute later
  //   (Notification/idle) **piled up as two separate slots**. A session has one state, so
  //   being replaced by the newer one is correct. ⚠️ Re-ringing comes from `renotify: true` in sw.js.
  const common = {
    machine: 'PC-A',
    account: '.claude-r',
    project: 'nyan-remote',
    sessionId: 'abc-123',
    at: '2026-08-20T05:00:00.000Z',
  } as const
  const done = toPushPayload({ ...common, event: 'Stop' })
  const waiting = toPushPayload({ ...common, event: 'Notification' })
  const failure = toPushPayload({ ...common, event: 'StopFailure' })
  assert.equal(done.tag, waiting.tag)
  assert.equal(done.tag, failure.tag)
  // ★ The wording (= which state) stays separate. Only the slot is collapsed
  assert.notEqual(done.body, waiting.body)
  // ⚠️⚠️ Do not put it in the same namespace as approval tags (starting with `perm-`).
  //    Otherwise it gets caught by the PWA's cleanup (pruneStaleNotifications in notifications.ts) and
  //    **state notifications get closed on their own**.
  assert.ok(!done.tag?.startsWith('perm-'))
})

test('★ toPushPayload: tags do not collide even when two machines have the same account and project', () => {
  // ⚠️ If these collide, the Service Worker replaces the earlier notification with the later one,
  //    and one machine's event disappears (actually hit on 2026-08-12).
  //    Working on the same repo from two machines is normal M3 usage, so the condition always happens.
  const common = {
    event: 'Stop',
    account: '.claude-r',
    project: 'nyan-remote',
    sessionId: 'abc-123',
    at: '2026-08-12T00:30:00.000Z',
  } as const
  const a = toPushPayload({ ...common, machine: 'PC-A' })
  const b = toPushPayload({ ...common, machine: 'PC-B' })
  // ★★ No collision even for **a different session** on the same machine and project
  //    (external review 2026-08-16, medium #5. One of the threads becomes unreachable)
  const other = toPushPayload({ ...common, machine: 'PC-A', sessionId: 'zzz-999' })
  assert.notEqual(a.tag, other.tag)

  assert.notEqual(a.tag, b.tag)
  // Distinguishable by body alone (only the title and body can be read without opening the notification)
  assert.notEqual(a.body, b.body)
  assert.match(b.body ?? '', /PC-B/)
})

// ★★ End-of-turn notifications (2026-08-16)
//
//   `Stop` only means "Claude's turn ended", **not necessarily that the work is done**.
//   If a background Bash (codex exec) or a subagent is running, it is not finished yet.
//   ⚠️ When the hook is received, the state has not been written yet (measured 657ms lag), so
//      the wording is decided from the value re-read right before sending.

const STOP_EVENT = {
  event: 'Stop',
  machine: 'PC-A',
  account: '.claude-r',
  project: 'nyan-remote',
  sessionId: 'abc-123',
  at: '2026-08-11T10:21:38.299Z',
} as const

/**
 * ★ The hook record. **For `Stop`, the wording is decided "after that event has been recorded"**, so
 *   the test passes that too (the implementation reads `hooksFor` after `noteHook(event)`).
 */
const STOPPED = { stop: { event: 'Stop', at: STOP_EVENT.at } } as const
/** Activity before that notification (so the hook is not misjudged as "old") */
const CTX = { hooks: STOPPED, lastActivity: '2026-08-11T10:21:30.000Z' }

test('★★ settledLabel: does not say "done" while a background Bash is running', () => {
  assert.equal(settledLabel(STOP_EVENT, { kind: 'live', status: 'shell' }, CTX), '背景で実行中')
})

test('★ settledLabel: "responding" while a subagent is running (same wording as the list)', () => {
  assert.equal(settledLabel(STOP_EVENT, { kind: 'live', status: 'busy' }, CTX), '応答中')
})

test('★ settledLabel: "needs attention" when the CLI shows a dialog and waits', () => {
  assert.equal(settledLabel(STOP_EVENT, { kind: 'live', status: 'waiting' }, CTX), '要対応')
})

test('settledLabel: "done" when it is really finished', () => {
  assert.equal(settledLabel(STOP_EVENT, { kind: 'live', status: 'idle' }, CTX), '完了')
  // ★ No process = the background Bash died along with it
  assert.equal(settledLabel(STOP_EVENT, { kind: 'gone' }, CTX), '完了')
})

test('★★ settledLabel: does not assert "done" when the state could not be read (fail-open is forbidden)', () => {
  // ⚠️ External review 2026-08-16, high #2. Unreadable, unknown account and timeout were all squashed into "done".
  //    That is **exactly the false done notification we are trying to fix**.
  // ⚠️⚠️ `resolveStatus` falls to "done" on hooks alone, so **it is stopped before that**.
  assert.equal(settledLabel(STOP_EVENT, { kind: 'unknown' }, CTX), '状態不明')
  assert.equal(settledLabel(STOP_EVENT, { kind: 'unknown' }, CTX), UNKNOWN_LABEL)
  // ★ Also do not assert when unknown statuses are added
  assert.equal(settledLabel(STOP_EVENT, { kind: 'live', status: 'brand-new' }, CTX), UNKNOWN_LABEL)
  assert.equal(settledLabel(STOP_EVENT, { kind: 'live', status: undefined }, CTX), UNKNOWN_LABEL)
})

test('★ settledLabel: only an abnormal exit is announced immediately without looking at the state', () => {
  // ⚠️ Looking at the state delays it by that much. Abnormalities are what you want to know soonest
  const failure = { ...STOP_EVENT, event: 'StopFailure' } as const
  assert.equal(settledLabel(failure, { kind: 'live', status: 'shell' }, CTX), '⚠ 異常終了')
  // ★ "Abnormal exit" even if unreadable or a marker exists (the only place allowed to disagree with the list / pinned by the table below)
  assert.equal(settledLabel(failure, { kind: 'unknown' }, CTX), '⚠ 異常終了')
})

test('★★ settledLabel: Notification is also decided from the state (never "needs attention" unconditionally)', () => {
  // ⚠️⚠️ The lie seen on a real device on 2026-08-21. `Notification/idle` only means "no reply for 60 seconds",
  //    not necessarily that action is needed (it **always** arrives a median 60.6 s after `Stop`).
  const notice = { ...STOP_EVENT, event: 'Notification', notice: 'idle' } as const
  assert.equal(settledLabel(notice, { kind: 'live', status: 'busy' }, CTX), '応答中')
  assert.equal(settledLabel(notice, { kind: 'live', status: 'shell' }, CTX), '背景で実行中')
  assert.equal(settledLabel(notice, { kind: 'live', status: 'idle' }, CTX), '完了')
  assert.equal(settledLabel(notice, { kind: 'gone' }, CTX), '完了')
  assert.equal(settledLabel(notice, { kind: 'unknown' }, CTX), UNKNOWN_LABEL)
  // ★ "Needs attention" only when a dialog really is open
  assert.equal(settledLabel(notice, { kind: 'live', status: 'waiting' }, CTX), '要対応')
})

test('★★★ notification wording matches the list decision (exhaustive)', () => {
  // ⚠️⚠️ **This was the root of today's bug**. The wording (strings) was shared via `statusLabel`, but
  //    "which state to decide on" was **separate** between `resolveStatus` (the list) and a hand-written switch on the notification side.
  //    Comparing all 96 combinations, **65 disagreed** (2 with real damage: "needs attention" for idle, and
  //    "done" ignoring the approval marker). ⇒ The decision was unified. **Pin it here so it never forks again.**
  const RAWS = ['busy', 'shell', 'waiting', 'idle', undefined, 'brand-new'] as const
  const HOOKS = [
    ['none', undefined],
    ['Stop', { stop: { event: 'Stop', at: STOP_EVENT.at } }],
    ['permission', { permission: { at: STOP_EVENT.at } }],
  ] as const
  const ACTIVITY = '2026-08-11T10:21:30.000Z'

  let checked = 0
  for (const raw of RAWS) {
    for (const [, hooks] of HOOKS) {
      for (const isLive of [true, false]) {
        for (const pending of [true, false]) {
          const probe = isLive
            ? ({ kind: 'live', status: raw } as const)
            : ({ kind: 'gone' } as const)
          const notif = settledLabel(STOP_EVENT, probe, {
            hooks,
            lastActivity: ACTIVITY,
            hasPendingApproval: pending,
          })
          const list = resolveStatus(raw, isLive, hooks, ACTIVITY, pending)
          // ★★ The intended difference: only when **alive but with an unknown status**, the notification
          //    falls to "状態不明" (state unknown) (the list says "done" based on the Stop hook = fail-open).
          const expected =
            isLive && !isKnownRawStatus(raw)
              ? UNKNOWN_LABEL
              : statusLabel(list.status) ?? UNKNOWN_LABEL
          assert.equal(
            notif,
            expected,
            `raw=${raw} hooks=${JSON.stringify(hooks)} live=${isLive} card=${pending}`,
          )
          checked++
        }
      }
    }
  }
  assert.equal(checked, 72, 'the number of exhaustive cases changed (review the table)')
})

test('★★ do not rely on old hooks (do not say "done" if the last activity overtook it)', () => {
  // ⚠️ Forgetting or breaking `lastActivity` announces **"done" based on an old Stop**.
  //    Only this test fails under the mutation (lastActivity pinned to 1970).
  const staleStop = { stop: { event: 'Stop', at: '2026-08-11T09:00:00.000Z' } } as const
  const newerActivity = '2026-08-11T10:21:30.000Z'

  // ★ The activity is newer = that hook no longer matters
  assert.equal(
    settledLabel(STOP_EVENT, { kind: 'live', status: 'idle' }, {
      hooks: staleStop,
      lastActivity: newerActivity,
    }),
    '起動中',
  )
  // ★ Conversely, if the hook is after the activity, "done"
  assert.equal(
    settledLabel(STOP_EVENT, { kind: 'live', status: 'idle' }, {
      hooks: { stop: { event: 'Stop', at: newerActivity } },
      lastActivity: '2026-08-11T09:00:00.000Z',
    }),
    '完了',
  )
})

test('★ only one intended difference: abnormal exit takes precedence over the marker', () => {
  // ⚠️ The list goes "marker → abnormal exit", so with a marker it is `要対応` (needs attention).
  //    Notifications **want to announce abnormalities as fast as possible**, so they show `⚠ 異常終了` without looking at the state.
  //    Do not "fix" this as a disagreement. **It is intentional.**
  const failure = { ...STOP_EVENT, event: 'StopFailure' } as const
  const ctx = { hooks: undefined, hasPendingApproval: true }
  assert.equal(settledLabel(failure, { kind: 'live', status: 'idle' }, ctx), '⚠ 異常終了')
  assert.equal(statusLabel(resolveStatus('idle', true, undefined, STOP_EVENT.at, true).status), '要対応')
})

test('★★ quietly waiting approvals also count as "waiting" (invisible to listPending)', () => {
  // ⚠️⚠️ `/code-review` 2026-08-21, medium #1. `listPending()` hides approvals within `quietUntil` (6 s).
  //    Those 6 seconds are exactly the window `Stop` → `PUSH_SETTLE_MS` (1.5 s) passes through, so
  //    **it would ring "done" while waiting for an answer**. ⇒ Use `hasPendingForSession`.
  resetPending()
  const ev = { ...STOP_EVENT, sessionId: 'S-quiet' } as const
  assert.equal(hasPendingApprovalFor(ev), false, 'precondition: nothing yet')

  void waitForDecision(
    { key: 'k-quiet', machine: 'M', account: '.claude-r', project: 'p', sessionId: 'S-quiet', toolName: 'Bash', summary: '', at: new Date().toISOString() },
    () => {},
  )
  holdQuiet('k-quiet', 60_000) // not surfaced (same state as a subagent request)
  assert.equal(listPending().length, 0, 'precondition: not surfaced')
  assert.equal(hasPendingApprovalFor(ev), true, '★ "waiting" even when quiet')
  resetPending()
})

test('★★ do not silence a Notification/permission without a marker (the path where it is the only notification)', () => {
  // ⚠️⚠️ `/code-review` 2026-08-21, low #4. `resolveStatus` looks at `busy` before `hooks.permission`,
  //    so passing it as is gives "responding" = `shouldRing` makes it silent.
  //    This path is reached only when it was let through as "on machines without the approval hook, ① is the only notification".
  const notice = { ...STOP_EVENT, event: 'Notification', notice: 'permission' } as const
  assert.equal(isPermissionNotice(notice), true)
  assert.equal(isPermissionNotice({ ...notice, notice: 'idle' } as const), false)

  const ctx = {
    hooks: { permission: { at: STOP_EVENT.at } },
    lastActivity: '2026-08-11T10:21:30.000Z',
  }
  // ★ Saying an approval is pending gives "needs attention" = it rings
  const label = settledLabel(notice, { kind: 'live', status: 'busy' }, { ...ctx, hasPendingApproval: true })
  assert.equal(label, '要対応')
  assert.equal(shouldRing(label), true, '★★ an approval request must not be silent')
  // ⚠️ Without saying so it becomes "responding" = silent (this is what was fixed)
  const bad = settledLabel(notice, { kind: 'live', status: 'busy' }, { ...ctx, hasPendingApproval: false })
  assert.equal(bad, '応答中')
  assert.equal(shouldRing(bad), false)
})

test('★★ do not send the same wording twice (the idle 60 seconds after Stop was ringing twice)', () => {
  resetLabelsForTest()
  const ev = STOP_EVENT
  // Send the first one
  assert.equal(shouldSendLabel(ev, '完了'), true)
  rememberLabel(ev, '完了')
  // The idle 60 seconds later is not sent if it is also "done"
  assert.equal(shouldSendLabel(ev, '完了'), false)
  // ★ Send when the state changes
  assert.equal(shouldSendLabel(ev, '要対応'), true)
  rememberLabel(ev, '要対応')
  assert.equal(shouldSendLabel(ev, '要対応'), false)
  // ★ Send again when it returns to the original state (you must notice "done → needs attention → done")
  assert.equal(shouldSendLabel(ev, '完了'), true)

  // ⚠️ The account is part of the key too (the same sessionId in two accounts would mix states)
  assert.equal(shouldSendLabel({ ...ev, account: '.claude' }, '要対応'), true)

  // ⚠️⚠️ Events without a sessionId are not collapsed (**when unknown, send**. Do not fall to the silent side)
  const noId = { ...ev, sessionId: undefined }
  rememberLabel(noId, '要対応')
  assert.equal(shouldSendLabel(noId, '要対応'), true)
  resetLabelsForTest()
})

test('★★ a different reason is a different notification (needs attention (input needed) vs needs attention (sandbox permission))', () => {
  // ⚠️⚠️ codex review 2026-08-21, high #2. Collapsing on `label` alone made the second one vanish.
  //    On machines without the approval hook **it is the only notification**, so it silently dropped.
  resetLabelsForTest()
  assert.equal(shouldSendLabel(STOP_EVENT, '要対応', '入力が必要'), true)
  rememberLabel(STOP_EVENT, '要対応', '入力が必要')
  // ★ Collapse when the reason is the same
  assert.equal(shouldSendLabel(STOP_EVENT, '要対応', '入力が必要'), false)
  // ★★ Send when the reason differs
  assert.equal(shouldSendLabel(STOP_EVENT, '要対応', 'sandbox の許可'), true)
  // ★ Also treated differently when the reason disappears (is no longer attached)
  assert.equal(shouldSendLabel(STOP_EVENT, '要対応'), true)
  resetLabelsForTest()
})

test('★★ the collapsing key must not include things that change every time (ctx) (collapsing would stop working)', () => {
  // ⚠️ Using the whole body as the key means `ctx 87k` changes every time, bringing back the duplicate 60 seconds after `Stop`.
  //    The key must be only "state + reason".
  resetLabelsForTest()
  rememberLabel(STOP_EVENT, '完了')
  assert.equal(shouldSendLabel(STOP_EVENT, '完了'), false, 'collapse even when ctx changes')
  resetLabelsForTest()
})

test('★★ do not treat an unreadable index as "gone" (it would announce done while running)', () => {
  // ⚠️⚠️ codex review 2026-08-21, high #3. `gone` is passed to `resolveStatus`, and
  //    becomes "done" based on the latest `Stop`. Just because the index was mid-write,
  //    it announced **"done" for a running session** (fail-open).
  const ctx = { hooks: STOPPED, lastActivity: '2026-08-11T10:00:00.000Z' }
  assert.equal(settledLabel(STOP_EVENT, { kind: 'gone' }, ctx), '完了')
  assert.equal(settledLabel(STOP_EVENT, { kind: 'unknown' }, ctx), UNKNOWN_LABEL)
})

test('★★ even a long project name fits within the push limit (4KB)', () => {
  // ⚠️⚠️ codex review 2026-08-21, medium #5. The display side was bounded, but **the tag took raw values**.
  //    Measured: with a 5000-char `project` the payload was 15,334 bytes and **not a single notification showed**.
  const huge = {
    ...STOP_EVENT,
    project: 'あ'.repeat(5000),
    account: `.claude-${'x'.repeat(5000)}`,
    machine: 'M'.repeat(5000),
  }
  const payload = toPushPayload(huge, '完了')
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
  assert.ok(bytes < 3000, `payload too large: ${bytes} bytes`)
  // ★ Even when cut, the same session always gets the same tag (collapsing is not broken)
  assert.equal(payload.tag, toPushPayload(huge, '要対応').tag)
  // ★ Different sessions get different tags (truncation does not cause collisions)
  assert.notEqual(payload.tag, toPushPayload({ ...huge, sessionId: 'other' }, '完了').tag)
})

test('★★ remember only when sent (remembering a failure means it never arrives)', () => {
  // ⚠️ If it remembers on a failed send, the next identical state is discarded as a "duplicate".
  //    The wiring conditions this on `result.sent > 0` (this pins the tool-side contract).
  resetLabelsForTest()
  assert.equal(shouldSendLabel(STOP_EVENT, '完了'), true)
  // If rememberLabel is not called, the next one can be sent too
  assert.equal(shouldSendLabel(STOP_EVENT, '完了'), true)
  resetLabelsForTest()
})

test('★ toPushPayload: swapping the wording does not change what is carried (§6.2)', () => {
  const payload = toPushPayload(STOP_EVENT, '背景で実行中')
  assert.equal(payload.body, '背景で実行中 · PC-A · claude-r\nnyan-remote')
  // ★ The tag does not depend on the wording. Building it from the wording would leave two notifications for the same turn
  assert.equal(payload.tag, 'PC-A/.claude-r/nyan-remote/abc-123')
  // ★★ "背景で実行中" (running in background) is **silent** (what rings: needs attention, done, abnormal exit, state unknown, awaiting approval)
  assert.equal(payload.silent, true)
  assert.deepEqual(
    Object.keys(payload).sort(),
    ['at', 'body', 'event', 'silent', 'tag', 'title', 'url'],
  )

  // ★ Wordings that ring do not get a `silent` key at all (the sw checks `=== true`)
  assert.equal(toPushPayload(STOP_EVENT, '完了').silent, undefined)
  assert.equal(toPushPayload(STOP_EVENT, '要対応').silent, undefined)
  assert.equal(toPushPayload(STOP_EVENT, UNKNOWN_LABEL).silent, undefined)
  // ⚠️⚠️ Unknown wording **rings** (falling to silence would go unnoticed by anyone)
  assert.equal(toPushPayload(STOP_EVENT, 'まだ無い状態').silent, undefined)
})

test('★ labelFor and the list wording point to the same thing (confirms the double bookkeeping is gone)', () => {
  assert.equal(labelFor('Stop'), statusLabel('done'))
  assert.equal(labelFor('StopFailure'), statusLabel('error'))
  assert.equal(labelFor('Notification'), statusLabel('waiting'))
})

test('classifyNotice: separates approval requests from idle notifications', () => {
  // Only approval requests become "承認待ち" (awaiting approval). Mixing in idle notifications would be crying wolf
  assert.equal(classifyNotice({ message: 'Claude needs your permission to use Bash' }), 'permission')
  assert.equal(classifyNotice({ message: 'Please approve this action' }), 'permission')
  assert.equal(classifyNotice({ message: 'Claude is waiting for your input' }), 'idle')
  // With no message, fall to the safe side (treated as idle)
  assert.equal(classifyNotice({}), 'idle')
})

test('classifyNotice: prefers notification_type (does not depend on wording)', () => {
  // Measurement showed the payload has notification_type (2026-08-11)
  assert.equal(classifyNotice({ notification_type: 'tool_use_permission' }), 'permission')
  assert.equal(classifyNotice({ notification_type: 'permission_request' }), 'permission')
  assert.equal(classifyNotice({ notification_type: 'idle_prompt' }), 'idle')
  assert.equal(classifyNotice({ notification_type: 'waiting_for_input' }), 'idle')

  // For unknown vocabulary, decide by the message wording (backup)
  assert.equal(
    classifyNotice({ notification_type: 'something_new', message: 'needs your permission' }),
    'permission',
  )
  assert.equal(classifyNotice({ notification_type: 'something_new', message: 'just idling' }), 'idle')
})

test('★ classifyNotice: does not conclude idle from type alone, and does not miss approvals', () => {
  // The notification_type vocabulary is unknown. Even if an approval request's type is a word like `user_input_required`
  // that matches the idle-side pattern, look at message and decide it is an approval.
  // (An early return preferring type would drop what wording matching would have caught = a regression)
  assert.equal(
    classifyNotice({
      notification_type: 'user_input_required',
      message: 'Claude needs your permission to use Bash',
    }),
    'permission',
  )
  // Idle notifications seen in real data do not contain permission in their wording, so no false positives
  assert.equal(
    classifyNotice({
      notification_type: 'user_input_required',
      message: 'Claude is waiting for your input',
    }),
    'idle',
  )
})

// ── Stop a single approval from sending two notifications (★ reported by the user on 2026-08-13) ─────────────
//
// "要対応" (needs attention, Notification) and "承認待ち" (awaiting approval, the PermissionRequest hook) appeared side by side, and
// after answering on the PC **only the awaiting-approval one disappeared, leaving needs attention**.
// ② is better (it shows the tool name / jumps to the thread / disappears once answered), so
// on machines where ② fires, ① is not sent.

const notice = (n: 'permission' | 'idle'): HookEvent => ({
  event: 'Notification',
  machine: 'PC-B',
  account: '.claude-s',
  project: 'answer-analytics',
  sessionId: 's1',
  at: '2026-08-13T08:00:00.000Z',
  notice: n,
})

test('★★ shouldPushNotice: on machines with the approval hook, "needs attention" is not sent', () => {
  assert.equal(shouldPushNotice(notice('permission'), true), false)
})

test('★★ shouldPushNotice: sent on machines without it (it is the only notification, so it must not be suppressed)', () => {
  assert.equal(shouldPushNotice(notice('permission'), false), true)
})

test('★ shouldPushNotice: idle notifications are unrelated to approvals, so always sent', () => {
  assert.equal(shouldPushNotice(notice('idle'), true), true)
  assert.equal(shouldPushNotice(notice('idle'), false), true)
})

test('shouldPushNotice: done / abnormal exit are unaffected', () => {
  const base = { machine: 'PC-B', account: '.claude-s', project: 'p', at: '2026-08-13T08:00:00.000Z' }
  assert.equal(shouldPushNotice({ ...base, event: 'Stop' }, true), true)
  assert.equal(shouldPushNotice({ ...base, event: 'StopFailure' }, true), true)
  // Kinds that produce no notification
  assert.equal(shouldPushNotice({ ...base, event: 'SessionEnd' }, true), false)
  assert.equal(shouldPushNotice({ ...base, event: 'PreToolUse' }, false), false)
})

// ⚠️ The expected shape is "a url that reaches this agent" and "the current token".
//    If either differs, the hook is rejected with 403 = it does not arrive, so it must not count as installed.
const EXPECT = { url: 'http://127.0.0.1:7777/permission', token: 'tok-current' }
const entry = (over: Record<string, unknown> = {}) => ({
  hooks: {
    PermissionRequest: [
      {
        matcher: '',
        hooks: [
          {
            type: 'http',
            url: EXPECT.url,
            timeout: 86400,
            headers: { Authorization: `Bearer ${EXPECT.token}` },
            ...over,
          },
        ],
      },
    ],
  },
})

test('★ hasPermissionHook: only reads an http hook that reaches us as "installed"', () => {
  assert.equal(hasPermissionHook(entry(), EXPECT), true)
  // Header-name case and extra whitespace are tolerated
  assert.equal(
    hasPermissionHook(entry({ headers: { authorization: `Bearer  ${EXPECT.token} ` } }), EXPECT),
    true,
  )
  // A machine with only notify.sh (no approval hook)
  assert.equal(hasPermissionHook({ hooks: { Stop: [{ hooks: [{ type: 'command' }] }] } }, EXPECT), false)
  assert.equal(hasPermissionHook({ hooks: { PermissionRequest: [] } }, EXPECT), false)
  // ⚠️ Do not mistake a hook pointing to another service or port for our own
  assert.equal(hasPermissionHook(entry({ url: 'http://x/other' }), EXPECT), false)
  assert.equal(hasPermissionHook(entry({ url: 'http://127.0.0.1:7788/permission' }), EXPECT), false)
  // A command-type hook (a custom script) does not reach the agent, so it is not installed
  assert.equal(
    hasPermissionHook({ hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'x' }] }] } }, EXPECT),
    false,
  )
  // Broken input
  assert.equal(hasPermissionHook(null, EXPECT), false)
  assert.equal(hasPermissionHook('{}', EXPECT), false)
  assert.equal(hasPermissionHook({ hooks: 'x' }, EXPECT), false)
})

test('★★ hasPermissionHook: a hook with an old token is not "installed" (all notifications would stop)', () => {
  // ⚠️ Pointed out in the external review on 2026-08-13. Recreating config.json or copying another machine's settings
  //    makes only the Bearer stale. /permission rejects with 403 so approvals never fire, yet
  //    mistaking it for "installed" and also stopping the "needs attention" push means **not a single notification arrives**.
  assert.equal(hasPermissionHook(entry({ headers: { Authorization: 'Bearer tok-old' } }), EXPECT), false)
  // Same when the header itself is missing
  assert.equal(hasPermissionHook(entry({ headers: undefined }), EXPECT), false)
  assert.equal(hasPermissionHook(entry({ headers: { 'X-Other': 'y' } }), EXPECT), false)
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ Dedup **does not cross turns** (2026-09-21 / hit in the field)
//
// ⚠️⚠️ Before the fix, once "done" was sent, **that session never got another notification**
//    (measured: `直前と同じなので送らない` (not sent: same as last time) three turns in a row).
//    = the main use on the go (instruct from the phone → learn when it is done) did not work from the second time on.
//
// ★ Design point: **the turn marker is taken only from `Stop`-type `promptId`s**.
//   Whether `Notification/idle`'s `prompt_id` is the same value **has not been measured**, so we do not depend on it.
// ─────────────────────────────────────────────────────────────────────────────

test('★★ a different turn sends even the same wording (exactly today\'s real damage)', () => {
  resetLabelsForTest()
  const turn1 = { ...STOP_EVENT, promptId: 'p1' }
  const turn2 = { ...STOP_EVENT, promptId: 'p2' }

  assert.equal(shouldSendLabel(turn1, '完了'), true)
  rememberLabel(turn1, '完了')
  // ⚠️ The second one in the same turn (the idle 60 seconds later) is collapsed
  assert.equal(shouldSendLabel(turn1, '完了'), false)
  // ★★ The next turn's "done" is **always sent** (this is what was fixed)
  assert.equal(shouldSendLabel(turn2, '完了'), true, '⚠️⚠️ collapsing across turns')
})

test('★★ idle\'s prompt_id is not looked at (do not depend on an unmeasured value)', () => {
  resetLabelsForTest()
  const stop = { ...STOP_EVENT, promptId: 'p1' }
  assert.equal(shouldSendLabel(stop, '完了'), true)
  rememberLabel(stop, '完了')

  // ⚠️⚠️ Even if idle carries a **different** prompt_id, it is not a Stop, so "the turn has not changed"
  const idle = { ...STOP_EVENT, event: 'Notification', notice: 'idle' as const, promptId: 'ちがう' }
  assert.equal(shouldSendLabel(idle, '完了'), false, '⚠️⚠️ advancing the turn on idle\'s id')

  // ★ Even if idle is sent (= a changed wording is sent), the turn marker is not overwritten
  assert.equal(shouldSendLabel(idle, '要対応'), true)
  rememberLabel(idle, '要対応')
  assert.equal(shouldSendLabel({ ...STOP_EVENT, promptId: 'p1' }, '要対応'), false, 'collapse within the same turn')
})

test('★★ if Stop has no prompt_id, behave as before (no regression)', () => {
  resetLabelsForTest()
  const ev = STOP_EVENT // ⚠️ no promptId
  assert.equal(shouldSendLabel(ev, '完了'), true)
  rememberLabel(ev, '完了')
  assert.equal(shouldSendLabel(ev, '完了'), false, '⚠️ no longer collapsing (the duplicate comes back)')
})
