// Clean up notifications left in the tray.
//
// ⚠️ Notifications **don't disappear once shown**. If the notification for an answered approval remains,
//   it reads as "I pressed it, is it still waiting?" (this actually caused confusion on 2026-08-13).
//
// ⚠️ Worse, **the URL embedded in a notification is fixed when it is created**.
//   If an old notification carries a broken URL, fixing it later still leaves **that tap broken**.
//   We actually reproduced "tapping the notification shows sw.js source" with an old notification after the fix.
//   → The right thing is to **remove notifications once they have served their purpose**.

import { permissionTag } from '../../shared/types.ts'

/**
 * ★★ **Look at every registration** (2026-09-21 / codex round 12, medium #5).
 *
 * ⚠️⚠️ Originally only `navigator.serviceWorker.ready` (= **the registration controlling this page**)
 *    was checked. On 2026-09-21 notifications moved to **per-agent scopes** (`/push/<id>/`), so
 *    **none of the notifications shown there were found, and answered approvals stopped being cleared**.
 * ⚠️ `ready` **never resolves** without a controller, so don't use it here either.
 */
async function registrations(): Promise<readonly ServiceWorkerRegistration[]> {
  if (!('serviceWorker' in navigator)) return []
  try {
    return await navigator.serviceWorker.getRegistrations()
  } catch {
    return []
  }
}

/** Remove the notification for that approval (call right after answering) */
export async function closePermissionNotification(machine: string, key: string): Promise<void> {
  const tag = permissionTag(machine, key)
  for (const reg of await registrations()) {
    if (!reg.getNotifications) continue
    try {
      for (const n of await reg.getNotifications({ tag })) n.close()
    } catch {
      // Not fatal if it can't be closed (the next cleanup picks it up)
    }
  }
}

/**
 * Remove notifications for approvals that are no longer pending.
 *
 * On timeout or when answered first on the PC, **we didn't press it**, so
 * this is called to clean up after refetching the list.
 *
 * ⚠️⚠️ **Never treat "unknown" as "resolved"** (external review on 2026-08-13).
 *   Previously all notifications starting with `perm-` were checked and closed if not in `activeTags`. As a result:
 *
 *     ① When fetching `/permissions` failed transiently (`.catch(() => [])`) it read as 0 items
 *        and **closed notifications for live approvals**
 *     ② With two machines where B was disconnected and only A alive, **B's notifications were closed too**
 *
 * ⚠️⚠️ The codex review on 2026-08-20 (high #2, high #4) added two more:
 *
 *     ③ **Don't close notifications newer than the list.** The list is a snapshot, so approvals
 *        raised between fetching and the screen updating look "absent". Closing them **removes the only
 *        signal for that approval** (the CLI keeps waiting for 86400 seconds). Compare **agent clocks with each other**
 *        (both the notification `timestamp` and `/permissions` `at` are set by the agent).
 *     ④ **Leave notifications with an unknown owner alone.** In the tag (`perm-<machine>-<key>`) both machine
 *        and key may contain `-`, so it **cannot be split**. Falling back to prefix match, a successful fetch for `pc-b`
 *        alone would **close live notifications of the disconnected `pc-b-wsl`**.
 *        ⇒ Notifications shown before this fix (no `data.machine`) are **kept** (a stale one remains, but
 *        tapping it only returns "no longer valid", so it can't cause a wrong action).
 */
/** Just the parts of one notification needed for the cleanup decision */
export interface NotificationFacts {
  tag: string
  /** The agent that showed the notification (`data.machine`). If absent, **leave it alone** */
  machine?: string
  /** Time set by the agent (epoch ms) */
  timestamp?: number
}

/**
 * ★ Decide which tags may be closed (**pure function**; the decision lives only here).
 *
 * @param snapshotAt machine name → time that list was taken (epoch ms).
 *   Include **only machines whose fetch succeeded** (notifications of machines not included are left alone)
 */
export function staleAppTags(
  shown: NotificationFacts[],
  activeTags: Set<string>,
  snapshotAt: Map<string, number>,
): string[] {
  const out: string[] = []
  for (const n of shown) {
    if (!n.tag.startsWith('perm-')) continue // leave done / stopped notifications alone
    if (activeTags.has(n.tag)) continue
    if (typeof n.machine !== 'string') continue // ④ owner unknown
    const at = snapshotAt.get(n.machine)
    if (at === undefined) continue // we don't know that machine's state
    if (typeof n.timestamp !== 'number' || Number.isNaN(n.timestamp)) continue
    if (n.timestamp >= at) continue // ③ newer than the list
    out.push(n.tag)
  }
  return out
}

/**
 * @param activeTags tags of approvals actually pending now (**superset**; the agent's `pendingTags`)
 * @param snapshotAt machine name → time the list was taken (only machines whose fetch succeeded)
 */
export async function closeStalePermissionNotifications(
  activeTags: Set<string>,
  snapshotAt: Map<string, number>,
): Promise<void> {
  if (snapshotAt.size === 0) return
  // ⚠️⚠️ **Decide per registration** (2026-09-21 / codex medium #5). Notifications appear in per-agent scopes,
  //    so looking at a single registration **finds none of the notifications shown there**.
  for (const reg of await registrations()) {
    if (!reg.getNotifications) continue
    try {
      const list = await reg.getNotifications()
      if (list.length === 0) continue
      const stale = new Set(
        staleAppTags(
          list.map((n) => ({
            tag: n.tag,
            machine: (n.data as { machine?: unknown } | undefined)?.machine as string | undefined,
            // ⚠️ `timestamp` is in the spec but not in TS's DOM types, so make it explicit here
            timestamp: (n as Notification & { timestamp?: number }).timestamp,
          })),
          activeTags,
          snapshotAt,
        ),
      )
      for (const n of list) if (stale.has(n.tag)) n.close()
    } catch {
      // Same as above (skip just that registration)
    }
  }
}
