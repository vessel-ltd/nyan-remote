// ★ Stop a release when a dependency that reaches users has a known vulnerability (2026-09-26).
//
// ★ Why here and not Dependabot PRs: only `web-push` (the agent, shipped in the tarball) and `preact` (bundled into the PWA)
//   reach users; everything else runs on the build machine. PRs on the public repo cannot be merged there (`publish:public`
//   overwrites it), so the check that matters is "never ship a known-vulnerable runtime dependency" — at release time.
// ⚠️ Blocks on moderate and above; low/info are printed but do not block.
// ⚠️⚠️ If the audit cannot run (offline, registry down) or its report is not one we understand, it does **not** pass: the
//    release stops and says so. `--skip-audit` continues on purpose (for when the registry is down and a release cannot wait).
//
// ★★ Two holes codex found (2026-09-26), both closed here:
//   ① The audit reads the lockfile, but `pack.mjs` ships what is **installed** (and vite bundles the installed preact).
//      After a pull without reinstalling, an older installed version could ship while the audit checked the new lockfile.
//      ⇒ Every runtime entry of the lockfile must match the installed version first (`lockMismatches`).
//   ② Inherited npm settings (`npm_config_workspaces=false`, a workspace filter …) can make `npm audit` skip both workspaces and
//      still print a clean report — and the report's counts look the same either way, so it cannot be detected afterwards.
//      ⇒ Every workspace is named on the command line, and npm runs without this machine's npm configuration (`auditEnv`).

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { t } from '../../shared/i18n.ts'

export const BLOCKING = ['moderate', 'high', 'critical']
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical']

/**
 * ★ The audit invocation: every workspace **named** plus the root.
 * ⚠️ `--workspaces` alone is not enough: a `workspace=web` filter in a user's `.npmrc` survived it and dropped the agent
 *    (web-push) from the audit (codex round 2, reproduced). Naming each workspace on the command line replaces that filter.
 */
export function auditArgs(workspaces) {
  if (!Array.isArray(workspaces) || workspaces.length === 0) throw new Error('package.json has no workspaces to audit')
  return ['audit', '--omit=dev', ...workspaces.flatMap((w) => ['--workspace', w]), '--include-workspace-root', '--json']
}

/**
 * ★★ Run npm with **none of this machine's npm configuration** (codex rounds 2-6 kept finding one more inherited setting that changed
 *    what `npm ls` / `npm audit` look at: workspace filters, depth, output format, package-lock-only, offline (a false clean!), link,
 *    optional, include/production/dev/also, legacy-peer-deps, install-strategy …). Listing them is whack-a-mole, so instead:
 *    ① the child's env keeps no `npm_config_*` except network plumbing (proxy, certificates) — ② the user and global config files are
 *    replaced by an empty file — ③ the public registry is named. npm's defaults then apply to everything else.
 * ⚠️ A project `.npmrc` in the repository would still be read; the repository has none, and `npmrcInRepo` stops the release if one appears.
 */
const KEEP_NPM_ENV = /^npm_config_(https?_proxy|proxy|no_?proxy|cafile|ca|strict_ssl)$/i
export const PUBLIC_REGISTRY = 'https://registry.npmjs.org/'

export function auditEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^npm_config_/i.test(k) || KEEP_NPM_ENV.test(k)))
}

/**
 * ★ Flags that replace the machine's config files with two empty files (⚠️ npm refuses one file loaded as both user and global),
 *   pin the project to `root` (npm could otherwise promote an enclosing workspace and read its .npmrc), and force `offline=false`
 *   (an offline audit returns an empty report that looks clean).
 * ⚠️ npm's own builtin config (`<npm package>/npmrc`) cannot be replaced from the command line. It is **not** refused: a packaged
 *    npm (Homebrew's, for one) may ship one with just `prefix=…`, and refusing it would stop every release from such a machine
 *    (a check added and removed on 2026-09-26 before it ever ran there).
 *    The settings that matter are forced here and in `lsArgs` (offline, depth, output format, package-lock-only), which also cover
 *    anything a builtin file could set.
 */
export function isolationArgs(dir, root) {
  return [`--userconfig=${join(dir, 'user.npmrc')}`, `--globalconfig=${join(dir, 'global.npmrc')}`, `--prefix=${root}`, `--registry=${PUBLIC_REGISTRY}`, '--offline=false', '--prefer-online']
}

/** ★ Project-level .npmrc files that npm would still read (the root and each workspace) */
export function npmrcInRepo(root, workspaces, exists = existsSync) {
  return ['', ...workspaces].map((w) => join(root, w, '.npmrc')).filter((p) => exists(p))
}

/**
 * ★ Read `npm audit --json` output (⚠️ pure = tests check it).
 * ⚠️ Only a report with all five severity counts as non-negative integers is understood; anything else is "unavailable",
 *    never a pass (a changed or partial report shape must not read as clean / codex).
 * @returns { ok, counts, names } or { ok: false, unavailable: true }
 */
export function auditVerdict(stdout) {
  let report
  try {
    report = JSON.parse(stdout)
  } catch {
    return { ok: false, unavailable: true }
  }
  if (!report || typeof report !== 'object' || Array.isArray(report) || 'error' in report) return { ok: false, unavailable: true }
  const counts = report.metadata?.vulnerabilities
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return { ok: false, unavailable: true }
  if (!SEVERITIES.every((k) => Number.isInteger(counts[k]) && counts[k] >= 0)) return { ok: false, unavailable: true }
  const blocking = BLOCKING.reduce((n, k) => n + counts[k], 0)
  return { ok: blocking === 0, counts, names: Object.keys(report.vulnerabilities ?? {}) }
}

/**
 * ★ Runtime packages whose installed version differs from the lockfile (or are missing).
 * @returns list of "name: installed x, lockfile y" (empty = the installation is what the audit checks)
 */
export function lockMismatches(root, read = (p) => readFileSync(p, 'utf8')) {
  const lock = JSON.parse(read(join(root, 'package-lock.json')))
  const out = []
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    // ⚠️ `node_modules/` anywhere in the path: npm installs conflicting versions under a workspace (`web/node_modules/preact`),
    //    and vite bundles that copy (codex round 2)
    if (!/(^|\/)node_modules\//.test(key) || entry.dev || entry.link) continue
    let installed
    try {
      installed = JSON.parse(read(join(root, key, 'package.json'))).version
    } catch {
      installed = undefined
    }
    // ⚠️ An optional package may be legitimately absent on this platform (a correct `npm ci` skips it); installed ones are still checked
    if (installed === undefined && (entry.optional || entry.devOptional)) continue
    if (installed !== entry.version) out.push(`${key.replace(/^.*node_modules\//, '')}: installed ${installed ?? 'missing'}, lockfile ${entry.version}`)
  }
  return out
}

/**
 * ★ Installed runtime paths (from `npm ls --parseable`) that the lockfile does not list.
 * ⚠️ A leftover `web/node_modules/preact` from another branch is what vite resolves, yet the lockfile only lists the hoisted copy,
 *    so checking the lockfile's own entries never reads it (codex round 3). ⇒ Check the tree npm actually resolves.
 */
export function unlistedInstalls(root, lsStdout, lock) {
  const packages = lock.packages ?? {}
  const prefix = root.endsWith('/') ? root : `${root}/`
  const out = []
  for (const line of String(lsStdout).split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (line === root || line === prefix.slice(0, -1)) continue
    const rel = line.startsWith(prefix) ? line.slice(prefix.length) : line
    if (!(rel in packages)) out.push(`${rel}: installed but not in package-lock.json`)
  }
  return out
}

/**
 * ★ `npm ls` with the same forced selection as the audit (every workspace named, the root included).
 * ⚠️ Output settings are forced too: an inherited `depth=0` truncated the tree even with `--all` (a stale nested package would hide),
 *    and `long=true` / `json=true` changed the output format into false alarms (codex round 4, reproduced with an .npmrc).
 */
export function lsArgs(workspaces) {
  // ⚠️ `--package-lock-only=false`: that setting makes npm ls read the lockfile instead of the disk (codex round 5)
  return ['ls', '--omit=dev', '--all', '--depth=Infinity', '--parseable', '--long=false', '--json=false', '--package-lock-only=false', ...auditArgs(workspaces).slice(2, -1)]
}

/**
 * ★ Check the installation, run the audit in `root`, and stop the process if either does not pass (unless `skip`).
 * ⚠️ `npm audit` exits 1 when it finds something, so the exit code is not the verdict — the JSON is.
 */
export function requireAudit(root, { skip = false, installed = true, run = spawnSync, read, env = process.env, exists = existsSync } = {}) {
  if (skip) {
    console.warn(t('⚠️ 依存の監査を飛ばしました（--skip-audit）', '⚠️ Skipped the dependency audit (--skip-audit)'))
    return
  }
  const readFile = read ?? ((p) => readFileSync(p, 'utf8'))
  const workspaces = JSON.parse(readFile(join(root, 'package.json'))).workspaces
  const rc = npmrcInRepo(root, workspaces, exists)
  if (rc.length) {
    console.error(t(`✗ リポジトリの中に .npmrc があります（監査の設定を変えられるので止めます）: ${rc.join(', ')}`, `✗ The repository contains an .npmrc (it could change what the audit looks at): ${rc.join(', ')}`))
    process.exit(1)
  }
  const dir = mkdtempSync(join(tmpdir(), 'nyan-audit-'))
  writeFileSync(join(dir, 'user.npmrc'), '')
  writeFileSync(join(dir, 'global.npmrc'), '')
  const npm = (args) => run('npm', [...args, ...isolationArgs(dir, root)], { cwd: root, encoding: 'utf8', maxBuffer: 16 << 20, env: auditEnv(env) })
  // ⚠️ The checks stop with process.exit(), which skips `finally` ⇒ clean up on exit too (a failed check left temp dirs behind)
  const cleanup = () => rmSync(dir, { recursive: true, force: true })
  process.once('exit', cleanup)
  try {
    audited(root, workspaces, readFile, read, npm, installed)
  } finally {
    cleanup()
    process.removeListener('exit', cleanup)
  }
}

function audited(root, workspaces, readFile, read, npm, installed) {
  if (installed) checkInstalled(root, workspaces, readFile, read, npm)
  const r = npm(auditArgs(workspaces))
  const v = r.error || r.signal ? { ok: false, unavailable: true } : auditVerdict(String(r.stdout ?? ''))
  if (v.unavailable) {
    console.error(t('✗ 依存の監査ができませんでした（npm audit が読める結果を返さない ＝ ネットワークか registry）。', '✗ Could not run the dependency audit (npm audit returned no usable report: network or registry).'))
    console.error(t('  ⚠️ この点検は npm の設定ファイルを読みません。プロキシや社内の証明書が要るなら、環境変数（HTTPS_PROXY・npm_config_https_proxy・npm_config_cafile）で渡してください。', '  ⚠️ This check ignores npm config files. If you need a proxy or a corporate certificate, pass it in the environment (HTTPS_PROXY, npm_config_https_proxy, npm_config_cafile).'))
    console.error(t('  直してからもう一度。待てないときだけ --skip-audit で進めます。', '  Fix it and run again. Only if it cannot wait, pass --skip-audit.'))
    process.exit(1)
  }
  const c = v.counts
  if (!v.ok) {
    console.error(t(`✗ 利用者に届く依存に既知の脆弱性があります（重大 ${c.critical}・高 ${c.high}・中 ${c.moderate}）: ${v.names.join(', ')}`, `✗ A dependency that reaches users has a known vulnerability (critical ${c.critical}, high ${c.high}, moderate ${c.moderate}): ${v.names.join(', ')}`))
    console.error(t('  npm audit --omit=dev で中身を見て、更新してから配ってください。', '  See npm audit --omit=dev, update, then release.'))
    process.exit(1)
  }
  const low = c.low + c.info
  console.log(low ? t(`✓ 依存の監査: 止めるものなし（低 ${low} 件は表示のみ）`, `✓ Dependency audit: nothing blocking (${low} low/info, shown only)`) : t('✓ 依存の監査: 既知の脆弱性なし', '✓ Dependency audit: no known vulnerabilities'))
}

/**
 * ★ The installation must be what the lockfile says (versions of listed packages, and no unlisted installed paths).
 * ⚠️ Only for releases that ship `node_modules` (`site:stage`); `publish:public` publishes the git tree and skips it.
 */
function checkInstalled(root, workspaces, readFile, read, npm) {
  const drift = lockMismatches(root, read)
  const ls = npm(lsArgs(workspaces))
  // ⚠️ `npm ls` exits non-zero on extraneous/invalid packages but still prints the tree; only no output means it did not run
  if (ls.error || ls.signal || !String(ls.stdout ?? '').trim()) {
    console.error(t('✗ 入っている依存を確かめられませんでした（npm ls が結果を返さない）', '✗ Could not list the installed dependencies (npm ls returned nothing)'))
    process.exit(1)
  }
  drift.push(...unlistedInstalls(root, ls.stdout, JSON.parse(readFile(join(root, 'package-lock.json')))))
  if (drift.length) {
    console.error(t('✗ 入っている依存が package-lock.json と違います（配るのは入っている方です）:', '✗ Installed dependencies differ from package-lock.json (what is installed is what ships):'))
    for (const d of drift) console.error(`    ${d}`)
    console.error(t('  npm ci で入れ直してから、もう一度。', '  Reinstall with npm ci, then run again.'))
    process.exit(1)
  }
}
