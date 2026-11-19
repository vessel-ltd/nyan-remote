import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { decide, decideRemove, main, MARK, profiles } from './install-skill.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = readFileSync(join(ROOT, 'skills', 'nyan-team', 'SKILL.md'))
const quiet = (fn) => {
  const log = console.log
  const error = console.error
  console.log = () => {}
  console.error = () => {}
  try {
    return fn()
  } finally {
    console.log = log
    console.error = error
  }
}

test('★ the shipped skill carries the managed mark and the frontmatter Claude Code reads', () => {
  const s = SRC.toString('utf8')
  assert.match(s, /^---\nname: nyan-team\ndescription: .+\n---\n/)
  assert.ok(s.includes(MARK))
})

test('★★ decide: install / same / replace only our marked copy / leave the user’s, links and unreadable', () => {
  assert.equal(decide(undefined, SRC), 'install')
  assert.equal(decide(SRC, SRC), 'same')
  assert.equal(decide(Buffer.from(`---\nname: nyan-team\n---\n\n${MARK} — old -->\n`), SRC), 'replace')
  // ⚠️ a personal skill that only quotes the mark is the user's (r8 medium #4)
  assert.equal(decide(Buffer.from(`---\nname: mine\n---\n\nTo stop updates, delete the line ${MARK} — … -->\n`), SRC), 'theirs')
  assert.equal(decideRemove(Buffer.from(`# notes\n${MARK} — x -->\n`)), 'theirs')
  assert.equal(decide(Buffer.from('my own skill'), SRC), 'theirs')
  assert.equal(decide('link', SRC), 'link')
  assert.equal(decide('unreadable', SRC), 'unreadable')
  assert.equal(decideRemove(Buffer.from(`---\nname: nyan-team\n---\n\n${MARK} — x -->\n`)), 'remove')
  assert.equal(decideRemove(Buffer.from('mine')), 'theirs')
  assert.equal(decideRemove(undefined), 'absent')
})

test('★★ main: places into every profile with projects/, keeps the user’s edits, removes only ours', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nr-skill-'))
  try {
    for (const p of ['.claude', '.claude-r', '.claude-x']) mkdirSync(join(home, p, 'projects'), { recursive: true })
    mkdirSync(join(home, '.claude-empty')) // no projects/: not a profile in use
    mkdirSync(join(home, '.claudeish', 'projects'), { recursive: true }) // not a profile name
    assert.deepEqual(profiles(home).map((p) => p.split('/').pop()), ['.claude', '.claude-r', '.claude-x'])
    // the user's own skill under that name in .claude-x
    mkdirSync(join(home, '.claude-x', 'skills', 'nyan-team'), { recursive: true })
    writeFileSync(join(home, '.claude-x', 'skills', 'nyan-team', 'SKILL.md'), 'mine')
    assert.equal(quiet(() => main([], home, ROOT)), 0)
    assert.deepEqual(readFileSync(join(home, '.claude', 'skills', 'nyan-team', 'SKILL.md')), SRC)
    assert.deepEqual(readFileSync(join(home, '.claude-r', 'skills', 'nyan-team', 'SKILL.md')), SRC)
    assert.equal(readFileSync(join(home, '.claude-x', 'skills', 'nyan-team', 'SKILL.md'), 'utf8'), 'mine')
    assert.equal(existsSync(join(home, '.claude-empty', 'skills')), false)
    // ⚠️ an up-to-date copy others can write is replaced by one we own (r12 high #4)
    const { chmodSync: chmod2, statSync: stat2 } = await import('node:fs')
    chmod2(join(home, '.claude', 'skills', 'nyan-team', 'SKILL.md'), 0o666)
    assert.equal(quiet(() => main([], home, ROOT)), 0)
    assert.equal(stat2(join(home, '.claude', 'skills', 'nyan-team', 'SKILL.md')).mode & 0o777, 0o644)
    // a linked skill directory is never written through
    const elsewhere = join(home, 'elsewhere')
    mkdirSync(elsewhere)
    rmSync(join(home, '.claude-r', 'skills', 'nyan-team'), { recursive: true })
    symlinkSync(elsewhere, join(home, '.claude-r', 'skills', 'nyan-team'))
    assert.equal(quiet(() => main([], home, ROOT)), 0)
    assert.equal(existsSync(join(elsewhere, 'SKILL.md')), false)
    // ⚠️ a linked skills/ folder (a dotfiles repository) is never written into either (codex review, medium #4)
    const dots = join(home, 'dotfiles-skills')
    mkdirSync(dots)
    rmSync(join(home, '.claude', 'skills'), { recursive: true })
    symlinkSync(dots, join(home, '.claude', 'skills'))
    assert.equal(quiet(() => main([], home, ROOT)), 0)
    assert.equal(existsSync(join(dots, 'nyan-team')), false)
    rmSync(join(home, '.claude', 'skills'))
    assert.equal(quiet(() => main([], home, ROOT)), 0)
    // ⚠️ a linked profile (a shared profile kept elsewhere) is left alone too (codex review r2, medium #4)
    const shared = join(home, 'shared-profile')
    mkdirSync(join(shared, 'projects'), { recursive: true })
    symlinkSync(shared, join(home, '.claude-work'))
    assert.equal(quiet(() => main([], home, ROOT)), 0)
    assert.equal(existsSync(join(shared, 'skills')), false)
    // ⚠️ a skills/ folder others can write is left alone (they could swap nyan-team for a link / r4 medium #12)
    const { chmodSync } = await import('node:fs')
    mkdirSync(join(home, '.claude-g', 'projects'), { recursive: true })
    mkdirSync(join(home, '.claude-g', 'skills'))
    chmodSync(join(home, '.claude-g', 'skills'), 0o777)
    assert.equal(quiet(() => main([], home, ROOT)), 0)
    assert.equal(existsSync(join(home, '.claude-g', 'skills', 'nyan-team')), false)
    // remove: ours goes (and its now-empty directory), the user's stays
    assert.equal(quiet(() => main(['--remove'], home, ROOT)), 0)
    assert.equal(existsSync(join(home, '.claude', 'skills', 'nyan-team')), false)
    assert.equal(readFileSync(join(home, '.claude-x', 'skills', 'nyan-team', 'SKILL.md'), 'utf8'), 'mine')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
