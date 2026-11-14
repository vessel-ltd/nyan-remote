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
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DEFAULT_RELAY_URL, DISTRIBUTION_ORIGIN, PWA_CSP, PWA_HEADERS, PWA_INLINE_SCRIPT_HASHES, pwaHeadersFile } from './distribution.ts'
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

test('★★ the PWA refuses to be framed, and Y\'s `_headers` carries exactly that table to every path (security audit 2026-09-28, F5)', () => {
  assert.equal(PWA_HEADERS['content-security-policy'], PWA_CSP)
  assert.match(PWA_CSP, /(^|; )frame-ancestors 'none'(;|$)/)
  assert.equal(PWA_HEADERS['x-frame-options'], 'DENY')
  const lines = pwaHeadersFile().split('\n')
  // ⚠️ Cloudflare applies the rules under a path line; the rules must be indented under `/*` (a stray rule is ignored)
  assert.equal(lines[0], '/*')
  for (const [k, v] of Object.entries(PWA_HEADERS)) assert.ok(lines.includes(`  ${k}: ${v}`), `${k} is not in _headers`)
})

/** The directives of the PWA's CSP as a map (name → sources) */
const directives = (csp: string) =>
  new Map(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k!, v]))

test('★★ the PWA CSP: scripts only from this origin and the hashed inline script (2026-11-14)', () => {
  const d = directives(PWA_CSP)
  assert.deepEqual(d.get('script-src'), ["'self'", ...PWA_INLINE_SCRIPT_HASHES])
  assert.deepEqual(d.get('default-src'), ["'self'"])
  for (const k of ['object-src', 'base-uri', 'frame-ancestors', 'frame-src', 'form-action']) assert.deepEqual(d.get(k), ["'none'"], k)
  assert.doesNotMatch(PWA_CSP, /unsafe-inline|unsafe-eval|strict-dynamic|\*/, '⚠️⚠️ a loosened source')
  // ⚠️ Self-hosted relays and tailnet agents live on any host (§1.95) ⇒ connect-src must not be narrowed to ours
  assert.deepEqual(d.get('connect-src'), ["'self'", 'https:', 'wss:', 'ws:'])
})

test('★★ every inline script in web/index.html is in the CSP (editing the theme script changes its hash)', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8')
  const inline = [...html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)].filter((m) => !/\ssrc=/.test(m[1] ?? ''))
  assert.ok(inline.length >= 1, 'the theme script is gone — drop its hash too')
  const hashes = inline.map((m) => `'sha256-${createHash('sha256').update(m[2]!, 'utf8').digest('base64')}'`)
  assert.deepEqual(hashes, [...PWA_INLINE_SCRIPT_HASHES], 'update PWA_INLINE_SCRIPT_HASHES in shared/distribution.ts')
  // ⚠️ No inline event handlers or style attributes (CSP blocks them; they would silently do nothing)
  assert.doesNotMatch(html, /\son[a-z]+=|\sstyle=/i)
})
