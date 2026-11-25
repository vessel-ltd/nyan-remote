import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { approvalChoicesShown, approvalShows, childViewOf, dialogFits, inChildView, inputBoxOf, inputRowOf, listAgy, listFocused, parseApproval, parseBanner, parseDialog, parseSubagentList, readAgyScreen, respondOffered, slashPicked, viewOwnerOf, sameQuestionText, showsQuestion } from './screen.ts'

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

// ★ agy 1.5.14's parent view, as the relay rebuilt it (2026-11-22)
const RULE = '─'.repeat(60)
const parentWith = (box: string, below: string[] = ['? for shortcuts             auto · Gemini 4 Neon · high']) => ['  ok', '', RULE, box, RULE, ...below].join('\n')

test('★ the input box: empty, a draft, or none on the screen', () => {
  assert.equal(inputRowOf(parentWith('>')), '')
  assert.equal(inputRowOf(parentWith('> abc')), 'abc')
  assert.equal(inputRowOf('Question 1/1: Which?\n> 1. a\n  2. Write-in...\n  ↑/↓ Navigate · enter Select · esc Skip'), undefined)
  // (a "> …" line of output not between two rules is not the box)
  assert.equal(inputRowOf('> quoted text\nmore'), undefined)
})

test('★ the input box with all its rows (a draft of several lines, measured 1.5.14); the slash list under it is not the box', () => {
  assert.deepEqual(inputBoxOf(parentWith('>')), [''])
  assert.deepEqual(inputBoxOf(parentWith('> abc')), ['abc'])
  assert.deepEqual(inputBoxOf(['  ok', RULE, '> line one', '  line two', '', '  four', RULE, '? for shortcuts'].join('\n')), ['line one', 'line two', '', 'four'])
  // the list below the box: the box above it is read
  const list = ['> /codesearch    Search code', '  /config         Open settings panel', '  ↑/↓ Navigate · enter Select · tab Complete', 'esc to cancel    auto · Gemini 4 Neon · high']
  assert.deepEqual(inputBoxOf(parentWith('> /co', list)), ['/co'])
  // ⚠️ the box pushed off a short pane: only the list (not closed by a rule) ⇒ no box
  assert.equal(inputBoxOf([RULE, ...list].join('\n')), undefined)
  assert.equal(inputBoxOf('Question 1/1: Which?\n> 1. a\n  2. Write-in...\n  ↑/↓ Navigate · enter Select · esc Skip'), undefined)
  // ⚠️ a draft with its own "────" line (indented) is not cut there (codex review)
  assert.deepEqual(inputBoxOf(['  ok', RULE, '>', `  ${RULE}`, '  text', RULE, '? for shortcuts'].join('\n')), ['', RULE, 'text'])
  // a row that is not indented ends it (not a box)
  assert.equal(inputBoxOf([RULE, '> a', 'b', RULE].join('\n')), undefined)
})

test('★ the slash command list shows /compact picked with "enter Select" (measured 1.5.14)', () => {
  const shown = parentWith('> /compact', ['> /compact  Compact the conversation now (summarize history to free up the context window)', '  ↑/↓ Navigate · enter Select · tab Complete', 'esc to cancel    auto · Gemini 4 Neon · high'])
  assert.equal(inputRowOf(shown), '/compact')
  assert.equal(slashPicked(shown, '/compact', 'Compact the conversation'), true)
  // another command picked, or no "enter Select": not
  assert.equal(slashPicked(shown.replace('> /compact  Compact', '> /compare  Compact'), '/compact', 'Compact the conversation'), false)
  assert.equal(slashPicked(shown.replace('enter Select', 'enter Run'), '/compact', 'Compact the conversation'), false)
  assert.equal(slashPicked(shown.replace('Compact the conversation now', 'Clear everything'), '/compact', 'Compact the conversation'), false)
})

// ★ Screens of agy 1.5.16 as tmux showed them (2026-11-25 / docs/AGY.md §19.2), trimmed
const v16 = {
  "parentList": " ┃ ● Bash(echo alpha-cmd)\n ┃\n ┃ ctrl+k approve · alt+j manage\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n>\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n> ● Agent(self: Beta Command Runner) · Gemini 4 Neon  Blocked · Bash · 37s\n  ● Agent(self: Alpha Command Runner) · Gemini 4 Neon  Blocked · Bash · 39s\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n? for shortcuts                                                      accept-edits · Gemini 4 Neon · high · 2 subagent(s)",
  "childApproval": "  main › self\n  ● running · Gemini 4 Neon (High) · 47s · 3 steps\n  ID: 1788a5a6-a988-4356-bcaf-5f50e974aa73\n  ────────────────────────────────────────────────────────────\n  Tools\n    Bash\n  ────────────────────────────────────────────────────────────\n  ⚠ Approval Required\n    Bash\n      echo alpha-cmd\n  ────────────────────────────────────────────────────────────\n  Trajectory — self (3 steps)\n  ▸ Thought for 4s, 96 tokens\n    Calling the command executor with the specified command to fulfill the task requirements. The focus is solely o...\n  ● Bash(echo alpha-cmd) (ctrl+o to expand)\n  ↑/↓ scroll · pgup/pgdown page · ctrl+end bottom · ctrl+home top · ctrl+o expand · a respond · shift+k kill · esc back\n                                                                     accept-edits · Gemini 4 Neon · high · 2 subagent(s)",
  "childApprovalOpen": "  main › self\n  ● running · Gemini 4 Neon (High) · 59s · 3 steps\n  ID: 1788a5a6-a988-4356-bcaf-5f50e974aa73\n    Bash\n  ────────────────────────────────────────────────────────────\n  ⚠ Approval Required\n    > Bash\n      echo alpha-cmd\n      > 1. Yes, approve\n        2. No, deny\n  ────────────────────────────────────────────────────────────\n  Trajectory — self (3 steps)\n  ▸ Thought for 4s, 96 tokens\n    Calling the command executor with the specified command to fulfill the task requirements. The focus is solely o...\n  ● Bash(echo alpha-cmd) (ctrl+o to expand)\n  ↑/↓ navigate · / select · enter confirm · esc cancel\n                                                                     accept-edits · Gemini 4 Neon · high · 2 subagent(s)",
  "childQuestion": "  main › self\n  ● running · Gemini 4 Neon (High) · 11s · 3 steps\n  ID: dd2a582b-f573-4dc7-9e26-c839fa3fe8dd\n  ────────────────────────────────────────────────────────────\n  Tools\n    No tools used yet\n  ────────────────────────────────────────────────────────────\n  ⚠ Approval Required\n    AskQuestion\n      ? Pick a sea\n  ────────────────────────────────────────────────────────────\n  Trajectory — self (3 steps)\n  ? Pick a sea\n  ↑/↓ scroll · pgup/pgdown page · ctrl+end bottom · ctrl+home top · ctrl+o expand · a respond · shift+k kill · esc back\n                                                                     accept-edits · Gemini 4 Neon · high · 2 subagent(s)",
  "childQuestionOpen": "  main › self\n  ● running · Gemini 4 Neon (High) · 13s · 3 steps\n  ID: 7929e674-cd04-4705-85e8-7188c29a56f5\n  Trajectory — self (3 steps)\n  ▸ Thought for 4s, 168 tokens\n    I'm thinking through how to approach this.\n  ? Pick a color\nQuestion\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\nQuestion 1/1: Pick a color\n> 1. red\n  2. blue\n  3. Write-in...\n  ↑/↓ Navigate · enter Select · esc Skip\n                                                                     accept-edits · Gemini 4 Neon · high · 2 subagent(s)"
}

test('★★ agy 1.5.16: the parent\'s subagent list — names, what each waits on, the focus (docs/AGY.md §19.2)', () => {
  const rows = parseSubagentList(v16.parentList)!
  assert.deepEqual(rows, [
    { focused: true, name: 'self: Beta Command Runner', state: 'Blocked · Bash', blockedOn: 'Bash' },
    { focused: false, name: 'self: Alpha Command Runner', state: 'Blocked · Bash', blockedOn: 'Bash' },
  ])
  // a running one: no `blockedOn`
  const running = v16.parentList.replace('Blocked · Bash · 39s', 'Echo alpha-cmd · 1m6s')
  assert.deepEqual(parseSubagentList(running)![1], { focused: false, name: 'self: Alpha Command Runner', state: 'Echo alpha-cmd' })
  // no list (a child's view, or nothing running)
  assert.equal(parseSubagentList(v16.childApproval), undefined)
  assert.equal(viewOwnerOf(v16.parentList), 'parent')
  // ⚠️ the list's focused row is not the input box (an empty box above it), also with one subagent (between two rules)
  assert.equal(inputRowOf(v16.parentList), '')
  assert.deepEqual(inputBoxOf(v16.parentList), [''])
  const one = v16.parentList.replace(/\n  ● Agent\(self: Alpha[^\n]*/, '')
  assert.equal(parseSubagentList(one)!.length, 1)
  assert.equal(inputRowOf(one), '')
  assert.deepEqual(inputBoxOf(one), [''])
})

test('★★ agy 1.5.16: a subagent\'s view opened from the list — whose, what it waits for, and whether its dialog is open', () => {
  assert.deepEqual(viewOwnerOf(v16.childApproval), { child: '1788a5a6-a988-4356-bcaf-5f50e974aa73' })
  // closed: "a respond" offered, no choices
  assert.equal(respondOffered(v16.childApproval), true)
  assert.deepEqual(parseApproval(v16.childApproval), { tool: 'Bash', details: ['echo alpha-cmd'] })
  // open: its choices, the cursor; "a respond" no longer offered
  assert.equal(respondOffered(v16.childApprovalOpen), false)
  assert.deepEqual(parseApproval(v16.childApprovalOpen), {
    tool: 'Bash',
    details: ['echo alpha-cmd'],
    choices: [
      { n: 1, label: 'Yes, approve', cursor: true },
      { n: 2, label: 'No, deny', cursor: false },
    ],
  })
  // a question: the block names AskQuestion and the question; its dialog is the question dialog
  assert.equal(respondOffered(v16.childQuestion), true)
  assert.deepEqual(parseApproval(v16.childQuestion), { tool: 'AskQuestion', details: ['? Pick a sea'] })
  assert.equal(respondOffered(v16.childQuestionOpen), false)
  assert.equal(parseDialog(v16.childQuestionOpen)?.question, 'Pick a color')
  // ⚠️ the parent's view offers nothing to respond to
  assert.equal(respondOffered(v16.parentList), false)
})

test('★★ agy 1.5.16: the list is read only right under the input box, and the version that has it', () => {
  // ⚠️ a matching line of output above (a log, this very file) is not a row (codex · agy review)
  const stray = '  ● Agent(self: Old Runner) · Gemini 4 Neon  Blocked · Bash · 5s'
  assert.equal(parseSubagentList(`${stray}\n${'─'.repeat(40)}\n>\n${'─'.repeat(40)}\n? for shortcuts`), undefined)
  assert.equal(parseSubagentList(`${stray}\n${v16.parentList}`)!.length, 2)
  // (a row framed by rules in the output, with no input box right above it)
  const rule = '─'.repeat(40)
  assert.equal(parseSubagentList(`${rule}\n  a table\n${rule}\n${stray}\n${rule}\n  more output\n? for shortcuts`), undefined)
  // a block with anything but rows in it is not the list
  assert.equal(parseSubagentList(v16.parentList.replace('  ● Agent(self: Alpha', '  output line\n  ● Agent(self: Alpha')), undefined)
  // ★ 1.5.16 and later have it; ⚠️ a version that cannot be read is taken as one that has it (never ctrl+k on a guess)
  assert.equal(listAgy('1.5.16'), true)
  assert.equal(listAgy('1.6.0'), true)
  assert.equal(listAgy('2.0.1'), true)
  assert.equal(listAgy('1.5.15'), false)
  assert.equal(listAgy('1.5.13'), false)
  assert.equal(listAgy(undefined), true)
})

test('★ agy 1.5.16: a focused list row wrapped or cut short is not a draft in the box, and says the list has the focus', () => {
  const rule = '─'.repeat(40)
  const wrapped = [rule, '>', rule, '> ● Agent(self: Worker) · Gemini 4 Neon', '  Blocked · AskQuestion · 15s', rule, '? for shortcuts'].join('\n')
  assert.equal(inputRowOf(wrapped), '')
  assert.deepEqual(inputBoxOf(wrapped), [''])
  assert.equal(listFocused(wrapped), true)
  // (cut short on one row, between the rules)
  const cut = [rule, '>', rule, '> ● Agent(self: Worker) · Gemi…', rule, '? for shortcuts'].join('\n')
  assert.equal(inputRowOf(cut), '')
  assert.equal(listFocused(cut), true)
  assert.equal(listFocused(v16.parentList), true)
  assert.equal(listFocused(v16.parentList.replace('> ● Agent(self: Beta', '  ● Agent(self: Beta')), false)
})

test('★ agy 1.5.16: numbered rows are choices only in an open dialog — in a closed preview they are the question\'s text', () => {
  const closed = v16.childQuestion.replace('      ? Pick a sea', '      ? Roll out with\n      1. canary or 2. all at once?')
  assert.deepEqual(parseApproval(closed), { tool: 'AskQuestion', details: ['? Roll out with', '1. canary or 2. all at once?'] })
  assert.equal(parseApproval(v16.childApprovalOpen)!.choices!.length, 2)
})

test('★ a draft that itself starts "● Agent(" is a draft (1.5.13: no list under the box), not the list (codex review)', () => {
  const rule = '─'.repeat(40)
  const draft = [rule, '> ● Agent(self: Reviewer) is stuck', rule, '? for shortcuts'].join('\n')
  assert.equal(inputRowOf(draft), '● Agent(self: Reviewer) is stuck')
  assert.equal(listFocused(draft), false)
})

test('★ a subagent approval as measured (1.5.16): its command, its two choices, its owner by the header (docs/AGY.md §19, case 8)', () => {
  assert.equal(approvalShows(v16.childApproval, 'echo alpha-cmd'), true)
  assert.equal(approvalShows(v16.childApprovalOpen, 'echo alpha-cmd'), true)
  assert.equal(approvalShows(v16.childApproval, 'echo beta-cmd'), false)
  assert.equal(approvalShows(v16.childQuestion, 'echo alpha-cmd'), false, 'a question is not an approval')
  // wrapped over rows (compared without spaces), or cut short
  assert.equal(approvalShows(v16.childApproval.replace('      echo alpha-cmd', '      echo alpha-\n      cmd'), 'echo alpha-cmd'), true)
  assert.equal(approvalShows(v16.childApproval.replace('      echo alpha-cmd', '      echo al…'), 'echo alpha-cmd'), true)
  assert.equal(approvalShows(v16.childApproval.replace('      echo alpha-cmd', '      echo al…'), 'rm -rf /'), false)
  assert.equal(approvalChoicesShown(v16.childApprovalOpen), true)
  assert.equal(approvalChoicesShown(v16.childApproval), false, 'closed: no choices')
  assert.equal(approvalChoicesShown(v16.childApprovalOpen.replace('2. No, deny', '2. Yes, always')), false)
  // the open dialog's footer is its own: the owner is read from the header
  assert.deepEqual(viewOwnerOf(v16.childApprovalOpen), { child: '1788a5a6-a988-4356-bcaf-5f50e974aa73' })
})
