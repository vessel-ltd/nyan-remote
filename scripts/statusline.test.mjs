// ★ The status line relay (`hooks/statusline.sh`) and how the installer puts it in front of the user's status line
//   (2026-11-17 / agent/src/usage.ts). Both are run for real: the relay with bash, the installer in a throwaway HOME.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const RELAY = new URL('../hooks/statusline.sh', import.meta.url).pathname
const INSTALL = new URL('./install-permission-hook.mjs', import.meta.url).pathname
const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`
const wrapped = (account, input) => `{"nyanAccount":"${account}","input":${input}}`
const INPUT = JSON.stringify({ model: { id: 'x' }, rate_limits: { seven_day: { used_percentage: 9, resets_at: 1795312800 } } })

function home() {
  const h = mkdtempSync(join(tmpdir(), 'nyan-sl-'))
  mkdirSync(join(h, '.nyan-remote', 'usage'), { recursive: true, mode: 0o700 })
  return h
}

function relay(h, args, input, env = {}) {
  return spawnSync('bash', [RELAY, ...args], { input, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: h, ...env } })
}

test('relay: keeps the reading for the profile, and the user status line gets the same input and shows the same output', (t) => {
  const h = home()
  t.after(() => rmSync(h, { recursive: true, force: true }))
  // The user's command echoes what it got (so the test sees the input reached it unchanged)
  const r = relay(h, ['--nyan-remote-relay', 'cat; echo " | mine"'], INPUT, { CLAUDE_CONFIG_DIR: join(h, '.claude-s') })
  assert.equal(r.status, 0)
  // ★ The exact bytes (no newline added)
  assert.equal(r.stdout, `${INPUT} | mine\n`)
  // No config for that profile here: no account recorded
  assert.equal(readFileSync(join(h, '.nyan-remote', 'usage', 'claude-.claude-s.json'), 'utf8'), wrapped('', INPUT))
})

const U = '88c9fbd1-0000-4000-8000-000000000000'
/** Claude Code's own layout (2.1.326): `accountUuid` is the first key of `oauthAccount` */
const config = (uuid) => JSON.stringify({ numStartups: 3, oauthAccount: { accountUuid: uuid, emailAddress: 'user@example.com' }, cachedUsageUtilization: { accountUuid: 'ffffffff-0000-4000-8000-000000000000' } }, null, 2)

test('relay: records the account from the config the session uses — $CLAUDE_CONFIG_DIR/.claude.json, else ~/.claude.json (not ~/.claude/.claude.json)', (t) => {
  const h = home()
  t.after(() => rmSync(h, { recursive: true, force: true }))
  mkdirSync(join(h, '.claude-r'))
  writeFileSync(join(h, '.claude-r', '.claude.json'), config(U))
  relay(h, ['true'], INPUT, { CLAUDE_CONFIG_DIR: join(h, '.claude-r') })
  assert.equal(readFileSync(join(h, '.nyan-remote', 'usage', 'claude-.claude-r.json'), 'utf8'), wrapped(U, INPUT))

  // The default profile: ~/.claude.json is the live one; a stale ~/.claude/.claude.json is not read
  const other = '0976d2ee-0000-4000-8000-000000000000'
  mkdirSync(join(h, '.claude'))
  writeFileSync(join(h, '.claude', '.claude.json'), config(other))
  writeFileSync(join(h, '.claude.json'), config(U))
  relay(h, ['true'], INPUT)
  assert.equal(readFileSync(join(h, '.nyan-remote', 'usage', 'claude-.claude.json'), 'utf8'), wrapped(U, INPUT))

  // ⚠️ A nested oauthAccount earlier in the file (e.g. under a project) is not the top-level one (codex review round 4)
  const nested = JSON.stringify({ projects: { '/home/user/p': { oauthAccount: { accountUuid: other } } }, oauthAccount: { accountUuid: U } }, null, 2)
  writeFileSync(join(h, '.claude.json'), nested)
  relay(h, ['true'], INPUT)
  assert.equal(readFileSync(join(h, '.nyan-remote', 'usage', 'claude-.claude.json'), 'utf8'), wrapped(U, INPUT))
  // Not a UUID (36 hyphens): no account
  writeFileSync(join(h, '.claude.json'), config('-'.repeat(36)))
  relay(h, ['true'], INPUT)
  assert.equal(readFileSync(join(h, '.nyan-remote', 'usage', 'claude-.claude.json'), 'utf8'), wrapped('', INPUT))
  // Past the first 1 MB in **bytes** (multibyte padding, NUL padding): not read, so no account (codex review round 5)
  for (const pad of ['あ'.repeat(400_000), '\0'.repeat(1_100_000)]) {
    writeFileSync(join(h, '.claude.json'), `{\n  "pad": "${pad}",\n  "oauthAccount": {\n    "accountUuid": "${U}"\n  }\n}\n`)
    relay(h, ['true'], INPUT)
    assert.equal(readFileSync(join(h, '.nyan-remote', 'usage', 'claude-.claude.json'), 'utf8'), wrapped('', INPUT))
  }
  // Past the first 1 MB: not read (the render path stays quick), so no account
  writeFileSync(join(h, '.claude.json'), JSON.stringify({ pad: 'x'.repeat(1_100_000), oauthAccount: { accountUuid: U } }, null, 2))
  relay(h, ['true'], INPUT)
  assert.equal(readFileSync(join(h, '.nyan-remote', 'usage', 'claude-.claude.json'), 'utf8'), wrapped('', INPUT))

  // A layout it does not know: no account, rather than a wrong one
  writeFileSync(join(h, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'user@example.com', accountUuid: U } }))
  relay(h, ['true'], INPUT)
  assert.equal(readFileSync(join(h, '.nyan-remote', 'usage', 'claude-.claude.json'), 'utf8'), wrapped('', INPUT))
})

test('relay: the default profile, and a call without rate_limits keeps the last reading', (t) => {
  const h = home()
  t.after(() => rmSync(h, { recursive: true, force: true }))
  relay(h, ['true'], INPUT)
  const f = join(h, '.nyan-remote', 'usage', 'claude-.claude.json')
  assert.equal(readFileSync(f, 'utf8'), wrapped('', INPUT))
  // The first calls of a session have no limits yet: the last reading must not be wiped
  relay(h, ['true'], JSON.stringify({ model: { id: 'x' } }))
  assert.equal(readFileSync(f, 'utf8'), wrapped('', INPUT))
})

test('relay: never writes through what is at the name (a link, a hard link, a FIFO), never without our directory, never for a name that is not a profile', (t) => {
  const h = home()
  t.after(() => rmSync(h, { recursive: true, force: true }))
  const target = join(h, 'elsewhere')
  writeFileSync(target, 'keep')
  const f = join(h, '.nyan-remote', 'usage', 'claude-.claude-r.json')
  for (const plant of [() => symlinkSync(target, f), () => linkSync(target, f), () => execFileSync('mkfifo', [f])]) {
    rmSync(f, { force: true })
    plant()
    const r = spawnSync('bash', [RELAY, '--nyan-remote-relay', 'echo shown'], { input: INPUT, encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH, HOME: h, CLAUDE_CONFIG_DIR: join(h, '.claude-r') } })
    assert.equal(r.error, undefined, 'never blocks')
    assert.equal(r.stdout, 'shown\n', 'the status line still shows')
    assert.equal(readFileSync(target, 'utf8'), 'keep')
    // ★ Replaced by a new file of ours
    assert.equal(readFileSync(f, 'utf8'), wrapped('', INPUT))
  }

  relay(h, ['true'], INPUT, { CLAUDE_CONFIG_DIR: join(h, 'not-a-profile') })
  assert.equal(existsSync(join(h, '.nyan-remote', 'usage', 'claude-not-a-profile.json')), false)

  const bare = mkdtempSync(join(tmpdir(), 'nyan-sl-bare-'))
  t.after(() => rmSync(bare, { recursive: true, force: true }))
  const b = relay(bare, ['echo shown'], INPUT)
  assert.equal(b.stdout, 'shown\n')
  assert.equal(existsSync(join(bare, '.nyan-remote')), false, 'the relay never creates our directory')
})

test('relay: the user command fails the same way it would alone, with the same umask; no command prints nothing', (t) => {
  const h = home()
  t.after(() => rmSync(h, { recursive: true, force: true }))
  const mine = spawnSync('bash', ['-c', `umask 022; exec bash ${q(RELAY)} --nyan-remote-relay umask`], { input: INPUT, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: h } })
  assert.equal(mine.stdout.trim(), '0022', 'our umask stays in our part')
  assert.equal(relay(h, ['echo half; exit 3'], INPUT).status, 3)
  const none = relay(h, [], INPUT)
  assert.equal(none.status, 0)
  assert.equal(none.stdout, '')
})

// ── installer ──────────────────────────────────────────────────────────────────────────────────────────────────

function installHome(statusLine) {
  const h = mkdtempSync(join(tmpdir(), 'nyan-sl-inst-'))
  mkdirSync(join(h, '.claude', 'projects'), { recursive: true })
  mkdirSync(join(h, '.nyan-remote'), { recursive: true })
  writeFileSync(join(h, '.nyan-remote', 'hook-token'), 'tok\n')
  const settings = { model: 'x', ...(statusLine === undefined ? {} : { statusLine }) }
  writeFileSync(join(h, '.claude', 'settings.json'), JSON.stringify(settings, null, 2))
  return h
}

function install(h, args = []) {
  return execFileSync('node', [INSTALL, ...args], { env: { ...process.env, HOME: h, NYAN_REMOTE_STATE_DIR: join(h, '.nyan-remote') }, encoding: 'utf8' })
}

const settingsOf = (h) => JSON.parse(readFileSync(join(h, '.claude', 'settings.json'), 'utf8'))

test('installer: puts the relay in front of the user status line, keeps padding, once; remove puts it back exactly', (t) => {
  const user = `~/.claude/statusline.sh --flag 'it''s'`
  const h = installHome({ type: 'command', command: user, padding: 0 })
  t.after(() => rmSync(h, { recursive: true, force: true }))
  install(h)
  const sl = settingsOf(h).statusLine
  assert.deepEqual(sl, { type: 'command', command: `${q(RELAY)} --nyan-remote-relay ${q(user)}`, padding: 0 })
  // The command it makes runs the user's command with the input (through the relay)
  assert.equal(spawnSync('bash', ['-c', `${q(RELAY)} --nyan-remote-relay ${q('cat')}`], { input: 'x', encoding: 'utf8', env: { PATH: process.env.PATH, HOME: h } }).stdout, 'x')
  assert.ok(existsSync(join(h, '.nyan-remote', 'usage')), 'its directory is made')

  // Again: not wrapped twice
  install(h)
  assert.deepEqual(settingsOf(h).statusLine, sl)

  // A tree that moved: re-pointed, still not wrapped twice
  const moved = { ...sl, command: `${q('/opt/old-tree/hooks/statusline.sh')} --nyan-remote-relay ${q(user)}` }
  writeFileSync(join(h, '.claude', 'settings.json'), JSON.stringify({ model: 'x', statusLine: moved }))
  install(h)
  assert.deepEqual(settingsOf(h).statusLine, sl)

  install(h, ['--remove'])
  assert.deepEqual(settingsOf(h).statusLine, { type: 'command', command: user, padding: 0 })
})

test('installer: no status line, or one that is not a command, is left as it is (nothing on screen changes)', (t) => {
  for (const statusLine of [undefined, { type: 'static', text: 'hi' }, { type: 'command', command: '  ' }]) {
    const h = installHome(statusLine)
    t.after(() => rmSync(h, { recursive: true, force: true }))
    install(h)
    assert.deepEqual(settingsOf(h).statusLine, statusLine)
  }
})

test('installer: someone else\'s statusline.sh is not ours: remove leaves it, install puts the relay in front of it', (t) => {
  for (const command of [`'/home/user/tools/hooks/statusline.sh'`, `'/home/user/tools/hooks/statusline.sh' 'x'`, `'/home/user/tools/hooks/statusline.sh'; echo x`]) {
    const user = { type: 'command', command, padding: 0 }
    const h = installHome(user)
    t.after(() => rmSync(h, { recursive: true, force: true }))
    install(h, ['--remove'])
    assert.deepEqual(settingsOf(h).statusLine, user)
    install(h)
    assert.equal(settingsOf(h).statusLine.command, `${q(RELAY)} --nyan-remote-relay ${q(command)}`)
    install(h, ['--remove'])
    assert.deepEqual(settingsOf(h).statusLine, user)
  }
})

test('relay: a command that does not read its input still shows, with nothing of ours on stderr', (t) => {
  const h = home()
  t.after(() => rmSync(h, { recursive: true, force: true }))
  const big = JSON.stringify({ rate_limits: {}, pad: 'x'.repeat(256 * 1024) })
  const r = spawnSync('bash', [RELAY, '--nyan-remote-relay', 'echo shown'], { input: big, encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH, HOME: h } })
  assert.equal(r.stdout, 'shown\n')
  assert.equal(r.stderr, '')
})
