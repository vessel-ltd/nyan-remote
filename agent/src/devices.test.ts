// Registered devices (`devices.json`) and the pairing one-time codes.
//
// ★★ **This feature exists to eliminate "pairing reopens when the file breaks"**
//   (ARCHITECTURE §14.1.2.5). With the current TOFU, a broken `config.json` became
//   `allowedLogins: []` = mistaken for first launch, and **whoever came next was registered**.
//   ⇒ The "broken" tests below are **the core**. The happy-path tests are the escort.
//
// ★★ **Mutations explicitly targeted here** (16 run on 2026-09-07 and **all killed**):
//   ① Fall back to zero devices on broken JSON (treating it as registered)
//   ② Naively fall back to zero devices on structural corruption (`Array.isArray(x) ? x : []`)
//      ⇒ the next registration **overwrites the evidence** (CLAUDE.md §2 / same shape as autoApprove medium #6)
//   ③ Do not consume the one-time code (**the same QR works any number of times**)
//   ④ Ignore the one-time code's expiry (a QR left on display is valid forever)
//   ⑤ Include the expiry boundary (`>` to `>=`)
//   ⑥ Do not check that it reads as a public key (**non-key bytes** get registered and the handshake fails forever)
//   ⑦ Do not check key length on the file side (hand-edited rows load silently)
//   ⑧ Put a registration in memory even though saving failed (start accepting what could not be saved)
//   ⑨ Remove serialization of the whole "check → memory → save" section
//      (a registration revives **after** its revocation = same shape as autoApprove's codex high #1)
//   ⑩ Revocation also drops **other devices**
//   ⑪ Do not copy the bytes at the entry point (the caller's buffer is overwritten during an `await`)
//   ⑫ Rewrite `addedAt` on a duplicate registration (overwrite the record)
//   ⑬ Do not normalize the label (raw control characters end up in the file and logs)
//   ⑭ Report revoking a missing key as success
//   ⑮ Throw on a key that is not valid base64url (**startup crashes**)
//   ⑯ Allow duplicates of the same key (one silently vanishes in the `Map`)
//
// ★ **Be honest about equivalent mutations and mutations the type system prevents** (do not add fake asserts to go green / CLAUDE.md §2):
//   - There is **no** redundant check matching by `deviceId` (fingerprint). The `Map` key is
//     **the public key itself**, so a lookup hit = the keys match.
//     ⚠️ Looking up by fingerprint and then comparing bytes would add **a guard no test can kill,
//     since collisions cannot be produced** (the lesson from autoApprove).
//   - The **key-length check that used to sit in `registerDevice` was removed** (2026-09-07).
//     ⚠️ `importPublicKey` gives the same result, so **the mutation survived** = it was a redundant guard.
//   - Changing the one-time comparison from `sameBytes` to `===` is **equivalent** (same result).
//     What it protects is "neither content nor length leaks through timing", which **unit tests cannot observe**.
//     ⚠️ So no fake assert here. ⇒ **Not reverting to `===` is enforced by review.**
//   - The "write while broken" mutation **cannot be written given the types** (`Loaded` cannot hold
//     the set while broken). ⇒ No need to sprinkle redundant `if (broken)` checks.
//     ★ The **observable behavior** (both registration and revocation are refused / the file does not change by a single byte)
//       is still tested below.

import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  FRAME,
  acceptHandshake,
  exportPublicKey,
  finishHandshake,
  generateDeviceKey,
  startHandshake,
  toBase64Url,
} from '../../shared/crypto.ts'
import { generateAgentKey } from './agentKey.ts'
import {
  ONE_TIME_TTL_MS,
  DEVICES_FILE,
  authorizeDevice,
  cancelOneTime,
  isLiveRegistration,
  isRegisteredKey,
  issueOneTime,
  listDevices,
  loadDevices,
  oneTimeCount,
  oneTimeStatus,
  devicesBroken,
  registerDevice,
  resetDevices,
  revokeDevice,
} from './devices.ts'

/** Swap the state directory. ⚠️ So the real `~/.nyan-remote/` is never modified */
async function withStateDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-devices-'))
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = dir
  resetDevices()
  t.after(async () => {
    resetDevices()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await chmod(dir, 0o700).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

async function newPublicRaw(): Promise<Uint8Array> {
  const pair = await generateDeviceKey()
  return await exportPublicKey(pair.publicKey)
}

async function fileJson(dir: string): Promise<{ v?: unknown; devices?: unknown }> {
  return JSON.parse(await readFile(join(dir, DEVICES_FILE), 'utf8'))
}

/** Take a one-time code and register (exactly the happy-path procedure) */
async function pair(raw: Uint8Array, label = 'スマホ', now = Date.now()) {
  const one = issueOneTime(now)
  return await registerDevice(raw, label, one.token, now)
}

// ─────────────────────────────────────────────────────────────────────────────
// ★★ Broken (the reason this feature exists)
// ─────────────────────────────────────────────────────────────────────────────

test('★★ a broken devices.json is "broken", not "zero devices" (never treated as registered)', async (t) => {
  const dir = await withStateDir(t)
  await writeFile(join(dir, DEVICES_FILE), '{ これは JSON ではない', 'utf8')
  await loadDevices()

  assert.ok(devicesBroken(), 'a reason for being broken is reported')
  assert.deepEqual(listDevices(), [])
  assert.equal(isRegisteredKey(await newPublicRaw()), false)
})

test('★★ while broken, both registration and revocation are refused (evidence is not overwritten = pairing does not reopen)', async (t) => {
  const dir = await withStateDir(t)
  const broken = '{ "v": 1, "devices": "壊れた値" }'
  await writeFile(join(dir, DEVICES_FILE), broken, 'utf8')
  await loadDevices()
  assert.ok(devicesBroken())

  const raw = await newPublicRaw()
  const added = await pair(raw)
  assert.equal(added.ok, false)
  const removed = await revokeDevice('なんでもよい')
  assert.equal(removed.ok, false)

  // ★★ **The file has not changed by a single byte** (the evidence remains)
  assert.equal(await readFile(join(dir, DEVICES_FILE), 'utf8'), broken)
  assert.equal(isRegisteredKey(raw), false)
})

test('★★ valid JSON with a broken structure is still "broken" (v / devices / each element)', async (t) => {
  const dir = await withStateDir(t)
  const cases = [
    '{ "devices": [] }', // no v
    '{ "v": 2, "devices": [] }', // unknown version
    '{ "v": 1 }', // no devices
    '{ "v": 1, "devices": {} }', // not an array
    '{ "v": 1, "devices": [null] }',
    '{ "v": 1, "devices": [{ "label": "x", "addedAt": "2026-09-07T00:00:00.000Z" }] }', // no key
    '{ "v": 1, "devices": [{ "key": "AAA", "label": 1, "addedAt": "2026-09-07T00:00:00.000Z" }] }',
    '{ "v": 1, "devices": [{ "key": "AAA", "label": "x", "addedAt": "きのう" }] }', // unparseable time
    // ★ key length is not that of a raw P-256 public key (65 bytes) (hand-edited or corrupted file)
    '{ "v": 1, "devices": [{ "key": "AAA", "label": "x", "addedAt": "2026-09-07T00:00:00.000Z" }] }',
    '{ "v": 1, "devices": [{ "key": "!!!", "label": "x", "addedAt": "2026-09-07T00:00:00.000Z" }] }',
  ]
  for (const body of cases) {
    resetDevices()
    await writeFile(join(dir, DEVICES_FILE), body, 'utf8')
    await loadDevices()
    assert.ok(devicesBroken(), `should be treated as broken: ${body}`)
  }
})

test('★★ a file with the same key on two rows is treated as broken (one must not silently vanish in the Map)', async (t) => {
  const dir = await withStateDir(t)
  await loadDevices()
  const raw = await newPublicRaw()
  await pair(raw, 'A')
  const one = listDevices()[0]!
  resetDevices()
  await writeFile(join(dir, DEVICES_FILE), JSON.stringify({ v: 1, devices: [one, one] }), 'utf8')
  await loadDevices()
  assert.ok(devicesBroken())
  assert.equal(isRegisteredKey(raw), false)
})

test('★★ one 65-byte entry that "does not read as a key" makes the whole file broken', async (t) => {
  // ⚠️⚠️ 2026-09-08 codex medium #4. **Only the length was checked**, so an invalid 65-byte value
  //    (all zeros = not a P-256 point) loaded as "valid".
  //    "Checked at registration" is **no justification once the file has been corrupted**.
  const dir = await withStateDir(t)
  await loadDevices()
  const raw = await newPublicRaw()
  await pair(raw, '正しい端末')
  const good = JSON.parse(await readFile(join(dir, DEVICES_FILE), 'utf8'))

  // ★ a valid row + a 65-byte junk row
  const junk = toBase64Url(new Uint8Array(65))
  resetDevices()
  await writeFile(
    join(dir, DEVICES_FILE),
    JSON.stringify({
      v: 1,
      devices: [...good.devices, { key: junk, label: 'ゴミ', addedAt: good.devices[0].addedAt }],
    }),
    'utf8',
  )
  await loadDevices()

  assert.ok(devicesBroken(), '⚠️ a reason for being broken is reported')
  assert.deepEqual(listDevices(), [], '★ valid rows are not loaded either (never expose a partially filled map)')
  assert.equal(isRegisteredKey(raw), false, '★ authentication of the valid key stops too')
  // ⚠️ writes are refused as well (keep the evidence)
  assert.equal((await revokeDevice(toBase64Url(raw))).ok, false)
})

test('★★ a file with only valid keys loads (the check above is not "always broken")', async (t) => {
  await withStateDir(t)
  await loadDevices()
  const raw = await newPublicRaw()
  await pair(raw, '正しい端末')
  resetDevices()
  await loadDevices()
  assert.equal(devicesBroken(), undefined)
  assert.equal(isRegisteredKey(raw), true)
})

test('★★ a non-canonical key encoding is treated as broken (never create "listed but cannot authenticate")', async (t) => {
  // ⚠️⚠️ 2026-09-08 codex round 2, medium #2 (reproduced by measurement).
  //    With a trailing `=`, `fromBase64Url` and `importPublicKey` still accept it, but
  //    authentication looks up by `toBase64Url(raw)` (no padding), so **it never matches**:
  //      devicesBroken() === undefined / listDevices().length === 1 /
  //      isRegisteredKey(original key) === false
  //    ⇒ **Accept only the encoding a correct writer produces** (do not silently fix it).
  const dir = await withStateDir(t)
  await loadDevices()
  const raw = await newPublicRaw()
  await pair(raw, '正しい端末')
  const good = JSON.parse(await readFile(join(dir, DEVICES_FILE), 'utf8'))

  resetDevices()
  await writeFile(
    join(dir, DEVICES_FILE),
    JSON.stringify({
      v: 1,
      devices: [{ ...good.devices[0], key: `${good.devices[0].key}=` }],
    }),
    'utf8',
  )
  await loadDevices()

  assert.ok(devicesBroken(), '⚠️ should be treated as broken')
  assert.deepEqual(listDevices(), [], '★ never create the "listed but cannot authenticate" shape')
  assert.equal(isRegisteredKey(raw), false)
})

test('★ a missing file means first launch (not broken, and nothing is written)', async (t) => {
  const dir = await withStateDir(t)
  await loadDevices()
  assert.equal(devicesBroken(), undefined)
  assert.deepEqual(listDevices(), [])
  await assert.rejects(() => readFile(join(dir, DEVICES_FILE), 'utf8'), /ENOENT/)
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ One-time codes (the QR's `t`)
// ─────────────────────────────────────────────────────────────────────────────

test('★★ a one-time code works only once (the second registration is refused)', async (t) => {
  await withStateDir(t)
  await loadDevices()
  const one = issueOneTime()
  const a = await newPublicRaw()
  const b = await newPublicRaw()

  assert.equal((await registerDevice(a, 'A', one.token)).ok, true)
  const second = await registerDevice(b, 'B', one.token)
  assert.equal(second.ok, false, 'a second device cannot register with the same QR')
  assert.equal(isRegisteredKey(b), false)
})

test('★★ an expired one-time code is refused (a QR left on display does not work)', async (t) => {
  await withStateDir(t)
  await loadDevices()
  const now = Date.parse('2026-09-07T10:00:00.000Z')
  const raw = await newPublicRaw()

  // Boundary: refused exactly at the expiry
  const a = issueOneTime(now)
  assert.equal((await registerDevice(raw, 'x', a.token, now + ONE_TIME_TTL_MS)).ok, false)
  const b = issueOneTime(now)
  assert.equal((await registerDevice(raw, 'x', b.token, now + ONE_TIME_TTL_MS - 1)).ok, true)
})

test('★★ one-time codes are not kept in the file (= pairing cannot be revived from an old or broken file)', async (t) => {
  const dir = await withStateDir(t)
  await loadDevices()
  const one = issueOneTime()
  const raw = await newPublicRaw()
  await pair(await newPublicRaw(), 'ほかの端末') // make it create the file

  const body = await readFile(join(dir, DEVICES_FILE), 'utf8')
  assert.equal(body.includes(one.token), false, 'the one-time code is not written to the file')

  // ★ Restart (memory is cleared) ⇒ issued one-time codes are invalid
  resetDevices()
  await loadDevices()
  assert.equal(oneTimeCount(), 0)
  assert.equal((await registerDevice(raw, 'x', one.token)).ok, false)
})

test('★★ only the code that was used is consumed (other issued codes stay alive)', async (t) => {
  await withStateDir(t)
  await loadDevices()
  const one = issueOneTime()
  const two = issueOneTime()
  assert.equal(oneTimeCount(), 2)

  assert.equal((await registerDevice(await newPublicRaw(), 'x', one.token)).ok, true)
  assert.equal(oneTimeCount(), 1)
  assert.equal((await registerDevice(await newPublicRaw(), 'y', two.token)).ok, true)
  assert.equal(oneTimeCount(), 0)
})

test('★★ expired one-time codes do not pile up (sweep. ⚠️ the decision rests on the expiry itself)', async (t) => {
  await withStateDir(t)
  await loadDevices()
  const now = Date.parse('2026-09-07T10:00:00.000Z')
  issueOneTime(now)
  issueOneTime(now)
  assert.equal(oneTimeCount(now), 2)
  assert.equal(oneTimeCount(now + ONE_TIME_TTL_MS), 0, 'expired ones count as 0 at the time of counting')
  // The sweep runs alongside issuing (so they do not pile up)
  issueOneTime(now + ONE_TIME_TTL_MS)
  assert.equal(oneTimeCount(now + ONE_TIME_TTL_MS), 1)
})

test('★★ empty, wrong-length and one-character-off one-time codes are refused', async (t) => {
  await withStateDir(t)
  await loadDevices()
  const one = issueOneTime()
  const raw = await newPublicRaw()
  const last = one.token.slice(-1)
  const flipped = `${one.token.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`

  assert.equal((await registerDevice(raw, 'x', '')).ok, false)
  assert.equal((await registerDevice(raw, 'x', `${one.token}x`)).ok, false)
  assert.equal((await registerDevice(raw, 'x', one.token.slice(0, -1))).ok, false)
  assert.equal((await registerDevice(raw, 'x', flipped)).ok, false)
  assert.equal(oneTimeCount(), 1, 'a failure does not consume it')
  assert.equal((await registerDevice(raw, 'x', one.token)).ok, true)
})

// ─────────────────────────────────────────────────────────────────────────────
// Registration and revocation
// ─────────────────────────────────────────────────────────────────────────────

test('★★ only registered keys pass (a one-byte difference does not)', async (t) => {
  await withStateDir(t)
  await loadDevices()
  const raw = await newPublicRaw()
  assert.equal((await pair(raw)).ok, true)
  assert.equal(isRegisteredKey(raw), true)

  const off = new Uint8Array(raw)
  off[off.length - 1] = (off[off.length - 1] ?? 0) ^ 1
  assert.equal(isRegisteredKey(off), false)
  assert.equal(isRegisteredKey(raw.slice(0, 64)), false, 'a different length does not pass either')
})

test('★★ non-key bytes cannot be registered (never leave a row whose handshake fails forever)', async (t) => {
  await withStateDir(t)
  await loadDevices()
  const junk = new Uint8Array(65) // first byte is not 0x04 = not a P-256 point
  const r = await registerDevice(junk, 'x', issueOneTime().token)
  assert.equal(r.ok, false)
  assert.deepEqual(listDevices(), [])

  const short = new Uint8Array(32)
  short[0] = 4
  assert.equal((await registerDevice(short, 'x', issueOneTime().token)).ok, false)
})

test('★★ state can be restored from the file alone (a restart itself; addedAt does not change)', async (t) => {
  await withStateDir(t)
  await loadDevices()
  const raw = await newPublicRaw()
  const added = await pair(raw, 'iPhone')
  assert.equal(added.ok, true)
  const before = listDevices()
  assert.equal(before.length, 1)

  resetDevices()
  await loadDevices()
  assert.equal(devicesBroken(), undefined)
  assert.deepEqual(listDevices(), before, 'the same content comes back')
  assert.equal(isRegisteredKey(raw), true)
})

test('★★ a duplicate registration of the same key does not rewrite addedAt (the record is not overwritten)', async (t) => {
  await withStateDir(t)
  await loadDevices()
  const raw = await newPublicRaw()
  await pair(raw, '最初', Date.parse('2026-09-01T00:00:00.000Z'))
  const first = listDevices()[0]

  const again = await pair(raw, 'あとから', Date.parse('2026-09-07T00:00:00.000Z'))
  assert.equal(again.ok, true)
  assert.equal(listDevices().length, 1)
  assert.equal(listDevices()[0]?.addedAt, first?.addedAt)
})

test('★★ revocation removes only that one device (also from the file; the others remain)', async (t) => {
  const dir = await withStateDir(t)
  await loadDevices()
  const a = await newPublicRaw()
  const b = await newPublicRaw()
  await pair(a, 'A')
  await pair(b, 'B')

  const r = await revokeDevice(toBase64Url(a))
  assert.equal(r.ok, true)
  assert.equal(isRegisteredKey(a), false)
  assert.equal(isRegisteredKey(b), true, '★ other devices are not affected')

  const stored = await fileJson(dir)
  assert.deepEqual(stored.devices, [listDevices()[0]], 'it is gone from the file too')

  assert.equal((await revokeDevice(toBase64Url(a))).ok, false, 'revoking a missing key is reported as a failure')
})

test('★★ labels are normalized at the entry point (control characters stripped, length truncated)', async (t) => {
  await withStateDir(t)
  await loadDevices()
  const raw = await newPublicRaw()
  await pair(raw, `  ス マ\u0000\nホ${'あ'.repeat(200)}  `)
  const label = listDevices()[0]?.label ?? ''
  assert.equal(/[\u0000-\u001f\u007f]/.test(label), false, 'no control characters remain')
  assert.ok(label.length <= 64, `length is truncated: ${label.length}`)
  assert.ok(label.startsWith('ス マ'), label)
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ Save failures and concurrency (the two kinds mutations do not reach / ARCHITECTURE §14.1.2.11)
// ─────────────────────────────────────────────────────────────────────────────

test('★★ if saving fails, it does not start accepting (not put in memory either)', async (t) => {
  const dir = await withStateDir(t)
  await loadDevices()
  await chmod(dir, 0o500) // make it unwritable
  const raw = await newPublicRaw()

  const r = await registerDevice(raw, 'x', issueOneTime().token)
  assert.equal(r.ok, false)
  assert.equal(isRegisteredKey(raw), false, 'not registered when it could not be saved')
  await chmod(dir, 0o700)
})

test('★★ a revocation during a registration is not undone afterwards (the whole section is serialized)', async (t) => {
  await withStateDir(t)
  await loadDevices()
  const a = await newPublicRaw()
  const b = await newPublicRaw()
  await pair(a, 'A')

  // ★ Run a registration (which waits on the save) and a revocation at the same time. ⚠️ enqueue handles the ordering
  const adding = registerDevice(b, 'B', issueOneTime().token)
  const removing = revokeDevice(toBase64Url(b))
  const [added, removed] = await Promise.all([adding, removing])

  assert.equal(added.ok, true)
  // The revocation runs "after the registration", so it succeeds and b does not remain
  assert.equal(removed.ok, true)
  assert.equal(isRegisteredKey(b), false, '★ not revived after the revocation')
  assert.equal(isRegisteredKey(a), true)
})

test('★★ bytes are copied at the entry point (the registration is unaffected if the caller buffer changes later)', async (t) => {
  await withStateDir(t)
  await loadDevices()
  const raw = await newPublicRaw()
  const shared = new Uint8Array(raw) // a buffer the caller reuses
  const p = registerDevice(shared, 'x', issueOneTime().token)
  shared.fill(0) // ★ overwrite it during the await
  assert.equal((await p).ok, true)
  assert.equal(isRegisteredKey(raw), true, 'what was registered is the key at the moment it was passed')
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ Look at the values the implementation actually produces — it can be passed straight to the handshake's `authorize`
// ─────────────────────────────────────────────────────────────────────────────

test('★★ passing authorizeDevice to acceptHandshake lets only registered devices through', async (t) => {
  await withStateDir(t)
  await loadDevices()
  const agent = await generateAgentKey()
  const agentPublic = await exportPublicKey(agent.publicKey)

  const good = await generateDeviceKey()
  const goodRaw = await exportPublicKey(good.publicKey)
  await pair(goodRaw, '登録済み')

  // Registered ⇒ the handshake completes
  const h = await startHandshake(good, agentPublic)
  const accepted = await acceptHandshake(agent, h.message, authorizeDevice)
  const pending = await finishHandshake(h, accepted.message)
  const session = await pending.accept(accepted.confirm)
  const sealed = await session.seal(FRAME.request, new TextEncoder().encode('こんにちは'))
  const opened = await accepted.session.open(sealed)
  assert.equal(opened.type, FRAME.request)
  assert.equal(new TextDecoder().decode(opened.plaintext), 'こんにちは')

  // Unregistered ⇒ refused without deriving keys
  const stranger = await generateDeviceKey()
  const h2 = await startHandshake(stranger, agentPublic)
  await assert.rejects(() => acceptHandshake(agent, h2.message, authorizeDevice))

  // After revocation it no longer passes
  await revokeDevice(toBase64Url(goodRaw))
  const h3 = await startHandshake(good, agentPublic)
  await assert.rejects(() => acceptHandshake(agent, h3.message, authorizeDevice))
})

test('★★ while broken, handshakes do not pass either (fail-closed)', async (t) => {
  const dir = await withStateDir(t)
  const agent = await generateAgentKey()
  const agentPublic = await exportPublicKey(agent.publicKey)
  const device = await generateDeviceKey()
  const raw = await exportPublicKey(device.publicKey)

  await loadDevices()
  await pair(raw, '登録済み')
  const good = await readFile(join(dir, DEVICES_FILE), 'utf8')

  // Break it while keeping the same content
  resetDevices()
  await writeFile(join(dir, DEVICES_FILE), `${good}壊れた`, 'utf8')
  await loadDevices()
  assert.ok(devicesBroken())
  const h = await startHandshake(device, agentPublic)
  await assert.rejects(() => acceptHandshake(agent, h.message, authorizeDevice))
})

test('★★ state is not published mid-load (★ the surviving mutation codex round 2 measured)', async (t) => {
  // ⚠️⚠️ codex observed the registration state of the first row at the entry of `importKey` and
  //    showed that after the mutation it became `[false, true]` (= **published mid-load**).
  //    ⇒ Pin "publish exactly once, at the end" **as behavior**.
  const dir = await withStateDir(t)
  await loadDevices()
  const a = await newPublicRaw()
  const b = await newPublicRaw()
  await pair(a, 'A')
  await pair(b, 'B')

  resetDevices()
  // ★ On every `importKey` call, record whether it already looks registered
  const subtle = globalThis.crypto.subtle
  const original = subtle.importKey.bind(subtle)
  const seen: boolean[] = []
  ;(subtle as { importKey: typeof subtle.importKey }).importKey = ((
    ...args: Parameters<typeof original>
  ) => {
    seen.push(isRegisteredKey(a))
    return original(...args)
  }) as typeof subtle.importKey
  try {
    await loadDevices()
  } finally {
    ;(subtle as { importKey: typeof subtle.importKey }).importKey = original
  }

  assert.ok(seen.length >= 2, `importKey is called at least twice: ${seen.length}`)
  assert.deepEqual(
    seen.filter((x) => x),
    [],
    '⚠️⚠️ looks registered mid-load (state is published part way through)',
  )
  // ★ Visible once finished (= the assert above is not "always false")
  assert.equal(isRegisteredKey(a), true)
  assert.equal(isRegisteredKey(b), true)
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ Registration generations (2026-09-08 / stage 6 ① of ③ = codex round 2, medium #8)
//
// ⚠️⚠️ **"Is it registered" alone does not make revocation apply to connections past the handshake.**
//   ⇒ Use the **object identity** of a single registration as its "generation" (the `Map` value itself).
//     It disappears on revocation, and re-registration creates **a different object**, so old connections do not revive.
//
// ★ **Mutations explicitly targeted here**:
//   ① Write `isLiveRegistration` with `has(key)` (**re-registration revives the old generation**)
//   ② `authorizeDevice` returns a boolean (cannot carry the generation = the material for ① is gone)
//   ③ Create a new object on every lookup (`{...device}`. **The generation changes every time and everything dies**)
//   ④ Treat generations as alive while broken (fail-open)
//   ⑤ Revocation also drops other devices' generations
//
// ★ ①②④ were actually run and killed (the same round as the 7 in `agent/src/deviceAuth.test.ts`).
// ⚠️ ② **cannot be written given the types** (if `authorizeDevice` returns a boolean, tsc stops on the type of `minted`)
//    ⇒ Behaviorally ① (`has(key)`) creates the same hole, so that is what we target.
// ─────────────────────────────────────────────────────────────────────────────

test('★★ authorizeDevice returns "the currently live registration" (that object is the generation)', async (t) => {
  await withStateDir(t)
  await loadDevices()
  const raw = await newPublicRaw()
  assert.equal(authorizeDevice({ devicePublicRaw: raw }), undefined, 'unregistered is undefined')

  await pair(raw, 'スマホ')
  const reg = authorizeDevice({ devicePublicRaw: raw })
  assert.ok(reg, 'when registered, the registration itself is returned')
  assert.equal(reg.key, toBase64Url(raw))
  assert.equal(isLiveRegistration(reg), true)
  // ★ A second lookup returns **the same object** (= looking up again does not change the generation)
  assert.equal(authorizeDevice({ devicePublicRaw: raw }), reg)
  // ★★ The list shows the same object too (**never create two values that say the same thing**)
  assert.equal(
    listDevices().find((d) => d.key === reg.key),
    reg,
    'the list returns a copy (there are two generations)',
  )
})

test('★★ a revoked generation dies. ⚠️ re-registering the same key does not revive it', async (t) => {
  await withStateDir(t)
  await loadDevices()
  const raw = await newPublicRaw()
  await pair(raw, 'スマホ')
  const before = authorizeDevice({ devicePublicRaw: raw })!

  assert.equal((await revokeDevice(toBase64Url(raw))).ok, true)
  assert.equal(isLiveRegistration(before), false, '⚠️⚠️ a revoked generation is alive')

  // ★★ This is the point (writing it with `has(key)` fails **only here**)
  await pair(raw, 'スマホ（もう一度）')
  const after = authorizeDevice({ devicePublicRaw: raw })!
  assert.equal(isLiveRegistration(after), true, 'the re-registered generation is alive')
  assert.notEqual(after, before, '★ it is a different object')
  assert.equal(isLiveRegistration(before), false, '⚠️⚠️ re-registration revived the old generation')
})

test('★★ a duplicate registration does not change the generation (nothing was revoked)', async (t) => {
  await withStateDir(t)
  await loadDevices()
  const raw = await newPublicRaw()
  await pair(raw, 'スマホ')
  const first = authorizeDevice({ devicePublicRaw: raw })!
  const again = await pair(raw, '名前を変えてみる')
  assert.equal(again.ok && again.already, true)
  assert.equal(authorizeDevice({ devicePublicRaw: raw }), first, '★ the generation has not changed')
  assert.equal(isLiveRegistration(first), true)
})

test('★★ revocation drops only "that device\'s generation"', async (t) => {
  await withStateDir(t)
  await loadDevices()
  const a = await newPublicRaw()
  const b = await newPublicRaw()
  await pair(a, 'A')
  await pair(b, 'B')
  const regA = authorizeDevice({ devicePublicRaw: a })!
  const regB = authorizeDevice({ devicePublicRaw: b })!

  await revokeDevice(toBase64Url(a))
  assert.equal(isLiveRegistration(regA), false)
  assert.equal(isLiveRegistration(regB), true, '★ other devices are not affected')
})

test('★★ while the records are broken, no generation is alive (fail-closed)', async (t) => {
  const dir = await withStateDir(t)
  await loadDevices()
  const raw = await newPublicRaw()
  await pair(raw, 'スマホ')
  const reg = authorizeDevice({ devicePublicRaw: raw })!

  await writeFile(join(dir, DEVICES_FILE), '{ "v": 1, "devices": "壊れた値" }', 'utf8')
  resetDevices()
  await loadDevices()
  assert.ok(devicesBroken())
  assert.equal(isLiveRegistration(reg), false, '⚠️ a generation is alive while broken')
})

test('★★ reloading replaces the generations (= old connections must handshake again / fail-closed)', async (t) => {
  await withStateDir(t)
  await loadDevices()
  const raw = await newPublicRaw()
  await pair(raw, 'スマホ')
  const before = authorizeDevice({ devicePublicRaw: raw })!

  // ⚠️ `loadDevices` is only called at startup (and in tests). Here we pin "what happens after a reload"
  await loadDevices()
  const after = authorizeDevice({ devicePublicRaw: raw })!
  assert.equal(isLiveRegistration(after), true, 'alive after the reload')
  assert.equal(isLiveRegistration(before), false, '★ the generation from before the reload dies (the safe side)')
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ One-time code status and cancellation (2026-09-23 / so `npm run pair` knows whether it was scanned)
// ─────────────────────────────────────────────────────────────────────────────

test('★★ status: waiting → registered (and which device)', async (t) => {
  await withStateDir(t)
  const raw = await newPublicRaw()
  const one = issueOneTime()
  assert.equal(oneTimeStatus(one.id).state, 'waiting')
  // ⚠️ The id is not the one-time code (knowing it does not allow registration)
  assert.notEqual(one.id, one.token)
  assert.equal((await registerDevice(raw, 'スマホ', one.id)).ok, false, '⚠️⚠️ registration is possible with the id')
  assert.equal((await registerDevice(raw, 'スマホ', one.token)).ok, true)
  const s = oneTimeStatus(one.id)
  assert.equal(s.state, 'registered')
  assert.ok(s.state === 'registered' && s.label === 'スマホ' && s.already === false && s.deviceKey.length > 0)
})

test('★★ status: already when a registered device scans again', async (t) => {
  await withStateDir(t)
  const raw = await newPublicRaw()
  await pair(raw)
  const one = issueOneTime()
  await registerDevice(raw, 'スマホ', one.token)
  const s = oneTimeStatus(one.id)
  assert.ok(s.state === 'registered' && s.already === true)
})

test('★★ once cancelled, that QR can no longer register (Ctrl-C)', async (t) => {
  await withStateDir(t)
  const raw = await newPublicRaw()
  const one = issueOneTime()
  assert.equal(await cancelOneTime(one.id), true)
  assert.equal(oneTimeStatus(one.id).state, 'cancelled')
  const r = await registerDevice(raw, 'スマホ', one.token)
  assert.equal(r.ok, false, '⚠️⚠️ registered even though it was cancelled')
  assert.equal(listDevices().length, 0)
  // ⚠️ The second time is false (it is gone = never claim a false "cancelled")
  assert.equal(await cancelOneTime(one.id), false)
})

test('★★ cancelling after use is false (the registration stays); an unknown id is expired', async (t) => {
  await withStateDir(t)
  const raw = await newPublicRaw()
  const one = issueOneTime()
  await registerDevice(raw, 'スマホ', one.token)
  assert.equal(await cancelOneTime(one.id), false)
  assert.equal(oneTimeStatus(one.id).state, 'registered')
  assert.equal(listDevices().length, 1)
  assert.equal(oneTimeStatus('nope').state, 'expired')
})

test('★★ cancellation shares the registration queue (even when simultaneous, "cancelled" and "registered" cannot both hold)', async (t) => {
  await withStateDir(t)
  const raw = await newPublicRaw()
  const one = issueOneTime()
  const [reg, cancelled] = await Promise.all([registerDevice(raw, 'スマホ', one.token), cancelOneTime(one.id)])
  assert.notEqual(reg.ok, cancelled, `⚠️⚠️ registered=${reg.ok} cancelled=${cancelled}`)
})

test('★★ once expired it is expired (outcomes are also forgotten after the lifetime)', async (t) => {
  await withStateDir(t)
  const now = Date.now()
  const one = issueOneTime(now)
  assert.equal(oneTimeStatus(one.id, now + ONE_TIME_TTL_MS + 1).state, 'expired')
  const raw = await newPublicRaw()
  const two = issueOneTime(now)
  await registerDevice(raw, 'スマホ', two.token, now)
  assert.equal(oneTimeStatus(two.id, now + 1).state, 'registered')
  assert.equal(oneTimeStatus(two.id, now + ONE_TIME_TTL_MS + 1).state, 'expired')
})

test('★★ never answers "expired" while waiting for the save (codex round 15, medium #1)', async (t) => {
  // ⚠️⚠️ It used to answer `expired` between consumption and the outcome being decided ⇒ `npm run pair`
  //    ended with "expired", and then the registration went through (reporting failure on a success).
  // ★ Keep polling the status between every I/O step while the registration runs (the save hits a real file, so there are always gaps)
  await withStateDir(t)
  const raw = await newPublicRaw()
  const one = issueOneTime()
  const seen = new Set<string>()
  let done = false
  const reg = registerDevice(raw, 'スマホ', one.token).finally(() => {
    done = true
  })
  while (!done) {
    seen.add(oneTimeStatus(one.id).state)
    await new Promise((r) => setImmediate(r))
  }
  assert.equal((await reg).ok, true)
  seen.add(oneTimeStatus(one.id).state)
  assert.ok(!seen.has('expired'), `⚠️⚠️ answered expired during the registration: ${[...seen].join(',')}`)
  assert.ok(seen.has('registering'), `registering was never observed (this check is not exercising anything): ${[...seen].join(',')}`)
  assert.equal(oneTimeStatus(one.id).state, 'registered')
})
