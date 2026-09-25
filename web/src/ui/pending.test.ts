import assert from 'node:assert/strict'
import { test } from 'node:test'
import { beginSend, consumeAfterReload, consumePending, finishSend, noteArrivals, type PendingSend } from './pending.ts'

const sent = (text: string, at = 1): PendingSend => ({ text, at, route: 'inbox' })
const typed = (text: string, at = 1): PendingSend => ({ text, at, route: 'keys' })
const inbox = (text: string) => ({ kind: 'user', text, via: 'inbox' })
/** ★ Delivered by keystrokes. ⚠️ **No `via`** (same shape as human typing) */
const asKeys = (text: string) => ({ kind: 'user', text })

test('a delivered instruction disappears from the optimistic entries', () => {
  assert.deepEqual(consumePending([sent('やっといて')], [inbox('やっといて')]), [])
})

test('★★ not cleared by the same text sent in the past (look only at what was added)', () => {
  // ⚠️ It used to put the whole thread's text in a Set, so **a send not yet delivered**
  //    hit an old identical message and counted as "delivered"
  const pending = [sent('続けて', 2)]
  const arrivals = [{ kind: 'assistant', text: 'はい' }] // only Claude's reply was added
  assert.deepEqual(consumePending(pending, arrivals), pending)
})

test('★ sending the same text twice: one arrival leaves one pending', () => {
  const rest = consumePending([sent('続けて', 1), sent('続けて', 2)], [inbox('続けて')])
  assert.equal(rest.length, 1)
})

test('not cleared by messages not from the inbox (typed on the PC)', () => {
  const pending = [sent('やっといて')]
  assert.deepEqual(consumePending(pending, [{ kind: 'user', text: 'やっといて' }]), pending)
})

test('empty or unrelated input does not crash; unchanged returns the same array (no extra re-render)', () => {
  const pending = [sent('x')]
  assert.equal(consumePending(pending, []), pending)
  assert.equal(consumePending(pending, [{ kind: 'tool_use' }]), pending)
  assert.deepEqual(consumePending([], [inbox('x')]), [])
})

// ─── ★★ Sent by keystrokes (no frame) / a bug seen on a real device on 2026-08-23 ───────

test('★★ sent by keystrokes: cleared by a message without `via`', () => {
  // ⚠️⚠️ It only looked at `via === "inbox"`, so **although delivered by keystrokes,
  //    "cannot confirm delivery" did not clear** (it cleared on leaving and re-entering the thread, so
  //    it looked like "maybe it was not sent")
  assert.deepEqual(consumePending([typed('やっといて')], [asKeys('やっといて')]), [])
})

test('★★ a different route does not clear (sent by inbox, but a no-`via` arrived = typed on the PC)', () => {
  const pending = [sent('やっといて')]
  assert.deepEqual(consumePending(pending, [asKeys('やっといて')]), pending)
})

test('★ sent by keystrokes but arrived with the inbox mark ⇒ not cleared (no mixing of routes)', () => {
  const pending = [typed('やっといて')]
  assert.deepEqual(consumePending(pending, [inbox('やっといて')]), pending)
})

test('★★ not cleared by another session\'s message (even with the same text)', () => {
  const pending = [typed('やっといて')]
  const peer = [{ kind: 'user', text: 'やっといて', via: 'peer' }]
  assert.deepEqual(consumePending(pending, peer), pending)
})

test('old agents that do not return route are treated as inbox (versions without the keystroke route)', () => {
  const old: PendingSend[] = [{ text: 'x', at: 1 }]
  assert.deepEqual(consumePending(old, [inbox('x')]), [])
  assert.deepEqual(consumePending(old, [asKeys('x')]), old)
})

// ─── ★★ Stack at the moment of sending (2026-09-24 / codex round 25) ──────────────────────

const atIso = (ms: number) => new Date(ms).toISOString()
const T0 = Date.parse('2026-09-24T10:00:00Z')

test('★★ arrived before the reply (keystrokes) ⇒ confirmed and cleared by the reply', () => {
  let p = beginSend([], 1, 'こんにちは', T0)
  p = noteArrivals(p, [{ ...asKeys('こんにちは'), at: atIso(T0 + 100) }])
  assert.equal(p.length, 1, '⚠️ cleared before the reply (the route is still unknown)')
  assert.deepEqual(finishSend(p, 1, 'keys'), [])
})

test('★★ no miss even if more than 100 unrelated records arrive before the reply (medium #4)', () => {
  let p = beginSend([], 1, 'やっといて', T0)
  p = noteArrivals(p, [{ ...asKeys('やっといて'), at: atIso(T0 + 1) }])
  p = noteArrivals(p, Array.from({ length: 250 }, () => ({ kind: 'assistant', text: 'x' })))
  assert.deepEqual(finishSend(p, 1, 'keys'), [])
})

test('★★ once the reply reveals the route, a mismatched note does not clear; a matching record arriving later does', () => {
  let p = beginSend([], 1, 'やっといて', T0)
  // The same text was typed on the PC (no via), but the phone sent via the inbox
  p = noteArrivals(p, [{ ...asKeys('やっといて'), at: atIso(T0 + 1) }])
  p = finishSend(p, 1, 'inbox')
  assert.equal(p.length, 1)
  assert.equal(p[0]!.sending, undefined)
  assert.deepEqual(noteArrivals(p, [{ ...inbox('やっといて'), at: atIso(T0 + 2) }]), [])
})

test('★★ a failed send is cleared; unknown ids are left alone', () => {
  const p = beginSend([], 1, 'x', T0)
  assert.deepEqual(finishSend(p, 1, null), [])
  assert.equal(finishSend(p, 9, 'keys'), p)
})

test('★★ full reload: matches even while awaiting a reply (medium #3), judged by each send\'s time (medium #1)', () => {
  const used = new Set<string>()
  // A remains from 10:00 (confirmed, not delivered). B was sent at 10:01 (awaiting reply)
  let p: PendingSend[] = [{ id: 1, text: 'B', at: T0, route: 'keys' }]
  p = beginSend(p, 2, 'B', T0 + 60_000)
  // The reload contains an older B at 10:00:10 and a new B at 10:01:01
  const old = { ...asKeys('B'), at: atIso(T0 + 10_000) }
  const now = { ...asKeys('B'), at: atIso(T0 + 61_000) }
  p = consumeAfterReload(p, [old, now], used)
  // The older B clears #1 (sent at 10:00). The new B is noted for #2 (awaiting reply)
  assert.deepEqual(p.map((x) => x.id), [2])
  assert.deepEqual(finishSend(p, 2, 'keys'), [])
})

test('★★ one record is used only once (reloading does not let the same record clear the next send / medium #1)', () => {
  const used = new Set<string>()
  const rec = { ...asKeys('続けて'), at: atIso(T0 + 1000) }
  let p: PendingSend[] = [
    { id: 1, text: '続けて', at: T0, route: 'keys' },
    { id: 2, text: '続けて', at: T0, route: 'keys' },
  ]
  p = consumeAfterReload(p, [rec], used)
  p = consumeAfterReload(p, [rec], used)
  assert.deepEqual(p.map((x) => x.id), [2], '⚠️⚠️ cleared both with the same record')
  // Records used during live follow are not used on reload either
  const used2 = new Set<string>()
  let q: PendingSend[] = [
    { id: 1, text: 'y', at: T0, route: 'keys' },
    { id: 2, text: 'y', at: T0, route: 'keys' },
  ]
  const r = { ...asKeys('y'), at: atIso(T0 + 5) }
  q = noteArrivals(q, [r], used2)
  q = consumeAfterReload(q, [r], used2)
  assert.deepEqual(q.map((x) => x.id), [2])
})

test('★★ full reload: not cleared by the same text sent earlier, nor by records without a time', () => {
  const pending: PendingSend[] = [{ id: 1, text: 'こんにちは', at: T0 + 120_000, route: 'keys' }]
  assert.deepEqual(consumeAfterReload(pending, [{ ...asKeys('こんにちは'), at: atIso(T0) }], new Set()), pending)
  assert.deepEqual(consumeAfterReload(pending, [asKeys('こんにちは')], new Set()), pending)
  assert.deepEqual(consumeAfterReload(pending, [{ ...asKeys('こんにちは'), at: atIso(T0 + 121_000) }], new Set()), [])
})
