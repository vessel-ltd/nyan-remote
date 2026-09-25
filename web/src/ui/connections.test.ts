import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentEndpoint } from '../endpoints.ts'
import { machineSummary, openAddByDefault, routeName, transportIndex } from './connections.ts'

const relayEp: AgentEndpoint = {
  id: 'https://a.ts.net',
  url: 'https://a.ts.net',
  label: 'A',
  relay: { url: 'wss://relay.example', agentPublicKey: 'K' },
  kind: 'relay',
}
const localEp: AgentEndpoint = { id: 'https://b.ts.net', url: 'https://b.ts.net', label: 'B' }

test('★★★ route names are relay / Tailscale (⚠️ never shown as local)', () => {
  assert.equal(routeName(relayEp), 'relay 経由')
  assert.equal(routeName(localEp), 'Tailscale 経由')
})

test('★★★ line 2 is "route · state" (checking while unknown = never reads as healthy)', () => {
  assert.deepEqual(machineSummary(relayEp, undefined), { text: 'relay 経由 ・ 確認中…', tone: 'wait' })
  assert.deepEqual(machineSummary(relayEp, { state: 'ok' }), { text: 'relay 経由 ・ 応答あり', tone: 'ok' })
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
