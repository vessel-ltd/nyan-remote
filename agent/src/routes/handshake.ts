// The device-key handshake endpoint (`POST /handshake` / ARCHITECTURE §14.1.2.17).
//
// ★★ **This is exactly the first message of step 6 (the relay / local tunnel).** For now it is
//   also used to check that the crypto works in a browser (⚠️ it had only ever run on Node).
//
// ⚠️⚠️ **The resulting session is discarded here** (step 6 keeps it for round trips).
//   ⇒ The current use is only to check the handshake succeeds. **Since it is discarded, the key has no lifetime.**
//
// ★ Authentication goes through the single place in index.ts (`auth.ts`). **Do not look at identity headers here** (discipline 3).
//   ⚠️ The handshake itself is checked by `authorizeDevice` (`devices.json`) = **if not registered,
//      it refuses without deriving keys**. So this endpoint is "an authenticated person tries it on their own device".

import { fromBase64Url, toBase64Url } from '../../../shared/crypto.ts'
import type { HandshakeResult } from '../../../shared/types.ts'
import { acceptDeviceHandshake } from '../auth.ts'
import { HttpError, readJsonBody } from '../router.ts'
import { t } from '../../../shared/i18n.ts'

export async function deviceHandshake(ctx: {
  req: import('node:http').IncomingMessage
}): Promise<HandshakeResult> {
  const body = await readJsonBody<{ init?: unknown }>(ctx.req)
  const init = typeof body.init === 'string' ? body.init : ''
  if (!init) throw new HttpError(400, t('init（1通目の base64url）が必要です', '`init` (the first message, base64url) is required.'))
  let bytes: Uint8Array
  try {
    bytes = fromBase64Url(init)
  } catch {
    throw new HttpError(400, t('init が base64url として読めません', '`init` is not valid base64url.'))
  }

  try {
    const h = await acceptDeviceHandshake(bytes)
    return {
      ok: true,
      // ⚠️⚠️ **Send in this order** (the `acceptHandshake` contract / §14.1.2.6).
      //    An HTTP response is a single message, so order is preserved.
      reply: toBase64Url(h.reply),
      confirm: toBase64Url(h.confirm),
      deviceId: h.connection.deviceId,
    }
  } catch (err) {
    // ⚠️ Return the reason as is ("not registered", "record is corrupt", "key unusable" are
    //    **all fixable by the user**). ⚠️ No absolute paths are included (category only / CLAUDE.md §2).
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}
