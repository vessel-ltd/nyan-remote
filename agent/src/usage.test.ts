import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { accountKeyOf, claudeUsage, claudeUsagePath, claudeWindows, codexUsageOf } from './usage.ts'

const NOW = Date.parse('2026-11-17T02:00:00Z')
const sec = (iso: string): number => Date.parse(iso) / 1000

test('Claude: both windows from the status line input, as minutes / percent / ISO reset', () => {
  const input = {
    model: { id: 'x' },
    rate_limits: {
      five_hour: { used_percentage: 20, resets_at: sec('2026-11-17T05:50:00Z') },
      seven_day: { used_percentage: 80, resets_at: sec('2026-11-18T06:00:00Z') },
    },
  }
  assert.deepEqual(claudeWindows(input, NOW), [
    { minutes: 300, usedPercent: 20, resetsAt: '2026-11-17T05:50:00.000Z' },
    { minutes: 10080, usedPercent: 80, resetsAt: '2026-11-18T06:00:00.000Z' },
  ])
})

test('Claude: a plan without a 5-hour window shows the week only; a passed reset is dropped; no rate_limits is no reading', () => {
  const weekOnly = { rate_limits: { seven_day: { used_percentage: 9, resets_at: sec('2026-11-22T02:00:00Z') } } }
  assert.deepEqual(claudeWindows(weekOnly, NOW)?.map((w) => w.minutes), [10080])
  const passed = { rate_limits: { five_hour: { used_percentage: 99, resets_at: sec('2026-11-17T01:00:00Z') }, seven_day: { used_percentage: 9, resets_at: sec('2026-11-22T02:00:00Z') } } }
  assert.deepEqual(claudeWindows(passed, NOW)?.map((w) => w.minutes), [10080])
  assert.equal(claudeWindows({ model: { id: 'x' } }, NOW), undefined)
  assert.equal(claudeWindows(null, NOW), undefined)
  // Broken numbers are not windows
  for (const bad of [{ used_percentage: 9, resets_at: 1e20 }, { used_percentage: '9', resets_at: 1e10 }, { used_percentage: -1, resets_at: 1e10 }, { used_percentage: 9, resets_at: 'x' }, { used_percentage: Number.NaN, resets_at: 1e10 }]) {
    assert.deepEqual(claudeWindows({ rate_limits: { seven_day: bad } }, NOW), [])
  }
})

/** The shape `account/rateLimits/read` answered (codex-cli 0.169.0, measured 2026-11-17; ids replaced) */
const CODEX = {
  ordinaryUsageAllowed: true,
  rateLimits: {
    limitId: 'codex',
    limitName: null,
    primary: { usedPercent: 54, windowDurationMins: 10080, resetsAt: sec('2026-11-20T14:15:41Z') },
    secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: '0' },
    planType: 'prolite',
    rateLimitReachedType: null,
  },
  accountId: '00000000-0000-4000-8000-000000000000',
}

test('Codex: the windows by their own length (a week-only plan has no 5-hour window), the plan, a hashed account', () => {
  const got = codexUsageOf(CODEX, NOW)
  assert.deepEqual(got, {
    windows: [{ minutes: 10080, usedPercent: 54, resetsAt: '2026-11-20T14:15:41.000Z' }],
    plan: 'prolite',
    accountKey: accountKeyOf(CODEX.accountId),
  })
  assert.notEqual(got?.accountKey, CODEX.accountId, 'the id itself never leaves')
  assert.equal(got?.accountKey?.length, 12)
})

test('Codex: a plan with a 5-hour window shows both, shortest first', () => {
  const both = {
    rateLimits: {
      primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: sec('2026-11-17T04:00:00Z') },
      secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: sec('2026-11-21T00:00:00Z') },
      planType: 'plus',
    },
  }
  assert.deepEqual(codexUsageOf(both, NOW)?.windows.map((w) => [w.minutes, w.usedPercent]), [[300, 30], [10080, 12]])
  // Order does not matter in the answer
  const swapped = { rateLimits: { ...both.rateLimits, primary: both.rateLimits.secondary, secondary: both.rateLimits.primary } }
  assert.deepEqual(codexUsageOf(swapped, NOW)?.windows.map((w) => w.minutes), [300, 10080])
  assert.equal(codexUsageOf({}, NOW), undefined)
  assert.equal(codexUsageOf({ rateLimits: { planType: '<b>' } }, NOW)?.plan, undefined, 'a plan name that is not a plain word is dropped')
})

const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'
/** What the relay writes: the account it read with the input it got */
const wrap = (account: string, input: unknown): string => JSON.stringify({ nyanAccount: account, input })
const weekAt = (pct: number) => ({ rate_limits: { seven_day: { used_percentage: pct, resets_at: sec('2026-11-22T02:00:00Z') } } })

async function stateDirFor(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-usage-'))
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = join(dir, 'state')
  t.after(async () => {
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(dir, { recursive: true, force: true })
  })
  await mkdir(join(dir, 'state', 'usage'), { recursive: true })
  return dir
}

const profilesIn = (dir: string, names: string[]) => names.map((account) => ({ account, dir: join(dir, account), projectsDir: join(dir, account, 'projects') }))

test('Claude: read from the relay file per profile, timed by the file, grouped by the account the relay recorded', async (t) => {
  const dir = await stateDirFor(t)
  const profiles = profilesIn(dir, ['.claude', '.claude-r', '.claude-rs', '.claude-s'])
  // ★ .claude and .claude-r are one account (measured on a real machine: the default profile's config is ~/.claude.json)
  await writeFile(claudeUsagePath('.claude'), wrap(U1, weekAt(9)))
  await writeFile(claudeUsagePath('.claude-r'), wrap(U1, weekAt(10)))
  await writeFile(claudeUsagePath('.claude-s'), wrap(U2, weekAt(80)))
  await utimes(claudeUsagePath('.claude-s'), new Date('2026-11-17T01:42:37Z'), new Date('2026-11-17T01:42:37Z'))
  // rs has no reading (no session ran since the relay was installed)

  const got = await claudeUsage(profiles, NOW)
  assert.deepEqual(got.map((u) => [u.account, u.windows[0]?.usedPercent, u.accountKey]), [
    ['.claude', 9, accountKeyOf(U1)],
    ['.claude-r', 10, accountKeyOf(U1)],
    ['.claude-s', 80, accountKeyOf(U2)],
  ])
  assert.equal(got[2]!.at, '2026-11-17T01:42:37.000Z')
  assert.ok(!JSON.stringify(got).includes(U1), 'the id itself never leaves')

  // A profile whose file is gone has no reading
  await rm(claudeUsagePath('.claude-r'))
  assert.deepEqual((await claudeUsage(profiles, NOW)).map((u) => u.account), ['.claude', '.claude-s'])
})

test('Claude: a reading without a recorded account (an older relay, or a layout it could not read) is never grouped; one broken profile never fails the others', async (t) => {
  const dir = await stateDirFor(t)
  const profiles = profilesIn(dir, ['.claude-a', '.claude-b', '.claude-c', '.claude-d'])
  await writeFile(claudeUsagePath('.claude-a'), JSON.stringify(weekAt(5)))
  await writeFile(claudeUsagePath('.claude-b'), wrap('', weekAt(6)))
  await writeFile(claudeUsagePath('.claude-c'), wrap('-'.repeat(36), weekAt(7)))
  // d: a reset time no Date can hold (codex review: it threw and failed the whole response)
  await writeFile(claudeUsagePath('.claude-d'), wrap(U1, { rate_limits: { seven_day: { used_percentage: 5, resets_at: 1e20 } } }))
  const got = await claudeUsage(profiles, NOW)
  assert.deepEqual(got.map((u) => [u.account, u.accountKey, u.windows.length]), [
    ['.claude-a', undefined, 1],
    ['.claude-b', undefined, 1],
    ['.claude-c', undefined, 1],
    ['.claude-d', accountKeyOf(U1), 0],
  ])
})
