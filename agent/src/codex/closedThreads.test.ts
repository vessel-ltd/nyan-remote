import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { ClosedThreads } from './closedThreads.ts'
import type { RpcResult } from './rpc.ts'

function thread(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    parentThreadId: null,
    preview: `preview of ${id}`,
    ephemeral: false,
    updatedAt: 1000,
    status: { type: 'notLoaded' },
    cwd: '/home/user/proj',
    cliVersion: '0.169.0',
    threadSource: 'user',
    gitInfo: null,
    name: null,
    ...over,
  }
}

const ctx = { machine: 'pc-a', account: '.codex', idPrefix: 'codex-0123abcd0123abcd-' }

function setup(opts: { limit?: number } = {}) {
  const calls: Array<{ method: string; params: unknown }> = []
  const state = {
    saved: [] as Array<Record<string, unknown>>,
    /** ★ When set, the list is served in pages of this size (the cursor is the next index) */
    pageSize: undefined as number | undefined,
    /** ★ The page behind this cursor fails */
    failCursor: undefined as string | undefined,
    live: new Set<string>(),
    listFails: false,
    readFails: new Set<string>(),
    now: 0,
    changes: 0,
    /** Held list answers (a refresh in flight) */
    gate: Promise.resolve() as Promise<void>,
  }
  const c = new ClosedThreads({
    call: (method, params): Promise<RpcResult> => {
      calls.push({ method, params })
      return (async (): Promise<RpcResult> => {
        if (method === 'thread/list') {
          await state.gate
          if (state.listFails) return { ok: false, failure: { type: 'timeout', written: true } }
          if (state.failCursor !== undefined && (params as { cursor?: string }).cursor === state.failCursor) {
            return { ok: false, failure: { type: 'timeout', written: true } }
          }
          const all = state.saved.map((t) => ({ ...t, threadSource: null }))
          if (state.pageSize === undefined) return { ok: true, result: { data: all, nextCursor: null } }
          const from = Number((params as { cursor?: string }).cursor ?? 0)
          const to = from + state.pageSize
          return { ok: true, result: { data: all.slice(from, to), nextCursor: to < all.length ? String(to) : null } }
        }
        const id = (params as { threadId: string }).threadId
        const t = state.saved.find((x) => x.id === id)
        if (!t || state.readFails.has(id)) return { ok: false, failure: { type: 'error', error: { code: -1, message: 'x' } } }
        return { ok: true, result: { thread: t } }
      })()
    },
    isLive: (id) => state.live.has(id),
    now: () => state.now,
    changed: () => state.changes++,
    limit: opts.limit ?? 60,
  })
  return { c, calls, state }
}
const listed = (calls: Array<{ method: string }>) => calls.filter((x) => x.method === 'thread/list').length

test('rows: user threads only, not live, newest first, as history (live: false)', async () => {
  const s = setup()
  s.state.saved = [thread('a', { updatedAt: 1000 }), thread('b', { updatedAt: 2000 }), thread('sub', { threadSource: 'subagent' }), thread('child', { parentThreadId: 'a' })]
  await s.c.refresh()
  assert.deepEqual(s.c.rows(ctx).map((r) => [r.sessionId, r.live, r.status]), [
    [`${ctx.idPrefix}b`, false, 'unknown'],
    [`${ctx.idPrefix}a`, false, 'unknown'],
  ])
  assert.equal(s.state.changes, 1)
  s.state.live.add('b')
  assert.deepEqual(s.c.rows(ctx).map((r) => r.sessionId), [`${ctx.idPrefix}a`], 'a live thread is not history')
  assert.equal(s.c.has('b'), false)
  assert.equal(s.c.has('a'), true)
  assert.equal(s.c.has('sub'), false)
})

test('the list is asked in the fast mode, newest first, capped', async () => {
  const s = setup({ limit: 2 })
  s.state.saved = [thread('a'), thread('b'), thread('c')]
  await s.c.refresh()
  assert.deepEqual(s.calls[0], { method: 'thread/list', params: { limit: 2, sortKey: 'updated_at', sortDirection: 'desc', useStateDbOnly: true } })
  assert.equal(s.c.rows(ctx).length, 2, 'never more than the cap')
  assert.ok(!s.calls.some((x) => x.method === 'thread/resume'), 'nothing that loads a thread')
})

test('each thread is read once; a failed read is asked again next time; a failed list keeps the rows', async () => {
  const s = setup()
  s.state.saved = [thread('a'), thread('b')]
  s.state.readFails.add('b')
  await s.c.refresh()
  assert.deepEqual(s.c.rows(ctx).map((r) => r.sessionId), [`${ctx.idPrefix}a`])
  s.state.readFails.clear()
  await s.c.refresh()
  const reads = s.calls.filter((x) => x.method === 'thread/read').map((x) => (x.params as { threadId: string }).threadId)
  assert.deepEqual(reads, ['a', 'b', 'b'], 'a is not read again; b is, after its read failed')
  assert.equal(s.c.rows(ctx).length, 2)
  s.state.listFails = true
  await s.c.refresh()
  assert.equal(s.c.rows(ctx).length, 2, 'kept')
})

test('an unchanged list does not tell the phones', async () => {
  const s = setup()
  s.state.saved = [thread('a')]
  await s.c.refresh()
  await s.c.refresh()
  assert.equal(s.state.changes, 1)
  s.state.saved = [thread('a', { name: 'renamed' })]
  await s.c.refresh()
  assert.equal(s.state.changes, 2)
})

test('one refresh at a time; asked meanwhile ⇒ one more after it', async () => {
  const s = setup()
  s.state.saved = [thread('a')]
  let release: () => void = () => undefined
  s.state.gate = new Promise<void>((r) => (release = r))
  const first = s.c.refresh()
  void s.c.refresh()
  void s.c.refresh()
  await new Promise((r) => setImmediate(r))
  assert.equal(listed(s.calls), 1)
  release()
  await first
  assert.equal(listed(s.calls), 2, 'the two asks meanwhile became one more')
})

test('refreshIfOlder: only when the last read is older than asked', async () => {
  const s = setup()
  s.c.refreshIfOlder(60_000)
  await new Promise((r) => setImmediate(r))
  assert.equal(listed(s.calls), 1, 'never read yet')
  await s.c.refresh()
  const n = listed(s.calls)
  s.state.now = 30_000
  s.c.refreshIfOlder(60_000)
  assert.equal(listed(s.calls), n)
  s.state.now = 60_000
  s.c.refreshIfOlder(60_000)
  await new Promise((r) => setImmediate(r))
  assert.equal(listed(s.calls), n + 1)
})

test('★ the cap counts history rows: pages are read past threads that are not the user\'s (codex review, medium)', async () => {
  const s = setup({ limit: 2 })
  s.state.pageSize = 2
  s.state.saved = [
    thread('sub1', { threadSource: 'subagent' }),
    thread('sub2', { threadSource: 'subagent' }),
    thread('a'),
    thread('sub3', { threadSource: 'subagent' }),
    thread('b'),
    thread('c'),
  ]
  await s.c.refresh()
  assert.deepEqual(s.c.rows(ctx).map((r) => r.sessionId).sort(), [`${ctx.idPrefix}a`, `${ctx.idPrefix}b`])
  assert.deepEqual(
    s.calls.filter((x) => x.method === 'thread/list').map((x) => (x.params as { cursor?: string }).cursor),
    [undefined, '2', '4'],
    'stopped once the cap was reached',
  )
})

test('a failed page keeps the last rows (no partial list)', async () => {
  const s = setup({ limit: 5 })
  s.state.pageSize = 1
  s.state.saved = [thread('a'), thread('b')]
  await s.c.refresh()
  assert.equal(s.c.rows(ctx).length, 2)
  // Now the second page fails: the first page alone must not replace the rows
  s.state.saved = [thread('a'), thread('c'), thread('d')]
  s.state.failCursor = '1'
  await s.c.refresh()
  assert.deepEqual(s.c.rows(ctx).map((r) => r.sessionId).sort(), [`${ctx.idPrefix}a`, `${ctx.idPrefix}b`])
})

test('a change in branch or version alone reaches the rows (codex review, low)', async () => {
  const s = setup()
  s.state.saved = [thread('a', { gitInfo: { branch: 'main' } })]
  await s.c.refresh()
  assert.equal(s.c.rows(ctx)[0]!.gitBranch, 'main')
  s.state.saved = [thread('a', { gitInfo: { branch: 'new-branch' } })]
  await s.c.refresh()
  assert.equal(s.c.rows(ctx)[0]!.gitBranch, 'new-branch')
  assert.equal(s.state.changes, 2)
  s.state.saved = [thread('a', { gitInfo: { branch: 'new-branch' }, cliVersion: '0.170.0' })]
  await s.c.refresh()
  assert.equal(s.c.rows(ctx)[0]!.cliVersion, '0.170.0')
})

test('★ the sessions route asks for the history refresh on every list request, `?live=1` included (codex review, medium)', async () => {
  const src = await readFile(fileURLToPath(new URL('../routes/sessions.ts', import.meta.url)), 'utf8')
  // ⚠️ Executed lines only (the comments say the same words)
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
  const call = code.findIndex((l) => /^\s*codexHistoryWanted\(\)\s*$/.test(l))
  assert.ok(call >= 0, 'called unconditionally, on a line of its own')
  // Not inside a condition: the statement before it is not an `if (…)` without braces, and the call is not in a block
  //   that only runs for the full list
  assert.ok(!/^\s*(if|else)\b/.test(code[call - 1] ?? ''), 'not behind a condition')
  const before = code.slice(0, call).join('\n')
  const fnStart = before.lastIndexOf('export async function sessions')
  assert.ok(fnStart >= 0)
  const inFn = before.slice(fnStart)
  assert.equal((inFn.match(/\{/g) ?? []).length - (inFn.match(/\}/g) ?? []).length, 1, 'at the top level of the handler')
})

test('★ live threads do not use the cap (codex round 2, medium)', async () => {
  const s = setup({ limit: 2 })
  s.state.pageSize = 2
  s.state.saved = [thread('live1'), thread('live2'), thread('a'), thread('b')]
  s.state.live.add('live1')
  s.state.live.add('live2')
  await s.c.refresh()
  assert.deepEqual(s.c.rows(ctx).map((r) => r.sessionId).sort(), [`${ctx.idPrefix}a`, `${ctx.idPrefix}b`])
  // One that was live closes: still never more rows than the cap, and what is past it cannot be read by id
  s.state.live.delete('live1')
  const shown = s.c.rows(ctx).map((r) => r.sessionId.slice(ctx.idPrefix.length))
  assert.equal(shown.length, 2)
  for (const id of ['live1', 'a', 'b']) assert.equal(s.c.has(id), shown.includes(id), `has(${id}) matches the rows (codex round 3, low)`)
})

test('★ a failing list is retried at most once a minute, however often the phone asks (codex round 2, medium)', async () => {
  const s = setup()
  s.state.listFails = true
  for (let i = 0; i < 5; i++) {
    s.c.refreshIfOlder(60_000)
    await new Promise((r) => setImmediate(r))
  }
  assert.equal(listed(s.calls), 1)
  s.state.now = 60_000
  s.c.refreshIfOlder(60_000)
  await new Promise((r) => setImmediate(r))
  assert.equal(listed(s.calls), 2)
})

test('★ polls during a slow refresh join it and queue nothing (codex round 2, medium)', async () => {
  const s = setup()
  s.state.saved = [thread('a')]
  let release: () => void = () => undefined
  s.state.gate = new Promise<void>((r) => (release = r))
  s.c.refreshIfOlder(60_000)
  s.state.now = 120_000
  for (let i = 0; i < 5; i++) s.c.refreshIfOlder(60_000)
  release()
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))
  assert.equal(listed(s.calls), 1)
})
