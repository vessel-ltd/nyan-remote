#!/usr/bin/env node
// ★★ `nyan uninstall` (2026-09-26 / user decision).
//
// ★ Why a command and not a list of steps in the README: installing touches **5 places outside the tree**
//   (the rc files' PATH block, the hooks in every `~/.claude*/settings.json`, the service, `~/.claude/hooks/notify.sh`,
//   `~/.nyan-remote/`). Deleting only the tree leaves hooks pointing at a dead 127.0.0.1 port (on WSL a dead port
//   hangs instead of failing / CLAUDE.md §4) and, when signed in, a machine slot taken on the account.
// ⚠️ It only calls the existing removers (never write a step in two places):
//   `install-permission-hook.mjs --remove` / `install-notify.mjs --remove` / `install-relay.mjs --uninstall` / `account.mjs logout`.
// ⚠️⚠️ Order matters:
//   pending check → sign out (needs account.json) → pending check again → stop the service → confirm the agent is gone →
//   hooks → notify.sh (after the hooks that call it) → shim, rc blocks and `nyan` → the service file (last among config:
//   a retry reads the state directory from it) → the tree → the state directory (only with `--purge`).
// ⚠️⚠️ **The state directory is kept by default** (`vapid.json` / `device-key.json` cannot be recovered; keeping them means a
//   reinstall needs no re-pairing). `--purge` removes it **only when every entry in it is a file we write**.
// ⚠️ A git working tree is never removed (it is the developer's checkout).
// ⚠️ Every `rm -rf` target is proven ours first (codex 2026-09-26: an arbitrary `NYAN_REMOTE_STATE_DIR` holding a `config.json`,
//   and a checkout named like a backup, were both deletable in the first version).

import { spawnSync } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { t } from '../shared/i18n.ts'
import { initCliLang } from './lib/lang.mjs'
import { isMain } from './lib/isMain.mjs'
import { launchdLogPath, launchdPlistPath, serviceKind } from './lib/service.mjs'
import { helpDetail, pendingDecision } from './nyan.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const UNIT = 'nyan-remote'

/**
 * ★★ Everything the agent and the CLI write in the state directory (`--purge` removes it only if nothing else is there).
 * ⚠️ A name missing here only makes `--purge` keep the directory and say so (fail-safe). Temp and backup copies
 *    (`<name>.tmp…` / `<name>.bak…`) count as the same name.
 */
export const STATE_FILES = [
  'config.json', 'hook-token', 'device-key.json', 'vapid.json', 'devices.json', 'subscriptions.json',
  'account.json', 'account.lock', 'license.json', 'auto-approve.json',
  'hooks.jsonl', 'sent.jsonl', 'traffic.jsonl', 'inflight.off',
]
export const STATE_DIRS = ['bin', 'panes', 'inflight']
/**
 * ★ The names written inside those directories (codex round 4: any regular file used to pass).
 *   panes/    `<pid>.json` (relay.py), its temp `<pid>.json.<pid>.tmp`, `<pid>.rejected`
 *   inflight/ `<session UUID>.jsonl` (hooks/message-display.sh only accepts a UUID)
 *   bin/      nothing: the removers take ours out before a purge
 */
export const STATE_CHILD = {
  bin: /(?!)/,
  panes: /^\d+\.(json|rejected|json\.\d+\.tmp)$/,
  inflight: /^[0-9a-fA-F-]{36}\.jsonl$/,
}
/** ★ At least one of these must be there before anything is called "our state directory" */
export const STATE_MARKERS = ['config.json', 'hook-token', 'device-key.json']

export function unitPath(home) {
  return join(home, '.config', 'systemd', 'user', `${UNIT}.service`)
}

/** ★ Did we write this plist? (⚠️ it must start our launcher, like the unit) */
export function isOurPlist(body) {
  return /<string>[^<]*\/scripts\/agent-service\.sh<\/string>/.test(body)
}

/** ★ Did we write this unit? (⚠️ it must start our launcher; a unit someone else named the same is left alone) */
export function isOurUnit(body) {
  return /^ExecStart=.*\/scripts\/agent-service\.sh\s*$/m.test(body)
}

const unxml = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/**
 * ★★ The state directory the running agent uses.
 *   The service's setting wins over this shell (the systemd unit's `Environment=` or the launchd plist).
 *   ⚠️ Only a service file that is ours is read. ⚠️ systemd: the **last** assignment wins (as in systemd).
 *   ⚠️⚠️ A value we did not write (quotes, several assignments on a line) is not guessed at: `problem` is returned,
 *      and the caller stops unless `NYAN_REMOTE_STATE_DIR` was given explicitly.
 * @returns { dir } or { problem }
 */
export function stateDirOf({ unitBody, plistBody, env, home }) {
  if (unitBody && isOurUnit(unitBody)) {
    const lines = unitBody.split('\n').filter((l) => /^Environment=.*NYAN_REMOTE_STATE_DIR/.test(l))
    const last = lines.at(-1)
    if (last) {
      const m = /^Environment=NYAN_REMOTE_STATE_DIR=(\/[^\s"'\\]+)\s*$/.exec(last)
      if (!m) return { problem: t(`unit の設定が読めません: ${last}`, `cannot read the unit's setting: ${last}`) }
      return { dir: m[1] }
    }
  }
  if (plistBody && isOurPlist(plistBody)) {
    const m = /<key>NYAN_REMOTE_STATE_DIR<\/key>\s*<string>([^<]*)<\/string>/.exec(plistBody)
    if (m) return { dir: unxml(m[1]) }
  }
  return { dir: env.NYAN_REMOTE_STATE_DIR || join(home, '.nyan-remote') }
}

/** ★ One shell quoting for every command we print (codex round 5: a path with a space made `rm -rf` hit two other paths) */
export function shq(p) {
  return `'${String(p).replace(/'/g, `'\\''`)}'`
}

function writable(p) {
  try {
    accessSync(p, constants.W_OK | constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** ★ Real path, or undefined when it cannot be resolved (⚠️ an unknown real path means "remove nothing") */
function phys(p) {
  try {
    return realpathSync(p)
  } catch {
    return undefined
  }
}

const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)

/** ★ Is `dir` (or a directory above it) a git working tree? */
function inGit(dir, exists) {
  for (let d = dir; ; d = dirname(d)) {
    if (exists(join(d, '.git'))) return true
    if (dirname(d) === d) return false
  }
}

/**
 * ★★ May this installed tree (or update backup) be removed? ("looks like a nyan-remote install", as the installer's update checks)
 * @returns undefined when it may, otherwise the reason it is kept
 */
export function treeProblem({ root, stateDir, home, exists = existsSync, real = phys }) {
  if (inGit(root, exists)) return t('git の作業ツリーなので残します', 'it is a git checkout, so it is kept')
  if (!exists(join(root, 'RELEASE')) || !exists(join(root, 'agent', 'src', 'index.ts'))) {
    return t('nyan-remote の導入に見えないので残します', 'it does not look like a nyan-remote install, so it is kept')
  }
  const r = real(root)
  const h = real(home)
  const s = real(stateDir)
  if (!r || !h) return t('パスの実体を確かめられないので残します', 'its real path could not be resolved, so it is kept')
  // ⚠️⚠️ Never remove home or anything above it
  if (inside(h, r)) return t('ホームを含むので残します', 'it contains your home directory, so it is kept')
  // ⚠️⚠️ The state directory inside the tree would go with it (keys cannot be recovered)
  if (s && inside(s, r)) return t('状態ディレクトリを含むので残します', 'it contains the state directory, so it is kept')
  return undefined
}

/**
 * ★ Update backups next to the tree: exactly `<tree>.old-YYYYMMDD-HHMMSS` (the name install.sh gives) and each passing `treeProblem`.
 * ⚠️ codex 2026-09-26: "starts with a digit" also matched a checkout named `app.old-20260926-my-work`.
 */
export function oldTrees({ root, stateDir, home, list = readdirSync, exists = existsSync, real = phys }) {
  const dir = dirname(root)
  const name = new RegExp(`^${basename(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.old-\\d{8}-\\d{6}$`)
  let names = []
  try {
    names = list(dir)
  } catch {
    return []
  }
  return names.filter((n) => name.test(n)).map((n) => join(dir, n)).filter((p) => !treeProblem({ root: p, stateDir, home, exists, real }))
}

/** ★ Is this entry of the state directory one we write? (a temp/backup copy of one counts) */
export function isStateEntry(name) {
  return [...STATE_FILES, ...STATE_DIRS].some((k) => name === k || name.startsWith(`${k}.tmp`) || name.startsWith(`${k}.bak`) || name.startsWith(`${k}.new-`))
}

/**
 * ★★ May the state directory be removed with `--purge`? Only when **every** entry is ours (otherwise nothing is removed).
 * @returns undefined when it may, 'absent', or the reason it is kept
 */
export function stateDirProblem({ stateDir, home, lstat = lstatSync, exists = existsSync, list = readdirSync, real = phys }) {
  let st
  try {
    st = lstat(stateDir)
  } catch {
    return 'absent'
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return t('ディレクトリではない（リンクなど）ので残します', 'it is not a plain directory (a link?), so it is kept')
  const s = real(stateDir)
  const h = real(home)
  if (!s || !h) return t('パスの実体を確かめられないので残します', 'its real path could not be resolved, so it is kept')
  if (inside(h, s)) return t('ホームを含むので残します', 'it contains your home directory, so it is kept')
  if (inGit(s, exists)) return t('git の作業ツリーの中なので残します', 'it is inside a git checkout, so it is kept')
  if (!STATE_MARKERS.some((m) => exists(join(stateDir, m)))) {
    return t('nyan-remote の状態ディレクトリに見えないので残します', 'it does not look like a nyan-remote state directory, so it is kept')
  }
  const foreign = foreignEntries(stateDir, { lstat, list })
  if (foreign.length) return t(`nyan-remote のものでないファイルがあるので残します: ${foreign.join(', ')}`, `it holds files that are not nyan-remote's, so it is kept: ${foreign.join(', ')}`)
  // ★ Every directory must be writable, or the delete stops half-way (codex round 3) and a partial delete may take the marker
  //   files with it, so the retry could no longer tell the directory is ours ⇒ refuse before deleting anything
  for (const d of [dirname(stateDir), stateDir, ...STATE_DIRS.map((n) => join(stateDir, n)).filter((p) => exists(p))]) {
    if (!writable(d)) return t(`${d} に書けないので残します（中身は全部 nyan-remote のものです。権限を直してから: rm -rf ${shq(stateDir)}）`, `${d} is not writable, so it is kept (everything in it is nyan-remote's; fix the permissions, then: rm -rf ${shq(stateDir)})`)
  }
  return undefined
}

/**
 * ★★ Entries that are not ours, **looking inside the directories too** (codex round 2: a personal tool in `bin/` survived the
 *   ownership-aware removers and was then deleted by `--purge`).
 *   Files must be regular files. `bin/` must be empty (the removers took ours out already). `panes/` and `inflight/` may hold only
 *   regular files (no subdirectories, no links).
 */
export function foreignEntries(stateDir, { lstat = lstatSync, list = readdirSync } = {}) {
  const out = []
  // ⚠️ An unreadable directory cannot be proven ours ⇒ it counts as foreign (never throw half-way through uninstall / codex round 5)
  const ls = (d) => {
    try {
      return list(d)
    } catch {
      return undefined
    }
  }
  const top = ls(stateDir)
  if (!top) return ['.']
  for (const n of top) {
    const p = join(stateDir, n)
    let st
    try {
      st = lstat(p)
    } catch {
      continue
    }
    if (!isStateEntry(n)) {
      out.push(n)
      continue
    }
    const dir = STATE_DIRS.find((d) => n === d)
    if (!dir) {
      if (!st.isFile()) out.push(n)
      continue
    }
    if (!st.isDirectory()) {
      out.push(n)
      continue
    }
    const children = ls(p)
    if (!children) {
      out.push(`${n}/`)
      continue
    }
    for (const c of children) {
      let cs
      try {
        cs = lstat(join(p, c))
      } catch {
        continue
      }
      if (dir === 'bin' || !cs.isFile() || !STATE_CHILD[dir].test(c)) out.push(`${n}/${c}`)
    }
  }
  return out
}

/** ⚠️ The text lives once, in `nyan.mjs` (`nyan help uninstall`) */
const usage = () => helpDetail().uninstall

function runNode(script, args, env) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], { stdio: 'inherit', env })
  return r.status ?? 1
}

/** ★ The pending check, quiet unless it matters (its own wording talks about restarting). @returns its exit code */
function pendingCode(env) {
  const pr = spawnSync(process.execPath, [join(ROOT, 'scripts', 'pending.mjs')], { env, encoding: 'utf8' })
  const code = pr.status ?? 3
  if (code !== 0 && code !== 2) process.stderr.write(`${pr.stdout ?? ''}${pr.stderr ?? ''}`)
  return code
}

/** @returns undefined to go on, or the exit code to stop with */
function pendingGate(env, force) {
  const code = pendingCode(env)
  if (code === 0) console.log(t('  承認待ちはありません', '  No pending approvals'))
  if (code === 2) console.log(t('  agent は止まっています（消える承認はありません）', '  The agent is not running (no approval can be lost)'))
  const d = pendingDecision(code, force)
  if (d === 'stop-pending') {
    console.error(t('✗ 承認待ちがあります。答えてからもう一度 nyan uninstall を打ってください（止めると待っている承認が消えます）', '✗ An approval is pending. Answer it, then run nyan uninstall again (stopping would drop it).'))
    return 1
  }
  if (d === 'stop-unknown') {
    console.error(t('✗ 承認待ちがあるか確かめられませんでした。無いことを確かめてから: nyan uninstall --force', '✗ Could not check for pending approvals. Make sure none is pending, then: nyan uninstall --force'))
    return 3
  }
  return undefined
}

/**
 * ★★ Does anything answer HTTP on the agent's port? (no credentials: codex round 2 — `pending.mjs` needs the hook token and
 *   exits 3 without it, which blocked uninstall forever)
 *   'no' = refused / 'unknown' = no answer in time / 'yes' = something answered (any status, even 403)
 * ⚠️⚠️ On WSL without mirrored networking a dead 127.0.0.1 port **hangs instead of refusing** (CLAUDE.md §4) ⇒ 'unknown'
 *    must not block, or uninstall could never finish there. A live agent answers /health immediately.
 */
export async function agentAnswers(stateDir, env, probe = httpProbe) {
  let port = Number(env.NYAN_REMOTE_PORT)
  if (!port) {
    try {
      port = Number(JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8')).port) || 7777
    } catch {
      port = 7777
    }
  }
  return probe(port)
}

/**
 * ★ One GET /health with `node:http` (⚠️ not fetch: fetch refuses some ports such as 6000 locally, without connecting / codex round 3).
 * @returns 'no' refused / 'unknown' no answer in time / 'yes' any HTTP answer / 'error' anything else (the caller stops)
 */
export function httpProbe(port, timeoutMs = 3000) {
  return new Promise((done) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/health', method: 'GET' }, (res) => {
      res.resume()
      done('yes')
    })
    const timer = setTimeout(() => {
      req.destroy()
      done('unknown')
    }, timeoutMs)
    req.on('error', (err) => {
      clearTimeout(timer)
      done(err?.code === 'ECONNREFUSED' ? 'no' : 'error')
    })
    req.on('response', () => clearTimeout(timer))
    req.end()
  })
}

/** ★ mac logs: only our log files, then the directory if it is empty (codex round 3: it was deleted wholesale) */
export function removeLogs(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const n of names) if (/^agent\.log(\.\d+)?$/.test(n)) rmSync(join(dir, n), { force: true })
  try {
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true })
  } catch {
    // gone or not empty
  }
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim())
  } finally {
    rl.close()
  }
}

function readOr(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** ★ Backups of `settings.json` our hook installer left (they still carry the hook token) */
function settingsBackups(home) {
  const out = []
  for (const n of readdirSync(home)) {
    if (!/^\.claude(-[A-Za-z0-9._-]+)?$/.test(n)) continue
    try {
      for (const f of readdirSync(join(home, n))) if (f.startsWith('settings.json.bak-')) out.push(join(home, n, f))
    } catch {
      // not a directory
    }
  }
  return out
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  initCliLang(env)
  const known = new Set(['--purge', '--yes', '-y', '--force', '--help', '-h'])
  const bad = argv.filter((a) => !known.has(a))
  if (bad.length) {
    console.error(t(`知らない引数です: ${bad.join(' ')}\n`, `Unknown argument: ${bad.join(' ')}\n`))
    process.stdout.write(usage())
    return 2
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(usage())
    return 0
  }
  const purge = argv.includes('--purge')
  const force = argv.includes('--force')
  const yes = argv.includes('--yes') || argv.includes('-y')

  const home = env.HOME ?? homedir()
  const kind = serviceKind(platform(), home)
  const unit = unitPath(home)
  const plist = launchdPlistPath(home)
  // ⚠️ Only the service file this platform uses (codex round 2: a stale systemd unit on a mac overrode the live plist)
  const mac = platform() === 'darwin'
  const unitBody = mac ? '' : readOr(unit)
  const plistBody = mac ? readOr(plist) : ''
  const found = stateDirOf({ unitBody, plistBody, env, home })
  if (found.problem && !env.NYAN_REMOTE_STATE_DIR) {
    console.error(t(`✗ agent の状態ディレクトリが分かりません（${found.problem}）。`, `✗ Cannot tell the agent's state directory (${found.problem}).`))
    console.error(t('  NYAN_REMOTE_STATE_DIR=<場所> nyan uninstall で指定してください。何も変えていません。', '  Give it as NYAN_REMOTE_STATE_DIR=<path> nyan uninstall. Nothing was changed.'))
    return 2
  }
  const stateDir = found.dir ?? env.NYAN_REMOTE_STATE_DIR
  // ⚠️ Every child must use the same state directory as the agent (port, hook token, bin directory, account.json)
  const childEnv = { ...env, NYAN_REMOTE_STATE_DIR: stateDir }
  const tree = treeProblem({ root: ROOT, stateDir, home })

  console.log(t('このマシンから nyan-remote を外します:', 'This removes nyan-remote from this machine:'))
  console.log(t('  ・常駐を止めて外す', '  - stop and remove the background service'))
  console.log(t('  ・Claude Code のフック・notify.sh・claude の入口（PATH）・nyan コマンドを外す', '  - remove the Claude Code hooks, notify.sh, the claude entry point (PATH) and the nyan command'))
  if (existsSync(join(stateDir, 'account.json'))) console.log(t('  ・このマシンをアカウントから外す（ログアウト）', '  - remove this machine from your account (sign out)'))
  console.log(tree ? t(`  ・入れた木 ${ROOT} は残す（${tree}）`, `  - keep the installed tree ${ROOT} (${tree})`) : t(`  ・入れた木 ${ROOT} を消す`, `  - delete the installed tree ${ROOT}`))
  console.log(
    purge
      ? t(`  ・⚠️ 状態ディレクトリ ${stateDir} も消す（鍵と登録。入れ直したらスマホの登録をやり直し）`, `  - ⚠️ delete the state directory ${stateDir} too (keys and registrations; after a reinstall you pair your phones again)`)
      : t(`  ・状態ディレクトリ ${stateDir} は残す（入れ直せばスマホはそのまま繋がる）`, `  - keep the state directory ${stateDir} (reinstall and your phones still connect)`),
  )
  if (!yes && !(await confirm(t('進めますか？ [y/N] ', 'Continue? [y/N] ')))) {
    console.log(t(process.stdin.isTTY ? 'やめました。' : 'やめました（確かめられないので。進めるなら --yes）', process.stdin.isTTY ? 'Cancelled.' : 'Cancelled (cannot ask here; pass --yes to continue).'))
    return 1
  }

  // ① Pending approvals (⚠️ stopping the agent drops them / same decision as `nyan update`)
  console.log(t('▸ 承認待ちの確認', '▸ Check pending approvals'))
  let stop = pendingGate(childEnv, force)
  if (stop !== undefined) return stop

  // ② Sign out while account.json is still there (⚠️ otherwise the machine keeps a slot on the account)
  if (existsSync(join(stateDir, 'account.json'))) {
    console.log(t('▸ アカウントから外す', '▸ Remove this machine from the account'))
    if (runNode('account.mjs', ['logout', ...(force ? ['--force'] : [])], childEnv) !== 0) {
      if (!force) {
        console.error(t('✗ アカウントから外せなかったので止めました（もう一度 打つか、外さずに進めるなら --force）', '✗ Stopped because the machine could not be removed from the account (run it again, or pass --force to continue anyway)'))
        return 1
      }
      // ★ `logout --force` removed the local sign-in but not the slot (codex 2026-09-26: it used to stop here anyway)
      console.log(t('  ⚠️ 続けます。アカウントの画面でこのマシンを外してください（枠が残っています）', '  ⚠️ Continuing. Remove this machine on the account page (its slot is still taken)'))
    }
  }

  // ③ Pending again right before stopping (⚠️ an approval may have arrived while signing out)
  stop = pendingGate(childEnv, force)
  if (stop !== undefined) return stop

  // ④ Stop the service (⚠️ the file itself is removed later: a retry after a failure reads the state directory from it)
  console.log(t('▸ 常駐を止める', '▸ Stop the background service'))
  const ourUnit = kind === 'systemd' && unitBody && isOurUnit(unitBody)
  const ourPlist = kind === 'launchd' && isOurPlist(plistBody)
  if (kind === 'systemd') {
    if (!unitBody) console.log(t('  （systemd の unit はありません）', '  (no systemd unit)'))
    else if (!ourUnit) console.log(t(`  ⚠️ ${unit} は nyan-remote が書いたものに見えないので触りません`, `  ⚠️ ${unit} does not look like ours, so it was left alone`))
    else if (spawnSync('systemctl', ['--user', 'disable', '--now', UNIT], { stdio: 'inherit' }).status !== 0) {
      console.error(t('✗ 常駐を止められませんでした（systemctl --user status nyan-remote を見てください）', '✗ Could not stop the service (check: systemctl --user status nyan-remote)'))
      return 1
    }
  } else if (kind === 'launchd' && !ourPlist) {
    console.log(t(`  ⚠️ ${plist} は nyan-remote が書いたものに見えないので触りません`, `  ⚠️ ${plist} does not look like ours, so it was left alone`))
  } else if (kind === 'launchd') {
    if (runNode('launchd.mjs', ['stop'], childEnv) !== 0) {
      console.error(t('✗ launchd の常駐を止められませんでした', '✗ Could not stop the launchd service'))
      return 1
    }
  }
  // ★★ Confirm the agent no longer answers (⚠️ one started by hand or by a unit that is not ours would keep running on deleted files)
  const answers = await agentAnswers(stateDir, env)
  if (answers === 'unknown') console.log(t('  （agent のポートは応答しませんでした。止まったものとして進めます）', '  (the agent port did not answer; treating it as stopped)'))
  if (answers === 'yes' || (answers === 'error' && !force)) {
    console.error(t('✗ agent がまだ動いています。npm start のタブなら Ctrl-C、ほかの常駐なら止めてから、もう一度 nyan uninstall を打ってください', '✗ The agent is still running. Stop it (Ctrl-C in the npm start tab, or its own service), then run nyan uninstall again'))
    return 1
  }

  // ⑤ Hooks → ⑥ notify.sh (after the hooks that call it) → ⑦ the entry point, rc blocks and `nyan`
  const steps = [
    { label: t('Claude Code のフックを外す', 'Remove the Claude Code hooks'), script: 'install-permission-hook.mjs', args: ['--remove'] },
    { label: t('notify.sh を外す', 'Remove notify.sh'), script: 'install-notify.mjs', args: ['--remove'] },
    { label: t('claude の入口（PATH）と nyan コマンドを外す', 'Remove the claude entry point (PATH) and the nyan command'), script: 'install-relay.mjs', args: ['--uninstall'] },
  ]
  for (const s of steps) {
    console.log(`▸ ${s.label}`)
    const code = runNode(s.script, s.args, childEnv)
    if (code !== 0) {
      console.error(t(`✗ 「${s.label}」で止まりました（終了コード ${code}）。直してからもう一度 nyan uninstall を打てば続きからやります`, `✗ Stopped at "${s.label}" (exit code ${code}). Fix it and run nyan uninstall again; finished steps are skipped`))
      return code
    }
  }

  // ⑧ The service file (⚠️ only now: until here a retry needs it to find the state directory)
  if (ourUnit) {
    rmSync(unit, { force: true })
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' })
    console.log(t(`▸ ✔ ${UNIT}.service を外しました`, `▸ ✔ Removed ${UNIT}.service`))
  } else if (ourPlist) {
    rmSync(plist, { force: true })
    console.log(t('▸ ✔ launchd の常駐を外しました', '▸ ✔ Removed the launchd service'))
  }

  const leftovers = []
  // ⑨ The state directory (⚠️ only when asked, and only when everything in it is ours)
  //   ⚠️ Before the tree (codex round 3). Checked writable up to its parent first, so a failure here is rare; if it happens,
  //   the rest goes on and the final message gives the `rm -rf` for what is left
  if (purge) {
    const why = stateDirProblem({ stateDir, home })
    if (why === 'absent') {
      console.log(t(`▸ 状態ディレクトリ ${stateDir} はありません`, `▸ No state directory at ${stateDir}`))
    } else if (why) {
      console.log(t(`▸ ⚠️ 状態ディレクトリ ${stateDir} は残しました（${why}）`, `▸ ⚠️ Kept the state directory ${stateDir} (${why})`))
    } else {
      try {
        rmSync(stateDir, { recursive: true, force: true })
        if (mac) removeLogs(dirname(launchdLogPath(home)))
        console.log(t(`▸ ✔ 状態ディレクトリ ${stateDir} を消しました`, `▸ ✔ Deleted the state directory ${stateDir}`))
      } catch (err) {
        // ⚠️ Already proven to hold only our files ⇒ what is left is a plain `rm -rf` (a re-run could not recognise a
        //    half-deleted directory: the marker files may be gone / codex round 4)
        leftovers.push(stateDir)
        console.error(t(`✗ 状態ディレクトリを消しきれませんでした: ${err.message}`, `✗ Could not delete all of the state directory: ${err.message}`))
      }
    }
  } else if (existsSync(stateDir)) {
    // ⚠️ Offer the command only when it would be safe (the same check as --purge / codex round 5)
    const why = stateDirProblem({ stateDir, home })
    console.log(
      why
        ? t(`▸ 状態ディレクトリ ${stateDir} は残しました`, `▸ Kept the state directory ${stateDir}`)
        : t(`▸ 状態ディレクトリ ${stateDir} は残しました（消すなら: rm -rf ${shq(stateDir)}）`, `▸ Kept the state directory ${stateDir} (to delete it: rm -rf ${shq(stateDir)})`),
    )
  }

  // ⑩ The tree (⚠️ last: the steps above run scripts from it. ⚠️ checked again right before deleting)
  const again = treeProblem({ root: ROOT, stateDir, home })
  if (again) {
    console.log(t(`▸ 入れた木 ${ROOT} は残しました（${again}）`, `▸ Kept the installed tree ${ROOT} (${again})`))
  } else {
    for (const p of [...oldTrees({ root: ROOT, stateDir, home }), ROOT]) {
      try {
        rmSync(p, { recursive: true, force: true })
      } catch (err) {
        leftovers.push(p)
        console.error(t(`✗ ${p} を消しきれませんでした: ${err.message}`, `✗ Could not delete all of ${p}: ${err.message}`))
      }
    }
    if (!leftovers.includes(ROOT)) console.log(t(`▸ ✔ ${ROOT} を消しました`, `▸ ✔ Deleted ${ROOT}`))
  }

  const backups = settingsBackups(home)
  if (backups.length) {
    console.log(t(`▸ settings.json の控えが ${backups.length} 個 残っています（フックの合言葉を含みます。要らなければ消してください）:`, `▸ ${backups.length} backup(s) of settings.json remain (they contain the hook token; delete them if you do not need them):`))
    for (const b of backups) console.log(`    ${b}`)
  }

  console.log('')
  if (leftovers.length) {
    console.error(t('⚠️ ほかは外しました。残りは手で消してください:', '⚠️ Everything else is removed. Delete the rest by hand:'))
    for (const p of leftovers) console.error(`    rm -rf ${shq(p)}`)
    return 1
  }
  console.log(t('✔ 外しました。開いているシェルは PATH が古いままなので、新しいシェルを開いてください。', '✔ Done. Open a new shell (shells already open still have the old PATH).'))
  console.log(t('  スマホ側: アプリの「接続先」でこのマシンを消し、使わないならホーム画面からアプリも消してください。', '  On the phone: remove this machine under Connections in the app, and remove the app from the home screen if you no longer use it.'))
  return 0
}

if (isMain(process.argv[1], import.meta.url)) {
  process.exit(await main())
}
