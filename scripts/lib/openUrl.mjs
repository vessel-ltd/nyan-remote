// ★ Open a URL in the browser (2026-09-24 / `nyan login`). ⚠️ Never throws if it cannot open (the URL is also printed).
//   Same approach as the QR image (`imageOpeners` in `qrMode.mjs`): mac uses `open`, WSL uses Windows explorer.exe, Linux uses xdg-open.
//   ⚠️ `NYAN_REMOTE_NO_OPEN=1` disables opening (so tests don't open a real browser every run).
import { spawn } from 'node:child_process'
import { isWsl } from './qrMode.mjs'

export function urlOpeners({ platform, env, url }) {
  if (!/^https:\/\//.test(url)) return []
  if (platform === 'darwin') return [['open', [url]]]
  // ⚠️ Full path (some machines have `appendWindowsPath=false` / CLAUDE.md §4)
  if (platform === 'linux' && isWsl(env)) return [['/mnt/c/Windows/explorer.exe', [url]]]
  if (platform === 'linux' && (env.DISPLAY || env.WAYLAND_DISPLAY)) return [['xdg-open', [url]]]
  return []
}

export function openUrl(url, env = process.env, platform = process.platform) {
  if (env.NYAN_REMOTE_NO_OPEN === '1') return
  for (const [cmd, args] of urlOpeners({ platform, env, url })) {
    try {
      // ⚠️ Don't wait and don't look at the result (explorer.exe exits 1 even on success)
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
      child.on('error', () => undefined)
      child.unref()
      return
    } catch {
      // try the next one
    }
  }
}
