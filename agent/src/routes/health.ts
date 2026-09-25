import { toBase64Url } from '../../../shared/crypto.ts'
import { agentKeyProblem, agentPublicRaw } from '../deviceKey.ts'
import { relayHealth } from '../relayRun.ts'
import { hostname } from 'node:os'
import type { AgentFeature, AgentHealth } from '../../../shared/types.ts'
import { AGENT_VERSION, agentBuild } from '../version.ts'
import { accountHealth } from '../account.ts'
import { config } from '../config.ts'
import { devMode } from '../auth.ts'
import { discoverConfigDirs } from '../claude/configDirs.ts'
import { describeAccounts } from '../claude/sessions.ts'

/**
 * ★★ Features this agent has. **When you add an endpoint, add it here too.**
 *
 * ⚠️⚠️ The UI looks at this to decide which buttons to show (`web/src/ui/commands.ts`). Forget to add it and
 *    **the new endpoint exists but no button appears** (conversely, forget to remove it and a button that 404s appears).
 * ★ `agent/src/routes/routes.test.ts` checks that registered endpoints and feature flags correspond.
 */
export const AGENT_FEATURES: AgentFeature[] = [
  'slash-commands',
  'clear-input',
  'auto-approve',
  // ★ The device-key endpoints for ③ (`GET /devices` / `POST /pair` / `POST /devices/revoke`).
  //   ⚠️ The UI does not offer pairing on an agent without this flag (fail-closed / CLAUDE.md §2)
  'device-pairing',
  // ★ The handshake endpoint. ⚠️ **Kept separate from `device-pairing`** (an agent may support
  //   registration without the handshake = sharing one flag would make "verify connection" 404)
  'device-handshake',
  // ★ Endpoint for following a thread via notifications (`GET /sessions/:id/follow`). ⚠️ Agents without it get 3-second polling
  'log-follow',
  // ★ 24 hours can be chosen as the auto-approve duration (`AUTO_APPROVE_DURATIONS` in `autoApprove.ts`)
  'auto-approve-24h',
]

export async function health(): Promise<AgentHealth> {
  const cfg = config()
  const dirs = await discoverConfigDirs(cfg.configDirs)
  return {
    machine: hostname(),
    agentVersion: AGENT_VERSION,
    nodeVersion: process.version,
    uptimeSec: Math.round(process.uptime()),
    devMode: devMode(),
    accounts: await describeAccounts(dirs),
    features: AGENT_FEATURES,
    // ★ The device key for ③. ⚠️ **Omitted** when unusable (the PWA then fails to match and
    //   says "the machine that showed this QR is not among your endpoints" = never send to a false destination)
    ...(agentKeyProblem() ? {} : { agentPublicKey: toBase64Url(agentPublicRaw()) }),
    // ★ State of the relay link (③ step 6 / ⚠️ **for diagnostics only**; never used for decisions / §14.1.2.28)
    relay: relayHealth(),
    // ★ This agent's build (the UI shows "outdated, run nyan update" / `shared/release.ts`). ⚠️ Omitted when unknown
    ...(agentBuild() ? { build: agentBuild() } : {}),
    // ★ Account and plan (⚠️ never exposes the passphrase or the license itself)
    account: accountHealth(),
  }
}
