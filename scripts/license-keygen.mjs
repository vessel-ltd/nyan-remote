#!/usr/bin/env node
// ★ Create the license key pair (2026-09-24 / docs/BILLING.md). ⚠️ The operator uses this **only once** (regenerating invalidates every issued license, for up to 24 hours).
//
//   Public key ⇒ paste into `LICENSE_PUBLIC_KEY` in `shared/license.ts` (safe to publish)
//   Private key ⇒ never shown on screen. Written to a 0600 file ⇒ load it with `wrangler secret put LICENSE_PRIVATE_KEY < that-file`, then delete the file
//   ⚠️ Never commit the private key or paste it into a chat.

import { writeFileSync } from 'node:fs'
import { t } from '../shared/i18n.ts'
import { toBase64Url } from '../shared/crypto.ts'
import { initCliLang } from './lib/lang.mjs'

initCliLang()
const out = process.argv[2]
if (!out) {
  console.error(t('使い方: node scripts/license-keygen.mjs <秘密鍵を書くファイル（リポジトリの外）>', 'Usage: node scripts/license-keygen.mjs <file for the private key (outside the repo)>'))
  process.exit(2)
}
const k = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
const pub = toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey)))
const priv = toBase64Url(new Uint8Array(await crypto.subtle.exportKey('pkcs8', k.privateKey)))
writeFileSync(out, priv, { mode: 0o600, flag: 'wx' })
console.log(t('公開鍵（shared/license.ts の LICENSE_PUBLIC_KEY に貼る）:', 'Public key (paste into LICENSE_PUBLIC_KEY in shared/license.ts):'))
console.log(pub)
console.log(t(`秘密鍵を書きました: ${out}（0600）`, `Wrote the private key: ${out} (0600)`))
console.log(t('  次: cd account && ../relay/node_modules/.bin/wrangler secret put LICENSE_PRIVATE_KEY < ファイル && rm ファイル', '  Next: cd account && ../relay/node_modules/.bin/wrangler secret put LICENSE_PRIVATE_KEY < file && rm file'))
