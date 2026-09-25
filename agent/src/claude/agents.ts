// Get the running sessions via `claude agents --json`.
//
// ⚠️⚠️ **This is now only a fallback. The main path is sessionIndex.ts.**
//    On 2026-08-12 we found that the same information is written to
//    `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json`. Reading it is all it takes, so there is no room for accidents.
//    This path is used only by old CLIs that have no index directory.
//
// It used to be "the only source that ties sessionId to status" (from the process we can only
// get CLAUDE_CONFIG_DIR and cwd). That premise no longer holds.
//
// ⚠️⚠️ Do not remove the guard.
//    On 2026-08-04, running this command while .claude.json did not exist
//    created the file anew, and a 167KB config became 309B (we actually broke it).
//    → Only run when the file exists and is at least 1KB.

import { t } from '../../../shared/i18n.ts'
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ConfigDir } from './configDirs.ts'

const exec = promisify(execFile)

const MIN_CLAUDE_JSON_BYTES = 1024
const TTL_MS = 2000
const TIMEOUT_MS = 10_000

export interface LiveAgent {
  sessionId: string
  pid?: number
  cwd?: string
  kind?: string
  name?: string
  status?: string
  /**
   * ★ "What it is waiting for" when `status === 'waiting'` (2026-08-18).
   * ⚠️ Appears both in the index (`sessions/<pid>.json`) and in `claude agents --json`
   *    (CLI 2.1.234: `...p.status==="waiting" && p.waitingFor && {waitingFor}`).
   *    ⚠️ This used to say "only in the index", which was wrong (flagged by /code-review the same day)
   */
  waitingFor?: string
  startedAt?: number
  /**
   * UNIX socket for dropping messages into a running session (ARCHITECTURE.md §9.7).
   * Only available from `sessions/<pid>.json` (not in this command's output).
   */
  messagingSocketPath?: string
}

export interface LiveResult {
  /** false means live state could not be obtained (the guard tripped / the command failed) */
  available: boolean
  agents: LiveAgent[]
  reason?: string
}

const cache = new Map<string, { at: number; result: LiveResult }>()
const warned = new Set<string>()

function claudeBin(): string {
  return process.env.NYAN_REMOTE_CLAUDE_BIN ?? 'claude'
}

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(message)
}

export async function liveAgents(dir: ConfigDir): Promise<LiveResult> {
  const hit = cache.get(dir.dir)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.result

  const result = await fetchLive(dir)
  cache.set(dir.dir, { at: Date.now(), result })
  return result
}

async function fetchLive(dir: ConfigDir): Promise<LiveResult> {
  // --- Guard (see the comment at the top. Never remove it) ---
  const claudeJson = join(dir.dir, '.claude.json')
  try {
    const s = await stat(claudeJson)
    if (s.size < MIN_CLAUDE_JSON_BYTES) {
      const reason = t(`${claudeJson} が ${s.size}B しかありません（壊れている可能性）`, `${claudeJson} is only ${s.size}B (possibly broken)`)
      warnOnce(
        `small:${dir.dir}`,
        t(`[agents] ${dir.account}: ${reason} — ライブ状態の取得を見送ります`, `[agents] ${dir.account}: ${reason} — skipping live state`),
      )
      return { available: false, agents: [], reason }
    }
  } catch {
    const reason = t(`${claudeJson} がありません`, `${claudeJson} does not exist`)
    warnOnce(
      `missing:${dir.dir}`,
      t(`[agents] ${dir.account}: ${reason} — ライブ状態の取得を見送ります`, `[agents] ${dir.account}: ${reason} — skipping live state`),
    )
    return { available: false, agents: [], reason }
  }

  try {
    const { stdout } = await exec(claudeBin(), ['agents', '--json'], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir.dir },
      timeout: TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    })
    return { available: true, agents: normalize(stdout) }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    warnOnce(
      `exec:${dir.dir}`,
      t(`[agents] ${dir.account}: claude agents --json に失敗 — ${reason}`, `[agents] ${dir.account}: claude agents --json failed — ${reason}`),
    )
    return { available: false, agents: [], reason }
  }
}

/**
 * ⚠️ Exported for tests (2026-08-18 codex review, medium #4).
 *    On machines whose CLI has no index this is the only path, so **a dropped field is checked by machine**.
 */
export function normalize(stdout: string): LiveAgent[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim() || '[]')
  } catch {
    return []
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>)['agents'])
      ? ((parsed as Record<string, unknown>)['agents'] as unknown[])
      : []

  const out: LiveAgent[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const sessionId = typeof o['sessionId'] === 'string' ? o['sessionId'] : undefined
    if (!sessionId) continue
    out.push({
      sessionId,
      pid: typeof o['pid'] === 'number' ? o['pid'] : undefined,
      cwd: typeof o['cwd'] === 'string' ? o['cwd'] : undefined,
      kind: typeof o['kind'] === 'string' ? o['kind'] : undefined,
      name: typeof o['name'] === 'string' ? o['name'] : undefined,
      status: typeof o['status'] === 'string' ? o['status'] : undefined,
      // ⚠️ Dropping this hides the reason on CLIs without an index (machines that fall back to this command)
      waitingFor: typeof o['waitingFor'] === 'string' ? o['waitingFor'] : undefined,
      startedAt: typeof o['startedAt'] === 'number' ? o['startedAt'] : undefined,
    })
  }
  return out
}
