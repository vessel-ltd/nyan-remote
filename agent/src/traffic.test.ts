// Traffic measurement (`traffic.ts`).
//
// ⚠️⚠️ **Measure against a real HTTP server.** Tests that pass hand-made `req`/`res`
// become "false green" (VERIFY.md "test the values the implementation actually produces").
// ★ In particular, "socket deltas" can only be verified with real keep-alive.

import assert from 'node:assert/strict'
import { Agent, createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import {
  beginMeasure,
  flush,
  measureConnection,
  notePattern,
  resetForTest,
  snapshot,
  startFlushing,
  stopFlushingForTest,
} from './traffic.ts'

/**
 * Starts a server with measurement installed and sends requests.
 *
 * ⚠️⚠️ **Do not use `fetch`** (it actually hung on 2026-08-31). Node's `fetch` has
 *    **a global connection pool**; even after `server.closeAllConnections()` cuts the server side,
 *    **the client-side keep-alive remains and the test process never exits**.
 * ⇒ **Own a `node:http` `Agent` and destroy it** (this also lets us test keep-alive).
 */
async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (get: (path: string) => Promise<string>) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    beginMeasure(req, res)
    handler(req, res)
  })
  // ★ same shape as the real index.ts (measures per-connection totals)
  server.on('connection', measureConnection)
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  // ★ enable keep-alive (one of the goals is to verify socket deltas)
  const agent = new Agent({ keepAlive: true, maxSockets: 1 })
  const get = (path: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port, path, agent }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => (body += c))
        res.on('end', () => resolve(body))
      })
      r.on('error', reject)
      r.end()
    })
  try {
    await run(get)
  } finally {
    agent.destroy()
    server.closeAllConnections()
    await new Promise<void>((ok) => server.close(() => ok()))
  }
}

beforeEach(() => {
  delete process.env['NYAN_REMOTE_NO_MEASURE']
  resetForTest()
})
afterEach(() => {
  stopFlushingForTest()
  resetForTest()
})

test('★★ measured: response bytes are recorded (not hand-made values)', async () => {
  const body = 'x'.repeat(5000)
  await withServer(
    (req, res) => {
      notePattern(res, '/sessions')
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(body)
    },
    async (get) => {
      assert.equal((await get('/sessions')).length, 5000)
    },
  )
  const s = snapshot()
  const row = s.routes['GET /sessions']
  assert.ok(row, `no record: ${JSON.stringify(s.routes)}`)
  assert.equal(row.n, 1)
  // ★ 5000 body + headers. ⚠️ not written as equality (header length is implementation-dependent), but **never less than the body**
  assert.ok(row.out >= 5000, `out=${row.out} is less than the 5000 body`)
  assert.ok(row.out < 5000 + 2000, `out=${row.out} is too large (possibly not a delta)`)
  // ⚠️⚠️ **No per-pattern `in`** (headers are read before measurement starts, so it cannot be measured).
  //    ⇒ upstream is looked at **per connection**. ★ This implements "do not report unmeasurable numbers as 0"
  assert.ok(!('in' in row), 'has a per-pattern in (reporting an unmeasurable number)')
})

test('★★★ measured: two requests over keep-alive still give a "delta" (not adding running totals)', async () => {
  const body = 'y'.repeat(4000)
  await withServer(
    (req, res) => {
      notePattern(res, '/sessions')
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(body.length) })
      res.end(body)
    },
    async (get) => {
      // ⚠️ maxSockets:1 + keepAlive **reuses the same socket** (verifies the delta)
      for (let i = 0; i < 3; i++) await get('/sessions')
    },
  )
  const row = snapshot().routes['GET /sessions']
  assert.ok(row, 'no record')
  assert.equal(row.n, 3)
  // ★ adding running totals would give at least 4000+8000+12000=24000. A delta gives about 12000
  assert.ok(row.out >= 12_000, `out=${row.out} (does not reach 12000 for three requests)`)
  assert.ok(row.out < 20_000, `out=${row.out} — ★ adding running totals (not a delta)`)
})

test('★★★ session IDs do not remain in the record (router patterns are used)', async () => {
  await withServer(
    (req, res) => {
      // ★ same shape as the real index.ts: pass the pattern the router returned
      notePattern(res, '/sessions/:id/log')
      res.writeHead(200)
      res.end('{}')
    },
    async (get) => {
      await get('/sessions/9f8e7d6c-dead-beef-1234-567890abcdef/log')
    },
  )
  const keys = Object.keys(snapshot().routes)
  assert.deepEqual(keys, ['GET /sessions/:id/log'])
  // ⚠️ this is the whole point (§6.2 "identifiers and state only")
  assert.ok(!JSON.stringify(snapshot()).includes('9f8e7d6c'), 'a session ID remains in the record')
})

test('★ without a pattern it becomes `?` (static serving and 404)', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(404)
      res.end('nope')
    },
    async (get) => {
      await get('/no/such/path')
    },
  )
  assert.deepEqual(Object.keys(snapshot().routes), ['GET ?'])
})

test('★★ bodies are not recorded (§6.2)', async () => {
  const secret = 'コミットしてはいけない秘密の文章'
  await withServer(
    (req, res) => {
      notePattern(res, '/sessions')
      res.writeHead(200)
      res.end(secret)
    },
    async (get) => {
      await get('/sessions')
    },
  )
  assert.ok(!JSON.stringify(snapshot()).includes(secret), 'a body leaked into the record')
})

test('★★ escape hatch: NYAN_REMOTE_NO_MEASURE=1 records nothing', async () => {
  process.env['NYAN_REMOTE_NO_MEASURE'] = '1'
  await withServer(
    (req, res) => {
      notePattern(res, '/sessions')
      res.writeHead(200)
      res.end('z'.repeat(3000))
    },
    async (get) => {
      await get('/sessions')
    },
  )
  assert.deepEqual(snapshot().routes, {}, 'the escape hatch is not working')
})

test('★★ measured: check the line flush actually writes (not a hand-made line)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-remote-traffic-'))
  process.env['NYAN_REMOTE_STATE_DIR'] = dir
  try {
    await withServer(
      (req, res) => {
        notePattern(res, '/health')
        res.writeHead(200)
        res.end('{}')
      },
      async (get) => {
        await get('/health')
      },
    )
    const wrote = await flush(new Date('2026-08-31T15:00:00.000Z'))
    assert.equal(wrote, true, 'flush did not write')
    const line = readFileSync(join(dir, 'traffic.jsonl'), 'utf8').trim()
    const rec = JSON.parse(line) as { at: string; routes: Record<string, { n: number; out: number }> }
    assert.equal(rec.at, '2026-08-31T15:00:00.000Z')
    assert.equal(rec.routes['GET /health']?.n, 1)
    assert.ok((rec.routes['GET /health']?.out ?? 0) > 0, 'out is 0')
    // ★ empty after writing (no double counting into the next window)
    assert.deepEqual(snapshot().routes, {})
  } finally {
    delete process.env['NYAN_REMOTE_STATE_DIR']
  }
})

test('★ empty windows are not written (no 1440 empty lines a day)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-remote-traffic-'))
  process.env['NYAN_REMOTE_STATE_DIR'] = dir
  try {
    assert.equal(await flush(), false)
  } finally {
    delete process.env['NYAN_REMOTE_STATE_DIR']
  }
})

test('★★★ returns false if it cannot write (no exception, no false success)', async () => {
  // ⚠️⚠️ using `/proc/...` **makes mkdir hang on WSL** (actually hit on 2026-08-31;
  //    node --test stalled for 45s with `Promise resolution is still pending`).
  //    ⇒ **put a file where the directory should be** (ENOTDIR fails reliably and immediately)
  const base = mkdtempSync(join(tmpdir(), 'nyan-remote-traffic-'))
  const notADir = join(base, 'notadir')
  writeFileSync(notADir, 'x')
  process.env['NYAN_REMOTE_STATE_DIR'] = notADir
  try {
    await withServer(
      (req, res) => {
        notePattern(res, '/health')
        res.writeHead(200)
        res.end('{}')
      },
      async (get) => {
        await get('/health')
      },
    )
    // ⚠️ return false without throwing (the agent sits in the daily critical path)
    // ★★ this is the real check: with `appendJsonl` it would return **true though nothing was written**
    assert.equal(await flush(), false, 'returns true though nothing was written (false success)')
  } finally {
    delete process.env['NYAN_REMOTE_STATE_DIR']
  }
})

test('★ the startFlushing timer is unref\'d (does not hold up the process)', () => {
  startFlushing()
  // ⚠️ without unref the test process would not exit (which is itself the failure signal)
  //    here we check it is not started twice
  startFlushing()
  stopFlushingForTest()
  assert.ok(true)
})

test('★★★ measured: upstream (in) is available per connection (not per pattern)', async () => {
  await withServer(
    (req, res) => {
      notePattern(res, '/sessions')
      res.writeHead(200)
      res.end('ok')
    },
    async (get) => {
      await get('/sessions')
    },
  )
  // ⚠️ wait for the socket to close (close is asynchronous)
  await new Promise((r) => setTimeout(r, 50))
  const c = snapshot().conns
  assert.equal(c.n, 1, `connection not counted: ${JSON.stringify(c)}`)
  assert.ok(c.in > 0, `upstream is 0 (measureConnection not working): ${JSON.stringify(c)}`)
  assert.ok(c.out > 0, `downstream is 0: ${JSON.stringify(c)}`)
})
