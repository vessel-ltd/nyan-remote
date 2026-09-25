// ★ What the public tarball may contain (2026-09-25 / codex security review): the public repository's rules.
import { readFileSync, readdirSync, lstatSync } from 'node:fs'
import { join, relative } from 'node:path'
import { classify } from '../publish-public.mjs'

/**
 * ★ Tarball entries that the public rules do not keep (`classify` in `publish-public.mjs`).
 *   Our generated files and the bundled dependencies are not in git, so they are skipped here.
 * @param {string[]} entries `tar tzf` lines
 */
export function privateEntries(entries) {
  const GENERATED = ['RELEASE', 'hooks/notify.known']
  const bad = []
  for (const raw of entries) {
    if (!raw) continue
    // ⚠️ Every entry sits under the one root, with no `.`/`..` segments (codex: `web/dist/../../docs/x` passed the exemptions)
    if (!raw.startsWith('nyan-remote/') || raw.split('/').some((seg) => seg === '..' || seg === '.')) {
      bad.push(raw)
      continue
    }
    const e = raw.slice('nyan-remote/'.length)
    if (e === '' || e.endsWith('/') || e.startsWith('node_modules/') || e.startsWith('web/dist/') || GENERATED.includes(e)) continue
    if (classify(e) !== 'keep') bad.push(e)
  }
  return bad
}

/**
 * ★ Entries that are not plain files or directories (`tar tvzf` lines: the first character is the type) — no links in what we ship
 * @param {string[]} verbose `tar tvzf` lines
 */
export function linkEntries(verbose) {
  return verbose.filter((l) => l !== '' && !/^[-d]/.test(l))
}


/**
 * ★★ Our files in the package that are **not exactly what the public repository has** (2026-09-25 / codex).
 *   ⚠️⚠️ Publishing has a human gate for files that become public for the first time; the package had none, so a private
 *      `web/public/internal.json` with no forbidden pattern would have shipped. ⇒ The package may only carry what already
 *      passed that gate: every file must exist in the public checkout with the same bytes.
 *   Generated files and bundled dependencies are not in git, so they are compared elsewhere (scan) and skipped here.
 * @param {string} pkgRoot the extracted `nyan-remote/` directory
 * @param {string} publicRoot a checkout of the public repository
 */
export function unpublishedEntries(pkgRoot, publicRoot) {
  const GENERATED = ['RELEASE', 'hooks/notify.known']
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const rel = relative(pkgRoot, p)
      if (lstatSync(p).isDirectory()) {
        if (rel === 'node_modules' || rel === 'web/dist') continue
        walk(p)
        continue
      }
      if (GENERATED.includes(rel)) continue
      let theirs
      try {
        theirs = readFileSync(join(publicRoot, rel))
      } catch {
        out.push(`${rel}: not in the public repository`)
        continue
      }
      if (!theirs.equals(readFileSync(p))) out.push(`${rel}: differs from the public repository`)
    }
  }
  walk(pkgRoot)
  return out
}
