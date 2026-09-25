// Reads tailnet information. It just runs `tailscale status --json`.
//
// Two uses:
//   1. MagicDNS suffix → automatic CORS allowance (only origins on the same tailnet / auth.ts)
//   2. List of peers → candidates for "Add endpoint" in the PWA
//
// ⚠️ On WSL `tailscale` is not on PATH (it exists only on the Windows side).
//    `/etc/wsl.conf` has appendWindowsPath=false, so call it by full path.
//
// ⚠️ The agent itself does not hit peers' /health, because MagicDNS cannot be resolved from WSL
//    (it would need IP + SNI). It only returns candidates; the actual connection
//    is left to the phone side (PWA), where MagicDNS works.

import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { PeerCandidate, PeersResult } from '../../shared/types.ts'
import { t } from '../../shared/i18n.ts'

const exec = promisify(execFile)

const TTL_MS = 10_000
const TIMEOUT_MS = 8000

const CANDIDATES = [
  'tailscale',
  '/usr/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/mnt/c/Program Files/Tailscale/tailscale.exe',
]

let binCache: string | null | undefined
let statusCache: { at: number; result: PeersResult } | null = null
let warned = false

async function findBin(): Promise<string | null> {
  if (binCache !== undefined) return binCache
  const override = process.env.NYAN_REMOTE_TAILSCALE_BIN
  if (override) {
    binCache = override
    return binCache
  }
  for (const candidate of CANDIDATES) {
    if (candidate.includes('/')) {
      try {
        await access(candidate)
        binCache = candidate
        return binCache
      } catch {
        continue
      }
    } else {
      // check whether it is on PATH by actually running it
      try {
        await exec(candidate, ['version'], { timeout: TIMEOUT_MS })
        binCache = candidate
        return binCache
      } catch {
        continue
      }
    }
  }
  binCache = null
  return null
}

interface RawStatus {
  MagicDNSSuffix?: string
  Self?: RawNode
  Peer?: Record<string, RawNode>
}

interface RawNode {
  HostName?: string
  DNSName?: string
  OS?: string
  Online?: boolean
}


/** Devices that cannot host an agent (phones) are not offered as candidates */
const NOT_A_HOST = new Set(['android', 'ios'])

function toCandidate(node: RawNode, self: boolean): PeerCandidate | null {
  const dns = (node.DNSName ?? '').replace(/\.$/, '')
  if (!dns) return null
  const os = node.OS ?? ''
  if (NOT_A_HOST.has(os.toLowerCase())) return null
  return {
    hostname: node.HostName ?? dns,
    dnsName: dns,
    url: `https://${dns}`,
    os: os || undefined,
    online: self ? true : Boolean(node.Online),
    self,
  }
}

export async function tailnetStatus(): Promise<PeersResult> {
  const hit = statusCache
  if (hit && Date.now() - hit.at < TTL_MS) return hit.result

  const result = await fetchStatus()
  statusCache = { at: Date.now(), result }
  return result
}

async function fetchStatus(): Promise<PeersResult> {
  const bin = await findBin()
  if (!bin) {
    if (!warned) {
      warned = true
      console.warn(t('[tailscale] tailscale コマンドが見つかりません（ピア候補と CORS 自動許可が無効）', '[tailscale] The tailscale command was not found (peer candidates and automatic CORS allowance are disabled)'))
    }
    return { available: false, peers: [], reason: t('tailscale コマンドが見つかりません', 'The tailscale command was not found.') }
  }
  try {
    const { stdout } = await exec(bin, ['status', '--json'], {
      timeout: TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    })
    const raw = JSON.parse(stdout) as RawStatus
    const peers: PeerCandidate[] = []
    const self = raw.Self ? toCandidate(raw.Self, true) : null
    if (self) peers.push(self)
    for (const node of Object.values(raw.Peer ?? {})) {
      const c = toCandidate(node, false)
      if (c) peers.push(c)
    }
    peers.sort((a, b) => Number(b.online) - Number(a.online) || a.hostname.localeCompare(b.hostname))
    return { available: true, suffix: raw.MagicDNSSuffix, peers }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    if (!warned) {
      warned = true
      console.warn(t(`[tailscale] status --json に失敗: ${reason}`, `[tailscale] status --json failed: ${reason}`))
    }
    return { available: false, peers: [], reason }
  }
}


/**
 * ★★ This agent's own entry point (`https://<own MagicDNS name>`. 2026-09-16 / to move toward Y).
 *
 * ⚠️⚠️ It is **the value put in the QR**, so if it is wrong we hand people "an endpoint that does not connect".
 *    ⇒ **Take it from `Self` in `tailscale status`** (= the name `tailscale serve` actually publishes;
 *      **the same value** shown among the PWA's "tailnet candidates"). ⚠️ Do not rebuild it another way.
 * ⚠️ `undefined` if it cannot be read (not put in the QR ⇒ the QR is just as before).
 */
export async function selfAgentUrl(): Promise<string | undefined> {
  const status = await tailnetStatus()
  if (!status.available) return undefined
  return status.peers.find((p) => p.self)?.url
}

// ── Does `tailscale serve` forward to this agent? (2026-09-25 / codex security review, high #1) ─────────────────────
//
// ★★ The Tailscale identity headers (`Tailscale-User-Login`) are only trustworthy **when tailscale serve is the one sending
//   them**. On a machine that does not use Tailscale (relay only, the default), anyone who can open 127.0.0.1:7777
//   (another OS user, a DNS-rebinding page) could forge them, and with an empty `allowedLogins` the first forged login
//   was even remembered. ⇒ Accept them only while the serve config forwards to our port.
// ⚠️ `authenticate` is synchronous, so the answer is refreshed in the background (`watchServe`) and read here.
//   Unknown (not checked yet, or the command failed) = **not forwarding** (fail-closed).
// ⚠️ Residual: on a machine that does use tailscale serve, another OS user can still forge the headers (loopback cannot tell
//   who connected). That needs device-key authentication on the local route too (not done).

let serving = false

/**
 * ★ Pure: does a `tailscale serve status --json` value forward to 127.0.0.1/localhost:`port`?
 *   Walks the whole value (background serve under `Web`, foreground sessions under `Foreground`). TCP forwards do not count.
 */
export function servesPort(raw: unknown, port: number): boolean {
  // ⚠️ On a default web port a target without a port (`http://127.0.0.1`) also means us, and would escape the mention count
  //    below (codex). The agent never needs them (7777 by default; 80/443 would need root) ⇒ simply not trusted
  if (port === 80 || port === 443) return false
  const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
  // ★ An HTTP proxy target must be this machine's loopback on our port (anything else: not ours = refuse)
  const loopbackTo = (v: string): boolean => {
    try {
      const u = new URL(v)
      const host = u.hostname.toLowerCase()
      return (u.protocol === 'http:' || u.protocol === 'https:') && (host === '127.0.0.1' || host === 'localhost' || host === '[::1]') && Number(u.port) === port
    } catch {
      return false
    }
  }
  let proxies = 0
  // ★ Read it as Tailscale's ServeConfig: `TCP` (port → handler), `Web` ("host:port" → Handlers), `Foreground` (session → config)
  const visit = (cfg: unknown, depth: number): void => {
    if (!obj(cfg) || depth > 4) return
    const tcp = obj(cfg['TCP']) ? cfg['TCP'] : {}
    const web = obj(cfg['Web']) ? cfg['Web'] : {}
    for (const [hostPort, site] of Object.entries(web)) {
      // ⚠️ Only a listener that terminates **HTTPS** (`TCP[port].HTTPS`) — tailscale serve sets identity headers there (codex)
      const listener = tcp[hostPort.slice(hostPort.lastIndexOf(':') + 1)]
      const https = obj(listener) && listener['HTTPS'] === true
      const handlers = obj(site) && obj(site['Handlers']) ? site['Handlers'] : {}
      for (const h of Object.values(handlers)) {
        if (https && obj(h) && typeof h['Proxy'] === 'string' && loopbackTo(h['Proxy'])) proxies++
      }
    }
    for (const key of ['Foreground', 'Services']) {
      const sub = cfg[key]
      if (obj(sub)) for (const f of Object.values(sub)) visit(f, depth + 1)
    }
  }
  visit(raw, 0)
  // ★★★ **Every mention of our port anywhere must be one of the HTTPS proxies counted above** (codex, rounds 3–5:
  //   raw TCP forwards — however the host is spelt —, forwards under `Services`, HTTP proxies next to HTTPS ones…).
  //   Listing shapes one by one never ends, so the rule is inverted: any other place that points at our port — in a shape
  //   we know or one we do not — means "not trusted". ⚠️ Do not add per-shape vetoes back (this covers them; tests pin each).
  let mentions = 0
  const count = (v: unknown, depth: number): void => {
    if (depth > 16) return
    if (typeof v === 'string') {
      const m = /:(\d+)(?:[/?#]|$)/.exec(v)
      if (m && Number(m[1]) === port) mentions++
    } else if (typeof v === 'object' && v !== null) {
      for (const x of Object.values(v as Record<string, unknown>)) count(x, depth + 1)
    }
  }
  count(raw, 0)
  return proxies > 0 && mentions === proxies
}

async function refreshServe(port: number): Promise<void> {
  const bin = await findBin()
  if (!bin) {
    serving = false
    return
  }
  try {
    const { stdout } = await exec(bin, ['serve', 'status', '--json'], { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 })
    serving = servesPort(JSON.parse(stdout), port)
  } catch {
    serving = false
  }
}

/** ★ Last known answer (⚠️ false until the first check finished) */
export function tailscaleServesUs(): boolean {
  return serving
}

/**
 * ★ Check now and every 30 seconds. ⚠️ Resolves after the first check (so the first requests after a restart are not refused;
 *   bounded by the command timeout). The timer does not keep the process alive.
 */
export async function watchServe(port: number): Promise<() => void> {
  await refreshServe(port)
  const timer = setInterval(() => void refreshServe(port), 30_000)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** ⚠️ For tests */
export function setServingForTest(v: boolean): void {
  serving = v
}
