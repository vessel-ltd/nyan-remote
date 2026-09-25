// ★ Before showing a pairing QR: would the phone be refused? (2026-09-25)
//
// ★ Our relay requires `nyan login` since 2026-09-25. The phone pairs **only** over the relay when the QR carries one
//   (it never falls back to the weaker local route), so without sign-in the pairing fails on the phone with a vague
//   "cannot reach the relay". ⇒ Stop before showing the QR and say what to do.
// ⚠️⚠️ Stop only when it is certain: the QR's relay is ours **and** the agent says it is signed out (`signedIn === false`).
//    An old agent without `account` in `/health`, an unreadable reply, or a self-hosted relay ⇒ carry on as before.
import { isOurRelay } from '../../shared/distribution.ts'
import { parsePairUrl } from '../../shared/pairing.ts'

/** ★ Does the QR carry our relay? (⇒ only then is it worth asking the agent about sign-in) */
export function carriesOurRelay(pairUrl) {
  const p = typeof pairUrl === 'string' ? parsePairUrl(pairUrl) : undefined
  return p !== undefined && isOurRelay(p.relayUrl)
}

/** @param {{ pairUrl: unknown, account: unknown }} o */
export function mustSignIn(o) {
  // ★ Read it with the phone's own parser (one reader for the QR / `shared/pairing.ts`)
  if (!carriesOurRelay(o.pairUrl)) return false
  const a = o.account
  return typeof a === 'object' && a !== null && /** @type {{ signedIn?: unknown }} */ (a).signedIn === false
}
