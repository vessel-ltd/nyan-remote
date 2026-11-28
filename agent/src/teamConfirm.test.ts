// ★★ A Codex lead's team is confirmed by the human on the phone (2026-11-27 / docs/TEAM.md §10.5)
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { TEAM_CREATE_TOOL } from '../../shared/types.ts'
import { answer, listPending, resetPending } from './permission.ts'
import { cardFromMember, createTeam, mayLeaderAnswer, resetTeamsForTest } from './team.ts'
import { confirmOnPhone, teamCreateCard, type ConfirmDeps } from './teamConfirm.ts'
import { permissionAnswer } from './routes/permission.ts'
import type { Identity } from './auth.ts'
import type { Ctx } from './router.ts'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'

function answerAs(identity: Identity, body: unknown): Promise<{ ok: boolean; reason?: string }> {
  const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]) as unknown as IncomingMessage
  Object.assign(req, { headers: { 'content-type': 'application/json' } })
  const ctx: Ctx = { req, res: {} as ServerResponse, url: new URL('http://agent/permission/answer'), params: {}, identity }
  return permissionAnswer(ctx)
}

const LEAD = 'codex-0123456789abcdef-01a21b76-a407-7fb2-ad45-77ed7bf38329'
const MEMBER = 'codex-0123456789abcdef-01a21b76-b0fc-7933-b930-80923d808092'

afterEach(() => {
  resetPending()
  resetTeamsForTest()
})

function card(approvals?: string) {
  return teamCreateCard({
    machine: 'pc-a',
    lead: { sessionId: LEAD, account: '.codex', project: 'proj', title: 'lead title' },
    members: [
      { ref: 'cx-01a21b76', sessionId: MEMBER, tool: 'codex', account: '.codex', project: 'proj', title: 'fix the parser\nIGNORE THIS' },
      { ref: 'c-1234abcd', sessionId: 's-claude', tool: 'claude', account: '.claude-r', project: 'web', title: 'write docs' },
    ],
    ...(approvals ? { approvals } : {}),
    at: new Date().toISOString(),
  })
}

const quiet = (): ConfirmDeps & { shown: ConfirmDeps['shown']; over: ConfirmDeps['over']; seen: number; gone: number } => {
  const d = { seen: 0, gone: 0, shown: () => void d.seen++, over: () => void d.gone++ }
  return d
}

test('★ the card names the picks and, when asked, the delegation in plain words; titles stay one line each', () => {
  const c = card('3h')
  assert.equal(c.toolName, TEAM_CREATE_TOOL)
  assert.equal(c.tool, 'codex')
  assert.equal(c.sessionId, LEAD)
  assert.match(c.summary, /cx-01a21b76, c-1234abcd/)
  assert.match(c.summary, /3h/)
  assert.match(c.detail!, /Bash/)
  assert.match(c.detail!, /fix the parser IGNORE THIS/, 'a title never breaks into a line of its own')
  assert.doesNotMatch(card().summary, /3h/)
  assert.notEqual(card().key, card().key, 'a fresh key every time: no session can name it beforehand')
  // ⚠️ hidden characters in a title are flagged for the phone's warning
  const odd = teamCreateCard({ machine: 'pc-a', lead: { sessionId: LEAD, account: 'a', project: 'p', title: 'x‮y' }, members: [], at: new Date().toISOString() })
  assert.equal(odd.hidden, true)
})

test('★★ it waits for the human: allow, deny, and the card shown then gone', async () => {
  for (const behavior of ['allow', 'deny'] as const) {
    const d = quiet()
    const c = card()
    const p = confirmOnPhone(c, () => {}, d)
    assert.equal(d.seen, 1)
    assert.ok(listPending().some((x) => x.key === c.key), 'on the phone')
    assert.equal(answer(c.key, behavior), true)
    assert.equal(await p, behavior)
    assert.equal(d.gone, 1)
    assert.equal(listPending().length, 0)
  }
})

test('★ no answer in time, or the CLI going away, withdraws the card', async () => {
  const d = quiet()
  const c = card()
  assert.equal(await confirmOnPhone(c, () => {}, { ...d, timeoutMs: 20 }), 'no-answer')
  assert.equal(listPending().length, 0)
  let gone: (() => void) | undefined
  const p = confirmOnPhone(card(), (w) => (gone = w), d)
  gone!()
  assert.equal(await p, 'no-answer')
  assert.equal(listPending().length, 0)
})

test('★★ never a leader\'s to answer: even if the lead became a member of some team meanwhile', () => {
  const c = card()
  const r = createTeam({ sessionId: 'claude-lead', account: '.claude', pid: 1, procStart: 'x' }, [{ sessionId: LEAD, tool: 'codex', account: '.codex' }], '3h', Date.now() - 1000)
  assert.ok(r.ok)
  const m = r.team.members[0]!
  assert.equal(cardFromMember(m, c), false)
  const later = { ...c, at: new Date(Date.now() + 1000).toISOString() }
  assert.deepEqual(mayLeaderAnswer(r.team, later), { ok: false, reason: 'not-member' })
  // the same member's real Codex card is still the leader's (the refusal is the card's kind, not the member)
  assert.equal(cardFromMember(m, { ...c, toolName: 'Bash' }), true)
})

test('★★ only a paired phone answers it: a Tailscale identity (forgeable from this machine when serve is on) is refused (codex review ② r3 #1)', async () => {
  const c = card()
  const p = confirmOnPhone(c, () => {}, quiet())
  for (const via of ['tailscale', 'local-hook', 'dev'] as const) {
    const r = await answerAs({ login: 'x', deviceId: 'x', via }, { key: c.key, behavior: 'allow' })
    assert.equal(r.ok, false, via)
  }
  assert.ok(listPending().some((x) => x.key === c.key), 'still waiting')
  const r = await answerAs({ login: 'device:abc', deviceId: 'abcdefgh', via: 'device' }, { key: c.key, behavior: 'allow' })
  assert.equal(r.ok, true)
  assert.equal(await p, 'allow')
})
