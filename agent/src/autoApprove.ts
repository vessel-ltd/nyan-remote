// A mode that automatically passes only "yes/no" approvals (per session, with an expiry).
//
// ★★ Why this lives in the agent (PC side):
//   The agent is what receives the approval hook, so **it is pointless unless it works while the phone is closed**.
//   ⇒ This is the second exception to CLAUDE.md §2's "do not keep state on the server side".
//   ⚠️ However, **its authority is "only its own sessions"** (§6 terminology), so there is no replication or consensus.
//
// ★★ What gets auto-passed (**look at both criteria**):
//   - `requiresInteraction(toolName)` … `AskUserQuestion` / `ExitPlanMode` (known by name)
//   - `interaction` is attached       … something built as a question with choices
//   ⚠️⚠️ **Never rely only on whether `interaction` is present.** `describeInteraction` returns
//     **`undefined` even for broken input**, so looking only at that misjudges a broken `AskUserQuestion`
//     as "yes/no" (the actual harm is only "it stalls on the PC", but this is exactly the CLAUDE.md §2
//     pattern of "inferring meaning from the stored shape"). ⇒ **Stop on the OR of both.**
//
// ⚠️⚠️ **The scope of the danger is accepted** (2026-09-07 user decision). Approvals without `interaction`
//   include **all of** arbitrary `Bash` commands, file rewrites and `WebFetch` (effectively a remote
//   `--dangerously-skip-permissions`). No exclusion list (adding one would erase almost all the benefit).
//   ⇒ Instead it is balanced by **(1) per session (2) a 3-hour cap (3) staying visible on screen (4) a notification on expiry**.
//
// ★ A broken state file is handled the **opposite** way from `config.json`:
//   config means "503 for every request if unreadable", but here we **fall back to off and keep the agent running**.
//   ⚠️ Treating it the same way would mean "one auto-approve settings file can stop the whole agent".
//   ⚠️ This is not fail-open (the dangerous side is "on", so falling back to off is the safe direction).
//   ⚠️ When broken, **do not write** (keep the evidence / CLAUDE.md §2). ⇒ Turning it on is refused too.

import type { Interaction, PermissionRequest } from '../../shared/types.ts'
import { requiresInteraction } from './claude/interaction.ts'
import { readJsonFile, writeJson } from './state.ts'
import { t } from '../../shared/i18n.ts'
import { reasonText } from './reasons.ts'
import type { AutoApproveDuration } from '../../shared/types.ts'

/** ⚠️ Under `~/.nyan-remote/` (the §0 protected-name rule; do not use `nyan-remote` here) */
export const AUTO_APPROVE_FILE = 'auto-approve.json'

/**
 * ★★ Table of durations (2026-09-24 / user decision: choose 3 hours / 24 hours; originally 3 hours only).
 *
 * ⚠️ There is no "until explicitly turned off" because **forgetting to turn it off is the only form of accident** (permanent was rejected / user agreed).
 * ⚠️⚠️ Only a **name** comes from the screen (`toAutoApproveDuration`). The lengths exist only here.
 */
export const AUTO_APPROVE_DURATIONS: Record<AutoApproveDuration, number> = {
  '3h': 3 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
}

/** ★ Duration when no name is given (older screens): the same 3 hours as before */
export const AUTO_APPROVE_DEFAULT: AutoApproveDuration = '3h'

/**
 * ★★ Upper bound of the duration (= the longest in the table). ⚠️ An entry in the state file exceeding this is treated as **broken**.
 */
export const AUTO_APPROVE_MAX_MS = Math.max(...Object.values(AUTO_APPROVE_DURATIONS))

/** ★ Turn a value from the screen into a table name (⚠️ unknown values give `undefined` = the caller refuses. Do not fall back to a default) */
export function toAutoApproveDuration(x: unknown): AutoApproveDuration | undefined {
  return typeof x === 'string' && Object.hasOwn(AUTO_APPROVE_DURATIONS, x) ? (x as AutoApproveDuration) : undefined
}

/**
 * Something that has auto-approve enabled.
 *
 * ★★ `until` is an **absolute time** (ISO). ⚠️ Storing remaining time would **rewind the 3 hours on agent restart**.
 * ★ `scope` exists so that "per machine" can be added later
 *   (only `'session'` today; when adding more, split the decision by table as well).
 */
export interface AutoApproveEntry {
  scope: 'session'
  /** Target `sessionId` (the UUID of the transcript file name = the list's `sessionId`) */
  id: string
  /** Not effective after this (ISO8601) */
  until: string
  /** When it was enabled (ISO8601) */
  at: string
}

interface Stored {
  v: 1
  entries: AutoApproveEntry[]
}

/**
 * ★ A remembered entry. **The expiry is turned into a number at load time** (do not call `Date.parse` later).
 *
 * ⚠️⚠️ Why (2026-09-07; a copy of "promote conventions to invariants" learned from the crypto work):
 *   Calling `Date.parse` on every check makes **how to treat an unreadable time** a per-call-site convention
 *   (`NaN > now` is false = do not pass, while `NaN <= now` is also false = cannot be dropped as expired;
 *   a trap where **the directions do not line up**). ⇒ **Convert to a number once at the entrance; if it is not finite, make no entry.**
 */
interface Active {
  entry: AutoApproveEntry
  /** ⚠️ **Always finite** (guaranteed by `validEntry`; `NaN` cannot get in here) */
  untilMs: number
}

/**
 * ★★ The currently remembered state.
 *
 * ⚠️⚠️ **"Broken" and "the set of entries" are one value.** As separate variables,
 *    "entries are empty when broken" becomes a **convention**, and `if (broken)` gets
 *    sprinkled around every check (= redundant guards that **tests cannot kill**, because removing one leaves another to catch it).
 *    ⇒ Make the type ensure "entries cannot be taken out when broken".
 * ★ The check must be doable **synchronously** (it sits in the hook's serial path).
 */
type Loaded =
  | { kind: 'ok'; active: Map<string, Active> }
  | { kind: 'broken'; reason: string }

let state: Loaded = { kind: 'ok', active: new Map() }

/** Called when it turns off automatically on expiry (sends a notification; ⚠️ this layer does not know about push) */
let onExpire: ((entry: AutoApproveEntry) => void) | undefined

const timers = new Map<string, NodeJS.Timeout>()

export function setAutoApproveExpiryHandler(fn: (entry: AutoApproveEntry) => void): void {
  onExpire = fn
}

/**
 * Read at startup.
 *
 * ⚠️ Distinguish "missing" (first run) from "broken" (`readJsonFile`). If broken,
 *    **run with it off and refuse writes too**.
 * ⚠️ Expired entries are dropped at read time (**not written back to the file**: writing on every
 *    start would touch it needlessly when it is not broken. It gets in sync on the next toggle).
 */
export async function loadAutoApprove(now = Date.now()): Promise<void> {
  const file = await readJsonFile<Partial<Stored>>(AUTO_APPROVE_FILE)
  clearTimers()
  if (file.kind === 'broken') {
    state = { kind: 'broken', reason: file.reason }
    console.warn(
      t(
        `[auto] 自動承認の状態が読めないのでオフで動かす: ${file.reason} / ${file.detail}`,
        `[auto] Cannot read the auto-approve state; running with it off: ${reasonText(file.reason)} / ${file.detail}`,
      ),
    )
    return
  }
  const active = new Map<string, Active>()
  state = { kind: 'ok', active }
  if (file.kind === 'missing') return

  // ★★ **If the structure is broken, treat it as "broken"** (2026-09-07 codex, medium #6).
  //
  // ⚠️⚠️ Originally `Array.isArray(entries) ? entries : []` made `{"v":1,"entries":"<broken value>"}`
  //    **normal (0 entries)**. ⇒ A later turn-on succeeded and **overwrote the evidence**
  //    (exactly the rule that `state.ts` must not confuse "readable" with "correct" / CLAUDE.md §2).
  // ⚠️ Also check `v`. **Unknown versions fall back to off** (an old agent reading a file written by
  //    a newer one. The dangerous side is "on", so if unsure, do not pass).
  // ⚠️ If even one entry is invalid, treat the whole thing as broken (**a correct writer never produces
  //    such values**, so discarding them one by one leaves "only part of it works and nobody knows why").
  const problem = structureProblem(file.value)
  if (problem) {
    state = { kind: 'broken', reason: problem }
    console.warn(
      t(
        `[auto] 自動承認の状態が壊れているのでオフで動かす: ${problem}`,
        `[auto] The auto-approve state is broken; running with it off: ${reasonText(problem)}`,
      ),
    )
    return
  }
  const entries = file.value.entries ?? []

  // ★★ Expired entries are not loaded; **notify and clean up** (2026-09-07 codex, high #5).
  //   ⚠️⚠️ If the expiry passes while the agent is stopped, the `onExpire` timer never runs,
  //      so **"it expired" is never announced** (requirement (4) silently fails).
  //   ⚠️ **Save** the cleaned result. Otherwise the same notification fires on every restart.
  const expired: AutoApproveEntry[] = []
  for (const raw of entries) {
    // ⚠️ It passed the check above, so it always becomes an entry (checked by the same function as `structureProblem`)
    const found = validEntry(raw)!
    if (found.untilMs <= now) {
      expired.push(found.entry)
      continue
    }
    active.set(found.entry.id, found)
    schedule(found, now)
  }
  console.log(t(`[auto] 自動承認 有効=${active.size} 期限切れ=${expired.length}`, `[auto] Auto-approve active=${active.size} expired=${expired.length}`))
  if (expired.length === 0) return
  // ⚠️ Save first (do not end up with a notification sent but the entry still there). ⚠️ Write inside the serialization.
  // ★ **Await it** (it is a one-off at startup, so settle it. Fire-and-forget would hide "did we notify"
  //   from the caller, and neither tests nor the real machine could reproduce it)
  await enqueue(async () => {
    const saved = await writeState([...active.values()].map((a) => a.entry))
    // ⚠️⚠️ **Do not notify if saving failed** (2026-09-07 codex round 2, medium #4).
    //    The entries stay on disk, so notifying would **fire the same notification on every restart**.
    //    ⇒ Retry on the next start (= the notification is late, but only sent once).
    //    ★ The flip side of "remember only when it was sent" (`shouldSendLabel`).
    if (!saved.ok) {
      console.warn(
        t(
          `[auto] 期限切れ ${expired.length} 件を掃除できなかったので通知しない（次の起動でやり直す）`,
          `[auto] Could not clean up ${expired.length} expired entries, so not notifying (will retry on next start)`,
        ),
      )
      return
    }
    for (const entry of expired) {
      console.log(t(`[auto] 停止中に期限切れになっていた session=${entry.id.slice(0, 8)}`, `[auto] Expired while the agent was stopped session=${entry.id.slice(0, 8)}`))
      onExpire?.(entry)
    }
  })
}

/**
 * ★ Checks the state file's structure. Returns **why it is broken** (only a category that is safe to expose) or `undefined`.
 *
 * ⚠️ If this passes, `validEntry` always returns an entry (the same function is used
 *    so that **the check is not written in two places**).
 */
function structureProblem(value: Partial<Stored>): string | undefined {
  if (value.v !== 1) return '知らない版です'
  const entries = value.entries
  if (entries === undefined) return 'entries がありません'
  if (!Array.isArray(entries)) return 'entries が配列ではありません'
  for (const raw of entries) if (!validEntry(raw)) return '札の形が不正です'
  return undefined
}

/** ⚠️ Shape is checked **once at the entrance** (do not force it through with `as` later) */
function validEntry(raw: unknown): Active | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  if (o['scope'] !== 'session') return undefined
  const id = typeof o['id'] === 'string' ? o['id'] : ''
  const until = typeof o['until'] === 'string' ? o['until'] : ''
  const at = typeof o['at'] === 'string' ? o['at'] : ''
  if (!id || !until || !at) return undefined
  // ⚠️⚠️ **Make no entry for an unreadable time** (fail-closed). Past this point we can rely on
  //    `untilMs` being finite (= `NaN` handling does not scatter)
  const untilMs = Date.parse(until)
  const atMs = Date.parse(at)
  if (!Number.isFinite(untilMs) || !Number.isFinite(atMs)) return undefined
  // ★★ **Check the duration cap at load time too** (2026-09-07 codex, high #4).
  //   ⚠️⚠️ The normal path (`setAutoApprove`) never writes beyond `at + AUTO_APPROVE_MAX_MS`, so an
  //      `until` past that exists only in a **hand-edited or broken** file.
  //      Without the check, a "de facto unlimited" entry could be created from outside (= breaking the premise that the expiry balances the risk).
  //   ⚠️ **Shortening** is allowed (for manual checks that rewrite `until` to something near / VERIFY).
  if (untilMs > atMs + AUTO_APPROVE_MAX_MS) return undefined
  return { entry: { scope: 'session', id, until, at }, untilMs }
}

/**
 * ★★ Whether this approval may be auto-passed. **This function is the only place that decides.**
 *
 * ⚠️ Pass the `PermissionRequest` itself (do not allow the caller to recombine
 *    `toolName` and `interaction`).
 */
export function shouldAutoApprove(
  req: Pick<PermissionRequest, 'sessionId' | 'toolName'> & { interaction?: Interaction },
  now = Date.now(),
): boolean {
  // ★ If the state could not be read, it is off (do not fall to the dangerous side). ⚠️ The type keeps us away from entries
  if (state.kind !== 'ok') return false
  // ⚠️⚠️ **Do not pass an approval whose session is unknown.** If `transcript_path` has
  //    an unexpected shape, `sessionId` can be `undefined`. Passing it here would make
  //    the "per session" setting meaningless
  if (!req.sessionId) return false
  // ⚠️⚠️ Stop the ones known by name first (`interaction` disappears on broken input)
  if (requiresInteraction(req.toolName)) return false
  // ★ Stop questions with choices and plan approvals (= not "yes/no")
  if (req.interaction) return false
  const found = state.active.get(req.sessionId)
  if (!found) return false
  return found.untilMs > now
}

/** That session's entry (used for the on-screen mark). ⚠️ `undefined` if expired */
export function autoApproveFor(sessionId: string, now = Date.now()): AutoApproveEntry | undefined {
  if (state.kind !== 'ok') return undefined
  const found = state.active.get(sessionId)
  if (!found) return undefined
  return found.untilMs > now ? found.entry : undefined
}

/** Currently active entries (input for `npm run pending` and `/health`) */
export function autoApproveList(now = Date.now()): AutoApproveEntry[] {
  if (state.kind !== 'ok') return []
  return [...state.active.values()].filter((a) => a.untilMs > now).map((a) => a.entry)
}

/** Whether the state file is broken (to show the reason on screen) */
export function autoApproveBroken(): string | undefined {
  return state.kind === 'broken' ? state.reason : undefined
}

export type SetResult =
  | { ok: true; entry?: AutoApproveEntry }
  | { ok: false; reason: string; saved: boolean }

/**
 * Turn it on or off.
 *
 * ★★ **The order depends on the direction** (both choose "never fall to the dangerous side"):
 *   on  … **save first, then load into memory on success** (do not start passing if saving failed)
 *   off … **drop from memory first, then save** (stop without waiting for a possible save failure)
 * ⚠️⚠️ If saving the "off" fails, **say so** (`saved: false`). The old entry stays in the file,
 *    so restarting the agent **revives it until its expiry** (`until` is absolute, so
 *    it never becomes unlimited). ⇒ The screen shows this as is. Never make it look like success.
 */
export async function setAutoApprove(
  sessionId: string,
  on: boolean,
  now = Date.now(),
  /** ★ Name of the duration (⚠️ the length comes from the table; never take a length from the screen) */
  duration: AutoApproveDuration = AUTO_APPROVE_DEFAULT,
): Promise<SetResult> {
  if (!sessionId) return { ok: false, reason: t('セッションが指定されていません', 'No session was specified.'), saved: false }
  // ★★ **Serialize the whole toggle** (2026-09-07 codex, high #1).
  //
  // ⚠️⚠️ Only saving was serialized, and it broke like this:
  //   (1) on (waiting to save) → (2) off (delete from memory, save) → (3) the rest of "on"
  //   **revives it** with `active.set()` ⇒ **both `ok:true`, file empty, entry in memory**
  //   = the screen says "turned off" yet **it keeps passing** (the worst form).
  //   Also, the set being saved was built from "its own continuation", so turning on two sessions
  //   at once **dropped one from the file** (2 in memory, 1 in the file = changes on restart).
  // ⇒ **Close check, memory update and save into one section** (`await` inside `enqueue` is fine).
  //   ★ This promotes "something the caller must be careful about" to an invariant (ARCHITECTURE §14.1.2.11).
  return await enqueue(async () => {
    // ⚠️ Do not write when broken (keep the evidence). Cannot turn it on either
    if (state.kind !== 'ok') {
      return { ok: false, reason: t(`状態ファイルが壊れています（${state.reason}）`, `The state file is broken (${reasonText(state.reason)}).`), saved: false }
    }
    const active = state.active

    if (!on) {
      const had = active.delete(sessionId)
      clearTimer(sessionId)
      // ★ We are inside the serial section, so writing **the current memory as is** is fine
      const saved = await writeState([...active.values()].map((a) => a.entry))
      if (!saved.ok) return { ok: false, reason: saved.reason, saved: false }
      if (had) console.log(t(`[auto] 自動承認オフ session=${sessionId.slice(0, 8)}`, `[auto] Auto-approve off session=${sessionId.slice(0, 8)}`))
      return { ok: true }
    }

    const untilMs = now + AUTO_APPROVE_DURATIONS[duration]
    const entry: AutoApproveEntry = {
      scope: 'session',
      id: sessionId,
      until: new Date(untilMs).toISOString(),
      at: new Date(now).toISOString(),
    }
    // ★★ Save first (do not start passing if saving failed).
    //   ⚠️ The set is **current memory + this entry** (do not drop other sessions)
    const next = [...active.values()].map((a) => a.entry).filter((e) => e.id !== sessionId)
    const saved = await writeState([...next, entry])
    if (!saved.ok) return { ok: false, reason: saved.reason, saved: false }
    const found: Active = { entry, untilMs }
    active.set(sessionId, found)
    schedule(found, now)
    console.log(t(`[auto] 自動承認オン session=${sessionId.slice(0, 8)} 期限=${entry.until}`, `[auto] Auto-approve on session=${sessionId.slice(0, 8)} until=${entry.until}`))
    return { ok: true, entry }
  })
}

/**
 * ★ The session ended (SessionEnd) ⇒ drop its entry, if any (2026-09-26).
 * ⚠️⚠️ The "is there an entry" check is made **inside** the serial chain (codex): checking before queueing missed an "on" that was
 *    still waiting for its save, which then landed after the session had ended and stayed until expiry.
 * ★ Writes only when there was an entry (SessionEnd comes for every session; most never had auto-approve).
 */
export async function endSessionAutoApprove(sessionId: string): Promise<{ had: boolean } & ({ ok: true } | { ok: false; reason: string })> {
  return await enqueue(async () => {
    if (state.kind !== 'ok' || !state.active.has(sessionId)) return { ok: true, had: false }
    state.active.delete(sessionId)
    clearTimer(sessionId)
    const saved = await writeState([...state.active.values()].map((a) => a.entry))
    return saved.ok ? { ok: true, had: true } : { ok: false, had: true, reason: saved.reason }
  })
}

/**
 * ★★ **Serialize** toggles and cleanup **into one chain**.
 *
 * ⚠️⚠️ **Serializing only the writes is not enough** (see the notes on `setAutoApprove` above).
 *    Put in each **whole section** of "check → update memory → save".
 * ⚠️ Do not call `enqueue` from inside `enqueue` (it waits on itself and hangs).
 */
let chain: Promise<unknown> = Promise.resolve()

function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const run = chain.then(op)
  // ⚠️ A failure does not stop later work (`chain` only carries "order")
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * Write the state file. ⚠️ **Call only inside `enqueue`** (calling it from outside breaks the order).
 */
async function writeState(
  entries: AutoApproveEntry[],
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const stored: Stored = { v: 1, entries }
  try {
    await writeJson(AUTO_APPROVE_FILE, stored)
    return { ok: true }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.warn(t(`[auto] 自動承認の保存に失敗: ${detail}`, `[auto] Failed to save auto-approve state: ${detail}`))
    // ⚠️ Only the category goes out (absolute paths go to the log / CLAUDE.md §2)
    return { ok: false, reason: t('保存に失敗しました', 'Saving failed.') }
  }
}

/**
 * Turn off automatically on expiry.
 *
 * ⚠️ **The timer only handles "announcing"** (same role as `quietUntil`).
 *    Whether it is in effect is always decided by `expiresAt() > now`, so even if the timer
 *    is skipped **it never keeps passing**.
 */
function schedule(found: Active, now: number): void {
  const { entry } = found
  clearTimer(entry.id)
  const ms = found.untilMs - now
  if (ms <= 0) return
  const timer = setTimeout(() => {
    timers.delete(entry.id)
    // ★ Ride the same serial chain as toggles (⚠️ decide inside too = do not remove an entry that was toggled while waiting)
    void enqueue(async () => {
      // ⚠️ Generation check (an old timer right after a toggle must not drop the new entry)
      if (state.kind !== 'ok' || state.active.get(entry.id) !== found) return
      state.active.delete(entry.id)
      await writeState([...state.active.values()].map((a) => a.entry))
      console.log(t(`[auto] 自動承認が期限切れ session=${entry.id.slice(0, 8)}`, `[auto] Auto-approve expired session=${entry.id.slice(0, 8)}`))
      onExpire?.(entry)
    })
  }, ms)
  // ⚠️ Do not keep the process alive (tests would never finish)
  timer.unref?.()
  timers.set(entry.id, timer)
}

function clearTimer(sessionId: string): void {
  const t = timers.get(sessionId)
  if (t) clearTimeout(t)
  timers.delete(sessionId)
}

function clearTimers(): void {
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
}

/** For tests (★ a stateful module, treated the same as `resetPending` in `permission.ts`) */
export function resetAutoApprove(): void {
  clearTimers()
  state = { kind: 'ok', active: new Map() }
  onExpire = undefined
  chain = Promise.resolve()
}
