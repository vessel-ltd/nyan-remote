// ③ stage 6: the tunnel (agent side / `agent/src/tunnel.ts`).
//
// ★★ **Check with the real things wired together**: real handshake (`shared/crypto.ts`) → real router →
//   real authentication (`serve.ts` → `auth.ts`). ⚠️ Only **the carrier (`TunnelSender`)** is fake.
//   ★ Reason: what is protected here is "there is exactly one path", so faking the path
//     would mean looking at nothing (= false green).
//
// ★★ **Mutations targeted by name** here:
//   ① entering the path without the mark (= authentication does not become `via:'device'` = turns into 403 or dev)
//   ② putting peer values into headers (can claim `tailscale-user-login`)
//   ③ `allowStatic: true` (**the PWA itself goes into envelopes** / 404 becomes html)
//   ④ letting `/hook` `/permission` `/pair/token` through the tunnel (**injecting fake events**)
//   ⑤ revocation does not apply to open subscriptions (`isDeviceConnectionLive` not checked)
//   ⑥ accepting `response` / `event` / `confirm` from the peer
//   ⑦ answering tampered or replayed frames (not returning `fatal`)
//   ⑧ staying silent on a broken request (not returning a `close` with a reason)
//   ⑨ not serializing sends (**sealing order and send order swap** = the peer discards by counter)
//   ⑩ `close` (with a number) does not stop the subscription / without a number does not stop everything
//   ⑪ stalling on a handler that writes no response (= the screen waits forever)
//   ⑫ a tunnel can be opened on a connection that did not pass the handshake

import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  type Session,
} from '../../shared/crypto.ts'
import {
  decodeClose,
  decodeEvent,
  decodeResponse,
  encodeClose,
  encodeRequest,
  type TunnelMethod,
} from '../../shared/tunnel.ts'
import { acceptDeviceHandshake, type DeviceConnection } from './auth.ts'
import { loadConfig } from './config.ts'
import { agentPublicRaw, loadAgentKey, resetAgentKey } from './deviceKey.ts'
import { attach, broadcast, clientCount, notifyFollowers } from './events.ts'
import {
  DEVICES_FILE,
  issueOneTime,
  loadDevices,
  registerDevice,
  resetDevices,
  revokeDevice,
} from './devices.ts'
import { HttpError, Router, readJsonBody } from './router.ts'
import { buildRouter } from './routes/index.ts'
import { openTunnel, tunnelHeaders, type Tunnel } from './tunnel.ts'

/** Swaps the state directory and puts the agent in a "started" state (same steps as deviceAuth.test.ts) */
async function boot(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-tunnel-'))
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
  return dir
}

interface Wired {
  tunnel: Tunnel
  /** The device-side session (real) */
  device: Session
  /** Envelopes the carrier received (★ in the order received) */
  sent: Uint8Array[]
  connection: DeviceConnection
  /** The device's raw public key (used for revocation) */
  raw: Uint8Array
}

/** Opens a tunnel through the real handshake */
async function wire(
  t: { after: (fn: () => Promise<void>) => void },
  router: Router = buildRouter(),
): Promise<Wired> {
  const pair = await generateDeviceKey()
  const raw = await exportPublicKey(pair.publicKey)
  assert.equal((await registerDevice(raw, 'テスト端末', issueOneTime().token)).ok, true)

  const h = await startHandshake(pair, agentPublicRaw())
  const accepted = await acceptDeviceHandshake(h.message)
  const pending = await finishHandshake(h, accepted.reply)
  const device = await pending.accept(accepted.confirm)

  const sent: Uint8Array[] = []
  // ★★ **make the carrier deliberately "slow with varying speed"** (2026-09-08).
  //   ⚠️⚠️ with a fake that `push`es synchronously, **removing serialization does not swap the order**
  //      (`seal` decides the order internally, and they just line up synchronously right after).
  //      ⇒ a real WebSocket sends asynchronously, so **an implementation that does not wait for earlier sends comes out reversed**.
  let nth = 0
  const tunnel = openTunnel({
    connection: accepted.connection,
    router,
    sender: {
      send: async (frame) => {
        // make the first one the slowest (without serialization **later envelopes go out first**)
        const wait = Math.max(0, 5 - nth++)
        await new Promise((r) => setTimeout(r, wait))
        sent.push(frame)
      },
    },
  })
  t.after(async () => {
    await tunnel.close().catch(() => {})
  })
  return { tunnel, device, sent, connection: accepted.connection, raw }
}

/** Sends one request (sealed on the device side and passed to `deliver`) */
async function ask(
  w: Wired,
  r: { id: number; method: TunnelMethod; path: string; body?: Record<string, unknown> },
) {
  const frame = await w.device.seal(FRAME.request, encodeRequest(r))
  return await w.tunnel.deliver(frame)
}

interface Drained {
  responses: { id: number; status: number; body?: unknown }[]
  events: { id: number; event: unknown }[]
  closes: { id?: number; reason?: string }[]
}

/**
 * Opens the envelopes the carrier received on the device side, **in the order received**.
 *
 * ★★ This is the check for ⑨ (serialization) itself: if the order were swapped,
 *    `open` fails with "the counter went back".
 */
async function drain(w: Wired): Promise<Drained> {
  const out: Drained = { responses: [], events: [], closes: [] }
  const frames = w.sent.splice(0, w.sent.length)
  for (const frame of frames) {
    const opened = await w.device.open(frame)
    if (opened.type === FRAME.response) {
      const d = decodeResponse(opened.plaintext)
      assert.ok(d.ok, `cannot read the response: ${!d.ok && d.reason}`)
      out.responses.push(d.value)
    } else if (opened.type === FRAME.event) {
      const d = decodeEvent(opened.plaintext)
      assert.ok(d.ok, `cannot read the event: ${!d.ok && d.reason}`)
      out.events.push(d.value)
    } else if (opened.type === FRAME.close) {
      const d = decodeClose(opened.plaintext)
      assert.ok(d.ok, `cannot read the close: ${!d.ok && d.reason}`)
      out.closes.push(d.value)
    } else {
      assert.fail(`an unknown type arrived: ${opened.type}`)
    }
  }
  return out
}

/** ★ A route for seeing "the values the implementation builds" (returns headers and identity as is) */
function echoRouter(): Router {
  const router = new Router()
  router.get('/echo', (ctx) => ({
    headers: ctx.req.headers,
    url: ctx.req.url,
    via: ctx.identity.via,
    login: ctx.identity.login,
  }))
  router.post('/echo', async (ctx) => ({
    headers: ctx.req.headers,
    body: await readJsonBody<Record<string, unknown>>(ctx.req),
  }))
  // ★ a route that writes no response (reproducing an implementation bug)
  router.get('/silent', () => undefined)
  // ★ a route that throws (★ ordinary errors; `HttpError` is thrown normally for "session ended" etc.)
  router.get('/throw409', () => {
    throw new HttpError(409, 'そのセッションは終了しています')
  })
  router.get('/boom', () => {
    throw new Error('予期しない失敗')
  })
  // ★ stand-in for static serving (tunnels must never fall through to here)
  router.fallback = (ctx) => {
    ctx.res.writeHead(200, { 'content-type': 'text/html' })
    ctx.res.end('<html>PWA 本体</html>')
    return undefined
  }
  return router
}

// ─────────────────────────────────────────────────────────────────────────────

test('★★★★ requests through the tunnel are handled as via:"device"', async (t) => {
  await boot(t)
  const w = await wire(t, echoRouter())

  const res = await ask(w, { id: 1, method: 'GET', path: '/echo?x=1' })
  assert.deepEqual(res, { ok: true })

  const out = await drain(w)
  assert.equal(out.responses.length, 1)
  const r = out.responses[0]!
  assert.equal(r.id, 1)
  assert.equal(r.status, 200)
  const body = r.body as { via: string; login: string; url: string }
  assert.equal(body.via, 'device', '⚠️⚠️ not marked (authentication does not become device)')
  assert.equal(body.login, `device:${w.connection.deviceId}`)
  // ★ the destination is exactly the path sent (the query is kept too)
  assert.equal(body.url, '/echo?x=1')
})

test('★★★★ headers are fixed by the agent (not a single peer value goes in)', async (t) => {
  await boot(t)
  const w = await wire(t, echoRouter())

  await ask(w, { id: 1, method: 'GET', path: '/echo' })
  await ask(w, { id: 2, method: 'POST', path: '/echo', body: { text: 'やあ' } })
  const out = await drain(w)

  const get = (out.responses[0]!.body as { headers: Record<string, string> }).headers
  // ★★ compare with **the values written out** (⚠️ comparing only with `tunnelHeaders()`
  //   **compares the implementation with itself**, so a mutation rewriting the table slips through)
  assert.deepEqual(get, { host: 'tunnel', accept: 'application/json' })
  // ★ then also check that "this table is what the route uses"
  assert.deepEqual(get, tunnelHeaders('GET'))

  const post = out.responses[1]!.body as { headers: Record<string, string>; body: unknown }
  assert.deepEqual(post.headers, {
    host: 'tunnel',
    accept: 'application/json',
    'content-type': 'application/json',
  })
  assert.deepEqual(post.headers, tunnelHeaders('POST'))
  // ★ the body arrives (in a form `readJsonBody` can read)
  assert.deepEqual(post.body, { text: 'やあ' })
})

test('★★★★ headers the peer claims do not get in (even with extra keys mixed in)', async (t) => {
  await boot(t)
  const w = await wire(t, echoRouter())

  // ⚠️ send plaintext with fields not in `encodeRequest` mixed in **by hand** (the shape of a modified PWA)
  const payload = new TextEncoder().encode(
    JSON.stringify({
      v: 1,
      i: 1,
      m: 'GET',
      p: '/echo',
      h: { 'tailscale-user-login': 'me@github', 'x-nyan-remote-token': 'x'.repeat(40) },
      headers: { origin: 'https://evil.example' },
    }),
  )
  await w.tunnel.deliver(await w.device.seal(FRAME.request, payload))
  const out = await drain(w)
  const body = out.responses[0]!.body as { headers: Record<string, string>; via: string }
  assert.deepEqual(body.headers, tunnelHeaders('GET'))
  assert.equal(body.via, 'device')
})

test('★★★★ the tunnel is API only (does not fall through to static serving)', async (t) => {
  await boot(t)
  const w = await wire(t, echoRouter())
  await ask(w, { id: 1, method: 'GET', path: '/どこにも無い' })
  const out = await drain(w)
  assert.equal(out.responses[0]!.status, 404, '⚠️⚠️ the PWA itself went into an envelope (allowStatic)')
  assert.deepEqual(out.responses[0]!.body, { error: 'not found' })
})

// ⚠️⚠️ **Add a timeout** (actually hit on 2026-09-08): with a mutation removing this 403,
//    the `/permission` route **waits for the approval answer** (`timeout: 86400`), so
//    the test does not "fail" but **never returns**.
test('★★★★ /hook /permission /pair/token from a device are 403 (prevents injecting fake events)', { timeout: 5000 }, async (t) => {
  await boot(t)
  const w = await wire(t)
  let id = 1
  for (const path of ['/hook', '/hook/', '/permission', '/pair/token', '/pair//token']) {
    await ask(w, { id: id++, method: 'POST', path, body: {} })
  }
  const out = await drain(w)
  assert.equal(out.responses.length, 5)
  for (const r of out.responses) {
    assert.equal(r.status, 403, `⚠️⚠️ request #${r.id} got through`)
  }
})

test('★★★★ subscriptions (/events) flow in envelopes', async (t) => {
  await boot(t)
  const w = await wire(t)

  assert.deepEqual(await ask(w, { id: 5, method: 'GET', path: '/events' }), { ok: true })
  assert.equal(w.tunnel.openStreams, 1, 'the subscription is not open')

  broadcast({ type: 'sessions-changed', at: '2026-09-08T00:00:00.000Z' })
  // ⚠️ events are sealed asynchronously from inside `write`, so wait for the chain
  await w.tunnel.flush()
  const out = await drain(w)

  // ★ first the "subscription started" response (200)
  assert.deepEqual(out.responses, [{ id: 5, status: 200 }])
  // ★ `attach`'s hello + one broadcast (⚠️ the `retry:` line is dropped)
  const types = out.events.map((e) => (e.event as { type: string }).type)
  assert.deepEqual(types, ['hello', 'sessions-changed'])
  for (const e of out.events) assert.equal(e.id, 5, 'the subscription number is missing')
})

test('★★★★ thread following (/sessions/:id/follow) also flows in envelopes, and only that session\'s notices arrive (2026-09-23)', async (t) => {
  await boot(t)
  const w = await wire(t)
  assert.deepEqual(await ask(w, { id: 7, method: 'GET', path: '/sessions/SID-1/follow' }), { ok: true })
  assert.equal(w.tunnel.openStreams, 1, 'the follow subscription is not open')
  notifyFollowers('OTHER', '2026-09-23T00:00:00.000Z')
  notifyFollowers('SID-1', '2026-09-23T00:00:01.000Z')
  broadcast({ type: 'sessions-changed', at: '2026-09-23T00:00:02.000Z' })
  await w.tunnel.flush()
  const out = await drain(w)
  assert.deepEqual(out.responses, [{ id: 7, status: 200 }])
  const got = out.events.map((e) => e.event as { type: string; sessionId?: string })
  assert.deepEqual(
    got.map((e) => `${e.type}${e.sessionId ? ':' + e.sessionId : ''}`),
    ['hello', 'log-appended:SID-1'],
    '⚠️⚠️ another session\'s notice or a list notice flowed into the follow',
  )
})

test('★★★★ if revoked mid-subscription, it is cut without sending events (continuation of §14.1.2.21)', async (t) => {
  await boot(t)
  const w = await wire(t)
  await ask(w, { id: 9, method: 'GET', path: '/events' })
  await drain(w) // discard the response and hello

  assert.equal((await revokeDevice(toBase64Url(w.raw))).ok, true)
  broadcast({ type: 'sessions-changed', at: '2026-09-08T00:00:00.000Z' })
  await w.tunnel.flush()

  const out = await drain(w)
  assert.deepEqual(out.events, [], '⚠️⚠️ sent events although revoked')
  assert.equal(out.closes.length, 1, 'the close was not reported')
  assert.equal(out.closes[0]!.id, 9)
  assert.match(out.closes[0]!.reason ?? '', /失効/)
  assert.equal(w.tunnel.openStreams, 0, 'a subscription remains')

  // ★ further requests do not pass either (per-request authentication also applies)
  await ask(w, { id: 10, method: 'GET', path: '/health' })
  const after = await drain(w)
  assert.equal(after.responses[0]!.status, 403)
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ 2026-09-15 codex medium #3: **a subscription being processed could be registered after closing**
//
// ⚠️⚠️ `closed` was only checked **once, before `session.open`**, and subscriptions were put into `streams`
//    **after** `handleRequest`. ⇒ if `close()` ran in between it could not be cleaned up,
//    and a later `streams.set()` **left a subscription in `events.ts`** (measured).
// ⇒ **Also when leaving the path**, check "closed, or that number was cut".
// ─────────────────────────────────────────────────────────────────────────────

test('★★★★ if close() runs mid-processing, the subscription is not registered (codex medium #3)', async (t) => {
  await boot(t)
  const w = await wire(t)
  const before = clientCount()

  // ⚠️⚠️ **create the envelope first** (`ask` seals before handing over, so waiting there lets
  //    `close` finish first and **no race can be created** = false green)
  const frame = await w.device.seal(FRAME.request, encodeRequest({ id: 7, method: 'GET', path: '/events' }))
  const inflight = w.tunnel.deliver(frame)
  await w.tunnel.close('やめます')
  await inflight

  assert.equal(w.tunnel.openStreams, 0, '⚠️⚠️ a subscription remains after closing')
  assert.equal(clientCount(), before, '⚠️⚠️ a subscription remains in events.ts (not cleaned up)')
})

test('★★★★ if a close (with a number) arrives mid-processing, that subscription is not registered', async (t) => {
  await boot(t)
  // ★★ make **a route that can be paused mid-path** (⚠️ the real `/events` is too fast;
  //    registration finishes before the close arrives and **no race can be created** = false green)
  let release: (() => void) | undefined
  const gate = new Promise<void>((r) => {
    release = r
  })
  const router = new Router()
  router.get('/events', async (ctx) => {
    await gate
    attach(ctx.res)
    return undefined
  })
  const w = await wire(t, router)
  const before = clientCount()

  // ⚠️ create both envelopes first (waiting in `ask` lets `close` finish first)
  const open = await w.device.seal(FRAME.request, encodeRequest({ id: 8, method: 'GET', path: '/events' }))
  const cancel = await w.device.seal(FRAME.close, encodeClose({ id: 8 }))
  const inflight = w.tunnel.deliver(open)
  // ⚠️ "no longer needed" arrives mid-start (= while the route is paused)
  await w.tunnel.deliver(cancel)
  release!()
  await inflight

  assert.equal(w.tunnel.openStreams, 0, '⚠️⚠️ a subscription remains after cutting it')
  assert.equal(clientCount(), before, '⚠️⚠️ a subscription remains in events.ts')

  // ⚠️ `attach`'s `hello` is queued before the subscription is removed (cannot be undone).
  //    ★ the device side has unsubscribed itself, so it discards events for this number (`relay.ts`).
  await w.tunnel.flush()
  await drain(w)

  // ★★ **not a single** broadcast flows afterwards (this is the point)
  broadcast({ type: 'sessions-changed', at: '2026-09-15T00:00:00.000Z' })
  await w.tunnel.flush()
  assert.deepEqual((await drain(w)).events, [], '⚠️⚠️ events keep flowing after cutting it')
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ 2026-09-15 codex medium #4: **revocation did not apply to events queued for sending**
//
// ⚠️⚠️ The liveness check was only **at enqueue time**, so revoking while the carrier was clogged
//    sent **events not yet even sealed** after the revocation (a gap in invariant 4).
// ⇒ **Also check right before sending (inside the chain)**. ⚠️ "Taking back frames already sent" is another matter.
// ─────────────────────────────────────────────────────────────────────────────

test('★★★ if the subscription is cancelled while sending is clogged, queued events are not sent (codex round 16, low #6)', async (t) => {
  await boot(t)
  const pair = await generateDeviceKey()
  const raw = await exportPublicKey(pair.publicKey)
  assert.equal((await registerDevice(raw, 'x', issueOneTime().token)).ok, true)
  const h = await startHandshake(pair, agentPublicRaw())
  const accepted = await acceptDeviceHandshake(h.message)
  const device = await (await finishHandshake(h, accepted.reply)).accept(accepted.confirm)
  const sent: Uint8Array[] = []
  let open: (() => void) | undefined
  let gate: Promise<void> | undefined
  const tunnel = openTunnel({
    connection: accepted.connection,
    router: buildRouter(),
    sender: {
      send: async (frame) => {
        if (gate) await gate
        sent.push(frame)
      },
    },
  })
  t.after(async () => {
    open?.()
    await tunnel.close().catch(() => {})
  })
  await tunnel.deliver(await device.seal(FRAME.request, encodeRequest({ id: 9, method: 'GET', path: '/events' })))
  await tunnel.flush()
  sent.splice(0, sent.length)
  gate = new Promise<void>((r) => {
    open = r
  })
  broadcast({ type: 'sessions-changed', at: '1' })
  await new Promise((r) => setImmediate(r))
  broadcast({ type: 'sessions-changed', at: '2' })
  broadcast({ type: 'sessions-changed', at: '3' })
  // ★ the peer cancels (⚠️ ② and ③ are only queued)
  await tunnel.deliver(await device.seal(FRAME.close, encodeClose({ id: 9 })))
  open!()
  await tunnel.flush()
  const ats: string[] = []
  for (const frame of sent) {
    const o = await device.open(frame)
    if (o.type === FRAME.event) {
      const d = decodeEvent(o.plaintext)
      assert.ok(d.ok)
      ats.push((d.value.event as { at: string }).at)
    }
  }
  assert.deepEqual(ats, ['1'], `⚠️ sent events that were queued after cancelling: ${ats.join(',')}`)
})

test('★★★★ if revoked while sending is clogged, queued events are not sent (codex medium #4)', async (t) => {
  await boot(t)
  const pair = await generateDeviceKey()
  const raw = await exportPublicKey(pair.publicKey)
  assert.equal((await registerDevice(raw, 'x', issueOneTime().token)).ok, true)
  const h = await startHandshake(pair, agentPublicRaw())
  const accepted = await acceptDeviceHandshake(h.message)
  const device = await (await finishHandshake(h, accepted.reply)).accept(accepted.confirm)

  // ★ make the carrier stoppable with a "gate" (the shape of real backpressure)
  const sent: Uint8Array[] = []
  let open: (() => void) | undefined
  let gate: Promise<void> | undefined
  const tunnel = openTunnel({
    connection: accepted.connection,
    router: buildRouter(),
    sender: {
      send: async (frame) => {
        if (gate) await gate
        sent.push(frame)
      },
    },
  })
  t.after(async () => {
    open?.()
    await tunnel.close().catch(() => {})
  })

  await tunnel.deliver(await device.seal(FRAME.request, encodeRequest({ id: 9, method: 'GET', path: '/events' })))
  await tunnel.flush()
  sent.splice(0, sent.length) // discard the response and hello

  // ★ close the gate ⇒ sends from here on are clogged
  gate = new Promise<void>((r) => {
    open = r
  })
  // ① is sealed and stops where it is handed to the carrier (⚠️ what was handed over cannot be taken back)
  broadcast({ type: 'sessions-changed', at: '2026-09-15T00:00:01.000Z' })
  await new Promise((r) => setImmediate(r))
  // ② and ③ are **only queued** behind it (not even sealed yet)
  //   ★ two are queued to also check that "the close is sent **only once**" (not once per queued item)
  broadcast({ type: 'sessions-changed', at: '2026-09-15T00:00:02.000Z' })
  broadcast({ type: 'sessions-changed', at: '2026-09-15T00:00:03.000Z' })

  assert.equal((await revokeDevice(toBase64Url(raw))).ok, true)
  open!()
  await tunnel.flush()

  // ★ check on the device side what went out (**the envelopes the implementation actually built**)
  const events: string[] = []
  let closes = 0
  for (const frame of sent) {
    const opened = await device.open(frame)
    if (opened.type === FRAME.event) {
      const d = decodeEvent(opened.plaintext)
      assert.ok(d.ok)
      events.push((d.value.event as { at: string }).at)
    } else if (opened.type === FRAME.close) {
      closes += 1
    }
  }
  // ⚠️⚠️ if ② went out, "revocation did not apply to the queued ones"
  assert.deepEqual(
    events,
    ['2026-09-15T00:00:01.000Z'],
    '⚠️⚠️ queued events were sent after revocation',
  )
  // ⚠️ the close is not sent once per queued item (only once)
  assert.equal(closes, 1, `the close was sent ${closes} times`)
  assert.equal(tunnel.openStreams, 0)
})

test('★★★ close (with a number) stops the subscription', async (t) => {
  await boot(t)
  const w = await wire(t)
  await ask(w, { id: 3, method: 'GET', path: '/events' })
  assert.equal(w.tunnel.openStreams, 1)
  await drain(w)

  const res = await w.tunnel.deliver(await w.device.seal(FRAME.close, encodeClose({ id: 3 })))
  assert.deepEqual(res, { ok: true })
  assert.equal(w.tunnel.openStreams, 0)

  // ★ broadcasts after stopping do not flow
  broadcast({ type: 'sessions-changed', at: '2026-09-08T00:00:00.000Z' })
  await w.tunnel.flush()
  assert.deepEqual((await drain(w)).events, [])
})

test('★★★ close (without a number) closes the whole tunnel', async (t) => {
  await boot(t)
  const w = await wire(t)
  await ask(w, { id: 3, method: 'GET', path: '/events' })
  await drain(w)

  await w.tunnel.deliver(await w.device.seal(FRAME.close, encodeClose({ reason: 'やめます' })))
  assert.equal(w.tunnel.openStreams, 0)
  // ⚠️ nothing is accepted after closing
  const res = await ask(w, { id: 4, method: 'GET', path: '/health' })
  assert.equal(res.ok, false)
  assert.ok(!res.ok && res.fatal)
})

test('★★★★ heartbeats are not put into envelopes (the relay\'s DO could not hibernate)', async (t) => {
  await boot(t)
  const w = await wire(t)
  await ask(w, { id: 3, method: 'GET', path: '/events' })
  await w.tunnel.flush()
  await drain(w) // discard the response and hello

  // ⚠️⚠️ sending these every 5 seconds makes **an always-awake DO** (§14.1.2.28)
  broadcast({ type: 'heartbeat', n: 1, at: '2026-09-15T00:00:00.000Z' })
  await w.tunnel.flush()
  assert.deepEqual(w.sent, [], '⚠️⚠️ sent a heartbeat through the tunnel')

  // ★ other events flow as before (= distinguishable from a "stop everything" mutation)
  broadcast({ type: 'sessions-changed', at: '2026-09-15T00:00:01.000Z' })
  await w.tunnel.flush()
  const out = await drain(w)
  assert.deepEqual(
    out.events.map((e) => (e.event as { type: string }).type),
    ['sessions-changed'],
  )
  // ★ the subscription stays alive (⚠️ distinguishes it from a "stop and discard" fix)
  assert.equal(w.tunnel.openStreams, 1)
})

test('★★★★ abandon() stops subscriptions but **sends nothing**', async (t) => {
  await boot(t)
  const w = await wire(t)
  await ask(w, { id: 3, method: 'GET', path: '/events' })
  assert.equal(w.tunnel.openStreams, 1)
  await drain(w)

  // ⚠️⚠️ used when "the peer is already gone" (the relay **reuses connection numbers**, so
  //    envelopes addressed to a departed peer reach **the next phone** = an unrelated device breaks)
  w.tunnel.abandon()
  assert.equal(w.tunnel.openStreams, 0, 'a subscription remains')
  assert.equal(clientCount(), 0, 'a subscription remains in events.ts')
  await w.tunnel.flush()
  assert.deepEqual(w.sent, [], '⚠️⚠️ sent an envelope to a number with no peer')

  broadcast({ type: 'sessions-changed', at: '2026-09-15T00:00:00.000Z' })
  await w.tunnel.flush()
  assert.deepEqual(w.sent, [], '⚠️ events keep flowing after abandoning')
})

test('★★★★ tampered or replayed frames are fatal (not answered)', async (t) => {
  await boot(t)
  const w = await wire(t)

  const frame = await w.device.seal(FRAME.request, encodeRequest({ id: 1, method: 'GET', path: '/health' }))
  const tampered = new Uint8Array(frame)
  tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 0x01
  const bad = await w.tunnel.deliver(tampered)
  assert.equal(bad.ok, false)
  assert.ok(!bad.ok && bad.fatal, '⚠️⚠️ a tampered frame is not fatal')
  assert.deepEqual(await drain(w), { responses: [], events: [], closes: [] }, '⚠️ answered it')

  // ★ the genuine one passes (= the refusal above is not "always refuse")
  assert.deepEqual(await w.tunnel.deliver(frame), { ok: true })
  assert.equal((await drain(w)).responses.length, 1)
  // ⚠️ the same envelope again (a replay) does not pass
  const replay = await w.tunnel.deliver(frame)
  assert.equal(replay.ok, false)
  assert.ok(!replay.ok && replay.fatal)
})

test('★★★★ only request and close may come from the peer', async (t) => {
  await boot(t)
  const w = await wire(t, echoRouter())
  // ⚠️⚠️ **make the content a correct request** (broken content also fails in decode, so
  //    it could not be told apart from a "does not look at the type" mutation = false green)
  const payload = encodeRequest({ id: 1, method: 'GET', path: '/echo' })
  for (const type of [FRAME.confirm, FRAME.response, FRAME.event] as const) {
    const res = await w.tunnel.deliver(await w.device.seal(type, payload))
    assert.equal(res.ok, false, `accepted type ${type}`)
    assert.ok(!res.ok && res.fatal)
    // ★ **it was not executed** (not a single response went out)
    assert.deepEqual(await drain(w), { responses: [], events: [], closes: [] }, 'executed it as a request')
  }
  // ★ the same content sent as `request` passes (= the refusal above is not "always refuse")
  assert.deepEqual(await w.tunnel.deliver(await w.device.seal(FRAME.request, payload)), { ok: true })
  assert.equal((await drain(w)).responses.length, 1)
})

test('★★★ a broken request is closed with a reason (not silent)', async (t) => {
  await boot(t)
  const w = await wire(t)
  // ⚠️ broken down to the number, so **there is nowhere to answer** ⇒ the whole tunnel (close without a number)
  const frame = await w.device.seal(FRAME.request, new TextEncoder().encode('{"v":1,"m":"GET","p":"/health"}'))
  const res = await w.tunnel.deliver(frame)
  assert.equal(res.ok, false)
  assert.ok(!res.ok && res.fatal)
  const out = await drain(w)
  assert.deepEqual(out.responses, [])
  assert.equal(out.closes.length, 1, 'no reason returned')
  assert.equal(out.closes[0]!.id, undefined)
  assert.match(out.closes[0]!.reason ?? '', /番号/)
})

test('★★★★ send order is sealing order (the peer does not discard by counter)', async (t) => {
  await boot(t)
  const w = await wire(t, echoRouter())

  // ★ send 5 **simultaneously** (without serialization, the send order swaps)
  const frames = await Promise.all(
    [1, 2, 3, 4, 5].map((id) => w.device.seal(FRAME.request, encodeRequest({ id, method: 'GET', path: '/echo' }))),
  )
  await Promise.all(frames.map((f) => w.tunnel.deliver(f)))

  // ⚠️ `drain` opens in the order received = fails if the counter went back
  const out = await drain(w)
  assert.equal(out.responses.length, 5)
  assert.deepEqual(
    out.responses.map((r) => r.id).sort((a, b) => a - b),
    [1, 2, 3, 4, 5],
  )
})

// ⚠️ **Add a timeout** (a mutation removing this check does not "fail" but **never returns** /
//    the shape hit with the fake IndexedDB on 2026-09-08)
test('★★★ a handler that writes no response ends with 500 (does not keep the screen waiting)', { timeout: 5000 }, async (t) => {
  await boot(t)
  const w = await wire(t, echoRouter())
  const res = await ask(w, { id: 1, method: 'GET', path: '/silent' })
  assert.deepEqual(res, { ok: true })
  const out = await drain(w)
  assert.equal(out.responses[0]!.status, 500)
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ 2026-09-15 codex medium #1: **exceptions did not become responses in the tunnel**
//
// ⚠️⚠️ Converting `HttpError` into a response was left in the `.catch()` of `index.ts`, so
//    on the tunnel side, which goes through the path (`serve.ts`), **`deliver` itself rejected**.
//    = the contract I wrote, "`deliver` never throws on the peer's input", was broken.
//    ★ Even **malformed percent-encoding** such as `/sessions/%/log` made the router's
//      `decodeURIComponent` throw, so it could be triggered **by the peer's input alone**.
// ⇒ **Turning exceptions into responses became the path's (`serve.ts`) job** (same for HTTP and tunnels).
// ─────────────────────────────────────────────────────────────────────────────

test('★★★★ handler exceptions become responses (deliver does not throw / codex medium #1)', async (t) => {
  await boot(t)
  const w = await wire(t, echoRouter())

  assert.deepEqual(await ask(w, { id: 1, method: 'GET', path: '/throw409' }), { ok: true })
  assert.deepEqual(await ask(w, { id: 2, method: 'GET', path: '/boom' }), { ok: true })

  const out = await drain(w)
  assert.equal(out.responses[0]!.status, 409, '⚠️⚠️ HttpError did not become a response')
  assert.deepEqual(out.responses[0]!.body, { error: 'そのセッションは終了しています' })
  // ⚠️ unexpected exceptions give only the classification (the contents are not sent out as is / CLAUDE.md §2)
  assert.equal(out.responses[1]!.status, 500)
  assert.deepEqual(out.responses[1]!.body, { error: 'internal error' })
})

test('★★★★ deliver does not throw even on malformed percent-encoding (does not crash on peer input)', async (t) => {
  await boot(t)
  const w = await wire(t)
  // ⚠️ `decodeURIComponent('%')` throws URIError
  const res = await ask(w, { id: 1, method: 'GET', path: '/sessions/%/log' })
  assert.deepEqual(res, { ok: true }, '⚠️⚠️ deliver threw on the peer\'s input')
  const out = await drain(w)
  // ★ no such session exists, so 404 (= neither 500 nor an exception)
  assert.equal(out.responses[0]!.status, 404)
})

test('★★★ deliver does not throw even if the carrier fails to send (returns a result)', async (t) => {
  await boot(t)
  const pair = await generateDeviceKey()
  const raw = await exportPublicKey(pair.publicKey)
  assert.equal((await registerDevice(raw, 'x', issueOneTime().token)).ok, true)
  const h = await startHandshake(pair, agentPublicRaw())
  const accepted = await acceptDeviceHandshake(h.message)
  const device = await (await finishHandshake(h, accepted.reply)).accept(accepted.confirm)

  const tunnel = openTunnel({
    connection: accepted.connection,
    router: buildRouter(),
    sender: {
      send: () => {
        throw new Error('ソケットが切れています')
      },
    },
  })
  const frame = await device.seal(FRAME.request, encodeRequest({ id: 1, method: 'GET', path: '/health' }))
  const res = await tunnel.deliver(frame)
  assert.equal(res.ok, false, '⚠️⚠️ deliver threw on a send failure')
  assert.ok(!res.ok && res.fatal, 'if it cannot send, the carrier should close')
})

test('★★★★ a tunnel cannot be opened on a connection that did not pass the handshake', async (t) => {
  await boot(t)
  const w = await wire(t)
  const forged: DeviceConnection = {
    session: w.connection.session,
    deviceId: w.connection.deviceId,
  }
  assert.throws(
    () => openTunnel({ connection: forged, router: buildRouter(), sender: { send: () => {} } }),
    /握手/,
  )

  // ★ cannot be opened on a revoked connection either
  assert.equal((await revokeDevice(toBase64Url(w.raw))).ok, true)
  assert.throws(
    () => openTunnel({ connection: w.connection, router: buildRouter(), sender: { send: () => {} } }),
    /失効|握手/,
  )
})

test('★★★ a broken config gives 503 in the tunnel too (the gate is not bypassed)', async (t) => {
  const dir = await boot(t)
  const w = await wire(t)
  await writeFile(join(dir, 'config.json'), '{ 壊れた', 'utf8')
  await loadConfig()

  await ask(w, { id: 1, method: 'GET', path: '/health' })
  const out = await drain(w)
  assert.equal(out.responses[0]!.status, 503)
})

test('★★★ if the records are broken, tunnel requests are refused too (fail-closed)', async (t) => {
  const dir = await boot(t)
  const w = await wire(t)
  await writeFile(join(dir, DEVICES_FILE), '{ "v": 1, "devices": "壊れた値" }', 'utf8')
  resetDevices()
  await loadDevices()

  await ask(w, { id: 1, method: 'GET', path: '/health' })
  const out = await drain(w)
  assert.equal(out.responses[0]!.status, 403)
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ ③ stage 7: **a pairing-only tunnel is "one-shot"** (ARCHITECTURE §14.1.4)
//
// ⚠️⚠️ **A separate safeguard** from `auth.ts`'s "only one route passes":
//   that one is **what it can do**, this one is **how many times**. Without closing, one connection
//   **can try the one-time token any number of times** (a brute-force window open until timeout).
//   ⇒ Mutations targeted: ⑮ not closing after the response / closing only on success
// ─────────────────────────────────────────────────────────────────────────────

/** ★ Opens a tunnel from a not-yet-registered device while a one-time token exists (= right after reading the QR) */
async function wirePairing(t: { after: (fn: () => Promise<void>) => void }): Promise<Wired> {
  const pair = await generateDeviceKey()
  const raw = await exportPublicKey(pair.publicKey)
  // ⚠️ **do not register**. ⇒ only create the state where a person ran `npm run pair`
  issueOneTime()

  const h = await startHandshake(pair, agentPublicRaw())
  const accepted = await acceptDeviceHandshake(h.message)
  const pending = await finishHandshake(h, accepted.reply)
  const device = await pending.accept(accepted.confirm)

  const sent: Uint8Array[] = []
  const tunnel = openTunnel({
    connection: accepted.connection,
    router: buildRouter(),
    sender: { send: async (frame) => void sent.push(frame) },
  })
  t.after(async () => {
    await tunnel.close().catch(() => {})
  })
  return { tunnel, device, sent, connection: accepted.connection, raw }
}

test('★★★★ a pairing connection closes after returning one response (⑮ no repeated one-time attempts)', async (t) => {
  await boot(t)
  const w = await wirePairing(t)

  // ① the first attempt (⚠️ **deliberately made to fail**: kills an implementation that closes only on success)
  const first = await ask(w, { id: 1, method: 'POST', path: '/pair', body: { key: 'x', token: 'x' } })
  assert.equal(first.ok, true)
  await w.tunnel.flush()
  const got = await drain(w)
  assert.equal(got.responses.length, 1, 'one response was not returned')
  // ★ the close reaches the peer (a `close` envelope)
  assert.equal(got.closes.length, 1, '⚠️⚠️ the pairing connection was not closed')

  // ② the second attempt is not accepted (= no brute-force window)
  const second = await ask(w, { id: 2, method: 'POST', path: '/pair', body: { key: 'x', token: 'y' } })
  assert.equal(second.ok, false, '⚠️⚠️ a tunnel that should be closed accepted a second attempt')
})

test('★★★ registered tunnels are not closed (the flip side of ⑮; ordinary connections are not broken)', async (t) => {
  await boot(t)
  const w = await wire(t)
  await ask(w, { id: 1, method: 'GET', path: '/health' })
  await w.tunnel.flush()
  const got = await drain(w)
  assert.equal(got.responses.length, 1)
  assert.equal(got.closes.length, 0, '⚠️⚠️ ordinary connections are closed too')
  // ★ the second one passes normally too
  const second = await ask(w, { id: 2, method: 'GET', path: '/health' })
  assert.equal(second.ok, true)
})
