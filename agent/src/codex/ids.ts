// ★★ The id of a Codex row (2026-11-15 / docs/CODEX.md §5.3).
//
// A Codex row's `sessionId` is `codex-<16 hex of sha256(home id)>-<thread id>`.
// ⚠️⚠️ Never the bare thread id (codex review, high #1): auto-approve, routing, cards and cleanup are all keyed by the
//    row's `sessionId`, a daemon can list a thread whose id equals a Claude session's, and two homes can list the same
//    thread id. ★ `codex-` cannot begin a Claude session id (36 hex digits and dashes).
// ⚠️ 64 bits of the home, not 32: two crafted home paths collided at 8 hex digits (second review, medium #2). Homes
//    whose prefixes still collide are refused when the lines start (`codexHomes`), never watched under one id.
// No imports on purpose: `autoApprove.ts` and the routes use this too.

const HOME_HEX = 16

export function codexSessionPrefix(homeId: string, hash: (s: string) => string): string {
  return `codex-${hash(homeId).slice(0, HOME_HEX)}-`
}

const CODEX_ID = new RegExp(`^codex-[0-9a-f]{${HOME_HEX}}-.`)

/** Whether `id` has the form of a Codex row id. The form is ours, so this is not a guess. */
export function isCodexSessionId(id: string): boolean {
  return CODEX_ID.test(id)
}

/**
 * The id as journals print it. A Claude id: its first 8 characters, as before. A Codex row id: the whole home part
 * and the first 8 of the thread (8 characters would print `codex-3b` for every thread of a home — second review, low #5).
 */
export function shortSessionId(id: string): string {
  return isCodexSessionId(id) ? id.slice(0, 'codex-'.length + HOME_HEX + 1 + 8) : id.slice(0, 8)
}
