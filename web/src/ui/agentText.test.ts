import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setLang } from '../../../shared/i18n.ts'
import type { PermissionRequest } from '../../../shared/types.ts'
import { buildPermissionInfo } from '../../../agent/src/routes/permission.ts'
import { synthesizeRows } from './order.ts'
import { accountLabel, agentTypeLabel, suggestionText, suggestionTexts } from './agentText.ts'

// ★ Verify with values the implementation actually produces (hand-built values alone give a false green when the agent's shape changes)
const SUGGESTIONS = [
  { type: 'addDirectories', directories: ['/home/u/proj'] },
  { type: 'setMode', mode: 'acceptEdits' },
  { type: 'addRules' },
]
const made = buildPermissionInfo({
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
  agent_id: 'a1',
  permission_suggestions: SUGGESTIONS,
})

/** ⚠️ The shape old agents sent (no structured fields). The text equals the new agent's legacy fields */
function oldPayload(p: PermissionRequest): PermissionRequest {
  const { suggestionItems: _s, subagent: _a, accountUnknown: _u, ...rest } = p
  return rest
}

function inLang<T>(lang: 'ja' | 'en', f: () => T): T {
  setLang(lang)
  try {
    return f()
  } finally {
    setLang('ja')
  }
}

test('★★ new agent: renders text in the UI language from the structured fields', () => {
  assert.ok(made.suggestionItems && made.subagent && made.accountUnknown, 'the new fields are present')
  assert.deepEqual(
    inLang('en', () => suggestionTexts(made)),
    ['Allow this directory: proj', "Set this session's mode to acceptEdits", 'addRules'],
  )
  assert.equal(inLang('en', () => agentTypeLabel(made)), 'Subagent')
  assert.equal(inLang('en', () => accountLabel(made)), '(unknown)')
  // On a Japanese UI it looks the same as the old text
  assert.deepEqual(inLang('ja', () => suggestionTexts(made)), made.suggestions)
  assert.equal(inLang('ja', () => agentTypeLabel(made)), 'サブエージェント')
  assert.equal(inLang('ja', () => accountLabel(made)), '(不明)')
})

test('★★ old agent (legacy): matches the Japanese sentence and translates it', () => {
  const old = oldPayload(made)
  assert.deepEqual(
    inLang('en', () => suggestionTexts(old)),
    ['Allow this directory: proj', "Set this session's mode to acceptEdits", 'addRules'],
  )
  assert.equal(inLang('en', () => agentTypeLabel(old)), 'Subagent')
  assert.equal(inLang('en', () => accountLabel(old)), '(unknown)')
  assert.deepEqual(inLang('ja', () => suggestionTexts(old)), made.suggestions)
  // Non-matching text, kind names and the user's account names pass through unchanged
  assert.equal(inLang('en', () => agentTypeLabel({ agentType: 'code-review' })), 'code-review')
  assert.equal(inLang('en', () => accountLabel({ account: '.claude-r' })), '.claude-r')
  assert.deepEqual(inLang('en', () => suggestionTexts({ suggestions: ['whatever'] })), ['whatever'])
})

test('★★ new agent kind names are not translated', () => {
  const p = buildPermissionInfo({ tool_name: 'Bash', agent_id: 'a1', agent_type: 'Explore' })
  assert.deepEqual(p.subagent, { type: 'Explore' })
  assert.equal(inLang('en', () => agentTypeLabel(p)), 'Explore')
})

test('★★ unknown kinds and broken values do not throw and show a generic word (fail-closed / future agents)', () => {
  const future = [
    { kind: 'addRules', rules: [{ toolName: 'Bash' }] },
    { kind: 'addDirectories', directories: 'nope' },
    { kind: 'setMode' },
    null,
    'x',
    42,
  ]
  const out = inLang('en', () => suggestionTexts({ suggestionItems: future as never }))
  assert.equal(out.length, future.length, 'drops none')
  for (const s of out) assert.equal(s, 'another option')
  assert.equal(inLang('ja', () => suggestionText({ kind: 'zzz' })), 'ほかの候補')
  // The tag still shows with a broken `subagent`
  assert.equal(inLang('en', () => agentTypeLabel({ subagent: { type: 7 as never } })), 'Subagent')
  // No suggestions means empty (no row shown)
  assert.deepEqual(suggestionTexts({}), [])
})

test('★ synthesized rows (approval-only sessions) also carry the unknown-account flag', () => {
  const p = { ...made, sessionId: 's-synth' }
  const [row] = synthesizeRows([p], [])
  assert.ok(row)
  assert.equal(inLang('en', () => accountLabel(row)), '(unknown)')
})
