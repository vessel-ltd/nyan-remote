// ★★ Known answers (KAT) for **the two official entry points** (2026-09-18).
//
// ⚠️⚠️ **A failure here means "the entry point changed", not "a bug"** (treated like
//   `RELAY_PING` in `shared/relayFrame.test.ts`). ⇒ Before fixing, check **it does not disagree with what is deployed**.
//
// ★ Why this exists: on 2026-09-18 **a mutation that rewrote the relay default to the distribution URL
//   slipped through** (both live under the same `nyan-remote-relay.workers.dev`, so eyeballing does not catch it).
//   ⚠️⚠️ The symptom of that mistake is "**nobody can connect to relay**", and
//      nothing shows up in the config file, so **the cause is as hard to find as it gets**.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_RELAY_URL, DISTRIBUTION_ORIGIN } from './distribution.ts'
import { isRelayBase } from './relayFrame.ts'

test('★★ both official entry points are known answers (⚠️ changing them disagrees with what is deployed)', () => {
  assert.equal(DISTRIBUTION_ORIGIN, 'https://app.nyan-remote.app')
  assert.equal(DEFAULT_RELAY_URL, 'wss://relay.nyan-remote.app')
})

test('★★ distribution origin and relay are **different hosts** (⚠️⚠️ kills copy-paste mistakes)', () => {
  // ⚠️ The symptom is "nobody can connect to relay", so check by machine what eyes cannot catch
  const pwa = new URL(DISTRIBUTION_ORIGIN).hostname
  const relay = new URL(DEFAULT_RELAY_URL).hostname
  assert.notEqual(relay, pwa, '⚠️⚠️ the relay entry point has the same host as the distribution origin')
})

test('★★ the shapes are right (★ judged by the same `isRelayBase` the implementation uses)', () => {
  // ⚠️ Do not hand-write a regex (two copies next to the implementation drift / CLAUDE.md §2)
  assert.equal(isRelayBase(DEFAULT_RELAY_URL), true, '⚠️⚠️ the default relay has an unusable shape')
  // ⚠️ The distribution origin is an http(s) origin (no trailing slash, path or query)
  const u = new URL(DISTRIBUTION_ORIGIN)
  assert.equal(u.protocol, 'https:')
  assert.equal(DISTRIBUTION_ORIGIN, u.origin, '⚠️ compared by exact match, so add nothing extra')
})

test('★★ the default relay is a WebSocket entry point (⚠️ do not confuse it with https)', () => {
  assert.equal(new URL(DEFAULT_RELAY_URL).protocol, 'wss:')
})

test('★★ the PWA is on **a subdomain, not the apex** (⚠️⚠️ origin granularity / CLAUDE.md §1)', () => {
  // ★ Why this exists: the **same hole** that made us avoid `<user>.github.io` can be created
  //   on our own domain. With the PWA on the apex, adding one landing page to that domain
  //   is enough to **read the device's private key in IndexedDB from the same origin**.
  //   ⚠️⚠️ The symptom appears **on the day the page is added**, not the day the PWA is placed (= unnoticeable).
  const host = new URL(DISTRIBUTION_ORIGIN).hostname
  const labels = host.split('.')
  assert.ok(labels.length >= 3, `⚠️⚠️ the distribution origin is on the apex (${host})`)
  // ⚠️ `www.` tends to be treated as "the same as the apex", so reject it too
  assert.notEqual(labels[0], 'www', '⚠️ www gets treated like the apex (other uses end up there)')

  // ★ A **different subdomain** from relay (the notEqual above looks at the whole host,
  //   this checks "a different branch of the same tree" = it fails even if one is copied into the other)
  const relayHost = new URL(DEFAULT_RELAY_URL).hostname
  assert.notEqual(relayHost.split('.')[0], labels[0], '⚠️⚠️ distribution origin and relay have the same name')
})
