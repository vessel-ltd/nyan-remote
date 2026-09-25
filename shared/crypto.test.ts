// ★★ E2E for ③ (`shared/crypto.ts` / ARCHITECTURE §14.1.2).
//
// ⚠️⚠️ **The negative tests are the point.** Crypto that merely "works" is easy to write and **stays green while broken**
//    (tampering passes, replays pass, impostors pass: all of it slips past "the happy path works" tests).
// ⇒ Lists the table of §14.1.2.9 as-is.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  FRAME,
  HEADER_BYTES,
  PUBKEY_BYTES,
  ECDH_PARAMS,
  MAX_COUNTER,
  __forTest,
  __unsafeSessionForTest,
  acceptHandshake,
  exportPublicKey,
  fingerprint,
  finishHandshake,
  generateDeviceKey,
  matchesKeyPair,
  sameBytes,
  startHandshake,
  toBase64Url,
  fromBase64Url,
  type Key,
  type Session,
} from './crypto.ts'
import { exportPrivateKey, generateAgentKey, importKeyPair } from '../agent/src/agentKey.ts'
import type { Jwk } from './crypto.ts'

/** Actually handshake and return both sides' sessions */
async function pair(): Promise<{
  device: Session
  agent: Session
  agentStatic: Awaited<ReturnType<typeof generateAgentKey>>
  deviceStatic: Awaited<ReturnType<typeof generateAgentKey>>
}> {
  const agentStatic = await generateAgentKey()
  const deviceStatic = await generateDeviceKey()
  const agentPub = await exportPublicKey(agentStatic.publicKey)
  const h = await startHandshake(deviceStatic, agentPub)
  const { message: reply, confirm, session: agent } = await acceptHandshake(agentStatic, h.message, ALLOW)
  // ★ A `Session` is only obtainable through the confirm frame (codex round 4, medium #2)
  const device = await (await finishHandshake(h, reply)).accept(confirm)
  return { device, agent, agentStatic, deviceStatic }
}

/** Lets everything through (for the happy path). ⚠️ The registration check itself has dedicated tests */
const ALLOW = (): boolean => true

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
/** Flip the last bit (tampering). ⚠️ Index access can be `undefined`, so keep it inside a function */
function flipLast(b: Uint8Array): Uint8Array {
  const at = b.length - 1
  b.set([(b.at(at) ?? 0) ^ 1], at)
  return b
}
const dec = (b: Uint8Array): string => new TextDecoder().decode(b)

// ─────────────────────────────────────────────────────────────────────────────
// Happy path (this alone protects nothing)
// ─────────────────────────────────────────────────────────────────────────────

test('★★ handshake, and contents pass in both directions', async () => {
  const { device, agent } = await pair()
  const f1 = await device.seal(FRAME.request, enc('こんにちは'))
  assert.equal(dec((await agent.open(f1)).plaintext), 'こんにちは')
  const f2 = await agent.seal(FRAME.response, enc('やあ'))
  assert.equal(dec((await device.open(f2)).plaintext), 'やあ')
})

test('★★ the frame type is preserved (it carries the type, not just the body)', async () => {
  const { device, agent } = await pair()
  const f = await agent.seal(FRAME.event, enc('x'))
  assert.equal((await device.open(f)).type, FRAME.event)
})

test('★★ plaintext does not appear in the frame (forgetting to encrypt keeps the happy path green)', async () => {
  const { device } = await pair()
  const secret = 'コミットしてはいけない秘密の文章'
  const f = await device.seal(FRAME.request, enc(secret))
  assert.ok(!dec(f).includes(secret), 'plaintext is in there as-is')
  // ★ Even after subtracting the header, the AEAD tag always makes it longer
  assert.ok(f.length > HEADER_BYTES + enc(secret).length, 'no tag attached')
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ Negative tests (the table of §14.1.2.9)
// ─────────────────────────────────────────────────────────────────────────────

test('★★ ciphertext with one tampered byte cannot be decrypted', async () => {
  const { device, agent } = await pair()
  const f = await device.seal(FRAME.request, enc('たいせつな指示'))
  flipLast(f)
  await assert.rejects(agent.open(f), 'tampering passed')
})

test('★★ tampering with the header also fails decryption (the header is in the AAD)', async () => {
  // ⚠️ Forgetting the header in the AAD lets **only the type be swapped** (turning a request into a close, etc.)
  const { device, agent } = await pair()
  const f = await device.seal(FRAME.request, enc('x'))
  f[1] = FRAME.close
  await assert.rejects(agent.open(f), 'swapping the type passed')
})

test('★★ resending the same frame is rejected', async () => {
  const { device, agent } = await pair()
  const f = await device.seal(FRAME.request, enc('二重に届いてはいけない指示'))
  await agent.open(f)
  await assert.rejects(agent.open(f), /カウンタ/, 'the resend passed')
})

test('★★ a frame with a rewound counter is rejected', async () => {
  const { device, agent } = await pair()
  const a = await device.seal(FRAME.request, enc('1'))
  const b = await device.seal(FRAME.request, enc('2'))
  await agent.open(b)
  // ⚠️ The order was swapped (= an attacker replayed an old one later)
  await assert.rejects(agent.open(a), /カウンタ/, 'an old frame passed')
})

test('★★ a frame that fails decryption does not advance the counter (the correct next one would be dropped)', async () => {
  // ⚠️⚠️ "Remember only on success". Advancing on failure makes **the real next frame get
  //    dropped as "counter went backwards"** (same trap as `shouldSendLabel` for keystrokes).
  const { device, agent } = await pair()
  const ok = await device.seal(FRAME.request, enc('本物'))
  const bad = new Uint8Array(ok)
  flipLast(bad)
  await assert.rejects(agent.open(bad))
  assert.equal(dec((await agent.open(ok)).plaintext), '本物', 'dropped the genuine frame too')
})

test('★★ a different device key does not agree on the key (impersonation)', async () => {
  const agentStatic = await generateAgentKey()
  const agentPub = await exportPublicKey(agentStatic.publicKey)
  const honest = await generateDeviceKey()
  const attacker = await generateDeviceKey()

  // The attacker starts a handshake claiming "the honest party's public key" (holding only its own private key)
  // ⚠️ Replace the "static public key" field of the first message (65B from byte 2) with the honest party's
  const h = await startHandshake(attacker, agentPub)
  const forgedMessage = new Uint8Array(h.message)
  forgedMessage.set(await exportPublicKey(honest.publicKey), 2)
  const { message: reply, confirm } = await acceptHandshake(agentStatic, forgedMessage, ALLOW)
  const pending = await finishHandshake(h, reply)
  // ★ The keys do not match, so even the confirm frame cannot be opened (= stops before any request is sent)
  await assert.rejects(pending.accept(confirm), 'impersonation passed')
})

test('★★ an agent that is not the addressee rejects the handshake (does not proceed silently)', async () => {
  // ⚠️ Without rejecting, it would go unnoticed until "cannot decrypt", with no reason given
  const realAgent = await generateAgentKey()
  const otherAgent = await generateAgentKey()
  const device = await generateDeviceKey()
  const h = await startHandshake(device, await exportPublicKey(otherAgent.publicKey))
  await assert.rejects(
    acceptHandshake(realAgent, h.message, ALLOW),
    /宛先/,
    'accepted a handshake addressed to another agent',
  )
})

test('★★ a second message with a swapped transcript does not agree on the key', async () => {
  // ⚠️⚠️ Forgetting the transcript in the salt gives **the same key even if a field midway is swapped**
  const agentStatic = await generateAgentKey()
  const deviceStatic = await generateDeviceKey()
  const agentPub = await exportPublicKey(agentStatic.publicKey)
  const h = await startHandshake(deviceStatic, agentPub)
  const { message: reply, confirm } = await acceptHandshake(agentStatic, h.message, ALLOW)
  // Flip one bit of the second message's nonce before handing it to the device (key agreement inputs unchanged)
  const tampered = new Uint8Array(reply)
  flipLast(tampered)
  const pending = await finishHandshake(h, tampered)
  await assert.rejects(pending.accept(confirm), 'the transcript has no effect on the key')
})

test('★★ separate handshakes give separate keys (not reused even with the same static key = forward secrecy)', async () => {
  const agentStatic = await generateAgentKey()
  const deviceStatic = await generateDeviceKey()
  const agentPub = await exportPublicKey(agentStatic.publicKey)
  const one = async (): Promise<{ d: Session; a: Session }> => {
    const h = await startHandshake(deviceStatic, agentPub)
    const { message, confirm, session } = await acceptHandshake(agentStatic, h.message, ALLOW)
    return { d: await (await finishHandshake(h, message)).accept(confirm), a: session }
  }
  const s1 = await one()
  const s2 = await one()
  assert.ok(!sameBytes(s1.a.transcript, s2.a.transcript), 'same transcript (randomness has no effect)')
  // ★ A frame from the first session must not open in the second session
  const f = await s1.d.seal(FRAME.request, enc('前のセッションの中身'))
  await assert.rejects(s2.a.open(f), 'decrypted with the key of another session (keys are reused)')
})

test('★★ too-short frames and wrong versions are dropped', async () => {
  const { agent } = await pair()
  await assert.rejects(agent.open(new Uint8Array(HEADER_BYTES)), /短/)
  const bad = new Uint8Array(HEADER_BYTES + 20)
  bad[0] = 99
  await assert.rejects(agent.open(bad), /版/)
})

test('★★ broken handshake messages are dropped (length, version, type)', async () => {
  const agentStatic = await generateAgentKey()
  const deviceStatic = await generateDeviceKey()
  const h = await startHandshake(deviceStatic, await exportPublicKey(agentStatic.publicKey))
  await assert.rejects(acceptHandshake(agentStatic, h.message.slice(0, 10), ALLOW), /長さ/)
  const v = new Uint8Array(h.message)
  v[0] = 99
  await assert.rejects(acceptHandshake(agentStatic, v, ALLOW), /版/)
  const t = new Uint8Array(h.message)
  t[1] = 9
  await assert.rejects(acceptHandshake(agentStatic, t, ALLOW), /種別/)
  await assert.rejects(finishHandshake(h, new Uint8Array(3)), /長さ/)
})

test('★ no handshake starts if the agent public key has the wrong length', async () => {
  const deviceStatic = await generateDeviceKey()
  await assert.rejects(startHandshake(deviceStatic, new Uint8Array(10)), /長さ/)
})

// ─────────────────────────────────────────────────────────────────────────────
// Key handling
// ─────────────────────────────────────────────────────────────────────────────

test('★★ measured: an extractable:false private key cannot be extracted (this is what the PWA and app use)', async () => {
  // ⚠️⚠️ This is exactly why `@noble` was rejected (§14.1.2.2). XSS cannot exfiltrate the key
  const kp = await generateDeviceKey()
  await assert.rejects(exportPrivateKey(kp.privateKey), 'the private key was extracted')
  // ★ The public key can be extracted (otherwise it could not be handed to the peer)
  assert.equal((await exportPublicKey(kp.publicKey)).length, PUBKEY_BYTES)
})

test('★★ the agent key can be restored "from the file alone" (that is what a restart is)', async () => {
  // ⚠️⚠️ codex medium #1 of 2026-09-01. The previous version **reused the original `publicKey`**, so
  //    it never actually checked "restorable from the file alone".
  //    ⇒ Build the key pair **only from the JWK re-read from JSON**, and discard the original key.
  const original = await generateAgentKey()
  const originalPub = await exportPublicKey(original.publicKey)
  const onDisk = JSON.parse(JSON.stringify(await exportPrivateKey(original.privateKey))) as Jwk
  const restored = await importKeyPair(onDisk)
  // ★ The restored public key equals the original (otherwise it disagrees with the key in the QR and nobody connects)
  assert.ok(sameBytes(await exportPublicKey(restored.publicKey), originalPub), 'the public key changed')

  const deviceStatic = await generateDeviceKey()
  const h = await startHandshake(deviceStatic, originalPub)
  const { message, confirm, session: agent } = await acceptHandshake(restored, h.message, ALLOW)
  const device = await (await finishHandshake(h, message)).accept(confirm)
  assert.equal(dec((await agent.open(await device.seal(FRAME.request, enc('ok')))).plaintext), 'ok')
})

test('★ no key pair from a public-only JWK (do not succeed without `d`)', async () => {
  const kp = await generateAgentKey()
  const { d: _d, ...pub } = await exportPrivateKey(kp.privateKey)
  await assert.rejects(importKeyPair(pub as Jwk), /秘密鍵/)
})

test('★★ fingerprints differ per public key and are stable for the same key', async () => {
  const a = await exportPublicKey((await generateAgentKey()).publicKey)
  const b = await exportPublicKey((await generateAgentKey()).publicKey)
  assert.equal(await fingerprint(a), await fingerprint(a))
  assert.notEqual(await fingerprint(a), await fingerprint(b))
  // ⚠️ Do not use the key itself as the id (it must be a fingerprint)
  assert.ok(!(await fingerprint(a)).includes(toBase64Url(a)))
})

test('★ base64url round-trips (it goes into QR codes and JSON)', () => {
  const b = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255])
  const s = toBase64Url(b)
  assert.ok(!/[+/=]/.test(s), `contains characters that cannot go into a URL: ${s}`)
  assert.ok(sameBytes(fromBase64Url(s), b))
})

test('★★ sameBytes does not throw on length mismatch (the timingSafeEqual trap)', () => {
  assert.equal(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])), false)
  assert.equal(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3])), false)
  assert.equal(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true)
})


test('★★ a frame we sent cannot be opened by ourselves (reflection attack / separate keys per direction)', async () => {
  // ⚠️⚠️ Added because mutation ③ of 2026-09-01 **survived**. With the same key both ways:
  //   1. what we send can be **reflected straight back to us** (reflection)
  //   2. ★★ **AES-GCM nonces collide** (both counters start at 0, so
  //      two plaintexts get encrypted with the same key and same nonce = fatal)
  const { device, agent } = await pair()
  const f = await device.seal(FRAME.request, enc('反射してはいけない指示'))
  await assert.rejects(device.open(f), 'opened our own frame (same key both ways)')
  // ★ The peer can open it (= evidence the failure above is not just "because it is broken")
  assert.equal(dec((await agent.open(f)).plaintext), '反射してはいけない指示')
})

test('★★ same plaintext and same counter still give different ciphertext in the other direction (nonce collision)', async () => {
  const { device, agent } = await pair()
  const same = enc('まったく同じ本文')
  const a = await device.seal(FRAME.request, same)
  const b = await agent.seal(FRAME.request, same)
  // ⚠️ Both are counter 0. With the same key the AES-GCM nonce would collide and give **identical ciphertext**
  assert.ok(!sameBytes(a, b), 'the same key is used both ways (nonces collide)')
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ codex round 3 of 2026-09-01 (high #3 / medium #1 / low #2 + 7 surviving mutations)
// ─────────────────────────────────────────────────────────────────────────────

test('★★ opening the same frame concurrently passes only once (`open` is serialised)', async () => {
  // ⚠️⚠️ codex high #1. There is an `await decrypt` between checking and updating the counter, so
  //    without serialisation **both see `#lastIn === -1` and both succeed** (it passed in a measurement).
  //    ⇒ Non-idempotent requests (keystrokes, approval answers) **run twice**.
  const { device, agent } = await pair()
  const f = await device.seal(FRAME.request, enc('二重に実行してはいけない'))
  const r = await Promise.allSettled([agent.open(f), agent.open(f)])
  const ok = r.filter((x) => x.status === 'fulfilled').length
  assert.equal(ok, 1, `passed ${ok} times (replay protection breaks under concurrency)`)
})

test('★★ even when 1 then 0 arrive concurrently, the older one does not rewind the counter', async () => {
  // ⚠️ If the late-finishing 0 rewinds `#lastIn`, even a resend of 1 then passes (codex high #1)
  const { device, agent } = await pair()
  const f0 = await device.seal(FRAME.request, enc('0'))
  const f1 = await device.seal(FRAME.request, enc('1'))
  const r = await Promise.allSettled([agent.open(f1), agent.open(f0)])
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1, 'the old frame passed too')
  await assert.rejects(agent.open(f1), /カウンタ/, 'the resend passed (the counter was rewound)')
})

test('★★ after a decryption failure, later `open` calls still work (the chain is not broken)', async () => {
  const { device, agent } = await pair()
  const ok = await device.seal(FRAME.request, enc('本物'))
  const bad = flipLast(new Uint8Array(await device.seal(FRAME.request, enc('偽物'))))
  await assert.rejects(agent.open(bad))
  assert.equal(dec((await agent.open(ok)).plaintext), '本物', 'stopped working after a failure')
})

test('★★ a handshake is usable only once (no two sessions with the same key and counter 0)', async () => {
  // ⚠️⚠️ codex high #2. If two could be made, the same plaintext gives **exactly the same ciphertext frame**
  //    = AES-GCM key and nonce reuse (they came out identical in a measurement)
  const agentStatic = await generateAgentKey()
  const deviceStatic = await generateDeviceKey()
  const h = await startHandshake(deviceStatic, await exportPublicKey(agentStatic.publicKey))
  const { message } = await acceptHandshake(agentStatic, h.message, ALLOW)
  await finishHandshake(h, message)
  await assert.rejects(finishHandshake(h, message), /使われて/, 'the same handshake could be used twice')
})

test('★★ two concurrent `finishHandshake` calls: only one passes', async () => {
  // ⚠️ Setting the flag after the `await` lets both concurrent calls pass
  const agentStatic = await generateAgentKey()
  const deviceStatic = await generateDeviceKey()
  const h = await startHandshake(deviceStatic, await exportPublicKey(agentStatic.publicKey))
  const { message } = await acceptHandshake(agentStatic, h.message, ALLOW)
  const r = await Promise.allSettled([finishHandshake(h, message), finishHandshake(h, message)])
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1, 'both concurrent calls passed')
})

test('★★ an unregistered device cannot handshake (the check is enforced by type)', async () => {
  // ⚠️⚠️ codex high #3. `parseInit` used to be exported, with "the caller checks it" said
  //    **only in a comment** ⇒ miss it and an unknown device gets the key (it passed in a measurement)
  const agentStatic = await generateAgentKey()
  const stranger = await generateDeviceKey()
  const h = await startHandshake(stranger, await exportPublicKey(agentStatic.publicKey))
  await assert.rejects(
    acceptHandshake(agentStatic, h.message, () => false),
    /登録されていない/,
    'an unregistered device completed the handshake',
  )
})

test('★★ the check receives "the public key that actually arrived and its fingerprint" (so peers.json can be looked up)', async () => {
  const agentStatic = await generateAgentKey()
  const deviceStatic = await generateDeviceKey()
  const devicePub = await exportPublicKey(deviceStatic.publicKey)
  const h = await startHandshake(deviceStatic, await exportPublicKey(agentStatic.publicKey))
  const seen: { devicePublicRaw: Uint8Array; deviceId: string }[] = []
  await acceptHandshake(agentStatic, h.message, (info) => {
    seen.push(info)
    return true
  })
  assert.equal(seen.length, 1, 'the check was not called')
  assert.ok(sameBytes(seen[0]!.devicePublicRaw, devicePub), 'a different public key was passed')
  assert.equal(seen[0]!.deviceId, await fingerprint(devicePub))
})

test('★★ the check is called before deriving keys (no computation for what will be rejected)', async () => {
  const agentStatic = await generateAgentKey()
  const deviceStatic = await generateDeviceKey()
  // A handshake with the wrong addressee → never reaches the check (the addressee check comes first)
  const other = await generateAgentKey()
  const h = await startHandshake(deviceStatic, await exportPublicKey(other.publicKey))
  let called = false
  await assert.rejects(
    acceptHandshake(agentStatic, h.message, () => {
      called = true
      return true
    }),
    /宛先/,
  )
  assert.equal(called, false, 'reached the check despite the wrong addressee')
})

test('★★ the derived key is 256 bits (shrinking the HKDF length keeps the happy path green)', async () => {
  // ⚠️ codex mutation ①: `256,` → `128,` was 23/23 green
  const { device, agent } = await pair()
  assert.equal(device.keyBits, 256, `the key is ${device.keyBits} bits`)
  assert.equal(agent.keyBits, 256)
})

test('★★ every frame type has a different value (a collision in the table keeps the happy path green)', () => {
  // ⚠️ codex mutation ②: `request: 3` → `request: 4` was 23/23 green
  //    (both sides use the same constants, so a collision slips through)
  const values = Object.values(FRAME)
  assert.equal(new Set(values).size, values.length, `duplicate type values: ${values.join(',')}`)
})

test('★★ frames with unknown types are dropped (never return a value impossible for the type)', async () => {
  // ⚠️ codex low #1. A peer with the right key, or a future version, may send an unknown type
  const { device, agent } = await pair()
  // @ts-expect-error — deliberately seal with a type that is not in the table
  const f = await device.seal(255, enc('x'))
  await assert.rejects(agent.open(f), /種別/, 'an unknown type passed')
})

test('★★ stops at the counter limit (never wraps silently)', async () => {
  // ⚠️ codex mutation ③: turning the limit check into `if (false)` was 23/23 green
  //    (the earlier test never touched the private slot and did not even call `seal`)
  const atMax = __unsafeSessionForTest(await aesForTest(), await aesForTest(), MAX_COUNTER)
  await assert.rejects(atMax.seal(FRAME.request, enc('x')), /上限/, 'the counter wraps')
  // ★ One step below passes (= evidence the failure above is not "always fails")
  const nearMax = __unsafeSessionForTest(await aesForTest(), await aesForTest(), MAX_COUNTER - 1)
  assert.ok((await nearMax.seal(FRAME.request, enc('x'))).length > HEADER_BYTES)
})

test('★★ two concurrent `seal` calls do not take the same counter', async () => {
  // ⚠️ codex mutation ④: moving `this.#out += 1` after encrypt makes
  //    two concurrent calls use the same counter and nonce (they came out as identical frames in a measurement)
  const { device } = await pair()
  const p = enc('まったく同じ本文')
  const [a, b] = await Promise.all([
    device.seal(FRAME.request, p),
    device.seal(FRAME.request, p),
  ])
  assert.ok(!sameBytes(a, b), 'two identical frames came out (counter and nonce reuse)')
})

/** AES key used only to reach the limit branch (no handshake) */
async function aesForTest(): Promise<Key> {
  const kp = await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  return kp as Key
}

// ─────────────────────────────────────────────────────────────────────────────
// ★★ Known-answer tests (KAT) — **pin the wire format**
//
// ⚠️⚠️ codex round 4 of 2026-09-01. The handshake is full of randomness, so from the outside
//    **none of the order and count of z1-z4, the HKDF labels, the salt, how nonces are built, or the key length**
//    can be pinned. **Both sides share the code, so changing them together keeps the happy path green**
//    = unnoticed until versions mix. In fact these mutations slipped past 36/36:
//      `ikm.slice(0, 96)` (drop z4) / `'nyan1 d2a'` → `'nyan2 d2a'` /
//      `setBigUint64(4, BigInt(counter))` → `setBigUint64(4, 0n)` (fixed nonce)
// ⇒ **Fix both keys and randomness, and compare the resulting bytes themselves.**
// ⚠️ If this fails it is not "a bug" but a sign that **the wire format changed**.
//    Bump the version (`V`) or revert the change.
// ─────────────────────────────────────────────────────────────────────────────

const KAT = {
  deviceStatic: { kty: "EC", crv: "P-256", x: "E1jBPbkwhsKBNW6SjLRvVvhb5gYk4zQ500XBE0OFBsI", y: "vfF3wz_ggAPbojEdF0nQzZFyKpiqO91Jks937nJ9k0Y", d: "5cgbBdYOP4ZONyqiwk7MnkXKRyU-AHhQRJTzuBPzvZQ" },
  agentStatic: { kty: "EC", crv: "P-256", x: "x2fxG2zKtcbxxZcVs-DL_wm6DF22TM_dh0AaB5ItP5I", y: "J8ZcbX5IE19NSD_x22hK92_--J-mHpV1eY8Un7Gu_ZE", d: "27nnGU2TM-cBWRo6_sP1H4R00kh4lBsQazLWets5xbc" },
  deviceEph: { kty: "EC", crv: "P-256", x: "KM7BKOt6K8cI8B5QJqbxS7dHSbeSJWG_zrNyk8SYyJQ", y: "eQlSl9TUWG940MoUDBK_IeV8JC1XkXjPtGGvHecydqg", d: "pIY-UY4FSERmq7O31HD6YFhIriElQPYSNKIapKpFBpg" },
  agentEph: { kty: "EC", crv: "P-256", x: "_TUaWD83OAFC2zHuVG1KP4ZRt2dO-7c3eXwWCPC7Szk", y: "d1qi3WjYt681K5qJdlk8Cn3rbSt9kv9ie0Pb4JPHK2c", d: "13kVrW011GogMq9cF72wooRYTUEyFydfjuNdxjvqqS4" },
  init: '0100041358c13db93086c281356e928cb46f56f85be60624e33439d345c113438506c2bdf177c33fe08003dba2311d1749d0cd91722a98aa3bdd4992cf77ee727d93460428cec128eb7a2bc708f01e5026a6f14bb74749b7922561bfceb37293c498c89479095297d4d4586f78d0ca140c12bf21e57c242d579178cfb461af1de73276a811111111111111111111111111111111e20e632be0ad9fb59dd99469d31b345dd6f8ab90bb2a13ef221426b7a24d931f',
  reply: '010104fd351a583f37380142db31ee546d4a3f8651b7674efbb737797c1608f0bb4b39775aa2dd68d8b7af352b9a8976593c0a7deb6d2b7d92ff627b43dbe093c72b6722222222222222222222222222222222',
  confirm: '0102000000000000000015711f3f25b282edc13a69611c1a636870789354db061fe06a59cc29691120bf3d27c681439441b4000b3b78d90e9bf2',
  frame: '01030000000000000000fc71c6e1108438f40a6c5aa384b0070a3ffd54',
} as const

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')

test('★★ KAT: fixed keys and randomness produce fixed bytes (pins the wire format)', async (t) => {
  const nonceD = new Uint8Array(16).fill(0x11)
  const nonceA = new Uint8Array(16).fill(0x22)
  const deviceStatic = await importDeviceKeyForTest(KAT.deviceStatic as Jwk)
  const agentStatic = await importKeyPair(KAT.agentStatic as Jwk)
  const deviceEph = await importKeyPair(KAT.deviceEph as Jwk)
  const agentEph = await importKeyPair(KAT.agentEph as Jwk)
  let n = 0
  let e = 0
  __forTest.nonce = () => (n++ === 0 ? nonceD : nonceA)
  __forTest.ephemeral = async () => (e++ === 0 ? deviceEph : agentEph)
  t.after(() => {
    delete __forTest.nonce
    delete __forTest.ephemeral
  })

  const h = await startHandshake(deviceStatic, await exportPublicKey(agentStatic.publicKey))
  assert.equal(hex(h.message), KAT.init, 'the bytes of the first message changed')
  const { message: reply, confirm, session: agent } = await acceptHandshake(agentStatic, h.message, ALLOW)
  assert.equal(hex(reply), KAT.reply, 'the bytes of the second message changed')
  // ★ This is the real one: the confirm frame is encrypted with **the derived key**, so
  //   a change to any of z order, count, HKDF labels, salt, nonce or key length breaks the match
  assert.equal(hex(confirm), KAT.confirm, 'the derived key or the frame construction changed')
  const device = await (await finishHandshake(h, reply)).accept(confirm)
  assert.equal(
    hex(await device.seal(FRAME.request, new TextEncoder().encode('KAT'))),
    KAT.frame,
    'the device → agent key or the counter construction changed',
  )
  assert.ok(agent)
})

test('★★ type values are wire constants (do not change them on a whim)', () => {
  // ⚠️ Both sides use the same constants, so changing a value keeps the happy path green = unnoticed until versions mix
  assert.deepEqual({ ...FRAME }, { confirm: 2, request: 3, response: 4, event: 5, close: 6 })
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ Regressions for codex round 4 (high #3, medium #2, low #1)
// ─────────────────────────────────────────────────────────────────────────────

test('★★ copying the handshake state cannot bypass the one-time flag', async () => {
  // ⚠️⚠️ codex round 4, high #1. `pending` used to be public, so `{...h.pending}`
  //    could copy it and make **two Sessions with the same key and counter 0** (measured: identical ciphertext frames).
  //    Writing back `h.pending.used = false` was also possible.
  const agentStatic = await generateAgentKey()
  const deviceStatic = await generateDeviceKey()
  const h = await startHandshake(deviceStatic, await exportPublicKey(agentStatic.publicKey))
  const { message } = await acceptHandshake(agentStatic, h.message, ALLOW)
  await finishHandshake(h, message)
  // ★ It holds no contents, so copying does not carry the state
  const twin = { message: h.message } as typeof h
  await assert.rejects(finishHandshake(twin, message), /状態がありません/, 'bypassed by copying')
  assert.deepEqual(Object.keys(h), ['message'], 'the handshake exposes its state')
})

test('★★ a `Session` is only obtainable through the confirm frame', async () => {
  // ⚠️ codex round 4, medium #2. `finishHandshake` used to return a `Session` immediately, so
  //    **requests could be sent before opening the agent's confirm**
  const agentStatic = await generateAgentKey()
  const deviceStatic = await generateDeviceKey()
  const h = await startHandshake(deviceStatic, await exportPublicKey(agentStatic.publicKey))
  const { message, confirm, session } = await acceptHandshake(agentStatic, h.message, ALLOW)
  const pending = await finishHandshake(h, message)
  assert.deepEqual(Object.keys(pending), ['accept'], 'there is an entry usable before confirmation')
  assert.ok(await pending.accept(confirm))
  // ★ Success only once (no Sessions with the same key and counter 0 from several valid confirms)
  //   ⚠️ codex round 5 mutation ①: `return session` → `new SessionImpl(...)` was green
  await assert.rejects(pending.accept(confirm), /確認済み/, 'passed confirmation twice')
  assert.ok(session)
})

test('★★ a confirm frame with different contents is rejected (decrypting alone is not enough)', async () => {
  const agentStatic = await generateAgentKey()
  const deviceStatic = await generateDeviceKey()
  const h = await startHandshake(deviceStatic, await exportPublicKey(agentStatic.publicKey))
  const { message, session: agent } = await acceptHandshake(agentStatic, h.message, ALLOW)
  const pending = await finishHandshake(h, message)
  // The agent sent different contents claiming "confirm" (counter 0 is already used by the confirm, so 1)
  const fake = await agent.seal(FRAME.confirm, enc('ちがう中身'))
  await assert.rejects(pending.accept(fake), /確認/, 'contents are not checked')
})

test('★★ concurrent `seal` calls come out in call order', async () => {
  // ⚠️ codex round 4, medium #1. Counters do not collide, but **completion order can flip**, so
  //    an implementation that sends in completion order makes the receiver **drop the legitimate 0 as "rewound"**
  const { device, agent } = await pair()
  const frames = await Promise.all([
    device.seal(FRAME.request, enc('0')),
    device.seal(FRAME.request, enc('1')),
    device.seal(FRAME.request, enc('2')),
  ])
  // ★ The receiver can open them in order as-is (= counters are in call order)
  for (let i = 0; i < frames.length; i++) {
    assert.equal(dec((await agent.open(frames[i]!)).plaintext), String(i))
  }
})

test('★★ sending the same plaintext twice gives different ciphertext bodies (the nonce is not fixed)', async () => {
  // ⚠️ codex round 4 mutation: `setBigUint64(4, BigInt(counter))` → `setBigUint64(4, 0n)`.
  //    Comparing with the header included reads as "different because the counter differs" and slips through
  //    ⇒ Compare **the ciphertext body without the header**
  // ⚠️⚠️ **Strip the tag too.** In AES-GCM the **ciphertext body does not depend on the AAD** (only the tag does), so
  //    stripping just the header makes a fixed nonce still look "different" because of the tag, and it slips through
  //    (actually missed on 2026-09-01). ⇒ Drop the last 16 bytes (the GCM tag) as well.
  const TAG = 16
  const { device } = await pair()
  const p = enc('まったく同じ本文')
  const a = (await device.seal(FRAME.request, p)).slice(HEADER_BYTES, -TAG)
  const b = (await device.seal(FRAME.request, p)).slice(HEADER_BYTES, -TAG)
  assert.ok(a.length > 0, 'empty body (not a real comparison)')
  assert.ok(!sameBytes(a, b), 'the nonce is fixed (a fatal misuse of AES-GCM)')
})

test('★★ handshake messages must be "exactly that length" or they are dropped', async () => {
  // ⚠️ codex round 4 mutation: `!==` → `<` (accepts trailing garbage)
  const agentStatic = await generateAgentKey()
  const deviceStatic = await generateDeviceKey()
  const h = await startHandshake(deviceStatic, await exportPublicKey(agentStatic.publicKey))
  const longer = new Uint8Array(h.message.length + 1)
  longer.set(h.message)
  await assert.rejects(acceptHandshake(agentStatic, longer, ALLOW), /長さ/, 'accepted trailing garbage')

  const { message } = await acceptHandshake(agentStatic, h.message, ALLOW)
  const h2 = await startHandshake(deviceStatic, await exportPublicKey(agentStatic.publicKey))
  const longReply = new Uint8Array(message.length + 1)
  longReply.set(message)
  await assert.rejects(finishHandshake(h2, longReply), /長さ/, 'accepted trailing garbage on the second message')
})

test('★★ version and type of the second message are checked too (not only the first)', async () => {
  const agentStatic = await generateAgentKey()
  const deviceStatic = await generateDeviceKey()
  const mk = async (): Promise<{ h: Awaited<ReturnType<typeof startHandshake>>; reply: Uint8Array }> => {
    const h = await startHandshake(deviceStatic, await exportPublicKey(agentStatic.publicKey))
    const { message } = await acceptHandshake(agentStatic, h.message, ALLOW)
    return { h, reply: message }
  }
  const a = await mk()
  const badV = new Uint8Array(a.reply)
  badV[0] = 99
  await assert.rejects(finishHandshake(a.h, badV), /版/, 'the version of the second message is not checked')
  const b = await mk()
  const badT = new Uint8Array(b.reply)
  badT[1] = 9
  await assert.rejects(finishHandshake(b.h, badT), /種別/, 'the type of the second message is not checked')
})

test('★★ the caller rewriting its buffer does not change what was handshaken', async () => {
  // ⚠️ codex round 4, low #1. The receive buffer belongs to the caller and may be overwritten during an `await`
  const agentStatic = await generateAgentKey()
  const deviceStatic = await generateDeviceKey()
  const h = await startHandshake(deviceStatic, await exportPublicKey(agentStatic.publicKey))
  const buf = new Uint8Array(h.message)
  const seen: Uint8Array[] = []
  const res = await acceptHandshake(agentStatic, buf, (info) => {
    seen.push(info.devicePublicRaw)
    // ★ Clobber the caller's buffer in the middle of the check
    buf.fill(0)
    // ★ Rewriting the copy that was handed over does not affect the inside
    info.devicePublicRaw.fill(0xff)
    return true
  })
  const device = await (await finishHandshake(h, res.message)).accept(res.confirm)
  assert.equal(dec((await res.session.open(await device.seal(FRAME.request, enc('ok')))).plaintext), 'ok')
  assert.equal(seen.length, 1)
})

test('★★ base64url round-trips with remainders of 1-3 bytes (missed padding removal)', () => {
  // ⚠️ codex round 4 mutation: `replace(/=+$/, '')` → `replace(/=$/, '')`
  for (const n of [1, 2, 3, 4, 5, 32, 65]) {
    const b = new Uint8Array(n).map((_, i) => (i * 37) & 0xff)
    const s = toBase64Url(b)
    assert.ok(!/[+/=]/.test(s), `n=${n} left characters unusable in a URL: ${s}`)
    assert.ok(sameBytes(fromBase64Url(s), b), `n=${n} does not round-trip`)
  }
})

/** For KAT: build a "non-extractable" device key from a fixed JWK (same property as `generateDeviceKey`) */
async function importDeviceKeyForTest(jwk: Jwk): Promise<{ publicKey: Key; privateKey: Key }> {
  const su = globalThis.crypto.subtle
  const { d: _d, key_ops: _o, ext: _e, ...pub } = jwk
  return {
    privateKey: await su.importKey('jwk', jwk, ECDH_PARAMS, false, ['deriveBits']),
    publicKey: await su.importKey('jwk', { ...pub, key_ops: [] }, ECDH_PARAMS, true, []),
  }
}

/** Hash of the handshake transcript (the same thing as the confirm frame contents) */
async function transcriptHash(h: { message: Uint8Array }, reply: Uint8Array): Promise<Uint8Array> {
  const both = new Uint8Array(h.message.length + reply.length)
  both.set(h.message)
  both.set(reply, h.message.length)
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', both))
}

// ─────────────────────────────────────────────────────────────────────────────
// ★★ Regressions for codex round 5 (high #2, medium #2, low #1)
// ─────────────────────────────────────────────────────────────────────────────

test('★★ no handshake with an extractable key (device keys are extractable:false)', async () => {
  // ⚠️⚠️ codex round 5, high #1. Using `generateDeviceKey()` guarantees it, but **that was only a convention**
  //    (passing an `extractable:true` key went all the way through, and the private key could be extracted / measured)
  const agentStatic = await generateAgentKey()
  const leaky = await generateAgentKey() // extractable: true
  await assert.rejects(
    startHandshake(leaky, await exportPublicKey(agentStatic.publicKey)),
    /extractable/,
    'handshake worked with an extractable key',
  )
})

test('★★ rewriting the peer public key right after the call does not change the handshake peer', async () => {
  // ⚠️⚠️ codex round 5, high #2. Copying after the `await` **completed a handshake with B** (measured)
  //    = the peer pinned by the QR changes through buffer reuse
  const a1 = await generateAgentKey()
  const a2 = await generateAgentKey()
  const raw = new Uint8Array(await exportPublicKey(a1.publicKey))
  const pendingH = startHandshake(await generateDeviceKey(), raw)
  raw.set(await exportPublicKey(a2.publicKey))
  const h = await pendingH
  // ★ B rejects it as "wrong addressee"
  await assert.rejects(acceptHandshake(a2, h.message, ALLOW), /宛先/, 'handshake worked with the swapped peer')
  // ★ It succeeds with A
  assert.ok(await acceptHandshake(a1, h.message, ALLOW))
})

test('★★ rewriting the handshake message does not change the internal transcript', async () => {
  // ⚠️ codex round 5, low #1. Sharing the same array breaks "state lives only inside"
  const agentStatic = await generateAgentKey()
  const h = await startHandshake(await generateDeviceKey(), await exportPublicKey(agentStatic.publicKey))
  const sent = new Uint8Array(h.message)
  const { message, confirm } = await acceptHandshake(agentStatic, sent, ALLOW)
  h.message.fill(0) // clobber our own array after sending
  assert.ok(await (await finishHandshake(h, message)).accept(confirm), 'the internal transcript broke too')
})

test('★★ rewriting the plaintext right after passing it to `seal` still sends the contents at call time', async () => {
  // ⚠️ codex round 5, medium #1 (measured: "A" became "B")
  const { device, agent } = await pair()
  const p = enc('A')
  const f = device.seal(FRAME.request, p)
  p.set(enc('B'))
  assert.equal(dec((await agent.open(await f)).plaintext), 'A', 'the rewritten version was sent')
})

test('★★ rewriting a frame right after passing it to `open` does not get it processed as another frame', async () => {
  // ⚠️ codex round 5, medium #1 (measured: the next frame written over it got decrypted)
  const { device, agent } = await pair()
  const f0 = await device.seal(FRAME.request, enc('0'))
  const f1 = await device.seal(FRAME.request, enc('1'))
  const buf = new Uint8Array(f0)
  const opened = agent.open(buf)
  buf.set(f1)
  assert.equal(dec((await opened).plaintext), '0', 'the rewritten version was processed')
})

test('★★ concurrent `seal` calls come out in call order (judged by completion order)', async () => {
  // ⚠️ codex round 5 mutation ④: `this.#sendChain.then(` → `Promise.resolve().then(`.
  //    The earlier test read results in the **input order** of `Promise.all`, so it slipped through
  //    ⇒ Record **the order of completion**
  // ⚠️⚠️ **Vary the sizes.** With all small plaintexts they happen to finish in order even concurrently, and it slips through
  //    (actually missed on 2026-09-01). ★ Make only the first one heavy, so it **gets overtaken** unless serialised
  const { device } = await pair()
  const sizes = [4 << 20, 8, 8, 8]
  const order: number[] = []
  await Promise.all(
    sizes.map((n, i) =>
      device.seal(FRAME.request, new Uint8Array(n)).then(() => {
        order.push(i)
      }),
    ),
  )
  assert.deepEqual(order, [0, 1, 2, 3], `completion order is not call order (overtaken): ${order.join(',')}`)
})

test('★★ not a "confirm" type means no Session, even if it decrypts with the same key', async () => {
  // ⚠️⚠️ codex round 5 mutation ②: `if (type !== FRAME.confirm)` → `if (false)` was green.
  //    The earlier test built the frame with **the key of another handshake**, so it **failed at decryption**
  //    and never reached the type check.
  //    ★ Use **the same session key**, with **the transcript hash as contents** too,
  //      to create a state where "only the type differs".
  const agentStatic = await generateAgentKey()
  const deviceStatic = await generateDeviceKey()
  const h = await startHandshake(deviceStatic, await exportPublicKey(agentStatic.publicKey))
  const { message, session } = await acceptHandshake(agentStatic, h.message, ALLOW)
  const pending = await finishHandshake(h, message)
  const notConfirm = await session.seal(FRAME.request, await transcriptHash(h, message))
  await assert.rejects(
    pending.accept(notConfirm),
    /確認フレームではありません/,
    'type is not checked (non-confirm frames can become a Session)',
  )
})

test('★★ the frame used for confirmation cannot later pass as an ordinary frame', async () => {
  // ⚠️ codex round 5 mutation ①: `return session` → `new SessionImpl(d2a, a2d, transcript)`.
  //    Returning a new Session **resets the receive counter to -1**, so the confirm frame
  //    can be fed in again (= replaying a used frame passes)
  const agentStatic = await generateAgentKey()
  const deviceStatic = await generateDeviceKey()
  const h = await startHandshake(deviceStatic, await exportPublicKey(agentStatic.publicKey))
  const { message, confirm } = await acceptHandshake(agentStatic, h.message, ALLOW)
  const device = await (await finishHandshake(h, message)).accept(confirm)
  await assert.rejects(device.open(confirm), /カウンタ/, 'the confirm frame could be replayed')
})

test('★★ acceptHandshake returns the fingerprint of "the peer keys were agreed with" (identity and key come from the same handshake)', async () => {
  // ⚠️⚠️ Without returning it, the caller could only pull it into a variable inside the `authorize` callback
  //    = "the peer keys were agreed with" and "the identity" take **different paths**, and the mismatch cannot be prevented by type
  //    (2026-09-07 / noticed while building `via:'device'` in `agent/src/auth.ts`).
  const agent = await generateAgentKey()
  const device = await generateDeviceKey()
  const devicePublic = await exportPublicKey(device.publicKey)
  const h = await startHandshake(device, await exportPublicKey(agent.publicKey))

  let seen: { devicePublicRaw: Uint8Array; deviceId: string } | undefined
  const accepted = await acceptHandshake(agent, h.message, (info) => {
    seen = info
    return true
  })

  assert.equal(accepted.deviceId, await fingerprint(devicePublic))
  assert.equal(accepted.deviceId, seen?.deviceId, '★ must be the same value that was passed to the check')
  assert.deepEqual(seen?.devicePublicRaw, devicePublic)
})

test('★★ the value returned by the check comes back as `authorized` as-is (the subject checked later is the same value)', async () => {
  // ⚠️⚠️ 2026-09-08 (step 6 ① of ③). **A boolean-only return was not enough**:
  //    the caller could only get "the registration let through" **via a variable inside the callback** or **by looking it up again later**,
  //    and either way "the authenticated subject" and "the subject later checked for validity" take **different paths**
  //    (= **the same shape** fixed for `deviceId` in the test above).
  // ★ With this, `agent/src/auth.ts` can bind **the returned registration itself** to the connection.
  const agent = await generateAgentKey()
  const device = await generateDeviceKey()
  const h = await startHandshake(device, await exportPublicKey(agent.publicKey))
  // ★ Contents are meaningless. **Object identity** serves as "the registration generation"
  const registration = { note: 'この物の同一性が世代' }
  const accepted = await acceptHandshake(agent, h.message, () => registration)
  assert.equal(accepted.authorized, registration, '★ the same object comes back (not a copy)')
})

test('★★ if the check returns "none", the handshake is rejected (only truthy passes)', async () => {
  const agent = await generateAgentKey()
  const device = await generateDeviceKey()
  const agentPub = await exportPublicKey(agent.publicKey)
  // ⚠️ Reject not only `false` but also `undefined` (the shape when no registration is found)
  for (const no of [undefined, null, false, 0, ''] as unknown[]) {
    const h = await startHandshake(device, agentPub)
    await assert.rejects(
      acceptHandshake(agent, h.message, () => no),
      /登録されていない/,
      `let ${String(no)} through`,
    )
  }
  // ★ Not "always reject"
  const ok = await startHandshake(device, agentPub)
  assert.equal((await acceptHandshake(agent, ok.message, () => true)).authorized, true)
})

test('★★ matchesKeyPair: true only for the same pair (⚠️ checked without exporting the private key)', async () => {
  // ★ Why needed: device keys are `extractable:false`, so they cannot be exported.
  //   Even if IndexedDB held **a mix of two different pairs**, an implementation that only looks at the public key would pass
  //   (codex medium #3 of 2026-09-08. `web/src/identity.ts` relies on this).
  const x = await generateDeviceKey()
  const y = await generateDeviceKey()
  assert.equal(await matchesKeyPair(x), true)
  assert.equal(await matchesKeyPair(y), true)
  // ⚠️ A mix taken from different pairs
  assert.equal(await matchesKeyPair({ publicKey: x.publicKey, privateKey: y.privateKey }), false)
  assert.equal(await matchesKeyPair({ publicKey: y.publicKey, privateKey: x.privateKey }), false)
})

test('★★ matchesKeyPair: never throws on broken values (returns false)', async () => {
  const x = await generateDeviceKey()
  for (const bad of [
    { publicKey: 1, privateKey: 2 },
    { publicKey: x.publicKey, privateKey: { type: 'private', extractable: false } },
    // ★ Swapped (a private key where the public key should be)
    { publicKey: x.privateKey, privateKey: x.privateKey },
  ] as unknown as Array<{ publicKey: Key; privateKey: Key }>) {
    assert.equal(await matchesKeyPair(bad), false)
  }
})

test('★★ matchesKeyPair: keys with a different curve or algorithm give false (identity.ts relies on this)', async () => {
  // ⚠️ `web/src/identity.ts` has **no** alg / usages check (removed as unreachable).
  //    ⇒ **This is the only guard**, so these two are pinned explicitly.
  const ecdsa = (await globalThis.crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )) as { publicKey: Key; privateKey: Key }
  assert.equal(await matchesKeyPair(ecdsa), false)

  const p384 = (await globalThis.crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-384' },
    false,
    ['deriveBits'],
  )) as { publicKey: Key; privateKey: Key }
  assert.equal(await matchesKeyPair(p384), false)
})
