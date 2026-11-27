// Entry point of the agent.
//
// ⚠️ bind is fixed to 127.0.0.1. tailscale serve is the only way in (ARCHITECTURE.md §4.3).
//    Measured: other tailnet devices cannot reach WSL's ports (the Hyper-V firewall blocks them).
//    Do not open the port. Opening it creates an unauthenticated entry point (§4.2.1).

import { recordLimitStop, SAMPLE_MS, usageHistory } from './usageHistory.ts'
import { usage } from './routes/usage.ts'
import { startAgyWatch } from './agy/watch.ts'
import { endAgyGrantsOver } from './agy/grants.ts'
import { AGY_ACCOUNT, AGY_PREFIX, agyDir, agyChildrenSettledSeen, agyOthersWrote, agyOwnRowOf, agyOwnRows, conversationOf, defaultAgyDeps, transcriptPathOf, withLocksProbed } from './agy/sessions.ts'
import { lastTurnStartCached, readTailRecords, turnEnd } from './agy/pending.ts'
import { AgyCards } from './agy/cards.ts'
import { homedir } from 'node:os'
import { aliveProcStartSync } from './claude/sessionIndex.ts'
import { scanAgyBlocked } from './agy/blocked.ts'
import { AgyNotifier } from './agy/notify.ts'
import { answerAgyCard, answerAgyQuestion, answerAgyChildApproval } from './agy/keys.ts'

/** ★ How often agy cards and notifications are looked at besides the watcher (a missed file event) */
const AGY_LOOK_MS = 5000
import { langFromEnv, setLang, t } from '../../shared/i18n.ts'
import { reasonText } from './reasons.ts'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { hostAllowed } from './hostCheck.ts'
import { watchServe } from './tailscale.ts'
import { devMode } from './auth.ts'
import { autoApproveFor, autoApproveList, endCodexAutoApproveOutside, endSessionAutoApprove, loadAutoApprove, setAutoApproveExpiryHandler } from './autoApprove.ts'
import { discoverConfigDirs } from './claude/configDirs.ts'
import { seedHookState } from './claude/hookState.ts'
import { startSessionWatch } from './claude/sessionWatch.ts'
import { uploads } from './uploads.ts'
import { CODEX_FOLLOW_TICK_MS, codexFollowTick, codexLabelShared, codexLastWords, codexRowsNow, startCodex } from './codex/run.ts'
import { agyCardsChanged, agyMemberDone, agyTeamSafetyNet, agyTeamPcWaits, agyPhoneFallback, codexCardsChanged, codexMemberState, codexRowStatus, codexSnapshot, sessionEnded } from './teamHooks.ts'
import { startTeamSocket } from './teamSocket.ts'
import { codexPayload } from './codex/notify.ts'
import { sendToAll } from './push.ts'
import { withPendingPerms } from './permission.ts'
import { toPushPayload } from './routes/hook.ts'
import { broadcast, followedSessions, notifyFollowers } from './events.ts'
import { noteFirstSeen, pendingCount } from './permission.ts'
import { config, configProblem, loadConfig } from './config.ts'
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
import { machineName, machineNameProblem } from './machine.ts'

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

  // ★ agy conversations (docs/AGY.md): say "sessions changed" when one changes state. ⚠️ Never fatal (polling remains)
  let agyWatcher: { close(): void; check(): void } | undefined
  // ★ agy approval cards and notifications (docs/AGY.md §9): looked at on every status file change, and every few
  //   seconds in case watching fails. ⚠️ Never throws into the watcher or the timer.
  const agyCards = new AgyCards({
    agy: () => ({ ...defaultAgyDeps(), aliveProcStart: aliveProcStartSync }),
    machine: machineName(),
    answer: (conv, mark, behavior, stillWanted) => answerAgyCard(conv, mark, behavior, undefined, undefined, stillWanted),
    // ★ Questions answered from the phone (docs/AGY.md §13)
    answerQuestion: (conv, mark, answer, stillWanted) => answerAgyQuestion(conv, mark, answer, undefined, undefined, stillWanted),
    // ★ Subagents' command approvals answered from the phone (agy 1.5.16+ / docs/AGY.md §19, case 8)
    answerChildApproval: (conv, mark, behavior, stillWanted) => answerAgyChildApproval(conv, mark, behavior, undefined, undefined, stillWanted),
    changed: () => {
      broadcast({ type: 'permissions-changed', machine: machineName(), at: new Date().toISOString() })
      // ★ Teams: each new agy card the leader may answer is announced to it once (`teamHooks.ts` / docs/TEAM.md §9)
      agyCardsChanged()
    },
    now: () => new Date(),
    log: (line) => console.log(line),
    // ★ The card came back after a key that did not land: ring "needs you" again (`notify.ts` rule 11)
    reraised: (conv, card, once) => {
      agyNotifier.owe(`agy-${conv}`, card, once)
      void agyNotifier.look()
    },
  })
  const agyNotifier: AgyNotifier = new AgyNotifier({
    // ★ Each lock-holding agy's own state (`notify.ts` rule 8)
    // ⚠️ Locks probed all at once without blocking (a Mac's `lsof` / `withLocksProbed`)
    rows: async () => agyOwnRows(machineName(), await withLocksProbed({ ...defaultAgyDeps(), aliveProcStart: aliveProcStartSync })),
    // ★ Usage history (`usageHistory.ts`): agy's login is one (`AGY_ACCOUNT`)
    onLimit: (sessionId, stop) => recordLimitStop('agy', AGY_ACCOUNT, `${sessionId}:${stop}`),
    statusNow: (sessionId) => {
      const conv = conversationOf(sessionId)
      // ★ Only that conversation's agy is probed (the guard runs before each device's send)
      const row = conv === undefined ? undefined : agyOwnRowOf(machineName(), { ...defaultAgyDeps(), aliveProcStart: aliveProcStartSync }, conv)
      if (row === undefined || conv === undefined) return undefined
      const path = transcriptPathOf(conv)
      const end = turnEnd(readTailRecords(path))
      // ★ The card is this agy's own state write (as `notify.ts` `cardOf`)
      return { status: row.status, turn: end.turn ?? lastTurnStartCached(path)?.turn, ...(row.status === 'waiting' ? { card: row.lastActivity } : {}) }
    },
    turnStart: (sessionId) => {
      const conv = conversationOf(sessionId)
      return conv === undefined ? undefined : lastTurnStartCached(transcriptPathOf(conv))
    },
    // ⚠️ Locks probed without blocking (a Mac's `lsof`); a probe that fails ⇒ undefined (the push waits, `notify.ts`)
    // ★ Rule 7b: "done" on an answer seen `idle` only when its children reported and finished well (`agyChildrenSettled`)
    childrenSettled: (sessionId) => {
      const conv = conversationOf(sessionId)
      return conv !== undefined && agyChildrenSettledSeen(conv)
    },
    othersWrote: async (sessionId, since) => {
      const conv = conversationOf(sessionId)
      if (conv === undefined) return true
      const d = await withLocksProbed(defaultAgyDeps())
      return agyOthersWrote(d.dir, conv, since, d.isAgy, d.locksOf!)
    },
    home: homedir(),
    // ★ A card auto-approve answers does not ring (`cards.ts` rule 5b)
    //   ⚠️ The cards look again first when it is on (a card written after their last look and before this snapshot was
    //      not decided yet, and rang / codex review). `sync` settles after a look that started after the call.
    quiet: async (sessionId, card) => {
      const conv = conversationOf(sessionId)
      if (conv === undefined || autoApproveFor(sessionId) === undefined) return false
      await agyCards.fresh()
      if (agyCards.autoAnswering(conv, card)) return true
      // cannot tell now ⇒ the notifier holds it back for a few looks
      return agyCards.unsureAbout(conv) ? undefined : false
    },
    // ★ The same text builder and sender as Claude and Codex
    send: async (row, fields, current) => {
      const push = async (guard?: () => boolean): Promise<number> =>
        (await sendToAll(withPendingPerms(codexPayload(row, fields, new Date().toISOString(), toPushPayload)), undefined, () => (current?.() ?? true) && (guard?.() ?? true))).sent
      // ★ A team member (docs/TEAM.md §9): its turn end is reported to the leader instead of ringing; the phone rings
      //   when that report does not get through (its own count: a failed push is tried again by the notifier)
      // ⚠️ A member's "done" is not sent to the phone once the leader got that turn (`agyPhoneFallback`)
      // ★ With the completion's own turn when known (codex review: the latest turn, read later, was another one)
      const fallback = (turn?: { turn: number; at: number }): Promise<number> =>
        agyPhoneFallback(row.sessionId, fields.label, push, turn === undefined ? undefined : () => turn)
      return (await agyMemberDone(row, fields.label, fallback, undefined, current)) ?? fallback()
    },
    log: (line) => console.log(line),
  })
  // ★ Cards first: the notifier asks which card auto-approve is answering (`quiet`), decided by the cards' look
  const agyLook = (): void => {
    // ★ Then the team safety net (a member's turn the leader was not told about / docs/TEAM.md §9.2)
    // ★ One card look for both (agy review: two `fresh()` calls ran every look twice)
    // ★ With the subagents waiting on an approval only the PC can answer (`agy/blocked.ts` / docs/AGY.md §19, case 8):
    //   read before the notifier and the leaders' notices look, so they see it the same look
    const cards = Promise.all([
      agyCards.fresh(),
      scanAgyBlocked().then((changed) => {
        if (changed) broadcast({ type: 'sessions-changed', at: new Date().toISOString() })
      }),
    ])
    void cards.then(() => agyNotifier.look())
    // ★ Then the team safety net — not behind the notifier's queue (codex review: a stalled phone push held it, and a
    //   member's stop was never told)
    void cards.then(() => agyTeamSafetyNet())
    // ★ And the leaders' "waits for the PC" notices (docs/TEAM.md §9.3), apart from the net
    void cards.then(() => agyTeamPcWaits())
    void endAgyAutoApproveGone().catch(() => undefined)
  }
  // ★ An agy grant whose agy no longer shows the conversation (it exited, moved on, or this agent restarted and forgot
  //   which agy it was for) is ended, like Claude's `SessionEnd` (docs/AGY.md §10 / `grants.ts`). Only while one is on.
  const endAgyAutoApproveGone = async (): Promise<void> => {
    // ⚠️ The grants first, then the probe (one turned on during the probe is not judged by a lock seen before it)
    const entries = autoApproveList().filter((e) => e.id.startsWith(AGY_PREFIX))
    if (entries.length === 0) return
    const ended = await endAgyGrantsOver(entries, await withLocksProbed({ ...defaultAgyDeps(), aliveProcStart: aliveProcStartSync }), (l) => console.warn(l))
    if (ended.length === 0) return
    broadcast({ type: 'sessions-changed', at: new Date().toISOString() })
    // ★ A card the grant would have answered is now the person's: the cards raise it on the phone and the notifier
    //   rings it (a waiting card rings even on the agent's first look / `notify.ts` rule 3)
    agyLook()
  }
  agyLook()
  // ★ With the watcher, the periodic look goes through it: the list is told when a status changed without a status file
  //   (a limit's error record in the transcript / codex review). Its look ends with `agyLook` as well.
  setInterval(() => (agyWatcher ? agyWatcher.check() : agyLook()), AGY_LOOK_MS).unref()

  // ★ Usage history (2026-11-27 / `usageHistory.ts`): read the limits every 15 minutes, keep what changed. On this PC
  //   only. ⚠️ Never fatal: a reading that fails is skipped until the next round.
  usageHistory()
  // ⚠️ One reading at a time: a stuck read must not pile up more of them (codex review)
  let sampling = false
  const sampleUsage = (): void => {
    if (sampling) return
    sampling = true
    // ⚠️ Not a Codex home whose label another home shares (cannot be told apart, even when only one has a reading)
    void usage()
      .then((r) => usageHistory().sample(r.usage.filter((u) => !(u.tool === 'codex' && codexLabelShared(u.account)))))
      .catch((err: unknown) => console.warn(`[usage-history] could not read the limits: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        sampling = false
      })
  }
  // ★ Soon after start, so a stop right after a restart is filed under the account behind its profile
  setTimeout(sampleUsage, 5_000).unref()
  // …and once more after the Codex reading cache has expired (it may still have been connecting at five seconds)
  setTimeout(sampleUsage, 75_000).unref()
  setInterval(sampleUsage, SAMPLE_MS).unref()
  try {
    agyWatcher = await startAgyWatch(agyDir(), () => broadcast({ type: 'sessions-changed', at: new Date().toISOString() }), agyLook)
  } catch {
    // no immediacy for agy rows; the list still polls
  }

  // ★ Codex sessions (docs/CODEX.md). ⚠️ On unless `codex.enabled` is false: connects to the user's Codex daemon under
  //   our name (said once in the log on the first connect). ⚠️ Never awaited and never fatal: no daemon = no Codex rows.
  {
    let pending: NodeJS.Timeout | undefined
    const n = startCodex(cfg.codex, {
      machine: machineName(),
      version: AGENT_VERSION,
      // ★ The same cap as Claude's sessions per account (closed Codex threads per home)
      historyLimit: cfg.maxSessionsPerAccount,
      hooks: {
        // ★ Coalesce: one turn produces several status changes within milliseconds
        onChange: () => {
          pending ??= setTimeout(() => {
            pending = undefined
            broadcast({ type: 'sessions-changed', at: new Date().toISOString() })
          }, 100)
        },
        log: (line) => console.log(line),
        // ★ Teams: when a request was first seen, by its replay-stable origin (`permission.ts`)
        noteSeen: (origin) => noteFirstSeen(origin),
        // ★ A closed thread ends its auto-approve entry, like `SessionEnd` does for Claude (never left on for a
        //   thread nobody is running). ⚠️ Never throws into the daemon line.
        onClosed: (threadId) => {
          // ★ Teams: a closed member leaves its team (`teamHooks.ts`)
          sessionEnded(threadId)
          void endSessionAutoApprove(threadId)
            .then((r) => {
              if (r.had) broadcast({ type: 'sessions-changed', at: new Date().toISOString() })
              if (!r.ok) console.warn(`[auto] ⚠️ could not save the end of auto-approve for a closed Codex thread (${r.reason})`)
            })
            .catch(() => undefined)
        },
        // ★ Threads that closed while nobody listened (line down, agent off): their entries end too
        onLoadedSnapshot: (prefix, loaded) => {
          // ★ Teams: Codex members that closed while nobody listened leave their team (`teamHooks.ts`)
          codexSnapshot(prefix, loaded)
          void endCodexAutoApproveOutside(prefix, loaded)
            .then((r) => {
              if (r.ended > 0) broadcast({ type: 'sessions-changed', at: new Date().toISOString() })
              if (r.failed) console.warn(`[auto] ⚠️ could not save the end of auto-approve for a closed Codex thread (${r.failed})`)
            })
            .catch(() => undefined)
        },
      },
      // ★ The same text builder and the same sender as the Claude side (`toPushPayload` → `sendToAll`)
      notify: async (row, fields, turn, current) => {
        const send = async (guard?: () => boolean): Promise<number> =>
          (await sendToAll(withPendingPerms(codexPayload(row, fields, new Date().toISOString(), toPushPayload)), undefined, guard)).sent
        // ★ A team member (docs/TEAM.md §4.6): its turn end is reported to the leader instead of ringing (the phone
        //   rings if that report does not get through). ⚠️ 0 = not sent now (not remembered)
        const held = codexMemberState(
          row,
          fields.label,
          // ★ A late fallback rings only while this change is still the thread's latest (its status mark)
          //   ⚠️ A row gone with a reconnect is not a newer state: the mark check applies only while the row is listed
          (guard) =>
            void send(() => {
              const listed = codexRowsNow().some((x) => x.sessionId === row.sessionId)
              return (!listed || (current?.() ?? true)) && (guard?.() ?? true)
            }).catch(() => undefined),
          async () => (turn ? codexLastWords(row.sessionId, turn) : undefined),
        )
        return held ? 0 : send()
      },
      // ★ Teams: a member waiting at the grant is released on its first real transition out of waiting (`teamHooks.ts`)
      onRowStatus: (sessionId, to) => codexRowStatus(sessionId, to),
      // ★ Approvals: the cards live in the same store as the Claude ones; the phones only need to read it again
      cardsChanged: () => {
        broadcast({ type: 'permissions-changed', machine: machineName(), at: new Date().toISOString() })
        // ★ Teams: each new Codex card the leader may answer is announced to it once (`teamHooks.ts`)
        codexCardsChanged()
      },
    })
    if (n > 0) {
      console.log(t(`[codex] Codex の daemon を見張ります: ${n} 件`, `[codex] Watching Codex daemons: ${n}`))
      // ★ Follow watch (`codexFollowTick`): asks the local daemon only while a phone is viewing a Codex thread.
      //   ⚠️ One round at a time (a slow daemon must not pile rounds up); never throws into the timer.
      let busy = false
      setInterval(() => {
        if (busy) return
        busy = true
        codexFollowTick(followedSessions())
          .then((ids) => {
            for (const id of ids) notifyFollowers(id)
          })
          .catch(() => undefined)
          .finally(() => {
            busy = false
          })
      }, CODEX_FOLLOW_TICK_MS).unref()
    }
  }

  // ★ Whether tailscale serve forwards to us (Tailscale identity headers count only then / `tailscale.ts`)
  await watchServe(cfg.port)

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

  // ★ Files from the phone: expired uploads and week-old files go on a timer, not only when someone uploads (uploads.ts)
  uploads.startSweeping()
  // ★ Teams (`/nyan-team`): their routes live only on a Unix socket in the state directory (`teamSocket.ts`). Never fatal
  void startTeamSocket()
  server.listen(cfg.port, cfg.host, () => {
    console.log(`[agent] nyan-remote ${AGENT_VERSION} on ${machineName()}`)
    const badName = machineNameProblem(config().machineName)
    if (badName) console.warn(badName)
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
    // ⚠️ agy grants are memory only: they end here (docs/AGY.md §10)
    const agyAuto = autoApproveList().filter((e) => e.id.startsWith(AGY_PREFIX))
    if (agyAuto.length > 0) {
      console.warn(
        t(`[auto] ⚠️ agy の自動承認 ${agyAuto.length} 件はこの終了で切れます`, `[auto] ⚠️ ${agyAuto.length} agy auto-approve grants end with this exit`),
      )
    }
    const auto = autoApproveList().filter((e) => !e.id.startsWith(AGY_PREFIX))
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
    agyWatcher?.close()
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
