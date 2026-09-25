// ★ Mark each list row with "how a message from the phone would be delivered" (the per-session marker in HANDOFF).
//
// ⚠️⚠️ **No decision is made here**. It copies the answer of `scanPanes` (the same function that finds keystroke destinations) **as is**.
//    Inventing "probably keystroke-able" here would bring back the same disagreement (6 combinations)
//    as when `npm run keys` had its own independent implementation.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { markSend } from './sessions.ts'
import type { PaneScan } from '../claude/keys.ts'
import type { SessionSummary } from '../../../shared/types.ts'

const base: SessionSummary = {
  machine: 'm',
  account: '.claude-r',
  sessionId: 's1',
  cwd: '/home/x/p',
  project: 'p',
  title: 't',
  titleSource: 'fallback',
  status: 'idle',
  live: true,
  lastActivity: '2026-08-24T00:00:00.000Z',
  transcriptBytes: 1,
}

const scanOf = (
  entries: [string, { reason: 'no-relay' } | { sessionId: string; pid: number; socketPath: string }][],
  skipped = 0,
): PaneScan => ({ bySession: new Map(entries), skipped })

test('★ a session that accepts keystrokes is keys (no reason attached)', () => {
  const scan = scanOf([['s1', { sessionId: 's1', pid: 1, socketPath: '/tmp/a.sock' }]])
  const [s] = markSend([base], scan)
  assert.equal(s?.sendRoute, 'keys')
  assert.equal(s?.keysReason, undefined, 'a reason is attached although keystrokes work')
})

test('★★ a session that cannot accept keystrokes is inbox + a reason (so the UI can explain)', () => {
  const [s] = markSend([base], scanOf([['s1', { reason: 'no-relay' }]]))
  assert.equal(s?.sendRoute, 'inbox')
  assert.equal(s?.keysReason, 'no-relay')
})

test('★★★ sessions that are not alive get no marker (do not talk about routes for something you cannot send to)', () => {
  const dead = { ...base, live: false }
  const [s] = markSend([dead], scanOf([['s1', { reason: 'no-relay' }]]))
  assert.equal(s?.sendRoute, undefined)
  assert.equal(s?.keysReason, undefined)
})

test('★★★ a session missing from the scan is not called "keystroke-able" (fail-closed)', () => {
  // ⚠️⚠️ This is exactly the trap hit in `npm run keys` (it showed ✅ for everything when there were 0 items).
  //    Not in the scan = unknown ⇒ fall to **the side that adds a frame**
  const [s] = markSend([base], scanOf([]))
  assert.equal(s?.sendRoute, 'inbox')
  assert.equal(s?.keysReason, 'not-found')
})

test('★★ when the index could not be read, do not conclude it is "absent"', () => {
  const [s] = markSend([base], scanOf([], 2))
  assert.equal(s?.sendRoute, 'inbox')
  assert.equal(s?.keysReason, 'unverified', '⚠️ made it not-found although it merely could not be read')
})

test('★ does not break the original list (other fields unchanged)', () => {
  const [s] = markSend([base], scanOf([['s1', { reason: 'no-relay' }]]))
  assert.equal(s?.title, 't')
  assert.equal(s?.status, 'idle')
  assert.equal(base.sendRoute, undefined, '⚠️ mutates the original array')
})
