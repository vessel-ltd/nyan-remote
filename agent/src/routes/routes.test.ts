// ★ Pin the route registrations themselves (external review 2026-08-14, low).
//   Getting a path wrong or removing a registration left every existing test green.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../config.ts'
import { forWire, isStale } from './sessions.ts'
import { testPayload } from './push.ts'
import { test } from 'node:test'
import { buildRouter } from './index.ts'
import { sessionClear, sessionInterrupt } from './interrupt.ts'
import { sessionCommand } from './command.ts'
import { sessionAutoApprove } from './autoApprove.ts'
import { AGENT_FEATURES, health } from './health.ts'

test('★ POST /sessions/:id/message is registered and the id is decoded', () => {
  const r = buildRouter()
  const m = r.match('POST', '/sessions/S%201%2F2/message')
  assert.ok(m, 'no route (sending from the phone would 404)')
  assert.equal(m?.params['id'], 'S 1/2')
})

test('★ sending is POST only (if GET could send, it would bypass the CSRF check)', () => {
  // ⚠️ The CSRF check in auth.ts only looks at "unsafe methods". A GET with side effects slips straight through
  assert.equal(buildRouter().match('GET', '/sessions/x/message'), null)
})

test('existing main routes are still there', () => {
  const r = buildRouter()
  for (const [method, path] of [
    ['GET', '/health'],
    ['GET', '/sessions'],
    ['GET', '/sessions/x/log'],
    ['POST', '/hook'],
    ['POST', '/permission'],
    ['GET', '/permissions'],
    ['POST', '/permission/answer'],
    ['GET', '/push/status'],
    ['POST', '/push/subscribe'],
  ] as const) {
    assert.ok(r.match(method, path), `${method} ${path} is missing`)
  }
})

test('★★ testPayload: the connectivity-check notification also carries at (without it cleanup does not work)', () => {
  // ⚠️⚠️ codex 2026-08-20, high #3. A push without `at` makes the sw fall back to the device clock, so
  //    there was a risk of **an old, late-delivered list removing live notifications**.
  const payload = testPayload(new Date('2026-08-20T12:34:56.000Z'))
  assert.equal(payload.at, '2026-08-20T12:34:56.000Z')
  assert.equal(payload.tag, 'tmux-agent-test')
  // ★ No conversation content is included (§6.2)
  assert.deepEqual(Object.keys(payload).sort(), ['at', 'body', 'event', 'tag', 'title', 'url'])
})

test('★★ testPayload: with-sound / silent use different tags (the same tag shows only one, leading to misdiagnosis)', () => {
  const now = new Date('2026-08-21T12:34:56.000Z')
  const loud = testPayload(now)
  const quiet = testPayload(now, true)

  // ★ The default is with sound. The `silent` key itself is not added (the sw checks `=== true`)
  assert.equal(loud.silent, undefined)
  assert.equal(quiet.silent, true)

  // ⚠️ With the same tag the later one replaces the earlier and **only one is visible**
  assert.notEqual(loud.tag, quiet.tag)

  // ★ Which one arrived must be clear from the notification text alone (prevents mix-ups when measuring)
  assert.ok(loud.body.includes('音あり'), `cannot tell it is with sound: ${loud.body}`)
  assert.ok(quiet.body.includes('無音'), `cannot tell it is silent: ${quiet.body}`)

  // ★ No conversation content is included (§6.2)
  assert.deepEqual(Object.keys(quiet).sort(), [
    'at',
    'body',
    'event',
    'silent',
    'tag',
    'title',
    'url',
  ])
})

test('★★ forWire: the transcript path is not passed to the UI', () => {
  // ⚠️ `/code-review` 2026-08-21, low #4. It was returned as is, so **the host's absolute path
  //    was sent to the PWA every time** (`InflightMessage` does not declare it, so the type check passed too).
  const wire = forWire({
    text: '本文',
    final: true,
    at: '2026-08-21T00:00:00.000Z',
    clipped: true,
    transcriptPath: '/home/user/.claude-r/projects/-home-user-x/abc.jsonl',
  })
  assert.deepEqual(Object.keys(wire).sort(), ['at', 'clipped', 'final', 'text'])
  assert.ok(!JSON.stringify(wire).includes('/home/'))
})

test('★★ isStale: not shown when the record is newer (old text after the hook stopped)', () => {
  // ⚠️ `/code-review` 2026-08-21, medium #1. When the hook stops (escape hatch, version change, disk full),
  //    **the previous message's file remains**, and after a few messages it also drops out of matching, so
  //    **an old explanation shows above a new approval card**.
  const inflight = { text: '古い説明です。これは前のメッセージ', final: true, at: '2026-08-21T01:00:00.000Z' }
  const newer = [{ kind: 'assistant', text: 'まったく別の新しい本文', at: '2026-08-21T02:00:00.000Z' }]
  assert.equal(isStale(inflight, newer), true, 'not shown when the record is newer')
  const older = [{ kind: 'assistant', text: 'まったく別の古い本文', at: '2026-08-21T00:30:00.000Z' }]
  assert.equal(isStale(inflight, older), false, 'shown when the record is older (the intended use)')
  // Not shown if the record already contains the same thing
  assert.equal(
    isStale(inflight, [{ kind: 'assistant', text: inflight.text, at: '2026-08-21T00:30:00.000Z' }]),
    true,
  )
  // Not shown if the time cannot be parsed (fail-closed)
  assert.equal(isStale({ ...inflight, at: 'こわれている' }, older), true)
  // Shown if the record is empty (a session without a transcript)
  assert.equal(isStale(inflight, []), false)
})

test('★★★ pin the endpoint ↔ handler mapping (detect swapped wiring)', () => {
  // ⚠️⚠️ codex round 7 (2026-08-25), medium #1. Only the **existence** of paths was checked, so
  //    **a mutation swapping in** `router.post('/sessions/:id/clear', sessionInterrupt)` stayed green
  //    (= when the user presses "clear input", **ESC is sent and the response stops**).
  const r = buildRouter()
  for (const [path, handler, name] of [
    ['/sessions/x/interrupt', sessionInterrupt, 'sessionInterrupt'],
    ['/sessions/x/clear', sessionClear, 'sessionClear'],
    ['/sessions/x/command', sessionCommand, 'sessionCommand'],
    ['/sessions/x/auto-approve', sessionAutoApprove, 'sessionAutoApprove'],
  ] as const) {
    const m = r.match('POST', path)
    assert.ok(m, `${path} is missing`)
    assert.equal(m?.handler, handler, `${path} is not wired to ${name} (swapped wiring)`)
  }
  // ★ The four are **different handlers** (wiring them to the same one would be meaningless)
  assert.equal(new Set([sessionInterrupt, sessionClear, sessionCommand, sessionAutoApprove]).size, 4)
})

test('★★★ feature flags correspond to the endpoints actually registered', () => {
  // ⚠️⚠️ codex round 7 (2026-08-25), medium #3: without flags, **while updating several machines one by one**,
  //    buttons appear for agents that do not yet have the endpoint and 404 (`sendRoute` cannot serve as a flag).
  //    ⇒ Map **endpoint ↔ flag** mechanically (catch both forgetting to add and forgetting to remove).
  const r = buildRouter()
  const NEEDS: Record<string, string> = {
    'slash-commands': '/sessions/x/command',
    'clear-input': '/sessions/x/clear',
    'auto-approve': '/sessions/x/auto-approve',
    // ★ A flag for adding the duration name (`duration: '24h'`) to the same endpoint (2026-09-24 / acceptance is tested in autoApproveRoute.test.ts)
    'auto-approve-24h': '/sessions/x/auto-approve',
    // ★ The device key for ③. `/pair` is checked as the representative (the existence and methods of `/devices`, `/devices/revoke`
    //   and `/pair/token` are pinned by `routes/devicesRoute.test.ts`)
    'device-pairing': '/pair',
    'device-handshake': '/handshake',
    // ★ A GET endpoint (⚠️ the method is in the METHOD table below)
    'log-follow': '/sessions/x/follow',
  }
  const METHOD: Record<string, string> = { 'log-follow': 'GET' }
  for (const feature of AGENT_FEATURES) {
    const path = NEEDS[feature]
    assert.ok(path, `no endpoint in the table for flag ${feature} (fix this table too)`)
    assert.ok(r.match(METHOD[feature] ?? 'POST', path!), `flag ${feature} is returned but endpoint ${path} is missing`)
  }
  for (const [feature, path] of Object.entries(NEEDS)) {
    assert.ok(
      !r.match(METHOD[feature] ?? 'POST', path) || AGENT_FEATURES.includes(feature as never),
      `endpoint ${path} exists but flag ${feature} is not returned (no button appears)`,
    )
  }
})

test('★★★ /health actually returns the feature flags (checking only the constant lets the wiring be killed)', async (t) => {
  // ⚠️⚠️ codex round 8 (2026-08-25), medium #2 / mutation ①: the test above only looks at the `AGENT_FEATURES` **constant**,
  //    so a mutation where `health()` returns `features: []` stayed green (= every button disappears).
  const state = await mkdtemp(join(tmpdir(), 'nyan-remote-health-'))
  const account = await mkdtemp(join(tmpdir(), 'nyan-remote-hacct-'))
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['NYAN_REMOTE_STATE_DIR'] = state
  await mkdir(join(account, 'projects'), { recursive: true })
  await mkdir(join(account, 'sessions'), { recursive: true })
  // ⚠️ Without `hookToken` it goes into refuse mode and **looks at the real `~/.claude*`**
  await writeFile(
    join(state, 'config.json'),
    JSON.stringify({ allowedLogins: ['t@example.com'], configDirs: [account], hookToken: 'x'.repeat(40) }),
  )
  await loadConfig()
  t.after(async () => {
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    await rm(state, { recursive: true, force: true })
    await rm(account, { recursive: true, force: true })
  })
  const h = await health()
  assert.deepEqual(h.features, AGENT_FEATURES, '/health does not return the flags (no buttons appear)')
  assert.ok((h.features?.length ?? 0) > 0, 'flags are empty (the trap where 0 items is still green)')
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ `match` also returns the matched **pattern** (2026-08-31 / used for traffic measurement)
//
// ⚠️⚠️ When measurement records a path, writing `/sessions/<uuid>/log` as is
//    **leaves the session ID in the record** (against §6.2 "identifiers and state only").
//    ⇒ Normalize it to `/sessions/:id/log` before writing.
// ⚠️⚠️ **Do not hand-roll that normalization on the measurement side.** It would create the same path table in two places,
//    and they would disagree the moment an endpoint is added (CLAUDE.md "writing it in two places always diverges").
//    ⇒ **Use the pattern the router decided, as is.**
// ─────────────────────────────────────────────────────────────────────────────

test('★★ match returns the pattern (so measurement does not keep a second path table)', () => {
  const r = buildRouter()
  const m = r.match('GET', '/sessions/9f8e7d6c-1234-5678-9abc-def012345678/log')
  assert.ok(m, 'did not match')
  // ★ Look at the value the implementation returns (not a test comparing against a hand-built pattern)
  assert.equal(m.pattern, '/sessions/:id/log')
  // ⚠️ The pattern must not contain the real ID (this is the whole point)
  assert.ok(!m.pattern.includes('9f8e7d6c'), `the ID remains in the pattern: ${m.pattern}`)
})

test('★ the pattern is identical to the registered one (not rebuilt from segments)', () => {
  const r = buildRouter()
  // ⚠️ Rebuilding with `split`→`join` can differ from the original on leading or repeated slashes.
  //    ⇒ Keep the string from registration as is
  for (const [method, path, want] of [
    ['GET', '/health', '/health'],
    ['GET', '/sessions', '/sessions'],
    ['POST', '/sessions/abc/command', '/sessions/:id/command'],
    ['POST', '/sessions/abc/interrupt', '/sessions/:id/interrupt'],
    ['POST', '/permission/answer', '/permission/answer'],
  ] as const) {
    const m = r.match(method, path)
    assert.ok(m, `${method} ${path} does not match`)
    assert.equal(m.pattern, want, `${method} ${path}`)
  }
})
