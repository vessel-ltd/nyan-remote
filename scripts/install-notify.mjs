#!/usr/bin/env node
// ★★ Install / reinstall `~/.claude/hooks/notify.sh` (2026-09-24 / codex round 23, high #1).
//
// ⚠️⚠️ It used to **silently overwrite** with `cp` (install.sh and `nyan update`) ⇒ a notify.sh the user had modified
//    was lost on every update (no backup). ⇒ **Replace it only when it equals "one of the versions we shipped"**.
//    If it was modified, leave it alone and say so (`--force` replaces it; the backup is `notify.sh.bak`).
// ★ "Versions we shipped" = fingerprints of **every past version** of `hooks/notify.sh`
//    (git working trees: from git history / installer trees: from `hooks/notify.known` packed in the tarball).
// ⚠️ Leave machines that installed it as a link alone (that would write to its target = the tree itself).
// ⚠️ Do not install without `~/.claude` (Claude Code has never been started). ⚠️ Temp file → verify → replace (CLAUDE.md §5).
//
// `--remove` (for `nyan uninstall`): removes it only when it equals a version we shipped.
//
// Exit code: 0 = installed / identical / removed / left alone (with the reason) / 1 = could not write

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { t } from '../shared/i18n.ts'
import { initCliLang } from './lib/lang.mjs'
import { isMain } from './lib/isMain.mjs'

// ⚠️ `.pathname` keeps `%20` (breaks under paths with spaces or Japanese) ⇒ `fileURLToPath` (codex round 24, medium #2)
const ROOT = fileURLToPath(new URL('..', import.meta.url))

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** ★ Fingerprints of the notify.sh versions we shipped (every past version + the current one) */
export function knownHashes(root) {
  const out = new Set()
  try {
    out.add(sha256(readFileSync(join(root, 'hooks', 'notify.sh'))))
  } catch {
    // if missing, refused below
  }
  try {
    for (const line of readFileSync(join(root, 'hooks', 'notify.known'), 'utf8').split('\n')) {
      if (/^[0-9a-f]{64}$/.test(line.trim())) out.add(line.trim())
    }
  } catch {
    // not present in a git working tree
  }
  if (existsSync(join(root, '.git'))) for (const h of historyHashes(root)) out.add(h)
  return out
}

/** ★ Fingerprints of every notify.sh version in git history (also used by `scripts/pack.mjs`) */
export function historyHashes(root) {
  try {
    const revs = execFileSync('git', ['-C', root, 'log', '--format=%H', '--', 'hooks/notify.sh'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
    const out = []
    for (const rev of revs) {
      try {
        out.push(sha256(execFileSync('git', ['-C', root, 'show', `${rev}:hooks/notify.sh`], { stdio: ['ignore', 'pipe', 'ignore'] })))
      } catch {
        // it was deleted in that revision (the deleting commit)
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * ★ Decide what to do (⚠️ pure = tests can hit every branch).
 * @param dest the installed contents, 'link', 'unreadable' (exists but cannot be read), or undefined (**confirmed absent**)
 * @returns 'no-claude' | 'linked' | 'unreadable' | 'same' | 'install' | 'replace' | 'modified'
 */
export function decide({ claudeExists, dest, src, known, force }) {
  if (!claudeExists) return 'no-claude'
  if (dest === 'link') return 'linked'
  // ⚠️⚠️ Do not treat "unreadable" like "absent" (codex round 24, high #1): doing so removed an unreadable notify.sh **without a backup**
  if (dest === 'unreadable') return 'unreadable'
  if (dest === undefined) return 'install'
  if (sha256(dest) === sha256(src)) return 'same'
  if (known.has(sha256(dest)) || force) return 'replace'
  return 'modified'
}

/**
 * ★ Decide what `--remove` does (`nyan uninstall` / ⚠️ pure = tests can hit every branch).
 * ⚠️ Remove only a copy that equals a version we shipped (a modified one is the user's = leave it and say so).
 * @returns 'absent' | 'linked' | 'unreadable' | 'remove' | 'modified'
 */
export function decideRemove({ dest, known }) {
  if (dest === undefined) return 'absent'
  if (dest === 'link') return 'linked'
  if (dest === 'unreadable') return 'unreadable'
  return known.has(sha256(dest)) ? 'remove' : 'modified'
}

function readDest(target) {
  try {
    return lstatSync(target).isSymbolicLink() ? 'link' : readFileSync(target)
  } catch (err) {
    // ★ "Absent" only when absence is confirmed (⚠️ unreadable due to permissions etc. is different = leave it)
    return err?.code === 'ENOENT' ? undefined : 'unreadable'
  }
}

function remove(target, root) {
  const what = decideRemove({ dest: readDest(target), known: knownHashes(root) })
  switch (what) {
    case 'absent':
      console.log(t('notify.sh はありません', 'notify.sh is not installed'))
      return 0
    case 'linked':
      console.log(t('notify.sh はリンクで置いてあるので触りません（要らなければ手で消してください）', 'notify.sh is a symlink, leaving it as is (delete it by hand if you no longer need it)'))
      return 0
    case 'unreadable':
      console.error(t(`✗ notify.sh が在るのに読めません（権限を確かめてください）: ${target}`, `✗ notify.sh exists but cannot be read (check its permissions): ${target}`))
      return 1
    case 'modified':
      console.log(t(`notify.sh に手が入っているので残しました（フックからは外してあります）: ${target}`, `notify.sh has local changes, so it was kept (no hook calls it any more): ${target}`))
      return 0
  }
  try {
    rmSync(target)
  } catch (err) {
    console.error(t(`✗ notify.sh を消せません: ${err.message}`, `✗ Cannot remove notify.sh: ${err.message}`))
    return 1
  }
  console.log(t('notify.sh を消しました', 'Removed notify.sh'))
  return 0
}

export function main(argv = process.argv.slice(2), home = process.env.HOME ?? homedir(), root = ROOT) {
  const force = argv.includes('--force')
  const claude = join(home, '.claude')
  const target = join(claude, 'hooks', 'notify.sh')
  if (argv.includes('--remove')) return remove(target, root)
  const src = readFileSync(join(root, 'hooks', 'notify.sh'))
  const dest = readDest(target)
  const what = decide({ claudeExists: existsSync(claude), dest, src, known: knownHashes(root), force })
  switch (what) {
    case 'no-claude':
      console.log(t('⚠️⚠️ ~/.claude が無いので notify.sh を置けません ＝ **通知が1通も出ません**', '⚠️⚠️ ~/.claude does not exist, so notify.sh cannot be installed = **no notifications will be sent**'))
      console.log(t(`   Claude Code を一度 起動してから: node ${join(root, 'scripts', 'install-notify.mjs')}`, `   Start Claude Code once, then: node ${join(root, 'scripts', 'install-notify.mjs')}`))
      return 0
    case 'linked':
      console.log(t('notify.sh はリンクで置いてあるので触りません', 'notify.sh is a symlink, leaving it as is'))
      return 0
    case 'unreadable':
      console.error(t(`✗ notify.sh が在るのに読めません（権限を確かめてください）: ${target}`, `✗ notify.sh exists but cannot be read (check its permissions): ${target}`))
      return 1
    case 'same':
      // ⚠️⚠️ Even with identical contents, notifications fail **if it is not executable** (the hook runs this file directly / codex round 24, medium #3)
      try {
        if ((statSync(target).mode & 0o111) !== 0o111) {
          chmodSync(target, 0o755)
          console.log(t('notify.sh に実行の権限を付け直しました', 'Restored the execute permission on notify.sh'))
          return 0
        }
      } catch (err) {
        console.error(t(`✗ notify.sh の権限を直せません: ${err.message}`, `✗ Cannot fix the permissions of notify.sh: ${err.message}`))
        return 1
      }
      console.log(t('notify.sh は最新です', 'notify.sh is up to date'))
      return 0
    case 'modified':
      console.log(t('⚠️⚠️ notify.sh に手が入っているので置き換えません（配った版のどれとも違います）', '⚠️⚠️ notify.sh has local changes, so it was not replaced (it matches none of the versions we shipped)'))
      console.log(t('   ⚠️ 古いままだと通知と状態の更新が落ちることがあります。置き換えるなら（控えは notify.sh.bak）:', '   ⚠️ An old copy can make notifications and status updates fail. To replace it (a backup is kept as notify.sh.bak):'))
      console.log(`   node ${join(root, 'scripts', 'install-notify.mjs')} --force`)
      return 0
  }
  const tmp = `${target}.tmp.${process.pid}`
  let created = false
  let placed = false
  try {
    mkdirSync(dirname(target), { recursive: true })
    // ★ Keep a backup before replacing (⚠️ only one = do not accumulate)
    if (what === 'replace') copyFileSync(target, `${target}.bak`)
    // ⚠️ The temp file is **created fresh** (`wx` = refuse if it exists; never overwrite someone else's partial write)
    writeFileSync(tmp, src, { mode: 0o755, flag: 'wx' })
    created = true
    chmodSync(tmp, 0o755)
    // ⚠️ Read back what was written and verify before replacing
    if (sha256(readFileSync(tmp)) !== sha256(src)) throw new Error(t('書いた中身が一致しません', 'the written file does not match'))
    renameSync(tmp, target)
    placed = true
  } catch (err) {
    console.error(t(`✗ notify.sh を置けません: ${err.message}`, `✗ Cannot install notify.sh: ${err.message}`))
    return 1
  } finally {
    // ⚠️ On failure clean up only the temp file **we created** (leaving it accumulates with every retry / codex round 24, low #6)
    if (created && !placed) rmSync(tmp, { force: true })
  }
  console.log(what === 'replace' ? t('notify.sh を置き直しました', 'Updated notify.sh') : t('notify.sh を置きました', 'Installed notify.sh'))
  return 0
}

// ★ Detecting "run directly" lives in `lib/isMain.mjs` (works with spaces, Japanese and links / codex round 24, medium #2)
export { isMain } from './lib/isMain.mjs'

if (isMain(process.argv[1], import.meta.url)) {
  initCliLang()
  process.exit(main())
}
