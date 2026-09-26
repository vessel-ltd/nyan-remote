// List of agent endpoints.
//
// ★ CLAUDE.md discipline 1: don't assume "there's an agent on our own origin".
//    Our own origin is merely "the first candidate by coincidence".
//      - In X (the agent serves the PWA), own origin = agent
//      - In Y (served from a public origin), there's no agent on our own origin
//      - In the symmetric mesh, one PWA talks to agents on several machines (ARCHITECTURE.md §7)
//
// M0 keeps it in localStorage. From M2 on it moves to IndexedDB (to live alongside read state etc.).

import { isRelayBase } from '../../shared/relayFrame.ts'

export interface AgentEndpoint {
  id: string
  /** Base URL without trailing slash (★ used by the `local` route) */
  url: string
  label: string
  /**
   * ★ Material for connecting via relay (step 6-④ of ③ / the QR's `r` and `a`).
   *
   * ⚠️ Without it, `local` only (as before). ⚠️ **Learned at pairing time**
   *    (for peers reachable only via relay, `/health` can't be fetched first = it's received out of band).
   */
  relay?: { url: string; agentPublicKey: string }
  /**
   * ★ The route to use now (§14.1.1). ⚠️ `local` if absent.
   *
   * ⚠️⚠️ **Even if it says `relay`, fall back to `local` when the material is missing** (`endpointRoute`).
   */
  kind?: 'local' | 'relay'
}

/**
 * ★ **Which route to use for this endpoint**. **The decision lives only here**.
 *
 * ⚠️⚠️ fail-closed: even with `kind: 'relay'`, `local` if the material (entrance and public key) is missing
 *    (= don't pick an unreachable route and "die silently").
 */
export function endpointRoute(e: AgentEndpoint): 'local' | 'relay' {
  return e.kind === 'relay' && e.relay !== undefined ? 'relay' : 'local'
}

/**
 * ★★ **Whether the material for that route is present** (2026-09-21 / counterpart of `endpointRoute`).
 *
 * ⚠️⚠️ **`endpointRoute` was fail-closed only on the `relay` side.** With no equivalent check on the `local` side,
 *    even for **peers paired relay-only** (machines without Tailscale = no `u` in the QR = empty `url`)
 *    the screen offered "switch route to local", and pressing it created **a dead row trying to connect to an empty URL**.
 *    ⇒ This violated CLAUDE.md's "**don't pick an unreachable route and 'die silently'**".
 * ★ That's why the decision lives **only here** (don't write `e.relay ? …` back into `.tsx` =
 *   that returns to a one-sided guard. "If the same decision is needed in two places, make it a function").
 */
export function hasRoute(e: AgentEndpoint, kind: 'local' | 'relay'): boolean {
  return kind === 'relay' ? e.relay !== undefined : e.url !== ''
}

/**
 * ★ Whether the route can be switched = **only when the material for both is present**.
 *
 * ⚠️ With only one, switching is meaningless (`endpointRoute` would just fall back to that route).
 */
export function canSwitchRoute(e: AgentEndpoint): boolean {
  return hasRoute(e, 'local') && hasRoute(e, 'relay')
}

/**
 * ★★ **Switch the route. ⚠️⚠️ Never switch to a route without material** (2026-09-21).
 *
 * ★ Why "not showing it on screen" isn't enough: that's **a convention, not an invariant**
 *   (CLAUDE.md / "please call it the moment you grab it" is a convention, not an invariant).
 *   Indeed, a mutation reverting the `.tsx` condition from `canSwitchRoute(e)` to `e.relay`
 *   **couldn't be killed by tests** (`.tsx` has no behavioral tests).
 *   ⇒ **There's one place that can break the state**, so refuse there. Pressing does **nothing** (no dead rows).
 * ⚠️ Don't silently switch to another route (don't reinterpret the user's choice = return as-is).
 */
export function setRouteIn(
  list: readonly AgentEndpoint[],
  id: string,
  kind: 'local' | 'relay',
): readonly AgentEndpoint[] {
  return list.map((e) => (e.id === id && hasRoute(e, kind) ? { ...e, kind } : e))
}

/**
 * ★★ **The one machine added by pairing** (2026-09-18 / codex round 8, medium #2).
 *
 * ⚠️⚠️ **Not in `.tsx`.** It used to be in `main.tsx`, so **there were no behavioral tests**, and
 *    the mistake of "guessing the route from whether `url` is empty" **went unseen**
 *    (registered via relay, but if `u` was present local was chosen, which no longer connects now that CORS auto-allow is gone).
 *
 * Three rules:
 * 1. ★ **Save the route that registration went through, as-is** (⚠️ no guessing).
 *    ⚠️ But don't write it if the material (`relay`) is missing (aligned with `endpointRoute`'s fail-closed).
 * 2. ⚠️⚠️ **Identity is by "key"** (relay-only peers have an empty `url`, so
 *    comparing by `url` **silently drops the second machine**).
 * 3. ⚠️ If it already exists, **do nothing** (don't rewrite the list = don't clobber existing settings).
 */
export function upsertEndpoint(
  list: readonly AgentEndpoint[],
  e: {
    url: string
    label: string
    relay?: { url: string; agentPublicKey: string }
    /** ★ The route registration went through (⚠️ falls back to `local` if absent) */
    kind?: 'local' | 'relay'
  },
): AgentEndpoint[] | undefined {
  const id = e.url || (e.relay ? `relay:${e.relay.agentPublicKey}` : '')
  // ⚠️ Don't add what can't be named (empty URL and no relay material = no way to connect)
  if (!id) return undefined
  const at = list.findIndex((x) => x.id === id || (e.url !== '' && x.url === e.url))
  // ★★ A registration confirmed over local also **switches an existing relay endpoint back to local** (2026-09-25 / codex):
  //   after turning a PC's relay off for Tailscale, re-scanning its QR used to keep `kind: 'relay'` ⇒ it kept dialling the dead relay.
  const route = e.kind === 'relay' && e.relay ? ({ kind: 'relay' } as const) : e.kind === 'local' ? ({ kind: 'local' } as const) : {}
  if (at < 0) {
    return [...list, { id, url: e.url, label: e.label, ...(e.relay ? { relay: e.relay } : {}), ...route }]
  }
  // ★★ **Also apply the verified material and route to an existing peer** (2026-09-19 / codex round 9, medium #3).
  //   ⚠️⚠️ It used to "do nothing if present", so **even after registration succeeded via relay,
  //      that endpoint got neither the material nor the route** (the screen said "remembered" — a lie).
  //   ⚠️ **`label` isn't overwritten** (don't clobber a name the user gave).
  //   ⚠️ `undefined` if nothing changes (= don't save again).
  const cur = list[at]!
  const next: AgentEndpoint = { ...cur, ...(e.relay ? { relay: e.relay } : {}), ...route }
  const same =
    cur.kind === next.kind &&
    cur.relay?.url === next.relay?.url &&
    cur.relay?.agentPublicKey === next.relay?.agentPublicKey
  if (same) return undefined
  return list.map((x, i) => (i === at ? next : x))
}

/**
 * ★ Teach relay material to just one endpoint (⚠️ **don't touch other endpoints**).
 *
 * ⚠️ Learning it doesn't change the route (`kind` stays = still `local` at home).
 */
export function rememberRelay(
  list: readonly AgentEndpoint[],
  at: number,
  relay: { url: string; agentPublicKey: string },
): AgentEndpoint[] {
  return list.map((e, i) => (i === at ? { ...e, relay } : e))
}

/**
 * ★ Mix **only relay entrances learned later** into the list being edited (2026-09-15 / codex round 4, medium #9).
 *
 * ⚠️⚠️ Pairing while the endpoints screen is open means the screen holds **an old list**, so
 *    saving it as-is **overwrites and erases the learned entrance** (= can no longer switch to relay).
 * ⚠️ Only `relay` is mixed in (other edits belong to the human). ⚠️ **Never removes** (only adds).
 */
export function mergeRelay(
  editing: readonly AgentEndpoint[],
  fresh: readonly AgentEndpoint[],
): AgentEndpoint[] {
  return editing.map((e) => {
    if (e.relay) return e
    const found = fresh.find((x) => x.id === e.id)
    return found?.relay ? { ...e, relay: found.relay } : e
  })
}

/**
 * ★★ Take **route and relay entry-point changes made by pairing** into the list being edited (2026-09-25 / codex).
 *   ⚠️⚠️ Re-pairing over local saves `kind: 'local'`, but the open screen kept `relay`, and pressing Save **restored the dead relay**.
 *   ⚠️ Only rows whose route **changed in the parent since last seen** (a route the user switched on this screen is left alone otherwise).
 */
export function mergeRoute(
  editing: readonly AgentEndpoint[],
  prevFresh: readonly AgentEndpoint[],
  fresh: readonly AgentEndpoint[],
): AgentEndpoint[] {
  return editing.map((e) => {
    const now = fresh.find((x) => x.id === e.id)
    const before = prevFresh.find((x) => x.id === e.id)
    if (!now || !before) return e
    // ★ The relay entry point too (codex round 3: moved to a self-hosted relay, then Save restored our relay's URL)
    const relayChanged = now.relay?.url !== before.relay?.url || now.relay?.agentPublicKey !== before.relay?.agentPublicKey
    const kindChanged = now.kind !== before.kind
    if (!relayChanged && !kindChanged) return e
    let out: AgentEndpoint = relayChanged && now.relay ? { ...e, relay: now.relay } : e
    if (kindChanged) {
      const { kind: _drop, ...rest } = out
      out = now.kind === undefined ? rest : { ...rest, kind: now.kind }
    }
    return out
  })
}

/**
 * ★★ Also add endpoints **newly added** to the parent list to the list being edited (codex round 15, medium #4).
 *
 * ⚠️⚠️ It used to be only `mergeRelay`, so a machine added by scanning a QR on this screen
 *    **didn't appear in the list until reopening** (registering from zero stayed at "0 endpoints").
 * ⚠️⚠️ Add only those "**absent from the previously seen parent list**". Present in the parent but absent in editing
 *    means **the user removed it** (unlinked), so don't bring it back (that would revive an unlinked machine).
 * @returns `editing` itself if unchanged (⚠️ doesn't trigger a redraw)
 */
export function mergeAdded(
  editing: readonly AgentEndpoint[],
  prevFresh: readonly AgentEndpoint[],
  fresh: readonly AgentEndpoint[],
): readonly AgentEndpoint[] {
  const before = new Set(prevFresh.map((e) => e.id))
  const have = new Set(editing.map((e) => e.id))
  const added = fresh.filter((e) => !before.has(e.id) && !have.has(e.id))
  return added.length === 0 ? editing : [...editing, ...added]
}

/**
 * ★★ **Old endpoints of the same machine whose key was recreated** (2026-09-24 / no key backups = pave the way back).
 *
 * Relay-only endpoints have id `relay:<agent public key>`, so when a machine loses and recreates its key,
 * rescanning the QR **adds it as a separate row, leaving the old one as "no response"**.
 * ⇒ Return as candidates those with **the same relay entrance and name but a different key** from the registered peer (the screen asks "remove?").
 * ⚠️⚠️ **Never removed automatically**: another machine with the same name may exist (both `MacBook-Pro`, etc.).
 * ⚠️⚠️ **Only rows known to be "no response"** (codex round 18, medium #4): if another same-named machine **is connected now**,
 *    it isn't an old row. Checking / unchecked aren't shown either (fail-closed = removable by a normal "unlink").
 * ⚠️ If the user renamed it, it isn't picked up (errs on the side of missing it).
 */
export function staleTwins(
  list: readonly AgentEndpoint[],
  paired: { machine: string; relayUrl: string; agentPublicKey: string },
  probe: (e: AgentEndpoint) => 'ok' | 'ng' | 'offline' | 'checking' | undefined,
): AgentEndpoint[] {
  return list.filter(
    (e) =>
      e.relay !== undefined &&
      e.relay.url === paired.relayUrl &&
      e.label === paired.machine &&
      e.relay.agentPublicKey !== paired.agentPublicKey &&
      // ⚠️ `offline` too: an old key's relay room has no agent, so its probe is "unreachable" since 2026-09-26
      (probe(e) === 'ng' || probe(e) === 'offline'),
  )
}

/** ⚠️ Don't trust what's stored (broken localStorage, old shapes, hand-written data) */
function sanitize(raw: unknown): AgentEndpoint[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const out: AgentEndpoint[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return undefined
    const e = item as Record<string, unknown>
    if (typeof e['id'] !== 'string' || typeof e['url'] !== 'string' || typeof e['label'] !== 'string') {
      return undefined
    }
    const kept: AgentEndpoint = { id: e['id'], url: e['url'], label: e['label'] }
    const relay = e['relay']
    if (typeof relay === 'object' && relay !== null) {
      const r = relay as Record<string, unknown>
      // ⚠️ The entrance shape uses the check in `shared/relayFrame.ts` (same one for config, QR and screen)
      if (isRelayBase(r['url']) && typeof r['agentPublicKey'] === 'string' && r['agentPublicKey']) {
        kept.relay = { url: r['url'], agentPublicKey: r['agentPublicKey'] }
      }
    }
    // ⚠️ Unknown values fall back to `local` (fail-closed)
    if (e['kind'] === 'relay') kept.kind = 'relay'
    out.push(kept)
  }
  return out
}

const KEY = 'tmux-agent.endpoints.v1'

/**
 * ★ The shape used when our own origin becomes an endpoint (⚠️ **id is the URL**, aligned with `addEndpoint` =
 *    the same agent doesn't get two rows).
 */
export function selfCandidate(): AgentEndpoint {
  const url = location.origin
  return { id: url, url, label: location.hostname }
}

/**
 * ★★ Whether our own origin may be added as a candidate (2026-09-16 / to move to Y).
 *
 * ⚠️⚠️ It used to **list one unconditionally** (assuming "an agent on our own origin" = discipline 1 violation).
 *    Served from a public origin there's no agent, so **a "❌ no response" row always appeared**.
 * ★ But removing it would **lose the first machine in X (the agent serves the PWA)**, so
 *    **add it after checking** (= only when `/health` answered).
 * ⚠️ **Don't add while still unknown (`undefined`)** (fail-closed).
 * ⚠️ Don't add if endpoints already exist (**don't revive a row a human removed**).
 */
export function shouldOfferSelf(
  list: readonly AgentEndpoint[],
  probe: { readonly ok: boolean } | undefined,
): boolean {
  return list.length === 0 && probe?.ok === true
}

/**
 * ★★ Whether to offer "enter a URL directly" (2026-09-21 / feedback from real use).
 *
 * ⚠️⚠️ **On the public origin (Y), anything added there never works**:
 *   ① only a URL can be typed, so it becomes a `local` endpoint
 *     (**the relay entrance and agent public key only come from the QR**)
 *   ② **CORS auto-allow for the public origin was removed on 2026-09-18**, so the agent doesn't answer over HTTP
 *   ⇒ pressing it **only adds a row that always shows "❌ no response"** = we were making users create
 *     the "broken-looking rows" discipline 1 forbids themselves.
 *
 * ★ But **removing it entirely is wrong**: **in X (the agent itself serves the PWA / tailnet origin) it's
 *   still valid** (CORS passes automatically for https origins in the same tailnet). §14.3 decided
 *   "always keep both X and Y".
 *
 * ⇒ The decision uses the same material as `shouldOfferSelf` (**is there an agent on our own origin**).
 * ⚠️ **Not shown while still unknown (`undefined`)** (fail-closed).
 */
export function shouldOfferManualUrl(probe: { readonly ok: boolean } | undefined): boolean {
  return probe?.ok === true
}

export function loadEndpoints(): AgentEndpoint[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const parsed = sanitize(JSON.parse(raw))
      if (parsed) return parsed
    }
  } catch {
    // If broken, fall back to the default
  }
  // ⚠️⚠️ **Don't add our own origin by default** (added after checking with `shouldOfferSelf` / see above)
  return []
}

export function saveEndpoints(list: AgentEndpoint[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    // Not fatal if it fails in private mode etc.
  }
}
