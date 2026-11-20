// ★ agy's status line relay (`hooks/agy-statusline.sh`) and its installer (`scripts/install-agy.mjs`) — docs/AGY.md §5.
//   Both run for real: the relay with bash under `sh -c` (as agy runs it), the installer in a throwaway HOME.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyAgySettings, main, readCommand, shimStep } from './install-agy.mjs'

const RELAY = new URL('../hooks/agy-statusline.sh', import.meta.url).pathname
const CID = '062a8f25-9451-42f3-ae93-34a208e99365'
const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`

// The shape agy 1.5.12 sends (measured 2026-11-19), with example values
function input(over = {}) {
  return JSON.stringify({
    cwd: '/home/user/work',
    session_id: CID,
    conversation_id: CID,
    transcript_path: '/home/user/.gemini/antigravity/brain/x/transcript.jsonl',
    model: { id: 'Gemini 4 Neon (High)', display_name: 'Gemini 4 Neon (High)', effort: 'high' },
    version: '1.5.12',
    context_window: { total_input_tokens: 13013, used_percentage: 1.24 },
    quota: { 'gemini-weekly': { remaining_fraction: 0.99, reset_time: '2026-11-26T04:49:30Z', reset_in_seconds: 577914 } },
    agent_state: 'idle',
    cycle_mode: 'accept-edits',
    plan_tier: 'Google AI Pro',
    email: 'someone@example.com',
    terminal_width: 160,
    ...over,
  })
}

function home() {
  const h = mkdtempSync(join(tmpdir(), 'nyan-agy-'))
  mkdirSync(join(h, '.nyan-remote', 'agy'), { recursive: true, mode: 0o700 })
  return h
}

/** Run the relay as agy does: `sh -c '<command>'` with the input on stdin */
function relay(h, command, stdin) {
  return spawnSync('sh', ['-c', command], { input: stdin, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: h } })
}

const saved = (h) => JSON.parse(readFileSync(join(h, '.nyan-remote', 'agy', `session-${CID}.json`), 'utf8'))

test('relay: keeps the state per conversation without the e-mail, names agy (the parent of sh -c), prints nothing', (t) => {
  const h = home()
  t.after(() => rmSync(h, { recursive: true, force: true }))
  const r = relay(h, `${q(RELAY)}; echo "sh=$$"`, input())
  assert.equal(r.status, 0)
  // ★ nothing of ours on screen (agy's own status line stays)
  const shPid = Number(/sh=(\d+)/.exec(r.stdout)?.[1])
  assert.equal(r.stdout.replace(/sh=\d+\n?/, ''), '')
  const j = saved(h)
  assert.equal(j.input.conversation_id, CID)
  assert.equal(j.input.agent_state, 'idle')
  // ⚠️⚠️ the e-mail is never kept
  assert.equal('email' in j.input, false)
  assert.doesNotMatch(readFileSync(join(h, '.nyan-remote', 'agy', `session-${CID}.json`), 'utf8'), /example\.com/)
  // the pid is the parent of the `sh -c` that ran us (here: the test's own sh's parent = node)
  assert.equal(j.nyanPid, process.pid)
  assert.ok(shPid > 0)
  assert.equal(j.nyanBusyAt, 0)
  assert.equal(statSync(join(h, '.nyan-remote', 'agy', `session-${CID}.json`)).mode & 0o777, 0o600)
})

test('relay: the e-mail is removed wherever it sits (first, middle, last), and the file stays JSON', (t) => {
  const h = home()
  t.after(() => rmSync(h, { recursive: true, force: true }))
  const base = JSON.parse(input())
  delete base.email
  for (const json of [
    JSON.stringify({ email: 'a@example.com', ...base }),
    JSON.stringify({ ...base, email: 'a@example.com' }),
    JSON.stringify(base).replace('"cwd"', '"email" : "a@example.com" , "cwd"'),
  ]) {
    relay(h, q(RELAY), json)
    const j = saved(h)
    assert.equal('email' in j.input, false, json)
  }
  // an address the pattern cannot take out (an escaped quote inside) ⇒ nothing is written
  rmSync(join(h, '.nyan-remote', 'agy', `session-${CID}.json`))
  relay(h, q(RELAY), JSON.stringify({ ...base, email: 'a\\"b@example.com' }))
  assert.equal(existsSync(join(h, '.nyan-remote', 'agy', `session-${CID}.json`)), false)
})

test('relay: remembers when the conversation was last busy, across idle writes', (t) => {
  const h = home()
  t.after(() => rmSync(h, { recursive: true, force: true }))
  relay(h, q(RELAY), input({ agent_state: 'working' }))
  const busy = saved(h).nyanBusyAt
  assert.ok(busy > 1_700_000_000)
  relay(h, q(RELAY), input({ agent_state: 'idle' }))
  assert.equal(saved(h).nyanBusyAt, busy)
})

test('relay: no conversation yet, a bad id, no state directory or a linked one ⇒ nothing written; the user line still runs', (t) => {
  const h = home()
  t.after(() => rmSync(h, { recursive: true, force: true }))
  const dir = join(h, '.nyan-remote', 'agy')
  relay(h, q(RELAY), input({ conversation_id: '', session_id: '' }))
  relay(h, q(RELAY), input({ conversation_id: '../../x' }))
  assert.deepEqual(readdirSync(dir), [])
  rmSync(dir, { recursive: true })
  const elsewhere = mkdtempSync(join(tmpdir(), 'nyan-agy-other-'))
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }))
  symlinkSync(elsewhere, dir)
  const r = relay(h, `${q(RELAY)} --nyan-remote-relay ${q('cat >/dev/null; echo mine')}`, input())
  assert.deepEqual(readdirSync(elsewhere), [])
  assert.equal(r.stdout, 'mine\n')
})

test('relay: the user status line gets the same bytes and prints exactly what it prints under sh -c', (t) => {
  const h = home()
  t.after(() => rmSync(h, { recursive: true, force: true }))
  const raw = input()
  const r = relay(h, `${q(RELAY)} --nyan-remote-relay ${q('cat')}`, raw)
  assert.equal(r.stdout, raw)
  // ★ the user's command runs through sh, as agy runs it (dash's echo reads escapes; bash's does not / codex review)
  const cmd = "cat >/dev/null; echo 'a\\tb'"
  const direct = spawnSync('sh', ['-c', cmd], { input: raw, encoding: 'utf8' }).stdout
  assert.equal(relay(h, `${q(RELAY)} --nyan-remote-relay ${q(cmd)}`, raw).stdout, direct)
})

test('relay: names agy whether the sh -c stays (dash) or replaces itself with the relay (bash as sh)', (t) => {
  const h = home()
  t.after(() => rmSync(h, { recursive: true, force: true }))
  // A stand-in agy: bash run under the name `agy` (its process name is then `agy`)
  const fake = join(h, 'agy')
  symlinkSync(process.env.SHELL && process.env.SHELL.endsWith('bash') ? process.env.SHELL : '/bin/bash', fake)
  for (const how of [`sh -c ${q(`${q(RELAY)}; :`)}`, `sh -c ${q(`exec ${q(RELAY)}`)}`]) {
    rmSync(join(h, '.nyan-remote', 'agy', `session-${CID}.json`), { force: true })
    const r = spawnSync(fake, ['-c', `echo $$; ${how}; :`], { input: input(), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: h } })
    assert.equal(saved(h).nyanPid, Number(r.stdout.trim()), how)
  }
})

test('installer: no status line ⇒ ours alone, stacked; the user’s ⇒ wrapped; uninstall gives back exactly what was there', () => {
  const relay = '/opt/nyan/hooks/agy-statusline.sh'
  const added = applyAgySettings({ trustedWorkspaces: ['/w'] }, { relay })
  assert.equal(added.did, 'added')
  assert.deepEqual(added.data, { trustedWorkspaces: ['/w'], statusLine: { type: 'command', command: q(relay), stack_with_default: true } })
  assert.equal(applyAgySettings(added.data, { relay }).did, 'unchanged')
  assert.deepEqual(applyAgySettings(added.data, { relay, remove: true }).data, { trustedWorkspaces: ['/w'] })

  const mine = { statusLine: { type: 'command', command: "~/my line.sh --x 'y'", padding: 1 } }
  const wrapped = applyAgySettings(mine, { relay })
  assert.equal(wrapped.did, 'relayed')
  assert.equal(wrapped.data.statusLine.padding, 1)
  assert.deepEqual(readCommand(wrapped.data.statusLine.command, relay), { ours: true, inner: "~/my line.sh --x 'y'" })
  assert.equal(applyAgySettings(wrapped.data, { relay }).did, 'unchanged', 'never wrapped twice')
  assert.deepEqual(applyAgySettings(wrapped.data, { relay, remove: true }).data, mine)
  // ★ a moved tree is still ours and is re-pointed (never wrapped around itself)
  const moved = applyAgySettings(wrapped.data, { relay: '/new/hooks/agy-statusline.sh' })
  assert.equal(moved.did, 'relayed')
  assert.deepEqual(readCommand(moved.data.statusLine.command, '/new/hooks/agy-statusline.sh'), { ours: true, inner: "~/my line.sh --x 'y'" })
  // a status line the user turned off, or not a command one, is left alone; someone else's is never "removed"
  assert.equal(applyAgySettings({ statusLine: { command: 'x', enabled: false } }, { relay }).did, 'skipped')
  assert.equal(applyAgySettings({ statusLine: true }, { relay }).did, 'skipped')
  assert.equal(applyAgySettings(mine, { relay, remove: true }).did, 'not-ours')
  assert.equal(readCommand(`${q('/x/hooks/agy-statusline.sh.evil')}`, relay).ours, false)
  assert.equal(readCommand(`${q(relay)} --other ${q('x')}`, relay).ours, false)
})

test('installer: no agy ⇒ nothing; agy ⇒ settings written (backup kept, mode kept) and the state directory made private', (t) => {
  const h = mkdtempSync(join(tmpdir(), 'nyan-agy-inst-'))
  t.after(() => rmSync(h, { recursive: true, force: true }))
  const log = t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'warn', () => {})
  const was = process.env.NYAN_REMOTE_STATE_DIR
  delete process.env.NYAN_REMOTE_STATE_DIR
  t.after(() => (was === undefined ? delete process.env.NYAN_REMOTE_STATE_DIR : (process.env.NYAN_REMOTE_STATE_DIR = was)))
  assert.equal(main([], h), 0)
  assert.equal(existsSync(join(h, '.gemini')), false)
  assert.equal(existsSync(join(h, '.nyan-remote')), false)
  const root = join(h, '.gemini', 'antigravity-cli')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'settings.json'), '{"trustedWorkspaces":["/w"]}\n', { mode: 0o644 })
  assert.equal(main([], h), 0)
  const s = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'))
  assert.equal(s.statusLine.stack_with_default, true)
  assert.match(s.statusLine.command, /hooks\/agy-statusline\.sh'$/)
  assert.equal(statSync(join(root, 'settings.json')).mode & 0o777, 0o644)
  assert.ok(readdirSync(root).some((n) => n.startsWith('settings.json.bak-')))
  assert.equal(statSync(join(h, '.nyan-remote', 'agy')).mode & 0o777, 0o700)
  assert.equal(main(['--uninstall'], h), 0)
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')), { trustedWorkspaces: ['/w'] })
  // ★ a settings file that is a link (dotfiles) stays a link; the file it points to gets the change (codex review)
  const dotfiles = join(h, 'dotfiles')
  mkdirSync(dotfiles)
  writeFileSync(join(dotfiles, 'agy.json'), '{}\n')
  rmSync(join(root, 'settings.json'))
  symlinkSync(join(dotfiles, 'agy.json'), join(root, 'settings.json'))
  assert.equal(main([], h), 0)
  assert.equal(lstatSync(join(root, 'settings.json')).isSymbolicLink(), true)
  assert.ok(JSON.parse(readFileSync(join(dotfiles, 'agy.json'), 'utf8')).statusLine)
  assert.equal(main(['--uninstall'], h), 0)
  assert.equal(lstatSync(join(root, 'settings.json')).isSymbolicLink(), true)
  assert.deepEqual(JSON.parse(readFileSync(join(dotfiles, 'agy.json'), 'utf8')), {})
  // ★ unwritable: installing goes on (0); removing stops (1) while our relay is still named there (codex review)
  t.mock.method(console, 'error', () => {})
  assert.equal(main([], h), 0)
  chmodSync(dotfiles, 0o500)
  try {
    if (process.getuid?.() !== 0) {
      assert.equal(main(['--uninstall'], h), 1)
      assert.ok(JSON.parse(readFileSync(join(dotfiles, 'agy.json'), 'utf8')).statusLine)
    }
  } finally {
    chmodSync(dotfiles, 0o700)
  }
  assert.equal(main([], h), 0)
  assert.equal(main(['--uninstall'], h), 0)
  // ⚠️ a link to something missing stays a link (never replaced by a file of ours)
  rmSync(join(dotfiles, 'agy.json'))
  assert.equal(main([], h), 0)
  assert.equal(lstatSync(join(root, 'settings.json')).isSymbolicLink(), true)
  assert.equal(existsSync(join(dotfiles, 'agy.json')), false)
  rmSync(join(root, 'settings.json'))
  // ⚠️ a file that is not JSON is never touched
  writeFileSync(join(root, 'settings.json'), '{broken')
  t.mock.method(console, 'error', () => {})
  assert.equal(main([], h), 0)
  assert.equal(readFileSync(join(root, 'settings.json'), 'utf8'), '{broken')
  // ⚠️ agy is optional: broken settings without our relay never stop nyan's uninstall; with it, they do
  assert.equal(main(['--uninstall'], h), 0)
  assert.equal(readFileSync(join(root, 'settings.json'), 'utf8'), '{broken')
  writeFileSync(join(root, 'settings.json'), `{"statusLine":{"command":"'/x/hooks/agy-statusline.sh'",}`)
  assert.equal(main(['--uninstall'], h), 1)
  assert.equal(main([], h), 0, 'installing goes on')
  // an empty file is an empty settings object (nothing of ours in it)
  writeFileSync(join(root, 'settings.json'), '')
  assert.equal(main(['--uninstall'], h), 0)
  assert.ok(log.mock.callCount() > 0)
})

test('★★ agy shim: placed only with the shim directory and a real agy on PATH; a file that is not ours is never touched; removal removes only ours', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'nyan-agy-shim-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const realDir = join(home, 'real')
  mkdirSync(realDir)
  const real = join(realDir, 'agy')
  // a stand-in agy that prints its arguments
  writeFileSync(real, '#!/bin/sh\necho "real agy: $*"\n', { mode: 0o755 })
  const env = { PATH: `${join(home, '.nyan-remote', 'bin')}:${realDir}:/usr/bin:/bin` }
  const quiet = (fn) => {
    const log = console.log
    console.log = () => {}
    try {
      return fn()
    } finally {
      console.log = log
    }
  }
  const shim = join(home, '.nyan-remote', 'bin', 'agy')
  // no shim directory (the typing route is not installed) ⇒ nothing
  assert.equal(quiet(() => shimStep({ remove: false, dry: false, home, env })), 0)
  assert.equal(existsSync(shim), false)
  mkdirSync(join(home, '.nyan-remote', 'bin'), { recursive: true })
  // no agy on PATH ⇒ nothing
  quiet(() => shimStep({ remove: false, dry: false, home, env: { PATH: '/usr/bin:/bin' } }))
  assert.equal(existsSync(shim), false)
  quiet(() => shimStep({ remove: false, dry: false, home, env }))
  const body = readFileSync(shim, 'utf8')
  assert.match(body, /^#!\/bin\/sh\n# nyan-remote: 打鍵で渡す経路/)
  assert.ok(body.includes(`real='${real}'`))
  assert.match(body, /-p\|-p=\*\|--p\|--p=\*\|--print\|--print=\*\|-print\|-print=\*\|--prompt\|--prompt=\*\|-prompt\|-prompt=\*\) exec "\$real"/)
  assert.equal(statSync(shim).mode & 0o777, 0o755)
  // ★ without a terminal it is agy itself (fail-open), arguments untouched
  const run = spawnSync(shim, ['-p', 'hi there'], { env: { ...env, HOME: home }, encoding: 'utf8' })
  assert.equal(run.stdout.trim(), 'real agy: -p hi there')
  // the shim found first on PATH is never taken as the real one
  quiet(() => shimStep({ remove: false, dry: false, home, env }))
  assert.ok(readFileSync(shim, 'utf8').includes(`real='${real}'`))
  // ★ the saved agy is gone (an update moved it): a folder named agy earlier on PATH is skipped, the program is found
  const later = join(home, 'later')
  mkdirSync(join(home, 'early', 'agy'), { recursive: true })
  mkdirSync(later)
  writeFileSync(join(later, 'agy'), '#!/bin/sh\necho "moved agy: $*"\n', { mode: 0o755 })
  rmSync(real)
  const moved = spawnSync(shim, ['x'], { env: { HOME: home, PATH: `${join(home, 'early')}:${join(home, '.nyan-remote', 'bin')}:${later}:/usr/bin:/bin` }, encoding: 'utf8' })
  assert.equal(moved.stdout.trim(), 'moved agy: x', moved.stderr)
  writeFileSync(real, '#!/bin/sh\necho "real agy: $*"\n', { mode: 0o755 })
  // removal removes ours
  quiet(() => shimStep({ remove: true, dry: false, home, env }))
  assert.equal(existsSync(shim), false)
  // ⚠️ someone else's file at that name: never replaced, never removed
  writeFileSync(shim, '#!/bin/sh\necho mine\n', { mode: 0o755 })
  quiet(() => shimStep({ remove: false, dry: false, home, env }))
  assert.equal(readFileSync(shim, 'utf8'), '#!/bin/sh\necho mine\n')
  quiet(() => shimStep({ remove: true, dry: false, home, env }))
  assert.equal(readFileSync(shim, 'utf8'), '#!/bin/sh\necho mine\n')
})
