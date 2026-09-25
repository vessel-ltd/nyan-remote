import assert from 'node:assert/strict'
import { extname } from 'node:path'
import { test } from 'node:test'
import { cacheControl, resolveUnderDist } from './static.ts'

// Can be judged independently of the real DIST (it is a pure function).
const DIST = '/home/user/nyan-remote/web/dist'

test('resolveUnderDist: ordinary paths are served as is', () => {
  assert.equal(resolveUnderDist('/index.html', DIST)?.file, `${DIST}/index.html`)
  assert.equal(resolveUnderDist('/assets/main-abc123.js', DIST)?.file, `${DIST}/assets/main-abc123.js`)
  // a trailing slash is index.html (the SPA root)
  assert.equal(resolveUnderDist('/', DIST)?.file, `${DIST}/index.html`)
  assert.equal(resolveUnderDist('/', DIST)?.pathname, '/index.html')
  // paths without an extension are dropped to index.html by the caller. Allowed here
  assert.equal(resolveUnderDist('/s/abc-123', DIST)?.file, `${DIST}/s/abc-123`)
})

/**
 * ★★ The one invariant to protect:
 *    **Whatever pathname is passed, the returned path must be inside DIST.**
 *
 * ⚠️ If this loosens, each account's `.credentials.json` or `~/.nyan-remote/vapid.json`
 *    can be read from the same origin. The agent serves the PWA itself, so the range is all of home.
 *
 * ⚠️ Do not write "paths containing `..` become null" (I first wrote that and it was wrong).
 *    `url.pathname` always starts with `/`, so `normalize` stops `..` at the root, and
 *    `/../../x` becomes `/x` and **lands inside DIST** (it does not exist, so 404).
 *    ★ Whether it becomes null is an implementation detail. **Not escaping** is the requirement.
 */
function assertInsideDist(pathname: string): void {
  const r = resolveUnderDist(pathname, DIST)
  if (r === null) return // rejecting is also correct
  assert.ok(
    r.file === DIST || r.file.startsWith(`${DIST}/`),
    `escaped DIST: ${JSON.stringify(pathname)} → ${r.file}`,
  )
}

test('★★ resolveUnderDist: trying to go up cannot leave DIST', () => {
  assertInsideDist('/../../.claude/.credentials.json')
  assertInsideDist('/../.nyan-remote/vapid.json')
  assertInsideDist('/assets/../../../etc/passwd')
  assertInsideDist('/..')
  assertInsideDist('/../')
  assertInsideDist('/a/b/c/../../../../../etc/hosts')
  assertInsideDist('//etc/passwd')
  assertInsideDist('/./../../etc/passwd')
})

test('★★ resolveUnderDist: escaping via percent-encoding cannot leave DIST either', () => {
  // ⚠️ decodeURIComponent before deciding. Deciding before decoding makes
  //    `%2e%2e%2f` look like "just a file name" in its raw form
  assertInsideDist('/%2e%2e%2f%2e%2e%2f.claude/.credentials.json')
  assertInsideDist('/%2E%2E/')
  assertInsideDist('/assets/%2e%2e%2f%2e%2e%2fetc/passwd')
  // double escaping
  assertInsideDist('/%252e%252e%252f.claude')
  // ★ the decoded result really is a path that goes up (sanity check of the test itself)
  assert.equal(decodeURIComponent('/%2e%2e%2f'), '/../')
})

test('★ resolveUnderDist: a relative pathname does not escape either (the guard\'s job)', () => {
  // url.pathname always starts with `/` so this does not normally happen; it is the last line of defence if callers change.
  // only here does normalize keep `..`, so the startsWith check actually matters
  assertInsideDist('../../.claude/.credentials.json')
  assert.equal(resolveUnderDist('../../.claude/.credentials.json', DIST), null)
})

test('resolveUnderDist: malformed percent-encoding and NUL are rejected (not a 500)', () => {
  // the shape that makes decodeURIComponent throw. Letting it throw would give a 500
  assert.equal(resolveUnderDist('/%', DIST), null)
  assert.equal(resolveUnderDist('/%zz', DIST), null)
  // NUL characters are used to truncate paths in attacks
  assert.equal(resolveUnderDist('/index.html\0.png', DIST), null)
})

test('★ resolveUnderDist: a neighbouring name (web/dist-secret) is not mistaken for inside DIST', () => {
  // ⚠️ comparing with `startsWith(dist)` alone lets `web/dist-secret/...` through.
  //    this is why the comparison uses `dist + sep`
  // a shape pointing at `web/dist-secret/x.js`. With a prefix match alone it would look inside DIST
  assert.equal(resolveUnderDist('../dist-secret/x.js', DIST), null)
  assert.equal(resolveUnderDist('../distant/x.js', DIST), null)
})

test('★ a path without an extension is treated as an SPA route (a note on the 200 that alarmed us on a real device)', () => {
  // `GET /etc/passwd` returns 200 with **index.html**. It is not a leak:
  // the basename has no `.` (extname('/etc/passwd') === ''), so it is treated as
  // an SPA route and falls back to index.html.
  // ⚠️ Seeing a 200 during the 2026-08-13 device check gave a brief scare, so it is recorded here.
  assert.equal(extname('/etc/passwd'), '')
  assert.equal(extname('/foo.passwd'), '.passwd')
  // either way, the returned path is inside DIST (= no outside file is opened)
  assertInsideDist('/etc/passwd')
  assertInsideDist('/foo.passwd')
})

test('cacheControl: only hashed build outputs are cached permanently', () => {
  assert.match(cacheControl('/assets/main-abc123.js'), /immutable/)
  // ★ making index.html immutable would stop updates from arriving
  assert.equal(cacheControl('/index.html'), 'no-cache')
  assert.equal(cacheControl('/sw.js'), 'no-cache')
  assert.equal(cacheControl('/manifest.webmanifest'), 'no-cache')
})
