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
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { t } from '../shared/i18n.ts'
import { formatRelease } from '../shared/release.ts'
import { historyHashes } from './install-notify.mjs'
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

// ★ ③ Stack it up
const stage = join(ROOT, 'dist', '.pack', 'nyan-remote')
rmSync(join(ROOT, 'dist', '.pack'), { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

// ★★ Leave out only **heavy things not needed to run** (⚠️ never leave out a single line of code = keep transparency).
//   ⚠️ Currently only "the cat source art" (about 12MB. PNG sketches; the package uses `web/dist/cats/`).
//   ⚠️⚠️ **Before adding more, confirm it is "not needed to run"** (docs stay = better to be readable).
const HEAVY = ['docs/cat-concepts/']
let skipped = 0
for (const rel of git('ls-files').split('\n').filter(Boolean)) {
  if (HEAVY.some((h) => rel.startsWith(h))) {
    skipped++
    continue
  }
  const to = join(stage, rel)
  mkdirSync(dirname(to), { recursive: true })
  cpSync(join(ROOT, rel), to)
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

mkdirSync(dirname(out), { recursive: true })
execFileSync('tar', ['czf', out, '-C', join(ROOT, 'dist', '.pack'), 'nyan-remote'], { stdio: 'inherit' })
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
