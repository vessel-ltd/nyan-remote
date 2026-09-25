// Endpoints for registered devices (the device key of ③).
//
// ★ Authentication goes through the single place in index.ts (`auth.ts`). **Do not look at identity headers here** (discipline 3).
//   ⚠️ However, `POST /pair/token` is made **local only via `isLocalOnlyPath` in `auth.ts`**
//      (= only whoever can read `~/.nyan-remote/hook-token` = **someone on this machine**).
//      ⇒ This gives meaning to "registration requires the PC's screen" (the out-of-band path of §14.1.2.5).
//
// ⚠️⚠️ **Everything is POST** (only the `GET /devices` list is a read). If registration / revocation worked over GET,
//    **merely getting someone to follow a link** could add or remove devices.
//
// ⚠️ Do not write bodies into logs (§6.2). ⚠️⚠️ **Never log the one-time code.**

import { hostname } from 'node:os'
import { fingerprint, fromBase64Url, toBase64Url } from '../../../shared/crypto.ts'
import { agentBase, buildPairUrl } from '../../../shared/pairing.ts'
import { isRelayBase } from '../../../shared/relayFrame.ts'
import type { DevicesResult, PairResult, PairTokenCancelResult, PairTokenResult, PairTokenStatus, RevokeResult } from '../../../shared/types.ts'
import { config } from '../config.ts'
import { agentKeyProblem, agentKeyRecreated, agentPublicRaw } from '../deviceKey.ts'
import {
  MAX_LABEL,
  cancelOneTime,
  devicesBroken,
  issueOneTime,
  oneTimeStatus,
  listDevices,
  registerDevice,
  revokeDevice,
} from '../devices.ts'
import { removeSubscriptionsFor } from '../push.ts'
import { HttpError, readJsonBody } from '../router.ts'
import { selfAgentUrl } from '../tailscale.ts'
import { t } from '../../../shared/i18n.ts'

/**
 * The list of registered devices (for checking on the PC, and for the phone's "is this device registered?").
 *
 * ⚠️ Public keys are returned as is (**a public key is not a secret**). It is needed as the handle for revocation.
 * ⚠️⚠️ The corruption reason and key problems are returned too (**never silently show 0 items**.
 *    0 items and "corrupt, so everything is refused" **are fixed differently**).
 */
export async function devicesList(): Promise<DevicesResult> {
  const devices = await Promise.all(
    listDevices().map(async (d) => ({
      key: d.key,
      label: d.label,
      addedAt: d.addedAt,
      // ★ A short id for display. ⚠️ Not stored (do not keep two values derivable from the key / devices.ts)
      deviceId: await fingerprint(fromBase64Url(d.key)),
    })),
  )
  const broken = devicesBroken()
  const keyProblem = agentKeyProblem()
  const keyRecreated = agentKeyRecreated()
  return {
    devices,
    ...(broken ? { broken } : {}),
    ...(keyProblem ? { keyProblem } : {}),
    ...(keyRecreated ? { keyRecreated } : {}),
  }
}

/**
 * Issue one pairing one-time code and return the string to put in the QR.
 *
 * ⚠️⚠️ **A local-only endpoint** (`isLocalOnlyPath` in `auth.ts`). If it could be issued over the network,
 *    the premise "the PC's screen is required" would break (a registered phone could **add a second one
 *    by itself**).
 * ⚠️ Refuse when the agent key is unusable (**never show a QR that cannot connect**).
 */
export async function pairToken(): Promise<PairTokenResult> {
  const problem = agentKeyProblem()
  // ⚠️ 503 (same treatment as config problems). ⚠️ Return only the category (absolute paths go to the log)
  if (problem) throw new HttpError(503, t(`agent の鍵が使えません（${problem}）`, `The agent key is unusable (${problem}).`))
  if (devicesBroken()) {
    throw new HttpError(503, t(`登録済みデバイスの記録が壊れています（${devicesBroken()}）`, `The registered-device records are broken (${devicesBroken()}).`))
  }
  const one = issueOneTime()
  const machine = hostname()
  // ★★ Put the relay entry in the QR (③ step 6, part ④).
  //   ⚠️⚠️ **Do not include anything of the wrong shape** (never show people an unreadable QR). Config mistakes
  //      show up in `relay` on `/health` (= you can see why it silently became local only).
  const relay = config().relayUrl
  // ★★ **Include our own entry too** (2026-09-16 / to move on to Y).
  //   ⚠️⚠️ A PWA served from the public origin starts with **no agents at all**, so
  //      without this **the first one cannot be added anywhere** (its own origin is not a candidate / discipline 1).
  //   ⚠️ If it cannot be resolved, leave it out (it just becomes the QR as before).
  const agentUrl = agentBase(await selfAgentUrl())
  const url = buildPairUrl({
    agentPublicKey: toBase64Url(agentPublicRaw()),
    token: one.token,
    machine,
    ...(isRelayBase(relay) ? { relayUrl: relay } : {}),
    ...(agentUrl === undefined ? {} : { agentUrl }),
  })
  // ⚠️⚠️ **Never log the one-time code** (journalctl is shown to people for other purposes)
  console.log(t(`[devices] ペアリングのワンタイムを発行しました（${one.expiresAt} まで）`, `[devices] Issued a pairing one-time code (valid until ${one.expiresAt})`))
  const keyRecreated = agentKeyRecreated()
  return { token: one.token, expiresAt: one.expiresAt, url, machine, id: one.id, ...(keyRecreated ? { keyRecreated } : {}) }
}

/**
 * ★★ Status of a one-time code (how `npm run pair` knows "was it scanned" / 2026-09-23).
 * ⚠️⚠️ **Local only** (`isLocalOnlyPath`). Looked up by **id**; the one-time code itself is not passed.
 * ★ A registered device is returned with the same short id as the list (built from the single `fingerprint`).
 */
export async function pairTokenStatus(ctx: { params: Record<string, string> }): Promise<PairTokenStatus> {
  const s = oneTimeStatus(ctx.params['id'] ?? '')
  if (s.state !== 'registered') return s
  return {
    state: 'registered',
    label: s.label,
    already: s.already,
    deviceId: await fingerprint(fromBase64Url(s.deviceKey)),
  }
}

/**
 * ★★ Cancel a one-time code (Ctrl-C in `npm run pair`). ⚠️ POST only, local only.
 * ⚠️ When it could not be cancelled (already used / expired), `cancelled: false` = never lie.
 */
export async function pairTokenCancel(ctx: { params: Record<string, string> }): Promise<PairTokenCancelResult> {
  return { cancelled: await cancelOneTime(ctx.params['id'] ?? '') }
}

/**
 * Register a device (the phone sends its own public key).
 *
 * ⚠️⚠️ **A one-time code is required** (it is an argument of `registerDevice`, so there is no way to omit it).
 * ⚠️ The failure reason is returned as is (so the UI can say "please show the QR again").
 */
export async function pairDevice(ctx: { req: import('node:http').IncomingMessage }): Promise<PairResult> {
  const body = await readJsonBody<{ key?: unknown; token?: unknown; label?: unknown }>(ctx.req)
  const key = typeof body.key === 'string' ? body.key : ''
  const token = typeof body.token === 'string' ? body.token : ''
  const label = typeof body.label === 'string' ? body.label.slice(0, MAX_LABEL * 4) : ''
  if (!key) throw new HttpError(400, t('key（公開鍵の base64url）が必要です', '`key` (the public key, base64url) is required.'))
  if (!token) throw new HttpError(400, t('token（ペアリングのワンタイム）が必要です', '`token` (the pairing one-time code) is required.'))
  let raw: Uint8Array
  try {
    raw = fromBase64Url(key)
  } catch {
    throw new HttpError(400, t('key が base64url として読めません', '`key` is not valid base64url.'))
  }
  const res = await registerDevice(raw, label, token)
  if (!res.ok) return { ok: false, reason: res.reason }
  return {
    ok: true,
    deviceId: await fingerprint(raw),
    ...(res.already ? { already: true } : {}),
  }
}

/** Revoke a registration. ⚠️ The handle is the public key (the `key` returned by `GET /devices`) */
export async function deviceRevoke(ctx: {
  req: import('node:http').IncomingMessage
}): Promise<RevokeResult> {
  const body = await readJsonBody<{ key?: unknown }>(ctx.req)
  const key = typeof body.key === 'string' ? body.key : ''
  if (!key) throw new HttpError(400, t('key が必要です', '`key` is required.'))
  const res = await revokeDevice(key)
  if (!res.ok) return { ok: false, reason: res.reason, ...(res.saved === false ? { saved: false } : {}) }
  // ★★ **On revocation, also drop that device's notification subscriptions** (2026-09-21).
  //   ⚠️⚠️ Left alone they **remain forever** (FCM returns 201 even for dead endpoints, so
  //      they escape the automatic 404/410 cleanup / `removeSubscriptionsFor` in `push.ts`).
  //   ⚠️⚠️ **Never roll back the revocation itself.** The authority is `devices.json`; cleaning subscriptions is
  //      merely aftercare ⇒ **do not throw** here (the revocation stands even if the subscription file is corrupt).
  //      ★ Log that it could not be dropped (do not pretend it silently disappeared).
  //   ⚠️ The fingerprint is **not recomputed separately**; it comes from the single `fingerprint` (same value as the list = the value in the subscription).
  try {
    const dropped = await removeSubscriptionsFor(await fingerprint(fromBase64Url(key)))
    if (dropped > 0) console.log(t(`[push] 失効に伴い購読を落としました: ${dropped} 件`, `[push] Removed ${dropped} subscriptions of the revoked device`))
  } catch (e) {
    console.error(
      t('[push] 失効した端末の購読を落とせませんでした: ', "[push] Could not remove the revoked device's subscriptions: ") +
        (e instanceof Error ? e.message : String(e)),
    )
  }
  return { ok: true }
}
