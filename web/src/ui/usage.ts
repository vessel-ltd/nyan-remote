// ★ Plan limits on the settings screen (2026-11-17 / agent/src/usage.ts).
//
// Each machine reports its Claude profiles and Codex homes. ⚠️ Limits belong to the **account**: two profiles (even on
// two machines) logged in to one account are one set of numbers ⇒ grouped by `accountKey`, the freshest reading wins.
// ⚠️ Which windows exist depends on the plan (some have no 5-hour window): only what was reported is shown.

import type { ToolUsage, UsageWindow } from '../../../shared/types.ts'
import { t } from '../../../shared/i18n.ts'
import { hhmm } from '../time.ts'

export interface UsageGroup {
  tool: ToolUsage['tool']
  /** `machine: profile` of every profile that is this account */
  names: string[]
  plan?: string
  /** Who is logged in (display only) */
  email?: string
  org?: string
  windows: UsageWindow[]
  at: string
}

/** Merge the machines' readings. A reading without an account is its own group */
export function groupUsage(byMachine: ReadonlyArray<{ machine: string; usage: readonly ToolUsage[] }>, nowMs: number = Date.now()): UsageGroup[] {
  const groups = new Map<string, { names: string[]; best: ToolUsage }>()
  for (const { machine, usage } of byMachine) {
    for (const u of usage) {
      const key = u.accountKey ? `${u.tool}:${u.accountKey}` : `${u.tool}:${machine}:${u.account}`
      const name = `${machine}: ${u.account}`
      const g = groups.get(key)
      if (!g) {
        groups.set(key, { names: [name], best: u })
        continue
      }
      if (!g.names.includes(name)) g.names.push(name)
      if (Date.parse(u.at) > Date.parse(g.best.at)) g.best = u
    }
  }
  const out: UsageGroup[] = []
  for (const { names, best } of groups.values()) {
    out.push({
      tool: best.tool,
      names: names.sort(),
      ...(best.plan ? { plan: best.plan } : {}),
      ...(best.email ? { email: best.email } : {}),
      ...(best.org ? { org: best.org } : {}),
      // ⚠️ A reset that passed while the screen was open is no longer true
      windows: best.windows.filter((w) => Date.parse(w.resetsAt) > nowMs).sort((a, b) => b.minutes - a.minutes),
      at: best.at,
    })
  }
  // Claude, Codex, then agy; within a tool the fullest week first (the one to watch)
  const week = (g: UsageGroup): number => g.windows.find((w) => w.minutes >= 7 * 24 * 60)?.usedPercent ?? -1
  const order = (tool: UsageGroup['tool']): number => (tool === 'claude' ? 0 : tool === 'codex' ? 1 : 2)
  return out.sort((a, b) => (a.tool === b.tool ? week(b) - week(a) : order(a.tool) - order(b.tool)))
}

/**
 * The plan as each tool's `/status` names it. ⚠️ Only names that were seen there (codex-cli 0.169.0 shows `prolite` as
 * "Pro 100"; Claude Code 2.1.326 shows `claude_team` as "Claude Team account"); anything else is shown as the tool sent it.
 */
export function planLabel(tool: UsageGroup['tool'], plan: string): string {
  // agy names its plan in words already (`Google AI Pro`)
  if (tool === 'agy') return plan
  if (tool === 'codex') return plan === 'prolite' ? 'Pro 100' : plan
  const m = /^claude_([a-z0-9]+)$/.exec(plan)
  return m ? m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1) : plan
}

export function windowName(minutes: number): string {
  if (minutes === 10080) return t('週', 'Week')
  if (minutes % 1440 === 0) return t(`${minutes / 1440}日`, `${minutes / 1440}d`)
  if (minutes % 60 === 0) return t(`${minutes / 60}時間`, `${minutes / 60}h`)
  return t(`${minutes}分`, `${minutes}m`)
}

/** The tool's name as the usage list shows it */
export function toolName(tool: UsageGroup['tool']): string {
  return tool === 'claude' ? 'Claude' : tool === 'codex' ? 'Codex' : 'agy'
}

/** When it resets, in local time: the time today, else month/day and time */
export function resetText(iso: string, nowMs: number = Date.now()): string {
  const d = new Date(iso)
  const now = new Date(nowMs)
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameDay ? hhmm(iso) : `${d.getMonth() + 1}/${d.getDate()} ${hhmm(iso)}`
}

export function windowText(w: UsageWindow, nowMs: number = Date.now()): string {
  const pct = Math.round(w.usedPercent)
  return t(`${windowName(w.minutes)} ${pct}%（${resetText(w.resetsAt, nowMs)} リセット）`, `${windowName(w.minutes)} ${pct}% (resets ${resetText(w.resetsAt, nowMs)})`)
}
