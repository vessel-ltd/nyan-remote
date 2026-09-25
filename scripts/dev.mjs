#!/usr/bin/env node
// Dev loop: build web with --watch and start the agent with --watch.
//
// We use build --watch + static serving instead of HMR. tailscale serve points only at 7777, and
// proxying Vite's HMR WebSocket through the agent adds complexity.
// Reload on the phone to get the new build (the dev loop in ARCHITECTURE.md §14.5).
//
// No `concurrently`, to avoid adding dependencies.

import { spawn } from 'node:child_process'
import { unlinkSync, writeFileSync } from 'node:fs'
import { t } from '../shared/i18n.ts'
import { initCliLang } from './lib/lang.mjs'

// ★ Language first (before any message is built)
initCliLang()

// ⚠️ Why a PID file:
//    stopping with `pkill -f dev.mjs` also kills your own shell, whose command line contains
//    'dev.mjs' (hit this 3 times). Use `npm run dev:stop`.
const PID_FILE = new URL('../.dev.pid', import.meta.url).pathname

/** @type {{name: string, child: import('node:child_process').ChildProcess}[]} */
const running = []
let shuttingDown = false

function start(name, cmd, args) {
  const child = spawn(cmd, args, { stdio: 'inherit', env: process.env })
  running.push({ name, child })
  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    console.error(t(`\n[dev] ${name} が終了しました (code=${code} signal=${signal})`, `\n[dev] ${name} exited (code=${code} signal=${signal})`))
    shutdown(code ?? 1)
  })
  child.on('error', (err) => {
    console.error(t(`[dev] ${name} を起動できません:`, `[dev] Cannot start ${name}:`), err.message)
    shutdown(1)
  })
  return child
}

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  for (const { child } of running) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
  try {
    unlinkSync(PID_FILE)
  } catch {
    // fine if it's already gone
  }
  setTimeout(() => process.exit(code), 200)
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(0))

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

writeFileSync(PID_FILE, `${process.pid}\n`)

console.log(t(`[dev] pid=${process.pid}（停止は npm run dev:stop）`, `[dev] pid=${process.pid} (stop with npm run dev:stop)`))
console.log('[dev] web: vite build --watch / agent: node --watch (127.0.0.1:7777)')
if (!process.env.NYAN_REMOTE_DEV) {
  console.log(t('[dev] ヒント: NYAN_REMOTE_DEV=1 を付けると身元ヘッダ無しの curl を許可します', '[dev] Hint: NYAN_REMOTE_DEV=1 allows curl without identity headers'))
}

start('web', npm, ['run', 'dev', '--workspace', 'web'])
start('agent', process.execPath, ['--watch', 'agent/src/index.ts'])
