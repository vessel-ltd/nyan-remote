import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalize } from './agents.ts'

// ★ The `claude agents --json` side (**the only path** on machines with an old CLI that has no index).
//
// ⚠️ 2026-08-18 codex review, medium #4: `waitingFor` was carried from the index
//    but dropped here (= only on that machine, the reason for "needs attention" silently went missing).
//    Tests that use the index never enter this path, so we check it directly here.

test('★★ normalize: does not drop waitingFor (the only path on machines without an index)', () => {
  // Shape of real CLI 2.1.234 output（`...p.status==="waiting" && p.waitingFor && {waitingFor}`）
  const out = normalize(
    JSON.stringify([
      {
        pid: 111,
        cwd: '/home/x/proj',
        kind: 'interactive',
        startedAt: 1,
        sessionId: 'S-waiting',
        name: 'なにか',
        status: 'waiting',
        waitingFor: 'input needed',
      },
      { pid: 222, cwd: '/home/x/p2', startedAt: 2, sessionId: 'S-busy', status: 'busy' },
    ]),
  )
  assert.equal(out.length, 2)
  assert.equal(out[0]?.sessionId, 'S-waiting')
  assert.equal(out[0]?.waitingFor, 'input needed')
  // No reason stays undefined (do not invent one)
  assert.equal(out[1]?.waitingFor, undefined)
})

test('normalize: does not crash on broken or non-array output', () => {
  assert.deepEqual(normalize(''), [])
  assert.deepEqual(normalize('{ 壊れている'), [])
  assert.deepEqual(normalize('{"not":"an array"}'), [])
  // Items without sessionId are unusable (neither a destination nor displayable)
  assert.deepEqual(normalize(JSON.stringify([{ pid: 1, status: 'busy' }])), [])
})
