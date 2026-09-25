// ③ stage 6 step ④: startup wiring (`agent/src/relayRun.ts`).
//
// ★★ **Mutations targeted by name** here:
//   ① opening a link with no config (= hitting a URL that goes nowhere forever)
//   ② opening with a malformed `relayUrl` / leaving no reason (**silently not connecting**)
//   ③ opening when the agent key is unusable (`connectRelay` just throws and no reason remains)
//   ④ a broken config stops the whole agent (⚠️ the relay is on the "local still works if it fails" side)
//   ⑤ no status in `/health` (= nobody can see why it is not connected)
//   ⑥ the QR lacks the relay entry / **carries a malformed one** (showing people an unreadable QR)

import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parsePairUrl } from '../../shared/pairing.ts'
import { loadConfig } from './config.ts'
import { loadAgentKey, resetAgentKey } from './deviceKey.ts'
import { loadDevices, resetDevices } from './devices.ts'
import { relayHealth, resetRelay, startRelay, licensingFor } from './relayRun.ts'
import { buildRouter } from './routes/index.ts'
import { pairToken } from './routes/devices.ts'
import { health } from './routes/health.ts'

/** Swaps the state directory and puts the agent in a "started" state (★ config.json can be written) */
/** ★ A fake link that waits without ever connecting (⚠️ opens no real WebSocket = never touches the production relay) */
const neverConnect = () => new Promise<never>(() => {})

async function boot(
  t: { after: (fn: () => Promise<void>) => void },
  config: Record<string, unknown> = {},
  breakKey = false,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-relayrun-'))
  const prev = process.env['NYAN_REMOTE_STATE_DIR']
  const prevDev = process.env['NYAN_REMOTE_DEV']
  process.env['NYAN_REMOTE_STATE_DIR'] = dir
  delete process.env['NYAN_REMOTE_DEV']
  resetAgentKey()
  resetDevices()
  resetRelay()
  t.after(async () => {
    resetRelay()
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
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ allowedLogins: ['x@example.com'], hookToken: 'tok', ...config }),
    'utf8',
  )
  // ⚠️ break the agent key (★ not recreated = becomes unusable / deviceKey.ts)
  if (breakKey) await writeFile(join(dir, 'device-key.json'), '{"v":1,"crv":"P-256"}', 'utf8')
  await loadConfig()
  await loadAgentKey()
  await loadDevices()
}

test('★★★★ with no config, **connects to the default relay** (2026-09-18 / user decision)', async (t) => {
  // ⚠️⚠️ when this was `false` there were "agents without a relay configured",
  //    and those users could not use ③ stage 7 (pairing via relay) = still dependent on the tailnet.
  //    ⇒ aligned the implementation with the policy (2026-09-16 "the default route is relay").
  const { DEFAULT_RELAY_URL } = await import('../../shared/distribution.ts')
  await boot(t)
  // ⚠️⚠️ the link is opened with a fake (the real one **connected to the production relay every time** = tests never touch production / 2026-09-24)
  assert.equal(startRelay(buildRouter(), neverConnect), true, '⚠️⚠️ does not connect to the relay by default')
  assert.notEqual(relayHealth().state, 'off')
  // ★ look at the default value itself (check **the value the implementation uses** / CLAUDE.md §2)
  const { config } = await import('./config.ts')
  assert.equal(config().relayUrl, DEFAULT_RELAY_URL)
})

test('★★★ `relayUrl: ""` means no link (★ there is a way to turn it off)', async (t) => {
  // ⚠️ self-hosters can choose "do not connect to the official relay" (the OSS escape hatch)
  await boot(t, { relayUrl: '' })
  assert.equal(startRelay(buildRouter()), false)
  assert.equal(relayHealth().state, 'off')
})

test('★★★★ a malformed relayUrl opens no link and **keeps the reason** (②)', async (t) => {
  await boot(t, { relayUrl: 'https://relay.example' })
  assert.equal(startRelay(buildRouter()), false)
  const h = relayHealth()
  assert.equal(h.state, 'off')
  // ⚠️⚠️ without a reason nobody notices that "it silently became local only"
  assert.match(h.lastError ?? '', /relayUrl/)
})

test('★★★★ a broken config does not stop the agent (④ / treated differently from config.json)', async (t) => {
  // ⚠️ `relayUrl` is not a string = the config is rejected (= refusal mode = 503 for every request).
  // ★★ **it still connects to the relay** (changed on 2026-09-18).
  //   ⚠️⚠️ reason: the point of refusal mode is "show the reason so it can be fixed", and
  //      **without the link the reason never reaches the phone** (people without a tailnet see nothing).
  //      ⇒ connecting and returning 503 for everything is better than silently disappearing.
  //   ⚠️ connecting does not loosen authentication (`authenticate` returns the config 503 first).
  await boot(t, { relayUrl: 42 })
  // ⚠️⚠️ a broken config falls back to the default relay ⇒ open with a fake (never touch production)
  assert.equal(startRelay(buildRouter(), neverConnect), true)
  assert.notEqual(relayHealth().state, 'off')
})

test('★★★★ no link if the agent key is unusable (③)', async (t) => {
  await boot(t, { relayUrl: 'ws://127.0.0.1:1' }, true)
  assert.equal(startRelay(buildRouter()), false, '⚠️⚠️ opened a link though it cannot identify itself')
  const h = relayHealth()
  assert.equal(h.state, 'off')
  assert.match(h.lastError ?? '', /鍵/)
})

test('★★★★ a correct config opens the link (⑤ also shown in `/health`)', async (t) => {
  // ⚠️ a destination that connects nowhere (★ even without connecting, "opened" is visible = the state moves)
  await boot(t, { relayUrl: 'ws://127.0.0.1:1' })
  assert.equal(startRelay(buildRouter()), true)
  const h = await health()
  assert.ok(h.relay, 'no relay in /health')
  assert.notEqual(h.relay?.state, 'off', 'still off after opening')

  // ★ it cannot connect, so it eventually goes to "waiting" (⚠️ with a reason)
  for (let i = 0; i < 100 && relayHealth().state !== 'waiting'; i++) {
    await new Promise((r) => setTimeout(r, 20))
  }
  const after = relayHealth()
  assert.equal(after.state, 'waiting')
  assert.ok((after.lastError ?? '').length > 0, 'no reason left for not connecting')
})

test('★★★★ the QR carries the relay entry (⑥)', async (t) => {
  await boot(t, { relayUrl: 'wss://relay.example' })
  const out = await pairToken()
  const parsed = parsePairUrl(out.url)
  assert.equal(parsed?.relayUrl, 'wss://relay.example')
})

test('★★★★ a malformed relay is not put in the QR (never show people an unreadable QR / ⑥)', async (t) => {
  await boot(t, { relayUrl: 'https://relay.example' })
  const out = await pairToken()
  const parsed = parsePairUrl(out.url)
  // ★ the QR itself is readable (= pairing over local works as before)
  assert.ok(parsed, '⚠️⚠️ built an unreadable QR')
  assert.equal(parsed?.relayUrl, undefined)
})

test('★★★★ tests do not connect to the production relay (tests using the default relay pass a fake link)', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./relayRun.test.ts', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n')
  // ⚠️ do not write a test that opens a link without a fake in a default-relay shape (no config, broken config)
  for (const m of src.matchAll(/await boot\(t(?:, \{ relayUrl: 42 \})?\)\s*\n[^\n]*startRelay\(buildRouter\(\)([^)]*)\)/g)) {
    assert.ok(m[1]!.includes('neverConnect'), `⚠️⚠️ a test really connects to the production relay: ${m[0].slice(0, 80)}`)
  }
})

test('★★ the license is handed only to our relay (a self-hosted relay would apply our plan limits / 2026-09-25)', () => {
  assert.ok(licensingFor('wss://relay.nyan-remote.app').licensing)
  assert.ok(licensingFor('wss://nyan-relay.nyan-remote-relay.workers.dev').licensing)
  assert.deepEqual(licensingFor('wss://nyan-relay.someone.workers.dev'), {})
  assert.deepEqual(licensingFor('ws://127.0.0.1:8787'), {})
})

test('★ wiring: startRelay passes the license through licensingFor only', async () => {
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('./relayRun.ts', import.meta.url), 'utf8')
  assert.match(src, /keepRelayConnected\(\{[\s\S]*?\.\.\.licensingFor\(base\),[\s\S]*?\}\)/)
  assert.equal(src.match(/licensing: accountLicensing/g)?.length, 1, '⚠️ the license is handed over somewhere else too')
})
