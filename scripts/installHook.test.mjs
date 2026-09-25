// ★★ Invariants of `install-permission-hook.mjs` (2026-09-21).
//
// ⚠️⚠️ **It runs on users' machines yet had not a single test** (the same hole as `install.sh`).
//   And it actually broke: **it placed `notify.sh` but never wired it up**, so
//   people who installed via `install.sh` **never got a single "turn finished" notification**
//   (test notifications do arrive, so it is indistinguishable from subscription or VAPID problems).
//
// ★ How it runs: create a throwaway HOME, call it with `--dry-run`, and look at **the before/after the implementation prints**
//   (⚠️ not hand-built JSON passed to a function, but **the script itself**).

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const SCRIPT = new URL('./install-permission-hook.mjs', import.meta.url).pathname

/** Throwaway HOME (needs `~/.claude/projects` and hook-token) */
function makeHome(o = {}) {
  const home = mkdtempSync(join(tmpdir(), 'nyan-hook-'))
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true })
  mkdirSync(join(home, '.nyan-remote'), { recursive: true })
  writeFileSync(join(home, '.nyan-remote', 'hook-token'), 'tok\n')
  if (o.notify !== false) {
    mkdirSync(join(home, '.claude', 'hooks'), { recursive: true })
    writeFileSync(join(home, '.claude', 'hooks', 'notify.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  }
  if (o.settings) {
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(o.settings, null, 2))
  }
  return home
}

function run(home, args = []) {
  return execFileSync('node', [SCRIPT, ...args], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  })
}

/**
 * ★★ **Read the settings.json that was actually written** (2026-09-21).
 *
 * ⚠️⚠️ At first we looked at the `--dry-run` summary, but it only says "present / absent", so
 *    **we never checked "did it remove the user's hooks"** (= a false green).
 *    ⇒ Look at **the value the implementation produces** (the file).
 */
function hooksOf(home) {
  return JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).hooks ?? {}
}

/** Flatten all commands in that event */
function commandsOf(hooks, event) {
  return (hooks[event] ?? []).flatMap((m) => (m.hooks ?? []).map((h) => h.command ?? h.url))
}

test('★★ wires Stop / StopFailure / Notification when notify.sh exists', (t) => {
  const home = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  run(home)
  // ⚠️⚠️ Without this **not a single notification is sent** (hit for real on 2026-09-21)
  const hooks = hooksOf(home)
  for (const ev of ['Stop', 'StopFailure', 'Notification']) {
    assert.deepEqual(
      commandsOf(hooks, ev),
      ['"$HOME/.claude/hooks/notify.sh"'],
      `${ev} is not wired (no notifications at all)`,
    )
  }
})

test('★★ does not wire when notify.sh is missing (fail-closed) + says so', (t) => {
  const home = makeHome({ notify: false })
  t.after(() => rmSync(home, { recursive: true, force: true }))
  run(home)
  // ⚠️ A hook pointing at something missing fails silently on every turn (and invisibly)
  const hooks = hooksOf(home)
  for (const ev of ['Stop', 'StopFailure', 'Notification']) {
    assert.deepEqual(commandsOf(hooks, ev), [], `⚠️⚠️ wired ${ev} although notify.sh is not installed`)
  }
  // ★ Approvals are still installed (no notifications is no reason to drop everything)
  assert.equal(commandsOf(hooks, 'PermissionRequest').length, 1, 'approvals stopped too')
})

test('★★★ --remove also removes notifications (removing always works)', (t) => {
  const home = makeHome({
    settings: {
      hooks: {
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: '"$HOME/.claude/hooks/notify.sh"' }] }],
      },
    },
  })
  t.after(() => rmSync(home, { recursive: true, force: true }))
  run(home, ['--remove'])
  assert.deepEqual(commandsOf(hooksOf(home), 'Stop'), [], '⚠️ not removed')
})

test('★★ never removes hooks the user wrote (no "contains" matching)', (t) => {
  // ⚠️⚠️ Another command that **contains** `notify.sh` (the user's own wrapper) is not ours
  const mine = '"$HOME/.claude/hooks/notify.sh" 2>>/tmp/mylog'
  const home = makeHome({
    settings: { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: mine }] }] } },
  })
  t.after(() => rmSync(home, { recursive: true, force: true }))
  run(home)
  const got = commandsOf(hooksOf(home), 'Stop')
  assert.ok(got.includes(mine), `⚠️⚠️ removed the user's hook: ${JSON.stringify(got)}`)
  assert.ok(got.includes('"$HOME/.claude/hooks/notify.sh"'), 'our own entry is missing')
})

test('★★★ the port follows config.json (⚠️ never add a hook for 7777 / codex round 23, medium #2)', (t) => {
  const home = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  writeFileSync(join(home, '.nyan-remote', 'config.json'), JSON.stringify({ port: 8888 }))
  const env = { ...process.env, HOME: home }
  delete env.NYAN_REMOTE_PORT
  delete env.NYAN_REMOTE_STATE_DIR
  execFileSync('node', [SCRIPT], { env, encoding: 'utf8' })
  const urls = commandsOf(hooksOf(home), 'PermissionRequest')
  assert.ok(urls.some((u) => String(u).includes('127.0.0.1:8888/permission')), JSON.stringify(urls))
  assert.ok(!urls.some((u) => String(u).includes(':7777/')), '⚠️⚠️ added a hook for 7777 (approvals would be doubled)')
})

test('★★★ a machine with a custom state directory reads both port and token from the same place (codex round 24, medium #4)', (t) => {
  const home = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const other = join(home, 'elsewhere')
  mkdirSync(other)
  writeFileSync(join(other, 'config.json'), JSON.stringify({ port: 8888 }))
  writeFileSync(join(other, 'hook-token'), 'other-token\n')
  const env = { ...process.env, HOME: home, NYAN_REMOTE_STATE_DIR: other }
  delete env.NYAN_REMOTE_PORT
  execFileSync('node', [SCRIPT], { env, encoding: 'utf8' })
  const text = readFileSync(join(home, '.claude', 'settings.json'), 'utf8')
  assert.match(text, /127\.0\.0\.1:8888\/permission/)
  assert.match(text, /other-token/, '⚠️⚠️ read the token from the default location (mismatches the port = rejected by auth)')
  assert.doesNotMatch(text, /Bearer tok"/)
})
