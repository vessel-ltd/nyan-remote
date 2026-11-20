import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isStaleWaiting, shownBeforeAnswer, staleAppTags, staleWaitingTags, type NotificationFacts } from './notifications.ts'

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

test('★ after an agy deny: only notifications shown before it took effect (agent clock), on Chromium and WebKit alike', () => {
  const at = Date.parse('2026-11-20T00:00:10Z')
  // WebKit: no `timestamp`, the service worker's `data.at`
  assert.equal(shownBeforeAnswer({ data: { url: '/', machine: 'pc-a', at: at - 5000, waiting: true } }, at), true)
  // a push that started right after the key went out (within the margin)
  assert.equal(shownBeforeAnswer({ data: { at: at + 300, waiting: true } }, at), true)
  // a newer turn's alert
  assert.equal(shownBeforeAnswer({ data: { at: at + 5000, waiting: true } }, at), false)
  // Chromium: `timestamp`
  assert.equal(shownBeforeAnswer({ data: { url: '/', waiting: true }, timestamp: at - 1 }, at), true)
  // ★ not a "needs you" (an earlier error or "done" under the same tag): left
  assert.equal(shownBeforeAnswer({ data: { at: at - 5000 } }, at), false)
  // neither time: never closed
  assert.equal(shownBeforeAnswer({ data: { url: '/', waiting: true } }, at), false)
  assert.equal(shownBeforeAnswer({}, at), false)
})

test('★ a "needs you" whose session a later list shows not waiting is closed; anything unknown is left', () => {
  const at = Date.parse('2026-11-20T00:00:10Z')
  const rows = new Map([['pc-a', new Map([['agy-1', 'done'], ['agy-2', 'waiting']])]])
  const taken = new Map([['pc-a', at]])
  const n = (over: Partial<Parameters<typeof staleWaitingTags>[0][number]>) => ({ tag: 'pc-a/agy/agy-1', machine: 'pc-a', session: 'agy-1', waiting: true, at: at - 5000, ...over })
  assert.deepEqual(staleWaitingTags([n({})], rows, taken), ['pc-a/agy/agy-1'])
  // still waiting / newer than the list (within 2 s) / not a "needs you" / unknown row, machine, or time
  assert.deepEqual(staleWaitingTags([n({ session: 'agy-2', tag: 'x2' })], rows, taken), [])
  assert.deepEqual(staleWaitingTags([n({ at: at - 1000 })], rows, taken), [])
  // a "done"/"error" (not a "needs you") of a session that does not wait: left
  assert.deepEqual(staleWaitingTags([n({ waiting: false })], rows, taken), [])
  // ★ an older "done"/"error" of a session that waits again (a late delivery after a newer card's alert was opened)
  assert.deepEqual(staleWaitingTags([n({ waiting: false, session: 'agy-2', tag: 'late' })], rows, taken), ['late'])
  assert.deepEqual(staleWaitingTags([n({ session: 'agy-9' })], rows, taken), [])
  assert.deepEqual(staleWaitingTags([n({ machine: 'pc-b' })], rows, taken), [])
  assert.deepEqual(staleWaitingTags([n({ at: undefined })], rows, taken), [])
  // ★ an agy that exited (its conversation is not listed any more): over — only for sessions said to be so
  const agyGone = (s: string) => s.startsWith('agy-')
  assert.deepEqual(staleWaitingTags([n({ session: 'agy-9', tag: 'g' })], rows, taken, agyGone), ['g'])
  assert.deepEqual(staleWaitingTags([n({ session: 'claude-1', tag: 'c' })], rows, taken, agyGone), [], 'a Claude session missing is unknown')
  assert.deepEqual(staleWaitingTags([n({ session: 'agy-9', machine: 'pc-b' })], rows, taken, agyGone), [], 'a machine not read')
})

test('★ judged per notification: an older "done" and a live "needs you" under one tag — only the "done" is over', () => {
  const at = Date.parse('2026-11-20T00:00:10Z')
  const rows = new Map([['pc-a', new Map([['agy-1', 'waiting']])]])
  const taken = new Map([['pc-a', at]])
  const tag = 'pc-a/agy/agy-1'
  const done = { tag, machine: 'pc-a', session: 'agy-1', at: at - 60_000 }
  const live = { tag, machine: 'pc-a', session: 'agy-1', waiting: true, at: at - 5000 }
  assert.equal(isStaleWaiting(done, rows, taken), true)
  assert.equal(isStaleWaiting(live, rows, taken), false)
})

test('★ a conversation open in two agys closes nothing (its row’s state cannot be trusted)', () => {
  const at = Date.parse('2026-11-20T00:00:10Z')
  const rows = new Map([['pc-a', new Map([['agy-1', 'contested']])]])
  const taken = new Map([['pc-a', at]])
  assert.equal(isStaleWaiting({ tag: 't', machine: 'pc-a', session: 'agy-1', waiting: true, at: at - 5000 }, rows, taken), false)
  assert.equal(isStaleWaiting({ tag: 't', machine: 'pc-a', session: 'agy-1', at: at - 5000 }, rows, taken), false)
})
