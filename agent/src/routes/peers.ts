import type { PeersResult } from '../../../shared/types.ts'
import { tailnetStatus } from '../tailscale.ts'

/**
 * Returns the nodes on the same tailnet. These become candidates for "add endpoint" in the PWA.
 *
 * ⚠️ This does not hit each peer's /health. MagicDNS cannot be resolved from WSL, so it would
 *    need IP + SNI, which makes the implementation heavy. Reachability checks are left to the
 *    phone side (PWA), where MagicDNS works.
 */
export async function peers(): Promise<PeersResult> {
  return tailnetStatus()
}
