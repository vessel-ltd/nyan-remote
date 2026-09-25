import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hhmm, hhmmss } from './time.ts'

// ★★ What this test protects:
//
//   Slicing an ISO string with `slice(11, 16)` **shows UTC as-is**.
//   We actually shipped that bug and thread times were off by 9 hours (recorded in CLAUDE.md).
//   It "looks like it works", so it's easy to miss = without a test it comes back.
//
// ⚠️ Do not assert locale-dependent characters (AM/PM, separators).
//    Node is en-US and the phone is ja-JP, so exact matches fail depending on the environment.
//    Only check **the hour and minute digits** and **that the result changes with the time zone**.

/** Run with TZ swapped. Node reflects changes to process.env.TZ in Date */
function inTz<T>(tz: string, fn: () => T): T {
  const before = process.env.TZ
  process.env.TZ = tz
  try {
    return fn()
  } finally {
    if (before === undefined) delete process.env.TZ
    else process.env.TZ = before
  }
}

const UTC_0030 = '2026-08-13T00:30:00.000Z'

test('★★ hhmm: formats in the device time zone (never shows UTC)', () => {
  const jst = inTz('Asia/Tokyo', () => hhmm(UTC_0030))
  // JST is +9, so 09:30. Check digits only (some environments add AM/PM)
  assert.match(jst, /\b09\b/, `hour is not in JST: ${jst}`)
  assert.match(jst, /:30/, `minutes missing: ${jst}`)

  // ★ This is the point. Must not equal the sliced ISO string
  assert.notEqual(jst, UTC_0030.slice(11, 16), 'UTC shown as-is (same as slice(11,16))')
})

test('★ hhmm: result changes when the time zone changes (not returning a fixed value)', () => {
  const jst = inTz('Asia/Tokyo', () => hhmm(UTC_0030))
  const utc = inTz('UTC', () => hhmm(UTC_0030))
  const ny = inTz('America/New_York', () => hhmm(UTC_0030))
  assert.notEqual(jst, utc)
  assert.notEqual(jst, ny)
  // 00:30 in UTC (may be written 12:30 AM, so check minutes only)
  assert.match(utc, /:30/)
})

test('★ hhmm: hour stays correct across a date boundary', () => {
  // 23:00Z the previous day is 08:00 the next day in JST. The date carry must not break the hour
  const jst = inTz('Asia/Tokyo', () => hhmm('2026-08-12T23:00:00.000Z'))
  assert.match(jst, /\b08\b/, `hour shifted by the carry: ${jst}`)
  assert.match(jst, /:00/)
})

test('hhmmss: shows seconds', () => {
  const jst = inTz('Asia/Tokyo', () => hhmmss('2026-08-13T00:30:45.000Z'))
  assert.match(jst, /\b09\b/)
  assert.match(jst, /:30/)
  assert.match(jst, /:45/, `seconds missing: ${jst}`)
})

test('hhmm / hhmmss: empty string for empty or broken input (never "Invalid Date")', () => {
  // ⚠️ If this is not an empty string, the list chips fill with "Invalid Date"
  assert.equal(hhmm(undefined), '')
  assert.equal(hhmm(''), '')
  assert.equal(hhmm('これは時刻ではない'), '')
  assert.equal(hhmmss(undefined), '')
  assert.equal(hhmmss('2026-13-45T99:99:99Z'), '')
})
