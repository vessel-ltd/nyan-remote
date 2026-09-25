import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFollowWatch, type FileSig } from './follow.ts'

function world() {
  const files = new Map<string, FileSig>()
  const followed = new Set<string>()
  const notified: string[] = []
  let located = 0
  const w = createFollowWatch({
    sessions: () => followed,
    locateTranscript: async (id) => {
      located++
      return files.has(`/t/${id}.jsonl`) ? `/t/${id}.jsonl` : undefined
    },
    inflightPath: (id) => `/i/${id}.jsonl`,
    stat: async (p) => files.get(p),
    notify: (id) => notified.push(id),
  })
  return { w, files, followed, notified, located: () => located }
}

test('★★ when a transcript grows, notify only followed sessions (the first tick also notifies / round 16, medium #2)', async () => {
  const x = world()
  x.files.set('/t/A.jsonl', { size: 10, mtimeMs: 1, ino: 1 })
  x.files.set('/t/B.jsonl', { size: 10, mtimeMs: 1, ino: 2 })
  x.followed.add('A')
  await x.w.tick()
  // ★ The first tick also notifies (picks up what was written between the `hello` fetch and the first tick)
  assert.deepEqual(x.notified, ['A'], '⚠️⚠️ the first tick did not notify (misses appends right after opening)')
  x.files.set('/t/A.jsonl', { size: 20, mtimeMs: 2, ino: 1 })
  x.files.set('/t/B.jsonl', { size: 20, mtimeMs: 2, ino: 2 })
  await x.w.tick()
  assert.deepEqual(x.notified, ['A', 'A'], '⚠️⚠️ also notified B, which is not followed (leaks to devices that are not watching)')
  await x.w.tick()
  assert.deepEqual(x.notified, ['A', 'A'], '⚠️ notified although nothing changed')
})

test('★★ notifies when only the in-progress text changes (while waiting for approval the transcript does not grow)', async () => {
  const x = world()
  x.files.set('/t/A.jsonl', { size: 10, mtimeMs: 1, ino: 1 })
  x.followed.add('A')
  await x.w.tick()
  x.notified.length = 0
  x.files.set('/i/A.jsonl', { size: 5, mtimeMs: 3, ino: 9 })
  await x.w.tick()
  assert.deepEqual(x.notified, ['A'])
  x.files.delete('/i/A.jsonl')
  await x.w.tick()
  assert.deepEqual(x.notified, ['A', 'A'], '⚠️ did not notify that the in-progress text disappeared (finished writing)')
})

test('★★ a session with no transcript yet is notified once it appears / recreation (ino) is also caught', async () => {
  const x = world()
  x.followed.add('A')
  await x.w.tick()
  x.notified.length = 0
  x.files.set('/t/A.jsonl', { size: 3, mtimeMs: 1, ino: 1 })
  await x.w.tick()
  assert.deepEqual(x.notified, ['A'])
  x.files.set('/t/A.jsonl', { size: 3, mtimeMs: 1, ino: 2 })
  await x.w.tick()
  assert.deepEqual(x.notified, ['A', 'A'])
})

test('★★ remembers where the transcript was found (does not scan every folder each second) and forgets when unfollowed', async () => {
  const x = world()
  x.files.set('/t/A.jsonl', { size: 1, mtimeMs: 1, ino: 1 })
  x.followed.add('A')
  await x.w.tick()
  await x.w.tick()
  await x.w.tick()
  assert.equal(x.located(), 1, '⚠️ searching every time')
  x.followed.delete('A')
  await x.w.tick()
  x.notified.length = 0
  x.followed.add('A')
  await x.w.tick()
  // ★ Re-following notifies again as a first tick (the memory was dropped)
  assert.deepEqual(x.notified, ['A'])
})
