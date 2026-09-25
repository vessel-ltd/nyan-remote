import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dismissRecord, isSnoozed, planUpdates, releaseChecker, UPDATE_SNOOZE_MS } from './updates.ts'

const OLD = { commit: 'aaaaaaa', committedAt: '2026-09-20T10:00:00+09:00' }
const NEW = { commit: 'bbbbbbb', committedAt: '2026-09-24T10:00:00+09:00' }
const DEV = { commit: 'ccccccc', committedAt: '2026-09-25T10:00:00+09:00' }

test('★★ update notice: lists only old ones (not dev machines, old agents without a version, or broken values)', () => {
  const p = planUpdates({
    self: OLD,
    latest: NEW,
    machines: [
      { name: 'PC-B', build: OLD },
      { name: 'pc-a', build: DEV },
      { name: 'pc-c', build: NEW },
      { name: 'mac', build: undefined },
      { name: 'odd', build: { commit: '<script>', committedAt: 'x' } },
      { name: 'PC-B', build: OLD },
    ],
  })
  assert.deepEqual(p, { app: true, machines: ['PC-B'], key: 'bbbbbbb|app|PC-B' })
})

test('★ update notice: everything current, or distribution version unknown ⇒ nothing', () => {
  assert.equal(planUpdates({ self: NEW, latest: NEW, machines: [{ name: 'a', build: NEW }] }), undefined)
  assert.equal(planUpdates({ self: OLD, latest: undefined, machines: [{ name: 'a', build: OLD }] }), undefined)
  // ★ App only / machines only
  assert.equal(planUpdates({ self: null, latest: NEW, machines: [{ name: 'a', build: OLD }] })?.app, false)
  assert.deepEqual(planUpdates({ self: OLD, latest: NEW, machines: [] })?.machines, [])
})

test('★ dismissal key: different content gives a different key (new version or more old machines ⇒ shown again)', () => {
  const a = planUpdates({ self: NEW, latest: NEW, machines: [{ name: 'a', build: OLD }] })!.key
  const b = planUpdates({ self: NEW, latest: NEW, machines: [{ name: 'a', build: OLD }, { name: 'b', build: OLD }] })!.key
  const c = planUpdates({ self: NEW, latest: DEV, machines: [{ name: 'a', build: OLD }] })!.key
  assert.notEqual(a, b)
  assert.notEqual(a, c)
})

test('★★ asks the distribution origin at most every N, never concurrently, previous answer on failure (codex round 23, low #5)', async () => {
  let clock = 0
  let calls = 0
  let answer: typeof NEW | undefined = NEW
  const c = releaseChecker(async () => {
    calls++
    return answer
  }, 1000, () => clock)
  await Promise.all([c.check(), c.check()])
  assert.equal(calls, 1, '⚠️ asked twice concurrently')
  clock = 500
  assert.deepEqual(await c.check(), NEW)
  assert.equal(calls, 1, '⚠️ asked again before the interval (asks every time the screen is revisited)')
  clock = 1500
  answer = undefined
  assert.deepEqual(await c.check(), NEW, '⚠️ discarded the answer when the fetch failed')
  assert.equal(calls, 2)
})

test('★★ ✕ means "not today": hide for 24 hours, show again if still old, do not wait if the content changed', () => {
  const at = 1_000_000
  const rec = dismissRecord('k1', at)
  assert.equal(isSnoozed(rec, 'k1', at + 1000), true)
  assert.equal(isSnoozed(rec, 'k1', at + UPDATE_SNOOZE_MS - 1), true)
  assert.equal(isSnoozed(rec, 'k1', at + UPDATE_SNOOZE_MS), false, '⚠️⚠️ still hidden after 24 hours (silently stays old)')
  assert.equal(isSnoozed(rec, 'k2', at + 1000), false, '⚠️ hidden although the content changed')
  // ⚠️ Unreadable, old shape (bare key) or clock set back ⇒ do not hide (err on showing too much)
  assert.equal(isSnoozed('k1', 'k1', at), false)
  assert.equal(isSnoozed('{', 'k1', at), false)
  assert.equal(isSnoozed(null, 'k1', at), false)
  assert.equal(isSnoozed(rec, 'k1', at - 1), false)
})

test('★ if the device clock goes back, ask again without waiting for the interval (codex round 24, low #7)', async () => {
  let clock = 10_000_000
  let calls = 0
  const c = releaseChecker(async () => {
    calls++
    return NEW
  }, 1000, () => clock)
  await c.check()
  clock -= 24 * 60 * 60 * 1000
  await c.check()
  assert.equal(calls, 2, '⚠️ setting the clock back stopped asking for a whole day')
})
