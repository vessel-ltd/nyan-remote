import { useEffect, useState } from 'preact/hooks'
import { t } from '../../../shared/i18n.ts'
import type { Transport } from '../transport/index.ts'
import { toolName } from './usage.ts'
import { fivesText, groupHistory, historyNote, historySince, pctText, readHistories, shortDate, stopsText, weeksText, type MachineHistory } from './usageHistory.ts'

/**
 * ★ Usage history per login, a section of its own under "Usage" (2026-11-27 / user decision / `ui/usageHistory.ts`).
 * Each PC keeps its own history (`GET /usage/history`); nothing is collected anywhere else.
 * ⚠️ Asked only of agents with the `usage-history` feature (an older one would answer 404 / fail-closed).
 * ★ Read once when the settings screen opens (history moves every 15 minutes at most; no timer).
 * ★ A PC that could not be read is said (its stops are missing from the counts / codex review).
 */
export function UsageHistoryPanel({ transports }: { transports: Transport[] }) {
  const [read, setRead] = useState<{ ok: MachineHistory[]; missing: number } | undefined>(undefined)

  useEffect(() => {
    let alive = true
    void readHistories(transports).then((r) => {
      if (alive) setRead(r)
    })
    return () => {
      alive = false
    }
  }, [transports])

  // Nothing while reading, and nothing when no machine keeps a history and none failed (older agents only)
  if (!read || (read.ok.length === 0 && read.missing === 0)) return null
  const groups = groupHistory(read.ok)
  const since = historySince(read.ok)
  return (
    <section class="group">
      <h2>{t('履歴', 'History')}</h2>
      <div class="notice">
        <div class="pushrow">
          <span class="grow dim">
            {historyNote(read, groups, since).map((line, i) => (
              <span key={i}>
                {i > 0 ? <br /> : null}
                {line}
              </span>
            ))}
          </span>
        </div>
        {groups.map((g) => (
          <div key={g.key} class="pushrow usagerow">
            <span class="grow">
              <strong>{toolName(g.tool)}</strong>
              <br />
              <span class="dim">{g.names.join(' · ')}</span>
              {g.weeks.length > 0 ? (
                <>
                  <span class="histweeks" role="img" aria-label={g.weeks.map((w) => `${shortDate(w.resetsAt)} ${pctText(w.usedPercent)}%`).join(', ')}>
                    {g.weeks.map((w) => (
                      <span
                        key={w.resetsAt}
                        title={`${shortDate(w.resetsAt)} ${pctText(w.usedPercent)}%`}
                        class={w.usedPercent >= 100 ? 'histbar full' : 'histbar'}
                        style={{ height: `${Math.max(2, Math.min(100, w.usedPercent))}%` }}
                      />
                    ))}
                  </span>
                  <span class="histdates" aria-hidden="true">
                    <span>{shortDate(g.weeks[0]!.resetsAt)}</span>
                    {g.weeks.length > 1 ? <span>{shortDate(g.weeks[g.weeks.length - 1]!.resetsAt)}</span> : null}
                  </span>
                  {weeksText(g)}
                  <br />
                </>
              ) : (
                <br />
              )}
              <span class={g.limitStops > 0 ? 'bad' : undefined}>{stopsText(g)}</span>
              {fivesText(g) ? (
                <>
                  <br />
                  {fivesText(g)}
                </>
              ) : null}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}
