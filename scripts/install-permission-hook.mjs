#!/usr/bin/env node
// Install the hook that lets approvals be answered from the phone into every account on this machine (M4-1).
//
// ★ Why a script:
//   the settings exist **per account and per machine** (`~/.claude` / `~/.claude-r` / `~/.claude-s` …).
//   Even 1 machine with 2 accounts means 4 files (6 in practice), and editing by hand always misses one.
//   We really did miss one: "installed only in machine A's .claude-r, so approvals from machine B's .claude-s never arrived"
//   (2026-08-12).
//
// ⚠️ The token differs per machine (`~/.nyan-remote/hook-token`). Another machine's value does not work.
//    This script reads **the token of the machine it runs on**, so run it once on each machine.
//
// Usage:
//   node scripts/install-permission-hook.mjs                 # install (waits 24 hours by default)
//   node scripts/install-permission-hook.mjs --timeout 1800  # change the wait time (for trials)
//   node scripts/install-permission-hook.mjs --remove        # remove
//   node scripts/install-permission-hook.mjs --dry-run       # only show what it would do
//
// ⚠️ Settings files are replaced in the order backup → temp file → verify → rename
//    (the CLAUDE.md convention. Breaking them stops Claude Code from starting).

import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { t } from '../shared/i18n.ts'
import { initCliLang } from './lib/lang.mjs'

initCliLang()

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const valueOf = (f, d) => {
  const i = args.indexOf(f)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}

const REMOVE = has('--remove')
const DRY = has('--dry-run')
/** The default is 24 hours. ★ While waiting the prompt is also shown on the PC, so a long wait costs nothing (measured) */
const TIMEOUT = Number(valueOf('--timeout', '86400'))
/**
 * ★★ The port is decided like the agent does (`--port` > `NYAN_REMOTE_PORT` > `port` in `config.json` > 7777).
 * ⚠️⚠️ It used to ignore `config.json` ⇒ when `nyan update` reinstalled the hooks on a machine with a custom port,
 *    **hooks for 7777 were added and approvals were doubled** (if something else listens on 7777, the hook token goes there /
 *    codex round 23, medium #2). Same order as `pending.mjs` / `devices.mjs` / `pair.mjs`.
 */
/**
 * ★★ Decide the state directory **once** and use it for both the port (`config.json`) and the token (`hook-token`)
 *   (same as the agent: `NYAN_REMOTE_STATE_DIR` > `~/.nyan-remote`).
 * ⚠️⚠️ When they were decided separately, a machine with a custom state directory read **the port from the given place and the token from the default**,
 *    and the approval hook was rejected by auth (codex round 24, medium #4).
 */
const STATE_DIR = process.env.NYAN_REMOTE_STATE_DIR ?? join(homedir(), '.nyan-remote')

function configPort() {
  try {
    const p = JSON.parse(readFileSync(join(STATE_DIR, 'config.json'), 'utf8'))?.port
    return Number.isInteger(p) && p > 0 && p < 65536 ? String(p) : undefined
  } catch {
    return undefined
  }
}
const PORT = Number(valueOf('--port', process.env.NYAN_REMOTE_PORT ?? configPort() ?? '7777'))
const NAME = /^\.claude(-[A-Za-z0-9._-]+)?$/

if (!Number.isFinite(TIMEOUT) || TIMEOUT <= 0) {
  console.error(t('--timeout は正の秒数で指定してください', '--timeout must be a positive number of seconds'))
  process.exit(2)
}

const home = homedir()
const tokenPath = join(STATE_DIR, 'hook-token')
let token = ''
if (!REMOVE) {
  if (!existsSync(tokenPath)) {
    console.error(t(`✗ ${tokenPath} がありません。agent を一度起動してから実行してください`, `✗ ${tokenPath} does not exist. Start the agent once, then run this again`))
    process.exit(1)
  }
  token = readFileSync(tokenPath, 'utf8').trim()
  if (!token) {
    console.error(t(`✗ ${tokenPath} が空です`, `✗ ${tokenPath} is empty`))
    process.exit(1)
  }
}

/** Target ~/.claude* directories that have projects/ (same rule as the agent's configDirs.ts) */
function configDirs() {
  const out = []
  for (const name of readdirSync(home).sort()) {
    if (!NAME.test(name)) continue
    const dir = join(home, name)
    try {
      if (!statSync(join(dir, 'projects')).isDirectory()) continue
    } catch {
      continue
    }
    out.push(dir)
  }
  return out
}

const URL_OURS = `http://127.0.0.1:${PORT}/permission`

function hookEntry() {
  return {
    matcher: '',
    hooks: [
      {
        // ★ type:"http", so no shell script is needed. The JSON response becomes the decision as is
        type: 'http',
        url: URL_OURS,
        // ⚠️ The agent waits without responding. While it waits, a Push goes out
        timeout: TIMEOUT,
        headers: { Authorization: `Bearer ${token}` },
      },
    ],
  }
}

/** Is this a hook we manage (identified by url) */
function isOurs(h) {
  return h && typeof h === 'object' && h.type === 'http' && h.url === URL_OURS
}

/**
 * ★★ One more: `MessageDisplay` (added 2026-08-21).
 *
 * Why it is needed: the CLI writes the transcript in batches, and **while waiting for the human's answer
 * it stops flushing** (measured: 0 bytes for 93 seconds → +10KB the moment it was answered).
 * ⇒ **The approval card's "preceding explanation" is structurally always missing**. So we intercept it and keep it.
 *
 * ⚠️⚠️ **Never make it `type: 'http'`.** This hook is called in the CLI's **render path**
 *    (`forceSyncExecution: true` / measured about every 0.7 seconds). Calling the agent means that when the agent is slow
 *    or down, **the user's screen freezes** (rejected for the same reason as CLAUDE.md §4).
 *    ⇒ A shell script that **only writes one line to a file** (measured 2.6ms = 0.37% of rendering).
 *
 * ⚠️ Point **directly at the repository path**, not a copy. `notify.sh` was installed as a copy,
 *    and we once wrongly said "`git pull` applies it" (CLAUDE.md §3).
 * ⚠️ If the repository disappears the hook fails, but **on failure the original text is shown** by contract, so it errs on the safe side.
 */
const MSG_COMMAND = join(fileURLToPath(new URL('..', import.meta.url)), 'hooks', 'message-display.sh')
// ⚠️ **Keep it short** (2026-08-21 `/code-review` medium #3). When writing stalls (disk full,
//    a frozen FS), the hook waits until the timeout, and that **repeats about every 0.7 seconds**
//    = rendering effectively stops. ⇒ Err on the side of "give up when stuck".
const MSG_TIMEOUT = 2

/**
 * ★ Quote it for the shell (2026-08-21 codex medium #9).
 *
 * ⚠️ `command` is **run by a shell**, so a space in the path makes it try to run something else and
 *    **the hook never arrives**. And since by contract "on failure the original text is shown",
 *    **the user sees nothing** (the hardest shape to triage).
 * ⚠️ Paths containing `'` are not broken either: close and reopen with `'\''`.
 */
function shQuote(p) {
  return `'${String(p).replace(/'/g, `'\\''`)}'`
}

function msgHookEntry() {
  return {
    matcher: '',
    hooks: [{ type: 'command', command: shQuote(MSG_COMMAND), timeout: MSG_TIMEOUT }],
  }
}

/**
 * Is this a text hook **we installed**?
 *
 * ⚠️⚠️ **Never judge with "contains" (includes)** (both reviews on 2026-08-21).
 *    `applyEvent` removes "ours" then re-adds it, so a loose match would **silently remove**, on the next install or `--remove`,
 *    **wrappers the user wrote** (`timeout 2 …/message-display.sh 2>>/tmp/log`) or
 *    **entries pointing at another clone**.
 * ⚠️ To also catch the shape installed before quoting (the raw path), check **exact matches of both**.
 */
function isOursMsg(h) {
  if (!h || typeof h !== 'object' || h.type !== 'command' || typeof h.command !== 'string') {
    return false
  }
  return h.command === MSG_COMMAND || h.command === shQuote(MSG_COMMAND)
}

// ─────────────────────────────────────────────────────────────────────────────
// ★★ Notification source (`notify.sh`) — **folded in here** on 2026-09-21.
//
// ⚠️⚠️ It used to be a **manual step** in `docs/SETUP.md` (paste python that writes settings.json).
//    ⇒ For people who installed via `install.sh`, `notify.sh` was **only placed and never wired up**, so
//      **not a single notification was sent** (= the product's main feature did not work). Noticed in practice:
//      "test notifications arrive, but turn-finished notifications do not".
// ★ Use `$HOME` with `type:'command'` (it **runs through a shell**, so embedding an absolute path
//    would need rewriting per machine / carries over SETUP.md's decision as is).
// ⚠️ All 3 accounts call **the single `$HOME/.claude/hooks/notify.sh`** (one copy to distribute is enough).
// ─────────────────────────────────────────────────────────────────────────────

/** ⚠️ Keep the double quotes **as is** (the shell expands `$HOME`; passing it through `shQuote` would stop the expansion) */
const NOTIFY_COMMAND = '"$HOME/.claude/hooks/notify.sh"'
const NOTIFY_PATH = join(home, '.claude', 'hooks', 'notify.sh')

/**
 * ★ Which events to forward.
 * ⚠️ `Stop` does not mean "done" but **the turn ended** (SETUP.md §1 / 2026-08-16).
 * ⚠️ Do not drop `StopFailure` (directly addresses "stopped with an error and nobody noticed").
 */
const NOTIFY_EVENTS = ['Stop', 'StopFailure', 'Notification']

function notifyHookEntry() {
  return { matcher: '', hooks: [{ type: 'command', command: NOTIFY_COMMAND }] }
}

/**
 * Is this a notification hook **we wired up**?
 *
 * ⚠️⚠️ For the same reason as `isOursMsg`, **never judge with "contains" (includes)** — it would **silently remove**,
 *    on the next install or `--remove`, a wrapper the user wrote (`… notify.sh 2>>/tmp/log`).
 * ⚠️ Also catch the manually installed shape (absolute path; some people installed it in the SETUP.md days).
 */
function isOursNotify(h) {
  if (!h || typeof h !== 'object' || h.type !== 'command' || typeof h.command !== 'string') {
    return false
  }
  return (
    h.command === NOTIFY_COMMAND || h.command === NOTIFY_PATH || h.command === shQuote(NOTIFY_PATH)
  )
}

/**
 * ★★ **Do not wire it up if it is not installed** (fail-closed / 2026-09-21).
 *
 * ⚠️ A hook pointing at something missing makes the shell fail on every turn.
 *    And hook failures are nearly invisible to the user, so **nobody notices**.
 */
function notifyReady() {
  try {
    return statSync(NOTIFY_PATH).isFile()
  } catch {
    return false
  }
}

function bearerOf(h) {
  const headers = h?.headers
  if (!headers || typeof headers !== 'object') return undefined
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'authorization' && typeof v === 'string') {
      return v.replace(/^Bearer\s+/i, '').trim()
    }
  }
  return undefined
}

/**
 * Describe the current state in one line.
 *
 * ⚠️ **Compare including the token.** Because it was not compared, re-running after `config.json` was recreated
 *    and only the Bearer had gone stale said "unchanged" and could not fix it
 *    (2026-08-13 external review). The agent side does not count unreachable hooks as "installed" either.
 * ⚠️ Never display the token itself (it stays in terminal scrollback and screen shares). Only the first 6 characters.
 */
function describeEvent(hooks, event, isMine) {
  const list = hooks?.[event]
  if (!Array.isArray(list) || list.length === 0) return NONE()
  const parts = []
  for (const matcher of list) {
    for (const h of matcher?.hooks ?? []) {
      if (isMine(h)) {
        if (h.type === 'http') {
          const tok = bearerOf(h)
          const fp = tok ? `${tok.slice(0, 6)}…` : t('（トークン無し）', '(no token)')
          parts.push(`http ${h.url} timeout=${h.timeout} token=${fp}`)
        } else {
          parts.push(`command ${h.command} timeout=${h.timeout}`)
        }
      } else {
        // ★ Other people's hooks are left alone, but shown as present
        parts.push(`${t('他', 'other')}: ${h?.type ?? '?'} ${h?.url ?? h?.command ?? ''}`.trim())
      }
    }
  }
  return parts.length > 0 ? parts.join(' / ') : NONE()
}

/** ★ How "absent" is shown (⚠️ comparisons use the same function's value = never disagree when the language changes) */
function NONE() {
  return t('なし', 'none')
}

function describe(hooks) {
  const notify = NOTIFY_EVENTS.map((ev) => describeEvent(hooks, ev, isOursNotify)).every(
    (s) => s !== NONE(),
  )
    ? t(`あり（${NOTIFY_EVENTS.join(' / ')}）`, `yes (${NOTIFY_EVENTS.join(' / ')})`)
    : NOTIFY_EVENTS.some((ev) => describeEvent(hooks, ev, isOursNotify) !== NONE())
      ? t('⚠️ 一部だけ', '⚠️ only some')
      : NONE()
  return (
    `${t('承認', 'approval')}=${describeEvent(hooks, 'PermissionRequest', isOurs)}` +
    ` ${t('／', '/')} ${t('本文', 'text')}=${describeEvent(hooks, 'MessageDisplay', isOursMsg)}` +
    ` ${t('／', '/')} ${t('通知', 'notify')}=${notify}`
  )
}

/**
 * Replace only our own hooks (keep the others).
 *
 * ⚠️ It used to replace `PermissionRequest = [our one entry]` wholesale, so
 *    **it removed PermissionRequest hooks the user had added separately** (same review).
 *    `--remove` likewise removes only ours.
 */
function applyEvent(hooks, event, isMine, entry, remove) {
  const next = { ...(hooks ?? {}) }
  const list = Array.isArray(next[event]) ? next[event] : []
  const kept = []
  for (const matcher of list) {
    if (!matcher || typeof matcher !== 'object') continue
    const others = (Array.isArray(matcher.hooks) ? matcher.hooks : []).filter((h) => !isMine(h))
    // Drop matchers that contained only our hooks (do not leave empty matchers)
    if (others.length > 0) kept.push({ ...matcher, hooks: others })
  }
  if (!remove) kept.push(entry())
  if (kept.length > 0) next[event] = kept
  else delete next[event]
  return next
}

/**
 * @param msgReady whether the text hook may be installed (passed the live test).
 *   ⚠️⚠️ **If it did not pass, do not touch MessageDisplay at all** (2026-08-21 codex high #2).
 *   If a frozen state directory is the cause, installing it would
 *   **freeze rendering for up to 2 seconds every 0.7 seconds**. ⇒ Match the implementation to the message "installing approvals only".
 */
function applyOurs(hooks, { remove, msgReady, notifyOk }) {
  let next = applyEvent(hooks, 'PermissionRequest', isOurs, hookEntry, remove)
  if (remove || msgReady) {
    next = applyEvent(next, 'MessageDisplay', isOursMsg, msgHookEntry, remove)
  }
  // ★★ Notification source (2026-09-21). ⚠️ **Do not wire it up if it is not installed** (fail-closed).
  //   ⚠️ `notifyOk` is ignored with `--remove` (**removing must always be possible**).
  if (remove || notifyOk) {
    for (const ev of NOTIFY_EVENTS) {
      next = applyEvent(next, ev, isOursNotify, notifyHookEntry, remove)
    }
  }
  return next
}

/**
 * ★ Before installing, check that the hook is **in a shape that really works** (2026-08-21 `/code-review` low #7).
 *
 * ⚠️ `command` is run by a shell, so **a space in the path makes it fail forever**.
 *    And by contract "on failure the original text is shown", so **the user sees nothing**
 *    (= installed but nothing shows, the hardest shape to triage).
 */
function checkMsgCommand() {
  const warn = []
  if (!existsSync(MSG_COMMAND)) warn.push(t(`ファイルが無い: ${MSG_COMMAND}`, `file missing: ${MSG_COMMAND}`))
  else {
    try {
      if (!(statSync(MSG_COMMAND).mode & 0o111)) warn.push(t('実行ビットが立っていない（chmod +x）', 'not executable (chmod +x)'))
    } catch {
      warn.push(t('状態を読めない', 'cannot stat it'))
    }
  }
  return warn
}

/**
 * ★★ **Run it once exactly as installed and check it really writes** (2026-08-21, codex's suggestion).
 *
 * Why it is needed: `MessageDisplay` is an **undocumented hook**, and when it fails
 * **the user sees nothing** (just the original text). ⇒ Measuring it once at install time catches
 * **mac's bash, path quoting, permissions and state directory mismatches** here.
 * ⚠️ Uses **a random sessionId**. Removed after checking.
 */
function smokeTest() {
  // ★ **If the off switch is present, say so** (2026-08-21 `/code-review` low #7).
  //   ⚠️ Otherwise it says "the hook ran but wrote no file" and
  //     **makes people chase permissions although it was turned off on purpose**.
  // ⚠️ The same place the hook looks (`hooks/message-display.sh`: the per-user runtime directory first)
  const off = process.env.XDG_RUNTIME_DIR ? join(process.env.XDG_RUNTIME_DIR, 'nyan-remote-inflight.off') : join(STATE_DIR, 'inflight.off')
  // ⚠️ Same rule as the hook: a regular file of ours, not a link (someone else's file there does not stop the hook)
  if (ownOffSwitch(off)) return t(`逃げ道が置かれています（${off} を消すまで本文は出ません）`, `the off switch is present (message text will not show until you delete ${off})`)
  const sid = randomUUID()
  const dir = join(STATE_DIR, 'inflight')
  const path = join(dir, `${sid}.jsonl`)
  const payload = JSON.stringify({
    session_id: sid,
    hook_event_name: 'MessageDisplay',
    index: 0,
    final: true,
    delta: 'smoke',
  })
  try {
    // ★ Pass the command string **exactly as installed** to the shell (quoting mistakes show up here too)
    execFileSync('/bin/sh', ['-c', msgHookEntry().hooks[0].command], {
      input: payload,
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (err) {
    return t(`フックを実行できません: ${err.message}`, `cannot run the hook: ${err.message}`)
  }
  if (!existsSync(path)) return t(`フックは動いたのにファイルができません（${dir} を確認）`, `the hook ran but wrote no file (check ${dir})`)
  let body = ''
  try {
    body = readFileSync(path, 'utf8')
  } catch (err) {
    return t(`書いたファイルを読めません: ${err.message}`, `cannot read the written file: ${err.message}`)
  }
  try {
    unlinkSync(path)
  } catch {
    // not fatal if it cannot be removed
  }
  if (!body.includes('smoke')) return t('書かれた中身が違います', 'the written content is wrong')
  // ★ Conversation content lands here, so fix the permissions too (in case existing ones are 755/644).
  // ⚠️ **If the directory cannot be made 700, do not install** (2026-08-21 codex low #8).
  //    Avoid conversation content continuing to land somewhere others can read.
  try {
    chmodSync(dir, 0o700)
  } catch (err) {
    return t(`ディレクトリを 700 にできません（${err.message}）`, `cannot chmod the directory to 700 (${err.message})`)
  }
  // ⚠️ Fix them **one by one** (giving up after one failure would report success with non-600 files left).
  // ⚠️ Do not follow symlinks (that would change the target's permissions)
  let files = []
  try {
    files = readdirSync(dir)
  } catch {
    files = []
  }
  const failed = []
  for (const name of files) {
    if (!/^[0-9a-fA-F-]{36}\.jsonl$/.test(name)) continue
    const f = join(dir, name)
    try {
      if (!lstatSync(f).isFile()) continue
      chmodSync(f, 0o600)
    } catch {
      failed.push(name)
    }
  }
  if (failed.length > 0) return t(`既存ファイルの権限を直せません（${failed.length}件）`, `cannot fix the permissions of existing files (${failed.length})`)
  return null
}

let changed = 0
let msgReady = true
if (!REMOVE) {
  const msgWarn = checkMsgCommand()
  if (msgWarn.length === 0 && !DRY) {
    const bad = smokeTest()
    if (bad) msgWarn.push(bad)
  }
  if (msgWarn.length > 0) {
    msgReady = false
    console.error(t('⚠️ 本文フック（MessageDisplay）は設置しません:', '⚠️ Not installing the message hook (MessageDisplay):'))
    for (const w of msgWarn) console.error(t(`   ・${w}`, `   - ${w}`))
    console.error(t('   ⚠️ 承認フックだけ設置します（本文が出ないだけで、承認は動きます）', '   ⚠️ Installing only the approval hook (message text will not show, but approvals work)'))
    console.error(t('   ⚠️ すでに設置済みのものは**触りません**（消しません）', '   ⚠️ Anything already installed is **left as is** (not removed)'))
  } else if (!DRY) {
    console.log(t('✔ 本文フックを実測しました（書けています）', '✔ Tested the message hook (it writes correctly)'))
  }
}
const dirs = configDirs()
if (dirs.length === 0) {
  console.error(t('✗ ~/.claude* が見つかりません', '✗ No ~/.claude* directory found'))
  process.exit(1)
}

// ★★ Is the notification source installed (2026-09-21). ⚠️ If not, do not wire it up.
const notifyOk = notifyReady()
if (!REMOVE && !notifyOk) {
  console.warn(t(`⚠️⚠️ ${NOTIFY_PATH} が無いので**通知を結線しません**（承認だけ設置します）`, `⚠️⚠️ ${NOTIFY_PATH} is missing, so **notifications are not wired up** (installing approvals only)`))
  console.warn(t('   ⇒ 置いてから もう一度: cp hooks/notify.sh ~/.claude/hooks/notify.sh', '   ⇒ Install it, then run this again: cp hooks/notify.sh ~/.claude/hooks/notify.sh'))
  console.warn(t('   ⚠️ これが無いと「ターンが終わった」「エラーで止まった」が**1通も出ません**', '   ⚠️ Without it, **no** "turn finished" or "stopped with an error" notifications are sent'))
}

for (const dir of dirs) {
  const path = join(dir, 'settings.json')
  let data = {}
  if (existsSync(path)) {
    try {
      data = JSON.parse(readFileSync(path, 'utf8'))
    } catch (err) {
      // ⚠️ Never overwrite a broken file. Silently creating a new one would lose the settings
      console.error(t(`✗ ${path} が JSON として読めません（触りません）: ${err.message}`, `✗ ${path} is not valid JSON (leaving it untouched): ${err.message}`))
      continue
    }
  }

  const before = describe(data.hooks)
  data.hooks = applyOurs(data.hooks, { remove: REMOVE, msgReady, notifyOk })
  // If hooks becomes empty, remove the key too (do not leave an empty object)
  if (Object.keys(data.hooks).length === 0) delete data.hooks
  const after = describe(data.hooks)
  if (before === after) {
    console.log(t(`・${dir}  変更なし（${after}）`, `- ${dir}  unchanged (${after})`))
    continue
  }

  if (DRY) {
    console.log(t(`（dry-run）${dir}\n    前: ${before}\n    後: ${after}`, `(dry-run) ${dir}\n    before: ${before}\n    after:  ${after}`))
    continue
  }

  // Backup → temp file → verify → rename (the CLAUDE.md convention)
  if (existsSync(path)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    copyFileSync(path, `${path}.bak-${stamp}`)
  } else {
    mkdirSync(dir, { recursive: true })
  }
  const tmp = `${path}.tmp-permhook`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
  JSON.parse(readFileSync(tmp, 'utf8')) // confirm it parses before replacing
  // ⚠️ It contains the token, so make it 600
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
  try {
    unlinkSync(`${tmp}`)
  } catch {
    // already renamed, so it is gone
  }
  console.log(t(`✔ ${dir}\n    前: ${before}\n    後: ${after}`, `✔ ${dir}\n    before: ${before}\n    after:  ${after}`))
  changed++
}

console.log(
  changed === 0
    ? t('\n変更はありませんでした。', '\nNothing changed.')
    : t(`\n${changed} 件を更新しました。★ 動いているセッションもすぐ拾います（再起動は不要）。`, `\nUpdated ${changed}. ★ Running sessions pick it up right away (no restart needed).`),
)
if (!REMOVE && changed > 0) {
  const h = TIMEOUT / 3600
  const hr = Math.round(h * 10) / 10
  const min = Math.round(TIMEOUT / 60)
  console.log(
    t(
      `待ち時間: ${TIMEOUT} 秒（${h >= 1 ? `${hr} 時間` : `${min} 分`}）`,
      `Wait time: ${TIMEOUT} seconds (${h >= 1 ? `${hr} hours` : `${min} minutes`})`,
    ),
  )
  console.log(t('⚠️ 承認は「スマホ」でも「PCの画面」でも答えられます。どちらでも構いません。', '⚠️ Approvals can be answered on the phone or on the PC screen, whichever you like.'))
}

/** ★ The hook's off switch counts only as a regular file owned by us, not a symlink (same rule as `hooks/message-display.sh`) */
export function ownOffSwitch(path) {
  try {
    const st = lstatSync(path)
    return st.isFile() && (typeof process.getuid !== 'function' || st.uid === process.getuid())
  } catch {
    return false
  }
}

