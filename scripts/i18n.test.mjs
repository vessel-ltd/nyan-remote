// ★★★ User-run scripts (CLI, installer) have no Japanese text left that bypasses `t()` (2026-09-24).
//   ⚠️ Japanese showing up for foreign users is a letdown (user decision). Any text whose English was forgotten fails here.
//   ★ Tokens are read with web's `i18nScan.ts` (comments and regexes excluded).
//   ★ Also fails if the English side (`t()`'s second argument) contains full-width characters (・「」（） etc.; they stand out on an English screen).
//   ★ Developer-only tools (dev-fakeserve / relay-smoke / stun-probe / build-*) are covered too (the exclusion was dropped on 2026-09-24).
//   ⚠️ Fake data in the check server (Japanese titles etc.) may stay Japanese only inside a declared range (FIXTURE_FILES below).
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { scanJaLiterals } from '../web/src/i18nScan.ts'

const ROOT = new URL('.', import.meta.url).pathname

const files = [
  ...readdirSync(ROOT).filter((n) => /\.(mjs|cjs)$/.test(n) && !/\.test\.(mjs|cjs)$/.test(n)),
  ...readdirSync(join(ROOT, 'lib'))
    .filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs'))
    .map((n) => `lib/${n}`),
]

// kana and kanji (Japanese as prose)
const JA_WORD = /[ぁ-ゖァ-ヺ一-鿿]/
// full-width characters that must not appear on the English side (kana and kanji plus ・「」（）、。 etc.)
const WIDE = /[　-ヿ一-鿿＀-￯]/

/** ★ Allowed to stay Japanese (always give a reason). The key is `file:part of the contents`. */
const ALLOWED = new Map([
  ['install-relay.mjs:テストのために失敗させました', 'only appears with an environment variable set by tests'],
  ['build-manul-cat.mjs:ずしずしマヌルネコ', 'the <title> of the generated SVG (asset content; never shown on screen)'],
])

/**
 * ★ Files allowed to declare fake-data ranges (always give a reason).
 *   A range runs from the "begin marker (with reason)" line to the "end marker" line. See the regexes below for the spelling
 *   (⚠️ writing the marker verbatim in prose gets it picked up as a marker).
 */
const FIXTURE_FILES = new Map([
  ['dev-fakeserve.mjs', 'fake data returned to the PWA. The Japanese titles and bodies are there to check Japanese typesetting'],
])
const FIXTURE_BEGIN = /^\s*\/\/ i18n-fixture: begin\b(.*)$/
const FIXTURE_END = /^\s*\/\/ i18n-fixture: end\s*$/
const FIXTURE_ANY = /i18n-fixture:/

/**
 * ★ Read the ranges. ⚠️ An unclosed, nested, orphaned, reasonless range or one in a non-allowed file **fails by itself**
 *   (allowing an unclosed one would leave everything to the end of the file unguarded / CLAUDE.md §2 "exclusion ranges").
 * @returns {{ ranges: Array<[number, number]>, errors: string[] }} line numbers are 1-based, inclusive
 */
function fixtureRanges(f, srcLines) {
  const ranges = []
  const errors = []
  let open = 0
  srcLines.forEach((l, i) => {
    const n = i + 1
    const b = FIXTURE_BEGIN.exec(l)
    if (b) {
      if (!FIXTURE_FILES.has(f)) errors.push(`${f}:${n} not a file allowed to declare fake-data ranges`)
      if (open) errors.push(`${f}:${n} nested fake-data range`)
      if (!b[1].trim()) errors.push(`${f}:${n} fake-data range has no reason`)
      open = n
    } else if (FIXTURE_END.test(l)) {
      if (!open) errors.push(`${f}:${n} end marker without a begin`)
      else ranges.push([open, n])
      open = 0
    } else if (FIXTURE_ANY.test(l)) {
      errors.push(`${f}:${n} malformed marker`)
    }
  })
  if (open) errors.push(`${f}:${open} fake-data range is not closed`)
  return { ranges, errors }
}

/**
 * Whether Japanese may appear on this line of generated shell.
 *   - comment lines (`# …`) and the markers expanded into them (`${SHIM_MARK}` etc.). ⚠️ markers are matched on removal = never translate them
 *   - the Japanese branch of `if _ta_ja; then … else`, where the shell picks the language
 * ⚠️ Templates are split at `${…}`, so look at **source lines**, not fragments (a fragment can start mid-line).
 */
function onlyShellComments(srcLines, lit) {
  const n = lit.text.split('\n').length
  let jaBranch = false
  let ok = true
  let seen = false
  for (const l of srcLines.slice(lit.line - 1, lit.line - 1 + n)) {
    if (/\bif _ta_ja; then\b/.test(l)) jaBranch = true
    else if (jaBranch && /^\s*(else|fi)\b/.test(l)) jaBranch = false
    if (!JA_WORD.test(l)) continue
    seen = true
    if (!/^\s*(#|\$\{\w*MARK\})|\b[A-Z_]*MARK\s*=/.test(l) && !(jaBranch && /^\s*echo /.test(l))) ok = false
  }
  // A one-line string (`const SHIM_MARK = '# …'`) is judged by its contents
  if (!seen) return lit.text.split('\n').every((l) => !JA_WORD.test(l) || /^\s*#/.test(l))
  return ok
}

test('★★★ user-facing scripts put Japanese only on the Japanese side of t()', () => {
  const bad = []
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), 'utf8')
    const srcLines = src.split('\n')
    const { ranges, errors } = fixtureRanges(f, srcLines)
    bad.push(...errors)
    for (const lit of scanJaLiterals(src)) {
      if (!lit.inEnglish && ranges.some(([a, b]) => lit.line > a && lit.line < b)) continue
      if ([...ALLOWED.keys()].some((k) => k === `${f}:${lit.text}` || (k.startsWith(`${f}:`) && lit.text.includes(k.slice(f.length + 1))))) continue
      if (lit.inEnglish) {
        if (WIDE.test(lit.text)) bad.push(`${f}:${lit.line} full-width on the English side: ${lit.text.slice(0, 60)}`)
        continue
      }
      if (lit.inT) continue
      if (!onlyShellComments(srcLines, lit)) bad.push(`${f}:${lit.line} outside t(): ${lit.text.slice(0, 60)}`)
    }
  }
  assert.deepEqual(bad, [])
})

test('★ the guard really works (catches Japanese outside t() and full-width on the English side)', () => {
  const src = "console.log('こんにちは'); t('はい', 'yes・no')"
  const hits = scanJaLiterals(src)
  // ⚠️ Must also catch an English side with no kana/kanji (`Yes（no）`) (codex round 22, low #5)
  assert.ok(scanJaLiterals("t('はい', 'Yes（no）')").some((h) => h.inEnglish && WIDE.test(h.text)))
  assert.ok(hits.some((h) => !h.inT && h.text === 'こんにちは' && !onlyShellComments(src.split('\\n'), h)))
  assert.ok(hits.some((h) => h.inEnglish && WIDE.test(h.text)))
})

test('★ fake-data ranges reject broken markers, and outside the range scanning is unchanged', () => {
  const B = '// i18n-fixture: begin 理由'
  const E = '// i18n-fixture: end'
  assert.deepEqual(fixtureRanges('dev-fakeserve.mjs', ['x', B, "'あ'", E]), { ranges: [[2, 4]], errors: [] })
  // unclosed, nested, orphaned, no reason, non-allowed file, malformed
  assert.equal(fixtureRanges('dev-fakeserve.mjs', [B, "'あ'"]).errors.length, 1)
  assert.equal(fixtureRanges('dev-fakeserve.mjs', [B, B, E]).errors.length, 1)
  assert.equal(fixtureRanges('dev-fakeserve.mjs', [E]).errors.length, 1)
  assert.equal(fixtureRanges('dev-fakeserve.mjs', ['// i18n-fixture: begin', E]).errors.length, 1)
  assert.equal(fixtureRanges('pair.mjs', [B, E]).errors.length, 1)
  assert.equal(fixtureRanges('dev-fakeserve.mjs', ['// i18n-fixture: bgein x']).errors.length, 1)
  // ★ The real dev-fakeserve.mjs: exactly one range, and developer-facing text (outside the range) goes through t()
  const src = readFileSync(join(ROOT, 'dev-fakeserve.mjs'), 'utf8')
  const { ranges } = fixtureRanges('dev-fakeserve.mjs', src.split('\n'))
  assert.equal(ranges.length, 1)
  const outside = scanJaLiterals(src).filter((l) => !ranges.some(([a, b]) => l.line > a && l.line < b))
  assert.ok(outside.some((l) => l.inT && l.text.includes('確認用サーバー')), 'text outside the range is not visible')
})

test('★ the target file list is not empty (no green from a skipping mistake)', () => {
  for (const f of ['nyan.mjs', 'pair.mjs', 'devices.mjs', 'pending.mjs', 'install-relay.mjs', 'lib/pairPrint.mjs',
    'dev-fakeserve.mjs', 'relay-smoke.mjs', 'stun-probe.mjs', 'build-manul-cat.mjs', 'build-icons.cjs']) {
    assert.ok(files.includes(f), f)
  }
})

test('★★ the CLI tells the agent its language (`?lang=` / codex round 22, medium #1)', async () => {
  const { agentUrl } = await import('./lib/lang.mjs')
  const { setLang } = await import('../shared/i18n.ts')
  setLang('en')
  assert.equal(agentUrl(7777, '/devices'), 'http://127.0.0.1:7777/devices?lang=en')
  setLang('ja')
  assert.equal(agentUrl(7777, '/pair/token/abc'), 'http://127.0.0.1:7777/pair/token/abc?lang=ja')
  // ⚠️ Do not build fetches to the agent with hard-coded URLs (then the agent answers in **the machine's language**)
  for (const f of files) {
    const direct = readFileSync(join(ROOT, f), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l) && /fetch\(\s*`http:\/\/127\.0\.0\.1/.test(l))
    assert.deepEqual(direct, [], `${f}: does not go through agentUrl`)
  }
})
