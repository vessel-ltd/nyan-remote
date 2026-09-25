// How auto-approve mode looks.
//
// ★★ Mutations targeted by name:
//   1. decide whether it is in effect by **the device clock** instead of the marker (clock skew gives
//      "looks off but approvals go through" = fails in the dangerous direction)
//   2. add `sendRoute !== 'keys'` as a condition (**cannot be turned off** in sessions without keystrokes)
//   3. show the button without the marker (`features`) (a button that 404s)
//   4. hide it for a non-live session even though the marker is set (the means to turn it off disappears)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionSummary } from '../../../shared/types.ts'
import { autoApproveBanner, autoApproveError, autoApproveView, remainingText } from './autoApprove.ts'

const NOW = Date.UTC(2026, 8, 7, 12, 0, 0)

function row(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    machine: 'pc-a',
    account: '.claude-r',
    sessionId: 's1',
    cwd: '/home/x/proj',
    project: 'proj',
    title: 'proj',
    titleSource: 'fallback',
    status: 'idle',
    live: true,
    sendRoute: 'keys',
    lastActivity: '2026-09-07T00:00:00.000Z',
    transcriptBytes: 0,
    ...over,
  }
}

const on = (until = new Date(NOW + 2 * 60 * 60 * 1000 + 41 * 60 * 1000).toISOString()) =>
  row({ autoApprove: { until } })

test('★ how the remaining time is phrased', () => {
  assert.equal(remainingText(new Date(NOW + 161 * 60_000).toISOString(), NOW), '残り 2時間41分')
  assert.equal(remainingText(new Date(NOW + 41 * 60_000).toISOString(), NOW), '残り 41分')
  assert.equal(remainingText(new Date(NOW + 30_000).toISOString(), NOW), 'まもなく終了')
  // 1. ⚠️⚠️ do not treat it as "expired" by the device clock (do not fail toward hiding)
  assert.equal(remainingText(new Date(NOW - 60 * 60_000).toISOString(), NOW), 'まもなく終了')
  assert.equal(remainingText('こわれている', NOW), '残り不明')
})

test('★★★ the banner line depends only on whether the marker is set (not removed by the device clock)', () => {
  assert.equal(autoApproveBanner(row(), NOW), null, 'must not be shown for a session that is off')
  assert.ok(autoApproveBanner(on(), NOW)?.text.includes('自動承認'))
  // 1. **keep showing it** even if the expiry has passed (by the phone's clock)
  const past = on(new Date(NOW - 10 * 60_000).toISOString())
  assert.ok(autoApproveBanner(past, NOW), '⚠️ if clock skew removes the warning, approvals go through unseen')
  assert.equal(autoApproveBanner(undefined, NOW), null)
})

test('★★★ the menu does not depend on the keystroke route (so it can always be turned off)', () => {
  // 2. the permission hook works even in an inbox-only session (no relay installed)
  const inbox = row({ sendRoute: 'inbox', keysReason: 'no-relay', autoApprove: on().autoApprove })
  const v = autoApproveView(inbox, 'ready', ['auto-approve'])
  assert.equal(v.show, true, '⚠️ auto-approve cannot be turned off in a session without keystrokes')
  assert.equal(v.on, true)
  assert.ok(v.label.includes('オフ'), `when on, the label should turn it off: ${v.label}`)
})

test('★★ not shown for agents without the marker (no button that 404s)', () => {
  // 3. old agents do not return `features`
  assert.equal(autoApproveView(row(), 'ready', undefined).show, false)
  assert.equal(autoApproveView(row(), 'ready', []).show, false)
  assert.equal(autoApproveView(row(), 'ready', ['slash-commands']).show, false)
  assert.equal(autoApproveView(row(), 'ready', ['auto-approve']).show, true)
})

test('★★ non-live session: can be turned off if on / not shown if off', () => {
  // 4. if the marker is set, **keep the means to turn it off**
  // ★ 2026-09-07 codex high #3: this combination (`live:false` + marker) was **never produced on the real path**
  //   at first, because the agent hid the marker via `live` (= this test protected
  //   nothing). Since the `live` condition was removed from `markAutoApprove`,
  //   **this shape now really arrives** for sessions whose index cannot be read
  const dead = row({ live: false, autoApprove: on().autoApprove })
  assert.equal(autoApproveView(dead, 'ready', ['auto-approve']).show, true, 'the means to turn it off is gone')
  assert.equal(autoApproveView(row({ live: false }), 'ready', ['auto-approve']).show, false)
})

test('★ cannot be tapped while sending (a double tap does not fire twice)', () => {
  const v = autoApproveView(row(), 'sending', ['auto-approve'])
  assert.equal(v.show, true)
  assert.equal(v.disabled, true)
  assert.ok(v.label.endsWith('…'))
})

test('★ when off, the label turns it on (showing the opposite would invert the result of tapping)', () => {
  const v = autoApproveView(row(), 'ready', ['auto-approve'])
  assert.equal(v.on, false)
  assert.ok(v.label.includes('オン'), v.label)
  assert.ok(!v.label.includes('オフ'), v.label)
})

test('★★★ refusal messages differ for on/off (dangerous if the state cannot be read)', () => {
  const onErr = autoApproveError(true, '保存に失敗しました')
  const offErr = autoApproveError(false, '保存に失敗しました')
  assert.notEqual(onErr, offErr, 'with the same message you cannot tell whether approvals are going through or stopped')
  // on: has not started approving (safe side)
  assert.ok(/できませんでした/.test(onErr), onErr)
  // off: says it is stopped but may come back on restart
  assert.ok(/止めました/.test(offErr), offErr)
  assert.ok(/再起動/.test(offErr), `does not say it may come back: ${offErr}`)
  // no lies even without a reason
  assert.ok(autoApproveError(true, undefined).length > 0)
})

test('★★★ the message after turning on states the expiry time returned by the agent (2026-09-24)', async () => {
  const { autoApproveOnText } = await import('./autoApprove.ts')
  const text = autoApproveOnText('2026-09-25T03:00:00.000Z')
  assert.match(text, /自動で切れます/)
  assert.match(text, /\d/, '⚠️ no time in the message')
  // ⚠️ with no or unparsable expiry, do not make up a time (no false time)
  assert.equal(autoApproveOnText(undefined), '自動承認をオンにしました')
  assert.equal(autoApproveOnText('こわれ'), '自動承認をオンにしました')
})
