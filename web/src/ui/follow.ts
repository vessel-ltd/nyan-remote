// Decides only "may the page that arrived be applied" for live follow.
//
// ⚠️⚠️ Why this is a pure function (codex review 2026-08-20, medium #3):
//    Follow requests fire every 3 seconds, so when responses are slow (HTTP limit is 10s) they **overlap**.
//    If an earlier request returns **later**, it rewinds `tail` and **appends the same records twice**.
//    If an old response lands after switching sessions, **another thread's messages get mixed in**.
//    ⇒ Pull the decision out of the view and pin the reordering cases in tests
//      (no extra DOM test environment = no extra dependencies / CLAUDE.md).

/**
 * `ignore` = drop / `advance` = only move tail forward / `append` = append to the end /
 * `reset` = reload from the latest page
 */
export type FollowAction = 'ignore' | 'advance' | 'append' | 'reset'

export function followAction(args: {
  /** Generation at request time (increments when the session or endpoint changes) */
  requestGen: number
  /** Current generation */
  currentGen: number
  /** The tail we currently hold */
  currentTail: number
  /** The response's tail */
  pageTail: number
  /** Number of display entries in the response */
  added: number
}): FollowAction {
  // ★ Drop anything that arrives after switching to another session or endpoint
  if (args.requestGen !== args.currentGen) return 'ignore'
  // ★★ **tail shrank = the file was recreated** (codex review 2026-08-20, high #2).
  //    Follow is serialized, so within one generation responses never arrive out of order.
  //    ⇒ The shrink is real, so **reload from the latest page** (don't keep appending stale content).
  //    ⚠️ However, "same size, different content" **cannot be detected this way**.
  //      Fixing it would need a generation marker on tail (e.g. a hash of the preceding bytes), changing the protocol.
  //      No observed case, so it is recorded in HANDOFF and deferred.
  if (args.pageTail < args.currentTail) return 'reset'
  // Nothing to do if it hasn't advanced
  if (args.pageTail === args.currentTail) return 'ignore'
  // Nothing to display (e.g. file-history-snapshot): just advance the position
  if (args.added === 0) return 'advance'
  return 'append'
}
