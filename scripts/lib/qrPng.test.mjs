// ★★ Check the PNG by **reading it back** (2026-09-22).
//
// ⚠️⚠️ It is tempting to think images can only be "checked by eye", but **the contents can be checked by machine**.
//   ⇒ Without adding a decoder, inflate with `zlib` and **compare pixels with the matrix**
//     (the same "hit it with an independent computation" as `shared/qr.test.ts`).
// ★ Why this exists: the SVG version depended on the environment's viewer and **was not visible on the real device**.
//   When changing formats, **at least make the contents' correctness certain locally**.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inflateSync } from 'node:zlib'
import { makeQr, QR_QUIET } from '../../shared/qr.ts'
import { qrPng } from './qrPng.mjs'

const QR = makeQr('nyan://pair?v=1&a=' + 'B'.repeat(87))

test('★★ PNG pixels match the source matrix', () => {
  const scale = 3
  const png = qrPng(QR, QR_QUIET, scale)
  // ★ Signature (⚠️ if wrong, no app will open it)
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  // ★ Read IHDR (⚠️ **from the output**, not from hand-built values)
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR')
  const side = png.readUInt32BE(16)
  assert.equal(side, png.readUInt32BE(20), 'not square')
  assert.equal(side, (QR.size + QR_QUIET * 2) * scale, 'size does not match the matrix')
  assert.equal(png[24], 8, 'bit depth is not 8')
  assert.equal(png[25], 0, 'not grayscale')

  // ★ Extract IDAT and inflate it
  let at = 8
  let idat
  while (at < png.length) {
    const len = png.readUInt32BE(at)
    const type = png.subarray(at + 4, at + 8).toString('ascii')
    if (type === 'IDAT') idat = png.subarray(at + 8, at + 8 + len)
    at += 12 + len
  }
  assert.ok(idat, 'no IDAT')
  const raw = inflateSync(idat)
  assert.equal(raw.length, (side + 1) * side, 'scanline length mismatch')

  for (let y = 0; y < side; y++) {
    assert.equal(raw[y * (side + 1)], 0, `filter type on row ${y} is not 0`)
    for (let x = 0; x < side; x++) {
      const mx = Math.floor(x / scale) - QR_QUIET
      const my = Math.floor(y / scale) - QR_QUIET
      const inside = mx >= 0 && mx < QR.size && my >= 0 && my < QR.size
      const dark = inside && QR.modules[my][mx]
      assert.equal(raw[y * (side + 1) + 1 + x], dark ? 0 : 0xff, `pixel (${x},${y}) differs`)
    }
  }
})

test('★★★ CRCs are correct (⚠️ apps silently refuse to open a broken PNG)', () => {
  const png = qrPng(QR, QR_QUIET, 2)
  // ★ Compute the CRC here **independently** of our implementation and compare
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  const crc = (b) => {
    let c = 0xffffffff
    for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  let at = 8
  let seen = 0
  while (at < png.length) {
    const len = png.readUInt32BE(at)
    const body = png.subarray(at + 4, at + 8 + len)
    assert.equal(png.readUInt32BE(at + 8 + len), crc(body), `CRC of ${png.subarray(at + 4, at + 8)} differs`)
    seen++
    at += 12 + len
  }
  assert.equal(seen, 3, 'chunks must be IHDR / IDAT / IEND')
  assert.equal(at, png.length, 'trailing bytes at the end')
})

test('★★ the quiet zone is white (⚠️ some devices cannot read without it)', () => {
  const png = qrPng(QR, QR_QUIET, 1)
  const side = png.readUInt32BE(16)
  let at = 8
  let idat
  while (at < png.length) {
    const len = png.readUInt32BE(at)
    if (png.subarray(at + 4, at + 8).toString('ascii') === 'IDAT') idat = png.subarray(at + 8, at + 8 + len)
    at += 12 + len
  }
  const raw = inflateSync(idat)
  for (let y = 0; y < QR_QUIET; y++) {
    for (let x = 0; x < side; x++) {
      assert.equal(raw[y * (side + 1) + 1 + x], 0xff, `black in the quiet zone (${x},${y})`)
    }
  }
})
