// ★★ **Read QR codes ourselves** (2026-09-24 / using the camera on iPhone = iOS Safari has no `BarcodeDetector`).
//
// ⚠️⚠️ **No third-party reader libraries** (jsQR etc. / CLAUDE.md §2 "no new dependencies"). ⇒ Written in-house.
// ★ The scope is narrowed to match the drawing side (`shared/qr.ts`): **error correction level L, versions 1-20**.
//   ⚠️ What it reads is **the pairing QR** (drawn by the agent with `qr.ts`). Other QR codes need not be readable
//      (anything but L fails the format information ⇒ not read). Data modes read: numeric, alphanumeric and byte.
// ★ Tables, order and mask formulas **use the drawing side's single copy** (`blockLayout` / `dataPath` / `maskAt` / `formatBits`)
//   ⇒ the drawing and reading sides never disagree on their copy of the spec.
//
// Steps:
//   1. brightness → black and white (a threshold per small tile = robust to uneven lighting)
//   2. look for the finder patterns (the nested squares in three corners) as a 1:1:3:1:1 run (confirmed horizontal → vertical → horizontal)
//   3. decide the orientation from a triple and estimate the modules per side
//   4. find the bottom-right alignment pattern and **correct the tilt (perspective)**
//   5. sample grid centres into a board → format information → remove the mask → codewords → **error correction** → text
//
// ⚠️ A value from outside (the camera feed) ⇒ **never throw** (undefined if unreadable).

import { blockLayout, dataPath, formatBits, GF_EXP, GF_LOG, maskAt, QR_MAX_VERSION, qrSize } from './qr.ts'

/** ★ An image (same shape as `ImageData` = RGBA, 4 bytes per pixel) */
export interface RgbaImage {
  readonly data: ArrayLike<number>
  readonly width: number
  readonly height: number
}

/** ⚠️ Reject oversized images (one camera frame is up to 1920×1080 = about 2 million pixels) */
const MAX_PIXELS = 4_000_000

/**
 * ★★ Read the QR text from an image. ⚠️ undefined if unreadable (never throws).
 */
export function decodeQrImage(img: RgbaImage): string | undefined {
  try {
    const { width, height } = img
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 21 || height < 21) return undefined
    if (width * height > MAX_PIXELS || img.data.length < width * height * 4) return undefined
    const bits = binarize(toLuminance(img), width, height)
    const finders = findFinders(bits, width, height)
    // ⚠️ Try at most the 6 best triples (on busy backgrounds, do not spend too long on a frame without a QR = read it in the next frame)
    for (const triple of rankTriples(finders).slice(0, 6)) {
      const got = decodeFromFinders(bits, width, height, triple)
      if (got !== undefined) return got
    }
    return undefined
  } catch {
    return undefined
  }
}

// ── 1. Black and white ─────────────────────────────────────────────────────────────────

function toLuminance(img: RgbaImage): Uint8Array {
  const n = img.width * img.height
  const out = new Uint8Array(n)
  const d = img.data
  for (let i = 0; i < n; i++) {
    // ★ Integer approximation (0.299R + 0.587G + 0.114B)
    out[i] = (d[i * 4]! * 77 + d[i * 4 + 1]! * 150 + d[i * 4 + 2]! * 29) >> 8
  }
  return out
}

const BLOCK = 8
/** ⚠️ If the contrast within a tile is at most this, treat it as "a single-colour tile" (paper white, solid black) */
const MIN_RANGE = 24

/**
 * ★ The threshold per tile (8×8) is the average over the surrounding 5×5 tiles (robust to uneven lighting).
 * ⚠️ Single-colour tiles borrow the value of neighbouring tiles (so the threshold does not stick to white in the middle of a white margin).
 * @returns 1 byte per pixel (1 = dark)
 */
function binarize(lum: Uint8Array, width: number, height: number): Uint8Array {
  const bw = Math.ceil(width / BLOCK)
  const bh = Math.ceil(height / BLOCK)
  const black = new Float32Array(bw * bh)
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let sum = 0
      let count = 0
      let min = 255
      let max = 0
      for (let y = by * BLOCK; y < Math.min(height, by * BLOCK + BLOCK); y++) {
        for (let x = bx * BLOCK; x < Math.min(width, bx * BLOCK + BLOCK); x++) {
          const v = lum[y * width + x]!
          sum += v
          count++
          if (v < min) min = v
          if (v > max) max = v
        }
      }
      let avg = sum / count
      if (max - min <= MIN_RANGE) {
        avg = min / 2
        if (by > 0 && bx > 0) {
          const around = (black[(by - 1) * bw + bx]! + 2 * black[by * bw + bx - 1]! + black[(by - 1) * bw + bx - 1]!) / 4
          if (min < around) avg = around
        }
      }
      black[by * bw + bx] = avg
    }
  }
  const out = new Uint8Array(width * height)
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let sum = 0
      let count = 0
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const yy = Math.min(bh - 1, Math.max(0, by + dy))
          const xx = Math.min(bw - 1, Math.max(0, bx + dx))
          sum += black[yy * bw + xx]!
          count++
        }
      }
      const threshold = sum / count
      for (let y = by * BLOCK; y < Math.min(height, by * BLOCK + BLOCK); y++) {
        for (let x = bx * BLOCK; x < Math.min(width, bx * BLOCK + BLOCK); x++) {
          out[y * width + x] = lum[y * width + x]! <= threshold ? 1 : 0
        }
      }
    }
  }
  return out
}

// ── 2. Finder patterns ─────────────────────────────────────────────────────

export interface Point {
  x: number
  y: number
}

interface Finder extends Point {
  /** Size of one module (pixels) */
  size: number
  /** How many times it was found (more = more certain) */
  count: number
}

/** ★ Do the 5 lengths look like 1:1:3:1:1 (⚠️ allows a deviation of up to half a module) */
function ratioOk(c: readonly number[]): boolean {
  const total = c[0]! + c[1]! + c[2]! + c[3]! + c[4]!
  if (total < 7) return false
  const m = total / 7
  const tol = m / 2
  return (
    Math.abs(m - c[0]!) < tol &&
    Math.abs(m - c[1]!) < tol &&
    Math.abs(3 * m - c[2]!) < 3 * tol &&
    Math.abs(m - c[3]!) < tol &&
    Math.abs(m - c[4]!) < tol
  )
}

/**
 * ★ Check 1:1:3:1:1 along the line through (cx, cy) (direction dx, dy), and return the centre (pixel offset along the line) and the total length.
 * ⚠️ undefined if the centre is not dark or the shape does not match.
 */
function crossCheck(
  bits: Uint8Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
  maxCount: number,
): { offset: number; total: number } | undefined {
  const dark = (i: number) => {
    const x = Math.round(cx + dx * i)
    const y = Math.round(cy + dy * i)
    if (x < 0 || y < 0 || x >= width || y >= height) return undefined
    return bits[y * width + x] === 1
  }
  if (dark(0) !== true) return undefined
  const c = [0, 0, 0, 0, 0]
  // Going back from the centre: dark (middle) → light → dark (outer)
  let i = 0
  while (dark(i) === true) {
    c[2]!++
    i--
  }
  while (dark(i) === false && c[1]! <= maxCount) {
    c[1]!++
    i--
  }
  if (dark(i) === undefined || c[1]! > maxCount) return undefined
  while (dark(i) === true && c[0]! <= maxCount) {
    c[0]!++
    i--
  }
  if (c[0]! > maxCount) return undefined
  const start = i + 1
  // Going forward
  i = 1
  while (dark(i) === true) {
    c[2]!++
    i++
  }
  while (dark(i) === false && c[3]! <= maxCount) {
    c[3]!++
    i++
  }
  if (dark(i) === undefined || c[3]! > maxCount) return undefined
  while (dark(i) === true && c[4]! <= maxCount) {
    c[4]!++
    i++
  }
  if (c[4]! > maxCount) return undefined
  if (!ratioOk(c)) return undefined
  const total = c[0]! + c[1]! + c[2]! + c[3]! + c[4]!
  // Centre = middle of the central dark band
  const offset = start + c[0]! + c[1]! + c[2]! / 2 - 0.5
  return { offset, total }
}

/**
 * ⚠️⚠️ Candidates are compared **only with those in nearby cells** (codex round 23, medium #4). When finder-like patterns fill the screen,
 *    candidates run into thousands, and "compare with all on every add" grew **quadratically** (about 220 ms per frame at 960×720 = the screen freezes).
 * ⚠️ The limit is **only for safety** (kept large). Making it small lets background patterns near the top fill the slots,
 *    **missing the real finder near the bottom** (rows are read top-down). Real finders are found across many rows =
 *    `count` is large, so the later selection step (`rankTriples`) picks them up.
 */
const MAX_FINDERS = 20_000
/** Size of the cells used for nearby lookups (pixels) */
const CELL = 16

/**
 * ★ Collect finder candidates (merging nearby ones by averaging). ⚠️ Exported for verification (`qrDecode.test.ts`).
 * ⚠️⚠️ The merge condition looks at **the size of the existing candidate** (`f.size * 2`), so the search radius is also set by **the largest candidate so far**
 *    (setting it by the new candidate's size added small candidates near a large one as separate entries / codex round 24, medium #5).
 * ⚠️ If averaging moves the position across a cell boundary, re-file it (staying in the first cell means it cannot be found from near where it moved).
 */
export function finderIndex(width: number): { add: (x: number, y: number, size: number) => void; found: Finder[] } {
  const found: Finder[] = []
  const grid = new Map<number, Finder[]>()
  const cellOf = new Map<Finder, number>()
  const cols = Math.ceil(width / CELL) + 1
  const keyOf = (x: number, y: number) => Math.floor(y / CELL) * cols + Math.floor(x / CELL)
  const put = (f: Finder) => {
    const k = keyOf(f.x, f.y)
    cellOf.set(f, k)
    const bucket = grid.get(k)
    if (bucket) bucket.push(f)
    else grid.set(k, [f])
  }
  let maxSize = 1
  const add = (x: number, y: number, size: number) => {
    const reach = Math.ceil((Math.max(size, maxSize) * 2) / CELL) + 1
    const gx = Math.floor(x / CELL)
    const gy = Math.floor(y / CELL)
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        for (const f of grid.get((gy + dy) * cols + (gx + dx)) ?? []) {
          if (Math.abs(f.x - x) <= f.size * 2 && Math.abs(f.y - y) <= f.size * 2 && Math.abs(f.size - size) <= Math.max(1, f.size)) {
            // ★ Average matching ones (the position gets more accurate with every hit)
            f.x = (f.x * f.count + x) / (f.count + 1)
            f.y = (f.y * f.count + y) / (f.count + 1)
            f.size = (f.size * f.count + size) / (f.count + 1)
            f.count++
            if (f.size > maxSize) maxSize = f.size
            const k = keyOf(f.x, f.y)
            const was = cellOf.get(f)!
            if (k !== was) {
              const old = grid.get(was)!
              old.splice(old.indexOf(f), 1)
              put(f)
            }
            return
          }
        }
      }
    }
    if (found.length >= MAX_FINDERS) return
    const f = { x, y, size, count: 1 }
    found.push(f)
    if (size > maxSize) maxSize = size
    put(f)
  }
  return { add, found }
}

function findFinders(bits: Uint8Array, width: number, height: number): Finder[] {
  const { add, found } = finderIndex(width)
  for (let y = 0; y < height; y++) {
    const c = [0, 0, 0, 0, 0]
    let state = 0
    const row = y * width
    const check = (endX: number) => {
      if (!ratioOk(c)) return false
      const total = c[0]! + c[1]! + c[2]! + c[3]! + c[4]!
      const cx = endX - c[4]! - c[3]! - c[2]! / 2
      const maxCount = Math.ceil(total / 7) * 3
      const v = crossCheck(bits, width, height, Math.round(cx), y, 0, 1, maxCount)
      if (!v) return false
      const cy = y + v.offset
      const h = crossCheck(bits, width, height, Math.round(cx), Math.round(cy), 1, 0, maxCount)
      if (!h) return false
      const fx = Math.round(cx) + h.offset
      // ⚠️ Check the diagonal too (discards accidental 1:1:3:1:1 in text or patterns)
      const d = crossCheck(bits, width, height, Math.round(fx), Math.round(cy), 1, 1, maxCount)
      if (!d) return false
      // ★ The module size is measured by **the shortest crossing** (tilted, horizontal and vertical get longer = √2 times at 45°).
      //   ⚠️ A diagonal step is √2 pixels
      add(fx, cy, Math.min(v.total, h.total, d.total * Math.SQRT2) / 7)
      return true
    }
    for (let x = 0; x < width; x++) {
      const isDark = bits[row + x] === 1
      if (isDark) {
        if (state % 2 === 1) state++
        c[state]!++
      } else if (state % 2 === 0) {
        // ⚠️ Do not count before any dark pixel has been seen (the white at the start of a row)
        if (state === 0 && c[0] === 0) continue
        if (state === 4) {
          check(x)
          // ⚠️ Whether found or not, shift by two and continue (also picks up overlapping runs)
          c[0] = c[2]!
          c[1] = c[3]!
          c[2] = c[4]!
          c[3] = 1
          c[4] = 0
          state = 3
        } else {
          state++
          c[state]!++
        }
      } else {
        c[state]!++
      }
    }
    if (state === 4) check(width)
  }
  return found
}

// ── 3. Orientation and size ─────────────────────────────────────────────────────────

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

interface Oriented {
  tl: Finder
  tr: Finder
  bl: Finder
}

/**
 * ★ Order triples by "closest to a right isosceles triangle" (⚠️ even if the first triple is wrong, the next one can read it).
 * ⚠️ When there are too many candidates (busy background), narrow to the 12 most certain (highest count).
 */
function rankTriples(finders: Finder[]): Oriented[] {
  // ⚠️ Drop ones found only once (noise that happened to line up as 1:1:3:1:1) when 3 or more certain ones exist
  //    (otherwise "clean right angles" between noise sorted ahead of the real triple and used up the 6 tries)
  const sure = finders.filter((f) => f.count >= 2)
  const pool = [...(sure.length >= 3 ? sure : finders)].sort((a, b) => b.count - a.count).slice(0, 12)
  const out: { o: Oriented; score: number }[] = []
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      for (let k = j + 1; k < pool.length; k++) {
        const t = [pool[i]!, pool[j]!, pool[k]!]
        const sizes = t.map((f) => f.size)
        if (Math.max(...sizes) > Math.min(...sizes) * 1.6) continue
        const o = orient(t[0]!, t[1]!, t[2]!)
        const a = dist(o.tl, o.tr)
        const b = dist(o.tl, o.bl)
        const c = dist(o.tr, o.bl)
        const ms = (o.tl.size + o.tr.size + o.bl.size) / 3
        // ⚠️ Triples whose finders are too close (under 7 modules) are not a QR
        if (a < ms * 10 || b < ms * 10) continue
        const legs = Math.abs(a - b) / Math.max(a, b)
        const hyp = Math.abs(c - Math.hypot(a, b)) / c
        if (legs > 0.4 || hyp > 0.25) continue
        out.push({ o, score: legs + hyp })
      }
    }
  }
  return out.sort((x, y) => x.score - y.score).map((x) => x.o)
}

function orient(a: Finder, b: Finder, c: Finder): Oriented {
  // Top left = opposite the longest side
  const ab = dist(a, b)
  const bc = dist(b, c)
  const ac = dist(a, c)
  let tl: Finder
  let p: Finder
  let q: Finder
  if (bc >= ab && bc >= ac) [tl, p, q] = [a, b, c]
  else if (ac >= ab && ac >= bc) [tl, p, q] = [b, a, c]
  else [tl, p, q] = [c, a, b]
  // ★ In image coordinates (y points down): (top right − top left) × (bottom left − top left) > 0
  const cross = (p.x - tl.x) * (q.y - tl.y) - (p.y - tl.y) * (q.x - tl.x)
  return cross > 0 ? { tl, tr: p, bl: q } : { tl, tr: q, bl: p }
}

// ── 4. Correct the tilt (perspective) and build the board ───────────────────────────────────────

/** Projective transform (3×3 matrix. a33 = 1) */
interface Homography {
  a11: number
  a12: number
  a13: number
  a21: number
  a22: number
  a23: number
  a31: number
  a32: number
  a33: number
}

function squareToQuad(p0: Point, p1: Point, p2: Point, p3: Point): Homography {
  const dx3 = p0.x - p1.x + p2.x - p3.x
  const dy3 = p0.y - p1.y + p2.y - p3.y
  if (dx3 === 0 && dy3 === 0) {
    return { a11: p1.x - p0.x, a21: p2.x - p1.x, a31: p0.x, a12: p1.y - p0.y, a22: p2.y - p1.y, a32: p0.y, a13: 0, a23: 0, a33: 1 }
  }
  const dx1 = p1.x - p2.x
  const dx2 = p3.x - p2.x
  const dy1 = p1.y - p2.y
  const dy2 = p3.y - p2.y
  const den = dx1 * dy2 - dx2 * dy1
  const a13 = (dx3 * dy2 - dx2 * dy3) / den
  const a23 = (dx1 * dy3 - dx3 * dy1) / den
  return {
    a11: p1.x - p0.x + a13 * p1.x,
    a21: p3.x - p0.x + a23 * p3.x,
    a31: p0.x,
    a12: p1.y - p0.y + a13 * p1.y,
    a22: p3.y - p0.y + a23 * p3.y,
    a32: p0.y,
    a13,
    a23,
    a33: 1,
  }
}

function adjoint(m: Homography): Homography {
  return {
    a11: m.a22 * m.a33 - m.a23 * m.a32,
    a21: m.a23 * m.a31 - m.a21 * m.a33,
    a31: m.a21 * m.a32 - m.a22 * m.a31,
    a12: m.a13 * m.a32 - m.a12 * m.a33,
    a22: m.a11 * m.a33 - m.a13 * m.a31,
    a32: m.a12 * m.a31 - m.a11 * m.a32,
    a13: m.a12 * m.a23 - m.a13 * m.a22,
    a23: m.a13 * m.a21 - m.a11 * m.a23,
    a33: m.a11 * m.a22 - m.a12 * m.a21,
  }
}

function times(a: Homography, b: Homography): Homography {
  return {
    a11: a.a11 * b.a11 + a.a21 * b.a12 + a.a31 * b.a13,
    a21: a.a11 * b.a21 + a.a21 * b.a22 + a.a31 * b.a23,
    a31: a.a11 * b.a31 + a.a21 * b.a32 + a.a31 * b.a33,
    a12: a.a12 * b.a11 + a.a22 * b.a12 + a.a32 * b.a13,
    a22: a.a12 * b.a21 + a.a22 * b.a22 + a.a32 * b.a23,
    a32: a.a12 * b.a31 + a.a22 * b.a32 + a.a32 * b.a33,
    a13: a.a13 * b.a11 + a.a23 * b.a12 + a.a33 * b.a13,
    a23: a.a13 * b.a21 + a.a23 * b.a22 + a.a33 * b.a23,
    a33: a.a13 * b.a31 + a.a23 * b.a32 + a.a33 * b.a33,
  }
}

/** ★ 4 points in board coordinates (in modules) → 4 points in the image (⚠️ exported for verification = tests build tilted images) */
export function quadToQuad(from: readonly Point[], to: readonly Point[]): (x: number, y: number) => Point {
  const q2s = adjoint(squareToQuad(from[0]!, from[1]!, from[2]!, from[3]!))
  const s2q = squareToQuad(to[0]!, to[1]!, to[2]!, to[3]!)
  const m = times(s2q, q2s)
  return (x, y) => {
    const d = m.a13 * x + m.a23 * y + m.a33
    return { x: (m.a11 * x + m.a21 * y + m.a31) / d, y: (m.a12 * x + m.a22 * y + m.a32) / d }
  }
}

/**
 * ★ Search for the bottom-right alignment pattern (the 5×5 nested square) around the estimated position.
 * ⚠️ Counts shape matches and returns **up to 3, best first,** of those with 22 or more out of 25 (which is real is confirmed by reading).
 * ⚠️⚠️ Shot at an angle, it lands **far from** the position estimated with a parallelogram (a trapezoid = about 18 modules in a photo wider at the bottom)
 *    ⇒ The search range is widened to 20 modules. On ties, the one closer to the estimate goes first, so near ones are tried first.
 */
function findAlignments(bits: Uint8Array, width: number, height: number, est: Point, ux: Point, uy: Point): Point[] {
  // ⚠️⚠️ The per-module direction is taken along **the QR's axes** (toward top right / bottom left). Measured along the screen axes, a tilted QR
  //    shifted the whole template and not a single real one was picked up (measured on a 150° photo)
  const ms = (Math.hypot(ux.x, ux.y) + Math.hypot(uy.x, uy.y)) / 2
  const at = (x: number, y: number) => {
    const xi = Math.round(x)
    const yi = Math.round(y)
    if (xi < 0 || yi < 0 || xi >= width || yi >= height) return 0
    return bits[yi * width + xi]!
  }
  const score = (cx: number, cy: number) => {
    // ⚠️ Discard early if the centre is not dark (speed)
    if (at(cx, cy) !== 1) return 0
    let s = 0
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const want = Math.max(Math.abs(dx), Math.abs(dy)) !== 1 ? 1 : 0
        if (at(cx + dx * ux.x + dy * uy.x, cy + dx * ux.y + dy * uy.y) === want) s++
      }
    }
    return s
  }
  const found: { p: Point; s: number; d: number }[] = []
  const radius = ms * 20
  const step = Math.max(1, ms / 2)
  for (let y0 = est.y - radius; y0 <= est.y + radius; y0 += step) {
    for (let x0 = est.x - radius; x0 <= est.x + radius; x0 += step) {
      // ★ Search in two stages: loosely (19) on a coarse grid, then refine around it finely (0.5 px) to reach 22
      //   ⚠️ With the coarse grid alone, an oblique photo **let a real one slip that reaches 22 at only one point**
      if (score(x0, y0) < 19) continue
      let best = { x: x0, y: y0, s: 0 }
      for (let dy = -step; dy <= step; dy += 0.5) {
        for (let dx = -step; dx <= step; dx += 0.5) {
          const v = score(x0 + dx, y0 + dy)
          if (v > best.s) best = { x: x0 + dx, y: y0 + dy, s: v }
        }
      }
      const s = best.s
      if (s < 22) continue
      const p = { x: best.x, y: best.y }
      // ⚠️ Merge nearby points of the same pattern (one pattern hits at several points)
      const near = found.find((f) => dist(f.p, p) < ms * 2)
      const d = dist(p, est)
      if (near) {
        if (s > near.s || (s === near.s && d < near.d)) Object.assign(near, { p, s, d })
      } else {
        found.push({ p, s, d })
      }
    }
  }
  return found
    .sort((a, b) => b.s - a.s || a.d - b.d)
    .slice(0, 3)
    .map((f) => f.p)
}

/** ★ The 5 points sampled within one module (the centre and 0.25 module around it) */
const SAMPLE_OFFSETS: readonly (readonly [number, number])[] = [
  [0.5, 0.5],
  [0.25, 0.5],
  [0.75, 0.5],
  [0.5, 0.25],
  [0.5, 0.75],
]

function decodeFromFinders(bits: Uint8Array, width: number, height: number, o: Oriented): string | undefined {
  const ms = (o.tl.size + o.tr.size + o.bl.size) / 3
  const across = (dist(o.tl, o.tr) + dist(o.tl, o.bl)) / 2 / ms
  const estimate = Math.round(across) + 7
  // ★ A side is 4v+17. Try versions near the estimate, nearest first (⚠️ fixing on one fails with a slightly off estimate)
  const versions = [0, -1, 1, -2, 2]
    .map((d) => Math.round((estimate - 17) / 4) + d)
    .filter((v, i, a) => v >= 1 && v <= QR_MAX_VERSION && a.indexOf(v) === i)
  for (const version of versions) {
    const n = qrSize(version)
    const brCorner = { x: o.tr.x - o.tl.x + o.bl.x, y: o.tr.y - o.tl.y + o.bl.y }
    const points: Point[] = [o.tl, o.tr, brCorner, o.bl]
    const modules: Point[] = [
      { x: 3.5, y: 3.5 },
      { x: n - 3.5, y: 3.5 },
      { x: n - 3.5, y: n - 3.5 },
      { x: 3.5, y: n - 3.5 },
    ]
    const attempts: Array<{ img: Point[]; mod: Point[] }> = []
    if (version >= 2) {
      // ★ The bottom-right alignment is at module (n-7, n-7) (centre n-6.5)
      const k = 1 - 3 / (n - 7)
      const est = { x: o.tl.x + k * (brCorner.x - o.tl.x), y: o.tl.y + k * (brCorner.y - o.tl.y) }
      // ★ Direction and length of one module (the QR's axes = from top left toward top right and bottom left).
      //   At the bottom right, scale by how the size changes from top left to top right and bottom left (shot at an angle, the bottom right is larger / smaller)
      const grow = Math.max(0.5, (o.tr.size + o.bl.size - o.tl.size) / o.tl.size)
      const ux = { x: ((o.tr.x - o.tl.x) / (n - 7)) * grow, y: ((o.tr.y - o.tl.y) / (n - 7)) * grow }
      const uy = { x: ((o.bl.x - o.tl.x) / (n - 7)) * grow, y: ((o.bl.y - o.tl.y) / (n - 7)) * grow }
      for (const al of findAlignments(bits, width, height, est, ux, uy)) {
        attempts.push({ img: [o.tl, o.tr, al, o.bl], mod: [modules[0]!, modules[1]!, { x: n - 6.5, y: n - 6.5 }, modules[3]!] })
      }
    }
    attempts.push({ img: points, mod: modules })
    for (const a of attempts) {
      const map = quadToQuad(a.mod, a.img)
      const grid: boolean[][] = []
      for (let y = 0; y < n; y++) {
        const row: boolean[] = []
        for (let x = 0; x < n; x++) {
          // ★ Majority vote over 5 points in the module (a single point loses to one noisy pixel on a small QR)
          let votes = 0
          for (const [ox, oy] of SAMPLE_OFFSETS) {
            const p = map(x + ox, y + oy)
            const xi = Math.round(p.x)
            const yi = Math.round(p.y)
            if (xi >= 0 && yi >= 0 && xi < width && yi < height && bits[yi * width + xi] === 1) votes++
          }
          row.push(votes >= 3)
        }
        grid.push(row)
      }
      // ★ Also try the mirrored orientation (front camera) = the board with rows and columns swapped
      const text = decodeGrid(grid) ?? decodeGrid(grid.map((_, y) => grid.map((row) => row[y]!)))
      if (text !== undefined) return text
    }
  }
  return undefined
}

// ── 5. Board → text ──────────────────────────────────────────────────────────

const popcount = (v: number) => {
  let c = 0
  for (; v; v &= v - 1) c++
  return c
}

/** ★ Read the format information (either of the two copies). ⚠️ undefined unless within 3 bits of one of the 8 level-L values */
function readMask(m: readonly (readonly boolean[])[]): number | undefined {
  const n = m.length
  const b = (x: number, y: number) => (m[y]![x] ? 1 : 0)
  // ⚠️ Positions are the same as the drawing side's `placeFormat` (`m[y][x]`)
  let a = 0
  for (let i = 0; i <= 5; i++) a |= b(8, i) << i
  a |= b(8, 7) << 6
  a |= b(8, 8) << 7
  a |= b(7, 8) << 8
  for (let i = 9; i <= 14; i++) a |= b(14 - i, 8) << i
  let c = 0
  for (let i = 0; i <= 7; i++) c |= b(n - 1 - i, 8) << i
  for (let i = 8; i <= 14; i++) c |= b(8, n - 15 + i) << i
  let best: { mask: number; d: number } | undefined
  for (let mask = 0; mask < 8; mask++) {
    const want = formatBits(mask)
    const d = Math.min(popcount(a ^ want), popcount(c ^ want))
    if (!best || d < best.d) best = { mask, d }
  }
  return best && best.d <= 3 ? best.mask : undefined
}

/**
 * ★★ Board (`m[y][x]`, true = dark) → text. ⚠️ undefined if unreadable.
 * ⚠️ Exported for verification (`qrDecode.test.ts` reads straight from boards).
 */
export function decodeGrid(m: readonly (readonly boolean[])[]): string | undefined {
  const n = m.length
  const version = (n - 17) / 4
  if (!Number.isInteger(version) || version < 1 || version > QR_MAX_VERSION) return undefined
  if (m.some((row) => row.length !== n)) return undefined
  const mask = readMask(m)
  if (mask === undefined) return undefined
  const { ecLen, sizes } = blockLayout(version)
  const total = sizes.reduce((s, x) => s + x, 0) + ecLen * sizes.length
  const raw = new Uint8Array(total)
  let bit = 0
  for (const [x, y] of dataPath(version)) {
    if (bit >= total * 8) break
    if (m[y]![x] !== maskAt(mask, x, y)) raw[bit >> 3]! |= 0x80 >> (bit & 7)
    bit++
  }
  // ★ Turn the interleaved codewords back into blocks (inverse of the drawing side's `interleave`)
  const blocks = sizes.map((size) => new Uint8Array(size + ecLen))
  let at = 0
  const maxData = Math.max(...sizes)
  for (let i = 0; i < maxData; i++) for (let b = 0; b < blocks.length; b++) if (i < sizes[b]!) blocks[b]![i] = raw[at++]!
  for (let i = 0; i < ecLen; i++) for (let b = 0; b < blocks.length; b++) blocks[b]![sizes[b]! + i] = raw[at++]!
  const data: number[] = []
  for (let b = 0; b < blocks.length; b++) {
    const fixed = rsCorrect(blocks[b]!, ecLen)
    if (!fixed) return undefined
    for (let i = 0; i < sizes[b]!; i++) data.push(fixed[i]!)
  }
  return parseSegments(new Uint8Array(data), version)
}

// ── Error correction (Reed–Solomon / GF(256), generator roots α^0 … α^(ecLen-1) = the drawing side's `rsGenerator`) ──

const gexp = (i: number) => GF_EXP[((i % 255) + 255) % 255]!
const glog = (x: number) => GF_LOG[x]!
const gmul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : gexp(glog(a) + glog(b)))
const gdiv = (a: number, b: number) => (a === 0 ? 0 : gexp(glog(a) - glog(b)))

/** Value of a polynomial (lowest degree first) */
function polyEval(p: readonly number[], x: number): number {
  let y = 0
  for (let i = p.length - 1; i >= 0; i--) y = gmul(y, x) ^ p[i]!
  return y
}

/**
 * ★★ Correct one block (data codewords + EC codewords = highest degree first). ⚠️ undefined if it cannot be corrected.
 * ★ Steps: syndromes → Berlekamp–Massey (error locator polynomial) → Chien search → Forney (error values) → **re-check after correcting**.
 */
export function rsCorrect(block: Uint8Array, ecLen: number): Uint8Array | undefined {
  const len = block.length
  // Values r(α^j) of the received codeword polynomial (highest degree first)
  const synd: number[] = []
  let clean = true
  for (let j = 0; j < ecLen; j++) {
    let s = 0
    for (let i = 0; i < len; i++) s = gmul(s, gexp(j)) ^ block[i]!
    synd.push(s)
    if (s !== 0) clean = false
  }
  if (clean) return block
  // Berlekamp–Massey (lowest degree first)
  let lambda = [1]
  let prev = [1]
  let l = 0
  let shift = 1
  let b = 1
  for (let r = 0; r < ecLen; r++) {
    let d = synd[r]!
    for (let i = 1; i <= l; i++) d ^= gmul(lambda[i] ?? 0, synd[r - i]!)
    if (d === 0) {
      shift++
      continue
    }
    const coef = gdiv(d, b)
    const next = lambda.slice()
    for (let i = 0; i < prev.length; i++) {
      const k = i + shift
      while (next.length <= k) next.push(0)
      next[k] = next[k]! ^ gmul(coef, prev[i]!)
    }
    if (2 * l <= r) {
      prev = lambda
      l = r + 1 - l
      b = d
      shift = 1
    } else {
      shift++
    }
    lambda = next
  }
  while (lambda.length > 1 && lambda[lambda.length - 1] === 0) lambda.pop()
  if (l !== lambda.length - 1 || 2 * l > ecLen) return undefined
  // Chien search: position p (counted from the start) is degree len-1-p. X = α^(len-1-p), Λ(X^-1) = 0
  const positions: number[] = []
  for (let p = 0; p < len; p++) {
    if (polyEval(lambda, gexp(-(len - 1 - p))) === 0) positions.push(p)
  }
  if (positions.length !== l) return undefined
  // Ω(x) = S(x)Λ(x) mod x^ecLen (S is lowest degree first)
  const omega = new Array<number>(ecLen).fill(0)
  for (let i = 0; i < ecLen; i++) for (let j = 0; j < lambda.length && i + j < ecLen; j++) omega[i + j]! ^= gmul(synd[i]!, lambda[j]!)
  // Λ'(x) (GF(2), so only odd degrees remain)
  const deriv: number[] = []
  for (let i = 1; i < lambda.length; i++) deriv.push(i % 2 === 1 ? lambda[i]! : 0)
  const out = block.slice()
  for (const p of positions) {
    const X = gexp(len - 1 - p)
    const Xinv = gexp(-(len - 1 - p))
    const den = polyEval(deriv, Xinv)
    if (den === 0) return undefined
    // ★ Roots start at α^0 (fcr = 0), so e = X · Ω(X^-1) / Λ'(X^-1)
    out[p] = out[p]! ^ gmul(X, gdiv(polyEval(omega, Xinv), den))
  }
  // ⚠️ After correcting, check that the syndrome is 0 again (never claim "fixed" by mistake)
  for (let j = 0; j < ecLen; j++) {
    let s = 0
    for (let i = 0; i < len; i++) s = gmul(s, gexp(j)) ^ out[i]!
    if (s !== 0) return undefined
  }
  return out
}

// ── Data segments (modes) ────────────────────────────────────────────────

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:'

function parseSegments(data: Uint8Array, version: number): string | undefined {
  let pos = 0
  const total = data.length * 8
  const read = (w: number): number | undefined => {
    if (pos + w > total) return undefined
    let v = 0
    for (let i = 0; i < w; i++) {
      v = (v << 1) | ((data[(pos + i) >> 3]! >> (7 - ((pos + i) & 7))) & 1)
    }
    pos += w
    return v
  }
  const small = version <= 9
  const bytes: number[] = []
  let text = ''
  const flush = () => {
    if (bytes.length) text += new TextDecoder().decode(new Uint8Array(bytes))
    bytes.length = 0
  }
  for (;;) {
    if (total - pos < 4) break
    const mode = read(4)!
    if (mode === 0) break
    if (mode === 0b0100) {
      const count = read(small ? 8 : 16)
      if (count === undefined) return undefined
      for (let i = 0; i < count; i++) {
        const b = read(8)
        if (b === undefined) return undefined
        bytes.push(b)
      }
    } else if (mode === 0b0010) {
      flush()
      const count = read(small ? 9 : 11)
      if (count === undefined) return undefined
      for (let i = 0; i + 1 < count; i += 2) {
        const v = read(11)
        if (v === undefined || v >= 45 * 45) return undefined
        text += ALNUM[Math.floor(v / 45)]! + ALNUM[v % 45]!
      }
      if (count % 2 === 1) {
        const v = read(6)
        if (v === undefined || v >= 45) return undefined
        text += ALNUM[v]!
      }
    } else if (mode === 0b0001) {
      flush()
      const count = read(small ? 10 : 12)
      if (count === undefined) return undefined
      let left = count
      while (left >= 3) {
        const v = read(10)
        if (v === undefined || v > 999) return undefined
        text += String(v).padStart(3, '0')
        left -= 3
      }
      if (left === 2) {
        const v = read(7)
        if (v === undefined || v > 99) return undefined
        text += String(v).padStart(2, '0')
      } else if (left === 1) {
        const v = read(4)
        if (v === undefined || v > 9) return undefined
        text += String(v)
      }
    } else if (mode === 0b0111) {
      // ECI (⚠️ a character-set designation. It is read as UTF-8, so the contents are discarded)
      const first = read(8)
      if (first === undefined) return undefined
      if ((first & 0x80) !== 0 && read((first & 0x40) === 0 ? 8 : 16) === undefined) return undefined
    } else {
      // ⚠️ Modes not read (kanji, structured append, etc.)
      return undefined
    }
  }
  flush()
  return text
}
