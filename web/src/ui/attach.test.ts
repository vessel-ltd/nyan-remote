import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { MAX_UPLOAD_BYTES, UPLOAD_CHUNK_BYTES } from '../../../shared/types.ts'
import { acceptAttr, prepareFile, renameExt, sha256Hex, toBase64, uploadFile, UPLOADS_AT_ONCE, type UploadTransport } from './attach.ts'

test('base64 and sha256 match Node\'s (big inputs too)', async () => {
  const bytes = new Uint8Array(200_000).map((_, i) => (i * 31) & 0xff)
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'))
  assert.equal(await sha256Hex(bytes), createHash('sha256').update(bytes).digest('hex'))
})

test('the picker offers what the agent takes; renaming keeps the base name', () => {
  const a = acceptAttr()
  for (const x of ['image/*', 'application/pdf', '.pdf', '.txt', '.md', '.csv', '.json']) assert.ok(a.split(',').includes(x), x)
  assert.ok(!a.includes('.exe') && !a.includes('.html') && !a.includes('.svg'))
  assert.equal(renameExt('IMG_0001.HEIC', 'jpg'), 'IMG_0001.jpg')
  assert.equal(renameExt('.heic', 'jpg'), 'image.jpg')
})

test('prepareFile: PDF and text go as they are; other kinds and oversize are refused before sending', async () => {
  const pdf = await prepareFile(new File([new TextEncoder().encode('%PDF-1.4')], '見積書.pdf', { type: 'application/pdf' }))
  assert.equal(pdf.name, '見積書.pdf')
  assert.equal(pdf.bytes.length, 8)
  assert.equal((await prepareFile(new File(['# x'], 'メモ.md'))).name, 'メモ.md')
  await assert.rejects(prepareFile(new File(['x'], 'run.sh')))
  await assert.rejects(prepareFile(new File(['x'], 'page.html', { type: 'text/html' })))
  await assert.rejects(prepareFile(new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], 'big.pdf')))
})

function fakeAgent(fail?: { at: number }) {
  const calls: string[] = []
  let got = Buffer.alloc(0)
  const tr: UploadTransport = {
    async uploadStart(name, size, sha256) {
      calls.push(`start ${name} ${size} ${sha256.slice(0, 8)}`)
      return { id: 'a'.repeat(32), chunkBytes: UPLOAD_CHUNK_BYTES }
    },
    async uploadChunk(_id, offset, data) {
      if (fail && offset >= fail.at) throw new Error('line dropped')
      assert.equal(offset, got.length, 'chunks out of order')
      got = Buffer.concat([got, Buffer.from(data, 'base64')])
      calls.push(`chunk ${offset}`)
      return { received: got.length }
    },
    async uploadFinish(id) {
      calls.push('finish')
      return { id, name: 'x.pdf', kind: 'pdf', size: got.length }
    },
    async uploadCancel() {
      calls.push('cancel')
      return { ok: true }
    },
  }
  return { tr, calls, bytes: () => got }
}

test('uploadFile: chunks in order, progress up to 1, finish; the bytes arrive exactly', async () => {
  const a = fakeAgent()
  const bytes = new Uint8Array(UPLOAD_CHUNK_BYTES * 2 + 7).map((_, i) => i & 0xff)
  const seen: number[] = []
  const done = await uploadFile(a.tr, { name: 'x.pdf', bytes }, (f) => seen.push(f))
  assert.equal(done.size, bytes.length)
  assert.deepEqual(a.bytes(), Buffer.from(bytes))
  assert.deepEqual(seen.at(-1), 1)
  assert.deepEqual(a.calls.filter((c) => c.startsWith('chunk')).length, 3)
})

test('uploadFile: a failure or a cancel tells the agent to drop it', async () => {
  const a = fakeAgent({ at: UPLOAD_CHUNK_BYTES })
  await assert.rejects(uploadFile(a.tr, { name: 'x.pdf', bytes: new Uint8Array(UPLOAD_CHUNK_BYTES + 1) }, () => undefined))
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(a.calls.at(-1), 'cancel')
  const b = fakeAgent()
  const control = { cancelled: false }
  await assert.rejects(uploadFile(b.tr, { name: 'x.pdf', bytes: new Uint8Array(UPLOAD_CHUNK_BYTES + 1) }, () => (control.cancelled = true), control))
  await new Promise((r) => setTimeout(r, 0))
  assert.ok(!b.calls.includes('finish') && b.calls.at(-1) === 'cancel')
})

test('imageDimensions: reads PNG, GIF, JPEG and WebP sizes from the header (a pixel budget before decoding)', async () => {
  const { imageDimensions } = await import('./attach.ts')
  const png = new Uint8Array(24)
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  png.set([0, 0, 0x4e, 0x20, 0, 0, 0x4e, 0x20], 16)
  assert.deepEqual(imageDimensions(png), { width: 20000, height: 20000 })
  assert.deepEqual(imageDimensions(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00])), { width: 320, height: 240 })
  // JPEG: SOI, an APP0 segment, then SOF0 (height 600, width 800)
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0, 0, 0, 0])
  assert.deepEqual(imageDimensions(jpg), { width: 800, height: 600 })
  const webp = new Uint8Array(30)
  webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58])
  webp.set([0xff, 0x0f, 0x00, 0xff, 0x0f, 0x00], 24)
  assert.deepEqual(imageDimensions(webp), { width: 4096, height: 4096 })
  assert.equal(imageDimensions(new Uint8Array([1, 2, 3])), undefined)
  // ★ A JPEG frame header after large metadata is still found (the budget cannot be dodged by padding)
  const app = new Uint8Array(4 + 60_000)
  app.set([0xff, 0xe1, 0xea, 0x62])
  const late = new Uint8Array([0xff, 0xd8, ...[...Array(5)].flatMap(() => [...app]), 0xff, 0xc0, 0x00, 0x11, 0x08, 0x4e, 0x20, 0x4e, 0x20, 0x03, 0, 0, 0, 0])
  assert.deepEqual(imageDimensions(late), { width: 20000, height: 20000 })
  // ⚠️ HEIC is not read (a fake small `ispe` box could hide the real size): unknown ⇒ refused before decoding
  const heic = new Uint8Array(64)
  heic.set([0, 0, 0, 20, 0x69, 0x73, 0x70, 0x65, 0, 0, 0, 0, 0, 0, 0x00, 0x01, 0, 0, 0x00, 0x01], 4)
  assert.equal(imageDimensions(heic), undefined)
})

test('prepareFile: an image this device cannot draw again is refused, never sent as it is (its EXIF would go)', async () => {
  // Node has no canvas: exactly the "cannot convert" case
  const jpg = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])], 'IMG_0001.jpg', { type: 'image/jpeg' })
  await assert.rejects(prepareFile(jpg), /変換できない|cannot be converted/)
  const heic = new File([new Uint8Array(16)], 'IMG_0002.HEIC', { type: 'image/heic' })
  await assert.rejects(prepareFile(heic))
  // A GIF goes as it is
  const gif = new File([new TextEncoder().encode('GIF89a\x01\x00\x01\x00')], 'a.gif', { type: 'image/gif' })
  assert.equal((await prepareFile(gif)).name, 'a.gif')
})

test('★ five files picked at once: at most UPLOADS_AT_ONCE go at the same time, all finish (codex review round 8)', async () => {
  let open = 0
  let peak = 0
  const tr: UploadTransport = {
    async uploadStart() {
      open++
      peak = Math.max(peak, open)
      return { id: 'a'.repeat(32), chunkBytes: UPLOAD_CHUNK_BYTES }
    },
    async uploadChunk(_id, _offset, data) {
      await new Promise((r) => setTimeout(r, 5))
      return { received: Buffer.from(data, 'base64').length }
    },
    async uploadFinish(id) {
      open--
      return { id, name: 'x.txt', kind: 'text', size: 1 }
    },
    async uploadCancel() {
      return { ok: true }
    },
  }
  const done = await Promise.all(Array.from({ length: 5 }, () => uploadFile(tr, { name: 'x.txt', bytes: new Uint8Array([0x61]) }, () => undefined)))
  assert.equal(done.length, 5)
  assert.ok(peak <= UPLOADS_AT_ONCE, `${peak} at once`)
})
