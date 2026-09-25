// ★★ **There are two official entry points** (distribution origin = Y / relay = the wire in ③).
//
// ⚠️⚠️ **The agent and the PWA read this one file** (with two copies, fixing only one leads to
//    "shipped it but it does not connect". Same reason the E2E crypto lives in one file).
//
// ★★ **relay became the default on 2026-09-18** (user decision).
//   ⚠️ Before that, only people who hand-wrote `relayUrl` in `config.json` could use relay.
//      ⇒ **There was a category of "people without relay configured"**, and they
//        could not use step 7 of ③ (pairing via relay) = they were still tailnet-dependent.
//   ★ This just **aligned the implementation** with the policy (decided 2026-09-16: "the default route is relay").
//   ⚠️ Self-hosters (OSS) **can override** with `relayUrl` in `config.json`.
//      ★ **To turn it off, `"relayUrl": ""`** (wrong shape so it is not used; the reason shows in `relay` of `/health`).
//   ⬜ Whether to "connect to our relay by default" when shipping as OSS is **a separate discussion**
//      (decided to prioritise paying app users / 2026-09-18 user decision).

/**
 * ★ Distribution origin of the PWA (Y). ⚠️ Compared by exact match (no trailing slash, no path).
 *
 * ⚠️⚠️ **There is no automatic CORS allowance any more** (removed 2026-09-18 / codex round 7, high #2).
 *   ★ Why it could be removed: pairing moved onto relay (§14.1.4), so
 *     **the PWA on the public origin no longer talks HTTP to the agent**.
 *   ⚠️ The earlier reasoning ("it is the very app we ship, so no new trust is added") was wrong on two counts:
 *     1. `isAllowedOrigin()` also passes `rejectCrossOrigin()` = **writes got through too**
 *        (`tailscale serve` adds identity headers, so **it could operate without device registration**)
 *     2. It was attached unconditionally even to agents of **people who never open that origin**
 *        = for them it was **new trust, plain and simple**
 *   ⇒ General rule: **"we already trust the same thing" only holds when the blast radius is the same.**
 *   ⚠️ Self-hosters use `allowedOrigins` in `config.json` (that one is kept).
 *
 * ★★ **Moved to a custom domain on 2026-09-21** (`app.nyan-remote.app` / user decision).
 *   ⚠️⚠️ **The `app.` subdomain, not the apex (`nyan-remote.app`)**. Same reason we did not pick
 *      `<user>.github.io` (CLAUDE.md §1): on the apex, adding a single landing page
 *      would be enough to **read the device's private key in IndexedDB from the same origin**.
 *      ⇒ The apex is landing and billing, `app.` is only the PWA, `relay.` is WSS. **Do not mix.**
 *   ⚠️⚠️ **The origin changed, so every device installed before this needs re-pairing + notification setup again**
 *      (endpoints, the device private key and Web Push subscriptions are **per origin**). The agent is
 *      **left with dead registrations**, so clean up with `npm run devices -- --revoke …`.
 *   ★ So **this value does not move again** (moving it again pays the same price once more).
 *   ⚠️ The old `nyan-remote.nyan-remote-relay.workers.dev` was **stopped with `workers_dev: false`**
 *      (keeping it alive would give the PWA two origins / `site/wrangler.jsonc`).
 */
export const DISTRIBUTION_ORIGIN = 'https://app.nyan-remote.app'

/**
 * ★★ **Default relay entry point** (step 6 of ③ / `DEFAULTS` in `agent/src/config.ts`).
 *
 * ⚠️⚠️ **With this as the default, "an agent without relay configured" no longer exists.**
 *   ⇒ The QR always carries `r` = **every agent can pair via relay** (§14.1.4).
 * ⚠️ Override with `relayUrl` in `config.json`. ⚠️ The shape is judged by `isRelayBase` in `shared/relayFrame.ts`
 *    (`ws:` / `wss:` only, no query or fragment).
 * ⚠️⚠️ **`wss://`, not `https://`** (a WebSocket entry point). ⚠️ The host name differs from the distribution origin
 *    (`nyan-relay` vs `nyan-remote`), so do not copy one into the other.
 *
 * ★★ **Moved to `relay.nyan-remote.app` on 2026-09-21** (user decision).
 *   ★ **The old `nyan-relay.nyan-remote-relay.workers.dev` is kept alive**, so
 *     **QR codes already handed out (with the old entry point in `r`) keep connecting**.
 *     Why: a room (Durable Object) is **looked up by the agent's public key**, so
 *     **either host name lands in the same room** = agent and phone may mix old and new.
 *   ⚠️ This is a default, so **agents that already have `relayUrl` written in `config.json` do not change**
 *      (it is written out on first start). ⇒ To move them, edit it by hand and restart.
 */
export const DEFAULT_RELAY_URL = 'wss://relay.nyan-remote.app'

/**
 * ★ Entry point for accounts and billing (2026-09-24 / docs/BILLING.md). Used by `nyan login` and by the agent fetching tickets.
 * ⚠️ Only needed when using our relay (Tailscale or your own relay need no account).
 */
export const ACCOUNT_ORIGIN = 'https://account.nyan-remote.app'

/**
 * ★ Client ID of the GitHub OAuth App (Device Flow enabled). ⚠️ Fine to publish (the secret lives only in the account Worker).
 *   Used by `nyan login` for GitHub's Device Flow. ⚠️ Same value as `GITHUB_CLIENT_ID` in `account/wrangler.jsonc`.
 */
export const GITHUB_CLIENT_ID = 'Ov23liR5gPIqJCohxOey'
