// The path one request takes (= **the only order** of authentication, routing and response).
//
// ★★ **That there is exactly one path is itself a safeguard** (2026-09-08 / ③ stage 6 step ②).
//   It used to live inside `index.ts`; it was split out so that **tunnels (relay / local WebSocket)
//   take the same path**.
//   ⚠️⚠️ **Never write a second pipeline for tunnels.**
//      Writing the broken-config 503, CSRF, authentication and route matching in two places means
//      **only one side ever gets fixed** (a shape this repo has hit many times / CLAUDE.md §2).
//   ★ Tunnels differ in only two ways, and both are **arguments**:
//      ① whether a GET that matches no route falls through to static serving (`allowStatic`)
//      ② the request is marked with `markDeviceRequest` before the call (`agent/src/tunnel.ts`)

import { AsyncLocalStorage } from 'node:async_hooks'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { asLang, currentLang, setLangProvider, type Lang, t } from '../../shared/i18n.ts'
import { applyCors, authenticate, rejectCrossOrigin } from './auth.ts'
import { configProblem, problemMessage, rememberLogin } from './config.ts'
import { HttpError, json, type Router } from './router.ts'
import { serveStatic } from './static.ts'
import { notePattern } from './traffic.ts'

/** Identity used when only static serving is let through in refusal mode (nobody) */
const LOCKED_IDENTITY = { login: 'locked', deviceId: 'locked', via: 'dev' } as const

export interface ServeOptions {
  router: Router
  req: IncomingMessage
  res: ServerResponse
  /**
   * ★ Whether a GET that matches no route falls through to **static serving** (the PWA itself).
   *
   * ⚠️ `true` for HTTP (the agent serving the PWA itself is X / ARCHITECTURE §14.3).
   * ⚠️⚠️ **`false` for tunnels** (tunnels are API only. They are used by an already open PWA,
   *    so there is no need to serve the app, and no path is made for putting non-JSON into envelopes).
   */
  allowStatic: boolean
}

/**
 * ★★ **Turning exceptions into responses is also the path's job** (2026-09-15 / codex medium #1).
 *
 * ⚠️⚠️ It used to exist only in the `.catch()` in `index.ts`, so **on the tunnel side
 *    `deliver` itself rejected** (= the "never throw on the peer's input" contract was broken).
 *    ★ It also happened with **malformed percent-encoding** such as `/sessions/%/log`, so it
 *      could be triggered **by the peer's input alone**.
 * ⇒ HTTP and tunnels go through **the same conversion** (= what "one path" means).
 */
/**
 * ★★ Per-request language (2026-09-23 / `shared/i18n.ts`). The PWA adds `?lang=en|ja` to requests
 *   (added in one place, `web/src/transport/agent.ts`). While this request is being handled,
 *   text the agent returns (`t()`) is in that language. ⚠️ Without it, Japanese (old PWA, CLI = as before).
 * ⚠️ Works over the relay too (tunnel requests take this path; it is **a query in the path**, not a header, so it travels).
 * ⚠️ Never used for decisions (it only picks the text = harmless whatever value the peer puts in).
 */
const requestLang = new AsyncLocalStorage<Lang>()
setLangProvider(() => requestLang.getStore())

export function langOfRequest(rawUrl: string | undefined): Lang {
  try {
    // ★ 2026-09-24: without it, **this machine's language** (hooks, CLI, old PWA). It used to be hard-wired to Japanese
    //   ⚠️ this is called outside any request ⇒ `currentLang()` is the process language (`index.ts` decides it from the environment at startup)
    return asLang(new URL(rawUrl ?? '/', 'http://localhost').searchParams.get('lang')) ?? currentLang()
  } catch {
    return currentLang()
  }
}

export async function handleRequest(o: ServeOptions): Promise<void> {
  await requestLang.run(langOfRequest(o.req.url), () => handleRequestIn(o))
}

async function handleRequestIn(o: ServeOptions): Promise<void> {
  try {
    await runRequest(o)
  } catch (err) {
    // ⚠️ once sending has started the status code can no longer change (let the carrier cut it)
    if (o.res.headersSent) {
      o.res.destroy()
      return
    }
    if (err instanceof HttpError) {
      json(o.res, err.status, { error: err.message })
      return
    }
    // ⚠️ only the classification goes out (details go to the log / CLAUDE.md §2)
    console.error(t('[agent] 未処理のエラー:', '[agent] Unhandled error:'), err)
    json(o.res, 500, { error: 'internal error' })
  }
}

async function runRequest(o: ServeOptions): Promise<void> {
  const { router, req, res } = o
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

  if (await applyCors(req, res)) return

  // ★★ If the config is unusable, stop the whole API (fail-closed).
  //
  //   ⚠️ Mistaking a broken config.json for "first start" records and pins the next login that arrives
  //     (= pairing silently reopens). While authentication inputs cannot be trusted, **allow nothing**.
  //   ★ But **the PWA itself (static serving) is let through** (2026-08-14 review, medium).
  //     ⚠️ When it was blocked, **the PWA served by that agent did not even show a screen**.
  //        Only one machine is on the home screen (CLAUDE.md), so if that machine's config breaks,
  //        **every means of control from the phone disappears** (even if other machines are healthy).
  //        Once the screen shows, `main.tsx` displays the reason cleanly as "<label>: <reason>".
  //     ⚠️ Static serving is read-only and independent of the config, so letting it through adds no decision inputs.
  const broken = configProblem()
  const matchedRoute = router.match(req.method ?? 'GET', url.pathname)
  // ★ Tell traffic measurement the path classification (to measure bandwidth for §14.1.1 / traffic.ts).
  //   ⚠️ **Do not write normalization on the measurement side** (it would make a second path table that drifts when routes are added)
  notePattern(res, matchedRoute?.pattern)
  const isStatic =
    o.allowStatic && !matchedRoute && (req.method === 'GET' || req.method === 'HEAD')
  if (broken && !isStatic) {
    json(res, 503, { error: problemMessage(broken) })
    return
  }
  if (broken && isStatic) {
    // authentication cannot be judged in this state either, so let it through (only the public PWA code is served)
    await serveStatic({ req, res, url, params: {}, identity: LOCKED_IDENTITY })
    return
  }

  // ★ CSRF: writes from disallowed origins are rejected before processing.
  //    CORS only stops "reading", not "arriving", so without this
  //    any website could cause side effects (hijacking subscriptions etc.) (see the notes in auth.ts)
  const crossOrigin = await rejectCrossOrigin(req)
  if (crossOrigin) {
    json(res, crossOrigin.status, { error: crossOrigin.message })
    return
  }

  // Authentication happens only here (CLAUDE.md discipline 3).
  // ★★ **Pass the destination the router resolved** (not the raw path / 2026-09-08 codex high #1).
  //   ⚠️⚠️ The router drops empty segments, so `/hook/` hits the `/hook` handler.
  //      While authentication compared the raw path exactly, **that one path slipped past the local-only check**.
  const auth = authenticate(req, matchedRoute)
  if (!auth.ok) {
    json(res, auth.status, { error: auth.message })
    return
  }
  if (auth.rememberLogin) await rememberLogin(auth.rememberLogin)

  // ★★ **Execute with the same match result that was authenticated** (do not call `match` again).
  //   ⚠️⚠️ Calling it twice makes "what was authenticated" and "what is executed" different values (the seed of the same shape as high #1).
  const method = req.method ?? 'GET'
  const handler =
    matchedRoute?.handler ?? (o.allowStatic && (method === 'GET' || method === 'HEAD') ? router.fallback : null)
  if (!handler) {
    json(res, 404, { error: 'not found' })
    return
  }

  const result = await handler({
    req,
    res,
    url,
    params: matchedRoute?.params ?? {},
    identity: auth.identity,
  })
  // if the handler returned a value and nothing has been sent yet, return it as JSON
  if (result !== undefined && !res.headersSent) json(res, 200, result)
}
