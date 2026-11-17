import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ToolUsage } from '../../../shared/types.ts'
import { groupUsage, windowName } from './usage.ts'

const NOW = Date.parse('2026-11-17T02:00:00Z')
const week = (pct: number, resetsAt = '2026-11-22T02:00:00.000Z') => ({ minutes: 10080, usedPercent: pct, resetsAt })
const five = (pct: number) => ({ minutes: 300, usedPercent: pct, resetsAt: '2026-11-17T05:00:00.000Z' })

test('one account across profiles and machines is one group; the freshest reading wins', () => {
  const r: ToolUsage = { tool: 'claude', account: '.claude-r', accountKey: 'a1', windows: [week(9)], at: '2026-11-17T01:00:00.000Z' }
  const rs: ToolUsage = { tool: 'claude', account: '.claude-rs', accountKey: 'a1', windows: [week(12)], at: '2026-11-17T01:30:00.000Z' }
  const s: ToolUsage = { tool: 'claude', account: '.claude-s', accountKey: 'a2', windows: [five(20), week(80)], at: '2026-11-17T01:42:00.000Z' }
  const g = groupUsage([{ machine: 'pc-a', usage: [r, s] }, { machine: 'pc-b', usage: [rs] }], NOW)
  assert.deepEqual(
    g.map((x) => [x.names, x.windows.map((w) => [w.minutes, w.usedPercent])]),
    [
      // the fullest week first
      [['pc-a: .claude-s'], [[10080, 80], [300, 20]]],
      [['pc-a: .claude-r', 'pc-b: .claude-rs'], [[10080, 12]]],
    ],
  )
})

test('Claude before Codex; no account key is its own group; a passed reset is dropped', () => {
  const codex: ToolUsage = { tool: 'codex', account: '.codex', plan: 'prolite', windows: [week(54)], at: '2026-11-17T01:00:00.000Z' }
  const lone: ToolUsage = { tool: 'claude', account: '.claude', windows: [week(1, '2026-11-17T01:59:00.000Z')], at: '2026-11-10T00:00:00.000Z' }
  const g = groupUsage([{ machine: 'pc-a', usage: [codex, lone] }, { machine: 'pc-b', usage: [{ ...lone }] }], NOW)
  assert.deepEqual(g.map((x) => [x.tool, x.names.length, x.windows.length]), [['claude', 1, 0], ['claude', 1, 0], ['codex', 1, 1]])
  assert.equal(g[2]!.plan, 'prolite')
})

test('window names: a week, hours, days', () => {
  assert.match(windowName(10080), /週|Week/)
  assert.match(windowName(300), /5/)
  assert.match(windowName(2880), /2/)
})
