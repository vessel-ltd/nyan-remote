// Step 6-③b② of ③: the PWA-side carrier (`web/src/transport/relayCarrier.ts`).
//
// ★★ **Connected end to end** (only "the line" is fake = attaches/removes connection IDs in place of the relay):
//
//   AgentTransport → relayWire → envelope → **relayCarrier** → fake line (relay framing)
//     → **relayLink** (agent side) → openTunnel → serve.ts → auth → **the real router**
//
//   ⇒ `relayE2E.test.ts` "connected two tunnels directly", while this one puts **both carriers**
//     (`relayCarrier.ts` and `relayLink.ts`) in between = it checks **down to the handshake's first message and connection IDs**.
//
// ★★ **Mutations killed by name** here:
//   ① don't send the first (raw) message / process the reply before sending
//   ② drop `reply` and `confirm` (attach the receiver later / don't serialize)
//   ③ no handshake timeout (**if the agent goes silent the screen waits forever**)
//   ④ don't call `wire.fail` when the line drops (pending requests wait 10s **without a reason**)
//   ⑤ don't close the line on a broken envelope
//   ⑥ start the handshake with an unreadable agent public key (= sends garbage on the line)
//   ⑦ process envelopes arriving after it's over (= touches a dropped line)

import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { exportPublicKey, generateDeviceKey, toBase64Url } from '../../../shared/crypto.ts'
import { isUnreachable } from './unreachable.ts'
import {
  RELAY_FRAME,
  decodeRelayFrame,
  encodeRelayFrame,
} from '../../../shared/relayFrame.ts'
import { loadConfig } from '../../../agent/src/config.ts'
import { agentPublicRaw, loadAgentKey, resetAgentKey } from '../../../agent/src/deviceKey.ts'
import { issueOneTime, loadDevices, registerDevice, resetDevices } from '../../../agent/src/devices.ts'
import { broadcast } from '../../../agent/src/events.ts'
import { openRelayLink, type RelayLink } from '../../../agent/src/relayLink.ts'
import { buildRouter } from '../../../agent/src/routes/index.ts'
import { AgentTransport } from './agent.ts'
import type { RelayWire } from './relay.ts'
import {
  connectRelayCarrier,
  openRelayCarrier,
  type CarrierLine,
  type CarrierSocket,
  type RelayCarrier,
} from './relayCarrier.ts'

/** Swap the state directory and put the agent into a "started" state (same procedure as relayE2E.test.ts) */
async function boot(t: { after: (fn: () => Promise<void>) => void }): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-carrier-'))
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

const CONN_ID = 1

interface Rig {
  carrier: RelayCarrier
  link: RelayLink
  /** ★ Wait until the handshake completes (⚠️ failures throw with a reason) */
  ready: Promise<{ transport: AgentTransport; settle: () => Promise<void> }>
  /** ⚠️ Setting this true makes phone → agent envelopes **stop arriving** (reproduces a stall) */
  stalled: boolean
  /** Number of times the line was closed */
  closed: number
  /** ⚠️ Corrupt one agent → phone envelope (reproduces tampering) */
  tamperNext: boolean
  /** ⚠️ Corrupt one phone → agent envelope (★ makes the agent side issue "close the whole tunnel") */
  tamperUp: boolean
}

/**
 * Fake relay (★ **only attaches/removes connection IDs**).
 *
 * ⚠️ Same as what the real relay (`relay/src/worker.ts`) does: the phone side is raw,
 *    the agent side is `[version][kind][ID][payload]`.
 */
function rig(agentPublicKey: string, identity: Awaited<ReturnType<typeof generateDeviceKey>>): Rig {
  const r = { stalled: false, closed: 0, tamperNext: false, tamperUp: false } as Rig

  r.link = openRelayLink({
    router: buildRouter(),
    socket: {
      // agent → relay → phone (★ strip the ID)
      send: (bytes) => {
        const d = decodeRelayFrame(bytes)
        assert.ok(d.ok, `⚠️ the agent emitted an unreadable envelope: ${!d.ok ? d.reason : ''}`)
        assert.equal(d.value.type, RELAY_FRAME.data)
        assert.equal(d.value.connId, CONN_ID)
        const payload = new Uint8Array(d.value.payload as Uint8Array)
        if (r.tamperNext) {
          r.tamperNext = false
          payload[payload.length - 1] = (payload[payload.length - 1] ?? 0) ^ 0xff
        }
        r.carrier.receive(payload)
      },
      close: () => undefined,
    },
  })

  const socket: CarrierSocket = {
    // phone → relay → agent (★ attach the ID)
    send: (bytes) => {
      if (r.stalled) return
      const payload = new Uint8Array(bytes)
      if (r.tamperUp) {
        r.tamperUp = false
        payload[payload.length - 1] = (payload[payload.length - 1] ?? 0) ^ 0xff
      }
      void r.link.receive(
        encodeRelayFrame({ type: RELAY_FRAME.data, connId: CONN_ID, payload }),
      )
    },
    close: () => {
      r.closed += 1
      void r.link.receive(encodeRelayFrame({ type: RELAY_FRAME.closed, connId: CONN_ID }))
    },
  }

  // ★ The relay first tells the agent "a phone arrived"
  void r.link.receive(encodeRelayFrame({ type: RELAY_FRAME.opened, connId: CONN_ID }))
  r.carrier = openRelayCarrier({ socket, identity, agentPublicKey, timeoutMs: 300 })
  r.ready = r.carrier.ready.then((wire) => ({
    transport: new AgentTransport({ id: 'relay', label: 'relay', url: 'relay://tunnel' }, wire),
    /**
     * ★★ Wait until the chains in both directions are empty.
     *
     * ⚠️⚠️ **Order matters** (actually hit here): "phone sends → agent processes and sends →
     *    phone receives". Waiting in reverse means `broadcast`ing while **the subscription request hasn't arrived yet**,
     *    misdiagnosing "no events come" (= produces both false reds and false greens).
     * ★ The real thing is `RelayWire` (`ready` returns the narrow `Wire` = `deliver` isn't exposed to screens).
     */
    settle: async (): Promise<void> => {
      for (let i = 0; i < 2; i++) {
        await (wire as RelayWire).flush()
        await r.link.flush()
        await r.carrier.flush()
      }
    },
  }))
  return r
}

/** Build one registered device */
async function joined(t: { after: (fn: () => Promise<void>) => void }, register = true) {
  const identity = await generateDeviceKey()
  const raw = await exportPublicKey(identity.publicKey)
  if (register) {
    assert.equal((await registerDevice(raw, 'テスト端末', issueOneTime().token)).ok, true)
  }
  const r = rig(toBase64Url(agentPublicRaw()), identity)
  t.after(async () => {
    r.carrier.close('テスト終了')
  })
  return r
}

test('★★ raw first message → envelope → real router (end to end through both carriers)', { timeout: 5000 }, async (t) => {
  await boot(t)
  const r = await joined(t)
  const { transport } = await r.ready
  assert.equal(r.link.openTunnels, 1, 'no tunnel opened on the agent side')

  // ★ `/health` is the value the agent actually built
  const health = await transport.health()
  assert.equal(health.machine, hostname())
  assert.equal(health.agentPublicKey, toBase64Url(agentPublicRaw()))

  const page = await transport.listSessions({ history: false })
  assert.equal(page.machine, hostname())
})

test('★★ subscriptions pass too (the agent\'s broadcast reaches the screen)', { timeout: 5000 }, async (t) => {
  await boot(t)
  const r = await joined(t)
  const { transport, settle } = await r.ready

  const seen: string[] = []
  const stop = transport.subscribe((e) => seen.push(e.type))
  await settle()
  broadcast({ type: 'sessions-changed', at: '2026-09-15T00:00:00.000Z' })
  await settle()
  assert.deepEqual(seen, ['hello', 'sessions-changed'])

  stop()
  await settle()
  broadcast({ type: 'sessions-changed', at: '2026-09-15T00:00:01.000Z' })
  await settle()
  assert.deepEqual(seen, ['hello', 'sessions-changed'], '⚠️ still flowing after unsubscribing')
})

test('★★ if the agent stays silent, the handshake times out **with a reason** (③)', { timeout: 5000 }, async (t) => {
  await boot(t)
  const identity = await generateDeviceKey()
  let sent = 0
  const carrier = openRelayCarrier({
    socket: {
      send: () => {
        sent += 1
      },
      close: () => undefined,
    },
    identity,
    agentPublicKey: toBase64Url(agentPublicRaw()),
    timeoutMs: 80,
  })
  await assert.rejects(carrier.ready, /時間切れ/)
  // ★ The first message went out (= the silence is on the peer's side)
  assert.equal(sent, 1, 'the first (raw) message was not sent')
})

test('★★ an unregistered device fails the handshake (the agent returns nothing = timeout)', { timeout: 5000 }, async (t) => {
  await boot(t)
  const r = await joined(t, false)
  await assert.rejects(r.ready, /時間切れ/)
  assert.equal(r.link.openTunnels, 0, '⚠️⚠️ a tunnel opened for an unregistered device')
})

test('★★ when the line drops, pending requests end **with a reason** (④)', { timeout: 5000 }, async (t) => {
  await boot(t)
  const r = await joined(t)
  const { transport } = await r.ready

  // ⚠️ From here on envelopes don't arrive (reproduces a stuck line)
  r.stalled = true
  const pending = transport.health()
  r.carrier.down('relay の線が切れました（テスト）')
  // ★★ It must end with **that reason**, not a timeout (10s)
  await assert.rejects(pending, /relay の線が切れました/)

  // ⚠️ Requests after the drop also return the reason without waiting
  await assert.rejects(transport.health(), /relay の線が切れました/)
})

test('★★ a broken envelope closes the whole line (⑤)', { timeout: 5000 }, async (t) => {
  await boot(t)
  const r = await joined(t)
  const { transport } = await r.ready

  r.tamperNext = true
  await assert.rejects(transport.health(), /(改竄|再送|カウンタ|復号|operation-specific)/i)
  assert.equal(r.closed >= 1, true, '⚠️⚠️ left the line open after a broken envelope')
  // ★ The close also reaches the agent side (= that tunnel is cleaned up)
  await r.link.flush()
  assert.equal(r.link.openTunnels, 0, '⚠️ a tunnel remains on the agent side')
})

test('★★ envelopes arriving after it\'s over are no longer touched (⑦)', { timeout: 5000 }, async (t) => {
  await boot(t)
  const r = await joined(t)
  const { transport, settle } = await r.ready
  const seen: string[] = []
  transport.subscribe((e) => seen.push(e.type))
  await settle()
  assert.deepEqual(seen, ['hello'])

  // ★ The line dropped (⚠️ we didn't close it = the agent still sends events)
  r.carrier.down('テストで落とした')
  const closedBefore = r.closed
  broadcast({ type: 'sessions-changed', at: '2026-09-15T00:00:00.000Z' })
  await r.link.flush()
  await r.carrier.flush()

  assert.deepEqual(seen, ['hello'], '⚠️ events after the drop reached the screen')
  // ⚠️⚠️ Don't touch a finished line (touching it means "close again" = making a dropped line do work)
  assert.equal(r.closed, closedBefore, '⚠️⚠️ closed the line again after it was over')
})

test('★★ when the agent says "close the whole tunnel", the line closes too and can reconnect (medium #6)', { timeout: 5000 }, async (t) => {
  await boot(t)
  const r = await joined(t)
  const { transport } = await r.ready
  const closedBefore = r.closed

  // ⚠️ Corrupt one upstream envelope ⇒ the agent decides it "can't answer" and **closes with the reason in an envelope**
  r.tamperUp = true
  await assert.rejects(transport.health())
  await r.link.flush()
  await r.carrier.flush()

  // ⚠️⚠️ The point: `deliver` "handled it correctly" and returns `{ok:true}`.
  //    Even so, **not closing the line** leaves the route dead and the line open = it never reconnects.
  assert.ok(r.closed > closedBefore, '⚠️⚠️ the tunnel was closed but the line is still open')
})

test('★★ when a request times out, the line closes too (don\'t keep using a half-dead line / codex round 17, medium #2)', { timeout: 5000 }, async (t) => {
  await boot(t)
  const r = await joined(t)
  const { transport } = await r.ready
  const closedBefore = r.closed
  // ⚠️ Upstream silently drops without a disconnect notice (TCP half-dead)
  r.stalled = true
  await assert.rejects(transport.health(), /時間切れ/)
  assert.ok(r.closed > closedBefore, '⚠️⚠️ the dead line stays open after the timeout (never reconnects)')
})

test('★★ with an unreadable agent public key, not one byte goes on the line (⑥)', { timeout: 5000 }, async (t) => {
  await boot(t)
  const identity = await generateDeviceKey()
  const sent: Uint8Array[] = []
  const carrier = openRelayCarrier({
    socket: { send: (b) => sent.push(b), close: () => undefined },
    identity,
    agentPublicKey: 'これは鍵ではありません',
    timeoutMs: 300,
  })
  await assert.rejects(carrier.ready, /握手を始められません/)
  assert.deepEqual(sent, [], '⚠️⚠️ sent garbage on the line with an unreadable key')
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ **Wiring of the real line** (`connectRelayCarrier`). 2026-09-15 / codex round 4.
//
// ⚠️⚠️ Since this wasn't checked, the following two were only found by smoke:
//   ⑧ **not closing** lines that failed the handshake (= eating the 8 slots ourselves / medium #5)
//   ⑨ buffer what's sent before open / emit the heartbeat (ping) / drop text
// ─────────────────────────────────────────────────────────────────────────────

interface FakeLine {
  sent: (Uint8Array | string)[]
  closes: number
  emit(type: 'open' | 'message' | 'close' | 'error', ev?: { data?: unknown; code?: number }): void
}

function fakeLine(): { open: (url: string) => CarrierLine; lines: FakeLine[]; urls: string[] } {
  const lines: FakeLine[] = []
  const urls: string[] = []
  const open = (url: string): CarrierLine => {
    urls.push(url)
    const listeners = new Map<string, ((ev: { data?: unknown; code?: number }) => void)[]>()
    const line: FakeLine = {
      sent: [],
      closes: 0,
      emit: (type, ev = {}) => {
        for (const fn of listeners.get(type) ?? []) fn(ev)
      },
    }
    lines.push(line)
    return {
      send: (data) => line.sent.push(data),
      close: () => {
        line.closes += 1
        line.emit('close', { code: 1000 })
      },
      addEventListener: (type, listener) => {
        const list = listeners.get(type) ?? []
        list.push(listener)
        listeners.set(type, list)
      },
    }
  }
  return { open, lines, urls }
}

test('★★ lines that failed the handshake are closed (⑧ don\'t eat the 8 slots ourselves)', { timeout: 5000 }, async (t) => {
  await boot(t)
  const identity = await generateDeviceKey()
  const f = fakeLine()
  const opened = connectRelayCarrier({
    base: 'ws://relay.test',
    agentPublicKey: toBase64Url(agentPublicRaw()),
    identity,
    timeoutMs: 60,
    pingMs: 10,
    openLine: f.open,
  })
  // ★ The line opened, but the peer returns nothing
  f.lines[0]!.emit('open')
  await assert.rejects(opened, /時間切れ/)
  assert.equal(f.lines[0]!.closes, 1, '⚠️⚠️ a line that failed the handshake is still open')
})

test('★★ a line refused before it opens (the PC is off) is "unreachable"; a handshake that times out is not (2026-09-26)', { timeout: 5000 }, async (t) => {
  await boot(t)
  const identity = await generateDeviceKey()
  const f = fakeLine()
  const refused = connectRelayCarrier({ base: 'ws://relay.test', agentPublicKey: toBase64Url(agentPublicRaw()), identity, timeoutMs: 300, pingMs: 10, openLine: f.open })
  // ★ The relay refuses the upgrade (503 when the agent is not connected): the browser only fires `error` then `close`
  f.lines[0]!.emit('error')
  f.lines[0]!.emit('close', { code: 1006 })
  await assert.rejects(refused, (e) => isUnreachable(e), 'an off PC must show as offline, not as a red error')
  // ⚠️ A handshake that never finishes reached the relay (e.g. an unregistered phone) ⇒ stays an error
  const g = fakeLine()
  const silent = connectRelayCarrier({ base: 'ws://relay.test', agentPublicKey: toBase64Url(agentPublicRaw()), identity, timeoutMs: 60, pingMs: 10, openLine: g.open })
  g.lines[0]!.emit('open')
  await assert.rejects(silent, (e) => !isUnreachable(e))
})

test('★★ sends before open are buffered and flushed on open; the heartbeat is emitted too (⑨)', { timeout: 5000 }, async (t) => {
  await boot(t)
  const identity = await generateDeviceKey()
  const f = fakeLine()
  const opened = connectRelayCarrier({
    base: 'ws://relay.test',
    agentPublicKey: toBase64Url(agentPublicRaw()),
    identity,
    timeoutMs: 300,
    pingMs: 10,
    openLine: f.open,
  })
  // ⚠️ The URL is built by `relayUrl` (side is device)
  assert.match(f.urls[0] ?? '', /\/v1\/device\?a=/)
  // ★ The first message may be ready "before open" ⇒ it's only buffered
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(f.lines[0]!.sent, [], '⚠️ sent before open')

  f.lines[0]!.emit('open')
  await new Promise((r) => setTimeout(r, 40))
  // ★ The handshake's first message (bytes) + heartbeat (text) went out
  assert.equal(typeof f.lines[0]!.sent[0], 'object', 'the first (raw) message did not go out')
  assert.ok(
    f.lines[0]!.sent.some((x) => typeof x === 'string'),
    '⚠️ no heartbeat (ping) = the line gets cut silently',
  )

  // ⚠️ Text (pong) isn't treated as an envelope (= the handshake doesn't break)
  f.lines[0]!.emit('message', { data: 'nyan-pong' })
  await assert.rejects(opened, /時間切れ/)
})
