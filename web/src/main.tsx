// ★★ Decide the language first (before other modules build their text / `lang.ts`)
import './lang.ts'
// ★★ Apply the theme before drawing too (no dark flash on light-mode devices / `theme.ts`)
import './theme.ts'
import { render } from 'preact'
import { whileVisible } from './visibility.ts'
import { idbKeyStore, loadIdentity } from './identity.ts'
import { runUnlink } from './ui/pairRun.ts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import {
  permissionTag,
  type AgentEvent,
  type AgentFeature,
  type PermissionRequest,
  type SessionSummary,
} from '../../shared/types.ts'
import {
  upsertEndpoint,
  loadEndpoints,
  rememberRelay as rememberRelayAt,
  saveEndpoints,
  selfCandidate,
  shouldOfferSelf,
  type AgentEndpoint,
} from './endpoints.ts'
import { closeStalePermissionNotifications } from './notifications.ts'
import { goList, goSession, parseRoute, syncHistory, type Route, type RouteKind } from './route.ts'
import { t } from '../../shared/i18n.ts'
import { createTransports, probeUrl, type Transport } from './transport/index.ts'
import { Endpoints } from './ui/Endpoints.tsx'
import { buildAlertInput, nextAlert } from './ui/alerts.ts'
import { applyAutoApprove, groupSessions, showMachineFor, synthesizeRows } from './ui/order.ts'
import {
  EMPTY_LIST,
  applyPage,
  combineRows,
  markOfflineList,
  pickOwner,
  pickRow,
  shouldFetchHistory,
} from './ui/history.ts'
import { isConfirmedWait, type ConfirmedWait } from './ui/staleNotice.ts'
import { isPollDue, notePoll, POLL_TICK_MS, type PollState } from './ui/pollPlan.ts'
import { PushPanel, type PushSummary } from './ui/PushPanel.tsx'
import { pushBadge } from './ui/pushState.ts'
import { SessionList } from './ui/SessionList.tsx'
import { Thread } from './ui/Thread.tsx'
import { UpdateBanner } from './ui/UpdateBanner.tsx'
import { syncEndpointStates, syncSubscriptions } from './ui/endpointStates.ts'
import './styles.css'

/** Key remembering whether history is open (display settings live on the PWA side / CLAUDE.md) */
const HISTORY_OPEN_KEY = 'tmux-agent.historyOpen'

interface EndpointState {
  endpoint: AgentEndpoint
  machine?: string
  /**
   * ★★ Features the agent has (`features` in `/health`).
   *
   * ⚠️⚠️ **Adding an endpoint alone isn't enough to show a button** (machines update one by one, so
   *    showing a button on an agent without the endpoint yet gives 404 / codex round 7, medium #3).
   * ⚠️ `undefined` means "an old agent (doesn't return it)" = **don't show** (fail-closed).
   */
  features?: AgentFeature[]
  /** ★ The agent's version (`build` in `/health` / update notice). ⚠️ An external value ⇒ checked by `ui/updates.ts` */
  build?: unknown
  /** ★ The agent's account state (`account` in `/health` / billing). ⚠️ An external value ⇒ checked by `ui/plan.ts` */
  account?: unknown
  /**
   * ★★ **Running ones only** (2026-08-31 / ARCHITECTURE §14.1.1.7).
   *    The agent now returns only these by default (87% of bandwidth was resending history).
   *    ⚠️ Old agents return everything, so `applyPage` in `ui/history.ts` splits them.
   */
  sessions: SessionSummary[]
  /** ★ History fetched so far. ⚠️ Empty by default (not fetched until "History" is opened) */
  history: SessionSummary[]
  /** ★ **Total** history count (the number shown on the collapsed heading). ⚠️ Differs from `history.length` */
  historyCount: number
  /** ★ History version the agent reported. ⚠️ Old agents don't report it (`null`) */
  rev: string | null
  /** ★ Version of the fetched history (meaningless while `everFetched` is false) */
  loadedRev: string | null
  /** ★★ Whether history was ever fetched. ⚠️ **Don't substitute a `null` version** (mixes with old agents) */
  everFetched: boolean
  /** ★ Pending approvals (M4-1). Present only while the hook is waiting */
  permissions: PermissionRequest[]
  /**
   * ★ Whether the pending-approval list **could be fetched**.
   *
   * ⚠️ Distinguish "0 items" from "fetch failed, unknown" (external review on 2026-08-13).
   *    Without it, a transient failure **closes notifications for live approvals**.
   */
  permissionsKnown: boolean
  /** ★ Sessions in auto-approve mode (from `/permissions`; used to mark synthetic rows) */
  autoApprove?: { id: string; until: string }[]
  error?: string
  /** Number of subagent approvals not yet shown (the agent's `/permissions` `quiet`) */
  quietPermissions?: number
  /**
   * ★★ The list used for notification cleanup (the agent's `/permissions` `pendingTags`).
   *
   * ⚠️⚠️ **Don't build it from `permissions`** (`/code-review` low #5, 2026-08-20).
   *    That one excludes **quietly waiting ones**, so for the 6 seconds an approval that had shown went back to quiet,
   *    it **closed notifications for live approvals**.
   * ⚠️ Old agents don't return it (`undefined`). Then **the cleanup decision is unchanged**.
   */
  pendingTags?: string[]
  /**
   * ★ Time that list was taken (agent clock). Used for ordering notification cleanup.
   * ⚠️ Never compare with the device clock (skew would misjudge "new notifications" as old).
   */
  permissionsAt?: string
  /** Whether SSE is alive */
  connected: boolean
  /** Count of heartbeats received. Used to check SSE isn't being buffered (docs/VERIFY.md #4) */
  beats: number
  lastEventAt?: string
}

/**
 * The screen currently open. **Destinations are interpreted only by `route.ts`** (shaped to be testable).
 *
 * ★ History is also shaped here (`syncHistory`). To make "← List" and browser back
 *   the same action, **a list is always laid one entry below a thread**. The reason is at the top of route.ts.
 */
function useRoute(): Route {
  const [hash, setHash] = useState(() => location.hash)
  useEffect(() => {
    const on = () => setHash(location.hash)
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const route = parseRoute(hash)
  // ⚠️ Depend on **the hash itself**. `kind` alone misses "thread → another thread".
  //    Even `kind + id` misses URLs that **grow history yet are interpreted as the same route**,
  //    like `#/s/A?x` → `#/s/A?y` (external review on 2026-08-16).
  //    Every new history entry must get the marker, so always run when the hash moves
  const prev = useRef<RouteKind | undefined>(undefined)
  useEffect(() => {
    syncHistory(prev.current, route.kind)
    prev.current = route.kind
  }, [hash])
  return route
}

/** ★ Initial state of an endpoint (nothing fetched yet) */
function emptyState(e: AgentEndpoint): EndpointState {
  return {
    endpoint: e,
    ...EMPTY_LIST,
    permissions: [],
    permissionsKnown: false,
    connected: false,
    beats: 0,
  }
}

function App() {
  // ★ Endpoints are **state** (step 6-④ of ③: learning a relay entrance at pairing adds one)
  const [endpoints, setEndpoints] = useState<AgentEndpoint[]>(loadEndpoints)
  /** ★ Notification state (the heading's indicator / `ui/pushState.ts`). ⚠️ Reported by the list's `PushPanel` */
  const [pushInfo, setPushInfo] = useState<PushSummary>()
  const openSettings = () => {
    location.hash = '#/agents'
  }
  // ★★ The same endpoint gets the same `Transport` (⚠️ no piling up of relay lines / transport/index.ts)
  const transports = useMemo(() => createTransports(endpoints), [endpoints])
  /** ★ Teach the relay entrance from the QR **only to the one machine that matched** */
  const rememberRelay = useCallback(
    (at: number, relay: { url: string; agentPublicKey: string }) => {
      setEndpoints((prev) => {
        const next = rememberRelayAt(prev, at, relay)
        saveEndpoints(next)
        return next
      })
    },
    [],
  )
  /**
   * ★★ **Add an unknown endpoint** from the QR's `u` (2026-09-16 / to move to Y).
   *
   * ⚠️⚠️ **Served from a public origin, this list starts empty** (no agent on our own origin).
   * ⚠️ Called **only after registration succeeds** (guarded by `pairRun.ts`).
   * ⚠️ An existing URL isn't added (= the same agent doesn't get two rows).
   */
  const addEndpoint = useCallback(
    (e: {
      url: string
      label: string
      relay?: { url: string; agentPublicKey: string }
      /** ★ The route registration went through (⚠️ no guessing / codex round 8, medium #2) */
      kind?: 'local' | 'relay'
    }) => {
      setEndpoints((prev) => {
        // ★★ The decision is in `endpoints.ts` (⚠️ `.tsx` has no behavioral tests / codex round 8, medium #2)
        const next = upsertEndpoint(prev, e)
        if (!next) return prev
        saveEndpoints(next)
        return next
      })
    },
    [],
  )

  /**
   * ★★ **Unlinking** (2026-09-21 / user decision). Revoke → remove the endpoint.
   *
   * ★ The procedure itself is `runUnlink` in `ui/pairRun.ts` (⚠️ not assembled in `.tsx` / discipline).
   *   This only passes the materials: the pressed row's transport, this device's key, and how to forget it.
   * ⚠️⚠️ **Send only to the pressed row's endpoint** (trying all endpoints **removes other machines' registrations**).
   */
  /** ★ Just remove from the list (no revocation sent / old endpoints of the same machine with a recreated key / `staleTwins`) */
  const forgetEndpoint = useCallback((e: AgentEndpoint) => {
    setEndpoints((prev) => {
      const next = prev.filter((x) => x.id !== e.id)
      saveEndpoints(next)
      return next
    })
  }, [])

  const unlinkEndpoint = useCallback(
    async (e: AgentEndpoint) => {
      const identity = await loadIdentity(idbKeyStore())
      return await runUnlink(e.label || e.url, {
        transport: transports.find((t) => t.endpoint.id === e.id),
        myKey: identity.kind === 'ok' ? identity.publicKey : undefined,
        // ⚠️⚠️ **Really remove it from storage** (removing only screen state brings it back on reload)
        forget: () => {
          setEndpoints((prev) => {
            const next = prev.filter((x) => x.id !== e.id)
            saveEndpoints(next)
            return next
          })
        },
      })
    },
    [transports],
  )
  // ★★ **Check that there's an agent on our own origin first**, then add it as the first machine
  //   (2026-09-16 / to move to Y). ⚠️⚠️ It used to list one unconditionally, so
  //   **a "❌ no response" row always appeared on the public origin** (= looks broken / discipline 1 violation).
  //   ⚠️ The decision is the single `shouldOfferSelf` (fail-closed: not added while unknown).
  useEffect(() => {
    if (endpoints.length > 0) return
    void (async () => {
      // ⚠️ Only `endpoints.ts` knows our own origin's URL (discipline 1 / discipline.test.ts)
      const probe = await probeUrl(selfCandidate().url)
      // ⚠️ It may have been added from a QR while waiting, so **look again right before adding**
      setEndpoints((prev) => {
        if (!shouldOfferSelf(prev, probe)) return prev
        const next = [selfCandidate()]
        saveEndpoints(next)
        return next
      })
    })()
  }, [endpoints.length])
  const route = useRoute()

  const [states, setStates] = useState<Record<string, EndpointState>>(() =>
    syncEndpointStates({}, endpoints, emptyState),
  )
  // ★★ When endpoints are added, removed or changed, align the list state too (`ui/endpointStates.ts`).
  //   ⚠️⚠️ Before this, endpoints added by pairing **didn't show in the list until reopening** (hit in practice on iPhone)
  useEffect(() => {
    setStates((prev) => syncEndpointStates(prev, endpoints, emptyState))
  }, [endpoints])
  const [now, setNow] = useState(Date.now())
  const [loading, setLoading] = useState(true)
  /**
   * Whether history is open. **Collapsed by default** (rarely viewed, so it shouldn't take list space).
   *
   * ⚠️ Display settings live on the PWA side (not on the server / CLAUDE.md prohibitions).
   *    For now the same localStorage as endpoints.ts. Move them together when moving to IndexedDB.
   */
  const [showAll, setShowAll] = useState(() => {
    try {
      return localStorage.getItem(HISTORY_OPEN_KEY) === '1'
    } catch {
      return false // environments where localStorage is unavailable, e.g. private mode
    }
  })
  useEffect(() => {
    showAllRef.current = showAll
    try {
      localStorage.setItem(HISTORY_OPEN_KEY, showAll ? '1' : '0')
    } catch {
      // Failing to remember doesn't affect behavior
    }
    // ★ Fetch the moment it opens (don't leave it blank for up to 15s until the next poll)
    // ⚠️ On mount `useEffect([])` fetches, so don't fetch here (double fetch)
    const first = showAllFirst.current
    showAllFirst.current = false
    if (showAll && !first) void refreshRef.current?.()
  }, [showAll])

  /**
   * ★ Fetch generation. So that **an old response doesn't overwrite newer state** (external review on 2026-08-13).
   *
   * ⚠️ Polling, hooks, `permissions-changed` and `sessions-changed` can start refresh
   *    at the same time. If an earlier fetch returns last, **answered cards come back**, or
   *    sessions of a dropped machine go back to "responding".
   */
  const gen = useRef<Record<string, number>>({})

  /**
   * ★★ `refresh` runs with **the closure captured when it was put into the interval**, so
   *    reading `showAll` or the fetched history count **directly gives the initial values**.
   *    ⇒ Copy them into refs on every render, and `refresh` reads from the refs.
   * ⚠️ "The open thread's row is nowhere" is known only after building `rows`, so
   *    it's written there (`openMissing.current = ...` below).
   */
  const statesRef = useRef<Record<string, EndpointState>>({})
  statesRef.current = states
  const showAllRef = useRef(false)
  const openMissing = useRef(false)
  /**
   * ⚠️ Effects **also run once on mount**, so if "history open" is the state at startup,
   *    both the `showAll` effect and `useEffect([])` start fetching, fetching **61KB twice**
   *    (codex low #2, 2026-09-01). The generation number only discards old responses; **the traffic isn't stopped**.
   *    ⇒ The one on mount is left to `useEffect([])`.
   * ⚠️⚠️ **The meaning depends on effect declaration order**, so keep **a flag per effect**.
   *    The `showAll` effect is declared **before** `useEffect([])`, but the `routeKey` effect is
   *    **after** it = with a shared flag the `routeKey` side already sees `true` on the first run, and
   *    **the double fetch when opened via a direct link remains** (it actually did).
   */
  const showAllFirst = useRef(true)
  const routeFirst = useRef(true)

  const patch = (id: string, next: Partial<EndpointState>) =>
    setStates((prev) => {
      const cur = prev[id]
      if (!cur) return prev
      return { ...prev, [id]: { ...cur, ...next } }
    })

  /**
   * ★ Machines whose fetch failed don't claim "running".
   *
   * ⚠️ Previously only the error was updated and old sessions were left as-is, so
   *    even when a PC slept or stopped, **that machine's sessions showed "responding" / "awaiting approval"
   *    indefinitely** (found in the external review on 2026-08-12).
   *    They're worth reading as history, so don't remove them; **drop live and set the state to idle**
   *    (= out of "waiting for you" / "running", into history).
   *    Which machines are down is shown by the red notice at the top.
   */
  const markOffline = (id: string, error: string) =>
    setStates((prev) => {
      const cur = prev[id]
      if (!cur) return prev
      return {
        ...prev,
        [id]: {
          ...cur,
          error,
          connected: false,
          // ★ Sessions of a dropped machine move to history (the counting place moves too / ui/history.ts)
          ...markOfflineList(cur),
          // ★ Don't show pending approvals of unreachable machines (no one to answer to)
          permissions: [],
          // ⚠️ But they aren't "resolved", so don't use this as material for notification cleanup
          permissionsKnown: false,
          // ★★ Clear `quiet` too (codex review medium #2, 2026-08-18).
          //    Otherwise **a dropped machine's old `quiet` lingers**, and can hide other machines'
          //    "needs attention (handle on PC)" **indefinitely** (confusing 0 with "unknown").
          quietPermissions: 0,
        },
      }
    })

  /**
   * ★★ Refetch schedule per endpoint (2026-09-24 / `ui/pollPlan.ts`).
   * ⚠️ Kept in a ref (not something that changes per render = as state, everything would redraw every 15s)
   */
  const pollRef = useRef<Record<string, PollState>>({})

  /**
   * @param only ★ Endpoints to refetch (all if omitted). ⚠️⚠️ A signal refetches **only the machine that sent it**
   *   (originally one machine's signal queried all machines = relay volume multiplied by machine count / 2026-09-24)
   */
  const refresh = async (only?: ReadonlySet<string>) => {
    await Promise.all(
      transports.map(async (t) => {
        const id = t.endpoint.id
        if (only && !only.has(id)) return
        const startedAt = Date.now()
        const mine = (gen.current[id] ?? 0) + 1
        gen.current[id] = mine
        /** Discard results if a newer fetch has started */
        const stale = () => gen.current[id] !== mine
        try {
          // Old agents don't have pending approvals, so a failure here doesn't stop the rest.
          // ⚠️ But **don't turn a failure into "0 items"** (notification cleanup would misfire)
          /**
           * ★★ **History isn't requested by default** (ARCHITECTURE §14.1.1.7).
           *    Measured: default 466 B / `?history=1` 61,038 B.
           * ⚠️ The decision is in one place, `ui/history.ts` (don't scatter conditions across screens).
           */
          const cur = statesRef.current[id] ?? EMPTY_LIST
          const wantHistory = shouldFetchHistory({
            open: showAllRef.current,
            missingOpenSession: openMissing.current,
            state: cur,
          })
          const [health, page, perms] = await Promise.all([
            t.health(),
            t.listSessions({ history: wantHistory }),
            t
              .listPermissions()
              .then((r) => ({
                permissions: r.permissions,
                quiet: r.quiet,
                pendingTags: r.pendingTags,
                at: r.at,
                // ★ Auto-approve markers (used to mark synthetic rows)
                autoApprove: r.autoApprove,
                known: true,
              }))
              .catch(() => ({
                permissions: [] as PermissionRequest[],
                quiet: 0,
                pendingTags: undefined as string[] | undefined,
                at: undefined as string | undefined,
                autoApprove: undefined as { id: string; until: string }[] | undefined,
                known: false,
              })),
          ])
          if (stale()) return
          // ⚠️ Folding is a pure function (`applyPage`). **Pass whether it was requested**
          //    (guessing from the row count can't distinguish a "correct 0 items")
          const list = applyPage(page, {
            requestedHistory: wantHistory,
            prev: statesRef.current[id] ?? EMPTY_LIST,
          })
          patch(t.endpoint.id, {
            machine: health.machine,
            // ★ Per-endpoint support (so buttons for missing endpoints aren't shown while old and new are mixed)
            features: health.features,
            build: health.build,
            account: health.account,
            ...list,
            permissions: perms.permissions,
            // ★ Number of "approvals appearing in a few seconds". **Don't treat it like 0** (Thread would show false guidance)
            quietPermissions: perms.quiet,
            pendingTags: perms.pendingTags,
            permissionsAt: perms.at,
            permissionsKnown: perms.known,
            autoApprove: perms.autoApprove,
            error: undefined,
          })
          // ⚠️⚠️ If only approvals failed, don't count it as "success" (codex round 17, medium #3): the approval card would stay empty
          //    and wait 60s ⇒ back to 15s via `partial` (not counted as a failure = don't widen old agents without the endpoint to 5 min)
          pollRef.current[id] = notePoll(pollRef.current[id], true, startedAt, { partial: !perms.known })
        } catch (err) {
          if (stale()) return
          // ★ Count failures (if they continue, widen the fallback polling interval)
          pollRef.current[id] = notePoll(pollRef.current[id], false, startedAt)
          markOffline(t.endpoint.id, err instanceof Error ? err.message : String(err))
        }
      }),
    )
    setLoading(false)
  }
  /** ★ Call the latest `refresh` from effects (`useEffect([])` captures the initial closure) */
  const refreshRef = useRef<((only?: ReadonlySet<string>) => Promise<void>) | null>(null)
  refreshRef.current = refresh
  /** ★ The current endpoints (⚠️ read inside `useEffect([])` = not frozen to the list at startup) */
  const transportsRef = useRef(transports)
  transportsRef.current = transports
  /**
   * ★★ Fallback polling: refetch only endpoints whose turn has come (2026-09-24 / `ui/pollPlan.ts`).
   * 60s if the signal line is alive, 15s if dead, 30s–5min if failures continue.
   * ⚠️ User actions (refresh button, send, approve, returning to foreground) bypass the schedule (call `refresh()` directly).
   */
  const pollDue = () => {
    const now = Date.now()
    const due = new Set(
      transportsRef.current
        .filter((t) => isPollDue(pollRef.current[t.endpoint.id], t.eventsLive(), now))
        .map((t) => t.endpoint.id),
    )
    if (due.size > 0) void refreshRef.current?.(due)
  }

  useEffect(() => {
    void refresh()
    // ★★ **Stop while the screen is in the background** (2026-09-23 / warning at 91% of relay's daily limit / `visibility.ts`).
    //   ⚠️ Refetch once immediately on returning to the foreground (this fetch also re-establishes the relay line / §14.1.2.32)
    //   ★ On return refetch **everything** (`onResume`). Per tick only endpoints whose turn has come (`pollDue`)
    const stopPoll = whileVisible(pollDue, POLL_TICK_MS, globalThis.document, undefined, () => void refreshRef.current?.())
    const tick = setInterval(() => setNow(Date.now()), 30_000)

    return () => {
      stopPoll()
      clearInterval(tick)
    }
  }, [])

  /**
   * ★★ Signal subscriptions follow **the current endpoints** (2026-09-24 / `syncSubscriptions` in `ui/endpointStates.ts`).
   *   ⚠️⚠️ They used to be subscribed only for the endpoints at startup ⇒ signals from machines added by pairing never arrived.
   *   ⚠️ Refetches are called via `refreshRef` (the `refresh` at startup only covers the endpoints at startup).
   */
  const subsRef = useRef(new Map<string, { t: Transport; off: () => void }>())
  const firstSubs = useRef(true)
  useEffect(() => {
    const refresh = (only?: ReadonlySet<string>) => refreshRef.current?.(only) ?? Promise.resolve()
    const added = syncSubscriptions(subsRef.current, transports, (t) =>
      t.subscribe((event: AgentEvent) => {
        const id = t.endpoint.id
        if (event.type === 'hello') {
          patch(id, { connected: true, machine: event.machine, lastEventAt: event.at })
          // ★★ The signal line was re-established = signals during the gap were missed ⇒ **always** refetch that machine
          //   (the fallback is now 60s, so without fetching here it stays up to 60s stale / 2026-09-24)
          //   ⚠️⚠️ **Don't throttle by time** (codex round 17, medium #1): if "first fetch → approval appears → line up, hello"
          //      happens within 3s, the approval signal predates the line and never arrives, and throttling means **no approval card until the next fallback**.
          //   ★ Arriving mid-fetch is harmless (the generation `gen` discards the older result = the fetch started after the line wins).
          //      The cost is just one duplicate at startup.
          void refresh(new Set([id]))
        } else if (event.type === 'heartbeat') {
          setStates((prev) => {
            const cur = prev[id]
            if (!cur) return prev
            return { ...prev, [id]: { ...cur, connected: true, beats: event.n, lastEventAt: event.at } }
          })
        } else if (event.type === 'permissions-changed') {
          // ★ Pending approvals exist "only while waiting", so refetch as soon as they change
          void refresh(new Set([id]))
        } else if (event.type === 'hook') {
          patch(id, { lastEventAt: event.hook.at })
          void refresh(new Set([id]))
        } else if (event.type === 'sessions-changed') {
          patch(id, { lastEventAt: event.at })
          void refresh(new Set([id]))
        }
      }),
    )
    // ★★ Fetch newly added endpoints **immediately** (⚠️ waiting for hello or the next fallback leaves it empty up to 15s right after pairing).
    //   ⚠️ Those present at startup are all fetched by `useEffect([])` above, so not here (double fetch)
    if (!firstSubs.current && added.length > 0) void refresh(new Set(added))
    firstSubs.current = false
  }, [transports])
  useEffect(
    () => () => {
      for (const s of subsRef.current.values()) s.off()
      subsRef.current.clear()
    },
    [],
  )

  const all = Object.values(states)
  /**
   * ★★ Auto-approve markers (from `/permissions`; **the only source of visibility**).
   *
   * ⚠️⚠️ Relying on rows makes them vanish (codex round 2, high #1 and #2, 2026-09-07):
   *   - the moment an approval is answered, if the transcript isn't in `/sessions` yet **the synthetic row vanishes**
   *   - collapsed **cached history rows** aren't refetched, so they don't get the marker
   *   ⇒ Both mean "approvals pass, yet neither the banner nor the off button shows".
   * ⚠️ Always carry `machine` and `endpointId` (when **the same `sessionId` exists on two machines**,
   *    one's "on" attaches to the other's row and off **goes to another machine** / same review, medium #3).
   */
  const autoApproveMarks = all.flatMap((s) =>
    (s.autoApprove ?? []).map((a) => ({
      sessionId: a.id,
      until: a.until,
      machine: s.machine,
      endpointId: s.endpoint.id,
    })),
  )
  // ★ Running ones + fetched history. ⚠️ Don't show rows revived by `--resume` twice
  //   (folding is `combineRows` in `ui/history.ts`)
  // ★★ Auto-approve markers are overlaid **only once, here** (a row is created if absent / `applyAutoApprove`)
  const merged = applyAutoApprove(all.flatMap((s) => combineRows(s)), autoApproveMarks)
  /** ★ **Total** history count. ⚠️ While collapsed `groups.history.length` is 0, so show this instead */
  const historyTotal = all.reduce((n, s) => n + s.historyCount, 0)
  const errors = all.filter((s) => s.error)

  // ★ Not split by machine. Split into "waiting for you" → "running" → "history", ordered by state priority.
  //   Splitting by machine always pushes the second machine down, and its pending approvals go unnoticed (web/src/ui/order.ts)
  // ★ Pending approvals from all machines are mixed at the very top. Never bury any PC's
  const pendingPerms = all.flatMap((s) =>
    s.permissions.map((p) => ({ ...p, endpointId: s.endpoint.id })),
  )

  // ★ Remove notifications for approvals no longer pending (timeout / answered first on the PC).
  //
  // ⚠️ Notifications don't disappear once shown, so answered ones linger. **Lingering notifications
  //    hold the URL from when they were created**, so even after a fix only the old taps stay broken
  //    (2026-08-13: tapping an old notification already answered on the PC showed sw.js source).
  // ⚠️ Approvals of disconnected machines aren't "gone" but "unknown", so
  //    those machines aren't cleaned up (decide only with connected ones).
  useEffect(() => {
    // ★ Only machines whose state we know for sure (list fetch succeeded)
    const known = all.filter((s) => s.permissionsKnown && s.machine)
    if (known.length === 0) return
    // ★★ Use the superset (`pendingTags`) if present. Only agents without it (old versions) use the old way
    const active = new Set(
      known.flatMap((s) => s.pendingTags ?? s.permissions.map((p) => permissionTag(p.machine, p.key))),
    )
    // ★★ Machine name → time its list was taken (agent clock).
    //    ⚠️ Agents without a time (old versions) **aren't cleaned up** (ordering can't be guaranteed).
    const snapshotAt = new Map<string, number>()
    for (const s of known) {
      const at = s.permissionsAt ? Date.parse(s.permissionsAt) : Number.NaN
      if (s.machine && !Number.isNaN(at)) snapshotAt.set(s.machine, at)
    }
    void closeStalePermissionNotifications(active, snapshotAt)
  }, [
    all
      .map(
        (s) =>
          `${s.permissionsKnown ? 1 : 0}:${s.machine ?? ''}:${(s.pendingTags ?? s.permissions.map((p) => p.key)).join(',')}`,
      )
      .join('|'),
  ])

  const answerPermission = async (
    endpointId: string,
    key: string,
    behavior: 'allow' | 'deny',
    answers?: Record<string, string[]>,
    feedback?: string,
  ): Promise<{ ok: boolean; reason?: string }> => {
    const tr = transports.find((x) => x.endpoint.id === endpointId)
    if (!tr) return { ok: false, reason: t('接続先が見つかりません', 'Connection not found') }
    const res = await tr.answerPermission(key, behavior, answers, feedback)
    void refresh(new Set([endpointId]))
    return res
  }

  /**
   * ★ Synthesize list rows from approvals that don't have a transcript yet (assembled in `order.ts`).
   *
   * ⚠️ If the first turn hits an approval, the JSONL isn't created yet and `/sessions` has no row
   *    (pointed out in the external review on 2026-08-13). The list only draws rows from sessions, so
   *    **missing the Push means the PWA can't reach the approval**.
   * ⚠️ **Use the same function as the banner's second line** (written separately, one of them misses this row / low #1).
   */
  const syntheticRows = synthesizeRows(pendingPerms, merged)

  /**
   * ★ Input for the banner's second line. **Assembled by a pure function in `alerts.ts`** (codex review low #2, 2026-08-18).
   *   Put here (`.tsx`) it can't be checked mechanically, and 3 mistakes actually passed green.
   */
  const sources = all.map((s) => ({
    endpointId: s.endpoint.id,
    // ⚠️ The banner's second line looks at **the same set of rows as the list** (separately, one of them misses rows /
    //    codex low #1, 2026-08-18). ⇒ Pass `combineRows` including fetched history
    sessions: combineRows(s),
    permissions: s.permissions,
    permissionsKnown: s.permissionsKnown,
    quietPermissions: s.quietPermissions,
  }))

  /**
   * ★ Marker for arriving from the banner's second line **gray** item. So the grace period isn't applied again at the destination
   *   (`/code-review` low #3, 2026-08-18. Gray shows after waiting 6 seconds over there).
   *
   * ⚠️ Clear it when leaving that session. Otherwise, later entering the same session **from the list**
   *    would also skip the grace period (= the 2026-08-14 lie comes back).
   */
  const confirmedWait = useRef<ConfirmedWait | null>(null)
  const routeKey = `${route.kind}:${route.kind === 'session' ? route.id : ''}`
  useEffect(() => {
    if (route.kind !== 'session' || route.id !== confirmedWait.current?.sessionId) {
      confirmedWait.current = null
    }
    // ★ Refetch when opening a thread without a row (a history session opened from a notification)
    // ⚠️ On mount (opened via direct link) `useEffect([])` fetches, so not here
    const first = routeFirst.current
    routeFirst.current = false
    if (openMissing.current && !first) void refreshRef.current?.()
  }, [routeKey])

  const rows = [...merged, ...syntheticRows]
  /**
   * ★★ The open thread's row is nowhere (a history session opened from a notification / reload).
   *    ⚠️ Without fetching it becomes **a thread with no title or state**. The decision is `shouldFetchHistory`.
   */
  openMissing.current =
    route.kind === 'session' && !rows.some((r) => r.sessionId === route.id)
  const groups = groupSessions(rows)
  // ⚠️ **Count synthetic rows too** (codex review low #1, 2026-08-18). Without them, when the second machine
  //    has only "approval on the first turn", it looks like one machine and **which PC is unclear**
  const showMachine = showMachineFor(rows)

  if (route.kind === 'endpoints') {
    return (
      <Endpoints
          transports={transports}
          onBack={goList}
          rememberRelay={rememberRelay}
          addEndpoint={addEndpoint}
          endpoints={endpoints}
          unlink={unlinkEndpoint}
          forget={forgetEndpoint}
          accounts={Object.values(states).map((s) => ({ name: s.machine ?? s.endpoint.label, account: s.account }))}
        />
    )
  }

  if (route.kind === 'session') {
    const openSessionId = route.id
    // Pick the agent that owns the session (the mesh is symmetric, so there may be several / §7.2)
    // ⚠️⚠️ **The decision is `pickOwner` in `ui/history.ts`** (written in `.tsx` it can't be checked mechanically).
    //    Two stages: search live across all endpoints, then fall back to history (reasons in the comment there).
    const owner = pickOwner(all, openSessionId)
    // ★ Sessions without a transcript yet (synthetic rows) aren't in `sessions`, so
    //   use **the endpoint the approval card came from** (approval answers have long been sent by endpointId)
    const permEndpoint = pendingPerms.find((p) => p.sessionId === openSessionId)?.endpointId
    /**
     * ★ The last resort: an endpoint that **only has an auto-approve marker** (codex round 2, 2026-09-07).
     * ⚠️ For a session whose approval was answered and whose transcript doesn't exist yet, this is the only clue.
     *    Without it **there's nowhere to send off** (= approvals pass and it can't be turned off).
     */
    const autoEndpoint = autoApproveMarks.find((m) => m.sessionId === openSessionId)?.endpointId
    const transport =
      transports.find(
        (t) => t.endpoint.id === (owner?.endpoint.id ?? permEndpoint ?? autoEndpoint),
      ) ?? transports[0]!
    // ⚠️ The row shown uses **the same priority** as `pickOwner` (live first). Written separately,
    //    it becomes "the owner is B but the row shown is A's old history"
    const real = pickRow(all, openSessionId)
    /**
     * ★ The row used for display. **Includes synthetic rows** (codex review medium #1, 2026-08-18).
     *   Without them, a row shown in the list as "awaiting approval · Bash" / "needs attention"
     *   becomes **the first 8 chars of the ID with no state** in the thread, a mismatch.
     */
    /**
     * ★★ The row shown. **Markers are overlaid by `applyAutoApprove`** (independent of where the row came from).
     * ⚠️ Even with no row anywhere, a marker **creates the whole row** (= the off button always shows).
     */
    const base = real ?? syntheticRows.find((x) => x.sessionId === openSessionId)
    const session = applyAutoApprove(
      base ? [base] : [],
      autoApproveMarks.filter((m) => m.sessionId === openSessionId),
    )[0]
    /**
     * ★ Items waiting in **other threads** (orange = answerable approvals / gray = signals to go back to the PC).
     *   Rows for working through accumulated approvals without returning to the list (user request, 2026-08-18).
     */
    const alert = nextAlert(buildAlertInput(sources, openSessionId))
    /**
     * ★ The endpoint that owns this thread. `permissionsKnown` and `quiet` come from here.
     * ⚠️⚠️ **Don't sum `quiet` across machines** (codex review medium #2, 2026-08-18).
     *    Another machine's "approval appearing in a few seconds" would hide this thread's explanation.
     */
    const ownerState = owner ?? all.find((s) => s.endpoint.id === (permEndpoint ?? autoEndpoint))
    return (
      <Thread
        /**
         * ★★ **Rebuilt per destination** (codex round 8, high #1, 2026-08-25).
         *
         * ⚠️⚠️ Without `key`, switching sessions **reuses the same component**.
         *    As a result, **async work started before switching finishes and breaks the screen after switching**:
         *      - A's send completion clears B's notice (`note`)
         *      - A's text shows up as **B's optimistic row** (`setPending`)
         *      - `Composer`'s `setText('')` **empties B's input box and even deletes the saved draft**
         *      - A's completion clears B's "running" (`stopping` / `running`)
         *    ⚠️ I **patched these one by one over 3 rounds** (confirm dialog, notice, running).
         *      With `key` **the whole component is rebuilt**, so this kind of hole disappears structurally
         *      (no one sees `setState` from the unmounted side).
         * ⚠️ Cost: going back and forth **loses the optimistic row (the provisional row right after sending)**.
         *    ⇒ It shows up once recorded, so trading it for the holes above was judged better.
         */
        key={`${transport.endpoint.id}:${openSessionId}`}
        transport={transport}
        sessionId={openSessionId}
        session={session}
        /**
         * ★★ Whether sending is allowed is **passed separately**. Having a `session` doesn't mean it can be sent to.
         *
         * ⚠️ A synthetic row is "a provisional row built from an approval card", so it isn't in `/sessions` yet.
         *    Deciding by `session` **opens the input box on synthetic rows** (sending without certainty
         *    about the destination / the same hole as the external review high on 2026-08-14).
         */
        canSend={real !== undefined && real.live}
        /**
         * ★ Whether we **know for sure** the pending approvals of the machine owning that session.
         * ⚠️ **false** when the owner is unknown (synthetic rows, fetch failures) (don't let it assert)
         */
        permissionsKnown={ownerState?.permissionsKnown ?? false}
        alert={alert}
        onJump={(id) => {
          // ★ Only when jumping from gray, carry "the grace period has already been applied" (orange has an approval card, so it's unrelated)
          // ⚠️ Carry the time too. **The marker is valid only right after pressing** (`isConfirmedWait` / medium #1)
          confirmedWait.current =
            alert?.kind === 'attention' ? { sessionId: id, at: Date.now() } : null
          goSession(id)
        }}
        waitConfirmed={isConfirmedWait(confirmedWait.current, openSessionId, Date.now())}
        permissions={pendingPerms.filter((p) => p.sessionId === openSessionId)}
        quietPermissions={ownerState?.quietPermissions ?? 0}
        /* ★ Features the agent has (absent = old agent ⇒ don't show buttons) */
        features={ownerState?.features}
        onAnswer={answerPermission}
        onBack={goList}
      />
    )
  }

  return (
    <>
      <header class="top">
        <h1>nyan-remote</h1>
        <span class="grow" />
        <span class="meta">
          {/* ★ 2026-09-24: removed "SSE ♥ N" (relay doesn't carry heartbeats, so it was always 0 = showed nothing meaningful) */}
          {t(`${merged.length} セッション`, `${merged.length} sessions`)}
        </span>
        <button class="plain" onClick={() => void refresh()}>
          {t('更新', 'Refresh')}
        </button>
        {/* ★★ "Connections" → "Settings" (2026-09-24 / connections, notifications, display, version and diagnostics live here).
            ⚠️ The URL (#/agents) stays (don't break bookmarks or links opened from notifications).
            ★ Notification state is just the small indicator beside it (nothing on the list when normal / `ui/pushState.ts`) */}
        <button
          class="plain"
          title={t('設定（接続先・通知・表示）', 'Settings (connections, notifications, display)')}
          onClick={openSettings}
        >
          {t('⚙ 設定', '⚙ Settings')}
          {pushInfo && pushBadge(pushInfo.kind, pushInfo.registered, pushInfo.total) ? (
            <span class="pushbadge"> {pushBadge(pushInfo.kind, pushInfo.registered, pushInfo.total)}</span>
          ) : null}
        </button>
      </header>

      {errors.map((s) => (
        <p key={s.endpoint.id} class="notice bad">
          {s.endpoint.label}: {s.error}
        </p>
      ))}

      {/* ★★ On the list, a one-line banner "only when there's trouble" (nothing when normal / `ui/pushState.ts`).
          ⚠️ The component stays mounted (subscription sync runs on the list too) */}
      <PushPanel transports={transports} mode="list" onOpenSettings={openSettings} onSummary={setPushInfo} />

      {/* ★★ Update notice (app is old ⇒ reload / machine is old ⇒ nyan update on that PC / `ui/updates.ts`) */}
      <UpdateBanner machines={all.map((s) => ({ name: s.machine ?? s.endpoint.label, build: s.build }))} />

      {loading && merged.length === 0 ? <p class="notice">{t('読み込み中…', 'Loading…')}</p> : null}

      {/* ⚠️ While history is collapsed `merged` can be 0 (also look at `historyTotal`) */}
      {!loading && merged.length === 0 && historyTotal === 0 && errors.length === 0 ? (
        <p class="notice">
          {t('セッションが見つかりません。', 'No sessions found. Check ')}
          <code>~/.claude*/projects</code>
          {t(' を確認してください。', '.')}
        </p>
      ) : null}

      {groups.attention.length > 0 ? (
        <section class="group">
          <h2>{t(`あなた待ち ${groups.attention.length}`, `Waiting for you ${groups.attention.length}`)}</h2>
          <SessionList sessions={groups.attention} now={now} showMachine={showMachine} />
        </section>
      ) : null}

      {groups.running.length > 0 ? (
        <section class="group">
          <h2>{t(`動作中 ${groups.running.length}`, `Running ${groups.running.length}`)}</h2>
          <SessionList sessions={groups.running} now={now} showMachine={showMachine} />
        </section>
      ) : null}

      {/* ★ History is collapsed by default (user decision, 2026-08-13).
          "Waiting for you" and "Running" are the stars of the list; history is **rarely viewed**.
          The intermediate state showing only 20 items was meaningless (and "all" vs "collapse"
          being label variants of one button was confusing), so
          it became two states: **collapsed = all hidden / open = everything**. Open/closed is remembered in localStorage. */}
      {historyTotal > 0 || groups.history.length > 0 ? (
        <section class="group">
          <h2>
            <button class="disclose" onClick={() => setShowAll(!showAll)} aria-expanded={showAll}>
              {/* ★ While collapsed there are no rows, so show the **total** the agent reported */}
              {showAll ? '▾' : '▸'}{' '}
              {t(
                `履歴 ${Math.max(historyTotal, groups.history.length)}`,
                `History ${Math.max(historyTotal, groups.history.length)}`,
              )}
            </button>
          </h2>
          {showAll && groups.history.length === 0 && historyTotal > 0 ? (
            <p class="notice">{t('読み込み中…', 'Loading…')}</p>
          ) : null}
          {showAll ? (
            <SessionList sessions={groups.history} now={now} showMachine={showMachine} />
          ) : null}
        </section>
      ) : null}

      {/* ★ 2026-09-24: removed the machine list at the bottom (connected (♥0) · last event) (user decision).
          ⚠️ Down machines show in the red banner at the top (`errors`); per-machine state is under "⚙ Settings" → connections */}
    </>
  )
}

const root = document.getElementById('app')
if (root) render(<App />, root)

// The Service Worker is registered for add-to-home-screen and (from M1) Push reception
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' })
  })
}
