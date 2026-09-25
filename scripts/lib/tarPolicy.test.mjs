import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { linkEntries, privateEntries, unpublishedEntries } from './tarPolicy.mjs'

test('★★ the public tarball refuses private files (it used to ship CLAUDE.md and docs/ / codex security review)', () => {
  const ok = ['nyan-remote/', 'nyan-remote/README.md', 'nyan-remote/agent/src/index.ts', 'nyan-remote/RELEASE', 'nyan-remote/hooks/notify.known', 'nyan-remote/web/dist/index.html', 'nyan-remote/node_modules/web-push/README.md']
  assert.deepEqual(privateEntries(ok), [])
  assert.deepEqual(
    privateEntries(['nyan-remote/CLAUDE.md', 'nyan-remote/docs/publish-forbidden.txt', 'nyan-remote/docs/HANDOFF.md', 'nyan-remote/relay/README.md', 'nyan-remote/secret.bin']),
    ['CLAUDE.md', 'docs/publish-forbidden.txt', 'docs/HANDOFF.md', 'relay/README.md', 'secret.bin'],
  )
  // ⚠️ Unrooted or traversing paths are refused even inside the exempt folders (codex)
  assert.deepEqual(
    privateEntries(['nyan-remote/web/dist/../../docs/HANDOFF.md', 'nyan-remote/agent/../docs/private.json', 'agent/a.js', 'nyan-remote/./x.ts']),
    ['nyan-remote/web/dist/../../docs/HANDOFF.md', 'nyan-remote/agent/../docs/private.json', 'agent/a.js', 'nyan-remote/./x.ts'],
  )
  // ⚠️ No links of any kind
  assert.deepEqual(
    linkEntries(['drwxr-xr-x u/g 0 2026-09-25 22:00 nyan-remote/', '-rw-r--r-- u/g 1 2026-09-25 22:00 nyan-remote/a.ts', 'lrwxrwxrwx u/g 0 2026-09-25 22:00 nyan-remote/x -> /home/user/secret', 'hrw-r--r-- u/g 0 2026-09-25 22:00 nyan-remote/y link to nyan-remote/a.ts', '']),
    ['lrwxrwxrwx u/g 0 2026-09-25 22:00 nyan-remote/x -> /home/user/secret', 'hrw-r--r-- u/g 0 2026-09-25 22:00 nyan-remote/y link to nyan-remote/a.ts'],
  )
})

test('★ wiring: pack.mjs copies only classify(...) === keep, and site-stage checks the staged tarball before copying it', async () => {
  const { readFileSync } = await import('node:fs')
  const code = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  const pack = code('pack.mjs')
  assert.match(pack, /const c = classify\(rel\)[\s\S]{0,400}?if \(c === 'drop'\) \{\n\s*skipped\+\+\n\s*continue\n\s*\}\n\s*if \(c !== 'keep'\) \{/)
  // ★ The scan runs on the finished package (after the dependencies went in) and web/public must be all-public
  assert.match(pack, /const hits = scan\(stage, forbiddenPatterns\(ROOT\), \{ lenient: \(rel\) => rel\.startsWith\('node_modules\/'\), keepGit: true \}\)/)
  assert.ok(pack.indexOf('const hits = scan(stage') > pack.indexOf('for (const p of runtime) {'), '⚠️ scanned before the dependencies went in')
  assert.match(pack, /if \(rel\.startsWith\('web\/public\/'\) && c !== 'keep'\) \{/)
  assert.match(pack, /if \(line\.startsWith\('120000 '\)\) refused\.push/)
  // ★ Files on disk in web/public must be tracked (ignored ones would be published by the build), and no .git in the package
  assert.match(pack, /else if \(!tracked\.has\(rel\)\) bad\.push/)
  assert.match(pack, /keepGit: true \}\)/)
  assert.match(pack, /if \(f\.split\('\/'\)\.some\(\(seg\) => seg\.toLowerCase\(\) === '\.git'\)\) hits\.push/)
  const stage = code('site-stage.mjs')
  assert.match(stage, /linkEntries\(execFileSync\('tar', \['tvzf', TAR\]/)
  // ★ Compared with the public repository before anything is copied into the site
  const pub = stage.indexOf('const differ = unpublishedEntries(')
  assert.ok(pub > 0 && pub < stage.indexOf("cpSync(TAR, join(SITE, 'nyan-remote.tar.gz'))"), 'not compared with the public repository before staging')
  // ★ No build-account names in the tar headers
  assert.match(pack, /\['czf', out, '--owner=0', '--group=0', '--numeric-owner',/)
  const check = stage.indexOf("privateEntries(execFileSync('tar', ['tzf', TAR]")
  assert.ok(check > 0, 'site-stage does not check the tarball')
  assert.ok(check < stage.indexOf("cpSync(TAR, join(SITE, 'nyan-remote.tar.gz'))"), 'checked only after staging it')
})

test('★★ the package carries only what the public repository already has, byte for byte (codex)', () => {
  const root = mkdtempSync(join(tmpdir(), 'nyan-unpub-'))
  try {
    const pkg = join(root, 'pkg')
    const pub = join(root, 'pub')
    for (const d of [pkg, pub]) mkdirSync(join(d, 'web', 'public'), { recursive: true })
    mkdirSync(join(pkg, 'node_modules', 'x'), { recursive: true })
    mkdirSync(join(pkg, 'web', 'dist'), { recursive: true })
    writeFileSync(join(pkg, 'README.md'), 'same')
    writeFileSync(join(pub, 'README.md'), 'same')
    writeFileSync(join(pkg, 'web', 'public', 'internal.json'), '{"secret":1}')
    writeFileSync(join(pkg, 'agent.ts'), 'new')
    writeFileSync(join(pub, 'agent.ts'), 'old')
    writeFileSync(join(pkg, 'RELEASE'), 'generated')
    writeFileSync(join(pkg, 'node_modules', 'x', 'i.js'), 'dep')
    writeFileSync(join(pkg, 'web', 'dist', 'index.html'), 'built')
    assert.deepEqual(unpublishedEntries(pkg, pub).sort(), ['agent.ts: differs from the public repository', 'web/public/internal.json: not in the public repository'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
