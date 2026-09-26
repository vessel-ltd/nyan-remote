// ★ Which machine problems the list shows, and how (`ui/offline.ts`).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { machineCount, machineCountLabel, OFFLINE_GRACE_MS, splitTrouble } from './offline.ts'
import { setLang } from '../../../shared/i18n.ts'

const now = 1_000_000

test('★★ an unreachable machine is not an error: grey, and only after the grace period', () => {
  const s = [{ label: 'pc-a', error: 'Cannot reach it', offline: true, offlineSince: now - 5_000 }]
  assert.deepEqual(splitTrouble(s, now), { errors: [], offline: [] }, 'a reconnect or reopening the app must not flash anything')
  assert.deepEqual(splitTrouble(s, now + OFFLINE_GRACE_MS).offline.map((x) => x.label), ['pc-a'])
})

test('★★ errors after reaching a machine stay red, at once', () => {
  const s = [{ label: 'pc-b', error: 'config.json is broken' }]
  assert.deepEqual(splitTrouble(s, now).errors.map((x) => x.label), ['pc-b'])
  assert.deepEqual(splitTrouble(s, now).offline, [])
})

test('★ healthy machines show nothing; offline ones are listed oldest first', () => {
  const s = [
    { label: 'ok' },
    { label: 'later', error: 'x', offline: true, offlineSince: now - 40_000 },
    { label: 'first', error: 'x', offline: true, offlineSince: now - 90_000 },
    { label: 'unknown-since', error: 'x', offline: true },
  ]
  const r = splitTrouble(s, now)
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.offline.map((x) => x.label), ['first', 'later'])
})

test('★ the Settings button count: reachable / all, always shown', () => {
  assert.equal(machineCount(5, 2), '🖥 3/5')
  assert.equal(machineCount(1, 0), '🖥 1/1')
  assert.equal(machineCount(1, 1), '🖥 0/1')
})

test('★ screen readers hear what the fraction counts (codex)', () => {
  setLang('en')
  assert.equal(machineCountLabel(2, 1), '1 of 2 machines reachable')
})
