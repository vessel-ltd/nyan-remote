// ★★ Build notification text from "the same inputs as one row of the list" (2026-08-21).
//
// ⚠️ The text itself is `notificationText` in `shared/types.ts`. This file **only gathers the inputs**.
//    Building it in two places means fixing one side makes the list and the notification disagree (hit many times).
//
// ⚠️ **If it cannot be read, give up on the title** (fail-closed). With `titleSource: 'fallback'`,
//    `notificationText` falls back to the 8-char ID and adds the project name on line 3.
//    "ID only" is better than a false title.

import { basename } from 'node:path'
import type { NotifyFields, TitleSource } from '../../shared/types.ts'
import { readTranscriptMeta } from './claude/transcript.ts'
import { findTranscript } from './claude/sessions.ts'
import { discoverConfigDirs } from './claude/configDirs.ts'
import { config } from './config.ts'

/** The part of a notification that does not depend on the session */
export interface NotifyBase {
  machine: string
  account: string
  project: string
  sessionId?: string
  label: string
  /** ⚠️ Fixed vocabulary only (reasons, tool names). Never put conversation-derived strings here (§6.2) */
  qualifier?: string
}

function fallback(base: NotifyBase): NotifyFields {
  return {
    title: '',
    titleSource: 'fallback',
    sessionId: base.sessionId ?? '',
    project: base.project,
    machine: base.machine,
    account: base.account,
    label: base.label,
    ...(base.qualifier ? { qualifier: base.qualifier } : {}),
  }
}

/**
 * ★ Transcript-side inputs needed to build a notification (2026-08-21).
 *
 * ⚠️ `lastActivity` is used to **decide the text** (passed to `resolveStatus`), not for display.
 *    Getting this wrong brings back "the list and the notification disagree".
 */
export interface NotifyMeta {
  title: string
  titleSource: TitleSource
  contextTokens?: number
  /**
   * ★ The project **as the list shows it** (`basename` of the transcript's first cwd = where the session started).
   *   ⚠️ The hook's own cwd follows the session into subfolders, so the notification said `account` for a `nyan-remote` session (2026-09-25)
   */
  project?: string
  /**
   * ISO8601. From the transcript's conversation records, **or mtime if there are none**.
   *
   * ⚠️⚠️ **Decide it in the same order as the list** (`meta.lastActivity ?? mtimeMs` in `sessions.ts`).
   *    2026-08-21 `/code-review` medium #2: mtime was dropped here, so for sessions with no timestamped
   *    record in the last 64KB **the list used mtime and the notification used "now"**,
   *    and the same Stop hook was judged "new" by the list and "old" by the notification,
   *    splitting into **list = done / notification = running** (I had recreated a mismatch I had already fixed).
   */
  lastActivity?: string
}

/** Builds display values from the inputs that could be read. ⚠️ `null` means "could not read" ⇒ falls back to the 8-char ID */
export function fieldsFrom(base: NotifyBase, meta: NotifyMeta | null): NotifyFields {
  if (!meta) return fallback(base)
  return {
    ...fallback(base),
    title: meta.title,
    titleSource: meta.titleSource,
    // ⚠️ omit when unknown (do not show 0 as "ctx 0")
    ...(meta.contextTokens === undefined ? {} : { contextTokens: meta.contextTokens }),
    ...(meta.project ? { project: meta.project } : {}),
  }
}

/** When the transcript path is known (the permission hook has it in its payload) */
export async function readNotifyMetaFromTranscript(path: string): Promise<NotifyMeta | null> {
  try {
    const meta = await readTranscriptMeta(path)
    // ⚠️ decide in **the same order** as the list (`collectSessions`). Dropping it splits the verdict
    const lastActivity = meta.lastActivity ?? new Date(meta.mtimeMs).toISOString()
    return {
      title: meta.title,
      titleSource: meta.titleSource,
      ...(meta.contextTokens === undefined ? {} : { contextTokens: meta.contextTokens }),
      ...(lastActivity ? { lastActivity } : {}),
      // ⚠️ Same rule as the list (`sessions.ts`: `cwd ? basename(cwd) : '—'`)
      ...(meta.cwd ? { project: basename(meta.cwd) } : {}),
    }
  } catch {
    return null
  }
}

export async function notifyFieldsFromTranscript(
  path: string,
  base: NotifyBase,
): Promise<NotifyFields> {
  return fieldsFrom(base, await readNotifyMetaFromTranscript(path))
}

/**
 * When only the sessionId is known (the status hooks).
 *
 * ⚠️ **Search only within that account**. If the same sessionId exists in another account,
 *    do not show someone else's title (same reason as `probeStatus`).
 */
export async function readNotifyMeta(
  account: string,
  sessionId: string | undefined,
): Promise<NotifyMeta | null> {
  if (!sessionId) return null
  try {
    const dirs = await discoverConfigDirs(config().configDirs)
    const mine = dirs.filter((d) => d.account === account)
    if (mine.length === 0) return null
    const found = await findTranscript(mine, sessionId)
    if (!found) return null
    return await readNotifyMetaFromTranscript(found.path)
  } catch {
    return null
  }
}

export async function notifyFieldsBySessionId(base: NotifyBase): Promise<NotifyFields> {
  return fieldsFrom(base, await readNotifyMeta(base.account, base.sessionId))
}
