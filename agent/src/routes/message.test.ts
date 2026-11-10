// Fallback from keystrokes → inbox (§9.7.2).
//
// ★★ Only one thing to guard here: **never fall back to the inbox on `partial`**.
//    If a part-typed instruction arrives again via the inbox, **the same instruction runs twice**.
//
// ★ Why the table is a `Record<KeysFailure, …>`: **a new reason fails the type check**.
//   (lesson from writing the notification decision in two places, where 65 of 96 combinations disagreed / HANDOFF 5.0-o)

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { decideAfterKeys, inboxRefusal, type RouteDecision } from './message.ts'
import type { KeysFailure } from '../claude/keys.ts'

/**
 * ⚠️ **List every reason**. Anything added to `KeysFailure` but not written here **fails the type check**.
 */
const EXPECTED: Record<KeysFailure, RouteDecision> = {
  // ⚠️⚠️ Must not fall back
  partial: { kind: 'error', status: 500 },
  // The body is bad = same result in the inbox
  empty: { kind: 'error', status: 400 },
  'too-long': { kind: 'error', status: 400 },
  // ⚠️⚠️ Starts with `/` `!` (2026-11-10): refused. The inbox is worse (the receiving model runs it)
  'command-like': { kind: 'error', status: 400 },
  // Keystrokes were merely unavailable → inbox (a frame is added, but it arrives)
  'pending-approval': { kind: 'fallback' },
  // ★ Also to the inbox while a dialog is open (keystrokes would become key input; the inbox does not)
  waiting: { kind: 'fallback' },
  'not-found': { kind: 'fallback' },
  'no-relay': { kind: 'fallback' },
  broken: { kind: 'fallback' },
  unverified: { kind: 'fallback' },
  ambiguous: { kind: 'fallback' },
  unreachable: { kind: 'fallback' },
}

test('★★ decideAfterKeys: pin every reason exhaustively', () => {
  let checked = 0
  for (const [reason, want] of Object.entries(EXPECTED) as [KeysFailure, RouteDecision][]) {
    assert.deepEqual(decideAfterKeys(reason), want, `fallback for reason ${reason} changed`)
    checked += 1
  }
  // ★ Prevents "green with an empty table" (same trap as notify:check's `0 / 0`)
  assert.equal(checked, 12, 'if reasons are added/removed, fix this count together with the table')
})

test('★★ decideAfterKeys: only partial never falls back to the inbox (it would arrive twice)', () => {
  assert.deepEqual(decideAfterKeys('partial'), { kind: 'error', status: 500 })
  // The opposite side too, just in case: if it could not connect (not a single byte written), falling back is fine
  assert.deepEqual(decideAfterKeys('unreachable'), { kind: 'fallback' })
})

test('decideAfterKeys: with no reason (called after keystrokes succeeded) it falls back', () => {
  assert.deepEqual(decideAfterKeys(undefined), { kind: 'fallback' })
})

test('★★★ no path falls back to the inbox because of content', () => {
  // ⚠️⚠️ The inbox does more than "add a frame": the receiving model **executes it as a peer request**
  //    (measured: a `/tes` that fell there ran `make test`). ⇒ Every content reason is an error.
  const contentReasons = ['empty', 'too-long', 'command-like'] as const
  for (const r of contentReasons) {
    assert.equal(decideAfterKeys(r).kind, 'error', `${r} must not fall back to the inbox`)
  }
})

test('★★★ a body starting with `/` or `!` is never handed to the inbox, even when the route fails (codex 2026-08-24, high #2)', () => {
  // ⚠️⚠️ Keystrokes can fail for route reasons **before the body is looked at** (`pending-approval` is
  //    checked first), and then `decideAfterKeys` falls back to the inbox with **the original text**.
  //    ⇒ The receiving model executed it (measured: a `/tes` that fell into the inbox ran `make test`).
  for (const text of ['/tes', '!ls', '  /compact', '\u200b/help', '\u3164/exit']) {
    assert.equal(inboxRefusal(text), true, `would hand it to the inbox: ${JSON.stringify(text)}`)
  }
  // ★ Ordinary sentences may still fall back to the inbox as before (better than not arriving)
  for (const text of ['状況を教えて', 'a/b を直して', 'これを見て\n/tmp のこと']) {
    assert.equal(inboxRefusal(text), false, `refuses it: ${JSON.stringify(text)}`)
  }
})

test('★★ the decision goes through `sanitizeForKeys` (do not write the leading-character check in two places)', () => {
  // ⚠️ Writing a custom `startsWith('/')` here would make invisible-character handling disagree inside the agent
  //    (`​/help` actually slipped through). ⇒ Use the same function's answer
  const src = readFileSync(new URL('./message.ts', import.meta.url), 'utf8')
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n')
  assert.match(code, /sanitizeForKeys\(/, 'the leading-character check is hand-rolled')
  assert.ok(!/startsWith\('\/'\)/.test(code), "⚠️ the leading-character check is hand-rolled")
})
