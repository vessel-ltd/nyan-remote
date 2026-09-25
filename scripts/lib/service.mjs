// ★★ **How the agent is kept running** and the matching **instructions and log reading** (2026-09-23).
//
// ⚠️⚠️ Why one place: during the mac trial we fixed "instructions that cannot run on mac" (systemctl / journalctl)
//   **3 times in one day, in different places** (pair.mjs, devices.mjs, install.sh). Scattered, the
//   **next place we add repeats the mistake**. ⇒ The wording per service type lives **only here**.
//
// There are 3 service types:
//   systemd … Linux（`nyan-remote.service`）
//   launchd … running as a service on mac (`~/Library/LaunchAgents/app.nyan-remote.agent.plist` exists)
//   none    … not a service on mac (you start `npm start` yourself)

import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { t } from '../../shared/i18n.ts'

/** ★ launchd label (reverse domain. ⚠️ changing it loses track of installed services) */
export const LAUNCHD_LABEL = 'app.nyan-remote.agent'

export function launchdPlistPath(home) {
  return join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
}

/** ★ Agent log on mac (⚠️ no journalctl, so launchd writes it) */
export function launchdLogPath(home) {
  return join(home, 'Library', 'Logs', 'nyan-remote', 'agent.log')
}

/** ★ How the agent is kept running on this machine right now */
export function serviceKind(platform, home, exists = existsSync) {
  if (platform === 'darwin') return exists(launchdPlistPath(home)) ? 'launchd' : 'none'
  return 'systemd'
}

/**
 * ★ Instructions per service type (⚠️ **never print instructions that cannot run**).
 * @returns how to start it, how to check it is running, how to see the logs (each **a single line to paste**)
 */
export function hints(kind) {
  switch (kind) {
    case 'launchd':
      return {
        start: `launchctl kickstart -k gui/$(id -u)/${LAUNCHD_LABEL}`,
        status: `launchctl print gui/$(id -u)/${LAUNCHD_LABEL} | grep -E 'state|pid'`,
        logs: 'tail -n 30 ~/Library/Logs/nyan-remote/agent.log',
      }
    case 'none':
      return {
        start: 'cd ~/nyan-remote && npm start',
        status: t('（常駐させていません。npm start を動かしているタブを見てください）', '(no background service; look at the tab running npm start)'),
        logs: t('npm start を動かしているタブ', 'the tab running npm start'),
      }
    default:
      return {
        start: 'systemctl --user start nyan-remote',
        status: 'systemctl --user is-active nyan-remote',
        logs: 'journalctl --user -u nyan-remote -n 30',
      }
  }
}

/**
 * ★ Read recent logs (for "which route did the last send use" in `npm run keys`).
 * ⚠️ Empty if unreadable (do not stop the diagnosis). ⚠️ `none` only prints to the tab, so it cannot be read.
 */
export function recentLogLines(kind, home) {
  try {
    if (kind === 'systemd') {
      return execFileSync('journalctl', ['--user', '-u', 'nyan-remote', '-n', '200', '--no-pager', '-o', 'cat'], {
        encoding: 'utf8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).split('\n')
    }
    if (kind === 'launchd') return tailLines(launchdLogPath(home), 64 * 1024)
  } catch {
    // ⚠️ Unreadable = say nothing (do not treat absence as evidence)
  }
  return []
}

/** ⚠️ Logs keep growing, so read **only the tail** (never the whole file) */
function tailLines(path, bytes) {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const len = Math.min(size, bytes)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    const lines = buf.toString('utf8').split('\n')
    // ⚠️ We started mid-file, so the first line is partial (drop it)
    return size > len ? lines.slice(1) : lines
  } finally {
    closeSync(fd)
  }
}
