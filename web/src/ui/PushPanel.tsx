import { useEffect, useState } from 'preact/hooks'
import type { PushFailure } from '../../../shared/types.ts'
import { hhmm } from '../time.ts'
import { t } from '../../../shared/i18n.ts'
import { toBase64Url } from '../../../shared/crypto.ts'
import { endpointTag } from '../../../shared/pushTag.ts'
import type { Transport } from '../transport/index.ts'
import { executePlan, makeSerializer, stopAll, type LockManagerLike, type PushDeps, type PushTarget } from './pushExec.ts'
import { planPush, registeredFor, scopeFor } from './pushScopes.ts'
import { bannerText, pushKind, showsBanner, type PushKind } from './pushState.ts'

/**
 * Notification permission and subscriptions.
 *
 * ★ Subscriptions are registered with "every agent". Each machine sends only its own events, so
 *   registering with just one means no notifications from the others (ARCHITECTURE.md §6.3 / §6.4).
 */
// ─────────────────────────────────────────────────────────────────────────────
// ★★ Subscriptions are held in **a scope per agent** (2026-09-21 / HANDOFF 5.0-bt)
//
// ⚠️⚠️ **Never use `navigator.serviceWorker.ready`.** It waits for
//   "**the registration controlling this page**", so with no controller it **never returns**
//   (the screen froze on a real iOS device on 2026-09-21; on Android it disguised itself as "fails only the first time").
//   ⇒ What to wait for is **that registration's worker becoming `activated`**. ⚠️ Always add a timeout too.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ★★ **Remember that the user "stopped" it** (2026-09-21 / codex round 12, high #1).
 *
 * ⚠️⚠️ Without remembering, `syncSubscription` **resubscribes on its own** just because "permission remains"
 *    ⇒ stop → open a thread and return to the list, and **notifications come back** (not even a restart needed).
 * ⚠️ Stored in localStorage (like display settings = a per-device intention. §7.3).
 * ⚠️ The name uses **the same namespace** as other browser-side keys (`tmux-agent.*` / CLAUDE.md §0).
 */
const OFF_KEY = 'tmux-agent.pushOff.v1'
function pushOff(): boolean {
  try {
    return localStorage.getItem(OFF_KEY) === '1'
  } catch {
    return false // ⚠️ unreadable means "not stopped" (do not err towards silence)
  }
}
function setPushOff(off: boolean): void {
  try {
    if (off) localStorage.setItem(OFF_KEY, '1')
    else localStorage.removeItem(OFF_KEY)
  } catch {
    // ⚠️ Continue even if it cannot be saved (accept that it may come back on next open)
  }
}

/**
 * ★★ Subscription sync runs **one at a time** (2026-09-21 / codex round 12, medium #4).
 *
 * ⚠️⚠️ Many `await`s intervene between planning and executing, so running concurrently means
 *    **one run unsubscribes the subscription the other created**. ⚠️ Concurrency across tabs cannot be prevented here
 *    (the agent side converges with last-write-wins).
 */
// ★★ **Serialise into one line across tabs** (codex round 13, high #2 / `makeSerializer` in `pushExec.ts`)
const serialize = makeSerializer(
  typeof navigator !== 'undefined' ? (navigator as { locks?: LockManagerLike }).locks : undefined,
)

/** ★ Ask every registration to "fetch a new version if there is one" (⚠️ never throws, never waits too long) */
async function refreshWorkers(): Promise<void> {
  try {
    const regs = await navigator.serviceWorker.getRegistrations()
    await Promise.all(regs.map((r) => r.update().catch(() => undefined)))
  } catch {
    // Registrations unreadable = update next time
  }
}

/** Wait until that registration's worker is usable (⚠️ with a timeout; never create a path that does not return) */
function waitActive(reg: ServiceWorkerRegistration, ms: number): Promise<boolean> {
  if (reg.active) return Promise.resolve(true)
  const sw = reg.installing ?? reg.waiting
  if (!sw) return Promise.resolve(false)
  return new Promise((res) => {
    // ⚠️ A timeout returns **false** (do not proceed as a success / codex medium #6)
    const t = setTimeout(() => res(false), ms)
    const f = () => {
      if (sw.state === 'activated') {
        clearTimeout(t)
        sw.removeEventListener('statechange', f)
        res(true)
      }
    }
    sw.addEventListener('statechange', f)
    f()
  })
}

/** Subscriptions currently in the browser (⚠️ **for this scope**; also picks up old root subscriptions) */
/** ★ The endpoint tag of that endpoint's scope subscription (`undefined` if there is no subscription) */
async function tagFor(
  have: readonly { scope: string; sub: PushSubscription | null }[],
  endpointId: string,
): Promise<string | undefined> {
  const sub = have.find((h) => h.scope === scopeFor(endpointId))?.sub
  return sub ? endpointTag(sub.endpoint) : undefined
}

async function listSubs(): Promise<{ scope: string; publicKey: string | undefined; sub: PushSubscription | null }[]> {
  const out: { scope: string; publicKey: string | undefined; sub: PushSubscription | null }[] = []
  for (const r of await navigator.serviceWorker.getRegistrations()) {
    const sub = await r.pushManager.getSubscription()
    if (!sub) continue
    const raw = sub.options.applicationServerKey
    out.push({
      scope: new URL(r.scope).pathname,
      publicKey: raw ? toBase64Url(new Uint8Array(raw)) : undefined,
      sub,
    })
  }
  return out
}

/** ★ Summary passed to the header badge (2026-09-24) */
export interface PushSummary {
  kind: PushKind
  registered: number
  total: number
}

/**
 * ★★ The presentation changes by placement (2026-09-24 / user decision).
 * - `list`: **show nothing when healthy**. Only states needing action (unset, blocked, failing) get a one-line banner (`pushState.ts`).
 * - `settings`: always show everything (test and stop live here too).
 * ⚠️⚠️ **Subscription sync runs in both placements** (hiding the display does not remove the component = sync does not stop in the list).
 */
export function PushPanel({
  transports,
  mode,
  onOpenSettings,
  onSummary,
}: {
  transports: Transport[]
  mode: 'list' | 'settings'
  /** ★ The banner's "Fix →" (list only) */
  onOpenSettings?: () => void
  /** ★ Summary for the header badge (list only) */
  onSummary?: (s: PushSummary) => void
}) {
  const supported =
    typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    supported ? Notification.permission : 'unsupported',
  )
  const [registered, setRegistered] = useState(0)
  const [devices, setDevices] = useState(0)
  /**
   * ★★ **Show "subscribed but no notifications arrive"** (2026-08-21).
   *
   * ⚠️ A 403 does not delete the subscription, so the screen stays "enabled" and **only the notifications stop**.
   *    In reality 171 sends to an iPhone failed over 3 days without anyone noticing (caused by the VAPID subject).
   */
  const [failure, setFailure] = useState<PushFailure>()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string>()
  /** ★ Why registration failed on the last sync (⚠️ separate from the notice `msg` = the failure is what drives the list banner / `pushState.ts`) */
  const [syncProblem, setSyncProblem] = useState<string>()
  /**
   * Awaiting confirmation right before pressing "Stop".
   *
   * ⚠️ The row was folded into one line with a small button, so the cost of a mis-tap must be lowered.
   *    Stop calls `sub.unsubscribe()` = **stops all notifications**, and
   *    recovering from that state took half an hour on 2026-08-12. **It takes two taps.**
   */
  const [confirmOff, setConfirmOff] = useState(false)

  const refresh = async () => {
    let ok = 0
    let count = 0
    let worst: PushFailure | undefined
    // ⚠️ Keep displaying even if unreadable (better to show it without knowing than to lose the notification row)
    const have = await listSubs().catch(() => [])
    await Promise.all(
      transports.map(async (t) => {
        try {
          const st = await t.pushStatus()
          // ★ **The same decision** as sync (not written in two places / codex round 13, high #3).
          //   ⚠️ Only old agents (returning no tags) are counted by the old `subscribed` (display does not get worse)
          if (registeredFor(st, await tagFor(have, t.endpoint.id)) ?? st.subscribed) ok++
          count = Math.max(count, st.deviceCount)
          // ★ Show a failure if any machine failed (take the newer one)
          if (st.lastFailure && (!worst || st.lastFailure.at > worst.at)) worst = st.lastFailure
        } catch {
          // That machine is just down. Ignore it
        }
      }),
    )
    setRegistered(ok)
    setDevices(count)
    setFailure(worst)
  }

  /**
   * ★★ **Subscribe per agent, with that agent's key** (2026-09-21).
   *
   * ⚠️⚠️ Previously "one subscription per device distributed to every agent", which required **every agent to have
   *    the same `vapid.json`** (each new machine meant **copying the private key by hand**; forget it and nothing arrives, silently).
   *    ⇒ We measured that subscriptions can be held **per scope**, so **the shared secret is gone**.
   * ⚠️ The decision is `planPush` in `pushScopes.ts`, one place (endpoints that are down are left alone / fail-closed).
   * ⚠️ Safe to call any number of times (creates only what is needed, discards only what is not).
   */
  /** ★ Endpoints passed to `pushExec.ts` (⚠️ only the needed part of `Transport`) */
  const targets = (): PushTarget[] =>
    transports.map((t) => ({
      id: t.endpoint.id,
      label: t.endpoint.label,
      registerPush: (sub) => t.registerPush(sub as Parameters<typeof t.registerPush>[0]),
      unregisterPush: (endpoint) => t.unregisterPush(endpoint),
    }))

  /** ★ Only the browser-dependent part (decisions live in `pushExec.ts`) */
  const pushDeps: PushDeps = {
    subscribe: async (scope, publicKey) => {
      const reg = await navigator.serviceWorker.register('/push-sw.js', { scope })
      // ⚠️⚠️ Do not use `navigator.serviceWorker.ready` (never returns without a controller)
      if (!(await waitActive(reg, 8000))) throw new Error(t('Service Worker が有効になりません', 'Service Worker did not activate'))
      const old = await reg.pushManager.getSubscription()
      if (old) await old.unsubscribe().catch(() => {})
      return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) })
    },
    unregisterScope: async (scope) => {
      const reg = await navigator.serviceWorker.getRegistration(scope)
      if (reg && new URL(reg.scope).pathname === scope) await reg.unregister().catch(() => {})
    },
    stopped: () => pushOff(),
  }

  const syncSubscription = (): Promise<void> =>
    serialize(async () => {
      // ⚠️⚠️ **Do nothing if the user stopped it** (do not revive just because permission remains / high #1)
      if (!supported || Notification.permission !== 'granted' || pushOff()) return
      const problems: string[] = []
      try {
        // ★ Look at local subscriptions **first** (to judge "has it arrived" by the endpoint tag of that scope)
        const have = await listSubs()
        const agents = await Promise.all(
          transports.map(async (t) => {
            try {
              const st = await t.pushStatus()
              // ⚠️⚠️ Do not use `st.subscribed` ("any one at all" = true for an old endpoint / codex round 13, high #3)
              return { id: t.endpoint.id, publicKey: st.publicKey, registered: registeredFor(st, await tagFor(have, t.endpoint.id)) }
            } catch {
              // ⚠️ Just down (say neither "no key" nor "unregistered" / fail-closed)
              return { id: t.endpoint.id, publicKey: undefined, registered: undefined }
            }
          }),
        )
        const plan = planPush(agents, have)

        // ★ Execution is in one place, `pushExec.ts` (⚠️ do not write it back here = `.tsx` has no tests)
        problems.push(...(await executePlan(plan, have, targets(), pushDeps)))
      } catch (err) {
        problems.push(err instanceof Error ? err.message : String(err))
      }
      // ⚠️⚠️ **Never swallow failures silently** (codex medium #6). Give the reason even for the startup sync.
      if (problems.length > 0) {
        const why = problems.join(' / ')
        setMsg(t(`通知の設定に失敗しました — ${why}`, `Failed to set up notifications — ${why}`))
      }
      // ★ Clear on success (⚠️ while a failure remains, show the banner even for "partially registered" / codex round 19, medium #3)
      setSyncProblem(problems.length > 0 ? problems.join(' / ') : undefined)
    })

  useEffect(() => {
    if (!supported) return
    void (async () => {
      // ★★ Also make the notification-receiving worker (the `/push/<id>/` registration) **fetch the new version** (2026-09-24 / real device).
      //   ⚠️⚠️ That scope's page is never opened, so the browser does not check for updates by itself (can stay up to about a day old).
      //      ⇒ It kept loading the removed old icon: the status bar showed the default 🔔 and an "A" next to the notification.
      //   ⚠️⚠️ **Do not wait** (codex round 21, medium #1): if the connection to the distribution origin stalls, `update()` never finishes,
      //      and waiting blocked the subscription sync and the device count. Updating later is fine, so fire it in parallel and start sync at once
      void refreshWorkers()
      await syncSubscription()
      await refresh()
    })()
  }, [])

  const enable = async () => {
    setBusy(true)
    setMsg(undefined)
    try {
      const perm = await Notification.requestPermission()
      setPermission(perm)
      if (perm !== 'granted') {
        setMsg(t('通知が許可されませんでした', 'Notifications were not allowed'))
        return
      }
      // ⚠️⚠️ Call **after clearing the "stopped" mark** (otherwise `syncSubscription` does nothing / high #1)
      setPushOff(false)
      // ★ Creating and discarding are both in one place, `syncSubscription` (just call it after permission)
      await syncSubscription()
      await refresh()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    setBusy(true)
    setMsg(undefined)
    try {
      const results = await Promise.all(transports.map((t) => t.sendTestPush()))
      const sent = results.reduce((n, r) => n + r.sent, 0)
      setMsg(
        sent > 0
          ? t(`テスト通知を ${sent} 件送りました`, `Sent ${sent} test notification(s)`)
          : t('送信先がありません', 'No one to send to'),
      )
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const disable = async () => {
    setBusy(true)
    setMsg(undefined)
    try {
      // ⚠️⚠️ **Set the "stopped" mark first** (a failure before setting it would revive on next open / high #1)
      setPushOff(true)
      // ⚠️⚠️ **Stop every scope** (each agent has its own, so removing only one gives
      //    "stopped, yet they still come" / 2026-09-21)
      // ★★ **On the same chain as sync** (codex round 13, high #2). If another tab's sync is running,
      //   wait for it to finish (that sync checks the "stopped" mark right before registering and leaves nothing).
      let left: string[] = []
      await serialize(async () => {
        left = await stopAll(await listSubs(), targets(), pushDeps)
      })
      setRegistered(0)
      // ⚠️ Once stopped, clear the previous registration failure too (do not keep showing "could not register" after stopping)
      setSyncProblem(undefined)
      await refresh()
      // ⚠️⚠️ **Say "stopped" only when actually unsubscribed** (never lie silently / medium #6)
      setMsg(
        left.length === 0
          ? t('通知を停止しました', 'Notifications stopped')
          : t(
              `⚠️ 停止しきれませんでした（${left.join(' / ')}）。もう一度お試しください`,
              `⚠️ Could not stop everything (${left.join(' / ')}). Please try again`,
            ),
      )
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!supported) {
    return (
      <p class="notice">
        {t(
          'この環境では通知が使えません（Service Worker / Push 非対応）。',
          'Notifications are not available here (no Service Worker / Push support).',
        )}
      </p>
    )
  }

  /**
   * ★ Folded into one line when enabled (2026-08-13 user decision).
   *
   * The top of the list is meant for "sessions waiting on you", and **spending about 90px on the settings of
   * notifications that already work is too much**. Removing the heading and card frame brings it to about 22px.
   *
   * ⚠️ **Not folded when unset, blocked or unsupported.** Those are "action needed" states, so
   *    they may stand out (folded, nobody would ever notice).
   */
  /**
   * ⚠️ **Not folded when failing.** Put in a folded single line, it goes unnoticed while
   *    "Notifications enabled" keeps showing (exactly those 3 days).
   */
  const kind = pushKind({
    supported,
    permission,
    registered,
    total: transports.length,
    failure,
    off: pushOff(),
    syncProblem,
  })
  // ★ To the header badge (⚠️ calling on every render makes the parent re-render forever ⇒ only on change)
  useEffect(() => {
    onSummary?.({ kind, registered, total: transports.length })
  }, [kind, registered, transports.length])

  // ★★ List: nothing when healthy. A one-line banner only for states needing action
  if (mode === 'list') {
    if (!showsBanner(kind)) return null
    return (
      <div class={kind === 'failing' || kind === 'unregistered' ? 'pushline bad' : 'pushline'}>
        <span class="body">{bannerText(kind)}</span>
        <span class="grow" />
        {kind === 'unset' ? (
          <button class="plain tiny" disabled={busy} onClick={() => void enable()}>
            {t('許可する', 'Allow')}
          </button>
        ) : null}
        <button class="plain tiny" onClick={() => onOpenSettings?.()}>
          {kind === 'failing' || kind === 'unregistered' ? t('直す →', 'Fix →') : t('設定 →', 'Settings →')}
        </button>
        {msg ? <span class="pushmsg inline">{msg}</span> : null}
      </div>
    )
  }

  // ⚠️ Below is the settings screen (always shows everything). The old "fold into one line when enabled" was taken over by the list banner
  return (
    <section class="group">
      {failure ? (
        <p class="notice bad">
          {t('⚠ この端末に通知を送れていません（', '⚠ Notifications are not reaching this device (')}
          {failure.status ?? t('状態不明', 'unknown status')} · {hhmm(failure.at)}
          {t(
            '）。購読は残っているので「有効」に見えますが、',
            '). The subscription is still there, so it looks “on”, but they are ',
          )}
          <strong>{t('届いていません', 'not arriving')}</strong>
          {t(
            '。agent を更新しても直らなければ、下の「停止」→ 「通知を許可」でやり直してください。',
            '. If updating the agent does not fix it, redo it below with “Stop” → “Allow notifications”.',
          )}
        </p>
      ) : null}
      <h2>{t('通知', 'Notifications')}</h2>
      <div class="notice push">
        <div class="pushrow">
          <span>
            {permission === 'denied'
              ? t('❌ ブラウザ設定で通知がブロックされています', '❌ Notifications are blocked in the browser settings')
              : registered > 0
                ? t(
                    `🔔 有効 — ${registered}/${transports.length} 台に登録済み（端末 ${devices}）`,
                    `🔔 On — registered with ${registered}/${transports.length} machines (${devices} device(s))`,
                  )
                : t('通知は未設定です', 'Notifications are not set up')}
          </span>
          <span class="grow" />
          {permission !== 'denied' && registered === 0 ? (
            <button class="plain" disabled={busy} onClick={() => void enable()}>
              {t('通知を許可', 'Allow notifications')}
            </button>
          ) : null}
          {registered > 0 ? (
            <>
              <button class="plain" disabled={busy} onClick={() => void test()}>
                {t('テスト送信', 'Send test')}
              </button>
              {/* ★ Stop takes two taps (stops all notifications / recovery took half an hour on 2026-08-12) */}
              <button
                class={confirmOff ? 'plain danger' : 'plain'}
                disabled={busy}
                onClick={() => {
                  if (!confirmOff) {
                    setConfirmOff(true)
                    setTimeout(() => setConfirmOff(false), 4000)
                    return
                  }
                  setConfirmOff(false)
                  void disable()
                }}
              >
                {confirmOff ? t('もう一度押すと停止', 'Tap again to stop') : t('停止', 'Stop')}
              </button>
            </>
          ) : null}
        </div>
        {msg ? <div class="pushmsg">{msg}</div> : null}
        {permission === 'denied' ? (
          <div class="pushmsg">
            {t(
              'Chrome の「サイトの設定 → 通知」で許可し直してください。',
              'Allow them again in Chrome under “Site settings → Notifications”.',
            )}
          </div>
        ) : null}
      </div>
    </section>
  )
}

/**
 * Turn the VAPID public key (base64url) into bytes for applicationServerKey.
 *
 * The spec allows passing the base64url string directly, but we convert to bytes to avoid implementation differences.
 * ⚠️ Build it from an ArrayBuffer. `new Uint8Array(len)` becomes `Uint8Array<ArrayBufferLike>` and
 *    cannot be assigned to BufferSource (TS 5.7+).
 */
function base64UrlToBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4)
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}
