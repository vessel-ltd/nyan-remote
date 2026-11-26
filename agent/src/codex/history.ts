// ★★ Codex turns → entries of the thread view (2026-11-14 / docs/CODEX.md §5).
//
// Source: `thread/turns/list` with `itemsView: 'full'` (works with `experimentalApi: false`; measured on 0.169.0).
// Pure: the daemon's JSON goes in, `LogEntry[]` comes out.
//
// ⚠️⚠️ Hostile input: a turn or item that does not parse is skipped (counted), never thrown on, never half-shown.
// ⚠️⚠️ **An unknown item type is shown as one folded line**, it does not fail the page (Codex adds types; the generated
//    schema of 0.169.0 lists 19 and only four have been seen for real).
// ⚠️ What the history does **not** contain (measured):
//    - a **declined** command leaves no item at all ⇒ the view cannot show "you declined X"
//    - text that is still streaming is not there (only recorded items are) ⇒ no character-by-character follow
// ⚠️ The PWA's thread is append-only (entries are not replaced by id) ⇒ an item is emitted **once, when it is settled**:
//    it has `completedAtMs`, or its turn is over. An unfinished command is held back until then.

import { clipUserText, type LogEntry } from '../../../shared/types.ts'
import { t } from '../../../shared/i18n.ts'

const TEXT_MAX = 20_000
const TOOL_MAX = 4000

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function clip(s: string, max: number): string {
  const t = s.trimEnd()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function foldable(raw: string, max = TOOL_MAX): { summary: string; lines: number; truncated: boolean } {
  const t = raw.replace(/\s+$/, '')
  if (!t) return { summary: '', lines: 0, truncated: false }
  const truncated = t.length > max
  const summary = truncated ? `${t.slice(0, max - 1)}…` : t
  return { summary, lines: summary.split('\n').length, truncated }
}

/** The largest time a JavaScript `Date` can hold, in ms. ⚠️ `isFinite` alone lets `1e100` through to a `RangeError`. */
const MAX_DATE_MS = 8.64e15

/**
 * ★ A time in ms we take as real: finite, not negative, one a `Date` can hold. Anything else is "no time".
 * ⚠️ The one check for both "is the item finished" (`parseTurn`) and its label (`itemEntries`): two checks disagreed and
 *    a finished item was labelled "did not finish" for good (codex review rounds 2–3, low; JSON `1e400` is Infinity).
 */
export function timeMs(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_DATE_MS ? v : undefined
}

function isoFromMs(v: unknown): string | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_DATE_MS ? new Date(v).toISOString() : undefined
}

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress'

export interface CodexItem {
  id: string
  type: string
  /** Has a completion time (⇒ will not change any more, as far as we can tell) */
  completed: boolean
  raw: Record<string, unknown>
}

export interface CodexTurn {
  id: string
  /** `undefined` = a status this version does not know (treated as "not over") */
  status: TurnStatus | undefined
  /** Message of the turn's error, if it failed */
  error?: string
  /** ★ The turn failed because the login hit a plan or spend limit (`isCodexLimitError`; 2026-11-26) */
  limited?: true
  /** Unix seconds */
  completedAt?: number
  items: CodexItem[]
  /** Items of this turn that did not parse */
  skipped: number
}

const TURN_STATUSES = new Set<string>(['completed', 'interrupted', 'failed', 'inProgress'])

/**
 * ★ The `codexErrorInfo` values (app-server schema, codex 0.172.0) that mean "this login cannot work until its limit
 *   resets or money is added" — the Codex side of the list's "rate-limited" (2026-11-26).
 * ⚠️ Not `rateLimitExceeded` (a short throttle the CLI retries; the same call as Claude's "request rejected (429)"),
 *    not `sessionBudgetExceeded` (a budget of that one session, not of the login), not overload or capacity errors.
 * ⚠️ Only the bare string form: the object forms (`httpConnectionFailed: {…}`, …) are connection errors.
 */
export const CODEX_LIMIT_ERRORS: ReadonlySet<string> = new Set([
  'usageLimitExceeded',
  'apiKeySpendLimitExceeded',
  'projectSpendLimitExceeded',
  'organizationSpendLimitExceeded',
])

export function isCodexLimitError(info: unknown): boolean {
  return typeof info === 'string' && CODEX_LIMIT_ERRORS.has(info)
}

export function parseTurn(raw: unknown): CodexTurn | undefined {
  if (!isObject(raw) || typeof raw.id !== 'string' || raw.id === '' || !Array.isArray(raw.items)) return undefined
  const items: CodexItem[] = []
  let skipped = 0
  for (const it of raw.items) {
    if (!isObject(it) || typeof it.id !== 'string' || it.id === '' || typeof it.type !== 'string') {
      skipped++
      continue
    }
    items.push({ id: it.id, type: it.type, completed: timeMs(it.completedAtMs) !== undefined, raw: it })
  }
  const status = typeof raw.status === 'string' && TURN_STATUSES.has(raw.status) ? (raw.status as TurnStatus) : undefined
  const err = raw.error
  return {
    id: raw.id,
    status,
    ...(isObject(err) && typeof err.message === 'string' && err.message !== '' ? { error: clip(err.message, 500) } : {}),
    // ⚠️ Only a failed turn: an interrupted one can carry an error too, and it is not a stop at a limit
    ...(status === 'failed' && isObject(err) && isCodexLimitError(err.codexErrorInfo) ? { limited: true as const } : {}),
    // ⚠️ Only a time a `Date` can hold (the journal turns it into an ISO string)
    ...(typeof raw.completedAt === 'number' && Number.isFinite(raw.completedAt) && Math.abs(raw.completedAt * 1000) <= MAX_DATE_MS
      ? { completedAt: raw.completedAt }
      : {}),
    items,
    skipped,
  }
}

/** One page of `thread/turns/list`. ⚠️ `nextCursor` is opaque: passed back verbatim, never parsed. */
export interface TurnsPage {
  turns: CodexTurn[]
  nextCursor: string | null
  skipped: number
}

export function parseTurnsPage(result: unknown): TurnsPage | undefined {
  if (!isObject(result) || !Array.isArray(result.data)) return undefined
  const turns: CodexTurn[] = []
  let skipped = 0
  for (const raw of result.data) {
    const t = parseTurn(raw)
    if (t) {
      turns.push(t)
      skipped += t.skipped
    } else skipped++
  }
  const next = result.nextCursor
  return { turns, nextCursor: typeof next === 'string' && next !== '' ? next : null, skipped }
}

/** ★ A user message's text as the thread shows it (also used to say what a send from the phone will look like) */
export function userText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const c of content) {
    if (!isObject(c)) continue
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text)
    // ⚠️ Not only text: images, mentions, skills… Say that something was there instead of dropping it silently.
    else if (typeof c.type === 'string') parts.push(`[${c.type}]`)
  }
  return parts.join('\n')
}

function stringList(v: unknown): string {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').join('\n') : ''
}

/**
 * One item → entries.
 * ⚠️ `tool_use` / `tool_result` carry the item id so the view pairs them (same contract as the Claude side).
 */
export function itemEntries(item: CodexItem): LogEntry[] {
  const r = item.raw
  const at = isoFromMs(r.startedAtMs)
  const withAt = at ? { at } : {}
  switch (item.type) {
    case 'userMessage': {
      const user = clipUserText(userText(r.content), TEXT_MAX)
      return user.text ? [{ kind: 'user', ...withAt, ...user }] : []
    }
    case 'agentMessage': {
      const text = typeof r.text === 'string' ? clip(r.text, TEXT_MAX) : ''
      return text ? [{ kind: 'assistant', ...withAt, text }] : []
    }
    case 'plan': {
      const text = typeof r.text === 'string' ? clip(r.text, TEXT_MAX) : ''
      return text ? [{ kind: 'assistant', ...withAt, text }] : []
    }
    case 'reasoning': {
      // ★ Only the summary (the model's own short account). Empty for most turns ⇒ no empty "thinking" rows.
      const text = clip(stringList(r.summary), TEXT_MAX)
      return text ? [{ kind: 'thinking', ...withAt, text }] : []
    }
    case 'contextCompaction': {
      // ★ The item holds no text (only its id and times / measured 0.169.0), so one folded line that says it happened,
      //   with how long it took when it finished (the TUI says "Context compacted · 13s").
      // ⚠️ Shown only once it completed or its turn is over (`journal` holds unfinished items back): an unfinished one
      //    belongs to a turn that was interrupted, and that turn's end line says so.
      const started = timeMs(r.startedAtMs)
      const ended = timeMs(r.completedAtMs)
      const secs = started !== undefined && ended !== undefined && ended >= started ? Math.max(1, Math.round((ended - started) / 1000)) : undefined
      const label = !item.completed || ended === undefined
        ? t('会話の圧縮（終わっていません）', 'Conversation compaction (did not finish)')
        : secs === undefined
          ? t('会話を圧縮しました', 'Conversation compacted')
          : t(`会話を圧縮しました（${secs}秒）`, `Conversation compacted (${secs}s)`)
      return [{ kind: 'meta', ...withAt, label, summary: '', lines: 0, truncated: false }]
    }
    case 'commandExecution': {
      const command = typeof r.command === 'string' ? r.command : ''
      const out: LogEntry[] = [{ kind: 'tool_use', ...withAt, name: 'command', id: item.id, ...foldable(command) }]
      const status = typeof r.status === 'string' ? r.status : ''
      // ⚠️ A result is shown only for a command that finished. `ok` is decided by the exit code the daemon reports,
      //    not by the text on a screen (a declined command renders as "Ran …" in the TUI; docs/CODEX.md).
      if (status !== '' && status !== 'inProgress') {
        const output = typeof r.aggregatedOutput === 'string' ? r.aggregatedOutput : ''
        const exit = typeof r.exitCode === 'number' ? r.exitCode : undefined
        const doneAt = isoFromMs(r.completedAtMs)
        const body = output.trim() !== '' ? output : exit === undefined ? `(${status})` : `(exit ${exit})`
        out.push({
          kind: 'tool_result',
          ...(doneAt ? { at: doneAt } : {}),
          ok: status === 'completed' && exit === 0,
          forId: item.id,
          ...foldable(body),
        })
      }
      return out
    }
    default: {
      // ★ Everything else (fileChange, mcpToolCall, webSearch, … and types that do not exist yet): one folded line
      //   naming the type, with the one field most likely to say what it was. Never the whole object.
      const hint =
        (typeof r.tool === 'string' && r.tool) ||
        (typeof r.query === 'string' && r.query) ||
        (typeof r.path === 'string' && r.path) ||
        (typeof r.text === 'string' && r.text) ||
        ''
      return [{ kind: 'tool_use', ...withAt, name: item.type, id: item.id, ...foldable(String(hint), 500) }]
    }
  }
}

/** The line that closes a turn which did not end normally. `undefined` for a normal end (nothing to add). */
export function turnEndEntry(turn: CodexTurn): LogEntry | undefined {
  const at = turn.completedAt ? { at: new Date(turn.completedAt * 1000).toISOString() } : {}
  if (turn.status === 'failed') return { kind: 'system', ...at, text: turn.error ? `Turn failed: ${turn.error}` : 'Turn failed' }
  if (turn.status === 'interrupted') return { kind: 'system', ...at, text: 'Turn interrupted' }
  return undefined
}

/** Whole turns → entries, old to new (for reading older pages, where every turn is over or shown as it is). */
export function turnsToEntries(turnsOldToNew: readonly CodexTurn[]): LogEntry[] {
  const out: LogEntry[] = []
  for (const t of turnsOldToNew) {
    for (const item of t.items) out.push(...itemEntries(item))
    const end = turnEndEntry(t)
    if (end) out.push(end)
  }
  return out
}

/** Entries kept per thread. Beyond this the oldest are dropped (and "older" stops joining up). */
export const JOURNAL_MAX = 6000

/** Room for this many positions per journal; epochs are multiples of it so journals never overlap. */
export const EPOCH_STEP = 1_000_000

/** A fresh epoch from the clock (seconds). ⚠️ seconds × 1e6 stays below 2^53 until the year 2255; 1e7 would not. */
export function newEpoch(nowMs: number): number {
  return Math.floor(nowMs / 1000) * EPOCH_STEP
}

/**
 * The entries of one thread, each with a stable numeric **position**, so that both "what came after N" (follow) and
 * "what came before N" (scrolling up) have a stable answer for an append-only view.
 *
 * ★ Positions live in `[epoch, epoch + EPOCH_STEP)`. The first entry starts in the middle of that range, so newer
 *   entries get larger positions and older turns that are read later get smaller ones.
 * ★ The epoch is fixed when the journal is created ⇒ a position from another journal (the agent restarted, or the
 *   line was rebuilt) is recognised and never mistaken for a position in this one.
 */
export class ThreadJournal {
  readonly epoch: number
  #entries: LogEntry[] = []
  /** Position of `#entries[0]` */
  #front: number
  #trimmed = false
  #seen = new Set<string>()
  /** Turns whose shown ending is "interrupted" (a failure may still correct it) */
  #interrupted = new Set<string>()
  /** Every turn this journal has taken in (shown or still waiting), to tell whether a newer page joins up */
  #turns = new Set<string>()

  /** `epoch` must be a multiple of `EPOCH_STEP` (see `newEpoch`) */
  constructor(epoch: number) {
    this.epoch = epoch
    this.#front = epoch + EPOCH_STEP / 2
  }

  /** Position just past the last entry */
  get tail(): number {
    return this.#front + this.#entries.length
  }

  /** Position of the oldest entry held */
  get front(): number {
    return this.#front
  }

  get length(): number {
    return this.#entries.length
  }

  /** Whether entries were dropped from the front (⇒ an "older turns" cursor no longer joins up with what we hold) */
  get trimmed(): boolean {
    return this.#trimmed
  }

  #owns(position: number): boolean {
    return Number.isInteger(position) && position >= this.epoch && position < this.epoch + EPOCH_STEP
  }

  /** New, settled entries of these turns (old → new). ⚠️ Stops at the first unsettled item of a turn. */
  #collect(turnsOldToNew: readonly CodexTurn[]): LogEntry[] {
    const out: LogEntry[] = []
    for (const t of turnsOldToNew) {
      this.#turns.add(t.id)
      const over = t.status !== undefined && t.status !== 'inProgress'
      let blocked = false
      for (const item of t.items) {
        const key = `i:${item.id}`
        if (this.#seen.has(key)) continue
        if (!over && !item.completed) {
          blocked = true
          break
        }
        this.#seen.add(key)
        out.push(...itemEntries(item))
      }
      if (over && !blocked) {
        const key = `e:${t.id}`
        if (!this.#seen.has(key)) {
          this.#seen.add(key)
          const end = turnEndEntry(t)
          if (end) out.push(end)
          if (t.status === 'interrupted') this.#interrupted.add(t.id)
        } else if (t.status === 'failed' && this.#interrupted.delete(t.id)) {
          // ★ A correction (third review, medium #4): a failing turn reads as "interrupted" for a moment (measured,
          //   ~0.5 s), and that ending was already shown. The failure is added after it, so the thread says what the
          //   notification says. ⚠️ Only interrupted → failed: an ending is never taken back or changed twice.
          const end = turnEndEntry(t)
          if (end) out.push(end)
        }
      }
    }
    return out
  }

  /**
   * Take the newest turns (old → new) and append what is new **and settled**.
   * ⚠️ Later items of a turn wait behind an unsettled one, so the order shown is the order recorded.
   */
  ingest(turnsOldToNew: readonly CodexTurn[]): number {
    const fresh = this.#collect(turnsOldToNew)
    this.#entries.push(...fresh)
    const extra = this.#entries.length - JOURNAL_MAX
    if (extra > 0) {
      this.#entries.splice(0, extra)
      this.#front += extra
      this.#trimmed = true
    }
    return fresh.length
  }

  /**
   * Put **older** turns (old → new) in front of what is held.
   * ⚠️ Refused (returns -1) once the journal is full or was trimmed: the caller then stops offering "older".
   */
  prepend(turnsOldToNew: readonly CodexTurn[]): number {
    if (this.#trimmed) return -1
    const older = this.#collect(turnsOldToNew)
    if (this.#entries.length + older.length > JOURNAL_MAX) return -1
    this.#entries.unshift(...older)
    this.#front -= older.length
    return older.length
  }

  /** Whether this turn was taken in before (by `ingest` or `prepend`) */
  knows(turnId: string): boolean {
    return this.#turns.has(turnId)
  }

  /** Everything held, old to new */
  all(): LogEntry[] {
    return [...this.#entries]
  }

  /** The newest `limit` entries, and the position of the first of them */
  latest(limit: number): { entries: LogEntry[]; from: number } {
    const start = Math.max(0, this.#entries.length - limit)
    return { entries: this.#entries.slice(start), from: this.#front + start }
  }

  /**
   * Up to `limit` entries just before `position`.
   * ⚠️ `undefined` = that position is not from this journal.
   */
  before(position: number, limit: number): { entries: LogEntry[]; from: number } | undefined {
    if (!this.#owns(position) || position > this.tail) return undefined
    const end = Math.max(0, position - this.#front)
    const start = Math.max(0, end - limit)
    return { entries: this.#entries.slice(start, end), from: this.#front + start }
  }

  /**
   * Entries after `position`.
   * ⚠️ `undefined` = that position is not from this journal (another epoch, or beyond the end): the caller must not
   *    guess what the reader already has. Returning "everything" for an old journal's position would show the whole
   *    thread a second time.
   */
  since(position: number): LogEntry[] | undefined {
    if (!this.#owns(position) || position > this.tail) return undefined
    // A position older than what we still hold: everything we have is "after" it
    return this.#entries.slice(Math.max(0, position - this.#front))
  }

  /** Position of the entry `index` places after `position` (for a catch-up cut to fit one frame) */
  after(position: number, index: number): number {
    return this.#front + Math.max(0, position - this.#front) + index
  }
}
