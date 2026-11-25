import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { noteAgyBlocked, resetAgyBlockedForTest, transcriptPathOf } from './sessions.ts'
import { agyStatuses, startAgyWatch } from './watch.ts'

const A = '062a8f25-9451-42f3-ae93-34a208e99365'
const file = (state: string, ctx = 1) =>
  JSON.stringify({ nyanPid: 4242, nyanBusyAt: 0, input: { conversation_id: A, cwd: '/home/user/w', agent_state: state, context_window: { used_percentage: ctx } } })
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('watch: a state change says "changed" once; a context-only rewrite stays quiet', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-agy-watch-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, `session-${A}.json`), file('idle'))
  let n = 0
  const w = await startAgyWatch(dir, () => n++)
  t.after(() => w.close())
  writeFileSync(join(dir, `session-${A}.json`), file('working'))
  await wait(800)
  assert.equal(n, 1)
  writeFileSync(join(dir, `session-${A}.json`), file('working', 9))
  await wait(800)
  assert.equal(n, 1, 'context alone is not a list change')
  writeFileSync(join(dir, `session-${A}.json`), file('idle', 9))
  await wait(800)
  assert.equal(n, 2)
})

test('watch: steady writes (two conversations in turn) still say "changed" without waiting for them to stop', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-agy-watch2-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const B = '6c0298e8-77c4-406c-aa97-cbecdfd19c88'
  const other = (ctx: number) => file('working', ctx).replaceAll(A, B)
  writeFileSync(join(dir, `session-${A}.json`), file('idle'))
  writeFileSync(join(dir, `session-${B}.json`), other(0))
  let n = 0
  const w = await startAgyWatch(dir, () => n++)
  t.after(() => w.close())
  writeFileSync(join(dir, `session-${A}.json`), file('working'))
  for (let i = 1; i <= 10; i++) {
    await wait(100)
    writeFileSync(join(dir, `session-${B}.json`), other(i))
  }
  assert.ok(n >= 1, 'the change was said while writes went on')
})

test('★ watch: a card and a question are different states (an approval then a question in one response is a change)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'nyan-agy-watch3-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'agy')
  mkdirSync(dir)
  const tr = transcriptPathOf(A, root)
  mkdirSync(join(tr, '..'), { recursive: true })
  const at = '2026-11-21T00:08:03Z'
  writeFileSync(
    tr,
    [
      { type: 'USER_INPUT', step_index: 0, created_at: at, content: 'x' },
      { type: 'PLANNER_RESPONSE', step_index: 1, created_at: at, tool_calls: [{ name: 'ask_question', args: {} }] },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  )
  const sec = Date.parse(at) / 1000
  utimesSync(tr, sec + 5, sec + 5)
  const f = join(dir, `session-${A}.json`)
  writeFileSync(f, JSON.stringify({ nyanPid: 4242, nyanBusyAt: 1, input: { conversation_id: A, cwd: '/home/user/w', agent_state: 'tool_use', tool_confirmation_pending: true } }))
  utimesSync(f, sec + 6, sec + 6)
  const card = (await agyStatuses(dir, root)).get(A)
  writeFileSync(f, file('tool_use'))
  utimesSync(f, sec + 6, sec + 6)
  const question = (await agyStatuses(dir, root)).get(A)
  assert.equal(card, '4242:waiting:card')
  assert.equal(question, '4242:waiting:question')
  // ★ a subagent's approval up, then the parent's own card beside it: a change too (codex review)
  resetAgyBlockedForTest()
  t.after(() => resetAgyBlockedForTest())
  noteAgyBlocked(A, 4242, 1, Date.now())
  const kid = (pending: boolean): string => JSON.stringify({ nyanPid: 4242, nyanBusyAt: 1, input: { conversation_id: A, cwd: '/home/user/w', agent_state: 'idle', tool_confirmation_pending: pending, subagents: [{ status: 'running', role: 'x' }] } })
  writeFileSync(f, kid(false))
  const blocked = (await agyStatuses(dir, root)).get(A)
  writeFileSync(f, kid(true))
  const both = (await agyStatuses(dir, root)).get(A)
  assert.equal(blocked, '4242:waiting:question')
  assert.notEqual(both, blocked)
})
