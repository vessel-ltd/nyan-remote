// ★ Choosing text vs image (scripts/lib/qrMode.mjs)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QR_TRAILING_LINES, artSize, chooseQrMode, fitsIn, imageOpeners, modeNote } from './qrMode.mjs'
import { setLang } from '../../shared/i18n.ts'

// ★ Tests that look at Japanese text pin the language
setLang('ja')

const need = { cols: 73, rows: 37 }
const big = { columns: 120, rows: 50 }

test('★★ mac: image only (regardless of size, even with --text; no text QR)', () => {
  assert.deepEqual(chooseQrMode({ platform: 'darwin', argv: [], term: big, need }), { mode: 'image', reason: 'mac' })
  assert.deepEqual(chooseQrMode({ platform: 'darwin', argv: ['--text'], term: big, need }), { mode: 'image', reason: 'mac-text' })
  // ⚠️ If piped (size unknown) no window is opened either ⇒ string only (2026-09-23 user decision)
  assert.deepEqual(chooseQrMode({ platform: 'darwin', argv: [], term: undefined, need }), { mode: 'none', reason: 'mac-no-tty' })
  assert.match(modeNote({ reason: 'mac-text' }, need, big), /文字の QR は出しません/)
  assert.match(modeNote({ reason: 'mac-no-tty' }, need, undefined), /貼り付け/)
})

test('★★ Linux / WSL: text if it fits, image if width or height is short', () => {
  const pick = (term) => chooseQrMode({ platform: 'linux', argv: [], term, need })
  assert.deepEqual(pick(big), { mode: 'text', reason: 'fits' })
  assert.deepEqual(pick({ columns: 73, rows: 37 + QR_TRAILING_LINES }), { mode: 'text', reason: 'fits' })
  assert.deepEqual(pick({ columns: 72, rows: 50 }), { mode: 'image', reason: 'too-small' })
  // ⚠️ If it overflows vertically the camera cannot capture it in one go
  assert.deepEqual(pick({ columns: 120, rows: 37 + QR_TRAILING_LINES - 1 }), { mode: 'image', reason: 'too-small' })
})

test('★★★ if the terminal size is unknown (pipe, log) use text (never open a window on its own)', () => {
  for (const term of [undefined, { columns: undefined, rows: undefined }, { columns: 0, rows: 0 }]) {
    assert.deepEqual(chooseQrMode({ platform: 'linux', argv: [], term, need }), { mode: 'text', reason: 'no-tty' })
  }
})

test('★★★ on Linux / WSL an explicit flag wins (--text is text, --image is image)', () => {
  assert.equal(chooseQrMode({ platform: 'linux', argv: ['--text'], term: { columns: 10, rows: 10 }, need }).mode, 'text')
  assert.equal(chooseQrMode({ platform: 'linux', argv: ['--image'], term: big, need }).mode, 'image')
  // ★ Also account for the trailing lines (QR_TRAILING_LINES) (codex round 15, low #5)
  assert.equal(fitsIn(need, { columns: 73, rows: 37 + QR_TRAILING_LINES }), true)
  assert.equal(fitsIn(need, { columns: 73, rows: 37 + QR_TRAILING_LINES - 1 }), false)
})

test('★★ visible size is counted without color escapes', () => {
  assert.deepEqual(artSize('\x1b[47m▀▄█ \x1b[0m\n\x1b[47m▀▀▀▀\x1b[0m\n'), { cols: 4, rows: 2 })
})

test('★★★ says why (when too small: the required size and the current size)', () => {
  assert.match(modeNote({ reason: 'too-small' }, need, { columns: 60, rows: 30 }), new RegExp(`73 桁 × ${37 + QR_TRAILING_LINES} 行.*60 桁 × 30 行`))
  assert.match(modeNote({ reason: 'mac' }, need, undefined), /mac/)
})

test('★★ how the image is opened: mac uses Preview then plain open / WSL uses the full explorer.exe path / Linux without a display does not open', () => {
  assert.deepEqual(imageOpeners({ platform: 'darwin', env: {}, file: '/t/p.png' }), [
    ['open', ['-a', 'Preview', '/t/p.png']],
    ['open', ['/t/p.png']],
  ])
  assert.deepEqual(imageOpeners({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, file: '/t/p.png', winPath: '\\\\wsl.localhost\\U\\t\\p.png' }), [
    ['/mnt/c/Windows/explorer.exe', ['\\\\wsl.localhost\\U\\t\\p.png']],
  ])
  // ⚠️ Cannot open if it cannot be converted to a Windows path
  assert.deepEqual(imageOpeners({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, file: '/t/p.png' }), [])
  assert.deepEqual(imageOpeners({ platform: 'linux', env: { DISPLAY: ':0' }, file: '/t/p.png' }), [['xdg-open', ['/t/p.png']]])
  assert.deepEqual(imageOpeners({ platform: 'linux', env: {}, file: '/t/p.png' }), [])
})


test('★★ in English the reason is English too (⚠️ no Japanese / 2026-09-24)', () => {
  setLang('en')
  try {
    for (const reason of ['mac', 'mac-text', 'mac-no-tty', 'too-small', 'asked']) {
      const note = modeNote({ reason }, need, { columns: 60, rows: 30 })
      assert.doesNotMatch(note, /[\u3040-\u30ff\u4e00-\u9fff]/, note)
    }
  } finally {
    setLang('ja')
  }
})
