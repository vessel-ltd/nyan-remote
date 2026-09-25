// ★★ Theme (dark / light / 2026-09-24). Colors live in one place (the variables in `styles.css`); switching is `theme.ts`.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { applyTheme, asThemeChoice, type ThemeTarget } from './theme.ts'

const CSS = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

/** Contents from `sel {` to its matching `}` (one nesting level only) */
function block(from: number): string {
  const open = CSS.indexOf('{', from)
  let depth = 0
  for (let i = open; i < CSS.length; i++) {
    if (CSS[i] === '{') depth++
    else if (CSS[i] === '}' && --depth === 0) return CSS.slice(open + 1, i)
  }
  throw new Error('unclosed')
}

function vars(body: string): Map<string, string> {
  return new Map([...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]))
}

const dark = vars(block(CSS.indexOf(':root {')))
const lightMedia = vars(block(CSS.indexOf(":root:not([data-theme='dark'])")))
const lightManual = vars(block(CSS.indexOf(":root[data-theme='light']")))

test('★★ light values are identical in both places (following the OS / manual light)', () => {
  assert.ok(lightMedia.size > 10, 'light values not read (this check is running empty)')
  assert.deepEqual([...lightMedia], [...lightManual], '⚠️⚠️ colors differ between following the OS and manual choice')
})

test('★★ every color variable also exists for light (otherwise dark colors remain in light mode)', () => {
  const colorVars = [...dark].filter(([, v]) => /^(#|rgba?\(|color-mix)/.test(v)).map(([k]) => k)
  assert.ok(colorVars.length > 20)
  for (const k of colorVars) assert.ok(lightMedia.has(k), `⚠️⚠️ ${k} has no light value`)
})

test('★★ no hardcoded colors outside variables (only the agreed exceptions)', () => {
  // ★ Exceptions: filled buttons that can look the same in both themes (yellow approval, red auto-approve) and the camera feed background
  const ALLOWED = new Set(['#1a1400', '#e6ad3f', 'rgba(0, 0, 0, 0.18)', '#2a0000', '#e66a6a', '#000'])
  const lightEnd = CSS.indexOf(":root[data-theme='light']")
  const rest = CSS.slice(lightEnd + block(lightEnd).length)
    .split('\n')
    .filter((l) => !l.trim().startsWith('/*') && !l.trim().startsWith('*'))
    .join('\n')
  const found = [...rest.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)].map((m) => m[0])
  const bad = found.filter((c) => !ALLOWED.has(c))
  assert.deepEqual(bad, [], `⚠️⚠️ hardcoded colors (stand out / vanish in light ⇒ make them variables): ${bad.join(' ')}`)
})

test('★★ auto removes the marker and defers to the OS; manual sets it; chrome color is --bg after applying', () => {
  const log: string[] = []
  let bg = '#0b0d10'
  const target: ThemeTarget = {
    setDataTheme: (v) => {
      log.push(`theme=${v ?? '(なし)'}`)
      bg = v === 'light' ? '#f6f7f9' : '#0b0d10'
    },
    background: () => ` ${bg}`,
    setThemeColor: (c) => void log.push(`color=${c}`),
  }
  applyTheme('light', target)
  applyTheme('auto', target)
  applyTheme('dark', target)
  assert.deepEqual(log, ['theme=light', 'color=#f6f7f9', 'theme=(なし)', 'color=#0b0d10', 'theme=dark', 'color=#0b0d10'])
  // ⚠️ Unknown values mean auto (a broken saved value doesn't break the screen)
  for (const x of [null, '', 'blue', 1]) assert.equal(asThemeChoice(x), 'auto')
})

test('★★ theme is applied before drawing (imported early in main.tsx)', () => {
  const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')
  const at = main.indexOf("import './theme.ts'")
  assert.ok(at >= 0, '⚠️ theme.ts is not imported')
  assert.ok(at < main.indexOf("import { render } from 'preact'"), '⚠️ applied after render setup (brief dark flash)')
})

test('★★ saved theme is applied in index.html head before first paint; name and colors match theme.ts / CSS (codex round 19, low #4)', async () => {
  const { THEME_KEY } = await import('./theme.ts')
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const head = html.slice(0, html.indexOf('</head>'))
  assert.ok(head.includes(`localStorage.getItem('${THEME_KEY}')`), '⚠️⚠️ head does not read the saved theme (brief flash of the opposite color)')
  assert.ok(head.includes('<script>'), '⚠️ no script in head')
  // ⚠️ Colors match the CSS --bg (if they differ, only the chrome color is off)
  assert.ok(head.includes(`'${lightMedia.get('--bg')}'`), `⚠️ light chrome color differs from CSS: ${lightMedia.get('--bg')}`)
  assert.ok(head.includes(`'${dark.get('--bg')}'`), `⚠️ dark chrome color differs from CSS: ${dark.get('--bg')}`)
  assert.ok(head.includes(`content="${lightMedia.get('--bg')}" media="(prefers-color-scheme: light)"`))
  assert.ok(head.includes(`content="${dark.get('--bg')}" media="(prefers-color-scheme: dark)"`))
})

test('★★ actually running the head script applies the saved theme and chrome color (checked by behavior, not text)', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const head = html.slice(0, html.indexOf('</head>'))
  const code = head.slice(head.indexOf('<script>') + '<script>'.length, head.indexOf('</script>'))
  const run = (saved: string | null) => {
    const metas = [
      { attrs: new Map([['media', '(prefers-color-scheme: light)'], ['content', 'x']]) },
      { attrs: new Map([['media', '(prefers-color-scheme: dark)'], ['content', 'y']]) },
    ].map((m) => ({
      removeAttribute: (k: string) => void m.attrs.delete(k),
      setAttribute: (k: string, v: string) => void m.attrs.set(k, v),
      attrs: m.attrs,
    }))
    const dataset: Record<string, string> = {}
    const document = { documentElement: { dataset }, querySelectorAll: () => metas }
    const localStorage = { getItem: () => saved }
    new Function('document', 'localStorage', code)(document, localStorage)
    return { theme: dataset['theme'], metas: metas.map((m) => Object.fromEntries(m.attrs)) }
  }
  const dark = run('dark')
  assert.equal(dark.theme, 'dark', '⚠️⚠️ saved theme not applied')
  assert.deepEqual(dark.metas, [{ content: '#0b0d10' }, { content: '#0b0d10' }])
  assert.equal(run('light').theme, 'light')
  // ★ Auto (nothing saved) and broken values do nothing (defer to the device setting)
  assert.equal(run(null).theme, undefined)
  assert.equal(run('blue').theme, undefined)
})
