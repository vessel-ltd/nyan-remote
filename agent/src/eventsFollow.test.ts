// ★★ A follow subscription receives only "appended" for that session (2026-09-23 / HANDOFF 5.0-cf)
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { test } from 'node:test'
import { attach, broadcast, followedSessions, notifyFollowers } from './events.ts'

/** Fake SSE response (collects written events) */
function fakeRes() {
  const e = new EventEmitter() as EventEmitter & { got: unknown[] }
  e.got = []
  Object.assign(e, {
    writeHead: () => e,
    write: (chunk: string) => {
      const m = /^data: (.*)\n\n$/s.exec(chunk)
      if (m) e.got.push(JSON.parse(m[1]!))
      return true
    },
  })
  return e
}

test('★★ notifications go only to followers; list notifications are not sent to follows', () => {
  const list = fakeRes()
  const a = fakeRes()
  const b = fakeRes()
  attach(list as unknown as ServerResponse)
  attach(a as unknown as ServerResponse, { follow: 'A' })
  attach(b as unknown as ServerResponse, { follow: 'B' })
  try {
    assert.deepEqual([...followedSessions()].sort(), ['A', 'B'])
    const types = (r: { got: unknown[] }) => r.got.map((x) => (x as { type: string }).type)
    // ★ Right after subscribing: hello (the PWA refetches on it)
    assert.deepEqual(types(a), ['hello'])
    assert.equal(notifyFollowers('A'), 1)
    assert.deepEqual(types(a), ['hello', 'log-appended'])
    assert.deepEqual(types(b), ['hello'], '⚠️⚠️ leaked to a follow of another session')
    assert.deepEqual(types(list), ['hello'], '⚠️⚠️ leaked to the list subscription (/events) = reaches devices not looking')
    broadcast({ type: 'sessions-changed', at: 'x' })
    assert.deepEqual(types(list), ['hello', 'sessions-changed'])
    assert.deepEqual(types(a), ['hello', 'log-appended'], '⚠️ list notification was sent twice into the follow')
  } finally {
    for (const r of [list, a, b]) r.emit('close')
  }
  assert.equal(followedSessions().size, 0, '⚠️ closed follow still registered (the watcher never stops)')
})
