// The agent's own static key (`~/.nyan-remote/device-key.json`).
//
// ⚠️⚠️ **This file is agent-only. The PWA must not import it**
// (2026-09-01 codex round 4, high #2 / `web/src/discipline.test.ts` checks this mechanically).
//
// **Why it is separate**: `shared/crypto.ts` is also imported by the PWA. Merely having
// `exportPrivateKey` / `extractable: true` generation there **ships an API that lets XSS
// exfiltrate the private key**. ⇒ Rather than saying "don't use it" in prose,
// **put it where the PWA cannot reach it**.
//
// ⚠️ Only the agent's key is `extractable: true` because it **has to be persisted to a file**.
//    What protects it is the file mode (0600); the machine is the trust boundary (ARCHITECTURE §14.1.2.3).

import { t } from '../../shared/i18n.ts'
import { ECDH_PARAMS, type Jwk, type Key, type KeyPair } from '../../shared/crypto.ts'

const subtle = (): typeof globalThis.crypto.subtle => globalThis.crypto.subtle

/** ⚠️ Agent only. `extractable: true` because it is persisted to a file */
export function generateAgentKey(): Promise<KeyPair> {
  return subtle().generateKey(ECDH_PARAMS, true, ['deriveBits']) as Promise<KeyPair>
}

export async function exportPrivateKey(key: Key): Promise<Jwk> {
  return (await subtle().exportKey('jwk', key)) as Jwk
}

export function importPrivateKey(jwk: Jwk): Promise<Key> {
  return subtle().importKey('jwk', jwk, ECDH_PARAMS, true, ['deriveBits'])
}

/**
 * ★ **Rebuild the key pair from the JWK alone** (this is what an agent restart does).
 *
 * ⚠️ The public-key JWK must not contain `d` (WebCrypto rejects it if it does).
 * ⚠️ Don't confuse "it parsed" with "it is correct" ⇒ callers must go as far as checking that **the restored key can actually complete a handshake**.
 */
export async function importKeyPair(jwk: Jwk): Promise<KeyPair> {
  const { d, key_ops: _ops, ext: _ext, ...pub } = jwk
  if (!d) throw new Error(t('秘密鍵（d）がありません', 'The private key (d) is missing'))
  return {
    privateKey: await importPrivateKey(jwk),
    publicKey: await subtle().importKey('jwk', { ...pub, key_ops: [] }, ECDH_PARAMS, true, []),
  }
}
