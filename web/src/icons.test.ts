// ★★ Icons (2026-09-24 / D enlarged, navy background, badge is E / `scripts/build-icons.cjs`).
//   ⚠️ Checks that referenced files exist, sizes match their declarations, and the badge is "only a white shape on a transparent background".
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { inflateSync } from 'node:zlib'

const PUB = new URL('../public/', import.meta.url)
const read = (p: string) => readFileSync(new URL(p.replace(/^\//, ''), PUB))

/** ★ Read a PNG (8-bit, non-interlaced, RGB/RGBA only / no added dependencies) */
function png(buf: Buffer): { w: number; h: number; channels: number; px: Uint8Array } {
  assert.equal(buf.subarray(1, 4).toString(), 'PNG')
  let off = 8
  let w = 0, h = 0, channels = 0
  const idat: Buffer[] = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.subarray(off + 4, off + 8).toString()
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      assert.equal(data[8], 8, 'only bit depth 8 is read')
      channels = { 2: 3, 6: 4 }[data[9]!] ?? 0
      assert.ok(channels, `color type ${data[9]} is not read`)
      assert.equal(data[12], 0, 'interlaced images are not read')
    }
    if (type === 'IDAT') idat.push(data)
    off += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * channels
  const px = new Uint8Array(h * stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!
    for (let x = 0; x < stride; x++) {
      const cur = raw[y * (stride + 1) + 1 + x]!
      const a = x >= channels ? px[y * stride + x - channels]! : 0
      const b = y > 0 ? px[(y - 1) * stride + x]! : 0
      const c = x >= channels && y > 0 ? px[(y - 1) * stride + x - channels]! : 0
      const p = a + b - c
      const pr = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c
      px[y * stride + x] = (cur + [0, a, b, (a + b) >> 1, pr][f]!) & 255
    }
  }
  return { w, h, channels, px }
}

test('★★ manifest icons: PNG, declared sizes, both any and maskable present', () => {
  const m = JSON.parse(read('/manifest.webmanifest').toString()) as { icons: { src: string; sizes: string; type: string; purpose: string }[]; background_color: string }
  for (const i of m.icons) {
    assert.equal(i.type, 'image/png', `⚠️ ${i.src} is not PNG (SVG doesn't work on iPhone and some Androids)`)
    const { w, h } = png(read(i.src))
    assert.equal(`${w}x${h}`, i.sizes, `⚠️ ${i.src} size differs from its declaration`)
  }
  for (const purpose of ['any', 'maskable']) {
    for (const size of ['192x192', '512x512']) {
      assert.ok(m.icons.some((i) => i.purpose === purpose && i.sizes === size), `⚠️ ${purpose} ${size} missing (required for install)`)
    }
  }
  // ★ The launch background color equals the icon background (BG in build-icons.cjs)
  const script = readFileSync(new URL('../../scripts/build-icons.cjs', import.meta.url), 'utf8')
  assert.ok(script.includes(`const BG = '${m.background_color}'`), `⚠️ launch background ${m.background_color} differs from the icon background`)
})

test('★★ iPhone icon is a 180px PNG (⚠️ iPhone cannot use SVG icons)', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const href = html.match(/<link rel="apple-touch-icon" href="([^"]+)"/)?.[1]
  assert.ok(href?.endsWith('.png'), `⚠️ apple-touch-icon is not PNG: ${href}`)
  const { w, h } = png(read(href!))
  assert.deepEqual([w, h], [180, 180])
  const fav = html.match(/<link rel="icon" href="([^"]+)"/)?.[1]
  assert.ok(fav && existsSync(new URL(fav.replace(/^\//, ''), PUB)), `⚠️ favicon missing: ${fav}`)
})

test('★★ the notification badge is "only a white shape on a transparent background" (color is ignored; a background becomes a white square)', () => {
  const core = readFileSync(new URL('../public/push-core.js', import.meta.url), 'utf8')
  const badge = core.match(/badge: '([^']+)'/)?.[1]
  const icon = core.match(/icon: '([^']+)'/)?.[1]
  assert.ok(badge)
  assert.ok(icon, '⚠️⚠️ no image on the right of the notification (Chrome inserts the origin initial "A" / real device 2026-09-24)')
  assert.ok(badge.endsWith('.png') && icon.endsWith('.png'), '⚠️ notification uses SVG (Android sometimes cannot draw it)')
  const ic = png(read(icon))
  assert.ok(ic.w >= 192 && ic.w === ic.h, `⚠️ notification image must be a square of at least 192px (web.dev): ${ic.w}x${ic.h}`)
  const b = png(read(badge))
  assert.equal(b.channels, 4, '⚠️ badge has no transparency')
  let opaque = 0, clear = 0, colored = 0
  for (let i = 0; i < b.w * b.h; i++) {
    const a = b.px[i * 4 + 3]!
    if (a === 0) clear++
    else {
      opaque++
      if (a > 128 && (b.px[i * 4]! < 240 || b.px[i * 4 + 1]! < 240 || b.px[i * 4 + 2]! < 240)) colored++
    }
  }
  assert.ok(clear > b.w * b.h * 0.3, '⚠️⚠️ badge background is not transparent (becomes a white square in the status bar)')
  assert.ok(opaque > b.w * b.h * 0.1, '⚠️ almost no shape')
  assert.equal(colored, 0, '⚠️ badge has non-white color (only the shape shows = color is wasted)')
})

test('★★ everything listed for the shell (offline) exists', () => {
  const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')
  const shell = sw.match(/const SHELL = \[([^\]]+)\]/)?.[1] ?? ''
  const extras = sw.match(/const EXTRAS = \[([^\]]+)\]/)?.[1] ?? ''
  assert.ok(extras.includes('/icons/notify-256.png') && extras.includes('/icons/badge-96.png'), '⚠️ notification images are not cached locally')
  for (const p of [...`${shell} ${extras}`.matchAll(/'(\/[^']+)'/g)].map((m) => m[1]!)) {
    if (p === '/index.html') continue
    assert.ok(existsSync(new URL(p.replace(/^\//, ''), PUB)), `⚠️ shell entry ${p} missing (install fails and the SW is not installed)`)
  }
})

test('★★ experimental pages are not shipped', () => {
  assert.equal(existsSync(new URL('webrtc-probe.html', PUB)), false, '⚠️ anyone could open it from the public origin')
})

test('★★ notification workers also fetch a new version when the screen opens (don\'t keep loading old icons)', () => {
  const panel = readFileSync(new URL('./ui/PushPanel.tsx', import.meta.url), 'utf8')
  assert.match(panel, /regs\.map\(\(r\) => r\.update\(\)\.catch\(\(\) => undefined\)\)/)
  // ⚠️⚠️ Don't wait (if it stalls, sync and device-count display stall too / codex round 21, medium #1)
  assert.match(panel, /void refreshWorkers\(\)\s*\n\s*await syncSubscription\(\)/, '⚠️ syncing after waiting for the update (if it stalls, sync stalls)')
  assert.doesNotMatch(panel, /await refreshWorkers\(\)/, '⚠️⚠️ waiting for the update')
})
