#!/usr/bin/env node
// ★★ Install, stop and restart the mac service (launchd) (2026-09-23).
//
//   node scripts/launchd.mjs install --home-dir <tree> --state-dir <state> --node <absolute path to node>
//   node scripts/launchd.mjs stop      ← before an update swaps the tree
//   node scripts/launchd.mjs restart
//   node scripts/launchd.mjs status
//
// ⚠️⚠️ **Never write the config (plist) with a shell heredoc**. On 2026-09-23 install.sh hit the hole where
//    backquotes inside an unquoted heredoc **get executed**.
//    ⇒ Build it with a pure Node function (`buildPlist`) and **check the contents directly in tests**.
// ⚠️⚠️ **launchd passes only `/usr/bin:/bin:/usr/sbin:/sbin` as PATH** ⇒ Homebrew's node
//    (`/opt/homebrew/bin/node`) **is not found and the agent does not start**. ⇒ At install time
//    **pass node's absolute path** (`AGENT_NODE`, which agent-service.sh already reads).
// ⚠️ Also pass the state directory explicitly (`NYAN_REMOTE_STATE_DIR`; same reason as systemd's `Environment=` =
//    the installer and the agent must use the same location / codex round 11, medium #2).

import { execFileSync } from 'node:child_process'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hints, LAUNCHD_LABEL, launchdLogPath, launchdPlistPath } from './lib/service.mjs'
import { t } from '../shared/i18n.ts'
import { initCliLang } from './lib/lang.mjs'

/** ⚠️ Always escape characters put into XML (so `&` or `<` in a path does not break it) */
function xml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * ★ Build the launchd config (plist). **Pure function** (tests look at the contents).
 * ⚠️ Every path must be absolute (launchd cannot be relied on for a working directory or PATH).
 */
export function buildPlist({ homeDir, stateDir, node, log, home }) {
  for (const [name, v] of Object.entries({ homeDir, stateDir, node, log, home })) {
    if (typeof v !== 'string' || !isAbsolute(v)) throw new Error(t(`${name} は絶対パスで渡してください: ${v}`, `${name} must be an absolute path: ${v}`))
  }
  // ★ PATH: node's directory first. Also include claude (~/.local/bin) and Homebrew
  //   (⚠️ agent-service.sh adds them too, but it starts from launchd's minimal PATH, so both keep them)
  const path = [dirname(node), join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  const kv = (k, v) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>\n  <string>${xml(LAUNCHD_LABEL)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/bin/bash</string>',
    `    <string>${xml(join(homeDir, 'scripts', 'agent-service.sh'))}</string>`,
    '  </array>',
    `  <key>WorkingDirectory</key>\n  <string>${xml(homeDir)}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    kv('NYAN_REMOTE_STATE_DIR', stateDir),
    kv('AGENT_NODE', node),
    kv('PATH', path.join(':')),
    kv('HOME', home),
    '  </dict>',
    // ★ Start at login and restart on crash (systemd's Restart=always)
    '  <key>RunAtLoad</key>\n  <true/>',
    '  <key>KeepAlive</key>\n  <true/>',
    // ★ Restart interval (⚠️ launchd never gives up = same behavior as systemd's StartLimitIntervalSec=0)
    '  <key>ThrottleInterval</key>\n  <integer>5</integer>',
    `  <key>StandardOutPath</key>\n  <string>${xml(log)}</string>`,
    `  <key>StandardErrorPath</key>\n  <string>${xml(log)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

/**
 * ★ The `launchctl` steps to run (**pure function** = tests check order and arguments).
 * ⚠️ Use `bootstrap` / `bootout` (current syntax), not `load` / `unload` (legacy).
 */
export function launchctlSteps(action, uid, plist) {
  const target = `gui/${uid}/${LAUNCHD_LABEL}`
  switch (action) {
    // ⚠️ When reinstalling, **bootout first** (bootstrap fails if it is already loaded)
    case 'install':
      return [
        { argv: ['bootout', target], mayFail: true },
        { argv: ['bootstrap', `gui/${uid}`, plist], mayFail: false },
      ]
    // ★★★ When stopping, **confirm it is gone** (`requireGone` / codex round 15, medium #3).
    //   ⚠️ The decision lives in the step table (`main()` only runs on a real machine = tests cannot reach it there)
    case 'stop':
      return [{ argv: ['bootout', target], mayFail: true, requireGone: true }]
    case 'restart':
      return [{ argv: ['kickstart', '-k', target], mayFail: false }]
    case 'status':
      return [{ argv: ['print', target], mayFail: true }]
    default:
      throw new Error(t(`知らない操作です: ${action}`, `Unknown action: ${action}`))
  }
}

/** ★ Whether it is running, from `launchctl print` output (⚠️ read in the affirmative = does `state = running` appear) */
export function isRunning(printed) {
  return /^\s*state = running\s*$/m.test(printed)
}

/** ★ pid of the running process (undefined if none) */
export function runningPid(printed) {
  if (!isRunning(printed)) return undefined
  const m = /^\s*pid = (\d+)\s*$/m.exec(printed)
  return m ? Number(m[1]) : undefined
}

/**
 * ★★ Can we say it "keeps running"?
 * ⚠️⚠️ One `state = running` is not enough: it restarts on every crash (KeepAlive), so
 *    **an agent that dies right after start also looks running for a moment** (e.g. an old `npm start` holds the port).
 *    ⇒ Only call it "running" when **the same pid is running twice, some time apart**.
 */
export function staysRunning(first, second) {
  const a = runningPid(first)
  return a !== undefined && a === runningPid(second)
}

/**
 * ★★ Run the steps (2026-09-23 / `Bootstrap failed: 5: Input/output error` on a real mac).
 *
 * ⚠️⚠️ **`bootout` returns without waiting for removal to finish**. Calling `bootstrap` before the old agent has fully exited
 *    is refused with 5 (updates do "stop → swap tree → reinstall" quickly, so **it always hits**).
 *    ⇒ ① after `bootout`, **wait until `print` fails (= gone)**
 *       ② if `bootstrap` is still refused, **retry a few times with a pause** (for when waiting was not enough).
 * ★ How to run and how to sleep are injected (launchd cannot be tried on Linux = tests check order and counts).
 * @returns output of the last step (for status)
 */
export async function runSteps(steps, { run, sleep, target, goneTries = 20, bootstrapTries = 5 }) {
  let out = ''
  for (const step of steps) {
    const verb = step.argv[0]
    const tries = verb === 'bootstrap' ? bootstrapTries : 1
    let lastErr
    for (let i = 0; i < tries; i++) {
      try {
        out = run(step.argv)
        lastErr = undefined
        break
      } catch (err) {
        lastErr = err
        if (i < tries - 1) await sleep(1000)
      }
    }
    if (lastErr && !step.mayFail) {
      throw new Error(`launchctl ${step.argv.join(' ')}: ${(lastErr.stderr || lastErr.message || '').toString().trim()}`)
    }
    if (verb === 'bootout') {
      // ⚠️ Wait until it is gone (print fails = not loaded)
      let gone = false
      for (let i = 0; i < goneTries; i++) {
        try {
          run(['print', target])
        } catch {
          gone = true
          break
        }
        await sleep(500)
      }
      // ★★★ **When stopping (stop), return only after confirming it is gone** (codex round 15, medium #3).
      //   ⚠️⚠️ It used to return normally even if waiting ran out, so the update path **swapped the tree while the old agent was still running**.
      //   ⚠️ "Never there" (print fails immediately) is success (first move from no service to launchd).
      //   ★ Reinstall (install) does not throw ⇒ the bootstrap retries after it pick it up, and throw with a reason if that fails.
      if (!gone && step.requireGone) {
        throw new Error(t(`launchctl bootout ${target}: 止まりきりませんでした（${(goneTries * 500) / 1000} 秒待ちました）`, `launchctl bootout ${target}: did not stop (waited ${(goneTries * 500) / 1000} seconds)`))
      }
    }
  }
  return out
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}

function launchctl(argv) {
  return execFileSync('launchctl', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

async function main() {
  initCliLang()
  const action = process.argv[2]
  if (process.platform !== 'darwin') {
    console.error(t('✗ launchd は mac だけです', '✗ launchd is only available on macOS'))
    process.exit(2)
  }
  const home = homedir()
  const uid = process.getuid()
  const plist = launchdPlistPath(home)
  const h = hints('launchd')

  if (action === 'install') {
    const homeDir = arg('home-dir')
    const stateDir = arg('state-dir')
    const node = arg('node')
    const log = launchdLogPath(home)
    const body = buildPlist({ homeDir: homeDir && resolve(homeDir), stateDir, node, log, home })
    mkdirSync(dirname(plist), { recursive: true })
    mkdirSync(dirname(log), { recursive: true })
    // ⚠️ Temp file → rename (never let launchd read a half-written file / §5)
    const tmp = `${plist}.${process.pid}.tmp`
    writeFileSync(tmp, body, { mode: 0o644 })
    // ★ Check not "it was written" but **"the reader can accept its shape"** (CLAUDE.md "check config files from the reader's side")
    try {
      launchctlPlutil(tmp)
    } catch (err) {
      console.error(t(`✗ 設定ファイルの形が不正です（plutil -lint）: ${err.message}`, `✗ The plist is malformed (plutil -lint): ${err.message}`))
      process.exit(1)
    }
    renameSync(tmp, plist)
  }

  try {
    const out = await runSteps(launchctlSteps(action, uid, plist), {
      run: launchctl,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      target: `gui/${uid}/${LAUNCHD_LABEL}`,
    })
    if (action === 'status') process.stdout.write(out)
  } catch (err) {
    console.error(`✗ ${err.message}`)
    process.exit(1)
  }

  if (action === 'install' || action === 'restart') {
    // ★★ **Confirm it started, in the affirmative** (the same pid running 2 seconds apart)
    //   ⚠️ Never treat "no error appeared" as success (CLAUDE.md "never hand people a check where invisible reads as normal")
    const print = () => {
      try {
        return launchctl(['print', `gui/${uid}/${LAUNCHD_LABEL}`])
      } catch {
        return ''
      }
    }
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    for (let i = 0; i < 10; i++) {
      const first = print()
      await sleep(2000)
      if (staysRunning(first, print())) {
        console.log(t(`✔ 常駐させました（launchd: ${LAUNCHD_LABEL}）`, `✔ Running as a background service (launchd: ${LAUNCHD_LABEL})`))
        console.log(t(`  ログ: ${launchdLogPath(home)}`, `  Log: ${launchdLogPath(home)}`))
        return
      }
    }
    console.error(t('✗ launchd に登録しましたが、動き続けていることを確かめられませんでした', '✗ Registered with launchd, but could not confirm that it keeps running'))
    // ⚠️ Name the most likely cause (an agent started without the service is still around)
    console.error(t('  ⚠️ npm start で起こした agent が別のタブに残っていたら、Ctrl-C で止めてください（ポートを握っています）', '  ⚠️ If an agent started with npm start is still running in another tab, stop it with Ctrl-C (it holds the port)'))
    console.error(t(`  ログを見てください: ${h.logs}`, `  Check the log: ${h.logs}`))
    process.exit(1)
  }
}

/** ⚠️ `plutil` always exists on mac (if missing, it is not mac). Check the shape only */
function launchctlPlutil(path) {
  execFileSync('plutil', ['-lint', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main()
}
