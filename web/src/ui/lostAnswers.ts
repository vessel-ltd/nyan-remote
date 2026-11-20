// ★ Answers to approval cards that did not go through, or whose outcome is unknown (2026-11-20 / docs/AGY.md §9).
//
// Shown in one fixed bar at the top of the app (`LostAnswers.tsx`), on the list and in every thread, whether the card
// is still there or not (codex review, rounds 39–42: kept inside the cards, the reason vanished with the card, stayed
// in another thread, or sat below the visible part of a long thread while a command the PC had just allowed ran).
// One entry per card; a later answer to that same card that goes through clears it (another card's success does not /
// codex review).

import type { PermissionRequest } from '../../../shared/types.ts'

export interface LostAnswer {
  /** The attempt it came from (`nextAttempt`) */
  attempt: number
  summary: string
  reason: string
  /** The reply never came back (a dropped connection): whether it took effect is unknown */
  unknown?: true
}

const entries = new Map<string, LostAnswer>()
const listeners = new Set<() => void>()
/**
 * card → the newest attempt that went through. ⚠️ Replies can arrive out of order (a failed first try answered after
 * a successful retry of the same card): a failure older than a success of that card is not shown (codex review).
 */
const succeeded = new Map<string, number>()
/** card → the newest attempt whose failure was dismissed (an older reply must not bring the bar back / codex review) */
const dismissed = new Map<string, number>()
let attempts = 0

/** A number for one answer attempt (taken before sending) */
export function nextAttempt(): number {
  return ++attempts
}

const keyOf = (item: Pick<PermissionRequest, 'key'> & { endpointId: string }): string => `${item.endpointId}|${item.key}`

function changed(): void {
  for (const f of listeners) f()
}

export function rememberLost(
  item: Pick<PermissionRequest, 'sessionId' | 'key' | 'summary'> & { endpointId: string },
  reason: string,
  attempt: number,
  unknown?: true,
): void {
  if ((succeeded.get(keyOf(item)) ?? 0) > attempt) return
  if ((dismissed.get(keyOf(item)) ?? 0) > attempt) return
  // ⚠️ Nor over a newer failure of the same card (an older request timing out after a newer refusal / codex review)
  if ((entries.get(keyOf(item))?.attempt ?? 0) > attempt) return
  entries.set(keyOf(item), { attempt, summary: item.summary, reason, ...(unknown ? { unknown } : {}) })
  changed()
}

/** An answer to this card went through (the card came back after a failed key, same key): its failure is no news */
export function clearLost(item: Pick<PermissionRequest, 'key'> & { endpointId: string }, attempt: number): void {
  const k = keyOf(item)
  succeeded.set(k, Math.max(succeeded.get(k) ?? 0, attempt))
  if (succeeded.size > 500) succeeded.delete(succeeded.keys().next().value as string)
  // ⚠️ Only a failure older than this success (an older Allow's reply must not erase a newer Deny's failure)
  const e = entries.get(k)
  if (e && e.attempt < attempt) {
    entries.delete(k)
    changed()
  }
}

export function dismissLost(id: string): void {
  const e = entries.get(id)
  if (!e) return
  dismissed.set(id, Math.max(dismissed.get(id) ?? 0, e.attempt))
  if (dismissed.size > 500) dismissed.delete(dismissed.keys().next().value as string)
  entries.delete(id)
  changed()
}

export function lostAnswers(): [string, LostAnswer][] {
  return [...entries.entries()]
}

export function onLostChange(f: () => void): () => void {
  listeners.add(f)
  return () => {
    listeners.delete(f)
  }
}
