// ★ agy stopped at a plan limit ⇒ "rate-limited" (2026-11-26 / docs/AGY.md §20). Inferred from words: no real sample yet.
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { turnEnd } from './pending.ts'
import { agyLimited, agyOwnRowOf, agyOwnRows, agyRows, agyStatus, isAgyLimitText, parseAgyFile, transcriptPathOf } from './sessions.ts'
import { agyStatuses, startAgyWatch } from './watch.ts'

const A = '062a8f25-9451-42f3-ae93-34a208e99365'

function input(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cwd: '/home/user/work/proj',
    conversation_id: A,
    model: { id: 'Gemini 4 Neon (High)', display_name: 'Gemini 4 Neon (High)', effort: 'high' },
    // ⚠️ A window at 0 alone is not a limit (words only / user decision 2026-11-27)
    quota: { 'gemini-5h': { remaining_fraction: 0, reset_time: '2099-01-01T00:00:00Z' } },
    agent_state: 'idle',
    ...over,
  }
}
const state = (over: Record<string, unknown> = {}) => parseAgyFile({ nyanPid: 100, nyanBusyAt: 7, input: input(over) }, A)!

test('words: agy\'s own limit strings and RESOURCE_EXHAUSTED are a limit; server capacity and a bare 429 are not', () => {
  for (const w of [
    'You have exhausted your quota on this model.',
    'model Gemini 4 Neon is out of quota until 7:40',
    'Usage limit reached',
    'API error: RESOURCE_EXHAUSTED (code 429)',
    'You have exhausted your capacity on this model.',
    'Quota exceeded for quota metric',
  ]) assert.equal(isAgyLimitText(w), true, w)
  for (const w of [
    'API error (attempt 1): transport error (Unavailable, HTTP 503): No capacity available for model gemini-4-neon-high on the server: UNAVAILABLE (code 503)',
    'The stream was interrupted. Please continue the task you were working on.',
    'HTTP 429 Too Many Requests',
    '',
  ]) assert.equal(isAgyLimitText(w), false, w)
  assert.equal(isAgyLimitText(undefined), false)
  assert.equal(isAgyLimitText({ message: 'out of quota' }), false)
})

test('status: limited turns "error" and "idle" into rate-limited; a card, a question or running children still win', () => {
  const s = (agentState: string, extra: Record<string, unknown> = {}) => ({ agentState, confirmationPending: false, busyAt: 1, subagentsActive: false, ...extra })
  assert.equal(agyStatus(s('error'), false, false, true), 'rate-limited')
  assert.equal(agyStatus(s('error'), false, false, false), 'error')
  assert.equal(agyStatus(s('idle'), false, false, true), 'rate-limited')
  assert.equal(agyStatus(s('idle'), false, false, false), 'done')
  assert.equal(agyStatus(s('tool_use', { confirmationPending: true }), false, false, true), 'waiting')
  assert.equal(agyStatus(s('idle'), true, false, true), 'waiting')
  assert.equal(agyStatus(s('idle', { subagentsActive: true }), false, false, true), 'working', 'its children still run')
})

test('turn end: an error record ending the turn gives its time; a system notice after it does not hide it', () => {
  const at = '2026-11-26T10:00:05Z'
  assert.equal(turnEnd([{ type: 'USER_INPUT', step_index: 0 }, { type: 'ERROR_MESSAGE', created_at: at, error: 'x' }]).erroredAt, Date.parse(at))
  assert.equal(turnEnd([{ type: 'USER_INPUT', step_index: 4 }, { type: 'ERROR_MESSAGE', created_at: at, error: 'x' }]).turn, 4, 'the turn too (one push per turn)')
  assert.equal(turnEnd([{ type: 'USER_INPUT', step_index: 0 }, { type: 'ERROR_MESSAGE', created_at: at }, { type: 'SYSTEM_MESSAGE', content: 'n' }]).erroredAt, Date.parse(at))
  assert.equal(turnEnd([{ type: 'USER_INPUT', step_index: 0 }, { type: 'ERROR_MESSAGE' }]).erroredAt, undefined)
  assert.equal(turnEnd([{ type: 'USER_INPUT', step_index: 0 }, { type: 'PLANNER_RESPONSE', content: 'ok', tool_calls: [] }]).erroredAt, undefined)
  assert.equal(turnEnd([{ type: 'USER_INPUT', step_index: 0 }, { type: 'ERROR_MESSAGE', created_at: at }, { type: 'GENERIC', content: 'r' }]).erroredAt, undefined, 'a result after it')
})

function home(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'nyan-agy-limit-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const tp = transcriptPathOf(A, root)
  mkdirSync(join(tp, '..'), { recursive: true })
  // ★ Each prompt written gets a new step (as in a real transcript: a new prompt is a new turn)
  let step = 0
  const numbered = (r: Record<string, unknown>) => (r['type'] === 'USER_INPUT' ? { ...r, step_index: (step += 10) } : r)
  const write = (...records: Record<string, unknown>[]) => writeFileSync(tp, records.map((r) => JSON.stringify(numbered(r)) + '\n').join(''))
  const append = (r: Record<string, unknown>) => appendFileSync(tp, JSON.stringify(numbered(r)) + '\n')
  return { root, tp, write, append }
}
const prompt = { type: 'USER_INPUT', content: '<USER_REQUEST>\nfix it\n</USER_REQUEST>' }
const answer = { type: 'PLANNER_RESPONSE', content: 'done', tool_calls: [] }
const err = (error: string) => ({ type: 'ERROR_MESSAGE', status: 'DONE', error, content: `Error: ${error}`, created_at: '2026-11-26T10:00:00Z' })

test('★ limited: the turn ended in an error whose words name a limit; nothing else is', (t) => {
  const h = home(t)
  h.write(prompt, err('You have exhausted your quota on this model.'))
  assert.equal(agyLimited(state({ agent_state: 'idle' }), h.root), true, 'idle after the error')
  assert.equal(agyLimited(state({ agent_state: 'error' }), h.root), true)
  assert.equal(agyLimited(state({ agent_state: 'working' }), h.root), false, 'working again (a retry)')
  // Other words: not a limit, even with the window at 0 in the status line
  h.write(prompt, err('The stream was interrupted. Please continue the task you were working on.'))
  assert.equal(agyLimited(state({ agent_state: 'idle' }), h.root), false)
  assert.equal(agyLimited(state({ agent_state: 'error' }), h.root), false)
  // The words anywhere but in the error that ends the turn: not a limit
  const words = 'You have exhausted your quota on this model.'
  h.write(prompt, { type: 'PLANNER_RESPONSE', content: words, tool_calls: [] })
  assert.equal(agyLimited(state({ agent_state: 'idle' }), h.root), false, 'an answer quoting them')
  h.write(prompt, answer, { type: 'SYSTEM_MESSAGE', content: words })
  assert.equal(agyLimited(state({ agent_state: 'idle' }), h.root), false, 'a system notice')
  h.write({ type: 'USER_INPUT', content: words })
  assert.equal(agyLimited(state({ agent_state: 'idle' }), h.root), false, 'the person typing them')
  // An error, then an answer in the same turn (agy went on): not a limit
  h.write(prompt, err('Usage limit reached'), answer)
  assert.equal(agyLimited(state({ agent_state: 'idle' }), h.root), false, 'answered after the error')
  // A turn that ended well, or agy in error with no error record
  h.write(prompt, answer)
  assert.equal(agyLimited(state({ agent_state: 'idle' }), h.root), false)
  assert.equal(agyLimited(state({ agent_state: 'error' }), h.root), false)
  // The words in either field alone
  h.write(prompt, { type: 'ERROR_MESSAGE', error: 'You have exhausted your quota on this model.' })
  assert.equal(agyLimited(state({ agent_state: 'idle' }), h.root), true, 'error field')
  h.write(prompt, { type: 'ERROR_MESSAGE', content: 'Error: Usage limit reached' })
  assert.equal(agyLimited(state({ agent_state: 'idle' }), h.root), true, 'content field')
  h.write(prompt, { type: 'ERROR_MESSAGE', error: 'API error', content: 'Error: You have exhausted your quota on this model.' })
  assert.equal(agyLimited(state({ agent_state: 'idle' }), h.root), true, 'a generic error with the words in content')
  // A system notice after the error is still the error's turn
  h.append({ type: 'SYSTEM_MESSAGE', content: 'note' })
  assert.equal(agyLimited(state({ agent_state: 'idle' }), h.root), true)
  // ★ A new prompt ends it
  h.append(prompt)
  assert.equal(agyLimited(state({ agent_state: 'idle' }), h.root), false)
  // No transcript at all — also right after a limited read (nothing stale is kept)
  h.write(prompt, err('Usage limit reached'))
  assert.equal(agyLimited(state({ agent_state: 'error' }), h.root), true)
  rmSync(h.tp)
  assert.equal(agyLimited(state({ agent_state: 'error' }), h.root), false)
})

test('★ the list, the notifier\'s rows, the send guard and the watcher all say rate-limited', async (t) => {
  const h = home(t)
  const dir = join(h.root, 'state')
  mkdirSync(dir)
  h.write(prompt, err('You have exhausted your quota on this model.'))
  writeFileSync(join(dir, 'pid-100.json'), JSON.stringify({ nyanPid: 100, nyanBusyAt: 7, input: input({ agent_state: 'idle' }) }))
  writeFileSync(join(dir, `session-${A}.json`), JSON.stringify({ nyanPid: 100, nyanBusyAt: 7, input: input({ agent_state: 'idle' }) }))
  const deps = { dir, home: h.root, isAgy: (p: number) => p === 100, now: Date.now(), locksOf: (p: number) => (p === 100 ? [A] : []) }
  assert.equal((await agyRows('pc-a', deps))[0]?.status, 'rate-limited')
  assert.equal(agyOwnRows('pc-a', deps)[0]?.status, 'rate-limited')
  assert.equal(agyOwnRowOf('pc-a', deps, A)?.status, 'rate-limited', 'the send guard reads the same')
  assert.match((await agyStatuses(dir, h.root)).get(A) ?? '', /:rate-limited$/, 'the watcher tells the list')
  h.append(prompt)
  assert.equal((await agyRows('pc-a', deps))[0]?.status, 'done')
})

test('★ the watcher\'s check() tells the list when only the transcript changed the status (codex review)', async (t) => {
  const h = home(t)
  const dir = join(h.root, 'state')
  mkdirSync(dir)
  h.write(prompt, answer)
  writeFileSync(join(dir, `session-${A}.json`), JSON.stringify({ nyanPid: 100, nyanBusyAt: 7, input: input({ agent_state: 'idle' }) }))
  let changes = 0
  let ticks = 0
  const w = await startAgyWatch(dir, () => changes++, () => ticks++, h.root)
  t.after(() => w.close())
  // Unchanged: the notifier's look still runs
  w.check()
  for (let i = 0; i < 200 && ticks === 0; i++) await new Promise((r) => setTimeout(r, 5))
  assert.equal(ticks, 1)
  assert.equal(changes, 0)
  // The limit's error reaches the transcript; no status file is written
  h.write(prompt, err('You have exhausted your quota on this model.'))
  w.check()
  for (let i = 0; i < 200 && changes === 0; i++) await new Promise((r) => setTimeout(r, 5))
  assert.equal(changes, 1)
  assert.equal(ticks, 2)
})
