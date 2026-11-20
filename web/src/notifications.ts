// Clean up notifications left in the tray.
//
// ⚠️ Notifications **don't disappear once shown**. If the notification for an answered approval remains,
//   it reads as "I pressed it, is it still waiting?" (this actually caused confusion on 2026-08-13).
//
// ⚠️ Worse, **the URL embedded in a notification is fixed when it is created**.
//   If an old notification carries a broken URL, fixing it later still leaves **that tap broken**.
//   We actually reproduced "tapping the notification shows sw.js source" with an old notification after the fix.
//   → The right thing is to **remove notifications once they have served their purpose**.

import { permissionTag, sessionTag } from '../../shared/types.ts'

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
/**
 * ★ Close a session's notification (`sessionTag`). Used after denying an agy card from the phone: that stops agy's
 *   turn, and no later notification replaces the "needs you" one (codex review 2026-11-20).
 */
export async function closeSessionNotification(machine: string, account: string, sessionId: string, shownBefore: number): Promise<void> {
  // ⚠️ Only one shown before the deny took effect (a newer turn's "needs you" may have arrived meanwhile / codex review)
  await closeTag(sessionTag(machine, account, sessionId), (n) => shownBeforeAnswer(n, shownBefore))
}

/**
 * ★ Whether a notification was shown before an answer took effect at `tookEffect` (both the agent's clock).
 * The sender's time is `data.at` (our service worker puts it there; WebKit has no `timestamp`), else `timestamp`
 * (in the spec but not in TS's DOM types). Neither ⇒ false (not closed).
 * ★ 0.5 s of margin: a push that started right after the key went out, before agy rewrote its state (measured 13–48
 *   ms), is older news too. A newer turn's alert cannot come that soon (a new prompt, then the model).
 */
export function shownBeforeAnswer(n: { data?: unknown; timestamp?: number }, tookEffect: number): boolean {
  // ⚠️ Only a "needs you" (an earlier error or "done" under the same tag stays / codex review)
  if ((n.data as { waiting?: unknown } | null | undefined)?.waiting !== true) return false
  const fromData = (n.data as { at?: unknown } | null | undefined)?.at
  const at = typeof fromData === 'number' ? fromData : n.timestamp
  return typeof at === 'number' && Number.isFinite(at) && at <= tookEffect + 500
}

export async function closePermissionNotification(machine: string, key: string): Promise<void> {
  await closeTag(permissionTag(machine, key))
}

async function closeTag(tag: string, which: (n: Notification) => boolean = () => true): Promise<void> {
  for (const reg of await registrations()) {
    if (!reg.getNotifications) continue
    try {
      for (const n of await reg.getNotifications({ tag })) if (which(n)) n.close()
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

/** Just the parts of a shown notification the "needs you" cleanup needs */
export interface WaitingFacts {
  tag: string
  machine?: string
  session?: string
  waiting?: boolean
  /** The sender's time (`data.at`, else `timestamp`) */
  at?: number
}

/**
 * ★ Which "needs you" notifications are over (2026-11-20 / agy rows): the session's row, in a list its machine took
 * at least 2 s after the notification, is not waiting. Covers a card answered on the PC, a phone deny, and a push
 * delivered late. ⚠️ Only what is known: the machine's list was read, the row is in it, both times are the agent's.
 * @param rows machine → session id → its status, only for machines whose list was read
 * @param snapshotAt machine → when that list was taken (agent clock)
 */
export function staleWaitingTags(
  shown: WaitingFacts[],
  rows: Map<string, Map<string, string>>,
  snapshotAt: Map<string, number>,
  goneWhenMissing: (session: string) => boolean = () => false,
): string[] {
  return shown.filter((n) => isStaleWaiting(n, rows, snapshotAt, goneWhenMissing)).map((n) => n.tag)
}

/**
 * ★ Whether this one notification is over. ⚠️ Judged per notification and closed one by one: a tray can hold an older
 * "done" and a live "needs you" under the same tag, and closing by tag took the live one too (codex review).
 * @param goneWhenMissing sessions whose absence from a read list means they are over (agy: a running agy's waiting
 *   conversation is always listed, so a missing one has exited / moved on). Others: absent = unknown, left.
 */
export function isStaleWaiting(
  n: WaitingFacts,
  rows: Map<string, Map<string, string>>,
  snapshotAt: Map<string, number>,
  goneWhenMissing: (session: string) => boolean = () => false,
): boolean {
  if (!n.machine || !n.session || typeof n.at !== 'number' || !Number.isFinite(n.at)) return false
  const taken = snapshotAt.get(n.machine)
  const list = rows.get(n.machine)
  if (taken === undefined || !list || n.at > taken - 2000) return false
  const status = list.get(n.session) ?? (goneWhenMissing(n.session) ? 'gone' : undefined)
  // ⚠️ Open in two agys (`main.tsx` marks it): which state is that conversation's cannot be told ⇒ nothing closed
  if (status === undefined || status === 'contested') return false
  // a "needs you" that no longer waits; ★ or an older "done"/"error" while it waits again (a late delivery of an
  // earlier turn's alert after a newer card's was opened — on Android the newer one replaces it anyway)
  return n.waiting ? status !== 'waiting' : status === 'waiting'
}

export async function closeStaleWaitingNotifications(rows: Map<string, Map<string, string>>, snapshotAt: Map<string, number>): Promise<void> {
  if (snapshotAt.size === 0) return
  for (const reg of await registrations()) {
    if (!reg.getNotifications) continue
    try {
      const list = await reg.getNotifications()
      const facts = list.map((n): WaitingFacts => {
        const d = (n.data ?? {}) as { machine?: unknown; session?: unknown; waiting?: unknown; at?: unknown }
        const ts = (n as Notification & { timestamp?: number }).timestamp
        return {
          tag: n.tag,
          ...(typeof d.machine === 'string' ? { machine: d.machine } : {}),
          ...(typeof d.session === 'string' ? { session: d.session } : {}),
          ...(d.waiting === true ? { waiting: true } : {}),
          ...(typeof d.at === 'number' ? { at: d.at } : typeof ts === 'number' ? { at: ts } : {}),
        }
      })
      list.forEach((n, i) => {
        if (isStaleWaiting(facts[i]!, rows, snapshotAt, (session) => session.startsWith('agy-'))) n.close()
      })
    } catch {
      // skip just that registration
    }
  }
}
