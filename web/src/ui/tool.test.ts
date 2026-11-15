import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentFeature, PermissionRequest, SessionSummary } from '../../../shared/types.ts'
import { autoApproveView } from './autoApprove.ts'
import { COMMAND_UI, commandView } from './commands.ts'
import { applyAutoApprove, synthesizeRows } from './order.ts'
import { stopView } from './stop.ts'
import { actionFeatures, canSendTo, canStop, isCodex, sendBlockedNote } from './tool.ts'

const ALL: AgentFeature[] = ['slash-commands', 'clear-input', 'auto-approve', 'device-pairing', 'device-handshake', 'log-follow', 'auto-approve-24h', 'codex-sessions', 'codex-log-follow']
const NO_CODEX_FOLLOW = ALL.filter((f) => f !== 'codex-log-follow')

function row(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    machine: 'pc-a',
    account: '.codex',
    sessionId: '01a1d8d9-66fc-7823-968f-c97d7234176e',
    cwd: '/home/user/proj',
    project: 'proj',
    title: 'x',
    titleSource: 'fallback',
    status: 'working',
    live: true,
    lastActivity: '2026-11-14T00:00:00.000Z',
    transcriptBytes: 0,
    ...over,
  }
}

test('isCodex: only the explicit mark; a row without it is Claude Code', () => {
  assert.equal(isCodex(row({ tool: 'codex' })), true)
  assert.equal(isCodex(row()), false)
  assert.equal(isCodex(undefined), false)
})

const CODEX_MARKS: AgentFeature[] = ['codex-log-follow', 'codex-send', 'codex-auto-approve']
const EVERYTHING: AgentFeature[] = [...ALL, 'codex-send', 'codex-auto-approve']

test('a Claude row keeps every feature and can be sent to', () => {
  assert.deepEqual(actionFeatures(row(), ALL), ALL)
  assert.equal(actionFeatures(row(), undefined), undefined)
  assert.equal(canSendTo(row(), undefined), true)
  assert.equal(sendBlockedNote(row(), undefined), undefined)
})

test('a Codex row on an agent without the Codex marks gets no action, cannot be sent to, and says why', () => {
  const codex = row({ tool: 'codex' })
  assert.deepEqual(actionFeatures(codex, NO_CODEX_FOLLOW), [])
  assert.deepEqual(actionFeatures(codex, undefined), [])
  // ★ Each thing passes only with its own mark (the Claude-side mark is not enough)
  assert.deepEqual(actionFeatures(codex, ALL), ['log-follow'])
  for (const f of [ALL, undefined, []]) {
    assert.equal(canSendTo(codex, f), false)
    assert.ok((sendBlockedNote(codex, f) ?? '').length > 0)
  }
})

test('★ each Codex mark opens exactly its own action', () => {
  const codex = row({ tool: 'codex' })
  assert.equal(canSendTo(codex, [...ALL, 'codex-send']), true)
  assert.equal(sendBlockedNote(codex, [...ALL, 'codex-send']), undefined)
  assert.equal(canSendTo(codex, [...ALL, 'codex-auto-approve']), false, 'another Codex mark does not open sending')
  assert.deepEqual(actionFeatures(codex, EVERYTHING), ['log-follow', 'auto-approve', 'auto-approve-24h'])
  // ⚠️ A grant needs the agent to have the thing itself too (an agent without the 24 h choice does not offer it)
  assert.deepEqual(
    actionFeatures(codex, EVERYTHING.filter((f) => f !== 'auto-approve-24h')),
    ['log-follow', 'auto-approve'],
  )
  // ⚠️ The Codex marks alone grant nothing (nothing to grant from)
  assert.deepEqual(actionFeatures(codex, CODEX_MARKS), [])
  assert.equal(autoApproveView(row({ tool: 'codex', status: 'idle' }), 'ready', actionFeatures(codex, EVERYTHING)).show, true)
  assert.equal(autoApproveView(row({ tool: 'codex', status: 'idle' }), 'ready', actionFeatures(codex, ALL)).show, false)
})

test('★ no command or stop button shows for a Codex row, whatever the marks (the real view functions)', () => {
  // ⚠️ Even a Codex row that (wrongly) carried a send route must not grow buttons
  for (const codex of [row({ tool: 'codex' }), row({ tool: 'codex', sendRoute: 'keys' })]) {
    const f = actionFeatures(codex, EVERYTHING)
    for (const id of Object.keys(COMMAND_UI) as Array<keyof typeof COMMAND_UI>) {
      // ★ `auto-approve` is not a keyed command: it has its own view (`autoApproveView`, checked above)
      if (id === 'auto-approve') continue
      assert.equal(commandView(codex, id as never, 'ready', f).show, false, `command ${String(id)}`)
    }
  }
  // The stop button needs the Codex mark: everything else (even a key route on the row) leaves it hidden
  assert.equal(stopView(row({ tool: 'codex' }), 'ready', EVERYTHING).show, false)
  assert.equal(stopView(row({ tool: 'codex', sendRoute: 'keys' }), 'ready', EVERYTHING).show, false)
  // Control: the same checks do show for a Claude row with a keystroke route (so this test can fail)
  const claude = row({ sendRoute: 'keys' })
  assert.equal(autoApproveView(claude, 'ready', actionFeatures(claude, ALL)).show, true)
  assert.equal(stopView(claude, 'ready', ALL).show, true)
})

test('★ the stop button shows for a live Codex row only with codex-interrupt (2026-11-15)', () => {
  const marks: AgentFeature[] = [...EVERYTHING, 'codex-interrupt']
  assert.equal(canStop(row({ tool: 'codex' }), marks), true)
  assert.equal(stopView(row({ tool: 'codex' }), 'ready', marks).show, true)
  // ⚠️ Not on a closed row, and another Codex mark does not open it
  assert.equal(stopView(row({ tool: 'codex', live: false }), 'ready', marks).show, false)
  assert.equal(canStop(row({ tool: 'codex' }), EVERYTHING), false)
  assert.equal(canStop(row({ tool: 'codex' }), undefined), false)
  // ⚠️ The Codex mark does not change a Claude row: it still needs its key route
  assert.equal(canStop(row(), marks), false)
  assert.equal(canStop(row({ sendRoute: 'inbox' }), undefined), true)
  // ★ Shown whatever the status (the agent refuses idle / waiting), like Claude's
  for (const status of ['idle', 'waiting', 'done'] as const) assert.equal(stopView(row({ tool: 'codex', status }), 'ready', marks).show, true)
})

// ── codex review (2026-11-15), medium #7: rows the PWA builds itself must keep the tool ──────────────────────

const CODEX_CARD: PermissionRequest = {
  key: 'codex:abc#def',
  machine: 'pc-a',
  account: '.codex',
  project: 'proj',
  sessionId: 'codex-0000000000000000-01a1d8d9-66fc-7823-968f-c97d7234176e',
  toolName: 'Bash',
  tool: 'codex',
  summary: 'ls',
  at: '2026-11-14T00:00:00.000Z',
}

test('★ a row synthesized from a Codex card is a Codex row: no send or auto-approve without the Codex marks', () => {
  // ⚠️ The output of the real function, not a hand-built row (the hand-built ones were tagged correctly and hid this)
  const [synth] = synthesizeRows([CODEX_CARD], [])
  assert.equal(isCodex(synth), true)
  assert.equal(canSendTo(synth, ALL), false)
  assert.ok(!(actionFeatures(synth, ALL) ?? []).includes('auto-approve'))
  // A Claude card's row stays Claude
  const [claude] = synthesizeRows([{ ...CODEX_CARD, tool: undefined, sessionId: '01a1d8d9-66fc-7823-968f-c97d7234176e' }], [])
  assert.equal(isCodex(claude), false)
})

test('★ a row built from a Codex auto-approve mark is a Codex row too', () => {
  const [made] = applyAutoApprove([], [{ sessionId: CODEX_CARD.sessionId!, until: '2026-11-14T03:00:00.000Z', machine: 'pc-a', tool: 'codex' }])
  assert.equal(isCodex(made), true)
  assert.equal(canSendTo(made, ALL), false)
  const [claude] = applyAutoApprove([], [{ sessionId: 'x', until: '2026-11-14T03:00:00.000Z', machine: 'pc-a' }])
  assert.equal(isCodex(claude), false)
})
