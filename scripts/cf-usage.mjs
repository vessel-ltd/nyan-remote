#!/usr/bin/env node
// ★ Print Cloudflare usage per day (2026-09-25). `npm run cf`
//   ⚠️ Read-only token (CLOUDFLARE_READ_LOGS_KEY in `.env` / permission: Account Analytics: Read).
//   Columns: requests and errors per worker, Durable Object requests (⚠️ counted toward the 100k/day free quota / CLAUDE.md §2), DO wall-clock seconds.
import { readFileSync } from 'node:fs'
for (const line of (() => { try { return readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n') } catch { return [] } })()) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}
if (!process.env.CLOUDFLARE_READ_LOGS_KEY) {
  console.error('CLOUDFLARE_READ_LOGS_KEY is not set (.env)')
  process.exit(2)
}
const tok = process.env.CLOUDFLARE_READ_LOGS_KEY, acct = 'de3117b74037f67ec29c1db3c5b67213'
const since = new Date(Date.now() - Number(process.argv[2] ?? 8) * 86400e3).toISOString().slice(0, 10)
const q = `query($a:String!,$s:Date!){viewer{accounts(filter:{accountTag:$a}){
 w: workersInvocationsAdaptive(limit:500, filter:{date_geq:$s}){ sum{requests errors} dimensions{date scriptName} }
 d: durableObjectsInvocationsAdaptiveGroups(limit:500, filter:{date_geq:$s}){ sum{requests} dimensions{date} }
 p: durableObjectsPeriodicGroups(limit:500, filter:{date_geq:$s}){ sum{activeTime cpuTime} dimensions{date} }
}}}`
const r = await fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ query: q, variables: { a: acct, s: since } }) })
const j = await r.json()
if (j.errors) { console.log(JSON.stringify(j.errors, null, 1)); process.exit(1) }
const a = j.data.viewer.accounts[0]
const days = {}
for (const x of a.w) { const d = (days[x.dimensions.date] ??= {}); d[x.dimensions.scriptName] = (d[x.dimensions.scriptName] ?? 0) + x.sum.requests; d.err = (d.err ?? 0) + x.sum.errors }
for (const x of a.d) (days[x.dimensions.date] ??= {}).DO = x.sum.requests
for (const x of a.p) { const d = (days[x.dimensions.date] ??= {}); d.activeSec = Math.round(x.sum.activeTime / 1e6); }
for (const [k, v] of Object.entries(days).sort()) console.log(k, JSON.stringify(v))
