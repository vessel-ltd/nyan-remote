import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { callBeforeState, lastTurnStart, lastTurnStartCached, readTailRecords, turnEnd } from './pending.ts'

const user = (step: number) => ({ step_index: step, type: 'USER_INPUT', content: '<USER_REQUEST>\nx\n</USER_REQUEST>' })
const PLAN_AT = '2026-11-20T04:00:00Z'
const plan = (step: number, calls?: { name: string; args: Record<string, unknown> }[], content?: string) => ({
  step_index: step,
  type: 'PLANNER_RESPONSE',
  created_at: PLAN_AT,
  ...(calls ? { tool_calls: calls } : {}),
  ...(content ? { content } : {}),
})
// a result of a call made by that response (created at or after it; agy writes the local time with its offset)
const result = (step: number, createdAt = '2026-11-20T13:00:05+09:00') => ({ step_index: step, type: 'GENERIC', content: `Created At: ${createdAt}\nCompleted At: ${createdAt}\nok` })
const sys = (step: number) => ({ step_index: step, type: 'SYSTEM_MESSAGE', content: 'Reminder' })
const cmd = (c: string) => ({ name: 'run_command', args: { CommandLine: c } })

test('the card is the first call of the last response without a result (calls run in order)', () => {
  // one call, card up
  assert.deepEqual(turnEnd([user(0), plan(1, [cmd('ls')])]), { turn: 0, answered: false, pending: { step: 1, index: 0, name: 'run_command', args: { CommandLine: 'ls' }, at: Date.parse(PLAN_AT) }, afterPrompt: true })
  // a parallel pair: the first ran (its result is written before the next card)
  const two = [user(7), plan(8, [cmd('echo one'), cmd('echo two')]), result(9)]
  assert.deepEqual(turnEnd(two).pending, { step: 8, index: 1, name: 'run_command', args: { CommandLine: 'echo two' }, at: Date.parse(PLAN_AT) })
  // a system reminder in between says nothing about the call
  assert.equal(turnEnd([user(0), plan(1, [cmd('a'), cmd('b')]), result(2), sys(3)]).pending?.index, 1)
  // every call has its result: nothing pending (the model is thinking again)
  assert.deepEqual(turnEnd([user(0), plan(1, [cmd('a')]), result(2)]), { turn: 0, answered: false, afterPrompt: true })
  // the prompt is the last record: nothing written after it yet
  assert.equal(turnEnd([user(0)]).afterPrompt, undefined)
  // a system reminder is not the model's
  assert.equal(turnEnd([user(0), sys(1)]).afterPrompt, undefined)
  assert.equal(turnEnd([user(0), sys(1), { step_index: 2, type: 'ERROR_MESSAGE' }]).afterPrompt, true)
})

test('a turn counts as answered only when it ends with the model’s answer', () => {
  assert.equal(turnEnd([user(0), plan(1, [cmd('ls')]), result(2), sys(3), plan(4, undefined, 'Done.')]).answered, true)
  assert.equal(turnEnd([user(0), plan(1, [], 'Done.')]).answered, true)
  // stopped before the model answered / a declined card (nothing written after the call)
  assert.equal(turnEnd([plan(1, undefined, 'old answer'), user(2)]).answered, false)
  assert.equal(turnEnd([user(0), plan(1, [cmd('ls')])]).answered, false)
  assert.equal(turnEnd([user(0), { step_index: 1, type: 'ERROR_MESSAGE', error: 'x' }]).answered, false)
  // the turn is the last request
  assert.equal(turnEnd([user(0), plan(1, undefined, 'a'), user(2), plan(3, undefined, 'b')]).turn, 2)
  assert.deepEqual(turnEnd([]), { answered: false })
})

test('a malformed call or step is no card (fail-closed)', () => {
  assert.equal(turnEnd([plan(1, [{ name: 'run_command' } as never])]).pending, undefined)
  assert.equal(turnEnd([plan(1, [{ name: 7, args: {} } as never])]).pending, undefined)
  assert.equal(turnEnd([{ type: 'PLANNER_RESPONSE', tool_calls: [cmd('ls')] }]).pending, undefined)
  assert.equal(turnEnd([plan(1, ['x' as never])]).pending, undefined)
})

test('the tail: only whole records (a half-written last line and a cut first line are left out)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-agy-pending-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const p = join(dir, 't.jsonl')
  const lines = [user(0), plan(1, [cmd('ls')])].map((r) => JSON.stringify(r))
  writeFileSync(p, lines.join('\n') + '\n' + '{"step_index":2,"type":"GEN')
  assert.deepEqual(readTailRecords(p).map((r) => r['step_index']), [0, 1])
  // read from the middle of the first record: it is dropped, the second stays
  assert.deepEqual(readTailRecords(p, Buffer.byteLength(lines[1]!) + 30).map((r) => r['step_index']), [1])
  writeFileSync(p, 'not json\n' + lines[1] + '\n')
  assert.deepEqual(readTailRecords(p).map((r) => r['step_index']), [1])
  assert.deepEqual(readTailRecords(join(dir, 'missing')), [])
})

test('the call carries its time; a call newer than the state (or without a time) is not the card', () => {
  const at = '2026-11-20T04:56:21Z'
  const p = turnEnd([user(0), { ...plan(1, [cmd('ls')]), created_at: at }]).pending!
  assert.equal(p.at, Date.parse(at))
  assert.equal(callBeforeState(p, Date.parse(at) + 400), true)
  assert.equal(callBeforeState(p, Date.parse(at)), true)
  assert.equal(callBeforeState(p, Date.parse(at) - 1), false)
  assert.equal(callBeforeState({}, Date.parse(at)), false)
})

test('★ the turn’s prompt is found further back than the tail, also across a chunk boundary; not past the limit', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-agy-turn-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const p = join(dir, 't.jsonl')
  const prompt = JSON.stringify({ step_index: 4, type: 'USER_INPUT', created_at: '2026-11-20T04:56:21Z', content: 'x'.repeat(5000) }) + '\n'
  const filler = JSON.stringify({ step_index: 5, type: 'GENERIC', content: 'y'.repeat(1000) }) + '\n'
  const MIB = 1024 * 1024
  // the prompt straddles the 1 MiB boundary counted from the end
  const after = Math.floor((MIB - 2000) / Buffer.byteLength(filler)) + 1
  const body = JSON.stringify({ step_index: 1, type: 'USER_INPUT', created_at: '2026-11-20T04:00:00Z' }) + '\n' + prompt + filler.repeat(after)
  writeFileSync(p, body + '{"step_index":99,"type":"USER_INP')
  assert.ok(Buffer.byteLength(body) - MIB > 0 && Buffer.byteLength(body) - MIB < Buffer.byteLength(prompt) + 100)
  assert.deepEqual(lastTurnStart(p), { turn: 4, at: Date.parse('2026-11-20T04:56:21Z') })
  // beyond the limit: not found
  assert.equal(lastTurnStart(p, 1000), undefined)
  // the tail alone does not hold it
  assert.equal(turnEnd(readTailRecords(p, 64 * 1024)).turn, undefined)
  assert.equal(lastTurnStart(join(dir, 'missing')), undefined)
})

test('★★ a result whose call is older than the response is another agy’s: no card (it would shift which call is up)', () => {
  // a second agy's slow tool, started before this response, finished after it
  const foreign = [user(0), plan(1, [cmd('rm -rf build'), cmd('cat a.txt')]), result(2, '2026-11-20T12:59:00+09:00')]
  assert.equal(turnEnd(foreign).pending, undefined)
  // a result that does not say when its call was made
  assert.equal(turnEnd([user(0), plan(1, [cmd('a'), cmd('b')]), { step_index: 2, type: 'GENERIC', content: 'ok' }]).pending, undefined)
  // the response's own result (same second) counts
  assert.equal(turnEnd([user(0), plan(1, [cmd('a'), cmd('b')]), result(2, '2026-11-20T13:00:00+09:00')]).pending?.index, 1)
})

test('the cached lookup follows a growing file (new prompt found, old one kept) and starts over when it shrinks', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-agy-turncache-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const p = join(dir, 't.jsonl')
  const u = (step: number, at: string) => JSON.stringify({ step_index: step, type: 'USER_INPUT', created_at: at }) + '\n'
  writeFileSync(p, u(1, '2026-11-20T04:00:00Z'))
  assert.equal(lastTurnStartCached(p)?.turn, 1)
  appendFileSync(p, JSON.stringify({ step_index: 2, type: 'GENERIC', content: 'x' }) + '\n')
  assert.equal(lastTurnStartCached(p)?.turn, 1)
  appendFileSync(p, u(3, '2026-11-20T04:01:00Z'))
  assert.equal(lastTurnStartCached(p)?.turn, 3)
  writeFileSync(p, u(9, '2026-11-20T05:00:00Z'))
  assert.equal(lastTurnStartCached(p)?.turn, 9)
  rmSync(p)
  assert.equal(lastTurnStartCached(p), undefined)
})
