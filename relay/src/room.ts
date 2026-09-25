// Step 6 ③ of ③: **the contents** of the rendezvous (⚠️ knows nothing about the Durable Object API).
//
// ★★ **Why it was pulled out of `worker.ts`** (2026-09-15 / codex round 4):
//   the worker imports `cloudflare:workers`, so **not a single line ran from `npm test`**.
//   ⇒ The **most accident-prone decisions** ("not treated as an agent until proven", "number reuse", "disconnecting the old agent")
//     were only exercised by the smoke test against a real relay.
//   ⇒ The shape matches `openTunnel` / `openRelayLink` (**the carrier is passed in from outside**).
//
// ⚠️ Only "decisions" live here. Accepting sockets, storing tags and key generation are on the other side of `RoomIo`.

import { relayProof, sameBytes, type Jwk, type Key } from '../../shared/crypto.ts'
import {
  RELAY_NONCE_BYTES,
  decodeProof,
  encodeChallenge,
} from '../../shared/relayAuth.ts'
import {
  MAX_RELAY_BYTES,
  RELAY_FRAME,
  decodeRelayFrame,
  encodeRelayFrame,
  type LicenseStatus,
} from '../../shared/relayFrame.ts'
import type { LicenseCheck } from '../../shared/license.ts'

/**
 * ★★ How many phones can hang off one agent (the basis of the device limit in §14.1.1.5).
 *
 * ⚠️⚠️ **The limit lives on the relay side** (on the agent side it would be removed in the OSS).
 */
export const MAX_DEVICES = 8

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
  // ★ Billing (2026-09-24). ⚠️ Includes the fix (`nyan login`)
  licenseRequired: 'Sign in on the PC: nyan login / PC で nyan login してください',
  displaced: 'Closed to make room for a newer connection / 後から来た接続のために閉じました',
  noText: 'Text frames not accepted / 文字は受け取りません',
  tooLarge: 'Too large / 大きすぎます',
  unknownSocket: 'Unknown connection / 素性が分かりません',
  badProof: 'Could not read the proof / 証明を受け取れませんでした',
  lateProof: 'Proof came too late / 証明が遅すぎます',
  notOwner: 'Could not verify the key owner / 鍵の持ち主だと確かめられません',
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
   * ★★ agent: **whether proof of ownership is done** (④a of ③b / §14.1.2.30).
   *
   * ⚠️⚠️ Not treated as "agent" until done = **old wires are not cut and phones are not accepted**.
   */
  proven?: boolean
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
  /** ★ Whether the date after which phones are not let into rooms without a ticket has passed (⚠️ default is "not passed" = as before during the grace period) */
  licenseRequired(): boolean
  /**
   * ★★ **Someone else's relay** (`SELF_HOSTED=1` in `wrangler.selfhost.jsonc` / 2026-09-25): no plans at all.
   *   Tickets are never asked for (so no agent, old or new, sends one) and every room takes `MAX_DEVICES` phones.
   *   ⚠️ Without it, a signed-in agent's ticket put our Free plan's 2-phone limit on the user's own relay (codex).
   */
  selfHosted(): boolean
}

/** ★ Reply from the ledger (⚠️ falls to `machine-limit` if unreachable) */
export type ClaimResult = 'ok' | 'machine-limit' | 'revoked'

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
      const until = s.tag()?.pending?.until
      // ⚠️ Tags without a deadline (= old versions, broken tags) are evicted too (fail-closed)
      if (until === undefined || until <= now) {
        s.setTag({ side: 'agent', retired: true })
        s.close(CLOSE.badProof, REASON.noProof)
        swept += 1
      }
    }
    return swept
  }

  /**
   * ★★ Number of phones this room accepts (2026-09-24 / billing).
   *   With a valid ticket, its value (Free 2, Plus 5). Without one, as before during the grace period (`MAX_DEVICES`), 0 after it.
   * ⚠️ Never above `MAX_DEVICES` (even if a ticket carries a broken value, relay owns the room limit).
   */
  #deviceLimit(): number {
    if (this.#io.selfHosted()) return MAX_DEVICES
    const lic = this.#agent()?.tag()?.lic
    if (lic && lic.exp > this.#io.now()) return Math.min(lic.maxDevices, MAX_DEVICES)
    return this.#io.licenseRequired() ? 0 : MAX_DEVICES
  }

  /**
   * ★★ Enforce the limit **now** (2026-09-24 / codex round 26, high #2).
   *   ⚠️⚠️ Checking only on accept meant that after a ticket expired, a return to Free, or `LICENSE_REQUIRED_FROM` passing,
   *      **connected wires kept being carried** (reproduced). ⇒ Go through this every time before carrying anything.
   *   ★ Remove an expired ticket from the tag and tell the agent. Wires over the limit are closed **latest first**.
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
    const admitted = this.#devices()
      .filter((d) => d.tag.until === undefined || d.tag.admitted === true)
      .sort((a, b) => a.connId - b.connId)
    for (const d of admitted.slice(limit)) this.#evict(d, limit === 0 ? REASON.licenseRequired : REASON.tooMany, CLOSE.tooMany)
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
    const c = await this.#io.newChallenge()
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
    // ★ Past the date tickets are required, and there is none (⚠️ the agent wire is kept = a ticket can be handed over later)
    if (limit === 0) return { ok: false, status: 402, text: REASON.licenseRequired }
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
   */
  startDevice(socket: RoomSocket): number {
    const agent = this.#agent()
    const tag = agent?.tag()
    const last = tag?.lastConnId ?? 0
    // ⚠️ Wrap back to 1 on 4-byte overflow (by the time it gets that far, nobody from then remains)
    const connId = last >= MAX_CONN_ID ? 1 : last + 1
    if (agent && tag) agent.setTag({ ...tag, lastConnId: connId })
    // ★ Deadline until the agent accepts it (see `MAX_PENDING_DEVICES`)
    socket.setTag({ side: 'device', connId, until: this.#io.now() + DEVICE_ADMIT_DEADLINE_MS })
    this.#toAgent({ type: RELAY_FRAME.opened, connId })
    return connId
  }

  /** Handle one byte array from a wire (⚠️ **never throws**) */
  async onMessage(socket: RoomSocket, message: string | ArrayBuffer): Promise<void> {
    // ⚠️ No text (only ciphertext is carried = no second kind).
    //   ★ The only exception is `RELAY_PING`, and it **never gets here** (the auto-response answers first).
    //   ⚠️⚠️ So if the signal text differs by a single character it is **cut on the spot** = a mismatch shows up in measurement.
    if (typeof message === 'string') {
      socket.close(CLOSE.badFrame, REASON.noText)
      return
    }
    if (message.byteLength > MAX_RELAY_BYTES) {
      // ⚠️⚠️ The ToS measure itself (§14.1.1.4). **Large things are not carried**
      socket.close(CLOSE.badFrame, REASON.tooLarge)
      return
    }
    const tag = socket.tag()
    // ★★ **Until proof is done, only that is accepted** (④a of ③b)
    if (tag?.side === 'agent' && tag.proven !== true) {
      return await this.#checkProof(socket, tag, new Uint8Array(message))
    }
    // ★★ Enforce the limit before carrying (⚠️ nothing from a closed wire is carried / codex round 26, high #2)
    this.#enforce()
    if (socket.tag()?.evicted === true) return
    if (tag?.side === 'agent') return await this.#fromAgent(socket, new Uint8Array(message))
    if (tag?.side === 'device' && tag.connId) return this.#fromDevice(tag.connId, message)
    socket.close(CLOSE.badFrame, REASON.unknownSocket)
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
      socket.close(CLOSE.badProof, REASON.badProof)
      return
    }
    // ⚠️ Proofs past the deadline do not pass (accepting late ones would make the deadline meaningless)
    if (pending.until <= this.#io.now()) {
      socket.setTag({ side: 'agent', retired: true })
      socket.close(CLOSE.badProof, REASON.lateProof)
      return
    }
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
      socket.close(CLOSE.badProof, REASON.notOwner)
      return
    }
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
      for (const d of this.#devices()) d.socket.close(CLOSE.agentGone, REASON.agentReconnected)
    }
    // ★ Numbers are **carried over** (⚠️ going back to 1 would collide with frames in flight)
    socket.setTag({
      side: 'agent',
      proven: true,
      key: pending.key,
      ...(tag.control ? { control: true } : {}),
      ...(tag.licensing ? { licensing: true } : {}),
      ...(previousTag?.lastConnId === undefined ? {} : { lastConnId: previousTag.lastConnId }),
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
    const token = new TextDecoder().decode(payload)
    const r = await this.#io.verifyLicense(token)
    const tagNow = socket.tag()
    if (!tagNow || !isLiveAgent(tagNow)) return
    const { lic: _drop, ...without } = tagNow
    if (!r.ok) {
      socket.setTag(without)
      this.#licenseResult(socket, r.reason === 'expired' ? 'expired' : 'invalid')
      this.#enforce()
      return
    }
    const l = r.license
    // ⚠️⚠️ Only tickets addressed to **this machine's key** (do not let another machine's ticket be reused / codex round 26, high #3)
    if (!tagNow.key || l.key !== tagNow.key) {
      socket.setTag(without)
      this.#licenseResult(socket, 'invalid')
      this.#enforce()
      return
    }
    // ★ Marks for in-flight checks (⚠️ the count is only what the agent sends = the key owner. A cap just in case)
    const claiming = tagNow.claiming ?? []
    if (claiming.length >= MAX_CLAIMS_IN_FLIGHT) {
      socket.setTag(without)
      this.#licenseResult(socket, 'invalid')
      return
    }
    const seq = (tagNow.claimSeq ?? 0) + 1
    const mark = `${seq}|${l.acct} ${l.mid}`
    socket.setTag({ ...without, claimSeq: seq, claiming: [...claiming, mark] })
    const claimed = await this.#io.claimMachine(l.acct, tagNow.key, l.maxMachines, l.mid)
    // ⚠️ If the wire changed while waiting, do nothing (never tag a retired wire)
    const tagAfter = socket.tag()
    if (!tagAfter || !isLiveAgent(tagAfter)) return
    const revokedDuring = (tagAfter.claimRevoked ?? []).includes(mark)
    const { lic: _old, claiming: c, claimRevoked: cr, ...rest } = tagAfter
    const left = (c ?? []).filter((m) => m !== mark)
    const leftRevoked = (cr ?? []).filter((m) => m !== mark && left.includes(m))
    const base: Tag = { ...rest, ...(left.length ? { claiming: left } : {}), ...(leftRevoked.length ? { claimRevoked: leftRevoked } : {}) }
    // ⚠️ Removed while waiting (`revokeLicense`) ⇒ the returning "may pass" is stale
    if (revokedDuring) {
      socket.setTag(base)
      this.#licenseResult(socket, 'revoked')
      this.#enforce()
      return
    }
    if (claimed !== 'ok') {
      socket.setTag(base)
      this.#licenseResult(socket, claimed)
      this.#enforce()
      return
    }
    socket.setTag({ ...base, lic: { acct: l.acct, mid: l.mid, plan: l.plan, maxDevices: l.maxDevices, exp: l.exp * 1000 } })
    this.#licenseResult(socket, 'ok')
    // ★ If the ticket lowers the limit (Plus → Free), close the excess wires here
    this.#enforce()
  }

  /** agent → phone (⚠️ the destination is resolved here. The agent only knows the number) */
  async #fromAgent(socket: RoomSocket, bytes: Uint8Array): Promise<void> {
    const decoded = decodeRelayFrame(bytes)
    if (!decoded.ok) {
      // ⚠️ The inner reason is built by `shared/relayFrame.ts` (Japanese on relay) ⇒ prefix an English heading
      socket.close(CLOSE.badFrame, `${REASON.malformed} / ${decoded.reason}`)
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
      socket.close(CLOSE.badFrame, REASON.agentBadType)
      return
    }
    const target = this.#devices().find((d) => d.connId === decoded.value.connId)
    // ★★ The agent replied = accepted it (⚠️ the tag is written only the first time = not on every frame after)
    if (target && target.tag.until !== undefined && target.tag.admitted !== true) {
      // ⚠️⚠️ **Check the limit at the moment of promotion too** (codex round 18, medium #2): checking only on accept,
      //    with 7 accepted, the 4 in the waiting room got replies at once and it became **11** (reproduced).
      if (this.#admittedCount() >= this.#deviceLimit()) {
        this.#evict(target, REASON.tooMany)
        return
      }
      target.socket.setTag({ side: 'device', connId: target.connId, admitted: true })
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
      // ★ Tell the agent it "disconnected" (the agent discards that tunnel)
      this.#toAgent({ type: RELAY_FRAME.closed, connId: tag.connId })
      return
    }
    // ⚠️⚠️ An unproven wire or **a retired wire** closing does not concern the phones
    //    (it was not "the agent" / is no longer current / codex round 4, medium #3)
    if (isLiveAgent(tag)) {
      // ⚠️ Once the agent is gone, the phones hanging off it **have no purpose**
      //    (do not keep them waiting silently = the UI shows a reason)
      for (const d of this.#devices()) d.socket.close(CLOSE.agentGone, REASON.agentGone)
    }
  }
}

function isLiveAgent(tag: Tag | null | undefined): boolean {
  return tag?.side === 'agent' && tag.proven === true && tag.retired !== true
}

/** ⚠️ The public key is base64url raw P-256 (65B → 87 characters). **Only length and character set are checked** */
export const KEY_RE = /^[A-Za-z0-9_-]{86,88}$/

/** ★ Length of the ephemeral key and nonce (used by `RoomIo` implementations) */
export const CHALLENGE_NONCE_BYTES = RELAY_NONCE_BYTES
