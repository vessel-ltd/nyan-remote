// ★ Every "why it is broken" classification of state files is in the English table (`reasons.ts`).
//   ⚠️ A classification missing from the table shows up **in Japanese** on English screens and logs (not silently dropped, but a forgotten entry goes unnoticed).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { setLang } from '../../shared/i18n.ts'
import { REASON_EN, reasonText } from './reasons.ts'

const src = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')

/** The function body (up to the next top-level `function` / `export`) */
function body(text: string, fn: string): string {
  const start = text.indexOf(`function ${fn}(`)
  assert.ok(start >= 0, `${fn} not found`)
  const rest = text.slice(start + 1)
  const end = rest.search(/\n(export |async function |function |\/\*\*)/)
  return end < 0 ? rest : rest.slice(0, end)
}

function literals(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((m) => m[1]!)
}

test('★ every classification the producers build is in the English table', () => {
  const found = new Set<string>([
    ...literals(src('state.ts'), /reason: '([^']+)'/g),
    ...literals(body(src('config.ts'), 'validateConfig'), /return '([^']+)'/g),
    ...literals(body(src('autoApprove.ts'), 'structureProblem'), /return '([^']+)'/g),
    ...literals(body(src('devices.ts'), 'structureProblem'), /return '([^']+)'/g),
    ...literals(src('devices.ts'), /const reason = '([^']+)'/g),
    ...literals(body(src('deviceKey.ts'), 'structureProblem'), /return '([^']+)'/g),
    ...literals(src('deviceKey.ts'), /fail\('([^']+)'/g),
  ])
  // ⚠️ if nothing is picked up, the check is idle (do not read 0 as green)
  assert.ok(found.size >= 25, `too few classifications picked up: ${found.size}`)
  const missing = [...found].filter((r) => !(r in REASON_EN))
  assert.deepEqual(missing, [])
})

test('★ reasonText uses the current language (Japanese as is if not in the table)', () => {
  try {
    setLang('en')
    assert.equal(reasonText('JSON として読めません'), 'not valid JSON')
    assert.equal(reasonText('未知の分類'), '未知の分類')
    setLang('ja')
    assert.equal(reasonText('JSON として読めません'), 'JSON として読めません')
  } finally {
    setLang('ja')
  }
})

test('★★ English logs do not embed internal Japanese (reasons via reasonText, status words via logLabel / codex round 22, low #4)', () => {
  // ⚠️ even with t() on the outside, embedded values (`${broken.reason}` / `${label}`) are not translated
  const index = src('index.ts')
  assert.match(index, /Listening in refuse mode[^`]*\$\{reasonText\(broken\.reason\)\}/)
  const hook = src('routes/hook.ts')
  const raw = hook.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l) && /\$\{label\}/.test(l) && /\[hook\]|sentLabel =|not sent:/.test(l))
  assert.deepEqual(raw, [], '⚠️ log status words are not passed through logLabel')
})

test('★★ the agent version is read at startup (not deferred to the first /health / codex round 23, medium #3)', () => {
  const index = src('index.ts')
  const code = index.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l))
  const at = code.findIndex((l) => /^agentBuild\(\)$/.test(l.trim()))
  assert.ok(at >= 0, '⚠️ agentBuild() is not called at startup')
  // ⚠️ before starting to listen (fix it before any request arrives)
  assert.ok(at < code.findIndex((l) => /\.listen\(/.test(l)), '⚠️ read after starting to listen')
})
