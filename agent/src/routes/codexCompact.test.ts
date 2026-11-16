// ★ The command endpoint for Codex rows (`codexCommand` / 2026-11-16 / docs/CODEX.md §5.8).
// The daemon side is tested in `codex/daemon.test.ts`; here: which ids are ours, which commands, and what the phone is told.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CodexSendResult } from '../codex/daemon.ts'
import { HttpError } from '../router.ts'
import { codexCommand } from './command.ts'

const CODEX_ID = 'codex-0123abcd0123abcd-01a1d8d9-66fc-7823-968f-c97d7234176e'

function codexWorld(...given: [(CodexSendResult | undefined)?]) {
  // ⚠️ `undefined` passed on purpose is a result too (a default parameter would swallow it)
  const result: CodexSendResult | undefined = given.length > 0 ? given[0] : { ok: true }
  const asked: string[] = []
  return {
    asked,
    codex: {
      lists: (id: string) => id === CODEX_ID,
      compact: async (id: string) => {
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
  assert.equal(await codexCommand('5f0c2b9e-1111-4222-8333-944455556666', 'compact', w.codex), undefined)
  assert.equal(await codexCommand('5f0c2b9e-1111-4222-8333-944455556666', 'exit', w.codex), undefined)
  assert.deepEqual(w.asked, [])
})

test('★ compact on a listed Codex row goes to the daemon', async () => {
  const w = codexWorld()
  const res = await codexCommand(CODEX_ID, 'compact', w.codex)
  assert.deepEqual(w.asked, [CODEX_ID])
  assert.equal(res?.ok, true)
  assert.equal(res?.id, 'compact')
})

test('★ exit is refused for a Codex row (400), and the daemon is never asked — never a fall-through to keystrokes', async () => {
  const w = codexWorld()
  assert.equal(await status(codexCommand(CODEX_ID, 'exit', w.codex)), 400)
  // A Codex id no line lists now is refused the same way (it must not reach the Claude route)
  const other = 'codex-ffffffffffffffff-01a1d8d9-66fc-7823-968f-c97d7234176e'
  assert.equal(await status(codexCommand(other, 'exit', w.codex)), 400)
  assert.deepEqual(w.asked, [])
})

test('★ a Codex row id that no line lists now is "not open" (409), never handed to the Claude route', async () => {
  const w = codexWorld(undefined)
  const other = 'codex-ffffffffffffffff-01a1d8d9-66fc-7823-968f-c97d7234176e'
  assert.equal(await status(codexCommand(other, 'compact', w.codex)), 409)
})

test('refusals are 409 — busy, not-listed, failed, and a row that vanished between the two looks', async () => {
  for (const r of [
    { ok: false, reason: 'busy' },
    { ok: false, reason: 'not-listed' },
    { ok: false, reason: 'failed', detail: 'error -32603' },
    undefined,
  ] as Array<CodexSendResult | undefined>) {
    assert.equal(await status(codexCommand(CODEX_ID, 'compact', codexWorld(r).codex)), 409, JSON.stringify(r))
  }
})

test('★ the endpoint asks the Codex side before the Claude route (a Codex id never reaches the keystroke table)', async () => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const src = await readFile(fileURLToPath(new URL('./command.ts', import.meta.url)), 'utf8')
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
  const fn = code.slice(code.indexOf('export async function sessionCommand'))
  const codexAt = fn.indexOf('await codexCommand(sessionId, id)')
  const claudeAt = fn.indexOf('sendCommandToSession(')
  assert.ok(codexAt > 0 && claudeAt > 0 && codexAt < claudeAt)
  assert.ok(/if \(viaCodex\) return viaCodex/.test(fn.slice(codexAt, claudeAt)))
})
