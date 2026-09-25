import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LogEntry } from '../../../shared/types.ts'
import { anchoredScrollY, firstVisibleIndex, isMine, keepLoading, MAX_SCROLLBACK_PAGES, MINE_SLACK_PX, pickPrevMine, showMineJump } from './scrollback.ts'

const me: LogEntry = { kind: 'user', text: 'やって' }
const fromPhone: LogEntry = { kind: 'user', text: 'スマホから', via: 'inbox' }
const peer: LogEntry = { kind: 'user', text: '別のセッション', via: 'peer' }
const asst: LogEntry = { kind: 'assistant', text: 'はい' }

test('★★ own messages: typed on the PC or sent from the phone; those from another session are not', () => {
  assert.equal(isMine(me), true)
  assert.equal(isMine(fromPhone), true)
  assert.equal(isMine(peer), false, '⚠️ jumps to another session\'s request as if it were mine')
  assert.equal(isMine(asst), false)
})

test('★★ the nearest own message above the view (one sitting just under the bar is not re-selected)', () => {
  const view = 60
  assert.equal(pickPrevMine([-900, -300, 200, 500], view), 1)
  // ★ Pressing again right after a jump (just under the bar) goes to the one before it
  assert.equal(pickPrevMine([-900, -300, view], view), 1)
  assert.equal(pickPrevMine([-900, -300, view - MINE_SLACK_PX + 1], view), 1)
  // ⚠️ Nothing above ⇒ -1 (⇒ load more)
  assert.equal(pickPrevMine([100, 400], view), -1)
  assert.equal(pickPrevMine([], view), -1)
})

test('★★ loading more stops when an own message arrives, nothing older remains, or the cap is hit', () => {
  assert.equal(keepLoading({ entries: [asst, asst], cursor: 10 }, 1), true)
  assert.equal(keepLoading({ entries: [asst, me], cursor: 10 }, 1), false, '⚠️ keeps loading after an own message arrived')
  assert.equal(keepLoading({ entries: [asst, peer], cursor: 10 }, 1), true, '⚠️ stops at another session\'s request')
  assert.equal(keepLoading({ entries: [asst], cursor: null }, 1), false, '⚠️ keeps loading when nothing is left')
  assert.equal(keepLoading({ entries: [asst], cursor: 10 }, MAX_SCROLLBACK_PAGES), false, '⚠️ keeps loading past the cap')
})

test('★★ after loading above, scroll down by the added height (stay where you were)', () => {
  assert.equal(anchoredScrollY({ scrollY: 120, height: 3000 }, 5400), 2520)
  assert.equal(anchoredScrollY({ scrollY: 0, height: 3000 }, 3000), 0)
})

test('★★ screen wiring (loading goes through the decision function, alignment before paint, Chrome\'s auto anchoring restored)', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./Thread.tsx', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n')
  assert.match(src, /if \(!untilMine \|\| !keepLoading\(page, pages\)\) break/, '⚠️ the screen hand-rolls when to stop loading')
  assert.match(src, /const idx = firstVisibleIndex\(kids\.map\(\(el\) => el\.getBoundingClientRect\(\)\.bottom\), viewTop\(\)\)/, '⚠️ does not remember the element in view before loading')

  // ★★ Restore by the offset of the element in view (do not count growth below / codex round 19, medium #2). If none is visible, the height difference
  // ★★ Remember **the message itself** in view and look up its position after painting (not by adding offsets / codex round 20, medium #6)
  assert.match(src, /entry: idx >= 0 \? visibleRef\.current\[idx\] : undefined/, '⚠️ does not remember the message in view')
  assert.match(src, /const at = a\.entry \? visibleRef\.current\.indexOf\(a\.entry\) : -1/, '⚠️ does not re-look-up the position after painting (aligns to a different message when thinking toggles)')
  assert.match(src, /visibleRef\.current = visible/)
  assert.match(src, /window\.scrollBy\(0, el\.getBoundingClientRect\(\)\.top - a\.top\)/)
  assert.match(src, /window\.scrollTo\(0, anchoredScrollY\(a, root\.scrollHeight\)\)/, '⚠️ does not restore position after loading (jumps on Safari)')
  // ★★ Restore on leaving the screen; do nothing if completion comes after leaving (codex round 19, medium #1)
  assert.match(src, /if \(gen !== genRef\.current \|\| !threadRef\.current\) return/)
  assert.match(src, /\(\) => \(\) => \{\s*genRef\.current \+= 1\s*anchorRef\.current = null\s*document\.documentElement\.style\.overflowAnchor = ''/)
  // ⚠️⚠️ Disable Chrome's auto anchoring while loading (otherwise Chrome and we move it **twice**)
  assert.match(src, /root\.style\.overflowAnchor = 'none'/)
  // ⚠️⚠️ Restore the disabled auto anchoring (otherwise Chrome stops keeping position on later changes)
  assert.match(src, /root\.style\.overflowAnchor = ''/)
  assert.match(src, /pickPrevMine\(els\.map\(\(el\) => el\.getBoundingClientRect\(\)\.top\), viewTop\(\)\)/)
  // ⚠️ The jump target is decided in one place, `isMine` (not another session's request or a background notice)
  assert.match(src, /querySelectorAll<HTMLElement>\('\[data-mine\]'\)/)
  assert.match(src, /data-mine=\{isMine\(entry\) \? '' : undefined\}/)
})

test('★★ the alignment anchor is the first visible element (whose bottom is below the bar\'s bottom)', () => {
  assert.equal(firstVisibleIndex([-500, 20, 70, 300], 60), 2)
  assert.equal(firstVisibleIndex([-500, -100], 60), -1)
  assert.equal(firstVisibleIndex([], 60), -1)
})

test('★★ background-task completion notices (<task-notification>) are not own messages (landed there in practice)', () => {
  assert.equal(isMine({ kind: 'user', text: '<task-notification>\n<task-id>x</task-id>' }), false)
  assert.equal(isMine({ kind: 'user', text: '  <task-notification>' }), false)
  assert.equal(isMine({ kind: 'user', text: 'task-notification を調べて' }), true)
})

test('★★ "↑ My message" shows only away from the bottom, with a message of yours above (or more to load) (2026-09-25)', async () => {
  const base = { loading: false, atBottom: false, hasPrevMine: true, moreToLoad: false }
  assert.equal(showMineJump(base), true)
  assert.equal(showMineJump({ ...base, atBottom: true }), false, '⚠️ covers the reply being read at the bottom')
  assert.equal(showMineJump({ ...base, hasPrevMine: false }), false, '⚠️ nothing of yours above to jump to')
  assert.equal(showMineJump({ ...base, hasPrevMine: false, moreToLoad: true }), true, '★ older pages may hold one')
  assert.equal(showMineJump({ ...base, loading: true }), false)
  // ★ Wiring: the thread uses this decision, recomputed on scroll and when the content changes
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./Thread.tsx', import.meta.url), 'utf8')
  assert.match(src, /showMineJump\(\{ loading, atBottom, hasPrevMine, moreToLoad: cursor !== null \}\)/)
  assert.equal(src.match(/setHasPrevMine\(findPrevMine\(\) !== undefined\)/g)?.length, 2)
})
