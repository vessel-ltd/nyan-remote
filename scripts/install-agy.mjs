#!/usr/bin/env node
// ★ Antigravity CLI (agy) setup for nyan-remote (2026-11-19 / docs/AGY.md §5).
//
//   node scripts/install-agy.mjs              place the status line relay in agy's settings, and the agy shim
//   node scripts/install-agy.mjs --uninstall  put the user's status line back exactly (or remove ours), remove the shim
//   node scripts/install-agy.mjs --dry-run    say what would change, change nothing
//
// ★ agy hands its status line command the session state (conversation id, `agent_state`, approvals pending, model,
//   context, plan quota). `hooks/agy-statusline.sh` keeps it in `~/.nyan-remote/agy/` for the session list.
// ★ Where agy keeps its settings: `~/.gemini/antigravity-cli/settings.json` (`statusLine`: command, type, enabled,
//   padding, stack_with_default / https://antigravity.google/docs/settings?tab=cli).
//   - no status line of the user's ⇒ {"type":"command","command":"'<relay>'","stack_with_default":true}: we print
//     nothing, so agy's own status line shows as before (measured 2026-11-19)
//   - the user's command status line ⇒ its command becomes "'<relay>' --nyan-remote-relay '<their command>'" (the rest
//     of their object stays); uninstall puts their command back
// ⚠️ agy not installed (no `~/.gemini/antigravity-cli`) ⇒ nothing is done (not an error: most machines have no agy).
// ⚠️ A settings file that is not a JSON object is never touched. Writes go backup → temp file → verify → rename.
// ⚠️ "Ours" = a quoted path ending in `/hooks/agy-statusline.sh`, alone or with the mark and one quoted argument.

import { chmodSync, closeSync, copyFileSync, existsSync, openSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { t } from '../shared/i18n.ts'
import { initCliLang } from './lib/lang.mjs'
import { SHIM_MARK, binDirFor, buildWrapper, resolveRealClaude } from './install-relay.mjs'

export const RELAY = join(fileURLToPath(new URL('..', import.meta.url)), 'hooks', 'agy-statusline.sh')
const MARK = '--nyan-remote-relay'

function shQuote(p) {
  return `'${String(p).replace(/'/g, `'\\''`)}'`
}

/** The inverse of `shQuote`, only for exactly its output */
function shUnquote(q) {
  if (!/^'(?:[^']|'\\'')*'$/.test(q)) return undefined
  const v = q.slice(1, -1).replace(/'\\''/g, "'")
  return shQuote(v) === q ? v : undefined
}

const Q = `'(?:[^']|'\\\\'')*'`

/**
 * What a status line command is to us: `{ ours: false }` (someone else's), `{ ours: true }` (our relay alone) or
 * `{ ours: true, inner }` (our relay in front of the user's command). A moved tree is still ours.
 */
export function readCommand(cmd, relay = RELAY) {
  if (typeof cmd !== 'string') return { ours: false }
  const alone = new RegExp(`^(${Q})$`).exec(cmd)
  const wrapped = new RegExp(`^(${Q}) (\\S+) (${Q})$`).exec(cmd)
  const m = wrapped ?? alone
  if (!m) return { ours: false }
  const path = shUnquote(m[1])
  if (!path || !(path === relay || path.endsWith('/hooks/agy-statusline.sh'))) return { ours: false }
  if (!wrapped) return { ours: true }
  if (wrapped[2] !== MARK) return { ours: false }
  const inner = shUnquote(wrapped[3])
  return inner === undefined ? { ours: false } : { ours: true, inner }
}

/**
 * ★ Apply (or remove) the relay on one parsed settings object. Returns `{ data, did }` (a new object; the input is not
 * changed). `did`: 'added' | 'relayed' | 'unchanged' | 'removed' | 'not-ours' | 'skipped' (a status line we do not
 * understand: not a command one, or disabled — left alone).
 */
export function applyAgySettings(input, { remove = false, relay = RELAY } = {}) {
  const data = { ...input }
  const sl = data.statusLine
  if (sl === undefined || sl === null) {
    if (remove) return { data, did: 'not-ours' }
    data.statusLine = { type: 'command', command: shQuote(relay), stack_with_default: true }
    return { data, did: 'added' }
  }
  if (typeof sl !== 'object' || Array.isArray(sl) || typeof sl.command !== 'string' || (sl.type ?? 'command') !== 'command') {
    return { data, did: remove ? 'not-ours' : 'skipped' }
  }
  const got = readCommand(sl.command, relay)
  if (remove) {
    if (!got.ours) return { data, did: 'not-ours' }
    if (got.inner === undefined) delete data.statusLine
    else data.statusLine = { ...sl, command: got.inner }
    return { data, did: 'removed' }
  }
  // ⚠️ A status line the user turned off stays off and untouched (wrapping it would not run anyway)
  if (sl.enabled === false && !got.ours) return { data, did: 'skipped' }
  const want = got.ours ? (got.inner === undefined ? shQuote(relay) : `${shQuote(relay)} ${MARK} ${shQuote(got.inner)}`) : `${shQuote(relay)} ${MARK} ${shQuote(sl.command)}`
  if (want === sl.command) return { data, did: 'unchanged' }
  data.statusLine = { ...sl, command: want }
  // ★ Ours from another tree (a moved install) is re-pointed here: a change to write
  return { data, did: 'relayed' }
}

export function agyHome(home = homedir()) {
  return join(home, '.gemini', 'antigravity-cli')
}

function stateDir(home = homedir()) {
  return process.env.NYAN_REMOTE_STATE_DIR ?? join(home, '.nyan-remote')
}

/** ★ The directory the relay writes into: ours, private, never a link. Returns a problem or undefined */
export function ensureStateDir(dir) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const st = lstatSync(dir)
    if (st.isSymbolicLink() || !st.isDirectory()) return t(`${dir} がディレクトリではありません`, `${dir} is not a directory`)
    chmodSync(dir, 0o700)
    return undefined
  } catch (err) {
    return err.message
  }
}

export function main(argv = process.argv.slice(2), home = homedir(), env = process.env) {
  initCliLang()
  const remove = argv.includes('--uninstall') || argv.includes('--remove')
  const dry = argv.includes('--dry-run')
  const settings = settingsStep({ remove, dry, home })
  const shim = shimStep({ remove, dry, home, env })
  return settings || shim
}

/** The status line part (see the top of this file) */
function settingsStep({ remove, dry, home }) {
  const root = agyHome(home)
  if (!existsSync(root)) {
    console.log(t('・agy（Antigravity CLI）は入っていないので、何もしません', '- agy (Antigravity CLI) is not installed here; nothing to do'))
    return 0
  }
  const path = join(root, 'settings.json')
  let data = {}
  // ⚠️ A link whose target is missing (dotfiles not there right now) is left alone: writing would replace the link
  //    with a file of ours (codex review)
  let link = false
  try {
    link = lstatSync(path).isSymbolicLink()
  } catch {
    // not there
  }
  if (link && !existsSync(path)) {
    console.error(t(`⚠️ ${path} はリンク先が見つからないので触りません`, `⚠️ ${path} is a link to something missing; leaving it alone`))
    return 0
  }
  if (existsSync(path)) {
    let raw
    try {
      raw = readFileSync(path, 'utf8')
      data = raw.trim() === '' ? {} : JSON.parse(raw)
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(t('オブジェクトではありません', 'not a JSON object'))
    } catch (err) {
      // ⚠️ agy is optional: its broken settings never stop nyan's install or update (codex review).
      // ⚠️⚠️ Removing stops when the file still names our relay (`nyan uninstall` must not delete what it runs);
      //    unreadable ⇒ cannot tell ⇒ stops too
      const ours = remove && (raw === undefined || raw.includes('agy-statusline.sh'))
      console.error(t(`${ours ? '✗' : '⚠️'} ${path} を読めません（触りません）: ${err.message}`, `${ours ? '✗' : '⚠️'} cannot read ${path} (leaving it untouched): ${err.message}`))
      if (ours) {
        console.error(t('   nyan の中継が残っているかもしれません。直してから、もう一度実行してください', '   The nyan relay may still be in it. Fix the file, then run this again'))
        return 1
      }
      return 0
    }
  } else if (remove) {
    console.log(t('・agy の設定ファイルが無いので、外すものはありません', '- agy has no settings file; nothing to remove'))
    return 0
  }
  if (!remove && !dry) {
    const problem = ensureStateDir(join(stateDir(home), 'agy'))
    if (problem) console.warn(t(`⚠️ agy の状態を置くディレクトリを用意できません: ${problem}`, `⚠️ cannot prepare the directory for agy's state: ${problem}`))
  }
  const { data: next, did } = applyAgySettings(data, { remove })
  const said = {
    added: t('statusLine に nyan の中継を置きます（agy の表示は今までどおり）', 'placing the nyan relay as the status line (agy shows the same as before)'),
    relayed: t('あなたの statusLine の前に nyan の中継を挟みます（表示は今までどおり）', 'the nyan relay goes in front of your status line (it shows the same as before)'),
    unchanged: t('変更なし', 'unchanged'),
    removed: t('nyan の中継を外します', 'removing the nyan relay'),
    'not-ours': t('nyan の中継はありません', 'no nyan relay there'),
    skipped: t('statusLine が command 形式でない・止めてあるので触りません（agy のセッションは一覧に出ません）', 'the status line is not a command one or is turned off, so it is left alone (agy sessions will not be listed)'),
  }[did]
  console.log(`・${path}  ${said}`)
  if (did !== 'added' && did !== 'relayed' && did !== 'removed') return 0
  if (dry) return 0
  try {
    write(path, next)
  } catch (err) {
    // ⚠️ A read-only dotfiles target and the like: installing or updating goes on (agy is optional). ⚠️⚠️ Removing
    //    stops: our relay is still named there, and `nyan uninstall` must not delete the file it runs (codex review)
    console.error(
      remove
        ? t(`✗ ${path} を書けませんでした（nyan の中継が残っています）: ${err.message}`, `✗ could not write ${path} (the nyan relay is still in it): ${err.message}`)
        : t(`⚠️ ${path} を書けませんでした（agy の行は一覧に出ません）: ${err.message}`, `⚠️ could not write ${path} (agy sessions will not be listed): ${err.message}`),
    )
    return remove ? 1 : 0
  }
  console.log(
    remove
      ? t('✔ 外しました', '✔ Removed')
      : t('✔ 置きました。★ 次に起こす agy から一覧に出ます（いま開いている agy は再起動で）', '✔ Done. ★ agy sessions started from now on appear in the list (restart the ones open now)'),
  )
  return 0
}

/** ★ The relay itself (`scripts/relay.py`) the agy shim starts agy through */
export const RELAY_PY = join(fileURLToPath(new URL('..', import.meta.url)), 'scripts', 'relay.py')

/** ★ Ours = the shape we generate (shebang on line 1, the mark on line 2), the same test as the claude shim's removal */
function isOurAgyShim(path) {
  try {
    if (!lstatSync(path).isFile()) return false
    return readFileSync(path, 'utf8').startsWith(`#!/bin/sh\n${SHIM_MARK}`)
  } catch {
    return false
  }
}

/**
 * ★★ The way in for typing from the phone (2026-11-20 / docs/AGY.md §8): `~/.nyan-remote/bin/agy`, the same shim as
 * `claude`'s (`buildWrapper` with the name `agy`), starts agy through `scripts/relay.py`.
 * ⚠️ The shim directory is put first on PATH by `install-relay.mjs` (run before this). Not there ⇒ nothing here.
 * ⚠️ No real agy on PATH ⇒ no shim (a shim we placed earlier stays: it searches PATH again when it runs).
 * ⚠️ A file there that we did not write is never touched. Removing removes only ours.
 * ⚠️ Fail-open like the claude shim: `NYAN_REMOTE_NO_RELAY=1`, no terminal, `-p` / `--print` / `--prompt` ⇒ agy itself.
 */
export function shimStep({ remove, dry, home, env = process.env }) {
  const binDir = binDirFor(home, env)
  const shimPath = join(binDir, 'agy')
  // ⚠️ The shim directory must be a real directory (a link could point into someone else's install / codex review)
  try {
    if (lstatSync(binDir).isSymbolicLink()) {
      console.log(t(`⚠️ ${binDir} がリンクなので、agy の入口には触りません`, `⚠️ ${binDir} is a link, so the agy shim is left alone`))
      return 0
    }
  } catch {
    // not there: handled below
  }
  const exists = existsSync(shimPath) || (() => {
    try {
      lstatSync(shimPath)
      return true
    } catch {
      return false
    }
  })()
  if (remove) {
    if (!exists) return 0
    if (!isOurAgyShim(shimPath)) {
      console.log(t(`⚠️ ${shimPath} は nyan が置いたものではないので消しません`, `⚠️ ${shimPath} was not placed by nyan; leaving it`))
      return 0
    }
    if (!dry) rmSync(shimPath, { force: true })
    console.log(t(`・${shimPath} を外しました`, `- removed ${shimPath}`))
    return 0
  }
  if (!existsSync(binDir)) {
    console.log(t('・打鍵の経路（~/.nyan-remote/bin）が無いので、agy の入口は置きません', '- the typing route (~/.nyan-remote/bin) is not set up, so the agy shim is not placed'))
    return 0
  }
  const real = resolveRealClaude(env.PATH, binDir, undefined, 'agy')
  if (!real) {
    console.log(t('・PATH に agy が見つからないので、agy の入口は置きません', '- agy is not on PATH, so the agy shim is not placed'))
    return 0
  }
  if (exists && !isOurAgyShim(shimPath)) {
    console.log(t(`⚠️ ${shimPath} に nyan のものではないファイルがあるので触りません（スマホから agy へは送れません）`, `⚠️ ${shimPath} exists and is not nyan's; leaving it (agy cannot be typed into from the phone)`))
    return 0
  }
  const body = buildWrapper({ real, relay: RELAY_PY, name: 'agy' })
  if (exists && readFileSync(shimPath, 'utf8') === body) {
    console.log(t(`・${shimPath}  変更なし`, `- ${shimPath}  unchanged`))
    return 0
  }
  console.log(t(`・${shimPath}  agy を nyan の relay 経由で起こす入口を置きます（本物: ${real}）`, `- ${shimPath}  placing the shim that starts agy through the nyan relay (real: ${real})`))
  if (dry) return 0
  // ⚠️ A fresh temp name, created exclusively: a link left at a fixed name would have us write through it (codex review)
  const tmp = `${shimPath}.tmp-nyan-${process.pid}-${Date.now()}`
  try {
    writeExclusive(tmp, body, 0o755)
    chmodSync(tmp, 0o755)
    renameSync(tmp, shimPath)
  } catch (err) {
    if (existsSync(tmp) && err?.code !== 'EEXIST') rmSync(tmp, { force: true })
    // ⚠️ agy is optional: never stops nyan's install or update
    console.error(t(`⚠️ ${shimPath} を置けませんでした: ${err.message}`, `⚠️ could not place ${shimPath}: ${err.message}`))
    return 0
  }
  console.log(t('✔ 新しいターミナルで起こす agy から、スマホで送信・停止ができます', '✔ agy started in a new terminal can be typed into and stopped from the phone'))
  return 0
}

/**
 * ★ A new file under a name nobody has (`wx`: a link or file already there ⇒ EEXIST, left alone). Once this run made
 * it, a failed write removes it (a full disk would otherwise leave a part behind / codex review).
 */
function writeExclusive(path, body, mode) {
  const fd = openSync(path, 'wx', mode)
  let open = true
  try {
    writeFileSync(fd, body)
    open = false
    closeSync(fd)
  } catch (err) {
    // ⚠️ close can fail too (NFS reports a full quota there / codex review): the part is ours to remove either way
    if (open) {
      try {
        closeSync(fd)
      } catch {}
    }
    rmSync(path, { force: true })
    throw err
  }
}

/** Backup → temp file → verify → rename. ★ A settings file that is a link (dotfiles) is written where it points */
function write(path, next) {
  const target = existsSync(path) ? realpathSync(path) : path
  if (existsSync(target)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    copyFileSync(target, `${target}.bak-${stamp}`)
  } else {
    mkdirSync(dirname(target), { recursive: true })
  }
  // ⚠️ A fresh name, created exclusively (a link left at a fixed name would be written through / codex review)
  const tmp = `${target}.tmp-nyan-${process.pid}-${Date.now()}`
  writeExclusive(tmp, `${JSON.stringify(next, null, 2)}\n`, existsSync(target) ? statSync(target).mode & 0o777 : 0o600)
  try {
    JSON.parse(readFileSync(tmp, 'utf8'))
    renameSync(tmp, target)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main()
