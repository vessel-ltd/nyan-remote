import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HookEvent } from '../../shared/types.ts'
import {
  flushStopPushes,
  pendingStopPushes,
  scheduleStopPush,
  type StatusProbe,
  type StopPushDeps,
} from './stopPush.ts'

// ★★ What this test guards (the spot a 2026-08-16 external review called "false green"):
//
//   The previous version only passed hand-made values to `settledLabel` and **never ran
//   the delayed-send path**. So any of these stayed green:
//     - deleting the delay branch itself
//     - deleting the send call
//     - setting the wait to 0
//     - creating many timers for the same Stop
//   ⇒ **Replace the timers and the sender, and check the actual call count and order.**
//
// ⚠️ What is protected here is "notifications are never lost". Notifications are this tool's reason to exist,
//    so not a single path may drop them silently.

function ev(sessionId: string | undefined, at = '2026-08-16T05:00:00.000Z'): HookEvent {
  return {
    event: 'Stop',
    machine: 'PC-A',
    account: '.claude-r',
    project: 'tmux-agent',
    sessionId,
    at,
  }
}

interface Harness {
  deps: StopPushDeps
  /** Pending timers (fired by hand) */
  timers: { fn: () => void; ms: number; cleared: boolean }[]
  sent: { sessionId?: string; probe: StatusProbe }[]
  probes: number
  fire: (i: number) => void
}

function harness(probe: StatusProbe = { kind: 'live', status: 'shell' }): Harness {
  const h: Harness = {
    timers: [],
    sent: [],
    probes: 0,
    deps: {
      delayMs: 1500,
      probe: async () => {
        h.probes += 1
        return probe
      },
      send: async (event, p) => {
        h.sent.push({ sessionId: event.sessionId, probe: p })
      },
      setTimer: (fn, ms) => {
        h.timers.push({ fn, ms, cleared: false })
        return {}
      },
      clearTimer: (t) => {
        const i = h.timers.findIndex((x) => x.fn === (t as { fn?: unknown })?.fn)
        // the stand-in has no identifier, so clear the uncleared ones in order
        const target = i >= 0 ? h.timers[i] : h.timers.find((x) => !x.cleared)
        if (target) target.cleared = true
      },
    },
    fire: (i) => {
      const t = h.timers[i]
      assert.ok(t, `timer ${i} is missing`)
      assert.equal(t.cleared, false, `timer ${i} was cleared`)
      t.fn()
    },
  }
  return h
}

test('★ nothing is sent at scheduling time; it is sent after the wait', async () => {
  const h = harness()
  assert.equal(scheduleStopPush(ev('A'), h.deps), true)
  assert.equal(h.sent.length, 0, 'must not send on scheduling alone (state not written yet)')
  assert.equal(h.timers[0]?.ms, 1500, 'wait time is not wired')
  assert.equal(pendingStopPushes(), 1)

  h.fire(0)
  await new Promise((r) => setImmediate(r))
  assert.equal(h.sent.length, 1)
  assert.deepEqual(h.sent[0]?.probe, { kind: 'live', status: 'shell' }, 'passes the state re-read right before sending')
  assert.equal(pendingStopPushes(), 0)
  await flushStopPushes(h.deps)
})

test('★★ repeated Stop for the same session notifies only once', async () => {
  // ⚠️ the hook can fire multiple times. Without merging, `renotify: true` makes it **ring twice**
  const h = harness()
  scheduleStopPush(ev('A'), h.deps)
  scheduleStopPush(ev('A'), h.deps)
  scheduleStopPush(ev('A'), h.deps)
  assert.equal(pendingStopPushes(), 1, 'only one pending')

  const alive = h.timers.filter((t) => !t.cleared)
  assert.equal(alive.length, 1, `${alive.length} live timers (the previous schedule was not dropped)`)
  alive[0]!.fn()
  await new Promise((r) => setImmediate(r))
  assert.equal(h.sent.length, 1)
  await flushStopPushes(h.deps)
})

test('different sessions are not merged (each is notified)', async () => {
  const h = harness()
  scheduleStopPush(ev('A'), h.deps)
  scheduleStopPush(ev('B'), h.deps)
  assert.equal(pendingStopPushes(), 2)
  await flushStopPushes(h.deps)
  assert.deepEqual(
    h.sent.map((s) => s.sessionId).sort(),
    ['A', 'B'],
  )
})

test('★★ on exit, pending notifications are flushed (not lost on agent restart)', async () => {
  // ⚠️ 2026-08-16 external review, high #1. Because it rode on setTimeout,
  //    a restart within 1.5s **lost the notification forever** (not even logged).
  //    Notifications are this tool's reason to exist, so the exit path always flushes them.
  const h = harness({ kind: 'live', status: 'busy' })
  scheduleStopPush(ev('A'), h.deps)
  scheduleStopPush(ev('B'), h.deps)
  assert.equal(h.sent.length, 0)

  const n = await flushStopPushes(h.deps)
  assert.equal(n, 2, 'number flushed')
  assert.equal(h.sent.length, 2)
  assert.equal(pendingStopPushes(), 0)
  // ★ timers are cleared (so they do not run again after exit)
  assert.equal(h.timers.every((t) => t.cleared), true)
})

test('★ if one fails during flush, the rest are still sent', async () => {
  const h = harness()
  let calls = 0
  h.deps.send = async (event) => {
    calls += 1
    if (event.sessionId === 'A') throw new Error('cannot send')
    h.sent.push({ sessionId: event.sessionId, probe: { kind: 'unknown' } })
  }
  scheduleStopPush(ev('A'), h.deps)
  scheduleStopPush(ev('B'), h.deps)
  await flushStopPushes(h.deps)
  assert.equal(calls, 2)
  assert.deepEqual(h.sent.map((s) => s.sessionId), ['B'])
})

test('★★ a notification is still sent if re-reading the state fails (passed as unknown)', async () => {
  // ⚠️ "stay silent because it could not be read" is the worst. Weaken the text but always send
  const h = harness()
  h.deps.probe = async () => {
    throw new Error('cannot read sessions/')
  }
  scheduleStopPush(ev('A'), h.deps)
  await flushStopPushes(h.deps)
  assert.equal(h.sent.length, 1, 'a failed re-read must not drop the notification')
  assert.deepEqual(h.sent[0]?.probe, { kind: 'unknown' })
})

test('not scheduled without a sessionId (duplicates undetectable, so left to immediate send)', () => {
  const h = harness()
  assert.equal(scheduleStopPush(ev(undefined), h.deps), false)
  assert.equal(h.timers.length, 0)
  assert.equal(pendingStopPushes(), 0)
})
