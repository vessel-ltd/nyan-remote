import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cells, type Cell } from './previewCells.ts'

// ★★ Matching the diagram's columns to the terminal (2026-08-19; found a box-drawing box 8px off in a real browser).
//
// ⚠️ If this goes wrong, **the box we fixed breaks in a different way**. Pins "how many columns the terminal counts".

/** Column count in the terminal (chunks without a width count as 1 column per character) */
function width(line: string): number {
  return cells(line).reduce((n, c) => n + (c.wide ? 2 : [...c.text].length), 0)
}

test('★ ASCII-only lines produce no chunks (no extra elements)', () => {
  assert.deepEqual(cells('a -> b (400)'), [{ text: 'a -> b (400)' }])
})

test('★★ full-width is 2 columns (this was the cause of the breakage)', () => {
  assert.deepEqual(cells('入力'), [
    { text: '入', wide: true },
    { text: '力', wide: true },
  ])
  assert.equal(width('入力'), 4)
  // Kana, full-width alphanumerics, ideographic space, Hangul and CJK extensions too
  for (const s of ['あ', 'ア', 'Ａ', '　', '한', '𠀋']) {
    assert.equal(width(s), 2, `not 2 columns: ${s}`)
  }
})

test('★★ box-drawing characters and arrows are untouched (boxing them clipped the glyphs into dotted lines)', () => {
  // ⚠️ Measured (390px / Chromium): the advance of `─` `│` `→` is **exactly the same 1ch** as `0`.
  //    They were boxed for no reason and clipped by `overflow: hidden`, **making them dotted**
  assert.deepEqual(cells('─│┌┘'), [{ text: '─│┌┘' }])
  assert.deepEqual(cells('→←'), [{ text: '→←' }])
})

test('★★ a line mixing box-drawing and Japanese has the same column count as the terminal', () => {
  // The shape that broke on a real device. The frame and inner lines must have **the same column count** to align
  const top = '┌────────────┬──────────┐'
  const row = '│ 入力       │ 結果     │'
  assert.equal(width(top), 25)
  assert.equal(width(row), 25, 'inner line does not have the same column count as the frame')
})

test('★ emoji are 2 columns; U+FE0F joins the preceding character (splitting adds columns)', () => {
  assert.deepEqual(cells('🙂'), [{ text: '🙂', wide: true }])
  assert.deepEqual(cells('⚠️'), [{ text: '⚠️', wide: true }], 'the variation selector became a separate column')
  assert.equal(width('✅❌'), 4, 'common emoji are still 1 column')
  // Emoji joined by ZWJ are one chunk too (2 columns)
  assert.equal(cells('👩‍💻').length, 1)
  assert.equal(width('👩‍💻'), 2)
})

test('★ does not split surrogate pairs', () => {
  const c: Cell[] = cells('a𠀋b')
  assert.deepEqual(c, [{ text: 'a' }, { text: '𠀋', wide: true }, { text: 'b' }])
})

// ── ★★ Three cases found in the 2026-08-19 `/code-review` (all actually reproduced)

test('★★ NFD Japanese from mac broke the columns (combining marks were counted as 2 columns)', () => {
  // ⚠️ `'ガード'.normalize('NFD')` became **five 2-column chunks (width 10)**, disagreeing with the terminal's 6,
  //    and **the dakuten was drawn in its own column** (medium #2)
  const nfd = 'ガード'.normalize('NFD')
  assert.equal(nfd.length, 5, 'not NFD in this environment (the test itself is stale)')
  assert.equal(width(nfd), 6, 'combining marks add columns')
  assert.equal(cells(nfd).length, 3, 'the dakuten is a separate chunk (drawn in a different position)')
  // Must match the precomposed (NFC) form
  assert.equal(width('ガード'), 6)
})

test('★ an enclosing keycap is one chunk (the enclosing mark fell into the next chunk)', () => {
  assert.deepEqual(cells('1️⃣'), [{ text: '1️⃣', wide: true }], 'the enclosing mark is split off (low #4)')
})

test('★★ align the width table with the terminal (string-width) (it was off in both directions)', () => {
  // Full-width below 1F300 was **counted as 1 column**
  for (const s of ['🀄', '🃏', '🆎', '🆚', '🈁', '🈲']) {
    assert.equal(width(s), 2, `not 2 columns: ${s}`)
  }
  // Characters **drawn as text, not pictures** were counted as 2 columns (the whole plane was 2 columns)
  for (const s of ['👁', '🗺', '🌡', '🖼']) {
    assert.equal(width(s), 1, `not 1 column: ${s}`)
  }
  // ⚠️ But with U+FE0F they become pictures, 2 columns (caught first)
  assert.equal(width('👁️'), 2)
  // Characters drawn as pictures stay 2 columns
  for (const s of ['🙂', '🚀', '🧠']) {
    assert.equal(width(s), 2, `no longer 2 columns: ${s}`)
  }
})

// ── ★★ 2026-08-19 codex review, medium #3 (the width table and grapheme segmentation)

test('★★ grapheme segmentation is left to Intl.Segmenter (the hand-made version missed cases)', () => {
  // ⚠️ All of these actually reproduced
  assert.deepEqual(cells('葛󠄀'), [{ text: '葛󠄀', wide: true }], 'U+E0100 (Variation Selectors Supplement) became a separate column')
  assert.deepEqual(cells('🇯🇵'), [{ text: '🇯🇵', wide: true }], 'a flag (two regional indicators) is not a single column unit')
  assert.equal(width('👍🏽'), 2, 'skin-toned emoji is not 2 columns')
  assert.equal(width('1️⃣'), 2)
  assert.equal(width('👩‍💻'), 2)
})

test('★★ filled the East Asian Width gaps (it was off in both directions)', () => {
  // ⚠️ **Write code points.** A look-alike `〈` (U+3008) was pasted, so
  //    a mutant removing U+2329 **stayed green** (2026-08-19)
  assert.equal(width('〈'), 2, 'U+2329 is W (was missing)')
  assert.equal(width('〉'), 2, 'U+232A is W')
  assert.equal(width('〈'), 2, 'U+3008 (a different look-alike character) is also W')
  // ⚠️ **Ambiguous is 1 column** (matching the terminal's `string-width`)
  assert.equal(width('㉈'), 1, 'U+3248 is Ambiguous (it was 2 columns)')
  assert.equal(width('㉏'), 1, 'U+324F is Ambiguous too')
  assert.equal(width('㉇'), 2, 'just outside the boundary (U+3247) stays W')
  assert.equal(width('㉐'), 2, 'just outside the boundary (U+3250) stays W')
})

test('★ symbols not in the table are left to the font (no chunk = no column claim)', () => {
  // ⚠️ The part where we decided not to hold all of `Emoji_Presentation`. **Accepting that some characters stay misaligned**,
  //    this pins that it does not "claim 2 columns on its own"
  assert.deepEqual(cells('✂✎'), [{ text: '✂✎' }])
})

test('★ empty lines and empty strings', () => {
  assert.deepEqual(cells(''), [])
})

test('★ does not crash without Intl.Segmenter (columns may be off)', () => {
  // ⚠️ Actually verify "shifted columns beat crashing" (if the branch is kept, it must pass)
  const intl = Intl as { Segmenter?: typeof Intl.Segmenter }
  const real = intl.Segmenter
  delete intl.Segmenter
  try {
    assert.equal(width('入力'), 4, 'keeps full-width columns')
    assert.deepEqual(cells('ab'), [{ text: 'ab' }])
    // Combining marks take their own column (unavoidable in this environment)
    assert.equal(width('ガード'.normalize('NFD')), 10)
  } finally {
    intl.Segmenter = real
  }
})
