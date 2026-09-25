// ★★ **The notification receiver is shared by the shell SW and the push-only SW** (2026-09-21).
//
// ⚠️⚠️ Since subscriptions are now split into per-agent scopes, **several SWs get registered**
//   (`/push/<id>/` = `push-sw.js`). ⇒ Writing push handling in two places **always drifts**
//   (and if only one breaks, "only that machine's notifications don't show" — extremely hard to isolate).
//   ⇒ **Both load this single file via `importScripts`.**
//
// ⚠️ This was **moved as-is** from `sw.js` (behavior unchanged / 2026-09-21).

/* ---- Push（M1） ----
 * The payload arrives encrypted per RFC 8291, so the delivery network (Google for Chrome) can't read it.
 * Even so, the body carries only identifiers and state by policy (ARCHITECTURE.md §6.2).
 */
self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    // ★ Only for the unreadable case does the SW pick the language (⚠️ the SW can't read the screen's manual language setting ⇒ device language)
    const ja = String((self.navigator && self.navigator.language) || '').toLowerCase().startsWith('ja')
    data = { title: 'nyan-remote', body: ja ? '通知' : 'Notification' }
  }
  const title = data.title || 'nyan-remote'
  // ⚠️ Don't put the time in the body. Pass timestamp and let the OS show it in the device time zone
  //    (we hit the bug where slicing ISO on the server showed UTC)
  const ts = data.at ? Date.parse(data.at) : Date.now()
  // ★★ Cleanup ordering uses **only the time set by the sender** (codex high #3, 2026-08-20).
  //    ⚠️ Falling back to the device clock when `at` is missing, **an old list delivered late** would
  //    misjudge "approvals raised afterwards" as old and **remove live notifications**.
  //    ⇒ If unknown, don't clean up (keep this separate from the display `ts`).
  const pruneAt = data.at ? Date.parse(data.at) : Number.NaN
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag || 'tmux-agent',
      // ★ Image on the right of the notification (Android crops it round / 256px).
      //   ⚠️⚠️ **Without it, Chrome inserts the origin's initial "A"** (confirmed on both Pixel and moto on 2026-09-24).
      //      Web notifications have no option to "hide the right side" (native apps build their own layout, so they can omit it)
      //      ⇒ Show the app's image rather than a meaningless "A" (user decision)
      icon: '/icons/notify-256.png',
      // ★ Status bar mark (⚠️ only a white shape on a transparent background = color is ignored). If unreadable, Chrome shows the default 🔔
      badge: '/icons/badge-96.png',
      timestamp: Number.isNaN(ts) ? Date.now() : ts,
      // ★★ Whether to suppress sound and vibration (2026-08-21). With a design that mirrors state in the notification tray,
      //    we must "ring only for states that need attention".
      //    ⚠️ Don't pass `vibrate` (specifying it together with `silent` is a TypeError per spec).
      silent: data.silent === true,
      // Make replacing a notification with the same tag still noticeable via sound/vibration.
      // ⚠️ Drop it when `silent`. Setting both means specifying "ring on replace" and "don't ring"
      //    at once, and **which one wins is implementation-dependent**.
      renotify: data.silent !== true,
      // ★★ Store `machine` on the notification itself (`/code-review` medium #2, 2026-08-20).
      //    ⚠️ **Never determine the owner by prefix-matching the tag** (`perm-<machine>-<key>`).
      //    Both host name and key may contain `-`, so a push from `pc-b` would
      //    prefix-match `pc-b-wsl` notifications too and **close another machine's live notifications**.
      data: { url: data.url || '/', machine: data.machine },
    }).then(() => closeResolvedPermissions(data, pruneAt)),
  )
})

/**
 * ★★ Close notifications for "approvals no longer pending" **piggybacking on this notification** (2026-08-20).
 *
 * Why here:
 *   Approval notifications are one slot each and can't be collapsed (collapsing removes the way to answer the second).
 *   Cleanup after answering on the PC **only runs while the app is open**, so while it's closed
 *   "awaiting approval" lingers. ⚠️ Because we subscribe with `userVisibleOnly: true`,
 *   **receiving a push without showing a notification is not allowed** (the browser shows a generic one).
 *   ⇒ **Ride along with the notification we show.** No extra Push needed, and it doesn't ring more often.
 *
 * ⚠️⚠️ Touch **only the sending machine's** notifications. Only that machine's agent has the list, so
 *    never judge other machines' approvals as "absent" (that would remove ones from disconnected machines).
 * ⚠️⚠️ **Do nothing if there is no list** (fail-open forbidden). The sender **omits it** when it doesn't fit
 *    the size limit, so "absent" does not mean "all gone".
 */
/**
 * @param shown notifications currently shown (reduced to `{ tag, machine, timestamp }`)
 * @param pushAt this push's `at` (epoch ms). **The list is a snapshot at this time**
 * @param ownTag tag of the notification just shown (left alone)
 */
function staleTags(shown, pushAt, machine, pending, ownTag) {
  if (!machine || !Array.isArray(pending)) return []
  if (typeof pushAt !== 'number' || Number.isNaN(pushAt)) return []
  const keep = new Set(pending.filter((t) => typeof t === 'string'))
  const out = []
  for (const n of shown) {
    if (!n || typeof n.tag !== 'string' || n.tag.indexOf('perm-') !== 0) continue
    // ★★ Determine the owner by **the machine stored on the notification** (not by tag prefix match)
    if (n.machine !== machine) continue
    if (n.tag === ownTag) continue
    // ⚠️⚠️ **Don't close notifications newer than the list** (`/code-review` high #1, 2026-08-20).
    //    Push ordering isn't guaranteed, so **an old snapshot may arrive later**.
    //    If "approvals that came afterwards" were then judged "no longer pending",
    //    **the only signal for an approval still awaiting an answer would vanish** (the CLI keeps waiting 86400 seconds).
    //    ⇒ Also don't close when the time is unreadable (fail-open forbidden).
    if (typeof n.timestamp !== 'number' || Number.isNaN(n.timestamp)) continue
    if (n.timestamp >= pushAt) continue
    if (keep.has(n.tag)) continue
    out.push(n.tag)
  }
  return out
}

function closeResolvedPermissions(data, pushAt) {
  if (!self.registration.getNotifications) return Promise.resolve()
  return self.registration
    .getNotifications()
    .then((list) => {
      const stale = new Set(
        staleTags(
          list.map((n) => ({
            tag: n.tag,
            machine: n.data && n.data.machine,
            timestamp: n.timestamp,
          })),
          pushAt,
          data && data.machine,
          data && data.pendingPerms,
          data && data.tag,
        ),
      )
      for (const n of list) if (stale.has(n.tag)) n.close()
    })
    .catch(() => {
      // Not fatal if it can't be closed (opening the app cleans up)
    })
}

/**
 * ★★ Always open "a page of this app" from a notification.
 *
 * ⚠️ Resolving a relative URL inside a Service Worker uses **`/sw.js` itself** as the base,
 *    not the open page. Passing `#/s/abc` yields `/sw.js#/s/abc`, and
 *    **tapping shows the sw.js source in tiny text** (happened on a real device on 2026-08-13).
 *
 * ⚠️ The sender (agent) always starts it with `/` via threadUrl in `pushUrl.ts`, but
 *    we also resolve against the scope here as a second defense. **Never open an external origin.**
 */
function resolveTarget(raw) {
  const scope = self.registration.scope
  try {
    const u = new URL(raw || '/', scope)
    // Don't open another origin (don't trust notification contents)
    if (u.origin !== new URL(scope).origin) return scope
    // Don't open sw.js itself or assets (= prevents the accident of showing source code)
    if (/\.(js|css|json|webmanifest|map)$/.test(u.pathname)) return `${scope}${u.hash}`
    return u.href
  } catch {
    return scope
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = resolveTarget(event.notification.data && event.notification.data.url)
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          if ('navigate' in client) client.navigate(url).catch(() => {})
          return client.focus()
        }
      }
      return self.clients.openWindow(url)
    }),
  )
})
