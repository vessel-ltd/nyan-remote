// Checks auto-approve mode **through the actual endpoint and hook path**.
//
// ⚠️⚠️ Unit tests of `shouldAutoApprove` (`agent/src/autoApprove.test.ts`) are not enough.
//    "The decision is right but not wired in" and "auto-allow **after** raising the marker (= only the notification fires)"
//    both stay green in unit tests (VERIFY.md "false green").
//
// ★★ Mutations explicitly targeted here:
//   ① remove the auto-approve branch from `permissionRequest` (it stops even when on)
//   ② move the branch **after** `waitForDecision` (the marker is raised and the notification fires before allowing)
//   ③ change `decisionResponse({behavior:'allow'})` to `{}` (defers to the PC = has no effect)
//   ④ auto-allow even choice questions and plan approvals
//   ⑤ skip cleaning up the "要対応" (needs attention) label
//   ⑥ the endpoint does not treat `on` as a boolean (turns `'false'` into "on")
//   ⑦ do not add the list marker
//   ⑧ ★ **hide the marker based on `live`** (codex 2026-09-07, high #3. Just failing to read the index
//      makes it `live:false`, but the allow decision does not look at the index, so **it keeps passing** =
//      "it passes, yet the banner and the off button disappear")

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import type { SessionSummary } from '../../../shared/types.ts'
import { autoApproveFor, resetAutoApprove, setAutoApprove } from '../autoApprove.ts'
import { hooksFor, noteHook } from '../claude/hookState.ts'
import { listPending, resetPending } from '../permission.ts'
import { HttpError, type Ctx } from '../router.ts'
import { sessionAutoApprove } from './autoApprove.ts'
import { permissionRequest } from './permission.ts'
import { hook } from './hook.ts'
import { markAutoApprove } from './sessions.ts'

const SESSION = '960cbcc3-0c6e-435d-b024-1867c146dfa8'
const TRANSCRIPT = `/home/x/.claude-r/projects/-home-x-proj/${SESSION}.jsonl`

const SRC = fileURLToPath(new URL('./permission.ts', import.meta.url))

async function withState(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-aaroute-'))
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = dir
  resetAutoApprove()
  resetPending()
  t.after(async () => {
    resetAutoApprove()
    resetPending()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

/** A Ctx that mimics a hook call. ★ `close` simulates "the connection dropped" */
function hookCtx(payload: Record<string, unknown>): { ctx: Ctx; close: () => void } {
  const req = Readable.from([
    Buffer.from(JSON.stringify(payload), 'utf8'),
  ]) as unknown as IncomingMessage
  Object.assign(req, { headers: { 'content-type': 'application/json' } })
  const res = { once: () => undefined } as unknown as ServerResponse
  return {
    ctx: {
      req,
      res,
      url: new URL('http://agent/permission'),
      params: {},
      identity: { login: 'test@example.com', deviceId: '100.0.0.1', via: 'dev' },
    },
    close: () => req.emit('close'),
  }
}

/**
 * ★★ **Always put a deadline on waiting for a return.**
 *
 * ⚠️⚠️ With a mutation that disables auto-approve (removing the branch, etc.), the hook is designed to **wait 24 hours**,
 *    so `await permissionRequest(...)` **never returns and the test hangs** (= the mutation does not "fail" but
 *    "never finishes", so mutation testing itself stalls. Actually hit on 2026-09-07).
 */
async function settled(p: Promise<unknown>, ms = 500): Promise<unknown> {
  const stuck = Symbol('stuck')
  const out = await Promise.race([p, new Promise((r) => setTimeout(() => r(stuck), ms))])
  assert.notEqual(out, stuck, `⚠️ it waited (auto-approve is not working / ${ms}ms)`)
  return out
}

/**
 * ★★ Check "it is waiting" **by state** (do not wait with a fixed `setTimeout`).
 *
 * ⚠️⚠️ It used to be `await new Promise((r) => setTimeout(r, 20))`. The marker is registered
 *    after reading the body (a stream), so **under load from running tests in parallel** it
 *    missed the 20ms and **occasionally failed** (failed once in a full run on 2026-09-07 and could not be reproduced).
 *    ⇒ Drop the timing assumption and **wait until the condition holds** (fail if it never does).
 */
async function waitPending(count: number, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    if (listPending().length === count) return
    if (Date.now() > deadline) {
      assert.equal(listPending().length, count, `after waiting ${ms}ms the markers did not reach ${count}`)
      return
    }
    await new Promise((r) => setTimeout(r, 5))
  }
}

const bashPayload = {
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf /tmp/x' },
  transcript_path: TRANSCRIPT,
  session_id: SESSION,
  cwd: '/home/x/proj',
}

test('★★★ when on, a yes/no approval gets allow immediately (no marker raised either)', async (t) => {
  await withState(t)
  await setAutoApprove(SESSION, true)

  const { ctx } = hookCtx(bashPayload)
  // ① ③ Look at **the JSON the implementation returns** (not a test that passes a hand-built Decision)
  const out = await settled(permissionRequest(ctx))
  assert.deepEqual(out, {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  })
  // ② Not a single marker raised = neither the notification (`announce`) nor the silence timer ran
  assert.deepEqual(listPending(), [], 'a marker was raised (the shape where only the notification fires)')
})

test('★★★ the auto-approve branch comes before `waitForDecision` (so no notification fires)', async () => {
  // ② Swapping the order **returns the same value**, so the test above alone cannot kill it.
  //    ⚠️ Answering after raising the marker runs `announce`, and **a notification for an already-answered approval** fires
  const code = await readFile(SRC, 'utf8')
  const auto = code.indexOf('if (shouldAutoApprove(info))')
  const wait = code.indexOf('const waiting = waitForDecision(')
  assert.ok(auto > 0, 'no auto-approve branch')
  assert.ok(wait > 0, 'no call to waitForDecision')
  assert.ok(auto < wait, '⚠️⚠️ auto-approve comes after registering the marker (a notification fires)')
})

test('★★★ even when on, choice questions and plan approvals stop (deferred to the PC)', async (t) => {
  await withState(t)
  await setAutoApprove(SESSION, true)

  for (const [name, input] of [
    [
      'AskUserQuestion',
      { questions: [{ question: 'どれ？', options: [{ label: 'A' }, { label: 'B' }] }] },
    ],
    ['ExitPlanMode', { plan: 'これで進める' }],
    // ⚠️ A broken `AskUserQuestion` (no `interaction` can be built) is also stopped by name
    ['AskUserQuestion', { questions: 'こわれている' }],
  ] as const) {
    const { ctx, close } = hookCtx({ ...bashPayload, tool_name: name, tool_input: input })
    const p = permissionRequest(ctx)
    // ★ Waiting = a marker is raised (answerable from the phone)
    await waitPending(1)
    // When the connection drops, "no decision" = back to the PC's normal flow
    close()
    assert.deepEqual(await p, {}, `returns a decision for ${name}`)
    resetPending()
  }
})

test('★★ a session that is off waits as before', async (t) => {
  await withState(t)
  // The one turned on is a **different** session (confirming per-session scope through the path)
  await setAutoApprove('e2e96878-1111-2222-3333-444455556666', true)

  const { ctx, close } = hookCtx(bashPayload)
  const p = permissionRequest(ctx)
  await waitPending(1)
  close()
  assert.deepEqual(await p, {})
})

test('★★ the endpoint accepts `on` only as a boolean', async (t) => {
  await withState(t)
  const call = (body: unknown): Promise<unknown> => {
    const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]) as unknown as IncomingMessage
    Object.assign(req, { headers: { 'content-type': 'application/json' } })
    return sessionAutoApprove({
      req,
      res: {} as ServerResponse,
      url: new URL(`http://agent/sessions/${SESSION}/auto-approve`),
      params: { id: SESSION },
      identity: { login: 'test@example.com', deviceId: '100.0.0.1', via: 'dev' },
    })
  }
  // ⑥ ⚠️⚠️ Silently interpreting strings or numbers does **the opposite of what the user meant**
  for (const bad of [{ on: 'false' }, { on: 'true' }, { on: 1 }, { on: 0 }, {}, { on: null }]) {
    await assert.rejects(() => call(bad), (err: unknown) => err instanceof HttpError && err.status === 400, `accepts ${JSON.stringify(bad)}`)
  }
  // ★ A real toggle goes through and returns the expiry (absolute time)
  const on = (await call({ on: true })) as { ok: boolean; until?: string; saved?: boolean }
  assert.equal(on.ok, true)
  assert.ok(on.until && Number.isFinite(Date.parse(on.until)), `no expiry returned: ${on.until}`)
  assert.equal(on.saved, true)
  // ★ That this endpoint actually changes state (checked on the hook side = confirms the wiring)
  const { ctx } = hookCtx(bashPayload)
  assert.deepEqual(await settled(permissionRequest(ctx)), {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  })
  const off = (await call({ on: false })) as { ok: boolean; until?: string }
  assert.equal(off.ok, true)
  assert.equal(off.until, undefined, 'attaches an expiry to off')
  const again = hookCtx(bashPayload)
  const p = permissionRequest(again.ctx)
  await waitPending(1)
  again.close()
  await p

  // ★★ The duration is chosen by **name** (2026-09-24). Absent means 3 hours (old UI); 24h means 24 hours
  const HOUR = 60 * 60 * 1000
  const near = (until: string | undefined, ms: number): boolean =>
    until !== undefined && Math.abs(Date.parse(until) - (Date.now() + ms)) < 60_000
  const three = (await call({ on: true })) as { until?: string }
  assert.ok(near(three.until, 3 * HOUR), `⚠️ not 3 hours although no name was given: ${three.until}`)
  const day = (await call({ on: true, duration: '24h' })) as { until?: string }
  assert.ok(near(day.until, 24 * HOUR), `⚠️ 24h but not 24 hours: ${day.until}`)
  // ⚠️⚠️ Unknown names and raw lengths are 400 (never silently 3 hours = never disagree with what the UI says)
  for (const bad of [{ on: true, duration: '72h' }, { on: true, duration: 86_400_000 }, { on: true, duration: null }]) {
    await assert.rejects(() => call(bad), (err: unknown) => err instanceof HttpError && err.status === 400, `accepts ${JSON.stringify(bad)}`)
  }
  await call({ on: false })
})

test('★★★ no "needs attention" marker remains after an auto-allow', async (t) => {
  await withState(t)
  await setAutoApprove(SESSION, true)

  // ⑤ ⚠️⚠️ The "要対応" (needs attention) from `hooks.permission` has only two ways out:
  //    **the latest activity overtakes it**, or **the sweep finds the result**.
  //    This is the shape that stayed **"needs attention" for 21 minutes** on 2026-08-21 (`claude/sessions.ts`).
  //    ⇒ Clear it on the auto-allow path too (it used to be cleared only when `decision === undefined`).
  noteHook({
    event: 'Notification',
    notice: 'permission',
    machine: 'pc-a',
    account: '.claude-r',
    project: 'proj',
    sessionId: SESSION,
    at: new Date().toISOString(),
  })
  assert.ok(hooksFor(SESSION)?.permission, 'precondition: the pending-approval evidence is raised')

  const { ctx } = hookCtx(bashPayload)
  await settled(permissionRequest(ctx))
  assert.equal(hooksFor(SESSION)?.permission, undefined, '⚠️ "needs attention" remains although there is nothing to answer')
})

test('★★★ the list marker is not hidden by `live` (vanishing just because the index is unreadable means it passes but cannot be turned off)', async (t) => {
  await withState(t)
  const now = Date.now()
  await setAutoApprove(SESSION, true, now)
  await setAutoApprove('dead-session', true, now)

  const rows: SessionSummary[] = [
    row({ sessionId: SESSION, live: true }),
    row({ sessionId: 'dead-session', live: false }),
    row({ sessionId: 'other', live: true }),
  ]
  const marked = markAutoApprove(rows, now)
  // ⑦ Check both that the marker is added and that it is not
  assert.ok(marked[0]!.autoApprove, 'no marker (cannot be shown on screen)')
  assert.equal(Date.parse(marked[0]!.autoApprove!.until) > now, true)
  // ⑧ ⚠️⚠️ **Add it even when `live:false`.** Just because `sessions/<pid>.json` is mid-write, corrupt or unreadable due to permissions,
  //    the row becomes `live:false`, but **the allow decision does not look at the index**, so it keeps passing.
  //    ⇒ Hiding it here means "it passes, yet the banner and the off button disappear" (codex high #3)
  assert.ok(
    marked[1]!.autoApprove,
    '⚠️ the marker disappears for a session treated as not alive (it passes but cannot be turned off)',
  )
  assert.equal(marked[2]!.autoApprove, undefined, 'adds a marker to a session that was not turned on')
  // It disappears after the expiry (decided in one place, `autoApproveFor`)
  assert.equal(markAutoApprove(rows, now + 4 * 60 * 60 * 1000)[0]!.autoApprove, undefined)
})

function row(over: Partial<SessionSummary>): SessionSummary {
  return {
    machine: 'pc-a',
    account: '.claude-r',
    sessionId: 'x',
    cwd: '/home/x/proj',
    project: 'proj',
    title: 'proj',
    titleSource: 'fallback',
    status: 'idle',
    live: true,
    lastActivity: '2026-09-07T00:00:00.000Z',
    transcriptBytes: 0,
    ...over,
  }
}

test('★★ SessionEnd (/exit) turns that session\'s auto-approve off; a turn\'s Stop does not (2026-09-26 / user report)', async (t) => {
  await withState(t)
  assert.equal((await setAutoApprove(SESSION, true)).ok, true)
  // ⚠️ A turn ending is not the session ending: auto-approve must survive Stop
  await hook(hookCtx({ hook_event_name: 'Stop', transcript_path: TRANSCRIPT, cwd: '/home/x/proj' }).ctx)
  assert.ok(autoApproveFor(SESSION), '⚠️⚠️ a turn\'s end switched auto-approve off')
  // ★ The session ended ⇒ off (otherwise the phone kept a row for the ended session until expiry)
  await hook(hookCtx({ hook_event_name: 'SessionEnd', transcript_path: TRANSCRIPT, cwd: '/home/x/proj', reason: 'prompt_input_exit' }).ctx)
  assert.equal(autoApproveFor(SESSION), undefined, '⚠️⚠️ auto-approve survived the session\'s end')
})
