// ③ stage 6 step ③b①: the relay link (agent side / `agent/src/relayLink.ts`).
//
// ★★ **Check with the real things wired together**: real relay envelopes (`shared/relayFrame.ts`) → real handshake
//   (`shared/crypto.ts`) → real tunnel → real router. ⚠️ Only **the socket** is fake.
//   ★ The fake socket is **slow with varying speed** (a synchronous fake lets an implementation that
//     "does not wait for sends" slip through / lesson of 2026-09-08).
//
// ★★ **Mutations targeted by name** here:
//   ① treating the first message as an envelope (= the handshake never starts)
//   ② `reply` and `confirm` swapped / `confirm` never sent
//   ③ dispatching to "the first tunnel" instead of looking up by connection number (**two devices get mixed**)
//   ④ creating a tunnel on `data` without seeing `opened` (**a closed number comes back to life**)
//   ⑤ not discarding the tunnel on `closed` (the subscription remains)
//   ⑥ ⚠️⚠️ **sending envelopes** on `closed` / number reuse / `down`
//      (the relay reuses numbers, so **an unrelated next phone breaks**)
//   ⑦ not serializing per number (a `closed` arriving mid-handshake cleans up first and **something remains**)
//   ⑧ opening a tunnel for an unregistered device
//   ⑨ still accepting that number after `fatal` (= the handshake can be retried)
//   ⑩ not closing the link on an unreadable relay envelope

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  FRAME,
  exportPublicKey,
  finishHandshake,
  generateDeviceKey,
  startHandshake,
  toBase64Url,
  type Handshake,
  type Session,
} from '../../shared/crypto.ts'
import {
  RELAY_FRAME,
  decodeRelayFrame,
  encodeRelayFrame,
  RELAY_PING_MS,
  RELAY_PONG,
} from '../../shared/relayFrame.ts'
import {
  decodeClose,
  decodeEvent,
  decodeResponse,
  encodeRequest,
  type TunnelMethod,
} from '../../shared/tunnel.ts'
import { loadConfig } from './config.ts'
import { agentPublicRaw, loadAgentKey, resetAgentKey } from './deviceKey.ts'
import { issueOneTime, listDevices, loadDevices, registerDevice, resetDevices } from './devices.ts'
import { broadcast, clientCount } from './events.ts'
import { keepRelayConnected, openRelayLink, type RelayLink, pongOverdue, PONG_GRACE, connectRelay } from './relayLink.ts'
import { buildRouter } from './routes/index.ts'

/** Swaps the state directory and puts the agent in a "started" state (same steps as tunnel.test.ts) */
async function boot(t: { after: (fn: () => Promise<void>) => void }): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-relaylink-'))
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  const prevDev = process.env['NYAN_REMOTE_DEV']
  process.env['NYAN_REMOTE_STATE_DIR'] = dir
  delete process.env['NYAN_REMOTE_DEV']
  resetAgentKey()
  resetDevices()
  t.after(async () => {
    resetAgentKey()
    resetDevices()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    if (prevDev === undefined) delete process.env['NYAN_REMOTE_DEV']
    else process.env['NYAN_REMOTE_DEV'] = prevDev
    await chmod(dir, 0o700).catch(() => {})
    await rm(dir, { recursive: true, force: true })
    await loadConfig()
  })
  await loadConfig()
  await loadAgentKey()
  await loadDevices()
}

interface Wire {
  link: RelayLink
  /** Bytes that went out on the link (★ in the order they went out) */
  raw: Uint8Array[]
  closed: number
}

/** A fake relay link (⚠️ **slow with varying speed** / see the header notes) */
function link(): Wire {
  const raw: Uint8Array[] = []
  const w = { raw, closed: 0 } as Wire
  let nth = 0
  w.link = openRelayLink({
    router: buildRouter(),
    socket: {
      send: async (bytes) => {
        // make the first message the slowest (without serialization **later envelopes go out first**)
        const wait = Math.max(0, 5 - nth++)
        await new Promise((r) => setTimeout(r, wait))
        raw.push(bytes)
      },
      close: () => {
        w.closed += 1
      },
    },
  })
  return w
}

interface Sent {
  connId: number
  payload: Uint8Array
}

/** Takes out what went onto the link (⚠️ **the contents are not looked at** = only the type and destination are checked) */
function drain(w: Wire): Sent[] {
  return w.raw.splice(0, w.raw.length).map((bytes) => {
    const d = decodeRelayFrame(bytes)
    assert.ok(d.ok, `⚠️ the agent emitted an unreadable envelope: ${!d.ok ? d.reason : ''}`)
    assert.equal(d.value.type, RELAY_FRAME.data, '⚠️⚠️ the agent must not send anything but data')
    return { connId: d.value.connId, payload: d.value.payload as Uint8Array }
  })
}

function relayFrame(type: number, connId: number, payload?: Uint8Array): Uint8Array {
  return encodeRelayFrame({
    type: type as 1 | 2 | 3,
    connId,
    ...(payload ? { payload } : {}),
  })
}

interface Peer {
  connId: number
  raw: Uint8Array
  h: Handshake
  session?: Session
}

/** One phone (★ registered by default) */
async function peer(connId: number, register = true): Promise<Peer> {
  const pair = await generateDeviceKey()
  const raw = await exportPublicKey(pair.publicKey)
  if (register) {
    assert.equal((await registerDevice(raw, `端末${connId}`, issueOneTime().token)).ok, true)
  }
  return { connId, raw, h: await startHandshake(pair, agentPublicRaw()) }
}

/** Sends the relay signal (`opened`) + the raw first message to complete the handshake */
async function joinPeer(w: Wire, p: Peer): Promise<Session> {
  await w.link.receive(relayFrame(RELAY_FRAME.opened, p.connId))
  await w.link.receive(relayFrame(RELAY_FRAME.data, p.connId, p.h.message))
  const mine = drain(w).filter((f) => f.connId === p.connId)
  assert.equal(mine.length, 2, `the two handshake messages (reply / confirm) did not go out (${mine.length})`)
  // ★★ if the order were swapped, it fails here (mutation ②)
  const pending = await finishHandshake(p.h, mine[0]!.payload)
  p.session = await pending.accept(mine[1]!.payload)
  return p.session
}

async function ask(
  w: Wire,
  p: Peer,
  r: { id: number; method: TunnelMethod; path: string; body?: Record<string, unknown> },
): Promise<void> {
  const frame = await p.session!.seal(FRAME.request, encodeRequest(r))
  await w.link.receive(relayFrame(RELAY_FRAME.data, p.connId, frame))
}

interface Opened {
  responses: { id: number; status: number; body?: unknown }[]
  events: { id: number; event: unknown }[]
  closes: { id?: number; reason?: string }[]
}

/**
 * Opens the envelopes addressed to that device **in the order they went out**.
 *
 * ★★ Mutation ③ (dispatching without looking up by number) dies here: an envelope sealed with another
 *    device's key fails in `open` (= "mixed up" shows up as an exception).
 */
async function openFor(sent: Sent[], p: Peer): Promise<Opened> {
  const out: Opened = { responses: [], events: [], closes: [] }
  for (const f of sent.filter((x) => x.connId === p.connId)) {
    const opened = await p.session!.open(f.payload)
    if (opened.type === FRAME.response) {
      const d = decodeResponse(opened.plaintext)
      assert.ok(d.ok)
      out.responses.push(d.value)
    } else if (opened.type === FRAME.event) {
      const d = decodeEvent(opened.plaintext)
      assert.ok(d.ok)
      out.events.push(d.value)
    } else if (opened.type === FRAME.close) {
      const d = decodeClose(opened.plaintext)
      assert.ok(d.ok)
      out.closes.push(d.value)
    } else {
      assert.fail(`an unknown type arrived: ${opened.type}`)
    }
  }
  return out
}

test('★★★★ the raw first message completes the handshake, and afterwards envelopes reach the real router', async (t) => {
  await boot(t)
  const w = link()
  const p = await peer(1)
  await joinPeer(w, p)
  assert.equal(w.link.openTunnels, 1, 'no tunnel opened')

  await ask(w, p, { id: 1, method: 'GET', path: '/health' })
  const out = await openFor(drain(w), p)
  assert.equal(out.responses.length, 1)
  assert.equal(out.responses[0]!.id, 1)
  assert.equal(out.responses[0]!.status, 200)
  // ★★ check "the value the implementation built" (the real `/health` = **this agent** is answering)
  assert.equal(
    (out.responses[0]!.body as { agentPublicKey?: string }).agentPublicKey,
    toBase64Url(agentPublicRaw()),
  )
})

test('★★★★ two devices do not get mixed (separate keys and tunnels per connection number)', async (t) => {
  await boot(t)
  const w = link()
  const a = await peer(1)
  const b = await peer(2)
  await joinPeer(w, a)
  await joinPeer(w, b)
  assert.equal(w.link.openTunnels, 2)

  await ask(w, a, { id: 11, method: 'GET', path: '/health' })
  await ask(w, b, { id: 22, method: 'GET', path: '/health' })
  const sent = drain(w)
  // ★★ if destinations were swapped, `open` fails (= mutation ③)
  assert.deepEqual(
    (await openFor(sent, a)).responses.map((r) => r.id),
    [11],
  )
  assert.deepEqual(
    (await openFor(sent, b)).responses.map((r) => r.id),
    [22],
  )
})

test('★★★★ numbers whose `opened` was not seen are not accepted (closed numbers do not come back to life)', async (t) => {
  await boot(t)
  const w = link()
  const p = await peer(9)
  // ⚠️ skip `opened` and send only the first message
  await w.link.receive(relayFrame(RELAY_FRAME.data, p.connId, p.h.message))
  assert.equal(w.link.openTunnels, 0, '⚠️⚠️ opened a tunnel for a number with no signal')
  assert.deepEqual(drain(w), [], '⚠️⚠️ sent to a number with no signal')
})

test('★★★★ an unregistered device cannot handshake (nothing is returned)', async (t) => {
  await boot(t)
  const w = link()
  const p = await peer(1, false)
  await w.link.receive(relayFrame(RELAY_FRAME.opened, p.connId))
  await w.link.receive(relayFrame(RELAY_FRAME.data, p.connId, p.h.message))
  assert.equal(w.link.openTunnels, 0, '⚠️⚠️ opened a tunnel for an unregistered device')
  assert.deepEqual(drain(w), [], '⚠️ replied to an unregistered device')

  // ★★ **a number refused once is not accepted even if registered later** (mutation M10).
  //   ⚠️ do not let one connection try handshakes repeatedly (= do not let it repeat key agreement computations).
  //      reconnecting is fine (the relay assigns a new number).
  assert.equal((await registerDevice(p.raw, 'あとから登録', issueOneTime().token)).ok, true)
  const again = await peer(p.connId)
  await w.link.receive(relayFrame(RELAY_FRAME.data, p.connId, again.h.message))
  assert.equal(w.link.openTunnels, 0, '⚠️⚠️ the handshake could be retried on a refused number')
  assert.deepEqual(drain(w), [], '⚠️⚠️ sent to a refused number')
})

test('★★★★ `closed` stops the subscription and **sends not a single byte** (number reuse)', async (t) => {
  await boot(t)
  const w = link()
  const p = await peer(1)
  await joinPeer(w, p)
  await ask(w, p, { id: 5, method: 'GET', path: '/events' })
  await w.link.flush()
  assert.equal((await openFor(drain(w), p)).responses[0]!.status, 200)

  assert.equal(clientCount(), 1, 'the subscription has not started')

  await w.link.receive(relayFrame(RELAY_FRAME.closed, p.connId))
  assert.equal(w.link.openTunnels, 0, '⚠️ the tunnel remains after closing')
  // ★★ **the authority on subscriptions is `events.ts`** (⚠️ without discarding the tunnel, a receiver with
  //    nowhere to write stays around forever = only noticed by looking through the counting hook / mutation M5)
  assert.equal(clientCount(), 0, '⚠️⚠️ a subscription remains in events.ts')
  // ⚠️ do not let the table itself pile up either (closed numbers are removed / mutation M14)
  assert.equal(w.link.connections, 0, '⚠️ a closed number remains in the table')
  // ⚠️⚠️ sending to a closed number reaches **the next phone connected under the same number**
  assert.deepEqual(drain(w), [], '⚠️⚠️ sent an envelope to a closed number')

  broadcast({ type: 'sessions-changed', at: '2026-09-15T00:00:00.000Z' })
  await w.link.flush()
  assert.deepEqual(drain(w), [], '⚠️ events keep flowing after closing')
})

test('★★★★ when the same number is reconnected, the previous occupant is discarded without sending', async (t) => {
  await boot(t)
  const w = link()
  const a = await peer(1)
  await joinPeer(w, a)
  await ask(w, a, { id: 5, method: 'GET', path: '/events' })
  await w.link.flush()
  drain(w)

  // ★ the relay counts from live slots, so a closed number goes to the next phone
  const b = await peer(1)
  await w.link.receive(relayFrame(RELAY_FRAME.opened, b.connId))
  assert.equal(w.link.openTunnels, 0, '⚠️ the previous occupant\'s tunnel remains')
  assert.deepEqual(drain(w), [], '⚠️⚠️ sent envelopes meant for the previous occupant to the new phone')

  // ★ the new occupant can handshake normally
  await w.link.receive(relayFrame(RELAY_FRAME.data, b.connId, b.h.message))
  const mine = drain(w)
  assert.equal(mine.length, 2)
  b.session = await (await finishHandshake(b.h, mine[0]!.payload)).accept(mine[1]!.payload)
  await ask(w, b, { id: 1, method: 'GET', path: '/health' })
  assert.equal((await openFor(drain(w), b)).responses[0]!.status, 200)
})

test('★★★★ if it closes mid-handshake, discard without sending anything (per-number serialization / ⑦)', async (t) => {
  await boot(t)
  const w = link()
  const p = await peer(1)
  await w.link.receive(relayFrame(RELAY_FRAME.opened, p.connId))
  // ⚠️⚠️ send the next one **without waiting** (the handshake is async, so without serialization it gets overtaken)
  const first = w.link.receive(relayFrame(RELAY_FRAME.data, p.connId, p.h.message))
  await w.link.receive(relayFrame(RELAY_FRAME.closed, p.connId))
  await first
  await w.link.flush()

  assert.equal(w.link.openTunnels, 0, '⚠️⚠️ a tunnel was registered after closing')
  assert.deepEqual(drain(w), [], '⚠️⚠️ sent a handshake reply to a closed number')
})

test('★★★★ even if the first message arrives twice, no second tunnel is created (serialization / ⑦)', async (t) => {
  await boot(t)
  const w = link()
  const p = await peer(1)
  await w.link.receive(relayFrame(RELAY_FRAME.opened, p.connId))
  const a = w.link.receive(relayFrame(RELAY_FRAME.data, p.connId, p.h.message))
  const b = w.link.receive(relayFrame(RELAY_FRAME.data, p.connId, p.h.message))
  await Promise.all([a, b])

  const sent = drain(w)
  // ★ only one reply / confirm pair (★ two pairs would mean the handshake ran twice)
  assert.equal(sent.length, 3, `${sent.length} envelopes went out (should be 3: reply, confirm, close)`)
  const pending = await finishHandshake(p.h, sent[0]!.payload)
  p.session = await pending.accept(sent[1]!.payload)
  // ★ the second raw first message is "an envelope that cannot be opened", so the whole tunnel is refused
  const out = await openFor(sent.slice(2), p)
  assert.equal(out.closes.length, 1, 'the close was not reported')
  assert.equal(w.link.openTunnels, 0)
})

test('★★★★ a tampered envelope cuts it off, and that number cannot retry even from the handshake (⑨)', async (t) => {
  await boot(t)
  const w = link()
  const p = await peer(1)
  await joinPeer(w, p)

  const frame = await p.session!.seal(FRAME.request, encodeRequest({ id: 1, method: 'GET', path: '/health' }))
  const tampered = new Uint8Array(frame)
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff
  await w.link.receive(relayFrame(RELAY_FRAME.data, p.connId, tampered))
  assert.equal(w.link.openTunnels, 0, '⚠️⚠️ the tunnel is alive after a tampered envelope')
  // ★ the peer is still connected, so the reason arrives in an envelope
  const out = await openFor(drain(w), p)
  assert.equal(out.closes.length, 1, 'the reason was not reported')

  // ⚠️⚠️ afterwards even a **correct** request does not pass (= the whole number is refused)
  const again = await peer(1)
  await w.link.receive(relayFrame(RELAY_FRAME.data, p.connId, again.h.message))
  assert.equal(w.link.openTunnels, 0, '⚠️⚠️ the handshake could be retried on a refused number')
  assert.deepEqual(drain(w), [], '⚠️⚠️ sent to a refused number')
})

test('★★★★ an unreadable relay envelope closes the whole link (⑩)', async (t) => {
  await boot(t)
  const w = link()
  const p = await peer(1)
  await joinPeer(w, p)

  await w.link.receive(new Uint8Array([0, 0, 0, 0, 0, 0]))
  assert.equal(w.closed, 1, '⚠️⚠️ kept the link open after an unreadable envelope')
  assert.equal(w.link.openTunnels, 0)
  assert.deepEqual(drain(w), [], '⚠️⚠️ sent on a dropped link')

  // ⚠️ anything arriving after the drop does nothing
  await ask(w, p, { id: 2, method: 'GET', path: '/health' })
  assert.deepEqual(drain(w), [])
})

test('★★★★ down() discards every tunnel (⚠️ sends nothing)', async (t) => {
  await boot(t)
  const w = link()
  const a = await peer(1)
  const b = await peer(2)
  await joinPeer(w, a)
  await joinPeer(w, b)
  for (const p of [a, b]) await ask(w, p, { id: 5, method: 'GET', path: '/events' })
  await w.link.flush()
  drain(w)

  await w.link.down('テスト')
  assert.equal(w.link.openTunnels, 0)
  assert.equal(w.closed, 1, 'the link was not closed')

  broadcast({ type: 'sessions-changed', at: '2026-09-15T00:00:00.000Z' })
  await w.link.flush()
  assert.deepEqual(drain(w), [], '⚠️⚠️ sent an envelope on a dropped link')

  // ★★ **a new phone** arriving on a dropped link is not accepted either (mutation M15)
  const c = await peer(3)
  await w.link.receive(relayFrame(RELAY_FRAME.opened, c.connId))
  await w.link.receive(relayFrame(RELAY_FRAME.data, c.connId, c.h.message))
  assert.equal(w.link.openTunnels, 0, '⚠️⚠️ handshook on a dropped link')
  assert.deepEqual(drain(w), [], '⚠️⚠️ sent on a dropped link')
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ ③b step ④: reconnecting (`keepRelayConnected`).
//
// ★★ **Mutations targeted by name** here:
//   ⑪ giving up after one failure (= does not connect even when the relay comes back)
//   ⑫ the wait does not grow (keeps hammering a peer it cannot reach) / ⑬ grows beyond the ceiling
//   ⑭ the wait is not reset on a disconnect after it had settled (= always waits long)
//   ⑮ no jitter (every agent hammers **all at once** the moment the relay comes back)
//   ⑯ reconnecting after `stop()` / not stopping while waiting (**the process cannot exit**)
//   ⑰ `stop()` does not discard the link (open subscriptions remain)
//   ⑱ keeps hammering **a peer that cuts right after connecting** with the minimum wait (= resetting the count merely on connecting)
// ─────────────────────────────────────────────────────────────────────────────

/** ⚠️ A fake link (★ has a hook to drop it) */
function fakeLink(onDown: (reason: string) => void): { link: RelayLink; downs: string[] } {
  const downs: string[] = []
  const link: RelayLink = {
    receive: async () => undefined,
    down: async (reason?: string) => {
      downs.push(reason ?? '')
      onDown(reason ?? '')
    },
    flush: async () => undefined,
    get openTunnels() {
      return 0
    },
    get connections() {
      return 0
    },
  }
  return { link, downs }
}

async function until(pred: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.fail(`${what} never happened`)
}

test('★★★★ reconnects when the link drops (⑪)', { timeout: 5000 }, async () => {
  const falls: ((reason: string) => void)[] = []
  const keeper = keepRelayConnected({
    base: 'ws://relay.test',
    router: buildRouter(),
    minWaitMs: 5,
    maxWaitMs: 20,
    connect: async ({ onDown }) => {
      falls.push(onDown)
      return fakeLink(onDown).link
    },
  })
  await until(() => falls.length === 1, 'first link connects')
  // ⚠️ it becomes `open` **on the tick after** connecting (= no guessing by time)
  await until(() => keeper.status.state === 'open', 'connected')

  falls[0]!('切れました')
  await until(() => falls.length === 2, 'reconnects')
  await until(() => keeper.status.state === 'open', 'connected again')
  await keeper.stop()
})

test('★★★★ when it cannot connect it spaces out attempts and stays under the ceiling (⑫⑬)', { timeout: 5000 }, async () => {
  const waits: number[] = []
  const keeper = keepRelayConnected({
    base: 'ws://relay.test',
    router: buildRouter(),
    minWaitMs: 10,
    maxWaitMs: 40,
    // ★ pin the jitter to "full amount" so only the growth is observed
    random: () => 1,
    connect: async () => {
      throw new Error('繋がりません')
    },
    onStatus: (s) => {
      if (s.state === 'waiting') waits.push(s.waitMs ?? -1)
    },
  })
  await until(() => waits.length >= 4, 'waited 4 times')
  await keeper.stop()
  // ⚠️ doubles and stops at the ceiling (40)
  assert.deepEqual(waits.slice(0, 4), [10, 20, 40, 40])
  assert.match(keeper.status.lastError ?? '', /繋がりません/)
})

test('★★★★ a drop after it had settled restarts the wait from the beginning (⑭)', { timeout: 5000 }, async () => {
  const waits: number[] = []
  let tries = 0
  const falls: ((reason: string) => void)[] = []
  const keeper = keepRelayConnected({
    base: 'ws://relay.test',
    router: buildRouter(),
    minWaitMs: 10,
    maxWaitMs: 640,
    random: () => 1,
    // ★ treated as "settled" (the reverse of ⑱; here the case of a long connection)
    stableMs: 0,
    connect: async ({ onDown }) => {
      tries += 1
      // only the first attempt fails
      if (tries === 1) throw new Error('繋がりません')
      falls.push(onDown)
      return fakeLink(onDown).link
    },
    onStatus: (s) => {
      if (s.state === 'waiting') waits.push(s.waitMs ?? -1)
    },
  })
  await until(() => falls.length === 1, 'connects on the second try')
  // ⚠️⚠️ showing "1 consecutive failure" while connected would be a lie (it goes straight to the screen)
  assert.equal(keeper.status.attempts, 0, 'the failure count remains although connected')
  falls[0]!('切れました')
  await until(() => waits.length >= 2, 'waits after the drop')
  await keeper.stop()
  // ⚠️⚠️ without a reset the second wait would be 20 (doubled)
  assert.deepEqual(waits.slice(0, 2), [10, 10])
})

test('★★★★ does not keep hammering a peer that cuts right after connecting (⑱)', { timeout: 5000 }, async () => {
  const waits: number[] = []
  const keeper = keepRelayConnected({
    base: 'ws://relay.test',
    router: buildRouter(),
    minWaitMs: 10,
    maxWaitMs: 80,
    random: () => 1,
    // ⚠️ cut **much sooner** than the length that counts as "settled"
    stableMs: 10_000,
    connect: async ({ onDown }) => {
      const fake = fakeLink(onDown)
      // ★ cut right after connecting (during deploy, device limit, being rejected, etc.)
      setTimeout(() => onDown('すぐ切れました'), 0)
      return fake.link
    },
    onStatus: (s) => {
      if (s.state === 'waiting') waits.push(s.waitMs ?? -1)
    },
  })
  await until(() => waits.length >= 4, 'waited 4 times')
  await keeper.stop()
  // ⚠️⚠️ with only "reset to 0 on connecting" it would be **10ms every time**, hammering the peer
  assert.deepEqual(waits.slice(0, 4), [10, 20, 40, 80])
})

test('★★★★ the wait has jitter (⑮ no hammering all at once)', { timeout: 5000 }, async () => {
  const waits: number[] = []
  const keeper = keepRelayConnected({
    base: 'ws://relay.test',
    router: buildRouter(),
    // ★ make the ceiling = floor to remove "growth" and observe **only the jitter**
    minWaitMs: 40,
    maxWaitMs: 40,
    connect: async () => {
      throw new Error('繋がりません')
    },
    onStatus: (s) => {
      if (s.state === 'waiting') waits.push(s.waitMs ?? -1)
    },
  })
  await until(() => waits.length >= 6, 'waited 6 times')
  await keeper.stop()
  const seen = new Set(waits.slice(0, 6))
  assert.ok(seen.size > 1, `⚠️⚠️ the wait is the same every time (${[...seen].join(',')})`)
  // ★ between half and the full amount (⚠️ never 0 or above the ceiling)
  for (const ms of waits.slice(0, 6)) assert.ok(ms >= 20 && ms <= 40, `${ms}ms`)
})

test('★★★★ once stopped, it stops immediately even while waiting and does not reconnect (⑯)', { timeout: 5000 }, async () => {
  let tries = 0
  const keeper = keepRelayConnected({
    base: 'ws://relay.test',
    router: buildRouter(),
    // ⚠️ deliberately long (**if the wait cannot be cut, this test times out**)
    minWaitMs: 30_000,
    maxWaitMs: 30_000,
    connect: async () => {
      tries += 1
      throw new Error('繋がりません')
    },
  })
  await until(() => keeper.status.state === 'waiting', 'enters waiting')
  await keeper.stop()
  assert.equal(keeper.status.state, 'stopped')
  const after = tries
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(tries, after, '⚠️⚠️ reconnected after being stopped')
})

test('★★★★ once stopped, the currently connected link is discarded too (⑰)', { timeout: 5000 }, async () => {
  let fake: { link: RelayLink; downs: string[] } | undefined
  const keeper = keepRelayConnected({
    base: 'ws://relay.test',
    router: buildRouter(),
    minWaitMs: 5,
    maxWaitMs: 5,
    connect: async ({ onDown }) => {
      fake = fakeLink(onDown)
      return fake.link
    },
  })
  await until(() => keeper.status.state === 'open', 'connected')
  await keeper.stop('テスト終了')
  assert.deepEqual(fake?.downs, ['テスト終了'], '⚠️ the link was not discarded')
  assert.equal(keeper.link, undefined, '⚠️ keeps holding a dropped link')
})

test('★★★★ a refused number cannot retry even with a queued handshake (⑲ codex round 4, medium #7)', { timeout: 5000 }, async (t) => {
  await boot(t)
  const w = link()
  const p = await peer(1)
  await joinPeer(w, p)

  const frame = await p.session!.seal(FRAME.request, encodeRequest({ id: 1, method: 'GET', path: '/health' }))
  const tampered = new Uint8Array(frame)
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff
  const again = await peer(p.connId)

  // ⚠️⚠️ send two **without waiting** (= both queued while "not yet dead")
  const a = w.link.receive(relayFrame(RELAY_FRAME.data, p.connId, tampered))
  const b = w.link.receive(relayFrame(RELAY_FRAME.data, p.connId, again.h.message))
  await Promise.all([a, b])
  await w.link.flush()

  assert.equal(w.link.openTunnels, 0, '⚠️⚠️ the handshake could be retried on a refused number')
})

test('★★★★ stopping while connecting stops without waiting (⑳ codex round 4, medium #8)', { timeout: 5000 }, async () => {
  let settle: ((link: RelayLink) => void) | undefined
  let fake: { link: RelayLink; downs: string[] } | undefined
  const keeper = keepRelayConnected({
    base: 'ws://relay.test',
    router: buildRouter(),
    minWaitMs: 5,
    maxWaitMs: 5,
    // ⚠️ **a connection that never returns** (= stuck while going to connect)
    connect: async ({ onDown }) =>
      await new Promise<RelayLink>((resolve) => {
        fake = fakeLink(onDown)
        settle = resolve
      }),
  })
  await until(() => settle !== undefined, 'goes to connect')

  // ⚠️⚠️ before the fix it **did not return until connected** here (= the whole test died by timeout)
  await keeper.stop('テスト終了')
  assert.equal(keeper.status.state, 'stopped')

  // ★ even if it connects later, **discard it** (leave no link)
  settle?.(fake!.link)
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(fake?.downs, ['止めました'], '⚠️⚠️ a link that connected later remained')
  assert.equal(keeper.link, undefined)
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ **Drop a link that returns no pong** (2026-09-19 / hit in practice)
//
// ⚠️⚠️ Symptom: **the second phone cannot pair**, yet the agent log shows not a single `[relay]` line
//   (not refused either = it never arrived). The agent thinks it is "connected", and
//   `/health` also says `open`. ⇒ **a half-dead link** (TCP silently cut).
//   ★ In practice it stayed like that **for over 2 hours**; the moment TCP finally died it reconnected within a second and "fixed itself".
//
// ★ Mutations targeted here:
//   ① not looking at pongs (= the shape before the fix; never drops)
//   ② dropping after one miss (⚠️ a wrong drop **disconnects phones** on reconnect)
//   ③ no starting point (always drops on the first tick right after `open`)
// ─────────────────────────────────────────────────────────────────────────────

test('★★★★ a link with no reply is dropped. ⚠️ But not after a single miss', () => {
  const pingMs = 45_000
  // ★ it came back exactly on time ⇒ not dropped
  assert.equal(pongOverdue({ lastPongAt: 0, now: 0, pingMs }), false)
  // ⚠️ missed once (silent for ① one interval) ⇒ **not dropped yet**
  assert.equal(pongOverdue({ lastPongAt: 0, now: pingMs, pingMs }), false, '⚠️⚠️ drops after one miss')
  // ⚠️ missed twice ⇒ still not (exactly at the boundary is allowed)
  assert.equal(pongOverdue({ lastPongAt: 0, now: pingMs * 2, pingMs }), false)
  // ★ beyond that it is dropped (= reconnects)
  assert.equal(pongOverdue({ lastPongAt: 0, now: pingMs * 2 + 1, pingMs }), true, '⚠️⚠️ does not drop a dead link')
  assert.equal(pongOverdue({ lastPongAt: 0, now: pingMs * 10, pingMs }), true)
})

test('★★★ the time to detect is "interval × grace" (⚠️ orders of magnitude from the 2 hours seen in practice)', () => {
  // ⚠️ noticed after 45s × 2 = 90s (before the fix it relied on the OS TCP timeout)
  assert.equal(PONG_GRACE, 2, 'if you change the grace, review the time to detect too')
  const detectMs = RELAY_PING_MS * PONG_GRACE
  assert.ok(detectMs <= 3 * 60_000, `detection is too slow: ${Math.round(detectMs / 1000)}s`)
  // ⚠️ too short is bad too (false positive ⇒ reconnect ⇒ the relay replaces the old link and **phones disconnect**)
  assert.ok(detectMs >= 60_000, `detection is too fast (reconnects on false positives): ${Math.round(detectMs / 1000)}s`)
})

test('★★★ the starting point is "when it opened" (③ without it, always dropped on the first tick)', () => {
  // ⚠️ reaching the first tick with `lastPongAt` still 0 means `now` is huge, so it is always overdue
  //    = **dropped every time right after opening, never getting out of the reconnect loop**.
  assert.equal(pongOverdue({ lastPongAt: 0, now: Date.now(), pingMs: RELAY_PING_MS }), true)
  // ★ the implementation sets the starting point at `open` (the wiring check below looks at it)
})

test('★★★★ wiring: sets the starting point on `open`, checks `pongOverdue` on tick and calls `close()`', () => {
  // ⚠️ `connectRelay` creates **a real `WebSocket`**, so it does not run from tests (the same hole as `worker.ts`).
  //    ⇒ the decision is hammered via the pure function above; here only **that it is wired up** is checked.
  const src = readFileSync(new URL('./relayLink.ts', import.meta.url), 'utf8')
  // ⚠️ extracting the body with a regex stops at **the closing brace of the argument type** (the `}` in column 0)
  //    (actually hit). ⇒ just cut up to the next section separator.
  const from = src.indexOf('export function connectRelay(')
  assert.ok(from >= 0, 'connectRelay not found')
  const to = src.indexOf('\n// ─', from)
  assert.ok(to > from, 'next section separator not found')
  const body = src.slice(from, to)
  assert.ok(body.length > 1000, `could not get the body of connectRelay (${body.length} chars)`)
  assert.match(body, /if \(ev\.data === RELAY_PONG\) lastPongAt = Date\.now\(\)/, '⚠️⚠️ pongs are not looked at')
  assert.match(body, /lastPongAt = Date\.now\(\)\n\s*beat = setInterval/, '⚠️⚠️ no starting point set on open')
  // ⚠️ writing the arguments in a regex cuts at the `)` of `Date.now()` (actually hit) ⇒ check by position
  const at = body.indexOf('pongOverdue(')
  assert.ok(at >= 0, '⚠️⚠️ unresponsiveness is not checked on tick')
  const closeAt = body.indexOf('ws.close()', at)
  assert.ok(closeAt > at && closeAt - at < 300, '⚠️⚠️ the link is not dropped even when unresponsive')
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ **An unresponsive link is cleaned up without waiting for the `close` event** (codex round 10, high #1)
//
// ⚠️⚠️ Before the fix it only called `ws.close()`. **That does not bring it back**:
//   calling `close()` on a black-holed link puts the WebSocket into `CLOSING`,
//   **waiting for the peer's close reply**. The reply never comes, so **the `close` event never comes** =
//   neither `onDown` nor `clearInterval` runs.
//   ⇒ **The "does not recover until the TCP timeout" we wanted to fix was still there**
//     (codex measured `readyState=2` / `onDown=0` over the equivalent of 15 minutes with Node's built-in implementation).
// ─────────────────────────────────────────────────────────────────────────────

/** ★ A fake socket that black-holes (⚠️ calling `close()` **does not fire** `close`) */
function blackholeSocket() {
  const on = new Map<string, Array<(ev: unknown) => void>>()
  const state = { sent: [] as unknown[], closes: 0 }
  const ws = {
    binaryType: '',
    send: (d: unknown) => void state.sent.push(d),
    // ⚠️⚠️ this is the crux: **closing does not bring a `close` event** (the peer does not respond)
    close: () => void state.closes++,
    addEventListener: (t: string, cb: (ev: unknown) => void) => {
      const list = on.get(t) ?? []
      list.push(cb)
      on.set(t, list)
    },
  }
  return {
    ws: ws as unknown as WebSocket,
    state,
    fire: (t: string, ev: unknown = {}) => {
      for (const cb of on.get(t) ?? []) cb(ev)
    },
  }
}

test('★★★★ when unresponsive, it reaches `onDown` without waiting for `close` (= reconnecting runs)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-relaylink-'))
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = dir
  resetAgentKey()
  t.after(async () => {
    resetAgentKey()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(dir, { recursive: true, force: true })
  })
  await loadAgentKey()

  const sock = blackholeSocket()
  const downs: string[] = []
  const link = await new Promise<Awaited<ReturnType<typeof connectRelay>>>((resolve, reject) => {
    const p = connectRelay({
      base: 'wss://relay.invalid',
      router: buildRouter(),
      onDown: (r) => void downs.push(r),
      pingMs: 20,
      open: () => sock.ws,
    })
    p.then(resolve, reject)
    // ⚠️ open it (★ this starts the ping loop)
    sock.fire('open')
  })
  assert.ok(link, 'could not open')

  // ⚠️ never return a pong = beyond the grace
  await new Promise((r) => setTimeout(r, 20 * 5))

  assert.ok(sock.state.closes >= 1, '⚠️ did not try to close')
  // ★★ **this is the main point**: `onDown` runs although the `close` event never came
  assert.equal(downs.length, 1, `⚠️⚠️ waiting for close (onDown ran ${downs.length} times)`)
  assert.match(downs[0] ?? '', /無反応/, 'the reason is not "unresponsive"')

  // ⚠️ even if a real `close` arrives later, **the second time does nothing**
  sock.fire('close', { code: 1006, reason: '' })
  assert.equal(downs.length, 1, '⚠️⚠️ cleanup ran twice')

  // ⚠️ the pings must have stopped too (otherwise it keeps sending on a closed link)
  const sentBefore = sock.state.sent.length
  await new Promise((r) => setTimeout(r, 20 * 3))
  assert.equal(sock.state.sent.length, sentBefore, '⚠️⚠️ keeps sending pings after cleanup')
})

test('★★★ not dropped while pongs keep coming back (no disconnecting phones on false positives)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-relaylink-'))
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = dir
  resetAgentKey()
  t.after(async () => {
    resetAgentKey()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(dir, { recursive: true, force: true })
  })
  await loadAgentKey()

  const sock = blackholeSocket()
  const downs: string[] = []
  const urls: string[] = []
  await new Promise<void>((resolve, reject) => {
    connectRelay({
      base: 'wss://relay.invalid',
      router: buildRouter(),
      onDown: (r) => void downs.push(r),
      pingMs: 20,
      open: (u) => {
        urls.push(u)
        return sock.ws
      },
    }).then(() => resolve(), reject)
    sock.fire('open')
  })

  // ★ like the relay's auto-response, always return a pong to a ping
  const beat = setInterval(() => sock.fire('message', { data: RELAY_PONG }), 10)
  t.after(() => clearInterval(beat))
  await new Promise((r) => setTimeout(r, 20 * 6))
  assert.deepEqual(downs, [], '⚠️⚠️ dropped a live link (phones disconnect)')
  // ★★ declares it understands `ready` / `drop` (without declaring, the relay does not send ready = the slot hole stays open)
  assert.equal(new URL(urls[0]!).searchParams.get('c'), '1', '⚠️⚠️ c=1 not declared')
})

test('★★★★ after the phone drops the link, requests queued behind are not run (an operation shown as failed does not run on the PC / codex round 18, medium #5)', { timeout: 5000 }, async (t) => {
  await boot(t)
  // ★ a link whose response sending can be stalled (= a slow request clogging that number's chain)
  const raw: Uint8Array[] = []
  let gate: Promise<void> = Promise.resolve()
  let open!: () => void
  const w = { raw, closed: 0 } as Wire
  w.link = openRelayLink({
    router: buildRouter(),
    socket: {
      send: async (bytes) => {
        await gate
        raw.push(bytes)
      },
      close: () => {
        w.closed += 1
      },
    },
  })
  const p = await peer(1)
  await joinPeer(w, p)
  // ★ a peer that shows whether it was revoked (the second registration)
  const victim = await peer(2)
  const victimKey = toBase64Url(victim.raw)
  assert.ok(listDevices().some((d) => d.key === victimKey))

  gate = new Promise((r) => {
    open = r
  })
  // ① the first: stuck sending its response
  const first = ask(w, p, { id: 1, method: 'GET', path: '/health' })
  await new Promise((r) => setTimeout(r, 20))
  // ② the second: queued behind (⚠️ a state-changing request)
  const second = ask(w, p, { id: 2, method: 'POST', path: '/devices/revoke', body: { key: victimKey } })
  await new Promise((r) => setTimeout(r, 20))
  // ③ the phone dropped the link (the relay's closed)
  // ⚠️ the cleanup for `closed` also lines up on the same chain, so send without waiting (the `gone` mark is set synchronously)
  const gone = w.link.receive(relayFrame(RELAY_FRAME.closed, p.connId))
  open()
  await Promise.all([first, second, gone])
  await w.link.flush()
  assert.ok(
    listDevices().some((d) => d.key === victimKey),
    '⚠️⚠️ ran a not-yet-started request from a link the phone dropped (the screen says "failed" but it runs on the PC)',
  )
})

/** ★ Every frame type that went onto the link (`drain` expects only data, so use this to look at drop) */
function frames(w: Wire): { type: number; connId: number }[] {
  return w.raw.splice(0, w.raw.length).map((bytes) => {
    const d = decodeRelayFrame(bytes)
    assert.ok(d.ok)
    return { type: d.value.type, connId: d.value.connId }
  })
}

function linkWith(o: { pairingTtlMs?: number } = {}): Wire {
  const raw: Uint8Array[] = []
  const w = { raw, closed: 0 } as Wire
  w.link = openRelayLink({
    router: buildRouter(),
    socket: {
      send: async (bytes) => {
        raw.push(bytes)
      },
      close: () => {
        w.closed += 1
      },
    },
    ...o,
  })
  return w
}

const READY = encodeRelayFrame({ type: RELAY_FRAME.ready, connId: 0 })

test('★★★★ drop is not sent without receiving ready (old relays cut the whole agent link / codex round 18, high #1)', async (t) => {
  await boot(t)
  const w = linkWith()
  const stranger = await peer(3, false)
  await w.link.receive(relayFrame(RELAY_FRAME.opened, stranger.connId))
  await w.link.receive(relayFrame(RELAY_FRAME.data, stranger.connId, stranger.h.message))
  await w.link.flush()
  assert.deepEqual(frames(w), [], '⚠️⚠️ sent something without receiving ready')
})

test('★★★★ after receiving ready, numbers whose handshake was refused are closed by the relay', async (t) => {
  await boot(t)
  const w = linkWith()
  await w.link.receive(READY)
  const stranger = await peer(3, false)
  await w.link.receive(relayFrame(RELAY_FRAME.opened, stranger.connId))
  await w.link.receive(relayFrame(RELAY_FRAME.data, stranger.connId, stranger.h.message))
  await w.link.flush()
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(frames(w), [{ type: RELAY_FRAME.drop, connId: stranger.connId }])
})

test('★★★★ a pairing-only connection is closed by the relay when its deadline comes, and not accepted again (codex round 18, high #1)', { timeout: 5000 }, async (t) => {
  await boot(t)
  const w = linkWith({ pairingTtlMs: 30 })
  await w.link.receive(READY)
  // ★ during `npm run pair` (an unused one-time token exists) = handshakes pass even when unregistered
  issueOneTime()
  const stranger = await peer(4, false)
  await w.link.receive(relayFrame(RELAY_FRAME.opened, stranger.connId))
  await w.link.receive(relayFrame(RELAY_FRAME.data, stranger.connId, stranger.h.message))
  const handshake = frames(w)
  assert.equal(handshake.filter((f) => f.type === RELAY_FRAME.data).length, 2, '⚠️ the pairing-only handshake did not pass (this check is idle)')
  await new Promise((r) => setTimeout(r, 60))
  assert.deepEqual(frames(w), [{ type: RELAY_FRAME.drop, connId: stranger.connId }], '⚠️⚠️ it can stay after the deadline')
  assert.equal(w.link.openTunnels, 0, '⚠️ the tunnel remains after the deadline')
  // ⚠️⚠️ do not let the same number retry the handshake (otherwise it could re-handshake at every deadline and stay)
  const again = await startHandshake(await generateDeviceKey(), agentPublicRaw())
  await w.link.receive(relayFrame(RELAY_FRAME.data, stranger.connId, again.message))
  await w.link.flush()
  assert.deepEqual(frames(w), [], '⚠️⚠️ the handshake could be retried on an expired number')
})

test('★★★ connections from registered devices get no deadline', { timeout: 5000 }, async (t) => {
  await boot(t)
  const w = linkWith({ pairingTtlMs: 30 })
  await w.link.receive(READY)
  const p = await peer(5)
  await joinPeer(w, p)
  await new Promise((r) => setTimeout(r, 60))
  assert.deepEqual(frames(w), [], '⚠️⚠️ had the relay close a registered device')
  assert.equal(w.link.openTunnels, 1)
})

test('★★★ if drop arrives from the relay, it is not keeping its promises, so the link is dropped', async (t) => {
  await boot(t)
  const w = linkWith()
  await w.link.receive(encodeRelayFrame({ type: RELAY_FRAME.drop, connId: 1 }))
  assert.equal(w.closed, 1)
})
