// ★★ Usage history, kept on this PC only (2026-11-27 / user decision: "使用量の履歴（A）").
//
// What it answers, per login (a Claude profile, a Codex home, agy — and within one, per account behind it):
//   - how much of each finished **week** window was used (does the plan get used up, or is it paid for and wasted?)
//   - how many times it **stopped at a limit** (制限中), and how many **5-hour** windows were used up.
//
// The rules:
//  1. ⚠️⚠️ **Nothing leaves this PC** except the summary the phone asks for (`GET /usage/history`). Never collected
//     centrally (user decision 2026-11-26).
//  2. ⚠️ **Only numbers and labels are written**: the tool, the profile label (the same one `GET /usage` and the list
//     show), the short account hash (`accountKey`, already a hash), each window's length, use and reset. No e-mail, no
//     organization, no titles, no session ids (a limit stop is kept as a short hash of its id, only to count it once).
//  3. Samples are written **when a login's readings change**, read every `SAMPLE_MS`; limit stops when they happen.
//  4. ★ **A login is (tool, profile, account)**: switching the account behind a profile starts another login, so the
//     old account's weeks and stops are never relabelled with the new one (codex · agy review).
//  5. ★ A window is identified by its reset time **with a tolerance** (`SAME_WINDOW_MS`: readings differ by seconds),
//     and it is **finished only when its own reset time has passed** (never a rounded one / codex · agy review).
//  6. Kept `HISTORY_DAYS` (90, user decision): windows by their reset time, stops by their time — the same rule for the
//     file (pruned once a day) and for memory. A sample line stays while any of its windows is still kept.
//  7. ★ The file is read once at start; afterwards the summary comes from memory (rule 6 trims it).
//  8. ⚠️ A history, not a state file: a line that does not parse is skipped. The file is opened without following a
//     link and must be a regular file (else the history is off and says so); it is kept 0600. A write that fails is
//     tried again with the next reading (nothing is marked seen before it is on disk).
//  9. One agent per state folder (as for every state file): appends and the daily rewrite are one chain.

import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, fchmodSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ToolUsage, UsageHistoryLogin, UsageHistoryResponse } from '../../shared/types.ts'
import { statePath } from './state.ts'

export const HISTORY_FILE = 'usage-history.jsonl'
export const HISTORY_DAYS = 90
export const SAMPLE_MS = 15 * 60_000
const DAY_MS = 24 * 60 * 60_000
const WEEK_MIN = 7 * 24 * 60
const FIVE_HOURS_MIN = 5 * 60
/** Readings of one window can name reset times seconds or minutes apart (rule 5) */
export const SAME_WINDOW_MS = 10 * 60_000
/** How many finished weeks, full 5-hour windows and recent stops the summary carries (a phone screen) */
export const SUMMARY_WEEKS = 13
export const SUMMARY_FIVES = 500
export const SUMMARY_HITS = 10

type Tool = ToolUsage['tool']

interface Sample {
  v: 1
  k: 's'
  at: string
  tool: Tool
  account: string
  key?: string
  /** minutes · used percent (one decimal) · reset (ISO) */
  w: Array<{ m: number; p: number; r: string }>
}

interface Hit {
  v: 1
  k: 'hit'
  at: string
  tool: Tool
  account: string
  key?: string
  /** A short hash of what identifies the stop (a session and its turn): counted once */
  id: string
}

type Line = Sample | Hit

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const TOOLS = new Set<string>(['claude', 'codex', 'agy'])
/** `accountKey` is our own short hash (`usage.ts` `accountKeyOf`): anything else is not kept */
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/

/** One line → a record, or undefined (anything malformed is skipped) */
export function parseLine(text: string): Line | undefined {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isObj(o) || o.v !== 1 || typeof o.at !== 'string' || !Number.isFinite(Date.parse(o.at))) return undefined
  if (typeof o.tool !== 'string' || !TOOLS.has(o.tool) || typeof o.account !== 'string' || o.account === '' || o.account.length > 200) return undefined
  if (o.key !== undefined && (typeof o.key !== 'string' || !KEY_RE.test(o.key))) return undefined
  const key = typeof o.key === 'string' ? { key: o.key } : {}
  if (o.k === 'hit') {
    if (typeof o.id !== 'string' || !KEY_RE.test(o.id)) return undefined
    return { v: 1, k: 'hit', at: o.at, tool: o.tool as Tool, account: o.account, ...key, id: o.id }
  }
  if (o.k !== 's' || !Array.isArray(o.w)) return undefined
  const w: Sample['w'] = []
  for (const x of o.w) {
    if (!isObj(x) || typeof x.m !== 'number' || typeof x.p !== 'number' || typeof x.r !== 'string') return undefined
    if (!Number.isFinite(x.m) || !Number.isFinite(x.p) || !Number.isFinite(Date.parse(x.r))) return undefined
    w.push({ m: x.m, p: x.p, r: x.r })
  }
  return { v: 1, k: 's', at: o.at, tool: o.tool as Tool, account: o.account, ...key, w }
}

export function hitId(raw: string): string {
  return createHash('sha256').update(raw).digest('base64url').slice(0, 16)
}

/** One window as remembered: its latest reset time and the highest use seen */
interface Win {
  r: number
  p: number
  /** When the reading that gave `r` was taken: a later reading decides the reset, whatever the order on disk */
  at: number
}

interface LoginState {
  tool: Tool
  account: string
  key?: string
  weeks: Win[]
  fives: Win[]
  /** Limit stops: id → time (ms) */
  hits: Map<string, number>
  /** The oldest record kept (ms) */
  first: number
}

/** The window of `list` that `r` belongs to (rule 5), or a new one */
function windowOf(list: Win[], r: number): Win {
  const hit = list.find((w) => Math.abs(w.r - r) <= SAME_WINDOW_MS)
  if (hit) return hit
  const w = { r, p: 0, at: -Infinity }
  list.push(w)
  return w
}

const loginId = (tool: Tool, account: string, key: string | undefined): string => `${tool}\u0000${account}\u0000${key ?? ''}`
const profileId = (tool: Tool, account: string): string => `${tool}\u0000${account}`

/**
 * What "changed" means for a sample: whole percents, the reset to the minute (rule 3).
 * ⚠️ Below 100 never rounds up to 100 (99.6% then 100% is a change: the window was used up / agy review)
 */
function signature(w: Sample['w']): string {
  const pct = (p: number): number => (p >= 100 ? 100 : Math.min(99, Math.floor(p)))
  return JSON.stringify(
    w.map((x) => [x.m, pct(x.p), Math.round(Date.parse(x.r) / 60_000)]).sort((a, b) => a[0]! - b[0]! || a[2]! - b[2]!),
  )
}

export interface UsageHistoryDeps {
  path: string
  now(): number
  log?: (line: string) => void
}

export class UsageHistory {
  readonly #deps: UsageHistoryDeps
  #logins = new Map<string, LoginState>()
  /** Per profile: the account seen last and the last sample written (to write only changes) */
  #profiles = new Map<string, { key?: string; sig?: string }>()
  #chain: Promise<unknown> = Promise.resolve()
  /** Set when the file is not ours to touch: nothing is written (rule 8) */
  #blocked = false
  #prunedAt = 0
  /** Lines that could not be written yet (samples and stops): written with the next sample, in order (rule 8) */
  #pending: Line[] = []
  static readonly PENDING_MAX = 1000

  constructor(deps: UsageHistoryDeps) {
    this.#deps = deps
  }

  get path(): string {
    return this.#deps.path
  }

  /** Read the file once (rule 7). A missing file is an empty history. */
  load(): void {
    // ★ A prune cut short (the agent stopped between writing the copy and renaming it) left a copy: removed
    void this.#dropLeftovers()
    let text: string
    try {
      // ⚠️ One descriptor, not through a link, never waiting on a FIFO (rule 8)
      const fd = openSync(this.#deps.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const st = fstatSync(fd)
        if (!st.isFile()) {
          this.#block()
          return
        }
        // ★ 0600 also for a file that is only read (one restored from a backup with wider rights / codex review)
        if ((st.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600)
        text = readFileSync(fd, 'utf8')
      } finally {
        closeSync(fd)
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return
      // ⚠️ A history that could not be read is off until a restart (else it would answer "nothing" and append to a
      //    file it never read: the stops in it would be counted again / codex review)
      this.#block(code === 'ELOOP' ? undefined : `could not be read (${code ?? (err as Error).message})`)
      return
    }
    for (const l of text.split('\n')) {
      const rec = l ? parseLine(l) : undefined
      if (rec) this.#apply(rec)
    }
  }

  async #dropLeftovers(): Promise<void> {
    const dir = dirname(this.#deps.path)
    const base = this.#deps.path.slice(dir.length + 1)
    try {
      for (const name of await readdir(dir)) {
        if (name.startsWith(`${base}.`) && /^[0-9a-f]{12}\.tmp$/.test(name.slice(base.length + 1))) await unlink(`${dir}/${name}`).catch(() => undefined)
      }
    } catch {
      // nothing to clean
    }
  }

  #block(why = 'is not a regular file'): void {
    if (!this.#blocked) this.#deps.log?.(`[usage-history] ${HISTORY_FILE} ${why}; the history is off until the agent restarts`)
    this.#blocked = true
  }

  #login(tool: Tool, account: string, key: string | undefined, at: number): LoginState {
    const id = loginId(tool, account, key)
    let s = this.#logins.get(id)
    if (!s) {
      s = { tool, account, ...(key ? { key } : {}), weeks: [], fives: [], hits: new Map(), first: at }
      this.#logins.set(id, s)
    }
    s.first = Math.min(s.first, at)
    return s
  }

  #apply(rec: Line): void {
    const at = Date.parse(rec.at)
    const s = this.#login(rec.tool, rec.account, rec.key, at)
    if (rec.k === 'hit') {
      s.hits.set(rec.id, at)
      return
    }
    this.#profiles.set(profileId(rec.tool, rec.account), { ...(rec.key ? { key: rec.key } : {}), sig: signature(rec.w) })
    for (const w of rec.w) {
      const list = w.m === WEEK_MIN ? s.weeks : w.m === FIVE_HOURS_MIN ? s.fives : undefined
      if (!list) continue
      const win = windowOf(list, Date.parse(w.r))
      // ⚠️ The newest reading's reset, not the last line's (a retried older line can follow a newer one / codex)
      if (at >= win.at) {
        win.r = Date.parse(w.r)
        win.at = at
      }
      win.p = Math.max(win.p, w.p)
    }
  }

  /**
   * Append lines in order (one writer). Resolves to whether they are on disk. ⚠️ Never throws: a history that cannot be
   * written only logs.
   */
  #write(recs: Line[]): Promise<boolean> {
    if (recs.length === 0) return Promise.resolve(true)
    if (this.#blocked) return Promise.resolve(false)
    const text = recs.map((r) => JSON.stringify(r) + '\n').join('')
    const done = this.#chain.then(async () => {
      try {
        await mkdir(dirname(this.#deps.path), { recursive: true, mode: 0o700 })
        // ⚠️ Not through a link (rule 8); a FIFO is not a regular file and is refused below
        const fh = await open(this.#deps.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
        try {
          const st = await fh.stat()
          if (!st.isFile()) {
            this.#block()
            return false
          }
          if ((st.mode & 0o777) !== 0o600) await fh.chmod(0o600)
          // ★ A line cut by a crash is closed first (else the next record would be glued to it and lost)
          let lead = ''
          if (st.size > 0) {
            const rd = await open(this.#deps.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
            try {
              const b = Buffer.alloc(1)
              await rd.read(b, 0, 1, st.size - 1)
              if (b[0] !== 0x0a) lead = '\n'
            } finally {
              await rd.close()
            }
          }
          await fh.appendFile(lead + text)
          return true
        } finally {
          await fh.close()
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ELOOP') this.#block()
        else this.#deps.log?.(`[usage-history] could not write: ${err instanceof Error ? err.message : String(err)}`)
        return false
      }
    })
    this.#chain = done
    return done
  }

  /** ★ The readings of now (`GET /usage`'s list): a line per login whose readings changed (rule 3) */
  async sample(usage: readonly ToolUsage[]): Promise<void> {
    if (this.#blocked) return
    const nowMs = this.#deps.now()
    const at = new Date(nowMs).toISOString()
    const out: Sample[] = []
    // ⚠️ Two places with the same label (two Codex homes named alike) cannot be told apart: neither is kept (a mixed
    //    history would be worse than none / codex · agy review)
    const count = new Map<string, number>()
    for (const u of usage) count.set(profileId(u.tool, u.account), (count.get(profileId(u.tool, u.account)) ?? 0) + 1)
    for (const u of usage) {
      const pid = profileId(u.tool, u.account)
      if (count.get(pid)! > 1) continue
      const key = u.accountKey !== undefined && KEY_RE.test(u.accountKey) ? u.accountKey : undefined
      const prev = this.#profiles.get(pid)
      // ⚠️ One decimal, never rounded up to 100 (99.96% is not used up / codex review)
      const pct = (p: number): number => (p >= 100 ? Math.round(p * 10) / 10 : Math.min(99.9, Math.floor(p * 10) / 10))
      const w = u.windows
        .filter((x) => Number.isFinite(x.minutes) && Number.isFinite(x.usedPercent) && Number.isFinite(Date.parse(x.resetsAt)))
        .map((x) => ({ m: x.minutes, p: pct(x.usedPercent), r: x.resetsAt }))
      // ★ Who is behind the profile counts even without windows (a stop belongs to the account seen last): an account
      //   change is written as a line of its own, so a restart files the next stop under it too (codex review)
      if (w.length === 0 && (key === undefined || prev?.key === key)) continue
      if (w.length > 0 && prev?.sig === signature(w) && prev.key === key) continue
      const rec: Sample = { v: 1, k: 's', at, tool: u.tool, account: u.account, ...(key ? { key } : {}), w }
      this.#apply(rec)
      out.push(rec)
    }
    const pending = this.#pending
    this.#pending = []
    const ok = await this.#write([...pending, ...out])
    // ⚠️ Not on disk ⇒ kept aside, in order, and written with the next sample (rule 8): a reading taken just before a
    //    reset is not lost to one failed write (codex review)
    if (!ok) this.#keep([...pending, ...out])
    await this.#pruneDaily()
  }

  /**
   * ★ A stop at a plan limit. `raw` identifies the stop (a session and its turn): the same stop is counted once, also
   *   across restarts (only its hash is written). It belongs to the account last seen behind the profile.
   */
  hit(tool: Tool, account: string, raw: string): Promise<boolean> {
    if (this.#blocked) return Promise.resolve(false)
    const nowMs = this.#deps.now()
    const key = this.#profiles.get(profileId(tool, account))?.key
    const id = hitId(`${tool}\u0000${account}\u0000${raw}`)
    // ★ Once per profile, whichever account it was filed under (a replay after a switch is not a second stop)
    for (const l of this.#logins.values()) if (l.tool === tool && l.account === account && l.hits.has(id)) return Promise.resolve(false)
    const rec: Hit = { v: 1, k: 'hit', at: new Date(nowMs).toISOString(), tool, account, ...(key ? { key } : {}), id }
    this.#apply(rec)
    return this.#write([rec]).then((ok) => {
      // ⚠️ Not on disk ⇒ kept aside and written with the next sample (rule 8); it still counts meanwhile
      if (!ok) this.#keep([rec])
      return ok
    })
  }

  #keep(recs: Line[]): void {
    if (this.#blocked) return
    this.#pending = [...recs, ...this.#pending].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-UsageHistory.PENDING_MAX)
  }

  /** What the phone shows (rule 1: numbers only) */
  summary(): UsageHistoryResponse {
    const nowMs = this.#deps.now()
    const cutoff = nowMs - HISTORY_DAYS * DAY_MS
    this.#trim(cutoff)
    const logins: UsageHistoryLogin[] = []
    let since: number | undefined
    for (const s of this.#logins.values()) {
      const weeks = s.weeks.filter((w) => w.r <= nowMs).sort((a, b) => a.r - b.r)
      const fives = s.fives.filter((w) => w.r <= nowMs && w.p >= 100).sort((a, b) => a.r - b.r)
      const hits = [...s.hits.values()].sort((a, b) => a - b)
      if (weeks.length === 0 && fives.length === 0 && hits.length === 0) continue
      since = since === undefined ? s.first : Math.min(since, s.first)
      logins.push({
        tool: s.tool,
        account: s.account,
        ...(s.key ? { accountKey: s.key } : {}),
        weeks: weeks.slice(-SUMMARY_WEEKS).map((w) => ({ resetsAt: new Date(w.r).toISOString(), usedPercent: w.p })),
        fiveHourFull: fives.slice(-SUMMARY_FIVES).map((w) => new Date(w.r).toISOString()),
        limitStops: { count: hits.length, recent: hits.slice(-SUMMARY_HITS).map((t) => new Date(t).toISOString()) },
      })
    }
    return {
      days: HISTORY_DAYS,
      ...(this.#blocked ? { off: true as const } : {}),
      ...(since !== undefined ? { since: new Date(Math.max(since, cutoff)).toISOString() } : {}),
      logins,
    }
  }

  /** Rule 6 in memory: windows by their reset, stops by their time; a login with nothing left goes */
  #trim(cutoff: number): void {
    for (const [id, s] of this.#logins) {
      s.weeks = s.weeks.filter((w) => w.r > cutoff)
      s.fives = s.fives.filter((w) => w.r > cutoff)
      for (const [h, t] of s.hits) if (t <= cutoff) s.hits.delete(h)
      if (s.weeks.length === 0 && s.fives.length === 0 && s.hits.size === 0) this.#logins.delete(id)
      else s.first = Math.max(s.first, cutoff)
    }
  }

  /** Rule 6 on disk, once a day */
  #pruneDaily(): Promise<void> {
    const nowMs = this.#deps.now()
    if (this.#blocked || nowMs - this.#prunedAt < DAY_MS) return Promise.resolve()
    this.#prunedAt = nowMs
    const cutoff = nowMs - HISTORY_DAYS * DAY_MS
    this.#trim(cutoff)
    const done = this.#chain.then(async () => {
      let text: string
      try {
        const rd = await open(this.#deps.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          if (!(await rd.stat()).isFile()) {
            this.#block()
            return
          }
          text = await rd.readFile('utf8')
        } finally {
          await rd.close()
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') return
        if (code === 'ELOOP') return this.#block()
        this.#deps.log?.(`[usage-history] could not prune: ${(err as Error).message}`)
        return
      }
      const lines = text.split('\n').filter((l) => l !== '')
      const keep = lines.filter((l) => {
        const rec = parseLine(l)
        if (!rec) return false
        if (rec.k === 'hit') return Date.parse(rec.at) > cutoff
        return Date.parse(rec.at) > cutoff || rec.w.some((w) => Date.parse(w.r) > cutoff)
      })
      if (keep.length === lines.length) return
      const tmp = `${this.#deps.path}.${randomBytes(6).toString('hex')}.tmp`
      try {
        const fh = await open(tmp, 'wx', 0o600)
        try {
          await fh.writeFile(keep.map((l) => l + '\n').join(''))
          await fh.sync()
        } finally {
          await fh.close()
        }
        await rename(tmp, this.#deps.path)
      } catch (err) {
        await unlink(tmp).catch(() => undefined)
        this.#deps.log?.(`[usage-history] could not prune: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
    this.#chain = done
    return done
  }

  /** (tests) every write so far has finished */
  async settled(): Promise<void> {
    await this.#chain
  }
}

// ── The agent's one history ──────────────────────────────────────────────────────────────────────────────────────

let history: UsageHistory | undefined

/** Start the history (read the file once). Later calls return the same one (a new one if the state folder moved: tests). */
export function usageHistory(): UsageHistory {
  if (!history || history.path !== statePath(HISTORY_FILE)) {
    history = new UsageHistory({ path: statePath(HISTORY_FILE), now: Date.now, log: (l) => console.warn(l) })
    history.load()
  }
  return history
}

/** ★ A stop at a plan limit, from the three places that detect one (Claude hook, Codex notifier, agy notifier) */
export function recordLimitStop(tool: Tool, account: string, raw: string): void {
  try {
    void usageHistory().hit(tool, account, raw)
  } catch (err) {
    console.warn(`[usage-history] ${err instanceof Error ? err.message : String(err)}`)
  }
}
