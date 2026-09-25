// ★★ What may reach the public repository (scripts/publish-public.mjs / codex round 33).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { classify, forbiddenPatterns, scan, SECRET_SHAPES } from './publish-public.mjs'

test('★★★ only listed places and file types are public; anything else stops the publish', () => {
  assert.equal(classify('agent/src/index.ts'), 'keep')
  assert.equal(classify('web/public/cats/mochi-cat.png'), 'keep')
  assert.equal(classify('README.md'), 'keep')
  assert.equal(classify('SECURITY.md'), 'keep')
  assert.equal(classify('.github/ISSUE_TEMPLATE/bug_report.yml'), 'keep')
  assert.equal(classify('docs/HANDOFF.md'), 'drop')
  assert.equal(classify('CLAUDE.md'), 'drop')
  assert.equal(classify('relay/README.md'), 'drop', '⚠️ only the root README is public')
  assert.equal(classify('account/INTERNAL.md'), 'drop', '⚠️⚠️ a new internal note was published')
  assert.notEqual(classify('notes/plan.ts'), 'keep', '⚠️⚠️ a new top-level folder was published without being listed')
  assert.notEqual(classify('account/notes.txt'), 'keep', '⚠️ an unknown file type was published')
  assert.notEqual(classify('agent/src/dump.bin'), 'keep')
})

test('★★★ nothing is skipped by the scan: NUL in a text file stops, secrets inside images are found', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-publish-test-'))
  try {
    mkdirSync(join(dir, 'a'))
    writeFileSync(join(dir, 'a', 'x.ts'), Buffer.concat([Buffer.from('\0'), Buffer.from('sk_live_' + 'A'.repeat(24))]))
    writeFileSync(join(dir, 'a', 'y.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]), Buffer.from('whsec_' + 'B'.repeat(24))]))
    writeFileSync(join(dir, 'a', 'z.ts'), 'export const ok = 1\n')
    writeFileSync(join(dir, 'a', 'clean.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]))
    const hits = scan(dir, SECRET_SHAPES)
    assert.ok(hits.some((h) => h.startsWith('a/x.ts') && /NUL/.test(h)), '⚠️⚠️ a NUL byte let a text file skip the scan')
    assert.ok(hits.some((h) => h.startsWith('a/y.png') && /whsec/.test(h)), '⚠️⚠️ a secret inside an image was not found')
    assert.ok(!hits.some((h) => h.startsWith('a/z.ts')))
    assert.ok(!hits.some((h) => h.startsWith('a/clean.png')), '⚠️ an ordinary image (NUL bytes, no secret) was refused')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★ the path is checked too, and an empty personal-value list stops (codex round 34)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-publish-test-'))
  try {
    mkdirSync(join(dir, 'docs'))
    writeFileSync(join(dir, 'docs', 'publish-forbidden.txt'), '# only comments\n\n')
    assert.throws(() => forbiddenPatterns(dir), /no patterns/, '⚠️⚠️ an empty list turned the check off silently')
    writeFileSync(join(dir, 'docs', 'publish-forbidden.txt'), 'secretbox\n')
    mkdirSync(join(dir, 'agent'))
    writeFileSync(join(dir, 'agent', 'secretbox.ts'), 'export const ok = true\n')
    const hits = scan(join(dir, 'agent'), forbiddenPatterns(dir))
    assert.ok(hits.some((h) => /path matches/.test(h)), '⚠️⚠️ a forbidden value in a file name was not caught')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
