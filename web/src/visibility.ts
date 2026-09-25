// ★★ Stop polling while the screen is in the background (2026-09-23 / we approached relay's daily limit).
//
// ⚠️⚠️ Measured (Cloudflare Analytics): a single tab with the PWA left open kept the "list every 15s"
//    and "thread every 3s" queries flowing into the relay room **nonstop for 24 hours**
//    (on 9/22 176k messages to the DO ⇒ warning at 91% of the Workers daily limit / HANDOFF 5.0-ce).
//    Polling only matters **while someone is looking** ⇒ stop it in the background.
// ★ On returning to the foreground, **fetch once immediately, then resume** (don't show a stale screen for up to 15s).
// ⚠️ Don't stop state notifications (`/events` subscription) or Push (they only flow on change = small volume).
// ⚠️ Without `document` (tests, SSR) **keep running as before** (don't stop without a reason to).

export interface VisibilityLike {
  readonly visibilityState?: string
  addEventListener(type: 'visibilitychange', fn: () => void): void
  removeEventListener(type: 'visibilitychange', fn: () => void): void
}

export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realTimers: Timers = {
  set: (fn, ms) => setInterval(fn, ms),
  clear: (h) => clearInterval(h as ReturnType<typeof setInterval>),
}

/**
 * ★ Call `fn` every `ms`, but **not while the screen is in the background**.
 * ⚠️ Does not make the first call (the caller fetches first itself = same meaning as the old `setInterval`).
 * ★ `onResume` is called on returning to the foreground (default `fn`). The list uses not the "check schedule" `fn`
 *   but **a full refetch** (so endpoints with repeated failures don't stay 5 minutes stale after returning / 2026-09-24).
 * @returns stop (⚠️ always removes the listener = call it in the effect cleanup)
 */
export function whileVisible(
  fn: () => void,
  ms: number,
  doc: VisibilityLike | undefined,
  timers: Timers = realTimers,
  onResume: () => void = fn,
): () => void {
  let handle: unknown
  const start = () => {
    if (handle === undefined) handle = timers.set(fn, ms)
  }
  const pause = () => {
    if (handle !== undefined) timers.clear(handle)
    handle = undefined
  }
  if (!doc) {
    start()
    return pause
  }
  const onChange = () => {
    if (doc.visibilityState === 'hidden') {
      pause()
      return
    }
    // ★ Back in the foreground: fetch once right away, then resume (⚠️ no-op if already running = no double calls)
    if (handle === undefined) {
      onResume()
      start()
    }
  }
  if (doc.visibilityState !== 'hidden') start()
  doc.addEventListener('visibilitychange', onChange)
  return () => {
    doc.removeEventListener('visibilitychange', onChange)
    pause()
  }
}

/**
 * ★★ Hold a subscription **only while the screen is in the foreground** (2026-09-23 / thread following).
 * ⚠️ Unsubscribe in the background and resubscribe in the foreground (resubscribing sends `hello` ⇒ the caller refetches the rest).
 * ⚠️ Without `document`, subscribe once (as before).
 * @returns stop (⚠️ unsubscribes if subscribed)
 */
export function subscribeWhileVisible(start: () => () => void, doc: VisibilityLike | undefined): () => void {
  let stopSub: (() => void) | undefined
  const up = () => {
    if (stopSub === undefined) stopSub = start()
  }
  const down = () => {
    stopSub?.()
    stopSub = undefined
  }
  if (!doc) {
    up()
    return down
  }
  const onChange = () => (doc.visibilityState === 'hidden' ? down() : up())
  if (doc.visibilityState !== 'hidden') up()
  doc.addEventListener('visibilitychange', onChange)
  return () => {
    doc.removeEventListener('visibilitychange', onChange)
    down()
  }
}
