import { t } from '../../../shared/i18n.ts'

/**
 * ★ The cat that signals "responding". **The choice belongs to this device** (not stored on the agent / CLAUDE.md §2).
 *
 * ★★ **Adding one takes just one row in this table** (2026-09-16).
 *   ⚠️⚠️ Do **not infer asset properties** (pixel art or illustration, PNG or SVG, drawn at what scale)
 *      **from the id's spelling**. If inferred, the moment a cat with a different naming scheme is added,
 *      **the guard silently stops working** (in fact it first checked `id.startsWith('pixel')`).
 *   => The properties are **held by this table** (`art` / `file` / `scale`). `catPreference.test.ts`
 *      checks the assets and CSS **for every row of the table**.
 *
 * ⬜ **We may add the real Nyan Cat someday** (after asking the rights holders for permission / CLAUDE.md §2).
 *   Then add one row like `{ id: 'nyan-cat', label: '…', art: 'pixel', file: '/cats/nyan-cat.png', scale: 1 }`
 *   and add `[data-cat="nyan-cat"]` to the CSS.
 *   ⚠️ **That asset is made at 1x (`scale: 1`)**, so do not hard-code 2x (= that is what `scale` is for).
 */
export const CAT_CHOICES = [ // ⚠️ labels are getters (do not call `t()` at module top level)
  { id: 'mochi-cat', get label() { return t('もち白ねこ', 'Mochi white cat') }, art: 'illustration', file: '/cats/mochi-cat.png', scale: 2 },
  { id: 'fluffy-cat', get label() { return t('ふさしっぽ茶ねこ', 'Fluffy-tail brown cat') }, art: 'illustration', file: '/cats/fluffy-cat.png', scale: 2 },
  { id: 'tuxedo-cat', get label() { return t('しなやか黒ねこ', 'Sleek black cat') }, art: 'illustration', file: '/cats/tuxedo-cat.png', scale: 2 },
  { id: 'calico-cat', get label() { return t('ころころ三毛ねこ', 'Roly-poly calico') }, art: 'illustration', file: '/cats/calico-cat.png', scale: 2 },
  { id: 'pixel-tabby-cat', get label() { return t('ドット茶トラ', 'Pixel tabby') }, art: 'pixel', file: '/cats/pixel-tabby-cat.png', scale: 2 },
  { id: 'pixel-grey-cat', get label() { return t('ドットふわ灰ねこ', 'Pixel fluffy grey cat') }, art: 'pixel', file: '/cats/pixel-grey-cat.png', scale: 2 },
  { id: 'manul-cat', get label() { return t('ずしずしマヌルネコ', 'Hefty Pallas\'s cat') }, art: 'pixel', file: '/manul-cat.svg', scale: 1 },
] as const

export type Cat = (typeof CAT_CHOICES)[number]
export type CatId = Cat['id']

/** ⚠️ Protected name (CLAUDE.md §0). Changing it loses the chosen cat */
export const CAT_KEY = 'tmux-agent.status-cat.v1'

/** ⚠️ Unknown or broken values fall back to **the default cat** (never throws / may come from a camera or hand edits) */
export function catId(value: unknown): CatId {
  return CAT_CHOICES.find((cat) => cat.id === value)?.id ?? 'mochi-cat'
}

export function loadCat(): CatId {
  try {
    return catId(localStorage.getItem(CAT_KEY))
  } catch {
    // ⚠️ do not break the screen over this device's quirks (private mode, etc.)
    return 'mochi-cat'
  }
}

export function saveCat(value: CatId): void {
  try {
    localStorage.setItem(CAT_KEY, value)
  } catch {
    // ⚠️ even if it cannot be saved, the choice holds for this session
  }
}
