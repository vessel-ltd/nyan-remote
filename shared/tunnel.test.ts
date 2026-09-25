// Step 6 of ③: the contents of the tunnel (`shared/tunnel.ts`).
//
// ★★ **This is the entry for "hostile input from a peer that passed the handshake".**
//   ⚠️⚠️ Even a registered device is not guaranteed "not to send broken input" (implementation bugs, modified builds,
//      right after a device is stolen). ⇒ **Never throw, never fall back to defaults, cut at the limit**.
//
// ★★ Mutations **targeted by name** here:
//   ① version not checked (silently reads an unknown version with another meaning)
//   ② method not checked against the table (free-form strings pass)
//   ③ routes starting with `//` pass (★ `new URL` gives **another host** = same shape as high #1)
//   ④ routes not starting with `/` pass
//   ⑤ non-object bodies pass (the caller's `body.key` becomes a **500**)
//   ⑥ body allowed on GET (the same meaning expressed two ways)
//   ⑦ length not checked before `JSON.parse` (lets it build a huge string)
//   ⑧ number not read with `Object.hasOwn` (picks up **inherited properties**)
//   ⑨ number check loosened (`0` / negative / fraction / huge)
//   ⑩ control characters in the route pass (raw control characters reach logs and files)
//   ⑪ status code range not checked
//   ⑫ decode throws (= the peer can crash the agent's handling)
//
// ★ That **there is no way to carry headers "in the type"** is checked here as
//   "extra keys do not appear in the decode result" (that the agent attaches fixed headers
//   is checked by `agent/src/tunnel.test.ts` **on the values the implementation produces**).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_PATH,
  MAX_PAYLOAD_BYTES,
  TUNNEL_METHODS,
  TUNNEL_ORIGIN,
  TUNNEL_V,
  decodeClose,
  decodeEvent,
  decodeRequest,
  decodeResponse,
  encodeClose,
  encodeEvent,
  encodeRequest,
  encodeResponse,
} from './tunnel.ts'

const enc = (s: string) => new TextEncoder().encode(s)
const raw = (o: unknown) => enc(JSON.stringify(o))

test('★★ request round trip (with and without body)', () => {
  const get = decodeRequest(encodeRequest({ id: 1, method: 'GET', path: '/sessions?live=1' }))
  assert.deepEqual(get, { ok: true, value: { id: 1, method: 'GET', path: '/sessions?live=1' } })

  const post = decodeRequest(
    encodeRequest({ id: 7, method: 'POST', path: '/pair', body: { key: 'k', token: 't' } }),
  )
  assert.deepEqual(post, {
    ok: true,
    value: { id: 7, method: 'POST', path: '/pair', body: { key: 'k', token: 't' } },
  })
})

test('★★ response, event and close round trips', () => {
  assert.deepEqual(decodeResponse(encodeResponse({ id: 2, status: 200, body: { ok: true } })), {
    ok: true,
    value: { id: 2, status: 200, body: { ok: true } },
  })
  // ★ A response without body (like 204), and endpoints that return arrays or null
  assert.deepEqual(decodeResponse(encodeResponse({ id: 3, status: 204 })), {
    ok: true,
    value: { id: 3, status: 204 },
  })
  assert.deepEqual(decodeResponse(encodeResponse({ id: 4, status: 200, body: [1, 2] })).ok, true)
  assert.deepEqual(decodeResponse(encodeResponse({ id: 5, status: 200, body: null })), {
    ok: true,
    value: { id: 5, status: 200, body: null },
  })

  assert.deepEqual(decodeEvent(encodeEvent({ id: 9, event: { type: 'sessions-changed' } })), {
    ok: true,
    value: { id: 9, event: { type: 'sessions-changed' } },
  })
  assert.deepEqual(decodeClose(encodeClose({ id: 9, reason: '切りました' })), {
    ok: true,
    value: { id: 9, reason: '切りました' },
  })
  assert.deepEqual(decodeClose(encodeClose({ id: 9 })), { ok: true, value: { id: 9 } })
})

test('★★ unknown versions are rejected (never silently read with another meaning)', () => {
  for (const v of [2, 0, '1', undefined, null]) {
    const r = decodeRequest(raw({ v, i: 1, m: 'GET', p: '/x' }))
    assert.equal(r.ok, false, `let v=${String(v)} through`)
    assert.ok(!r.ok && /版/.test(r.reason))
  }
  // ★ Not "always reject"
  assert.equal(decodeRequest(raw({ v: TUNNEL_V, i: 1, m: 'GET', p: '/x' })).ok, true)
})

test('★★ only the two methods in the table (no free-form strings)', () => {
  assert.deepEqual([...TUNNEL_METHODS], ['GET', 'POST'])
  for (const m of ['DELETE', 'PUT', 'HEAD', 'get', 'post', 'OPTIONS', '', 1, null, ['GET']]) {
    const r = decodeRequest(raw({ v: TUNNEL_V, i: 1, m, p: '/x' }))
    assert.equal(r.ok, false, `let ${JSON.stringify(m)} through`)
  }
})

test('★★ routes whose destination changes are rejected (★ both // and \\ become another host)', () => {
  // ⚠️⚠️ This is the same shape as high #1 of 2026-09-08 (the authenticated value and the executed value disagree).
  //    **Measure both** (so we notice if the premise changes).
  assert.equal(new URL('//evil/x', TUNNEL_ORIGIN).host, 'evil', 'the premise changed')
  // ★ codex low #6 on 2026-09-15: the backslash is the same (a `//`-only check let it through)
  assert.equal(new URL('/\\evil/x', TUNNEL_ORIGIN).host, 'evil', 'the premise changed')

  for (const p of ['//evil/x', '///x', '/\\evil/x', '/\\\\evil/x', 'http://evil/x', 'https://evil/x', '', null, 1]) {
    const r = decodeRequest(raw({ v: TUNNEL_V, i: 1, m: 'GET', p }))
    assert.equal(r.ok, false, `let ${JSON.stringify(p)} through`)
  }
  assert.equal(decodeRequest(raw({ v: TUNNEL_V, i: 1, m: 'GET', p: '/x' })).ok, true)
})

test('★★ the route returns "the re-parsed value" (no two interpretations)', () => {
  // ★★ **Normalising and returning** rather than rejecting makes it **the same value**
  //    the agent gets from `new URL` (rejecting by enumeration always leaves something outside).
  const canon = (p: string): string | false => {
    const r = decodeRequest(raw({ v: TUNNEL_V, i: 1, m: 'GET', p }))
    return r.ok ? r.value.path : false
  }
  assert.equal(canon('/sessions?live=1'), '/sessions?live=1', 'ordinary routes do not change')
  // ⚠️ Each of these gives the same value once the agent passes it through `new URL`
  assert.equal(canon('sessions'), '/sessions')
  assert.equal(canon('/a/../b'), '/b')
  assert.equal(canon('/x#ここ'), '/x', 'the fragment is dropped (it never reaches the agent)')
  assert.equal(canon('/どこにも無い'), `/${encodeURIComponent('どこにも無い')}`)
  // ★ Passing the returned value through **again** does not change it (= one interpretation)
  for (const p of ['/sessions?live=1', 'sessions', '/a/../b', '/どこにも無い']) {
    const once = canon(p) as string
    assert.equal(canon(once), once, `interpretation of ${p} is not stable`)
  }
})

test('★★ control characters in the route are rejected (never raw into logs and files)', () => {
  for (const p of ['/x\u0000y', '/x\u001fy', '/x\u007fy', '/x\ny', '/x\ry']) {
    const r = decodeRequest(raw({ v: TUNNEL_V, i: 1, m: 'GET', p }))
    assert.equal(r.ok, false, `let ${JSON.stringify(p)} through`)
    assert.ok(!r.ok && /制御文字/.test(r.reason))
  }
})

test('★★ route length limit (do not let it build long strings)', () => {
  const ok = `/${'a'.repeat(MAX_PATH - 1)}`
  assert.equal(ok.length, MAX_PATH)
  assert.equal(decodeRequest(raw({ v: TUNNEL_V, i: 1, m: 'GET', p: ok })).ok, true)
  const tooLong = `${ok}a`
  const r = decodeRequest(raw({ v: TUNNEL_V, i: 1, m: 'GET', p: tooLong }))
  assert.equal(r.ok, false)
  assert.ok(!r.ok && /長すぎ/.test(r.reason))
})

test('★★ the body must be a JSON object (do not make the caller 500)', () => {
  // ⚠️ Same hole `readJsonBody` closed on 2026-09-08 (`null` makes `body.key` a TypeError)
  for (const b of [null, [], 1, 'x', true]) {
    const r = decodeRequest(raw({ v: TUNNEL_V, i: 1, m: 'POST', p: '/pair', b }))
    assert.equal(r.ok, false, `let ${JSON.stringify(b)} through`)
  }
  assert.equal(decodeRequest(raw({ v: TUNNEL_V, i: 1, m: 'POST', p: '/pair', b: {} })).ok, true)
})

test('★★ GET cannot have a body (never express the same meaning two ways)', () => {
  const r = decodeRequest(raw({ v: TUNNEL_V, i: 1, m: 'GET', p: '/x', b: {} }))
  assert.equal(r.ok, false)
  assert.ok(!r.ok && /GET/.test(r.reason))
})

test('★★ the number must be a positive safe integer', () => {
  for (const i of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, '1', null, undefined]) {
    const r = decodeRequest(raw({ v: TUNNEL_V, i, m: 'GET', p: '/x' }))
    assert.equal(r.ok, false, `let ${String(i)} through`)
  }
  assert.equal(decodeRequest(raw({ v: TUNNEL_V, i: Number.MAX_SAFE_INTEGER, m: 'GET', p: '/x' })).ok, true)
})

test('★★ the number is not picked up from inherited properties', () => {
  // ⚠️ codex 2026-08-25, medium #1 (`Object.prototype.id='exit'` made an empty JSON run /exit)
  const proto = Object.prototype as unknown as Record<string, unknown>
  proto['i'] = 1
  try {
    const r = decodeRequest(raw({ v: TUNNEL_V, m: 'GET', p: '/x' }))
    assert.equal(r.ok, false, '⚠️⚠️ used a number from an inherited property')
  } finally {
    delete proto['i']
  }
})

test('★★ status code must be in the HTTP range', () => {
  for (const s of [0, 99, 600, 200.5, '200', null, undefined]) {
    const r = decodeResponse(raw({ v: TUNNEL_V, i: 1, s }))
    assert.equal(r.ok, false, `let ${String(s)} through`)
  }
  for (const s of [100, 200, 403, 503, 599]) {
    assert.equal(decodeResponse(raw({ v: TUNNEL_V, i: 1, s })).ok, true)
  }
})

test('★★ an event without contents is rejected (never hand out `undefined`)', () => {
  const r = decodeEvent(raw({ v: TUNNEL_V, i: 1 }))
  assert.equal(r.ok, false)
  // ★ `null` counts as "has contents" (an endpoint may stream null)
  assert.equal(decodeEvent(raw({ v: TUNNEL_V, i: 1, e: null })).ok, true)
})

test('★★ decode never throws (the peer cannot crash the handling)', () => {
  const inputs: Uint8Array[] = [
    new Uint8Array(0),
    enc('{'),
    enc('null'),
    enc('[]'),
    enc('3'),
    enc('"x"'),
    new Uint8Array([0xff, 0xfe, 0xfd]), // not valid UTF-8
    new Uint8Array([0x7b, 0x00, 0x7d]),
    raw({}),
  ]
  for (const bytes of inputs) {
    for (const fn of [decodeRequest, decodeResponse, decodeEvent, decodeClose]) {
      const r = fn(bytes)
      // ⚠️ Must not throw, and must not fall to `ok:true`
      assert.equal(r.ok, false, `${fn.name}(${JSON.stringify([...bytes].slice(0, 8))}) passed`)
      assert.equal(typeof r.reason, 'string')
      assert.ok(r.reason.length > 0, 'empty reason')
    }
  }
  // ★ Only for `close` is "no number" the correct shape (= close the whole tunnel)
  assert.deepEqual(decodeClose(raw({ v: TUNNEL_V })), { ok: true, value: {} })
  for (const fn of [decodeRequest, decodeResponse, decodeEvent]) {
    assert.equal(fn(raw({ v: TUNNEL_V })).ok, false, `${fn.name} let a missing number through`)
  }
})

test('★★ a close reason that is "present but not a string" is rejected (never fall back to defaults)', () => {
  // ⚠️ 2026-09-15 / codex low #7. Silently treating it as "no reason"
  //    **turns the disconnect into "a disconnect with no known reason"** (the text shown on screen disappears)
  for (const r of [123, null, {}, ['x']]) {
    const d = decodeClose(raw({ v: TUNNEL_V, i: 1, r }))
    assert.equal(d.ok, false, `let ${JSON.stringify(r)} through`)
  }
  assert.deepEqual(decodeClose(raw({ v: TUNNEL_V, i: 1, r: '' })), {
    ok: true,
    value: { id: 1, reason: '' },
  })
})

test('★★ close: "no number = everything", but a broken number does not fall to everything', async () => {
  // ⚠️⚠️ Treating `i: 0` as "none" makes **a request meant to stop one subscription stop all of them**
  for (const i of [0, -1, 1.5, '1', null]) {
    const r = decodeClose(raw({ v: TUNNEL_V, i }))
    assert.equal(r.ok, false, `let i=${String(i)} through`)
  }
  assert.deepEqual(decodeClose(raw({ v: TUNNEL_V, i: 3 })), { ok: true, value: { id: 3 } })
  // ★ A close with only a reason closes the whole tunnel
  assert.deepEqual(decodeClose(raw({ v: TUNNEL_V, r: 'やめます' })), {
    ok: true,
    value: { reason: 'やめます' },
  })
})

test('★★ an oversized plaintext is rejected before `JSON.parse`', () => {
  // ★ Rejected as "too large" (not rejected as broken JSON after reaching `JSON.parse`)
  const big = new Uint8Array(MAX_PAYLOAD_BYTES + 1).fill(0x20)
  const r = decodeRequest(big)
  assert.equal(r.ok, false)
  assert.ok(!r.ok && /大きすぎ/.test(r.reason), `reason is not "too large": ${!r.ok && r.reason}`)
})

test('★★ the sender also checks the limit (never silently send what cannot be sent)', () => {
  const body = { x: 'あ'.repeat(MAX_PAYLOAD_BYTES) }
  assert.throws(
    () => encodeRequest({ id: 1, method: 'POST', path: '/x', body }),
    /大きすぎ/,
  )
})

test('★★ there is no way to carry headers (extra keys do not appear in the decode result)', () => {
  // ⚠️⚠️ If they could be carried, the phone could **claim** `tailscale-user-login` / `x-nyan-remote-token` /
  //    `origin` = the peer could forge the inputs to authentication and CSRF checks.
  const r = decodeRequest(
    raw({
      v: TUNNEL_V,
      i: 1,
      m: 'GET',
      p: '/sessions',
      h: { 'tailscale-user-login': 'me@github', 'x-nyan-remote-token': 'x'.repeat(40) },
      headers: { origin: 'https://evil.example' },
    }),
  )
  assert.ok(r.ok)
  // ★ Nothing passes through (**not even the keys** appear)
  assert.deepEqual(Object.keys(r.value).sort(), ['id', 'method', 'path'])
})
