// ★ Usage history across machines (2026-11-27 / `UsageHistoryPanel.tsx` / agent: `usageHistory.ts`).
//
// Each PC keeps its own history and answers with numbers only. The phone puts one account together:
//  - the same account on two PCs (equal `accountKey`) is one login: its week windows and its full 5-hour windows are
//    the same windows seen twice (merged by reset time, highest use wins), its limit stops are different stops (added);
//  - without an `accountKey`, a login is its machine and profile.

import type { UsageHistoryLogin, UsageHistoryResponse } from '../../../shared/types.ts'
import { t } from '../../../shared/i18n.ts'

/** Readings of one window can name reset times seconds or minutes apart (the agent's `SAME_WINDOW_MS`) */
const SAME_WINDOW_MS = 10 * 60_000
/** Week bars shown per login */
export const HISTORY_WEEKS = 13

export interface HistoryGroup {
  /** Unique among the groups (for the list's keys) */
  key: string
  tool: UsageHistoryLogin['tool']
  /** "machine: profile" of every place this login was seen */
  names: string[]
  /** Finished week windows, oldest first */
  weeks: Array<{ resetsAt: string; usedPercent: number }>
  fiveHourFull: number
  fiveHourLast?: string
  limitStops: number
  /** The latest stops, newest first */
  recentStops: string[]
}

/** One machine's answer. `id` tells the agent apart (its public key): the same PC saved twice is read once. */
export interface MachineHistory {
  id: string
  machine: string
  history: UsageHistoryResponse
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const time = (v: unknown): number | undefined => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : undefined)
const TOOLS = new Set(['claude', 'codex', 'agy'])

/** ⚠️ An answer is data from the network: anything misshapen is skipped, never thrown (one bad PC hides nothing else) */
function loginsOf(history: unknown): UsageHistoryLogin[] {
  if (!isObj(history) || !Array.isArray(history.logins)) return []
  const out: UsageHistoryLogin[] = []
  for (const l of history.logins) {
    // ⚠️ Every field must be there in its shape: a missing one would read as "0 stops" (codex review)
    if (!isObj(l) || typeof l.tool !== 'string' || !TOOLS.has(l.tool) || typeof l.account !== 'string') continue
    // ⚠️ A key that is there but not a string is broken (dropping it would split one account in two / codex)
    if (l.accountKey !== undefined && typeof l.accountKey !== 'string') continue
    if (!Array.isArray(l.weeks) || !Array.isArray(l.fiveHourFull) || !isObj(l.limitStops)) continue
    const ls = l.limitStops
    if (typeof ls.count !== 'number' || !Number.isInteger(ls.count) || ls.count < 0 || !Array.isArray(ls.recent)) continue
    // ⚠️ Every entry too: one broken entry makes the login (and so the answer) not taken, rather than silently fewer
    //    windows (codex review)
    const okWeek = (w: unknown): w is { resetsAt: string; usedPercent: number } =>
      isObj(w) && time(w.resetsAt) !== undefined && typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent)
    if (!l.weeks.every(okWeek) || !l.fiveHourFull.every((r) => time(r) !== undefined) || !ls.recent.every((r) => time(r) !== undefined)) continue
    const weeks = l.weeks.map((w) => ({ resetsAt: w.resetsAt, usedPercent: Math.max(0, Math.min(100, w.usedPercent)) }))
    const fives = l.fiveHourFull as string[]
    const recent = ls.recent as string[]
    out.push({
      tool: l.tool as UsageHistoryLogin['tool'],
      account: l.account,
      ...(typeof l.accountKey === 'string' && l.accountKey !== '' ? { accountKey: l.accountKey } : {}),
      weeks,
      fiveHourFull: fives,
      limitStops: { count: ls.count, recent },
    })
  }
  return out
}

/** The window of `list` that `r` belongs to (tolerance as on the agent), or a new one */
function windowOf(list: Array<{ r: number; p: number }>, r: number): { r: number; p: number } {
  const hit = list.find((w) => Math.abs(w.r - r) <= SAME_WINDOW_MS)
  if (hit) return hit
  const w = { r, p: 0 }
  list.push(w)
  return w
}

export function groupHistory(byMachine: readonly MachineHistory[]): HistoryGroup[] {
  const groups = new Map<string, { tool: HistoryGroup['tool']; names: string[]; weeks: Array<{ r: number; p: number }>; fives: number[]; stops: string[]; stopCount: number }>()
  const seen = new Set<string>()
  for (const { id, machine, history } of byMachine) {
    // ★ One PC saved under two addresses answers twice: its stops are counted once (codex review)
    if (seen.has(id)) continue
    seen.add(id)
    for (const l of loginsOf(history)) {
      const key = l.accountKey ? `${l.tool}:${l.accountKey}` : `${l.tool}:${id}:${l.account}`
      let g = groups.get(key)
      if (!g) {
        g = { tool: l.tool, names: [], weeks: [], fives: [], stops: [], stopCount: 0 }
        groups.set(key, g)
      }
      const name = `${machine}: ${l.account}`
      if (!g.names.includes(name)) g.names.push(name)
      // A week or a 5-hour window seen by two PCs is one window (highest use wins); stops on two PCs are two stops
      for (const w of l.weeks) {
        const win = windowOf(g.weeks, Date.parse(w.resetsAt))
        win.p = Math.max(win.p, w.usedPercent)
      }
      for (const r of l.fiveHourFull) {
        const at = Date.parse(r)
        if (!g.fives.some((x) => Math.abs(x - at) <= SAME_WINDOW_MS)) g.fives.push(at)
      }
      g.stopCount += l.limitStops.count
      g.stops.push(...l.limitStops.recent)
    }
  }
  const out: HistoryGroup[] = []
  for (const [key, g] of groups) {
    const fives = g.fives.sort((a, b) => a - b)
    out.push({
      key,
      tool: g.tool,
      names: g.names.sort(),
      weeks: g.weeks
        .sort((a, b) => a.r - b.r)
        .slice(-HISTORY_WEEKS)
        .map((w) => ({ resetsAt: new Date(w.r).toISOString(), usedPercent: w.p })),
      fiveHourFull: fives.length,
      ...(fives.length ? { fiveHourLast: new Date(fives[fives.length - 1]!).toISOString() } : {}),
      limitStops: g.stopCount,
      recentStops: g.stops.sort((a, b) => Date.parse(b) - Date.parse(a)).slice(0, 3),
    })
  }
  // Claude, Codex, then agy; within a tool the login that stopped most first (the one to look at)
  const order = (tool: HistoryGroup['tool']): number => (tool === 'claude' ? 0 : tool === 'codex' ? 1 : 2)
  return out.sort((a, b) => order(a.tool) - order(b.tool) || b.limitStops - a.limitStops || a.names[0]!.localeCompare(b.names[0]!))
}

/** What the panel needs of a connection (a `Transport`) */
export interface HistorySource {
  health(): Promise<{ machine: string; features?: readonly string[] | undefined; agentPublicKey?: string | undefined }>
  usageHistory(): Promise<UsageHistoryResponse>
}

/**
 * ★ Read every PC's history once. One PC saved under two addresses is one agent (its public key): asked once, the
 *   other address tried if the first fails. `missing` = connections that could not be read (their counts are absent).
 *   Agents without the `usage-history` feature are skipped silently (older ones).
 */
export async function readHistories(sources: readonly HistorySource[]): Promise<{ ok: MachineHistory[]; missing: number }> {
  const healths = await Promise.all(
    sources.map((src) =>
      src.health().then(
        (h) => (isObj(h) && typeof h.machine === 'string' ? { src, h } : undefined),
        () => undefined,
      ),
    ),
  )
  const byAgent = new Map<string, { machine: string; srcs: HistorySource[] }>()
  let missing = 0
  for (const x of healths) {
    if (!x) {
      missing++
      continue
    }
    if (!Array.isArray(x.h.features) || !x.h.features.includes('usage-history')) continue
    const id = typeof x.h.agentPublicKey === 'string' && x.h.agentPublicKey !== '' ? x.h.agentPublicKey : x.h.machine
    const a = byAgent.get(id) ?? { machine: x.h.machine, srcs: [] }
    a.srcs.push(x.src)
    byAgent.set(id, a)
  }
  // ★ Each agent in parallel; within one, its addresses in turn (a slow PC does not hold the others back)
  const got = await Promise.all(
    [...byAgent].map(async ([id, a]): Promise<MachineHistory | undefined> => {
      for (const src of a.srcs) {
        try {
          const history = await src.usageHistory()
          // ⚠️ A misshapen answer (any login entry included) or a history that is off is not a reading: the next
          //    address, else "missing"
          if (isObj(history) && Array.isArray(history.logins) && history.off !== true && loginsOf(history).length === history.logins.length) {
            return { id, machine: a.machine, history }
          }
        } catch {
          // the next address
        }
      }
      return undefined
    }),
  )
  const ok = got.filter((x): x is MachineHistory => x !== undefined)
  return { ok, missing: missing + got.length - ok.length }
}

/** The line above the logins: what was read, and what could not be */
export function historyNote(read: { ok: readonly MachineHistory[]; missing: number }, groups: readonly HistoryGroup[], since: string | undefined): string[] {
  const out: string[] = []
  if (read.ok.length === 0) {
    out.push(t('どの PC からも履歴を読めませんでした', 'Could not read the history from any PC'))
    return out
  }
  out.push(
    since && groups.length > 0
      ? t(`各 PC に残っている ${shortDate(since)} からの記録（最長90日・外には送っていません）`, `Kept on each PC since ${shortDate(since)} (up to 90 days, never sent anywhere else)`)
      : t('まだ見せるものがありません（終わった週も上限での停止もまだありません。各 PC が15分ごとに記録しています）', 'Nothing to show yet (no finished week and no limit stop so far; each PC records every 15 minutes)'),
  )
  if (read.missing > 0) {
    out.push(t(`${read.missing}か所の接続先から読めませんでした（その分は数に入っていません）`, `${read.missing} connection${read.missing === 1 ? '' : 's'} could not be read (not in the counts)`))
  }
  return out
}

/** The oldest time any machine's history covers (for "since …") */
export function historySince(byMachine: ReadonlyArray<{ history: UsageHistoryResponse }>): string | undefined {
  const times = byMachine.map((x) => (isObj(x.history) ? x.history.since : undefined)).filter((s): s is string => time(s) !== undefined)
  return times.sort((a, b) => Date.parse(a) - Date.parse(b))[0]
}

/** A short local date: "11/27" */
export function shortDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** A short local date and time: "11/27 14:05" */
export function shortDateTime(iso: string): string {
  const d = new Date(iso)
  return `${shortDate(iso)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** "上限で止まった 3回（直近 11/27 14:05）" */
export function stopsText(g: HistoryGroup): string {
  if (g.limitStops === 0) return t('上限で止まったことはありません', 'Never stopped at a limit')
  const last = g.recentStops[0]
  return t(
    `上限で止まった ${g.limitStops}回${last ? `（直近 ${shortDateTime(last)}）` : ''}`,
    `Stopped at a limit ${g.limitStops} time${g.limitStops === 1 ? '' : 's'}${last ? ` (last ${shortDateTime(last)})` : ''}`,
  )
}

/** "5時間の枠を使い切った 2回（直近 11/26）" — nothing when none */
export function fivesText(g: HistoryGroup): string | undefined {
  if (g.fiveHourFull === 0) return undefined
  const last = g.fiveHourLast ? shortDate(g.fiveHourLast) : undefined
  return t(
    `5時間の枠を使い切った ${g.fiveHourFull}回${last ? `（直近 ${last}）` : ''}`,
    `Used up a 5-hour window ${g.fiveHourFull} time${g.fiveHourFull === 1 ? '' : 's'}${last ? ` (last ${last})` : ''}`,
  )
}

/** A percent as shown: whole numbers, ⚠️ 100 only for a window really used up (99.9 shows 99 / codex review) */
export function pctText(p: number): number {
  return p >= 100 ? 100 : Math.min(99, Math.round(p))
}

/** "週の使い切り率: 直近 87%・平均 62%（13週）" — the bars above it carry the same numbers */
export function weeksText(g: HistoryGroup): string {
  const n = g.weeks.length
  const last = pctText(g.weeks[n - 1]?.usedPercent ?? 0)
  const avg = pctText(g.weeks.reduce((a, w) => a + w.usedPercent, 0) / Math.max(1, n))
  return t(`週の使い切り率: 直近 ${last}%・平均 ${avg}%（${n}週）`, `Weekly use: last ${last}%, average ${avg}% (${n} week${n === 1 ? '' : 's'})`)
}
