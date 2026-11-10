// Step 6 ④a of ③: proof that the agent owns its key (`shared/relayAuth.ts` + `relayProof` in `shared/crypto.ts`).
//
// ★★ Mutations **targeted by name** here:
//   ① the proof is not "only producible by whoever holds the private key" (passes with another key)
//   ② the nonce is ignored (= **a proof from another connection can be reused**)
//   ③ relay's ephemeral key is ignored (same)
//   ④ it uses **the same inputs** as the E2E key derivation (`info` mix-up)
//   ⑤ version, type or length are not checked / decode throws
//   ⑥ ★★★ (v2 / 2026-11-10) the proof is not bound to the relay host, the room or the role, or the relay accepts v1

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ECDH_PARAMS,
  PUBKEY_BYTES,
  exportPublicKey,
  fromBase64Url,
  generateDeviceKey,
  relayProof,
  relayProofInfo,
  sameBytes,
  type RelayProofContext,
  toBase64Url,
} from './crypto.ts'
import {
  RELAY_AUTH,
  RELAY_AUTH_V,
  RELAY_AUTH_V1,
  RELAY_NONCE_BYTES,
  RELAY_TAG_BYTES,
  decodeChallenge,
  decodeDeviceChallenge,
  decodeDeviceProof,
  decodeProof,
  encodeChallenge,
  encodeDeviceChallenge,
  encodeDeviceProof,
  encodeProof,
  answerContext,
  relayBinding,
} from './relayAuth.ts'

function nonce(fill = 7): Uint8Array {
  return new Uint8Array(RELAY_NONCE_BYTES).fill(fill)
}

/** ★ A v2 context for tests where the binding itself is not the subject */
const AG: RelayProofContext = { v: 2, role: 'agent', host: 'relay.example.com', room: 'ROOM' }
const DV: RelayProofContext = { v: 2, role: 'device', host: 'relay.example.com', room: 'ROOM' }

test('★★ only the private-key holder can produce the same proof', async () => {
  const agent = await generateDeviceKey()
  const relay = await generateDeviceKey()
  const agentRaw = await exportPublicKey(agent.publicKey)
  const relayRaw = await exportPublicKey(relay.publicKey)
  const n = nonce()

  // ★ The agent side (own private key × relay ephemeral public key) and
  //   the relay side (ephemeral private key × agent public key) give **the same value**
  const fromAgent = await relayProof(agent.privateKey, relayRaw, n, AG)
  const fromRelay = await relayProof(relay.privateKey, agentRaw, n, AG)
  assert.ok(sameBytes(fromAgent, fromRelay), 'the two sides produced different proofs')
  assert.equal(fromAgent.length, RELAY_TAG_BYTES)

  // ⚠️⚠️ **Another key cannot produce it** (= knowing the public key is not enough to claim the identity)
  const impostor = await generateDeviceKey()
  const fake = await relayProof(impostor.privateKey, relayRaw, n, AG)
  assert.equal(sameBytes(fake, fromRelay), false, '⚠️⚠️ a proof from another key passed')
})

test('★★ the proof changes when the nonce or relay ephemeral key changes (replays do not work)', async () => {
  const agent = await generateDeviceKey()
  const relay = await generateDeviceKey()
  const relayRaw = await exportPublicKey(relay.publicKey)

  const a = await relayProof(agent.privateKey, relayRaw, nonce(1), AG)
  const b = await relayProof(agent.privateKey, relayRaw, nonce(2), AG)
  assert.equal(sameBytes(a, b), false, '⚠️⚠️ nonce is ignored (an earlier proof can be reused)')

  const relay2 = await generateDeviceKey()
  const c = await relayProof(agent.privateKey, await exportPublicKey(relay2.publicKey), nonce(1), AG)
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
  const p = encodeProof(tag, RELAY_AUTH_V)
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
  assert.equal(decodeChallenge(encodeProof(new Uint8Array(RELAY_TAG_BYTES), RELAY_AUTH_V)).ok, false)
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
  assert.throws(() => encodeProof(new Uint8Array(3), RELAY_AUTH_V), /証明/)
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
const KAT_TAG_V2 = 'VCmIUhUInn4lJdr6Vue_NfvuhHhZRFQFJ5xXttOIurI'

test('★★ known answer for the proof (⚠️ a failure means "the construction changed")', async () => {
  const priv = await crypto.subtle.importKey('jwk', KAT_PRIVATE_JWK, ECDH_PARAMS, false, [
    'deriveBits',
  ])
  const nonce = new Uint8Array(32)
  for (let i = 0; i < 32; i++) nonce[i] = i
  // ★ v1 is still answered (old self-hosted relays), so its construction is pinned too
  const tag = await relayProof(priv, fromBase64Url(KAT_PEER_PUBLIC), nonce, { v: 1 })
  assert.equal(toBase64Url(tag), KAT_TAG)
  // ★★ v2 (2026-11-10): role, host and room in `info`
  const v2 = await relayProof(priv, fromBase64Url(KAT_PEER_PUBLIC), nonce, {
    v: 2,
    role: 'device',
    host: 'relay.example.com',
    room: KAT_PEER_PUBLIC,
  })
  assert.equal(toBase64Url(v2), KAT_TAG_V2)
})

test('★★ reject messages with the same length and version but "only the type" broken', () => {
  const relayRaw = new Uint8Array(PUBKEY_BYTES).fill(4)
  const challenge = encodeChallenge({ relayPublicRaw: relayRaw, nonce: nonce(5) })
  const proof = encodeProof(new Uint8Array(RELAY_TAG_BYTES).fill(6), RELAY_AUTH_V)

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

// ─── ★★ The phone's proof (2026-09-27 / the free tier without sign-in) ───────────────────────────

test('★★ the phone challenge and proof have their own types: never read as the agent\'s, nor as each other', async () => {
  const relay = await generateDeviceKey()
  const relayRaw = await exportPublicKey(relay.publicKey)
  const n = nonce(3)
  const dc = encodeDeviceChallenge({ relayPublicRaw: relayRaw, nonce: n })
  assert.deepEqual([dc[0], dc[1]], [RELAY_AUTH_V, RELAY_AUTH.deviceChallenge])
  assert.equal(dc.length, 2 + PUBKEY_BYTES + RELAY_NONCE_BYTES)
  const back = decodeDeviceChallenge(dc)
  assert.ok(back.ok)
  assert.ok(sameBytes(back.value.relayPublicRaw, relayRaw) && sameBytes(back.value.nonce, n))
  // ⚠️⚠️ The same bytes with the agent's type do not decode as a phone challenge (and vice versa): the type byte is the only difference,
  //    so the phone can tell the challenge from the agent's handshake reply (type 1) by that byte alone
  assert.equal(decodeDeviceChallenge(encodeChallenge({ relayPublicRaw: relayRaw, nonce: n })).ok, false)
  assert.equal(decodeChallenge(dc).ok, false)
  assert.notEqual(RELAY_AUTH.deviceChallenge, 1, '⚠️ type 1 is the tunnel\'s handshake reply on the phone wire')
  assert.notEqual(RELAY_AUTH.deviceProof, 0, '⚠️ type 0 is the tunnel\'s handshake init on the phone wire')

  const phone = await generateDeviceKey()
  const phoneRaw = await exportPublicKey(phone.publicKey)
  const tag = await relayProof(phone.privateKey, relayRaw, n, DV)
  const dp = encodeDeviceProof({ devicePublicRaw: phoneRaw, tag, v: RELAY_AUTH_V })
  assert.deepEqual([dp[0], dp[1]], [RELAY_AUTH_V, RELAY_AUTH.deviceProof])
  assert.equal(dp.length, 2 + PUBKEY_BYTES + RELAY_TAG_BYTES)
  const proof = decodeDeviceProof(dp)
  assert.ok(proof.ok)
  assert.ok(sameBytes(proof.value.devicePublicRaw, phoneRaw) && sameBytes(proof.value.tag, tag))
  // ★ relay verifies with the key **inside** the message and its own ephemeral private key
  assert.ok(sameBytes(await relayProof(relay.privateKey, proof.value.devicePublicRaw, n, DV), proof.value.tag))
  assert.equal(decodeProof(dp).ok, false)
  assert.equal(decodeDeviceProof(encodeProof(tag, RELAY_AUTH_V)).ok, false)
})

test('★★ phone frames: wrong length, version or type are refused without throwing; wrong lengths cannot be encoded', () => {
  const good = encodeDeviceProof({ devicePublicRaw: new Uint8Array(PUBKEY_BYTES).fill(4), tag: new Uint8Array(RELAY_TAG_BYTES).fill(5), v: RELAY_AUTH_V })
  assert.equal(decodeDeviceProof(good.slice(0, -1)).ok, false)
  const badV = new Uint8Array(good)
  badV[0] = 9
  assert.equal(decodeDeviceProof(badV).ok, false)
  assert.equal(decodeDeviceProof(new Uint8Array(0)).ok, false)
  assert.equal(decodeDeviceChallenge(new Uint8Array(0)).ok, false)
  assert.throws(() => encodeDeviceProof({ devicePublicRaw: new Uint8Array(64), tag: new Uint8Array(RELAY_TAG_BYTES), v: RELAY_AUTH_V }))
  assert.throws(() => encodeDeviceProof({ devicePublicRaw: new Uint8Array(PUBKEY_BYTES), tag: new Uint8Array(31), v: RELAY_AUTH_V }))
  assert.throws(() => encodeDeviceChallenge({ relayPublicRaw: new Uint8Array(64), nonce: nonce() }))
})

// ─── ★★★ v2: the proof is bound to the relay host, the room and the role (2026-11-10 / security check) ───────

test('★★★ v2: a proof made for another relay host, room or role does not verify (the forwarding attack)', async () => {
  const phone = await generateDeviceKey()
  const relay = await generateDeviceKey()
  const relayRaw = await exportPublicKey(relay.publicKey)
  const phoneRaw = await exportPublicKey(phone.publicKey)
  const n = nonce(4)
  const ours: RelayProofContext = { v: 2, role: 'device', host: 'relay.nyan-remote.example', room: 'ROOM_A' }
  // ★ What our relay checks against (its own host, the room the wire came to)
  const expected = await relayProof(relay.privateKey, phoneRaw, n, ours)
  assert.ok(sameBytes(await relayProof(phone.privateKey, relayRaw, n, ours), expected))
  // ⚠️⚠️ A relay forwarding our challenge gets a proof bound to **its** host = refused here
  for (const other of [
    { ...ours, host: 'evil.example' },
    { ...ours, room: 'ROOM_B' },
    { ...ours, role: 'agent' as const },
    { v: 1 as const },
  ]) {
    const forwarded = await relayProof(phone.privateKey, relayRaw, n, other)
    assert.equal(sameBytes(forwarded, expected), false, `⚠️⚠️ not bound: ${JSON.stringify(other)}`)
  }
})

test('★★★ the relay accepts only v2 proofs (accepting v1 would let a forwarding relay downgrade)', () => {
  const tag = new Uint8Array(RELAY_TAG_BYTES).fill(6)
  assert.equal(decodeProof(encodeProof(tag, RELAY_AUTH_V)).ok, true)
  assert.equal(decodeProof(encodeProof(tag, RELAY_AUTH_V1)).ok, false, '⚠️⚠️ v1 agent proof accepted')
  const devicePublicRaw = new Uint8Array(PUBKEY_BYTES).fill(4)
  assert.equal(decodeDeviceProof(encodeDeviceProof({ devicePublicRaw, tag, v: RELAY_AUTH_V })).ok, true)
  assert.equal(decodeDeviceProof(encodeDeviceProof({ devicePublicRaw, tag, v: RELAY_AUTH_V1 })).ok, false, '⚠️⚠️ v1 phone proof accepted')
  assert.equal(RELAY_AUTH_V, 2)
})

test('★★ challenges: this relay sends v2; v1 (an old relay) still decodes and says so, so it is answered in v1', async () => {
  const relayPublicRaw = new Uint8Array(PUBKEY_BYTES).fill(4)
  const c2 = decodeChallenge(encodeChallenge({ relayPublicRaw, nonce: nonce() }))
  assert.ok(c2.ok && c2.value.v === RELAY_AUTH_V)
  const c1 = decodeChallenge(encodeChallenge({ relayPublicRaw, nonce: nonce() }, RELAY_AUTH_V1))
  assert.ok(c1.ok && c1.value.v === RELAY_AUTH_V1)
  const d1 = decodeDeviceChallenge(encodeDeviceChallenge({ relayPublicRaw, nonce: nonce() }, RELAY_AUTH_V1))
  assert.ok(d1.ok && d1.value.v === RELAY_AUTH_V1)
  const b = { host: 'h.example', room: 'R' }
  assert.deepEqual(answerContext(RELAY_AUTH_V1, 'agent', b), { v: 1 })
  assert.deepEqual(answerContext(RELAY_AUTH_V, 'device', b), { v: 2, role: 'device', host: 'h.example', room: 'R' })
})

test('★★ relayBinding: the same host for every side (case and the default port do not matter; the room is `a`)', () => {
  assert.deepEqual(relayBinding('wss://Relay.Example.COM/v1/agent?a=KEY&c=1'), { host: 'relay.example.com', room: 'KEY' })
  assert.deepEqual(relayBinding('wss://relay.example.com:443/v1/device?a=KEY&p=1'), { host: 'relay.example.com', room: 'KEY' })
  assert.deepEqual(relayBinding('ws://127.0.0.1:8787/v1/device?a=KEY'), { host: '127.0.0.1:8787', room: 'KEY' })
  assert.equal(relayBinding('https://relay.example.com/v1/agent?a=KEY').host, 'relay.example.com')
  // ⚠️ no room = an empty one, which `relayProofInfo` refuses (= no proof is produced, the wire fails closed)
  assert.equal(relayBinding('wss://relay.example.com/v1/agent').room, '')
})

test('★★ relayProofInfo: refuses an empty host or room and NUL inside a field (fields must not run into each other)', () => {
  assert.throws(() => relayProofInfo({ v: 2, role: 'agent', host: '', room: 'R' }))
  assert.throws(() => relayProofInfo({ v: 2, role: 'agent', host: 'h', room: '' }))
  assert.throws(() => relayProofInfo({ v: 2, role: 'agent', host: 'h\0agent', room: 'R' }))
  assert.equal(new TextDecoder().decode(relayProofInfo({ v: 1 })), 'nyan-relay-auth1')
  assert.equal(new TextDecoder().decode(relayProofInfo({ v: 2, role: 'device', host: 'h', room: 'R' })), 'nyan-relay-auth2\0device\0h\0R')
})
