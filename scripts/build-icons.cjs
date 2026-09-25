// ★★ Build the app icon and the notification badge (2026-09-24 / user decision: the icon is **A3-3 (calico cat leaping out of the screen) on black**, the badge is E).
//   ⚠️ Initially D (resting on a terminal) on navy, but it looked small in the round mask, so codex redrew the A composition (`docs/icon-concepts/a3/`).
//
//   node scripts/build-icons.cjs
//
// ★ The source art was made by codex's built-in image generation (`docs/icon-concepts/`; history and prompts in README.md).
// ⚠️ A build-time-only tool (`sharp` is a relay dev dependency = never in the distribution or the agent's runtime dependencies).
// ⚠️ Output goes to `web/public/icons/` (served as-is by the PWA). The source art is not modified.

const sharp = require('../relay/node_modules/sharp')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'docs', 'icon-concepts')
const OUT = path.join(ROOT, 'web', 'public', 'icons')
/** ★ Icon background color (black = same as the app's dark background / 2026-09-24 user choice). ⚠️ Same as the manifest's background_color (`icons.test.ts` checks it) */
const BG = '#0b0d10'
/** ★ Source art (A3-3 on black, drawn by codex's built-in image generation. Safe-zone check in `docs/icon-concepts/a3/validation.json`) */
const SOURCE = path.join(SRC, 'a3', 'a3-3-black-1024.png')
/** ★ Share of the rounded square (iPhone, Android "any") taken by the art */
const FILL_ANY = 0.86
/** ★ maskable safe zone (W3C: circle of radius 40% from the center). ⚠️ **Every pixel** of the art must fit in it (with a little margin) */
const SAFE_R = 0.4 * 0.97

async function foreground() {
  // Extract the foreground by removing pixels close to the background color
  const { data, info } = await sharp(SOURCE).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width: w, height: h } = info
  const bg = [data[0], data[1], data[2]]
  const rgba = Buffer.alloc(w * h * 4)
  let minX = w, minY = h, maxX = 0, maxY = 0
  for (let p = 0; p < w * h; p++) {
    const d = Math.max(...bg.map((c, k) => Math.abs(c - data[p * 3 + k])))
    for (let k = 0; k < 3; k++) rgba[p * 4 + k] = data[p * 3 + k]
    rgba[p * 4 + 3] = d < 30 ? 0 : 255
    if (d >= 30) {
      const x = p % w, y = (p / w) | 0
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    }
  }
  const cw = maxX - minX + 1, ch = maxY - minY + 1
  // ★ Distance from the foreground center to the farthest pixel (decides the maskable size)
  let far = 0
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
  for (let p = 0; p < w * h; p++) if (rgba[p * 4 + 3]) far = Math.max(far, Math.hypot((p % w) - cx, ((p / w) | 0) - cy))
  const png = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).extract({ left: minX, top: minY, width: cw, height: ch }).png().toBuffer()
  return { png, cw, ch, far }
}

async function compose(fg, scale, size) {
  const nw = Math.round(fg.cw * scale * (size / 1024)), nh = Math.round(fg.ch * scale * (size / 1024))
  const art = await sharp(fg.png).resize(nw, nh).png().toBuffer()
  return sharp({ create: { width: size, height: size, channels: 3, background: BG } })
    .composite([{ input: art, left: Math.round((size - nw) / 2), top: Math.round((size - nh) / 2) }])
    .png()
}

;(async () => {
  // ★ Decide the language before building messages (CommonJS, so load it with dynamic import)
  const { initCliLang } = await import('./lib/lang.mjs')
  const { t } = await import('../shared/i18n.ts')
  initCliLang()
  fs.mkdirSync(OUT, { recursive: true })
  const fg = await foreground()
  const anyScale = (1024 * FILL_ANY) / Math.max(fg.cw, fg.ch)
  const maskScale = (1024 * SAFE_R) / fg.far
  const out = []
  for (const size of [512, 192]) {
    await (await compose(fg, anyScale, size)).toFile(path.join(OUT, `icon-any-${size}.png`))
    await (await compose(fg, maskScale, size)).toFile(path.join(OUT, `icon-maskable-${size}.png`))
    out.push(`icon-any-${size}.png`, `icon-maskable-${size}.png`)
  }
  // ★ iPhone (home screen, notifications): iOS rounds the corners ⇒ keep it square
  await (await compose(fg, anyScale, 180)).toFile(path.join(OUT, 'apple-touch-icon-180.png'))
  // ★ Browser tab
  await (await compose(fg, anyScale, 64)).toFile(path.join(OUT, 'favicon-64.png'))
  out.push('apple-touch-icon-180.png', 'favicon-64.png')
  // ★★ Image on the right of a notification (Android **crops it round**): fill the circle (radius 47%). 256px (web.dev: 192px or more; 256px is what all browsers agree on)
  //   ⚠️ Without it Chrome shows the origin's initial ("A") ⇒ provide it (checked on a real device 2026-09-24)
  await (await compose(fg, (1024 * 0.47) / fg.far, 256)).toFile(path.join(OUT, 'notify-256.png'))
  out.push('notify-256.png')
  // ★★ Notification badge (Android status bar): **only a white shape on transparent** (E / a leaping cat)
  //   ⚠️ Colors are ignored (only the shape shows) ⇒ fill white and carry the shape in alpha
  const alpha = await sharp(path.join(SRC, 'sources', 'e-badge.png')).ensureAlpha()
    .resize(96, 96, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .extractChannel('alpha').raw().toBuffer()
  await sharp({ create: { width: 96, height: 96, channels: 3, background: '#ffffff' } })
    .joinChannel(alpha, { raw: { width: 96, height: 96, channels: 1 } })
    .png().toFile(path.join(OUT, 'badge-96.png'))
  out.push('badge-96.png')
  const radius = (fg.far * maskScale / 1024 * 100).toFixed(1)
  const fill = (FILL_ANY * 100).toFixed(0)
  console.log(t(`maskable: 絵の半径 ${radius}%（安全域 40%）/ any: 絵の大きさ ${fill}%`, `maskable: art radius ${radius}% (safe zone 40%) / any: art size ${fill}%`))
  console.log(out.map((f) => `  web/public/icons/${f}`).join('\n'))
})()
