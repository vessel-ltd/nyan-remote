// ★★★ ③b of step 6 in ③: **connect to a real relay with a real WebSocket and go end to end**.
//
//   **AgentTransport** (the PWA's 20 methods) → relayWire → seal → **relayCarrier**
//   → relay (`relay/src/worker.ts`) → **relayLink** (the agent's connection) → tunnel (`tunnel.ts`)
//   → pipeline (`serve.ts`) → auth → **the real router**
//
//   ⇒ **Not a single fake** (both carriers are real, connected through a running relay).
//
// ⚠️⚠️ This is not part of `npm test` (**it needs a running relay**).
//    ⇒ `agent/src/relayLink.test.ts` checks the logic with a fake socket; **this checks the real wire**.
//
// Usage:
//   terminal A: cd relay && npm run dev
//   terminal B: node scripts/relay-smoke.mjs            (default ws://127.0.0.1:8787)
//          node scripts/relay-smoke.mjs ws://127.0.0.1:8787
//
// ⚠️ State is created in **a throwaway temp directory** (never touches the real `~/.nyan-remote/`).

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  exportPublicKey,
  generateDeviceKey,
  relayProof,
  toBase64Url,
} from '../shared/crypto.ts'
import { decodeChallenge, encodeProof } from '../shared/relayAuth.ts'
import { relayUrl } from '../shared/relayFrame.ts'
import { t } from '../shared/i18n.ts'
import { initCliLang } from './lib/lang.mjs'

// ★ Decide the language before building messages (calling `t()` at top level freezes the default language)
initCliLang()

const base = (process.argv[2] ?? 'ws://127.0.0.1:8787').replace(/^http/, 'ws')

// ⚠️ Decide the state directory **before the imports** (the agent side touches it at load time)
const dir = await mkdtemp(join(tmpdir(), 'nyan-relay-smoke-'))
process.env['NYAN_REMOTE_STATE_DIR'] = dir
delete process.env['NYAN_REMOTE_DEV']

const { loadConfig } = await import('../agent/src/config.ts')
const { broadcast } = await import('../agent/src/events.ts')
const { agentKey, agentPublicRaw, loadAgentKey } = await import('../agent/src/deviceKey.ts')
const { issueOneTime, loadDevices, registerDevice } = await import('../agent/src/devices.ts')
const { keepRelayConnected } = await import('../agent/src/relayLink.ts')
const { buildRouter } = await import('../agent/src/routes/index.ts')
const { AgentTransport } = await import('../web/src/transport/agent.ts')
const { connectRelayCarrier } = await import('../web/src/transport/relayCarrier.ts')

const ok = (name) => console.log(`✔ ${name}`)

/** ⚠️ Wait on a "condition" (never guess with a fixed time) */
async function until(pred, what) {
  for (let i = 0; i < 300; i++) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.fail(t(`${what} になりません（時間切れ）`, `${what}: did not happen (timed out)`))
}

await loadConfig()
await loadAgentKey()
await loadDevices()
const agentKey_ = toBase64Url(agentPublicRaw())

/**
 * ★ Barge in "as the agent" with a raw WebSocket (to check ④a of ③b).
 *
 * ⚠️ If `prove` is false, return **a bogus proof** (= someone who merely knows the key).
 */
async function rawAgent(prove) {
  const ws = new WebSocket(relayUrl(base, 'agent', agentKey_))
  ws.binaryType = 'arraybuffer'
  const queue = []
  const waiters = []
  // ⚠️ Attach the listener **before connecting** (attaching later loses the first message that arrived)
  ws.addEventListener('message', (ev) => {
    const bytes = new Uint8Array(ev.data)
    const w = waiters.shift()
    if (w) w(bytes)
    else queue.push(bytes)
  })
  const closed = new Promise((r) => ws.addEventListener('close', (ev) => r(ev.code), { once: true }))
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true })
    ws.addEventListener('error', () => j(new Error(t('割り込みの線が開けません', 'Cannot open the intruding connection'))), { once: true })
  })
  const first = await new Promise((resolve, reject) => {
    const bytes = queue.shift()
    if (bytes) return resolve(bytes)
    const timer = setTimeout(() => reject(new Error(t('challenge が来ません', 'No challenge arrived'))), 5000)
    waiters.push((b) => {
      clearTimeout(timer)
      resolve(b)
    })
  })
  const challenge = decodeChallenge(first)
  assert.ok(challenge.ok, t(`challenge が読めない: ${challenge.reason ?? ''}`, `Cannot read the challenge: ${challenge.reason ?? ''}`))
  const tag = prove
    ? await relayProof(agentKey().privateKey, challenge.value.relayPublicRaw, challenge.value.nonce)
    : new Uint8Array(32).fill(9)
  ws.send(encodeProof(tag))
  return { ws, closed }
}

/** One phone (★ **the real carrier** = `connectRelayCarrier` + the real `AgentTransport`) */
async function phone(name) {
  const identity = await generateDeviceKey()
  const raw = await exportPublicKey(identity.publicKey)
  const registered = await registerDevice(raw, name, issueOneTime().token)
  assert.equal(registered.ok, true, t(`登録できない: ${registered.reason ?? ''}`, `Cannot register: ${registered.reason ?? ''}`))

  // ★★ The handshake (raw first message → reply → confirm) completes here
  const { wire, close } = await connectRelayCarrier({
    base,
    agentPublicKey: agentKey_,
    identity,
    // ⚠️ Make the ping **deliberately fast** (default 45 seconds; so a short smoke shows it works)
    pingMs: 500,
    onDown: (reason) => console.log(t(`  （${name} の線が落ちました: ${reason}）`, `  (${name}'s connection dropped: ${reason})`)),
  })
  const transport = new AgentTransport({ id: name, label: name, url: 'relay://tunnel' }, wire)
  return { transport, wire, close }
}

let keeper
try {
  // ★ Same shape as production (stand up **the reconnect watchdog** too / ④ of ③b)
  keeper = keepRelayConnected({
    base,
    router: buildRouter(),
    pingMs: 500,
    minWaitMs: 100,
    maxWaitMs: 400,
    stableMs: 0,
    onStatus: (s) => {
      if (s.state !== 'open') console.log(t(`  （relay: ${s.state}${s.lastError ? ` / ${s.lastError}` : ''}）`, `  (relay: ${s.state}${s.lastError ? ` / ${s.lastError}` : ''})`))
    },
  })
  await until(() => keeper.status.state === 'open', t('agent が relay に繋がる', 'agent connects to the relay'))
  ok(t('agent が relay に繋がった（本物の WebSocket）', 'agent connected to the relay (real WebSocket)'))

  const a = await phone(t('スマホA', 'Phone A'))
  ok(t('生の1通目で握手が通った（reply → confirm の順）', 'Handshake passed with the raw first message (reply -> confirm order)'))

  const health = await a.transport.health()
  assert.equal(health.agentPublicKey, agentKey_, t('⚠️ 別の agent が答えている', '⚠️ A different agent is answering'))
  assert.ok(Array.isArray(health.features), t('機能の印が来ていない', 'Feature flags did not arrive'))
  ok(t('PWA の Transport が本物のルータまで届いた（/health）', 'The PWA Transport reached the real router (/health)'))

  const page = await a.transport.listSessions({ history: false })
  assert.ok(Array.isArray(page.sessions), t('一覧が来ていない', 'The session list did not arrive'))
  ok(t('一覧も通る（?live=1 が付いた要求がルータに当たっている）', 'The list works too (requests with ?live=1 reach the router)'))

  // ★ The tunnel never serves static files (API only)
  const root = await a.wire.request({ method: 'GET', path: '/' })
  assert.equal(root.status, 404, t(`トンネルから PWA 本体が配られた（${root.status}）`, `The PWA itself was served through the tunnel (${root.status})`))
  ok(t('トンネルは API 専用（PWA 本体は封に入らない）', 'The tunnel is API only (the PWA itself is never sealed into it)'))

  // ★★ Subscription (⚠️ **the agent's broadcast reaches the screen**)
  const seen = []
  const stop = a.transport.subscribe((e) => seen.push(e.type))
  for (let i = 0; i < 50 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 50))
  broadcast({ type: 'sessions-changed', at: new Date().toISOString() })
  for (let i = 0; i < 50 && seen.length < 2; i++) await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(seen, ['hello', 'sessions-changed'], t(`届いたのは ${JSON.stringify(seen)}`, `Received: ${JSON.stringify(seen)}`))
  stop()
  ok(t('購読が relay を通って届く（hello ＋ broadcast）', 'Subscription events arrive through the relay (hello + broadcast)'))

  // ★★ **The ping alone keeps the connection, and no heartbeat flows** (③ of ③b / §14.1.2.28)
  //   ⚠️⚠️ If heartbeats flow, the relay's DO can never hibernate (= exceeds the free quota).
  //   ⚠️ The agent's heartbeat is **every 5 seconds**, so wait 6.5 seconds and check that "none arrives".
  //   ★ Meanwhile pings keep flowing (if the relay did not answer, it would cut us off with "no text accepted",
  //     and the following `/health` would fail = if it does not work, we always find out).
  const quiet = []
  const stopQuiet = a.transport.subscribe((e) => quiet.push(e.type))
  await new Promise((r) => setTimeout(r, 6500))
  assert.equal(
    quiet.includes('heartbeat'),
    false,
    t(`⚠️⚠️ heartbeat が relay に流れた（DO が寝られない）: ${JSON.stringify(quiet)}`, `⚠️⚠️ heartbeat went through the relay (the DO cannot hibernate): ${JSON.stringify(quiet)}`),
  )
  assert.equal(
    (await a.transport.health()).agentPublicKey,
    agentKey_,
    t('⚠️⚠️ 線が切れた（合図が relay に受け入れられていない）', '⚠️⚠️ The connection dropped (the relay is not accepting the ping)'),
  )
  stopQuiet()
  ok(t('合図（ping）だけで線が保たれ、heartbeat は流れない', 'The ping alone keeps the connection alive, and no heartbeat flows'))

  // ★★ Second phone (⚠️ **multiplexed on one connection**. Never mix up the numbers)
  const b = await phone(t('スマホB', 'Phone B'))
  assert.equal(keeper.link?.openTunnels, 2, t(`トンネルが ${keeper.link?.openTunnels} 本`, `${keeper.link?.openTunnels} tunnel(s)`))
  const [ha, hb] = await Promise.all([a.transport.health(), b.transport.health()])
  assert.equal(ha.agentPublicKey, agentKey_)
  assert.equal(hb.agentPublicKey, agentKey_)
  ok(t('2台が1本の線で混ざらない', 'Two phones on one connection do not get mixed up'))

  // ★ A disconnect reaches the agent (⚠️ numbers are reused, so cleanup is needed)
  b.close('smoke')
  await until(() => keeper.link?.openTunnels === 1, t('切れたスマホのトンネルが片付く', 'the disconnected phone\'s tunnel is cleaned up'))
  assert.equal(keeper.link?.connections, 1, t('⚠️ 切れた番号が表に残っている', '⚠️ The disconnected number is still in the table'))
  ok(t('スマホが切れたら、そのトンネルだけ捨てる', 'When a phone disconnects, only its tunnel is dropped'))

  // ★ The remaining phone keeps working
  assert.equal((await a.transport.health()).agentPublicKey, agentKey_)
  ok(t('残った1台はそのまま使える', 'The remaining phone keeps working'))

  // ★★ **Reconnect** (④ of ③b). When another connection arrives with the same key, the relay cuts the old one
  //   (`relay/src/worker.ts`: "agent reconnected on another connection" / 4004).
  //   ⇒ At that moment **this agent's connection drops**, so we check that the watchdog brings it back.
  //   ⚠️ The phones on the other side are also cut by the relay (the agent disappeared) = check with a new phone.
  // ★★ ④a: **merely knowing the key cannot kick the agent** (proof of ownership)
  const firstLink = keeper.link
  const fake = await rawAgent(false)
  assert.equal(await fake.closed, 4005, t('⚠️⚠️ でたらめな証明が通った', '⚠️⚠️ A bogus proof was accepted'))
  assert.equal(keeper.status.state, 'open', t('⚠️⚠️ 割り込みで本物の agent が落ちた', '⚠️⚠️ The intruder knocked the real agent off'))
  assert.equal(keeper.link, firstLink, t('⚠️⚠️ 本物の線が入れ替わった', '⚠️⚠️ The real connection was replaced'))
  assert.equal((await a.transport.health()).agentPublicKey, agentKey_, t('⚠️⚠️ スマホが切れた', '⚠️⚠️ The phone was disconnected'))
  ok(t('鍵を知っているだけでは agent を蹴れない（所有証明）', 'Knowing the key alone cannot kick the agent (proof of ownership)'))

  // ★★ ④ of ③b: **a connection with a valid proof** cuts the old one (= the agent's reconnect itself)
  const real = await rawAgent(true)
  await until(
    () => keeper.status.state === 'open' && keeper.link !== undefined && keeper.link !== firstLink,
    t('agent が繋ぎ直す', 'agent reconnects'),
  )
  real.ws.close()
  const c = await phone(t('スマホC', 'Phone C'))
  assert.equal((await c.transport.health()).agentPublicKey, agentKey_, t('繋ぎ直したあと使えない', 'Not usable after reconnecting'))
  ok(t('線が落ちても agent が戻ってくる（繋ぎ直し）', 'The agent comes back after the connection drops (reconnect)'))
  c.close('smoke')

  a.close('smoke')
  console.log(t('\n★ 全部 通りました', '\n★ All passed'))
} finally {
  await keeper?.stop(t('smoke 終了', 'smoke finished'))
  await rm(dir, { recursive: true, force: true })
}
// ⚠️ The agent-side watchers (`fs.watch` etc.) are alive, so exit explicitly
process.exit(0)
