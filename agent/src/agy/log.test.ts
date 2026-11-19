import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readLogSince, readLogSlice } from '../claude/log.ts'
import { agyEntries, resultText, toolGist } from './log.ts'

// The records agy 1.5.12 wrote for a run with a command, a write, a read and an edit (measured 2026-11-19), with
// example paths
const RECS = [
  {
    step_index: 0,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    status: 'DONE',
    created_at: '2026-11-19T12:14:28Z',
    content: "<USER_REQUEST>\nRun 'ls -la' and make note.txt\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-19T21:14:28+09:00.\n</ADDITIONAL_METADATA>",
  },
  {
    step_index: 1,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-11-19T12:14:28Z',
    thinking: 'Listing files first.\n\n',
    tool_calls: [{ name: 'run_command', args: { CommandLine: 'ls -la', WaitMsBeforeAsync: 5000, toolSummary: 'List directory contents' } }],
  },
  {
    step_index: 2,
    source: 'MODEL',
    type: 'GENERIC',
    status: 'DONE',
    created_at: '2026-11-19T12:14:33Z',
    content: 'Created At: 2026-11-19T21:14:33+09:00\nCompleted At: 2026-11-19T21:14:33+09:00\nCommand exited with code 0.\n\nCommand output:\ntotal 0\r\n',
  },
  {
    step_index: 3,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-11-19T12:14:33Z',
    tool_calls: [{ name: 'write_file', args: { Content: 'hello', Overwrite: true, Path: '/home/user/ws/note.txt' } }],
  },
  { step_index: 4, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-19T12:14:40Z', content: 'Created At: x\nCompleted At: y\nCreated file.' },
  { step_index: 5, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-19T12:14:41Z', content: 'Created At: x\nfailed', error: 'exit status 1' },
  { step_index: 9, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-19T12:14:52Z', content: 'Listed the directory and made note.txt.' },
  { step_index: 10, source: 'SYSTEM', type: 'ERROR_MESSAGE', created_at: '2026-11-19T12:15:00Z', error: 'quota exceeded' },
  { step_index: 11, source: 'MODEL', type: 'SOMETHING_NEW', content: 'not shown' },
]

test('entries: the request without wrappers, thinking, the command, results without the timing header, the reply, errors', () => {
  const out = RECS.flatMap((r) => agyEntries(r))
  assert.deepEqual(
    out.map((e) => e.kind),
    ['user', 'thinking', 'tool_use', 'tool_result', 'tool_use', 'tool_result', 'tool_result', 'assistant', 'system'],
  )
  const [user, thinking, cmd, res, write, , failed, reply, err] = out as any[]
  assert.equal(user.text, "Run 'ls -la' and make note.txt")
  assert.equal(user.at, '2026-11-19T12:14:28Z')
  assert.equal(thinking.text, 'Listing files first.')
  assert.equal(cmd.name, 'run_command')
  assert.equal(cmd.summary, 'ls -la')
  assert.equal(res.ok, true)
  assert.equal(res.summary, 'Command exited with code 0.\n\nCommand output:\ntotal 0')
  // ★ a write shows the file, never what is written into it (as Claude's Write)
  assert.equal(write.summary, '/home/user/ws/note.txt')
  assert.equal(failed.ok, false)
  assert.equal(reply.text, 'Listed the directory and made note.txt.')
  assert.equal(err.text, 'quota exceeded')
})

test('helpers: gist of known tools; timing lines only at the top are dropped', () => {
  assert.equal(toolGist('run_command', { CommandLine: 'npm test' }), 'npm test')
  assert.equal(toolGist('read_file', { Path: '/a' }), '/a')
  assert.equal(toolGist('x', null), '')
  assert.equal(toolGist('edit_file', { Path: '/a', Target: 'secret', Replacement: 'secret2' }), '/a')
  assert.doesNotMatch(toolGist('mystery', { Content: 'secret', Mode: 'x', toolSummary: 's' }), /secret|toolSummary/)
  assert.match(toolGist('mystery', { Content: 'secret', Mode: 'x' }), /mode: x/)
  // ★ MCP tools write lowercase keys (codex review)
  assert.equal(toolGist('write_file', { path: '/b', content: 'secret' }), '/b')
  assert.doesNotMatch(toolGist('mcp_x', { contents: 'secret', new_string: 's2', old_string: 's3', edits: [{ x: 'secret' }] }), /secret|s2|s3/)
  // ★ nested and long values are named, never shown (codex review)
  const multi = toolGist('mcp_write', { files: [{ path: '/a', content: 'secret' }], note: 'x'.repeat(200), mode: 'fast' })
  assert.doesNotMatch(multi, /secret|xxxxx/)
  assert.match(multi, /files: …/)
  assert.match(multi, /mode: fast/)
  assert.doesNotMatch(toolGist('mcp_db', { query: "INSERT INTO t VALUES ('secret'),\n('more')" }), /secret/)
  assert.equal(resultText('Created At: a\nCompleted At: b\nok\nCreated At: kept'), 'ok\nCreated At: kept')
})

test('the transcript reads with the byte cursors (page from the end, then follow what is appended)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-agy-log-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const f = join(dir, 'transcript_full.jsonl')
  writeFileSync(f, RECS.slice(0, 3).map((r) => JSON.stringify(r) + '\n').join(''))
  const page = await readLogSlice(f, 60, undefined, agyEntries)
  assert.deepEqual(page.entries.map((e) => e.kind), ['user', 'thinking', 'tool_use', 'tool_result'])
  // a step being written (no newline yet) is not read, and the tail stays before it
  appendFileSync(f, JSON.stringify(RECS[6]))
  const half = await readLogSince(f, page.tail, agyEntries)
  assert.equal(half.entries.length, 0)
  assert.equal(half.tail, page.tail)
  appendFileSync(f, '\n')
  const more = await readLogSince(f, page.tail, agyEntries)
  assert.deepEqual(more.entries.map((e) => e.kind), ['assistant'])
})
