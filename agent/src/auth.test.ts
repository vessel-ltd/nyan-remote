import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  blocksCrossOrigin,
  isAllowedOrigin,
  isSameOrigin,
  isUnsafeMethod,
  rejectCrossOrigin,
  sameSecret,
} from './auth.ts'



// ── CSRF / hook token (pins the holes found in the 2026-08-12 review) ─────────

const fakeReq = (method: string, headers: Record<string, string>) =>
  ({ method, headers }) as unknown as import('node:http').IncomingMessage

test('★ isUnsafeMethod: treats anything but GET/HEAD/OPTIONS as a write', () => {
  assert.equal(isUnsafeMethod('GET'), false)
  assert.equal(isUnsafeMethod('get'), false)
  assert.equal(isUnsafeMethod('HEAD'), false)
  assert.equal(isUnsafeMethod('OPTIONS'), false)
  assert.equal(isUnsafeMethod('POST'), true)
  assert.equal(isUnsafeMethod('DELETE'), true)
  assert.equal(isUnsafeMethod(undefined), false)
})

test('★★ blocksCrossOrigin: rejects POSTs from arbitrary websites (prevents subscription hijacking)', () => {
  // Attack path: if a malicious page registers its own endpoint via POST /push/subscribe,
  // deviceId becomes the user's own device IP, so newestPerDevice picks the attacker and
  // notifications to the user silently stop. CORS only prevents reading, so side effects still happen.
  assert.equal(blocksCrossOrigin('POST', 'https://evil.example', false), true)
  // Allowed origins (our own PWA) pass
  assert.equal(blocksCrossOrigin('POST', 'https://pc-a.tailabc123.ts.net', true), false)
})

test('blocksCrossOrigin: GET is out of scope (CORS stops reads)', () => {
  assert.equal(blocksCrossOrigin('GET', 'https://evil.example', false), false)
})

test('★ rejectCrossOrigin: POSTs without Origin pass (notify.sh / curl; browsers always send it)', async () => {
  assert.equal(await rejectCrossOrigin(fakeReq('POST', {})), null)
})

test('★ sameSecret: distinguishes match, mismatch and different lengths (comparison is constant-time)', () => {
  assert.equal(sameSecret('abc', 'abc'), true)
  assert.equal(sameSecret('abc', 'abd'), false)
  // Different lengths must not throw (using timingSafeEqual directly throws)
  assert.equal(sameSecret('abc', 'abcdef'), false)
  assert.equal(sameSecret('', ''), true)
})

test('★★ isSameOrigin: same-origin writes are always allowed (CSRF is a cross-origin attack)', () => {
  // ⚠️ Without this, when served from a non-tailnet origin, POSTs from our own screen get 403.
  //    Actually hit on 2026-08-12 by pressing the approve button with Playwright.
  // In development it is plain http (no X-Forwarded-Proto)
  assert.equal(isSameOrigin('http://127.0.0.1:7788', '127.0.0.1:7788'), true)
  // Via serve it is https (proto is set)
  assert.equal(
    isSameOrigin('https://pc-b.tailabc123.ts.net', 'pc-b.tailabc123.ts.net', 'https'),
    true,
  )
  // Case-insensitive
  assert.equal(
    isSameOrigin('https://PC-B.tailabc123.ts.net', 'pc-b.tailabc123.ts.net', 'https'),
    true,
  )
  // ★ A different host or port is not the same origin
  assert.equal(isSameOrigin('https://evil.example', 'pc-b.tailabc123.ts.net', 'https'), false)
  assert.equal(isSameOrigin('http://127.0.0.1:9999', '127.0.0.1:7788'), false)
  // Malformed input
  assert.equal(isSameOrigin(undefined, 'host'), false)
  assert.equal(isSameOrigin('https://a', undefined), false)
  assert.equal(isSameOrigin('not a url', 'host'), false)
})

test('★★ isSameOrigin: a different scheme is not the same origin (2026-08-13 external review)', () => {
  // ⚠️ Comparing only the host let writes from `http://<same hostname>`
  //    pass as same-origin (skipping the allowlist check).
  const host = 'pc-b.tailabc123.ts.net'
  assert.equal(isSameOrigin(`http://${host}`, host, 'https'), false, 'http Origin to an https target')
  assert.equal(isSameOrigin(`https://${host}`, host, undefined), false, 'https Origin to an http target')
  // Same scheme passes
  assert.equal(isSameOrigin(`https://${host}`, host, 'https'), true)
  assert.equal(isSameOrigin(`http://${host}`, host, undefined), true)
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ The official distribution origin was allowed from the start (2026-09-16 / to move toward Y).
//
//   ⚠️⚠️ **Don't loosen auth** (CORS only decides "can the response be read"). ⚠️ Don't add more (just one).
//   Mutations attacked by name:
//     ① make it a prefix match (`https://nyan-remote.nyan-remote-relay.workers.dev.evil.example` passes)
//     ② also allow http
//     ③ allow anything
// ─────────────────────────────────────────────────────────────────────────────

test('★★ even the official distribution origin is not allowed without configuration (2026-09-18 / codex round 7, high #2)', { timeout: 5000 }, async () => {
  // ⚠️⚠️ **Do not revert this.** Passing here also passes `rejectCrossOrigin()` = **writes too**.
  //    And since `tailscale serve` attaches identity headers, just opening that origin in a
  //    browser on the tailnet **allowed operating the agent without device registration**.
  //    ★ Why it could be removed: pairing moved onto the relay (§14.1.4), so
  //      **the public-origin PWA does not talk HTTP to the agent**.
  const { DISTRIBUTION_ORIGIN } = await import('../../shared/distribution.ts')
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'nyan-auth-'))
  process.env['NYAN_REMOTE_STATE_DIR'] = dir
  const { loadConfig } = await import('./config.ts')
  await loadConfig()
  assert.equal(
    await isAllowedOrigin(DISTRIBUTION_ORIGIN),
    false,
    '⚠️⚠️ the official distribution origin is allowed without configuration (high #2 has come back)',
  )

  // ★ Whether to allow it is **the user's decision** (`allowedOrigins`). ⚠️ Keep that as it was
  //   ⚠️ Add to a config.json created by the real procedure (a hand-built one fails validation and goes into reject mode)
  const { readFile } = await import('node:fs/promises')
  const stored = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))
  stored.allowedOrigins = [DISTRIBUTION_ORIGIN]
  await writeFile(join(dir, 'config.json'), JSON.stringify(stored))
  await loadConfig()
  assert.equal(await isAllowedOrigin(DISTRIBUTION_ORIGIN), true, 'not allowed even after configuring it')

  // ⚠️⚠️ Even when configured, prefix/suffix matching must not fool it (①)
  for (const bad of [
    `${DISTRIBUTION_ORIGIN}.evil.example`,
    `${DISTRIBUTION_ORIGIN}/`,
    `${DISTRIBUTION_ORIGIN}#x`,
    'https://evil.example/nyan-remote.nyan-remote-relay.workers.dev',
    DISTRIBUTION_ORIGIN.replace('https:', 'http:'),
    'https://nyan-remote.nyan-remote-relay.workers.dev.evil.example',
    'https://xnyan-remote.nyan-remote-relay.workers.dev',
  ]) {
    assert.equal(await isAllowedOrigin(bad), false, `⚠️⚠️ slipped through: ${bad}`)
  }
})

test('★★★ a same-tailnet origin is not allowed unless written in allowedOrigins (codex security review, high #2)', { timeout: 5000 }, async () => {
  const { mkdtemp, readFile, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'nyan-auth-tailnet-'))
  process.env['NYAN_REMOTE_STATE_DIR'] = dir
  const { loadConfig } = await import('./config.ts')
  await loadConfig()
  const other = 'https://pc-b.example.ts.net'
  assert.equal(await isAllowedOrigin(other), false, '⚠️⚠️ a tailnet origin is allowed without being listed')
  const stored = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))
  stored.allowedOrigins = [other]
  await writeFile(join(dir, 'config.json'), JSON.stringify(stored))
  await loadConfig()
  assert.equal(await isAllowedOrigin(other), true)
  assert.equal(await isAllowedOrigin('https://pc-c.example.ts.net'), false)
})
