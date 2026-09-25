// Step 6 ③ of ③: the outer rendezvous frame (`shared/relayFrame.ts`).
//
// ★★ **The agent, the PWA and the Worker all read this one file**. ⇒ If it disagrees,
//   "only via relay does it fail", and **it can only be noticed on real devices**.
//
// ★★ Mutations **targeted by name** here:
//   ① version not checked ② type not checked against the table
//   ③ limit not checked (⚠️ the ToS measure itself / §14.1.1.4)
//   ④ connection number 0 allowed (= indistinguishable from "no number")
//   ⑤ payload allowed on types other than `data` / empty allowed on `data`
//   ⑥ decode throws (⚠️ an exception inside the carrier's `onmessage` breaks the whole connection)
//   ⑦ wrong header length (payload shifted by one byte = every decryption fails)
//   ⑧ rendezvous URL side (agent/device) or key mixed up

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_RELAY_BYTES,
  RELAY_FRAME,
  RELAY_HEADER_BYTES,
  RELAY_PING,
  RELAY_PING_MS,
  RELAY_PONG,
  RELAY_V,
  decodeRelayFrame,
  encodeRelayFrame,
  isRelayBase,
  relayUrl,
} from './relayFrame.ts'
import { MAX_PAYLOAD_BYTES } from './tunnel.ts'

test('★★ round trip (payload does not change by a single byte)', () => {
  const payload = new Uint8Array([0, 1, 2, 250, 255])
  const d = decodeRelayFrame(encodeRelayFrame({ type: RELAY_FRAME.data, connId: 7, payload }))
  assert.ok(d.ok)
  assert.equal(d.value.type, RELAY_FRAME.data)
  assert.equal(d.value.connId, 7)
  assert.deepEqual([...(d.value.payload ?? [])], [...payload])

  for (const type of [RELAY_FRAME.opened, RELAY_FRAME.closed] as const) {
    const r = decodeRelayFrame(encodeRelayFrame({ type, connId: 1 }))
    assert.ok(r.ok)
    assert.deepEqual(r.value, { type, connId: 1 })
  }
})

test('★★ payload position does not shift (header length)', () => {
  const payload = new Uint8Array([9, 9, 9])
  const frame = encodeRelayFrame({ type: RELAY_FRAME.data, connId: 1, payload })
  assert.equal(frame.length, RELAY_HEADER_BYTES + payload.length)
  // ★ Look at **the exact bytes the implementation produced** (version, type, number, payload)
  assert.equal(frame[0], RELAY_V)
  assert.equal(frame[1], RELAY_FRAME.data)
  assert.deepEqual([...frame.slice(2, 6)], [0, 0, 0, 1])
  assert.deepEqual([...frame.slice(RELAY_HEADER_BYTES)], [9, 9, 9])
})

test('★★ large numbers do not break (4 bytes)', () => {
  const big = 0xfffffffe
  const d = decodeRelayFrame(
    encodeRelayFrame({ type: RELAY_FRAME.data, connId: big, payload: new Uint8Array([1]) }),
  )
  assert.ok(d.ok)
  assert.equal(d.value.connId, big)
})

test('★★ unknown versions and unknown types are rejected', () => {
  const frame = encodeRelayFrame({ type: RELAY_FRAME.data, connId: 1, payload: new Uint8Array([1]) })
  const badV = new Uint8Array(frame)
  badV[0] = RELAY_V + 1
  assert.equal(decodeRelayFrame(badV).ok, false)

  for (const type of [0, 6, 99, 255]) {
    const bad = new Uint8Array(frame)
    bad[1] = type
    const r = decodeRelayFrame(bad)
    assert.equal(r.ok, false, `let type ${type} through`)
  }
})

test('★★ connection number 0 is rejected (indistinguishable from "no number")', () => {
  const frame = encodeRelayFrame({ type: RELAY_FRAME.data, connId: 1, payload: new Uint8Array([1]) })
  const zero = new Uint8Array(frame)
  zero.set([0, 0, 0, 0], 2)
  assert.equal(decodeRelayFrame(zero).ok, false)
  // ★ The sender refuses too
  for (const id of [0, -1, 1.5, Number.NaN, 0x1_0000_0000]) {
    assert.throws(
      () => encodeRelayFrame({ type: RELAY_FRAME.data, connId: id, payload: new Uint8Array([1]) }),
      /接続番号/,
      `let ${String(id)} through`,
    )
  }
})

test('★★ only `data` carries a payload / `data` cannot be empty', () => {
  const withBody = new Uint8Array([RELAY_V, RELAY_FRAME.opened, 0, 0, 0, 1, 42])
  assert.equal(decodeRelayFrame(withBody).ok, false)
  const empty = new Uint8Array([RELAY_V, RELAY_FRAME.data, 0, 0, 0, 1])
  assert.equal(decodeRelayFrame(empty).ok, false)
})

test('★★ limit (★ the ToS measure itself)', () => {
  // ⚠️⚠️ **Never smaller than the payload limit** (if smaller, relay drops correct responses)
  assert.ok(
    MAX_RELAY_BYTES > MAX_PAYLOAD_BYTES,
    `relay limit ${MAX_RELAY_BYTES} is not above the payload limit ${MAX_PAYLOAD_BYTES}`,
  )
  // Sender side
  assert.throws(
    () =>
      encodeRelayFrame({
        type: RELAY_FRAME.data,
        connId: 1,
        payload: new Uint8Array(MAX_RELAY_BYTES),
      }),
    /大きすぎ/,
  )
  // Receiver side
  const tooBig = new Uint8Array(MAX_RELAY_BYTES + 1)
  tooBig[0] = RELAY_V
  tooBig[1] = RELAY_FRAME.data
  tooBig[5] = 1
  assert.equal(decodeRelayFrame(tooBig).ok, false)
  // ★ Exactly at the limit passes (= the rejection above is not "always reject")
  const ok = encodeRelayFrame({
    type: RELAY_FRAME.data,
    connId: 1,
    payload: new Uint8Array(MAX_RELAY_BYTES - RELAY_HEADER_BYTES),
  })
  assert.equal(ok.length, MAX_RELAY_BYTES)
  assert.equal(decodeRelayFrame(ok).ok, true)
})

test('★★ decode never throws (does not break the receiver of the carrier)', () => {
  for (const bytes of [
    new Uint8Array(0),
    new Uint8Array([RELAY_V]),
    new Uint8Array([RELAY_V, RELAY_FRAME.data, 0, 0, 0]),
    new Uint8Array([0, 0, 0, 0, 0, 0]),
  ]) {
    const r = decodeRelayFrame(bytes)
    assert.equal(r.ok, false)
    assert.ok(!r.ok && r.reason.length > 0, 'empty reason')
  }
})

test('★★ rendezvous URL (★ keep it replaceable)', () => {
  const key = 'BEiiii-_abc'
  assert.equal(
    relayUrl('wss://relay.example', 'agent', key),
    `wss://relay.example/v${RELAY_V}/agent?a=${key}`,
  )
  assert.equal(
    relayUrl('wss://relay.example/', 'device', key),
    `wss://relay.example/v${RELAY_V}/device?a=${key}`,
  )
  // ★ Does not break under a sub-path either (self-hosted versions or path-based setups)
  assert.equal(
    relayUrl('wss://example.com/nyan/', 'agent', key),
    `wss://example.com/nyan/v${RELAY_V}/agent?a=${key}`,
  )
  // ⚠️ The key is base64url, so it goes in as-is (assumes no `+` `/`)
  assert.equal(new URL(relayUrl('wss://r.example', 'device', key)).searchParams.get('a'), key)
})

test('★★ the keepalive signal is **a contract with the running relay** (known answer)', () => {
  // ⚠️⚠️ Changing this **disagrees with the deployed relay** (the auto-response stops matching, and
  //    the DO that receives text cuts the wire with "text is not accepted").
  //    ⇒ If you change it, deploy relay first. A failure is not "a bug" but a sign **the contract changed**.
  assert.equal(RELAY_PING, 'nyan-ping')
  assert.equal(RELAY_PONG, 'nyan-pong')
  // ★ Cloudflare's auto-response allows up to 2,048 characters each (confirmed in the official docs on 2026-09-15)
  assert.ok(RELAY_PING.length <= 2048 && RELAY_PONG.length <= 2048)
  // ⚠️ If request and response were equal, our own signal would be misread as "the reply"
  assert.notEqual(RELAY_PING, RELAY_PONG)
  // ⚠️ Too long and NATs or middleboxes silently cut it / too short does not raise billing but adds requests
  assert.ok(RELAY_PING_MS >= 10_000 && RELAY_PING_MS <= 120_000, `${RELAY_PING_MS}ms`)
})

test('★★ is the shape usable as a relay entry point (config and QR use the same check)', () => {
  for (const ok of [
    'wss://relay.example',
    'wss://relay.example/nyan',
    'ws://127.0.0.1:8787',
    'ws://[::1]:8787',
  ]) {
    assert.equal(isRelayBase(ok), true, `rejected: ${ok}`)
  }
  for (const bad of [
    // ⚠️ Plain HTTP / other schemes (★ the route is WebSocket only)
    'https://relay.example',
    'http://relay.example',
    'file:///etc/passwd',
    'javascript:alert(1)',
    // ⚠️ Query and fragment are added by `relayUrl` (do not mix in what was passed)
    'wss://relay.example?a=x',
    'wss://relay.example#x',
    // ⚠️ **Empty fragment** (`u.hash` is an empty string, so it passes unless the raw text is checked / low #10)
    'wss://relay.example/#',
    // ⚠️⚠️ With credentials (values from QR or config become the connection target as-is)
    'wss://user:pw@relay.example',
    // ⚠️ Not even URL-shaped
    '',
    'relay.example',
    'ws:',
    `wss://${'x'.repeat(600)}`,
    // ⚠️ Not even a string (comes from a config file)
    undefined,
    null,
    42,
    { url: 'wss://relay.example' },
  ]) {
    assert.equal(isRelayBase(bad), false, `accepted: ${String(bad)}`)
  }
})

test('★★ shapes of drop (agent → relay) and ready (relay → agent) (2026-09-24 / codex round 18, high #1)', () => {
  // ★ drop: has a number, no payload
  const drop = decodeRelayFrame(encodeRelayFrame({ type: RELAY_FRAME.drop, connId: 7 }))
  assert.ok(drop.ok)
  assert.deepEqual(drop.value, { type: RELAY_FRAME.drop, connId: 7 })
  assert.equal(decodeRelayFrame(new Uint8Array([RELAY_V, RELAY_FRAME.drop, 0, 0, 0, 7, 1])).ok, false, '⚠️ drop with a payload')
  assert.equal(decodeRelayFrame(new Uint8Array([RELAY_V, RELAY_FRAME.drop, 0, 0, 0, 0])).ok, false, '⚠️ drop with number 0')
  // ★ ready: number 0 only
  const ready = decodeRelayFrame(encodeRelayFrame({ type: RELAY_FRAME.ready, connId: 0 }))
  assert.ok(ready.ok)
  assert.deepEqual(ready.value, { type: RELAY_FRAME.ready, connId: 0 })
  assert.equal(decodeRelayFrame(new Uint8Array([RELAY_V, RELAY_FRAME.ready, 0, 0, 0, 1])).ok, false, '⚠️ ready with a number')
  assert.throws(() => encodeRelayFrame({ type: RELAY_FRAME.ready, connId: 1 }), /接続番号/)
  // ⚠️ Known answer (a contract between the running relay and the agent. Changing type numbers breaks the wire)
  assert.equal(RELAY_FRAME.drop, 4)
  assert.equal(RELAY_FRAME.ready, 5)
})

test('★★ the agent can announce c=1 in the URL (not added on the phone side)', () => {
  const a = new URL(relayUrl('wss://r.example', 'agent', 'KEY', { control: true }))
  assert.equal(a.searchParams.get('c'), '1')
  assert.equal(new URL(relayUrl('wss://r.example', 'agent', 'KEY')).searchParams.get('c'), null)
  assert.equal(new URL(relayUrl('wss://r.example', 'device', 'KEY', { control: true })).searchParams.get('c'), null)
})

test('★★ license support is announced with l=1 (⚠️ not c=2 = old relays only look at c=1 and would lose drop / ready too / codex round 26)', () => {
  const a = new URL(relayUrl('wss://r.example', 'agent', 'KEY', { control: true, license: true }))
  assert.equal(a.searchParams.get('c'), '1')
  assert.equal(a.searchParams.get('l'), '1')
  assert.equal(new URL(relayUrl('wss://r.example', 'agent', 'KEY', { control: true })).searchParams.get('l'), null)
})
