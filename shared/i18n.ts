// ★★ Foundation for multiple languages (2026-09-23 / user decision: Japanese and English).
//
// ★ How to write: put **Japanese and English side by side** where the text is used (`t('接続先', 'Connections')`).
//   ⚠️ Do not invent key names (when the dictionary and the call site are apart, fixing one lets them drift). A missing English side fails the type check.
// ★ How the language is decided:
//   - PWA … the device language (ja if Japanese, otherwise en) + a manual switch (`web/src/lang.ts`)
//   - Text the agent returns … **the language of the phone that sent that request** (the PWA adds `lang` to requests ⇒
//     the agent answers in that language only while handling it / `agent/src/serve.ts`). Without it, Japanese (as before)
//   - Notifications … **a language per subscription** (the PWA passes it on registration). Decisions inside the agent (dedup, whether to ring)
//     are made on the Japanese text, and it is **translated right before sending** (`localizeNotificationBody`)
// ⚠️ Logs (console) are out of scope (read by the PC owner ⇒ next step, together with the CLI).

export type Lang = 'ja' | 'en'

export function asLang(x: unknown): Lang | undefined {
  return x === 'ja' || x === 'en' ? x : undefined
}

/**
 * ★ Decide the language. A manual choice wins; otherwise the device language (Japanese if it starts with `ja`, English otherwise).
 * ⚠️ If nothing is known, Japanese (do not change the existing behaviour).
 */
export function pickLang(pref: unknown, languages: readonly string[] | undefined): Lang {
  const p = asLang(pref)
  if (p) return p
  const first = languages?.find((l) => typeof l === 'string' && l.length > 0)
  if (first === undefined) return 'ja'
  return first.toLowerCase().startsWith('ja') ? 'ja' : 'en'
}

/**
 * ★★★★ Language from the environment (CLI tools and the agent process / 2026-09-24).
 *   NYAN_LANG > LC_ALL > LC_MESSAGES > LANG. Starts with `ja` ⇒ Japanese, **anything else (unset / C) ⇒ English**.
 * ⚠️ The PWA does not use this (it follows the device language: `pickLang`).
 */
export function langFromEnv(env: Record<string, string | undefined>): Lang {
  // ★ the first non-empty one decides — NYAN_LANG included (`NYAN_LANG=ja_JP.UTF-8` is Japanese, `NYAN_LANG=fr` is English)
  const loc = [env['NYAN_LANG'], env['LC_ALL'], env['LC_MESSAGES'], env['LANG']].find((v) => typeof v === 'string' && v !== '')
  return loc && loc.toLowerCase().startsWith('ja') ? 'ja' : 'en'
}

let current: Lang = 'ja'
let provider: (() => Lang | undefined) | undefined

/** ★ Language of this runtime (the PWA sets it once at startup; the agent stays on the default Japanese) */
export function setLang(lang: Lang): void {
  current = lang
}

/**
 * ★ Hook that returns the per-request language (the agent passes an `AsyncLocalStorage`).
 * ⚠️ If it returns undefined, falls back to the `setLang` value.
 */
export function setLangProvider(fn: (() => Lang | undefined) | undefined): void {
  provider = fn
}

export function currentLang(): Lang {
  return provider?.() ?? current
}

/** ★ Pick the text. ⚠️ Looks at the current language on every call (calling it at module top level freezes the startup language) */
export function t(ja: string, en: string): string {
  return currentLang() === 'en' ? en : ja
}

/** ★ Pick with an explicit language (for places where the language differs per recipient, such as notifications) */
export function tIn(lang: Lang, ja: string, en: string): string {
  return lang === 'en' ? en : ja
}

/**
 * ★ From a bilingual "English / Japanese" sentence (relay close reasons / `REASON` in `relay/src/room.ts`), take only the side for the current language.
 *   ⚠️ relay does not know the peer's language, so it sends both. Shown as-is, English users would see the Japanese half.
 *   ⚠️ Anything in a different shape (no separator, Japanese on the left) is returned unchanged (old relays send Japanese only).
 */
export function pickBilingual(text: string, lang: Lang = currentLang()): string {
  const i = text.indexOf(' / ')
  if (i <= 0) return text
  const en = text.slice(0, i)
  const ja = text.slice(i + 3)
  if (/[぀-ヿ一-鿿]/.test(en) || !/[぀-ヿ一-鿿]/.test(ja)) return text
  return lang === 'en' ? en : ja
}

// ── Vocabulary of the notification's second line (state and reason) ─────────────────────────
//
// ⚠️⚠️ The notification's **first line (the session title) is never translated** (user content). Only the fixed words of the second line are.
// ⚠️ The vocabulary is `statusLabel` / `UNKNOWN_LABEL` / `waitingReason` / the approval, auto-approve and test notification texts.
//    When adding one, **add it here too** (`shared/i18n.test.ts` checks that no word outside the table is left).

export const NOTIFY_PHRASES_EN: readonly (readonly [string, string])[] = [
  ['背景で実行中', 'Running in background'],
  ['⚠ 異常終了', '⚠ Failed'],
  ['自動承認 終了', 'Auto-approve ended'],
  ['承認プロンプト', 'permission prompt'],
  ['sandbox の許可', 'sandbox permission'],
  ['worker の要求', 'worker request'],
  ['テスト通知', 'Test notification'],
  ['（音あり）', ' (with sound)'],
  ['（無音）', ' (silent)'],
  ['入力が必要', 'input needed'],
  ['目標の提案', 'goal proposal'],
  ['ダイアログ', 'dialog'],
  ['承認待ち', 'Approval needed'],
  ['状態不明', 'Unknown'],
  ['応答中', 'Working'],
  ['要対応', 'Needs you'],
  ['制限中', 'Rate-limited'],
  ['起動中', 'Idle'],
  ['完了', 'Done'],
]

/**
 * ★ Translate the notification's second line (⚠️ replace longer words first = short words do not eat part of longer ones).
 * ⚠️ Full-width brackets are converted to English typesetting (`要対応（承認プロンプト）· PC-B` → `Needs you (permission prompt) · PC-B`).
 * ★★ **Only the first segment of line 1 (before `·`) = state and reason is translated** (2026-09-24 / codex round 17, low #5).
 *   ⚠️⚠️ Replacing across the whole body would rewrite identifiers when a **machine, account or project name** (line 2)
 *   contains a state word (`完了通知` → `Done通知`). Assembly happens in `notificationText` (the state always comes first).
 */
export function localizeNotificationBody(body: string, lang: Lang): string {
  if (lang === 'ja') return body
  const nl = body.indexOf('\n')
  const line = nl < 0 ? body : body.slice(0, nl)
  // ⚠️ The separator is `· ` (`joinParts` omits the preceding space only after a full-width bracket = searching for ` · ` misses lines with a reason)
  const sep = line.indexOf('· ')
  const head = sep < 0 ? line : line.slice(0, sep)
  const rest = body.slice(head.length)
  // ★ After a full-width bracket the separator has no space (`）· `) ⇒ restore ` · ` for English typesetting
  return localizeHead(head) + (head.endsWith('）') && rest.startsWith('·') ? ' ' : '') + rest
}

function localizeHead(head: string): string {
  let out = head
  const phrases = [...NOTIFY_PHRASES_EN].sort((a, b) => b[0].length - a[0].length)
  for (const [ja, en] of phrases) out = out.split(ja).join(en)
  return out.replace(/（/g, ' (').replace(/）·/g, ') ·').replace(/）/g, ')')
}
