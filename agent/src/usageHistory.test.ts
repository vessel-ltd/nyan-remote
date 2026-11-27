// ★ Usage history kept on this PC (2026-11-27 / `usageHistory.ts`)
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ToolUsage } from '../../shared/types.ts'
import { HISTORY_DAYS, UsageHistory, hitId, parseLine } from './usageHistory.ts'

const DAY = 24 * 60 * 60_000
const T0 = Date.parse('2026-11-27T00:00:00Z')

function place(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-usage-history-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'usage-history.jsonl')
}

function rig(path: string, start = T0) {
  let now = start
  const logs: string[] = []
  const make = () => {
    const h = new UsageHistory({ path, now: () => now, log: (l) => logs.push(l) })
    h.load()
    return h
  }
  return { make, logs, at: (ms: number) => (now = ms), now: () => now }
}

const claude = (week: number, five: number, weekReset: string, fiveReset: string, over: Partial<ToolUsage> = {}): ToolUsage => ({
  tool: 'claude',
  account: '.claude-r',
  accountKey: 'k1',
  email: 'someone@example.com',
  org: 'Example Org',
  windows: [
    { minutes: 7 * 24 * 60, usedPercent: week, resetsAt: weekReset },
    { minutes: 300, usedPercent: five, resetsAt: fiveReset },
  ],
  at: new Date(T0).toISOString(),
  ...over,
})

const lines = (path: string) => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)

test('★ samples: written only when a login\'s readings change; never the e-mail or the organization; 0600', async (t) => {
  const path = place(t)
  const r = rig(path)
  const h = r.make()
  await h.sample([claude(10.4, 50, '2026-12-01T00:00:00Z', '2026-11-27T05:00:00Z')])
  await h.sample([claude(10.2, 50, '2026-12-01T00:00:00Z', '2026-11-27T05:00:00Z')])
  assert.equal(lines(path).length, 1, 'the same readings (rounded) are not written again')
  await h.sample([claude(12, 50, '2026-12-01T00:00:00Z', '2026-11-27T05:00:00Z')])
  assert.equal(lines(path).length, 2)
  await h.sample([claude(12, 50, '2026-12-01T00:00:00Z', '2026-11-27T05:00:00Z', { accountKey: 'k2' })])
  assert.equal(lines(path).length, 3, 'another account behind the profile is written')
  await h.sample([{ ...claude(1, 1, '2026-12-01T00:00:00Z', '2026-11-27T05:00:00Z', { accountKey: 'k2' }), windows: [] }])
  assert.equal(lines(path).length, 3, 'no windows and the same account: nothing to write')
  const text = readFileSync(path, 'utf8')
  assert.doesNotMatch(text, /example\.com|Example Org/, '⚠️⚠️ who is logged in reached the history')
  assert.equal(statSync(path).mode & 0o777, 0o600)
  // A restart does not write the unchanged readings again
  const again = r.make()
  await again.sample([claude(12, 50, '2026-12-01T00:00:00Z', '2026-11-27T05:00:00Z', { accountKey: 'k2' })])
  assert.equal(lines(path).length, 3)
})

test('★ summary: finished weeks with their highest use, full 5-hour windows, limit stops counted once', async (t) => {
  const path = place(t)
  const r = rig(path, Date.parse('2026-11-20T00:00:00Z'))
  const h = r.make()
  // Week A (resets 11-24): 40 → 95; its 5-hour windows: one reaches 100, one stops at 80
  await h.sample([claude(40, 100, '2026-11-24T00:00:00Z', '2026-11-20T05:00:00Z')])
  await h.sample([claude(95, 80, '2026-11-24T00:00:10Z', '2026-11-20T10:00:00Z')])
  // Week B (resets 12-01, not over yet at the summary)
  r.at(Date.parse('2026-11-25T00:00:00Z'))
  await h.sample([claude(30, 10, '2026-12-01T00:00:00Z', '2026-11-25T05:00:00Z')])
  assert.equal(await h.hit('claude', '.claude-r', 'session-1:turn-1'), true)
  assert.equal(await h.hit('claude', '.claude-r', 'session-1:turn-1'), false, 'the same stop twice')
  assert.equal(await h.hit('claude', '.claude-r', 'session-1:turn-2'), true)
  await h.settled()
  const s = h.summary()
  assert.equal(s.days, HISTORY_DAYS)
  assert.equal(s.logins.length, 1)
  const l = s.logins[0]!
  assert.equal(l.accountKey, 'k1')
  assert.deepEqual(l.weeks, [{ resetsAt: '2026-11-24T00:00:10.000Z', usedPercent: 95 }], 'one finished week (seconds apart = one window), its highest use')
  assert.deepEqual(l.fiveHourFull, ['2026-11-20T05:00:00.000Z'], 'only the finished window that reached 100%')
  assert.equal(l.limitStops.count, 2)
  assert.equal(l.limitStops.recent.length, 2)
  assert.doesNotMatch(readFileSync(path, 'utf8'), /session-1|turn-1/, '⚠️ only a hash of the stop is kept')
  // ★ Across a restart: the same stop is still counted once, the summary is the same
  const again = r.make()
  assert.equal(await again.hit('claude', '.claude-r', 'session-1:turn-1'), false)
  assert.deepEqual(again.summary(), s)
})

test('loading: malformed lines are skipped, the rest counts', (t) => {
  const path = place(t)
  const good = { v: 1, k: 'hit', at: '2026-11-26T00:00:00.000Z', tool: 'codex', account: '.codex', id: hitId('x') }
  writeFileSync(path, ['not json', JSON.stringify({ v: 2, k: 'hit' }), JSON.stringify({ ...good, tool: 'other' }), JSON.stringify(good), '{"v":1,"k":"s","at":"x"}'].join('\n') + '\n')
  const h = rig(path).make()
  assert.deepEqual(h.summary().logins.map((l) => [l.tool, l.limitStops.count]), [['codex', 1]])
  assert.equal(parseLine(JSON.stringify({ ...good, id: '' })), undefined)
  assert.equal(parseLine(JSON.stringify({ v: 1, k: 's', at: good.at, tool: 'agy', account: 'agy', w: [{ m: 300, p: 'x', r: good.at }] })), undefined)
})

test('⚠️ a history file that is a link is neither read nor written', async (t) => {
  const path = place(t)
  const target = `${path}.real`
  writeFileSync(target, '')
  symlinkSync(target, path)
  const r = rig(path)
  const h = r.make()
  await h.sample([claude(10, 10, '2026-12-01T00:00:00Z', '2026-11-27T05:00:00Z')])
  assert.equal(await h.hit('claude', '.claude-r', 's:1'), false)
  await h.settled()
  assert.equal(readFileSync(target, 'utf8'), '')
  assert.ok(r.logs.some((l) => l.includes('not a regular file')))
})

test('★ kept 90 days: older lines are dropped from the file and from the summary', async (t) => {
  const path = place(t)
  const old = { v: 1, k: 'hit', at: new Date(T0 - (HISTORY_DAYS + 5) * DAY).toISOString(), tool: 'agy', account: 'agy', id: hitId('old') }
  const recent = { ...old, at: new Date(T0 - 2 * DAY).toISOString(), id: hitId('recent') }
  writeFileSync(path, [JSON.stringify(old), 'garbage', JSON.stringify(recent)].join('\n') + '\n', { mode: 0o600 })
  const r = rig(path)
  const h = r.make()
  assert.equal(h.summary().logins[0]?.limitStops.count, 1, 'the summary drops what is past')
  // A sample triggers the daily prune
  await h.sample([claude(10, 10, '2026-12-01T00:00:00Z', '2026-11-27T05:00:00Z')])
  await h.settled()
  const kept = lines(path)
  assert.deepEqual(kept.map((l) => l['k']), ['hit', 's'])
  assert.equal(kept[0]!['id'], recent.id)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  // Not again the same day
  writeFileSync(path, readFileSync(path, 'utf8') + JSON.stringify(old) + '\n')
  await h.sample([claude(11, 10, '2026-12-01T00:00:00Z', '2026-11-27T05:00:00Z')])
  await h.settled()
  assert.equal(lines(path).filter((l) => l['id'] === old.id).length, 1)
})

test('★ switching the account behind a profile starts another login: the old weeks and stops keep their account', async (t) => {
  const path = place(t)
  const r = rig(path, Date.parse('2026-11-20T00:00:00Z'))
  const h = r.make()
  await h.sample([claude(80, 10, '2026-11-24T00:00:00Z', '2026-11-20T05:00:00Z', { accountKey: 'k1' })])
  await h.hit('claude', '.claude-r', 's:1')
  r.at(Date.parse('2026-11-25T00:00:00Z'))
  await h.sample([claude(20, 10, '2026-12-01T00:00:00Z', '2026-11-25T05:00:00Z', { accountKey: 'k2' })])
  await h.hit('claude', '.claude-r', 's:2')
  r.at(Date.parse('2026-12-02T00:00:00Z'))
  const byKey = Object.fromEntries(h.summary().logins.map((l) => [l.accountKey, [l.weeks.map((w) => w.usedPercent), l.limitStops.count]]))
  assert.deepEqual(byKey, { k1: [[80], 1], k2: [[20], 1] })
})

test('★ a window is finished only when its own reset passed; 99.6% is not used up', async (t) => {
  const path = place(t)
  const r = rig(path, Date.parse('2026-11-20T00:00:00Z'))
  const h = r.make()
  await h.sample([claude(50, 99.6, '2026-11-24T00:07:29Z', '2026-11-20T05:00:00Z')])
  r.at(Date.parse('2026-11-24T00:05:00Z'))
  assert.deepEqual(h.summary().logins.flatMap((l) => l.weeks), [], 'a rounded reset would call it finished at 00:00')
  r.at(Date.parse('2026-11-24T00:08:00Z'))
  const l = h.summary().logins[0]!
  assert.equal(l.weeks.length, 1)
  assert.deepEqual(l.fiveHourFull, [], '99.6% is not 100%')
})

test('★ a write that failed is tried again with the next reading; a line cut by a crash is closed first', async (t) => {
  const path = place(t)
  const r = rig(path)
  const h = r.make()
  // The folder is not writable for a moment
  const dir = join(path, '..')
  chmodSync(dir, 0o500)
  try {
    await h.sample([claude(10, 10, '2026-12-01T00:00:00Z', '2026-11-27T05:00:00Z')])
    assert.equal(await h.hit('claude', '.claude-r', 's:9'), false)
  } finally {
    chmodSync(dir, 0o700)
  }
  assert.ok(r.logs.some((l) => l.includes('could not write')))
  await h.sample([claude(10, 10, '2026-12-01T00:00:00Z', '2026-11-27T05:00:00Z')])
  assert.deepEqual(lines(path).map((l) => l['k']), ['hit', 's'], 'both written with the next reading (the stop from aside)')
  assert.equal(await h.hit('claude', '.claude-r', 's:9'), false, 'and not counted twice')
  // A crash left half a line: the next record is not glued to it
  writeFileSync(path, readFileSync(path, 'utf8') + '{"v":1,"k":"hit","at":"2026')
  await h.hit('claude', '.claude-r', 's:10')
  const after = r.make()
  assert.equal(after.summary().logins[0]?.limitStops.count, 2)
})

test('a history folder that does not exist yet is made', async (t) => {
  const base = place(t)
  const path = join(base, '..', 'sub', 'usage-history.jsonl')
  const h = rig(path).make()
  await h.sample([claude(10, 10, '2026-12-01T00:00:00Z', '2026-11-27T05:00:00Z')])
  assert.equal(lines(path).length, 1)
})

test('★ 99.6% then 100%: the window is used up (the change is written); a stop not written is written with the next sample', async (t) => {
  const path = place(t)
  const r = rig(path, Date.parse('2026-11-20T00:00:00Z'))
  const h = r.make()
  await h.sample([claude(50, 99.6, '2026-11-24T00:00:00Z', '2026-11-20T05:00:00Z')])
  await h.sample([claude(50, 100, '2026-11-24T00:00:00Z', '2026-11-20T05:00:00Z')])
  r.at(Date.parse('2026-11-20T06:00:00Z'))
  assert.deepEqual(h.summary().logins[0]!.fiveHourFull, ['2026-11-20T05:00:00.000Z'])
  // A restart reads the same
  assert.deepEqual(r.make().summary().logins[0]!.fiveHourFull, ['2026-11-20T05:00:00.000Z'])
})

test('★ a stop that could not be written is kept aside and written with the next sample (the hook fires once)', async (t) => {
  const path = place(t)
  const r = rig(path)
  const h = r.make()
  const dir = join(path, '..')
  chmodSync(dir, 0o500)
  try {
    assert.equal(await h.hit('codex', '.codex', 'th:turn'), false)
  } finally {
    chmodSync(dir, 0o700)
  }
  assert.equal(h.summary().logins[0]?.limitStops.count, 1, 'it counts meanwhile')
  await h.sample([claude(10, 10, '2026-12-01T00:00:00Z', '2026-11-27T05:00:00Z')])
  assert.deepEqual(lines(path).map((l) => l['k']), ['hit', 's'])
  assert.equal(r.make().summary().logins.find((l) => l.tool === 'codex')?.limitStops.count, 1)
})

test('★ two places with the same label are not kept; the account behind a profile counts even without windows', async (t) => {
  const path = place(t)
  const r = rig(path)
  const h = r.make()
  const codex = (key: string, p: number): ToolUsage => ({ tool: 'codex', account: '.codex', accountKey: key, windows: [{ minutes: 300, usedPercent: p, resetsAt: '2026-11-27T05:00:00Z' }], at: new Date(T0).toISOString() })
  await h.sample([codex('k1', 10), codex('k2', 20)])
  await h.sample([codex('k1', 10), codex('k2', 20)])
  assert.throws(() => lines(path), 'nothing written for the ambiguous label')
  // An account seen with no windows: a stop is filed under it
  await h.sample([{ ...claude(1, 1, '2026-12-01T00:00:00Z', '2026-11-27T05:00:00Z', { accountKey: 'k9' }), windows: [] }])
  await h.hit('claude', '.claude-r', 's:1')
  assert.equal(h.summary().logins.find((l) => l.tool === 'claude')?.accountKey, 'k9')
  // The same stop replayed after a switch to another account is not a second one
  await h.sample([{ ...claude(1, 1, '2026-12-01T00:00:00Z', '2026-11-27T05:00:00Z', { accountKey: 'k8' }), windows: [] }])
  assert.equal(await h.hit('claude', '.claude-r', 's:1'), false)
})

test('★ prune keeps a sample line whose window is still kept, though the reading is older than 90 days', async (t) => {
  const path = place(t)
  const at = new Date(T0 - (HISTORY_DAYS + 3) * DAY).toISOString()
  const reset = new Date(T0 - (HISTORY_DAYS - 4) * DAY).toISOString()
  const line = { v: 1, k: 's', at, tool: 'claude', account: '.claude-r', key: 'k1', w: [{ m: 10080, p: 77, r: reset }] }
  writeFileSync(path, JSON.stringify(line) + '\n' + JSON.stringify({ v: 1, k: 'hit', at, tool: 'agy', account: 'agy', id: hitId('o') }) + '\n', { mode: 0o600 })
  const r = rig(path)
  const h = r.make()
  await h.sample([claude(10, 10, '2026-12-01T00:00:00Z', '2026-11-27T05:00:00Z')])
  await h.settled()
  const kept = lines(path)
  assert.deepEqual(kept.map((l) => l['k']), ['s', 's'], 'the old stop goes, the week stays')
  assert.deepEqual(r.make().summary().logins.find((l) => l.weeks.length)?.weeks.map((w) => w.usedPercent), [77])
})

test('★ a reading not written just before a reset is written with the next sample (the finished week is not lost)', async (t) => {
  const path = place(t)
  const r = rig(path, Date.parse('2026-11-23T23:50:00Z'))
  const h = r.make()
  await h.sample([claude(80, 10, '2026-11-24T00:00:00Z', '2026-11-24T02:00:00Z')])
  // The file itself cannot be written for a moment (the folder is not enough: the file exists already)
  chmodSync(path, 0o400)
  try {
    await h.sample([claude(92, 10, '2026-11-24T00:00:00Z', '2026-11-24T02:00:00Z')])
  } finally {
    chmodSync(path, 0o600)
  }
  assert.ok(r.logs.some((l) => l.includes('could not write')), 'the write did fail')
  assert.equal(lines(path).length, 1)
  r.at(Date.parse('2026-11-24T00:10:00Z'))
  await h.sample([claude(1, 10, '2026-12-01T00:00:00Z', '2026-11-24T02:00:00Z')])
  assert.deepEqual(r.make().summary().logins[0]!.weeks.map((w) => w.usedPercent), [92], 'after a restart too')
})

test('★ an account change is written even without windows: after a restart the next stop is filed under it; 99.96% is not 100', async (t) => {
  const path = place(t)
  const r = rig(path, Date.parse('2026-11-20T00:00:00Z'))
  const h = r.make()
  await h.sample([claude(10, 99.96, '2026-11-24T00:00:00Z', '2026-11-20T05:00:00Z', { accountKey: 'kA' })])
  await h.sample([{ ...claude(0, 0, '2026-11-24T00:00:00Z', '2026-11-20T05:00:00Z', { accountKey: 'kB' }), windows: [] }])
  const again = r.make()
  await again.hit('claude', '.claude-r', 's:1')
  r.at(Date.parse('2026-11-20T06:00:00Z'))
  const s = again.summary()
  assert.equal(s.logins.find((l) => l.limitStops.count === 1)?.accountKey, 'kB')
  assert.deepEqual(s.logins.flatMap((l) => l.fiveHourFull), [], '99.96% is not used up')
})

test('a history that is off says so (the phone does not read it as "nothing recorded")', async (t) => {
  const path = place(t)
  symlinkSync(`${path}.real`, path)
  const h = rig(path).make()
  assert.equal(h.summary().off, true)
})

test('a history file that cannot be read is off (not "nothing"), and nothing is appended to it', async (t) => {
  const path = place(t)
  writeFileSync(path, JSON.stringify({ v: 1, k: 'hit', at: new Date(T0).toISOString(), tool: 'agy', account: 'agy', id: hitId('x') }) + '\n', { mode: 0o000 })
  const r = rig(path)
  const h = r.make()
  assert.equal(h.summary().off, true)
  await h.sample([claude(10, 10, '2026-12-01T00:00:00Z', '2026-11-27T05:00:00Z')])
  chmodSync(path, 0o600)
  assert.equal(lines(path).length, 1)
  assert.ok(r.logs.some((l) => l.includes('could not be read')))
})

test('a history file restored with wider rights is made 0600 when it is read', (t) => {
  const path = place(t)
  writeFileSync(path, '', { mode: 0o644 })
  chmodSync(path, 0o644)
  rig(path).make()
  assert.equal(statSync(path).mode & 0o777, 0o600)
})

test('★ an older reading written after a newer one does not move the reset back (a retried line / codex review)', (t) => {
  const path = place(t)
  const line = (at: string, r: string) => JSON.stringify({ v: 1, k: 's', at, tool: 'claude', account: '.claude-r', key: 'k1', w: [{ m: 10080, p: 40, r }] })
  // on disk: the newer reading (reset 05:08) first, then the older one retried (reset 05:00)
  writeFileSync(path, [line('2026-11-24T04:50:00.000Z', '2026-11-24T05:08:00Z'), line('2026-11-24T04:40:00.000Z', '2026-11-24T05:00:00Z')].join('\n') + '\n')
  const r = rig(path, Date.parse('2026-11-24T05:04:00Z'))
  assert.deepEqual(r.make().summary().logins.flatMap((l) => l.weeks), [], 'not finished at 05:04: the newer reading says 05:08')
})

test('a copy left by a prune cut short is removed at start', async (t) => {
  const path = place(t)
  const left = `${path}.0123456789ab.tmp`
  const other = `${path}.notours`
  writeFileSync(left, 'old copy')
  writeFileSync(other, 'x')
  rig(path).make()
  for (let i = 0; i < 50 && existsSync(left); i++) await new Promise((res) => setTimeout(res, 5))
  assert.equal(existsSync(left), false)
  assert.equal(existsSync(other), true, 'only our own leftovers')
})
