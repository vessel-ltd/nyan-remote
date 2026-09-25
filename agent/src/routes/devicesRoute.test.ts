// The device-key endpoints for ③ (`GET /devices` / `POST /pair/token` / `POST /pair` / `POST /devices/revoke`).
//
// ★★ **Mutations explicitly targeted** here (10 of them were run on 2026-09-07 and **all failed**.
//   The 7 for `shared/pairing.ts` live in `shared/pairing.test.ts`):
//   ① `/pair/token` can be hit from the network too (a registered phone could add a second one by itself)
//   ② registration is accepted over GET too (**merely following a link** adds a device)
//   ③ show a QR although the agent key is unusable (**a QR that cannot connect**)
//   ④ show a QR although the records are corrupt (keeps people waiting when registration is impossible)
//   ⑤ the list hides "why it is corrupt" (looks like 0 items and cannot be fixed)
//   ⑥ the list hides the agent key problem (you cannot tell why no QR can be shown)
//   ⑦ log the one-time code (journalctl is shown to people)
//   ⑧ the list's `deviceId` is not built from the fingerprint (disagrees with registration's return value)
//   ⑨ an exception escapes on a broken `key` (becomes a 500)
//   ⑩ forget to add the `/health` flag (`device-pairing`) (**a button that 404s** appears)
//   ⑪ ★ **keep the notification subscriptions** after revocation (2026-09-21. FCM returns 201 even for dead endpoints,
//      so **they escape automatic cleanup and remain forever**)
//   ⑫ ★ the revocation cleanup **also drops other devices' subscriptions**
//   ⑬ ★ if the subscription file is corrupt, **the revocation itself fails** (although devices.json is the authority)

import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { exportPublicKey, generateDeviceKey, toBase64Url } from '../../../shared/crypto.ts'
import { parsePairUrl } from '../../../shared/pairing.ts'
import { loadConfig } from '../config.ts'
import { loadAgentKey, resetAgentKey } from '../deviceKey.ts'
import { devicesBroken, loadDevices, resetDevices } from '../devices.ts'
import { addSubscription, listSubscriptions } from '../push.ts'
import { HttpError } from '../router.ts'
import { AGENT_FEATURES, health } from './health.ts'
import { deviceRevoke, devicesList, pairDevice, pairToken } from './devices.ts'
import { buildRouter } from './index.ts'

/** Build a "request" with a JSON body (`readJsonBody` reads an async iterator) */
function body(value: unknown): { req: IncomingMessage } {
  const text = JSON.stringify(value)
  const req = {
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(text, 'utf8')
    },
  }
  return { req: req as unknown as IncomingMessage }
}

async function boot(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-devroute-'))
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = dir
  resetAgentKey()
  resetDevices()
  t.after(async () => {
    resetAgentKey()
    resetDevices()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await chmod(dir, 0o700).catch(() => {})
    await rm(dir, { recursive: true, force: true })
    await loadConfig()
  })
  await loadConfig()
  await loadAgentKey()
  await loadDevices()
  return dir
}

async function newKey(): Promise<string> {
  const pair = await generateDeviceKey()
  return toBase64Url(await exportPublicKey(pair.publicKey))
}

// ─────────────────────────────────────────────────────────────────────────────
// ★★ Routes (which endpoint can be hit by whom)
// ─────────────────────────────────────────────────────────────────────────────

test('★★★ `/pair/token` is in the local-only table (never issued from the network)', async () => {
  // ⚠️⚠️ **The real test is the behavioral one in `agent/src/deviceAuth.test.ts`** (it wires router → auth
  //    in the same order as index.ts and checks that `/pair/token/` and `/pair//token` get 403).
  //    ⇒ In codex round 2 (2026-09-08), high #1, an **exact match on the raw path** let
  //      an alternate spelling slip past the check (reproduced).
  // ★ This only lightly checks "it has not fallen out of the table" (★ and asserts it was found).
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../auth.ts', import.meta.url), 'utf8'),
  )
  const m = /function isLocalOnlyPath\([\s\S]*?\n\}/.exec(src)
  assert.ok(m, 'isLocalOnlyPath not found (the scan is broken)')
  assert.match(m[0], /'\/pair\/token'/, '`/pair/token` is not in the local-only table')
  // ⚠️ It must not have reverted to taking a raw path (the type guards this too, but check here as well)
  assert.equal(
    /isLocalOnlyPath\(pathname: string\)/.test(src),
    false,
    '⚠️⚠️ it has reverted to taking a raw path (its interpretation would disagree with the router)',
  )
})

test('★★★ registration and revocation are POST only (cannot be hit with GET)', () => {
  const router = buildRouter()
  // ⚠️ A GET registration would let **merely following a link** add / remove a device
  assert.equal(router.match('GET', '/pair')?.handler, undefined)
  assert.equal(router.match('GET', '/pair/token')?.handler, undefined)
  assert.equal(router.match('GET', '/devices/revoke')?.handler, undefined)
  // Only the list is GET (a read)
  assert.ok(router.match('GET', '/devices')?.handler, 'the list is readable with GET')
  assert.ok(router.match('POST', '/pair')?.handler)
  assert.ok(router.match('POST', '/pair/token')?.handler)
  assert.ok(router.match('POST', '/devices/revoke')?.handler)
})

test('★★★ `/health` flags include device-pairing (no buttons that 404)', () => {
  // ⚠️⚠️ Machines are updated one by one, so **there is always a period with agents lacking the endpoint**
  //    (CLAUDE.md §2). If the UI shows a button without the flag, it 404s
  assert.ok(AGENT_FEATURES.includes('device-pairing'), 'forgot to add the flag')
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ The agent public key in /health (what the PWA uses to match the destination)
// ─────────────────────────────────────────────────────────────────────────────

test('★★★ the public key in /health equals the key in the QR (the PWA can match the destination)', async (t) => {
  await boot(t)
  const h = await health()
  const qr = parsePairUrl((await pairToken()).url)
  assert.ok(qr, 'the QR can be read')
  // ★ **Look at the values the implementation produces** (compare two values produced by different paths)
  assert.equal(h.agentPublicKey, qr.agentPublicKey)
  assert.ok((h.agentPublicKey ?? '').length > 80)
})

test('★★★ when the key is unusable it is not put in /health (never send to a false destination)', async (t) => {
  await boot(t)
  resetAgentKey() // = not loaded
  const h = await health()
  assert.equal(h.agentPublicKey, undefined, '⚠️ must be omitted (the PWA then says "not found")')
})

// ─────────────────────────────────────────────────────────────────────────────
// Issuing the QR
// ─────────────────────────────────────────────────────────────────────────────

test('★★★ an issued QR reads back and contains the agent key and the one-time code', async (t) => {
  await boot(t)
  const res = await pairToken()
  const got = parsePairUrl(res.url)
  assert.ok(got, `reads back: ${res.url}`)
  assert.equal(got.token, res.token)
  assert.equal(got.machine, res.machine)
  // ★ **Look at the values the implementation produces**: registering with the QR's key can handshake directly
  assert.equal(got.agentPublicKey.length > 80, true)
})

test('★★★ if the agent key is unusable, no QR is shown (never create a QR that cannot connect)', async (t) => {
  await boot(t)
  resetAgentKey() // = not loaded
  await assert.rejects(() => pairToken(), (err: unknown) => {
    assert.ok(err instanceof HttpError)
    assert.equal(err.status, 503)
    return true
  })
})

test('★★★ if the records are corrupt, no QR is shown (do not keep people waiting when registration is impossible)', async (t) => {
  const dir = await boot(t)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(dir, 'devices.json'), '{ "v": 1, "devices": "壊れた値" }', 'utf8')
  resetDevices()
  await loadDevices()
  assert.ok(devicesBroken())
  await assert.rejects(() => pairToken(), /壊れて/)
})

test('★★ the one-time code is not logged (journalctl is shown to people)', async (t) => {
  await boot(t)
  const lines: string[] = []
  const orig = console.log
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(' '))
  try {
    const res = await pairToken()
    assert.ok(lines.length > 0, 'a log line is emitted')
    for (const l of lines) {
      assert.equal(l.includes(res.token), false, `the one-time code appears: ${l}`)
    }
  } finally {
    console.log = orig
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Registration and revocation
// ─────────────────────────────────────────────────────────────────────────────

test('★★★ with a one-time code, registration works and it shows in the list', async (t) => {
  await boot(t)
  const one = await pairToken()
  const key = await newKey()
  const res = await pairDevice(body({ key, token: one.token, label: 'iPhone' }))
  assert.equal(res.ok, true)
  assert.ok(res.ok)
  assert.ok(res.deviceId.length > 20)

  const list = await devicesList()
  assert.equal(list.devices.length, 1)
  assert.equal(list.devices[0]?.key, key)
  assert.equal(list.devices[0]?.label, 'iPhone')
  assert.equal(list.devices[0]?.deviceId, res.deviceId, '★ the id in the list equals registration\'s return value')
  assert.equal(list.broken, undefined)
})

test('★★★ registration fails without a one-time code or with a wrong one', async (t) => {
  await boot(t)
  const one = await pairToken()
  const key = await newKey()

  await assert.rejects(() => pairDevice(body({ key })), /token/)
  const wrong = await pairDevice(body({ key, token: `${one.token}x` }))
  assert.equal(wrong.ok, false)
  assert.deepEqual((await devicesList()).devices, [])

  // ★ The correct one goes through (= the failures above are not "always failing")
  assert.equal((await pairDevice(body({ key, token: one.token }))).ok, true)
})

test('★★★ a second device cannot register with the same one-time code', async (t) => {
  await boot(t)
  const one = await pairToken()
  assert.equal((await pairDevice(body({ key: await newKey(), token: one.token }))).ok, true)
  assert.equal((await pairDevice(body({ key: await newKey(), token: one.token }))).ok, false)
  assert.equal((await devicesList()).devices.length, 1)
})

test('★★ a broken key is 400 (no exception escapes)', async (t) => {
  await boot(t)
  const one = await pairToken()
  for (const key of ['!!!', 'AAA', 'x'.repeat(200)]) {
    const res = await pairDevice(body({ key, token: one.token })).catch((e: unknown) => e)
    if (res instanceof HttpError) {
      assert.equal(res.status, 400, `refused with 400: ${key.slice(0, 8)}`)
    } else {
      assert.equal((res as { ok: boolean }).ok, false, `refused: ${key.slice(0, 8)}`)
    }
  }
})

test('★★ revocation works (the handle is the public key) / an unknown key returns failure', async (t) => {
  await boot(t)
  const one = await pairToken()
  const key = await newKey()
  await pairDevice(body({ key, token: one.token }))

  assert.equal((await deviceRevoke(body({ key }))).ok, true)
  assert.deepEqual((await devicesList()).devices, [])
  assert.equal((await deviceRevoke(body({ key }))).ok, false)
  await assert.rejects(() => deviceRevoke(body({})), /key/)
})

test('★★★ the list does not hide "why it is corrupt" (distinguishable from 0 items)', async (t) => {
  const dir = await boot(t)
  const { writeFile } = await import('node:fs/promises')
  const empty = await devicesList()
  assert.deepEqual(empty.devices, [])
  assert.equal(empty.broken, undefined, '★ plain 0 items shows no reason')

  await writeFile(join(dir, 'devices.json'), '{ "v": 1, "devices": "壊れた値" }', 'utf8')
  resetDevices()
  await loadDevices()
  const broken = await devicesList()
  assert.deepEqual(broken.devices, [])
  assert.ok(broken.broken, '⚠️ when corrupt, a reason is shown')
})

test('★★ the list also shows the agent key problem (the UI can tell why no QR can be shown)', async (t) => {
  await boot(t)
  resetAgentKey()
  const list = await devicesList()
  assert.ok(list.keyProblem)
})

test('★★ if the body is not a JSON object it is 400 (not 500)', async (t) => {
  // ⚠️ codex round 2 (2026-09-08), low. Type arguments are **not runtime checks**, so
  //    a `null` body made the caller's `body.key` a `TypeError`, giving a 500.
  //    ⇒ Made it 400 in one place, `readJsonBody` (writing it per endpoint always misses one).
  await boot(t)
  const { deviceHandshake } = await import('./handshake.ts')
  for (const bad of [null, [], 1, 'x']) {
    for (const [name, fn] of [
      ['/pair', pairDevice],
      ['/devices/revoke', deviceRevoke],
      ['/handshake', deviceHandshake],
    ] as const) {
      await assert.rejects(
        () => fn(body(bad)),
        (err: unknown) => err instanceof HttpError && err.status === 400,
        `${name} does not give 400 for ${JSON.stringify(bad)}`,
      )
    }
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ Revocation also drops notification subscriptions (⑪⑫⑬ / 2026-09-21)
//
// ⚠️⚠️ This is needed because **there is no other cleanup**: send failures only remove on 404/410, and
//    **FCM returns 201 even for dead endpoints** (measured 2026-08-21).
//    ⇒ Subscriptions of a moved origin or a device given away **remain forever**, and
//      `/push/status` shows more devices than there really are, breaking fault isolation.
// ─────────────────────────────────────────────────────────────────────────────

/** ★ Match using the values the implementation produces (do not hand-build fingerprints / §2) */
async function registerWithSubscription(
  t: { after: (fn: () => Promise<void>) => void },
  endpoint: string,
): Promise<{ key: string; deviceId: string }> {
  void t
  const key = await newKey()
  const token = (await pairToken()).token
  const reg = await pairDevice(body({ key, token, label: 'Android' }))
  assert.equal(reg.ok, true, 'not registered (the precondition is broken)')
  const deviceId = (reg as { deviceId: string }).deviceId
  // ⚠️⚠️ **Build it in the same shape as the real thing** (on 2026-09-21 `p256dh` was put at the top level
  //    without creating `keys` and it went green = runtime, where types vanish, cannot notice / §2 "lenient fakes")
  await addSubscription({
    endpoint,
    keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) },
    deviceId,
    login: `device:${deviceId}`,
    createdAt: new Date().toISOString(),
  })
  return { key, deviceId }
}

test('★★ revoking also drops that device\'s subscriptions (⑪ left alone they remain forever)', async (t) => {
  await boot(t)
  const gone = await registerWithSubscription(t, 'https://fcm.googleapis.com/x/old')
  assert.equal((await listSubscriptions()).length, 1, 'precondition: there is 1 subscription')

  assert.equal((await deviceRevoke(body({ key: gone.key }))).ok, true)

  const left = await listSubscriptions()
  assert.deepEqual(
    left.map((s) => s.deviceId),
    [],
    '⚠️⚠️ the subscription remains after revocation (FCM returns 201, so it will never be removed automatically)',
  )
})

test('★★ the revocation cleanup is "that device only" (⑫ do not kill other devices\' notifications)', async (t) => {
  await boot(t)
  const gone = await registerWithSubscription(t, 'https://fcm.googleapis.com/x/old')
  const stay = await registerWithSubscription(t, 'https://fcm.googleapis.com/x/new')
  assert.notEqual(gone.deviceId, stay.deviceId, 'precondition: registered as different devices')
  assert.equal((await listSubscriptions()).length, 2, 'precondition: there are 2 subscriptions')

  assert.equal((await deviceRevoke(body({ key: gone.key }))).ok, true)

  assert.deepEqual(
    (await listSubscriptions()).map((s) => s.deviceId),
    [stay.deviceId],
    '⚠️⚠️ a live device\'s subscription was dropped too (notifications silently stop)',
  )
})

test('★★ revocation succeeds even if the subscription file is corrupt (⑬ devices.json is the authority)', async (t) => {
  const dir = await boot(t)
  const { key } = await registerWithSubscription(t, 'https://fcm.googleapis.com/x/old')
  // ⚠️ Corrupt the subscription file (`subscriptionsForWrite` throws = fail-closed)
  await writeFile(join(dir, 'subscriptions.json'), '{ これは JSON では', 'utf8')

  // ⚠️⚠️ Cleanup is aftercare, so throwing here would mean **the device could not be cut off** (a stolen device could not be cut off)
  assert.equal(
    (await deviceRevoke(body({ key }))).ok,
    true,
    '⚠️⚠️ revocation failed because the subscription file is corrupt (devices.json is the authority)',
  )
  assert.deepEqual(
    (await devicesList()).devices.map((d) => d.label),
    [],
    'the revocation did not actually take effect',
  )
})
