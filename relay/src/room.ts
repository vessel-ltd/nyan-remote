// Step 6 ③ of ③: **the contents** of the rendezvous (⚠️ knows nothing about the Durable Object API).
//
// ★★ **Why it was pulled out of `worker.ts`** (2026-09-15 / codex round 4):
//   the worker imports `cloudflare:workers`, so **not a single line ran from `npm test`**.
//   ⇒ The **most accident-prone decisions** ("not treated as an agent until proven", "number reuse", "disconnecting the old agent")
//     were only exercised by the smoke test against a real relay.
//   ⇒ The shape matches `openTunnel` / `openRelayLink` (**the carrier is passed in from outside**).
//
// ⚠️ Only "decisions" live here. Accepting sockets, storing tags and key generation are on the other side of `RoomIo`.

import { initDevicePublicKey, relayProof, sameBytes, toBase64Url, type Jwk, type Key } from '../../shared/crypto.ts'
import {
  RELAY_NONCE_BYTES,
  decodeDeviceProof,
  decodeProof,
  encodeChallenge,
  encodeDeviceChallenge,
} from '../../shared/relayAuth.ts'
import {
  MAX_RELAY_BYTES,
  RELAY_FRAME,
  decodeRelayFrame,
  encodeRelayFrame,
  type LicenseStatus,
} from '../../shared/relayFrame.ts'
import { PLAN_LIMITS, type LicenseCheck } from '../../shared/license.ts'

/**
 * ★★ How many phones can hang off one agent (the basis of the device limit in §14.1.1.5).
 *
 * ⚠️⚠️ **The limit lives on the relay side** (on the agent side it would be removed in the OSS).
 * ★ On our relay a room takes its plan's value (Free 2 / Plus 5, from a ticket or the free tier); this is the ceiling, and the
 *   whole allowance on a self-hosted relay.
 */
export const MAX_DEVICES = 8

/**
 * ★★ The free tier without sign-in (2026-09-27 / docs/BILLING.md): a room without a plan ticket takes this many phones,
 *   and each phone may use **one** such room (counted per phone key in `phoneLedger.ts`, after the phone proved its key).
 */
export const FREE_ROOM_DEVICES = PLAN_LIMITS.free.maxDevices

/**
 * ★ A phone's first tunnel message may cross relay's challenge in flight (both are sent right after the wire opens),
 *   so relay holds **one** such message until the proof is in, then forwards it. ⚠️ Bounded (hostile input): the real
 *   handshake message is 196 bytes; anything larger, or a second one, cuts the wire.
 */
export const HELD_MAX_BYTES = 256

/**
 * ★★ Limit and deadline for phone wires **the agent has not yet accepted** (2026-09-24 / the slot hole).
 *
 * ⚠️⚠️ The agent's public key is in the QR (assumed known), so **someone who merely knows the key** could
 *    connect `MAX_DEVICES` wires and sit silent, and **real phones could never connect again**.
 * ★ How to tell: the agent **only replies to handshakes from registered devices (or devices being paired)**
 *   (by design it does not return refusal reasons). ⇒ **Once the agent sends even one message to that number, it is "accepted"**.
 *   ⇒ relay can decide alone, and **no agent update is needed** (does not break users of self-hosted relays either).
 * ⇒ Wires not yet accepted are counted separately, given a deadline, and when full **the oldest is evicted** to make room
 *   (with refusal instead, a few silent squatters could hold the slots forever).
 * ⚠️ `MAX_DEVICES` applies **only to accepted wires** (the device limit = the basis of billing / §14.1.1.5).
 * ⚠️ The deadline is longer than the PWA's handshake timeout (10 s) (never evict a real handshake).
 */
export const MAX_PENDING_DEVICES = 4
export const DEVICE_ADMIT_DEADLINE_MS = 15_000

/**
 * ⚠️ Limit on wires waiting for proof.
 *
 * ★ The key is assumed known, so **anyone can get as far as "waiting for proof"**. Cap it so they do not pile up.
 */
export const MAX_PENDING_AGENTS = 4

/**
 * ★★ Deadline for wires waiting for proof (2026-09-15 / codex round 4, high #1).
 *
 * ⚠️⚠️ **Without it, someone who merely knows the key could connect 4 wires and sit silent,
 *    and the real agent could never connect again** (hits the limit, 429). ⇒ Evict on expiry.
 * ⚠️ Kept in the tag as **an absolute time** (it spans hibernation; a remaining duration would rewind).
 */
export const PROOF_DEADLINE_MS = 10_000

/** ⚠️ Limit on tickets checked against the ledger at the same time (the agent sends one at a time = normally 1) */
export const MAX_CLAIMS_IN_FLIGHT = 8

/** Upper bound of the connection number (4 bytes, same as `shared/relayFrame.ts`) */
const MAX_CONN_ID = 0xffffffff

/** Close codes (⚠️ so the UI can show a reason. The private range in the 1000s) */
export const CLOSE = {
  /** That agent is not connected */
  noAgent: 4001,
  /** Device limit */
  tooMany: 4002,
  /** Not keeping the contract (too large, unreadable) */
  badFrame: 4003,
  /** The agent disconnected */
  agentGone: 4004,
  /** ★ Cannot verify the key owner (④a of ③b) */
  badProof: 4005,
  /** ★ The deadline passed without the agent accepting it / evicted to make room (2026-09-24) */
  notAdmitted: 4006,
  /** ★ An old app (no key proof) in a room without a plan ticket (2026-09-27) */
  updateApp: 4007,
  /** ★ This phone already uses another machine on the free tier (2026-09-27) */
  freeUsed: 4008,
  /** ★ The room's plan changed (ticket gone) ⇒ reconnect and claim the free tier (2026-09-27) */
  planChanged: 4009,
  /** ★ The free-tier ledger could not be reached (2026-09-27) */
  unavailable: 4010,
  /** ★ This phone moved its free slot to another machine (pairing / "use this machine for free" / 2026-09-27) */
  freeMoved: 4011,
} as const

/**
 * ★★ Wording of close and refusal reasons (2026-09-24 / multilingual).
 *
 * ⚠️ relay has no per-peer language (phones do not announce one) ⇒ **English / Japanese** side by side.
 * ⚠️⚠️ A WebSocket close reason is **at most 123 bytes of UTF-8** (beyond that `close()` throws)
 *    ⇒ keep them short. `room.test.ts` checks the length of every message.
 * ⚠️ Some places in the UI show the reason **as-is** (`web/src/transport/relayCarrier.ts`), so make them meaningful sentences.
 */
export const REASON = {
  noProof: 'No proof received / 証明が来ませんでした',
  tooManyPending: 'Too many pending proofs / 証明待ちが多すぎます',
  noAgent: 'Agent not connected / agent が繋がっていません',
  // ⚠️ Right at the limit (118 bytes). Do not lengthen the English
  notAdmitted: 'Not accepted by the agent / agent が認めませんでした（登録されていない端末かもしれません）',
  tooMany: 'Device limit for this agent reached / この agent に繋げる台数の上限です',
  // ★ The free tier without sign-in (2026-09-27). ⚠️ Each includes the fix
  updateApp: 'Update the app to connect without sign-in / アプリを更新してください',
  freeUsed: 'Free: one machine per phone. Plus for more / 無料はマシン1台まで。2台目からは Plus',
  planChanged: 'The machine plan changed; reconnect / マシンのプランが変わりました。繋ぎ直してください',
  ledgerDown: 'Could not check the free slot; try again / 無料の枠を確かめられません。やり直してください',
  freeMoved: 'This phone now uses another machine for free / この端末は別のマシンを無料で使うことにしました',
  displaced: 'Closed to make room for a newer connection / 後から来た接続のために閉じました',
  noText: 'Text frames not accepted / 文字は受け取りません',
  tooLarge: 'Too large / 大きすぎます',
  unknownSocket: 'Unknown connection / 素性が分かりません',
  badProof: 'Could not read the proof / 証明を受け取れませんでした',
  lateProof: 'Proof came too late / 証明が遅すぎます',
  notOwner: 'Could not verify the key owner / 鍵の持ち主だと確かめられません',
  keyMismatch: 'Handshake key is not the proven key / 握手の鍵が証明した鍵と違います',
  agentReplaced: 'Agent reconnected on another link / agent が別の線で繋ぎ直しました',
  agentReconnected: 'Agent reconnected / agent が繋ぎ直しました',
  agentClosed: 'Closed by the agent / agent が閉じました',
  agentBadType: 'The agent cannot send this frame type / その種別は agent からは送れません',
  agentGone: 'Agent disconnected / agent が切れました',
  /** ⚠️ Followed by `/ <reason from shared/relayFrame.ts>` */
  malformed: 'Malformed frame',
} as const

/** Tag attached to each socket (⚠️ survives hibernation) */
export interface Tag {
  side: 'agent' | 'device'
  /** ⚠️ Only for `device` */
  connId?: number
  /**
   * ★ `device`: deadline until the agent accepts it (absolute time). ⚠️ A tag without it (a wire connected before this version) counts as accepted.
   */
  until?: number
  /** ★ `device`: the agent sent at least one message to this number (= replied to the handshake) */
  admitted?: boolean
  /** ★ `device`: evicted (⚠️ closing wires are not counted and not used as targets = same practice as `retired`) */
  evicted?: boolean
  /**
   * ★★ `device`: waiting for the phone's key proof (2026-09-27 / `shared/relayAuth.ts`). Deleted once the proof and the
   *   free-tier check are done; until then nothing from this wire reaches the agent and the agent has not been told `opened`.
   *   ⚠️ The ephemeral private key is on the tag to survive hibernation (a per-connection value).
   */
  dpending?: { nonce: Uint8Array; jwk: Jwk; until: number }
  /** ★ `device`: the proof passed and the free-tier check is in flight (⚠️ a second proof is not accepted meanwhile) */
  dproof?: boolean
  /**
   * ★ `device`: while this wire's ledger check was in flight, another wire of the same phone **released** this room from the
   *   phone's ledger (a licensed connect) ⇒ the answer in flight is stale and the check is redone under the current state
   */
  dstale?: boolean
  /** ★ `device`: one message that crossed the challenge in flight, forwarded after the proof (`HELD_MAX_BYTES`) */
  held?: Uint8Array
  /** ★ `device`: the phone's public key (base64url), known only after its proof passed */
  dkey?: string
  /**
   * ★★ `device`: the handshake's first message named `dkey` (security audit 2026-09-28, F1/F2 / `#binds`).
   *   ⚠️ Checked once, on the first message that goes to the agent; later messages are sealed frames.
   */
  dbound?: boolean
  /** ★ `device`: the phone asked to move its free slot here (`f=1` / passed to the ledger with its proof) */
  dtake?: boolean
  /**
   * ★★ `device`: admitted on the free tier (this phone's free slot is this room / `phoneLedger.ts`).
   * ⚠️ In a room without a ticket every admitted phone must carry it (`#enforce` evicts the others so they reconnect and claim).
   */
  free?: boolean
  /**
   * ★★ agent: **whether proof of ownership is done** (④a of ③b / §14.1.2.30).
   *
   * ⚠️⚠️ Not treated as "agent" until done = **old wires are not cut and phones are not accepted**.
   */
  proven?: boolean
  /** ★ agent: a proof is being verified on this wire (⚠️ one per wire / codex 2026-09-27, round 4) */
  proving?: boolean
  /**
   * ★★ agent: tickets are numbered **on arrival** (`ticketSeq`), and the number whose outcome is on the tag now is `ticketApplied`
   *   (2026-09-27 / codex). ⚠️ An older ticket's answer arriving after a newer one's never replaces it (a slow Free renewal used to
   *   overwrite a completed Plus upgrade and close the Plus phones).
   */
  ticketSeq?: number
  ticketApplied?: number
  /**
   * ★★ An old wire that was replaced (2026-09-15 / codex round 4, medium #3).
   *
   * ⚠️⚠️ Without it, **the late-arriving disconnect of the old agent** would also cut the phones
   *    hanging off the new agent (the tag is still `proven`, so they cannot be told apart).
   */
  retired?: boolean
  /**
   * ★★ **The last connection number the agent handed out** (2026-09-15 / codex round 4, medium #2).
   *
   * ⚠️⚠️ Counting `max + 1` from live tags **reuses numbers**. Then, when
   *    "right after the agent sends, that device disconnects and another device joins with the same number",
   *    **a frame in flight reaches an unrelated device** (it cannot open it, so that device breaks).
   *    ⇒ Kept in the agent's tag and **increased monotonically** (does not go back across hibernation).
   */
  lastConnId?: number
  /**
   * ★★ agent: announced it understands `drop` / `ready` (`c=1` in the URL / 2026-09-24 / codex round 18, high #1).
   * ⚠️⚠️ Agents that did not announce it get no `ready`, and their `drop` is not accepted (an **old agent** cuts the whole wire on unknown types).
   */
  control?: boolean
  /** ★★ agent: announced it understands tickets (`l=1` in the URL / 2026-09-24). ⚠️ `licenseResult` is sent only on wires that announced it */
  licensing?: boolean
  /** ★ agent: the room key (kept after proof too = this key is registered in the account ledger) */
  key?: string
  /**
   * ★★ agent: only the needed parts of the verified ticket (2026-09-24 / docs/BILLING.md). `exp` is in ms.
   * ⚠️ Once expired, same as absent (`#deviceLimit`).
   */
  lic?: { acct: string; mid: string; plan: string; maxDevices: number; exp: number }
  /**
   * ★★ agent: tickets currently being checked against the ledger (`<acct> <mid>` / 2026-09-24 / codex rounds 26-28), and
   *   those removed in the meantime (`claimRevoked`). ⚠️ A returning "may pass" is not used if it was removed in the meantime.
   *   ⚠️⚠️ Remember **only those being checked** (remembering recent revocations by count let other people's revocations push them out,
   *      and a late "may pass" was adopted / round 28, medium #5). Cleared when the check ends.
   */
  claiming?: string[]
  claimRevoked?: string[]
  /**
   * ★★ Sequence number of checks (⚠️ tells each one apart / codex round 29, high #1: with two checks of the same ticket, the one finishing first
   *   cleared both marks by `<acct> <mid>`, and the later "may pass" missed the revocation). The mark is `<number>|<acct> <mid>`.
   */
  claimSeq?: number
  /**
   * ⚠️ Held only while waiting for proof (discarded once done).
   *
   * ⚠️⚠️ **The ephemeral private key is on the tag to survive hibernation**
   *    (the proof can continue even if it sleeps midway). ⚠️ A per-connection value, deleted once done.
   */
  pending?: { key: string; nonce: Uint8Array; jwk: Jwk; until: number }
  /**
   * ★★ agent: accepted, its challenge still being made (security audit 2026-09-28, F3). Counts toward `MAX_PENDING_AGENTS`
   *   **from the moment the wire is accepted**: without it, wires opened together were all admitted while `newChallenge()` was
   *   awaited (the count only saw tagged wires). Replaced by `pending` once the challenge is sent; swept at `until` like it.
   */
  reserving?: { until: number }
}

/** One wire (⚠️ `worker.ts` wraps the Durable Object's WebSocket) */
export interface RoomSocket {
  send(bytes: Uint8Array): void
  close(code: number, reason: string): void
  /** ⚠️ Tag that survives hibernation */
  tag(): Tag | null
  setTag(tag: Tag): void
}

export interface RoomIo {
  /** Wires currently connected (⚠️ **no state in memory** = count from here) */
  sockets(side: 'agent' | 'device'): RoomSocket[]
  /** ★ Ephemeral key and nonce (⚠️ tests can fix them) */
  newChallenge(): Promise<{ publicRaw: Uint8Array; jwk: Jwk; nonce: Uint8Array }>
  /** ⚠️ Read back the ephemeral private key stored on the tag (may throw on failure) */
  importPrivate(jwk: Jwk): Promise<Key>
  /** base64url public key to bytes (⚠️ may throw if unreadable) */
  publicRaw(key: string): Uint8Array
  now(): number
  /** ★ Verify a ticket (signature, shape, expiry / `shared/license.ts`). ⚠️ Never throws */
  verifyLicense(token: string): Promise<LicenseCheck>
  /**
   * ★ Register this machine in the account ledger (false if slots are full or the passphrase was removed / `ledger.ts`). ⚠️ Never throws
   * @param mid number of the passphrase that issued the ticket
   */
  claimMachine(acct: string, key: string, maxMachines: number, mid: string): Promise<ClaimResult>
  /**
   * ★★ May this phone use this room? (`phoneLedger.ts` / 2026-09-27). ⚠️ Never throws
   * @param dkey the phone's public key (⚠️ only after its proof passed)
   * @param licensed the room has a **Plus** ticket right now (`#paid` ⇒ the ledger releases the room instead of counting it)
   * @param takeover the phone asked to move its free slot here (⇒ the ledger drops its other rooms and tells them first)
   * @returns `unavailable` when the ledger cannot be reached (⚠️ refuses a free-tier phone = fail-closed; a licensed room carries on)
   */
  claimPhone(dkey: string, agentKey: string, licensed: boolean, takeover: boolean, connId: number): Promise<PhoneClaimResult>
  /**
   * ★★ **Someone else's relay** (`SELF_HOSTED=1` in `wrangler.selfhost.jsonc` / 2026-09-25): no plans at all.
   *   Tickets are never asked for (so no agent, old or new, sends one) and every room takes `MAX_DEVICES` phones.
   *   ⚠️ Without it, a signed-in agent's ticket put our Free plan's 2-phone limit on the user's own relay (codex).
   */
  selfHosted(): boolean
}

/** ★ Reply from the ledger (⚠️ falls to `machine-limit` if unreachable) */
export type ClaimResult = 'ok' | 'machine-limit' | 'revoked'
/** ★ Reply from the phone ledger (`phoneLedger.ts`) */
export type PhoneClaimResult = 'ok' | 'machine-limit' | 'unavailable'

/** Whether to accept (⚠️ a refusal reason becomes **the HTTP status code as-is**) */
export type Admit = { ok: true } | { ok: false; status: number; text: string }

/**
 * One rendezvous room (= one agent public key).
 *
 * ⚠️⚠️ **No state in memory** (lost on hibernation). State lives **only on socket tags**.
 */
export class Room {
  #io: RoomIo

  constructor(io: RoomIo) {
    this.#io = io
  }

  /** ⚠️⚠️ **Only wires whose proof is done** (unproven or retired wires are not "the agent") */
  #agent(): RoomSocket | undefined {
    return this.#io
      .sockets('agent')
      .find((s) => isLiveAgent(s.tag()))
  }

  #devices(): { socket: RoomSocket; connId: number; tag: Tag }[] {
    return this.#io.sockets('device').flatMap((socket) => {
      const tag = socket.tag()
      return tag?.connId && tag.evicted !== true ? [{ socket, connId: tag.connId, tag }] : []
    })
  }

  /** ★ Number of accepted wires (⚠️ wires with no deadline tag = connected before this version are counted too) */
  #admittedCount(): number {
    return this.#devices().filter((d) => d.tag.until === undefined || d.tag.admitted === true).length
  }

  /** ★ Evict a phone wire that has not been accepted yet (⚠️ set the mark first = closing wires are not counted) */
  #evict(d: { socket: RoomSocket; tag: Tag }, reason: string, code: number = CLOSE.notAdmitted): void {
    d.socket.setTag({ ...d.tag, evicted: true })
    d.socket.close(code, reason)
  }

  /**
   * ★★ Close a wire for breaking the contract — **marking it first** (codex 2026-09-27, round 5).
   *
   * ⚠️⚠️ `close()` alone is not "closed": the `close` event arrives later, and a proof check awaiting crypto or the ledger
   *    re-reads the tag in between. Unmarked, that continuation went on to announce a closing phone (`opened`) or to let a
   *    closing agent wire replace the live agent. ⇒ Every relay-initiated close of a tagged wire goes through here:
   *    a phone gets `evicted`, an agent wire gets `retired` (and, if it was the live agent, its phones are cut now, as `onClose` would).
   */
  #drop(socket: RoomSocket, reason: string, code: number): void {
    const tag = socket.tag()
    if (tag?.side === 'device') {
      if (tag.evicted !== true) socket.setTag({ ...tag, evicted: true })
    } else if (tag?.side === 'agent') {
      const live = isLiveAgent(tag)
      if (tag.retired !== true) socket.setTag({ ...tag, retired: true })
      if (live) for (const d of this.#devices()) this.#evict(d, REASON.agentGone, CLOSE.agentGone)
    }
    socket.close(code, reason)
  }

  /** ⚠️ Wires whose proof is not done yet (= anyone can make them. Do not let them pile up; give them a deadline) */
  #pending(): RoomSocket[] {
    return this.#io.sockets('agent').filter((s) => {
      const tag = s.tag()
      return tag?.side === 'agent' && tag.proven !== true && tag.retired !== true
    })
  }

  /**
   * ★★ Evict expired "waiting for proof" wires (codex round 4, high #1).
   *
   * @returns number evicted
   */
  #sweepPending(): number {
    const now = this.#io.now()
    let swept = 0
    for (const s of this.#pending()) {
      const tag = s.tag()
      const until = tag?.pending?.until ?? tag?.reserving?.until
      // ⚠️ Tags without a deadline (= old versions, broken tags) are evicted too (fail-closed)
      if (until === undefined || until <= now) {
        this.#drop(s, REASON.noProof, CLOSE.badProof)
        swept += 1
      }
    }
    return swept
  }

  /**
   * ★★ The room is **outside the phones' free tier** right now: it has a valid **Plus** ticket (2026-09-27 / user report).
   *   ⚠️⚠️ Not "any ticket": a signed-in **Free** machine must count against the phone's free slot too, or one GitHub sign-in gave a
   *      second free machine (A signed in on Free = the account's one machine, B not signed in = the phone's free slot).
   *   ⇒ A Free ticket still sets the room's phone limit (`#deviceLimit`) and the account's machine count (`ledger.ts`), and the
   *     phone's one free machine is counted as if the room had no ticket.
   */
  #paid(): boolean {
    const lic = this.#agent()?.tag()?.lic
    return lic !== undefined && lic.exp > this.#io.now() && lic.plan === 'plus'
  }

  /**
   * ★★ Number of phones this room accepts (2026-09-24 / billing).
   *   With a valid ticket, its value (Free 2, Plus 5). Without one, the free tier (`FREE_ROOM_DEVICES` / 2026-09-27).
   * ⚠️ Never above `MAX_DEVICES` (even if a ticket carries a broken value, relay owns the room limit).
   */
  #deviceLimit(): number {
    if (this.#io.selfHosted()) return MAX_DEVICES
    const lic = this.#agent()?.tag()?.lic
    if (lic && lic.exp > this.#io.now()) return Math.min(lic.maxDevices, MAX_DEVICES)
    return Math.min(FREE_ROOM_DEVICES, MAX_DEVICES)
  }

  /**
   * ★★ Enforce the limit **now** (2026-09-24 / codex round 26, high #2).
   *   ⚠️⚠️ Checking only on accept meant that after a ticket expired or a return to Free,
   *      **connected wires kept being carried** (reproduced). ⇒ Go through this every time before carrying anything.
   *   ★ Remove an expired ticket from the tag and tell the agent. Wires over the limit are closed **latest first**.
   * ★★ A room without a ticket is the free tier (2026-09-27): every admitted phone must hold this room as its free slot
   *   (`free`). Phones admitted under a ticket that is now gone are closed so they reconnect and claim (or get refused there).
   *   ⚠️ Not on a self-hosted relay (no plans there).
   */
  #enforce(): void {
    const agent = this.#agent()
    const tag = agent?.tag()
    if (agent && tag?.lic && tag.lic.exp <= this.#io.now()) {
      const { lic: _gone, ...rest } = tag
      agent.setTag(rest)
      if (tag.licensing) this.#licenseResult(agent, 'expired')
    }
    const limit = this.#deviceLimit()
    let admitted = this.#devices()
      .filter((d) => d.tag.until === undefined || d.tag.admitted === true)
      .sort((a, b) => a.connId - b.connId)
    if (!this.#io.selfHosted() && !this.#paid()) {
      for (const d of admitted.filter((d) => d.tag.free !== true)) this.#evict(d, REASON.planChanged, CLOSE.planChanged)
      admitted = admitted.filter((d) => d.tag.free === true)
    }
    for (const d of admitted.slice(limit)) this.#evict(d, REASON.tooMany, CLOSE.tooMany)
  }

  /**
   * ★★ A passphrase was removed from the account (called from the relay's Accounts DO / 2026-09-24 / codex rounds 26-27).
   *   ⚠️ Deleting it only from the ledger left the ticket on the room working until expiry (up to 24 hours) ⇒ remove it here and enforce the limit.
   *   ⚠️⚠️ **Only tickets of the same account and the same passphrase are removed** (codex round 27, high #1: a stranger who only knew the public key
   *      could claim that key under their own account, log out, and remove the victim room's ticket).
   */
  revokeLicense(acct: string, mid: string): void {
    const agent = this.#agent()
    const tag = agent?.tag()
    if (agent && tag) {
      const mark = `${acct} ${mid}`
      const hit = tag.lic?.acct === acct && tag.lic.mid === mid
      // ★ However many checks of the same ticket are in flight, mark all of them "removed"
      const inFlight = (tag.claiming ?? []).filter((c) => c.slice(c.indexOf('|') + 1) === mark)
      const { lic, ...rest } = tag
      agent.setTag({
        ...rest,
        ...(lic && !hit ? { lic } : {}),
        ...(inFlight.length ? { claimRevoked: [...new Set([...(tag.claimRevoked ?? []), ...inFlight])] } : {}),
      })
      if (hit && tag.licensing) this.#licenseResult(agent, 'revoked')
    }
    this.#enforce()
  }

  /** An agent is trying to connect (⚠️ **not yet "the agent"**) */
  admitAgent(): Admit {
    // ⚠️⚠️ Collect expired ones first (without this, 4 wires could squat silently)
    this.#sweepPending()
    if (this.#pending().length >= MAX_PENDING_AGENTS) {
      return { ok: false, status: 429, text: REASON.tooManyPending }
    }
    return { ok: true }
  }

  /** Put a tag on the accepted agent wire and **send the challenge first** */
  async startAgent(socket: RoomSocket, key: string, control = false, licensing = false): Promise<void> {
    // ⚠️⚠️ Tagged **before** the await (F3): an untagged wire is not counted by `admitAgent`, so the limit did not hold
    socket.setTag({ side: 'agent', reserving: { until: this.#io.now() + PROOF_DEADLINE_MS } })
    const c = await this.#io.newChallenge()
    // ⚠️ The wire may be gone meanwhile (swept, or closed = retired). Then no challenge
    const now = socket.tag()
    if (!now || now.retired === true || now.reserving === undefined) return
    socket.setTag({
      side: 'agent',
      ...(control ? { control: true } : {}),
      // ⚠️ Tickets ride on top of `drop` / `ready` (`l=1` only together with `c=1`)
      // ⚠️ A self-hosted relay does not take the ticket declaration (⇒ never sends `want` ⇒ never receives a ticket)
      ...(control && licensing && !this.#io.selfHosted() ? { licensing: true } : {}),
      pending: {
        key,
        nonce: c.nonce,
        jwk: c.jwk,
        // ★ Absolute time (⚠️ a remaining duration would rewind across hibernation)
        until: this.#io.now() + PROOF_DEADLINE_MS,
      },
    })
    socket.send(encodeChallenge({ relayPublicRaw: c.publicRaw, nonce: c.nonce }))
  }

  /** A phone is trying to connect */
  admitDevice(): Admit {
    // ★ Phone side. ⚠️ If there is no agent, **return the reason right away** (the UI does not wait)
    if (!this.#agent()) return { ok: false, status: 503, text: REASON.noAgent }
    const now = this.#io.now()
    const pending: { socket: RoomSocket; tag: Tag; until: number }[] = []
    let admitted = 0
    for (const d of this.#devices()) {
      const until = d.tag.until
      if (until === undefined || d.tag.admitted === true) {
        admitted += 1
      } else if (until <= now) {
        // ⚠️⚠️ Collect expired ones first (without this, they could squat silently)
        this.#evict(d, REASON.notAdmitted)
      } else {
        pending.push({ ...d, until })
      }
    }
    const limit = this.#deviceLimit()
    if (admitted >= limit) {
      return { ok: false, status: 429, text: REASON.tooMany }
    }
    if (pending.length >= MAX_PENDING_DEVICES) {
      // ★ Evict the oldest to make room (⚠️ refusing would let a few squatters hold the slots forever)
      pending.sort((a, b) => a.until - b.until)
      this.#evict(pending[0]!, REASON.displaced)
    }
    return { ok: true }
  }

  /**
   * Assign a number to the accepted phone and tell the agent.
   *
   * ⚠️⚠️ Numbers are **increased monotonically on the agent's tag** (reuse would deliver an in-flight frame
   *    to an unrelated device / codex round 4, medium #2).
   * ★★ A phone that announced the key proof (`p=1`) is **challenged first** (2026-09-27): the agent is told `opened` only
   *   after the proof and the free-tier check pass (`#checkDeviceProof`). ⚠️ Not on a self-hosted relay (no plans, no ledger).
   * ⚠️ An old app (no `p=1`) is closed **with a reason** right after accepting (a refusal before the upgrade would be invisible
   *    to the browser = it would show as "offline" instead of "update the app").
   *    ⚠️⚠️ **In every room, Plus included** (codex 2026-09-28 on the audit fix): without a proven key `#binds` has nothing to
   *    compare with, so a Plus room let an unproven wire name a registered phone's public key and hold the slots (F1 again).
   * @param proving the phone announced `p=1`
   * @param takeover the phone announced `f=1` (move its free slot here / only meaningful with `proving`)
   */
  async startDevice(socket: RoomSocket, proving = false, takeover = false): Promise<number> {
    const agent = this.#agent()
    const tag = agent?.tag()
    const last = tag?.lastConnId ?? 0
    // ⚠️ Wrap back to 1 on 4-byte overflow (by the time it gets that far, nobody from then remains)
    const connId = last >= MAX_CONN_ID ? 1 : last + 1
    if (agent && tag) agent.setTag({ ...tag, lastConnId: connId })
    // ★ Deadline until the agent accepts it (see `MAX_PENDING_DEVICES`). ⚠️ Tagged **before** any await (an untagged wire is nobody)
    const until = this.#io.now() + DEVICE_ADMIT_DEADLINE_MS
    const base: Tag = { side: 'device', connId, until }
    socket.setTag(base)
    if (this.#io.selfHosted()) {
      this.#toAgent({ type: RELAY_FRAME.opened, connId })
      return connId
    }
    if (!proving) {
      this.#evict({ socket, tag: base }, REASON.updateApp, CLOSE.updateApp)
      return connId
    }
    const c = await this.#io.newChallenge()
    // ⚠️ The wire may already be gone (evicted to make room while the key was made)
    const now = socket.tag()
    if (!now || now.evicted === true) return connId
    socket.setTag({ ...now, dpending: { nonce: c.nonce, jwk: c.jwk, until }, ...(takeover ? { dtake: true } : {}) })
    socket.send(encodeDeviceChallenge({ relayPublicRaw: c.publicRaw, nonce: c.nonce }))
    return connId
  }

  /**
   * ★★ This phone moved its free slot to another machine (called by the Phones DO **before** it writes the ledger / 2026-09-27).
   *   Wires of that phone holding this room as their free slot are closed with the reason (the app shows it and offers to move it
   *   back); a check in flight is marked stale (it asks again and gets refused). ⚠️ Wires admitted under a ticket are not touched.
   */
  /**
   * ★★ The Phones DO is about to drop this room from phone `dkey`'s ledger because a wire of it connected here under Plus
   *   (called **before** the ledger is written / 2026-09-27 / codex): the phone's other wires here stop holding this room as their
   *   free slot now, not when the releasing wire's answer comes back (in that window the phone could claim another room on the
   *   free tier while these kept carrying). ⚠️ Marks only; `#enforce` closes them if this room is not Plus by the next message.
   */
  phoneFreeReleased(dkey: string, releasingConnId: number): void {
    for (const d of this.#devices()) {
      if (d.tag.dkey !== dkey || d.connId === releasingConnId) continue
      // ★ A check still waiting for its answer is marked stale too (its "may pass" predates the release / codex): it asks again
      if (d.tag.dpending !== undefined) d.socket.setTag({ ...d.tag, dstale: true })
      else if (d.tag.free === true) {
        const { free: _gone, ...kept } = d.tag
        d.socket.setTag(kept)
      }
    }
  }

  phoneFreeMoved(dkey: string): void {
    // ⚠️ A room that got a ticket after the wire was admitted keeps that wire (it is licensed now); only the stale mark goes
    const licensed = this.#paid()
    for (const d of this.#devices()) {
      if (d.tag.dkey !== dkey) continue
      if (d.tag.dpending !== undefined) d.socket.setTag({ ...d.tag, dstale: true })
      else if (d.tag.free === true) {
        if (licensed) {
          const { free: _gone, ...kept } = d.tag
          d.socket.setTag(kept)
        } else this.#evict(d, REASON.freeMoved, CLOSE.freeMoved)
      }
    }
  }

  /** Handle one byte array from a wire (⚠️ **never throws**) */
  async onMessage(socket: RoomSocket, message: string | ArrayBuffer): Promise<void> {
    // ⚠️ No text (only ciphertext is carried = no second kind).
    //   ★ The only exception is `RELAY_PING`, and it **never gets here** (the auto-response answers first).
    //   ⚠️⚠️ So if the signal text differs by a single character it is **cut on the spot** = a mismatch shows up in measurement.
    if (typeof message === 'string') {
      this.#drop(socket, REASON.noText, CLOSE.badFrame)
      return
    }
    if (message.byteLength > MAX_RELAY_BYTES) {
      // ⚠️⚠️ The ToS measure itself (§14.1.1.4). **Large things are not carried**
      this.#drop(socket, REASON.tooLarge, CLOSE.badFrame)
      return
    }
    const tag = socket.tag()
    // ★★ **Until proof is done, only that is accepted** (④a of ③b)
    if (tag?.side === 'agent' && tag.proven !== true) {
      return await this.#checkProof(socket, tag, new Uint8Array(message))
    }
    // ★★ A phone that has not proved its key yet: only the proof (or one held message) is accepted (2026-09-27)
    if (tag?.side === 'device' && tag.dpending && tag.evicted !== true) {
      return await this.#checkDeviceProof(socket, tag, new Uint8Array(message))
    }
    // ★★ Enforce the limit before carrying (⚠️ nothing from a closed wire is carried / codex round 26, high #2)
    this.#enforce()
    if (socket.tag()?.evicted === true) return
    if (tag?.side === 'agent') return await this.#fromAgent(socket, new Uint8Array(message))
    if (tag?.side === 'device' && tag.connId) {
      if (!this.#binds(socket, new Uint8Array(message))) return
      return this.#fromDevice(tag.connId, message)
    }
    this.#drop(socket, REASON.unknownSocket, CLOSE.badFrame)
  }

  /**
   * ★★ A phone that proved a key must hand the agent **that same key** in its handshake (security audit 2026-09-28, F1/F2).
   *
   * ⚠️⚠️ Without this, the relay's key (the free-tier count) and the agent's key (registration) were unrelated:
   *    F1: prove any key, then name a victim phone's **public** key in the handshake ⇒ the agent replies (it cannot tell yet),
   *        the wire is admitted and holds the victim room's slots while it stays open.
   *    F2: keep one paired key for the agent and prove a fresh key per room ⇒ one app, many free machines.
   * ★ Only the first message that reaches the agent is the handshake (the agent takes one per connection number), so it is
   *   checked once and remembered (`dbound`). Usually that is the held message (`#checkDeviceProof`); this covers the case where
   *   the handshake comes after the proof.
   * ⚠️ Not checked on a self-hosted relay only (no proofs there). ⚠️⚠️ On our relay a wire **without a proven key carries
   *    nothing** (codex 2026-09-28 round 2: while `startDevice` awaited the challenge the tag had neither `dpending` nor `dkey`,
   *    so a message in that window went straight to the agent). ⚠️ A wire the agent already admitted is **not** exempt either
   *    (a deploy closes the wires anyway; an exemption would be one more way past this check).
   * @returns false = the wire was closed
   */
  #binds(socket: RoomSocket, bytes: Uint8Array): boolean {
    if (this.#io.selfHosted()) return true
    const tag = socket.tag()
    if (!tag?.dkey) {
      if (tag) this.#evict({ socket, tag }, REASON.badProof, CLOSE.badProof)
      else this.#drop(socket, REASON.unknownSocket, CLOSE.badFrame)
      return false
    }
    if (tag.dbound === true) return true
    if (!namesKey(bytes, tag.dkey)) {
      this.#evict({ socket, tag }, REASON.keyMismatch, CLOSE.badProof)
      return false
    }
    socket.setTag({ ...tag, dbound: true })
    return true
  }

  /**
   * ★★ Check the phone is the owner of the key it names, then whether it may use this room (2026-09-27 / docs/BILLING.md §2.2).
   *
   * ⚠️⚠️ The free tier is counted **per phone key**, so the key must be proven: otherwise anyone who saw a phone's public key
   *    (its own agent does) could name it from another room and fill that phone's free slot. Same proof as the agent's
   *    (`relayProof` in `shared/crypto.ts`, one place), with relay's own ephemeral key and nonce per wire.
   * ★ Order: proof → ledger (async) → tell the agent `opened` → forward the one held message. The agent never learns of
   *   a phone that did not get this far (a refused phone costs it nothing).
   * ⚠️ While the ledger answers, the wire may be evicted (deadline, agent gone) ⇒ re-read the tag after the await and stop.
   */
  async #checkDeviceProof(socket: RoomSocket, tag: Tag, bytes: Uint8Array): Promise<void> {
    const d = tag.dpending as NonNullable<Tag['dpending']>
    const decoded = decodeDeviceProof(bytes)
    if (!decoded.ok) {
      // ★ Not a proof (the handshake's first message crossed the challenge in flight) ⇒ hold exactly one small message
      if (tag.held === undefined && bytes.length <= HELD_MAX_BYTES && bytes.length > 0) {
        socket.setTag({ ...tag, held: bytes })
        return
      }
      this.#evict({ socket, tag }, REASON.badProof, CLOSE.badProof)
      return
    }
    // ⚠️⚠️ One proof per wire, latched **before the first await** (codex round 3): two valid copies arriving back to back used to
    //    run two checks at once, and their interleaved ledger answers could leave `free` on the wire with nothing in the ledger.
    //    A second proof is never held either (it is not a handshake message)
    if (tag.dproof === true) {
      this.#evict({ socket, tag }, REASON.badProof, CLOSE.badProof)
      return
    }
    // ⚠️ Proofs past the deadline do not pass (accepting late ones would make the deadline meaningless)
    if (d.until <= this.#io.now()) {
      this.#evict({ socket, tag }, REASON.lateProof, CLOSE.badProof)
      return
    }
    socket.setTag({ ...tag, dproof: true })
    let ok = false
    try {
      const priv = await this.#io.importPrivate(d.jwk)
      // ⚠️ Compare with `sameBytes` (no timing leak)
      ok = sameBytes(await relayProof(priv, decoded.value.devicePublicRaw, new Uint8Array(d.nonce)), decoded.value.tag)
    } catch {
      // ⚠️ Broken key, broken tag. **Do not pass**
      ok = false
    }
    const afterProof = socket.tag()
    if (!afterProof || afterProof.evicted === true) return
    if (!ok) {
      this.#evict({ socket, tag: afterProof }, REASON.notOwner, CLOSE.badProof)
      return
    }
    const agentKey = this.#agent()?.tag()?.key
    if (!agentKey) {
      this.#evict({ socket, tag: afterProof }, REASON.noAgent, CLOSE.noAgent)
      return
    }
    const dkey = toBase64Url(decoded.value.devicePublicRaw)
    // ★ The key is on the tag **before** the ledger is asked (so a release by another wire of this phone can mark this one stale).
    //   ⚠️ The takeover flag is read **once** here and dropped from the tag: a stale retry must be a plain claim (codex 2026-09-27:
    //      a delayed takeover answer, retried with the flag, took the slot back from a newer takeover)
    const { dtake: _once, ...withKey } = afterProof
    const take = afterProof.dtake === true
    socket.setTag({ ...withKey, dkey })
    // ★★ Ask the ledger under the room's plan **as of the request**. The answer can go stale while it travels (codex 2026-09-27):
    //   the ticket arrives or goes, or another wire of this phone releases this room. ⇒ If the world changed, ask **once more**
    //   under the current state (a stale answer must neither grant a slot the ledger no longer holds nor refuse a room that is
    //   licensed now). If it changed again, close the wire so the phone reconnects (fail-closed).
    let licensed = this.#paid()
    let claimed: PhoneClaimResult = 'unavailable'
    for (let attempt = 0; ; attempt++) {
      const agentKey = this.#agent()?.tag()?.key
      const before = socket.tag()
      if (!before || before.evicted === true || before.dpending === undefined) return
      if (!agentKey) {
        this.#evict({ socket, tag: before }, REASON.noAgent, CLOSE.noAgent)
        return
      }
      claimed = await this.#io.claimPhone(dkey, agentKey, licensed, take && attempt === 0, now0ConnId(before))
      // ★★ A licensed request is a release. It may have reached the ledger **even when the answer was lost** (`unavailable`), so
      //   **whatever became of this wire or its answer**, no other wire of this phone in this room holds the room as its free slot
      //   any more (its `free` was a cache of the ledger; a check in flight is redone / codex rounds 2-3)
      if (licensed) this.#releasedHere(dkey, socket)
      const now = socket.tag()
      if (!now || now.evicted === true || now.dpending === undefined) return
      // ⚠️ `dstale` only matters to a free claim: a Plus answer does not depend on the free slot, so a room still Plus accepts it
      //    (three wires of one phone connecting at once used to mark each other stale until two closed with 4009 / codex)
      const changed = this.#paid() !== licensed || (now.dstale === true && !licensed)
      if (!changed) break
      if (attempt >= 1) {
        this.#evict({ socket, tag: now }, REASON.planChanged, CLOSE.planChanged)
        return
      }
      const { dstale: _seen, ...fresh } = now
      socket.setTag(fresh)
      licensed = this.#paid()
    }
    const after = socket.tag()
    if (!after || after.evicted === true || after.dpending === undefined) return
    if (claimed === 'machine-limit') {
      this.#evict({ socket, tag: after }, REASON.freeUsed, CLOSE.freeUsed)
      return
    }
    // ⚠️ The ledger could not be reached: a free-tier phone is refused (fail-closed); a licensed room only lost a release
    if (claimed === 'unavailable' && !licensed) {
      this.#evict({ socket, tag: after }, REASON.ledgerDown, CLOSE.unavailable)
      return
    }
    // ⚠️ The agent may have gone while waiting (its close evicts the phones, caught above); if it was replaced, the new one is told
    if (!this.#agent()) {
      this.#evict({ socket, tag: after }, REASON.noAgent, CLOSE.noAgent)
      return
    }
    const { dpending: _p, dproof: _q, dstale: _s, held, ...rest } = after
    // ★★ The held message is the handshake's first message: it must name the proven key (before the agent hears of this phone)
    if (held !== undefined && !namesKey(new Uint8Array(held), dkey)) {
      this.#evict({ socket, tag: after }, REASON.keyMismatch, CLOSE.badProof)
      return
    }
    socket.setTag({ ...rest, dkey, ...(licensed ? {} : { free: true }), ...(held !== undefined ? { dbound: true } : {}) })
    this.#toAgent({ type: RELAY_FRAME.opened, connId: rest.connId as number })
    if (held !== undefined) this.#toAgent({ type: RELAY_FRAME.data, connId: rest.connId as number, payload: new Uint8Array(held) })
  }

  /**
   * ★ This room was released from phone `dkey`'s ledger (a licensed connect / 2026-09-27 / codex rounds 1-2): every other wire of
   *   that phone here drops its `free` mark, and a wire whose ledger check is in flight is marked stale (it asks again).
   * ⚠️ Applied by the wire that made the release **even if it was evicted meanwhile** (the ledger changed regardless).
   */
  #releasedHere(dkey: string, except: RoomSocket): void {
    for (const d of this.#devices()) {
      if (d.socket === except || d.tag.dkey !== dkey) continue
      if (d.tag.dpending !== undefined) {
        d.socket.setTag({ ...d.tag, dstale: true })
      } else if (d.tag.free === true) {
        const { free: _stale, ...kept } = d.tag
        d.socket.setTag(kept)
      }
    }
  }

  /**
   * ★★ Check it is the key owner (④a of ③b / §14.1.2.30).
   *
   * ⚠️⚠️ It becomes "the agent" **only when it passes** = cutting old wires and accepting phones
   *    are possible only from here on. ⚠️ The contents (the proof itself) are in `relayProof` in `shared/crypto.ts`, one place only.
   */
  async #checkProof(socket: RoomSocket, tag: Tag, bytes: Uint8Array): Promise<void> {
    const decoded = decodeProof(bytes)
    const pending = tag.pending
    if (!decoded.ok || !pending) {
      this.#drop(socket, REASON.badProof, CLOSE.badProof)
      return
    }
    // ⚠️ Proofs past the deadline do not pass (accepting late ones would make the deadline meaningless)
    if (pending.until <= this.#io.now()) {
      this.#drop(socket, REASON.lateProof, CLOSE.badProof)
      return
    }
    // ⚠️ One proof per wire, latched **before the first await** (codex 2026-09-27, round 4): a second copy arriving while the
    //    first is being verified used to run a second check, which then "replaced" the wire that had just become the agent
    if (tag.proving === true) {
      this.#drop(socket, REASON.badProof, CLOSE.badProof)
      return
    }
    socket.setTag({ ...tag, proving: true })
    let ok = false
    try {
      const priv = await this.#io.importPrivate(pending.jwk)
      // ⚠️ Compare with `sameBytes` (no timing leak)
      ok = sameBytes(
        await relayProof(priv, this.#io.publicRaw(pending.key), new Uint8Array(pending.nonce)),
        decoded.value,
      )
    } catch {
      // ⚠️ Broken key, broken tag. **Do not pass**
      ok = false
    }
    if (!ok) {
      this.#drop(socket, REASON.notOwner, CLOSE.badProof)
      return
    }
    // ⚠️⚠️ The wire may have closed while the proof was verified (codex round 4): `onClose` retires it, and a retired wire must not
    //    replace the live agent (it would cut the live agent and its phones for a wire that is already gone = 503 until it returns)
    const verified = socket.tag()
    if (!verified || verified.retired === true || verified.pending === undefined) return
    // ★ Only here does it become "the agent". ⚠️ The previous wire is dropped (a disconnected agent **can come back**)
    const previous = this.#agent()
    const previousTag = previous?.tag()
    if (previous && previousTag) {
      // ⚠️⚠️ **Put the retired tag on first** (otherwise the old wire's late disconnect
      //    also cuts the new agent's phones / codex round 4, medium #3)
      previous.setTag({ ...previousTag, retired: true })
      previous.close(CLOSE.agentGone, REASON.agentReplaced)
      // ★★ **Cut the phones that hung off the old agent** (2026-09-15).
      //   ⚠️⚠️ The tunnel (session keys) lives inside the agent, so once the wire is swapped
      //      **nobody can answer for that number**. Without cutting, the phone stays connected while
      //      **nobody answers** (requests just time out and it never reconnects) = the nastiest outcome.
      for (const d of this.#devices()) this.#evict(d, REASON.agentReconnected, CLOSE.agentGone)
    }
    // ★ Numbers are **carried over** (⚠️ going back to 1 would collide with frames in flight).
    //   ⚠️⚠️ Not only from the live predecessor (codex 2026-09-27, round 6): an agent wire retired by `#drop` or gone through
    //      `onClose` is no longer "live", yet its phones may still be closing — their delayed `closed(n)` would reach the new agent
    //      and discard the tunnel of a **new** phone that got the same `n`. ⇒ Start above every number still present in the room:
    //      the counters of all agent wires (retired ones included) and the numbers of all phone wires (closing ones included)
    const carried = Math.max(
      previousTag?.lastConnId ?? 0,
      ...this.#io.sockets('agent').map((s) => s.tag()?.lastConnId ?? 0),
      ...this.#io.sockets('device').map((s) => s.tag()?.connId ?? 0),
    )
    socket.setTag({
      side: 'agent',
      proven: true,
      key: pending.key,
      ...(tag.control ? { control: true } : {}),
      ...(tag.licensing ? { licensing: true } : {}),
      ...(carried > 0 ? { lastConnId: carried } : {}),
    })
    // ★★ Tell only agents that announced it that "drop is accepted" (⚠️ **after** the proof passed = only the key owner)
    if (tag.control) {
      try {
        socket.send(encodeRelayFrame({ type: RELAY_FRAME.ready, connId: 0 }))
      } catch {
        // ⚠️ A wire that cannot be sent to is cleaned up at the next close
      }
    }
    // ★★ Tell only agents that announced ticket support that "tickets are accepted" (2026-09-24)
    if (tag.control && tag.licensing) this.#licenseResult(socket, 'want')
  }

  #licenseResult(socket: RoomSocket, status: LicenseStatus): void {
    try {
      socket.send(encodeRelayFrame({ type: RELAY_FRAME.licenseResult, connId: 0, payload: new TextEncoder().encode(status) }))
    } catch {
      // ⚠️ A wire that cannot be sent to is cleaned up at the next close
    }
  }

  /**
   * ★★ A ticket was received (2026-09-24 / docs/BILLING.md §2.2).
   *   Verify signature, shape and expiry; if this machine can be registered in the account ledger, set the room limit to the ticket's value.
   * ⚠️ If it fails, **remove it from the tag** (do not keep running on the previous ticket). ⚠️ The reason goes back to the agent (`nyan account` and the UI show it).
   */
  async #onLicense(socket: RoomSocket, payload: Uint8Array): Promise<void> {
    // ★★ Number this ticket **before the first await** (a later ticket gets a higher number whatever order the answers come in)
    const tag0 = socket.tag()
    if (!tag0 || !isLiveAgent(tag0)) return
    const gen = (tag0.ticketSeq ?? 0) + 1
    socket.setTag({ ...tag0, ticketSeq: gen })
    /** ⚠️ A newer ticket's outcome is already on the tag ⇒ this answer must not replace it (nor be reported) */
    const superseded = (t: Tag) => (t.ticketApplied ?? 0) > gen
    const token = new TextDecoder().decode(payload)
    const r = await this.#io.verifyLicense(token)
    const tagNow = socket.tag()
    if (!tagNow || !isLiveAgent(tagNow)) return
    const { lic: _drop, ...without } = tagNow
    const refuse = (status: LicenseStatus, enforce = true): void => {
      if (superseded(tagNow)) return
      socket.setTag({ ...without, ticketApplied: gen })
      this.#licenseResult(socket, status)
      if (enforce) this.#enforce()
    }
    if (!r.ok) return refuse(r.reason === 'expired' ? 'expired' : 'invalid')
    const l = r.license
    // ⚠️⚠️ Only tickets addressed to **this machine's key** (do not let another machine's ticket be reused / codex round 26, high #3)
    if (!tagNow.key || l.key !== tagNow.key) return refuse('invalid')
    // ★ Marks for in-flight checks (⚠️ the count is only what the agent sends = the key owner. A cap just in case)
    const claiming = tagNow.claiming ?? []
    if (claiming.length >= MAX_CLAIMS_IN_FLIGHT) return refuse('invalid', false)
    const seq = (tagNow.claimSeq ?? 0) + 1
    const mark = `${seq}|${l.acct} ${l.mid}`
    // ★★ Keep the current ticket while the ledger answers (2026-09-27 / codex): dropping it here made the room look unlicensed
    //   during every hourly renewal, and a message arriving meanwhile closed the licensed phones (`#enforce`). A failure below
    //   still removes it (`base` has no `lic`); revocation meanwhile removes it in `revokeLicense`.
    socket.setTag({ ...tagNow, claimSeq: seq, claiming: [...claiming, mark] })
    const claimed = await this.#io.claimMachine(l.acct, tagNow.key, l.maxMachines, l.mid)
    // ⚠️ If the wire changed while waiting, do nothing (never tag a retired wire)
    const tagAfter = socket.tag()
    if (!tagAfter || !isLiveAgent(tagAfter)) return
    const revokedDuring = (tagAfter.claimRevoked ?? []).includes(mark)
    const { lic: _old, claiming: c, claimRevoked: cr, ...rest } = tagAfter
    const left = (c ?? []).filter((m) => m !== mark)
    const leftRevoked = (cr ?? []).filter((m) => m !== mark && left.includes(m))
    const base: Tag = { ...rest, ...(left.length ? { claiming: left } : {}), ...(leftRevoked.length ? { claimRevoked: leftRevoked } : {}) }
    // ⚠️⚠️ A newer ticket's outcome is on the tag ⇒ only our marks are cleared; the current ticket stays (codex 2026-09-27)
    if (superseded(tagAfter)) {
      socket.setTag({ ...base, ...(tagAfter.lic ? { lic: tagAfter.lic } : {}) })
      return
    }
    // ⚠️ Removed while waiting (`revokeLicense`) ⇒ the returning "may pass" is stale
    if (revokedDuring) {
      socket.setTag({ ...base, ticketApplied: gen })
      this.#licenseResult(socket, 'revoked')
      this.#enforce()
      return
    }
    if (claimed !== 'ok') {
      socket.setTag({ ...base, ticketApplied: gen })
      this.#licenseResult(socket, claimed)
      this.#enforce()
      return
    }
    socket.setTag({ ...base, ticketApplied: gen, lic: { acct: l.acct, mid: l.mid, plan: l.plan, maxDevices: l.maxDevices, exp: l.exp * 1000 } })
    this.#licenseResult(socket, 'ok')
    // ★ If the ticket lowers the limit (Plus → Free), close the excess wires here
    this.#enforce()
  }

  /** agent → phone (⚠️ the destination is resolved here. The agent only knows the number) */
  async #fromAgent(socket: RoomSocket, bytes: Uint8Array): Promise<void> {
    const decoded = decodeRelayFrame(bytes)
    if (!decoded.ok) {
      // ⚠️ The inner reason is built by `shared/relayFrame.ts` (Japanese on relay) ⇒ prefix an English heading
      this.#drop(socket, `${REASON.malformed} / ${decoded.reason}`, CLOSE.badFrame)
      return
    }
    // ★★ "Close the wire of the phone with this number" (2026-09-24 / codex round 18, high #1).
    //   ⚠️ Only from agents that announced it (otherwise, as before, "a type that cannot be sent").
    //   ⚠️ Unknown numbers are silently dropped (crossing in flight is normal).
    if (decoded.value.type === RELAY_FRAME.drop && socket.tag()?.control === true) {
      const target = this.#devices().find((d) => d.connId === decoded.value.connId)
      if (target) this.#evict(target, REASON.agentClosed)
      return
    }
    // ★★ Tickets (⚠️ only from agents that announced `l=1`. Otherwise, as before, "a type that cannot be sent")
    if (decoded.value.type === RELAY_FRAME.license && socket.tag()?.licensing === true) {
      await this.#onLicense(socket, decoded.value.payload ?? new Uint8Array(0))
      return
    }
    // ⚠️ `opened` / `closed` / `ready` / `licenseResult` are produced by relay (never come from the agent)
    if (decoded.value.type !== RELAY_FRAME.data) {
      this.#drop(socket, REASON.agentBadType, CLOSE.badFrame)
      return
    }
    const target = this.#devices().find((d) => d.connId === decoded.value.connId)
    // ⚠️⚠️ A phone that has not proved its key was never announced to the agent (no `opened`) ⇒ nothing reaches it, and it is not promoted
    if (target?.tag.dpending) return
    // ★★ The agent replied = accepted it (⚠️ the tag is written only the first time = not on every frame after)
    if (target && target.tag.until !== undefined && target.tag.admitted !== true) {
      // ⚠️⚠️ **Check the limit at the moment of promotion too** (codex round 18, medium #2): checking only on accept,
      //    with 7 accepted, the 4 in the waiting room got replies at once and it became **11** (reproduced).
      if (this.#admittedCount() >= this.#deviceLimit()) {
        this.#evict(target, REASON.tooMany)
        return
      }
      // ★ A room without a ticket admits only phones holding it as their free slot (the ticket may have gone between the
      //   phone's check and the agent's reply; `#enforce` only looks at admitted wires, so it is checked here too / 2026-09-27)
      if (!this.#io.selfHosted() && !this.#paid() && target.tag.free !== true) {
        this.#evict(target, REASON.planChanged, CLOSE.planChanged)
        return
      }
      // ★ Keep `dkey` / `free` (the free-tier marks / 2026-09-27); the deadline has served
      const { until: _served, ...rest } = target.tag
      target.socket.setTag({ ...rest, admitted: true })
    }
    // ⚠️ Unknown numbers are **silently dropped** (crossing right after a disconnect is normal)
    if (decoded.value.payload) target?.socket.send(decoded.value.payload)
  }

  /** phone → agent (⚠️ adding the number is relay's job) */
  #fromDevice(connId: number, message: ArrayBuffer): void {
    this.#toAgent({ type: RELAY_FRAME.data, connId, payload: new Uint8Array(message) })
  }

  #toAgent(frame: Parameters<typeof encodeRelayFrame>[0]): void {
    const agent = this.#agent()
    if (!agent) return
    try {
      agent.send(encodeRelayFrame(frame))
    } catch {
      // ⚠️ A wire that cannot be sent to is cleaned up at the next close (do not touch state here)
    }
  }

  /** A wire closed (⚠️ `worker.ts` routes both `close` and `error` here) */
  onClose(socket: RoomSocket): void {
    const tag = socket.tag()
    if (tag?.side === 'device' && tag.connId) {
      // ★★ Mark it gone **before** telling the agent (2026-09-27 / codex round 3): a proof check awaiting the ledger re-reads the tag
      //   and must stop here, or it would send `opened` (and the held message) for a phone that no longer exists = an orphan slot
      //   on the agent with no `closed` ever coming. ⚠️ Writing to a closed wire may fail; the notice still goes out
      try {
        socket.setTag({ ...tag, evicted: true })
      } catch {
        // ⚠️ Already unreachable (the continuation then sees no tag at all and stops too)
      }
      // ★ Tell the agent it "disconnected" (the agent discards that tunnel)
      this.#toAgent({ type: RELAY_FRAME.closed, connId: tag.connId })
      return
    }
    // ⚠️⚠️ An unproven wire or **a retired wire** closing does not concern the phones
    //    (it was not "the agent" / is no longer current / codex round 4, medium #3)
    // ★ An unproven agent wire closing is retired here, so a proof check still verifying on it stops (codex 2026-09-27, round 4)
    if (tag?.side === 'agent' && tag.proven !== true && tag.retired !== true) {
      try {
        socket.setTag({ ...tag, retired: true })
      } catch {
        // ⚠️ Already unreachable (the continuation then sees no tag and stops too)
      }
      return
    }
    if (isLiveAgent(tag)) {
      // ⚠️ Once the agent is gone, the phones hanging off it **have no purpose**
      //    (do not keep them waiting silently = the UI shows a reason)
      for (const d of this.#devices()) this.#evict(d, REASON.agentGone, CLOSE.agentGone)
    }
  }
}

/** ★ `bytes` is a handshake's first message naming the device key `dkey` (base64url / `#binds`) */
function namesKey(bytes: Uint8Array, dkey: string): boolean {
  const named = initDevicePublicKey(bytes)
  return named !== undefined && toBase64Url(named) === dkey
}

/** ⚠️ The connection number of a phone wire (always set by `startDevice` before any await) */
function now0ConnId(tag: Tag): number {
  return tag.connId ?? 0
}

function isLiveAgent(tag: Tag | null | undefined): boolean {
  return tag?.side === 'agent' && tag.proven === true && tag.retired !== true
}

/** ⚠️ The public key is base64url raw P-256 (65B → 87 characters). **Only length and character set are checked** */
export const KEY_RE = /^[A-Za-z0-9_-]{86,88}$/

/** ★ Length of the ephemeral key and nonce (used by `RoomIo` implementations) */
export const CHALLENGE_NONCE_BYTES = RELAY_NONCE_BYTES
