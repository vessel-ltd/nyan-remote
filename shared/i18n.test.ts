import assert from 'node:assert/strict'
import { test } from 'node:test'
import { asLang, currentLang, localizeNotificationBody, pickBilingual, pickLang, setLang, setLangProvider, t, tIn } from './i18n.ts'
import { notificationText, statusLabel, UNKNOWN_LABEL, waitingReason, type SessionStatus } from './types.ts'

const JA = /[぀-ヿ一-鿿（）]/

test('★★ how the language is decided: manual first, Japanese if the device language is ja, otherwise English, Japanese when unknown', () => {
  assert.equal(pickLang('en', ['ja-JP']), 'en')
  assert.equal(pickLang(undefined, ['ja-JP', 'en']), 'ja')
  assert.equal(pickLang(undefined, ['en-US']), 'en')
  assert.equal(pickLang(undefined, ['fr']), 'en')
  assert.equal(pickLang('xx', []), 'ja')
  assert.equal(pickLang(null, undefined), 'ja')
  assert.equal(asLang('en'), 'en')
  assert.equal(asLang('EN'), undefined)
})

test('★★ t looks at the current language on every call, and the per-request language (provider) wins', () => {
  setLang('ja')
  assert.equal(t('接続先', 'Connections'), '接続先')
  setLang('en')
  assert.equal(t('接続先', 'Connections'), 'Connections')
  setLangProvider(() => 'ja')
  assert.equal(currentLang(), 'ja')
  setLangProvider(() => undefined)
  assert.equal(currentLang(), 'en', '⚠️ did not fall back to the setLang value when the provider does not know')
  setLangProvider(undefined)
  setLang('ja')
  assert.equal(tIn('en', 'あ', 'a'), 'a')
})

test('★★ notification line 2: every fixed word becomes English (no word outside the table is left)', () => {
  const statuses: SessionStatus[] = ['working', 'background', 'waiting', 'error', 'done', 'rate-limited', 'idle']
  const labels = [...statuses.map((s) => statusLabel(s)!), UNKNOWN_LABEL, '承認待ち', '自動承認 終了']
  const reasons = ['permission prompt', 'sandbox request', 'input needed', 'dialog open', 'worker request', 'goal proposal'].map(
    (w) => waitingReason(w)!,
  )
  for (const label of labels) {
    for (const q of [undefined, ...reasons]) {
      const { body } = notificationText({
        title: '',
        titleSource: 'fallback',
        sessionId: 'abcdef1234',
        project: 'proj',
        machine: 'PC-B',
        account: '.claude-r',
        label,
        ...(q ? { qualifier: q } : {}),
        contextTokens: 87000,
      })
      const en = localizeNotificationBody(body, 'en')
      assert.doesNotMatch(en, JA, `⚠️⚠️ left untranslated: ${body} → ${en}`)
    }
  }
  assert.equal(
    localizeNotificationBody('要対応（承認プロンプト）· PC-B · claude-r · ctx 87k', 'en'),
    'Needs you (permission prompt) · PC-B · claude-r · ctx 87k',
  )
  assert.equal(localizeNotificationBody('テスト通知（無音） 12:34', 'en'), 'Test notification (silent) 12:34')
  // ★ Japanese stays as-is
  assert.equal(localizeNotificationBody('要対応（承認プロンプト）', 'ja'), '要対応（承認プロンプト）')
})

test('★★ only state and reason are translated; machine, account and project names are never rewritten (codex round 17, low #5)', () => {
  for (const qualifier of [undefined, '承認プロンプト']) {
    const { body } = notificationText({
      title: '',
      titleSource: 'fallback',
      sessionId: 'abcdef1234',
      project: '完了通知',
      machine: '応答中PC',
      account: '.承認待ち',
      label: '完了',
      ...(qualifier ? { qualifier } : {}),
    })
    const en = localizeNotificationBody(body, 'en')
    assert.ok(en.startsWith(qualifier ? 'Done (permission prompt)' : 'Done'), en)
    assert.ok(en.includes('応答中PC'), `⚠️⚠️ translated the machine name: ${en}`)
    assert.ok(en.includes('承認待ち'), `⚠️⚠️ translated the account name: ${en}`)
    assert.ok(en.endsWith('\n完了通知'), `⚠️⚠️ translated the project name: ${en}`)
  }
})

test('★ pickBilingual: take only the current-language side of the relay "English / Japanese" text', async () => {
  assert.equal(pickBilingual('Agent not connected / agent が繋がっていません', 'en'), 'Agent not connected')
  assert.equal(pickBilingual('Agent not connected / agent が繋がっていません', 'ja'), 'agent が繋がっていません')
  // ⚠️ Different shapes stay as-is (old relays send Japanese only / do not split an English-only sentence that contains " / ")
  assert.equal(pickBilingual('agent が繋がっていません', 'en'), 'agent が繋がっていません')
  assert.equal(pickBilingual('read / write failed', 'en'), 'read / write failed')
  // ★ Every entry of relay's table has a splittable shape
  const { REASON } = await import('../relay/src/room.ts')
  for (const [name, r] of Object.entries(REASON)) {
    if (name === 'malformed') continue
    assert.ok(!/[぀-ヿ一-鿿]/.test(pickBilingual(r, 'en')), `${name}: ${pickBilingual(r, 'en')}`)
  }
})
