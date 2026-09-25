// ★★★ Keeps the list's "state per endpoint" in sync with the endpoint list (2026-09-24 / hit in practice on an iPhone).
//
// ⚠️⚠️ State was built only from **the endpoints at startup** => an endpoint added by pairing was fetched, but
//    `patch` discarded the result as an "unknown endpoint", so **it did not appear in the list until the app was reopened**.
//    Removed endpoints also kept their row until reopening.
// => Whenever endpoints change, add, remove and replace contents (relay entry, etc.). Keep results already fetched.

export interface HasEndpoint<E extends { id: string }> {
  endpoint: E
}

export function syncEndpointStates<E extends { id: string }, S extends HasEndpoint<E>>(
  prev: Readonly<Record<string, S>>,
  endpoints: readonly E[],
  make: (e: E) => S,
): Record<string, S> {
  const next: Record<string, S> = {}
  let changed = Object.keys(prev).length !== endpoints.length
  for (const e of endpoints) {
    const cur = prev[e.id]
    if (!cur) {
      next[e.id] = make(e)
      changed = true
    } else if (cur.endpoint !== e) {
      // ★ same endpoint, changed contents (learned the relay entry, etc.) => replace it, keeping fetched results
      next[e.id] = { ...cur, endpoint: e }
      changed = true
    } else {
      next[e.id] = cur
    }
  }
  // ⚠️ if nothing changed, **return the same object** (avoid an extra render)
  return changed ? next : (prev as Record<string, S>)
}

/**
 * ★ Syncs signal subscriptions to the current endpoints (subscribe to added ones, drop removed ones).
 * ⚠️ If the `Transport` for the same endpoint was recreated (contents changed), drop the old subscription and resubscribe.
 * @returns the endpoints newly subscribed
 */
export function syncSubscriptions<T extends { endpoint: { id: string } }>(
  subs: Map<string, { t: T; off: () => void }>,
  transports: readonly T[],
  subscribe: (t: T) => () => void,
): string[] {
  const added: string[] = []
  for (const [id, s] of subs) {
    if (!transports.includes(s.t)) {
      s.off()
      subs.delete(id)
    }
  }
  for (const t of transports) {
    if (!subs.has(t.endpoint.id)) {
      subs.set(t.endpoint.id, { t, off: subscribe(t) })
      added.push(t.endpoint.id)
    }
  }
  // ★ return what was subscribed (the caller fetches immediately = no waiting for a signal or the next fallback poll)
  return added
}
