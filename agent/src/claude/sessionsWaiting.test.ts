import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { collectSessions } from './sessions.ts'
import { noteHook } from './hookState.ts'

// ★★ Whether the **reason** for "needs attention" (`waitingFor`) reaches the value handed to the screen (2026-08-18).
//
// The CLI writes `waitingFor` together with `status: "waiting"` to the session record
// (2.1.234's `kZh()` → `HHn({status, waitingFor})`. ARCHITECTURE §9.1).
//
// ⚠️ A test that only calls `parseIndexEntry` on its own **stays green even if the assembling side forgets to pass it**.
//    So here we check the return of `collectSessions` (= the value the API returns as is and the screen reads).
// ⚠️ To be treated as a live session, it uses **our own pid and the /proc starttime**.

async function fixture(status: string, waitingFor?: string) {
  const root = await mkdtemp(join(tmpdir(), 'nyan-remote-waitingfor-'))
  const dir = join(root, '.claude-test')
  const projectsDir = join(dir, 'projects')
  const project = join(projectsDir, '-tmp-proj')
  await mkdir(join(dir, 'sessions'), { recursive: true })
  await mkdir(project, { recursive: true })

  const sessionId = '11111111-2222-3333-4444-555555555555'
  // ⚠️ **Do not write** `procStart` (2026-08-18 codex review, medium #4).
  //    Writing it makes the test skip on environments without `/proc` (mac), so **breakage goes unnoticed**.
  //    Without `procStart` in the index, `selectLive` passes on a liveness check alone (as implemented).
  await writeFile(
    join(dir, 'sessions', `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId,
      cwd: '/tmp/proj',
      status,
      ...(waitingFor !== undefined && { waitingFor }),
      kind: 'interactive',
    }),
  )
  // transcript (one line is enough to read. It is live, so it passes the minimum-size limit)
  await writeFile(
    join(project, `${sessionId}.jsonl`),
    JSON.stringify({
      type: 'user',
      cwd: '/tmp/proj',
      timestamp: '2026-08-18T05:00:00.000Z',
      message: { role: 'user', content: 'テスト' },
    }) + '\n',
  )
  return { dirs: [{ account: '.claude-test', dir, projectsDir }], sessionId, root }
}

test('★★ when waiting, "what it is waiting for" reaches the value handed to the screen', async (t) => {
  const { dirs, sessionId, root } = await fixture('waiting', 'permission prompt')
  t.after(() => rm(root, { recursive: true, force: true }))
  const res = await collectSessions(dirs, 10)
  const s = res.sessions.find((x) => x.sessionId === sessionId)
  assert.ok(s, 'one session is returned (otherwise the asserts below are a false green)')
  assert.equal(s.status, 'waiting')
  assert.equal(s.live, true)
  assert.equal(s.waitingFor, 'permission prompt')
})

test('★ no reason attached when not waiting (we do not fabricate a reason)', async (t) => {
  // ⚠️ Even if it remains in the record, do not show it unless it is waiting now
  const { dirs, sessionId, root } = await fixture('busy', 'permission prompt')
  t.after(() => rm(root, { recursive: true, force: true }))
  const res = await collectSessions(dirs, 10)
  const s = res.sessions.find((x) => x.sessionId === sessionId)
  assert.ok(s)
  assert.equal(s.status, 'working')
  assert.equal(s.waitingFor, undefined)
})

test('★★ no reason attached when the CLI is not waiting (when waiting came from a card or Notification)', async (t) => {
  // ⚠️ Flagged by /code-review: our `status` becomes waiting **from cards and Notification too**.
  //    If a stale `waitingFor` remains in the record then, **awaiting approval gets an unrelated reason**.
  const { dirs, sessionId, root } = await fixture('idle', 'sandbox request')
  t.after(() => rm(root, { recursive: true, force: true }))
  // Record a Notification (approval request) with a time after the conversation's last activity
  noteHook({
    event: 'Notification',
    notice: 'permission',
    sessionId,
    at: '2026-08-18T06:00:00.000Z',
    machine: 'M',
    account: '.claude-test',
    project: 'proj',
  })
  const res = await collectSessions(dirs, 10)
  const s = res.sessions.find((x) => x.sessionId === sessionId)
  assert.ok(s)
  assert.equal(s.status, 'waiting', 'precondition: our verdict is needs-attention')
  assert.equal(s.waitingFor, undefined, 'the CLI is not waiting, so no reason is attached')
})
