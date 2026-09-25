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

/** MagicDNS suffix used for automatic CORS allowance (e.g. example.ts.net) */
export async function magicDnsSuffix(): Promise<string | undefined> {
  return (await tailnetStatus()).suffix
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
