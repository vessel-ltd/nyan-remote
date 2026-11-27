// ★★ Rate-limit detection for Claude (2026-11-26). Measured on Claude Code 2.1.332: when a plan limit stops a turn, the
//   `StopFailure` hook carries `error: "rate_limit"` and `last_assistant_message: "You've hit your 5-hour limit · resets …"`,
//   at the same instant as the `isApiErrorMessage` line in the transcript. The agent keeps the category only.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { isClaudeLimitStop, statusLabel, type HookEvent } from '../../../shared/types.ts'
import { hooksFor, seedHookState } from '../claude/hookState.ts'
import { resolveStatus } from '../claude/sessions.ts'
import type { Ctx } from '../router.ts'
import { usageHistory } from '../usageHistory.ts'
import { hook, labelFor, settledLabel, toPushPayload } from './hook.ts'

const SESSION = '5b1c0e8e-7c2f-4a51-9d3e-2f6a1c0b9e44'
const TRANSCRIPT = `/home/x/.claude-r/projects/-home-x-proj/${SESSION}.jsonl`
const LIMIT_TEXT = "You've hit your 5-hour limit · resets 7:40am (Asia/Tokyo)"

async function withState(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-ratelimit-'))
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = dir
  t.after(async () => {
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

function hookCtx(payload: Record<string, unknown>): Ctx {
  const req = Readable.from([Buffer.from(JSON.stringify(payload), 'utf8')]) as unknown as IncomingMessage
  Object.assign(req, { headers: { 'content-type': 'application/json' } })
  return {
    req,
    res: { once: () => undefined } as unknown as ServerResponse,
    url: new URL('http://agent/hook'),
    params: {},
    identity: { login: 'test@example.com', deviceId: '100.0.0.1', via: 'dev' },
  }
}

const stopFailure = (error: string, message = LIMIT_TEXT) => ({
  hook_event_name: 'StopFailure',
  transcript_path: TRANSCRIPT,
  session_id: SESSION,
  cwd: '/home/x/proj',
  error,
  error_details: 'details',
  last_assistant_message: message,
})

test('★★ StopFailure with error "rate_limit" ⇒ the list says rate-limited and the record keeps the category, never the message', async (t) => {
  const dir = await withState(t)
  await hook(hookCtx(stopFailure('rate_limit')))
  const h = hooksFor(SESSION)
  assert.equal(h?.stop?.event, 'StopFailure')
  assert.equal(h?.stop?.limited, true, '⚠️⚠️ the limit was not remembered')
  assert.equal(resolveStatus('idle', true, h, h!.stop!.at).status, 'rate-limited')
  const log = await readFile(join(dir, 'hooks.jsonl'), 'utf8')
  const last = JSON.parse(log.trim().split('\n').at(-1)!) as HookEvent
  assert.equal(last.failure, 'rate-limit')
  assert.doesNotMatch(log, /hit your|resets|details/, '⚠️⚠️ the message reached the record (§6.2)')
  // ★ The usage history counts a stop once per turn (the same turn told again is not a second one), without the session id
  await hook(hookCtx({ ...stopFailure('rate_limit'), prompt_id: 'p1' }))
  await hook(hookCtx({ ...stopFailure('rate_limit'), prompt_id: 'p1' }))
  await hook(hookCtx({ ...stopFailure('rate_limit'), prompt_id: 'p2' }))
  await hook(hookCtx(stopFailure('server_error')))
  await usageHistory().settled()
  const hist = await readFile(join(dir, 'usage-history.jsonl'), 'utf8')
  assert.doesNotMatch(hist, new RegExp(SESSION), '⚠️ the session id reached the history')
  // the first (no prompt id) + p1 + p2; the server error is not a limit
  assert.equal(usageHistory().summary().logins[0]?.limitStops.count, 3)
  // ★ An empty prompt id is no id: the minute decides, as when it is absent (the same minute = the same stop)
  const minute = new Date().toISOString().slice(0, 16)
  await hook(hookCtx({ ...stopFailure('rate_limit'), session_id: SESSION, prompt_id: '' }))
  await hook(hookCtx(stopFailure('rate_limit')))
  await usageHistory().settled()
  // (the test's first stop, also without an id, was in this minute too: all three are one stop)
  if (new Date().toISOString().slice(0, 16) === minute) assert.equal(usageHistory().summary().logins[0]?.limitStops.count, 3, 'the same minute is one stop')
})

test('★★ any other StopFailure stays "failed" (only rate_limit is a limit)', async (t) => {
  await withState(t)
  for (const [error, message] of [
    ['authentication_failed', 'API Error: something'],
    ['server_error', 'API Error: something'],
    ['RATE_LIMIT', LIMIT_TEXT],
    // ⚠️⚠️ A temporary server 429 has the same error but is not a plan limit (Claude Code's own wording)
    ['rate_limit', 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited'],
    ['rate_limit', 'Opus is experiencing high load. Switch to Sonnet.'],
    ['rate_limit', 'API Error: Request rejected (429) · Too many requests, retry in 10 seconds'],
    ['unknown', 'API Error: something else'],
  ] as const) {
    await hook(hookCtx(stopFailure(error, message)))
    const h = hooksFor(SESSION)
    assert.equal(h?.stop?.limited, undefined, `⚠️ ${error} / ${message} was read as a limit`)
    assert.equal(resolveStatus('idle', true, h, h!.stop!.at).status, 'error')
  }
  // A limit after a failure, then a failure after the limit: the latest decides
  await hook(hookCtx(stopFailure('rate_limit')))
  assert.equal(hooksFor(SESSION)?.stop?.limited, true)
  await hook(hookCtx(stopFailure('server_error')))
  assert.equal(hooksFor(SESSION)?.stop?.limited, undefined, '⚠️ a later failure still showed the old limit')
})

test('★★ the notification says "制限中" (rate-limited), the same word as the list, and rings', () => {
  const base: HookEvent = { event: 'StopFailure', machine: 'pc-a', account: '.claude-r', project: 'proj', sessionId: SESSION, at: '2026-11-26T10:00:00.000Z' }
  const limited: HookEvent = { ...base, failure: 'rate-limit' }
  assert.equal(labelFor('StopFailure', 'rate-limit'), statusLabel('rate-limited'))
  assert.equal(settledLabel(limited, { kind: 'unknown' }, { hooks: undefined, hasPendingApproval: false }), '制限中')
  assert.equal(settledLabel(base, { kind: 'unknown' }, { hooks: undefined, hasPendingApproval: false }), '⚠ 異常終了')
  assert.match(toPushPayload(limited).body, /制限中|Rate-limited/)
  // ★ Every other rate_limit stop counts (Claude Code marks the one that is not a limit)
  for (const m of ["You've reached your weekly limit", "You're out of usage credits", 'Usage is paused for your organization.', 'Fable 5 requires usage credits.', '', undefined]) {
    assert.equal(isClaudeLimitStop('rate_limit', m), true, m)
  }
  assert.equal(isClaudeLimitStop('unknown', 'API Error: Usage credits ran out before the response was finished.'), true)
  // ★ A prompt typed right after the limit is a new turn: busy with newer activity ⇒ working (not stuck on rate-limited)
  const at = '2026-11-26T10:00:00.000Z'
  const lim = { stop: { event: 'StopFailure' as const, at, limited: true as const } }
  assert.equal(resolveStatus('busy', true, lim, '2026-11-26T10:00:02.001Z').status, 'working', '⚠️⚠️ a quick retry stayed rate-limited')
  assert.equal(resolveStatus('waiting', true, lim, '2026-11-26T10:00:02.001Z').status, 'waiting', '⚠️⚠️ a retry waiting for approval stayed rate-limited')
  // ⚠️ The failure's own transcript line (~0.5 s after the hook, measured) is not a new turn
  assert.equal(resolveStatus('busy', true, lim, '2026-11-26T10:00:00.486Z').status, 'rate-limited', '⚠️⚠️ the failure line itself read as a retry')
  assert.equal(resolveStatus('busy', true, lim, '2026-11-26T10:00:02.000Z').status, 'rate-limited')
  // ⚠️ A retry that went quiet again (cancelled before another write) is not "failed" either
  assert.equal(resolveStatus('idle', true, lim, '2026-11-26T10:00:02.500Z').status, 'idle', '⚠️⚠️ the old limit came back as failed')
  // ⚠️ A plain failure keeps its old rule (unchanged)
  assert.equal(resolveStatus('busy', true, { stop: { event: 'StopFailure' as const, at } }, '2026-11-26T10:00:01.000Z').status, 'error')
  // A later reply clears it (same rule as a failure)
  const h = { stop: { event: 'StopFailure' as const, at: base.at, limited: true as const } }
  assert.equal(resolveStatus('busy', true, h, '2026-11-26T11:00:00.000Z').status, 'working')
})

test('★ restarting the agent keeps "rate-limited" (restored from hooks.jsonl; only the exact category counts)', async (t) => {
  const dir = await withState(t)
  const other = '0e7f9b1a-3c44-4d2e-8a51-6b2c9d0f1e77'
  const at = '2026-11-26T10:00:00.000Z'
  const line = (sessionId: string, failure: unknown) => JSON.stringify({ event: 'StopFailure', machine: 'pc-a', account: '.claude-r', project: 'p', sessionId, at, failure })
  await writeFile(join(dir, 'hooks.jsonl'), `${line(SESSION, 'rate-limit')}\n${line(other, 'something-else')}\n`)
  await seedHookState()
  assert.equal(hooksFor(SESSION)?.stop?.limited, true, '⚠️ a restart forgot the limit')
  assert.equal(hooksFor(other)?.stop?.limited, undefined)
})
