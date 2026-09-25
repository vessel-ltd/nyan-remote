import { useEffect, useRef, useState } from 'preact/hooks'
import type { AgentHealth } from '../../../shared/types.ts'
import { idbKeyStore, loadIdentity, resetIdentity, type Identity } from '../identity.ts'
import { hhmm } from '../time.ts'
import { t } from '../../../shared/i18n.ts'
import { connectForPairing, connectForRelayPairing, type Transport } from '../transport/index.ts'
import { pairAbility, pairText, verifyHandshake, verifyText } from './pairing.ts'
import {
  cameraEnv,
  canScan,
  createScanController,
  openCamera,
  scanText,
  type ScanController,
} from './scan.ts'
import {
  collectDevices,
  revokeText,
  runPairing,
  runRevoke,
  showPairing,
  type DeviceRow,
} from './pairRun.ts'

type AddEndpoint = (e: {
  url: string
  label: string
  relay?: { url: string; agentPublicKey: string }
  /** ★ The route registration succeeded on (⚠️ no guessing / codex round 8, medium #2) */
  kind?: 'local' | 'relay'
}) => void

/**
 * Pairing of ③ device keys (ARCHITECTURE §14.1.2.16 / §14.1.2.17).
 *
 * ★★ On 2026-09-23 **only the screen layout** was rearranged (user decision / top of `ui/connections.ts`).
 *   - State is one `usePairing` (held by `Endpoints.tsx`)
 *   - The contents of "+ Add machine" are `Pairing`; the part inside the machine details is `MachineDevices`
 *   ⚠️ Decisions, steps and text are **all on the `.ts` side as before** (`ui/pairing.ts` and `ui/pairRun.ts`).
 *
 * ★★ **Decisions, steps and text all live on the `.ts` side** (`ui/pairing.ts` and `ui/pairRun.ts`).
 *   ⚠️⚠️ `.tsx` has no behavioural tests, so **writing steps here means nobody checks "how return values
 *      tie to side effects"** (2026-09-08 codex hit exactly that =
 *      a mutant changing `transports[at]` to `transports[0]` was green).
 *   ⇒ This file **only lines up the calls**. ⚠️ Do not move decisions or ordering back here.
 *
 * ⚠️ Pasted strings are **not saved** (the one-time token would remain in localStorage).
 */
export function usePairing({
  transports,
  rememberRelay,
  addEndpoint,
}: {
  transports: Transport[]
  /** ★ If the QR carries a relay entry point, have that endpoint remember it (③ stage 6, ④) */
  rememberRelay?: (at: number, relay: { url: string; agentPublicKey: string }) => void
  /**
   * ★ **Add an unknown endpoint** from the QR's `u` (2026-09-16 / Y).
   * ⚠️ If absent, that path is not used (fail-closed = "add it to endpoints first" as before).
   */
  addEndpoint?: AddEndpoint
}) {
  const [identity, setIdentity] = useState<Identity>()
  /** ⚠️ `undefined` means "not yet known" (★ distinct from `[]` / codex low #1) */
  const [healths, setHealths] = useState<(AgentHealth | undefined)[]>()
  const [rows, setRows] = useState<DeviceRow[]>([])
  const [trouble, setTrouble] = useState<string>()
  const [busy, setBusy] = useState(false)
  /** ★ Result of adding (pairing) */
  const [note, setNote] = useState<string>()
  /** ★ The registered party (to find old endpoints of the same machine whose key was regenerated / `staleTwins`) */
  const [lastPaired, setLastPaired] = useState<{ machine: string; relayUrl: string; agentPublicKey: string }>()
  /** ★ Per-machine results (check, remove registration). Keyed by transport position */
  const [machineNote, setMachineNote] = useState<Record<number, string>>({})

  useEffect(() => {
    void (async () => {
      setIdentity(await loadIdentity(idbKeyStore()))
      setHealths(
        await Promise.all(
          transports.map((t) => t.health().catch((): AgentHealth | undefined => undefined)),
        ),
      )
    })()
  }, [transports])

  const deps = {
    transports,
    healths: healths ?? [],
    identity,
    ua: navigator.userAgent,
    ...(rememberRelay ? { rememberRelay } : {}),
    // ★ The path connecting from the QR's `u` (⚠️ the line may be **disposable**: the `local` route is fetch, so
    //    it eats no slots. Do not open a relay line here = do not break §14.1.2.32's "keep one and pass it around")
    ...(addEndpoint ? { addEndpoint, connect: (url: string) => connectForPairing(url) } : {}),
    // ★★ Pairing via relay (③ stage 7 / §14.1.4). ⚠️ The line is **disposable**
    //   (`pairViaRelay` always closes it in `finally` = does not eat relay slots).
    ...(addEndpoint
      ? { connectRelay: (relay: { url: string; agentPublicKey: string }) => connectForRelayPairing(relay) }
      : {}),
  }

  const refresh = async () => {
    const got = await collectDevices(deps)
    setRows(got.rows)
    setTrouble(got.trouble)
  }

  useEffect(() => {
    if (healths) void refresh()
  }, [healths])

  const register = async (raw: string) => {
    setBusy(true)
    setNote(undefined)
    setLastPaired(undefined)
    try {
      const out = await runPairing(raw, deps)
      setNote(pairText(out))
      if (out.kind === 'done' && out.paired) setLastPaired({ machine: out.machine, ...out.paired })
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  /** ★★ The only way to confirm crypto works in the browser (§14.1.2.17) */
  const verify = async (at: number) => {
    if (!identity || identity.kind !== 'ok') return
    setBusy(true)
    try {
      const key = healths?.[at]?.agentPublicKey ?? ''
      const out = await verifyHandshake(identity.pair, key, (init) =>
        transports[at]!.handshake(init),
      )
      setMachineNote((m) => ({ ...m, [at]: verifyText(out) }))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (row: DeviceRow) => {
    setBusy(true)
    try {
      // ⚠️⚠️ **Send only to that row's machine** (do not go back to trying every endpoint / codex medium #5)
      const text = revokeText(await runRevoke(row, deps))
      setMachineNote((m) => ({ ...m, [row.at]: text }))
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const resetKey = async () => {
    setBusy(true)
    try {
      setIdentity(await resetIdentity(idbKeyStore()))
    } finally {
      setBusy(false)
    }
  }

  return { identity, healths, rows, trouble, busy, note, lastPaired, machineNote, register, verify, revoke, resetKey }
}

export type PairingState = ReturnType<typeof usePairing>

/**
 * ★ Contents of "+ Add machine" (id, paste, camera, result, key recreation).
 * ⚠️ The camera's lifetime is owned by `scan.ts`. Always stop it when this component goes away (the effect below).
 */
export function Pairing({ state }: { state: PairingState }) {
  const { identity, healths, busy, note } = state
  const [input, setInput] = useState('')
  /** Awaiting confirmation of key recreation (⚠️ becomes a different identity on every machine) */
  const [confirmReset, setConfirmReset] = useState(false)
  /** Whether the camera is open (★ only **whether to draw**; the authority to stop is `ScanController`) */
  const [scanning, setScanning] = useState(false)
  const [scanNote, setScanNote] = useState<string>()
  const videoRef = useRef<HTMLVideoElement>(null)
  /**
   * ★★ The camera's lifetime is owned by `scan.ts` (⚠️ do not move the steps back here / codex round 7, medium #6).
   * ⚠️ `setTimeout` is injected so tests can control the deadline.
   */
  const scanRef = useRef<ScanController>()
  if (!scanRef.current) {
    scanRef.current = createScanController((ms, fn) => {
      const id = setTimeout(fn, ms)
      return () => clearTimeout(id)
    })
  }
  // ⚠️⚠️ **Always stop when the screen goes away** (without this the track remains on unmount =
  //    the camera light stays on even after moving to another screen / codex round 7, medium #6)
  useEffect(() => () => scanRef.current?.stop(), [])

  // ⚠️⚠️ **Not shown before health is known** (no buttons without the mark / fail-closed)
  if (!showPairing(healths)) return null

  const register = async (raw: string) => {
    setScanNote(undefined)
    await state.register(raw)
    // ★ The one-time token is used up, so clear the input (it was never saved)
    setInput('')
  }

  /**
   * ★ Read with the camera (⚠️ **the steps are in `scan.ts`**. This only opens, runs and closes).
   * ⚠️⚠️ Once read, proceed straight to registration (⚠️ `runPairing` still validates the content as before).
   */
  const scan = async () => {
    const ctl = scanRef.current!
    // ⚠️⚠️ "Close" **stops the grabbed camera immediately** (without waiting for the loop's reply)
    if (ctl.active()) {
      ctl.stop()
      setScanning(false)
      return
    }
    setScanNote(undefined)
    setScanning(true)
    // ⚠️ Open after the video element is drawn (opening before `ref` is set cannot grab it)
    await new Promise((r) => setTimeout(r, 0))
    const video = videoRef.current
    if (!video) {
      setScanning(false)
      return
    }
    // ⚠️ Failing to open or double-pressing also comes back as a `ScanOutcome` (no exception)
    // ⚠️ Only **the browser ports** are passed (the camera is grabbed inside `scan.ts` / codex round 9, medium #2)
    const out = await ctl.run({ video, env: cameraEnv() })
    setScanning(false)
    if (out.kind !== 'found') {
      setScanNote(scanText(out))
      return
    }
    await register(out.raw)
  }

  return (
    <div class="notice push addpanel">
      <div class="pushmsg first">
        {t('PC で ', 'On the PC, run ')}
        <code>nyan pair</code>
        {t(' を実行し、出てきた QR を', ', then ')}
        {canScan(globalThis) ? t('カメラで読むか、', 'scan the QR code with the camera, or ') : ''}
        {t('下に ', 'paste the ')}
        <code>nyan://…</code>
        {t(' を貼り付けます', ' link below')}
      </div>
      {/* ★ Read with the camera (③ stage 6, ④). ⚠️ **Not shown on devices that cannot use it** (fail-closed).
          ★ iOS Safari has no `BarcodeDetector`, so it is read with our own decoder (2026-09-24 / `shared/qrDecode.ts`) */}
      {canScan(globalThis) ? (
        <div class="pushrow">
          <button class="plain" onClick={() => void scan()} disabled={busy}>
            {scanning ? t('カメラを閉じる', 'Close camera') : t('カメラで読み取る', 'Scan with camera')}
          </button>
        </div>
      ) : null}
      {/* ⚠️ **Not rendered** rather than `hidden` (a leftover video element makes the camera look grabbed) */}
      {scanning ? (
        <video class="scanview" ref={videoRef} playsInline muted autoPlay aria-label={t('カメラ', 'Camera')} />
      ) : null}
      <div class="pushrow">
        <input
          class="urlinput"
          type="text"
          placeholder={t('nyan://pair?… を貼り付け', 'Paste nyan://pair?…')}
          value={input}
          onInput={(e) => setInput((e.target as HTMLInputElement).value)}
        />
        <button class="plain" onClick={() => void register(input)} disabled={busy || !input.trim()}>
          {t('登録', 'Register')}
        </button>
      </div>

      {scanNote ? <div class="pushmsg">{scanNote}</div> : null}
      {note ? <div class="pushmsg result">{note}</div> : null}

      <div class="pushmsg">
        {identity?.kind === 'ok' ? (
          <>
            {t('この端末の id: ', 'This device’s id: ')}<code>{identity.deviceId.slice(0, 12)}…</code>
          </>
        ) : identity ? (
          <>⚠️ {identity.reason}</>
        ) : (
          t('読み込み中…', 'Loading…')
        )}
      </div>

      {/* ⚠️ Key recreation is the escape hatch for when "it is broken". ⚠️⚠️ Pressing it makes you a different identity on every machine */}
      {identity && identity.kind !== 'ok' ? (
        confirmReset ? (
          <button
            class="plain"
            disabled={busy}
            onClick={() => void state.resetKey().finally(() => setConfirmReset(false))}
          >
            {t(
              '本当に作り直す（登録済みの全マシンで再ペアリングが必要）',
              'Really recreate (every registered machine will need pairing again)',
            )}
          </button>
        ) : (
          <button class="plain" onClick={() => setConfirmReset(true)} disabled={busy}>
            {t('鍵を作り直す', 'Recreate key')}
          </button>
        )
      ) : null}
    </div>
  )
}

/**
 * ★★ The part inside the machine details: "Check" and the devices registered on that machine.
 *
 * ★ "Check" does two things at once: a response check (`onProbe` = parent) and a crypto handshake check (`verify`).
 *   ⚠️ The handshake is **only for agents with the mark** (no buttons that 404 / fail-closed).
 * ⚠️ The device list is fetched from the agent, so **it does not appear without a connection** (unlinking is the parent's "Unlink" = pressable even when down).
 */
export function MachineDevices({
  state,
  at,
  onProbe,
}: {
  state: PairingState
  /** Position in `transports` (⚠️ do not look up by name / `transportIndex` in `ui/connections.ts`) */
  at: number
  onProbe: () => void
}) {
  const { identity, healths, rows, busy, machineNote } = state
  /** Awaiting confirmation of revocation (★ a mis-tap costs "re-pairing", so it takes two taps) */
  const [confirmRow, setConfirmRow] = useState<string>()
  const h = healths?.[at]
  const canVerify = pairAbility(h?.features).verify && identity?.kind === 'ok'
  const mine = identity?.kind === 'ok' ? identity.deviceId : undefined
  const here = rows.filter((r) => r.at === at)
  const rowKey = (r: DeviceRow) => `${r.at}:${r.device.key}`

  return (
    <>
      <div class="pushrow">
        <button
          class="plain"
          disabled={busy}
          onClick={() => {
            onProbe()
            if (canVerify) void state.verify(at)
          }}
        >
          {t('確認', 'Check')}
        </button>
      </div>
      {machineNote[at] ? <div class="pushmsg">{machineNote[at]}</div> : null}

      {here.length > 0 ? (
        <>
          <div class="pushmsg">{t(`このマシンに登録されている端末 ${here.length}`, `Devices registered on this machine: ${here.length}`)}</div>
          <ul class="devrows">
            {here.map((r) => (
              <li key={rowKey(r)}>
                <span class="grow">
                  {r.device.label || t('名前なし', 'Unnamed')} <code>{r.device.deviceId.slice(0, 8)}…</code>
                  {r.device.deviceId === mine ? t(' （この端末）', ' (this device)') : ` ${hhmm(r.device.addedAt)}`}
                </span>
                {/* ★★ **Revocation was removed from this device's own row** (2026-09-21 / user decision).
                    ⇒ **Cutting the connection to yourself is only via "Unlink"** (that one works even when the other side is down).
                    ★ What remains here is **managing other devices** (stolen, no longer used, PCs). */}
                {r.device.deviceId === mine ? null : confirmRow === rowKey(r) ? (
                  <button
                    class="plain tiny danger"
                    onClick={() => void state.revoke(r).finally(() => setConfirmRow(undefined))}
                    disabled={busy}
                  >
                    {t('本当に消す', 'Really remove')}
                  </button>
                ) : (
                  <button class="plain tiny" onClick={() => setConfirmRow(rowKey(r))} disabled={busy}>
                    {t('消す', 'Remove')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  )
}
