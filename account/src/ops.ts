// ★★ Ops watcher (2026-09-25 / user requests a and c).
//   c: the `/admin` page (counts of accounts, Plus and machines, plus Cloudflare usage)
//   a: check usage every hour, and email once if there is something to report (`scheduled` in `worker.ts`)
//   ★★ Moved to Workers Paid ($5/month) on 2026-09-25 ⇒ the daily free tier (100k) is gone, so watch **the monthly included amount**:
//      ① if the projection of any kind for this month (average so far × days in month) looks set to exceed the included amount, once that month
//      ② a daily spike (`spikeDailyRequests`) once that day (a sign of overuse, runaway or attack)
// ⚠️ Decisions live here (runs from `npm test`). Cloudflare's hooks (D1, email, GraphQL) are wired in `worker.ts`.
// ⚠️ Only counts are shown (no personal GitHub names or machine names).

import { esc } from './pages.ts'

/** ★ One day of usage (UTC date) */
export interface UsageDay {
  date: string
  /** Requests per worker */
  workers: Record<string, number>
  errors: number
  /** Durable Object requests */
  durableObjects: number
  /** Seconds the Durable Objects were awake */
  activeSec: number
}

export interface Stats {
  accounts: number
  accountsNew7d: number
  plus: number
  /** Accounts with two or more subscriptions (double billing) */
  duplicateSubs: number
  machines: number
  machines24h: number
  machines7d: number
}

/**
 * ★ The amounts included in Workers Paid ($5/month) and the overage prices ($ / million).
 *   ⚠️ A copy of public pricing as of 2026-09 (may change ⇒ confirm on Cloudflare's billing page in the end).
 *   ⚠️ DO time (GB-seconds) is estimated as "seconds awake × 128MB".
 */
export const PAID_INCLUDED = { workerRequests: 10_000_000, doRequests: 1_000_000, doGbSec: 400_000 } as const
export const OVERAGE_PER_MILLION = { workerRequests: 0.3, doRequests: 0.15, doGbSec: 12.5 } as const
type Kind = keyof typeof PAID_INCLUDED
const KINDS: Kind[] = ['workerRequests', 'doRequests', 'doGbSec']
const LABEL: Record<Kind, string> = { workerRequests: 'Worker requests', doRequests: 'Durable Object requests', doGbSec: 'Durable Object duration (GB-s)' }
const DO_GB = 0.128

/** ★ Default daily spike threshold (requests = worker + DO). ⚠️ Currently just under 200k even on busy days */
export const DEFAULT_SPIKE_DAILY = 300_000

export const dayTotal = (d: UsageDay) => Object.values(d.workers).reduce((a, b) => a + b, 0) + d.durableObjects

export interface MonthUsage {
  /** `2026-09` */
  month: string
  /** Days elapsed this month (including today) and days in the month */
  days: number
  daysInMonth: number
  used: Record<Kind, number>
  /** End-of-month projection (average so far × days in month) */
  projected: Record<Kind, number>
  /** Cost ($) of what the projection exceeds beyond the included amount */
  projectedOverageUsd: number
}

/** ★ Summarise this month (UTC month) */
export function monthUsage(days: UsageDay[], now: number): MonthUsage {
  const d = new Date(now)
  const month = d.toISOString().slice(0, 7)
  const elapsed = d.getUTCDate()
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  const mine = days.filter((x) => x.date.startsWith(month))
  const used: Record<Kind, number> = {
    workerRequests: mine.reduce((a, x) => a + Object.values(x.workers).reduce((p, q) => p + q, 0), 0),
    doRequests: mine.reduce((a, x) => a + x.durableObjects, 0),
    doGbSec: Math.round(mine.reduce((a, x) => a + x.activeSec, 0) * DO_GB),
  }
  // ⚠️ Today is still in progress ⇒ dividing by "days elapsed" reads low early in the month (alerts lean late, but spikes are caught by ②)
  const projected = Object.fromEntries(KINDS.map((k) => [k, Math.round((used[k] / elapsed) * daysInMonth)])) as Record<Kind, number>
  const projectedOverageUsd = KINDS.reduce((a, k) => a + (Math.max(0, projected[k] - PAID_INCLUDED[k]) / 1e6) * OVERAGE_PER_MILLION[k], 0)
  return { month, days: elapsed, daysInMonth, used, projected, projectedOverageUsd }
}

const n = (v: number) => v.toLocaleString('en-US')

/**
 * ★★ What to report (a). Once per `key` (the caller checks with `alerted` / `markAlert`).
 *   ① month: kinds whose projection exceeds the included amount (once that month) ② day: spikes (once that day)
 */
export function usageAlerts(days: UsageDay[], now: number, spikeDaily: number): { key: string; subject: string; text: string }[] {
  const m = monthUsage(days, now)
  const out: { key: string; subject: string; text: string }[] = []
  for (const k of KINDS) {
    if (m.projected[k] <= PAID_INCLUDED[k]) continue
    out.push({
      key: `month:${m.month}:${k}`,
      subject: `[nyan-remote] ${LABEL[k]} projected over the included amount (${m.month})`,
      text: [
        `${LABEL[k]} this month (${m.days}/${m.daysInMonth} days): ${n(m.used[k])}`,
        `Projected for the month: ${n(m.projected[k])} (included: ${n(PAID_INCLUDED[k])})`,
        `Projected overage for all kinds: about $${m.projectedOverageUsd.toFixed(2)}`,
        '',
        'Details: https://account.nyan-remote.app/admin',
      ].join('\n'),
    })
  }
  const date = new Date(now).toISOString().slice(0, 10)
  const today = days.find((x) => x.date === date)
  if (today && dayTotal(today) >= spikeDaily) {
    out.push({
      key: `spike:${date}`,
      subject: `[nyan-remote] Unusual Cloudflare traffic today: ${n(dayTotal(today))} requests (${date})`,
      text: [
        `Requests today (UTC ${date}): ${n(dayTotal(today))} (alert at ${n(spikeDaily)})`,
        `  Durable Objects: ${n(today.durableObjects)}`,
        ...Object.entries(today.workers).map(([k, v]) => `  ${k}: ${n(v)}`),
        `  errors: ${today.errors}`,
        '',
        'Details: https://account.nyan-remote.app/admin',
      ].join('\n'),
    })
  }
  return out
}

/** ★ Group Cloudflare's GraphQL answer by day (⚠️ throws on a wrong shape = the page shows "unreadable") */
export function parseUsage(j: unknown): UsageDay[] {
  const a = (j as { data?: { viewer?: { accounts?: unknown[] } } })?.data?.viewer?.accounts?.[0] as
    | {
        w?: { sum: { requests: number; errors: number }; dimensions: { date: string; scriptName: string } }[]
        d?: { sum: { requests: number }; dimensions: { date: string } }[]
        p?: { sum: { activeTime: number }; dimensions: { date: string } }[]
      }
    | undefined
  if (!a || !Array.isArray(a.w) || !Array.isArray(a.d) || !Array.isArray(a.p)) throw new Error('unexpected analytics response')
  const days = new Map<string, UsageDay>()
  const day = (date: string) => {
    let d = days.get(date)
    if (!d) days.set(date, (d = { date, workers: {}, errors: 0, durableObjects: 0, activeSec: 0 }))
    return d
  }
  for (const x of a.w) {
    const d = day(x.dimensions.date)
    d.workers[x.dimensions.scriptName] = (d.workers[x.dimensions.scriptName] ?? 0) + x.sum.requests
    d.errors += x.sum.errors
  }
  for (const x of a.d) day(x.dimensions.date).durableObjects += x.sum.requests
  for (const x of a.p) day(x.dimensions.date).activeSec += Math.round(x.sum.activeTime / 1e6)
  return [...days.values()].sort((x, y) => (x.date < y.date ? -1 : 1))
}

export const USAGE_QUERY = `query($a:String!,$s:Date!){viewer{accounts(filter:{accountTag:$a}){
 w: workersInvocationsAdaptive(limit:1000, filter:{date_geq:$s}){ sum{requests errors} dimensions{date scriptName} }
 d: durableObjectsInvocationsAdaptiveGroups(limit:1000, filter:{date_geq:$s}){ sum{requests} dimensions{date} }
 p: durableObjectsPeriodicGroups(limit:1000, filter:{date_geq:$s}){ sum{activeTime} dimensions{date} }
}}}`

/** ★ The `/admin` page (⚠️ no scripts, counts only) */
const ADMIN_NOTICE: Record<string, string> = {
  sent: 'Test email sent. Check your inbox (and spam).',
  failed: 'Could not send the test email (see Workers Logs for nyan-account).',
  'no-mail': 'Email is not configured.',
}

export function adminPage(o: { stats: Stats; usage: UsageDay[] | string; spikeDaily: number; now: number; alertTo?: string; notice?: string }): string {
  const s = o.stats
  const usage =
    typeof o.usage === 'string'
      ? `<p class="card">Cloudflare usage: ${esc(o.usage)}</p>`
      : monthTable(monthUsage(o.usage, o.now)) +
        `<table><tr><th>Date (UTC)</th><th>Total</th><th>DO</th><th>Workers</th><th>Errors</th><th>DO active</th></tr>${[...o.usage]
          .reverse()
          .slice(0, 14)
          .map((d) => {
            const total = dayTotal(d)
            const hot = total >= o.spikeDaily ? ' class="hot"' : ''
            return `<tr${hot}><td>${esc(d.date)}</td><td>${n(total)}</td><td>${n(d.durableObjects)}</td><td>${esc(
              Object.entries(d.workers)
                .map(([k, v]) => `${k.replace(/^nyan-/, '')} ${n(v)}`)
                .join(', '),
            )}</td><td>${n(d.errors)}</td><td>${n(d.activeSec)}s</td></tr>`
          })
          .join('')}</table>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>nyan-remote admin</title>
<style>
:root{color-scheme:light dark;--bg:#0b0d10;--fg:#e8edf2;--dim:#9aa4af;--card:#151a20;--line:#27303a;--hot:#d9534f}
@media (prefers-color-scheme:light){:root{--bg:#f6f7f9;--fg:#15191e;--dim:#5b6570;--card:#fff;--line:#dfe3e8}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,sans-serif}
main{max-width:900px;margin:0 auto;padding:24px 16px 48px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.big{font-size:1.6rem;font-weight:700}.dim{color:var(--dim);font-size:.9rem}
table{width:100%;border-collapse:collapse;font-size:.9rem;display:block;overflow-x:auto}
th,td{text-align:left;padding:6px 8px;border-top:1px solid var(--line);white-space:nowrap}
tr.hot td{color:var(--hot);font-weight:600}
a{color:inherit}
</style></head><body><main>
<p><a href="/">← Account</a></p>
<h1>Admin</h1>
${o.notice && ADMIN_NOTICE[o.notice] ? `<p class="card">${esc(ADMIN_NOTICE[o.notice]!)}</p>` : ''}
<div class="grid">
<div class="card"><div class="dim">Accounts</div><div class="big">${n(s.accounts)}</div><div class="dim">+${n(s.accountsNew7d)} in 7 days</div></div>
<div class="card"><div class="dim">Plus</div><div class="big">${n(s.plus)}</div>${s.duplicateSubs ? `<div class="dim" style="color:var(--hot)">${n(s.duplicateSubs)} with duplicate subscriptions</div>` : ''}</div>
<div class="card"><div class="dim">Machines</div><div class="big">${n(s.machines)}</div><div class="dim">${n(s.machines24h)} active 24h · ${n(s.machines7d)} active 7d</div></div>
</div>
<h2>Cloudflare usage</h2>
<p class="dim">Workers Paid ($5/month). Alerts: a kind projected over its included amount (once a month), or a day over ${n(o.spikeDaily)} requests (once a day)${o.alertTo ? ` → ${esc(o.alertTo)}` : ' — ⚠️ no alert address configured'}.</p>
${usage}
<form method="post" action="/admin/test-alert"><button>Send a test alert email</button></form>
</main></body></html>`
}

function monthTable(m: MonthUsage): string {
  const row = (k: Kind) => {
    const over = m.projected[k] > PAID_INCLUDED[k]
    return `<tr${over ? ' class="hot"' : ''}><td>${esc(LABEL[k])}</td><td>${n(m.used[k])}</td><td>${n(m.projected[k])}</td><td>${n(PAID_INCLUDED[k])}</td><td>${Math.round((m.projected[k] / PAID_INCLUDED[k]) * 100)}%</td></tr>`
  }
  return `<h3>This month (${esc(m.month)}, day ${m.days} of ${m.daysInMonth})</h3>
<table><tr><th>Kind</th><th>So far</th><th>Projected</th><th>Included</th><th>Projected / included</th></tr>${KINDS.map(row).join('')}</table>
<p class="dim">Projected overage: about $${m.projectedOverageUsd.toFixed(2)} on top of $5 (estimate from public prices; the Cloudflare billing page is authoritative).</p>
<h3>By day</h3>`
}
