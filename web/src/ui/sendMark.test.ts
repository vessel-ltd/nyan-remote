// The mark for "how will it arrive if sent from the phone" (per session / HANDOFF).
//
// ⚠️⚠️ **No mark for the good route (keystrokes).** A mark on every thread all the time stops being read.
//    ⇒ Shown **only on the framed side**. ★ The point this time is knowing **before sending**
//      (until now you could only notice after sending, via the "from phone" mark).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { KEYS_REASON_TEXT, NEUTRALIZED_NOTE, perMessageNote, sendMark } from './sendMark.ts'
import type { KeysUnavailable, SessionSummary } from '../../../shared/types.ts'

const base: SessionSummary = {
  machine: 'm',
  account: '.claude-r',
  sessionId: 's1',
  cwd: '/home/x/p',
  project: 'p',
  title: 't',
  titleSource: 'fallback',
  status: 'idle',
  live: true,
  lastActivity: '2026-08-24T00:00:00.000Z',
  transcriptBytes: 1,
}

test('★★ nothing shown for sessions delivered by keystrokes (a permanent mark stops being read)', () => {
  assert.equal(sendMark({ ...base, sendRoute: 'keys' }), null)
})

test('★★ sessions that get a frame show it with a reason', () => {
  const m = sendMark({ ...base, sendRoute: 'inbox', keysReason: 'no-relay' })
  assert.ok(m, 'no mark (cannot notice before sending)')
  assert.ok(m.label.includes('枠'), m.label)
  assert.ok(m.note.length > 0, 'empty reason')
  // ★ The line shown on screen is assembled **here** (concatenating on the screen side makes it vary by place)
  assert.ok(m.text.includes(m.label) && m.text.includes(m.note), m.text)
})

test('★ nothing for sessions without a mark (old agent / not alive)', () => {
  // ⚠️ Old agents do not return `sendRoute`. **Do not assert what we do not know**
  assert.equal(sendMark(base), null)
  assert.equal(sendMark(undefined), null)
  assert.equal(sendMark({ ...base, live: false }), null)
})

test('★★ pin every reason\'s text exhaustively (a new one fails the type check)', () => {
  const all: KeysUnavailable[] = [
    'not-found',
    'no-relay',
    'broken',
    'unverified',
    'ambiguous',
    'waiting',
  ]
  for (const r of all) {
    const text = KEYS_REASON_TEXT[r]
    assert.ok(text && text.length > 0, `no explanation for ${r}`)
    // ⚠️ Do not show internal terms like "keystrokes" or "relay" on screen (meaningless to users)
    assert.ok(!/打鍵/.test(text), `${r}: internal term shown: ${text}`)
  }
  assert.equal(Object.keys(KEYS_REASON_TEXT).length, 6, 'reasons were added/removed')
})

test('★★ the mark is shown even when the reason is unknown (never silently vanishes)', () => {
  // ⚠️ Even `inbox` without `keysReason` (= unexpected) **says a frame will be added**
  const m = sendMark({ ...base, sendRoute: 'inbox' })
  assert.ok(m, '⚠️ without a reason the whole mark vanishes (silent about the frame)')
  assert.ok(m.text.length > 0 && !m.text.endsWith('。'), m.text)
})

test('★★ shown above the input box (the goal is to notice before sending)', () => {
  const thread = readFileSync(new URL('./Thread.tsx', import.meta.url), 'utf8')
  assert.match(thread, /sendMark\(session\)/, 'Thread does not build the mark')
  assert.match(thread, /hint=\{/, 'not passed to Composer')
  const composer = readFileSync(new URL('./Composer.tsx', import.meta.url), 'utf8')
  assert.match(composer, /hint/, 'Composer does not receive it')
})

test('★★ even when the mark is `keys`, `/` and `!` always get a frame (2026-08-24 codex high #2)', () => {
  // ⚠️⚠️ The session mark is "that session's default route", and **the text overrides it**:
  //    `/` `!` are refused by keystrokes and fall into the inbox (= English frame) (`decideAfterKeys`).
  //    Letting the mark alone suggest "no frame" causes exactly the harm the mark should prevent
  //    (the frame makes it reply to an unrelated session).
  assert.equal(perMessageNote('/compact'), 'slash')
  assert.equal(perMessageNote('  /status あとで'), 'slash')
  assert.equal(perMessageNote('!ls'), 'bang')
  assert.equal(perMessageNote('ふつうの文'), null)
  assert.equal(perMessageNote(''), null)
  // ★ `/` on line 2 is not a command to the CLI ⇒ no caution either (same rule as the agent)
  assert.equal(perMessageNote('これを見て\n/tmp のこと'), null)
})

test('★★ whitespace handling matches the agent (full-width, BOM, leading newline / mutants codex named)', () => {
  // ⚠️ The agent looks at the start after `trimStart()` (strips all Unicode whitespace).
  //    If the screen strips only ASCII spaces, it misses **a `/` after a full-width space or BOM**.
  assert.equal(perMessageNote('\u3000/compact'), 'slash')
  assert.equal(perMessageNote('\ufeff!ls'), 'bang')
  assert.equal(perMessageNote('\n/compact'), 'slash')
  assert.equal(perMessageNote('\t/compact'), 'slash')
})

test('★★ decides by the start after stripping control characters (same shape as the agent)', () => {
  // ⚠️ The agent strips control characters **before** looking for `/` (`sanitizeForKeys`).
  //    If the screen only looked at the raw start, it would present `\x01/compact` as "ordinary text".
  assert.equal(perMessageNote('\u0001/compact'), 'slash')
  assert.equal(perMessageNote('\u001b!ls'), 'bang')
})

test('★★ the neutralisation notice says "sent as text" and does not mention the frame (behaviour changed on 2026-08-24)', () => {
  // ⚠️ `/` `!` used to fall into the inbox (English frame), but now they go by **keystrokes with one space added**
  //    (measured: the CLI's command parsing is disabled). Stale text would be a lie.
  assert.ok(/文章として/.test(NEUTRALIZED_NOTE), NEUTRALIZED_NOTE)
  assert.ok(!/枠/.test(NEUTRALIZED_NOTE), '⚠️ the old "a frame is added" explanation remains')
  const composer = readFileSync(new URL('./Composer.tsx', import.meta.url), 'utf8')
  // ★ The caution while typing should also say "arrives as text"
  assert.ok(/文章として/.test(composer), 'the input box caution is stale')
  assert.ok(!/英文の枠付き/.test(composer), '⚠️ "arrives with an English frame" remains')
  const thread = readFileSync(new URL('./Thread.tsx', import.meta.url), 'utf8')
  assert.match(thread, /res\.neutralized/, 'does not tell after sending (rewrites silently)')
})

test('★★ the start-of-text decision goes through the same function as the agent (no divergence on invisible characters)', () => {
  // ⚠️⚠️ 2026-08-24 codex low #2: the screen did its own `trimStart()`, so
  //    `​/help` was **unwarned on screen but rewritten by the agent**
  //    (failing the goal of "tell before sending").
  for (const p of ['\u200b', '\u00ad', '\u2066', '\ufe0f', '\u061c', '\u180e']) {
    assert.equal(perMessageNote(`${p}/compact`), 'slash', JSON.stringify(p))
    assert.equal(perMessageNote(`${p}!ls`), 'bang', JSON.stringify(p))
  }
  // ★ Check it does not hand-roll the decision (structurally)
  const src = readFileSync(new URL('./sendMark.ts', import.meta.url), 'utf8')
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n')
  assert.match(code, /looksLikeCommand\(/, '⚠️ the screen hand-rolls the start-of-text check')
  assert.ok(!/trimStart/.test(code), '⚠️ a hand-written trimStart remains')
})

test('★★ action results are shown "next to the input box" (invisible at the top / 2026-08-24 device report)', () => {
  // ⚠️⚠️ The post-send "added a leading space" and **Stop's success/failure** were
  //    drawn at the top of the thread, so a user near the input box **never once saw them**.
  //    ⇒ The input box is `position: fixed`, so anything put there is always visible.
  const thread = readFileSync(new URL('./Thread.tsx', import.meta.url), 'utf8')
  const composer = readFileSync(new URL('./Composer.tsx', import.meta.url), 'utf8')
  assert.match(thread, /result=\{note\}/, 'result is not passed to the input box')
  assert.match(composer, /result \?/, 'the input box does not render the result')
  // ★ Stop's failure also goes in **the same place** (not in the top error)
  assert.match(thread, /setNote\(\{ bad: true/, 'the reason for failing to stop is in a place no one sees')
  // ⚠️ No stale drawing left at the top
  assert.ok(!/\{notice \?/.test(thread), 'the top drawing remains')
})

test('★★ the three notices (send, stop, neutralise) share one container', () => {
  // ⚠️ Adding more places for notices brings back "drawn but invisible" (2026-08-24 device report).
  //   ★ The component is recreated per target (`<Thread key=…>`), so notices need not carry a target.
  const thread = readFileSync(new URL('./Thread.tsx', import.meta.url), 'utf8')
  for (const [text, what] of [
    // ★ 2026-09-23: switched by language, so it goes through functions (`stopSentNote()` / `neutralizedNote()`)
    // ★ 2026-09-24: passes whether the input box was cleared too (`stopSentNote(res.cleared === true)`)
    ['stopSentNote\\(res\\.cleared === true', 'the stop notice'],
    ['neutralizedNote\\(\\)', 'the neutralisation notice'],
    ['COMMAND_UI\\[target\\.id\\]\\.sent', 'the command notice'],
  ] as const) {
    assert.match(thread, new RegExp(`setNote\\([^)]*${text}`), `${what} does not go through setNote`)
  }
  // ⚠️ Gather notices into one state (a separate container makes one of them invisible)
  assert.equal(
    [...thread.matchAll(/useState<\{ bad: boolean; text: string \}>/g)].length,
    1,
    'more than one notice container',
  )
})

test('★★ "Stopping…" is always cleared (pressing it does not freeze)', () => {
  // ⚠️ codex round 8 mutant #4: turning `finally { setStopping(false) }` into `true`
  //    stayed green because the switch effect's `setStopping(false)` satisfied the structural test.
  const thread = readFileSync(new URL('./Thread.tsx', import.meta.url), 'utf8')
  const stop = thread.slice(thread.indexOf('const stop = async'), thread.indexOf('const loadOlder'))
  assert.match(stop, /finally \{[\s\S]{0,80}setStopping\(false\)/, 'not cleared after stopping')
  assert.ok(!/finally \{[\s\S]{0,80}setStopping\(true\)/.test(stop), 'sets true when clearing')
})
