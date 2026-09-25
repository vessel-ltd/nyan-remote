// ★★ The part that **executes** the push subscription plan (2026-09-23 / codex round 13, high #2, a hole in the tests).
//
// ⚠️⚠️ It used to live in `PushPanel.tsx` with **not a single behavioural test**:
//   - removing the "never remove the shell SW (`/`)" check (`canUnregisterScope`) **failed no test at all**
//   - the "stopped?" check ran **only once at the start of a sync**, so stopping in another tab **was undone by a later resubscribe**
// ⇒ Only the browser-dependent parts (registering the SW, creating subscriptions, unregistering the SW) are **injected as ports**,
//   and every decision lives here (= testable from Node).

import { canUnregisterScope, type PushPlan } from './pushScopes.ts'

/** ⚠️ Only the part of the browser's `PushSubscription` used here */
export interface PushSub {
  readonly endpoint: string
  toJSON(): unknown
  unsubscribe(): Promise<boolean>
}

/** ⚠️ Only the part of `Transport` used here */
export interface PushTarget {
  readonly id: string
  readonly label: string
  registerPush(sub: unknown): Promise<unknown>
  unregisterPush(endpoint: string): Promise<unknown>
}

export interface PushDeps {
  /** Prepare the SW for that scope and, once active, create and return a **new subscription** (⚠️ throws on timeout etc.) */
  subscribe(scope: string, publicKey: string): Promise<PushSub>
  /** Unregister that scope's SW (⚠️ only scopes that passed `canUnregisterScope` are passed here) */
  unregisterScope(scope: string): Promise<void>
  /**
   * Whether the user "stopped notifications".
   * ⚠️⚠️ **Read it every time** (other tabs write it too / localStorage). **The situation changes at every await**.
   */
  stopped(): boolean
}

/**
 * ★ Discard one scope (the agent's record → the subscription → the SW registration).
 * @returns whether the subscription was unsubscribed (⚠️ so we never say "stopped" when it was not)
 */
export async function dropScope(
  scope: string,
  sub: PushSub,
  targets: readonly PushTarget[],
  deps: Pick<PushDeps, 'unregisterScope'>,
): Promise<boolean> {
  // ⚠️ Drop the agent's record too (do not leave undeliverable subscriptions)
  for (const t of targets) {
    try {
      await t.unregisterPush(sub.endpoint)
    } catch {
      // Ignore machines that are down (⚠️ that agent's record remains, but the subscription itself dies)
    }
  }
  const gone = await sub.unsubscribe().catch(() => false)
  // ⚠️⚠️ The decision is `canUnregisterScope`, in one place (removing the shell SW breaks offline startup)
  if (canUnregisterScope(scope)) await deps.unregisterScope(scope).catch(() => {})
  return gone
}

/**
 * ★★ Execute the plan. **Create first, discard after** (codex round 12, high #3).
 * @returns problems to show on screen (⚠️ never swallowed silently / codex medium #6)
 */
export async function executePlan(
  plan: PushPlan,
  have: readonly { scope: string; sub: PushSub | null }[],
  targets: readonly PushTarget[],
  deps: PushDeps,
): Promise<string[]> {
  const problems: string[] = []
  const find = (id: string) => targets.find((t) => t.id === id)

  for (const w of plan.subscribe) {
    const t = find(w.id)
    if (!t) continue
    // ★★ **Also check "have we been stopped?" before starting to create** (2026-09-23 / codex round 14, medium #3).
    //   ⚠️ It only checked "after creating", so **for a machine where creation failed it moved on without checking**,
    //      waited out every SW startup (up to 8 s × machines), and only then began honouring the stop (up to ~24 s).
    if (deps.stopped()) return problems
    // ★ The endpoint before recreation (⚠️ `deps.subscribe` unsubscribes it in the browser; the agent side is removed below)
    const replaced = have.find((h) => h.scope === w.scope)?.sub?.endpoint
    let sub: PushSub
    try {
      sub = await deps.subscribe(w.scope, w.publicKey)
    } catch (err) {
      problems.push(`${t.label}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    // ★★ **Check "have we been stopped?" once more right before registering** (codex round 13, high #2).
    //   ⚠️⚠️ If **another tab stops it** while the subscription is being created (SW startup wait, subscribe),
    //      registering here would **revive the subscription** after "Stopped".
    //   ⇒ If stopped, also unsubscribe the one just created and **leave nothing behind**.
    if (deps.stopped()) {
      await sub.unsubscribe().catch(() => false)
      return problems
    }
    try {
      await t.registerPush(sub.toJSON())
    } catch (err) {
      problems.push(`${t.label}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    // ★★ **Remove the replaced old endpoint from that agent** (2026-09-23 / cleanup for codex round 14, medium #2).
    //   ⚠️ The agent no longer folds tailnet (IP identity) subscriptions into "one per device", so
    //      without removal **dead old endpoints pile up** (FCM returns 201 even for dead endpoints = never cleaned automatically).
    //   ⚠️ Only **this browser's own** old endpoint may be removed (`have` is this browser's subscription).
    if (replaced && replaced !== sub.endpoint) await t.unregisterPush(replaced).catch(() => {})
  }

  // ★ **Resend** subscriptions that exist but have not reached the agent (do not recreate / high #2)
  for (const r of plan.reregister) {
    const t = find(r.id)
    const cur = have.find((h) => h.scope === r.scope)
    if (!t || !cur?.sub) continue
    if (deps.stopped()) return problems // ⚠️ same as above (do not send if stopped)
    try {
      await t.registerPush(cur.sub.toJSON())
    } catch (err) {
      problems.push(`${t.label}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ⚠️ Discard subscriptions no longer needed (removed endpoints / old shared subscriptions already replaced)
  for (const scope of plan.drop) {
    const cur = have.find((h) => h.scope === scope)
    if (!cur?.sub) continue
    await dropScope(scope, cur.sub, targets, deps)
  }
  return problems
}

/**
 * ★ Stop every scope ("Stop notifications").
 * @returns scopes that could not be stopped (⚠️ if non-empty, do not say "Stopped" / medium #6)
 */
export async function stopAll(
  have: readonly { scope: string; sub: PushSub | null }[],
  targets: readonly PushTarget[],
  deps: Pick<PushDeps, 'unregisterScope'>,
): Promise<string[]> {
  const left: string[] = []
  for (const h of have) {
    if (!h.sub) continue
    if (!(await dropScope(h.scope, h.sub, targets, deps))) left.push(h.scope)
  }
  return left
}

/** ⚠️ Only the part of the browser's `navigator.locks` used here */
export interface LockManagerLike {
  request<T>(name: string, fn: () => Promise<T>): Promise<T>
}

/**
 * ★★ **Serialise sync and stop into one line across tabs** (codex round 13, high #2).
 *
 * ⚠️⚠️ The original `serialize` was a chain **within that page only** ⇒ another tab's sync and stop interleaved.
 * ★ Web Locks (`navigator.locks`) share one lock across **all tabs of the same origin**.
 * ⚠️ In browsers without it, fall back to the in-page chain (same as before = no regression).
 *    ⚠️ Even then, `executePlan`'s "check for stop right before registering" works, so nothing is revived.
 */
export function makeSerializer(locks: LockManagerLike | undefined) {
  let chain: Promise<void> = Promise.resolve()
  return function serialize(fn: () => Promise<void>): Promise<void> {
    if (locks) return locks.request('nyan-remote.push-sync', fn)
    const run = chain.then(fn, fn)
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
