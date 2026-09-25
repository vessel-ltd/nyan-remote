/* nyan-remote Service Worker — hand-written (why no Workbox: CLAUDE.md §2)
 *
 * In M0 its only job is caching the app shell. Push reception is added in M1.
 * Why it lives in public/ as plain JS:
 *   - It must be served at root scope under a fixed name (/sw.js) (can't be hashed)
 *   - No generated code mixed in, keeping the served JS small enough to read (the §14.4 trust model)
 */

// ★★ Bumping the version makes `activate` **clean up old caches** (`migrate` below).
//   ⚠️ v1 → v2 on 2026-09-16. `/index.html` had gone stale since install day, and
//      **old JS was running only when launched offline**.
//   ⚠️⚠️ **Just bumping the name is dangerous** (codex round 5, medium #4): old caches hold
//      `/assets/*.js`, but `install` only adds the shell.
//      **A running page doesn't refetch its JS**, so going offline after deleting it gives
//      "shell but no JS" = **can't start**.
//   ⇒ `migrate` **carries over only `/assets/` from old caches before** deleting them
//      (⚠️ **the shell is not carried over** = don't bring a stale shell along).
//   ⚠️ Only the cache is removed (endpoints in `localStorage` and the device key in IndexedDB remain).
const CACHE = 'tmux-agent-shell-v2'

// ★★ **Only one key for the shell** (2026-09-16 / codex round 5, medium #1).
//   ⚠️⚠️ Originally it was written to **both** `/` and `/index.html`, but that spans two `await`s, so
//      **another navigation's save can interleave and leave only one of them new** (= version depends on how it was launched).
//   ⇒ **`/` is not stored.** Requests for `/` then always miss and
//      fall back to `SHELL_KEY` = **the mismatch structurally can't happen**.
//   ★ A launch URL with a query (`?source=pwa` in `start_url`, etc.) takes the same path.
const SHELL_KEY = '/index.html'
const SHELL = [SHELL_KEY, '/manifest.webmanifest']
/**
 * ★ Also keep the notification images and icons locally (⚠️ so notifications arriving while offline don't lack images / 2026-09-24).
 * ⚠️⚠️ **Kept separate from the shell (`SHELL`)** (codex round 21, medium #2): `cache.addAll` aborts entirely if any one fails,
 *    so mixing them into the shell means **one bad image blocks switching to a new version**. Install continues even if images fail.
 */
const EXTRAS = ['/icons/icon-any-192.png', '/icons/notify-256.png', '/icons/badge-96.png', '/icons/apple-touch-icon-180.png']

self.addEventListener('install', (event) => {
  event.waitUntil(installShell({ caches, fetch: (r) => fetch(r) }).then(() => self.skipWaiting()))
})

/**
 * ★★ Secure the shell together with **the build outputs it points to** (2026-09-16 / codex round 6, A-2).
 *
 * ⚠️⚠️ The previous version only added the shell, but `migrate` carries over **JS present in old caches**, so
 *    **a new shell pointing to JS with a different hash doesn't match**.
 *    ⇒ Update with the old screen open → only the new shell is added → go offline before loading the new JS →
 *      **can't start** (= left over from the previous fix).
 * ⚠️ **Install succeeds even if build outputs can't be fetched** (they're added next time it opens).
 *    Failing install keeps the SW from being replaced, which is worse: stuck with a stale shell.
 */
async function installShell(env) {
  const cache = await env.caches.open(CACHE)
  await cache.addAll(SHELL)
  const shell = await cache.match(SHELL_KEY)
  if (!shell) return
  const html = await shell.text()
  // ⚠️ `/assets/…` inside the shell (hashed, so these are this version's outputs themselves) are not refetched if present.
  // ⚠️⚠️ Notification images etc. (`EXTRAS`) are **refetched every time** (fixed names = what's present may be an old version.
  //    Skipping when present means **old images linger even after replacing them** / codex round 22, low #2). Keep the old one if the fetch fails.
  const assets = new Set(html.match(/\/assets\/[A-Za-z0-9._-]+/g) ?? [])
  for (const url of [...assets, ...EXTRAS]) {
    if (assets.has(url) && (await cache.match(url))) continue
    try {
      const res = await env.fetch(url)
      if (res.ok) await cache.put(url, res.clone())
    } catch {
      // ⚠️ Keep going even if the fetch fails
    }
  }
}

self.addEventListener('activate', (event) => {
  event.waitUntil(migrate({ caches }).then(() => self.clients.claim()))
})

/**
 * ★★ Clean up old caches. **Carry over only `/assets/`** (codex round 5, medium #4).
 *
 * ⚠️⚠️ **The shell is not carried over** (carrying it over defeats bumping the name = a stale shell remains).
 * ⚠️ Also delete **old `/` entries left in the same-named cache** (from when two keys were written.
 *    If left, requests for `/` hit them and **the old shell shows again**).
 */
async function migrate(env) {
  const cache = await env.caches.open(CACHE)
  // ⚠️ Leftover from when two keys were written (this version does not store `/`)
  await cache.delete('/')
  for (const name of await env.caches.keys()) {
    if (name === CACHE) continue
    const old = await env.caches.open(name)
    for (const req of await old.keys()) {
      // ⚠️ Carry over **build outputs only** (their names include a hash, so old ones won't match)
      if (!new URL(req.url).pathname.startsWith('/assets/')) continue
      if (await cache.match(req)) continue
      const res = await old.match(req)
      if (res) await cache.put(req, res)
    }
    await env.caches.delete(name)
  }
}

/** Don't cache the API. Showing stale state is the worst thing for a notification app. */
function isApi(pathname) {
  // ⚠️ Don't cache the agent API.
  //    ★ /permissions was forgotten, so the pending-approval list was being cached
  //      (confirmed with Playwright on 2026-08-12). Offline, **approvals that no longer exist** were
  //      shown, and pressing them reached nobody: a false screen.
  //    When adding a new API, add it here too.
  return (
    pathname === '/health' ||
    pathname === '/events' ||
    pathname === '/hook' ||
    pathname === '/peers' ||
    pathname.startsWith('/sessions') ||
    pathname.startsWith('/permission') ||
    pathname.startsWith('/push')
  )
}

/**
 * ★★ How the shell (the app itself) is answered. **The decision lives in this one place** (exercised by `web/src/sw.test.ts`).
 *
 * ⚠️ Dependencies come in as arguments (`fetch` / `caches`). The SW isn't bundled, so unless
 *    it's shaped to be testable from Node it becomes **code where not one line runs**
 *    (we hit the same thing in `relay/src/worker.ts` / CLAUDE.md).
 *    ⚠️⚠️ **Testing only the function isn't enough** (codex round 5, medium #5): removing `event.respondWith(…)`
 *    left all function tests green ⇒ tests must run **from the event**.
 */
async function respondShell(req, env) {
  const url = new URL(req.url)
  // Hashed build outputs are cache-first (names change, so old ones won't match)
  if (url.pathname.startsWith('/assets/')) {
    const hit = await env.caches.match(req)
    if (hit) return hit
    const res = await env.fetch(req)
    if (res.ok) await keepShell(req, res, env)
    return res
  }
  const navigate = req.mode === 'navigate'
  try {
    const res = await env.fetch(req)
    if (res.ok) {
      // ⚠️⚠️ **`navigate` doesn't mean "HTML"** (codex round 5, medium #3).
      //    **Opening `/icon.svg` directly in the browser** is also navigate, so without checking,
      //    **that SVG would be stored as the shell** (= the next offline launch shows an image).
      if (navigate) {
        if (isHtml(res)) await keepShell(SHELL_KEY, res, env)
      } else {
        await keepShell(req, res, env)
      }
      return res
    }
    // ★ If a page request fails, serve the cached shell (review medium, 2026-08-14).
    //   ⚠️ When the agent returns 503 for "config is broken", as-is
    //      **raw JSON is shown instead of the app**. With the shell, the reason can be shown properly on screen.
    if (navigate) {
      const shell = await cachedShell(req, env)
      if (shell) return shell
    }
    return res
  } catch (err) {
    const shell = await cachedShell(req, env)
    if (shell) return shell
    throw err
  }
}

/** ⚠️ Only HTML content becomes the shell (checks `content-type` / medium #3) */
function isHtml(res) {
  return (res.headers?.get('content-type') ?? '').includes('text/html')
}

/**
 * ★★ Read the shell **only from the current cache** (2026-09-16 / codex round 6, A-1).
 *
 * ⚠️⚠️ It used `caches.match()` (= search every cache), so when `migrate`
 *    **failed midway (e.g. over quota) and couldn't delete old caches**,
 *    **the shell in the older cache won** (= the old screen appears again).
 *    ⚠️ Even if `activate` fails, **the new SW becomes active**, so this can really happen.
 * ★ On the other hand **`/assets/` may be searched across all caches** (names include a hash = identical contents are
 *    guaranteed by the name). ⇒ Build outputs in old caches are usable even mid-migration.
 */
async function cachedShell(req, env) {
  const cache = await env.caches.open(CACHE)
  return (await cache.match(req)) ?? (await cache.match(SHELL_KEY))
}

/**
 * ★★ Store what was fetched. ⚠️⚠️ **A failed save must not destroy a successfully fetched response**
 * (codex round 5, medium #2). With insufficient quota `put` **can fail per spec**, and
 * letting it throw drops into `catch`, **showing an old shell while online** / failing the JS fetch.
 */
async function keepShell(key, res, env) {
  try {
    const cache = await env.caches.open(CACHE)
    await cache.put(key, res.clone())
  } catch {
    // ⚠️ Even if saving fails, return the fetched response as-is (it's stored again next time it opens)
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (isApi(url.pathname)) return
  event.respondWith(respondShell(req, { fetch: (r) => fetch(r), caches }))
})

// ★★ The notification receiver is **the single `push-core.js`** (split out on 2026-09-21).
//   ⚠️⚠️ `push-sw.js` (per-agent scopes) **loads the same file**, so
//      don't write push handling back here (writing it in two places always drifts).
importScripts('/push-core.js')
