// ★ Make it noticeable when the HTTP wiring breaks (external review, low, 2026-08-14).
//   Until now tests stayed green even with a wrong route path, method or content-type.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentTransport } from './agent.ts'

/** ★ Strip `?lang=` / `&lang=` (added to every request by the i18n work on 2026-09-23 ⇒ stripped when comparing routes) */
function noLang(u: string): string {
  return u.replace(/[?&]lang=(ja|en)$/, '')
}

const endpoint = { id: 'e1', label: 'test', url: 'https://agent.example', kind: 'local' as const }

test('★ pins the target and contents that sendMessage hits', async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: noLang(String(url)), init })
    return new Response(JSON.stringify({ ok: true, at: '2026-08-14T00:00:00.000Z' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  try {
    const t = new AgentTransport(endpoint)
    const r = await t.sendMessage('S 1/2', 'やっといて')
    assert.deepEqual(r, { ok: true, at: '2026-08-14T00:00:00.000Z' })
    assert.equal(calls.length, 1)
    // ★ Session IDs are always escaped (a `/` would turn it into another route)
    assert.equal(calls[0]?.url, 'https://agent.example/sessions/S%201%2F2/message')
    assert.equal(calls[0]?.init.method, 'POST')
    // ⚠️ application/json is needed so the CORS preflight always happens (see auth.ts)
    assert.equal((calls[0]?.init.headers as Record<string, string>)['content-type'], 'application/json')
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { text: 'やっといて' })
  } finally {
    globalThis.fetch = original
  }
})

test('★ on failure, throws the agent\'s reason as-is (to show it on screen)', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: 'このセッションは動いていません' }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
  try {
    await assert.rejects(
      () => new AgentTransport(endpoint).sendMessage('S', 'x'),
      /このセッションは動いていません/,
    )
  } finally {
    globalThis.fetch = original
  }
})

/** ★ Capture the target in one call (instead of repeating fetch swapping per test) */
async function capture(fn: (t: AgentTransport) => Promise<unknown>): Promise<{ url: string; init: RequestInit }> {
  const calls: { url: string; init: RequestInit }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: noLang(String(url)), init })
    return new Response(JSON.stringify({ ok: true, at: '2026-08-25T00:00:00.000Z' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  try {
    await fn(new AgentTransport(endpoint))
  } finally {
    globalThis.fetch = original
  }
  assert.equal(calls.length, 1, 'not called exactly once')
  return calls[0]!
}

test('★★ "stop", "clear input" and "table commands" hit separate endpoints', async () => {
  // ⚠️⚠️ codex round 7, medium #1 on 2026-08-25: there was no URL test for `clearInput`, so
  //    a mutation rewriting `/clear` to `/interrupt` stayed green (= meaning to clear, it stops).
  const stop = await capture((t) => t.interrupt('S 1/2'))
  assert.equal(stop.url, 'https://agent.example/sessions/S%201%2F2/interrupt')
  assert.equal(stop.init.method, 'POST')

  const clear = await capture((t) => t.clearInput('S 1/2'))
  assert.equal(clear.url, 'https://agent.example/sessions/S%201%2F2/clear', 'wrong endpoint for clearing input')
  assert.equal(clear.init.method, 'POST')
  // ⚠️ Neither **has a body** (the screen can't choose the bytes)
  for (const c of [stop, clear]) {
    assert.deepEqual(JSON.parse(String(c.init.body)), {}, 'sending a body')
  }

  const cmd = await capture((t) => t.runCommand('S 1/2', 'compact'))
  assert.equal(cmd.url, 'https://agent.example/sessions/S%201%2F2/command')
  // ⚠️ Table commands send **only the id** (the text is in the agent's table)
  assert.deepEqual(JSON.parse(String(cmd.init.body)), { id: 'compact' })

  // ★ The three are distinct endpoints
  assert.equal(new Set([stop.url, clear.url, cmd.url]).size, 3)
})
