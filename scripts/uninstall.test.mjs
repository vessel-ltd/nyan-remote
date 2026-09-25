// ★★ `nyan uninstall` (2026-09-26).
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { decideRemove, sha256 } from './install-notify.mjs'
import { agentAnswers, foreignEntries, httpProbe, removeLogs, shq, isOurPlist, isOurUnit, oldTrees, stateDirOf, stateDirProblem, treeProblem } from './uninstall.mjs'
import { uninstallTargets } from './install-relay.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fakeTree(dir, { git = false, release = true } = {}) {
  mkdirSync(join(dir, 'agent', 'src'), { recursive: true })
  writeFileSync(join(dir, 'agent', 'src', 'index.ts'), '')
  if (release) writeFileSync(join(dir, 'RELEASE'), 'r\n')
  if (git) mkdirSync(join(dir, '.git'))
  return dir
}

test('★★ the tree: a git checkout is never removed (it is the developer\'s working tree)', () => {
  const home = mkdtempSync(join(tmpdir(), 'nyan-un-'))
  const root = fakeTree(join(home, 'nyan-remote'), { git: true })
  assert.match(treeProblem({ root, stateDir: join(home, '.nyan-remote'), home }), /git/)
})

test('★★ the tree: only something that looks like a nyan-remote install (RELEASE + agent/src/index.ts)', () => {
  const home = mkdtempSync(join(tmpdir(), 'nyan-un-'))
  const root = fakeTree(join(home, 'app'), { release: false })
  assert.ok(treeProblem({ root, stateDir: join(home, '.nyan-remote'), home }), '⚠️ removed a directory without RELEASE')
  writeFileSync(join(root, 'RELEASE'), 'r\n')
  assert.equal(treeProblem({ root, stateDir: join(home, '.nyan-remote'), home }), undefined)
})

test('★★ the tree: never when it holds the state directory or the home directory (real paths)', () => {
  const home = mkdtempSync(join(tmpdir(), 'nyan-un-'))
  const root = fakeTree(join(home, 'app'))
  mkdirSync(join(root, 'state'))
  assert.ok(treeProblem({ root, stateDir: join(root, 'state'), home }), '⚠️⚠️ the keys would go with the tree')
  // ⚠️ Through a link too (compare real paths)
  symlinkSync(join(root, 'state'), join(home, 'state-link'))
  assert.ok(treeProblem({ root, stateDir: join(home, 'state-link'), home }), '⚠️⚠️ a linked state directory inside the tree was not noticed')
  const top = fakeTree(mkdtempSync(join(tmpdir(), 'nyan-un-top-')))
  mkdirSync(join(top, 'me'))
  assert.ok(treeProblem({ root: top, stateDir: join(top, 'x'), home: join(top, 'me') }), '⚠️⚠️ would remove the home directory')
})

test('★★ update backups: only exactly `<tree>.old-YYYYMMDD-HHMMSS` that pass the tree rules (codex: a checkout named like one)', () => {
  const base = mkdtempSync(join(tmpdir(), 'nyan-un-'))
  const root = fakeTree(join(base, 'app'))
  const home = join(base, 'home')
  mkdirSync(home)
  fakeTree(join(base, 'app.old-20260901-000000'))
  fakeTree(join(base, 'app.old-20260926-my-work'))
  fakeTree(join(base, 'app.old-keep'))
  fakeTree(join(base, 'app.old-20260902-000000'), { git: true })
  fakeTree(join(base, 'app.old-20260904-000000'), { release: false })
  const withState = fakeTree(join(base, 'app.old-20260903-000000'))
  mkdirSync(join(withState, 'state'))
  const got = oldTrees({ root, stateDir: join(withState, 'state'), home }).map((p) => p.slice(base.length + 1))
  assert.deepEqual(got, ['app.old-20260901-000000'])
})

test('★★ --purge: refuses a link, the home directory, a git checkout, and a directory holding anything not ours', () => {
  const home = mkdtempSync(join(tmpdir(), 'nyan-un-'))
  const s = join(home, '.nyan-remote')
  assert.equal(stateDirProblem({ stateDir: s, home }), 'absent')
  mkdirSync(s)
  assert.ok(stateDirProblem({ stateDir: s, home }), '⚠️ removed a directory without any of our files')
  writeFileSync(join(s, 'config.json'), '{}')
  mkdirSync(join(s, 'panes'))
  writeFileSync(join(s, 'vapid.json.tmp.123'), '')
  assert.equal(stateDirProblem({ stateDir: s, home }), undefined)
  // ⚠️⚠️ codex: NYAN_REMOTE_STATE_DIR=$HOME/project with a config.json was removed wholesale
  writeFileSync(join(s, 'notes.txt'), 'mine')
  assert.match(stateDirProblem({ stateDir: s, home }), /notes\.txt/, '⚠️⚠️ would delete a file that is not ours')
  const proj = join(home, 'project')
  mkdirSync(join(proj, '.git'), { recursive: true })
  mkdirSync(join(proj, 'sub'))
  writeFileSync(join(proj, 'sub', 'config.json'), '{}')
  assert.ok(stateDirProblem({ stateDir: join(proj, 'sub'), home }), '⚠️⚠️ would delete inside a git checkout')
  symlinkSync(s, join(home, 'link'))
  assert.ok(stateDirProblem({ stateDir: join(home, 'link'), home }), '⚠️ followed a link')
  writeFileSync(join(home, 'config.json'), '{}')
  assert.ok(stateDirProblem({ stateDir: home, home }), '⚠️⚠️ would remove the home directory')
})

test('★★ --purge looks inside: a personal tool in bin/, a subdirectory in panes/, a directory named like a file (codex round 2)', () => {
  const s = mkdtempSync(join(tmpdir(), 'nyan-un-'))
  writeFileSync(join(s, 'config.json'), '{}')
  for (const d of ['bin', 'panes', 'inflight']) mkdirSync(join(s, d))
  writeFileSync(join(s, 'panes', '123.json'), '{}')
  assert.deepEqual(foreignEntries(s), [])
  writeFileSync(join(s, 'inflight', 'x.jsonl'), '')
  writeFileSync(join(s, 'bin', 'mytool'), '')
  mkdirSync(join(s, 'panes', 'sub'))
  mkdirSync(join(s, 'vapid.json'))
  writeFileSync(join(s, 'panes', 'notes.txt'), '')
  writeFileSync(join(s, 'inflight', 'personal.csv'), '')
  writeFileSync(join(s, 'panes', '123.json.456.tmp'), '')
  writeFileSync(join(s, 'panes', '123.rejected'), '')
  writeFileSync(join(s, 'inflight', '0161bdfb-e0cb-4b0e-a124-3e0ba4dabbf6.jsonl'), '')
  assert.deepEqual(foreignEntries(s).sort(), ['bin/mytool', 'inflight/personal.csv', 'inflight/x.jsonl', 'panes/notes.txt', 'panes/sub', 'vapid.json'], '⚠️ codex round 4: any regular file used to pass')
})

test('★★ after stopping: the port comes from config.json; refused = gone, no answer = unknown, any HTTP answer = running', async () => {
  const s = mkdtempSync(join(tmpdir(), 'nyan-un-'))
  writeFileSync(join(s, 'config.json'), '{"port":7788}')
  let asked
  assert.equal(await agentAnswers(s, {}, async (port) => ((asked = port), 'no')), 'no')
  assert.equal(asked, 7788)
  // ⚠️ real sockets: a server that answers (on 6000, a port fetch refuses locally / codex round 3), one that never answers, a closed port
  const answering = createServer((_q, r) => r.writeHead(403).end())
  await new Promise((ok) => answering.listen(6000, '127.0.0.1', ok).on('error', () => answering.listen(0, '127.0.0.1', ok)))
  const silent = createServer(() => {})
  await new Promise((ok) => silent.listen(0, '127.0.0.1', ok))
  const closed = createServer()
  await new Promise((ok) => closed.listen(0, '127.0.0.1', ok))
  const closedPort = closed.address().port
  await new Promise((ok) => closed.close(ok))
  try {
    assert.equal(await httpProbe(answering.address().port), 'yes', '⚠️ a 403 is still a running agent')
    assert.equal(await httpProbe(silent.address().port, 200), 'unknown')
    assert.equal(await httpProbe(closedPort), 'no')
  } finally {
    answering.close()
    silent.closeAllConnections?.()
    silent.close()
  }
})

test('★ mac logs: only our log files go, and the directory only when empty (codex round 3)', () => {
  const d = mkdtempSync(join(tmpdir(), 'nyan-un-'))
  writeFileSync(join(d, 'agent.log'), '')
  writeFileSync(join(d, 'agent.log.1'), '')
  writeFileSync(join(d, 'my-notes.txt'), 'mine')
  removeLogs(d)
  assert.deepEqual(readdirSync(d), ['my-notes.txt'])
  rmSync(join(d, 'my-notes.txt'))
  writeFileSync(join(d, 'agent.log'), '')
  removeLogs(d)
  assert.ok(!existsSync(d))
})

test('★★ the state directory: from our unit (last assignment) or the plist; anything unusual is not guessed at', () => {
  const exec = 'ExecStart=/home/user/nyan-remote-app/scripts/agent-service.sh\n'
  const env = { NYAN_REMOTE_STATE_DIR: '/tmp/x' }
  const home = '/home/user'
  assert.deepEqual(stateDirOf({ unitBody: `Environment=NYAN_REMOTE_STATE_DIR=/srv/a\nEnvironment=NYAN_REMOTE_STATE_DIR=/srv/b\n${exec}`, env, home }), { dir: '/srv/b' })
  assert.ok(stateDirOf({ unitBody: `Environment="NYAN_REMOTE_STATE_DIR=/srv/n s"\n${exec}`, env, home }).problem, '⚠️ guessed a quoted value')
  assert.ok(stateDirOf({ unitBody: `Environment=NYAN_REMOTE_STATE_DIR="/srv/n"\n${exec}`, env, home }).problem)
  // ⚠️ a unit that is not ours is not read
  assert.deepEqual(stateDirOf({ unitBody: 'Environment=NYAN_REMOTE_STATE_DIR=/srv/evil\nExecStart=/usr/bin/other\n', env, home }), { dir: '/tmp/x' })
  const plistBody = '<string>/Users/u/nyan-remote/scripts/agent-service.sh</string>\n<key>NYAN_REMOTE_STATE_DIR</key>\n    <string>/Users/u/a &amp; b</string>'
  assert.deepEqual(stateDirOf({ plistBody, env, home }), { dir: '/Users/u/a & b' }, '⚠️ codex: mac ignored the plist')
  assert.deepEqual(stateDirOf({ env: {}, home }), { dir: '/home/user/.nyan-remote' })
})

test('★★ --purge refuses when the parent is not writable (the directory itself could not be removed / codex round 4)', { skip: process.getuid?.() === 0 }, () => {
  const home = mkdtempSync(join(tmpdir(), 'nyan-un-'))
  const parent = join(home, 'p')
  const s = join(parent, 'state')
  mkdirSync(s, { recursive: true })
  writeFileSync(join(s, 'config.json'), '{}')
  assert.equal(stateDirProblem({ stateDir: s, home }), undefined)
  chmodSync(parent, 0o500)
  try {
    assert.ok(stateDirProblem({ stateDir: s, home })?.startsWith(parent), 'the parent must be named as the reason')
  } finally {
    chmodSync(parent, 0o700)
  }
})

test('★★ printed commands are quoted, and an unreadable directory is foreign, not an exception (codex round 5)', { skip: process.getuid?.() === 0 }, () => {
  assert.equal(shq("/Users/a/nyan state"), "'/Users/a/nyan state'")
  assert.equal(execFileSync('sh', ['-c', `printf %s ${shq("it's here")}`], { encoding: 'utf8' }), "it's here")
  const s = mkdtempSync(join(tmpdir(), 'nyan-un-'))
  writeFileSync(join(s, 'config.json'), '{}')
  mkdirSync(join(s, 'panes'))
  chmodSync(join(s, 'panes'), 0o300)
  try {
    assert.deepEqual(foreignEntries(s), ['panes/'])
  } finally {
    chmodSync(join(s, 'panes'), 0o700)
  }
})

test('★ the plist: only ours is read, stopped or deleted (codex round 4)', () => {
  const ours = '<key>ProgramArguments</key>\n  <array>\n    <string>/bin/bash</string>\n    <string>/Users/u/nyan-remote/scripts/agent-service.sh</string>\n  </array>\n    <key>NYAN_REMOTE_STATE_DIR</key>\n    <string>/Users/u/state</string>'
  assert.ok(isOurPlist(ours))
  assert.deepEqual(stateDirOf({ plistBody: ours, env: {}, home: '/Users/u' }), { dir: '/Users/u/state' })
  const other = ours.replace('/Users/u/nyan-remote/scripts/agent-service.sh', '/usr/local/bin/other')
  assert.ok(!isOurPlist(other))
  assert.deepEqual(stateDirOf({ plistBody: other, env: {}, home: '/Users/u' }), { dir: '/Users/u/.nyan-remote' })
})

test('★ the unit: only ours (starts our launcher)', () => {
  assert.ok(isOurUnit('[Service]\nExecStart=/home/user/nyan-remote-app/scripts/agent-service.sh\n'))
  assert.ok(isOurUnit('[Service]\nExecStart=%h/nyan-remote/scripts/agent-service.sh\n'), 'the unit docs/SETUP-AGENT.md writes')
  assert.ok(!isOurUnit('[Service]\nExecStart=/usr/bin/something-else\n'))
})

test('★ uninstallTargets: every rc we may have written that exists, whatever the shell now is', () => {
  const home = mkdtempSync(join(tmpdir(), 'nyan-un-'))
  writeFileSync(join(home, '.bashrc'), '')
  writeFileSync(join(home, '.profile'), '')
  assert.deepEqual(uninstallTargets(home, [join(home, '.zshrc')]).map((p) => p.slice(home.length + 1)).sort(), ['.bashrc', '.profile'])
})

test('★ notify.sh --remove: only a copy we shipped (a modified one is the user\'s)', () => {
  const known = new Set([sha256(Buffer.from('ours'))])
  assert.equal(decideRemove({ dest: Buffer.from('ours'), known }), 'remove')
  assert.equal(decideRemove({ dest: Buffer.from('mine'), known }), 'modified')
  assert.equal(decideRemove({ dest: 'link', known }), 'linked')
  assert.equal(decideRemove({ dest: 'unreadable', known }), 'unreadable')
  assert.equal(decideRemove({ dest: undefined, known }), 'absent')
})

/**
 * ★★★ Install for real, then uninstall for real, in a throwaway HOME.
 * ⚠️ PATH holds only a fake claude, node and the system (never the real ~/.nyan-remote/bin); the port is one nobody listens on.
 * ⚠️ No systemd unit in the fake HOME, so `systemctl` is never called.
 */
function installed() {
  const home = mkdtempSync(join(tmpdir(), 'nyan-un-e2e-'))
  const tree = join(home, 'nyan-remote-app')
  for (const d of ['scripts', 'shared', 'hooks']) {
    cpSync(join(REPO, d), join(tree, d), { recursive: true, filter: (p) => !p.includes('__pycache__') && !p.endsWith('.test.mjs') })
  }
  fakeTree(tree)
  const state = join(home, '.nyan-remote')
  mkdirSync(state)
  writeFileSync(join(state, 'config.json'), '{"port":59123}')
  writeFileSync(join(state, 'hook-token'), 'tok\n')
  for (const a of ['.claude', '.claude-r']) mkdirSync(join(home, a, 'projects'), { recursive: true })
  writeFileSync(join(home, '.claude', 'settings.json'), '{"theme":"dark"}\n')
  writeFileSync(join(home, '.bashrc'), '# mine\n')
  writeFileSync(join(home, '.profile'), '# mine too\n')
  const bin = join(home, 'fakebin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho 1.0.0\n')
  chmodSync(join(bin, 'claude'), 0o755)
  const env = { HOME: home, SHELL: '/bin/bash', PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, NYAN_LANG: 'en', NYAN_REMOTE_NO_OPEN: '1' }
  const node = (script, args = []) => execFileSync(process.execPath, [join(tree, 'scripts', script), ...args], { env, cwd: home, stdio: 'pipe' })
  node('install-notify.mjs')
  node('install-permission-hook.mjs')
  node('install-relay.mjs')
  assert.match(readFileSync(join(home, '.claude-r', 'settings.json'), 'utf8'), /permission/, 'setup did not install the hooks (the test would prove nothing)')
  assert.ok(existsSync(join(state, 'bin', 'claude')) && existsSync(join(state, 'bin', 'nyan')), 'setup did not place the shim and nyan')
  const uninstall = (args, extraEnv = {}) =>
    spawnSync(process.execPath, [join(tree, 'scripts', 'uninstall.mjs'), '--yes', ...args], { env: { ...env, ...extraEnv }, cwd: home, encoding: 'utf8' })
  return { home, tree, state, uninstall }
}

function assertUserFilesKept(home) {
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')), { theme: 'dark' }, 'the user\'s settings must stay, our hooks must go')
  assert.ok(!readFileSync(join(home, '.claude-r', 'settings.json'), 'utf8').includes('hooks'))
  assert.equal(readFileSync(join(home, '.bashrc'), 'utf8'), '# mine\n')
  assert.equal(readFileSync(join(home, '.profile'), 'utf8'), '# mine too\n')
  assert.ok(!existsSync(join(home, '.claude', 'hooks', 'notify.sh')))
}

test('★★★ install → uninstall --purge: the user\'s files stay, nothing of ours is left', () => {
  const { home, tree, state, uninstall } = installed()
  const r = uninstall(['--purge'])
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  assertUserFilesKept(home)
  assert.ok(!existsSync(tree), 'the installed tree is still there')
  assert.ok(!existsSync(state), 'the state directory is still there (--purge)')
})

test('★★★ install → uninstall (no --purge, another SHELL, a config dir without projects/): the state stays, the rest goes', () => {
  const { home, tree, state, uninstall } = installed()
  // ⚠️ codex: a directory whose projects/ was cleared kept our hooks / installed under bash, uninstalled under zsh kept the bash blocks
  rmSync(join(home, '.claude-r', 'projects'), { recursive: true })
  const r = uninstall([], { SHELL: '/bin/zsh' })
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  assertUserFilesKept(home)
  assert.ok(!existsSync(tree))
  assert.ok(existsSync(join(state, 'config.json')) && existsSync(join(state, 'hook-token')), '⚠️⚠️ the keys must stay without --purge')
  assert.ok(!existsSync(join(state, 'bin', 'claude')), 'the shim is still there')
  assert.ok(!existsSync(join(state, 'bin', 'nyan')), 'the nyan command is still there')
})

test('★★ a settings.json that cannot be read stops the uninstall before anything its hooks call is deleted', () => {
  const { home, tree, uninstall } = installed()
  writeFileSync(join(home, '.claude-r', 'settings.json'), '{ broken')
  const r = uninstall([])
  assert.notEqual(r.status, 0, `${r.stdout}\n${r.stderr}`)
  assert.ok(existsSync(join(home, '.claude', 'hooks', 'notify.sh')), '⚠️ notify.sh was deleted while a hook may still call it')
  assert.ok(existsSync(tree), '⚠️ the tree was deleted while a hook may still call it')
})

test('★★ without the hook token: stops, and --force still finishes (codex round 2)', () => {
  const { home, tree, state, uninstall } = installed()
  rmSync(join(state, 'hook-token'))
  assert.equal(uninstall([]).status, 3, 'must not guess that nothing is pending')
  const r = uninstall(['--force'])
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  assertUserFilesKept(home)
  assert.ok(!existsSync(tree))
})

test('★★ a state directory that cannot be fully deleted is not touched, and a retry finishes (codex round 3)', { skip: process.getuid?.() === 0 }, () => {
  const { home, tree, state, uninstall } = installed()
  mkdirSync(join(state, 'panes'), { recursive: true })
  writeFileSync(join(state, 'panes', '1.json'), '{}')
  chmodSync(join(state, 'panes'), 0o500)
  const r = uninstall(['--purge'])
  chmodSync(join(state, 'panes'), 0o700)
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  assert.match(r.stdout, /not writable/)
  assert.ok(existsSync(join(state, 'config.json')) && existsSync(join(state, 'panes', '1.json')), '⚠️ deleted half of it')
  // ★ the rest is gone, so finishing is just the state directory (the printed rm, or a reinstall + --purge)
  assert.ok(!existsSync(tree))
})

test('★★ --purge keeps a state directory that holds a file which is not ours', () => {
  const { state, uninstall } = installed()
  writeFileSync(join(state, 'notes.txt'), 'mine')
  const r = uninstall(['--purge'])
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  assert.equal(readFileSync(join(state, 'notes.txt'), 'utf8'), 'mine')
  assert.match(r.stdout, /notes\.txt/)
})

test('★ without a terminal and without --yes it asks nothing and changes nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'nyan-un-'))
  const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'uninstall.mjs')], { env: { ...process.env, HOME: home, NYAN_LANG: 'en' }, input: '', encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /--yes/)
})
