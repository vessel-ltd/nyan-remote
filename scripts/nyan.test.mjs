// ★★ The `nyan` / `nyan-remote` commands (2026-09-24).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { cliShim, commandElsewhere, installCli, isOurs, removeCli } from './lib/cli.mjs'
import { ACCOUNT_COMMANDS, cliLang, DISTRIBUTION_ORIGIN, helpDetail, helpText, main, PASSTHROUGH, pendingDecision, ROOT, restartArgv, updatePlan, wantsHelp } from './nyan.mjs'
import { setLang } from '../shared/i18n.ts'

test('★★ update: installer machines always pass "the install location" to install.sh (machine C), starting from home', () => {
  const [step] = updatePlan({ root: '/home/u/nyan-remote-app', isGit: false, kind: 'systemd', home: '/home/u' })
  assert.equal(step.env.NYAN_REMOTE_UPDATE, '1')
  assert.equal(step.env.NYAN_REMOTE_HOME, '/home/u/nyan-remote-app', '⚠️⚠️ without the location it reinstalls into ~/nyan-remote')
  assert.equal(step.cwd, '/home/u', '⚠️ starting inside the tree leaves it stranded in a place removed by the swap')
  assert.ok(step.argv.join(' ').includes(`curl -fsSL ${DISTRIBUTION_ORIGIN}/install.sh -o`), '⚠️ does not download before running')
})

test('★★ if fetching the installer fails, never report success (codex round 20, medium #2 / actually run with a fake curl)', () => {
  const d = mkdtempSync(join(tmpdir(), 'nyan-curl-'))
  const [step] = updatePlan({ root: '/r', isGit: false, kind: 'systemd', home: d })
  const run = (curlBody) => {
    writeFileSync(join(d, 'curl'), `#!/bin/sh\n${curlBody}\n`)
    chmodSync(join(d, 'curl'), 0o755)
    try {
      execFileSync(step.argv[0], step.argv.slice(1), { cwd: d, env: { ...process.env, PATH: `${d}:${process.env.PATH}` }, stdio: 'pipe' })
      return 0
    } catch (e) {
      return e.status
    }
  }
  // ⚠️⚠️ Fetch failed (prints nothing on an HTTP error) ⇒ must not exit 0
  assert.notEqual(run('exit 22'), 0, '⚠️⚠️ reports success although fetching failed')
  // ★ If fetched, run that script (and return its exit code)
  assert.equal(run('while [ "$1" != "-o" ]; do shift; done; printf "exit 0\\n" > "$2"'), 0)
  assert.equal(run('while [ "$1" != "-o" ]; do shift; done; printf "exit 7\\n" > "$2"'), 7)
})

test('★★ update: git machines do pull → pending check → build → restart (same order as the old one-liner)', () => {
  setLang('ja') // ⚠️ step names change with the language (the order must not depend on `main()` having decided the language)
  const plan = updatePlan({ root: '/r', isGit: true, kind: 'systemd', home: '/h' })
  assert.deepEqual(plan.map((s) => s.label), [
    'git pull',
    '依存の入れ直し',
    '承認待ちの確認',
    'ビルド',
    '再起動',
    '起動の確認',
    // ★★ Same setup as the installer's update (⚠️ without it, changes to `nyan`, the shim, notify.sh and hooks never reach git machines)
    'notify.sh を置き直す',
    'フックの設置',
    '打鍵の経路と nyan の設置',
  ])
  assert.equal(plan[1].onlyIfLockChanged, true, '⚠️ reinstalls dependencies every time (slow) / no condition')
  assert.equal(plan[2].pendingCheck, true, '⚠️⚠️ does not stop on pending approvals (the restart would lose them)')
  assert.deepEqual(plan[4].argv, ['systemctl', '--user', 'restart', 'nyan-remote'])
  assert.equal(plan[5].waitAlive, true, '⚠️ does not check that it came back up after restarting (medium #3)')
  assert.deepEqual(restartArgv('launchd', 501), ['launchctl', 'kickstart', '-k', 'gui/501/app.nyan-remote.agent'])
  // ⚠️ Machines without a service are not restarted (never print steps that cannot run)
  assert.equal(updatePlan({ root: '/r', isGit: true, kind: 'none', home: '/h' }).some((s) => s.label === '再起動' || s.waitAlive), false)
})

test('★★★ the distribution origin matches shared/distribution.ts', () => {
  const src = readFileSync(join(ROOT, 'shared', 'distribution.ts'), 'utf8')
  assert.ok(src.includes(`DISTRIBUTION_ORIGIN = '${DISTRIBUTION_ORIGIN}'`))
})

test('★★★ calls the existing steps as they are (never write a step in two places)', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  for (const [name, script] of Object.entries(PASSTHROUGH)) {
    const npmName = name === 'keys' ? 'keys' : name
    assert.ok(pkg.scripts[npmName]?.includes(script.replace('scripts/', 'scripts/')), `⚠️ npm run ${npmName} and ${script} disagree`)
  }
  assert.equal(main(['nosuch']), 2)
})

test('★★ placing commands: places both, leaves identical ones alone, skips nyan if another nyan exists, never overwrites foreign files', async () => {
  const d = mkdtempSync(join(tmpdir(), 'nyan-cli-'))
  const bin = join(d, 'bin')
  const other = join(d, 'other')
  mkdirSync(bin)
  mkdirSync(other)
  const r1 = await installCli({ binDir: bin, root: '/opt/nr', pathEnv: `${bin}:${other}` })
  assert.deepEqual(r1.map((r) => r.result), ['placed', 'placed'])
  assert.ok(isOurs(readFileSync(join(bin, 'nyan'), 'utf8')))
  assert.deepEqual((await installCli({ binDir: bin, root: '/opt/nr', pathEnv: bin })).map((r) => r.result), ['kept', 'kept'])
  // ⚠️ Another tool's nyan is on PATH ⇒ do not place it (do not shadow it)
  writeFileSync(join(other, 'nyan'), '#!/bin/sh\necho other\n')
  chmodSync(join(other, 'nyan'), 0o755)
  assert.equal(commandElsewhere('nyan', `${bin}:${other}`, bin), join(other, 'nyan'))
  const r2 = await installCli({ binDir: bin, root: '/opt/nr2', pathEnv: `${bin}:${other}` })
  assert.equal(r2.find((r) => r.name === 'nyan').result, 'skipped')
  assert.equal(r2.find((r) => r.name === 'nyan-remote').result, 'placed')
  // ⚠️ Never overwrite or remove foreign files
  writeFileSync(join(bin, 'nyan-remote'), '#!/bin/sh\necho mine\n')
  const r3 = await installCli({ binDir: bin, root: '/opt/nr', pathEnv: bin })
  assert.equal(r3.find((r) => r.name === 'nyan-remote').result, 'skipped')
  await removeCli(bin)
  assert.equal(readFileSync(join(bin, 'nyan-remote'), 'utf8'), '#!/bin/sh\necho mine\n', '⚠️⚠️ removed a foreign file')
})

test('★★ running a placed command runs nyan.mjs in the install location (even with spaces and quotes in the path)', () => {
  const d = mkdtempSync(join(tmpdir(), "nyan cli '"))
  const shim = join(d, 'nyan')
  writeFileSync(shim, cliShim(ROOT))
  chmodSync(shim, 0o755)
  execFileSync('sh', ['-n', shim])
  const out = execFileSync(shim, ['help'], { encoding: 'utf8', env: { ...process.env, NYAN_LANG: 'ja' } })
  assert.match(out, /nyan pair/)
  assert.ok(out.includes(ROOT), '⚠️ does not mention the install location')
})

test('★★★ even with spaces or quotes in the install location, the placed command points there (sh quoting)', () => {
  const root = mkdtempSync(join(tmpdir(), "nyan root 'q' "))
  mkdirSync(join(root, 'scripts'))
  writeFileSync(join(root, 'scripts', 'nyan.mjs'), "process.stdout.write('ROOT-OK ' + process.argv.slice(2).join(','))\n")
  const shim = join(root, 'nyan')
  writeFileSync(shim, cliShim(root))
  chmodSync(shim, 0o755)
  assert.equal(execFileSync(shim, ['a b', "c'd"], { encoding: 'utf8' }), "ROOT-OK a b,c'd")
})

test('★★★ help: the list and detailed descriptions match the real commands (both Japanese and English)', () => {
  const commands = [...Object.keys(PASSTHROUGH), ...ACCOUNT_COMMANDS, 'update', 'status', 'logs', 'version', 'help']
  for (const lang of ['ja', 'en']) {
    setLang(lang)
    const detail = helpDetail()
    const list = helpText()
    for (const c of commands) {
      assert.ok(detail[c], `⚠️ ${lang}: no detailed description for ${c}`)
      assert.ok(list.includes(`nyan ${c}`), `⚠️ ${lang}: ${c} is missing from the list`)
    }
    for (const c of Object.keys(detail)) assert.ok(commands.includes(c), `⚠️ description for a nonexistent command ${c}`)
  }
  setLang('ja')
})

test('★★ language: NYAN_LANG > LC_ALL > LC_MESSAGES > LANG. Japanese if it starts with ja, otherwise (unset, C) English', () => {
  assert.equal(cliLang({}), 'en', '⚠️⚠️ Japanese with nothing set (C locale = English)')
  assert.equal(cliLang({ LANG: 'C.UTF-8' }), 'en')
  assert.equal(cliLang({ LANG: 'ja_JP.UTF-8' }), 'ja')
  assert.equal(cliLang({ LANG: 'ja_JP.UTF-8', LC_ALL: 'en_US.UTF-8' }), 'en', '⚠️ LC_ALL is stronger than LANG')
  assert.equal(cliLang({ LANG: 'en_US.UTF-8', LC_MESSAGES: 'ja_JP.UTF-8' }), 'ja')
  assert.equal(cliLang({ LANG: 'ja_JP.UTF-8', NYAN_LANG: 'en' }), 'en', '⚠️ cannot change it with NYAN_LANG')
  assert.equal(cliLang({ LANG: 'C', NYAN_LANG: 'ja' }), 'ja')
  assert.equal(cliLang({ LANG: 'ja', NYAN_LANG: 'fr' }), 'en', '⚠️ decided by the first non-empty value (NYAN_LANG too)')
  assert.equal(cliLang({ LANG: 'C', NYAN_LANG: 'ja_JP.UTF-8' }), 'ja')
})

test('★★★ nyan help <command> / nyan <command> --help does not run the underlying script (pair does not show a QR)', () => {
  const ja = { ...process.env, NYAN_LANG: 'ja' }
  const out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'nyan.mjs'), 'pair', '--help'], { encoding: 'utf8', env: ja })
  assert.match(out, /スマホを1台 登録する/)
  // ★ English in an English environment
  const en = execFileSync(process.execPath, [join(ROOT, 'scripts', 'nyan.mjs'), 'pair', '--help'], { encoding: 'utf8', env: { ...process.env, NYAN_LANG: '', LANG: 'C.UTF-8', LC_ALL: '', LC_MESSAGES: '' } })
  assert.match(en, /register one phone/)
  assert.doesNotMatch(out, /nyan:\/\/pair/, '⚠️⚠️ --help actually showed a QR (issued a one-time token)')
  assert.match(execFileSync(process.execPath, [join(ROOT, 'scripts', 'nyan.mjs'), 'help', 'update'], { encoding: 'utf8', env: ja }), /承認待ちがあると止まります/)
  assert.equal(main(['help', 'nosuch']), 2)
})

test('★★ pending check: stops if it could not check (3), proceeds only with --force (codex round 20, high #1)', () => {
  assert.equal(pendingDecision(0, false), 'go')
  assert.equal(pendingDecision(2, false), 'go', '⚠️ stops although the agent is stopped (no approvals to lose)')
  assert.equal(pendingDecision(1, false), 'stop-pending')
  assert.equal(pendingDecision(1, true), 'stop-pending', '⚠️⚠️ --force discards pending approvals')
  assert.equal(pendingDecision(3, false), 'stop-unknown', '⚠️⚠️ restarts although it could not check (existing approvals would be lost)')
  assert.equal(pendingDecision(3, true), 'go')
})

test('★★★ help is only right after the command (does not swallow a device id like -h… / codex round 20, low #8)', () => {
  assert.equal(wantsHelp(['--help']), true)
  assert.equal(wantsHelp(['-h']), true)
  assert.equal(wantsHelp(['--revoke', '-hAbc']), false, '⚠️⚠️ mistakes the value for help, so it cannot revoke')
  // ⚠️ Also pass it as a value when the prefix is exactly `-h` (the first 2 characters of an id)
  assert.equal(wantsHelp(['--revoke', '-h']), false, '⚠️⚠️ mistook the value -h for help')
})

test('★★ never overwrites a dangling symlink in the bin directory (codex round 20, medium #4)', async () => {
  const { symlinkSync, lstatSync, readlinkSync } = await import('node:fs')
  const d = mkdtempSync(join(tmpdir(), 'nyan-link-'))
  const bin = join(d, 'bin')
  mkdirSync(bin)
  symlinkSync(join(d, 'まだ無い道具'), join(bin, 'nyan'))
  const r = await installCli({ binDir: bin, root: '/opt/nr', pathEnv: bin })
  assert.equal(r.find((x) => x.name === 'nyan').result, 'skipped')
  assert.ok(lstatSync(join(bin, 'nyan')).isSymbolicLink(), "⚠️⚠️ replaced the user's link")
  assert.equal(readlinkSync(join(bin, 'nyan')), join(d, 'まだ無い道具'))
})

test('★★ if the bin directory is a symlink, removal deletes nothing (never removes another install behind the link / codex round 20, medium #5)', async () => {
  const { symlinkSync, existsSync } = await import('node:fs')
  const d = mkdtempSync(join(tmpdir(), 'nyan-rm-'))
  const real = join(d, 'real-bin')
  mkdirSync(real)
  await installCli({ binDir: real, root: '/opt/nr', pathEnv: real })
  symlinkSync(real, join(d, 'linked-bin'))
  await removeCli(join(d, 'linked-bin'))
  assert.ok(existsSync(join(real, 'nyan')), '⚠️⚠️ followed the link and removed commands in another bin directory')
  await removeCli(real)
  assert.equal(existsSync(join(real, 'nyan')), false, '(control) removed in a real bin directory')
})

test('★★★ an empty PATH entry is checked for clashes as "the current directory" (codex round 20, low #7)', () => {
  const d = mkdtempSync(join(tmpdir(), 'nyan-cwd-'))
  writeFileSync(join(d, 'nyan'), '#!/bin/sh\n')
  chmodSync(join(d, 'nyan'), 0o755)
  const prev = process.cwd()
  process.chdir(d)
  try {
    assert.equal(commandElsewhere('nyan', ':/nonexistent', '/some/bin'), join(d, 'nyan'), '⚠️ skips the empty entry')
  } finally {
    process.chdir(prev)
  }
})

test('★★★ even if a link in the bin directory points at "a nyan-remote-shaped file", the link is not replaced (only regular files are touched)', async () => {
  const { symlinkSync, lstatSync } = await import('node:fs')
  const d = mkdtempSync(join(tmpdir(), 'nyan-link2-'))
  const bin = join(d, 'bin')
  mkdirSync(bin)
  const target = join(d, 'elsewhere-nyan')
  writeFileSync(target, cliShim('/opt/other'))
  symlinkSync(target, join(bin, 'nyan'))
  const r = await installCli({ binDir: bin, root: '/opt/nr', pathEnv: bin })
  assert.equal(r.find((x) => x.name === 'nyan').result, 'skipped')
  assert.ok(lstatSync(join(bin, 'nyan')).isSymbolicLink(), "⚠️⚠️ replaced the user's link")
})
