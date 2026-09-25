import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { endpointTag } from './pushTag.ts'

test('★★ tag is the first 128 bits of SHA-256 in base64url (⚠️ known answer = both sides agree)', async () => {
  const e = 'https://fcm.googleapis.com/fcm/send/abc:DEF_123'
  // ★ Compute with a different implementation (node:crypto) and compare
  const want = createHash('sha256').update(e).digest().subarray(0, 16).toString('base64url')
  assert.equal(await endpointTag(e), want)
  assert.equal((await endpointTag(e)).length, 22)
  assert.match(await endpointTag(e), /^[A-Za-z0-9_-]{22}$/, 'not base64url (contains + / =)')
})

test('★★ different endpoints give different tags, the same endpoint gives the same tag', async () => {
  assert.notEqual(await endpointTag('https://x/1'), await endpointTag('https://x/2'))
  assert.equal(await endpointTag('https://x/1'), await endpointTag('https://x/1'))
})

test('★★ the endpoint cannot be read from the tag (⚠️ never return a capability URL)', async () => {
  const e = 'https://web.push.apple.com/QWxhZGRpbjpvcGVuIHNlc2FtZQ'
  const tag = await endpointTag(e)
  assert.ok(!e.includes(tag) && !tag.includes('apple'), 'part of the endpoint leaks into the tag')
})
