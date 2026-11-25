// ★★ Subagents waiting on an approval only the PC can answer (agy 1.5.16+ / docs/AGY.md §19, case 8).
//
// agy writes no record of a subagent's approval wait (its transcript shows nothing / measured 1.5.16): the only sign is
// the parent's list under the input box, "● Agent(self: …) · <model>  Blocked · Bash · <time>". Before this, such a
// wait showed "working" on the phone, rang nothing, and the leader was not told: a silent stop.
// ⇒ Each look reads the screen of every agy whose children run (through its relay), and notes whether its list shows a
//   child blocked on anything but a question (questions have their own cards / `cards.ts`). The rows then read
//   "needs you" (`agyQuestionWaitAt` → `agyBlockedAt`), which rings and tells a team's leader (`teamHooks.ts`).
// ⚠️ Only the parent's view shows the list: on a child's view, a dialog, a menu, or an unreadable screen the last
//    reading stays (the person at the PC is looking at it then). The children's end forgets it.
// ★ Counted, not named (a name is cut short at another width): one more blocked is a new wait, rung and told to a
//   leader; one fewer leaves the others' starts (`sessions.ts` `noteAgyBlocked`).
// ⚠️ This only tells. Nothing here types into agy.

import { aliveProcStartSync } from '../claude/sessionIndex.ts'
import { inChildView, listAgy, parseDialog, readAgyScreen, readSubagentEntries, viewOwnerOf } from './screen.ts'
import { agyBlockedWaits, agyLocksOf, agyPaneOf, agyPidFiles, defaultAgyDeps, forgetAgyBlockedExcept, noteAgyBlocked, readAgyPidFile, withLocksProbed, type AgyDeps } from './sessions.ts'

/** The list's word for a question (`ask_question`): not an approval */
const QUESTION = 'AskQuestion'

/** The children a list shows waiting on an approval (blocked on anything but a question), by name */
export function approvalWaits(rows: readonly { name: string; blockedOn?: string }[]): string[] {
  return rows.filter((r) => r.blockedOn !== undefined && r.blockedOn !== QUESTION).map((r) => r.name)
}

let running = false

/**
 * One look over the agys (each agy look, `index.ts`). Returns whether some conversation's reading changed (re-fetch the
 * list). Never throws.
 */
export async function scanAgyBlocked(
  given: AgyDeps = { ...defaultAgyDeps(), aliveProcStart: aliveProcStartSync },
  readScreen: (socketPath: string) => Promise<string | undefined> = readAgyScreen,
): Promise<boolean> {
  if (running) return false
  running = true
  let changed = false
  try {
    const deps = await withLocksProbed(given)
    const locksOf = deps.locksOf ?? ((p: number) => agyLocksOf(p, deps.home))
    const keep = new Set<string>()
    for (const pid of agyPidFiles(deps.dir)) {
      if (!deps.isAgy(pid)) continue
      const f = readAgyPidFile(deps.dir, pid)
      if (!f || !f.state.subagentsActive) continue
      const conv = f.state.conversationId
      // ⚠️ Only the agy that holds the conversation (a second agy on it is not the one the phone shows). One that moved
      //    off it (`/new` keeps the old id in its file until the first prompt / agy review) forgets it; a lock that
      //    cannot be probed keeps it
      const locks = locksOf(pid)
      if (locks !== undefined && !locks.includes(conv)) continue
      // (kept while its children run, read or not)
      keep.add(conv)
      if (locks === undefined || !listAgy(f.state.version)) continue
      const pane = await agyPaneOf(pid, deps.aliveProcStart ?? aliveProcStartSync)
      if (typeof pane === 'string' || !pane.screen || f.mtimeMs < pane.startedAt) continue
      const screen = await readScreen(pane.socketPath)
      if (screen === undefined || inChildView(screen) || viewOwnerOf(screen) !== 'parent' || parseDialog(screen) !== undefined) continue
      // ★ Wrapped rows joined (codex review: one long sibling row kept a wait up, or hid a new one). ⚠️ No list where it
      //   belongs (a menu, a dialog, the parent's own card in its place) keeps the last reading (agy · codex review: a
      //   hidden list read as "none" rang the same wait again when it came back)
      const rows = readSubagentEntries(screen)
      if (rows === undefined) continue
      const seen = approvalWaits(rows).length
      const cut = rows.filter((r) => r.cut).length
      // ⚠️ A row cut short (a narrow terminal) may be waiting or not: between what the whole rows show and that plus the
      //    cut ones (codex · agy review: a cut row read as running cleared a wait; one cut row hid a sibling's new wait;
      //    a count kept above what could still wait hid the next ones)
      //    ✅ Accepted: a wait ended while a cut sibling runs on stays "needs you" until that row is read whole; and while
      //       a row is cut, a new wait that keeps the count is not rung again (the row already says "needs you")
      const known = agyBlockedWaits(f.state).length
      const count = Math.max(seen, Math.min(known, seen + cut))
      if (noteAgyBlocked(conv, pid, count, Date.now())) changed = true
    }
    if (forgetAgyBlockedExcept(keep)) changed = true
  } catch {
    // the next look tries again
  } finally {
    running = false
  }
  return changed
}
