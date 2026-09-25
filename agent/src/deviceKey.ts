// The agent's own static key (`~/.nyan-remote/device-key.json`, 0600).
//
// ★★★ **Recreating this key disconnects every registered device.**
//   The QR code carries **the agent's public key** (ARCHITECTURE §14.1.2.5), and the device
//   starts the handshake **addressed to that key** with `startHandshake(deviceStatic, agentPublicRaw)`.
//   ⇒ If the key changes, `z2`/`z4` no longer match, so **every pairing has to be redone**.
//   = **The same kind of accident** as recreating `vapid.json`, which kills every subscription (CLAUDE.md §2).
//   ⇒ **If it is broken, do not recreate it and do not write it** (keep the evidence and the means of recovery).
//
// ⚠️ The file name `device-key.json` was fixed by ARCHITECTURE §14.1.2.3.
//    It is **the agent-side key**, but named after the family "device key pair (identity for ③)".
//    ⚠️ The device (phone) side key lives in **IndexedDB with `extractable: false`** (never a file).
//
// ⚠️ The primitives for generating, exporting and importing the key are in `agentKey.ts` (**a place the PWA does not import**).
//    This file only owns the key's "lifetime as a file" on top of that.

import type { Jwk, KeyPair } from '../../shared/crypto.ts'
import { exportPublicKey, sameBytes } from '../../shared/crypto.ts'
import { exportPrivateKey, generateAgentKey, importKeyPair } from './agentKey.ts'
import { readJsonFile, statePath, writeJson, type JsonFile } from './state.ts'
import { t } from '../../shared/i18n.ts'
import { reasonText } from './reasons.ts'

/** ⚠️ Under `~/.nyan-remote/` (protected names in §0; do not use `nyan-remote`) */
export const DEVICE_KEY_FILE = 'device-key.json'

interface Stored {
  v: 1
  /** ⚠️ A JWK including the private key (`d`). Hence 0600; the machine is the trust boundary (§14.1.2.3) */
  key: Jwk
  /**
   * ★★★ **Marker that a lost key was recreated** (2026-09-24 / user decision: no backups, make recovery paths instead).
   * The key file was missing while registered devices existed = not a first run but **lost**. The only option is to recreate it,
   * but phones registered before that **look for the relay room with the old key**, so they cannot connect until the QR is scanned again.
   * ⇒ Record the time and device count; `npm run devices` / `npm run pair` / the startup log say so.
   * ⚠️ Display only (never used for decisions). `registered` of `null` means "the records were broken and could not be counted".
   */
  recreated?: KeyRecreated
}

export interface KeyRecreated {
  at: string
  registered: number | null
}

/**
 * ★★ "Broken" and "usable key" are one value (same as `peers.ts`).
 *
 * ⚠️ With separate variables it becomes a **convention** ("the key is null when broken"),
 *    and `if (broken)` gets sprinkled everywhere. ⇒ **Make it impossible to extract via the type.**
 */
type Loaded =
  | { kind: 'none' }
  | { kind: 'ok'; pair: KeyPair; publicRaw: Uint8Array }
  | { kind: 'broken'; reason: string }

let state: Loaded = { kind: 'none' }
let recreated: KeyRecreated | undefined

/** ★ If a lost key was recreated, its time and device count (⚠️ display only / `Stored.recreated`) */
export function agentKeyRecreated(): KeyRecreated | undefined {
  return recreated
}

/** Why the key is unusable (shown on screen and in diagnostics. ⚠️ Category only; absolute paths go to the log) */
export function agentKeyProblem(): string | undefined {
  if (state.kind === 'broken') return reasonText(state.reason)
  if (state.kind === 'none') return t('鍵をまだ読み込んでいません', 'The key has not been loaded yet.')
  return undefined
}

/**
 * The agent's static key.
 *
 * ⚠️ **Throws** when unusable (does not return `null` for the caller to judge =
 *    no path that "starts a handshake while broken"). Callers check `agentKeyProblem()` first.
 */
export function agentKey(): KeyPair {
  if (state.kind !== 'ok') throw new Error(t(`agent の静的鍵が使えません（${agentKeyProblem()}）`, `The agent's static key is unusable (${agentKeyProblem()}).`))
  return state.pair
}

/**
 * The agent's public key to put in the QR code (raw 65B).
 *
 * ⚠️⚠️ Must not return it when broken (that would **produce a QR code that cannot connect**).
 */
export function agentPublicRaw(): Uint8Array {
  if (state.kind !== 'ok') throw new Error(t(`agent の静的鍵が使えません（${agentKeyProblem()}）`, `The agent's static key is unusable (${agentKeyProblem()}).`))
  // ⚠️ Return a copy (the caller rewriting it must not change our internal state)
  return new Uint8Array(state.publicRaw)
}

/**
 * Read once at startup (create if missing).
 *
 * ⚠️⚠️ **If broken, do not recreate. Do not write.** Read the explanation above.
 * ⚠️⚠️ **If saving fails, do not keep running on the in-memory key.** Otherwise devices paired
 *    in the meantime **silently fail to connect after the next start** (the agent would have a different key).
 * ★ After creating, **read it back and verify** (same practice as `repairSubject` in `push.ts`;
 *   do not confuse "readable" with "correct" / CLAUDE.md §2).
 */
export async function loadAgentKey(
  io: KeyIo = fileIo,
  /**
   * ★ Number of registered devices (⚠️ finish `loadDevices` **before the key** and pass it in).
   * `null` means "the records are broken and cannot be counted" (⚠️ distinct from 0 = there may have been some).
   */
  registeredDevices: number | null = 0,
): Promise<void> {
  if (state.kind === 'ok') return
  const file = await io.read()
  if (file.kind === 'broken') {
    return fail(file.reason, `${file.detail} / ${statePath(DEVICE_KEY_FILE)}`)
  }
  if (file.kind === 'ok') {
    const problem = structureProblem(file.value)
    if (problem) return fail(problem, statePath(DEVICE_KEY_FILE))
    // ⚠️ "Right shape" and "usable as a key" are different (`d` can be broken base64url and still have the right shape)
    try {
      await adopt(await importKeyPair(file.value.key as Jwk))
    } catch (err) {
      return fail('鍵として読めません', errText(err))
    }
    recreated = asRecreated(file.value.recreated)
    console.log(t('[key] agent の静的鍵を読みました', "[key] Loaded the agent's static key"))
    if (recreated) warnRecreated(recreated)
    return
  }

  // ★ First start: create it and use it **only if it was saved**
  // ★★★ But if registered devices exist (or cannot be counted), it is **lost, not a first run** (`Stored.recreated`)
  const lost: KeyRecreated | undefined =
    registeredDevices === 0 ? undefined : { at: new Date().toISOString(), registered: registeredDevices }
  const pair = await generateAgentKey()
  const stored: Stored = {
    v: 1,
    key: await exportPrivateKey(pair.privateKey),
    ...(lost ? { recreated: lost } : {}),
  }
  try {
    await io.write(stored)
  } catch (err) {
    return fail('鍵を保存できません', errText(err))
  }
  // ★★ **Read back what was written and check the key can be rebuilt from that alone.**
  //   ⚠️ Skipping this means "thought it was saved, but broken from the next start" goes unnoticed.
  const back = await io.read()
  if (back.kind !== 'ok' || structureProblem(back.value)) {
    return fail('保存した鍵を読み直せません', statePath(DEVICE_KEY_FILE))
  }
  let restored: KeyPair
  try {
    restored = await importKeyPair(back.value.key as Jwk)
  } catch (err) {
    return fail('保存した鍵を組み立て直せません', errText(err))
  }
  const wrote = await exportPublicKey(restored.publicKey)
  const made = await exportPublicKey(pair.publicKey)
  if (!sameBytes(wrote, made)) return fail('保存した鍵が作った鍵と一致しません', '')
  await adopt(restored)
  recreated = lost
  console.log(t(`[key] agent の静的鍵を作りました: ${statePath(DEVICE_KEY_FILE)}`, `[key] Created the agent's static key: ${statePath(DEVICE_KEY_FILE)}`))
  if (lost) warnRecreated(lost)
}

function asRecreated(v: unknown): KeyRecreated | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const r = v as Record<string, unknown>
  if (typeof r['at'] !== 'string') return undefined
  const n = r['registered']
  return { at: r['at'], registered: typeof n === 'number' ? n : null }
}

function warnRecreated(r: KeyRecreated): void {
  const who = r.registered === null ? '登録済みの端末' : `登録済みの ${r.registered} 台`
  const whoEn = r.registered === null ? 'Registered devices' : `The ${r.registered} registered devices`
  console.warn(
    t(
      `[key] ⚠️⚠️ agent の鍵を作り直しました（${r.at}。鍵のファイルが無いのに登録済みの端末が居た ＝ 失った）。` +
        `${who}は、スマホで QR を読み直すまで繋がりません（\`npm run pair\`）`,
      `[key] ⚠️⚠️ Recreated the agent key (${r.at}; the key file was missing while devices were registered = it was lost). ` +
        `${whoEn} cannot connect until the QR code is scanned again on the phone (\`npm run pair\`)`,
    ),
  )
}

async function adopt(pair: KeyPair): Promise<void> {
  // ⚠️ **No length check here** (a mutation slipped through on 2026-09-07). `structureProblem`
  //    checks `crv`, so any key reaching here always has a 65B raw = the check was **unreachable**.
  //    ★ Made the same mistake in `peers.ts` (VERIFY "types of my mistakes").
  //    ⇒ "It is an invariant relied on later" is not a reason to add a check. **Check whether it is reachable.**
  state = { kind: 'ok', pair, publicRaw: await exportPublicKey(pair.publicKey) }
}

function fail(reason: string, detail: string): void {
  state = { kind: 'broken', reason }
  console.error(t(`[key] ⚠️⚠️ agent の静的鍵が使えません: ${reason}`, `[key] ⚠️⚠️ The agent's static key is unusable: ${reasonText(reason)}`))
  if (detail) console.error(t(`[key]    詳細: ${detail}`, `[key]    Detail: ${detail}`))
  console.error(
    t(
      '[key] ⚠️ **鍵を作り直しません**（作り直すと登録済みの全デバイスが繋がらなくなります）。' +
        'デバイス鍵の経路だけを止めます。Tailscale 経由の操作は今までどおり動きます',
      '[key] ⚠️ **Not recreating the key** (recreating it would disconnect every registered device). ' +
        'Only the device-key route is stopped. Access via Tailscale keeps working',
    ),
  )
  console.error(
    t(
      `[key] 直し方: 中身を直すか、退避してから再起動する（⚠️ 退避すると再ペアリングが必要）:`,
      `[key] To fix: repair the contents, or move the file aside and restart (⚠️ moving it aside requires pairing again):`,
    ),
  )
  console.error(`[key]   mv ${statePath(DEVICE_KEY_FILE)}{,.broken} && systemctl --user restart nyan-remote`)
}

/**
 * ★ The actual read/write (**swappable for tests only**; the default is the real file).
 *
 * ⚠️⚠️ Without this, "**read back and verify after writing**" cannot be tested
 *    (a normal save round-trip cannot tell apart a mutation that skips the read-back =
 *     the surviving mutation codex named on 2026-09-08).
 * ⚠️ No decisions here (`loadAgentKey` decides everything).
 */
export interface KeyIo {
  read(): Promise<JsonFile<Partial<Stored>>>
  write(value: Stored): Promise<void>
}

const fileIo: KeyIo = {
  read: () => readJsonFile<Partial<Stored>>(DEVICE_KEY_FILE),
  write: (value) => writeJson(DEVICE_KEY_FILE, value),
}

/** ⚠️ Shape is checked **once at the entrance** (do not force it through with `as` later) */
function structureProblem(value: Partial<Stored>): string | undefined {
  if (value.v !== 1) return '知らない版です'
  const key = value.key
  if (!key || typeof key !== 'object' || Array.isArray(key)) return 'key がありません'
  if (key.crv !== 'P-256') return '曲線が P-256 ではありません'
  // ⚠️ Missing `d` means **a public-key-only file** (`importKeyPair` rejects it too, but we want to give the reason)
  if (typeof key.d !== 'string' || !key.d) return '秘密鍵（d）がありません'
  return undefined
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** For tests (★ a stateful module, so treated like `resetPeers`) */
export function resetAgentKey(): void {
  state = { kind: 'none' }
  recreated = undefined
}
