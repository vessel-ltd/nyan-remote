// ★★ Compare "the list text" with "the notification text" (no phone needed / 2026-08-21).
//
// ⚠️ Because the decision was written in two places, exhaustive testing found 65/96 mismatches
//    (`docs/ARCHITECTURE.md §6.2.0.3`). As a guard after unifying them,
//    compare the real thing on **the sessions alive right now**.
//
// ⚠️⚠️ **It is a separate process, so it must provide the agent's memory (hook records, approval cards) itself.**
//    2026-08-21 `/code-review` low #5: that was not filled in, so both sides computed with
//    "no hooks, no cards" = **green without ever testing the two axes that cause
//    mismatches**. ⇒ Hooks are restored with `seedHookState()`, and
//    cards are fetched from the running agent's `/permissions`.
//
// Usage: node scripts/notify-check.mjs
//   exit code 0 = match (and every axis was tested) / 1 = mismatch / 2 = some axis was not tested
import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { loadConfig, config } from '../agent/src/config.ts'
import { discoverConfigDirs } from '../agent/src/claude/configDirs.ts'
import { collectSessions } from '../agent/src/claude/sessions.ts'
import { probeStatus, settledLabel } from '../agent/src/routes/hook.ts'
import { hooksFor, seedHookState } from '../agent/src/claude/hookState.ts'
import { readNotifyMeta } from '../agent/src/notify.ts'
import { statusLabel, waitingReason } from '../shared/types.ts'
import { t } from '../shared/i18n.ts'
import { initCliLang, agentUrl } from './lib/lang.mjs'

// ★ Language first (before any message is built)
initCliLang()

await loadConfig()
// ★ Restore the hook records (without this "Done" is never tested)
const seeded = await seedHookState()

/**
 * ★ Approval cards exist only in the agent's memory, so fetch them over HTTP (same shape as `scripts/pending.mjs`).
 * ⚠️ **Cards waiting quietly (during `quietUntil`) are not in this list**, so
 *    take just the count and state explicitly that "some are not visible". To avoid a false green.
 */
async function fetchCards() {
  try {
    const cfg = JSON.parse(readFileSync(`${homedir()}/.nyan-remote/config.json`, 'utf8'))
    const login = cfg.allowedLogins?.[0]
    if (!login) return { ids: new Set(), quiet: 0, ok: false, why: t('allowedLogins が空', 'allowedLogins is empty') }
    const res = await fetch(agentUrl(cfg.port ?? 7777, '/permissions'), {
      headers: { 'Tailscale-User-Login': login, 'X-Forwarded-Proto': 'https' },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return { ids: new Set(), quiet: 0, ok: false, why: `HTTP ${res.status}` }
    const j = await res.json()
    return {
      ids: new Set((j.permissions ?? []).map((p) => p.sessionId).filter(Boolean)),
      quiet: j.quiet ?? 0,
      ok: true,
      why: '',
    }
  } catch (err) {
    return { ids: new Set(), quiet: 0, ok: false, why: err instanceof Error ? err.message : String(err) }
  }
}

const cards = await fetchCards()
const dirs = await discoverConfigDirs(config().configDirs)
const { sessions } = await collectSessions(dirs, 60)
const machine = hostname()
const w = (s, n) => String(s ?? '').padEnd(n).slice(0, n)

const rows = []
for (const s of sessions) {
  if (!s.live) continue
  const event = {
    event: 'Stop',
    machine,
    account: s.account,
    project: s.project,
    sessionId: s.sessionId,
    at: new Date().toISOString(),
  }
  const probe = await probeStatus(event)
  const meta = await readNotifyMeta(s.account, s.sessionId)
  const card = cards.ids.has(s.sessionId)
  // ⚠️ Pass the same inputs the list uses (otherwise false mismatches appear)
  const notif = settledLabel(event, probe, {
    hooks: hooksFor(s.sessionId),
    ...(meta?.lastActivity ? { lastActivity: meta.lastActivity } : {}),
    hasPendingApproval: card,
  })
  const why = s.status === 'waiting' ? waitingReason(s.waitingFor) : null
  const list = why ? `${statusLabel(s.status)}（${why}）` : statusLabel(s.status)
  rows.push({ id: s.sessionId.slice(0, 8), acct: s.account, title: s.title ?? '', list, notif, probe, card, ok: list === notif })
}

console.log(
  t(
    `フックの記録: ${seeded} 件を復元 / 承認の札: ${cards.ok ? `${cards.ids.size} 件（静かに待っているもの ${cards.quiet} 件）` : `⚠️ 取れなかった（${cards.why}）`}`,
    `Hook records: ${seeded} restored / approval cards: ${cards.ok ? `${cards.ids.size} (${cards.quiet} waiting quietly)` : `⚠️ could not get them (${cards.why})`}`,
  ),
)
if (!cards.ok) {
  console.log(
    t(
      '⚠️ 札が取れていないので、承認待ちの食い違いは**試せていません**（agent が動いているか確認）',
      '⚠️ No approval cards, so pending-approval mismatches were **not tested** (check the agent is running)',
    ),
  )
} else if (cards.quiet > 0) {
  console.log(t('⚠️ 静かに待っている札は一覧に出ないので、その分は試せていません', '⚠️ Quietly waiting cards are not listed, so those were not tested'))
}
console.log(t(`\n生きているセッション: ${rows.length}`, `\nLive sessions: ${rows.length}`))
console.log(
  `${w('id', 9)}${w('acct', 11)}${w(t('題名', 'title'), 22)}${w(t('一覧', 'list'), 18)}${w(t('通知', 'notify'), 18)}${w('probe', 14)}${w(t('札', 'card'), 5)}${t('判定', 'result')}`,
)
for (const r of rows.sort((a, b) => Number(a.ok) - Number(b.ok))) {
  const p = r.probe.kind === 'live' ? `live/${r.probe.status ?? '?'}` : r.probe.kind
  console.log(
    `${w(r.id, 9)}${w(r.acct, 11)}${w(r.title, 22)}${w(r.list, 18)}${w(r.notif, 18)}${w(p, 14)}${w(r.card ? t('有', 'yes') : t('無', 'no'), 5)}${r.ok ? t('一致', 'match') : t('⚠️ 食い違い', '⚠️ mismatch')}`,
  )
}
const bad = rows.filter((r) => !r.ok).length
console.log(t(`\n食い違い: ${bad} / ${rows.length}`, `\nMismatches: ${bad} / ${rows.length}`))

// ★★ **No green if nothing was tested** (2026-08-21 codex review, medium #6).
//    ⚠️⚠️ Returning exit code 0 for "mismatches 0 / 0" is **false reassurance** itself.
//    The docs say "run this before looking at the phone", so
//    if this is green you will think "checked".
const blockers = []
if (rows.length === 0) blockers.push(t('生きているセッションが無い（比べるものが無い）', 'no live sessions (nothing to compare)'))
if (seeded === 0) blockers.push(t('フックの記録が0件（「完了」の判定を一度も試していない）', 'no hook records (the "Done" decision was never tested)'))
if (!cards.ok) blockers.push(t(`承認の札が取れていない（${cards.why}）`, `could not get approval cards (${cards.why})`))
if (cards.quiet > 0) blockers.push(t(`静かに待っている札が ${cards.quiet} 件（その軸は試せていない）`, `${cards.quiet} card(s) waiting quietly (that axis was not tested)`))

if (bad > 0) {
  console.log(t('\n✗ 食い違いがある', '\n✗ There are mismatches'))
  process.exit(1)
}
if (blockers.length > 0) {
  console.log(t('\n△ 試せていない軸がある（緑にはしない）:', '\n△ Some axes were not tested (not reporting green):'))
  for (const b of blockers) console.log(`   - ${b}`)
  process.exit(2)
}
console.log(t('\n✔ 一致（フックの記録と承認の札の両方を通して比べた）', '\n✔ All match (compared through both hook records and approval cards)'))
process.exit(0)
