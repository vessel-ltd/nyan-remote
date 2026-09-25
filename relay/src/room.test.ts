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

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ECDH_PARAMS,
  exportPublicKey,
  fromBase64Url,
  generateDeviceKey,
  relayProof,
  toBase64Url,
  type Jwk,
  type KeyPair,
} from '../../shared/crypto.ts'
import { decodeChallenge, encodeProof } from '../../shared/relayAuth.ts'
import {
  MAX_RELAY_BYTES,
  RELAY_FRAME,
  decodeRelayFrame,
  encodeRelayFrame,
} from '../../shared/relayFrame.ts'
import {
  CLOSE,
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
function rig(o: { licenses?: Record<string, LicenseCheck>; required?: boolean; duringClaim?: () => void; duringClaimAsync?: () => Promise<void> } = {}) {
  const all: { side: 'agent' | 'device'; socket: Fake }[] = []
  let now = 1_000_000
  // ★ The ledger is real (`ledger.ts`). Kept in memory per account
  const ledgers = new Map<string, Ledger>()
  let required = o.required ?? false
  const room = new Room({
    sockets: (side) => all.filter((s) => s.side === side).map((s) => s.socket),
    newChallenge: async () => {
      const eph = (await crypto.subtle.generateKey(ECDH_PARAMS, true, [
        'deriveBits',
      ])) as KeyPair
      return {
        publicRaw: await exportPublicKey(eph.publicKey),
        jwk: (await crypto.subtle.exportKey('jwk', eph.privateKey)) as Jwk,
        nonce: crypto.getRandomValues(new Uint8Array(32)),
      }
    },
    importPrivate: (jwk) =>
      crypto.subtle.importKey('jwk', jwk as never, ECDH_PARAMS, false, ['deriveBits']),
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
    licenseRequired: () => required,
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
    setRequired: (v: boolean) => {
      required = v
    },
    now: () => now,
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

function joinDevice(r: ReturnType<typeof rig>): { socket: Fake; connId: number } {
  assert.equal(r.room.admitDevice().ok, true, 'the phone is not accepted')
  const socket = r.open('device')
  return { socket, connId: r.room.startDevice(socket) }
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
  const { socket: phone } = joinDevice(r)

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
  const first = joinDevice(r)
  assert.equal(first.connId, 1)
  // ★ Disconnected and removed from the table too
  r.room.onClose(first.socket)
  r.forget(first.socket)
  const second = joinDevice(r)
  // ⚠️⚠️ If this were 1, a frame in flight would reach **the new device**
  assert.equal(second.connId, 2, '⚠️⚠️ reused a connection number')
})

test('★★ numbers carry over when the agent reconnects (④ medium #2)', async () => {
  const r = rig()
  const pair = await generateDeviceKey()
  const old = await becomeAgent(r, pair)
  joinDevice(r)
  // ★ Reconnect with the same key (= agent restart)
  const next = await becomeAgent(r, pair)
  assert.notEqual(next, old)
  assert.equal(old.closed?.code, CLOSE.agentGone)
  const after = joinDevice(r)
  assert.equal(after.connId, 2, '⚠️⚠️ numbering went back to 1 on reconnect')
})

test('★★ when the agent reconnects, phones on the previous wire are cut (so they reconnect)', async () => {
  const r = rig()
  const pair = await generateDeviceKey()
  await becomeAgent(r, pair)
  const phone = joinDevice(r)
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
  const phone = joinDevice(r)

  // ⚠️⚠️ The old agent's disconnect arrives **late**
  r.room.onClose(old)
  assert.equal(phone.socket.closed, undefined, '⚠️⚠️ the phone of the new agent was cut')
})

test('★★ when the current agent disconnects, the phones hanging off it are cut', async () => {
  const r = rig()
  const pair = await generateDeviceKey()
  const agent = await becomeAgent(r, pair)
  const phone = joinDevice(r)
  r.room.onClose(agent)
  assert.equal(phone.socket.closed?.code, CLOSE.agentGone)
})

test('★★ adding and stripping numbers (⑦ contents do not change by a single byte)', async () => {
  const r = rig()
  const pair = await generateDeviceKey()
  const agent = await becomeAgent(r, pair)
  const a = joinDevice(r)
  const b = joinDevice(r)
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
  const phone = joinDevice(r)
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
  const s1 = joinDevice(r).socket
  await r.room.onMessage(s1, 'ping')
  assert.equal(s1.closed?.code, CLOSE.badFrame)

  // ⚠️⚠️ Oversized (the ToS measure itself)
  const s2 = joinDevice(r).socket
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
  const r = rig()
  const pair = await generateDeviceKey()
  const agent = await becomeAgent(r, pair)
  for (let i = 0; i < MAX_DEVICES; i++) await agentReplies(r, agent, joinDevice(r).connId)
  assert.equal(r.room.admitDevice().ok, false)
})

test('★★ even if someone who merely knows the key connects silently, a real phone gets in (2026-09-24 / the slot hole)', async () => {
  const r = rig()
  const pair = await generateDeviceKey()
  const agent = await becomeAgent(r, pair)
  // ⚠️ Connect more unaccepted wires than the limit (the agent does not reply = not registered)
  const squatters = Array.from({ length: MAX_DEVICES + MAX_PENDING_DEVICES }, () => joinDevice(r))
  // ★ Unaccepted wires have their own pool: always at most MAX_PENDING_DEVICES (oldest evicted first)
  const alive = squatters.filter((d) => d.socket.closed === undefined)
  assert.equal(alive.length, MAX_PENDING_DEVICES, `⚠️ ${alive.length} unaccepted wires remain`)
  for (const d of squatters.filter((d) => d.socket.closed)) assert.equal(d.socket.closed?.code, CLOSE.notAdmitted)
  // ★★ The real one gets in, becomes "accepted" once the agent replies, and is not evicted
  const real = joinDevice(r)
  await agentReplies(r, agent, real.connId)
  for (let i = 0; i < MAX_PENDING_DEVICES * 3; i++) joinDevice(r)
  assert.equal(real.socket.closed, undefined, '⚠️⚠️ evicted an accepted wire')
  assert.deepEqual([...(real.socket.sent.at(-1) as Uint8Array)], [7], '⚠️ did not reach the accepted wire')
})

test('★★ a wire whose deadline passed unaccepted is collected at the next accept (cannot squat silently)', async () => {
  const r = rig()
  const pair = await generateDeviceKey()
  await becomeAgent(r, pair)
  const a = joinDevice(r)
  r.advance(DEVICE_ADMIT_DEADLINE_MS - 1)
  joinDevice(r)
  assert.equal(a.socket.closed, undefined, '⚠️ evicted before the deadline (would cut a real handshake)')
  r.advance(1)
  joinDevice(r)
  // ⚠️ The assert above narrows the type to `undefined`, so read it again
  const after = (a.socket as { closed?: { code: number } }).closed
  assert.equal(after?.code, CLOSE.notAdmitted, '⚠️⚠️ still squatting after the deadline')
})

test('★★ evicted wires are not delivered to or counted (even if the closing wire lingers)', async () => {
  const r = rig()
  const pair = await generateDeviceKey()
  const agent = await becomeAgent(r, pair)
  const first = joinDevice(r)
  for (let i = 0; i < MAX_PENDING_DEVICES; i++) joinDevice(r)
  assert.equal(first.socket.closed?.code, CLOSE.notAdmitted)
  // ⚠️ The fake keeps closed wires in the table (the real one may too while closing)
  await agentReplies(r, agent, first.connId)
  assert.equal(first.socket.sent.length, 0, '⚠️⚠️ delivered to an evicted wire')
})

test('★★ wires connected before this version (no deadline tag) count as accepted (not cut on deploy)', async () => {
  const r = rig()
  const pair = await generateDeviceKey()
  await becomeAgent(r, pair)
  const old = r.open('device')
  old.setTag({ side: 'device', connId: 99 })
  for (let i = 0; i < MAX_PENDING_DEVICES * 2; i++) joinDevice(r)
  r.advance(DEVICE_ADMIT_DEADLINE_MS * 2)
  joinDevice(r)
  assert.equal(old.closed, undefined, '⚠️⚠️ cut a real phone that had been connected since before the deploy')
})

test('★★ when full, the oldest wire is evicted (a new wire mid-handshake is not cut)', async () => {
  const r = rig()
  const pair = await generateDeviceKey()
  await becomeAgent(r, pair)
  const lines = []
  for (let i = 0; i < MAX_PENDING_DEVICES; i++) {
    lines.push(joinDevice(r))
    r.advance(1_000)
  }
  joinDevice(r)
  assert.equal(lines[0]!.socket.closed?.code, CLOSE.notAdmitted, '⚠️⚠️ the oldest wire remains')
  for (const d of lines.slice(1)) assert.equal(d.socket.closed, undefined, '⚠️⚠️ evicted a newer wire')
})

test('★★ the limit is checked at promotion from the waiting room too (7 + 4 waiting getting replies at once stays at 8 / codex round 18, medium #2)', async () => {
  const r = rig()
  const pair = await generateDeviceKey()
  const agent = await becomeAgent(r, pair)
  for (let i = 0; i < MAX_DEVICES - 1; i++) await agentReplies(r, agent, joinDevice(r).connId)
  const waiting = Array.from({ length: MAX_PENDING_DEVICES }, () => joinDevice(r))
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
  const a = joinDevice(r)
  const b = joinDevice(r)
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
  const a = joinDevice(r)
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
  for (let i = 0; i < 2; i++) await agentReplies(r, agent, joinDevice(r).connId)
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

test('★★ after the grace period, phones are not let into rooms without a ticket (the agent wire is kept)', async () => {
  const r = rig({ licenses: { FREE: LIC_FREE } })
  const agent = await becomeAgent(r, await generateDeviceKey(), { licensing: true })
  assert.equal(r.room.admitDevice().ok, true, 'as before during the grace period')
  r.setRequired(true)
  const denied = r.room.admitDevice()
  assert.equal(denied.ok, false)
  assert.equal(!denied.ok && denied.status, 402)
  assert.equal(agent.closed, undefined, '⚠️ cut the agent wire (a ticket could not be handed over later)')
  await sendLicense(r, agent, 'FREE')
  assert.equal(r.room.admitDevice().ok, true, 'passes once a ticket is handed over')
})

test('★★ a ticket from an agent that did not announce it is cut as "a type that cannot be sent", as before', async () => {
  const r = rig({ licenses: { FREE: LIC_FREE } })
  const agent = await becomeAgent(r, await generateDeviceKey())
  await sendLicense(r, agent, 'FREE')
  assert.equal(agent.closed?.code, CLOSE.badFrame)
})

test('★★ the ticket limit does not exceed the room limit (MAX_DEVICES)', async () => {
  const big: LicenseCheck = { ok: true, license: { ...PLUS, maxDevices: 99 } }
  const r = rig({ licenses: { BIG: big } })
  const agent = await becomeAgent(r, await generateDeviceKey(), { licensing: true })
  await sendLicense(r, agent, 'BIG')
  for (let i = 0; i < MAX_DEVICES; i++) await agentReplies(r, agent, joinDevice(r).connId)
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

test('★★ when a ticket expires, connected phones are closed too (after the grace period / codex round 26, high #2)', async () => {
  const short: LicenseCheck = { ok: true, license: { ...LIC_FREE.license, exp: 1_100 } }
  const r = rig({ licenses: { SHORT: short }, required: true })
  const agent = await becomeAgent(r, await generateDeviceKey(), { licensing: true })
  await sendLicense(r, agent, 'SHORT')
  const d = joinDevice(r)
  await agentReplies(r, agent, d.connId)
  r.advance(200_000)
  const before = agent.sent.length
  await deviceSends(r, d.socket)
  assert.deepEqual(d.socket.closed, { code: CLOSE.tooMany, reason: REASON.licenseRequired }, '⚠️⚠️ kept carrying with an expired ticket')
  assert.equal(agent.sent.slice(before).some((b) => ((x) => x.ok && x.value.type === RELAY_FRAME.data)(decodeRelayFrame(b))), false, '⚠️ carried something from a closed wire')
  assert.deepEqual(licenseResults(agent).slice(-1), ['expired'])
})

test('★★ the moment the grace period ends, connected wires in rooms without a ticket are closed too (codex round 26, high #2)', async () => {
  const r = rig()
  const agent = await becomeAgent(r, await generateDeviceKey(), { licensing: true })
  const d = joinDevice(r)
  await agentReplies(r, agent, d.connId)
  r.setRequired(true)
  await deviceSends(r, d.socket)
  assert.equal(d.socket.closed?.reason, REASON.licenseRequired)
})

test('★★ when the ticket changes Plus → Free, excess phones are closed latest first (codex round 26, high #2)', async () => {
  const r = rig({ licenses: { PLUS: LIC_PLUS, FREE: { ok: true, license: { ...PLUS, plan: 'free', maxMachines: 1, maxDevices: 2 } } } })
  const agent = await becomeAgent(r, await generateDeviceKey(), { licensing: true })
  await sendLicense(r, agent, 'PLUS')
  const ds = []
  for (let i = 0; i < 5; i++) {
    const d = joinDevice(r)
    await agentReplies(r, agent, d.connId)
    ds.push(d)
  }
  await sendLicense(r, agent, 'FREE')
  assert.deepEqual(
    ds.map((d) => d.socket.closed?.code ?? null),
    [null, null, CLOSE.tooMany, CLOSE.tooMany, CLOSE.tooMany],
    '⚠️⚠️ still 5 after going back to Free',
  )
})

test('★★ removed from the account: the room ticket is removed too, and the same ticket at hand cannot bring it back (codex round 26, high #3)', async () => {
  const r = rig({ licenses: { FREE: LIC_FREE }, required: true })
  const agent = await becomeAgent(r, await generateDeviceKey(), { licensing: true })
  await sendLicense(r, agent, 'FREE')
  const d = joinDevice(r)
  await agentReplies(r, agent, d.connId)
  r.advance(10)
  r.release(LIC_FREE.ok ? LIC_FREE.license.acct : '', agent.tag()!.key!, LIC_FREE.ok ? LIC_FREE.license.mid : '')
  assert.equal(agent.tag()?.lic, undefined, '⚠️⚠️ the room ticket remained after removal')
  assert.equal(d.socket.closed?.reason, REASON.licenseRequired)
  assert.deepEqual(licenseResults(agent).slice(-1), ['revoked'])
  await sendLicense(r, agent, 'FREE')
  assert.deepEqual(licenseResults(agent).slice(-1), ['revoked'], '⚠️⚠️ came back with the ticket from before removal')
  assert.equal(agent.tag()?.lic, undefined)
})

test('★★ if removed while waiting for the ledger reply, the returning "may pass" is not used', async () => {
  let release = () => {}
  const r = rig({ licenses: { FREE: LIC_FREE }, duringClaim: () => release() })
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
  const r = rig({ licenses: { FREE: LIC_FREE }, required: true })
  const agent = await becomeAgent(r, await generateDeviceKey(), { licensing: true })
  await sendLicense(r, agent, 'FREE')
  const d = joinDevice(r)
  await agentReplies(r, agent, d.connId)
  // The attacker claims this key under their own account and removes their own passphrase
  r.room.revokeLicense('acct_attacker', 'm_attack001')
  r.room.revokeLicense('acct_free_01', 'm_other0001')
  assert.ok(agent.tag()?.lic, '⚠️⚠️ a "remove" by a stranger removed the ticket of the victim')
  assert.equal(d.socket.closed, undefined)
})

test('★★ removal marks for in-flight checks are not pushed out however many other revocations arrive (codex round 28, medium #5)', async () => {
  let during = () => {}
  const r = rig({ licenses: { FREE: LIC_FREE }, duringClaim: () => during() })
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
  const r = rig({ licenses: { FREE: LIC_FREE }, duringClaimAsync: () => (hold ? new Promise<void>((ok) => gates.push(ok)) : Promise.resolve()) })
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
