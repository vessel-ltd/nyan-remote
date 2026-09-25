// Check whether the account has the approval hook (`PermissionRequest`) installed.
//
// ★ Why: to stop one approval from sending two notifications.
//
//   When an approval is needed, **notifications come from two paths**:
//     ① `Notification` (via notify.sh / `notification_type: user_input_required`) → "needs attention"
//     ② `PermissionRequest` (the approval hook) → "awaiting approval · Bash @MACHINE"
//
//   ② is better (**shows the tool name / jumps to the thread / disappears once answered**), so
//   if ② goes out, ① is not needed. In practice "needs attention" and "awaiting approval" appeared side by side, and after
//   answering on the PC **only ② disappeared and ① remained** (reported by the user on 2026-08-13).
//
// ⚠️ But **never stop ① unconditionally.** On a machine without the hook,
//    ① is the only notification, so stopping it means **approvals go unnoticed**.
//    → **Decide by actually checking whether it is installed** (it lives in `settings.json`, so reading tells us).
//
// ⚠️ We dropped the idea of judging by "has this machine ever seen the hook". Restarting the agent
//    forgets that, so the first one after a restart is doubled. Reading the settings is more reliable and order-independent.

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { config } from '../config.ts'

/** How often to re-read the settings. Installation is "once per machine", so it rarely changes */
const CACHE_MS = 30_000

const cache = new Map<string, { at: number; installed: boolean }>()

/** For tests */
export function resetPermissionHookCache(): void {
  cache.clear()
}

/**
 * Decide from the contents of `settings.json` whether the approval hook is installed **in a form that reaches us (this agent)**.
 * A pure function with no file I/O, so it is testable.
 *
 * ⚠️⚠️ **Match the url and the token too.** A hole pointed out in the external review on 2026-08-13:
 *   recreating `config.json` or copying another machine's settings leaves **only the Bearer stale**.
 *   Then `/permission` is rejected with 403 and no approval goes out, yet it is mistaken for "installed" and
 *   the `Notification/permission` push is stopped too, so **not a single approval notification arrives**.
 *   A hook that cannot reach us must not be counted as "installed".
 *
 * @param expect the form this agent can receive (url and the current token)
 */
export function hasPermissionHook(
  settings: unknown,
  expect: { url: string; token: string },
): boolean {
  if (!settings || typeof settings !== 'object') return false
  const hooks = (settings as Record<string, unknown>)['hooks']
  if (!hooks || typeof hooks !== 'object') return false
  const list = (hooks as Record<string, unknown>)['PermissionRequest']
  if (!Array.isArray(list)) return false
  for (const matcher of list) {
    if (!matcher || typeof matcher !== 'object') continue
    const inner = (matcher as Record<string, unknown>)['hooks']
    if (!Array.isArray(inner)) continue
    for (const h of inner) {
      if (!h || typeof h !== 'object') continue
      const o = h as Record<string, unknown>
      // ⚠️ Self-made `type: "command"` hooks do not reach the agent, so do not count them
      if (o['type'] !== 'http') continue
      if (o['url'] !== expect.url) continue
      // ⚠️ A different token is rejected with 403 = does not reach us. Do not count it as installed
      if (bearerOf(o['headers']) !== expect.token) continue
      return true
    }
  }
  return false
}

/** Extract the Bearer token from a hook's headers (tolerates case and surrounding whitespace) */
function bearerOf(headers: unknown): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() !== 'authorization' || typeof v !== 'string') continue
    return v.replace(/^Bearer\s+/i, '').trim()
  }
  return undefined
}

/**
 * @param account `.claude` / `.claude-r` … (available from the transcript path)
 * @returns true if installed. false if unreadable (= lean toward not stopping notifications)
 */
export async function isPermissionHookInstalled(account: string | undefined): Promise<boolean> {
  if (!account) return false
  const hit = cache.get(account)
  const now = Date.now()
  if (hit && now - hit.at < CACHE_MS) return hit.installed

  let installed = false
  try {
    const cfg = config()
    const text = await readFile(join(homedir(), account, 'settings.json'), 'utf8')
    installed = hasPermissionHook(JSON.parse(text), {
      url: `http://127.0.0.1:${cfg.port}/permission`,
      token: cfg.hookToken ?? '',
    })
  } catch {
    // Missing, broken, or token not set → treat as "not installed"
    // ⚠️ This side means the "needs attention" notification goes out. Safer than stopping notifications because of a hook that cannot reach us
    installed = false
  }
  cache.set(account, { at: now, installed })
  return installed
}
