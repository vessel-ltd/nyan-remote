// ★★ English for the "why it is broken" classifications of state files (2026-09-24 / i18n).
//
// ⚠️ Classifications are **built in Japanese at startup (outside any request) and stored in state** (`readJsonFile` in `state.ts`,
//    each module's `structureProblem`, `validateConfig` in `config.ts`).
//    ⇒ Calling `t()` when building them **freezes the startup language**, so `reasonText` looks them up again **right before output**.
// ⚠️ Do not change the classifications themselves (Japanese) — tests and audit trails look at those values.
// ⚠️ If not in the table, output the Japanese as is (do not silently drop a newly added classification).
//    ★ When adding one, **add it here too** (`reasons.test.ts` checks that every text the producers build is in the table).

import { t } from '../../shared/i18n.ts'

export const REASON_EN: Readonly<Record<string, string>> = {
  // `readJsonFile` in `state.ts`
  'リンク先が見つかりません': 'the symlink target was not found',
  '読み取りに失敗しました': 'reading failed',
  'JSON として読めません': 'not valid JSON',
  'JSON オブジェクトではありません': 'not a JSON object',
  // `validateConfig` in `config.ts`
  'allowedLogins が文字列の配列ではありません（ペアリングが開き直るため拒否します）':
    'allowedLogins is not an array of strings (refused because pairing would reopen)',
  'hookToken がありません（作り直すと設置済みフックの承認が飛ばなくなるため拒否します）':
    'hookToken is missing (refused because recreating it would break approvals from installed hooks)',
  'allowedOrigins が文字列の配列ではありません': 'allowedOrigins is not an array of strings',
  'configDirs が文字列の配列でも null でもありません': 'configDirs is neither an array of strings nor null',
  'maxSessionsPerAccount が正の数ではありません': 'maxSessionsPerAccount is not a positive number',
  'relayUrl が文字列ではありません': 'relayUrl is not a string',
  'port が正の整数ではありません': 'port is not a positive integer',
  // `structureProblem` of each state file (autoApprove / devices / deviceKey)
  '知らない版です': 'unknown version',
  'entries がありません': 'entries is missing',
  'entries が配列ではありません': 'entries is not an array',
  '札の形が不正です': 'an entry has an invalid shape',
  'devices がありません': 'devices is missing',
  'devices が配列ではありません': 'devices is not an array',
  'デバイスの形が不正です': 'a device has an invalid shape',
  '同じ鍵が重複しています': 'the same key appears twice',
  '公開鍵として読めない登録があります': 'a registration has an unreadable public key',
  'key がありません': 'key is missing',
  '曲線が P-256 ではありません': 'the curve is not P-256',
  '秘密鍵（d）がありません': 'the private key (d) is missing',
  // `loadAgentKey` in `deviceKey.ts`
  '鍵として読めません': 'cannot be read as a key',
  '鍵を保存できません': 'cannot save the key',
  '保存した鍵を読み直せません': 'cannot read back the saved key',
  '保存した鍵を組み立て直せません': 'cannot rebuild the saved key',
  '保存した鍵が作った鍵と一致しません': 'the saved key does not match the generated key',
}

/** ★ Output a classification **in the current language** (⚠️ called inside a request, it uses that request's language) */
export function reasonText(reason: string): string {
  return t(reason, REASON_EN[reason] ?? reason)
}
