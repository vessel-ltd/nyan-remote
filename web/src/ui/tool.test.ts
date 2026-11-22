import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentFeature, PermissionRequest, SessionSummary } from '../../../shared/types.ts'
import { autoApproveView } from './autoApprove.ts'
import { COMMAND_UI, commandUi, commandView } from './commands.ts'
import { applyAutoApprove, synthesizeRows } from './order.ts'
import { stopView } from './stop.ts'
import { actionFeatures, canAttachTo, canSendTo, canStop, isCodex, sendBlockedNote } from './tool.ts'

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

test('★ an agy row (2026-11-19): only follow, with its own mark; no send, stop, command or auto-approve, whatever the marks', () => {
  for (const agy of [row({ tool: 'agy', account: 'agy' }), row({ tool: 'agy', account: 'agy', sendRoute: 'keys' })]) {
    const f = actionFeatures(agy, [...EVERYTHING, 'agy-log-follow'])
    assert.deepEqual(f, ['log-follow'])
    assert.deepEqual(actionFeatures(agy, EVERYTHING), [], 'no agy mark ⇒ nothing, not Claude’s features')
    for (const id of Object.keys(COMMAND_UI) as Array<keyof typeof COMMAND_UI>) {
      if (id === 'auto-approve') continue
      assert.equal(commandView(agy, id as never, 'ready', f).show, false, `command ${String(id)}`)
    }
    assert.equal(autoApproveView(agy, 'ready', f).show, false)
    assert.equal(stopView(agy, 'ready', EVERYTHING).show, false)
    assert.equal(canStop(agy, EVERYTHING), false)
    assert.equal(canSendTo(agy, EVERYTHING), false)
    assert.ok(sendBlockedNote(agy, EVERYTHING))
  }
  // ⚠️ a tool this PWA does not know is never treated as Claude
  const unknown = row({ tool: 'future' as never, sendRoute: 'keys' })
  assert.deepEqual(actionFeatures(unknown, ALL), [])
  assert.equal(canSendTo(unknown, ALL), false)
  assert.equal(canStop(unknown, ALL), false)
})

test('★★ agy send and stop (2026-11-20): only with the agent\'s marks AND a row the relay announced; files only with agy-files, never commands or auto-approve', () => {
  const marks: AgentFeature[] = [...EVERYTHING, 'agy-log-follow', 'agy-send', 'agy-interrupt', 'agy-question']
  const relayed = row({ tool: 'agy', account: 'agy', sendRoute: 'keys' })
  const plain = row({ tool: 'agy', account: 'agy' })
  assert.equal(canSendTo(relayed, marks), true)
  assert.equal(canStop(relayed, marks), true)
  assert.equal(stopView(relayed, 'ready', marks).show, true)
  assert.equal(sendBlockedNote(relayed, marks), undefined)
  assert.equal(canAttachTo(relayed, marks), false, 'no files for agy without the agent\'s agy-files')
  // ★ 2026-11-22: with agy-files, files go to a row it can send to (never to one started without the relay)
  assert.equal(canAttachTo(relayed, [...marks, 'agy-files']), true)
  assert.equal(canAttachTo(plain, [...marks, 'agy-files']), false)
  assert.equal(canAttachTo(relayed, [...EVERYTHING, 'agy-log-follow', 'agy-files']), false, 'agy-files alone does not send')
  // the actions on the thread stay as before (no commands, no auto-approve)
  const f = actionFeatures(relayed, marks)
  assert.deepEqual(f, ['log-follow'])
  assert.equal(autoApproveView(relayed, 'ready', f).show, false)
  // ⚠️ started without the relay: no send, no stop, and the box says how to fix it
  assert.equal(canSendTo(plain, marks), false)
  assert.equal(canStop(plain, marks), false)
  assert.match(sendBlockedNote(plain, marks) ?? '', /nyan-remote/)
  // ⚠️ an agent without the marks (older): nothing, even with the relay
  assert.equal(canSendTo(relayed, [...EVERYTHING, 'agy-log-follow']), false)
  assert.equal(canStop(relayed, [...EVERYTHING, 'agy-log-follow', 'agy-send']), false)
  // ⚠️ an agent before questions (phase 4): its stop sent ESC into a question (skipping it) ⇒ no stop button
  assert.equal(canStop(relayed, [...EVERYTHING, 'agy-log-follow', 'agy-send', 'agy-interrupt']), false)
  assert.equal(stopView(relayed, 'ready', [...EVERYTHING, 'agy-log-follow', 'agy-send', 'agy-interrupt']).show, false)
  // a Claude row still attaches
  assert.equal(canAttachTo(row(), ALL), true)
})

test('★ agy: a conversation open in two agys says so (not "restart agy")', () => {
  const features: AgentFeature[] = ['agy-send']
  const note = sendBlockedNote({ tool: 'agy', agyShared: true }, features)
  assert.match(note ?? '', /2つの agy|two agys/)
  assert.doesNotMatch(note ?? '', /起こし直す|Start agy again/)
  assert.match(sendBlockedNote({ tool: 'agy' }, features) ?? '', /起こし直す|Start agy again/)
})

test('★★ agy auto-approve (2026-11-20): only with its own mark; "on" needs a relayed agy alone on the conversation; "off" always shows', () => {
  const marks: AgentFeature[] = [...EVERYTHING, 'agy-log-follow', 'agy-send', 'agy-interrupt', 'agy-auto-approve']
  const relayed = row({ tool: 'agy', account: 'agy', sendRoute: 'keys', status: 'idle' })
  const f = actionFeatures(relayed, marks)
  assert.deepEqual(f, ['log-follow', 'auto-approve', 'auto-approve-24h'])
  assert.equal(autoApproveView(relayed, 'ready', f).show, true)
  // ⚠️ the 24 h choice still needs the agent's own mark; the Claude-side mark alone grants nothing to agy
  assert.deepEqual(actionFeatures(relayed, marks.filter((m) => m !== 'auto-approve-24h')), ['log-follow', 'auto-approve'])
  assert.deepEqual(actionFeatures(relayed, marks.filter((m) => m !== 'agy-auto-approve')), ['log-follow'])
  // not through the relay / open in two agys ⇒ no "on"
  for (const r of [row({ tool: 'agy', account: 'agy', status: 'idle' }), row({ tool: 'agy', account: 'agy', sendRoute: 'keys', agyShared: true, status: 'idle' })]) {
    assert.equal(autoApproveView(r, 'ready', actionFeatures(r, marks)).show, false)
    // ★ but when it is on, the way to turn it off stays
    const on = { ...r, autoApprove: { until: '2026-11-20T03:00:00.000Z' } }
    assert.equal(autoApproveView(on, 'ready', actionFeatures(on, marks)).show, true)
    assert.equal(autoApproveView(on, 'ready', actionFeatures(on, marks)).on, true)
  }
  // a row built from an agy mark is an agy row (never Claude's buttons)
  const [made] = applyAutoApprove([], [{ sessionId: 'agy-062a8f25-9451-42f3-ae93-34a208e99365', until: '2026-11-14T03:00:00.000Z', machine: 'pc-a', tool: 'agy' }])
  assert.equal(made!.tool, 'agy')
  assert.equal(canSendTo(made, ALL), false)
})


test('★ the agy auto-approve confirmation says what it really passes (commands and outside reads; others still stop; ends on restart)', () => {
  const body = commandUi('auto-approve', { tool: 'agy' }).body
  assert.match(body, /コマンド|commands/)
  assert.match(body, /再起動|restarts/)
  assert.doesNotMatch(body, /Web 取得|web fetches/)
  // ⚠️ no "needs you" promised for agy questions (they do not ring yet)
  assert.doesNotMatch(body, /質問は今までどおり止まり、「要対応」|questions still stop as before, and you get/)
  assert.match(commandUi('auto-approve', undefined).body, /Web 取得|web fetches/, 'Claude keeps its wording')
})
