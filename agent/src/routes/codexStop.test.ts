// ★ The stop endpoint for Codex rows (`codexStop` / 2026-11-15 / docs/CODEX.md §5.4).
// The daemon side is tested in `codex/daemon.test.ts`; here: which ids are ours, and what the phone is told.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CodexInterruptResult } from '../codex/daemon.ts'
import { HttpError } from '../router.ts'
import { codexStop } from './interrupt.ts'

const CODEX_ID = 'codex-0123abcd0123abcd-01a1d8d9-66fc-7823-968f-c97d7234176e'

function codexWorld(...given: [(CodexInterruptResult | undefined)?]) {
  // ⚠️ `undefined` passed on purpose is a result too (a default parameter would swallow it)
  const result: CodexInterruptResult | undefined = given.length > 0 ? given[0] : { ok: true }
  const asked: string[] = []
  return {
    asked,
    codex: {
      lists: (id: string) => id === CODEX_ID,
      interrupt: async (id: string) => {
        asked.push(id)
        return result
      },
    },
  }
}

async function status(run: Promise<unknown>): Promise<number | 'ok'> {
  try {
    await run
    return 'ok'
  } catch (err) {
    assert.ok(err instanceof HttpError)
    return err.status
  }
}

test('an id that is not a Codex row is not ours (undefined): the Claude route follows, the daemon is never asked', async () => {
  const w = codexWorld()
  assert.equal(await codexStop('5f0c2b9e-1111-4222-8333-944455556666', w.codex), undefined)
  assert.deepEqual(w.asked, [])
})

test('★ a Codex row id that no line lists now is "not open" (409), never handed to the Claude route', async () => {
  const w = codexWorld(undefined)
  const other = 'codex-ffffffffffffffff-01a1d8d9-66fc-7823-968f-c97d7234176e'
  assert.equal(await status(codexStop(other, w.codex)), 409)
})

test('★ a listed Codex row is stopped by the daemon, and the reply carries no `cleared` (nothing is cleared on the PC)', async () => {
  const w = codexWorld()
  const res = await codexStop(CODEX_ID, w.codex)
  assert.deepEqual(w.asked, [CODEX_ID])
  assert.equal(res?.ok, true)
  assert.equal(res?.cleared, undefined)
})

test('refusals: the state of the other side is 409, a second press on its way is 429 — never a fall-through', async () => {
  for (const [r, want] of [
    [{ ok: false, reason: 'idle' }, 409],
    [{ ok: false, reason: 'waiting' }, 409],
    [{ ok: false, reason: 'not-listed' }, 409],
    [{ ok: false, reason: 'failed', detail: 'error -32600' }, 409],
    [{ ok: false, reason: 'too-soon' }, 429],
    // The row vanished between the look and the stop
    [undefined, 409],
  ] as Array<[CodexInterruptResult | undefined, number]>) {
    assert.equal(await status(codexStop(CODEX_ID, codexWorld(r).codex)), want, JSON.stringify(r))
  }
})

test('★ "clear the input box" refuses a Codex row id (409) instead of handing it to the Claude route', async () => {
  const { sessionClear } = await import('./interrupt.ts')
  const ctx = { params: { id: CODEX_ID } } as unknown as Parameters<typeof sessionClear>[0]
  assert.equal(await status(sessionClear(ctx)), 409)
})
