// ★★ The update-notice banner (2026-09-24). The decision is `planUpdates` in `updates.ts`; this only renders it.
//   - App is old ⇒ "Reload" (the Service Worker fetches the page first, so reloading gives the new shell)
//   - Machine is old ⇒ "nyan update on that PC" (⚠️ not updated from the phone = a restart kills pending approvals / CLAUDE.md §3)
// ⚠️ The distribution origin is asked only on open and on returning to the foreground (at most every 30 min).
// ★ ✕ means "not today" (24 hours / `isSnoozed` in `updates.ts`).

import { useEffect, useState } from 'preact/hooks'
import type { BuildInfo } from '../../../shared/release.ts'
import { t } from '../../../shared/i18n.ts'
import { fetchLatestRelease } from '../transport/index.ts'
import { whileVisible } from '../visibility.ts'
import { dismissRecord, isSnoozed, planUpdates, releaseChecker, UPDATE_DISMISSED_KEY, type MachineBuild } from './updates.ts'

const CHECK_EVERY_MS = 30 * 60 * 1000

/** ★ One for the whole app lifetime (⚠️ kept inside the component, it re-asks every time you return to the list / codex round 23, low #5) */
const checker = releaseChecker(fetchLatestRelease, CHECK_EVERY_MS)

function readDismissed(): string | null {
  try {
    return localStorage.getItem(UPDATE_DISMISSED_KEY)
  } catch {
    return null
  }
}

export function UpdateBanner({ machines }: { machines: readonly MachineBuild[] }) {
  const [latest, setLatest] = useState<BuildInfo | undefined>(checker.latest)
  const [dismissed, setDismissed] = useState<string | null>(readDismissed)
  // ★ "Now" for re-checking whether 24 hours have passed (advanced on every check, even if left open)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    let alive = true
    const check = () =>
      void checker.check().then((r) => {
        if (!alive) return
        if (r) setLatest(r)
        setNow(Date.now())
      })
    check()
    const stop = whileVisible(check, CHECK_EVERY_MS, typeof document === 'undefined' ? undefined : document)
    return () => {
      alive = false
      stop()
    }
  }, [])

  const plan = planUpdates({ self: __BUILD_INFO__, latest, machines })
  if (!plan || isSnoozed(dismissed, plan.key, now)) return null
  const close = () => {
    const rec = dismissRecord(plan.key, Date.now())
    try {
      localStorage.setItem(UPDATE_DISMISSED_KEY, rec)
    } catch {
      // ⚠️ Even if it cannot be remembered, close it for this screen
    }
    setNow(Date.now())
    setDismissed(rec)
  }
  return (
    <div class="pushline update">
      <span class="lines">
        {plan.app ? (
          <span class="body">
            {t('⬆ アプリの新しい版があります', '⬆ A new version of the app is available')}{' '}
            <button class="plain tiny" onClick={() => location.reload()}>
              {t('再読み込み', 'Reload')}
            </button>
          </span>
        ) : null}
        {plan.machines.length > 0 ? (
          <span class="body">
            {t(
              `⬆ ${plan.machines.join('・')} が古い版です。その PC で `,
              `⬆ ${plan.machines.join(', ')} ${plan.machines.length === 1 ? 'is' : 'are'} on an older version. On that PC, run `,
            )}
            <code>nyan update</code>
            {t(' を打ってください', '')}
          </span>
        ) : null}
      </span>
      <button class="plain tiny" title={t('今日は出さない（24時間）', 'Hide for today (24 hours)')} onClick={close}>
        ✕
      </button>
    </div>
  )
}
