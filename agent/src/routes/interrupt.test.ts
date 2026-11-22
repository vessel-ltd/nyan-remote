// ★★ The "stop" endpoint (`POST /sessions/:id/interrupt`).
//
// ⚠️⚠️ Three things are guarded here. **All by structure** (not relying on runtime branches):
//
//   1. **Never fall back to the inbox** (does not import `inbox` = there is no path to fall back).
//      Falling back would put "stop" **into the conversation as an instruction** (it would not stop, and would pollute the context)
//   2. **Never read the body** (does not call `readJsonBody` = the phone cannot choose bytes.
//      Same reason approvals never accept `updatedInput`)
//   3. The failure category → HTTP mapping is pinned by an **exhaustive table** (a new reason fails the type check)

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { INTERRUPT_STATUS, sessionClear, sessionInterrupt } from './interrupt.ts'
import { controlMessage } from '../claude/keys.ts'
import type { ControlFailure } from '../claude/keys.ts'
import { buildRouter } from './index.ts'

const SRC = readFileSync(new URL('./interrupt.ts', import.meta.url), 'utf8')

/**
 * ★ **Strip comments before checking** (I tripped on this myself on 2026-08-24).
 *
 * ⚠️ Checking "does not know the inbox" with a plain string search **matches the explanation
 *    "never fall back to the inbox" itself** and turns red. ⇒ What we want to check is **code**, so
 *    strip line and block comments before searching.
 * ⚠️ This endpoint has no strings containing `//` (URLs etc.), so trailing comments can be stripped simply.
 */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((l) => l.replace(/\/\/.*$/, ''))
  .join('\n')

/** ⚠️ **List every reason**. Anything added to `ControlFailure` but missing here **fails the type check** */
const EXPECTED: Record<ControlFailure, number> = {
  // The other side's state (wait / look at the PC)
  'pending-approval': 409,
  waiting: 409,
  'no-relay': 409,
  broken: 409,
  unverified: 409,
  ambiguous: 409,
  // Rapid repeats (ESC twice is a different operation)
  'too-soon': 429,
  // That session no longer exists
  'not-found': 404,
  // The relay (window) does not respond
  unreachable: 502,
}

test('★★ INTERRUPT_STATUS: pin every failure category exhaustively', () => {
  let checked = 0
  for (const [reason, want] of Object.entries(EXPECTED) as [ControlFailure, number][]) {
    assert.equal(INTERRUPT_STATUS[reason], want, `handling of reason ${reason} changed`)
    checked += 1
  }
  // ★ Prevents "green with an empty table" (same trap as notify:check's `0 / 0`)
  assert.equal(checked, 9, 'if reasons are added/removed, fix this count together with the table')
  assert.equal(Object.keys(INTERRUPT_STATUS).length, 9)
})

test('★★★ the endpoint does not know the inbox (a failure never arrives as an instruction)', () => {
  assert.ok(
    !/inbox/i.test(CODE),
    '⚠️⚠️ the "stop" endpoint references the inbox (meant to stop, it would arrive as an instruction)',
  )
  assert.ok(!/sendToSession/.test(CODE), '⚠️⚠️ it calls the inbox send')
  assert.ok(!/decideAfterKeys/.test(CODE), '⚠️ it reuses the keystroke fallback (to the inbox)')
})

test('★★★ the endpoint never reads the body (the phone cannot choose bytes)', () => {
  assert.ok(
    !/readJsonBody/.test(CODE),
    '⚠️⚠️ it reads the body (the bytes sent must not be specifiable from the UI)',
  )
  // ★ What is sent comes from the table (no bytes are written here)
  // ★ 2026-09-24: "stop" is `sendStopToSession` (sends ESC and Ctrl-U from the table in keys.ts)
  assert.ok(/CONTROL_KEYS|'escape'|sendStopToSession/.test(CODE), 'cannot tell where the sent key comes from')
  assert.ok(!/\\x1b|\\u001b/.test(CODE), '⚠️ bytes are written directly in the endpoint (keep them in the one table)')
})

test('★ POST /sessions/:id/interrupt is registered and the id is decoded', () => {
  const r = buildRouter()
  const m = r.match('POST', '/sessions/S%201%2F2/interrupt')
  assert.ok(m, 'no route (cannot stop from the phone)')
  assert.equal(m?.params['id'], 'S 1/2')
})

test('★★ stopping is POST only (a GET with side effects bypasses the CSRF check)', () => {
  // ⚠️ The CSRF check in auth.ts only looks at "unsafe methods".
  //    If ESC could be sent over GET, **merely getting someone to follow a link could stop another person's session**
  assert.equal(buildRouter().match('GET', '/sessions/x/interrupt'), null)
})

test('★★ messages for why it could not stop (exhaustive)', () => {
  // ⚠️ Reusing the keystroke (text endpoint) wording gives **sentences that are not about stopping**
  //    (`no-relay` saying "this session cannot receive keystrokes" = you cannot tell what was asked).
  // ⚠️ Internal terms (keystrokes / relay / pane / the ESC byte) must not appear on screen.
  let checked = 0
  for (const reason of Object.keys(EXPECTED) as ControlFailure[]) {
    const text = controlMessage(reason)
    assert.ok(text.length > 0, `message for ${reason} is empty`)
    assert.ok(!/打鍵|pane|socket/.test(text), `${reason}: exposes an internal term: ${text}`)
    // ★ It is the reply to a "stop" request, so it must read that way
    assert.ok(/止め|待っ|開いて|見つかりません|応答|確かめ|複数/.test(text), `${reason}: ${text}`)
    checked += 1
  }
  assert.equal(checked, 9)
})

test('★★★ the registered endpoint really is `sessionInterrupt` (rejects swapped wiring)', () => {
  // ⚠️⚠️ The mutation codex named on 2026-08-24: swapping the wiring to `sessionMessage` kept
  //    **every test green** (the endpoint tests called the imported function directly, and the route tests
  //    only looked at paths and params). ⇒ Look at **the function actually registered**.
  //    If it were `sessionMessage`, `POST /interrupt` would turn into **an endpoint that reads the body**.
  const m = buildRouter().match('POST', '/sessions/x/interrupt')
  assert.ok(m)
  assert.equal(m?.handler, sessionInterrupt, '⚠️⚠️ a different endpoint is wired in')
})

test('★★★ the clear-input endpoint also never reads the body / does not know the inbox / is POST only', () => {
  // ⚠️⚠️ Bundling endpoints into one and passing `key` in the body would make "an endpoint that can fire anything in the table".
  //    ⇒ The key sent is **fixed inside the handler** (it must literally say `'clear'`).
  assert.ok(/sendControlToSession\(dirs, sessionId, 'clear'/.test(CODE), 'clear is not fixed')
  assert.ok(!/readJsonBody/.test(CODE), '⚠️⚠️ it reads the body')
  assert.ok(!/inbox/i.test(CODE), '⚠️⚠️ it references the inbox')
  assert.ok(!/\\x15|\\u0015/.test(CODE), '⚠️ bytes are written directly in the endpoint (keep them in the one table)')
  const router = buildRouter()
  assert.ok(router.match('POST', '/sessions/x/clear'), 'POST is not registered')
  // ⚠️ With GET, merely getting someone to follow a link could erase another person's draft
  assert.equal(router.match('GET', '/sessions/x/clear'), null, 'also registered for GET')
  assert.equal(typeof sessionClear, 'function')
})
