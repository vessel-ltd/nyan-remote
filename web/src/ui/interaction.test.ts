import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Interaction, InteractionOption } from '../../../shared/types.ts'
import { needsSubmit, previewText, tapAnswers } from './interaction.ts'

// ★★ Decide in one place whether to "answer on tap" or "answer with a submit button" (2026-08-18).
//
// ⚠️⚠️ If this splits into two places, you can build **a card where neither appears = one that cannot be answered**.
//    In fact the submit button side had **copied the condition** `questions.length > 1 || questions[0]?.multiSelect`.
//    When adding the change that stops tap-to-answer for questions with diagrams,
//    leaving it as-is would have produced "tapping only selects, and there is no submit button".

function q(
  options: InteractionOption[],
  multiSelect = false,
): Interaction {
  return { kind: 'question', questions: [{ question: 'q', multiSelect, options }] }
}

// ── ★★ Diagram contents (`/code-review` medium #1, 2026-08-19)
//
// ⚠️⚠️ **The contract was confirmed in the binary**: *"Preview content is rendered as markdown in a
//    monospace box"* (CLI 2.1.234). I assumed it was "raw monospace text" and
//    asserted "passing it through markdown breaks it". **The assumption was the error.**
//    But passing it through our parser is also wrong (`---` → rule / `|` → table changes columns).
//    ⇒ Strip **only what can be removed line-by-line without shifting columns = fences**.

test('★★ code fence lines are not shown (``` used to appear on screen as-is)', () => {
  const src = ['```ts', 'const a = 1', '  // 字下げは保つ', '```'].join('\n')
  assert.equal(previewText(src), 'const a = 1\n  // 字下げは保つ')
})

test('★★ inline syntax is left alone (removing it narrows only that line and breaks the box)', () => {
  const box = ['┌────────┐', '│ **強調** │', '└────────┘'].join('\n')
  assert.equal(previewText(box), box, 'rewrites in a way that shifts columns')
})

test('★ lines that look like rules, separators or tables stay as-is (confirms it is not passed through the parser)', () => {
  const art = ['a --> b', '---', '| x | y |', '# 見出しに見える行'].join('\n')
  assert.equal(previewText(art), art)
})

test('★ a diagram with only fences counts as "no diagram" (do not show an empty box)', () => {
  assert.equal(previewText('```\n```'), '')
  assert.equal(previewText(undefined), '')
  assert.equal(previewText(''), '')
  // ⚠️ With nothing to show, tap-to-answer is fine (do not add a submit button when no box appears)
  assert.equal(tapAnswers({ kind: 'question', questions: [
    { question: 'q', multiSelect: false, options: [{ label: 'A', preview: '```\n```' }] },
  ] }), true)
})

test('★ drop only leading and trailing blank lines (no trace of stripped fences left inside the box)', () => {
  assert.equal(previewText('\n\n  図  \n\n'), '  図  ', 'trims whitespace inside lines too')
})

// ── ★★ codex review medium #1, 2026-08-19 (**paths that "answer on tap despite a diagram"**)

test('★★ a diagram wrapped in four backticks is not emptied (it used to answer on tap)', () => {
  // ⚠️ The inner ``` is **content** (CommonMark). Removing line-by-line emptied the diagram, and
  //    `tapAnswers` was true = answerable without confirmation (actually reproduced)
  const src = ['````', '```', '````'].join('\n')
  assert.equal(previewText(src), '```')
  assert.equal(tapAnswers(q([{ label: 'A', preview: src }])), false)
})

test('★ match opening and closing fences (a fence that is too short is content)', () => {
  assert.equal(previewText(['```', '````', '図', '````', '```'].join('\n')), '図\n```')
  assert.equal(previewText(['~~~', '図', '~~~'].join('\n')), '図', '~~~ fence')
  assert.equal(previewText(['```ts', 'const a = 1', '```'].join('\n')), 'const a = 1')
  // An info string cannot contain ` (not an opening fence = do not remove)
  assert.equal(previewText('``` a`b'), '``` a`b')
  // Even if it ends without a closing fence, keep the content
  assert.equal(previewText('```\n図'), '図')
})

test('★★ if a diagram is clipped, do not answer on tap (there is hidden content)', () => {
  // ⚠️⚠️ The shape that actually happened: the limit **cuts off down to the closing fence** → `previewText` is empty →
  //    `tapAnswers` was true while neither box nor warning appeared
  const i = q([{ label: 'A', preview: '```\n' + ' '.repeat(100), previewClipped: true }])
  assert.equal(previewText('```\n' + ' '.repeat(100)), '', 'premise (diagram becomes empty) changed')
  assert.equal(tapAnswers(i), false, 'answers on tap despite a clipped diagram')
  assert.equal(needsSubmit(i), true)
})

test('★ one question, single select, no diagram → answer on tap (fastest on a phone)', () => {
  const i = q([{ label: 'A' }, { label: 'B', description: 'ほう' }])
  assert.equal(tapAnswers(i), true)
  assert.equal(needsSubmit(i), false)
})

test('★★ if any option has a diagram, do not answer on tap (a mistaken tap becomes an irreversible answer)', () => {
  const i = q([{ label: 'A', preview: '┌─┐\n└─┘' }, { label: 'B' }])
  assert.equal(tapAnswers(i), false, 'answers on tap with a diagram')
  assert.equal(needsSubmit(i), true, 'no way left to answer')
})

test('★ an empty-string diagram keeps tap-to-answer (the agent drops empties, so treat it the same here)', () => {
  assert.equal(tapAnswers(q([{ label: 'A', preview: '' }])), true)
})

test('★★ "answer on tap" and "show the box" are decided by the same function (never disagree)', () => {
  for (const p of ['図', '```\n図\n```', '```\n```', '', undefined]) {
    const 出す = previewText(p) !== ''
    const 即答 = tapAnswers(q([{ label: 'A', ...(p === undefined ? {} : { preview: p }) }]))
    assert.equal(即答, !出す, `box and tap-to-answer disagree: ${JSON.stringify(p)}`)
  }
})

test('multiple select and multiple questions use the submit button', () => {
  assert.equal(tapAnswers(q([{ label: 'A' }], true)), false)
  const two: Interaction = {
    kind: 'question',
    questions: [
      { question: 'a', multiSelect: false, options: [{ label: 'A' }] },
      { question: 'b', multiSelect: false, options: [{ label: 'B' }] },
    ],
  }
  assert.equal(tapAnswers(two), false)
  assert.equal(needsSubmit(two), true)
})

test('★ empty questions, plans and none raise neither (do not show only a submit button)', () => {
  const empty: Interaction = { kind: 'question', questions: [] }
  assert.equal(tapAnswers(empty), false)
  // ⚠️ Showing "Answer with this" with no questions means pressing it is always refused.
  //    But `describeInteraction` never creates empty questions, so this is a type-level safeguard
  assert.equal(needsSubmit(empty), true)
  assert.equal(tapAnswers({ kind: 'plan' }), false)
  assert.equal(needsSubmit({ kind: 'plan' }), false, 'a plan has nothing to choose (one allow button)')
  assert.equal(tapAnswers(undefined), false)
  assert.equal(needsSubmit(undefined), false, 'a normal approval is "allow / deny"')
})

test('★★ for approvals with choices, exactly one of the two is always raised (never an unanswerable shape)', () => {
  const cases: Interaction[] = [
    q([{ label: 'A' }]),
    q([{ label: 'A', preview: '図' }]),
    q([{ label: 'A' }], true),
    q([{ label: 'A', preview: '図' }], true),
  ]
  for (const i of cases) {
    assert.notEqual(tapAnswers(i), needsSubmit(i), `zero or two ways to answer: ${JSON.stringify(i)}`)
  }
})
