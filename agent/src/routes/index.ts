import { attach } from '../events.ts'
import { Router } from '../router.ts'
import { serveStatic } from '../static.ts'
import { health } from './health.ts'
import { refreshAccountNow } from '../account.ts'
import { sessionAutoApprove } from './autoApprove.ts'
import { hook } from './hook.ts'
import { sessionCommand } from './command.ts'
import { sessionClear, sessionInterrupt } from './interrupt.ts'
import { sessionMessage } from './message.ts'
import { deviceRevoke, devicesList, pairDevice, pairToken, pairTokenCancel, pairTokenStatus } from './devices.ts'
import { deviceHandshake } from './handshake.ts'
import { peers } from './peers.ts'
import { permissionAnswer, permissionRequest, permissions } from './permission.ts'
import { pushStatus, pushSubscribe, pushTest, pushUnsubscribe } from './push.ts'
import { sessionFollow, sessionLog, sessions } from './sessions.ts'

export function buildRouter(): Router {
  const router = new Router()

  router.get('/health', health)
  // ★ Refetch the license right now (`nyan account` / 2026-09-24). ⚠️ This machine only (`isLocalOnlyPath` in `auth.ts`)
  router.post('/account/refresh', () => refreshAccountNow())
  router.get('/sessions', sessions)
  router.get('/sessions/:id/log', sessionLog)
  // ★★ Follow a thread via notifications (⚠️ only devices viewing that session open it / 2026-09-23)
  router.get('/sessions/:id/follow', sessionFollow)
  // ★ Send an instruction from the phone (M4-2). It is an internal feature, so it is isolated in inbox.ts
  router.post('/sessions/:id/message', sessionMessage)
  // ★ "Stop" (ESC). ⚠️ **POST only** (with GET, merely getting someone to follow a link could stop it).
  //   ⚠️⚠️ Takes no body (the bytes sent are fixed in an agent-side table / routes/interrupt.ts)
  router.post('/sessions/:id/interrupt', sessionInterrupt)
  // ★ Clear the PC's input box (Ctrl-U). ⚠️ Takes no body (the key sent is fixed in the handler)
  //   ⚠️⚠️ The endpoints are separate so there is no "endpoint that can fire anything in the table"
  router.post('/sessions/:id/clear', sessionClear)
  // ★ Slash commands from the table (`/compact` / `/exit`). ⚠️ Only the **id** is taken from the body.
  //   ⚠️⚠️ Free text never runs them (`/` `!` become plain text with one leading space / routes/command.ts)
  router.post('/sessions/:id/command', sessionCommand)
  // ★ Toggle auto-approve mode (per session, with an expiry / autoApprove.ts).
  //   ⚠️⚠️ **POST only** (with GET, merely getting someone to follow a link could enable auto-approve)
  router.post('/sessions/:id/auto-approve', sessionAutoApprove)
  router.post('/hook', hook)

  router.get('/peers', peers)

  // ★★ The device key for ③ (ARCHITECTURE §14.1.2.5 / routes/devices.ts).
  //   ⚠️⚠️ **Registration and revocation are POST only** (with GET, following a link could add / remove a device).
  //   ⚠️⚠️ `/pair/token` is **this machine only** via `isLocalOnlyPath` in `auth.ts`
  //      (issuing over the network would break "registration requires the PC's screen").
  router.get('/devices', devicesList)
  router.post('/pair/token', pairToken)
  // ★★ Status and cancellation of an issued one-time token (`npm run pair` / 2026-09-23).
  //   ⚠️⚠️ **Both are this machine only** (added to `isLocalOnlyPath` in `auth.ts` in the same shape)
  router.get('/pair/token/:id', pairTokenStatus)
  router.post('/pair/token/:id/cancel', pairTokenCancel)
  router.post('/pair', pairDevice)
  router.post('/devices/revoke', deviceRevoke)
  // ★★ Handshake (exactly the first message of the step-6 tunnel). ⚠️ POST only (the body carries the first message)
  router.post('/handshake', deviceHandshake)

  // ★ Pending approvals (M4-1). /permission is hit by Claude Code's PermissionRequest hook
  //    with type:"http", which **waits without a response** (read the explanation in routes/permission.ts)
  router.post('/permission', permissionRequest)
  router.get('/permissions', permissions)
  router.post('/permission/answer', permissionAnswer)

  router.get('/push/status', pushStatus)
  router.post('/push/subscribe', pushSubscribe)
  router.post('/push/unsubscribe', pushUnsubscribe)
  router.post('/push/test', pushTest)
  router.get('/events', (ctx) => {
    attach(ctx.res)
    return undefined // attach keeps holding the response
  })

  // ★ Serving the PWA itself (= X. ARCHITECTURE.md §14.3)
  // "The agent itself can serve it" is what backs Y's reliability, so this must not be removed.
  router.fallback = serveStatic

  return router
}
