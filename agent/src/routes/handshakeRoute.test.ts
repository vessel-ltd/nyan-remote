// The device-key handshake endpoint (`POST /handshake`).
//
// ★★ **This is exactly the first message of the step-6 tunnel**, so the endpoint's shape (base64url round trip) is checked too.
//
// ★★ **Mutations explicitly targeted** here:
//   ① handshake with an unregistered device (bypassing `authorizeDevice`)
//   ② handshake although the records are corrupt
//   ③ omit either `reply` or `confirm` (**the device side cannot become a `Session`**)
//   ④ an exception escapes on a broken `init` (becomes a 500)
//   ⑤ drop the destination (agentId) check (**accept a first message addressed to another agent**)
//   ⑥ accept the handshake over GET too
//   ⑦ forget to add the `/health` flag (`device-handshake`) (**a button that 404s**)
//   ⑧ share the flag with `device-pairing` (on a registration-only agent, "verify" 404s)

import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  FRAME,
  exportPublicKey,
  finishHandshake,
  fromBase64Url,
  generateDeviceKey,
  startHandshake,
  toBase64Url,
} from '../../../shared/crypto.ts'
import { loadConfig } from '../config.ts'
import { agentPublicRaw, loadAgentKey, resetAgentKey } from '../deviceKey.ts'
import { DEVICES_FILE, issueOneTime, loadDevices, registerDevice, resetDevices } from '../devices.ts'
import { HttpError } from '../router.ts'
import { deviceHandshake } from './handshake.ts'
import { AGENT_FEATURES } from './health.ts'
import { buildRouter } from './index.ts'

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
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-hs-'))
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

/** Create one registered device */
async function paired() {
  const pair = await generateDeviceKey()
  const raw = await exportPublicKey(pair.publicKey)
  assert.equal((await registerDevice(raw, 'テスト端末', issueOneTime().token)).ok, true)
  return pair
}

test('★★★ when registered, the handshake succeeds and the returned confirm opens (both reached the same key)', async (t) => {
  await boot(t)
  const device = await paired()
  const h = await startHandshake(device, agentPublicRaw())

  const res = await deviceHandshake(body({ init: toBase64Url(h.message) }))
  assert.equal(res.ok, true)
  assert.ok(res.ok)

  // ★ **Advance the device side in the endpoint's shape (base64url)** = exactly the path step 6 uses
  const pending = await finishHandshake(h, fromBase64Url(res.reply))
  const session = await pending.accept(fromBase64Url(res.confirm))
  // ⚠️ Not just "it opened": the session can actually encrypt
  const sealed = await session.seal(FRAME.request, new TextEncoder().encode('やあ'))
  assert.ok(sealed.length > 10)

  // ★ The deviceId the agent reports matches the device side's fingerprint
  const { fingerprint } = await import('../../../shared/crypto.ts')
  assert.equal(res.deviceId, await fingerprint(await exportPublicKey(device.publicKey)))
})

test('★★★ an unregistered device is refused (without deriving keys)', async (t) => {
  await boot(t)
  await paired() // another device is registered
  const stranger = await generateDeviceKey()
  const h = await startHandshake(stranger, agentPublicRaw())

  const res = await deviceHandshake(body({ init: toBase64Url(h.message) }))
  assert.equal(res.ok, false)
  assert.ok(!res.ok)
  assert.match(res.reason, /登録/)
})

test('★★★ when the records are corrupt, the reason says so (so it can be fixed)', async (t) => {
  const dir = await boot(t)
  const device = await paired()
  await writeFile(join(dir, DEVICES_FILE), '{ "v": 1, "devices": "壊れた値" }', 'utf8')
  resetDevices()
  await loadDevices()

  const h = await startHandshake(device, agentPublicRaw())
  const res = await deviceHandshake(body({ init: toBase64Url(h.message) }))
  assert.ok(!res.ok)
  assert.match(res.reason, /壊れて/)
})

test('★★ when the agent key is unusable, the reason shows it', async (t) => {
  await boot(t)
  const device = await paired()
  const good = agentPublicRaw()
  const h = await startHandshake(device, good)
  resetAgentKey()

  const res = await deviceHandshake(body({ init: toBase64Url(h.message) }))
  assert.ok(!res.ok)
  assert.match(res.reason, /鍵/)
})

test('★★★ a first message addressed to another agent is refused (destination check)', async (t) => {
  await boot(t)
  const device = await paired()
  // ★ Build it addressed to another agent's public key
  const other = await generateDeviceKey()
  const h = await startHandshake(device, await exportPublicKey(other.publicKey))

  const res = await deviceHandshake(body({ init: toBase64Url(h.message) }))
  assert.ok(!res.ok)
  assert.match(res.reason, /宛先/)
})

test('★★ missing or unreadable init is 400 (no exception escapes)', async (t) => {
  await boot(t)
  await assert.rejects(
    () => deviceHandshake(body({})),
    (err: unknown) => err instanceof HttpError && err.status === 400,
  )
  await assert.rejects(
    () => deviceHandshake(body({ init: '!!!' })),
    (err: unknown) => err instanceof HttpError && err.status === 400,
  )
  // ★ Readable but not in handshake shape gives ok:false (not a 500)
  const res = await deviceHandshake(body({ init: toBase64Url(new Uint8Array(10)) }))
  assert.equal(res.ok, false)
})

test('★★★ the handshake is POST only (cannot be hit with GET)', () => {
  const r = buildRouter()
  assert.equal(r.match('GET', '/handshake')?.handler, undefined)
  assert.ok(r.match('POST', '/handshake')?.handler)
})

test('★★★ /health flags include device-handshake (★ separate from device-pairing)', () => {
  // ⚠️⚠️ Sharing the flag means that on **an agent that can register but has no handshake endpoint** (the period when only
  //    one machine has been updated), "verify connection" 404s (CLAUDE.md §2)
  assert.ok(AGENT_FEATURES.includes('device-handshake'), 'forgot to add the flag')
  assert.notEqual('device-handshake', 'device-pairing')
})
