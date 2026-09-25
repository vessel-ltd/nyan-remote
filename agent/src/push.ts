// Sending Web Push. Kept confined to this one file.
//
// Why web-push (the only exception to CLAUDE.md §2):
//   Implementing RFC 8291 crypto (ECDH P-256 + HKDF-SHA256 + AES-128-GCM) and VAPID ES256 signatures
//   ourselves invites accidents. But be aware of the cost: it adds 17 dependencies.
//
// Room to replace it: sending goes only through sendToAll(). node:crypto has every primitive
// (createECDH / hkdfSync / createCipheriv / createSign), and RFC 8291 has public test vectors,
// so it can later be replaced by ~120 lines of our own. Even then, only this file changes.
//
// Key design points (ARCHITECTURE.md §6):
//   - Payloads are E2E encrypted with per-subscription keys. The delivery network (Google for Chrome) cannot read them
//   - VAPID keys are generated per installation. The distribution origin holds no keys
//   - Each machine sends only its own events, so duplicates cannot occur structurally

import { asLang, localizeNotificationBody, t, type Lang } from '../../shared/i18n.ts'
import { reasonText } from './reasons.ts'
import webpush from 'web-push'
import type { PushFailure, PushPayload } from '../../shared/types.ts'
import { readJsonFile, statePath, writeJson } from './state.ts'

const VAPID_FILE = 'vapid.json'
const SUBS_FILE = 'subscriptions.json'
const TTL_SEC = 3600
/** Upper bound on waiting for one send, so an endpoint that never responds cannot drag us along */
const SEND_TIMEOUT_MS = 10_000
/** Concurrent sends. Do not open them all at once even as devices increase */
const SEND_CONCURRENCY = 4

interface Vapid {
  publicKey: string
  privateKey: string
  subject: string
}

export interface StoredSubscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
  /**
   * Which device (`Identity.deviceId`). ⚠️ **The content depends on the identity kind** (`via`):
   *   `device` = fingerprint of the device key (differs per browser) / `tailscale` = source IP (same for other browsers on the same device)
   */
  deviceId: string
  login: string
  userAgent?: string
  createdAt: string
  /**
   * ★★ The kind of identity that registered it (`Identity.via` / 2026-09-23 / codex round 14, medium #2).
   * ⚠️ Missing = a record from before this field was added.
   */
  via?: string
  /**
   * ★★ Notification language (2026-09-23 / `shared/i18n.ts`). **The request language** at registration (= the phone's UI language).
   * ⚠️ Missing = a record from before this field was added ⇒ Japanese (as before).
   */
  lang?: Lang
}

/**
 * ★★ **Whether this subscription's `deviceId` points to "one browser"** (2026-09-23 / codex round 14, medium #2).
 *
 * ⚠️⚠️ The rule "only one subscription per device" exists in **two places** (`addSubscription` at registration and
 *    `newestPerDevice` when sending). Both assumed "identity = one browser".
 *    - `device` (device key fingerprint) … differs per browser (origin × profile) ⇒ **safe to collapse**
 *      (its job is to clean up the old endpoint when the same browser re-subscribes)
 *    - `tailscale` (source IP) … **the same value for other browsers on the same device** ⇒ collapsing makes them **fight over the subscription**
 *      (once round 13 made the decision precise with "this subscription's marker", they were seen re-sending to each other on every sync)
 * ⇒ **Collapse only `device`**. ⚠️ Old records without `via` are not collapsed
 *    (old `device` records are cleaned up by `addSubscription` the next time the same browser registers).
 * ⚠️⚠️ Do not "stop the fighting by reverting `registered` to 'any one of them'" here
 *    = the **pendulum** back to round 13 high #3 (deleting old subscriptions too). Fix the foundation, not the decision.
 * ⚠️ The decision lives in **this one place** (in two places, registration and sending would treat it differently).
 */
export function oneBrowserPerDevice(s: { via?: string }): boolean {
  return s.via === 'device'
}

interface SubsFile {
  subscriptions: StoredSubscription[]
}

/**
 * ★★ Remember **send failures that are not cleaned up** (2026-08-21).
 *
 * Why: 404 / 410 delete the subscription, so "no notifications" is noticeable. But **403 does not delete it**,
 * so `/push/status` keeps saying "subscribed". In practice it **failed 171 times on the iPhone, every day,
 * unnoticed for 3 days** (the VAPID subject was the cause).
 *
 * ⚠️ Not written to a file. **Do not add "state needing a single writer" to the server** (CLAUDE.md).
 *    It is lost on restart, but a failure always recurs on the next send, which is enough for "noticing".
 * ⚠️ Only the classification is kept (status code and time). **No bodies or raw error strings** (§6.2).
 */
const lastFailures = new Map<string, PushFailure>()

let vapidCache: Vapid | null = null
/**
 * ⚠️ Serialize generation (2026-08-14 review, low).
 *    On first start, if `/push/status` and `/hook` arrive almost simultaneously, **keys are generated twice**
 *    and memory and disk disagree. Subscriptions registered during that run then get 403 after a restart,
 *    which is not 404/410 so they are never cleaned up, leaving **notifications failing for no apparent reason**.
 */
let vapidInFlight: Promise<Vapid> | null = null

/**
 * ★★ The key file is unusable (2026-09-24 / codex round 17, low #4).
 * ⚠️⚠️ **Build the text when it is read** (`message` is a getter). Loading is shared with concurrent requests
 *    via `vapidInFlight`, so translating at creation would return **the first request's language** to later requests too
 *    (a Japanese 503 to an English request that arrived while a Japanese request was loading).
 *    ⇒ The exception carries only the classification, translated when `orExplain` turns it into a body (= that request's language).
 */
class VapidFileError extends Error {
  readonly kind: 'broken' | 'incomplete'
  readonly reason: string
  constructor(kind: 'broken' | 'incomplete', reason: string) {
    super()
    this.name = 'VapidFileError'
    this.kind = kind
    this.reason = reason
  }
  override get message(): string {
    if (this.kind === 'broken') {
      return t(
        `VAPID 鍵のファイルが読めません（${this.reason}）: ${VAPID_FILE} — ` +
          '作り直すと既存の購読が全部無効になるため、生成せずに中断しました。' +
          'ファイルを直すか、退避してから購読をやり直してください',
        `The VAPID key file cannot be read (${reasonText(this.reason)}): ${VAPID_FILE} — ` +
          'Stopped without generating a new key, because recreating it would invalidate every existing subscription. ' +
          'Fix the file, or move it aside and subscribe again.',
      )
    }
    return t(
      `VAPID 鍵のファイルが欠けています: ${VAPID_FILE} — ` +
        '作り直すと既存の購読が全部無効になるため、生成せずに中断しました。' +
        '中身を直すか、退避してから購読をやり直してください',
      `The VAPID key file is incomplete: ${VAPID_FILE} — ` +
        'Stopped without generating a new key, because recreating it would invalidate every existing subscription. ' +
        'Fix its contents, or move it aside and subscribe again.',
    )
  }
}

export async function ensureVapid(): Promise<Vapid> {
  if (vapidCache) return vapidCache
  if (vapidInFlight) return vapidInFlight
  vapidInFlight = loadOrCreateVapid().finally(() => {
    vapidInFlight = null
  })
  return vapidInFlight
}

/** For tests. Keeps module variables from leaking across tests */
export function resetVapidCacheForTest(): void {
  vapidCache = null
  vapidInFlight = null
  warnedBrokenSubs = false
  brokenSubsReason = undefined
}

async function loadOrCreateVapid(): Promise<Vapid> {
  const read = await readJsonFile<Partial<Vapid>>(VAPID_FILE)
  // ★★ If it cannot be read, **do not recreate it** (2026-08-13 fail-open fix).
  //
  // ⚠️ Generating a new key here **overwrites it via `writeJson`, killing every existing subscription**.
  //    Keys cannot be recovered, so one startup would create "notifications never arrive again".
  //    Throwing makes /push/* return 500 with the reason on screen (other features keep working)
  if (read.kind === 'broken') {
    // ⚠️⚠️ **Never put absolute paths in text returned outside** (2026-09-23 / CLAUDE.md §2 "no details in outgoing text").
    //    This exception becomes the body of the `/push/*` 503 ⇒ return only the name; the location goes to the log (same split as reason / detail in `state.ts`).
    console.error(
      t(
        `[push] VAPID 鍵のファイルが読めません（${read.reason}）: ${statePath(VAPID_FILE)}`,
        `[push] Cannot read the VAPID key file (${reasonText(read.reason)}): ${statePath(VAPID_FILE)}`,
      ),
    )
    throw new VapidFileError('broken', read.reason)
  }
  if (read.kind === 'ok') {
    const stored = read.value
    // ★★ **Do not overwrite a file with only one half left** (2026-08-14 external review, high).
    //
    // ⚠️ It used to proceed to generation if `publicKey && privateKey` was false. That is,
    //    **a file with only one half left, like `{"privateKey":"…"}`, was crushed by new keys**.
    //    The private key cannot be recovered, so even restoring from another machine's copy or leftovers became impossible.
    //    **Generate only when the file is "absent".**
    if (!stored.publicKey || !stored.privateKey) {
      // ⚠️ location goes to the log (outgoing text gets only the name / same as above)
      console.error(t(`[push] VAPID 鍵のファイルが欠けています: ${statePath(VAPID_FILE)}`, `[push] The VAPID key file is incomplete: ${statePath(VAPID_FILE)}`))
      throw new VapidFileError('incomplete', '')
    }
    // ★★ **Fix an unusable `subject`** (found by measurement on 2026-08-21).
    //
    // ⚠️⚠️ The default was `mailto:nyan-remote@localhost`, so **Apple rejected everything with 403 BadJwtToken**.
    //    With the same key and only the subject changed it passed with 201, so the subject alone was the cause.
    //    FCM is lenient, so Android received them, giving the shape **"only the iPhone never receives anything"**
    //    (171 times a day in machine A's journal. Not 404/410, so subscriptions were not cleaned up either and nobody noticed).
    //
    // ⚠️ Never touch the keys. Rewrite **only `subject`** (recreating keys kills every subscription).
    const storedSubject = typeof stored.subject === 'string' ? stored.subject.trim() : ''
    const subject = isUsableSubject(storedSubject) ? storedSubject : defaultSubject()
    vapidCache = {
      publicKey: stored.publicKey,
      privateKey: stored.privateKey,
      subject,
    }
    if (subject !== storedSubject) {
      await repairSubject(vapidCache, storedSubject)
    }
    return vapidCache
  }
  const generated = webpush.generateVAPIDKeys()
  const made: Vapid = {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
    subject: defaultSubject(),
  }
  // ⚠️ private key. Written with 600 (writeJson's default). Never committed (.gitignore)
  await writeJson(VAPID_FILE, made, 0o600)
  console.log(t('[push] VAPID 鍵を生成しました（このインストール専用）', '[push] Generated VAPID keys (for this installation only)'))
  await dropSubscriptionsOfLostKey()
  // ★★ **Publish only after cleanup finishes** (codex round 18, medium #3).
  //   ⚠️⚠️ Putting it in `vapidCache` first let another request see it and **register a subscription with the new key**,
  //      and then cleanup **deleted that subscription too** (reproduced). Requests before publication wait on `vapidInFlight`.
  vapidCache = made
  return vapidCache
}

/**
 * ★★ RFC 8292 `sub`. **Apple is strict about this** (measured 2026-08-21).
 *
 * ⚠️⚠️ The old default was `mailto:nyan-remote@localhost`, intended as "do not expose more information".
 *    But Apple rejects it with **403 `{"reason":"BadJwtToken"}`**. With the same key, changing the subject to
 *    `https://example.com/tmux-agent` passed with **201** (= the subject alone was the cause).
 *
 * ⚠️ **Do not put the user's email address or your own host name here**.
 *    `sub` is passed to Apple / Google servers (not to devices, and not shown in notifications), but
 *    there is no reason to hand out information that is not needed. **Anyone who wants to change it can override it with an environment variable.**
 */
function defaultSubject(): string {
  const fromEnv = process.env.NYAN_REMOTE_VAPID_SUBJECT?.trim()
  // ★ validate the environment variable too. Adopting a broken value as is **gets everything rejected by Apple again**
  if (fromEnv) {
    if (isUsableSubject(fromEnv)) return fromEnv
    console.warn(
      t(
        `[push] NYAN_REMOTE_VAPID_SUBJECT が使えない形なので既定値を使います（mailto:… か https://… で、` +
          'ホスト名にドットが必要です）',
        '[push] NYAN_REMOTE_VAPID_SUBJECT has an unusable form, so the default is used (it must be mailto:… or https://… ' +
          'with a dot in the host name)',
      ),
    )
  }
  return 'https://example.com/tmux-agent'
}

/**
 * ★ Whether it is a form push services accept as `sub`.
 *
 * ⚠️ **Do not confuse "readable" with "correct"** (CLAUDE.md). `mailto:x@localhost` is
 *    readable as a string, but Apple rejects it. **The host name needs a dot** — that is the real dividing line.
 */
export function isUsableSubject(subject: unknown): boolean {
  if (typeof subject !== 'string') return false
  const s = subject.trim()
  if (s.startsWith('mailto:')) {
    const addr = s.slice('mailto:'.length)
    const at = addr.lastIndexOf('@')
    if (at <= 0) return false
    const host = addr.slice(at + 1)
    return isPublicishHost(host)
  }
  if (s.startsWith('https://')) {
    try {
      return isPublicishHost(new URL(s).hostname)
    } catch {
      return false
    }
  }
  return false
}

function isPublicishHost(host: string): boolean {
  if (!host.includes('.')) return false
  // a trailing dot alone or an empty label is not allowed
  if (host.startsWith('.') || host.endsWith('.')) return false
  return !/\s/.test(host)
}

/**
 * ★ Rewrites only `subject` (keeps the keys).
 *
 * ⚠️⚠️ **After writing, read it back and confirm the keys did not change** (CLAUDE.md
 *    "do not confuse readable with correct"). The private key cannot be recovered, so this one place is verified.
 * ⚠️ **Continue even if it cannot be written** (it is fixed in memory, so notifications arrive; it is fixed again next start).
 */
async function repairSubject(vapid: Vapid, before: string): Promise<void> {
  try {
    await writeJson(VAPID_FILE, vapid, 0o600)
    const back = await readJsonFile<Partial<Vapid>>(VAPID_FILE)
    if (
      back.kind !== 'ok' ||
      back.value.publicKey !== vapid.publicKey ||
      back.value.privateKey !== vapid.privateKey
    ) {
      // ⚠️ reaching here means the key is about to break. **Do not print the contents** (it is a private key)
      console.error(
        t(
          `[push] ⚠️ VAPID の subject を直したあとの検証に失敗しました: ${statePath(VAPID_FILE)} — ` +
            '鍵が一致しません。手で中身を確認してください',
          `[push] ⚠️ Verification failed after fixing the VAPID subject: ${statePath(VAPID_FILE)} — ` +
            'the keys do not match. Check the contents by hand',
        ),
      )
      return
    }
    console.log(
      t(
        `[push] VAPID の subject を直しました（${before || '(無し)'} → ${vapid.subject}）。` +
          'Apple は無効な subject を 403 で弾くため',
        `[push] Fixed the VAPID subject (${before || '(none)'} → ${vapid.subject}), ` +
          'because Apple rejects an invalid subject with 403',
      ),
    )
  } catch (err) {
    console.warn(
      t(
        `[push] VAPID の subject を書き直せませんでした（送信自体はこの起動では直っています）: `,
        `[push] Could not rewrite the VAPID subject (sending already works for this run): `,
      ) + (err instanceof Error ? err.message : String(err)),
    )
  }
}

export async function publicKey(): Promise<string> {
  return (await ensureVapid()).publicKey
}

let warnedBrokenSubs = false
/** Why the subscription file cannot be read (included in send results and shown on screen) */
let brokenSubsReason: string | undefined

/**
 * List of subscriptions (read-only).
 * ⚠️ Returns empty even if broken (gives up sending but does not stop other features). **The writing side throws** (below)
 */
export async function listSubscriptions(): Promise<StoredSubscription[]> {
  const read = await readJsonFile<SubsFile>(SUBS_FILE)
  if (read.kind === 'broken') {
    brokenSubsReason = t(`購読ファイルが読めません（${read.reason}）`, `The subscription file cannot be read (${reasonText(read.reason)}).`)
    if (!warnedBrokenSubs) {
      warnedBrokenSubs = true
      console.error(
        t(
          `[push] ⚠️ 購読ファイルが読めません（${read.reason}）: ${statePath(SUBS_FILE)} — ` +
            '通知は送れません。上書きして失わないよう、登録・削除も拒否します',
          `[push] ⚠️ Cannot read the subscription file (${reasonText(read.reason)}): ${statePath(SUBS_FILE)} — ` +
            'notifications cannot be sent. Registering and removing are refused too, so nothing is overwritten and lost',
        ),
      )
    }
    return []
  }
  brokenSubsReason = undefined
  const file = read.kind === 'ok' ? read.value : { subscriptions: [] }
  return Array.isArray(file.subscriptions) ? file.subscriptions : []
}

/**
 * Read before updating.
 *
 * ★ Throws if broken. It is read → modify → write, so **reading a broken file as empty means
 *   the next write deletes every subscription** (2026-08-13 fail-open fix).
 *   Throwing makes /push/subscribe return 500 with the reason on screen (nothing disappears silently).
 */
async function subscriptionsForWrite(): Promise<StoredSubscription[]> {
  const read = await readJsonFile<SubsFile>(SUBS_FILE)
  if (read.kind === 'broken') {
    // ⚠️ location goes to the log (outgoing text gets only the name / same as `loadOrCreateVapid`)
    console.error(
      t(
        `[push] 購読ファイルが読めないため更新しません（${read.reason}）: ${statePath(SUBS_FILE)}`,
        `[push] Not updating because the subscription file cannot be read (${reasonText(read.reason)}): ${statePath(SUBS_FILE)}`,
      ),
    )
    throw new Error(
      t(`購読ファイルが読めないため更新しません（${read.reason}）: ${SUBS_FILE}`, `Not updating because the subscription file cannot be read (${reasonText(read.reason)}): ${SUBS_FILE}`),
    )
  }
  if (read.kind === 'missing') return []
  // ⚠️ **Do not overwrite a file whose `subscriptions` is not an array as "empty"**
  //    (2026-08-14 external review, medium). Even if it reads as JSON,
  //    a shape like `{"subscriptions":{"0":{…}}}` means **the contents are alive**.
  //    Writing it back as empty loses subscriptions that could have been recovered, and notifications silently stop.
  if (!Array.isArray(read.value.subscriptions)) {
    console.error(
      t(
        `[push] 購読ファイルの形が壊れているため更新しません（subscriptions が配列ではない）: ${statePath(SUBS_FILE)}`,
        `[push] Not updating because the subscription file is malformed (subscriptions is not an array): ${statePath(SUBS_FILE)}`,
      ),
    )
    throw new Error(
      t(`購読ファイルの形が壊れているため更新しません（subscriptions が配列ではない）: ${SUBS_FILE}`, `Not updating because the subscription file is malformed (subscriptions is not an array): ${SUBS_FILE}`),
    )
  }
  return read.value.subscriptions
}

async function saveSubscriptions(list: StoredSubscription[]): Promise<void> {
  await writeJson(SUBS_FILE, { subscriptions: list }, 0o600)
}

/**
 * Serializes updates to the subscription file.
 *
 * ⚠️⚠️ Without this, subscriptions are lost. Every update is read → modify → write, so if another request
 *      cuts in, the later write rolls back the earlier change (atomic writes via rename cannot prevent it).
 *      The PWA **re-registers with every agent** at startup, so concurrent registration is normal, not exceptional.
 *      On 2026-08-12 a subscription was actually lost and notifications stopped (right after `total=2` it dropped to 1).
 */
let subsWriteChain: Promise<unknown> = Promise.resolve()
function serializeSubsWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = subsWriteChain.then(fn, fn)
  // a failure does not stop the ones after it (subscription updates are independent)
  subsWriteChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

const MAX_SUBSCRIPTIONS = 32
const MAX_ENDPOINT_CHARS = 512
const B64URL = /^[A-Za-z0-9_-]+=*$/

/**
 * Validates whether a subscription can be registered.
 *
 * ⚠️ If this is loose, two real harms follow (found in the 2026-08-12 review):
 *   1. **The send path hangs / blind SSRF**: if `https://attacker.example/hold` is registered,
 *      the agent POSTs there on every notification, and sending never finishes unless the other side responds
 *   2. **Unbounded file growth**: changing the endpoint every time stores every entry even for the same device
 *
 * ★ Hosts are restricted by an allowlist.
 *   At first it only checked "https, no port, not an IP", and **`https://attacker.example/hold`
 *   went straight through** (my own test let it through). Push endpoints are
 *   fixed browser-vendor hosts, so an allowlist works.
 *   ⚠️ An unknown browser cannot register, but **a 400 gives the reason**, so it does not break silently.
 *   Escape hatch: `NYAN_REMOTE_PUSH_HOSTS` (comma-separated; a leading `.` means "under that domain")
 */
const DEFAULT_PUSH_HOSTS = [
  'fcm.googleapis.com', // Chrome / Chromium / Brave / Edge(Chromium)
  'updates.push.services.mozilla.com', // Firefox
  'web.push.apple.com', // Safari / iOS
  '.notify.windows.com', // Windows (WNS)
  '.push.apple.com', // Apple's other hosts
]

function allowedPushHosts(): string[] {
  const raw = process.env.NYAN_REMOTE_PUSH_HOSTS
  if (!raw) return DEFAULT_PUSH_HOSTS
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

/** Whether the host is allowed. Entries starting with `.` allow "under that domain" (checked at dot boundaries) */
export function isAllowedPushHost(host: string, hosts: string[] = allowedPushHosts()): boolean {
  const h = host.toLowerCase()
  return hosts.some((allowed) =>
    allowed.startsWith('.') ? h.endsWith(allowed) : h === allowed,
  )
}
export function validateSubscription(endpoint: string, p256dh: string, auth: string): string | null {
  if (endpoint.length > MAX_ENDPOINT_CHARS) return t('endpoint が長すぎます', 'The endpoint is too long.')
  let u: URL
  try {
    u = new URL(endpoint)
  } catch {
    return t('endpoint が URL ではありません', 'The endpoint is not a URL.')
  }
  if (u.protocol !== 'https:') return t('endpoint は https でなければなりません', 'The endpoint must use https.')
  if (u.port) return t('endpoint にポートは指定できません', 'The endpoint must not include a port.')
  const host = u.hostname.toLowerCase()
  // IP literals (v4 / v6) cannot be a push service
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || host.includes(':')) {
    return t('endpoint に IP は使えません', 'The endpoint must not be an IP address.')
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return t('endpoint にローカル名は使えません', 'The endpoint must not be a local name.')
  }
  if (!host.includes('.')) return t('endpoint のホスト名が不正です', 'The endpoint host name is invalid.')
  if (!isAllowedPushHost(host)) {
    return t(`endpoint のホストが許可されていません（${host}）。NYAN_REMOTE_PUSH_HOSTS で追加できます`, `The endpoint host is not allowed (${host}). You can add it with NYAN_REMOTE_PUSH_HOSTS.`)
  }
  // p256dh is 65 bytes (86–88 chars in base64url), auth is 16 bytes (21–24 chars)
  if (!B64URL.test(p256dh) || p256dh.length < 80 || p256dh.length > 92) return t('keys.p256dh が不正です', 'keys.p256dh is invalid.')
  if (!B64URL.test(auth) || auth.length < 16 || auth.length > 32) return t('keys.auth が不正です', 'keys.auth is invalid.')
  return null
}

/**
 * Unique by endpoint. If the same device re-subscribes, it is overwritten (last-write-wins / §6.4)
 *
 * ★ Old entries with the same deviceId are removed too. `newestPerDevice` **only collapses at send time**, so
 *   without this, changing only the endpoint could grow the file without bound.
 *   A device could only ever receive notifications through one of them, so removing them does not change delivery.
 */
export async function addSubscription(sub: StoredSubscription): Promise<number> {
  return serializeSubsWrite(async () => {
    // ⚠️ collapse only when the identity points to "one browser" (`oneBrowserPerDevice`)
    const sameDevice = (s: StoredSubscription): boolean =>
      oneBrowserPerDevice(sub) && Boolean(sub.deviceId) && sub.deviceId !== 'unknown' && s.deviceId === sub.deviceId
    const list = (await subscriptionsForWrite()).filter(
      (s) => s.endpoint !== sub.endpoint && !sameDevice(s),
    )
    list.push(sub)
    // over the limit, drop the oldest (no point keeping an unbounded number)
    const trimmed =
      list.length > MAX_SUBSCRIPTIONS
        ? [...list]
            .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
            .slice(-MAX_SUBSCRIPTIONS)
        : list
    await saveSubscriptions(trimmed)
    return trimmed.length
  })
}

export async function removeSubscription(endpoint: string): Promise<void> {
  return serializeSubsWrite(async () => {
    const list = await subscriptionsForWrite()
    const next = list.filter((s) => s.endpoint !== endpoint)
    if (next.length !== list.length) await saveSubscriptions(next)
  })
}

/**
 * ★★ **Drop the subscriptions of a revoked device** (2026-09-21 / needed for consolidating on the public origin).
 *
 * ⚠️⚠️ **Without this they stay forever.** Unused subscriptions
 *    are **not caught** by the automatic "delete on 404/410" cleanup —
 *    **FCM returns 201 even for dead endpoints** (measured 2026-08-21 / CLAUDE.md §2).
 *    ⇒ One wasted send per notification, the count in `/push/status` **looks higher than reality**,
 *      and when investigating "the second device gets no notifications" **they cannot be told apart from real subscriptions**.
 * ★ Only at the moment a device is revoked can we drop them from our side (safe, since the device can no longer connect).
 *
 * ⚠️ `deviceId` is **the device key fingerprint** (the value `acceptHandshake` returns, also stored in subscriptions).
 *    ⇒ Callers must not rebuild the fingerprint (§14.1.2.14 "do not take identity from a separate path").
 * ★ Returns the number dropped (the caller logs it = **even 0 is visible**).
 */
export async function removeSubscriptionsFor(deviceId: string): Promise<number> {
  return serializeSubsWrite(async () => {
    const list = await subscriptionsForWrite()
    const next = list.filter((s) => s.deviceId !== deviceId)
    if (next.length !== list.length) await saveSubscriptions(next)
    return list.length - next.length
  })
}

/**
 * ★★ The key file is missing but subscriptions remain = **the key was lost** (2026-09-24 / user decision: no backups).
 * The remaining subscriptions are **bound to the old key**, so not one more will arrive (Apple / FCM reject with 403; not 404/410,
 * so automatic cleanup does not catch them). ⇒ Delete them and log the count and reason.
 * ★ The phone side **notices the key changed and re-registers by itself** the next time it opens (`planPush` in `web/src/ui/pushScopes.ts`).
 * ⚠️ Do not touch it if the subscription file cannot be read (keep the evidence / same safeguard as subscription writes).
 */
async function dropSubscriptionsOfLostKey(): Promise<void> {
  try {
    const dropped = await serializeSubsWrite(async () => {
      const list = await subscriptionsForWrite()
      if (list.length > 0) await saveSubscriptions([])
      return list.length
    })
    if (dropped > 0) {
      console.warn(
        t(
          `[push] ⚠️⚠️ VAPID 鍵のファイルが無いのに購読が ${dropped} 件 残っていました（鍵を失った）。` +
            '旧い鍵の購読はもう届かないので消しました。スマホはアプリを開くと自動で登録し直します',
          `[push] ⚠️⚠️ ${dropped} subscriptions remained although the VAPID key file was missing (the key was lost). ` +
            'Subscriptions for the old key can no longer be delivered, so they were removed. The phone re-registers automatically when the app is opened',
        ),
      )
    }
  } catch (err) {
    console.error(
      t('[push] 旧い鍵の購読を消せませんでした（そのまま残します）: ', '[push] Could not remove subscriptions for the old key (leaving them): ') +
        (err instanceof Error ? err.message : String(err)),
    )
  }
}

export async function hasSubscriptionFor(deviceId: string): Promise<boolean> {
  return (await listSubscriptions()).some((s) => s.deviceId === deviceId)
}

export interface SendResult {
  sent: number
  pruned: number
  failed: number
  /** ★ Why it could not send (subscription file unreadable etc.). Absent means normal */
  unavailable?: string
}

/**
 * When a device has several subscriptions, keep only the newest.
 *
 * ⚠️ Without this, notifications arrive twice. Each machine's agent serves the PWA, so there are several URLs,
 *    and if the user installs from two origins **the same device gets two subscriptions**
 *    (each origin counts as a separate app, so replacement by notification tag does not work either).
 *    Devices are identified by deviceId (tailnet IP / §5), so they can be collapsed by it.
 */
export function newestPerDevice(subs: StoredSubscription[]): StoredSubscription[] {
  const byDevice = new Map<string, StoredSubscription>()
  const out: StoredSubscription[] = []
  for (const s of subs) {
    // entries without a deviceId, and **identities that do not point to one browser**, are sent as is without collapsing (`oneBrowserPerDevice`)
    if (!s.deviceId || s.deviceId === 'unknown' || !oneBrowserPerDevice(s)) {
      out.push(s)
      continue
    }
    const cur = byDevice.get(s.deviceId)
    if (!cur || (s.createdAt ?? '') > (cur.createdAt ?? '')) byDevice.set(s.deviceId, s)
  }
  return [...out, ...byDevice.values()]
}

/**
 * The function that actually pushes. **A seam only so tests can replace it** (same shape as `StopPushDeps`).
 *
 * ⚠️ Without it the 403 record cannot be tested **through the implementation's path**, only via hand-made values (false green).
 *    No test really sends to the network (slow, goes outside).
 */
export type PushSender = (
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  body: string,
) => Promise<unknown>

/** Sends to every registered device. Cleans up expired subscriptions (404/410). */
export async function sendToAll(payload: PushPayload, sender?: PushSender): Promise<SendResult> {
  const subs = newestPerDevice(await listSubscriptions())
  // ★ do not mix "no recipients" with "cannot send because unreadable" (2026-08-14 review, low).
  //   mixing them makes a stoppage from the moment of breakage look like a `{sent:0}` success
  if (subs.length === 0) return { sent: 0, pruned: 0, failed: 0, unavailable: brokenSubsReason }

  const vapid = await ensureVapid()
  // ★★ **Send in each subscription's language** (2026-09-23). Only the fixed words of the body (line 2) are translated; line 1 (title) stays as is.
  //   ⚠️ Decisions (dedup, whether to ring) were already made on the Japanese text ⇒ only **the appearance** changes here.
  // ⚠️ the record's `lang` goes through `asLang` (so a hand-written or broken value never sends **a notification without a body**)
  const bodies: Record<Lang, string> = {
    ja: JSON.stringify(payload),
    en: JSON.stringify({ ...payload, body: localizeNotificationBody(payload.body, 'en') }),
  }
  const dead: string[] = []
  let sent = 0
  let failed = 0

  // limit concurrency (do not open connections all at once even as devices increase)
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const s = subs[cursor++]
      if (!s) return
      await send(s)
    }
  }
  const send = async (s: StoredSubscription): Promise<void> => {
    {
      try {
        if (sender) {
          await sender({ endpoint: s.endpoint, keys: s.keys }, bodies[asLang(s.lang) ?? 'ja'])
          sent++
          lastFailures.delete(s.endpoint)
          return
        }
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: s.keys },
          bodies[asLang(s.lang) ?? 'ja'],
          {
            vapidDetails: {
              subject: vapid.subject,
              publicKey: vapid.publicKey,
              privateKey: vapid.privateKey,
            },
            TTL: TTL_SEC,
            urgency: 'high',
            // ⚠️ without this, one endpoint that never responds keeps sending from ever finishing.
            //    Together with registration validation (validateSubscription) it is guarded twice
            timeout: SEND_TIMEOUT_MS,
          },
        )
        sent++
        // ★ clear the warning once it recovers (showing it forever hides real failures)
        lastFailures.delete(s.endpoint)
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) {
          dead.push(s.endpoint)
          lastFailures.delete(s.endpoint)
        } else {
          failed++
          // ★ remember only failures that are not cleaned up (403 VAPID mismatch, invalid subject, etc.)
          lastFailures.set(s.endpoint, { at: new Date().toISOString(), status: status ?? null })
          const where = typeof s.endpoint === 'string' ? s.endpoint.slice(0, 60) : t('(不正な endpoint)', '(invalid endpoint)')
          console.warn(t(`[push] 送信失敗 (${status ?? '?'}) ${where}…`, `[push] Send failed (${status ?? '?'}) ${where}…`))
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, subs.length) }, () => worker()))

  if (dead.length > 0) {
    // ride the same chain as registration (so cleanup does not roll back a registration)
    try {
      await serializeSubsWrite(async () => {
        const list = (await subscriptionsForWrite()).filter((s) => !dead.includes(s.endpoint))
        await saveSubscriptions(list)
      })
      console.log(t(`[push] 失効した購読を ${dead.length} 件削除しました`, `[push] Removed ${dead.length} expired subscriptions`))
    } catch (err) {
      // ⚠️ sending itself is done. A cleanup failure must not make /hook 500 (the status display would stop)
      console.warn(
        t('[push] 失効した購読の掃除に失敗: ', '[push] Failed to clean up expired subscriptions: ') + (err instanceof Error ? err.message : String(err)),
      )
    }
  }
  // ⚠️ drop records for endpoints not in the subscriptions (so the Map does not grow without limit)
  const alive = new Set(subs.map((s) => s.endpoint))
  for (const endpoint of lastFailures.keys()) {
    if (!alive.has(endpoint)) lastFailures.delete(endpoint)
  }
  return { sent, pruned: dead.length, failed }
}

/**
 * ★ Returns **the newest failure** among this device's (`deviceId`) subscriptions.
 *
 * ⚠️ A device can have several subscriptions (per origin), so only that device's are considered.
 *    Do not turn other devices' failures into a warning on this screen (it would look broken although its own notifications arrive).
 */
export async function lastFailureForDevice(deviceId: string): Promise<PushFailure | undefined> {
  if (lastFailures.size === 0) return undefined
  let latest: PushFailure | undefined
  for (const s of await listSubscriptions()) {
    if (s.deviceId !== deviceId) continue
    const f = lastFailures.get(s.endpoint)
    if (f && (!latest || f.at > latest.at)) latest = f
  }
  return latest
}

/** For tests. Keeps state from leaking across processes */
export function resetFailuresForTest(): void {
  lastFailures.clear()
}
