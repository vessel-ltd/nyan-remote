import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { childViewOf, dialogFits, inChildView, parseBanner, parseDialog, readAgyScreen, viewOwnerOf, sameQuestionText, showsQuestion } from './screen.ts'

// ★ Screens as the relay rebuilt them from agy 1.5.13 (2026-11-21), trimmed
const batch = [
  '? Which fruit?',
  '? Which colors?',
  '',
  'Question',
  '────────────────────',
  '',
  'Question 2/2: Which colors?',
  '',
  '> 1. [x] red',
  '  2. [ ] blue',
  '  3. Write-in...',
  '',
  '  ↑/↓ Navigate · ← Back · space Toggle · enter Submit All · esc Skip',
  'esc to cancel                                  Gemini 4 Neon · high',
].join('\n')

test('★ dialog: the open question, its options, ticks and the cursor', () => {
  const d = parseDialog(batch)!
  assert.equal(d.k, 2)
  assert.equal(d.of, 2)
  assert.equal(d.question, 'Which colors?')
  assert.deepEqual(
    d.options.map((o) => [o.n, o.label, o.cursor, o.checked]),
    [
      [1, 'red', true, true],
      [2, 'blue', false, false],
      [3, 'Write-in...', false, undefined],
    ],
  )
  assert.equal(d.writing, false)
})

test('★ dialog: a long list (two-digit numbers), an open write-in field with its text', () => {
  const long = ['Question 1/1: Which number?', '', ...Array.from({ length: 11 }, (_, i) => `${i === 10 ? '>' : ' '} ${i + 1}. n${i + 1}`), '  12. Write-in...', '  Your answer:', '  and zero', '  enter Submit · esc Back'].join('\n')
  const d = parseDialog(long)!
  assert.equal(d.options.length, 12)
  assert.equal(d.options[10]!.cursor, true)
  assert.equal(d.writing, true)
  assert.equal(d.written, 'and zero')
})

test('★ dialog: nothing read from a screen without one, half drawn, or a list not starting at 1', () => {
  assert.equal(parseDialog('> hello\n? for shortcuts'), undefined)
  assert.equal(parseDialog('Question 1/1: Which?\n> 1. a\n  2. b'), undefined, 'no footer yet')
  assert.equal(parseDialog('Question 1/1: Which?\n  5. e\n> 6. f\n  enter Select · esc Skip'), undefined)
})

test('★ banner and the subagent view', () => {
  const parent = [' ┃ self has a question', ' ┃ ────────', ' ┃', ' ┃ ? Which hill?', ' ┃', ' ┃ ctrl+k answer · alt+j manage', '>', '? for shortcuts'].join('\n')
  assert.equal(parseBanner(parent), 'Which hill?')
  assert.equal(inChildView(parent), false)
  const child = ['  ? Which hill?', '  > west', '  ↑/↓ scroll · pgup/pgdown page · ctrl+end bottom · ctrl+home top', '  ctrl+o expand · shift+k kill · esc back', '        Gemini 4 Neon · high · 1 subagent(s)'].join('\n')
  assert.equal(inChildView(child), true)
  assert.equal(parseBanner(child), undefined)
})

test('★ question text: equal, or the start of a longer one (cut or wrapped), never a few letters', () => {
  assert.equal(sameQuestionText('Which colors?', 'Which colors?'), true)
  assert.equal(sameQuestionText('Which colors do you like for the…', 'Which colors do you like for the new logo?'), true)
  assert.equal(sameQuestionText('Which', 'Which colors?'), false)
  assert.equal(sameQuestionText('Which fruit?', 'Which colors?'), false)
  assert.equal(sameQuestionText('', 'x'), false)
})

test('★ dialog: an option picked earlier in the batch (seen after going back) is read without its tick', () => {
  const d = parseDialog('Question 1/2: Which sea?\n> 1. ✓ north\n  2. south\n  3. Write-in...\n  ↑/↓ Navigate · → Next · enter Select · esc Skip')!
  assert.deepEqual(d.options[0], { n: 1, label: 'north', cursor: true, picked: true })
})

test('★ dialog: a footer giving ESC another meaning (or none) is not read; the field open goes with "esc Back"', () => {
  const base = 'Question 1/1: Which?\n> 1. a\n  2. Write-in...\n'
  assert.equal(parseDialog(`${base}  ↑/↓ Navigate · enter Select · esc Cancel turn`), undefined)
  // (an unknown ESC line is not skipped over to a later one that looks right)
  assert.equal(parseDialog(`${base}  esc Cancel turn\n  ↑/↓ Navigate · enter Select · esc Skip`), undefined)
  assert.equal(parseDialog(`${base}  ↑/↓ Navigate · enter Select`), undefined)
  assert.equal(parseDialog(`${base}  enter Submit · esc Back`), undefined, '"back" without the field open')
  assert.equal(parseDialog(`${base}  ↑/↓ Navigate · enter Select · esc Skip`)!.esc, 'skip')
})

test('★ a footer with any hint not seen on agy 1.5.13 is not read; a banner without "ctrl+k answer" neither', () => {
  const base = 'Question 1/1: Which?\n> 1. [ ] a\n  2. Write-in...\n'
  assert.equal(parseDialog(`${base}  ↑/↓ Navigate · enter Toggle · ctrl+enter Submit All · esc Skip`), undefined)
  assert.deepEqual([...parseDialog(`${base}  ↑/↓ Navigate · space Toggle · enter Submit · esc Skip`)!.hints], ['↑/↓ Navigate', 'space Toggle', 'enter Submit', 'esc Skip'])
  assert.equal(parseBanner(' ┃ self has a question\n ┃\n ┃ ? Which hill?\n ┃\n ┃ ctrl+j answer · alt+j manage'), undefined)
})

test('★ a long question wrapped onto the next rows is read whole; two with the same first row are told apart', () => {
  const screen = (rest: string) => `Question 1/1: Should the release go out to the stag\ning environment ${rest}\n\n> 1. Proceed\n  2. Write-in...\n  ↑/↓ Navigate · enter Select · esc Skip`
  const d = parseDialog(screen('now?'))!
  assert.equal(sameQuestionText(d.question, 'Should the release go out to the staging environment now?'), true)
  assert.equal(sameQuestionText(d.question, 'Should the release go out to the staging environment later?'), false)
})

test('★ inside the open field, a typed line that says "esc" is the text, not a footer', () => {
  const d = parseDialog('Question 1/1: Which?\n> 1. a\n  2. Write-in...\n  Your answer:\n  press esc to go back\n  enter Submit · esc Back')!
  assert.equal(d.writing, true)
  assert.equal(d.written, 'press esc to go back')
})

test('★ showsQuestion: any row of the batch still on the screen (whatever its footer says)', () => {
  assert.equal(showsQuestion('Question 2/2: Which colors?\n  enter Toggle · ctrl+enter Submit', ['Which fruit?', 'Which colors?'], 2), true)
  assert.equal(showsQuestion('• Which colors?: red\n>', ['Which fruit?', 'Which colors?'], 2), false)
})

test('★ question text: an accent combined or written apart is the same text', () => {
  assert.equal(sameQuestionText('Open Cafe\u0301?', 'Open Caf\u00e9?'), true)
})

test('★★ the subagent view: its footer on the last rows, and which child it is (the id under its header)', () => {
  const view = ['  main › self', '  ● running · Gemini 4 Neon (High) · 12s · 3 steps', '  ID: C7CCC5B8-47e1-40bf-99d2-12353d7d1834', '  ────', '', '  ? Which lake?', '  > huron', '', '  ↑/↓ scroll · pgup/pgdown page · ctrl+end bottom · ctrl+home top', '  ctrl+o expand · shift+k kill · esc back', '                                            Gemini 4 Neon · high · 1 subagent(s)'].join('\n')
  assert.equal(inChildView(view), true)
  assert.equal(childViewOf(view), 'c7ccc5b8-47e1-40bf-99d2-12353d7d1834')
  // the header scrolled away: not known which child
  assert.equal(childViewOf(view.split('\n').slice(3).join('\n')), undefined)
  // ⚠️ the parent's own output saying "kill" and "esc back" above its footer is not a child's view
  const parent = ['● ran: shift+k kill · esc back', 'done', '>', '? for shortcuts                       Gemini 4 Neon · high'].join('\n')
  assert.equal(inChildView(parent), false)
})

test('★★ a relay answering nothing (its screen broken, or the connection not admitted) is "not readable", never a blank screen', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-screen-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const sock = join(dir, 's')
  let reply = ''
  const server = createServer((c) => c.once('data', () => c.end(reply)))
  await new Promise<void>((r) => server.listen(sock, r))
  t.after(() => server.close())
  assert.equal(await readAgyScreen(sock), undefined)
  reply = '>\n'
  assert.equal(await readAgyScreen(sock), '>\n')
})

test('★ a footer wrapped onto two rows (agy between hints, a terminal anywhere) is read whole', () => {
  const base = 'Question 2/3: Which colors?\n> 1. [ ] red\n  2. [ ] blue\n  3. Write-in...\n'
  const agyWrap = parseDialog(`${base}  ↑/↓ Navigate · ← Back · space Toggle · → Next\n  enter Submit · esc Skip`)!
  assert.deepEqual([...agyWrap.hints], ['↑/↓ Navigate', '← Back', 'space Toggle', '→ Next', 'enter Submit', 'esc Skip'])
  const termWrap = parseDialog(`${base}  ↑/↓ Navigate · ← Back · space Toggle · → Next · enter Sub\nmit · esc Skip`)!
  assert.ok(termWrap.hints.has('enter Submit'))
  // ⚠️ an unknown hint on either row still stops it
  assert.equal(parseDialog(`${base}  ↑/↓ Navigate · ctrl+enter Submit\n  enter Submit · esc Skip`), undefined)
})

test('★ the open field: every row it shows, joined', () => {
  const d = parseDialog('Question 1/1: Which?\n> 1. a\n  2. Write-in...\n  Your answer:\n  word31 word32\nword41 word42\n\n  enter Submit · esc Back')!
  assert.equal(d.written, 'word31 word32 word41 word42')
})

test('★★ whose view: a child’s header and id, the parent’s (no header), or not known (the id squeezed out)', () => {
  assert.deepEqual(viewOwnerOf('  main › self\n  ● running\n  ID: B129477F-7a18-4ce6-b7e0-683a0fd90607\n\nQuestion 1/1: x'), { child: 'b129477f-7a18-4ce6-b7e0-683a0fd90607' })
  assert.equal(viewOwnerOf('> do it\n\nQuestion 1/1: x\n> 1. a'), 'parent')
  assert.equal(viewOwnerOf('  main › self\n  (1–1 of 26 lines)\nQuestion\n\nQuestion 1/1: x'), undefined)
})

test('★ dialogFits: the options in order, the write-in row, ticks exactly for a multi-select', () => {
  const d = parseDialog('Question 1/1: Which colors?\n> 1. [ ] red\n  2. [x] blue\n  3. Write-in...\n  ↑/↓ Navigate · space Toggle · enter Submit · esc Skip')!
  assert.equal(dialogFits(d, { question: 'Which colors?', options: ['red', 'blue'], multi: true }), true)
  assert.equal(dialogFits(d, { question: 'Which colors?', options: ['red', 'blue'], multi: false }), false)
  assert.equal(dialogFits(d, { question: 'Which colors?', options: ['blue', 'red'], multi: true }), false)
  assert.equal(dialogFits(d, { question: 'Which colors?', options: ['red'], multi: true }), false)
})

test('★ banner: a batch lists each question on its own row (agy 1.5.14); the first is the one read', () => {
  const b = [' ┃ self has a question', ' ┃ ────', ' ┃', ' ┃ ? Which birds?', ' ┃ ? Which pond?', ' ┃', ' ┃ ctrl+k answer · alt+j manage'].join('\n')
  assert.equal(parseBanner(b), 'Which birds?')
})

test('★ banner: a batch of six questions (the "ctrl+k answer" row far below the heading) is read', () => {
  const b = [' ┃ self has a question', ' ┃ ────', ' ┃', ...[1, 2, 3, 4, 5, 6].map((n) => ` ┃ ? Q${n}?`), ' ┃', ' ┃ ctrl+k answer · alt+j manage', '>'].join('\n')
  assert.equal(parseBanner(b), 'Q1?')
})

test('★ dialogFits: a write-in row answered earlier in the batch shows what was written, picked ("✓ pear")', () => {
  const d = parseDialog('Question 1/2: Which fruit?\n  1. apple\n  2. banana\n> 3. ✓ pear\n  ↑/↓ Navigate · → Next · enter Select · esc Skip')!
  assert.equal(dialogFits(d, { question: 'Which fruit?', options: ['apple', 'banana'], multi: false }), true)
  const other = parseDialog('Question 1/2: Which fruit?\n  1. apple\n  2. banana\n> 3. pear\n  ↑/↓ Navigate · → Next · enter Select · esc Skip')!
  assert.equal(dialogFits(other, { question: 'Which fruit?', options: ['apple', 'banana'], multi: false }), false)
})

test('★ dialogFits: a multi-select’s write-in row picked earlier ("✓ pear") is not taken (the phone could not clear it)', () => {
  const d = parseDialog('Question 1/2: Which colors?\n  1. [ ] red\n  2. [ ] blue\n> 3. ✓ pear\n  ↑/↓ Navigate · → Next · space Toggle · enter Submit · esc Skip')!
  assert.equal(dialogFits(d, { question: 'Which colors?', options: ['red', 'blue'], multi: true }), false)
})

test('★ dialogFits: the write-in row reads exactly "Write-in..." — a written answer starting with "Write-in" is not it', () => {
  const footer = '  ↑/↓ Navigate · → Next · space Toggle · enter Submit · esc Skip'
  const picked = parseDialog(`Question 1/2: Which features?\n  1. [ ] Export\n  2. [ ] Import\n> 3. ✓ Write-in support for surveys\n${footer}`)!
  assert.equal(dialogFits(picked, { question: 'Which features?', options: ['Export', 'Import'], multi: true }), false)
  const text = parseDialog(`Question 1/2: Which features?\n  1. [ ] Export\n  2. [ ] Import\n> 3. Write-in support for surveys\n${footer}`)!
  assert.equal(dialogFits(text, { question: 'Which features?', options: ['Export', 'Import'], multi: true }), false)
})

test('★★ the subagent view: its footer wrapped between "shift+k kill" and "esc back" (104 columns, "auto" in the status line)', () => {
  const view = ['  main › self', '  ● done · Gemini 4 Neon (High) · worked 45s · 7 steps', '  ID: d04a8552-963a-46c1-a40c-59104d8ac70f', '', '  ↑/↓ scroll · pgup/pgdown page · ctrl+end bottom · ctrl+home top · ctrl+o expand · shift+k kill', '  esc back', '                                        auto · Gemini 4 Neon · high'].join('\n')
  assert.equal(inChildView(view), true)
  assert.equal(childViewOf(view), 'd04a8552-963a-46c1-a40c-59104d8ac70f')
  // ⚠️ "esc back" alone without "shift+k kill" before it is not the footer
  assert.equal(inChildView(['> do it', 'esc back', '? for shortcuts'].join('\n')), false)
})
