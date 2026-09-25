#!/usr/bin/env node
// Check whether there are pending approvals right now. **Always check this before restarting the agent.**
//
// ⚠️ Restarting kills pending approvals (the hook connections die with the process).
//    A killed approval can only be answered on the PC screen. On 2026-08-13 we restarted 5 seconds after an approval appeared,
//    the phone's "Allow" hit a dead card, and triaging the cause took time.
//
// ⚠️ Why a script: `/permissions` requires identity headers, so a hand-written curl
//    gets `Tailscale-User-Login` wrong and is rejected with "login not allowed" (hit this for real).
//    **The more you want a rule followed, the shorter the command to type.**
//
// Usage:
//   node scripts/pending.mjs        # list of pending approvals ("none" if there are none)
//   nyan pending (same as npm run pending)
//
// ★★ Exit code contract (split on 2026-09-23. **It is chained with `&&`**, so never mix them):
//   0 = no pending approvals (safe to restart)
//   1 = **approvals are pending** (answer them first)
//   2 = cannot reach the agent (stopped = no pending approvals either)
//   3 = **could not check** (cannot identify, unexpected response)
//   ⚠️⚠️ "cannot identify" used to be 1 too ⇒ **indistinguishable from "approvals pending"**.
//
// ★★ How we identify (2026-09-23): use **the hook token first**.
//   ⚠️⚠️ It used to be the tailnet login name only ⇒ **on relay-only machines (machine C, mac)
//      it failed every time and checked nothing** (= the guard against killing approvals was not working).
//   ⚠️ Old agents do not allow `/permissions` with the hook token ⇒ **only on 401/403,
//      retry with the tailnet login name**. The one-line update (`git pull && npm run pending && …`)
//      runs as "this new file × a still-old agent", so without this **the update itself stops**.

import { readFileSync } from 'node:fs'
import { t } from '../shared/i18n.ts'
import { initCliLang, agentUrl } from './lib/lang.mjs'
// ★★ **Unexpected exceptions always give 3** (2026-09-23 / codex round 13, medium #4).
//   ⚠️⚠️ By default Node exits with **1** on an uncaught exception = **the same as "approvals pending"**.
//      Even if each case above is caught, a missed spot added later does the same ⇒ set up a final net.
//   ⚠️⚠️ But an exception **after pending approvals are known** gives **1** (with 3, install.sh treats it as "could not check"
//      and **proceeds** = kills existing approvals). ⇒ Set `knownPending` as soon as it is known.
let knownPending = false
for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, (err) => {
    console.error(t(`✗ 想定外のエラー: ${err?.stack ?? err}`, `✗ Unexpected error: ${err?.stack ?? err}`))
    process.exit(knownPending ? 1 : 3)
  })
}
// ★ Language (right after the net above: the net builds no message until it fires,
//   and it must be in place first so that nothing can end with exit code 1 = "pending")
initCliLang()
import { homedir } from 'node:os'
import { join } from 'node:path'

// ⚠️ The state directory is located the same way the agent does (`NYAN_REMOTE_STATE_DIR` first / same as devices.mjs)
const stateDir = process.env.NYAN_REMOTE_STATE_DIR ?? join(homedir(), '.nyan-remote')

function config() {
  try {
    return JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8'))
  } catch {
    return {}
  }
}

const cfg = config()
const port = Number(process.env.NYAN_REMOTE_PORT ?? cfg.port ?? 7777)
// Identify as the first entry of the allow list (the login this machine's agent recorded)
const login = cfg.allowedLogins?.[0]
let token = ''
try {
  token = readFileSync(join(stateDir, 'hook-token'), 'utf8').trim()
} catch {
  // ⚠️ If absent, try with the tailnet login name only (below)
}

/** ★ Candidate ways to identify (⚠️ the order matters: hook token → tailnet login name) */
const ways = [
  ...(token ? [{ headers: { 'X-Nyan-Remote-Token': token } }] : []),
  // Same shape as what serve adds. The agent decides the route by the presence of headers (auth.ts)
  ...(login ? [{ headers: { 'Tailscale-User-Login': login, 'X-Forwarded-Proto': 'https' } }] : []),
]
if (ways.length === 0) {
  console.error(
    t(
      `✗ 名乗る材料がありません（${join(stateDir, 'hook-token')} も allowedLogins も無い）`,
      `✗ Nothing to authenticate with (neither ${join(stateDir, 'hook-token')} nor allowedLogins exists)`,
    ),
  )
  console.error(t('  agent を一度起動すると hook-token が作られます', '  hook-token is created when the agent starts once'))
  process.exit(3)
}

let res
for (const way of ways) {
  try {
    res = await fetch(agentUrl(port, '/permissions'), {
      headers: way.headers,
      signal: AbortSignal.timeout(5000),
    })
  } catch (err) {
    // ⚠️⚠️ **Separate "could not connect" from "no response"** (2026-09-23 / codex round 13, medium #4).
    //    Refused (ECONNREFUSED) = stopped ⇒ 2. **A timeout is 3** (not necessarily stopped:
    //    on WSL a dead 127.0.0.1 port does not fail immediately but **hangs for 8 seconds** / CLAUDE.md §4 =
    //    indistinguishable from a live agent that is stuck).
    if (err?.cause?.code === 'ECONNREFUSED') {
      console.error(t(`✗ agent に繋がりません（127.0.0.1:${port}）: 止まっています`, `✗ Cannot reach the agent (127.0.0.1:${port}): it is stopped`))
      console.error(
        t(
          '  止まっているなら承認待ちも無いので、再起動して問題ありません',
          '  A stopped agent has no pending approvals, so restarting is fine',
        ),
      )
      process.exit(2)
    }
    console.error(
      t(
        `✗ agent が応答しません（127.0.0.1:${port}）: ${err?.name ?? ''} ${err?.message ?? err}`,
        `✗ The agent does not respond (127.0.0.1:${port}): ${err?.name ?? ''} ${err?.message ?? err}`,
      ),
    )
    console.error(
      t(
        '  ⚠️ 止まっているとは限りません（固まっているだけかもしれない）。確かめられませんでした',
        '  ⚠️ It is not necessarily stopped (it may just be stuck). Could not check',
      ),
    )
    process.exit(3)
  }
  // ⚠️ Move to the next identification only when refused (old agents do not accept the hook token)
  if (res.status !== 401 && res.status !== 403) break
}

if (!res.ok) {
  // ⚠️⚠️ **Never mix with "approvals pending" (1)**. Could not check is 3
  // ⚠️ Read the body only once (t() builds both arguments = a second read would throw)
  const detail = (await res.text()).slice(0, 200)
  console.error(t(`✗ 確かめられませんでした（${res.status}）: ${detail}`, `✗ Could not check (${res.status}): ${detail}`))
  if (!login) {
    console.error(
      t(
        '  ⚠️ この agent は古い版かもしれません（hook トークンで承認待ちを読めない版）',
        '  ⚠️ This agent may be an old version (one that cannot list pending approvals with the hook token)',
      ),
    )
  }
  process.exit(3)
}

// ★★ **Check the shape of the response** (2026-09-23 / codex round 13, medium #4).
//   ⚠️⚠️ An exception on broken JSON or `{}` makes Node exit with **1** =
//      **indistinguishable from "approvals pending"**, which wrongly stopped install.sh's update.
//   ⇒ Unreadable or wrongly shaped is **could not check (3)**.
let body
try {
  body = await res.json()
} catch (err) {
  console.error(t(`✗ 応答を読めませんでした（JSON でない）: ${err?.message ?? err}`, `✗ Could not read the response (not JSON): ${err?.message ?? err}`))
  process.exit(3)
}
if (!body || typeof body !== 'object' || !Array.isArray(body.permissions)) {
  console.error(
    t(
      '✗ 応答の形が想定と違います（permissions がありません）。確かめられませんでした',
      '✗ Unexpected response shape (no permissions). Could not check',
    ),
  )
  process.exit(3)
}
// ★ From here on an exception means "they exist", not "there may be pending approvals" (the net returns 1)
// ⚠️⚠️ **Raise the flags one by one, as soon as each is known** (2026-09-23 / codex round 14, high #1).
//    - `quiet` (approvals being prepared) also counts as "exist". Looking only at `permissions`, an exception
//      while printing with `quiet > 0` returned **3**, and install.sh **proceeded and killed a live approval** (my regression when adding the net)
//    - ⚠️ "Raise them after reading everything" **loses an already-known "exist" to an exception mid-read**
//      (this actually happened mid-fix = crashing while reading `quiet` gave 3)
const permissions = body.permissions
knownPending = permissions.length > 0
const quiet = typeof body.quiet === 'number' ? body.quiet : 0
knownPending ||= quiet > 0
const autoApprove = Array.isArray(body.autoApprove) ? body.autoApprove : []

// ★★ Auto-approve mode (per session, with a deadline / agent/src/autoApprove.ts).
//   ⚠️⚠️ **This is no reason to block a restart** (no card is raised, so there is no approval to kill).
//      But **it is persisted, so it stays in effect after a restart until it expires**. It is a
//      "keeps running if you don't notice" feature, so it must always be readable on this screen.
if (autoApprove.length > 0) {
  console.log(
    t(
      `⚠️ 自動承認モード ${autoApprove.length} 件（再起動後も期限まで有効）`,
      `⚠️ Auto-approve mode: ${autoApprove.length} (stays on until it expires, even after a restart)`,
    ),
  )
  for (const a of autoApprove) {
    // ⚠️ **Never crash** on a malformed shape (do not change the exit code for display's sake)
    const left = Math.round((Date.parse(a?.until) - Date.now()) / 60000)
    console.log(
      t(
        `  ${String(a?.id ?? '?').slice(0, 8)}  残り ${left} 分（${new Date(a?.until ?? 0).toLocaleTimeString()} まで）`,
        `  ${String(a?.id ?? '?').slice(0, 8)}  ${left} min left (until ${new Date(a?.until ?? 0).toLocaleTimeString()})`,
      ),
    )
  }
  console.log('')
}
// ★★ `quiet` = approvals from subagents "not yet surfaced" (agent/src/permission.ts).
//    ⚠️ **Not being displayed does not make them any less an approval that must not be killed.**
//       Without adding it, for 6 seconds it answers "none" and **kills a live approval by restarting**
//       (2026-08-14 review, medium. What CLAUDE.md calls "the worst accident")
if (permissions.length === 0 && quiet === 0) {
  console.log(t('承認待ち: なし ✔ 再起動して安全です', 'Pending approvals: none ✔ safe to restart'))
  process.exit(0)
}

if (permissions.length === 0) {
  console.log(
    t(
      `⚠️ 承認待ち ${quiet} 件（サブエージェント由来。数秒後に表示されます）`,
      `⚠️ Pending approvals: ${quiet} (from subagents; they show up in a few seconds)`,
    ),
  )
  console.log(t('→ 少し待ってからもう一度確認してください', '→ Wait a moment and check again'))
  process.exit(1)
}

console.log(
  t(
    `⚠️ 承認待ち ${permissions.length} 件${quiet > 0 ? `（ほかに準備中 ${quiet} 件）` : ''} — 再起動すると**スマホからは答えられなくなります**`,
    `⚠️ Pending approvals: ${permissions.length}${quiet > 0 ? ` (plus ${quiet} being prepared)` : ''} — after a restart **they can no longer be answered from the phone**`,
  ),
)
for (const p of permissions) {
  // ⚠️ **Never crash** on a malformed shape (if they are known to exist, stopping with 1 is the job)
  const hhmm = new Date(p?.at ?? 0).toLocaleTimeString()
  console.log(`  ${hhmm}  [${p?.account ?? '?'}] ${p?.project ?? '?'}  ${p?.toolName ?? '?'}: ${String(p?.summary ?? '').slice(0, 60)}`)
}
console.log(t('\n→ 先に答えてから（スマホでもPCでも可）再起動してください', '\n→ Answer them first (on the phone or PC), then restart'))
process.exit(1)
