// ★ Read and test **the very functions** in the served `public/sw.js`.
//   ⚠️ sw.js isn't bundled (it must be served at root scope under a fixed name), so it can't be imported.
//      A copy wouldn't notice **when only one side is fixed**, so extract from the source and evaluate it.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const SRC = readFileSync(join(import.meta.dirname, '..', 'public', 'sw.js'), 'utf8')

/**
 * ★★ The notification receiver moved to **`push-core.js`** (2026-09-21).
 *
 * ⚠️⚠️ Subscriptions are split into per-agent scopes, so **several SWs are registered**
 *   (`sw.js` and `push-sw.js`). Writing push handling in two places **always drifts**,
 *   and if only one breaks it becomes "**only that machine's notifications don't show**", which is extremely hard to isolate.
 *   ⇒ One file, **`importScripts`-ed from both**.
 */
const PUSH = readFileSync(join(import.meta.dirname, '..', 'public', 'push-core.js'), 'utf8')

test('★★ both SWs load push-core (wiring)', () => {
  // ⚠️⚠️ Removing the load means **not a single notification shows**, yet every other test stays green
  for (const f of ['sw.js', 'push-sw.js']) {
    const src = readFileSync(join(import.meta.dirname, '..', 'public', f), 'utf8')
    assert.match(src, /^importScripts\('\/push-core\.js'\)$/m, `${f} does not load push-core.js`)
  }
  // ⚠️ The push-only SW **holds no shell** (if it did, version cleanup would break)
  const ps = readFileSync(join(import.meta.dirname, '..', 'public', 'push-sw.js'), 'utf8')
  assert.doesNotMatch(ps, /caches/, '⚠️⚠️ the push-only SW holds a cache')
})

interface Shown {
  tag: string
  machine?: string
  timestamp?: number
}
type StaleTags = (
  shown: Shown[],
  pushAt: unknown,
  machine: unknown,
  pending: unknown,
  ownTag?: unknown,
) => string[]

function loadStaleTags(): StaleTags {
  const m = PUSH.match(/function staleTags\([\s\S]*?\n\}/)
  assert.ok(m, 'push-core.js has no staleTags (if renamed, fix this test too)')
  return new Function(`${m[0]}; return staleTags`)() as StaleTags
}

const AT = 1_000_000
/** Notification shown before the list (= known to the snapshot) */
const old = (tag: string, machine = 'PC-A'): Shown => ({ tag, machine, timestamp: AT - 1000 })

test('★★ sw: closes only notifications for approvals no longer pending', () => {
  const staleTags = loadStaleTags()
  const shown = [
    old('perm-PC-A-a'), // answered → close
    old('perm-PC-A-b'), // still pending → keep
    old('perm-PC-B-c', 'PC-B'), // another machine → leave alone
    old('PC-A/.claude-r/proj/sess'), // state notification → leave alone
  ]
  assert.deepEqual(staleTags(shown, AT, 'PC-A', ['perm-PC-A-b']), ['perm-PC-A-a'])
})

test('★★ sw: does not close notifications newer than the list (an old push arriving late)', () => {
  // ⚠️⚠️ `/code-review` high #1, 2026-08-20. Push ordering isn't guaranteed, so
  //    **a payload built before an approval was raised may arrive later**. Closing then
  //    **removes the only signal of an approval still awaiting an answer** (the CLI keeps waiting 86400 seconds).
  const staleTags = loadStaleTags()
  const newer: Shown = { tag: 'perm-PC-A-new', machine: 'PC-A', timestamp: AT + 1 }
  assert.deepEqual(staleTags([newer], AT, 'PC-A', []), [])
  // Equal timestamps aren't closed either (can't tell which came first)
  assert.deepEqual(
    staleTags([{ ...newer, timestamp: AT }], AT, 'PC-A', []),
    [],
  )
  // ★ Old ones are closed (the rule has not collapsed into "never close")
  assert.deepEqual(staleTags([old('perm-PC-A-x')], AT, 'PC-A', []), ['perm-PC-A-x'])
})

test('★★ sw: owner is determined by the machine stored on the notification (not tag prefix match)', () => {
  // ⚠️ In `perm-<machine>-<key>` both machine and key may contain `-`, so it can't be split.
  //    If a push from `pc-b` prefix-matched `pc-b-wsl` notifications,
  //    it would **close another machine's pending-approval notifications** (same review, medium #2).
  const staleTags = loadStaleTags()
  const other: Shown = { tag: 'perm-pc-b-wsl-k', machine: 'pc-b-wsl', timestamp: AT - 1 }
  assert.deepEqual(staleTags([other], AT, 'pc-b', []), [])
  // Notifications without a machine (shown before this fix) are left alone too
  assert.deepEqual(staleTags([{ tag: 'perm-pc-b-k', timestamp: AT - 1 }], AT, 'pc-b', []), [])
})

test('★★ sw: does nothing without a list (fail-open forbidden)', () => {
  const staleTags = loadStaleTags()
  const shown = [old('perm-PC-A-a'), old('perm-PC-A-b')]
  // The sender **omits it** if it doesn't fit the size limit. Never read "absent" as "all gone"
  assert.deepEqual(staleTags(shown, AT, 'PC-A', undefined), [])
  assert.deepEqual(staleTags(shown, AT, 'PC-A', null), [])
  assert.deepEqual(staleTags(shown, AT, 'PC-A', 'perm-PC-A-b'), [])
  // Also do nothing when the machine is unknown or the time unreadable
  assert.deepEqual(staleTags(shown, AT, undefined, []), [])
  assert.deepEqual(staleTags(shown, Number.NaN, 'PC-A', []), [])
  assert.deepEqual(staleTags(shown, undefined, 'PC-A', []), [])
  // Notifications without a timestamp aren't closed either
  assert.deepEqual(staleTags([{ tag: 'perm-PC-A-a', machine: 'PC-A' }], AT, 'PC-A', []), [])
})

test('★ sw: leaves the notification just shown alone', () => {
  const staleTags = loadStaleTags()
  const shown = [old('perm-PC-A-a')]
  assert.deepEqual(staleTags(shown, AT, 'PC-A', [], 'perm-PC-A-a'), [])
})

test('★★ sw: notifications carry machine (forgetting it silently disables cleanup)', () => {
  assert.match(PUSH, /data: \{ url: data\.url \|\| '\/', machine: data\.machine \}/)
})

test('★ sw: cleans up after showing the notification (rule: a push must always show a notification)', () => {
  // ⚠️ We subscribe with `userVisibleOnly: true`, so **only removing without showing** is not allowed.
  assert.match(
    PUSH,
    /showNotification\([\s\S]*?\}\)\.then\(\(\) => closeResolvedPermissions\(data, pruneAt\)\)/,
  )
})

test('★★ sw: cleanup time is only "the at set by the sender" (no fallback to the device clock)', () => {
  // ⚠️⚠️ codex high #3, 2026-08-20. For a push without `at` (test sends lacked it),
  //    using the device clock lets **an old, late-delivered list** remove notifications for new approvals.
  assert.match(PUSH, /const pruneAt = data\.at \? Date\.parse\(data\.at\) : Number\.NaN/)
  // The display timestamp stays as before (current time if absent)
  assert.match(PUSH, /timestamp: Number\.isNaN\(ts\) \? Date\.now\(\) : ts/)
})

/**
 * ★★ Test the options passed to `showNotification` **extracted from the served sw.js**.
 *
 * ⚠️ A copy wouldn't notice when only one side is fixed, so evaluate the real source.
 */
function loadOptions(): (data: unknown, ts: number, pruneAt: number) => Record<string, unknown> {
  const m = PUSH.match(/self\.registration\.showNotification\(title, \{([\s\S]*?)\n {4}\}\)/)
  assert.ok(m, 'showNotification options not found in sw.js (if the shape changes, fix this test too)')
  return new Function('data', 'ts', 'pruneAt', `return {${m[1]}}`) as (
    data: unknown,
    ts: number,
    pruneAt: number,
  ) => Record<string, unknown>
}

test('★★ sw: only a push with silent set is silent, and renotify is dropped', () => {
  const opts = loadOptions()

  const loud = opts({ title: 't', body: 'b', tag: 'x' }, AT, AT)
  assert.equal(loud['silent'], false, 'must not be silent by default (needs-attention would stop ringing)')
  assert.equal(loud['renotify'], true, 'without ringing on replace, "done → needs attention" goes unnoticed')

  const quiet = opts({ title: 't', body: 'b', tag: 'x', silent: true }, AT, AT)
  assert.equal(quiet['silent'], true)
  // ⚠️ Setting both specifies "ring on replace" and "don't ring" at once, which is implementation-dependent
  assert.equal(quiet['renotify'], false)

  // ★ Non-boolean values must not make it silent (going quiet on a string like "false" would be an accident)
  for (const bad of ['true', 1, {}, [], 'false']) {
    assert.equal(opts({ silent: bad }, AT, AT)['silent'], false, `silent=${JSON.stringify(bad)}`)
  }
})

test('★★ sw: does not pass vibrate (specifying it with silent is a TypeError per spec)', () => {
  // ⚠️ If it throws, **no notification shows at all** (treated as receiving a push and ignoring it)
  assert.equal(loadOptions()({ silent: true }, AT, AT)['vibrate'], undefined)
  assert.ok(!/\bvibrate\s*:/.test(SRC), 'sw.js has vibrate; it cannot be combined with silent')
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ How the shell is answered. **Run from the events** (2026-09-16 / codex round 5, medium #5).
//
//   ⚠️⚠️ At first only `respondShell` was extracted and tested, but then
//      **removing `event.respondWith(…)` left all 15 green** (= if the served SW
//      stopped calling the function we wouldn't notice = the same hole as `relay/src/worker.ts`).
//   ⇒ Capture `self.addEventListener` and **actually fire install / activate / fetch**.
//   ⚠️ The fake caches **distinguish names** (otherwise "saving to the wrong cache" can't be killed).
//
//   Mutations targeted by name:
//     ① remove `event.respondWith(…)` (wiring)
//     ② save to a different cache name
//     ③ drop `if (res.ok)` for `/assets/` (stores failure bodies)
//     ④ don't write the shell to `/index.html`
//     ⑤ ignore content-type on `navigate` (an SVG becomes the shell)
//     ⑥ don't swallow save failures (an old shell shows while online)
//     ⑦ don't carry over `/assets/` on `activate` (can't launch offline right after an update)
//     ⑧ don't delete the old `/` on `activate` (the old shell shows again)
// ─────────────────────────────────────────────────────────────────────────────

const ORIGIN = 'https://pc-a.example'

/**
 * ★★ Fake `Response`. **Mirrors the real semantics** (2026-09-16 / codex round 6, A-3).
 *
 * ⚠️⚠️ The previous version's `clone()` returned **itself**, and `put()` didn't consume the body.
 *    So **the mutation changing `res.clone()` to `res` slipped past 19/19**
 *    (in reality `Cache.put()` consumes the body, so the same response can't then be returned to the browser).
 * ★ The second time this repo made the same mistake (the first was the fake IndexedDB on 2026-09-08).
 *   ⇒ **Don't loosen the assert; make the fake match reality.**
 */
interface FakeRes {
  ok: boolean
  body: string
  used: boolean
  headers: { get: (k: string) => string | null }
  clone: () => FakeRes
  text: () => Promise<string>
}
type FakeReq = { url: string; mode?: string }

function res(body: string, opts: { ok?: boolean; type?: string } = {}): FakeRes {
  const type = opts.type ?? 'text/html; charset=utf-8'
  const make = (): FakeRes => {
    const r: FakeRes = {
      ok: opts.ok ?? true,
      body,
      used: false,
      headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? type : null) },
      // ⚠️ A clone is **a separate container** (doesn't inherit the original's consumed state)
      clone: () => make(),
      text: async () => {
        consume(r, 'text()')
        return body
      },
    }
    return r
  }
  return make()
}

/** ⚠️ A body can be used only once (one of `put` / `text()` / returning to the browser) */
function consume(r: FakeRes, what: string): void {
  if (r.used) throw new TypeError(`body used twice (${what})`)
  r.used = true
}

/** ⚠️ Mirrors the real semantics: contents are separated by name, and `caches.match` looks at **all** of them */
function swHarness(network: (req: FakeReq) => FakeRes | undefined) {
  const caches_ = new Map<string, Map<string, FakeRes>>()
  const called = { skipWaiting: 0, claim: 0 }
  // ⚠️ Keys are kept as **absolute URLs** (dropping the origin hides how other origins are handled)
  const keyOf = (k: string | FakeReq) =>
    new URL(typeof k === 'string' ? k : k.url, ORIGIN).href
  const openCache = (name: string) => {
    let m = caches_.get(name)
    if (!m) caches_.set(name, (m = new Map()))
    return {
      put: async (k: string | FakeReq, v: FakeRes) => {
        // ⚠️⚠️ The real `Cache.put()` **consumes the response body**
        consume(v, 'cache.put')
        m.set(keyOf(k), v)
      },
      // ⚠️ Each retrieval is **a new response** (the real one returns a usable Response every time)
      match: async (k: string | FakeReq) => m.get(keyOf(k))?.clone(),
      delete: async (k: string | FakeReq) => m.delete(keyOf(k)),
      keys: async () => [...m.keys()].map((url) => ({ url })),
      addAll: async (list: string[]) => {
        // ⚠️⚠️ The real one **aborts everything if any is non-2xx** (keeps nothing partial)
        const got: [string, FakeRes][] = []
        for (const k of list) {
          const r = network({ url: keyOf(k), mode: 'navigate' })
          if (!r) throw new TypeError('Failed to fetch')
          if (!r.ok) throw new TypeError('addAll: a non-2xx response')
          got.push([keyOf(k), r])
        }
        for (const [k, r] of got) {
          consume(r, 'addAll')
          m.set(k, r)
        }
      },
    }
  }
  const caches = {
    open: async (name: string) => openCache(name),
    keys: async () => [...caches_.keys()],
    delete: async (name: string) => caches_.delete(name),
    match: async (k: string | FakeReq) => {
      for (const m of caches_.values()) {
        const hit = m.get(keyOf(k))
        if (hit) return hit.clone()
      }
      return undefined
    },
  }
  const listeners = new Map<string, (event: unknown) => void>()
  const self_ = {
    addEventListener: (type: string, fn: (event: unknown) => void) => void listeners.set(type, fn),
    skipWaiting: async () => void called.skipWaiting++,
    clients: { claim: async () => void called.claim++ },
    location: { origin: ORIGIN },
    registration: { showNotification: async () => {} },
  }
  const fetch_ = async (req: FakeReq | string) => {
    const r = network(typeof req === 'string' ? { url: keyOf(req) } : req)
    if (!r) throw new TypeError('Failed to fetch')
    return r
  }
  // ★ Run **the actual contents** of `sw.js` (no copy)
  //   ⚠️ Since 2026-09-21 it calls `importScripts('/push-core.js')`, so pass a fake that
  //      **really loads it** (a no-op would let a mutation removing the load slip past).
  const importScripts_ = (path: string) => {
    const src = readFileSync(join(import.meta.dirname, '..', 'public', path.replace(/^\//, '')), 'utf8')
    new Function('self', 'caches', 'fetch', 'clients', src)(self_, caches, fetch_, self_.clients)
  }
  new Function('self', 'caches', 'fetch', 'clients', 'importScripts', SRC)(
    self_,
    caches,
    fetch_,
    self_.clients,
    importScripts_,
  )

  const run = async (type: 'install' | 'activate') => {
    const waits: Promise<unknown>[] = []
    listeners.get(type)?.({ waitUntil: (p: Promise<unknown>) => waits.push(p) })
    await Promise.all(waits)
  }
  const get = async (req: FakeReq): Promise<FakeRes | undefined> => {
    let answer: Promise<FakeRes> | undefined
    listeners.get('fetch')?.({
      request: { method: 'GET', ...req },
      respondWith: (p: Promise<FakeRes>) => {
        answer = p
      },
    })
    if (answer === undefined) return undefined
    const out = await answer
    // ⚠️⚠️ Returning to the browser also **uses the body** (a consumed response can't be returned)
    consume(out, 'return to browser')
    return out
  }
  const shelf = (name = 'tmux-agent-shell-v2') => caches_.get(name) ?? new Map<string, FakeRes>()
  const has = (path: string, name?: string) => shelf(name).has(`${ORIGIN}${path}`)
  const body = (path: string, name?: string) => shelf(name).get(`${ORIGIN}${path}`)?.body
  return {
    install: () => run('install'),
    activate: () => run('activate'),
    get,
    shelf,
    has,
    body,
    caches_,
    called,
  }
}

const nav = (path: string): FakeReq => ({ url: `${ORIGIN}${path}`, mode: 'navigate' })

test('★★ sw: install → the shell is served on offline launch (① wiring / ④ saving the shell)', { timeout: 5000 }, async () => {
  let online = true
  const h = swHarness((req) => (online ? res(`殻 ${new URL(req.url).pathname}`) : undefined))
  await h.install()
  assert.ok(h.has('/index.html'), 'install did not add the shell')

  online = false
  // ⚠️ A launch URL with a query (the installed PWA's `start_url`)
  const cold = await h.get(nav('/?source=pwa'))
  assert.equal(cold?.body, '殻 /index.html', '⚠️⚠️ no shell on offline launch')
})

test('★★ sw: a fetched shell overwrites `/index.html` (④)', { timeout: 5000 }, async () => {
  let body = '古い殻'
  const h = swHarness(() => res(body))
  await h.install()
  body = '新しい殻'
  assert.equal((await h.get(nav('/')))?.body, '新しい殻')
  assert.equal(h.body('/index.html'), '新しい殻', 'shell not refreshed')
  // ⚠️ `/` is **not stored** (with two keys, an interleaving leaves only one new / medium #1)
  assert.equal(h.has('/'), false, '⚠️ `/` is stored (the medium #1 mismatch comes back)')
})

test('★★ sw: a non-HTML navigate does not become the shell (⑤ / medium #3)', { timeout: 5000 }, async () => {
  const h = swHarness((req) =>
    new URL(req.url).pathname === '/icon.svg'
      ? res('<svg/>', { type: 'image/svg+xml' })
      : res('本物の殻'),
  )
  await h.install()
  // ⚠️ Opening `/icon.svg` directly in the browser is also navigate
  assert.equal((await h.get(nav('/icon.svg')))?.body, '<svg/>')
  assert.equal(h.body('/index.html'), '本物の殻', '⚠️⚠️ the SVG became the shell')
})

test('★★ sw: a failed response does not become the shell (③ / on 503 the shell is served)', { timeout: 5000 }, async () => {
  let broken = false
  const h = swHarness(() =>
    broken ? res('{"error":"設定が壊れています"}', { ok: false, type: 'application/json' }) : res('本物の殻'),
  )
  await h.install()
  broken = true
  const out = await h.get(nav('/'))
  assert.equal(out?.body, '本物の殻', 'showed the 503 body as-is')
  assert.equal(h.body('/index.html'), '本物の殻', '⚠️ overwrote the shell with a failure body')
})

test('★★ sw: `/assets/` is cache-first and failures are not stored (③)', { timeout: 5000 }, async () => {
  let hits = 0
  let ok = true
  const h = swHarness(() => {
    hits++
    return res('JS', { ok, type: 'text/javascript' })
  })
  const js: FakeReq = { url: `${ORIGIN}/assets/index-abc.js` }
  assert.equal((await h.get(js))?.body, 'JS')
  assert.equal(h.body('/assets/index-abc.js'), 'JS')
  await h.get(js)
  assert.equal(hits, 1, 'not cache-first')

  ok = false
  const bad: FakeReq = { url: `${ORIGIN}/assets/index-zzz.js` }
  await h.get(bad)
  assert.equal(h.has('/assets/index-zzz.js'), false, '⚠️ stored a failed response')
})

test('★★ sw: even if saving fails, the fetched response is returned (⑥ / medium #2)', { timeout: 5000 }, async () => {
  // ⚠️⚠️ **Make the shell and the network contents differ** (if equal, the fallback shell
  //    returns the same body, so **this check sees nothing** / mutation ⑥ slipped past)
  let body = '古い殻'
  const h = swHarness(() => res(body))
  await h.install()
  body = '新しい殻'

  // ⚠️ Simulate exceeding quota (`put` throws)
  const shelf = h.caches_.get('tmux-agent-shell-v2')
  const real = shelf!.set.bind(shelf)
  shelf!.set = () => {
    throw new Error('QuotaExceededError')
  }
  const out = await h.get(nav('/'))
  shelf!.set = real
  assert.equal(out?.body, '新しい殻', '⚠️⚠️ fell back to the old shell just because saving failed')
})

test('★★ sw: activate carries over `/assets/` from old caches (⑦ / medium #4)', { timeout: 5000 }, async () => {
  const h = swHarness(() => res('新しい殻'))
  // ★ Build the v1 world (build outputs and a stale shell)
  const v1 = new Map<string, FakeRes>([
    [`${ORIGIN}/assets/index-old.js`, res('古い JS', { type: 'text/javascript' })],
    [`${ORIGIN}/index.html`, res('腐った殻')],
    [`${ORIGIN}/`, res('腐った殻')],
  ])
  h.caches_.set('tmux-agent-shell-v1', v1)
  await h.install()
  await h.activate()

  assert.equal(h.caches_.has('tmux-agent-shell-v1'), false, 'old cache not deleted')
  // ⚠️⚠️ **Build outputs are carried over** (deleting them means no JS when going offline right after an update)
  assert.equal(h.body('/assets/index-old.js'), '古い JS', '⚠️⚠️ dropped `/assets/`')
  // ⚠️ **The shell is not carried over** (carrying it defeats bumping the version)
  assert.equal(h.body('/index.html'), '新しい殻', '⚠️ carried over the stale shell')
})

test('★★ sw: activate deletes the old `/` left in the same cache (⑧)', { timeout: 5000 }, async () => {
  const h = swHarness(() => res('新しい殻'))
  await h.install()
  // ★ Leftover from when two keys were written (inside the same v2)
  h.shelf().set(`${ORIGIN}/`, res('腐った殻'))
  await h.activate()
  assert.equal(h.has('/'), false, '⚠️⚠️ the old `/` remains and the old shell shows again')
  assert.equal((await h.get(nav('/')))?.body, '新しい殻')
})

test('★★ sw: the API does not touch the cache (existing contract)', { timeout: 5000 }, async () => {
  const h = swHarness(() => res('{"ok":true}', { type: 'application/json' }))
  await h.install()
  const out = await h.get({ url: `${ORIGIN}/sessions?live=1` })
  assert.equal(out, undefined, '⚠️ the SW answers the API (shows stale state)')
  assert.equal(h.has('/sessions?live=1'), false)
})

/** ★ A "no network" world with the same cache contents (simulates relaunching) */
function swHarnessOffline(h: ReturnType<typeof swHarness>) {
  const off = swHarness(() => undefined)
  off.caches_.clear()
  for (const [name, m] of h.caches_) off.caches_.set(name, m)
  return off
}

test('★★ sw: the shell is read only from "the current cache" (A-1 / an old shell doesn\'t win even if migration failed)', { timeout: 5000 }, async () => {
  const h = swHarness(() => res('新しい殻'))
  // ★ Create the situation where the old cache (v1) **was left behind**
  h.caches_.set(
    'tmux-agent-shell-v1',
    new Map([[`${ORIGIN}/index.html`, res('腐った殻')]]),
  )
  await h.install()
  // ⚠️ Pretend `migrate` failed midway and couldn't delete v1
  h.caches_.get('tmux-agent-shell-v1')!.set(`${ORIGIN}/`, res('腐った殻'))

  const offline = swHarnessOffline(h)
  const cold = await offline.get(nav('/?source=pwa'))
  assert.equal(cold?.body, '新しい殻', '⚠️⚠️ the old cache\'s shell won (searching all caches)')
})

test('★★ sw: install also fetches the build outputs the shell points to (A-2 / can launch even if going offline right after an update)', { timeout: 5000 }, async () => {
  const html = '<script src="/assets/index-NEW.js"></script>'
  let online = true
  const h = swHarness((req) => {
    if (!online) return undefined
    const path = new URL(req.url).pathname
    return path.startsWith('/assets/')
      ? res('新しい JS', { type: 'text/javascript' })
      : res(html)
  })
  await h.install()
  assert.equal(h.body('/assets/index-NEW.js'), '新しい JS', '⚠️⚠️ build outputs referenced by the shell not fetched')

  online = false
  assert.equal((await h.get({ url: `${ORIGIN}/assets/index-NEW.js` }))?.body, '新しい JS')
})

test('★★ sw: install / activate complete the handover (skipWaiting, claim)', { timeout: 5000 }, async () => {
  const h = swHarness(() => res('殻'))
  await h.install()
  await h.activate()
  assert.equal(h.called.skipWaiting, 1, '⚠️ the new SW would be left waiting')
  assert.equal(h.called.claim, 1, '⚠️ open pages would stay on the old SW')
})

test('★★ sw: install fails if the shell cannot be fetched (= the old SW remains / fail-closed)', { timeout: 5000 }, async () => {
  // ⚠️⚠️ Swallowing this lets "an SW without a shell" take over successfully,
  //    and **nothing can be shown offline**. Failing keeps the old SW working.
  const h = swHarness(() => res('落ちています', { ok: false, type: 'text/plain' }))
  await assert.rejects(() => h.install(), '⚠️ install succeeded without a shell')
  assert.equal(h.called.skipWaiting, 0, '⚠️ tried to take over despite failing')
})

test('★★ sw: install succeeds even if one notification image fails (separate from the shell / codex round 21, medium #2)', { timeout: 5000 }, async () => {
  // ⚠️⚠️ Mixed into the shell, `addAll` aborts entirely ⇒ one bad image blocks switching to a new version
  const h = swHarness((req) => (new URL(req.url).pathname === '/icons/notify-256.png' ? undefined : res(`殻 ${new URL(req.url).pathname}`)))
  await h.install()
  assert.equal(h.called.skipWaiting, 1, '⚠️⚠️ cannot take over just because one image failed')
  assert.ok(h.has('/index.html'))
  assert.ok(h.has('/icons/badge-96.png'), '⚠️ fetched images are kept locally')
  assert.equal(h.has('/icons/notify-256.png'), false)
})

test('★★ sw: notification images are refetched on every update; the old image is kept if the fetch fails (codex round 22, low #2)', { timeout: 5000 }, async () => {
  // ⚠️ "Skip if present" for fixed-name images means old images linger even after replacing them
  let fresh = true
  const h = swHarness((req) => {
    const p = new URL(req.url).pathname
    if (p === '/icons/notify-256.png') return fresh ? res('新しい絵', { type: 'image/png' }) : undefined
    return res(`殻 ${p}`)
  })
  h.caches_.set('tmux-agent-shell-v2', new Map([[`${ORIGIN}/icons/notify-256.png`, res('旧い絵', { type: 'image/png' })]]))
  await h.install()
  assert.equal(h.body('/icons/notify-256.png', 'tmux-agent-shell-v2'), '新しい絵', '⚠️⚠️ replaced image not refetched')
  // ★ When the fetch fails, keep the local image (don't delete it)
  fresh = false
  h.caches_.get('tmux-agent-shell-v2')!.set(`${ORIGIN}/icons/notify-256.png`, res('手元の絵', { type: 'image/png' }))
  await h.install()
  assert.equal(h.body('/icons/notify-256.png', 'tmux-agent-shell-v2'), '手元の絵')
})
