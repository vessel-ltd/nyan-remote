// ★★ How the "Connections" screen is presented (2026-09-23 / rebuilt per the user's decision).
//
// Policy: **always show only what you check every time (is it connected), fold the rest.**
//   - Each machine: name on line 1, only "route · state" on line 2 (`machineSummary`)
//   - URL, relay entry, switching, unlinking and registered devices appear only when the row is opened
//   - Registered devices are folded **per machine** into that machine's details (looked up by transport position = not by name)
// ⚠️ Decisions live in `.ts` (`.tsx` has no behavioral tests / CLAUDE.md §2).

import { endpointRoute, type AgentEndpoint } from '../endpoints.ts'
import { t } from '../../../shared/i18n.ts'
import { isOurRelay } from '../../../shared/distribution.ts'

export interface ProbeView {
  /**
   * ★ `offline` = nothing answered (off / asleep): a state, not an error (2026-09-26).
   * ★ `free-used` = the relay refused because this phone's free slot is another machine (2026-09-27): a state with a way out
   *   (the "use this machine for free" button, or `nyan login` on the PC)
   */
  state: 'checking' | 'ok' | 'ng' | 'offline' | 'free-used'
  detail?: string
}

/**
 * ★ Route name. ⚠️ The three routes shown to users (CLAUDE.md §1): **our relay / your own relay / Tailscale** (`local` is the name of
 *   the mechanism, never shown). Our relay vs. yours is told by the entrance (`isOurRelay`); yours shows its host.
 */
export function routeName(e: AgentEndpoint): string {
  if (endpointRoute(e) !== 'relay' || !e.relay) return t('Tailscale 経由', 'via Tailscale')
  if (isOurRelay(e.relay.url)) return t('こちらの relay', 'our relay')
  let host = e.relay.url
  try {
    host = new URL(e.relay.url).host
  } catch {
    // ⚠️ Shown as saved (the shape was checked when it was learned)
  }
  return t(`自分の relay（${host}）`, `your relay (${host})`)
}

/** ★ How the route is chosen (one line in the machine details / 2026-09-27: no switch in the app) */
export function routeHint(): string {
  return t(
    '経路は PC の設定で決まります（relay があれば relay、無ければ Tailscale）。変えるときは PC の ~/.nyan-remote/config.json の relayUrl を変えて、QR を読み直します（README の「Hosting the relay」）。',
    'The route is the PC’s setting (its relay if it has one, otherwise Tailscale). To change it, edit relayUrl in ~/.nyan-remote/config.json on the PC and scan its QR code again (see “Hosting the relay” in the README).',
  )
}

/**
 * ★ Line 2 (route · state). ⚠️ State is stated **positively** (while unknown, "checking…" = never lets it read as healthy).
 */
export function machineSummary(e: AgentEndpoint, p: ProbeView | undefined): { text: string; tone: 'ok' | 'ng' | 'wait' | 'off' } {
  const route = routeName(e)
  if (p === undefined || p.state === 'checking') return { text: t(`${route} ・ 確認中…`, `${route} · Checking…`), tone: 'wait' }
  if (p.state === 'ok') return { text: t(`${route} ・ 応答あり`, `${route} · Responding`), tone: 'ok' }
  if (p.state === 'offline') return { text: t(`${route} ・ オフライン`, `${route} · Offline`), tone: 'off' }
  if (p.state === 'free-used') return { text: t(`${route} ・ 無料枠は別のマシン`, `${route} · Free slot: another machine`), tone: 'off' }
  return { text: t(`${route} ・ 応答なし（${p.detail ?? '理由不明'}）`, `${route} · No response (${p.detail ?? 'unknown reason'})`), tone: 'ng' }
}

/** ★ Position of the transport for that endpoint (-1 if none = not yet saved / reloaded) */
export function transportIndex(e: AgentEndpoint, transports: readonly { endpoint: { id: string } }[]): number {
  return transports.findIndex((t) => t.endpoint.id === e.id)
}

/**
 * ★ Whether "+ Add machine" starts open.
 * ⚠️⚠️ **Zero machines is a normal initial state** (public origin / CLAUDE.md §2). Closed, it looks like **you can connect to nothing**.
 * ⚠️ Also open when this device's key is broken (the way to fix it is inside).
 */
export function openAddByDefault(count: number, identityBroken: boolean): boolean {
  return count === 0 || identityBroken
}
