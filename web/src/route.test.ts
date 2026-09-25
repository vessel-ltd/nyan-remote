import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  canPopToList,
  goList,
  needsListBelow,
  parseRoute,
  reloadAtList,
  syncHistory,
} from './route.ts'

// ★★ What this test protects (2026-08-16):
//
//   Make "← List" and browser back **the same single action**.
//   To that end it maintains "there's always a list one entry below a thread".
//   If this breaks, browser back after launching from a notification **closes the app**.
//
// ⚠️⚠️ **Tests that only looked at the decision function were a "false green"** (external review on 2026-08-16).
//    Even with `needsListBelow` correct, `syncHistory` stayed green when
//      - replaceState and pushState were written in reverse order
//      - the pushed destination was still the list
//      - it pushed twice every time
//    ⇒ **Look at what the history stack actually becomes** (pattern 3 of the mistakes in VERIFY.md).
//    For that, minimal stand-ins for `history` / `location` are built and injected here.

/** Stand-in for the history stack. A minimal implementation copying only the browser's semantics */
class FakeHistory {
  entries: { url: string; state: unknown }[]
  index = 0

  constructor(initialUrl: string) {
    this.entries = [{ url: initialUrl, state: null }]
  }

  get state(): unknown {
    return this.entries[this.index]!.state
  }

  /** The hash part of the current URL (the browser returns an empty string when it's just `#`) */
  get hash(): string {
    const url = this.entries[this.index]!.url
    return url === '#' || url === '' ? '' : url
  }

  replaceState(state: unknown, _title: string, url: string): void {
    this.entries[this.index] = { url, state }
  }

  pushState(state: unknown, _title: string, url: string): void {
    // Forward history is discarded (same as the browser)
    this.entries = this.entries.slice(0, this.index + 1)
    this.entries.push({ url, state })
    this.index += 1
  }

  back(): void {
    // ⚠️ The real one is async, but here only the destination matters, so it's synchronous
    if (this.index === 0) throw new Error('went outside the history (= the app closes)')
    this.index -= 1
  }

  /** Equivalent to `location.hash = x`. Nothing happens if the same, otherwise pushes one */
  setHash(next: string): void {
    const url = next === '' ? '#' : next
    if (this.entries[this.index]!.url === url) return
    this.pushState(null, '', url)
  }

  /** A notification tap (sw.js's client.navigate). A new entry with no state */
  navigate(url: string): void {
    this.pushState(null, '', url)
  }

  /** Reload. ★ `history.state` stays on the entry (isn't lost) */
  get urls(): string[] {
    return this.entries.map((e) => e.url)
  }
}

/** Side effects the test can touch (reloads and listeners) */
interface Env {
  h: FakeHistory
  /** Number of times `location.reload()` was called */
  reloads: number
  /** Registered `popstate` listeners (fired manually to reproduce async behavior) */
  popstate: (() => void)[]
  /** Scheduled timers (advanced by hand instead of waiting on real ones) */
  timers: (() => void)[]
}

/** `route.ts` looks at the global `history` / `location` / `window`, so inject there */
function withHistory<T>(initialUrl: string, fn: (env: Env) => T): T {
  const env: Env = { h: new FakeHistory(initialUrl), reloads: 0, popstate: [], timers: [] }
  const g = globalThis as Record<string, unknown>
  const saved = { history: g.history, location: g.location, window: g.window, setTimeout: g.setTimeout }
  g.history = env.h
  g.location = {
    get hash() {
      return env.h.hash
    },
    set hash(v: string) {
      env.h.setHash(v)
    },
    reload() {
      env.reloads += 1
    },
  }
  g.window = {
    addEventListener(type: string, fn: () => void) {
      if (type === 'popstate') env.popstate.push(fn)
    },
    removeEventListener() {},
  }
  g.setTimeout = (fn: () => void) => {
    env.timers.push(fn)
    return 0
  }
  try {
    return fn(env)
  } finally {
    Object.assign(g, saved)
  }
}

test('parseRoute: thread / endpoints / list', () => {
  assert.deepEqual(parseRoute('#/s/abc-123'), { kind: 'session', id: 'abc-123' })
  assert.deepEqual(parseRoute('#/agents'), { kind: 'endpoints' })
  assert.deepEqual(parseRoute(''), { kind: 'list' })
  assert.deepEqual(parseRoute('#'), { kind: 'list' })
  assert.deepEqual(parseRoute('#/nope'), { kind: 'list' })
})

test('parseRoute: sessionId is URL-decoded', () => {
  assert.deepEqual(parseRoute('#/s/a%40b'), { kind: 'session', id: 'a@b' })
})

test('needsListBelow: not laid only when entered from the list', () => {
  assert.equal(needsListBelow(undefined, 'session'), true, 'opened directly from a notification')
  assert.equal(needsListBelow('session', 'session'), true, 'moved to another thread via a notification')
  assert.equal(needsListBelow('list', 'session'), false)
  assert.equal(needsListBelow('list', 'endpoints'), false)
  assert.equal(needsListBelow(undefined, 'list'), false)
  assert.equal(needsListBelow('session', 'list'), false)
})

test('★ opening directly from a notification lays a list below and restores the URL', () => {
  withHistory('#/s/A', ({ h }) => {
    syncHistory(undefined, 'session')
    assert.deepEqual(h.urls, ['#', '#/s/A'], 'the thread sits on top of the list')
    assert.equal(h.index, 1)
    assert.equal(h.hash, '#/s/A', '★ the URL stays the same (doesn\'t disagree with screen state)')
    assert.equal(canPopToList(h.state), true)
  })
})

test('★★ calling it repeatedly on the same screen doesn\'t grow history (reload / remount)', () => {
  // ⚠️ A bug found in the external review on 2026-08-16.
  //    Reloading with a thread open returns `prev` to undefined, so
  //    re-laying ran every time and it **grew endlessly** like `['#','#','#/s/A']` ….
  withHistory('#/s/A', ({ h }) => {
    syncHistory(undefined, 'session')
    const after1 = [...h.urls]
    syncHistory(undefined, 'session')
    syncHistory(undefined, 'session')
    assert.deepEqual(h.urls, after1, 'does nothing from the second call on')
    assert.equal(h.index, 1)
  })
})

test('★ entering from the list doesn\'t push (the list is already below)', () => {
  withHistory('#', ({ h }) => {
    h.setHash('#/s/A') // tap a list row (<a href>)
    assert.deepEqual(h.urls, ['#', '#/s/A'])
    syncHistory('list', 'session')
    assert.deepEqual(h.urls, ['#', '#/s/A'], 'does not grow')
    assert.equal(canPopToList(h.state), true, 'only the marker is attached')
  })
})

test('★ thread A → thread B via notification. Back goes to the list (not the previous thread)', () => {
  withHistory('#', ({ h }) => {
    h.setHash('#/s/A')
    syncHistory('list', 'session')
    h.navigate('#/s/B') // sw.js's client.navigate
    syncHistory('session', 'session')
    assert.deepEqual(h.urls, ['#', '#/s/A', '#', '#/s/B'])
    goList()
    assert.equal(h.hash, '', '★ went down to the list')
  })
})

test('★ goList goes down without pushing (back right after the list doesn\'t re-enter the thread)', () => {
  withHistory('#/s/A', ({ h }) => {
    syncHistory(undefined, 'session')
    goList()
    assert.equal(h.index, 0)
    assert.equal(h.hash, '')
    assert.deepEqual(h.urls, ['#', '#/s/A'], 'did not push (forward can return to the thread)')
  })
})

test('★★ without the marker, back() isn\'t called (never leaves the app)', () => {
  // With only one history entry, back() closes the whole PWA.
  withHistory('#/s/A', ({ h }) => {
    assert.equal(canPopToList(h.state), false, 'precondition: not shaped yet')
    goList() // ★ a throw here means "went outside"
    assert.equal(h.hash, '', 'it does become the list')
    assert.deepEqual(h.urls, ['#/s/A', '#'], 'pushes one instead (safe side)')
  })
})

test('does nothing on the list', () => {
  withHistory('#', ({ h }) => {
    syncHistory('session', 'list')
    assert.deepEqual(h.urls, ['#'])
  })
})

test('the endpoints screen is treated the same (lays a list below)', () => {
  withHistory('#/agents', ({ h }) => {
    syncHistory(undefined, 'endpoints')
    assert.deepEqual(h.urls, ['#', '#/agents'])
    goList()
    assert.equal(h.hash, '')
  })
})

test('★ reloadAtList: goes down to the list and then reloads (without pushing)', () => {
  withHistory('#', (env) => {
    env.h.setHash('#/agents')
    syncHistory('list', 'endpoints')
    reloadAtList()
    assert.equal(env.h.hash, '', 'went down to the list')
    assert.deepEqual(env.h.urls, ['#', '#/agents'], '★ did not push (going back doesn\'t re-enter the endpoints screen)')
    assert.equal(env.reloads, 0, 'waiting for popstate (doesn\'t reload before going down)')
    env.popstate[0]!()
    assert.equal(env.reloads, 1, 'reloads after going down')
  })
})

test('★★ reloadAtList: always reloads even if popstate never comes (the save isn\'t left hanging)', () => {
  withHistory('#', (env) => {
    env.h.setHash('#/agents')
    syncHistory('list', 'endpoints')
    reloadAtList()
    assert.equal(env.timers.length, 1, 'a fallback timer is set')
    env.timers[0]!() // popstate never came
    assert.equal(env.reloads, 1)
  })
})

test('★★ reloadAtList: reloads only once (no double run on slow connections)', () => {
  // ⚠️ Pointed out in the external review on 2026-08-16. `{ once: true }` removes the listener but
  //    **the timer remains**. If loading exceeds 400ms a second reload runs,
  //    discarding in-flight requests and starting over (more likely on slow connections).
  withHistory('#', (env) => {
    env.h.setHash('#/agents')
    syncHistory('list', 'endpoints')
    reloadAtList()
    env.popstate[0]!() // went down → reload starts
    assert.equal(env.reloads, 1)
    env.timers[0]!() // ★ loading dragged on and the fallback timer fired
    assert.equal(env.reloads, 1, 'the second does not run')
  })
})

test('reloadAtList: without the marker, as before (never leaves the app)', () => {
  withHistory('#/agents', (env) => {
    reloadAtList()
    assert.equal(env.h.hash, '')
    assert.deepEqual(env.h.urls, ['#/agents', '#'])
    assert.equal(env.reloads, 1)
  })
})

test('canPopToList: doesn\'t react to other code\'s state', () => {
  assert.equal(canPopToList(null), false)
  assert.equal(canPopToList(undefined), false)
  assert.equal(canPopToList({}), false)
  assert.equal(canPopToList({ m: 'よそのライブラリ' }), false)
  assert.equal(canPopToList('tmux-agent:deep'), false, 'the string itself is not the shape of history.state')
})
