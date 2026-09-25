// Holding pending approvals, and answers from the phone (M4-1 / ARCHITECTURE.md §9.8).
//
// ★ How it works (all confirmed by measurement; the docs were wrong three times):
//
//   ① When approval is needed, Claude Code's `PermissionRequest` hook fires.
//      It does not fire for auto-approved tool calls, so everyday speed is unaffected
//   ② The hook POSTs to the agent's /permission with `type: "http"` (no script needed)
//   ③ The agent **waits without responding**. Meanwhile it sends a push
//   ④ When the phone taps, the decision is returned as that response
//        {"hookSpecificOutput":{"hookEventName":"PermissionRequest",
//          "decision":{"behavior":"allow"}}}
//      ⚠️ Not `permissionDecision`. The implementation looks at `decision.behavior`, and
//         **anything other than `allow` is treated as deny** (confirmed by reading the 2.1.228 binary directly).
//         The correct shape is the same as the SDK's `canUseTool`, and was in ARCHITECTURE.md §9.3 all along
//   ⑤ **The prompt is also shown on the PC**, so answering on the PC first is fine (measured).
//      ⚠️⚠️ **But the hook's connection is not cut** (measured 2026-08-13; what I wrote before,
//      "it gets killed", was wrong). The agent keeps waiting even when answered on the PC, so
//      **`permissionSweep.ts` looks at the transcript and clears the card**.
//      The timeout is 24 hours, so without it, finished cards would stay for 24 hours
//   ⑥ Finishing without a decision proceeds with the normal flow (= left to the PC; measured)
//
// ⚠️ Exception (2026-08-14): only for approvals from sub-agents, **whether to show it** is delayed a few seconds by a timer
//   (`quietUntil`). ⚠️ The rule below — **decisions and liveness are not handled by timers** — still stands.
//
// ⚠️⚠️ **Never manage this with timers. The connection's liveness is the only truth.**
//   That the hook died (timed out, approved on the PC, session ended)
//   is known from the HTTP connection closing. Guessing with timers causes the mismatch
//   "I pressed approve on the phone but the place to answer is dead".
//
// ⚠️ The hook can fire multiple times for the same approval (measured). Without idempotency via
//   `prompt_id` + `tool_use_id`, the same approval goes to the phone repeatedly and waiters leak.

import { createHash, randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { basename } from 'node:path'
import {
  legacySuggestionText,
  MAX_MESSAGE_BYTES,
  type PermissionSuggestion,
  type PermissionRequest,
  type PushPayload,
  permissionTag,
} from '../../shared/types.ts'
import { ASK_USER_QUESTION, EXIT_PLAN_MODE } from './claude/interaction.ts'
import { t } from '../../shared/i18n.ts'

export type Behavior = 'allow' | 'deny'

/**
 * ★★ The decision returned to the hook.
 *
 * ⚠️ `updatedInput` is **not decoration**. For tools where `requiresUserInteraction()` is true
 *    (`AskUserQuestion` / `ExitPlanMode`), the CLI **silently discards an `allow` without
 *    `updatedInput`** (showed up on a real device on 2026-08-14 as "pressing it does nothing").
 *    How its contents are built and validated: `claude/interaction.ts`. **Never take it directly from the phone.**
 */
export interface Decision {
  behavior: Behavior
  updatedInput?: Record<string, unknown>
  /**
   * ★ The reason for denial (equivalent to `3. Tell Claude what to change` on the PC).
   * The CLI uses a deny's `message` as **the denial reason passed to the model** (confirmed in the implementation).
   * ⚠️ Not attached to allow (it is not read)
   */
  message?: string
}

interface Pending {
  info: PermissionRequest
  /** Resolved when a decision arrives. Resolving with undefined means "no decision" = left to the PC */
  resolve: (decision: Decision | undefined) => void
  settled: boolean
  /** Used for cleanup decisions (not exposed in the API; read by permissionSweep.ts) */
  meta?: PendingMeta
  /**
   * ★★ **Not shown** until this time (epoch ms). Used for approvals from sub-agents.
   *
   * ⚠️ Why (the user hit this on a real device on 2026-08-14):
   *   With sub-agents, as in `/code-review`, **the hook fires as soon as the sub-agent's check
   *   decides to "ask"**. But in many cases that request is then
   *   **approved automatically on the main side and proceeds**. The hook's connection is not cut, so
   *   **approvals that need no answer are notified to the phone and their cards stay**.
   *
   * ⚠️ Yet **sub-agent approvals must not be hidden across the board.** When a human decision is really
   *   needed, hiding it leaves **no way to answer from the phone, and it stalls unnoticed**
   *   (the failure this tool most wants to avoid). → **Wait silently for a few seconds, and show it if it is still there.**
   */
  quietUntil?: number
}

/**
 * Information needed to clean up a card.
 *
 * ⚠️ Why: **approving on the PC does not cut the hook's connection** (found by measurement on 2026-08-13;
 *   what I wrote before, "it is cut", was wrong). The timeout is 24 hours, so
 *   left alone, **an already-answered approval card stays on the phone for 24 hours**.
 *   → Look at the transcript, confirm "that tool already ran", and clear it (permissionSweep.ts).
 */
export interface PendingMeta {
  /** That session's transcript (it is in the hook payload) */
  transcriptPath?: string
  /**
   * ★ `agent_id` if from a sub-agent.
   *
   * ⚠️ **`transcriptPath` alone is not enough to clean up.** A sub-agent's `tool_use` /
   *    `tool_result` are **not in** the main transcript (a separate file).
   *    How to locate it: `claude/subagentTranscript.ts` (measured 2026-08-14)
   */
  agentId?: string
  /** Tool arguments. Used to match against the transcript's tool_use */
  toolInput?: unknown
}

const pending = new Map<string, Pending>()

/**
 * Uniquely identifies the same approval. Even if the hook fires multiple times, there is one card.
 *
 * ⚠️⚠️ **`prompt_id` is one per "user turn", not per tool call.**
 *   Confirmed on a real device on 2026-08-13 (machine B's journal):
 *
 *     14:38:54 [perm] allow key=8b504117-c48…
 *     14:47:24 [perm] allow key=8b504117-c48…   ← 9 minutes later, a different tool call, same key
 *     14:50:23 [perm] allow key=8b504117-c48…   ← another 3 minutes later, same key
 *
 *   And **the `PermissionRequest` payload has no `tool_use_id`**
 *   (confirmed the same day on a live one via `/permissions`; only `promptId` was there).
 *
 *   So using `prompt_id` as the key makes **all approvals lined up in the same turn the same card**.
 *   `waitForDecision` folds the older one with the same key as "no decision", so
 *   **one of the parallel tool calls falls to the PC without ever showing on the phone** (= "some never show").
 *   The notification `tag` is also built from the key, so **the second notification replaces and erases the first**.
 *
 * → Distinguish them by a fingerprint built from the tool name and arguments. Re-entry of the same approval has an identical payload,
 *   so the fingerprint is the same too, and **idempotency is preserved**.
 *
 * ⚠️ If **exactly the same tool with the same arguments** comes twice in the same turn, this value is the same.
 *    ★ So **this can only be used to decide "is it the same approval", never as the address of an answer**.
 *    The address uses the generation that `withGeneration` adds (see the notes below).
 */
export function keyOf(p: {
  promptId?: string
  toolUseId?: string
  sessionId?: string
  toolName?: string
  toolInput?: unknown
  /**
   * ★ The sub-agent's identifier (`agent_id`).
   *
   * ⚠️ Without it, **when different sub-agents ask the same command in the same turn**,
   *    the two are folded into one card (`/code-review` runs similar agents side by side, so
   *    the same commands like `git status` overlap). The folded one is
   *    ended by `waitForDecision` with "no decision" and **falls to the PC without showing on the phone**.
   *    The notification `tag` is also built from the key, so **one notification erases the other**.
   *    → It only ever separates, so including it is always safe.
   */
  agentId?: string
}): string {
  // if tool_use_id is ever added to the payload, it is the most accurate, so prefer it
  if (p.toolUseId) return p.toolUseId
  const fp = fingerprint(p.toolName, p.toolInput)
  // requests from the main agent keep the same shape as before (no needless differences)
  const scoped = p.agentId ? `${p.agentId}:${fp}` : fp
  if (p.promptId) return `${p.promptId}:${scoped}`
  return `${p.sessionId ?? 'unknown'}:${scoped}`
}

/**
 * Fingerprint of a tool call. **The same call must always give the same value** (the foundation of idempotency).
 * ⚠️ `JSON.stringify` output depends on key order, so the order is fixed first.
 * ★ Also used to match against the transcript's `tool_use` (permissionSweep.ts).
 */
export function fingerprint(toolName: string | undefined, input: unknown): string {
  const text = `${toolName ?? '?'}\0${stableJson(input)}`
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/**
 * ★★ Attaches a per-waiter generation. **This is what guarantees "the answer goes to the card you pressed".**
 *
 * ⚠️⚠️ Without a generation, **an old card's "allow" goes to a different request** (the ABA problem;
 *   pointed out in the 2026-08-13 external review and reproduced in the real code):
 *
 *     ① approval A waits (key = fingerprint). A card appears on the phone
 *     ② A ends (answered on the PC / connection closed)
 *     ③ approval B for **the same command in the same turn** arrives → same key, so the same card
 *     ④ pressing "allow" on **A's card** still on the phone → **B receives allow**
 *
 *   ★ "Same command, same judgement" does not hold. **A was denied but B runs**,
 *     **allowed once but runs twice** happen. Approval leads directly to arbitrary command execution, so
 *     "what was pressed and what is answered differ" must never be allowed.
 *
 * ★ The generation is **put inside the key**. That way the PWA only needs to send the key back as an opaque value,
 *   and neither the protocol nor the client changes (approvals do not break across version skew).
 */
export function withGeneration(dedupeKey: string): string {
  return `${dedupeKey}#${randomBytes(6).toString('hex')}`
}

/** Drops the generation, returning the value used to decide "is it the same approval" */
export function baseKey(key: string): string {
  const i = key.lastIndexOf('#')
  return i < 0 ? key : key.slice(0, i)
}

/** Sorts keys before converting to JSON (so the fingerprint does not depend on order) */
function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  const o = v as Record<string, unknown>
  const body = Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(',')
  return `{${body}}`
}

/**
 * Approvals waiting to be shown.
 * ⚠️ **Those waiting quietly (`quietUntil`) are not shown** (read the notes on Pending).
 */
export function listPending(now = Date.now()): PermissionRequest[] {
  return [...pending.values()].filter((p) => !isQuiet(p, now)).map((p) => p.info)
}

function isQuiet(p: Pending, now: number): boolean {
  return p.quietUntil !== undefined && p.quietUntil > now
}

/**
 * ★★ Number of approvals waiting quietly.
 *
 * ⚠️ **Add this too when deciding whether a restart is OK** (2026-08-14 review, medium).
 *    `listPending()` excludes the quiet ones, so if `npm run pending` looked only at it,
 *    **it would answer "pending approvals: none" for 6 seconds and restart, killing a live approval**.
 *    That is exactly the accident CLAUDE.md calls "the worst accident".
 */
export function quietCount(now = Date.now()): number {
  return [...pending.values()].filter((p) => !p.settled && isQuiet(p, now)).length
}

/**
 * Whether that session still has approvals waiting.
 * ⚠️ **Quietly waiting ones are counted too** (they are just not shown; they are waiting for an answer).
 */
export function hasPendingForSession(sessionId: string): boolean {
  return [...pending.values()].some((p) => !p.settled && p.info.sessionId === sessionId)
}

/** Approvals shown at least once (baseKey). Remembered so re-entry does not hide them again */
const promotedOnce = new Set<string>()

/**
 * Makes it wait quietly (from a sub-agent; automatically shown after ms).
 *
 * ⚠️ **Once shown, never hidden again** (2026-08-14 review, low).
 *    The hook can fire multiple times for the same approval. If **a card vanishes for 6 seconds**
 *    in front of someone who opened it from a notification, it looks like there is no way to answer.
 * ⚠️ Do not touch it if the generation (`#…`) differs. Same rule as `answer` / `abandon` / `promoteQuiet`
 *    (it was missing only here. It is called synchronously now so it cannot happen, but **with a single await in between
 *    it would silently hide a different, newer request**).
 */
export function holdQuiet(key: string, ms: number, now = Date.now()): void {
  const base = baseKey(key)
  if (promotedOnce.has(base)) return
  const entry = pending.get(base)
  if (!entry || entry.settled || entry.info.key !== key) return
  entry.quietUntil = now + ms
}

/**
 * Shows something that was waiting quietly.
 * @returns true if it is still waiting and was actually shown (= notify here)
 */
export function promoteQuiet(key: string): boolean {
  const base = baseKey(key)
  const entry = pending.get(base)
  if (!entry || entry.settled || entry.info.key !== key) return false
  if (entry.quietUntil === undefined) return false
  entry.quietUntil = undefined
  // ★ from now on this approval is never hidden (so hook re-entry does not make the card vanish)
  promotedOnce.add(base)
  return true
}

export function pendingCount(): number {
  return pending.size
}

/**
 * Registers an approval and waits.
 *
 * @param onAbort registration function called when the caller (the hook's connection) closes
 * @returns the decision. undefined means return "no decision" (proceed with the PC's normal flow)
 */
export function waitForDecision(
  info: PermissionRequest,
  registerAbort: (onAbort: () => void) => void,
  meta?: PendingMeta,
): Promise<Decision | undefined> {
  // ★ cards are looked up by the value without the generation (re-entries of the same approval fold into one card).
  //   the answer's address is matched against info.key (with the generation) (read answer)
  const key = baseKey(info.key)

  // if the same approval is already waiting, end the old one with "no decision" and replace it.
  // ⚠️ the old one is discarded, because only the new connection can still receive a decision
  // ⚠️ do not set settled yourself; resolve (= finish) manages it.
  //    setting it first makes finish return early and **the Promise never resolves**
  //    (my own test hung on this during implementation)
  const existing = pending.get(key)
  if (existing && !existing.settled) existing.resolve(undefined)

  return new Promise<Decision | undefined>((resolve) => {
    const entry: Pending = { info, resolve, settled: false, meta }
    pending.set(key, entry)

    const finish = (decision: Decision | undefined): void => {
      if (entry.settled) return
      entry.settled = true
      // remove only if we are still the latest registrant (do not touch if replaced)
      if (pending.get(key) === entry) {
        pending.delete(key)
        // ⚠️ discard the "shown once" marker too (keeping it grows memory forever)
        promotedOnce.delete(key)
      }
      resolve(decision)
    }

    entry.resolve = finish

    // ★ remove the card when the connection closes. This is the only way to prevent mismatches
    registerAbort(() => finish(undefined))
  })
}

/**
 * An answer from the phone. false if there is no one to answer (= too late).
 *
 * ⚠️⚠️ **Do not answer unless the generation matches too.**
 *   If the same command comes twice in the same turn the fingerprint matches, so without this
 *   **an old card's "allow" goes to a different request that came later** (read the notes on withGeneration).
 *   On mismatch it returns false and the UI says "it can no longer be answered" (never shown as a silent success).
 */
export function answer(
  clientKey: string,
  behavior: Behavior,
  extra?: Pick<Decision, 'updatedInput' | 'message'>,
): boolean {
  const entry = pending.get(baseKey(clientKey))
  if (!entry || entry.settled) return false
  // ★ confirm that the pressed card and the request waiting now are the same
  if (entry.info.key !== clientKey) return false
  entry.resolve({
    behavior,
    ...(extra?.updatedInput ? { updatedInput: extra.updatedInput } : {}),
    // ⚠️ the reason is only for deny. The CLI does not read it on allow
    ...(behavior === 'deny' && extra?.message ? { message: extra.message } : {}),
  })
  return true
}

/**
 * ★★ The JSON returned to the hook. **This shape is the only contract** (the measurement in ④ above).
 *
 * ⚠️ The official docs described a different shape three times in a row (`permissionDecision` /
 *    `decision.permissionDecision`). **Only measurements can be trusted.**
 *    The CLI implementation looks at `decision.behavior`, and anything other than `allow` is treated as deny.
 *
 * ⚠️ If the shape changes it becomes **a silent failure**: "I pressed it on the phone but the PC does nothing".
 *    It is pinned by tests, so a Claude Code update that breaks it will be noticed.
 *
 * @param behavior undefined means no decision is returned (= left to the PC's normal flow)
 */
export function decisionResponse(decision: Decision | undefined): Record<string, unknown> {
  if (decision === undefined) return {}
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: decision.behavior,
        // ★ attached only when present. **Never attached when not allow**
        //   (the CLI only reads it on allow / confirmed in the 2.1.232 implementation)
        ...(decision.behavior === 'allow' && decision.updatedInput
          ? { updatedInput: decision.updatedInput }
          : {}),
        // ★ the reason for denial. The CLI passes it to the model (= "fix it like this" gets through)
        ...(decision.behavior === 'deny' && decision.message
          ? { message: decision.message }
          : {}),
      },
    },
  }
}

/**
 * ★★ Notification tags of approvals **waiting for an answer** now (passed to the PWA's cleanup / 2026-08-20).
 *
 * ⚠️⚠️ **Always a superset.** `listPending()` excludes **quietly waiting ones** (`quietUntil`),
 *    so **it must not be used**. Excluding them would make the notification of an approval that went back
 *    to quiet after being shown look "no longer waiting", and **it would be closed**.
 *    ⇒ Fix the direction of error: **only over-inclusion (failing to close) is allowed.**
 */
export function pendingPermTags(machine?: string): string[] {
  const tags = new Set<string>()
  for (const p of pending.values()) {
    if (p.settled) continue
    // ★ make the advertised machine match the list contents (2026-08-20 `/code-review` low #3).
    //   ⚠️ if they disagree, the sw falls toward "close all of that machine's notifications"
    if (machine !== undefined && p.info.machine !== machine) continue
    tags.add(permissionTag(p.info.machine, p.info.key))
  }
  return [...tags]
}

/**
 * ★ Adds "the sending machine" and "tags of waiting approvals" to the push payload.
 *
 * ⚠️ **If it does not fit the limit, do not attach tags** (a truncated list is dangerous for the reason above).
 *    The Web Push limit is 4KB, so 3000 bytes is used with a margin.
 */
export const PUSH_PAYLOAD_SAFE_BYTES = 3000

export function withPendingPerms(payload: PushPayload, machine = hostname()): PushPayload {
  // ★★ **Do not attach the list to a payload without `at`** (2026-08-20 codex high #3).
  //    The sw decides "do not close notifications newer than the list" by `at`, so without `at`
  //    order cannot be kept (falling back to the device clock **closes live notifications**).
  //    ⇒ Structurally stop callers forgetting it, here.
  if (!payload.at) return { ...payload, machine }
  const withTags: PushPayload = { ...payload, machine, pendingPerms: pendingPermTags(machine) }
  if (Buffer.byteLength(JSON.stringify(withTags), 'utf8') <= PUSH_PAYLOAD_SAFE_BYTES) return withTags
  return { ...payload, machine }
}

/** Extracts only what cleanup decisions need (used by permissionSweep.ts) */
export function pendingWithMeta(): { info: PermissionRequest; meta?: PendingMeta }[] {
  return [...pending.values()]
    .filter((p) => !p.settled)
    .map((p) => ({ info: p.info, meta: p.meta }))
}

/**
 * Discards a card that is "no longer needed". **Returns no decision** (= left to the PC's normal flow).
 *
 * ⚠️ Never return deny. That would return deny for something already allowed on the PC, and
 *    depending on timing it could **do the opposite of what the user intended**.
 */
export function abandon(key: string): boolean {
  const entry = pending.get(baseKey(key))
  if (!entry || entry.settled) return false
  // a different generation means it has already been replaced by another request (do not touch)
  if (entry.info.key !== key) return false
  entry.resolve(undefined)
  return true
}

/** Discards all of that session's cards (Stop arrived = the turn ended, so all are invalid) */
export function abandonSession(sessionId: string | undefined): number {
  if (!sessionId) return 0
  let n = 0
  for (const entry of [...pending.values()]) {
    if (entry.settled || entry.info.sessionId !== sessionId) continue
    // ★★ keep those from sub-agents (teammates). **They keep running after the main turn ends.**
    //
    // ⚠️ this caused `/code-review` to hang twice on a real device on 2026-08-16. Log sequence:
    //      08:00:05 approval request from a sub-agent (general-purpose)
    //      08:00:11 approval wait notified push=2            ← "needs attention" on the phone
    //      08:00:51 cleared 1 pending approval at turn end    ← ★ we discarded the card here
    //    → the notification arrives but **the thread has no approve button** (the way to answer is gone).
    //      The session stalls waiting for approval on the PC and cannot be recovered while away.
    //    ⚠️ what I wrote here before, "by the time Stop arrives it is certainly invalid", was **wrong**.
    if (entry.info.agentType) continue
    entry.resolve(undefined)
    n++
  }
  return n
}

/** For tests. Clears in-process state */
export function resetPending(): void {
  // ⚠️ let resolve manage settled (see the comment above)
  for (const entry of [...pending.values()]) {
    if (!entry.settled) entry.resolve(undefined)
  }
  pending.clear()
  promotedOnce.clear()
}

// ── Display formatting (no side-effecting imports, so easy to test) ──────────

const SUMMARY_MAX = 400

/**
 * ★ Upper bound for the "full text" (`detail`) opened from a card.
 *
 * It is for seeing what lies past the "…" of `summary`, so it is made much larger than that.
 * ⚠️ Not unlimited. `/permissions` returns **all** waiting approvals, so
 *    several long heredocs piling up would bloat the response accordingly.
 */
const DETAIL_MAX = 8000

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * What the display is built from.
 *
 * ⚠️ `list` is **kept per question**. Joining into one string and splitting again makes
 *    **newlines inside a question turn into question separators** (2026-08-18 /code-review low #3).
 */
type Raw =
  | { kind: 'text'; text: string }
  /** A question with choices (`AskUserQuestion`) */
  | { kind: 'list'; items: string[] }
  /** Unknown tools / MCP. The shape of their contents is unknown, so JSON is the only way to show them */
  | { kind: 'json'; value: Record<string, unknown> }

/**
 * Chooses what the display is built from (the shape of `tool_input` differs per tool).
 *
 * ★★ So that `summarize` (the folded line) and `detailOf` (the opened full text) **always look at the same thing**,
 *    the choice is made in this one place. Choosing separately could show "different things folded vs. opened"
 *    = **what you looked at and approved differs from what actually runs**, the worst possible shape.
 */
/**
 * ★★ Only **tools whose content shape is known** are folded into a one-line gist.
 *
 * ⚠️⚠️ **Decide by tool name, not by key name.**
 *    If an MCP tool happens to have `command`, **other fields such as `target: production` or `force: true`
 *    vanish from the card** (2026-08-18 codex review, high #1;
 *    reproduced with `mcp__ops__deploy`). **Approval is meaningless unless it shows "this is everything".**
 *
 * ⚠️ Tools not listed here are shown in full as JSON (**never fold what we do not know**).
 *    Getting a name wrong only makes it "harder to read", and falls on the side where **nothing is hidden**.
 *
 * ⚠️ Even for known tools, anything beyond the gist (`timeout` / `run_in_background` etc.) is not on the card.
 *    This matches the granularity of the PC dialog.
 */
const SUMMARY_FIELD: Record<string, readonly string[]> = {
  Bash: ['command'],
  Read: ['file_path'],
  Edit: ['file_path'],
  Write: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Glob: ['pattern'],
  Grep: ['pattern'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  [EXIT_PLAN_MODE]: ['plan'],
}

function rawText(toolName: string, input: unknown): Raw | undefined {
  if (!input || typeof input !== 'object') return undefined
  const o = input as Record<string, unknown>
  // ★ a question with choices shows **only the question text**.
  //   ⚠️ without this a one-line JSON appears as is (confirmed on a real device; CLAUDE.md "one-line JSON is forbidden").
  //      the card draws the choices separately, so they are not repeated here
  if (toolName === ASK_USER_QUESTION && Array.isArray(o['questions'])) {
    const qs = (o['questions'] as unknown[])
      .map((q) => (q && typeof q === 'object' ? (q as Record<string, unknown>)['question'] : undefined))
      .filter((q): q is string => typeof q === 'string' && q.length > 0)
    if (qs.length > 0) return { kind: 'list', items: qs }
  }
  for (const key of SUMMARY_FIELD[toolName] ?? []) {
    const v = o[key]
    if (typeof v === 'string' && v.length > 0) return { kind: 'text', text: v }
  }
  return { kind: 'json', value: o }
}

/** What the tool is about to do, in one line. The shape of tool_input differs per tool */
export function summarize(toolName: string, input: unknown): string {
  const raw = rawText(toolName, input)
  if (!raw) return toolName
  switch (raw.kind) {
    case 'list':
      return clip(raw.items.join(' / '))
    case 'json':
      return clip(JSON.stringify(raw.value))
    default:
      return clip(raw.text)
  }
}

/**
 * ★ The "full text" opened by tapping a card. **Keeps newlines**.
 *
 * `summary` is flattened to one line and cut at 400 characters so it does not break notifications or chips.
 * A heredoc like `python3 - <<'PY' …` disappears entirely past the "…" there, so
 * **you cannot read what you are about to approve** (a real-device problem on 2026-08-18).
 *
 * ⚠️ If it is cut here too, **say so** (`clipped`). If you opened it to see past the "…"
 *    and it was silently cut again, you would approve thinking you had "seen everything".
 *
 * @returns `undefined` if the folded line is already the full text (so no open button is shown)
 */
export function detailOf(
  toolName: string,
  input: unknown,
): { text: string; clipped: boolean } | undefined {
  const raw = rawText(toolName, input)
  if (!raw) return undefined
  // a question with choices is drawn as is (question and choices) by the card, so opening is pointless
  if (raw.kind === 'list') return undefined
  // ★ decide with **the same string as the folded line**.
  //   ⚠️ measuring by the length after formatting shows an open button **even though nothing was dropped**
  //      (2026-08-18 codex review, low #3)
  const source = raw.kind === 'json' ? JSON.stringify(raw.value) : raw.text
  const flat = source.replace(/\s+/g, ' ').trim()
  const truncated = flat.length > SUMMARY_MAX // does not fit in the folded line
  // ★★ collapsing whitespace can **change the meaning** (`printf '%s' 'allow  deny'`
  //   looks like a different command when collapsed / same review, medium #2). If only **leading and trailing whitespace**
  //   was dropped, it looks the same, so only that case is excluded.
  //   ⚠️ for JSON the folded line is already everything, so it is not opened just for formatting
  const flattened = raw.kind !== 'json' && source.trim() !== flat
  if (!truncated && !flattened) return undefined
  // ★ unknown tools / MCP are "one-line JSON", so **make it readable when opened**.
  //   ⚠️ shown as is, `\n` would just **sit there as characters** in a lump, defeating the point of opening
  //      (2026-08-18 /code-review medium #1).
  //   ⚠️ newlines inside strings stay escaped per JSON rules (that cannot be fixed)
  const full = raw.kind === 'json' ? JSON.stringify(raw.value, null, 2) : raw.text
  const clipped = full.length > DETAIL_MAX
  return { text: clipped ? full.slice(0, DETAIL_MAX) : full, clipped }
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX - 1)}…` : flat
}

/**
 * ★ Validates "what I would like changed" (the reason attached to a denial).
 * ⚠️ The limit is shared with the screen (`MAX_MESSAGE_BYTES`). If they drift, "the screen lets you send it but it is refused"
 */
export function validateFeedback(raw: unknown): { ok: true; message?: string } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: true }
  if (typeof raw !== 'string') return { ok: false, reason: t('直してほしい点は文字列で送ってください', 'Send the requested changes as text.') }
  const text = raw.trim()
  if (text.length === 0) return { ok: true } // empty is treated the same as "deny without a reason"
  if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) {
    return { ok: false, reason: t(`長すぎます（${MAX_MESSAGE_BYTES} バイトまで）`, `Too long (up to ${MAX_MESSAGE_BYTES} bytes).`) }
  }
  return { ok: true, message: text }
}

/**
 * ★★ Turns the permission suggestions the CLI offers into just the **structure** the display needs (2026-09-24). The screen turns them into sentences (in its own language).
 * ⚠️ Broken input is silently skipped (display only, so missing items do not affect the approval itself).
 */
export function suggestionItems(raw: unknown): PermissionSuggestion[] {
  if (!Array.isArray(raw)) return []
  const out: PermissionSuggestion[] = []
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue
    const o = s as Record<string, unknown>
    const type = str(o['type'])
    if (type === 'addDirectories' && Array.isArray(o['directories'])) {
      const dirs = (o['directories'] as unknown[]).filter((d): d is string => typeof d === 'string')
      // ⚠️ only the trailing name (same exposure as the old text)
      if (dirs.length > 0) out.push({ kind: 'addDirectories', directories: dirs.map((d) => basename(d) || d) })
    } else if (type === 'setMode' && str(o['mode'])) {
      out.push({ kind: 'setMode', mode: str(o['mode']) as string })
    } else if (type) {
      out.push({ kind: 'other', type })
    }
  }
  return out
}

/**
 * ⚠️ **legacy**: the Japanese text for old screens (`PermissionRequest.suggestions`).
 *    New screens read `suggestionItems`. The wording lives in one place, `legacySuggestionText` in `shared/types.ts`.
 */
export function describeSuggestions(raw: unknown): string[] {
  return suggestionItems(raw).map(legacySuggestionText)
}

