#!/usr/bin/env node
// ★★ Stack everything for the distribution origin (Y) into one box (distribution D of ③ / 2026-09-20).
//
//   dist/site/ ├── (PWA build)             … web/dist as-is
//              ├── install.sh              … ★ **extracted from the tarball**
//              ├── nyan-remote.tar.gz      … the product
//              └── RELEASE                 … version (⚠️ so it can be checked without downloading 3.2MB)
//
// ⚠️⚠️ **Do not copy `install.sh` from the working tree. Extract it from the tarball.**
//   What `curl | bash` runs is the origin's `install.sh`, and it installs the tarball from the same
//   origin, so **if the two disagree you get "fixed but still broken"**
//   (exactly how we lost half a day on 2026-09-16). Extracting makes them **structurally identical**
//   = an invariant, not a convention (CLAUDE.md "promote conventions to invariants").
//
// ⚠️ `pack.mjs` **refuses to build from a dirty working tree**, so
//    as long as this path is used **what we ship is always some git revision**.

import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
// ★ **Never copy the distribution URL by hand** (built from the single place in `shared/distribution.ts`).
//   ⚠️ It was hard-coded here, so the 2026-09-21 move to our own domain nearly **kept pointing users at the old URL**
//      (CLAUDE.md "when you change a decision, fix the text that shows it the same day").
import { DISTRIBUTION_ORIGIN } from '../shared/distribution.ts'
import { t } from '../shared/i18n.ts'
import { initCliLang } from './lib/lang.mjs'

// ★ Language first (before any message is built)
initCliLang()

const ROOT = resolve(new URL('..', import.meta.url).pathname)
const SITE = join(ROOT, 'dist', 'site')
const TAR = join(ROOT, 'dist', 'site.tar.gz')

// ★ ① Build the product (⚠️ runs `npm run build` inside = the PWA is always rebuilt)
execFileSync('node', [join(ROOT, 'scripts/pack.mjs'), '--out', TAR], {
  cwd: ROOT,
  stdio: 'inherit',
})

// ★ ② Restack from scratch (⚠️ never ship leftovers from last time)
rmSync(SITE, { recursive: true, force: true })
mkdirSync(SITE, { recursive: true })
cpSync(join(ROOT, 'web/dist'), SITE, { recursive: true })
cpSync(TAR, join(SITE, 'nyan-remote.tar.gz'))

// ★ ③ Extract install.sh and RELEASE **from inside the tarball** (reason above)
for (const name of ['install.sh', 'RELEASE']) {
  const bytes = execFileSync('tar', ['xzOf', TAR, `nyan-remote/${name}`], {
    maxBuffer: 8 << 20,
  })
  writeFileSync(join(SITE, name), bytes)
}

const release = readFileSync(join(SITE, 'RELEASE'), 'utf8').trim().split('\n')
console.log(`✔ ${SITE}`)
console.log(t(`  版: ${release[0]} / 作った時刻: ${release[1]}`, `  Version: ${release[0]} / built at: ${release[1]}`))
console.log(t('  ⚠️ 配る前に、いま出ている版と見比べること:', '  ⚠️ Before deploying, compare with the version currently served:'))
console.log(`     curl -fsS ${DISTRIBUTION_ORIGIN}/RELEASE`)
