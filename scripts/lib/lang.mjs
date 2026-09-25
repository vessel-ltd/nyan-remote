// ★★★★ Language for command-line tools and the agent (2026-09-24 / user: "foreign users must not hit Japanese").
//
//   NYAN_LANG > LC_ALL > LC_MESSAGES > LANG — the first one that is set (non-empty).
//   Starts with `ja` ⇒ Japanese. **Anything else (including unset / C) ⇒ English.**
// ⚠️ Call `initCliLang()` at the very top of a script, **before** building any message
//    (`t()` at module top level freezes the default language).

import { currentLang, langFromEnv, setLang } from '../../shared/i18n.ts'

/** ★ The rule itself lives in `shared/i18n.ts` (`langFromEnv`) so the agent uses the same one */
export function cliLang(env = process.env) {
  return langFromEnv(env)
}

/** ★ Decide the language for this process (call once, first thing) */
export function initCliLang(env = process.env) {
  const lang = cliLang(env)
  setLang(lang)
  return lang
}

/**
 * ★ URL of the local agent, **carrying this tool's language** (`?lang=`).
 *   ⚠️ Without it the agent answers in *its own* language (the machine's), so `NYAN_LANG=en nyan devices`
 *      mixed Japanese reasons into English output (codex round 22, medium 1).
 */
export function agentUrl(port, path) {
  const u = new URL(path, `http://127.0.0.1:${port}`)
  u.searchParams.set('lang', currentLang())
  return u.href
}
