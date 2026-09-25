import assert from 'node:assert/strict'
import { test } from 'node:test'
import { syncEndpointStates, syncSubscriptions } from './endpointStates.ts'

const A = { id: 'a' }
const B = { id: 'b' }
const make = (e: { id: string }) => ({ endpoint: e, sessions: [] as string[] })

test('★★★ an endpoint added by pairing enters the state (⚠️ otherwise fetched results are discarded and never listed)', () => {
  const s0 = { a: { endpoint: A, sessions: ['s1'] } }
  const s1 = syncEndpointStates(s0, [A, B], make)
  assert.deepEqual(Object.keys(s1), ['a', 'b'])
  assert.equal(s1['a'], s0.a, '⚠️ discarded an already-fetched result')
  assert.deepEqual(s1['b']!.sessions, [])
})

test('★★ removed endpoints leave the state, changed ones are replaced, unchanged ones stay the same object', () => {
  const s0 = { a: { endpoint: A, sessions: ['s1'] }, b: { endpoint: B, sessions: [] } }
  assert.deepEqual(Object.keys(syncEndpointStates(s0, [A], make)), ['a'])
  const A2 = { id: 'a', relay: 'wss://x' }
  const s2 = syncEndpointStates(s0, [A2, B], make)
  assert.equal(s2['a']!.endpoint, A2)
  assert.deepEqual(s2['a']!.sessions, ['s1'])
  assert.equal(syncEndpointStates(s0, [A, B], make), s0)
})

test('★★★ signal subscriptions follow endpoints too (subscribe on add, drop on remove, resubscribe on recreate)', () => {
  const log: string[] = []
  const subs = new Map<string, { t: { endpoint: { id: string } }; off: () => void }>()
  const sub = (t: { endpoint: { id: string } }) => {
    log.push(`+${t.endpoint.id}`)
    return () => log.push(`-${t.endpoint.id}`)
  }
  const ta = { endpoint: A }
  const tb = { endpoint: B }
  assert.deepEqual(syncSubscriptions(subs, [ta], sub), ['a'])
  assert.deepEqual(syncSubscriptions(subs, [ta, tb], sub), ['b'], '★ returns only the added ones (the caller fetches immediately)')
  assert.deepEqual(syncSubscriptions(subs, [ta, tb], sub), [])
  const ta2 = { endpoint: A }
  syncSubscriptions(subs, [ta2, tb], sub)
  syncSubscriptions(subs, [ta2], sub)
  assert.deepEqual(log, ['+a', '+b', '-a', '+a', '-b'])
})
