// ★ The name this machine shows on the phone and in notifications (2026-10-02).
//
// ★ Default is the hostname. `config.json` may set `"machineName": "laptop"` — for a readable name, or to keep a
//   hostname out of a screen recording. Everything the phone sees takes the name from here (the list, notifications,
//   approval cards, `/health`), so one machine shows one name everywhere.
// ⚠️ The phone also uses this name as part of keys (notification tags, approval tags): **give each machine its own name**.
//   Changing it later is fine (old notifications simply stop being replaced).
// ⚠️⚠️ Not used for the inbox sender (`senderName` in claude/inbox.ts keeps the hostname): "came from the phone" is
//   matched exactly against it, so renaming would strip that badge from everything sent before.
// ⚠️ A bad value does not make requests fail (unlike the rest of config.json): only the name is lost, so fall back to the
//   hostname and say so in the log (same treatment as `relayUrl`).

import { hostname } from 'node:os'
import { config } from './config.ts'
import { t } from '../../shared/i18n.ts'

export const MACHINE_NAME_MAX = 32

/**
 * The usable form of a configured name, or null.
 * ⚠️ No control or format characters (they reach notifications and the log), no line breaks, and no `/`
 *   (notification tags are `machine/account/session`), and no leading `perm-` (the prefix of approval tags).
 */
export function checkMachineName(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  const len = [...s].length
  if (len === 0 || len > MACHINE_NAME_MAX) return null
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}/]/u.test(s)) return null
  // ⚠️ `perm-` is how the phone tells approval notifications apart (session tags are `machine/…`), so a machine named
  //   `perm-x` would have its ordinary notifications cleared as stale approvals (codex, medium)
  if (s.startsWith('perm-')) return null
  return s
}

/** ★ From what `config.json` holds (pure; scripts that only read the file use this) */
export function resolveMachineName(configured: unknown, host: string = hostname()): string {
  return configured === undefined ? host : (checkMachineName(configured) ?? host)
}

/** ★ This machine's name, as the agent shows it. ⚠️ Before the config is loaded it is the hostname */
export function machineName(): string {
  let configured: unknown
  try {
    configured = config().machineName
  } catch {
    return hostname()
  }
  return resolveMachineName(configured)
}

/** A line for the startup log when the configured name cannot be used (null when fine or absent) */
export function machineNameProblem(configured: unknown): string | null {
  if (configured === undefined || checkMachineName(configured) !== null) return null
  return t(
    `[config] ⚠️ machineName を使えません（1〜${MACHINE_NAME_MAX}文字・改行や制御文字や / を含まない）。ホスト名 ${hostname()} を使います`,
    `[config] ⚠️ machineName cannot be used (1–${MACHINE_NAME_MAX} characters, no line breaks, control characters or /). Using the hostname ${hostname()}`,
  )
}
