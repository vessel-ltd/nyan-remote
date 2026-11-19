// ★ A Codex request's identity across replays (teams / `PermissionRequest.origin` / codex review r2 high #3, r3 high #3).
//   No connection generation, no request id (the daemon numbers a replayed request anew): the row and the item.
// ⚠️ Used both where the daemon accepts a request (`daemon.ts`, before a diff is read) and on the card (`cards.ts`):
//    one function, so the two always agree.

import { createHash } from 'node:crypto'

export type OriginKind = 'command' | 'question' | 'file'

export function cardOrigin(req: { threadId: string; turnId: string; itemId: string }, rowSessionId: string, kind: OriginKind): string {
  return `codex:${createHash('sha256').update([kind, rowSessionId, req.threadId, req.turnId, req.itemId].join('\0'), 'utf8').digest('hex').slice(0, 24)}`
}
