// ★★ **SW that receives notifications for one agent only** (2026-09-21 / registered at `/push/<id>/`).
//
// ★ Why separate: a subscription is **one per Service Worker registration (scope)** and is bound to
//   **one VAPID key** (confirmed on real Android and iOS devices on 2026-09-21 / HANDOFF 5.0-bt).
//   ⇒ With one scope per agent, **each agent can subscribe with its own key**
//      = **no more copying `vapid.json` between machines**.
//
// ⚠️⚠️ **Holds no cache.** Only `sw.js` holds the shell (`/index.html` etc.).
//   If this held the shell, every added registration would add a shell version and **break the cleanup check**.
// ⚠️ The receiver is the single `push-core.js` (shared with `sw.js`; writing it in two places always drifts).

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
importScripts('/push-core.js')
