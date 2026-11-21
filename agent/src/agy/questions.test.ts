import assert from 'node:assert/strict'
import { test } from 'node:test'
import { STEP_KEYS, type BuildSteps, agyQuestionInteraction, buildAgySteps, noteForKeys, parseAgyQuestion, skipSteps, type AgyQuestion } from './questions.ts'

/** The fixed keys only (the plan is checked on its own) */
const stepsOf = (q: unknown, a: unknown, n: unknown): unknown => {
  const r: BuildSteps = buildAgySteps(q, a, n)
  return r.ok ? { ok: true, steps: r.steps } : r
}

const call = (questions: unknown) => ({ name: 'ask_question', args: { questions } as Record<string, unknown> })

// the measured shape (agy 1.5.13)
const two = [
  { is_multi_select: false, options: ['apple', 'banana'], question: 'Which fruit?' },
  { is_multi_select: true, options: ['red', 'blue', 'green'], question: 'Which colors?' },
]

const one = [{ is_multi_select: false, options: ['apple', 'banana'], question: 'Which fruit?' }]
const multi = [{ is_multi_select: true, options: ['red', 'blue', 'green'], question: 'Which colors?' }]

test('parse: the measured shape (a list, or a JSON string); anything unmeasured or ambiguous stays on the PC', () => {
  const q = parseAgyQuestion(call(one))!
  assert.deepEqual(q.items, [{ question: 'Which fruit?', options: ['apple', 'banana'], multi: false }])
  assert.deepEqual(parseAgyQuestion(call(JSON.stringify(one))), q)
  assert.deepEqual(parseAgyQuestion(call(multi))!.items[0]!.multi, true)
  // ★ a batch of two (how far the PC went in it cannot be seen / codex review): the PC
  assert.equal(parseAgyQuestion(call(two)), undefined)
  assert.equal(parseAgyQuestion({ name: 'run_command', args: { questions: one } }), undefined)
  assert.equal(parseAgyQuestion(call('not json')), undefined)
  assert.equal(parseAgyQuestion(call([])), undefined)
  // ⚠️ nine options: the write-in row would be "10"
  assert.equal(parseAgyQuestion(call([{ question: 'q', options: ['1', '2', '3', '4', '5', '6', '7', '8', '9'] }])), undefined)
  assert.ok(parseAgyQuestion(call([{ question: 'q', options: ['1', '2', '3', '4', '5', '6', '7', '8'] }])))
  // duplicates cannot be told apart by the phone (it answers by text)
  assert.equal(parseAgyQuestion(call([{ question: 'q', options: ['a', 'a'] }])), undefined)
  assert.equal(parseAgyQuestion(call([{ question: 'q', options: ['a', 2] }])), undefined)
  assert.equal(parseAgyQuestion(call([{ question: '', options: ['a'] }])), undefined)
  assert.equal(parseAgyQuestion(call([{ question: 'q', options: ['a'], is_multi_select: 'yes' }])), undefined)
})

test('interaction: what the phone shows; a written answer may stand in or be added', () => {
  const i = agyQuestionInteraction(parseAgyQuestion(call(multi))!)
  assert.equal(i.kind, 'question')
  if (i.kind !== 'question') return
  assert.deepEqual(i.questions.map((x) => [x.question, x.multiSelect, x.note]), [['Which colors?', true, 'answer']])
  assert.deepEqual(i.questions[0]!.options, [{ label: 'red' }, { label: 'blue' }, { label: 'green' }])
})

test('★★ steps: a digit for an option, toggles + Enter for a multi-select, the write-in row + text + Enter (as measured)', () => {
  const q = parseAgyQuestion(call(one))!
  assert.deepEqual(stepsOf(q, { 'Which fruit?': ['banana'] }, undefined), { ok: true, steps: [{ key: '2' }] })
  // a written answer: the write-in row (3), the text, Enter
  assert.deepEqual(stepsOf(q, undefined, { 'Which fruit?': 'straight\nahead' }), {
    ok: true,
    steps: [{ key: '3' }, { text: 'straight ahead' }, { key: STEP_KEYS.enter }],
  })
  const m = parseAgyQuestion(call(multi))!
  assert.deepEqual(stepsOf(m, { 'Which colors?': ['green', 'red'] }, undefined), {
    ok: true,
    steps: [{ key: '1' }, { key: '3' }, { key: STEP_KEYS.enter }],
  })
  // toggles + written text, Enter submits (measured "saw, nails")
  assert.deepEqual(stepsOf(m, { 'Which colors?': ['red'] }, { 'Which colors?': 'nails' }), {
    ok: true,
    steps: [{ key: '1' }, { key: '4' }, { text: 'nails' }, { key: STEP_KEYS.enter }],
  })
})

test('★★ steps refuse anything off (nothing is typed): unknown labels or questions, no answer, both on a single-select', () => {
  const q = parseAgyQuestion(call(one))!
  const no = (a: unknown, n?: unknown): void => assert.equal(buildAgySteps(q, a, n).ok, false, JSON.stringify([a, n]))
  no({ 'Which fruit?': ['cherry'] })
  no({ 'Which fruit?': ['apple'], 'Other?': ['x'] })
  no({})
  no({ 'Which fruit?': ['apple', 'banana'] })
  no({ 'Which fruit?': ['apple'] }, { 'Which fruit?': 'and this' })
  no({ 'Which fruit?': 'apple' })
  no(null)
  no({ 'Which fruit?': ['apple'] }, { 'Which fruit?': 3 })
  // ⚠️ `__proto__` is never a question
  no(JSON.parse('{"__proto__": ["apple"]}'))
  const m = parseAgyQuestion(call(multi))!
  assert.equal(buildAgySteps(m, { 'Which colors?': ['red', 'red'] }, undefined).ok, false)
  assert.equal(buildAgySteps(undefined, {}, {}).ok, false)
})

test('★ notes: one line, no control characters, never starting with / ! ? (it could land in the prompt), bounded', () => {
  assert.deepEqual(noteForKeys('  a\r\nb\tc\x1b[2J '), { ok: true, text: 'a b c[2J' })
  // ⚠️ NEL and the Unicode line / paragraph separators are line breaks too; C1 controls go (codex review)
  assert.deepEqual(noteForKeys('a\u0085b\u2028c\u2029d\u009be'), { ok: true, text: 'a b c de' })
  for (const bad of ['/exit', '!rm -rf x', '?help', '\u200b/exit']) assert.equal(noteForKeys(bad).ok, false, bad)
  assert.equal(noteForKeys('x'.repeat(2001)).ok, false)
  assert.equal(noteForKeys('x'.repeat(2000)).ok, true)
})

test('skip: one ESC (the question on screen)', () => {
  const q: AgyQuestion = parseAgyQuestion(call(one))!
  assert.deepEqual(skipSteps(q), [{ key: '\x1b' }])
})
