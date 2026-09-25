// Matching just-sent instructions (optimistic entries) against the real ones that appear in the thread.
//
// ★ This is `.ts` rather than `.tsx` **so it can be imported from node:test**
//   (Node 24's strip-only execution cannot read `.tsx` / CLAUDE.md §5).
//
// ⚠️ At first it was "put the whole thread's text in a Set and drop every matching pending".
//    That lies in two ways (2026-08-14 external review, medium):
//      1. It hits **the same text sent in the past** ("continue", etc.) and **an undelivered send disappears**
//      2. Sending the same text twice means **one enqueue marks both as "delivered"**
//    → Look **only at what was added after sending**, and **consume one at a time**.

export interface PendingSend {
  /** The text sent */
  text: string
  /** When it was sent (used only to keep display order stable) */
  at: number
  /**
   * ★ Which route it went by (the `route` the agent returns). **The matching shape changes**:
   *
   * | route | Shape in the thread |
   * |---|---|
   * | `inbox` | `via: 'inbox'` (text with the inbox frame stripped) |
   * | `keys` | ⚠️ **no `via`** (same shape as human typing = no `origin`) |
   *
   * ⚠️⚠️ Without this, **"cannot confirm delivery" never clears although it arrived via keystrokes**
   *    (seen on a real device on 2026-08-23).
   * ⚠️ Old agents do not return `route`, but **the keystroke route did not exist then either**, so
   *    `undefined` can be treated as `inbox` (= not cleared by the same text typed on the PC).
   */
  route?: 'keys' | 'inbox'
  /** ★ A number per send (for the display key, and to find which one a reply confirms) */
  id?: number
  /**
   * ★★ **While waiting** for the send reply (2026-09-24 / codex round 25). The route (`route`) is unknown meanwhile, so
   *    records of the same text that arrive are noted in `seen` and matched once the reply reveals the route.
   */
  sending?: boolean
  seen?: ArrivedEntry[]
  /**
   * ★★ "Stop" cleared the PC input box while this keystroke send had not arrived (2026-09-25 / seen on a real device).
   *   ⚠️ While Claude is responding, the CLI **queues** what is typed; ESC puts the queue back into the input box
   *   (`queue-operation` `popAll` in the transcript) and the automatic Ctrl-U then erases it ⇒ it never arrives.
   *   ⇒ Say so instead of "Can't confirm it arrived" forever. ⚠️ Still cleared if a matching record turns up after all.
   */
  cancelled?: boolean
}

/** The minimal shape used for matching (just the needed part of `LogEntry`) */
export interface ArrivedEntry {
  kind: string
  text?: string
  via?: string
  /** Record time (ISO). ⚠️ May be missing */
  at?: string
}

/**
 * Consume newly arrived entries one at a time and return the remaining optimistic entries.
 *
 * @param pending sent but not yet confirmed (oldest first)
 * @param arrivals pass **only what this poll added** (not the whole thread)
 */
export function consumePending(pending: PendingSend[], arrivals: ArrivedEntry[]): PendingSend[] {
  if (pending.length === 0 || arrivals.length === 0) return pending
  const rest = [...pending]
  for (const a of arrivals) {
    if (a.kind !== 'user' || typeof a.text !== 'string') continue
    // ⚠️ Entries from another session (`via: 'peer'`) are rejected by `matches`.
    //    Do not check twice here (conditions in two places always diverge / CLAUDE.md §2)
    // Even if the same text remains several times, drop **only the oldest one**.
    // ⚠️ Drop only route-compatible ones (keystrokes: no `via` / inbox: `via: 'inbox'`)
    // ⚠️ Awaiting reply (`sending`) has no route yet, so not dropped here (`noteArrivals` notes it)
    const text = a.text
    const i = rest.findIndex((p) => !p.sending && matches(p.route, a.via) && sameText(p.route, p.text, text))
    if (i >= 0) rest.splice(i, 1)
  }
  return rest.length === pending.length ? pending : rest
}

/**
 * Whether the sending route and the shape in the thread fit together.
 *
 * ⚠️ **Kept as a table** (conditions in two places always diverge / the notification lesson in CLAUDE.md §2).
 */
function matches(route: PendingSend['route'], via: string | undefined): boolean {
  // ⚠️ Keystrokes carry no `via` (indistinguishable from human typing)
  if (route === 'keys') return via === undefined
  // `inbox`, and old agents that do not return `route` (versions without the keystroke route)
  return via === 'inbox'
}

/**
 * ★★ Whether a record's text is this send (2026-09-25 / seen on a real device).
 *   ⚠️⚠️ Keystrokes are **appended to the PC input box**, so a half-typed draft on the PC is joined in front
 *   (`…修正。` + `Test` → the record is `…修正。Test`). Exact equality left "Can't confirm it arrived" behind for ever.
 *   ⇒ keystrokes (and sends whose route is not known yet): the record **ends with** the sent text.
 *   ⚠️ The inbox does not join anything ⇒ exact (after trimming, like the CLI).
 *   ⚠️ Only records that arrived after the send are passed here, so the looser rule does not reach older ones.
 */
export function sameText(route: PendingSend['route'] | 'unknown', sent: string, record: string): boolean {
  const a = sent.trim()
  const b = record.trim()
  if (a.length === 0) return false
  return route === 'keys' || route === 'unknown' ? b.endsWith(a) : a === b
}

/**
 * ★★ "Stop" also cleared the PC input box (`cleared`) ⇒ keystroke sends not yet seen were erased with it (see `cancelled`).
 *   ⚠️ Only settled keystroke sends: the inbox does not go through the input box, and a send still awaiting its reply
 *   has no route yet.
 */
export function cancelAfterStop(pending: PendingSend[]): PendingSend[] {
  // ★ A send awaiting its reply has no `route` yet, so `route === 'keys'` already leaves it out
  if (!pending.some((p) => p.route === 'keys' && !p.cancelled)) return pending
  return pending.map((p) => (p.route === 'keys' ? { ...p, cancelled: true } : p))
}

/** ★ The user dismissed a leftover bubble (unconfirmed or cancelled) */
export function dismissPending(pending: PendingSend[], id: number | undefined, at: number): PendingSend[] {
  return pending.filter((p) => !(p.id === id && p.at === at))
}

/** ★ Key identifying a record (time, route, text). ⚠️ Used so that "one record is used only once" */
export const recordKey = (e: ArrivedEntry): string => `${e.at ?? ''}\u0000${e.via ?? ''}\u0000${e.text ?? ''}`

/**
 * ★★ Stack it at the moment of sending (2026-09-24 / codex round 25, medium #3, #4).
 *
 * ⚠️⚠️ It used to "stack after the reply returns, and look up what arrived meanwhile in a buffer" ⇒ exceeding the buffer cap (100),
 *    reloading (`loadFirst`) or arriving before the reply all caused a missed match, and **"Sending…" stayed although it arrived**.
 * ⇒ **Stack at send time** (`sending`), note arrivals on the spot (`noteArrivals`), confirm once the reply reveals the route (`finishSend`).
 *    Only **own messages with the same text** are noted, so no cap is needed.
 * ⚠️ `at` is **the time sending started** (taken after the reply, a slow reply would look like "a record before sending" / medium #2).
 */
export function beginSend(pending: PendingSend[], id: number, text: string, at: number): PendingSend[] {
  return [...pending, { id, text, at, sending: true, seen: [] }]
}

/**
 * ★ Match against arrivals (pass **only what was added** by live follow or the insurance poll).
 *   Confirmed ones are dropped; those awaiting a reply note records with the same text (one record is used only once).
 */
export function noteArrivals(pending: PendingSend[], arrivals: readonly ArrivedEntry[], used?: Set<string>): PendingSend[] {
  if (pending.length === 0 || arrivals.length === 0) return pending
  let rest = pending
  let changed = false
  for (const a of arrivals) {
    if (a.kind !== 'user' || typeof a.text !== 'string') continue
    // ⚠️ Remember used records (so that on a later full reload the same record does not drop another send).
    //    ⚠️ Records without a time cannot be told apart (two identical texts look like one), so they are not remembered
    const key = a.at ? recordKey(a) : undefined
    if (key && used?.has(key)) continue
    const after = consumePending(rest, [a])
    if (after !== rest) {
      rest = after
      changed = true
      if (key) used?.add(key)
      continue
    }
    const text = a.text
    const j = rest.findIndex((p) => p.sending && sameText('unknown', p.text, text))
    if (j >= 0) {
      rest = rest.map((p, k) => (k === j ? { ...p, seen: [...(p.seen ?? []), a] } : p))
      changed = true
      if (key) used?.add(key)
    }
  }
  return changed ? rest : pending
}

/**
 * ★ The send reply came back. ⚠️ On failure (`route === null`) drop it (not sent = do not leave it stacked).
 *   If it already arrived (a route-compatible record is noted), drop it. Otherwise attach the route and wait.
 */
export function finishSend(pending: PendingSend[], id: number, route: PendingSend['route'] | null): PendingSend[] {
  const i = pending.findIndex((p) => p.id === id)
  if (i < 0) return pending
  const p = pending[i]!
  if (route === null) return pending.filter((_, k) => k !== i)
  const settled: PendingSend = { text: p.text, at: p.at, id: p.id, ...(route ? { route } : {}) }
  if (consumePending([settled], p.seen ?? []).length === 0) return pending.filter((_, k) => k !== i)
  return pending.map((x, k) => (k === i ? settled : x))
}

/**
 * ★★ Matching when the page is **reloaded in full** (the file was recreated, the first load was redone).
 *   ⚠️ The full reload also contains "the same text sent earlier" ⇒ match only against records **after each send's time** (with a little slack)
 *   (matching against everything would drop an undelivered send via an older identical text).
 *   ⚠️⚠️ **One record is used only once** (remembered in `used` = reloading does not let the same record drop the next send / codex round 25, medium #1).
 *   ⚠️ Records without a time are not used (do not over-drop = leftovers vanish on reopening).
 *   ⚠️ Remaining limit: if the phone and PC clocks differ by more than the slack it can miss (rare path + clears on reopening).
 */
export const RELOAD_SLACK_MS = 5_000


export function consumeAfterReload(pending: PendingSend[], entries: readonly ArrivedEntry[], used: Set<string>): PendingSend[] {
  if (pending.length === 0) return pending
  let rest = pending
  for (const e of entries) {
    if (e.kind !== 'user' || typeof e.text !== 'string' || typeof e.at !== 'string') continue
    const key = recordKey(e)
    if (used.has(key)) continue
    const t = Date.parse(e.at)
    const text = e.text
    // ★ Only sends started before that record can match (per-send boundary). Only the oldest one
    const i = rest.findIndex(
      (p) =>
        t >= p.at - RELOAD_SLACK_MS &&
        (p.sending ? sameText('unknown', p.text, text) : matches(p.route, e.via) && sameText(p.route, p.text, text)),
    )
    if (i < 0) continue
    used.add(key)
    const p = rest[i]!
    rest = p.sending
      ? rest.map((x, k) => (k === i ? { ...x, seen: [...(x.seen ?? []), e] } : x))
      : rest.filter((_, k) => k !== i)
  }
  return rest
}
