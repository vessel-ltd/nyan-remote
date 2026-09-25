// Persistence of the agent's own static key (`~/.nyan-remote/device-key.json`).
//
// ★★★ **Recreating this key disconnects every registered device.**
//   The QR code carries **the agent's public key** (ARCHITECTURE §14.1.2.5), and the device
//   starts the handshake **addressed to that key** with `startHandshake(deviceStatic, agentPublicRaw)`.
//   ⇒ If the key changes, `z2`/`z4` no longer match and **every pairing has to be redone**.
//   = **The same kind of accident** as recreating `vapid.json`, which kills every subscription (CLAUDE.md §2).
//
// ★★ **Mutations targeted by name** here (ran 9 on 2026-09-07 and **all were killed**):
//   ① Treat a broken file as "missing" and **recreate it** (= every pairing dies)
//   ② Drop the structure checks (ignore `v` / `crv` / `d`)
//   ③ Ignore the version (`v`)
//   ④ Ignore the curve (`crv`)
//   ⑤ Ignore whether the private key (`d`) is present
//   ⑥ Keep running on the in-memory key after saving failed (**the next start gets a different key**,
//      so devices paired in the meantime silently fail to connect)
//   ⑦ Recreate on the second start without looking at the file
//   ⑧ Return the key while broken (**produces a QR code that cannot connect**)
//   ⑨ `agentPublicRaw()` returns the internal array as-is (caller writes reach the internal state)
//
// ★★ **Killing ③④⑤ required asserting the "reason" too** (measured on 2026-09-07).
//   ⚠️ The first version only checked "it is broken", so mutations removing the `v` and `crv` checks
//      **were absorbed by the `importKeyPair` failure and slipped through**. ⇒ Recovery differs
//      per reason, so **checking the reason is not a fake assert** (it is the very value shown on screen and in the log).
//
// ★ **Be honest about equivalent mutations and removed checks** (no fake asserts in tests / CLAUDE.md §2):
//   - A mutation removing "read back and verify after writing" **cannot be killed**, because a unit test
//     cannot produce a situation where `writeJson` outputs something "present but broken".
//     ★ The reason to keep it is `repairSubject` in `push.ts` (the shape of an incident that stuck for 3 days in the field).
//   - The **public-key length check that used to be in `adopt` was removed**. Since `crv` is checked,
//     any key reaching there always has a 65B raw = the check was **unreachable** (a mutation slipped through).
//     ⚠️⚠️ **Made the same mistake in `peers.ts`** (twice on the same day).
//     ⇒ "It is an invariant relied on later" is not a reason to add a check. **Check whether it is reachable.**

import assert from 'node:assert/strict'
import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
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
} from '../../shared/crypto.ts'
import { importKeyPair } from './agentKey.ts'
import {
  DEVICE_KEY_FILE,
  type KeyIo,
  agentKey,
  agentKeyProblem,
  agentKeyRecreated,
  agentPublicRaw,
  loadAgentKey,
  resetAgentKey,
} from './deviceKey.ts'

async function withStateDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-devkey-'))
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = dir
  resetAgentKey()
  t.after(async () => {
    resetAgentKey()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await chmod(dir, 0o700).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

/** ★ Whether a handshake actually succeeds with this key pair (= check it is usable as a key) */
async function handshakeWorks(pair: { publicKey: unknown; privateKey: unknown }): Promise<boolean> {
  const agentStatic = pair as Awaited<ReturnType<typeof generateDeviceKey>>
  const agentPublic = await exportPublicKey(agentStatic.publicKey)
  const device = await generateDeviceKey()
  const h = await startHandshake(device, agentPublic)
  // ⚠️ Authorization is a pass-through in tests (the only real check in production is `authorizePeer` in `peers.ts`)
  const accepted = await acceptHandshake(agentStatic, h.message, () => true)
  const pending = await finishHandshake(h, accepted.message)
  const session = await pending.accept(accepted.confirm)
  const sealed = await session.seal(FRAME.request, new TextEncoder().encode('ping'))
  const opened = await accepted.session.open(sealed)
  return new TextDecoder().decode(opened.plaintext) === 'ping'
}

test('★★ first start creates the file (0600 / v:1 / includes the private key)', async (t) => {
  const dir = await withStateDir(t)
  await loadAgentKey()
  assert.equal(agentKeyProblem(), undefined)

  const path = join(dir, DEVICE_KEY_FILE)
  const st = await stat(path)
  assert.equal(st.mode & 0o777, 0o600, 'permissions are 0600')
  const stored = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(stored.v, 1)
  assert.equal(typeof stored.key?.d, 'string', 'the private key (d) is included')
  assert.equal(stored.key?.crv, 'P-256')

  assert.equal(agentPublicRaw().length, 65)
  assert.equal(await handshakeWorks(agentKey()), true)
})

test('★★★ second start uses the same key (restored from the file alone = the restart itself)', async (t) => {
  await withStateDir(t)
  await loadAgentKey()
  const first = agentPublicRaw()

  resetAgentKey()
  await loadAgentKey()
  assert.equal(agentKeyProblem(), undefined)
  assert.deepEqual(agentPublicRaw(), first, '★ the public key does not change')
  assert.equal(await handshakeWorks(agentKey()), true)
})

test('★★★ a handshake works from the saved file alone (do not confuse "readable" with "correct")', async (t) => {
  const dir = await withStateDir(t)
  await loadAgentKey()
  const stored = JSON.parse(await readFile(join(dir, DEVICE_KEY_FILE), 'utf8'))

  // ★ Rebuild from nothing but the JWK after a JSON round-trip
  const restored = await importKeyPair(JSON.parse(JSON.stringify(stored.key)))
  assert.deepEqual(await exportPublicKey(restored.publicKey), agentPublicRaw())
  assert.equal(await handshakeWorks(restored), true)
})

test('★★★ if broken, do not recreate (file not changed by a single byte / key unusable)', async (t) => {
  const dir = await withStateDir(t)
  const broken = '{ これは JSON ではない'
  await writeFile(join(dir, DEVICE_KEY_FILE), broken, 'utf8')
  await loadAgentKey()

  assert.ok(agentKeyProblem(), 'the reason it is broken is reported')
  assert.equal(await readFile(join(dir, DEVICE_KEY_FILE), 'utf8'), broken, '★ not overwritten')
  assert.throws(() => agentKey(), /鍵/)
  assert.throws(() => agentPublicRaw(), /鍵/, '★ must not produce a QR code that cannot connect')
})

test('★★ valid JSON with missing contents is treated as broken (★ reasons are distinguishable)', async (t) => {
  const dir = await withStateDir(t)
  await loadAgentKey()
  const good = JSON.parse(await readFile(join(dir, DEVICE_KEY_FILE), 'utf8'))
  const { d: _d, ...pubOnly } = good.key

  // ★★ **Check down to the reason** (recovery differs, so it cannot be fixed if indistinguishable).
  //   ⚠️ If this only checks "it is broken", mutations removing the `v` and `crv` checks
  //      get absorbed by the `importKeyPair` failure and **slip through** (measured on 2026-09-07).
  const cases: Array<[unknown, RegExp]> = [
    [{ key: good.key }, /版/], // no v
    [{ v: 2, key: good.key }, /版/], // unknown version
    [{ v: 1 }, /key/], // no key
    [{ v: 1, key: 'x' }, /key/], // key is not an object
    [{ v: 1, key: pubOnly }, /秘密鍵/], // ★ no private key (d)
    [{ v: 1, key: { ...good.key, crv: 'P-384' } }, /P-256/], // wrong curve
    [{ v: 1, key: { ...good.key, d: 'AAAA' } }, /読めません/], // ★ readable but unusable as a key
  ]
  for (const [body, reason] of cases) {
    resetAgentKey()
    const text = JSON.stringify(body)
    await writeFile(join(dir, DEVICE_KEY_FILE), text, 'utf8')
    await loadAgentKey()
    const problem = agentKeyProblem() ?? ''
    assert.match(problem, reason, `reason matches: ${text.slice(0, 60)}`)
    assert.equal(await readFile(join(dir, DEVICE_KEY_FILE), 'utf8'), text, 'not overwritten')
  }
})

test('★ agentPublicRaw() returns a copy (caller writes do not change internal state)', async (t) => {
  await withStateDir(t)
  await loadAgentKey()
  const first = agentPublicRaw()
  first.fill(0)
  assert.notDeepEqual(agentPublicRaw(), first, '★ the next value obtained is not corrupted')
  assert.equal(await handshakeWorks(agentKey()), true)
})

test('★★★ if saving fails, do not keep running on the in-memory key (avoid a different key on the next start)', async (t) => {
  const dir = await withStateDir(t)
  await chmod(dir, 0o500) // make it unwritable
  await loadAgentKey()

  assert.ok(agentKeyProblem(), 'failing to save is reported as a problem')
  assert.throws(() => agentPublicRaw(), /鍵/)
  await chmod(dir, 0o700)
})

test('★ once loaded, calling load again keeps the same key (meant to run once at startup)', async (t) => {
  await withStateDir(t)
  await loadAgentKey()
  const first = agentPublicRaw()
  await loadAgentKey()
  assert.deepEqual(agentPublicRaw(), first)
})

test('★★★ do not confuse a dangling symlink with a "first run" (do not recreate the key)', async (t) => {
  // ⚠️⚠️ codex round 2, medium #1 on 2026-09-08 (reproduced by measurement).
  //    `readFile` returns `ENOENT` even for a link whose target is gone, so it fell into "first start",
  //    **recreated the key and replaced the link itself with a regular file via `rename`**
  //    = every registered device failed to connect, and **the link, a clue for recovery, was lost too**.
  const dir = await withStateDir(t)
  const path = join(dir, DEVICE_KEY_FILE)
  await symlink(join(dir, 'nowhere', DEVICE_KEY_FILE), path)

  await loadAgentKey()
  assert.match(agentKeyProblem() ?? '', /リンク/, '⚠️ the reason shows it is a "link"')
  assert.throws(() => agentPublicRaw(), /鍵/, '★ the key is not usable')
  // ⚠️⚠️ **The link must remain** (not recreated = restoring the target recovers it)
  assert.equal((await lstat(path)).isSymbolicLink(), true, '★ not overwritten')
})

test('★★ reads normally once the target is back (the rejection above is not "always reject")', async (t) => {
  const dir = await withStateDir(t)
  // ★ First create the real one, then move it to another name and create the link
  await loadAgentKey()
  const first = agentPublicRaw()
  const real = join(dir, 'real-key.json')
  await writeFile(real, await readFile(join(dir, DEVICE_KEY_FILE), 'utf8'), 'utf8')
  await rm(join(dir, DEVICE_KEY_FILE))
  await symlink(real, join(dir, DEVICE_KEY_FILE))

  resetAgentKey()
  await loadAgentKey()
  assert.equal(agentKeyProblem(), undefined)
  assert.deepEqual(agentPublicRaw(), first, '★ same key through the link')
})

test('★★★ read back and verify after writing (★ the surviving mutation codex round 2 named)', async (t) => {
  // ⚠️⚠️ codex injected a fault "rewrite the file to `{}` right after `rename`" and showed that
  //    **with a mutation that skips the read-back, `agentKeyProblem()` becomes `undefined`**.
  //    ⇒ **A normal save round-trip cannot tell them apart**, so swap the IO to hit it.
  await withStateDir(t)
  let wrote: unknown
  let reads = 0
  const broken: KeyIo = {
    async read() {
      reads += 1
      // 1st = first start (missing) / 2nd = read-back after writing (★ broken)
      return reads === 1 ? { kind: 'missing' } : { kind: 'ok', value: {} }
    },
    async write(value) {
      wrote = value
    },
  }
  await loadAgentKey(broken)
  assert.ok(wrote, '★ it did write (it did not refuse without writing)')
  assert.equal(reads, 2, '⚠️⚠️ it reads back after writing')
  assert.match(agentKeyProblem() ?? '', /読み直せません/)
  assert.throws(() => agentPublicRaw(), /鍵/, '★ not usable')
})

test('★★ also refuses when the read-back key "differs from the key it created"', async (t) => {
  await withStateDir(t)
  // ★ Return a different key's JWK on the read-back (= the saved content was swapped)
  const other = await generateDeviceKey()
  const { exportPrivateKey } = await import('./agentKey.ts')
  // ⚠️ `generateDeviceKey` is extractable:false and cannot be exported ⇒ create one for the agent
  const { generateAgentKey } = await import('./agentKey.ts')
  const alt = await generateAgentKey()
  const altJwk = await exportPrivateKey(alt.privateKey)
  void other
  let reads = 0
  const swapped: KeyIo = {
    async read() {
      reads += 1
      return reads === 1 ? { kind: 'missing' } : { kind: 'ok', value: { v: 1, key: altJwk } }
    },
    async write() {},
  }
  await loadAgentKey(swapped)
  assert.match(agentKeyProblem() ?? '', /一致しません/)
})

test('★★ without a swap it behaves as before (default is the real file)', async (t) => {
  const dir = await withStateDir(t)
  await loadAgentKey()
  assert.equal(agentKeyProblem(), undefined)
  const stored = JSON.parse(await readFile(join(dir, DEVICE_KEY_FILE), 'utf8'))
  assert.equal(stored.v, 1)
})

test('★★★ key file missing while devices are registered records it as "lost" and keeps saying so after restart (2026-09-24)', async (t) => {
  const dir = await withStateDir(t)
  const warn = console.warn
  const warned: string[] = []
  console.warn = (m: string) => void warned.push(String(m))
  t.after(() => {
    console.warn = warn
  })
  // ★ A first start (0 devices) is not "lost"
  await loadAgentKey(undefined, 0)
  assert.equal(agentKeyRecreated(), undefined, '⚠️ a first start is reported as "lost"')
  assert.equal(warned.length, 0)

  // ★ Lose only the key file and restart (2 devices registered)
  const { rm: remove } = await import('node:fs/promises')
  await remove(join(dir, DEVICE_KEY_FILE))
  resetAgentKey()
  await loadAgentKey(undefined, 2)
  const r = agentKeyRecreated()
  assert.equal(r?.registered, 2)
  assert.ok(r && !Number.isNaN(Date.parse(r.at)))
  assert.ok(warned.some((m) => m.includes('2 台')), `⚠️ losing the key is not logged: ${warned.join(' / ')}`)
  assert.equal(agentKeyProblem(), undefined, '⚠️ recreated but unusable (not a way back)')

  // ★★ The record survives a restart (`npm run pair` / `npm run devices` keep saying so)
  resetAgentKey()
  await loadAgentKey(undefined, 2)
  assert.deepEqual(agentKeyRecreated(), r, '⚠️⚠️ "recreated" disappeared on restart')
})

test('★★★ also treated as "lost" when the registration records are broken and cannot be counted (null) (there may have been some)', async (t) => {
  await withStateDir(t)
  const warn = console.warn
  console.warn = () => undefined
  t.after(() => {
    console.warn = warn
  })
  await loadAgentKey(undefined, null)
  assert.deepEqual(agentKeyRecreated()?.registered, null)
})

test('★★★ startup order is "read registered devices, then read the key (passing the count)" (reversed, a loss goes unnoticed)', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
  const dev = src.indexOf('await loadDevices()')
  const key = src.indexOf('await loadAgentKey(undefined, devicesBroken() ? null : listDevices().length)')
  assert.ok(dev >= 0 && key >= 0, '⚠️⚠️ the device count is not passed (cannot tell a first start from "lost")')
  assert.ok(dev < key, '⚠️⚠️ the key is read first (count is always 0 = a loss is judged a "first start")')
})
