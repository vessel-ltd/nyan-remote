import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  agyRow,
  agyRows,
  agyStatus,
  agyUsage,
  bucketMinutes,
  conversationOf,
  liveAgy,
  parseAgyFile,
  promptTitle,
  readAgyFiles,
  transcriptPathOf,
  AGY_FILE_MAX_AGE_MS,
} from './sessions.ts'

const A = '062a8f25-9451-42f3-ae93-34a208e99365'
const B = '6c0298e8-77c4-406c-aa97-cbecdfd19c88'

// The shape agy 1.5.12 hands its status line (measured 2026-11-19), with example values
function input(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cwd: '/home/user/work/proj',
    session_id: id,
    conversation_id: id,
    transcript_path: '/home/user/.gemini/antigravity/brain/x/transcript.jsonl',
    model: { id: 'Gemini 4 Neon (High)', display_name: 'Gemini 4 Neon (High)', effort: 'high' },
    version: '1.5.12',
    context_window: { total_input_tokens: 13013, used_percentage: 1.24, context_window_size: 1048576 },
    quota: {
      '3p-5h': { remaining_fraction: 1, reset_time: '2026-11-19T17:17:36Z', reset_in_seconds: 18000 },
      '3p-weekly': { remaining_fraction: 0.5, reset_time: '2026-11-26T12:17:36Z', reset_in_seconds: 604800 },
      'gemini-5h': { remaining_fraction: 0.9943947, reset_time: '2026-11-19T17:14:14Z', reset_in_seconds: 17798 },
      'gemini-weekly': { remaining_fraction: 0.8, reset_time: '2026-11-26T04:49:30Z', reset_in_seconds: 577914 },
      'gemini-argon-wtu-weekly': { remaining_fraction: 1, reset_time: '2026-11-26T12:17:36Z', reset_in_seconds: 604800 },
    },
    agent_state: 'idle',
    cycle_mode: 'auto',
    plan_tier: 'Google AI Pro',
    ...over,
  }
}

test('ids: agy rows never meet Claude or Codex ids; only a well-formed uuid is read', () => {
  assert.equal(conversationOf(`agy-${A}`), A)
  assert.equal(conversationOf(A), undefined)
  assert.equal(conversationOf('agy-../../etc'), undefined)
  assert.equal(conversationOf(`codex-x-${A}`), undefined)
  assert.equal(transcriptPathOf(A, '/home/user'), `/home/user/.gemini/antigravity-cli/brain/${A}/.system_generated/logs/transcript_full.jsonl`)
})

test('parse: what the list uses, and nothing from a file that is not ours', () => {
  const s = parseAgyFile({ nyanPid: 4242, nyanBusyAt: 0, input: input(A, { tool_confirmation_pending: true, agent_state: 'tool_use' }) }, A)!
  assert.equal(s.conversationId, A)
  assert.equal(s.pid, 4242)
  assert.equal(s.cwd, '/home/user/work/proj')
  assert.equal(s.model, 'Gemini 4 Neon (High)')
  assert.equal(s.effort, 'high')
  assert.equal(s.contextPercent, 1)
  assert.equal(s.confirmationPending, true)
  assert.equal(s.mode, 'auto')
  assert.equal(s.quota.length, 5)
  // the id inside must be the file's own; pid must be a real one; the input must be an object
  assert.equal(parseAgyFile({ nyanPid: 4242, input: input(A) }, B), undefined)
  assert.equal(parseAgyFile({ nyanPid: 1, input: input(A) }, A), undefined)
  assert.equal(parseAgyFile({ nyanPid: '4242', input: input(A) }, A), undefined)
  assert.equal(parseAgyFile({ nyanPid: 4242, input: 'x' }, A), undefined)
  assert.equal(parseAgyFile({ nyanPid: 4242, input: input(A, { cwd: '', workspace: {} }) }, A), undefined)
})

test('status: a card is waiting; working kinds are working; idle after a turn is done, before any is idle', () => {
  assert.equal(agyStatus({ agentState: 'tool_use', confirmationPending: true, busyAt: 1 }), 'waiting')
  for (const st of ['working', 'tool_use', 'reviewing']) assert.equal(agyStatus({ agentState: st, confirmationPending: false, busyAt: 1 }), 'working')
  assert.equal(agyStatus({ agentState: 'error', confirmationPending: false, busyAt: 0 }), 'error')
  assert.equal(agyStatus({ agentState: 'idle', confirmationPending: false, busyAt: 1_800_000_000 }), 'done')
  assert.equal(agyStatus({ agentState: 'idle', confirmationPending: false, busyAt: 0 }), 'idle')
  assert.equal(agyStatus({ agentState: 'initializing', confirmationPending: false, busyAt: 0 }), 'idle')
  assert.equal(agyStatus({ confirmationPending: false, busyAt: 0 }), 'idle')
})

test('row: tool agy, its own id and account, the mode as the permission chip, waitingFor while a card is up', () => {
  const s = parseAgyFile({ nyanPid: 4242, nyanBusyAt: 5, input: input(A, { tool_confirmation_pending: true, agent_state: 'tool_use', cycle_mode: 'accept-edits' }) }, A)!
  const row = agyRow(s, { machine: 'pc-a', transcriptBytes: 10, lastActivity: '2026-11-19T12:00:00.000Z', promptTitle: 'Fix the test' })
  assert.equal(row.tool, 'agy')
  assert.equal(row.sessionId, `agy-${A}`)
  assert.equal(row.account, 'agy')
  assert.equal(row.project, 'proj')
  assert.equal(row.title, 'Fix the test')
  assert.equal(row.titleSource, 'prompt')
  assert.equal(row.status, 'waiting')
  assert.equal(row.waitingFor, 'permission prompt')
  assert.equal(row.permissionMode, 'accept-edits')
  assert.equal(row.live, true)
  // ⚠️ never the e-mail, the plan or the status line's wrong transcript path
  assert.doesNotMatch(JSON.stringify(row), /example\.com|Google AI Pro|transcript\.jsonl/)
  const titled = agyRow({ ...s, title: 'Named' }, { machine: 'pc-a', transcriptBytes: 0, lastActivity: 'x' })
  assert.equal(titled.titleSource, 'ai')
  assert.equal(agyRow(s, { machine: 'pc-a', transcriptBytes: 0, lastActivity: 'x' }).titleSource, 'fallback')
})

test('title: the first request without agy’s wrappers; a cut head gives none', () => {
  const head =
    JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>\nFix the failing test\nplease\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: x\n</ADDITIONAL_METADATA>' }) + '\n'
  assert.equal(promptTitle(head), 'Fix the failing test')
  assert.equal(promptTitle('{"type":"USER_INPUT","content":"<USER_REQ'), undefined)
})

test('live: only a running agy, only the newest conversation of each pid; gone ones are removed after a day', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-agy-live-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const C = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const write = (id: string, pid: number, ageMs: number): void => {
    const p = join(dir, `session-${id}.json`)
    writeFileSync(p, JSON.stringify({ nyanPid: pid, nyanBusyAt: 0, input: input(id) }))
    const at = (Date.now() - ageMs) / 1000
    utimesSync(p, at, at)
  }
  write(A, 100, 1000) // newest of pid 100
  write(B, 100, 60_000) // an older conversation of the same agy
  write(C, 200, AGY_FILE_MAX_AGE_MS + 60_000) // agy gone a day ago
  writeFileSync(join(dir, 'session-not-ours.json'), '{}')
  writeFileSync(join(dir, `session-${'ffffffff-ffff-4fff-8fff-ffffffffffff'}.json`), '{broken')
  const live = await liveAgy({ dir, home: '/home/user', isAgy: (pid) => pid === 100, now: Date.now() })
  assert.deepEqual(live.map((f) => f.state.conversationId), [A])
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(existsSync(join(dir, `session-${C}.json`)), false, 'the gone agy’s file is removed')
  assert.equal(existsSync(join(dir, `session-${B}.json`)), true, 'a file of a running agy is kept')
  assert.equal((await readAgyFiles(join(dir, 'missing'))).length, 0)
})

test('rows: built from the live files with the transcript’s size and first request', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'nyan-agy-rows-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'state')
  mkdirSync(dir)
  writeFileSync(join(dir, `session-${A}.json`), JSON.stringify({ nyanPid: 100, nyanBusyAt: 7, input: input(A) }))
  const tp = transcriptPathOf(A, root)
  mkdirSync(join(tp, '..'), { recursive: true })
  const line = JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>\nList the files\n</USER_REQUEST>' }) + '\n'
  writeFileSync(tp, line)
  const rows = await agyRows('pc-a', { dir, home: root, isAgy: () => true, now: Date.now() })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.title, 'List the files')
  assert.equal(rows[0]!.transcriptBytes, Buffer.byteLength(line))
  assert.equal(rows[0]!.status, 'done')
})

test('rows: an agy with no transcript yet is not listed (like Claude) unless a turn runs or a card waits', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'nyan-agy-rows-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'state')
  mkdirSync(dir)
  const deps = { dir, home: root, isAgy: () => true, now: Date.now() }
  const put = (over: Record<string, unknown>): void =>
    writeFileSync(join(dir, `session-${A}.json`), JSON.stringify({ nyanPid: 100, nyanBusyAt: 0, input: { ...input(A), ...over } }))
  for (const s of ['idle', 'initializing', 'error']) {
    put({ agent_state: s })
    assert.deepEqual(await agyRows('pc-a', deps), [], s)
  }
  put({ agent_state: 'working' })
  assert.equal((await agyRows('pc-a', deps))[0]?.status, 'working')
  put({ agent_state: 'tool_use', tool_confirmation_pending: true })
  assert.equal((await agyRows('pc-a', deps))[0]?.status, 'waiting')
  // an empty transcript is still "none yet"
  const tp = transcriptPathOf(A, root)
  mkdirSync(join(tp, '..'), { recursive: true })
  writeFileSync(tp, '')
  put({ agent_state: 'idle' })
  assert.deepEqual(await agyRows('pc-a', deps), [])
  writeFileSync(tp, JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>\nhi\n</USER_REQUEST>' }) + '\n')
  assert.equal((await agyRows('pc-a', deps)).length, 1)
})

test('usage: the Gemini windows only (other buckets share their lengths and could not be told apart)', () => {
  assert.equal(bucketMinutes('gemini-weekly'), 10080)
  assert.equal(bucketMinutes('3p-5h'), 300)
  assert.equal(bucketMinutes('gemini-argon-wtu-weekly'), 10080)
  assert.equal(bucketMinutes('mystery'), undefined)
  const s = parseAgyFile({ nyanPid: 4242, input: input(A) }, A)!
  const now = Date.parse('2026-11-19T12:00:00Z')
  const u = agyUsage([{ state: s, mtimeMs: now - 60_000 }], now)!
  assert.equal(u.tool, 'agy')
  assert.equal(u.plan, 'Google AI Pro')
  const byLen = new Map(u.windows.map((w) => [w.minutes, w]))
  assert.equal(Math.round(byLen.get(10080)!.usedPercent), 20, 'gemini-weekly, not 3p-weekly (more used)')
  assert.equal(Math.round(byLen.get(300)!.usedPercent), 1)
  assert.equal(u.windows.length, 2)
  // a window whose reset passed is dropped
  assert.equal(agyUsage([{ state: s, mtimeMs: now }], Date.parse('2026-11-30T00:00:00Z')), undefined)
  assert.equal(agyUsage([], now), undefined)
})
