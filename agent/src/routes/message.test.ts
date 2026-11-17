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
import { codexMessage, decideAfterKeys, inboxRefusal, type RouteDecision } from './message.ts'
import { HttpError } from '../router.ts'
import type { CodexSendResult } from '../codex/daemon.ts'
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
  // ★ A long text the relay cannot take as a paste yet: said so (restart claude), not sent another way
  'long-needs-paste': { kind: 'error', status: 409 },
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
  assert.equal(checked, 13, 'if reasons are added/removed, fix this count together with the table')
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

// ── Codex threads (docs/CODEX.md §5.2) ──

function codexWorld(...given: [(CodexSendResult | undefined)?]) {
  // ⚠️ `undefined` passed on purpose is a result too (a default parameter would swallow it)
  const result: CodexSendResult | undefined = given.length > 0 ? given[0] : { ok: true }
  const sent: Array<[string, string]> = []
  return {
    sent,
    codex: {
      lists: (id: string) => id === 'thread-1',
      send: async (id: string, text: string) => {
        sent.push([id, text])
        return result
      },
    },
  }
}

async function status(run: Promise<unknown>): Promise<number | 'ok'> {
  try {
    await run
    return 'ok'
  } catch (err) {
    assert.ok(err instanceof HttpError)
    return err.status
  }
}

test('codex: an id that is not a Codex row is not ours (undefined), and the daemon is never asked', async () => {
  const w = codexWorld()
  assert.equal(await codexMessage('some-claude-session', 'hi', w.codex), undefined)
  // ⚠️ Even with a bad body: the Claude routes give their own answer for it
  assert.equal(await codexMessage('some-claude-session', '', w.codex), undefined)
  assert.deepEqual(w.sent, [])
})

test('★ codex: a Codex row id that is not listed now is "not open" (409), never handed to the Claude routes', async () => {
  const w = codexWorld()
  assert.equal(await status(codexMessage('codex-0123abcd0123abcd-01a1d8d9-66fc-7823-968f-c97d7234176e', 'hi', w.codex)), 409)
  assert.deepEqual(w.sent, [])
})

test('★ codex: the text goes to the daemon as it is, and the reply names the shape the phone will see', async () => {
  const w = codexWorld()
  const res = await codexMessage('thread-1', 'fix the  test\nplease ', w.codex)
  assert.deepEqual(w.sent, [['thread-1', 'fix the  test\nplease ']])
  assert.equal(res?.ok, true)
  // ⚠️ `keys`: a plain message without `via` (what `pending.ts` matches the sent bubble against)
  assert.equal(res?.route, 'keys')
})

test('★ codex: an empty, too long, or `/` `!` body is refused with 400 before the daemon is asked', async () => {
  for (const body of ['', '   ', 'x'.repeat(200_000), '/compact', '!ls', ' /exit']) {
    const w = codexWorld()
    assert.equal(await status(codexMessage('thread-1', body, w.codex)), 400, JSON.stringify(body.slice(0, 12)))
    assert.deepEqual(w.sent, [])
  }
})

test('codex: busy, gone, and refused by the daemon are 409 (the state of the other side), never a fall-through', async () => {
  for (const r of [
    { ok: false, reason: 'busy' },
    { ok: false, reason: 'not-listed' },
    { ok: false, reason: 'failed', detail: 'error -32600' },
    // The row vanished between the look and the send
    undefined,
  ] as Array<CodexSendResult | undefined>) {
    assert.equal(await status(codexMessage('thread-1', 'hi', codexWorld(r).codex)), 409, JSON.stringify(r))
  }
})
