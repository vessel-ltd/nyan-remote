import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addedKeys, baseKey, boundaryVisible, needsPermSignal, permArea, signalTarget } from './scroll.ts'

// ★★ Landing point and signal decisions. **Moved out of `.tsx` so mutation tests can turn red**
//    (with string guards, "a mutant reverting the boundary condition" slipped through / codex review, medium #1, #5).

const VH = 844

test('★★ is the boundary on screen (dropping `top >= 0` causes yank-back)', () => {
  assert.equal(boundaryVisible(422, VH), true, 'in the middle of the screen')
  assert.equal(boundaryVisible(0, VH), true, 'exactly at the top')
  assert.equal(boundaryVisible(843, VH), true, 'just above the bottom')
  assert.equal(boundaryVisible(844, VH), false, 'below the bottom')
  // ⚠️⚠️ The key point: **someone reading inside a card** (the boundary is above the screen)
  assert.equal(boundaryVisible(-1, VH), false, 'the check would steal the view from someone reading inside a card')
  assert.equal(boundaryVisible(-2300, VH), false)
  assert.equal(boundaryVisible(undefined, VH), false, 'if it cannot be measured, do not scroll')
})

// ★ The actually visible range (below the sticky bar to above the input box)
const TOP = 100
const BOT = 700

test('★★ does the approval card fit within the visible range', () => {
  const A = (top: number, bottom: number) => permArea(top, bottom, TOP, BOT)
  assert.deepEqual(A(150, 600), { visible: true, clippedAbove: false, clippedBelow: false }, 'fully visible')
  assert.deepEqual(A(150, 900), { visible: true, clippedAbove: false, clippedBelow: true }, 'bottom clipped')
  assert.deepEqual(A(-500, 600), { visible: true, clippedAbove: true, clippedBelow: false }, 'top clipped')
  assert.deepEqual(A(-500, 900), { visible: true, clippedAbove: true, clippedBelow: true }, 'larger than the screen')
  assert.deepEqual(A(800, 1200), { visible: false, clippedAbove: false, clippedBelow: true }, 'still below')
  assert.deepEqual(A(-900, -200), { visible: false, clippedAbove: true, clippedBelow: false }, 'scrolled away upward')
  // ⚠️⚠️ **Behind the bar and the input box is "not visible"** (measuring 0…screen height treats it as visible)
  assert.equal(A(20, 90).visible, false, 'treats the area behind the sticky bar as visible')
  assert.equal(A(720, 800).visible, false, 'treats the area behind the input box as visible')
  // When it cannot be measured, no signal (no flashing)
  assert.deepEqual(permArea(undefined, 10, TOP, BOT), { visible: true, clippedAbove: false, clippedBelow: false })
})

test('★★ the signal is hidden only when everything is within the visible range', () => {
  const A = (top: number, bottom: number) => permArea(top, bottom, TOP, BOT)
  assert.equal(needsPermSignal(A(150, 600), 1), false, 'fully visible')
  assert.equal(needsPermSignal(A(150, 900), 2), true, 'bottom clipped (answer buttons below)')
  // ⚠️ Continuation of the hole found in a real browser: **a tall card with only its bottom edge visible**
  assert.equal(needsPermSignal(A(-500, 650), 1), true, 'no signal although the top is clipped')
  assert.equal(needsPermSignal(A(-900, -200), 1), true, 'scrolled away upward (after sending an instruction)')
  assert.equal(needsPermSignal(A(150, 600), 0), false, 'no approvals, no signal')
})

test('★★ direction when the signal is pressed (no press that does nothing)', () => {
  const A = (top: number, bottom: number) => permArea(top, bottom, TOP, BOT)
  assert.equal(signalTarget(A(150, 900)), 'down', 'bottom clipped ⇒ down (to the answer buttons)')
  assert.equal(signalTarget(A(-500, 900)), 'down', 'both clipped ⇒ down (show the rest)')
  assert.equal(signalTarget(A(-900, -200)), 'up', 'scrolled away upward ⇒ up')
  assert.equal(signalTarget(A(800, 1200)), 'down', 'still below')
})

test('★★ strip the key generation (`#random`) before comparing (no scrolling on the same approval re-entering)', () => {
  // ⚠️ The agent returns `keyOf(...)#<random>` (so an old card's Allow cannot go to a later request).
  //    Comparing as-is, **the same approval merely re-entering the hook counts as "increased"**,
  //    moving the reading position although the count did not change (2026-08-19 codex round 3, medium #1)
  assert.equal(baseKey('abc#0011aabb2233'), 'abc')
  assert.equal(baseKey('abc'), 'abc', 'does not break keys without a generation')
  assert.equal(addedKeys(['abc#1111'], ['abc#2222']), 0, 're-entry of the same approval counted as "increased"')
  assert.equal(addedKeys(['abc#1111'], ['abc#2222', 'xyz#3333']), 1, 'counts only real additions')
})

test('★★ scroll only on increase (no yank-back when answering reduces them)', () => {
  assert.equal(addedKeys([], ['a']), 1, 'first card')
  assert.equal(addedKeys(['a'], ['a', 'b']), 1, 'a second card was added')
  assert.equal(addedKeys(['a', 'b'], ['b']), 0, 'reduced by answering')
  assert.equal(addedKeys(['a', 'b'], ['b', 'a']), 0, 'only reordered')
  assert.equal(addedKeys(['a'], []), 0, 'all answered')
  assert.equal(addedKeys(['a'], ['b']), 1, 'replaced (a new one has arrived)')
})
