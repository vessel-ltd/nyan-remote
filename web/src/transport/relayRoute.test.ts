// Step 6-④-2 of ③: the route via relay (`web/src/transport/relayRoute.ts`).
//
// ★★ **Mutations killed by name** here:
//   ① don't reconnect after a drop (= unusable forever after one disconnect)
//   ② ⚠️⚠️ reconnect but **don't re-establish subscriptions** (looks connected but the screen goes silent)
//   ③ ⚠️⚠️ retry requests (**keystrokes enter the TUI twice**)
//   ④ re-establish an unsubscribed subscription (events that were removed come back)
//   ⑤ **open two lines** for simultaneous requests
//   ⑥ connect even though the key is unusable / no reason shown
//   ⑦ connect even after `close()`

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateDeviceKey } from '../../../shared/crypto.ts'
import type { AgentEvent } from '../../../shared/types.ts'
import type { Identity } from '../identity.ts'
import { relayRoute, type RelayConnect } from './relayRoute.ts'
import type { Wire, WireRequest, WireResponse } from './wire.ts'

interface FakeLine {
  /** Requests that came to this line (★ increases if a **retry** happens) */
  asked: WireRequest[]
  /** Number of subscriptions currently established */
  subs: number
  /** Drop the line (⚠️ an event invisible to the screen) */
  fall(reason: string): void
  /** Pretend something arrived on the line */
  emit(event: AgentEvent): void
  closes: string[]
  /** ⚠️ Stall this line's requests (= create requests that never return) */
  stall: boolean
  /** ★ Endpoints of established subscriptions (2026-09-23 / don't lose the follow endpoint on resubscribe) */
  paths: string[]
  /** ★ The value this line's `eventsLive` returns */
  eventsOk: boolean
}

/** `connect` that hands out fake lines (★ counts how many were connected) */
function fakeConnect(): { connect: RelayConnect; lines: FakeLine[] } {
  const lines: FakeLine[] = []
  const connect: RelayConnect = async ({ onDown }) => {
    const listeners = new Set<(e: AgentEvent) => void>()
    /** ⚠️ Pending requests (★ like the real `relayWire`, on drop they **fail with a reason**) */
    const waiting = new Set<(err: Error) => void>()
    const line: FakeLine = {
      asked: [],
      closes: [],
      stall: false,
      paths: [],
      eventsOk: true,
      get subs() {
        return listeners.size
      },
      fall: (reason) => {
        for (const reject of waiting) reject(new Error(reason))
        waiting.clear()
        onDown(reason)
      },
      emit: (event) => {
        for (const on of listeners) on(event)
      },
    }
    const wire: Wire = {
      request: async (r: WireRequest): Promise<WireResponse> => {
        line.asked.push(r)
        if (line.stall) {
          await new Promise<never>((_, reject) => waiting.add(reject))
        }
        return { status: 200, body: { ok: true } }
      },
      subscribe: (on, path) => {
        line.paths.push(path ?? '/events')
        listeners.add(on)
        return () => listeners.delete(on)
      },
      eventsLive: () => line.eventsOk,
    }
    lines.push(line)
    return { wire, close: (reason) => line.closes.push(reason ?? '') }
  }
  return { connect, lines }
}

async function okIdentity(): Promise<Identity> {
  const pair = await generateDeviceKey()
  return { kind: 'ok', pair, deviceId: 'dev', publicKey: 'pub' }
}

test('★★ connects when a request arrives (★ the second doesn\'t reconnect)', { timeout: 5000 }, async () => {
  const { connect, lines } = fakeConnect()
  const route = relayRoute({
    base: 'wss://relay.test',
    agentPublicKey: 'A',
    identity: okIdentity,
    connect,
  })
  assert.equal(route.state, 'idle')
  assert.equal((await route.request({ method: 'GET', path: '/health' })).status, 200)
  await route.request({ method: 'GET', path: '/sessions' })
  assert.equal(lines.length, 1, `connected ${lines.length} lines`)
  assert.equal(route.state, 'open')
})

test('★★ after the line drops, the next request reconnects (①)', { timeout: 5000 }, async () => {
  const { connect, lines } = fakeConnect()
  const route = relayRoute({
    base: 'wss://relay.test',
    agentPublicKey: 'A',
    identity: okIdentity,
    connect,
  })
  await route.request({ method: 'GET', path: '/health' })
  lines[0]!.fall('切れました')
  assert.equal(route.state, 'down')
  assert.equal(route.lastError, '切れました')

  await route.request({ method: 'GET', path: '/health' })
  assert.equal(lines.length, 2, 'did not reconnect')
  assert.equal(route.state, 'open')
})

test('★★ after reconnecting, subscriptions are re-established (②)', { timeout: 5000 }, async () => {
  const { connect, lines } = fakeConnect()
  const route = relayRoute({
    base: 'wss://relay.test',
    agentPublicKey: 'A',
    identity: okIdentity,
    connect,
  })
  const seen: string[] = []
  const stop = route.subscribe((e) => seen.push(e.type))
  // ⚠️ Subscriptions are established asynchronously (the contract returns the unsubscribe function synchronously)
  await route.request({ method: 'GET', path: '/health' })
  assert.equal(lines[0]!.subs, 1, 'subscription not established')
  lines[0]!.emit({ type: 'sessions-changed', at: '1' })
  assert.deepEqual(seen, ['sessions-changed'])

  // ★ Drop, then reconnect on the next request
  lines[0]!.fall('切れました')
  await route.request({ method: 'GET', path: '/health' })
  assert.equal(lines.length, 2)
  // ⚠️⚠️ This is the point (without resubscribing **the screen goes silent**)
  assert.equal(lines[1]!.subs, 1, '⚠️⚠️ reconnected but the subscription is not established')
  lines[1]!.emit({ type: 'sessions-changed', at: '2' })
  assert.deepEqual(seen, ['sessions-changed', 'sessions-changed'])

  stop()
  assert.equal(lines[1]!.subs, 0, 'could not unsubscribe')
})

test('★★ unsubscribed subscriptions are not re-established (④)', { timeout: 5000 }, async () => {
  const { connect, lines } = fakeConnect()
  const route = relayRoute({
    base: 'wss://relay.test',
    agentPublicKey: 'A',
    identity: okIdentity,
    connect,
  })
  const seen: string[] = []
  const stop = route.subscribe((e) => seen.push(e.type))
  await route.request({ method: 'GET', path: '/health' })
  stop()
  lines[0]!.fall('切れました')
  await route.request({ method: 'GET', path: '/health' })
  assert.equal(lines[1]!.subs, 0, '⚠️ re-established despite unsubscribing')
  lines[1]!.emit({ type: 'sessions-changed', at: '3' })
  assert.deepEqual(seen, [])
})

test('★★ requests are not retried (③ keystrokes are not entered twice)', { timeout: 5000 }, async () => {
  const { connect, lines } = fakeConnect()
  const route = relayRoute({
    base: 'wss://relay.test',
    agentPublicKey: 'A',
    identity: okIdentity,
    connect,
  })
  // ★ First connect one line
  await route.request({ method: 'GET', path: '/health' })
  const line = lines[0]!
  line.stall = true
  // ⚠️ Issue a request that never returns, and drop the line meanwhile
  const sending = route.request({ method: 'POST', path: '/sessions/x/message', body: { text: 'やあ' } })
  // ⚠️ Attach the handler **before dropping** (attaching later causes an "unhandled rejection")
  const rejected = assert.rejects(sending, /送っている最中に切れました/)
  await new Promise((r) => setTimeout(r, 5))
  line.fall('送っている最中に切れました')
  // ★ Even when the next request reconnects, **the earlier request is not resent**
  await route.request({ method: 'GET', path: '/health' })
  assert.equal(lines.length, 2)
  assert.deepEqual(
    lines[1]!.asked.map((r) => r.path),
    ['/health'],
    '⚠️⚠️ keystrokes were resent on the new line',
  )
  // ★ The original request **fails with a reason** (same as the real `relayWire.fail`)
  await rejected
})

test('★★ simultaneous requests don\'t open two lines (⑤)', { timeout: 5000 }, async () => {
  const { connect, lines } = fakeConnect()
  const route = relayRoute({
    base: 'wss://relay.test',
    agentPublicKey: 'A',
    identity: okIdentity,
    connect,
  })
  await Promise.all([
    route.request({ method: 'GET', path: '/a' }),
    route.request({ method: 'GET', path: '/b' }),
    route.request({ method: 'GET', path: '/c' }),
  ])
  assert.equal(lines.length, 1, `connected ${lines.length} lines`)
})

test('★★ if the key is unusable, it doesn\'t connect and shows the reason (⑥)', { timeout: 5000 }, async () => {
  const { connect, lines } = fakeConnect()
  const route = relayRoute({
    base: 'wss://relay.test',
    agentPublicKey: 'A',
    identity: async () => ({ kind: 'broken', reason: '読めません' }),
    connect,
  })
  await assert.rejects(route.request({ method: 'GET', path: '/health' }), /読めません/)
  assert.equal(lines.length, 0, '⚠️⚠️ connected without a key')
  assert.equal(route.state, 'down')
  assert.match(route.lastError ?? '', /読めません/)

  // ⚠️ Once the key is back, the next request connects (= doesn't give up after one failure)
  const route2 = relayRoute({
    base: 'wss://relay.test',
    agentPublicKey: 'A',
    identity: okIdentity,
    connect,
  })
  assert.equal((await route2.request({ method: 'GET', path: '/health' })).status, 200)
})

test('★★ no connecting after close() (⑦)', { timeout: 5000 }, async () => {
  const { connect, lines } = fakeConnect()
  const route = relayRoute({
    base: 'wss://relay.test',
    agentPublicKey: 'A',
    identity: okIdentity,
    connect,
  })
  await route.request({ method: 'GET', path: '/health' })
  route.close('切り替えました')
  assert.deepEqual(lines[0]!.closes, ['切り替えました'], 'line not closed')
  await assert.rejects(route.request({ method: 'GET', path: '/health' }), /閉じ/)
  assert.equal(lines.length, 1, '⚠️⚠️ connected after closing')
})

test('★★ close during connecting discards the line that opens afterwards (⑧ codex round 4)', { timeout: 5000 }, async () => {
  const lines: { closes: string[] }[] = []
  let settle: ((v: { wire: Wire; close(reason?: string): void }) => void) | undefined
  const route = relayRoute({
    base: 'wss://relay.test',
    agentPublicKey: 'A',
    identity: okIdentity,
    // ⚠️ **A connection that never returns** (= still trying to connect)
    connect: async () =>
      await new Promise((resolve) => {
        settle = resolve
      }),
  })
  const asking = route.request({ method: 'GET', path: '/health' })
  const rejected = assert.rejects(asking, /閉じ/)
  // ⚠️ **Don't guess by timing** (if creating the key takes time, `settle` isn't there yet)
  for (let i = 0; i < 400 && settle === undefined; i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.ok(settle, 'did not try to connect')
  route.close('切り替えました')

  // ★ It connects afterwards
  const line = { closes: [] as string[] }
  lines.push(line)
  settle?.({
    wire: { request: async () => ({ status: 200 }), subscribe: () => () => undefined },
    close: (reason) => line.closes.push(reason ?? ''),
  })
  await rejected
  assert.deepEqual(line.closes, ['この接続先は閉じています'], '⚠️⚠️ the line remained after closing')
})

test('★★ the line claims "the peer it is bound to" (codex round 8, low #7 / ㉘)', () => {
  // ⚠️⚠️ Without this `pairDevice` sees it as "unbound" and fetches `/health` first,
  //    which on a pairing-only line **gets 403 and always fails**.
  // ★ Conversely, claiming a different key **could send the one-time token to another agent** (checked by `agent.test.ts`).
  const route = relayRoute({
    base: 'wss://relay.example',
    agentPublicKey: 'このagentのかぎ',
    identity: () => Promise.reject(new Error('使わない')),
    connect: () => Promise.reject(new Error('繋がない')),
  })
  assert.equal(
    route.boundAgentPublicKey,
    'このagentのかぎ',
    '⚠️⚠️ the line does not claim the peer it is bound to',
  )
  route.close()
})

test('★★ the claimed key and the key actually connected to are **one and the same** (codex round 9, low #4)', async () => {
  // ⚠️⚠️ When it claimed the value at creation but re-read it on every connect, a caller mutating the argument
  //    **passed the `pairDevice` check with claimed key A while the handshake was bound to key B** (reproduced by codex).
  const used: string[] = []
  const options = {
    base: 'wss://relay.example',
    agentPublicKey: 'A',
    // ⚠️ Without a key it never reaches `connect` (= nothing can be checked)
    identity: () =>
      Promise.resolve({ kind: 'ok', pair: {}, deviceId: 'd', publicKey: 'p' } as never),
    connect: (a: { agentPublicKey: string }) => {
      used.push(a.agentPublicKey)
      return Promise.reject(new Error('繋がない'))
    },
  }
  const route = relayRoute(options as unknown as Parameters<typeof relayRoute>[0])
  // ⚠️ Mutate after creation (= a shape that can happen by accident or attack)
  options.agentPublicKey = 'B'
  assert.equal(route.boundAgentPublicKey, 'A', 'the claimed value changed')
  await route.request({ method: 'GET', path: '/health' }).catch(() => undefined)
  assert.deepEqual(used, ['A'], '⚠️⚠️ tried to connect to a peer different from the claimed key')
  route.close()
})

test('★★ after reconnecting, the follow subscription is re-established at the same endpoint (doesn\'t turn into the list subscription / 2026-09-23)', { timeout: 5000 }, async () => {
  const { connect, lines } = fakeConnect()
  const route = relayRoute({ base: 'wss://relay.test', agentPublicKey: 'A', identity: okIdentity, connect })
  route.subscribe(() => undefined)
  route.subscribe(() => undefined, '/sessions/S/follow')
  await route.request({ method: 'GET', path: '/health' })
  assert.deepEqual(lines[0]!.paths.sort(), ['/events', '/sessions/S/follow'])
  lines[0]!.fall('切れました')
  await route.request({ method: 'GET', path: '/health' })
  assert.deepEqual(
    lines[1]!.paths.sort(),
    ['/events', '/sessions/S/follow'],
    '⚠️⚠️ resubscribing dropped the follow endpoint (following turned into the list subscription and all notifications flow)',
  )
})

test('★★ eventsLive: only when a line is open and the line side says it is alive (2026-09-24)', { timeout: 5000 }, async () => {
  const { connect, lines } = fakeConnect()
  const route = relayRoute({ base: 'wss://relay.test', agentPublicKey: 'A', identity: okIdentity, connect })
  assert.equal(route.eventsLive?.(), false, '⚠️ claims alive before connecting')
  route.subscribe(() => undefined)
  await route.request({ method: 'GET', path: '/health' })
  assert.equal(route.eventsLive?.(), true)
  lines[0]!.eventsOk = false
  assert.equal(route.eventsLive?.(), false, '⚠️ ignores the line side\'s answer')
  lines[0]!.eventsOk = true
  lines[0]!.fall('切れました')
  assert.equal(route.eventsLive?.(), false, '⚠️⚠️ claims a dropped line is alive (60s stale)')
})
