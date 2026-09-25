// ★★ Verification of our own QR reader (2026-09-24).
//   ⚠️ Reader correctness is judged by "can a QR made by the drawing side (`qr.ts`) be read back after **distorting it like a photo**"
//      (tilt, perspective, blur, noise, uneven lighting, background patterns, dirt = error correction).
//   ⚠️⚠️ **The final check is a real device** (can the iPhone camera read it). This is not filled in automatically.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeQr, qrSize, type Qr } from './qr.ts'
import { decodeGrid, decodeQrImage, quadToQuad, rsCorrect, type Point, type RgbaImage } from './qrDecode.ts'
import { rsEncode } from './qr.ts'

// ★ Text with the same length and shape as the pairing QR (it becomes version 10)
const PAIR = `nyan://pair?v=1&a=${'B'.repeat(87)}&t=${'T'.repeat(43)}&n=DESKTOP&r=wss%3A%2F%2Frelay.nyan-remote.app&u=https%3A%2F%2Fdesktop.tail0a1b2c.ts.net`

/** Deterministic randomness (the same distortion every time = reproducible on failure) */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

interface RenderOpts {
  /** Image size */
  w?: number
  h?: number
  /** Where the four corners of the board (margin included) land in the image (top left, top right, bottom right, bottom left) */
  corners?: Point[]
  /** Noise strength (0-255) */
  noise?: number
  /** Uneven lighting (how much it darkens from left → right) */
  gradient?: number
  /** Dark and light values */
  dark?: number
  light?: number
  /** How many samples to average per pixel (blur) */
  samples?: number
  /** Scatter patterns over the background */
  clutter?: boolean
  seed?: number
}

const QUIET = 4

function render(qr: Qr, o: RenderOpts = {}): RgbaImage {
  const w = o.w ?? 640
  const h = o.h ?? 480
  const N = qr.size + QUIET * 2
  const corners = o.corners ?? [
    { x: 170, y: 90 },
    { x: 470, y: 90 },
    { x: 470, y: 390 },
    { x: 170, y: 390 },
  ]
  // Image → board (module coordinates including the margin)
  const inv = quadToQuad(corners, [
    { x: 0, y: 0 },
    { x: N, y: 0 },
    { x: N, y: N },
    { x: 0, y: N },
  ])
  const rand = rng(o.seed ?? 1)
  const dark = o.dark ?? 20
  const light = o.light ?? 235
  const ss = o.samples ?? 2
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const p = inv(x + (sx + 0.5) / ss, y + (sy + 0.5) / ss)
          const mx = Math.floor(p.x) - QUIET
          const my = Math.floor(p.y) - QUIET
          let v: number
          if (p.x >= 0 && p.y >= 0 && p.x < N && p.y < N) {
            v = mx >= 0 && my >= 0 && mx < qr.size && my < qr.size && qr.modules[my]![mx] ? dark : light
          } else if (o.clutter) {
            // Background patterns (stripes and spots = easily produce accidental 1:1:3:1:1)
            v = (Math.floor(x / 7) + Math.floor(y / 11)) % 3 === 0 ? 60 : 180
          } else {
            v = 128
          }
          acc += v
        }
      }
      let v = acc / (ss * ss)
      v -= ((o.gradient ?? 0) * x) / w
      v += (rand() - 0.5) * 2 * (o.noise ?? 0)
      const i = (y * w + x) * 4
      data[i] = data[i + 1] = data[i + 2] = v
      data[i + 3] = 255
    }
  }
  return { data, width: w, height: h }
}

function rotated(cx: number, cy: number, half: number, deg: number): Point[] {
  const r = (deg * Math.PI) / 180
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([sx, sy]) => ({
    x: cx + (sx! * Math.cos(r) - sy! * Math.sin(r)) * half,
    y: cy + (sx! * Math.sin(r) + sy! * Math.cos(r)) * half,
  }))
}

const qr = makeQr(PAIR)!

test('★ premise: the pairing QR is version 10 (the size the reader deals with)', () => {
  assert.equal(qr.version, 10)
})

test('★★ straight from the board: a drawn QR reads back as-is (short, long, Japanese)', () => {
  for (const text of ['A', 'hello', PAIR, 'スマホ 🐈 nyan', 'x'.repeat(300)]) {
    const q = makeQr(text)!
    assert.equal(decodeGrid(q.modules), text, `version ${q.version}`)
  }
})

test('★★ error correction: fixes up to the correctable count per block, unreadable beyond it (never returns false text)', () => {
  const data = new Uint8Array(Array.from({ length: 68 }, (_, i) => (i * 37 + 11) & 255))
  const ec = rsEncode(data, 18)
  const block = new Uint8Array([...data, ...ec])
  for (let errors = 0; errors <= 9; errors++) {
    const broken = block.slice()
    for (let k = 0; k < errors; k++) broken[(k * 7 + 3) % broken.length]! ^= 0x5a + k
    assert.deepEqual(rsCorrect(broken, 18), block, `${errors} errors`)
  }
  const tooMany = block.slice()
  for (let k = 0; k < 12; k++) tooMany[k * 5]! ^= 0xa5
  const got = rsCorrect(tooMany, 18)
  assert.ok(got === undefined || got.some((b, i) => b !== block[i]), '⚠️ claimed to restore it despite an uncorrectable count')
})

test('★★ readable even with a dirty board (data modules flipped at scattered spots)', () => {
  const rand = rng(7)
  const m = qr.modules.map((row) => row.slice())
  let flipped = 0
  const n = qrSize(qr.version)
  while (flipped < 25) {
    const x = Math.floor(rand() * n)
    const y = Math.floor(rand() * n)
    // ⚠️ Avoid the finders and format information (those are tested at the image stage)
    if ((x < 9 && y < 9) || (x > n - 9 && y < 9) || (x < 9 && y > n - 9)) continue
    m[y]![x] = !m[y]![x]
    flipped++
  }
  assert.equal(decodeGrid(m), PAIR)
})

test('★★ from an image: straight, smaller, larger', () => {
  assert.equal(decodeQrImage(render(qr)), PAIR)
  // 1 module ≈ 3.3 pixels (from far away)
  assert.equal(decodeQrImage(render(qr, { corners: rotated(320, 240, 110, 0) })), PAIR)
  // Filling the screen
  assert.equal(decodeQrImage(render(qr, { corners: rotated(320, 240, 230, 0) })), PAIR)
})

test('★★ from an image: rotation (90°, 180°, 270° and oblique)', () => {
  for (const deg of [90, 180, 270, 12, -25, 40, 135]) {
    assert.equal(decodeQrImage(render(qr, { corners: rotated(320, 240, 160, deg) })), PAIR, `${deg}°`)
  }
})

test('★★ from an image: shot at an angle (perspective)', () => {
  const tilted = [
    { x: 190, y: 70 },
    { x: 480, y: 110 },
    { x: 450, y: 400 },
    { x: 160, y: 380 },
  ]
  assert.equal(decodeQrImage(render(qr, { corners: tilted })), PAIR)
  const keystone = [
    { x: 220, y: 80 },
    { x: 420, y: 80 },
    { x: 480, y: 400 },
    { x: 160, y: 400 },
  ]
  assert.equal(decodeQrImage(render(qr, { corners: keystone })), PAIR)
})

test('★★ from an image: blur, noise, uneven lighting, faint (black is not black when photographing a screen)', () => {
  assert.equal(decodeQrImage(render(qr, { samples: 4, noise: 40, seed: 3 })), PAIR)
  assert.equal(decodeQrImage(render(qr, { gradient: 120 })), PAIR)
  assert.equal(decodeQrImage(render(qr, { dark: 90, light: 170, noise: 15, seed: 5 })), PAIR)
})

test('★★ from an image: readable even with a background full of patterns', () => {
  assert.equal(decodeQrImage(render(qr, { clutter: true, corners: rotated(320, 240, 150, 8) })), PAIR)
})

test('★★ a mirrored QR (front camera) is readable too', () => {
  const mirrored = rotated(320, 240, 160, 0)
  // Swap left and right
  const flipped = [mirrored[1]!, mirrored[0]!, mirrored[3]!, mirrored[2]!]
  assert.equal(decodeQrImage(render(qr, { corners: flipped })), PAIR)
})

test('★★ unreadable input gives undefined (never throws)', () => {
  const blank = { data: new Uint8ClampedArray(320 * 240 * 4).fill(200), width: 320, height: 240 }
  assert.equal(decodeQrImage(blank), undefined)
  const rand = rng(9)
  const noise = { data: Uint8ClampedArray.from({ length: 320 * 240 * 4 }, () => rand() * 255), width: 320, height: 240 }
  assert.equal(decodeQrImage(noise), undefined)
  assert.equal(decodeQrImage({ data: new Uint8ClampedArray(4), width: 1, height: 1 }), undefined)
  assert.equal(decodeQrImage({ data: new Uint8ClampedArray(0), width: 640, height: 480 }), undefined, '⚠️ size and data do not match')
  assert.equal(decodeGrid([[true]]), undefined)
})

test('★ speed: reads a 640×480 frame well within the 200 ms interval', () => {
  const img = render(qr, { corners: rotated(320, 240, 160, 20), noise: 20 })
  const start = performance.now()
  for (let i = 0; i < 5; i++) assert.equal(decodeQrImage(img), PAIR)
  const each = (performance.now() - start) / 5
  // ⚠️ iPhones are slower than PCs ⇒ aim for within 60 ms on a PC (the interval is 200 ms)
  assert.ok(each < 60, `${each.toFixed(1)}ms per frame`)
})

test('★★ reads almost all of many distortions (rotation, perspective, noise, unevenness, faintness, background)', () => {
  // ⚠️ Deterministic randomness = the same 60 images every time. 58/60 as of 2026-09-24 (the two failures are about 3 px per module + heavy noise).
  //   ⚠️ Do not lower the floor to make it pass (it signals that reading got weaker)
  const r = rng(42)
  let ok = 0
  let tried = 0
  for (let i = 0; i < 200 && tried < 60; i++) {
    const half = 90 + r() * 140
    const deg = r() * 360
    const cx = 320 + (r() - 0.5) * 80
    const cy = 240 + (r() - 0.5) * 60
    const c = rotated(cx, cy, half, deg).map((p) => ({ x: p.x + (r() - 0.5) * half * 0.35, y: p.y + (r() - 0.5) * half * 0.35 }))
    const o: RenderOpts = {
      corners: c,
      noise: r() * 35,
      gradient: r() * 100,
      samples: 2 + Math.floor(r() * 2),
      seed: i,
      clutter: r() < 0.3,
      dark: 20 + r() * 60,
      light: 180 + r() * 60,
    }
    // ⚠️ A QR that goes off the edge is naturally unreadable ⇒ not counted
    if (c.some((p) => p.x < 0 || p.y < 0 || p.x > 640 || p.y > 480)) continue
    tried++
    if (decodeQrImage(render(qr, o)) === PAIR) ok++
  }
  assert.equal(tried, 60)
  assert.ok(ok >= 58, `${ok}/60`)
})

/** Tile 7×7 finder-like patterns every `step` pixels (`rows` rows / `px` pixels per module) */
function tileFinders(img: RgbaImage, rows: number, px = 1, step = 9): void {
  const d = img.data as Uint8ClampedArray
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < img.width; x++) {
      const cx = Math.floor(x / px) % step
      const cy = Math.floor(y / px) % step
      const dark = cx < 7 && cy < 7 && Math.max(Math.abs(cx - 3), Math.abs(cy - 3)) !== 2
      const v = dark ? 0 : 255
      const i = (y * img.width + x) * 4
      d[i] = d[i + 1] = d[i + 2] = v
    }
  }
}

test('★★ does not freeze even when finder-like patterns fill the screen (codex round 23, medium #4 = originally about 220 ms per frame)', () => {
  const img: RgbaImage = { data: new Uint8ClampedArray(960 * 720 * 4).fill(255), width: 960, height: 720 }
  tileFinders(img, 720)
  decodeQrImage(img)
  const start = performance.now()
  assert.equal(decodeQrImage(img), undefined)
  const took = performance.now() - start
  assert.ok(took < 120, `${took.toFixed(0)}ms per frame`)
})

test('★★ reads the real one at the bottom even when the top is full of lookalikes (⚠️ a small candidate limit would miss it)', () => {
  const img = render(qr, { w: 640, h: 640, corners: rotated(320, 440, 150, 0) })
  tileFinders(img, 250)
  assert.equal(decodeQrImage(img), PAIR)
})

test('★★ merging candidates: a small candidate near a large one, and a candidate that moved across cells, are both found (codex round 24, medium #5)', async () => {
  const { finderIndex } = await import('./qrDecode.ts')
  // ① The codex example: size 1 at (120,64) near an existing (64,64, size 32) ⇒ satisfies the merge condition (56 ≤ 64)
  const a = finderIndex(640)
  a.add(64, 64, 32)
  a.add(120, 64, 1)
  assert.equal(a.found.length, 1, '⚠️⚠️ the search radius was set by the new candidate size, and it was added as a separate entry')
  // ② A candidate that averaging moved right across a cell boundary can be found from near where it moved
  const b = finderIndex(640)
  b.add(10, 10, 4)
  // Each hit is "slightly right of the current average" ⇒ the average creeps right, several cells away from the first one
  for (let i = 0; i < 300; i++) b.add(b.found[0]!.x + 7.9, 10, 4)
  assert.equal(b.found.length, 1)
  assert.ok(b.found[0]!.x > 10 + 16 * 2, `did not move far enough (premise of the test itself): ${b.found[0]!.x}`)
  // ★ Arriving from near the new position still gives the same candidate (⚠️ without re-filing, the first cell falls outside the search range and it becomes separate)
  b.add(b.found[0]!.x + 7, 10, 4)
  assert.equal(b.found.length, 1, '⚠️ the cell was not re-filed')
})
