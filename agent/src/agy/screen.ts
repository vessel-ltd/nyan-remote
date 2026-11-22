// ★★ What an agy shows on the PC, read from its relay (2026-11-21 / docs/AGY.md §14).
//
// The relay keeps the screen of an agy it started (`Screen` in scripts/relay.py) and answers a connection that starts
// with 0x02 with its text (only a relay whose registration says `screen: true`; an older one would type the byte).
// The agent reads it before and after every key of an answer to a question: which question is open, how far a batch
// went, which options are ticked, where the cursor is, a subagent's banner, a subagent's view. Shapes measured on agy
// 1.5.13 (the relay's screen matched tmux's at every checkpoint of several recorded sessions):
//
//   Question 1/2: Which fruit?            ← the open question (k of n)
//   > 1. apple                             ← the cursor
//     2. [x] red                           ← a multi-select option, ticked
//     3. Write-in...                       ← the write-in row (the number after the options)
//     Your answer:                         ← the write-in field, open
//     ↑/↓ Navigate · → Next · enter Select · esc Skip
//
//    ┃ self has a question                 ← a subagent asks (on the parent's view)
//    ┃ ? Which hill?
//    ┃ ctrl+k answer · alt+j manage
//
//   … shift+k kill · esc back              ← a subagent's view (its footer)
//
// ⚠️ Text is compared, never trusted beyond that: a screen that does not show exactly what is expected stops the answer.

import { connect } from 'node:net'

/** The byte that asks the relay for the screen (`SCREEN_REQUEST` in scripts/relay.py) */
export const SCREEN_REQUEST = 0x02
const SCREEN_MAX = 1024 * 1024
export const SCREEN_TIMEOUT_MS = 1500

/** ★ The screen of the agy behind this relay socket; undefined = cannot be read now */
export function readAgyScreen(socketPath: string, timeoutMs = SCREEN_TIMEOUT_MS): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (v: string | undefined): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      sock.destroy()
      resolve(v)
    }
    const sock = connect(socketPath)
    const timer = setTimeout(() => finish(undefined), timeoutMs)
    sock.on('connect', () => sock.write(Buffer.from([SCREEN_REQUEST])))
    sock.on('data', (d: Buffer) => {
      size += d.length
      if (size > SCREEN_MAX) return finish(undefined)
      chunks.push(d)
    })
    // ⚠️ Nothing at all is "not readable", never a blank screen: the relay answers so when its screen broke, and closes a
    //    connection it does not admit the same way (agy review: a blank read as "the dialog is gone" ⇒ a false success)
    sock.on('end', () => finish(size === 0 ? undefined : Buffer.concat(chunks).toString('utf8')))
    sock.on('error', () => finish(undefined))
  })
}

export interface ScreenOption {
  /** Its number on the screen (1-based) */
  n: number
  label: string
  cursor: boolean
  /** A multi-select option: ticked or not; undefined for a single-select one */
  checked?: boolean
  /** ★ A single-select option already picked earlier in this batch ("✓ north", seen after going back with ←) */
  picked?: true
}

export interface ScreenDialog {
  k: number
  of: number
  /** The question as shown (its first line; a long one can be cut) */
  question: string
  options: ScreenOption[]
  /** The write-in field is open ("Your answer:") */
  writing: boolean
  /**
   * What the field shows, when open: its rows joined by a space (a long text wraps; ⚠️ a longer one scrolls, so the
   * field shows its end only — measured: about 4 rows)
   */
  written?: string
  /** How many rows of the field hold text (a full field may show only the end of a long text) */
  writtenRows?: number
  /** ★ The field's rows as shown (trimmed): a row boundary is a space for words, nothing inside CJK text */
  writtenLines?: string[]
  /** ★ What ESC means here, from the footer ("esc Skip" / "esc Back"); a dialog saying anything else is not read */
  esc: 'skip' | 'back'
  /** ★ The footer's hints ("enter Select", "space Toggle", "→ Next" …), all of them known (`FOOTER_HINTS`) */
  hints: Set<FooterHint>
}

/**
 * ★ Every hint the footers of agy 1.5.13 were seen to give (2026-11-21). A footer with any other is not read: a key's
 * meaning may have changed (codex review: "enter Toggle · ctrl+enter Submit All" would make Enter tick a box).
 */
export const FOOTER_HINTS = ['↑/↓ Navigate', '→ Next', '← Back', 'space Toggle', 'enter Select', 'enter Submit', 'enter Submit All', 'enter Write-in', 'esc Skip', 'esc Back'] as const
export type FooterHint = (typeof FOOTER_HINTS)[number]

const QUESTION = /^Question (\d+)\/(\d+): (.*)$/
const OPTION = /^(>| ) (\d+)\. (?:\[( |x)\] )?(.*)$/

/** ★ The question open on the screen, or undefined (none, or not readable as one) */
export function parseDialog(screen: string): ScreenDialog | undefined {
  const lines = screen.split('\n').map((l) => l.replace(/\s+$/, ''))
  let at = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (QUESTION.test(lines[i]!)) {
      at = i
      break
    }
  }
  if (at < 0) return undefined
  const m = QUESTION.exec(lines[at]!)!
  // ★ A long question wraps onto the next rows (up to the blank line): read whole (codex review: two questions with the
  //   same first row were told apart only by their wrapped rest)
  let question = m[3]!
  let i = at + 1
  for (; i < lines.length && lines[i] !== '' && !OPTION.test(lines[i]!); i++) question += lines[i]
  const options: ScreenOption[] = []
  let writing = false
  let written: string | undefined
  let esc: ScreenDialog['esc'] | undefined
  let hints = new Set<FooterHint>()
  let last: 'option' | 'other' = 'other'
  const field: string[] = []
  for (; i < lines.length; i++) {
    const l = lines[i]!
    // ★ The footer: this row, or this row and the next one (a narrow terminal wraps it / codex review)
    const footer = footerOf(l) ?? (i + 1 < lines.length ? footerAcross(l, lines[i + 1]!) : undefined)
    if (footer) {
      esc = footer.esc
      hints = footer.hints
      break
    }
    const o = OPTION.exec(l)
    if (o && !writing) {
      const raw = o[4]!.trim()
      const picked = raw.startsWith('✓ ')
      options.push({
        n: Number(o[2]),
        label: picked ? raw.slice(2).trim() : raw,
        cursor: o[1] === '>',
        ...(o[3] !== undefined ? { checked: o[3] === 'x' } : {}),
        ...(picked ? { picked: true as const } : {}),
      })
      last = 'option'
      continue
    }
    if (/^\s*Your answer:\s*$/.test(l)) {
      writing = true
      last = 'other'
      continue
    }
    // ⚠️ Inside the open field every row is the typed text (a note may say "esc": never a footer / codex review)
    if (writing) {
      if (l.trim() !== '') field.push(l.trim())
      continue
    }
    // ★ A footer that is not the known one (an ESC meaning not measured — "esc Cancel turn" in some future version), or
    //   a row of key hints that is not part of it (a wrapped footer with an unknown hint): the dialog is not read, so
    //   no key is typed (codex review)
    if (/\besc\b/.test(l) || hintRow(l)) return undefined
    // a long option wraps onto the next row
    if (last === 'option' && l.trim() !== '' && /^\s/.test(l)) options[options.length - 1]!.label += l.trim()
    else if (l.trim() !== '') last = 'other'
  }
  if (writing) written = field.join(' ')
  const writtenRows = writing ? field.length : undefined
  // ⚠️ A dialog drawn only in part (its footer not reached) is not read
  if (esc === undefined || options.length === 0) return undefined
  // the field open ⇔ ESC goes back (and not open ⇔ it skips)
  if ((esc === 'back') !== writing) return undefined
  // the options must be numbered 1, 2, 3 … (a list scrolled out of view is not read)
  if (options.some((o, n) => o.n !== n + 1)) return undefined
  return { k: Number(m[1]), of: Number(m[2]), question: question.trim(), options, writing, ...(written !== undefined ? { written, writtenRows, writtenLines: field } : {}), esc, hints }
}

/** ★ A footer line: only known hints, the last one giving ESC's meaning; undefined for any other line */
function footerOf(l: string): { esc: ScreenDialog['esc']; hints: Set<FooterHint> } | undefined {
  const parts = l.trim().split(/\s+·\s+/)
  const end = parts[parts.length - 1]
  if (end !== 'esc Skip' && end !== 'esc Back') return undefined
  if (!parts.every((x) => (FOOTER_HINTS as readonly string[]).includes(x))) return undefined
  return { esc: end === 'esc Skip' ? 'skip' : 'back', hints: new Set(parts as FooterHint[]) }
}

/** A row that reads as key hints ("enter Select · ctrl+enter Submit"): every part a key, then what it does */
function hintRow(l: string): boolean {
  const parts = l.trim().split(/\s+·\s+/)
  return parts[0] !== '' && parts.every((p) => /^(?:[↑↓←→/]+|enter|esc|space|tab|backspace|pgup\/pgdown|(?:ctrl|alt|shift|cmd)\+\S+)\s+\S/i.test(p))
}

/**
 * ★ A footer wrapped onto two rows: agy breaks it between hints (dropping the " · "), a terminal anywhere (the rest at
 * the start of the next row). Only a join that reads as a whole known footer counts.
 */
function footerAcross(a: string, b: string): ReturnType<typeof footerOf> {
  if (a.trim() === '' || b.trim() === '') return undefined
  return footerOf(`${a.trim()} · ${b.trim()}`) ?? footerOf(`${a.trim()}${b.trimEnd()}`) ?? footerOf(`${a.trim()} ${b.trim()}`)
}

/** ★ Whether the screen still shows a dialog line "Question k/n: …" for any of these questions (after the last key) */
export function showsQuestion(screen: string, questions: readonly string[], of: number): boolean {
  const lines = screen.split('\n').map((l) => l.replace(/\s+$/, ''))
  for (let i = 0; i < lines.length; i++) {
    const m = QUESTION.exec(lines[i]!)
    if (!m || Number(m[2]) !== of) continue
    // ⚠️ Every join of the wrapped rows is tried: a row under it that is not part of it (a footer) must not hide it
    let q = m[3]!
    if (questions.some((x) => sameQuestionText(q, x))) return true
    for (let j = i + 1; j < lines.length && lines[j] !== '' && !OPTION.test(lines[j]!); j++) {
      q += lines[j]
      if (questions.some((x) => sameQuestionText(q, x))) return true
    }
  }
  return false
}

/** ★ The question a subagent's banner shows on the parent's view ("┃ ? …"), or undefined */
export function parseBanner(screen: string): string | undefined {
  const lines = screen.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/┃\s*.+ has a question\s*$/.test(lines[i]!)) continue
    // ★ The banner must still say ctrl+k answers it (a changed shortcut ⇒ not read / codex review). Its rows are the
    //   "┃" ones under the heading (a batch lists every question there: 8 questions and wrapped ones too / agy review)
    const block: string[] = []
    for (let j = i + 1; j < lines.length && j <= i + 40 && /^\s*┃/.test(lines[j]!); j++) block.push(lines[j]!)
    if (!block.some((l) => /┃\s*ctrl\+k answer\b/.test(l))) return undefined
    for (let j = 0; j < block.length; j++) {
      const q = /┃\s*\?\s+(.*\S)\s*$/.exec(block[j]!)
      if (!q) continue
      // a long question wraps onto the next banner rows (up to the empty one, or the batch's next question "? …" —
      // agy 1.5.14 lists every question of a batch there)
      let text = q[1]!
      for (let k = j + 1; k < block.length; k++) {
        const more = /┃\s*(.*\S)\s*$/.exec(block[k]!)
        if (!more || /ctrl\+k answer\b/.test(more[1]!) || /^\?\s/.test(more[1]!)) break
        text += more[1]
      }
      return text
    }
    return undefined
  }
  return undefined
}

/**
 * ★ The screen shows a subagent's view, not the parent's: its footer is the last row (but the status line under it)
 * and says "shift+k kill · esc back" (codex review: the parent's output saying "kill" and "esc back" near the bottom
 * was read as a child's view)
 */
export function inChildView(screen: string): boolean {
  const rows = screen.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  const footer = /(?:^|·\s)shift\+k kill · esc back$/
  // ★ agy wraps the footer between hints (dropping the " · "): "… shift+k kill" / "esc back" at 104 columns with
  //   "auto" in the status line (measured 2026-11-22: a send was refused as "not back to the parent's view")
  for (let i = Math.max(0, rows.length - 2); i < rows.length; i++) {
    if (footer.test(rows[i]!) || (i > 0 && footer.test(`${rows[i - 1]} · ${rows[i]}`))) return true
  }
  return false
}

/**
 * ★★ Whose view the screen shows: a subagent's view starts with its header ("main › self", then "ID: <id>" — measured
 * at 80×24 with a dialog of 11 options open, and at 104 columns); the parent's has none. undefined = a header whose id
 * is not on the screen (a tall dialog squeezed it), or none to read (codex / agy review: a dialog is told apart by its
 * owner, not by its text only).
 */
export function viewOwnerOf(screen: string): { child: string } | 'parent' | undefined {
  const rows = screen.split('\n').map((l) => l.trim())
  const head = rows.findIndex((l) => l !== '')
  if (head < 0) return undefined
  if (!/^\S.* › \S/.test(rows[head]!)) return 'parent'
  for (const l of rows.slice(head + 1, head + 4)) {
    const m = /^ID: ([0-9a-fA-F-]{8,})$/.exec(l)
    if (m) return { child: m[1]!.toLowerCase() }
  }
  return undefined
}

/**
 * ★ Which subagent's view the screen shows (its footer says it is one, its header names it). undefined = not a child's
 * view, or not known whose (codex review: the PC person may have opened another child's view; an ESC meant for one
 * must not close another's).
 */
export function childViewOf(screen: string): string | undefined {
  if (!inChildView(screen)) return undefined
  const owner = viewOwnerOf(screen)
  return typeof owner === 'object' ? owner.child : undefined
}

/**
 * ★ The dialog shows this question as the card did: its options (text, the order), the write-in row after them, ticks
 * exactly when it is a multi-select. The cards and the answer check the same (agy review: a card the answer would
 * always refuse came back after each try).
 */
export function dialogFits(d: ScreenDialog, item: { question: string; options: readonly string[]; multi: boolean }): boolean {
  if (!sameQuestionText(d.question, item.question)) return false
  // (the write-in row: "Write-in...", or what was written there earlier in the batch, shown picked — "✓ pear" / codex review)
  const w = d.options[item.options.length]
  // ⚠️ Only on a single-select (a pick there is replaced by the next one); a multi-select's written text would stay in
  //    its answer, which the phone did not choose (agy review)
  //    The row itself reads exactly "Write-in..." (codex review: a written answer that starts with "Write-in" is text)
  if (d.options.length !== item.options.length + 1 || !((!w!.picked && /^Write-in(?:\.\.\.|…)$/.test(w!.label)) || (w!.picked && !item.multi))) return false
  for (let j = 0; j < item.options.length; j++) {
    if (!sameQuestionText(d.options[j]!.label, item.options[j]!)) return false
    if ((d.options[j]!.checked !== undefined) !== item.multi) return false
  }
  return true
}

/**
 * Compared without any whitespace (a wrapped row is joined without the space the wrap took), in one Unicode form (an
 * accent written combined or apart is the same text)
 */
const flat = (s: string): string => s.normalize('NFC').replace(/\s+/g, '')

/**
 * ★ Whether a question shown on the screen is this question's text, whitespace aside (a wrapped question is read whole);
 * one cut short with "…" matches when it is the start of the question. ⚠️ At least 8 characters must match.
 */
export function sameQuestionText(shown: string, question: string): boolean {
  const cut = /…\s*$/.test(shown)
  const s = flat(shown.replace(/…\s*$/, ''))
  const q = flat(question)
  if (s.length === 0) return false
  if (s === q) return true
  return cut && s.length >= Math.min(8, q.length) && q.startsWith(s)
}

const RULE = /^─{8,}$/

/**
 * ★ What agy's input box holds on the parent's view: the row "> …" between two rules (measured 1.5.14:
 * "────" / "> abc" / "────"); '' when empty, undefined when no input box is on the screen (a dialog, a subagent's view).
 */
export function inputRowOf(screen: string): string | undefined {
  const rows = screen.split('\n').map((l) => l.replace(/\s+$/, ''))
  for (let i = rows.length - 2; i >= 1; i--) {
    const m = /^>(?: (.*))?$/.exec(rows[i]!)
    if (m && RULE.test(rows[i - 1]!.trim()) && RULE.test(rows[i + 1]!.trim())) return (m[1] ?? '').trim()
  }
  return undefined
}

/**
 * ★ The rows of agy's input box on the parent's view, also a draft of several lines (measured 1.5.14: "────" /
 * "> line one" / "  line two" / "────"): the first row without its "> ", the others without their two-space indent;
 * `['']` when empty, undefined when no input box is on the screen. ⚠️ Ends only at a rule: the slash list below the box
 * ("> /codesearch …" / "  /config …" / "  ↑/↓ Navigate …") is followed by the footer, not by a rule.
 */
export function inputBoxOf(screen: string): string[] | undefined {
  const rows = screen.split('\n').map((l) => l.replace(/\s+$/, ''))
  for (let i = rows.length - 2; i >= 1; i--) {
    const m = /^>(?: (.*))?$/.exec(rows[i]!)
    // ⚠️ The rules as drawn (flush left): a draft's own "────" line is indented, never one of them (codex review)
    if (!m || !RULE.test(rows[i - 1]!)) continue
    const box = [(m[1] ?? '').trim()]
    for (let j = i + 1; j < rows.length; j++) {
      if (RULE.test(rows[j]!)) return box
      if (rows[j] !== '' && !rows[j]!.startsWith('  ')) break
      box.push(rows[j]!.trim())
    }
  }
  return undefined
}

/**
 * ★ The slash command list shows this command picked (the cursor on its row, its description after it) and Enter
 * selects it: "> /compact  Compact the conversation now (…)" then "↑/↓ Navigate · enter Select · tab Complete" (1.5.14)
 */
export function slashPicked(screen: string, command: string, about: string): boolean {
  const rows = screen.split('\n').map((l) => l.replace(/\s+$/, ''))
  const at = rows.findIndex((l) => l.startsWith(`> ${command}  `) && l.slice(command.length + 2).trim().startsWith(about))
  if (at < 0) return false
  return rows.slice(at + 1, at + 4).some((l) => /(?:^|·\s)enter Select(?:\s·|$)/.test(l.trim()))
}
