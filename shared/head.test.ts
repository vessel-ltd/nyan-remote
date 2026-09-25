// ★ How "the start of the body" is judged (the agent and the UI share one function / codex 2026-08-24, high #1 and low #2).
//
// ⚠️ Never write raw control or invisible characters in source (invisible to the eye, and git treats the file as binary).
//    Always write them as `\u` escapes.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { looksLikeCommand, visibleHead } from './types.ts'

/** ⚠️ Include every "not stripped" character codex named (hand lists miss things, so select by property) */
const INVISIBLE = [
  ' ', // ASCII space
  '\u0009', // tab
  '\u000a', // newline
  '\u00a0', // NBSP
  '­', // SHY (flagged by codex)
  '؜', // ALM (flagged by codex)
  '\u180e', // MONGOLIAN VOWEL SEP
  '\u1680', // OGHAM SPACE
  '\u2028', // LINE SEP
  '\u2029', // PARAGRAPH SEP
  '\u200b', // ZWSP
  '\u200c', // ZWNJ
  '\u200d', // ZWJ
  '‎', // LRM (flagged by codex)
  '‏', // RLM (flagged by codex)
  '\u2060', // WORD JOINER
  '⁦', // LRI (flagged by codex)
  '⁩', // PDI (flagged by codex)
  '　', // ideographic (full-width) space
  '\u3164', // HANGUL FILLER
  '️', // variation selector (flagged by codex)
  '\ufeff', // BOM
  '\u{e0001}', // tag character (flagged by codex)
]

test('★★ strip every leading "invisible" character exhaustively (prevents gaps in hand lists)', () => {
  let checked = 0
  for (const p of INVISIBLE) {
    for (const body of ['/compact', '!ls'] as const) {
      assert.equal(visibleHead(`${p}${body}`), body, `not stripped: ${JSON.stringify(p)}`)
      assert.equal(looksLikeCommand(`${p}${body}`), body[0], JSON.stringify(p))
      checked += 1
    }
  }
  // ★ Check the count too, so zero cases does not turn green
  assert.equal(checked, INVISIBLE.length * 2)
  assert.ok(INVISIBLE.length >= 23, 'were characters removed from the list?')
})

test('★★ a control character placed first is not missed (even combined with invisible characters)', () => {
  for (const c of ['\u0001', '\u001b', '\u007f', '\u009b']) {
    assert.equal(looksLikeCommand(`${c}/compact`), '/', JSON.stringify(c))
    assert.equal(looksLikeCommand(`${c}\u200b\u2066/compact`), '/', JSON.stringify(c))
    assert.equal(looksLikeCommand(`${c}!ls`), '!', JSON.stringify(c))
  }
})

test('★ ordinary sentences are not affected (widening it breaks ordinary text)', () => {
  for (const ok of ['ふつうの文', 'a/b を直して', '／全角は文字', 'ok\n/clear', '「/」の話']) {
    assert.equal(looksLikeCommand(ok), null, ok)
  }
})

test('★ invisible characters inside the body are left alone (never removed silently)', () => {
  assert.equal(visibleHead('あ\u200bい'), 'あ\u200bい')
})

test('★★ CR is not among the "stripped control characters" (converting it to a newline is handled elsewhere)', () => {
  // ⚠️ Stripping CR here would disagree with the "CR → newline" rule of `sanitizeForKeys` and join lines
  assert.equal(visibleHead('あ\r\nい'), 'あ\nい')
})

test('★★ `visibleHead` is **for judging only** (never used where legitimate input is rewritten)', () => {
  // ⚠️⚠️ Found by measuring it myself (2026-08-24): it strips `\p{Cf}` / `\p{M}`, so
  //    **the start of legitimate input changes too**:
  //      Arabic number sign U+0600 + Arabic / a leading combining mark /
  //      Devanagari vowel sign / Thai above-mark / hamza
  //    ⇒ but `looksLikeCommand` returns `null`, so **no rewriting happens**
  //      (neutralising only happens when the start is `/` or `!`). This pins that down.
  const legit = [
    '؀ال を見て', // Arabic number sign + Arabic
    '゙あいう', // leading combining mark (dakuten)
    'िहिन्दी', // Devanagari vowel sign
    'ัก', // Thai above-mark
  ]
  for (const t of legit) {
    assert.equal(looksLikeCommand(t), null, `treated as a command: ${JSON.stringify(t)}`)
    // ★ The judging-only `visibleHead` strips it, but **only for judging**
    assert.notEqual(visibleHead(t), t, `not stripped (judgement too loose): ${JSON.stringify(t)}`)
  }
})

test('★★ a leading combining mark + `/` is treated as "a command" (stripping is the safe side)', () => {
  // ⚠️ We cannot rule out the CLI ignoring that character and reading `/help` (cannot be measured).
  //    ⇒ Strip it and normalise to **the shape measured to be safe (one space + `/`)**.
  //    ⚠️ Cost: the leading combining mark disappears (such input does not happen in practice, so accepted).
  assert.equal(looksLikeCommand('\u3099/help'), '/')
  assert.equal(looksLikeCommand('\u0600!ls'), '!')
})
