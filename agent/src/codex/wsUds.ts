// ★★ A WebSocket **client** over a Unix domain socket (2026-11-14 / docs/CODEX.md §5).
//
// Why this exists: the Codex app-server daemon listens on a UDS and speaks WebSocket + JSON-RPC on it (measured on
// codex-cli 0.169.0). Node's built-in `WebSocket` cannot connect to a UDS, and the agent has zero runtime dependencies,
// so the client side of RFC 6455 is written here on top of `node:net`.
//
// ⚠️⚠️ Everything read from the socket is **hostile input** (it is another program's bytes, and its version changes
//    under us). ⇒ Every length is bounded, every protocol violation tears the connection down, nothing is guessed.
// ⚠️ Scope is deliberately small: text messages only (JSON-RPC), no extensions, no subprotocol. A binary message or a
//    reserved bit is a violation, not something to tolerate.
// ⚠️ **`close()` completes the teardown by itself** (CLAUDE.md "calling close() is not closed"): it never waits for the
//    peer's close frame. Measured: the daemon drops us with a bare EOF, without a close frame.

import { createHash, randomBytes } from 'node:crypto'
import { connect as netConnect } from 'node:net'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Largest HTTP response head we read during the upgrade */
export const MAX_HANDSHAKE_BYTES = 8 * 1024
/** Default cap for one (reassembled) message. A thread read can be large, so this is generous but finite. */
export const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024
/** Control frames may carry at most 125 bytes (RFC 6455 §5.5) */
const MAX_CONTROL_BYTES = 125
/**
 * Most fragments one message may arrive in. ⚠️ The byte cap alone does not bound memory: empty continuation frames
 * add nothing to the byte count (codex review, medium #9: 100,000 of them were accepted under a 1-byte cap).
 */
export const MAX_FRAGMENTS = 1024

const OP_CONT = 0x0
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

export type WsEvent =
  | { type: 'message'; text: string }
  | { type: 'ping'; payload: Buffer }
  | { type: 'pong' }
  | { type: 'close'; code: number | undefined }
  /** A protocol violation. The connection must be torn down; the parser accepts nothing after this. */
  | { type: 'violation'; reason: string }

/**
 * Incremental parser for frames **from the server** (so: never masked).
 *
 * ★ Pure: bytes in, events out. Chunk boundaries may fall anywhere (inside the header, inside a UTF-8 sequence).
 * ⚠️ After a violation or a close it is dead: further bytes produce nothing (never "resynchronise" on hostile input).
 */
export class WsFrameParser {
  #buf: Buffer = Buffer.alloc(0)
  #parts: Buffer[] = []
  #partsBytes = 0
  #fragments = 0
  #inMessage = false
  #dead = false
  readonly #max: number

  constructor(maxMessageBytes: number = DEFAULT_MAX_MESSAGE_BYTES) {
    this.#max = maxMessageBytes
  }

  push(chunk: Buffer): WsEvent[] {
    if (this.#dead) return []
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk])
    const out: WsEvent[] = []
    while (!this.#dead) {
      const ev = this.#next()
      if (ev === 'need-more') break
      if (ev === 'continue') continue
      out.push(ev)
      if (ev.type === 'violation' || ev.type === 'close') this.#dead = true
    }
    if (this.#dead) this.#buf = Buffer.alloc(0)
    return out
  }

  #next(): WsEvent | 'need-more' | 'continue' {
    const b = this.#buf
    if (b.length < 2) return 'need-more'
    const b0 = b[0]!
    const b1 = b[1]!
    const fin = (b0 & 0x80) !== 0
    if ((b0 & 0x70) !== 0) return { type: 'violation', reason: 'reserved-bits' }
    const opcode = b0 & 0x0f
    // ⚠️ A server must never mask (RFC 6455 §5.1). Accepting it would mean running an unmasking path nobody tests.
    if ((b1 & 0x80) !== 0) return { type: 'violation', reason: 'masked-from-server' }
    let len = b1 & 0x7f
    let offset = 2
    if (len === 126) {
      if (b.length < 4) return 'need-more'
      len = b.readUInt16BE(2)
      offset = 4
    } else if (len === 127) {
      if (b.length < 10) return 'need-more'
      const big = b.readBigUInt64BE(2)
      // ⚠️ Compare as bigint **before** narrowing (a 2^63 length must not wrap into something small)
      if (big > BigInt(this.#max)) return { type: 'violation', reason: 'too-long' }
      len = Number(big)
      offset = 10
    }
    const control = opcode >= 0x8
    if (control) {
      if (!fin) return { type: 'violation', reason: 'fragmented-control' }
      if (len > MAX_CONTROL_BYTES) return { type: 'violation', reason: 'control-too-long' }
    } else if (len > this.#max || this.#partsBytes + len > this.#max) {
      // ⚠️ Checked from the header, before the payload arrives: never buffer what we already know we will refuse
      return { type: 'violation', reason: 'too-long' }
    }
    if (b.length < offset + len) return 'need-more'
    const payload = b.subarray(offset, offset + len)
    this.#buf = b.subarray(offset + len)

    switch (opcode) {
      case OP_PING:
        return { type: 'ping', payload: Buffer.from(payload) }
      case OP_PONG:
        return { type: 'pong' }
      case OP_CLOSE:
        if (len === 1) return { type: 'violation', reason: 'bad-close' }
        return { type: 'close', code: len >= 2 ? payload.readUInt16BE(0) : undefined }
      case OP_TEXT:
        if (this.#inMessage) return { type: 'violation', reason: 'interleaved-message' }
        break
      case OP_CONT:
        if (!this.#inMessage) return { type: 'violation', reason: 'stray-continuation' }
        break
      case OP_BINARY:
        return { type: 'violation', reason: 'binary-message' }
      default:
        return { type: 'violation', reason: 'unknown-opcode' }
    }
    this.#inMessage = true
    if (++this.#fragments > MAX_FRAGMENTS) return { type: 'violation', reason: 'too-many-fragments' }
    // ★ An empty fragment adds nothing to the message: nothing is kept for it
    if (len > 0) this.#parts.push(Buffer.from(payload))
    this.#partsBytes += len
    if (!fin) return 'continue'
    const whole = this.#parts.length === 1 ? this.#parts[0]! : Buffer.concat(this.#parts)
    this.#parts = []
    this.#partsBytes = 0
    this.#fragments = 0
    this.#inMessage = false
    try {
      // ⚠️ `fatal`: invalid UTF-8 is a violation, not replacement characters that then fail JSON.parse somewhere else
      return { type: 'message', text: new TextDecoder('utf-8', { fatal: true }).decode(whole) }
    } catch {
      return { type: 'violation', reason: 'bad-utf8' }
    }
  }
}

/** Encode one **client** frame (always masked, always FIN). */
export function encodeClientFrame(opcode: number, payload: Buffer, mask: Buffer = randomBytes(4)): Buffer {
  const len = payload.length
  let head: Buffer
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, 0x80 | len])
  } else if (len < 0x10000) {
    head = Buffer.alloc(4)
    head[0] = 0x80 | opcode
    head[1] = 0x80 | 126
    head.writeUInt16BE(len, 2)
  } else {
    head = Buffer.alloc(10)
    head[0] = 0x80 | opcode
    head[1] = 0x80 | 127
    head.writeBigUInt64BE(BigInt(len), 2)
  }
  const masked = Buffer.alloc(len)
  for (let i = 0; i < len; i++) masked[i] = payload[i]! ^ mask[i & 3]!
  return Buffer.concat([head, mask, masked])
}

/** The `Sec-WebSocket-Accept` value a server must answer for `key` */
export function acceptFor(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64')
}

export type HandshakeResult =
  | { type: 'need-more' }
  | { type: 'ok'; rest: Buffer }
  | { type: 'refused'; reason: string }

/**
 * Read the HTTP response to our upgrade request.
 *
 * ⚠️ Not a general HTTP parser on purpose: status 101, `Upgrade: websocket`, the right accept value, nothing else.
 * ⚠️ Any extension or subprotocol the server claims is refused (we offered none ⇒ it would change the framing rules).
 */
export function readHandshake(buf: Buffer, key: string): HandshakeResult {
  const end = buf.indexOf('\r\n\r\n')
  if (end === -1) {
    return buf.length > MAX_HANDSHAKE_BYTES ? { type: 'refused', reason: 'head-too-long' } : { type: 'need-more' }
  }
  if (end > MAX_HANDSHAKE_BYTES) return { type: 'refused', reason: 'head-too-long' }
  const lines = buf.subarray(0, end).toString('latin1').split('\r\n')
  const status = lines[0] ?? ''
  if (!/^HTTP\/1\.1 101(?: |$)/.test(status)) return { type: 'refused', reason: 'not-101' }
  const headers = new Map<string, string>()
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':')
    if (i <= 0) return { type: 'refused', reason: 'bad-header' }
    const name = line.slice(0, i).trim().toLowerCase()
    // ⚠️ A repeated security-relevant header is refused rather than "last one wins"
    if (headers.has(name)) return { type: 'refused', reason: 'duplicate-header' }
    headers.set(name, line.slice(i + 1).trim())
  }
  if ((headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') return { type: 'refused', reason: 'no-upgrade' }
  if (headers.get('sec-websocket-accept') !== acceptFor(key)) return { type: 'refused', reason: 'bad-accept' }
  if (headers.has('sec-websocket-extensions')) return { type: 'refused', reason: 'unexpected-extension' }
  if (headers.has('sec-websocket-protocol')) return { type: 'refused', reason: 'unexpected-protocol' }
  return { type: 'ok', rest: Buffer.from(buf.subarray(end + 4)) }
}

/** The part of a socket this file uses (so that tests can hand in their own). */
export interface DuplexLike {
  write(data: Buffer): boolean
  destroy(): void
  on(event: 'data', cb: (chunk: Buffer) => void): unknown
  on(event: 'drain' | 'close' | 'connect', cb: () => void): unknown
  on(event: 'error', cb: (err: Error) => void): unknown
}

/**
 * Why a connection ended.
 *   `local`      we called `close()`
 *   `eof`        the peer went away without a close frame (what the daemon does on stop / restart)
 *   `peer-close` the peer sent a close frame
 *   `violation`  the peer broke the protocol, or the upgrade was refused (`detail` says which)
 *   `timeout`    the upgrade did not finish in time
 *   `error`      the socket failed (`detail` is the error code: ENOENT = no daemon, EACCES/EPERM = not ours to open)
 */
export interface WsClosed {
  reason: 'local' | 'eof' | 'peer-close' | 'violation' | 'timeout' | 'error'
  detail?: string
}

export interface WsUdsConnection {
  /**
   * Send one text message. Resolves once the bytes were handed to the socket **and it is ready for more** (backpressure).
   * ⚠️ `guard` is called right before the bytes are written (after everything queued ahead of them). If it returns
   *    false the message is **not written** and the promise rejects (a request that timed out while queued must not
   *    reach the daemon later — codex review, high #4).
   */
  send(text: string, guard?: () => boolean): Promise<void>
  /** Tear down now. Idempotent. Does not wait for the peer. */
  close(): void
  /** Resolves exactly once, when the connection is over (for any reason). */
  readonly closed: Promise<WsClosed>
}

export interface WsUdsOptions {
  path: string
  onMessage: (text: string) => void
  handshakeTimeoutMs?: number
  maxMessageBytes?: number
  /** ★ Injected in tests. The default opens the UDS at `path`. */
  open?: (path: string) => DuplexLike
}

/**
 * Connect and upgrade. Rejects (with a `WsClosed`) if the connection ends before the upgrade completes.
 *
 * ⚠️ `onMessage` is attached before the first byte is read: a message that arrives in the same chunk as the upgrade
 *    response is delivered, not dropped (CLAUDE.md "attach the receiver right after connecting").
 */
export function connectWsUds(opts: WsUdsOptions): Promise<WsUdsConnection> {
  const socket = (opts.open ?? ((p: string) => netConnect({ path: p }) as unknown as DuplexLike))(opts.path)
  const key = randomBytes(16).toString('base64')
  const parser = new WsFrameParser(opts.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES)

  let upgraded = false
  let over = false
  let head: Buffer = Buffer.alloc(0)
  let sendChain: Promise<void> = Promise.resolve()
  const drainWaiters: Array<() => void> = []

  let resolveClosed!: (c: WsClosed) => void
  const closed = new Promise<WsClosed>((r) => (resolveClosed = r))
  let resolveOpen!: (c: WsUdsConnection) => void
  let rejectOpen!: (c: WsClosed) => void
  const opened = new Promise<WsUdsConnection>((res, rej) => {
    resolveOpen = res
    rejectOpen = rej
  })

  const finish = (why: WsClosed): void => {
    if (over) return
    over = true
    clearTimeout(timer)
    socket.destroy()
    // ⚠️ Wake everyone waiting for `drain`: a send stuck behind a dead socket must fail, not hang forever
    for (const w of drainWaiters.splice(0)) w()
    resolveClosed(why)
    if (!upgraded) rejectOpen(why)
  }

  const timer = setTimeout(() => finish({ reason: 'timeout' }), opts.handshakeTimeoutMs ?? 5000)

  const writeRaw = (data: Buffer, guard?: () => boolean): Promise<void> => {
    if (over) return Promise.reject(new Error('ws-closed'))
    // ⚠️ Asked here, immediately before the write (not when the message was queued)
    if (guard && !guard()) return Promise.reject(new Error('ws-cancelled'))
    if (socket.write(data)) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      drainWaiters.push(() => (over ? reject(new Error('ws-closed')) : resolve()))
    })
  }
  // ★ One chain for every outgoing frame: frames never interleave, and a slow socket slows the caller down
  /** `data` may be a function: the frame is then built when its turn comes (a pong carries the latest ping) */
  const enqueue = (data: Buffer | (() => Buffer), guard?: () => boolean): Promise<void> => {
    const p = sendChain.then(() => writeRaw(typeof data === 'function' ? data() : data, guard))
    sendChain = p.catch(() => undefined)
    return p
  }
  /**
   * ★ Pongs are coalesced (second review, low #4): at most one waits in the queue, and it answers the **latest** ping
   *   (RFC 6455 §5.5.3 allows answering only the most recent). Behind backpressure, every ping used to queue one
   *   more pong (unbounded), and a fixed cap would have dropped the newest one instead.
   */
  let pongPayload: Buffer | undefined

  const conn: WsUdsConnection = {
    send: (text, guard) => enqueue(encodeClientFrame(OP_TEXT, Buffer.from(text, 'utf8')), guard),
    close: () => {
      if (over) return
      // Best effort: tell the peer, but do not wait for it
      if (upgraded) socket.write(encodeClientFrame(OP_CLOSE, Buffer.from([0x03, 0xe8])))
      finish({ reason: 'local' })
    },
    closed,
  }

  const onFrames = (chunk: Buffer): void => {
    for (const ev of parser.push(chunk)) {
      if (over) return
      switch (ev.type) {
        case 'message':
          opts.onMessage(ev.text)
          break
        case 'ping': {
          const waiting = pongPayload !== undefined
          pongPayload = ev.payload
          if (waiting) break
          void enqueue(() => {
            const payload = pongPayload ?? Buffer.alloc(0)
            pongPayload = undefined
            return encodeClientFrame(OP_PONG, payload)
          }).catch(() => undefined)
          break
        }
        case 'pong':
          break
        case 'close':
          finish({ reason: 'peer-close', ...(ev.code === undefined ? {} : { detail: String(ev.code) }) })
          break
        case 'violation':
          finish({ reason: 'violation', detail: ev.reason })
          break
      }
    }
  }

  socket.on('connect', () => {
    if (over) return
    socket.write(
      Buffer.from(
        'GET / HTTP/1.1\r\n' +
          'Host: localhost\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n',
        'latin1',
      ),
    )
  })
  socket.on('data', (chunk) => {
    if (over) return
    if (upgraded) return onFrames(chunk)
    head = Buffer.concat([head, chunk])
    const r = readHandshake(head, key)
    if (r.type === 'need-more') return
    if (r.type === 'refused') return finish({ reason: 'violation', detail: `handshake:${r.reason}` })
    upgraded = true
    head = Buffer.alloc(0)
    clearTimeout(timer)
    resolveOpen(conn)
    if (r.rest.length > 0) onFrames(r.rest)
  })
  socket.on('drain', () => {
    for (const w of drainWaiters.splice(0)) w()
  })
  socket.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException).code
    finish({ reason: 'error', ...(typeof code === 'string' ? { detail: code } : {}) })
  })
  socket.on('close', () => finish({ reason: 'eof' }))

  return opened
}
