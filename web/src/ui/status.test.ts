// Pins what the line above the input box (`composerBusy`) shows in each state.
//
// ★★ **Do not build expected values from `statusView`** (2026-08-28 codex medium #1, #6).
//    At first it brute-forced "matches the output of `statusView` and `showNyan`", but
//    **the expected side came from the same functions, so it was a tautology**:
//      - a mutant turning `case 'rate-limited'` into `return null` **stayed green**
//        (both sides become `null` together) = the line vanishes only while rate-limited
//      - the bug of not checking `live` would also be pinned as "correct"
//    ⇒ **Write text, colour and running as literals in this table.** Changing the implementation turns this red.
//
// ⚠️ The source of truth for the text is `statusLabel` in `shared/types.ts` (shared with notifications), so
//    **also check separately that the table matches `statusLabel`** (test below).

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { statusLabel, type SessionStatus, type SessionSummary } from '../../../shared/types.ts'
import { composerBusy, showNyan, statusView } from './status.ts'

/** ⚠️ Every `SessionStatus`. Add here when one is added (the coverage test below fails) */
const ALL: readonly SessionStatus[] = [
  'working',
  'background',
  'waiting',
  'error',
  'done',
  'idle',
  'rate-limited',
  'unknown',
]

type Expected = { label: string; cls: string; running: boolean } | null

/**
 * ★★ Table of expected values (**literals**). `[status].live` / `[status].dead`.
 *
 * ⚠️ `null` means "do not render the line" = an ended record (a target that cannot receive).
 * ⚠️ `running: true` appears **only once** (working and alive).
 */
const TABLE: Record<SessionStatus, { live: Expected; dead: Expected }> = {
  // ★ Only this one runs. ⚠️ Does not run when not alive (fail-closed / codex medium #1)
  working: {
    live: { label: '応答中', cls: 'working', running: true },
    dead: { label: '応答中', cls: 'working', running: false },
  },
  // ★ The "no reply for a while" mark. Running it would make it indistinguishable from working
  background: {
    live: { label: '背景で実行中', cls: 'background', running: false },
    dead: { label: '背景で実行中', cls: 'background', running: false },
  },
  waiting: {
    live: { label: '要対応', cls: 'waiting', running: false },
    dead: { label: '要対応', cls: 'waiting', running: false },
  },
  error: {
    live: { label: '⚠ 異常終了', cls: 'error', running: false },
    dead: { label: '⚠ 異常終了', cls: 'error', running: false },
  },
  done: {
    live: { label: '完了', cls: 'done', running: false },
    dead: { label: '完了', cls: 'done', running: false },
  },
  // ★ Rate-limited borrows the `error` colour (as `statusView` intends). ⚠️ The line is shown
  'rate-limited': {
    live: { label: '制限中', cls: 'error', running: false },
    dead: { label: '制限中', cls: 'error', running: false },
  },
  // ★ "Starting" is shown only while active (history has the time = `statusView`'s decision)
  idle: {
    live: { label: '起動中', cls: 'idle', running: false },
    dead: null,
  },
  unknown: {
    live: { label: '起動中', cls: 'idle', running: false },
    dead: null,
  },
}

function session(status: SessionStatus, live: boolean, waitingFor?: string): SessionSummary {
  return {
    machine: 'pc-a',
    account: '.claude-r',
    sessionId: 'abc',
    cwd: '/home/x/p',
    project: 'p',
    title: 't',
    titleSource: 'fallback',
    status,
    live,
    lastActivity: '2026-08-28T00:00:00.000Z',
    transcriptBytes: 0,
    ...(waitingFor === undefined ? {} : { waitingFor }),
  }
}

test('★ every state in the type is listed (the test\'s own validity)', () => {
  // ⚠️ A test claiming coverage **silently goes green** if a target is missing
  assert.equal(new Set(ALL).size, ALL.length, 'duplicates')
  assert.equal(ALL.length, 8, `number of states changed: ${ALL.length} (review SessionStatus)`)
  assert.deepEqual([...Object.keys(TABLE)].sort(), [...ALL].sort(), 'a state is missing from the table')
})

test('★★ all 16 combinations of state × live match the table (literal expectations)', () => {
  for (const status of ALL) {
    for (const live of [true, false]) {
      const got = composerBusy(session(status, live))
      const want = TABLE[status][live ? 'live' : 'dead']
      assert.deepEqual(got, want, `${status} / live=${live}`)
    }
  }
})

test('★★ only 1 of the 16 runs ("working and alive")', () => {
  // ⚠️⚠️ If this grows, "a picture that lies about state" is showing. Pinned **as a list of combinations**
  const running: string[] = []
  for (const status of ALL) {
    for (const live of [true, false]) {
      if (composerBusy(session(status, live))?.running) running.push(`${status}/live=${live}`)
    }
  }
  assert.deepEqual(running, ['working/live=true'], `the running combinations changed: ${running}`)
})

test('★★ the line is omitted only for "ended records" (not for rate-limited etc.)', () => {
  const missing: string[] = []
  for (const status of ALL) {
    for (const live of [true, false]) {
      if (composerBusy(session(status, live)) === null) missing.push(`${status}/live=${live}`)
    }
  }
  // ⚠️ Only `idle` / `unknown` with `live: false` (where `statusView` returns null)
  assert.deepEqual(missing, ['idle/live=false', 'unknown/live=false'], `combinations where the line vanishes: ${missing}`)
})

test('★★ table text matches `statusLabel` (never diverge from notifications)', () => {
  // ⚠️ The source of truth for text is `shared/types.ts` (shared by list and notifications). The table must not invent words
  for (const status of ALL) {
    const row = TABLE[status].live
    if (!row) continue
    // ⚠️ `unknown` has no mark, so it borrows the `idle` text (`statusView`'s default)
    const expected = statusLabel(status) ?? statusLabel('idle')
    assert.equal(row.label, expected, `${status}: table text differs from statusLabel`)
  }
})

test('★★ nothing shown without a session (do not default to "working")', () => {
  assert.equal(composerBusy(undefined), null)
})

test('★★ nothing shown for ended records (no cat for a target that cannot receive)', () => {
  assert.equal(statusView('unknown', false, undefined), null, 'the test itself is stale')
  assert.equal(composerBusy(session('unknown', false)), null)
  assert.equal(composerBusy(session('idle', false)), null)
})

test('★ a "needs attention" reason is appended in parentheses (does not run)', () => {
  const busy = composerBusy(session('waiting', true, 'permission prompt'))
  assert.equal(busy?.running, false)
  assert.match(busy?.label ?? '', /^要対応（/)
  assert.equal(busy?.cls, 'waiting')
})

test('★ `showNyan` is true only for `working` (the one run decision)', () => {
  const clsList = ['working', 'background', 'waiting', 'error', 'done', 'idle']
  assert.deepEqual(
    clsList.filter((c) => showNyan(c)),
    ['working'],
  )
})
