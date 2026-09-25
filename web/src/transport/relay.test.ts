// Step 6 route of ③ (`relay.ts`) — the PWA-side tunnel.
//
// ★★ **Uses real crypto** (both sides of a `Session` made by the handshake in `shared/crypto.ts`).
//   ⚠️ Only **the carrier** is fake (the real WebSocket is connected in step 6-③).
//   ★ The end-to-end check against the real agent side (`agent/src/tunnel.ts`) is
//     "PWA ↔ agent" in `agent/src/tunnel.test.ts`.
//
// ★★ **Mutations killed by name** here:
//   ① don't match IDs (a response hits another request)
//   ② reuse IDs (a late response hits the next request)
//   ③ don't serialize sending (**sealing order and sending order swap** = the agent drops by counter)
//   ④ no timeout (without a response **the screen waits forever**)
//   ⑤ drop the disconnect reason (**it turns into a timeout** and "why it dropped" isn't shown)
//   ⑥ continue after a tampered envelope (no `fail`)
//   ⑦ don't send `close` on unsubscribe (**events keep flowing**)
//   ⑧ accept the agent-side kind (`request`)
//   ⑨ throw on a broken response (breaks the carrier's `onmessage`)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  FRAME,
  acceptHandshake,
  exportPublicKey,
  finishHandshake,
  generateDeviceKey,
  startHandshake,
  type Session,
} from '../../../shared/crypto.ts'
import {
  decodeClose,
  decodeRequest,
  encodeClose,
  encodeEvent,
  encodeResponse,
  type TunnelRequest,
} from '../../../shared/tunnel.ts'
import type { AgentEvent } from '../../../shared/types.ts'
import { relayWire, type RelayWire } from './relay.ts'

interface Linked {
  wire: RelayWire
  /** agent-side session (real) */
  agent: Session
  /** Envelopes the carrier received (★ in the order received) */
  sent: Uint8Array[]
}

/**
 * Create both sides of a session with a real handshake and open the PWA-side route.
 *
 * ⚠️ `generateDeviceKey()` is also used for the agent's static key (**a non-extractable key** is fine =
 *    `agent/src/agentKey.ts` isn't imported from the PWA / discipline.test.ts).
 */
async function link(opts: { timeoutMs?: number; slowSend?: boolean; gate?: Promise<void> } = {}): Promise<Linked> {
  const agentKey = await generateDeviceKey()
  const deviceKey = await generateDeviceKey()
  const h = await startHandshake(deviceKey, await exportPublicKey(agentKey.publicKey))
  const accepted = await acceptHandshake(agentKey, h.message, () => true)
  const device = await (await finishHandshake(h, accepted.message)).accept(accepted.confirm)

  const sent: Uint8Array[] = []
  let nth = 0
  const wire = relayWire({
    session: device,
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    carrier: {
      send: opts.slowSend
        ? async (frame) => {
            // ★ Make the first slowest (without serialization **later envelopes go out first**)
            await new Promise((r) => setTimeout(r, Math.max(0, 5 - nth++)))
            sent.push(frame)
          }
        : async (frame) => {
            // ★ While the gate is closed sending is stuck (the shape of real backpressure)
            if (opts.gate) await opts.gate
            sent.push(frame)
          },
    },
  })
  return { wire, agent: accepted.session, sent }
}

/** As the agent side, open arriving envelopes **in the order received** */
async function received(l: Linked): Promise<{ requests: TunnelRequest[]; closes: { id?: number }[] }> {
  // ⚠️ Sealing is async, so take them out **after the chain has flowed**
  await l.wire.flush()
  const out: { requests: TunnelRequest[]; closes: { id?: number }[] } = { requests: [], closes: [] }
  for (const frame of l.sent.splice(0, l.sent.length)) {
    const opened = await l.agent.open(frame)
    if (opened.type === FRAME.request) {
      const d = decodeRequest(opened.plaintext)
      assert.ok(d.ok, `request unreadable: ${!d.ok && d.reason}`)
      out.requests.push(d.value)
    } else if (opened.type === FRAME.close) {
      const d = decodeClose(opened.plaintext)
      assert.ok(d.ok, `close unreadable: ${!d.ok && d.reason}`)
      out.closes.push(d.value)
    } else {
      assert.fail(`kind that must not come from the PWA: ${opened.type}`)
    }
  }
  return out
}

/** Return a response / event / close from the agent side */
async function reply(l: Linked, type: number, plaintext: Uint8Array): Promise<void> {
  const frame = await l.agent.seal(type as Parameters<Session['seal']>[0], plaintext)
  const res = await l.wire.deliver(frame)
  assert.deepEqual(res, { ok: true }, `deliver refused: ${JSON.stringify(res)}`)
}

// ─────────────────────────────────────────────────────────────────────────────

test('★★ request → envelope → response round trip (matched by ID)', async () => {
  const l = await link()
  const p = l.wire.request({ method: 'GET', path: '/health' })

  const got = await received(l)
  assert.deepEqual(got.requests, [{ id: 1, method: 'GET', path: '/health' }])

  await reply(l, FRAME.response, encodeResponse({ id: 1, status: 200, body: { machine: 'm' } }))
  assert.deepEqual(await p, { status: 200, body: { machine: 'm' } })
})

test('★★ responses returned out of order are still delivered by ID', async () => {
  const l = await link()
  const a = l.wire.request({ method: 'GET', path: '/a' })
  const b = l.wire.request({ method: 'POST', path: '/b', body: { x: 1 } })
  const got = await received(l)
  assert.deepEqual(got.requests, [
    { id: 1, method: 'GET', path: '/a' },
    { id: 2, method: 'POST', path: '/b', body: { x: 1 } },
  ])

  // ★ Deliberately return in reverse order
  await reply(l, FRAME.response, encodeResponse({ id: 2, status: 201, body: 'B' }))
  await reply(l, FRAME.response, encodeResponse({ id: 1, status: 200, body: 'A' }))
  assert.deepEqual(await a, { status: 200, body: 'A' })
  assert.deepEqual(await b, { status: 201, body: 'B' })
})

test('★★ sending order is sealing order (the agent doesn\'t drop by counter)', async () => {
  // ⚠️⚠️ Make the carrier **deliberately slow with varying speed** (a synchronous fake shows no difference /
  //    the shape we hit on the agent side on 2026-09-08)
  const l = await link({ slowSend: true })
  const ps = [1, 2, 3, 4, 5].map((n) => l.wire.request({ method: 'GET', path: `/p${n}` }))

  // Wait until sending finishes
  await new Promise((r) => setTimeout(r, 60))
  // ⚠️ `received` `open`s in the order received = fails if the order got swapped
  const got = await received(l)
  assert.deepEqual(
    got.requests.map((r) => r.path),
    ['/p1', '/p2', '/p3', '/p4', '/p5'],
  )
  for (const r of got.requests) {
    await reply(l, FRAME.response, encodeResponse({ id: r.id, status: 200, body: r.path }))
  }
  assert.deepEqual(
    (await Promise.all(ps)).map((r) => r.body),
    ['/p1', '/p2', '/p3', '/p4', '/p5'],
  )
})

test('★★ subscription: the follow endpoint (/sessions/:id/follow) is requested at that endpoint (2026-09-23)', async () => {
  // ⚠️⚠️ If it turned into `/events`, following would receive **all list notifications** (including unwatched ones)
  const l = await link()
  l.wire.subscribe(() => undefined, '/sessions/S1/follow')
  const got = await received(l)
  assert.deepEqual(got.requests, [{ id: 1, method: 'GET', path: '/sessions/S1/follow' }])
})

test('★★ subscription: requests /events and events arrive', async () => {
  const l = await link()
  const seen: AgentEvent[] = []
  const stop = l.wire.subscribe((e) => seen.push(e))

  const got = await received(l)
  assert.deepEqual(got.requests, [{ id: 1, method: 'GET', path: '/events' }])

  // ★ The agent may emit events **before** the "subscription started" response (`attach`'s hello)
  await reply(l, FRAME.event, encodeEvent({ id: 1, event: { type: 'hello', machine: 'm', at: 'T' } }))
  await reply(l, FRAME.response, encodeResponse({ id: 1, status: 200 }))
  await reply(l, FRAME.event, encodeEvent({ id: 1, event: { type: 'heartbeat', n: 1, at: 'T' } }))
  assert.deepEqual(seen.map((e) => e.type), ['hello', 'heartbeat'])

  // ★★ Unsubscribing sends close, and later events don't arrive
  stop()
  assert.deepEqual((await received(l)).closes, [{ id: 1 }], 'unsubscribe not told to the agent')
  await reply(l, FRAME.event, encodeEvent({ id: 1, event: { type: 'heartbeat', n: 2, at: 'T' } }))
  assert.equal(seen.length, 2, '⚠️⚠️ events arrived after unsubscribing')
})

test('★★ if the subscription request is refused, that subscription stops', async () => {
  const l = await link()
  const seen: AgentEvent[] = []
  l.wire.subscribe((e) => seen.push(e))
  await received(l)

  await reply(l, FRAME.response, encodeResponse({ id: 1, status: 403, body: { error: 'だめ' } }))
  await reply(l, FRAME.event, encodeEvent({ id: 1, event: { type: 'heartbeat', n: 1, at: 'T' } }))
  assert.deepEqual(seen, [], 'delivering events to a refused subscription')
})

test('★★ close (without ID) fails pending requests "with the reason"', async () => {
  // ⚠️⚠️ Dropping the reason **turns it into a timeout (10s)** and why it dropped isn't shown
  const l = await link()
  const p = l.wire.request({ method: 'GET', path: '/health' })
  await received(l)

  await reply(l, FRAME.close, encodeClose({ reason: 'この端末の登録は失効しています' }))
  await assert.rejects(() => p, /失効/)

  // ★ Requests after disconnection return **immediately** with the same reason (no waiting)
  await assert.rejects(() => l.wire.request({ method: 'GET', path: '/health' }), /失効/)
})

test('★★ close (with ID) ends only that request', async () => {
  const l = await link()
  const a = l.wire.request({ method: 'GET', path: '/a' })
  const b = l.wire.request({ method: 'GET', path: '/b' })
  await received(l)

  await reply(l, FRAME.close, encodeClose({ id: 1, reason: 'やめました' }))
  await assert.rejects(() => a, /やめました/)

  // ★ The other is still alive
  await reply(l, FRAME.response, encodeResponse({ id: 2, status: 200, body: 'B' }))
  assert.deepEqual(await b, { status: 200, body: 'B' })
})

// ⚠️⚠️ **The test side also gets a timeout** (a mutation removing this check doesn't "fail" but
//    **never returns** / the shape we hit with the fake IndexedDB and `/permission` on 2026-09-08)
test('★★ without a response it fails by timeout (never makes the screen wait forever)', { timeout: 5000 }, async () => {
  const l = await link({ timeoutMs: 20 })
  await assert.rejects(() => l.wire.request({ method: 'GET', path: '/health' }), /時間切れ/)
})

test('★★ a tampered envelope refuses everything afterwards (`fail`)', async () => {
  const l = await link()
  const p = l.wire.request({ method: 'GET', path: '/health' })
  await received(l)

  const frame = await l.agent.seal(FRAME.response, encodeResponse({ id: 1, status: 200 }))
  const tampered = new Uint8Array(frame)
  tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 0x01
  const res = await l.wire.deliver(tampered)
  assert.equal(res.ok, false, '⚠️⚠️ accepted a tampered envelope')

  await assert.rejects(() => p, /カウンタ|復号|decrypt|operation/i)
  // ★ Later requests are refused immediately too
  await assert.rejects(() => l.wire.request({ method: 'GET', path: '/health' }))
})

test('★★ kinds that must not come from the agent are refused (without throwing)', async () => {
  const l = await link()
  for (const type of [FRAME.request, FRAME.confirm] as const) {
    const frame = await l.agent.seal(type, encodeResponse({ id: 1, status: 200 }))
    const res = await l.wire.deliver(frame)
    assert.equal(res.ok, false, `accepted kind ${type}`)
  }
})

test('★★ a broken response returns a result without throwing (doesn\'t break the carrier)', async () => {
  const l = await link()
  for (const bad of ['{', 'null', '{"v":1}', '{"v":2,"i":1,"s":200}']) {
    const frame = await l.agent.seal(FRAME.response, new TextEncoder().encode(bad))
    const res = await l.wire.deliver(frame)
    assert.equal(res.ok, false, `accepted ${bad}`)
    assert.ok(!res.ok && res.reason.length > 0)
  }
})

test('★★ IDs are not reused (a late response doesn\'t hit another request)', { timeout: 5000 }, async () => {
  // ⚠️ A timeout discards the whole line (2026-09-24), so here we check with a response arriving again for an already-answered ID
  const l = await link()
  const a = l.wire.request({ method: 'GET', path: '/a' })
  await received(l)
  await reply(l, FRAME.response, encodeResponse({ id: 1, status: 200, body: 'A' }))
  assert.deepEqual(await a, { status: 200, body: 'A' })

  const p = l.wire.request({ method: 'GET', path: '/b' })
  const got = await received(l)
  assert.equal(got.requests[0]?.id, 2, '⚠️⚠️ reusing IDs')

  // ★ The late (duplicate) response for ID 1 is dropped (ID 2 is still waiting)
  await reply(l, FRAME.response, encodeResponse({ id: 1, status: 200, body: 'A2' }))
  await reply(l, FRAME.response, encodeResponse({ id: 2, status: 200, body: 'B' }))
  assert.deepEqual(await p, { status: 200, body: 'B' })
})

test('★★ a timeout discards the whole line (don\'t keep sending to a half-dead line / codex round 17, medium #2)', { timeout: 5000 }, async () => {
  const l = await link({ timeoutMs: 20 })
  l.wire.subscribe(() => undefined)
  await received(l)
  await reply(l, FRAME.response, encodeResponse({ id: 1, status: 200 }))
  assert.equal(l.wire.eventsLive(), true)
  const other = l.wire.request({ method: 'GET', path: '/b' })
  await assert.rejects(() => l.wire.request({ method: 'GET', path: '/a' }), /時間切れ/)
  // ★ Collateral requests say "reset the connection" (⚠️ up to "check before resending")
  await assert.rejects(other, /時間切れ|張り直しました/)
  assert.equal(l.wire.eventsLive(), false, '⚠️⚠️ still says "the signal is alive" after a timeout')
  await assert.rejects(() => l.wire.request({ method: 'GET', path: '/c' }), /張り直しました/, '⚠️⚠️ still sending to the dead line')
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ codex medium #2 and #5, 2026-09-15
//
// medium #2: `request()` waited **for the send to complete** before waiting for the response, so when the carrier was stuck
//      **neither the timeout nor `fail()` reached the caller** (and the waiter's reject became
//      unhandled). ⇒ Wait for the response without waiting for the send.
// medium #5: `subscribe()` and `deliver()` didn't check `dead`. Moreover `fail('')`
//      **passed** `if (dead)` (an empty string is also "dead"). ⇒ Check with `!== undefined`.
// ─────────────────────────────────────────────────────────────────────────────

test('★★ even while sending is stuck, the timeout reaches the caller (codex medium #2)', { timeout: 5000 }, async () => {
  let open: (() => void) | undefined
  const gate = new Promise<void>((r) => {
    open = r
  })
  const l = await link({ timeoutMs: 20, gate })
  // ⚠️⚠️ Sending stays stuck. Even so **the caller** must fail by timeout
  await assert.rejects(() => l.wire.request({ method: 'GET', path: '/health' }), /時間切れ/)
  open!()
  await l.wire.flush()
})

test('★★ if it dies while sending is stuck, the reason returns immediately and that request isn\'t sent', { timeout: 5000 }, async () => {
  let open: (() => void) | undefined
  const gate = new Promise<void>((r) => {
    open = r
  })
  const l = await link({ gate })
  const p = l.wire.request({ method: 'GET', path: '/health' })
  // Queue a second while the first is stuck at the gate
  const q = l.wire.request({ method: 'GET', path: '/sessions' })

  l.wire.fail('この端末の登録は失効しています')
  await assert.rejects(() => p, /失効/)
  await assert.rejects(() => q, /失効/)

  open!()
  await l.wire.flush()
  // ⚠️⚠️ **The queued second one isn't sent** (no sealing and sending after disconnection)
  const got = await received(l)
  assert.ok(got.requests.length <= 1, `sent ${got.requests.length} after disconnection`)
  assert.equal(
    got.requests.some((r) => r.path === '/sessions'),
    false,
    '⚠️⚠️ sent a queued request after disconnection',
  )
})

test('★★ after disconnection, no subscriptions start and no events are delivered (codex medium #5)', async () => {
  const l = await link()
  l.wire.fail('切れました')

  const seen: AgentEvent[] = []
  const stop = l.wire.subscribe((e) => seen.push(e))
  await l.wire.flush()
  assert.deepEqual((await received(l)).requests, [], '⚠️⚠️ started a subscription after disconnection')

  // ⚠️ Even if an event somehow arrives, don't deliver it
  await l.agent.seal(FRAME.event, encodeEvent({ id: 1, event: { type: 'heartbeat', n: 1, at: 'T' } }))
  assert.deepEqual(seen, [])
  stop()
})

test('★★ an empty-string reason still means "disconnected" (not judged by truthiness)', { timeout: 5000 }, async () => {
  // ⚠️ `if (dead)` lets an empty string through, so it failed only **after waiting for the timeout**
  //    (= turns into "no response" rather than "disconnected")
  const l = await link({ timeoutMs: 50 })
  l.wire.fail('')
  await assert.rejects(
    () => l.wire.request({ method: 'GET', path: '/health' }),
    (err: Error) => {
      assert.equal(/時間切れ/.test(err.message), false, '⚠️⚠️ the disconnect turned into a timeout')
      return true
    },
  )
})

test('★★ subscriptions and normal requests mixed are not confused (codex slip-past mutation ①)', async () => {
  // ⚠️⚠️ A separate counter for subscriptions **collides IDs**, a normal response is swallowed by the subscription,
  //    and the request times out (the mutation codex named). ⇒ **IDs share one space**.
  const l = await link({ timeoutMs: 500 })
  const seen: AgentEvent[] = []
  l.wire.subscribe((e) => seen.push(e))
  const p = l.wire.request({ method: 'GET', path: '/health' })

  const got = await received(l)
  assert.deepEqual(
    got.requests.map((r) => [r.id, r.path]),
    [
      [1, '/events'],
      [2, '/health'],
    ],
    '⚠️⚠️ IDs collide between subscriptions and requests',
  )

  await reply(l, FRAME.response, encodeResponse({ id: 2, status: 200, body: { machine: 'm' } }))
  assert.deepEqual(await p, { status: 200, body: { machine: 'm' } }, 'the request\'s response was swallowed by a subscription')
  assert.deepEqual(seen, [], '⚠️ delivered a normal response as an event')
})

test('★★ once disconnected, existing subscriptions get no events either (codex slip-past mutation ②)', async () => {
  const l = await link()
  const seen: AgentEvent[] = []
  l.wire.subscribe((e) => seen.push(e))
  await received(l)
  await reply(l, FRAME.event, encodeEvent({ id: 1, event: { type: 'hello', machine: 'm', at: 'T' } }))
  assert.equal(seen.length, 1, 'precondition: it arrives now')

  l.wire.fail('切れました')
  // ⚠️ Envelopes arriving after disconnection aren't opened (and not delivered even if opened)
  const frame = await l.agent.seal(FRAME.event, encodeEvent({ id: 1, event: { type: 'heartbeat', n: 1, at: 'T' } }))
  const res = await l.wire.deliver(frame)
  assert.equal(res.ok, false)
  assert.equal(seen.length, 1, '⚠️⚠️ delivered events after disconnection')
})

test('★★ eventsLive: only after the /events subscription is accepted with 2xx; false once disconnected or unsubscribed (2026-09-24)', async () => {
  const l = await link()
  assert.equal(l.wire.eventsLive(), false)
  // ★ The follow endpoint doesn't count (unrelated to the list's fallback interval)
  l.wire.subscribe(() => undefined, '/sessions/s/follow')
  const stop = l.wire.subscribe(() => undefined)
  await received(l)
  await reply(l, FRAME.response, encodeResponse({ id: 1, status: 200 }))
  assert.equal(l.wire.eventsLive(), false, '⚠️⚠️ the follow subscription claims "the signal is alive"')
  // ⚠️ Not alive before the response (it might be refused)
  await reply(l, FRAME.event, encodeEvent({ id: 2, event: { type: 'hello', machine: 'm', at: 'T' } }))
  assert.equal(l.wire.eventsLive(), false, '⚠️ claims alive before being accepted')
  await reply(l, FRAME.response, encodeResponse({ id: 2, status: 200 }))
  assert.equal(l.wire.eventsLive(), true)
  stop()
  assert.equal(l.wire.eventsLive(), false, '⚠️ claims alive after unsubscribing')
})

test('★★ eventsLive: false for a refused subscription, a close with ID, and a whole-line disconnect', async () => {
  const l = await link()
  l.wire.subscribe(() => undefined)
  await received(l)
  await reply(l, FRAME.response, encodeResponse({ id: 1, status: 403 }))
  assert.equal(l.wire.eventsLive(), false, '⚠️ claims a refused subscription is alive')

  l.wire.subscribe(() => undefined)
  await received(l)
  await reply(l, FRAME.response, encodeResponse({ id: 2, status: 200 }))
  assert.equal(l.wire.eventsLive(), true)
  await reply(l, FRAME.close, encodeClose({ id: 2 }))
  assert.equal(l.wire.eventsLive(), false, '⚠️ claims a subscription the agent closed is alive')

  l.wire.subscribe(() => undefined)
  await received(l)
  await reply(l, FRAME.response, encodeResponse({ id: 3, status: 200 }))
  assert.equal(l.wire.eventsLive(), true)
  l.wire.fail('切れました')
  assert.equal(l.wire.eventsLive(), false, '⚠️⚠️ claims alive after the line dropped (60s stale)')
})
