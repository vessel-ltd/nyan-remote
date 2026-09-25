import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bannerText, pushBadge, pushKind, showsBanner, type PushKind } from './pushState.ts'

const base = { supported: true, permission: 'granted' as NotificationPermission, registered: 2, total: 2, failure: undefined, off: false }

test('★★ state decision (failure before "registered"; a user stop is not nagged)', () => {
  assert.equal(pushKind(base), 'ok')
  assert.equal(pushKind({ ...base, registered: 1 }), 'partial')
  assert.equal(pushKind({ ...base, registered: 0 }), 'unset')
  assert.equal(pushKind({ ...base, registered: 0, off: true }), 'off')
  assert.equal(pushKind({ ...base, permission: 'denied' }), 'blocked')
  assert.equal(pushKind({ ...base, supported: false }), 'unsupported')
  // ⚠️⚠️ Registered but not delivered is "failing" (do not look "enabled" / the 3 days of 2026-08-21)
  assert.equal(pushKind({ ...base, failure: { status: 403, at: '2026-09-24T00:00:00Z' } }), 'failing')
})

test('★★ the list shows a banner only for states needing action; nothing when healthy', () => {
  const all: PushKind[] = ['unsupported', 'blocked', 'failing', 'off', 'unset', 'partial', 'ok']
  assert.deepEqual(all.filter(showsBanner), ['blocked', 'failing', 'unset'])
  assert.equal(showsBanner('unregistered'), true, '⚠️⚠️ no banner although registration failed')
  // ⚠️⚠️ Failure always gets a banner (never folded away)
  assert.equal(showsBanner('failing'), true)
  assert.match(bannerText('failing'), /届いていません/)
})

test('★★ header badge (🔔 when healthy, count when partial, ⚠ on failure, none where unsupported)', () => {
  assert.equal(pushBadge('ok', 2, 2), '🔔')
  assert.equal(pushBadge('partial', 2, 4), '🔔 2/4')
  assert.equal(pushBadge('failing', 2, 2), '⚠')
  assert.equal(pushBadge('off', 0, 2), '🔕')
  assert.equal(pushBadge('unsupported', 0, 2), undefined)
})

test('★★ the list is "list" (banner only on trouble); settings is "settings" (always everything)', async () => {
  const { readFileSync } = await import('node:fs')
  const main = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8')
  const settings = readFileSync(new URL('./Endpoints.tsx', import.meta.url), 'utf8')
  assert.match(main, /<PushPanel transports=\{transports\} mode="list" onOpenSettings=\{openSettings\} onSummary=\{setPushInfo\} \/>/)
  assert.match(settings, /<PushPanel transports=\{transports\} mode="settings" \/>/)
  // ⚠️⚠️ The banner goes through the decision function (conditions hand-written in the screen could fold failures again)
  const panel = readFileSync(new URL('./PushPanel.tsx', import.meta.url), 'utf8')
  assert.match(panel, /if \(!showsBanner\(kind\)\) return null/)
})

test('★★ a registration failure is "failing" even if some registered (keep the banner / codex round 19, medium #3)', () => {
  assert.equal(pushKind({ ...base, registered: 1, syncProblem: 'B: 403' }), 'unregistered')
  assert.equal(pushKind({ ...base, syncProblem: 'x' }), 'unregistered')
  // ⚠️ Not delivered (a send failure) is stronger than that
  assert.equal(pushKind({ ...base, syncProblem: 'x', failure: { status: 403, at: 'T' } }), 'failing')
  assert.equal(pushBadge('unregistered', 1, 2), '⚠')
  assert.match(bannerText('unregistered'), /登録できませんでした/)
})
