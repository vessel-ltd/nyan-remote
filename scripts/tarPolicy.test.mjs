import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { cpSync, existsSync, writeFileSync } from 'node:fs'
import { insideNodeModules, runtimePackages } from './lib/tarPolicy.mjs'

test('★★ DIST-2: a workspace link in node_modules is never packed (it copied the on-disk agent/ outside the checks)', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nyan-pack-')))
  try {
    mkdirSync(join(root, 'agent'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'web-push'), { recursive: true })
    mkdirSync(join(root, 'node_modules', '@nyan-remote'), { recursive: true })
    symlinkSync('../../agent', join(root, 'node_modules', '@nyan-remote', 'agent'))
    const lines = [join(root, 'agent'), join(root, 'node_modules', '@nyan-remote', 'agent'), join(root, 'node_modules', 'web-push'), join(root, 'node_modules', 'gone')]
    assert.deepEqual(runtimePackages(lines, root, realpathSync), [join(root, 'node_modules', 'web-push')])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('★ DIST-2: pack.mjs packs through runtimePackages (the wiring)', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./pack.mjs', import.meta.url), 'utf8')
  assert.match(src, /const runtime = runtimePackages\(runtimeLines, ROOT, \(p\) => realpathSync\(p\)\)/)
  assert.match(src, /dereference: true, filter: stayInside/)
  assert.doesNotMatch(src, /\.filter\(\(p\) => p\.includes\(`\$\{ROOT\}\/node_modules\/`\)\)/)
})

test('★★ DIST-2: a link inside a package that leads out of node_modules is not followed by the copy (codex review)', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nyan-pack-')))
  try {
    mkdirSync(join(root, 'agent'), { recursive: true })
    writeFileSync(join(root, 'agent', '.env'), 'SECRET=1')
    const pkg = join(root, 'node_modules', 'pkg')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'index.js'), 'ok')
    symlinkSync('../../agent', join(pkg, 'leak'))
    const out = join(root, 'stage')
    cpSync(pkg, out, { recursive: true, dereference: true, filter: insideNodeModules(root, realpathSync) })
    assert.equal(existsSync(join(out, 'index.js')), true)
    assert.equal(existsSync(join(out, 'leak')), false, 'the link out of node_modules was followed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
