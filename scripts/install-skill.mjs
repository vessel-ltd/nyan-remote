#!/usr/bin/env node
// ★★ Place the `/nyan-team` skill in every Claude Code profile (docs/TEAM.md §5 / 2026-11-19).
//
// `skills/nyan-team/SKILL.md` → `~/.claude*/skills/nyan-team/SKILL.md` (profiles with `projects/`, the same rule as the
// hooks). Run by install.sh and `nyan update` (`setupSteps`); `--remove` for `nyan uninstall`.
//
// ⚠️ Ours = the file carries the managed mark (`MARK`). Only such a file is replaced or removed; a file without it is the
//    user's (they deleted the line to keep their edits, or wrote their own skill under that name) and is left alone.
// ⚠️ Links are left alone (writing would change their target). Temp file → verify → rename (CLAUDE.md §5).
// ★ Phase 1: Claude Code only. A Codex lead is phase 1b (Codex's sandbox cannot reach the team socket).
//
// Exit code: 0 = placed / up to date / removed / left alone (said why) / could not place (said: optional) /
//            1 = could not remove (uninstall must know)

import { createHash } from 'node:crypto'
import { macAclProblem, walkPrivate } from '../agent/src/privateDir.ts'

/** ★ macOS ACLs on a destination directory (the same strict rule as the socket's / r9 high #2) */
const aclBad = (p) => (process.platform === 'darwin' ? macAclProblem(p) : undefined)
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

export function main(argv = process.argv.slice(2), home = process.env.HOME ?? homedir(), root = ROOT) {
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
  if (list.length === 0) {
    console.log(t('Claude Code のプロファイル（~/.claude*）が無いので skill は置きません', 'No Claude Code profile (~/.claude*), so the skill is not placed'))
    return 0
  }
  let failed = false
  for (const profile of list) {
    const dir = join(profile, 'skills', SKILL_NAME)
    const file = join(dir, 'SKILL.md')
    const name = `${profile.split('/').pop()}/skills/${SKILL_NAME}`
    const dest = readDest(dir, file)
    if (removing) {
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
  // ★ Placing the skill is optional: a failure is said, never fatal to install.sh / nyan update (r13 medium #2 — someone
  //   who never uses teams must still finish the core setup). Removal failures still count (uninstall must know).
  if (failed && !removing) {
    console.log(t('⚠️ /nyan-team の skill を置けないプロファイルがありました（チームを使わないなら影響はありません）', '⚠️ The /nyan-team skill could not be placed in some profiles (no effect unless you use teams)'))
    return 0
  }
  return failed ? 1 : 0
}

if (isMain(process.argv[1], import.meta.url)) {
  initCliLang()
  process.exit(main())
}
