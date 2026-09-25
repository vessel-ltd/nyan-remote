// ★ That this file can exist at all is the result of a fix.
//
// While `AgentTransport`'s constructor used a parameter property (`constructor(readonly endpoint: …)`),
// Node's strip-only mode couldn't handle it, and importing it directly gave
// ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. Vite transforms it, so only production happened to work, and
// **not a single transport test could be written** (found in the review on 2026-08-12).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentTransport } from './agent.ts'
import { probeUrl } from './index.ts'
import { EVENTS_STALE_MS, httpWire } from './http.ts'

/** ★ Strip `?lang=` / `&lang=` (added to every request by the i18n work on 2026-09-23 ⇒ stripped when comparing routes) */
function noLang(u: string): string {
  return u.replace(/[?&]lang=(ja|en)$/, '')
}

const endpoint = { id: 'e1', url: 'https://host.example', label: 'host' }

test('★ AgentTransport can be imported and constructed from node (strip-only regression)', () => {
  const t = new AgentTransport(endpoint)
  assert.equal(t.endpoint.url, 'https://host.example')
  assert.equal(t.endpoint.id, 'e1')
})

/** Swap fetch. Returns a function that restores it */
function stubFetch(impl: typeof fetch): () => void {
  const original = globalThis.fetch
  globalThis.fetch = impl
  return () => {
    globalThis.fetch = original
  }
}

test('★ probeUrl: returns the machine name on response (the screen uses it as the label)', async () => {
  const restore = stubFetch((async (input: string | URL | Request) => {
    assert.equal(noLang(String(input)), 'https://host.example/health')
    return new Response(JSON.stringify({ machine: 'PC-A', accounts: [1, 2, 3] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch)
  try {
    const res = await probeUrl('https://host.example')
    assert.equal(res.ok, true)
    assert.equal(res.machine, 'PC-A')
    assert.equal(res.accounts, 3)
  } finally {
    restore()
  }
})

test('★ probeUrl: returns a reason when there is no response (so "nothing shows until checked" goes away)', async () => {
  const restore = stubFetch((async () => {
    throw new TypeError('Failed to fetch')
  }) as typeof fetch)
  try {
    const res = await probeUrl('https://down.example')
    assert.equal(res.ok, false)
    assert.equal(res.detail, 'Failed to fetch')
    assert.equal(res.machine, undefined)
  } finally {
    restore()
  }
})

test('probeUrl: an HTTP error gives ok=false with the status', async () => {
  const restore = stubFetch((async () => new Response('nope', { status: 403 })) as typeof fetch)
  try {
    const res = await probeUrl('https://forbidden.example')
    assert.equal(res.ok, false)
    assert.equal(res.detail, 'HTTP 403')
  } finally {
    restore()
  }
})

test('probeUrl: does not crash on a response without machine', async () => {
  const restore = stubFetch((async () =>
    new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch)
  try {
    const res = await probeUrl('https://bare.example')
    assert.equal(res.ok, true)
    assert.equal(res.machine, undefined)
  } finally {
    restore()
  }
})

test('★★ listPermissions: keeps pendingTags and at (otherwise cleanup silently breaks)', async () => {
  // ⚠️⚠️ codex medium #5 on 2026-08-20. They were dropped here, so **the app-side cleanup never
  //    received the superset** (= it quietly closed notifications of pending approvals).
  //    ★ Looking only at the canary in `main.tsx` was a false green. **Check the whole path end to end.**
  const restore = stubFetch(
    (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            permissions: [],
            quiet: 1,
            pendingTags: ['perm-M-live'],
            at: '2026-08-20T12:00:00.000Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )) as unknown as typeof fetch,
  )
  try {
    const res = await new AgentTransport(endpoint).listPermissions()
    assert.deepEqual(res.pendingTags, ['perm-M-live'])
    assert.equal(res.at, '2026-08-20T12:00:00.000Z')
    assert.equal(res.quiet, 1)
  } finally {
    restore()
  }
})

test('★ listPermissions: with an old agent (no pendingTags) it is undefined (not an empty array)', async () => {
  // ⚠️ An empty array would read as "no approvals pending" (= toward removing notifications).
  const restore = stubFetch(
    (() =>
      Promise.resolve(
        new Response(JSON.stringify({ permissions: [], quiet: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )) as unknown as typeof fetch,
  )
  try {
    const res = await new AgentTransport(endpoint).listPermissions()
    assert.equal(res.pendingTags, undefined)
    assert.equal(res.at, undefined)
  } finally {
    restore()
  }
})

test('★★ the URLs listSessions actually sends (never confuse filtered and full)', async () => {
  // ⚠️⚠️ The mutation named by codex round 2 on 2026-09-01. Reverting this to `'/sessions'`
  //    **refetches the full history every 15 seconds** = the 87% reduction silently vanishes (all tests stay green).
  // ⚠️ Conversely, making "full" the query-less form means **agents whose default was filtered** (bd59748)
  //    can never return history. ⇒ **Make both explicit**.
  const seen: string[] = []
  const restore = stubFetch(
    ((url: string) => {
      seen.push(noLang(String(url)))
      return Promise.resolve(
        new Response(JSON.stringify({ machine: 'M', sessions: [], history: { count: 0, rev: 'r' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }) as unknown as typeof fetch,
  )
  try {
    const t = new AgentTransport(endpoint)
    await t.listSessions({ history: false })
    await t.listSessions({ history: true })
  } finally {
    restore()
  }
  assert.ok(seen[0]?.endsWith('/sessions?live=1'), `default is not filtered: ${seen[0]}`)
  assert.ok(seen[1]?.endsWith('/sessions?history=1'), `full list not explicit: ${seen[1]}`)
})

test('★★ listSessions: an old agent (no history) doesn\'t crash and is passed through', async () => {
  // ⚠️ Don't fill in `history` (it would confuse 0 items with "old agent")
  const restore = stubFetch(
    (() =>
      Promise.resolve(
        new Response(JSON.stringify({ machine: 'M', sessions: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )) as unknown as typeof fetch,
  )
  try {
    const page = await new AgentTransport(endpoint).listSessions({ history: false })
    assert.equal(page.history, undefined, 'fabricating history')
  } finally {
    restore()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ Pairing: the check right before sending (codex medium #7, 2026-09-08)
//
// ⚠️⚠️ Originally "the check is the caller's responsibility" was only written **in a comment**, so
//    the moment the screen picked the wrong endpoint **the one-time token leaked to another machine**
//    (a mutation changing `transports[at]` to `transports[0]` stayed green).
//    ⇒ **This layer checks right before sending** (omitting it is a type error; if it differs not one byte goes out).
// ─────────────────────────────────────────────────────────────────────────────

const QR_KEY = 'BEiiiiQRのagentのかぎ'
const BODY = { key: 'このたんまつのかぎ', token: 'ワンタイム', label: 'Android' }

/** Fake fetch answering both `/health` and `/pair`. ★ Records every request made */
function stubAgent(healthKey: string | undefined) {
  const seen: { url: string; body?: string }[] = []
  const restore = stubFetch((async (input: string | URL | Request, init?: RequestInit) => {
    const url = noLang(String(input))
    seen.push({ url, body: typeof init?.body === 'string' ? init.body : undefined })
    if (url.endsWith('/health')) {
      return new Response(
        JSON.stringify({ machine: 'HOST', ...(healthKey ? { agentPublicKey: healthKey } : {}) }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify({ ok: true, deviceId: 'abc' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch)
  return { seen, restore }
}

test('★★ sends to an endpoint whose key matches', async () => {
  const { seen, restore } = stubAgent(QR_KEY)
  try {
    const res = await new AgentTransport(endpoint).pairDevice({ ...BODY, agentPublicKey: QR_KEY })
    assert.equal(res.ok, true)
    assert.ok(
      seen.some((r) => r.url.endsWith('/pair')),
      '★ it sends to /pair',
    )
    // ⚠️ Don't mix `agentPublicKey` into the sent body (the agent doesn't use it)
    const pair = seen.find((r) => r.url.endsWith('/pair'))
    assert.equal(pair?.body?.includes('agentPublicKey'), false)
    assert.ok(pair?.body?.includes('ワンタイム'))
  } finally {
    restore()
  }
})

test('★★ sends "not one byte" to an endpoint whose key differs (never leak the one-time token)', async () => {
  const { seen, restore } = stubAgent('べつのマシンのかぎ')
  try {
    const res = await new AgentTransport(endpoint).pairDevice({ ...BODY, agentPublicKey: QR_KEY })
    assert.equal(res.ok, false)
    assert.ok(!res.ok && /マシンではありません/.test(res.reason))
    // ⚠️⚠️ This is the point: **no request to `/pair` went out at all**
    assert.deepEqual(
      seen.filter((r) => r.url.endsWith('/pair')),
      [],
    )
    // ★ The one-time token is on none of the requests
    for (const r of seen) assert.equal(r.body?.includes('ワンタイム') ?? false, false)
  } finally {
    restore()
  }
})

test('★★ also doesn\'t send to an (old) agent that returns no key (fail-closed)', async () => {
  const { seen, restore } = stubAgent(undefined)
  try {
    const res = await new AgentTransport(endpoint).pairDevice({ ...BODY, agentPublicKey: QR_KEY })
    assert.equal(res.ok, false)
    assert.deepEqual(
      seen.filter((r) => r.url.endsWith('/pair')),
      [],
    )
  } finally {
    restore()
  }
})

test('★★ if the QR key is empty, `/health` isn\'t even hit', async () => {
  const { seen, restore } = stubAgent(QR_KEY)
  try {
    const res = await new AgentTransport(endpoint).pairDevice({ ...BODY, agentPublicKey: '' })
    assert.equal(res.ok, false)
    assert.deepEqual(seen, [])
  } finally {
    restore()
  }
})

test('★★ doesn\'t send when the endpoint cannot be verified (returns the reason)', async () => {
  const restore = stubFetch((async () => {
    throw new TypeError('Failed to fetch')
  }) as typeof fetch)
  try {
    const res = await new AgentTransport(endpoint).pairDevice({ ...BODY, agentPublicKey: QR_KEY })
    assert.equal(res.ok, false)
    assert.ok(!res.ok && /確かめられません/.test(res.reason))
  } finally {
    restore()
  }
})

test('★★ eventsLive: only /events lines that are OPEN and recently received something (codex round 17, medium #2)', () => {
  const made: FakeSource[] = []
  class FakeSource {
    static readonly OPEN = 1
    readyState = 0
    onmessage: ((ev: { data: string }) => void) | null = null
    readonly url: string
    constructor(url: string) {
      this.url = url
      made.push(this)
    }
    close(): void {
      this.readyState = 2
    }
  }
  const original = (globalThis as { EventSource?: unknown }).EventSource
  ;(globalThis as { EventSource?: unknown }).EventSource = FakeSource
  try {
    let clock = 1_000
    const wire = httpWire('https://host.example', () => clock)
    assert.equal(wire.eventsLive?.(), false)
    // ★ The follow line doesn't count
    wire.subscribe(() => undefined, '/sessions/s/follow')
    const follow = made[0]!
    follow.readyState = 1
    follow.onmessage?.({ data: '{"type":"hello"}' })
    assert.equal(wire.eventsLive?.(), false, '⚠️⚠️ the follow line claims "the signal is alive"')

    const stop = wire.subscribe(() => undefined)
    const ev = made[1]!
    ev.readyState = 1
    assert.equal(wire.eventsLive?.(), false, '⚠️ claims alive though nothing has arrived yet')
    ev.onmessage?.({ data: '{"type":"hello","machine":"m","at":"T"}' })
    assert.equal(wire.eventsLive?.(), true)
    // ⚠️⚠️ Went silent while OPEN (TCP half-dead)
    clock += EVENTS_STALE_MS
    assert.equal(wire.eventsLive?.(), false, '⚠️⚠️ claims a silent line is alive (the list stays 60s stale)')
    ev.onmessage?.({ data: '{"type":"heartbeat","n":1,"at":"T"}' })
    assert.equal(wire.eventsLive?.(), true)
    // ⚠️ Reconnecting is not alive
    ev.readyState = 0
    assert.equal(wire.eventsLive?.(), false)
    ev.readyState = 1
    stop()
    assert.equal(wire.eventsLive?.(), false, '⚠️ counts an unsubscribed line')
  } finally {
    ;(globalThis as { EventSource?: unknown }).EventSource = original
  }
})
