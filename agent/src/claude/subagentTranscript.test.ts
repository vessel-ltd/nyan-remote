import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { directAgentTranscript, isSafeAgentId, resolveAgentTranscript } from './subagentTranscript.ts'

// ★★ What these tests protect (measured 2026-08-14):
//
//   The `transcript_path` of the `PermissionRequest` hook is the **main** transcript.
//   A subagent's `tool_use` / `tool_result` are **not written there**.
//   Get this wrong and permissionSweep can never find "approvals that resolved on their own",
//   and the quieting step (wait 6 seconds and check) becomes **the same as not checking**.

test('★ directAgentTranscript: <session>.jsonl → <session>/subagents/agent-<id>.jsonl', () => {
  assert.equal(
    directAgentTranscript('/home/u/.claude-r/projects/-home-u-app/abc-123.jsonl', 'aaea8328'),
    '/home/u/.claude-r/projects/-home-u-app/abc-123/subagents/agent-aaea8328.jsonl',
  )
})

test('★ directAgentTranscript: gives up on malformed input (does not build a path by guessing)', () => {
  assert.equal(directAgentTranscript('/home/u/projects/x/abc.txt', 'a1'), undefined, 'not .jsonl')
  // ⚠️ agent_id comes from the hook payload. Check its shape before putting it into a path
  assert.equal(directAgentTranscript('/home/u/projects/x/abc.jsonl', '../../etc'), undefined)
  assert.equal(directAgentTranscript('/home/u/projects/x/abc.jsonl', 'a/b'), undefined)
  assert.equal(isSafeAgentId('aaea832835255403b'), true)
  assert.equal(isSafeAgentId(''), false)
})

async function withTree<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-sub-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('★ resolveAgentTranscript: returns only files that actually exist', async () => {
  await withTree(async (dir) => {
    const main = join(dir, 'sess-1.jsonl')
    await writeFile(main, '{}\n')
    // Not there yet
    assert.equal(await resolveAgentTranscript(main, 'a1'), undefined)

    const subs = join(dir, 'sess-1', 'subagents')
    await mkdir(subs, { recursive: true })
    const file = join(subs, 'agent-a1.jsonl')
    await writeFile(file, '{}\n')
    assert.equal(await resolveAgentTranscript(main, 'a1'), file)
  })
})

test('resolveAgentTranscript: also finds nested subagents (one level only)', async () => {
  await withTree(async (dir) => {
    const main = join(dir, 'sess-2.jsonl')
    await writeFile(main, '{}\n')
    const nested = join(dir, 'sess-2', 'subagents', 'deep')
    await mkdir(nested, { recursive: true })
    const file = join(nested, 'agent-b2.jsonl')
    await writeFile(file, '{}\n')
    assert.equal(await resolveAgentTranscript(main, 'b2'), file)
  })
})

test('resolveAgentTranscript: does nothing without agent_id (falls back to reading the main one)', async () => {
  assert.equal(await resolveAgentTranscript('/x/y.jsonl', undefined), undefined)
  assert.equal(await resolveAgentTranscript(undefined, 'a1'), undefined)
})

test('★ isSafeAgentId: accepts the teammate form (name@session-xxx) and rejects path separators', () => {
  // ★ Background teammates take the form `code-review@session-960cbcc3`
  //   (members[].agentId in ~/.claude*/teams/<session>/config.json / measured 2026-08-16)
  assert.equal(isSafeAgentId('code-review@session-960cbcc3'), true)
  assert.equal(isSafeAgentId('aaea832835255403b'), true)
  // ⚠️ The value goes into a path, so separators and parent directories must never pass
  assert.equal(isSafeAgentId('../../etc/passwd'), false)
  assert.equal(isSafeAgentId('a/b'), false)
  assert.equal(isSafeAgentId('a.b'), false, 'allowing . lets .. be formed')
})
