import assert from 'node:assert/strict'
import { test } from 'node:test'
import { actorOf, ownerOf } from './auth.ts'

test('★ ownerOf: the full identity (two devices sharing the 8-character log prefix are different owners / codex review)', () => {
  const a = { login: '', deviceId: 'AAAAAAAAxxxxxxxxxxxxxxxx', via: 'device' as const }
  const b = { login: '', deviceId: 'AAAAAAAAyyyyyyyyyyyyyyyy', via: 'device' as const }
  assert.equal(actorOf(a), actorOf(b), 'the log prefix is the same')
  assert.notEqual(ownerOf(a), ownerOf(b))
  // The same id proven another way is another owner
  assert.notEqual(ownerOf(a), ownerOf({ ...a, via: 'pairing' as const }))
})
