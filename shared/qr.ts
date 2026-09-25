// ★★ **Draw QR codes ourselves** (2026-09-16 / homework ①).
//
// ⚠️⚠️ **Do not use `qrencode`** (so users never have to type `sudo apt install` / user decision).
//   ⚠️ As with reader libraries, **no third-party dependencies** (CLAUDE.md §2). ⇒ Written in-house.
//
// ★ The scope is narrow: **byte mode, error correction level L, versions 1-20** (changed from M on 2026-09-23).
//   ⚠️ The pairing URL is about 230 characters, so it fits around version 11 (up to 20 for headroom).
//   ⚠️ Other modes (numeric, alphanumeric, kanji) are **not implemented** (do not keep what is unused).
//
// ★★ **How correctness is checked** (⚠️ no decoder at hand, so look at independently computable properties):
//   1. **Capacity**: "data codewords + EC codewords" in the table equals **the free module count counted from the board**
//      (a copying mistake in the table fails = checked through a path separate from the table)
//   2. **Reed–Solomon**: the **syndrome of the produced codewords is 0** (a computation separate from encoding)
//   3. **Format information**: the BCH-computed value equals **the values published in the spec**
//   4. **Structure**: finder, timing, alignment and the always-dark module are at the spec's coordinates
//   5. **Mask**: computes the 8 penalty scores and **picks the smallest**
//   ⚠️⚠️ **The final check is a real device** (can a phone camera read it). This cannot be filled in automatically.

/** ⚠️ Highest version this implementation handles (strings beyond it are rejected = never silently broken) */
export const QR_MAX_VERSION = 20

/**
 * Per-version "EC codewords per block" and "block split" (★ level L).
 * `[ecPerBlock, [block count, data codewords], [block count, data codewords]?]`
 * ⚠️ Copying mistakes fail **the capacity check** (item 1 above).
 *
 * ★★ **Changed M → L on 2026-09-23** (user decision). The only form readable in a mac terminal is
 *   drawing with background colour, one module per row (`wide`), so **size = modules per side**.
 *   L is **about 8 modules smaller per side** for the same contents (the pairing URL goes from version 12 → 10).
 *   ⚠️ L corrects about 7% (M about 15%). **For something shown on screen** there is no dirt or damage, so it is enough
 *   (tools that show QR codes in a terminal often use L). ⚠️ If it is ever extended to printed stickers, go back to M.
 */
const EC_TABLE: readonly (readonly [number, readonly [number, number], (readonly [number, number])?])[] = [
  [7, [1, 19]],
  [10, [1, 34]],
  [15, [1, 55]],
  [20, [1, 80]],
  [26, [1, 108]],
  [18, [2, 68]],
  [20, [2, 78]],
  [24, [2, 97]],
  [30, [2, 116]],
  [18, [2, 68], [2, 69]],
  [20, [4, 81]],
  [24, [2, 92], [2, 93]],
  [26, [4, 107]],
  [30, [3, 115], [1, 116]],
  [22, [5, 87], [1, 88]],
  [24, [5, 98], [1, 99]],
  [28, [1, 107], [5, 108]],
  [30, [5, 120], [1, 121]],
  [28, [3, 113], [4, 114]],
  [28, [3, 107], [5, 108]],
]

/** ★ The 2 bits of error correction level in the format information (L = 0b01 / M = 0b00. ⚠️ always keep in step with the table) */
const EC_LEVEL_BITS = 0b01

/** Centre coordinates of alignment patterns (version 1 has none) */
const ALIGN: readonly (readonly number[])[] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62],
  [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82],
  [6, 30, 58, 86], [6, 34, 62, 90],
]

// ── GF(256) (primitive polynomial 0x11d) ─────────────────────────────────────────
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!
}

/**
 * ★ GF(256) tables (the reader `shared/qrDecode.ts` uses them too = the same field is not written twice).
 * ⚠️ Handed out read-only (if rewritten, the drawing side breaks too).
 */
export const GF_EXP: Readonly<Uint8Array> = EXP
export const GF_LOG: Readonly<Uint8Array> = LOG

export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a]! + LOG[b]!]!
}

/** ★ Generator polynomial for error correction (degree `n`) */
export function rsGenerator(n: number): Uint8Array {
  // ★★ **Coefficients are "highest degree first"** (2026-09-19 / codex round 8, medium #4. ⚠️ **they were reversed**).
  //
  //   `rsEncode` uses `gen[i + 1]` as "the rest after the leading 1" = assumes **descending order**.
  //   ⚠️⚠️ Only the generator was built in ascending order, so **the EC codewords were entirely wrong**
  //      (measured: the syndrome was 47, not 0). ⚠️ A problem before the board or masks even matter.
  //
  //   Multiplying the polynomial by `(x + α^i)` = "shifted by one" + "multiplied by α^i":
  //     next[j]     ^= poly[j]              (times x = shift left)
  //     next[j + 1] ^= poly[j] * α^i        (constant multiple = aligned right)
  //   ★ Check: for n=2, `(x+1)(x+α)` = `[1, 3, 2]` (⚠️ not the reversed `[2, 3, 1]`).
  let poly = new Uint8Array([1])
  for (let i = 0; i < n; i++) {
    const next = new Uint8Array(poly.length + 1)
    for (let j = 0; j < poly.length; j++) {
      next[j] = (next[j] ?? 0) ^ poly[j]!
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMul(poly[j]!, EXP[i]!)
    }
    poly = next
  }
  return poly
}

/** ★ Data codewords → EC codewords */
export function rsEncode(data: Uint8Array, ecLen: number): Uint8Array {
  const gen = rsGenerator(ecLen)
  const out = new Uint8Array(ecLen)
  for (const byte of data) {
    const factor = byte ^ out[0]!
    out.copyWithin(0, 1)
    out[ecLen - 1] = 0
    if (factor !== 0) {
      for (let i = 0; i < ecLen; i++) out[i] = out[i]! ^ gfMul(gen[i + 1]!, factor)
    }
  }
  return out
}

// ── Board ─────────────────────────────────────────────────────────────────────

export interface Qr {
  readonly version: number
  readonly size: number
  /** `true` is a dark module */
  readonly modules: readonly (readonly boolean[])[]
  readonly mask: number
}

/** Side length for a version */
export function qrSize(version: number): number {
  return 17 + 4 * version
}

/** ★ Board of reserved (function pattern) modules. ⚠️ Also used to count free places (capacity check) */
export function reservedMask(version: number): boolean[][] {
  const n = qrSize(version)
  const r: boolean[][] = Array.from({ length: n }, () => new Array<boolean>(n).fill(false))
  const mark = (x: number, y: number, w: number, h: number) => {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        if (y + dy >= 0 && y + dy < n && x + dx >= 0 && x + dx < n) r[y + dy]![x + dx] = true
      }
    }
  }
  // Finders (3 corners) + separators + format information
  mark(0, 0, 9, 9)
  mark(n - 8, 0, 8, 9)
  mark(0, n - 8, 9, 8)
  // Timing
  mark(6, 0, 1, n)
  mark(0, 6, n, 1)
  // Alignment (⚠️ none where it would overlap a finder)
  const centers = ALIGN[version - 1] ?? []
  for (const cy of centers) {
    for (const cx of centers) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === n - 7) || (cx === n - 7 && cy === 6)) continue
      mark(cx - 2, cy - 2, 5, 5)
    }
  }
  // Version information (version 7 and up)
  if (version >= 7) {
    mark(n - 11, 0, 3, 6)
    mark(0, n - 11, 6, 3)
  }
  return r
}

/** ★ Number of free modules that can hold data (⚠️ the basis for capacity, via a path separate from the table) */
export function freeModules(version: number): number {
  const r = reservedMask(version)
  let free = 0
  for (const row of r) for (const cell of row) if (!cell) free++
  return free
}

/** Bytes that fit in that version (level M) */
export function capacityBytes(version: number): number {
  const [, g1, g2] = EC_TABLE[version - 1]!
  const dataWords = g1[0] * g1[1] + (g2 ? g2[0] * g2[1] : 0)
  // ⚠️ Subtract mode indicator (4) + character count (8 or 16)
  return dataWords - 2 - (version >= 10 ? 1 : 0)
}

/** ⚠️ The smallest version that fits (`undefined` if nothing fits = never silently cut) */
export function pickVersion(byteLength: number): number | undefined {
  for (let v = 1; v <= QR_MAX_VERSION; v++) if (capacityBytes(v) >= byteLength) return v
  return undefined
}

/** ★ Bytes → data codewords (mode, count, terminator, padding) */
export function toDataCodewords(bytes: Uint8Array, version: number): Uint8Array {
  const [, g1, g2] = EC_TABLE[version - 1]!
  const total = g1[0] * g1[1] + (g2 ? g2[0] * g2[1] : 0)
  const countBits = version >= 10 ? 16 : 8
  const bits: number[] = []
  const push = (value: number, width: number) => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >> i) & 1)
  }
  push(0b0100, 4) // byte mode
  push(bytes.length, countBits)
  for (const b of bytes) push(b, 8)
  // Terminator (⚠️ shortened if fewer than 4 bits remain)
  for (let i = 0; i < 4 && bits.length < total * 8; i++) bits.push(0)
  while (bits.length % 8 !== 0) bits.push(0)
  const out = new Uint8Array(total)
  for (let i = 0; i < bits.length / 8; i++) {
    let v = 0
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j]!
    out[i] = v
  }
  // ⚠️ Padding repeats 0xEC / 0x11 (per spec)
  for (let i = bits.length / 8; i < total; i++) out[i] = i % 2 === bits.length / 8 % 2 ? 0xec : 0x11
  return out
}

/**
 * ★ Block split of that version (data codeword lengths listed) and EC codeword length.
 *
 * ⚠️ Exported **for verification** (`shared/qr.test.ts` uses it for read-back).
 *    ⚠️⚠️ It is **not uniquely determined** by the total codeword count (several combinations share `blocks × ecLen`), so
 *       letting the test guess it would **judge a wrong split as "correct"** (actually hit).
 *    ★ The table itself is verified through another path (capacity = free modules counted from the board).
 */
export function blockLayout(version: number): { ecLen: number; sizes: number[] } {
  const [ecLen, g1, g2] = EC_TABLE[version - 1]!
  const sizes: number[] = []
  for (const [count, size] of g2 ? [g1, g2] : [g1]) {
    for (let i = 0; i < count; i++) sizes.push(size)
  }
  return { ecLen, sizes }
}

/** ★ Split into blocks, add error correction, and **interleave** */
export function interleave(data: Uint8Array, version: number): Uint8Array {
  const [ecLen, g1, g2] = EC_TABLE[version - 1]!
  const blocks: { data: Uint8Array; ec: Uint8Array }[] = []
  let at = 0
  for (const [count, size] of g2 ? [g1, g2] : [g1]) {
    for (let i = 0; i < count; i++) {
      const d = data.subarray(at, at + size)
      at += size
      blocks.push({ data: d, ec: rsEncode(d, ecLen) })
    }
  }
  const out: number[] = []
  const maxData = Math.max(...blocks.map((b) => b.data.length))
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]!)
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.ec[i]!)
  return new Uint8Array(out)
}

// ── Drawing ─────────────────────────────────────────────────────────────────────

/**
 * ★★ The order in which data is placed (zigzag). **`makeQr` and the verification use the same one**.
 *
 * ⚠️⚠️ **Why it is exported** (2026-09-19): when **the same shape was written twice** for placing and reading,
 *    a mutation that removed "skip column 6 (timing)" **shifted both at once and slipped through**.
 *    ⇒ The order itself is kept single, and **"does it visit every free module exactly once"** is checked separately
 *    (= a property independent of the implementation. `shared/qr.test.ts`).
 */
export function dataPath(version: number): Array<readonly [number, number]> {
  const n = qrSize(version)
  const reserved = reservedMask(version)
  const out: Array<readonly [number, number]> = []
  let up = true
  for (let right = n - 1; right >= 1; right -= 2) {
    // ⚠️ Column 6 is the vertical timing. **Shift the column itself one to the left** (not skip it)
    const col = right <= 6 ? right - 1 : right
    for (let step = 0; step < n; step++) {
      const y = up ? n - 1 - step : step
      for (const x of [col, col - 1]) {
        if (reserved[y]![x]) continue
        out.push([x, y])
      }
    }
    up = !up
  }
  return out
}

/** ★ Format information (level is `EC_LEVEL_BITS`). BCH(15,5) + the spec's mask 0x5412 */
export function formatBits(mask: number): number {
  const data = (EC_LEVEL_BITS << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537)
  return ((data << 10) | rem) ^ 0x5412
}

/** ★ Version information (version 7 and up). BCH(18,6) */
export function versionBits(version: number): number {
  let rem = version
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25)
  return (version << 12) | rem
}

function placeFunctionPatterns(m: boolean[][], version: number): void {
  const n = m.length
  const finder = (x: number, y: number) => {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const px = x + dx
        const py = y + dy
        if (px < 0 || py < 0 || px >= n || py >= n) continue
        const inRing = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6
        const on =
          inRing &&
          (dx === 0 || dx === 6 || dy === 0 || dy === 6 ||
            (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4))
        m[py]![px] = on
      }
    }
  }
  finder(0, 0)
  finder(n - 7, 0)
  finder(0, n - 7)
  // Timing (⚠️ even ones are dark)
  for (let i = 8; i < n - 8; i++) {
    m[6]![i] = i % 2 === 0
    m[i]![6] = i % 2 === 0
  }
  // Alignment
  const centers = ALIGN[version - 1] ?? []
  for (const cy of centers) {
    for (const cx of centers) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === n - 7) || (cx === n - 7 && cy === 6)) continue
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          m[cy + dy]![cx + dx] = Math.max(Math.abs(dx), Math.abs(dy)) !== 1
        }
      }
    }
  }
  // ⚠️ The always-dark module (per spec. Some devices cannot read without it)
  m[n - 8]![8] = true
  // Version information
  if (version >= 7) {
    const bits = versionBits(version)
    for (let i = 0; i < 18; i++) {
      const on = ((bits >> i) & 1) === 1
      const a = Math.floor(i / 3)
      const b = i % 3
      m[n - 11 + b]![a] = on
      m[a]![n - 11 + b] = on
    }
  }
}

/**
 * ★★ Place the format information (2026-09-19 / codex round 8, medium #5. ⚠️⚠️ **it was fully transposed**).
 *
 * ⚠️⚠️ This board is **`m[y][x]`**. The spec's tables are written as `(x, y)`, so
 *    copying them as-is **swaps rows and columns** (measured: `makeQr('A')` needs `0x5e7c`, but
 *    reading back from the specified coordinates gave `0x1f3d`).
 * ⚠️⚠️ On top of that, the second copy **overwrote the fixed dark module `m[n-8][8]`**
 *    (⇒ measured `false`. The spec requires it dark = some devices cannot read it).
 * ★ Verified in `shared/qr.test.ts` (**read back from the specified coordinates and compare with `formatBits`**).
 */
export function placeFormat(m: boolean[][], mask: number): void {
  const n = m.length
  const bits = formatBits(mask)
  const on = (i: number) => ((bits >> i) & 1) === 1
  // ── First copy (the L shape at top left) ─────────────────────────────────────────
  // ⚠️ The vertical column `x = 8` (⚠️ skips the timing at `y = 6` = the 6/7/8 sequence below)
  for (let i = 0; i <= 5; i++) m[i]![8] = on(i)
  m[7]![8] = on(6)
  m[8]![8] = on(7)
  // ⚠️ From here it turns into the horizontal row `y = 8`
  m[8]![7] = on(8)
  for (let i = 9; i <= 14; i++) m[8]![14 - i] = on(i)
  // ── Second copy (horizontal at top right + vertical at bottom left) ───────────────
  for (let i = 0; i <= 7; i++) m[8]![n - 1 - i] = on(i)
  // ⚠️⚠️ `i = 8..14` is **`y = n-7 … n-1`** (★ `m[n-8][8]` = the fixed dark module is **never touched**)
  for (let i = 8; i <= 14; i++) m[n - 15 + i]![8] = on(i)
}

/** ⚠️ Mask formulas (the spec's 8) */
export function maskAt(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0
    case 1:
      return y % 2 === 0
    case 2:
      return x % 3 === 0
    case 3:
      return (x + y) % 3 === 0
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
  }
}

/** ★ Penalty (the spec's 4 rules). ⚠️ Smaller is better */
export function penalty(m: readonly (readonly boolean[])[]): number {
  const n = m.length
  let score = 0
  const line = (get: (i: number, j: number) => boolean) => {
    for (let i = 0; i < n; i++) {
      let run = 1
      for (let j = 1; j < n; j++) {
        if (get(i, j) === get(i, j - 1)) {
          run++
        } else {
          if (run >= 5) score += 3 + (run - 5)
          run = 1
        }
      }
      if (run >= 5) score += 3 + (run - 5)
    }
  }
  line((i, j) => m[i]![j]!)
  line((i, j) => m[j]![i]!)
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const v = m[y]![x]!
      if (v === m[y]![x + 1] && v === m[y + 1]![x] && v === m[y + 1]![x + 1]) score += 3
    }
  }
  const pattern = [true, false, true, true, true, false, true, false, false, false, false]
  const rev = [...pattern].reverse()
  const match = (cells: boolean[], at: number, pat: boolean[]) =>
    pat.every((p, k) => cells[at + k] === p)
  for (let i = 0; i < n; i++) {
    const row: boolean[] = []
    const col: boolean[] = []
    for (let j = 0; j < n; j++) {
      row.push(m[i]![j]!)
      col.push(m[j]![i]!)
    }
    for (const cells of [row, col]) {
      for (let at = 0; at + 11 <= n; at++) {
        if (match(cells, at, pattern) || match(cells, at, rev)) score += 40
      }
    }
  }
  let dark = 0
  for (const row of m) for (const cell of row) if (cell) dark++
  score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10
  return score
}

/**
 * ★★ String → QR. ⚠️ **`undefined` if it does not fit** (never silently cut).
 *
 * ⚠️ Tries all 8 masks and picks **the one with the smallest penalty** (per spec).
 */
export function makeQr(text: string): Qr | undefined {
  const bytes = new TextEncoder().encode(text)
  const version = pickVersion(bytes.length)
  if (version === undefined) return undefined
  const codewords = interleave(toDataCodewords(bytes, version), version)
  const n = qrSize(version)
  const path = dataPath(version)

  let best: Qr | undefined
  let bestScore = Number.POSITIVE_INFINITY
  for (let mask = 0; mask < 8; mask++) {
    const m: boolean[][] = Array.from({ length: n }, () => new Array<boolean>(n).fill(false))
    placeFunctionPatterns(m, version)
    placeFormat(m, mask)
    // ★ The placement order is only `dataPath` (⚠️ never copy it here)
    let bit = 0
    for (const [x, y] of path) {
      const byte = codewords[bit >> 3] ?? 0
      const on = ((byte >> (7 - (bit & 7))) & 1) === 1
      m[y]![x] = on !== maskAt(mask, x, y)
      bit++
    }
    const score = penalty(m)
    if (score < bestScore) {
      bestScore = score
      best = { version, size: n, modules: m, mask }
    }
  }
  return best
}

/**
 * ★ Number of modules in the white margin (quiet zone) around it.
 * ★★ Changed 4 → 2 on 2026-09-23 (the spec says 4). ⚠️ White is **painted explicitly here** (not relying on the terminal colours), so
 *   2 is enough (OpenClaw uses 1). ⚠️ **Readability is confirmed on a real device** (this is not filled in automatically).
 */
export const QR_QUIET = 2

/**
 * ★ Draw in a terminal (half blocks = 1 module wide and 2 tall per character). ⚠️ **Set colours explicitly**
 *   (keep "dark modules are dark" regardless of the terminal's colour scheme).
 *
 * ⚠️⚠️ **If the terminal has line spacing, white stripes appear every other row and it cannot be read** (macOS terminal / real device 2026-09-21).
 *   Painting with background colour only (one module per row) was readable, but **so large it always needed ⌘−**
 *   ⇒ Removed on 2026-09-23 (mac uses images only / `scripts/lib/qrMode.mjs`). **Read this before reviving it.**
 */
export function qrTerminal(qr: Qr): string {
  const quiet = QR_QUIET
  const n = qr.size
  const at = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= n || y >= n) return false
    return qr.modules[y]![x]!
  }
  const lines: string[] = []
  for (let y = -quiet; y < n + quiet; y += 2) {
    let line = ''
    for (let x = -quiet; x < n + quiet; x++) {
      const top = at(x, y)
      const bottom = at(x, y + 1)
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
    }
    // ⚠️ Black characters × white background (⚠️ not inverted even with a dark terminal theme)
    lines.push(`[30;107m${line}[0m`)
  }
  return lines.join('\n')
}

/**
 * ★★ **Turn the QR into SVG** (2026-09-21 / added because it could not be read in the mac terminal).
 *
 * ⚠️⚠️ **Drawing in a terminal depends on the terminal** (line spacing, font, glyph fill). On a real
 *    macOS Terminal, **neither half blocks nor background colour could be read**.
 *    ⇒ If a GUI is available, **opening it as an image is reliable** (bypasses the terminal).
 *
 * ⚠️ No new dependencies (CLAUDE.md §2), so it is an SVG made **just by building a string**.
 *    Not PNG (zlib exists, but **there is no reason to write the encoding ourselves**).
 * ⚠️ The quiet zone is `QR_QUIET` (same value as the terminal. ⚠️ do not write a different number here).
 * ⚠️ **Set colours explicitly** (keep "dark modules are dark" regardless of the viewer's colour scheme).
 * ★ `shape-rendering="crispEdges"` = edges stay sharp when scaled (affects whether it can be read).
 */
export function qrSvg(qr: Qr): string {
  const q = QR_QUIET
  const side = qr.size + q * 2
  const rects: string[] = []
  for (let y = 0; y < qr.size; y++) {
    // ★ Consecutive dark modules in a row are merged into one rect (⚠️ only makes the output smaller. Same shape)
    let x = 0
    while (x < qr.size) {
      if (!qr.modules[y]![x]) {
        x++
        continue
      }
      let w = 1
      while (x + w < qr.size && qr.modules[y]![x + w]) w++
      rects.push(`<rect x="${x + q}" y="${y + q}" width="${w}" height="1"/>`)
      x += w
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}"`,
    ` shape-rendering="crispEdges" width="${side * 8}" height="${side * 8}">`,
    `<rect width="${side}" height="${side}" fill="#ffffff"/>`,
    `<g fill="#000000">${rects.join('')}</g>`,
    '</svg>',
  ].join('')
}
