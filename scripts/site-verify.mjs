#!/usr/bin/env node
// ★★ Wait until what we deployed can be fetched **from the URL users go through**, and check the contents too
// (2026-09-20 / distribution D of ③).
//
// ⚠️⚠️ **A successful `deploy` does not mean the new version is served right away** (measured).
//   Right after deploying, `curl` returned **the old `install.sh`** (`cf-cache-status: HIT`.
//   The headers say `max-age=0, must-revalidate`, so it is **propagation delay**, not configuration).
//   ⇒ Worse than "an old one comes back" is that **`install.sh` and the tarball can hit differently**
//     = versions kept consistent by extraction **diverge at the delivery stage**.
//
// ⚠️⚠️ **Do not add a cache-busting query.** That would check **a URL users never go through**
//   (= the check becomes meaningless / CLAUDE.md "check through the path the other side actually uses").

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DISTRIBUTION_ORIGIN } from '../shared/distribution.ts'
import { t } from '../shared/i18n.ts'
import { initCliLang } from './lib/lang.mjs'

// ★ Language first (before any message is built)
initCliLang()

const SITE = join(resolve(new URL('..', import.meta.url).pathname), 'dist', 'site')
const want = {
  release: readFileSync(join(SITE, 'RELEASE'), 'utf8'),
  install: readFileSync(join(SITE, 'install.sh')),
  tarball: readFileSync(join(SITE, 'nyan-remote.tar.gz')),
}
const rev = want.release.trim().split('\n')[0]
const sha = (b) => createHash('sha256').update(b).digest('hex')

const TRIES = 30
const WAIT_MS = 2000

async function get(path) {
  const res = await fetch(`${DISTRIBUTION_ORIGIN}${path}`)
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

let seen = ''
for (let i = 1; i <= TRIES; i++) {
  try {
    const release = (await get('/RELEASE')).toString('utf8')
    seen = release.trim().split('\n')[0]
    if (release === want.release) {
      // ★ Check the contents once the version matches (⚠️ **all three**. Only one being new is the most dangerous state)
      const [install, tarball] = await Promise.all([get('/install.sh'), get('/nyan-remote.tar.gz')])
      if (!install.equals(want.install)) throw new Error(t('install.sh の中身が違う', 'install.sh content differs'))
      if (!tarball.equals(want.tarball)) {
        throw new Error(
          t(
            `tarball が違う（配: ${sha(tarball).slice(0, 12)} / 手元: ${sha(want.tarball).slice(0, 12)}）`,
            `tarball differs (served: ${sha(tarball).slice(0, 12)} / local: ${sha(want.tarball).slice(0, 12)})`,
          ),
        )
      }
      console.log(
        t(
          `✔ 配布元が版 ${rev} を返しています（${i} 回目 / install.sh と tarball も一致）`,
          `✔ The distribution origin serves version ${rev} (attempt ${i} / install.sh and tarball match too)`,
        ),
      )
      console.log(`  ${DISTRIBUTION_ORIGIN}`)
      process.exit(0)
    }
  } catch (e) {
    // ⚠️ Mid-propagation, both "fetchable but old" and "only one is new" happen ⇒ wait and look again
    seen = t(`${seen || '?'}（${e instanceof Error ? e.message : String(e)}）`, `${seen || '?'} (${e instanceof Error ? e.message : String(e)})`)
  }
  if (i < TRIES) await new Promise((r) => setTimeout(r, WAIT_MS))
}

console.error(
  t(
    `✗ ${(TRIES * WAIT_MS) / 1000} 秒 待っても揃いませんでした（ほしい版 ${rev} / 返ってきた ${seen}）`,
    `✗ Still not consistent after ${(TRIES * WAIT_MS) / 1000} s (wanted version ${rev} / got ${seen})`,
  ),
)
console.error(
  t(
    '  ⚠️ 配布元が古いままか、配信の伝播が遅れています。⚠️ 「配りました」と言わないこと。',
    '  ⚠️ The origin is still old, or propagation is delayed. ⚠️ Do not report it as deployed.',
  ),
)
process.exit(1)
