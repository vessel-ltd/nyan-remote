import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasBidi, hasHidden, reveal } from './reveal.ts'

const labels = (text: string) => reveal(text).filter((p) => p.kind === 'hidden').map((p) => (p.kind === 'hidden' ? p.label : ''))
const visible = (text: string) => reveal(text).map((p) => (p.kind === 'text' ? p.text : `[${p.label}]`)).join('')

test('reveal: a direction override is shown as a marker, not applied', () => {
  // Draws as "rm -rf ~ #cat log.txt" in a browser without the marker
  const spoof = 'rm -rf ~ #\u202Etxt.gol tac'
  assert.equal(visible(spoof), 'rm -rf ~ #[U+202E]txt.gol tac')
  assert.ok(hasHidden(spoof))
})

test('reveal: every bidi control is marked', () => {
  const controls = ['\u061C', '\u200E', '\u200F', '\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069']
  for (const c of controls) {
    assert.equal(labels(`a${c}b`).length, 1, `U+${c.codePointAt(0)!.toString(16)} must be marked`)
  }
})

test('reveal: zero-width, default-ignorable, control and non-ASCII space characters are marked', () => {
  const cases: Array<[string, string]> = [
    ['\u200B', 'U+200B'],
    ['\u200D', 'U+200D'],
    ['\u2060', 'U+2060'],
    ['\uFEFF', 'U+FEFF'],
    ['\u00AD', 'U+00AD'],
    ['\u180E', 'U+180E'],
    ['\u3164', 'U+3164'],
    ['\u00A0', 'U+00A0'],
    ['\u3000', 'U+3000'],
    ['\u2028', 'U+2028'],
    ['\u2029', 'U+2029'],
    ['\r', 'U+000D'],
    ['\x1b', 'U+001B'],
    ['\x08', 'U+0008'],
    ['\x7f', 'U+007F'],
    ['\u{E0041}', 'U+E0041'], // tag character (astral, Default_Ignorable)
    ['\u2800', 'U+2800'], // braille blank: not in the classes, but draws as a blank (codex)
  ]
  for (const [ch, label] of cases) assert.deepEqual(labels(`x${ch}y`), [label], label)
})

test('reveal: ordinary text, newlines, tabs and spaces pass unchanged in one run', () => {
  const text = 'cat <<\'PY\'\n\tprint("日本語 ok")\nPY'
  assert.deepEqual(reveal(text), [{ kind: 'text', text }])
  assert.equal(hasHidden(text), false)
  assert.deepEqual(reveal(''), [])
})

test('reveal: nothing visible is lost and markers keep their position', () => {
  const text = 'a\u200Bb\u202Ec'
  assert.deepEqual(reveal(text), [
    { kind: 'text', text: 'a' },
    { kind: 'hidden', label: 'U+200B' },
    { kind: 'text', text: 'b' },
    { kind: 'hidden', label: 'U+202E' },
    { kind: 'text', text: 'c' },
  ])
})

test('hasHidden: looks at every text given (summary looks clean, detail does not)', () => {
  assert.equal(hasHidden('ls -la', undefined), false)
  assert.equal(hasHidden('ls -la', 'ls\u00A0-la'), true)
})

test("reveal 'bidi': only direction controls are marked (labels keep emoji ZWJ and spaces)", () => {
  const labelText = '\u202EON\u202C'
  assert.deepEqual(reveal(labelText, 'bidi'), [
    { kind: 'hidden', label: 'U+202E' },
    { kind: 'text', text: 'ON' },
    { kind: 'hidden', label: 'U+202C' },
  ])
  const emoji = 'dev \u{1F468}\u200D\u{1F4BB}\u00A0ok'
  assert.deepEqual(reveal(emoji, 'bidi'), [{ kind: 'text', text: emoji }])
  for (const c of ['\u061C', '\u200E', '\u200F', '\u202A', '\u202B', '\u202D', '\u2066', '\u2067', '\u2068', '\u2069']) {
    assert.equal(reveal(`a${c}b`, 'bidi').length, 3, `U+${c.codePointAt(0)!.toString(16)}`)
  }
})

test('hasBidi: direction controls only', () => {
  assert.equal(hasBidi('a\u2067b'), true)
  assert.equal(hasBidi(undefined, 'x\u200Dy\u00A0z'), false)
})
