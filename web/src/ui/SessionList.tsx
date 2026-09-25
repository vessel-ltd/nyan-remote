import type { SessionSummary } from '../../../shared/types.ts'
import { formatTokens } from './tokens.ts'
import { sessionHash } from '../route.ts'
import { statusView } from './status.ts'
import { currentLang, t } from '../../../shared/i18n.ts'
import { accountLabel } from './agentText.ts'

// ★ How state is shown (`statusView`) lives in `status.ts`.
//   ⚠️ `.tsx` cannot be imported from `node:test` (`ERR_UNKNOWN_FILE_EXTENSION`), so
//      **anything to be checked by machine goes in `.ts`** (2026-08-18).
export { statusView } from './status.ts'

// ★ Built once per language (⚠️ do not decide the language at module top level = frozen to the startup language)
const rtfs = new Map<string, Intl.RelativeTimeFormat>()
function rtfFor(lang: string): Intl.RelativeTimeFormat {
  let f = rtfs.get(lang)
  if (!f) {
    f = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' })
    rtfs.set(lang, f)
  }
  return f
}

export function relativeTime(iso: string, now = Date.now()): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return '—'
  const rtf = rtfFor(currentLang())
  const sec = Math.round((at - now) / 1000)
  const abs = Math.abs(sec)
  if (abs < 60) return rtf.format(sec, 'second')
  if (abs < 3600) return rtf.format(Math.round(sec / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(sec / 3600), 'hour')
  return rtf.format(Math.round(sec / 86400), 'day')
}

export function SessionList({
  sessions,
  now,
  showMachine,
}: {
  sessions: SessionSummary[]
  now: number
  /** Show the machine name only when 2+ machines are connected (redundant with 1) */
  showMachine?: boolean
}) {
  return (
    <ul class="sessions">
      {sessions.map((s) => {
        const view = statusView(s.status, s.live, s.waitingFor)
        const ctx = formatTokens(s.contextTokens)
        return (
          <li key={`${s.machine}/${s.account}/${s.sessionId}`}>
            <a class="row" href={sessionHash(s.sessionId)}>
              <span
                class={`dot ${view?.cls ?? (s.live ? 'idle' : 'closed')}`}
                aria-label={view?.label ?? t('終了', 'Ended')}
              />
              <span class="body">
                <span class="title">{s.title}</span>
                <span class="sub">
                  {view ? <span class={`state ${view.cls}`}>{view.label}</span> : null}
                  {/* ★★ Auto-approve mode (2026-09-07). ⚠️ **Shown in the list too** (so you can tell at a glance, without opening,
                      which session is auto-passing yes/no approvals.
                      This feature keeps running if unnoticed, so visibility is the point).
                      ⚠️ Decided only by whether the agent attached the mark (not cleared by the device clock) */}
                  {s.autoApprove ? <span class="chip auto">⚡ {t('自動承認', 'Auto-approve')}</span> : null}
                  {/* ★ Machines are no longer grouped, so the row shows which PC */}
                  {showMachine ? <span class="chip machine">{s.machine}</span> : null}
                  <span class="chip account">{accountLabel(s)}</span>
                  <span>{s.project}</span>
                  {s.gitBranch ? <span class="chip">{s.gitBranch}</span> : null}
                  {s.permissionMode && s.permissionMode !== 'auto' ? (
                    <span class="chip mode">{s.permissionMode}</span>
                  ) : null}
                  {/* ★ Amount of context currently in use (2026-08-19).
                      ⚠️ No percentage or colour — the window size is unknown, so
                         **do not guess an unknown window** (see `ui/tokens.ts`).
                      ⚠️ When unknown, **omit the chip entirely** (do not write 0).
                      ⚠️⚠️ **Put the meaning on screen.** `title` **cannot be read by a finger**, so
                         on the phone nobody could tell what "673k" meant
                         (2026-08-19 `/code-review`, low #2) */}
                  {ctx ? (
                    <span class="chip ctx" title={t('いま使っているコンテキストの量（最後の応答時点）', 'Context currently in use (as of the last response)')}>
                      ctx {ctx}
                    </span>
                  ) : null}
                </span>
                {s.awaySummary ? <span class="away">{s.awaySummary}</span> : null}
              </span>
              <span class="when">{relativeTime(s.lastActivity, now)}</span>
            </a>
          </li>
        )
      })}
    </ul>
  )
}
