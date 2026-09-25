/**
 * ★★ Matching the diagram's columns to the terminal (2026-08-19; added after seeing it broken in a real browser).
 *
 * ⚠️⚠️ **Even with a monospace font, box-drawing boxes break when Japanese is mixed in.** Measured (390px / Chromium):
 *    the right edge of `│ 入力       │ 結果     │` sat **8px short** of the frame above and below.
 *    The cause is the width ratio. The terminal treats **full-width as always 2 columns**, but in the browser
 *    **a full-width advance is only 1.661ch** (`1ch` = the advance of `0` = 5.945px = 0.6em).
 *    ⇒ Each full-width character loses 0.34ch (**2.016px**); 4 characters give **8.06px** = matches the measured 8.1px.
 *    ⇒ Changing fonts does not fix it (every font in this environment had the same value).
 *
 * ⚠️⚠️ **I once wrote this number wrong** (not subtracting the `padding` and `border` that `getBoundingClientRect()`
 *    includes, I recorded "1.48ch / 0.4em", and **that number could not explain the 8px**
 *    / 2026-08-19 `/code-review`, low #5). Measure character width **by the difference of two lengths**:
 *    `(width(c×60) − width(c×20)) / 40`. ★ **Check that the observation can be reproduced from the number you wrote.**
 *
 * **Fix**: put only characters judged full-width into a `width: 2ch` box (`2ch` = twice the width of "0"
 * = two monospace columns). ⚠️ **Do not touch box-drawing characters or arrows** (measured: `─` `│` `→` are
 * the same 1ch as `0`. Touching them clipped the glyphs and **the lines looked dotted**).
 *
 * ⚠️ This only deals with **columns**. It does not change characters (a separate role from `previewText`).
 */

/**
 * How one unit is shown. Anything without `wide` is **left to the font**.
 *
 * ★ I also built a version pinning box-drawing characters and arrows to "1 column", and **dropped it** (measured 2026-08-19).
 *   Here the advance of `─` `│` `→` is **exactly the same as `0` (1ch)**, so no pinning is needed.
 *   Worse, pinning let `overflow: hidden` clip the glyphs and **the lines looked dotted**
 *   (found in a real-browser screenshot). **Do not add what there is no reason to add.**
 */
export interface Cell {
  text: string
  wide?: true
}

/** What the terminal counts as 2 columns (East Asian Width W / F, and emoji) */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2329 && cp <= 0x232a) || // 〈 〉 (★ EAW = W. Was missing / codex medium #3)
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, Kanbun, symbols (★ includes the ideographic space 0x3000)
    // Hiragana, Katakana, Bopomofo, enclosed CJK. ⚠️ **Only 0x3248–0x324F are Ambiguous** (1 column in terminals)
    (cp >= 0x3041 && cp <= 0x33ff && !(cp >= 0x3248 && cp <= 0x324f)) ||
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) || // full-width alphanumerics and symbols
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp === 0x1f004 || cp === 0x1f0cf || cp === 0x1f18e) || // 🀄 🃏 🆎
    (cp >= 0x1f191 && cp <= 0x1f19a) || // 🆑〜🆚
    (cp >= 0x1f200 && cp <= 0x1f2ff) || // 🈁–🈲 (enclosed CJK)
    (cp >= 0x1f300 && cp <= 0x1faff ? !isTextPresentation(cp) : false) || // emoji planes (with exceptions)
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Extension B and beyond
  )
}

/**
 * ★ Characters in the emoji planes (U+1F300–) that **the terminal counts as 1 column** (EAW = Neutral;
 * drawn as text, not pictures. 2026-08-19 `/code-review`, low #3).
 *
 * ⚠️ `👁` (U+1F441) and `🗺` (U+1F5FA) are **1 column** in `string-width`. The whole plane was
 *    2 columns, so lines containing them **shifted by one column per character** (reproduced by measurement).
 * ⚠️ But with `U+FE0F` they become pictures, 2 columns (caught earlier by the branch above).
 * ⚠️⚠️ **This table is not exhaustive** (gaps after U+1F6FF are not included).
 *    Characters not listed are treated as 2 columns, so **only that line may shift by one column**.
 */
function isTextPresentation(cp: number): boolean {
  return (
    (cp >= 0x1f321 && cp <= 0x1f32c) ||
    cp === 0x1f336 ||
    cp === 0x1f37d ||
    (cp >= 0x1f394 && cp <= 0x1f39f) ||
    (cp >= 0x1f3cb && cp <= 0x1f3ce) ||
    (cp >= 0x1f3d4 && cp <= 0x1f3df) ||
    (cp >= 0x1f3f1 && cp <= 0x1f3f3) ||
    (cp >= 0x1f3f5 && cp <= 0x1f3f7) ||
    cp === 0x1f43f ||
    cp === 0x1f441 ||
    (cp >= 0x1f4fd && cp <= 0x1f4fe) ||
    (cp >= 0x1f53e && cp <= 0x1f54a) ||
    cp === 0x1f54f ||
    (cp >= 0x1f568 && cp <= 0x1f579) ||
    (cp >= 0x1f57b && cp <= 0x1f594) ||
    (cp >= 0x1f597 && cp <= 0x1f5a3) ||
    (cp >= 0x1f5a5 && cp <= 0x1f5fa) ||
    (cp >= 0x1f6e0 && cp <= 0x1f6ea) ||
    (cp >= 0x1f6f0 && cp <= 0x1f6f3)
  )
}

/**
 * ★ Standalone symbols drawn as emoji (`Emoji_Presentation`) that are common in diagrams.
 *
 * ⚠️ **Deliberately only a subset**. Holding all of `Emoji_Presentation` would make the table large, so
 *    anything missing is **left to the font** (= only lines with that character may shift).
 *    To align emoji reliably, **add U+FE0F** like `⚠️`
 *    (the `️` branch below always makes it 2 columns).
 */
const EMOJI_PRESENTATION = new Set([
  0x231a, 0x231b, 0x23f0, 0x23f3, 0x25fd, 0x25fe, 0x2614, 0x2615, 0x2705, 0x270a, 0x270b, 0x2728,
  0x274c, 0x274e, 0x2753, 0x2754, 0x2755, 0x2757, 0x2795, 0x2796, 0x2797, 0x27b0, 0x27bf, 0x2b1b,
  0x2b1c, 0x2b50, 0x2b55,
])

/**
 * Split one line into "chunks with columns".
 *
 * ⚠️ Chunks without a width are **merged when consecutive** (so ASCII-only diagrams do not multiply elements.
 *    The cap is 2000 characters, so even if all are full-width it stops at 2000 chunks).
 */
export function cells(line: string): Cell[] {
  const out: Cell[] = []
  let plain = ''
  const flush = (): void => {
    if (plain) out.push({ text: plain })
    plain = ''
  }
  for (const g of graphemes(line)) {
    const cp = g.codePointAt(0)!
    // ★ If a variation selector (U+FE0F) is present it is drawn as a picture ⇒ 2 columns in the terminal
    const wide = g.includes('\u{fe0f}') || isWide(cp) || EMOJI_PRESENTATION.has(cp)
    // ⚠️ A flag (two regional indicators) is one grapheme, 2 columns
    const flag = cp >= 0x1f1e6 && cp <= 0x1f1ff
    if (wide || flag) {
      flush()
      out.push({ text: g, wide: true })
    } else {
      plain += g
    }
  }
  flush()
  return out
}

/**
 * ★★ Split into graphemes (one visible character each). **Left to `Intl.Segmenter`**
 * (2026-08-19 codex review, medium #3. The hand-made joining logic was discarded).
 *
 * ⚠️⚠️ A hand-written "append if the next char is a combining mark" **still missed cases**:
 *    `U+E0100` (Variation Selectors Supplement) became a separate column so `葛󠄀` took 3 columns,
 *    and flags (`🇯🇵`) and skin-tone ZWJ sequences broke depending on shape (reproduced by measurement).
 *    ⇒ **Leave segmentation to the standard implementation; we only decide "how many columns a chunk is".**
 *
 * ⚠️ Environments without `Intl.Segmenter` (old versions) fall back to code points.
 *    Combining marks then take their own column, but **shifted columns beat crashing**.
 */
function graphemes(line: string): Iterable<string> {
  const S = Intl.Segmenter
  if (typeof S !== 'function') return [...line]
  const seg = new S('ja', { granularity: 'grapheme' })
  return [...seg.segment(line)].map((x) => x.segment)
}
