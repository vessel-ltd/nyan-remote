import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile, appendFile, symlink } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextCache, contextFromTail, isRolloutPath, readContextTokens, readTailText } from './context.ts'

// The shape measured in a 0.169.0 rollout (numbers changed)
function tokenCount(last: unknown, info: 'ok' | 'null' = 'ok'): string {
  return JSON.stringify({
    timestamp: '2026-11-16T14:47:49.806Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info:
        info === 'null'
          ? null
          : {
              total_token_usage: { input_tokens: 900000, output_tokens: 5000, total_tokens: 905000 },
              last_token_usage: { input_tokens: 40000, output_tokens: 1000, total_tokens: last },
              model_context_window: 258400,
            },
      rate_limits: { primary: { used_percent: 51 } },
    },
  })
}
const message = (text: string) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } })

const lines = (...ls: string[]) => `${ls.join('\n')}\n`

test('readTailText: the newest token_count, as last_token_usage (not the running total)', () => {
  assert.equal(contextFromTail(lines(tokenCount(1000), message('a'), tokenCount(41000), message('b'))), 41000)
})

test('readTailText: an event with only rate limits (info null) is passed over', () => {
  assert.equal(contextFromTail(lines(tokenCount(41000), tokenCount(0, 'null'))), 41000)
})

test('readTailText: an unreadable newest count stops — never the older number behind it', () => {
  const stale = (newest: string) => readTailText(lines(tokenCount(41000), newest), false)
  assert.deepEqual(stale(tokenCount('41000')), { type: 'stop' })
  assert.deepEqual(stale(tokenCount(-1)), { type: 'stop' })
  assert.deepEqual(stale(tokenCount(1.5)), { type: 'stop' })
  assert.deepEqual(stale(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {} } })), { type: 'stop' })
  // A complete line that is a broken count record
  assert.deepEqual(stale(tokenCount(9).slice(0, -5)), { type: 'stop' })
})

test('readTailText: the unfinished last record and a cut first line are not read', () => {
  // Still being written (no newline yet) ⇒ the complete count before it
  assert.equal(contextFromTail(`${lines(tokenCount(41000))}${tokenCount(9).slice(0, -5)}`), 41000)
  // The tail starts mid-record
  assert.deepEqual(readTailText(lines(tokenCount(7).slice(20), message('x')), true), { type: 'none' })
  assert.deepEqual(readTailText(lines(tokenCount(7), message('x')), false), { type: 'count', tokens: 7 })
})

test('readTailText: nothing readable ⇒ undefined, never 0', () => {
  assert.equal(contextFromTail(''), undefined)
  assert.equal(contextFromTail(lines(message('no counts here'))), undefined)
  // A message that only mentions the word is not a count
  assert.equal(contextFromTail(lines(message('"token_count" total_tokens 5'))), undefined)
})

test('isRolloutPath: absolute .jsonl only', () => {
  assert.equal(isRolloutPath('/home/user/.codex/sessions/x.jsonl'), true)
  assert.equal(isRolloutPath('x.jsonl'), false)
  assert.equal(isRolloutPath('/home/user/.codex/config.toml'), false)
  assert.equal(isRolloutPath('/a\0.jsonl'), false)
})

test('readContextTokens: reads only the tail, and goes to 1 MB when a big output fills the end', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-ctx-'))
  try {
    const path = join(dir, 'rollout.jsonl')
    await writeFile(path, `${tokenCount(12345)}\n${message('x'.repeat(200 * 1024))}\n`)
    assert.equal((await readContextTokens(path))?.tokens, 12345)
    await appendFile(path, `${tokenCount(23456)}\n`)
    assert.equal((await readContextTokens(path))?.tokens, 23456)
    // Beyond 1 MB of output after the count ⇒ unknown
    await appendFile(path, `${message('y'.repeat(1100 * 1024))}\n`)
    assert.equal((await readContextTokens(path))?.tokens, undefined)
    assert.equal(await readContextTokens(join(dir, 'missing.jsonl')), undefined)
    assert.equal(await readContextTokens(dir), undefined)
    // An unreadable newest count beyond 64 KB of output stops the larger read too
    const stop = join(dir, 'stop.jsonl')
    await writeFile(stop, lines(tokenCount(500), tokenCount('x'), message('z'.repeat(100 * 1024))))
    assert.equal((await readContextTokens(stop))?.tokens, undefined)
    // Never through a symlink, never a FIFO (an open would block the list)
    const link = join(dir, 'link.jsonl')
    await symlink(path, link)
    assert.equal(await readContextTokens(link), undefined)
    const fifo = join(dir, 'fifo.jsonl')
    execFileSync('mkfifo', [fifo])
    assert.equal(await readContextTokens(fifo), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ContextCache: reads again only when size or time changed, and forgets paths not asked about', async () => {
  let reads = 0
  let size = 10
  const cache = new ContextCache(
    async () => {
      reads++
      return { size, mtimeMs: 1, tokens: size * 100 }
    },
    async () => ({ size, mtimeMs: 1 }),
  )
  const p = '/home/user/.codex/sessions/a.jsonl'
  assert.equal((await cache.lookup([p])).get(p), 1000)
  assert.equal((await cache.lookup([p])).get(p), 1000)
  assert.equal(reads, 1)
  size = 20
  assert.equal((await cache.lookup([p])).get(p), 2000)
  assert.equal(reads, 2)
  await cache.lookup([])
  await cache.lookup([p])
  assert.equal(reads, 3, 'a forgotten path is read again')
  assert.equal((await cache.lookup(['relative.jsonl'])).size, 0)
})
