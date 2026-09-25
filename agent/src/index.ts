// Entry point of the agent.
//
// ⚠️ bind is fixed to 127.0.0.1. tailscale serve is the only way in (ARCHITECTURE.md §4.3).
//    Measured: other tailnet devices cannot reach WSL's ports (the Hyper-V firewall blocks them).
//    Do not open the port. Opening it creates an unauthenticated entry point (§4.2.1).

import { langFromEnv, setLang, t } from '../../shared/i18n.ts'
import { reasonText } from './reasons.ts'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { hostAllowed } from './hostCheck.ts'
import { hostname } from 'node:os'
import { devMode } from './auth.ts'
import { autoApproveList, loadAutoApprove, setAutoApproveExpiryHandler } from './autoApprove.ts'
import { discoverConfigDirs } from './claude/configDirs.ts'
import { seedHookState } from './claude/hookState.ts'
import { startSessionWatch } from './claude/sessionWatch.ts'
import { broadcast } from './events.ts'
import { pendingCount } from './permission.ts'
import { configProblem, loadConfig } from './config.ts'
import { loadAgentKey } from './deviceKey.ts'
import { devicesBroken, listDevices, loadDevices } from './devices.ts'
import { startRelay, stopRelay } from './relayRun.ts'
import { json } from './router.ts'
import { buildRouter } from './routes/index.ts'
import { handleRequest } from './serve.ts'
import { stopPushDeps } from './routes/hook.ts'
import { notifyAutoApproveExpired } from './routes/autoApprove.ts'
import { flushStopPushes, pendingStopPushes } from './stopPush.ts'
import { AGENT_VERSION, agentBuild } from './version.ts'
import { startAccount } from './account.ts'
import { stateDir, legacyStateProblem } from './state.ts'
import { beginMeasure, measureConnection, startFlushing } from './traffic.ts'

// ★★ The language of this process (logs, and replies to requests that carry no language / 2026-09-24). ⚠️ Decide it before anything else
//   ⚠️ Notification text is built in Japanese and translated right before sending (`localizeNotificationBody` in `shared/i18n.ts`), so it is not affected by this
setLang(langFromEnv(process.env))
// ★★ Read and freeze the version **at startup** (⚠️ if we wait until the first `/health`, a `git pull` in between makes the
//    old code claim the new version, and the "this machine is outdated" hint never shows / codex round 23, medium #3)
agentBuild()

async function main(): Promise<void> {
  // ★★ **Stop on leftovers from the rename before creating anything** (2026-09-19 / CLAUDE.md §0).
  //   ⚠️⚠️ `loadConfig()` **creates and writes** `hookToken` when missing, so placing this after it leaves
  //      "the old directory exists, yet a new empty directory was created".
  const legacy = await legacyStateProblem()
  if (legacy) {
    console.error(`[state] ${legacy}`)
    process.exitCode = 1
    return
  }
  const cfg = await loadConfig()
  // Restore status from the tail of hooks.jsonl so a restart does not lose it
  const seeded = await seedHookState()
  const router = buildRouter()

  // ★★ Load the auto-approve mode state (per session, with expiry / autoApprove.ts).
  //   ⚠️ Even if it is broken, **keep starting** (it just falls back to off). Unlike config.json,
  //      answering every request with 503 here would let one settings file stop the whole agent.
  //   ⚠️ Send exactly one notice on expiry (so nobody leaves it thinking it is still on).
  setAutoApproveExpiryHandler((entry) => void notifyAutoApproveExpired(entry))
  await loadAutoApprove()

  // ★★ Load registered devices (device keys of ③ / peers.ts).
  //   ⚠️ Even if broken, **keep starting**, but **refuse every device-key connection** (fail-closed).
  //      Today everything works over `via:'tailscale'` alone, so no operation is lost by this.
  //   ⚠️⚠️ The purpose of this layer is to remove "it broke, so treat it as first launch and reopen pairing"
  //      (ARCHITECTURE §14.1.2.5). ⇒ **Do not go back to falling back to defaults.**
  await loadDevices()

  // ★★ The agent's own static key (③ / deviceKey.ts). Created if missing.
  //   ⚠️⚠️ **Never recreate it when broken** (recreating changes the public key in the QR, and
  //      **every registered device stops connecting** = the same kind of accident as `vapid.json`).
  //   ⚠️ When unusable, only the device-key route stops (the Tailscale route works as before).
  // ★★ **Load registered devices before the key** (2026-09-24): when the key file is missing,
  //   having devices means "lost", not "first launch" (`recreated` in `deviceKey.ts`).
  //   ⚠️ If the records are broken we cannot count (`null` = there may have been some).
  await loadAgentKey(undefined, devicesBroken() ? null : listDevices().length)

  // ★★ The relay line (③ step 6 / relayRun.ts). **Does nothing without settings** (`local` only).
  //   ⚠️⚠️ Even if it is unusable the agent does not stop (only the relay route is lost). The reason
  //      goes to the log and to `relay` in `/health`. ⇒ Never create a **silent failure to connect**.
  // ★★ Account and license (2026-09-24 / billing / account.ts). ⚠️ Not awaited (a slow account must not delay startup).
  //   ⚠️ Start it before the relay line (read the local copy of the license first = it can be handed over right after connecting)
  void startAccount()
  startRelay(router)

  // ★ Make "responding" immediate (read the explanation in sessionWatch.ts).
  //
  //   No hook fires at the start of a turn, but `sessions/<pid>.json` turns `busy` at the same time.
  //   Watching it and emitting `sessions-changed` is enough to make it immediate.
  //   ⚠️ Do not use the `UserPromptSubmit` hook: it sits **in series on the input path**
  //      (when the agent is down, WSL does not fail fast, so typing freezes every time).
  //   ⚠️ Keep starting even if watching fails. It just falls back to 15s polling.
  let watcher: { close(): void } | undefined
  try {
    const dirs = await discoverConfigDirs(cfg.configDirs)
    const w = startSessionWatch(dirs, () => {
      broadcast({ type: 'sessions-changed', at: new Date().toISOString() })
    })
    watcher = w
    console.log(
      t(`[agent] セッション状態を監視: ${w.watched.length} 件`, `[agent] Watching session state: ${w.watched.length}`) +
        (w.failed.length > 0
          ? t(
              `（${w.failed.length} 件は監視できず15秒ポーリングに任せます）`,
              ` (${w.failed.length} could not be watched; falling back to 15s polling)`,
            )
          : ''),
    )
  } catch (err) {
    // ⚠️ Do not crash here. Only immediacy is lost; the feature still works through 15s polling
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(t(`[agent] セッション状態の監視を開始できません: ${msg}`, `[agent] Cannot start watching session state: ${msg}`))
  }

  const server = createServer((req, res) => {
    beginMeasure(req, res)
    // ★★ Refuse Host names that are not ours (DNS rebinding / `hostCheck.ts`). ⚠️ TCP only: the tunnel never comes through here
    if (!hostAllowed(req.headers.host)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'host not allowed' }))
      return
    }
    // ★★ There is only one pipeline, `serve.ts` (the tunnel goes through the same one / §14.1.2.22).
    //   ⚠️ HTTP may fall through to static serving (= route X, where the agent serves the PWA).
    handleRequest({ router, req, res, allowStatic: true }).catch((err: unknown) => {
      // ★ **The last safety net**. ⚠️ Assigning status codes is `serve.ts`'s job (2026-09-15 / codex medium #1).
      //   Putting the same conversion here means **only the tunnel side misses it** (it actually did).
      //   ⇒ This only makes sure the socket is not leaked.
      console.error(t('[agent] 道筋が例外を返しました:', '[agent] The request pipeline threw:'), err)
      res.destroy()
    })
  })

  // ★ Totals per connection (upload cannot be measured per request / see traffic.ts)
  server.on('connection', measureConnection)

  server.on('clientError', (_err, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })

  server.listen(cfg.port, cfg.host, () => {
    console.log(`[agent] nyan-remote ${AGENT_VERSION} on ${hostname()}`)
    console.log(t(`[agent] listening http://${cfg.host}:${cfg.port}  (loopback のみ)`, `[agent] listening http://${cfg.host}:${cfg.port}  (loopback only)`))
    console.log(`[agent] state: ${stateDir()}`)
    startFlushing()
    if (seeded > 0) console.log(t(`[agent] hook 状態を ${seeded} 件復元しました`, `[agent] Restored ${seeded} hook states`))
    if (devMode()) {
      console.log(t('[agent] ⚠️ DEV モード: 身元ヘッダ無しのアクセスを許可しています', '[agent] ⚠️ DEV mode: allowing access without identity headers'))
    }
    const broken = configProblem()
    if (broken) {
      // ⚠️ In refuse mode, "record the first login" would be a lie. Do not bury the log above
      console.error(
        t(
          `[agent] ⚠️⚠️ 拒否モードで待受中 — 全ての要求を 503 で拒否します（${broken.reason}）`,
          `[agent] ⚠️⚠️ Listening in refuse mode — every request gets 503 (${reasonText(broken.reason)})`,
        ),
      )
    } else if (cfg.allowedLogins.length === 0) {
      console.log(t('[agent] 許可ログイン未設定 — 最初に来た Tailscale-User-Login を記録します', '[agent] No allowed logins yet — the first Tailscale-User-Login will be recorded'))
    } else {
      console.log(t(`[agent] 許可ログイン: ${cfg.allowedLogins.join(', ')}`, `[agent] Allowed logins: ${cfg.allowedLogins.join(', ')}`))
    }
  })

  const shutdown = () => {
    // ★★ **Flush** pending end-of-turn notifications before exiting (2026-08-16 external review, high #1).
    //   ⚠️ The `Stop` notification waits 1.5s to look at the state. If we do not send it here,
    //      **it is lost on every deploy (systemctl restart)**. Notifications are why this tool exists.
    //   ⚠️ Crashes (SIGKILL, power loss) cannot be saved. **The 1.5s window remains** (stated in VERIFY).
    const waitingPush = pendingStopPushes()
    if (waitingPush > 0) {
      console.log(t(`[push] 終了する前に、待っている通知 ${waitingPush} 件を送ります`, `[push] Sending ${waitingPush} pending notifications before exiting`))
      void flushStopPushes(stopPushDeps()).finally(() => finish())
      // ⚠️ Exit even if sending fails (cut off after at most 2s)
      setTimeout(finish, 2000)
      return
    }
    finish()
  }

  let finishing = false
  const finish = () => {
    if (finishing) return
    finishing = true
    // ★ A restart kills pending approvals (the hook connection dies with the process).
    //   ⚠️ On 2026-08-13 we restarted 5 seconds after an approval appeared, and the phone's "Allow"
    //      hit a dead ticket and did nothing. **Log it so it can be noticed.**
    const waiting = pendingCount()
    if (waiting > 0) {
      console.warn(
        t(
          `[perm] ⚠️ 承認待ち ${waiting} 件を残して終了します。` +
            'この承認はスマホからは答えられなくなるので、PCの画面で答えてください',
          `[perm] ⚠️ Exiting with ${waiting} pending approvals. ` +
            'They can no longer be answered from the phone; answer them on the PC screen',
        ),
      )
    }
    // ★ Auto-approve **stays in effect after a restart until it expires** (it is persisted). Make it readable in the exit log
    const auto = autoApproveList()
    if (auto.length > 0) {
      console.warn(
        t(
          `[auto] ⚠️ 自動承認モードのセッションが ${auto.length} 件あります（再起動後も期限まで有効）: `,
          `[auto] ⚠️ ${auto.length} sessions are in auto-approve mode (still active after restart until expiry): `,
        ) +
          auto.map((e) => `${e.id.slice(0, 8)}→${e.until}`).join(', '),
      )
    }
    watcher?.close()
    // ★ Close the relay line too (⚠️ leave no pending subscriptions; keep exiting even if it fails)
    void stopRelay().catch(() => undefined)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err: unknown) => {
  console.error(t('[agent] 起動に失敗しました:', '[agent] Failed to start:'), err)
  process.exit(1)
})
