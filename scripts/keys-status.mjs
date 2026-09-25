#!/usr/bin/env node
// Shows "which sessions can receive instructions from the phone **without the wrapper** right now".
//
// ⚠️⚠️ When keystrokes are unavailable the symptom is "silently falls back to the inbox (= the English wrapper is added)",
//    and **it is indistinguishable on screen**. On 2026-08-23 we did the same triage 3 times, and
//    **a hand-written one-liner showed every session as "keystrokes OK" when there were 0**
//    (the glob did not expand and `*` was passed = fail-open on the diagnostic side).
//    ⇒ Provide **a tool that clearly says 0 when there are 0**.
//
// ★★★ **Do not own the decision** (rebuilt on 2026-08-23).
//
// ⚠️⚠️ At first it had an **independent implementation**, `classifyPane`, which disagreed with the real one (`findPane` in `keys.ts`)
//    **in 6 ways** (broken pane JSON / missing socket / pid mismatch /
//    missing procStart / unreadable `/proc` (**every session on mac**) / a pane record not in the index).
//    ⇒ **On mac it said "✅ N sessions accept keystrokes" while not one of them did**.
//    That was the exact opposite of the tool's purpose (eliminating fail-open diagnostics).
// ⇒ **Call `findPane` as is.** Never write "which state it is" in two places (CLAUDE.md §2).
//
// Usage: nyan keys (= node scripts/keys-status.mjs = npm run keys)

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { findPane } from '../agent/src/claude/keys.ts'
import { discoverConfigDirs } from '../agent/src/claude/configDirs.ts'
import { aliveProcStartSync, readIndexEntries } from '../agent/src/claude/sessionIndex.ts'
import { config } from '../agent/src/config.ts'
import { shellFor } from './install-relay.mjs'
import { recentLogLines, serviceKind } from './lib/service.mjs'
import { t } from '../shared/i18n.ts'
import { initCliLang } from './lib/lang.mjs'

const stateDir = process.env['NYAN_REMOTE_STATE_DIR'] ?? join(homedir(), '.nyan-remote')

/** Assessment of one session. ★ Ask `findPane` whether it accepts keystrokes (never decide here) */
export async function inspect(dirs, entry) {
  const target = await findPane(dirs, entry.sessionId)
  return {
    sessionId: entry.sessionId,
    pid: entry.pid,
    name: entry.name,
    cwd: entry.cwd,
    account: entry.account,
    ok: !('reason' in target),
    reason: 'reason' in target ? target.reason : undefined,
  }
}

// ⚠️ It is a function (calling `t()` at load time freezes the default before the language is decided)
function reasonNote() {
  return {
    'no-relay': t('relay 経由で起動していない（新しい窓で起こし直す）', 'not started through the relay (start it again from a new window)'),
    waiting: t('★ CLI がダイアログを出して待っている（打鍵しない）', '★ the CLI is showing a dialog and waiting (no keystrokes sent)'),
    broken: t('名乗りが壊れている', 'its pane record is broken'),
    unverified: t('同一性を確かめられない（mac は /proc が無いので常にこれ）', 'cannot verify its identity (always the case on mac, which has no /proc)'),
    ambiguous: t('同じ sessionId が複数ある', 'more than one entry has the same sessionId'),
    // ⚠️ `not-found` does not mean "not in the index" but "**that session has ended**"
    //    (if the pid was reused by another process, the `procStart` check rejects it and it lands here)
    'not-found': t('そのセッションは終了しています（pid が再利用されている等）', 'that session has ended (e.g. its pid was reused)'),
  }
}

/**
 * ★★ Read the record of the relay **refusing a keystroke connection** (2026-09-23 / actually happened on mac).
 *
 * ⚠️⚠️ We decided not to add an ACK, so the agent only knows "it wrote to the socket"
 *    ⇒ even when the relay refuses, **the agent logs "sent as keystrokes" and nothing shows on screen**.
 *    ⇒ `note_rejected` in `relay.py` leaves it next to the pane record (`<pid>.rejected`), so show it here.
 * ⚠️ `undefined` if absent (even when unreadable, never say "not refused" = say nothing).
 */
export function readRejected(dir, pid) {
  try {
    const j = JSON.parse(readFileSync(join(dir, `${pid}.rejected`), 'utf8'))
    return typeof j?.count === 'number' && j.count > 0 ? j : undefined
  } catch {
    return undefined
  }
}

function describe(r) {
  const head = `${r.ok ? '✅' : '⬜'} ${String(r.pid).padEnd(8)} ${(r.sessionId ?? '').slice(0, 8)}`
  const who = `${r.account ?? ''} ${r.name ?? t('(名前なし)', '(no name)')}  ${r.cwd ?? ''}`
  // ⚠️⚠️ **Even ✅ may be refused** (the target is found, but the relay closes the connection)
  const rej = readRejected(join(stateDir, 'panes'), r.pid)
  const rejLine = rej
    ? t(
        `\n      └ ⚠️⚠️ リレーが打鍵の接続を ${rej.count} 回 断っています（相手の身元を確かめられない）` +
          `\n         ⇒ 「打鍵で送りました」と出ても**画面には届いていません**`,
        `\n      └ ⚠️⚠️ The relay refused the keystroke connection ${rej.count} time(s) (could not verify the peer)` +
          `\n         ⇒ Even if it says "sent as keystrokes", **nothing reached the screen**`,
      )
    : ''
  if (r.ok) return `${head} ${who}${rejLine}`
  const notes = reasonNote()
  const note = notes[r.reason] ? t(`（${notes[r.reason]}）`, ` (${notes[r.reason]})`) : ''
  return `${head} ${who}\n      └ ${t('打鍵不可', 'No keystrokes')}: ${r.reason}${note}`
}

/** Say 0 when there are 0 (⚠️ this is the very lesson learned here) */
export function summarize(rows) {
  const ok = rows.filter((r) => r.ok)
  if (ok.length === 0) {
    const out = [t('❌ 打鍵できるセッションは 0 件', '❌ Sessions that accept keystrokes: 0')]
    if (rows.length === 0) {
      out.push(t('   ⇒ 生きているセッションが1つもありません', '   ⇒ There are no live sessions'))
    } else {
      out.push(
        t(
          `   ⇒ 生きているセッションは ${rows.length} 件ありますが、どれも打鍵できません:`,
          `   ⇒ ${rows.length} live session(s), but none accepts keystrokes:`,
        ),
      )
      for (const r of rows.slice(0, 12)) out.push(`      ${describe(r)}`)
    }
    out.push(
      t(
        '   ⇒ **新しい窓**から claude-r / claude-s を起こしてください（rc は新しいシェルからしか効きません）',
        '   ⇒ Start claude-r / claude-s from a **new window** (the rc only takes effect in a new shell)',
      ),
    )
    return out
  }
  const extra = rows.length !== ok.length ? t(`（ほか ${rows.length - ok.length} 件は不可）`, ` (${rows.length - ok.length} more cannot)`) : ''
  const lines = [t(`✅ 打鍵できるセッション ${ok.length} 件${extra}:`, `✅ Sessions that accept keystrokes: ${ok.length}${extra}:`)]
  for (const r of rows) lines.push(`   ${describe(r)}`)
  return lines
}

function shimCheck() {
  const shim = join(stateDir, 'bin', 'claude')
  // ⚠️ Ask with **a PATH that excludes the shim directory** (inheriting the parent's PATH
  //    gives ✅ even with no rc block at all / same reason as install-relay.mjs)
  const cleanPath = (process.env['PATH'] ?? '')
    .split(':')
    .filter((d) => d && resolve(d) !== resolve(join(stateDir, 'bin')))
    .join(':')
  // ⚠️ Wrap with sentinels so it does not mix with text rc files print to stdout (sudo hints etc.).
  //    ⚠️ Never write raw control characters in source (git treats the file as binary / CLAUDE.md §5)
  const MARK = '\u0001'
  // ★★ **Check with the user's shell** (2026-09-23 / it lied on mac).
  //   ⚠️⚠️ It used to hard-code `bash` ⇒ on mac (which writes `.zshrc`) it **always said ⚠️ even when it worked**.
  //   ⇒ Use **the same decision** as the writer (`install-relay.mjs`) (`shellFor` = derived from `rcPathFor`).
  const sh = shellFor(process.env['SHELL'], process.platform)
  const probe = (flags) => {
    try {
      const out = execFileSync(
        sh,
        [...flags, '-c', `printf "${MARK}%s${MARK}" "$(command -v claude)"`],
        {
          encoding: 'utf8',
          timeout: 15_000,
          stdio: ['ignore', 'pipe', 'ignore'],
          env: { ...process.env, PATH: cleanPath },
        },
      )
      return new RegExp(`${MARK}([^${MARK}]*)${MARK}`).exec(out)?.[1]?.trim() ?? ''
    } catch {
      return ''
    }
  }
  // ⚠️ Check with **login + interactive** (non-login only lies because of `.profile` ordering)
  const login = probe(['-l', '-i'])
  const plain = probe(['-i'])
  // ★ **Say what it was measured with** (in the affirmative. ⚠️ never rely on something invisible / CLAUDE.md §2)
  if (login === shim && plain === shim) {
    return [t(`✅ claude → ${shim}（shim。打鍵の入口 / ${sh} で確認）`, `✅ claude → ${shim} (shim, the keystroke entry / checked with ${sh})`)]
  }
  // ⚠️⚠️ **Never conclude "not reached" from "could not measure"** (2026-09-23).
  //    When it comes back empty because the shell cannot start or the rc is too slow, say **unknown**
  //    (concluding would tell people to "run it again" on a working install, creating needless work).
  if (!login && !plain) {
    return [
      t(`⚠️ shim に届いているかを測れませんでした（${sh} を起動できませんでした）。`, `⚠️ Could not check whether the shim is reached (could not start ${sh}).`),
      t('   ⇒ 下の「打鍵できるセッション」が ✅ なら、実際には届いています', '   ⇒ If "Sessions that accept keystrokes" below shows ✅, it is actually reached'),
    ]
  }
  return [
    t('⚠️⚠️ **shim に届いていません。** これから起こすセッションも受信箱に落ちます。', '⚠️⚠️ **The shim is not reached.** New sessions will also fall back to the inbox.'),
    t(`   調べたシェル              : ${sh}`, `   Shell checked                    : ${sh}`),
    t(
      `   ログイン+対話（実際の端末）: ${login || '（測れませんでした）'}`,
      `   Login + interactive (real term.) : ${login || '(could not check)'}`,
    ),
    t(`   対話のみ                  : ${plain || '（測れませんでした）'}`, `   Interactive only                 : ${plain || '(could not check)'}`),
    t('   ⇒ node scripts/install-relay.mjs を流し直してください', '   ⇒ Run node scripts/install-relay.mjs again'),
  ]
}

/** ★ Count leftover pane records (left behind by SIGKILL etc.) */
function orphanNote(rows) {
  let panes = []
  try {
    panes = readdirSync(join(stateDir, 'panes')).filter((n) => n.endsWith('.json'))
  } catch {
    return []
  }
  const live = new Set(rows.map((r) => String(r.pid)))
  const orphans = panes.filter((n) => !live.has(n.replace(/\.json$/, '')))
  if (orphans.length === 0) return []
  return [
    t(
      `⬜ 掃除されていない名乗りが ${orphans.length} 件（誤配は procStart の照合で防いでいます）`,
      `⬜ ${orphans.length} leftover pane record(s) (misdelivery is prevented by the procStart check)`,
    ),
  ]
}

function recentLog() {
  // ★ How to read logs per service type lives in one place, service.mjs (⚠️ never call journalctl on mac)
  return recentLogLines(serviceKind(process.platform, homedir()), homedir())
    .filter((l) => l.includes('[keys]') || l.includes('[inbox]'))
    .slice(-5)
}

async function main() {
  for (const l of shimCheck()) console.log(l)
  console.log('')
  let dirs = []
  try {
    dirs = await discoverConfigDirs(config().configDirs)
  } catch {
    dirs = await discoverConfigDirs(null)
  }
  const rows = []
  for (const dir of dirs) {
    const entries = await readIndexEntries(dir)
    if (!entries) continue
    for (const e of entries) {
      if (!e.sessionId || e.pid === undefined) continue
      // ⚠️ **Do not show old index entries of dead pids** (`findPane` returns `not-found`, so
      //    it would show "not found in the index", which is confusing. A real machine had 20 months-old records)
      if (aliveProcStartSync(e.pid) === null) continue
      rows.push(await inspect(dirs, { ...e, account: `[${dir.account}]` }))
    }
  }
  rows.sort((a, b) => (a.ok === b.ok ? (a.pid ?? 0) - (b.pid ?? 0) : a.ok ? -1 : 1))
  for (const l of summarize(rows)) console.log(l)
  for (const l of orphanNote(rows)) console.log(l)
  const log = recentLog()
  if (log.length) {
    console.log('')
    console.log(t('直近の送信:', 'Recent sends:'))
    for (const l of log) console.log(`   ${l}`)
  }
}

if (process.argv[1] && process.argv[1].endsWith('keys-status.mjs')) {
  // ★ Language first (before any message is built). ⚠️ Not at module top level: tests import this file
  initCliLang()
  await main()
}
