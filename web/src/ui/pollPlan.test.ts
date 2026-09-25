import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isPollDue, notePoll, POLL_FAST_MS, POLL_MAX_BACKOFF_MS, POLL_SLOW_MS, POLL_TICK_MS, pollInterval } from './pollPlan.ts'

test('★★ 60 s when the signal line is alive, 15 s when it is not', () => {
  assert.equal(pollInterval(true, 0), POLL_SLOW_MS)
  assert.equal(pollInterval(false, 0), POLL_FAST_MS)
})

test('★★ back off on repeated failures (30 s→1 min→2 min→4 min→capped at 5 min), reset on success', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((f) => pollInterval(false, f)), [30_000, 60_000, 120_000, 240_000, 300_000, 300_000])
  // ⚠️ Even with a live line, failing means backing off takes priority
  assert.equal(pollInterval(true, 3), 120_000)
  assert.equal(POLL_MAX_BACKOFF_MS, 300_000)
  let s = notePoll(undefined, false, 0)
  s = notePoll(s, false, 1)
  assert.equal(s.failures, 2)
  s = notePoll(s, true, 2)
  assert.deepEqual(s, { lastAt: 2, failures: 0, partial: false }, '⚠️ success did not reset the failure count (interval stays wide)')
})

test('★★ is it time: immediately if never fetched, and once the interval has passed', () => {
  assert.equal(isPollDue(undefined, true, 0), true)
  assert.equal(isPollDue({ failures: 0 }, true, 0), true)
  assert.equal(isPollDue({ lastAt: 0, failures: 0 }, true, 45_000), false)
  assert.equal(isPollDue({ lastAt: 0, failures: 0 }, true, 60_000), true)
  assert.equal(isPollDue({ lastAt: 0, failures: 0 }, false, 15_000), true)
  assert.equal(isPollDue({ lastAt: 0, failures: 5 }, false, 285_000), false)
  assert.equal(isPollDue({ lastAt: 0, failures: 5 }, false, 300_000), true)
})

test('★★ clock jitter does not delay by a tick (a tick at 14,998 ms still counts as 15 s)', () => {
  assert.equal(isPollDue({ lastAt: 0, failures: 0 }, false, 14_998), true)
  assert.equal(isPollDue({ lastAt: 0, failures: 0 }, true, 59_990), true)
  // ⚠️ But one tick earlier (45 s) is not due (the slack does not eat a whole tick)
  assert.equal(isPollDue({ lastAt: 0, failures: 0 }, true, 60_000 - POLL_TICK_MS), false)
})

test('★ every interval is a multiple of the tick (an off-tick interval slips by one tick each time)', () => {
  for (const live of [true, false]) {
    for (let f = 0; f < 8; f++) assert.equal(pollInterval(live, f) % POLL_TICK_MS, 0, `${live} ${f}`)
  }
})

test('★★ if only approvals failed, re-fetch in 15 s even with a live signal, and do not count it as a failure (codex round 17, medium #3)', () => {
  const s = notePoll({ lastAt: 0, failures: 2 }, true, 100, { partial: true })
  assert.deepEqual(s, { lastAt: 100, failures: 0, partial: true })
  assert.equal(isPollDue(s, true, 100 + POLL_FAST_MS), true, '⚠️⚠️ waits 60 s with empty approvals')
  assert.equal(pollInterval(true, 0, true), POLL_FAST_MS)
  // ⚠️ Once everything is fetched next time, it goes back
  assert.equal(notePoll(s, true, 200).partial, false)
  // ⚠️ On failure, partial is not carried over (the failure interval takes priority)
  assert.equal(notePoll(s, false, 300, { partial: true }).partial, false)
})
