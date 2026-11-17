import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LONG_SEND_TIMEOUT_MS, MAX_MESSAGE_BYTES, MAX_SEND_BYTES, MAX_SEND_JSON_BYTES, sendLimitBytes, sendTimeoutMs, sendTooLong } from './types.ts'
import { MAX_PAYLOAD_BYTES } from './tunnel.ts'

test('send limit: 64 KB only for an agent that says so; the old 4 KB otherwise', () => {
  assert.equal(sendLimitBytes(['long-send']), MAX_SEND_BYTES)
  assert.equal(sendLimitBytes([]), MAX_MESSAGE_BYTES)
  assert.equal(sendLimitBytes(undefined), MAX_MESSAGE_BYTES)
})

test('send limit: counted in bytes, and refused when too big once escaped as JSON (codex review)', () => {
  const just = 'あ'.repeat(Math.floor(MAX_SEND_BYTES / 3))
  assert.equal(sendTooLong(just, MAX_SEND_BYTES), false)
  assert.equal(sendTooLong(`${just}xx`, MAX_SEND_BYTES), true)
  // ⚠️ Within the byte limit, but 6 bytes each once escaped
  assert.equal(sendTooLong(`a${'\u0001'.repeat(MAX_SEND_BYTES - 1)}`, MAX_SEND_BYTES), true)
  // The escaped limit still fits the tunnel with room for the envelope
  assert.ok(MAX_SEND_JSON_BYTES + 4096 < MAX_PAYLOAD_BYTES)
})

test('send timeout: longer only for a long text', () => {
  assert.equal(sendTimeoutMs('short'), undefined)
  assert.equal(sendTimeoutMs('あ'.repeat(6000)), LONG_SEND_TIMEOUT_MS)
})
