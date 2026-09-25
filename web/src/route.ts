// Screen destinations (hash routing) and **unifying the back action**.
//
// ★★ Why this file exists (2026-08-16):
//
//   "← List" and browser back (the phone's back gesture) **went to different places**.
//   The three actual mismatches:
//
//   1. When tapping a notification **launches the app fresh**, history has only one entry, `#/s/xxx`.
//      → Browser back **closes the whole app** (can't reach the list). Launching from a notification
//        is this tool's main path, so this matters most
//   2. Tapping another notification with the app open moves via `client.navigate()` from
//      `#/s/A` → `#/s/B` (`web/public/sw.js`).
//      → Browser back returns to **the previous thread A** (not the list)
//   3. "← List" **pushed a history entry** with `location.hash = ''`.
//      → Browser back right after returning to the list **re-entered the thread**
//
//   The fix isn't "hijacking back" but **shaping the history**:
//
//     ★ Always lay **the list one entry below** a thread (and the endpoints screen)
//     ★ "← List" goes down with `history.back()` without pushing
//
//   This makes both the same single action. ⚠️ `pushState` / `replaceState` don't fire
//   `hashchange`, so **as long as the URL is restored, the screen state doesn't move**.

export type RouteKind = 'list' | 'session' | 'endpoints'
export type Route = { kind: 'list' } | { kind: 'session'; id: string } | { kind: 'endpoints' }

/** `#/s/<sessionId>` is a thread (notification taps land here too), `#/agents` is endpoint management */
export function parseRoute(hash: string): Route {
  if (hash.startsWith('#/agents')) return { kind: 'endpoints' }
  const m = /^#\/s\/([^/?]+)/.exec(hash)
  return m ? { kind: 'session', id: decodeURIComponent(m[1]!) } : { kind: 'list' }
}

/** Marker attached to history entries. If present, we know "there's a list below" */
const MARK = 'tmux-agent:deep'

/**
 * Whether the list must be laid again one entry below the current one.
 *
 * ⚠️ `prev === undefined` is **the first render** (= opened directly from a notification or bookmark).
 *    There's nothing below then, so always lay it.
 */
export function needsListBelow(prev: RouteKind | undefined, next: RouteKind): boolean {
  if (next === 'list') return false
  // Only when entered from the list is there already a list below
  return prev !== 'list'
}

/** Whether the entry is guaranteed to "have a list below" (pass `history.state`) */
export function canPopToList(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as { m?: unknown }).m === MARK
}

/**
 * Shape the history to match the displayed route. **Safe to call on every render** (idempotent).
 *
 * ⚠️ The URL is always restored at the end. Otherwise it disagrees with `useRoute`'s state.
 */
export function syncHistory(prev: RouteKind | undefined, next: RouteKind): void {
  if (next === 'list') return
  // ★★ If the entry is already shaped, **do nothing**.
  //    ⚠️ Deciding by `prev` alone **adds one history entry per reload**
  //       (on reload `prev` is back to undefined, but `history.state` survives).
  //       Found in the external review on 2026-08-16. The same happens when the OS
  //       recreates a standalone PWA
  if (canPopToList(history.state)) return
  const target = location.hash || '#'
  if (needsListBelow(prev, next)) {
    // Rewrite the current entry to the list and push on top of it (= lay a list below)
    history.replaceState(null, '', '#')
    history.pushState({ m: MARK }, '', target)
    return
  }
  // The list is already below. Just attach the marker (no push)
  history.replaceState({ m: MARK }, '', target)
}

/**
 * Destination of a thread.
 *
 * ⚠️ **Built only here**. Writing it separately for the list's `<a href>` and the banner's second line (moving to another thread)
 *    drifts by one of them forgetting `encodeURIComponent`.
 */
export function sessionHash(sessionId: string): string {
  return `#/s/${encodeURIComponent(sessionId)}`
}

/** Move to a thread (history shaping is done by `syncHistory` on every render) */
export function goSession(sessionId: string): void {
  location.hash = sessionHash(sessionId)
}

/**
 * "← List". To **behave the same as browser back**, go down with `back()` whenever possible.
 *
 * ⚠️ Rewrite the hash only when there's no marker (`syncHistory` hasn't run yet, etc.).
 *    It adds one history entry, but **that's safer than leaving the app**.
 */
export function goList(): void {
  if (canPopToList(history.state)) {
    history.back()
    return
  }
  location.hash = ''
}

/**
 * Go down to the list and then reload (for the endpoints screen's "save and reload").
 *
 * ⚠️ Reloading after `location.hash = ''` **pushes a history entry**, so
 *    going back there re-enters the endpoints screen (= breaks the invariant / external review on 2026-08-16).
 * ⚠️ `history.back()` is async. Reload after waiting for `popstate`.
 *    **Always reload even if the wait never ends** (leaving saved endpoints unapplied is worse).
 * ⚠️⚠️ **Reload only once**. `{ once: true }` removes the listener but **the timer remains**, so
 *    if loading exceeds 400ms **a second reload runs and discards in-flight requests**
 *    (more likely on slow connections / pointed out in the external review on 2026-08-16).
 */
export function reloadAtList(): void {
  if (!canPopToList(history.state)) {
    location.hash = ''
    location.reload()
    return
  }
  let reloaded = false
  const done = () => {
    if (reloaded) return
    reloaded = true
    location.reload()
  }
  window.addEventListener('popstate', done, { once: true })
  setTimeout(done, 400)
  history.back()
}
