import assert from 'node:assert/strict'
import { test } from 'node:test'
import { asBuildInfo, formatRelease, isBehind, parseRelease } from './release.ts'

const OLD = { commit: 'aaaaaaa', committedAt: '2026-09-20T10:00:00+09:00', builtAt: '2026-09-20T02:00:00.000Z' }
const NEW = { commit: 'bbbbbbb', committedAt: '2026-09-24T10:00:00+09:00', builtAt: '2026-09-24T02:00:00.000Z' }

test('★★ isBehind: true only when older (not just different, and not when unsure)', () => {
  assert.equal(isBehind(OLD, NEW), true)
  assert.equal(isBehind(NEW, OLD), false, '⚠️⚠️ told a dev machine newer than the release to "update"')
  assert.equal(isBehind(NEW, NEW), false)
  assert.equal(isBehind({ commit: 'bbbbbbb+' }, NEW), false, 'same commit (dirty working tree)')
  assert.equal(isBehind({ commit: 'bbbbbbbcc' }, NEW), false, 'same commit even with a different short-hash length')
  assert.equal(isBehind(undefined, NEW), false)
  assert.equal(isBehind(OLD, undefined), false)
  // ★ If one side lacks the commit time, compare by build time (RELEASE files before 2026-09-24)
  assert.equal(isBehind({ commit: 'aaaaaaa', builtAt: OLD.builtAt }, NEW), true)
  // ⚠️ Not enough to compare (git machine = no builtAt / old RELEASE = no committedAt) ⇒ do not prompt
  assert.equal(isBehind({ commit: 'aaaaaaa', committedAt: OLD.committedAt }, { commit: 'bbbbbbb', builtAt: NEW.builtAt }), false)
})

test('★ reading and writing RELEASE (the old 2-line form is readable, broken input gives undefined)', () => {
  const full = { commit: 'abc1234', builtAt: '2026-09-24T07:06:38.794Z', committedAt: '2026-09-24T16:00:00+09:00' }
  assert.deepEqual(parseRelease(formatRelease(full)), full)
  assert.deepEqual(parseRelease('5ae9ca6\n2026-09-24T07:06:38.794Z\n'), { commit: '5ae9ca6', builtAt: '2026-09-24T07:06:38.794Z' })
  assert.equal(parseRelease('<html>'), undefined, '⚠️ do not read a 404 page as a version')
  assert.equal(parseRelease(undefined), undefined)
  assert.equal(asBuildInfo({ commit: 'abc1234', committedAt: 'きのう' })?.committedAt, undefined)
  assert.equal(asBuildInfo(null), undefined)
})
