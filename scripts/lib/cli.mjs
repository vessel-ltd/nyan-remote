// ★★ Place the `nyan-remote` / `nyan` commands (2026-09-24 / user decision).
//
// ★ They go in `~/.nyan-remote/bin` (same as the `claude` keystroke entry point = `install-relay.mjs` puts it on PATH).
// ★ They only call `scripts/nyan.mjs` in the install location ⇒ users need not remember where it is installed (`~/nyan-remote` or
//   `~/nyan-remote-app`).
// ⚠️ `nyan` is short, so **if another tool already calls itself `nyan`, do not place it** (no overwriting, no shadowing on PATH).
// ⚠️ Never overwrite or remove anything except what we placed (the marker on line 2).

import { accessSync, constants, lstatSync, readFileSync } from 'node:fs'
import { chmod, rm, writeFile, rename } from 'node:fs/promises'
import { delimiter, join, resolve } from 'node:path'
import { t } from '../../shared/i18n.ts'

export const CLI_MARK = '# nyan-remote: コマンド（scripts/nyan.mjs）'
export const CLI_NAMES = ['nyan-remote', 'nyan']

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/** ★ Contents of the command (⚠️ the install location is stored as an absolute path) */
export function cliShim(root) {
  return `#!/bin/sh\n${CLI_MARK}\nexec node ${shq(join(resolve(root), 'scripts', 'nyan.mjs'))} "$@"\n`
}

/** ★ Did we place it? (⚠️ checked by the shape of lines 1 and 2 = do not remove a file that merely mentions this string) */
export function isOurs(body) {
  return body.startsWith(`#!/bin/sh\n${CLI_MARK}\n`)
}

/** ★ Look for an executable with that name on PATH outside `binDir` (null if none) */
export function commandElsewhere(name, pathEnv, excludeDir, isExec = isExecutable) {
  const ex = resolve(excludeDir)
  for (const raw of String(pathEnv ?? '').split(delimiter)) {
    // ⚠️ An empty entry means "the current directory" (shell convention / codex round 20, low #7). Skipping it misses a clash with a nyan there
    const dir = raw === '' ? '.' : raw
    if (resolve(dir) === ex) continue
    // ⚠️ Return an absolute path (so "another nyan exists (where)" can be said as-is)
    const p = join(resolve(dir), name)
    if (isExec(p)) return p
  }
  return null
}

function isExecutable(p) {
  try {
    accessSync(p, constants.X_OK)
    return !lstatSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * ★ Place them. @returns a result per name (`placed` / `kept` (same contents) / `skipped` (reason))
 * ⚠️ `install-relay.mjs` has already checked that `binDir` is safe (owned by us, not a symlink, not writable by others)
 */
export async function installCli({ binDir, root, pathEnv }) {
  const body = cliShim(root)
  const out = []
  for (const name of CLI_NAMES) {
    const path = join(binDir, name)
    const other = commandElsewhere(name, pathEnv, binDir)
    if (other) {
      out.push({ name, result: 'skipped', reason: t(`ほかの ${name} が在ります（${other}）`, `another ${name} already exists (${other})`) })
      continue
    }
    // ⚠️⚠️ Check with `lstat` (codex round 20, medium #4): `existsSync` reports a **dangling symlink** as "absent",
    //    so a link the user made was being overwritten. ⇒ If something exists, touch nothing except a **regular file** we placed
    let st
    try {
      st = lstatSync(path)
    } catch {
      st = undefined
    }
    if (st) {
      if (!st.isFile()) {
        out.push({ name, result: 'skipped', reason: t(`${path} は nyan-remote が置いたものではありません（通常のファイルでない）`, `${path} was not placed by nyan-remote (not a regular file)`) })
        continue
      }
      let cur = ''
      try {
        cur = readFileSync(path, 'utf8')
      } catch {
        // unreadable = cannot tell whether it is ours ⇒ leave it
      }
      if (!isOurs(cur)) {
        out.push({ name, result: 'skipped', reason: t(`${path} は nyan-remote が置いたものではありません`, `${path} was not placed by nyan-remote`) })
        continue
      }
      if (cur === body) {
        out.push({ name, result: 'kept' })
        continue
      }
    }
    // ⚠️ Temp file → rename (never leave half-written contents in place)
    const tmp = `${path}.new-${process.pid}`
    await rm(tmp, { force: true })
    await writeFile(tmp, body, { flag: 'wx', mode: 0o755 })
    await chmod(tmp, 0o755)
    await rename(tmp, path)
    out.push({ name, result: 'placed' })
  }
  return out
}

/**
 * ★ Remove them (⚠️ only what we placed).
 * ⚠️⚠️ If the directory itself is a symlink or not owned by us ⇒ **remove nothing** (codex round 20, medium #5):
 *    following the link would remove commands of another location (another install). Matches the guard used when removing the `claude` entry point.
 */
export async function removeCli(binDir) {
  try {
    const st = lstatSync(binDir)
    if (st.isSymbolicLink() || !st.isDirectory()) return
    if (process.getuid && st.uid !== process.getuid()) return
  } catch {
    return
  }
  for (const name of CLI_NAMES) {
    const path = join(binDir, name)
    try {
      if (!lstatSync(path).isFile()) continue
      if (!isOurs(readFileSync(path, 'utf8'))) continue
      await rm(path, { force: true })
    } catch {
      // absent
    }
  }
}
