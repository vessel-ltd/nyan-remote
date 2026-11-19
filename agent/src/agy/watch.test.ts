import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startAgyWatch } from './watch.ts'

const A = '062a8f25-9451-42f3-ae93-34a208e99365'
const file = (state: string, ctx = 1) =>
  JSON.stringify({ nyanPid: 4242, nyanBusyAt: 0, input: { conversation_id: A, cwd: '/home/user/w', agent_state: state, context_window: { used_percentage: ctx } } })
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('watch: a state change says "changed" once; a context-only rewrite stays quiet', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-agy-watch-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, `session-${A}.json`), file('idle'))
  let n = 0
  const w = await startAgyWatch(dir, () => n++)
  t.after(() => w.close())
  writeFileSync(join(dir, `session-${A}.json`), file('working'))
  await wait(800)
  assert.equal(n, 1)
  writeFileSync(join(dir, `session-${A}.json`), file('working', 9))
  await wait(800)
  assert.equal(n, 1, 'context alone is not a list change')
  writeFileSync(join(dir, `session-${A}.json`), file('idle', 9))
  await wait(800)
  assert.equal(n, 2)
})

test('watch: steady writes (two conversations in turn) still say "changed" without waiting for them to stop', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-agy-watch2-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const B = '6c0298e8-77c4-406c-aa97-cbecdfd19c88'
  const other = (ctx: number) => file('working', ctx).replaceAll(A, B)
  writeFileSync(join(dir, `session-${A}.json`), file('idle'))
  writeFileSync(join(dir, `session-${B}.json`), other(0))
  let n = 0
  const w = await startAgyWatch(dir, () => n++)
  t.after(() => w.close())
  writeFileSync(join(dir, `session-${A}.json`), file('working'))
  for (let i = 1; i <= 10; i++) {
    await wait(100)
    writeFileSync(join(dir, `session-${B}.json`), other(i))
  }
  assert.ok(n >= 1, 'the change was said while writes went on')
})
