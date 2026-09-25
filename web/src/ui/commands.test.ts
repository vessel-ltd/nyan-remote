import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionSummary } from '../../../shared/types.ts'
import type { AgentFeature } from '../../../shared/types.ts'
import type { ConfirmKind, KeyedConfirmKind } from './commands.ts'
import {
  COMMAND_UI,
  DRAFT_WARNING,
  commandView,
  confirmNote,
  confirmTitle,
  isCurrentTarget,
  releaseRunning, autoApproveLongLabel } from './commands.ts'

/**
 * ★ Operations `commandView` handles (= **things delivered to the TUI by keystrokes**).
 * ⚠️⚠️ `auto-approve` is not included (separated by type: `KeyedConfirmKind` in `commands.ts`).
 *    ⇒ Adding it here means **auto-approve cannot be turned off for sessions that cannot take keystrokes**
 */
const IDS: KeyedConfirmKind[] = ['compact', 'exit', 'clear']
/** ★ Check **every** entry in the wording table (including `auto-approve`) */
const ALL_IDS: ConfirmKind[] = [...IDS, 'auto-approve']
/** ★ A new agent (has every endpoint) */
const ALL: AgentFeature[] = ['slash-commands', 'clear-input', 'auto-approve']

const live = (extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    machine: 'm',
    account: '.claude-r',
    sessionId: 'sid',
    live: true,
    sendRoute: 'keys',
    ...extra,
  }) as SessionSummary

test('★★ wording differs per id and never claims "done"', () => {
  const seen = new Set<string>()
  for (const id of ALL_IDS) {
    const ui = COMMAND_UI[id]
    for (const [name, text] of Object.entries(ui)) {
      assert.ok(text.length > 0, `${id}.${name} is empty`)
      assert.ok(!seen.has(text), `${id}.${name} has the same wording as another`)
      seen.add(text)
    }
  }

  // ★★ Only **things delivered to the TUI by keystrokes** can say no more than "it arrived".
  //   ⚠️⚠️ Do not mix `auto-approve` in here (why `ALL_IDS` is not used).
  //      That endpoint changes **the agent's own state**, which is settled once the response returns.
  //      Writing "sent" would **read as if it has not taken effect yet** (a lie the other way).
  for (const id of IDS) {
    const ui = COMMAND_UI[id]
    // ⚠️ All we know is "it arrived" (same reason as `InterruptResult`)
    assert.ok(!/しました。|完了しました/.test(ui.sent), `${id}: claims it took effect: ${ui.sent}`)
    assert.ok(/送りました/.test(ui.sent), `${id}: does not say it was sent: ${ui.sent}`)
  }
})

test('★★★ the /exit confirmation always says "irreversible" and "pending approvals disappear too"', () => {
  const body = COMMAND_UI.exit.body
  assert.ok(/取り返しがつかない|取り返しがつきません/.test(body), `wording: ${body}`)
  assert.ok(/承認/.test(body), `does not say pending approvals disappear: ${body}`)
  assert.ok(/終了/.test(COMMAND_UI.exit.title), `heading does not say what it does: ${COMMAND_UI.exit.title}`)
})

test('★ the compact confirmation also says it cannot be undone', () => {
  assert.ok(/戻せません|戻せない/.test(COMMAND_UI.compact.body), COMMAND_UI.compact.body)
})

test('★★★ the draft note says "sent along too" and "runs if it starts with / or !"', () => {
  // ⚠️⚠️ codex high #1, 2026-08-25: "it only adds an extra message (fail-safe)" was **wrong**.
  //    A CR is sent at the end, so a draft starting with `!` **runs in bash mode**.
  assert.ok(/一緒に送信/.test(DRAFT_WARNING), `does not say the draft is sent: ${DRAFT_WARNING}`)
  assert.ok(/実行されません/.test(DRAFT_WARNING), `does not say this action does not run: ${DRAFT_WARNING}`)
  assert.ok(/`\/`|\//.test(DRAFT_WARNING) && /!/.test(DRAFT_WARNING), `nothing about / and !: ${DRAFT_WARNING}`)
  assert.ok(/コマンドとして実行/.test(DRAFT_WARNING), `⚠️ does not say it may run: ${DRAFT_WARNING}`)
  // ⚠️⚠️ Do not claim what cannot be guaranteed. ★ Also kill **the mutation that reverts to the old wrong claim**
  //    (named by codex: appending "if it fails, it only adds an extra message" at the end)
  for (const banned of ['安全', '大丈夫', 'fail-safe', '発言が増えるだけ', '取り返しがつく']) {
    assert.ok(!DRAFT_WARNING.includes(banned), `claims something it cannot guarantee (${banned})`)
  }
})

test('★★ not shown for sessions that are not alive', () => {
  for (const id of IDS) {
    assert.equal(commandView(undefined, id, 'ready', ALL).show, false)
    assert.equal(commandView(live({ live: false }), id, 'ready', ALL).show, false)
  }
})

test('★★★ not shown for sessions that cannot take keystrokes (no button that always fails when pressed)', () => {
  for (const id of IDS) {
    // Old agent (no marker at all) ⇒ no POST …/command, so 404
    assert.equal(commandView(live({ sendRoute: undefined }), id, 'ready', ALL).show, false, `${id}: shown to an old agent`)
    // ⚠️ Inbox only ⇒ the agent always refuses with `no-relay` (codex low #1)
    assert.equal(commandView(live({ sendRoute: 'inbox' }), id, 'ready', ALL).show, false, `${id}: shown for inbox`)
    assert.equal(commandView(live({ sendRoute: 'keys' }), id, 'ready', ALL).show, true, `${id}: not shown for keys`)
  }
})

test('★★★ the confirmation heading includes the target name (do not let a swapped target be pressed)', () => {
  const named = confirmTitle('exit', live({ title: 'meta広告' }) as SessionSummary)
  assert.match(named, /meta広告/, `target is unclear: ${named}`)
  assert.match(named, /終了/, `unclear what it does: ${named}`)
  // ★ Without a name it falls back to the plain heading (never shows ": undefined")
  const anon = confirmTitle('exit', undefined)
  assert.equal(anon, COMMAND_UI.exit.title)
  assert.ok(!anon.includes('undefined'), anon)
})

test('★ shown whenever alive, regardless of status (refusing is the agent\'s job)', () => {
  for (const id of IDS) {
    for (const status of ['working', 'idle', 'waiting', 'done'] as const) {
      const v = commandView(live({ status }), id, 'ready', ALL)
      assert.equal(v.show, true, `hidden for ${id}/${status}`)
      assert.equal(v.disabled, false)
    }
  }
})

test('★★ cannot be pressed while sending (never run twice on a double tap)', () => {
  for (const id of IDS) {
    const v = commandView(live(), id, 'sending', ALL)
    assert.equal(v.show, true)
    assert.equal(v.disabled, true, `${id}: pressable while sending`)
    assert.notEqual(v.label, COMMAND_UI[id].label, `${id}: not clear that it is sending`)
  }
})

test('★★★ the confirmation is shown only if it matches "the target when opened" (closes the one-frame gap on switch)', () => {
  // ⚠️⚠️ codex round 6, high #1, 2026-08-25: the switch's `useEffect` runs **after paint**, so
  //    for one frame "a confirmation opened on A shows over B".
  //    Pressing then **sends `/exit` to B**. ⇒ Check the target on every render.
  const t = { id: 'exit' as const, sessionId: 'A', endpointId: 'e1' }
  assert.equal(isCurrentTarget(t, 'A', 'e1'), true)
  // Different session ⇒ do not show
  assert.equal(isCurrentTarget(t, 'B', 'e1'), false)
  // ★ Same sessionId but **a different machine** is a different thing (the same id can exist on two machines)
  assert.equal(isCurrentTarget(t, 'A', 'e2'), false)
  assert.equal(isCurrentTarget(undefined, 'A', 'e1'), false)
})

test('★★ heading differs per id (the compact confirmation does not become the end confirmation)', () => {
  // ⚠️ Mutation named by codex: `COMMAND_UI[id]` → `COMMAND_UI.exit`
  const s = live({ title: 'x' }) as SessionSummary
  assert.match(confirmTitle('compact', s), /圧縮/)
  assert.ok(!confirmTitle('compact', s).includes('終了'), '"end" appears in the compact confirmation')
  assert.match(confirmTitle('exit', s), /終了/)
})

test('★★ the name is for noticeability, not a safeguard (identical names can coexist)', () => {
  // ⚠️ Second half of codex round 6, high #1: if A and B share a name, the headings are the same.
  //    ⇒ The safeguard must be on the `isCurrentTarget` side (compares **session and machine ids**)
  const a = confirmTitle('exit', live({ title: '同じ名前', sessionId: 'A' }) as SessionSummary)
  const b = confirmTitle('exit', live({ title: '同じ名前', sessionId: 'B' }) as SessionSummary)
  assert.equal(a, b, 'premise changed (names alone can now tell them apart)')
  assert.equal(isCurrentTarget({ sessionId: 'A', endpointId: 'e' }, 'B', 'e'), false)
})

test('★★★ notes are per operation (`clear` does not show "the draft is sent too")', () => {
  // ⚠️ Showing the same note everywhere means **nobody reads it**. `clear` sends nothing, so it is irrelevant.
  assert.equal(confirmNote('compact'), DRAFT_WARNING)
  assert.equal(confirmNote('exit'), DRAFT_WARNING)
  assert.equal(confirmNote('clear'), undefined, 'an irrelevant note is shown for clear')
})

test('★★ the `clear` confirmation says "the draft is lost too" and "cannot be undone"', () => {
  const body = COMMAND_UI.clear.body
  assert.match(body, /下書き/, `does not say the draft is lost: ${body}`)
  assert.match(body, /戻せません|戻せない/, `does not say it is irreversible: ${body}`)
  // ⚠️ Do not make it about "sending" (it only clears)
  assert.ok(!/送信/.test(body), `talk of sending is mixed in: ${body}`)
})

test('★★★ releaseRunning: clears only the marker we set (an old run does not release a newer one)', () => {
  // ⚠️⚠️ codex round 7, medium #2, 2026-08-25. The post-completion check looked at closure values, so
  //    it **always succeeded** (= A's `finally` could release B's "running").
  //    ⇒ Compare against the current state (`prev`) and a **per-run token**.
  const mine = { id: 'compact' as const, sessionId: 'A', endpointId: 'e1', token: 7 }
  assert.equal(releaseRunning(mine, 7), undefined, 'our own marker is not cleared')
  // ★ Keep a marker set by another run (e.g. clear started while compact is running)
  const other = { ...mine, id: 'clear' as const, token: 8 }
  assert.equal(releaseRunning(other, 7), other, 'clears someone else\'s marker')
  // ★★ Same session and same operation, but a different token is a different run (an earlier run does not clear a later one)
  const newer = { ...mine, token: 9 }
  assert.equal(releaseRunning(newer, 7), newer, 'ignores the token (clears a newer run)')
  assert.equal(releaseRunning(undefined, 7), undefined)
})

test('★★★ no button for agents lacking the endpoint (no button that returns 404)', () => {
  // ⚠️⚠️ codex round 7, medium #3, 2026-08-25. Measured: on an old-agent equivalent (only `sendRoute:'keys'`)
  //    "Clear input" appeared, and pressing it gave **404**. ⇒ Decide by **the feature marker**.
  const s = live()
  // No marker (old agents do not return `features`) ⇒ none of the three are shown
  for (const id of IDS) {
    assert.equal(commandView(s, id, 'ready', undefined).show, false, `${id}: shown with no marker`)
    assert.equal(commandView(s, id, 'ready', []).show, false, `${id}: shown with an empty marker list`)
  }
  // ★ An agent with only one of them (has `/command` but not `/clear`)
  const onlyCommands = commandView(s, 'clear', 'ready', ['slash-commands'])
  assert.equal(onlyCommands.show, false, '"clear" is shown without clear-input')
  for (const id of ['compact', 'exit'] as const) {
    assert.equal(commandView(s, id, 'ready', ['slash-commands']).show, true, `${id} is not shown`)
  }
  // ★ The reverse (only `/clear`) does not get mixed up either
  assert.equal(commandView(s, 'compact', 'ready', ['clear-input']).show, false)
  assert.equal(commandView(s, 'clear', 'ready', ['clear-input']).show, true)
})

test('★★★ the auto-approve confirmation says concretely what passes automatically', () => {
  // ⚠️⚠️ Here **explaining the danger is the point** (since we decided not to add an exclusion list / 2026-09-07).
  //    "Skips approvals" alone does not make the person pressing it understand that `Bash` runs silently
  const ui = COMMAND_UI['auto-approve']
  // ★ 2026-09-24: the duration is now chosen ⇒ the body says "the chosen time", the buttons say the length
  for (const must of ['選んだ時間', 'はい/いいえ', 'コマンド']) {
    assert.ok(ui.body.includes(must), `confirmation body lacks "${must}": ${ui.body}`)
  }
  assert.ok(ui.ok.includes('3時間'), `the 3-hour button does not state its length: ${ui.ok}`)
  assert.ok(autoApproveLongLabel().includes('24時間'), `the 24-hour button does not state its length: ${autoApproveLongLabel()}`)
  // ★ Also say what still stops (choices, plans) (= do not suggest everything passes)
  assert.ok(/選択肢|プラン/.test(ui.body), `does not say what still stops: ${ui.body}`)
  // ⚠️ Do not claim what cannot be guaranteed
  for (const banned of ['安全', '大丈夫', '取り消せます', 'いつでも戻せます']) {
    assert.ok(!ui.body.includes(banned), `claims something it cannot guarantee (${banned}): ${ui.body}`)
  }
  // ★ Conversely, this one **may state that it took effect** (it is the agent's own state, so the response = settled).
  //   ⚠️ Using "sent" like the keystroke endpoints (`/compact`) would read as if it has not taken effect yet
  assert.ok(/しました/.test(ui.sent), `unclear that it took effect: ${ui.sent}`)
  assert.ok(/3時間|自動で切れ/.test(ui.sent), `the expiry is not readable: ${ui.sent}`)
  // ★★ **No** keystroke note (the draft is sent along too) — this path types not a single byte, so it would be a lie
  assert.equal(confirmNote('auto-approve'), undefined)
  // Contrast: things sent by keystrokes do get it
  assert.equal(confirmNote('compact'), DRAFT_WARNING)
})

test('★★★★ the 24-hour button is shown only to agents with the auto-approve-24h marker (2026-09-24)', async () => {
  const { readFileSync } = await import('node:fs')
  // ⚠️ `.tsx` has no runtime tests, so check the wiring in executed lines (drop comments)
  const src = readFileSync(new URL('./Thread.tsx', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
  assert.match(
    src,
    /confirm\.id === 'auto-approve' && features\?\.includes\('auto-approve-24h'\)[\s\S]{0,200}duration: '24h'/,
    '⚠️⚠️ the 24-hour button is shown without the marker (an old agent does not know the name and uses 3 hours = mismatch with the screen)',
  )
  // ★ The message is built from the expiry the agent returned (do not add to the device clock)
  assert.match(src, /autoApproveOnText\(res\.until\)/)
})
