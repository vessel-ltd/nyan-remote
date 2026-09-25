#!/usr/bin/env node
// Install the keystroke path (§9.7.2).
//
//   node scripts/install-relay.mjs --dry-run    only show what would be placed
//   node scripts/install-relay.mjs              install (takes backups)
//   node scripts/install-relay.mjs --uninstall   remove
//
// ## ★★ Why "a shim on PATH" rather than "a shell function" (method changed on 2026-08-23)
//
// At first we did this: define a **function** called `claude()` in the rc to wrap it.
// ⚠️⚠️ **This depends on how callers write the call, so it does not hold up.**
//
//   | how it is called    | alias | function | PATH   |
//   |---------------------|-------|----------|--------|
//   | `claude`            | hit   | hit      | hit    |
//   | **`command claude`**| skip  | **skip** | hit    |
//   | `env … claude`      | skip  | skip     | hit    |
//   | `/abs/path/claude`  | skip  | skip     | skip   |
//
// The **very purpose** of `command` is "ignore functions and aliases", so a function cannot catch it.
// **Machine B's `_claude_acct` was `command claude "$@"`** (machine A's was a plain `claude "$@"`).
// As a result **the install succeeded yet not a single keystroke got through; they silently fell back to the inbox**.
//
// ⇒ Catch it at the shell's **lowest layer** (PATH lookup). The same shim approach as `pyenv` / `ccache` / `direnv`.
// ⇒ ★ **Never touches other people's definitions (`_claude_acct` etc.)**, so it works regardless of how they are written.
//
// ## ★★ Another trap we hit: **in a login shell `.profile` runs afterwards** (2026-08-23)
//
// Ubuntu's default `~/.profile` looks like this:
//
//     line 14: . "$HOME/.bashrc"                   ← puts the shim first on PATH here
//     line 21: PATH="$HOME/bin:$PATH"              ← **after** that
//     line 26: PATH="$HOME/.local/bin:$PATH"       ← ★ the real one cuts in front
//
// ⇒ **In a real terminal (login shell) the real one wins.** ⚠️ And the first check
// looked with `bash -i -c` (**non-login**), so **it lied with ✅**.
// ⇒ **Put the same block in the file read at login too** (`loginProfileFor`).
// ⇒ **Check with `bash -l -i -c` (login + interactive)**. Look in the same shape as a real terminal.
// ⚠️ zsh runs `.zprofile` → `.zshrc` (the order is reversed), so `.zshrc` alone suffices.
//
// ⚠️ What it still misses (made visible by the install-time check):
//   - definitions calling it directly by absolute path (`absoluteClaudeCalls` warns)
//   - environments where `mise` / `nvm` / `direnv` rewrite the front of PATH **afterwards** (visible in the check)
//   - shells that do not read that rc (fish / nushell) / zsh touching PATH in `.zlogin`
//
// ## What we guard
//
// ⚠️ **Temp file → syntax check → live check → rename** (the order in CLAUDE.md §5).
// ⚠️ **For the rc, "prepare everything in temp files and syntax-check → rename only after all pass"**
//    (breaking it breaks the interactive shell = fail-closed). The shim is placed **after that** too.
//    ⚠️ This used to say "backup → syntax check → write", which **did not match the implementation**
//       (pointed out in the 2026-08-23 review. The backup is taken right before the rename).
// ⚠️ **Non-interactive (`claude -p`) passes straight through** (a pty in between changes the output shape).
// ⚠️ **Always keep the bypass** (`NYAN_REMOTE_NO_RELAY=1`).

import { installCli, removeCli } from './lib/cli.mjs'
import { execFileSync } from 'node:child_process'
import {
  accessSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { t } from '../shared/i18n.ts'
import { initCliLang } from './lib/lang.mjs'

export const BEGIN = '# >>> nyan-remote relay >>>'
/**
 * ★ **Line 2** of the shim (line 1 is the shebang). `--uninstall` only removes files in this shape.
 * ⚠️ Not "proof that we wrote it" (anyone can make the same shape to get it removed). It exists **so we never remove someone else's file by mistake**.
 */
export const SHIM_MARK = '# nyan-remote: 打鍵で渡す経路'
export const END = '# <<< nyan-remote relay <<<'

/** Where the shim goes. ⚠️ Same rule as relay.py's `state_dir()` */
export function binDirFor(home, env = {}) {
  return join(env['NYAN_REMOTE_STATE_DIR'] || join(home, '.nyan-remote'), 'bin')
}

/**
 * ★ Make it safe to place **as is** inside double quotes (review A7).
 *
 * ⚠️⚠️ It used to be embedded raw, so when the rc was read `$USER` **got expanded**,
 *    putting a different directory than the one created on PATH. `$(…)` / `` ` `` **would have been executed**.
 * ⚠️ **Newlines cannot be handled**. ⇒ `stateDirProblem()` **refuses at the install entry point** (added in review B2.
 *    Until then it only said "the caller refuses", and that check did not exist).
 */
function shd(s) {
  return String(s).replace(/(["$`\\])/g, '\\$1')
}

/** Safely wrap in sh single quotes */
function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/**
 * The block added to the rc. ★ It only adds one entry to PATH (defines no function).
 *
 * ⚠️ **Needs a duplicate guard** (so reading the rc twice does not put it on PATH twice).
 */
export function buildBlock(binDir) {
  const d = shd(binDir)
  return `${BEGIN}
# 打鍵で渡す経路（docs/ARCHITECTURE.md §9.7.2）。
# ⚠️ このブロックは scripts/install-relay.mjs が管理する（消しても claude は動く）。
# ★ シェル関数にしない理由: \`command claude\` / \`env … claude\` は**関数を飛ばす**ので、
#   PATH の shim（${d}/claude）で受ける（2026-08-23 に実機で実測）。
# ⚠️ 逃げ道: NYAN_REMOTE_NO_RELAY=1 claude … で素の claude が起動する。
# ⚠️⚠️ 判定は「在るか」ではなく **「先頭か」**。ログインシェルでは
#   ~/.profile が「.bashrc を読む → そのあと PATH を prepend」する順なので、
#   「在るなら何もしない」にすると**悪い順番がそのまま残る**（2026-08-23 に実測）。
#   ⇒ **先頭でなければ、取り除いてから先頭に置く**（重複も増やさない）。
# ⚠️ \${PATH-} にする（set -u の rc で PATH が未設定のときに落ちないように / A7）
case ":\${PATH-}:" in
  ":${d}:"*) ;;
  *":${d}:"*)
    _nyan_remote_path=":\$PATH:"
    while :; do
      case $_nyan_remote_path in
        *":${d}:"*) _nyan_remote_path="\${_nyan_remote_path%%":${d}:"*}:\${_nyan_remote_path#*":${d}:"}" ;;
        *) break ;;
      esac
    done
    _nyan_remote_path="\${_nyan_remote_path#:}"; _nyan_remote_path="\${_nyan_remote_path%:}"
    PATH="${d}\${_nyan_remote_path:+:\$_nyan_remote_path}"
    unset _nyan_remote_path ;;
  # ⚠️ PATH が空のとき ":$PATH" は**末尾コロン ＝ 空エントリ ＝ cwd** になる（Q2）
  *) PATH="${d}\${PATH:+:\$PATH}" ;;
esac
${END}`
}

/**
 * The shim itself, placed on PATH. ★ Reading only this tells you what happens when claude starts.
 *
 * ⚠️ **If the real one cannot be exec'd, search PATH again** (so it starts even after an update changes the path).
 *    When doing so, **exclude our own directory** (otherwise it calls itself forever).
 */
export function buildWrapper({ real, relay }) {
  return `#!/bin/sh
${SHIM_MARK}（docs/ARCHITECTURE.md §9.7.2）の入口。
# ⚠️ scripts/install-relay.mjs が生成する。手で直さない（再設置で上書きされる）。
# ★ 関数ではなく PATH 上のファイルなのは、\`command claude\` / \`env … claude\` が
#   シェル関数を飛ばすため（2026-08-23 に実機で実測）。
# ⚠️ 素の claude に戻る道を必ず残す（fail-open）。逃げ道: NYAN_REMOTE_NO_RELAY=1

real=${shq(real)}
relay=${shq(relay)}

# ★★★ 循環ガード（**回数を数える** / 2026-08-24）。
#
# ⚠️⚠️ **真偽値では原理的に防げない**（実測。12通りのうち9通りが無限に回った）。
#   印を消して exec claude すると **PATH 先頭の自分に戻る**ので、PATH 上に
#   「claude を名前で呼び直す別のラッパー」が1つ在るだけで
#   shim → ラッパー → shim → … と無限に回る（リレー経由なら**pty ごと積み上がる**）。
#   ⇒ hop を数えて、上限で**止める**（黙って回り続けるより、理由を出して落ちる方が良い）。
# ⚠️ 上限は普通の入れ子（claude の中から claude）を殺さない大きさにする。
# ⚠️ 数えるのは**素通しの枝より前**（逃げ道と -p でも循環しうる / 実測）。
# ★ 言語（NYAN_LANG > LC_ALL > LC_MESSAGES > LANG。ja で始まれば日本語、それ以外は英語）
#   ⚠️ 失敗の枝でしか呼ばない（毎日の直列なので、普段の起動には何も足さない）
_ta_ja() {
  case \${NYAN_LANG:-\${LC_ALL:-\${LC_MESSAGES:-\${LANG:-}}}} in
    [Jj][Aa]*) return 0 ;;
  esac
  return 1
}
_ta_n=\${_NYAN_REMOTE_SHIM:-0}
# ⚠️⚠️ 桁が多い値は 0 にする（レビュー B6）。巨大な数字を -ge に渡すと
#    **dash は Illegal number で死ぬ** ＝ 変な env 1つで claude が起動しなくなる。
case $_ta_n in ''|*[!0-9]*|???*) _ta_n=0 ;; esac
if [ "$_ta_n" -ge 8 ]; then
  if _ta_ja; then
    echo 'nyan-remote: claude の呼び出しが循環しています（PATH 上のラッパーが claude を呼び直しています）' >&2
    echo '  ⇒ PATH を確認してください。素で起こすなら本物を絶対パスで叩いてください' >&2
  else
    echo 'nyan-remote: calls to claude are looping (a wrapper on PATH keeps calling claude again)' >&2
    echo '  => Check your PATH. To start claude directly, run the real one by its absolute path' >&2
  fi
  exit 127
fi
_NYAN_REMOTE_SHIM=$((_ta_n + 1))
export _NYAN_REMOTE_SHIM

# ★ 本物が動かせないなら PATH から探し直す。
# ⚠️⚠️ **文字列一致で自分を除外してはいけない**（末尾スラッシュ・symlink 別名・重複表記で
#    除外に失敗して自分を拾う）。⇒ **候補が自分と同一ファイル（-ef）なら捨てる**。
# ⚠️ tr で組み立てると**末尾コロン**が残り、空エントリ ＝ **cwd** が検索対象に入る。
#    ⇒ IFS=: のループで空を捨て、**絶対パスでない候補は採らない**。
if [ ! -x "$real" ] || [ "$real" -ef "$0" ]; then
  real=''
  _ta_ifs=$IFS
  IFS=:
  # ⚠️⚠️ **glob を止める**（レビュー B2）。無引用の $PATH は**パス名展開される**ので、
  #    PATH に /opt/claude-* のような要素が在ると、そこに無いはずの
  #    /opt/claude-evil/claude を拾いうる。
  set -f
  for _ta_d in $PATH; do
    [ -n "$_ta_d" ] || continue
    case $_ta_d in /*) ;; *) continue ;; esac
    _ta_c="$_ta_d/claude"
    [ -x "$_ta_c" ] || continue
    [ "$_ta_c" -ef "$0" ] && continue
    real=$_ta_c
    break
  done
  set +f
  IFS=$_ta_ifs
  unset _ta_ifs _ta_d _ta_c
fi
if [ -z "$real" ] || [ ! -x "$real" ]; then
  if _ta_ja; then
    echo 'nyan-remote: 本物の claude が見つかりません（NYAN_REMOTE_NO_RELAY=1 でも素起動できません）' >&2
  else
    echo 'nyan-remote: the real claude was not found (NYAN_REMOTE_NO_RELAY=1 cannot start it either)' >&2
  fi
  exit 127
fi

# 素で起こす条件（fail-open）
if [ -n "\${NYAN_REMOTE_NO_RELAY:-}" ] || [ ! -t 0 ] || [ ! -t 1 ] || [ ! -f "$relay" ]; then
  exec "$real" "$@"
fi
# ⚠️⚠️ **「在る」ではなく「走る」を確かめる**（2026-08-23）。pyenv / asdf / conda の shim は
#    「在るが走らない」ことがあり、python3 を exec した**後**では素の claude に戻れない
#    （実測で起動不能になった）
python3 -c '' >/dev/null 2>&1 || exec "$real" "$@"
# ⚠️ 非対話（-p / --print）は必ず素通し。pty を挟むと出力の形が変わる
for a in "$@"; do
  case "$a" in
    -p|--print) exec "$real" "$@" ;;
  esac
done
exec python3 "$relay" -- "$real" "$@"
`
}

/**
 * Return the ranges of **all** blocks in the rc. ⚠️ `null` if the shape is ambiguous (do not touch).
 *
 * ⚠️⚠️ **Calling `indexOf` once only sees "the first one"** (2026-08-23 review Q1).
 *    Because of that **install left the old one and `--uninstall` left one behind** =
 *    **a block that keeps putting a removed shim directory first on PATH stays forever**.
 */
function findBlocks(rc) {
  const spans = []
  let pos = 0
  for (;;) {
    const b = findMark(rc, BEGIN, pos)
    const e = findMark(rc, END, pos)
    if (b < 0 && e < 0) return spans
    if (b < 0 || (e >= 0 && e < b)) return null // END comes first / an END without a start
    if (e < 0) return null // not closed
    const nested = findMark(rc, BEGIN, b + BEGIN.length)
    if (nested >= 0 && nested < e) return null // nested
    // ⚠️ The end runs **to the end of the line** (leaving whitespace or CR after the marker makes us lose it on the next read)
    let end = e + END.length
    while (end < rc.length && (rc[end] === ' ' || rc[end] === '\t' || rc[end] === '\r')) end++
    spans.push({ start: b, end })
    pos = end
  }
}

/**
 * Find the marker. ⚠️⚠️ **Only counts as found if it is "the line itself"** (review A7).
 *
 * `indexOf` ignores line boundaries, so the same string **appearing once** in the user's rc
 * was mistaken for the block, and `applyBlock` **replaced and deleted that line**.
 * ⚠️ The markers we write always occupy a whole line (`buildBlock`), so this misses none.
 */
function findMark(rc, mark, from) {
  for (let i = rc.indexOf(mark, from); i >= 0; i = rc.indexOf(mark, i + 1)) {
    const headOk = i === 0 || rc[i - 1] === '\n'
    // ⚠️ Allow "only whitespace, then end of line" after it (review B4).
    //    ⚠️⚠️ An rc edited from a Windows editor on WSL becomes **CRLF**, so
    //       allowing only a newline **loses the block and adds a second one** (removing leaves the old one).
    let tail = i + mark.length
    while (tail < rc.length && (rc[tail] === ' ' || rc[tail] === '\t' || rc[tail] === '\r')) tail++
    const tailOk = tail === rc.length || rc[tail] === '\n'
    if (headOk && tailOk) return i
  }
  return -1
}

/**
 * Put the block into the rc text (replace it if already present).
 *
 * ⚠️ **Append at the end** (as late as possible, so things rewriting PATH afterwards do not win).
 * ★ **If there are 2 or more, remove them all and add it again** (= exactly one remains, at the end / Q1).
 *   ⚠️ Do not make this "leave it alone". **Then `--uninstall` would leave it alone too, and
 *      there would be no way to remove the real harm (the leftover block)**.
 */
export function applyBlock(rc, block) {
  const spans = findBlocks(rc)
  if (spans === null) return null // ⚠️ only one side / nested = broken by hand (fail-closed)
  if (spans.length > 1) {
    const cleaned = removeBlock(rc)
    return cleaned === null ? null : applyBlock(cleaned, block)
  }
  if (spans.length === 1) {
    const { start, end } = spans[0]
    return `${rc.slice(0, start)}${block}${rc.slice(end)}`
  }
  const sep = rc.length === 0 || rc.endsWith('\n') ? '' : '\n'
  return `${rc}${sep}\n${block}\n`
}

/**
 * Remove **all** blocks. Return it unchanged if there are none.
 *
 * ⚠️ **Eat as few newlines as possible** (2026-08-23 review R).
 * ⚠️⚠️ **Exception**: an rc not ending in a newline **gains one trailing newline** after a round trip
 *    (the two `applyBlock` added cannot be told apart, so only one can be returned). Pinned by a test.
 *   - the front used to be collapsed with `replace(/\n+$/, '\n')`, so **the user's trailing blank lines disappeared**
 *     = it did not return to the uninstalled shape ("removed, yet the rc changed")
 *   - conversely, eating both sides **joins lines** when removing a block in the middle (`A=1B=2`)
 *   ⇒ `applyBlock` adds "one blank line + the block + one newline". **Return exactly that.**
 */
export function removeBlock(rc) {
  let out = rc
  for (;;) {
    const spans = findBlocks(out)
    if (spans === null) return null
    if (spans.length === 0) return out
    const { start, end } = spans[0]
    let before = out.slice(0, start)
    // ★ What we added was "one blank line" only, so return **just one**.
    //   ⚠️ Collapsing all removes the user's blank lines; eating both sides joins lines at a block in the middle.
    //   (Only a newline in front = the block sits at the start. Even there, eat just one)
    if (/^\n*$/.test(before) || before.endsWith('\n\n')) before = before.slice(0, -1)
    const after = out.slice(end).startsWith('\n') ? out.slice(end + 1) : out.slice(end)
    out = `${before}${after}`
  }
}

/** Which rc to touch. ⚠️ mac defaults to zsh */
export function rcPathFor(shell, home, os) {
  const name = (shell ?? '').split('/').pop() ?? ''
  if (name === 'zsh') return join(home, '.zshrc')
  if (name === 'bash') return join(home, '.bashrc')
  return os === 'darwin' ? join(home, '.zshrc') : join(home, '.bashrc')
}

/**
 * ★★ **The shell that reads that rc** (2026-09-23 / the diagnosis lied on a real mac).
 *
 * ⚠️⚠️ `keys-status.mjs` **hard-coded `bash`** to check "is the shim reached".
 *    Meanwhile this writes to **`.zshrc`** on mac ⇒ bash does not read `.zshrc`, so
 *    **it always said "not reached" even when the shim worked** (on the same screen as "1 session accepts keystrokes ✅").
 * ⇒ **Derive it from where we write (`rcPathFor`)** = the rc written and the shell checked **cannot disagree**.
 *    ⚠️ Do not write a separate decision here (the moment there are two, they disagree again).
 */
export function shellFor(shell, os) {
  return rcPathFor(shell, '/', os).endsWith('.zshrc') ? 'zsh' : 'bash'
}

/**
 * ★ **The file read at login** (runs **after** `.bashrc`, so put it here too).
 *
 * ⚠️ bash reads **only the first existing one** of `.bash_profile` → `.bash_login` → `.profile`.
 * ⚠️ zsh runs `.zprofile` → `.zshrc` (`.zshrc` is later), so **nothing needs adding** → undefined.
 */
/** ★ Every rc file we may have written that exists (for `--uninstall`) */
export function uninstallTargets(home, extra = [], exists = existsSync) {
  const all = [...extra.filter(Boolean), ...['.bashrc', '.zshrc', '.bash_profile', '.bash_login', '.profile'].map((f) => join(home, f))]
  return [...new Set(all)].filter((p) => exists(p))
}

export function loginProfileFor(shell, home, os, exists = existsSync) {
  const name = (shell ?? '').split('/').pop() ?? ''
  const isZsh = name === 'zsh' || (name === '' && os === 'darwin')
  if (isZsh) return undefined
  for (const f of ['.bash_profile', '.bash_login', '.profile']) {
    if (exists(join(home, f))) return join(home, f)
  }
  return join(home, '.profile')
}

/**
 * ★ The env passed to the check's child. **Never carry over our own session's markers** (2026-08-23 / A1).
 *
 * ⚠️⚠️ `_NYAN_REMOTE_SHIM` is a re-entry guard the shim sets right before exec'ing the relay, so
 *    **running the install from inside a relayed session has it in the env** (measured).
 *    Passing it to the check's child makes the guard misfire and fall into `exec claude`, so
 *    **it showed "✅ went through the relay" although the relay never ran once**.
 * ⇒ Check in "the real shape (a new terminal)". Exactly the kind of mistake listed in CLAUDE.md.
 */
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  delete env['_NYAN_REMOTE_SHIM']
  return env
}

/**
 * ★★ Can it be used as the bin directory path (review B2 / 2026-08-24).
 *
 * ⚠️⚠️ **Newline**: it can break out of the block's comment line and **embed arbitrary commands in the rc**
 *    (measured: `printf` got executed). `shd()` cannot handle newlines.
 * ⚠️ **`:`**: the shim can be placed, but on PATH it **splits into 2 entries and is never reached**
 *    (the symptom is "silently falls back to the inbox" = invisible on screen).
 * ⚠️ **Relative path**: works in the window it was installed from, but **a terminal opened in another directory points elsewhere**.
 * @returns why it cannot be used (undefined if it can)
 */
export function stateDirProblem(dir) {
  const d = String(dir ?? '')
  if (!d) return t('空です', 'it is empty')
  if (!d.startsWith('/')) return t('絶対パスではありません', 'it is not an absolute path')
  if (/[\n\r]/.test(d)) return t('改行が入っています', 'it contains a newline')
  if (d.includes(':')) return t('PATH の区切り（:）が入っています', 'it contains the PATH separator (:)')
  if (d.includes('\0')) return t('NUL が入っています', 'it contains NUL')
  return undefined
}

/**
 * ★ The `script` arguments that start claude through the relay on a pty (2026-09-23 / ⑤).
 *
 * ⚠️⚠️ **`script` takes different arguments per OS**:
 *    Linux (util-linux) … `script -qec '<command line>' /dev/null` (the command is **one string**)
 *    mac (BSD)          … `script -q /dev/null <command> [args...]` (**no `-c`**)
 *    mac used to be "omitted (⬜)", ⇒ **on mac it never once checked whether the relay could be passed**
 *    = **the diagnosis missed** keystrokes silently falling back to the inbox (actually happened on mac on 2026-09-23).
 * ⚠️ On Linux `-c` is one string, so **quote it** (paths with spaces split / B2 measured).
 *    On mac the arguments are **listed as is** (no shell involved, so quoting would pass the quotes along).
 */
export function ptyProbeArgv(plat, cmd, args) {
  if (plat === 'darwin') return ['-q', '/dev/null', cmd, ...args]
  return ['-qec', [cmd, ...args].map(shq).join(' '), '/dev/null']
}

const isExecutableSync = (p) => {
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Find the real claude on PATH.
 *
 * ⚠️ **Always exclude the shim directory** (embedding ourselves as "the real one" on reinstall
 *    makes it call itself forever at run time).
 */
export function resolveRealClaude(pathEnv, excludeDir, isExecutable = isExecutableSync) {
  const skip = resolve(excludeDir)
  const shim = join(excludeDir, 'claude')
  for (const dir of String(pathEnv ?? '').split(':')) {
    if (!dir) continue
    if (resolve(dir) === skip) continue
    // ⚠️⚠️ **Comparing strings is not enough** (measured 2026-08-23). If PATH has a **symlink alias**
    //    of the shim directory, `resolve()` (lexical normalization only) considers it different and
    //    **embeds the shim itself as "the real one"** = an inescapable infinite exec on reinstall.
    //    ⇒ **Drop it if it is the same file (dev+ino)**.
    const p = join(dir, 'claude')
    if (!isExecutable(p)) continue
    if (isSameFile(p, shim)) continue
    return p
  }
  return undefined
}

/** Same underlying file? (dev + inode). ⚠️ If unreadable, lean to "different" (no basis to exclude it) */
function isSameFile(a, b) {
  try {
    const x = statSync(a)
    const y = statSync(b)
    return x.dev === y.dev && x.ino === y.ino
  } catch {
    return false
  }
}

/**
 * Strip trailing comments. ⚠️ **A `#` inside quotes is not a comment** (cutting it misjudges).
 */
function stripComment(line) {
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = ''
      else if (quote === '"' && c === '\\') i++
    } else if (c === "'" || c === '"') {
      quote = c
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i)
    }
  }
  return line
}

/**
 * ★ Find **call styles the shim cannot catch** (lines calling claude with a path).
 * ⚠️ Do not fix them. **Only make them visible** (the rule of not touching others' definitions).
 *
 * ⚠️⚠️ **It only looked at absolute paths and missed the most common style in real rcs**
 *    (`$HOME/...` / `${HOME}/...` / `~/...` / 2026-08-23 review Q4).
 *    Missing them reads as "no ⚠️ = fine", and **it silently falls back to the inbox**.
 * ★ The check is just one thing: "is there **a word ending in `/claude`**". A word containing a slash
 *   makes the shell skip PATH = it bypasses the shim; that is the reason (no need to distinguish absolute/relative).
 * ⚠️ **This is not a "call" check** (pointed out in the 2026-08-23 review). It also **picks up lines that do not call it**,
 *    like `echo /opt/bin/claude` or `test -x /opt/bin/claude`. It only warns, so this is tolerated.
 *   ⚠️ `$HOME/.claude` (the config directory) and `.../claude-wrapper` are **not calls**, so
 *   they are not caught (they do not end in `/claude`).
 */
export function absoluteClaudeCalls(rc) {
  const out = []
  for (const line of String(rc ?? '').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const words = stripComment(line).split(/[\s"'`;&|()=<>{}]+/)
    if (words.some((w) => w.endsWith('/claude'))) out.push(t)
  }
  return out
}

// ⚠️ It is a function (building messages at module top level freezes them to the default before the language is decided)
function usage() {
  return t(
    `使い方: node scripts/install-relay.mjs [--dry-run] [--uninstall]
  --dry-run    何を置くか出すだけ（1バイトも書かない）
  --uninstall  外す（rc のブロックと shim を消す）`,
    `Usage: node scripts/install-relay.mjs [--dry-run] [--uninstall]
  --dry-run    only show what would be installed (writes nothing)
  --uninstall  remove it (the rc block and the shim)`,
  )
}

async function main() {
  initCliLang()
  const args = process.argv.slice(2)
  // ★★ **Refuse unknown arguments** (2026-08-23 review Q3).
  // ⚠️⚠️ They used to be ignored silently, so **a one-character typo like `--dry-runn`
  //    turned "not writing anything" into a real install** (`includes('--dry-run')` was false).
  const known = new Set(['--dry-run', '--uninstall', '--help', '-h'])
  const bad = args.filter((a) => !known.has(a))
  if (bad.length) {
    console.error(t(`⚠️ 知らない引数です: ${bad.join(' ')}`, `⚠️ Unknown argument: ${bad.join(' ')}`))
    console.error(usage())
    process.exit(1)
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage())
    return
  }
  const dry = args.includes('--dry-run')
  const uninstall = args.includes('--uninstall')
  const here = dirname(fileURLToPath(import.meta.url))
  const relayPath = resolve(join(here, 'relay.py'))
  const home = homedir()
  const rcPath = rcPathFor(process.env['SHELL'], home, platform())
  // ★ Also place it in the file read at login (it runs **after** `.bashrc` and takes over PATH)
  const loginPath = loginProfileFor(process.env['SHELL'], home, platform())
  // ★ Removing looks at **every** rc we may have written, not only this shell's (codex 2026-09-26: installed under bash,
  //   uninstalled with SHELL=zsh left the bash blocks). ⚠️ Only files that exist (never create one to remove from).
  const targets = uninstall
    ? uninstallTargets(home, [rcPath, loginPath])
    : [rcPath, ...(loginPath && loginPath !== rcPath ? [loginPath] : [])]
  const binDir = binDirFor(home, process.env)
  // ★★ **Check the bin directory path first** (B2). If it is malformed, nothing written to the rc can fix it
  const dirProblem = stateDirProblem(binDir)
  if (dirProblem) {
    console.error(t(`⚠️ ${binDir} は shim の置き場に使えません（${dirProblem}）。`, `⚠️ ${binDir} cannot hold the shim (${dirProblem}).`))
    console.error(t('   NYAN_REMOTE_STATE_DIR を見直してください。何もしていません。', '   Check NYAN_REMOTE_STATE_DIR. Nothing was changed.'))
    process.exit(1)
  }
  const shimPath = join(binDir, 'claude')

  const block = buildBlock(binDir)
  /** @type {{path: string, before: string, after: string}[]} */
  const plans = []
  for (const path of targets) {
    let before = ''
    try {
      before = await readFile(path, 'utf8')
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(t(`⚠️ ${path} を読めませんでした（${err.code}）。何もしていません。`, `⚠️ Could not read ${path} (${err.code}). Nothing was changed.`))
        process.exit(1)
      }
    }
    const after = uninstall ? removeBlock(before) : applyBlock(before, block)
    if (after === null) {
      console.error(t(`⚠️ ${path} の区切り（${BEGIN} / ${END}）が片方だけ在ります。`, `⚠️ ${path} has only one of the markers (${BEGIN} / ${END}).`))
      console.error(t('   手で直してから流し直してください。何もしていません。', '   Fix it by hand, then run this again. Nothing was changed.'))
      process.exit(1)
    }
    plans.push({ path, before, after })
  }

  if (uninstall) {
    if (dry) {
      for (const { path } of plans) console.log(t(`--- ${path} からブロックを削除（--dry-run） ---`, `--- remove the block from ${path} (--dry-run) ---`))
      console.log(t(`--- ${shimPath} を削除（--dry-run） ---`, `--- remove ${shimPath} (--dry-run) ---`))
      return
    }
    // ⚠️ **No** syntax check. We only remove our own block, so
    //    an rc that was already broken **must still be removable** (fail-closed would point the wrong way)
    const { staged, relinks, error } = await stageRcFiles(plans, { syntaxCheck: false })
    if (error) {
      console.error(`⚠️ ${error}`)
      console.error(t('   **何も変えていません。**', '   **Nothing was changed.**'))
      process.exit(1)
    }
    const failed = await commitStaged(staged, t('外しました', 'Removed'))
    if (failed.error) {
      reportCommitFailure(failed, t('shim は消していません。', 'The shim was not removed.'))
      process.exit(1)
    }
    await relinkAll(relinks)
    await removeShim(shimPath, binDir)
    // ★ Also remove the `nyan` / `nyan-remote` commands (⚠️ only what we placed / `lib/cli.mjs`)
    await removeCli(binDir)
    console.log(t('⚠️ 反映されるのは**新しいシェル**からです。', '⚠️ This takes effect in **new shells**.'))
    return
  }

  // ★ Decide the real claude. ⚠️ Search excluding the shim directory
  const real = resolveRealClaude(process.env['PATH'], binDir)
  if (!real) {
    console.error(t('⚠️ PATH に claude が見つかりません。先に Claude Code を入れてください。', '⚠️ claude was not found on PATH. Install Claude Code first.'))
    process.exit(1)
  }
  const wrapper = buildWrapper({ real, relay: relayPath })

  if (dry) {
    console.log(t(`--- ${shimPath} に置くもの（本物は ${real}） ---`, `--- to be placed at ${shimPath} (the real one is ${real}) ---`))
    console.log(wrapper)
    for (const { path, before, after } of plans) {
      console.log(t(`--- ${path} に足すもの ---`, `--- to be added to ${path} ---`))
      console.log(after === before ? t('（すでに同じ形です）', '(already in this form)') : block)
    }
    console.log(t('--- ここまで（--dry-run なので書いていません） ---', '--- end (--dry-run, nothing written) ---'))
    // ★ **Print it even with `--dry-run`** (pointless if you cannot notice before installing / Q4)
    warnAbsoluteCalls(plans)
    return
  }

  // ⚠️ Temp file → syntax check → **live check** → rename (CLAUDE.md §5)
  // ★ Also check the parent (the state directory) (R). ⚠️ hookToken and the VAPID private key live here.
  //   The files are 0600, but **if others can write the directory, `bin` can be swapped wholesale** (the front of PATH is hijacked).
  //   ⚠️ `mkdir`'s `mode` **does not apply to intermediate directories**, so tighten it ourselves here.
  const stateDir = dirname(binDir)
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  try {
    // ⚠️ Always judge with **`stat` (the link target)** (review A7). With `lstat` the symlink's own uid
    //    = "us", so **a symlink to someone else's directory would pass**.
    const st = statSync(stateDir)
    if (st.uid !== process.getuid?.()) throw new Error(t('自分の所有ではありません', 'not owned by you'))
    if (st.mode & 0o022) throw new Error(t('他人が書けます', 'writable by others'))
    // ★ Even for a symlink, **tighten the target** (review B5). Ownership was confirmed above.
    //   ⚠️ It used to skip symlinks, so **the target stayed at 0755**.
    if ((st.mode & 0o777) !== 0o700) await chmod(stateDir, 0o700)
  } catch (err) {
    console.error(t(`⚠️ ${stateDir} を状態の置き場にできません: ${err.message}`, `⚠️ ${stateDir} cannot be used as the state directory: ${err.message}`))
    process.exit(1)
  }
  await mkdir(binDir, { recursive: true, mode: 0o700 })
  // ★★ Verify the bin directory itself (2026-08-23). ⚠️ `mkdir` **does not fix the permissions of an existing directory**.
  //    It goes first on PATH, so if others can write it or it is a symlink, **the shim can be swapped**.
  try {
    const st = lstatSync(binDir)
    if (st.isSymbolicLink()) throw new Error(t('symlink です', 'it is a symlink'))
    if (st.uid !== process.getuid?.()) throw new Error(t('自分の所有ではありません', 'not owned by you'))
    if (st.mode & 0o022) throw new Error(t(`他人が書けます（${(st.mode & 0o777).toString(8)}）`, `writable by others (${(st.mode & 0o777).toString(8)})`))
  } catch (err) {
    console.error(t(`⚠️ ${binDir} を shim の置き場にできません: ${err.message}`, `⚠️ ${binDir} cannot hold the shim: ${err.message}`))
    console.error(t('   （PATH の先頭に入るので、他人が差し替えられる場所には置きません）', '   (it goes at the front of PATH, so it must not be somewhere others can replace it)'))
    process.exit(1)
  }
  const tmpShim = `${shimPath}.new-${process.pid}`
  await rm(tmpShim, { force: true })
  // ⚠️ **Create exclusively** (if a symlink with the same name exists first, we would write to its target)
  await writeFile(tmpShim, wrapper, { flag: 'wx', mode: 0o755 })
  await chmod(tmpShim, 0o755)
  try {
    execFileSync('sh', ['-n', tmpShim], { stdio: 'pipe' })
  } catch (err) {
    await rm(tmpShim, { force: true })
    console.error(t('⚠️ 生成した shim が sh の構文検査で落ちました。設置していません。', '⚠️ The generated shim failed the sh syntax check. Not installed.'))
    console.error(String(err.stderr ?? err.message).slice(0, 400))
    process.exit(1)
  }
  // ★ Actually run it and check "does it reach the real one" (non-interactive, so it takes the pass-through path).
  //   ⚠️ `claude --version` is the only safe command (never call `agents --json` / CLAUDE.md §5)
  let shimVersion = ''
  let realVersion = ''
  try {
    const opts = { encoding: 'utf8', timeout: 30_000, env: childEnv() }
    shimVersion = execFileSync(tmpShim, ['--version'], opts).trim()
    realVersion = execFileSync(real, ['--version'], opts).trim()
  } catch (err) {
    await rm(tmpShim, { force: true })
    console.error(t('⚠️ shim を実際に走らせたら失敗しました。設置していません。', '⚠️ Running the shim failed. Not installed.'))
    console.error(String(err.stderr ?? err.message).slice(0, 400))
    process.exit(1)
  }
  if (!shimVersion || shimVersion !== realVersion) {
    await rm(tmpShim, { force: true })
    console.error(t('⚠️ shim 経由と本物で --version が一致しません。設置していません。', '⚠️ --version differs between the shim and the real claude. Not installed.'))
    console.error(`   shim=${JSON.stringify(shimVersion)} real=${JSON.stringify(realVersion)}`)
    process.exit(1)
  }
  // ★★ **Open a pty and go all the way through the relay** (added 2026-08-23).
  //
  // ⚠️⚠️ The `--version` comparison above has stdin as a pipe, so it takes the shim's `[ ! -t 0 ]`
  //    **pass-through branch**. In other words it only compares "the real one with the real one" and
  //    **tests neither the relay nor python3 at all** (it showed ✅ even with a broken python3).
  //
  // ⚠️⚠️⚠️ **Never write the verdict in the negative** (2026-08-23 / A1 / measured).
  //    It used to be "✅ if the output lacks 'exec directly' and contains the version".
  //    ⇒ **It showed ✅ on a PATH without any python3** (the shim failed on `python3 -c ''` and
  //       just exec'd the plain claude. The pass-through branch says nothing, so they cannot be told apart).
  //    ⇒ The symptom is "silently falls back to the inbox" = **invisible from the phone**, the shape we fear most.
  //    ⇒ **Require that the relay itself announced it (positive evidence)** (have it write to `RELAY_LOG`).
  //    ⚠️ Receive it in a file, not stderr (mixed into the pty output it cannot be told from claude's output).
  // ⚠️ The initial value is "nothing done yet" (it used to say "an environment without script", but
  //    in fact it always tries to run and the catch overwrites it, so that text never appears / pointed out in review)
  let relayNote = t('⬜ relay を通す確認をしていません', '⬜ Did not check going through the relay')
  const relayLog = `${shimPath}.relay-check-${process.pid}`
  await rm(relayLog, { force: true })
  try {
    const out = execFileSync('script', ptyProbeArgv(platform(), tmpShim, ['--version']), {
      encoding: 'utf8',
      timeout: 90_000,
      env: childEnv({ RELAY_LOG: relayLog }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let logged = ''
    try {
      logged = await readFile(relayLog, 'utf8')
    } catch {
      logged = ''
    }
    const why = logged.trim()
      ? logged.trim().split('\n').slice(-2).join(' / ')
      : t('relay が名乗りませんでした（python3 が走らない / relay.py を読めない 等）', 'the relay did not register (python3 does not run / relay.py cannot be read, etc.)')
    // ⚠️ **"Started" alone is not enough** (review B5). Even if the relay runs, if it cannot register in `panes/`
    //    **the agent cannot find it = keystrokes do not work**.
    // ⚠️ relay.py's line changes with the language (`名乗り=あり` / `registered=yes`) ⇒ accept both
    if (!/名乗り=あり|registered=yes/.test(logged)) {
      relayNote = t(
        `⚠️⚠️ **relay を通せませんでした ＝ 打鍵は使えません**（素の起動は動きます）\n   ${why}`,
        `⚠️⚠️ **Could not go through the relay = typing from the phone will not work** (claude itself starts normally)\n   ${why}`,
      )
    } else if (!out.includes(realVersion.split(' ')[0] ?? '')) {
      relayNote = t(`⚠️ relay 経由の出力が本物と違います: ${JSON.stringify(out.slice(0, 160))}`, `⚠️ The output through the relay differs from the real one: ${JSON.stringify(out.slice(0, 160))}`)
    } else {
      relayNote = t('✅ relay を通して claude が起動しました（打鍵の経路が生きています）', '✅ claude started through the relay (typing from the phone works)')
    }
  } catch (err) {
    relayNote = t(`⚠️ relay を通す確認が失敗しました: ${String(err.message).slice(0, 160)}`, `⚠️ Checking the relay failed: ${String(err.message).slice(0, 160)}`)
  }
  await rm(relayLog, { force: true })

  // ★★ **Place the shim only after all rc checks pass** (2026-08-23 review A3).
  //   ⚠️ It used to be placed first, so when the rc syntax check failed it said
  //      "**nothing was changed**" while `~/.nyan-remote/bin/claude` remained (= a lie).
  const { staged, relinks, error } = await stageRcFiles(plans, { syntaxCheck: true })
  if (error) {
    await rm(tmpShim, { force: true })
    console.error(`⚠️ ${error}`)
    console.error(t('   **何も変えていません**（shim も置いていません）。', '   **Nothing was changed** (the shim was not placed either).'))
    process.exit(1)
  }
  // ★★ **Replace the rc first, then place the shim** (review B3 / 2026-08-24).
  //   ⚠️ In reverse order, a failure while replacing the rc leaves "only the shim placed".
  //   ★ In this order the worst case is "the block went in but there is no shim" = the front of PATH misses and
  //     **the real claude starts normally** (`command -v` skips directories without an executable)
  //     = it errs on the harmless side.
  const failed = await commitStaged(staged, t('設置しました', 'Installed'))
  if (failed.error) {
    await rm(tmpShim, { force: true })
    reportCommitFailure(failed, t('shim は置いていません。', 'The shim was not placed.'))
    process.exit(1)
  }
  await relinkAll(relinks)
  // ⚠️ Failing here leaves **only the rc changed** (review B6).
  //    ★ Do not roll back: even with only the block present, the front of PATH misses and **the real claude starts**.
  //    ⇒ **Say what happened** and exit (never crash silently with a stack trace).
  try {
    await rename(tmpShim, shimPath)
  } catch (err) {
    await rm(tmpShim, { force: true })
    console.error(t(`⚠️ shim を置けませんでした: ${shimPath}（${err.code ?? err.message}）`, `⚠️ Could not place the shim: ${shimPath} (${err.code ?? err.message})`))
    console.error(t('   rc のブロックは入っています（＝ 素の claude は普通に起動します）。', '   The rc block is in place (= claude itself starts normally).'))
    console.error(t('   ⇒ その場所を空けてから流し直してください。打鍵は使えません。', '   ⇒ Free that path and run this again. Typing from the phone will not work.'))
    process.exit(1)
  }
  console.log(t(`設置しました: ${shimPath}`, `Installed: ${shimPath}`))
  console.log(t(`  本物: ${real}（${realVersion}）`, `  real: ${real} (${realVersion})`))
  console.log(`  ${relayNote}`)

  // ★★ From here on, checks to prevent "silently passing straight through" (reflecting on 20 minutes lost on 2026-08-23)
  console.log('')
  warnAbsoluteCalls(plans)
  // ★★ **Look in the same shape as a real terminal** (login + interactive).
  //    ⚠️ Looking only non-login (`bash -i`) lies with "✅" where `.profile` later takes over PATH
  //       (it actually lied on 2026-08-23)
  // ★ Use **the same shell as the rc we wrote** for the check (2026-08-23).
  //   ⚠️ Asking a zsh user via bash, bash does not read `.zshrc`, so
  //      it falsely warns "not reached" even when the install succeeded (every mac).
  const probeShell = rcPath.endsWith('.zshrc') ? 'zsh' : 'bash'
  // ⚠️ Inheriting the parent's PATH gives **✅ even without any block** (measured).
  //   ⇒ Start with a PATH that has the shim directory **removed**, and see whether the rc puts it back.
  const cleanPath = (process.env['PATH'] ?? '')
    .split(':')
    .filter((d) => d && resolve(d) !== resolve(binDir))
    .join(':')
  // ⚠️ rc files sometimes print things to stdout (Ubuntu's sudo hint, fastfetch etc.).
  //   ⇒ **Wrap with sentinels and extract** (`.trim()` and comparing whole gives false warnings / measured).
  //   ⚠️ Never write raw control characters in source (git treats the file as binary / CLAUDE.md §5)
  const MARK = '\u0001'
  const probe = (flags) => {
    try {
      const out = execFileSync(
        probeShell,
        [...flags, '-c', `printf "${MARK}%s${MARK}" "$(command -v claude)"`],
        {
          encoding: 'utf8',
          timeout: 15_000,
          stdio: ['ignore', 'pipe', 'ignore'],
          env: childEnv({ PATH: cleanPath }),
        },
      )
      const m = new RegExp(`${MARK}([^${MARK}]*)${MARK}`).exec(out)
      return m?.[1]?.trim() ?? ''
    } catch {
      return ''
    }
  }
  const login = probe(['-l', '-i'])
  const plain = probe(['-i'])
  const ok = (v) => v && resolve(v) === resolve(shimPath)
  if (!login && !plain) {
    console.log(t('⬜ 新しいシェルでの解決先を確認できませんでした。手で確かめてください:', '⬜ Could not check what claude resolves to in a new shell. Check it by hand:'))
    console.log("   bash -l -i -c 'command -v claude'")
  } else if (ok(login) && ok(plain)) {
    console.log(t(`✅ 新しい端末では claude → ${login}（shim に届いています）`, `✅ In a new terminal, claude → ${login} (reaches the shim)`))
  } else {
    const unmeasured = t('（測れませんでした）', '(could not measure)')
    console.log(t('⚠️⚠️ **shim に届いていません。** 打鍵は使えず、受信箱（英文の枠つき）に落ちます。', '⚠️⚠️ **claude does not reach the shim.** Typing will not work; messages fall back to the inbox (with an English frame).'))
    console.log(t(`   ログイン+対話（＝実際の端末）: ${login || unmeasured}`, `   login + interactive (= a real terminal): ${login || unmeasured}`))
    console.log(t(`   対話のみ                    : ${plain || unmeasured}`, `   interactive only                        : ${plain || unmeasured}`))
    console.log(t('   ⇒ shim より**後**に PATH を書き換えているものがあります。', '   ⇒ Something rewrites PATH **after** the shim.'))
    console.log(t(`      置いたファイル: ${plans.map((x) => x.path).join(' / ')}`, `      files written: ${plans.map((x) => x.path).join(' / ')}`))
    console.log(t('      その設定（mise / nvm / direnv / .zlogin など）より後ろにブロックを移してください。', '      Move the block after that setting (mise / nvm / direnv / .zlogin, etc.).'))
  }
  // ★★ Place the `nyan` / `nyan-remote` commands in the same directory (2026-09-24 / `lib/cli.mjs`).
  //   ⚠️ The directory's safety (owned by us, not a symlink, not writable by others) was checked above
  for (const r of await installCli({ binDir, root: resolve(here, '..'), pathEnv: process.env['PATH'] })) {
    if (r.result === 'skipped') console.log(t(`⚠️ ${r.name} は置いていません（${r.reason}）`, `⚠️ ${r.name} was not placed (${r.reason})`))
    else console.log(t(`✅ ${r.name} のコマンド: ${join(binDir, r.name)}${r.result === 'kept' ? '（同じ中身）' : ''}`, `✅ ${r.name} command: ${join(binDir, r.name)}${r.result === 'kept' ? ' (unchanged)' : ''}`))
  }
  console.log('')
  console.log(t('⚠️ 反映されるのは**新しいシェル**からです（いま開いているセッションは対象外）。', '⚠️ This takes effect in **new shells** (sessions open now are not affected).'))
  console.log(t('確認: 新しい端末で claude を起こし、~/.nyan-remote/panes/ に名乗りが出れば成功。', 'Check: start claude in a new terminal; it worked if an entry appears in ~/.nyan-remote/panes/.'))
  console.log(t('逃げ道: NYAN_REMOTE_NO_RELAY=1 claude … で素の claude が起動します。', 'Bypass: NYAN_REMOTE_NO_RELAY=1 claude … starts claude directly.'))
}

/**
 * ★ Print call styles that bypass the shim **for every file we touch**.
 * ⚠️⚠️ It used to look only at `plans[0]` (= `.bashrc`), so **absolute-path calls in `.profile`
 *    passed silently** (install says ✅ yet keystrokes do not work / Q4).
 * ⚠️ Print "which file" and "that line" **together** on one line (separately, readers cannot connect them).
 */
function warnAbsoluteCalls(plans) {
  for (const { path, before } of plans) {
    const abs = absoluteClaudeCalls(before)
    if (!abs.length) continue
    console.log(t('⚠️ **shim を通らない呼び方があります**（パス付きで claude を起こしています）:', '⚠️ **Some calls bypass the shim** (they start claude by path):'))
    for (const line of abs.slice(0, 5)) console.log(`   ${path}: ${line}`)
    if (abs.length > 5) console.log(t(`   （ほか ${abs.length - 5} 行）`, `   (${abs.length - 5} more lines)`))
    console.log(t('   （打鍵で渡したいなら、その行を `claude` に直してください）', '   (to type from the phone, change that line to plain `claude`)'))
  }
}

/**
 * Only **prepare the rc in a temp file** (do not replace yet).
 *
 * ★★ **Replace only after everything is prepared and verified** (`commitStaged`).
 *   ⚠️ The replacement itself is **a `rename` per file, in order** (there is no way to switch several
 *      files at once). ⇒ If it fails midway, **roll back** (`commitStaged` rolls back / B3).
 *   ⚠️ Only install used to work this way; **`--uninstall` truncated/wrote the rc directly**
 *      (2026-08-23 review A2). ⇒ A failure on the second file left **a half-removed state**,
 *      possibly with a half-written rc (= the user's interactive shell comes back broken).
 * ⚠️ **Never write the same file twice** (when `.profile` is a symlink to `.bashrc`, the temp file paths
 *    used to collide and **it crashed with a stack trace** / A4 / measured).
 *    ⚠️ Tell them apart by **dev + ino** (`realpathSync` **cannot tell hard links apart** / B4).
 *    ⚠️ Hard links are **re-linked after replacing** (`rename` swaps the inode, so
 *       the skipped side is left with the old contents).
 * ⚠️ `writeFile`'s `mode` is **trimmed by the umask** (measured: umask 077 + 0644 → 0600), so
 *    restore it with `chmod` after writing (A5).
 * @returns {Promise<{staged: {path:string,target:string,tmp:string,before:string}[], error?: string}>}
 */
/**
 * Which shell to syntax-check with. ⚠️ Decided by **the original name** (review B4).
 *
 * ⚠️ It used to be decided by the link target's name, so with `~/.zshrc -> ~/dotfiles/zshrc` (a common setup)
 *    **bash** was chosen, rejected valid zsh syntax (`repeat 3; do …; done` etc.), and
 *    installing became impossible.
 */
export function checkerFor(rcPath) {
  return rcPath.endsWith('.zshrc') || rcPath.endsWith('.zprofile') ? 'zsh' : 'bash'
}

/**
 * Decide **where to write** the rc. For a symlink, return its target (even if the target does not exist).
 * ⚠️ `realpathSync` throws if the target does not exist, so follow it with `readlinkSync`.
 */
function resolveRcTarget(path) {
  try {
    if (!lstatSync(path).isSymbolicLink()) return realpathSync(path)
  } catch {
    return path // does not exist at all
  }
  try {
    return realpathSync(path) // the target exists
  } catch {
    const to = readlinkSync(path)
    return to.startsWith('/') ? to : resolve(dirname(path), to)
  }
}

async function stageRcFiles(plans, { syntaxCheck }) {
  const staged = []
  /** real file → the first path found */
  const seen = new Map()
  /** was a hard link, so re-link after replacing */
  const relinks = []
  const cleanup = async () => {
    for (const st of staged) await rm(st.tmp, { force: true })
  }
  for (const { path, before, after } of plans) {
    if (after === before) {
      console.log(t(`変更なし: ${path}（すでにこの形です）`, `Unchanged: ${path} (already in this form)`))
      continue
    }
    // ⚠️ If the rc is a symlink (dotfiles-managed), replace **the target** (do not clobber the link with rename).
    //    ⚠️⚠️ **Symlinks whose target does not exist yet** are common too (before cloning dotfiles, etc.).
    //       `existsSync` is false for them, so **the symlink itself used to be clobbered with a regular file**.
    const target = resolveRcTarget(path)
    // ★ Never write the same file twice. ⚠️ **`realpathSync` cannot tell hard links apart**
    //   (it returns different path strings), so if it exists compare **dev + ino** (review B4).
    let key = target
    try {
      const st = statSync(target)
      key = `${st.dev}:${st.ino}`
    } catch {
      // files that do not exist yet (to be created) are compared by path
    }
    const first = seen.get(key)
    if (first !== undefined) {
      // ⚠️⚠️ **Deduplication alone is not enough** (for hard links / review B4).
      //    `rename` swaps the inode, so the skipped side is **left with the old contents**.
      //    ⇒ For a regular file, **re-link it after replacing**.
      let sameLink = false
      try {
        sameLink = !lstatSync(path).isSymbolicLink()
      } catch {
        sameLink = false
      }
      if (sameLink && path !== first) {
        relinks.push({ path, target: first })
        console.log(t(`同じ実体です: ${path} → ${first}（置き換えたあとリンクを張り直します）`, `Same file: ${path} → ${first} (the link is recreated after replacing)`))
      } else {
        console.log(t(`変更なし: ${path}（${target} と同じ実体です）`, `Unchanged: ${path} (same file as ${target})`))
      }
      continue
    }
    seen.set(key, target)
    const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600
    const tmp = `${target}.nyan-remote-new-${process.pid}`
    await rm(tmp, { force: true })
    try {
      await writeFile(tmp, after, { flag: 'wx', mode })
      await chmod(tmp, mode)
    } catch (err) {
      await cleanup()
      await rm(tmp, { force: true })
      return { staged: [], error: t(`${path} に書けません（${err.code ?? err.message}）`, `cannot write ${path} (${err.code ?? err.message})`) }
    }
    if (syntaxCheck) {
      // ⚠️ Check with bash / zsh (the block's own POSIX compliance is checked by tests with `sh -n`).
      //    Using `sh -n` here would make a single bashism in the user's rc block the install
      const checker = checkerFor(path)
      try {
        execFileSync(checker, ['-n', tmp], { stdio: 'pipe' })
      } catch (err) {
        await cleanup()
        await rm(tmp, { force: true })
        const detail = String(err.stderr ?? err.message).slice(0, 400)
        return { staged: [], error: t(`${path} の内容が ${checker} の構文検査で落ちました\n${detail}`, `${path} failed the ${checker} syntax check\n${detail}`) }
      }
    }
    // ⚠️ **Do not reuse `before` (the contents) as an existence flag** (review B6).
    //    If the original is **a 0-byte file**, it is judged "did not exist", no backup is taken, and
    //    the rollback **deletes it**. ⇒ Keep `existed` separately
    staged.push({ path, target, tmp, before, existed: existsSync(target) })
  }
  return { staged, relinks }
}

/**
 * Re-link an rc that was a hard link (restore the relationship `rename` broke).
 * ⚠️ Even on failure **get the contents right** (fall back to copying).
 */
async function relinkAll(relinks) {
  for (const { path, target } of relinks) {
    try {
      await rm(path, { force: true })
      linkSync(target, path)
    } catch {
      try {
        await copyFile(target, path)
        console.log(t(`⚠️ ${path} はリンクを張り直せませんでした（中身は合わせました）`, `⚠️ Could not recreate the link for ${path} (its content was synced)`))
      } catch (e2) {
        console.error(t(`⚠️⚠️ ${path} を更新できませんでした（${e2.code ?? e2.message}）`, `⚠️⚠️ Could not update ${path} (${e2.code ?? e2.message})`))
      }
    }
  }
}

/**
 * Replace the prepared temp files **atomically** (after taking backups).
 *
 * ★★ **If it fails midway, restore what was already replaced** (review B3 / 2026-08-24).
 *   ⚠️ It used to just `rename` one by one, so when the second failed
 *      **only the first stayed replaced** and it crashed with a stack trace (= a half-installed state).
 *   ⚠️ What can actually happen is e.g. "a symlink to a file owned by someone else in a sticky location"
 *      (`rename` fails with EPERM).
 * @returns {error, restored} only on failure
 */
async function commitStaged(staged, verb) {
  const done = []
  for (const [i, st] of staged.entries()) {
    const { path, target, tmp, before, existed } = st
    void before
    const backup = `${target}.nyan-remote-backup-${stamp()}`
    try {
      if (existed) await copyFile(target, backup)
      // ★ **A test-only injection point** (this path cannot be created from outside). ⚠️ Unset in production
      if (process.env['NYAN_REMOTE_TEST_FAIL_COMMIT'] === String(i)) {
        throw Object.assign(new Error('テストのために失敗させました'), { code: 'ETEST' })
      }
      await rename(tmp, target) // ★ replace atomically
    } catch (err) {
      // ⚠️ Discard temp files not yet swapped in
      for (const s of staged) await rm(s.tmp, { force: true })
      const restored = []
      const lost = []
      for (const d of done.reverse()) {
        try {
          if (d.backup) await copyFile(d.backup, d.target)
          else await rm(d.target, { force: true })
          restored.push(d.target)
        } catch (e2) {
          lost.push(t(`${d.target}（バックアップ: ${d.backup ?? 'なし'} / ${e2.code ?? e2.message}）`, `${d.target} (backup: ${d.backup ?? 'none'} / ${e2.code ?? e2.message})`))
        }
      }
      return { error: t(`${path} を置き換えられませんでした（${err.code ?? err.message}）`, `could not replace ${path} (${err.code ?? err.message})`), restored, lost }
    }
    done.push({ target, backup: existed ? backup : undefined })
    console.log(`${verb}: ${path}${existed ? t(`（バックアップ: ${backup}）`, ` (backup: ${backup})`) : ''}`)
  }
  // ⚠️⚠️ **Clean up only after all replacements finish** (review B6).
  //    Doing it midway, with a future-dated backup present, **deletes the backup just made
  //    as "the oldest"**, and the rollback fails with ENOENT (same with a clock that went backwards).
  for (const d of done) if (d.backup) await pruneBackups(d.target)
  return {}
}

/** Report when commitStaged fails. ⚠️ **Always say what was done** (never leave it half-done silently) */
function reportCommitFailure(res, extra) {
  console.error(`⚠️ ${res.error}`)
  if (res.restored?.length) console.error(t(`   **元に戻しました**: ${res.restored.join(' / ')}`, `   **Restored**: ${res.restored.join(' / ')}`))
  if (res.lost?.length) {
    console.error(t('   ⚠️⚠️ **戻せませんでした**（手で戻してください）:', '   ⚠️⚠️ **Could not restore** (restore these by hand):'))
    for (const l of res.lost) console.error(`      ${l}`)
  }
  if (!res.restored?.length && !res.lost?.length) console.error(t('   何も変えていません。', '   Nothing was changed.'))
  if (extra) console.error(`   ${extra}`)
}

/**
 * ★ Remove the shim. ⚠️⚠️ **Only what we wrote** (2026-08-23 review A2).
 *
 * In environments where `bin` is a symlink to a shared directory, `rm` **deleted an unrelated claude**
 * (install's symlink check runs after uninstall, so it had no effect).
 */
async function removeShim(shimPath, binDir) {
  try {
    if (lstatSync(binDir).isSymbolicLink()) throw new Error(t(`${binDir} が symlink です`, `${binDir} is a symlink`))
    if (!lstatSync(shimPath).isFile()) throw new Error(t('通常ファイルではありません', 'not a regular file'))
    const body = await readFile(shimPath, 'utf8')
    // ⚠️ **Whether it contains the marker** is not enough (review B5). A file for another purpose
    //    that merely mentions this string in its description would be removed.
    //    ⇒ Check **the shape we generate (shebang on line 1 + marker on line 2)**.
    //    ⚠️ Even this is not "proof" (anyone can make the same shape to get it removed). **The check is a heuristic**.
    if (!body.startsWith(`#!/bin/sh\n${SHIM_MARK}`)) {
      throw new Error(t('私たちが生成した形ではありません', 'not in the form we generate'))
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(t(`ありません: ${shimPath}`, `Not present: ${shimPath}`))
      return
    }
    console.log(t(`⚠️ ${shimPath} は消していません（${err.message}）`, `⚠️ ${shimPath} was not removed (${err.message})`))
    return
  }
  await rm(shimPath, { force: true })
  console.log(t(`削除しました: ${shimPath}`, `Removed: ${shimPath}`))
}

/**
 * ★ Do not accumulate backups (keep only the newest 3 / R).
 * ⚠️ **Keeping none is not acceptable** (the recovery path disappears).
 * ⚠️ Targets only files that match "**the name shape we create**" and are **regular files**.
 *    ⚠️ This is not "proof that we created it" (the same name can be made by hand).
 *    ★ Restricting to that shape makes **lexical order = time order**, so "the newest 3" means something.
 */
async function pruneBackups(target, keep = 3) {
  const dir = dirname(target)
  const prefix = `${basename(target)}.nyan-remote-backup-`
  try {
    const names = (await readdir(dir))
      // ⚠️⚠️ **Never delete by prefix match alone** (2026-08-23 review A6 / reproduced by measurement).
      //    `…backup-000-手で取った大事なもの` (a precious backup taken by hand) sorted first and was deleted as "the oldest".
      //    ⇒ Target **only names we create (the `stamp()` shape)** = lexical order becomes time order.
      .filter((n) => n.startsWith(prefix) && STAMP.test(n.slice(prefix.length)))
      // ⚠️ We always create them with `copyFile` = **regular files**. Symlinks and FIFOs are not ours.
      //    ⚠️⚠️ **Exclude them before counting** (review B5). Skipping them later lets a future-dated symlink
      //       take a slot among "the newest 3", and **only 2 real backups remain**
      .filter((n) => {
        try {
          return lstatSync(join(dir, n)).isFile()
        } catch {
          return false
        }
      })
      .sort()
    for (const n of names.slice(0, Math.max(0, names.length - keep))) {
      await rm(join(dir, n), { force: true })
    }
  } catch {
    // a cleanup failure does not stop the install
  }
}

/** ★ The name shape `stamp()` creates. ⚠️ **Only names matching this are cleaned up** */
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

// ★ Run only when executed directly, so tests can import it
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main()
}
