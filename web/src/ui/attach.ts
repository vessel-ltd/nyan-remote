// ★ Files from the phone (2026-11-17 / agent `uploads.ts`): get a file ready, then send it in chunks.
//
// ⚠️ The agent checks everything again (kind by content, size, hash); this side only avoids sending what would be refused.
// ★ Images are drawn again (at most 2048 px on the long side) before they go: smaller, and **the photo's metadata (EXIF:
//   place, camera, time) is not sent** — an image that cannot be drawn again is refused, never sent as it is.
// ⚠️ A huge image is refused before decoding (input size, and the pixel count from its header / codex review).
// ⚠️ An animated GIF goes as it is (drawing it would keep one frame).

import {
  MAX_UPLOAD_BYTES,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_KINDS,
  uploadExtOf,
  type UploadFinishResult,
  type UploadStartResult,
} from '../../../shared/types.ts'
import { t } from '../../../shared/i18n.ts'

/** The longest side of an image after drawing it again */
export const MAX_IMAGE_SIDE = 2048

/** What the file picker offers (the same table the agent checks against) */
export function acceptAttr(): string {
  const exts = Object.keys(UPLOAD_KINDS).map((e) => `.${e}`)
  return ['image/*', 'application/pdf', ...exts].join(',')
}

export interface Prepared {
  /** The name as sent (its extension is what the agent checks the content against) */
  name: string
  bytes: Uint8Array
}

/** The name without its extension, with another one */
export function renameExt(name: string, ext: string): string {
  const base = name.replace(/\.[^./\\]{1,8}$/, '') || 'image'
  return `${base}.${ext}`
}

function tooBig(): Error {
  return new Error(t(`大きすぎます（${MAX_UPLOAD_BYTES / 1024 / 1024} MB まで）`, `Too large (up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).`))
}

/** ★ An image file this big is not even opened (it would be decoded whole before it could be shrunk) */
export const MAX_IMAGE_INPUT_BYTES = 40 * 1024 * 1024
/** ★ …nor one with more pixels than this (≈ 50 MP; read from its header, before decoding / codex review) */
export const MAX_IMAGE_PIXELS = 50_000_000

/**
 * ★ The size an image says it has, from its first bytes (PNG, JPEG, GIF, WebP). `undefined` = not read (HEIC etc.).
 * ⚠️ Only for refusing a huge image before the browser decodes it; the agent checks the content again.
 */
export function imageDimensions(b: Uint8Array): { width: number; height: number } | undefined {
  const u16 = (i: number): number => (b[i]! << 8) | b[i + 1]!
  const u32 = (i: number): number => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!
  const le16 = (i: number): number => b[i]! | (b[i + 1]! << 8)
  const le24 = (i: number): number => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { width: u32(16), height: u32(20) }
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { width: le16(6), height: le16(8) }
  if (b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
    const kind = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!)
    if (kind === 'VP8X') return { width: le24(24) + 1, height: le24(27) + 1 }
    if (kind === 'VP8L') {
      const v = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)
      return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }
    }
    if (kind === 'VP8 ') return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff }
    return undefined
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // JPEG: walk the segments to a start-of-frame
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined
      const m = b[i + 1]!
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        i += 2
        continue
      }
      const len = u16(i + 2)
      if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: u16(i + 7), height: u16(i + 5) }
      i += 2 + len
    }
    return undefined
  }
  // ⚠️ HEIC / HEIF and anything else: not read (a box format a loose scan can be fooled by / codex review round 3).
  //    The iPhone's picker hands the browser a JPEG for `image/*`, so this costs nothing there
  return undefined
}

/** ★ Draw an image again (browser only). `undefined` = this browser cannot decode it */
async function redraw(file: Blob, asPng: boolean): Promise<Uint8Array | undefined> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return undefined
  let bmp: ImageBitmap | undefined
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
    const k = Math.min(1, MAX_IMAGE_SIDE / Math.max(bmp.width, bmp.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bmp.width * k))
    canvas.height = Math.max(1, Math.round(bmp.height * k))
    const g = canvas.getContext('2d')
    if (!g) return undefined
    g.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, asPng ? 'image/png' : 'image/jpeg', 0.85))
    return blob ? new Uint8Array(await blob.arrayBuffer()) : undefined
  } catch {
    return undefined
  } finally {
    bmp?.close()
  }
}

/** ★ One image is prepared at a time (several big decodes at once could run the phone out of memory) */
let preparing: Promise<unknown> = Promise.resolve()

/**
 * ★ A file as it will be sent. Throws a message for the screen when it cannot go.
 *   Images (also HEIC from an iPhone, when the browser can read it) are drawn again: PNG stays PNG, the others JPEG.
 * ⚠️⚠️ An image that cannot be drawn again is **refused, never sent as it is** (it would carry its EXIF: the place it
 *    was taken). Only a GIF goes as it is (drawing would keep one frame; GIF has no EXIF).
 */
export function prepareFile(file: File): Promise<Prepared> {
  const run = preparing.then(() => prepareOne(file), () => prepareOne(file))
  preparing = run.catch(() => undefined)
  return run
}

async function prepareOne(file: File): Promise<Prepared> {
  const name = file.name || 'file'
  const ext = uploadExtOf(name)
  const isGif = ext === 'gif' || file.type === 'image/gif'
  const isImage = file.type.startsWith('image/') || (ext !== undefined && UPLOAD_KINDS[ext].kind === 'image') || /\.(heic|heif|avif|bmp|tiff?)$/i.test(name)
  if (isImage && !isGif) {
    const cannot = (): Error => new Error(t('この画像はこの端末で変換できないので送れません', 'This image cannot be converted on this device, so it cannot be sent.'))
    if (file.size > MAX_IMAGE_INPUT_BYTES) throw tooBig()
    // ⚠️⚠️ The size must be known **before** decoding: one we cannot read is refused (a JPEG can put its frame header
    //    after large metadata segments, hence the first 4 MB / codex review round 2)
    const dims = imageDimensions(new Uint8Array(await file.slice(0, 4 * 1024 * 1024).arrayBuffer()))
    if (!dims) throw cannot()
    if (dims.width * dims.height > MAX_IMAGE_PIXELS) throw new Error(t('画像が大きすぎます（画素が多すぎる）', 'The image is too large (too many pixels).'))
    const png = ext === 'png' || file.type === 'image/png'
    let bytes = await redraw(file, png)
    // A PNG drawn again can grow past the limit (a photo saved as PNG): then as JPEG
    if (bytes && png && bytes.length > MAX_UPLOAD_BYTES) bytes = await redraw(file, false)
    if (!bytes) throw cannot()
    if (bytes.length > MAX_UPLOAD_BYTES) throw tooBig()
    return { name: renameExt(name, bytes[0] === 0x89 ? 'png' : 'jpg'), bytes }
  }
  if (ext === undefined) throw new Error(t('この種類のファイルは送れません（画像・PDF・テキスト）', 'This kind of file cannot be sent (images, PDF and text only).'))
  if (file.size > MAX_UPLOAD_BYTES) throw tooBig()
  return { name, bytes: new Uint8Array(await file.arrayBuffer()) }
}

/** Base64 of some bytes (in pieces: one `String.fromCharCode` call takes a limited number of arguments) */
export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface UploadTransport {
  uploadStart(name: string, size: number, sha256: string): Promise<UploadStartResult>
  uploadChunk(id: string, offset: number, data: string): Promise<{ received: number }>
  uploadFinish(id: string): Promise<UploadFinishResult>
  uploadCancel(id: string): Promise<{ ok: true }>
}

/** Set `cancelled` to stop between chunks (the agent drops what arrived) */
export interface UploadControl {
  cancelled: boolean
}

/**
 * ★ Send a prepared file: start → chunks strictly in order → finish. `onProgress` gets 0…1.
 * ⚠️ A failure or a cancel tells the agent to drop the upload (best effort: it also expires on its own).
 */
/** ★ At most this many files go at once (the agent allows 4 open per device; 5 can be picked / codex review round 8) */
export const UPLOADS_AT_ONCE = 2
let running = 0
const waiting: Array<() => void> = []

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= UPLOADS_AT_ONCE) await new Promise<void>((r) => waiting.push(r))
  running++
  try {
    return await fn()
  } finally {
    running--
    waiting.shift()?.()
  }
}

export function uploadFile(
  tr: UploadTransport,
  p: Prepared,
  onProgress: (fraction: number) => void,
  control: UploadControl = { cancelled: false },
): Promise<UploadFinishResult> {
  return slot(() => uploadOne(tr, p, onProgress, control))
}

async function uploadOne(
  tr: UploadTransport,
  p: Prepared,
  onProgress: (fraction: number) => void,
  control: UploadControl,
): Promise<UploadFinishResult> {
  // ⚠️ Cancelled while waiting for its turn: never started
  if (control.cancelled) throw new Error(t('取り消しました', 'Cancelled.'))
  const { id, chunkBytes } = await tr.uploadStart(p.name, p.bytes.length, await sha256Hex(p.bytes))
  const step = Math.max(1, Math.min(chunkBytes, UPLOAD_CHUNK_BYTES))
  try {
    for (let off = 0; off < p.bytes.length; off += step) {
      if (control.cancelled) throw new Error(t('取り消しました', 'Cancelled.'))
      const got = await tr.uploadChunk(id, off, toBase64(p.bytes.subarray(off, off + step)))
      onProgress(got.received / p.bytes.length)
    }
    if (control.cancelled) throw new Error(t('取り消しました', 'Cancelled.'))
    return await tr.uploadFinish(id)
  } catch (e) {
    void tr.uploadCancel(id).catch(() => undefined)
    throw e
  }
}
