// ③ stage 6 step ④: **open this agent's single relay link** (startup wiring).
//
// ★ Only two jobs:
//   ① look at the config (`relayUrl` in `config.json`) and, if usable, start `keepRelayConnected`
//   ② return the current status in a form `/health` can show (`RelayHealth`)
//
// ⚠️⚠️ **Do not stop the agent when it is unusable** (same treatment as `deviceKey.ts`).
//    Without a relay, the `local` (Tailscale) route keeps working as before.
//    ⇒ Not "503 for every request" like config.json. **Keep the reason** (log and `/health`).
//
// ⚠️ **Do not use "connected" as a flag for decisions on the screen** (§14.1.2.28):
//    the relay returns pong even with no agent, and the PWA judges by **its own link**.

import { isRelayBase } from '../../shared/relayFrame.ts'
import type { RelayHealth } from '../../shared/types.ts'
import { t } from '../../shared/i18n.ts'
import { config } from './config.ts'
import { agentKeyProblem } from './deviceKey.ts'
import { keepRelayConnected, type RelayKeeper } from './relayLink.ts'
import { accountLicensing } from './account.ts'
import type { Router } from './router.ts'

/** ⚠️ Only one (even in a symmetric mesh there is one agent / §7) */
let keeper: RelayKeeper | undefined
/** ⚠️ Why it could not be opened (= `lastError` of `state: 'off'`) */
let problem: (() => string) | undefined

/**
 * Looks at the config and opens the link. **If it cannot, it keeps the reason and does nothing.**
 *
 * @returns `true` if opened
 */
export function startRelay(
  router: Router,
  /**
   * ⚠️ How to open the link (**for tests**; defaults to a real WebSocket).
   * ⚠️⚠️ 2026-09-24: the "connects to the default relay" test **connected to the real production relay every run** (one more room per throwaway key)
   *    ⇒ tests pass a fake. **Tests never touch production**.
   */
  connect?: Parameters<typeof keepRelayConnected>[0]['connect'],
): boolean {
  stopRelaySync()
  problem = undefined
  const base = config().relayUrl
  if (base === undefined || base === '') {
    // ★ not configured = `local` only (a normal state; no reason needed)
    return false
  }
  if (!isRelayBase(base)) {
    // ⚠️ wrong shape (must be `ws://` or `wss://`, with no query or credentials)
    // ★ kept as a function (so it is rendered in the language of the request that read `/health`, not frozen at startup)
    problem = () =>
      t(
        'relayUrl の形が違います（ws:// か wss:// / クエリと認証情報は付けない）',
        'relayUrl has the wrong form (use ws:// or wss://, with no query or credentials).',
      )
    console.warn(t(`[relay] 線を立てません: ${problem()}`, `[relay] Not opening the relay link: ${problem()}`))
    return false
  }
  // ⚠️⚠️ without a usable agent key it **cannot identify itself** (`connectRelay` throws) ⇒ refuse first
  const keyProblem = agentKeyProblem()
  if (keyProblem) {
    // ★ re-evaluated on every read (`agentKeyProblem` returns the reason in the reading request's language)
    problem = () => {
      const why = agentKeyProblem() ?? keyProblem
      return t(`agent の鍵が使えません（${why}）`, `The agent key is unusable (${why}).`)
    }
    console.warn(t(`[relay] 線を立てません: ${problem()}`, `[relay] Not opening the relay link: ${problem()}`))
    return false
  }
  keeper = keepRelayConnected({
    base,
    router,
    ...(connect ? { connect } : {}),
    // ★ hand the license to the relay (2026-09-24 / billing). ⚠️ without an account there is simply nothing to send (as before)
    licensing: accountLicensing,
    onStatus: (s) => {
      // ⚠️ **always log** that it dropped (silently not connecting is the worst)
      if (s.state === 'open') console.log(t(`[relay] 繋がりました: ${base}`, `[relay] Connected: ${base}`))
      else if (s.state === 'waiting') {
        const sec = Math.round((s.waitMs ?? 0) / 1000)
        console.warn(t(`[relay] ${sec}秒後に繋ぎ直します: ${s.lastError ?? ''}`, `[relay] Reconnecting in ${sec}s: ${s.lastError ?? ''}`))
      }
    },
  })
  console.log(t(`[relay] 線を張ります: ${base}`, `[relay] Opening the relay link: ${base}`))
  return true
}

/** ⚠️ Stopped **only on exit** (if it drops, the watcher reconnects) */
export async function stopRelay(reason = t('終了します', 'Shutting down')): Promise<void> {
  const k = keeper
  keeper = undefined
  await k?.stop(reason)
}

function stopRelaySync(): void {
  const k = keeper
  keeper = undefined
  // ⚠️ do not wait when restarting (the caller is synchronous). ⚠️ continue even on failure
  void k?.stop(t('立て直します', 'Restarting')).catch(() => undefined)
}

/** ★ Status shown in `/health` (⚠️ for diagnostics; not used for decisions) */
export function relayHealth(): RelayHealth {
  const s = keeper?.status
  if (!s) {
    return { state: 'off', attempts: 0, ...(problem === undefined ? {} : { lastError: problem() }) }
  }
  return {
    state: s.state,
    attempts: s.attempts,
    ...(s.lastError === undefined ? {} : { lastError: s.lastError }),
  }
}

/** ⚠️ For tests (same shape as `resetDevices` / `resetAgentKey`) */
export function resetRelay(): void {
  stopRelaySync()
  problem = undefined
}
