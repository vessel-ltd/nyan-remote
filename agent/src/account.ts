// ★★ This agent's account and usage ticket (2026-09-24 / billing / docs/BILLING.md §2.3).
//
//   `~/.nyan-remote/account.json`   the machine credential (written by `nyan login` / 0600)
//   `~/.nyan-remote/license.json`   copy of the last usage ticket obtained (usable across restarts and while account is down)
//
// ★ The usage ticket is fetched at startup and every hour, and handed to the relay (`Licensing` in `relayLink.ts`).
// ★ After `nyan login` / `nyan logout` it is picked up within a minute (by watching account.json's mtime).
// ⚠️ Follow the state-file rules (`state.ts`): if broken, **don't write, don't recreate**, and record the reason.
// ⚠️ Never put the credential or the usage ticket itself in `/health` or the logs (only the plan and limits).
// ⚠️ No account = a normal state (Tailscale, own relay, grace period). We just don't send a usage ticket.

import { createHash } from 'node:crypto'
import { stat, unlink } from 'node:fs/promises'
import { toBase64Url } from '../../shared/crypto.ts'
import { ACCOUNT_ORIGIN } from '../../shared/distribution.ts'
import { t } from '../../shared/i18n.ts'
import type { LicenseStatus } from '../../shared/relayFrame.ts'
import type { AccountHealth } from '../../shared/types.ts'
import { agentPublicRaw } from './deviceKey.ts'
import type { Licensing } from './relayLink.ts'
import { readJsonFile, statePath, writeJson } from './state.ts'

export const ACCOUNT_FILE = 'account.json'
export const LICENSE_FILE = 'license.json'
/**
 * ★ Interval for re-fetching the usage ticket (1 hour / shortened from 6 hours on 2026-09-24).
 *   ⚠️ How long it takes for Plus to take effect after purchase = this interval (at 6 hours, "I paid but I'm still on free" lasted too long).
 *   ★ One light request per machine per hour (cost barely changes). Tickets expire after 24 hours ⇒ there is slack even if fetching fails for a while.
 */
export const LICENSE_REFRESH_MS = 60 * 60 * 1000
/** ★ Interval for watching account.json rewrites (`nyan login` / `logout`) */
export const ACCOUNT_WATCH_MS = 60 * 1000

export interface AccountFile {
  v: 1
  origin: string
  credential: string
  account: { id: string; login: string }
}

/**
 * ★★ Copy of the usage ticket. ⚠️⚠️ It records **which credential it was obtained with** (2026-09-24 / codex round 26, medium #13):
 *   Without that, signing in again as B while A's copy was still on disk meant that after a restart we **displayed B while using A's quota**.
 *   ⇒ On read, compare with the current credential and ignore it if different (`cred` is a prefix of the credential's hash = the credential itself is never written).
 */
interface LicenseFile {
  v: 2
  acct: string
  cred: string
  token: string
  plan: string
  maxMachines: number
  maxDevices: number
  /** seconds */
  exp: number
  login: string
}

type Fetch = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<Response>

interface State {
  account?: AccountFile
  /** ⚠️ account.json is broken (don't write; surface the reason) */
  broken?: string
  license?: LicenseFile
  relay?: LicenseStatus
  lastError?: string
  mtime?: number
}

let state: State = {}
/**
 * ★★ Sign-in generation (incremented every time the credential changes / 2026-09-24 / codex round 27, medium #9).
 *   ⚠️ Fetching a ticket awaits several times ⇒ check that the generation is unchanged **right before each state mutation**
 *      (checking only when the headers arrived let someone sign in again as B while we waited for the body, and we overwrote with A's ticket).
 */
let generation = 0
const listeners = new Set<() => void>()
let timers: ReturnType<typeof setInterval>[] = []

const validAccount = (v: Partial<AccountFile> | undefined): v is AccountFile =>
  v?.v === 1 &&
  typeof v.origin === 'string' &&
  /^https:\/\//.test(v.origin) &&
  typeof v.credential === 'string' &&
  /^[A-Za-z0-9_-]{20,100}$/.test(v.credential) &&
  typeof v.account?.id === 'string' &&
  typeof v.account?.login === 'string'

const validLicense = (v: Partial<LicenseFile> | undefined, nowSec: number): v is LicenseFile =>
  v?.v === 2 && typeof v.token === 'string' && typeof v.exp === 'number' && v.exp > nowSec && typeof v.plan === 'string'

/** ★ Identifies a credential (⚠️ the credential itself is never written) */
const credId = (credential: string) => createHash('sha256').update(credential).digest('base64url').slice(0, 16)
/** ★ Whether the copy belongs to the current sign-in */
const ownLicense = (l: LicenseFile, a: AccountFile | undefined) => a !== undefined && l.acct === a.account.id && l.cred === credId(a.credential)

async function dropLicenseFile(): Promise<void> {
  await unlink(statePath(LICENSE_FILE)).catch(() => undefined)
}

/** ★ Re-read account.json (⚠️ if broken, put the reason in `broken` and drop the current credential = don't use it) */
async function loadAccount(): Promise<void> {
  const f = await readJsonFile<Partial<AccountFile>>(ACCOUNT_FILE)
  if (f.kind === 'missing') {
    if (state.account) generation += 1
    state = { ...state, account: undefined, broken: undefined, license: undefined }
    return
  }
  if (f.kind === 'broken' || !validAccount(f.value)) {
    const why = f.kind === 'broken' ? f.reason : t('形が違います', 'wrong shape')
    if (state.account) generation += 1
    if (state.broken !== why) console.warn(t(`[account] account.json が読めません（${why}）: nyan login し直してください`, `[account] Cannot read account.json (${why}): run nyan login again`))
    state = { ...state, account: undefined, broken: why, license: undefined }
    return
  }
  const changed = state.account?.credential !== f.value.credential
  if (changed) generation += 1
  state = { ...state, account: f.value, broken: undefined, ...(changed ? { license: undefined, relay: undefined } : {}) }
}

async function loadLicense(nowSec: number): Promise<void> {
  const f = await readJsonFile<Partial<LicenseFile>>(LICENSE_FILE)
  if (f.kind === 'ok' && validLicense(f.value, nowSec) && ownLicense(f.value, state.account) && !state.license) state = { ...state, license: f.value }
}

/**
 * ★ Fetch the usage ticket. ⚠️ On failure, **keep going with the valid ticket on hand** (the relay stays usable even if account is down).
 *   ⚠️ On 401 (credential revoked), drop the ticket (don't keep using it after it was revoked).
 */
export async function refreshLicense(f: Fetch = (u, i) => fetch(u, i), now = Date.now()): Promise<void> {
  const a = state.account
  if (!a) return
  const gen = generation
  /** ⚠️ Signed in again mid-fetch ⇒ this response is for the old credential (touch neither state nor file) */
  const stale = () => gen !== generation
  let key: string
  try {
    // ★ The ticket is issued for **this machine's key** (account binds the credential to the key / codex round 26, high #3)
    key = toBase64Url(agentPublicRaw())
  } catch {
    state = { ...state, lastError: t('agent の鍵が使えないので利用券を取れません', 'Cannot get a usage ticket: the agent key is unavailable') }
    return
  }
  try {
    const res = await f(`${a.origin}/api/license`, {
      headers: { authorization: `Bearer ${a.credential}`, 'x-nyan-agent-key': key },
      signal: AbortSignal.timeout(10_000),
    })
    if (stale()) return
    if (res.status === 401 || res.status === 409) {
      state = {
        ...state,
        license: undefined,
        lastError:
          res.status === 401
            ? t('このマシンはアカウントから外されました（nyan login し直してください）', 'This machine was removed from the account (run nyan login again)')
            : t('このログインは別のマシンのものです（このマシンで nyan login し直してください）', 'This sign-in belongs to another machine (run nyan login on this machine)'),
      }
      // ⚠️ Remove the copy too (so a restart doesn't bring back the old ticket / codex round 26, medium #13)
      await dropLicenseFile()
      if (!stale()) notify()
      return
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = (await res.json()) as Partial<LicenseFile> & { license?: unknown }
    if (stale()) return
    const lic: Partial<LicenseFile> = {
      v: 2,
      acct: a.account.id,
      cred: credId(a.credential),
      token: j.license as string,
      plan: j.plan,
      maxMachines: j.maxMachines,
      maxDevices: j.maxDevices,
      exp: j.exp,
      login: j.login,
    }
    if (!validLicense(lic, Math.floor(now / 1000))) throw new Error(t('利用券の形が違います', 'The usage ticket has the wrong shape'))
    const changed = state.license?.token !== lic.token
    state = { ...state, license: lic, lastError: undefined }
    await writeJson(LICENSE_FILE, lic).catch(() => undefined)
    // ⚠️ Signed in again while writing ⇒ the copy we wrote is stale (`ownLicense` rejects it on read); don't notify
    if (changed && !stale()) notify()
  } catch (err) {
    if (stale()) return
    state = { ...state, lastError: t(`利用券を取れません: ${err instanceof Error ? err.message : String(err)}`, `Cannot get a usage ticket: ${err instanceof Error ? err.message : String(err)}`) }
  }
}

function notify(): void {
  for (const fn of listeners) {
    try {
      fn()
    } catch {
      // ⚠️ One failure must not stop the others
    }
  }
}

/**
 * ★ Re-fetch right now (`POST /account/refresh` = called first by `nyan account` / codex round 26, low #14).
 *   ⚠️ Don't make someone wait an hour right after purchasing. ⚠️ Also picks up account.json rewrites.
 */
export async function refreshAccountNow(f?: Fetch): Promise<AccountHealth> {
  state = { ...state, mtime: undefined }
  // ⚠️ If the credential changed, `watchAccount` has already re-fetched (don't ask twice)
  if (!(await watchAccount(f))) await refreshLicense(f)
  return accountHealth()
}

/** ★ Called at startup (⚠️ not awaited = a slow account service doesn't delay agent startup) */
export async function startAccount(o: { fetch?: Fetch } = {}): Promise<void> {
  stopAccount()
  await loadAccount()
  await loadLicense(Math.floor(Date.now() / 1000))
  state = { ...state, mtime: await mtimeOf() }
  void refreshLicense(o.fetch)
  const refresh = setInterval(() => void refreshLicense(o.fetch), LICENSE_REFRESH_MS)
  const watch = setInterval(() => void watchAccount(o.fetch), ACCOUNT_WATCH_MS)
  refresh.unref?.()
  watch.unref?.()
  timers = [refresh, watch]
}

async function mtimeOf(): Promise<number | undefined> {
  try {
    return (await stat(statePath(ACCOUNT_FILE))).mtimeMs
  } catch {
    return undefined
  }
}

/** ★ Picks up `nyan login` / `logout` (when account.json's mtime changes, re-read and re-fetch) */
export async function watchAccount(f?: Fetch): Promise<boolean> {
  const m = await mtimeOf()
  if (m === state.mtime) return false
  state = { ...state, mtime: m }
  const before = state.account?.credential
  await loadAccount()
  if (state.account?.credential === before) return false
  notify()
  await refreshLicense(f)
  return true
}

export function stopAccount(): void {
  for (const x of timers) clearInterval(x)
  timers = []
}

/** ★ The hook handed to the relay link (`relayRun.ts`) */
export const accountLicensing: Licensing = {
  current: () => {
    const l = state.license
    return l && l.exp > Date.now() / 1000 ? l.token : undefined
  },
  subscribe: (fn) => {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  report: (status) => {
    if (state.relay !== status) {
      if (status === 'machine-limit') console.warn(t('[account] relay: このプランで使えるマシンの台数を超えています（アカウントの画面でマシンを外すか、Plus にしてください）', '[account] relay: this plan’s machine limit is reached (remove a machine on the account page, or upgrade to Plus)'))
      else if (status !== 'ok') console.warn(t(`[account] relay が利用券を受け付けません（${status}）`, `[account] The relay did not accept the usage ticket (${status})`))
      else console.log(t('[account] relay が利用券を受け付けました', '[account] The relay accepted the usage ticket'))
    }
    state = { ...state, relay: status }
  },
}

/** ★ Exposed in `/health` (⚠️ never the credential or the ticket itself) */
export function accountHealth(): AccountHealth {
  const s = state
  return {
    signedIn: s.account !== undefined,
    ...(s.account ? { login: s.account.account.login } : {}),
    ...(s.license ? { plan: s.license.plan, maxMachines: s.license.maxMachines, maxDevices: s.license.maxDevices, exp: s.license.exp } : {}),
    ...(s.relay ? { relay: s.relay } : {}),
    ...(s.broken ? { problem: s.broken } : s.lastError ? { problem: s.lastError } : {}),
  }
}

/** ⚠️ For tests */
export function resetAccount(): void {
  stopAccount()
  state = {}
  generation += 1
  listeners.clear()
}

/** ★ The shape `nyan login` writes (⚠️ the CLI writes it; the agent only reads it) */
export function accountFileOf(credential: string, account: { id: string; login: string }, origin = ACCOUNT_ORIGIN): AccountFile {
  return { v: 1, origin, credential, account }
}
