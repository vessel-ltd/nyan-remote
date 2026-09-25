import { hostname } from 'node:os'
import { basename, join } from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import type { AccountInfo, SessionStatus, SessionSummary } from '../../../shared/types.ts'
import type { ConfigDir } from './configDirs.ts'
// ★ The main path is sessions/<pid>.json (sessionIndex.ts).
//   agents --json is called inside as a fallback for old CLIs without an index (§9.1)
import { liveSessions } from './sessionIndex.ts'
import { hooksFor, type SessionHooks } from './hookState.ts'
import { listPending } from '../permission.ts'
import { readTranscriptMeta } from './transcript.ts'

/** Threshold for hiding empty "just started" sessions from the list (measured: many were 1520B) */
const MIN_BYTES = 1024
/** Concurrency for reading transcript metadata */
const CONCURRENCY = 8

export interface CollectResult {
  machine: string
  sessions: SessionSummary[]
  accounts: AccountInfo[]
}

export async function collectSessions(dirs: ConfigDir[], maxPerAccount: number): Promise<CollectResult> {
  const machine = hostname()
  const sessions: SessionSummary[] = []
  const accounts: AccountInfo[] = []
  // ★ Sessions currently waiting for approval. They are present only while the hook connection is alive,
  //   so this is more reliable than the guess from `Notification` (read the notes on resolveStatus)
  const pendingSessions = new Set(
    listPending()
      .map((p) => p.sessionId)
      .filter((id): id is string => Boolean(id)),
  )

  for (const dir of dirs) {
    const live = await liveSessions(dir)
    const liveById = new Map(live.agents.map((a) => [a.sessionId, a]))

    const files = await listTranscripts(dir.projectsDir)
    files.sort((a, b) => b.mtimeMs - a.mtimeMs)

    const picked = files
      .filter((f) => f.bytes >= MIN_BYTES || liveById.has(f.sessionId))
      .slice(0, maxPerAccount)

    const metas = await mapLimit(picked, CONCURRENCY, async (f) => {
      try {
        return await readTranscriptMeta(f.path)
      } catch {
        return null
      }
    })

    let count = 0
    for (const meta of metas) {
      if (!meta) continue
      const agent = liveById.get(meta.sessionId)
      const isLive = Boolean(agent)
      const cwd = meta.cwd ?? agent?.cwd ?? ''
      const lastActivity = meta.lastActivity ?? new Date(meta.mtimeMs).toISOString()
      const hooks = hooksFor(meta.sessionId)
      const { status, lastEvent } = resolveStatus(
        agent?.status,
        isLive,
        hooks,
        lastActivity,
        // ★ Whether there is an actual pending-approval card. More reliable than the guess from Notification
        pendingSessions.has(meta.sessionId),
      )
      sessions.push({
        machine,
        account: dir.account,
        sessionId: meta.sessionId,
        cwd,
        project: cwd ? basename(cwd) : '—',
        title: meta.title,
        titleSource: meta.titleSource,
        status,
        // ★ Pass the reason for "needs attention" **only when the CLI states it** (2026-08-18).
        //
        //   ⚠️⚠️ **Also require the CLI's raw status** (flagged by /code-review the same day).
        //     `status` (our verdict) **also becomes `waiting` from cards and Notification**, so
        //     gating on it alone means that when "a stale `waitingFor` remained in the record" we
        //     **lie with `要対応（sandbox の許可）` for a pending-approval card**.
        //     The current CLI clears `waitingFor` on every transition, but do not rely on that
        //     (`Okt` writes by **merging**, so it breaks if the implementation stops clearing it).
        ...(status === 'waiting' && agent?.status === 'waiting' && agent.waitingFor
          ? { waitingFor: agent.waitingFor }
          : {}),
        live: isLive,
        permissionMode: meta.permissionMode,
        gitBranch: meta.gitBranch,
        cliVersion: meta.cliVersion,
        lastActivity,
        transcriptBytes: meta.bytes,
        lastEvent,
        awaySummary: meta.awaySummary,
        // ★ Amount of context currently in use (omitted if unknown / 2026-08-19)
        ...(meta.contextTokens === undefined ? {} : { contextTokens: meta.contextTokens }),
      })
      count++
    }

    accounts.push({
      account: dir.account,
      configDir: dir.dir,
      loginCached: dir.loginCached,
      sessionCount: count,
      liveAvailable: live.available,
    })
  }

  sessions.sort(compare)
  return { machine, sessions, accounts }
}

/**
 * Look up the transcript file from a sessionId.
 * Instead of listing every file, only check whether each project directory has `<sessionId>.jsonl`
 * (one stat per project).
 */
export async function findTranscript(
  dirs: ConfigDir[],
  sessionId: string,
): Promise<{ dir: ConfigDir; path: string } | null> {
  // Used as a path component, so reject characters outside a UUID (path traversal defense)
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return null
  for (const dir of dirs) {
    let projects: string[] = []
    try {
      projects = await readdir(dir.projectsDir)
    } catch {
      continue
    }
    for (const project of projects) {
      const path = join(dir.projectsDir, project, `${sessionId}.jsonl`)
      try {
        const s = await stat(path)
        if (s.isFile()) return { dir, path }
      } catch {
        // Not here; try the next
      }
    }
  }
  return null
}

/**
 * A lightweight version for /health. Does not read transcript contents; looks only at stat and live state.
 * (collectSessions opens up to 60 files x 2 accounts, so it is not used for /health)
 */
export async function describeAccounts(dirs: ConfigDir[]): Promise<AccountInfo[]> {
  const out: AccountInfo[] = []
  for (const dir of dirs) {
    const live = await liveSessions(dir)
    const files = await listTranscripts(dir.projectsDir)
    const liveIds = new Set(live.agents.map((a) => a.sessionId))
    out.push({
      account: dir.account,
      configDir: dir.dir,
      loginCached: dir.loginCached,
      sessionCount: files.filter((f) => f.bytes >= MIN_BYTES || liveIds.has(f.sessionId)).length,
      liveAvailable: live.available,
    })
  }
  return out
}

/** Hooks fire at almost the same time as the transcript's last activity, so ignore small reorderings */
const HOOK_TOLERANCE_MS = 3000

/**
 * ★★ The **known vocabulary** of `status` that the CLI writes to the session record (from the CLI 2.1.233 binary / 2026-08-16).
 *
 * ```js
 * XB_ = ["busy", "shell", "idle", "waiting"]
 * ```
 *
 * ⚠️⚠️ Needed **so that unknown values do not fall to "done"**. `resolveStatus` lets unknown values through and
 *    makes them `done` based on the Stop hook (= the list shows that), but **notifications must not assert it**
 *    (on 2026-08-16, not knowing `shell`, we actually notified "done" — real damage).
 * ⚠️ Do not write the vocabulary anywhere else. With two copies, only one grows and the same accident happens.
 */
const KNOWN_RAW_STATUS = new Set(['busy', 'shell', 'idle', 'waiting'])

export function isKnownRawStatus(raw: string | undefined): boolean {
  return raw !== undefined && KNOWN_RAW_STATUS.has(raw)
}

/**
 * How the state is decided (in priority order):
 *   0. ★ There is an approval card (the hook is waiting) → awaiting approval  ← **the most reliable evidence**
 *   1. Approval request after the last activity   → awaiting approval (a fallback from `Notification`)
 *   1.5 Abnormal end after the last activity      → ★ abnormal end (do not let busy/shell hide it)
 *   2. Live and busy                              → responding
 *   2.5 Live and shell                            → ★ running in the background (a background Bash is running)
 *   2.6 Live and waiting                          → ★ needs attention (the CLI shows a dialog and waits)
 *   3. Turn ended after the last activity         → done
 *   4. Live → starting / otherwise → treated as ended (the UI decides with live=false)
 *
 * ⚠️ **Check 2.5 before Stop.** The turn ends even while a background task runs, so
 *    `Stop` arrives. Checking Stop first gives "done", and **we actually hit this** (2026-08-16).
 *
 * ⚠️ Check awaiting-approval before busy.
 *    Approval requests happen mid-turn, so the process is still busy at that moment.
 *    Deciding busy first means **awaiting approval is not shown exactly when it is needed most** (it actually was so).
 *    After approval, the tool result is written to the transcript and the last activity overtakes the hook, so it clears automatically.
 *
 * The "after the last activity" condition is the key point. When the user replies the transcript grows,
 * so awaiting approval and done clear automatically (no clearing event is awaited).
 *
 * ⚠️ Take lastActivity only from conversation records (see the comment in transcript.ts).
 *    Including system housekeeping (away_summary is written 3 minutes later) makes the state vanish.
 */
export function resolveStatus(
  raw: string | undefined,
  isLive: boolean,
  hooks: SessionHooks | undefined,
  lastActivity: string,
  /**
   * ★ Whether there is actually a card waiting for approval right now (via the `PermissionRequest` hook).
   *
   * This is **the most reliable evidence**. It is true only while the hook connection is alive,
   * and becomes false the moment it is answered, times out, or is cleaned up.
   *
   * ⚠️ `hooks.permission` (from `Notification`), by contrast, only says "it is asking" and
   *    **does not tell us when it has been answered**. So the checks below are a fallback, not the main path.
   */
  hasPendingApproval = false,
): { status: SessionStatus; lastEvent?: string } {
  const activityAt = Date.parse(lastActivity)

  // ★ If there is a card, it is awaiting approval, period. Check before busy (approval happens mid-turn)
  if (hasPendingApproval) return { status: 'waiting', lastEvent: 'PermissionRequest' }

  /**
   * Whether the hook is "after the last activity".
   *
   * @param toleranceMs Tolerance for Stop. The hook can arrive slightly before
   *   the transcript write (events of the same instant look reversed).
   *   ⚠️ **No tolerance for awaiting approval**. Using one causes the accident described below.
   */
  const isAfterActivity = (at: string, toleranceMs: number): boolean => {
    const t = Date.parse(at)
    // A hook with an unreadable time is not treated as "current" (do not fabricate state)
    if (Number.isNaN(t)) return false
    // When the last activity is unreadable, trust the hook (it is the only clue, so keep it)
    if (Number.isNaN(activityAt)) return true
    return t >= activityAt - toleranceMs
  }

  // ★★ Abnormal end comes before everything else (2026-08-16 external review, medium #4).
  //
  //   ⚠️ Checking `busy` / `shell` first **hides `StopFailure`**.
  //      It is a state meant to be raised as "waiting on you" so it gets noticed, yet merely something running in the background
  //      turned it into "running in the background" (introduced when `shell` was added).
  //   ⚠️ So that old failures do not linger, the "after the last activity" condition applies here too.
  if (hooks?.stop?.event === 'StopFailure' && isAfterActivity(hooks.stop.at, HOOK_TOLERANCE_MS)) {
    return { status: 'error', lastEvent: 'StopFailure' }
  }

  if (isLive && raw === 'busy') return { status: 'working' }

  // ★★ Running in the background (found by measurement on 2026-08-16).
  //
  //   The CLI writes **4 kinds** of status to the session record: `["busy","shell","idle","waiting"]`.
  //   For a long time we only knew `busy`, and **the rest passed through as "unknown values"**.
  //   As a result they fell into the Stop check below and **were shown as "done"**.
  //
  //   `shell` is the state "the main loop is free, but **a background Bash is running**"
  //   (CLI side: `status === "idle" && a running local_bash exists → "shell"`).
  //   This is what you get while `codex exec` or a long test runs in the background.
  //   ⚠️ Measured: `Stop` arrived with a background task still running, and the phone showed "done" (real damage).
  //
  //   ★ Do not mix this into "responding". **"Claude is thinking" and "waiting on codex"
  //      mean different things on the phone** (the former replies soon / the latter is a wait).
  //
  //   ⚠️ Background sub-agents (Task / skills running in the background) stay `busy`, so **they never get here**
  //      (confirmed by 7 minutes of measurement. It stayed busy even after `Stop` arrived twice).
  if (isLive && raw === 'shell') return { status: 'background' }

  // ★ The CLI shows a dialog on screen and waits for a human (`waiting`).
  //   ⚠️ This too passed through as an "unknown value" and became **"done" based on Stop**
  //      (2026-08-16 external review, medium #4. Confirmed that `waiting + Stop` actually became done).
  //   ⚠️ Not observed for real (we have not yet seen `waiting` in this environment). Based on the CLI
  //      implementation (set by `sandbox request` / `input needed` / `dialog open` etc.).
  if (isLive && raw === 'waiting') return { status: 'waiting' }

  // ★★ From here down we know "the CLI itself is not waiting for a human" (since busy / shell /
  //    waiting were returned above).
  //
  //   The check derived from Notification (approval request) goes **after that**.
  //
  //   ⚠️ The awaiting-approval check (two bugs found in the 2026-08-12 external review):
  //     ① The 3-second tolerance was also applied to awaiting approval, so **if activity stopped within 3 seconds
  //        of the approval, it stayed stuck at waiting**. So no tolerance; compare strictly.
  //     ② permission was only checked first and never compared against stop, so
  //        **a later Stop could not clear a stale permission.**
  //
  //   ⚠️⚠️ **Why after busy / shell (hit on a real machine on 2026-08-18, confirmed from the CLI implementation)**
  //
  //   What happened on the real machine (machine B / session `git-push fix`):
  //     04:36:31  last transcript write (a tool call) → Notification right after
  //     ~04:52    approved on the PC, `codex exec` runs for 21 minutes (nothing written to the transcript)
  //     04:52     agent restarted (deploy) → the answerable card died, only the memory was restored
  //     04:36-57  **"needs attention" for 21 minutes straight** (nothing to answer. /permissions was empty)
  //     04:57:40  the tool finished and wrote → the memory was overtaken and cleared
  //
  //   `Notification` only says "it is asking" and **does not tell us when it has been answered**.
  //   It clears in only two ways, "the last activity overtakes it" or `permissionSweep` finds the result, and
  //   **neither happens with an approved, long-running tool**.
  //
  //   ★ Reading the CLI 2.1.234 implementation (`kZh` / `Bqw` / `hbg`):
  //       if even one dialog is open, status is **`waiting`** (decided before `busy`,
  //       `working: false`). If none is open, `busy` / `idle` depending on `isLoading`.
  //     ⇒ **With `busy` / `shell` no dialog is open** = not waiting for a human.
  //       So a `permission` at this point is **always stale by then**.
  //
  //   ⚠️ Two grounds that we do not hide a real approval:
  //     - If our hook is installed, the **card** (`hasPendingApproval`) takes effect first
  //     - Even without it, while a dialog is open **the CLI itself says `waiting`**
  if (hooks?.permission && isAfterActivity(hooks.permission.at, 0)) {
    const stopAt = hooks.stop ? Date.parse(hooks.stop.at) : NaN
    const permAt = Date.parse(hooks.permission.at)
    const resolvedByStop = !Number.isNaN(stopAt) && !Number.isNaN(permAt) && stopAt > permAt
    if (!resolvedByStop) {
      return { status: 'waiting', lastEvent: 'Notification' }
    }
  }

  if (hooks?.stop && isAfterActivity(hooks.stop.at, HOOK_TOLERANCE_MS)) {
    return {
      status: hooks.stop.event === 'StopFailure' ? 'error' : 'done',
      lastEvent: hooks.stop.event,
    }
  }

  if (isLive) return { status: raw === 'idle' ? 'idle' : 'unknown' }
  return { status: 'idle' }
}

/** Live ones on top, then by last activity time descending */
function compare(a: SessionSummary, b: SessionSummary): number {
  const rank = (s: SessionSummary) => (s.status === 'working' ? 0 : s.live ? 1 : 2)
  const d = rank(a) - rank(b)
  if (d !== 0) return d
  return b.lastActivity.localeCompare(a.lastActivity)
}

interface FileEntry {
  path: string
  sessionId: string
  bytes: number
  mtimeMs: number
}

async function listTranscripts(projectsDir: string): Promise<FileEntry[]> {
  const out: FileEntry[] = []
  let projects: string[] = []
  try {
    projects = await readdir(projectsDir)
  } catch {
    return out
  }
  for (const project of projects) {
    const projectPath = join(projectsDir, project)
    let names: string[] = []
    try {
      names = await readdir(projectPath)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const path = join(projectPath, name)
      try {
        const s = await stat(path)
        if (!s.isFile()) continue
        out.push({
          path,
          sessionId: name.replace(/\.jsonl$/, ''),
          bytes: s.size,
          mtimeMs: s.mtimeMs,
        })
      } catch {
        // Ignore files that vanished or cannot be read
      }
    }
  }
  return out
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i]!)
    }
  })
  await Promise.all(workers)
  return results
}
