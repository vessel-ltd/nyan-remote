// ★ Files from the phone (2026-11-17 / `agent/src/uploads.ts` holds every rule; this file only connects the endpoints).
//   ⚠️ Authentication is the one place in `auth.ts` (discipline 3); the device identity binds an upload to its phone.
//   ⚠️ POST only (CSRF: a JSON body forces the preflight / `readJsonBody`).

import { ownerOf } from '../auth.ts'
import { HttpError, readJsonBody, type Ctx } from '../router.ts'
import { UploadError, uploads, type UploadStore } from '../uploads.ts'
import type { UploadFinishResult, UploadStartResult } from '../../../shared/types.ts'

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    // ⚠️ Our own refusals keep their status and text; anything else is a plain 500 (no paths or file system errors out)
    if (e instanceof UploadError) throw new HttpError(e.status, e.message)
    console.log(`[uploads] failed: ${e instanceof Error ? (e as NodeJS.ErrnoException).code ?? e.name : 'error'}`)
    throw new HttpError(500, 'upload failed')
  }
}

export function uploadRoutes(store: UploadStore = uploads) {
  return {
    async start(ctx: Ctx): Promise<UploadStartResult> {
      const body = await readJsonBody<{ name?: unknown; size?: unknown; sha256?: unknown }>(ctx.req)
      return guarded(() => store.start(ownerOf(ctx.identity), body))
    },
    async chunk(ctx: Ctx): Promise<{ received: number }> {
      const body = await readJsonBody<{ offset?: unknown; data?: unknown }>(ctx.req)
      return guarded(() => store.chunk(ownerOf(ctx.identity), ctx.params['id'] ?? '', body))
    },
    async finish(ctx: Ctx): Promise<UploadFinishResult> {
      await readJsonBody(ctx.req)
      return guarded(() => store.finish(ownerOf(ctx.identity), ctx.params['id'] ?? ''))
    },
    async cancel(ctx: Ctx): Promise<{ ok: true }> {
      await readJsonBody(ctx.req)
      return guarded(() => store.cancel(ownerOf(ctx.identity), ctx.params['id'] ?? ''))
    },
  }
}
