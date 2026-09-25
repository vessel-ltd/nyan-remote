import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatTokens } from './tokens.ts'

// ★★ Formatting the amount of context (2026-08-19). **No percentage, no colour** (the window is unknown).

test('★ rounds by magnitude (k / M)', () => {
  assert.equal(formatTokens(2), '2')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1000), '1k')
  assert.equal(formatTokens(673965), '673k')
  assert.equal(formatTokens(999999), '999k')
  assert.equal(formatTokens(1_000_000), '1M')
  assert.equal(formatTokens(1_234_567), '1.2M')
})

test('★★ truncates (never make "still has room" look like "at the limit")', () => {
  assert.equal(formatTokens(673999), '673k', 'must not round up to 674k')
  assert.equal(formatTokens(1_999_999), '1.9M')
})

test('★★ shows nothing when unknown (0 must not become "0k" / no fail-open)', () => {
  assert.equal(formatTokens(undefined), undefined)
  assert.equal(formatTokens(0), undefined)
  assert.equal(formatTokens(-5), undefined)
  assert.equal(formatTokens(Number.NaN), undefined)
  assert.equal(formatTokens(Number.POSITIVE_INFINITY), undefined)
})
