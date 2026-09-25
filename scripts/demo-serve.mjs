// ★ A demo server for README screenshots (2026-09-25). `node scripts/demo-serve.mjs [port]` → http://127.0.0.1:7798
//
// Serves web/dist with a small, realistic English data set (two machines, a pending approval, a running session).
// ⚠️ Never touches the real agent or state files. ⚠️ Bound to 127.0.0.1 only (like dev-fakeserve.mjs).
// ⚠️ For pictures only — checks of layout and edge cases belong to dev-fakeserve.mjs.
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { summarize, detailOf } from '../agent/src/permission.ts'

const PORT = Number(process.argv[2] ?? 7798)
const DIST = fileURLToPath(new URL('../web/dist/', import.meta.url))
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString()

const session = (o) => ({
  account: '.claude',
  cwd: `/home/user/${o.project}`,
  titleSource: 'ai',
  live: true,
  transcriptBytes: 100,
  ...o,
})
const SESSIONS = [
  session({ machine: 'desktop', sessionId: 'S1', project: 'webshop', title: 'Refactor the auth middleware', status: 'waiting', waitingFor: 'permission prompt', lastActivity: ago(1), contextTokens: 84_000 }),
  session({ machine: 'desktop', sessionId: 'S2', project: 'webshop', title: 'Add dark mode to settings', status: 'working', lastActivity: ago(0), contextTokens: 41_000 }),
  session({ machine: 'laptop', account: '.claude-work', sessionId: 'S3', project: 'api', title: 'Fix the flaky upload test', status: 'idle', lastActivity: ago(6), contextTokens: 128_000 }),
  session({ machine: 'laptop', account: '.claude-work', sessionId: 'S4', project: 'api', title: 'Write the release notes', status: 'idle', lastActivity: ago(22), contextTokens: 23_000 }),
  session({ machine: 'desktop', sessionId: 'S5', project: 'infra', title: 'Upgrade the Postgres image', status: 'idle', lastActivity: ago(55), contextTokens: 61_000 }),
]

const input = { command: 'npm test -- --coverage', description: 'Run the test suite with coverage' }
const d = detailOf('Bash', input)
const PERMISSIONS = [
  {
    key: 'p1',
    machine: 'desktop',
    account: '.claude',
    project: 'webshop',
    sessionId: 'S1',
    toolName: 'Bash',
    summary: summarize('Bash', input),
    ...(d ? { detail: d.text, detailClipped: d.clipped } : {}),
    at: ago(1),
  },
]

const LOG = {
  S1: [
    { kind: 'user', at: ago(6), text: 'Move the token check out of each route into one middleware.' },
    { kind: 'assistant', at: ago(2), text: 'Done: every route now goes through `requireAuth()`. Running the tests to make sure nothing broke.' },
  ],
  S2: [
    { kind: 'user', at: ago(4), text: 'Add a dark mode toggle to the settings page. Follow the OS setting by default.' },
    { kind: 'assistant', at: ago(3), text: "I'll add a theme setting with three choices: **System**, **Light** and **Dark**.\n\n1. Define the colours as CSS variables\n2. Add the toggle to `Settings.tsx`\n3. Remember the choice in `localStorage`" },
    { kind: 'assistant', at: ago(1), text: 'The variables are in place and the toggle works. Now updating the tests.' },
    { kind: 'thinking', at: ago(0), text: '' },
  ],
}

const json = (res, body) => {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.map': 'application/json' }

createServer(async (req, res) => {
  const p = new URL(req.url ?? '/', 'http://x').pathname
  if (p === '/sessions') return json(res, { sessions: SESSIONS })
  if (p === '/permissions') return json(res, { permissions: PERMISSIONS, quiet: 0 })
  if (p === '/health') return json(res, { machine: 'desktop', accounts: [], account: { signedIn: true, plan: 'plus', maxMachines: 5, maxDevices: 5, login: 'you', relay: 'ok' } })
  if (p === '/peers') return json(res, { available: false })
  if (p === '/push/status') return json(res, { supported: false, subscribed: false, deviceCount: 0 })
  if (p.startsWith('/sessions/') && p.endsWith('/log')) {
    const id = decodeURIComponent(p.split('/')[2] ?? '')
    return json(res, { sessionId: id, account: '.claude', entries: LOG[id] ?? [{ kind: 'assistant', at: ago(5), text: 'Done. All tests pass.' }], cursor: null, tail: 100, bytes: 100 })
  }
  if (p === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    return res.write('retry: 3000\n\n')
  }
  // ⚠️ No update banner in pictures; no Service Worker (same reason as dev-fakeserve.mjs)
  if (p === '/RELEASE' || p === '/sw.js') {
    res.writeHead(404)
    return res.end()
  }
  const rel = normalize(p === '/' ? '/index.html' : p).replace(/^(\.\.[/\\])+/, '')
  const file = join(DIST, rel)
  try {
    const buf = await readFile(file.startsWith(DIST) ? file : join(DIST, 'index.html'))
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(buf)
  } catch {
    res.writeHead(200, { 'content-type': TYPES['.html'] })
    res.end(await readFile(join(DIST, 'index.html')))
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Demo server http://127.0.0.1:${PORT}`))
