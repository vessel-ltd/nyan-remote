// Types shared by the agent and web.
//
// ⚠️ As a rule, "types only". Runtime values live here only when **drift between the two sides breaks things**
//    (`permissionTag`, `MAX_MESSAGE_BYTES`, `statusLabel`, the old approval card wording `LEGACY_*`, etc.).
//    Drift breaks things **silently** ("the notification never clears", "the UI can send but the agent refuses"),
//    so only those live in one place and are imported by both. Everything else stays types only.

import type { BuildInfo } from './release.ts'

export type SessionStatus =
  | 'working' // responding (session record status is busy)
  | 'background' // ★ running in background (status is shell = a background Bash is running)
  | 'waiting' // needs you (Notification hook = waiting for approval or input)
  | 'error' // failed (StopFailure hook)
  | 'done' // done (Stop hook. The turn ended and it waits for input)
  | 'idle' // running but none of the above
  | 'rate-limited' // rate-limited (taken from SDK events in M4)
  | 'unknown'

export type TitleSource = 'custom' | 'ai' | 'prompt' | 'fallback'

/**
 * ★ Reasons it does not become a keystroke (no frame).
 *
 * ⚠️ **The same set as the agent's `PaneFailure`** (`agent/src/claude/keys.ts`
 *    uses this type as-is). ⇒ Adding one makes the UI text table **fail the type check**.
 */
export type KeysUnavailable =
  | 'not-found' // that session was not found
  | 'no-relay' // not started via relay (= plain claude)
  | 'broken' // the self-description is broken
  | 'unverified' // cannot verify the process identity (mac, etc.)
  | 'ambiguous' // the same sessionId appears more than once
  | 'waiting' // the CLI is showing a dialog and waiting for a human

export interface SessionSummary {
  /** Which machine's agent holds it (os.hostname()) */
  machine: string
  /** Base name of CLAUDE_CONFIG_DIR. '.claude' / '.claude-r' */
  account: string
  /** ★ A synthetic row the UI built from an approval, with unknown account (carries `PermissionRequest.accountUnknown`) */
  accountUnknown?: true
  sessionId: string
  cwd: string
  /** basename(cwd) */
  project: string
  /** customTitle > aiTitle > first user message > fallback */
  title: string
  titleSource: TitleSource
  status: SessionStatus
  /**
   * ★ Reason for "needs you" (`waitingFor` that the CLI writes into the session record. 2026-08-18).
   * ⚠️ **Only present when the CLI says so**. Not present when the only basis is the approval tag
   *    (so that we never invent a reason). Display goes through `waitingReason()`
   */
  waitingFor?: string
  /** Whether the process is alive (was it in claude agents --json) */
  live: boolean
  permissionMode?: string
  gitBranch?: string
  /** Claude Code version (taken from transcript records) */
  cliVersion?: string
  /** ISO8601 */
  lastActivity: string
  transcriptBytes: number
  /** Name of the latest hook event the state is based on (`Stop` / `Notification` / `StopFailure`) */
  lastEvent?: string
  /**
   * One-line summary of "what happened while you were away". From the transcript's system/away_summary record.
   * ⚠️ It contains conversation-derived content, so it **never goes into Push notifications** (§6.2). In-app only.
   */
  awaySummary?: string
  /**
   * ★ Amount of context (tokens) the session currently uses. Added 2026-08-19.
   *
   * ⚠️ **No percentage.** The window size (1M / 200k) cannot be known from the transcript
   *    (`[1m]` does not appear in `model`), so **do not make up an unknown window**.
   * ⚠️ `undefined` when unknown (not 0). One turn stale while responding.
   */
  contextTokens?: number
  /**
   * ★★ **How what is sent from the phone arrives** (2026-08-24 / HANDOFF "per-session marker").
   *
   *   `keys`  … keystrokes. **No English frame** (indistinguishable from what a human typed)
   *   `inbox` … inbox. **Gets a frame**, and the receiver may interpret it as "from another session"
   *             and **reply to an unrelated session** (§9.7.2)
   *
   * ⚠️ **Cannot be attached to individual messages** (being indistinguishable from human input in the transcript is
   *    the price of keystrokes. Attaching it would be a lie) ⇒ only **per session**.
   * ⚠️ Decided by the agent's `scanPanes` (**the same function** that finds keystroke targets).
   * ⚠️ Not attached to sessions that are not alive (`undefined`).
   */
  sendRoute?: 'keys' | 'inbox'
  /** Why `sendRoute === 'inbox'` (used for the UI explanation. Absent for `keys`) */
  keysReason?: KeysUnavailable
  /**
   * ★★ Whether **auto-approve mode** is active for the session (2026-09-07).
   *
   * The agent automatically passes only "yes/no" approvals (questions with options and plan approval still stop).
   * ⚠️⚠️ **The UI must keep showing this.** This feature is the opposite of "stops if unnoticed":
   *    **"keeps running if unnoticed"**, so visibility is the core (`until` is an absolute ISO time).
   * ⚠️ Not attached to sessions that are not alive (no approvals arrive anyway).
   */
  autoApprove?: { until: string }
}

/**
 * ★★ "History" = **sessions whose process has ended**. Decided here only (2026-08-31).
 *
 * **Why it lives in shared**: `/sessions` now returns only "running" ones by default
 * (87% of bandwidth was `/sessions`, and 98% of that was **resending unchanged history** /
 * ARCHITECTURE §14.1.1.7). ⇒ **The agent's filter and the PWA's bucketing (`bucketOf` in `order.ts`)
 * must follow the same rule.**
 *
 * ⚠️⚠️ **Written in two places, they always drift** (CLAUDE.md. The notification text once disagreed in
 *    65 of 96 exhaustive cases). If only one drifts, **the PWA tries to put a row the agent did not return
 *    into the "running" bucket** = sessions disappear from the list.
 * ⚠️⚠️ The only input is `live`. **Never decide by `status`** — ended sessions keep
 *    their `done` / `error` tag, and conversely a running session holds `done` for a moment
 *    (right after a turn ends). Confirmed by mutation: deciding by `status` makes
 *    **sessions that just finished responding vanish from the list**.
 */
export function isHistorySession(s: { live: boolean }): boolean {
  return !s.live
}

/**
 * Response of `GET /sessions`.
 *
 * ★★ **The default stays "everything". Filtering is requested explicitly by new PWAs with `?live=1`**
 * (direction fixed on 2026-09-01). Measured 61,038 B → 466 B.
 *
 * ⚠️⚠️ **It first went the other way (filtered by default) and failed** (codex medium #1).
 *    It said "old agents ignore `?history=1`, so it is backward compatible", but **the breakage is the other direction**:
 *    with **an old PWA × a new agent**, the old PWA reads the query-less `/sessions` as everything,
 *    so **the whole history disappears, along with the way to open it**.
 *    ⚠️ This is not hypothetical: ① the PWA runs with the Service Worker holding an old bundle
 *    ② it is a symmetric mesh, so **one PWA talks to agents on several machines** (a state where only one is new always occurs).
 *    ⇒ **Keep the default as before and let the new side opt in** (fail-closed).
 * ⚠️ When a new PWA sends `?live=1` to an old agent, **the unknown query is ignored and everything comes back**
 *    = no 404. ⇒ No `/health` marker is needed; **the presence of `history` in the response is the marker**.
 */
export interface SessionsPage {
  machine: string
  /** ★ Everything by default. Only `live` ones with `?live=1` */
  sessions: SessionSummary[]
  /**
   * ★ History info. ⚠️ **Old agents do not have it** (`undefined` = the list above is everything and filtering does not work).
   * ⚠️ `count` / `rev` refer to **the whole history** regardless of filtering.
   */
  history?: {
    /** Number of history entries (the number shown on the collapsed heading) */
    count: number
    /**
     * ★★ History **revision**. A short string that changes when the contents change.
     *
     * ⚠️⚠️ **The count alone cannot detect changes in the set** (codex medium #2).
     *    When `maxSessionsPerAccount` (default 60 per account) is reached,
     *    one short session starting and ending **pushes out the oldest entry** =
     *    **the count stays the same while the contents change**. Judging by count, the PWA
     *    **never fetches the new history**.
     */
    rev: string
  }
}

/**
 * ★ Result of toggling auto-approve mode.
 *
 * ⚠️⚠️ **Never look successful silently.** If turning it off could not be saved, the file still
 *    holds the old tag (= restarting the agent **brings it back until expiry**). ⇒ Say so with `saved: false`.
 */
/**
 * ★★ **Name** of the auto-approve duration (2026-09-24 / user decision: choose 3 hours or 24 hours).
 * ⚠️⚠️ The UI sends **only this name**. The length is held by the agent's table (`AUTO_APPROVE_DURATIONS`)
 *    (no way for the UI to pass a length = no de facto unlimited duration / CLAUDE.md §2).
 * ⚠️ No permanent option (the expiry is the only safety net for "forgot about it" / user agreed).
 */
export type AutoApproveDuration = '3h' | '24h'

export interface AutoApproveResult {
  ok: boolean
  /** Expiry when turned on (ISO8601, absolute time). Absent when off */
  until?: string
  /** Reason for refusing. ⚠️ **A category only** (no absolute paths or contents / §6.2) */
  reason?: string
  /** ★ Whether it was written to the state file (`false` = may come back until expiry on restart) */
  saved?: boolean
}

export interface AccountInfo {
  account: string
  configDir: string
  /** Cached value from .claude.json. ⚠️ Stale values linger, so do not trust it (ARCHITECTURE.md §10) */
  loginCached?: string
  sessionCount: number
  /** Whether claude agents --json could run. false means live state is not available */
  liveAvailable: boolean
}

/**
 * ★★ **Features** the agent has (codex round 7 of 2026-08-25, medium #3).
 *
 * ⚠️⚠️ **Do not decide by version** (`agentVersion` is a fixed value, so it is no input).
 * ⚠️⚠️ **Do not reuse `sendRoute` as a marker for new features** (it marks "can deliver by keystrokes", and
 *    it **predates** `/command` and `/clear`). Measured: with `{live:true, sendRoute:'keys'}` like an old agent,
 *    "clear input" appeared, and pressing it gave **404**.
 * ⇒ **When adding an endpoint, add a marker here too** (while machines are updated one by one they are always mixed).
 * ⚠️ Without the marker (= an old agent), **do not show it** (fail-closed).
 */
export type AgentFeature =
  /** `POST /sessions/:id/command` (slash commands from the table) */
  | 'slash-commands'
  /** `POST /sessions/:id/clear` (clear the PC's input field / Ctrl-U) */
  | 'clear-input'
  /** `POST /sessions/:id/auto-approve` (toggle auto-approve mode) */
  | 'auto-approve'
  /** ★ Device keys of ③: `GET /devices` `POST /pair` `POST /devices/revoke` */
  | 'device-pairing'
  /**
   * ★ `POST /handshake` (device-key handshake = the first message of the step 6 tunnel).
   * ⚠️ **Kept separate from `device-pairing`**: an agent that can register but has no handshake endpoint
   *    can exist (while only one machine is updated). Sharing a marker would show **a button that 404s**.
   */
  | 'device-handshake'
  /**
   * ★ `GET /sessions/:id/follow` (follow a thread via notifications / 2026-09-23).
   * ⚠️ Without it, the PWA keeps following by 3-second polling as before (fail-safe).
   */
  | 'log-follow'
  /**
   * ★ `24h` can be chosen as the auto-approve duration (2026-09-24). ⚠️ Without it, only "3 hours" is shown
   *   (old agents do not know `duration`, so sending it gives 3 hours = disagrees with what the UI says).
   */
  | 'auto-approve-24h'

export interface AgentHealth {
  machine: string
  agentVersion: string
  nodeVersion: string
  uptimeSec: number
  devMode: boolean
  accounts: AccountInfo[]
  /** ★ Features it has. ⚠️ When absent (old agent), **do not show buttons for those features** */
  features?: AgentFeature[]
  /**
   * ★★ This agent's static key (base64url raw public key / device keys of ③).
   *
   * ⚠️⚠️ **Why it is needed**: the QR names the agent by **public key**, while the PWA holds endpoints
   *    by **URL** (discipline 1). Without something to match them, the PWA would
   *    "POST to every endpoint and take whichever succeeds", and **the one-time code leaks to other machines**
   *    （2026-09-08 / ARCHITECTURE §14.1.2.16）。
   * ⚠️ It is a public key, not a secret (the very value in the QR).
   * ⚠️ **Not attached** when the key is unusable (`undefined`). Old agents do not return it either.
   */
  agentPublicKey?: string
  /**
   * ★ State of the relay wire (step 6 of ③ / `agent/src/relayRun.ts`).
   *
   * ⚠️ This is **for diagnostics** (this `/health` may only be viewed locally).
   *    ⚠️⚠️ **Never use it to judge "connected"**: relay returns pong even without an agent,
   *    and the PWA judges by **its own wire going down** (§14.1.2.28).
   * ⚠️ Old agents do not return it (`undefined`).
   */
  relay?: RelayHealth
  /**
   * ★ This agent's version (2026-09-24 / update prompts). ⚠️ Old agents do not return it; not attached if unreadable.
   *   ⚠️ A value from outside ⇒ the UI passes it through `asBuildInfo` before use.
   */
  build?: BuildInfo
  /** ★ Account and plan (2026-09-24 / billing). ⚠️ Old agents do not return it */
  account?: AccountHealth
}

/**
 * ★ Account state shown in `/health` (`agent/src/account.ts`). ⚠️ The passphrase and ticket themselves are never included.
 */
export interface AccountHealth {
  signedIn: boolean
  login?: string
  plan?: string
  maxMachines?: number
  maxDevices?: number
  /** Ticket expiry (seconds) */
  exp?: number
  /** Latest reply from relay (`ok` / `machine-limit` / `invalid` / `expired`) */
  relay?: string
  problem?: string
}

/**
 * ★ State of the relay wire (step 6 of ③ / §14.1.2.29).
 *
 * ⚠️ `off` means "not configured or configuration unusable" (reason in `lastError`).
 */
export type RelayState = 'off' | 'connecting' | 'open' | 'waiting' | 'stopped'

export interface RelayHealth {
  state: RelayState
  /** ★ Consecutive failure count (⚠️ 0 while connected) */
  attempts: number
  /** Reason for the last drop / failure to connect */
  lastError?: string
}

/* ---- Registered devices (device keys of ③ / ARCHITECTURE §14.1.2.5) ---- */

/**
 * ⚠️⚠️ **"Device" means a phone or the app; "peer" means another machine on the same tailnet** (`PeerCandidate`).
 *    The names were split on 2026-09-07 (`GET /peers` lists other machines and is unrelated to this).
 */
export interface DeviceInfo {
  /** base64url of the raw public key (65B). ★ **This is the identity itself** (also the handle for revocation) */
  key: string
  /** Display name (⚠️ the string the device claimed. Never used for decisions) */
  label: string
  addedAt: string
  /** Public key fingerprint (short display id = `Identity.deviceId`) */
  deviceId: string
}

export interface DevicesResult {
  devices: DeviceInfo[]
  /**
   * ⚠️⚠️ Why the record is broken. **While present, every device-key connection is refused.**
   *    ⇒ The UI shows it **distinctly from "0 devices"** (the fix is different).
   */
  broken?: string
  /** Why the agent's static key is unusable (⚠️ while present, no QR can be shown either) */
  keyProblem?: string
  /**
   * ★★ When a lost key was recreated, and how many devices were registered at the time (2026-09-24 / `recreated` in `deviceKey.ts`).
   * ⚠️ Phones registered before that **cannot connect until they re-scan the QR** (they look for the relay room with the old key).
   */
  keyRecreated?: { at: string; registered: number | null }
}

export interface PairTokenResult {
  token: string
  expiresAt: string
  /** The string carried in the QR (`nyan://pair?...` / `shared/pairing.ts`) */
  url: string
  machine: string
  /** ★ Present if a lost key was recreated (same as `DevicesResult.keyRecreated`) */
  keyRecreated?: { at: string; registered: number | null }
  /**
   * ★ A number for status queries (2026-09-23). ⚠️ Not the one-time code.
   * ⚠️ Old agents do not return it ⇒ `npm run pair` waits as before without asking "was it scanned".
   */
  id?: string
}

/** ★ `GET /pair/token/:id` (local only) */
export type PairTokenStatus =
  | { state: 'waiting'; expiresAt: string }
  | { state: 'registered'; deviceId: string; label: string; already: boolean }
  | { state: 'failed'; reason: string }
  | { state: 'cancelled' }
  /** ★ A phone is in the middle of registering (waiting to save). ⚠️ Not expired (codex round 15, medium #1) */
  | { state: 'registering' }
  | { state: 'expired' }

/** ★ `POST /pair/token/:id/cancel` (local only) */
export interface PairTokenCancelResult {
  cancelled: boolean
}

export type PairResult =
  | { ok: true; deviceId: string; already?: boolean }
  | { ok: false; reason: string }

export type RevokeResult = { ok: true } | { ok: false; reason: string; saved?: boolean }

/**
 * Return value of the device-key handshake (`POST /handshake`).
 *
 * ⚠️⚠️ After receiving `reply`, **it is not a `Session` until `confirm` is opened**
 *    (`finishHandshake` → `accept()` / item 4 of ARCHITECTURE §14.1.2.6).
 * ⚠️ The agent side currently **discards** this session (step 6 holds on to it and uses it for round trips).
 */
export type HandshakeResult =
  | { ok: true; reply: string; confirm: string; deviceId: string }
  | { ok: false; reason: string }

/* ---- Peers (M3: mesh) ---- */

export interface PeerCandidate {
  hostname: string
  /** MagicDNS name (trailing dot dropped) */
  dnsName: string
  /** URL usable directly as an endpoint */
  url: string
  os?: string
  online: boolean
  /** Whether this is this agent itself */
  self: boolean
}

export interface PeersResult {
  /** Whether the tailscale command was usable */
  available: boolean
  /** MagicDNS suffix (used for the automatic CORS allowance) */
  suffix?: string
  peers: PeerCandidate[]
  reason?: string
}

/** Payload delivered by Claude Code hooks (shape verified with hooks/notify.sh) */
export interface HookPayload {
  hook_event_name?: string
  cwd?: string
  transcript_path?: string
  [k: string]: unknown
}

/** A hook as normalised by the agent */
export interface HookEvent {
  event: string
  machine: string
  account: string
  project: string
  sessionId?: string
  at: string
  /**
   * Notification kind.
   *   permission … asking for approval (= really needs a response)
   *   idle       … idle notice (fires a while after a turn ends)
   * ⚠️ Only the category is stored. The notification body is not stored (§6.2).
   */
  notice?: 'permission' | 'idle'
  /**
   * ★★ The id of that turn (the CLI `prompt_id`). Added 2026-09-21.
   *
   * ⚠️ Used **only so that dedup does not span turns** (`shouldSendLabel`).
   *    We want to fold the `Notification/idle` that arrives about 60 s after `Stop`,
   *    but **it was also folding the "done" of the next turn** (measured: gone for 3 turns in a row).
   * ⚠️⚠️ **Only the value from `Stop` is used as "the turn changed" marker** (whether the `prompt_id` of `idle`
   *    is the same value has **not been measured**, so nothing depends on it).
   * ⚠️ It is a UUID, not content, so keeping it in records does not touch §6.2.
   */
  promptId?: string
}

/**
 * Push body.
 *
 * ⚠️ Never include conversation content, prompts or code (identifiers and state only / §6.2).
 *    The payload is encrypted per RFC 8291, but as a policy it is simply not included.
 * ⚠️ 4KB limit. The body is fetched from the agent after opening.
 */
/**
 * ★★ One entry of the CLI `permission_suggestions`, trimmed to what display needs (2026-09-24).
 *    `kind` is spelled like the CLI `type` (`addDirectories` / `setMode`). Any other CLI type is `other`.
 * ⚠️ `directories` holds **only the last path segment** (same exposure as the old sentence. No full paths).
 * ⚠️ The UI **does not break or hide the card on an unknown `kind`** (future agents may add kinds) ⇒ it shows one generic word.
 */
export type PermissionSuggestion =
  | { kind: 'addDirectories'; directories: string[] }
  | { kind: 'setMode'; mode: string }
  | { kind: 'other'; type: string }

/**
 * ⚠️ **Legacy wording**. The Japanese put into `suggestions` / `agentType` / `account` for old UIs.
 *    ★ The agent (producer) and the UI (which matches old agents' sentences) look at **these same values** = the wording never drifts.
 *    ⚠️ **Do not change them** (old UIs could no longer match).
 */
export const LEGACY_SUBAGENT_LABEL = 'サブエージェント'
export const LEGACY_UNKNOWN_ACCOUNT = '(不明)'
export const LEGACY_DIRECTORY_PREFIX = 'このディレクトリを許可: '
export const LEGACY_MODE_PREFIX = 'このセッションのモードを '
export const LEGACY_MODE_SUFFIX = ' にする'

/** ⚠️ legacy: a single Japanese sentence for old UIs (put into `suggestions`). New UIs do not show it */
export function legacySuggestionText(s: PermissionSuggestion): string {
  switch (s.kind) {
    case 'addDirectories':
      return `${LEGACY_DIRECTORY_PREFIX}${s.directories.join(', ')}`
    case 'setMode':
      return `${LEGACY_MODE_PREFIX}${s.mode}${LEGACY_MODE_SUFFIX}`
    case 'other':
      return s.type
  }
}

/**
 * One pending approval (M4-1). Built from Claude Code's `PermissionRequest` hook.
 *
 * ⚠️ `tool_input` comes from the conversation, so it **never goes into the Push body** (§6.2).
 *    It is shown after opening the app, never in a notification.
 */
export interface PermissionRequest {
  /** Idempotency key. Chosen with priority tool_use_id > prompt_id */
  key: string
  machine: string
  account: string
  project: string
  sessionId?: string
  promptId?: string
  toolUseId?: string
  toolName: string
  /**
   * ★ If the request comes from a subagent (the side started by `Task`), its kind.
   *
   * ⚠️ Whether `agent_id` is present decides "from a subagent" (confirmed in the CLI 2.1.231 code).
   *    Subagent requests **are often auto-approved on the main side and disappear**, so
   *    it waits quietly for a few seconds before showing them (`quietUntil` in agent/src/permission.ts).
   */
  agentType?: string
  /**
   * ★★ Always present for subagent requests (2026-09-24 / structured). `type` is the CLI `agent_type`
   *    (absent if missing = the UI shows "subagent" in its own language).
   * ⚠️ `agentType` **is kept for old UIs** (old UIs show the badge and the note based on whether `agentType` exists.
   *    Removing it means old UIs **can no longer tell it came from a subagent**). The agent's own checks also look at whether `agentType` exists.
   *    Without `agent_type`, `agentType` is {@link LEGACY_SUBAGENT_LABEL} (a fixed Japanese value).
   */
  subagent?: { type?: string }
  /** What it is trying to make the tool do. Pre-formatted for display (**collapsed to one line and cut at 400 chars**) */
  summary: string
  /**
   * ★ The full text opened by tapping the card (**newlines preserved**). Absent if `summary` is already the full text.
   *
   * ⚠️ **Never put it in a notification** (§6.2. It is a conversation-derived string itself).
   *    Only for the person approving to read after opening the app.
   */
  detail?: string
  /** ★ Even that full text is cut off (= seeing it is not seeing everything). The UI says so */
  detailClipped?: boolean
  /**
   * ⚠️ **Legacy**. Sentences like "このディレクトリを許可: …" that the agent turned into **Japanese sentences**.
   *    New UIs use {@link suggestionItems} and read this **only when that is absent (old agents)**.
   * ★ New agents keep sending it too (decided 2026-09-24): old UIs only read this field, and
   *    without it the "can be chosen on the PC" line **silently disappears** (nothing breaks, but information is lost).
   *    The wording lives in one place, {@link legacySuggestionText} (`agentText.ts` of old UIs matches against it to translate).
   */
  suggestions?: string[]
  /**
   * ★★ Permission candidates the CLI offers (display only / 2026-09-24 / structured). The UI turns them into sentences in its own language.
   * ⚠️ Display only. **The phone never sends these back** (an approval answer is just the chosen label / CLAUDE.md §2).
   */
  suggestionItems?: PermissionSuggestion[]
  /**
   * ★ The agent could not read the account from the transcript (2026-09-24 / structured).
   *    The UI shows "(unknown)" in its own language. ⚠️ For old UIs, `account` still carries
   *    {@link LEGACY_UNKNOWN_ACCOUNT} (old UIs show `account` as-is).
   */
  accountUnknown?: true
  permissionMode?: string
  at: string
  /**
   * ★★ An approval that cannot be answered with "yes/no" (`AskUserQuestion` / `ExitPlanMode`).
   *
   * ⚠️ For tools whose CLI definition returns `requiresUserInteraction()`,
   *    **an `allow` without `updatedInput` is silently discarded** (confirmed in the CLI 2.1.232 implementation).
   *    So pressing "allow" **leaves the PC waiting**. That happened on a real device (2026-08-14).
   *    → The options must be shown on screen and **the chosen one sent back** (§9.11).
   */
  interaction?: Interaction
}

/** ★ A question with options (built from `AskUserQuestion` input. Used for both display and validation) */
export interface InteractionQuestion {
  question: string
  header?: string
  multiSelect: boolean
  options: InteractionOption[]
}

/** One option */
export interface InteractionOption {
  label: string
  description?: string
  /**
   * ★ A diagram or code snippet attached to an option (the CLI `preview`. Supported 2026-08-18).
   *
   * In the PC dialog it appears monospaced in the right-hand box **only for the option being highlighted**.
   * The phone has no width and no "focus", so **it stacks the previews of all options vertically**.
   *
   * ⚠️⚠️ **Newlines and leading spaces carry meaning** (box-drawing, code).
   *    Markdown would break it, so the UI passes it to `<pre>` as a string
   *    (`web/src/ui/Permissions.tsx`. The `innerHTML` ban still applies).
   * ⚠️ **Never put it in a notification** (§6.2). The approval Push body has identifiers only.
   */
  preview?: string
  /** ★ Cut at the limit (= seeing it is not seeing everything). The UI says so */
  previewClipped?: boolean
}

export type Interaction =
  | { kind: 'question'; questions: InteractionQuestion[] }
  /** Plan approval. Nothing to choose, but `allow` needs `updatedInput` */
  | { kind: 'plan' }

/**
 * ★ An answer from the phone.
 *
 * ⚠️⚠️ **Never accept `updatedInput` itself.**
 *    Accepting it would allow "rewriting the command while approving a Bash call".
 *    The phone sends **only the chosen labels**, and the agent builds it by matching against
 *    the original `tool_input` (agent/src/claude/interaction.ts).
 */
export interface PermissionAnswer {
  key: string
  behavior: 'allow' | 'deny'
  /** Question text → chosen labels (sent as an array even for single choice) */
  answers?: Record<string, string[]>
  /**
   * ★ Deny with "please change it like this" attached (like the PC `3. Tell Claude what to change`).
   *
   * ⚠️ Only meaningful when `behavior: 'deny'`. The CLI passes the hook's deny `message`
   *    **to the model as the reason for denial**, so this becomes "what to fix" as-is.
   * ⚠️ The limit is `MAX_MESSAGE_BYTES` (shared so that the UI and the agent do not drift)
   */
  feedback?: string
}

/**
 * Limit for instructions sent from the phone (M4-2). **Lives here so both sides see the same value.**
 *
 * ⚠️ Separate constants drift. Drift means "the UI can send it but the agent refuses with 400"
 *    (= retyping). It is not a tool for long texts, so short is fine.
 */
export const MAX_MESSAGE_BYTES = 4096

/**
 * Japanese state labels. **Both the list (PWA) and notifications (agent) use them, so they live here.**
 *
 * ⚠️ With separate strings, fixing one makes **the list and notifications disagree**.
 *    That is exactly what happened on 2026-08-16 (the list said "running in background", the notification said "done").
 *
 * ⚠️ Never mix conversation-derived words in here (they go into notification bodies / §6.2).
 */
export function statusLabel(status: SessionStatus): string | null {
  switch (status) {
    case 'working':
      return '応答中'
    case 'background':
      return '背景で実行中'
    case 'waiting':
      return '要対応'
    case 'error':
      return '⚠ 異常終了'
    case 'done':
      return '完了'
    case 'rate-limited':
      return '制限中'
    case 'idle':
      return '起動中'
    default:
      return null
  }
}

/**
 * ★ Text used when the state could not be read (formerly "turn ended" / renamed 2026-08-21).
 *
 * ⚠️ Shown when `Stop` arrived but **the state could not be read right before sending**. Not "failed", but
 *    a self-report of "could not confirm whether it is done" (`probeStatus` in `agent/src/routes/hook.ts`).
 *    With "turn ended" the difference from "done" could not be read, so it was changed.
 *
 * ⚠️ It lives here **so notifications and the UI never disagree** (same reason as `statusLabel`).
 */
export const UNKNOWN_LABEL = '状態不明'

/**
 * ★★ Whether **to play a sound** for that state (2026-08-21 user decision).
 *
 * Only "in-progress states that are obvious when you are looking" stay silent:
 *
 * ```
 * ring    needs you / done / ⚠ failed / unknown / approval needed / any unknown wording
 * silent  working / running in background
 * ```
 *
 * ⚠️⚠️ **Do not write the check as "a list of what rings".** If it falls toward **silence** when unknown wording is added,
 *    that state **goes unnoticed by everyone** (the same failure type as the iPhone staying silent for 3 days).
 *    ⇒ **List only what is silent, ring for everything else** (fail-loud).
 * ⚠️ `UNKNOWN_LABEL` had 0 occurrences over 14 days of measurement, but it **rings**. Insurance so that a bug
 *    that makes the state unreadable does not turn every notification silent (user decision 2026-08-21).
 */
export function shouldRing(label: string): boolean {
  return label !== statusLabel('working') && label !== statusLabel('background')
}

/**
 * Round to a human-readable form. **Do not round to nearest** (truncate).
 *
 * ⚠️ Rounding up could make "still has room" look like "at the limit". Lean toward showing less.
 * ⚠️⚠️ **No percentage.** The window size (1M / 200k) cannot be known from the transcript, so
 *    **do not make up an unknown window** (explanation in `web/src/ui/tokens.ts`).
 *
 * ⚠️ It lives here **because both the list (PWA) and notifications (agent) use it** (same reason as `statusLabel`).
 */
export function formatTokens(n: number | undefined): string | undefined {
  if (n === undefined || !Number.isFinite(n) || n <= 0) return undefined
  if (n < 1000) return `${Math.floor(n)}`
  if (n < 1_000_000) return `${Math.floor(n / 1000)}k`
  // 1M and above: one decimal (truncated)
  return `${Math.floor(n / 100_000) / 10}M`
}

/** Inputs for a notification. **Built from the same values as the list row** (never disagree) */
export interface NotifyFields {
  /** SessionSummary.title (customTitle > aiTitle > first user message > fallback) */
  title: string
  titleSource: TitleSource
  sessionId: string
  /** basename(cwd) */
  project: string
  machine: string
  /** Base name of CLAUDE_CONFIG_DIR (`.claude-r`). Shown without the leading `.` */
  account: string
  /** State text. Pass what `statusLabel` / `settledLabel` produced */
  label: string
  /**
   * A short word appended after the state as `（…）`. A reason (return value of `waitingReason`) or a tool name (`Bash`).
   *
   * ⚠️⚠️ **Never put conversation-derived strings here** (§6.2). Passing `summary` or
   *    `PermissionRequest.detail` would **put prompts or code on the lock screen**.
   *    Only **fixed vocabulary** (return values of `waitingReason`, tool names) may go here.
   */
  qualifier?: string
  contextTokens?: number
}

/** Keep line 1 of the notification from pushing line 2 out (also helps with the 4KB limit) */
const NOTIFY_TITLE_MAX = 80
const NOTIFY_FIELD_MAX = 60

/**
 * ★ Join with `·`. But **no space right after a full-width closing bracket**.
 *
 * ⚠️ `要対応（承認プロンプト） · PC-B` has space to the right of the full-width `）`, so **the gap is too wide**.
 *    Japanese typesetting puts no space after a closing bracket (the spec from the user had that shape too).
 */
function joinParts(parts: string[]): string {
  let out = ''
  for (const p of parts) {
    if (!out) {
      out = p
      continue
    }
    out += /[）」』】〕］｝]$/.test(out) ? `· ${p}` : ` · ${p}`
  }
  return out
}

function clipTo(s: string, max: number): string {
  const t = s.trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/**
 * ★★ Build the notification text (2026-08-21). The requirement from the user is **to look like the list row**.
 *
 * ```
 * Fix the flaky login test
 * 要対応（承認プロンプト）· PC-B · claude-r · ctx 87k
 * ```
 *
 * Only when line 1 falls back to the 8-char ID, add **the project name as line 3**
 * (when the title is meaningless, two sessions of the same worker tree could not be told apart).
 *
 * ⚠️⚠️ **Titles from `ai` are an explicit exception to §6.2** (2026-08-21 user decision).
 *    The only exception to the policy of keeping conversation-derived strings out of notification bodies, chosen
 *    knowing it **appears on the lock screen** (judged that matching the list outweighs it).
 *    ⚠️ **Do not strip it on your own.** Stripping it breaks a requirement the user decided.
 * ⚠️ `prompt`-derived titles (the typed text itself) are **not shown**. They are a step rawer, so fall back to the ID.
 * ⚠️ `awaySummary` is not included (summary or not, it is entirely conversation-derived / §6.2).
 */
export function notificationText(f: NotifyFields): { title: string; body: string } {
  // ★ Only custom and ai titles are meaningful. Anything else falls back to the 8-char ID
  const named = f.titleSource === 'custom' || f.titleSource === 'ai'
  const heading = named ? clipTo(f.title, NOTIFY_TITLE_MAX) : ''
  const fallbackId = f.sessionId ? f.sessionId.slice(0, 8) : '—'
  const line1 = heading || fallbackId

  const q = f.qualifier?.trim()
  const parts = [q ? `${f.label}（${clipTo(q, NOTIFY_FIELD_MAX)}）` : f.label]
  if (f.machine) parts.push(clipTo(f.machine, NOTIFY_FIELD_MAX))
  // ★ Drop the leading `.` (`.claude-r` → `claude-r`)
  const account = f.account.replace(/^\./, '')
  if (account) parts.push(clipTo(account, NOTIFY_FIELD_MAX))
  const ctx = formatTokens(f.contextTokens)
  if (ctx) parts.push(`ctx ${ctx}`)

  const lines = [joinParts(parts)]
  // ★ Add the project name only when the title fell back to the ID
  if (!heading && f.project && f.project !== '—') lines.push(clipTo(f.project, NOTIFY_FIELD_MAX))

  return { title: line1, body: lines.join('\n') }
}

/**
 * ★ Turn the **reason** for "needs you" into Japanese (2026-08-18).
 *
 * The CLI writes `waitingFor` along with `status: "waiting"` into the session record
 * (confirmed via `kZh()` → `HHn({status, waitingFor})` in 2.1.234).
 *
 * ⚠️ The values are **a fixed set**, looked up from the kind of dialog that is open (`VuA`):
 *
 *   "input needed" / "dialog open" / "goal proposal"
 *   / "sandbox request" / "worker request"
 *   / ★ **Every kind not in the table becomes "permission prompt"** (`hbg` does `VuA[k] ?? "permission prompt"`)
 *
 *   → So **the raw dialog name never arrives** (in this version).
 *     But the table grows across versions, so **unknown values are shown as-is** (dropping them loses the reason).
 *
 * ⚠️ The wording lives here **so notifications (agent side) and the UI never disagree**
 *    (same reason as `statusLabel` / CLAUDE.md).
 */
export function waitingReason(waitingFor: string | undefined): string | null {
  if (!waitingFor) return null
  const t = waitingFor.trim()
  if (!t) return null
  switch (t) {
    case 'permission prompt':
      return '承認プロンプト'
    case 'sandbox request':
      return 'sandbox の許可'
    case 'input needed':
      return '入力が必要'
    case 'dialog open':
      return 'ダイアログ'
    case 'worker request':
      return 'worker の要求'
    case 'goal proposal':
      return '目標の提案'
    default:
      return t
  }
}

/**
 * The `tag` of approval notifications. **Both the agent (sender) and the PWA (which clears them) use it, so it lives here.**
 *
 * ⚠️ Building the string separately drifts when one side is fixed, and **notifications stop clearing**.
 *    Each approval gets a different value (the key is included), so two in a row do not replace each other.
 */
export function permissionTag(machine: string, key: string): string {
  // ⚠️ The key ends with "the waiter generation" (`#xxxx`). **Drop it in the tag.**
  //    Otherwise the tag changes every time the hook re-enters for the same approval, and
  //    **notifications for the same approval pile up** (the hook can start several times / measured).
  const i = key.lastIndexOf('#')
  const base = i < 0 ? key : key.slice(0, i)
  return `perm-${machine}-${base}`
}

export interface PushPayload {
  title: string
  body: string
  /**
   * ★ The sending machine (2026-08-20). The Service Worker of the PWA uses it
   * to clean up **only the approval notifications of this machine**.
   */
  machine?: string
  /**
   * ★★ Notification tags of approvals **currently waiting for an answer** on that machine.
   *
   * Why needed: approval notifications are one slot each, so they cannot be folded (folding removes the way to answer the second).
   * Cleanup after answering on the PC **only runs while the app is open**, so while it is closed
   * "approval needed" lingers. ⇒ **Close them alongside the next notification** (a notification is shown anyway,
   * so the `userVisibleOnly` rule is satisfied).
   *
   * ⚠️⚠️ **Always a superset** (including ones waiting quietly). Passing an incomplete list
   *    **clears notifications for approvals still waiting** (= stalls unnoticed, the worst failure of this tool).
   * ⚠️ When it does not fit within the limit, **omit it** (a truncated list is dangerous for the reason above).
   *    Without it the sw does nothing (no fail-open).
   */
  pendingPerms?: string[]
  /**
   * ★★ **No sound or vibration** (2026-08-21). `silent` of `showNotification`.
   *
   * With a design that mirrors state in the notification tray, **only states that need attention should ring**
   * (needs you, done and failed ring / working and running in background are replaced quietly).
   *
   * ⚠️ Passing `silent: true` together with `vibrate` is a **TypeError** (per spec). `vibrate` is not used.
   * ⚠️ `renotify` is the inverse of `silent` (`sw.js`). Setting both means "ring even on replace" and
   *    "do not ring" are specified at once, and **which wins depends on the implementation**.
   * ⚠️⚠️ **Whether iOS honours silent is unverified** (the main device is an iPhone / `web.push.apple.com`).
   *    If it does not, "replace quietly" does not hold. **Measure before finalising the design.**
   */
  silent?: boolean
  /** Notifications with the same tag replace each other */
  tag?: string
  /** Path to open on tap */
  url?: string
  event?: string
  /** ISO8601. The Service Worker uses it as the notification timestamp (shown in the device TZ) */
  at?: string
}

/**
 * ★ **Send failures that do not get cleaned up** (2026-08-21).
 *
 * 404 / 410 delete the subscription, so they get noticed, but **403 does not**, so
 * it keeps showing "subscribed" while no notifications arrive. In fact **the iPhone received nothing for 3 days
 * and nobody noticed** (Apple was rejecting the VAPID `subject`).
 *
 * ⚠️ Only the category is kept. No raw error strings or bodies (§6.2).
 */
export interface PushFailure {
  /** ISO8601 */
  at: string
  /** HTTP status code. null if unknown */
  status: number | null
}

/**
 * Result of sending an instruction.
 *
 * ★ `route` is returned **for matching in the UI** (`web/src/ui/pending.ts`).
 * ⚠️ Instructions delivered by keystrokes **have no `origin`** (same shape as human typing), so
 *    the thread element gets no `via`. **Unless the sender remembers the route,
 *    "cannot confirm it arrived" never goes away** (seen on a real device on 2026-08-23).
 */
export interface MessageSendResult {
  ok: true
  at: string
  /** `keys` = keystrokes (no frame) / `inbox` = inbox (gets an English frame) */
  route: 'keys' | 'inbox'
  /**
   * ★ It started with `/` or `!`, so it was sent **as text with one space prepended** (2026-08-24).
   *
   * ⚠️ Returned **so it is never rewritten silently** (the UI says so). Running as a command only happens via
   *    the table in the agent + the dedicated endpoint (never from free input).
   */
  neutralized?: boolean
}

/**
 * ★ Result of "stop" (ESC).
 *
 * ⚠️ **The key to send is never specified by the UI** (fixed in the table in the agent). So neither the request nor the result
 *    carries a key name = if you want more, **add an endpoint** (it never widens silently).
 * ⚠️⚠️ Not a guarantee that "it stopped". **Only as far as the relay socket receiving it**
 *    (measured: even a socket nobody reads returns `ok`. Right after start the CLI discards input).
 *    ⇒ Check the result in the thread. The UI also does not say "stopped".
 */
/**
 * ★★ Ids of slash commands the phone may run **as real commands**.
 *
 * ⚠️⚠️ They never run from free input (`/` `!` get one space prepended and arrive **as text** /
 *    `sanitizeForKeys`). Only **this table + the dedicated endpoint** (`POST /sessions/:id/command`) run them.
 * ⚠️ Two conditions for adding one (CLAUDE.md §2):
 *    ① **non-interactive** (anything that opens a dialog becomes `status:'waiting'`, and keystrokes and ESC all stop)
 *    ② **its effect is visible from the phone** (otherwise "pressed it and nothing happened")
 * ★ Measured (2026-08-25 / CLI 2.1.241): `/compact` runs via keystrokes and **opens no dialog**.
 *   `/exit` ends cleanly through the relay (the self-description disappears and it drops from the list).
 * ⚠️ The actual characters sent are held by the table in the agent (`SLASH_COMMANDS`). **The UI can only pass the id**.
 */
export type CommandId = 'compact' | 'exit'

/** ★ Return value for "sent". ⚠️ Not a guarantee that "it took effect" (same as `InterruptResult`) */
export interface CommandResult {
  ok: true
  at: string
  id: CommandId
}

export interface InterruptResult {
  ok: true
  at: string
  /**
   * ★ After "stop", the PC input field was cleared too (when it was responding / 2026-09-24).
   * ⚠️ Old agents do not set it (⇒ the UI shows the old guidance). Never set on the "clear input" endpoint.
   */
  cleared?: boolean
}

export interface PushStatus {
  /** VAPID public key (needed for subscribing) */
  publicKey: string
  /**
   * Whether the subscription of this device is registered.
   * ⚠️⚠️ It means **"is any one of them present"** (true even if an old endpoint remains).
   *    ⇒ Whether it "holds a subscription **for this scope**" is judged by `endpointTags` (codex round 13, high #3).
   */
  subscribed: boolean
  /**
   * ★★ **Tags** of the endpoints the agent holds for this device (`shared/pushTag.ts`).
   * ⚠️ The endpoint itself is not returned (capability URL). ⚠️ Old agents do not return it (⇒ the PWA treats it as unknown).
   */
  endpointTags?: string[]
  /** Total number of registered devices */
  deviceCount: number
  /**
   * ★ The latest send failure to this device (if any). **Makes "subscribed but nothing arrives" visible**.
   * ⚠️ Its absence does not mean "succeeded" (it disappears on agent restart).
   */
  lastFailure?: PushFailure
}

/* ---- Thread view (M2) ---- */

/** Tool display is folded to one line by default (same as the Claude Code TUI) */
export interface Foldable {
  /** Body shown when unfolded. Newlines preserved */
  summary: string
  /** Line count of summary. 2 or more means it can be opened by tapping */
  lines: number
  /** Whether it was cut because the original was too long */
  truncated: boolean
}

export type LogEntry =
  /**
   * `via: 'inbox'` = **an instruction this agent sent** (= from the phone / M4-2).
   * `via: 'peer'`  = ★ **came from the inbox, but not sent by us** (another Claude session, etc.).
   *   ⚠️ `origin.kind === 'peer'` is not a nyan-remote-specific marker, so
   *      showing it as "you" would **make instructions we never sent look like our own messages**.
   * ⚠️ The UI needs to tell them apart. If it looked the same as what was typed on the PC,
   *    later you could not tell "did I send it from the phone or type it on the PC".
   */
  | { kind: 'user'; at?: string; text: string; via?: 'inbox' | 'peer'; from?: string }
  | { kind: 'assistant'; at?: string; text: string }
  | { kind: 'thinking'; at?: string; text: string }
  | ({ kind: 'tool_use'; at?: string; name: string; id?: string } & Foldable)
  | ({ kind: 'tool_result'; at?: string; ok: boolean; forId?: string } & Foldable)
  | { kind: 'system'; at?: string; text: string }
  /**
   * ★★ **Internal records** a slash command (`/compact` etc.) leaves in the transcript
   *    (measured 2026-08-25 / 5.0-x). ⇒ **Fold to one line, readable when opened**.
   *
   * ⚠️ Without this, the conversation fills up with **the whole summary** (thousands of characters) and tags like `<command-name>`
   *    (measured: one `/compact` added four "your messages").
   * ⚠️⚠️ **Never delete them**. The condition for putting a command in the table is "**its effect is visible from the phone**",
   *    so dropping `<local-command-stdout>` (= output of the command)
   *    makes it look like "pressed it and nothing happened".
   */
  | ({ kind: 'meta'; at?: string; label: string } & Foldable)

/**
 * ★★ Whether that body is already at the end of the transcript (**used by both the agent and the PWA**).
 *
 * ⚠️ Implemented separately, fixing only one drifts, and **the same body appears twice** or **not at all**
 *    (lives here for the same reason as `permissionTag`).
 * ⚠️ The hook `message_id` is a UUID, while the transcript uses `msg_…`, **different schemes**, so they cannot be matched.
 *    ⇒ **Match on the start of the body**. ⚠️ When undecidable, lean toward "already there" (do not show too much).
 * ⚠️ **The agent side alone is not enough**: live-follow responses contain only new elements, so
 *    it must match against all elements the UI holds (noticed during implementation on 2026-08-21).
 */
export function alreadyInTranscript(
  inflightText: string,
  entries: { kind: string; text?: string }[],
  /**
   * ★ Whether the body is complete. ⚠️ **If complete, compare the whole text** (codex 2026-08-21, medium #8).
   *    Comparing only the first 120 characters meant **a message starting the same as the previous one**
   *    made the new explanation vanish (e.g. a boilerplate opening).
   */
  final = false,
): boolean {
  const trimmed = inflightText.trim()
  if (trimmed.length === 0) return true
  // ★ If complete, compare **the whole text** (codex 2026-08-21, medium #4).
  //   ⚠️ It used to be the first 4000 characters, so "identical for 4000 characters, then the deciding detail"
  //     made the new explanation vanish. The comment said "whole text" but the implementation differed.
  const head = final ? trimmed : trimmed.slice(0, 120)
  // ★★ **Short remarks are cleared only on an exact match** (same review, low #7).
  //    ⚠️ Previously anything under 4 characters was treated **unconditionally as "already there"**, so
  //      **legitimate one-liners right before an approval** like `了解` `続行。` did not show.
  const exactOnly = trimmed.length < 8
  // ★★ **Do not cut by distance** (same review, medium #2). One assistant message expands into **one element per block**,
  //    so with parallel tool calls the body can be 7 or more elements back.
  //    Looking at a window of the last 6 made **the same explanation display twice for the whole tool run**.
  //    ⇒ Look back at up to 3 "recent assistant elements", **however many elements lie between**.
  let seen = 0
  for (let i = entries.length - 1; i >= 0 && seen < 3; i--) {
    const e = entries[i]
    if (!e || e.kind !== 'assistant' || typeof e.text !== 'string') continue
    seen++
    const body = e.text.trim()
    if (exactOnly ? body === trimmed : body.startsWith(head)) return true
  }
  return false
}

export interface InflightMessage {
  /** The streaming body (the deltas joined in order) */
  text: string
  /** Whether it is complete (`final`). If not, it can show "still writing" */
  final: boolean
  at: string
  /** Whether it was cut at the limit */
  clipped?: boolean
}

export interface LogPage {
  sessionId: string
  account: string
  /** Chronological (old → new) */
  entries: LogEntry[]
  /**
   * Cursor for reading older entries (byte position in the file).
   * null means everything has been read back to the start.
   */
  cursor: number | null
  /** Position of the end of the file. Starting point of live follow */
  tail: number
  bytes: number
  /**
   * ★★ **Body not yet written to the transcript** (2026-08-21).
   *
   * The CLI batches transcript writes, and **flushing stops while it waits for a human answer**
   * (measured: 0 bytes for 93 s → +10KB the moment it was answered). ⇒ The "explanation right before" an approval card
   * is always missing by construction. What the `MessageDisplay` hook intercepted goes here.
   *
   * ⚠️ **undefined if the hook is not installed** (it just falls back to the previous display).
   * ⚠️ Not returned when reading backwards (`before`) (it is about "now").
   */
  inflight?: InflightMessage
}

/** What flows over SSE */
export type AgentEvent =
  | { type: 'hello'; machine: string; at: string }
  | { type: 'heartbeat'; n: number; at: string }
  | { type: 'hook'; hook: HookEvent }
  | { type: 'sessions-changed'; at: string }
  /** Pending approvals increased or decreased (M4-1). The PWA re-fetches /permissions */
  | { type: 'permissions-changed'; machine: string; at: string }
  /**
   * ★★ The session's record or its "body being written" grew (2026-09-23 / `GET /sessions/:id/follow`).
   * ⚠️⚠️ Sent **only to devices subscribed to that session** (not to `/events` = does not reach devices not looking,
   *    or background tabs). The PWA fetches the continuation on receipt (no body included = the notification is just a signal).
   */
  | { type: 'log-appended'; sessionId: string; at: string }

/* ---- How "the start of the body" is judged (★ the agent and the UI use **the same function** / 2026-08-24) ---- */

/**
 * Whether it is a control character **dropped** from keystrokes (C0 except LF/CR, DEL, C1).
 *
 * ⚠️ Letting ESC through moves the option dialog. ⚠️ **CR is not dropped here**
 *    (`sanitizeForKeys` turns it into a newline. Dropping it joins lines).
 * ★ Why the check is in one place: if the UI wrote its own, **its view of the start drifts from that of the agent**
 *   (it actually drifted on invisible characters: the UI showed no warning while the agent was rewriting).
 */
export function isDroppedControl(code: number): boolean {
  return (
    (code < 0x20 && code !== 0x0a && code !== 0x0d) ||
    code === 0x7f ||
    (code >= 0x80 && code <= 0x9f)
  )
}

/**
 * ★★ Leading "invisible characters" (codex 2026-08-24, high #1).
 *
 * ⚠️⚠️ `trimStart()` only drops Unicode **whitespace**. Measured (node):
 *    U+FEFF(BOM) / U+3000 are dropped but **U+200B / U+200C / U+200D / U+2060 are not**.
 *    codex further pointed out that **U+00AD(SHY) / U+061C(ALM) / U+200E,200F(LRM,RLM) /
 *    U+2066-2069(isolate) / variation selectors / tag characters (U+E0000 range) / U+180E / U+1680 /
 *    U+3164(HANGUL FILLER)** are not dropped either.
 * ⇒ **Stop appending lists of invisible characters** (it always misses some). Select by Unicode property:
 *    whitespace + \p{Cf} (format) + \p{M} (mark) + Default_Ignorable_Code_Point.
 * ★ Which side is safe: **dropping and normalising to one space** (the shape measured to be safe).
 *    Keeping them bets on "whether the CLI ignores that character" (cannot be measured).
 */
export const LEADING_INVISIBLE = /^[\s\p{Cf}\p{M}\p{Default_Ignorable_Code_Point}]+/u

/** With control characters and leading invisible characters dropped (= starts from the first "visible" character) */
export function visibleHead(text: string): string {
  let cleaned = ''
  for (const ch of text.replace(/\r\n?/g, '\n')) {
    if (!isDroppedControl(ch.codePointAt(0) ?? 0)) cleaned += ch
  }
  return cleaned.replace(LEADING_INVISIBLE, '')
}

/**
 * Whether the CLI **may interpret the body as a command** (`/` = slash command / `!` = bash mode).
 *
 * ★ The agent (neutralising keystrokes, how to hand off to the inbox) and the UI (warning while typing) look at **this one function**.
 */
export function looksLikeCommand(text: string): '/' | '!' | null {
  const head = visibleHead(text)
  if (head.startsWith('/')) return '/'
  if (head.startsWith('!')) return '!'
  return null
}
