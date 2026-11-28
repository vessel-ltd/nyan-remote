#!/usr/bin/env node
// ★★ Place the `/nyan-team` skill in every Claude Code profile (docs/TEAM.md §5 / 2026-11-19) — and in Codex
//    (2026-11-27 / docs/TEAM.md §10), with the rule that lets a Codex lead's `nyan team` out of Codex's sandbox.
//
// `skills/nyan-team/SKILL.md` → `~/.claude*/skills/nyan-team/SKILL.md` (profiles with `projects/`, the same rule as the
// hooks) and `<codex home>/skills/nyan-team/SKILL.md` (`CODEX_HOME`, or `~/.codex`, when it exists).
// The rule: `<codex home>/rules/nyan-remote.rules` (user decision 2026-11-27: nyan update writes it, uninstall removes it).
// Run by install.sh and `nyan update` (`setupSteps`); `--remove` for `nyan uninstall`.
//
// ⚠️ Ours = the file carries the managed mark (`MARK`). Only such a file is replaced or removed; a file without it is the
//    user's (they deleted the line to keep their edits, or wrote their own skill under that name) and is left alone.
// ⚠️ Links are left alone (writing would change their target). Temp file → verify → rename (CLAUDE.md §5).
// ⚠️ Codex's sandbox refuses Unix sockets (measured 2026-11-18): the rule runs `<abs> team …` outside it without
//    asking (measured 2026-11-27 on 0.172.0; a pipe, `&&`, `<` or an env prefix keeps it inside).
// ⚠️⚠️ What the rule lets out must be something a sandboxed session cannot rewrite (codex review ② r2 #1: the tree and
//    `~/.nyan-remote/bin` sit in a workspace when Codex works on nyan-remote itself). ⇒ A **self-contained copy** of the
//    team command in `<codex home>/.codex/nyan-remote/` (`COPY_FILES`) and a launcher there (`launcherText`): Codex keeps
//    `.codex` read-only inside its sandbox even when it lies in the workspace (measured 2026-11-27), and it is outside
//    every other workspace. The launcher runs a fixed node (`trustedNode`) with a cleaned environment.
// ⚠️⚠️ The rule names the launcher by its **absolute path** (codex review ② r1 #1, measured: a rule on the bare name
//    `nyan` also let a workspace's own `./nyan` script out of the sandbox). The Codex copy of the skill says that path.
// ⚠️⚠️ `create` is confirmed on the phone (user decision 2026-11-27 / `agent/src/teamConfirm.ts`): Codex can approve its
//    own escalations, so no Codex prompt is the human's yes. The rule allows `team` as a whole.
// ⚠️ It covers only `team`: the launcher runs nothing else (update, uninstall stay with `nyan` itself).
// ⚠️⚠️ Only into `~/.codex` itself — a real folder (no link), with `CODEX_HOME` unset or naming it (codex review ② r6
//    #1): the copy is read-only only under a workspace's **direct** `.codex`, so a Codex home anywhere else (a dotfiles
//    folder, a link into one) can sit inside some workspace with nothing protecting it. Elsewhere: nothing placed, said.
//
// Exit code: 0 = placed / up to date / removed / left alone (said why) / could not place (said: optional) /
//            1 = could not remove (uninstall must know)

import { createHash } from 'node:crypto'
import { macAclProblem, walkPrivate } from '../agent/src/privateDir.ts'

/** ★ macOS ACLs on a destination directory (the same strict rule as the socket's / r9 high #2) */
const aclBad = (p) => (process.platform === 'darwin' ? macAclProblem(p) : undefined)
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { t } from '../shared/i18n.ts'
import { initCliLang } from './lib/lang.mjs'
import { isMain } from './lib/isMain.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const SKILL_NAME = 'nyan-team'
/** ⚠️ Matched to tell ours from the user's. Never translated (CLAUDE.md §1.9: marks used to remove are not translated) */
export const MARK = '<!-- nyan-remote:managed'

/**
 * ★ Ours = the **whole** managed line, standing alone as the first non-blank line after the frontmatter (codex review
 *   r8, medium #4: a personal skill that merely quotes the mark was replaced or deleted). One predicate for both.
 */
export function isManaged(buf) {
  const lines = buf.toString('utf8').split('\n')
  if (lines[0] !== '---') return false
  const end = lines.indexOf('---', 1)
  if (end < 0) return false
  const next = lines.slice(end + 1).find((l) => l.trim() !== '')
  return next !== undefined && next.startsWith(`${MARK} — `) && next.endsWith(' -->') && !next.slice(MARK.length).includes('<!--')
}
const PROFILE = /^\.claude(-[A-Za-z0-9._-]+)?$/

/** ★ The Codex rule file and its content. ⚠️ The first line is the mark (never translated / CLAUDE.md §1.9) */
export const RULE_FILE = 'nyan-remote.rules'
export const RULE_MARK = '# nyan-remote:managed'
/** ★ The rule for the launcher `entry` (an absolute path of safe characters: `codexLauncher`) */
export function ruleText(entry) {
  return `${RULE_MARK} — nyan update writes this file and nyan uninstall removes it. Delete this line to keep your own edits.
# Lets a lead session's \`${entry} team …\` reach the local nyan-remote agent (a Unix socket Codex's sandbox refuses).
# Only this exact path (a copy Codex keeps read-only): another program named nyan stays in the sandbox.
# Making a team is confirmed by you on your phone.
prefix_rule(pattern=["${entry}", "team"], decision="allow")
`
}

/** ★ The Codex copy of the skill: the shared text, with this machine's command path said right under the mark line */
export function codexSkill(src, entry) {
  const text = src.toString('utf8')
  const lines = text.split('\n')
  const at = lines.findIndex((l) => l.startsWith(`${MARK} — `))
  if (at < 0) return src
  const note = [
    '',
    `> **On this machine, in Codex, the command is \`${entry} team …\`** — always that full path, never plain \`nyan team\`: Codex's`,
    '> rule lets only that exact path out of its sandbox. Wherever this skill says `nyan team`, type that path instead.',
  ]
  lines.splice(at + 1, 0, ...note)
  return Buffer.from(lines.join('\n'))
}

/**
 * ★★ Where the copy and its launcher go, in each Codex home: `<codex home>/.codex/nyan-remote`. Codex keeps only a
 *   writable root's **direct** `.codex` read-only (codex-rs `default_read_only_subpaths_for_writable_root`, 0.172.0;
 *   codex review ② r3 #2): with `~/.codex` itself opened as the workspace (editing Codex's settings), a copy directly
 *   in it was writable. One `.codex` deeper, the home, `~/.codex` or any folder above them as the workspace all keep
 *   it read-only. Left: opening Codex in `~/.codex/.codex` or deeper (documented).
 */
export const LAUNCHER_DIR = '.codex/nyan-remote'
export const LAUNCHER = 'nyan'
/**
 * ★★ The team command and everything it imports (`copy is self-contained` in the tests reads every import). Copied from
 *   the installed tree as is; a `package.json` of our own stops Node from reading one further up.
 */
export const COPY_FILES = ['scripts/team.mjs', 'scripts/lib/lang.mjs', 'agent/src/privateDir.ts', 'shared/i18n.ts']
/** ⚠️ The launcher's second line: what makes the folder ours (never translated / CLAUDE.md §1.9) */
export const LAUNCHER_MARK = '# nyan-remote:managed — Codex lead launcher'
/** The environment the team command keeps (everything else is dropped: `NODE_OPTIONS` and the like never reach node) */
export const KEPT_ENV = ['HOME', 'CODEX_THREAD_ID', 'CODEX_HOME', 'NYAN_REMOTE_STATE_DIR', 'NYAN_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG']

const SAFE_PATH = /^[A-Za-z0-9._/+-]+$/

/** ★ The launcher: `team` only, the pinned node, the copy, a cleaned environment (paths are safe characters) */
export function launcherText(node, dir) {
  const keep = KEPT_ENV.map((k) => `\${${k}+"${k}=$${k}"}`).join(' ')
  return `#!/bin/sh
${LAUNCHER_MARK}. nyan update writes this folder; nyan uninstall removes it.
# Codex's rule (rules/nyan-remote.rules) lets only this file out of its sandbox: it runs nyan-remote's team command
# from this folder, with this node and a cleaned environment.
[ "$1" = team ] || { echo 'nyan-remote: this command runs "team" only' >&2; exit 2; }
shift
[ -x '${node}' ] || { echo 'nyan-remote: node is no longer at ${node}: run nyan update' >&2; exit 1; }
exec /usr/bin/env -i PATH=/usr/bin:/bin ${keep} '${node}' '${dir}/scripts/team.mjs' "$@"
`
}

/** Ours = the launcher's first two lines */
export function isOurLauncher(buf) {
  return buf.toString('utf8').startsWith(`#!/bin/sh\n${LAUNCHER_MARK}.`)
}

/**
 * ★ The node the launcher pins: its real path, a plain file, and nothing on the way changeable by anyone but this user
 *   or root (a sticky folder only above its own folder). Undefined when it is not so (no launcher, said).
 */
export function trustedNode(execPath, uid = process.getuid?.(), lstat = lstatSync) {
  let real
  try {
    real = realpathSync(execPath)
  } catch {
    return undefined
  }
  if (!SAFE_PATH.test(real) || !real.startsWith('/')) return undefined
  const parts = real.split('/').filter(Boolean)
  let at = '/'
  for (let i = 0; i <= parts.length; i++) {
    if (i > 0) at = at === '/' ? `/${parts[i - 1]}` : `${at}/${parts[i - 1]}`
    let st
    try {
      st = lstat(at)
    } catch {
      return undefined
    }
    if (st.isSymbolicLink()) return undefined
    if (uid !== undefined && st.uid !== uid && st.uid !== 0) return undefined
    const othersWrite = (st.mode & 0o022) !== 0
    if (i === parts.length) {
      if (!st.isFile() || othersWrite) return undefined
    } else {
      const sticky = (st.mode & 0o1000) !== 0
      if (!st.isDirectory() || (othersWrite && !(sticky && i < parts.length - 1))) return undefined
    }
    if (aclBad(at)) return undefined
  }
  return real
}

/** The copy's files: `{ rel, bytes, mode }` (the launcher last) */
export function copyContents(root, node, dir) {
  const files = COPY_FILES.map((rel) => ({ rel, bytes: readFileSync(join(root, rel)), mode: 0o600 }))
  files.push({ rel: 'package.json', bytes: Buffer.from('{ "type": "module", "private": true }\n'), mode: 0o600 })
  files.push({ rel: LAUNCHER, bytes: Buffer.from(launcherText(node, dir)), mode: 0o700 })
  return files
}

/** What is in `<codex home>/.codex/nyan-remote` now: 'absent' | 'ours' | 'theirs' | 'link' */
function launcherState(dir) {
  let st
  try {
    st = lstatSync(dir)
  } catch (err) {
    return err?.code === 'ENOENT' ? 'absent' : 'theirs'
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return 'link'
  try {
    const f = join(dir, LAUNCHER)
    if (!lstatSync(f).isFile()) return 'theirs'
    return isOurLauncher(readFileSync(f)) ? 'ours' : 'theirs'
  } catch {
    return 'theirs'
  }
}

/** Every file of the copy is already what it would be (and closed to others) */
function copyCurrent(dir, files) {
  try {
    const st = lstatSync(dir)
    if (st.isSymbolicLink() || !st.isDirectory() || (st.mode & 0o077) !== 0) return false
    return files.every(({ rel, bytes, mode }) => {
      const p = join(dir, rel)
      // ⚠️ Every folder on the way is a real folder (r14 #1: a `scripts` moved into a workspace and linked back)
      const parts = rel.split('/')
      for (let i = 1; i < parts.length; i++) {
        const d = lstatSync(join(dir, ...parts.slice(0, i)))
        if (d.isSymbolicLink() || !d.isDirectory()) return false
      }
      const f = lstatSync(p)
      return f.isFile() && (f.mode & 0o777) === mode && sha256(readFileSync(p)) === sha256(bytes)
    })
  } catch {
    return false
  }
}

/**
 * ★ The folder that holds the copy (`<codex home>/.codex`): a real folder of ours, closed to others — checked before
 *   anything in it is reused, authorized or removed (codex review ② r4 #2: a linked `.codex` led into a workspace).
 * @param make create it (private) when it is not there
 * @returns a reason, or undefined (fine); 'absent' when it is not there and not made
 */
function parentProblem(parent, make) {
  if (make) {
    try {
      mkdirSync(parent, { mode: 0o700 })
    } catch (err) {
      if (err?.code !== 'EEXIST') return err.message
    }
  }
  let pst
  try {
    pst = lstatSync(parent)
  } catch (err) {
    return err?.code === 'ENOENT' ? 'absent' : err.message
  }
  const uid = process.getuid?.()
  if (pst.isSymbolicLink() || !pst.isDirectory() || (uid !== undefined && pst.uid !== uid) || (pst.mode & 0o022) !== 0 || aclBad(parent)) {
    return t(`${parent} が自分だけのフォルダではありません（リンクか、他人も書き換えられる）`, `${parent} is not a private folder (a link, or others can change it)`)
  }
  return undefined
}

/**
 * ★ A folder Codex lets every sandbox write (codex-rs 0.172.0: `/tmp` and `$TMPDIR` are writable roots by default):
 *   no copy may live under one (r4 #2: a custom `CODEX_HOME` in /tmp)
 */
export function underSandboxTemp(real, roots) {
  return roots.some((r) => r && (real === r || real.startsWith(`${r}/`)))
}

/** The temp folders (real paths) a Codex sandbox may write by default */
export function sandboxTempRoots(env = process.env) {
  const out = []
  for (const p of ['/tmp', '/var/tmp', '/private/tmp', env.TMPDIR]) {
    if (!p || !p.startsWith('/')) continue
    try {
      out.push(realpathSync(p).replace(/\/+$/, ''))
    } catch {
      // not there
    }
  }
  return out
}

/**
 * ★ Place (or refresh) the copy and its launcher in one Codex home: built in a fresh private folder beside it, checked,
 *   then swapped in. Only ours is replaced. @returns the launcher's path, or undefined (said why)
 */
export function codexLauncher(codexHome, root, node) {
  const dir = join(codexHome, LAUNCHER_DIR)
  const entry = join(dir, LAUNCHER)
  const name = `${codexHome.split('/').pop()}/${LAUNCHER_DIR}`
  if (!SAFE_PATH.test(entry)) {
    console.log(t(`⚠️ ${name} のパスに使えない文字があるので、Codex には置きません`, `⚠️ ${name} has characters the rule cannot carry, so nothing is placed in Codex`))
    return undefined
  }
  const bad = parentProblem(dirname(dir), true)
  if (bad) {
    console.error(t(`✗ ${name} を置けません: ${bad}`, `✗ Cannot place ${name}: ${bad}`))
    return undefined
  }
  const state = launcherState(dir)
  if (state === 'theirs' || state === 'link') {
    console.log(t(`⚠️ ${name} は nyan-remote のものではないので触りません（Codex には置きません）`, `⚠️ ${name} is not nyan-remote's, so it was left alone (nothing placed in Codex)`))
    return undefined
  }
  let files
  try {
    files = copyContents(root, node, dir)
  } catch (err) {
    console.error(t(`✗ チームのコマンドを写せません: ${err.message}`, `✗ Cannot copy the team command: ${err.message}`))
    return undefined
  }
  if (state === 'ours' && copyCurrent(dir, files)) {
    console.log(t(`Codex 用の nyan team は最新です: ${name}`, `The Codex copy of nyan team is up to date: ${name}`))
    return entry
  }
  const tmp = `${dir}.tmp.${process.pid}`
  const old = `${dir}.old.${process.pid}`
  try {
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(tmp, { mode: 0o700 })
    for (const { rel, bytes, mode } of files) {
      const p = join(tmp, rel)
      mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
      writeFileSync(p, bytes, { mode, flag: 'wx' })
      chmodSync(p, mode)
      if (sha256(readFileSync(p)) !== sha256(bytes)) throw new Error(t('書いた中身が一致しません', 'the written file does not match'))
    }
    if (state === 'ours') renameSync(dir, old)
    renameSync(tmp, dir)
    rmSync(old, { recursive: true, force: true })
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true })
    console.error(t(`✗ ${name} を置けません: ${err.message}`, `✗ Cannot place ${name}: ${err.message}`))
    return undefined
  }
  console.log(t(`Codex 用の nyan team を置きました: ${name}`, `Placed the Codex copy of nyan team: ${name}`))
  return entry
}

/** Remove the copy (ours only). @returns false on a failure (said) */
export function removeCodexLauncher(codexHome) {
  const dir = join(codexHome, LAUNCHER_DIR)
  const name = `${codexHome.split('/').pop()}/${LAUNCHER_DIR}`
  // ⚠️ Never through a linked `.codex` (it could lead into someone's folder / r4 #2). Left as is and said — not a failure
  //    (r14 #2): with our rule gone, a copy behind it lets nothing out, and uninstall must go on
  const bad = parentProblem(dirname(dir), false)
  if (bad === 'absent') return true
  if (bad) {
    console.log(t(`⚠️ ${name} はリンクの先（か他人も書けるフォルダ）なので触りません`, `⚠️ ${name} is behind a link (or in a folder others can change), so it was left alone`))
    return true
  }
  const state = launcherState(dir)
  if (state === 'absent') return true
  if (state !== 'ours') {
    console.log(t(`${name} は nyan-remote のものではないので残しました`, `${name} is not nyan-remote's, so it was kept`))
    return true
  }
  try {
    rmSync(dir, { recursive: true })
    console.log(t(`Codex 用の nyan team を外しました: ${name}`, `Removed the Codex copy of nyan team: ${name}`))
    return true
  } catch (err) {
    console.error(`✗ ${name}: ${err.message}`)
    return false
  }
}

/** Ours = the first line is the managed mark line */
export function isManagedRule(buf) {
  const first = buf.toString('utf8').split('\n')[0]
  return first.startsWith(`${RULE_MARK} — `)
}

/**
 * The Codex homes. Placing: `<home>/.codex` only, when it is a real folder (not a link) and `CODEX_HOME` is unset or
 * names that very folder (r6 #1 — see the header). Removing: `CODEX_HOME` and `<home>/.codex` (whatever an older
 * version placed). Only real paths whose every folder is not changeable by others (codex review ② r1 #9).
 */
/** Homes found not fit for the copy on the last placing call (their earlier setup must go / r7 #1) */
const ineligible = new Set()
/** Homes a removal had to leave alone (others may change them) */
const skippedUnsafe = new Set()

/** ⚠️ A home a removal left alone that still holds our rule: said, and a failure (never a quiet success) */
function leftBehind() {
  const out = []
  for (const h of skippedUnsafe) {
    try {
      if (isManagedRule(readFileSync(join(h, 'rules', RULE_FILE)))) out.push(h)
    } catch {
      // no rule of ours there
    }
  }
  skippedUnsafe.clear()
  for (const h of out) {
    console.error(
      t(
        `✗ ${h}/rules/${RULE_FILE} に nyan team の許可が残っています（そのフォルダは他人も書き換えられるので触りません）。手で消して、Codex を開き直してください`,
        `✗ The nyan team rule is still in ${h}/rules/${RULE_FILE} (that folder can be changed by others, so it is left alone). Delete it by hand and restart Codex`,
      ),
    )
  }
  return out.length > 0
}

export function codexHomesOf(home, env, removing = false, uid = process.getuid?.()) {
  const fromEnv = env.CODEX_HOME && env.CODEX_HOME.startsWith('/') ? env.CODEX_HOME : undefined
  const dflt = join(home, '.codex')
  let want = [fromEnv, dflt]
  if (!removing) {
    let envReal
    try {
      envReal = fromEnv === undefined ? undefined : realpathSync(fromEnv)
    } catch {
      envReal = fromEnv
    }
    // ⚠️ Judged before ~/.codex is looked for (r8 #2: moved to CODEX_HOME with no ~/.codex left, the old setup stayed)
    let linked = false
    try {
      linked = lstatSync(dflt).isSymbolicLink()
    } catch {
      if (envReal === undefined) return []
    }
    if (linked || (envReal !== undefined && envReal !== dflt)) {
      ineligible.add(home)
      console.log(
        t(
          `⚠️ Codex をリーダーにする仕組みは、リンクでない ~/.codex だけに置きます（${linked ? '~/.codex がリンク' : `CODEX_HOME=${fromEnv}`}）。Codex には skill と許可を置きません`,
          `⚠️ The Codex lead setup goes into ~/.codex only, as a real folder (${linked ? '~/.codex is a link' : `CODEX_HOME=${fromEnv}`}): the skill and the rule are not placed in Codex`,
        ),
      )
      return []
    }
    want = [dflt]
  }
  const out = []
  for (const p of want) {
    if (!p) continue
    let real
    try {
      real = realpathSync(p)
      if (!statSync(real).isDirectory()) continue
    } catch {
      continue
    }
    const unsafe = walkPrivate(real, uid, lstatSync, 'ours')
    if (unsafe) {
      // ⚠️ Removing: one left alone may still hold our rule (r9 #1) — the caller says so and fails
      if (removing) skippedUnsafe.add(real)
      console.log(t(`⚠️ Codex のフォルダ（${p}）か、その上を他のユーザーが書き換えられるので触りません（${unsafe}）`, `⚠️ The Codex folder (${p}) or a folder above it can be changed by other users, so it is left alone (${unsafe})`))
      continue
    }
    if (!out.includes(real)) out.push(real)
  }
  return out
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex')

/** Profiles to place into: `~/.claude*` with `projects/` (removing: also any that has our skill) */
export function profiles(home, removing = false) {
  const out = []
  let names = []
  try {
    names = readdirSync(home).sort()
  } catch {
    return out
  }
  for (const name of names) {
    if (!PROFILE.test(name)) continue
    const dir = join(home, name)
    const isDir = (p) => {
      try {
        return statSync(p).isDirectory()
      } catch {
        return false
      }
    }
    if (isDir(join(dir, 'projects')) || (removing && isDir(join(dir, 'skills', SKILL_NAME)))) out.push(dir)
  }
  return out
}

/**
 * ★ What to do with one profile's copy (pure: tests hit every branch).
 * @param dest the installed bytes, 'link', 'unreadable', or undefined (confirmed absent)
 * @returns 'install' | 'same' | 'replace' | 'theirs' | 'link' | 'unreadable'
 */
export function decide(dest, src) {
  if (dest === 'link') return 'link'
  if (dest === 'unreadable') return 'unreadable'
  if (dest === undefined) return 'install'
  if (sha256(dest) === sha256(src)) return 'same'
  return isManaged(dest) ? 'replace' : 'theirs'
}

/** @returns 'absent' | 'remove' | 'theirs' | 'link' | 'unreadable' */
export function decideRemove(dest) {
  if (dest === undefined) return 'absent'
  if (dest === 'link') return 'link'
  if (dest === 'unreadable') return 'unreadable'
  return isManaged(dest) ? 'remove' : 'theirs'
}

/**
 * What is installed now, without following links below the profile (codex review, medium #4):
 *   `<profile>/skills` or `<profile>/skills/nyan-team` being a link ⇒ 'link' (writing would land in its target —
 *   a dotfiles repository, a shared folder); `SKILL.md` not a regular file ⇒ 'link' too (left alone, said so).
 * ⚠️ The profile itself too (codex review r2, medium #4): a `~/.claude-work` link to a shared profile would have
 *    update write into it and uninstall remove from it. A linked profile is left alone and said so (place it by hand).
 */
export function readDest(dir, file, { lstat = lstatSync, read = readFileSync, uid = process.getuid?.() } = {}) {
  for (const p of [dirname(dirname(dir)), dirname(dir), dir]) {
    try {
      const st = lstat(p)
      if (st.isSymbolicLink() || !st.isDirectory()) return 'link'
      // ⚠️ Another user could swap what is below it between this check and the write (codex review r4, medium #12)
      if ((uid !== undefined && st.uid !== uid) || (st.mode & 0o022) !== 0 || aclBad(p)) return 'link'
    } catch (err) {
      if (err?.code === 'ENOENT') return undefined
      return 'unreadable'
    }
  }
  try {
    const st = lstat(file)
    if (!st.isFile()) return 'link'
    return read(file)
  } catch (err) {
    return err?.code === 'ENOENT' ? undefined : 'unreadable'
  }
}

/** The installed file: not ours, writable by group/others, or (macOS) an ACL that lets someone else change it */
function fileUnsafe(file) {
  try {
    const st = lstatSync(file)
    const uid = process.getuid?.()
    return (uid !== undefined && st.uid !== uid) || (st.mode & 0o022) !== 0 || !!aclBad(file)
  } catch {
    return true
  }
}

function place(file, dir, src) {
  const tmp = `${file}.tmp.${process.pid}`
  let created = false
  try {
    // ⚠️ One level at a time with an explicit mode (a recursive mkdir under umask 0002 made group-writable folders
    //    that the check then has to trust / codex review r5, medium #4)
    for (const d of [dirname(dir), dir]) {
      try {
        mkdirSync(d, { mode: 0o755 })
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err
      }
      const st = lstatSync(d)
      if (st.isSymbolicLink() || !st.isDirectory() || (st.mode & 0o022) !== 0 || aclBad(d)) throw new Error(`${d} is not a private folder`)
    }
    writeFileSync(tmp, src, { mode: 0o644, flag: 'wx' })
    created = true
    if (sha256(readFileSync(tmp)) !== sha256(src)) throw new Error(t('書いた中身が一致しません', 'the written file does not match'))
    renameSync(tmp, file)
    created = false
    return true
  } catch (err) {
    console.error(t(`✗ skill を置けません（${file}）: ${err.message}`, `✗ Cannot place the skill (${file}): ${err.message}`))
    return false
  } finally {
    if (created) rmSync(tmp, { force: true })
  }
}

export function main(
  argv = process.argv.slice(2),
  home = process.env.HOME ?? homedir(),
  root = ROOT,
  // ⚠️ `CODEX_HOME` only for the real home (a test's temporary home never writes into the real Codex)
  env = home === (process.env.HOME ?? homedir()) ? process.env : {},
  /** (tests) the node the launcher pins; the temp folders a sandbox may write (tests live in one) */
  { node: nodePath = process.execPath, tmpRoots = sandboxTempRoots() } = {},
) {
  const removing = argv.includes('--remove')
  let src
  if (!removing) {
    try {
      src = readFileSync(join(root, 'skills', SKILL_NAME, 'SKILL.md'))
    } catch (err) {
      // ★ Optional (r14 medium #4): a missing or unreadable bundled skill never stops the core setup
      console.log(t(`⚠️ 配る skill が読めないので置きません（${err.message}）`, `⚠️ The bundled skill cannot be read, so it is not placed (${err.message})`))
      return 0
    }
  }
  // ⚠️ The home and everything above it must not be changeable by others (a profile in it could be swapped / r5 medium
  //    #4, r6 medium #6): the same walk as the team socket's directory, with "ours, not writable by others" for the home
  let homeReal
  try {
    homeReal = realpathSync(home)
  } catch {
    return 0
  }
  const unsafe = walkPrivate(homeReal, process.getuid?.(), lstatSync, 'ours')
  if (unsafe) {
    console.log(t(`⚠️ ホーム（${home}）か、その上を他のユーザーが書き換えられるので、skill は置きません（${unsafe}）`, `⚠️ Your home (${home}) or a folder above it can be changed by other users, so the skill is not placed (${unsafe})`))
    return 0
  }
  // ★ Every path below comes from the checked real home (never through `$HOME` again / r7 high #3)
  const list = profiles(homeReal, removing)
  ineligible.delete(homeReal)
  const codexHomes = codexHomesOf(homeReal, env, removing)
  // ⚠️⚠️ Not fit any more (`~/.codex` became a link into a dotfiles folder, or `CODEX_HOME` points elsewhere): what an
  //    earlier run placed is taken out — the rule still names the old absolute path, which may now lead into a
  //    workspace (codex review ② r7 #1)
  const revoke = !removing && ineligible.has(homeReal) ? codexHomesOf(homeReal, env, true) : []
  const stranded = leftBehind()
  const node = removing || codexHomes.length === 0 ? undefined : trustedNode(nodePath)
  if (list.length === 0) console.log(t('Claude Code のプロファイル（~/.claude*）が無いので、そこには skill を置きません', 'No Claude Code profile (~/.claude*), so the skill is not placed there'))
  let failed = false
  /** ⚠️ An earlier rule that could not be taken out is a failure even when placing (never "optional") */
  let revokeFailed = false
  // ★ Every place the skill goes: the Claude profiles, then Codex (its copy says this machine's command path)
  const places = list.map((profile) => ({ dir: join(profile, 'skills', SKILL_NAME), name: `${profile.split('/').pop()}/skills/${SKILL_NAME}`, src }))
  /** Codex home → its launcher (placed now) */
  const entries = new Map()
  for (const home of codexHomes) {
    // ⚠️ Without a launcher there is no rule, so no Codex skill either (it could not work)
    if (!removing) {
      if (!node) {
        console.log(
          t(
            `⚠️ node（${nodePath}）か、その上のフォルダを他のユーザーが書き換えられるので、Codex には skill と許可を置きません`,
            `⚠️ node (${nodePath}) or a folder above it can be changed by other users, so the skill and the rule are not placed in Codex`,
          ),
        )
        break
      }
      // ⚠️ A Codex home in a temp folder: every sandbox may write there (r4 #2)
      if (underSandboxTemp(home, tmpRoots)) {
        console.log(t(`⚠️ Codex のフォルダ（${home}）は一時フォルダの中なので、Codex には置きません（どの sandbox からも書けるため）`, `⚠️ The Codex folder (${home}) is inside a temp folder every sandbox may write, so nothing is placed in Codex`))
        continue
      }
      // ⚠️ The same for the node the launcher pins (r5 #1: a node unpacked under /tmp)
      if (underSandboxTemp(node, tmpRoots)) {
        console.log(t(`⚠️ node（${node}）は一時フォルダの中なので、Codex には置きません（どの sandbox からも書けるため）`, `⚠️ node (${node}) is inside a temp folder every sandbox may write, so nothing is placed in Codex`))
        break
      }
      // ⚠️ A rules folder that is a link (dotfiles): the rule could not be written, so nothing else goes either (r15 #2:
      //    a skill without its rule only ran inside the sandbox)
      if (readDest(join(home, 'rules'), join(home, 'rules', RULE_FILE)) === 'link') {
        console.log(t(`⚠️ ${home}/rules はリンク（か他人も書けるフォルダ）なので、Codex をリーダーにする仕組みは置きません`, `⚠️ ${home}/rules is a link (or others can change it), so the Codex lead setup is not placed`))
        continue
      }
      const entry = codexLauncher(home, root, node)
      if (!entry) {
        failed = true
        continue
      }
      // ★ The rule before the skill (r16 #2: a rule that could not be written left a skill that only ran inside the
      //   sandbox). No rule ⇒ this home is taken back out below (no launcher kept ⇒ revoke)
      if (!codexRule(home, false, entry)) {
        failed = true
        continue
      }
      entries.set(home, entry)
    }
    places.push({ dir: join(home, 'skills', SKILL_NAME), name: `${home.split('/').pop()}/skills/${SKILL_NAME}`, src: removing ? src : codexSkill(src, entries.get(home)) })
  }
  // ⚠️⚠️ A home where no launcher could be placed now (node or the home not fit, a linked or foreign copy folder…) keeps
  //    no rule from an earlier run either (codex review ② r13 #1: a moved-and-linked `.codex/.codex` kept the old rule)
  if (!removing) for (const h of codexHomes) if (!entries.has(h) && !revoke.includes(h)) revoke.push(h)
  for (const home of revoke) places.push({ dir: join(home, 'skills', SKILL_NAME), name: `${home.split('/').pop()}/skills/${SKILL_NAME}`, src: undefined, remove: true })
  for (const { dir, name, src, remove } of places) {
    const file = join(dir, 'SKILL.md')
    const dest = readDest(dir, file)
    if (removing || remove) {
      const what = decideRemove(dest)
      if (what === 'remove') {
        try {
          rmSync(file)
          try {
            rmdirSync(dir)
          } catch {
            // something else is in it: leave the directory
          }
          console.log(t(`/nyan-team を外しました: ${name}`, `Removed /nyan-team: ${name}`))
        } catch (err) {
          console.error(`✗ ${name}: ${err.message}`)
          failed = true
        }
      } else if (what === 'theirs') console.log(t(`${name} は手が入っているので残しました`, `${name} has your own edits, so it was kept`))
      else if (what === 'link') console.log(t(`${name} はリンク（か普通のファイルでない）なので触りません`, `${name} is a symlink (or not a plain file), leaving it as is`))
      else if (what === 'unreadable') {
        console.error(t(`✗ ${name} が読めません`, `✗ Cannot read ${name}`))
        failed = true
      }
      continue
    }
    let what = decide(dest, src)
    // ⚠️⚠️ A copy others could edit is never "up to date" (r12 high #4): ours (same bytes or marked) is replaced with a
    //    fresh file we own; one that is not ours is left alone, said so
    if ((what === 'same' || what === 'replace') && fileUnsafe(file)) what = 'replace'
    else if (what === 'theirs' && fileUnsafe(file)) console.log(t(`⚠️ ${name} は他のユーザーも書き換えられます（あなたが置いたものなので触りません）`, `⚠️ ${name} can be changed by other users (it is yours, so it was left alone)`))
    switch (what) {
      case 'same':
        console.log(t(`/nyan-team は最新です: ${name}`, `/nyan-team is up to date: ${name}`))
        break
      case 'theirs':
        console.log(t(`⚠️ ${name} は手が入っているので置き換えません（管理の印の行を消してある）`, `⚠️ ${name} has your own edits (the managed line was removed), so it was not replaced`))
        break
      case 'link':
        console.log(t(`${name} はリンク（か普通のファイルでない）なので触りません`, `${name} is a symlink (or not a plain file), leaving it as is`))
        break
      case 'unreadable':
        console.error(t(`✗ ${name} が在るのに読めません`, `✗ ${name} exists but cannot be read`))
        failed = true
        break
      default:
        if (place(file, dir, src)) console.log(what === 'replace' ? t(`/nyan-team を置き直しました: ${name}`, `Updated /nyan-team: ${name}`) : t(`/nyan-team を置きました: ${name}`, `Placed /nyan-team: ${name}`))
        else failed = true
    }
  }
  if (removing) {
    // ★ The rule first (nothing points at the copy any more), then the copy
    for (const home of codexHomes) {
      if (!codexRule(home, true)) failed = true
      else if (!removeCodexLauncher(home)) failed = true
    }
    if (codexHomes.length > 0) console.log(t('  開いている Codex は、開き直すと許可が外れます', '  Restart any open Codex to drop the rule'))
  } else {
    for (const home of revoke) {
      if (!codexRule(home, true)) {
        console.error(t(`✗ 前に置いた Codex の許可を外せませんでした（${home}）。nyan uninstall か手で外してください`, `✗ Could not take out the Codex rule placed earlier (${home}). Remove it with nyan uninstall or by hand`))
        revokeFailed = true
      } else removeCodexLauncher(home) // (with the rule gone, a copy left behind lets nothing out)
    }
    // ⚠️ An open Codex keeps the rules it read at its start (codex-rs 0.172.0 / r8 #1): only a restart drops the old one
    if (revoke.length > 0) {
      console.log(t('  ⚠️ 開いている Codex をすべて開き直してください（古い許可を覚えたままです）', '  ⚠️ Restart every open Codex (each still holds the old rule)'))
    }
    if (entries.size > 0) {
      console.log(t('  Codex は開き直すと新しい許可を読み込みます', '  Restart Codex to load the new rule'))
    }
  }
  // ★ Placing the skill is optional: a failure is said, never fatal to install.sh / nyan update (r13 medium #2 — someone
  //   who never uses teams must still finish the core setup). Removal failures still count (uninstall must know).
  if (revokeFailed || stranded) return 1
  if (failed && !removing) {
    console.log(t('⚠️ /nyan-team の skill を置けないプロファイルがありました（チームを使わないなら影響はありません）', '⚠️ The /nyan-team skill could not be placed in some profiles (no effect unless you use teams)'))
    return 0
  }
  return failed ? 1 : 0
}

/**
 * ★ The Codex rule (`<codex home>/rules/nyan-remote.rules`): placed, kept up to date, or removed — only ours (the mark).
 * @returns false on a failure (said)
 */
export function codexRule(codexHome, removing, entry) {
  const dir = join(codexHome, 'rules')
  const file = join(dir, RULE_FILE)
  const name = `${codexHome.split('/').pop()}/rules/${RULE_FILE}`
  const src = Buffer.from(removing ? '' : ruleText(entry))
  const dest = readDest(dir, file)
  const ours = Buffer.isBuffer(dest) && isManagedRule(dest)
  if (removing) {
    if (dest === undefined) return true
    // ⚠️ A linked rules folder (moved into dotfiles): left as is, but a rule of ours read through it still works for
    //    Codex (it follows the link / r10 #1) — said with its path, and a failure, never a quiet success
    if (dest === 'link') {
      let theirsOrOurs
      try {
        theirsOrOurs = readFileSync(file)
      } catch {
        return true
      }
      if (!isManagedRule(theirsOrOurs)) return true
      console.error(
        t(
          `✗ ${file} はリンクの先にあるので触りません。nyan team の許可が残っています。手で消して、Codex を開き直してください`,
          `✗ ${file} is reached through a link, so it is left alone, and it still holds the nyan team rule. Delete it by hand and restart Codex`,
        ),
      )
      return false
    }
    if (!ours) {
      if (dest === 'unreadable') {
        console.error(t(`✗ ${name} が読めません`, `✗ Cannot read ${name}`))
        return false
      }
      console.log(t(`${name} は手が入っているので残しました`, `${name} has your own edits, so it was kept`))
      return true
    }
    try {
      rmSync(file)
      console.log(t(`Codex の nyan team の許可を外しました: ${name}`, `Removed the Codex rule for nyan team: ${name}`))
      return true
    } catch (err) {
      console.error(`✗ ${name}: ${err.message}`)
      return false
    }
  }
  if (Buffer.isBuffer(dest) && sha256(dest) === sha256(src) && !fileUnsafe(file)) {
    console.log(t(`Codex の nyan team の許可は最新です: ${name}`, `The Codex rule for nyan team is up to date: ${name}`))
    return true
  }
  if (dest === 'link') {
    console.log(t(`${name} はリンク（か普通のファイルでない）なので触りません`, `${name} is a symlink (or not a plain file), leaving it as is`))
    return true
  }
  if (dest === 'unreadable') {
    console.error(t(`✗ ${name} が在るのに読めません`, `✗ ${name} exists but cannot be read`))
    return false
  }
  if (dest !== undefined && !ours) {
    console.log(t(`⚠️ ${name} は手が入っているので置き換えません（管理の印の行を消してある）`, `⚠️ ${name} has your own edits (the managed line was removed), so it was not replaced`))
    return true
  }
  if (!place(file, dir, src)) return false
  console.log(
    t(
      `Codex で nyan team を sandbox の外で動かす許可を置きました: ${name}（Codex をリーダーにするため / nyan team だけ）`,
      `Placed the Codex rule that runs nyan team outside its sandbox: ${name} (for a Codex lead; nyan team only)`,
    ),
  )
  return true
}

if (isMain(process.argv[1], import.meta.url)) {
  initCliLang()
  process.exit(main())
}
