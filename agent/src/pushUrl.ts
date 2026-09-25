// Builds the URL a notification opens. **Never hand-write it without going through here.**
//
// ⚠️⚠️ **It must start with `/`.** Never use a bare fragment (`#/s/...`).
//
//   Inside a Service Worker, a relative URL resolves against
//   **the Service Worker's own URL (`/sw.js`)**, not the open page.
//   So `#/s/abc` resolves to `/sw.js#/s/abc`, and
//   **tapping the notification showed the source code of `sw.js`** (happened on a real device, 2026-08-13).
//
//   `hooks.ts` used `/#/s/...` from the start so nobody noticed; when M4-1 added approval notifications
//   only one side was written as `#/s/...`. **It is a function so the same mistake cannot happen twice.**

/** URL that opens the session's thread. Opens the list if there is no sessionId */
export function threadUrl(sessionId: string | undefined): string {
  if (!sessionId) return '/'
  return `/#/s/${encodeURIComponent(sessionId)}`
}
