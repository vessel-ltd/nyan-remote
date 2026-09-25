// The pairing **steps** (register, list, revoke).
//
// ★★ **Why it was moved out of `.tsx`** (2026-09-08 codex):
//   `.tsx` has no behavioural tests, so while the steps were written in the screen
//   **nobody was checking "how return values tie to side effects"**.
//   The slipping mutant codex named (`transports[at]` → `transports[0]` = **sending the one-time token
//   to another machine**) was exactly that; `discipline.test.ts` only checks **that function names exist and their order**.
//   ⇒ **Move the steps out and exercise them with a stubbed transport.**
//
// ⚠️ Decisions and text are in `ui/pairing.ts` (decoding, matching, names, text). Only **the order** is here.

import type { AgentFeature, DeviceInfo, PairResult, RevokeResult } from '../../../shared/types.ts'
import type { Identity } from '../identity.ts'
import { t } from '../../../shared/i18n.ts'
import {
  pairAbility,
  pickPairTarget,
  readPairInput,
  sendLabel,
  type PairCandidate,
  type PairOutcome,
} from './pairing.ts'

/**
 * ★ Only the ports these steps need (**no dependency on the whole `Transport`** = stubbable in tests).
 */
export interface PairTransport {
  pairDevice(body: {
    key: string
    token: string
    label: string
    agentPublicKey: string
  }): Promise<PairResult>
  listDevices(): Promise<{ devices: DeviceInfo[]; broken?: string; keyProblem?: string }>
  revokeDevice(key: string): Promise<RevokeResult>
}

/** ★ Only the part of `/health` the steps look at (no dependency on the whole `AgentHealth`) */
export type HealthLike = PairCandidate & { features?: readonly AgentFeature[] }

export interface PairDeps {
  readonly transports: readonly PairTransport[]
  /** ⚠️ **Same order** as `transports` (`undefined` = endpoint that could not be reached) */
  readonly healths: readonly (HealthLike | undefined)[]
  readonly identity: Identity | undefined
  readonly ua: string
  /**
   * ★★ **Connect to an unknown endpoint** from the QR's `u` (the agent's entry point) (2026-09-16 / to move on to Y).
   *
   * ⚠️⚠️ **A PWA served from the public origin starts with no agents at all**
   *    (its own origin is not a candidate = discipline 1). ⇒ The first one can only be added from a QR.
   * ⚠️⚠️ This path loosens "**never send the one-time token to the wrong party**", so
   *    **match the public key via `/health` before sending** (if it does not match, send to none).
   * ⚠️ Opening the line is the caller's job (`Transport` is kept one per endpoint / §14.1.2.32).
   */
  readonly connect?: (url: string) => {
    transport: PairTransport
    health: () => Promise<HealthLike | undefined>
  }
  /**
   * ★ Added to endpoints **only after registration succeeds** (⚠️ do not leave a refusing party in the list).
   *
   * ⚠️ The relay entry point is passed along too (`rememberRelay` points at the position of an **existing** endpoint, so it cannot be used).
   */
  readonly addEndpoint?: (e: {
    url: string
    label: string
    relay?: { url: string; agentPublicKey: string }
    /**
     * ★★ **The route registration succeeded on** (2026-09-18 / codex round 8, medium #2).
     *
     * ⚠️⚠️ Without it, **registering via relay with `u` present made local win from then on**,
     *    and with CORS auto-allow removed **that endpoint did not connect** (at home or away).
     * ⇒ **Save the route that was confirmed** (do not fall back to `endpointRoute`'s default `local`).
     */
    kind?: 'local' | 'relay'
  }) => void
  /**
   * ★★ **Pair via relay** (③ stage 7 / ARCHITECTURE §14.1.4).
   *
   * ⚠️⚠️ This is the last piece of "complete without a tailnet". ⇒ Registration works even without `u` (local).
   * ★ **No `/health` matching needed** (the handshake is bound to the QR's key = the answer to codex high #1).
   * ⚠️ The line is **disposable** (the caller always closes it = does not eat relay slots).
   */
  readonly connectRelay?: (relay: { url: string; agentPublicKey: string }) => {
    transport: PairTransport
    close: () => void
  }
}

/**
 * Register with a pasted string.
 *
 * ⚠️⚠️ **Send only to the one matched machine** (`pickPairTarget`).
 *    ★ The "never send to the wrong party" guarantee also exists **on the transport side** (`http.ts`
 *      checks its own `/health` right before sending / codex medium #7). This only **chooses the destination**.
 * ⚠️ **Never throws** (the screen would freeze, so return a result).
 */
/**
 * ★★ **The one-time token is sent from this one place only** (`discipline.test.ts` counts it).
 *
 * ⚠️⚠️ More call sites let "a path that sends without matching" sprout unnoticed, so
 *    split **the side deciding the destination** (choose from existing endpoints / verify from the QR's `u`)
 *    from **the sending side**, and keep the sending side single.
 */
async function sendPairing(
  to: PairTransport,
  payload: { agentPublicKey: string; token: string },
  identity: { publicKey: string },
  ua: string,
): Promise<PairResult> {
  return await to.pairDevice({
    key: identity.publicKey,
    token: payload.token,
    label: sendLabel('', ua),
    agentPublicKey: payload.agentPublicKey,
  })
}

/**
 * ★★ **Register via relay** (③ stage 7 / ARCHITECTURE §14.1.4).
 *
 * ⚠️⚠️ **Not consulting `/health`** is the decisive difference from `pairViaQr`.
 *    That one relies on "the host **returned** the real public key", and **a fake host passed
 *    just by returning the real key** (codex round 7, high #1 / reproduced by measurement).
 *    Here the handshake is bound to the QR's key (`z2`/`z4`), so **a party that cannot agree on the key
 *    cannot even open the envelope carrying the one-time token**.
 * ⚠️⚠️ **Always close** (`finally`). Forgetting eats relay slots (8),
 *    and each retry leaves the real phone unable to connect.
 * ⚠️ Added to endpoints **only after registration succeeds** (do not leave a refusing party in the list).
 * ⚠️ `u` (the local entry point) is remembered too if present (so local can be used at home).
 */
async function pairViaRelay(
  payload: { agentPublicKey: string; token: string; machine: string; relayUrl: string; agentUrl?: string },
  connectRelay: NonNullable<PairDeps['connectRelay']>,
  deps: PairDeps,
  identity: { publicKey: string },
): Promise<PairOutcome> {
  const relay = { url: payload.relayUrl, agentPublicKey: payload.agentPublicKey }
  const { transport, close } = connectRelay(relay)
  try {
    const res = await sendPairing(transport, payload, identity, deps.ua)
    if (!res.ok) return { kind: 'refused', reason: res.reason }
    deps.addEndpoint?.({
      // ⚠️ Remember `u` if present (for when you want local at home). Empty otherwise
      url: payload.agentUrl ?? '',
      label: payload.machine,
      relay,
      // ★★ **Registered via relay**. ⚠️⚠️ Without writing this, local wins when `u` is present,
      //   and with auto-allow removed **an unreachable endpoint** stays in the list (codex round 8, medium #2).
      kind: 'relay',
    })
    return {
      kind: 'done',
      deviceId: res.deviceId,
      machine: payload.machine,
      ...(res.already ? { already: true } : {}),
      relay: true,
      paired: { relayUrl: payload.relayUrl, agentPublicKey: payload.agentPublicKey },
    }
  } catch (err) {
    // ★★ **Failures where only relay registration is allowed** are grouped as `relay-only`
    //   (2026-09-19 / in practice). ⚠️ As `error` it only showed
    //   "Could not register: the handshake does not finish (timeout)",
    //   **never mentioning the most common cause (the QR is single-use and expires in 5 minutes)**.
    return {
      kind: 'relay-only',
      machine: payload.machine,
      reason: err instanceof Error ? err.message : String(err),
    }
  } finally {
    // ⚠️⚠️ Close regardless of outcome (do not eat slots)
    close()
  }
}

/**
 * ★★ **Connect to an unknown endpoint** from the QR's `u` and register (2026-09-16 / to move on to Y).
 *
 * ⚠️⚠️ The order is the guard: **① verify the entry point (`/health`) → ② public key matches → ③ register → ④ add to endpoints**.
 *    Skipping ①② means "hand the one-time token to wherever the QR points",
 *    and doing ④ first means "rows that cannot connect pile up".
 */
async function pairViaQr(
  payload: { agentPublicKey: string; token: string; machine: string; relayUrl?: string; agentUrl?: string },
  deps: PairDeps,
  identity: { publicKey: string },
): Promise<PairOutcome> {
  const url = payload.agentUrl
  if (url === undefined || !deps.connect) return { kind: 'no-target', machine: payload.machine }
  const { transport, health } = deps.connect(url)
  let found: HealthLike | undefined
  try {
    found = await health()
  } catch (err) {
    return { kind: 'error', reason: err instanceof Error ? err.message : String(err) }
  }
  // ⚠️⚠️ **If it does not match, send to none** (keep the same guarantee as for existing endpoints)
  if (!found || found.agentPublicKey !== payload.agentPublicKey) {
    return { kind: 'no-target', machine: payload.machine }
  }
  try {
    const res = await sendPairing(transport, payload, identity, deps.ua)
    if (!res.ok) return { kind: 'refused', reason: res.reason }
    const machine = found.machine ?? payload.machine
    // ★ Add only after registration succeeds (⚠️ with the relay entry point too = it cannot be pointed at by position)
    deps.addEndpoint?.({
      url,
      label: machine,
      ...(payload.relayUrl === undefined
        ? {}
        : { relay: { url: payload.relayUrl, agentPublicKey: payload.agentPublicKey } }),
    })
    return {
      kind: 'done',
      deviceId: res.deviceId,
      machine,
      ...(res.already ? { already: true } : {}),
      ...(payload.relayUrl === undefined
        ? {}
        : { relay: true, paired: { relayUrl: payload.relayUrl, agentPublicKey: payload.agentPublicKey } }),
    }
  } catch (err) {
    return { kind: 'error', reason: err instanceof Error ? err.message : String(err) }
  }
}

export async function runPairing(input: string, deps: PairDeps): Promise<PairOutcome> {
  const read = readPairInput(input)
  if (read.kind !== 'ok') return { kind: 'unreadable' }
  const identity = deps.identity
  if (!identity || identity.kind !== 'ok') {
    return { kind: 'no-identity', reason: identity?.reason ?? t('読み込み中', 'Loading') }
  }

  // ★★ **If `r` is present, relay only. This comes before the endpoint lookup** (2026-09-19 / codex round 9, high #1).
  //
  // ⚠️⚠️ **My fix only half worked**: in round 8 "try relay first" was added only to
  //    the "not in endpoints" branch, so **a party already in endpoints** (= normal use at home)
  //    was chosen by `pickPairTarget` and **sent to local `/pair`**
  //    (codex measured "0 relay calls" with a real transport).
  //    ⇒ The weak route we thought was closed (string comparison of `/health`) remained entirely.
  // ★ The decision is placed **before looking at the endpoint list** (= strength does not depend on "whether it is in the list").
  const relayUrl = read.payload.relayUrl
  if (relayUrl !== undefined) {
    // ⚠️⚠️ **Never silently take the weaker route** (a missing `connectRelay` is a wiring omission in the screen)
    if (!deps.connectRelay) {
      return { kind: 'relay-only', machine: read.payload.machine, reason: t('relay の経路がありません', 'No relay route available') }
    }
    return await pairViaRelay({ ...read.payload, relayUrl }, deps.connectRelay, deps, identity)
  }

  // ★ Below here is only for **QRs without `r`** (= no stronger route exists = not a downgrade)
  const at = pickPairTarget(
    read.payload.agentPublicKey,
    deps.healths.map((h) => h ?? {}),
  )
  // ★★ If not in endpoints, **add it from the QR's `u`** (2026-09-16 / Y).
  //   ⚠️⚠️ Match **here too** (do not hand the one-time token over even if `u` points at another machine).
  if (at === undefined) {
    // ⚠️ Our identity check here is only the `/health` string comparison (round 7, high #1 remains).
    //   ★ But **no `r` = no stronger route exists**, so this is not a downgrade.
    //   ⬜ Whether to retire the `u` path altogether waits on deciding how to treat self-hosters (§14.1.4 cleanup ②).
    return await pairViaQr(read.payload, deps, identity)
  }
  const tr = deps.transports[at]
  if (!tr) return { kind: 'no-target', machine: read.payload.machine }
  try {
    const res = await sendPairing(tr, read.payload, identity, deps.ua)
    if (!res.ok) return { kind: 'refused', reason: res.reason }
    // ⚠️ Only **QRs without `r`** reach here, so there is no relay entry point to remember
    //   (★ it used to call `rememberRelay`, but relay returns first above so it was **unreachable**
    //    = not "a guard others back up" but **dead code**, so it was removed).
    return {
      kind: 'done',
      deviceId: res.deviceId,
      machine: deps.healths[at]?.machine ?? read.payload.machine,
      ...(res.already ? { already: true } : {}),
    }
  } catch (err) {
    return { kind: 'error', reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * One registered row.
 *
 * ★★ **Keep which endpoint it came from** (2026-09-08 codex medium #5).
 *   ⚠️⚠️ It used to be discarded when gathering the list, so revocation **tried every endpoint in turn and stopped
 *      at the first success** = with the same device key registered on A and B,
 *      **pressing B's row removed A** (reproduced by measurement).
 */
export interface DeviceRow {
  device: DeviceInfo
  /** Position in `transports` */
  at: number
  machine: string
}

/**
 * Gather registrations.
 *
 * ⚠️ Endpoints without the mark are skipped (fail-closed). Unreachable endpoints are silently skipped
 *    (the endpoints screen gives its own reason).
 * ⚠️⚠️ **Do not mix "0 entries" with "broken, so refusing everything"** (the fixes differ).
 */
export async function collectDevices(
  deps: PairDeps,
): Promise<{ rows: DeviceRow[]; trouble?: string }> {
  const found: DeviceRow[][] = deps.transports.map(() => [])
  const troubles: (string | undefined)[] = deps.transports.map(() => undefined)
  await Promise.all(
    deps.transports.map(async (tr, at) => {
      const h = deps.healths[at]
      if (!pairAbility(h?.features).pair) return
      const machine = h?.machine ?? ''
      try {
        const res = await tr.listDevices()
        found[at] = res.devices.map((device) => ({ device, at, machine }))
        // ⚠️ The broken one is shown with priority (recovery is more urgent than a key problem)
        if (res.broken) troubles[at] = `${machine}: ${res.broken}`
        else if (res.keyProblem) troubles[at] = `${machine}: ${res.keyProblem}`
      } catch {
        // Merely unreachable
      }
    }),
  )
  const trouble = troubles.find((x) => x !== undefined)
  return { rows: found.flat(), ...(trouble ? { trouble } : {}) }
}

export type RevokeOutcome =
  | { kind: 'done'; machine: string }
  /** ⚠️ Stopped for now but **not saved** = revives when the agent restarts */
  | { kind: 'unsaved'; machine: string; reason: string }
  | { kind: 'refused'; reason: string }
  | { kind: 'error'; reason: string }

/**
 * Revoke that row's registration.
 *
 * ⚠️⚠️ **Send only to that row's machine** (`row.at`). Do not go back to trying every endpoint.
 * ⚠️⚠️ **Do not discard `saved:false`** (2026-09-08 codex medium #6). The agent drops it from memory
 *    even if saving fails, so if the screen only looked at `ok`, **the row would vanish as if revoked,
 *    and revive on restart**. ⇒ Carried as a separate result.
 */
export async function runRevoke(row: DeviceRow, deps: PairDeps): Promise<RevokeOutcome> {
  const tr = deps.transports[row.at]
  if (!tr) return { kind: 'error', reason: t('その接続先がありません', 'That connection does not exist') }
  try {
    const res = await tr.revokeDevice(row.device.key)
    if (res.ok) return { kind: 'done', machine: row.machine }
    if (res.saved === false) {
      return { kind: 'unsaved', machine: row.machine, reason: res.reason }
    }
    return { kind: 'refused', reason: res.reason }
  } catch (err) {
    return { kind: 'error', reason: err instanceof Error ? err.message : String(err) }
  }
}

/** Revocation text. ★ **One place** (same reason as `pairText`) */
export function revokeText(o: RevokeOutcome): string {
  switch (o.kind) {
    case 'done':
      return t(`${o.machine || 'この接続先'} の登録を消しました`, `Removed the registration on ${o.machine || 'this connection'}`)
    case 'unsaved':
      // ⚠️⚠️ Always say that it "looks gone but will revive"
      return t(
        `${o.machine || 'この接続先'} でいまは止まりましたが、保存できませんでした（${o.reason}）。` +
          '⚠️ agent を再起動すると復活します',
        `Stopped on ${o.machine || 'this connection'} for now, but could not save it (${o.reason}). ` +
          '⚠️ It comes back when the agent restarts',
      )
    case 'refused':
      return t(`消せませんでした: ${o.reason}`, `Could not remove: ${o.reason}`)
    case 'error':
      return t(`消せませんでした: ${o.reason}`, `Could not remove: ${o.reason}`)
  }
}

/**
 * Whether to show the pairing section.
 *
 * ⚠️⚠️ **Not shown before health is known** (2026-09-08 codex low #1).
 *    It used to be `healths.length > 0 && !anyPair`, so **it showed while loading (`[]`)**
 *    = the button flashed even when all agents lacked the mark (fail-open).
 */
export function showPairing(
  healths: readonly ({ features?: readonly AgentFeature[] } | undefined)[] | undefined,
): boolean {
  // ⚠️ Not shown while still unknown (loading)
  if (!healths) return false
  // ★★ **Shown when there are no endpoints at all** (2026-09-16 / hit in practice after moving to Y).
  //   ⚠️⚠️ On the public origin **0 machines is the normal initial state**, so failing closed here
  //      **removes the QR paste field itself, leaving no way to connect anywhere** (another chicken-and-egg).
  //   ★ The original intent "no button without the mark" is about **agents that already exist**.
  //      With 0 there is nobody to press against, so no 404 button can be made either.
  //      ⚠️ If the pasted QR's party is too old to handshake, the reason comes back on the spot (still fail-closed).
  if (healths.length === 0) return true
  // ★★ **Also shown when no agent could be reached** (2026-09-19 / codex round 7, medium #7.
  //   ⚠️⚠️ **Got stuck in practice**: the only agent in the list was down, so
  //   **the field for adding another PC from the phone vanished** (= no way to recover from the screen).
  //   ★ Same logic as the 0 case: **with nothing to decide on**, do not block. There is nobody to press against,
  //     so no "404 button" can be made (if the pasted QR's party is old, the reason comes back on the spot).
  //   ⚠️ The original fail-closed intent (**no button for agents without the mark**) applies
  //     "when **a reachable** agent exists", so that is still guarded by the line below.
  if (healths.every((h) => h === undefined)) return true
  return healths.some((h) => pairAbility(h?.features).pair)
}

// ─────────────────────────────────────────────────────────────────────────────
// ★★ Unlinking (2026-09-21 / user decision)
//
// ★ **Do not explain to the user that "there are two".** The relationship is held in two directions
//   (the endpoint list = machines this phone knows / registrations = devices that machine allows),
//   but the phone **knows both sides and can reach both**, so one action can move both.
//
// ⚠️⚠️ **The reverse (machine-initiated) is inherently one-way**: the device's endpoint list is out of reach
//   (unreachable when offline / the revoked party is an untrusted device / by design handshake reasons are not returned).
//   ⇒ That side is handled by `scripts/devices.mjs` (list and revoke from the machine).
// ─────────────────────────────────────────────────────────────────────────────

export type UnlinkOutcome =
  /** Both removed */
  | { kind: 'done'; machine: string }
  /** ⚠️ The endpoint was removed, but **the registration on the other side remained** (= the only place the duality shows) */
  | { kind: 'kept'; machine: string; reason: string }

export interface UnlinkDeps {
  /** Only the endpoint of the pressed row (⚠️ never sent to other machines / same reason as `runRevoke`) */
  readonly transport: Pick<PairTransport, 'revokeDevice'> | undefined
  /** This device's public key. ⚠️ If absent (the key is broken), revocation is **not attempted** */
  readonly myKey: string | undefined
  /** ★★ Actually remove the endpoint. ⚠️⚠️ **Always called** (removed even if revocation fails) */
  readonly forget: () => void
}

/**
 * ★★ Unlink from this machine (revoke → remove the endpoint).
 *
 * ⚠️⚠️ **Do not swap the order.** Removing the endpoint first **loses the revocation's destination**
 *   (the shape hit in practice: after removing the endpoint, the registration left on the other side could never be removed).
 * ⚠️⚠️ **Remove the endpoint even if revocation fails.** Making this depend on the network means
 *   **the endpoint of a down agent cannot be removed** (a hole just fixed on 2026-09-19 / §2).
 */
export async function runUnlink(machine: string, deps: UnlinkDeps): Promise<UnlinkOutcome> {
  const kept = (reason: string): UnlinkOutcome => {
    deps.forget()
    return { kind: 'kept', machine, reason }
  }
  if (!deps.transport) return kept(t('その接続先に繋げませんでした', 'Could not connect to that machine'))
  if (!deps.myKey) return kept(t('この端末の鍵が読めませんでした', "Could not read this device's key"))
  let res: RevokeResult
  try {
    res = await deps.transport.revokeDevice(deps.myKey)
  } catch (err) {
    return kept(err instanceof Error ? err.message : String(err))
  }
  if (!res.ok) {
    // ⚠️ `saved:false` means "dropped from memory but not saved" = **revives on restart**
    return kept(res.saved === false ? t(`${res.reason}（保存できていません）`, `${res.reason} (not saved)`) : res.reason)
  }
  deps.forget()
  return { kind: 'done', machine }
}

/** Unlink text. ★ **One place** (same reason as `pairText` / `revokeText`) */
export function unlinkText(o: UnlinkOutcome): string {
  if (o.kind === 'done') return t(`${o.machine} との接続を解除しました`, `Unlinked from ${o.machine}`)
  // ⚠️⚠️ **Only here is the duality shown** (if silent, nobody notices the registration left on the other side)
  return t(
    `接続先からは消しました。⚠️ ${o.machine} 側に残ったこの端末の登録は消せませんでした` +
      `（${o.reason}）。そのマシンで npm run devices -- --revoke で消せます`,
    `Removed from connections. ⚠️ Could not remove this device's registration left on ${o.machine}` +
      ` (${o.reason}). You can remove it on that machine with npm run devices -- --revoke`,
  )
}
