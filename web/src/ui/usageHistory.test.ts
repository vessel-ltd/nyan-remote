import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { UsageHistoryLogin, UsageHistoryResponse } from '../../../shared/types.ts'
import { setLang } from '../../../shared/i18n.ts'
import { HISTORY_WEEKS, fivesText, groupHistory, historyNote, historySince, pctText, readHistories, stopsText, weeksText, type HistorySource } from './usageHistory.ts'

const login = (over: Partial<UsageHistoryLogin> = {}): UsageHistoryLogin => ({
  tool: 'claude',
  account: '.claude-r',
  accountKey: 'k1',
  weeks: [],
  fiveHourFull: [],
  limitStops: { count: 0, recent: [] },
  ...over,
})
const res = (logins: UsageHistoryLogin[], since?: string): UsageHistoryResponse => ({ days: 90, ...(since ? { since } : {}), logins })

test('★ one account on two PCs is one login: weeks merged (highest use), full 5-hour windows once, stops added', () => {
  const a = login({
    weeks: [{ resetsAt: '2026-11-17T00:00:00.000Z', usedPercent: 60 }, { resetsAt: '2026-11-24T00:00:00.000Z', usedPercent: 90 }],
    fiveHourFull: ['2026-11-20T05:00:00.000Z'],
    limitStops: { count: 2, recent: ['2026-11-20T04:00:00.000Z', '2026-11-22T04:00:00.000Z'] },
  })
  const b = login({
    account: '.claude-rs',
    // the same week seen a few seconds apart, with a higher reading
    weeks: [{ resetsAt: '2026-11-24T00:00:20.000Z', usedPercent: 97 }],
    fiveHourFull: ['2026-11-20T05:00:30.000Z', '2026-11-23T05:00:00.000Z'],
    limitStops: { count: 1, recent: ['2026-11-23T04:00:00.000Z'] },
  })
  const [g, ...rest] = groupHistory([
    { id: 'pc-a', machine: 'pc-a', history: res([a]) },
    { id: 'pc-b', machine: 'pc-b', history: res([b]) },
  ])
  assert.equal(rest.length, 0)
  assert.deepEqual(g!.names, ['pc-a: .claude-r', 'pc-b: .claude-rs'])
  assert.deepEqual(g!.weeks.map((w) => w.usedPercent), [60, 97])
  assert.equal(g!.fiveHourFull, 2, 'the window both PCs saw counts once')
  assert.equal(g!.fiveHourLast, '2026-11-23T05:00:00.000Z')
  assert.equal(g!.limitStops, 3, 'stops on two PCs are different stops')
  assert.deepEqual(g!.recentStops, ['2026-11-23T04:00:00.000Z', '2026-11-22T04:00:00.000Z', '2026-11-20T04:00:00.000Z'])
})

test('without an account key a login is its machine and profile; tools ordered, the one that stopped most first', () => {
  const groups = groupHistory([
    {
      id: 'pc-a',
      machine: 'pc-a',
      history: res([
        login({ tool: 'agy', account: 'agy', accountKey: undefined }),
        login({ tool: 'codex', account: '.codex', accountKey: undefined, limitStops: { count: 1, recent: [] } }),
        login({ accountKey: 'k1' }),
        login({ account: '.claude-s', accountKey: 'k2', limitStops: { count: 4, recent: [] } }),
      ]),
    },
    { id: 'pc-b', machine: 'pc-b', history: res([login({ tool: 'codex', account: '.codex', accountKey: undefined })]) },
  ])
  assert.deepEqual(
    groups.map((g) => [g.tool, g.names.join(',')]),
    [
      ['claude', 'pc-a: .claude-s'],
      ['claude', 'pc-a: .claude-r'],
      ['codex', 'pc-a: .codex'],
      ['codex', 'pc-b: .codex'],
      ['agy', 'pc-a: agy'],
    ],
  )
})

test('★ the same PC saved twice (two addresses, one agent) is read once', () => {
  const l = login({ limitStops: { count: 2, recent: ['2026-11-20T04:00:00.000Z'] } })
  const [g, ...rest] = groupHistory([
    { id: 'key-a', machine: 'pc-a', history: res([l]) },
    { id: 'key-a', machine: 'pc-a', history: res([l]) },
  ])
  assert.equal(rest.length, 0)
  assert.equal(g!.limitStops, 2)
  // two different agents that happen to share a name are two
  const two = groupHistory([
    { id: 'key-a', machine: 'pc-a', history: res([login({ accountKey: undefined })]) },
    { id: 'key-b', machine: 'pc-a', history: res([login({ accountKey: undefined })]) },
  ])
  assert.equal(two.length, 2)
})

test('★ misshapen answers never throw and hide nothing else', () => {
  const bad = [null, 'x', { logins: null }, { logins: [null, 'x', { tool: 'claude' }] }, { logins: [{ tool: 'claude', account: '.c', weeks: {}, fiveHourFull: 'x', limitStops: null }] }]
  const groups = groupHistory([
    ...bad.map((h, i) => ({ id: `bad-${i}`, machine: `bad-${i}`, history: h as unknown as UsageHistoryResponse })),
    { id: 'pc-a', machine: 'pc-a', history: res([login({ weeks: [{ resetsAt: '2026-11-24T00:00:00Z', usedPercent: 999 }] })]) },
    { id: 'pc-c', machine: 'pc-c', history: res([login({ account: '.neg', accountKey: undefined, limitStops: { count: -5, recent: [] } })]) },
  ])
  const good = groups.find((g) => g.names.includes('pc-a: .claude-r'))!
  assert.equal(good.weeks[0]!.usedPercent, 100, 'clamped')
  assert.equal(groups.some((g) => g.names.includes('pc-c: .neg')), false, 'a login with a negative count is not taken')
  assert.equal(historySince([{ history: null as unknown as UsageHistoryResponse }]), undefined)
})

test('a week seen just across a 15-minute boundary by two PCs is one bar', () => {
  const [g] = groupHistory([
    { id: 'pc-a', machine: 'pc-a', history: res([login({ weeks: [{ resetsAt: '2026-11-24T00:07:29Z', usedPercent: 40 }] })]) },
    { id: 'pc-b', machine: 'pc-b', history: res([login({ weeks: [{ resetsAt: '2026-11-24T00:07:31Z', usedPercent: 70 }] })]) },
  ])
  assert.deepEqual(g!.weeks.map((w) => w.usedPercent), [70])
})

test('hostile or partial answers are skipped, never thrown; at most 13 weeks', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ resetsAt: new Date(Date.UTC(2026, 6, 1) + i * 7 * 86_400_000).toISOString(), usedPercent: i }))
  const groups = groupHistory([
    { id: 'pc-a', machine: 'pc-a', history: { days: 90 } as unknown as UsageHistoryResponse },
    { id: 'pc-b', machine: 'pc-b', history: res([login({ weeks: many })]) },
    // one broken entry: the login is not taken (not silently fewer windows)
    { id: 'pc-c', machine: 'pc-c', history: res([login({ account: '.c', accountKey: undefined, weeks: [{ resetsAt: 'x', usedPercent: 5 }] })]) },
    { id: 'pc-d', machine: 'pc-d', history: res([login({ account: '.d', accountKey: undefined, fiveHourFull: [null as unknown as string] })]) },
  ])
  assert.deepEqual(groups.map((g) => g.names.join(',')), ['pc-b: .claude-r'])
  assert.equal(groups[0]!.weeks.length, HISTORY_WEEKS)
  assert.equal(groups[0]!.weeks.at(-1)!.usedPercent, 19)
})

test('texts, in both languages; since is the oldest of the machines', () => {
  setLang('en')
  const g = groupHistory([
    {
      id: 'pc-a',
      machine: 'pc-a',
      history: res([
        login({
          weeks: [{ resetsAt: '2026-11-17T00:00:00Z', usedPercent: 40 }, { resetsAt: '2026-11-24T00:00:00Z', usedPercent: 81 }],
          fiveHourFull: ['2026-11-20T05:00:00Z'],
          limitStops: { count: 1, recent: ['2026-11-22T04:05:00Z'] },
        }),
      ]),
    },
  ])[0]!
  assert.equal(weeksText(g), 'Weekly use: last 81%, average 61% (2 weeks)')
  assert.match(stopsText(g), /^Stopped at a limit 1 time \(last 11\/2\d \d\d:\d\d\)$/)
  assert.match(fivesText(g)!, /^Used up a 5-hour window 1 time \(last 11\/2\d\)$/)
  setLang('ja')
  assert.equal(weeksText(g), '週の使い切り率: 直近 81%・平均 61%（2週）')
  assert.match(stopsText(g), /^上限で止まった 1回（直近 /)
  const none = groupHistory([{ id: 'pc-a', machine: 'pc-a', history: res([login({ weeks: [{ resetsAt: '2026-11-17T00:00:00Z', usedPercent: 1 }] })]) }])[0]!
  assert.equal(stopsText(none), '上限で止まったことはありません')
  assert.equal(fivesText(none), undefined)
  assert.equal(historySince([{ history: res([], '2026-11-01T00:00:00Z') }, { history: res([], '2026-10-01T00:00:00Z') }, { history: res([]) }]), '2026-10-01T00:00:00Z')
})

test('★ reading: one agent at two addresses is asked once, the other address on failure; old agents skipped; failures counted', async () => {
  const calls: string[] = []
  const src = (name: string, machine: string, key: string | undefined, opts: { health?: 'fail'; history?: 'fail'; old?: true } = {}): HistorySource => ({
    health: async () => {
      if (opts.health === 'fail') throw new Error('down')
      return { machine, ...(key ? { agentPublicKey: key } : {}), features: opts.old ? ['usage'] : ['usage', 'usage-history'] }
    },
    usageHistory: async () => {
      calls.push(name)
      if (opts.history === 'fail') throw new Error('x')
      return res([login({ accountKey: undefined, account: name })])
    },
  })
  const r = await readHistories([
    src('a-relay', 'pc-a', 'KA', { history: 'fail' }),
    src('a-tailnet', 'pc-a', 'KA'),
    src('b', 'pc-b', 'KB', { old: true }),
    src('c', 'pc-c', 'KC', { health: 'fail' }),
    src('d', 'pc-d', 'KD', { history: 'fail' }),
  ])
  assert.deepEqual(calls.sort(), ['a-relay', 'a-tailnet', 'd'])
  assert.deepEqual(r.ok.map((x) => [x.id, x.machine]), [['KA', 'pc-a']])
  assert.equal(r.missing, 2, 'pc-c unreachable, pc-d failed; pc-a read through its other address')
})

test('group keys are unique even when two groups show the same names (an account switch behind one profile)', () => {
  const groups = groupHistory([{ id: 'pc-a', machine: 'pc-a', history: res([login({ accountKey: 'k1' }), login({ accountKey: 'k2' })]) }])
  assert.equal(groups.length, 2)
  assert.equal(new Set(groups.map((g) => g.key)).size, 2)
})

test('★ reading: an answer that is off or misshapen is not a reading (the other address is tried); a null health is unreachable', async () => {
  const mk = (history: unknown, fail = false): HistorySource => ({
    health: async () => ({ machine: 'pc-a', agentPublicKey: 'KA', features: ['usage-history'] }),
    usageHistory: async () => {
      if (fail) throw new Error('x')
      return history as UsageHistoryResponse
    },
  })
  const r1 = await readHistories([mk({ days: 90, off: true, logins: [] }), mk(res([login()]))])
  assert.equal(r1.ok.length, 1)
  assert.equal(r1.missing, 0)
  assert.equal(r1.ok[0]!.history.logins.length, 1, 'the other address answered')
  const nullStops = await readHistories([mk({ days: 90, logins: [{ ...login(), limitStops: null }] }), mk(res([login({ limitStops: { count: 8, recent: [] } })]))])
  assert.equal(nullStops.ok[0]?.history.logins[0]?.limitStops.count, 8, 'a login without its stops is not "0 stops"')
  const badKey = await readHistories([mk({ days: 90, logins: [{ ...login(), accountKey: 123 }] }), mk(res([login()]))])
  assert.equal(badKey.ok[0]?.history.logins[0]?.accountKey, 'k1', 'a broken key is not dropped silently: the other address')
  const partly = await readHistories([mk({ days: 90, logins: [null] }), mk(res([login()]))])
  assert.equal(partly.ok[0]?.history.logins[0]?.tool, 'claude', 'an answer with a broken entry is not taken; the other address is')
  const off = await readHistories([mk({ days: 90, off: true, logins: [] })])
  assert.deepEqual([off.ok.length, off.missing], [0, 1], 'a history that is off is not "nothing recorded"')
  const r2 = await readHistories([mk(null), mk({ days: 90 })])
  assert.deepEqual([r2.ok.length, r2.missing], [0, 1])
  const r3 = await readHistories([{ health: async () => null as never, usageHistory: async () => res([]) }, mk(res([login()]))])
  assert.deepEqual([r3.ok.length, r3.missing], [1, 1])
})

test('★ the note: nothing could be read / nothing recorded yet / since …, and what was missing', () => {
  setLang('en')
  assert.deepEqual(historyNote({ ok: [], missing: 2 }, [], undefined), ['Could not read the history from any PC'])
  const one = [{ id: 'a', machine: 'pc-a', history: res([]) }]
  assert.deepEqual(historyNote({ ok: one, missing: 0 }, [], undefined), ['Nothing to show yet (no finished week and no limit stop so far; each PC records every 15 minutes)'])
  const groups = groupHistory([{ id: 'a', machine: 'pc-a', history: res([login({ limitStops: { count: 1, recent: [] } })]) }])
  const note = historyNote({ ok: one, missing: 1 }, groups, '2026-11-01T00:00:00Z')
  assert.match(note[0]!, /^Kept on each PC since 11\/1 /)
  assert.equal(note[1], '1 connection could not be read (not in the counts)')
})

test('100% only for a window really used up', () => {
  assert.deepEqual([pctText(99.9), pctText(100), pctText(130), pctText(42.4)], [99, 100, 100, 42])
})
