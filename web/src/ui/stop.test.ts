// How "Stop" (ESC) looks (HANDOFF hole 1 / the agent side is routes/interrupt.ts).
//
// ⚠️⚠️ **Do not write the show/hide decision in two places.** Same reason notifications disagreed in 65 of 96
//    combinations (`resolveStatus` → `statusLabel`). This is the only decision.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { stopSentNote, stopView, STOP_SENT_NOTE } from './stop.ts'
import type { SessionStatus, SessionSummary } from '../../../shared/types.ts'

const base: SessionSummary = {
  machine: 'm',
  account: '.claude-r',
  sessionId: 's1',
  cwd: '/home/x/p',
  project: 'p',
  title: 't',
  titleSource: 'fallback',
  status: 'working',
  live: true,
  lastActivity: '2026-08-24T00:00:00.000Z',
  transcriptBytes: 10,
}

test('★ shown for running sessions', () => {
  const v = stopView({ ...base, sendRoute: 'keys' }, 'ready')
  assert.equal(v.show, true)
  assert.equal(v.disabled, false)
  assert.ok(v.label.includes('止める'), v.label)
})

test('★★ not shown for sessions missing from the list / not running (no pressable-but-inert buttons)', () => {
  assert.equal(stopView(undefined, 'ready').show, false)
  assert.equal(stopView({ ...base, live: false, sendRoute: 'keys' }, 'ready').show, false)
})

test('★★ not hidden based on state (busy or not)', () => {
  // ⚠️⚠️ The list's state comes from the transcript and **lags**. Hiding the button in a moment when
  //    it does not look busy means **you cannot press it when you most want to stop**. ⇒ Show whenever alive.
  //    The agent does the refusing (approval card, dialog).
  // ★ Try every state (★ uses the same type as the list decision, so a new state fails the type check)
  const all: SessionStatus[] = [
    'working',
    'background',
    'waiting',
    'error',
    'done',
    'idle',
    'rate-limited',
    'unknown',
  ]
  for (const status of all) {
    assert.equal(
      stopView({ ...base, status, sendRoute: 'keys' }, 'ready').show,
      true,
      `hidden at status=${status}`,
    )
  }
})

test('★★ cannot be pressed while sending (ESC twice opens the "go back" screen)', () => {
  const v = stopView({ ...base, sendRoute: 'keys' }, 'sending')
  assert.equal(v.show, true)
  assert.equal(v.disabled, true, '⚠️⚠️ can be tapped repeatedly (ESC sent twice)')
  assert.notEqual(
    v.label,
    stopView({ ...base, sendRoute: 'keys' }, 'ready').label,
    'appearance does not change after pressing',
  )
})

test('★ the sent notice does not promise that it stopped', () => {
  // ⚠️ We only know it arrived (same as `InterruptResult`).
  //    Saying "Stopped" would be a lie when it did not stop.
  assert.ok(STOP_SENT_NOTE.length > 0)
  assert.ok(!/止めました/.test(STOP_SENT_NOTE), STOP_SENT_NOTE)
  assert.ok(/もう一度/.test(STOP_SENT_NOTE), 'no next step for when it does not stop')
})

test('★★ the screen goes through transport (discipline 2); the button calls interrupt', () => {
  // ⚠️ If this is not wired, it becomes "press and nothing happens" (invisible to types)
  const thread = readFileSync(new URL('./Thread.tsx', import.meta.url), 'utf8')
  assert.match(thread, /transport\.interrupt\(sessionId\)/, 'Thread does not call interrupt')
  assert.match(thread, /stopView\(/, 'Thread hand-rolls the show/hide decision')
  // ★ 2026-09-15: the `Transport` implementation moved to `agent.ts` (routes are swapped via `Wire`)
  const http = readFileSync(new URL('../transport/agent.ts', import.meta.url), 'utf8')
  assert.match(http, /\/interrupt/, 'transport has no interrupt implementation')
  // ⚠️⚠️ **It must be POST** (GET does not pass the CSRF check = a link could stop it)
  assert.match(http, /this\.post<InterruptResult>/, 'interrupt is not POST')
  // ⚠️ No body is passed (bytes sent are fixed in the agent's table; must not be selectable from the screen)
  //
  // ⚠️⚠️ **Do not scan from `interrupt(` to end of file** (hit on 2026-09-08).
  //    It used to look at `http.slice(http.indexOf('interrupt('))`, so it matched **an unrelated
  //    method added later** (`revokeDevice(key: string)`) and failed = the watch was too broad.
  //    ⇒ Extract **only that function's body**. ★ Also assert that it was extracted
  //      (if the landmark changes it would "check nothing" and go silently green / VERIFY "my recurring mistakes").
  const body = /\n  interrupt\([\s\S]*?\n  \}/.exec(http)?.[0] ?? ''
  assert.ok(body.length > 40, 'could not extract the interrupt body (the scan is broken)')
  assert.equal(/\bkey\b/.test(body), false, '⚠️⚠️ the screen specifies a key')
  // ★ Check that this assertion really bites (no false green)
  assert.equal(/\bkey\b/.test(body.replace('sessionId: string', 'key: string')), true)
})

test('★★ not shown for old agents\' sessions (pressing would 404)', () => {
  // ⚠️⚠️ Old and new coexist for a period (one machine is kept on the old version for comparison).
  //    Old agents lack `POST /sessions/:id/interrupt`, so it **404s**.
  //    ⇒ Do not make "a button that does nothing".
  // ★ How to tell: **alive but no `sendRoute`** = that agent does not return the mark
  //    = this version is not installed (dead sessions get no mark even on a new agent).
  assert.equal(stopView({ ...base, sendRoute: undefined }, 'ready').show, false)
  // ★ Conversely: with a mark (keys or inbox), show it
  assert.equal(stopView({ ...base, sendRoute: 'keys' }, 'ready').show, true)
  assert.equal(stopView({ ...base, sendRoute: 'inbox', keysReason: 'no-relay' }, 'ready').show, true)
})

test('★★ when the input box was cleared too, say so and say how to restore it (Ctrl+Y) (2026-09-24)', () => {
  const cleared = stopSentNote(true)
  assert.match(cleared, /入力欄も消しました/)
  assert.match(cleared, /Ctrl\+Y/, '⚠️ PC text in progress is cleared too, but it does not say how to restore')
  assert.doesNotMatch(stopSentNote(), /入力欄/, '⚠️ says "cleared" although it did not (old agent)')
})
