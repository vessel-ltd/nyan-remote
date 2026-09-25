// Authentication lives in this one file only (CLAUDE.md discipline 3).
// Handlers must not look at identity headers. In ③ this becomes device key pairs + pairing,
// and in ④ the per-account device limit sits here.
//
// Basis (confirmed on real hardware 2026-08-11 / ARCHITECTURE.md §5):
//   tailscale serve adds the following to the backend, and strips same-named headers coming from outside.
//     Tailscale-User-Login : user@github
//     X-Forwarded-For      : 100.67.123.108   (the phone's tailnet IP)
//     X-Forwarded-Proto    : https
//   Also confirmed that direct access not going through serve (curl 127.0.0.1:7777) does not get them.
//   → The presence of the headers can be used directly to tell "via serve or not".

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { acceptHandshake, type Session } from '../../shared/crypto.ts'
import { config, configProblem, problemMessage } from './config.ts'
import { agentKey } from './deviceKey.ts'
import {
  authorizeDevice,
  type Device,
  devicesBroken,
  isLiveRegistration,
  oneTimeCount,
} from './devices.ts'
import { magicDnsSuffix } from './tailscale.ts'
import { t } from '../../shared/i18n.ts'

export interface Identity {
  login: string
  /**
   * Device identifier (used to bind Push subscriptions).
   *
   * - `via:'tailscale'` … the tailnet IP as-is
   * - `via:'device'`    … ★ **the public-key fingerprint** (`fingerprint` / ARCHITECTURE §14.1.2.4)
   * - `via:'pairing'`   … ★ also the fingerprint. ⚠️⚠️ But this is **a peer that is not registered yet**
   *   (③ step 7 / §14.1.4). It only gets through the pairing endpoint, so **never use this to mean
   *   "registered"**. ⚠️ Don't use it for Push subscriptions either (don't bind to an unregistered device).
   *
   * ⚠️ Moving to ③ changes the same phone's `deviceId`. **The migration is safe** (`addSubscription`
   *    removes rows with the same `endpoint` before adding), but one narrow hole remains (§14.1.2.4).
   */
  deviceId: string
  via: 'tailscale' | 'dev' | 'local-hook' | 'device' | 'pairing'
}

export type AuthResult =
  | { ok: true; identity: Identity; rememberLogin?: string }
  | { ok: false; status: number; message: string }

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name]
  if (Array.isArray(v)) return v[0]
  return v
}

export function devMode(): boolean {
  return process.env.NYAN_REMOTE_DEV === '1'
}

/**
 * Secret comparison. Neither length differences nor content differences show up in timing.
 *
 * ⚠️ `a === b` compares from the start and exits at the first difference,
 *    which (in theory) leaves room for brute-forcing one character at a time.
 *    We hash before comparing because timingSafeEqual throws when lengths differ.
 */
export function sameSecret(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest()
  const hb = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(ha, hb)
}

/** Whether the method may change state (= a CSRF target) */
export function isUnsafeMethod(method: string | undefined): boolean {
  const m = (method ?? 'GET').toUpperCase()
  return m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS'
}

/**
 * ★ Stop CSRF.
 *
 * ⚠️ CORS is a mechanism for "not letting the response be read", not for "not letting the request arrive".
 *    `applyCors` merely omitting the allow headers **still lets the side effects happen**.
 *    The following attack actually worked (found in the 2026-08-12 review):
 *
 *      malicious page → POST /push/subscribe (registers the attacker's endpoint)
 *        deviceId is X-Forwarded-For = the user's own device IP, so
 *        newestPerDevice picks the attacker as "the newer one from the same device", and
 *        **notifications to the user silently stop**
 *      same page → fake events via POST /hook (→ /hook now requires a token)
 *
 *    Browsers always send `Origin` on POST, so **rejecting unsafe methods with a disallowed Origin
 *    before processing** closes it. Requests without `Origin` are non-browsers (notify.sh / curl),
 *    which can't be used as a CSRF springboard, so they pass.
 */
export async function rejectCrossOrigin(
  req: IncomingMessage,
): Promise<{ status: number; message: string } | null> {
  if (!isUnsafeMethod(req.method)) return null
  const origin = header(req, 'origin')
  // Non-browser (notify.sh / curl). Browsers always send Origin on POST, so
  // requests without it can't be a CSRF springboard. Returning here also avoids loading the config
  if (!origin) return null

  // ★ Same-origin is always allowed.
  //
  // ⚠️ CSRF is an attack "from another origin", so rejecting ourselves is wrong.
  //    Without this, when served from a non-tailnet origin (127.0.0.1 during development,
  //    ③'s public origin, ④'s app) **writes from our own screen get 403**.
  //    Noticed on 2026-08-12 after hitting 403 pressing the approve button with Playwright.
  // ⚠️ Check the scheme too (pointed out in the 2026-08-13 external review). Comparing only the host
  //    lets POSTs from `http://<same hostname>` pass as same-origin
  if (isSameOrigin(origin, header(req, 'host'), header(req, 'x-forwarded-proto'))) return null

  if (blocksCrossOrigin(req.method, origin, await isAllowedOrigin(origin))) {
    return { status: 403, message: t('許可されていないオリジンからの書き込みです', 'Writes from this origin are not allowed.') }
  }
  return null
}

/**
 * Whether the request's Origin is the request's own destination.
 *
 * Compared against the `Host` header. Behind serve, Host is the tailnet FQDN and Origin is
 * `https://<FQDN>`, so they match. `127.0.0.1:7788` during development matches as well.
 */
export function isSameOrigin(
  origin: string | undefined,
  host: string | undefined,
  proto?: string,
): boolean {
  if (!origin || !host) return false
  try {
    const u = new URL(origin)
    // Compare Origin's host part (including port) with the Host header
    if (u.host.toLowerCase() !== host.toLowerCase()) return false
    // ★ The scheme must match too.
    //
    // ⚠️ Comparing only the host lets writes from `http://<same hostname>` pass as same-origin
    //    (pointed out in the 2026-08-13 external review; reproduced as a pure function).
    //    Via serve, `X-Forwarded-Proto: https` is set. In development (plain http) it is not.
    const expected = proto === 'https' ? 'https:' : 'http:'
    return u.protocol === expected
  } catch {
    return false
  }
}

/** The IO-independent part of the check above. Split out so it can be tested */
export function blocksCrossOrigin(
  method: string | undefined,
  origin: string | undefined,
  originAllowed: boolean,
): boolean {
  if (!isUnsafeMethod(method)) return false
  if (!origin) return false
  return !originAllowed
}

/**
 * **Routes that only local processes on this machine may call.** Checked with a shared token
 * (`~/.nyan-remote/hook-token`, 0600) (no identity headers are attached).
 *
 * ⚠️⚠️ `/pair/token` is here on purpose (2026-09-07).
 *    If the pairing one-time token **could be issued over the network, an already
 *    registered phone could add a second device on its own** = the §14.1.2.5 premise
 *    "registration requires the PC's screen" breaks. ⇒ Only **whoever can read the token = someone on this machine**.
 * ⚠️ `POST /pair` (the phone sends its public key) is **not in here** (the phone calls it).
 *    Its protection is **the one-time token itself**.
 *
 * ★★ **Pass the `pattern` the router resolved. Never pass the raw path**
 *   (2026-09-08 codex round 2, high #1 / reproduced by measurement).
 *   ⚠️⚠️ The router **drops empty segments**, so `/hook/` `/permission/` `/pair//token`
 *      **hit the same handler**, yet exact matching on the raw path **slipped past the local-only check**:
 *
 *        /pair/token   → 403 (correct)
 *        /pair/token/  → ★ passed with the tailscale identity, and **a one-time token was actually issued**
 *        /hook/        → ★ passed, and **fake events could be injected without the hook token**
 *
 *   = a hole that should have been closed on 2026-08-12 was open because **there were two interpretations of the path**.
 *   ⇒ **Made it impossible by type to pass the raw path** (it only accepts `{ pattern }`).
 *      ★ Rather than adding another defense, **the thing authenticated and the thing executed are now the same value**.
 */
function isLocalOnlyPath(route: MatchedRoute | null | undefined): boolean {
  const p = route?.pattern
  return (
    p === '/hook' ||
    p === '/permission' ||
    p === '/pair/token' ||
    // ★★ One-time token status and cancellation (2026-09-23). ⚠️⚠️ If callable from the network,
    //    **a registered phone could cancel someone else's pairing** / peek at whether one was issued.
    p === '/pair/token/:id' ||
    p === '/pair/token/:id/cancel' ||
    // ★ Re-fetching the usage ticket (`nyan account` / 2026-09-24). ⚠️ Don't let phones call it (don't let them fire requests at account)
    p === '/account/refresh'
  )
}

/**
 * ★★ **Endpoints that someone on this machine may also call** (2026-09-21 / `scripts/devices.mjs`).
 *
 * ⚠️⚠️ **The opposite role of `isLocalOnlyPath`**: that one is "**local only**", this one is
 *    "**devices, and local too**". ⇒ Revocation from the phone (theft response) **stays as is**.
 *
 * ★ Why it's needed (we got stuck on this in practice on 2026-09-21): without it,
 *   **the machine's owner, standing right in front of it, could neither list nor revoke its registrations**.
 *   If the phone was revoked, lost, or had its site data cleared, there was **zero way to clean up**
 *   (machine B actually kept two dead registrations from two days earlier).
 *   ⚠️ Also needed for distribution: otherwise **a user who loses their phone has no way to recover**.
 *
 * ⚠️ No privilege is added: whoever can read `hook-token` **can already inject fake approvals and events**,
 *    and listing/revoking registrations is weaker than that. ⚠️⚠️ **Never add `/hook` `/permission` here**
 *    (those must be "local only" = otherwise a device could inject fake events).
 */
function isLocalAlsoPath(route: MatchedRoute | null | undefined, method: string | undefined): boolean {
  const p = route?.pattern
  if (p === '/devices' || p === '/devices/revoke') return true
  // ★★ **The pending-approval list may also be read from this machine, read-only** (2026-09-23 / `scripts/pending.mjs`).
  //   ⚠️⚠️ Why: `npm run pending` (the guard that checks for pending approvals before a restart)
  //      identified itself with the tailnet login name ⇒ **on machines installed with relay only (machine C, mac)
  //      it failed every time and checked nothing** (= the guard meant to avoid killing approvals wasn't working).
  //   ⚠️⚠️ **GET only**. `isLocalAlsoPath` only looks at the path shape, so the moment a POST is added
  //      to `/permissions` it would **silently open up**. ⇒ Check the method here as well.
  //      ★ The answering endpoint is `/permission/answer` (a different shape), so the hook token still can't answer.
  //   ⚠️ No privilege is added: whoever can read the hook token is **the same user** and can read the transcript directly
  //      (the `tool_input` in the list is already there). **The power to answer** is not handed over.
  if (p === '/permissions' && method === 'GET') return true
  // ★★ `/health` may also be read from this machine, read-only (2026-09-24 / `nyan account` / `nyan login`).
  //   ⚠️ Without it, `nyan account` couldn't read the plan and wrongly said "the agent is old", and `nyan login` couldn't get the agent's key (on real hardware).
  //   ⚠️ No privilege is added (same content as the diagnostics shown on screen; no power to answer). ⚠️ GET only
  if (p === '/health' && method === 'GET') return true
  return false
}

/**
 * The token local processes on this machine identify with (`~/.nyan-remote/hook-token`).
 *
 * ⚠️ `type:"http"` hooks send it as `Authorization: Bearer`, so accept **both**.
 * ★ Extracted in one place (writing it in two places means one of them forgets Bearer).
 */
function localToken(req: IncomingMessage): string | undefined {
  const bearer = header(req, 'authorization')?.replace(/^Bearer\s+/i, '')
  return header(req, 'x-nyan-remote-token') ?? bearer
}

/**
 * ★★ The destination resolved by the router. Shaped so **the raw `url.pathname` cannot be passed**.
 *
 * ⚠️ `undefined` when nothing matched (= static serving). It never becomes local-only.
 */
export interface MatchedRoute {
  /** The registered string (e.g. `/sessions/:id/log`). ⚠️ Not the raw path */
  pattern: string
}

// ─────────────────────────────────────────────────────────────────────────────
// ★★ ③ Identity by device key (`via: 'device'` / ARCHITECTURE §14.1.2.8)
//
// ⚠️⚠️ **Don't take identity from headers.** A form like `x-nyan-device: <public key>` would
//    **let browsers and curl claim it** (relying on `tailscale serve` stripping same-named headers from
//    outside is "opening a hole before authentication" / CLAUDE.md §1).
//    ⇒ **Only what passed the handshake** becomes a device identity.
//
// ★★ **Promote conventions to invariants** (the shape learned in §14.1.2.11):
//   - **Only auth.ts can create the actual `DeviceConnection`** (the `minted` `WeakMap`)
//     ⇒ passing an object of the same shape can't be marked
//   - The mark is **a `WeakMap` keyed by the request itself** ⇒ it can't leak to another request or be copied
//   - Verification is **only** `authorizeDevice` in `devices.ts` (a required argument of `acceptHandshake`)
//
// ★★ **Revocation also applies to "connections that already completed the handshake"** (2026-09-08 / codex round 2, medium #8).
//   ⚠️⚠️ Before the fix, holding a connection obtained from a handshake **let requests through even after revocation**
//      (`minted` only remembered "created by auth.ts", and `authenticate` didn't look at the registration).
//      ★ `POST /handshake` discards the connection, so **there was no harm yet**, but
//        **it becomes a hole the moment the step-6 tunnel keeps a connection** ⇒ closed before the tunnel.
//   ⇒ At handshake time, **bind the registration itself (= generation) returned by `authorizeDevice` to the connection**,
//     and **on each request's authentication, check with `isLiveRegistration` that it is still alive**.
//   ⚠️⚠️ Don't check "is the key still registered" (**re-registration would revive old connections**).
//
// ⚠️ The tunnel (relay / local WebSocket) **doesn't exist yet**. Step 6 calls into this.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A connection with a device that passed the handshake.
 *
 * ⚠️⚠️ **Building one yourself does not make it an identity** (`markDeviceRequest` refuses it).
 *    Only what `acceptDeviceHandshake` returned gets through.
 */
export interface DeviceConnection {
  /** ★ Encrypted round trips go through this (used by the tunnel layer) */
  readonly session: Session
  /** ★ Public-key fingerprint (= `Identity.deviceId`) */
  readonly deviceId: string
}

export interface DeviceHandshake {
  /** The second message returned to the device */
  readonly reply: Uint8Array
  /** Confirmation frame (⚠️ without it the device side never becomes a `Session`) */
  readonly confirm: Uint8Array
  readonly connection: DeviceConnection
}

/**
 * ★★ **What** this handshake was let through **as** (2026-09-18 / ③ step 7 = pairing via relay).
 *
 * ⚠️⚠️ **`pairing` is "a peer not registered yet"**. The session key is real, but
 *    all it can do is **the single pairing endpoint** (`authenticate` closes everything else by default-deny).
 *    ⇒ Loosening this **hands full power to a stranger** (what the `parseInit` note in `shared/crypto.ts`
 *      describes, "an unknown device obtains a valid session key", would now happen **on purpose**).
 */
export type Minted =
  | { readonly kind: 'device'; readonly registration: Device }
  | { readonly kind: 'pairing' }

/**
 * ★ Only connections created by auth.ts (keyed by **an identity that cannot be copied**).
 *
 * ★★ The value is **the registration (= generation) let through by that handshake**. ⚠️⚠️ **Keep it private**
 *    (if exposed, the tunnel layer could swap the generation itself = defeat revocation.
 *    ★ Whether it's pairing lives here for the same reason = **the tunnel layer can't escalate it**).
 */
const minted = new WeakMap<DeviceConnection, Minted>()

/** Contents of a mark. ★ **The generation is captured at marking time** (not looked up again from the key later) */
interface Marked {
  readonly connection: DeviceConnection
  readonly minted: Minted
}

/**
 * ★★ **The only endpoint a pairing-only connection may use** (③ step 7 / ARCHITECTURE §14.1.4).
 *
 * ⚠️⚠️ **Don't make it a table, don't add more.** The moment there are two, the containment of
 *    "registration only, once" breaks. ⚠️ `/pair/token` is **separate** (that is `isLocalOnlyPath` = PC only;
 *    if it could be issued from the network, "registration requires the PC's screen" breaks / §14.1.2.15).
 */
function isPairingPath(route: MatchedRoute | null | undefined): boolean {
  return route?.pattern === '/pair'
}

/** ★ Whether this connection is pairing-only (the tunnel layer checks it to "close once registration is done") */
export function isPairingConnection(connection: DeviceConnection): boolean {
  return minted.get(connection)?.kind === 'pairing'
}

/** ★ The mark is keyed by the request itself (⚠️ holding it globally would affect other requests) */
const marks = new WeakMap<IncomingMessage, Marked>()

/**
 * Accept a handshake from a device.
 *
 * ⚠️ Verification is `authorizeDevice` (`devices.json`). **If not registered, refuse without deriving a key.**
 * ⚠️ If the agent key is unusable, `agentKey()` throws (= no decision is made here).
 */
/**
 * ★★ **The single decision of whom to let through** (③ step 7 added a second answer / ARCHITECTURE §14.1.4).
 *
 * 1. registered          → `device` (as before; every endpoint is usable)
 * 2. unregistered **and ★ an unused one-time token exists** → `pairing` (pairing endpoint only)
 * 3. anything else       → refuse (no key derived = exactly as before)
 *
 * ★★ **The "only while a one-time token exists" in 2 is the crux** (2026-09-18; a safeguard added to the design doc).
 *   ⚠️⚠️ The agent's public key **appears in the QR and in URLs** (assumed known), so without a condition
 *      there would be a permanent **connection anyone could key-agree with at any time while unregistered** (and make us run 4 ECDHs).
 *   ⇒ The door is open **only for the 5 minutes right after `npm run pair`** (`ONE_TIME_TTL_MS`).
 *      At all other times the behavior is **not one bit different from before this change**.
 *   ⚠️ This is not a substitute for rate limiting but an **existence condition** (stronger than §14.1.4's "limit the count").
 *   ⚠️⚠️ **The one-time token's contents are not checked here** (still inside the envelope). `registerDevice` checks them.
 *      All this checks is "did a person at the PC display a QR".
 */
function authorizeConnection(info: { devicePublicRaw: Uint8Array; deviceId: string }): Minted | undefined {
  const registration = authorizeDevice(info)
  if (registration) return { kind: 'device', registration }
  // ⚠️ Unregistered. ⇒ Only while a person is displaying a QR, let it through as pairing-only
  if (oneTimeCount() > 0) return { kind: 'pairing' }
  return undefined
}

export async function acceptDeviceHandshake(initMessage: Uint8Array): Promise<DeviceHandshake> {
  // ⚠️ `agentKey()` throws when unusable (with a reason / deviceKey.ts)
  const pair = agentKey()
  // ⚠️ Spell out the type argument (it carries **the very thing let through** returned by `authorizeConnection`)
  let accepted: Awaited<ReturnType<typeof acceptHandshake<Minted | undefined>>>
  try {
    accepted = await acceptHandshake(pair, initMessage, authorizeConnection)
  } catch (err) {
    // ★ **Only adds "why" after refusing** (the decision stays in the one place, `authorizeDevice`).
    //   ⚠️ Without this, a broken file would also say "not registered" and **couldn't be fixed**.
    const broken = devicesBroken()
    if (broken) throw new Error(t(`登録済みデバイスの記録が壊れています（${broken}）`, `The registered-device records are broken (${broken}).`))
    throw err
  }
  // ★★ Use **the `deviceId` returned by `acceptHandshake`** (= the very peer we key-agreed with).
  //   ⚠️ Don't recompute the fingerprint here (computing it in two places can diverge).
  const connection: DeviceConnection = {
    session: accepted.session,
    deviceId: accepted.deviceId,
  }
  // ★★ Bind **the registration that was let through** to the connection (`authorized` is `authorizeDevice`'s return value).
  //   ⚠️⚠️ Don't look it up again from the key here (that would be a different path from "what was verified").
  minted.set(connection, accepted.authorized)
  return { reply: accepted.message, confirm: accepted.confirm, connection }
}

/**
 * Mark this request as "arrived from that device" (★ only the tunnel layer calls this).
 *
 * ⚠️⚠️ **Refuse any connection other than one returned by `acceptDeviceHandshake`** (checked by identity, not type).
 */
export function markDeviceRequest(req: IncomingMessage, connection: DeviceConnection): void {
  const got = minted.get(connection)
  if (!got) {
    throw new Error(t('この接続は握手を通っていません（デバイスの身元にできません）', 'This connection has not passed the handshake (it cannot be a device identity)'))
  }
  marks.set(req, { connection, minted: got })
}

/**
 * ★★ Whether this connection is still valid (checked **before the tunnel sends** / continuation of §14.1.2.21).
 *
 * ⚠️⚠️ Per-request authentication (`authenticate`) alone doesn't apply revocation to
 *    **long-lived subscriptions** (`/events`) (once through, it keeps streaming). ⇒ The tunnel checks this **for every frame**.
 * ⚠️ Connections that didn't pass the handshake (fakes) are `false` (not in `minted`).
 */
export function isDeviceConnectionLive(connection: DeviceConnection): boolean {
  const got = minted.get(connection)
  if (!got) return false
  // ★ Pairing-only connections **hold no registration**, so there is nothing to revoke (③ step 7).
  //   ⚠️ Keeping it alive is safe because it can reach **only the one pairing endpoint** (`authenticate`).
  //   ⚠️⚠️ **It ends "when registration is done"** (the tunnel layer closes it). Returning `false` here
  //      would mean **the registration response itself can't be sent** (the screen shows "timed out" and,
  //      although registration succeeded, the device believes it can't connect).
  if (got.kind === 'pairing') return true
  return isLiveRegistration(got.registration)
}

/**
 * @param route ★ **The destination resolved by the router** (the result of `router.match()`).
 *   ⚠️⚠️ **Never pass the raw `url.pathname`** (read the note on `isLocalOnlyPath`).
 *      The types prevent it.
 */
export function authenticate(
  req: IncomingMessage,
  route: MatchedRoute | null | undefined,
): AuthResult {
  // ★★ If the config is unusable, always stop here too (2026-08-14 review, medium).
  //
  // ⚠️ In reject mode `allowedLogins` is `[]`, so **without this gate we'd fall into the TOFU branch below**
  //    and issue an identity to any tailnet login (reaching conversation reads and answering approvals on the user's behalf).
  //    If the gate in index.ts were the only gate, **just moving it would turn into "anyone gets in"**.
  //    Per discipline 3, this file also carries the authentication decision.
  const broken = configProblem()
  if (broken) return { ok: false, status: 503, message: problemMessage(broken) }

  // ★★ ③ Requests that came with a device key (only those with the mark of a passed handshake).
  //
  // ⚠️ **Check before the headers** (requests through the tunnel have no identity headers, so
  //    falling to the branches below gives 403, and with `NYAN_REMOTE_DEV=1` it turns into `via:'dev'`).
  // ⚠️⚠️ **After the 503 for a broken config** (when the auth inputs can't be trusted,
  //    no path gets through = the device path must not bypass the gate above).
  const marked = marks.get(req)
  if (marked) {
    // ★★ **Pairing-only connections are contained here** (③ step 7 / ARCHITECTURE §14.1.4).
    //
    // ⚠️⚠️ **Default deny.** The peer on this connection **is not registered yet** (the session key is real).
    //    Rather than an allowlist, name **just one endpoint** and refuse everything else.
    // ⚠️⚠️ **Don't fall through to the branches below** (with `NYAN_REMOTE_DEV=1` it would become `via:'dev'` and
    //    **everything would pass** = full power to an unregistered peer. Same trap as revocation / CLAUDE.md §2).
    // ⚠️ `deviceId` is exposed, but it is **the fingerprint of the key-agreed peer**, not "registered".
    if (marked.minted.kind === 'pairing') {
      if (!isPairingPath(route)) {
        return {
          ok: false,
          status: 403,
          message: t('この端末はまだ登録されていません（できるのはペアリングだけです）', 'This device is not registered yet (only pairing is allowed).'),
        }
      }
      return {
        ok: true,
        identity: {
          login: `pairing:${marked.connection.deviceId}`,
          deviceId: marked.connection.deviceId,
          via: 'pairing',
        },
      }
    }
    // ★★ **Revocation takes effect here** (2026-09-08 / codex round 2, medium #8).
    //
    // ⚠️⚠️ **Refuse. Never fall through to the branches below.** Requests through the tunnel have no
    //    identity headers, so it's tempting to think falling through gives 403, but with `NYAN_REMOTE_DEV=1`
    //    **it becomes `via:'dev'` and everything passes**.
    // ⚠️ Check **the generation captured at handshake time** (looking it up by key would **revive it on re-registration**).
    if (!isLiveRegistration(marked.minted.registration)) {
      return {
        ok: false,
        status: 403,
        message: t('この端末の登録は失効しています（もう一度ペアリングしてください）', 'This device\'s registration has been revoked. Pair it again.'),
      }
    }
    const device = marked.connection
    // ⚠️⚠️ **Don't let devices call the hook endpoints.** Those are only for local processes on this machine
    //    (`hooks/notify.sh` / the approval hook); letting them through **allows fake event injection**
    //    (fake Stop / Notification could forge the list and notifications / same shape as the 2026-08-12 hole).
    if (isLocalOnlyPath(route)) {
      return { ok: false, status: 403, message: t('この口はこのマシンのローカルプロセス専用です', 'This endpoint is only for local processes on this machine.') }
    }
    // ⚠️ No `rememberLogin` (there is no TOFU in ③ / §14.1.2.5)
    return {
      ok: true,
      identity: { login: `device:${device.deviceId}`, deviceId: device.deviceId, via: 'device' },
    }
  }

  if (isLocalOnlyPath(route)) {
    // ⚠️⚠️ Never "fall through to the normal check" here.
    //    Back when it did, a user merely opening an arbitrary website let
    //    that page POST /hook (because serve attaches identity headers to browser requests).
    //    Fake Stop / StopFailure / Notification could be injected to forge the list and notifications.
    //    hook is always checked by token (found in the 2026-08-12 review).
    const token = localToken(req)
    const expected = config().hookToken
    if (!expected) {
      return { ok: false, status: 503, message: t('hook トークンが未設定です', 'The hook token is not configured.') }
    }
    if (!token || !sameSecret(token, expected)) {
      return { ok: false, status: 403, message: t('hook トークンが違います', 'The hook token is wrong.') }
    }
    return { ok: true, identity: { login: 'local-hook', deviceId: 'local', via: 'local-hook' } }
  }

  // ★★ **Someone on this machine** (`scripts/devices.mjs`). 2026-09-21.
  //
  // ⚠️⚠️ Only checked **when a token is presented**. If not presented, **fall through below**
  //    = tailnet browsers and devices behave **as before** (this branch only adds).
  // ⚠️ If presented but wrong, **refuse instead of falling through** (don't let a wrong token turn into another path).
  // ★ Device requests have **already returned in the `marked` block above**, so they never get here.
  if (isLocalAlsoPath(route, req.method)) {
    const token = localToken(req)
    if (token !== undefined) {
      const expected = config().hookToken
      if (!expected) return { ok: false, status: 503, message: t('hook トークンが未設定です', 'The hook token is not configured.') }
      if (!sameSecret(token, expected)) {
        return { ok: false, status: 403, message: t('hook トークンが違います', 'The hook token is wrong.') }
      }
      return { ok: true, identity: { login: 'local-cli', deviceId: 'local', via: 'local-hook' } }
    }
  }

  const login = header(req, 'tailscale-user-login')
  const proto = header(req, 'x-forwarded-proto')
  // X-Forwarded-For can be "client, proxy1, ...". The first entry is the client.
  const forwardedFor = header(req, 'x-forwarded-for')?.split(',')[0]?.trim()

  // Only in development, allow requests without identity headers.
  //
  // ⚠️ Even in production the peer is always loopback (serve proxies from localhost), so
  //    "loopback or not" can't decide it. The only signal is whether the headers are present.
  if (!login && !proto) {
    if (devMode()) {
      return { ok: true, identity: { login: 'dev@localhost', deviceId: 'dev', via: 'dev' } }
    }
    return {
      ok: false,
      status: 403,
      message: t('tailscale serve 経由でアクセスしてください（開発時は NYAN_REMOTE_DEV=1）', 'Access this through tailscale serve (use NYAN_REMOTE_DEV=1 during development).'),
    }
  }

  if (proto !== 'https') {
    return { ok: false, status: 403, message: t('https 経由でのみ受け付けます', 'Only https requests are accepted.') }
  }
  if (!login) {
    return { ok: false, status: 403, message: t('身元ヘッダがありません', 'The identity header is missing.') }
  }

  const allowed = config().allowedLogins
  if (allowed.length === 0) {
    // First access: record this login and pin it from then on (§8.2 pairing is just opening the URL)
    return {
      ok: true,
      identity: { login, deviceId: forwardedFor ?? 'unknown', via: 'tailscale' },
      rememberLogin: login,
    }
  }
  if (!allowed.includes(login)) {
    return { ok: false, status: 403, message: t('許可されていないログインです', 'This login is not allowed.') }
  }
  return { ok: true, identity: { login, deviceId: forwardedFor ?? 'unknown', via: 'tailscale' } }
}

/**
 * Decide whether the origin is allowed.
 *
 * ⚠️ Loosening this is dangerous. serve attaches identity headers "on the server side", so if a tailnet user
 * has an arbitrary website open, that site's JS could fetch /sessions.
 * **Only CORS stops the response from being read.**
 *
 * Only two kinds are allowed:
 *   1. Those listed explicitly in the config's allowedOrigins (e.g. a future public distribution origin)
 *   2. **https origins on the same tailnet** (`*.<MagicDNS suffix>`)
 *
 * Why 2 can be allowed automatically: only "pages served by a node on that tailnet" can have such an
 * origin. Unrelated websites are other origins, so they don't match this condition.
 * This removes the need for manual configuration every time a second machine is added.
 */
export async function isAllowedOrigin(origin: string): Promise<boolean> {
  // ★★ **Removed the automatic allowance for the official distribution origin** (2026-09-18 / the core of codex round 7, high #2).
  //
  // ⚠️⚠️ **Do not revert this.** "It's the very app we distribute, so no new trust is added" was
  //    **wrong** (two points / `shared/distribution.ts`):
  //    1. Passing here also passes `rejectCrossOrigin()` = **writes as well as reads**.
  //       And since `tailscale serve` attaches identity headers, just opening that origin in a
  //       browser on the tailnet **allowed operating the agent without device registration**.
  //    2. It was attached **unconditionally** even to agents of **people who never open that origin** (self-distribution).
  //  ★ Why it could be removed: pairing moved onto the relay (§14.1.4), so
  //    **the public-origin PWA does not talk HTTP to the agent** (all relay WebSocket).
  //  ⚠️ People who host their own write it in `config.json`'s `allowedOrigins` (= **they decide**).
  if (config().allowedOrigins.includes(origin)) return true
  return matchesTailnetOrigin(origin, await magicDnsSuffix())
}

/**
 * Whether it's an https origin on the same tailnet. A pure function that spawns no process, so it can be tested.
 * ⚠️ Security-critical. If this loosens, any website can read /sessions.
 */
export function matchesTailnetOrigin(origin: string, suffix: string | undefined): boolean {
  if (!suffix) return false
  let u: URL
  try {
    u = new URL(origin)
  } catch {
    return false
  }
  // No http (serve only attaches identity headers over https)
  if (u.protocol !== 'https:') return false
  // Reject ports: they can't occur in a serve setup
  if (u.port) return false
  const host = u.hostname.toLowerCase()
  const suf = suffix.toLowerCase().replace(/^\.+|\.+$/g, '')
  if (!suf) return false
  // Reject names that merely end with the suffix, like `evil-example.ts.net`
  return host === suf || host.endsWith(`.${suf}`)
}

/**
 * CORS. Same-origin needs no headers, so nothing is added.
 * @returns true if the preflight was completed here
 */
export async function applyCors(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const origin = header(req, 'origin')
  if (origin && (await isAllowedOrigin(origin))) {
    res.setHeader('access-control-allow-origin', origin)
    res.setHeader('vary', 'origin')
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
    res.setHeader('access-control-allow-headers', 'content-type')
    res.setHeader('access-control-max-age', '600')
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end()
    return true
  }
  return false
}
