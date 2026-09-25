#!/usr/bin/env node
// Stop npm run dev.
//
// ⚠️ Do not use `pkill -f dev.mjs`. It also kills your own shell, whose command line
//    contains 'dev.mjs' (hit this 3 times).

import { readFileSync, unlinkSync } from 'node:fs'
import { t } from '../shared/i18n.ts'
import { initCliLang } from './lib/lang.mjs'

// ★ Language first (before any message is built)
initCliLang()

const PID_FILE = new URL('../.dev.pid', import.meta.url).pathname

let pid
try {
  pid = Number(readFileSync(PID_FILE, 'utf8').trim())
} catch {
  console.log(t('[dev:stop] .dev.pid がありません（既に止まっています）', '[dev:stop] No .dev.pid (already stopped)'))
  process.exit(0)
}

if (!Number.isInteger(pid) || pid <= 1) {
  console.error(t(`[dev:stop] PIDファイルの内容が不正です: ${pid}`, `[dev:stop] Invalid PID file content: ${pid}`))
  process.exit(1)
}

try {
  process.kill(pid, 'SIGTERM')
  console.log(t(`[dev:stop] pid=${pid} に SIGTERM を送りました`, `[dev:stop] Sent SIGTERM to pid=${pid}`))
} catch (err) {
  if (err.code === 'ESRCH') {
    console.log(t(`[dev:stop] pid=${pid} は既に居ません`, `[dev:stop] pid=${pid} is already gone`))
  } else {
    console.error(`[dev:stop] ${err.message}`)
    process.exit(1)
  }
}

try {
  unlinkSync(PID_FILE)
} catch {
  // fine as long as dev.mjs removed it
}
