// Get live sessions from `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json`.
//
// ★ Why we use this (found 2026-08-12. ARCHITECTURE.md §9.1):
//   The same information (sessionId / status / name) is **written to a file**, so
//   there is no need to call `claude agents --json`. What not calling it buys us:
//
//   1. ⚠️ Removes the source of accidents that break .claude.json. That command creates
//      a new, practically empty 309B file when the file is missing (CLAUDE.md §5 / caused real damage twice)
//   2. State is available for the default account too. Since CLAUDE_CONFIG_DIR is not set explicitly,
//      the "liveAvailable:false on machines that keep the config directly under home" problem goes away (machine B is like this)
//   3. We get messagingSocketPath = the entry point into a live session (§9.7 / used in M4)
//   4. Fast, since no child process is spawned
//
// ⚠️ This is an internal format, not in the official docs. If it disappears we fall back to agents.ts (guarded).
//
// ⚠️⚠️ pids get reused. "The file exists" does not prove the process is alive.
//   We compare procStart (starttime from /proc/<pid>/stat) so that another process is not
//   mistaken for the same session. Without this, dead sessions stay
//   "responding" forever.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConfigDir } from './configDirs.ts'
import { liveAgents, type LiveAgent, type LiveResult } from './agents.ts'

const TTL_MS = 2000

export interface IndexEntry {
  pid: number
  sessionId: string
  cwd?: string
  name?: string
  status?: string
  /** ★ "What it is waiting for", written by the CLI when `status: "waiting"` (2026-08-18) */
  waitingFor?: string
  kind?: string
  startedAt?: number
  /** starttime from /proc/<pid>/stat (kept as a string). Used to detect pid reuse */
  procStart?: string
  /** UNIX socket for dropping messages into a live session (§9.7) */
  messagingSocketPath?: string
}

export interface IndexResult extends LiveResult {
  /** 'index' = from sessions/*.json / 'cli' = fell back to agents --json */
  source: 'index' | 'cli'
}

const cache = new Map<string, { at: number; result: IndexResult }>()

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** Validate one file's JSON. Entries without sessionId and pid are unusable */
export function parseIndexEntry(raw: unknown): IndexEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const sessionId = str(o['sessionId'])
  const pid = num(o['pid'])
  if (!sessionId || pid === undefined || pid <= 0) return null
  return {
    pid,
    sessionId,
    cwd: str(o['cwd']),
    name: str(o['name']),
    status: str(o['status']),
    waitingFor: str(o['waitingFor']),
    kind: str(o['kind']),
    startedAt: num(o['startedAt']),
    // Treat procStart as a string even if written as a number (string equality is enough for comparison)
    procStart: str(o['procStart']) ?? (num(o['procStart']) !== undefined ? String(o['procStart']) : undefined),
    messagingSocketPath: str(o['messagingSocketPath']),
  }
}

/**
 * Keep only the live ones.
 *
 * @param aliveProcStart Function returning the starttime if the pid is alive, or null if it is dead.
 *                       On environments where starttime is unavailable (mac etc.) it may return undefined
 *                       — in that case we only conclude "alive".
 */
export function selectLive(
  entries: IndexEntry[],
  aliveProcStart: (pid: number) => string | null | undefined,
): LiveAgent[] {
  const out: LiveAgent[] = []
  // If the same sessionId appears under several pids, take the one started later
  const bySession = new Map<string, IndexEntry>()

  for (const e of entries) {
    const actual = aliveProcStart(e.pid)
    if (actual === null) continue // no such process
    // ★ Detect pid reuse: compare only when both starttimes are known
    // ⚠️ Compare with `sameProcStart` (ignores only whitespace packing / for mac's `ps`)
    if (actual !== undefined && e.procStart !== undefined && !sameProcStart(actual, e.procStart)) continue

    const cur = bySession.get(e.sessionId)
    if (!cur || (e.startedAt ?? 0) >= (cur.startedAt ?? 0)) bySession.set(e.sessionId, e)
  }

  for (const e of bySession.values()) {
    out.push({
      sessionId: e.sessionId,
      pid: e.pid,
      cwd: e.cwd,
      kind: e.kind,
      name: e.name,
      status: e.status,
      waitingFor: e.waitingFor,
      startedAt: e.startedAt,
      messagingSocketPath: e.messagingSocketPath,
    })
  }
  return out
}

/**
 * starttime from /proc/<pid>/stat (the 22nd field).
 *
 * ⚠️ comm (the 2nd field) is wrapped in parentheses and may contain spaces and parentheses.
 *    A naive split(' ') breaks, so look at what follows the last ')'.
 */
export function parseProcStart(stat: string): string | undefined {
  const close = stat.lastIndexOf(')')
  if (close < 0) return undefined
  // ') S 1 2 3 …' → counting state as the 1st, starttime is the 20th
  const fields = stat.slice(close + 1).trim().split(/\s+/)
  return fields[19]
}

/**
 * ★★ **Process identity on mac** (2026-09-22 / got stuck on a real machine).
 *
 * ⚠️⚠️ mac has no `/proc`, so starttime could not be read and `aliveProcStartSync`
 *    returned `undefined` (alive but unverifiable). ⇒ `inbox.ts` / `keys.ts`
 *    **refused to send as `unverified`** = **on mac not a single character could be sent from the phone**
 *    (the screen said "cannot send because the session's process cannot be verified").
 *
 * ★ Learned by measuring on a real machine (2026-09-22): **the CLI writes `procStart` on mac too**.
 *   Its content is **`lstart` in the C locale and UTC** (e.g. `"Mon Sep 21 23:12:13 2026"`).
 *   ⇒ **If we call `ps` under the same conditions, we can compare them as strings.**
 *   ⚠️⚠️ **Always** pass `LC_ALL=C` and `TZ=UTC` (on the user's terminal it came out
 *      like `"火  9/22 08:12:13 2026"` = **garbled by locale and time zone** = measured).
 *
 * ⚠️ **Do not spawn `ps` once per pid** (spawning once per index entry is slow).
 *    Take the list **once** and remember it briefly. ⚠️ Remembering too long makes "dead pids look alive", so keep it short.
 */
const PS_CACHE_MS = 1000
let psCache: { at: number; map: Map<number, string> } | undefined

/** ⚠️ Output of `ps -A -o pid=,lstart=` → starttime per pid (★ parsing only = testable) */
export function parsePsSnapshot(out: string): Map<number, string> {
  const map = new Map<number, string>()
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\S.*\S)\s*$/.exec(line)
    if (!m) continue
    // ⚠️ Whitespace packing differs between `ps` implementations (two spaces for a 1-digit day), so **collapse before** storing.
    //    ⚠️ The other side of the comparison goes through the same collapsing (`sameProcStart`).
    map.set(Number(m[1]), m[2]!.replace(/\s+/g, ' '))
  }
  return map
}

/**
 * ★ Whether two starttimes are the same. ⚠️ Ignores **only whitespace packing** (strict otherwise).
 *
 * ⚠️⚠️ Do not loosen this (loosening misses pid reuse = **typing text into a different process**).
 */
export function sameProcStart(a: string, b: string): boolean {
  return a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()
}

/** ⚠️ Empty if unavailable (= falls back to `undefined` as before / fail-safe) */
function psSnapshot(run: () => string): Map<number, string> {
  const now = Date.now()
  if (psCache && now - psCache.at < PS_CACHE_MS) return psCache.map
  let map = new Map<number, string>()
  try {
    map = parsePsSnapshot(run())
  } catch {
    // ⚠️ `ps` missing or failed = unverifiable (falls to **not sending**. Never allow on our own)
  }
  psCache = { at: now, map }
  return map
}

function runPs(): string {
  // ⚠️⚠️ **Pin the locale and time zone** (measured: on the user's terminal it came out in Japanese / JST)
  return execFileSync('ps', ['-A', '-o', 'pid=,lstart='], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    maxBuffer: 4 << 20,
  })
}

/**
 * starttime if the pid is alive (undefined if unknown), null if dead. Also used by inbox.ts.
 *
 * ★ The decision itself lives in `resolveProcStart` (the `ps` spawn is injectable = testable).
 */
export function aliveProcStartSync(pid: number): string | null | undefined {
  return resolveProcStart(pid, readProcStat, () => psSnapshot(runPs), HAS_PROC)
}

/**
 * ★★ **For the identity check right before sending** (2026-09-23 / codex round 13, high #1). ⚠️ **No cache.**
 *
 * ⚠️⚠️ On mac `aliveProcStartSync` **remembers the `ps` list for 1 second** (the listing path calls it once per entry).
 *    If that is also used for the check right before sending, **a pid that dies and is reused within that second returns the old start time**,
 *    and another process may be accepted as "the same session" (keystrokes are TUI input = close to arbitrary command execution).
 * ⇒ The sending paths (`findTarget` in `inbox.ts` / target lookup in `keys.ts`) **query only that pid, fresh**.
 * ★ On Linux `/proc` is read directly, so this is the same as `aliveProcStartSync` (no `ps` spawned).
 */
export function aliveProcStartFreshSync(pid: number): string | null | undefined {
  return resolveProcStart(pid, readProcStat, () => freshSnapshot(pid, runPsOne), HAS_PROC)
}

/** ★ Query only that pid, fresh (⚠️ not remembered). ⚠️ Empty if unavailable = unverifiable (toward not sending) */
export function freshSnapshot(pid: number, run: (pid: number) => string): Map<number, string> {
  try {
    return parsePsSnapshot(run(pid))
  } catch {
    return new Map()
  }
}

function runPsOne(pid: number): string {
  // ⚠️⚠️ **Pin the locale and time zone** (same conditions as the listing `runPs` = same string shape)
  return execFileSync('ps', ['-o', 'pid=,lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    maxBuffer: 1 << 16,
  })
}

function readProcStat(p: number): string | undefined {
  try {
    // A synchronous read is fine: a few dozen entries of a few hundred bytes are negligible
    return readFileSync(`/proc/${p}/stat`, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * ★★ **Whether this OS has `/proc`** (2026-09-23 / removed a side effect of the mac support).
 *
 * ⚠️⚠️ It used to be "fall back to `ps` if `/proc/<pid>/stat` **could not be read**" ⇒ even on Linux
 *    **a merely dead pid spawned `ps -A`** (same result, "dead" = harm to performance only).
 *    ⇒ The correct condition is not "could not read" but "**on an OS without `/proc`**".
 * ★ Measured only once (the OS does not change mid-run).
 */
const HAS_PROC = existsSync('/proc/self/stat')

/** ★ The core (⚠️ `/proc` and `ps` are injected = the mac path can be tried from Linux) */
export function resolveProcStart(
  pid: number,
  readStat: (pid: number) => string | undefined,
  snapshot: () => Map<number, string>,
  /** ⚠️ **Required** (no default = do not go back to a shape where forgetting it makes Linux silently spawn `ps`) */
  hasProc: boolean,
): string | null | undefined {
  const stat = readStat(pid)
  if (stat !== undefined) return parseProcStart(stat) ?? undefined
  // ★ Only on an OS without `/proc` (mac), look it up in the `ps` list.
  //   ⚠️ `/proc` exists but cannot be read = **dead** (`ps` would give the same answer)
  if (!hasProc) {
    const found = snapshot().get(pid)
    if (found !== undefined) return found
  }
  // ⚠️ Do not conclude "not in the list = dead" (`ps` may have failed)
  //    ⇒ Check existence only; if alive, fall to **undefined** (= unverifiable).
  try {
    process.kill(pid, 0)
    return undefined
  } catch {
    return null
  }
}

/**
 * ★★ Classification when the index directory could not be read (2026-08-24 codex medium #2, low).
 *
 * ⚠️⚠️ **Only ENOENT means "missing"** (= an old CLI that does not write the index). Everything else
 *    falls to "unreadable". Previously every exception was rounded to "missing", so
 *    **EACCES / EMFILE (fd exhaustion) were treated like "no index"**, and keystrokes and
 *    "stop" asserted **not-found (that session is not running)** (measured).
 * ⚠️ `ENOTDIR` (`sessions` became a regular file) is also on the **broken side**
 *    (an old CLI never produces that). ⇒ Do not assert.
 * ★ The classification is a function **so that an exhaustive test can pin it**
 *   (codex named the mutant "mixing in EMFILE stays green").
 */
export function indexDirFailure(code: string | undefined): 'missing' | 'unreadable' {
  return code === 'ENOENT' ? 'missing' : 'unreadable'
}

/**
 * ★★ Return the index entries that were read, plus **how many could not be read** (2026-08-21 codex review, high #3).
 *
 * ⚠️⚠️ Dropping the skipped count makes it **impossible to tell "that session is gone" from "only that file could not be read"**.
 *    The notification side asserts "done" for the former, so stepping on a single half-written index file
 *    **notifies "done" for a running session** (this bypassed the explicit fail-open ban).
 */
export async function readIndexEntriesDetailed(
  dir: ConfigDir,
): Promise<{ entries: IndexEntry[]; skipped: number; skippedPids: number[] } | null> {
  const sessionsDir = join(dir.dir, 'sessions')
  let names: string[]
  try {
    names = await readdir(sessionsDir)
  } catch (err) {
    const code = (err as { code?: string } | null)?.code
    if (indexDirFailure(code) === 'missing') return null // no index (old CLI)
    // ⚠️ We do not know how many there were, so count 1 (if non-zero, the caller does not assert).
    //    ⚠️ **We also do not know which pids were unreadable** (`skippedPids` is empty)
    return { entries: [], skipped: 1, skippedPids: [] }
  }
  const entries: IndexEntry[] = []
  let skipped = 0
  /**
   * ★ pids of files that could not be read (2026-08-24 codex medium #3).
   *
   * ⚠️ Without this, "something was unreadable" alone falls back to the CLI, so **a single rotten leftover of a dead
   *    session makes us hit `claude agents --json` (up to 10 seconds) every time**.
   *    ⇒ Return them so the caller can check "is that pid alive".
   */
  const skippedPids: number[] = []
  await Promise.all(
    names
      .filter((n) => /^\d+\.json$/.test(n)) // only <pid>.json. Do not read *.key
      .map(async (n) => {
        const pid = Number(n.slice(0, -'.json'.length))
        try {
          const parsed = parseIndexEntry(JSON.parse(await readFile(join(sessionsDir, n), 'utf8')))
          if (parsed) entries.push(parsed)
          // ⚠️ Readable as JSON but the wrong shape = the content cannot be trusted. Count it
          else {
            skipped++
            skippedPids.push(pid)
          }
        } catch {
          // Being written / broken = count it (do not drop it)
          skipped++
          skippedPids.push(pid)
        }
      }),
  )
  return { entries, skipped, skippedPids }
}

export async function readIndexEntries(dir: ConfigDir): Promise<IndexEntry[] | null> {
  const detailed = await readIndexEntriesDetailed(dir)
  return detailed ? detailed.entries : null
}


/**
 * ★★ Drop the 2-second cache (2026-08-18 codex review, medium #1).
 *
 * ⚠️ **Without this, "instant update" is a lie.** Even if the watcher (`sessionWatch`) spots a change and
 *    fires `sessions-changed`, the `/sessions` the PWA re-fetches returns **a value up to 2 seconds old**.
 *    The watcher's copy is already new, so **no second signal comes and the stale view stays until the next 15-second poll**.
 *    → Whoever spots the change drops this before re-fetching.
 */
export function invalidateLiveSessions(dir?: string): void {
  if (dir === undefined) cache.clear()
  else cache.delete(dir)
}

/**
 * ★★ Whether the index may be trusted (2026-08-24 codex medium, medium #3).
 *
 * ⚠️⚠️ Fixed twice:
 *   1. "If zero entries were read, use the CLI" ⇒ asserted 0 when **every readable entry was a dead pid**
 *   2. "If zero are alive and something was unreadable, use the CLI" ⇒ **a single rotten dead leftover
 *      made us hit the CLI (a path of up to 10 seconds) every time**
 * ⇒ Fall back **only when the pid of an unreadable file is "alive / unknown"**.
 *    ⚠️ When the whole directory was unreadable (pids unknown), fall back (do not assert).
 */
export function shouldTrustIndex(
  agents: unknown[],
  skipped: number,
  skippedPids: number[],
  aliveProcStart: (pid: number) => string | null | undefined,
): boolean {
  if (agents.length > 0) return true // we have live ones
  if (skipped === 0) return true // nothing unreadable (= truly 0)
  // ⚠️ We do not know which pids were unreadable ⇒ do not assert
  if (skippedPids.length === 0) return false
  // ★ If even one unreadable pid cannot be called "dead", go to the CLI
  return skippedPids.every((pid) => aliveProcStart(pid) === null)
}

/** Live sessions. Falls back to agents --json if the index is unusable */
export async function liveSessions(dir: ConfigDir): Promise<IndexResult> {
  const hit = cache.get(dir.dir)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.result

  // ★★ **Use `readIndexEntriesDetailed`** (2026-08-24 codex medium #1).
  //
  // ⚠️⚠️ The thin API (`readIndexEntries`) drops `skipped`, so **when not a single index entry could be read**
  //    it **asserts** "0 live sessions" (= the list shows running sessions
  //    as "not running", and that also lands in the 2-second cache).
  //    ⇒ **If nothing was read but something was unreadable, do not trust the index**
  //      (fall back to the CLI. If that fails too, `available:false` = honestly "could not get it").
  const read = await readIndexEntriesDetailed(dir)
  let result: IndexResult
  // ★★ **Check liveness first, then** decide "may the index be trusted" (2026-08-24 codex medium).
  //
  // ⚠️⚠️ "Adopt if even one entry was read" asserts "0 running" when **every readable entry is a dead pid**
  //    (= leftovers) and **the broken one is actually running**.
  //    ⇒ If zero are known to be alive and something was unreadable, fall back to the CLI.
  // ⚠️ Conversely, if even one live entry is found, use the index (falling back to the CLI every time is heavy,
  //    and `claude agents --json` is a path we would rather not touch / CLAUDE.md §5).
  const agents = read ? selectLive(read.entries, aliveProcStartSync) : []
  if (read === null || !shouldTrustIndex(agents, read.skipped, read.skippedPids, aliveProcStartSync)) {
    const fallback = await liveAgents(dir)
    result = { ...fallback, source: 'cli' }
  } else {
    result = { available: true, agents, source: 'index' }
  }
  cache.set(dir.dir, { at: Date.now(), result })
  return result
}
