// ★★ How the "Connections" screen is presented (2026-09-23 / rebuilt per the user's decision).
//
// Policy: **always show only what you check every time (is it connected), fold the rest.**
//   - Each machine: name on line 1, only "route · state" on line 2 (`machineSummary`)
//   - URL, relay entry, switching, unlinking and registered devices appear only when the row is opened
//   - Registered devices are folded **per machine** into that machine's details (looked up by transport position = not by name)
// ⚠️ Decisions live in `.ts` (`.tsx` has no behavioral tests / CLAUDE.md §2).

import { endpointRoute, type AgentEndpoint } from '../endpoints.ts'
import { t } from '../../../shared/i18n.ts'

export interface ProbeView {
  /** ★ `offline` = nothing answered (off / asleep): a state, not an error (2026-09-26) */
  state: 'checking' | 'ok' | 'ng' | 'offline'
  detail?: string
}

/** ★ Route name (⚠️ routes shown to users are "Tailscale / relay". `local` is the name of the mechanism / CLAUDE.md §1) */
export function routeName(e: AgentEndpoint): string {
  return endpointRoute(e) === 'relay' ? t('relay 経由', 'via relay') : t('Tailscale 経由', 'via Tailscale')
}

/**
 * ★ Line 2 (route · state). ⚠️ State is stated **positively** (while unknown, "checking…" = never lets it read as healthy).
 */
export function machineSummary(e: AgentEndpoint, p: ProbeView | undefined): { text: string; tone: 'ok' | 'ng' | 'wait' | 'off' } {
  const route = routeName(e)
  if (p === undefined || p.state === 'checking') return { text: t(`${route} ・ 確認中…`, `${route} · Checking…`), tone: 'wait' }
  if (p.state === 'ok') return { text: t(`${route} ・ 応答あり`, `${route} · Responding`), tone: 'ok' }
  if (p.state === 'offline') return { text: t(`${route} ・ オフライン`, `${route} · Offline`), tone: 'off' }
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
