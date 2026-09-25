// ★★ Notification text (`notificationText` in `shared/types.ts`).
//    ⚠️ If this breaks we are back to "the list and the notification disagree". Check **the exact string the implementation builds**.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  UNKNOWN_LABEL,
  notificationText,
  shouldRing,
  statusLabel,
  type NotifyFields,
} from '../../shared/types.ts'

const base: NotifyFields = {
  title: 'GYG_API Test workflow faillure',
  titleSource: 'ai',
  sessionId: '600ec8d2-1111-2222-3333-444455556666',
  project: 'isue-u358-llm358-llm-context',
  machine: 'PC-B',
  account: '.claude-r',
  label: statusLabel('waiting')!,
  qualifier: '承認プロンプト',
  contextTokens: 87_000,
}

test('★★ a notification has two lines; no project name when there is a title (the shape the user asked for)', () => {
  const t = notificationText(base)
  assert.equal(t.title, 'GYG_API Test workflow faillure')
  assert.equal(t.body, '要対応（承認プロンプト）· PC-B · claude-r · ctx 87k')
  // ★ two lines = no newline in body
  assert.ok(!t.body.includes('\n'), `an extra third line appeared: ${JSON.stringify(t.body)}`)
})

test('★★ the project name goes on line 3 only when the title falls back to the ID', () => {
  // ⚠️ without a meaningful title, two sessions in the same worktree become **two indistinguishable cards**
  const t = notificationText({ ...base, titleSource: 'fallback', title: '' })
  assert.equal(t.title, '600ec8d2')
  assert.equal(
    t.body,
    '要対応（承認プロンプト）· PC-B · claude-r · ctx 87k\nisue-u358-llm358-llm-context',
  )
})

test('★★ the typed text itself (prompt-derived) is never shown (user decision 2026-08-21)', () => {
  // ⚠️ `ai` titles are allowed as an explicit exception in §6.2. But `prompt` is **the text you typed**,
  //    which is a step more raw on the lock screen. ⇒ fall back to the 8-char ID.
  const secret = 'この顧客の請求バグを直して。金額は 1,234,567 円'
  const t = notificationText({ ...base, titleSource: 'prompt', title: secret })
  assert.equal(t.title, '600ec8d2')
  assert.ok(!t.body.includes(secret))
  assert.ok(!JSON.stringify(t).includes('請求'), `the typed text leaked: ${JSON.stringify(t)}`)
})

test('★ a custom title has top priority', () => {
  const t = notificationText({ ...base, titleSource: 'custom', title: 'nyan-remote-main' })
  assert.equal(t.title, 'nyan-remote-main')
})

test('★ unknown things are not shown (no ctx / no reason / default account)', () => {
  const t = notificationText({
    ...base,
    account: '.claude',
    label: statusLabel('done')!,
    qualifier: undefined,
    contextTokens: undefined,
  })
  assert.equal(t.body, '完了 · PC-B · claude')
  // ⚠️ do not show 0 as "ctx 0"
  assert.equal(notificationText({ ...base, contextTokens: 0 }).body.includes('ctx'), false)
})

test('★ no space right after a full-width closing parenthesis (the gap would be too wide)', () => {
  assert.ok(notificationText(base).body.includes('）· PC-B'))
  // ★ without parentheses, a normal space is used
  assert.ok(notificationText({ ...base, qualifier: undefined }).body.includes('要対応 · PC-B'))
})

test('★★ fits in 4KB even with a long title and long fields (unbounded, the notification is not shown)', () => {
  const t = notificationText({
    ...base,
    title: 'あ'.repeat(5000),
    project: 'p'.repeat(5000),
    machine: 'M'.repeat(5000),
    account: `.claude-${'x'.repeat(5000)}`,
    qualifier: 'q'.repeat(5000),
    titleSource: 'fallback',
  })
  assert.ok(JSON.stringify(t).length < 1024, `too long: ${JSON.stringify(t).length}`)
  assert.ok(t.body.includes('…'), 'no truncation marker')
})

test('★★ whether to ring: **list only the quiet ones** (unknown labels ring)', () => {
  // ⚠️⚠️ Writing it as "the list that rings" falls toward **silence** when labels are added.
  //    Nobody notices that state (the same failure type as the iPhone staying silent for 3 days).
  for (const quiet of [statusLabel('working')!, statusLabel('background')!]) {
    assert.equal(shouldRing(quiet), false, `must not ring: ${quiet}`)
  }
  for (const ring of [
    statusLabel('waiting')!,
    statusLabel('done')!,
    statusLabel('error')!,
    UNKNOWN_LABEL,
    '承認待ち',
    'まだ存在しない状態',
    '',
  ]) {
    assert.equal(shouldRing(ring), true, `should ring: ${ring}`)
  }
})

test('★ "unknown state" is not "turn ended" (renamed so the difference from done is readable)', () => {
  assert.equal(UNKNOWN_LABEL, '状態不明')
  assert.notEqual(UNKNOWN_LABEL, statusLabel('done'))
})
