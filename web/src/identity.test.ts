// This device's static key (③'s identity).
//
// ★★ **Mutations killed by name** here:
//   ① silently recreate a broken key (the user thinks they're "paired" but **can't connect**)
//   ② proceed with an in-memory key even if saving failed (the key vanishes right after registering, **leaving a dead registration**)
//   ③ create a different key the second time (not reading storage = re-pairing every time)
//   ④ accept an `extractable: true` private key (keeps using **an exfiltratable key**)
//   ⑤ treat a read failure like "first time" (**creates and overwrites even though the store is unreadable**)
//   ⑥ don't derive `deviceId` from the public key fingerprint (mismatches the id the agent returns)
//
// ★★ **codex (read-only) on 2026-09-08 found 3 mediums. All were reproduced by measurement before fixing**:
//   ⑦ treat `null` the same as "unsaved" and **overwrite with a new key** (medium #3)
//   ⑧ pass a private key that isn't a `CryptoKey` / pass even when **public and private keys don't correspond** (medium #3)
//   ⑨ concurrent first creation makes both ok with different keys, only one remaining saved (medium #1)
//      ⇒ changed to `getOrPut` (in one transaction: "insert if absent and return the settled value")
//   ⑩ confuse IndexedDB's `onsuccess` with **commit** (medium #2; resolve on `tx.oncomplete`)
//      ⚠️ This is inside `idbKeyStore()`, so **it can't be verified in Node** (⬜ real device)
//
// ⚠️ Node has no IndexedDB, so `KeyStore` is swapped to check only the decisions.
//    ⇒ **`idbKeyStore()` itself can only be verified on a real device** (⬜ step 5 real-device check).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { exportPublicKey, fingerprint, generateDeviceKey } from '../../shared/crypto.ts'
import { IDENTITY_ID, loadIdentity, resetIdentity, type KeyStore } from './identity.ts'

/**
 * In-memory store (★ failures can be injected).
 *
 * ★★ `getOrPut` means "**insert if absent and return the settled value**" (equivalent to one transaction).
 *    ⚠️ No `put` (save-only) = **the shape "saved, yet a different value is settled" can't be created**.
 * ⚠️ `slowPut` **widens the concurrency window** (without it they happen to finish in order and mutations slip past).
 */
function memStore(
  opts: { failGet?: boolean; failPut?: boolean; failDel?: boolean; slowPut?: boolean } = {},
) {
  const map = new Map<string, unknown>()
  const store: KeyStore = {
    async get(id) {
      if (opts.failGet) throw new Error('読めません')
      return map.get(id)
    },
    async getOrPut(id, candidate) {
      if (opts.failPut) throw new Error('書けません')
      // ⚠️ An await here doesn't break "first one wins" (check and assignment are synchronous)
      if (opts.slowPut) await new Promise((r) => setTimeout(r, 5))
      // ⚠️ The real one (IndexedDB) checks whether `get` returned `undefined`. **Use the same check**
      //    (with `has`, only the fake would treat `null` as "absent" = an impossible world)
      if (map.get(id) === undefined) map.set(id, candidate)
      return map.get(id)
    },
    async del(id) {
      if (opts.failDel) throw new Error('消せません')
      map.delete(id)
    },
  }
  return { store, map }
}

test('★★ first time creates and saves (deviceId is the public key fingerprint)', async () => {
  const { store, map } = memStore()
  const id = await loadIdentity(store)
  assert.equal(id.kind, 'ok')
  assert.ok(id.kind === 'ok')
  assert.ok(map.has(IDENTITY_ID), '★ it is saved')

  // ★ **Look at the value the implementation produces** (compare against a separately computed fingerprint)
  const raw = await exportPublicKey(id.pair.publicKey)
  assert.equal(id.deviceId, await fingerprint(raw))
  assert.equal(id.publicKey.length > 80, true)
})

test('★★ the private key can\'t be extracted (saved with extractable: false)', async () => {
  const { store } = memStore()
  const id = await loadIdentity(store)
  assert.ok(id.kind === 'ok')
  assert.equal(id.pair.privateKey.extractable, false)
  await assert.rejects(
    () => globalThis.crypto.subtle.exportKey('jwk', id.pair.privateKey),
    '★ it cannot be exported',
  )
})

test('★★ second time returns the same key (reads storage = no re-pairing every time)', async () => {
  const { store } = memStore()
  const first = await loadIdentity(store)
  const second = await loadIdentity(store)
  assert.ok(first.kind === 'ok' && second.kind === 'ok')
  assert.equal(second.publicKey, first.publicKey)
  assert.equal(second.deviceId, first.deviceId)
})

test('★★ if something broken is stored, it isn\'t silently recreated', async () => {
  const { store, map } = memStore()
  for (const junk of [
    {},
    { publicKey: 1, privateKey: 2 },
    'なにか',
    { publicKey: { type: 'public' } }, // no private key
    { publicKey: { type: 'private' }, privateKey: { type: 'private', extractable: false } },
  ]) {
    map.set(IDENTITY_ID, junk)
    const id = await loadIdentity(store)
    assert.equal(id.kind, 'broken', `treated as broken: ${JSON.stringify(junk)}`)
    // ⚠️ **Not overwritten** (keeps the evidence / doesn't become someone else on its own)
    assert.deepEqual(map.get(IDENTITY_ID), junk)
  }
})

test('★★ extractable: true private keys are rejected (no use of exfiltratable keys)', async () => {
  const { store, map } = memStore()
  // ★ Store **a real** extractable key (not a hand-made shape-only value)
  const bad = (await globalThis.crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  )) as CryptoKeyPair
  assert.equal(bad.privateKey.extractable, true, 'precondition: it is an extractable key')
  map.set(IDENTITY_ID, bad)

  const id = await loadIdentity(store)
  assert.equal(id.kind, 'broken', '⚠️ must not keep using it')
})

test('★★ if it can\'t be saved, it doesn\'t proceed with an in-memory key (no dead registrations)', async () => {
  const { store } = memStore({ failPut: true })
  const id = await loadIdentity(store)
  assert.equal(id.kind, 'unavailable')
  assert.ok(id.kind === 'unavailable' && id.reason.length > 0)
})

test('★★ an unreadable store is not treated like "first time" (no overwrite)', async () => {
  const { store, map } = memStore({ failGet: true })
  const id = await loadIdentity(store)
  assert.equal(id.kind, 'unavailable')
  assert.equal(map.size, 0, '⚠️ must not create and write when unreadable')
})

test('★★ recreating only when a human presses it (becomes a different key)', async () => {
  const { store } = memStore()
  const first = await loadIdentity(store)
  assert.ok(first.kind === 'ok')
  const again = await resetIdentity(store)
  assert.ok(again.kind === 'ok')
  assert.notEqual(again.publicKey, first.publicKey, '★ becomes someone else')
})

test('★★ recreating also escapes a broken state', async () => {
  const { store, map } = memStore()
  map.set(IDENTITY_ID, { publicKey: 1, privateKey: 2 })
  assert.equal((await loadIdentity(store)).kind, 'broken')
  assert.equal((await resetIdentity(store)).kind, 'ok')
})

test('★ says so when it can\'t delete (doesn\'t fake success)', async () => {
  const { store } = memStore({ failDel: true })
  await loadIdentity(store)
  assert.equal((await resetIdentity(store)).kind, 'unavailable')
})

test('★ the saved key can handshake (= usable, not just the right shape)', async () => {
  const { store } = memStore()
  const id = await loadIdentity(store)
  assert.ok(id.kind === 'ok')
  const { acceptHandshake, startHandshake, finishHandshake, FRAME } = await import(
    '../../shared/crypto.ts'
  )
  const agent = await generateDeviceKey() // ⚠️ it's a test, so the agent role can use the same generator
  const h = await startHandshake(id.pair, await exportPublicKey(agent.publicKey))
  const accepted = await acceptHandshake(agent, h.message, () => true)
  const session = await (await finishHandshake(h, accepted.message)).accept(accepted.confirm)
  const sealed = await session.seal(FRAME.request, new TextEncoder().encode('やあ'))
  assert.equal(
    new TextDecoder().decode((await accepted.session.open(sealed)).plaintext),
    'やあ',
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ The 3 mediums from codex (read-only) on 2026-09-08 (all reproduced by measurement before fixing)
// ─────────────────────────────────────────────────────────────────────────────

test('★★ null is not "unsaved" (no overwrite with a new key)', async () => {
  // ⚠️⚠️ It used to branch on `stored !== undefined && stored !== null`, so
  //    with `null` stored it **overwrote as first time** (reproduced by measurement on 2026-09-08).
  //    ⇒ **Unsaved is only `undefined`**.
  const { store, map } = memStore()
  map.set(IDENTITY_ID, null)
  const id = await loadIdentity(store)
  assert.equal(id.kind, 'broken')
  assert.equal(map.get(IDENTITY_ID), null, '★ not overwritten')
})

test('★★ rejects if the private key isn\'t a CryptoKey (no shape-only values)', async () => {
  const { store, map } = memStore()
  const real = await generateDeviceKey()
  // ★ Real public key, "shape-only" private key
  map.set(IDENTITY_ID, {
    publicKey: real.publicKey,
    privateKey: { type: 'private', extractable: false },
  })
  assert.equal((await loadIdentity(store)).kind, 'broken')
})

test('★★ rejects if public and private keys don\'t correspond', async () => {
  // ⚠️⚠️ `describe()` only uses the public key, so **mismatched pairs** passed.
  //    Only the handshake failed, so it wasn't recognized as a "broken key" and no recreate button appeared.
  const { store, map } = memStore()
  const x = await generateDeviceKey()
  const y = await generateDeviceKey()
  map.set(IDENTITY_ID, { publicKey: x.publicKey, privateKey: y.privateKey })
  assert.equal((await loadIdentity(store)).kind, 'broken')

  // ★ A correct pair passes (= the check above isn't "always false")
  map.set(IDENTITY_ID, x)
  assert.equal((await loadIdentity(store)).kind, 'ok')
})

test('★★ rejects keys with a different algorithm (only ECDH P-256)', async () => {
  const { store, map } = memStore()
  const ecdsa = (await globalThis.crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  map.set(IDENTITY_ID, ecdsa)
  assert.equal((await loadIdentity(store)).kind, 'broken')

  const p384 = (await globalThis.crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-384' },
    false,
    ['deriveBits'],
  )) as CryptoKeyPair
  map.set(IDENTITY_ID, p384)
  assert.equal((await loadIdentity(store)).kind, 'broken')
})

test('★★ concurrent first creation yields the same key (no two identities)', async () => {
  // ⚠️⚠️ `get → generate → put` used to be separate, so two tabs opening at once gave
  //    **both ok, different public keys, and only one remaining saved** (reproduced by measurement).
  //    ⇒ `getOrPut` "inserts if absent and **returns the settled value**" (first one wins).
  const { store } = memStore({ slowPut: true })
  const [a, b, c] = await Promise.all([
    loadIdentity(store),
    loadIdentity(store),
    loadIdentity(store),
  ])
  assert.ok(a.kind === 'ok' && b.kind === 'ok' && c.kind === 'ok')
  assert.equal(b.publicKey, a.publicKey, '★ the second gets the same key')
  assert.equal(c.publicKey, a.publicKey, '★ the third gets the same key too')

  // ★ Same after rereading (= matches what remained saved)
  const again = await loadIdentity(store)
  assert.ok(again.kind === 'ok')
  assert.equal(again.publicKey, a.publicKey)
})

test('★★ even concurrently, handshakes use "the saved key" (never a discarded key)', async () => {
  const { store } = memStore({ slowPut: true })
  const [a] = await Promise.all([loadIdentity(store), loadIdentity(store)])
  assert.ok(a.kind === 'ok')
  const stored = await loadIdentity(store)
  assert.ok(stored.kind === 'ok')
  // ⚠️ The returned key pair itself can handshake (= not a discarded candidate)
  const { acceptHandshake, startHandshake, finishHandshake, FRAME, exportPublicKey } = await import(
    '../../shared/crypto.ts'
  )
  const agent = await generateDeviceKey()
  const h = await startHandshake(a.pair, await exportPublicKey(agent.publicKey))
  const acc = await acceptHandshake(agent, h.message, () => true)
  const s = await (await finishHandshake(h, acc.message)).accept(acc.confirm)
  await s.seal(FRAME.request, new TextEncoder().encode('x'))
  assert.equal(a.publicKey, stored.publicKey)
})
