// Step 6 ④a of ③: proof that the agent owns its key (`shared/relayAuth.ts` + `relayProof` in `shared/crypto.ts`).
//
// ★★ Mutations **targeted by name** here:
//   ① the proof is not "only producible by whoever holds the private key" (passes with another key)
//   ② the nonce is ignored (= **a proof from another connection can be reused**)
//   ③ relay's ephemeral key is ignored (same)
//   ④ it uses **the same inputs** as the E2E key derivation (`info` mix-up)
//   ⑤ version, type or length are not checked / decode throws

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ECDH_PARAMS,
  PUBKEY_BYTES,
  exportPublicKey,
  fromBase64Url,
  generateDeviceKey,
  relayProof,
  sameBytes,
  toBase64Url,
} from './crypto.ts'
import {
  RELAY_AUTH,
  RELAY_AUTH_V,
  RELAY_NONCE_BYTES,
  RELAY_TAG_BYTES,
  decodeChallenge,
  decodeProof,
  encodeChallenge,
  encodeProof,
} from './relayAuth.ts'

function nonce(fill = 7): Uint8Array {
  return new Uint8Array(RELAY_NONCE_BYTES).fill(fill)
}

test('★★ only the private-key holder can produce the same proof', async () => {
  const agent = await generateDeviceKey()
  const relay = await generateDeviceKey()
  const agentRaw = await exportPublicKey(agent.publicKey)
  const relayRaw = await exportPublicKey(relay.publicKey)
  const n = nonce()

  // ★ The agent side (own private key × relay ephemeral public key) and
  //   the relay side (ephemeral private key × agent public key) give **the same value**
  const fromAgent = await relayProof(agent.privateKey, relayRaw, n)
  const fromRelay = await relayProof(relay.privateKey, agentRaw, n)
  assert.ok(sameBytes(fromAgent, fromRelay), 'the two sides produced different proofs')
  assert.equal(fromAgent.length, RELAY_TAG_BYTES)

  // ⚠️⚠️ **Another key cannot produce it** (= knowing the public key is not enough to claim the identity)
  const impostor = await generateDeviceKey()
  const fake = await relayProof(impostor.privateKey, relayRaw, n)
  assert.equal(sameBytes(fake, fromRelay), false, '⚠️⚠️ a proof from another key passed')
})

test('★★ the proof changes when the nonce or relay ephemeral key changes (replays do not work)', async () => {
  const agent = await generateDeviceKey()
  const relay = await generateDeviceKey()
  const relayRaw = await exportPublicKey(relay.publicKey)

  const a = await relayProof(agent.privateKey, relayRaw, nonce(1))
  const b = await relayProof(agent.privateKey, relayRaw, nonce(2))
  assert.equal(sameBytes(a, b), false, '⚠️⚠️ nonce is ignored (an earlier proof can be reused)')

  const relay2 = await generateDeviceKey()
  const c = await relayProof(agent.privateKey, await exportPublicKey(relay2.publicKey), nonce(1))
  assert.equal(sameBytes(a, c), false, '⚠️⚠️ relay ephemeral key is ignored')
})

test('★★ frame round trip (★ contents do not change by a single byte)', async () => {
  const relay = await generateDeviceKey()
  const relayPublicRaw = await exportPublicKey(relay.publicKey)
  const n = nonce(3)
  const frame = encodeChallenge({ relayPublicRaw, nonce: n })
  // ★ Look at the exact bytes the implementation produced
  assert.equal(frame.length, 2 + PUBKEY_BYTES + RELAY_NONCE_BYTES)
  assert.equal(frame[0], RELAY_AUTH_V)
  assert.equal(frame[1], RELAY_AUTH.challenge)
  const back = decodeChallenge(frame)
  assert.ok(back.ok)
  assert.deepEqual([...back.value.relayPublicRaw], [...relayPublicRaw])
  assert.deepEqual([...back.value.nonce], [...n])

  const tag = new Uint8Array(RELAY_TAG_BYTES).fill(9)
  const p = encodeProof(tag)
  assert.equal(p[1], RELAY_AUTH.proof)
  const pb = decodeProof(p)
  assert.ok(pb.ok)
  assert.deepEqual([...pb.value], [...tag])
})

test('★★ decode never throws (does not break the receiver)', () => {
  const bad = [
    new Uint8Array(0),
    new Uint8Array(99).fill(0),
    new Uint8Array(34).fill(0),
    new Uint8Array([RELAY_AUTH_V, RELAY_AUTH.proof]),
    new Uint8Array([RELAY_AUTH_V + 1, RELAY_AUTH.challenge, ...new Uint8Array(97)]),
  ]
  for (const bytes of bad) {
    const c = decodeChallenge(bytes)
    const p = decodeProof(bytes)
    assert.equal(c.ok && p.ok, false)
    if (!c.ok) assert.ok(c.reason.length > 0, 'empty reason')
    if (!p.ok) assert.ok(p.reason.length > 0, 'empty reason')
  }
  // ⚠️ Reject mixed-up types (a proof shaped like a challenge, and the reverse)
  const relayRaw = new Uint8Array(PUBKEY_BYTES).fill(4)
  const challenge = encodeChallenge({ relayPublicRaw: relayRaw, nonce: nonce() })
  assert.equal(decodeProof(challenge).ok, false)
  assert.equal(decodeChallenge(encodeProof(new Uint8Array(RELAY_TAG_BYTES))).ok, false)
})

test('★★ sender-side mistakes throw (length)', () => {
  assert.throws(
    () => encodeChallenge({ relayPublicRaw: new Uint8Array(3), nonce: nonce() }),
    /公開鍵/,
  )
  assert.throws(
    () => encodeChallenge({ relayPublicRaw: new Uint8Array(PUBKEY_BYTES), nonce: new Uint8Array(3) }),
    /nonce/,
  )
  assert.throws(() => encodeProof(new Uint8Array(3)), /証明/)
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ Known answers (KAT). **Both sides share the code, so changing the inputs keeps the happy path green**
//   (same reason as the KAT in `shared/crypto.test.ts` / called out by name in codex round 4 on 2026-09-15).
//
// ⚠️⚠️ If this fails, it is not "a bug" but a sign that **the way the proof is built changed**:
//   ① HKDF `info` (`'nyan-relay-auth1'`. ⚠️ must **never mix** with the E2E
//     `'nyan1 d2a'` / `'nyan1 a2d'`) ② the salt is the nonce ③ length 32 ④ ECDH P-256
//   ⇒ If you change it, **deploy relay first** (it would disagree with the deployed relay).
// ─────────────────────────────────────────────────────────────────────────────

/** ⚠️ Fixed keys (test only. **Not production keys**) */
const KAT_PRIVATE_JWK = {
  kty: 'EC',
  crv: 'P-256',
  x: 'cs2Im5AteAyqjESj57y4yrTKE8mftxzha4SXDFct7N8',
  y: 'IDRgF2uGiIdaHfY8ONWLY37cTNb3gzCwDJ811dO1tBQ',
  d: '6Bha9uz22PSv9YDR4ewoZ8lc_ExRN9ODgxHLfjNGqIA',
}
const KAT_PEER_PUBLIC = 'BKAYTYDnrvPIq4sxDN1-NMb_FI6zA2C7BuixPwC3HyYUqk5rVEcLaL39ySvM4uhJ-d-m7nesWYkjDj16LGZc7BI'
const KAT_TAG = 'GGTEQ0JJpKBMpfCVsjE44yuW_cwhnXGJsgIN1vEt_JA'

test('★★ known answer for the proof (⚠️ a failure means "the construction changed")', async () => {
  const priv = await crypto.subtle.importKey('jwk', KAT_PRIVATE_JWK, ECDH_PARAMS, false, [
    'deriveBits',
  ])
  const nonce = new Uint8Array(32)
  for (let i = 0; i < 32; i++) nonce[i] = i
  const tag = await relayProof(priv, fromBase64Url(KAT_PEER_PUBLIC), nonce)
  assert.equal(toBase64Url(tag), KAT_TAG)
})

test('★★ reject messages with the same length and version but "only the type" broken', () => {
  const relayRaw = new Uint8Array(PUBKEY_BYTES).fill(4)
  const challenge = encodeChallenge({ relayPublicRaw: relayRaw, nonce: nonce(5) })
  const proof = encodeProof(new Uint8Array(RELAY_TAG_BYTES).fill(6))

  // ⚠️ Keep the length **as is** and swap only the type, so it does not fail on length (= reaches the check)
  for (const [bytes, decode] of [
    [challenge, decodeChallenge],
    [proof, decodeProof],
  ] as const) {
    const badType = new Uint8Array(bytes)
    badType[1] = 99
    assert.equal(decode(badType).ok, false, 'type is not checked')
    const badV = new Uint8Array(bytes)
    badV[0] = RELAY_AUTH_V + 1
    assert.equal(decode(badV).ok, false, 'version is not checked')
  }
})
