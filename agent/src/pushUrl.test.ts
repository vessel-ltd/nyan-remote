import assert from 'node:assert/strict'
import { test } from 'node:test'
import { threadUrl } from './pushUrl.ts'

// ★★ Regression guard for a bug seen on a real device on 2026-08-13.
//    Tapping a notification showed the source code of `sw.js` in tiny text.
//    The URL was `#/s/...` (no leading slash), and inside a Service Worker it
//    **resolves against `/sw.js`**, so it became `/sw.js#/s/...`.

test('★★ threadUrl: always starts with `/` (a Service Worker resolves against sw.js)', () => {
  const u = threadUrl('d659ffc7-c73f-48ba-81b6-74ef520bee34')
  assert.ok(u.startsWith('/'), `does not start with /: ${u}`)
  // ⚠️ a bare fragment opens the source of sw.js
  assert.ok(!u.startsWith('#'), `is a bare fragment: ${u}`)
  assert.equal(u, '/#/s/d659ffc7-c73f-48ba-81b6-74ef520bee34')
})

test('threadUrl: opens the list if there is no sessionId', () => {
  assert.equal(threadUrl(undefined), '/')
  assert.equal(threadUrl(''), '/')
})

test('threadUrl: escapes characters not allowed in a URL', () => {
  // sessionId is normally a UUID, but it comes from transcript file names so it is not trusted
  assert.equal(threadUrl('a b/c'), '/#/s/a%20b%2Fc')
  assert.ok(!threadUrl('x#y').includes('x#y'))
})
