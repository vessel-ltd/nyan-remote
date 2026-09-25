// Clears the cards of "approvals no longer needed" (cleanup after M4-1).
//
// ⚠️⚠️ **Approving on the PC does not cut the hook's connection** (measured 2026-08-13).
//   What I had written until then — "answering on the PC kills the hook = the card disappears" — was **wrong**.
//   What was actually seen:
//
//     card:     at=07:52:47Z (an approval answered on the PC)   ← still there
//     session:  working / last activity=07:56:31Z              ← 4 minutes ahead
//
//   `timeout` is 24 hours, so left alone **an already-answered card stays on the phone for 24 hours**.
//   A button that does nothing when pressed is about as bad as an approval that never arrives.
//
// ★ What to judge by (easy to get wrong, so the reasons are recorded):
//
//   ❌ **"The session's last activity is newer than the approval" cannot decide it.**
//      Claude calls tools **in parallel** within one turn. While an auto-approved Read writes its result,
//      another Bash waiting for approval is perfectly normal. Clearing on that basis
//      **throws away a waiting approval**, back to the bug fixed today.
//
//   ✅ Check **whether that tool's `tool_result` was written to the transcript**.
//      Results are **only written after execution**, so if present, "it already ran" is certain.
//      Results are written for both allow and deny, so either way it is cleared.
//
//   How to match: `tool_use` carries the same arguments as the payload, so look for **the block whose
//   fingerprint (permission.ts `fingerprint`) matches**, take its `id`, then look for the `tool_result`
//   with that id. `tool_use_id` is not in the payload, hence this order.
//
// ⚠️ If nothing is found, **do nothing**. Keeping it is safer than wrongly clearing it (a leftover can just be pressed).
//
// ★★ **Reading the wrong file makes this whole check useless** (2026-08-14).
//   Even for requests from a sub-agent, `transcript_path` points to **the main** transcript, but
//   the sub-agent's `tool_use` / `tool_result` **are not written there**.
//   → Where they live is decided by `claude/subagentTranscript.ts`.

import { t } from '../../shared/i18n.ts'
import { open } from 'node:fs/promises'
import { clearPermission } from './claude/hookState.ts'
import { resolveAgentTranscript } from './claude/subagentTranscript.ts'
import { broadcast } from './events.ts'
import { abandon, fingerprint, hasPendingForSession, pendingWithMeta } from './permission.ts'

/**
 * Read only the tail. Transcripts can be up to 14MB, so never read the whole thing (CLAUDE.md).
 *
 * ⚠️ If a single `tool_result` record exceeds this size, the matching `tool_use` is also
 *    out of range and cannot be judged "executed" (= the card stays until `Stop` / external review finding).
 *    The failure direction is safe (it does not clear too much), so the limit is only raised.
 */
const TAIL_BYTES = 1024 * 1024

/**
 * ⚠️ **No tolerance** (found to be a hole in the 2026-08-13 external review).
 *
 * It used to be `resultAt >= askedAt - 5000` on the grounds that "hook times and transcript writes
 * drift by a few seconds", but that was a hole that
 * **threw away a new approval using the result of the same command that finished 2 seconds earlier**.
 * Results are always written after execution, so anything not satisfying `resultAt >= askedAt`
 * is "the result of an earlier run". Compare strictly.
 */

type Rec = Record<string, unknown>

/**
 * Runs one cleanup pass.
 * @returns number of cards discarded
 */
export async function sweepResolved(): Promise<number> {
  const items = pendingWithMeta().filter((p) => p.meta?.transcriptPath)
  if (items.length === 0) return 0

  // do not read the same transcript repeatedly (approvals in the same turn are in the same file)
  const byFile = new Map<string, typeof items>()
  for (const item of items) {
    // ★★ if it comes from a sub-agent, look at **that sub-agent's file**.
    //    The main transcript does not contain the sub-agent's tool_use / tool_result, so
    //    getting this wrong means **automatically resolved approvals are never found**
    //    (see the notes in subagentTranscript.ts; found by measuring on 2026-08-14).
    //    If not found, look at the main one (as before; lean toward not clearing too much)
    const file =
      (await resolveAgentTranscript(item.meta!.transcriptPath, item.meta?.agentId)) ??
      item.meta!.transcriptPath!
    const list = byFile.get(file) ?? []
    list.push(item)
    byFile.set(file, list)
  }

  let dropped = 0
  for (const [file, list] of byFile) {
    let records: Rec[]
    try {
      records = await readTailRecords(file)
    } catch {
      continue // gone or unreadable ⇒ do not touch
    }
    const done = executedAt(records)
    for (const item of list) {
      const fp = fingerprint(item.info.toolName, item.meta?.toolInput)
      // ★ whether **the latest tool_use** with that fingerprint has a result. null means unresolved, so do not touch
      const resultAt = done.get(fp)
      if (resultAt === undefined || resultAt === null) continue
      // ★★ only consider "results returned after the approval was requested".
      //
      // ⚠️ without this, **when the same command runs twice, the second is discarded immediately**.
      //    Running `npm test` twice in one turn is routine, so never judge by fingerprint alone.
      // ⚠️⚠️ **never give the tolerance a negative direction** (2026-08-13 external review finding).
      //    It used to be `resultAt >= askedAt - 5000`, so **a new approval could be discarded using the result
      //    of the same command that finished 2 seconds earlier**. Compare strictly here.
      const askedAt = Date.parse(item.info.at)
      if (!Number.isFinite(askedAt)) continue // time unreadable ⇒ do not touch
      if (resultAt < askedAt) continue
      if (abandon(item.info.key)) {
        dropped++
        console.log(
          t(
            `[perm] 済みの承認を片付けた key=${item.info.key.slice(0, 12)}… tool=${item.info.toolName}`,
            `[perm] Cleared an already-answered approval key=${item.info.key.slice(0, 12)}… tool=${item.info.toolName}`,
          ),
        )
        // ★ also reset the list label. `Notification/permission` does not tell us
        //   "it has been answered", so "needs attention" would remain until that tool finishes
        //   (see the notes on clearPermission in hookState.ts).
        // ⚠️ **do not clear if the session still has waiting cards** (when only one of parallel approvals
        //    is answered, that would hide the remaining approval).
        // ⚠️⚠️ **count the quietly waiting ones too** (2026-08-14 review, medium).
        //    `listPending()` hides waits from sub-agents, so judging by it
        //    **clears "needs attention" although an approval is really waiting, making it look like work in progress**.
        clearLabelIfSettled(item.info.sessionId)
      }
    }
  }
  if (dropped > 0) {
    broadcast({ type: 'permissions-changed', machine: '', at: new Date().toISOString() })
  }
  return dropped
}

/**
 * ★★ When an approval is settled, also clear the basis for the "needs attention" label. **The clearing side must always call this.**
 *
 * ⚠️ Forgetting it does real harm (seen on a real device on 2026-08-14):
 *    press approve on the phone → the card disappears → **but the state stays `waiting` for a few seconds** →
 *    the thread says "waiting for approval on the PC screen; it cannot be answered from the phone".
 *    **Right after you answered it on the phone, it shows up as a lie.**
 *
 * ⚠️ **Do not clear if the session still has waiting cards** (when only one of parallel approvals is answered,
 *    that would hide the remaining approval).
 * ⚠️⚠️ **Count the quietly waiting ones too** (use `hasPendingForSession`. `listPending()` hides
 *    waits from sub-agents, so judging by it clears approvals that are really waiting).
 */
export function clearLabelIfSettled(sessionId: string | undefined): boolean {
  if (!sessionId) return false
  if (hasPendingForSession(sessionId)) return false
  return clearPermission(sessionId)
}

/** Reads the tail of the transcript into records */
async function readTailRecords(file: string): Promise<Rec[]> {
  const fh = await open(file, 'r')
  try {
    const { size } = await fh.stat()
    const from = Math.max(0, size - TAIL_BYTES)
    const len = size - from
    if (len <= 0) return []
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, from)
    const lines = buf.toString('utf8').split('\n')
    // reading from the middle, so the first line may be broken
    if (from > 0) lines.shift()
    const out: Rec[] = []
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const rec = JSON.parse(line)
        if (rec && typeof rec === 'object') out.push(rec as Rec)
      } catch {
        // a line still being written. Discard it
      }
    }
    return out
  } finally {
    await fh.close()
  }
}

/**
 * For each fingerprint, returns "the time the result of **the latest `tool_use`** came back".
 * `null` if there is no result yet (= running, or about to be approved).
 *
 * ⚠️⚠️ **Never judge by "some tool_use with that fingerprint has a result"**
 *   (2026-08-13 external review finding). Running `npm test` twice in one turn is routine, and
 *   the first result would **immediately discard the second approval**.
 *   → Only check **whether the latest `tool_use` has a result**. If the latest is unresolved, it is
 *     the one waiting for approval now, so it must never be discarded.
 *
 * ⚠️ The time is returned too. The caller uses it to confirm "the result came after the approval request".
 */
export function executedAt(records: Rec[]): Map<string, number | null> {
  /** fingerprint → id of the last tool_use seen with that fingerprint (the file is chronological, so last wins) */
  const latestUseByFp = new Map<string, string>()
  const resultTimeById = new Map<string, number>()

  for (const rec of records) {
    const message = rec['message']
    if (!message || typeof message !== 'object') continue
    const content = (message as Rec)['content']
    if (!Array.isArray(content)) continue
    const at = typeof rec['timestamp'] === 'string' ? Date.parse(rec['timestamp']) : Number.NaN
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const b = block as Rec
      if (b['type'] === 'tool_use' && typeof b['id'] === 'string') {
        const name = typeof b['name'] === 'string' ? b['name'] : undefined
        latestUseByFp.set(fingerprint(name, b['input']), b['id'])
      } else if (b['type'] === 'tool_result' && typeof b['tool_use_id'] === 'string') {
        // a result with an unreadable time is unusable (the premise is separating by time)
        if (Number.isFinite(at)) resultTimeById.set(b['tool_use_id'], at)
      }
    }
  }

  const done = new Map<string, number | null>()
  for (const [fp, id] of latestUseByFp) {
    done.set(fp, resultTimeById.get(id) ?? null)
  }
  return done
}
