import type { Interaction } from '../../../shared/types.ts'

/**
 * ★★ Whether an approval with choices is "answered the moment it is tapped" or "answered with a submit button".
 *
 * ⚠️⚠️ **This is the only place that decides.** If the choices side (answer on tap) and the submit button side
 *    (show it or not) each write their own condition, you can build **a card where neither appears = one that cannot be answered**.
 *    Copying conditions has produced the same kind of accident repeatedly, so this is a pure function
 *    pinned by tests (`web/src/ui/interaction.test.ts`).
 */
/**
 * ★★ Turn a preview string into the form shown on screen.
 *
 * ⚠️⚠️ **The contract is "rendered as markdown in a monospace box"** (confirmed in the CLI 2.1.234 binary;
 *    the instruction to the model itself: *"Preview content is rendered as markdown in a monospace box"*).
 *    I initially **assumed it was raw monospace text** and asserted that "passing it through markdown breaks it".
 *
 * So should we render it as markdown? No. Our parser
 * (`markdown-parse.ts`) is **meant for chat prose**, so on diagrams it works against us:
 *
 *     `---` rule → `<hr>` ／ boxes drawn with `|` → tables ／ `#` → headings
 *
 * All of these **change column widths = break the box**. ⇒ **Output the content verbatim.**
 * The only thing processed is **what can be removed line-by-line without shifting columns** = **code fences (``` lines)**.
 * The model wraps code snippets in these as instructed, so these alone are stripped
 * (otherwise the ``` lines show up on screen as-is).
 *
 * ⚠️ Conversely, **inline syntax such as `**bold**` or `` `code` `` is left alone**.
 *    Removing it **narrows only that line and breaks the box**. Leftover symbols are still more readable.
 *
 * ⚠️ With `CLAUDE_CODE_QUESTION_PREVIEW_FORMAT=html` (and clientTypes other than `cli`)
 *    the contract is **HTML fragments** (the same binary has that instruction). In that case the HTML
 *    source shows as-is. **Hard to read but safe** (never pass it to `innerHTML`).
 */
export function previewText(preview: string | undefined): string {
  if (!preview) return ''
  fenceOpen = null // ★ Always reset per call (leftovers from the previous call must not change the result)
  const lines = preview.split('\n').filter((l) => !isFence(l))
  // Drop only blank lines at the start and end (columns do not move)
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
  return lines.join('\n')
}

/**
 * ★ Whether a line is a code fence. **Tracks the state of the open fence** (CommonMark rules).
 *
 * ⚠️⚠️ At first each line was checked with `/^\s*```/`, but **wrapping with four backticks also removed the inner
 *    ```, emptied the diagram, and made `tapAnswers` true = answered immediately without confirmation**
 *    (codex review medium #1, 2026-08-19; actually reproduced).
 *
 * Rules: up to 3 leading spaces / opens with 3+ of the same character (` or ~),
 *      closes with **the same character, the same length or longer, and no info string**.
 */
function isFence(line: string): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
  if (!m) return false
  const mark = m[1]!
  const rest = m[2]!
  const char = mark[0]!
  if (fenceOpen === null) {
    // Opening fence. ⚠️ A backtick fence's info string cannot contain ` (CommonMark)
    if (char === '`' && rest.includes('`')) return false
    fenceOpen = { char, len: mark.length }
    return true
  }
  // Closing fence (same character, same length or longer, only whitespace after)
  if (char === fenceOpen.char && mark.length >= fenceOpen.len && rest.trim() === '') {
    fenceOpen = null
    return true
  }
  // A fence-like line inside an open fence is **content** (do not remove)
  return false
}

/** State used only within a single `previewText` call (safe because `filter` is synchronous) */
let fenceOpen: { char: string; len: number } | null = null

export function tapAnswers(interaction: Interaction | undefined): boolean {
  if (interaction?.kind !== 'question') return false
  // Only when there is exactly one question (with two or more, pick all and then submit)
  const [q, ...rest] = interaction.questions
  if (!q || rest.length > 0) return false
  if (q.multiSelect) return false
  // ★ Questions with a diagram are not answered on tap (user decision, 2026-08-18).
  //   Diagrams make the card tall, so **a mistaken tap while scrolling becomes the answer**.
  //   Approval answers cannot be undone, so prefer being able to back out over speed
  // ⚠️⚠️ **If any diagram is clipped, do not answer on tap** (codex review medium #1, 2026-08-19).
  //    When the limit cuts off the closing fence, `previewText` becomes empty, and **it could be answered
  //    without confirmation while hidden content existed** (actually reproduced). `previewClipped` means
  //    exactly "there is something not yet shown", so that alone stops tap-to-answer.
  if (q.options.some((o) => o.previewClipped === true)) return false
  // ⚠️ Decide on "the form shown on screen" (pass through `previewText`). Deciding on the raw `preview` would
  //    stop tap-to-answer for a diagram of only ``` (nothing to show), producing the mismatch where **no box appears
  //    but a submit button is added**
  return !q.options.some((o) => previewText(o.preview) !== '')
}

/** ★ Whether to show "Answer with this" (= questions not answered on tap) */
export function needsSubmit(interaction: Interaction | undefined): boolean {
  return interaction?.kind === 'question' && !tapAnswers(interaction)
}
