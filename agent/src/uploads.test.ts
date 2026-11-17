import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MAX_ATTACHMENTS, MAX_UPLOAD_BYTES, UPLOAD_CHUNK_BYTES } from '../../shared/types.ts'
import { attachmentLines, cleanName, contentMatches, ensureDir, KEEP_MS, MAX_OPEN_PER_DEVICE, OPEN_TTL_MS, UploadError, UploadStore, uploadsDir } from './uploads.ts'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
const PDF = Buffer.from('%PDF-1.4\n%probe\n')
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

async function storeIn(t: { after: (fn: () => Promise<void>) => void }, now = () => Date.now()): Promise<{ dir: string; store: UploadStore }> {
  const root = await mkdtemp(join(tmpdir(), 'nyan-uploads-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'nyan-remote', 'uploads')
  return { dir, store: new UploadStore(() => dir, now) }
}

/** Upload `bytes` as `name` in chunks; returns the finish result */
async function put(store: UploadStore, actor: string, name: string, bytes: Buffer, chunk = UPLOAD_CHUNK_BYTES) {
  const { id } = await store.start(actor, { name, size: bytes.length, sha256: sha(bytes) })
  for (let off = 0; off < bytes.length; off += chunk) {
    await store.chunk(actor, id, { offset: off, data: bytes.subarray(off, off + chunk).toString('base64') })
  }
  return store.finish(actor, id)
}

const status = async (p: Promise<unknown>): Promise<number> => {
  try {
    await p
    return 0
  } catch (e) {
    assert.ok(e instanceof UploadError, `not an UploadError: ${e}`)
    return e.status
  }
}

test('★★ a file arrives in order, its hash and content are checked, and it is kept under a name the agent chose (0600, no link)', async (t) => {
  const { dir, store } = await storeIn(t)
  const big = Buffer.concat([PNG, Buffer.alloc(UPLOAD_CHUNK_BYTES * 2 + 5, 7)])
  const done = await put(store, 'device:aaaa', '../../etc/passwd‮.png', big)
  assert.equal(done.kind, 'image')
  assert.equal(done.name, '.._.._etc_passwd.png', 'the name is cleaned text only')
  const [file] = store.reserve('device:aaaa', [done.id]).files
  assert.equal(file!.path.startsWith(`${dir}/`), true)
  assert.match(file!.path.slice(dir.length + 1), /^\d{8}-\d{6}-[0-9a-f]{32}\.png$/, '⚠️ the phone named the file')
  assert.deepEqual(await readFile(file!.path), big)
  const st = await lstat(file!.path)
  assert.equal(st.isFile() && !st.isSymbolicLink(), true)
  assert.equal(st.mode & 0o777, 0o600)
  assert.equal((await stat(dir)).mode & 0o777, 0o700)
  assert.deepEqual((await readdir(dir)).filter((n) => n.startsWith('.part-')), [], 'no part left behind')
})

test('★★ the content must be what the name says; unknown kinds, oversize and bad hashes are refused', async (t) => {
  const { dir, store } = await storeIn(t)
  // A binary renamed .png / .pdf / .txt
  assert.equal(await status(put(store, 'd', 'x.png', PDF)), 415)
  assert.equal(await status(put(store, 'd', 'x.pdf', PNG)), 415)
  assert.equal(await status(put(store, 'd', 'x.txt', Buffer.from([0x61, 0x00, 0x62]))), 415)
  assert.equal(await status(put(store, 'd', 'x.txt', Buffer.from([0xc3, 0x28]))), 415, 'invalid UTF-8')
  // Kinds we do not take
  for (const name of ['x.exe', 'x.sh', 'x.html', 'x.svg', 'x', 'x.png.exe']) {
    assert.equal(await status(store.start('d', { name, size: 10, sha256: sha(PNG) })), 415, name)
  }
  assert.equal(await status(store.start('d', { name: 'x.png', size: MAX_UPLOAD_BYTES + 1, sha256: sha(PNG) })), 413)
  for (const size of [0, -1, 1.5, '10', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(await status(store.start('d', { name: 'x.png', size, sha256: sha(PNG) })), 400, String(size))
  }
  assert.equal(await status(store.start('d', { name: 'x.png', size: 16, sha256: 'x' })), 400)
  // The hash the phone computed must match what arrived
  const { id } = await store.start('d', { name: 'x.png', size: PNG.length, sha256: sha(PDF) })
  await store.chunk('d', id, { offset: 0, data: PNG.toString('base64') })
  assert.equal(await status(store.finish('d', id)), 400)
  // Text that is text passes
  assert.equal((await put(store, 'd', 'メモ.md', Buffer.from('# こんにちは\n'))).kind, 'text')
  // Every refusal left nothing behind but the one kept file
  assert.equal((await readdir(dir)).length, 1)
})

test('★★ chunks: strictly in order, never past the declared size, strict base64, at most one chunk size', async (t) => {
  const { store } = await storeIn(t)
  const bytes = Buffer.concat([PNG, Buffer.alloc(100, 1)])
  const { id } = await store.start('d', { name: 'x.png', size: bytes.length, sha256: sha(bytes) })
  assert.equal(await status(store.chunk('d', id, { offset: 5, data: bytes.toString('base64') })), 409, 'out of order')
  assert.equal(await status(store.chunk('d', id, { offset: 0, data: 'not base64!' })), 400)
  assert.equal(await status(store.chunk('d', id, { offset: 0, data: ` ${bytes.toString('base64')}` })), 400, 'whitespace')
  assert.equal(await status(store.chunk('d', id, { offset: 0, data: Buffer.alloc(bytes.length + 1).toString('base64') })), 400, 'past the size')
  assert.equal(await status(store.chunk('d', id, { offset: 0, data: Buffer.alloc(UPLOAD_CHUNK_BYTES + 3).toString('base64') })), 400, 'too big a chunk')
  // Two chunks sent at once: one goes in order, the other is refused (no interleaved writes)
  const half = bytes.length >> 1
  const both = await Promise.allSettled([
    store.chunk('d', id, { offset: 0, data: bytes.subarray(0, half).toString('base64') }),
    store.chunk('d', id, { offset: 0, data: bytes.subarray(0, half).toString('base64') }),
  ])
  assert.deepEqual(both.map((r) => r.status).sort(), ['fulfilled', 'rejected'])
  await store.chunk('d', id, { offset: half, data: bytes.subarray(half).toString('base64') })
  // Finishing before everything arrived is refused (and ends the upload)
  assert.equal((await store.finish('d', id)).kind, 'image')
})

test('★★ an upload belongs to the device that started it: another one can neither add to it, finish it nor attach it', async (t) => {
  const { store } = await storeIn(t)
  const { id } = await store.start('device:aaaa', { name: 'x.png', size: PNG.length, sha256: sha(PNG) })
  assert.equal(await status(store.chunk('device:bbbb', id, { offset: 0, data: PNG.toString('base64') })), 404)
  assert.equal(await status(store.finish('device:bbbb', id)), 404)
  assert.equal(await status(store.cancel('device:bbbb', id)), 404)
  await store.chunk('device:aaaa', id, { offset: 0, data: PNG.toString('base64') })
  const done = await store.finish('device:aaaa', id)
  const is409 = (e: unknown): boolean => e instanceof UploadError && e.status === 409
  assert.throws(() => store.reserve('device:bbbb', [done.id]), is409)
  // ★ Reserved by one send: a concurrent send cannot use it; released ⇒ usable again; consumed ⇒ gone (rule 8)
  const first = store.reserve('device:aaaa', [done.id])
  assert.equal(first.files.length, 1)
  assert.throws(() => store.reserve('device:aaaa', [done.id]), is409, '⚠️ two sends used the same attachment')
  first.release()
  const second = store.reserve('device:aaaa', [done.id])
  second.consume()
  second.release()
  assert.throws(() => store.reserve('device:aaaa', [done.id]), is409, 'used twice')
  // Shapes of the id list
  for (const ids of ['x', [1], ['zz'], Array(MAX_ATTACHMENTS + 1).fill('a'.repeat(32)), [done.id, done.id]]) {
    assert.throws(() => store.reserve('device:aaaa', ids), (e: unknown) => e instanceof UploadError, JSON.stringify(ids))
  }
  assert.deepEqual(store.reserve('device:aaaa', undefined).files, [])
})

test('★★ the directory must be ours: a link or a group-readable one is refused, never repaired', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nyan-uploads-dir-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  // A link where the folder should be
  await mkdir(join(root, 'a', 'nyan-remote'), { recursive: true, mode: 0o700 })
  await mkdir(join(root, 'elsewhere'), { mode: 0o700 })
  await symlink(join(root, 'elsewhere'), join(root, 'a', 'nyan-remote', 'uploads'))
  assert.equal(await status(ensureDir(join(root, 'a', 'nyan-remote', 'uploads'))), 500)
  // Readable by others
  await mkdir(join(root, 'b', 'nyan-remote', 'uploads'), { recursive: true, mode: 0o700 })
  await chmod(join(root, 'b', 'nyan-remote', 'uploads'), 0o755)
  assert.equal(await status(ensureDir(join(root, 'b', 'nyan-remote', 'uploads'))), 500)
  // ⚠️ Never inside the state directory by default
  assert.match(uploadsDir({ HOME: '/home/user' }), /\/\.local\/share\/nyan-remote\/uploads$/)
  assert.equal(uploadsDir({ XDG_DATA_HOME: '/data' }), '/data/nyan-remote/uploads')
  assert.match(uploadsDir({ XDG_DATA_HOME: 'relative' }), /\/\.local\/share\/nyan-remote\/uploads$/, 'a relative XDG path is ignored')
})

test('★ limits: open uploads per device; unfinished ones expire; kept files go after a week; only our names are removed', async (t) => {
  let now = Date.parse('2026-11-17T00:00:00Z')
  const { dir, store } = await storeIn(t, () => now)
  const ids = []
  for (let i = 0; i < MAX_OPEN_PER_DEVICE; i++) ids.push((await store.start('d', { name: 'x.png', size: 16, sha256: sha(PNG) })).id)
  assert.equal(await status(store.start('d', { name: 'x.png', size: 16, sha256: sha(PNG) })), 429)
  assert.equal(await status(store.start('e', { name: 'x.png', size: 16, sha256: sha(PNG) })), 0, 'another device is not blocked')
  // Ten minutes later the unfinished ones are gone (parts removed)
  now += OPEN_TTL_MS + 1
  assert.equal(await status(store.start('d', { name: 'x.png', size: 16, sha256: sha(PNG) })), 0)
  assert.equal(await status(store.chunk('d', ids[0]!, { offset: 0, data: PNG.toString('base64') })), 404)
  // A kept file older than a week goes; a file that is not ours stays
  const kept = await put(store, 'f', 'y.pdf', PDF)
  const [file] = store.reserve('f', [kept.id]).files
  await writeFile(join(dir, 'notes.txt'), 'mine')
  const old = new Date(now - KEEP_MS - 1000)
  await utimes(file!.path, old, old)
  await utimes(join(dir, 'notes.txt'), old, old)
  // ★ The timer's sweep (not another upload) removes it
  await store.sweep()
  const names = await readdir(dir)
  assert.equal(names.includes('notes.txt'), true)
  assert.equal(names.some((n) => file!.path.endsWith(n)), false)
})

test('★ cleanName: text only — no controls, bidi, separators or slashes; bounded', () => {
  assert.equal(cleanName('見積書.pdf'), '見積書.pdf')
  assert.equal(cleanName('a‮b​c\nd/e\\f.txt'), 'abc d_e_f.txt')
  assert.equal(cleanName('x'.repeat(200)).length, 80)
  for (const v of ['', '.', '..', 3, undefined, '\u0000']) assert.equal(cleanName(v), 'file')
})

test('★ contentMatches: the signatures', () => {
  assert.equal(contentMatches('png', PNG), true)
  assert.equal(contentMatches('jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])), true)
  assert.equal(contentMatches('gif', Buffer.from('GIF89a')), true)
  assert.equal(contentMatches('webp', Buffer.from('RIFF\0\0\0\0WEBP')), true)
  assert.equal(contentMatches('webp', Buffer.from('RIFF\0\0\0\0WAVE')), false)
  assert.equal(contentMatches('pdf', PDF), true)
  assert.equal(contentMatches('txt', Buffer.alloc(0)), false, 'text needs the whole file')
})

test('★ attachmentLines: the agent\'s own paths, cleaned names, before the person\'s text', () => {
  const lines = attachmentLines([
    { path: '/home/user/.local/share/nyan-remote/uploads/20261117-000000-' + 'a'.repeat(32) + '.pdf', kind: 'pdf', size: 120 * 1024 },
    { path: '/home/user/.local/share/nyan-remote/uploads/20261117-000000-' + 'b'.repeat(32) + '.png', kind: 'image', size: 3 * 1024 * 1024 },
  ])
  assert.match(lines, /^.+:\n- \/home\/user\/.+\.pdf （PDF・120 KB）\n- .+\.png （.+・3\.0 MB）\n\n$/)
  assert.equal(attachmentLines([]), '')
})

test('★ an expired upload takes no more chunks even when nobody starts another one (codex review)', async (t) => {
  let now = Date.parse('2026-11-17T00:00:00Z')
  const { dir, store } = await storeIn(t, () => now)
  const { id } = await store.start('d', { name: 'x.png', size: PNG.length, sha256: sha(PNG) })
  now += OPEN_TTL_MS + 1
  assert.equal(await status(store.chunk('d', id, { offset: 0, data: PNG.toString('base64') })), 404)
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual((await readdir(dir)).filter((n) => n.startsWith('.part-')), [], 'its part was removed')
})

test('★★ concurrent starts cannot all take the same room (reserved before any await / codex review)', async (t) => {
  const { store } = await storeIn(t)
  const tries = await Promise.allSettled(
    Array.from({ length: 20 }, () => store.start('d', { name: 'x.pdf', size: 10 * 1024 * 1024, sha256: sha(PDF) })),
  )
  const ok = tries.filter((r) => r.status === 'fulfilled').length
  assert.ok(ok <= MAX_OPEN_PER_DEVICE, `${ok} started at once`)
})

test('★★ every ancestor of the real path must be safe: a folder others can write (not sticky) is refused (codex review)', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nyan-uploads-anc-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'shared'))
  await chmod(join(root, 'shared'), 0o777)
  assert.equal(await status(ensureDir(join(root, 'shared', 'nyan-remote', 'uploads'))), 500)
  // Sticky (like /tmp): others cannot rename what is ours inside it
  await chmod(join(root, 'shared'), 0o1777)
  assert.equal(await status(ensureDir(join(root, 'shared', 'nyan-remote', 'uploads'))), 0)
  // A link on the way is followed to its real path, and that path is what is checked and used
  await mkdir(join(root, 'real'), { mode: 0o700 })
  await symlink(join(root, 'real'), join(root, 'via'))
  assert.equal(await ensureDir(join(root, 'via', 'nyan-remote', 'uploads')), join(await realpathOf(root), 'real', 'nyan-remote', 'uploads'))
})

async function realpathOf(p: string): Promise<string> {
  const { realpath } = await import('node:fs/promises')
  return realpath(p)
}

test('★ a part left by a previous run is removed before anything is accepted (never outside the quota / codex review round 2)', async (t) => {
  const { dir, store } = await storeIn(t)
  await ensureDir(dir)
  const orphan = join(dir, `.part-${'c'.repeat(32)}`)
  await writeFile(orphan, Buffer.alloc(1024))
  await store.start('d', { name: 'x.png', size: 16, sha256: sha(PNG) })
  const names = await readdir(dir)
  assert.equal(names.includes(`.part-${'c'.repeat(32)}`), false)
  assert.equal(names.filter((n) => n.startsWith('.part-')).length, 1, 'only the new upload\'s part')
})
