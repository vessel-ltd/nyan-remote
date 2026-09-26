// ★ First-run guide (`ui/onboarding.ts`).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isStandalone, onboarding, platformOf } from './onboarding.ts'

test('★ platform: iPhone, iPad (even with a Mac user agent), Android, other', () => {
  assert.equal(platformOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'ios')
  assert.equal(platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5), 'ios', 'iPadOS reports a Mac user agent')
  assert.equal(platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0), 'other')
  assert.equal(platformOf('Mozilla/5.0 (Linux; Android 15; Pixel 9)'), 'android')
})

test('★ standalone: the display-mode query, or iOS\'s navigator.standalone', () => {
  assert.equal(isStandalone((q) => q === '(display-mode: standalone)'), true)
  assert.equal(isStandalone(() => false, true), true)
  assert.equal(isStandalone(() => false), false)
})

test('★★ shown only while there is no connection; the install step only in a phone\'s browser tab (user decision)', () => {
  assert.equal(onboarding(1, 'ios', false), undefined, 'after the first pairing it never shows again (browser users are not nagged)')
  assert.deepEqual(onboarding(0, 'ios', false), { install: 'ios' })
  assert.deepEqual(onboarding(0, 'android', false), { install: 'android' })
  assert.deepEqual(onboarding(0, 'ios', true), { install: undefined }, 'opened from the home screen: just pair')
  assert.deepEqual(onboarding(0, 'other', false), { install: undefined }, 'a desktop browser: just pair')
})
