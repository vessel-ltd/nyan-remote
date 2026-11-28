// The entry point for pending approvals (M4-1).
//
// ★ Claude Code's `PermissionRequest` hook hits this with `type: "http"`.
//   The setup is just one addition to ~/.claude/settings.json, and **how you launch does not change**
//   (the premise of CLAUDE.md §1.5).
//
// ⚠️ This handler **waits without returning a response**. While waiting it sends a push,
//   and when the phone taps, it returns the decision as that response.
//   It is managed by **whether the connection is alive**, not by a timer (read the explanation in permission.ts).

import { basename } from 'node:path'
import {
  LEGACY_SUBAGENT_LABEL,
  LEGACY_UNKNOWN_ACCOUNT,
  legacySuggestionText,
  notificationText,
  permissionTag,
  TEAM_CREATE_TOOL,
  type HookPayload,
  type NotifyFields,
  type PermissionRequest,
  type PushPayload,
} from '../../../shared/types.ts'
import { notifyFieldsFromTranscript } from '../notify.ts'
import { broadcast } from '../events.ts'
import {
  answer,
  decisionResponse,
  holdQuiet,
  promoteQuiet,
  quietCount,
  withGeneration,
  suggestionItems,
  keyOf,
  listPending,
  pendingWithMeta,
  summarize,
  detailOf,
  hiddenIn,
  validateFeedback,
  waitForDecision,
  type Behavior,
  type Decision,
  withPendingPerms,
  pendingPermTags,
  wasPromoted,
  markPromoted,
} from '../permission.ts'
import { sendToAll } from '../push.ts'
import { clearLabelIfSettled, sweepResolved } from '../permissionSweep.ts'
import { threadUrl } from '../pushUrl.ts'
import { HOOK_BODY_MAX, HttpError, readJsonBody, type Ctx } from '../router.ts'

import { buildUpdatedInput, describeInteraction, requiresInteraction } from '../claude/interaction.ts'
import { buildCodexAnswers } from '../codex/questions.ts'
import { actorOf } from '../auth.ts'
import { autoApproveList, shouldAutoApprove } from '../autoApprove.ts'
import { announceToLeader } from '../teamHooks.ts'
import { membershipOf } from '../team.ts'
import { hasHidden } from '../../../shared/reveal.ts'
import { isCodexSessionId } from '../codex/daemon.ts'
import { agyDelivery, agyDeliveryMessage, AGY_DELIVERY_WAIT_MS } from '../agy/cards.ts'
import { buildAgySteps } from '../agy/questions.ts'
import { AGY_PREFIX } from '../agy/sessions.ts'
import { resolveAgentTranscript } from '../claude/subagentTranscript.ts'
import { parseTranscriptPath } from './hook.ts'
import { t } from '../../../shared/i18n.ts'
import { machineName } from '../machine.ts'

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * The list of pending approvals (used by the PWA for display).
 *
 * ★ Clean up before returning. **Approving on the PC does not close the hook's connection**, so
 *   finished markers must be found and discarded by us or they stay forever (read the explanation in permissionSweep.ts).
 *   The PWA refetches every 15 seconds, so that is effectively the cleanup cycle.
 */
export async function permissions(): Promise<{
  permissions: PermissionRequest[]
  /** ★ Cards left out as too large for one relay frame (absent = none). Still live: `npm run pending` counts them */
  omitted?: number
  quiet: number
  pendingTags: string[]
  /**
   * ★★ The time this list was taken (**the agent's clock**. codex 2026-08-20, high #2).
   *
   * ⚠️ Needed so the app-side cleanup can also apply "never close notifications newer than the list".
   *    A notification's `timestamp` is also the `at` the agent put in, so **both are compared on the same clock**
   *    (comparing with the device clock misjudges due to skew).
   */
  at: string
  /**
   * ★★ Sessions currently in **auto-approve mode** (2026-09-07).
   *
   * ⚠️ Why it is here: `npm run pending` is the screen for "is it OK to restart", so
   *    **"auto-approve continues until its expiry even after a restart"** must be readable there
   *    (no marker is raised, so not a single one appears in `permissions`).
   */
  autoApprove: { id: string; until: string; tool?: 'codex' | 'agy' }[]
}> {
  await sweepResolved()
  // ★ `quiet` = the number of subagent requests "waiting quietly".
  //   ⚠️ **Include this too when deciding whether a restart is OK** (scripts/pending.mjs).
  //      It is not displayed, but it is still **an approval that must not be killed**
  // ★★ `pendingTags` is **a superset that includes the quietly waiting ones** (`/code-review` 2026-08-20, low #5).
  //    ⚠️ The PWA's notification cleanup used to be built from `permissions` (= `listPending()`), so
  //      **during the 6 seconds after a surfaced approval went back to the quiet state**, it closed live notifications.
  //      Only allow erring in the "failing to remove" direction.
  return {
    ...withBudgetCount(listPending()),
    quiet: quietCount(),
    pendingTags: pendingPermTags(),
    at: new Date().toISOString(),
    // ⚠️ Only `sessionId` and expiry (nothing derived from the conversation / §6.2)
    // ★ `tool` for a Codex row's entry: the phone builds a row from a mark that landed on no row, and that row must
    //   not pass for a Claude session (its gates differ / codex review, medium #7)
    autoApprove: autoApproveList().map((e) => ({
      id: e.id,
      until: e.until,
      ...(isCodexSessionId(e.id) ? { tool: 'codex' as const } : e.id.startsWith(AGY_PREFIX) ? { tool: 'agy' as const } : {}),
    })),
  }
}

/**
 * ★★ The cards' full texts within one relay frame (codex review: a dozen pending writes of ~8,000 Japanese characters
 *   each passed 256 KiB, and the list closed the tunnel — every approval on that machine unreachable by relay). Past
 *   the budget the later cards go without their full text, marked `detailClipped` (the phone asks again before allowing).
 */
export const PERMISSIONS_DETAIL_BUDGET = 160 * 1024

/** ★ The list within the budget, and how many cards it left out (`npm run pending` counts those as live approvals) */
function withBudgetCount(all: readonly PermissionRequest[]): { permissions: PermissionRequest[]; omitted?: number } {
  const permissions = withinBudget(all)
  const omitted = all.length - permissions.length
  return omitted > 0 ? { permissions, omitted } : { permissions }
}
export function withinBudget(list: readonly PermissionRequest[], budget = PERMISSIONS_DETAIL_BUDGET): PermissionRequest[] {
  // ★ The whole list counted (questions with their previews too / codex review); the full texts are taken off, largest
  //   first, until it fits
  const out = [...list]
  let total = Buffer.byteLength(JSON.stringify(out))
  const order = out
    .map((p, i) => ({ i, size: p.detail === undefined ? 0 : Buffer.byteLength(JSON.stringify(p.detail)) }))
    .filter((x) => x.size > 0)
    .sort((a, b) => b.size - a.size)
  for (const { i, size } of order) {
    if (total <= budget) break
    const { detail: _dropped, ...rest } = out[i]!
    out[i] = { ...rest, detailClipped: true }
    total -= size
  }
  // ★ Then the option diagrams, largest card first (codex review: three cards of four questions with full Japanese
  //   previews were ~285 KiB with every full text gone). A card without them is marked `previewClipped`, so the phone
  //   warns and does not answer on one tap
  const byPreview = out
    .map((p, i) => ({ i, size: previewBytes(p) }))
    .filter((x) => x.size > 0)
    .sort((a, b) => b.size - a.size)
  for (const { i } of byPreview) {
    if (total <= budget) break
    const p = out[i]!
    if (p.interaction?.kind !== 'question') continue
    const before = Buffer.byteLength(JSON.stringify(p))
    out[i] = {
      ...p,
      interaction: {
        ...p.interaction,
        questions: p.interaction.questions.map((q) => ({
          ...q,
          options: q.options.map(({ preview, previewClipped: _c, ...o }) =>
            preview === undefined ? o : { ...o, previewClipped: true },
          ),
        })),
      },
    }
    total -= before - Buffer.byteLength(JSON.stringify(out[i]))
  }
  // ★★ Last, whole cards, largest first (codex review: question and option texts have no bound of their own — four
  //   cards of long option descriptions still passed the frame). A card left out is answered on the PC, and the phone
  //   says so for a waiting session it has no card for (`Thread.tsx` "answer on the PC"); one list over the frame lost
  //   every card on the machine instead
  if (total <= budget) return out
  const sized = out.map((p, i) => ({ i, size: Buffer.byteLength(JSON.stringify(p)) + 1 })).sort((a, b) => b.size - a.size)
  const drop = new Set<number>()
  for (const { i, size } of sized) {
    if (total <= budget) break
    drop.add(i)
    total -= size
  }
  return out.filter((_, i) => !drop.has(i))
}

function previewBytes(p: PermissionRequest): number {
  if (p.interaction?.kind !== 'question') return 0
  let n = 0
  for (const q of p.interaction.questions) for (const o of q.options) if (o.preview) n += Buffer.byteLength(JSON.stringify(o.preview))
  return n
}

/**
 * ★ Build the single card shown on screen (`PermissionRequest`) from the hook's raw input.
 *
 * ⚠️ This used to be buried inside `permissionRequest`, so **tests could not reach it**.
 *    It is split out to look at the very value passed to the UI (VERIFY.md "tests that pass
 *    hand-built values are a false green").
 */
export function buildPermissionInfo(body: HookPayload): PermissionRequest {
  const toolName = str(body['tool_name']) ?? 'unknown'
  const { account, sessionId } = parseTranscriptPath(str(body['transcript_path']))
  const cwd = str(body['cwd'])
  // ★ The collapsed line and the expanded full text are built **from the same input** (rawText in permission.ts)
  const detail = detailOf(toolName, body['tool_input'])
  // ★★ UI wording is sent **as structure** (2026-09-24). The UI turns it into sentences in its own language.
  //   ⚠️ The old shapes (Japanese sentences in `suggestions` / the `agentType` default / `(不明)` for `account`) are **sent alongside**:
  //      old UIs read only those, and without them the suggestion rows and subagent badge **silently disappear**.
  //      New UIs use the structured fields when present (`web/src/ui/agentText.ts`).
  const items = suggestionItems(body['permission_suggestions'])
  const sub = subagentOf(body)
  const cwdClipped = cwd !== undefined && cwd.length > CWD_MAX
  return {
    // ★★ Attach a generation so that **only the card that was pressed can be answered** (ABA protection).
    //   Without a generation, when the same command is retried in the same turn,
    //   **an old card's "allow" is handed to the later request** (withGeneration in permission.ts)
    key: withGeneration(
      keyOf({
        promptId: str(body['prompt_id']),
        toolUseId: str(body['tool_use_id']),
        sessionId: str(body['session_id']),
        // ★ There is only one prompt_id per turn, so the tool and its arguments are included to tell them apart
        //   (read the explanation of keyOf in permission.ts. It caused "approvals that never show" on a real device)
        toolName,
        toolInput: body['tool_input'],
        // ★ Do not collapse the same command from different subagents into one card (see keyOf)
        agentId: str(body['agent_id']),
      }),
    ),
    machine: machineName(),
    account: account ?? LEGACY_UNKNOWN_ACCOUNT,
    ...(account ? {} : { accountUnknown: true as const }),
    project: cwd ? basename(cwd) : '—',
    sessionId: sessionId ?? str(body['session_id']),
    promptId: str(body['prompt_id']),
    toolUseId: str(body['tool_use_id']),
    toolName,
    agentType: agentTypeOf(body),
    ...(sub ? { subagent: sub } : {}),
    summary: summarize(toolName, body['tool_input']),
    // ★ Some approvals cannot be judged without seeing past the "…", so the full text is passed too (tap to open in the UI)
    ...(detail ? { detail: detail.text, detailClipped: detail.clipped || cwdClipped } : cwdClipped ? { detailClipped: true } : {}),
    // ★★ Where it runs (2026-11-19 / codex review r8, high #2): `make clean` in a scratch checkout and in a live
    //    directory looked the same — the card carried only the project's base name. The same rule as a Codex card:
    //    cut at `CWD_MAX` (and said: `detailClipped`), third-party text drawn through `Revealed`, counted in `hidden`.
    ...(cwd === undefined ? {} : { cwd: cwd.slice(0, CWD_MAX) }),
    // ★★ Checked on the uncut input (the phone warns even if the character lies past the cut / 2026-11-10)
    ...(hiddenIn(toolName, body['tool_input']) || (cwd !== undefined && hasHidden(cwd)) ? { hidden: true as const } : {}),
    suggestions: items.map(legacySuggestionText),
    suggestionItems: items,
    permissionMode: str(body['permission_mode']),
    at: new Date().toISOString(),
    // ★ Tools that cannot be answered with "yes/no" (§9.11). Pass the choices to the UI
    ...(describeInteraction(toolName, body['tool_input'])
      ? { interaction: describeInteraction(toolName, body['tool_input']) }
      : {}),
  }
}

/** A directory longer than this is cut, and the card says it is not all there (the same bound as a Codex card) */
const CWD_MAX = 1000

/**
 * The hook's entry point. ★ This is where it waits.
 *
 * What it returns (the contract confirmed by measurement / see permission.ts):
 *   allow: {"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}
 *   deny: the same shape with behavior:"deny"
 *   defer: `{}` (no decision) → Claude Code proceeds with its normal approval flow = answer on the PC
 */
export async function permissionRequest(ctx: Ctx): Promise<unknown> {
  // ★ A large tool input is still a card (review CTL-2 / `HOOK_BODY_MAX`)
  const body = await readJsonBody<HookPayload>(ctx.req, HOOK_BODY_MAX)
  const info = buildPermissionInfo(body)
  const toolName = info.toolName

  // ★★ Auto-approve mode (per session, with an expiry / `agent/src/autoApprove.ts`).
  //
  // ⚠️⚠️ **Return before raising the marker.** Entering `waitForDecision` and then answering ourselves
  //    runs `announce` (push) and the quiet timer (`quietUntil`) first, so
  //    **only a notification for an already-answered approval reaches the phone**. ⇒ Here, "do not touch the waiting machinery".
  //    ★ `autoApproveRoute.test.ts` checks the order itself (to kill mutations that swap it).
  // ⚠️ Only "yes/no" is passed (decided in one place, `shouldAutoApprove`.
  //    `AskUserQuestion` / `ExitPlanMode` / anything with `interaction` stops).
  // ⚠️ Only one log line is kept (**no body is written** / §6.2). No dialog appears on the PC, so
  //    this line and the transcript are the only traces.
  if (shouldAutoApprove(info)) {
    console.log(
      t(
        `[perm] 自動承認で許可 tool=${toolName}${info.agentType ? ` sub=${info.agentType}` : ''} ` +
          `session=${info.sessionId?.slice(0, 8) ?? '不明'}`,
        `[perm] Allowed by auto-approve tool=${toolName}${info.agentType ? ` sub=${info.agentType}` : ''} ` +
          `session=${info.sessionId?.slice(0, 8) ?? 'unknown'}`,
      ),
    )
    // ★★ Clear the "要対応" (needs attention) marker (a label from `hooks.permission` has only two ways out:
    //    **the latest activity overtakes it** or **the sweep finds the result**).
    //    ⚠️ Skipping this brings back "needs attention remains although there is nothing to answer"
    //       (it stayed like that for 21 minutes on 2026-08-21 / see `claude/sessions.ts`).
    //    ⚠️ If another approval is genuinely pending, `clearLabelIfSettled` does not clear it.
    if (clearLabelIfSettled(info.sessionId)) {
      broadcast({ type: 'sessions-changed', at: new Date().toISOString() })
    }
    return decisionResponse({ behavior: 'allow' })
  }

  const waiting = waitForDecision(
    info,
    (onAbort) => {
      // ★ When the connection drops (timeout / session ended), remove the marker
      // ⚠️ **Approving on the PC does not close the connection** (measured 2026-08-13). That case is
      //    cleaned up by permissionSweep.ts looking at the transcript
      ctx.req.once('aborted', onAbort)
      ctx.req.once('close', onAbort)
      ctx.res.once('close', onAbort)
    },
    // Material for cleanup. Not exposed in the API
    // ⚠️ Always pass `agent_id`. Without it, subagent approvals **are never cleaned up**
    //    (the result is not written in the main transcript / subagentTranscript.ts)
    {
      transcriptPath: str(body['transcript_path']),
      agentId: str(body['agent_id']),
      toolInput: body['tool_input'],
    },
  )

  // ★★ How to notify differs between "requests from the main agent" and "requests from subagents".
  //   ⚠️ Call it **after** the marker is registered (done synchronously by `waitForDecision`) and **before** waiting
  const stopQuietTimer = announce(info, {
    transcriptPath: str(body['transcript_path']),
    agentId: str(body['agent_id']),
  })

  const startedAt = Date.now()
  let decision: Decision | undefined
  try {
    decision = await waiting
  } finally {
    stopQuietTimer()
  }

  // ★ Log one line about **how long it waited and how it ended**.
  //   Material so the quiet wait (QUIET_MS) is not set by guesswork. The log alone lets you tell apart:
  //     result=allow/deny … answered from the phone
  //     result=no decision … answered on the PC / passed automatically / the session ended
  //   ⚠️ No body is logged (§6.2). Only the tool name and time
  console.log(
    t(
      `[perm] 承認が終わった tool=${toolName}${info.agentType ? ` sub=${info.agentType}` : ''} ` +
        `経過=${((Date.now() - startedAt) / 1000).toFixed(1)}秒 結果=${decision?.behavior ?? '決定なし'}`,
      `[perm] Approval finished tool=${toolName}${info.agentType ? ` sub=${info.agentType}` : ''} ` +
        `elapsed=${((Date.now() - startedAt) / 1000).toFixed(1)}s result=${decision?.behavior ?? 'no decision'}`,
    ),
  )

  const endedAt = new Date().toISOString()
  // ★ Do not leave "needs attention" when the hook's connection dropped or it was settled on the PC either.
  //   ⚠️ The sweep only picks up "results written to the transcript", so for the path that
  //      ended with a dropped connection, the label stays until `Stop` unless cleared here
  if (decision === undefined && clearLabelIfSettled(info.sessionId)) {
    broadcast({ type: 'sessions-changed', at: endedAt })
  }
  broadcast({ type: 'permissions-changed', machine: info.machine, at: endedAt })

  // ★ The only definition of the returned shape is decisionResponse in permission.ts (pinned by tests).
  //   If decision === undefined it returns `{}`, deferring to the PC's normal flow
  return decisionResponse(decision)
}

export interface AnswerBody {
  key?: string
  behavior?: string
  /**
   * ★ Question text → the chosen labels (an array even for single choice).
   * ⚠️⚠️ **`updatedInput` itself is never accepted** (accepting it would let the Bash command
   *    be rewritten). Only labels are accepted, and the agent builds it (interaction.ts)
   */
  answers?: Record<string, string[]>
  /** ★ "Please change it like this" (a reason attached to a denial; the PC's `3. Tell Claude what to change`) */
  feedback?: string
  /** ★ Question text → a note (Codex questions only). ⚠️ Text for the model; the answer is built here (`questions.ts`) */
  notes?: Record<string, string>
  /** ★ "Skip" for an agy question (docs/AGY.md §13): a deny there needs it (an older PWA's button said "deny and stop") */
  skip?: boolean
}

export { AGY_DELIVERY_WAIT_MS }

/** The outcome, or 'slow' when it takes longer than `ms` (the outcome is then left to come on its own) */
export function settledWithin<T>(p: Promise<T>, ms: number): Promise<T | 'slow'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const slow = new Promise<'slow'>((r) => (timer = setTimeout(() => r('slow'), ms)))
  return Promise.race([p, slow]).finally(() => clearTimeout(timer))
}

/** The reply from the phone */
export async function permissionAnswer(ctx: Ctx, agyWaitMs = AGY_DELIVERY_WAIT_MS): Promise<{ ok: boolean; reason?: string; at?: string }> {
  const body = await readJsonBody<AnswerBody>(ctx.req)
  // ★ An agy card is answered by typing a key (`agy/cards.ts`): its outcome is known only after the key went out,
  //   so the phone waits for it (a key that never reached agy must not read as answered / codex review).
  //   ⚠️ Taken before answering (answering starts the typing)
  const delivery = typeof body.key === 'string' ? agyDelivery(body.key) : undefined
  // ⚠️⚠️ A team's confirmation (a Codex lead's create, `teamConfirm.ts`) only from a paired phone (codex review ② r3 #1):
  //    on a machine that uses `tailscale serve`, the loopback port believes forwarding headers, so a program of this
  //    user that can reach it (a Codex with its network turned on) could answer as "tailscale". A paired phone proves
  //    its key in a handshake nobody else can make.
  const r = answerPermission(body, actorOf(ctx.identity), (target) =>
    target?.toolName === TEAM_CREATE_TOOL && ctx.identity.via !== 'device'
      ? {
          ok: false,
          reason: t(
            'チーム作りの確認は、nyan-remote と組んだスマホ（アプリ）からだけ答えられます',
            'A team confirmation can be answered only from a phone paired with nyan-remote (the app).',
          ),
        }
      : { ok: true },
  )
  if (!r.ok || !delivery) return r
  // ★ The outcome is told when the typing ends within `AGY_DELIVERY_WAIT_MS` (most do). ⚠️ Not longer: a relay line runs
  //    its requests one at a time, so a longer wait held the phone's next request (an instruction to Claude) past its
  //    own 10 s timeout — shown as failed, then run (codex review). Past it the answer is told as taken (the typing goes
  //    on; a question it could not finish rings "needs you" again).
  const d = await settledWithin(delivery, agyWaitMs)
  if (d === 'slow') return r
  if (d && !d.ok) return { ok: false, reason: agyDeliveryMessage(d.reason) }
  // ★ When it took effect, by this agent's clock (the phone closes the notifications shown before it)
  return d ? { ...r, at: new Date().toISOString() } : r
}

/**
 * ★★ Answer one approval: the phone (`permissionAnswer`) and a team's leader (`/team/approve` / `team.ts`) go through
 *    this one function, so the rules (labels only, no `updatedInput`, the generation check) are written once.
 * ⚠️ `guard` sees the request **found by this same lookup**, with no await between the check and the answer
 *    (whoever answers first wins; a check made on an older lookup could pass a newer request).
 * @param actor who answered, for the journal (`device:…` / `team:<id>/<leader>`)
 */
export function answerPermission(
  body: AnswerBody,
  actor: string,
  guard?: (target: PermissionRequest | undefined) => { ok: true } | { ok: false; reason: string },
  /** ★ Asked again right before a later key (agy): `Decision.stillValid` */
  stillValid?: () => boolean,
): { ok: boolean; reason?: string } {
  const key = str(body.key)
  const behavior = str(body.behavior)
  if (!key) throw new HttpError(400, t('key が必要です', '`key` is required.'))
  if (behavior !== 'allow' && behavior !== 'deny') {
    throw new HttpError(400, t('behavior は allow か deny です', '`behavior` must be allow or deny.'))
  }
  // ⚠️ Look it up **before answering** (the marker disappears the moment it is answered).
  //    The first 12 characters of key are the head of `prompt_id`, so **two items in the same turn look identical**
  //    (they actually could not be told apart in the journal). Add the tool name so they can be distinguished
  const found = pendingWithMeta().find((p) => p.info.key === key)
  const target = found?.info
  if (guard) {
    const g = guard(target)
    if (!g.ok) return { ok: false, reason: g.reason }
  }

  // ★★ Tools that cannot be answered with "yes/no" **are ignored by the CLI without updatedInput**
  //    (§9.11 / interaction.ts). Being ignored means "I pressed it but the PC did nothing", so
  //    **if it cannot be built here, do not send the allow** (refusing is better than being silently dropped).
  let updatedInput: Record<string, unknown> | undefined
  const codexQuestion = target?.tool === 'codex' && target.interaction?.kind === 'question'
  // ★ An agy question (docs/AGY.md §13): answered with keys the agent builds from the question it read
  const agyQuestion = target?.tool === 'agy' && target.interaction?.kind === 'question'
  // ⚠️ Notes go to Codex and agy questions only (Claude's questions have nowhere to put them: refuse rather than drop)
  if (body.notes !== undefined && target && !codexQuestion && !agyQuestion) {
    return { ok: false, reason: t('この質問には書き足せません', 'A note cannot be added to this question.') }
  }
  if (agyQuestion) {
    // ⚠️ Never keys from the phone: built here from its labels and notes (`agy/questions.ts` rule 1).
    //    Deny = skip the questions (ESC per question, built where it is typed)
    if (behavior === 'allow') {
      const built = buildAgySteps(found?.meta?.toolInput, body.answers, body.notes)
      if (!built.ok) return { ok: false, reason: built.message }
      // ★ Both: the choices (typed against the screen) and, when they fit the digits, the fixed keys (a blind relay)
      updatedInput = { plan: built.plan, ...(built.steps ? { steps: built.steps } : {}) }
    } else if (body.skip !== true) {
      // ⚠️ An older PWA shows "deny and stop" here, but ESC on a question skips it and the turn goes on
      return {
        ok: false,
        reason: t('アプリを開き直して更新してください（質問は「飛ばす」で答えます）。', 'Reopen the app to update it (a question is skipped with "Skip").'),
      }
    }
  } else if (codexQuestion) {
    // ★ Built from the request the agent holds (the ids never left the agent). Deny = stop the turn that asks.
    if (behavior === 'allow') {
      const built = buildCodexAnswers(found?.meta?.toolInput, body.answers, body.notes)
      if (!built.ok) return { ok: false, reason: built.message }
      updatedInput = built.result as unknown as Record<string, unknown>
    }
  } else if (behavior === 'allow' && target && requiresInteraction(target.toolName)) {
    const built = buildUpdatedInput(target.toolName, found?.meta?.toolInput, body.answers)
    if (!built.ok) return { ok: false, reason: built.message }
    updatedInput = built.updatedInput
  }

  // ★ A denial can carry "please change it like this" (§9.9.1).
  //   ⚠️ The body is not logged (derived from the conversation / §6.2). Only its length
  const fb = validateFeedback(body.feedback)
  if (!fb.ok) return { ok: false, reason: fb.reason }
  // ★ A Codex approval has nowhere to put a reason (the daemon takes `accept` / `decline` only).
  //   ⚠️ Refuse rather than drop it: a denial whose reason silently vanished reads as "I told it what to change".
  if (target?.tool === 'codex' && fb.message) {
    return {
      ok: false,
      reason: t(
        'Codex の承認には理由を付けられません。理由を消して、もう一度 拒否してください。',
        'A Codex approval cannot carry a reason. Clear the reason and deny again.',
      ),
    }
  }
  // ★ An agy card is answered with one key (`agy/keys.ts` `AGY_CARD_KEYS`): no reason can go with it either
  if (target?.tool === 'agy' && fb.message) {
    return {
      ok: false,
      reason: t(
        'agy の承認には理由を付けられません。理由を消して、もう一度 拒否してください。',
        'An agy approval cannot carry a reason. Clear the reason and deny again.',
      ),
    }
  }

  const ok = answer(key, behavior as Behavior, { updatedInput, message: fb.message, ...(stillValid ? { stillValid } : {}) })
  if (ok) {
    console.log(
      `[perm] ${behavior} key=${key.slice(0, 12)}…${key.slice(-4)} by=${actor}` +
        (target ? ` tool=${target.toolName}${target.agentType ? ` sub=${target.agentType}` : ''}` : '') +
        // ⚠️ No contents. Only "was a reason attached" and its length
        (fb.message
          ? t(` 理由=${Buffer.byteLength(fb.message, 'utf8')}バイト`, ` reason=${Buffer.byteLength(fb.message, 'utf8')} bytes`)
          : ''),
    )
    // ★★ Also clear the evidence behind the "要対応" (needs attention) label.
    //    ⚠️ Without this, **right after answering the thread falsely says "please answer on the PC"**
    //       (showed for 4–5 seconds on a real device / 2026-08-14). `Notification/permission`
    //       does not tell us "it has been answered", so the answering side has to clear it.
    const at = new Date().toISOString()
    const cleared = clearLabelIfSettled(target?.sessionId)
    broadcast({ type: 'permissions-changed', machine: machineName(), at })
    // Make the list's status display refetch too (what changed is the session's label, not the approval list)
    if (cleared) broadcast({ type: 'sessions-changed', at })
    return { ok: true }
  }
  // No counterpart = the destination to return to is gone.
  // ⚠️ The cause cannot be distinguished, so **always add what to do next**.
  //    We actually pressed "an approval that appeared 5 seconds before the agent restarted" and got confused when nothing happened (2026-08-13).
  return {
    ok: false,
    reason: t('もう答えられません（agent の再起動 / 時間切れ / PCで対応済み）。PCの画面で答えてください', 'This can no longer be answered (agent restarted, timed out, or already handled on the PC). Answer on the PC screen.'),
  }
}

/**
 * ★ Decide whether it came from a subagent (a pure function, so it is testable).
 *
 * If `agent_id` is present, the request is from something launched via `Task` (confirmed in the CLI 2.1.231 code;
 * the CLI itself decides with `isSubagent = !!agentId`). The main agent has no `agent_id`.
 *
 * ⚠️ Rewriting this to always return `undefined` kept every unit test green
 *    (pointed out in the 2026-08-14 review). That is why it is split out and tested.
 */
export function agentTypeOf(body: HookPayload): string | undefined {
  if (!subagentOf(body)) return undefined
  // ⚠️ The legacy default (Japanese that old UIs match and translate). New UIs read `subagent`
  return str(body['agent_type']) ?? LEGACY_SUBAGENT_LABEL
}

/**
 * ★★ `{ type? }` if it came from a subagent (2026-09-24 / structured). Same single criterion as `agentTypeOf` (`agent_id`).
 *    When `type` is absent, the UI shows a name in its own language.
 */
export function subagentOf(body: HookPayload): { type?: string } | undefined {
  if (!str(body['agent_id'])) return undefined
  const type = str(body['agent_type'])
  return type ? { type } : {}
}

/**
 * ★★ How long to "wait quietly" on approvals from subagents.
 *
 * The phenomenon the user hit with `/code-review` on 2026-08-14:
 *   the hook fires as soon as the subagent side decides to "ask", but **most of those are then
 *   automatically approved by the main agent and move on**. The hook's connection does not close, so
 *   **approvals that need no answer get notified, and the cards remain**.
 *
 * ⚠️ **Never hide them across the board.** When a human decision really is needed, hiding it
 *    removes the way to answer from the phone, and **it stalls unnoticed** (the failure this tool most wants to avoid).
 *    → Wait silently for a few seconds, and **if it is still there, show it normally**.
 *
 * ⚠️ Do not make it too long. This is also how long the notification for "an approval really keeping a person waiting" is delayed.
 */
const QUIET_MS = 6000

/**
 * Announce an approval. Only for subagent requests, wait a little before announcing.
 *
 * ⚠️ **While waiting it does not appear in `/permissions`, so it cannot be answered from the phone**
 *    (it used to say here "it can be answered while waiting", which was wrong. The only source of the key is
 *    `/permissions` / pointed out in the 2026-08-14 review). It can be answered normally on the PC.
 * ⚠️ The timer is `unref`ed. Shutdown is cut off after 1 second so nothing is kept waiting, but
 *    **unsent notifications being lost at shutdown** is accepted (the approvals themselves die on restart).
 */
function announce(info: PermissionRequest, meta?: { transcriptPath?: string; agentId?: string }): () => void {
  // ★ A subagent request already shown once and now re-entering: the card stays (its new key is broadcast), but it is
  //   not announced again — no second ring, no second notice to a leader (r37 low #1: re-entries every few seconds
  //   rang the phone each time)
  if (info.agentType && wasPromoted(info.key)) {
    broadcast({ type: 'permissions-changed', machine: info.machine, at: info.at })
    return () => {}
  }
  // ★ A team member's subagent card skips the quiet period (r36 medium #4: a pending hook re-entering every few seconds
  //   restarted it, and neither the phone nor the leader heard); it counts as shown from now on
  if (info.agentType && membershipOf(info.sessionId)) markPromoted(info.key)
  if (!info.agentType || membershipOf(info.sessionId)) {
    // A request from the main agent — or a subagent request already shown once (its re-entry is not hidden again).
    // Announce immediately, as before. ★ A team member's: its leader is told too (`teamHooks.ts`)
    void notifyPermission(info, meta?.transcriptPath)
    announceToLeader(info)
    broadcast({ type: 'permissions-changed', machine: info.machine, at: info.at })
    return () => {}
  }

  holdQuiet(info.key, QUIET_MS)
  console.log(
    t(
      `[perm] サブエージェント（${info.agentType}）からの承認要求。${QUIET_MS / 1000}秒待ってから知らせます tool=${info.toolName}`,
      `[perm] Approval request from a subagent (${info.agentType}). Notifying after ${QUIET_MS / 1000}s tool=${info.toolName}`,
    ),
  )
  const timer = setTimeout(() => {
    void (async () => {
      // ★ Clean up once more before showing. **If it was auto-approved, the marker disappears here**
      //   (permissionSweep looks at the transcript's tool_result)
      try {
        await sweepResolved()
      } catch {
        // Even if cleanup fails, promoteQuiet below checks "is it still waiting", so it is on the safe side
      }
      // ★ Log **why it is shown** (2026-08-16). On a real device, "an approval appeared only on the phone,
      //   never on the PC" happened. What is needed to isolate the cause is these two:
      //     transcript=not found → the subagent transcript cannot be resolved (= the quiet period never works)
      //     transcript=found     → resolved, but the result is not written yet (= a matter of time)
      //   ⚠️ No path is logged (it contains the home and project name / §6.2). Only whether it exists
      const found = await resolveAgentTranscript(meta?.transcriptPath, meta?.agentId)
      console.log(
        t(
          `[perm] サブエージェントの承認を表に出します agent=${meta?.agentId ?? '(不明)'} 記録=${found ? 'あり' : '見つからない'} tool=${info.toolName}`,
          `[perm] Surfacing a subagent approval agent=${meta?.agentId ?? '(unknown)'} transcript=${found ? 'found' : 'not found'} tool=${info.toolName}`,
        ),
      )
      if (!promoteQuiet(info.key)) {
        // ⚠️ Do not conclude "it was resolved automatically". It also ends up here when **it was replaced by a new
        //    request with the same fingerprint** (`keyOf` collapses the same tool and arguments in one turn into one marker).
        //    That would mislead diagnosis, so only write the facts (2026-08-14 review, medium)
        console.log(
          t(
            `[perm] サブエージェントの承認は表に出さずに終わりました（片付いた/置き換えられた） tool=${info.toolName}`,
            `[perm] A subagent approval ended without being surfaced (resolved/replaced) tool=${info.toolName}`,
          ),
        )
        return
      }
      void notifyPermission(info, meta?.transcriptPath)
      // ★ A team member's subagent: once surfaced, its leader is told too
      announceToLeader(info)
      broadcast({ type: 'permissions-changed', machine: info.machine, at: new Date().toISOString() })
    })()
  }, QUIET_MS)
  timer.unref?.()
  // ⚠️ Stop it once settled. Otherwise **it reads 1MB of transcript for an already-answered approval**
  //    (2026-08-14 review, low. Waste piles up for subagents with many approvals)
  return () => clearTimeout(timer)
}

/**
 * ★★ **What to put** in an approval notification (§6.2).
 *
 * ⚠️ **Identifiers and state only.** Strings derived from the conversation (`summary` / `detail` / prompts and code snippets)
 *    must never be included. Notifications show on the lock screen, and the delivery path is not ours.
 * ⚠️ It is **separated** from the sending code for testing. If this changes,
 *    `routes/permission.test.ts` fails (codex review 2026-08-18, low #5).
 */
export function permissionPayload(info: PermissionRequest, fields?: NotifyFields): PushPayload {
  // ★★ Use **the same construction** as status notifications (2026-08-21). Mixed formats are harder to read.
  //
  // ⚠️⚠️ Only **identifiers and fixed vocabulary** may be included. `summary` / `detail` are
  //    strings derived from the conversation, so **never pass them** (§6.2. Checked by tests).
  // ⚠️ `notificationText` bounds the length (unbounded, it exceeds 4KB and **the notification does not show**).
  const text = notificationText({
    ...(fields ?? {
      title: '',
      titleSource: 'fallback',
      sessionId: info.sessionId ?? '',
      project: info.project,
      machine: info.machine,
      account: info.account,
      label: PERMISSION_LABEL,
    }),
    // ★ The tool name is on the "fixed vocabulary" side. Always show it (you cannot answer without knowing what you are allowing)
    qualifier: clipField(info.toolName),
    label: PERMISSION_LABEL,
  })
  return {
    title: text.title,
    body: text.body,
    // ★ A different tag per approval. After answering, the PWA closes it with the same tag (permissionTag in shared)
    tag: permissionTag(info.machine, info.key),
    // ★ Jump to the thread. Approvals are meant to be "go in, read the conversation, then answer"
    //    (the same placement as Claude's Android app / user decision 2026-08-12).
    // ⚠️ A session that waits for approval on its first turn has no transcript and cannot show a record, but
    //    **the approval card alone is still shown on the thread screen** (Thread.tsx).
    //    Otherwise there would be no way to answer from the phone.
    // ⚠️⚠️ The URL must go through threadUrl. Writing `#/s/...` makes the Service Worker resolve it relative to
    //    `/sw.js`, and **tapping the notification opens the source of sw.js** (happened on a real device)
    url: threadUrl(info.sessionId),
    event: 'PermissionRequest',
    at: info.at,
  }
}

/**
 * Length of identifiers put in notifications. ⚠️ Only 1–2 lines are readable, so making it longer is pointless.
 * ⚠️ Without a length bound, a push exceeds the limit (4KB) and **the notification itself does not show**.
 */
export const FIELD_MAX = 64

/**
 * ★ The status wording for approval notifications.
 *
 * ⚠️ **Kept separate** from `statusLabel('waiting')` (= "要対応", needs attention). Using the same text as the idle notification
 *    makes it impossible to tell from the sound whether it is "really waiting for an answer" or "just left idle"
 *    (it came up while brainstorming on 2026-08-21).
 */
export const PERMISSION_LABEL = '承認待ち'

export function clipField(raw: string): string {
  const t = String(raw ?? '')
  return t.length <= FIELD_MAX ? t : `${t.slice(0, FIELD_MAX - 1)}…`
}

/** Send the push (call before waiting) */
export async function notifyPermission(
  info: PermissionRequest,
  transcriptPath?: string,
): Promise<void> {
  // ★ Include the title and context size. ⚠️ If unreadable it falls back to the 8-char ID (never show a false title)
  const fields = transcriptPath
    ? await notifyFieldsFromTranscript(transcriptPath, {
        machine: info.machine,
        account: info.account,
        project: info.project,
        sessionId: info.sessionId,
        label: PERMISSION_LABEL,
      })
    : undefined
  const payload = permissionPayload(info, fields)
  try {
    const res = await sendToAll(withPendingPerms(payload))
    console.log(t(`[perm] 承認待ちを通知 push=${res.sent} tool=${info.toolName}`, `[perm] Notified pending approval push=${res.sent} tool=${info.toolName}`))
  } catch (err) {
    console.warn(t('[perm] 通知の送信に失敗: ', '[perm] Failed to send the notification: ') + (err instanceof Error ? err.message : String(err)))
  }
}
