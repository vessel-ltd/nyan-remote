#!/usr/bin/env node
// ★★★ Publish a snapshot of this private repository to the public one as a single commit (2026-09-25).
//
//   node scripts/publish-public.mjs            # build, check, commit and push
//   node scripts/publish-public.mjs --dry-run  # build and check only (prints where the tree is)
//   node scripts/publish-public.mjs --approve-new  # publish including files that were never public before (listed first)
//   node scripts/publish-public.mjs --closes 12,15 # the release commit says "Closes #12" etc. (GitHub closes them)
//
// ★ The public history is one commit per release; the private history (work notes, machine names, old diffs)
//   never leaves this repository.
// ⚠️⚠️ Stops (exit 1) on any personal value or secret-looking string in the exported tree — fix it here first.
// ⚠️ Needs a clean, pushed tree (what is published must match a commit in the private repository).
// ⚠️ Author: Vessel Ltd. <noreply@nyan-remote.app> (an address that receives nothing — commit emails get harvested).

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { isMain } from './lib/isMain.mjs'

const PUBLIC_REPO = 'vessel-ltd/nyan-remote'
const PUBLIC_URL = `https://github.com/${PUBLIC_REPO}.git`
const AUTHOR = { name: 'Vessel Ltd.', email: 'noreply@nyan-remote.app' }

/**
 * ★★ What may be public is **listed**, not what must stay private (codex round 33: anything added later was published
 *   automatically). A file outside these rules **stops** the publish — add it here on purpose, or move it under `docs/`.
 *   ①top-level entries ②file types ③Markdown only as the root README ④binary files only as images/fonts.
 */
export const PUBLIC_TOP = ['.github', '.gitignore', 'LICENSE', 'README.md', 'SECURITY.md', 'account', 'agent', 'hooks', 'install.sh', 'landing', 'package-lock.json', 'package.json', 'relay', 'scripts', 'shared', 'site', 'web']
/** ★ Kept private on purpose (dropped quietly — everything else not allowed stops the publish) */
export const PRIVATE = ['CLAUDE.md', 'docs', '.claude']
const TEXT_EXT = /\.(ts|tsx|mjs|cjs|js|json|jsonc|sql|sh|py|css|html|svg|webmanifest|gitignore|ya?ml)$|(^|\/)(LICENSE|\.gitignore)$/
const BINARY_EXT = /\.(png|jpg|jpeg|gif|webp|ico|woff2?)$/

/** ★ Decide each exported path: 'keep' / 'drop' (private) / a reason to stop. */
export function classify(path) {
  const top = path.split('/')[0]
  if (PRIVATE.includes(top)) return 'drop'
  if (!PUBLIC_TOP.includes(top)) return `not in the public list (${top})`
  // ★ Public Markdown: the root README and SECURITY, and GitHub's own files under .github/ (everything else is a work note)
  if (/\.md$/i.test(path)) return path === 'README.md' || path === 'SECURITY.md' || path.startsWith('.github/') ? 'keep' : 'drop'
  if (TEXT_EXT.test(path) || BINARY_EXT.test(path)) return 'keep'
  return 'unknown file type'
}

/**
 * ⚠️ Values that must never appear in the public tree.
 *   ★ Personal values (names, hosts, addresses) live in `docs/publish-forbidden.txt` — one regex per line — which is
 *   itself excluded, so the list never ships. ⚠️ If that file is missing, stop (do not publish unchecked).
 */
export const SECRET_SHAPES = [
  /\b(sk|rk)_(live|test)_[A-Za-z0-9]{10,}/,
  /whsec_[A-Za-z0-9]{10,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]

export function forbiddenPatterns(root) {
  const file = join(root, 'docs', 'publish-forbidden.txt')
  if (!existsSync(file)) throw new Error('docs/publish-forbidden.txt is missing (the personal-value list).')
  const personal = readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => new RegExp(l, 'i'))
  // ⚠️⚠️ An empty list would silently turn the personal-value check off (codex round 34)
  if (personal.length === 0) throw new Error('docs/publish-forbidden.txt has no patterns (the personal-value check would be off).')
  return [...personal, ...SECRET_SHAPES]
}

const git = (args, o = {}) => execFileSync('git', args, { encoding: 'utf8', ...o }).trim()

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (name === '.git') continue
    // ⚠️ lstat: a symlink is never followed (a link out of the tree could pull outside files in)
    if (lstatSync(p).isDirectory()) yield* files(p)
    else yield p
  }
}

/**
 * ★ Every forbidden hit as `path:line: pattern`.
 *   ⚠️⚠️ Nothing is skipped (codex round 33, high: one NUL byte made a file "binary" and let a secret through).
 *   Text is read as UTF-8; image/font files are read byte for byte (latin1) so an embedded secret still matches.
 *   ⚠️ A NUL in a text-type file stops the publish (UTF-16 and the like cannot be checked reliably).
 */
export function scan(root, patterns) {
  const hits = []
  for (const f of files(root)) {
    const rel = relative(root, f)
    // ★ The path itself is public too (a file named after a machine leaks it / codex round 34)
    for (const re of patterns) if (re.test(rel)) hits.push(`${rel}: path matches ${re}`)
    const buf = readFileSync(f)
    const binary = BINARY_EXT.test(rel)
    if (!binary && buf.includes(0)) {
      hits.push(`${rel}: NUL byte in a text file (cannot be checked)`)
      continue
    }
    const lines = buf.toString(binary ? 'latin1' : 'utf8').split('\n')
    lines.forEach((line, i) => {
      for (const re of patterns) if (re.test(line)) hits.push(`${rel}:${i + 1}: ${re}`)
    })
  }
  return hits
}

function main() {
  const dry = process.argv.includes('--dry-run')
  const approveNew = process.argv.includes('--approve-new')
  // ★ `--closes 12,15`: put "Closes #12" lines in the release commit ⇒ GitHub closes those issues/PRs when it lands
  const ci = process.argv.indexOf('--closes')
  const closes = ci > 0 ? (process.argv[ci + 1] ?? '').split(',').map((x) => x.trim().replace(/^#/, '')) : []
  if (closes.some((x) => !/^\d{1,7}$/.test(x))) throw new Error('--closes takes issue numbers, e.g. --closes 12,15')
  const root = git(['rev-parse', '--show-toplevel'])
  if (git(['status', '--porcelain'], { cwd: root })) throw new Error('The working tree is not clean. Commit first.')
  git(['fetch', '-q', 'origin'], { cwd: root })
  const head = git(['rev-parse', 'HEAD'], { cwd: root })
  if (head !== git(['rev-parse', 'origin/main'], { cwd: root })) throw new Error('HEAD is not pushed to origin/main.')

  const work = mkdtempSync(join(tmpdir(), 'nyan-publish-'))
  const tree = join(work, 'tree')
  execFileSync('bash', ['-c', `mkdir -p "${tree}" && git archive HEAD | tar -x -C "${tree}"`], { cwd: root })
  // ★ Apply the public list; anything it does not know stops here
  const refused = []
  for (const f of [...files(tree)]) {
    const rel = relative(tree, f)
    // ⚠️⚠️ No symlinks at all (codex round 33: cpSync rewrote relative links to absolute temp paths that do not exist)
    if (lstatSync(f).isSymbolicLink()) {
      refused.push(`${rel}: symlink`)
      continue
    }
    const c = classify(rel)
    if (c === 'drop') rmSync(f, { force: true })
    else if (c !== 'keep') refused.push(`${rel}: ${c}`)
  }
  for (const p of PRIVATE) rmSync(join(tree, p), { recursive: true, force: true })
  if (refused.length) {
    console.error(`✗ ${refused.length} file(s) are not allowed in the public tree (edit PUBLIC_TOP / the file types in scripts/publish-public.mjs, or move them under docs/):\n${refused.slice(0, 50).join('\n')}`)
    process.exit(1)
  }

  const hits = scan(tree, forbiddenPatterns(root))
  if (hits.length) {
    console.error(`✗ ${hits.length} forbidden value(s) in the public tree:\n${hits.slice(0, 50).join('\n')}`)
    process.exit(1)
  }
  const count = [...files(tree)].length
  console.log(`✓ ${count} files, no forbidden values (${head.slice(0, 7)})`)
  if (dry) {
    console.log(`(dry run) tree: ${tree}`)
    return
  }
  // ⚠️ Never publish into the private repository itself
  if (git(['remote', 'get-url', 'origin'], { cwd: root }).replace(/\.git$/, '').endsWith(PUBLIC_REPO)) {
    throw new Error(`origin is ${PUBLIC_REPO} — rename the private repository first.`)
  }

  const pub = join(work, 'public')
  try {
    git(['clone', '-q', '--depth', '1', PUBLIC_URL, pub])
  } catch {
    throw new Error(`Cannot clone ${PUBLIC_URL} (create the public repository first).`)
  }
  // ★★ Files that were not public before must be approved by name (codex round 34: a private JSON/HTML in an allowed
  //   folder would otherwise ship). ⇒ list them and stop unless --approve-new.
  const before = new Set([...files(pub)].map((f) => relative(pub, f)))
  const added = [...files(tree)].map((f) => relative(tree, f)).filter((f) => !before.has(f))
  if (added.length && before.size > 0 && !approveNew) {
    console.error(`✗ ${added.length} file(s) would be public for the first time. Check them, then run again with --approve-new:\n${added.map((f) => `  ${f}`).join('\n')}`)
    process.exit(1)
  }
  for (const name of readdirSync(pub)) if (name !== '.git') rmSync(join(pub, name), { recursive: true, force: true })
  cpSync(tree, pub, { recursive: true })
  git(['add', '-A'], { cwd: pub })
  if (!git(['status', '--porcelain'], { cwd: pub })) {
    console.log('Nothing changed since the last publish.')
    return
  }
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: AUTHOR.name,
    GIT_AUTHOR_EMAIL: AUTHOR.email,
    GIT_COMMITTER_NAME: AUTHOR.name,
    GIT_COMMITTER_EMAIL: AUTHOR.email,
  }
  const date = new Date().toISOString().slice(0, 10)
  const message = [`Release ${date} (${head.slice(0, 7)})`, ...(closes.length ? ['', ...closes.map((n) => `Closes #${n}`)] : [])].join('\n')
  git(['commit', '-q', '-m', message], { cwd: pub, env })
  git(['push', '-q', 'origin', 'HEAD:main'], { cwd: pub })
  console.log(`✓ Published to https://github.com/${PUBLIC_REPO}`)
  rmSync(work, { recursive: true, force: true })
}

if (isMain(process.argv[1], import.meta.url)) {
  try {
    main()
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
