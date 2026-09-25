#!/usr/bin/env node
// Aggregate `~/.nyan-remote/traffic.jsonl` (`npm run traffic`).
//
// ★ What the numbers are for (ARCHITECTURE §14.1.1):
//  - With `relay` as the default in ③, **every byte goes through Cloudflare**
//    (⚠️ we rejected WebRTC, so it is not "relay at first, then P2P")
//  - ⇒ **bandwidth becomes the main cost**. We need a basis for pricing (§14.1.1.5) and relay limits
//  - ★★ and "the number of round trips" is **an input to protocol design** (over the relay the RTT is 2x or more)
//
// ⚠️ What is measured is **plaintext size between agent ↔ tailscale serve**. Over the relay the encryption
//    overhead is small, so it is a good enough approximation.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { t } from '../shared/i18n.ts'
import { initCliLang } from './lib/lang.mjs'

// ★ Language first (before any message is built)
initCliLang()

const stateDir = process.env['NYAN_REMOTE_STATE_DIR'] ?? join(homedir(), '.nyan-remote')
const path = join(stateDir, 'traffic.jsonl')

// ★ Filter by period. ⚠️ **After an improvement, before and after are mixed in the same file**, so
//   reading "how many times bigger" requires cutting by time (`traffic.jsonl` is append-only).
//     npm run traffic -- --since 2026-09-01T10:00              ← given in **local time**
//     npm run traffic -- --since 2026-09-01T10:00 --until 2026-09-01T12:00
// ⚠️ When comparing, cut **the same time of day and the same usage** (night and day usage differ).
function argOf(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
import { toUtcBound } from './lib/timeBound.mjs'

/** ⚠️ The conversion itself is in `lib/timeBound.mjs` (split out so it can be tested) */
function bound(raw, what) {
  if (raw === undefined) return undefined
  const b = toUtcBound(raw)
  // ⚠️ Never use a "possible value" as a sentinel: an unreadable argument is **never silently "all records"** (you would not notice)
  if (!b) {
    console.error(t(`✗ --${what} の日時が読めません: ${raw}`, `✗ Cannot read the date/time for --${what}: ${raw}`))
    console.error(
      t('  例: --%s 2026-09-01  /  --%s 2026-09-01T10:00（ローカル時刻）', '  e.g. --%s 2026-09-01  /  --%s 2026-09-01T10:00 (local time)').replaceAll('%s', what),
    )
    process.exit(2)
  }
  return b
}

const sinceArg = bound(argOf('since'), 'since')
const untilArg = bound(argOf('until'), 'until')
const since = sinceArg?.iso
const until = untilArg?.iso

let text
try {
  text = readFileSync(path, 'utf8')
} catch {
  console.error(t(`✗ ${path} がありません。`, `✗ ${path} does not exist.`))
  console.error(
    t(
      '  agent が計測つきの版で動いていますか（起動ログに [agent] state: が出た版）。',
      '  Is the agent a version with measurement (one that logs [agent] state: at startup)?',
    ),
  )
  console.error(t('  ⚠️ NYAN_REMOTE_NO_MEASURE=1 が付いていると測りません。', '  ⚠️ Nothing is measured when NYAN_REMOTE_NO_MEASURE=1 is set.'))
  process.exit(1)
}

/** Drop broken lines (⚠️ an append-only file can be read mid-line / CLAUDE.md §5) */
const recs = []
for (const line of text.split('\n')) {
  if (!line.trim()) continue
  try {
    const r = JSON.parse(line)
    if (!r || typeof r.at !== 'string') continue
    // ★ Strings compare in lexical order (ISO 8601). A short argument becomes a prefix match
    if (since !== undefined && r.at < since) continue
    if (until !== undefined && r.at >= until) continue
    recs.push(r)
  } catch {
    // a partially written line
  }
}

if (recs.length === 0) {
  if (since !== undefined || until !== undefined) {
    console.error(
      t(
        `✗ 指定した期間に記録がありません（${sinceArg?.shown ?? '—'} 〜 ${untilArg?.shown ?? '—'} ローカル` +
          ` ＝ UTC ${since ?? '—'} 〜 ${until ?? '—'}）`,
        `✗ No records in that period (${sinceArg?.shown ?? '—'} – ${untilArg?.shown ?? '—'} local` +
          ` = UTC ${since ?? '—'} – ${until ?? '—'})`,
      ),
    )
    console.error(t('  ⚠️ 記録は UTC ですが、指定は**ローカル時刻**として読んでいます。', '  ⚠️ Records are in UTC, but the given times are read as **local time**.'))
  } else {
    console.error(t('✗ 有効な行がありません（まだ1分経っていない？）', '✗ No valid lines (has a minute not passed yet?)'))
  }
  process.exit(1)
}

const MB = 1024 * 1024
const fmt = (b) => (b >= MB ? `${(b / MB).toFixed(2)} MB` : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`)

// Fold per day
const byDay = new Map()
for (const r of recs) {
  const day = r.at.slice(0, 10)
  const d = byDay.get(day) ?? { routes: new Map(), conns: { n: 0, out: 0, in: 0 }, windows: 0 }
  d.windows += 1
  for (const [k, v] of Object.entries(r.routes ?? {})) {
    const cur = d.routes.get(k) ?? { n: 0, out: 0 }
    cur.n += v.n ?? 0
    cur.out += v.out ?? 0
    d.routes.set(k, cur)
  }
  d.conns.n += r.conns?.n ?? 0
  d.conns.out += r.conns?.out ?? 0
  d.conns.in += r.conns?.in ?? 0
  byDay.set(day, d)
}

const days = [...byDay.keys()].sort()
// ★ Print **both** the typed value (local) and the value actually compared (UTC)
//   ⚠️ With only one you cannot notice they are off (we actually did not notice)
const range =
  since !== undefined || until !== undefined
    ? t(
        `  [${sinceArg?.shown ?? '—'} 〜 ${untilArg?.shown ?? '—'} ローカル / UTC では ${since ?? '—'} 〜 ${until ?? '—'}]`,
        `  [${sinceArg?.shown ?? '—'} – ${untilArg?.shown ?? '—'} local / UTC ${since ?? '—'} – ${until ?? '—'}]`,
      )
    : ''
console.log(
  t(
    `計測: ${recs.length} 窓 / ${days.length} 日（${days[0]} 〜 ${days[days.length - 1]}）${range}\n`,
    `Measured: ${recs.length} windows / ${days.length} days (${days[0]} – ${days[days.length - 1]})${range}\n`,
  ),
)

for (const day of days) {
  const d = byDay.get(day)
  const total = d.conns.out + d.conns.in
  console.log(t(`── ${day} ──（${d.windows} 分ぶん記録）`, `── ${day} ── (${d.windows} min recorded)`))
  console.log(
    t(
      `   総量: ${fmt(total)}（下り ${fmt(d.conns.out)} / 上り ${fmt(d.conns.in)}）  接続 ${d.conns.n} 本`,
      `   Total: ${fmt(total)} (down ${fmt(d.conns.out)} / up ${fmt(d.conns.in)})  connections: ${d.conns.n}`,
    ),
  )

  const rows = [...d.routes.entries()].sort((a, b) => b[1].out - a[1].out)
  const reqs = rows.reduce((s, [, v]) => s + v.n, 0)
  console.log(t(`   ★ 往復 ${reqs} 回（= relay 越しなら RTT がこの回数ぶん効く）`, `   ★ ${reqs} round trips (= over the relay, the RTT is paid this many times)`))
  console.log(t('   内訳（下りの多い順）:', '   Breakdown (most downstream first):'))
  for (const [k, v] of rows.slice(0, 12)) {
    const share = total > 0 ? ((v.out / total) * 100).toFixed(1) : '0.0'
    console.log(`     ${String(v.n).padStart(6)} ${t('回', 'x')}  ${fmt(v.out).padStart(10)}  ${share.padStart(5)}%  ${k}`)
  }
  if (rows.length > 12) console.log(t(`     …ほか ${rows.length - 12} 種`, `     …and ${rows.length - 12} more`))
  console.log()
}

// ★ Inputs for decisions (pricing and limits)
const last = byDay.get(days[days.length - 1])
if (last && last.windows >= 60) {
  const perDay = last.conns.out + last.conns.in
  console.log(t('★ ここから読めること:', '★ What this tells you:'))
  console.log(t(`   1人あたり月 ${fmt(perDay * 30)}（この日のペースが続いた場合）`, `   ${fmt(perDay * 30)} per user per month (if this day's pace continues)`))
  console.log(t(`   1万人なら月 ${fmt(perDay * 30 * 10_000)} が relay を通る`, `   With 10,000 users, ${fmt(perDay * 30 * 10_000)} per month goes through the relay`))
  console.log(
    t(
      '   ⚠️ Cloudflare Workers に egress 課金は無いが、リクエスト数と CPU 時間は課金対象。',
      '   ⚠️ Cloudflare Workers has no egress charge, but requests and CPU time are billed.',
    ),
  )
  console.log(
    t(
      '   ⚠️ WebSocket は「接続確立」だけが1リクエスト（メッセージは課金されない）。',
      '   ⚠️ For WebSocket only the connection setup counts as a request (messages are not billed).',
    ),
  )
} else {
  console.log(
    t(
      `⚠️ まだ ${last?.windows ?? 0} 分ぶんしかありません（1日分＝1440分たまってから読むこと）。`,
      `⚠️ Only ${last?.windows ?? 0} min recorded so far (read it after a full day = 1440 min).`,
    ),
  )
}
