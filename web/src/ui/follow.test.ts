import assert from 'node:assert/strict'
import { test } from 'node:test'
import { followAction } from './follow.ts'

const base = { requestGen: 1, currentGen: 1, currentTail: 100, pageTail: 200, added: 2 }

test('followAction: new appends go to the end', () => {
  assert.equal(followAction(base), 'append')
})

test('followAction: with no display entries, only the position advances', () => {
  assert.equal(followAction({ ...base, added: 0 }), 'advance')
})

test('★★ followAction: does nothing if it has not advanced', () => {
  assert.equal(followAction({ ...base, currentTail: 300, pageTail: 300 }), 'ignore')
})

test('★★ followAction: reloads when tail shrinks (the file was recreated)', () => {
  // ⚠️ Follow is serialized, so nothing arrives out of order within a generation. The shrink is real.
  //    `advance` here would start following while **everything already in the new file stays invisible**.
  assert.equal(followAction({ ...base, currentTail: 300, pageTail: 200 }), 'reset')
  // ★ But with a different generation (arrival after a switch) it is dropped, not reloaded
  assert.equal(followAction({ ...base, currentGen: 2, currentTail: 300, pageTail: 200 }), 'ignore')
})

test('★★ followAction: drops a stale response arriving after a switch (would mix in another thread)', () => {
  assert.equal(followAction({ ...base, requestGen: 1, currentGen: 2 }), 'ignore')
  // ⚠️ With a different generation, drop it even if the content is newer
  assert.equal(followAction({ ...base, requestGen: 1, currentGen: 2, pageTail: 9999 }), 'ignore')
})

test('★ followAction: tail=0 does not mean "not loaded yet" (can advance from 0 to 1)', () => {
  assert.equal(followAction({ ...base, currentTail: 0, pageTail: 1, added: 1 }), 'append')
})

test('★ followAction: a history that started over (`reload`) reloads, even with a higher tail (codex review)', () => {
  assert.equal(followAction({ ...base, added: 0, reload: true }), 'reset')
  assert.equal(followAction({ ...base, requestGen: 0, reload: true }), 'ignore', 'another session: still dropped')
})

// ★ the wiring: the page's flag reaches followAction
test('Thread.tsx passes the page\'s reload flag to followAction', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./Thread.tsx', import.meta.url), 'utf8')
  assert.match(src, /followAction\(\{[^}]*reload: page\.reload === true,[^}]*\}\)/)
})

// ★ A "load older" begun before a reload is dropped (its cursor and entries belong to the replaced history / codex review)
test('Thread.tsx: loadOlder drops its result when the thread was reloaded meanwhile', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./Thread.tsx', import.meta.url), 'utf8')
  const first = src.slice(src.indexOf('const loadFirst = async'), src.indexOf('const reconcileOlder = async'))
  assert.match(first, /if \(gen !== genRef\.current\) return\n\s*reloadRef\.current\+\+/)
  const older = src.slice(src.indexOf('const loadOlder = async'))
  assert.match(older, /const reload = reloadRef\.current/)
  assert.equal(older.slice(0, older.indexOf('setCursor(at)')).match(/reload !== reloadRef\.current/g)?.length, 2)
})
