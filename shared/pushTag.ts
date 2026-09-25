// ★★ The "tag" of a push endpoint (2026-09-23 / codex round 13, high #3).
//
// ⚠️⚠️ Why it is needed: `subscribed` in `/push/status` meant "is **any one of this device's subscriptions** present",
//   so **even if registering the new endpoint failed, it looked "registered" as long as an old endpoint remained**
//   ⇒ nothing was re-sent, and the agent **kept sending to the dead old one** (notifications silently stop).
//   ⇒ The agent returns "the tags of the endpoints it holds for this device", and the PWA checks **whether its own tag is among them**.
//
// ⚠️ Never return the endpoint itself — a push endpoint is a **capability URL** (knowing it is enough to send notifications).
//    ⇒ The first 128 bits of SHA-256 (22 base64url chars). Long enough that collisions do not happen in practice.
// ⚠️ **The agent and the PWA use this one file** (two copies always drift / same reason as `shared/crypto.ts`).
// ⚠️ Do not write DOM type names (the agent type-checks this too). WebCrypto exists in Node 24 as well.

export async function endpointTag(endpoint: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint))
  const bytes = new Uint8Array(digest).subarray(0, 16)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
