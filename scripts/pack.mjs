#!/usr/bin/env node
// ★★ Build the tarball we distribute (distribution for ③ / 2026-09-20).
//
// ★ Three things go in:
//   ① files tracked by git (= the source itself. ⚠️ everything, for transparency)
//   ② `web/dist` (the built PWA) ⇒ users need neither vite nor preact
//   ③ **only the node_modules needed at runtime** (the `web-push` tree: 18 packages / 1.9MB / no native code)
//      ⇒ users do **not even need npm** (runs on Node 24 alone)
//
// ⚠️⚠️ **No dev dependencies** (vite, @types, test tools. With them it becomes 49MB).
// ⚠️ Refuses to build from a dirty working tree (**what we ship never differs from git**).
//
// Usage:
//   node scripts/pack.mjs              → dist/nyan-remote-<short hash>.tar.gz
//   node scripts/pack.mjs --out <path>

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { t } from '../shared/i18n.ts'
import { formatRelease } from '../shared/release.ts'
import { historyHashes } from './install-notify.mjs'
import { classify, forbiddenPatterns, scan } from './publish-public.mjs'
import { initCliLang } from './lib/lang.mjs'

// ★ Language first (before any message is built)
initCliLang()

const ROOT = resolve(new URL('..', import.meta.url).pathname)
const args = process.argv.slice(2)
const outAt = args.indexOf('--out')

function git(...a) {
  return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim()
}

// ⚠️⚠️ **Refuse if dirty** (we could no longer say which git revision was shipped)
const dirty = git('status', '--porcelain')
if (dirty && !args.includes('--allow-dirty')) {
  console.error(t('✗ 作業ツリーが汚れています（配るものと git が食い違います）', '✗ The working tree is dirty (the package would not match git)'))
  console.error(dirty.split('\n').slice(0, 10).join('\n'))
  console.error(t('  ⚠️ それでも作るなら --allow-dirty', '  ⚠️ To build anyway: --allow-dirty'))
  process.exit(1)
}

const rev = git('rev-parse', '--short', 'HEAD')
const out = outAt >= 0 ? resolve(args[outAt + 1]) : join(ROOT, 'dist', `nyan-remote-${rev}.tar.gz`)

// ★ ① Build (⚠️ `web/dist` is in .gitignore, so always build it here)
console.log(t('▸ PWA をビルドします', '▸ Building the PWA'))
execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
if (!existsSync(join(ROOT, 'web/dist/index.html'))) {
  console.error(t('✗ web/dist が作られていません', '✗ web/dist was not created'))
  process.exit(1)
}

// ★ ② Collect the node_modules needed at runtime (⚠️ no dev ones)
const runtime = execFileSync('npm', ['ls', '--all', '--parseable', '--omit=dev', '--workspace', 'agent'], {
  cwd: ROOT,
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter((p) => p.includes(`${ROOT}/node_modules/`))
if (runtime.length === 0) {
  console.error(t('✗ 実行時の依存を1つも見つけられませんでした（npm install が要ります）', '✗ Found no runtime dependencies (run npm install)'))
  process.exit(1)
}

// ★★ ②' Everything **on disk** in web/public goes into the site (the build copies ignored and untracked files too / codex):
//   every file there must be tracked, public by the rules, and not a link
{
  const tracked = new Set(git('ls-files', 'web/public').split('\n').filter(Boolean))
  const bad = []
  for (const f of walk(join(ROOT, 'web/public'))) {
    const rel = f.slice(ROOT.length + 1)
    const st = lstatSync(f)
    if (st.isDirectory()) continue
    if (st.isSymbolicLink()) bad.push(`${rel}: symlink`)
    else if (!tracked.has(rel)) bad.push(`${rel}: not in git (the build would publish it)`)
  }
  if (bad.length) {
    console.error(t(`✗ web/public に git に無いファイルがあります（ビルドで公開されます）:\n${bad.join('\n')}`, `✗ web/public holds files that are not in git (the build would publish them):\n${bad.join('\n')}`))
    process.exit(1)
  }
}

// ★ ③ Stack it up
const stage = join(ROOT, 'dist', '.pack', 'nyan-remote')
rmSync(join(ROOT, 'dist', '.pack'), { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

// ★★★ **The same rules as the public repository** (`classify` in `publish-public.mjs` / 2026-09-25 / codex security review).
//   ⚠️⚠️ This tarball is served publicly (`app.nyan-remote.app/nyan-remote.tar.gz`), and it used to copy **every tracked file**:
//      CLAUDE.md, docs/HANDOFF.md and docs/publish-forbidden.txt (the list of personal values itself) were downloadable by anyone.
//   ⇒ Only what the public repository may contain goes in; anything the rules do not know stops the pack (like publishing).
const HEAVY = ['private files (CLAUDE.md, docs/, other Markdown)']
let skipped = 0
const refused = []
// ⚠️ No symlinks at all (same as publishing: a link can carry an absolute build-machine target or pull outside files in)
for (const line of git('ls-files', '-s').split('\n').filter(Boolean)) {
  if (line.startsWith('120000 ')) refused.push(`${line.split('\t')[1]}: symlink`)
}
for (const rel of git('ls-files').split('\n').filter(Boolean)) {
  const c = classify(rel)
  // ⚠️⚠️ web/public is copied into web/dist by the build **whatever the rules say** (codex): everything there must be public
  if (rel.startsWith('web/public/') && c !== 'keep') {
    refused.push(`${rel}: ${c === 'drop' ? 'private file in web/public (the build would publish it)' : c}`)
    continue
  }
  if (c === 'drop') {
    skipped++
    continue
  }
  if (c !== 'keep') {
    refused.push(`${rel}: ${c}`)
    continue
  }
  const to = join(stage, rel)
  mkdirSync(dirname(to), { recursive: true })
  cpSync(join(ROOT, rel), to)
}
if (refused.length) {
  console.error(t(`✗ 公開してよいか分からないファイルがあります（scripts/publish-public.mjs の規則）:\n${refused.join('\n')}`, `✗ Files the public rules do not allow (scripts/publish-public.mjs):\n${refused.join('\n')}`))
  process.exit(1)
}
cpSync(join(ROOT, 'web/dist'), join(stage, 'web/dist'), { recursive: true })
for (const p of runtime) {
  cpSync(p, join(stage, p.slice(ROOT.length + 1)), { recursive: true, dereference: true })
}

// ★ Record which version was shipped (⚠️ to match against the version shown on screen)
// ★ Fingerprints of past shipped notify.sh versions (⚠️ the tarball tree has no .git ⇒ carry them here /
//   used by `install-notify.mjs` to replace it only when it "has not been modified")
writeFileSync(join(stage, 'hooks', 'notify.known'), `${historyHashes(ROOT).join('\n')}\n`)
// ★ Commit date on line 3 (2026-09-24) ⇒ the screen compares "which machine is behind" (`isBehind` in `shared/release.ts`)
writeFileSync(join(stage, 'RELEASE'), formatRelease({ commit: rev, builtAt: new Date().toISOString(), committedAt: git('log', '-1', '--format=%cI') }))

// ★★ Scan **the finished package** for personal values and secret shapes (⚠️ the same scan as publishing), dependencies included
//   (codex: they used to go in after the scan, copied with links followed)
{
  const hits = scan(stage, forbiddenPatterns(ROOT), { lenient: (rel) => rel.startsWith('node_modules/'), keepGit: true })
  // ⚠️ No repository metadata of any kind (a git-installed dependency brings its `.git`, remotes and tokens included / codex)
  //   ⚠️ Case-insensitively (`.GIT` is `.git` on macOS's default filesystem / codex)
  for (const f of walk(stage)) if (f.split('/').some((seg) => seg.toLowerCase() === '.git')) hits.push(`${f.slice(stage.length + 1)}: .git in the package`)
  if (hits.length) {
    console.error(t(`✗ 出してはいけない値があります:\n${hits.slice(0, 50).join('\n')}`, `✗ Forbidden values in the tarball:\n${hits.slice(0, 50).join('\n')}`))
    process.exit(1)
  }
}

mkdirSync(dirname(out), { recursive: true })
// ⚠️ Ownership is not ours to publish (the build account's name was in every header / codex) ⇒ root, numeric
execFileSync('tar', ['czf', out, '--owner=0', '--group=0', '--numeric-owner', '-C', join(ROOT, 'dist', '.pack'), 'nyan-remote'], { stdio: 'inherit' })
rmSync(join(ROOT, 'dist', '.pack'), { recursive: true, force: true })

const bytes = execFileSync('wc', ['-c', out], { encoding: 'utf8' }).trim().split(/\s+/)[0]
console.log(`✔ ${out}`)
const mb = (Number(bytes) / 1024 / 1024).toFixed(1)
console.log(t(`  版: ${rev} / 大きさ: ${mb} MB / 依存: ${runtime.length} 個`, `  Version: ${rev} / size: ${mb} MB / dependencies: ${runtime.length}`))
console.log(
  t(
    `  ⚠️ 動かすのに要らないので外したもの: ${skipped} ファイル（${HEAVY.join(', ')}）`,
    `  ⚠️ Left out as not needed to run: ${skipped} files (${HEAVY.join(', ')})`,
  ),
)

/** Every file and link under `dir` (links are not followed) */
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = lstatSync(p)
    if (st.isDirectory()) out.push(p, ...walk(p))
    else out.push(p)
  }
  return out
}
