import assert from 'node:assert/strict'
import { test } from 'node:test'
import { staleAppTags, type NotificationFacts } from './notifications.ts'

const AT = 2_000_000
const snap = new Map([['PC-A', AT]])
const old = (tag: string, machine = 'PC-A'): NotificationFacts => ({
  tag,
  machine,
  timestamp: AT - 1000,
})

test('★ staleAppTags: closes only notifications for approvals no longer pending', () => {
  const shown = [old('perm-PC-A-a'), old('perm-PC-A-b'), old('PC-A/acc/proj/sess')]
  assert.deepEqual(staleAppTags(shown, new Set(['perm-PC-A-b']), snap), ['perm-PC-A-a'])
})

test('★★ staleAppTags: does not close notifications newer than the list (approvals raised after fetching)', () => {
  // ⚠️⚠️ codex high #2 on 2026-08-20. The list is a snapshot, so approvals raised between fetching and
  //    the screen updating look "absent". Closing them **removes the only signal for that approval**.
  const newer: NotificationFacts = { tag: 'perm-PC-A-new', machine: 'PC-A', timestamp: AT + 1 }
  assert.deepEqual(staleAppTags([newer], new Set(), snap), [])
  assert.deepEqual(staleAppTags([{ ...newer, timestamp: AT }], new Set(), snap), [])
  // ★ Old ones are closed (the rule has not collapsed into "never close")
  assert.deepEqual(staleAppTags([old('perm-PC-A-x')], new Set(), snap), ['perm-PC-A-x'])
})

test('★★ staleAppTags: leaves notifications with unknown owner alone (no fallback to prefix match)', () => {
  // ⚠️ In `perm-<machine>-<key>` both machine and key may contain `-`, so it cannot be split.
  //    Falling back to prefix match would close live `pc-b-wsl` notifications just because `pc-b` fetched OK (high #4).
  assert.deepEqual(staleAppTags([{ tag: 'perm-pc-b-k', timestamp: AT - 1 }], new Set(), snap), [])
  assert.deepEqual(
    staleAppTags([old('perm-pc-b-wsl-k', 'pc-b-wsl')], new Set(), new Map([['pc-b', AT]])),
    [],
  )
})

test('★★ staleAppTags: leaves notifications alone for machines with unknown state or without a timestamp', () => {
  assert.deepEqual(staleAppTags([old('perm-PC-B-a', 'PC-B')], new Set(), snap), [])
  assert.deepEqual(
    staleAppTags([{ tag: 'perm-PC-A-a', machine: 'PC-A' }], new Set(), snap),
    [],
  )
  // Do nothing if not a single list has been fetched
  assert.deepEqual(staleAppTags([old('perm-PC-A-a')], new Set(), new Map()), [])
})
