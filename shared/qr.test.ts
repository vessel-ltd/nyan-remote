// ★★ QR encoder (`shared/qr.ts` / 2026-09-19).
//
// ⚠️⚠️ **There is no decoder at hand** (no new dependencies / CLAUDE.md §2), so
//   **checking by "a computation separate from producing it"** is the only way:
//     ① capacity … the table's codeword counts equal **the free module count counted from the board** (kills copying mistakes in the table)
//     ② error correction … the **syndrome of the produced codewords is 0** (a computation separate from encoding)
//     ③ format information … the BCH result equals **the values published in the spec**, and **reads back from the specified coordinates**
//     ④ structure … finders, timing and the fixed dark module are where the spec puts them
//     ⑤ mask … picks **the smallest** of the 8 penalties
//     ⑥ ★ **read-back** … pick up the placed bits along the zigzag, remove the mask,
//        undo the interleaving, and **get the original bytes back** (= a partial decoder)
//
// ⚠️⚠️ **The final check is a real device** (can a phone camera read it). This cannot be filled in automatically.
//
// ★ Mutations **targeted by name** here (codex round 8, medium #4 and #5 were actually alive):
//   ① reverse the generator polynomial coefficients (⇒ the EC codewords break entirely / measured syndrome 47)
//   ② transpose the format information (⇒ unreadable)
//   ③ overwrite the fixed dark module (⇒ some devices cannot read it)
//   ④ get padding, terminator or count width wrong
//   ⑤ not choosing the smallest mask

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  QR_MAX_VERSION,
  capacityBytes,
  dataPath,
  formatBits,
  placeFormat,
  freeModules,
  gfMul,
  makeQr,
  maskAt,
  penalty,
  pickVersion,
  blockLayout,
  qrSize,
  reservedMask,
  rsEncode,
  rsGenerator,
  toDataCodewords,
  versionBits,
  type Qr, qrTerminal, QR_QUIET} from './qr.ts'

/** ⚠️ GF(256) exponent table (★ kept **separately** from the implementation. Using the same one would not be a check) */
const EXP: number[] = []
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP.push(x)
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
}

// ── ① Capacity (table and board agree) ────────────────────────────────────────────

test('★★ **the total codewords in the table** equal the free modules counted from the board (every version)', () => {
  // ⚠️⚠️ **Originally it only looked at "known answers for 4 versions" and "capacity < total codewords"**
  //    (codex round 10, medium #4). ⇒ **A mutation breaking the version 12 table slipped through**
  //    (two fewer data codewords triggered neither check).
  //    ⇒ **Compare the total the table implies (data + EC) against the board count, for every version.**
  const TOTAL: Record<number, number> = { 1: 26, 7: 196, 10: 346, 20: 1085 }
  for (let v = 1; v <= QR_MAX_VERSION; v++) {
    const words = Math.floor(freeModules(v) / 8)
    if (TOTAL[v] !== undefined) assert.equal(words, TOTAL[v], `total codewords of version ${v} differ from the spec`)
    // ★★ This is the core: **the total derived from the table** (data codewords of the blocks + EC codewords of each block)
    const { ecLen, sizes } = blockLayout(v)
    const fromTable = sizes.reduce((a, b) => a + b, 0) + ecLen * sizes.length
    assert.equal(fromTable, words, `⚠️⚠️ version ${v}: table says ${fromTable}, board says ${words}`)
    assert.ok(capacityBytes(v) > 0 && capacityBytes(v) < words, `capacity of version ${v} is wrong`)
  }
})

test('★★ what does not fit gives `undefined` (⚠️ never silently cut)', () => {
  assert.equal(pickVersion(1), 1)
  assert.equal(pickVersion(capacityBytes(QR_MAX_VERSION)), QR_MAX_VERSION)
  assert.equal(pickVersion(capacityBytes(QR_MAX_VERSION) + 1), undefined)
  // ★ The pairing URL (about 230 characters) must fit (⚠️ if not, the design falls apart)
  const v = pickVersion(230)
  assert.ok(v !== undefined && v <= QR_MAX_VERSION, 'the pairing URL does not fit')
})

// ── ② Error correction (syndrome is 0) ──────────────────────────────────────────

test('★★ generator polynomial is highest degree first (① reversing it breaks the EC codewords / codex round 8, medium #4)', () => {
  // ★ The smallest hand-computable example: (x+1)(x+α) = x² + (α+1)x + α = [1, 3, 2]
  assert.deepEqual([...rsGenerator(2)], [1, 3, 2], '⚠️⚠️ coefficient order is reversed')
  // ⚠️ The first is always 1 (`rsEncode` assumes it and uses the rest via `gen[i+1]`)
  for (const n of [7, 10, 16, 26, 30]) assert.equal(rsGenerator(n)[0], 1, `leading coefficient of degree ${n} is not 1`)
})

test('★★ the syndrome of produced codewords is 0 (② checked by a computation separate from encoding)', () => {
  for (const ecLen of [10, 16, 22, 26, 30]) {
    for (const len of [1, 5, 44]) {
      const data = Uint8Array.from({ length: len }, (_, i) => (i * 31 + 7) & 0xff)
      const word = [...data, ...rsEncode(data, ecLen)]
      for (let i = 0; i < ecLen; i++) {
        let acc = 0
        for (const b of word) acc = gfMul(acc, EXP[i]!) ^ b
        assert.equal(acc, 0, `⚠️⚠️ α^${i} for ec=${ecLen} len=${len} is not 0 (= cannot correct)`)
      }
    }
  }
})

test('★★ blocks go "shorter first, longer ones exactly one codeword more" (spec ordering / 2026-09-23)', () => {
  // ⚠️⚠️ A copying mistake swapping the two groups **slipped through because capacity and read-back use the same table**
  //    (confirmed by mutation). A real decoder could not read it ⇒ look at the spec's rule directly.
  for (let v = 1; v <= QR_MAX_VERSION; v++) {
    const { sizes } = blockLayout(v)
    const min = sizes[0]!
    for (let i = 1; i < sizes.length; i++) {
      assert.ok(sizes[i]! >= sizes[i - 1]!, `version ${v}: a longer block comes first`)
      assert.ok(sizes[i]! - min <= 1, `version ${v}: blocks differ by more than 1`)
    }
  }
})

// ── ③ Format information (published values + read-back) ────────────────────────────────────────

test('★★ format information matches the published spec values (level L)', () => {
  // ⚠️ This is **a known answer** (the spec's table). ⚠️ A failure means the BCH, the XOR mask or the 2 level bits are broken
  // ★ Changed M → L on 2026-09-23 (the M values are 0x5412 0x5125 0x5e7c 0x5b4b 0x45f9 0x40ce 0x4f97 0x4aa0)
  const L = [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976]
  for (let mask = 0; mask < 8; mask++) assert.equal(formatBits(mask), L[mask], `mask ${mask}`)
})

test('★★ version information matches the published spec values (version 7 and up)', () => {
  const V: Record<number, number> = { 7: 0x07c94, 10: 0x0a4d3, 20: 0x149a6 }
  for (const [v, want] of Object.entries(V)) assert.equal(versionBits(Number(v)), want, `version ${v}`)
})

/** ★ Read the format information back from the spec's coordinates (⚠️ **written separately from the placing side** = kills transposition) */
function readFormat(qr: Qr, copy: 1 | 2): number {
  const n = qr.size
  const at = (x: number, y: number) => (qr.modules[y]![x]! ? 1 : 0)
  let bits = 0
  for (let i = 0; i <= 14; i++) {
    let b: number
    if (copy === 1) {
      // The L shape at top left (⚠️ skip the timing row `y = 6`)
      if (i <= 5) b = at(8, i)
      else if (i === 6) b = at(8, 7)
      else if (i === 7) b = at(8, 8)
      else if (i === 8) b = at(7, 8)
      else b = at(14 - i, 8)
    } else {
      // Horizontal at top right + vertical at bottom left
      b = i <= 7 ? at(n - 1 - i, 8) : at(8, n - 15 + i)
    }
    bits |= b << i
  }
  return bits
}

test('★★ the placed format information reads back from the specified coordinates (② transposition / codex round 8, medium #5)', () => {
  for (const text of ['A', 'nyan://pair?v=1&a=' + 'x'.repeat(120)]) {
    const qr = makeQr(text)
    assert.ok(qr, 'not built')
    const want = formatBits(qr.mask)
    assert.equal(readFormat(qr, 1), want, `⚠️⚠️ copy 1 does not read back (transposed): ${text.slice(0, 12)}`)
    assert.equal(readFormat(qr, 2), want, `⚠️⚠️ copy 2 does not read back: ${text.slice(0, 12)}`)
  }
})

// ── ④ Structure ──────────────────────────────────────────────────────────────────

/** ★ Read the version information back from the spec's coordinates (⚠️ written separately from the placing side) */
function readVersion(qr: Qr, copy: 1 | 2): number {
  const n = qr.size
  let bits = 0
  for (let i = 0; i < 18; i++) {
    const a = Math.floor(i / 3)
    const b = i % 3
    const on = copy === 1 ? qr.modules[n - 11 + b]![a]! : qr.modules[a]![n - 11 + b]!
    bits |= (on ? 1 : 0) << i
  }
  return bits
}

test('★★ the placed version information reads back from the specified coordinates (version 7 and up / codex round 10, medium #4)', () => {
  // ⚠️⚠️ **Originally it only looked at the return value of `versionBits()`**, so
  //    **a mutation writing 0 when placing slipped through** (= QR codes of version 7+ become unreadable).
  for (const text of ['x'.repeat(130), 'x'.repeat(250), 'あ'.repeat(200)]) {
    const qr = makeQr(text)
    assert.ok(qr, `not built: ${text.length} characters`)
    if (qr.version < 7) continue
    const want = versionBits(qr.version)
    assert.equal(readVersion(qr, 1), want, `⚠️⚠️ version ${qr.version}: copy 1 of the version information does not read back`)
    assert.equal(readVersion(qr, 2), want, `⚠️⚠️ version ${qr.version}: copy 2 of the version information does not read back`)
  }
})

test('★★ the fixed dark module is dark (③ never overwritten / codex round 8, medium #5)', () => {
  for (const text of ['A', 'x'.repeat(300)]) {
    const qr = makeQr(text)
    assert.ok(qr)
    assert.equal(qr.modules[qr.size - 8]![8], true, '⚠️⚠️ the fixed dark module is not dark')
  }
})

test('★★ finders and timing are where the spec puts them', () => {
  const qr = makeQr('A')
  assert.ok(qr)
  const n = qr.size
  const at = (x: number, y: number) => qr.modules[y]![x]!
  for (const [ox, oy] of [
    [0, 0],
    [n - 7, 0],
    [0, n - 7],
  ] as const) {
    // ★ A 7×7 ring (outer ring dark, inside it light, centre 3×3 dark)
    assert.equal(at(ox, oy), true)
    assert.equal(at(ox + 1, oy + 1), false)
    assert.equal(at(ox + 3, oy + 3), true, 'centre is not dark')
  }
  // ⚠️ Timing is dark on even positions (★ both directions)
  for (let i = 8; i < n - 8; i++) {
    assert.equal(at(i, 6), i % 2 === 0, `horizontal timing ${i}`)
    assert.equal(at(6, i), i % 2 === 0, `vertical timing ${i}`)
  }
})

test('★★ reserved places and data places do not overlap (board counts agree)', () => {
  for (const v of [1, 2, 7, 11, 20]) {
    const n = qrSize(v)
    const r = reservedMask(v)
    assert.equal(r.length, n)
    // ★ Version 1 has no alignment pattern
    assert.equal(freeModules(1) < n * n, true)
    if (v >= 7) assert.equal(r[0]![n - 11], true, `version ${v}: version information is not reserved`)
  }
})

// ── ⑤ Mask ────────────────────────────────────────────────────────────────

test('★★ the mask picks **the smallest penalty** of the 8 (⑤)', () => {
  const qr = makeQr('nyan://pair?v=1&t=abcdefghijklmnop')
  assert.ok(qr)
  const mine = penalty(qr.modules)
  // ⚠️ Rebuild the same string with every mask and compare (★ the same computation as inside `makeQr`, but
  //    **how it picks** (smallest or not) can be checked from outside)
  for (let mask = 0; mask < 8; mask++) {
    const other = makeQrWithMask(qr, mask)
    assert.ok(mine <= other, `⚠️ mask ${mask} is better (${other} < ${mine})`)
  }
})

/** ⚠️ Measure the penalty by swapping only the mask on the same board (flips only the data places) */
function makeQrWithMask(qr: Qr, mask: number): number {
  const n = qr.size
  const r = reservedMask(qr.version)
  const m = qr.modules.map((row) => [...row])
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (r[y]![x]) continue
      // ⚠️ Remove the current mask and apply another one
      m[y]![x] = m[y]![x]! !== maskAt(qr.mask, x, y) !== maskAt(mask, x, y)
    }
  }
  // ⚠️ Also re-place the format information for that mask (without it the penalty is off by a few points and the comparison lies
  //    = it passed by luck with M / failed after switching to L on 2026-09-23)
  placeFormat(m, mask)
  return penalty(m)
}

test('★★ the data path visits "every free module, exactly once" (⑥ kills the column 6 shift)', () => {
  // ⚠️⚠️ **When the same shape was written twice for placing and reading, a shift moved both at once and slipped through**
  //    (measured: a mutation removing "skip column 6" was green). ⇒ The order lives only in `dataPath`, and
  //    here only **properties that do not depend on the order** are checked.
  for (const v of [1, 2, 6, 7, 11, 20]) {
    const path = dataPath(v)
    const free = freeModules(v)
    assert.equal(path.length, free, `version ${v}: visited count differs from the free count (= unplaceable spots appear)`)
    const seen = new Set(path.map(([x, y]) => `${x},${y}`))
    assert.equal(seen.size, free, `version ${v}: visits the same spot twice`)
    const r = reservedMask(v)
    for (const [x, y] of path) assert.equal(r[y]![x], false, `version ${v}: places data on a reserved spot`)
  }
})

test('★★ the **order** of the path follows the spec (codex round 10, medium #4 / reversed order slipped through)', () => {
  // ⚠️⚠️ **Completeness as a set is not enough**. Read-back uses the same `dataPath`, so
  //    **reversing it cancelled out and slipped through** (= my "one path, so it is a real check" was wrong).
  //    ⇒ Look directly at **the starting point and direction the spec defines**.
  const path = dataPath(1)
  const n = qrSize(1)
  // ★ Spec: **starts at the bottom right, going up the right columns** (the first two are the bottom-right two columns)
  assert.deepEqual(path[0], [n - 1, n - 1], `⚠️⚠️ start is not the bottom right: ${String(path[0])}`)
  assert.deepEqual(path[1], [n - 2, n - 1], '⚠️ the first step is the left neighbour on the same row (one level per two columns)')
  assert.deepEqual(path[2], [n - 1, n - 2], '⚠️⚠️ not heading upward')
  // ★ The end is on the top-left side (⚠️ reversed, it would be the bottom right)
  const last = path[path.length - 1]!
  assert.ok(last[0] <= 1, `⚠️⚠️ the end is not at the left edge: ${String(last)}`)
})

test('★★ padding repeats 0xEC / 0x11 (④ known answer from the spec)', () => {
  // ⚠️⚠️ The read-back check **builds its expectation from the same function**, so padding contents are invisible to it
  //    (measured: a mutation setting padding to 0 slipped through). ⇒ Look at **the spec's values** directly here.
  const v = 1
  const out = toDataCodewords(new TextEncoder().encode('A'), v)
  // mode (4) + count (8) + body (8) + terminator (4) = 24 bits = 3 codewords. The rest is padding
  const pad = [...out.slice(3)]
  assert.ok(pad.length > 0, 'no padding (the premise broke)')
  assert.deepEqual(
    pad,
    pad.map((_, i) => (i % 2 === 0 ? 0xec : 0x11)),
    '⚠️⚠️ padding is not the repeating 0xEC / 0x11 of the spec',
  )
})

// ── ⑥ Read-back (a partial decoder) ──────────────────────────────────────────

test('★★ reading back what was placed gives the original bytes (⑥ this is the core)', () => {
  // ⚠️⚠️ **Always include version 10 or above** (the boundary where the count field goes from 8 to 16 bits).
  //    Measured: without it, a mutation making it "always 8 bits" slipped through.
  const LONG =
    'nyan://pair?v=1&a=' + 'Xk2qP9vLzA-_'.repeat(7) + '&t=' + 'a'.repeat(32) + '&n=PC-B-01&r=' + 'x'.repeat(120)
  assert.ok((pickVersion(new TextEncoder().encode(LONG).length) ?? 0) >= 10, 'the long example is below version 10 (the premise broke)')
  for (const text of ['A', 'nyan://pair?v=1&a=' + 'Xk2qP9vLzA-_'.repeat(8), 'あ'.repeat(40), LONG]) {
    const qr = makeQr(text)
    assert.ok(qr, `not built: ${text.slice(0, 10)}`)
    // ① Pick up along the path and remove the mask
    //   ⚠️ The order is only `dataPath` (★ **never written twice** = shifts cannot cancel out).
    //     Correctness of the path itself is checked separately by "every free module exactly once" above.
    const bits = dataPath(qr.version).map(([x, y]) =>
      qr.modules[y]![x]! !== maskAt(qr.mask, x, y) ? 1 : 0,
    )
    const bytes: number[] = []
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      let v = 0
      for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]!
      bytes.push(v)
    }

    // ② Undo the interleaving and check the syndrome per block
    const want = toDataCodewords(new TextEncoder().encode(text), qr.version)
    const data = deinterleaveData(bytes, qr.version, want.length)
    assert.deepEqual(data, [...want], `⚠️⚠️ data codewords do not come back: ${text.slice(0, 10)}`)

    // ③ Restore the contents too (mode, count, body)
    const head = data[0]! >> 4
    assert.equal(head, 0b0100, 'not byte mode')
    const wide = qr.version >= 10
    const len = wide
      ? ((data[0]! & 0x0f) << 12) | (data[1]! << 4) | (data[2]! >> 4)
      : ((data[0]! & 0x0f) << 4) | (data[1]! >> 4)
    const raw = new TextEncoder().encode(text)
    assert.equal(len, raw.length, 'count does not match')
    const out: number[] = []
    for (let i = 0; i < len; i++) {
      const at = wide ? 2 + i : 1 + i
      out.push(((data[at]! & 0x0f) << 4) | (data[at + 1]! >> 4))
    }
    assert.equal(new TextDecoder().decode(Uint8Array.from(out)), text, '⚠️⚠️ the body does not come back')
  }
})

/**
 * ⚠️ Undo the interleaving (★ written **separately** from the placing side's `interleave`).
 *
 * ⚠️⚠️ **Only the block split is taken from the implementation's table** (`blockLayout`).
 *    At first it was "guessed from the total codeword count", but **that is not unique, so a wrong split
 *    was judged "correct"** (read as one block, the leading mode indicator still matches).
 *    ★ The table itself is verified separately by ① above (capacity = free modules counted from the board).
 */
function deinterleaveData(all: readonly number[], version: number, dataWords: number): number[] {
  const { sizes } = blockLayout(version)
  assert.equal(
    sizes.reduce((a, b) => a + b, 0),
    dataWords,
    'data codeword count in the table differs from the length of `toDataCodewords`',
  )
  const took = sizes.map(() => [] as number[])
  let at = 0
  for (let i = 0; i < Math.max(...sizes); i++) {
    for (let b = 0; b < sizes.length; b++) {
      if (i < sizes[b]!) took[b]!.push(all[at++]!)
    }
  }
  return took.flat()
}

// ★★ **Read back what was drawn to the terminal** (2026-09-21 / added because the mac could not read it).
//   ⚠️⚠️ There was **not a single test** here (drawing was only "checked by eye").
//   ★ No decoder, so as elsewhere in `shared/qr.test.ts`, **hit it with a separate computation**:
//     **turn the drawn string back into a module board** and compare with the original `qr.modules`.

/** ⚠️ Strip colour codes (SGR) */
function noSgr(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, '')
}

test('★★ the default (half blocks) reads back as 1 character = 2 modules tall', () => {
  const qr = makeQr('nyan://pair?v=1&a=' + 'B'.repeat(87))!
  assert.ok(qr, 'QR not built')
  const lines = qrTerminal(qr).split('\n').map(noSgr)
  const n = qr.size
  const q = QR_QUIET
  assert.equal(lines.length, Math.ceil((n + q * 2) / 2), 'row count does not match')
  assert.equal(lines[0]!.length, n + q * 2, 'column count does not match')
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const ch = lines[Math.floor((y + q) / 2)]![x + q]!
      // ★ Upper or lower half (⚠️ decided by the parity of `y + q`)
      const dark = (y + q) % 2 === 0 ? ch === '█' || ch === '▀' : ch === '█' || ch === '▄'
      assert.equal(dark, qr.modules[y]![x], `(${x},${y}) differs`)
    }
  }
})

test('★★ the quiet zone is QR_QUIET modules (⚠️ never narrower than 2 / 4 → 2 on 2026-09-23)', () => {
  const qr = makeQr('nyan://pair?v=1&a=' + 'B'.repeat(87))!
  // ⚠️ Watch the lower bound (kills mutations to 0 or 1. White is painted by us, so 2 is enough)
  assert.ok(QR_QUIET >= 2, `quiet zone too narrow: ${QR_QUIET}`)
  const lines = qrTerminal(qr).split('\n').map(noSgr)
  // ⚠️ The top margin rows (1 row = 2 modules) are **entirely light** (= not a single block)
  for (let y = 0; y < Math.floor(QR_QUIET / 2); y++) {
    assert.match(lines[y]!, /^ +$/, `dark module in the quiet zone on row ${y}`)
  }
  // ⚠️ The left margin is light too
  for (const l of lines) assert.match(l.slice(0, QR_QUIET), /^ +$/, 'dark module in the left quiet zone')
})

// ★★ Check the SVG by **reading it back** too (2026-09-21 / the route added because the terminal could not be read).
//   ⚠️ The look can only be checked by eye, but **the board being correct** can be checked by machine.
test('★★ the SVG reads back from its rects to the original board', async () => {
  const { qrSvg } = await import('./qr.ts')
  const qr = makeQr('nyan://pair?v=1&a=' + 'B'.repeat(87))!
  const svg = qrSvg(qr)
  const side = qr.size + QR_QUIET * 2
  assert.match(svg, new RegExp(`viewBox="0 0 ${side} ${side}"`), 'viewBox does not match the board')
  // ★ White background, black modules (⚠️ independent of the viewer's colour scheme)
  assert.match(svg, /fill="#ffffff"/, 'background is not white')
  assert.match(svg, /fill="#000000"/, 'modules are not black')

  // ★ Turn the rects back into a board (⚠️ merged horizontally, so expand the width)
  const grid = Array.from({ length: side }, () => new Array<boolean>(side).fill(false))
  for (const m of svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="1"\/>/g)) {
    const [x, y, w] = [Number(m[1]), Number(m[2]), Number(m[3])]
    for (let i = 0; i < w; i++) grid[y]![x + i] = true
  }
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const inside = x >= QR_QUIET && x < qr.size + QR_QUIET && y >= QR_QUIET && y < qr.size + QR_QUIET
      const want = inside ? qr.modules[y - QR_QUIET]![x - QR_QUIET]! : false
      assert.equal(grid[y]![x], want, `(${x},${y}) differs`)
    }
  }
})
