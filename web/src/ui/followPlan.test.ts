import assert from 'node:assert/strict'
import { test } from 'node:test'
import { coalesce, FOLLOW_FALLBACK_MS, followPlan, LEGACY_POLL_MS, shouldPull } from './followPlan.ts'
import { subscribeWhileVisible } from '../visibility.ts'

test('★★★ agents with the marker get notifications + slow backup; agents without keep 3 seconds as before', () => {
  assert.deepEqual(followPlan(['log-follow']), { follow: true, pollMs: FOLLOW_FALLBACK_MS })
  assert.deepEqual(followPlan(['slash-commands']), { follow: false, pollMs: LEGACY_POLL_MS })
  assert.deepEqual(followPlan(undefined), { follow: false, pollMs: LEGACY_POLL_MS })
})

test('★★★ fetch only on this session\'s notification or hello (re-established)', () => {
  assert.equal(shouldPull({ type: 'log-appended', sessionId: 'A', at: '' }, 'A'), true)
  assert.equal(shouldPull({ type: 'log-appended', sessionId: 'B', at: '' }, 'A'), false)
  assert.equal(shouldPull({ type: 'hello', machine: 'm', at: '' }, 'A'), true)
  assert.equal(shouldPull({ type: 'sessions-changed', at: '' }, 'A'), false)
})

test('★★★★ a signal during a run is not dropped; run once more after it finishes', async () => {
  const releases: (() => void)[] = []
  let runs = 0
  const go = coalesce(
    () =>
      new Promise<void>((r) => {
        runs++
        releases.push(r)
      }),
  )
  go()
  go()
  go()
  assert.equal(runs, 1, '⚠️ runs overlapped (order swaps and appends are doubled)')
  releases.shift()!()
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(runs, 2, '⚠️⚠️ dropped a signal during a run (the last appends look stuck)')
  releases.shift()!()
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(runs, 2, '⚠️ ran once per signal received (one run fetches up to the latest)')
})

test('★★★ subscribe only while in the foreground (unsubscribe in the background, resubscribe in the foreground)', () => {
  const fns = new Set<() => void>()
  const doc = {
    visibilityState: 'visible',
    addEventListener: (_t: 'visibilitychange', f: () => void) => void fns.add(f),
    removeEventListener: (_t: 'visibilitychange', f: () => void) => void fns.delete(f),
  }
  let open = 0
  let starts = 0
  const stop = subscribeWhileVisible(() => {
    open++
    starts++
    return () => open--
  }, doc)
  assert.equal(open, 1)
  doc.visibilityState = 'hidden'
  for (const f of fns) f()
  assert.equal(open, 0, '⚠️⚠️ still subscribed in the background (streams to a device nobody is looking at)')
  doc.visibilityState = 'visible'
  for (const f of fns) f()
  for (const f of fns) f()
  assert.equal(open, 1, '⚠️ subscribed twice in the foreground')
  assert.equal(starts, 2)
  stop()
  assert.equal(open, 0)
  assert.equal(fns.size, 0)
})

test('★★★ after stopping, the scheduled "one more later" does not run either (codex round 16, low #4)', async () => {
  const releases: (() => void)[] = []
  let runs = 0
  const go = coalesce(
    () =>
      new Promise<void>((r) => {
        runs++
        releases.push(r)
      }),
  )
  go()
  go()
  go.stop()
  releases.shift()!()
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(runs, 1, '⚠️ the scheduled fetch ran after cleanup')
  go()
  assert.equal(runs, 1, '⚠️ ran after stopping')
})
