/**
 * ★★ Shows the characters a command contains but a screen does not (2026-11-10 / security check).
 *
 * The approval card shows `tool_input` (a third-party string: a prompt injection in a web page or a file can
 * steer what the model writes). Some characters change **how the text is drawn without being drawn themselves**:
 * - direction controls (U+202E etc.) reorder what follows: `#<U+202E>txt.gol tac` is drawn as `#cat log.txt`
 *   (measured in Chromium, 2026-11-10), so a command can be drawn as something other than what bash runs;
 * - zero-width and other default-ignorable characters, control characters and non-ASCII spaces hide
 *   what bash actually receives.
 * ⇒ The card draws each such character as a visible marker (`U+202E`) and says it contains some.
 *
 * ⚠️ Replace, never drop: dropping would also hide the attack (you would approve a cleaned-up text that is
 *    not what runs).
 * ⚠️ `\n` and `\t` stay (the full text keeps its lines). Everything else in `\p{Cc}` is marked (CR too).
 * ⚠️ The card also forces strict left-to-right order (`.permcode` / `unicode-bidi: bidi-override`) so that
 *    right-to-left letters cannot reorder their neighbours without any control character.
 * ⚠️ U+2800 (braille blank) is not invisible by Unicode's classes but draws as a blank, so it is listed explicitly.
 * ★ Shared because the agent uses it too: it must not trim or cut away the very characters the phone
 *   would mark (`permission.ts` `detailOf` / `hiddenIn`).
 * ★ `scope: 'bidi'` marks only direction controls (for choice labels: emoji ZWJ etc. stay as drawn,
 *   but `\u202EON\u202C` must not read as "NO").
 */
export type RevealPart = { kind: 'text'; text: string } | { kind: 'hidden'; label: string }

const HIDDEN = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}\p{Zs}\u2800]/u
/** Direction controls: ALM, LRM, RLM, LRE..RLO, LRI..PDI */
const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u

export type RevealScope = 'all' | 'bidi'

function isHidden(ch: string, scope: RevealScope): boolean {
  if (scope === 'bidi') return BIDI.test(ch)
  if (ch === '\n' || ch === '\t' || ch === ' ') return false
  return HIDDEN.test(ch)
}

function label(ch: string): string {
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`
}

/** Splits text into visible runs and markers for hidden characters (in order; joining loses nothing visible) */
export function reveal(text: string, scope: RevealScope = 'all'): RevealPart[] {
  const out: RevealPart[] = []
  let run = ''
  for (const ch of text) {
    if (isHidden(ch, scope)) {
      if (run) out.push({ kind: 'text', text: run })
      run = ''
      out.push({ kind: 'hidden', label: label(ch) })
    } else {
      run += ch
    }
  }
  if (run) out.push({ kind: 'text', text: run })
  return out
}

/** Whether any of the texts contains a character `reveal` would mark (decides the warning line) */
export function hasHidden(...texts: Array<string | undefined>): boolean {
  for (const text of texts) {
    if (!text) continue
    for (const ch of text) if (isHidden(ch, 'all')) return true
  }
  return false
}

/** Whether any of the texts contains a direction control (scope `bidi`: choice labels, where emoji ZWJ is normal) */
export function hasBidi(...texts: Array<string | undefined>): boolean {
  for (const text of texts) {
    if (!text) continue
    for (const ch of text) if (isHidden(ch, 'bidi')) return true
  }
  return false
}
