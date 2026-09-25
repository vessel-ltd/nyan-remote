#!/usr/bin/env node
// Show the QR to register one phone (③'s device keys / ARCHITECTURE §14.1.2.5).
//
// ⚠️ Why a script: `/pair/token` is an endpoint **only for local processes on this machine**,
//    and `~/.nyan-remote/hook-token` (0600) must be sent as a Bearer token.
//    A hand-written curl always gets it wrong (same reason as `pending.mjs`).
//
// ★★ **The point is that one-time tokens cannot be issued over the network** (`isLocalOnlyPath` in `auth.ts`).
//    ⇒ "Registering needs the PC's screen" = the QR means something as **an out-of-band authenticated channel**.
//
// ★★ The QR is **drawn by ourselves with `shared/qr.ts`** (2026-09-19).
//    ⚠️⚠️ It used to be left to `qrencode`, and if missing it said "`sudo apt install qrencode`".
//       **On 2026-09-16 we decided "implement it ourselves so users never run apt"**, yet
//       the implementation was unfinished while the instruction stayed (pointed out on a real machine).
//    ⚠️ Even if it cannot be drawn, print `nyan://…` as text (pairing itself never stops).
//
// Usage:
//   nyan pair (same as npm run pair)

import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { makeQr, QR_QUIET, qrTerminal } from '../shared/qr.ts'
import { qrPng } from './lib/qrPng.mjs'
import { connectWithRetry, renderPair } from './lib/pairPrint.mjs'
import { artSize, chooseQrMode, imageOpeners, isWsl, modeNote, toWinPath } from './lib/qrMode.mjs'
import { hints, serviceKind } from './lib/service.mjs'
import { t } from '../shared/i18n.ts'
import { initCliLang, agentUrl } from './lib/lang.mjs'

// ★ Language first (before any message is built)
initCliLang()

// ★ Instructions matching the service type (⚠️ never suggest systemctl on mac / 2026-09-23)
const svc = hints(serviceKind(process.platform, homedir()))

const stateDir = process.env.NYAN_REMOTE_STATE_DIR ?? join(homedir(), '.nyan-remote')

function readConfig() {
  try {
    return JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8'))
  } catch {
    return {}
  }
}

const cfg = readConfig()
const port = Number(process.env.NYAN_REMOTE_PORT ?? cfg.port ?? 7777)

let token
try {
  token = readFileSync(join(stateDir, 'hook-token'), 'utf8').trim()
} catch (err) {
  console.error(t(`✗ ${join(stateDir, 'hook-token')} が読めません: ${err.message}`, `✗ Cannot read ${join(stateDir, 'hook-token')}: ${err.message}`))
  // ⚠️ Never print **instructions that cannot run** (mac has no systemctl) ⇒ the wording lives in one place, service.mjs
  console.error(t(`  agent を一度起動すると作られます（${svc.start}）`, `  It is created when the agent starts once (${svc.start})`))
  process.exit(1)
}
if (!token) {
  console.error(t('✗ hook-token が空です（agent を再起動してください）', '✗ hook-token is empty (restart the agent)'))
  process.exit(1)
}

// ★★ **Ctrl-C cancels the one-time token** (2026-09-23 / user decision).
//   ⚠️⚠️ Without cancelling, for 5 minutes after exiting **the QR left on screen or in the image window can still register**.
//   ⚠️⚠️ **Set up the handler before issuing the token** (codex round 15, medium #2). It used to be set up after the QR
//      was printed, so **a Ctrl-C while drawing exited without cancelling** (the QR that went out stayed usable until expiry).
//   ★ If pressed while issuing, **wait for the issue to return, then cancel** (we cannot cancel without the id).
//     ⚠️ But a second Ctrl-C exits immediately (do not trap the user when the agent does not answer).
//   ⚠️ Exit even if cancelling fails (waiting is pointless if the agent is down). ⚠️ Say whether it was cancelled (no lies).
//   ⚠️ Old agents (which return no id) have no cancel endpoint ⇒ only clean up.
let info
let issuing = false
let stopAsked = 0
let stopping = false
async function stopNow() {
  if (stopping) return
  stopping = true
  if (info?.id) {
    const r = await localCall('POST', `/pair/token/${encodeURIComponent(info.id)}/cancel`)
    console.log('')
    console.log(
      r?.cancelled === true
        ? t('✔ やめました（この QR はもう使えません）', '✔ Cancelled (this QR can no longer be used)')
        : r?.cancelled === false
          ? t('（この QR はもう使われたか、切れていました）', '(This QR had already been used or had expired)')
          : t(
              '⚠️ 取り消せませんでした（agent に繋がりません）。この QR は期限まで有効です',
              '⚠️ Could not cancel (cannot reach the agent). This QR stays valid until it expires',
            ),
    )
  }
  process.exit(130)
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    stopAsked++
    if (issuing && stopAsked === 1) {
      console.error(
        t(
          '（発行を待ってから取り消します。すぐ抜けるならもう一度 Ctrl-C）',
          '(Will cancel once the code is issued. Press Ctrl-C again to quit right away)',
        ),
      )
      return
    }
    if (stopAsked > 1 && stopping) process.exit(130)
    void stopNow()
  })
}

let res
let waited = 0
issuing = true
try {
  // ★★ Wait a little until it connects (right after `systemctl restart` it is not bound yet).
  //   ⚠️ Hit for real on 2026-09-08 (called on the line after restart and got `fetch failed`)
  const out = await connectWithRetry(() =>
    fetch(agentUrl(port, '/pair/token'), {
      method: 'POST',
      // ⚠️ `auth.ts` looks at `X-Nyan-Remote-Token` or `Authorization: Bearer` (a protected name in §0)
      headers: { 'X-Nyan-Remote-Token': token },
      signal: AbortSignal.timeout(5000),
    }),
  )
  res = out.res
  waited = out.waited
} catch (err) {
  console.error(t(`✗ agent に繋がりません（127.0.0.1:${port}）: ${err.message}`, `✗ Cannot reach the agent (127.0.0.1:${port}): ${err.message}`))
  console.error(t(`  起動しているか: ${svc.status}`, `  Is it running? ${svc.status}`))
  console.error(t(`  起こすなら    : ${svc.start}`, `  To start it:   ${svc.start}`))
  process.exit(2)
}
// ⚠️ Never slow down silently (say that we waited)
if (waited > 0) console.error(t(`（agent の起動を ${waited} 回待ちました）`, `(Waited ${waited} time(s) for the agent to start)`))

if (!res.ok) {
  // ⚠️ The agent returns **only a category** as the reason (absolute paths go to its log / CLAUDE.md §2)
  console.error(`✗ ${res.status}: ${(await res.text()).slice(0, 300)}`)
  if (res.status === 503) {
    console.error(t(`  agent のログの [key] / [devices] の行を見てください: ${svc.logs}`, `  Check the [key] / [devices] lines in the agent log: ${svc.logs}`))
  }
  process.exit(3)
}

info = await res.json()
issuing = false
// ★ If Ctrl-C was pressed while issuing, cancel here and exit (now that the id is known, it can be cancelled)
if (stopAsked > 0) await stopNow()

/**
 * Draw the QR. ⚠️ **`undefined` if it cannot be drawn** (do not fail here = fall back to pasting).
 *
 * ⚠️ `makeQr` returns `undefined` for lengths that do not fit (never truncates silently).
 */
function drawQr(url) {
  const qr = makeQr(url)
  if (!qr) return undefined
  const art = qrTerminal(qr)
  return { qr, art, need: artSize(art) }
}

const shown = drawQr(info.url)
// ★★ **How it is shown is decided in one place, `chooseQrMode`** (2026-09-23 / user decision / top of scripts/lib/qrMode.mjs).
//   mac: image only (no text QR); elsewhere an image only when it does not fit the terminal.
//   ⚠️ The terminal size is known only when stdout is a terminal (if unknown, never open a window on its own).
const term = process.stdout.isTTY ? { columns: process.stdout.columns, rows: process.stdout.rows } : undefined
let choice = shown ? chooseQrMode({ platform: process.platform, argv: process.argv, term, need: shown.need }) : undefined
// ⚠️ Where images cannot be opened (Linux without a display, no wslpath), fall back to text (prevents silently showing nothing)
//   ⚠️ But not when `--image` was **given explicitly** (create the image and print its path = it can be opened by hand)
if (choice?.mode === 'image' && choice.reason !== 'asked') {
  const openers = imageOpeners({ platform: process.platform, env: process.env, file: '', winPath: isWsl(process.env) ? 'probe' : undefined })
  if (openers.length === 0) {
    console.error(t('⚠️ この環境では画像を開けません（画面がありません）。文字の QR を出します', '⚠️ Cannot open images here (no display). Showing a text QR instead'))
    choice = { mode: 'text', reason: 'no-viewer' }
  }
}
const asImage = choice?.mode === 'image'
const asText = choice?.mode === 'text'

// ★★★ **Guidance first, QR last** (codex round 15, low #5). ⚠️ Long guidance after the QR
//    pushes the top of a QR that should fit off the screen (at most `QR_TRAILING_LINES` lines after it / qrMode.mjs).
console.log('')
// ★ The phone-side entry point (built in step 5b on 2026-09-08. ⚠️ it used to say "not available yet")
// ⚠️⚠️ **Keep this in step with the implementation** (on 2026-09-19 it was lying on a real machine).
//    ⚠️ iOS Safari has no `BarcodeDetector`, so **only pasting works** (that is expected).
console.log(t('スマホの PWA で「⚙ 設定」→「＋ マシンを追加」を開き、', 'In the phone PWA, open "⚙ Settings" → "+ Add machine", then'))
console.log(
  t(
    'QR を「カメラで読み取る」で読むか、下の nyan://… を貼り付けます（⚠️ iPhone は貼り付けのみ）',
    'scan the QR with "Scan with camera", or paste the nyan://… text below (⚠️ iPhone: paste only)',
  ),
)
// ⚠️⚠️ **People who cannot scan need to know what to do** (do not just print it and stop).
if (asText) console.log(t('端末で読めないときは: nyan pair --image（画像にして開く）', "If it can't be scanned from the terminal: nyan pair --image (opens it as an image)"))
console.log('')
console.log(
  renderPair({
    url: info.url,
    expiresAt: info.expiresAt,
    machine: info.machine,
    keyRecreated: info.keyRecreated,
    qr: asText ? shown?.art : undefined,
    imageNote: shown && !asText ? modeNote(choice, shown.need, term) : undefined,
  }),
)

// ── Cleanup (⚠️ set up the handler before grabbing resources) ──────────────────────
//
// ★★ **Register the cleanup first, then create** (2026-09-22 / found by a test).
//   ⚠️⚠️ It used to be "create → register", so **a Ctrl-C in that gap left it behind**.
//      The gap is not instantaneous: **PNG encoding (deflate) takes tens of milliseconds**,
//      and a test actually reproduced `signal: SIGINT` (= died with the default action).
let dir
let cleaned = false
const cleanup = () => {
  if (cleaned || dir === undefined) return
  cleaned = true
  // ⚠️ Do not fail if it cannot be removed (⚠️ but do not stay silent)
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    console.error(t(`⚠️ 一時ファイルを消せませんでした（手で消してください）: ${dir}: ${err.message}`, `⚠️ Could not delete the temporary file (delete it by hand): ${dir}: ${err.message}`))
  }
}
// ★ Cleanup lives **in this one place** (always runs, whether via `process.exit` or a natural end).
//   ⚠️ Do not also sprinkle `cleanup()` calls before exiting (duplicated, it becomes a guard tests cannot kill / CLAUDE.md §2)
process.on('exit', cleanup)

/** Ask this machine's agent (⚠️ failure is undefined = the caller treats it as "unknown") */
async function localCall(method, path) {
  try {
    const r = await fetch(agentUrl(port, path), {
      method,
      headers: { 'X-Nyan-Remote-Token': token },
      signal: AbortSignal.timeout(3000),
    })
    if (!r.ok) return undefined
    return await r.json()
  } catch {
    return undefined
  }
}

// ── Image ────────────────────────────────────────────────────────────────────────
//
// ⚠️⚠️ **The one-time token lands in a file**. CLAUDE.md §2 says "one-time tokens live only in memory", so
//    the exposure is bounded by 3 things (widened from "only when asked" to "default" on 2026-09-23 / user approved):
//      ① a 0600 temp directory (unreadable by other users)
//      ② **always removed on exit** (registered, Ctrl-C, expired, or exception)
//      ③ its lifetime **never exceeds the one-time token's**
//    ⇒ Keep it to the same exposure as showing it on screen (**nothing left on disk**).
// ⚠️ No new dependencies: the PNG is written with Node's built-in `zlib` only (`scripts/lib/qrPng.mjs`).
if (shown && asImage) {
  dir = mkdtempSync(join(tmpdir(), 'nyan-pair-'))
  // ★★ **Make it a PNG** (2026-09-22 / on a real machine the SVG **opened in the terminal app (Warp)**).
  const file = join(dir, 'pair.png')
  // ⚠️ Pass `mode` at creation (a later chmod leaves it **readable by anyone for a moment**)
  writeFileSync(file, qrPng(shown.qr, QR_QUIET, 10), { mode: 0o600 })

  console.log(t(`★ 画像を開きます: ${file}`, `★ Opening the image: ${file}`))
  // ★ How to open lives in one place, `imageOpeners` (try from the top, fall through on failure)
  const steps = imageOpeners({
    platform: process.platform,
    env: process.env,
    file,
    winPath: isWsl(process.env) ? toWinPath(file) : undefined,
  })
  // ⚠️ Never open a real viewer from tests (a window would pop up every test run / 2026-09-23)
  if (process.env.NYAN_REMOTE_NO_OPEN === '1') steps.length = 0
  const tryOpen = (i) => {
    if (i >= steps.length) {
      console.log(t('  （自動では開けませんでした。上のパスを開いてください）', '  (Could not open it automatically. Open the path above)'))
      return
    }
    const [cmd, args] = steps[i]
    execFile(cmd, args, (err) => {
      // ⚠️ explorer.exe returns 1 even on success ⇒ if it is the last resort, do not treat it as failure
      if (err && i + 1 < steps.length) tryOpen(i + 1)
    })
  }
  tryOpen(0)
}

// ── Waiting ──────────────────────────────────────────────────────────────────────
//
// ★★ **Exit the moment the phone finishes registering** (2026-09-23 / user decision).
//   ⚠️ It used to be "press Enter after scanning", so **it was unclear what it was waiting for**, and
//      the screen could not tell whether registration succeeded (could not tell "thought I scanned" from "not registered").
//   ⇒ Ask the agent every second, and **exit by stating the registered device in the affirmative**.
//   ⚠️ What we ask with is **the id** (the one-time token is never sent). ⚠️ The endpoint is for this machine only.
const expiresAtMs = new Date(info.expiresAt).getTime()
const left = () => Math.max(0, expiresAtMs - Date.now())
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (info.id) {
  console.log(
    t(
      '⏳ 登録が終わると自動で終わります（Ctrl-C でやめる ＝ この QR は使えなくなります）',
      '⏳ Ends by itself once the phone is registered (Ctrl-C cancels = this QR stops working)',
    ),
  )
  let misses = 0
  // ★★★ **Expiry is decided only by the agent's answer (`expired`)** (2026-09-23 / codex round 16, medium #5).
  //   ⚠️⚠️ It used to cut off by the local clock first, so **when registration finished just before expiry**, it ended with
  //      "expired" without asking again (it had actually registered). The agent owns the deadline.
  //   ★ While registering (waiting for the save) the agent answers `registering` ⇒ keep waiting (round 15, medium #1).
  for (;;) {
    const st = await localCall('GET', `/pair/token/${encodeURIComponent(info.id)}`)
    if (st === undefined) {
      // ⚠️ Do not give up on a momentary failure (agent restart etc.). ⚠️ If it persists, say so and exit (never keep people waiting silently)
      if (++misses >= 10) {
        console.log(
          t(
            '⚠️ agent と話せなくなりました。登録できたかは スマホの画面 か nyan devices で確かめてください',
            '⚠️ Lost contact with the agent. Check on the phone or with nyan devices whether it was registered',
          ),
        )
        process.exit(2)
      }
    } else {
      misses = 0
      if (st.state === 'registered') {
        const who = st.label ? t(`${st.label}（${st.deviceId}）`, `${st.label} (${st.deviceId})`) : st.deviceId
        console.log(
          st.already
            ? t(`✅ 登録済みの端末でした: ${who}`, `✅ Already registered: ${who}`)
            : t(`✅ 登録されました: ${who}`, `✅ Registered: ${who}`),
        )
        process.exit(0)
      }
      if (st.state === 'failed') {
        console.log(t(`✗ 登録に失敗しました: ${st.reason}（もう一度: nyan pair）`, `✗ Registration failed: ${st.reason} (try again: nyan pair)`))
        process.exit(1)
      }
      if (st.state === 'cancelled' || st.state === 'expired') {
        console.log(
          st.state === 'cancelled'
            ? t('⚠️ この QR は取り消されました', '⚠️ This QR was cancelled')
            : t('⚠️ 期限が切れました。もう一度: nyan pair', '⚠️ Expired. Try again: nyan pair'),
        )
        process.exit(1)
      }
    }
    await sleep(1000)
  }
} else if (asImage) {
  // ⚠️ Old agents (which return no id): we cannot ask whether it registered ⇒ only decide when to remove the image (as before)
  console.log(
    t(
      `  読み取ったら Enter（または Ctrl-C）。${Math.round(left() / 1000)} 秒経つと一時ファイルを消して終わります。`,
      `  Press Enter once scanned (or Ctrl-C). After ${Math.round(left() / 1000)} s the temporary file is deleted and it ends.`,
    ),
  )
  const rl = createInterface({ input: process.stdin })
  let timer
  await Promise.race([
    new Promise((r) => rl.once('line', r)),
    // ⚠️⚠️ **Do not `unref()`** — that makes **the process exit without waiting** (hit on 2026-09-22)
    new Promise((r) => {
      timer = setTimeout(r, left())
    }),
  ])
  clearTimeout(timer)
  rl.close()
}
