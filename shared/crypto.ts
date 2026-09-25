// ★★ E2E for ③ (2026-09-01 / [ARCHITECTURE §14.1.2](../docs/ARCHITECTURE.md)).
//
// **The agent and the PWA import this same file.** No two implementations
// ("writing it in two places always drifts" / CLAUDE.md).
//
// ⚠️⚠️ **No dependencies.** Everything is ECDH P-256 via WebCrypto (`globalThis.crypto.subtle`).
//    ★ `@noble/curves` was rejected **for XSS resistance, not size** (the private key becomes raw bytes
//    and can be exfiltrated). P-256 was chosen for **browser reach** (X25519 is new in WebCrypto,
//    and iPhone Safari is unverified). ⇒ History in §14.1.2.2. **Do not reopen this.**
//
// ⚠️ Four things must hold here (§14.1.2.6). **Each breaks silently**:
//   1. put the transcript into the salt (otherwise swapping a field midway yields the same key)
//   2. a separate key per direction (using the same key both ways can collide nonces)
//   3. never rewind the nonce (the receiver requires "greater than before")
//   4. authentication is implicit, so add **one confirm frame** (otherwise no failure reason can be reported)

const V = 1

/** Frame types. ⚠️ When adding one, add it to the `FrameType` table (guarded by the type) */
import { t } from './i18n.ts'

export const FRAME = {
  /** Handshake confirmation (agent → device) */
  confirm: 2,
  /** An HTTP request for now */
  request: 3,
  /** An HTTP response for now */
  response: 4,
  /** One SSE event */
  event: 5,
  /** Explicit disconnect */
  close: 6,
} as const
export type FrameType = (typeof FRAME)[keyof typeof FRAME]

const INIT_TYPE = 0
const REPLY_TYPE = 1

/** Raw public key (uncompressed P-256 point) */
export const PUBKEY_BYTES = 65
const NONCE_BYTES = 16
const FP_BYTES = 32
/** `[1B version][1B type][8B counter]` */
export const HEADER_BYTES = 10
const INIT_BYTES = 2 + PUBKEY_BYTES * 2 + NONCE_BYTES + FP_BYTES
const REPLY_BYTES = 2 + PUBKEY_BYTES + NONCE_BYTES

/** ⚠️ An 8-byte counter, but stop once it exceeds JS's safe integers (never silently wrap) */
export const MAX_COUNTER = Number.MAX_SAFE_INTEGER

/**
 * ⚠️⚠️ **Test-only injection point.** Lets ephemeral keys and randomness be fixed
 *    so that known-answer tests (KAT) can be written.
 *
 * **Why it is needed**: the handshake is full of randomness, so from the outside
 * **none of the order and count of z1-z4, the HKDF labels, the salt or how nonces are built** can be pinned
 * (both sides share the code, so changing them all together keeps the happy path green = **unnoticed until versions mix**).
 * ⇒ **Fix everything and compare the resulting bytes themselves.**
 *
 * ⚠️ Never reference it from `src` (`web/src/discipline.test.ts` checks this mechanically).
 */
export const __forTest: {
  ephemeral?: () => Promise<KeyPair>
  nonce?: () => Uint8Array
} = {}

function newEphemeral(): Promise<KeyPair> {
  if (__forTest.ephemeral) return __forTest.ephemeral()
  return subtle().generateKey(ECDH, false, ['deriveBits']) as Promise<KeyPair>
}

function newNonce(): Uint8Array {
  if (__forTest.nonce) return __forTest.nonce()
  return globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
}

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const

/**
 * ⚠️⚠️ **Do not write DOM type names (`CryptoKey` / `BufferSource` / `JsonWebKey`) directly.**
 *    This file is **type-checked from both the agent (Node types, no DOM) and web (with DOM)**,
 *    so a name that exists only on one side fails on the other. ⇒ **Derive types from runtime values.**
 */
type Subtle = typeof globalThis.crypto.subtle
/** A WebCrypto key (`Key` in DOM, same shape in Node) */
export type Key = Awaited<ReturnType<Subtle['importKey']>>
export interface KeyPair {
  publicKey: Key
  privateKey: Key
}
/** Equivalent of `Bin` */
type Bin = Parameters<Subtle['digest']>[1]
/**
 * Equivalent of `JsonWebKey`.
 * ⚠️ Cannot be derived with `ReturnType` (`exportKey` is overloaded and the last branch = `ArrayBuffer` is picked).
 *    ⇒ A structural type with **only the fields an EC key needs** (mutually assignable with DOM's `JsonWebKey`).
 */
export interface Jwk {
  kty?: string
  crv?: string
  x?: string
  y?: string
  d?: string
  ext?: boolean
  key_ops?: string[]
}

const subtle = (): Subtle => globalThis.crypto.subtle

/**
 * ⚠️⚠️ **Copy byte arrays from outside at the boundary** (codex round 4 of 2026-09-01, low #1).
 *    The receive buffer belongs to the caller and **may be reused or overwritten** during an `await`.
 *    Holding it as-is lets "the public key we checked" and "the public key actually used for ECDH" disagree.
 */
function snapshot(b: Uint8Array): Uint8Array {
  return new Uint8Array(b)
}

function u8(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** ⚠️ Leak neither length nor content through timing (same reason as `sameSecret` in `auth.ts`) */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

export function toBase64Url(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(s: string): Uint8Array {
  const p = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(p + '='.repeat((4 - (p.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest('SHA-256', data as Bin))
}

/**
 * Identifier made from a public key (`deviceId` / `agentId`).
 * ⚠️ The id is **a fingerprint, not the key itself** (short, and printing it in logs cannot reconstruct the key).
 */
export async function fingerprint(publicKeyRaw: Uint8Array): Promise<string> {
  return toBase64Url(await sha256(publicKeyRaw))
}

// ─────────────────────────────────────────────────────────────────────────────
// Keys
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ★★ Static key of a device (PWA / app). **Always `extractable: false`. No arguments.**
 *
 * ⚠️⚠️ **`extractable` is not a parameter** (codex round 4 of 2026-09-01, high #2).
 *    If true could be passed, **the moment PWA generation or restore picked true even once,
 *    any later XSS could exfiltrate the private key**. ⇒ **Make it impossible to choose** (guarded by the type).
 * ⚠️ The agent's key (which must persist to a file) lives in **`agent/src/agentKey.ts`**.
 *    ★ **The PWA never imports it** (`web/src/discipline.test.ts` checks this mechanically).
 */
export function generateDeviceKey(): Promise<KeyPair> {
  return subtle().generateKey(ECDH, false, ['deriveBits']) as Promise<KeyPair>
}

export async function exportPublicKey(key: Key): Promise<Uint8Array> {
  // ⚠️ `as ArrayBuffer` is **for relay (`@cloudflare/workers-types`)** (its types collapse
  //    the `exportKey` overloads into one, giving `ArrayBuffer | JsonWebKey`).
  //    ★ The `'raw'` branch is always an `ArrayBuffer` (`crypto.test.ts` checks the real bytes).
  return new Uint8Array((await subtle().exportKey('raw', key)) as ArrayBuffer)
}

export function importPublicKey(raw: Uint8Array): Promise<Key> {
  // ⚠️ Public keys have empty usages (WebCrypto rejects `deriveBits` on them)
  return subtle().importKey('raw', raw as Bin, ECDH, true, [])
}

/**
 * ⚠️⚠️ **Key export and import do not live here** (codex round 4, high #2).
 *    **The PWA imports this file too**, so just having `exportPrivateKey` here would
 *    ship "an API that lets XSS exfiltrate the key". ⇒ **`agent/src/agentKey.ts`** (agent only).
 */

/** Name of ECDH P-256. ⚠️ Use **the same one** as `agentKey.ts` (do not write it twice) */
export const ECDH_PARAMS = ECDH

// ─────────────────────────────────────────────────────────────────────────────
// Handshake (§14.1.2.6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ★ ECDH parameters. **The only place where the type is loosened.**
 *
 * ⚠️⚠️ The reason is relay (`@cloudflare/workers-types`): its type definitions declare the same field
 *    **under the alias `$public`** (the correct runtime name is `public`).
 *    ⇒ Absorbed here so that **the same crypto is shared in three places (agent, PWA, relay)**.
 * ⚠️ The loosening is watched by **every handshake test** (a wrong field name breaks ECDH,
 *    and `shared/crypto.test.ts` fails across the board. Confirmed by mutation on 2026-09-15).
 */
function ecdhParams(pub: Key): Parameters<Subtle['deriveBits']>[0] {
  return { name: 'ECDH', public: pub } as unknown as Parameters<Subtle['deriveBits']>[0]
}

async function ecdh(priv: Key, pub: Key): Promise<Uint8Array> {
  return new Uint8Array(await subtle().deriveBits(ecdhParams(pub), priv, 256))
}

/**
 * ★★ Are this public key and private key **the same key pair** (2026-09-08 / codex medium #3)?
 *
 * ⚠️⚠️ **Check without exporting the private key** (device keys are `extractable: false`, so
 *    they cannot be exported. A path to export them would make them XSS-exfiltratable).
 * ★ How: create an ephemeral key `t` and
 *      compare ECDH(priv, t.pub) with ECDH(t.priv, pub).
 *    DH is commutative, so **they match only for the same pair**.
 * ⚠️ **Never throws** (the function assumes it may be handed broken keys, so it returns false).
 */
export async function matchesKeyPair(pair: KeyPair): Promise<boolean> {
  try {
    const t = await newEphemeral()
    return sameBytes(await ecdh(pair.privateKey, t.publicKey), await ecdh(t.privateKey, pair.publicKey))
  } catch {
    return false
  }
}

/** ⚠️ **Different keys** for sending and receiving (the same key in both directions can collide nonces) */
async function deriveKeys(
  ikm: Uint8Array,
  transcript: Uint8Array,
): Promise<{ d2a: Key; a2d: Key }> {
  const salt = await sha256(transcript)
  const base = await subtle().importKey('raw', ikm as Bin, 'HKDF', false, ['deriveBits'])
  const one = async (label: string): Promise<Key> => {
    const bits = await subtle().deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: salt as Bin, info: new TextEncoder().encode(label) },
      base,
      256,
    )
    // ⚠️ Session keys need not be extractable (`extractable: false`)
    return subtle().importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  }
  return { d2a: await one('nyan1 d2a'), a2d: await one('nyan1 a2d') }
}

/**
 * ★★ **The value that shows relay "I own this public key"** (④a of ③b / §14.1.2.30).
 *
 * ⚠️⚠️ Without it, **knowing the public key is enough to claim to be the agent** = anyone can kick
 *    the connected agent (DoS). The key appears in the QR and the rendezvous URL = **assumed known**.
 *
 * ★ How: relay sends **an ephemeral key** and a nonce, and both sides compute
 *   `HKDF(ECDH(own private key, peer public key), salt=nonce, info='nyan-relay-auth1')` and compare.
 *   ⇒ **Only the private-key holder can produce it**. ⚠️ The nonce and peer key are fresh per connection, so **replays do not work**.
 *
 * ⚠️⚠️ **Not a signature** (the agent's key is ECDH-only). A signature would use **the same key for two purposes**,
 *    widening the key's usage (`generateDeviceKey` only has `deriveBits`).
 * ⚠️⚠️ **Different inputs from the E2E key derivation** (a different `info` = they never mix).
 *    ⇒ Session keys (`nyan1 d2a` / `nyan1 a2d`) cannot be derived from the value made here.
 * ⚠️ Compare with `sameBytes` (no timing leak).
 */
export async function relayProof(
  privateKey: Key,
  peerPublicRaw: Uint8Array,
  nonce: Uint8Array,
): Promise<Uint8Array> {
  const ikm = await ecdh(privateKey, await importPublicKey(peerPublicRaw))
  const base = await subtle().importKey('raw', ikm as Bin, 'HKDF', false, ['deriveBits'])
  const bits = await subtle().deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: nonce as Bin,
      info: new TextEncoder().encode('nyan-relay-auth1'),
    },
    base,
    256,
  )
  return new Uint8Array(bits)
}

/**
 * Device-side handshake. **Holds no contents itself** (they live in the `#states` WeakMap).
 *
 * ⚠️⚠️ **Do not put state on the object** (codex round 4 of 2026-09-01, high #1).
 *    `pending` used to be public, so **copying it bypassed the one-time flag**, and
 *    two `Session`s with the same key and counter 0 could be made (measured: identical ciphertext frames came out).
 *    Writing back `h.pending.used = false` was also possible.
 * ⇒ **Key on a value that cannot be copied (the identity of this object).**
 */
export interface Handshake {
  /** Bytes to send to the peer */
  readonly message: Uint8Array
}

const states = new WeakMap<Handshake, Pending>()

interface Pending {
  staticPriv: Key
  ephemeralPriv: Key
  transcript: Uint8Array
  peerStaticRaw: Uint8Array
  /**
   * ⚠️⚠️ **Usable only once** (codex high #2 of 2026-09-01). Being able to call `finishHandshake`
   *    twice on the same `Handshake` made **two `Session`s with the same key and counter 0**,
   *    and the same plaintext produced **exactly the same ciphertext frame** (= AES-GCM key and nonce reuse).
   */
  used: boolean
}

/**
 * Build the first message device → agent.
 * ⚠️ `agentPublicRaw` is **the agent's public key from the QR** (§14.1.2.5).
 *    Because of it, **impersonating the agent is impossible in principle**.
 */
export async function startHandshake(
  deviceStatic: KeyPair,
  agentPublicRaw: Uint8Array,
): Promise<Handshake> {
  // ⚠️⚠️ **Copy synchronously** (codex round 5 of 2026-09-01, high #2). It used to copy after an `await`,
  //    so **overwriting the buffer right after the call completed a handshake with a different agent**
  //    (measured). ⇒ The peer that the QR was supposed to pin could change through buffer reuse.
  const peerRaw = snapshot(agentPublicRaw)
  if (peerRaw.length !== PUBKEY_BYTES) throw new Error(t('agent の公開鍵の長さが違います', 'Wrong agent public key length'))
  // ⚠️⚠️ **Device keys must be "non-extractable"** (codex round 5, high #1).
  //    Using `generateDeviceKey()` guarantees it, but **that was only a convention of the caller**
  //    (passing an `extractable: true` key went all the way through the handshake, and the private key could be extracted / measured).
  //    ⇒ Made an invariant at the entry (item 8 of §14.1.2.3).
  if (deviceStatic.privateKey.extractable) {
    throw new Error(t('デバイスの秘密鍵は取り出せないもの（extractable: false）でなければいけません', 'The device private key must be non-extractable (extractable: false)'))
  }
  const eph = await newEphemeral()
  const message = u8(
    new Uint8Array([V, INIT_TYPE]),
    await exportPublicKey(deviceStatic.publicKey),
    await exportPublicKey(eph.publicKey),
    newNonce(),
    await sha256(peerRaw),
  )
  const h: Handshake = { message }
  states.set(h, {
    staticPriv: deviceStatic.privateKey,
    ephemeralPriv: eph.privateKey,
    // ⚠️ **Do not share the array with `message`** (codex round 5, low #1). If the caller rewrote its contents,
    //    the transcript inside the WeakMap would change too, breaking "state lives only inside"
    transcript: snapshot(message),
    peerStaticRaw: peerRaw,
    used: false,
  })
  return h
}

interface Init {
  devicePublicRaw: Uint8Array
  deviceEphemeralRaw: Uint8Array
  agentFingerprint: Uint8Array
}

/**
 * Read the first message.
 *
 * ⚠️⚠️ **Not exported** (codex high #3 of 2026-09-01). `parseInit` used to be public, and
 *    "the caller checks registration in `peers.json` before calling `acceptHandshake`" was said
 *    **only in a comment**. ⇒ **Miss it and an unknown device gets a valid session key**
 *    (it passed in a measurement). What z3/z4 prove is "holds the private key of the key that was sent",
 *    not "is registered".
 * ⇒ **The check is enforced as an argument of `acceptHandshake`** (omitting `authorize` fails the type check).
 */
function parseInit(message: Uint8Array): Init {
  if (message.length !== INIT_BYTES) throw new Error(t('ハンドシェイクの長さが違います', 'Wrong handshake length'))
  if (message[0] !== V) throw new Error(t('版が違います', 'Wrong version'))
  if (message[1] !== INIT_TYPE) throw new Error(t('種別が違います', 'Wrong type'))
  let at = 2
  const devicePublicRaw = message.slice(at, (at += PUBKEY_BYTES))
  const deviceEphemeralRaw = message.slice(at, (at += PUBKEY_BYTES))
  at += NONCE_BYTES
  const agentFingerprint = message.slice(at, at + FP_BYTES)
  return { devicePublicRaw, deviceEphemeralRaw, agentFingerprint }
}

/**
 * Who is let through. ⚠️ **The caller looks at `devices.json`** (this layer only knows keys).
 *
 * ★★ **The return value may be "the thing let through" itself** (2026-09-08 / step 6 ① of ③).
 *   Falsy means reject (`false` / `undefined` / `null`). Truthy means `acceptHandshake`
 *   **returns that very thing as `authorized`**.
 *   ⚠️⚠️ With a boolean-only shape, the caller could only get "the registration let through"
 *      **via a variable inside the callback** or **by looking it up again later**, and either way
 *      "the authenticated subject" and "the subject later checked for validity" come through **different paths**
 *      (**the same reason** we return `deviceId` = prevent the mismatch by type).
 *   ★ `agent/src/auth.ts` uses this to **bind the registration generation to the connection**, and checks
 *     per request that it is still alive (= revocation applies to already-handshaken connections).
 */
export interface Authorize<T> {
  (info: { devicePublicRaw: Uint8Array; deviceId: string }): T | Promise<T>
}

/**
 * Agent side. Receives the first message, builds the second, and opens the session.
 *
 * ⚠️⚠️ **Caller contract** (codex round 5 of 2026-09-01, medium #2): the returned `message` (second message) and
 *    `confirm` must be sent **in this order, before any frame of `session`**.
 *    If the order flips, the device advances its receive counter on the request that arrived first, and
 *    **drops the later `confirm` as "rewound"** (measured) ⇒ the handshake never completes.
 *    ⇒ Carry it on **an order-preserving channel** (WebSocket / TCP).
 *
 * ⚠️⚠️ **`authorize` cannot be omitted** (codex high #3). It **enforces the registration check by type**.
 *    Just writing "the caller checks it" in a comment means that the moment someone misses it,
 *    **an unknown device gets a valid session key** (it passed in a measurement).
 * ⚠️⚠️ **Check the addressee too** (`agentFingerprint`). If it does not match, **reject without deriving keys**
 *    (ECDH does not fail on a mismatch, so staying silent would go unnoticed until "cannot decrypt").
 */
export async function acceptHandshake<T>(
  agentStatic: KeyPair,
  initMessage: Uint8Array,
  authorize: Authorize<T>,
): Promise<{
  message: Uint8Array
  confirm: Uint8Array
  session: Session
  deviceId: string
  /** ★ Exactly what `authorize` returned (= **the subject let through**. If falsy, the whole handshake was rejected) */
  authorized: NonNullable<T>
}> {
  // ⚠️ Copy byte arrays from outside (they may be overwritten during an `await` / codex low #1)
  const message0 = snapshot(initMessage)
  const init = parseInit(message0)
  const mine = await sha256(await exportPublicKey(agentStatic.publicKey))
  if (!sameBytes(init.agentFingerprint, mine)) throw new Error(t('宛先の agent が違います', 'Handshake is addressed to a different agent'))
  // ★★ **Build the identity (fingerprint) exactly once here, and use the same value for the check and the return value.**
  //   ⚠️⚠️ Without returning it, the caller could only pull it into a variable inside the `authorize` callback
  //      (= "the peer we agreed keys with" and "the identity" take different paths, and the mismatch cannot be prevented by type).
  const deviceId = await fingerprint(init.devicePublicRaw)
  // ⚠️ Check **before deriving keys** (do not compute for something we will reject)
  const authorized = await authorize({
    // ⚠️ Hand the caller **a copy** (if rewritten, the checked key and the key used for ECDH would disagree)
    devicePublicRaw: snapshot(init.devicePublicRaw),
    deviceId,
  })
  if (!authorized) throw new Error(t('登録されていないデバイスです', 'Device is not registered'))

  const eph = await newEphemeral()
  const reply = u8(
    new Uint8Array([V, REPLY_TYPE]),
    await exportPublicKey(eph.publicKey),
    newNonce(),
  )
  const transcript = u8(message0, reply)
  const dEph = await importPublicKey(init.deviceEphemeralRaw)
  const dStatic = await importPublicKey(init.devicePublicRaw)
  const ikm = u8(
    await ecdh(eph.privateKey, dEph), // z1 forward secrecy
    await ecdh(agentStatic.privateKey, dEph), // z2 authenticates the agent
    await ecdh(eph.privateKey, dStatic), // z3 authenticates the device
    await ecdh(agentStatic.privateKey, dStatic), // z4 static binding
  )
  const { d2a, a2d } = await deriveKeys(ikm, transcript)
  // The agent receives on d2a and sends on a2d
  const session = new SessionImpl(a2d, d2a, transcript)
  // ★★ **The confirm frame is built here** (removes the branch where the caller "forgets to send it" / codex medium #2).
  //    Its content is the transcript hash = the device can verify both reached the same key
  const confirm = await session.seal(FRAME.confirm, await sha256(transcript))
  return { message: reply, confirm, session, deviceId, authorized }
}

/** Device side. Receives the second message and opens the session */
/**
 * Device side. Receives the second message and returns a session that is **not yet usable**.
 *
 * ⚠️⚠️ **Does not return a `Session` here** (codex round 4 of 2026-09-01, medium #2).
 *    The design (item 4 of §14.1.2.6) said "add one confirm frame", but **there was no state transition**
 *    and requests could be sent before opening the confirm. ⇒ **A `Session` is only obtainable through `accept()`**.
 */
export interface PendingSession {
  /** Open the agent's confirm frame. ⚠️ Only once this passes does it become a `Session` */
  accept(confirmFrame: Uint8Array): Promise<Session>
}

export async function finishHandshake(h: Handshake, reply: Uint8Array): Promise<PendingSession> {
  const pending = states.get(h)
  if (!pending) throw new Error(t('握手の状態がありません', 'No handshake state'))
  // ⚠️⚠️ **Set the flag before the `await`** (synchronously). Set after, **two concurrent calls**
  //    both pass and two `Session`s with the same key and counter 0 are made (codex high #2).
  if (pending.used) throw new Error(t('この握手はもう使われています', 'This handshake has already been used'))
  pending.used = true
  const msg = snapshot(reply)
  if (msg.length !== REPLY_BYTES) throw new Error(t('ハンドシェイクの長さが違います', 'Wrong handshake length'))
  if (msg[0] !== V) throw new Error(t('版が違います', 'Wrong version'))
  if (msg[1] !== REPLY_TYPE) throw new Error(t('種別が違います', 'Wrong type'))
  const aEphRaw = msg.slice(2, 2 + PUBKEY_BYTES)
  const transcript = u8(pending.transcript, msg)
  const aEph = await importPublicKey(aEphRaw)
  const aStatic = await importPublicKey(pending.peerStaticRaw)
  const ikm = u8(
    await ecdh(pending.ephemeralPriv, aEph), // z1
    await ecdh(pending.ephemeralPriv, aStatic), // z2
    await ecdh(pending.staticPriv, aEph), // z3
    await ecdh(pending.staticPriv, aStatic), // z4
  )
  const { d2a, a2d } = await deriveKeys(ikm, transcript)
  // The device sends on d2a and receives on a2d
  const session = new SessionImpl(d2a, a2d, transcript)
  const want = await sha256(transcript)
  // ⚠️⚠️ **Success happens only once** (mutation ① of codex round 5 of 2026-09-01). Rewriting `return session`
  //    to `new SessionImpl(...)` stayed green = **a shape that could make several Sessions with the same key and counter 0**
  //    was still there. ⇒ Close it after success.
  let done = false
  return {
    async accept(confirmFrame: Uint8Array): Promise<Session> {
      if (done) throw new Error(t('この握手はもう確認済みです', 'This handshake has already been confirmed'))
      const { type, plaintext } = await session.open(confirmFrame)
      if (type !== FRAME.confirm) throw new Error(t('確認フレームではありません', 'Not a confirm frame'))
      if (!sameBytes(plaintext, want)) throw new Error(t('確認の中身が違います', 'Confirm payload does not match'))
      done = true
      return session
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Frames (§14.1.2.7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One connection.
 *
 * ⚠️⚠️ **The counter is never rewound.** The receiver requires "greater than before"
 *    (= rejects both resends and reordering).
 * ⚠️ **Do not use "a possible value" as a sentinel**: "nothing received yet" is `-1`
 *    (`0` would drop the first frame / same trap as `tail` in `log.ts`).
 */
/**
 * One connection.
 *
 * ⚠️⚠️ **Cannot be constructed from outside** (codex round 4 of 2026-09-01, high #3). With a public constructor,
 *    **passing the same key for send and receive** (= reflection attack and nonce collision), **making two with the same key and counter**,
 *    and **rewinding the counter** would all be possible, and **the invariants the handshake guaranteed would be
 *    undone through the public API** (measured: with the same key both ways, our own frames decrypted on our own side).
 * ⇒ **Only what passed the handshake** becomes a `Session`.
 */
export interface Session {
  seal(type: FrameType, plaintext: Uint8Array): Promise<Uint8Array>
  open(frame: Uint8Array): Promise<{ type: FrameType; plaintext: Uint8Array }>
  /** ★ Length of the derived key (so tests can check "should be 256 bits" mechanically) */
  readonly keyBits: number
  readonly transcript: Uint8Array
}

class SessionImpl implements Session {
  #send: Key
  #recv: Key
  #out: number
  #lastIn = -1
  /**
   * ⚠️⚠️ **Serialise `open`** (codex high #1 of 2026-09-01).
   *    There is an `await decrypt` between checking and updating the counter, so **calling it concurrently
   *    lets the same frame pass twice** (measured: `Promise.all([open(f), open(f)])` both succeeded).
   *    Also, running 1 and 0 concurrently let the later-finishing 0 **rewind** `#lastIn`,
   *    after which even a resend of 1 passed. ⇒ **Non-idempotent requests run twice.**
   * ⚠️ Do not break the chain on failure (the next `open` would stop working).
   */
  #chain: Promise<unknown> = Promise.resolve()
  /**
   * ⚠️⚠️ **Serialise sending too** (codex round 4 of 2026-09-01, medium #1). Counter reservation is synchronous, so
   *    nonces do not collide, but **encryption can finish out of order** (0 finishing after 1).
   *    With an implementation that sends in completion order, the receiver handles 1 and then **drops the legitimate 0 as "rewound"**.
   *    ⇒ The API guarantees **results come out in call order**.
   */
  #sendChain: Promise<unknown> = Promise.resolve()
  readonly transcript: Uint8Array

  constructor(send: Key, recv: Key, transcript: Uint8Array, startCounter = 0) {
    this.#send = send
    this.#recv = recv
    this.transcript = transcript
    this.#out = startCounter
  }

  /** ★ Length of the derived key (so tests can check "should be 256 bits" mechanically) */
  get keyBits(): number {
    const a = this.#send.algorithm as { length?: number }
    return a.length ?? 0
  }

  async seal(type: FrameType, plaintext: Uint8Array): Promise<Uint8Array> {
    // ⚠️⚠️ **Copy at the public entry** (codex round 5, medium #1). If the caller rewrites it
    //    while waiting in line, **the rewritten version is sent** (measured: "A" became "B")
    const body = snapshot(plaintext)
    const run = this.#sendChain.then(
      () => this.#seal(type, body),
      () => this.#seal(type, body),
    )
    this.#sendChain = run.catch(() => undefined)
    return run
  }

  async #seal(type: FrameType, plaintext: Uint8Array): Promise<Uint8Array> {
    if (this.#out >= MAX_COUNTER) throw new Error(t('カウンタが上限に達しました', 'Counter reached its limit'))
    const header = frameHeader(type, this.#out)
    const nonce = counterNonce(this.#out)
    this.#out += 1
    const ct = new Uint8Array(
      await subtle().encrypt(
        { name: 'AES-GCM', iv: nonce as Bin, additionalData: header as Bin },
        this.#send,
        plaintext as Bin,
      ),
    )
    return u8(header, ct)
  }

  /** ⚠️ Entry for serialisation. **Never call `#open` without going through here** */
  async open(frame: Uint8Array): Promise<{ type: FrameType; plaintext: Uint8Array }> {
    // ⚠️⚠️ **Copy at the public entry** (codex round 5, medium #1). Rewriting it while waiting in line
    //    makes it **processed as another legitimate frame** (non-idempotent requests run twice)
    const buf = snapshot(frame)
    // ⚠️ Wait for the previous result (success or failure) before starting. Do not break the chain with `catch`
    const run = this.#chain.then(
      () => this.#open(buf),
      () => this.#open(buf),
    )
    this.#chain = run.catch(() => undefined)
    return run
  }

  async #open(buf: Uint8Array): Promise<{ type: FrameType; plaintext: Uint8Array }> {
    if (buf.length <= HEADER_BYTES) throw new Error(t('フレームが短すぎます', 'Frame too short'))
    if (buf[0] !== V) throw new Error(t('版が違います', 'Wrong version'))
    const header = buf.slice(0, HEADER_BYTES)
    // ⚠️ **Never cast a value from the network as-is** (codex low #1).
    //    If a peer with the right key, or a future version, sends an unknown type, a value impossible for the type leaks out
    const type = toFrameType(buf[1])
    const counter = readCounter(header)
    // ⚠️⚠️ This is the only place that stops resends and replays
    if (counter <= this.#lastIn) throw new Error(t('カウンタが戻っています（再送か改竄）', 'Counter went backwards (replay or tampering)'))
    const plaintext = new Uint8Array(
      await subtle().decrypt(
        { name: 'AES-GCM', iv: counterNonce(counter) as Bin, additionalData: header as Bin },
        this.#recv,
        buf.slice(HEADER_BYTES) as Bin,
      ),
    )
    // ⚠️ Remember it **only when decryption succeeded** (advancing on a failed frame would drop the correct next one)
    this.#lastIn = counter
    return { type, plaintext }
  }
}

/** ⚠️ Types not in the table are dropped. Grows automatically when the table grows */
function toFrameType(raw: number | undefined): FrameType {
  const known = (Object.values(FRAME) as number[]).includes(raw ?? -1)
  if (!known) throw new Error(`${t('知らないフレームの種別です', 'Unknown frame type')}: ${raw}`)
  return raw as FrameType
}

/**
 * ⚠️⚠️ **Test only.** Builds a `Session` without a handshake (to reach states that cannot be built from outside, such as the limit branch).
 *    ⚠️ Never reference it from `src` (`web/src/discipline.test.ts` checks this mechanically).
 *    ★ Named so that it is obviously "unsafe".
 */
export function __unsafeSessionForTest(
  send: Key,
  recv: Key,
  startCounter = 0,
): Session {
  return new SessionImpl(send, recv, new Uint8Array(0), startCounter)
}

function frameHeader(type: number, counter: number): Uint8Array {
  const h = new Uint8Array(HEADER_BYTES)
  h[0] = V
  h[1] = type
  new DataView(h.buffer).setBigUint64(2, BigInt(counter))
  return h
}

function readCounter(header: Uint8Array): number {
  const n = new DataView(header.buffer, header.byteOffset, header.byteLength).getBigUint64(2)
  if (n > BigInt(MAX_COUNTER)) throw new Error(t('カウンタが大きすぎます', 'Counter too large'))
  return Number(n)
}

/** AEAD nonce (12B). ⚠️ Send and receive use different keys, so directions never mix */
function counterNonce(counter: number): Uint8Array {
  const n = new Uint8Array(12)
  new DataView(n.buffer).setBigUint64(4, BigInt(counter))
  return n
}
