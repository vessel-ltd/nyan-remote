// Markdown parser. Pure functions that do not touch the DOM, so they can be tested with node:test.
// Rendering (conversion to an element tree) is done by markdown.tsx.
//
// ★★ Purpose of this split: pin down the XSS-relevant check (safeHref) and the structural parsing with tests. ★★
//    The renderer never uses innerHTML, so strings are always escaped.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'bold'; v: string }
  | { t: 'em'; v: string }
  | { t: 'strike'; v: string }
  /** A null href means a dangerous scheme, so it is not rendered as a link */
  | { t: 'link'; v: string; href: string | null }

export type Block =
  | { t: 'p'; text: string }
  | { t: 'h'; level: number; text: string }
  | { t: 'pre'; lang: string; code: string }
  | { t: 'hr' }
  | { t: 'quote'; blocks: Block[] }
  | { t: 'list'; ordered: boolean; items: { depth: number; text: string }[] }
  | { t: 'table'; header: string[]; rows: string[][] }

/**
 * Decide whether a link target is safe.
 * Allowed: absolute http / https URLs, relative paths without a scheme
 * Rejected: every scheme such as javascript: data: vbscript:, and the `//host` form (protocol-relative)
 */
export function safeHref(url: string): string | null {
  const s = url.trim()
  if (!s) return null
  // ⚠️⚠️ **Decide on what the browser will parse, not on the raw string** (2026-09-25 / codex security review):
  //    `\u0001javascript:…` passed the old scheme regex, and URL parsing strips leading C0 controls ⇒ `javascript:` in href.
  //    ⇒ Parse it against a fixed base: a relative link must land on that same origin (so `javascript:`, `data:`, `//evil`,
  //       `/\evil` — parsed as `//evil` — and hidden control characters all fall out). Tests cover each form.
  // ⚠️ Control characters anywhere are refused (the parser drops them silently, so what we check would not be what runs)
  if (/[\u0000-\u001f\u007f]/.test(s)) return null
  // ★ A scheme is allowed only as written `http://` / `https://` (codex: `https:x`, `blob:…` resolve somewhere else in the real page)
  if (/^[a-z][a-z0-9+.\-]*:/i.test(s)) {
    if (!/^https?:\/\//i.test(s)) return null
    // ⚠️ And it must actually parse (a broken host is not a link)
    try {
      new URL(s)
    } catch {
      return null
    }
    return s
  }
  // ⚠️ Two leading slashes (either kind) name another host (`//evil`, `/\evil`, `\\evil`)
  if (/^[\\/]{2}/.test(s)) return null
  // ★ What is left must be a relative link that stays on this site (checked with the browser's parser)
  const BASE = 'https://base.invalid/'
  let u: URL
  try {
    u = new URL(s, BASE)
  } catch {
    return null
  }
  if (u.origin !== new URL(BASE).origin) return null
  return s
}

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(~~[^~\n]+~~)|(\[[^\]\n]*\]\([^)\s]+\))/

export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let rest = text
  while (rest.length > 0) {
    const m = INLINE.exec(rest)
    if (!m) {
      out.push({ t: 'text', v: rest })
      break
    }
    if (m.index > 0) out.push({ t: 'text', v: rest.slice(0, m.index) })
    const token = m[0]
    if (token.startsWith('`')) {
      out.push({ t: 'code', v: token.slice(1, -1) })
    } else if (token.startsWith('**')) {
      out.push({ t: 'bold', v: token.slice(2, -2) })
    } else if (token.startsWith('~~')) {
      out.push({ t: 'strike', v: token.slice(2, -2) })
    } else if (token.startsWith('*')) {
      out.push({ t: 'em', v: token.slice(1, -1) })
    } else {
      const cut = token.indexOf('](')
      out.push({
        t: 'link',
        v: token.slice(1, cut),
        href: safeHref(token.slice(cut + 2, -1)),
      })
    }
    rest = rest.slice(m.index + token.length)
  }
  return out
}

const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^(\s*)[-*•]\s+(.*)$/
const NUMBERED = /^(\s*)(\d+)[.)]\s+(.*)$/
const QUOTE = /^>\s?(.*)$/
const HR = /^\s*([-*_])\s*(\1\s*){2,}$/
const FENCE = /^\s*```(.*)$/
const TABLE_SEP = /^\s*\|?[\s:|-]*-[\s:|-]*\|[\s:|-]*$/

function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim())
}

function isTableStart(lines: string[], i: number): boolean {
  const line = lines[i]
  const next = lines[i + 1]
  return Boolean(line?.includes('|') && next !== undefined && TABLE_SEP.test(next))
}

function isBlockStart(lines: string[], i: number): boolean {
  const l = lines[i]
  if (l === undefined) return true
  return (
    !l.trim() ||
    FENCE.test(l) ||
    HEADING.test(l) ||
    HR.test(l) ||
    QUOTE.test(l) ||
    BULLET.test(l) ||
    NUMBERED.test(l) ||
    isTableStart(lines, i)
  )
}

export function parseBlocks(src: string): Block[] {
  const lines = src.split('\n')
  const out: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!

    if (!line.trim()) {
      i++
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const lang = fence[1]!.trim()
      const body: string[] = []
      i++
      while (i < lines.length && !FENCE.test(lines[i]!)) {
        body.push(lines[i]!)
        i++
      }
      i++ // closing fence (advance even if missing)
      out.push({ t: 'pre', lang, code: body.join('\n') })
      continue
    }

    if (HR.test(line)) {
      out.push({ t: 'hr' })
      i++
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      out.push({ t: 'h', level: Math.min(6, heading[1]!.length), text: heading[2]! })
      i++
      continue
    }

    if (isTableStart(lines, i)) {
      const header = splitRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) {
        rows.push(splitRow(lines[i]!))
        i++
      }
      out.push({ t: 'table', header, rows })
      continue
    }

    if (QUOTE.test(line)) {
      const body: string[] = []
      while (i < lines.length) {
        const q = QUOTE.exec(lines[i]!)
        if (!q) break
        body.push(q[1]!)
        i++
      }
      out.push({ t: 'quote', blocks: parseBlocks(body.join('\n')) })
      continue
    }

    if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = !BULLET.test(line)
      const items: { depth: number; text: string }[] = []
      while (i < lines.length) {
        const b = BULLET.exec(lines[i]!)
        const n = b ? null : NUMBERED.exec(lines[i]!)
        if (!b && !n) break
        const indent = (b ? b[1]! : n![1]!).length
        items.push({ depth: indent >= 2 ? 1 : 0, text: b ? b[2]! : n![3]! })
        i++
      }
      out.push({ t: 'list', ordered, items })
      continue
    }

    const para: string[] = []
    while (i < lines.length && !isBlockStart(lines, i)) {
      para.push(lines[i]!)
      i++
    }
    out.push({ t: 'p', text: para.join('\n') })
  }

  return out
}
