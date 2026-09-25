// ★★ How notify.sh is placed (2026-09-24 / codex round 23, high #1): replace it only when it equals one of the versions we shipped.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setLang } from '../shared/i18n.ts'
import { decide, historyHashes, isMain, knownHashes, main, sha256 } from './install-notify.mjs'

setLang('ja')

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-notify-'))
  const root = join(dir, 'root')
  mkdirSync(join(root, 'hooks'), { recursive: true })
  writeFileSync(join(root, 'hooks', 'notify.sh'), '#!/bin/sh\n# NEW\n')
  // ★ An old shipped version (in the tarball tree it comes via notify.known)
  writeFileSync(join(root, 'hooks', 'notify.known'), `${sha256(Buffer.from('#!/bin/sh\n# OLD\n'))}\n`)
  const home = join(dir, 'home')
  mkdirSync(home)
  return { dir, root, home, target: join(home, '.claude', 'hooks', 'notify.sh') }
}

const quiet = (fn) => {
  const log = console.log
  console.log = () => {}
  try {
    return fn()
  } finally {
    console.log = log
  }
}

test('★★ reinstalls over a shipped old version (keeps a backup), leaves a modified one alone, replaces with --force', () => {
  const f = fixture()
  try {
    mkdirSync(join(f.home, '.claude', 'hooks'), { recursive: true })
    writeFileSync(f.target, '#!/bin/sh\n# OLD\n')
    assert.equal(quiet(() => main([], f.home, f.root)), 0)
    assert.equal(readFileSync(f.target, 'utf8'), '#!/bin/sh\n# NEW\n')
    assert.equal(readFileSync(`${f.target}.bak`, 'utf8'), '#!/bin/sh\n# OLD\n', '⚠️ no backup kept')
    assert.ok(statSync(f.target).mode & 0o100, '⚠️ not executable')
    // ⚠️⚠️ Never remove a notify.sh the user modified
    writeFileSync(f.target, '#!/bin/sh\n# MINE\n')
    assert.equal(quiet(() => main([], f.home, f.root)), 0)
    assert.equal(readFileSync(f.target, 'utf8'), '#!/bin/sh\n# MINE\n', "⚠️⚠️ overwrote the user's notify.sh")
    quiet(() => main(['--force'], f.home, f.root))
    assert.equal(readFileSync(f.target, 'utf8'), '#!/bin/sh\n# NEW\n')
    assert.equal(readFileSync(`${f.target}.bak`, 'utf8'), '#!/bin/sh\n# MINE\n')
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test('★★ creates nothing without ~/.claude, leaves links alone, places it if missing', () => {
  const f = fixture()
  try {
    quiet(() => main([], f.home, f.root))
    assert.equal(existsSync(join(f.home, '.claude')), false)
    mkdirSync(join(f.home, '.claude'))
    quiet(() => main([], f.home, f.root))
    assert.equal(readFileSync(f.target, 'utf8'), '#!/bin/sh\n# NEW\n')
    // ⚠️ A link (never write to its target = the tree itself)
    const other = join(f.dir, 'target.sh')
    writeFileSync(other, 'TARGET')
    rmSync(f.target)
    symlinkSync(other, f.target)
    quiet(() => main(['--force'], f.home, f.root))
    assert.ok(lstatSync(f.target).isSymbolicLink())
    assert.equal(readFileSync(other, 'utf8'), 'TARGET')
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test('★ decision table (pure)', () => {
  const src = Buffer.from('NEW')
  const known = new Set([sha256(Buffer.from('OLD'))])
  assert.equal(decide({ claudeExists: false, dest: undefined, src, known, force: true }), 'no-claude')
  assert.equal(decide({ claudeExists: true, dest: 'link', src, known, force: true }), 'linked')
  assert.equal(decide({ claudeExists: true, dest: 'unreadable', src, known, force: true }), 'unreadable', '⚠️ does not overwrite an unreadable one with --force')
  assert.equal(decide({ claudeExists: true, dest: undefined, src, known, force: false }), 'install')
  assert.equal(decide({ claudeExists: true, dest: Buffer.from('NEW'), src, known, force: false }), 'same')
  assert.equal(decide({ claudeExists: true, dest: Buffer.from('OLD'), src, known, force: false }), 'replace')
  assert.equal(decide({ claudeExists: true, dest: Buffer.from('MINE'), src, known, force: false }), 'modified')
  assert.equal(decide({ claudeExists: true, dest: Buffer.from('MINE'), src, known, force: true }), 'replace')
})

test('★★ past notify.sh versions in git history count as "shipped" (git working tree)', (t) => {
  const root = new URL('..', import.meta.url).pathname
  const hist = historyHashes(root)
  // ★ The public repository is a single-commit snapshot (scripts/publish-public.mjs) ⇒ it has no past versions to check
  if (hist.length < 2) return t.skip('single-commit snapshot: no notify.sh history')
  assert.ok(hist.length >= 2, `too few versions in history: ${hist.length}`)
  const known = knownHashes(root)
  for (const h of hist) assert.ok(known.has(h))
  assert.ok(known.has(sha256(readFileSync(join(root, 'hooks', 'notify.sh')))))
})

test('★★★ an unreadable notify.sh is left alone and the step fails (never removed without a backup / codex round 24, high #1)', { skip: process.getuid?.() === 0 }, () => {
  const f = fixture()
  try {
    mkdirSync(join(f.home, '.claude', 'hooks'), { recursive: true })
    writeFileSync(f.target, '#!/bin/sh\n# MINE\n')
    chmodSync(f.target, 0o000)
    const err = console.error
    console.error = () => {}
    let code
    try {
      code = quiet(() => main([], f.home, f.root))
    } finally {
      console.error = err
    }
    chmodSync(f.target, 0o644)
    assert.equal(code, 1)
    assert.equal(readFileSync(f.target, 'utf8'), '#!/bin/sh\n# MINE\n', '⚠️⚠️ overwrote an unreadable notify.sh')
    assert.equal(existsSync(`${f.target}.bak`), false)
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test('★★ restores the execute bit even when the contents are identical (notifications drop / codex round 24, medium #3)', () => {
  const f = fixture()
  try {
    mkdirSync(join(f.home, '.claude', 'hooks'), { recursive: true })
    writeFileSync(f.target, '#!/bin/sh\n# NEW\n', { mode: 0o644 })
    chmodSync(f.target, 0o644)
    assert.equal(quiet(() => main([], f.home, f.root)), 0)
    assert.equal(statSync(f.target).mode & 0o111, 0o111)
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test('★★ on failure leaves none of its own temp files and never removes anyone else\'s (codex round 24, low #6)', () => {
  const f = fixture()
  try {
    mkdirSync(join(f.home, '.claude', 'hooks'), { recursive: true })
    // ⚠️ A temp file with the same name already exists ⇒ refuse with `wx` (never overwrite or remove someone else's partial write)
    const stale = `${f.target}.tmp.${process.pid}`
    writeFileSync(stale, 'SOMEONE')
    const err = console.error
    console.error = () => {}
    try {
      assert.equal(quiet(() => main([], f.home, f.root)), 1)
    } finally {
      console.error = err
    }
    assert.equal(readFileSync(stale, 'utf8'), 'SOMEONE', '⚠️ removed a temp file it did not create')
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test('★★★ recognizes "run directly" for paths with spaces or Japanese and through a link (codex round 24, medium #2)', () => {
  const f = fixture()
  try {
    const odd = join(f.dir, 'My Apps 日本語')
    mkdirSync(odd)
    const script = join(odd, 'x.mjs')
    writeFileSync(script, '')
    const url = new URL(`file://${script.split('/').map(encodeURIComponent).join('/')}`).href
    assert.equal(isMain(script, url), true, '⚠️⚠️ fails for paths with spaces or Japanese (does nothing and exits 0)')
    const link = join(f.dir, 'link.mjs')
    symlinkSync(script, link)
    assert.equal(isMain(link, url), true, '⚠️ fails when called through a link')
    assert.equal(isMain(undefined, url), false)
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})
