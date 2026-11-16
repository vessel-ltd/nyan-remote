// ★★ Codex file-change approvals (`item/fileChange/requestApproval`, apply_patch) as a yes / no card with the diff
//    (2026-11-16 / docs/CODEX.md §5.6).
//
// Measured on codex-cli 0.169.0 (Read Only, "use apply_patch to write hello.txt"):
//   - The request has **no diff**: `{threadId, turnId, itemId:"exec-…", startedAtMs, reason:null, grantRoot:null}`.
//   - `thread/turns/list` (`itemsView:'full'`) does not show the pending item.
//   - ★ `thread/resume {threadId, excludeTurns:false}` does: its `thread.turns` carries the running turn's snapshot,
//     with `{type:'fileChange', id:<the request's itemId>, changes:[{path, kind:{type:'add'}, diff:'hi\n'}], status:
//     'inProgress'}`. The reply came before the replayed request (4 KB / 9 ms on a new thread).
//   - ⚠️ The daemon answered that call with `deprecationNotice` ("Full-history hydration is deprecated for paginated
//     threads"). A later version may drop it ⇒ **no diff found = no card** (the PC answers, as before).
//   - "No" in the TUI interrupted the turn ⇒ our "no" is `cancel` (same as a command's "no").
//
// The rules:
//  1. ⚠️⚠️ **No diff, no card.** A yes on a change the person has not seen is not an approval.
//  2. ⚠️ **The reply carries the whole conversation and the whole pending diff**, and a connection drops a message over
//     16 MB (`wsUds.ts`). ⇒ The join is made **on a connection of its own** (`daemon.ts` `sideResume`), so an oversized
//     reply never drops the line and its other cards (codex review, round 5: deleting a large file puts its content in
//     the diff, so a short rollout does not bound the reply). The rollout is still checked first
//     (`MAX_ROLLOUT_BYTES`) so a long conversation is not read at all.
//  3. ⚠️ The full-history join is asked **once per request** for the line (a reconnect does not ask again): the
//     call replays the waiting request, and asking on every replay would loop.
//  4. ⚠️ `grantRoot` (a write grant for a whole directory, beyond this one patch) is left to the PC.

import type { RpcId, ServerRequest } from './rpc.ts'

export const FILE_CHANGE_METHOD = 'item/fileChange/requestApproval'

/** ★ The rollout above this is not joined with its full history (rule 2: well under the 16 MB message limit) */
export const MAX_ROLLOUT_BYTES = 4 * 1024 * 1024

export interface FileChange {
  path: string
  kind: 'add' | 'delete' | 'update'
  /** `update` that also moves the file */
  movePath?: string
  diff: string
}

/** A file-change approval as it arrives (no diff yet) */
export interface FileChangeRequest {
  requestId: RpcId
  threadId: string
  turnId: string
  itemId: string
  reason?: string
}

/** …with the diff found for it */
export interface CodexFileChange extends FileChangeRequest {
  changes: FileChange[]
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** Read a server request as a file-change approval. `undefined` = not ours (left to the PC). */
export function parseFileChangeRequest(req: ServerRequest): FileChangeRequest | undefined {
  if (req.method !== FILE_CHANGE_METHOD || !isObject(req.params)) return undefined
  const p = req.params
  const threadId = text(p.threadId)
  const turnId = text(p.turnId)
  const itemId = text(p.itemId)
  if (!threadId || !turnId || !itemId) return undefined
  // ⚠️ Rule 4
  if (p.grantRoot !== undefined && p.grantRoot !== null) return undefined
  if (p.reason !== undefined && p.reason !== null && typeof p.reason !== 'string') return undefined
  const reason = text(p.reason)
  return { requestId: req.id, threadId, turnId, itemId, ...(reason ? { reason } : {}) }
}

function parseChange(raw: unknown): FileChange | undefined {
  if (!isObject(raw) || !isObject(raw.kind)) return undefined
  const path = text(raw.path)
  if (!path || typeof raw.diff !== 'string') return undefined
  const type = raw.kind.type
  if (type !== 'add' && type !== 'delete' && type !== 'update') return undefined
  const move = raw.kind.move_path ?? raw.kind.movePath
  if (move !== undefined && move !== null && (type !== 'update' || !text(move))) return undefined
  return { path, kind: type, ...(typeof move === 'string' ? { movePath: move } : {}), diff: raw.diff }
}

/**
 * Find the pending change in a `thread/resume` reply: the `fileChange` item of **this** turn with **this** id.
 * ⚠️ Another program's output: anything off ⇒ `undefined` (no card), never a partial list.
 */
export function findChanges(reply: unknown, turnId: string, itemId: string): FileChange[] | undefined {
  const thread = isObject(reply) ? reply.thread : undefined
  const turns = isObject(thread) ? thread.turns : undefined
  if (!Array.isArray(turns)) return undefined
  const turn = turns.find((t) => isObject(t) && t.id === turnId)
  if (!isObject(turn) || !Array.isArray(turn.items)) return undefined
  const found = turn.items.filter((i) => isObject(i) && i.id === itemId)
  // ⚠️ Exactly one, and it is a file change
  if (found.length !== 1) return undefined
  const item = found[0] as Record<string, unknown>
  if (item.type !== 'fileChange' || !Array.isArray(item.changes) || item.changes.length === 0) return undefined
  const changes: FileChange[] = []
  for (const c of item.changes) {
    const parsed = parseChange(c)
    if (!parsed) return undefined
    changes.push(parsed)
  }
  return changes
}

/** ★ The mark in front of every line of a file's content: a header never starts with it (codex review, high) */
export const BODY_MARK = '│ '

/**
 * ★ The card's text: one block per file, as the PC shows them. Checked whole for hidden characters (`hiddenIn`).
 *
 * ⚠️⚠️ **Unambiguous** (codex review 2026-11-16, high): a file's content can contain any text, so a block that is
 *    printed plainly can imitate another header — adding `/safe.txt` with the content `delete: /important.txt` read
 *    exactly like a real delete. ⇒ Headers name the path quoted (JSON: a newline or a quote in a name is escaped),
 *    and **every content line starts with `BODY_MARK`**; nothing else does.
 * ⚠️ The end of an added file without a final newline is said (`hello` and `hello\n` are different files).
 */
export function patchText(fc: CodexFileChange): string {
  const blocks = fc.changes.map((c) => {
    const path = JSON.stringify(c.path)
    const head = c.kind === 'update' && c.movePath ? `update ${path} → ${JSON.stringify(c.movePath)}` : `${c.kind} ${path}`
    if (c.diff.length === 0) return head
    const ends = c.diff.endsWith('\n')
    const lines = (ends ? c.diff.slice(0, -1) : c.diff).split('\n').map((l) => BODY_MARK + l)
    if (c.kind === 'add' && !ends) lines.push('\\ No newline at end of file')
    return [head, ...lines].join('\n')
  })
  // ★ The files first (the folded line shows the start); the reason, when there is one, last and quoted
  return blocks.join('\n\n') + (fc.reason ? `\n\nreason: ${JSON.stringify(fc.reason)}` : '')
}
