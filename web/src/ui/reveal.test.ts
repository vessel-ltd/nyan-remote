import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// ★ Wiring: the card never renders the command text without going through reveal
test('Permissions.tsx: summary and detail are only rendered through <Revealed>', () => {
  const src = readFileSync(new URL('./Permissions.tsx', import.meta.url), 'utf8')
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  assert.doesNotMatch(code, /(?<!=)\{\s*p\.summary\s*\}/, 'p.summary rendered directly')
  assert.doesNotMatch(code, /(?<!=)\{\s*p\.detail\s*\}/, 'p.detail rendered directly')
  assert.equal(code.match(/<Revealed text=\{p\.(summary|detail)\}/g)?.length, 3)
  // the warning also reads the agent's flag (checked on the uncut input)
  assert.match(code, /p\.hidden \|\| hasHidden\(p\.summary, p\.detail\)/)
  // the summary/detail calls use the default scope ('all' = markers + strict order)
  assert.doesNotMatch(code, /<Revealed text=\{p\.(summary|detail)\} scope=/)
  // ⚠️ the override lives on Revealed's own wrapper (a flex parent would not pass it down / codex)
  assert.match(code, /scope === 'all' \? <span class="permcode">\{parts\}<\/span>/)
  // choice texts mark direction controls (`\u202EON\u202C` must not read as "NO")
  for (const f of ['q.question', 'q.header', 'o.label', 'o.description']) {
    assert.match(code, new RegExp(`<Revealed text=\\{${f.replace('.', '\\.')}\\} scope="bidi" />`), f)
  }
  // the "cut" warning is outside the expanded block (visible without opening)
  const clipAt = code.indexOf('{p.detailClipped ?')
  assert.ok(clipAt > code.indexOf('</button>') && clipAt > code.lastIndexOf('<div class="permfull mono">'))
  assert.ok(clipAt < code.indexOf('{p.hidden ||'))
})

test('styles.css: .permcode forces strict left-to-right order', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
  const rule = css.match(/\.permcode\s*\{([^}]*)\}/)
  assert.ok(rule, '.permcode rule missing')
  assert.match(rule[1]!, /unicode-bidi:\s*bidi-override/)
  assert.match(rule[1]!, /direction:\s*ltr/)
})
