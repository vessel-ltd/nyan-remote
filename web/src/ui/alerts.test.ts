import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PermissionRequest, SessionSummary } from '../../../shared/types.ts'
import { buildAlertInput, nextAlert, type AlertSource, type ThreadAlert } from './alerts.ts'

// ★★ The single line for "something waiting in another thread" (2026-08-18 user request).
//
// ⚠️ If this is wrong, **a dead end you can press but do nothing with** squats at the head of the queue.
//    This pins down the split between "answerable approvals (orange)" and "unanswerable needs-attention (gray)".
//
// ⚠️⚠️ **The entry point is `buildAlertInput` (endpoint state)** (same day's codex review, low #2).
//    Tests that hand in a pre-built `AlertInput` **turn every assembly bug green**.
//    Three were actually missed that way (another machine's `quiet` hides the gray line / a downed
//    machine's `quiet` lingers / a machine with only synthesized rows gets no machine name).

function perm(over: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    key: 'k1',
    machine: 'pc-a',
    account: '.claude-r',
    project: 'proj',
    sessionId: 'S1',
    toolName: 'Bash',
    summary: 'echo hi',
    at: '2026-08-18T05:00:00.000Z',
    ...over,
  }
}

function sess(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    machine: 'pc-a',
    account: '.claude-r',
    sessionId: 'S1',
    cwd: '/home/x/proj',
    project: 'proj',
    title: '名前',
    titleSource: 'ai',
    status: 'working',
    live: true,
    lastActivity: '2026-08-18T05:00:00.000Z',
    transcriptBytes: 100,
    ...over,
  }
}

/** One endpoint. ★ Default is "fetched, no quiet" */
function src(over: Partial<AlertSource> = {}): AlertSource {
  return {
    endpointId: 'e1',
    sessions: [],
    permissions: [],
    permissionsKnown: true,
    ...over,
  }
}

/** Runs through the production path (shape `main.tsx` passes -> build -> decide) */
function ask(sources: AlertSource[], openSessionId = 'OPEN'): ThreadAlert | null {
  return nextAlert(buildAlertInput(sources, openSessionId))
}

test('★★ does not show approvals of the open thread itself (that is the job of "承認 N 件 ↓" below)', () => {
  assert.equal(ask([src({ permissions: [perm({ sessionId: 'OPEN' })] })], 'OPEN'), null)
})

test('★★ shows another thread\'s approval in orange, with count, tool name and title', () => {
  const a = ask([
    src({
      sessions: [sess({ sessionId: 'A', title: 'ドキュメント整理' })],
      permissions: [perm({ key: 'a', sessionId: 'A' }), perm({ key: 'b', sessionId: 'B' })],
    }),
  ])
  assert.deepEqual(a, {
    kind: 'permission',
    count: 2,
    sessionId: 'A',
    title: 'ドキュメント整理',
    detail: 'Bash',
  })
})

test('★★ picks the head in FIFO (oldest first) order', () => {
  const a = ask([
    src({
      permissions: [
        perm({ key: 'new', sessionId: 'NEW', at: '2026-08-18T06:00:00.000Z' }),
        perm({ key: 'old', sessionId: 'OLD', at: '2026-08-18T04:00:00.000Z' }),
        perm({ key: 'mid', sessionId: 'MID', at: '2026-08-18T05:00:00.000Z' }),
      ],
    }),
  ])
  assert.equal(a?.sessionId, 'OLD')
  assert.equal(a?.count, 3)
})

test('★ a card with an unparsable time does not squat at the head (does not break the order)', () => {
  const broken = perm({ key: 'broken', sessionId: 'BROKEN', at: 'ゴミ' })
  const ok = perm({ key: 'ok', sessionId: 'OK', at: '2026-08-18T05:00:00.000Z' })
  // ⚠️⚠️ **Check both orderings.** With 2 elements `sort` calls the comparator with only one argument order,
  //    so half of the NaN branches never run (it survived mutation testing / 2026-08-18)
  for (const permissions of [
    [broken, ok],
    [ok, broken],
  ]) {
    const a = ask([src({ permissions })])
    assert.equal(a?.sessionId, 'OK')
    // ⚠️ But it is not dropped from the count (losing something that needs an answer is worse)
    assert.equal(a?.count, 2)
  }
})

test('★ ties on time are broken by key (no reshuffling on each render)', () => {
  const at = '2026-08-18T05:00:00.000Z'
  const A = perm({ key: 'a', sessionId: 'A', at })
  const B = perm({ key: 'b', sessionId: 'B', at })
  const one = ask([src({ permissions: [B, A] })])
  const two = ask([src({ permissions: [A, B] })])
  assert.equal(one?.sessionId, 'A')
  assert.deepEqual(one, two)
})

test('★ a card without sessionId has no jump target, so it is not used', () => {
  assert.equal(ask([src({ permissions: [perm({ sessionId: undefined })] })]), null)
})

test('★★ does not append the tool name if the title already contains it (synthesized rows would double it)', () => {
  // An approval with no transcript yet becomes a synthesized row (`承認待ち · Bash`).
  // Appending the tool name blindly would give "承認待ち · Bash・Bash"
  const a = ask([src({ permissions: [perm({ sessionId: 'ORPHAN' })] })])
  assert.equal(a?.title, '承認待ち · Bash')
  assert.equal(a?.detail, undefined, 'do not show the tool name twice')
})

test('★ with no rows at all, falls back to the head of the ID (last resort for the type)', () => {
  // ⚠️ `buildAlertInput` creates synthesized rows, so **this shape never occurs in production**.
  //    Still, `find` can return undefined, so we only pin down that it shows the ID rather than inventing a name
  const a = nextAlert({
    perms: [{ ...perm({ sessionId: 'AAAAAAAAAAAA' }), endpointId: 'e1' }],
    attention: [],
    sessions: [],
    showMachine: false,
    openSessionId: 'OPEN',
  })
  assert.equal(a?.title, 'AAAAAAAA')
})

// ── Gray (needs attention, not answerable)

test('★★ shows unanswerable needs-attention in gray (with the reason if any)', () => {
  const stuck = sess({
    sessionId: 'STUCK',
    title: 'git-push修正',
    status: 'waiting',
    waitingFor: 'input needed',
  })
  assert.deepEqual(ask([src({ sessions: [stuck] })]), {
    kind: 'attention',
    count: 1,
    sessionId: 'STUCK',
    title: 'git-push修正',
    detail: '入力が必要',
  })
})

test('★★ adds no reason when there is none (does not invent one)', () => {
  const a = ask([src({ sessions: [sess({ sessionId: 'STUCK', status: 'waiting' })] })])
  assert.equal(a?.kind, 'attention')
  assert.equal(a?.detail, undefined)
})

test('★★ shows no gray if there is even one orange (the answerable one is urgent)', () => {
  const a = ask([
    src({
      sessions: [sess({ sessionId: 'STUCK', status: 'waiting' })],
      permissions: [perm({ sessionId: 'CARD' })],
    }),
  ])
  assert.equal(a?.kind, 'permission')
  assert.equal(a?.sessionId, 'CARD')
})

test('★ sessions that do not need attention or have ended are not gray', () => {
  const rows = [
    sess({ sessionId: 'W', status: 'working' }),
    sess({ sessionId: 'D', status: 'done' }),
    sess({ sessionId: 'DEAD', status: 'waiting', live: false }),
  ]
  assert.equal(ask([src({ sessions: rows })]), null)
})

test('★ gray is FIFO too (longest-neglected first)', () => {
  const rows = [
    sess({ sessionId: 'NEW', status: 'waiting', lastActivity: '2026-08-18T06:00:00.000Z' }),
    sess({ sessionId: 'OLD', status: 'waiting', lastActivity: '2026-08-18T04:00:00.000Z' }),
  ]
  const a = ask([src({ sessions: rows })], 'X')
  assert.equal(a?.sessionId, 'OLD')
  assert.equal(a?.count, 2)
})

test('★★ sessions of a machine whose fetch failed are not shown as gray (no fail-open)', () => {
  // ⚠️ Confusing "zero cards" with "we don't know about the cards"
  //    **says "handle on the PC" while a live card exists**
  const stuck = sess({ sessionId: 'MAYBE', status: 'waiting' })
  assert.equal(ask([src({ sessions: [stuck], permissionsKnown: false })]), null)
})

// ── ★★ quiet (approvals appearing in a few seconds) is **per endpoint** (codex review, medium #2)

test('★★ while an endpoint has quiet, its gray line is not shown', () => {
  const stuck = sess({ sessionId: 'STUCK', status: 'waiting' })
  assert.equal(ask([src({ sessions: [stuck], quietPermissions: 1 })]), null)
})

test('★★ another endpoint\'s quiet does not hide the gray line (must not judge by the sum)', () => {
  // ⚠️ The shape we actually hit: summing across all machines, **an unrelated machine's quiet**
  //    hid "needs attention (handle on the PC)". And since `markOffline` did not clear quiet,
  //    **a downed machine's stale quiet could hide it indefinitely**
  const stuck = sess({ sessionId: 'STUCK', status: 'waiting', machine: 'pc-a' })
  const a = ask([
    src({ endpointId: 'e1', sessions: [stuck] }),
    src({ endpointId: 'e2', quietPermissions: 3, sessions: [sess({ sessionId: 'OTHER' })] }),
  ])
  assert.equal(a?.kind, 'attention')
  assert.equal(a?.sessionId, 'STUCK')
})

test('★ orange is shown even with quiet (the card existing is itself the evidence)', () => {
  const a = ask([src({ permissions: [perm({ sessionId: 'CARD' })], quietPermissions: 1 })])
  assert.equal(a?.kind, 'permission')
})

// ── ★★ Machine name (codex review, low #1 and low #4)

test('★★ machine name only with 2 or more machines (you need to know which PC to go to)', () => {
  const one = ask([src({ permissions: [perm({ sessionId: 'A', machine: 'pc-b' })] })])
  assert.equal(one?.machine, undefined, 'with one machine the name carries no information')

  const two = ask([
    src({
      endpointId: 'e1',
      sessions: [sess({ sessionId: 'X', machine: 'pc-a' })],
      permissions: [perm({ sessionId: 'A', machine: 'pc-b' })],
    }),
  ])
  assert.equal(two?.machine, 'pc-b')
})

test('★★ shows machine names even if the second machine has only synthesized rows (same row set as the list)', () => {
  // ⚠️ The shape we actually hit: the machine set was built only from `merged` (from `/sessions`),
  //    so a second machine that hit **an approval on its first turn** was not counted, and "which PC's approval" was not shown
  const a = ask([
    src({
      endpointId: 'e1',
      sessions: [sess({ sessionId: 'X', machine: 'pc-a' })],
      permissions: [perm({ sessionId: 'FIRSTTURN', machine: 'pc-b' })],
    }),
  ])
  assert.equal(a?.sessionId, 'FIRSTTURN')
  assert.equal(a?.machine, 'pc-b')
})

test('★ gray lines get the machine name too ("handle on the PC" is meaningless without knowing which PC)', () => {
  const a = ask([
    src({
      endpointId: 'e1',
      sessions: [
        sess({ sessionId: 'X', machine: 'pc-a' }),
        sess({ sessionId: 'STUCK', status: 'waiting', machine: 'pc-b' }),
      ],
    }),
  ])
  assert.equal(a?.machine, 'pc-b')
})
