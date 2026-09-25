// ★★ Connect PWA ↔ agent **end to end** (2026-09-15 / step 6-② of ③).
//
// ★ Only **the carrier** is fake (two tunnels connected directly). Everything passed through is real:
//   `AgentTransport` (the PWA's 20 methods) → `relayWire` → envelope → `openTunnel` →
//   the path in `serve.ts` → auth → **the real router** → response → envelope → `relayWire` → screen.
//
// ⚠️⚠️ This being green is the only evidence that "the route can be swapped".
//    One-sided tests miss **mismatches in envelope direction, kind and ID**.
//
// ⚠️ **Why it lives on the web side**: the agent tsconfig has no DOM (intentionally), so
//    importing `web/src` from agent tests fails type-checking on `location` / `PushSubscriptionJSON`.
//    ⇒ Tests connecting both sides live **on the side with the DOM**.

import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  exportPublicKey,
  finishHandshake,
  generateDeviceKey,
  startHandshake,
  toBase64Url,
} from '../../../shared/crypto.ts'
import { acceptDeviceHandshake } from '../../../agent/src/auth.ts'
import { loadConfig } from '../../../agent/src/config.ts'
import { agentPublicRaw, loadAgentKey, resetAgentKey } from '../../../agent/src/deviceKey.ts'
import { broadcast } from '../../../agent/src/events.ts'
import {
  issueOneTime,
  loadDevices,
  registerDevice,
  resetDevices,
  revokeDevice,
} from '../../../agent/src/devices.ts'
import { buildRouter } from '../../../agent/src/routes/index.ts'
import { openTunnel, type Tunnel } from '../../../agent/src/tunnel.ts'
import { AgentTransport } from './agent.ts'
import { relayWire } from './relay.ts'

/** Swap the state directory and put the agent into a "started" state */
async function boot(t: { after: (fn: () => Promise<void>) => void }): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-e2e-'))
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  const prevDev = process.env['NYAN_REMOTE_DEV']
  process.env['NYAN_REMOTE_STATE_DIR'] = dir
  delete process.env['NYAN_REMOTE_DEV']
  resetAgentKey()
  resetDevices()
  t.after(async () => {
    resetAgentKey()
    resetDevices()
    if (prev === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = prev
    if (prevDev === undefined) delete process.env['NYAN_REMOTE_DEV']
    else process.env['NYAN_REMOTE_DEV'] = prevDev
    await chmod(dir, 0o700).catch(() => {})
    await rm(dir, { recursive: true, force: true })
    await loadConfig()
  })
  await loadConfig()
  await loadAgentKey()
  await loadDevices()
}

/** Connect two tunnels directly (⚠️ WebSocket is step 6-③) */
async function e2e(t: { after: (fn: () => Promise<void>) => void }) {
  const pair = await generateDeviceKey()
  const raw = await exportPublicKey(pair.publicKey)
  assert.equal((await registerDevice(raw, 'テスト端末', issueOneTime().token)).ok, true)

  const h = await startHandshake(pair, agentPublicRaw())
  const accepted = await acceptDeviceHandshake(h.message)
  const device = await (await finishHandshake(h, accepted.reply)).accept(accepted.confirm)

  const held: { agent?: Tunnel } = {}
  const wire = relayWire({
    session: device,
    carrier: {
      send: async (frame) => {
        const res = await held.agent!.deliver(frame)
        assert.ok(res.ok, `the agent refused an envelope: ${JSON.stringify(res)}`)
      },
    },
  })
  held.agent = openTunnel({
    connection: accepted.connection,
    router: buildRouter(),
    sender: {
      send: async (frame) => {
        const res = await wire.deliver(frame)
        assert.ok(res.ok, `the PWA refused an envelope: ${JSON.stringify(res)}`)
      },
    },
  })
  t.after(async () => {
    await held.agent?.close().catch(() => {})
  })
  const transport = new AgentTransport(
    { id: 'relay', label: 'relay', url: 'relay://tunnel' },
    wire,
  )
  /**
   * ★ Wait until the chains in both directions are empty.
   *
   * ⚠️⚠️ **Waiting on only one side misses things** (actually hit on 2026-09-15): events are
   *    sealed and sent on **the agent's chain**, so the PWA side's `flush` isn't enough.
   */
  const settle = async (): Promise<void> => {
    await held.agent!.flush()
    await wire.flush()
  }
  return { transport, wire, raw, settle }
}

test('★★ the PWA Transport reaches the real router through envelopes', async (t) => {
  await boot(t)
  const { transport } = await e2e(t)

  // ★ `/health` is the value the agent actually built (machine name, feature markers)
  const health = await transport.health()
  assert.equal(health.machine, hostname())
  assert.ok(Array.isArray(health.features), 'feature markers not received')
  assert.ok(health.features.includes('device-handshake'), 'a marker is missing')

  // ★ The list passes too (⚠️ the request with `?live=1` hits the router)
  const page = await transport.listSessions({ history: false })
  assert.equal(page.machine, hostname())
  assert.ok(Array.isArray(page.sessions))
})

test('★★ subscriptions pass through envelopes too (the agent\'s broadcast reaches the screen)', async (t) => {
  await boot(t)
  const { transport, settle } = await e2e(t)
  const seen: string[] = []
  const stop = transport.subscribe((e) => seen.push(e.type))

  // ⚠️ Wait for the subscription request to arrive (envelopes are async, **in both directions**)
  await settle()
  broadcast({ type: 'sessions-changed', at: '2026-09-15T00:00:00.000Z' })
  await settle()

  assert.deepEqual(seen, ['hello', 'sessions-changed'])
  stop()
  await settle()
  broadcast({ type: 'sessions-changed', at: '2026-09-15T00:01:00.000Z' })
  await settle()
  assert.equal(seen.length, 2, '⚠️ events arrived after unsubscribing')
})

test('★★ on revocation, the "revoked" text shows on screen as-is (① and ② are connected)', async (t) => {
  await boot(t)
  const { transport, raw } = await e2e(t)
  assert.equal((await transport.health()).machine, hostname(), 'precondition: it passes now')

  assert.equal((await revokeDevice(toBase64Url(raw))).ok, true)

  // ⚠️⚠️ This must not become "timed out" or "HTTP 403" (**the reason must reach the screen**)
  await assert.rejects(() => transport.health(), /失効/)
})
