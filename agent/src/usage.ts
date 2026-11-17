// ★ Plan limits of each Claude profile and Codex home (`GET /usage` / 2026-11-17).
//
// Where the numbers come from (measured 2026-11-17, Claude Code 2.1.326 / codex-cli 0.169.0):
//   - Claude: the status line command gets `rate_limits.five_hour` / `.seven_day` (`used_percentage`, `resets_at`) after
//     each API response — a documented field. Our relay (`hooks/statusline.sh`) writes that input to
//     `~/.nyan-remote/usage/claude-<profile>.json`, then runs the user's own status line command unchanged.
//     ⚠️ Only while a session of that profile runs: the reading is "as of" the file's time.
//     ⚠️ `.claude.json`'s `cachedUsageUtilization` is written only when `/usage` is opened (days old) ⇒ not used.
//     ⚠️⚠️ Never Claude's OAuth token: calling the usage API with it is not ours to do.
//   - Codex: `account/rateLimits/read` on the line we already hold (`codex/run.ts`).
// ⚠️ Which windows exist depends on the plan (a 5-hour window is not on every plan, Claude or Codex) ⇒ only what is
//    reported is shown, never assumed.
// ⚠️ Limits belong to the account, and two profiles can be one account (measured: `.claude-r` and `.claude-rs`) ⇒
//    `accountKey`, a short hash (the id itself never leaves the machine).
// ⚠️ A window whose reset has passed is dropped: its number is no longer true, and the next one is unknown.

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ToolUsage, UsageWindow } from '../../shared/types.ts'
import type { ConfigDir } from './claude/configDirs.ts'
import { stateDir } from './state.ts'

/** The relay's file for one profile. ⚠️ The same name `hooks/statusline.sh` writes */
export function claudeUsagePath(account: string, dir: string = stateDir()): string {
  return join(dir, 'usage', `claude-${account}.json`)
}

/** The status line input is small (measured ~2 KB); a bigger file is not one of ours */
const MAX_BYTES = 256 * 1024

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A short, stable stand-in for an account id (equal ids = one account) */
export function accountKeyOf(id: unknown): string | undefined {
  return typeof id === 'string' && id !== '' ? createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 12) : undefined
}

function windowOf(minutes: number, percent: unknown, resetsAtSec: unknown, nowMs: number): UsageWindow | undefined {
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0) return undefined
  if (typeof resetsAtSec !== 'number' || !Number.isFinite(resetsAtSec) || resetsAtSec <= 0) return undefined
  const resetsMs = resetsAtSec * 1000
  // ⚠️ Passed: the number is no longer true. ⚠️ Beyond what a Date holds, `toISOString` throws (codex review: one broken
  //    file failed the whole `/usage`) ⇒ not a window
  if (resetsMs <= nowMs || resetsMs > 8.64e15) return undefined
  return { minutes, usedPercent: percent, resetsAt: new Date(resetsMs).toISOString() }
}

/** Claude's two windows, from the status line input (`rate_limits`). `undefined` = not a reading at all */
export function claudeWindows(input: unknown, nowMs: number): UsageWindow[] | undefined {
  if (!isObject(input) || !isObject(input.rate_limits)) return undefined
  const rl = input.rate_limits
  const out: UsageWindow[] = []
  for (const [key, minutes] of [['five_hour', 300], ['seven_day', 10080]] as const) {
    const w = rl[key]
    if (!isObject(w)) continue
    const got = windowOf(minutes, w.used_percentage, w.resets_at, nowMs)
    if (got) out.push(got)
  }
  return out
}

/** Codex's windows (`primary` / `secondary`, each with its own length) from `account/rateLimits/read` */
export function codexUsageOf(result: unknown, nowMs: number): Pick<ToolUsage, 'windows' | 'plan' | 'accountKey'> | undefined {
  if (!isObject(result) || !isObject(result.rateLimits)) return undefined
  const rl = result.rateLimits
  const windows: UsageWindow[] = []
  for (const key of ['primary', 'secondary']) {
    const w = rl[key]
    if (!isObject(w)) continue
    const minutes = w.windowDurationMins
    if (typeof minutes !== 'number' || !Number.isSafeInteger(minutes) || minutes <= 0) continue
    const got = windowOf(minutes, w.usedPercent, w.resetsAt, nowMs)
    if (got) windows.push(got)
  }
  windows.sort((a, b) => a.minutes - b.minutes)
  const plan = typeof rl.planType === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(rl.planType) ? rl.planType : undefined
  const accountKey = accountKeyOf(result.accountId)
  return { windows, ...(plan ? { plan } : {}), ...(accountKey ? { accountKey } : {}) }
}

/** Reads, kept while the file is unchanged (the list asks often) */
const cache = new Map<string, { size: number; mtimeMs: number; value: unknown }>()

async function readJsonCached(path: string): Promise<{ value: unknown; mtimeMs: number } | undefined> {
  try {
    const st = await stat(path)
    if (!st.isFile() || st.size > MAX_BYTES * 20) return undefined
    const known = cache.get(path)
    if (known && known.size === st.size && known.mtimeMs === st.mtimeMs) return { value: known.value, mtimeMs: known.mtimeMs }
    let value: unknown
    try {
      value = JSON.parse(await readFile(path, 'utf8'))
    } catch {
      // ⚠️ Caught half-written (the relay writes in place): the last good reading stays (no flicker on the phone)
      return known ? { value: known.value, mtimeMs: known.mtimeMs } : undefined
    }
    cache.set(path, { size: st.size, mtimeMs: st.mtimeMs, value })
    return { value, mtimeMs: st.mtimeMs }
  } catch {
    // ⚠️ Missing: no reading
    return undefined
  }
}

/**
 * The account a profile is logged in to (`oauthAccount.accountUuid` in its `.claude.json`), and when Claude Code last
 * fetched that profile (`profileFetchedAt`, ms).
 */
async function claudeAccount(d: ConfigDir): Promise<{ key: string | undefined; fetchedAtMs: number | undefined }> {
  // ★ The default profile can keep it in `~/.claude.json` (CLAUDE.md §5)
  for (const path of [join(d.dir, '.claude.json'), ...(d.account === '.claude' ? [join(homedir(), '.claude.json')] : [])]) {
    const got = await readJsonCached(path)
    if (!got || !isObject(got.value)) continue
    const oa = got.value.oauthAccount
    if (!isObject(oa)) continue
    const at = oa.profileFetchedAt
    return { key: accountKeyOf(oa.accountUuid), fetchedAtMs: typeof at === 'number' && Number.isFinite(at) ? at : undefined }
  }
  return { key: undefined, fetchedAtMs: undefined }
}

export async function claudeUsage(dirs: readonly ConfigDir[], nowMs: number = Date.now()): Promise<ToolUsage[]> {
  const out: ToolUsage[] = []
  for (const d of dirs) {
    try {
      const u = await profileUsage(d, nowMs)
      if (u) out.push(u)
    } catch {
      // ⚠️ One profile never fails the others
    }
  }
  return out
}

async function profileUsage(d: ConfigDir, nowMs: number): Promise<ToolUsage | undefined> {
  const path = claudeUsagePath(d.account)
  let got: { value: unknown; mtimeMs: number } | undefined
  try {
    const st = await stat(path)
    got = st.size <= MAX_BYTES ? await readJsonCached(path) : undefined
  } catch {
    got = undefined
  }
  if (!got) return undefined
  const windows = claudeWindows(got.value, nowMs)
  if (!windows) return undefined
  // ★★ Which account the reading belongs to (codex review rounds 1–2). The status line input does not say, and a profile
  //    can switch account after a reading was written. ⇒ The account is the reading's only when the profile was fetched
  //    **before** the reading (a login fetches the profile). Otherwise it is shown under the profile alone, never merged
  //    into an account it may not belong to (a later reading fixes it).
  const acct = await claudeAccount(d)
  const verified = acct.key !== undefined && acct.fetchedAtMs !== undefined && got.mtimeMs >= acct.fetchedAtMs
  return { tool: 'claude', account: d.account, ...(verified ? { accountKey: acct.key } : {}), windows, at: new Date(got.mtimeMs).toISOString() }
}
