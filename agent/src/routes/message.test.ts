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
  // Keystrokes were merely unavailable → inbox (a frame is added, but it arrives)
  // ⚠️ `slash` / `bang` were **removed from the type** (2026-08-24). Instead of refusing, they are neutralized
  //    with one space and passed via keystrokes, so **nothing falls back to the inbox because of its content**
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
  assert.equal(checked, 11, 'if reasons are added/removed, fix this count together with the table')
})

test('★★ decideAfterKeys: only partial never falls back to the inbox (it would arrive twice)', () => {
  assert.deepEqual(decideAfterKeys('partial'), { kind: 'error', status: 500 })
  // The opposite side too, just in case: if it could not connect (not a single byte written), falling back is fine
  assert.deepEqual(decideAfterKeys('unreachable'), { kind: 'fallback' })
})

test('decideAfterKeys: with no reason (called after keystrokes succeeded) it falls back', () => {
  assert.deepEqual(decideAfterKeys(undefined), { kind: 'fallback' })
})

test('★★★ no path falls back to the inbox because of content (`/` `!` are neutralized and sent as keystrokes)', () => {
  // ⚠️⚠️ The inbox does more than "add a frame": the receiving model **executes it as a peer request**
  //    (measured: a `/tes` that fell there ran `make test`). ⇒ Content-based fallback was removed.
  // ★ `slash` / `bang` were removed from the type, so **writing them in the table fails the type check**.
  //   Here the table contents pin down that "the only reasons to fall back are route constraints".
  const contentReasons = Object.keys(EXPECTED).filter((r) => r === 'empty' || r === 'too-long')
  assert.deepEqual(contentReasons.sort(), ['empty', 'too-long'])
  for (const r of contentReasons as ('empty' | 'too-long')[]) {
    assert.equal(decideAfterKeys(r).kind, 'error', `${r} must not fall back to the inbox`)
  }
})

test('★★★ a body starting with `/` or `!` is never handed to the inbox, even when the route fails (codex 2026-08-24, high #2)', () => {
  // ⚠️⚠️ **My fix only worked on one of the paths**. Keystrokes were changed to "neutralize with one space",
  //    but **when keystrokes failed for route reasons** (`no-relay` / `waiting` /
  //    `pending-approval` / `unreachable`), `decideAfterKeys` fell back to the inbox,
  //    and **the original text** went there. ⇒ The accident of the receiving model executing it remained
  //    (measured: a `/tes` that fell into the inbox ran `make test`).
  // ⚠️ Prepending a space and sending to the inbox is **not OK** (the space only disables the CLI's command parsing;
  //    **the model's interpretation remains**). ⇒ Refuse instead of falling back.
  for (const text of ['/tes', '!ls', '  /compact', '\u200b/help']) {
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
  assert.match(code, /sanitizeForKeys\(/, 'the neutralization check is hand-rolled')
  assert.ok(!/startsWith\('\/'\)/.test(code), "⚠️ the leading-character check is hand-rolled")
})
