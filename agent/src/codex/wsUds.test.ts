import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  MAX_FRAGMENTS,
  acceptFor,
  connectWsUds,
  encodeClientFrame,
  readHandshake,
  WsFrameParser,
  type DuplexLike,
  type WsClosed,
  type WsEvent,
} from './wsUds.ts'

/** A server frame (unmasked). `fin` and `opcode` are free so that tests can build illegal ones. */
function serverFrame(opcode: number, payload: Buffer | string, fin = true, extraBits = 0): Buffer {
  const p = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
  const b0 = (fin ? 0x80 : 0) | extraBits | opcode
  if (p.length < 126) return Buffer.concat([Buffer.from([b0, p.length]), p])
  if (p.length < 0x10000) {
    const h = Buffer.alloc(4)
    h[0] = b0
    h[1] = 126
    h.writeUInt16BE(p.length, 2)
    return Buffer.concat([h, p])
  }
  const h = Buffer.alloc(10)
  h[0] = b0
  h[1] = 127
  h.writeBigUInt64BE(BigInt(p.length), 2)
  return Buffer.concat([h, p])
}

function feed(parser: WsFrameParser, bytes: Buffer, step: number): WsEvent[] {
  const out: WsEvent[] = []
  for (let i = 0; i < bytes.length; i += step) out.push(...parser.push(bytes.subarray(i, i + step)))
  return out
}

/** Undo the client mask (what a server does), to read what the client sent */
function unmaskClientFrame(buf: Buffer): { opcode: number; payload: Buffer; rest: Buffer } | undefined {
  if (buf.length < 2) return undefined
  const opcode = buf[0]! & 0x0f
  assert.equal(buf[1]! & 0x80, 0x80, 'client frames must be masked')
  let len = buf[1]! & 0x7f
  let off = 2
  if (len === 126) {
    if (buf.length < 4) return undefined
    len = buf.readUInt16BE(2)
    off = 4
  } else if (len === 127) {
    if (buf.length < 10) return undefined
    len = Number(buf.readBigUInt64BE(2))
    off = 10
  }
  if (buf.length < off + 4 + len) return undefined
  const mask = buf.subarray(off, off + 4)
  const payload = Buffer.alloc(len)
  for (let i = 0; i < len; i++) payload[i] = buf[off + 4 + i]! ^ mask[i & 3]!
  return { opcode, payload, rest: buf.subarray(off + 4 + len) }
}

// ───────────────────────── parser ─────────────────────────

test('parser: a text message arrives whole at every chunk size, including inside a multi-byte character', () => {
  const text = 'こんにちは {"jsonrpc":"2.0"} 🐈'
  const bytes = serverFrame(0x1, text)
  for (const step of [1, 2, 3, 7, bytes.length]) {
    assert.deepEqual(feed(new WsFrameParser(), bytes, step), [{ type: 'message', text }], `step=${step}`)
  }
})

test('parser: the 16-bit and 64-bit length forms', () => {
  const mid = 'a'.repeat(300)
  const big = 'b'.repeat(70_000)
  assert.deepEqual(new WsFrameParser().push(serverFrame(0x1, mid)), [{ type: 'message', text: mid }])
  assert.deepEqual(new WsFrameParser().push(serverFrame(0x1, big)), [{ type: 'message', text: big }])
})

test('parser: fragments are reassembled, and a ping between fragments is delivered in order', () => {
  const bytes = Buffer.concat([
    serverFrame(0x1, 'he', false),
    serverFrame(0x9, 'p'),
    serverFrame(0x0, 'll', false),
    serverFrame(0x0, 'o', true),
  ])
  for (const step of [1, 5, bytes.length]) {
    assert.deepEqual(feed(new WsFrameParser(), bytes, step), [
      { type: 'ping', payload: Buffer.from('p') },
      { type: 'message', text: 'hello' },
    ])
  }
})

test('parser: two messages in one chunk', () => {
  const out = new WsFrameParser().push(Buffer.concat([serverFrame(0x1, 'a'), serverFrame(0x1, 'b')]))
  assert.deepEqual(out, [
    { type: 'message', text: 'a' },
    { type: 'message', text: 'b' },
  ])
})

test('parser: close with and without a code', () => {
  assert.deepEqual(new WsFrameParser().push(serverFrame(0x8, Buffer.from([0x03, 0xe9]))), [{ type: 'close', code: 1001 }])
  assert.deepEqual(new WsFrameParser().push(serverFrame(0x8, Buffer.alloc(0))), [{ type: 'close', code: undefined }])
})

test('parser: violations', () => {
  const cases: Array<[string, Buffer]> = [
    ['reserved-bits', serverFrame(0x1, 'x', true, 0x40)],
    ['masked-from-server', encodeClientFrame(0x1, Buffer.from('x'))],
    ['binary-message', serverFrame(0x2, 'x')],
    ['unknown-opcode', serverFrame(0x3, 'x')],
    ['stray-continuation', serverFrame(0x0, 'x')],
    ['interleaved-message', Buffer.concat([serverFrame(0x1, 'a', false), serverFrame(0x1, 'b')])],
    ['fragmented-control', serverFrame(0x9, 'x', false)],
    ['control-too-long', serverFrame(0x9, 'x'.repeat(126))],
    ['bad-close', serverFrame(0x8, Buffer.from([0x03]))],
    ['bad-utf8', serverFrame(0x1, Buffer.from([0xff, 0xfe]))],
  ]
  for (const [reason, bytes] of cases) {
    const out = new WsFrameParser().push(bytes)
    assert.deepEqual(out.at(-1), { type: 'violation', reason }, reason)
  }
})

test('parser: an over-long message is refused from its header, before the payload arrives', () => {
  const p = new WsFrameParser(1000)
  // Only the 4-byte header of a 2000-byte frame
  assert.deepEqual(p.push(serverFrame(0x1, 'x'.repeat(2000)).subarray(0, 4)), [{ type: 'violation', reason: 'too-long' }])

  // A 64-bit length far beyond anything (must not wrap into a small number)
  const huge = Buffer.alloc(10)
  huge[0] = 0x81
  huge[1] = 127
  huge.writeBigUInt64BE(2n ** 63n, 2)
  assert.deepEqual(new WsFrameParser(1000).push(huge), [{ type: 'violation', reason: 'too-long' }])
})

test('parser: fragments that only together exceed the cap are refused', () => {
  const p = new WsFrameParser(1000)
  assert.deepEqual(p.push(serverFrame(0x1, 'x'.repeat(600), false)), [])
  assert.deepEqual(p.push(serverFrame(0x0, 'x'.repeat(600), true)), [{ type: 'violation', reason: 'too-long' }])
})

test('parser: exactly the cap is accepted', () => {
  const text = 'x'.repeat(1000)
  assert.deepEqual(new WsFrameParser(1000).push(serverFrame(0x1, text)), [{ type: 'message', text }])
})

test('parser: nothing is produced after a violation or a close (no resynchronising on hostile bytes)', () => {
  const a = new WsFrameParser()
  a.push(serverFrame(0x2, 'x'))
  assert.deepEqual(a.push(serverFrame(0x1, 'after')), [])

  const b = new WsFrameParser()
  assert.equal(b.push(Buffer.concat([serverFrame(0x8, Buffer.alloc(0)), serverFrame(0x1, 'after')])).length, 1)
  assert.deepEqual(b.push(serverFrame(0x1, 'later')), [])
})

// ───────────────────────── encoder ─────────────────────────

test('encoder: frames are masked and read back to the same payload at each length form', () => {
  for (const n of [0, 5, 125, 126, 65_535, 65_536]) {
    const payload = Buffer.alloc(n, 0x61)
    const got = unmaskClientFrame(encodeClientFrame(0x1, payload))
    assert.ok(got, `n=${n}`)
    assert.equal(got.opcode, 0x1)
    assert.ok(got.payload.equals(payload), `n=${n}`)
    assert.equal(got.rest.length, 0)
  }
})

test('encoder: known answer (RFC 6455 §5.7 masked "Hello")', () => {
  const frame = encodeClientFrame(0x1, Buffer.from('Hello'), Buffer.from([0x37, 0xfa, 0x21, 0x3d]))
  assert.equal(frame.toString('hex'), '818537fa213d7f9f4d5158')
})

// ───────────────────────── handshake ─────────────────────────

test('handshake: known accept value (RFC 6455 §1.3)', () => {
  assert.equal(acceptFor('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
})

function response(key: string, over: { status?: string; headers?: string[] } = {}): Buffer {
  const headers = over.headers ?? ['Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptFor(key)}`]
  return Buffer.from([over.status ?? 'HTTP/1.1 101 Switching Protocols', ...headers, '', ''].join('\r\n'), 'latin1')
}

test('handshake: accepts a correct response and hands back the bytes after it', () => {
  const key = 'k'
  const r = readHandshake(Buffer.concat([response(key), Buffer.from('rest')]), key)
  assert.deepEqual(r, { type: 'ok', rest: Buffer.from('rest') })
  assert.deepEqual(readHandshake(response(key).subarray(0, 20), key), { type: 'need-more' })
})

test('handshake: refusals', () => {
  const key = 'k'
  const good = `Sec-WebSocket-Accept: ${acceptFor(key)}`
  const cases: Array<[string, Buffer]> = [
    ['not-101', response(key, { status: 'HTTP/1.1 200 OK' })],
    ['not-101', response(key, { status: 'HTTP/1.1 1010 Nope' })],
    ['no-upgrade', response(key, { headers: [good] })],
    ['bad-accept', response(key, { headers: ['Upgrade: websocket', `Sec-WebSocket-Accept: ${acceptFor('other')}`] })],
    ['bad-accept', response(key, { headers: ['Upgrade: websocket'] })],
    ['duplicate-header', response(key, { headers: ['Upgrade: websocket', `Sec-WebSocket-Accept: ${acceptFor('other')}`, good] })],
    ['unexpected-extension', response(key, { headers: ['Upgrade: websocket', good, 'Sec-WebSocket-Extensions: permessage-deflate'] })],
    ['unexpected-protocol', response(key, { headers: ['Upgrade: websocket', good, 'Sec-WebSocket-Protocol: x'] })],
    ['bad-header', response(key, { headers: ['Upgrade: websocket', good, 'no colon here'] })],
    ['head-too-long', Buffer.alloc(9000, 0x61)],
  ]
  for (const [reason, bytes] of cases) {
    assert.deepEqual(readHandshake(bytes, key), { type: 'refused', reason }, reason)
  }
})

// ───────────────────────── a real UDS ─────────────────────────

interface Peer {
  path: string
  /** The server side of the one accepted connection, after it answered the upgrade */
  accepted: Promise<Socket>
  stop(): void
}

/** A minimal real server on a real UDS: answers the upgrade (optionally wrongly), then hands the socket to the test. */
function startPeer(opts: { accept?: (key: string) => string; extra?: Buffer; silent?: boolean } = {}): Peer {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-ws-'))
  const path = join(dir, 's.sock')
  let resolveAccepted!: (s: Socket) => void
  const accepted = new Promise<Socket>((r) => (resolveAccepted = r))
  const server: Server = createServer((sock) => {
    let head = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk])
      const end = head.indexOf('\r\n\r\n')
      if (end === -1) return
      sock.off('data', onData)
      if (opts.silent) return resolveAccepted(sock)
      const key = /sec-websocket-key: (.+)\r\n/i.exec(head.toString('latin1'))?.[1] ?? ''
      const accept = (opts.accept ?? acceptFor)(key)
      sock.write(
        Buffer.concat([
          Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`),
          opts.extra ?? Buffer.alloc(0),
        ]),
      )
      resolveAccepted(sock)
    }
    sock.on('data', onData)
    sock.on('error', () => undefined)
  })
  server.listen(path)
  return {
    path,
    accepted,
    stop: () => {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function collectFrom(sock: Socket): { next(): Promise<{ opcode: number; payload: Buffer }> } {
  let buf = Buffer.alloc(0)
  const waiters: Array<() => void> = []
  sock.on('data', (c: Buffer) => {
    buf = Buffer.concat([buf, c])
    for (const w of waiters.splice(0)) w()
  })
  return {
    async next() {
      for (;;) {
        const f = unmaskClientFrame(buf)
        if (f) {
          buf = Buffer.from(f.rest)
          return { opcode: f.opcode, payload: f.payload }
        }
        await new Promise<void>((r) => waiters.push(r))
      }
    },
  }
}

test('uds: upgrade, exchange messages both ways, answer a ping', async () => {
  const peer = startPeer()
  try {
    const got: string[] = []
    let wake: (() => void) | undefined
    const conn = await connectWsUds({
      path: peer.path,
      onMessage: (t) => {
        got.push(t)
        wake?.()
      },
    })
    const sock = await peer.accepted
    const frames = collectFrom(sock)

    await conn.send('{"hello":1}')
    assert.deepEqual(await frames.next(), { opcode: 0x1, payload: Buffer.from('{"hello":1}') })

    sock.write(serverFrame(0x1, '{"from":"server"}'))
    await new Promise<void>((r) => (got.length > 0 ? r() : (wake = r)))
    assert.deepEqual(got, ['{"from":"server"}'])

    sock.write(serverFrame(0x9, 'ping!'))
    assert.deepEqual(await frames.next(), { opcode: 0xa, payload: Buffer.from('ping!') })

    conn.close()
    assert.deepEqual(await conn.closed, { reason: 'local' })
  } finally {
    peer.stop()
  }
})

test('uds: a message in the same chunk as the upgrade response is not lost', async () => {
  const peer = startPeer({ extra: serverFrame(0x1, 'early') })
  try {
    const got: string[] = []
    const conn = await connectWsUds({ path: peer.path, onMessage: (t) => got.push(t) })
    assert.deepEqual(got, ['early'])
    conn.close()
  } finally {
    peer.stop()
  }
})

test('uds: a bare EOF (what the daemon does on stop) ends the connection as "eof"', async () => {
  const peer = startPeer()
  try {
    const conn = await connectWsUds({ path: peer.path, onMessage: () => undefined })
    ;(await peer.accepted).destroy()
    assert.deepEqual(await conn.closed, { reason: 'eof' })
    await assert.rejects(conn.send('x'), /ws-closed/)
  } finally {
    peer.stop()
  }
})

test('uds: a close frame and a violation are told apart', async () => {
  const a = startPeer()
  try {
    const conn = await connectWsUds({ path: a.path, onMessage: () => undefined })
    ;(await a.accepted).write(serverFrame(0x8, Buffer.from([0x03, 0xe9])))
    assert.deepEqual(await conn.closed, { reason: 'peer-close', detail: '1001' })
  } finally {
    a.stop()
  }
  const b = startPeer()
  try {
    const got: string[] = []
    const conn = await connectWsUds({ path: b.path, onMessage: (t) => got.push(t) })
    ;(await b.accepted).write(Buffer.concat([serverFrame(0x2, 'bin'), serverFrame(0x1, 'after')]))
    assert.deepEqual(await conn.closed, { reason: 'violation', detail: 'binary-message' })
    assert.deepEqual(got, [], 'nothing after the violation is delivered')
  } finally {
    b.stop()
  }
})

test('uds: a wrong accept value refuses the upgrade', async () => {
  const peer = startPeer({ accept: () => acceptFor('someone-else') })
  try {
    await assert.rejects(
      connectWsUds({ path: peer.path, onMessage: () => undefined }),
      (e: unknown) => {
        assert.deepEqual(e, { reason: 'violation', detail: 'handshake:bad-accept' })
        return true
      },
    )
  } finally {
    peer.stop()
  }
})

test('uds: a peer that never answers the upgrade times out', async () => {
  const peer = startPeer({ silent: true })
  try {
    await assert.rejects(
      connectWsUds({ path: peer.path, onMessage: () => undefined, handshakeTimeoutMs: 50 }),
      (e: unknown) => {
        assert.deepEqual(e, { reason: 'timeout' })
        return true
      },
    )
  } finally {
    peer.stop()
  }
})

test('uds: no socket file is "error ENOENT" (= no daemon), distinct from every other ending', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-ws-'))
  try {
    await assert.rejects(
      connectWsUds({ path: join(dir, 'missing.sock'), onMessage: () => undefined }),
      (e: unknown) => {
        assert.deepEqual(e, { reason: 'error', detail: 'ENOENT' })
        return true
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ───────────────────────── backpressure and teardown (injected socket) ─────────────────────────

class FakeSocket implements DuplexLike {
  written: Buffer[] = []
  destroyed = false
  writable = true
  #h: Record<string, Array<(arg?: never) => void>> = {}
  write(data: Buffer): boolean {
    this.written.push(data)
    return this.writable
  }
  destroy(): void {
    this.destroyed = true
  }
  on(event: string, cb: (arg: never) => void): this {
    ;(this.#h[event] ??= []).push(cb as (arg?: never) => void)
    return this
  }
  emit(event: string, arg?: unknown): void {
    for (const cb of this.#h[event] ?? []) cb(arg as never)
  }
}

async function openFake(): Promise<{ sock: FakeSocket; conn: Awaited<ReturnType<typeof connectWsUds>> }> {
  const sock = new FakeSocket()
  const p = connectWsUds({ path: 'unused', onMessage: () => undefined, open: () => sock })
  sock.emit('connect')
  const key = /Sec-WebSocket-Key: (.+)\r\n/.exec(sock.written[0]!.toString('latin1'))![1]!
  sock.emit('data', response(key))
  return { sock, conn: await p }
}

test('backpressure: a send waits for drain, and later sends wait behind it', async () => {
  const { sock, conn } = await openFake()
  sock.written = []
  sock.writable = false
  const order: string[] = []
  const a = conn.send('a').then(() => order.push('a'))
  const b = conn.send('b').then(() => order.push('b'))
  await new Promise((r) => setImmediate(r))
  assert.equal(sock.written.length, 1, 'the second frame is not written while the first waits for drain')
  assert.deepEqual(order, [])
  sock.writable = true
  sock.emit('drain')
  await Promise.all([a, b])
  assert.deepEqual(order, ['a', 'b'])
  assert.equal(sock.written.length, 2)
  conn.close()
})

test('teardown: a send stuck behind a dead socket fails instead of hanging', async () => {
  const { sock, conn } = await openFake()
  sock.writable = false
  const stuck = conn.send('a')
  const queued = conn.send('b')
  sock.emit('close')
  await assert.rejects(stuck, /ws-closed/)
  await assert.rejects(queued, /ws-closed/)
  assert.deepEqual(await conn.closed, { reason: 'eof' })
})

test('teardown: close() finishes by itself, once, without waiting for the peer', async () => {
  const { sock, conn } = await openFake()
  conn.close()
  conn.close()
  assert.equal(sock.destroyed, true)
  const first: WsClosed = await conn.closed
  // The peer's later events must not rewrite the reason
  sock.emit('error', Object.assign(new Error('x'), { code: 'EPIPE' }))
  sock.emit('close')
  assert.deepEqual(await conn.closed, first)
  assert.deepEqual(first, { reason: 'local' })
})

// ── codex review (2026-11-15) ────────────────────────────────────────────────────────────────────────────────

test('★ parser: a message in too many fragments is refused, even when every fragment is empty (medium #9)', () => {
  const p = new WsFrameParser(1)
  assert.deepEqual(p.push(serverFrame(0x1, '', false)), [])
  const empties = Buffer.concat(Array.from({ length: MAX_FRAGMENTS - 1 }, () => serverFrame(0x0, '', false)))
  assert.deepEqual(p.push(empties), [], 'up to the cap is fine')
  assert.deepEqual(p.push(serverFrame(0x0, '', false)), [{ type: 'violation', reason: 'too-many-fragments' }])
})

test('parser: the fragment count starts over with each message', () => {
  const p = new WsFrameParser()
  for (let i = 0; i < 3; i++) {
    const frames = [serverFrame(0x1, 'a', false), ...Array.from({ length: MAX_FRAGMENTS - 2 }, () => serverFrame(0x0, '', false)), serverFrame(0x0, 'b', true)]
    assert.deepEqual(p.push(Buffer.concat(frames)), [{ type: 'message', text: 'ab' }])
  }
})

test('★ send: the guard is asked when the frame\'s turn comes; a "no" then means it is never written (high #4)', async () => {
  const { sock, conn } = await openFake()
  sock.written = []
  sock.writable = false
  const first = conn.send('a')
  const state = { ok: true, asked: 0 }
  const second = conn.send('b', () => {
    state.asked++
    return state.ok
  })
  await new Promise((r) => setImmediate(r))
  assert.equal(state.asked, 0, 'not asked while it waits behind the first frame')
  // It timed out meanwhile
  state.ok = false
  sock.writable = true
  sock.emit('drain')
  await first
  await assert.rejects(second, /ws-cancelled/)
  assert.equal(state.asked, 1)
  assert.equal(sock.written.length, 1, 'only the first frame was written')
  // The queue goes on afterwards
  await conn.send('c', () => true)
  assert.equal(sock.written.length, 2)
  conn.close()
})

test('★ ping: pongs behind backpressure are coalesced, and the one written answers the latest ping (second review, low #4)', async () => {
  const { sock, conn } = await openFake()
  sock.written = []
  sock.writable = false
  void conn.send('stuck').catch(() => undefined)
  sock.emit('data', Buffer.concat(Array.from({ length: 100 }, (_, i) => serverFrame(0x9, `p${i}`))))
  sock.writable = true
  for (let i = 0; i < 10; i++) {
    sock.emit('drain')
    await new Promise((r) => setImmediate(r))
  }
  const pongs = sock.written.map((b) => unmaskClientFrame(b)).filter((f) => f?.opcode === 0xa)
  assert.equal(pongs.length, 1)
  assert.equal(pongs[0]!.payload.toString(), 'p99')
  // A later ping is answered again
  sock.emit('data', serverFrame(0x9, 'again'))
  await new Promise((r) => setImmediate(r))
  const last = unmaskClientFrame(sock.written.at(-1)!)
  assert.equal(last?.opcode, 0xa)
  assert.equal(last?.payload.toString(), 'again')
  conn.close()
})
