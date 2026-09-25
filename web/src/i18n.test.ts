// ★★ UI code (.tsx and .ts) has no Japanese text left that bypasses `t()` (2026-09-23 / i18n).
//   ⚠️ If English is forgotten when adding text, Japanese shows on the English screen ⇒ fail here.
//   ★ Only "executed characters" are checked (comments and regexes excluded / `i18nScan.ts` reads tokens).
//   ★★ 2026-09-24: also checks `.ts` parts (functions that build labels, guidance text).
//      ⚠️ When only `.tsx` was checked, Japanese built in `.ts` showed as-is on the English screen.
//   ⚠️ A regex checking "preceded by `t(`" can't tell the second part of `t('a' + 'b', …)`, so count parenthesis nesting.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { scanJaLiterals } from './i18nScan.ts'
import { NOTIFY_PHRASES_EN } from '../../shared/i18n.ts'

const SRC = new URL('.', import.meta.url).pathname

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(p))
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/**
 * ★ Things allowed to stay Japanese (always give the reason). Key is `file (relative to src):contents`.
 */
const ALLOWED: ReadonlyMap<string, string> = new Map([
  // The language name itself (shown the same way on either screen)
  ['ui/Endpoints.tsx:日本語', 'name shown in the language switcher (written in its own language)'],
  // ★ 2026-09-24: agent approval-card text arrives structurally (`ui/agentText.ts`). Matching against old agents' Japanese
  //   uses `LEGACY_*` in `shared/types.ts`, so no Japanese needs to be added here for matching.
])

/**
 * ★ The form `export const X = '日本語'` used as `t(X, '…')` (named so tests can look at the Japanese text).
 *   ⚠️ Not allowed unless the name appears as `t(X,` in the same file (= otherwise it is shown directly).
 */
function namedForT(code: string, index: number): boolean {
  const before = code.slice(Math.max(0, index - 80), index)
  const m = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(before)
  if (!m) return false
  return new RegExp(`\\bt\\(\\s*${m[1]}\\s*,`).test(code)
}

function offenders(): string[] {
  const bad: string[] = []
  for (const f of sourceFiles(SRC)) {
    const rel = f.replace(SRC, '')
    const code = readFileSync(f, 'utf8')
    for (const lit of scanJaLiterals(code)) {
      if (lit.inEnglish) {
        bad.push(`${rel}:${lit.line}: Japanese on the English side 「${lit.text.slice(0, 40)}」`)
        continue
      }
      if (lit.inT) continue
      if (ALLOWED.has(`${rel}:${lit.text}`)) continue
      if (!lit.bare && namedForT(code, lit.index)) continue
      bad.push(`${rel}:${lit.line}: ${lit.bare ? 'JSX ' : ''}「${lit.text.slice(0, 40)}」`)
    }
  }
  return bad
}

test('★★ Japanese text in .tsx / .ts is always the first argument of t()', () => {
  const bad = offenders()
  assert.deepEqual(bad, [], `⚠️ Japanese not going through t():\n${bad.join('\n')}`)
})

test('★★ the scanner catches Japanese outside t(), Japanese on the English side and JSX text (the guard never goes silently blind)', () => {
  const src = [
    "const a = t('はい', 'Yes')",
    "const b = t('長い' + '文', 'Long ' + 'text')",
    "const c = '外'",
    "const d = t('日', 'に')",
    "const e = tIn(lang, '日', 'Day')",
    "const f = /正規表現/.test(x)",
    "// コメント",
    "const g = `${t('中', 'in')}と`",
    "const h = <p>{x}地の文</p>",
    "const i = x.t('点')",
  ].join('\n')
  const r = scanJaLiterals(src)
  const outside = r.filter((l) => !l.inT).map((l) => l.text)
  const english = r.filter((l) => l.inEnglish).map((l) => l.text)
  assert.deepEqual(outside, ['外', 'と', '地の文', '点'])
  assert.deepEqual(english, ['に'])
  // ★ Also catches full-width symbols/alphanumerics on the English side (even without kana/kanji / codex round 22, low #5)
  const wide = scanJaLiterals("t('はい', 'Yes（no）'); t('いいえ', 'Ｎｏ'); t('点', 'a・b'); const z = '（）'")
  assert.deepEqual(wide.filter((l) => l.inEnglish).map((l) => l.text), ['Yes（no）', 'Ｎｏ', 'a・b'])
  assert.ok(!wide.some((l) => l.text === '（）'), '⚠️ a symbols-only string outside t() is not UI text')
})

test('★ no dead rows in the allow list (if the allowance stays after a fix, the same text coming back would pass)', () => {
  const seen = new Set<string>()
  for (const f of sourceFiles(SRC)) {
    const rel = f.replace(SRC, '')
    for (const lit of scanJaLiterals(readFileSync(f, 'utf8'))) seen.add(`${rel}:${lit.text}`)
  }
  const dead = [...ALLOWED.keys()].filter((k) => !seen.has(k))
  assert.deepEqual(dead, [])
})

test('★★ Japanese in shared/ also goes through t() (thrown reasons appear on screen); the only exception is the notification vocabulary', () => {
  // ⚠️ The notification vocabulary (`statusLabel` etc.) is **deliberately kept in Japanese** and translated right before sending / showing
  //    (`localizeNotificationBody` / `web/src/ui/status.ts`) ⇒ only words in the table are allowed
  const vocab = new Set(NOTIFY_PHRASES_EN.map(([ja]) => ja))
  // ⚠️ Legacy approval-card text (`LEGACY_*` in `types.ts`). Old screens match against it, so it is **fixed in Japanese**
  //    (new screens show `t()` from `ui/agentText.ts`; this is read only for matching old agents)
  const legacyWire = new Set([
    'types.ts:サブエージェント',
    'types.ts:(不明)',
    'types.ts:このディレクトリを許可: ',
    'types.ts:このセッションのモードを ',
    'types.ts: にする',
  ])
  const dir = new URL('../../shared/', import.meta.url).pathname
  const bad: string[] = []
  for (const name of readdirSync(dir)) {
    // ⚠️ i18n.ts is the vocabulary table itself
    if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name === 'i18n.ts') continue
    for (const lit of scanJaLiterals(readFileSync(join(dir, name), 'utf8'))) {
      if (lit.inEnglish) bad.push(`${name}:${lit.line}: Japanese on the English side 「${lit.text.slice(0, 40)}」`)
      else if (!lit.inT && !vocab.has(lit.text) && !legacyWire.has(`${name}:${lit.text}`)) bad.push(`${name}:${lit.line}: 「${lit.text.slice(0, 40)}」`)
    }
  }
  assert.deepEqual(bad, [], `⚠️ Japanese not going through t():\n${bad.join('\n')}`)
})
