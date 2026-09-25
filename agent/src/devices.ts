// Registered devices (`~/.nyan-remote/devices.json`) and the pairing one-time codes.
//
// ★★ **This layer exists to eliminate "pairing reopens when the file breaks"**
//   (ARCHITECTURE §14.1.2.5). The current TOFU (`allowedLogins` in `config.json`)
//   **treated a broken file as `[]` = first launch and registered whoever came next**.
//   ⇒ Here "broken" is **distinguished from zero registered devices**, and **writes are refused too**.
//   = There is **structurally no path** where "it broke, so it reopens".
//
// ★★ **Identity is the public key itself.** The `Map` key is the base64url of the raw public key, so
//   **a lookup hit = the keys match**.
//   ⚠️ Do not switch to looking up by fingerprint (`deviceId`) and then comparing bytes. Collisions cannot be
//      produced, so it becomes **a redundant guard no test can kill** (the lesson from autoApprove / CLAUDE.md §2).
//   ⚠️ Public keys are not secret, so this comparison does not need to be constant-time.
//      **Only the one-time code must not leak through timing** (it goes through `sameBytes`).
//
// ★★ **One-time codes live in memory only. Never write them to a file.**
//   ① Restarting the agent invalidates any QR still on display (the desirable direction)
//   ② **There is no path for pairing to be revived from a corrupted or rolled-back state file**
//   ⇒ `nyan-remote qr` does not mint its own code; it **asks the running agent to issue one**
//     (stage 4. The agent is the authority).
//
// ⚠️ When broken, we lean the same way as `auto-approve.json` (**fall to the safe side**):
//   keep running (unlike `config.json`, we do not 503 every request). But
//   **zero registered devices = refuse every device-key connection** (fail-closed). Until it is repaired,
//   the `via:'tailscale'` route (`local`) still works.

import { randomBytes } from 'node:crypto'
import { PUBKEY_BYTES, fromBase64Url, importPublicKey, sameBytes, toBase64Url } from '../../shared/crypto.ts'
import { readJsonFile, writeJson } from './state.ts'
import { t } from '../../shared/i18n.ts'
import { reasonText } from './reasons.ts'

/** ⚠️ Lives under `~/.nyan-remote/` (protected names in §0: do not use `nyan-remote` here) */
export const DEVICES_FILE = 'devices.json'

/**
 * ★★ Lifetime of a one-time code.
 *
 * ⚠️ **Do not create an entry point that lets the UI pass the length** (same reason as the auto-approve expiry = no de facto unlimited codes).
 * ⚠️ Long enough to "show the QR, open the phone camera, and scan it". If there is a reason to lengthen it, **measure first**.
 */
export const ONE_TIME_TTL_MS = 5 * 60 * 1000

/** Maximum label length (display only. ⚠️ It is an external string, so we truncate at the entry point) */
export const MAX_LABEL = 64

/**
 * One registered device.
 *
 * ⚠️⚠️ **Do not store `deviceId` (the fingerprint).** Putting a value derivable from the key into the file
 *    creates **two truths that can disagree** (CLAUDE.md §2 "inferring meaning from the stored shape").
 *    If the display needs a fingerprint, **derive it from the key at that time**.
 */
export interface Device {
  /** ★ base64url of the raw public key (65 bytes). **This is the identity itself** */
  key: string
  /** Display name. ⚠️ An external string; never used for any decision */
  label: string
  /** Registration time (ISO8601). ⚠️ **Not rewritten** on a duplicate registration (do not overwrite the record) */
  addedAt: string
}

interface Stored {
  v: 1
  devices: Device[]
}

/**
 * ★★ The state currently held.
 *
 * ⚠️⚠️ **"Broken" and "the set of registered devices" are a single value** (same as autoApprove).
 *    Separate variables would turn "empty when broken" into a **convention**, with `if (broken)` sprinkled
 *    everywhere. ⇒ **Use the type to make the set unreachable while broken.**
 */
type Loaded =
  | { kind: 'ok'; devices: Map<string, Device> }
  | { kind: 'broken'; reason: string }

let state: Loaded = { kind: 'ok', devices: new Map() }

/** Issued one-time codes. ⚠️ **Memory only** (read the notes above) */
interface OneTimeState {
  /** ⚠️ Compare with `sameBytes`. Do not use it as a `Map` key (the content would leak through timing) */
  bytes: Uint8Array
  expiresAtMs: number
  /**
   * ★★ An id for status queries (2026-09-23 / so `npm run pair` can tell whether it was scanned).
   * ⚠️⚠️ **Not the one-time code itself** (knowing it does not allow registration).
   *    ⇒ The status and cancel endpoints **do not need the one-time code** (no secrets in logs or arguments).
   * ⚠️ Even so, those endpoints are **local to this machine only** (`isLocalOnlyPath` in `auth.ts`).
   */
  id: string
}

let oneTimes: OneTimeState[] = []

/**
 * ★★ Outcomes of used one-time codes (id → outcome). ⚠️ **Memory only**, with an expiry.
 * ⚠️ We only remember "which device was registered" (never the code itself = it vanishes once consumed).
 */
type Settled =
  | { kind: 'registered'; deviceKey: string; label: string; already: boolean }
  | { kind: 'failed'; reason: string }
  | { kind: 'cancelled' }
  /**
   * ★★ From consumption until the outcome is decided (while waiting for the save).
   * ⚠️⚠️ Without this, during that window it was in neither `oneTimes` nor the outcomes, so **we answered `expired`**
   *    (codex round 15, medium #1) ⇒ `npm run pair` ended with "expired", **and then the registration went through**.
   */
  | { kind: 'registering' }
const settled = new Map<string, { result: Settled; untilMs: number }>()

export interface OneTime {
  token: string
  /** ISO8601 (shown next to the QR) */
  expiresAt: string
  /** Id for status queries (⚠️ not the one-time code) */
  id: string
}

/** ★ Status of a one-time code (`npm run pair` polls it every second) */
export type OneTimeStatus =
  | { state: 'waiting'; expiresAt: string }
  | { state: 'registered'; deviceKey: string; label: string; already: boolean }
  | { state: 'failed'; reason: string }
  | { state: 'cancelled' }
  /** ★ The phone is in the middle of registering (waiting for the save). ⚠️ Not expired */
  | { state: 'registering' }
  | { state: 'expired' }

export type DeviceResult =
  | { ok: true; device?: Device; already?: boolean }
  | { ok: false; reason: string; saved?: boolean }

// ─────────────────────────────────────────────────────────────────────────────
// Loading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read at startup.
 *
 * ⚠️ Distinguishes "missing" (first launch) from "broken" (`readJsonFile` in `state.ts`).
 * ⚠️ **Never writes back while loading** (keep the evidence; there is nothing to clean up anyway).
 * ⚠️ Call only at startup (and in tests). Do not interleave with in-flight registrations.
 */
export async function loadDevices(): Promise<void> {
  const file = await readJsonFile<Partial<Stored>>(DEVICES_FILE)
  if (file.kind === 'broken') {
    state = { kind: 'broken', reason: file.reason }
    console.warn(
      t(
        `[devices] 登録済みデバイスが読めないのでデバイス鍵の接続を全部断る: ${file.reason} / ${file.detail}`,
        `[devices] Cannot read the registered devices; refusing all device-key connections: ${reasonText(file.reason)} / ${file.detail}`,
      ),
    )
    return
  }
  const devices = new Map<string, Device>()
  if (file.kind === 'missing') {
    state = { kind: 'ok', devices }
    return
  }

  // ★★ **A broken structure is treated as "broken"** (never `Array.isArray(x) ? x : []`).
  //   ⚠️⚠️ Falling back to zero devices lets the next registration **overwrite the evidence** (same as autoApprove's codex medium #6).
  //   ⚠️ Check `v` too. **Refuse unknown versions** (an old agent reading a file written by a newer one).
  //   ⚠️ If even one device has an invalid shape, treat the whole file as broken (it is **a value a correct writer
  //      never produces**, so dropping entries individually leaves "partly working, with no idea what happened").
  const problem = structureProblem(file.value)
  if (problem) {
    state = { kind: 'broken', reason: problem }
    console.warn(
      t(
        `[devices] 登録済みデバイスが壊れているのでデバイス鍵の接続を全部断る: ${problem}`,
        `[devices] The registered devices are broken; refusing all device-key connections: ${reasonText(problem)}`,
      ),
    )
    return
  }
  // ★★ **Also verify each one is usable as a key** (2026-09-08 codex medium #4).
  //
  // ⚠️⚠️ `validDevice` **only checks the length**, so an invalid 65-byte value (all zeros, etc.) was
  //    loaded as "valid". "It was checked with `importPublicKey` at registration" is
  //    **no justification once the file has been corrupted** (hand-edited or restored).
  // ★ This is a **reachable check** (nobody else verifies the point is on the curve) = a mutation can kill it.
  //
  // ⚠️⚠️ **Publish the state exactly once, at the end** (mid-load the previous state stays = fail-closed).
  //    ★ It used to "collect first, then insert", but **that was equivalent** (on failure we replace
  //      `state` wholesale with `broken`, so the partially filled map is never reachable).
  //      ⇒ The mutation survived, so we reshaped it around **the number of publications** instead (2026-09-08).
  for (const raw of file.value.devices ?? []) {
    const device = validDevice(raw)!
    try {
      await importPublicKey(fromBase64Url(device.key))
    } catch {
      // ⚠️ One unusable key makes the whole file broken (a value a correct writer never produces)
      const reason = '公開鍵として読めない登録があります'
      state = { kind: 'broken', reason }
      console.warn(
        t(
          `[devices] 登録済みデバイスが壊れているのでデバイス鍵の接続を全部断る: ${reason}`,
          `[devices] The registered devices are broken; refusing all device-key connections: ${reasonText(reason)}`,
        ),
      )
      return
    }
    devices.set(device.key, device)
  }
  state = { kind: 'ok', devices }
  console.log(t(`[devices] 登録済みデバイス ${devices.size} 台`, `[devices] Registered devices: ${devices.size}`))
}

/**
 * ★ Structural check of the state file. Returns **the reason it is broken** (only a category safe to expose) or `undefined`.
 *
 * ⚠️ Once this passes, `validDevice` always returns a value (we use the same function so **the rule is not written twice**).
 */
function structureProblem(value: Partial<Stored>): string | undefined {
  if (value.v !== 1) return '知らない版です'
  const devices = value.devices
  if (devices === undefined) return 'devices がありません'
  if (!Array.isArray(devices)) return 'devices が配列ではありません'
  const seen = new Set<string>()
  for (const raw of devices) {
    const device = validDevice(raw)
    if (!device) return 'デバイスの形が不正です'
    // ⚠️ A file with the same key on two rows is also "a value a correct writer never produces" (one would vanish in the Map)
    if (seen.has(device.key)) return '同じ鍵が重複しています'
    seen.add(device.key)
  }
  return undefined
}

/**
 * ⚠️ Shape is checked **once, at the entry point** (never forced through with `as` later).
 *
 * ★ The key is **checked down to its length** (only hand-edited or corrupted files have a length that cannot be a raw P-256 public key).
 *   ⚠️ Whether it is a point on the curve is **verified with `importPublicKey` at registration** (we keep this synchronous).
 */
function validDevice(raw: unknown): Device | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  const key = typeof o['key'] === 'string' ? o['key'] : ''
  const label = typeof o['label'] === 'string' ? o['label'] : undefined
  const addedAt = typeof o['addedAt'] === 'string' ? o['addedAt'] : ''
  if (!key || label === undefined || !addedAt) return undefined
  if (!Number.isFinite(Date.parse(addedAt))) return undefined
  if (decodedLength(key) !== PUBKEY_BYTES) return undefined
  // ★★ **The encoding must be canonical** (2026-09-08 codex round 2, medium #2).
  //   ⚠️⚠️ With a trailing `=`, `fromBase64Url` and `importPublicKey` still accept it, but
  //      authentication looks up by `toBase64Url(raw)` (no padding), so **it never matches** =
  //      a registration that **shows in the list but cannot authenticate** was possible (reproduced).
  //   ⇒ **Accept only the encoding a correct writer produces** (do not silently fix it = keep the evidence).
  if (toBase64Url(fromBase64Url(key)) !== key) return undefined
  return { key, label, addedAt }
}

/** Decoded length of a base64url string. ⚠️ `-1` if it contains unreadable characters (never silently 0) */
function decodedLength(key: string): number {
  try {
    return fromBase64Url(key).length
  } catch {
    return -1
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Lookups (★ decisions are synchronous: they sit in the handshake's serial path)
// ─────────────────────────────────────────────────────────────────────────────

/** Whether the state file is broken (to surface the reason on screen and in diagnostics) */
export function devicesBroken(): string | undefined {
  return state.kind === 'broken' ? reasonText(state.reason) : undefined
}

/** List of registered devices (input for the PC-side screen and `npm run keys`) */
export function listDevices(): Device[] {
  return state.kind === 'ok' ? [...state.devices.values()] : []
}

/**
 * ★★ Pass this **as is** as the third argument (`Authorize`) of `acceptHandshake`.
 *   If it passes, returns **the registration itself** (`undefined` if unregistered or broken).
 *
 * ⚠️⚠️ The handshake side is shaped so that "not passing a check fails the type check" (ARCHITECTURE §14.1.2.11).
 *    ⇒ **This is the one and only implementation of that check.** Never let callers write `() => true`.
 *
 * ★★ **It returns the registration itself, not a boolean** (2026-09-08 / codex round 2, medium #8).
 *   ⚠️⚠️ A boolean would leave **nothing to enforce revocation with** after the handshake
 *      (callers could only re-look up by key, and **re-registration would revive old connections**).
 *   ⇒ **The identity of the `Map` value itself serves as the "registration generation"** (`isLiveRegistration`).
 *
 * ⚠️ `undefined` when broken (fail-closed). ⚠️ The type keeps the set out of reach.
 */
export function authorizeDevice(info: { devicePublicRaw: Uint8Array }): Device | undefined {
  if (state.kind !== 'ok') return undefined
  return state.devices.get(toBase64Url(info.devicePublicRaw))
}

/** Whether this public key is registered (★ the only real implementation of the check is `authorizeDevice`) */
export function isRegisteredKey(publicRaw: Uint8Array): boolean {
  return authorizeDevice({ devicePublicRaw: publicRaw }) !== undefined
}

/**
 * ★★ Whether that registration generation is still alive (2026-09-08 / codex round 2, medium #8).
 *
 * Pass **the object `authorizeDevice` returned at handshake time**. ⇒ `auth.ts` checks this on every
 * request authentication, so **revocation also applies to connections that already completed the handshake**.
 *
 * ⚠️⚠️ **Do not change this to re-look up by key and check "is it still registered".**
 *    Then revoke → re-register with the same key would **revive the old connection**
 *    (= revocation would only mean "it disappeared from the list once").
 *    ⇒ Check that it is **the very same** `Map` value (re-registering creates a different object).
 * ⚠️ false while the records are broken (fail-closed).
 * ⚠️ Reloading via `loadDevices()` replaces every generation (= handshake again. The safe side).
 */
export function isLiveRegistration(registration: Device): boolean {
  if (state.kind !== 'ok') return false
  return state.devices.get(registration.key) === registration
}

// ─────────────────────────────────────────────────────────────────────────────
// ★★ One-time codes (the QR's `t`)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Issue one one-time code (to put in the QR).
 *
 * ⚠️ **Never written to a file** (read the notes at the top of this file).
 * ★ Expired entries are swept here as well (so they do not pile up).
 *   ⚠️ **The sweep is not a guard** (the decision rests on the expiry comparison in `consumeOneTime` itself).
 *   ⇒ Removing the sweep **never** changes the outcome (an equivalent mutation; the tests say so).
 */
export function issueOneTime(now = Date.now()): OneTime {
  oneTimes = oneTimes.filter((o) => o.expiresAtMs > now)
  for (const [id, s] of settled) if (s.untilMs <= now) settled.delete(id)
  const token = randomBytes(24).toString('base64url')
  const id = randomBytes(12).toString('base64url')
  const expiresAtMs = now + ONE_TIME_TTL_MS
  oneTimes.push({ bytes: new TextEncoder().encode(token), expiresAtMs, id })
  return { token, expiresAt: new Date(expiresAtMs).toISOString(), id }
}

/** Remember an outcome (⚠️ kept only for a one-time code's lifetime = pollers only exist during that window) */
function settle(id: string, result: Settled, now: number): void {
  settled.set(id, { result, untilMs: now + ONE_TIME_TTL_MS })
}

/**
 * ★★ Return the status of a one-time code (`GET /pair/token/:id`).
 * ⚠️ Unknown ids are `expired` (not distinguished from ones swept after expiry = both mean "no longer usable").
 */
export function oneTimeStatus(id: string, now = Date.now()): OneTimeStatus {
  const s = settled.get(id)
  if (s && s.untilMs > now) {
    const r = s.result
    if (r.kind === 'registered') return { state: 'registered', deviceKey: r.deviceKey, label: r.label, already: r.already }
    if (r.kind === 'failed') return { state: 'failed', reason: r.reason }
    if (r.kind === 'registering') return { state: 'registering' }
    return { state: 'cancelled' }
  }
  const o = oneTimes.find((x) => x.id === id)
  if (o && o.expiresAtMs > now) return { state: 'waiting', expiresAt: new Date(o.expiresAtMs).toISOString() }
  return { state: 'expired' }
}

/**
 * ★★ Cancel a one-time code (`POST /pair/token/:id/cancel` = Ctrl-C in `npm run pair`).
 * ⚠️⚠️ **Runs on the same serial queue as registration** (if a cancel slipped into the middle of "verify and consume",
 *    we would say "cancelled" while the registration still went through. One ordering means one of them wins first).
 * @returns whether it was cancelled (⚠️ false if already used or expired = never claim a false "cancelled")
 */
export async function cancelOneTime(id: string, now = Date.now()): Promise<boolean> {
  return await enqueue(async () => {
    const i = oneTimes.findIndex((o) => o.id === id && o.expiresAtMs > now)
    if (i < 0) return false
    oneTimes.splice(i, 1)
    settle(id, { kind: 'cancelled' }, now)
    console.log(t('[devices] ペアリングのワンタイムを取り消しました', '[devices] Cancelled the pairing one-time code'))
    return true
  })
}

/** Number currently valid (for diagnostics and tests) */
export function oneTimeCount(now = Date.now()): number {
  return oneTimes.filter((o) => o.expiresAtMs > now).length
}

/**
 * Use a one-time code. **It disappears on success (single use)**.
 *
 * ⚠️⚠️ Compared with `sameBytes` (neither length nor content leaks through timing / same reason as `sameSecret` in `auth.ts`).
 *    ⇒ **Do not revert** to a `Map` lookup or `===`.
 * ⚠️ **Do not stop scanning on a match** (do not leak through timing which entry matched).
 * ⚠️ A failure does not consume it (a QR dying from a typo or a network retry is merely bad UX,
 *    not the dangerous side).
 */
function consumeOneTime(token: string, now: number): string | undefined {
  if (!token) return undefined
  const want = new TextEncoder().encode(token)
  let hit = -1
  for (let i = 0; i < oneTimes.length; i++) {
    const o = oneTimes[i]!
    if (o.expiresAtMs > now && sameBytes(o.bytes, want)) hit = i
  }
  if (hit < 0) return undefined
  const [used] = oneTimes.splice(hit, 1)
  // ★ Return the id (to remember the outcome). ⚠️ Whether consumption succeeded is decided by this return value alone
  return used!.id
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration and revocation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register a device.
 *
 * ★★ **`token` is a required argument** (promoting a prose convention to an invariant / ARCHITECTURE §14.1.2.11).
 *   ⇒ **There is structurally no way to register without a one-time code.**
 *
 * ⚠️⚠️ The one-time code is **consumed before saving** (it burns even on failure).
 *   = If anything looks wrong, show a new QR. Never leave "what counts as one use" ambiguous.
 * ⚠️ If saving fails, it is not put in memory either (**never start accepting what could not be saved**).
 */
export async function registerDevice(
  publicRaw: Uint8Array,
  label: string,
  token: string,
  now = Date.now(),
): Promise<DeviceResult> {
  // ⚠️⚠️ **Copy at the entry point** (2026-09-01 codex round 4, low #1). The caller's buffer can be
  //    reused or overwritten during an `await` = the key we checked and the key we save would differ.
  const raw = new Uint8Array(publicRaw)
  const name = normalizeLabel(label)
  // ★★ **Close "check → update memory → save" into a single section** (autoApprove's codex high #1).
  //   ⚠️ Moving the check outside the section lets the ordering with `revokeDevice` flip depending on call timing.
  return await enqueue(async () => {
    if (state.kind !== 'ok') {
      return { ok: false, reason: t(`登録済みデバイスの記録が壊れています（${state.reason}）`, `The registered-device records are broken (${reasonText(state.reason)}).`) }
    }
    // ★★ **Verify it is usable as a key. This is the only "is it a key" check**.
    //   ⚠️ A length check used to sit in front of this, but **`importPublicKey` gives the same result**, so
    //      the mutation survived (measured 2026-09-07). ⇒ **No redundant guards**
    //      (a guard another one covers **cannot be killed by a test** / the autoApprove lesson in CLAUDE.md §2).
    //   ⚠️ The length check on the file side (`validDevice`) is different (there it is the only check, **to stay synchronous**).
    try {
      await importPublicKey(raw)
    } catch {
      return { ok: false, reason: t('公開鍵として読めません', 'The public key could not be read.') }
    }
    const id = consumeOneTime(token, now)
    if (id === undefined) {
      return { ok: false, reason: t('ペアリングのワンタイムが正しくありません（QR を出し直してください）', 'The pairing one-time code is not valid. Show a new QR code and try again.') }
    }
    // ★★ Record "registering" **in the same synchronous section** as consumption (⚠️ an await in between would answer `expired` in the gap)
    settle(id, { kind: 'registering' }, now)
    const key = toBase64Url(raw)
    const devices = state.devices
    const existing = devices.get(key)
    // ★ A duplicate registration is reported as success, but **`addedAt` is not rewritten** (do not overwrite the record)
    if (existing) {
      settle(id, { kind: 'registered', deviceKey: key, label: existing.label, already: true }, now)
      return { ok: true, device: existing, already: true }
    }

    const device: Device = { key, label: name, addedAt: new Date(now).toISOString() }
    // ★★ Save first (never start accepting what could not be saved)
    const saved = await writeState([...devices.values(), device])
    if (!saved.ok) {
      // ⚠️ The one-time code has burned (it is consumed before saving) ⇒ report "failed" (do not leave the poller waiting silently)
      settle(id, { kind: 'failed', reason: saved.reason }, now)
      return { ok: false, reason: saved.reason, saved: false }
    }
    devices.set(key, device)
    settle(id, { kind: 'registered', deviceKey: key, label: device.label, already: false }, now)
    console.log(
      t(
        `[devices] デバイスを登録: ${key.slice(0, 8)}… (${device.label || '名前なし'})`,
        `[devices] Registered device: ${key.slice(0, 8)}… (${device.label || 'unnamed'})`,
      ),
    )
    return { ok: true, device }
  })
}

/**
 * Revoke a registration (from the PC side).
 *
 * ★ Same direction as turning auto-approve "off": **drop from memory first, save afterwards**
 *   (stop without waiting on a possible save failure).
 * ⚠️⚠️ If saving fails, **say so** (`saved: false`). The old row stays in the file, so
 *   restarting the agent **revives it**. ⇒ The UI shows this as is. Never make it look like success.
 */
export async function revokeDevice(key: string): Promise<DeviceResult> {
  return await enqueue(async () => {
    if (state.kind !== 'ok') {
      return { ok: false, reason: t(`登録済みデバイスの記録が壊れています（${state.reason}）`, `The registered-device records are broken (${reasonText(state.reason)}).`) }
    }
    const devices = state.devices
    const had = devices.delete(key)
    if (!had) return { ok: false, reason: t('そのデバイスは登録されていません', 'That device is not registered.') }
    const saved = await writeState([...devices.values()])
    if (!saved.ok) return { ok: false, reason: saved.reason, saved: false }
    console.log(t(`[devices] デバイスを失効: ${key.slice(0, 8)}…`, `[devices] Revoked device: ${key.slice(0, 8)}…`))
    return { ok: true }
  })
}

/**
 * ★ Labels are **normalized at the entry point** (they are external strings).
 *
 * ⚠️ Strip control characters (no raw control characters in logs or files / CLAUDE.md §5).
 * ⚠️ Never used for any decision, so truncation has no security effect (display only).
 */
function normalizeLabel(label: string): string {
  // eslint-disable-next-line no-control-regex
  return label.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '').trim().slice(0, MAX_LABEL)
}

/**
 * ★★ **Serialize registration and revocation onto one queue**.
 *
 * ⚠️⚠️ **Serializing only the writes is not enough** (same as the autoApprove notes).
 *    Enqueue the **whole "check → update memory → save" section**.
 * ⚠️ Never call `enqueue` from inside `enqueue` (it would wait on itself and hang).
 */
let chain: Promise<unknown> = Promise.resolve()

function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const run = chain.then(op)
  // ⚠️ A failure must not stall what follows (`chain` is only responsible for ordering)
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** Write the state file. ⚠️ **Call only inside `enqueue`** (calling from outside breaks ordering). */
async function writeState(devices: Device[]): Promise<{ ok: true } | { ok: false; reason: string }> {
  const stored: Stored = { v: 1, devices }
  try {
    await writeJson(DEVICES_FILE, stored)
    return { ok: true }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.warn(t(`[devices] 登録済みデバイスの保存に失敗: ${detail}`, `[devices] Failed to save the registered devices: ${detail}`))
    // ⚠️ Expose only the category (absolute paths go to the log / CLAUDE.md §2)
    return { ok: false, reason: t('保存に失敗しました', 'Saving failed.') }
  }
}

/** For tests (★ a stateful module, handled the same way as `resetAutoApprove`) */
export function resetDevices(): void {
  state = { kind: 'ok', devices: new Map() }
  oneTimes = []
  settled.clear()
  chain = Promise.resolve()
}
