// ★★ Scanner that checks whether Japanese string literals are inside `t(...)` / `tIn(...)` (used by `i18n.test.ts`).
//   ⚠️ A regex that only checks "preceded by `t(`" can't tell the second part of `t('a' + 'b', …)`, or Japanese
//      assembled outside `t()` ⇒ read tokens and count **parenthesis nesting** to tell whether we're inside `t(`.
//   ★ Comments and regex literals are skipped (they aren't UI text).
//   ⚠️ Test-only (not referenced from the production bundle).

export interface JaLiteral {
  /** 1-based line number */
  line: number
  /** Start position (position of the quote) */
  index: number
  /** Literal contents (for templates, the text parts excluding `${…}`) */
  text: string
  /** Inside the arguments of `t(` / `tIn(` */
  inT: boolean
  /** ★ On the English side of `t()` (2nd argument / 3rd for `tIn`) ⇒ must not contain Japanese */
  inEnglish?: boolean
  /** ★ Bare text that is not a string literal (JSX text) */
  bare?: boolean
}

const JA = /[぀-ヿ一-鿿]/
/**
 * ★ Characters caught on the English side (2nd argument of `t()`): kana and kanji plus **full-width symbols and alphanumerics** (`（）` `・` `「」` `Ａ`).
 *   ⚠️ Restricting to kana/kanji missed `t('はい', 'Yes（no）')`, so the caller's check passed silently (codex round 22, low #5).
 */
const WIDE = /[　-ヿ一-鿿＀-￯]/

/** ★ Tokens after which a regex literal may start (otherwise `/` is division) */
function regexAllowedAfter(prev: string): boolean {
  if (prev === '') return true
  if (/[(,=:[!&|?{};+\-*%<>~^]$/.test(prev)) return true
  return /\b(return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/.test(prev)
}

export function scanJaLiterals(src: string): JaLiteral[] {
  const out: JaLiteral[] = []
  // Bracket stack: 'T' = t( / tIn( paren, '(' = ordinary paren, '{' = block / `${`
  const stack: string[] = []
  // Per 'T' / 'I' frame, "which argument we're in" (count of `,`)
  const commas: number[] = []
  // Depth of `${` inside templates (read the rest of the text when we return)
  const tplStack: number[] = []
  let i = 0
  let line = 1
  let prevTok = ''
  const inT = () => stack.includes('T') || stack.includes('I')
  const inEnglish = (): boolean => {
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k] === 'T') return commas[k]! >= 1
      if (stack[k] === 'I') return commas[k]! >= 2
    }
    return false
  }
  const push = (kind: string) => { stack.push(kind); commas[stack.length - 1] = 0 }
  const emit = (text: string, startLine: number, index: number) => {
    const en = inEnglish()
    if (JA.test(text) || (en && WIDE.test(text))) out.push({ line: startLine, index, text, inT: inT(), inEnglish: en })
  }
  const readTemplate = (): void => {
    // i is right after ` or right after `}` (template continuation)
    const startLine = line
    const start = i - 1
    let text = ''
    while (i < src.length) {
      const c = src[i]!
      if (c === '\\') { text += src.slice(i, i + 2); i += 2; continue }
      if (c === '\n') line++
      if (c === '`') { i++; emit(text, startLine, start); prevTok = '`'; return }
      if (c === '$' && src[i + 1] === '{') {
        i += 2
        emit(text, startLine, start)
        push('{')
        tplStack.push(stack.length)
        prevTok = '{'
        return
      }
      text += c
      i++
    }
    emit(text, startLine, start)
  }
  while (i < src.length) {
    const c = src[i]!
    if (c === '\n') { line++; i++; continue }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end < 0 ? src.length : end + 2
      for (let k = i; k < stop; k++) if (src[k] === '\n') line++
      i = stop
      continue
    }
    if (c === "'" || c === '"') {
      const startLine = line
      let j = i + 1
      let text = ''
      while (j < src.length && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') { text += src.slice(j, j + 2); j += 2; continue }
        text += src[j]
        j++
      }
      emit(text, startLine, i)
      i = j + 1
      prevTok = c
      continue
    }
    if (c === '`') { i++; readTemplate(); continue }
    if (c === '/' && regexAllowedAfter(prevTok)) {
      // Regex literal (`/` inside a character class does not end it)
      let j = i + 1
      let cls = false
      while (j < src.length && src[j] !== '\n') {
        const d = src[j]!
        if (d === '\\') { j += 2; continue }
        if (d === '[') cls = true
        else if (d === ']') cls = false
        else if (d === '/' && !cls) break
        j++
      }
      j++
      while (j < src.length && /[a-z]/i.test(src[j]!)) j++
      i = j
      prevTok = '/re/'
      continue
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i
      while (j < src.length && /[\w$]/.test(src[j]!)) j++
      const word = src.slice(i, j)
      const dot = i > 0 && src[i - 1] === '.'
      i = j
      // `t(` / `tIn(` (⚠️ `x.t(` is something else)
      let k = i
      while (src[k] === ' ') k++
      if (!dot && (word === 't' || word === 'tIn') && src[k] === '(') {
        push(word === 't' ? 'T' : 'I')
        i = k + 1
        prevTok = '('
        continue
      }
      prevTok = word
      continue
    }
    if (c === '(' || c === '[') { push('('); i++; prevTok = c; continue }
    if (c === '{') { push('{'); i++; prevTok = c; continue }
    if (c === ',') {
      const top = stack[stack.length - 1]
      if (top === 'T' || top === 'I') commas[stack.length - 1]!++
      i++
      prevTok = c
      continue
    }
    if (c === ')' || c === ']') { stack.pop(); i++; prevTok = c; continue }
    if (c === '}') {
      if (tplStack.length && tplStack[tplStack.length - 1] === stack.length) {
        tplStack.pop()
        stack.pop()
        i++
        readTemplate()
        continue
      }
      stack.pop()
      i++
      prevTok = c
      continue
    }
    // ★ Japanese outside a literal = JSX text (emit the run as one)
    if (JA.test(c)) {
      const startLine = line
      let j = i
      while (j < src.length && !/[<>{}\n]/.test(src[j]!)) j++
      out.push({ line: startLine, index: i, text: src.slice(i, j).trim(), inT: inT(), inEnglish: inEnglish(), bare: true })
      i = j
      continue
    }
    prevTok = c
    i++
  }
  return out
}
