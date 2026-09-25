import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  armStale,
  isConfirmedWait,
  showStale,
  CONFIRMED_WAIT_TTL_MS,
  NO_ANSWERABLE_GRACE_MS,
  shouldShowNoAnswerable,
} from './staleNotice.ts'

test('★★ not shown right after answering (a lie showed for 4–5 s on a real device)', () => {
  const t0 = 1_000_000
  assert.equal(shouldShowNoAnswerable(true, t0, t0), false, 'not shown at the moment it starts')
  assert.equal(shouldShowNoAnswerable(true, t0, t0 + 3000), false, 'not shown even at 3 s')
})

test('★★ always shown once the grace period ends (never silently hide an approval that truly cannot be answered)', () => {
  // ⚠️ If this stays false, **you never notice there is no way to answer** after e.g. an agent restart.
  //    This warning's job is "tell you where to answer", so it must not be suppressed
  const t0 = 1_000_000
  assert.equal(shouldShowNoAnswerable(true, t0, t0 + NO_ANSWERABLE_GRACE_MS + 1), true)
  assert.equal(shouldShowNoAnswerable(true, t0, t0 + 60_000), true)
})

test('not shown if an answerable mark exists / not waiting for approval', () => {
  const t0 = 1_000_000
  assert.equal(shouldShowNoAnswerable(false, t0, t0 + 60_000), false)
  // Not in that state (no time) ⇒ not shown
  assert.equal(shouldShowNoAnswerable(true, null, t0 + 60_000), false)
})

// ── ★★ Resetting the grace period (2026-08-18 `/code-review`, medium #1, #2, low #3)

const t0 = 1_000_000

test('★★ the grace period is recreated when the target changes (no verdict the instant you jump to another thread)', () => {
  // Grace period already over on A
  let g = armStale({ key: '', since: null }, 'A', true, t0)
  assert.equal(showStale(true, g, t0 + NO_ANSWERABLE_GRACE_MS + 1, false), true, 'precondition: shown on A')
  // ⚠️ Jump to B. Without recreating here, **B's first render gives the verdict immediately**
  g = armStale(g, 'B', true, t0 + 10_000)
  assert.equal(g.since, t0 + 10_000, 'counts again from the time of the jump')
  assert.equal(showStale(true, g, t0 + 10_000, false), false, 'not shown on B yet')
  assert.equal(showStale(true, g, t0 + 10_000 + NO_ANSWERABLE_GRACE_MS + 1, false), true)
})

test('★ same target ⇒ no recount (a shown warning does not flicker)', () => {
  const g1 = armStale({ key: '', since: null }, 'A', true, t0)
  const g2 = armStale(g1, 'A', true, t0 + 5000)
  assert.equal(g2.since, t0, 'keeps the time it first started')
  assert.equal(g2, g1, 'returns the same object (no needless re-render)')
})

test('★ when the state goes away the grace period goes too (can count again next time)', () => {
  const g1 = armStale({ key: '', since: null }, 'A', true, t0)
  const g2 = armStale(g1, 'A', false, t0 + 1000)
  assert.equal(g2.since, null)
  const g3 = armStale(g2, 'A', true, t0 + 2000)
  assert.equal(g3.since, t0 + 2000, 'counts from the start again')
})

test('★★ no wait when arriving with information that already passed the grace period (jumped from the bar\'s second line)', () => {
  // ⚠️ The grey line waited 6 s over there before showing. Waiting again here means
  //    the person who pressed it sees **a screen with no reason for 6–9 s**
  const g = armStale({ key: '', since: null }, 'B', true, t0)
  assert.equal(showStale(true, g, t0, false), false, 'normally waits')
  assert.equal(showStale(true, g, t0, true), true, 'shows immediately when arriving with passed information')
})

test('★★ without the state itself, not shown even if told it already passed', () => {
  // ⚠️ If this loosens, "Please answer on the PC" shows while an answerable mark exists
  const g = armStale({ key: '', since: null }, 'B', false, t0)
  assert.equal(showStale(false, g, t0 + 999_999, true), false)
})

test('★★ the "jumped from grey" mark is valid only right after the press (does not apply to the next wait)', () => {
  // ⚠️⚠️ codex's repro (medium #1): jump from grey to B → B's wait clears →
  //    **a new approval in the same B** is answered on the phone → the mark goes but `waiting` remains →
  //    if the mark is alive, **it skips the grace period and lies immediately** (exactly the lie of 2026-08-14).
  const mark = { sessionId: 'B', at: t0 }
  assert.equal(isConfirmedWait(mark, 'B', t0), true, 'valid right after the press')
  assert.equal(isConfirmedWait(mark, 'B', t0 + CONFIRMED_WAIT_TTL_MS - 1), true)
  // ★ After the grace period the result is the same without the mark, so discarding it costs nothing
  assert.equal(isConfirmedWait(mark, 'B', t0 + CONFIRMED_WAIT_TTL_MS), false, 'lifetime expires')
  assert.equal(isConfirmedWait(mark, 'C', t0), false, 'does not apply to another thread')
  assert.equal(isConfirmedWait(null, 'B', t0), false)
})

test('★ the mark lives longer than the grace period (does not vanish and reappear at the moment it ends)', () => {
  assert.ok(CONFIRMED_WAIT_TTL_MS > NO_ANSWERABLE_GRACE_MS)
})
