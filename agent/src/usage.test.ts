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

test('Claude: read from the relay file per profile, timed by the file, grouped by a hashed account id', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-usage-'))
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = join(dir, 'state')
  t.after(async () => {
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(dir, { recursive: true, force: true })
  })
  await mkdir(join(dir, 'state', 'usage'), { recursive: true })
  const profiles = ['.claude-r', '.claude-rs', '.claude-s'].map((account) => ({ account, dir: join(dir, account), projectsDir: join(dir, account, 'projects') }))
  for (const p of profiles) await mkdir(p.dir, { recursive: true })
  // r and rs: one account (measured on a real machine); s: another
  await writeFile(join(dir, '.claude-r', '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'acct-1', emailAddress: 'user@example.com', profileFetchedAt: 0 } }))
  await writeFile(join(dir, '.claude-rs', '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'acct-1', profileFetchedAt: 0 } }))
  await writeFile(join(dir, '.claude-s', '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'acct-2', profileFetchedAt: 0 } }))
  const reading = (pct: number) => JSON.stringify({ rate_limits: { seven_day: { used_percentage: pct, resets_at: sec('2026-11-22T02:00:00Z') } } })
  await writeFile(claudeUsagePath('.claude-r'), reading(9))
  await writeFile(claudeUsagePath('.claude-s'), reading(80))
  await utimes(claudeUsagePath('.claude-s'), new Date('2026-11-17T01:42:37Z'), new Date('2026-11-17T01:42:37Z'))
  // rs has no reading (no session ran since the relay was installed)

  const got = await claudeUsage(profiles, NOW)
  assert.deepEqual(got.map((u) => [u.account, u.windows[0]?.usedPercent]), [['.claude-r', 9], ['.claude-s', 80]])
  assert.equal(got[1]!.at, '2026-11-17T01:42:37.000Z')
  assert.equal(got[0]!.accountKey, accountKeyOf('acct-1'))
  assert.notEqual(got[0]!.accountKey, got[1]!.accountKey)
  assert.ok(!JSON.stringify(got).includes('example.com'), 'nothing else of the profile leaves')

  // Caught half-written (the relay writes in place): the last good reading stays, nothing thrown
  await writeFile(claudeUsagePath('.claude-r'), '{"rate_limits":{"seven')
  assert.deepEqual((await claudeUsage(profiles, NOW)).map((u) => [u.account, u.windows[0]?.usedPercent]), [['.claude-r', 9], ['.claude-s', 80]])
  // A profile whose file is gone has no reading
  await rm(claudeUsagePath('.claude-r'))
  assert.deepEqual((await claudeUsage(profiles, NOW)).map((u) => u.account), ['.claude-s'])
})

test('Claude: one broken profile never fails the others; a reading older than the profile\'s login is not given its account', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-usage2-'))
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = join(dir, 'state')
  t.after(async () => {
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(dir, { recursive: true, force: true })
  })
  await mkdir(join(dir, 'state', 'usage'), { recursive: true })
  const profiles = ['.claude-a', '.claude-b'].map((account) => ({ account, dir: join(dir, account), projectsDir: join(dir, account, 'projects') }))
  for (const p of profiles) await mkdir(p.dir, { recursive: true })
  const login = (uuid: string, at: number) => JSON.stringify({ oauthAccount: { accountUuid: uuid, profileFetchedAt: at } })
  const T1 = Date.parse('2026-11-17T01:00:00Z')
  await writeFile(join(dir, '.claude-a', '.claude.json'), login('acct-1', T1 - 60_000))
  await writeFile(join(dir, '.claude-b', '.claude.json'), login('acct-2', T1 - 60_000))
  // a: a reset time no Date can hold (codex review: it threw and failed the whole response)
  await writeFile(claudeUsagePath('.claude-a'), JSON.stringify({ rate_limits: { seven_day: { used_percentage: 5, resets_at: 1e20 } } }))
  const bReading = JSON.stringify({ rate_limits: { seven_day: { used_percentage: 30, resets_at: sec('2026-11-22T02:00:00Z') } } })
  await writeFile(claudeUsagePath('.claude-b'), bReading)
  for (const a of ['.claude-a', '.claude-b']) await utimes(claudeUsagePath(a), new Date(T1), new Date(T1))
  const first = await claudeUsage(profiles, NOW)
  assert.deepEqual(first.map((u) => [u.account, u.windows.length, u.accountKey]), [['.claude-a', 0, accountKeyOf('acct-1')], ['.claude-b', 1, accountKeyOf('acct-2')]])

  // b logs in to another account after its reading (even before the agent ever looked): the reading is shown under
  // the profile alone, never under the new account (codex review round 2)
  await writeFile(join(dir, '.claude-b', '.claude.json'), login('acct-3', T1 + 60_000))
  const after = (await claudeUsage(profiles, NOW)).find((u) => u.account === '.claude-b')
  assert.equal(after?.accountKey, undefined)
  assert.equal(after?.windows[0]?.usedPercent, 30)
  // Its next reading belongs to the new account
  await writeFile(claudeUsagePath('.claude-b'), JSON.stringify({ rate_limits: { seven_day: { used_percentage: 1, resets_at: sec('2026-11-22T02:00:00Z') } } }))
  await utimes(claudeUsagePath('.claude-b'), new Date(T1 + 120_000), new Date(T1 + 120_000))
  assert.equal((await claudeUsage(profiles, NOW)).find((u) => u.account === '.claude-b')?.accountKey, accountKeyOf('acct-3'))
  // No fetch time known ⇒ never grouped
  await writeFile(join(dir, '.claude-a', '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'acct-1' } }))
  assert.equal((await claudeUsage(profiles, NOW)).find((u) => u.account === '.claude-a')?.accountKey, undefined)
})
