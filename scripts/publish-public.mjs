#!/usr/bin/env node
// ★★★ Publish a snapshot of this private repository to the public one as a single commit (2026-09-25).
//
//   node scripts/publish-public.mjs            # build, check, commit and push
//   node scripts/publish-public.mjs --dry-run  # build and check only (prints where the tree is)
//
// ★ The public history is one commit per release; the private history (work notes, machine names, old diffs)
//   never leaves this repository.
// ⚠️⚠️ Stops (exit 1) on any personal value or secret-looking string in the exported tree — fix it here first.
// ⚠️ Needs a clean, pushed tree (what is published must match a commit in the private repository).
// ⚠️ Author: Vessel Ltd. <noreply@nyan-remote.app> (an address that receives nothing — commit emails get harvested).

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { isMain } from './lib/isMain.mjs'

const PUBLIC_REPO = 'vessel-ltd/nyan-remote'
const PUBLIC_URL = `https://github.com/${PUBLIC_REPO}.git`
const AUTHOR = { name: 'Vessel Ltd.', email: 'noreply@nyan-remote.app' }

/** ★ Kept private (work notes and internal design docs, mostly in Japanese). */
export const EXCLUDE = ['CLAUDE.md', 'docs', 'relay/README.md', 'site/README.md', '.claude']

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
  return [...personal, ...SECRET_SHAPES]
}

const git = (args, o = {}) => execFileSync('git', args, { encoding: 'utf8', ...o }).trim()

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (name === '.git') continue
    if (statSync(p).isDirectory()) yield* files(p)
    else yield p
  }
}

/** ★ Every forbidden hit as `path:line: pattern` (binary files are skipped). */
export function scan(root, patterns) {
  const hits = []
  for (const f of files(root)) {
    const buf = readFileSync(f)
    if (buf.includes(0)) continue
    const lines = buf.toString('utf8').split('\n')
    lines.forEach((line, i) => {
      for (const re of patterns) if (re.test(line)) hits.push(`${relative(root, f)}:${i + 1}: ${re}`)
    })
  }
  return hits
}

function main() {
  const dry = process.argv.includes('--dry-run')
  const root = git(['rev-parse', '--show-toplevel'])
  if (git(['status', '--porcelain'], { cwd: root })) throw new Error('The working tree is not clean. Commit first.')
  git(['fetch', '-q', 'origin'], { cwd: root })
  const head = git(['rev-parse', 'HEAD'], { cwd: root })
  if (head !== git(['rev-parse', 'origin/main'], { cwd: root })) throw new Error('HEAD is not pushed to origin/main.')

  const work = mkdtempSync(join(tmpdir(), 'nyan-publish-'))
  const tree = join(work, 'tree')
  execFileSync('bash', ['-c', `mkdir -p "${tree}" && git archive HEAD | tar -x -C "${tree}"`], { cwd: root })
  for (const p of EXCLUDE) rmSync(join(tree, p), { recursive: true, force: true })

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
  git(['commit', '-q', '-m', `Release ${date} (${head.slice(0, 7)})`], { cwd: pub, env })
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
