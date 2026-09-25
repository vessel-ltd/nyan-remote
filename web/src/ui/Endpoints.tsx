import { useEffect, useRef, useState } from 'preact/hooks'
import { ACCOUNT_ORIGIN } from '../../../shared/distribution.ts'
import { planRows } from './plan.ts'
import type { PeerCandidate } from '../../../shared/types.ts'
import {
  canSwitchRoute,
  endpointRoute,
  loadEndpoints,
  mergeAdded,
  mergeRelay,
  saveEndpoints,
  selfCandidate,
  setRouteIn,
  shouldOfferManualUrl,
  staleTwins,
  type AgentEndpoint,
} from '../endpoints.ts'
import { reloadAtList } from '../route.ts'
import { probeEndpoint, probeUrl, type Transport } from '../transport/index.ts'
import { machineSummary, openAddByDefault, transportIndex } from './connections.ts'
import { t } from '../../../shared/i18n.ts'
import { chooseLang, savedLangChoice, type LangChoice } from '../lang.ts'
import { asThemeChoice, chooseTheme, savedThemeChoice } from '../theme.ts'
import { MachineDevices, Pairing, usePairing } from './Pairing.tsx'
import { PushPanel } from './PushPanel.tsx'
import { type UnlinkOutcome, unlinkText } from './pairRun.ts'
import { staleTwinText } from './pairing.ts'

/**
 * ★ **The raw text stored** in `localStorage` (⚠️ not parsed or formatted / codex round 5, low #1).
 *
 * ⚠️⚠️ Do not `JSON.parse` here (**the brokenness itself is what we want to see**).
 * ⚠️ The key name matches the one in `endpoints.ts` (⚠️ changing it silently empties the diagnostics).
 */
function rawEndpoints(): string {
  try {
    return localStorage.getItem('tmux-agent.endpoints.v1') ?? t('（保存されていません）', '(not saved)')
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    return t(`（読めません: ${why}）`, `(cannot read: ${why})`)
  }
}

interface Probe {
  state: 'checking' | 'ok' | 'ng'
  detail?: string
  /** Machine name of the agent that responded. Used to absorb label spelling variations */
  machine?: string
}

/**
 * Management of connection agents (M3).
 *
 * ★ Discipline 1: connections are "data". Our own origin is just one candidate.
 *    What is added here goes into localStorage, and from then on the list shows them merged.
 *
 * Candidates come from each agent's /peers (= tailscale status).
 * ⚠️ Reachability is checked here (in the browser). The agent doesn't probe peers because
 *    MagicDNS can't be resolved from WSL (see the comment in agent/src/tailscale.ts).
 */
export function Endpoints({
  transports,
  onBack,
  rememberRelay,
  addEndpoint,
  endpoints,
  unlink,
  forget,
  accounts,
}: {
  transports: Transport[]
  onBack: () => void
  /** ★ The current list held by the parent (⚠️ pairing **adds relay entry points**) */
  endpoints?: readonly AgentEndpoint[]
  /** ★ Remembers the relay entry point that was in the QR during pairing (③ stage 6, step ④) */
  rememberRelay?: (at: number, relay: { url: string; agentPublicKey: string }) => void
  /** ★ Adds an unknown connection from the QR's `u` (2026-09-16 / Y) */
  addEndpoint?: (e: {
    url: string
    label: string
    relay?: { url: string; agentPublicKey: string }
    /** ★ The route the registration went through (⚠️ never guessed / codex round 8, medium #2) */
    kind?: 'local' | 'relay'
  }) => void
  /**
   * ★★ **Unlinking** (2026-09-21). Revoke → remove the connection, in a single action.
   *
   * ⚠️⚠️ **Required** (falling back to "remove locally only" when omitted leaves a branch
   *    nobody takes, **which tests can't kill**, and gives the prop two meanings).
   * ★ The procedure itself is `runUnlink` in `pairRun.ts` (not assembled in `.tsx` / discipline).
   */
  unlink: (e: AgentEndpoint) => Promise<UnlinkOutcome>
  /**
   * ★ **Only removes** from the list (sends no revocation / 2026-09-24). Used for a stale connection to the same machine whose key was recreated.
   * ⚠️ Revoking would also remove the current registration, since the device key is the same (`staleTwinText`).
   */
  forget: (e: AgentEndpoint) => void
  /** ★ Account status per machine (`account` in `/health` / billing / `ui/plan.ts`). ⚠️ Optional (list not fetched yet) */
  accounts?: readonly { name: string; account: unknown }[]
}) {
  const [list, setList] = useState<AgentEndpoint[]>(loadEndpoints)
  const [candidates, setCandidates] = useState<PeerCandidate[]>([])
  const [probes, setProbes] = useState<Record<string, Probe>>({})
  const [manual, setManual] = useState('')
  const [msg, setMsg] = useState<string>()
  const [dirty, setDirty] = useState(false)
  /** ★ Unlink confirmation (two taps. ⚠️ because the cost is "re-pairing") */
  const [confirmUnlink, setConfirmUnlink] = useState<string>()
  const [unlinking, setUnlinking] = useState(false)
  /** ★ Theme choice (⚠️ saving is in `theme.ts`; this only drives the select) */
  const [theme, setTheme] = useState(savedThemeChoice)
  /** ★ Whether an agent is on our own origin (⚠️ `undefined` while unknown = not shown) */
  const [selfProbe, setSelfProbe] = useState<{ ok: boolean }>()
  useEffect(() => {
    void (async () => setSelfProbe(await probeUrl(selfCandidate().url)))()
  }, [])

  // ★ Pairing state (used by both "add" and the machine details / `Pairing.tsx`)
  const pairing = usePairing({ transports, rememberRelay, addEndpoint })
  /** ★ The machine whose details are open (only one) */
  const [openId, setOpenId] = useState<string>()
  /** ★ Whether "+ Add machine" is open (⚠️ `undefined` = not touched yet = follow the default) */
  const [addOpen, setAddOpen] = useState<boolean>()
  const [diagOpen, setDiagOpen] = useState(false)
  const [copied, setCopied] = useState<string>()

  // ★★ **Merge relay entry points learned via pairing into the list being edited too** (codex round 4, medium #9).
  //   ⚠️⚠️ Without this, pairing with the screen open → saving as-is **loses the learned entry point**.
  // ★★ **Also add newly appearing connections** (codex round 15, medium #4 / `mergeAdded`). ⚠️ Unlinked ones are not brought back.
  const seenFresh = useRef<readonly AgentEndpoint[]>(endpoints ?? [])
  useEffect(() => {
    if (!endpoints) return
    const prevFresh = seenFresh.current
    seenFresh.current = endpoints
    setList((prev) => [...mergeAdded(mergeRelay(prev, endpoints), prevFresh, endpoints)])
    // ★ Show status for the new ones (don't leave them stuck at "checking…")
    const before = new Set(prevFresh.map((e) => e.id))
    for (const e of endpoints) if (!before.has(e.id)) void probe(e)
  }, [endpoints])

  // Collect candidates (several agents see the same tailnet, so dedupe)
  // ★★ **Only when we serve the PWA ourselves (an agent is on our own origin)** (2026-09-23 / user decision).
  //   ⚠️⚠️ On the public origin (Y), a connection added from candidates with only a Tailscale URL is **always "❌ no response"**
  //      (the public origin does not talk HTTP to agents / CORS auto-allow was removed on 2026-09-18).
  //   ⇒ Gated by the same single check as "enter URL directly" (`shouldOfferManualUrl`).
  const offerTailnet = shouldOfferManualUrl(selfProbe)
  useEffect(() => {
    if (!offerTailnet) return
    void (async () => {
      const seen = new Map<string, PeerCandidate>()
      for (const tr of transports) {
        try {
          const res = await tr.listPeers()
          if (!res.available) {
            setMsg(res.reason ?? t('tailscale の情報が取れませんでした', 'Could not get Tailscale info'))
            continue
          }
          for (const p of res.peers) if (!seen.has(p.url)) seen.set(p.url, p)
        } catch {
          // That machine is just down
        }
      }
      setCandidates([...seen.values()])
    })()
  }, [offerTailnet])

  // ★ Reachability goes through the transport layer (discipline 2). It used to fetch directly here
  //
  // ⚠️⚠️ **Check over the route currently in use** (2026-09-16). `probeUrl` always hits the local URL,
  //    so a connection switched to relay was **always "❌ no response" away from home**,
  //    **looking broken while working** (hit in the field). Decided in one place, `probeEndpoint`.
  const probe = async (e: AgentEndpoint) => {
    // ⚠️⚠️ Key by **id** (not URL): relay-only connections have an empty URL, so two of them would mix results
    //    (old and new entries for the same machine with a recreated key both look "responding" / found while investigating codex round 18, medium #4)
    setProbes((p) => ({ ...p, [e.id]: { state: 'checking' } }))
    const res = await probeEndpoint(e, transports)
    setProbes((p) => ({
      ...p,
      [e.id]: res.ok
        ? { state: 'ok', machine: res.machine, detail: res.machine }
        : { state: 'ng', detail: res.detail },
    }))
  }

  // ★ Registered connections show their status automatically on open.
  //
  // ⚠️ Previously nothing showed until "Check" was pressed, so **down machines
  //    just sat in the list** and read as "both are connected"
  //    (actually misread on 2026-08-12). Show health before being asked.
  useEffect(() => {
    for (const e of list) void probe(e)
  }, [])

  const add = (url: string, label: string) => {
    const clean = url.replace(/\/+$/, '')
    if (!clean) return
    if (list.some((e) => e.url === clean)) {
      setMsg(t('すでに追加されています', 'Already added'))
      return
    }
    const added: AgentEndpoint = { id: clean, url: clean, label }
    setList([...list, added])
    setDirty(true)
    setMsg(undefined)
    void probe(added)
  }

  /**
   * ★ Switch the route (③ stage 6, step ④).
   *
   * ⚠️ The input (relay entry point) is learned during pairing = **it cannot be added here**
   *    (the QR is an out-of-band authenticated channel; never let the entry point be typed in the UI).
   */
  const setRoute = (id: string, kind: 'local' | 'relay') => {
    // ⚠️⚠️ **The decision lives inside `setRouteIn`** (never switches to a route without inputs / fail-closed).
    //    Do not add an `if (…)` here = the guard would exist in two places.
    setList([...setRouteIn(list, id, kind)])
    setDirty(true)
  }

  /**
   * ★★ Unlink a connection (2026-09-21).
   *
   * ⚠️⚠️ Made **immediate, without going through "Save"**. Originally "removal takes effect only on save = can be undone",
   *   but that was decided **when only local operations existed**. Once revocation to the other side is involved,
   *   "does it go out on delete or on save" becomes ambiguous, and **"can be undone" becomes a lie**.
   *   (CLAUDE.md: "when a premise changes, go find the guards built on top of it")
   * ⚠️ Saving itself (URL or name edits) still goes `dirty` → "Save" as before.
   */
  const doUnlink = async (e: AgentEndpoint) => {
    setConfirmUnlink(undefined)
    setUnlinking(true)
    try {
      const out = await unlink(e)
      // ⚠️ Storage (localStorage) is cleared by `runUnlink`'s `forget`, so only the view is updated here
      setList((l) => l.filter((x) => x.id !== e.id))
      setMsg(unlinkText(out))
    } finally {
      setUnlinking(false)
    }
  }

  const apply = () => {
    saveEndpoints(list)
    // transports are created at startup, so reload to make sure changes apply.
    // ⚠️ Go down to the list without pushing history, then reload (reason in route.ts)
    reloadAtList()
  }

  const notAdded = candidates.filter((c) => !list.some((e) => e.url === c.url))
  const showAdd = addOpen ?? openAddByDefault(list.length, pairing.identity !== undefined && pairing.identity.kind !== 'ok')

  /** ★ Copy the diagnostics (⚠️ meant to be pasted to us / contains no secrets: only URLs, public keys and routes) */
  const copyDiag = async () => {
    const text = [
      t(`版: ${__BUILD_ID__}`, `Version: ${__BUILD_ID__}`),
      t(`保存されている接続先（生）: ${rawEndpoints()}`, `Saved connections (raw): ${rawEndpoints()}`),
      t(`読み込んだ結果: ${JSON.stringify(loadEndpoints())}`, `Loaded result: ${JSON.stringify(loadEndpoints())}`),
    ].join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(t('コピーしました', 'Copied'))
    } catch {
      setCopied(t('コピーできませんでした（長押しで選んでください）', 'Could not copy (long-press to select it)'))
    }
  }

  return (
    <>
      <header class="top">
        <button class="plain" onClick={onBack}>
          {t('← 一覧', '← List')}
        </button>
        {/* ★ 2026-09-24: "Connections" → "Settings" (connections, notifications, display, version and diagnostics) */}
        <h1>{t('設定', 'Settings')}</h1>
        <span class="grow" />
        {dirty ? (
          /* ★★ **Not pressable while waiting for the unlink response** (2026-09-21 / codex medium #4).
             ⚠️⚠️ Saving here writes back **the list being edited, including the row not yet removed**,
                and reloads, so `runUnlink`'s `forget()` never runs and
                **the connection remains even though it's revoked on the other side** (= the one-sided state comes back). */
          <button class="plain" onClick={apply} disabled={unlinking}>
            {t('保存して再読み込み', 'Save and reload')}
          </button>
        ) : null}
      </header>

      {/* ⚠️ Things like broken machine-side records go **at the top** (collapsed, nobody notices / recovery is urgent) */}
      {pairing.trouble ? <p class="notice">⚠️ {pairing.trouble}</p> : null}
      {/* ★★ Messages (e.g. unlink results). ⚠️⚠️ Never put them where they can be hidden (the unlink result would vanish / 2026-09-21) */}
      {msg ? <p class="notice">{msg}</p> : null}

      <section class="group">
        <h2>
          {t(`接続先 ${list.length}台`, `Connections ${list.length}`)}
          <span class="grow" />
          <button class="plain tiny" onClick={() => setAddOpen(!showAdd)}>
            {showAdd ? t('閉じる', 'Close') : t('＋ マシンを追加', '+ Add machine')}
          </button>
        </h2>
        {/* ★ "+ Add machine" (pairing). ⚠️ Shows nothing when only agents without the feature flag exist (fail-closed) */}
        {showAdd ? <Pairing state={pairing} /> : null}
        {/* ★★ Stale connection to the same machine whose key was recreated (⚠️ not removed automatically = a different machine may share the name) */}
        {pairing.lastPaired
          ? staleTwins(list, pairing.lastPaired, (e) => probes[e.id]?.state).map((e) => (
              <div class="pushmsg" key={`twin:${e.id}`}>
                {staleTwinText(e.label, e.relay?.agentPublicKey ?? '')}{' '}
                <button
                  class="plain tiny"
                  onClick={() => {
                    forget(e)
                    setList((l) => l.filter((x) => x.id !== e.id))
                  }}
                >
                  {t('古い方を一覧から消す', 'Remove the old one from the list')}
                </button>
              </div>
            ))
          : null}

        <ul class="sessions">
          {list.map((e) => {
            const p = probes[e.id]
            const sum = machineSummary(e, p)
            const open = openId === e.id
            const at = transportIndex(e, transports)
            return (
              <li key={e.id}>
                {/* ★★ Line 1 is the name, line 2 only "route and status" (2026-09-23 / user decision).
                    ⚠️ The whole row is the toggle button (don't make people aim at a small arrow) */}
                <button class="machine" aria-expanded={open} onClick={() => setOpenId(open ? undefined : e.id)}>
                  <span class={`dot ${sum.tone}`} aria-hidden="true" />
                  <span class="body">
                    {/* ★ Prefer the machine name reported by the agent (saved labels vary in spelling by route) */}
                    <span class="title">{p?.machine ?? e.label}</span>
                    <span class="sub">{sum.text}</span>
                  </span>
                  <span class="chev" aria-hidden="true">
                    {open ? '▾' : '›'}
                  </span>
                </button>
                {open ? (
                  <div class="machinedetail">
                    {e.relay ? (
                      <div class="pushmsg first">
                        relay: <code>{e.relay.url}</code>
                      </div>
                    ) : null}
                    {e.url ? (
                      <div class="pushmsg">
                        Tailscale: <code>{e.url}</code>
                      </div>
                    ) : null}
                    <div class="pushrow">
                      {/* ⚠️⚠️ **Only when both inputs are present** (fail-closed / `canSwitchRoute`).
                          ⚠️ Do not write the condition back here (decided in one place in `endpoints.ts`). */}
                      {canSwitchRoute(e) ? (
                        <button
                          class="plain"
                          onClick={() => setRoute(e.id, endpointRoute(e) === 'relay' ? 'local' : 'relay')}
                        >
                          {endpointRoute(e) === 'relay'
                            ? t('Tailscale に切り替え', 'Switch to Tailscale')
                            : t('relay に切り替え', 'Switch to relay')}
                        </button>
                      ) : null}
                      {/* ★★ **Even the last one can be removed** (2026-09-19). ⚠️⚠️ **Pressable even when the other side is down**
                          (which is why the "disconnect" entry point was consolidated **here only** / 2026-09-21). */}
                      {confirmUnlink === e.id ? (
                        <button class="plain danger" disabled={unlinking} onClick={() => void doUnlink(e)}>
                          {t('本当に解除（相手側の登録も消します）', 'Really unlink (also removes the registration on the other side)')}
                        </button>
                      ) : (
                        <button class="plain" disabled={unlinking} onClick={() => setConfirmUnlink(e.id)}>
                          {t('接続を解除', 'Unlink')}
                        </button>
                      )}
                    </div>
                    {at >= 0 ? (
                      <MachineDevices state={pairing} at={at} onProbe={() => void probe(e)} />
                    ) : (
                      <div class="pushrow">
                        <button class="plain" onClick={() => void probe(e)}>
                          {t('確認', 'Check')}
                        </button>
                        <span class="pushmsg">
                          {t(
                            '保存して再読み込みすると、登録されている端末も出ます',
                            'Save and reload to also see the registered devices',
                          )}
                        </span>
                      </div>
                    )}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      </section>

      {/* ★★ Tailscale candidates and direct URL entry appear **only when we serve the PWA ourselves** (`offerTailnet`). */}
      {offerTailnet ? (
        <section class="group">
          <h2>{t(`Tailscale で足す ${notAdded.length}`, `Add via Tailscale ${notAdded.length}`)}</h2>
          {notAdded.length > 0 ? (
            <ul class="sessions">
              {notAdded.map((c) => (
                <li key={c.url}>
                  <div class="eprow">
                    <span class="body">
                      <span class="title">
                        {c.hostname}
                        {c.self ? t(' （この agent）', ' (this agent)') : ''}
                      </span>
                      <span class="sub">
                        {c.online ? (
                          <span class="state done">{t('オンライン', 'Online')}</span>
                        ) : (
                          <span class="state idle">{t('オフライン', 'Offline')}</span>
                        )}
                        {c.os ? <span class="chip">{c.os}</span> : null}
                        <code>{c.dnsName}</code>
                      </span>
                    </span>
                    <span class="epbtns">
                      <button class="plain" onClick={() => add(c.url, c.hostname)}>
                        {t('追加', 'Add')}
                      </button>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          <div class="notice push">
            <div class="pushrow">
              <input
                class="urlinput"
                type="url"
                inputMode="url"
                placeholder="https://host.tailnet.ts.net"
                value={manual}
                onInput={(e) => setManual((e.target as HTMLInputElement).value)}
              />
              <button
                class="plain"
                onClick={() => {
                  add(manual.trim(), new URL(manual.trim()).hostname)
                  setManual('')
                }}
                disabled={!manual.trim().startsWith('https://')}
              >
                {t('追加', 'Add')}
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {/* ★★ Notifications (2026-09-24 / the list shows a banner only when something is wrong; test and stop live here / `ui/pushState.ts`) */}
      <PushPanel transports={transports} mode="settings" />

      {/* ★★ Plan (2026-09-24 / billing / `ui/plan.ts`). ⚠️ Only when some agent reports account status */}
      {(() => {
        const rows = planRows(accounts ?? [])
        if (rows.length === 0) return null
        return (
          <section class="group">
            <h2>{t('プラン', 'Plan')}</h2>
            <div class="notice">
              {rows.map((r) => (
                <div key={r.machine} class="pushrow">
                  <span class="grow">
                    <strong>{r.machine}</strong> <span class={r.warn ? 'bad' : 'dim'}>{r.text}</span>
                  </span>
                </div>
              ))}
              <div class="pushrow">
                <a class="plain" href={ACCOUNT_ORIGIN} target="_blank" rel="noopener noreferrer">
                  {t('アカウント・プランの管理 →', 'Manage account and plan →')}
                </a>
              </div>
            </div>
          </section>
        )
      })()}

      {/* ★ Display (language and theme / moved out of the version row on 2026-09-24) */}
      <section class="group">
        <h2>{t('表示', 'Display')}</h2>
        <div class="notice">
          <div class="pushrow">
            <span class="grow">{t('言語', 'Language')}</span>
            {/* ★ Language (2026-09-23). ⚠️ Applied by reloading (so no text is left un-rebuilt / `lang.ts`) */}
            <select
              class="langpick"
              aria-label="Language"
              value={savedLangChoice()}
              onChange={(e) => {
                chooseLang((e.target as HTMLSelectElement).value as LangChoice)
                location.reload()
              }}
            >
              <option value="auto">{t('自動（端末の言語）', 'Auto (device language)')}</option>
              <option value="ja">日本語</option>
              <option value="en">English</option>
            </select>
          </div>
          <div class="pushrow">
            <span class="grow">{t('テーマ', 'Theme')}</span>
            {/* ★ Theme (2026-09-24). ⚠️ No reload needed (colors are CSS variables / `theme.ts`) */}
            <select
              class="langpick"
              aria-label={t('テーマ', 'Theme')}
              value={theme}
              onChange={(e) => {
                const next = asThemeChoice((e.target as HTMLSelectElement).value)
                chooseTheme(next)
                setTheme(next)
              }}
            >
              <option value="auto">{t('自動（端末の設定）', 'Auto (device setting)')}</option>
              <option value="light">{t('ライト', 'Light')}</option>
              <option value="dark">{t('ダーク', 'Dark')}</option>
            </select>
          </div>
        </div>
      </section>

      {/* ★★ The version currently running (2026-09-16). ⚠️⚠️ **The version line is always shown** (never remove it / CLAUDE.md §3).
          This value exposed "thought we migrated, but hadn't" (2026-09-21).
          ⇒ Everything else (Service Worker, stored contents) is folded into "Diagnostics". */}
      <footer class="foot diag">
        <div class="pushrow">
          <span class="grow">
            {t('版 ', 'Version ')}<code>{__BUILD_ID__}</code>
          </span>
          <button class="plain tiny" onClick={() => setDiagOpen(!diagOpen)}>
            {diagOpen ? t('診断を閉じる', 'Close diagnostics') : t('診断', 'Diagnostics')}
          </button>
        </div>
        {diagOpen ? (
          <div class="diagbody">
            <div class="pushmsg">
              Service Worker:{' '}
              {typeof navigator !== 'undefined' && navigator.serviceWorker?.controller
                ? t('出している（キャッシュ経由でも動く）', 'serving (works from cache too)')
                : t('出していない', 'not serving')}
            </div>
            <div class="pushmsg">
              {t(
                '⚠️ オフラインで起動したときに版が古ければ、原因は Service Worker のキャッシュです。',
                '⚠️ If the version is old when launched offline, the cause is the Service Worker cache.',
              )}
            </div>
            <div class="pushrow">
              <button class="plain tiny" onClick={() => void copyDiag()}>
                {t('診断をコピー', 'Copy diagnostics')}
              </button>
              {copied ? <span class="pushmsg">{copied}</span> : null}
            </div>
            {/* ★ The raw stored data (⚠️ contains no secrets: only URLs, public keys and routes).
                ⚠️⚠️ **Show both the raw value and the loaded result** (2026-09-16 / codex round 5, low #1).
                   `loadEndpoints()` is **sanitized**, so broken entries would vanish from the display and lead to misdiagnosis. */}
            <div class="pushmsg">{t('保存されている接続先（生）:', 'Saved connections (raw):')}</div>
            <pre class="diagpre">{rawEndpoints()}</pre>
            <div class="pushmsg">{t('読み込んだ結果（これが実際に使われる）:', 'Loaded result (this is what is actually used):')}</div>
            <pre class="diagpre">{JSON.stringify(loadEndpoints(), null, 1)}</pre>
          </div>
        ) : null}
      </footer>
    </>
  )
}
