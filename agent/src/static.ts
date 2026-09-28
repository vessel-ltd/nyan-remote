// Serves web/dist (= X: the agent itself serves the PWA / ARCHITECTURE.md §14.3).
//
// Because of this we can say "if you are worried, open it from your own agent".
// This escape hatch is what backs the trustworthiness of Y (serving from a public origin), so never remove it.

import { PWA_HEADERS } from '../../shared/distribution.ts'
import { t } from '../../shared/i18n.ts'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import type { Ctx } from './router.ts'

const DIST = resolve(import.meta.dirname, '../../web/dist')

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

/** Hashed build outputs are cached permanently; everything else is revalidated every time */
export function cacheControl(pathname: string): string {
  if (pathname.startsWith('/assets/')) return 'public, max-age=31536000, immutable'
  return 'no-cache'
}

/**
 * ★ Path traversal guard. A pure function with no file I/O, so it is testable.
 *
 * ⚠️ If this loosens, `GET /../../.claude/.credentials.json` **can read credentials**.
 *   The agent serves the PWA from the same origin, so the whole home directory is in range.
 *
 * @returns the absolute path safe to serve and the pathname used to decide. null if it escapes
 */
export function resolveUnderDist(
  rawPathname: string,
  dist: string,
): { file: string; pathname: string } | null {
  let pathname: string
  try {
    // ⚠️ decode escapes like `%2e%2e%2f` before deciding (deciding before decoding lets it slip out)
    pathname = decodeURIComponent(rawPathname)
  } catch {
    // malformed percent-encoding (`/%`). decodeURIComponent throws, so close it here
    return null
  }
  // NUL characters are used to truncate paths in attacks (fs does not accept them either)
  if (pathname.includes('\0')) return null
  if (pathname.endsWith('/')) pathname += 'index.html'

  const file = resolve(join(dist, normalize(pathname)))
  // ★ only allow a match with `dist` or something starting with `dist/`.
  //   comparing without sep lets **a neighbouring name** such as `web/dist-secret` through
  if (file !== dist && !file.startsWith(dist + sep)) return null
  return { file, pathname }
}

/** ★ Headers of a served file (a pure function so the test sees what is actually sent / codex 2026-09-28) */
export function staticHeaders(pathname: string, file: string, size: number): Record<string, string | number> {
  return {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'content-length': size,
    'cache-control': cacheControl(pathname),
    // whatever the distribution origin, prevent embedding and MIME misinterpretation (one table with Y / `PWA_HEADERS`)
    ...PWA_HEADERS,
    'referrer-policy': 'no-referrer',
  }
}

/** @param dist ⚠️ only tests pass another directory (the real one is `web/dist`) */
export async function serveStatic(ctx: Ctx, dist = DIST): Promise<undefined> {
  const { req, res, url } = ctx
  const safe = resolveUnderDist(url.pathname, dist)
  if (!safe) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('forbidden')
    return
  }
  const { pathname } = safe

  let file = safe.file
  let s = await tryStat(file)
  if (!s?.isFile()) {
    // a path without an extension is treated as an SPA route and gets index.html
    if (!extname(pathname)) {
      file = join(dist, 'index.html')
      s = await tryStat(file)
    }
  }

  if (!s?.isFile()) {
    if (!(await tryStat(join(dist, 'index.html')))) {
      placeholder(ctx)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
    return
  }

  res.writeHead(200, staticHeaders(pathname, file, s.size))
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(file).pipe(res)
}

async function tryStat(path: string) {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

/** Minimal page shown while web/dist does not exist yet (waiting for the first vite build) */
function placeholder(ctx: Ctx): void {
  // ⚠️ only fixed text is inserted (no user values in HTML)
  const body = `<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>nyan-remote</title>
<body style="font:16px/1.7 system-ui;margin:0;padding:3rem 1.5rem;background:#0b0d10;color:#e6e8eb">
<h1 style="font-size:1.4rem">nyan-remote</h1>
<p>${t('agent は動いていますが、<code>web/dist</code> がまだありません。', 'The agent is running, but <code>web/dist</code> does not exist yet.')}</p>
<pre style="background:#151a20;padding:1rem;border-radius:8px;overflow-x:auto">npm install
NYAN_REMOTE_DEV=1 npm run dev</pre>
<p style="color:#9aa4af">${t('API は使えます: ', 'The API is available: ')}<a style="color:#7ab8ff" href="/health">/health</a> ·
<a style="color:#7ab8ff" href="/sessions">/sessions</a></p>`
  ctx.res
    .writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // ⚠️ this page too (codex 2026-09-28 round 2: it was the one HTML response that could be framed)
      ...PWA_HEADERS,
    })
    .end(body)
}
