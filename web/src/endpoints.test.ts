// ★★ The endpoint list (`web/src/endpoints.ts`).
//
//   ⚠️⚠️ **2026-09-16: dropped the assumption "there's an agent on our own origin"** (to move to Y).
//      Served from a public origin, there is **no** agent on our own origin. Yet one row was still
//      listed by default, so **a "❌ no response" row always appeared** (= looks broken).
//   ★ But it must keep working in X (the agent serves the PWA) too, so **instead of removing it,
//      it's now "added after checking"** (`shouldOfferSelf`).
//
//   Mutations killed by name:
//     ① with nothing saved, add our own origin **unconditionally** (looks broken on a public origin)
//     ② add our own origin even though something is saved (a removed row comes back)
//     ③ add it even though `/health` didn't answer
//     ④ add it on another machine's `/health` too (= not actually an own-origin check)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mergeAdded,
  upsertEndpoint, canSwitchRoute, endpointRoute, hasRoute, loadEndpoints, mergeRoute,
  saveEndpoints, selfCandidate, setRouteIn, shouldOfferManualUrl, shouldOfferSelf,
  type AgentEndpoint
} from './endpoints.ts'
import { staleTwins } from './endpoints.ts'

/** ⚠️ Fake localStorage close to the real one */
function installFakeStorage(): Map<string, string> {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
  return store
}

function installLocation(origin: string): void {
  ;(globalThis as { location?: unknown }).location = {
    origin,
    hostname: new URL(origin).hostname,
  }
}

test('★★ starts empty when nothing is saved (① never adds our own origin on its own)', () => {
  installFakeStorage()
  installLocation('https://nyan.example')
  assert.deepEqual(loadEndpoints(), [], '⚠️⚠️ a "no response" row appears on the public origin')
})

test('★★ uses what is saved (② no revival)', () => {
  const store = installFakeStorage()
  installLocation('https://nyan.example')
  store.set('tmux-agent.endpoints.v1', JSON.stringify([{ id: 'a', url: 'https://a.invalid', label: 'A' }]))
  const got = loadEndpoints()
  assert.equal(got.length, 1)
  assert.equal(got[0]?.id, 'a')
})

test('★★ our own origin is added only when "an agent was there" (③④)', () => {
  installLocation('https://pc-a.example.ts.net')
  // ⚠️ Only when the list is empty and our own origin answered as an agent
  assert.equal(shouldOfferSelf([], { ok: true } as const), true)
  assert.equal(shouldOfferSelf([], { ok: false } as const), false, '③')
  assert.equal(shouldOfferSelf([], undefined), false, '⚠️ not added while still unknown')
  // ⚠️⚠️ Not added if endpoints already exist (a removed row would come back)
  assert.equal(
    shouldOfferSelf([{ id: 'a', url: 'https://a.invalid', label: 'A' }], { ok: true } as const),
    false,
    '②',
  )
})

test('★★ the own-origin candidate is the current origin itself (④)', () => {
  installLocation('https://pc-a.example.ts.net')
  assert.deepEqual(selfCandidate(), {
    id: 'https://pc-a.example.ts.net',
    url: 'https://pc-a.example.ts.net',
    label: 'pc-a.example.ts.net',
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ The one machine added by pairing (2026-09-18 / codex round 8, medium #2)
//
// ⚠️⚠️ It used to be in `main.tsx`, so **there were no behavioral tests**, and
//   the mistake of "guessing the route from whether `url` is empty" went unseen.
//   ⇒ Mutations killed: ㉙ guess from `url` instead of the registered route / ㉚ identify by `url`
// ─────────────────────────────────────────────────────────────────────────────

const R1 = { url: 'wss://relay.example', agentPublicKey: 'かぎ1' }
const R2 = { url: 'wss://relay.example', agentPublicKey: 'かぎ2' }

test('★★ saves the registered route as-is (㉙ no guessing from `url`)', () => {
  // ⚠️⚠️ A peer registered via relay that also has `u`. When guessing, it became `local`, and
  //    now that CORS auto-allow is gone **an endpoint that can't connect** stayed in the list.
  const got = upsertEndpoint([], {
    url: 'https://pc-b.example.ts.net',
    label: 'pc-b',
    relay: R1,
    kind: 'relay',
  })
  assert.equal(got?.[0]?.kind, 'relay', '⚠️⚠️ the registered route is not saved')
  assert.equal(endpointRoute(got![0]!), 'relay')

  // ★ Registered via local stays local (⚠️ don't change it on our own even with relay material)
  const local = upsertEndpoint([], { url: 'https://pc-b.example.ts.net', label: 'pc-b' })
  assert.equal(local?.[0]?.kind, undefined)
  assert.equal(endpointRoute(local![0]!), 'local')
})

test('★★ without material, `relay` is not written (fail-closed)', () => {
  const got = upsertEndpoint([], { url: 'https://x.example', label: 'x', kind: 'relay' })
  assert.equal(got?.[0]?.kind, undefined, '⚠️⚠️ choosing an unreachable route')
  assert.equal(endpointRoute(got![0]!), 'local')
})

test('★★ identity is by key (㉚ a second relay-only machine isn\'t silently dropped)', () => {
  // ⚠️⚠️ Peers reachable only via relay have an empty `url`. Deduplicating by `url` **loses the second one**
  const one = upsertEndpoint([], { url: '', label: 'A', relay: R1, kind: 'relay' })
  assert.equal(one?.length, 1)
  const two = upsertEndpoint(one!, { url: '', label: 'B', relay: R2, kind: 'relay' })
  assert.equal(two?.length, 2, '⚠️⚠️ the second relay-only endpoint was dropped')
  assert.notEqual(two![0]!.id, two![1]!.id, '⚠️ ids collide')
})

test('★★ does nothing if it already exists (⚠️ doesn\'t clobber existing settings)', () => {
  const list = upsertEndpoint([], { url: '', label: 'A', relay: R1, kind: 'relay' })!
  assert.equal(upsertEndpoint(list, { url: '', label: 'ちがう名前', relay: R1, kind: 'relay' }), undefined)
  // ★ Same URL isn't added either
  const withUrl = upsertEndpoint([], { url: 'https://x.example', label: 'x' })!
  assert.equal(upsertEndpoint(withUrl, { url: 'https://x.example', label: 'y' }), undefined)
})

test('★★ doesn\'t add what can\'t be named (empty URL and no relay material)', () => {
  assert.equal(upsertEndpoint([], { url: '', label: 'なぞ' }), undefined)
})

test('★★ also applies the verified material and route to an existing endpoint (codex round 9, medium #3)', () => {
  // ⚠️⚠️ It used to "do nothing if present", so **even after registration succeeded via relay,
  //    that endpoint got neither the material nor the route** (the screen said "remembered" — a lie).
  //    ★ Conditions: a local row is in the list, that local is unreachable (CORS / outage) so
  //      `healths` is `undefined`, the QR has `u` and `r`, and registration via relay succeeded.
  const before = [{ id: 'https://pc-b.example.ts.net', url: 'https://pc-b.example.ts.net', label: 'わたしの名前' }]
  const after = upsertEndpoint(before, {
    url: 'https://pc-b.example.ts.net',
    label: 'PC-B',
    relay: R1,
    kind: 'relay',
  })
  assert.ok(after, '⚠️⚠️ not applied to the existing endpoint')
  assert.equal(after.length, 1, '⚠️ rows increased (double registration)')
  assert.deepEqual(after[0]!.relay, R1, '⚠️⚠️ relay material not stored')
  assert.equal(after[0]!.kind, 'relay', '⚠️⚠️ the verified route not stored')
  assert.equal(endpointRoute(after[0]!), 'relay')
  // ⚠️ **Don't clobber the name the user gave**
  assert.equal(after[0]!.label, 'わたしの名前', '⚠️⚠️ overwrote the name')
})

test('★★ doesn\'t save again when nothing changes (⚠️ no wasted writes)', () => {
  const list = upsertEndpoint([], { url: '', label: 'A', relay: R1, kind: 'relay' })!
  assert.equal(
    upsertEndpoint(list, { url: '', label: 'ちがう名前', relay: R1, kind: 'relay' }),
    undefined,
    '⚠️ rewriting despite identical contents',
  )
})

test('★★ a state with zero endpoints can be saved (2026-09-19 / so the last one can be removed)', () => {
  // ⚠️⚠️ **Zero is a normal initial state** (2026-09-16 / Y). ⇒ Removing all and saving must **come back empty**.
  //    If this were read as "broken", removed old endpoints would **appear to come back**.
  const store = new Map<string, string>()
  const g = globalThis as { localStorage?: unknown }
  const before = g.localStorage
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  }
  try {
    saveEndpoints([{ id: 'a', url: 'https://a.example', label: 'A' }])
    assert.equal(loadEndpoints().length, 1)
    saveEndpoints([])
    assert.deepEqual(loadEndpoints(), [], '⚠️⚠️ removed everything but it does not come back empty')
  } finally {
    if (before === undefined) delete g.localStorage
    else g.localStorage = before
  }
})

test('★★ with zero, it returns to deciding whether to add our own origin (⚠️ on the public origin the probe fails so nothing is added)', () => {
  // ★ State the behavior after removing everything (⚠️ on a page served by the agent itself it comes back = correct)
  assert.equal(shouldOfferSelf([], { ok: true }), true, 'added on an origin with an agent')
  assert.equal(shouldOfferSelf([], { ok: false }), false, '⚠️ not added on the public origin')
  assert.equal(shouldOfferSelf([], undefined), false, '⚠️ not added while unknown')
})

// ─────────────────────────────────────────────────────────────────────────────
// ★★ "Enter a URL directly" only when there's an agent on our own origin (2026-09-21 / feedback from real use)
// ─────────────────────────────────────────────────────────────────────────────

test('★★ not shown on the public origin (no agent) — because pressing it never works', () => {
  // ⚠️⚠️ Only a URL can be typed = it becomes a `local` endpoint, but
  //    **the relay entrance and key only come from the QR**, and
  //    **CORS auto-allow for the public origin was removed on 2026-09-18**.
  //    ⇒ Showing it makes users create "❌ no response" rows themselves (the shape discipline 1 forbids).
  assert.equal(shouldOfferManualUrl({ ok: false }), false)
})

test('★★ not shown while unknown (fail-closed)', () => {
  // ⚠️ Showing it before the probe returns lets it flash and be pressed even on the public origin
  assert.equal(shouldOfferManualUrl(undefined), false)
})

test('★★ shown when there\'s an agent on our own origin (X = needed by self-hosters)', () => {
  // ★ §14.3 "always keep both X and Y" ⇒ **must not be removed entirely**
  assert.equal(shouldOfferManualUrl({ ok: true }), true)
})

// ★★ **The route-material check is needed on both the `relay` and `local` sides** (2026-09-21 / found in real use).
//   ⚠️⚠️ `endpointRoute` was fail-closed only on the relay side with no equivalent check on the `local` side, so
//      even for **relay-only peers** (machines without Tailscale = empty `url`) the screen
//      offered "switch route to local", and pressing it produced **a dead row connecting to an empty URL**.
test('★★ a route without material can\'t be chosen (⚠️ fail-closed on the local side)', () => {
  const relayOnly: AgentEndpoint = {
    id: 'k',
    url: '', // ★ a peer whose QR had no `u` (a machine not using Tailscale)
    label: 'pc-c',
    relay: { url: 'wss://relay.example.com', agentPublicKey: 'A' },
    kind: 'relay',
  }
  assert.equal(hasRoute(relayOnly, 'relay'), true)
  assert.equal(hasRoute(relayOnly, 'local'), false, '⚠️⚠️ accepts an empty URL as local material')
  assert.equal(canSwitchRoute(relayOnly), false, '⚠️⚠️ allows switching to an unreachable route')

  const localOnly: AgentEndpoint = { id: 'u', url: 'https://x.ts.net', label: 'x' }
  assert.equal(hasRoute(localOnly, 'local'), true)
  assert.equal(hasRoute(localOnly, 'relay'), false)
  assert.equal(canSwitchRoute(localOnly), false, '⚠️ offers switching without relay material')

  const both: AgentEndpoint = { ...relayOnly, url: 'https://x.ts.net' }
  assert.equal(canSwitchRoute(both), true, '⚠️ can\'t switch even though both are present')
})

// ★ `endpointRoute` and `hasRoute` look at **the same material** (⚠️ kills mutations fixing only one)
test('★★ the chosen route always has material (correspondence between endpointRoute and hasRoute)', () => {
  const cases: AgentEndpoint[] = [
    { id: '1', url: '', label: 'a', relay: { url: 'wss://r', agentPublicKey: 'A' }, kind: 'relay' },
    { id: '2', url: 'https://a', label: 'b', kind: 'local' },
    { id: '3', url: 'https://a', label: 'c', relay: { url: 'wss://r', agentPublicKey: 'A' }, kind: 'relay' },
    // ⚠️ Says `relay` without material (`endpointRoute` falls back to local)
    { id: '4', url: 'https://a', label: 'd', kind: 'relay' },
  ]
  for (const e of cases) {
    assert.equal(hasRoute(e, endpointRoute(e)), true, `⚠️⚠️ a route without material was chosen: ${e.id}`)
  }
})

// ★★ **Put the guard where the state changes, not in the display** (2026-09-21).
//   ⚠️⚠️ A mutation reverting the `.tsx` condition couldn't be killed (`.tsx` has no behavioral tests), so
//      **pressing it can't break anything**. ⇒ Even if the button shows, it doesn't become a dead row.
test('★★ doesn\'t switch to a route without material (pressing can\'t break it)', () => {
  const relayOnly: AgentEndpoint = {
    id: 'k',
    url: '',
    label: 'pc-c',
    relay: { url: 'wss://relay.example.com', agentPublicKey: 'A' },
    kind: 'relay',
  }
  const only = (l: readonly AgentEndpoint[]): AgentEndpoint => {
    const first = l[0]
    assert.ok(first, '⚠️ the row disappeared')
    return first
  }
  assert.equal(only(setRouteIn([relayOnly], 'k', 'local')).kind, 'relay', '⚠️⚠️ a peer with an empty URL became local (dead row)')
  assert.equal(endpointRoute(only(setRouteIn([relayOnly], 'k', 'local'))), 'relay')

  // ★ With material it switches normally (⚠️ kills a do-nothing mutation)
  const both: AgentEndpoint = { ...relayOnly, url: 'https://x.ts.net' }
  assert.equal(only(setRouteIn([both], 'k', 'local')).kind, 'local', '⚠️ can\'t switch')
  assert.equal(only(setRouteIn([both], 'k', 'relay')).kind, 'relay')

  // ⚠️ Don't touch other rows
  const other: AgentEndpoint = { id: 'z', url: 'https://z', label: 'z', kind: 'local' }
  const list = setRouteIn([both, other], 'k', 'local')
  assert.equal(list[1], other, '⚠️ rebuilt a row that was not specified')
})

test('★★ mergeAdded: adds endpoints newly added to the parent; doesn\'t bring back unlinked ones (codex round 15, medium #4)', () => {
  const a = { id: 'https://a', url: 'https://a', label: 'A' }
  const b = { id: 'https://b', url: 'https://b', label: 'B' }
  // One added via QR from zero ⇒ add
  assert.deepEqual(mergeAdded([], [], [a]), [a])
  // Don't duplicate what's already being edited
  assert.deepEqual(mergeAdded([a], [], [a]), [a])
  // ⚠️⚠️ Present in the previously seen parent = the user removed (unlinked) it on screen ⇒ don't bring back
  assert.deepEqual(mergeAdded([], [a], [a]), [])
  // Unchanged returns the same object (no redraw)
  const editing = [a]
  assert.equal(mergeAdded(editing, [a], [a]), editing)
  // Appended at the end
  assert.deepEqual(mergeAdded([a], [a], [a, b]), [a, b])
})

test('★★ staleTwins: returns those with the same relay entrance and name but a different key (not itself, not other names, not other entrances / 2026-09-24)', () => {
  const R = 'wss://relay.example'
  const list = [
    { id: 'relay:OLD', url: '', label: 'PC', relay: { url: R, agentPublicKey: 'OLD' }, kind: 'relay' as const },
    { id: 'relay:NEW', url: '', label: 'PC', relay: { url: R, agentPublicKey: 'NEW' }, kind: 'relay' as const },
    { id: 'relay:X', url: '', label: 'Mac', relay: { url: R, agentPublicKey: 'X' }, kind: 'relay' as const },
    { id: 'relay:Y', url: '', label: 'PC', relay: { url: 'wss://other.example', agentPublicKey: 'Y' }, kind: 'relay' as const },
    { id: 'https://pc.ts.net', url: 'https://pc.ts.net', label: 'PC' },
  ]
  const ng = () => 'ng' as const
  assert.deepEqual(
    staleTwins(list, { machine: 'PC', relayUrl: R, agentPublicKey: 'NEW' }, ng).map((e) => e.id),
    ['relay:OLD'],
  )
  // ★ An old key's relay room has no agent, so since 2026-09-26 its probe is "offline" (unreachable) rather than "ng"
  assert.deepEqual(
    staleTwins(list, { machine: 'PC', relayUrl: R, agentPublicKey: 'NEW' }, () => 'offline' as const).map((e) => e.id),
    ['relay:OLD'],
    '⚠️⚠️ the "remove the old connection" offer disappeared',
  )
  // ⚠️⚠️ Rows that are connected now, checking, or unchecked aren't shown (might be another same-named machine / codex round 18, medium #4)
  for (const state of ['ok', 'checking', undefined] as const) {
    assert.deepEqual(staleTwins(list, { machine: 'PC', relayUrl: R, agentPublicKey: 'NEW' }, () => state), [], String(state))
  }
})

test('★★ a local registration switches an existing relay endpoint back to local (Tailscale after the relay is turned off / codex)', () => {
  const relay = { url: 'wss://relay.example', agentPublicKey: 'K' }
  const list = [{ id: 'https://pc-b.example.ts.net', url: 'https://pc-b.example.ts.net', label: 'mine', relay, kind: 'relay' as const }]
  const next = upsertEndpoint(list, { url: 'https://pc-b.example.ts.net', label: 'pc-b', kind: 'local' })
  assert.ok(next)
  assert.equal(endpointRoute(next[0]!), 'local', '⚠️⚠️ kept dialling the relay that was turned off')
  assert.equal(next[0]!.label, 'mine', '★ the name the user gave stays')
  // ★ Without a route, an existing endpoint keeps its route (as before)
  assert.equal(upsertEndpoint(list, { url: 'https://pc-b.example.ts.net', label: 'pc-b' }), undefined)
})

test('★★ the open screen takes route changes made by pairing, and nothing else (codex round 2)', () => {
  const relay = { url: 'wss://relay.example', agentPublicKey: 'K' }
  const a = { id: 'a', url: 'https://a.example.ts.net', label: 'A', relay, kind: 'relay' as const }
  const b = { id: 'b', url: 'https://b.example.ts.net', label: 'B', relay, kind: 'relay' as const }
  // Pairing switched A to local in the parent; the user switched B to local on this screen
  const editing = [a, { ...b, kind: 'local' as const }]
  const got = mergeRoute(editing, [a, b], [{ ...a, kind: 'local' }, b])
  assert.equal(got[0]!.kind, 'local', '⚠️⚠️ Save would restore the dead relay')
  assert.equal(got[1]!.kind, 'local', '★ the user\'s own switch is kept')
  // ★ Back to the default (no kind) is carried too
  const { kind: _k, ...plain } = a
  assert.equal(mergeRoute([a], [a], [plain])[0]!.kind, undefined)
})

test('★ wiring: the Endpoints screen merges route changes (mergeRoute) when the parent list changes', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./ui/Endpoints.tsx', import.meta.url), 'utf8')
  assert.match(src, /setList\(\(prev\) => \[\.\.\.mergeAdded\(mergeRoute\(mergeRelay\(prev, endpoints\), prevFresh, endpoints\), prevFresh, endpoints\)\]\)/)
})

test('★★ a new relay entry point from pairing survives Save on the open screen (moved to a self-hosted relay / codex round 3)', () => {
  const ours = { url: 'wss://relay.nyan-remote.app', agentPublicKey: 'K' }
  const mine = { url: 'wss://nyan-relay.someone.workers.dev', agentPublicKey: 'K' }
  const a = { id: 'a', url: '', label: 'A', relay: ours, kind: 'relay' as const }
  const got = mergeRoute([a], [a], [{ ...a, relay: mine }])
  assert.deepEqual(got[0]!.relay, mine, '⚠️⚠️ Save would put our relay back')
  assert.equal(got[0]!.kind, 'relay')
  // ★ Unchanged in the parent ⇒ the edited row stays as it is
  assert.equal(mergeRoute([a], [a], [a])[0], a)
})
