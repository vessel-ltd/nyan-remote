// Identity from ③'s device key (`via:'device'` in `auth.ts`).
//
// ★★★ **The most important rule is "never take identity from a header".**
//   A form like `x-nyan-device: <public key>` would let **browsers and curl claim it**
//   (`tailscale serve` strips a same-named header coming from outside, but relying on that
//   is "opening a hole before authentication" / CLAUDE.md §1).
//   ⇒ **Only what passed the handshake** becomes a device identity. The mark is a `WeakMap` (keyed by the request itself),
//     and only **connections created by auth.ts** can apply it (`WeakSet` = "an identity that cannot be copied").
//
// ★★ **Mutations targeted by name** here (ran 9 on 2026-09-07 and **all were killed**):
//   ① Let a request without a mark through as a device
//   ② A fake connection (an object of the same shape) can apply the mark
//   ③ Keep the mark as "the last one" instead of per request (it applies to other requests too)
//   ④ Make the registration check a pass-through (`authorizeDevice` → `() => true`)
//   ⑤ Do not report `devices.json` being broken as the reason (**it becomes unfixable**)
//   ⑥ A device can call `/hook` `/permission` (**injection of fake events**)
//   ⑦ `deviceId` is not the public key's fingerprint (Push binding becomes unstable)
//   ⑧ Let device through **before** the 503 for a broken config (bypassing the gate)
//   ⑨ (`shared/crypto.ts`) The `deviceId` returned by the handshake is not derived from the key-agreement peer
//
// ★ **Be honest about what cannot be mutated** (no fake asserts in tests / CLAUDE.md §2):
//   - "Start a handshake while the agent key is unusable" ... there is only the one line `const pair = agentKey()`,
//     and `agentKey()` **throws** when unusable (the decision lives in one place, `deviceKey.ts`).
//     ⇒ No decision here, so nothing to mutate. ★ Not a hole, but the result of "putting the decision in one place".
//
// ★★ **Made `acceptHandshake` return `deviceId`** (same day / `shared/crypto.ts`).
//   ⚠️⚠️ Without it, the caller could only pull it into a variable inside the `authorize` callback
//      = **"the key-agreement peer" and "the identity" take separate paths**, and a mismatch cannot be prevented by types.
//   ★ The wire format did not change, so the KATs stay green (= not a reason to bump the version).

import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  FRAME,
  exportPublicKey,
  fingerprint,
  finishHandshake,
  generateDeviceKey,
  startHandshake,
  toBase64Url,
} from '../../shared/crypto.ts'
import {
  acceptDeviceHandshake,
  authenticate,
  markDeviceRequest,
  type DeviceConnection,
} from './auth.ts'
import { agentPublicRaw, loadAgentKey, resetAgentKey } from './deviceKey.ts'
import {
  DEVICES_FILE,
  issueOneTime,
  loadDevices,
  registerDevice,
  resetDevices,
  revokeDevice,
} from './devices.ts'
import { config, loadConfig } from './config.ts'
import { buildRouter } from './routes/index.ts'

const req = (headers: Record<string, string> = {}, method = 'GET') =>
  ({ method, headers }) as unknown as IncomingMessage

/**
 * Swap the state directory and put the agent in a "started" state.
 * ⚠️ `config.json` is created through the real procedure too (`authenticate` looks at the config).
 */
async function boot(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-devauth-'))
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  const prevDev = process.env['NYAN_REMOTE_DEV']
  process.env['NYAN_REMOTE_STATE_DIR'] = dir
  delete process.env['NYAN_REMOTE_DEV']
  resetAgentKey()
  resetDevices()
  t.after(async () => {
    resetAgentKey()
    resetDevices()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    if (prevDev === undefined) delete process.env['NYAN_REMOTE_DEV']
    else process.env['NYAN_REMOTE_DEV'] = prevDev
    await chmod(dir, 0o700).catch(() => {})
    await rm(dir, { recursive: true, force: true })
    // ⚠️ The config stays in the module, so reload it for the next test
    await loadConfig()
  })
  await loadConfig()
  await loadAgentKey()
  await loadDevices()
  return dir
}

/** ★ Create and register one device (same state as scanning the QR code and pairing) */
async function pairDevice() {
  const pair = await generateDeviceKey()
  const raw = await exportPublicKey(pair.publicKey)
  const added = await registerDevice(raw, 'テスト端末', issueOneTime().token)
  assert.equal(added.ok, true)
  return { pair, raw }
}

/** Run the handshake to completion (up to the device-side confirm) */
async function handshake(pair: Awaited<ReturnType<typeof generateDeviceKey>>) {
  const h = await startHandshake(pair, agentPublicRaw())
  const accepted = await acceptDeviceHandshake(h.message)
  const pending = await finishHandshake(h, accepted.reply)
  const deviceSide = await pending.accept(accepted.confirm)
  return { accepted, deviceSide }
}

test('★★★ requests from a device that passed the handshake are via:"device" (deviceId is the public key fingerprint)', async (t) => {
  await boot(t)
  const { pair, raw } = await pairDevice()
  const { accepted, deviceSide } = await handshake(pair)

  const r = req()
  markDeviceRequest(r, accepted.connection)
  const auth = authenticate(r, { pattern: '/sessions' })
  assert.equal(auth.ok, true)
  assert.ok(auth.ok)
  assert.equal(auth.identity.via, 'device')
  // ★ **Check the value the implementation produces** (compute the fingerprint separately and compare / §14.1.2.4)
  assert.equal(auth.identity.deviceId, await fingerprint(raw))
  assert.equal(auth.rememberLogin, undefined, '⚠️ must not trigger a TOFU record')

  // ★ The session from the handshake is really usable (= identity and crypto come from the same handshake)
  const sealed = await deviceSide.seal(FRAME.request, new TextEncoder().encode('やあ'))
  const opened = await accepted.connection.session.open(sealed)
  assert.equal(new TextDecoder().decode(opened.plaintext), 'やあ')
})

test('★★★ a request without a mark cannot claim to be a device (identity is never taken from headers)', async (t) => {
  await boot(t)
  const { pair, raw } = await pairDevice()
  await handshake(pair) // handshake done, but this request is not marked

  // ⚠️ Adding every "I am a device" header you can think of still does not make it a device
  const claims = req({
    'x-nyan-device': Buffer.from(raw).toString('base64url'),
    'x-nyan-remote-device': Buffer.from(raw).toString('base64url'),
    'x-device-id': 'なりすまし',
    via: 'device',
  })
  const auth = authenticate(claims, { pattern: '/sessions' })
  assert.equal(auth.ok, false, 'no identity header, so it does not pass')
  assert.ok(!auth.ok)
  assert.equal(auth.status, 403)
})

test('★★★ a fake connection cannot apply the mark (only ones created by auth.ts)', async (t) => {
  await boot(t)
  const { pair } = await pairDevice()
  const { accepted } = await handshake(pair)

  // ★ Build an object with the same shape and contents (it type-checks)
  const forged: DeviceConnection = {
    session: accepted.connection.session,
    deviceId: accepted.connection.deviceId,
  }
  const r = req()
  assert.throws(() => markDeviceRequest(r, forged), /握手/)
  assert.equal(authenticate(r, { pattern: '/sessions' }).ok, false, 'no mark was applied')
})

test('★★ the mark only applies to "that request" (not to other requests)', async (t) => {
  await boot(t)
  const { pair } = await pairDevice()
  const { accepted } = await handshake(pair)

  const marked = req()
  const other = req()
  markDeviceRequest(marked, accepted.connection)
  assert.equal(authenticate(marked, { pattern: '/sessions' }).ok, true)
  assert.equal(authenticate(other, { pattern: '/sessions' }).ok, false, '★ must not leak to another request')
})

test('★★★ an unregistered device fails the handshake itself', async (t) => {
  await boot(t)
  await pairDevice() // another device is registered
  const stranger = await generateDeviceKey()
  const h = await startHandshake(stranger, agentPublicRaw())
  await assert.rejects(() => acceptDeviceHandshake(h.message))
})

test('★★★ a revoked device can no longer handshake', async (t) => {
  await boot(t)
  const { pair, raw } = await pairDevice()
  await handshake(pair) // passes for now

  assert.equal((await revokeDevice(toBase64Url(raw))).ok, true)

  const h = await startHandshake(pair, agentPublicRaw())
  await assert.rejects(() => acceptDeviceHandshake(h.message))
})

test('★★★ refuse the handshake if devices.json is broken (★ and say so in the reason)', async (t) => {
  const dir = await boot(t)
  const { pair } = await pairDevice()
  await writeFile(join(dir, DEVICES_FILE), '{ "v": 1, "devices": "壊れた値" }', 'utf8')
  resetDevices()
  await loadDevices()

  const h = await startHandshake(pair, agentPublicRaw())
  await assert.rejects(() => acceptDeviceHandshake(h.message), /壊れて/)
})

test('★★★ do not start a handshake if the agent key is unusable', async (t) => {
  await boot(t)
  const { pair } = await pairDevice()
  const good = agentPublicRaw()
  resetAgentKey() // = not loaded
  const h = await startHandshake(pair, good)
  await assert.rejects(() => acceptDeviceHandshake(h.message), /鍵/)
})

test('★★★ a device cannot call /hook and /permission (prevents fake event injection)', async (t) => {
  await boot(t)
  const { pair } = await pairDevice()
  const { accepted } = await handshake(pair)

  for (const path of ['/hook', '/permission']) {
    const r = req({}, 'POST')
    markDeviceRequest(r, accepted.connection)
    const auth = authenticate(r, { pattern: path })
    assert.equal(auth.ok, false, `${path} must be refused`)
    assert.ok(!auth.ok)
    assert.equal(auth.status, 403)
  }
})

test('★★ the same device always gets the same deviceId (stable Push binding)', async (t) => {
  await boot(t)
  const { pair } = await pairDevice()
  const a = await handshake(pair)
  const b = await handshake(pair)
  assert.equal(a.accepted.connection.deviceId, b.accepted.connection.deviceId)

  // ★ A different device gets a different id
  const second = await pairDevice()
  const c = await handshake(second.pair)
  assert.notEqual(c.accepted.connection.deviceId, a.accepted.connection.deviceId)
})

test('★★ a different session key per handshake (forward secrecy; same identity)', async (t) => {
  await boot(t)
  const { pair } = await pairDevice()
  const a = await handshake(pair)
  const b = await handshake(pair)

  const sealed = await a.deviceSide.seal(FRAME.request, new TextEncoder().encode('x'))
  // ⚠️ Cannot be opened with another handshake's session
  await assert.rejects(() => b.accepted.connection.session.open(sealed))
})

test('★★★ 503 even for device if config.json is broken (keep the existing gate)', async (t) => {
  const dir = await boot(t)
  const { pair } = await pairDevice()
  const { accepted } = await handshake(pair)

  await writeFile(join(dir, 'config.json'), '{ 壊れた', 'utf8')
  await loadConfig()

  const r = req()
  markDeviceRequest(r, accepted.connection)
  const auth = authenticate(r, { pattern: '/sessions' })
  assert.equal(auth.ok, false)
  assert.ok(!auth.ok)
  assert.equal(auth.status, 503)
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★★★ codex round 2, medium #8 on 2026-09-08: revocation did not apply to "connections that already handshaked"
//
// Repro (steps written by codex): handshake and get a connection → `revokeDevice()` succeeds →
//   **mark a new request with that connection** → authentication of `/sessions` passes as **ok**.
// ★ Harmless today (`POST /handshake` discards the connection), but
//   **it becomes a hole the moment step 6's tunnel holds on to the connection** ⇒ close it before the tunnel.
//
// ⇒ The fix is "promote a convention to an invariant": **bind the "registration itself" that passed the handshake to the connection**
//   (the `minted` `WeakMap` = private), and **check on every request authentication that this generation is still alive**.
//   ⚠️⚠️ Do not check "is the key still registered" (**re-registration would revive old connections**).
//
// ★ **Mutations targeted by name** here:
//   ① Authentication ignores the generation (= medium #8 as-is)
//   ② Check by key instead of generation (`has(key)`; **re-registration revives old connections**)
//   ③ Do not 403 a revoked connection but **fall through to the branches below**
//      (⚠️⚠️ with `NYAN_REMOTE_DEV=1` it turns into `via:'dev'` = everything passes)
//   ④ Let existing connections through when the records are broken (fail-open)
//   ⑤ Bind a "copy" to the connection (`{...authorized}` = throws away identity)
//   ⑥ Remove the provenance check in `markDeviceRequest` (`minted.get(connection)!`)
//   ⑦ (`shared/crypto.ts`) The handshake does not carry `authorized` (returns `true`)
//
// ★ **Ran all 7 and all were killed** (2026-09-08; kill counts in ARCHITECTURE §14.1.2.21).
// ⚠️⚠️ ③ **slipped past `web/src/discipline.test.ts` while it stayed green** (the strings remain).
//    ⇒ **Wiring guards only go as far as "notices if deleted". This file is what checks it works.**
//
// ★ **Be honest about what cannot be mutated** too:
//   - "Do not capture the generation when marking; look it up again from the key at authentication" ... gives **the same result** as ②
//     (= not counted as a separate mutation). ★ It captures because there is no way to look it up again
//     in the first place (`DeviceConnection` does not hold the public key).
//   - Turning `authorizeDevice` back into a boolean ... **tsc stops it** (the value type of `minted`).
//     ⇒ A mutation the types cannot express, so no fake assert is added here.
// ─────────────────────────────────────────────────────────────────────────────

/** ★ Revoke (also confirm it succeeded = rule out "fails because revocation did not happen") */
async function revoke(raw: Uint8Array): Promise<void> {
  const res = await revokeDevice(toBase64Url(raw))
  assert.equal(res.ok, true, `revocation itself failed: ${JSON.stringify(res)}`)
}

test('★★★★ revocation applies to "connections that already handshaked" too (codex medium #8)', async (t) => {
  await boot(t)
  const { pair, raw } = await pairDevice()
  const { accepted } = await handshake(pair)

  // Precondition: passes now (= the refusal below is not "never passed from the start")
  const ok = req()
  markDeviceRequest(ok, accepted.connection)
  assert.equal(authenticate(ok, { pattern: '/sessions' }).ok, true)

  // ★ **Mark before revocation** (the shape where the tunnel builds the request and then revocation runs)
  const preMarked = req()
  markDeviceRequest(preMarked, accepted.connection)

  await revoke(raw)

  const before = authenticate(preMarked, { pattern: '/sessions' })
  assert.equal(before.ok, false, '⚠️⚠️ a request marked before revocation passed')
  assert.ok(!before.ok)
  assert.equal(before.status, 403)
  assert.match(before.message, /失効/, '★ the message explains how to fix it')

  // ★ Requests arriving after revocation do not pass either
  const after = req()
  markDeviceRequest(after, accepted.connection)
  assert.equal(authenticate(after, { pattern: '/sessions' }).ok, false)
})

test('★★★★ a revoked connection does not turn into another identity even with NYAN_REMOTE_DEV=1', async (t) => {
  // ⚠️⚠️ Written as "fall through to the branches below" instead of refusing, in development it becomes `via:'dev'`
  //    and **everything passes** (no identity header is exactly what a request through the tunnel looks like).
  await boot(t)
  const { pair, raw } = await pairDevice()
  const { accepted } = await handshake(pair)
  await revoke(raw)

  // ⚠️ `boot`'s cleanup restores it
  process.env['NYAN_REMOTE_DEV'] = '1'
  const r = req()
  markDeviceRequest(r, accepted.connection)
  const auth = authenticate(r, { pattern: '/sessions' })
  assert.equal(auth.ok, false, "⚠️⚠️ a revoked connection turned into via:'dev'")
  assert.ok(!auth.ok)
  assert.equal(auth.status, 403)
})

test('★★★★ re-registering the same key does not revive old connections (re-handshaking passes)', async (t) => {
  await boot(t)
  const { pair, raw } = await pairDevice()
  const old = await handshake(pair)
  await revoke(raw)

  // ★ Show the QR again and register the same device once more (= same key)
  const again = await registerDevice(raw, 'スマホ（もう一度）', issueOneTime().token)
  assert.equal(again.ok, true)

  const r1 = req()
  markDeviceRequest(r1, old.accepted.connection)
  assert.equal(
    authenticate(r1, { pattern: '/sessions' }).ok,
    false,
    '⚠️⚠️ re-registration revived an old connection (checking by key)',
  )

  // ★ Re-handshaking passes (= the refusal above is not "never again")
  const fresh = await handshake(pair)
  const r2 = req()
  markDeviceRequest(r2, fresh.accepted.connection)
  assert.equal(authenticate(r2, { pattern: '/sessions' }).ok, true)
})

test('★★★ if the records are broken, refuse even handshaked connections (fail-closed)', async (t) => {
  const dir = await boot(t)
  const { pair } = await pairDevice()
  const { accepted } = await handshake(pair)

  await writeFile(join(dir, DEVICES_FILE), '{ "v": 1, "devices": "壊れた値" }', 'utf8')
  resetDevices()
  await loadDevices()

  const r = req()
  markDeviceRequest(r, accepted.connection)
  const auth = authenticate(r, { pattern: '/sessions' })
  assert.equal(auth.ok, false, '⚠️ an existing connection passed while the records are broken')
  assert.ok(!auth.ok)
  assert.equal(auth.status, 403)
})

test('★★ revocation only affects the chosen device (other devices stay connected)', async (t) => {
  await boot(t)
  const a = await pairDevice()
  const b = await pairDevice()
  const ha = await handshake(a.pair)
  const hb = await handshake(b.pair)

  await revoke(a.raw)

  const ra = req()
  markDeviceRequest(ra, ha.accepted.connection)
  assert.equal(authenticate(ra, { pattern: '/sessions' }).ok, false)

  const rb = req()
  markDeviceRequest(rb, hb.accepted.connection)
  assert.equal(authenticate(rb, { pattern: '/sessions' }).ok, true, '★ must not drag in other devices')
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★★ codex round 2, high #1 on 2026-09-08: alternate path spellings bypassed local-only
//
// ⚠️⚠️ **The router drops empty segments**, so `/hook/` `/pair//token` hit the same handler, but
//    authentication checked an **exact match of the raw path**, so only those skipped the check (reproduced by measurement):
//
//      /pair/token   → 403 (correct)
//      /pair/token/  → ★ passed with a tailscale identity, **a one-time token was actually issued**
//      /hook/        → ★ passed, **fake events could be injected without the hook token**
//                        = the hole closed on 2026-08-12 was open again
//
// ⇒ **Made the authenticated target and the executed target the same value** (`authenticate` only accepts
//    the result of `router.match()` = a raw path cannot be passed, by type).
// ─────────────────────────────────────────────────────────────────────────────

/** ★ Built in **the same order** as index.ts (this mismatch was the cause, so test the composition) */
function authLikeIndex(req: IncomingMessage, method: string, pathname: string) {
  const router = buildRouter()
  const matched = router.match(method, pathname)
  return { auth: authenticate(req, matched), matched }
}

const tailnetReq = () =>
  ({
    method: 'POST',
    headers: { 'tailscale-user-login': 'me@github', 'x-forwarded-proto': 'https' },
  }) as unknown as IncomingMessage

test('★★★ local-only endpoints do not pass with a tailscale identity even with "alternate spellings"', async (t) => {
  const dir = await boot(t)
  // ★ Add an allowed login (= a state where an ordinary user can get through)
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ allowedLogins: ['me@github'], hookToken: 'x'.repeat(40) }),
    'utf8',
  )
  await loadConfig()

  for (const path of [
    '/pair/token',
    '/pair/token/',
    '/pair//token',
    '/hook',
    '/hook/',
    '/permission',
    '/permission/',
    '//hook',
    // ★ Refreshing the license (2026-09-24 / do not let the phone trigger requests to account)
    '/account/refresh',
    '/account//refresh',
  ]) {
    const { auth, matched } = authLikeIndex(tailnetReq(), 'POST', path)
    // ★ First, it must hit a handler (otherwise this test checks nothing)
    assert.ok(matched, `${path} did not hit a handler (the test is empty)`)
    assert.equal(auth.ok, false, `⚠️⚠️ ${path} passed with a tailscale identity`)
    assert.ok(!auth.ok && auth.status === 403)
  }
})

test('★★★ one-time status and cancellation do not pass with a tailscale identity either (2026-09-23)', async (t) => {
  // ⚠️⚠️ If reachable from the network, a registered phone could **cancel someone else's pairing** / peek at issuance
  const dir = await boot(t)
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ allowedLogins: ['me@github'], hookToken: 'x'.repeat(40) }),
    'utf8',
  )
  await loadConfig()
  const tailnetGet = () =>
    ({ method: 'GET', headers: { 'tailscale-user-login': 'me@github', 'x-forwarded-proto': 'https' } }) as unknown as IncomingMessage
  for (const [method, path, req] of [
    ['GET', '/pair/token/abc', tailnetGet()],
    ['GET', '/pair/token/abc/', tailnetGet()],
    ['POST', '/pair/token/abc/cancel', tailnetReq()],
    ['POST', '/pair//token/abc/cancel', tailnetReq()],
  ] as const) {
    const { auth, matched } = authLikeIndex(req, method, path)
    assert.ok(matched, `${path} did not hit a handler (the test is empty)`)
    assert.equal(auth.ok, false, `⚠️⚠️ ${method} ${path} passed with a tailscale identity`)
    assert.ok(!auth.ok && auth.status === 403)
  }
  // ★ Passes with the hook token (= not always refused)
  const tok = (method: string) => ({ method, headers: { 'x-nyan-remote-token': 'x'.repeat(40) } }) as unknown as IncomingMessage
  assert.equal(authLikeIndex(tok('GET'), 'GET', '/pair/token/abc').auth.ok, true)
  assert.equal(authLikeIndex(tok('POST'), 'POST', '/pair/token/abc/cancel').auth.ok, true)
})

test('★★★ alternate spellings pass with the hook token (= the refusal above is not "always refuse")', async (t) => {
  const dir = await boot(t)
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ allowedLogins: ['me@github'], hookToken: 'x'.repeat(40) }),
    'utf8',
  )
  await loadConfig()
  const withToken = () =>
    ({
      method: 'POST',
      headers: { 'x-nyan-remote-token': 'x'.repeat(40) },
    }) as unknown as IncomingMessage

  for (const path of ['/hook', '/hook/', '/pair/token', '/pair//token']) {
    const { auth } = authLikeIndex(withToken(), 'POST', path)
    assert.equal(auth.ok, true, `${path} does not pass with the token`)
    assert.ok(auth.ok && auth.identity.via === 'local-hook')
  }
})

test('★★ ordinary endpoints pass via tailscale even with alternate spellings (the bypass fix does not block everything)', async (t) => {
  const dir = await boot(t)
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ allowedLogins: ['me@github'], hookToken: 'x'.repeat(40) }),
    'utf8',
  )
  await loadConfig()
  for (const path of ['/sessions', '/sessions/', '/devices', '/devices/']) {
    const { auth } = authLikeIndex(tailnetReq(), 'GET', path)
    assert.equal(auth.ok, true, `${path} does not pass`)
  }
})

test('★★★ the pipeline (serve.ts) passes the route the router resolved (not the raw path)', async () => {
  // ⚠️ Even in `.ts`, **wiring** is hard to hit with mutations, so this one is checked mechanically.
  //    ★ Types guard it too, but this pins down **not going back to passing `url.pathname`**.
  // ★ 2026-09-08: moved `handle` from `index.ts` to `serve.ts` (so the tunnel goes through the same pipeline).
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./serve.ts', import.meta.url), 'utf8')
  assert.match(src, /const auth = authenticate\(req, matchedRoute\)/, 'the resolved route is not passed')
  assert.equal(
    /authenticate\(req, url\.pathname\)/.test(src),
    false,
    '⚠️⚠️ passing the raw path (interpretation diverges from the router)',
  )
  // ★★ **Match only once** (calling it twice seeds "authenticated target" and "executed target" becoming different values)
  assert.equal(
    (src.match(/router\.match\(/g) ?? []).length,
    1,
    '⚠️⚠️ `router.match` is called twice (authenticated and executed targets diverge)',
  )
})

test('★★★★ there is only one request pipeline (do not write a second pipeline for the tunnel)', async () => {
  // ⚠️⚠️ If the broken-config 503, CSRF, authentication and router matching are written in two places,
  //    **only one of them always gets fixed** (a shape this repo has hit many times).
  // ★ So the only place that **calls** `authenticate` is `serve.ts`
  //   (`agent/src/tunnel.ts` goes through `handleRequest`).
  const { readdirSync, readFileSync } = await import('node:fs')
  const dir = new URL('./', import.meta.url)
  const callers: string[] = []
  const walk = (at: URL, prefix: string): void => {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      if (e.isDirectory()) {
        walk(new URL(`${e.name}/`, at), `${prefix}${e.name}/`)
        continue
      }
      if (!e.name.endsWith('.ts') || e.name.endsWith('.test.ts')) continue
      const text = readFileSync(new URL(e.name, at), 'utf8')
      // ⚠️ The definition (`export function authenticate(`) is not counted
      if (/[^.\w]authenticate\(req/.test(text)) callers.push(`${prefix}${e.name}`)
    }
  }
  walk(dir, '')
  assert.deepEqual(callers, ['serve.ts'], `authentication is called from more than one place: ${callers.join(', ')}`)
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★★★ ③ step 7: **pairing via relay** (2026-09-18 / ARCHITECTURE §14.1.4)
//
// ⚠️⚠️ This is **deliberately the place that "hands a real session key to an unregistered peer"**,
//   so we ourselves create **the same shape** of accident that `parseInit` in `shared/crypto.ts` warns about.
//   Only the default deny in `authenticate` stops it. ⇒ The mutations to hit:
//     ⑩ Let unregistered handshakes through without a one-time token (**a permanent back door**)
//     ⑪ Let non-pairing endpoints through on a pairing connection (**full access for an unregistered peer**)
//     ⑫ ⚠️⚠️ Put the pairing check after `via:'dev'` (**everything passes in dev**)
//     ⑬ Treat registered connections as pairing (**registered devices can do nothing**)
//     ⑭ Give pairing connections a registration generation (revocation targets diverge)
// ─────────────────────────────────────────────────────────────────────────────

/** ★ A device not yet registered (= a phone right after scanning the QR code) */
async function unregistered() {
  const pair = await generateDeviceKey()
  return { pair, raw: await exportPublicKey(pair.publicKey) }
}

test('★★★★ without a one-time token, unregistered handshakes are refused as before (⑩ no permanent back door)', async (t) => {
  await boot(t)
  const { pair } = await unregistered()
  const h = await startHandshake(pair, agentPublicRaw())
  // ⚠️⚠️ If this ever passes, **anyone** who knows the agent's public key
  //    could do key agreement at any time = a new permanent entrance
  await assert.rejects(() => acceptDeviceHandshake(h.message), /登録されていないデバイス/)
})

test('★★★★ unregistered devices can handshake only while a one-time token exists (= the 5 minutes the QR is shown on the PC)', async (t) => {
  await boot(t)
  const { pair } = await unregistered()
  issueOneTime() // ★ a person ran `npm run pair`
  const h = await startHandshake(pair, agentPublicRaw())
  const accepted = await acceptDeviceHandshake(h.message)
  // ★ The session is real (= only the agent can read the one-time token inside the envelope = the answer to codex high #1)
  const pending = await finishHandshake(h, accepted.reply)
  const deviceSide = await pending.accept(accepted.confirm)
  const sealed = await deviceSide.seal(FRAME.request, new TextEncoder().encode('ペアリング'))
  const opened = await accepted.connection.session.open(sealed)
  assert.equal(new TextDecoder().decode(opened.plaintext), 'ペアリング')
})

test('★★★★ a pairing-only connection passes only "/pair" (⑪ no full access for an unregistered peer)', async (t) => {
  await boot(t)
  const { pair } = await unregistered()
  issueOneTime()
  const { connection } = await acceptDeviceHandshake(
    (await startHandshake(pair, agentPublicRaw())).message,
  )

  // ★ Only the pairing endpoint passes
  const ok = req({}, 'POST')
  markDeviceRequest(ok, connection)
  const pass = authenticate(ok, { pattern: '/pair' })
  assert.equal(pass.ok, true)
  assert.ok(pass.ok)
  assert.equal(pass.identity.via, 'pairing', '⚠️⚠️ claims to be a device while unregistered')

  // ⚠️⚠️ Everything else is refused (default deny)
  for (const pattern of [
    '/sessions',
    '/health',
    '/devices',
    '/devices/revoke',
    '/pair/token',
    '/sessions/:id/message',
    '/events',
  ]) {
    const r = req({}, 'POST')
    markDeviceRequest(r, connection)
    const got = authenticate(r, { pattern })
    assert.equal(got.ok, false, `⚠️⚠️ ${pattern} passed for an unregistered peer`)
    assert.ok(!got.ok)
    assert.equal(got.status, 403)
  }
})

test('★★★★ pairing connections are not elevated even with NYAN_REMOTE_DEV=1 (⑫ the "everything passes in dev" trap)', async (t) => {
  await boot(t)
  const { pair } = await unregistered()
  issueOneTime()
  const { connection } = await acceptDeviceHandshake(
    (await startHandshake(pair, agentPublicRaw())).message,
  )
  // ⚠️⚠️ The trap CLAUDE.md names: falling through to the branches below turns it into `via:'dev'` and **everything passes**
  process.env['NYAN_REMOTE_DEV'] = '1'
  const r = req({}, 'POST')
  markDeviceRequest(r, connection)
  const got = authenticate(r, { pattern: '/sessions' })
  assert.equal(got.ok, false, '⚠️⚠️ dev mode gave full access to an unregistered peer')
  assert.ok(!got.ok)
  assert.equal(got.status, 403)
})

test('★★★ registered devices are not treated as pairing (⑬ still device even while a one-time token exists)', async (t) => {
  await boot(t)
  const { pair, raw } = await pairDevice()
  issueOneTime() // ★ even while another device is being registered
  const { accepted } = await handshake(pair)
  const r = req()
  markDeviceRequest(r, accepted.connection)
  const got = authenticate(r, { pattern: '/sessions' })
  assert.equal(got.ok, true, '⚠️ a registered device got confined')
  assert.ok(got.ok)
  assert.equal(got.identity.via, 'device')
  assert.equal(got.identity.deviceId, await fingerprint(raw))
})

test('★★★ can register straight from a pairing connection and be a device from then on (end to end)', async (t) => {
  await boot(t)
  const { pair, raw } = await unregistered()
  const token = issueOneTime().token
  // ① Pairing-only connection (unregistered)
  const first = await acceptDeviceHandshake((await startHandshake(pair, agentPublicRaw())).message)
  const r = req({}, 'POST')
  markDeviceRequest(r, first.connection)
  assert.equal(authenticate(r, { pattern: '/pair' }).ok, true)
  // ② Register inside that connection (the real path is the `POST /pair` handler)
  const added = await registerDevice(raw, 'relay で登録した端末', token)
  assert.equal(added.ok, true)
  // ③ After reconnecting, every endpoint is available as a device
  const second = await handshake(pair)
  const r2 = req()
  markDeviceRequest(r2, second.accepted.connection)
  const got = authenticate(r2, { pattern: '/sessions' })
  assert.ok(got.ok)
  assert.equal(got.identity.via, 'device')
  assert.equal(got.identity.deviceId, await fingerprint(raw))
})

test('★★★ after revocation, pairing again works "if a one-time token exists" (⚠️ but it does not go back to device)', async (t) => {
  await boot(t)
  const { pair, raw } = await pairDevice()
  const key = toBase64Url(raw)
  assert.equal((await revokeDevice(key)).ok, true)
  // ⚠️ Right after revocation, without a one-time token, the handshake itself is refused (as before)
  const again = await startHandshake(pair, agentPublicRaw())
  await assert.rejects(() => acceptDeviceHandshake(again.message), /登録されていないデバイス/)
  // ★ If the QR is shown again on the PC, it can connect, but only as pairing-only
  issueOneTime()
  const { connection } = await acceptDeviceHandshake(
    (await startHandshake(pair, agentPublicRaw())).message,
  )
  const r = req({}, 'POST')
  markDeviceRequest(r, connection)
  assert.equal(authenticate(r, { pattern: '/sessions' }).ok, false, '⚠️⚠️ a revoked device was revived')
  const pairReq = req({}, 'POST')
  markDeviceRequest(pairReq, connection)
  assert.equal(authenticate(pairReq, { pattern: '/pair' }).ok, true)
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★★★ Someone on this machine can also manage `/devices` (2026-09-21 / `scripts/devices.mjs`)
//
// ★ Why it is needed: without it, **the machine's owner, even standing in front of it, could not
//   list or revoke their own machine's registrations** (with the phone revoked, lost or its data wiped,
//   there was no way to clean up at all). In the field, 2 dead registrations kept lingering on machine B.
//
// ⚠️ Mutations hit here:
//   ① Ignore the local token (= still cannot clean up from the machine)
//   ② Let a wrong token through
//   ③ ⚠️ Change how requests that do not present a token are handled (breaks the tailnet)
//   ④ ⚠️ `/devices` via a device stops passing (revoking from the phone becomes impossible)
//
// ⚠️⚠️ **"Adding `/hook` to `isLocalAlsoPath`" is not checked here** (added and removed on 2026-09-21).
//   `isLocalAlsoPath` comes **after** `isLocalOnlyPath`, so adding it is **unreachable**
//   = the mutation slips through = **a guard tests cannot kill** (a future change removing it would pass green / §2).
//   ★ The real invariant is "**`/hook` and `/permission` are in `isLocalOnlyPath`**",
//     which the test "a device cannot call /hook and /permission" above checks.
// ─────────────────────────────────────────────────────────────────────────────

test('★★★★ /devices and /devices/revoke pass with this machine\'s token (①)', async (t) => {
  await boot(t)
  const token = config().hookToken
  assert.ok(token, 'precondition: hookToken has been created')
  for (const [path, method] of [
    ['/devices', 'GET'],
    ['/devices/revoke', 'POST'],
  ] as const) {
    const auth = authenticate(req({ 'x-nyan-remote-token': token }, method), { pattern: path })
    assert.ok(auth.ok, `${path} does not pass (cannot clean up from the machine)`)
    assert.equal(auth.identity.via, 'local-hook')
  }
  // ★ Bearer also passes (received the same way as hooks = extracted in one place)
  const bearer = authenticate(req({ authorization: `Bearer ${token}` }), { pattern: '/devices' })
  assert.ok(bearer.ok)
})

test('★★★ a wrong token does not pass (② and does not turn into another route)', async (t) => {
  await boot(t)
  const auth = authenticate(req({ 'x-nyan-remote-token': 'ちがう' }), { pattern: '/devices' })
  assert.equal(auth.ok, false)
  assert.ok(!auth.ok)
  assert.equal(auth.status, 403)
})

test('★★★ handling of requests that do not present a token is unchanged (③ do not break the tailnet)', async (t) => {
  await boot(t)
  // ⚠️ No identity header either = 403 as before (if this passed, anyone could list)
  const bare = authenticate(req(), { pattern: '/devices' })
  assert.equal(bare.ok, false)
  // ★ With a tailnet identity it passes as before
  const tailnet = authenticate(
    req({ 'tailscale-user-login': 'k@example.com', 'x-forwarded-proto': 'https' }),
    { pattern: '/devices' },
  )
  assert.ok(tailnet.ok, 'can no longer list from the tailnet')
  assert.equal(tailnet.identity.via, 'tailscale')
})

test('★★★★ /devices from a device passes as before (④ keep revocation for theft)', async (t) => {
  await boot(t)
  const { pair } = await pairDevice()
  const { accepted } = await handshake(pair)
  const r = req({}, 'POST')
  markDeviceRequest(r, accepted.connection)
  const auth = authenticate(r, { pattern: '/devices/revoke' })
  assert.ok(auth.ok, '⚠️⚠️ can no longer revoke from the phone (theft response is gone)')
  assert.equal(auth.identity.via, 'device')
})

// ★★★★ **The pending-approval list is readable with this machine's token too** (2026-09-23 / `npm run pending`).
//   ⚠️⚠️ Originally it was readable only with a tailnet login, so on machines installed with relay only (machine C, mac)
//      **the pre-restart guard failed every time and could check nothing**.
test('★★★★ GET /permissions is readable with this machine\'s token (the pre-restart guard)', async (t) => {
  await boot(t)
  const token = config().hookToken
  assert.ok(token, 'precondition: hookToken has been created')
  const auth = authenticate(req({ 'x-nyan-remote-token': token }, 'GET'), { pattern: '/permissions' })
  assert.ok(auth.ok, '⚠️⚠️ cannot check pending approvals on a relay-only machine')
  assert.equal(auth.identity.via, 'local-hook')
})

test('★★★★ /permissions is "read only" (⚠️ nothing but GET passes with the token)', async (t) => {
  await boot(t)
  const token = config().hookToken!
  // ⚠️⚠️ Allowing by path shape alone would **silently open** the moment a POST is added in the future
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const auth = authenticate(req({ 'x-nyan-remote-token': token }, method), { pattern: '/permissions' })
    assert.ok(!auth.ok || auth.identity.via !== 'local-hook', `⚠️⚠️ ${method} /permissions passes with the token`)
  }
  // ★ The answering endpoint (/permission/answer) **still** cannot be answered with the token
  const answer = authenticate(req({ 'x-nyan-remote-token': token }, 'POST'), { pattern: '/permission/answer' })
  assert.ok(!answer.ok || answer.identity.via !== 'local-hook', '⚠️⚠️ approvals can be answered with the hook token')
})

// ★★ `/health` is also readable with this machine's token (2026-09-24 / `nyan account` / `nyan login`).
//   ⚠️ Without it, `nyan account` could not read the plan and wrongly said "the agent is old" (on a real machine).
test('★★ GET /health is readable with this machine\'s token; nothing but GET passes', async (t) => {
  await boot(t)
  const token = config().hookToken!
  const ok = authenticate(req({ 'x-nyan-remote-token': token }, 'GET'), { pattern: '/health' })
  assert.ok(ok.ok, '⚠️⚠️ nyan account cannot read the plan')
  assert.equal(ok.identity.via, 'local-hook')
  const post = authenticate(req({ 'x-nyan-remote-token': token }, 'POST'), { pattern: '/health' })
  assert.ok(!post.ok || post.identity.via !== 'local-hook')
  // ⚠️ Without presenting one, it is refused as before
  assert.equal(authenticate(req(), { pattern: '/health' }).ok, false)
})
