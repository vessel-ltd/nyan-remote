import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DEFAULT_RELAY_URL } from '../../shared/distribution.ts'
import { readJsonFile, statePath, writeJson } from './state.ts'
import { t } from '../../shared/i18n.ts'
import { reasonText } from './reasons.ts'

export interface Config {
  /** ⚠️ Fixed to 127.0.0.1. tailscale serve is the only entrance (ARCHITECTURE.md §4.3) */
  host: string
  port: number
  /** If null, ~/.claude* are discovered automatically */
  configDirs: string[] | null
  /**
   * Allowed Tailscale-User-Login values.
   * If the first access arrives while this is empty, that login is recorded and fixed from then on (= pairing is "just open it").
   */
  allowedLogins: string[]
  /**
   * Origins other than the same origin that are allowed by CORS.
   *
   * ⚠️ Never loosen this. tailscale serve adds the identity headers "on the server side", so
   * if a tailnet user has any website open, that site's JS could
   * fetch https://<host>.ts.net/sessions. CORS is the only thing stopping the read.
   * Empty by default. However, **https origins on the same tailnet are allowed automatically** (auth.ts's
   * isAllowedOrigin). Only pages served by nodes on the same tailnet can have such an origin,
   * so there is no need to configure it by hand each time a second machine is added.
   * Put here only distribution origins outside the tailnet (such as a future GitHub Pages).
   */
  allowedOrigins: string[]
  /** Maximum number of sessions listed per account (newest mtime first) */
  maxSessionsPerAccount: number
  /**
   * Shared token that hooks/notify.sh uses to call POST /hook.
   *
   * Hooks come from local processes on this machine, so they carry no identity headers.
   * Loopback-or-not cannot tell them apart (serve also proxies from loopback),
   * so a token distinguishes them. The same value is also written to ~/.nyan-remote/hook-token (600)
   * so the shell can read it without jq.
   */
  hookToken: string
  /**
   * ★ The relay entrance (step 6 of ③ / e.g. `wss://nyan-relay.example.workers.dev`).
   *
   * ⚠️ **If absent, relay is not used** (`local` only = as before).
   * ⚠️⚠️ Even if malformed, it **does not make every request 503** (unlike config.json, what is lost when it is broken
   *    is only the relay route / same treatment as `deviceKey.ts`). The reason is shown in `/health`'s `relay`.
   */
  relayUrl?: string
}

const DEFAULTS: Config = {
  host: '127.0.0.1',
  port: 7777,
  configDirs: null,
  allowedLogins: [],
  allowedOrigins: [],
  maxSessionsPerAccount: 60,
  hookToken: '',
  // ★★ **relay is now the default** (2026-09-18 / user decision / `shared/distribution.ts`).
  //   ⚠️⚠️ Before this there were "agents without relay configured", and those users
  //      could not use step 7 of ③ (pairing via relay) = they were stuck depending on the tailnet.
  //   ⚠️ Override with `relayUrl` in `config.json`. ⚠️ **To disable it, use `"relayUrl": ""`**
  //      (malformed, so it is not used; the reason appears in `/health`'s `relay`).
  relayUrl: DEFAULT_RELAY_URL,
}

const FILE = 'config.json'
const TOKEN_FILE = 'hook-token'

let cached: Config | null = null

/**
 * Why the config could not be read.
 *
 * ★★ **If it cannot be read, this is not a "first run". Refuse everything.** (2026-08-13 external review finding)
 *
 * ⚠️ **Why not "refuse to start" (design decision)**:
 *    Refusing to start means one broken file keeps the agent down, and **nothing is visible from the phone**
 *    = not even the reason gets through. This is a resident process, so "up but doing nothing" recovers faster.
 *    → **It starts, but refuses every request with 503 and shows the reason in the log and on screen.**
 *      On screen it appears as "<label>: <reason>" in `web/src/main.tsx`.
 *
 * ⚠️ In this state **the config file is not rewritten** (keep the evidence so it can be recovered).
 *    `hook-token` is not touched either (so the Bearer of already-installed hooks is not broken).
 */
export interface ConfigProblem {
  /** ★ Only a category that is safe to expose (goes in the 503 body; returned before authentication) */
  reason: string
  /** Detail for the log. ⚠️ May contain absolute paths or file contents, so **never expose it** */
  detail: string
  path: string
  /** `unreadable` = cannot be read (move aside and recreate) / `invalid` = readable but contents are lacking (fixable) */
  kind: 'unreadable' | 'invalid'
}

let problem: ConfigProblem | null = null

/** Returns the reason if the config could not be read. null means OK */
export function configProblem(): ConfigProblem | null {
  return problem
}

/**
 * ★★ Validate the contents of a config that could be read (2026-08-14 external review, high).
 *
 * ⚠️ "Readable as JSON" is not enough. A file with **correct syntax but missing contents**, e.g.
 *
 *      { "hookToken": "…" }        ← no allowedLogins
 *
 *    falls back to the default `[]`, so **it claims "first run" again and TOFU reopens**.
 *    This really happens with restore accidents, hand edits and write-backs, and would undo closing the fail-open.
 *
 * ⚠️ `hookToken` is required too. Without it we would **recreate it and overwrite the broken file**,
 *    diverging from the installed hooks' Bearer so **approvals silently stop arriving**.
 *
 * ★ "No file" is a first run and never gets here (the normal procedure does not break).
 *
 * @returns The reason if there is a problem, otherwise null
 */
export function validateConfig(stored: Partial<Config>): string | null {
  const o = stored as Record<string, unknown>
  const logins = o['allowedLogins']
  if (!Array.isArray(logins) || logins.some((v) => typeof v !== 'string')) {
    return 'allowedLogins が文字列の配列ではありません（ペアリングが開き直るため拒否します）'
  }
  const token = o['hookToken']
  if (typeof token !== 'string' || token.length === 0) {
    return 'hookToken がありません（作り直すと設置済みフックの承認が飛ばなくなるため拒否します）'
  }
  // The following only check "if present, the type is correct" (defaults are fine if absent)
  const origins = o['allowedOrigins']
  if (origins !== undefined && (!Array.isArray(origins) || origins.some((v) => typeof v !== 'string'))) {
    return 'allowedOrigins が文字列の配列ではありません'
  }
  const dirs = o['configDirs']
  if (
    dirs !== undefined &&
    dirs !== null &&
    (!Array.isArray(dirs) || dirs.some((v) => typeof v !== 'string'))
  ) {
    return 'configDirs が文字列の配列でも null でもありません'
  }
  const max = o['maxSessionsPerAccount']
  if (max !== undefined && (typeof max !== 'number' || !Number.isFinite(max) || max <= 0)) {
    return 'maxSessionsPerAccount が正の数ではありません'
  }
  const relay = o['relayUrl']
  // ⚠️ Only the **type** is checked here (the shape is judged by `isRelayBase`; the agent starts even if it is broken)
  if (relay !== undefined && typeof relay !== 'string') {
    return 'relayUrl が文字列ではありません'
  }
  const port = o['port']
  if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port <= 0)) {
    return 'port が正の整数ではありません'
  }
  return null
}

function applyPortEnv(cfg: Config): void {
  if (process.env.NYAN_REMOTE_PORT) {
    const p = Number(process.env.NYAN_REMOTE_PORT)
    if (Number.isInteger(p) && p > 0) cfg.port = p
  }
}

export async function loadConfig(): Promise<Config> {
  const read = await readJsonFile<Partial<Config>>(FILE)

  // ★ Refuse not only "unreadable" but also "contents missing" (read the notes on validateConfig)
  const invalid = read.kind === 'ok' ? validateConfig(read.value) : null
  if (read.kind === 'broken' || invalid) {
    // ⚠️ Continuing here as `{}` would reopen pairing and recreate the hook token.
    //    Start in a "refuse mode" holding only defaults. **Write nothing at all**
    problem =
      read.kind === 'broken'
        ? { reason: read.reason, detail: read.detail, path: statePath(FILE), kind: 'unreadable' }
        : { reason: invalid ?? '', detail: invalid ?? '', path: statePath(FILE), kind: 'invalid' }
    const locked: Config = { ...DEFAULTS }
    applyPortEnv(locked)
    cached = locked
    logProblem(problem)
    return locked
  }

  problem = null
  const stored = read.kind === 'ok' ? read.value : {}
  const cfg: Config = { ...DEFAULTS, ...stored, host: DEFAULTS.host }
  applyPortEnv(cfg)

  let dirty = false
  if (!cfg.hookToken) {
    cfg.hookToken = randomBytes(24).toString('base64url')
    dirty = true
  }
  cached = cfg
  if (dirty) await writeJson(FILE, cfg, 0o600)
  await writeTokenFile(cfg.hookToken)
  return cfg
}

function logProblem(p: ConfigProblem): void {
  console.error(t(`[config] ⚠️⚠️ 設定ファイルを使えません: ${p.path}`, `[config] ⚠️⚠️ Cannot use the config file: ${p.path}`))
  console.error(t(`[config]    理由: ${p.reason}`, `[config]    Reason: ${reasonText(p.reason)}`))
  if (p.detail && p.detail !== p.reason) console.error(t(`[config]    詳細: ${p.detail}`, `[config]    Detail: ${p.detail}`))
  console.error(
    t(
      '[config] ⚠️ 安全側に倒して**全ての要求を 503 で拒否**します' +
        '（壊れた設定を「初回起動」と誤認してペアリングが開き直るのを防ぐため）。' +
        'ファイルは書き換えていません',
      '[config] ⚠️ Failing safe: **every request is refused with 503** ' +
        '(so a broken config is not mistaken for a first run, which would reopen pairing). ' +
        'The file has not been modified',
    ),
  )
  if (p.kind === 'invalid') {
    // ★ The contents are readable. **Do not suggest moving it aside** (that would recreate even the hook token)
    console.error(t('[config] 直し方: 足りない・型が違うキーを直して再起動する', '[config] To fix: correct the missing or mistyped keys and restart'))
    console.error(
      t(
        `[config]   hookToken が無い場合は ${statePath(TOKEN_FILE)} の値を貼り戻せる`,
        `[config]   If hookToken is missing, you can paste back the value from ${statePath(TOKEN_FILE)}`,
      ),
    )
    console.error(t('[config]   allowedLogins は文字列の配列（例: ["you@github"]）', '[config]   allowedLogins is an array of strings (e.g. ["you@github"])'))
  } else {
    console.error(t('[config] 直し方: 中身を直すか、退避してから再起動する:', '[config] To fix: repair the contents, or move the file aside and restart:'))
    console.error(`[config]   mv ${p.path} ${p.path}.broken && systemctl --user restart nyan-remote`)
    console.error(
      t(
        '[config] ⚠️ 退避すると許可ログインと hook トークンが作り直されるので、' +
          'このマシンで node scripts/install-permission-hook.mjs をやり直すこと',
        '[config] ⚠️ Moving it aside recreates the allowed logins and the hook token, ' +
          'so run node scripts/install-permission-hook.mjs again on this machine',
      ),
    )
  }
}

/** Make it readable from the shell (hooks/notify.sh) without jq */
async function writeTokenFile(token: string): Promise<void> {
  const path = statePath(TOKEN_FILE)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, `${token}\n`, { mode: 0o600 })
  const { rename } = await import('node:fs/promises')
  await rename(tmp, path)
}

export function hookTokenPath(): string {
  return statePath(TOKEN_FILE)
}

export function config(): Config {
  if (!cached) throw new Error(t('loadConfig() を先に呼ぶこと', 'Call loadConfig() first'))
  return cached
}

/**
 * The explanation returned in refuse mode. Shown as is on the phone screen (main.tsx displays `error`).
 *
 * ⚠️ **Never include absolute paths** (2026-08-14 external review finding).
 *    This response is returned **before authentication**, so it is visible even to logins that are not allowed.
 *    It used to include `${p.path}` with the note "the viewer is the person who fixes it, so hiding it makes it unfixable",
 *    but **that premise was wrong** (before authentication we cannot limit who the viewer is).
 *    The absolute path and reason needed for the fix **are written to the log** (`logProblem`).
 */
export function problemMessage(p: ConfigProblem): string {
  // ⚠️ Only `reason` (the category) may go here. **Never include** `detail` or `path`
  //    (EACCES contains the absolute home path; JSON errors contain the first 10 characters of the file)
  return t(
    `agent の設定ファイル（config.json）を使えないため、安全側に倒して全ての要求を拒否しています` +
      `（${p.reason}）。PC側のログを見て設定を直し、agent を再起動してください`,
    `The agent config file (config.json) cannot be used, so all requests are being refused to stay safe ` +
      `(${reasonText(p.reason)}). Check the log on the PC, fix the config, and restart the agent.`,
  )
}

/** Record the login of the first access (§8.2: pairing is just opening the URL) */
export async function rememberLogin(login: string): Promise<void> {
  // ⚠️ A second barrier. In refuse mode requests never get here, but even if one does, **never record it**
  //    (it would overwrite the broken config and lock in the pairing)
  if (problem) {
    console.error(t('[auth] 設定が読めていないため、許可ログインの記録を拒否しました', '[auth] Refused to record an allowed login because the config could not be read'))
    return
  }
  const cfg = config()
  if (cfg.allowedLogins.includes(login)) return
  cfg.allowedLogins.push(login)
  await writeJson(FILE, cfg, 0o600)
  console.log(t(`[auth] 許可ログインに追加しました: ${login} (${statePath(FILE)})`, `[auth] Added to allowed logins: ${login} (${statePath(FILE)})`))
}
