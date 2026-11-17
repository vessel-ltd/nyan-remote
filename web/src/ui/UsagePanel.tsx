import { useEffect, useState } from 'preact/hooks'
import type { ToolUsage } from '../../../shared/types.ts'
import { t } from '../../../shared/i18n.ts'
import type { Transport } from '../transport/index.ts'
import { relativeTime } from './SessionList.tsx'
import { groupUsage, planLabel, windowText } from './usage.ts'

/** How often the open settings screen reads the limits again (the agent asks Codex at most once a minute) */
const USAGE_REFRESH_MS = 60_000

/**
 * ★ Plan limits per account, Claude and Codex (2026-11-17 / `ui/usage.ts`).
 * ⚠️ Asked only of agents with the `usage` feature (an older one would answer 404 / fail-closed).
 * ⚠️ Shows nothing when no machine has a reading (a profile without a status line has none for Claude).
 */
export function UsagePanel({ transports }: { transports: Transport[] }) {
  const [byMachine, setByMachine] = useState<Array<{ machine: string; usage: ToolUsage[] }> | undefined>(undefined)

  useEffect(() => {
    let alive = true
    let busy = false
    const read = (): void => {
      // ⚠️ One round at a time, and not while the app is in the background (no reason to wake the agents)
      if (busy || (typeof document !== 'undefined' && document.hidden)) return
      busy = true
      void Promise.all(
        transports.map(async (tr) => {
          try {
            const h = await tr.health()
            if (!h.features?.includes('usage')) return undefined
            const res = await tr.usage()
            return { machine: h.machine, usage: Array.isArray(res.usage) ? res.usage : [] }
          } catch {
            return undefined
          }
        }),
      )
        .then((all) => {
          if (alive) setByMachine(all.filter((x): x is { machine: string; usage: ToolUsage[] } => x !== undefined))
        })
        .finally(() => {
          busy = false
        })
    }
    read()
    // ★ Kept fresh while the settings screen stays open (codex review: it was read once)
    const timer = setInterval(read, USAGE_REFRESH_MS)
    const onShow = (): void => {
      if (!document.hidden) read()
    }
    document.addEventListener('visibilitychange', onShow)
    return () => {
      alive = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onShow)
    }
  }, [transports])

  if (!byMachine) return null
  const groups = groupUsage(byMachine)
  if (groups.length === 0) return null
  return (
    <section class="group">
      <h2>{t('使用量', 'Usage')}</h2>
      <div class="notice">
        {groups.map((g) => (
          <div key={`${g.tool}:${g.names.join(',')}`} class="pushrow usagerow">
            <span class="grow">
              <strong>{g.tool === 'claude' ? 'Claude' : 'Codex'}</strong>
              {/* ★ Who, as `/status` shows it: plan · organization, then the e-mail (text only: Preact escapes it) */}
              {[g.plan ? planLabel(g.tool, g.plan) : undefined, g.org].filter(Boolean).map((x) => ` · ${x}`).join('')}
              <br />
              <span class="dim">{[g.email, ...g.names].filter(Boolean).join(' · ')}</span>
              <br />
              {g.windows.length > 0 ? (
                g.windows.map((w) => (
                  <span key={w.minutes} class={w.usedPercent >= 80 ? 'bad' : undefined}>
                    {windowText(w)}{' '}
                  </span>
                ))
              ) : (
                <span class="dim">{t('リセットされた後はまだ読めていません', 'Not read since the last reset')}</span>
              )}
              <br />
              <span class="dim">{t(`${relativeTime(g.at)}の値`, `as of ${relativeTime(g.at)}`)}</span>
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}
