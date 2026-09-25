import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CAT_CHOICES, catId } from './catPreference.ts'

test('unknown cat preferences fall back to a drawable cat', () => {
  for (const value of [null, undefined, '', 'old-cat', '__proto__', {}, 1]) assert.equal(catId(value), 'mochi-cat')
  for (const cat of CAT_CHOICES) assert.equal(catId(cat.id), cat.id)
})

test('★★ every selectable cat has matching assets and CSS (checked per table row)', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
  const width = Number(/--nyan-w: (\d+)px/.exec(css)![1])
  const height = Number(/--nyan-h: (\d+)px/.exec(css)![1])
  const count = Number(/--nyan-frames: (\d+)/.exec(css)![1])
  for (const cat of CAT_CHOICES) {
    // ⚠️ the CSS points at **that cat's asset** (catches typos)
    assert.ok(css.includes(`url('${cat.file}')`), `${cat.id}: asset is not referenced from the CSS`)
    if (cat.file.endsWith('.svg')) {
      const svg = readFileSync(new URL(`../../public${cat.file}`, import.meta.url), 'utf8')
      assert.ok(svg.includes(`width="${width * count}"`), `${cat.id}: sheet width does not match`)
      // ⚠️ no external assets, no embedded scripts (would vanish offline / an XSS target)
      assert.doesNotMatch(svg, /<(?:image|script|animate)\b|\bhref=/, `${cat.id}: references something external`)
      continue
    }
    const png = readFileSync(new URL(`../../public${cat.file}`, import.meta.url))
    assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG', `${cat.id}: not a PNG`)
    // ⚠️⚠️ **the table holds the scale** (hard-coding 2x gives a false green the moment a 1x asset is added / codex round 6)
    assert.equal(png.readUInt32BE(16), width * count * cat.scale, `${cat.id}: sheet width does not match`)
    assert.equal(png.readUInt32BE(20), height * cat.scale, `${cat.id}: sheet height does not match`)
    assert.equal(png[25], 6, `${cat.id}: must be RGBA, otherwise a square background shows`)
  }
})


// ─────────────────────────────────────────────────────────────────────────────
// ★★ Added from here on 2026-09-16 (codex round 6, B).
//
//   ⚠️⚠️ **The wiring was never checked**: removing the save in `saveCat()` or making `loadCat()`
//      always return the default cat left **all 50 related tests green** (= a change where "choosing works
//      but a restart reverts it" would land green). ⚠️ Same for hard-coding `data-cat`, a selector typo, or deleting the manul's height.
//   ★ The recurring pattern in this repo: "**the unit is correct, but nobody checks the caller / where it takes effect**".
// ─────────────────────────────────────────────────────────────────────────────

import { CAT_KEY, loadCat, saveCat } from './catPreference.ts'

const CSS = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
const NYAN_TSX = readFileSync(new URL('./Nyan.tsx', import.meta.url), 'utf8')

/** ⚠️ A fake localStorage close to the real one (can also be made to throw) */
function fakeStorage(broken = false) {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => {
      if (broken) throw new Error('だめ')
      return m.get(k) ?? null
    },
    setItem: (k: string, v: string) => {
      if (broken) throw new Error('だめ')
      m.set(k, v)
    },
    seen: m,
  }
}

function withStorage<T>(store: unknown, fn: () => T): T {
  const had = 'localStorage' in globalThis
  const prev = (globalThis as { localStorage?: unknown }).localStorage
  ;(globalThis as { localStorage?: unknown }).localStorage = store
  try {
    return fn()
  } finally {
    if (had) (globalThis as { localStorage?: unknown }).localStorage = prev
    else delete (globalThis as { localStorage?: unknown }).localStorage
  }
}

test('★★ the chosen cat persists on the device (save wiring / codex round 6, B-1)', () => {
  const store = fakeStorage()
  withStorage(store, () => {
    assert.equal(loadCat(), 'mochi-cat', 'wrong default')
    saveCat('tuxedo-cat')
    // ⚠️⚠️ check **the stored value itself** (checking only `loadCat`'s return stays green even if saving is removed)
    assert.equal(store.seen.get(CAT_KEY), 'tuxedo-cat', '⚠️⚠️ not saved (reverts on restart)')
    assert.equal(loadCat(), 'tuxedo-cat', '⚠️⚠️ does not read what was saved')
  })
})

test('★★★ does not crash when localStorage is unavailable (device quirks must not break the screen)', () => {
  withStorage(fakeStorage(true), () => {
    assert.equal(loadCat(), 'mochi-cat')
    assert.doesNotThrow(() => saveCat('calico-cat'))
  })
})

test('★★ the view wiring (`data-cat` and saving) is in `Nyan.tsx` (B-1)', () => {
  // ⚠️ `.tsx` has no behavioral tests, so check **the wiring itself** mechanically (same approach as discipline.test.ts)
  assert.match(NYAN_TSX, /data-cat=\{selected\}/, '⚠️⚠️ the chosen cat is not reflected in `data-cat`')
  assert.match(NYAN_TSX, /saveCat\(next\)/, '⚠️⚠️ choosing does not save')
  assert.match(NYAN_TSX, /useState\(loadCat\)/, '⚠️ does not start from the saved value')
  // ⚠️⚠️ `running` is **required** (adding `?` allows "running while stopped" = a picture that lies about the state)
  assert.match(NYAN_TSX, /\n  running,\n\}: \{\n  running: boolean\n\}/, '⚠️⚠️ `running` is not required')
})

/** ★ Extracts the body of `[data-cat="…"] { … }` (⚠️ empty if absent) */
function catBlock(id: string): string {
  return new RegExp(`\\[data-cat="${id}"\\]\\s*\\{([^}]*)\\}`).exec(CSS)?.[1] ?? ''
}

test('★★ CSS `data-cat` maps 1:1 to selectable cats (catches typos and hard-coding / B-2)', () => {
  // ⚠️⚠️ a check for "the URL is somewhere in the CSS" stayed green even with a mistyped selector
  for (const cat of CAT_CHOICES) {
    if (cat.id === 'mochi-cat') continue // ★ it is the default, so it lives in `:root`
    const block = catBlock(cat.id)
    assert.ok(block.length > 0, `${cat.id}: no [data-cat] (choosing it changes nothing)`)
    assert.ok(
      block.includes(`/${cat.id}.png`) || block.includes(`/${cat.id}.svg`),
      `${cat.id}: [data-cat] does not point at its own asset`,
    )
  }
  // ⚠️ also catch leftovers (a selector for a removed cat confuses readers)
  const declared = [...CSS.matchAll(/\[data-cat="([^"]+)"\]/g)].map((m) => m[1])
  for (const id of new Set(declared)) {
    assert.ok(
      CAT_CHOICES.some((c) => c.id === id),
      `selector left for a cat that cannot be chosen: ${id}`,
    )
  }
})

test('★★ pixel-art cats keep crisp edges (`image-rendering` / B-2)', () => {
  // ⚠️⚠️ the guard was relaxed to `var(--nyan-rendering)`, so check **the value itself** here.
  //    The default is `auto` (illustrations stay smooth), so **only pixel assets** need `pixelated`.
  assert.match(CSS, /--nyan-rendering:\s*auto/, 'default is not smooth')
  for (const cat of CAT_CHOICES) {
    // ⚠️⚠️ **check by the property held in the table** (inferring from the id's spelling **silently stops working**
    //    the moment a cat with a different naming scheme is added / 2026-09-16)
    const block = cat.id === 'mochi-cat' ? '' : catBlock(cat.id)
    if (cat.art === 'pixel') {
      assert.match(block, /--nyan-rendering:\s*pixelated/, `${cat.id}: blurry (pixel art smears)`)
    } else {
      // ⚠️ check the reverse too (so it **fails if the table lies**). Rendering an illustration `pixelated`
      //    makes the scaled edges jagged and it looks like something else.
      assert.doesNotMatch(block, /--nyan-rendering:\s*pixelated/, `${cat.id}: an illustration treated as pixel art`)
    }
  }
})

test('★★ the manul has its own height (its sheet differs from the others / B-2)', () => {
  const svg = readFileSync(new URL('../../public/manul-cat.svg', import.meta.url), 'utf8')
  const h = /height="(\d+)"/.exec(svg)?.[1]
  assert.ok(h, 'SVG has no height')
  // ⚠️⚠️ removing the CSS override stretches it to the other cats' height (**squashed / stretched vertically**)
  assert.match(catBlock('manul-cat'), new RegExp(`--nyan-h:\\s*${h}px`), '⚠️ no height set for the manul')
})
