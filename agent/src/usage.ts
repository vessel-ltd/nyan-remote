// ★ Plan limits of each Claude profile and Codex home (`GET /usage` / 2026-11-17).
//
// Where the numbers come from (measured 2026-11-17, Claude Code 2.1.326 / codex-cli 0.169.0):
//   - Claude: the status line command gets `rate_limits.five_hour` / `.seven_day` (`used_percentage`, `resets_at`) after
//     each API response — a documented field. Our relay (`hooks/statusline.sh`) writes that input, with the account
//     the session is logged in to, to `~/.nyan-remote/usage/claude-<profile>.json`, then runs the user's own status
//     line command unchanged.
//     ⚠️ Only while a session of that profile runs: the reading is "as of" the file's time.
//     ⚠️ `.claude.json`'s `cachedUsageUtilization` is written only when `/usage` is opened (days old) ⇒ not used.
//     ⚠️⚠️ Never Claude's OAuth token: calling the usage API with it is not ours to do.
//   - Codex: `account/rateLimits/read` on the line we already hold (`codex/run.ts`).
// ⚠️ Which windows exist depends on the plan (a 5-hour window is not on every plan, Claude or Codex) ⇒ only what is
//    reported is shown, never assumed.
// ⚠️ Limits belong to the account, and two profiles can be one account (measured: `.claude-r` and `.claude-rs`) ⇒
//    `accountKey`, a short hash (the id itself never leaves the machine).
// ⚠️ A window whose reset has passed is dropped: its number is no longer true, and the next one is unknown.
// ★ Who is logged in is shown too, as each tool's `/status` does (2026-11-17): Claude from the profile's config
//   (`oauthAccount`: e-mail, organization, organization type) **only when it names the account the relay recorded**;
//   Codex from `account/read` (e-mail, plan, workspace). Display only.

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

/** The shape of an account id as the relay records it */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

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

/**
 * A name to show as it is, or nothing. ⚠️ It comes from a file or a server: no control, format (bidi, invisible) or
 * line-separator character, and not longer than `max` (a value that fails is dropped whole, never cleaned up).
 */
function shownText(v: unknown, max: number): string | undefined {
  // ⚠️ Judged on the string as sent, before any trim (codex review: trimming first let a newline or 300 spaces through)
  if (typeof v !== 'string' || v.length > max || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(v)) return undefined
  const s = v.trim()
  return s !== '' ? s : undefined
}

/** A plan / type id as the tools spell them (`prolite`, `claude_team`) */
function planId(v: unknown): string | undefined {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v) ? v : undefined
}

/** Who is logged in to a Codex home, from `account/read` (a ChatGPT login only; an API key has no e-mail) */
export function codexLoginOf(result: unknown): Pick<ToolUsage, 'email' | 'org' | 'plan'> {
  if (!isObject(result) || !isObject(result.account) || result.account.type !== 'chatgpt') return {}
  const a = result.account
  const email = shownText(a.email, 254)
  const org = shownText(a.workspaceName, 120)
  const plan = planId(a.planType)
  return { ...(email ? { email } : {}), ...(org ? { org } : {}), ...(plan ? { plan } : {}) }
}

/**
 * The login read before and after the limits, if both reads name the same login (same user, e-mail, plan, workspace).
 * Anything else ⇒ nothing (the numbers are shown without a login rather than with someone else's).
 */
export function codexLoginBetween(before: unknown, after: unknown): Pick<ToolUsage, 'email' | 'org' | 'plan'> {
  const a = codexLoginOf(before)
  const b = codexLoginOf(after)
  const userOf = (r: unknown): unknown => (isObject(r) ? r.userId : undefined)
  const same = a.email !== undefined && a.email === b.email && a.org === b.org && a.plan === b.plan && userOf(before) === userOf(after)
  return same ? a : {}
}

/** Who is logged in, from a Claude config (`oauthAccount`), only when it is the account `uuid` */
export function claudeLoginOf(config: unknown, uuid: string): Pick<ToolUsage, 'email' | 'org' | 'plan'> | undefined {
  if (!isObject(config) || !isObject(config.oauthAccount)) return undefined
  const o = config.oauthAccount
  // ⚠️⚠️ The same account the reading was recorded with, or nothing (the config may have moved on to another login)
  if (o.accountUuid !== uuid) return undefined
  const email = shownText(o.emailAddress, 254)
  const org = shownText(o.organizationName, 120)
  const plan = planId(o.organizationType)
  return { ...(email ? { email } : {}), ...(org ? { org } : {}), ...(plan ? { plan } : {}) }
}

/** A Claude config is ~200 KB (measured); a bigger one is not read (the same cap as `configDirs.ts`) */
const MAX_CONFIG_BYTES = 5 * 1024 * 1024

/**
 * The configs a profile may use: `<dir>/.claude.json`, and for the default profile (`~/.claude`, run without
 * `CLAUDE_CONFIG_DIR`) `~/.claude.json` first. ⚠️ Which one the session used is not known here ⇒ the account id decides.
 */
function configCandidates(d: ConfigDir, home: string): string[] {
  const own = join(d.dir, '.claude.json')
  return d.dir.replace(/\/+$/, '') === join(home, '.claude') ? [join(home, '.claude.json'), own] : [own]
}

/** Reads, kept while the file is unchanged (the list asks often) */
const cache = new Map<string, { size: number; mtimeMs: number; value: unknown }>()

async function readJsonCached(path: string, maxBytes: number = MAX_BYTES): Promise<{ value: unknown; mtimeMs: number } | undefined> {
  try {
    const st = await stat(path)
    if (!st.isFile() || st.size > maxBytes) return undefined
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

export async function claudeUsage(dirs: readonly ConfigDir[], nowMs: number = Date.now(), home: string = homedir()): Promise<ToolUsage[]> {
  const out: ToolUsage[] = []
  for (const d of dirs) {
    try {
      const u = await profileUsage(d, nowMs, home)
      if (u) out.push(u)
    } catch {
      // ⚠️ One profile never fails the others
    }
  }
  return out
}

async function profileUsage(d: ConfigDir, nowMs: number, home: string): Promise<ToolUsage | undefined> {
  const path = claudeUsagePath(d.account)
  let got: { value: unknown; mtimeMs: number } | undefined
  try {
    const st = await stat(path)
    got = st.size <= MAX_BYTES ? await readJsonCached(path) : undefined
  } catch {
    got = undefined
  }
  if (!got) return undefined
  // ★★ The relay writes `{ nyanAccount, input }`: the account read from the session's own config **at the moment it
  //    wrote** (codex review rounds 1–3: the agent could not prove it afterwards from times or the profile's files).
  //    A file without it (an older relay) is the bare input, shown under its profile alone, never merged.
  const wrapped = isObject(got.value) && isObject(got.value.input) ? got.value : undefined
  const windows = claudeWindows(wrapped ? wrapped.input : got.value, nowMs)
  if (!windows) return undefined
  const uuid = wrapped && typeof wrapped.nyanAccount === 'string' && UUID.test(wrapped.nyanAccount) ? wrapped.nyanAccount : undefined
  const accountKey = accountKeyOf(uuid)
  // ★ Who that account is (`/status`'s login and organization), from a config that names the same account
  let login: Pick<ToolUsage, 'email' | 'org' | 'plan'> = {}
  if (uuid) {
    for (const path of configCandidates(d, home)) {
      const found = claudeLoginOf((await readJsonCached(path, MAX_CONFIG_BYTES))?.value, uuid)
      if (found) {
        login = found
        break
      }
    }
  }
  return { tool: 'claude', account: d.account, ...(accountKey ? { accountKey } : {}), ...login, windows, at: new Date(got.mtimeMs).toISOString() }
}
