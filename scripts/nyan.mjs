#!/usr/bin/env node
// ★★ The `nyan` / `nyan-remote` commands (2026-09-24 / user decision).
//
// ★ Why: with `cd ~/nyan-remote && npm run pair`, you had to remember **the install location** every time (a git working tree,
//   or the installer's `~/nyan-remote-app`) (we stumbled over it repeatedly on machine C).
//   ⇒ Make `nyan pair` / `nyan update` work from anywhere (the commands are placed by `scripts/lib/cli.mjs`).
// ⚠️ It only calls the existing `scripts/*.mjs` (never write a step in two places).
// ⚠️ `nyan update` stops if approvals are pending (a restart loses pending approvals / CLAUDE.md §3).

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hints, LAUNCHD_LABEL, launchdLogPath, recentLogLines, serviceKind } from './lib/service.mjs'
import { t } from '../shared/i18n.ts'
import { initCliLang } from './lib/lang.mjs'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** ⚠️ Same as `DISTRIBUTION_ORIGIN` in `shared/distribution.ts` (`nyan.test.mjs` checks it) */
export const DISTRIBUTION_ORIGIN = 'https://app.nyan-remote.app'

/** ★ Commands that call the existing steps as they are (name → script) */
export const PASSTHROUGH = {
  pair: 'scripts/pair.mjs',
  devices: 'scripts/devices.mjs',
  pending: 'scripts/pending.mjs',
  keys: 'scripts/keys-status.mjs',
  uninstall: 'scripts/uninstall.mjs',
}

/** ★ Account (2026-09-24 / billing). ⚠️ One script, given the command name (`scripts/account.mjs`) */
export const ACCOUNT_COMMANDS = ['login', 'logout', 'account']

// ★ Language: `scripts/lib/lang.mjs` (one place for every CLI tool)
export { cliLang } from './lib/lang.mjs'

/**
 * ★ Detailed description per command (`nyan help <command>` / `nyan <command> --help`).
 * ⚠️ `nyan.test.mjs` cross-checks the list (`helpText`) against the command table (catches forgotten additions or removals).
 * ⚠️ It is a function (calling `t()` at load time freezes the default before the language is decided).
 */
export function helpDetail() {
  return {
    pair: t(
      `nyan pair — スマホを1台 登録する

  QR を出して、スマホの nyan-remote で読みます（登録されたら自動で終わります）。
  Ctrl-C で取り消すと、出したワンタイムも無効になります。
  ワンタイムは 1回きり・5分で切れます。2台目には新しい QR が要ります。

  --image   QR を画像にして開く（端末で読めないとき。mac は最初から画像）
  --text    QR を端末に文字で描く（mac では使えません）
`,
      `nyan pair — register one phone

  Shows a QR code; scan it with nyan-remote on the phone (it ends by itself once registered).
  Ctrl-C cancels it and invalidates the one-time code.
  The one-time code works once and expires in 5 minutes. A second phone needs a new QR.

  --image   open the QR as an image (when the terminal can't show it; mac always uses an image)
  --text    draw the QR as text in the terminal (not available on mac)
`,
    ),
    update: t(
      `nyan update [--force] — 更新する

  git の作業ツリーで入れた台:  git pull → 承認待ちの確認 → ビルド → 再起動
  インストーラで入れた台:       install.sh で入れ直す（入れた場所はそのまま・状態は触らない）

  ⚠️ 承認待ちがあると止まります（再起動すると、待っている承認が消えるため）。
     スマホか PC で答えてから、もう一度打ってください。
  ⚠️ 承認待ちがあるか確かめられないときも止まります。無いことを確かめてから --force で進めます。
`,
      `nyan update [--force] — update

  Installed from a git checkout:  git pull → check pending approvals → build → restart
  Installed with the installer:   re-run install.sh (same place, state is not touched)

  ⚠️ Stops if an approval is pending (restarting would drop it).
     Answer it on the phone or PC, then run this again.
  ⚠️ Also stops if it can't tell whether one is pending. Check there is none, then use --force.
`,
    ),
    devices: t(
      `nyan devices — このマシンに登録されている端末

  nyan devices                     一覧
  nyan devices --revoke <id の先頭>  失効（1件に絞れたときだけ）
  nyan devices --revoke all        全部 失効（⚠️ 全端末が繋がらなくなる）
`,
      `nyan devices — phones registered on this machine

  nyan devices                        list
  nyan devices --revoke <id prefix>   revoke (only when it matches exactly one)
  nyan devices --revoke all           revoke all (⚠️ no phone can connect afterwards)
`,
    ),
    status: t(
      `nyan status — このマシンの様子

  版・入れた場所・常駐の様子・relay の最後の1行を出します。
  スマホから繋がらないときは、まずこれを見てください。
`,
      `nyan status — this machine's state

  Shows the version, install location, service state, and the last relay log line.
  Check this first when the phone can't connect.
`,
    ),
    logs: t(
      `nyan logs — agent のログ

  nyan logs      最後の 50 行
  nyan logs -f   追いかける（Ctrl-C で終わる）
`,
      `nyan logs — agent logs

  nyan logs      last 50 lines
  nyan logs -f   follow (Ctrl-C to stop)
`,
    ),
    pending: t(
      `nyan pending — 承認待ちがあるか

  終了コード: 0 なし ／ 1 ある ／ 2 agent が止まっている ／ 3 確かめられない
`,
      `nyan pending — whether an approval is pending

  Exit code: 0 none / 1 pending / 2 agent is stopped / 3 could not check
`,
    ),
    keys: t(
      `nyan keys — 打鍵の入口の確認

  スマホから送った文字が「枠なしで」PC に届くかを確かめます
  （届かないときは受信箱に落ちて、英文の枠が付きます）。
`,
      `nyan keys — check the keystroke path

  Checks whether text sent from the phone reaches the PC as typed input
  (if not, it falls back to the inbox and gets an English wrapper).
`,
    ),
    login: t(
      `nyan login — こちらの relay を使うためにログインする

  GitHub でログインし、このマシンをアカウントに登録します（ブラウザでコードを入れます）。
  無料: マシン1台・スマホ2台。Plus（$2.99/月・$24/年）: マシン5台・スマホ5台。
  ⚠️ Tailscale や自分の relay で使うなら要りません。
`,
      `nyan login — sign in to use our relay

  Signs in with GitHub and registers this machine to your account (you enter a code in the browser).
  Free: 1 machine, 2 phones. Plus ($2.99/month or $24/year): 5 machines, 5 phones.
  ⚠️ Not needed with Tailscale or your own relay.
`,
    ),
    logout: t(
      `nyan logout — ログアウトする

  このマシンをアカウントから外します（枠が空きます）。
  外せなかったときはログインを残します（もう一度 打つ）。
  nyan logout --force   外せなくても、このマシンのログインだけ消す
`,
      `nyan logout — sign out

  Removes this machine from your account (frees a slot).
  If that fails, you stay signed in (run it again).
  nyan logout --force   remove the sign-in on this machine even if that fails
`,
    ),
    account: t(
      `nyan account — プランと上限

  いまのプラン・使えるマシンとスマホの数・relay が受け付けているかを出します。
`,
      `nyan account — plan and limits

  Shows your plan, how many machines and phones you can use, and whether the relay accepts this machine.
`,
    ),
    uninstall: t(
      `nyan uninstall [--purge] [--yes] [--force] — このマシンから外す

  常駐・Claude Code のフック・notify.sh・claude の入口（PATH）・nyan コマンド・入れた木を外します
  （git の作業ツリーは残します）。ログインしていれば、このマシンをアカウントから外します。
  ★ 状態ディレクトリ（~/.nyan-remote: 鍵と登録）は残します。入れ直せばスマホはそのまま繋がります。

  --purge   状態ディレクトリも消す（⚠️ 入れ直したらスマホの登録をやり直し）
  --yes     確かめずに進む
  --force   承認待ちを確かめられない・アカウントから外せないときも進む
`,
      `nyan uninstall [--purge] [--yes] [--force] — remove nyan-remote from this machine

  Removes the background service, the Claude Code hooks, notify.sh, the claude entry point (PATH), the nyan command
  and the installed tree (a git checkout is kept). If you are signed in, this machine is removed from your account.
  ★ The state directory (~/.nyan-remote: keys and registrations) is kept. Reinstall and your phones still connect.

  --purge   remove the state directory too (⚠️ after a reinstall you pair your phones again)
  --yes     do not ask for confirmation
  --force   continue even if pending approvals cannot be checked or the machine cannot be removed from the account
`,
    ),
    version: t(`nyan version — 版を出す
`, `nyan version — print the version
`),
    help: t(`nyan help [コマンド] — 使い方を出す
`, `nyan help [command] — show usage
`),
  }
}

/** ★ The list (⚠️ a function = built after the language is decided) */
export function helpText() {
  return t(
    `nyan — nyan-remote のコマンド

  nyan pair        スマホを登録する（QR を出す）
  nyan update      更新する（git の作業ツリーは git pull、インストーラで入れた台は install.sh）
  nyan devices     登録済みの端末の一覧（--revoke <id の先頭> で失効）
  nyan status      版・常駐の様子・relay の様子
  nyan logs        ログを見る（-f で追いかける）
  nyan pending     承認待ちがあるか
  nyan keys        打鍵の入口の確認
  nyan login       こちらの relay を使うためにログインする（GitHub）
  nyan logout      ログアウトする（このマシンをアカウントから外す）
  nyan account     プランと上限
  nyan uninstall   このマシンから外す（鍵と登録は残す。--purge で全部）
  nyan version     版
  nyan help <コマンド>  そのコマンドの詳しい使い方（nyan <コマンド> --help でも同じ）

入れた場所: ${ROOT}
（言語は LANG に従います。変えるときは NYAN_LANG=en か ja）
`,
    `nyan — nyan-remote commands

  nyan pair        register a phone (shows a QR code)
  nyan update      update (git pull for a git checkout, install.sh for installer setups)
  nyan devices     list registered phones (--revoke <id prefix> to revoke)
  nyan status      version, service state, relay state
  nyan logs        show logs (-f to follow)
  nyan pending     whether an approval is pending
  nyan keys        check the keystroke path
  nyan login       sign in to use our relay (GitHub)
  nyan logout      sign out (removes this machine from the account)
  nyan account     plan and limits
  nyan uninstall   remove from this machine (keeps keys and registrations; --purge removes all)
  nyan version     version
  nyan help <command>  detailed usage (same as nyan <command> --help)

Installed at: ${ROOT}
(Language follows LANG. Set NYAN_LANG=ja or en to change it.)
`,
  )
}

/** ★ Version (RELEASE on installer machines, the short hash on git machines) */
export function versionOf(root, run = spawnSync) {
  try {
    const rel = readFileSync(join(root, 'RELEASE'), 'utf8').split('\n')[0]?.trim()
    if (rel) return rel
  } catch {
    // no RELEASE = a git working tree
  }
  const r = run('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' })
  return r.status === 0 ? String(r.stdout).trim() : t('不明', 'unknown')
}

/** ★ Restart steps (per service type / from the one place in `service.mjs`) */
export function restartArgv(kind, uid = process.getuid?.() ?? 0) {
  if (kind === 'systemd') return ['systemctl', '--user', 'restart', 'nyan-remote']
  if (kind === 'launchd') return ['launchctl', 'kickstart', '-k', `gui/${uid}/${LAUNCHD_LABEL}`]
  return undefined
}

/**
 * ★★ Update steps (a pure function = tests check it).
 * - git working tree: `git pull` → pending check → `npm run build` → restart (same as the old one-liner)
 * - installer machines: `install.sh` with `NYAN_REMOTE_UPDATE=1 NYAN_REMOTE_HOME=<install location>` (⚠️ always pass the location = machine C)
 * @returns the list of steps. A `pendingCheck` step stops on exit code 1 (approvals pending)
 */
export function updatePlan({ root, isGit, kind, home }) {
  if (isGit) {
    const restart = restartArgv(kind)
    return [
      { label: 'git pull', argv: ['git', '-C', root, 'pull', '--ff-only'], cwd: root },
      // ★ Reinstall dependencies only when the lockfile (package-lock.json) changed with the pull (codex round 20, medium #3)
      //   ⚠️ Without reinstalling, it restarts with parts the new version needs missing, and the agent crashes
      { label: t('依存の入れ直し', 'Reinstall dependencies'), argv: ['npm', 'install'], cwd: root, onlyIfLockChanged: true },
      { label: t('承認待ちの確認', 'Check pending approvals'), argv: [process.execPath, join(root, 'scripts', 'pending.mjs')], cwd: root, pendingCheck: true },
      { label: t('ビルド', 'Build'), argv: ['npm', 'run', 'build'], cwd: root },
      ...(restart
        ? [
            { label: t('再起動', 'Restart'), argv: restart, cwd: root },
            // ★ After restarting, check it **really came up** (the agent can crash even if the restart command succeeded / medium #3)
            { label: t('起動の確認', 'Check it started'), argv: [process.execPath, join(root, 'scripts', 'pending.mjs')], cwd: root, waitAlive: true },
          ]
        : []),
      // ★★ Set up again (the same 3 as the installer's update / 2026-09-24). ⚠️ This used to be missing only on git machines, so
      //    changes to `nyan` itself, the generated shim, notify.sh and hooks did not arrive with `git pull`, and one line had to be typed by hand.
      //    ⚠️ After the agent is up (hook setup looks at the agent / same order as install.sh). Each is idempotent.
      ...setupSteps(root),
    ]
  }
  // ⚠️ The installer swaps the tree ⇒ run from home (never start inside a place that disappears / same remedy as install.sh)
  // ⚠️⚠️ **Run only after the download finishes** (codex round 20, medium #2): with `curl … | bash`, even if the fetch failed, bash read nothing,
  //    exited 0 and said "updated". It may also run a partially downloaded script ⇒ download to a temp file, then run it
  return [
    {
      label: t('インストーラで更新', 'Update with the installer'),
      argv: [
        'bash',
        '-c',
        `set -eu; f="$(mktemp)"; trap 'rm -f "$f"' EXIT; curl -fsSL ${DISTRIBUTION_ORIGIN}/install.sh -o "$f"; bash "$f"`,
      ],
      cwd: home,
      env: { NYAN_REMOTE_UPDATE: '1', NYAN_REMOTE_HOME: root },
    },
  ]
}

/**
 * ★ Setup steps (same as the end of `install.sh`'s update: place notify.sh → hooks → the keystroke path and `nyan`).
 * ⚠️ notify.sh lives in one place, `install-notify.mjs` (replaced **only when it equals a version we shipped**; links left alone /
 *    codex round 23, high #1. It used to be silently overwritten with bash `cp`).
 */
export function setupSteps(root) {
  return [
    { label: t('notify.sh を置き直す', 'Reinstall notify.sh'), argv: [process.execPath, join(root, 'scripts', 'install-notify.mjs')], cwd: root },
    { label: t('フックの設置', 'Install hooks'), argv: [process.execPath, join(root, 'scripts', 'install-permission-hook.mjs')], cwd: root },
    { label: t('打鍵の経路と nyan の設置', 'Install the keystroke relay and nyan'), argv: [process.execPath, join(root, 'scripts', 'install-relay.mjs')], cwd: root },
  ]
}

/** ★ Fingerprint of the lockfile (⚠️ empty if missing = only used to compare whether it changed) */
export function lockHash(root) {
  try {
    return createHash('sha256').update(readFileSync(join(root, 'package-lock.json'))).digest('hex')
  } catch {
    return ''
  }
}

/**
 * ★★ Whether to proceed based on the pending check (codex round 20, high #1).
 *   0 none ⇒ proceed / 1 pending ⇒ stop / 2 agent is stopped (no approvals to lose) ⇒ proceed /
 *   ⚠️⚠️ 3 could not check ⇒ **stop** (never lose approvals that may exist by restarting). Proceeds only with `--force`
 */
export function pendingDecision(code, force) {
  if (code === 0 || code === 2) return 'go'
  if (code === 1) return 'stop-pending'
  return force ? 'go' : 'stop-unknown'
}

function run(argv, opts = {}) {
  const r = spawnSync(argv[0], argv.slice(1), {
    stdio: 'inherit',
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, ...(opts.env ?? {}) },
  })
  return r.status ?? 1
}

function update(args) {
  const force = args.includes('--force')
  const kind = serviceKind(platform(), homedir())
  const plan = updatePlan({ root: ROOT, isGit: existsSync(join(ROOT, '.git')), kind, home: homedir() })
  const lockBefore = lockHash(ROOT)
  for (const step of plan) {
    if (step.onlyIfLockChanged && lockHash(ROOT) === lockBefore) continue
    console.log(`▸ ${step.label}`)
    if (step.waitAlive) {
      // ⚠️ 2 = cannot reach the agent. Wait up to 30 seconds for it to come up (any other answer means it is up)
      let alive = false
      for (let i = 0; i < 30 && !alive; i++) {
        const r = spawnSync(step.argv[0], step.argv.slice(1), { cwd: step.cwd, stdio: 'ignore' })
        alive = r.status !== 2
        if (!alive) spawnSync('sleep', ['1'])
      }
      if (!alive) {
        console.error(t('✗ 再起動したあと agent が起きません。ログを見てください: nyan logs', '✗ The agent did not come back after the restart. Check the logs: nyan logs'))
        return 1
      }
      continue
    }
    const code = run(step.argv, step)
    if (step.pendingCheck) {
      const d = pendingDecision(code, force)
      if (d === 'stop-pending') {
        console.error(t('✗ 承認待ちがあります。答えてからもう一度 nyan update を打ってください（再起動すると待っている承認が消えます）', '✗ An approval is pending. Answer it, then run nyan update again (restarting would drop it).'))
        return 1
      }
      if (d === 'stop-unknown') {
        console.error(
          t(
            '✗ 承認待ちがあるか確かめられませんでした（再起動すると、あった場合に消えます）。\n' +
              '  スマホか PC で承認待ちが無いことを確かめてから: nyan update --force',
            '✗ Could not check for pending approvals (restarting would drop any that exist).\n' +
              '  Make sure none is pending on the phone or PC, then: nyan update --force',
          ),
        )
        return 3
      }
      if (code !== 0) console.log(t('  （agent が止まっているので、消える承認はありません。このまま進めます）', '  (The agent is stopped, so no approval can be lost. Continuing.)'))
      continue
    }
    if (code !== 0) {
      console.error(t(`✗ 「${step.label}」で止まりました（終了コード ${code}）`, `✗ Stopped at "${step.label}" (exit code ${code})`))
      return code
    }
  }
  if (!restartArgv(kind) && existsSync(join(ROOT, '.git'))) {
    console.log(t(`★ 常駐させていないので、agent は自分で起こし直してください: ${hints(kind).start}`, `★ No background service here, so restart the agent yourself: ${hints(kind).start}`))
  }
  console.log(t(`✔ 更新しました（版 ${versionOf(ROOT)}）`, `✔ Updated (version ${versionOf(ROOT)})`))
  return 0
}

function status() {
  const kind = serviceKind(platform(), homedir())
  console.log(t(`版:         ${versionOf(ROOT)}`, `Version:    ${versionOf(ROOT)}`))
  const git = existsSync(join(ROOT, '.git'))
  console.log(t(`入れた場所: ${ROOT}${git ? '（git の作業ツリー）' : '（インストーラ）'}`, `Installed:  ${ROOT}${git ? ' (git checkout)' : ' (installer)'}`))
  console.log(t(`常駐:       ${kind}`, `Service:    ${kind}`))
  if (kind === 'systemd') {
    const r = spawnSync('systemctl', ['--user', 'is-active', 'nyan-remote'], { encoding: 'utf8' })
    console.log(t(`動いているか: ${String(r.stdout || r.stderr).trim() || '不明'}`, `Running:    ${String(r.stdout || r.stderr).trim() || 'unknown'}`))
  } else if (kind === 'launchd') {
    const r = spawnSync('launchctl', ['print', `gui/${process.getuid?.()}/${LAUNCHD_LABEL}`], { encoding: 'utf8' })
    const state = String(r.stdout).match(/state = (\S+)/)?.[1]
    console.log(t(`動いているか: ${state ?? '不明'}`, `Running:    ${state ?? 'unknown'}`))
  }
  // ★ For the relay, print "the last line of that kind" in the affirmative (never cut by line count / CLAUDE.md §2)
  const relay = recentLogLines(kind, homedir()).filter((l) => l.includes('[relay]')).at(-1)
  console.log(`relay:      ${relay ? relay.replace(/^.*\[relay\]\s*/, '') : t('（ログにまだ出ていません）', '(not in the logs yet)')}`)
  return 0
}

function logs(args) {
  const kind = serviceKind(platform(), homedir())
  const follow = args.includes('-f') || args.includes('--follow')
  if (kind === 'systemd') {
    return run(['journalctl', '--user', '-u', 'nyan-remote', '-n', '50', '--no-pager', ...(follow ? ['-f'] : [])])
  }
  if (kind === 'launchd') return run(['tail', '-n', '50', ...(follow ? ['-f'] : []), launchdLogPath(homedir())])
  console.log(t(`常駐させていないので、ログは ${hints(kind).logs} に出ています`, `No background service here; logs go to: ${hints(kind).logs}`))
  return 0
}

/** ★ Is it `nyan <command> --help` (⚠️ look only right after the command = do not swallow a value like `-h…`) */
export function wantsHelp(rest) {
  return rest[0] === '--help' || rest[0] === '-h'
}

/** ★ Print usage (⚠️ for an unknown command, print the list and exit with 2) */
export function help(cmd) {
  if (!cmd) {
    process.stdout.write(helpText())
    return 0
  }
  const detail = helpDetail()[cmd]
  if (!detail) {
    console.error(t(`知らないコマンドです: ${cmd}\n`, `Unknown command: ${cmd}\n`))
    process.stdout.write(helpText())
    return 2
  }
  process.stdout.write(detail)
  return 0
}

export function main(argv, env = process.env) {
  initCliLang(env)
  const [cmd, ...rest] = argv
  if (!cmd || cmd === '-h' || cmd === '--help') return help(undefined)
  if (cmd === 'help') return help(rest[0])
  // ★ `nyan <command> --help` too (⚠️ never pass it to the underlying script = pair would show a QR)
  //   ⚠️⚠️ Look **only right after the command** (codex round 20, low #8): device ids can start with `-h`, so
  //      the value in `nyan devices --revoke -hAbc` would be misread as help and revoking would fail
  if (wantsHelp(rest)) return help(cmd)
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    console.log(versionOf(ROOT))
    return 0
  }
  if (cmd === 'update') return update(rest)
  if (cmd === 'status') return status()
  if (cmd === 'logs') return logs(rest)
  const script = PASSTHROUGH[cmd]
  if (script) return run([process.execPath, join(ROOT, script), ...rest])
  if (ACCOUNT_COMMANDS.includes(cmd)) return run([process.execPath, join(ROOT, 'scripts', 'account.mjs'), cmd, ...rest])
  console.error(t(`知らないコマンドです: ${cmd}\n`, `Unknown command: ${cmd}\n`))
  process.stdout.write(helpText())
  return 2
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
