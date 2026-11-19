import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import type { SessionSummary } from '../../../shared/types.ts'
import { resetAutoApprove, setAutoApprove } from '../autoApprove.ts'
import { answer, listPending, resetPending } from '../permission.ts'
import type { CodexApproval } from './approvals.ts'
import { codexCard, offerCodexCard } from './cards.ts'

afterEach(() => resetPending())

const row = {
  machine: 'pc-a',
  account: '.codex',
  project: 'proj',
  sessionId: 'thread-1',
  tool: 'codex',
} as SessionSummary

const approval = (over: Partial<CodexApproval> = {}): CodexApproval => ({
  requestId: 0,
  threadId: 'thread-1',
  turnId: 'turn-1',
  itemId: 'item-1',
  command: 'touch /home/user/x',
  cwd: '/home/user/elsewhere',
  no: 'cancel',
  ...over,
})

const AT = '2026-11-14T12:00:00.000Z'

test('the card: a Codex yes/no card for the thread, with the row identity and the command as sent', () => {
  const c = codexCard(approval(), row, 3, AT)
  assert.match(c.key, /^codex:[0-9a-f]{24}#[0-9a-f]{12}$/)
  // ★ The same request on a later connection: another key, the same origin (teams / codex review r2, high #3)
  const replay = codexCard(approval(), row, 4, AT)
  assert.notEqual(replay.key, c.key)
  assert.equal(replay.origin, c.origin)
  assert.match(c.origin ?? '', /^codex:[0-9a-f]{24}$/)
  assert.deepEqual(
    { ...c, key: '', origin: '' },
    {
      key: '',
      origin: '',
      machine: 'pc-a',
      account: '.codex',
      project: 'proj',
      sessionId: 'thread-1',
      toolName: 'Bash',
      tool: 'codex',
      summary: 'touch /home/user/x',
      cwd: '/home/user/elsewhere',
      at: AT,
    },
  )
})

test('★ the card says where the command runs; hidden characters there are flagged; a long one is cut and said (security review 2026-11-17, medium)', () => {
  assert.equal(codexCard(approval({ cwd: '/home/user/secrets' }), row, 1, AT).cwd, '/home/user/secrets')
  assert.notDeepEqual(codexCard(approval({ cwd: '/home/user/a' }), row, 1, AT), codexCard(approval({ cwd: '/home/user/b' }), row, 1, AT))
  const noCwd = approval()
  delete noCwd.cwd
  assert.equal('cwd' in codexCard(noCwd, row, 1, AT), false)
  assert.equal(codexCard(approval({ cwd: '/home/user/\u202Eatad' }), row, 1, AT).hidden, true)
  const long = codexCard(approval({ cwd: '/' + 'a'.repeat(2000) }), row, 1, AT)
  assert.equal(long.cwd?.length, 1000)
  assert.equal(long.detailClipped, true)
})

test('the card: a long or multi-line command keeps its full text, and hidden characters are flagged', () => {
  const long = codexCard(approval({ command: `echo ${'a'.repeat(600)}\necho b` }), row, 1, AT)
  assert.ok(long.detail?.includes('\necho b'))
  const bidi = codexCard(approval({ command: 'cat \u202Etxt.gol' }), row, 1, AT)
  assert.equal(bidi.hidden, true)
  assert.equal(codexCard(approval(), row, 1, AT).hidden, undefined)
})

test('the card key is bound to the home, the generation and all four ids', () => {
  const base = (a: CodexApproval, r = row, gen = 1): string => codexCard(a, r, gen, AT).key.split('#')[0]!
  const k = base(approval())
  assert.equal(base(approval()), k, 'the same request is the same card')
  assert.notEqual(base(approval(), row, 2), k, 'another connection')
  assert.notEqual(base(approval(), { ...row, sessionId: 'codex-0000000000000000-thread-1' }), k, 'another home')
  assert.notEqual(base(approval({ requestId: 1 })), k)
  assert.notEqual(base(approval({ requestId: '0' })), k, 'ids keep their type')
  assert.notEqual(base(approval({ threadId: 'thread-2' })), k)
  assert.notEqual(base(approval({ turnId: 'turn-2' })), k)
  assert.notEqual(base(approval({ itemId: 'item-2' })), k)
  // ⚠️ And two cards for the same request never share the secret part
  assert.notEqual(codexCard(approval(), row, 1, AT).key, codexCard(approval(), row, 1, AT).key)
})

function offering(over: Partial<CodexApproval> = {}) {
  let changes = 0
  const logs: string[] = []
  const offer = offerCodexCard({ generation: () => 1, changed: () => changes++, now: () => new Date(AT), log: (l) => logs.push(l) })
  let withdraw: () => void = () => undefined
  const decided = offer(approval(over), row, (w) => (withdraw = w))
  return { decided, withdraw: () => withdraw(), changes: () => changes, logs }
}

test('offer: the card is listed, allow from the phone is yes, and the phones are told twice (shown, gone)', async () => {
  const o = offering()
  const listed = listPending()
  assert.equal(listed.length, 1)
  assert.equal(listed[0]!.tool, 'codex')
  assert.equal(o.changes(), 1)
  assert.equal(answer(listed[0]!.key, 'allow'), true)
  assert.equal(await o.decided, 'yes')
  assert.equal(listPending().length, 0)
  assert.equal(o.changes(), 2)
})

test('offer: deny from the phone is no; anything else the phone attached is dropped', async () => {
  const o = offering()
  answer(listPending()[0]!.key, 'deny', { message: 'do it differently', updatedInput: { command: 'rm -rf /' } })
  assert.equal(await o.decided, 'no')
})

test('offer: a withdrawn card ends without a decision and leaves the list', async () => {
  const o = offering()
  const key = listPending()[0]!.key
  o.withdraw()
  assert.equal(await o.decided, undefined)
  assert.equal(listPending().length, 0)
  assert.equal(answer(key, 'allow'), false, 'too late to answer')
})

async function withAutoState(t: { after: (fn: () => Promise<void>) => void }): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-codexcards-'))
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = dir
  resetAutoApprove()
  t.after(async () => {
    resetAutoApprove()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(dir, { recursive: true, force: true })
  })
}

test('★ auto-approve: while it is on for the thread, the approval is a yes without a card, a signal, or the command in the log', async (t) => {
  await withAutoState(t)
  const at = new Date(AT).getTime()
  assert.equal((await setAutoApprove('thread-1', true, at)).ok, true)
  const o = offering({ command: 'touch /home/user/secret-name' })
  assert.equal(listPending().length, 0, 'no card was raised')
  assert.equal(await o.decided, 'yes')
  assert.equal(o.changes(), 0, 'the phones are not told to re-read')
  assert.equal(o.logs.length, 1)
  assert.ok(!o.logs[0]!.includes('secret-name'))
})

test('auto-approve: another thread\'s entry, or an expired one, does not pass — the card is shown', async (t) => {
  await withAutoState(t)
  const at = new Date(AT).getTime()
  await setAutoApprove('thread-2', true, at)
  const other = offering()
  assert.equal(listPending().length, 1)
  other.withdraw()
  assert.equal(await other.decided, undefined)
  // On for this thread, but long ago (the card's clock is AT; the longest duration is 24 h)
  await setAutoApprove('thread-1', true, at - 25 * 3600 * 1000)
  const expired = offering()
  assert.equal(listPending().length, 1)
  expired.withdraw()
  assert.equal(await expired.decided, undefined)
})
