// ★ Tell the phone the moment an agy conversation changes state (2026-11-19 / codex review).
//
// The status line relay writes `~/.nyan-remote/agy/session-<id>.json` on every agent state change (at most every
// 300 ms). Without watching it the list waited for the phone's next poll (60 s with a healthy event line), so a short
// turn or an approval wait could start and end unseen.
// ★ Same shape as `claude/sessionWatch.ts`: watch the directory, coalesce bursts, and say "sessions changed" only when
//   some conversation's list status actually changed (context and quota updates alone stay quiet).
// ⚠️ Only "when to re-fetch" changes; the status itself is decided where the rows are built. If watching fails, the
//    list falls back to polling.

import { watch, type FSWatcher } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { agyChildrenOutlived, agyQuestionWaitAt, agyStatus, readAgyFiles } from './sessions.ts'

const DEBOUNCE_MS = 300

/** id → status, for the files that parse (★ a question counts: working → asking is a change the list must show) */
export async function agyStatuses(dir: string, home?: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const f of await readAgyFiles(dir)) {
    const asking = agyQuestionWaitAt(f.state, f.mtimeMs, home) !== undefined
    // ★ A card and a question both read `waiting`: told apart (an approval followed by a question, the `working` in
    //   between not seen, left the thread saying "approval" / codex review)
    // ★ And its own card beside a wait (a subagent's approval, then the parent's card: the same `waiting:question`, the
    //   phone kept the old reason until its next poll / codex review)
    out.set(f.state.conversationId, `${f.state.pid}:${agyStatus(f.state, asking, agyChildrenOutlived(f.state, home))}${asking ? ':question' : ''}${f.state.confirmationPending ? ':card' : ''}`)
  }
  return out
}

function same(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}

/**
 * @param onChange some conversation's list status changed (re-fetch the list)
 * @param onTick after every look, changed or not (approval cards and notifications look themselves: a card's
 *   identity includes the status file's time, which can move without a status change / `cards.ts`)
 */
export async function startAgyWatch(dir: string, onChange: () => void, onTick?: () => void): Promise<{ close(): void }> {
  // ⚠️ The directory is the installer's (0700); made here too so a later `nyan update` finds it watched
  await mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => undefined)
  let last = await agyStatuses(dir)
  let timer: NodeJS.Timeout | undefined
  let running = false
  let again = false
  const check = async (): Promise<void> => {
    if (running) {
      again = true
      return
    }
    running = true
    try {
      do {
        again = false
        const now = await agyStatuses(dir)
        if (!same(now, last)) {
          last = now
          onChange()
        }
        onTick?.()
      } while (again)
    } finally {
      running = false
    }
  }
  // ★ At most one look per 300 ms, never pushed back by more writes (two busy conversations writing in turn kept
  //   resetting a debounce, so nothing was said until both stopped / codex review)
  const w: FSWatcher = watch(dir, () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      void check().catch(() => undefined)
    }, DEBOUNCE_MS)
  })
  w.on('error', () => w.close())
  return {
    close() {
      if (timer) clearTimeout(timer)
      w.close()
    },
  }
}
