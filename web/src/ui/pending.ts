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
  seen?: Seen[]
}

/**
 * ★ A record noted while awaiting the reply. `reload` = it came from a full reload, so the reload time rule
 *   (`inTime`) still applies when it is offered to other sends (codex round 3, medium #1).
 */
export type Seen = ArrivedEntry & { reload?: true }

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
    const i = pick(rest, (p) => (p.sending ? undefined : fit(p, a.via, text)))
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
 * ★★ How a record's text fits this send (2026-09-25 / reproduced on a real device).
 *   ⚠️⚠️ Keystrokes are **appended to the PC input box**, so a half-typed draft on the PC is joined in front
 *   (`あいう` + `Test` → the record is `あいうTest`). Exact equality left "Can't confirm it arrived" behind for ever.
 *   ⇒ keystrokes (and sends whose route is not known yet): a record that **ends with** the sent text fits as `suffix`.
 *   ⚠️ The inbox joins nothing ⇒ `exact` only.
 *   ★ The agent shows records with trailing whitespace removed (`clip` in agent/src/claude/log.ts) ⇒ compare without it.
 *   ⚠️ A `suffix` fit is weaker: an exact fit anywhere wins over it (`pick` / codex, medium #1).
 */
export type Fit = 'exact' | 'suffix' | undefined
export function textFit(route: PendingSend['route'] | 'unknown', sent: string, record: string): Fit {
  const s = sent.trimEnd()
  // ⚠️ A blank send would be a suffix of every record
  if (s.length === 0) return undefined
  if (record === s) return 'exact'
  return (route === 'keys' || route === 'unknown') && record.endsWith(s) ? 'suffix' : undefined
}

/** ★ Route and text together (a send awaiting its reply has no route yet, so only its text is judged) */
function fit(p: PendingSend, via: string | undefined, text: string): Fit {
  if (p.sending) return textFit('unknown', p.text, text)
  return matches(p.route, via) ? textFit(p.route, p.text, text) : undefined
}

/**
 * ★★ The oldest exact fit, else the oldest suffix fit (codex, medium #1: with `ok` and `looks ok` pending,
 *   the record `looks ok` used to clear `ok` and leave the delivered `looks ok` behind).
 */
function pick(rest: readonly PendingSend[], f: (p: PendingSend) => Fit): number {
  let weak = -1
  for (let i = 0; i < rest.length; i++) {
    const k = f(rest[i]!)
    if (k === 'exact') return i
    if (k === 'suffix' && weak < 0) weak = i
  }
  return weak
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
    // ★ Settled and awaiting-reply sends compete together (an exact fit wins either way / `pick`)
    const text = a.text
    const j = pick(rest, (p) => fit(p, a.via, text))
    if (j < 0) continue
    rest = rest[j]!.sending
      ? rest.map((p, k) => (k === j ? { ...p, seen: [...(p.seen ?? []), a] } : p))
      : rest.filter((_, k) => k !== j)
    changed = true
    if (key) used?.add(key)
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
  const settled: PendingSend = { text: p.text, at: p.at, id: p.id, ...(route ? { route } : {}) }
  // ★★ The noted records are **offered to every settled send**, not only this one (codex round 2, medium #1):
  //   a record noted here by an exact fit may belong to an older keystroke send (`ok` joined to a PC draft `looks `)
  //   while this reply says `inbox`; it is already marked `used`, so nothing else would ever offer it again.
  //   ⚠️ Exact fits still win (`pick`), and each record clears at most one send.
  //   ⚠️⚠️ A record from a full reload keeps the reload time rule for **each** candidate (codex round 3, medium #1:
  //      a `looks ok` said before both sends was noted for the newer `looks ok` by the exact-fit slack, then offered
  //      without the rule and cleared the older, undelivered `ok`).
  //   ⚠️ A failed send (`null`) is dropped, but what it noted is offered back the same way (codex round 4, medium #1)
  let list = route === null ? pending.filter((_, k) => k !== i) : pending.map((x, k) => (k === i ? settled : x))
  for (const r of p.seen ?? []) {
    if (r.kind !== 'user' || typeof r.text !== 'string') continue
    const text = r.text
    const t = r.reload ? Date.parse(r.at ?? '') : undefined
    const j = pick(list, (q) => {
      if (q.sending) return undefined
      const k = fit(q, r.via, text)
      return t === undefined ? k : inTime(k, t, q.at)
    })
    if (j >= 0) list = list.filter((_, k) => k !== j)
  }
  return list
}

/**
 * ★★ Matching when the page is **reloaded in full** (the file was recreated, the first load was redone).
 *   ⚠️ The full reload also contains "the same text sent earlier" ⇒ match only against records **after each send's time** (with a little slack)
 *   (matching against everything would drop an undelivered send via an older identical text).
 *   ⚠️⚠️ **One record is used only once** (remembered in `used` = reloading does not let the same record drop the next send / codex round 25, medium #1).
 *   ⚠️ Records without a time are not used (do not over-drop = leftovers vanish on reopening).
 *   ⚠️ Remaining limit: if the phone and PC clocks differ by more than the slack it can miss (rare path + clears on reopening).
 *   ⚠️ A suffix fit (a send joined to a PC draft) gets no slack, so it can miss on reload whenever the PC clock is behind
 *     (kept on purpose: slack there let an earlier record clear an undelivered send / codex, medium #2).
 */
export const RELOAD_SLACK_MS = 5_000

/** ★ The reload time rule: exact fits get the clock slack, suffix fits need a record at or after the send */
function inTime(k: Fit, t: number, sentAt: number): Fit {
  if (k === 'exact') return t >= sentAt - RELOAD_SLACK_MS ? k : undefined
  return k === 'suffix' && t >= sentAt ? k : undefined
}


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
    // ⚠️⚠️ The clock slack is for exact fits only; a suffix fit needs a record at or after the send
    //    (codex, medium #2: `looks ok` said 4 seconds before sending `ok` cleared the undelivered `ok`)
    const i = pick(rest, (p) => inTime(fit(p, e.via, text), t, p.at))
    if (i < 0) continue
    used.add(key)
    const p = rest[i]!
    rest = p.sending
      ? rest.map((x, k) => (k === i ? { ...x, seen: [...(x.seen ?? []), { ...e, reload: true as const }] } : x))
      : rest.filter((_, k) => k !== i)
  }
  return rest
}
