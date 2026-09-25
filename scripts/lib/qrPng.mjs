// ★★ Render the QR as a **PNG** (2026-09-22 / the image did not open on mac).
//
// ⚠️⚠️ **Why we dropped SVG**: what happens when you `open` an `.svg` on macOS
//    **depends on the environment** (with Xcode installed it opens in **a code editor**; sometimes there is no default app).
//    ⇒ Do not bet "the image shows up" on the environment. **A PNG always opens in Preview.**
//
// ⚠️ No new dependencies (CLAUDE.md §2): written with Node's built-in `zlib` only.
//    ⚠️⚠️ **It cannot live in `shared/`** — that is also type-checked from web, so `node:zlib`
//       cannot be used there (the flip side of CLAUDE.md "do not write DOM type names"). Hence `scripts/lib/`.
//
// ★ Format is **8-bit grayscale (color type 0)**. QR is black and white so this suffices
//   (no palette, no transparency = the least to write).

import { deflateSync } from 'node:zlib'

/** ⚠️ PNG CRC-32 (⚠️ not zlib's adler32. Needed per chunk) */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** ⚠️ A chunk is "length, type, data, CRC". The CRC covers **type and data** (not the length) */
function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/**
 * ★ Turn a QR into PNG bytes.
 *
 * @param qr what `makeQr` in `shared/qr.ts` returns
 * @param quiet quiet zone (in modules. ⚠️ the caller passes `QR_QUIET` = do not pick a different number here)
 * @param scale pixels per module (⚠️ too small and it cannot be read)
 */
export function qrPng(qr, quiet, scale = 10) {
  const side = (qr.size + quiet * 2) * scale
  // ★ Each scanline needs a leading filter-type byte (0 = none)
  const raw = Buffer.alloc((side + 1) * side, 0xff)
  for (let y = 0; y < side; y++) {
    raw[y * (side + 1)] = 0
    const my = Math.floor(y / scale) - quiet
    if (my < 0 || my >= qr.size) continue
    for (let x = 0; x < side; x++) {
      const mx = Math.floor(x / scale) - quiet
      if (mx < 0 || mx >= qr.size) continue
      if (qr.modules[my][mx]) raw[y * (side + 1) + 1 + x] = 0x00
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(side, 0)
  ihdr.writeUInt32BE(side, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // ★ grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
