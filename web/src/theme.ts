// ★★ Screen theme (dark / light / 2026-09-24 / user request). **Import this early in `main.tsx`**
//   (apply before drawing = no dark flash on a light-mode device).
//
// - Default **follows the OS setting** (`prefers-color-scheme`; the `@media` in `styles.css` applies)
// - A manual choice sets `<html data-theme="light|dark">` (`:root[data-theme]` in `styles.css` wins)
// ⚠️ The storage name follows the browser-side convention (`tmux-agent.<name>.v1` / CLAUDE.md §0). ⚠️ Does not crash if unreadable (falls back to auto).
// ⚠️ Colors live in one place: the variables in `styles.css` (none here). The browser chrome color (`theme-color`) is read from `--bg`.

export const THEME_KEY = 'tmux-agent.theme.v1'

export type ThemeChoice = 'auto' | 'light' | 'dark'

export function asThemeChoice(x: unknown): ThemeChoice {
  return x === 'light' || x === 'dark' ? x : 'auto'
}

export function savedThemeChoice(): ThemeChoice {
  try {
    return asThemeChoice(localStorage.getItem(THEME_KEY))
  } catch {
    return 'auto'
  }
}

/** ★ Target to apply to (⚠️ shaped so tests can pass a fake) */
export interface ThemeTarget {
  setDataTheme(value: 'light' | 'dark' | undefined): void
  /** current `--bg` (⚠️ read after applying) */
  background(): string
  setThemeColor(color: string): void
}

/**
 * ★ Apply. `auto` removes the marker and leaves it to the OS.
 * ⚠️ Also align the browser chrome color (otherwise a black band remains above a light screen).
 */
export function applyTheme(choice: ThemeChoice, target: ThemeTarget): void {
  target.setDataTheme(choice === 'auto' ? undefined : choice)
  const bg = target.background().trim()
  if (bg) target.setThemeColor(bg)
}

function documentTarget(): ThemeTarget | undefined {
  const doc = globalThis.document
  if (!doc) return undefined
  return {
    setDataTheme(value) {
      if (value) doc.documentElement.dataset['theme'] = value
      else delete doc.documentElement.dataset['theme']
    },
    background: () => getComputedStyle(doc.documentElement).getPropertyValue('--bg'),
    setThemeColor(color) {
      // ★ Collapse to one (`index.html` has two matching the device setting ⇒ after applying, just one with the current color)
      const metas = [...doc.querySelectorAll('meta[name="theme-color"]')]
      const meta = metas[0] ?? doc.head.appendChild(doc.createElement('meta'))
      for (const m of metas.slice(1)) m.remove()
      meta.setAttribute('name', 'theme-color')
      meta.removeAttribute('media')
      meta.setAttribute('content', color)
    },
  }
}

/** ★ Manual choice ("auto" clears the saved value). ⚠️ No reload needed (colors are CSS variables, so they change in place) */
export function chooseTheme(choice: ThemeChoice): void {
  try {
    if (choice === 'auto') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, choice)
  } catch {
    // Even if saving fails, apply it for this load
  }
  const target = documentTarget()
  if (target) applyTheme(choice, target)
}

/** ★ Once at startup. ⚠️ While "auto", the chrome color also follows OS switches (dark at night, etc.) */
export function initTheme(): void {
  const target = documentTarget()
  if (!target) return
  applyTheme(savedThemeChoice(), target)
  try {
    globalThis.matchMedia?.('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (savedThemeChoice() === 'auto') applyTheme('auto', target)
    })
  } catch {
    // environment without matchMedia
  }
}

initTheme()
