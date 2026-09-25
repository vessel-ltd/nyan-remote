// Where a subagent's transcript lives (used by the M4-1 cleanup / a CLI internal detail).
//
// ★★ **Without this, "approvals that resolved on their own" can never be found.**
//
// What we learned by measuring on 2026-08-14 (do not overwrite with guesses):
//
//   - The `transcript_path` of the `PermissionRequest` hook is the **main session's
//     transcript**. This holds even for requests coming from a subagent
//     (checked the CLI's hook input schema: **only SubagentStop** has `agent_transcript_path`)
//   - But **a subagent's `tool_use` / `tool_result` do not go into the main transcript**
//     (there was not a single `isSidechain:true` record in the main file).
//     They live at `<projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl`
//     (the CLI 2.1.232 implementation has the same shape: `join(projectDir, sessionId, 'subagents')` +
//      `agent-${agentId}.jsonl`. Only nested subagents add one level in between)
//
// ⇒ As long as `permissionSweep.ts` reads the main transcript, **a subagent's approval can only be
//    judged "still waiting"**. The quieting step's (§9.8.1) "check again after 6 seconds"
//    **was not actually checking** (= it always notified, however fast the auto-approval was).
//
// ⚠️ This is an internal detail, so **if nothing is found, give up silently** (same stance as inbox.ts).
//    Failures lean to the safe side (the card is not removed = a notification simply goes out).

import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** `agent_id` is a hex identifier created by the CLI. **Always check its shape before putting it into a path** */
export function isSafeAgentId(agentId: string): boolean {
  // ★ Allow `@`. Background teammates take the form `code-review@session-xxxx`
  //    (confirmed from `members[].agentId` in `~/.claude*/teams/<session>/config.json` / 2026-08-16).
  // ⚠️ Do not allow `/` or `.` (the value goes into a path, so it must not create separators or a parent directory)
  return /^[A-Za-z0-9_@-]{1,80}$/.test(agentId)
}

/**
 * Location of an ordinary, non-nested subagent (determined by strings alone, so it is testable).
 * `…/projects/<slug>/<sessionId>.jsonl` → `…/projects/<slug>/<sessionId>/subagents/agent-<id>.jsonl`
 */
export function directAgentTranscript(
  mainTranscriptPath: string,
  agentId: string,
): string | undefined {
  if (!mainTranscriptPath.endsWith('.jsonl')) return undefined
  if (!isSafeAgentId(agentId)) return undefined
  const dir = dirname(mainTranscriptPath)
  const sessionId = basename(mainTranscriptPath, '.jsonl')
  if (!sessionId) return undefined
  return join(dir, sessionId, 'subagents', `agent-${agentId}.jsonl`)
}

/** Find that subagent's transcript. undefined if absent (= use the main one) */
export async function resolveAgentTranscript(
  mainTranscriptPath: string | undefined,
  agentId: string | undefined,
): Promise<string | undefined> {
  if (!mainTranscriptPath || !agentId) return undefined
  const direct = directAgentTranscript(mainTranscriptPath, agentId)
  if (!direct) return undefined
  if (await isFile(direct)) return direct

  // Nested subagents (a Task inside a Task) live at `subagents/<something>/agent-<id>.jsonl`.
  // ⚠️ Look only one level down. Digging deeper costs more reading than it gains
  const root = dirname(direct)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const nested = join(root, e.name, `agent-${agentId}.jsonl`)
    if (await isFile(nested)) return nested
  }
  return undefined
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
