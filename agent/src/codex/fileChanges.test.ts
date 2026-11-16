import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import type { SessionSummary } from '../../../shared/types.ts'
import { resetAutoApprove, setAutoApprove } from '../autoApprove.ts'
import { answer, listPending, resetPending } from '../permission.ts'
import { CodexApprovals, type PhoneDecision } from './approvals.ts'
import { codexFileChangeCard, offerCodexFileChange } from './cards.ts'
import { findChanges, parseFileChangeRequest, patchText, type CodexFileChange, type FileChange } from './fileChanges.ts'
import type { RpcId, RpcResult, ServerRequest } from './rpc.ts'

// ★ Verbatim from codex-cli 0.169.0 (Read Only + apply_patch / 2026-11-16; the home path replaced)
const FC = JSON.parse(readFileSync(new URL('./fixtures/file-change-0.169.0.json', import.meta.url), 'utf8')) as {
  request: ServerRequest
  resumeResult: Record<string, unknown>
}
const P = FC.request.params as Record<string, string>
const T = P.threadId!
const TURN = P.turnId!
const ITEM = P.itemId!
const HELLO: FileChange[] = [{ path: '/home/user/nyan-probe/hello.txt', kind: 'add', diff: 'hi\n' }]

afterEach(() => resetPending())

test('parse: the real request (no diff in it)', () => {
  assert.deepEqual(parseFileChangeRequest(FC.request), { requestId: 16, threadId: T, turnId: TURN, itemId: ITEM })
  const with_ = (over: Record<string, unknown>) => parseFileChangeRequest({ ...FC.request, params: { ...P, ...over } })
  assert.equal(with_({ reason: 'needs write' })?.reason, 'needs write')
  assert.equal(with_({ grantRoot: '/home/user' }), undefined, 'a grant for a whole directory is left to the PC')
  assert.equal(with_({ reason: 5 }), undefined)
  for (const k of ['threadId', 'turnId', 'itemId']) assert.equal(with_({ [k]: undefined }), undefined, `missing ${k}`)
  assert.equal(parseFileChangeRequest({ ...FC.request, method: 'item/commandExecution/requestApproval' }), undefined)
})

test('findChanges: the real resume reply has the pending change under the request\'s turn and item', () => {
  assert.deepEqual(findChanges(FC.resumeResult, TURN, ITEM), HELLO)
})

test('findChanges: anything off is no diff (never a partial list)', () => {
  const none = (reply: unknown, why: string, turn = TURN, item = ITEM): void => assert.equal(findChanges(reply, turn, item), undefined, why)
  none(FC.resumeResult, 'another item', TURN, 'exec-other')
  none(FC.resumeResult, 'another turn', 'turn-other', ITEM)
  none({}, 'no thread')
  none({ thread: { turns: 'x' } }, 'turns not a list')
  const shaped = (items: unknown[]) => ({ thread: { turns: [{ id: TURN, items }] } })
  const good = { type: 'fileChange', id: ITEM, changes: [{ path: '/p', kind: { type: 'update', move_path: null }, diff: '@@\n-a\n+b\n' }] }
  assert.deepEqual(findChanges(shaped([good]), TURN, ITEM), [{ path: '/p', kind: 'update', diff: '@@\n-a\n+b\n' }])
  none(shaped([good, good]), 'two items with the id')
  none(shaped([{ ...good, type: 'commandExecution' }]), 'not a file change')
  none(shaped([{ ...good, changes: [] }]), 'no changes')
  none(shaped([{ ...good, changes: [good.changes[0], { path: '/q', kind: { type: 'rename' }, diff: '' }] }]), 'one change of an unknown kind')
  none(shaped([{ ...good, changes: [{ path: '', kind: { type: 'add' }, diff: '' }] }]), 'no path')
  none(shaped([{ ...good, changes: [{ path: '/p', kind: { type: 'add' } }] }]), 'no diff')
  none(shaped([{ ...good, changes: [{ path: '/p', kind: { type: 'add', move_path: '/q' }, diff: '' }] }]), 'a move on an add')
  const moved = shaped([{ ...good, changes: [{ path: '/p', kind: { type: 'update', move_path: '/q' }, diff: '' }] }])
  assert.deepEqual(findChanges(moved, TURN, ITEM), [{ path: '/p', kind: 'update', movePath: '/q', diff: '' }])
})

const fc = (changes: FileChange[] = HELLO, reason?: string): CodexFileChange => ({
  requestId: 16,
  threadId: T,
  turnId: TURN,
  itemId: ITEM,
  ...(reason ? { reason } : {}),
  changes,
})

test('patchText: one block per file, paths quoted, every content line marked, the reason last', () => {
  assert.equal(patchText(fc()), 'add "/home/user/nyan-probe/hello.txt"\n│ hi')
  assert.equal(
    patchText(fc([{ path: '/a', kind: 'update', movePath: '/b', diff: '@@\n-x\n+y\n' }, { path: '/c', kind: 'delete', diff: '' }], 'why\ndelete "/x"')),
    'update "/a" → "/b"\n│ @@\n│ -x\n│ +y\n\ndelete "/c"\n\nreason: "why\\ndelete \\"/x\\""',
  )
})

test('★ patchText: content cannot imitate a header, a path cannot hide a newline, a missing final newline is said (codex high/low)', () => {
  const text = (changes: FileChange[]) => patchText(fc(changes))
  // The collision codex found: an add whose content looks like a delete of another file
  assert.notEqual(
    text([{ path: '/safe.txt', kind: 'add', diff: 'hello\n\ndelete /important.txt\n' }]),
    text([{ path: '/safe.txt', kind: 'add', diff: 'hello\n' }, { path: '/important.txt', kind: 'delete', diff: '' }]),
  )
  assert.notEqual(
    text([{ path: '/safe.txt', kind: 'add', diff: 'hello\n\ndelete "/important.txt"\n' }]),
    text([{ path: '/safe.txt', kind: 'add', diff: 'hello\n' }, { path: '/important.txt', kind: 'delete', diff: '' }]),
  )
  // Every line that is not a header or a separator starts with the mark
  const t = text([{ path: '/a', kind: 'add', diff: 'x\n\nadd "/b"\n' }])
  assert.deepEqual(t.split('\n'), ['add "/a"', '│ x', '│ ', '│ add "/b"'])
  // A newline in a file name stays inside its quotes
  assert.equal(text([{ path: '/a\ndelete "/b"', kind: 'add', diff: '' }]), 'add "/a\\ndelete \\"/b\\""')
  // `hello` and `hello\n` differ
  assert.notEqual(text([{ path: '/a', kind: 'add', diff: 'hello' }]), text([{ path: '/a', kind: 'add', diff: 'hello\n' }]))
  assert.equal(text([{ path: '/a', kind: 'add', diff: 'hello' }]), 'add "/a"\n│ hello\n\\ No newline at end of file')
})

const row = { machine: 'pc-a', account: '.codex', project: 'proj', sessionId: 'codex-0123abcd0123abcd-t', tool: 'codex' } as SessionSummary
const AT = '2026-11-16T12:00:00.000Z'

test('the card: a Codex ApplyPatch card with the files and the diff; hidden characters and long diffs are flagged', () => {
  const c = codexFileChangeCard(fc(), row, 1, AT)
  assert.equal(c.tool, 'codex')
  assert.equal(c.toolName, 'ApplyPatch')
  assert.equal(c.sessionId, row.sessionId)
  assert.match(c.summary, /hello\.txt/)
  assert.equal(c.detail, 'add "/home/user/nyan-probe/hello.txt"\n│ hi', 'the full text, newlines kept')
  assert.equal(c.interaction, undefined, 'a yes / no card')
  assert.equal(codexFileChangeCard(fc([{ path: '/a', kind: 'add', diff: 'x‮y' }]), row, 1, AT).hidden, true)
  const long = codexFileChangeCard(fc([{ path: '/a', kind: 'add', diff: 'x'.repeat(9000) + '\nrm' }]), row, 1, AT)
  assert.equal(long.detailClipped, true)
  assert.notEqual(c.key.split('#')[0], codexFileChangeCard(fc(), { ...row, sessionId: 'other' }, 1, AT).key.split('#')[0])
})

test('offer: allow is yes, deny is no; the card leaves the list', async () => {
  const offer = offerCodexFileChange({ generation: () => 1, changed: () => undefined, now: () => new Date(AT) })
  const yes = offer(fc(), row, () => undefined)
  answer(listPending()[0]!.key, 'allow')
  assert.equal(await yes, 'yes')
  const no = offer(fc(), row, () => undefined)
  answer(listPending()[0]!.key, 'deny')
  assert.equal(await no, 'no')
  assert.equal(listPending().length, 0)
})

test('★ auto-approve passes a file change as it passes a command (no card, no paths in the log)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-fc-'))
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = dir
  resetAutoApprove()
  t.after(async () => {
    resetAutoApprove()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(dir, { recursive: true, force: true })
  })
  assert.equal((await setAutoApprove(row.sessionId, true, new Date(AT).getTime())).ok, true)
  const logs: string[] = []
  const offer = offerCodexFileChange({ generation: () => 1, changed: () => undefined, now: () => new Date(AT), log: (l) => logs.push(l) })
  assert.equal(await offer(fc(), row, () => undefined), 'yes')
  assert.equal(listPending().length, 0)
  assert.ok(!logs.join(' ').includes('hello'))
})

// ── The path in `approvals.ts`: the diff is looked up before the card, and anything that happens meanwhile wins ──

function setup() {
  const responses: Array<{ id: RpcId; result: unknown }> = []
  const offered: Array<{ change: CodexFileChange; decide: (d: PhoneDecision | undefined) => void; withdrawn: boolean }> = []
  const waiting = new Map<string, Set<'approval' | 'answer'>>([[T, new Set(['approval'])]])
  const lookups: Array<{ resolve: (c: FileChange[] | undefined) => void }> = []
  const a = new CodexApprovals({
    call: async (): Promise<RpcResult> => ({ ok: true, result: {} }),
    respond: async (id, result, guard) => {
      if (!guard()) return false
      responses.push({ id, result })
      return true
    },
    isWaiting: (id, on) => {
      const w = waiting.get(id)
      return w !== undefined && (on ? w.has(on) : w.size > 0)
    },
    sleep: () => new Promise<void>(() => undefined),
    offer: () => new Promise(() => undefined),
    fetchChanges: () => new Promise((resolve) => lookups.push({ resolve })),
    offerFileChange: (change, onWithdraw) =>
      new Promise((decide) => {
        const o = { change, decide, withdrawn: false }
        onWithdraw(() => {
          o.withdrawn = true
          decide(undefined)
        })
        offered.push(o)
      }),
  })
  return { a, responses, offered, waiting, lookups }
}
const tick = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

test('the card comes after the diff; yes is accept, no is cancel', async () => {
  const s = setup()
  assert.equal(s.a.onServerRequest(FC.request), true)
  assert.equal(s.offered.length, 0, 'not before the diff')
  s.lookups[0]!.resolve(HELLO)
  await tick()
  assert.deepEqual(s.offered[0]!.change.changes, HELLO)
  s.offered[0]!.decide('yes')
  await tick()
  assert.deepEqual(s.responses, [{ id: 16, result: { decision: 'accept' } }])

  const n = setup()
  n.a.onServerRequest(FC.request)
  n.lookups[0]!.resolve(HELLO)
  await tick()
  n.offered[0]!.decide('no')
  await tick()
  assert.deepEqual(n.responses, [{ id: 16, result: { decision: 'cancel' } }])
})

test('★ no diff ⇒ no card and no answer (the PC answers)', async () => {
  const s = setup()
  s.a.onServerRequest(FC.request)
  s.lookups[0]!.resolve(undefined)
  await tick()
  assert.equal(s.offered.length, 0)
  assert.deepEqual(s.responses, [])
  assert.equal(s.a.cards, 0)
})

test('race: answered on the PC, or the thread stopped waiting, while the diff was looked up ⇒ never offered', async () => {
  const s = setup()
  s.a.onServerRequest(FC.request)
  s.a.onResolved({ threadId: T, requestId: 16 })
  s.lookups[0]!.resolve(HELLO)
  await tick()
  assert.equal(s.offered.length, 0)

  const w = setup()
  w.a.onServerRequest(FC.request)
  w.waiting.set(T, new Set())
  w.a.sync(T)
  w.lookups[0]!.resolve(HELLO)
  await tick()
  assert.equal(w.offered.length, 0)
})

test('race: the request replayed while its diff was looked up ⇒ only the new one is offered', async () => {
  const s = setup()
  s.a.onServerRequest(FC.request)
  s.a.onServerRequest(FC.request)
  s.lookups[0]!.resolve(HELLO)
  await tick()
  assert.equal(s.offered.length, 0, 'the first lookup belongs to the replaced card')
  s.lookups[1]!.resolve(HELLO)
  await tick()
  assert.equal(s.offered.length, 1)
})

test('race: the line ends while the diff was looked up ⇒ never offered, nothing sent', async () => {
  const s = setup()
  s.a.onServerRequest(FC.request)
  s.a.dispose()
  s.lookups[0]!.resolve(HELLO)
  await tick()
  assert.equal(s.offered.length, 0)
  assert.deepEqual(s.responses, [])
})
