import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toBase64Url } from './crypto.ts'
import {
  asLicense,
  importLicensePublicKey,
  LICENSE_PUBLIC_KEY,
  LICENSE_SKEW_SEC,
  LICENSE_TTL_SEC,
  licenseFor,
  PLAN_LIMITS,
  signLicense,
  verifyLicense,
} from './license.ts'

async function keys() {
  // ⚠️ Do not write DOM type names (CryptoKeyPair) (shared/ must also pass type checking without DOM)
  const k = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as unknown as {
    publicKey: Parameters<typeof crypto.subtle.exportKey>[1]
    privateKey: Parameters<typeof crypto.subtle.sign>[1]
  }
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey))
  return { priv: k.privateKey, pub: await importLicensePublicKey(raw) }
}

const NOW = 1_800_000_000
const KEY = 'K'.repeat(87)
const MID = 'm_abcdefghijkl'

test('★★ an issued ticket verifies and its payload follows the plan table', async () => {
  const { priv, pub } = await keys()
  const tok = await signLicense(licenseFor('acct_12345678', KEY, MID, 'plus', NOW), priv)
  const r = await verifyLicense(tok, pub, NOW + 10)
  assert.ok(r.ok)
  assert.equal(r.license.maxMachines, PLAN_LIMITS.plus.maxMachines)
  assert.equal(r.license.maxDevices, PLAN_LIMITS.plus.maxDevices)
  assert.equal(r.license.exp - r.license.iat, LICENSE_TTL_SEC)
})

test('★★ tampered, wrong-key and broken tickets do not pass', async () => {
  const { priv, pub } = await keys()
  const other = await keys()
  const tok = await signLicense(licenseFor('acct_12345678', KEY, MID, 'free', NOW), priv)
  // Rewrite the payload to plus (signature unchanged)
  const [, sig] = tok.split('.')
  const forged = `${toBase64Url(new TextEncoder().encode(JSON.stringify({ ...licenseFor('acct_12345678', KEY, MID, 'plus', NOW) })))}.${sig}`
  assert.deepEqual(await verifyLicense(forged, pub, NOW), { ok: false, reason: 'signature' })
  assert.deepEqual(await verifyLicense(await signLicense(licenseFor('acct_12345678', KEY, MID, 'plus', NOW), other.priv), pub, NOW), {
    ok: false,
    reason: 'signature',
  })
  for (const bad of ['', 'abc', 'a.b.c', '.x', 'x.', 'x'.repeat(5000), 42, null, undefined]) {
    const r = await verifyLicense(bad, pub, NOW)
    assert.equal(r.ok, false, String(bad).slice(0, 20))
  }
})

test('★★ expiry: expired tickets fail, future tickets fail too (with allowance)', async () => {
  const { priv, pub } = await keys()
  const tok = await signLicense(licenseFor('acct_12345678', KEY, MID, 'free', NOW), priv)
  assert.ok((await verifyLicense(tok, pub, NOW + LICENSE_TTL_SEC + LICENSE_SKEW_SEC)).ok)
  assert.deepEqual(await verifyLicense(tok, pub, NOW + LICENSE_TTL_SEC + LICENSE_SKEW_SEC + 1), { ok: false, reason: 'expired' })
  assert.deepEqual(await verifyLicense(tok, pub, NOW - LICENSE_SKEW_SEC - 1), { ok: false, reason: 'not-yet' })
})

test('★★ even with a valid signature, a wrong shape is rejected (unknown plan, out-of-range numbers, wrong version)', async () => {
  const { priv, pub } = await keys()
  const base = licenseFor('acct_12345678', KEY, MID, 'free', NOW)
  for (const bad of [
    { ...base, plan: 'enterprise' },
    { ...base, maxMachines: 0 },
    { ...base, maxDevices: 1000 },
    { ...base, v: 4 },
    { ...base, v: 2 },
    { ...base, mid: 'x' },
    (({ mid: _m, ...rest }) => rest)(base),
    { ...base, acct: 'x' },
    { ...base, exp: base.iat },
    { ...base, key: 'short' },
    { ...base, v: 1 },
    (({ key: _k, ...rest }) => rest)(base),
  ]) {
    const tok = await signLicense(bad as never, priv)
    assert.deepEqual(await verifyLicense(tok, pub, NOW), { ok: false, reason: 'malformed' }, JSON.stringify(bad))
  }
  assert.equal(asLicense(null), undefined)
})

test('★ the production public key has the right shape (readable as a 32-byte Ed25519 key)', async () => {
  const { fromBase64Url } = await import('./crypto.ts')
  assert.equal(fromBase64Url(LICENSE_PUBLIC_KEY).length, 32)
  await importLicensePublicKey(fromBase64Url(LICENSE_PUBLIC_KEY))
})
