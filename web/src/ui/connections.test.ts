import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentEndpoint } from '../endpoints.ts'
import { machineSummary, openAddByDefault, routeName, routeParts, transportIndex } from './connections.ts'

const relayEp: AgentEndpoint = {
  id: 'https://a.ts.net',
  url: 'https://a.ts.net',
  label: 'A',
  relay: { url: 'wss://relay.example', agentPublicKey: 'K' },
  kind: 'relay',
}
const localEp: AgentEndpoint = { id: 'https://b.ts.net', url: 'https://b.ts.net', label: 'B' }

test('★★★ route names are our relay / your relay (host) / Tailscale (⚠️ never shown as local / 2026-09-27)', () => {
  assert.equal(routeName(relayEp), '自分の relay（relay.example）')
  assert.equal(routeName({ ...relayEp, relay: { url: 'wss://relay.nyan-remote.app', agentPublicKey: 'K' } }), 'nyan-remote relay')
  assert.equal(routeName(localEp), 'Tailscale 経由')
  // ★ The route follows the material, not `kind` (no switch any more)
  assert.equal(routeName({ ...relayEp, kind: 'local' }), '自分の relay（relay.example）')
})

test('★★★ line 2 is "route · state" (checking while unknown = never reads as healthy)', () => {
  assert.deepEqual(machineSummary(relayEp, undefined), { text: '自分の relay（relay.example） ・ 確認中…', tone: 'wait' })
  assert.deepEqual(machineSummary(relayEp, { state: 'ok' }), { text: '自分の relay（relay.example） ・ 応答あり', tone: 'ok' })
  assert.deepEqual(machineSummary(relayEp, { state: 'free-used' }), { text: '自分の relay（relay.example） ・ 無料枠は別のマシン', tone: 'off' })
  assert.deepEqual(machineSummary(localEp, { state: 'ng', detail: '時間切れ' }), {
    text: 'Tailscale 経由 ・ 応答なし（時間切れ）',
    tone: 'ng',
  })
})

test('★★★ transport position for an endpoint (⚠️ looked up by id, not name)', () => {
  const transports = [{ endpoint: { id: 'https://a.ts.net' } }, { endpoint: { id: 'https://b.ts.net' } }]
  assert.equal(transportIndex(localEp, transports), 1)
  assert.equal(transportIndex({ ...localEp, id: 'https://new' }, transports), -1)
})

test('★★★ "Add" starts open with zero machines or a broken key', () => {
  assert.equal(openAddByDefault(0, false), true)
  assert.equal(openAddByDefault(3, true), true)
  assert.equal(openAddByDefault(3, false), false)
})

test('★★ the details show only the route in use, with its address (2026-09-27: two addresses read as "both are used")', () => {
  assert.deepEqual(routeParts(relayEp), { name: '自分の relay', address: 'wss://relay.example' }, 'a remembered Tailscale URL must not be shown next to it')
  assert.deepEqual(routeParts({ ...relayEp, relay: { url: 'wss://relay.nyan-remote.app', agentPublicKey: 'K' } }), { name: 'nyan-remote relay', address: 'wss://relay.nyan-remote.app' })
  assert.deepEqual(routeParts(localEp), { name: 'Tailscale', address: 'https://b.ts.net' })
})
