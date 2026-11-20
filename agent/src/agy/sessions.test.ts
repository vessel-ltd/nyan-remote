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
  agyConversations,
  agyOthersWrote,
  agyOwnRowOf,
  agyOwnRows,
  agyShared,
  sweepAgyPidFiles,
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
  // (it holds its conversation's lock, as a running agy does)
  const deps = { dir, home: root, isAgy: () => true, now: Date.now(), locksOf: () => [A] }
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

test('★ another running agy on the same conversation is told apart (its pid file); unreadable counts as shared', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-agy-shared-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const own = (pid: number, cid: string) =>
    writeFileSync(join(dir, `pid-${pid}.json`), JSON.stringify({ nyanPid: pid, nyanBusyAt: 0, input: input(cid) }))
  own(100, A)
  own(200, A.toUpperCase())
  own(300, 'ffffffff-ffff-4fff-8fff-ffffffffffff')
  // a file whose pid does not match its name is not that agy's
  writeFileSync(join(dir, 'pid-400.json'), JSON.stringify({ nyanPid: 100, nyanBusyAt: 0, input: input(A) }))
  // `since` in the future: only the running agys count here
  const LATER = Date.now() + 60_000
  const live = (p: number) => p === 100 || p === 200 || p === 300
  // 200 holds no lock: a second agy on A
  const locks = (p: number) => (p === 100 ? [A] : p === 300 ? ['ffffffff-ffff-4fff-8fff-ffffffffffff'] : [])
  assert.equal(agyShared(dir, A, 100, live, locks, LATER), true)
  // the other agy is gone (or its pid is not an agy now)
  assert.equal(agyShared(dir, A, 100, (p) => p !== 200, locks, LATER), false)
  assert.equal(agyShared(dir, A, 100, (p) => p === 400, locks, LATER), false)
  assert.equal(agyShared(dir, 'ffffffff-ffff-4fff-8fff-ffffffffffff', 300, live, locks, LATER), false)
  // ★ 200 holds another conversation's lock: it moved there (a `/new` at an empty prompt) ⇒ not shared
  assert.equal(agyShared(dir, A, 100, live, (p) => (p === 200 ? ['ffffffff-ffff-4fff-8fff-ffffffffffff'] : locks(p)), LATER), false)
  // cannot tell ⇒ said so (undefined: acting on it is refused, what is shown is kept)
  assert.equal(agyShared(dir, A, 100, live, (p) => (p === 200 ? undefined : locks(p)), LATER), undefined)
  assert.equal(agyShared(join(dir, 'missing'), A, 100, live, locks, LATER), true)
  // ★ an agy gone (or moved on) that wrote during the card still counts by its visit mark; an older one does not
  const gone = (p: number) => p === 100
  writeFileSync(join(dir, `visit-${A}-200`), '')
  assert.equal(agyShared(dir, A, 100, gone, locks, Date.now() - 60_000), true)
  assert.equal(agyShared(dir, A, 100, gone, locks, LATER), false)
  // its own visit mark does not count
  assert.equal(agyShared(dir, A, 200, () => false, locks, Date.now() - 60_000), false)
  // ★ rows from each agy's own file, only for the lock holder; a conversation two agys hold is left out
  const deps = { dir, home: '/home/user', isAgy: live, now: Date.now() }
  const rows = agyOwnRows('pc-a', { ...deps, locksOf: (p) => (p === 100 ? [A] : p === 300 ? ['ffffffff-ffff-4fff-8fff-ffffffffffff'] : []) })
  assert.deepEqual(rows.map((r) => r.sessionId).sort(), [`agy-${A}`, 'agy-ffffffff-ffff-4fff-8fff-ffffffffffff'])
  assert.equal(agyOwnRows('pc-a', { ...deps, locksOf: () => [A] }).length, 0, 'two holders of one conversation')
})

test('★ the sweep keeps visit marks of a conversation a running agy shows, however old (they guard its card)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-agy-sweep-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const B = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  writeFileSync(join(dir, 'pid-100.json'), JSON.stringify({ nyanPid: 100, nyanBusyAt: 0, input: input(A) }))
  const old = (Date.now() - 3 * AGY_FILE_MAX_AGE_MS) / 1000
  for (const f of [`visit-${A}-200`, `visit-${B}-200`, 'pid-200.json']) {
    writeFileSync(join(dir, f), f.endsWith('.json') ? JSON.stringify({ nyanPid: 200, nyanBusyAt: 0, input: input(B) }) : '')
    utimesSync(join(dir, f), old, old)
  }
  await sweepAgyPidFiles({ dir, home: '/home/user', isAgy: (p) => p === 100, now: Date.now() })
  assert.equal(existsSync(join(dir, `visit-${A}-200`)), true, 'A is shown by a running agy')
  assert.equal(existsSync(join(dir, `visit-${B}-200`)), false)
  assert.equal(existsSync(join(dir, 'pid-200.json')), false, 'a gone agy’s own file')
  assert.equal(existsSync(join(dir, 'pid-100.json')), true)
})

test('★ the list shows the agy’s own state: a second agy overwriting the conversation file does not change the row', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'nyan-agy-own-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'state')
  mkdirSync(dir)
  const tp = transcriptPathOf(A, root)
  mkdirSync(join(tp, '..'), { recursive: true })
  writeFileSync(tp, JSON.stringify({ type: 'USER_INPUT', content: '<USER_REQUEST>\nhi\n</USER_REQUEST>' }) + '\n')
  const own = (pid: number, over: Record<string, unknown>) =>
    writeFileSync(join(dir, `pid-${pid}.json`), JSON.stringify({ nyanPid: pid, nyanBusyAt: 7, input: input(A, over) }))
  // agy 100 waits on a card; agy 200 opened the same conversation and its idle state is the conversation file's now
  own(100, { agent_state: 'tool_use', tool_confirmation_pending: true })
  own(200, { agent_state: 'idle' })
  writeFileSync(join(dir, `session-${A}.json`), JSON.stringify({ nyanPid: 200, nyanBusyAt: 7, input: input(A, { agent_state: 'idle' }) }))
  const deps = { dir, home: root, isAgy: (p: number) => p === 100 || p === 200, now: Date.now(), locksOf: (p: number) => (p === 100 ? [A] : []) }
  assert.equal((await agyRows('pc-a', deps))[0]?.status, 'waiting')
  // only one agy says anything about it: its own file
  const one = { ...deps, isAgy: (p: number) => p === 100 }
  writeFileSync(join(dir, `session-${A}.json`), JSON.stringify({ nyanPid: 100, nyanBusyAt: 7, input: input(A, { agent_state: 'idle' }) }))
  assert.equal((await agyRows('pc-a', one))[0]?.status, 'waiting')
})

test('★★ two running agys on one conversation: listed once (the lock holder’s state), nothing from the phone; one that left does not hide it', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'nyan-agy-contested-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'state')
  mkdirSync(dir)
  const tp = transcriptPathOf(A, root)
  mkdirSync(join(tp, '..'), { recursive: true })
  writeFileSync(tp, JSON.stringify({ type: 'USER_INPUT', content: '<USER_REQUEST>\nhi\n</USER_REQUEST>' }) + '\n')
  const own = (pid: number, over: Record<string, unknown>) =>
    writeFileSync(join(dir, `pid-${pid}.json`), JSON.stringify({ nyanPid: pid, nyanBusyAt: 7, input: input(A, over) }))
  own(100, { agent_state: 'tool_use', tool_confirmation_pending: true })
  own(200, { agent_state: 'working' })
  // the conversation file was written last by 200
  writeFileSync(join(dir, `session-${A}.json`), JSON.stringify({ nyanPid: 200, nyanBusyAt: 7, input: input(A, { agent_state: 'working' }) }))
  const both = { dir, home: root, isAgy: (p: number) => p === 100 || p === 200, now: Date.now(), locksOf: (p: number) => (p === 100 ? [A] : []) }
  const c = (await agyConversations(both)).get(A)!
  assert.equal(c.contested, true)
  assert.equal(c.file.state.pid, 100, 'the lock holder')
  const rows = await agyRows('pc-a', both)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.status, 'waiting')
  assert.equal(rows[0]!.sendRoute, undefined, 'nothing from the phone while two agys show it')
  assert.equal(rows[0]!.agyShared, true, 'and the phone is told why (not "restart agy")')
  // the second agy exits: the conversation file names a gone pid, but 100's own file still shows it
  const after = { ...both, isAgy: (p: number) => p === 100 }
  const left = (await agyConversations(after)).get(A)!
  assert.equal(left.contested, false)
  assert.equal(left.file.state.pid, 100)
  assert.equal((await agyRows('pc-a', after))[0]?.status, 'waiting')
  // a second agy that moved on (holds another conversation's lock) does not contest it
  const moved = { ...both, locksOf: (p: number) => (p === 100 ? [A] : ['ffffffff-ffff-4fff-8fff-ffffffffffff']) }
  assert.equal((await agyConversations(moved)).get(A)!.contested, false)
})

test('★★ an agy is judged by its own file only (a stale conversation file of it is ignored); an older relay’s agy still counts', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'nyan-agy-claims-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'state')
  mkdirSync(dir)
  const B = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  const write = (name: string, pid: number, conv: string, over: Record<string, unknown> = {}) =>
    writeFileSync(join(dir, name), JSON.stringify({ nyanPid: pid, nyanBusyAt: 7, input: input(conv, over) }))
  // agy 100 moved from A to B (its own file says B); its old A file is still there; agy 200 overwrote B's file
  write(`pid-100.json`, 100, B, { agent_state: 'tool_use', tool_confirmation_pending: true })
  write(`session-${A}.json`, 100, A, { agent_state: 'idle' })
  write(`session-${B}.json`, 200, B, { agent_state: 'idle' })
  const deps = { dir, home: root, isAgy: (p: number) => p === 100, now: Date.now(), locksOf: (p: number) => (p === 100 ? [B] : []) }
  const all = await agyConversations(deps)
  assert.equal(all.has(A), false, 'not shown by 100 any more')
  assert.equal(all.get(B)!.file.state.pid, 100)
  // an older relay's agy 300 (no own file) holds C; a current one, 400, opened C too ⇒ contested, the holder's state
  const C = '11111111-1111-4111-8111-111111111111'
  write(`session-${C}.json`, 300, C, { agent_state: 'working' })
  write(`pid-400.json`, 400, C, { agent_state: 'working' })
  const mixed = { ...deps, isAgy: (p: number) => p === 100 || p === 300 || p === 400, locksOf: (p: number) => (p === 100 ? [B] : p === 300 ? [C] : []) }
  const c = (await agyConversations(mixed)).get(C)!
  assert.equal(c.contested, true)
  assert.equal(c.file.state.pid, 300)
})

test('★ the cards’ sharing check counts an older relay’s agy too (its conversation file names it)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-agy-legacy-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'pid-100.json'), JSON.stringify({ nyanPid: 100, nyanBusyAt: 0, input: input(A) }))
  writeFileSync(join(dir, `session-${A}.json`), JSON.stringify({ nyanPid: 300, nyanBusyAt: 0, input: input(A) }))
  const live = (p: number) => p === 100 || p === 300
  const locks = (p: number) => (p === 100 ? [A] : [])
  assert.equal(agyShared(dir, A, 100, live, locks, Date.now() + 60_000), true)
  assert.equal(agyShared(dir, A, 100, (p) => p === 100, locks, Date.now() + 60_000), false, 'that agy is gone')
  // the conversation file naming this agy itself
  writeFileSync(join(dir, `session-${A}.json`), JSON.stringify({ nyanPid: 100, nyanBusyAt: 0, input: input(A) }))
  assert.equal(agyShared(dir, A, 100, live, locks, Date.now() + 60_000), false)
})

test('★ a row offers send and stop only when its agy holds the conversation’s lock', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'nyan-agy-holder-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const prev = process.env.NYAN_REMOTE_STATE_DIR
  process.env.NYAN_REMOTE_STATE_DIR = root
  t.after(() => {
    if (prev === undefined) delete process.env.NYAN_REMOTE_STATE_DIR
    else process.env.NYAN_REMOTE_STATE_DIR = prev
  })
  const dir = join(root, 'agy')
  mkdirSync(dir)
  mkdirSync(join(root, 'panes'))
  writeFileSync(join(root, 'panes', '100.json'), JSON.stringify({ pid: 100, procStart: 'S', socket: join(root, 'k.sock'), startedAt: 0, paste: true }))
  const tp = transcriptPathOf(A, root)
  mkdirSync(join(tp, '..'), { recursive: true })
  writeFileSync(tp, JSON.stringify({ type: 'USER_INPUT', content: '<USER_REQUEST>\nhi\n</USER_REQUEST>' }) + '\n')
  writeFileSync(join(dir, 'pid-100.json'), JSON.stringify({ nyanPid: 100, nyanBusyAt: 7, input: input(A, { agent_state: 'idle' }) }))
  const deps = { dir, home: root, isAgy: (p: number) => p === 100, now: Date.now(), aliveProcStart: (p: number) => (p === 100 ? 'S' : null) }
  assert.equal((await agyRows('pc-a', { ...deps, locksOf: () => [A] }))[0]?.sendRoute, 'keys')
  assert.equal((await agyRows('pc-a', { ...deps, locksOf: () => [] }))[0]?.sendRoute, undefined)
  assert.equal((await agyRows('pc-a', { ...deps, locksOf: () => undefined }))[0]?.sendRoute, undefined)
})

test('★ a "card is up" state is hidden only when its agy is shown not to hold the conversation’s lock (it moved on)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'nyan-agy-movedcard-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'state')
  mkdirSync(dir)
  writeFileSync(join(dir, 'pid-100.json'), JSON.stringify({ nyanPid: 100, nyanBusyAt: 7, input: input(A, { agent_state: 'tool_use', tool_confirmation_pending: true }) }))
  const deps = { dir, home: root, isAgy: (p: number) => p === 100, now: Date.now() }
  assert.equal((await agyConversations({ ...deps, locksOf: () => [A] })).has(A), true)
  assert.equal((await agyConversations({ ...deps, locksOf: () => ['ffffffff-ffff-4fff-8fff-ffffffffffff'] })).has(A), false)
  // ★ cannot tell (a slow probe): still listed (hiding it made the phone close a live "needs you")
  assert.equal((await agyConversations({ ...deps, locksOf: () => undefined })).has(A), true)
})

test('the guard’s single read: only the agy holding that conversation’s lock; two holders or none ⇒ nothing', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-agy-ownrowof-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'pid-100.json'), JSON.stringify({ nyanPid: 100, nyanBusyAt: 7, input: input(A, { agent_state: 'tool_use', tool_confirmation_pending: true }) }))
  writeFileSync(join(dir, 'pid-200.json'), JSON.stringify({ nyanPid: 200, nyanBusyAt: 7, input: input(A, { agent_state: 'idle' }) }))
  const deps = { dir, home: '/home/user', isAgy: (p: number) => p === 100 || p === 200, now: Date.now() }
  assert.equal(agyOwnRowOf('pc-a', { ...deps, locksOf: (p: number) => (p === 100 ? [A] : []) }, A)?.status, 'waiting')
  assert.equal(agyOwnRowOf('pc-a', { ...deps, locksOf: () => [A] }, A), undefined)
  assert.equal(agyOwnRowOf('pc-a', { ...deps, locksOf: () => [] }, A), undefined)
})

test('★ "done": only another agy’s writes during the turn count — one merely open and idle on it does not', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-agy-otherswrote-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'pid-100.json'), JSON.stringify({ nyanPid: 100, nyanBusyAt: 0, input: input(A) }))
  writeFileSync(join(dir, 'pid-200.json'), JSON.stringify({ nyanPid: 200, nyanBusyAt: 0, input: input(A) }))
  const visit = join(dir, `visit-${A}-200`)
  writeFileSync(visit, '')
  const turnAt = Date.now() - 10_000
  utimesSync(visit, (turnAt - 60_000) / 1000, (turnAt - 60_000) / 1000)
  const live = (p: number) => p === 100 || p === 200
  const locks = (p: number) => (p === 100 ? [A] : [])
  assert.equal(agyOthersWrote(dir, A, turnAt, live, locks), false, 'parked before the turn')
  utimesSync(visit, (turnAt + 2000) / 1000, (turnAt + 2000) / 1000)
  assert.equal(agyOthersWrote(dir, A, turnAt, live, locks), true, 'wrote during the turn')
  assert.equal(agyOthersWrote(dir, A, turnAt, live, (p) => (p === 200 ? undefined : locks(p))), undefined, 'cannot tell')
})
