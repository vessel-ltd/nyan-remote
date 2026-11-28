// ★★ The team socket (`nyan team …` / docs/TEAM.md §4.1 / codex design review, high #2).
//
// `/team/*` is served **only here**: a Unix socket in the state directory (`~/.nyan-remote/team.sock`).
// ⚠️⚠️ Not on 127.0.0.1:7777 with the hook token: while the agent is stopped, **another OS user can listen on 7777**
//    and collect the token a CLI sends; with the team routes that token could type into this user's sessions.
//    A socket inside a directory only this user can open needs no token: the directory is the lock.
// ⚠️ The directory is checked before listening (not a link, ours, closed to others); otherwise no socket is opened and
//    the teams are simply unavailable (the rest of the agent runs as before).
// ⚠️ One agent per state directory (as for every other state file): a second agent never takes a live socket away,
//    but two agents racing over the same leftover at the same instant are not arbitrated.
// ⚠️ Codex's sandbox refuses Unix sockets as it refuses TCP (measured 2026-11-18): a Codex lead's `nyan team` runs
//    outside it through the rule nyan update writes (docs/TEAM.md §10.2).

import { lstat, chmod, unlink } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect } from 'node:net'
import { join } from 'node:path'
import { t } from '../../shared/i18n.ts'
import { HttpError, json, Router, type Ctx } from './router.ts'
import {
  teamApprove,
  teamCandidates,
  teamCreate,
  teamDisband,
  teamList,
  teamPending,
  teamRead,
  teamRemove,
  teamSend,
  teamStatus,
} from './routes/team.ts'
import { stateDir } from './state.ts'
import { sweepTeamsNow } from './teamHooks.ts'
import { privateDirProblem, privateDirReal } from './privateDir.ts'

export const TEAM_SOCKET_NAME = 'team.sock'
/** AF_UNIX path limit is 104 (mac) / 108 (Linux) bytes; keep a margin */
export const MAX_SOCKET_PATH = 100

export function teamSocketPath(dir = stateDir()): string {
  return join(dir, TEAM_SOCKET_NAME)
}

export function buildTeamRouter(): Router {
  const r = new Router()
  r.get('/team/candidates', teamCandidates)
  r.post('/team/create', teamCreate)
  r.get('/team/status', teamStatus)
  r.get('/team/list', teamList)
  r.post('/team/send', teamSend)
  r.get('/team/read', teamRead)
  r.get('/team/pending', teamPending)
  r.post('/team/approve', teamApprove)
  r.post('/team/remove', teamRemove)
  r.post('/team/disband', teamDisband)
  return r
}

/** Whether a directory may hold the socket (`privateDir.ts`: the leaf private, every ancestor unchangeable by others) */
export async function dirProblem(dir: string, uid = process.getuid?.()): Promise<string | undefined> {
  return privateDirProblem(dir, uid)
}

const IDENTITY = { login: 'team-socket', deviceId: 'team-socket', via: 'local-hook' } as const

async function handle(router: Router, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://team')
    const m = router.match(req.method ?? 'GET', url.pathname)
    if (!m) {
      json(res, 404, { error: 'not found' })
      return
    }
    const ctx: Ctx = { req, res, url, params: m.params, identity: IDENTITY }
    const result = await m.handler(ctx)
    if (!res.headersSent) json(res, 200, result ?? { ok: true })
  } catch (err) {
    if (res.headersSent) {
      res.destroy()
      return
    }
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.message })
      return
    }
    console.error('[team] unhandled error:', err)
    json(res, 500, { error: 'internal error' })
  }
}

/** Whether something accepts connections on that socket now */
function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(path)
    const timer = setTimeout(() => {
      sock.destroy()
      resolve(true) // a socket that neither refuses nor accepts: treat as taken (never unlink what may be live)
    }, 1000)
    sock.once('connect', () => {
      clearTimeout(timer)
      sock.destroy()
      resolve(true)
    })
    sock.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      // ⚠️ Only a definite "nobody listens" is a leftover (r6 medium #5); any other error: leave it alone
      resolve(err.code !== 'ECONNREFUSED')
    })
  })
}

/**
 * Open the team socket. Never throws: a problem is logged and the teams stay unavailable.
 * @returns the server (to close on shutdown), or undefined
 */
export async function startTeamSocket(dir = stateDir()): Promise<Server | undefined> {
  const warn = (why: string): undefined => {
    console.warn(t(`[team] チームのソケットを開けません（${why}）。/nyan-team は使えません`, `[team] Cannot open the team socket (${why}). /nyan-team is unavailable.`))
    return undefined
  }
  // ⚠️ Bound at the directory's **real** path (r2 high #2): a link on the given path could be swapped after the check
  const checked = privateDirReal(dir)
  if (!checked.ok) return warn(checked.problem)
  const path = teamSocketPath(checked.real)
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH) return warn('path too long')
  // ⚠️ A leftover socket from the last run is removed; anything else at that name is left alone (never unlink a file
  //    we did not make)
  try {
    const st = await lstat(path)
    if (!st.isSocket()) return warn('something else is at the socket path')
    // ⚠️ Another agent (another port, the same state directory) may be listening there: never take its socket away
    //    (codex review r5, medium #5). Only a socket nobody answers on is a leftover.
    if (await answers(path)) return warn('another agent is listening on the team socket')
    await unlink(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return warn(err instanceof Error ? err.message : String(err))
  }
  const router = buildTeamRouter()
  const server = createServer((req, res) => void handle(router, req, res))
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.off('error', reject)
        resolve()
      })
    })
    await chmod(path, 0o600)
  } catch (err) {
    server.close()
    return warn(err instanceof Error ? err.message : String(err))
  }
  // ★ Delegations end on time even if nobody calls (`sweepTeamApprovals`)
  setInterval(() => void sweepTeamsNow().catch(() => undefined), 30_000).unref()
  console.log(t('[team] チームのソケットを開きました', '[team] Team socket open'))
  return server
}
