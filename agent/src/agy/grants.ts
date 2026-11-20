// ★★ Which agy an auto-approve grant was given to (2026-11-20 / docs/AGY.md §10).
//
// The grant itself is the shared auto-approve entry (`autoApprove.ts`: per session, persisted, with its expiry). For agy
// the consent is for the agy process that showed the conversation when it was turned on: its pid and when its relay
// registered (`AgyPane.startedAt`; a reused pid has another). The agent types `1` only into that process.
//
// ⚠️⚠️ Memory only. An agent restart forgets every owner, so every agy grant read back from the file is ended on the
//    first look (codex review: a grant kept by conversation id followed the conversation into an agy resumed while the
//    agent was away, or into another relay). Turning it on again from the phone sets a new owner.
// ⚠️ Each owner is a fresh object: whoever compares it later (`===`) can tell a grant given again meanwhile.

import { autoApproveFor, endSessionAutoApprove } from '../autoApprove.ts'
import { AGY_PREFIX, agyOwnerShows, conversationOf, type AgyDeps } from './sessions.ts'

export interface AgyGrantOwner {
  pid: number
  /** When the agy's relay registered (epoch ms) */
  startedAt: number
}

const owners = new Map<string, AgyGrantOwner>()

/** Set before the grant is saved (a look in between finds the owner, never a grant without one it could type for) */
export function setAgyGrantOwner(conversationId: string, owner: AgyGrantOwner): AgyGrantOwner {
  const fresh = { pid: owner.pid, startedAt: owner.startedAt }
  owners.set(conversationId.toLowerCase(), fresh)
  return fresh
}

export function agyGrantOwner(conversationId: string): AgyGrantOwner | undefined {
  return owners.get(conversationId.toLowerCase())
}

/** Forget this owner (only if it is still the current one) */
export function dropAgyGrantOwner(conversationId: string, owner: AgyGrantOwner | undefined): void {
  const id = conversationId.toLowerCase()
  if (owners.get(id) === owner) owners.delete(id)
}

export function resetAgyGrantOwners(): void {
  owners.clear()
}

/**
 * ★ End the agy grants whose owner no longer shows the conversation (it exited, moved to another conversation, or the
 * agent restarted and forgot it). Called on every look while some agy grant is on. Returns the ended ones' ids.
 * ⚠️ Only that very grant is ended: not one given again meanwhile (another owner) nor one that expired meanwhile (its
 *    expiry notice still goes) — codex review: a sweep's old picture revoked a grant the phone had just turned on.
 */
export async function endAgyGrantsOver(
  /** ⚠️ Listed before the locks were probed (a grant turned on after the probe is judged by the next sweep / codex review) */
  entries: readonly { id: string; at: string }[],
  deps: AgyDeps,
  warn: (line: string) => void = () => undefined,
): Promise<string[]> {
  const ended: string[] = []
  for (const e of entries) {
    const conv = conversationOf(e.id)
    if (conv === undefined) continue
    const owner = agyGrantOwner(conv)
    const shows = owner === undefined ? false : await agyOwnerShows(owner, conv, deps)
    if (shows !== false) continue
    if (agyGrantOwner(conv) !== owner || autoApproveFor(e.id)?.at !== e.at) continue
    const r = await endSessionAutoApprove(e.id)
    dropAgyGrantOwner(conv, owner)
    if (r.had) ended.push(e.id)
    if (!r.ok) warn(`[auto] ⚠️ could not save the end of auto-approve for an agy conversation no longer open (${r.reason})`)
  }
  return ended
}
