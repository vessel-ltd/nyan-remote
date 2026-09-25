import type { VNode } from 'preact'
import { subscribeWhileVisible, whileVisible } from '../visibility.ts'
import { coalesce, followPlan, shouldPull } from './followPlan.ts'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import type {
  AgentFeature,
  AutoApproveDuration,
  AutoApproveResult,
  CommandId,
  LogEntry,
  PermissionRequest,
  SessionSummary,
} from '../../../shared/types.ts'
import { hhmm } from '../time.ts'
import { t } from '../../../shared/i18n.ts'
import type { Transport } from '../transport/index.ts'
import { renderMarkdown } from './markdown.tsx'
import { Composer } from './Composer.tsx'
import { followAction } from './follow.ts'
import { alreadyInTranscript, type InflightMessage } from '../../../shared/types.ts'
import { formatTokens } from './tokens.ts'
import { beginSend, consumeAfterReload, finishSend, noteArrivals, type PendingSend } from './pending.ts'
import { Permissions } from './Permissions.tsx'
import { neutralizedNote, sendMark } from './sendMark.ts'
import {
  COMMAND_UI,
  type KeyedConfirmKind,
  commandView,
  confirmNote,
  confirmTitle,
  releaseRunning,
  autoApproveLongLabel,
  type CommandTarget,
  type ConfirmKind,
} from './commands.ts'
import { Confirm } from './Confirm.tsx'
import { autoApproveBanner, autoApproveError, autoApproveOnText, autoApproveView } from './autoApprove.ts'
import { stopSentNote, stopView } from './stop.ts'
import { anchoredScrollY, firstVisibleIndex, isMine, keepLoading, pickPrevMine, showMineJump } from './scrollback.ts'
import { ThreadBar, type ThreadBarAction } from './ThreadBar.tsx'
import type { ThreadAlert } from './alerts.ts'
import { armStale, showStale, type StaleGate } from './staleNotice.ts'
import { composerBusy, explainWait } from './status.ts'
import { addedKeys, boundaryVisible, needsPermSignal, permArea, signalTarget } from './scroll.ts'
import { accountLabel } from './agentText.ts'

const PAGE = 60
/** Beyond this distance from the bottom, show "to bottom" and stop auto-scrolling */
const BOTTOM_SLACK = 200
/** Characters shown when collapsed */
const FOLD_CHARS = 120
/** A send not appearing in the transcript after this becomes "cannot confirm" */
const UNSURE_MS = 30_000

export function Thread({
  transport,
  sessionId,
  session,
  canSend = false,
  permissions,
  quietPermissions = 0,
  features,
  permissionsKnown = false,
  alert,
  onJump,
  waitConfirmed,
  onAnswer,
  onBack,
}: {
  transport: Transport
  sessionId: string
  session?: SessionSummary
  /**
   * ★ Whether sending is allowed (whether the destination agent is settled).
   * ⚠️ Not decided by the presence of `session`. **Even synthetic rows (provisional rows built from marks) have `session`**
   */
  canSend?: boolean
  /**
   * ★ Whether we **definitely know** that machine's pending approvals (whether `/permissions` was fetched).
   * ⚠️ Defaults to `false` (err towards not knowing), so we never say "cannot be answered" without knowing
   */
  permissionsKnown?: boolean
  /**
   * ★ This session's pending approvals. Shown **at the bottom of the thread** (same as Claude's Android app).
   *   The list only tells you "approval pending"; you answer after going in.
   */
  permissions: (PermissionRequest & { endpointId: string })[]
  /**
   * ★ The number of "approvals that will appear in a few seconds" (from subagents / the agent's `quiet`).
   * ⚠️ Without this, during the quiet 6-second wait we would show the **lie**
   *    "This cannot be answered from the phone. Please answer on the PC".
   */
  quietPermissions?: number
  /**
   * ★★ The features that agent has (`/health` `features`).
   *
   * ⚠️⚠️ **Adding an endpoint alone does not allow showing the button** (while machines are updated one by one,
   *    agents without the endpoint would show a button that 404s / 2026-08-25 codex round 7, medium #3).
   * ⚠️ When unknown, **do not show** (fail-closed).
   */
  features?: AgentFeature[]
  onAnswer: (
    endpointId: string,
    key: string,
    behavior: 'allow' | 'deny',
    /** ★ Labels selected in an approval with options (`AskUserQuestion`). question text → labels */
    answers?: Record<string, string[]>,
    /** ★ "Please change it like this" attached to a denial */
    feedback?: string,
  ) => Promise<{ ok: boolean; reason?: string }>
  /**
   * ★ What is waiting in **another thread** (just one / `alerts.ts`).
   *   While inside a thread the list is not visible, so it is announced here.
   * ⚠️ This thread's own approvals are not included (that is the job of the `Approval N ↓` below)
   * ⚠️⚠️ **Not optional** (no `?`). If it could be omitted, dropping it at the call site would
   *    type-check and **another thread's approvals would silently stop showing** (same type as 2026-08-18 codex medium #4)
   */
  alert: ThreadAlert | null
  /** Navigation when the upper line is pressed */
  onJump: (sessionId: string) => void
  /**
   * ★ Whether we **jumped here from the bar's second line (grey)**.
   *
   * ⚠️ The grey line waited out a 6-second grace period over there before showing. Waiting again here means
   *    **the person who pressed it sees a screen with no reason for 6–9 seconds** (`/code-review`, low #3).
   * ⚠️ **Not optional** (do not allow a shape where forgetting to pass it type-checks)
   */
  waitConfirmed: boolean
  onBack: () => void
}) {
  const [entries, setEntries] = useState<LogEntry[]>([])
  /**
   * ★★ **Text not yet written to the transcript** (2026-08-21).
   *
   * The CLI stops flushing to the transcript "while waiting for a human answer", so
   * **the explanation just before an approval card was structurally always missing** (measured: 0 bytes for 93 seconds).
   * The agent returns what the `MessageDisplay` hook intercepted.
   * ⚠️ Without the hook, `undefined` (it just falls back to the previous display).
   */
  const [inflight, setInflight] = useState<InflightMessage | undefined>(undefined)
  const [cursor, setCursor] = useState<number | null>(null)
  const [error, setError] = useState<string>()
  /**
   * ★ The result of an action (send / stop).
   *
   * ⚠️⚠️ **Shown next to the input box** (`Composer`'s `note`). It used to be at the top of the thread, so
   *    on real devices **it was never once seen** (2026-08-24 user report).
   */
  const [note, setNote] = useState<{ bad: boolean; text: string }>()
  const [stopping, setStopping] = useState(false)
  /**
   * ★★ Table commands (`/compact` / `/exit`).
   *
   * ⚠️⚠️ The dialog shows only while `confirm` is set (**confirmation is the screen's responsibility**.
   *    The agent cannot confirm, so it must not be built to run the instant it is pressed).
   * ⚠️ `running` prevents double taps (the last line of defence is the agent's 1.5 seconds).
   */
  const [confirm, setConfirm] = useState<CommandTarget>()
  /** ★ The running mark. ⚠️ **Carries a `token` (per run)** (so an old run does not clear a newer mark)*/
  const [running, setRunning] = useState<CommandTarget & { token: number }>()
  /** ⚠️ Serial number per run (`useRef`, so it does not reset on render)*/
  const runToken = useRef(0)
  const [loading, setLoading] = useState(true)
  const [showThinking, setShowThinking] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  /** ★ A message of yours is above the view (for when "↑ My message" is shown / `showMineJump`) */
  const [hasPrevMine, setHasPrevMine] = useState(false)
  // ★★ -1 means "not loaded yet". **Never use 0 as the sentinel** (see below)
  const tailRef = useRef(-1)
  /**
   * ★★ Generation (increments when the session or endpoint changes). **Checked when a response arrives**.
   *
   * ⚠️ `cancelled` alone is not enough. Follow-ups fired inside `setInterval` do not pass through the effect's
   *    cleanup, so **responses arriving after a switch got mixed into another thread**
   *    (2026-08-20 codex review, medium #3). The decision is in `follow.ts` and tested.
   */
  const genRef = useRef(0)
  // ★ The guard against overlapping follow-ups moved to `coalesce` in `followPlan.ts` (a signal during a run triggers one later run)
  /** ★ The initial load (only while running). Follow-up fetches wait for it (no double reads / codex round 16, medium #3) */
  const firstLoadRef = useRef<Promise<void>>()
  /** Prevents double-starting the scrollback read (rapid taps would prepend the same page twice) */
  const olderRef = useRef(false)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  /**
   * ★★ The boundary between "end of the log" and "start of the approval cards" (2026-08-19 user report).
   *
   * ⚠️⚠️ Approval cards are tall (3 questions + a diagram is **2–3 screens**). Jumping to the bottom
   *    lands **at the bottom edge of the cards**, so **the text written right before the question is off screen**,
   *    and it looked like "the text is not displayed" (in fact both the API and the screen had it).
   *    ⇒ With cards, put **this boundary at the centre of the screen**.
   *    The top half shows the end of the text, the bottom half the start of the question.
   * ⚠️ When the cards are short the browser clamps at the edge, so it looks the same as before.
   * ⚠️ **Keep "pressing makes the cards appear on screen"** (behaviour measured on the transition from the bar's second line).
   */
  const permTopRef = useRef<HTMLDivElement | null>(null)
  /** ★ The approval cards themselves (the signal decision measures this, not the page end) */
  const permsRef = useRef<HTMLDivElement | null>(null)
  /** ★ The margin for the permanent input box (measured to compute the "visible range" at the bottom) */
  const padRef = useRef<HTMLDivElement | null>(null)
  /**
   * ★★ Measured values (measured after commit and put in state / 2026-08-19 codex round 3, medium #4).
   *
   * ⚠️⚠️ Reading `getBoundingClientRect()` during render gives **the previous layout's values**.
   *    Also, **when the cards grow or shrink** ("Show full text" pressed, diagrams added)
   *    no scroll happens, so nothing re-rendered and the signal stayed stale.
   *    ⇒ Measure in `useLayoutEffect`, and re-measure on `ResizeObserver` (**`border-box`**) and
   *    `scroll` / `resize`. ★ Same shape as the `--bar-h` lesson (CLAUDE.md §5).
   */
  const [permBox, setPermBox] = useState<{ top: number; bottom: number } | null>(null)
  const [usable, setUsable] = useState<{ top: number; bottom: number }>({ top: 0, bottom: 0 })
  // ⚠️ The initial-load effect does not depend on `permissions` (that would trigger a re-fetch).
  //    To see the latest value then, it is mirrored into a ref
  const permissionsRef = useRef(permissions)
  permissionsRef.current = permissions
  /**
   * ★★ Decide "are you looking around the approvals" **by position** (2026-08-19 `/code-review`, medium #1).
   *
   * ⚠️⚠️ It used to decide by `atBottomRef` (are you at the bottom), but **it becomes false the moment
   *    we ourselves scroll to the boundary** (the `scroll` listener catches our own scrolls too).
   *    As a result **the second and later approval cards stopped appearing on screen**
   *    = "it stops if unnoticed" (CLAUDE.md).
   * ⇒ Hold no flag; decide by **whether the boundary itself is on screen**.
   *
   * ⚠️⚠️ At first it checked "does it overlap the card area (boundary to bottom)", but
   *    **that is also true for someone reading inside a card (the boundary is above the screen)**, so
   *    the moment the next card arrived it **yanked them back several screens**
   *    (2026-08-19 codex review, medium #1. Measuring 0 movement was because only the single condition
   *    "the boundary is exactly centred" was checked = **a wrong generalisation**).
   * ⚠️ This effect runs **after** the cards are drawn, but new cards are added below, so
   *    the boundary does not move (= usable as "the position before they appeared").
   */
  const boundaryOnScreen = (): boolean =>
    boundaryVisible(permTopRef.current?.getBoundingClientRect().top, window.innerHeight)

  /** To the boundary if there are cards, otherwise to the bottom */
  const settleView = (behavior?: ScrollBehavior): void => {
    const el = permissionsRef.current.length > 0 ? permTopRef.current : bottomRef.current
    el?.scrollIntoView(
      permissionsRef.current.length > 0
        ? { block: 'center', ...(behavior ? { behavior } : {}) }
        : behavior
          ? { behavior }
          : undefined,
    )
  }
  /** Target of "↑ To top" (to get back to the details or "read older" in a long thread) */
  const topRef = useRef<HTMLDivElement | null>(null)
  /** ★ The thread body (to find your own messages / `jumpToPrevMine`) */
  const threadRef = useRef<HTMLDivElement | null>(null)
  /**
   * ★ The position right before loading more above (2026-09-24). ⚠️⚠️ Remembered by **the element in view** (codex round 19, medium #2):
   *   aligning by the difference in total page height also counts **growth below** in the same render (follow-ups, approval cards) and overshoots.
   *   `idx` is the position among `.thread`'s children (the first visible element); `added` is the number of elements added above.
   */
  const anchorRef = useRef<{ entry: LogEntry | undefined; top: number; scrollY: number; height: number } | null>(null)
  /**
   * ★ The `visible` currently drawn (to look up "which message was in view" when aligning / codex round 20, medium #6).
   * ⚠️ Do not add up positions (indexes): toggling the "thinking" display mid-load made the counted and drawn numbers disagree, and
   *    **it aligned to a different message**. ⇒ Remember the message (object) itself, and look up its position again after drawing.
   */
  const visibleRef = useRef<LogEntry[]>([])
  /** ★ Loading more via "↑ My message" is in progress */
  const [seeking, setSeeking] = useState(false)
  /**
   * Whether the previous scroll was at the bottom.
   *
   * ⚠️ Why a ref rather than state: **measuring right after approval cards are added is too late**.
   *    `scrollHeight` has grown by the cards, so it judges "not at the bottom", and
   *    the person who should see them cannot. We must remember **the position before the cards appear**.
   */
  const atBottomRef = useRef(true)
  /**
   * ★ Instructions just sent that have not yet appeared in the thread (optimistic display / M4-2).
   *
   * ⚠️ The inbox returns no reply, so "delivered" is only confirmed once `queue-operation`
   *    appears in the transcript (ARCHITECTURE §9.7.1). Polling is every 3 seconds, so
   *    until then **nothing on screen reads as "not sent"**.
   */
  const [pending, setPending] = useState<PendingSend[]>([])
  /**
   * ★ A buffer of elements that arrived via polling (last 100).
   * ⚠️ Needed to match what arrived while awaiting the send reply **before stacking** (pending.ts)
   */
  /** ★ Records already used for matching (⚠️ on a full reload, the same record must not clear another send / pending.ts) */
  const usedRef = useRef(new Set<string>())
  /** ★ A number per send (to find which one a reply confirms) */
  const sendSeq = useRef(0)

  /** A clock only for switching the optimistic text (updated naturally by the 3-second follow-up) */
  const [now, setNow] = useState(Date.now())

  /**
   * ★★ Grace period so that "Please answer on the PC" is **not shown immediately**.
   *
   * ⚠️ The lie seen on a real device on 2026-08-14: right after tapping an approval on the phone, the mark disappears but
   *    the list state (`waiting`) remains until the next re-fetch. In that gap
   *    **"This cannot be answered from the phone. Please answer on the PC" showed for 4–5 seconds**
   *    — right after answering it on the phone yourself.
   *    The agent also drops the label now, but the re-fetch round trip always remains, so
   *    **the screen waits a few seconds too** (fix both; with only one side it recurs depending on device and SSE state).
   */
  const staleGate = useRef<StaleGate>({ key: '', since: null })
  /** ★ Grace period for the bar's second line (grey). **Reset per target**, so held separately */
  const alertGate = useRef<StaleGate>({ key: '', since: null })
  /**
   * ★ "No answerable mark" and "state is waiting for approval".
   *
   * ⚠️⚠️ **Do not decide when the marks' state is unknown** (2026-08-18 codex review, medium #3).
   *    A machine whose `/permissions` fetch failed is not "0" but **unknown** (`main.tsx`).
   *    Treating it as 0 means **saying "cannot be answered" while a live mark exists**
   *    (passing what could not be read with a default = fail-open / CLAUDE.md).
   */
  const noAnswerable =
    permissionsKnown && permissions.length === 0 && quietPermissions === 0 && session?.status === 'waiting'
  // ⚠️ The key **includes the endpoint too** (re-reading the same sessionId from another machine is a different matter)
  staleGate.current = armStale(
    staleGate.current,
    `${sessionId}/${transport.endpoint.id}`,
    noAnswerable,
    Date.now(),
  )
  // ★ The decision is in staleNotice.ts (pinned by tests, including **always showing once the grace period ends**)
  const showNoAnswerable = showStale(noAnswerable, staleGate.current, now, waitConfirmed)

  /**
   * ★★ Apply the same grace period to the bar's second line **grey** (handle on PC) too (2026-08-18 `/code-review`, medium #1).
   *
   * ⚠️ Right after answering the last approval on the phone, the mark disappears but **that session's `waiting`
   *    remains until the next re-fetch**. Without a grace period, while looking at another thread
   *    **"Needs you 1 · session B … Handle on PC"** appears — right after answering it yourself.
   *    And the bar has nothing to contradict it (the same shape of lie as 2026-08-14).
   * ⚠️ Not applied to orange (answerable approvals). **There the mark's existence is itself the evidence**, so
   *    delaying it only delays noticing.
   */
  const greyPending = alert?.kind === 'attention'
  // ⚠️ The key is **only the destination** (including the count would restart the grace period every time
  //    another session's count changes, and **a shown line would vanish**)
  alertGate.current = armStale(
    alertGate.current,
    greyPending ? alert.sessionId : '',
    greyPending,
    Date.now(),
  )
  const barAlert = greyPending && !showStale(true, alertGate.current, now, false) ? null : alert
  /**
   * ★ If waiting on a dialog **other than** an approval, change the explanation of the cause (2026-08-18).
   * ⚠️ Those never reach the approval hook, so "the return path was lost" would be a lie (see status.ts)
   */
  // ⚠️ Pass `lastEvent` too. **An approval whose mark died** is not being waited on by the CLI, so there is no `waitingFor`,
  //    and without it we would say "we don't know what it is waiting for" (see status.ts)
  const wait = explainWait(session?.waitingFor, session?.lastEvent)

  const jumpToBottom = () => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })

  /**
   * ★ Measure the actually visible range and the cards' position.
   *
   * ⚠️ The top is the bottom edge of the **sticky bar** (`--bar-h`, measured and distributed by the bar. CLAUDE.md §5 "measure in one place and distribute").
   *    The bottom is the top edge of the **permanent input box** (approximated by `.composerpad`'s height).
   * ⚠️ When values have not changed, do not update state (to avoid re-rendering forever on every commit).
   */
  const measure = (): void => {
    const barH = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--bar-h'),
    )
    const padH = padRef.current?.getBoundingClientRect().height ?? 0
    const next = {
      top: Number.isFinite(barH) ? barH : 0,
      bottom: window.innerHeight - padH,
    }
    setUsable((prev) =>
      Math.abs(prev.top - next.top) < 0.5 && Math.abs(prev.bottom - next.bottom) < 0.5 ? prev : next,
    )
    const el = permsRef.current
    const box = el && permissionsRef.current.length > 0 ? el.getBoundingClientRect() : null
    setPermBox((prev) => {
      if (box === null) return prev === null ? prev : null
      if (prev && Math.abs(prev.top - box.top) < 0.5 && Math.abs(prev.bottom - box.bottom) < 0.5) {
        return prev
      }
      return { top: box.top, bottom: box.bottom }
    })
  }

  // ★ Measure after every commit (values during render are the previous layout)
  useLayoutEffect(measure)

  // ★ Re-measure when the cards grow or shrink ("Show full text" etc.) and when the screen changes
  useEffect(() => {
    const el = permsRef.current
    let ro: ResizeObserver | undefined
    if (el && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => measure())
      // ⚠️ The default (content-box) does not fire on padding changes (hit in CLAUDE.md §5)
      ro.observe(el, { box: 'border-box' })
    }
    window.addEventListener('resize', measure)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  // Showing and hiding "to bottom"
  useEffect(() => {
    const onScroll = () => {
      const near =
        window.innerHeight + window.scrollY >= document.body.scrollHeight - BOTTOM_SLACK
      atBottomRef.current = near
      setAtBottom(near)
      setHasPrevMine(findPrevMine() !== undefined)
      measure()
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // ★ Content changes without scrolling too (a reply grows, older pages are read) ⇒ look again after it is laid out
  useEffect(() => {
    const id = requestAnimationFrame(() => setHasPrevMine(findPrevMine() !== undefined))
    return () => cancelAnimationFrame(id)
  }, [entries])

  // ★ Re-read when the endpoint changes.
  //
  // ⚠️ The bug from when the dependency was only [sessionId] (found in the 2026-08-12 external review):
  //    tapping a notification **cold-starts the app**, and with no list yet the owning agent is unknown, so
  //    it reads via transports[0]. A notification from another machine gives 404. Then the list arrives and
  //    it switches to the right transport, **but this effect does not re-run, so it is never fixed**
  //    (live follow keeps hitting the wrong agent too). **Notification taps are the main path, so this is fatal.**
  const endpointId = transport.endpoint.id
  /**
   * ★ The destination this component is responsible for.
   *
   * ⚠️ **Take the send destination from here** (do not re-read `sessionId` inside async code).
   *    ★ The isolation on switching itself is handled by `main.tsx`'s `<Thread key={endpoint:session}>`.
   */
  const here = { sessionId, endpointId }

  /**
   * Re-fetch the latest page (used both for the initial load and for retrying after a failure).
   *
   * ⚠️⚠️ There was a hole where **one failed initial load also stopped the follow-up** (2026-08-20 codex medium #4).
   *    For a session without a transcript yet (right after deep-linking from a notification) or a transient network failure,
   *    `tail` stayed at -1 and **every later poll returned immediately**.
   *    ⇒ The follow-up **calls this again**.
   */
  const loadFirst = async (gen: number): Promise<void> => {
    const page = await transport.getLog(sessionId, { limit: PAGE })
    // ★ If the generation changed by arrival time, discard it (we have moved to another thread)
    if (gen !== genRef.current) return
    setEntries(page.entries)
    // ★ If the reload contains a just-sent message, clear "Sending…" (match only after the send time / pending.ts)
    setPending((prev) => consumeAfterReload(prev, page.entries, usedRef.current))
    setCursor(page.cursor)
    setInflight(page.inflight)
    tailRef.current = page.tail
    setError(undefined)
    setLoading(false)
    requestAnimationFrame(() => settleView())
  }

  /**
   * Initial load (from the latest).
   *
   * ★★ **No need to discard the previous content** (2026-08-25). `main.tsx` passes
   *    `<Thread key={endpoint:session}>`, so when the destination changes **the whole component is recreated**
   *    (preact 10 unmounts the old vnode whose `key` does not match = state starts fresh).
   * ⚠️⚠️ It used to discard things **one by one** here: `setEntries([])` / `setNote(undefined)` / `setConfirm(undefined)` …,
   *    but `useEffect` runs **after paint**, so **one frame remained**,
   *    and **forgotten state caused accidents** (a confirmation dialog acted on another session).
   *    ⇒ We moved to **recreating the container**, so do not add more here.
   * ⚠️ If `key` is removed, all of it comes back. **`web/src/discipline.test.ts` checks the `key` by machine.**
   */
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    tailRef.current = -1
    genRef.current += 1
    const gen = genRef.current
    // ★★ While the initial load runs, follow-up fetches **wait** for it (codex round 16, medium #3).
    //   ⚠️⚠️ Without waiting, on `hello` the follow-up saw "not read yet (tail -1)" and started **a second initial load**,
    //      and when the older one arrived later **the display and tail rolled back** (same generation, so the generation check did not stop it).
    const first = loadFirst(gen)
    firstLoadRef.current = first
    void (async () => {
      try {
        await first
      } catch (err) {
        if (!cancelled && gen === genRef.current) {
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        }
      } finally {
        if (firstLoadRef.current === first) firstLoadRef.current = undefined
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId, endpointId])

  // Live follow: fetch only what was appended after tail
  // ★★ **Stopped while the screen is in the background** (2026-09-23 / `visibility.ts`). ⚠️⚠️ Measured: a single tab left open
  //   streamed into the relay room **every 3 seconds for 24 hours**, taking most of the daily limit.
  // ★★ **Follow via notifications** (2026-09-23 / `ui/followPlan.ts`). For agents with the `log-follow` mark,
  //   `followLog` is opened only while viewing, and on "grew" or `hello` (re-subscribed) the rest is fetched.
  //   A 60-second poll remains as insurance. ⚠️ Agents without the mark (old ones) keep the 3-second poll.
  //   ⚠️ Fetches go through `coalesce` (no overlap; a signal during a run is not dropped but triggers one later run).
  const followOn = followPlan(features).follow
  useEffect(() => {
    const plan = followPlan(features)
    const pull = coalesce(async () => {
        try {
          // ★★ If the initial load is running, wait for it to finish before fetching more (no double reads / round 16, medium #3)
          const first = firstLoadRef.current
          if (first) await first.catch(() => undefined)
          const gen = genRef.current
          // ⚠️⚠️ **The sentinel is -1. Never 0** (2026-08-20 `/code-review`, medium).
          //    `tail` is "the end of a complete line", so **it can be 0 even for a non-empty file**
          //    (when the first record exceeds 4KB and is caught mid-write). With 0 as the sentinel
          //    **the follow-up never starts for the whole mount**.
          // ★ If not loaded (-1), **re-fetch the latest page** (retry after the initial load failed)
          if (tailRef.current < 0) {
            await loadFirst(gen)
            return
          }
          const page = await transport.getLog(sessionId, { since: tailRef.current })
          // ★ If the generation differs (arrived after moving to another thread), touch nothing
          if (gen !== genRef.current) return
          // ★★ "Text not yet written" is **replaced every time, before the tail check**.
          //    ⚠️⚠️ If this came after `followAction`, **the feature would not work**
          //    (2026-08-21 `/code-review`, high #1). While waiting for a human answer
          //    **the transcript does not grow by a single byte**, so `followAction` always returns `ignore`,
          //    the early return never reaches `setInflight` ⇒ waiting with the thread open,
          //    **neither the growing text nor "writing → not recorded yet" arrives**.
          //    ★ This is "the current state", not "something that grows", so it is updated independently of tail.
          setInflight(page.inflight)
          const action = followAction({
            requestGen: gen,
            currentGen: genRef.current,
            currentTail: tailRef.current,
            pageTail: page.tail,
            added: page.entries.length,
          })
          if (action === 'ignore') return
          // ★ The file was recreated. Reload from the latest page (do not append to old content)
          if (action === 'reset') {
            tailRef.current = -1
            await loadFirst(gen)
            return
          }
          tailRef.current = page.tail
          if (action === 'advance') return
          const nearBottom =
            window.innerHeight + window.scrollY >= document.body.scrollHeight - BOTTOM_SLACK
          setEntries((prev) => [...prev, ...page.entries])
          // ★ Optimistic entries are cleared **only by what was added** (matching the whole thread
          //   hits the same text sent in the past and clears "undelivered sends" / pending.ts)
          // ★ Those awaiting a reply note records with the same text (confirmed once the route is known / `noteArrivals` in pending.ts)
          setPending((prev) => noteArrivals(prev, page.entries, usedRef.current))
          setNow(Date.now())
          // ⚠️⚠️ **Do not scroll while approval cards are showing** (2026-08-19 `/code-review`, medium #2).
          //    Only this path jumped straight to `bottomRef`, so it **yanked to the bottom edge of the cards and
          //    pushed the preceding text off screen** (the same bug surviving on another path).
          //    There is "⚠ Approval needed ↓" for noticing, so do not pull the ground from under the reader.
          if (nearBottom && permissionsRef.current.length === 0) {
            requestAnimationFrame(() => bottomRef.current?.scrollIntoView())
          }
        } catch {
          // Ignore transient failures (picked up by the next notification or poll)
        }
    })
    const stopPoll = whileVisible(pull, plan.pollMs, globalThis.document)
    // ⚠️⚠️ Subscribed **only while viewing** (released when in the background = nothing streamed to unwatched devices or background tabs)
    const stopFollow = plan.follow
      ? subscribeWhileVisible(
          () =>
            transport.followLog(sessionId, (event) => {
              if (shouldPull(event, sessionId)) pull()
            }),
          globalThis.document,
        )
      : () => undefined
    return () => {
      stopPoll()
      stopFollow()
      // ⚠️ Also cancel the scheduled "one more later" (round 16, low #4)
      pull.stop()
    }
  }, [sessionId, endpointId, followOn])

  // On moving to another session, discard optimistic entries (they would look like part of another conversation)
  useEffect(() => setPending([]), [sessionId, endpointId])

  // ★ The clock advances independently.
  // ⚠️ It used to update only "when new records arrived", so **while nothing happened
  //    the time checks stood still** (no "cannot confirm delivery", no grace period ending).
  // ⚠️⚠️ But **do not always run it**. Re-rendering on every tick would diff the whole long thread
  //    every 3 seconds while open (janky on phones).
  //    Run it only while something shows the time.
  // ⚠️ The grey grace period also ends by the clock. Without it, **it does not show until the 3-second follow-up**
  //    (which never comes in a thread where nothing happens)
  const needsClock = pending.length > 0 || noAnswerable || greyPending
  useEffect(() => {
    if (!needsClock) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 3000)
    return () => clearInterval(t)
  }, [needsClock])

  const sendMessage = async (text: string): Promise<void> => {
    // ★★ **Stack at the moment of sending** (2026-09-24 / codex round 25). The same text arriving while awaiting the reply is noted by `noteArrivals`,
    //   and `finishSend` confirms once the reply reveals the route (keystrokes or inbox).
    //   ⚠️⚠️ Do not go back to stacking after the reply (searching a buffer): the buffer cap, reloads and arrivals before the reply left "Sending…" behind.
    const id = ++sendSeq.current
    setPending((prev) => beginSend(prev, id, text, Date.now()))
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }))
    let res: Awaited<ReturnType<typeof transport.sendMessage>>
    try {
      res = await transport.sendMessage(sessionId, text)
    } catch (err) {
      // ⚠️ Not sent ⇒ remove what was stacked (the input box shows the error)
      setPending((prev) => finishSend(prev, id, null))
      throw err
    }
    // ★ **Do not stay silent** about the rewrite (it started with `/` `!`, so one space was added)
    setNote(res.neutralized ? { bad: false, text: neutralizedNote() } : undefined)
    // ★ Confirmed by `route`. Keystroke deliveries carry no `via`, so without it matching fails (pending.ts)
    setPending((prev) => finishSend(prev, id, res.route))
  }

  /**
   * ★ Stop the response (ESC).
   *
   * ⚠️⚠️ **Even on failure, it is not sent as an instruction** (the agent side does not know the inbox either).
   *    If "stop" entered the conversation, it would not stop and would pollute the context.
   * ⚠️ While pressed, `stopping` (ESC twice opens the "go back" screen).
   *    ⚠️ Still, the last line of defence is the agent (another device can press at the same time).
   */
  const stop = async (): Promise<void> => {
    setStopping(true)
    setNote(undefined)
    try {
      const res = await transport.interrupt(sessionId)
      setNote({ bad: false, text: stopSentNote(res.cleared === true) })
    } catch (err) {
      // ⚠️ Refusal reasons (approval card showing, session that cannot be stopped, etc.) are **shown next to the input box**.
      //    They used to go into the top `error`, so the text we most wanted seen was invisible
      setNote({ bad: true, text: err instanceof Error ? err.message : String(err)})
    } finally {
      setStopping(false)
    }
  }

  /**
   * @param untilMine ★ keep loading more until an own message arrives ("↑ My message" / `keepLoading` in `ui/scrollback.ts`; capped)
   */
  const loadOlder = async (untilMine = false): Promise<void> => {
    if (cursor === null) return
    // ★ Prevent rapid taps from prepending the same page twice (2026-08-20 codex medium #3)
    if (olderRef.current) return
    olderRef.current = true
    const gen = genRef.current
    try {
      let at: number | null = cursor
      const got: LogEntry[] = []
      for (let pages = 1; at !== null; pages++) {
        const page = await transport.getLog(sessionId, { before: at, limit: PAGE })
        // ★ If we had moved to another thread by arrival, discard it
        if (gen !== genRef.current) return
        // ⚠️ Later-fetched pages are older ⇒ prepend
        got.unshift(...page.entries)
        at = page.cursor
        if (!untilMine || !keepLoading(page, pages)) break
      }
      // ⚠️⚠️ Do nothing if the screen was left (do not leave only the alignment setting behind after leaving / codex round 19, medium #1)
      if (gen !== genRef.current || !threadRef.current) return
      // ★★ **Stay where you were** even when adding above. ⚠️ Disable Chrome's automatic anchoring so it does not move twice
      const root = document.documentElement
      const kids = [...threadRef.current.children] as HTMLElement[]
      const idx = firstVisibleIndex(kids.map((el) => el.getBoundingClientRect().bottom), viewTop())
      anchorRef.current = {
        // ⚠️ The first `visible.length` children of `.thread` are messages (what follows, e.g. text being written, is not an anchor)
        entry: idx >= 0 ? visibleRef.current[idx] : undefined,
        top: idx >= 0 ? kids[idx]!.getBoundingClientRect().top : 0,
        scrollY: window.scrollY,
        height: root.scrollHeight,
      }
      root.style.overflowAnchor = 'none'
      setEntries((prev) => [...got, ...prev])
      setCursor(at)
    } catch (err) {
      if (gen === genRef.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      olderRef.current = false
    }
  }

  /** ★ Alignment after loading more (before paint = `useLayoutEffect`. ⚠️ after paint it jumps for a moment) */
  useLayoutEffect(() => {
    const a = anchorRef.current
    if (!a) return
    anchorRef.current = null
    const root = document.documentElement
    // ★★ Restore by how many px the element in view moved (growth below is not counted). ⚠️ Height difference only when no element was visible
    const at = a.entry ? visibleRef.current.indexOf(a.entry) : -1
    const el = at >= 0 ? (threadRef.current?.children[at] as HTMLElement | undefined) : undefined
    if (el) window.scrollBy(0, el.getBoundingClientRect().top - a.top)
    else window.scrollTo(0, anchoredScrollY(a, root.scrollHeight))
    root.style.overflowAnchor = ''
  }, [entries])

  // ★★ When leaving the screen, even mid-load, **restore the alignment setting and advance the generation** (codex round 19, medium #1).
  //   ⚠️ Otherwise a load finishing after leaving would leave Chrome's automatic anchoring disabled, breaking it in the list and the next thread
  useEffect(
    () => () => {
      genRef.current += 1
      anchorRef.current = null
      document.documentElement.style.overflowAnchor = ''
    },
    [],
  )

  /** ★ Top of the visible range (bottom of the sticky bar = the actual `--bar-h` / `ThreadBar.tsx`) */
  const viewTop = (): number => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bar-h')) || 0
  /** ★ The nearest own message above the current view (decided by `pickPrevMine`) */
  const findPrevMine = (): HTMLElement | undefined => {
    const els = [...(threadRef.current?.querySelectorAll<HTMLElement>('[data-mine]') ?? [])]
    const i = pickPrevMine(els.map((el) => el.getBoundingClientRect().top), viewTop())
    return i >= 0 ? els[i] : undefined
  }
  /**
   * ★★ "↑ My message" (2026-09-24 / user request). Jump to your own message above.
   * If none is loaded, load older ones until found, then jump (capped at `MAX_SCROLLBACK_PAGES`).
   * ⚠️ If the cap is reached without finding one, go to the top of what was loaded (pressing again reads further).
   * ⚠️ Moves only when a person presses it (never automatically = separate from the three-place limit on jumping to the bottom / discipline.test.ts).
   */
  const jumpToPrevMine = async (): Promise<void> => {
    const hit = findPrevMine()
    if (hit) {
      hit.scrollIntoView({ block: 'start', behavior: 'smooth' })
      return
    }
    if (cursor === null) {
      topRef.current?.scrollIntoView({ behavior: 'smooth' })
      return
    }
    setSeeking(true)
    try {
      await loadOlder(true)
    } finally {
      setSeeking(false)
    }
    // ⚠️ Search after drawing and aligning (wait 2 frames = after the added content is aligned)
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const next = findPrevMine()
        if (next) next.scrollIntoView({ block: 'start', behavior: 'smooth' })
        else topRef.current?.scrollIntoView({ behavior: 'smooth' })
      }),
    )
  }

  // ★ Approvals appear at the very bottom of the conversation, so **you cannot notice them unless looking at the bottom** (we actually missed them).
  //
  //   - Someone at the bottom → carry them on to the cards (a continuation of what they were reading)
  //   - Someone reading above → **do not steal the scroll**; announce with "⚠ Approval ↓" at the bottom
  //
  // ⚠️ Do not use `atBottom` (state) to judge position. This effect runs after the cards are drawn,
  //    so the state may already be updated.
  // ⚠️⚠️ `atBottomRef` cannot be used either (**it becomes false the moment we scroll to the boundary**, so
  //    the second and later cards stop appearing / 2026-08-19 `/code-review`, medium #1).
  //    ⇒ Look at **the position itself** with `cardAreaVisible()`.
  const permKeys = permissions.map((p) => p.key).join(',')
  // ⚠️⚠️ Scroll **only when they increase** (2026-08-19 codex review, medium #1).
  //    This effect also runs **when answering reduces them or they are reordered**, so
  //    without the condition it **yanks you back while reading a card**.
  const seenKeysRef = useRef<string>('')
  useEffect(() => {
    const added = addedKeys(
      seenKeysRef.current ? seenKeysRef.current.split(',') : [],
      permissions.map((p) => p.key),
    )
    seenKeysRef.current = permKeys
    if (added === 0) return
    // ⚠️ Do not scroll while the log is loading (2026-08-19 codex round 3, low #6).
    //    Scrolling once over the empty log and again after loading completes **jumps**
    if (loading) return
    if (!boundaryOnScreen()) return
    requestAnimationFrame(() => settleView('smooth'))
  }, [permKeys])

  const visible = showThinking ? entries : entries.filter((e) => e.kind !== 'thinking')
  visibleRef.current = visible
  const thinkingCount = entries.filter((e) => e.kind === 'thinking').length
  /** Approvals are showing but off screen (= cannot be noticed) */
  /**
   * ★★ Approvals are showing but **not visible** (= cannot be noticed).
   *
   * ⚠️⚠️ It used to be decided by `!atBottom` (not at the bottom), so there was a hole where
   *    **sending an instruction pushed the cards up off screen, and being at the bottom meant no signal**
   *    (2026-08-19 codex review, medium #2. Optimistic entries stack below the cards).
   *    ⇒ Decide by **the card area not overlapping the screen**, and indicate whether above or below.
   */
  /**
   * ★★ Run a table command (after confirmation).
   *
   * ⚠️⚠️ **Only the id is sent** (the characters sent come from the agent's table).
   * ⚠️ The agent returns refusal reasons in Japanese, so they are shown **next to the input box** as-is.
   */
  /**
   * ★★ Toggle auto-approve mode (endpoint `POST /sessions/:id/auto-approve`).
   *
   * ⚠️⚠️ The agent may return **`{ok:false}` with 200** (state file broken / cannot save).
   *    **Never make it look like success**. The text is in one place, `ui/autoApprove.ts` (on/off mean opposite things).
   */
  const sendAuto = async (target: string, on: boolean, duration?: AutoApproveDuration): Promise<AutoApproveResult> => {
    const res = await transport.setAutoApprove(target, on, duration)
    if (!res.ok) throw new Error(autoApproveError(on, res.reason))
    return res
  }

  /**
   * ★★ Turning off has **no confirmation** (2026-09-07 design decision).
   *
   * Only "turning on" is dangerous, and **turning off is the urgent action**. A confirmation would make it
   * two taps from the bar's warning, out of reach in a panic (same reason "Stop" has no confirmation).
   */
  const autoApproveOff = async (): Promise<void> => {
    const token = ++runToken.current
    const target = { id: 'auto-approve' as const, ...here }
    setRunning({ ...target, token })
    setNote(undefined)
    try {
      await sendAuto(target.sessionId, false)
      setNote({ bad: false, text: t('自動承認をオフにしました', 'Auto-approve turned off') })
    } catch (err) {
      setNote({ bad: true, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setRunning((prev) => releaseRunning(prev, token))
    }
  }

  const runCommand = async (target: CommandTarget): Promise<void> => {
    // ⚠️ The destination is **the value at the moment of pressing** (`target`). Do not re-read the current `sessionId`
    //    (re-reading it would swap destinations if `key` is ever removed)
    setConfirm(undefined)
    // ⚠️ Serial number per run (tells apart doing the same action twice)
    const token = ++runToken.current
    setRunning({ ...target, token })
    setNote(undefined)
    try {
      // ⚠️ `clear` is a **control key**, not a table command (separate endpoint / `CONTROL_KEYS`)
      if (target.id === 'clear') await transport.clearInput(target.sessionId)
      // ⚠️⚠️ `auto-approve` **uses not a single keystroke byte** (it goes through the approval hook).
      //    Confirmation is required **only when turning it on** (off is cut immediately by `autoApproveOff` below)
      else if (target.id === 'auto-approve') {
        // ★ The duration is passed by name (the length comes from the agent's table). ⚠️ The notice is built from **the expiry the agent returned**
        const res = await sendAuto(target.sessionId, true, target.duration)
        setNote({ bad: false, text: autoApproveOnText(res.until) })
        return
      } else await transport.runCommand(target.sessionId, target.id)
      // ⚠️⚠️ Checking "does it match the current `sessionId`" here **means nothing**
      //    (`sessionId` is **the closure value of the render that created this function**, so **it always matches**
      //     = measured in 2026-08-25 codex round 7, medium #2. Isolation on switching is handled by `key`)
      setNote({ bad: false, text: COMMAND_UI[target.id].sent })
    } catch (err) {
      setNote({ bad: true, text: err instanceof Error ? err.message : String(err) })
    } finally {
      // ★★ Clear **only the mark we set** (looks at current state, so it does not depend on stale values)
      setRunning((prev) => releaseRunning(prev, token))
    }
  }

  const area = permArea(permBox?.top, permBox?.bottom, usable.top, usable.bottom)
  const permBelow = needsPermSignal(area, permissions.length)

  /**
   * ★ What goes in the sticky bar's "…". **This is the place for future additions**.
   *
   * ⚠️ "Load older" does not go here. It is better **attached to the top of the thread**
   *    so it can be pressed repeatedly (through the menu it would be two taps each time).
   */
  const stopBtn = stopView(session, stopping ? 'sending' : 'ready')
  /**
   * ★★ How auto-approve mode looks. ⚠️ Decided in one place, `ui/autoApprove.ts`
   *    (must not use `commandView` = that conditions on the keystroke route)
   */
  const autoView = autoApproveView(
    session,
    running?.id === 'auto-approve' ? 'sending' : 'ready',
    features,
  )
  const actions: ThreadBarAction[] = [
    // ★ An urgent action, so at the top (⚠️ whether it shows is decided in one place, `stop.ts`)
    ...(stopBtn.show
      ? [
          {
            label: stopBtn.label,
            onClick: () => {
              if (!stopBtn.disabled) void stop()
            },
          },
        ]
      : []),
    // ★★ Auto-approve mode. **Confirmation only when turning on** (off is urgent, so cut immediately)
    ...(autoView.show
      ? [
          {
            label: autoView.label,
            onClick: () => {
              if (autoView.disabled) return
              // ⚠️ The destination is **the one at the moment of pressing** (`here`). Do not re-read the current value
              if (autoView.on) void autoApproveOff()
              else setConfirm({ id: 'auto-approve', ...here })
            },
          },
        ]
      : []),
    // ★ Table slash commands. ⚠️ **Not run the instant they are pressed** (confirmation in between)
    // ★ `clear` is used right after "Stop", so it sits **directly below it** (2026-08-25 request)
    ...(['clear', 'compact', 'exit'] as KeyedConfirmKind[]).flatMap((id) => {
      const v = commandView(session, id, running?.id === id ? 'sending' : 'ready', features)
      if (!v.show) return []
      return [
        {
          label: v.label,
          onClick: () => {
            // ★ The confirmation holds the destination at the moment of pressing (not re-read later)
            if (!v.disabled) setConfirm({ id, ...here })
          },
        },
      ]
    }),
    ...(thinkingCount > 0
      ? [
          {
            // ★ 2026-09-24: "Thinking N" was unclear (user) ⇒ say what it opens. N is the count **within what is loaded**
            label: showThinking
              ? t('💭 考えた過程を隠す', '💭 Hide thinking')
              : t(`💭 考えた過程を見る（${thinkingCount}件）`, `💭 Show thinking (${thinkingCount})`),
            onClick: () => setShowThinking(!showThinking),
          },
        ]
      : []),
    { label: t('↑ 一番上へ', '↑ To top'), onClick: () => topRef.current?.scrollIntoView({ behavior: 'smooth' }) },
  ]

  return (
    <>
      {/* ★ The sticky line. Name and state **do not disappear on scroll** (2026-08-18).
          ⚠️ It used to float because "in the header it scrolls away", but that was
             about a normal-flow header. A sticky one does not disappear (see ThreadBar.tsx) */}
      <ThreadBar
        sessionId={sessionId}
        title={session?.title ?? sessionId.slice(0, 8)}
        session={session}
        alert={barAlert}
        onJump={onJump}
        onBack={onBack}
        actions={actions}
        auto={
          // ★ Whether it shows is `autoApproveBanner` (⚠️ never cleared by the device clock)
          (() => {
            const banner = autoApproveBanner(session, Date.now())
            if (!banner) return null
            return { text: banner.text, disabled: autoView.disabled, onOff: () => void autoApproveOff() }
          })()
        }
      />

      <div ref={topRef} class="threadhead">
        {/* ★ The name is in the bar, so only the details here (information that may scroll away) */}
        <div class="sub">
          {session ? (
            <>
              <span class="chip account">{accountLabel(session)}</span>
              <span>{session.project}</span>
              {session.gitBranch ? <span class="chip">{session.gitBranch}</span> : null}
            </>
          ) : (
            <span>{sessionId}</span>
          )}
        </div>
      </div>

      {error ? <p class="notice bad">{error}</p> : null}
      {loading ? <p class="notice">{t('読み込み中…', 'Loading…')}</p> : null}

      {cursor !== null ? (
        <button class="plain wide" onClick={() => void loadOlder()}>
          {t('↑ 古いものを読む', '↑ Load older')}
        </button>
      ) : null}

      <div class="thread" ref={threadRef}>
        {visible.map((e, i) => (
          <Entry key={i} entry={e} />
        ))}
        {/* ★★ Text not yet recorded. Shown **at the very bottom of the log, just above the boundary**.
            ⚠️ It disappears once in the transcript (matched by `alreadyInTranscript`. The decision is
               shared with the agent = written separately, fixing only one side would drift).
            ⚠️ The decision uses **all elements the screen holds** (follow-up responses only contain the new part). */}
        {inflight && !alreadyInTranscript(inflight.text, entries, inflight.final) ? (
          <div class="msg asst inflight">
            <div class="who">
              Claude {hhmm(inflight.at)}
              <span class="chip">
                {inflight.final ? t('まだ記録されていません', 'Not recorded yet') : t('書いている途中', 'Still writing')}
              </span>
            </div>
            <div class="md">{renderMarkdown(inflight.text)}</div>
            {inflight.clipped ? <div class="clipnote">{t('⚠️ 長いので途中まで出しています', '⚠️ Long, showing only part of it')}</div> : null}
          </div>
        ) : null}
      </div>

      {/* ★ The boundary between the log and the cards (the target of `settleView`) */}
      <div ref={permTopRef} class="permtop" />

      {/* ★ Approvals are at the very bottom of the conversation, so you read the thread and then answer.
          ⚠️ Even for sessions without a transcript (stopped on the first turn)
             this part is still shown. Otherwise there is no way to answer from the phone
          ⚠️⚠️ **This box is what gets measured** (for the signal). It used to measure "boundary to page end", so
             sending an instruction stacked optimistic entries below and counted as "visible",
             and no signal appeared even when the cards scrolled away upward (codex round 3, medium #2) */}
      <div ref={permsRef} class="permswrap">
        <Permissions items={permissions} onAnswer={onAnswer} inThread />
      </div>

      {/* ★ Explains "the list says needs attention, but inside there is no way to answer".
          Approvals without a mark (hook connection) **can only be answered on the PC**. Mainly three causes:
            - the agent was restarted (the connection dies with the process / actually hit on 2026-08-13)
            - the 24-hour timeout
            - the approval hook is not installed on that machine
          ⚠️ Showing nothing silently reads as "broken". **Tell them where to answer** */}
      {/* ★★ `quiet` (approvals hidden for a few seconds) is a count **per endpoint** and carries
          no session identifier (`QUIET_MS` in `agent/src/routes/permission.ts`).
          ⚠️⚠️ So writing "an approval will appear shortly" would be **a lie asserting it appears in this thread**
          (it may belong to another session / 2026-08-19 codex review, medium #3).
          ⇒ **Say only what we know (being checked on this PC).**
          ★ The proper fix is adding per-session `quiet` to the API (HANDOFF 5.0-h a). This text is interim */}
      {permissions.length === 0 && quietPermissions > 0 ? (
        <p class="notice">
          {t(
            `このPCで確認中の承認が ${quietPermissions} 件あります… （このスレッドのものとは限りません）`,
            `${quietPermissions} approval(s) being checked on this PC… (not necessarily from this thread)`,
          )}
        </p>
      ) : null}
      {showNoAnswerable ? (
        <p class="notice warn">
          {wait.kind === 'other' ? (
            /* ⚠️ The reason is **a state word** like "input needed", so it goes in parentheses,
               to avoid broken Japanese grammar like "waiting for input needed" (noticed in a real browser) */
            <>
              {t('PCの画面で何かを待っています（', 'The PC screen is waiting for something (')}
              <strong>{wait.label}</strong>
              {t('）。', '). ')}
              <strong>{t('この種類はスマホからは答えられません', 'This kind can’t be answered from the phone')}</strong>
              {t(
                '（私たちが受け取れるのはツールの承認だけです）。PCで答えてください。',
                ' (we can only receive tool approvals). Please answer on the PC.',
              )}
            </>
          ) : wait.kind === 'permission' ? (
            <>
              {t('PCの画面で承認を待っています。', 'The PC screen is waiting for an approval. ')}
              <strong>{t('この承認はスマホからは答えられません', 'This approval can’t be answered from the phone')}</strong>
              {t(
                '（agent の再起動・時間切れ・フック未設置などで、返す先がありません）。PCで答えてください。',
                ' (there is nowhere to send the answer, e.g. the agent restarted, it timed out, or the hook is not installed). Please answer on the PC.',
              )}
            </>
          ) : (
            /* ★ Do not assert when the reason is unknown (old CLIs do not write waitingFor) */
            <>
              {t('PCの画面で何かを待っています。', 'The PC screen is waiting for something. ')}
              <strong>{t('ここからは答えられません', 'It can’t be answered from here')}</strong>
              {t(
                '（何を待っているかは分かりません）。PCの画面を見てください。',
                ' (what it is waiting for is unknown). Please check the PC screen.',
              )}
            </>
          )}
        </p>
      ) : null}

      {/* ★ Optimistic display right after sending. Disappears once it appears in the thread (the effect above) */}
      {pending.map((p) => (
        <div key={`${p.id ?? p.at}`} class="msg user pending">
          {/* ⚠️ The inbox returns no reply, so "Sending" forever would be a lie.
                 After a while it becomes "cannot confirm" (2026-08-14 review, low) */}
          <div class="who">
            {t('スマホから', 'From phone')}{' '}
            <span class="chip">
              {now - p.at > UNSURE_MS ? t('届いたか確認できません', 'Can’t confirm it arrived') : t('送信中…', 'Sending…')}
            </span>
          </div>
          <div class="md">{p.text}</div>
        </div>
      ))}

      <div ref={bottomRef} />
      {/* The input box is fixed to the screen, so leave that much margin below the content */}
      <div ref={padRef} class="composerpad" />

      {/* ★ When approvals are below, use stronger text than "Latest". Pressing goes to the cards.
          ⚠️ Do not show both (same spot, they would overlap). Approvals take priority
          ★ The position clear of the input box is **held by `.jump` itself** (the actual `--pad-h`).
            ⚠️ It used to be a convention to "always add" an `up` modifier, but **conventions are not kept**
               = it got hidden in practice on 2026-09-21. ⇒ The modifier was removed. Do not add positioning here */}
      {permBelow ? (
        <button
          class="jump perm"
          onClick={() => {
            // ★★ **Actually moves according to direction** (2026-08-19 codex round 3, medium #3).
            //    With only `settleView`, right after landing the boundary is already centred, so **pressing did nothing**
            //    = "one tap to the answer buttons" was a lie (a regression I introduced).
            if (signalTarget(area) === 'down') {
              // Bottom clipped ⇒ show the **end** of the cards (the answer buttons)
              permsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
            } else {
              settleView('smooth')
            }
          }}
          aria-label={t('承認まで移動', 'Go to approval')}
        >
          {/* ★★ Show the count (2026-08-19 `/code-review`, medium #1).
              Since we decided **not to steal the scroll** when a second card arrives,
              this text changing is the only signal. Without a number you cannot tell "it increased".
              ⚠️ Show the direction too (the cards may have scrolled **up** / same-day codex medium #2) */}
          ⚠ {t('承認が必要です', 'Approval needed')}
          {permissions.length > 1 ? t(`（${permissions.length}件）`, ` (${permissions.length})`) : ''}{' '}
          {signalTarget(area) === 'down' ? '↓' : '↑'}
        </button>
      ) : !atBottom ? (
        <button class="jump" onClick={jumpToBottom} aria-label={t('最下部へ', 'To bottom')}>
          {t('↓ 最新', '↓ Latest')}
        </button>
      ) : null}
      {/* ★★ Scroll back by your own messages (2026-09-24 / `ui/scrollback.ts`). ⚠️ Stacked above "↓ Latest" (`.jump.mine`) */}
      {showMineJump({ loading, atBottom, hasPrevMine, moreToLoad: cursor !== null }) ? (
        <button
          class="jump mine"
          disabled={seeking}
          onClick={() => void jumpToPrevMine()}
          aria-label={t('上の自分の発言へ', 'To my previous message')}
        >
          {seeking ? t('↑ 読み込み中…', '↑ Loading…') : t('↑ 自分の発言', '↑ My message')}
        </button>
      ) : null}

      {/* ★ Send an instruction (M4-2). Always present in the same "thumb-reachable spot" as approvals */}
      {/* ⚠️ Sending before the destination is settled **goes to the first endpoint**
             (2026-08-14 external review, high). The decision is held by main.tsx (`canSend`).
             ⚠️ Not decided by the presence of `session`. Synthetic rows also have `session` */}
      <Composer
        sessionId={sessionId}
        disabled={!canSend}
        hint={sendMark(session)?.text}
        result={note}
        // ★ The cat-and-status line. ⚠️ Decided in one place, `composerBusy` (including run/stop)
        busy={composerBusy(session)}
        // ★ Amount of context currently in use (same formatting as the list's `ctx`)
        ctx={formatTokens(session?.contextTokens)}
        onSend={sendMessage}
      />

      {/* ★★ Confirmation. ⚠️ `/exit` is irreversible (pending approvals vanish too), so the text says so */}
      {/* ★ The component is recreated per destination, so only **this destination's confirmation** remains here (see above)*/}
      {confirm ? (
        <Confirm
          title={confirmTitle(confirm.id, session)}
          body={COMMAND_UI[confirm.id].body}
          note={confirmNote(confirm.id)}
          ok={COMMAND_UI[confirm.id].ok}
          // ⚠️ Auto-approve is "reversible", but **arbitrary commands run once pressed**, so it is red
          danger={confirm.id === 'exit' || confirm.id === 'auto-approve'}
          // ★★ Auto-approve lets you pick a duration (2026-09-24). ⚠️ 24 hours only for agents with the `auto-approve-24h` mark
          //   (old agents do not know the name, so sending it gives 3 hours = disagrees with what the screen says)
          {...(confirm.id === 'auto-approve' && features?.includes('auto-approve-24h')
            ? { alt: { ok: autoApproveLongLabel(), onOk: () => void runCommand({ ...confirm, duration: '24h' }) } }
            : {})}
          onCancel={() => setConfirm(undefined)}
          // ⚠️ Auto-approve's "3 hours" is sent without a name (the agent's default = the same 3 hours even on old agents)
          onOk={() => void runCommand(confirm)}
        />
      ) : null}
    </>
  )
}

function Entry({ entry }: { entry: LogEntry }) {
  const at = hhmm(entry.at)
  switch (entry.kind) {
    case 'user': {
      // ★★ Appearance depends on origin (2026-08-14 review, high).
      //   ⚠️ Showing everything from the inbox as "You" would **list instructions you did not send
      //      as your own messages**. `via:'peer'` is what "did not match our own identity".
      const peer = entry.via === 'peer'
      return (
        // ★ `data-mine` = the jump target of "↑ My message" (⚠️ decided in one place, `isMine`. Do not hand-roll it with CSS classes)
        <div class={peer ? 'msg user peer' : 'msg user'} data-mine={isMine(entry) ? '' : undefined}>
          <div class="who">
            {peer ? (entry.from ?? t('別のセッション', 'Another session')) : t('あなた', 'You')} {at}
            {entry.via === 'inbox' ? <span class="chip">{t('スマホから', 'From phone')}</span> : null}
            {peer ? <span class="chip mode">{t('別のセッションから', 'From another session')}</span> : null}
          </div>
          <div class="md">{renderMarkdown(entry.text)}</div>
        </div>
      )
    }
    case 'assistant':
      return (
        <div class="msg asst">
          <div class="who">Claude {at}</div>
          <div class="md">{renderMarkdown(entry.text)}</div>
        </div>
      )
    case 'thinking':
      return (
        <div class="msg think">
          <div class="who">{t('思考', 'Thinking')} {at}</div>
          <div class="md">{renderMarkdown(entry.text)}</div>
        </div>
      )
    case 'tool_use':
      return (
        <Folded
          class="tool"
          chip={<span class="chip tool">{entry.name}</span>}
          text={entry.summary}
          lines={entry.lines}
          truncated={entry.truncated}
        />
      )
    case 'tool_result':
      return (
        <Folded
          class={entry.ok ? 'tool res' : 'tool res err'}
          text={entry.summary || t('(空)', '(empty)')}
          lines={entry.lines}
          truncated={entry.truncated}
        />
      )
    case 'system':
      return <div class="msg sys">{entry.text}</div>
    // ★★ Internal records left by slash commands (the full summary / `<command-name>` /
    //    command output). **Folded into one line, readable when opened** (2026-08-25 / 5.0-x).
    //    ⚠️ Not discarded because the table commands' "effect visible from the phone" shows up here
    case 'meta':
      return (
        <Folded
          class="tool meta"
          chip={<span class="chip">{entry.label}</span>}
          text={entry.summary}
          lines={entry.lines}
          truncated={entry.truncated}
        />
      )
  }
}

/**
 * A tool row. Collapsed to one line by default, opened by tap (same behaviour as Claude Code's TUI).
 * Single short lines get no toggle.
 */
function Folded({
  class: cls,
  chip,
  text,
  lines,
  truncated,
}: {
  class: string
  chip?: VNode
  text: string
  lines: number
  truncated: boolean
}) {
  const [open, setOpen] = useState(false)
  const firstLine = text.split('\n', 1)[0] ?? ''
  const foldable = lines > 1 || truncated || firstLine.length > FOLD_CHARS

  if (!foldable) {
    return (
      <div class={cls}>
        {chip}
        <code>{text}</code>
      </div>
    )
  }

  const extra = lines > 1 ? t(`+${lines - 1}行`, `+${lines - 1} lines`) : '…'
  return (
    <div class={cls}>
      {chip}
      {open ? (
        <>
          <code>{text}</code>
          {truncated ? <span class="more">{t(' （以降は省略）', ' (rest omitted)')}</span> : null}
          <button class="fold" onClick={() => setOpen(false)}>
            {t('閉じる', 'Close')}
          </button>
        </>
      ) : (
        <button class="fold line" onClick={() => setOpen(true)}>
          <code>{firstLine.slice(0, FOLD_CHARS)}</code>
          <span class="more">{extra}</span>
        </button>
      )}
    </div>
  )
}
