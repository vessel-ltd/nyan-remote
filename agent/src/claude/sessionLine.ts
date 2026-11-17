// ★ What a live Claude session's status line was last given: its model, effort and context use (2026-11-17 / the list).
//
// `hooks/statusline.sh` keeps each session's newest status line input as `~/.nyan-remote/usage/session-<id>.json`
// (only on profiles where the relay sits in front of a status line). Only three fields are read here:
//   `model.display_name` ("Opus 5.5"), `effort.level` ("high"), `context_window.used_percentage` (21).
// ⚠️ The file is ours but its contents come from the CLI: the id inside must be the session's, every value is checked,
//    and anything else is left out (never a guess).
// ⚠️ Files of sessions that ended are removed (`sweepSessionLines`), never one of a live session.

import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { stateDir } from '../state.ts'
import { readJsonCached, shownText } from '../usage.ts'

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
/** A file of an ended session older than this is removed */
export const SESSION_LINE_MAX_AGE_MS = 24 * 60 * 60 * 1000

export interface SessionLine {
  model?: string
  effort?: string
  contextPercent?: number
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function sessionLinePath(sessionId: string, dir: string = stateDir()): string {
  return join(dir, 'usage', `session-${sessionId}.json`)
}

/** The three fields, from a status line input that names `sessionId` */
export function sessionLineOf(input: unknown, sessionId: string): SessionLine | undefined {
  if (!isObject(input) || input.session_id !== sessionId) return undefined
  const model = isObject(input.model) ? shownText(input.model.display_name, 48) : undefined
  const level = isObject(input.effort) ? input.effort.level : undefined
  const effort = typeof level === 'string' && /^[a-z]{1,16}$/.test(level) ? level : undefined
  const pct = isObject(input.context_window) ? input.context_window.used_percentage : undefined
  const contextPercent = typeof pct === 'number' && Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : undefined
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(contextPercent === undefined ? {} : { contextPercent }),
  }
}

/** The session's line, if the relay kept one. ⚠️ Never throws (the list must not fail on it) */
export async function readSessionLine(sessionId: string): Promise<SessionLine | undefined> {
  if (!UUID.test(sessionId)) return undefined
  try {
    // ⚠️ Fail-closed: a bad file is nothing, not the last good one (codex review)
    return sessionLineOf((await readJsonCached(sessionLinePath(sessionId), undefined, false))?.value, sessionId)
  } catch {
    return undefined
  }
}

/**
 * Remove the files of sessions that ended a day ago or more (and temp files a write left behind).
 * ⚠️ Never a live session's (`live`: every live session, not the capped list), and only names the relay writes.
 * ⚠️ Residual (accepted): a session resumed in the instant between the age check and the unlink loses its new file;
 *    its next status line render writes it again.
 */
export async function sweepSessionLines(
  live: Set<string>,
  now = Date.now(),
  dir: string = stateDir(),
  /** `Infinity`: no session file is removed (the live set is not known in full); temp files still are */
  maxAgeMs: number = SESSION_LINE_MAX_AGE_MS,
): Promise<number> {
  const usage = join(dir, 'usage')
  let removed = 0
  let names: string[]
  try {
    names = await readdir(usage)
  } catch {
    return 0
  }
  for (const name of names) {
    const m = /^(?:session-([0-9a-fA-F-]{36})\.json|\.session-([0-9a-fA-F-]{36})\.\d+\.\d+\.tmp)$/.exec(name)
    if (!m) continue
    const id = m[1] ?? m[2]!
    // ⚠️ Only a name the relay can write (a UUID), nothing else that merely looks like one (codex review)
    if (!UUID.test(id)) continue
    if (m[1] !== undefined && live.has(id)) continue
    try {
      const st = await stat(join(usage, name))
      if (!st.isFile() || now - st.mtimeMs < (m[1] !== undefined ? maxAgeMs : 60 * 60 * 1000)) continue
      await unlink(join(usage, name))
      removed++
    } catch {
      // Failing to remove is not fatal
    }
  }
  return removed
}
