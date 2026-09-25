// ★★ The table-driven slash command endpoint (`POST /sessions/:id/command`).
//
// ⚠️⚠️ Four things are guarded here. **All by structure**:
//
//   1. **Never fall back to the inbox** (does not import `inbox` = there is no path to fall back).
//      A `/compact` that lands there is **executed as a request** by the receiving model (measured 2026-08-24)
//   2. **Take no characters from the body** (only `id` is read; only table values can be sent)
//   3. Failure category → HTTP is pinned by an **exhaustive table** (a new reason fails the type check)
//   4. **The endpoint does not contain command text** (never writes `/compact` = the table is the only source)

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { COMMAND_STATUS, toCommandId } from './command.ts'
import type { CommandFailure } from '../claude/keys.ts'
import { commandMessage } from '../claude/keys.ts'
import { buildRouter } from './index.ts'

const SRC = readFileSync(new URL('./command.ts', import.meta.url), 'utf8')

/** ⚠️ **Strip comments before checking** (otherwise the explanations themselves match and turn it red / same as interrupt.test.ts) */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((l) => l.replace(/\/\/.*$/, ''))
  .join('\n')

/** ⚠️ **List every reason**. Anything added to `CommandFailure` but missing here **fails the type check** */
const EXPECTED: Record<CommandFailure, number> = {
  'pending-approval': 409,
  waiting: 409,
  'no-relay': 409,
  broken: 409,
  unverified: 409,
  ambiguous: 409,
  'too-soon': 429,
  'not-found': 404,
  unreachable: 502,
  partial: 502,
}

test('★★ COMMAND_STATUS: pin every failure category exhaustively', () => {
  let checked = 0
  for (const [reason, want] of Object.entries(EXPECTED) as [CommandFailure, number][]) {
    assert.equal(COMMAND_STATUS[reason], want, `handling of reason ${reason} changed`)
    checked += 1
  }
  assert.equal(checked, 10, 'if reasons are added/removed, fix this count together with the table')
  assert.equal(Object.keys(COMMAND_STATUS).length, 10)
})

test('★★ messages differ per reason and never expose internal terms (keystrokes / relay / socket)', () => {
  const seen = new Set<string>()
  for (const reason of Object.keys(EXPECTED) as CommandFailure[]) {
    const msg = commandMessage(reason)
    assert.ok(msg.length > 0, `no message for ${reason}`)
    assert.ok(!seen.has(msg), `message for ${reason} is the same as another (the reason does not come across): ${msg}`)
    seen.add(msg)
    for (const word of ['打鍵', 'socket', 'ソケット', 'pane']) {
      assert.ok(!msg.includes(word), `message for ${reason} exposes internal term ${word}: ${msg}`)
    }
  }
})

test('★★★ the endpoint does not know the inbox (a failure never arrives as an instruction)', () => {
  assert.ok(!/inbox/i.test(CODE), '⚠️⚠️ the endpoint references the inbox')
  assert.ok(!/sendToSession\b/.test(CODE), '⚠️⚠️ it calls the inbox send')
  assert.ok(!/decideAfterKeys/.test(CODE), '⚠️ it reuses the keystroke fallback (to the inbox)')
})

test('★★★ the endpoint contains no command text (the table is the only source)', () => {
  assert.ok(!/'\/compact'|"\/compact"/.test(CODE), '⚠️⚠️ /compact is written directly in the endpoint')
  assert.ok(!/'\/exit'|"\/exit"/.test(CODE), '⚠️⚠️ /exit is written directly in the endpoint')
  assert.ok(/SLASH_COMMANDS/.test(CODE), 'does not reference the table')
})

test('★★★ only id is taken from the body (text / keys are not read)', () => {
  // ★ The body is **just passed as is to `toCommandId`** (extraction happens in that one place)
  assert.ok(/readJsonBody<unknown>\(ctx\.req\)/.test(CODE), 'the way the body is read changed')
  assert.ok(/const id = toCommandId\(body\)/.test(CODE), 'does not match against the table')
  // ⚠️⚠️ Extracting text from the body here would make "an endpoint that can type any command"
  assert.ok(!/body\.text|body\['text'\]|body\.command/.test(CODE), '⚠️⚠️ reads text from the body')
  assert.ok(!/writeKeys|sendKeysToSession/.test(CODE), '⚠️⚠️ the endpoint types keys directly (bypassing the table)')
})

test('★★★ toCommandId: rejects anything not in the table', () => {
  assert.equal(toCommandId({ id: 'compact' }), 'compact')
  assert.equal(toCommandId({ id: 'exit' }), 'exit')
  // ⚠️⚠️ If this breaks, it becomes "an endpoint where the phone can type any command"
  // ⚠️ `' compact '` is the mutation codex named (adding `raw.trim()` would let it through)
  for (const bad of [
    '/compact',
    'COMPACT',
    'clear',
    '',
    ' compact ',
    'compact ',
    'toString',
    '__proto__',
    'constructor',
  ]) {
    assert.equal(toCommandId({ id: bad }), undefined, `lets ${JSON.stringify(bad)} through`)
  }
  for (const bad of [undefined, null, 1, {}, ['compact'], true]) {
    assert.equal(toCommandId({ id: bad }), undefined, `lets ${JSON.stringify(bad)} through`)
  }
  // ⚠️⚠️ Does not crash even when the body itself is not an object (`JSON.parse('null')` etc.) (low #2)
  for (const bad of [null, undefined, 'compact', 1, true]) {
    assert.equal(toCommandId(bad), undefined, `lets a body of ${JSON.stringify(bad)} through`)
  }
})

test('★★★ toCommandId: ignores inherited properties (the gadget where empty JSON becomes /exit)', () => {
  // ⚠️⚠️ codex 2026-08-25, medium #1. Reproduced:
  //    with `Object.prototype.id = 'exit'`, `JSON.parse('{}')` ran `/exit`
  const proto = Object.prototype as unknown as Record<string, unknown>
  proto['id'] = 'exit'
  try {
    assert.equal(toCommandId(JSON.parse('{}')), undefined, '⚠️⚠️ an inherited property runs /exit')
    assert.equal(toCommandId({}), undefined)
    // ★ A genuine own property passes (the feature is not broken)
    assert.equal(toCommandId({ id: 'compact' }), 'compact')
  } finally {
    delete proto['id']
  }
})

test('★ the endpoint is POST only (no GET)', () => {
  const router = buildRouter()
  assert.ok(router.match('POST', '/sessions/x/command'), 'POST is not registered')
  // ⚠️⚠️ With GET, merely getting someone to follow a link could end another person's session
  assert.equal(router.match('GET', '/sessions/x/command'), null, 'also registered for GET')
})
