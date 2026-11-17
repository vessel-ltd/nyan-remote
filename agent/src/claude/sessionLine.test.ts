import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readSessionLine, sessionLineOf, sessionLinePath, sweepSessionLines, SESSION_LINE_MAX_AGE_MS } from './sessionLine.ts'

const SID = 'e608fc6c-0000-4000-8000-000000000000'
const OTHER = '11111111-1111-4111-8111-111111111111'
/** The fields Claude Code 2.1.326 gives the status line (measured; the rest left out) */
const input = (extra: Record<string, unknown> = {}) => ({
  session_id: SID,
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  effort: { level: 'high' },
  context_window: { context_window_size: 1000000, used_percentage: 21 },
  ...extra,
})

test('sessionLineOf: model, effort and context % of the session named inside; anything odd is left out', () => {
  assert.deepEqual(sessionLineOf(input(), SID), { model: 'Opus 5.5', effort: 'high', contextPercent: 21 })
  assert.equal(sessionLineOf(input(), OTHER), undefined, 'another session')
  assert.equal(sessionLineOf(null, SID), undefined)
  assert.deepEqual(sessionLineOf(input({ model: { display_name: 'Opus\u202E' }, effort: { level: 'HIGH' }, context_window: { used_percentage: 101 } }), SID), {})
  // Right after a compaction the percentage is null
  assert.deepEqual(sessionLineOf(input({ context_window: { used_percentage: null } }), SID), { model: 'Opus 5.5', effort: 'high' })
})

async function stateDirFor(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-sl-'))
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = dir
  t.after(async () => {
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(dir, { recursive: true, force: true })
  })
  await mkdir(join(dir, 'usage'), { recursive: true })
  return dir
}

test('readSessionLine: the relay\'s file for that id; a file holding another id, or no file, is nothing', async (t) => {
  await stateDirFor(t)
  await writeFile(sessionLinePath(SID), JSON.stringify(input()))
  assert.deepEqual(await readSessionLine(SID), { model: 'Opus 5.5', effort: 'high', contextPercent: 21 })
  await writeFile(sessionLinePath(OTHER), JSON.stringify(input()))
  assert.equal(await readSessionLine(OTHER), undefined)
  assert.equal(await readSessionLine('22222222-2222-4222-8222-222222222222'), undefined)
  assert.equal(await readSessionLine('../x'), undefined)
  // ⚠️ Fail-closed: a bad replacement is nothing, not the last good reading (codex review)
  await writeFile(sessionLinePath(SID), '{"session_id":')
  assert.equal(await readSessionLine(SID), undefined)
})

test('sweepSessionLines: ended sessions after a day, temp files after an hour; never a live one, never another name', async (t) => {
  const dir = await stateDirFor(t)
  const now = Date.now()
  const old = new Date(now - SESSION_LINE_MAX_AGE_MS - 1000)
  const usage = join(dir, 'usage')
  const files = {
    live: `session-${SID}.json`,
    ended: `session-${OTHER}.json`,
    recent: 'session-33333333-3333-4333-8333-333333333333.json',
    tmp: `.session-${SID}.123.456.tmp`,
    profile: 'claude-.claude-r.json',
    other: 'session-notes.json',
    notUuid: `session-${'-'.repeat(36)}.json`,
  }
  for (const f of Object.values(files)) {
    await writeFile(join(usage, f), '{}')
    if (f !== files.recent) await utimes(join(usage, f), old, old)
  }
  // Unsure of the live set: no session file, only the temp file
  assert.equal(await sweepSessionLines(new Set([SID]), now, dir, Number.POSITIVE_INFINITY), 1, 'only the temp file')
  assert.equal(await sweepSessionLines(new Set([SID]), now, dir), 1)
  assert.deepEqual((await readdir(usage)).sort(), [files.profile, files.recent, files.other, files.live, files.notUuid].sort())
})
