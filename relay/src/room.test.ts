// Step 6 ③ of ③: the contents of the rendezvous (`relay/src/room.ts`).
//
// ★★ **Without this, not a single line of relay's decisions ran from `npm test`**
//   (2026-09-15 / codex round 4. They were only covered by the smoke test against a real relay).
//
// ★★ Mutations **targeted by name** here:
//   ① treating it as "the agent" before the proof passes (= knowing the key is enough to kick the real one)
//   ② ⚠️⚠️ no deadline for waiting-for-proof (**4 silent squatters lock the real one out forever** / high #1)
//   ③ letting a proof past the deadline through
//   ④ ⚠️⚠️ **reusing** connection numbers (a frame in flight reaches an unrelated device / medium #2)
//   ⑤ ⚠️⚠️ a retired agent disconnecting **also cuts the new agent's phones** (medium #3)
//   ⑥ letting text, oversized frames or `opened` from the agent through
//   ⑦ getting the add/strip of numbers wrong (the destination changes)
//   ⑧ ★ the free tier without sign-in (2026-09-27): a phone gets in without proving its key / a second machine passes on the
//      free tier / a proof naming someone else's key passes (fills their slot) / a message that crossed the challenge is lost or
//      forwarded before `opened` / a room that lost its ticket keeps carrying phones that never claimed the free tier

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ECDH_PARAMS,
  exportPublicKey,
  fromBase64Url,
  generateDeviceKey,
  relayProof,
  startHandshake,
  toBase64Url,
  type Jwk,
  type KeyPair,
} from '../../shared/crypto.ts'
import { decodeChallenge, decodeDeviceChallenge, encodeDeviceProof, encodeProof } from '../../shared/relayAuth.ts'
import {
  MAX_RELAY_BYTES,
  RELAY_FRAME,
  decodeRelayFrame,
  encodeRelayFrame,
} from '../../shared/relayFrame.ts'
import {
  CLOSE,
  FREE_ROOM_DEVICES,
  HELD_MAX_BYTES,
  MAX_DEVICES,
  MAX_PENDING_AGENTS,
  PROOF_DEADLINE_MS,
  Room,
  type RoomSocket,
  type Tag,
  MAX_PENDING_DEVICES,
  DEVICE_ADMIT_DEADLINE_MS,
  REASON,
} from './room.ts'
import { claimMachine, revokeCredential, type Ledger } from './ledger.ts'
import { claimRoom, type PhoneLedger } from './phoneLedger.ts'
import type { LicenseCheck } from '../../shared/license.ts'

interface Fake extends RoomSocket {
  readonly sent: Uint8Array[]
  closed?: { code: number; reason: string }
}

/**
 * Fake room.
 *
 * ⚠️⚠️ **Closed wires stay in `sockets()` too** (Cloudflare's `getWebSockets()` may
 *    return them even after `close()` = do not build a lenient fake / codex round 4, medium #3).
 */
function rig(
  o: {
    licenses?: Record<string, LicenseCheck>
    selfHosted?: boolean
    duringClaim?: () => void
    duringClaimAsync?: () => Promise<void>
    /** ★ The per-phone ledger (real `phoneLedger.ts`). Pass the same map to two rigs = two rooms seen by the same phones */
    phones?: Map<string, PhoneLedger>
    /** ⚠️ The phone ledger cannot be reached (★ a function = decided per call) */
    phoneLedgerDown?: boolean | (() => boolean)
    duringPhoneClaim?: () => void
    duringPhoneClaimAsync?: (n: number) => Promise<void>
    duringProof?: () => void
    /** ★ Rooms by agent key (shared between rigs = the Phones DO can tell the room a phone moved away from) */
    rooms?: Map<string, Room>
    /** ★ Challenges are made only after this resolves (= wires accepted together all wait inside `newChallenge`) */
    challengeGate?: Promise<void>
  } = {},
) {
  const all: { side: 'agent' | 'device'; socket: Fake }[] = []
  let now = 1_000_000
  // ★ The ledger is real (`ledger.ts`). Kept in memory per account
  const ledgers = new Map<string, Ledger>()
  const phones = o.phones ?? new Map<string, PhoneLedger>()
  const rooms = o.rooms ?? new Map<string, Room>()
  let phoneCalls = 0
  const room = new Room({
    sockets: (side) => all.filter((s) => s.side === side).map((s) => s.socket),
    newChallenge: async () => {
      await o.challengeGate
      const eph = (await crypto.subtle.generateKey(ECDH_PARAMS, true, [
        'deriveBits',
      ])) as KeyPair
      return {
        publicRaw: await exportPublicKey(eph.publicKey),
        jwk: (await crypto.subtle.exportKey('jwk', eph.privateKey)) as Jwk,
        nonce: crypto.getRandomValues(new Uint8Array(32)),
      }
    },
    importPrivate: async (jwk) => {
      // ★ What happens while a proof is being verified (⚠️ in reality, other events arrive during the crypto awaits)
      o.duringProof?.()
      return crypto.subtle.importKey('jwk', jwk as never, ECDH_PARAMS, false, ['deriveBits'])
    },
    publicRaw: (key) => fromBase64Url(key),
    now: () => now,
    // ★ Tickets are fake (the signature itself is covered by shared/license.test.ts): `<name>@<addressed key>` → table of results
    verifyLicense: async (token) => {
      const [name = '', key = ''] = token.split('@')
      const c = o.licenses?.[name]
      if (!c) return { ok: false, reason: 'malformed' }
      return c.ok ? { ok: true, license: { ...c.license, key } } : c
    },
    claimMachine: async (acct, key, max, mid) => {
      const r = claimMachine(ledgers.get(acct) ?? { machines: {}, revoked: {} }, key, max, now, mid)
      ledgers.set(acct, r.ledger)
      // ★ What happens while waiting for the ledger's reply (⚠️ in reality, other events arrive while awaiting the RPC)
      o.duringClaim?.()
      await o.duringClaimAsync?.()
      return r.ok ? 'ok' : (r.reason ?? 'machine-limit')
    },
    claimPhone: async (dkey, agentKey, licensed, takeover, connId) => {
      o.duringPhoneClaim?.()
      if (typeof o.phoneLedgerDown === 'function' ? o.phoneLedgerDown() : o.phoneLedgerDown) return 'unavailable'
      rooms.set(agentKey, room)
      // ★ The ledger commits at once (a Durable Object does), the **answer** may travel slowly (the hook holds it)
      const r = claimRoom(phones.get(dkey) ?? { rooms: {} }, agentKey, licensed, now, undefined, takeover)
      // ★ Same order as the Phones DO: the rooms left (and a room released by a Plus connect) are told **before** the ledger is written
      for (const left of r.moved) rooms.get(left)?.phoneFreeMoved(dkey)
      if (r.released) room.phoneFreeReleased(dkey, connId)
      phones.set(dkey, r.ledger)
      phoneCalls += 1
      await o.duringPhoneClaimAsync?.(phoneCalls)
      return r.ok ? 'ok' : 'machine-limit'
    },
    selfHosted: () => o.selfHosted ?? false,
  })
  const open = (side: 'agent' | 'device'): Fake => {
    let tag: Tag | null = null
    const socket: Fake = {
      sent: [],
      send: (bytes) => socket.sent.push(bytes),
      close: (code, reason) => {
        socket.closed ??= { code, reason }
      },
      tag: () => tag,
      setTag: (t) => {
        tag = t
      },
    }
    all.push({ side, socket })
    return socket
  }
  return {
    room,
    open,
    /** ⚠️ Remove the wire from the table (= really cleaned up) */
    forget: (s: Fake) => {
      const at = all.findIndex((x) => x.socket === s)
      if (at >= 0) all.splice(at, 1)
    },
    advance: (ms: number) => {
      now += ms
    },
    now: () => now,
    phones,
    /** ★ Removed on the account page (ledger → room order = same as the Accounts DO in `worker.ts`) */
    release: (acct: string, key: string, mid: string) => {
      const r = revokeCredential(ledgers.get(acct) ?? { machines: {}, revoked: {} }, key, mid, false, now)
      ledgers.set(acct, r.ledger)
      room.revokeLicense(acct, mid)
    },
  }
}

/** ★ Return a real proof and become the agent */
async function becomeAgent(r: ReturnType<typeof rig>, pair: KeyPair, o: { licensing?: boolean } = {}): Promise<Fake> {
  const key = toBase64Url(await exportPublicKey(pair.publicKey))
  assert.equal(r.room.admitAgent().ok, true)
  const socket = r.open('agent')
  await r.room.startAgent(socket, key, o.licensing === true, o.licensing === true)
  const challenge = decodeChallenge(socket.sent.shift() as Uint8Array)
  assert.ok(challenge.ok)
  const tag = await relayProof(pair.privateKey, challenge.value.relayPublicRaw, challenge.value.nonce)
  await r.room.onMessage(socket, encodeProof(tag).buffer as ArrayBuffer)
  assert.equal(socket.closed, undefined, 'cut despite a real proof')
  return socket
}

/** ★ Connect and stay waiting for proof (= someone who merely knows the key) */
async function pendingAgent(r: ReturnType<typeof rig>, key: string): Promise<Fake> {
  const socket = r.open('agent')
  await r.room.startAgent(socket, key)
  return socket
}

/**
 * ★ A phone connects (⚠️ by default a current app = it announces the key proof; `{ old: true }` = an app from before 2026-09-27).
 *   On our relay the wire then holds a challenge in `socket.sent` and nothing has reached the agent yet (see `prove`).
 */
async function joinDevice(r: ReturnType<typeof rig>, o: { old?: boolean; takeover?: boolean } = {}): Promise<{ socket: Fake; connId: number }> {
  assert.equal(r.room.admitDevice().ok, true, 'the phone is not accepted')
  const socket = r.open('device')
  return { socket, connId: await r.room.startDevice(socket, o.old !== true, o.takeover === true) }
}

/** ★ Answer the relay's challenge with a real proof for `identity` (⚠️ `naming` = claim to be another key: the impostor case) */
async function prove(r: ReturnType<typeof rig>, d: { socket: Fake }, identity: KeyPair, o: { naming?: Uint8Array } = {}): Promise<void> {
  const challenge = decodeDeviceChallenge(d.socket.sent.shift() as Uint8Array)
  assert.ok(challenge.ok, 'the phone did not receive a challenge')
  const tag = await relayProof(identity.privateKey, challenge.value.relayPublicRaw, challenge.value.nonce)
  const bytes = encodeDeviceProof({ devicePublicRaw: o.naming ?? (await exportPublicKey(identity.publicKey)), tag })
  await r.room.onMessage(d.socket, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
}

/**
 * ★ The handshake's first message a real phone sends for `identity` (the addressed agent does not matter to relay).
 *   ⚠️ relay only carries a phone whose first message names the key it proved (`#binds` / security audit 2026-09-28, F1/F2)
 */
async function initFor(identity: KeyPair): Promise<Uint8Array> {
  const anyAgent = await generateDeviceKey()
  return (await startHandshake(identity, await exportPublicKey(anyAgent.publicKey))).message
}

/**
 * ★ A phone that connected and proved its key (a fresh phone unless `identity` is given). `takeover` = it asked to move its free slot here.
 *   ★ Like the real app, the handshake's first message crossed the challenge (held, then forwarded after `opened`).
 */
async function freePhone(r: ReturnType<typeof rig>, identity?: KeyPair, o: { takeover?: boolean } = {}): Promise<{ socket: Fake; connId: number; identity: KeyPair }> {
  const id = identity ?? (await generateDeviceKey())
  const d = await joinDevice(r, o)
  const challenge = d.socket.sent.shift() as Uint8Array
  await r_onMessage(r, d.socket, await initFor(id))
  d.socket.sent.unshift(challenge)
  await prove(r, d, id)
  assert.equal(d.socket.closed, undefined, `the phone was cut after a real proof: ${d.socket.closed?.reason ?? ''}`)
  return { ...d, identity: id }
}

/** `opened` frames the agent received, by number (⚠️ a phone that did not get this far is unknown to the agent) */
function openedIds(agent: Fake): number[] {
  return agent.sent.flatMap((b) => {
    const d = decodeRelayFrame(b)
    return d.ok && d.value.type === RELAY_FRAME.opened ? [d.value.connId] : []
  })
}

test('★★ not treated as "the agent" until the proof passes (①)', async () => {
  const r = rig()
  const pair = await generateDeviceKey()
  const key = toBase64Url(await exportPublicKey(pair.publicKey))
  await pendingAgent(r, key)
  // ⚠️⚠️ A wire before proof is not "the agent" ⇒ phones get 503
  const before = r.room.admitDevice()
  assert.deepEqual(before, { ok: false, status: 503, text: REASON.noAgent })

  await becomeAgent(r, pair)
  assert.equal(r.room.admitDevice().ok, true)
})

test('★★ a bogus proof gets cut and cannot kick the real one (①)', async () => {
  const r = rig()
  const pair = await generateDeviceKey()
  const key = toBase64Url(await exportPublicKey(pair.publicKey))
  const real = await becomeAgent(r, pair)
  const { socket: phone } = await freePhone(r)

  const fake = await pendingAgent(r, key)
  fake.sent.length = 0
  // ⚠️⚠️ Send **a proof with the right shape and only wrong contents** (hit on 2026-09-15:
  //    sending plain garbage fails in the `decodeProof` branch and **never reaches the comparison** = the mutation slips through)
  await r.room.onMessage(fake, encodeProof(new Uint8Array(32).fill(9)).buffer as ArrayBuffer)
  assert.equal(fake.closed?.code, CLOSE.badProof)
  // ★ A proof with a broken shape is refused too (that is the earlier branch)
  const fake2 = await pendingAgent(r, key)
  await r.room.onMessage(fake2, new Uint8Array(34).fill(9).buffer as ArrayBuffer)
  assert.equal(fake2.closed?.code, CLOSE.badProof)
  // ⚠️⚠️ The real one and the phone are unharmed
  assert.equal(real.closed, undefined, '⚠️⚠️ the real agent got kicked')
  assert.equal(phone.closed, undefined, '⚠️⚠️ the phone got cut')
})

test('★★ waiting-for-proof has a deadline (② high #1: 4 wires cannot squat)', async () => {
  const r = rig()
  const pair = await generateDeviceKey()
  const key = toBase64Url(await exportPublicKey(pair.publicKey))
  const squatters: Fake[] = []
  for (let i = 0; i < MAX_PENDING_AGENTS; i++) squatters.push(await pendingAgent(r, key))
  // ⚠️ Hits the limit (correct so far)
  assert.equal(r.room.admitAgent().ok, false)

  // ★★ Collected after the deadline (⚠️⚠️ otherwise the real one can never connect)
  r.advance(PROOF_DEADLINE_MS + 1)
  const admit = r.room.admitAgent()
  assert.equal(admit.ok, true, '⚠️⚠️ expired waiting-for-proof wires were not collected')
  for (const s of squatters) assert.equal(s.closed?.code, CLOSE.badProof, 'a squatter remains')
  // ★ Afterwards the real one connects
  await becomeAgent(r, pair)
  assert.equal(r.room.admitDevice().ok, true)
})

test('★★ a proof past the deadline does not pass (③)', async () => {
  const r = rig()
  const pair = await generateDeviceKey()
  const key = toBase64Url(await exportPublicKey(pair.publicKey))
  const socket = await pendingAgent(r, key)
  const challenge = decodeChallenge(socket.sent.shift() as Uint8Array)
  assert.ok(challenge.ok)
  const proof = await relayProof(
    pair.privateKey,
    challenge.value.relayPublicRaw,
    challenge.value.nonce,
  )
  r.advance(PROOF_DEADLINE_MS + 1)
  await r.room.onMessage(socket, encodeProof(proof).buffer as ArrayBuffer)
  assert.equal(socket.closed?.code, CLOSE.badProof, '⚠️ a late proof passed')
  assert.equal(r.room.admitDevice().ok, false, '⚠️⚠️ became the agent without passing')
})

test('★★ connection numbers are not reused (④ medium #2)', async () => {
  const r = rig()
  const pair = await generateDeviceKey()
  await becomeAgent(r, pair)
  const first = await joinDevice(r)
  assert.equal(first.connId, 1)
  // ★ Disconnected and removed from the table too
  r.room.onClose(first.socket)
  r.forget(first.socket)
  const second = await joinDevice(r)
  // ⚠️⚠️ If this were 1, a frame in flight would reach **the new device**
  assert.equal(second.connId, 2, '⚠️⚠️ reused a connection number')
})

test('★★ numbers carry over when the agent reconnects (④ medium #2)', async () => {
  const r = rig()
  const pair = await generateDeviceKey()
  const old = await becomeAgent(r, pair)
  await joinDevice(r)
  // ★ Reconnect with the same key (= agent restart)
  const next = await becomeAgent(r, pair)
  assert.notEqual(next, old)
  assert.equal(old.closed?.code, CLOSE.agentGone)
  const after = await joinDevice(r)
  assert.equal(after.connId, 2, '⚠️⚠️ numbering went back to 1 on reconnect')
})

test('★★ when the agent reconnects, phones on the previous wire are cut (so they reconnect)', async () => {
  const r = rig()
  const pair = await generateDeviceKey()
  await becomeAgent(r, pair)
  const phone = await freePhone(r)
  // ★ Reconnect with the same key (= agent restart, network switch)
  await becomeAgent(r, pair)
  // ⚠️⚠️ The tunnel lives inside the agent, so **nobody is left to answer**
  assert.equal(phone.socket.closed?.code, CLOSE.agentGone, '⚠️⚠️ a stranded phone remained')
})

test('★★ a retired agent disconnecting does not cut the phones of the new agent (⑤ medium #3)', async () => {
  const r = rig()
  const pair = await generateDeviceKey()
  const old = await becomeAgent(r, pair)
  await becomeAgent(r, pair)
  const phone = await freePhone(r)

  // ⚠️⚠️ The old agent's disconnect arrives **late**
  r.room.onClose(old)
  assert.equal(phone.socket.closed, undefined, '⚠️⚠️ the phone of the new agent was cut')
})

test('★★ when the current agent disconnects, the phones hanging off it are cut', async () => {
  const r = rig()
  const pair = await generateDeviceKey()
  const agent = await becomeAgent(r, pair)
  const phone = await freePhone(r)
  r.room.onClose(agent)
  assert.equal(phone.socket.closed?.code, CLOSE.agentGone)
})

test('★★ adding and stripping numbers (⑦ contents do not change by a single byte)', async () => {
  const r = rig()
  const pair = await generateDeviceKey()
  const agent = await becomeAgent(r, pair)
  const a = await freePhone(r)
  const b = await freePhone(r)
  agent.sent.length = 0

  // phone → agent (a number is added)
  await r.room.onMessage(a.socket, new Uint8Array([1, 2, 3]).buffer as ArrayBuffer)
  const up = decodeRelayFrame(agent.sent.at(-1) as Uint8Array)
  assert.ok(up.ok)
  assert.equal(up.value.connId, a.connId)
  assert.deepEqual([...(up.value.payload ?? [])], [1, 2, 3])

  // agent → phone (the number is stripped and it reaches **only that one**)
  await r.room.onMessage(
    agent,
    encodeRelayFrame({
      type: RELAY_FRAME.data,
      connId: b.connId,
      payload: new Uint8Array([9, 9]),
    }).buffer as ArrayBuffer,
  )
  assert.deepEqual([...(b.socket.sent.at(-1) as Uint8Array)], [9, 9])
  assert.equal(a.socket.sent.length, 0, '⚠️⚠️ reached another device')
})

test('★★ a phone disconnecting is reported to the agent', async () => {
  const r = rig()
  const pair = await generateDeviceKey()
  const agent = await becomeAgent(r, pair)
  const phone = await freePhone(r)
  agent.sent.length = 0
  r.room.onClose(phone.socket)
  const f = decodeRelayFrame(agent.sent.at(-1) as Uint8Array)
  assert.ok(f.ok)
  assert.equal(f.value.type, RELAY_FRAME.closed)
  assert.equal(f.value.connId, phone.connId)
})

test('★★ input breaking the contract gets cut (⑥)', async () => {
  const r = rig()
  const pair = await generateDeviceKey()
  const agent = await becomeAgent(r, pair)

  // ⚠️ Text (the keepalive pong is answered first by the auto-response, so it never gets here)
  const s1 = (await joinDevice(r)).socket
  await r.room.onMessage(s1, 'ping')
  assert.equal(s1.closed?.code, CLOSE.badFrame)

  // ⚠️⚠️ Oversized (the ToS measure itself)
  const s2 = (await joinDevice(r)).socket
  await r.room.onMessage(s2, new ArrayBuffer(MAX_RELAY_BYTES + 1))
  assert.equal(s2.closed?.code, CLOSE.badFrame)

  // ⚠️ The agent cannot send anything but `data`
  await r.room.onMessage(
    agent,
    encodeRelayFrame({ type: RELAY_FRAME.opened, connId: 1 }).buffer as ArrayBuffer,
  )
  assert.equal(agent.closed?.code, CLOSE.badFrame)
})

/** ★ The agent replies to that number (= accepted the handshake) */
async function agentReplies(r: ReturnType<typeof rig>, agent: Fake, connId: number): Promise<void> {
  await r.room.onMessage(
    agent,
    encodeRelayFrame({ type: RELAY_FRAME.data, connId, payload: new Uint8Array([7]) }).buffer as ArrayBuffer,
  )
}

test('★★ device limit (⚠️ lives on the relay side, applied to **wires the agent accepted**)', async () => {
  // ★ A self-hosted relay: the whole allowance
  const r = rig({ selfHosted: true })
  const pair = await generateDeviceKey()
  const agent = await becomeAgent(r, pair)
  for (let i = 0; i < MAX_DEVICES; i++) await agentReplies(r, agent, (await joinDevice(r)).connId)
  assert.equal(r.room.admitDevice().ok, false)
  // ★ Our relay, a room without a ticket: the free tier (⚠️ from the plan table)
  assert.equal(FREE_ROOM_DEVICES, 2)
  const f = rig()
  const fa = await becomeAgent(f, await generateDeviceKey())
  for (let i = 0; i < FREE_ROOM_DEVICES; i++) await agentReplies(f, fa, (await freePhone(f)).connId)
  const third = f.room.admitDevice()
  assert.equal(third.ok, false, '⚠️⚠️ a third phone got into a free room')
  assert.equal(!third.ok && third.status, 429)
})

test('★★ even if someone who merely knows the key connects silently, a real phone gets in (2026-09-24 / the slot hole)', async () => {
  const r = rig()
  const pair = await generateDeviceKey()
  const agent = await becomeAgent(r, pair)
  // ⚠️ Connect more unaccepted wires than the limit (they never prove their key, the agent never replies = not registered)
  const squatters = []
  for (let i = 0; i < MAX_DEVICES + MAX_PENDING_DEVICES; i++) squatters.push(await joinDevice(r))
  // ★ Unaccepted wires have their own pool: always at most MAX_PENDING_DEVICES (oldest evicted first)
  const alive = squatters.filter((d) => d.socket.closed === undefined)
  assert.equal(alive.length, MAX_PENDING_DEVICES, `⚠️ ${alive.length} unaccepted wires remain`)
  for (const d of squatters.filter((d) => d.socket.closed)) assert.equal(d.socket.closed?.code, CLOSE.notAdmitted)
  // ★★ The real one gets in, becomes "accepted" once the agent replies, and is not evicted
  const real = await freePhone(r)
  await agentReplies(r, agent, real.connId)
  for (let i = 0; i < MAX_PENDING_DEVICES * 3; i++) await joinDevice(r)
  assert.equal(real.socket.closed, undefined, '⚠️⚠️ evicted an accepted wire')
  assert.deepEqual([...(real.socket.sent.at(-1) as Uint8Array)], [7], '⚠️ did not reach the accepted wire')
})

test('★★ a wire whose deadline passed unaccepted is collected at the next accept (cannot squat silently)', async () => {
  const r = rig()
  const pair = await generateDeviceKey()
  await becomeAgent(r, pair)
  const a = await joinDevice(r)
  r.advance(DEVICE_ADMIT_DEADLINE_MS - 1)
  await joinDevice(r)
  assert.equal(a.socket.closed, undefined, '⚠️ evicted before the deadline (would cut a real handshake)')
  r.advance(1)
  await joinDevice(r)
  // ⚠️ The assert above narrows the type to `undefined`, so read it again
  const after = (a.socket as { closed?: { code: number } }).closed
  assert.equal(after?.code, CLOSE.notAdmitted, '⚠️⚠️ still squatting after the deadline')
})

test('★★ evicted wires are not delivered to or counted (even if the closing wire lingers)', async () => {
  const r = rig()
  const pair = await generateDeviceKey()
  const agent = await becomeAgent(r, pair)
  const first = await joinDevice(r)
  const before = first.socket.sent.length
  for (let i = 0; i < MAX_PENDING_DEVICES; i++) await joinDevice(r)
  assert.equal(first.socket.closed?.code, CLOSE.notAdmitted)
  // ⚠️ The fake keeps closed wires in the table (the real one may too while closing)
  await agentReplies(r, agent, first.connId)
  assert.equal(first.socket.sent.length, before, '⚠️⚠️ delivered to an evicted wire')
})

test('★★ wires connected before this version (no deadline tag) count as accepted (not cut on deploy)', async () => {
  const r = rig()
  const pair = await generateDeviceKey()
  await becomeAgent(r, pair)
  const old = r.open('device')
  old.setTag({ side: 'device', connId: 99 })
  for (let i = 0; i < MAX_PENDING_DEVICES * 2; i++) await joinDevice(r)
  r.advance(DEVICE_ADMIT_DEADLINE_MS * 2)
  await joinDevice(r)
  assert.equal(old.closed, undefined, '⚠️⚠️ cut a real phone that had been connected since before the deploy')
})

test('★★ when full, the oldest wire is evicted (a new wire mid-handshake is not cut)', async () => {
  const r = rig()
  const pair = await generateDeviceKey()
  await becomeAgent(r, pair)
  const lines = []
  for (let i = 0; i < MAX_PENDING_DEVICES; i++) {
    lines.push(await joinDevice(r))
    r.advance(1_000)
  }
  await joinDevice(r)
  assert.equal(lines[0]!.socket.closed?.code, CLOSE.notAdmitted, '⚠️⚠️ the oldest wire remains')
  for (const d of lines.slice(1)) assert.equal(d.socket.closed, undefined, '⚠️⚠️ evicted a newer wire')
})

test('★★ the limit is checked at promotion from the waiting room too (7 + 4 waiting getting replies at once stays at 8 / codex round 18, medium #2)', async () => {
  const r = rig({ selfHosted: true })
  const pair = await generateDeviceKey()
  const agent = await becomeAgent(r, pair)
  for (let i = 0; i < MAX_DEVICES - 1; i++) await agentReplies(r, agent, (await joinDevice(r)).connId)
  const waiting = []
  for (let i = 0; i < MAX_PENDING_DEVICES; i++) waiting.push(await joinDevice(r))
  for (const d of waiting) await agentReplies(r, agent, d.connId)
  const admitted = waiting.filter((d) => d.socket.closed === undefined)
  assert.equal(admitted.length, 1, `⚠️⚠️ accepted ${MAX_DEVICES - 1 + admitted.length}, over the limit`)
  for (const d of waiting.filter((d) => d.socket.closed)) {
    assert.equal(d.socket.closed?.code, CLOSE.notAdmitted)
    assert.equal(d.socket.sent.length, 0, '⚠️ delivered to a wire closed at the limit')
  }
})

/** ★ Become the agent announcing `c=1` (⚠️ the ready that comes after the challenge is left in the returned sent) */
async function becomeControlAgent(r: ReturnType<typeof rig>, pair: KeyPair): Promise<Fake> {
  const key = toBase64Url(await exportPublicKey(pair.publicKey))
  assert.equal(r.room.admitAgent().ok, true)
  const socket = r.open('agent')
  await r.room.startAgent(socket, key, true)
  const challenge = decodeChallenge(socket.sent.shift() as Uint8Array)
  assert.ok(challenge.ok)
  const tag = await relayProof(pair.privateKey, challenge.value.relayPublicRaw, challenge.value.nonce)
  await r.room.onMessage(socket, encodeProof(tag).buffer as ArrayBuffer)
  assert.equal(socket.closed, undefined, 'cut despite a real proof')
  return socket
}

test('★★ ready is sent after the proof only to agents that announced c=1 (never send unknown types to old agents)', async () => {
  const r = rig()
  const named = await becomeControlAgent(r, await generateDeviceKey())
  const ready = decodeRelayFrame(named.sent.at(-1) as Uint8Array)
  assert.ok(ready.ok)
  assert.deepEqual(ready.value, { type: RELAY_FRAME.ready, connId: 0 })

  const r2 = rig()
  const plain = await becomeAgent(r2, await generateDeviceKey())
  assert.equal(plain.sent.length, 0, '⚠️⚠️ sent ready to an agent that did not announce it (an old agent cuts the whole wire)')
})

test('★★ no ready before the proof (only the key owner)', async () => {
  const r = rig()
  const pair = await generateDeviceKey()
  const socket = r.open('agent')
  await r.room.startAgent(socket, toBase64Url(await exportPublicKey(pair.publicKey)), true)
  assert.equal(socket.sent.length, 1, '⚠️ sent something other than the challenge')
  assert.ok(decodeChallenge(socket.sent[0] as Uint8Array).ok)
})

test('★★ on drop, the wire of the phone with that number is closed (even an accepted one / codex round 18, high #1)', async () => {
  const r = rig()
  const agent = await becomeControlAgent(r, await generateDeviceKey())
  const a = await freePhone(r)
  const b = await joinDevice(r)
  await agentReplies(r, agent, a.connId)
  await r.room.onMessage(agent, encodeRelayFrame({ type: RELAY_FRAME.drop, connId: a.connId }).buffer as ArrayBuffer)
  assert.equal(a.socket.closed?.code, CLOSE.notAdmitted, '⚠️⚠️ the wire remains after drop')
  assert.equal(b.socket.closed, undefined, '⚠️ closed another number too')
  assert.equal(agent.closed, undefined, '⚠️ drop cut the agent wire')
  // ⚠️ Unknown numbers are silently dropped
  await r.room.onMessage(agent, encodeRelayFrame({ type: RELAY_FRAME.drop, connId: 999 }).buffer as ArrayBuffer)
  assert.equal(agent.closed, undefined)
})

test('★★ drop from an agent that did not announce it is "a type that cannot be sent", as before', async () => {
  const r = rig()
  const agent = await becomeAgent(r, await generateDeviceKey())
  const a = await joinDevice(r)
  await r.room.onMessage(agent, encodeRelayFrame({ type: RELAY_FRAME.drop, connId: a.connId }).buffer as ArrayBuffer)
  assert.equal(agent.closed?.code, CLOSE.badFrame)
})

test('★★ the agent cannot send ready', async () => {
  const r = rig()
  const agent = await becomeControlAgent(r, await generateDeviceKey())
  await r.room.onMessage(agent, encodeRelayFrame({ type: RELAY_FRAME.ready, connId: 0 }).buffer as ArrayBuffer)
  assert.equal(agent.closed?.code, CLOSE.badFrame)
})

test('★★ close reasons put English and Japanese side by side and fit the WebSocket limit (123 bytes of UTF-8)', () => {
  const enc = new TextEncoder()
  for (const [name, reason] of Object.entries(REASON)) {
    // ⚠️ `malformed` gets `/ <relayFrame reason>` appended, so measure with the longest reason added
    const full = name === 'malformed' ? `${reason} / この種別に中身は付きません` : reason
    assert.ok(enc.encode(full).length <= 123, `${name}: ${enc.encode(full).length} bytes`)
    if (name !== 'malformed') assert.match(reason, /^[ -~]+ \/ .*[ぁ-んァ-ヶ一-龠]/, `${name} is "English / Japanese"`)
  }
})

// ─── ★★ License tickets (2026-09-24 / billing / docs/BILLING.md) ────────────────────────

const LIC_FREE: LicenseCheck = {
  ok: true,
  license: { v: 3, acct: 'acct_free_01', key: '', mid: 'm_free0001', plan: 'free', maxMachines: 1, maxDevices: 2, iat: 1, exp: 4_000_000_000 },
}
const PLUS = { v: 3, acct: 'acct_plus_01', key: '', mid: 'm_plus0001', plan: 'plus', maxMachines: 5, maxDevices: 5, iat: 1, exp: 4_000_000_000 } as const
const LIC_PLUS: LicenseCheck = { ok: true, license: PLUS }
/** ★ A Plus ticket with LIC_FREE's account and number (tests of "a paid room" that also release it / 2026-09-27: only Plus is outside the phones' free tier) */
const LIC_PAID: LicenseCheck = { ok: true, license: { ...(LIC_FREE.ok ? LIC_FREE.license : PLUS), plan: 'plus', maxMachines: 5, maxDevices: 5 } }

/** Ticket replies (their text) that reached the agent, oldest first */
function licenseResults(agent: Fake): string[] {
  return agent.sent.flatMap((b) => {
    const d = decodeRelayFrame(b)
    return d.ok && d.value.type === RELAY_FRAME.licenseResult ? [new TextDecoder().decode(d.value.payload)] : []
  })
}

/** ★ Send a ticket (⚠️ by default addressed to this agent's key. `for` addresses another key) */
async function sendLicense(r: ReturnType<typeof rig>, agent: Fake, name: string, o: { for?: string } = {}): Promise<void> {
  const token = `${name}@${o.for ?? agent.tag()?.key ?? ''}`
  const frame = encodeRelayFrame({ type: RELAY_FRAME.license, connId: 0, payload: new TextEncoder().encode(token) })
  await r.room.onMessage(agent, frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer)
}

test('★★ want is sent only to agents that announced ticket support (l=1) (old agents cut the whole wire on unknown types)', async () => {
  const r = rig()
  const old = await becomeAgent(r, await generateDeviceKey())
  assert.deepEqual(licenseResults(old), [])
  const r2 = rig()
  const neu = await becomeAgent(r2, await generateDeviceKey(), { licensing: true })
  assert.deepEqual(licenseResults(neu), ['want'])
})

test('★★ when a ticket passes, the phone limit is the plan value (Free: 2)', async () => {
  const r = rig({ licenses: { FREE: LIC_FREE } })
  const agent = await becomeAgent(r, await generateDeviceKey(), { licensing: true })
  await sendLicense(r, agent, 'FREE')
  assert.deepEqual(licenseResults(agent), ['want', 'ok'])
  for (let i = 0; i < 2; i++) await agentReplies(r, agent, (await freePhone(r)).connId)
  assert.equal(r.room.admitDevice().ok, false, '⚠️⚠️ let a third phone through on Free')
})

test('★★ in the same room, a second key of the same account is refused (the ledger is per account)', async () => {
  const r = rig({ licenses: { FREE: LIC_FREE } })
  const a = await becomeAgent(r, await generateDeviceKey(), { licensing: true })
  await sendLicense(r, a, 'FREE')
  // An agent with a different key on the same rig (= the same ledger) claims the same account
  const b = await becomeAgent(r, await generateDeviceKey(), { licensing: true })
  await sendLicense(r, b, 'FREE')
  assert.deepEqual(licenseResults(b), ['want', 'machine-limit'])
})

test('★★ broken or expired tickets do not pass, and the previous ticket is removed too (do not keep the previous limit)', async () => {
  const r = rig({ licenses: { PLUS: LIC_PLUS, OLD: { ok: false, reason: 'expired' } } })
  const agent = await becomeAgent(r, await generateDeviceKey(), { licensing: true })
  await sendLicense(r, agent, 'PLUS')
  await sendLicense(r, agent, 'OLD')
  await sendLicense(r, agent, 'garbage')
  assert.deepEqual(licenseResults(agent), ['want', 'ok', 'expired', 'invalid'])
  assert.equal(agent.tag()?.lic, undefined, '⚠️ the previous ticket remained despite failing')
})

// ─── ★★ The free tier without sign-in (2026-09-27 / docs/BILLING.md §2.2) ────────────────────────

test('★★ a room without a ticket takes phones that proved their key; nothing reaches the agent before the proof (⑧)', async () => {
  const r = rig()
  const agent = await becomeAgent(r, await generateDeviceKey())
  const d = await joinDevice(r)
  // ⚠️ The agent has not been told about this phone yet, and the phone only holds the challenge
  assert.deepEqual(openedIds(agent), [], '⚠️⚠️ opened was sent before the proof')
  assert.equal(d.socket.sent.length, 1)
  assert.ok(decodeDeviceChallenge(d.socket.sent[0] as Uint8Array).ok, 'the first message is not a device challenge')
  // ⚠️ It cannot be answered with the agent's proof shape, nor with garbage of the right length
  const wrongShape = encodeProof(new Uint8Array(32).fill(1))
  await r.room.onMessage(d.socket, wrongShape.buffer.slice(wrongShape.byteOffset, wrongShape.byteOffset + wrongShape.byteLength) as ArrayBuffer)
  assert.equal(d.socket.closed, undefined, 'a small crossing message is held, not cut')
  const identity = await generateDeviceKey()
  await prove(r, d, identity)
  // ⚠️⚠️ ...but a held message that is not a handshake naming the proven key never reaches the agent (F1/F2)
  assert.deepEqual(d.socket.closed, { code: CLOSE.badProof, reason: REASON.keyMismatch })
  assert.deepEqual(openedIds(agent), [], '⚠️⚠️ opened was sent for a phone whose held message did not bind')
  // ★ A real phone: its handshake crosses the challenge, then the proof
  const e = await joinDevice(r)
  const challenge = e.socket.sent.shift() as Uint8Array
  await r_onMessage(r, e.socket, await initFor(identity))
  e.socket.sent.unshift(challenge)
  await prove(r, e, identity)
  assert.equal(e.socket.closed, undefined, `cut after a real proof: ${e.socket.closed?.reason ?? ''}`)
  assert.deepEqual(openedIds(agent), [e.connId], '⚠️⚠️ the agent was not told opened after the proof')
  assert.equal(e.socket.tag()?.free, true, 'the wire does not carry the free-tier mark')
  assert.equal(e.socket.tag()?.dkey, toBase64Url(await exportPublicKey(identity.publicKey)))
  // ★ From here on, bytes are carried
  await agentReplies(r, agent, e.connId)
  assert.deepEqual([...(e.socket.sent.at(-1) as Uint8Array)], [7])
})

test('★★ the handshake must name the key the phone proved to relay (security audit 2026-09-28, F1/F2)', async () => {
  const phones = new Map<string, PhoneLedger>()
  const victim = await generateDeviceKey()
  const r = rig({ phones })
  const agent = await becomeAgent(r, await generateDeviceKey())
  // F1: prove your own key, then name the victim's **public** key in the handshake (held before the proof)
  const held = await joinDevice(r)
  const c1 = held.socket.sent.shift() as Uint8Array
  await r_onMessage(r, held.socket, await initFor({ publicKey: victim.publicKey, privateKey: (await generateDeviceKey()).privateKey }))
  held.socket.sent.unshift(c1)
  await prove(r, held, await generateDeviceKey())
  assert.deepEqual(held.socket.closed, { code: CLOSE.badProof, reason: REASON.keyMismatch }, '⚠️⚠️ a held handshake naming another key went on')
  // ...or send it after the proof
  const after = await joinDevice(r)
  await prove(r, after, await generateDeviceKey())
  assert.equal(after.socket.closed, undefined)
  agent.sent.length = 0
  await r_onMessage(r, after.socket, await initFor({ publicKey: victim.publicKey, privateKey: (await generateDeviceKey()).privateKey }))
  assert.deepEqual(after.socket.closed, { code: CLOSE.badProof, reason: REASON.keyMismatch }, '⚠️⚠️ a later handshake naming another key went on')
  assert.equal(agent.sent.filter((b) => decodeRelayFrame(b).ok && (decodeRelayFrame(b) as { value: { type: number } }).value.type === RELAY_FRAME.data).length, 0, '⚠️⚠️ the forged handshake reached the agent')
  // ⚠️ Anything that is not a handshake as the first message is refused too (no way to skip the check)
  const junk = await joinDevice(r)
  await prove(r, junk, await generateDeviceKey())
  await r_onMessage(r, junk.socket, new Uint8Array([1, 2, 3]))
  assert.equal(junk.socket.closed?.reason, REASON.keyMismatch)
  // ★ The proven key in its own handshake passes, sent after the proof as well; later frames are not handshakes and still pass
  const own = await generateDeviceKey()
  const ok = await joinDevice(r)
  await prove(r, ok, own)
  await r_onMessage(r, ok.socket, await initFor(own))
  await r_onMessage(r, ok.socket, new Uint8Array([4, 5, 6]))
  assert.equal(ok.socket.closed, undefined, `cut a phone naming its own key: ${ok.socket.closed?.reason ?? ''}`)
  // ★ F2 in one line: the ledger only ever saw keys that the agent was handed, so one paired key = one free machine
  assert.equal(phones.has(toBase64Url(await exportPublicKey(victim.publicKey))), false)
})

test('★★ a proof with wrong contents does not pass, and a proof naming someone else\'s key does not fill their slot (⑧ impostor)', async () => {
  const phones = new Map<string, PhoneLedger>()
  const victim = await generateDeviceKey()
  const victimRaw = await exportPublicKey(victim.publicKey)
  // The attacker's own room (its agent replies to anything)
  const evil = rig({ phones })
  await becomeAgent(evil, await generateDeviceKey())
  const impostor = await joinDevice(evil)
  await prove(evil, impostor, await generateDeviceKey(), { naming: victimRaw })
  assert.equal(impostor.socket.closed?.code, CLOSE.badProof, '⚠️⚠️ a proof naming another key passed')
  assert.equal(impostor.socket.closed?.reason, REASON.notOwner)
  assert.equal(phones.has(toBase64Url(victimRaw)), false, '⚠️⚠️ the victim\'s ledger was touched')
  // ★ The victim then claims its own machine as usual
  const home = rig({ phones })
  await becomeAgent(home, await generateDeviceKey())
  await freePhone(home, victim)
  // ⚠️ Wrong contents with the right key: same refusal
  const d = await joinDevice(home)
  const bad = encodeDeviceProof({ devicePublicRaw: victimRaw, tag: new Uint8Array(32).fill(9) })
  await r_onMessage(home, d.socket, bad)
  assert.equal(d.socket.closed?.code, CLOSE.badProof)
})

/** ⚠️ `onMessage` takes an ArrayBuffer (like the Durable Object) */
async function r_onMessage(r: ReturnType<typeof rig>, socket: Fake, bytes: Uint8Array): Promise<void> {
  await r.room.onMessage(socket, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
}

test('★★ one machine per phone on the free tier: the second machine is refused with a reason; rooms with a ticket are not counted (⑧)', async () => {
  const phones = new Map<string, PhoneLedger>()
  const a = rig({ phones })
  await becomeAgent(a, await generateDeviceKey())
  const b = rig({ phones, licenses: { PLUS: LIC_PLUS } })
  const agentB = await becomeAgent(b, await generateDeviceKey(), { licensing: true })
  const c = rig({ phones })
  await becomeAgent(c, await generateDeviceKey())
  const phone = await generateDeviceKey()
  // Machine A on the free tier: ok
  await freePhone(a, phone)
  // Machine C on the free tier: refused (A holds the phone's free slot) — with a reason the app can show
  const onC = await joinDevice(c)
  await prove(c, onC, phone)
  assert.deepEqual(onC.socket.closed, { code: CLOSE.freeUsed, reason: REASON.freeUsed }, '⚠️⚠️ a second machine passed on the free tier')
  // Machine B with a plan ticket: passes, and is not the phone's free slot
  await sendLicense(b, agentB, 'PLUS')
  const onB = await freePhone(b, phone)
  assert.equal(onB.socket.tag()?.free, undefined, '⚠️ a licensed room was marked as the free slot')
  assert.equal(onB.socket.tag()?.dkey, toBase64Url(await exportPublicKey(phone.publicKey)))
  // ★ A reconnect to A keeps working (the slot is A's)
  await freePhone(a, phone)
  // ★ A signs in later ⇒ connecting to it releases the slot ⇒ C is now allowed
  const aLic = rig({ phones, licenses: { FREE: LIC_PAID } })
  const agentA2 = await becomeAgent(aLic, await generateDeviceKey(), { licensing: true })
  await sendLicense(aLic, agentA2, 'FREE')
  await freePhone(aLic, phone)
  // (A's key differs in this rig; release the real A's key the same way the DO would)
  phones.set(toBase64Url(await exportPublicKey(phone.publicKey)), { rooms: {} })
  await freePhone(c, phone)
})

test('★★ the handshake\'s first message may cross the challenge: held once, forwarded after opened, in order (⑧)', async () => {
  const r = rig()
  const agent = await becomeAgent(r, await generateDeviceKey())
  const d = await joinDevice(r)
  const identity = await generateDeviceKey()
  const init = await initFor(identity)
  const challenge = d.socket.sent.shift() as Uint8Array
  await r_onMessage(r, d.socket, init)
  d.socket.sent.unshift(challenge)
  assert.equal(d.socket.closed, undefined, '⚠️⚠️ cut a phone whose handshake crossed the challenge')
  assert.deepEqual(openedIds(agent), [], '⚠️⚠️ the held message reached the agent before the proof')
  await prove(r, d, identity)
  const frames = agent.sent.flatMap((b) => {
    const x = decodeRelayFrame(b)
    return x.ok ? [x.value] : []
  })
  const tail = frames.slice(-2)
  assert.deepEqual(tail.map((f) => f.type), [RELAY_FRAME.opened, RELAY_FRAME.data], '⚠️⚠️ the held message was not forwarded right after opened')
  assert.deepEqual([...(tail[1]?.payload ?? [])], [...init])
  // ⚠️ A second message before the proof, or an oversized one, cuts the wire (bounded hold)
  const e = await joinDevice(r)
  await r_onMessage(r, e.socket, new Uint8Array(10).fill(1))
  await r_onMessage(r, e.socket, new Uint8Array(10).fill(2))
  assert.equal(e.socket.closed?.code, CLOSE.badProof, '⚠️ held more than one message')
  const f = await joinDevice(r)
  await r_onMessage(r, f.socket, new Uint8Array(HELD_MAX_BYTES + 1).fill(1))
  assert.equal(f.socket.closed?.code, CLOSE.badProof, '⚠️ held an oversized message')
})

test('★★ an old app (no key proof) is closed with "update the app" in every room on our relay; a self-hosted relay never challenges (⑧)', async () => {
  const r = rig()
  const agent = await becomeAgent(r, await generateDeviceKey())
  const old = await joinDevice(r, { old: true })
  assert.deepEqual(old.socket.closed, { code: CLOSE.updateApp, reason: REASON.updateApp }, '⚠️⚠️ an app without the proof got into a free room')
  assert.deepEqual(openedIds(agent), [])
  // ⚠️⚠️ A Plus room too (codex 2026-09-28): an unproven wire leaves `#binds` nothing to compare with, so it could name a
  //    registered phone's public key and hold the slots (F1). ★ A current app still gets in
  const lic = rig({ licenses: { PLUS: LIC_PLUS } })
  const la = await becomeAgent(lic, await generateDeviceKey(), { licensing: true })
  await sendLicense(lic, la, 'PLUS')
  const onLic = await joinDevice(lic, { old: true })
  assert.deepEqual(onLic.socket.closed, { code: CLOSE.updateApp, reason: REASON.updateApp }, '⚠️⚠️ an app without the proof got into a Plus room')
  assert.deepEqual(openedIds(la), [])
  const current = await freePhone(lic)
  assert.deepEqual(openedIds(la), [current.connId])
  // A self-hosted relay: never challenges anyone
  const self = rig({ selfHosted: true })
  const sa = await becomeAgent(self, await generateDeviceKey())
  const onSelf = await joinDevice(self)
  assert.equal(onSelf.socket.sent.length, 0, '⚠️⚠️ a self-hosted relay challenged a phone')
  assert.deepEqual(openedIds(sa), [onSelf.connId])
})

test('★★ a phone that proved its key is still refused when the free-tier ledger cannot be reached; a licensed room carries on (fail-closed)', async () => {
  const r = rig({ phoneLedgerDown: true })
  await becomeAgent(r, await generateDeviceKey())
  const d = await joinDevice(r)
  await prove(r, d, await generateDeviceKey())
  assert.deepEqual(d.socket.closed, { code: CLOSE.unavailable, reason: REASON.ledgerDown }, '⚠️⚠️ let a phone in without checking the free tier')
  const lic = rig({ phoneLedgerDown: true, licenses: { FREE: LIC_PAID } })
  const la = await becomeAgent(lic, await generateDeviceKey(), { licensing: true })
  await sendLicense(lic, la, 'FREE')
  await freePhone(lic)
})

test('★★ a proof after the deadline, or a second proof while the ledger answers, does not pass (⑧)', async () => {
  const r = rig()
  await becomeAgent(r, await generateDeviceKey())
  const late = await joinDevice(r)
  r.advance(DEVICE_ADMIT_DEADLINE_MS + 1)
  await prove(r, late, await generateDeviceKey())
  assert.equal(late.socket.closed?.code, CLOSE.badProof, '⚠️ a late proof passed')
  assert.equal(late.socket.closed?.reason, REASON.lateProof)
})

test('★★ the agent leaving while the ledger answers: the phone is closed and no opened is sent to a newcomer', async () => {
  let during = () => {}
  const r = rig({ duringPhoneClaim: () => during() })
  const pair = await generateDeviceKey()
  const agent = await becomeAgent(r, pair)
  const d = await joinDevice(r)
  during = () => {
    during = () => {}
    r.room.onClose(agent)
  }
  await prove(r, d, await generateDeviceKey())
  assert.equal(d.socket.closed?.code, CLOSE.agentGone)
  // The agent comes back: it must not have been told about that phone
  const next = await becomeAgent(r, pair)
  assert.deepEqual(openedIds(next), [])
})

test('★★ the agent cannot promote or reach a phone that has not proved its key (no opened was sent for it)', async () => {
  const r = rig()
  const agent = await becomeAgent(r, await generateDeviceKey())
  const d = await joinDevice(r)
  const before = d.socket.sent.length
  await agentReplies(r, agent, d.connId)
  assert.equal(d.socket.sent.length, before, '⚠️⚠️ delivered to a phone before its proof')
  assert.equal(d.socket.tag()?.admitted, undefined, '⚠️⚠️ promoted a phone before its proof')
  assert.ok(d.socket.tag()?.dpending, 'the proof state was lost')
})

test('★★ a room that loses its ticket closes the phones admitted under it (they reconnect and claim the free tier); phones holding the free slot stay', async () => {
  const r = rig({ licenses: { FREE: LIC_PAID } })
  const agent = await becomeAgent(r, await generateDeviceKey(), { licensing: true })
  // A phone admitted before the ticket arrived holds the free slot
  const early = await freePhone(r)
  await agentReplies(r, agent, early.connId)
  await sendLicense(r, agent, 'FREE')
  const under = await freePhone(r)
  await agentReplies(r, agent, under.connId)
  assert.equal(under.socket.tag()?.free, undefined)
  // The ticket is removed ⇒ the room is the free tier again
  r.release(LIC_PAID.ok ? LIC_PAID.license.acct : '', agent.tag()!.key!, LIC_PAID.ok ? LIC_PAID.license.mid : '')
  assert.deepEqual(under.socket.closed, { code: CLOSE.planChanged, reason: REASON.planChanged }, '⚠️⚠️ kept carrying a phone that never claimed the free tier')
  assert.equal(early.socket.closed, undefined, '⚠️⚠️ closed a phone that holds this room as its free slot')
})

test('★★ a self-hosted relay asks for no ticket, and every room takes MAX_DEVICES phones (2026-09-25 / codex)', async () => {
  const r = rig({ licenses: { FREE: LIC_PAID }, selfHosted: true })
  // A signed-in agent (old or new) announces tickets …
  const agent = await becomeAgent(r, await generateDeviceKey(), { licensing: true })
  // … but is never asked, so it never sends one
  assert.deepEqual(licenseResults(agent), [], '⚠️⚠️ asked a self-hosted room for our ticket (our plan limits would apply)')
  assert.equal(agent.tag()?.licensing, undefined)
  for (let i = 0; i < MAX_DEVICES; i++) await agentReplies(r, agent, (await joinDevice(r)).connId)
  assert.equal(r.room.admitDevice().ok, false, 'still capped at MAX_DEVICES')
  // ★ Even with the sign-in date set by mistake, no phone is refused with 402
  const r2 = rig({ selfHosted: true })
  await becomeAgent(r2, await generateDeviceKey(), { licensing: true })
  assert.equal(r2.room.admitDevice().ok, true)
})

test('★★ a ticket from an agent that did not announce it is cut as "a type that cannot be sent", as before', async () => {
  const r = rig({ licenses: { FREE: LIC_PAID } })
  const agent = await becomeAgent(r, await generateDeviceKey())
  await sendLicense(r, agent, 'FREE')
  assert.equal(agent.closed?.code, CLOSE.badFrame)
})

test('★★ the ticket limit does not exceed the room limit (MAX_DEVICES)', async () => {
  const big: LicenseCheck = { ok: true, license: { ...PLUS, maxDevices: 99 } }
  const r = rig({ licenses: { BIG: big } })
  const agent = await becomeAgent(r, await generateDeviceKey(), { licensing: true })
  await sendLicense(r, agent, 'BIG')
  for (let i = 0; i < MAX_DEVICES; i++) await agentReplies(r, agent, (await freePhone(r)).connId)
  assert.equal(r.room.admitDevice().ok, false)
})

/** ★ One message from a phone (⚠️ if carried, data reaches the agent) */
async function deviceSends(r: ReturnType<typeof rig>, device: Fake): Promise<void> {
  await r.room.onMessage(device, new Uint8Array([1, 2, 3]).buffer as ArrayBuffer)
}

test('★★ a ticket addressed to the key of another machine does not pass (codex round 26, high #3)', async () => {
  const r = rig({ licenses: { PLUS: LIC_PLUS } })
  const agent = await becomeAgent(r, await generateDeviceKey(), { licensing: true })
  const other = toBase64Url(await exportPublicKey((await generateDeviceKey()).publicKey))
  await sendLicense(r, agent, 'PLUS', { for: other })
  assert.deepEqual(licenseResults(agent), ['want', 'invalid'], '⚠️⚠️ accepted a ticket for another key')
  assert.equal(agent.tag()?.lic, undefined)
})

test('★★ when a ticket expires, phones admitted under it are closed too (codex round 26, high #2)', async () => {
  const short: LicenseCheck = { ok: true, license: { ...(LIC_PAID.ok ? LIC_PAID.license : PLUS), exp: 1_100 } }
  const r = rig({ licenses: { SHORT: short } })
  const agent = await becomeAgent(r, await generateDeviceKey(), { licensing: true })
  await sendLicense(r, agent, 'SHORT')
  const d = await freePhone(r)
  await agentReplies(r, agent, d.connId)
  r.advance(200_000)
  const before = agent.sent.length
  await deviceSends(r, d.socket)
  assert.deepEqual(d.socket.closed, { code: CLOSE.planChanged, reason: REASON.planChanged }, '⚠️⚠️ kept carrying with an expired ticket')
  assert.equal(agent.sent.slice(before).some((b) => ((x) => x.ok && x.value.type === RELAY_FRAME.data)(decodeRelayFrame(b))), false, '⚠️ carried something from a closed wire')
  assert.deepEqual(licenseResults(agent).slice(-1), ['expired'])
})

test('★★ a phone from before this version (no deadline tag) in a room without a ticket is closed at the next message so it reconnects', async () => {
  const r = rig()
  const agent = await becomeAgent(r, await generateDeviceKey())
  const old = r.open('device')
  old.setTag({ side: 'device', connId: 99 })
  await agentReplies(r, agent, 99)
  assert.equal(old.closed?.code, CLOSE.planChanged)
})

test('★★ when the ticket changes Plus → Free, excess phones are closed latest first (codex round 26, high #2)', async () => {
  const r = rig({ licenses: { PLUS: LIC_PLUS, FREE: { ok: true, license: { ...PLUS, plan: 'free', maxMachines: 1, maxDevices: 2 } } } })
  const agent = await becomeAgent(r, await generateDeviceKey(), { licensing: true })
  await sendLicense(r, agent, 'PLUS')
  const ds = []
  for (let i = 0; i < 5; i++) {
    const d = await freePhone(r)
    await agentReplies(r, agent, d.connId)
    ds.push(d)
  }
  await sendLicense(r, agent, 'FREE')
  // ★ 2026-09-27: a Free ticket is inside the phones' free tier ⇒ phones admitted under Plus (no free mark) all reconnect and claim it
  assert.deepEqual(
    ds.map((d) => d.socket.closed?.code ?? null),
    [CLOSE.planChanged, CLOSE.planChanged, CLOSE.planChanged, CLOSE.planChanged, CLOSE.planChanged],
    '⚠️⚠️ still 5 after going back to Free',
  )
})

test('★★ removed from the account: the room ticket is removed too, and the same ticket at hand cannot bring it back (codex round 26, high #3)', async () => {
  const r = rig({ licenses: { FREE: LIC_PAID } })
  const agent = await becomeAgent(r, await generateDeviceKey(), { licensing: true })
  await sendLicense(r, agent, 'FREE')
  const d = await freePhone(r)
  await agentReplies(r, agent, d.connId)
  r.advance(10)
  r.release(LIC_PAID.ok ? LIC_PAID.license.acct : '', agent.tag()!.key!, LIC_PAID.ok ? LIC_PAID.license.mid : '')
  assert.equal(agent.tag()?.lic, undefined, '⚠️⚠️ the room ticket remained after removal')
  assert.equal(d.socket.closed?.reason, REASON.planChanged)
  assert.deepEqual(licenseResults(agent).slice(-1), ['revoked'])
  await sendLicense(r, agent, 'FREE')
  assert.deepEqual(licenseResults(agent).slice(-1), ['revoked'], '⚠️⚠️ came back with the ticket from before removal')
  assert.equal(agent.tag()?.lic, undefined)
})

test('★★ if removed while waiting for the ledger reply, the returning "may pass" is not used', async () => {
  let release = () => {}
  const r = rig({ licenses: { FREE: LIC_PAID }, duringClaim: () => release() })
  const agent = await becomeAgent(r, await generateDeviceKey(), { licensing: true })
  release = () => {
    release = () => {}
    r.room.revokeLicense('acct_free_01', 'm_free0001')
  }
  await sendLicense(r, agent, 'FREE')
  assert.equal(agent.tag()?.lic, undefined, '⚠️⚠️ attached a ticket although it was removed')
  assert.deepEqual(licenseResults(agent).slice(-1), ['revoked'])
})

test('★★ a "remove" from another account or another passphrase does not remove the room ticket (codex round 27, high #1)', async () => {
  const r = rig({ licenses: { FREE: LIC_PAID } })
  const agent = await becomeAgent(r, await generateDeviceKey(), { licensing: true })
  await sendLicense(r, agent, 'FREE')
  const d = await freePhone(r)
  await agentReplies(r, agent, d.connId)
  // The attacker claims this key under their own account and removes their own passphrase
  r.room.revokeLicense('acct_attacker', 'm_attack001')
  r.room.revokeLicense('acct_free_01', 'm_other0001')
  assert.ok(agent.tag()?.lic, '⚠️⚠️ a "remove" by a stranger removed the ticket of the victim')
  assert.equal(d.socket.closed, undefined)
})

test('★★ removal marks for in-flight checks are not pushed out however many other revocations arrive (codex round 28, medium #5)', async () => {
  let during = () => {}
  const r = rig({ licenses: { FREE: LIC_PAID }, duringClaim: () => during() })
  const agent = await becomeAgent(r, await generateDeviceKey(), { licensing: true })
  during = () => {
    during = () => {}
    r.room.revokeLicense('acct_free_01', 'm_free0001')
    for (let i = 0; i < 20; i++) r.room.revokeLicense('acct_attacker', `m_attack${String(i).padStart(3, '0')}`)
  }
  await sendLicense(r, agent, 'FREE')
  assert.equal(agent.tag()?.lic, undefined, '⚠️⚠️ pushed out, and a removed ticket was attached')
  assert.deepEqual(licenseResults(agent).slice(-1), ['revoked'])
  assert.equal(agent.tag()?.claiming, undefined, '⚠️ the mark remained after the check ended')
})

test('★★ checking the same ticket twice: the one finishing first does not clear the later mark (codex round 29, high #1)', async () => {
  const gates: (() => void)[] = []
  let hold = false
  const r = rig({ licenses: { FREE: LIC_PAID }, duringClaimAsync: () => (hold ? new Promise<void>((ok) => gates.push(ok)) : Promise.resolve()) })
  const agent = await becomeAgent(r, await generateDeviceKey(), { licensing: true })
  hold = true
  const one = sendLicense(r, agent, 'FREE')
  const two = sendLicense(r, agent, 'FREE')
  await new Promise((ok) => setTimeout(ok, 0))
  assert.equal(gates.length, 2)
  // The ledger allowed both (the replies have not reached the room yet) ⇒ removed here
  r.room.revokeLicense('acct_free_01', 'm_free0001')
  gates.shift()!()
  await one
  gates.shift()!()
  await two
  assert.equal(agent.tag()?.lic, undefined, '⚠️⚠️ a late "may pass" attached a removed ticket')
  assert.deepEqual(licenseResults(agent).slice(-2), ['revoked', 'revoked'])
})

test('★★ a ticket renewal keeps the current ticket while the ledger answers: a message meanwhile does not close licensed phones (codex 2026-09-27)', async () => {
  let during = async () => {}
  const r = rig({ licenses: { FREE: LIC_PAID }, duringClaimAsync: () => during() })
  const agent = await becomeAgent(r, await generateDeviceKey(), { licensing: true })
  await sendLicense(r, agent, 'FREE')
  const d = await freePhone(r)
  await agentReplies(r, agent, d.connId)
  assert.equal(d.socket.tag()?.free, undefined, 'admitted under the ticket')
  let licDuring: unknown
  during = async () => {
    during = async () => {}
    licDuring = agent.tag()?.lic
    await deviceSends(r, d.socket)
  }
  // The hourly renewal (the same ticket again)
  await sendLicense(r, agent, 'FREE')
  assert.ok(licDuring, '⚠️⚠️ the ticket was dropped from the room while the ledger answered')
  assert.equal(d.socket.closed, undefined, '⚠️⚠️ a renewal closed a licensed phone')
  assert.deepEqual(licenseResults(agent).slice(-1), ['ok'])
})

test('★★ a licensed connect releases the room from the phone\'s ledger, so an older free-tier wire of that phone loses its mark and cannot become a second free machine (codex 2026-09-27)', async () => {
  const phones = new Map<string, PhoneLedger>()
  const a = rig({ phones, licenses: { FREE: LIC_PAID } })
  const agentA = await becomeAgent(a, await generateDeviceKey(), { licensing: true })
  const phone = await generateDeviceKey()
  // P holds A as its free slot (no ticket yet)
  const w1 = await freePhone(a, phone)
  await agentReplies(a, agentA, w1.connId)
  assert.equal(w1.socket.tag()?.free, true)
  // A signs in; P connects again (another tab) ⇒ the ledger releases A
  await sendLicense(a, agentA, 'FREE')
  const w2 = await freePhone(a, phone)
  await agentReplies(a, agentA, w2.connId)
  assert.equal(w1.socket.tag()?.free, undefined, '⚠️⚠️ the older wire kept a free mark the ledger no longer backs')
  // P now claims machine C on the free tier (allowed: A is licensed)
  const c = rig({ phones })
  const agentC = await becomeAgent(c, await generateDeviceKey())
  const onC = await freePhone(c, phone)
  await agentReplies(c, agentC, onC.connId)
  // A loses its ticket ⇒ both of P's wires there must go (they reconnect and get refused: C holds the free slot)
  a.release(LIC_PAID.ok ? LIC_PAID.license.acct : '', agentA.tag()!.key!, LIC_PAID.ok ? LIC_PAID.license.mid : '')
  assert.equal(w1.socket.closed?.code, CLOSE.planChanged, '⚠️⚠️ P kept A on the free tier while also holding C')
  assert.equal(w2.socket.closed?.code, CLOSE.planChanged)
  const again = await joinDevice(a)
  await prove(a, again, phone)
  assert.equal(again.socket.closed?.code, CLOSE.freeUsed)
})

// ─── ★★ Stale ledger answers (codex 2026-09-27, round 2) ─────────────────────────────────────

test('★★ a licensed connect evicted while the ledger answers still clears the older free mark of that phone in the room (round 2, #1)', async () => {
  const phones = new Map<string, PhoneLedger>()
  let during = () => {}
  const a = rig({ phones, licenses: { FREE: LIC_PAID }, duringPhoneClaim: () => during() })
  const agentA = await becomeAgent(a, await generateDeviceKey(), { licensing: true })
  const phone = await generateDeviceKey()
  const w1 = await freePhone(a, phone)
  await agentReplies(a, agentA, w1.connId)
  await sendLicense(a, agentA, 'FREE')
  // W2's licensed connect: its ledger call releases A; meanwhile its deadline passes and an accept sweeps it away
  const w2 = await joinDevice(a)
  during = () => {
    during = () => {}
    a.advance(DEVICE_ADMIT_DEADLINE_MS + 1)
    a.room.admitDevice()
  }
  await prove(a, w2, phone)
  assert.equal(w2.socket.closed?.code, CLOSE.notAdmitted)
  assert.equal(w1.socket.tag()?.free, undefined, '⚠️⚠️ the release happened in the ledger but the older wire kept its free mark')
  // ⇒ P claims B; then A loses its ticket: W1 must not survive as a second free machine
  const b = rig({ phones })
  await becomeAgent(b, await generateDeviceKey())
  await freePhone(b, phone)
  a.release(LIC_PAID.ok ? LIC_PAID.license.acct : '', agentA.tag()!.key!, LIC_PAID.ok ? LIC_PAID.license.mid : '')
  assert.equal(w1.socket.closed?.code, CLOSE.planChanged)
})

test('★★ a delayed free-claim answer does not restore a slot released meanwhile (round 2, #2)', async () => {
  const phones = new Map<string, PhoneLedger>()
  const gates: (() => void)[] = []
  let hold = 0
  const a = rig({ phones, licenses: { FREE: LIC_PAID }, duringPhoneClaimAsync: (n) => (n === hold ? new Promise<void>((ok) => gates.push(ok)) : Promise.resolve()) })
  const agentA = await becomeAgent(a, await generateDeviceKey(), { licensing: true })
  const phone = await generateDeviceKey()
  // W2: a free claim of A whose answer is delayed (the ledger already holds A for P)
  hold = 1
  const w2 = await joinDevice(a)
  const w2Proof = prove(a, w2, phone)
  // ⚠️ The proof check does crypto (several awaits) before it reaches the ledger ⇒ wait for the call, not one tick
  for (let i = 0; i < 200 && gates.length === 0; i++) await new Promise((ok) => setTimeout(ok, 1))
  assert.equal(gates.length, 1, 'the ledger was not asked')
  assert.ok(phones.get(toBase64Url(await exportPublicKey(phone.publicKey)))?.rooms[agentA.tag()!.key!], 'the ledger did not commit A')
  // Meanwhile A gets a ticket and W3 (same phone) completes a licensed connect ⇒ A is released
  await sendLicense(a, agentA, 'FREE')
  const w3 = await freePhone(a, phone)
  assert.equal(w3.socket.tag()?.free, undefined)
  assert.equal(w2.socket.tag()?.dstale, true, '⚠️⚠️ the in-flight check was not marked stale by the release')
  // W2's stale answer arrives
  gates.shift()!()
  await w2Proof
  assert.equal(w2.socket.closed, undefined, `W2 was closed: ${(w2.socket as { closed?: { reason: string } }).closed?.reason ?? ''}`)
  assert.equal(w2.socket.tag()?.free, undefined, '⚠️⚠️ a stale answer restored the free mark')
  assert.deepEqual(phones.get(toBase64Url(await exportPublicKey(phone.publicKey)))?.rooms, {}, '⚠️⚠️ the ledger holds A again')
  await agentReplies(a, agentA, w2.connId)
  await agentReplies(a, agentA, w3.connId)
  // ⇒ P may claim B; when A loses its ticket, W2 and W3 both go (no second free machine)
  const b = rig({ phones })
  await becomeAgent(b, await generateDeviceKey())
  await freePhone(b, phone)
  a.release(LIC_PAID.ok ? LIC_PAID.license.acct : '', agentA.tag()!.key!, LIC_PAID.ok ? LIC_PAID.license.mid : '')
  assert.equal((w2.socket as { closed?: { code: number } }).closed?.code, CLOSE.planChanged)
  assert.equal(w3.socket.closed?.code, CLOSE.planChanged)
})

test('★★ a ticket arriving while the free claim is refused: the room is licensed now, so the phone is admitted (round 2, #3)', async () => {
  const phones = new Map<string, PhoneLedger>()
  const b = rig({ phones })
  await becomeAgent(b, await generateDeviceKey())
  const phone = await generateDeviceKey()
  await freePhone(b, phone)
  let during = async () => {}
  const a = rig({ phones, licenses: { PLUS: LIC_PLUS }, duringPhoneClaimAsync: () => during() })
  const agentA = await becomeAgent(a, await generateDeviceKey(), { licensing: true })
  const d = await joinDevice(a)
  during = async () => {
    during = async () => {}
    await sendLicense(a, agentA, 'PLUS')
  }
  await prove(a, d, phone)
  assert.equal(d.socket.closed, undefined, `⚠️⚠️ refused a phone in a room that is licensed now: ${(d.socket as { closed?: { reason: string } }).closed?.reason ?? ''}`)
  assert.equal(d.socket.tag()?.free, undefined)
  assert.deepEqual(openedIds(agentA), [d.connId])
  // ⚠️ And the opposite drift (the ticket goes while a licensed check is in flight) ends in a fresh free claim, not a stale grant
  const c = rig({ phones, licenses: { FREE: LIC_PAID }, duringPhoneClaimAsync: () => during() })
  const agentC = await becomeAgent(c, await generateDeviceKey(), { licensing: true })
  await sendLicense(c, agentC, 'FREE')
  const e = await joinDevice(c)
  during = async () => {
    during = async () => {}
    c.release(LIC_PAID.ok ? LIC_PAID.license.acct : '', agentC.tag()!.key!, LIC_PAID.ok ? LIC_PAID.license.mid : '')
  }
  await prove(c, e, phone)
  // P's free slot is B ⇒ the fresh claim of C is refused (not silently admitted on a stale licensed answer)
  assert.equal(e.socket.closed?.code, CLOSE.freeUsed, '⚠️⚠️ admitted on a licensed answer although the ticket had gone')
})

test('★★ a phone whose room lost its ticket between its check and the agent\'s reply is not promoted without the free mark', async () => {
  const r = rig({ licenses: { FREE: LIC_PAID } })
  const agent = await becomeAgent(r, await generateDeviceKey(), { licensing: true })
  await sendLicense(r, agent, 'FREE')
  const d = await freePhone(r)
  assert.equal(d.socket.tag()?.free, undefined)
  r.release(LIC_PAID.ok ? LIC_PAID.license.acct : '', agent.tag()!.key!, LIC_PAID.ok ? LIC_PAID.license.mid : '')
  assert.equal(d.socket.closed, undefined, 'not admitted yet = enforce leaves it alone')
  await agentReplies(r, agent, d.connId)
  assert.equal((d.socket as { closed?: { code: number } }).closed?.code, CLOSE.planChanged, '⚠️⚠️ promoted a phone without a free slot in a room without a ticket')
  assert.equal(d.socket.sent.length, 0, '⚠️ delivered to it')
})

// ─── ★★ codex 2026-09-27, round 3 ────────────────────────────────────────────────────────────

test('★★ a phone that disconnects while the ledger answers is never announced to the agent afterwards (round 3, #1)', async () => {
  let during = () => {}
  const r = rig({ duringPhoneClaim: () => during() })
  const agent = await becomeAgent(r, await generateDeviceKey())
  const d = await joinDevice(r)
  const init = new Uint8Array(196).fill(3)
  await r_onMessage(r, d.socket, init)
  during = () => {
    during = () => {}
    r.room.onClose(d.socket)
  }
  await prove(r, d, await generateDeviceKey())
  assert.deepEqual(openedIds(agent), [], '⚠️⚠️ opened was sent for a phone that had disconnected (an orphan slot on the agent)')
  const dataFrames = agent.sent.filter((b) => {
    const x = decodeRelayFrame(b)
    return x.ok && x.value.type === RELAY_FRAME.data
  })
  assert.equal(dataFrames.length, 0, '⚠️ the held message was forwarded for a phone that had disconnected')
})

test('★★ a second copy of a valid proof is refused, not run alongside the first nor held as a handshake message (round 3, #2)', async () => {
  const gates: (() => void)[] = []
  // ⚠️ Only the first ledger call is held (a mutation that runs the duplicate too must fail the assertions, not hang on a gate)
  const r = rig({ duringPhoneClaimAsync: (n) => (n === 1 ? new Promise<void>((ok) => gates.push(ok)) : Promise.resolve()) })
  const agent = await becomeAgent(r, await generateDeviceKey())
  const identity = await generateDeviceKey()
  const d = await joinDevice(r)
  const challenge = decodeDeviceChallenge(d.socket.sent.shift() as Uint8Array)
  assert.ok(challenge.ok)
  const tag = await relayProof(identity.privateKey, challenge.value.relayPublicRaw, challenge.value.nonce)
  const proof = encodeDeviceProof({ devicePublicRaw: await exportPublicKey(identity.publicKey), tag })
  const first = r_onMessage(r, d.socket, proof)
  // ⚠️ The duplicate arrives while the first is still doing crypto (before any ledger call)
  const second = r_onMessage(r, d.socket, proof)
  await second
  assert.equal(d.socket.closed?.code, CLOSE.badProof, '⚠️⚠️ a second proof was accepted (or held)')
  assert.equal(d.socket.tag()?.held, undefined, '⚠️ the duplicate proof was held as a handshake message')
  for (const g of gates.splice(0)) g()
  await first
  assert.deepEqual(openedIds(agent), [], '⚠️ a refused wire was announced')
})

test('★★ a licensed release whose answer was lost still clears the older free marks of that phone in the room (round 3, #3)', async () => {
  const phones = new Map<string, PhoneLedger>()
  let down = false
  const a = rig({ phones, licenses: { FREE: LIC_PAID }, phoneLedgerDown: () => down })
  const agentA = await becomeAgent(a, await generateDeviceKey(), { licensing: true })
  const phone = await generateDeviceKey()
  const w1 = await freePhone(a, phone)
  await agentReplies(a, agentA, w1.connId)
  await sendLicense(a, agentA, 'FREE')
  // The ledger commits the release but the answer is lost (the rig answers `unavailable` without touching the ledger; the
  // point is what the room does with the answer)
  down = true
  const w2 = await freePhone(a, phone)
  down = false
  assert.equal(w2.socket.closed, undefined, 'a licensed room carries on when the ledger is unreachable')
  assert.equal(w1.socket.tag()?.free, undefined, '⚠️⚠️ an uncertain release kept the older wire\'s free mark')
})

// ─── ★★ codex 2026-09-27, round 4 (the agent's proof: pre-existing races) ─────────────────────

test('★★ a replacement agent wire that closes while its proof is verified does not replace the live agent (round 4, #2)', async () => {
  let during = () => {}
  const r = rig({ duringProof: () => during() })
  const pair = await generateDeviceKey()
  const key = toBase64Url(await exportPublicKey(pair.publicKey))
  const live = await becomeAgent(r, pair)
  const phone = await freePhone(r)
  // B: a valid proof, but the wire closes while the crypto runs
  const b = await pendingAgent(r, key)
  const challenge = decodeChallenge(b.sent.shift() as Uint8Array)
  assert.ok(challenge.ok)
  const proof = await relayProof(pair.privateKey, challenge.value.relayPublicRaw, challenge.value.nonce)
  during = () => {
    during = () => {}
    r.room.onClose(b)
    r.forget(b)
  }
  await r_onMessage(r, b, encodeProof(proof))
  assert.equal(live.closed, undefined, '⚠️⚠️ the live agent was replaced by a wire that had already closed')
  assert.equal(phone.socket.closed, undefined, '⚠️⚠️ the phones were cut for a wire that had already closed')
  assert.equal(r.room.admitDevice().ok, true, '⚠️ the room lost its agent (503)')
})

test('★★ a second copy of the agent\'s proof is refused instead of "replacing" the wire that just became the agent (round 4)', async () => {
  const r = rig()
  const pair = await generateDeviceKey()
  const key = toBase64Url(await exportPublicKey(pair.publicKey))
  const a = await pendingAgent(r, key)
  const challenge = decodeChallenge(a.sent.shift() as Uint8Array)
  assert.ok(challenge.ok)
  const proof = encodeProof(await relayProof(pair.privateKey, challenge.value.relayPublicRaw, challenge.value.nonce))
  const first = r_onMessage(r, a, proof)
  const second = r_onMessage(r, a, proof)
  await first
  await second
  assert.equal(a.closed?.code, CLOSE.badProof, 'the duplicate was not refused')
  // ⚠️ The refusal closes the wire (a client sending two proofs is not keeping the contract), but it must not have retired itself
  //    as "replaced" first = no phantom `agentReplaced` on the same wire
  assert.notEqual(a.closed?.reason, REASON.agentReplaced, '⚠️⚠️ the wire replaced itself')
})

// ─── ★★ codex 2026-09-27, round 5: relay-initiated closes mark the wire first ────────────────

test('★★ a phone closed by the relay while the ledger answers (a text frame) is never announced afterwards (round 5)', async () => {
  const gates: (() => void)[] = []
  const r = rig({ duringPhoneClaimAsync: () => new Promise<void>((ok) => gates.push(ok)) })
  const agent = await becomeAgent(r, await generateDeviceKey())
  const d = await joinDevice(r)
  const proving = prove(r, d, await generateDeviceKey())
  for (let i = 0; i < 200 && gates.length === 0; i++) await new Promise((ok) => setTimeout(ok, 1))
  assert.equal(gates.length, 1, 'the ledger was not asked')
  // ⚠️ The phone breaks the contract meanwhile ⇒ relay closes it (the close event has not arrived yet)
  await r.room.onMessage(d.socket, 'text')
  assert.equal(d.socket.closed?.code, CLOSE.badFrame)
  gates.shift()!()
  await proving
  assert.deepEqual(openedIds(agent), [], '⚠️⚠️ opened was sent for a phone the relay had just closed')
})

test('★★ an agent wire closed by the relay while its proof is verified (a duplicate proof) cannot replace the live agent (round 5)', async () => {
  let during = () => {}
  const r = rig({ duringProof: () => during() })
  const pair = await generateDeviceKey()
  const key = toBase64Url(await exportPublicKey(pair.publicKey))
  const live = await becomeAgent(r, pair)
  const phone = await freePhone(r)
  const b = await pendingAgent(r, key)
  const challenge = decodeChallenge(b.sent.shift() as Uint8Array)
  assert.ok(challenge.ok)
  const proof = encodeProof(await relayProof(pair.privateKey, challenge.value.relayPublicRaw, challenge.value.nonce))
  during = () => {
    during = () => {}
    // The duplicate arrives while the first copy is being verified ⇒ relay closes B (synchronously)
    void r_onMessage(r, b, proof)
  }
  await r_onMessage(r, b, proof)
  assert.equal(b.closed?.code, CLOSE.badProof)
  assert.equal(live.closed, undefined, '⚠️⚠️ a wire the relay had just closed replaced the live agent')
  assert.equal(phone.socket.closed, undefined, '⚠️⚠️ the phones were cut')
  assert.equal(r.room.admitDevice().ok, true)
})

test('★★ closing the live agent for a broken frame cuts its phones at once (as its close event would)', async () => {
  const r = rig()
  const agent = await becomeAgent(r, await generateDeviceKey())
  const phone = await freePhone(r)
  await r.room.onMessage(agent, 'text')
  assert.equal(agent.closed?.code, CLOSE.badFrame)
  assert.equal(phone.socket.closed?.code, CLOSE.agentGone, '⚠️ phones left hanging on a closed agent')
  assert.equal(r.room.admitDevice().ok, false, 'the room still counts a closed agent as live')
})

// ─── ★★ codex 2026-09-27, round 6: numbers carry over even when the predecessor is not live ───

test('★★ after the agent is dropped or gone, a reconnect does not reuse the number of a phone that is still closing (round 6)', async () => {
  // ① dropped for a broken frame (retired at once; the phone is evicted, its close event has not arrived)
  const r = rig()
  const pair = await generateDeviceKey()
  const a1 = await becomeAgent(r, pair)
  const p = await freePhone(r)
  assert.equal(p.connId, 1)
  await r.room.onMessage(a1, 'text')
  assert.equal(p.socket.closed?.code, CLOSE.agentGone)
  const a2 = await becomeAgent(r, pair)
  const q = await joinDevice(r)
  assert.notEqual(q.connId, p.connId, '⚠️⚠️ reused the number of a phone whose delayed closed(n) would discard this one')
  assert.equal(q.connId, 2)
  // ⚠️ P's delayed close now names a number the new agent never opened (ignored there)
  r.room.onClose(p.socket)
  // ② gone through its own close event (the phones are cut; their close events are still pending)
  const r2 = rig()
  const b1 = await becomeAgent(r2, pair)
  const p2 = await freePhone(r2)
  r2.room.onClose(b1)
  r2.forget(b1)
  assert.equal(p2.socket.closed?.code, CLOSE.agentGone)
  await becomeAgent(r2, pair)
  const q2 = await joinDevice(r2)
  assert.notEqual(q2.connId, p2.connId, '⚠️⚠️ reused a number after the agent came back from a plain disconnect')
  void a2
})

// ─── ★★ Moving the free slot (`f=1` / 2026-09-27 / user decision) ───────────────────────────────

test('★★ pairing or "use this machine for free" moves the slot: the previous machine\'s wires close with the reason, the ledger follows', async () => {
  const phones = new Map<string, PhoneLedger>()
  const rooms = new Map<string, Room>()
  const a = rig({ phones, rooms })
  const agentA = await becomeAgent(a, await generateDeviceKey())
  const b = rig({ phones, rooms })
  const agentB = await becomeAgent(b, await generateDeviceKey())
  const phone = await generateDeviceKey()
  const dkey = toBase64Url(await exportPublicKey(phone.publicKey))
  const onA = await freePhone(a, phone)
  await agentReplies(a, agentA, onA.connId)
  // Without the flag, B is refused (as before)
  const plain = await joinDevice(b)
  await prove(b, plain, phone)
  assert.equal(plain.socket.closed?.code, CLOSE.freeUsed)
  // With the flag, B takes the slot: A's wire is told first, then the ledger says B
  const onB = await freePhone(b, phone, { takeover: true })
  await agentReplies(b, agentB, onB.connId)
  assert.equal(onB.socket.tag()?.free, true)
  assert.deepEqual(onA.socket.closed, { code: CLOSE.freeMoved, reason: REASON.freeMoved }, '⚠️⚠️ the previous machine kept a free wire')
  assert.deepEqual(Object.keys(phones.get(dkey)?.rooms ?? {}), [agentB.tag()!.key!])
  // A reconnecting now is refused (the slot is B\'s), and A can take it back the same way
  const backPlain = await joinDevice(a)
  await prove(a, backPlain, phone)
  assert.equal(backPlain.socket.closed?.code, CLOSE.freeUsed)
  const back = await freePhone(a, phone, { takeover: true })
  assert.equal(back.socket.tag()?.free, true)
  assert.equal(onB.socket.closed?.code, CLOSE.freeMoved)
})

test('★★ moving the slot does not touch wires admitted under a ticket, and a licensed room never takes over', async () => {
  const phones = new Map<string, PhoneLedger>()
  const rooms = new Map<string, Room>()
  const a = rig({ phones, rooms, licenses: { FREE: LIC_PAID } })
  const agentA = await becomeAgent(a, await generateDeviceKey(), { licensing: true })
  await sendLicense(a, agentA, 'FREE')
  const b = rig({ phones, rooms })
  await becomeAgent(b, await generateDeviceKey())
  const c = rig({ phones, rooms })
  const agentC = await becomeAgent(c, await generateDeviceKey())
  const phone = await generateDeviceKey()
  const dkey = toBase64Url(await exportPublicKey(phone.publicKey))
  const onA = await freePhone(a, phone)
  await agentReplies(a, agentA, onA.connId)
  const onB = await freePhone(b, phone)
  // C takes the slot from B; A (licensed) is untouched
  await freePhone(c, phone, { takeover: true })
  assert.equal(onB.socket.closed?.code, CLOSE.freeMoved)
  assert.equal(onA.socket.closed, undefined, '⚠️⚠️ a wire admitted under a ticket was closed by a takeover')
  // A licensed connect with the flag releases as usual (C keeps the slot)
  await freePhone(a, phone, { takeover: true })
  assert.deepEqual(Object.keys(phones.get(dkey)?.rooms ?? {}), [agentC.tag()!.key!], '⚠️ a licensed connect took the slot')
})

test('★★ a check in flight in the machine the slot moved away from is marked stale and ends refused', async () => {
  const phones = new Map<string, PhoneLedger>()
  const rooms = new Map<string, Room>()
  const gates: (() => void)[] = []
  let hold = 0
  const a = rig({ phones, rooms, duringPhoneClaimAsync: (n) => (n === hold ? new Promise<void>((ok) => gates.push(ok)) : Promise.resolve()) })
  await becomeAgent(a, await generateDeviceKey())
  const b = rig({ phones, rooms })
  await becomeAgent(b, await generateDeviceKey())
  const phone = await generateDeviceKey()
  // A's claim commits (ledger = A) but its answer is held
  hold = 1
  const onA = await joinDevice(a)
  const proving = prove(a, onA, phone)
  for (let i = 0; i < 200 && gates.length === 0; i++) await new Promise((ok) => setTimeout(ok, 1))
  assert.equal(gates.length, 1)
  // B takes the slot meanwhile ⇒ A's pending wire is marked stale
  await freePhone(b, phone, { takeover: true })
  assert.equal(onA.socket.tag()?.dstale, true)
  gates.shift()!()
  await proving
  assert.equal(onA.socket.closed?.code, CLOSE.freeUsed, '⚠️⚠️ a stale answer admitted A after the slot had moved to B')
})

test('★★ a stale takeover retry is a plain claim: it cannot take the slot back from a newer takeover (codex)', async () => {
  const phones = new Map<string, PhoneLedger>()
  const rooms = new Map<string, Room>()
  const gates: (() => void)[] = []
  let hold = 0
  const a = rig({ phones, rooms, duringPhoneClaimAsync: (n) => (n === hold ? new Promise<void>((ok) => gates.push(ok)) : Promise.resolve()) })
  const agentA = await becomeAgent(a, await generateDeviceKey())
  const b = rig({ phones, rooms })
  const agentB = await becomeAgent(b, await generateDeviceKey())
  const phone = await generateDeviceKey()
  const dkey = toBase64Url(await exportPublicKey(phone.publicKey))
  // A's takeover commits (ledger = A) but its answer is held
  hold = 1
  const onA = await joinDevice(a, { takeover: true })
  const proving = prove(a, onA, phone)
  for (let i = 0; i < 200 && gates.length === 0; i++) await new Promise((ok) => setTimeout(ok, 1))
  assert.equal(gates.length, 1)
  // B takes over meanwhile (the user's newer choice)
  const onB = await freePhone(b, phone, { takeover: true })
  await agentReplies(b, agentB, onB.connId)
  gates.shift()!()
  await proving
  assert.equal(onA.socket.closed?.code, CLOSE.freeUsed, '⚠️⚠️ the stale retry took the slot back')
  assert.equal(onB.socket.closed, undefined, '⚠️⚠️ the newer choice was closed')
  assert.deepEqual(Object.keys(phones.get(dkey)?.rooms ?? {}), [agentB.tag()!.key!])
  void agentA
})

test('★★ moving the slot away from a room that got a ticket meanwhile clears the mark but keeps the wire (codex)', async () => {
  const phones = new Map<string, PhoneLedger>()
  const rooms = new Map<string, Room>()
  const a = rig({ phones, rooms, licenses: { FREE: LIC_PAID } })
  const agentA = await becomeAgent(a, await generateDeviceKey(), { licensing: true })
  const b = rig({ phones, rooms })
  await becomeAgent(b, await generateDeviceKey())
  const phone = await generateDeviceKey()
  const onA = await freePhone(a, phone)
  await agentReplies(a, agentA, onA.connId)
  assert.equal(onA.socket.tag()?.free, true)
  await sendLicense(a, agentA, 'FREE')
  await freePhone(b, phone, { takeover: true })
  assert.equal(onA.socket.closed, undefined, '⚠️⚠️ closed a wire in a room that is licensed now')
  assert.equal(onA.socket.tag()?.free, undefined, 'the stale free mark remained')
})

test('★★ a signed-in Free machine counts against the phone\'s free slot (no second free machine by signing in / 2026-09-27)', async () => {
  const phones = new Map<string, PhoneLedger>()
  const rooms = new Map<string, Room>()
  const a = rig({ phones, rooms, licenses: { FREE: LIC_FREE } })
  const agentA = await becomeAgent(a, await generateDeviceKey(), { licensing: true })
  await sendLicense(a, agentA, 'FREE')
  const b = rig({ phones, rooms })
  await becomeAgent(b, await generateDeviceKey())
  const phone = await generateDeviceKey()
  // A: signed in on Free ⇒ this phone's free machine
  const onA = await freePhone(a, phone)
  assert.equal(onA.socket.tag()?.free, true, '⚠️⚠️ a Free-ticket room was not counted as the phone\'s free machine')
  // B: not signed in ⇒ refused (the phone's free slot is A)
  const onB = await joinDevice(b)
  await prove(b, onB, phone)
  assert.equal(onB.socket.closed?.code, CLOSE.freeUsed, '⚠️⚠️ one GitHub sign-in gave a second free machine')
  // ★ Plus is outside it (as before)
  const c = rig({ phones, rooms, licenses: { PLUS: LIC_PLUS } })
  const agentC = await becomeAgent(c, await generateDeviceKey(), { licensing: true })
  await sendLicense(c, agentC, 'PLUS')
  const onC = await freePhone(c, phone)
  assert.equal(onC.socket.tag()?.free, undefined)
  // ⚠️ An old app (no key proof) cannot be counted per phone ⇒ refused in a Free-ticket room too
  const old = await joinDevice(a, { old: true })
  assert.equal(old.socket.closed?.code, CLOSE.updateApp)
})

// ─── ★★ codex 2026-09-27 (after #paid) ───────────────────────────────────────────────────────

test('★★ an older ticket\'s answer never replaces a newer one (a slow Free renewal cannot undo a completed Plus upgrade)', async () => {
  const gates: (() => void)[] = []
  let hold = true
  const r = rig({ licenses: { FREE: LIC_FREE, PLUS: LIC_PAID }, duringClaimAsync: () => (hold ? new Promise<void>((ok) => gates.push(ok)) : Promise.resolve()) })
  const agent = await becomeAgent(r, await generateDeviceKey(), { licensing: true })
  const slowFree = sendLicense(r, agent, 'FREE')
  for (let i = 0; i < 200 && gates.length === 0; i++) await new Promise((ok) => setTimeout(ok, 1))
  hold = false
  await sendLicense(r, agent, 'PLUS')
  assert.equal(agent.tag()?.lic?.plan, 'plus')
  const phone = await freePhone(r)
  await agentReplies(r, agent, phone.connId)
  gates.shift()!()
  await slowFree
  assert.equal(agent.tag()?.lic?.plan, 'plus', '⚠️⚠️ the older Free answer replaced the newer Plus ticket')
  assert.equal(phone.socket.closed, undefined, '⚠️⚠️ a Plus phone was closed by a stale answer')
  assert.deepEqual(licenseResults(agent), ['want', 'ok'], 'a superseded answer must not be reported')
  assert.equal(agent.tag()?.claiming, undefined, 'the stale claim left its mark')
})

test('★★ a Plus connect clears the phone\'s free marks in the room before the ledger forgets it (not when its answer returns)', async () => {
  const phones = new Map<string, PhoneLedger>()
  const rooms = new Map<string, Room>()
  const gates: (() => void)[] = []
  let hold = 0
  const a = rig({ phones, rooms, licenses: { PLUS: LIC_PAID }, duringPhoneClaimAsync: (n) => (n === hold ? new Promise<void>((ok) => gates.push(ok)) : Promise.resolve()) })
  const agentA = await becomeAgent(a, await generateDeviceKey(), { licensing: true })
  const phone = await generateDeviceKey()
  const w1 = await freePhone(a, phone)
  await agentReplies(a, agentA, w1.connId)
  assert.equal(w1.socket.tag()?.free, true)
  await sendLicense(a, agentA, 'PLUS')
  // W2's Plus connect: the ledger drops A, its answer is held
  hold = 2
  const w2 = await joinDevice(a)
  const proving = prove(a, w2, phone)
  for (let i = 0; i < 200 && gates.length === 0; i++) await new Promise((ok) => setTimeout(ok, 1))
  assert.equal(gates.length, 1)
  assert.equal(w1.socket.tag()?.free, undefined, '⚠️⚠️ the older wire still holds the room as its free slot while the ledger forgot it')
  gates.shift()!()
  await proving
})

test('★★ a Plus release marks the phone\'s pending free checks in the room stale (Free → Plus → Free with both answers held / codex)', async () => {
  const phones = new Map<string, PhoneLedger>()
  const rooms = new Map<string, Room>()
  const gates = new Map<number, () => void>()
  const held = new Set<number>()
  const a = rig({ phones, rooms, licenses: { PLUS: LIC_PAID }, duringPhoneClaimAsync: (n) => (held.has(n) ? new Promise<void>((ok) => gates.set(n, ok)) : Promise.resolve()) })
  const agentA = await becomeAgent(a, await generateDeviceKey(), { licensing: true })
  const b = rig({ phones, rooms })
  await becomeAgent(b, await generateDeviceKey())
  const phone = await generateDeviceKey()
  const wait = async (n: number) => {
    for (let i = 0; i < 300 && !gates.has(n); i++) await new Promise((ok) => setTimeout(ok, 1))
    assert.ok(gates.has(n), `ledger call ${n} was not made`)
  }
  // ① W1: a free claim of A, its answer held
  held.add(1)
  const w1 = await joinDevice(a)
  const p1 = prove(a, w1, phone)
  await wait(1)
  // ② A upgrades; W2's Plus connect releases A, its answer held too
  await sendLicense(a, agentA, 'PLUS')
  held.add(2)
  const w2 = await joinDevice(a)
  const p2 = prove(a, w2, phone)
  await wait(2)
  assert.equal(w1.socket.tag()?.dstale, true, '⚠️⚠️ the pending free check was not marked stale by the release')
  // ③ A goes back to Free; the phone takes B on the free tier
  a.release(LIC_PAID.ok ? LIC_PAID.license.acct : '', agentA.tag()!.key!, LIC_PAID.ok ? LIC_PAID.license.mid : '')
  await freePhone(b, phone)
  // ④ W1's old "may pass" arrives: it must ask again (and be refused: the slot is B)
  gates.get(1)!()
  await p1
  assert.equal(w1.socket.closed?.code, CLOSE.freeUsed, '⚠️⚠️ one phone ended with free wires on two machines')
  gates.get(2)!()
  await p2
})

test('★★ several wires of one phone connecting to a Plus room at once all get in (stale marks do not matter to Plus answers / codex)', async () => {
  const gates: (() => void)[] = []
  let hold = true
  const r = rig({ licenses: { PLUS: LIC_PAID }, duringPhoneClaimAsync: () => (hold ? new Promise<void>((ok) => gates.push(ok)) : Promise.resolve()) })
  const agent = await becomeAgent(r, await generateDeviceKey(), { licensing: true })
  hold = false
  await sendLicense(r, agent, 'PLUS')
  hold = true
  const phone = await generateDeviceKey()
  const ws = [await joinDevice(r), await joinDevice(r), await joinDevice(r)]
  const proofs = ws.map((w) => prove(r, w, phone))
  for (let i = 0; i < 300 && gates.length < 3; i++) await new Promise((ok) => setTimeout(ok, 1))
  assert.equal(gates.length, 3)
  hold = false
  for (const g of gates.splice(0)) g()
  await Promise.all(proofs)
  assert.deepEqual(ws.map((w) => w.socket.closed?.code ?? null), [null, null, null], '⚠️⚠️ Plus wires of one phone closed each other')
})

test('★★ the pending-agent limit holds while challenges are still being made (security audit 2026-09-28, F3)', async () => {
  let release = () => {}
  const r = rig({ challengeGate: new Promise<void>((resolve) => (release = resolve)) })
  const key = toBase64Url(await exportPublicKey((await generateDeviceKey()).publicKey))
  const starts: Promise<void>[] = []
  let admitted = 0
  // ⚠️ Accept + start without awaiting, like concurrent upgrades in the Durable Object (its input gate does not cover crypto awaits)
  for (let i = 0; i < MAX_PENDING_AGENTS * 3; i++) {
    if (!r.room.admitAgent().ok) continue
    admitted += 1
    starts.push(r.room.startAgent(r.open('agent'), key))
  }
  assert.equal(admitted, MAX_PENDING_AGENTS, '⚠️⚠️ more agent wires were admitted than the pending limit while challenges were awaited')
  release()
  await Promise.all(starts)
  // ★ The reserved wires got their challenge; a reservation left past the deadline is swept like a pending proof
  r.advance(PROOF_DEADLINE_MS + 1)
  assert.equal(r.room.admitAgent().ok, true, 'expired wires were not swept')
})

test('★ a wire swept while its challenge was being made gets no challenge (F3)', async () => {
  let release = () => {}
  const r = rig({ challengeGate: new Promise<void>((resolve) => (release = resolve)) })
  const key = toBase64Url(await exportPublicKey((await generateDeviceKey()).publicKey))
  const socket = r.open('agent')
  const start = r.room.startAgent(socket, key)
  r.advance(PROOF_DEADLINE_MS + 1)
  assert.equal(r.room.admitAgent().ok, true)
  assert.equal(socket.closed?.code, CLOSE.badProof, 'the expired reservation was not swept')
  release()
  await start
  assert.equal(socket.sent.length, 0, '⚠️ a challenge was sent on a swept wire')
})

// ─── ★★ codex 2026-09-28 round 2 (after the audit fix) ───────────────────────────────────────────

test('★★ no key proof ⇒ "update the app" whatever else the phone asks for (p=0 with f=1), in a free or a Plus room', async () => {
  const free = rig()
  const fa = await becomeAgent(free, await generateDeviceKey())
  const plus = rig({ licenses: { PLUS: LIC_PLUS } })
  const pa = await becomeAgent(plus, await generateDeviceKey(), { licensing: true })
  await sendLicense(plus, pa, 'PLUS')
  for (const [r, agent] of [[free, fa], [plus, pa]] as const) {
    const d = await joinDevice(r, { old: true, takeover: true })
    assert.deepEqual(d.socket.closed, { code: CLOSE.updateApp, reason: REASON.updateApp }, '⚠️⚠️ f=1 without p=1 was not refused')
    assert.equal(d.socket.sent.length, 0, '⚠️ challenged an app that cannot answer')
    assert.deepEqual(openedIds(agent), [])
  }
})

test('★★ a Plus room also refuses a handshake naming another key than the proven one (F1 in a Plus room)', async () => {
  const r = rig({ licenses: { PLUS: LIC_PLUS } })
  const agent = await becomeAgent(r, await generateDeviceKey(), { licensing: true })
  await sendLicense(r, agent, 'PLUS')
  const victim = await generateDeviceKey()
  const d = await joinDevice(r)
  await prove(r, d, await generateDeviceKey())
  assert.equal(d.socket.closed, undefined)
  agent.sent.length = 0
  await r_onMessage(r, d.socket, await initFor({ publicKey: victim.publicKey, privateKey: (await generateDeviceKey()).privateKey }))
  assert.deepEqual(d.socket.closed, { code: CLOSE.badProof, reason: REASON.keyMismatch }, '⚠️⚠️ a forged handshake went on in a Plus room')
  assert.equal(agent.sent.length, 0, '⚠️⚠️ the forged handshake reached the agent')
})

test('★★ nothing is carried while the phone\'s challenge is still being made (no proven key yet)', async () => {
  const opts: { challengeGate?: Promise<void> } = {}
  const r = rig(opts)
  const agent = await becomeAgent(r, await generateDeviceKey())
  let release = () => {}
  opts.challengeGate = new Promise<void>((resolve) => (release = resolve))
  assert.equal(r.room.admitDevice().ok, true)
  const socket = r.open('device')
  const start = r.room.startDevice(socket, true)
  agent.sent.length = 0
  await r_onMessage(r, socket, await initFor(await generateDeviceKey()))
  assert.equal(agent.sent.length, 0, '⚠️⚠️ bytes reached the agent before the phone proved any key')
  assert.equal(socket.closed?.code, CLOSE.badProof)
  release()
  await start
  assert.equal(socket.sent.length, 0, '⚠️ a challenge was sent on a closed wire')
})

test('★ a reserved agent wire keeps its place until the proof deadline (not swept early)', async () => {
  const opts: { challengeGate?: Promise<void> } = { challengeGate: new Promise<void>(() => {}) }
  const r = rig(opts)
  const key = toBase64Url(await exportPublicKey((await generateDeviceKey()).publicKey))
  const wires: Fake[] = []
  for (let i = 0; i < MAX_PENDING_AGENTS; i++) {
    assert.equal(r.room.admitAgent().ok, true)
    const w = r.open('agent')
    wires.push(w)
    void r.room.startAgent(w, key)
  }
  r.advance(PROOF_DEADLINE_MS - 1)
  assert.equal(r.room.admitAgent().ok, false, '⚠️ reservations were swept before the deadline')
  assert.ok(wires.every((w) => w.closed === undefined), '⚠️ a reserved wire was closed before the deadline')
  r.advance(1)
  assert.equal(r.room.admitAgent().ok, true, 'reservations were not swept at the deadline')
})
