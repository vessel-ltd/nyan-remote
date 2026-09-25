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
} as const

/** ⚠️ Fresh per connection (= replays do not work) */
export const RELAY_NONCE_BYTES = 32
/** ★ Length produced by `relayProof` (256 bits of HKDF-SHA256) */
export const RELAY_TAG_BYTES = 32

const CHALLENGE_BYTES = 2 + PUBKEY_BYTES + RELAY_NONCE_BYTES
const PROOF_BYTES = 2 + RELAY_TAG_BYTES

export interface RelayChallenge {
  /** relay's **ephemeral** public key (⚠️ discarded per connection) */
  relayPublicRaw: Uint8Array
  nonce: Uint8Array
}

export type AuthDecoded<T> = { ok: true; value: T } | { ok: false; reason: string }

export function encodeChallenge(c: RelayChallenge): Uint8Array {
  if (c.relayPublicRaw.length !== PUBKEY_BYTES) throw new Error(t('relay の公開鍵の長さが違います', 'Wrong relay public key length'))
  if (c.nonce.length !== RELAY_NONCE_BYTES) throw new Error(t('nonce の長さが違います', 'Wrong nonce length'))
  const out = new Uint8Array(CHALLENGE_BYTES)
  out[0] = RELAY_AUTH_V
  out[1] = RELAY_AUTH.challenge
  out.set(c.relayPublicRaw, 2)
  out.set(c.nonce, 2 + PUBKEY_BYTES)
  return out
}

export function decodeChallenge(bytes: Uint8Array): AuthDecoded<RelayChallenge> {
  if (bytes.length !== CHALLENGE_BYTES) return { ok: false, reason: t('長さが違います', 'Wrong length') }
  if (bytes[0] !== RELAY_AUTH_V) return { ok: false, reason: t('知らない版です', 'Unknown version') }
  if (bytes[1] !== RELAY_AUTH.challenge) return { ok: false, reason: t('種別が違います', 'Wrong type') }
  return {
    ok: true,
    value: {
      relayPublicRaw: bytes.slice(2, 2 + PUBKEY_BYTES),
      nonce: bytes.slice(2 + PUBKEY_BYTES),
    },
  }
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
