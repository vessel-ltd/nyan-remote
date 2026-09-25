import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { hooksFor, noteHook, seedHookState } from './hookState.ts'

// ★★ Restoring at startup (`seedHookState`) must not bring back "asking for approval".
//
// The shape hit on a real machine on 2026-08-18 (machine B / session `git-push fix`):
//   04:36:31  a tool call is written, and right after it a Notification (approval request) arrives
//   ~04:52    approved on the PC, and `codex exec` runs for 21 minutes (nothing is written to the transcript)
//   04:52:02  the agent restarts for a deploy → **the answer card dies with the process**, yet
//             only "asking for approval" was restored from `hooks.jsonl` and **re-armed**
//   04:36–57  "needs attention" the whole time. `/permissions` is empty, so **there is no way to answer**
//   04:57:40  the tool finishes and writes → last activity overtakes it and it clears
//
// ⚠️ Dropping the restore does not hide real approvals:
//   - while the dialog is open, **the CLI itself says `waiting`** (see the notes in sessions.ts)
//   - if the hook is alive, the **card** takes effect first
// ⚠️ On the other hand `stop` (done / abnormal exit) is a finished fact, so it may be restored (that is what this was built for).

async function seedWith(lines: object[]): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-hookstate-'))
  await writeFile(join(dir, 'hooks.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  const prev = process.env.NYAN_REMOTE_STATE_DIR
  process.env.NYAN_REMOTE_STATE_DIR = dir
  try {
    return await seedHookState()
  } finally {
    if (prev === undefined) delete process.env.NYAN_REMOTE_STATE_DIR
    else process.env.NYAN_REMOTE_STATE_DIR = prev
  }
}

test('★★ restoring at startup does not bring back "asking for approval" (it gets stuck with no card to answer)', async () => {
  const n = await seedWith([
    { event: 'Notification', notice: 'permission', sessionId: 'seed-perm', at: '2026-08-18T04:36:40.000Z' },
    { event: 'Stop', sessionId: 'seed-stop', at: '2026-08-18T04:36:50.000Z' },
  ])
  assert.equal(n, 2, 'both lines were read (if not, the asserts below are a false green)')
  assert.equal(hooksFor('seed-perm')?.permission, undefined, 'do not create an awaiting-approval that cannot be answered')
  assert.deepEqual(
    hooksFor('seed-stop')?.stop,
    { event: 'Stop', at: '2026-08-18T04:36:50.000Z' },
    'done / abnormal exit are restored (so "done" does not vanish on restart)',
  )
})

test('★ a Notification that arrives while running is remembered as before (the feature is not removed)', () => {
  noteHook({
    event: 'Notification',
    notice: 'permission',
    sessionId: 'live-perm',
    at: '2026-08-18T05:00:00.000Z',
    machine: 'M',
    account: '.claude-r',
    project: 'p',
  })
  assert.deepEqual(hooksFor('live-perm')?.permission, { at: '2026-08-18T05:00:00.000Z' })
})

test('an idle notice does not change state (so it does not overwrite Stop and erase "done")', () => {
  noteHook({
    event: 'Stop',
    sessionId: 'idle-notice',
    at: '2026-08-18T05:00:00.000Z',
    machine: 'M',
    account: '.claude-r',
    project: 'p',
  })
  noteHook({
    event: 'Notification',
    notice: 'idle',
    sessionId: 'idle-notice',
    at: '2026-08-18T05:01:00.000Z',
    machine: 'M',
    account: '.claude-r',
    project: 'p',
  })
  assert.equal(hooksFor('idle-notice')?.stop?.event, 'Stop')
  assert.equal(hooksFor('idle-notice')?.permission, undefined)
})
