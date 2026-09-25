import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { permissionTag } from '../../shared/types.ts'
import {
  answer,
  baseKey,
  decisionResponse,
  withGeneration,
  describeSuggestions,
  suggestionItems,
  abandon,
  fingerprint,
  hasPendingForSession,
  holdQuiet,
  keyOf,
  listPending,
  promoteQuiet,
  quietCount,
  resetPending,
  summarize,
  detailOf,
  waitForDecision,
  withPendingPerms,
  pendingPermTags,
  PUSH_PAYLOAD_SAFE_BYTES,
} from './permission.ts'

import type { PermissionRequest } from '../../shared/types.ts'

const info = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  key: 'k1',
  machine: 'PC-A',
  account: '.claude-r',
  project: 'tmux-agent',
  toolName: 'Bash',
  summary: 'touch x',
  at: '2026-08-12T09:00:00.000Z',
  ...over,
})

/** Captures registerAbort so "the connection closed" can be triggered later */
function capture(): { register: (cb: () => void) => void; abort: () => void } {
  let stored: (() => void) | undefined
  return {
    register: (cb) => {
      stored = cb
    },
    abort: () => stored?.(),
  }
}

// ── The contract of the JSON returned to the hook (★ if this breaks, it breaks silently) ──────────────────
//
// ⚠️ A shape that could only be pinned down by measurement. The docs described a different shape three times in a row.
//    Pinned on 2026-08-12 by reading the Claude Code 2.1.228 binary directly.
//    If a Claude Code update changes this shape, this test catches it.

test('★★ decisionResponse(allow): exactly matches the shape confirmed by measurement', () => {
  // this string is "confirmed on a real device to work when sent as is". Do not rewrite it
  assert.equal(
    JSON.stringify(decisionResponse({ behavior: 'allow' })),
    '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}',
  )
})

test('★★ decisionResponse(deny): only behavior changes', () => {
  assert.equal(
    JSON.stringify(decisionResponse({ behavior: 'deny' })),
    '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}',
  )
})

test('★ decisionResponse(undefined): an empty object = left to the PC\'s normal flow', () => {
  // ⚠️ never return deny here. Timeouts and already-handled-on-PC would become "deny"
  assert.equal(JSON.stringify(decisionResponse(undefined)), '{}')
})

test('★ decisionResponse: does not contain easily confused aliases', () => {
  // the shape the docs described. If mixed in, the CLI does not read it as a decision
  const json = JSON.stringify(decisionResponse({ behavior: 'allow' }))
  assert.ok(!json.includes('permissionDecision'), `permissionDecision is wrong: ${json}`)
  // getting the container name wrong is common too (hookOutput / hook_specific_output etc.)
  assert.ok(json.includes('"hookSpecificOutput"'))
  assert.ok(json.includes('"hookEventName":"PermissionRequest"'))
})

// ── Key uniqueness (★ 2026-08-13; the cause of "some approvals never show on the phone") ──────────
//
// Facts confirmed on a real device:
//   - the `PermissionRequest` payload **has no `tool_use_id`**
//   - `prompt_id` is **one per user turn** (a different tool approval 9 minutes apart had the same value)
// → Using prompt_id as the key makes approvals lined up in the same turn the same card, and
//   the older one is folded with "no decision" and **only shows on the PC**.

test('★★ keyOf: a different tool or arguments give a different key even in the same turn (same prompt_id)', () => {
  const pr = 'e508741a-3d3c-42c3-b0e7-f962da481817'
  const a = keyOf({ promptId: pr, toolName: 'Bash', toolInput: { command: 'npm test' } })
  const b = keyOf({ promptId: pr, toolName: 'Bash', toolInput: { command: 'git push' } })
  const c = keyOf({ promptId: pr, toolName: 'Write', toolInput: { file_path: '/tmp/x' } })
  assert.notEqual(a, b)
  assert.notEqual(a, c)
  assert.notEqual(b, c)
  // prompt_id is kept (so which turn the approval belongs to remains visible)
  assert.ok(a.startsWith(`${pr}:`))
})

test('★★ keyOf: the same call always gives the same key (hook re-entry does not show it twice)', () => {
  const p = { promptId: 'pr', toolName: 'Bash', toolInput: { command: 'ls', timeout: 5 } }
  assert.equal(keyOf(p), keyOf({ ...p }))
  // ⚠️ must be the same even if argument key order changes (JSON.stringify order is not guaranteed)
  assert.equal(
    keyOf({ promptId: 'pr', toolName: 'Bash', toolInput: { command: 'ls', timeout: 5 } }),
    keyOf({ promptId: 'pr', toolName: 'Bash', toolInput: { timeout: 5, command: 'ls' } }),
  )
  // nested too
  assert.equal(
    keyOf({ promptId: 'p', toolName: 'T', toolInput: { a: { x: 1, y: [1, 2] } } }),
    keyOf({ promptId: 'p', toolName: 'T', toolInput: { a: { y: [1, 2], x: 1 } } }),
  )
})

test('★ keyOf: without prompt_id, sessionId + fingerprint (separate per approval)', () => {
  const a = keyOf({ sessionId: 's', toolName: 'Bash', toolInput: { command: 'a' } })
  const b = keyOf({ sessionId: 's', toolName: 'Bash', toolInput: { command: 'b' } })
  assert.notEqual(a, b)
  assert.ok(a.startsWith('s:'))
  // no exception even with nothing
  assert.ok(keyOf({}).startsWith('unknown:'))
})

test('keyOf: a tool_use_id, if present, takes top priority (for when it enters the payload)', () => {
  assert.equal(keyOf({ toolUseId: 'tu', promptId: 'pr', sessionId: 's' }), 'tu')
  // with a tool_use_id, the tool and arguments are not looked at (it is unique in itself)
  assert.equal(
    keyOf({ toolUseId: 'tu', toolName: 'Bash', toolInput: { command: 'a' } }),
    keyOf({ toolUseId: 'tu', toolName: 'Write', toolInput: { command: 'b' } }),
  )
})

test('★★ withPendingPerms: quietly waiting approvals are included too (a superset)', () => {
  // ⚠️⚠️ building this with `listPending()` **closes the notifications of quietly waiting approvals**
  //    (= the notification disappears while an answer is awaited = it stalls unnoticed).
  //    only the direction of "over-inclusion (failing to close)" is allowed.
  resetPending()
  const a = capture()
  const b = capture()
  void waitForDecision(info({ key: 'k1' }), a.register)
  // make it wait quietly (treated the same as from a sub-agent)
  void waitForDecision(info({ key: 'k2' }), b.register)
  holdQuiet('k2', 60_000)
  assert.equal(listPending().length, 1, 'only one is shown (checking the premise)')

  const payload = withPendingPerms(
    { title: 't', body: 'b', tag: 'x', url: '/', event: 'Stop', at: 'now' },
    'PC-A',
  )
  assert.equal(payload.machine, 'PC-A')
  // ★★ the quiet k2 is included too
  assert.deepEqual([...(payload.pendingPerms ?? [])].sort(), [
    permissionTag('PC-A', 'k1'),
    permissionTag('PC-A', 'k2'),
  ])
  resetPending()
})

test('★★ withPendingPerms: answered approvals are not included (= their notifications may be closed)', async () => {
  resetPending()
  const c = capture()
  const p = waitForDecision(info({ key: 'k1' }), c.register)
  answer('k1', 'allow')
  await p
  const payload = withPendingPerms({ title: 't', body: 'b', event: 'Stop', at: 'now' }, 'PC-A')
  assert.deepEqual(payload.pendingPerms, [])
  resetPending()
})

test('★★ withPendingPerms: if it does not fit the limit, no list is attached (no truncation)', () => {
  // ⚠️ passing a truncated list **closes the notifications of approvals left out**.
  //    ⇒ when it does not fit, **attach nothing** (the sw side does "nothing if absent").
  resetPending()
  for (let i = 0; i < 200; i++) {
    void waitForDecision(info({ key: `key-${i}-${'x'.repeat(40)}` }), capture().register)
  }
  const payload = withPendingPerms({ title: 't', body: 'b', event: 'Stop', at: 'now' }, 'PC-A')
  assert.equal(payload.pendingPerms, undefined, 'does not fit, so not attached')
  assert.equal(payload.machine, 'PC-A', 'the machine is attached (harmless)')
  // ★ check with values the implementation builds: attached when the count fits
  resetPending()
  void waitForDecision(info({ key: 'k1' }), capture().register)
  const small = withPendingPerms({ title: 't', body: 'b', event: 'Stop', at: 'now' }, 'PC-A')
  assert.deepEqual(small.pendingPerms, [permissionTag('PC-A', 'k1')])
  assert.ok(Buffer.byteLength(JSON.stringify(small), 'utf8') <= PUSH_PAYLOAD_SAFE_BYTES)
  resetPending()
})

test('★★ every push send goes through withPendingPerms (forgetting it leaves notifications uncleaned)', () => {
  // ★ **walks all of `agent/src`** (2026-08-20 `/code-review` low #4).
  //   ⚠️ a list of file names stays green **without looking at new senders**.
  const root = import.meta.dirname
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const path = join(dir, e.name)
      if (e.isDirectory()) return walk(path)
      if (!e.name.endsWith('.ts') || e.name.includes('.test.')) return []
      // push.ts is the **definition** of sendToAll, so it is excluded
      if (path === join(root, 'push.ts')) return []
      return [path]
    })
  let checked = 0
  for (const path of walk(root)) {
    const text = readFileSync(path, 'utf8')
    for (const m of text.matchAll(/sendToAll\(/g)) {
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 20)
      assert.ok(
        after.startsWith('withPendingPerms('),
        `${path}: sendToAll( does not go through withPendingPerms( (${after.slice(0, 20)})`,
      )
      checked++
    }
  }
  // ★ the scan is not idle (so breaking the regex does not stay green)
  assert.ok(checked >= 3, `send calls not found (${checked})`)
})

test('★★ pendingPermTags: only those of the advertised machine', () => {
  // ⚠️ if the advertised machine and the list contents disagree, the sw
  //    falls toward "close all of that machine's notifications" (low #3).
  resetPending()
  void waitForDecision(info({ key: 'k1', machine: 'PC-A' }), capture().register)
  void waitForDecision(info({ key: 'k2', machine: 'PC-B' }), capture().register)
  assert.deepEqual(pendingPermTags('PC-A'), [permissionTag('PC-A', 'k1')])
  assert.deepEqual(pendingPermTags('PC-B'), [permissionTag('PC-B', 'k2')])
  // unspecified means all (`/permissions` returns this shape)
  assert.equal(pendingPermTags().length, 2)
  const payload = withPendingPerms({ title: 't', body: 'b', event: 'Stop', at: 'now' }, 'PC-A')
  assert.deepEqual(payload.pendingPerms, [permissionTag('PC-A', 'k1')])
  resetPending()
})

test('★★ withPendingPerms: no list is attached to a payload without at', () => {
  // ⚠️⚠️ 2026-08-20 codex high #3. The sw decides "do not close notifications newer than the list" by `at`.
  //    Sending the list without `at` makes the sw fall back to the device clock and **close live notifications**.
  //    ⇒ stop the omission structurally (do not rely on a canary in the caller).
  resetPending()
  void waitForDecision(info({ key: 'k1' }), capture().register)
  const withAt = withPendingPerms({ title: 't', body: 'b', event: 'Stop', at: 'now' }, 'PC-A')
  assert.deepEqual(withAt.pendingPerms, [permissionTag('PC-A', 'k1')])
  const noAt = withPendingPerms({ title: 't', body: 'b', event: 'Stop' }, 'PC-A')
  assert.equal(noAt.pendingPerms, undefined)
  assert.equal(noAt.machine, 'PC-A')
  resetPending()
})

test('★ waitForDecision → answer(allow) resolves and the card disappears', async () => {
  resetPending()
  const c = capture()
  const p = waitForDecision(info(), c.register)
  assert.equal(listPending().length, 1, 'listed while waiting')
  assert.equal(answer('k1', 'allow'), true)
  assert.equal((await p)?.behavior, 'allow')
  assert.equal(listPending().length, 0, 'gone once answered')
})

test('waitForDecision → answer(deny) works too', async () => {
  resetPending()
  const c = capture()
  const p = waitForDecision(info(), c.register)
  answer('k1', 'deny')
  assert.equal((await p)?.behavior, 'deny')
})

test('★★ when the connection closes it ends with "no decision" (left to the PC\'s normal flow)', async () => {
  // ⚠️ without this, the mismatch "I pressed approve on the phone but the place to answer is dead" occurs.
  //    timeouts, approving first on the PC, and session end all appear as the connection closing.
  resetPending()
  const c = capture()
  const p = waitForDecision(info(), c.register)
  c.abort()
  assert.equal(await p, undefined, 'returns with no decision')
  assert.equal(listPending().length, 0, 'the card is gone')
})

test('★ an answer from the phone after the close returns false (it is clear it was too late)', async () => {
  resetPending()
  const c = capture()
  const p = waitForDecision(info(), c.register)
  c.abort()
  await p
  assert.equal(answer('k1', 'allow'), false)
})

test('★ if the same approval arrives twice the older is folded (the hook can fire multiple times)', async () => {
  resetPending()
  const a = capture()
  const b = capture()
  const first = waitForDecision(info(), a.register)
  const second = waitForDecision(info(), b.register)
  // the older one ends with "no decision". Only the new connection can be answered
  assert.equal(await first, undefined)
  assert.equal(listPending().length, 1, 'only one card')
  answer('k1', 'allow')
  assert.equal((await second)?.behavior, 'allow')
})

test('★★ separate approvals lined up in the same turn both remain as cards (one was vanishing on a real device)', async () => {
  // ⚠️ this is the bug from when `prompt_id` was used as the key. The second folded the first, and
  //    **the first fell into the PC's normal flow without ever showing on the phone** (= "some never show").
  resetPending()
  const pr = 'e508741a-3d3c-42c3-b0e7-f962da481817'
  const k1 = keyOf({ promptId: pr, toolName: 'Bash', toolInput: { command: 'npm test' } })
  const k2 = keyOf({ promptId: pr, toolName: 'Bash', toolInput: { command: 'git push' } })
  const a = capture()
  const b = capture()
  const first = waitForDecision(info({ key: k1 }), a.register)
  const second = waitForDecision(info({ key: k2 }), b.register)

  assert.equal(listPending().length, 2, '★ both remain')
  // each can be answered independently
  assert.equal(answer(k1, 'allow'), true)
  assert.equal((await first)?.behavior, 'allow')
  assert.equal(listPending().length, 1, 'only the answered one disappears')
  assert.equal(answer(k2, 'deny'), true)
  assert.equal((await second)?.behavior, 'deny')
  assert.equal(listPending().length, 0)
})

test('answer: an unknown key is false', () => {
  resetPending()
  assert.equal(answer('nope', 'allow'), false)
})

test('resetPending: ends everything that is waiting', async () => {
  resetPending()
  const c = capture()
  const p = waitForDecision(info(), c.register)
  resetPending()
  assert.equal(await p, undefined)
  assert.equal(listPending().length, 0)
})

test('★ summarize: shows in one line what it is about to do', () => {
  assert.equal(summarize('Bash', { command: 'rm -rf /tmp/x', description: 'x' }), 'rm -rf /tmp/x')
  assert.equal(summarize('Read', { file_path: '/a/b.ts' }), '/a/b.ts')
  assert.equal(summarize('WebFetch', { url: 'https://example.com' }), 'https://example.com')
  // newlines are flattened to one line (so notifications and chips do not break)
  assert.equal(summarize('Bash', { command: 'a\n  b' }), 'a b')
  // even unknown tools are shown as JSON (not "better unreadable")
  assert.ok(summarize('Weird', { foo: 1 }).includes('foo'))
  assert.equal(summarize('Bash', null), 'Bash')
})

test('summarize: cuts what is too long', () => {
  const s = summarize('Bash', { command: 'x'.repeat(1000) })
  assert.ok(s.length <= 400)
  assert.ok(s.endsWith('…'))
})

// ── ★ The "full text" opened from a card (2026-08-18) ────────────────────────────────
//
// The shape that hurt on a real device: a `python3 - <<'PY' …` heredoc, flattened to one line and cut at 400 chars,
// puts **all its contents past the "…"**. You cannot read what you are about to approve.

const HEREDOC = [
  "python3 - <<'PY'",
  'import pathlib',
  '# media_types: playlist を inert から外す',
  "p = pathlib.Path('lib/media_types.py')",
  's = p.read_text(encoding="utf-8")',
  `s = s.replace('${'a'.repeat(500)}', '${'b'.repeat(500)}')`,
  'PY',
].join('\n')

test('★★ detailOf: makes what lies past the "…" readable (returned with newlines)', () => {
  const d = detailOf('Bash', { command: HEREDOC })
  assert.ok(d, 'long commands get the full text')
  assert.equal(d.text, HEREDOC, 'newlines kept. Flattening it would make opening pointless')
  assert.equal(d.clipped, false)
})

test('★★ the folded line and the opened full text come from the same source (what was approved is what runs)', () => {
  // ⚠️ mix in a decoy. If they were chosen separately the file_path side would show
  const input = { command: HEREDOC, file_path: '/decoy.ts', description: 'x' }
  const s = summarize('Bash', input)
  const d = detailOf('Bash', input)
  assert.ok(d)
  assert.ok(!s.includes('\n'), 'the folded side stays one line')
  assert.ok(s.endsWith('…'))
  const flat = d.text.replace(/\s+/g, ' ').trim()
  assert.ok(flat.startsWith(s.slice(0, -1)), 'the folded line is exactly the start of the full text')
  assert.ok(!d.text.includes('/decoy.ts'))
})

test('★ detailOf: not attached when one line is already the full text (so no open button)', () => {
  assert.equal(detailOf('Bash', { command: 'rm -rf /tmp/x' }), undefined)
  assert.equal(detailOf('Read', { file_path: '/a/b.ts' }), undefined)
  assert.equal(detailOf('Bash', null), undefined)
})

test('★ detailOf: attached even when short if there are newlines (flattening makes it unreadable)', () => {
  const d = detailOf('Bash', { command: 'cd /tmp\nls -la' })
  assert.ok(d)
  assert.equal(d.text, 'cd /tmp\nls -la')
  assert.equal(summarize('Bash', { command: 'cd /tmp\nls -la' }), 'cd /tmp ls -la')
})

test('★★ detailOf: when the full text is also too long, cut it and **say it was cut**', () => {
  const d = detailOf('Bash', { command: 'x'.repeat(9000) })
  assert.ok(d)
  assert.equal(d.clipped, true, 'cutting silently means pressing allow thinking you "saw everything"')
  assert.equal(d.text.length, 8000)
})

test('detailOf: not attached for questions with choices (the card draws the question and choices as is)', () => {
  assert.equal(
    detailOf('AskUserQuestion', { questions: [{ question: 'A' }, { question: 'B' }] }),
    undefined,
  )
})

// ── ★ Three findings from /code-review (2026-08-18) ────────────────────────────────

test('★ detailOf: not attached if only leading/trailing whitespace was dropped (no pointless open button)', () => {
  // ⚠️ a plain comparison with `summarize` showed an open button here (/code-review low #2).
  //    a pointless open button **dulls the signal for when it really is cut**
  assert.equal(detailOf('Bash', { command: 'ls -la\n' }), undefined, 'only a trailing newline')
})

test('★★ detailOf: inner whitespace is not "just cosmetic" (collapsing it looks like another command)', () => {
  // ⚠️ codex review medium #2. Whitespace inside quotes is **the data itself**, so
  //    the folded line (`'allow deny'`) is **a lie**. It must be possible to open and check
  const command = "printf '%s' 'allow  deny'"
  assert.equal(summarize('Bash', { command }), "printf '%s' 'allow deny'")
  const d = detailOf('Bash', { command })
  assert.ok(d, 'if collapsing changes the meaning, show the full text')
  assert.equal(d.text, command)
})

test('★★ detailOf: unknown tools / MCP are **readable** when opened', () => {
  // ⚠️ medium #1: one-line JSON was shown as is, so `\n` just **sat there as characters** in
  //    an 8000-char lump (pointless to open)
  const input = { description: 'x'.repeat(200), prompt: `line1\nline2\n${'y'.repeat(300)}` }
  const d = detailOf('Task', input)
  assert.ok(d)
  assert.ok(d.text.includes('\n'), 'contains real newlines')
  assert.equal(JSON.parse(d.text).description, input.description, 'readable as JSON')
  // the folded side is one-line JSON as before
  const s = summarize('Task', input)
  assert.ok(!s.includes('\n'))
  assert.ok(s.startsWith('{"description"'))
})

test('★ short MCP input gets no open button (everything is visible in the folded line)', () => {
  assert.equal(detailOf('mcp__x__y', { foo: 1 }), undefined)
})

// ── ★★ Three findings from the codex review (2026-08-18) ─────────────────────────────

test('★★ whether to fold is decided by **tool name** (no hiding other fields because an MCP has `command`)', () => {
  // ⚠️ high #1: it was decided by key name, so when an MCP tool happened to have `command`,
  //    `target: production` and `force: true` **vanished from the card**
  const input = { command: 'echo harmless', target: 'production', force: true }
  const s = summarize('mcp__ops__deploy', input)
  assert.ok(s.includes('production'), 'other fields do not vanish')
  assert.ok(s.includes('force'))
  // known tools show only the gist as before
  assert.equal(summarize('Bash', input), 'echo harmless')
})

test('★ folding questions with choices is also decided by tool name (not fooled by an MCP with `questions`)', () => {
  const input = { questions: [{ question: 'A' }], danger: 'rm -rf /' }
  assert.ok(summarize('mcp__x__ask', input).includes('danger'))
  assert.equal(summarize('AskUserQuestion', input), 'A')
})

test('★ whether to open is measured on **the same string as the folded line** (not the formatted length)', () => {
  // ⚠️ low #3: it was measured on the length grown by formatting (indentation), so some objects
  //    got an open button **although nothing was dropped**
  const o = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, `v${i}`]))
  const compact = JSON.stringify(o)
  assert.ok(compact.length <= 400, `premise: fits in the folded line (${compact.length} chars)`)
  assert.ok(
    JSON.stringify(o, null, 2).replace(/\s+/g, ' ').trim().length > 400,
    'premise: exceeds 400 when formatted (measuring here would show an open button)',
  )
  assert.equal(summarize('mcp__x__y', o), compact, 'the summary contains everything')
  assert.equal(detailOf('mcp__x__y', o), undefined, 'so no open button is needed')
})

test('★ summarize: newlines inside a question do not become question separators', () => {
  // ⚠️ low #3: it joined into one string and split again, so **one question looked like two**
  assert.equal(summarize('AskUserQuestion', { questions: [{ question: 'a\nb' }] }), 'a b')
  assert.equal(
    summarize('AskUserQuestion', { questions: [{ question: 'a' }, { question: 'b' }] }),
    'a / b',
  )
})

test('★ describeSuggestions: turns the CLI\'s permission suggestions into readable text', () => {
  // the shape obtained by measurement (2026-08-12)
  const out = describeSuggestions([
    { type: 'addDirectories', directories: ['/tmp/a/b/hooktest5'], destination: 'session' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
  ])
  assert.equal(out.length, 2)
  assert.ok(out[0]?.includes('hooktest5'))
  assert.ok(out[1]?.includes('acceptEdits'))
})

test('★★ describeSuggestions (legacy): the Japanese wording old screens match against does not change (known answer)', () => {
  // ⚠️ old screens (the old `agentText.ts`) match this wording to translate it. Changing it stops the English on old screens
  assert.deepEqual(
    describeSuggestions([
      { type: 'addDirectories', directories: ['/tmp/a/b/hooktest5', '/x/y'] },
      { type: 'setMode', mode: 'acceptEdits' },
      { type: 'addRules' },
      { type: 'setMode' },
    ]),
    ['このディレクトリを許可: hooktest5, y', 'このセッションのモードを acceptEdits にする', 'addRules', 'setMode'],
  )
})

test('★★ suggestionItems: returned as structure (the screen makes the sentences)', () => {
  assert.deepEqual(
    suggestionItems([
      { type: 'addDirectories', directories: ['/tmp/a/b/hooktest5', 3], destination: 'session' },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      { type: 'addRules', rules: [{ toolName: 'Bash' }] },
      { type: 'addDirectories', directories: [] }, // omitted when empty (same as the old text)
      null,
      {},
    ]),
    [
      { kind: 'addDirectories', directories: ['hooktest5'] },
      { kind: 'setMode', mode: 'acceptEdits' },
      { kind: 'other', type: 'addRules' },
    ],
  )
  assert.deepEqual(suggestionItems('nope'), [])
})

test('describeSuggestions: does not crash on broken input', () => {
  assert.deepEqual(describeSuggestions(undefined), [])
  assert.deepEqual(describeSuggestions('nope'), [])
  assert.deepEqual(describeSuggestions([null, 'x', {}]), [])
})

// ── ★★ ABA: an old card's "allow" must not go to a different request ────────────────────
//
// A critical reproduced in the real code by the 2026-08-13 external review (codex).
//
//   ① approval A waits. A card appears on the phone
//   ② A ends (answered on the PC / connection closed)
//   ③ approval B for **the same command in the same turn** arrives → same fingerprint, so the same card
//   ④ pressing "allow" on **A's card** still on the phone → **B received allow**
//
// ★ "Same command, same judgement" does not hold. **A was denied but B runs**,
//   **allowed once but runs twice** happen. What was pressed and what is answered must always match.

test('★★ an old card\'s allow does not go to a later request for the same command (ABA)', async () => {
  resetPending()
  const dedupe = keyOf({ promptId: 'pr1', toolName: 'Bash', toolInput: { command: 'git push' } })
  const keyA = withGeneration(dedupe)
  const keyB = withGeneration(dedupe)
  assert.notEqual(keyA, keyB, 'different generations give different keys')
  assert.equal(baseKey(keyA), baseKey(keyB), 'identical as the same approval (one card)')

  const a = capture()
  const first = waitForDecision(info({ key: keyA }), a.register)
  a.abort() // ① A ends (answered on the PC / connection closed)
  assert.equal(await first, undefined)

  // ② approval B for the same command arrives
  const b = capture()
  const second = waitForDecision(info({ key: keyB }), b.register)

  // ③ press allow on **A's card** still on the phone
  assert.equal(answer(keyA, 'allow'), false, '★ an old card cannot answer')
  // ④ B is still waiting (not allowed on its own)
  assert.equal(listPending().length, 1)
  // only the correct card (B) can answer
  assert.equal(answer(keyB, 'deny'), true)
  assert.equal((await second)?.behavior, 'deny')
})

test('★ once replaced by re-entry, the old generation\'s card cannot answer', async () => {
  resetPending()
  const dedupe = keyOf({ promptId: 'pr2', toolName: 'Bash', toolInput: { command: 'ls' } })
  const k1 = withGeneration(dedupe)
  const k2 = withGeneration(dedupe)
  const first = waitForDecision(info({ key: k1 }), () => {})
  const second = waitForDecision(info({ key: k2 }), () => {}) // re-entry of the same approval
  assert.equal(await first, undefined, 'the old one is folded with no decision')
  assert.equal(answer(k1, 'allow'), false, '★ a folded generation cannot answer')
  assert.equal(answer(k2, 'allow'), true)
  assert.equal((await second)?.behavior, 'allow')
})

test('baseKey: keys without a generation work as is (does not break existing callers)', () => {
  assert.equal(baseKey('abc'), 'abc')
  assert.equal(baseKey('abc#def'), 'abc')
  // fingerprints never contain #, but pin that it cuts at the last #
  assert.equal(baseKey('a#b#c'), 'a#b')
})

test('★ permissionTag: ignores the generation (notifications do not pile up on re-entry)', () => {
  const dedupe = keyOf({ promptId: 'pr3', toolName: 'Bash', toolInput: { command: 'ls' } })
  assert.equal(
    permissionTag('PC-B', withGeneration(dedupe)),
    permissionTag('PC-B', withGeneration(dedupe)),
  )
  assert.equal(permissionTag('PC-B', dedupe), permissionTag('PC-B', withGeneration(dedupe)))
})

// ── "Waiting quietly" for sub-agent approvals (2026-08-14 / found by the user with /code-review) ──
//
// ⚠️ Symptom: when the sub-agent's check decides to "ask" the hook fires, but most are then
//    auto-approved on the main side and proceed. The hook's connection is not cut, so
//    **approvals that need no answer are notified to the phone and their cards stay**.

test('★★ holdQuiet: not listed while waiting quietly', async () => {
  const req = info({ key: withGeneration('quiet-1'), toolName: 'Bash' })
  const p = waitForDecision(req, () => {})
  holdQuiet(req.key, 5000, 1000)
  assert.equal(listPending(2000).some((x) => x.key === req.key), false, 'not shown while waiting')
  // ⚠️ but it is not "as if it never existed". It shows when the time comes
  assert.equal(listPending(9000).some((x) => x.key === req.key), true, 'shown when the time comes')
  answer(req.key, 'allow')
  await p
})

test('★★ promoteQuiet: shown only once; answered ones are not shown', async () => {
  const req = info({ key: withGeneration('quiet-2'), toolName: 'Bash' })
  const p = waitForDecision(req, () => {})
  holdQuiet(req.key, 5000)
  assert.equal(promoteQuiet(req.key), true, 'something waiting quietly is shown')
  assert.equal(promoteQuiet(req.key), false, 'not shown a second time (notifications would fire twice)')
  answer(req.key, 'allow')
  await p
})

test('★★ promoteQuiet: no notice if it was cleared automatically (the card is gone)', async () => {
  const req = info({ key: withGeneration('quiet-3'), toolName: 'Bash' })
  const p = waitForDecision(req, () => {})
  holdQuiet(req.key, 5000)
  // the situation where it was auto-approved and sweep discarded it
  abandon(req.key)
  assert.equal(promoteQuiet(req.key), false, 'do not dig up a gone card and notify it')
  await p
})

test('★ promoteQuiet: not shown for a card of a different generation (same reason as ABA)', async () => {
  const req = info({ key: withGeneration('quiet-4'), toolName: 'Bash' })
  const p = waitForDecision(req, () => {})
  holdQuiet(req.key, 5000)
  assert.equal(promoteQuiet(`${baseKey(req.key)}#ちがう世代`), false)
  answer(req.key, 'allow')
  await p
})

test('even while waiting quietly, it can be answered normally (only the display is hidden)', async () => {
  const req = info({ key: withGeneration('quiet-5'), toolName: 'Bash' })
  const p = waitForDecision(req, () => {})
  holdQuiet(req.key, 5000)
  assert.equal(answer(req.key, 'deny'), true)
  assert.equal((await p)?.behavior, 'deny')
})

// ── Holes in "waiting quietly" (findings from the 2026-08-14 /code-review) ────────────────────────

test('★★ quietCount: quietly waiting ones are also grounds for "do not restart"', async () => {
  // ⚠️ deciding whether to restart by listPending() alone answers "pending approvals: none"
  //    for 6 seconds and **kills a live approval** (the worst accident in CLAUDE.md)
  const req = info({ key: withGeneration('quiet-count'), toolName: 'Bash' })
  const p = waitForDecision(req, () => {})
  holdQuiet(req.key, 5000, 1000)
  assert.equal(listPending(2000).length, 0, 'not shown')
  assert.equal(quietCount(2000), 1, 'but it is known to be "waiting"')
  answer(req.key, 'allow')
  await p
})

test('★★ hasPendingForSession: quietly waiting approvals are not treated as absent', async () => {
  // ⚠️ if this is false, sweep clears the "needs attention" label and
  //    the session looks like work in progress although an approval is really waiting
  const req = info({ key: withGeneration('quiet-sess'), toolName: 'Bash', sessionId: 'S-1' })
  const p = waitForDecision(req, () => {})
  holdQuiet(req.key, 5000)
  assert.equal(hasPendingForSession('S-1'), true)
  answer(req.key, 'allow')
  await p
})

test('★★ once shown, an approval is not hidden even if the hook re-enters', async () => {
  // ⚠️ if a card vanishes for 6 seconds in front of someone who opened it from a notification, it looks like there is no way to answer
  const req = info({ key: withGeneration('quiet-reentry'), toolName: 'Bash' })
  const p = waitForDecision(req, () => {})
  holdQuiet(req.key, 5000)
  assert.equal(promoteQuiet(req.key), true)
  holdQuiet(req.key, 5000) // re-entry
  assert.equal(listPending().some((x) => x.key === req.key), true, 'must not be hidden again')
  answer(req.key, 'allow')
  await p
})

test('★ holdQuiet: a key of a different generation does not hide it (does not drag in another request)', async () => {
  const req = info({ key: withGeneration('quiet-gen'), toolName: 'Bash' })
  const p = waitForDecision(req, () => {})
  holdQuiet(`${baseKey(req.key)}#ちがう世代`, 5000)
  assert.equal(listPending().some((x) => x.key === req.key), true, 'must not drag it in and hide it')
  answer(req.key, 'allow')
  await p
})

// ── Another approval arrives during the 6 quiet seconds (2026-08-14 user finding) ──────────────────

test('★★ a main-agent approval arriving during the quiet period is shown immediately (not held back by the sub)', async () => {
  // ⚠️ if this breaks, "an approval that needs handling is hidden for 6 seconds". Quiet applies only to sub-agents
  const sub = info({ key: withGeneration('mix-sub'), toolName: 'Bash', agentType: 'general-purpose' })
  const main = info({ key: withGeneration('mix-main'), toolName: 'Bash' })
  const ps = waitForDecision(sub, () => {})
  holdQuiet(sub.key, 6000, 1000)
  const pm = waitForDecision(main, () => {})
  // main-agent ones do not go through holdQuiet (announce in routes/permission.ts branches)
  const shown = listPending(2000).map((x) => x.key)
  assert.equal(shown.includes(main.key), true, '★ the main approval shows immediately')
  assert.equal(shown.includes(sub.key), false, 'the sub stays quiet')
  // both are in the "waiting count" (so the restart decision is not misled)
  assert.equal(quietCount(2000), 1)
  answer(sub.key, 'allow')
  answer(main.key, 'allow')
  await Promise.all([ps, pm])
})

test('★ another sub-agent approval during the quiet period shows at its own time', async () => {
  const a = info({ key: withGeneration('mix-a'), toolName: 'Bash', agentType: 'general-purpose' })
  const b = info({ key: withGeneration('mix-b'), toolName: 'Read', agentType: 'code-reviewer' })
  const pa = waitForDecision(a, () => {})
  holdQuiet(a.key, 6000, 1000)
  const pb = waitForDecision(b, () => {})
  holdQuiet(b.key, 6000, 4000) // arrived 3 seconds later → shows at 10000
  assert.equal(listPending(5000).length, 0, 'both still quiet')
  // ★ the wait is counted **from each arrival time** (a later one must not show earlier)
  assert.deepEqual(listPending(8000).map((x) => x.key), [a.key], 'only a, which came first, shows')
  assert.equal(listPending(11000).map((x) => x.key).sort().join(','), [a.key, b.key].sort().join(','), 'both show')
  answer(a.key, 'allow')
  answer(b.key, 'allow')
  await Promise.all([pa, pb])
})

test('★★ keyOf: not folded when different sub-agents ask the same command in the same turn', () => {
  // ⚠️ `/code-review` runs similar agents side by side, so the same commands like `git status`
  //    overlap. Folding ends one with "no decision" and
  //    **it falls to the PC without showing on the phone** (the notification tag is also the same, erasing one)
  const base = { promptId: 'p1', toolName: 'Bash', toolInput: { command: 'git status' } }
  assert.notEqual(keyOf({ ...base, agentId: 'a1' }), keyOf({ ...base, agentId: 'a2' }))
  // re-entry of the same sub-agent is the same card (idempotency kept)
  assert.equal(keyOf({ ...base, agentId: 'a1' }), keyOf({ ...base, agentId: 'a1' }))
  // the main agent (no agent_id) and a sub-agent are different too
  assert.notEqual(keyOf(base), keyOf({ ...base, agentId: 'a1' }))
  // with only the main agent, the same shape as before (no needless differences)
  assert.equal(keyOf(base), `p1:${fingerprint('Bash', { command: 'git status' })}`)
})

// ── Denying with "what I would like changed" (equivalent to the PC's 3. Tell Claude what to change) ──

test('★★ decisionResponse: deny carries the reason (it becomes the instruction passed to the model)', () => {
  assert.equal(
    JSON.stringify(decisionResponse({ behavior: 'deny', message: '順番を変えて' })),
    '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"順番を変えて"}}}',
  )
  // ⚠️ not attached to allow (the CLI does not read it; it would be "allowed yet with a reason")
  assert.ok(
    !JSON.stringify(decisionResponse({ behavior: 'allow', message: 'x' })).includes('message'),
  )
})

test('★ answer: a deny with a reason reaches the waiter / dropped on allow', async () => {
  resetPending()
  const p = waitForDecision(info({ key: 'fb1' }), () => {})
  assert.equal(answer('fb1', 'deny', { message: 'ここを直して' }), true)
  assert.deepEqual(await p, { behavior: 'deny', message: 'ここを直して' })

  resetPending()
  const q = waitForDecision(info({ key: 'fb2' }), () => {})
  answer('fb2', 'allow', { message: '無視されるべき' })
  assert.deepEqual(await q, { behavior: 'allow' })
})

test('★ validateFeedback: empty means no reason / too long is refused / wrong type is refused', async () => {
  const { validateFeedback } = await import('./permission.ts')
  assert.deepEqual(validateFeedback(undefined), { ok: true })
  assert.deepEqual(validateFeedback('   '), { ok: true }, 'whitespace only is the same as a deny without reason')
  assert.deepEqual(validateFeedback(' 直して '), { ok: true, message: '直して' }, 'leading and trailing whitespace is dropped')
  const r = validateFeedback('あ'.repeat(2000))
  assert.equal(r.ok, false, 'refused because it exceeds 4096 bytes')
  assert.equal(validateFeedback(42).ok, false)
})
