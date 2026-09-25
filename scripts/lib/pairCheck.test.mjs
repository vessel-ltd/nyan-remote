import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mustSignIn } from './pairCheck.mjs'
import { isOurRelay } from '../../shared/distribution.ts'

const url = (r) => `nyan://pair?v=1&a=${'B'.repeat(87)}&t=${'T'.repeat(43)}&n=pc-a${r ? `&r=${encodeURIComponent(r)}` : ''}`

test('★★ stop before the QR only when our relay is in it and the agent says it is signed out', () => {
  assert.equal(mustSignIn({ pairUrl: url('wss://relay.nyan-remote.app'), account: { signedIn: false } }), true)
  // ★ The old workers.dev entry point is ours too (still alive for QR codes handed out earlier)
  assert.equal(mustSignIn({ pairUrl: url('wss://nyan-relay.nyan-remote-relay.workers.dev'), account: { signedIn: false } }), true)
  assert.equal(mustSignIn({ pairUrl: url('wss://relay.nyan-remote.app'), account: { signedIn: true } }), false)
  // ★ A self-hosted relay or no relay (Tailscale) does not need sign-in
  assert.equal(mustSignIn({ pairUrl: url('wss://relay.example.com'), account: { signedIn: false } }), false)
  assert.equal(mustSignIn({ pairUrl: url(undefined), account: { signedIn: false } }), false)
  // ⚠️ Unknown ⇒ carry on (an old agent without `account`, an unreadable reply, a broken URL)
  assert.equal(mustSignIn({ pairUrl: url('wss://relay.nyan-remote.app'), account: undefined }), false)
  assert.equal(mustSignIn({ pairUrl: url('wss://relay.nyan-remote.app'), account: {} }), false)
  assert.equal(mustSignIn({ pairUrl: 'garbage', account: { signedIn: false } }), false)
  assert.equal(mustSignIn({ pairUrl: undefined, account: { signedIn: false } }), false)
})

test('★ isOurRelay: exact host names only', () => {
  assert.equal(isOurRelay('wss://relay.nyan-remote.app'), true)
  assert.equal(isOurRelay('wss://RELAY.nyan-remote.app/'), true)
  // ★ A terminal dot is the same DNS name (codex)
  assert.equal(isOurRelay('wss://relay.nyan-remote.app./'), true)
  assert.equal(isOurRelay('wss://relay.nyan-remote.app..'), false)
  assert.equal(isOurRelay('wss://relay.nyan-remote.app.evil.example'), false)
  assert.equal(isOurRelay('wss://evil.example/relay.nyan-remote.app'), false)
  assert.equal(isOurRelay('https://relay.nyan-remote.app'), false)
  assert.equal(isOurRelay(42), false)
})
