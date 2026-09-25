import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  agentTypeOf,
  subagentOf,
  buildPermissionInfo,
  clipField,
  FIELD_MAX,
  permissionPayload,
  permissions,
} from './permission.ts'
import {
  holdQuiet,
  listPending,
  resetPending,
  waitForDecision,
} from '../permission.ts'
import { permissionTag, type PermissionRequest } from '../../../shared/types.ts'

const req = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  key: 'k1',
  machine: 'pc-a',
  account: '.claude-r',
  project: 'tmux-agent',
  toolName: 'Bash',
  summary: 'touch x',
  at: '2026-08-20T09:00:00.000Z',
  ...over,
})

// ★ Deriving the subagent decision (2026-08-14 review: there was not a single test here,
//   and rewriting it to always return `undefined` kept everything green)

test('★★ agentTypeOf: an agent_id means it came from a subagent', () => {
  assert.equal(agentTypeOf({ agent_id: 'agt_1', agent_type: 'Explore' }), 'Explore')
  // Even without a type, it is known to be a subagent
  assert.equal(agentTypeOf({ agent_id: 'agt_1' }), 'サブエージェント')
})

test('★★ subagentOf: same decision as agentTypeOf (structured field / 2026-09-24)', () => {
  assert.deepEqual(subagentOf({ agent_id: 'agt_1', agent_type: 'Explore' }), { type: 'Explore' })
  assert.deepEqual(subagentOf({ agent_id: 'agt_1' }), {}, 'without a type, the UI supplies the name')
  assert.equal(subagentOf({ agent_type: 'main' }), undefined)
  assert.equal(subagentOf({ agent_id: '' }), undefined)
})

test('★★ buildPermissionInfo: sends the structured fields alongside the old (legacy) fields', () => {
  const info = buildPermissionInfo({
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    agent_id: 'agt_1',
    permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits' }],
  })
  // For new UIs
  assert.deepEqual(info.suggestionItems, [{ kind: 'setMode', mode: 'acceptEdits' }])
  assert.deepEqual(info.subagent, {})
  assert.equal(info.accountUnknown, true)
  // ⚠️ For old UIs (without these, the suggestion rows and the subagent badge silently disappear)
  assert.deepEqual(info.suggestions, ['このセッションのモードを acceptEdits にする'])
  assert.equal(info.agentType, 'サブエージェント')
  assert.equal(info.account, '(不明)')
})

test('buildPermissionInfo: no structured markers when it is the main agent and the account is known', () => {
  const info = buildPermissionInfo({
    tool_name: 'Bash',
    transcript_path: '/home/u/.claude-r/projects/-home-u-p/0a1b2c3d-0000-4000-8000-000000000000.jsonl',
  })
  assert.equal(info.subagent, undefined)
  assert.equal(info.agentType, undefined)
  assert.deepEqual(info.suggestionItems, [])
  assert.equal(info.account, '.claude-r')
  assert.equal(info.accountUnknown, undefined)
})

test('★★ agentTypeOf: a request from the main agent is undefined (the side that notifies immediately)', () => {
  assert.equal(agentTypeOf({ agent_type: 'main' }), undefined, 'no agent_id means the main agent')
  assert.equal(agentTypeOf({}), undefined)
  assert.equal(agentTypeOf({ agent_id: '' }), undefined, 'an empty string is the same as absent')
})

// ── ★ Look at the very card passed to the UI (2026-08-18) ─────────────────────────
//
// ⚠️ A test that only calls `summarize` / `detailOf` on its own **stays green even if the builder forgets to pass them**.
//    Check the value that actually goes to the UI (the return of `buildPermissionInfo`) (VERIFY.md "false green").

const LONG = ["python3 - <<'PY'", 'import pathlib', `s = '${'a'.repeat(500)}'`, 'PY'].join('\n')

test('★★ buildPermissionInfo: a long command gets the full text (can be opened on the card)', () => {
  const info = buildPermissionInfo({
    tool_name: 'Bash',
    tool_input: { command: LONG },
    cwd: '/home/x/proj',
  })
  assert.equal(info.toolName, 'Bash')
  assert.ok(!info.summary.includes('\n'), 'the collapsed line is one line')
  assert.equal(info.detail, LONG, 'the full text is passed with its newlines')
  assert.equal(info.detailClipped, false)
})

test('buildPermissionInfo: no full text for things that fit in one line', () => {
  const info = buildPermissionInfo({ tool_name: 'Read', tool_input: { file_path: '/a/b.ts' } })
  assert.equal(info.summary, '/a/b.ts')
  assert.equal(info.detail, undefined)
  assert.equal(info.detailClipped, undefined)
})

// ── ★★ Nothing derived from the conversation goes into notifications (§6.2) ─────────────────────────────
//
// ⚠️ codex review 2026-08-18, low #5: "changing the notification body to `info.detail` stays green".
//    This looks at **the payload the implementation builds** (looking at a hand-built payload is meaningless).

test('★★ permissionPayload: no summary / detail / command contents in the notification', () => {
  const command = "python3 - <<'PY'\nSECRET_IN_COMMAND = 1\nPY"
  const info = buildPermissionInfo({
    tool_name: 'Bash',
    tool_input: { command },
    cwd: '/home/x/proj',
    session_id: 'S1',
  })
  // Precondition: this approval has "full text" (since the test checks it is not included)
  assert.ok(info.detail?.includes('SECRET_IN_COMMAND'))

  const payload = permissionPayload(info)
  const flat = JSON.stringify(payload)
  assert.ok(!flat.includes('SECRET_IN_COMMAND'), 'the command contents do not appear in the notification')
  assert.ok(!flat.includes('python3'), 'the summary does not appear either')
  // Only identifiers and state may appear. ⚠️ The tool name is "fixed vocabulary", so it appears
  // ⚠️ This call has no transcript_path, so account is `(不明)` (unknown; never filled in by guessing)
  assert.equal(payload.body, `承認待ち（Bash）· ${info.machine} · (不明)\nproj`)
  assert.equal(payload.event, 'PermissionRequest')
  // ★★ No title was passed, so it falls back to the 8-char ID (never show a false title / fail-closed)
  assert.equal(payload.title, 'S1')
  // ★ When the title falls back to the ID, the project name is added as the 3rd line
  assert.ok(payload.body.includes('\nproj'), `no 3rd line: ${payload.body}`)
  // ★★ Approvals are **never collapsed or silenced** (they are waiting for an answer, so they always ring)
  assert.equal(payload.silent, undefined)

  // ⚠️⚠️ Even on the path that passes a title, no conversation-derived strings are mixed in (only `ai` titles are the exception)
  const withTitle = permissionPayload(info, {
    title: 'GYG_API Test workflow faillure',
    titleSource: 'ai',
    sessionId: 'S1',
    project: 'proj',
    machine: info.machine,
    account: '.claude',
    label: '承認待ち',
    contextTokens: 87_000,
  })
  assert.equal(withTitle.title, 'GYG_API Test workflow faillure')
  assert.equal(withTitle.body, `承認待ち（Bash）· ${info.machine} · claude · ctx 87k`)
  // ★ No space right after the full-width closing parenthesis (the gap would be too wide)
  assert.ok(!withTitle.body.includes('） ·'), `space after the full-width parenthesis: ${withTitle.body}`)
  // ★ There is a meaningful title, so the project name is not added (redundant)
  assert.ok(!withTitle.body.includes('proj'), `the project name appeared unnecessarily: ${withTitle.body}`)
  assert.ok(!JSON.stringify(withTitle).includes('SECRET_IN_COMMAND'))
})

test('★★ /permissions pendingTags is a superset (includes the quietly waiting ones)', async () => {
  // ⚠️⚠️ `/code-review` 2026-08-20, low #5. The PWA's notification cleanup was built from `permissions`
  //    (= `listPending()`), so **for 6 seconds after a surfaced approval went back to the quiet state,
  //    it closed notifications for live approvals**. The list passed to cleanup must always be a superset.
  resetPending()
  void waitForDecision(req({ key: 'k1' }), () => {})
  void waitForDecision(req({ key: 'k2' }), () => {})
  holdQuiet('k2', 60_000)
  assert.equal(listPending().length, 1, 'only 1 is surfaced (checking the precondition)')

  const res = await permissions()
  assert.equal(res.permissions.length, 1)
  assert.equal(res.quiet, 1)
  // ★ Look at the value the implementation builds (do not pass hand-built tags)
  assert.deepEqual([...res.pendingTags].sort(), [
    permissionTag('pc-a', 'k1'),
    permissionTag('pc-a', 'k2'),
  ])
  resetPending()
})

test('★★ permissionPayload: even a long tool name stays under the push limit (so the notification still shows)', () => {
  // ⚠️⚠️ codex 2026-08-20, medium #6. `tool_name` has no length limit at the entry, so
  //    a long one makes **the push exceed 4KB and fail to send = the approval notification itself never shows**.
  //    ⇒ Bound the display strings before removing the list.
  const payload = permissionPayload(
    req({ toolName: 'X'.repeat(5000), project: 'P'.repeat(5000), account: 'A'.repeat(5000) }),
  )
  // ★ Measure the value the implementation builds
  assert.ok(
    Buffer.byteLength(JSON.stringify(payload), 'utf8') < 3000,
    `payload too large: ${Buffer.byteLength(JSON.stringify(payload), 'utf8')}B`,
  )
  assert.ok(payload.body.includes('…'), 'the truncation mark (…) is present')
  assert.equal(clipField('a'.repeat(FIELD_MAX)), 'a'.repeat(FIELD_MAX), 'not cut up to the limit')
  assert.equal(clipField('a'.repeat(FIELD_MAX + 1)).length, FIELD_MAX)
})

test('★★ /permissions returns "the time the list was taken" (used for ordering in the app-side cleanup)', async () => {
  // ⚠️ It must not be compared with the device clock, so **the agent's clock** is passed (codex high #2)
  resetPending()
  const before = Date.now()
  const res = await permissions()
  const at = Date.parse(res.at)
  assert.ok(!Number.isNaN(at), 'at is an ISO string')
  assert.ok(at >= before - 1000 && at <= Date.now() + 1000, 'it is the current time')
})
