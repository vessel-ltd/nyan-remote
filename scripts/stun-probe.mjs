// Measure the machine-side NAT type (prerequisite measurement for the ③ P2P version / docs/VERIFY.md "groundwork for the P2P path").
//
// ⚠️ 2026-09-24: the phone-side /webrtc-probe.html was removed from the distribution (anyone could open it from the public origin). It remains only in history.
// More accurate than a browser: the browser deduplicates candidates with identical results,
// whereas here each response is seen raw.
//
// ★ The key to the verdict: "query several STUN servers from the same UDP socket and check
//   whether the external address:port that comes back collapses to one" is the only thing that decides the NAT type.
//   - collapses to one → endpoint-independent (cone) → hole punching works
//   - changes per destination → symmetric NAT → browser ICE cannot get through (TURN needed)
//   Measuring with separate sockets changes the local port every time, so comparing tells you nothing.
//
// ★ Port preservation (local = external) does not matter, because the external port is learned via STUN and passed to the peer.
//
// Zero runtime dependencies (node:dgram + node:dns only. Builds the RFC 5389 Binding Request itself).
//
//   node scripts/stun-probe.mjs          # both IPv4 and IPv6
//   node scripts/stun-probe.mjs --4      # IPv4 only

import dgram from 'node:dgram'
import { lookup } from 'node:dns/promises'
import { randomBytes } from 'node:crypto'
import { t } from '../shared/i18n.ts'
import { initCliLang } from './lib/lang.mjs'

// ★ Decide the language before building messages (calling `t()` at top level freezes the default language)
initCliLang()

const SERVERS = [
  ['stun.l.google.com', 19302],
  ['stun.cloudflare.com', 3478],
  ['stun.nextcloud.com', 443],
  ['stun.sipgate.net', 3478],
]

const WAIT_MS = 3000
const MAGIC = 0x2112a442

/** RFC 5389 Binding Request (just the 20-byte header, no attributes) */
function bindingRequest() {
  const buf = Buffer.alloc(20)
  buf.writeUInt16BE(0x0001, 0) // Binding Request
  buf.writeUInt16BE(0, 2) // attribute length
  buf.writeUInt32BE(MAGIC, 4)
  const tid = randomBytes(12)
  tid.copy(buf, 8)
  return { buf, tid: tid.toString('hex') }
}

/** Read MAPPED-ADDRESS / XOR-MAPPED-ADDRESS */
function readAddress(val, xor, msg) {
  if (val.length < 8) return null
  const family = val.readUInt8(1)
  let port = val.readUInt16BE(2)
  if (xor) port ^= MAGIC >>> 16

  if (family === 0x01) {
    const a = Buffer.from(val.subarray(4, 8))
    if (xor) for (let i = 0; i < 4; i++) a[i] ^= msg[4 + i]
    return { family: 4, address: [...a].join('.'), port }
  }
  if (family === 0x02 && val.length >= 20) {
    const a = Buffer.from(val.subarray(4, 20))
    // The XOR key is magic cookie(4) + transaction id(12) = msg bytes 4..19
    if (xor) for (let i = 0; i < 16; i++) a[i] ^= msg[4 + i]
    const parts = []
    for (let i = 0; i < 16; i += 2) parts.push(a.readUInt16BE(i).toString(16))
    return { family: 6, address: parts.join(':'), port }
  }
  return null
}

function parseResponse(msg) {
  if (msg.length < 20) return null
  if (msg.readUInt16BE(0) !== 0x0101) return null // ignore anything but a Binding Success Response
  const len = msg.readUInt16BE(2)
  const tid = msg.subarray(8, 20).toString('hex')
  const end = Math.min(20 + len, msg.length)

  let mapped = null
  let off = 20
  while (off + 4 <= end) {
    const atype = msg.readUInt16BE(off)
    const alen = msg.readUInt16BE(off + 2)
    const val = msg.subarray(off + 4, off + 4 + alen)
    if (atype === 0x0020) {
      const r = readAddress(val, true, msg)
      if (r) mapped = r // prefer XOR-MAPPED-ADDRESS
    } else if (atype === 0x0001 && !mapped) {
      const r = readAddress(val, false, msg)
      if (r) mapped = r
    }
    off += 4 + alen + ((4 - (alen % 4)) % 4) // align to a 4-byte boundary
  }
  return mapped ? { tid, ...mapped } : null
}

async function resolveAll(family) {
  const out = []
  for (const [host, port] of SERVERS) {
    try {
      const r = await lookup(host, { family })
      out.push({ host, port, ip: r.address })
    } catch (e) {
      out.push({ host, port, ip: null, error: e.code || String(e.message || e) })
    }
  }
  return out
}

/** Send to every server from one socket (this is the core of the verdict) */
function askAll(family, targets) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket(family === 6 ? 'udp6' : 'udp4')
    const byTid = new Map()
    const results = []
    let localPort = null

    socket.on('message', (msg) => {
      const r = parseResponse(msg)
      if (!r) return
      const server = byTid.get(r.tid)
      if (!server) return
      results.push({ server, ...r })
    })
    socket.on('error', (e) => {
      try { socket.close() } catch { /* already closed */ }
      resolve({ localPort, results, error: String(e.message || e) })
    })

    socket.bind(() => {
      localPort = socket.address().port
      for (const tg of targets) {
        if (!tg.ip) continue
        const { buf, tid } = bindingRequest()
        byTid.set(tid, tg)
        socket.send(buf, tg.port, tg.ip, (err) => {
          if (err) results.push({ server: tg, sendError: String(err.message || err) })
        })
      }
      setTimeout(() => {
        try { socket.close() } catch { /* already closed */ }
        resolve({ localPort, results })
      }, WAIT_MS)
    })
  })
}

function verdict(localPort, targets, results) {
  const answered = results.filter((r) => r.address)
  const keys = new Set(answered.map((r) => `${r.address}:${r.port}`))
  const addrs = new Set(answered.map((r) => r.address))

  console.log(t(`\n  内側ポート: ${localPort}`, `\n  Local port: ${localPort}`))
  console.log('  ' + '-'.repeat(66))
  for (const tg of targets) {
    const hit = answered.find((r) => r.server.host === tg.host)
    const left = `${tg.host}:${tg.port}`.padEnd(32)
    if (!tg.ip) console.log(t(`  ${left} 名前が引けない (${tg.error})`, `  ${left} cannot resolve the name (${tg.error})`))
    else if (!hit) console.log(t(`  ${left} 応答なし`, `  ${left} no response`))
    else console.log(`  ${left} ${hit.address}:${hit.port}`)
  }
  console.log('  ' + '-'.repeat(66))

  if (answered.length === 0) {
    console.log(t('  ❌ どの STUN にも届かなかった → UDP が塞がれている', '  ❌ No STUN server was reached -> UDP is blocked'))
    console.log(t('     この経路では直結できない。TURN over TCP/443 以外に手段がない。', '     No direct connection on this path. TURN over TCP/443 is the only option.'))
    return 'blocked'
  }
  if (answered.length === 1) {
    console.log(t(`  ⚠️  応答が1つだけ（${answered.length}/${targets.length}）→ 判定不能`, `  ⚠️  Only one response (${answered.length}/${targets.length}) -> cannot tell`))
    console.log(t('     宛先を変えたときの挙動を比べられない。', '     Cannot compare the behavior across destinations.'))
    return 'unknown'
  }
  if (keys.size === 1) {
    const [only] = keys
    console.log(t(`  ✅ endpoint-independent（cone） — 応答 ${answered.length} 個すべてが ${only}`, `  ✅ endpoint-independent (cone) - all ${answered.length} responses are ${only}`))
    console.log(t('     宛先が変わってもマッピングが変わらない → ホールパンチできる。TURN 不要。', '     The mapping does not change with the destination -> hole punching works. No TURN needed.'))
    if (localPort !== answered[0].port) {
      console.log(t(`     （参考）内側 ${localPort} → 外側 ${answered[0].port}。ポート保存は不要なので問題ない。`, `     (FYI) local ${localPort} -> external ${answered[0].port}. Port preservation is not needed, so this is fine.`))
    }
    return 'cone'
  }
  console.log(t(`  ❌ 対称NAT（endpoint-dependent） — 宛先ごとに ${[...keys].join(' / ')}`, `  ❌ Symmetric NAT (endpoint-dependent) - per destination: ${[...keys].join(' / ')}`))
  if (addrs.size > 1) console.log(t(`     公開アドレスまで変わっている: ${[...addrs].join(' / ')}`, `     Even the public address changes: ${[...addrs].join(' / ')}`))
  console.log(t('     ブラウザの ICE では越えられない。この経路には TURN が必要。', '     Browser ICE cannot get through. This path needs TURN.'))
  return 'symmetric'
}

const only4 = process.argv.includes('--4')
const only6 = process.argv.includes('--6')
const families = only4 ? [4] : only6 ? [6] : [4, 6]

for (const family of families) {
  console.log(`\n=== IPv${family} ===`)
  const targets = await resolveAll(family)
  if (targets.every((tg) => !tg.ip)) {
    console.log(t(`  IPv${family} で名前を引けるサーバーが無い → この family は使えない`, `  No server resolves over IPv${family} -> this family is unusable`))
    continue
  }
  const { localPort, results, error } = await askAll(family, targets)
  if (error) console.log(t(`  ソケットのエラー: ${error}`, `  Socket error: ${error}`))
  verdict(localPort, targets, results)
}
console.log('')
