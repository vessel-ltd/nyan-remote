#!/usr/bin/env node
// ★★ `nyan login` / `nyan logout` / `nyan account` (2026-09-24 / billing / docs/BILLING.md §2.3).
//
//   login    sign in with GitHub's Device Flow → register this machine with account → store the credential in `~/.nyan-remote/account.json` (0600)
//   logout   discard the credential (also removes it from account = also removed from the relay's ledger)
//   account  current plan, limits and the relay's answer (from the agent's `/health`)
//
// ⚠️ An account is needed **only when using our relay** (not for Tailscale or your own relay).
// ⚠️ The GitHub token is handed to account once and **never stored**. The credential is never shown on screen.
// ⚠️ The agent picks up account.json within a minute (`agent/src/account.ts`) ⇒ no restart needed.

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { ACCOUNT_ORIGIN, GITHUB_CLIENT_ID } from '../shared/distribution.ts'
import { t } from '../shared/i18n.ts'
import { agentUrl, initCliLang } from './lib/lang.mjs'
import { isMain } from './lib/isMain.mjs'
import { openUrl } from './lib/openUrl.mjs'

const stateDir = () => process.env.NYAN_REMOTE_STATE_DIR ?? join(homedir(), '.nyan-remote')
const accountPath = () => join(stateDir(), 'account.json')
const port = () => {
  try {
    return Number(process.env.NYAN_REMOTE_PORT ?? JSON.parse(readFileSync(join(stateDir(), 'config.json'), 'utf8')).port ?? 7777)
  } catch {
    return Number(process.env.NYAN_REMOTE_PORT ?? 7777)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function readAccount() {
  try {
    return JSON.parse(readFileSync(accountPath(), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * ★★ Lock held while touching account.json (makes login's replacement and logout's "check then remove" mutually exclusive / codex round 32, medium).
 *   ⚠️ It excludes other processes, so it is needed even for synchronous code. ⚠️ A lock from a crashed process is considered stale after 30 seconds.
 */
async function withAccountLock(fn) {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 })
  const lock = join(stateDir(), 'account.lock')
  for (let i = 0; ; i++) {
    try {
      closeSync(openSync(lock, 'wx', 0o600))
      break
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { force: true })
      } catch {
        // ⚠️ gone ⇒ it can be taken next round
      }
      if (i > 100) throw new Error(t('account.json を触っている別の nyan が終わりません', 'Another nyan is still using account.json'))
      await sleep(100)
    }
  }
  try {
    return await fn()
  } finally {
    rmSync(lock, { force: true })
  }
}

/** ⚠️ Temp file → replace, 0600 (never leave a half-written credential) */
function writeAccount(v) {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 })
  const tmp = `${accountPath()}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600, flag: 'wx' })
  renameSync(tmp, accountPath())
}

/**
 * ★ Identify to the agent (`~/.nyan-remote/hook-token` / same as `nyan devices`). ⚠️ Without it `/health` refuses
 *   (on 2026-09-24 a real machine wrongly showed "the agent is old"). If unreadable, ask without identifying (old agent, dev).
 */
function agentHeaders() {
  try {
    const tok = readFileSync(join(stateDir(), 'hook-token'), 'utf8').trim()
    return tok ? { 'x-nyan-remote-token': tok } : {}
  } catch {
    return {}
  }
}

/** ★ This agent's public key (the key for the relay's ledger). ⚠️ If the agent is stopped, continue without it (the relay counts it later) */
async function agentPublicKey(f) {
  try {
    const res = await f(agentUrl(port(), '/health'), { headers: agentHeaders(), signal: AbortSignal.timeout(3000) })
    const j = await res.json()
    return typeof j.agentPublicKey === 'string' ? j.agentPublicKey : undefined
  } catch {
    return undefined
  }
}

/**
 * ★★★ GitHub's Device Flow (https://docs.github.com/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow).
 * @returns the GitHub token (⚠️ never stored), or undefined on failure
 */
export async function githubDeviceToken(f = fetch, wait = sleep, print = console.log, open = openUrl) {
  const form = (o) => new URLSearchParams(o).toString()
  const start = await f('https://github.com/login/device/code', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: GITHUB_CLIENT_ID }),
  })
  const s = await start.json().catch(() => ({}))
  if (!start.ok || typeof s.device_code !== 'string' || typeof s.user_code !== 'string') {
    console.error(t('✗ GitHub に繋がりません（しばらくしてから、もう一度）', '✗ Cannot reach GitHub (try again later)'))
    return undefined
  }
  print(t(`ブラウザで ${s.verification_uri ?? 'https://github.com/login/device'} を開き、このコードを入れてください:`, `Open ${s.verification_uri ?? 'https://github.com/login/device'} in a browser and enter this code:`))
  print(`\n    ${s.user_code}\n`)
  // ★ Open the page to enter the code (⚠️ the URL is printed above even if it cannot be opened)
  open(typeof s.verification_uri === 'string' ? s.verification_uri : 'https://github.com/login/device')
  print(t('（待っています… Ctrl-C でやめます）', '(Waiting… press Ctrl-C to stop)'))
  let interval = Math.max(5, Number(s.interval) || 5) * 1000
  const deadline = Date.now() + Math.min(900, Number(s.expires_in) || 900) * 1000
  while (Date.now() < deadline) {
    await wait(interval)
    const res = await f('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ client_id: GITHUB_CLIENT_ID, device_code: s.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
    })
    const j = await res.json().catch(() => ({}))
    if (typeof j.access_token === 'string') return j.access_token
    if (j.error === 'authorization_pending') continue
    if (j.error === 'slow_down') {
      interval += 5000
      continue
    }
    if (j.error === 'access_denied') {
      console.error(t('✗ ログインが取り消されました', '✗ Sign-in was cancelled'))
      return undefined
    }
    if (j.error === 'expired_token') break
    console.error(t(`✗ GitHub がログインを断りました（${j.error ?? res.status}）`, `✗ GitHub refused the sign-in (${j.error ?? res.status})`))
    return undefined
  }
  console.error(t('✗ 時間切れです。もう一度 nyan login を打ってください', '✗ Timed out. Run nyan login again'))
  return undefined
}

export async function login(f = fetch, wait = sleep, open = openUrl) {
  const token = await githubDeviceToken(f, wait, console.log, open)
  if (!token) return 1
  const agentKey = await agentPublicKey(f)
  let res
  try {
    res = await f(`${ACCOUNT_ORIGIN}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ githubToken: token, label: hostname(), ...(agentKey ? { agentKey } : {}) }),
    })
  } catch (err) {
    console.error(t(`✗ アカウントに繋がりません: ${err.message}`, `✗ Cannot reach the account service: ${err.message}`))
    return 1
  }
  const j = await res.json().catch(() => ({}))
  if (!res.ok || typeof j.credential !== 'string') {
    const why = j.error === 'too-many-machines' ? t('登録できるマシンの上限です（アカウントの画面で外してください）', 'Too many machines registered (remove some on the account page)') : String(j.error ?? res.status)
    console.error(t(`✗ ログインできませんでした: ${why}`, `✗ Sign-in failed: ${why}`))
    return 1
  }
  await withAccountLock(() => writeAccount({ v: 1, origin: ACCOUNT_ORIGIN, credential: j.credential, account: { id: j.account.id, login: j.account.login } }))
  const plan = j.account.plan === 'plus' ? 'Plus' : 'Free'
  console.log(t(`✅ ${j.account.login} でログインしました（${plan}）`, `✅ Signed in as ${j.account.login} (${plan})`))
  console.log(t('   agent が1分以内に拾います（再起動は要りません）。プランの確認: nyan account', '   The agent picks it up within a minute (no restart needed). Check your plan: nyan account'))
  // ★ Open the account page (plan, purchase, machine management / 2026-09-24 user request)
  console.log(t(`   アカウントの画面: ${ACCOUNT_ORIGIN}`, `   Account page: ${ACCOUNT_ORIGIN}`))
  open(ACCOUNT_ORIGIN)
  return 0
}

/**
 * ★★ Logout (2026-09-24 / fixed in codex round 26, medium #12).
 *   ⚠️⚠️ Remove the local copy only **after confirming** account removed it. It used to remove it even on failure and say "removed"
 *      (the credential stayed on the server, and anyone with a copy could keep getting licenses).
 *   ⚠️ On failure, keep the local copy and say so (running it again retries). `--force` removes only the local copy (and says so).
 */
export async function logout(f = fetch, o = { force: false }) {
  const a = readAccount()
  if (!a) {
    console.log(t('ログインしていません', 'Not signed in'))
    return 0
  }
  let why
  try {
    const res = await f(`${a.origin}/api/logout`, { method: 'POST', headers: { authorization: `Bearer ${a.credential}` }, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) why = `HTTP ${res.status}`
  } catch (err) {
    why = err instanceof Error ? err.message : String(err)
  }
  if (why && !o.force) {
    console.error(t(`✗ アカウントから外せませんでした（${why}）。ログインは残しています。もう一度 nyan logout するか、アカウントの画面でこのマシンを外してください: ${ACCOUNT_ORIGIN}`, `✗ Could not remove this machine from the account (${why}). You are still signed in. Run nyan logout again, or remove it on the account page: ${ACCOUNT_ORIGIN}`))
    return 1
  }
  // ⚠️ If `nyan login` was run again in another window meanwhile, do not remove that new login (codex rounds 31 and 32)
  //   ⚠️ Keep check-then-remove inside the lock (if interrupted, it removed a new login written after the check)
  const removed = await withAccountLock(() => {
    if (readAccount()?.credential !== a.credential) return false
    rmSync(accountPath(), { force: true })
    rmSync(join(stateDir(), 'license.json'), { force: true })
    return true
  })
  if (!removed) {
    console.log(t('⚠️ その間に新しいログインが書かれたので、そちらは残しました', '⚠️ A new sign-in was saved meanwhile; it was kept'))
    return why ? 1 : 0
  }
  if (why) {
    console.log(t(`⚠️ このマシンのログインだけ消しました（アカウントからは外れていません: ${why}）。アカウントの画面で外してください: ${ACCOUNT_ORIGIN}`, `⚠️ Removed the sign-in on this machine only (it is still on the account: ${why}). Remove it on the account page: ${ACCOUNT_ORIGIN}`))
    return 1
  }
  console.log(t('ログアウトしました（このマシンをアカウントから外しました）', 'Signed out (this machine was removed from the account)'))
  return 0
}

/** ★ Make the agent fetch a license right now (right after purchase / codex round 26, low #14). ⚠️ Old agents return 404 ⇒ fall through to `/health` silently */
async function refreshAgent(f) {
  try {
    await f(agentUrl(port(), '/account/refresh'), { method: 'POST', headers: agentHeaders(), signal: AbortSignal.timeout(15_000) })
  } catch {
    // ⚠️ If it does not arrive, the next `/health` says why
  }
}

export async function account(f = fetch) {
  let h
  await refreshAgent(f)
  try {
    const res = await f(agentUrl(port(), '/health'), { headers: agentHeaders(), signal: AbortSignal.timeout(3000) })
    // ⚠️ Do not misread a refusal as "old agent" (the refusal body has no `account`)
    if (!res.ok) {
      console.error(t(`✗ agent が答えを断りました（HTTP ${res.status}）。agent を nyan update してから、もう一度`, `✗ The agent refused (HTTP ${res.status}). Run nyan update, then try again`))
      return 2
    }
    h = await res.json()
  } catch {
    console.error(t('✗ agent に繋がりません（止まっているかもしれません）', '✗ Cannot reach the agent (it may be stopped)'))
    return 2
  }
  const a = h.account
  // ★ The agent returns no `account` = an old version (e.g. `git pull` without restarting / got confused on a real machine 2026-09-24)
  if (!a) {
    console.log(t('⚠️ agent が旧い版です（ログインの情報を読めません）。nyan update してください', '⚠️ The agent is an older version (it cannot read the sign-in). Run nyan update'))
    return 0
  }
  if (!a.signedIn) {
    // ★ There is a local sign-in record ⇒ the agent just has not picked it up yet (within a minute)
    if (readAccount()) {
      console.log(t('ログインは済んでいます。agent が拾うまで最大1分です（少し待ってから、もう一度 nyan account）', 'You are signed in. The agent picks it up within a minute (wait a moment, then run nyan account again)'))
    } else {
      console.log(t('ログインしていません（こちらの relay を使うなら: nyan login）', 'Not signed in (to use our relay: nyan login)'))
    }
    if (a.problem) console.log(`  ${a.problem}`)
    return 0
  }
  const plan = a.plan === 'plus' ? 'Plus' : a.plan === 'free' ? 'Free' : t('不明', 'unknown')
  console.log(t(`アカウント: ${a.login}`, `Account:  ${a.login}`))
  console.log(t(`プラン:     ${plan}（マシン ${a.maxMachines ?? '?'}台・スマホ ${a.maxDevices ?? '?'}台まで）`, `Plan:     ${plan} (up to ${a.maxMachines ?? '?'} machines, ${a.maxDevices ?? '?'} phones)`))
  const relay = {
    ok: t('受け付けられています', 'accepted'),
    'machine-limit': t('⚠️ マシンの台数の上限です（アカウントの画面で外すか Plus に）', '⚠️ machine limit reached (remove one on the account page or upgrade)'),
    invalid: t('⚠️ 利用券が通りません', '⚠️ usage ticket rejected'),
    expired: t('⚠️ 利用券が切れています', '⚠️ usage ticket expired'),
    revoked: t('⚠️ このマシンはアカウントから外されました（nyan login し直してください）', '⚠️ this machine was removed from the account (run nyan login again)'),
  }[a.relay] ?? t('まだ送っていません', 'not sent yet')
  console.log(t(`relay:      ${relay}`, `Relay:    ${relay}`))
  if (a.problem) console.log(`  ${a.problem}`)
  console.log(t(`管理: ${ACCOUNT_ORIGIN}`, `Manage: ${ACCOUNT_ORIGIN}`))
  return 0
}

export async function main(argv = process.argv.slice(2)) {
  initCliLang()
  const [cmd] = argv
  if (cmd === 'login') return await login()
  if (cmd === 'logout') return await logout(fetch, { force: argv.includes('--force') })
  if (cmd === 'account') return await account()
  console.error(t('使い方: nyan login | nyan logout | nyan account', 'Usage: nyan login | nyan logout | nyan account'))
  return 2
}

if (isMain(process.argv[1], import.meta.url)) {
  process.exit(await main())
}
