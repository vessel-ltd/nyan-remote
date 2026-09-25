// Step 6-④-2 of ③: how endpoints become `Transport`s (`web/src/transport/index.ts`).
//
// ★★ **Mutations killed by name** here:
//   ① rebuild every time (⚠️⚠️ relay lines pile up and **we eat relay's slots (8) ourselves**)
//   ② don't rebuild when contents change (switching the route keeps the old line)
//   ③ don't close the line when removed from the list (same)
//   ④ choose relay by `kind:'relay'` without the material (= choosing a route that dies silently)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { endpointRoute, mergeRelay, type AgentEndpoint } from '../endpoints.ts'
import { createTransports, probeEndpoint, resetTransports } from './index.ts'
import type { Transport } from './index.ts'

const RELAY = { url: 'wss://relay.test', agentPublicKey: 'AAA' }

/** Fake builder (★ counts how many were built and closed) */
function maker() {
  const built: { endpoint: AgentEndpoint; route: 'local' | 'relay' }[] = []
  const closed: string[] = []
  const make = (e: AgentEndpoint) => {
    built.push({ endpoint: e, route: endpointRoute(e) })
    return {
      transport: { endpoint: e } as unknown as Transport,
      close: () => closed.push(e.id),
    }
  }
  return { make, built, closed }
}

function endpoint(over: Partial<AgentEndpoint> = {}): AgentEndpoint {
  return { id: 'e1', url: 'https://a.example', label: 'A', ...over }
}

test('★★ returns the same one for the same endpoint (① no piling up of lines)', () => {
  resetTransports()
  const m = maker()
  const list = [endpoint()]
  const a = createTransports(list, m.make)
  const b = createTransports([endpoint()], m.make)
  assert.equal(m.built.length, 1, `built ${m.built.length}`)
  assert.equal(a[0], b[0], 'returned a different one for the same endpoint')
  assert.deepEqual(m.closed, [])
  resetTransports()
})

test('★★ rebuilds when the route changes and **closes the old line** (②)', () => {
  resetTransports()
  const m = maker()
  createTransports([endpoint({ relay: RELAY })], m.make)
  createTransports([endpoint({ relay: RELAY, kind: 'relay' })], m.make)
  assert.equal(m.built.length, 2, 'not rebuilt')
  assert.deepEqual(m.built.map((b) => b.route), ['local', 'relay'])
  assert.deepEqual(m.closed, ['e1'], '⚠️⚠️ old line not closed')
  resetTransports()
})

test('★★ closes the line when removed from the list (③)', () => {
  resetTransports()
  const m = maker()
  createTransports([endpoint({ id: 'a' }), endpoint({ id: 'b' })], m.make)
  const left = createTransports([endpoint({ id: 'a' })], m.make)
  assert.equal(left.length, 1)
  assert.deepEqual(m.closed, ['b'], '⚠️⚠️ the removed endpoint\'s line is still open')
  resetTransports()
})

test('★★ `relay` without material falls back to `local` (④ fail-closed)', () => {
  resetTransports()
  const m = maker()
  createTransports([endpoint({ kind: 'relay' })], m.make)
  assert.deepEqual(m.built.map((b) => b.route), ['local'])
  resetTransports()
})

test('★★ `endpointRoute` looks at both the material and `kind`', () => {
  assert.equal(endpointRoute(endpoint()), 'local')
  assert.equal(endpointRoute(endpoint({ relay: RELAY })), 'local', 'merely remembering doesn\'t switch')
  assert.equal(endpointRoute(endpoint({ kind: 'relay' })), 'local', 'local without material')
  assert.equal(endpointRoute(endpoint({ relay: RELAY, kind: 'relay' })), 'relay')
})

test('★★ mixes relay info learned later into the list being edited (without deleting / codex round 4, medium #9)', () => {
  const editing = [endpoint({ id: 'a', label: '編集した' }), endpoint({ id: 'b' })]
  const fresh = [endpoint({ id: 'a', relay: RELAY }), endpoint({ id: 'b' })]
  const merged = mergeRelay(editing, fresh)
  // ⚠️⚠️ The learned entrance goes in (= saving as-is doesn't lose it)
  assert.deepEqual(merged[0]?.relay, RELAY)
  // ★ Human edits are kept
  assert.equal(merged[0]?.label, '編集した')
  assert.equal(merged[1]?.relay, undefined)

  // ⚠️ **Don't delete** (keep what's being edited even if the parent lacks it)
  const kept = mergeRelay([endpoint({ id: 'a', relay: RELAY })], [endpoint({ id: 'a' })])
  assert.deepEqual(kept[0]?.relay, RELAY)
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ Reachability over "the route currently in use" (`probeEndpoint` / 2026-09-16).
//
//   ⚠️⚠️ Hit in practice: switched to relay, yet only the endpoints screen kept saying `Failed to fetch`
//      (the list showed and messages were being sent) = **looks broken while working**.
//   Mutations killed by name:
//     ① hit the local URL even for relay (the original behavior)
//     ② treat merely edited ones (no held line) as relay too
//     ③ swallow line failures and return `ok`
// ─────────────────────────────────────────────────────────────────────────────

test('★★ relay endpoints are checked via the line\'s `health` (① don\'t hit local)', async () => {
  const transports = [
    {
      endpoint: endpoint({ relay: RELAY, kind: 'relay' }),
      health: async () => ({ machine: 'PC-A', accounts: [1, 2, 3] }),
    },
  ] as unknown as Transport[]
  const res = await probeEndpoint(endpoint({ relay: RELAY, kind: 'relay' }), transports)
  // ★ Hitting local would always give `ok: false` (`a.example` doesn't resolve)
  assert.deepEqual(res, { ok: true, machine: 'PC-A', accounts: 3 })
})

test('★★ endpoints without a held line are checked via local (② don\'t widen)', async () => {
  // ⚠️ Something just switched to `relay` on screen and not saved is "not in use yet"
  const res = await probeEndpoint(endpoint({ relay: RELAY, kind: 'relay' }), [])
  // ★ Result of hitting the local URL (always fails in this environment = proof the route wasn't re-chosen)
  assert.equal(res.ok, false)
})

test('★★ returns the reason when the line fails (③ don\'t swallow)', async () => {
  const transports = [
    {
      endpoint: endpoint({ relay: RELAY, kind: 'relay' }),
      health: async () => {
        throw new Error('relay の線が切れました')
      },
    },
  ] as unknown as Transport[]
  const res = await probeEndpoint(endpoint({ relay: RELAY, kind: 'relay' }), transports)
  assert.deepEqual(res, { ok: false, detail: 'relay の線が切れました' })
})

test('★★ local endpoints hit the URL as before', async () => {
  const transports = [
    { endpoint: endpoint(), health: async () => ({ machine: 'だめ' }) },
  ] as unknown as Transport[]
  const res = await probeEndpoint(endpoint(), transports)
  // ⚠️ If `kind` is local, **the line isn't used** (getting `machine: 'だめ'` back means the route was mixed up)
  assert.equal(res.ok, false)
  assert.notEqual(res.machine, 'だめ')
})

test('★★ the route is decided by "the held line" (not by a merely edited `kind` / P4)', async () => {
  // ⚠️⚠️ Switched to `relay` on screen but **not saved yet**.
  //    The line actually in use is local, so the check is local too.
  const inUse = [
    { endpoint: endpoint({ relay: RELAY }), health: async () => ({ machine: '線を使った' }) },
  ] as unknown as Transport[]
  const editing = await probeEndpoint(endpoint({ relay: RELAY, kind: 'relay' }), inUse)
  assert.equal(editing.ok, false, '⚠️ used the line for an unsaved edit')
  assert.notEqual(editing.machine, '線を使った')

  // ★ Same rule in reverse (switched back to `local` but unsaved = still running on the relay line)
  const stillRelay = [
    { endpoint: endpoint({ relay: RELAY, kind: 'relay' }), health: async () => ({ machine: 'relay' }) },
  ] as unknown as Transport[]
  assert.deepEqual(await probeEndpoint(endpoint({ relay: RELAY }), stillRelay), {
    ok: true,
    machine: 'relay',
  })
})
