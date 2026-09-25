// Pairing decisions and text (③ device keys / ARCHITECTURE §14.1.2.5).
//
// ★★ **The one-time token is sent only to "the agent that showed the QR".**
//   ⚠️⚠️ The QR names the agent by **public key**, but the PWA holds endpoints by **URL**
//     (discipline 1: endpoints are data). ⇒ **Match** them via `/health` `agentPublicKey`.
//   ⚠️⚠️ Never do "POST to every endpoint and take whichever succeeds"
//     (**the one-time token leaks to other machines**). This decision is in this one place.
//
// ★ The text lives here too (same reason as `ui/commands.ts` = two places diverge).

import {
  FRAME,
  finishHandshake,
  fromBase64Url,
  startHandshake,
  toBase64Url,
  type KeyPair,
} from '../../../shared/crypto.ts'
import { parsePairUrl, type PairPayload } from '../../../shared/pairing.ts'
import type { AgentFeature, HandshakeResult } from '../../../shared/types.ts'
import { t } from '../../../shared/i18n.ts'

/** Inputs for matching (only part of `/health` is looked at) */
export interface PairCandidate {
  /** ★ Base64url of that agent's raw public key. ⚠️ Old agents do not return it */
  agentPublicKey?: string
  machine?: string
}

export type ReadResult =
  | { kind: 'ok'; payload: PairPayload }
  | { kind: 'unreadable' }

/**
 * Decode the scanned string (QR / paste).
 *
 * ⚠️ **Never throws** (`parsePairUrl` is built on the assumption of hostile input).
 * ★ Leading and trailing whitespace is stripped (copy-paste tends to add it).
 */
export function readPairInput(raw: string): ReadResult {
  const payload = parsePairUrl((raw ?? '').trim())
  return payload ? { kind: 'ok', payload } : { kind: 'unreadable' }
}

/**
 * Which endpoint is the agent that showed the QR. **`undefined` if none**.
 *
 * ⚠️⚠️ If this returns `undefined`, **the one-time token must not be sent**.
 * ★ Several with the same key means "the same agent registered under two URLs", so take the first.
 */
export function pickPairTarget(
  agentPublicKey: string,
  candidates: readonly PairCandidate[],
): number | undefined {
  if (!agentPublicKey) return undefined
  const at = candidates.findIndex((c) => c.agentPublicKey === agentPublicKey)
  return at < 0 ? undefined : at
}

/** Cap. ⚠️ The agent (`MAX_LABEL`) truncates too, but shorten it before sending */
export const MAX_SEND_LABEL = 64

/**
 * This device's default name (shown in the PC's list).
 *
 * ⚠️ **Do not send the UA as-is** (it only puts a long string on the PC's screen and does not help identify it).
 * ★ If unknown, "This device" (⚠️ never send an empty string = it becomes "no name" on the PC).
 */
export function defaultDeviceLabel(ua: string): string {
  const s = ua ?? ''
  // ⚠️ Order matters (the iPadOS UA contains "Macintosh")
  if (/\bAndroid\b/.test(s)) return 'Android'
  if (/\biPhone\b/.test(s)) return 'iPhone'
  if (/\biPad\b/.test(s)) return 'iPad'
  if (/\bMacintosh\b|\bMac OS X\b/.test(s)) return 'Mac'
  if (/\bWindows\b/.test(s)) return 'Windows'
  if (/\bLinux\b/.test(s)) return 'Linux'
  return t('この端末', 'This device')
}

/** Tidy the name to send (⚠️ strip control characters, cap the length; empty falls back to the default) */
export function sendLabel(input: string, ua: string): string {
  const cleaned = (input ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, '')
    .trim()
    .slice(0, MAX_SEND_LABEL)
  return cleaned || defaultDeviceLabel(ua)
}

export type PairOutcome =
  | { kind: 'unreadable' }
  | { kind: 'no-target'; machine: string }
  | { kind: 'no-identity'; reason: string }
  | { kind: 'refused'; reason: string }
  | { kind: 'error'; reason: string }
  /**
   * ★★ The QR carries a relay entry point, but **registration via relay failed**
   *   (2026-09-19 / codex round 9).
   *
   * ⚠️⚠️ **No fallback to `u` (local)** (that would be a downgrade attack / round 8, high #1).
   *   ⇒ Instead **show how to fix it on screen** (otherwise it ends at "cannot connect").
   */
  | { kind: 'relay-only'; machine: string; reason: string }
  | {
      kind: 'done'
      deviceId: string
      machine: string
      already?: boolean
      /** ★ The QR carried a relay entry point and **it was remembered for this endpoint** (③ stage 6, ④) */
      relay?: boolean
      /**
       * ★ The remembered relay entry point and the peer's key (2026-09-24). Used to find old endpoints of the same machine
       *   whose key was regenerated (`staleTwins` in `endpoints.ts`).
       */
      paired?: { relayUrl: string; agentPublicKey: string }
    }

/**
 * Text shown on screen. ★ **One place** (two places diverge / CLAUDE.md §2).
 *
 * ⚠️⚠️ **Do not stop at "registered".**
 *    ★ If the QR **does not carry** a relay entry point, there is no route using that key yet
 *      ⇒ say "connect as before" (otherwise it is misread as "now it connects").
 *    ★ If it does, it was remembered, so say **what to do next** (switch the route to relay when away from home).
 */
/**
 * ★ Notice that an old endpoint of the same machine whose key was regenerated should **just be removed from the list** (2026-09-24).
 * ⚠️⚠️ Do not send a revocation: the old key can no longer be reached, and if only the key file was lost, **this phone's registration is still alive**
 *    (the device key is the same), so revoking would **cut the current connection too**.
 */
export function staleTwinText(machine: string, agentPublicKey: string): string {
  // ★ A mark to identify which row (the start of the key). ⚠️ Do not assert (it could be another machine with the same name / codex round 18, medium #4)
  const mark = agentPublicKey.slice(0, 8)
  return t(
    `同じ名前「${machine}」で応答のない接続先があります（鍵 ${mark}…）。` +
      'マシンの鍵が作り直された古い行の可能性があります。同じマシンなら、一覧から消してかまいません（相手の登録には触りません）',
    `There is a connection with the same name "${machine}" that is not responding (key ${mark}…). ` +
      "It may be an old entry from before the machine's key was recreated. If it is the same machine, you can remove it from the list (the registration on the machine is not touched)",
  )
}

export function pairText(o: PairOutcome): string {
  switch (o.kind) {
    case 'unreadable':
      return t(
        'ペアリングの文字列として読めません（PC で `npm run pair` を実行し直してください）',
        'Not a valid pairing string (run `npm run pair` again on the PC)',
      )
    case 'no-target':
      return t(
        `その QR を出したマシン${o.machine ? `（${o.machine}）` : ''}が接続先に入っていません。` +
          '「接続先」で追加してから、もう一度読み取ってください',
        `The machine that showed this QR${o.machine ? ` (${o.machine})` : ''} is not in your connections. ` +
          'Add it under "Connections", then scan again',
      )
    case 'no-identity':
      return t(`この端末の鍵を用意できません（${o.reason}）`, `Could not prepare this device's key (${o.reason})`)
    case 'refused':
      // ⚠️ Show the agent's reason as-is ("show the QR again", etc.)
      return t(`登録を断られました: ${o.reason}`, `Registration was refused: ${o.reason}`)
    case 'error':
      return t(`登録できませんでした: ${o.reason}`, `Could not register: ${o.reason}`)
    case 'relay-only':
      // ⚠️⚠️ **State the most common cause first** (hit in practice on 2026-09-19).
      //    ★ The one-time token is **single-use, 5 minutes**, and without an unused one the agent **refuses the handshake itself**
      //      (`oneTimeCount() > 0` is the gate / §14.1.4). ⇒ Scanning the same QR on a second device always lands here.
      //    ⚠️ It used to start with "update the agent / empty `relayUrl`", so
      //      **it never mentioned the most ordinary cause (a stale QR)**.
      //    ⇒ Causes are listed in order of frequency.
      return t(
        `relay 経由で登録できませんでした（${o.reason}）。` +
          `⚠️ ワンタイムは **1回きり・5分**です。まず ${o.machine || 'そのマシン'} で ` +
          '`npm run pair` を打ち直して、**出たての QR** を読んでください。' +
          '（2台目には新しい QR が要ります）' +
          'それでも駄目なら ① agent を更新する（git pull → 再起動）' +
          '② config.json の "relayUrl" を "" にして QR を出し直す。' +
          '⚠️ この QR は relay の入口を載せているので、**安全のため local では登録しません**',
        `Could not register via relay (${o.reason}). ` +
          `⚠️ The one-time code works **once, for 5 minutes**. First run \`npm run pair\` again on ${o.machine || 'that machine'} ` +
          'and scan the **fresh QR**. ' +
          '(A second device needs a new QR.) ' +
          'If that still fails: ① update the agent (git pull → restart) ' +
          '② set "relayUrl" to "" in config.json and show the QR again. ' +
          '⚠️ This QR carries a relay entry point, so **for safety it will not register over local**',
      )
    case 'done':
      // ★★ Fixed on 2026-09-23 (a real device showed 「既に登録しました」 = unnatural Japanese).
      //   ⚠️⚠️ When registered via relay, **the endpoint is already saved with the relay route** (`kind: 'relay'` in `pairViaRelay`).
      //      It used to prompt "set the route to relay", **urging something already done** (wrong).
      return (
        (o.already
          ? t(
              `${o.machine || 'このマシン'} には、この端末はもう登録されています（${o.deviceId.slice(0, 8)}…）。`,
              `This device is already registered on ${o.machine || 'this machine'} (${o.deviceId.slice(0, 8)}…). `,
            )
          : t(
              `${o.machine || 'このマシン'} に登録しました（${o.deviceId.slice(0, 8)}…）。`,
              `Registered on ${o.machine || 'this machine'} (${o.deviceId.slice(0, 8)}…). `,
            )) +
        (o.relay
          ? t('relay で繋ぎます（家の外からも使えます）', 'Connecting via relay (works away from home too)')
          : t('Tailscale で繋ぎます（QR に relay の入口が無いため）', 'Connecting via Tailscale (the QR has no relay entry point)'))
      )
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ★★ Feature marks (⚠️ absent means not shown = fail-closed / CLAUDE.md §2)
// ─────────────────────────────────────────────────────────────────────────────

export interface PairAbility {
  /** Has `GET /devices` `POST /pair` `POST /devices/revoke` */
  pair: boolean
  /** Has `POST /handshake` */
  verify: boolean
}

/**
 * What can be done with that agent.
 *
 * ⚠️⚠️ **Not shown for agents without the mark (old ones)** (no buttons that 404 when pressed).
 * ⚠️ **Do not merge `pair` and `verify`** (an agent that can register but lacks the handshake endpoint
 *    can exist = while only one machine has been updated).
 */
export function pairAbility(features: readonly AgentFeature[] | undefined): PairAbility {
  const has = (f: AgentFeature): boolean => features?.includes(f) === true
  return { pair: has('device-pairing'), verify: has('device-handshake') }
}

// ─────────────────────────────────────────────────────────────────────────────
// ★★ Handshake connectivity check (= the only way to confirm crypto works in the browser)
// ─────────────────────────────────────────────────────────────────────────────

export type VerifyOutcome =
  | { kind: 'ok'; deviceId: string; keyBits: number }
  | { kind: 'refused'; reason: string }
  | { kind: 'failed'; reason: string }

/**
 * Handshake with the agent using this device's key and confirm **we reached the same key**.
 *
 * ★★ **Why it lives here**: `.tsx` has no behavioural tests, so
 *    **the steps (first message → reply → confirm → actually encrypt) are put in .ts and exercised in Node**.
 * ⚠️⚠️ **It is not a `Session` until `confirm` is opened** (goes through `accept()` / §14.1.2.6 item 4).
 *    Being able to open it is itself the proof of "reached the same key".
 * ⚠️ **Never throws** (the screen would freeze, so return a reason).
 */
export async function verifyHandshake(
  pair: KeyPair,
  agentPublicKey: string,
  send: (init: string) => Promise<HandshakeResult>,
): Promise<VerifyOutcome> {
  let agentRaw: Uint8Array
  try {
    agentRaw = fromBase64Url(agentPublicKey)
  } catch {
    return { kind: 'failed', reason: t('agent の公開鍵を読めません', "Cannot read the agent's public key") }
  }
  try {
    const h = await startHandshake(pair, agentRaw)
    const res = await send(toBase64Url(h.message))
    // ⚠️ Show the agent's refusal reason **as-is** ("not registered" etc. is fixable by the user)
    if (!res.ok) return { kind: 'refused', reason: res.reason }
    const pending = await finishHandshake(h, fromBase64Url(res.reply))
    const session = await pending.accept(fromBase64Url(res.confirm))
    // ★ Check not just "keys agree" but that it **can actually encrypt**
    await session.seal(FRAME.request, new TextEncoder().encode('ping'))
    return { kind: 'ok', deviceId: res.deviceId, keyBits: session.keyBits }
  } catch (err) {
    return { kind: 'failed', reason: err instanceof Error ? err.message : String(err) }
  }
}

/** Connectivity-check text. ★ **One place** (same reason as `pairText`) */
export function verifyText(o: VerifyOutcome): string {
  switch (o.kind) {
    case 'ok':
      return t(
        `握手できました（${o.keyBits} ビットの鍵・${o.deviceId.slice(0, 8)}…）。` +
          '⚠️ 確かめただけで、この鍵を使う経路（relay）はまだ無いので繋ぎ方は変わりません',
        `Handshake succeeded (${o.keyBits}-bit key, ${o.deviceId.slice(0, 8)}…). ` +
          '⚠️ This was only a check; there is no route (relay) using this key yet, so how you connect does not change',
      )
    case 'refused':
      return t(`agent が握手を断りました: ${o.reason}`, `The agent refused the handshake: ${o.reason}`)
    case 'failed':
      // ⚠️ If this appears, **crypto does not work in this device's browser** (the design's premise breaks)
      return t(`握手できませんでした: ${o.reason}`, `Handshake failed: ${o.reason}`)
  }
}
