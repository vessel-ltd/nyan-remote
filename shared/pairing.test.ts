// Building and reading the `nyan://pair?...` string carried in the QR.
//
// ★★ **Building and reading live in the same file** (the agent builds, the PWA reads).
//   ⚠️ With two copies, fixing only one produces **a QR that silently cannot be read**.
//
// ★★ **The reader takes "a string that came from the camera" = hostile input.**
//   ⚠️⚠️ **Never throw, never silently fall back to defaults** (`undefined` when unreadable).
//   ⚠️ `n` (machine name) is **shown on screen**, so it is normalised at the entry.
//
// ★★ Mutations **targeted by name** here:
//   ① version (`v`) not checked (an old PWA misreads a future format)
//   ② scheme and host not checked (accepts `https://evil/pair?...`)
//   ③ public key length not checked (**handshakes with a non-key as the agent's key**)
//   ④ passes without a one-time code (pairing reopens)
//   ⑤ machine name not normalised (control characters reach the screen)
//   ⑥ fails on unknown parameters (★ `r` (relay) could not be added later)
//   ⑦ throws on broken base64url (camera garbage kills the screen)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PUBKEY_BYTES, toBase64Url } from './crypto.ts'
import { PAIR_SCHEME, buildPairUrl, parsePairUrl } from './pairing.ts'

const KEY = toBase64Url(new Uint8Array(PUBKEY_BYTES).fill(7))
const TOKEN = 'Xk2qP9vLzA-_0123456789abcdefghij'

test('★ what was built can be read back (round trip)', () => {
  const url = buildPairUrl({ agentPublicKey: KEY, token: TOKEN, machine: 'pc-a' })
  assert.ok(url.startsWith(`${PAIR_SCHEME}//pair?`), url)
  const got = parsePairUrl(url)
  assert.deepEqual(got, { agentPublicKey: KEY, token: TOKEN, machine: 'pc-a' })
})

test('★★ a machine name with symbols round-trips (it is encoded)', () => {
  const machine = 'pc a/&?=#+日本語'
  const url = buildPairUrl({ agentPublicKey: KEY, token: TOKEN, machine })
  assert.equal(parsePairUrl(url)?.machine, machine)
})

test('★★ a different version is not read (an old PWA does not misread a new format)', () => {
  const url = buildPairUrl({ agentPublicKey: KEY, token: TOKEN, machine: 'k' })
  assert.equal(parsePairUrl(url.replace('v=1', 'v=2')), undefined)
  assert.equal(parsePairUrl(url.replace('v=1&', '')), undefined)
})

test('★★ a different scheme or host is not read', () => {
  const q = `v=1&a=${KEY}&t=${TOKEN}&n=k`
  assert.equal(parsePairUrl(`https://evil.example/pair?${q}`), undefined)
  assert.equal(parsePairUrl(`${PAIR_SCHEME}//evil?${q}`), undefined)
  assert.equal(parsePairUrl(`javascript://pair?${q}`), undefined)
  assert.ok(parsePairUrl(`${PAIR_SCHEME}//pair?${q}`))
})

test('★★ a public key of the wrong length is not read (never target a non-key)', () => {
  const short = toBase64Url(new Uint8Array(64).fill(7))
  assert.equal(parsePairUrl(`${PAIR_SCHEME}//pair?v=1&a=${short}&t=${TOKEN}&n=k`), undefined)
  assert.equal(parsePairUrl(`${PAIR_SCHEME}//pair?v=1&a=&t=${TOKEN}&n=k`), undefined)
})

test('★★ no one-time code means not read (never reopen pairing)', () => {
  assert.equal(parsePairUrl(`${PAIR_SCHEME}//pair?v=1&a=${KEY}&n=k`), undefined)
  assert.equal(parsePairUrl(`${PAIR_SCHEME}//pair?v=1&a=${KEY}&t=&n=k`), undefined)
})

test('★★ the machine name is normalised (control characters dropped, length cut)', () => {
  const dirty = encodeURIComponent(`pc\u0000-a\u007f${'あ'.repeat(200)}`)
  const got = parsePairUrl(`${PAIR_SCHEME}//pair?v=1&a=${KEY}&t=${TOKEN}&n=${dirty}`)
  assert.ok(got)
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/u.test(got.machine), false)
  assert.ok(got.machine.length <= 64)
  assert.ok(got.machine.startsWith('pc-a'))
})

test('★ readable without a machine name (display-only value, so not required)', () => {
  const got = parsePairUrl(`${PAIR_SCHEME}//pair?v=1&a=${KEY}&t=${TOKEN}`)
  assert.equal(got?.machine, '')
})

test('★★ unknown parameters are ignored (readable when old and new sides mix)', () => {
  const got = parsePairUrl(`${PAIR_SCHEME}//pair?v=1&a=${KEY}&t=${TOKEN}&n=k&z=1&zz=2`)
  assert.deepEqual(got, { agentPublicKey: KEY, token: TOKEN, machine: 'k' })
})

test('★★ can carry and read the relay entry point (`r`) (step 6 ④ of ③)', () => {
  const url = buildPairUrl({
    agentPublicKey: KEY,
    token: TOKEN,
    machine: 'pc-a',
    relayUrl: 'wss://relay.example',
  })
  assert.match(url, /[?&]r=wss%3A%2F%2Frelay\.example/)
  assert.deepEqual(parsePairUrl(url), {
    agentPublicKey: KEY,
    token: TOKEN,
    machine: 'pc-a',
    relayUrl: 'wss://relay.example',
  })
  // ★ Absent means not added (= local only. Same shape as old QR codes)
  assert.equal('relayUrl' in (parsePairUrl(buildPairUrl({ agentPublicKey: KEY, token: TOKEN, machine: '' })) ?? {}), false)
})

test('★★ if `r` is present and unreadable, the whole QR is rejected (never silently fall back to local)', () => {
  for (const bad of ['https://x', 'x', 'wss://x?a=1', 'wss://x#y', '', 'ws:', 'wss://u:p@x']) {
    const raw = `${PAIR_SCHEME}//pair?v=1&a=${KEY}&t=${TOKEN}&r=${encodeURIComponent(bad)}`
    assert.equal(parsePairUrl(raw), undefined, `⚠️⚠️ read a broken r (${bad})`)
  }
  // ★ The builder refuses too (**never show people an unreadable QR**)
  assert.throws(
    () => buildPairUrl({ agentPublicKey: KEY, token: TOKEN, machine: '', relayUrl: 'https://x' }),
    /relay/,
  )
})

test('★★ never throws on broken input (the camera reads anything)', () => {
  for (const bad of [
    '',
    'なんでもない文字列',
    'nyan://',
    `${PAIR_SCHEME}//pair`,
    `${PAIR_SCHEME}//pair?`,
    `${PAIR_SCHEME}//pair?v=1&a=!!!&t=${TOKEN}`,
    `${PAIR_SCHEME}//pair?v=1&a=${KEY}&t=${TOKEN}&n=%E3%81`, // broken percent encoding
    'nyan:pair?v=1',
    'x'.repeat(10000),
  ]) {
    assert.doesNotThrow(() => parsePairUrl(bad), `must not throw: ${bad.slice(0, 40)}`)
  }
})

test('★★ the builder also rejects broken inputs (do not build what cannot be built)', () => {
  assert.throws(() => buildPairUrl({ agentPublicKey: 'AAA', token: TOKEN, machine: 'k' }), /鍵/)
  assert.throws(() => buildPairUrl({ agentPublicKey: KEY, token: '', machine: 'k' }), /ワンタイム/)
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ Added `u` (the agent's local entry point) (2026-09-16 / to move toward Y).
//
//   ⚠️⚠️ **When the PWA is served from the public origin, that screen has no agent at all**
//      (its own origin is not a candidate = discipline 1 applies directly).
//      ⇒ **If the first machine cannot be added from a QR, it cannot connect anywhere.**
//   ★ Same rule as `r` (relay): **ignore unknown parameters; if present and unreadable, reject the whole QR.**
//
//   Mutations targeted by name:
//     ① lets `http:` through (makes a route without identity headers an endpoint)
//     ② lets URLs with query, fragment or credentials through
//     ③ silently drops an unreadable `u` and still reads the QR (= nobody knows why it does not connect)
//     ④ keeps the trailing slash (the endpoint id varies and it gets registered twice)
// ─────────────────────────────────────────────────────────────────────────────

const AGENT_URL = 'https://pc-a.example.ts.net'

/** ★ Minimal inputs (⚠️ use values the implementation produces) */
function base() {
  return { agentPublicKey: KEY, token: TOKEN, machine: 'PC-A' }
}

test('★★ can carry `u` and read it back (local entry point of the agent)', () => {
  const url = buildPairUrl({ ...base(), agentUrl: AGENT_URL })
  assert.match(url, /&u=https%3A%2F%2Fpc-a/)
  const back = parsePairUrl(url)
  assert.equal(back?.agentUrl, AGENT_URL)
})

test('★★ a QR without `u` is readable too (backward compatible)', () => {
  const back = parsePairUrl(buildPairUrl(base()))
  assert.ok(back)
  assert.equal(back.agentUrl, undefined)
})

test('★★ an unusable `u` rejects the whole QR (③) / cannot be built (①②)', () => {
  const bad = [
    'http://pc-a.example.ts.net', // ⚠️ no identity headers
    'https://user:pass@pc-a.example', // ⚠️ credentials
    'https://pc-a.example?x=1', // ⚠️ query
    'https://pc-a.example#a', // ⚠️ fragment
    'wss://pc-a.example',
    'javascript:alert(1)',
    'https://',
    'pc-a.example',
  ]
  for (const u of bad) {
    assert.throws(() => buildPairUrl({ ...base(), agentUrl: u }), /接続先/, `could be built: ${u}`)
    // ⚠️⚠️ A hand-edited QR is not read either (= no silent fallback)
    const forged = `${buildPairUrl(base())}&u=${encodeURIComponent(u)}`
    assert.equal(parsePairUrl(forged), undefined, `could be read: ${u}`)
  }
})

test('★★ the trailing slash of `u` is dropped (④ the endpoint id does not vary)', () => {
  const back = parsePairUrl(buildPairUrl({ ...base(), agentUrl: `${AGENT_URL}///` }))
  assert.equal(back?.agentUrl, AGENT_URL)
})
