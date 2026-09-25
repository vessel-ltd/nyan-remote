// ★★ PWA language (2026-09-23 / `shared/i18n.ts`). **Import this first in `main.tsx`**
//   (decide before other modules build their text).
//
// - Manual choice (saved on this device) > device language (Japanese if the first of `navigator.languages` is ja, otherwise English)
// ⚠️ The storage name follows the browser-side convention (`tmux-agent.<name>.v1` / CLAUDE.md §0). ⚠️ Does not crash if unreadable (falls back to auto).

import { asLang, pickLang, setLang, type Lang } from '../../shared/i18n.ts'

export const LANG_KEY = 'tmux-agent.lang.v1'

export type LangChoice = Lang | 'auto'

export function savedLangChoice(): LangChoice {
  try {
    return asLang(localStorage.getItem(LANG_KEY)) ?? 'auto'
  } catch {
    return 'auto'
  }
}

export function deviceLanguages(): readonly string[] {
  const n = globalThis.navigator as { languages?: readonly string[]; language?: string } | undefined
  if (!n) return []
  if (Array.isArray(n.languages) && n.languages.length > 0) return n.languages
  return n.language ? [n.language] : []
}

/** ★ Once at startup. ⚠️ Also sets `<html lang>` (affects screen readers and font selection) */
export function initLang(): Lang {
  const choice = savedLangChoice()
  const lang = pickLang(choice === 'auto' ? undefined : choice, deviceLanguages())
  setLang(lang)
  try {
    document.documentElement.lang = lang
  } catch {
    // environment without document (tests)
  }
  return lang
}

/**
 * ★ Manual choice ("auto" clears the saved value). ⚠️ Applied by **reloading** (done by the caller).
 *   ⇒ More reliable than rebuilding all on-screen text (nothing can be missed). The notification language
 *     also aligns automatically via the registration check (`/push/status`) after reloading.
 */
export function chooseLang(choice: LangChoice): void {
  try {
    if (choice === 'auto') localStorage.removeItem(LANG_KEY)
    else localStorage.setItem(LANG_KEY, choice)
  } catch {
    // Even if saving fails, don't apply it for this load (it reverts on reload)
  }
}

initLang()
