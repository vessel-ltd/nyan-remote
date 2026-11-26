import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// ★ Wiring: the card never renders the command text without going through reveal
test('Permissions.tsx: summary and detail are only rendered through <Revealed>', () => {
  const src = readFileSync(new URL('./Permissions.tsx', import.meta.url), 'utf8')
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  assert.doesNotMatch(code, /(?<!=)\{\s*p\.summary\s*\}/, 'p.summary rendered directly')
  assert.doesNotMatch(code, /(?<!=)\{\s*p\.detail\s*\}/, 'p.detail rendered directly')
  assert.doesNotMatch(code, /(?<!=)\{\s*p\.cwd\s*\}/, 'p.cwd rendered directly')
  assert.equal(code.match(/<Revealed text=\{p\.(summary|detail)\}/g)?.length, 3)
  // ★ Where a Codex command runs is third-party text too (security review 2026-11-17)
  assert.equal(code.match(/<Revealed text=\{p\.cwd\}/g)?.length, 1)
  // the warning also reads the agent's flag (checked on the uncut input)
  assert.match(code, /p\.hidden \|\| hasHidden\(p\.summary, p\.detail, p\.cwd\)/)
  // the summary/detail calls use the default scope ('all' = markers + strict order)
  assert.doesNotMatch(code, /<Revealed text=\{p\.(summary|detail)\} scope=/)
  // ⚠️ the override lives on Revealed's own wrapper (a flex parent would not pass it down / codex)
  assert.match(code, /scope === 'all' \? <span class="permcode">\{parts\}<\/span>/)
  // choice texts mark direction controls (`\u202EON\u202C` must not read as "NO")
  for (const f of ['q.question', 'q.header', 'o.label', 'o.description']) {
    assert.match(code, new RegExp(`<Revealed text=\\{${f.replace('.', '\\.')}\\} scope="bidi" />`), f)
  }
  // ★ the full text line by line with a hanging indent (a wrapped part never starts at the margin / codex review)
  assert.match(code, /<div class="permfull mono"><Revealed text=\{p\.detail\} lines \/><\/div>/)
  assert.match(code, /text\.split\('\\n'\)\.map\(\(line, i\) => <div key=\{i\} class="permline">/)
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
  assert.match(css, /\.permline \{[^}]*padding-left: 2ch;[^}]*text-indent: -2ch;/)
  // the "cut" warning is outside the expanded block (visible without opening)
  const clipAt = code.indexOf('{p.detailClipped ?')
  assert.ok(clipAt > code.indexOf('</button>') && clipAt > code.lastIndexOf('<div class="permfull mono">'))
  assert.ok(clipAt < code.indexOf('{p.hidden ||'))
})

// ★★ A cut command asks once before Allow (2026-11-10 / user decision: confirm, not block)
test('Permissions.tsx: Allow on a cut command goes through the "not seen all of it" confirmation', () => {
  const src = readFileSync(new URL('./Permissions.tsx', import.meta.url), 'utf8')
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  // the plain Allow button branches on detailClipped before answering
  assert.match(code, /onClick=\{\(\) => \(p\.detailClipped \? setClippedAsk\(p\) : void answer\(p, 'allow'\)\)\}/)
  // no other plain `answer(p, 'allow')` (without answers) bypasses it
  assert.equal(code.match(/answer\(p, 'allow'\)/g)?.length, 1)
  // the confirmation answers the item it was opened for, and only while it is still listed
  assert.match(code, /void answer\(item, 'allow'\)/)
  assert.match(code, /clippedAsk && items\.some\(\(i\) => i\.endpointId === clippedAsk\.endpointId && i\.key === clippedAsk\.key\)/)
})

test('styles.css: .permcode forces strict left-to-right order', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
  const rule = css.match(/\.permcode\s*\{([^}]*)\}/)
  assert.ok(rule, '.permcode rule missing')
  assert.match(rule[1]!, /unicode-bidi:\s*bidi-override/)
  assert.match(rule[1]!, /direction:\s*ltr/)
})
