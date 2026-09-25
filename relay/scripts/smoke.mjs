// ★★★ Exercise the rendezvous over **real WebSockets** (run against `wrangler dev`).
//
// ⚠️⚠️ Not part of `npm test` (**needs a running relay**).
//    ⇒ Steps: `relay/README.md`. ★ Frame building is checked by `shared/relayFrame.test.ts`,
//      so this only checks that frames are **actually forwarded**.
//
// Usage:
//   terminal A: cd relay && npm run dev
//   terminal B: cd relay && node scripts/smoke.mjs            (default http://127.0.0.1:8787)
//               node scripts/smoke.mjs ws://127.0.0.1:8787    (another URL)

import assert from 'node:assert/strict'
import {
  MAX_RELAY_BYTES,
  RELAY_FRAME,
  decodeRelayFrame,
  encodeRelayFrame,
  relayUrl,
} from '../../shared/relayFrame.ts'

const base = (process.argv[2] ?? 'ws://127.0.0.1:8787').replace(/^http/, 'ws')
/** ★ A key with the real shape only (86–88 base64url characters) */
const KEY = `B${'A'.repeat(85)}x`

/** Wait until open. ⚠️ Surface the failure reason as is (never hang silently) */
function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    const timer = setTimeout(() => reject(new Error(`Cannot open (timed out): ${url}`)), 5000)
    ws.onopen = () => {
      clearTimeout(timer)
      resolve(ws)
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error(`Cannot open: ${url}`))
    }
  })
}

/**
 * ★★ **Buffer** what arrives, then take it out.
 *
 * ⚠️⚠️ With a "wait, then listen" shape (attaching `addEventListener` later),
 *    **the first message that already arrived is lost** (hit for real: misdiagnosed as `opened` never coming).
 *    ⇒ Buffer from right after connecting.
 */
function collect(ws) {
  const queue = []
  const waiters = []
  ws.addEventListener('message', (ev) => {
    const bytes = new Uint8Array(ev.data)
    const waiter = waiters.shift()
    if (waiter) waiter(bytes)
    else queue.push(bytes)
  })
  return (what = 'message') =>
    new Promise((resolve, reject) => {
      const first = queue.shift()
      if (first) return resolve(first)
      const timer = setTimeout(() => reject(new Error(`${what} did not arrive (timed out)`)), 5000)
      waiters.push((bytes) => {
        clearTimeout(timer)
        resolve(bytes)
      })
    })
}

/** Wait for close (returns the code) */
function closed(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Did not close (timed out)')), 5000)
    ws.addEventListener(
      'close',
      (ev) => {
        clearTimeout(timer)
        resolve(ev.code)
      },
      { once: true },
    )
  })
}

const ok = (name) => console.log(`✔ ${name}`)

const agent = await open(relayUrl(base, 'agent', KEY))
// ★ Buffer from **right after** connecting (listening later loses the first message)
const fromAgent = collect(agent)
ok('agent connected')

// ★ First check that a phone is refused when no agent is there (with another key)
const orphan = await open(relayUrl(base, 'device', `B${'B'.repeat(85)}x`)).catch((err) => err)
assert.ok(orphan instanceof Error, '⚠️ accepted a phone with no agent')
ok('refused when there is no agent')

const device = await open(relayUrl(base, 'device', KEY))
const fromDevice = collect(device)
const opened = decodeRelayFrame(await fromAgent('opened'))
assert.ok(opened.ok && opened.value.type === RELAY_FRAME.opened, 'no opened frame')
const connId = opened.value.connId
ok(`phone connected; the agent got connection ${connId}`)

// ── phone → agent ──────────────────────────────────────────────────────────
device.send(new Uint8Array([1, 2, 3, 250]))
const up = decodeRelayFrame(await fromAgent('data (up)'))
assert.ok(up.ok && up.value.type === RELAY_FRAME.data)
assert.equal(up.value.connId, connId)
assert.deepEqual([...up.value.payload], [1, 2, 3, 250], '⚠️ the payload changed')
ok('phone → agent (payload unchanged, byte for byte)')

// ── agent → phone ──────────────────────────────────────────────────────────
agent.send(encodeRelayFrame({ type: RELAY_FRAME.data, connId, payload: new Uint8Array([9, 8, 7]) }))
assert.deepEqual([...(await fromDevice('data (down)'))], [9, 8, 7], '⚠️ the payload changed')
ok('agent → phone')

// ── nothing oversized is carried (★ ToS safeguard / §14.1.1.4) ─────────────
const big = await open(relayUrl(base, 'device', KEY))
await fromAgent('opened (second)')
big.send(new Uint8Array(MAX_RELAY_BYTES + 1))
assert.equal(await closed(big), 4003, '⚠️⚠️ carried an oversized frame')
ok('oversized frames close the line (4003)')

// ── a disconnect reaches the agent ─────────────────────────────────────────
device.close()
let sawClosed = false
for (let i = 0; i < 3 && !sawClosed; i++) {
  const f = decodeRelayFrame(await fromAgent('closed'))
  sawClosed = f.ok && f.value.type === RELAY_FRAME.closed && f.value.connId === connId
}
assert.ok(sawClosed, '⚠️ the agent was not told about the disconnect')
ok('a phone disconnect reaches the agent')

// ── device limit ───────────────────────────────────────────────────────────
const many = []
for (let i = 0; i < 12; i++) {
  const ws = await open(relayUrl(base, 'device', KEY)).catch(() => undefined)
  if (!ws) break
  many.push(ws)
}
assert.ok(many.length < 12, `⚠️⚠️ the device limit is not enforced (${many.length} connected)`)
ok(`the device limit holds (stopped at ${many.length})`)

for (const ws of [...many, agent]) ws.close()
console.log('\n★ All passed')
