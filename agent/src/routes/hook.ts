// The entry point for Claude Code hooks.
//
// The payload shape is proven in hooks/notify.sh: hook_event_name / cwd / transcript_path.
//
// ⚠️ Never include conversation content, prompts or code snippets in notification bodies (identifiers and state only / §6.2).
//    This handler uses transcript_path only to "determine the account". It never reads the contents.
//
// Each machine pushes only its own events, so duplicates structurally cannot occur (§6.3).

import { currentLang, localizeNotificationBody, t } from '../../../shared/i18n.ts'
import { endSessionAutoApprove } from '../autoApprove.ts'

/**
 * ★ Status words for the log (`完了` done / `要対応（…）` needs attention). ⚠️ Decisions, dedup and storage use **the original Japanese**; translate only right before output
 *   (wrapping the outside in `t()` does not translate embedded values / codex round 22, low #4).
 */
const logLabel = (label: string): string => localizeNotificationBody(label, currentLang())
import { hostname } from 'node:os'
import { basename } from 'node:path'
import {
  UNKNOWN_LABEL,
  notificationText,
  shouldRing,
  statusLabel,
  waitingReason,
  type HookEvent,
  type HookPayload,
  type NotifyFields,
  type PushPayload,
} from '../../../shared/types.ts'
import { fieldsFrom, readNotifyMeta } from '../notify.ts'
import { broadcast } from '../events.ts'
import { config } from '../config.ts'
import { discoverConfigDirs } from '../claude/configDirs.ts'
import { hooksFor, noteHook, type SessionHooks } from '../claude/hookState.ts'
import { aliveProcStartSync, readIndexEntriesDetailed, selectLive } from '../claude/sessionIndex.ts'
import { isKnownRawStatus, resolveStatus } from '../claude/sessions.ts'
import { isPermissionHookInstalled } from '../claude/permissionHook.ts'
import { abandonSession, hasPendingForSession, withPendingPerms } from '../permission.ts'
import { sendToAll } from '../push.ts'
import { threadUrl } from '../pushUrl.ts'
import { appendJsonl } from '../state.ts'
import { scheduleStopPush, type StatusProbe, type StopPushDeps } from '../stopPush.ts'
import { readJsonBody, type Ctx } from '../router.ts'

/** /home/user/.claude-r/projects/-home-x/<uuid>.jsonl → { account: '.claude-r', sessionId: '<uuid>' } */
export function parseTranscriptPath(path: string | undefined): {
  account?: string
  sessionId?: string
} {
  if (!path) return {}
  const m = /\/(\.claude(?:-[A-Za-z0-9._-]+)?)\/projects\/[^/]+\/([^/]+)\.jsonl$/.exec(path)
  if (!m) return {}
  return { account: m[1], sessionId: m[2] }
}

/** ★ A payload `session_id` accepted as a session id (the shape of a transcript file name; anything else is ignored) */
export function sessionIdOf(x: unknown): string | undefined {
  return typeof x === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(x) ? x : undefined
}

/**
 * Match the wording in hooks/notify.sh.
 *
 * ⚠️ The wording is taken from `statusLabel`. Writing it directly here **makes the list and notifications disagree**
 *    (external review 2026-08-16, low #7: the same Japanese was in two places).
 */
export function labelFor(event: string): string {
  switch (event) {
    case 'Stop':
      return statusLabel('done')!
    case 'StopFailure':
      return statusLabel('error')!
    case 'Notification':
      return statusLabel('waiting')!
    case 'SessionEnd':
      return '終了'
    default:
      return event
  }
}

/** Which events produce a push. Narrowed so it is not noisy. */
const PUSH_EVENTS = new Set(['Stop', 'StopFailure', 'Notification'])

/**
 * ★ Stop a single approval from sending two notifications.
 *
 * "要対応" (needs attention, this `Notification`) and "承認待ち" (awaiting approval, the `PermissionRequest` hook)
 * **both fire for the same approval**. ② is better (it shows the tool name / jumps to the thread /
 * disappears once answered), so on machines where ② fires, ① is not sent.
 *
 * ⚠️ **On machines without the hook installed, ① is the only notification**, so it is not suppressed there.
 *    The decision actually reads `settings.json` (permissionHook.ts).
 *
 * ⚠️ The idle notification (`idle`) is a different thing, so it is left alone. It announces "waiting for you" regardless of approvals.
 */
export function shouldPushNotice(event: HookEvent, permissionHookInstalled: boolean): boolean {
  if (!PUSH_EVENTS.has(event.event)) return false
  if (event.event !== 'Notification') return true
  if (event.notice !== 'permission') return true
  return !permissionHookInstalled
}

/**
 * ★★ How long to "wait before sending" the end-of-turn notification (decided by measurement on 2026-08-16).
 *
 * ⚠️ **When the hook arrives, the state has not been written yet.**
 *    Measured: `Stop` received at 05:35:44.120; the CLI wrote `status=shell` at **05:35:44.777**.
 *    An implementation that looks immediately **misses it every time** (= says "done" even while running in the background).
 *
 * ⚠️ Only **the send** waits here. The response to the hook is returned first.
 *    `hooks/notify.sh` calls synchronously, so waiting would **delay the end of every turn by that much**.
 */
export const PUSH_SETTLE_MS = 1500

// ★ The wording when the state is unknown is `UNKNOWN_LABEL` in `shared/types.ts` (= "状態不明", state unknown).
//   ⚠️ Do not continue with "could not read → default" (fail-open is forbidden / CLAUDE.md).
//      External review 2026-08-16, high #2: unreadable, account mismatch and timeout were all squashed into "done".
//      That is **exactly the false done notification we are trying to fix**.
//   ⚠️ Renamed from "ターン終了" (turn ended) on 2026-08-21 (the difference from `完了` was not readable).
export { UNKNOWN_LABEL }

/**
 * Decide the wording for the end-of-turn notification from **the state re-read right before sending**.
 *
 * ⚠️ `Stop` only means "Claude's turn ended", **not necessarily that the work is done**.
 *    If a background Bash (`codex exec`) or a subagent is running, it is not finished yet.
 *    Until 2026-08-16 it announced "done" there (fixing only the list left the notification disagreeing).
 */
/**
 * Inputs besides the probe needed to decide the wording.
 *
 * ⚠️⚠️ **Made required.** With defaults, a call that forgets to pass them **silently gives different wording**
 *    (dropping `hooks` turns "done" into "starting"). Make the type catch it.
 */
export interface StateContext {
  /** The session's hook record (`hooksFor`). ⚠️ Take it **after** `noteHook` */
  hooks: SessionHooks | undefined
  /** The transcript's last activity. ⚠️ Used by `resolveStatus` to decide "is the hook after the activity" */
  lastActivity?: string
  /**
   * Whether an approval is pending (`hasPendingApprovalFor` / `isPermissionNotice`).
   * ⚠️ **Set it to true for `Notification/permission` even without a marker** (do not silence the only notification).
   */
  hasPendingApproval?: boolean
}

/**
 * ★★ Notification wording is **built from the list's decision function** (2026-08-21).
 *
 * ⚠️⚠️ **Having the decision in two places was the root of today's bug.** The wording (strings) was shared via `statusLabel`,
 *    but "which state to decide on" was **separate** between `resolveStatus` (the list) and a hand-written
 *    switch here. Comparing exhaustively (96 combinations), **65 disagreed**.
 *
 *    The two with real damage:
 *      - `Notification/idle` was unconditionally "要対応" (needs attention) (the list does not use idle as evidence)
 *      - **approval markers were not checked**, so it could announce "done" while waiting for an answer
 *
 * ⇒ Pass the same inputs to `resolveStatus` and turn its result into wording with `statusLabel`.
 *   **Structurally, they can no longer disagree.**
 *
 * ⚠️ Only `StopFailure` becomes "⚠ 異常終了" (abnormal exit) immediately without looking at the state (abnormalities should be announced as fast as possible).
 *    ⇒ **It disagrees with the list (needs attention) only when there is a marker**. This is an intended difference, pinned by a test.
 * ⚠️ If unreadable, do not assert (fail-open is forbidden). `resolveStatus` can fall to "done" on hooks alone,
 *    so **stop before that**.
 */
export function settledLabel(event: HookEvent, probe: StatusProbe, ctx: StateContext): string {
  // ★ Events that do not look at the state. ⚠️ `SessionEnd` is not in `PUSH_EVENTS` so it never becomes a notification, but
  //   this is explicit so that if it is added, it does not get decided from the state instead of "終了" (ended).
  if (event.event === 'StopFailure' || event.event === 'SessionEnd') return labelFor(event.event)
  // ★ If `Stop` has no `sessionId`, it cannot be probed (`transcript_path` has an unexpected shape).
  //   ⚠️ It used to be `labelFor('Stop')` = "done" (fail-open). **Do not assert**
  //   (`/code-review` 2026-08-21, low #3. Noting that the behavior changed).
  // ★ If the state could not be read, do not fall to "done" on hooks alone
  if (probe.kind === 'unknown') return UNKNOWN_LABEL
  // ★★ **Do not assert unknown statuses either** (2026-08-21).
  //    ⚠️ `resolveStatus` lets unknown values through and makes it `done` based on the Stop hook.
  //       That is, **the list falls to "done" there**. On 2026-08-16, not knowing `shell` caused a real
  //       false "done" notification, so **the notification side stops** (an intended difference / pinned by a test).
  if (probe.kind === 'live' && !isKnownRawStatus(probe.status)) return UNKNOWN_LABEL
  const { status } = resolveStatus(
    probe.kind === 'live' ? probe.status : undefined,
    probe.kind === 'live',
    ctx.hooks,
    // ⚠️ When unknown, use this event's time, so the hook is not misjudged as "old"
    ctx.lastActivity ?? event.at,
    ctx.hasPendingApproval ?? false,
  )
  // ⚠️ Do not assert if unknown states are added
  return statusLabel(status) ?? UNKNOWN_LABEL
}

/**
 * Whether an approval for this session **is pending** right now.
 *
 * ⚠️⚠️ **Do not use `listPending()`** (`/code-review` 2026-08-21, medium #1).
 *    It **hides** approvals within `quietUntil` (from subagents, `QUIET_MS = 6 s`).
 *    Those hidden 6 seconds are exactly the window `Stop` → `PUSH_SETTLE_MS` (1.5 s) passes through, so
 *    **it would ring "done" while waiting for an answer** (the very shape this fix was meant to eliminate).
 *    ⇒ `hasPendingForSession` counts the quiet ones too and excludes settled ones.
 *    Same reason `withPendingPerms` uses a superset.
 */
export function hasPendingApprovalFor(event: HookEvent): boolean {
  return event.sessionId ? hasPendingForSession(event.sessionId) : false
}

/**
 * ★★ **Is this `Notification` the CLI saying "please approve"?**
 *
 * ⚠️⚠️ `/code-review` 2026-08-21, low #4. `resolveStatus` looks at `busy`/`shell`
 *    **before** `hooks.permission` (on the reasoning "busy = no dialog open = that
 *    permission record is old"). But **on this path, the permission is arriving with this very event**.
 *    Passing it as is gives "応答中" (responding) when `busy`, and
 *    `shouldRing` makes it **silent**. ⇒ **The approval request silently disappears.**
 *
 * ⚠️ Moreover, this path is reached only when `shouldPushNotice` let it through as "on machines without the approval hook, ① is the only notification".
 *    **The path that must least be silenced.**
 */
export function isPermissionNotice(event: HookEvent): boolean {
  return event.event === 'Notification' && event.notice === 'permission'
}

/**
 * ★★ **Do not send the same wording twice** (2026-08-21).
 *
 * Why: `Notification/idle` always arrives about 60 seconds after `Stop`, so even when the state had not changed,
 * **two were sent per turn** (measured: `idle` was 18% of all pushes, nearly all duplicates).
 *
 * ⚠️ **Record it only when sending succeeded**. Remembering a failure would discard the next identical state
 *    as a "duplicate", so it **would never arrive**.
 * ⚠️ Events without a sessionId are not collapsed (**when unknown, send**. Do not fall to the silent side).
 * ⚠️ The account is part of the key too (the same sessionId in two accounts would mix states / HANDOFF 3-c).
 * ⚠️ Not written to a file. A restart just sends one extra; it never goes silent.
 */
const LAST_LABEL_MAX = 200

/**
 * ★★ Per session, "the last wording sent successfully" + "the turn at that time" (turn added on 2026-09-21).
 *
 * ⚠️⚠️ **Without turn, it collapsed across turns** (measured / HANDOFF 5.0-bp):
 *    once `完了` (done) was sent, **that session never got another notification**
 *    = the main use on the go (instruct → learn when it is done) did not work from the second time on.
 */
interface LastSent {
  /** ⚠️ Only `promptId`s from `Stop`-type events go here (see `turnOf` below for why) */
  readonly turn?: string
  readonly label: string
}
const lastLabel = new Map<string, LastSent>()

/**
 * ★★ Is this id OK to use as "the turn changed" marker?
 *
 * ⚠️⚠️ **Only those from the end of a turn (`Stop` / `StopFailure`)** are used.
 *    What we want to collapse is the `Notification/idle` arriving about 60 seconds after `Stop`, but
 *    **whether its `prompt_id` is the same value has not been measured**.
 *    ⇒ By not looking at `idle`'s id, **it collapses correctly whether they are the same or not**
 *      (`idle` is treated as "the turn has not changed" and judged by wording alone).
 * ⚠️ A `Stop` without an id is `undefined` = **it falls back to the previous behavior** (no regression).
 */
function turnOf(event: HookEvent): string | undefined {
  if (event.event !== 'Stop' && event.event !== 'StopFailure') return undefined
  return event.promptId
}

function labelKey(event: HookEvent): string | null {
  return event.sessionId ? `${event.account}\0${event.sessionId}` : null
}

/**
 * ★★ The collapsing key is **the status wording itself** (`label` + reason).
 *
 * ⚠️⚠️ codex review 2026-08-21, high #2: it looked only at `label`, so
 *    **`要対応（入力が必要）` (input needed) → `要対応（sandbox の許可）` (sandbox permission)** was judged "the same" and
 *    the second one vanished. The requested action differs, and on machines without the approval hook
 *    **it is the only notification**, so it silently dropped.
 * ⚠️ On the other hand, **never use the whole body as the key**. `ctx 87k` changes every time, so
 *    collapsing would never work (the duplicate 60 seconds after `Stop` would come back).
 */
function stateKey(label: string, qualifier?: string): string {
  return qualifier ? `${label}（${qualifier}）` : label
}

/** Should that wording be sent now? (★ false if it equals the previous one within the same turn) */
export function shouldSendLabel(event: HookEvent, label: string, qualifier?: string): boolean {
  const key = labelKey(event)
  if (!key) return true
  const prev = lastLabel.get(key)
  if (!prev) return true
  // ★★ **If the turn changed, always send** (2026-09-21).
  //   ⚠️⚠️ Without this, once "done" is sent it never appears again for that session.
  const turn = turnOf(event)
  if (turn !== undefined && turn !== prev.turn) return true
  return prev.label !== stateKey(label, qualifier)
}

/** Remember that it was sent. ⚠️ Do not call when sending failed */
export function rememberLabel(event: HookEvent, label: string, qualifier?: string): void {
  const key = labelKey(event)
  if (!key) return
  // ⚠️ The turn marker is updated **only when it comes from a `Stop`-type event** (not overwritten by `idle`)
  const turn = turnOf(event) ?? lastLabel.get(key)?.turn
  const value: LastSent = { ...(turn !== undefined ? { turn } : {}), label: stateKey(label, qualifier) }
  // ⚠️ Discard the oldest so it does not grow without bound (insertion order)
  if (!lastLabel.has(key) && lastLabel.size >= LAST_LABEL_MAX) {
    const oldest = lastLabel.keys().next().value
    if (oldest !== undefined) lastLabel.delete(oldest)
  }
  lastLabel.delete(key)
  lastLabel.set(key, value)
}

/** For tests. Prevents leaking across processes */
export function resetLabelsForTest(): void {
  lastLabel.clear()
}

/**
 * Upper bound for one tag part. ⚠️ Even joining four, keep it well below the push limit (4KB).
 * ⚠️ Even when cut, **the same session always gives the same string** (only cut from the start).
 */
const TAG_PART_MAX = 64

function clipTagPart(part: string): string {
  const t = String(part ?? '')
  return t.length <= TAG_PART_MAX ? t : t.slice(0, TAG_PART_MAX)
}

export function toPushPayload(
  event: HookEvent,
  label = labelFor(event.event),
  fields?: NotifyFields,
): PushPayload {
  // ★★ The wording is built in one place, `notificationText` (2026-08-21, so it never disagrees with the list).
  //   ⚠️ On paths without `fields`, **the title is given up and falls back to the 8-char ID** (never show a false title).
  const text = notificationText(
    fields ?? {
      title: '',
      titleSource: 'fallback',
      sessionId: event.sessionId ?? '',
      project: event.project,
      machine: event.machine,
      account: event.account,
      label,
    },
  )
  return {
    // ⚠️ Conversation-derived strings are handled inside `notificationText` (only ai titles are the exception)
    title: text.title,
    // The time is not put in the body. The Service Worker passes at to the notification's timestamp,
    // and the OS shows it in the device's time zone (slicing the ISO string shows UTC)
    //
    // ★ Always include the machine name (same style as the Discord wording in hooks/notify.sh).
    //   Two machines having the same account and project name happens all the time (both were
    //   working on nyan-remote). Without it you cannot tell which machine from the notification. Actually a problem on 2026-08-12.
    //   It goes in the body rather than the title so that long project names do not truncate the title.
    body: text.body,
    // ★★ Whether to play a sound (2026-08-21). **List only what should be silent; everything else rings**
    //    (falling to silence on unknown wording would let that state go unnoticed by anyone)
    ...(shouldRing(label) ? {} : { silent: true }),
    // ★★ **One slot per session** (user request 2026-08-20: "replace the old one when a new one comes").
    //   `event` used to be appended at the end, so within one turn **完了 (done, Stop)** and
    //   **要対応 (needs attention, Notification/idle, about 1 minute after the turn ends)** piled up as two separate slots.
    //   A session has only one "current state", so **replacing with the newer one is correct**.
    //   ⚠️ `renotify: true` (sw.js) stays. Replacements also ring, so
    //   **you notice it changed from "done → needs attention"** (a requirement the user stated explicitly).
    // ★ Always include the machine. Without it, events from two machines get the same tag, and the Service Worker
    //   replaces the earlier with the later one, so **one disappears** (actually hit on 2026-08-12).
    // ★★ Include the sessionId too (external review 2026-08-16, medium #5).
    //   Without it, **when two sessions are open in the same project**, the one that finishes later
    //   replaces the earlier notification, and **you can no longer reach one of the threads**. ⚠️ Different sessions are different topics,
    //   so they must not be merged.
    // ⚠️⚠️ **Do not mix approvals (`permissionTag`) in here.** Approvals are answered one by one, so
    //   collapsing them **removes the way to answer the second one** (see `agent/src/permission.ts`).
    //   They are a separate family (starting with `perm-`), so this tag must not start with `perm-`.
    // ⚠️⚠️ **Bound the length** (codex review 2026-08-21, medium #5). The display side was bounded, but
    //    the tag took raw values, so a long project name made **the payload exceed 4KB and
    //    not a single notification showed** (measured: a 5000-char `project` gave 15,334 bytes).
    //    ★ The point is that the same session always gets the same tag (= the cutting is deterministic).
    // ⚠️⚠️ **No project name in the tag when the session id is known** (2026-09-25 / seen on Android: 3 notifications for one thread).
    //    `project` is `basename(cwd)` **of each hook call**, and the cwd follows the session into subfolders
    //    (measured: one session reported `nyan-remote` / `account` / `relay` / `web` / `icon-concepts`) ⇒ the tag changed
    //    and the notification stopped replacing. The session id alone identifies the session; the project stays only as the
    //    fallback when there is no id.
    tag: (event.sessionId ? [event.machine, event.account, event.sessionId] : [event.machine, event.account, event.project, '-'])
      .map((part) => clipTagPart(part))
      .join('/'),
    // ⚠️ Do not write it by hand. Dropping the `/` makes the notification open the source of sw.js (see pushUrl.ts)
    url: threadUrl(event.sessionId),
    event: event.event,
    at: event.at,
  }
}

/**
 * Classify the kind of Notification.
 *   permission … asking for approval (really needs action)
 *   idle       … the idle notification (always fires about 1 minute after the turn ends)
 *
 * ✅ Measured 2026-08-11: the payload keys are
 *    session_id / transcript_path / cwd / prompt_id / hook_event_name / message / notification_type
 *    → **`notification_type` is used primarily** (reliable because it does not depend on wording).
 *    Its vocabulary may vary by environment or version, so matching on `message` wording is kept as a backup.
 *
 * ⚠️ Only the classification is stored; the notification body is not (§6.2).
 */
export function classifyNotice(payload: HookPayload): 'permission' | 'idle' {
  const type = typeof payload['notification_type'] === 'string' ? payload['notification_type'] : ''
  const msg = typeof payload['message'] === 'string' ? payload['message'] : ''

  // ⚠️ If either one says "approval", treat it as an approval.
  //
  //    Do not conclude idle from type alone. The notification_type vocabulary is unknown, so
  //    if an approval request's type were e.g. `user_input_required`, it would hit `input` and
  //    miss the approval (a regression, since wording matching would have caught it).
  //    The opposite error (treating an idle notification as an approval) is unlikely because idle wording does not contain permission.
  if (/permission|approval|tool[_-]?use|confirm/i.test(type)) return 'permission'
  if (/permission|approve|allow|confirm/i.test(msg)) return 'permission'
  return 'idle'
}

/** To learn the notification_type vocabulary, log only values seen for the first time (type names only; no body) */
const seenNotificationTypes = new Set<string>()
let loggedNotificationShape = false

export async function hook(ctx: Ctx): Promise<{ ok: true; pushed: number }> {
  const payload = await readJsonBody<HookPayload>(ctx.req)
  const { account, sessionId } = parseTranscriptPath(payload.transcript_path)
  const name = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : 'unknown'
  if (name === 'Notification') {
    if (!loggedNotificationShape) {
      loggedNotificationShape = true
      // Log only the keys (not the body), to check what the classification can rely on
      console.log(t(`[hook] Notification のペイロードのキー: ${Object.keys(payload).join(', ')}`, `[hook] Notification payload keys: ${Object.keys(payload).join(', ')}`))
    }
    const nt = payload['notification_type']
    if (typeof nt === 'string' && !seenNotificationTypes.has(nt)) {
      seenNotificationTypes.add(nt)
      console.log(t(`[hook] 新しい notification_type: ${nt} → ${classifyNotice(payload)}`, `[hook] New notification_type: ${nt} → ${classifyNotice(payload)}`))
    }
  }
  const event: HookEvent = {
    event: name,
    machine: hostname(),
    account: account ?? '(unknown)',
    project: payload.cwd ? basename(payload.cwd) : '—',
    sessionId,
    at: new Date().toISOString(),
    ...(name === 'Notification' ? { notice: classifyNotice(payload) } : {}),
    // ★ The turn's id (so dedup does not cross turns / 2026-09-21)
    ...(typeof payload['prompt_id'] === 'string' ? { promptId: payload['prompt_id'] } : {}),
  }
  // Used as evidence for the list's status display (agents --json cannot tell needs attention / abnormal exit)
  noteHook(event)

  // ★ When a turn ends, all pending approvals for that session are invalid.
  //
  // ⚠️ **Approving on the PC does not close the hook's connection** (measured 2026-08-13), so
  //    unless someone cleans up, **answered cards remain until the timeout (24 hours)**.
  //    Mid-turn cleanup is done by permissionSweep.ts looking at the transcript, but
  //    once Stop arrives (the main agent's approvals) are invalid, so remove them for sure here.
  //
  // ⚠️⚠️ **Those from subagents (teammates) are not removed** (excluded inside `abandonSession`).
  //    `/code-review` teammates **keep running after the main turn ends**, so
  //    their approvals are still alive. Removing them creates "a notification arrives but there is no button to answer",
  //    making it impossible to recover from outside (it actually hung twice on a real device on 2026-08-16).
  if (event.event === 'Stop' || event.event === 'StopFailure') {
    const n = abandonSession(sessionId)
    if (n > 0) console.log(t(`[perm] ターン終了で ${n} 件の承認待ちを片付けた`, `[perm] Cleared ${n} pending approvals at end of turn`))
  }
  // ★ The session ended (/exit etc.) ⇒ turn its auto-approve off (2026-09-26 / user report).
  //   ⚠️ Without this the entry lived until its expiry (3 or 24 hours), and the phone kept a row for the ended session
  //      (`applyAutoApprove` shows every live entry, on purpose: hiding marks by the index is forbidden / CLAUDE.md §2).
  //   ★ Turning off is the safe direction. A later `--resume` of the same session starts without auto-approve.
  //   ⚠️ The id falls back to the payload's `session_id` like approvals do (`buildPermissionInfo`): a config directory outside
  //      `~/.claude*` makes the transcript path unparseable, yet auto-approve still works there (codex).
  //   ⚠️ Queued unconditionally; whether there is an entry is decided inside the chain (an "on" still saving must not be missed / codex).
  const endedId = event.event === 'SessionEnd' ? (sessionId ?? sessionIdOf(payload['session_id'])) : undefined
  if (endedId) {
    const r = await endSessionAutoApprove(endedId)
    if (!r.ok) {
      console.log(t(`[auto] セッション終了で自動承認を切れなかった（${endedId.slice(0, 8)}）: ${r.reason}`, `[auto] Session ended, but auto-approve could not be turned off (${endedId.slice(0, 8)}): ${r.reason}`))
    } else if (r.had) {
      console.log(t(`[auto] セッション終了で自動承認を切った（${endedId.slice(0, 8)}）`, `[auto] Session ended; auto-approve turned off (${endedId.slice(0, 8)})`))
    }
  }
  await appendJsonl('hooks.jsonl', event)
  broadcast({ type: 'hook', hook: event })
  broadcast({ type: 'sessions-changed', at: event.at })

  // ★★ The end-of-turn notification is sent **after a short wait** (read the explanation in stopPush.ts).
  //    ⚠️ Only the send waits. The response is not held here (the hook is called synchronously).
  //    ⚠️ Without a sessionId there is no wait (duplicates cannot be judged). It falls through to the immediate send below.
  if (
    event.event === 'Stop' &&
    shouldPushNotice(event, await isPermissionHookInstalled(account)) &&
    scheduleStopPush(event, stopPushDeps())
  ) {
    console.log(
      t(
        `[hook] ${event.account} ${event.project} — Stop (${PUSH_SETTLE_MS}ms 後に状態を見て通知)`,
        `[hook] ${event.account} ${event.project} — Stop (checking state and notifying in ${PUSH_SETTLE_MS}ms)`,
      ),
    )
    return { ok: true, pushed: 0 }
  }

  let pushed = 0
  let skipped = ''
  // ★ Log what was sent and on what basis (2026-08-21).
  //   ⚠️ This used to log only `event.event`, so **the source of a "needs attention" seen on a real device
  //      could not be identified from the log**. Diagnosis needs "the wording" and "the basis for deciding it".
  let sentLabel = ''
  if (shouldPushNotice(event, await isPermissionHookInstalled(account))) {
    // ⚠️ **Do not turn /hook into a 500 because of a notification failure** (external review 2026-08-14, low).
    //    For example, if vapid.json is corrupt, ensureVapid() throws. By this point
    //    state recording and broadcast are done, and returning 500 violates the contract "other features keep working",
    //    and the cause also turns into `internal error` and never reaches the screen.
    try {
      // ★★ `Notification` decides its wording after looking at the state (never "needs attention" unconditionally).
      //    ⚠️ `StopFailure` does not look at the state here (see settledLabel).
      const probe = event.event === 'Notification' ? await probeStatus(event) : { kind: 'unknown' as const }
      const meta = await readNotifyMeta(event.account, event.sessionId)
      // ★★ **Keep the two apart** (`/code-review` 2026-08-21, low #4).
      //   `card`    … we sent "承認待ち (tool name)" = the state notification may be skipped
      //   `waiting` … an approval is pending = the wording should be "要対応" (needs attention)
      //   ⚠️ Mixing them either **skips a `Notification/permission` without a marker (= the only notification)**,
      //      or **silences it as "responding"** — silenced either way.
      const card = hasPendingApprovalFor(event)
      const waitingApproval = card || isPermissionNotice(event)
      const label = settledLabel(event, probe, {
        // ⚠️ This is after `noteHook(event)`, so this event itself is included
        hooks: event.sessionId ? hooksFor(event.sessionId) : undefined,
        ...(meta?.lastActivity ? { lastActivity: meta.lastActivity } : {}),
        hasPendingApproval: waitingApproval,
      })
      // ⚠️ Log the basis too (to distinguish whether the CLI said `waiting` or we decided it)
      sentLabel = ` ${logLabel(label)} [notice=${event.notice ?? '-'} probe=${
        probe.kind === 'live' ? `live/${probe.status ?? '?'}${probe.waitingFor ? `/${probe.waitingFor}` : ''}` : probe.kind
      } ${t(`札=${card ? '有' : '無'}`, `card=${card ? 'yes' : 'no'}`)}]`
      // ★ The reason is built **before the collapsing check** (so that `要対応（入力が必要）` and
      //   `要対応（sandbox の許可）` are not treated as "the same" / codex high #2)
      const why =
        label === statusLabel('waiting') && probe.kind === 'live'
          ? waitingReason(probe.waitingFor)
          : null
      if (card) {
        // ★★ If there is an approval marker, **do not send the state notification** (same idea as `shouldPushNotice`).
        //    "承認待ち (Bash)" is better (it shows the tool name, can be answered, and gets cleaned up).
        //    ⚠️ Still **remember the wording** (otherwise the "done" after answering is dropped as a duplicate)
        rememberLabel(event, label, why ?? undefined)
        skipped = t(' 承認の札があるので状態の通知は省略', ' skipped the state notification because an approval card is open')
      } else if (!shouldSendLabel(event, label, why ?? undefined)) {
        // ★ The state has not changed = nothing to announce (the idle 60 seconds after `Stop` is this)
        skipped = t(` （${logLabel(label)} は直前と同じなので送らない）`, ` (not sent: ${logLabel(label)} is the same as last time)`)
      } else {
        const fields = fieldsFrom(
          {
            machine: event.machine,
            account: event.account,
            project: event.project,
            sessionId: event.sessionId,
            label,
            ...(why ? { qualifier: why } : {}),
          },
          meta,
        )
        const result = await sendToAll(withPendingPerms(toPushPayload(event, label, fields)))
        pushed = result.sent
        // ⚠️ Remember only when sent (remembering a failure means the next identical state never arrives)
        if (result.sent > 0) rememberLabel(event, label, why ?? undefined)
        // ⚠️ Log that some devices failed (because collapsing suppresses the next one / codex medium #4)
        if (result.failed > 0) {
          skipped =
            skipped +
            t(
              ` ⚠️ ${result.failed}台に送れていない（次の状態変化まで再送しない）`,
              ` ⚠️ not delivered to ${result.failed} devices (no retry until the next state change)`,
            )
        }
        // ★ Do not mix "no destinations" with "broken, cannot send" (so the log can tell them apart)
        if (result.unavailable) skipped = ` ⚠️ ${result.unavailable}`
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      skipped = t(` ⚠️ 通知を送れませんでした: ${msg}`, ` ⚠️ could not send the notification: ${msg}`)
      console.error(t(`[push] 送信できません: ${msg}`, `[push] Cannot send: ${msg}`))
    }
  } else if (event.event === 'Notification' && event.notice === 'permission') {
    // The approval hook shows "承認待ち · <tool> @<machine>", so this side does not
    skipped = t(' 承認は PermissionRequest 側で通知するので省略', ' skipped: approvals are notified by the PermissionRequest hook')
  }
  console.log(
    `[hook] ${event.account} ${event.project} — ${event.event}${sentLabel} (push=${pushed})${skipped}`,
  )
  return { ok: true, pushed }
}

/**
 * ★ Re-read whether the session is doing something in the background right now.
 *
 * ⚠️ `liveSessions()` caches for 2 seconds. The point here is "re-read right after the hook", so
 *    **the cache is bypassed** (going through it would defeat the purpose of waiting).
 * ⚠️ If the process is dead, background Bash is dead too → `gone` (= really done).
 * ⚠️⚠️ **Do not treat "could not read" as "finished"** (fail-open is forbidden / external review, high #2).
 *    When the account is not found, **do not read other accounts** (if the same sessionId exists
 *    in another account, the wording would be decided from someone else's state).
 */
export async function probeStatus(event: HookEvent): Promise<StatusProbe> {
  if (!event.sessionId) return { kind: 'unknown' }
  try {
    const dirs = await discoverConfigDirs(config().configDirs)
    const dir = dirs.find((d) => d.account === event.account)
    // ★ Do not assert for an account of unknown origin
    if (!dir) return { kind: 'unknown' }
    const read = await readIndexEntriesDetailed(dir)
    // ★ null means "could not read" (no sessions/). Different from an empty array
    if (!read) return { kind: 'unknown' }
    const live = selectLive(read.entries, aliveProcStartSync).find(
      (a) => a.sessionId === event.sessionId,
    )
    if (live) {
      return {
        kind: 'live',
        status: live.status,
        // ★ The reason for "needs attention". ⚠️ Only when the CLI says `waiting` (do not fabricate)
        ...(live.status === 'waiting' && live.waitingFor ? { waitingFor: live.waitingFor } : {}),
      }
    }
    // ★★ **Distinguish "gone" from "only that index could not be read"** (codex 2026-08-21, high #3).
    //    ⚠️⚠️ The index is `<pid>.json`, so **you cannot tell which file belongs to the session**.
    //       If even one could not be read, the session we are looking for might have been that one.
    //       Returning `gone` makes `resolveStatus` assert "done" based on the latest `Stop`
    //       = **it announces "done" for a running session** (fail-open).
    return read.skipped > 0 ? { kind: 'unknown' } : { kind: 'gone' }
  } catch {
    return { kind: 'unknown' }
  }
}

/** Send the end-of-turn notification (the wording is decided from the re-read state) */
export async function sendSettled(event: HookEvent, probe: StatusProbe): Promise<void> {
  try {
    // ★ Read the inputs only once (used for both deciding the wording and displaying it)
    const meta = await readNotifyMeta(event.account, event.sessionId)
    const card = hasPendingApprovalFor(event)
    const label = settledLabel(event, probe, {
      // ⚠️ This is after `noteHook(event)`, so this event itself is included
      hooks: event.sessionId ? hooksFor(event.sessionId) : undefined,
      ...(meta?.lastActivity ? { lastActivity: meta.lastActivity } : {}),
      hasPendingApproval: card || isPermissionNotice(event),
    })
    const basis = `[probe=${
      probe.kind === 'live' ? `live/${probe.status ?? '?'}${probe.waitingFor ? `/${probe.waitingFor}` : ''}` : probe.kind
    } ${t(`札=${card ? '有' : '無'}`, `card=${card ? 'yes' : 'no'}`)}]`

    // ★ The reason for "needs attention" is added only in this state (adding it elsewhere would be a lie).
    //   ⚠️ Build it **before the collapsing check** (so things with different reasons are not "the same" / codex high #2)
    const why =
      label === statusLabel('waiting') && probe.kind === 'live'
        ? waitingReason(probe.waitingFor)
        : null
    if (card) {
      // ★★ If there is an approval marker, do not send the state notification ("承認待ち (tool name)" is better).
      //    ⚠️ Still remember the wording (so the "done" after answering is not dropped as a duplicate)
      rememberLabel(event, label, why ?? undefined)
      console.log(
        t(
          `[hook] ${event.account} ${event.project} — ${logLabel(label)} ${basis} 承認の札があるので省略`,
          `[hook] ${event.account} ${event.project} — ${logLabel(label)} ${basis} skipped because an approval card is open`,
        ),
      )
      return
    }
    if (!shouldSendLabel(event, label, why ?? undefined)) {
      console.log(
        t(
          `[hook] ${event.account} ${event.project} — ${logLabel(label)} ${basis} 直前と同じなので送らない`,
          `[hook] ${event.account} ${event.project} — ${logLabel(label)} ${basis} not sent: same as last time`,
        ),
      )
      return
    }
    const fields = fieldsFrom(
      {
        machine: event.machine,
        account: event.account,
        project: event.project,
        sessionId: event.sessionId,
        label,
        ...(why ? { qualifier: why } : {}),
      },
      meta,
    )
    const result = await sendToAll(withPendingPerms(toPushPayload(event, label, fields)))
    if (result.sent > 0) rememberLabel(event, label, why ?? undefined)
    // ⚠️ Log that some devices failed (because collapsing suppresses the next one / codex medium #4)
    const partial =
      result.failed > 0 ? t(` ⚠️ ${result.failed}台に送れていない`, ` ⚠️ not delivered to ${result.failed} devices`) : ''
    const extra = (result.unavailable ? ` ⚠️ ${result.unavailable}` : '') + partial
    console.log(
      `[hook] ${event.account} ${event.project} — ${logLabel(label)} ${basis} (push=${result.sent})${extra}`,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(t(`[push] 送信できません: ${msg}`, `[push] Cannot send: ${msg}`))
  }
}

/** Wiring for the delayed send. ⚠️ Kept in this one place so tests can swap it out */
export function stopPushDeps(): StopPushDeps {
  return { probe: probeStatus, send: sendSettled, delayMs: PUSH_SETTLE_MS }
}
