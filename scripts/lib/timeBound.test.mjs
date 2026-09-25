// `--since` / `--until` timestamps. ⚠️ **Records are UTC, arguments are local**.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toUtcBound } from './timeBound.mjs'

test('★★★ reads as local time and converts to UTC (mixing it up with UTC gives "0 records after the fix")', () => {
  const b = toUtcBound('2026-09-01T10:42')
  assert.ok(b)
  // ★ Look at the value the implementation produces (reproduced in this machine's time zone)
  const expected = new Date(2026, 8, 1, 10, 42, 0, 0).toISOString()
  assert.equal(b.iso, expected)
  assert.equal(b.shown, '2026-09-01T10:42', 'the typed value is not kept (cannot be shown)')
})

test('★★ the month is not off (mutation `+mo - 1` → `+mo`)', () => {
  const b = toUtcBound('2026-09-01T00:00')
  assert.equal(new Date(b.iso).getMonth(), new Date(2026, 8, 1).getMonth(), 'off by one month')
  // ★ Check day and hour too (off-by-one is not only in the month)
  assert.equal(new Date(b.iso).getDate(), 1)
  assert.equal(new Date(b.iso).getHours(), 0)
})

test('★★★ rejects dates/times that do not exist (do not miss `Date` silently normalizing)', () => {
  // ⚠️⚠️ `Number.isNaN` does not catch it (2026-09-01 codex round 3, low #2)
  assert.equal(toUtcBound('2026-02-31'), null, 'Feb 31 passed (becomes March 3)')
  assert.equal(toUtcBound('2026-09-01T24:00'), null, '24:00 passed (becomes the next day)')
  assert.equal(toUtcBound('2026-13-01'), null)
  assert.equal(toUtcBound('2026-09-32'), null)
  assert.equal(toUtcBound('2026-09-01T10:60'), null)
})

test('★★ accepts leap days (the normalization check must not reject valid dates)', () => {
  assert.ok(toUtcBound('2024-02-29'), 'a leap day was rejected')
  assert.equal(toUtcBound('2026-02-29'), null, 'Feb 29 in a non-leap year passed')
})

test('★ unparseable input is null (never silently "all records")', () => {
  for (const v of ['', 'x', '2026/09/01', '26-09-01', '2026-9-1']) {
    assert.equal(toUtcBound(v), null, `${v} passed`)
  }
})

test('★ a date alone means 00:00 that day (local)', () => {
  const b = toUtcBound('2026-09-01')
  assert.equal(b.iso, new Date(2026, 8, 1, 0, 0, 0, 0).toISOString())
})
