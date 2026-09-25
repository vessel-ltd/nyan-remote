import assert from 'node:assert/strict'
import { test } from 'node:test'
import { beginSend, consumeAfterReload, consumePending, finishSend, noteArrivals, textFit, type PendingSend } from './pending.ts'

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

test('★★ keystrokes joined to a half-typed PC draft still clear the send (2026-09-25 / reproduced on a real device)', () => {
  const p: PendingSend[] = [{ text: 'Test', at: 1, route: 'keys' }]
  assert.deepEqual(consumePending(p, [{ kind: 'user', text: 'あいうTest' }]), [])
  // ⚠️ Not when the record only contains it in the middle
  assert.equal(consumePending(p, [{ kind: 'user', text: 'Test the upload' }]).length, 1)
  // ⚠️ The inbox joins nothing ⇒ still exact
  assert.equal(consumePending([{ text: 'Test', at: 1, route: 'inbox' }], [{ kind: 'user', text: 'xTest', via: 'inbox' }]).length, 1)
})

test('★★ joined text also matches while awaiting the reply and on a full reload', () => {
  const noted = noteArrivals(beginSend([], 1, 'Test', 1000), [{ kind: 'user', text: 'あいうTest', at: '2026-01-01T00:00:01Z' }], new Set())
  assert.deepEqual(finishSend(noted, 1, 'keys'), [])
  const settled: PendingSend[] = [{ id: 2, text: 'Test', at: Date.parse('2026-01-01T00:00:00Z'), route: 'keys' }]
  assert.deepEqual(consumeAfterReload(settled, [{ kind: 'user', text: 'あいうTest', at: '2026-01-01T00:00:02Z' }], new Set()), [])
  // ★ Full reload while still awaiting the reply: noted, then confirmed by the reply
  const reloaded = consumeAfterReload(beginSend([], 4, 'Test', Date.parse('2026-01-01T00:00:00Z')), [{ kind: 'user', text: 'あいうTest', at: '2026-01-01T00:00:02Z' }], new Set())
  assert.deepEqual(finishSend(reloaded, 4, 'keys'), [])
  // ⚠️ A send awaiting its reply that turns out to be inbox is still exact
  const viaInbox = noteArrivals(beginSend([], 3, 'Test', 1000), [{ kind: 'user', text: 'xTest', via: 'inbox', at: '2026-01-01T00:00:03Z' }], new Set())
  assert.equal(viaInbox[0]!.seen?.length, 1, 'the record was not even noted (the check below would pass for the wrong reason)')
  assert.equal(finishSend(viaInbox, 3, 'inbox').length, 1)
})

test('★★ an exact fit wins over a suffix fit (codex, medium #1: `looks ok` must not clear `ok`)', () => {
  const p: PendingSend[] = [
    { id: 1, text: 'ok', at: 1, route: 'keys' },
    { id: 2, text: 'looks ok', at: 2, route: 'keys' },
  ]
  assert.deepEqual(consumePending(p, [{ kind: 'user', text: 'looks ok' }]).map((x) => x.id), [1])
  // ★ Settled and awaiting-reply sends compete together
  const mixed: PendingSend[] = [{ id: 1, text: 'ok', at: 1, route: 'keys' }, { id: 2, text: 'looks ok', at: 2, sending: true, seen: [] }]
  const noted = noteArrivals(mixed, [{ kind: 'user', text: 'looks ok', at: '2026-01-01T00:00:01Z' }], new Set())
  assert.deepEqual(noted.map((x) => x.id), [1, 2])
  assert.equal(noted[1]!.seen?.length, 1, '⚠️ the exact fit went to the settled `ok` instead')
  assert.deepEqual(finishSend(noted, 2, 'keys').map((x) => x.id), [1])
  // ★ Same on a full reload
  const T = Date.parse('2026-01-01T00:00:00Z')
  const r: PendingSend[] = [{ id: 1, text: 'ok', at: T, route: 'keys' }, { id: 2, text: 'looks ok', at: T, route: 'keys' }]
  assert.deepEqual(consumeAfterReload(r, [{ kind: 'user', text: 'looks ok', at: '2026-01-01T00:00:01Z' }], new Set()).map((x) => x.id), [1])
})

test('★★ full reload: a suffix fit needs a record at or after the send (codex, medium #2); exact keeps the clock slack', () => {
  const T = Date.parse('2026-01-01T00:00:10Z')
  const before = [{ kind: 'user', text: 'looks ok', at: '2026-01-01T00:00:06Z' }]
  assert.equal(consumeAfterReload([{ id: 1, text: 'ok', at: T, route: 'keys' }], before, new Set()).length, 1)
  assert.equal(consumeAfterReload(beginSend([], 2, 'ok', T), before, new Set())[0]!.seen?.length, 0, '⚠️ noted an older record by suffix')
  assert.equal(consumeAfterReload([{ id: 3, text: 'ok', at: T, route: 'keys' }], [{ kind: 'user', text: 'looks ok', at: '2026-01-01T00:00:10Z' }], new Set()).length, 0)
  assert.equal(consumeAfterReload([{ id: 4, text: 'ok', at: T, route: 'keys' }], [{ kind: 'user', text: 'ok', at: '2026-01-01T00:00:06Z' }], new Set()).length, 0)
})

test('★★ trailing whitespace of the send is ignored (the agent shows records trimmed / codex, medium #3)', () => {
  assert.deepEqual(consumePending([{ text: 'Test \n', at: 1, route: 'keys' }], [{ kind: 'user', text: 'Test' }]), [])
  assert.deepEqual(consumePending([{ text: 'Test ', at: 1, route: 'inbox' }], [{ kind: 'user', text: 'Test', via: 'inbox' }]), [])
  assert.deepEqual(consumePending([{ text: 'Test\n', at: 1, route: 'keys' }], [{ kind: 'user', text: 'あいうTest' }]), [])
  // ⚠️ A blank send never fits everything
  assert.equal(textFit('keys', ' \n', 'anything'), undefined)
})

test('★★ a record noted by an awaiting-reply send that turns out inbox goes back to the other sends (codex round 2, medium #1)', () => {
  const used = new Set<string>()
  let p: PendingSend[] = [{ id: 1, text: 'ok', at: 1, route: 'keys' }, { id: 2, text: 'looks ok', at: 2, sending: true, seen: [] }]
  // `ok` was typed after a PC draft `looks ` ⇒ the record `looks ok` (no via) is the delivery of send 1
  p = noteArrivals(p, [{ kind: 'user', text: 'looks ok', at: '2026-01-01T00:00:01Z' }], used)
  assert.deepEqual(p.map((x) => [x.id, x.seen?.length]), [[1, undefined], [2, 1]], 'the record must first be noted by the exact fit')
  p = finishSend(p, 2, 'inbox')
  assert.deepEqual(p.map((x) => x.id), [2], '⚠️ the keystroke send `ok` stayed although its record arrived')
  p = noteArrivals(p, [{ kind: 'user', text: 'looks ok', via: 'inbox', at: '2026-01-01T00:00:02Z' }], used)
  assert.deepEqual(p, [])
  // ★ Same through a full reload
  const T = Date.parse('2026-01-01T00:00:00Z')
  const r = consumeAfterReload(
    [{ id: 1, text: 'ok', at: T, route: 'keys' }, { id: 2, text: 'looks ok', at: T + 1, sending: true, seen: [] }],
    [{ kind: 'user', text: 'looks ok', at: '2026-01-01T00:00:01Z' }],
    new Set(),
  )
  assert.deepEqual(r.map((x) => [x.id, x.seen?.length]), [[1, undefined], [2, 1]], 'the record must first be noted by the exact fit')
  assert.deepEqual(finishSend(r, 2, 'inbox').map((x) => x.id), [2])
  // ⚠️ One record clears at most one send
  const two: PendingSend[] = [
    { id: 1, text: 'ok', at: 1, route: 'keys' },
    { id: 2, text: 'ok', at: 2, sending: true, seen: [{ kind: 'user', text: 'ok', at: '2026-01-01T00:00:03Z' }] },
  ]
  assert.deepEqual(finishSend(two, 2, 'keys').map((x) => x.id), [2])
})

test('★★ a reloaded record offered back keeps the reload time rule (codex round 3, medium #1)', () => {
  const at = (s: string) => Date.parse(`2026-01-01T10:00:${s}Z`)
  // A `looks ok` said before both sends; `ok` (keys) has not arrived; `looks ok` awaits its reply
  let p: PendingSend[] = [{ id: 1, text: 'ok', at: at('01'), route: 'keys' }, ...beginSend([], 2, 'looks ok', at('03'))]
  p = consumeAfterReload(p, [{ kind: 'user', text: 'looks ok', at: '2026-01-01T10:00:00Z' }], new Set())
  assert.equal(p[1]!.seen?.length, 1, 'noted for the awaiting send by the exact-fit slack')
  assert.deepEqual(finishSend(p, 2, 'inbox').map((x) => x.id), [1, 2], '⚠️ an older record cleared the undelivered `ok`')
  // ★ A reloaded record at or after the older send still goes back to it
  let q: PendingSend[] = [{ id: 1, text: 'ok', at: at('01'), route: 'keys' }, ...beginSend([], 2, 'looks ok', at('03'))]
  q = consumeAfterReload(q, [{ kind: 'user', text: 'looks ok', at: '2026-01-01T10:00:02Z' }], new Set())
  assert.deepEqual(finishSend(q, 2, 'inbox').map((x) => x.id), [2])  // ⚠️ A live arrival is new by definition, so it is not held to the time rule (the PC clock may be behind)
  let live: PendingSend[] = [{ id: 1, text: 'ok', at: at('10'), route: 'keys' }, ...beginSend([], 2, 'looks ok', at('12'))]
  live = noteArrivals(live, [{ kind: 'user', text: 'looks ok', at: '2026-01-01T10:00:08Z' }], new Set())
  assert.deepEqual(finishSend(live, 2, 'inbox').map((x) => x.id), [2])
})

test('★★ a failed send gives back what it noted (codex round 4, medium #1)', () => {
  let p: PendingSend[] = [{ id: 1, text: 'ok', at: 1, route: 'keys' }, { id: 2, text: 'looks ok', at: 2, sending: true, seen: [] }]
  p = noteArrivals(p, [{ kind: 'user', text: 'looks ok', at: '2026-01-01T00:00:01Z' }], new Set())
  assert.equal(p[1]!.seen?.length, 1)
  assert.deepEqual(finishSend(p, 2, null), [], '⚠️ the delivered `ok` stayed after the newer send failed')
  // ★ A failure with nothing noted just drops the send
  assert.deepEqual(finishSend([{ id: 1, text: 'a', at: 1, route: 'keys' }, ...beginSend([], 2, 'b', 2)], 2, null).map((x) => x.id), [1])
})
