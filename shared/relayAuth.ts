// Step 6 ④a of ③: **proof that the agent owns its key** (relay entry / ARCHITECTURE §14.1.2.30).
//
// ★★ **Without this, knowing the public key is enough to claim to be the agent.**
//   The key appears in the QR and in the rendezvous URL (`?a=…`) = a value **assumed to be known**, so
//   "that key can take the room" alone would let anyone **kick the connected agent** (DoS).
//   ⚠️ Contents stay unreadable (E2E), but it **can be stopped**. ⇒ Required before going public (`relay/README.md`).
//
// ```
//   relay → agent : [version][type=challenge][65B relay ephemeral public key][32B nonce]
//   agent → relay : [version][type=proof][32B proof]
//   after that    : rendezvous frames (`shared/relayFrame.ts`)
// ```
//
// ★★ **The phone proves its key too** (2026-09-27 / the free tier without sign-in / docs/BILLING.md §2.2):
//
// ```
//   relay → phone : [version][type=deviceChallenge][65B relay ephemeral public key][32B nonce]
//   phone → relay : [version][type=deviceProof][65B phone public key][32B proof]
// ```
//
//   ★ relay counts the free tier **per phone key** (one machine per phone), so it must know the phone is the key's owner:
//     otherwise anyone who saw a phone's public key could fill that phone's free slot from their own room.
//   ⚠️ The phone's first tunnel message (`init`, type 0) may cross the challenge in flight; the types differ (3 / 4 here,
//      0 / 1 there), so **either side can tell them apart by the type byte** — relay holds one crossing message until the proof is in.
//   ⚠️ The phone answers a challenge only before the agent's reply (the handshake phase); afterwards, bytes are envelopes.
//
// ★ The shape follows **the same idea as the tunnel's first message** (§14.1.2.26): **only the first exchange is raw**,
//   then it switches to frames. ⇒ Even if a type value overlaps with a frame, **the phase decides**, so they never mix.
//
// ⚠️⚠️ **Never throw, never fall back to defaults** (for both relay and agent, the peer is just "someone connected").
// ⚠️ The proof itself (ECDH + HKDF) is `relayProof` in `shared/crypto.ts`, one place only
//   (⚠️ **never write crypto in two places**). This file is **only the frame shape**.

import { t } from './i18n.ts'
import { PUBKEY_BYTES } from './crypto.ts'

/** ⚠️ A **different** version from frames (`RELAY_V`) (it is a different phase of the exchange) */
export const RELAY_AUTH_V = 1

export const RELAY_AUTH = {
  /** relay → agent */
  challenge: 1,
  /** agent → relay */
  proof: 2,
  /** ★ relay → phone (2026-09-27). Same layout as `challenge`; a different type so it never reads as the agent's handshake reply */
  deviceChallenge: 3,
  /** ★ phone → relay: carries the phone's public key (relay verifies with it and keys the free-tier ledger by it) */
  deviceProof: 4,
} as const

/** ⚠️ Fresh per connection (= replays do not work) */
export const RELAY_NONCE_BYTES = 32
/** ★ Length produced by `relayProof` (256 bits of HKDF-SHA256) */
export const RELAY_TAG_BYTES = 32

const CHALLENGE_BYTES = 2 + PUBKEY_BYTES + RELAY_NONCE_BYTES
const PROOF_BYTES = 2 + RELAY_TAG_BYTES
const DEVICE_PROOF_BYTES = 2 + PUBKEY_BYTES + RELAY_TAG_BYTES

export interface RelayChallenge {
  /** relay's **ephemeral** public key (⚠️ discarded per connection) */
  relayPublicRaw: Uint8Array
  nonce: Uint8Array
}

export type AuthDecoded<T> = { ok: true; value: T } | { ok: false; reason: string }

function encodeChallengeOf(type: number, c: RelayChallenge): Uint8Array {
  if (c.relayPublicRaw.length !== PUBKEY_BYTES) throw new Error(t('relay の公開鍵の長さが違います', 'Wrong relay public key length'))
  if (c.nonce.length !== RELAY_NONCE_BYTES) throw new Error(t('nonce の長さが違います', 'Wrong nonce length'))
  const out = new Uint8Array(CHALLENGE_BYTES)
  out[0] = RELAY_AUTH_V
  out[1] = type
  out.set(c.relayPublicRaw, 2)
  out.set(c.nonce, 2 + PUBKEY_BYTES)
  return out
}

function decodeChallengeOf(type: number, bytes: Uint8Array): AuthDecoded<RelayChallenge> {
  if (bytes.length !== CHALLENGE_BYTES) return { ok: false, reason: t('長さが違います', 'Wrong length') }
  if (bytes[0] !== RELAY_AUTH_V) return { ok: false, reason: t('知らない版です', 'Unknown version') }
  if (bytes[1] !== type) return { ok: false, reason: t('種別が違います', 'Wrong type') }
  return {
    ok: true,
    value: {
      relayPublicRaw: bytes.slice(2, 2 + PUBKEY_BYTES),
      nonce: bytes.slice(2 + PUBKEY_BYTES),
    },
  }
}

export function encodeChallenge(c: RelayChallenge): Uint8Array {
  return encodeChallengeOf(RELAY_AUTH.challenge, c)
}

export function decodeChallenge(bytes: Uint8Array): AuthDecoded<RelayChallenge> {
  return decodeChallengeOf(RELAY_AUTH.challenge, bytes)
}

/** ★ relay → phone (⚠️ an agent challenge does not decode as one, and vice versa: the type byte differs) */
export function encodeDeviceChallenge(c: RelayChallenge): Uint8Array {
  return encodeChallengeOf(RELAY_AUTH.deviceChallenge, c)
}

export function decodeDeviceChallenge(bytes: Uint8Array): AuthDecoded<RelayChallenge> {
  return decodeChallengeOf(RELAY_AUTH.deviceChallenge, bytes)
}

export interface DeviceProof {
  /** The phone's static public key (raw). relay verifies the proof with it and keys the free-tier ledger by it */
  devicePublicRaw: Uint8Array
  /** `relayProof(phone private key, relay ephemeral public key, nonce)` */
  tag: Uint8Array
}

export function encodeDeviceProof(p: DeviceProof): Uint8Array {
  if (p.devicePublicRaw.length !== PUBKEY_BYTES) throw new Error(t('端末の公開鍵の長さが違います', 'Wrong device public key length'))
  if (p.tag.length !== RELAY_TAG_BYTES) throw new Error(t('証明の長さが違います', 'Wrong proof length'))
  const out = new Uint8Array(DEVICE_PROOF_BYTES)
  out[0] = RELAY_AUTH_V
  out[1] = RELAY_AUTH.deviceProof
  out.set(p.devicePublicRaw, 2)
  out.set(p.tag, 2 + PUBKEY_BYTES)
  return out
}

export function decodeDeviceProof(bytes: Uint8Array): AuthDecoded<DeviceProof> {
  if (bytes.length !== DEVICE_PROOF_BYTES) return { ok: false, reason: t('長さが違います', 'Wrong length') }
  if (bytes[0] !== RELAY_AUTH_V) return { ok: false, reason: t('知らない版です', 'Unknown version') }
  if (bytes[1] !== RELAY_AUTH.deviceProof) return { ok: false, reason: t('種別が違います', 'Wrong type') }
  return { ok: true, value: { devicePublicRaw: bytes.slice(2, 2 + PUBKEY_BYTES), tag: bytes.slice(2 + PUBKEY_BYTES) } }
}

export function encodeProof(tag: Uint8Array): Uint8Array {
  if (tag.length !== RELAY_TAG_BYTES) throw new Error(t('証明の長さが違います', 'Wrong proof length'))
  const out = new Uint8Array(PROOF_BYTES)
  out[0] = RELAY_AUTH_V
  out[1] = RELAY_AUTH.proof
  out.set(tag, 2)
  return out
}

export function decodeProof(bytes: Uint8Array): AuthDecoded<Uint8Array> {
  if (bytes.length !== PROOF_BYTES) return { ok: false, reason: t('長さが違います', 'Wrong length') }
  if (bytes[0] !== RELAY_AUTH_V) return { ok: false, reason: t('知らない版です', 'Unknown version') }
  if (bytes[1] !== RELAY_AUTH.proof) return { ok: false, reason: t('種別が違います', 'Wrong type') }
  return { ok: true, value: bytes.slice(2) }
}
