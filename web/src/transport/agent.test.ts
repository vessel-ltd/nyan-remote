// Pin down entirely **what the `Transport` implementation (`agent.ts`) hands to the route**.
//
// ★★ Why it's needed (2026-09-15 / step 6-② of ③): since the route can be swapped via `Wire`,
//   **"which endpoint, which method, what body"** became a route-independent contract.
//   ⇒ If this is green, **the same requests go out via relay too** (the route side only wraps them in envelopes).
//
// ⚠️⚠️ Without this, adding `relay.ts` could create **one-sided wiring**: "works over HTTP but hits a different
//    endpoint over relay" (exactly what discipline 2 wants to prevent).
//
// ★★ **Mutations killed by name** here:
//   ① rewrite the endpoint (path) ② swap GET/POST
//   ③ drop the body or add extras ④ don't escape the session ID
//   ⑤ return success on a non-2xx status ⑥ don't take the failure reason from `error`
//   ⑦ don't delegate `subscribe` to the route

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentEvent } from '../../../shared/types.ts'
import { AgentTransport } from './agent.ts'
import type { AgentEndpoint } from '../endpoints.ts'
import type { Wire, WireRequest, WireResponse } from './wire.ts'

const endpoint = { id: 'e1', label: 'test', url: 'https://agent.example', kind: 'local' as const }

interface Recorded {
  calls: WireRequest[]
  transport: AgentTransport
  subscribed: ((e: AgentEvent) => void)[]
  released: number
}

/** ★ Strip `?lang=` / `&lang=` (added to every request since the i18n work on 2026-09-23) */
function stripLang(path: string): string {
  return path.replace(/[?&]lang=(ja|en)$/, '')
}

/** ★ A fake that only records the route (⚠️ `fetch` is never called) */
function recording(reply: (r: WireRequest) => WireResponse = () => ({ status: 200, body: {} })): Recorded {
  const rec: Recorded = { calls: [], transport: null as unknown as AgentTransport, subscribed: [], released: 0 }
  const wire: Wire = {
    async request(raw) {
      // ★ The screen language (`?lang=`) is on every request (checked by the dedicated test below). Stripped here for comparison
      const r = { ...raw, path: stripLang(raw.path) }
      rec.calls.push(r)
      return reply(r)
    },
    subscribe(on) {
      rec.subscribed.push(on)
      return () => {
        rec.released += 1
      }
    },
  }
  rec.transport = new AgentTransport(endpoint, wire)
  return rec
}

test('★★ pins down entirely which endpoint, which method and what body are sent', async () => {
  const rec = recording((r) => ({
    status: 200,
    // ★ Minimal shape per endpoint (`listSessions` etc. read the contents)
    body: r.path.startsWith('/sessions?') ? { machine: 'm', sessions: [] } : { ok: true },
  }))
  const t = rec.transport

  await t.health()
  await t.listSessions({ history: false })
  await t.listSessions({ history: true })
  await t.getLog('S 1/2', { before: 10, limit: 5 })
  await t.listPeers()
  await t.listDevices()
  await t.pushStatus()
  await t.listPermissions()

  await t.sendMessage('S 1/2', 'やあ')
  await t.interrupt('S 1/2')
  await t.clearInput('S 1/2')
  await t.runCommand('S 1/2', 'compact')
  await t.setAutoApprove('S 1/2', true)
  await t.answerPermission('K', 'allow')
  await t.revokeDevice('KEY')
  await t.handshake('INIT')
  await t.unregisterPush('https://push.example/x')
  await t.sendTestPush()

  assert.deepEqual(rec.calls, [
    { method: 'GET', path: '/health' },
    // ★ Filtering is **requested explicitly** (a shape where old agents also return everything / §14.1.1.7)
    { method: 'GET', path: '/sessions?live=1' },
    { method: 'GET', path: '/sessions?history=1' },
    // ⚠️ Session IDs are always escaped (a `/` would turn it into another route)
    { method: 'GET', path: '/sessions/S%201%2F2/log?before=10&limit=5' },
    { method: 'GET', path: '/peers' },
    { method: 'GET', path: '/devices' },
    { method: 'GET', path: '/push/status' },
    { method: 'GET', path: '/permissions' },
    { method: 'POST', path: '/sessions/S%201%2F2/message', body: { text: 'やあ' } },
    // ⚠️⚠️ **Endpoints that take no body** (the bytes sent are fixed in the agent's table)
    { method: 'POST', path: '/sessions/S%201%2F2/interrupt', body: {} },
    { method: 'POST', path: '/sessions/S%201%2F2/clear', body: {} },
    // ⚠️⚠️ Commands send **only the id** (there's no path for passing text)
    { method: 'POST', path: '/sessions/S%201%2F2/command', body: { id: 'compact' } },
    // ⚠️⚠️ Auto-approve sends **only a boolean** (the duration is decided by the agent)
    { method: 'POST', path: '/sessions/S%201%2F2/auto-approve', body: { on: true } },
    // ⚠️⚠️ The approval answer has no `updatedInput` (only the chosen label)
    { method: 'POST', path: '/permission/answer', body: { key: 'K', behavior: 'allow' } },
    { method: 'POST', path: '/devices/revoke', body: { key: 'KEY' } },
    { method: 'POST', path: '/handshake', body: { init: 'INIT' } },
    { method: 'POST', path: '/push/unsubscribe', body: { endpoint: 'https://push.example/x' } },
    { method: 'POST', path: '/push/test', body: {} },
  ])
})

test('★★ approval answer: includes the chosen label and reason, nothing else', async () => {
  const rec = recording()
  await rec.transport.answerPermission('K', 'deny', { 'どっち?': ['A'] }, 'こう直して')
  assert.deepEqual(rec.calls[0], {
    method: 'POST',
    path: '/permission/answer',
    body: { key: 'K', behavior: 'deny', answers: { 'どっち?': ['A'] }, feedback: 'こう直して' },
  })
})

test('★★ throws unless 2xx; the reason comes from the body\'s `error`', async () => {
  const rec = recording(() => ({ status: 403, body: { error: 'この端末の登録は失効しています' } }))
  await assert.rejects(() => rec.transport.health(), /失効/)

  // ⚠️ Fall back to `HTTP <status>` only when the body is unreadable (don't silently succeed)
  const bare = recording(() => ({ status: 502 }))
  await assert.rejects(() => bare.transport.health(), /HTTP 502/)

  // ★ 2xx passes (= the rejection above isn't "always reject")
  const ok = recording(() => ({ status: 204 }))
  assert.equal(await ok.transport.sendTestPush(), undefined)
})

test('★★ subscription is delegated to the route (the screen doesn\'t know the route)', () => {
  const rec = recording()
  const seen: AgentEvent[] = []
  const stop = rec.transport.subscribe((e) => seen.push(e))
  assert.equal(rec.subscribed.length, 1, 'subscription not passed to the route')

  rec.subscribed[0]!({ type: 'heartbeat', n: 1, at: '2026-09-15T00:00:00.000Z' })
  assert.deepEqual(seen, [{ type: 'heartbeat', n: 1, at: '2026-09-15T00:00:00.000Z' }])

  stop()
  assert.equal(rec.released, 1, 'unsubscribe not propagated to the route')
})

test('★★ pairing checks against `/health` before sending (never to the wrong peer)', async () => {
  // ⚠️⚠️ codex medium #7, 2026-09-08. Sending without checking **leaks the one-time token to another machine**
  const mine = recording((r) =>
    r.path === '/health' ? { status: 200, body: { agentPublicKey: 'MINE' } } : { status: 200, body: { ok: true } },
  )
  const res = await mine.transport.pairDevice({
    key: 'K',
    token: 'T',
    label: 'L',
    agentPublicKey: 'OTHER',
  })
  assert.equal(res.ok, false)
  // ★ **Not a single `/pair` was sent** (only `/health`)
  assert.deepEqual(mine.calls.map((c) => c.path), ['/health'])

  const same = recording((r) =>
    r.path === '/health' ? { status: 200, body: { agentPublicKey: 'MINE' } } : { status: 200, body: { ok: true } },
  )
  await same.transport.pairDevice({ key: 'K', token: 'T', label: 'L', agentPublicKey: 'MINE' })
  assert.deepEqual(same.calls, [
    { method: 'GET', path: '/health' },
    // ⚠️ `agentPublicKey` is **not sent** (only used for the check)
    { method: 'POST', path: '/pair', body: { key: 'K', token: 'T', label: 'L' } },
  ])
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ The pairing target is decided by **the line itself** (2026-09-18 / codex round 8, low #7)
//
// ⚠️⚠️ "Is it relay" used to be guessed from `endpointRoute(this.endpoint)` (= **the endpoint settings**).
//   ⇒ Setting only `kind:'relay'` and handing over **an HTTP line**
//   skipped the `/health` check and **could send the one-time token to another host** (reproduced by codex).
// ★ The two mutations codex measured as "slipping past" are killed here:
//   ㉗ remove the `bound !== agentPublicKey` check (the one-time token could go to another agent)
//   ㉘ make `bound` always `undefined` (calls `/health` first on a pairing line = breaks with 403)
// ─────────────────────────────────────────────────────────────────────────────

const QR_KEY = 'くるまれたかぎ'
const PAIR_BODY = { key: 'この端末', token: 'わんたいむ', label: 'Android' }

/** ★ A fake claiming to be a relay line (= bound to this key by the handshake) */
function boundWire(bound: string | undefined, e: AgentEndpoint = endpoint): Recorded {
  const rec: Recorded = { calls: [], transport: null as unknown as AgentTransport, subscribed: [], released: 0 }
  const wire: Wire = {
    async request(raw) {
      // ★ The screen language (`?lang=`) is on every request (checked by the dedicated test below). Stripped here for comparison
      const r = { ...raw, path: stripLang(raw.path) }
      rec.calls.push(r)
      return { status: 200, body: r.path === '/health' ? { agentPublicKey: QR_KEY } : { ok: true } }
    },
    subscribe(on) {
      rec.subscribed.push(on)
      return () => {
        rec.released += 1
      }
    },
    ...(bound === undefined ? {} : { boundAgentPublicKey: bound }),
  }
  rec.transport = new AgentTransport(e, wire)
  return rec
}

test('★★ on a bound line, sends without fetching `/health` (㉘ /health is 403 on a pairing line)', async () => {
  const rec = boundWire(QR_KEY)
  const res = await rec.transport.pairDevice({ ...PAIR_BODY, agentPublicKey: QR_KEY })
  assert.equal(res.ok, true)
  assert.deepEqual(
    rec.calls.map((c) => c.path),
    ['/pair'],
    '⚠️⚠️ fetches `/health` first (on a pairing-only line it gets 403 and always fails)',
  )
  assert.deepEqual(rec.calls[0]?.body, PAIR_BODY, '⚠️ don\'t mix the QR key into the body')
})

test('★★ if the bound peer and the QR key differ, not one byte goes out (㉗)', async () => {
  const rec = boundWire('べつのかぎ')
  const res = await rec.transport.pairDevice({ ...PAIR_BODY, agentPublicKey: QR_KEY })
  assert.equal(res.ok, false)
  assert.deepEqual(rec.calls, [], '⚠️⚠️ sent the one-time token to another agent')
})

test('★★ even with relay in the settings, an unbound line is verified via `/health` (the core of low #7)', async () => {
  // ⚠️⚠️ **Relay only in the settings, with an HTTP line handed over** (the shape codex reproduced).
  //    ⇒ When the binding was guessed from settings, `/health` was skipped here and it could send to another host.
  const rec = boundWire(undefined, {
    id: 'r',
    label: 'r',
    url: 'https://other.example',
    kind: 'relay' as const,
    relay: { url: 'wss://relay.example', agentPublicKey: QR_KEY },
  })
  await rec.transport.pairDevice({ ...PAIR_BODY, agentPublicKey: QR_KEY })
  assert.equal(rec.calls[0]?.path, '/health', '⚠️⚠️ skipped the check on an unbound line')
})

test('★★ on an unbound line, doesn\'t send if the peer returns a different key (as before)', async () => {
  const rec: Recorded = { calls: [], transport: null as unknown as AgentTransport, subscribed: [], released: 0 }
  const wire: Wire = {
    async request(raw) {
      // ★ The screen language (`?lang=`) is on every request (checked by the dedicated test below). Stripped here for comparison
      const r = { ...raw, path: stripLang(raw.path) }
      rec.calls.push(r)
      return { status: 200, body: r.path === '/health' ? { agentPublicKey: 'べつのかぎ' } : { ok: true } }
    },
    subscribe: () => () => {},
  }
  rec.transport = new AgentTransport(endpoint, wire)
  const res = await rec.transport.pairDevice({ ...PAIR_BODY, agentPublicKey: QR_KEY })
  assert.equal(res.ok, false)
  assert.deepEqual(
    rec.calls.map((c) => c.path),
    ['/health'],
    '⚠️⚠️ sent the one-time token despite a mismatch',
  )
})

test('★★ every request carries the screen language (lang) (the agent returns reasons in that language / 2026-09-23)', async () => {
  const { setLang } = await import('../../../shared/i18n.ts')
  const seen: string[] = []
  const wire: Wire = {
    async request(r) {
      seen.push(r.path)
      return { status: 200, body: { sessions: [], history: { count: 0 } } }
    },
    subscribe: () => () => {},
  }
  const t = new AgentTransport(endpoint, wire)
  setLang('en')
  try {
    await t.listSessions({ history: false }).catch(() => undefined)
    await t.health().catch(() => undefined)
  } finally {
    setLang('ja')
  }
  assert.ok(seen.length >= 2)
  for (const p of seen) assert.match(p, /[?&]lang=en$/, `⚠️ lang missing: ${p}`)
  assert.match(seen[0]!, /^\/sessions\?live=1&lang=en$/, '⚠️ not appended with & after the existing query')
})

test('★★ auto-approve duration is sent as a name only and not attached when turning off (2026-09-24)', async () => {
  const rec = recording(() => ({ status: 200, body: { ok: true } }))
  await rec.transport.setAutoApprove('S1', true, '24h')
  await rec.transport.setAutoApprove('S1', true)
  await rec.transport.setAutoApprove('S1', false, '24h')
  assert.deepEqual(
    rec.calls.map((c) => c.body),
    [{ on: true, duration: '24h' }, { on: true }, { on: false }],
    '⚠️⚠️ duration name not delivered (choosing 24h gives 3h) / duration attached to off',
  )
})
