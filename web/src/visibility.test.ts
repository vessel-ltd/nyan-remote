import assert from 'node:assert/strict'
import { test } from 'node:test'
import { whileVisible, type Timers, type VisibilityLike } from './visibility.ts'

/** Fake document (switches foreground/background and fires visibilitychange) */
function fakeDoc(state: 'visible' | 'hidden') {
  const fns = new Set<() => void>()
  const doc = {
    visibilityState: state as string,
    addEventListener: (_t: 'visibilitychange', fn: () => void) => void fns.add(fn),
    removeEventListener: (_t: 'visibilitychange', fn: () => void) => void fns.delete(fn),
  }
  return {
    doc: doc as VisibilityLike,
    set(s: 'visible' | 'hidden') {
      doc.visibilityState = s
      for (const fn of fns) fn()
    },
    listeners: () => fns.size,
  }
}

/** Fake timers (`tick()` advances one period) */
function fakeTimers() {
  const live = new Map<number, () => void>()
  let next = 1
  const t: Timers & { tick(): void; running(): number } = {
    set: (fn) => {
      const id = next++
      live.set(id, fn)
      return id
    },
    clear: (h) => void live.delete(h as number),
    tick: () => {
      for (const fn of [...live.values()]) fn()
    },
    running: () => live.size,
  }
  return t
}

test('★★ not called in the background; on return, calls once immediately and resumes', () => {
  const d = fakeDoc('visible')
  const tm = fakeTimers()
  let calls = 0
  const stop = whileVisible(() => calls++, 15000, d.doc, tm)
  tm.tick()
  assert.equal(calls, 1)
  d.set('hidden')
  tm.tick()
  tm.tick()
  assert.equal(calls, 1, '⚠️⚠️ called while in the background (messages keep flowing to the relay)')
  assert.equal(tm.running(), 0, '⚠️ a timer is left running in the background')
  d.set('visible')
  assert.equal(calls, 2, '⚠️ did not refetch immediately on return (shows a stale screen for up to 15s)')
  tm.tick()
  assert.equal(calls, 3)
  stop()
  assert.equal(d.listeners(), 0, '⚠️ listener not removed')
  assert.equal(tm.running(), 0)
})

test('★★ opened in the background: does not start (starts when foregrounded); a repeat event while visible does not double up', () => {
  const d = fakeDoc('hidden')
  const tm = fakeTimers()
  let calls = 0
  whileVisible(() => calls++, 3000, d.doc, tm)
  assert.equal(tm.running(), 0)
  d.set('visible')
  assert.equal(calls, 1)
  assert.equal(tm.running(), 1)
  // ⚠️ Even if visibilitychange fires while still visible (some devices do), don't make two timers
  d.set('visible')
  assert.equal(tm.running(), 1)
  assert.equal(calls, 1)
})

test('★★ what is called on return can be separate (the list refetches everything, not the schedule)', () => {
  const d = fakeDoc('visible')
  const tm = fakeTimers()
  const calls: string[] = []
  whileVisible(() => calls.push('tick'), 15000, d.doc, tm, () => calls.push('resume'))
  tm.tick()
  d.set('hidden')
  d.set('visible')
  tm.tick()
  assert.deepEqual(calls, ['tick', 'resume', 'tick'])
})

test('★★ without document (tests, SSR), keeps running as before', () => {
  const tm = fakeTimers()
  let calls = 0
  const stop = whileVisible(() => calls++, 3000, undefined, tm)
  tm.tick()
  assert.equal(calls, 1)
  stop()
  assert.equal(tm.running(), 0)
})

test('★★ list and thread polling go through whileVisible (never back to a bare setInterval)', async () => {
  // ⚠️⚠️ `.tsx` has no behavioral tests, so check the wiring textually (reverting brings us near the relay limit again)
  const { readFileSync } = await import('node:fs')
  const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')
  const thread = readFileSync(new URL('./ui/Thread.tsx', import.meta.url), 'utf8')
  // ★★ The list polls only endpoints whose turn has come per tick; everything on return (2026-09-24 / ui/pollPlan.ts)
  assert.match(
    main,
    /whileVisible\(pollDue, POLL_TICK_MS, globalThis\.document, undefined, \(\) => void refreshRef\.current\?\.\(\)\)/,
  )
  // ⚠️⚠️ The turn check looks at whether the signal line is alive (otherwise it won't stretch to 60s / stretches too far)
  assert.match(main, /isPollDue\(pollRef\.current\[t\.endpoint\.id\], t\.eventsLive\(\), now\)/)
  // ⚠️⚠️ Success resets the failure count, failure increments it (with only one, the interval never widens / never resets)
  assert.match(main, /pollRef\.current\[id\] = notePoll\(pollRef\.current\[id\], true, startedAt, \{ partial: !perms\.known \}\)/)
  // ⚠️⚠️ Don't throttle hello by time (throttled, approvals raised before the line won't show until the next fallback / codex round 17, medium #1)
  // ★ Look only at executed lines (drop comments and the next branch's `} else if (`)
  const hello = main
    .slice(main.indexOf("event.type === 'hello'") + 1, main.indexOf("event.type === 'heartbeat'"))
    .split('} else')[0]!
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
  assert.match(hello, /\n\s*void refresh\(new Set\(\[id\]\)\)/)
  assert.doesNotMatch(hello, /if \(/, '⚠️⚠️ the hello refetch has a condition attached')
  assert.match(main, /pollRef\.current\[id\] = notePoll\(pollRef\.current\[id\], false, startedAt\)/)
  // ⚠️⚠️ A signal refetches only the machine that sent it (querying all multiplies relay volume by machine count)
  // ★ The signal receiver is inside `syncSubscriptions` (2026-09-24 / subscribes even as endpoints are added)
  const events = main.slice(main.indexOf("event.type === 'permissions-changed'"), main.indexOf('}, [transports])'))
  assert.ok(events.length > 0, '⚠️ signal receiver not found (the test itself is stale)')
  assert.equal(events.match(/void refresh\(\)/g), null, '⚠️ a signal refetches all machines')
  assert.equal(events.match(/void refresh\(new Set\(\[id\]\)\)/g)?.length, 3)
  // ★ The thread follows via notifications; its fallback / legacy-agent polling also goes through whileVisible (2026-09-23)
  assert.match(thread, /const stopPoll = whileVisible\(pull, plan\.pollMs, globalThis\.document\)/)
  // ⚠️⚠️ The follow subscription is also **only while visible** (unsubscribed in the background)
  assert.match(thread, /subscribeWhileVisible\(\s*\(\) =>\s*transport\.followLog\(sessionId,/)
  // ★★ During the first load, following waits for it (no double read that rewinds / codex round 16, medium #3)
  assert.match(thread, /firstLoadRef\.current = first/)
  assert.match(thread, /const first = firstLoadRef\.current\s*\n\s*if \(first\) await first\.catch\(\(\) => undefined\)/)
  // ★ Cleanup also cancels the scheduled fetch (round 16, low #4)
  assert.match(thread, /stopFollow\(\)\s*\n(?:\s*\/\/[^\n]*\n)*\s*pull\.stop\(\)/)
  for (const [name, src] of [['main.tsx', main], ['Thread.tsx', thread]] as const) {
    assert.doesNotMatch(src, /setInterval\([^)]*\b(REFRESH_MS|POLL_MS|LEGACY_POLL_MS|FOLLOW_FALLBACK_MS)\b/, `⚠️⚠️ ${name} polls with a bare setInterval`)
  }
})
