// ★★ Notification inputs (`agent/src/notify.ts`).
//    ⚠️ If this returns values different from the list, the text splits even with a single verdict function.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readNotifyMetaFromTranscript } from './notify.ts'

/** A transcript whose conversation records have no timestamp (no user/assistant in the last 64KB) */
const NO_TIMESTAMP = [
  JSON.stringify({ type: 'summary', summary: 'x' }),
  JSON.stringify({ type: 'custom-title', customTitle: '題名' }),
].join('\n')

test('★★ lastActivity is "conversation record → mtime" in that order (same as the list)', async () => {
  // ⚠️⚠️ 2026-08-21 `/code-review` medium #2. The mtime fallback was dropped, so
  //    the list used mtime and the notification used "now", and **the same Stop hook was "new" in the list
  //    and "old" in the notification**, splitting into list = done / notification = running.
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-notify-'))
  try {
    const file = join(dir, '11111111-2222-3333-4444-555555555555.jsonl')
    await writeFile(file, `${NO_TIMESTAMP}\n`, 'utf8')
    const meta = await readNotifyMetaFromTranscript(file)
    assert.ok(meta, 'should be readable')
    assert.ok(meta.lastActivity, '★ filled from mtime even when conversation records have no timestamp')
    assert.ok(!Number.isNaN(Date.parse(meta.lastActivity)), `not a timestamp: ${meta.lastActivity}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('★ an unreadable transcript is null (no false title / fail-closed)', async () => {
  assert.equal(await readNotifyMetaFromTranscript('/does/not/exist.jsonl'), null)
})
