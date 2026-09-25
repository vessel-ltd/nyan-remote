// ★★ Splitting notification subscriptions **per agent** (2026-09-21 / HANDOFF 5.0-bt).
//
// ★ Based on measurement: **a subscription is not "one per device" but "one per Service Worker registration (scope)"**,
//   bound to one VAPID key. ⇒ With a scope per agent, it can subscribe with **that agent's own key**
//   (confirmed on both Android/Chrome and iOS 18.7).
//
// ⚠️⚠️ What this removes is **manual work in the main use case**: previously every agent needed the same `vapid.json`,
//   and each second machine meant **copying the private key by hand** (forget it and notifications silently stop).
//
// ★ Only **decisions** live here (`.tsx` has no behavioural tests / discipline).

/** One endpoint. ⚠️ No subscription is created for one whose `publicKey` cannot be obtained (it is down) */
export interface AgentPush {
  /** The endpoint id (= URL). ★ Input for the scope. Must be stable per machine */
  readonly id: string
  readonly publicKey: string | undefined
  /**
   * ★★ **Whether that agent holds "the subscription for this scope"** (built with `registeredFor`).
   *
   * ⚠️⚠️ Without this, when **`subscribe()` succeeded but `registerPush()` failed**
   *    it never resends (the browser has the subscription, so it is judged "no longer needed").
   *    ⇒ It did **the opposite** of the comment that said "picked up next time" (codex round 12, high #2).
   * ⚠️⚠️ **Do not build it from "does this device have any subscription" (`subscribed`)** (codex round 13, high #3).
   *    A leftover old endpoint made it true, missed the failed registration of the new one, and **deleted the old subscription too**.
   * ⚠️ `undefined` when unknown (down, or an old agent that returns no tags).
   */
  readonly registered: boolean | undefined
}

/** One subscription currently in the browser */
export interface ExistingSub {
  readonly scope: string
  readonly publicKey: string | undefined
}

export interface PushPlan {
  /** Those for which an SW will be registered and a subscription created */
  readonly subscribe: readonly { id: string; scope: string; publicKey: string }[]
  /**
   * ★ The subscription exists but **has not reached the agent** (just resend / high #2).
   * ⚠️ Do not recreate (a changed endpoint would break other routes that were working).
   */
  readonly reregister: readonly { id: string; scope: string }[]
  /** ⚠️ Subscriptions no longer needed (endpoint removed, key changed, old root subscription) */
  readonly drop: readonly string[]
}

/**
 * ★★ The scope path. **Derived from the endpoint id** (stable per machine).
 *
 * ⚠️⚠️ **Not from the key**. Keys can be regenerated, and each regeneration would add a scope,
 *    **piling up registrations that can never be discarded**. ⚠️ The id (URL) does not change until the endpoint is removed.
 * ⚠️ Characters not allowed in URLs are dropped and the length is capped (a scope is just a prefix,
 *    so it need not be a real resource).
 */
export function scopeFor(id: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  const safe = id.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).toLowerCase()
  return `/push/${safe}-${h.toString(36)}/`
}

/**
 * ★★ Decide from the current state "what to subscribe and what to discard".
 *
 * ⚠️ **Endpoints with an unknown key are left alone** (they may just be down = fail-closed).
 *    ⇒ Not put in `drop` either (deleting it would stop notifications once it comes back).
 * ⚠️⚠️ **If the key changed, recreate** (a subscription is bound to its key, so as-is it will not deliver).
 * ★ **Discard subscriptions matching no scope** (left behind after removing an endpoint.
 *    ⚠️ Old subscriptions at the root (`/`) = from the shared-key days are removed here too).
 */
/**
 * ★★ Whether that agent holds **the subscription for this scope** (codex round 13, high #3).
 *
 * @param status the `/push/status` response (reads `endpointTags`)
 * @param myTag  the endpoint tag of this scope's subscription (`shared/pushTag.ts`). `undefined` if there is no subscription
 * @returns **`undefined`** when unknown (an old agent returning no tags) (⚠️ do not fall back to `subscribed`)
 */
export function registeredFor(status: { endpointTags?: unknown }, myTag: string | undefined): boolean | undefined {
  if (!Array.isArray(status.endpointTags)) return undefined
  if (myTag === undefined) return false
  return status.endpointTags.includes(myTag)
}

export function planPush(agents: readonly AgentPush[], existing: readonly ExistingSub[]): PushPlan {
  const want = new Map<string, { id: string; scope: string; publicKey: string }>()
  for (const a of agents) {
    if (!a.publicKey) continue // ⚠️ leave unknown ones alone
    const scope = scopeFor(a.id)
    want.set(scope, { id: a.id, scope, publicKey: a.publicKey })
  }
  const subscribe: { id: string; scope: string; publicKey: string }[] = []
  const reregister: { id: string; scope: string }[] = []
  const have = new Map(existing.map((e) => [e.scope, e]))
  const byScope = new Map(agents.filter((a) => a.publicKey).map((a) => [scopeFor(a.id), a]))
  for (const [scope, w] of want) {
    const cur = have.get(scope)
    // ⚠️ Recreate if not subscribed, or if **the key differs**
    if (!cur || cur.publicKey !== w.publicKey) {
      subscribe.push(w)
      continue
    }
    // ★★ The subscription exists but **we cannot confirm it reached the agent** ⇒ just resend (high #2)
    //   ⚠️⚠️ Resend not only on `=== false` but **also on `undefined` (old agent)** (resending overwrites, so it is safe).
    //      Do not treat what cannot be confirmed as "delivered" (codex round 13, high #3).
    if (byScope.get(scope)?.registered !== true) reregister.push({ id: w.id, scope })
  }

  // ⚠️ Discard subscriptions not in the wanted scopes (⚠️ unknown endpoints are not in `want`, but
  //    theirs **remain because the scope matches**. Only those whose destination is really gone are discarded)
  const keep = new Set(want.keys())
  const unknown = new Set(agents.filter((a) => !a.publicKey).map((a) => scopeFor(a.id)))
  // ★★ **Subscriptions from the shared-key days (`/` etc., belonging to no agent) are discarded last**
  //   (2026-09-21 / codex round 12, high #3).
  //   ⚠️⚠️ That one was **shared by every agent**, so discarding it while even one is still "unknown (down)"
  //      means **that agent cannot send notifications even after it comes back**
  //      (the endpoint has been unsubscribed).
  //   ⇒ Discard it only **when every key is known and no replacement is outstanding**.
  // ⚠️⚠️ And only **when everyone definitely holds "the subscription for this scope" (`registered === true`)**
  //    (codex round 13, high #3. Merely knowing the keys deleted the old one even when the new registration had failed)
  const replaced = subscribe.length === 0 && agents.every((a) => a.publicKey && a.registered === true)
  const isAgentScope = (s: string) => s.startsWith('/push/')
  const drop = existing
    .filter((e) => !keep.has(e.scope) && !unknown.has(e.scope))
    // ⚠️ Subscriptions not belonging to an agent (= old shared ones) are kept until replacement is done
    .filter((e) => isAgentScope(e.scope) || replaced)
    .map((e) => e.scope)
  return { subscribe, reregister, drop }
}

/**
 * ★★ **Whether a scope may be unregistered** (2026-09-21).
 *
 * ⚠️⚠️ **Never unregister the shell SW (`/`)** — removing it **breaks offline startup**
 *    (`sw.js` holds `/index.html` and `/assets/`).
 * ⚠️ Nearly hit in practice: the code discarding subscriptions had a branch that also removed the `/` registration,
 *    with a guard only in `disable()` and none in `syncSubscription()`.
 *    ⇒ **Put the decision in one place and use it from both** (a function, not a convention).
 * ★ Touch **only what we created** (under `/push/`). Never touch anyone else's scope.
 */
export function canUnregisterScope(scope: string): boolean {
  return scope.startsWith('/push/')
}
