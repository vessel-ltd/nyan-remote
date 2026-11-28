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

test('★★ Codex: a read-only copy of the team command, its launcher, the skill and the rule that lets only it out; only ours is replaced or removed (2026-11-27)', async () => {
  const { ruleText, codexSkill, isManagedRule, trustedNode, LAUNCHER_MARK } = await import('./install-skill.mjs')
  const { realpathSync, statSync } = await import('node:fs')
  const { spawnSync } = await import('node:child_process')
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'nr-skill-cx-')))
  const node = trustedNode(process.execPath)
  try {
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true })
    mkdirSync(join(home, '.codex', 'rules'), { recursive: true })
    mkdirSync(join(home, '.nyan-remote'), { mode: 0o700 })
    writeFileSync(join(home, '.codex', 'rules', 'default.rules'), 'prefix_rule(pattern=["git", "fetch"], decision="allow")\n')
    // ⚠️ a node others could change: nothing is placed in Codex
    const loose = join(home, 'loose')
    mkdirSync(loose, { mode: 0o777 })
    statSync(loose)
    const { chmodSync } = await import('node:fs')
    chmodSync(loose, 0o777)
    writeFileSync(join(loose, 'node'), '', { mode: 0o755 })
    assert.equal(quiet(() => main([], home, ROOT, {}, { node: join(loose, 'node'), tmpRoots: [] })), 0)
    assert.equal(existsSync(join(home, '.codex', 'rules', 'nyan-remote.rules')), false)
    assert.equal(existsSync(join(home, '.codex', '.codex', 'nyan-remote')), false)
    assert.equal(existsSync(join(home, '.codex', 'skills')), false)
    if (!node) return // this machine's node is not trustworthy enough to pin: the rest needs one
    assert.equal(quiet(() => main([], home, ROOT, {}, { node, tmpRoots: [] })), 0)
    // ★ one `.codex` deeper: read-only even with ~/.codex itself as Codex's workspace (codex review ② r3 #2)
    const entry = join(home, '.codex', '.codex', 'nyan-remote', 'nyan')
    // the copy: private, ours, the launcher pins this node
    assert.equal(statSync(join(home, '.codex', '.codex', 'nyan-remote')).mode & 0o777, 0o700)
    assert.equal(statSync(entry).mode & 0o777, 0o700)
    const launcher = readFileSync(entry, 'utf8')
    assert.ok(launcher.startsWith(`#!/bin/sh\n${LAUNCHER_MARK}.`))
    assert.match(launcher, new RegExp(`'${node.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`))
    assert.match(launcher, /env -i /)
    assert.deepEqual(readFileSync(join(home, '.codex', '.codex', 'nyan-remote', 'scripts', 'team.mjs')), readFileSync(join(ROOT, 'scripts', 'team.mjs')))
    // ★ it runs from the copy alone, `team` only, and NODE_OPTIONS never reaches node
    const run = (args, env = {}) => spawnSync(entry, args, { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home, NYAN_LANG: 'en', ...env }, timeout: 20_000 })
    const help = run(['team', 'help'], { NODE_OPTIONS: '--require /nonexistent/x.js' })
    assert.equal(help.status, 0, help.stderr)
    assert.match(help.stdout, /nyan team create/)
    assert.equal(run(['update']).status, 2)
    // the skill and the rule name that launcher
    assert.deepEqual(readFileSync(join(home, '.codex', 'skills', 'nyan-team', 'SKILL.md')), codexSkill(SRC, entry))
    const rule = readFileSync(join(home, '.codex', 'rules', 'nyan-remote.rules'), 'utf8')
    assert.equal(rule, ruleText(entry))
    assert.ok(isManagedRule(Buffer.from(rule)))
    // ⚠️⚠️ the absolute path only (a bare `nyan` let a workspace script out / measured), `team` only; `create` always asks
    //    the human in Codex (user decision 2026-11-28: as a Claude lead's create goes through Claude's approval)
    assert.match(rule, new RegExp(`^prefix_rule\\(pattern=\\["${entry}", "team"\\], decision="allow"\\)$`, 'm'))
    assert.match(rule, new RegExp(`^prefix_rule\\(pattern=\\["${entry}", "team", "create"\\], decision="prompt"\\)$`, 'm'))
    assert.equal(rule.match(/^prefix_rule/gm)?.length, 2)
    // ★ Codex's question tool: one marked line in its config (a new file: private)
    const cfg = join(home, '.codex', 'config.toml')
    assert.match(readFileSync(cfg, 'utf8'), /^\[features\]  # nyan-remote:managed\ndefault_mode_request_user_input = true  # nyan-remote:managed/m)
    assert.equal(statSync(cfg).mode & 0o777, 0o600)
    assert.doesNotMatch(rule, /pattern=\["nyan"/)
    // up to date: nothing rewritten; a copy changed by hand is put back
    assert.equal(quiet(() => main([], home, ROOT, {}, { node, tmpRoots: [] })), 0)
    writeFileSync(join(home, '.codex', '.codex', 'nyan-remote', 'scripts', 'team.mjs'), 'evil')
    assert.equal(quiet(() => main([], home, ROOT, {}, { node, tmpRoots: [] })), 0)
    assert.deepEqual(readFileSync(join(home, '.codex', '.codex', 'nyan-remote', 'scripts', 'team.mjs')), readFileSync(join(ROOT, 'scripts', 'team.mjs')))
    // ⚠️ a folder inside the copy moved into a workspace and linked back: not "up to date", rebuilt (r14 #1)
    const away = join(home, 'away-scripts')
    const { renameSync: mv2 } = await import('node:fs')
    mv2(join(home, '.codex', '.codex', 'nyan-remote', 'scripts'), away)
    symlinkSync(away, join(home, '.codex', '.codex', 'nyan-remote', 'scripts'))
    assert.equal(quiet(() => main([], home, ROOT, {}, { node, tmpRoots: [] })), 0)
    const { lstatSync: lst } = await import('node:fs')
    assert.equal(lst(join(home, '.codex', '.codex', 'nyan-remote', 'scripts')).isSymbolicLink(), false)
    // the user's own rule file is never touched
    assert.match(readFileSync(join(home, '.codex', 'rules', 'default.rules'), 'utf8'), /git", "fetch/)
    // a rule the user edited (mark removed) is kept, on update and on removal
    writeFileSync(join(home, '.codex', 'rules', 'nyan-remote.rules'), 'prefix_rule(pattern=["nyan"], decision="allow")\n')
    // ⚠️ kept, but said: it has no create prompt (codex review)
    const said = []
    const log0 = console.log
    console.log = (...a) => said.push(a.join(' '))
    try {
      assert.equal(main([], home, ROOT, {}, { node, tmpRoots: [] }), 0)
    } finally {
      console.log = log0
    }
    assert.match(said.join('\n'), /"team", "create"\], decision="prompt"/)
    // a commented-out create line does not count (codex review)
    said.length = 0
    writeFileSync(join(home, '.codex', 'rules', 'nyan-remote.rules'), `prefix_rule(pattern=["nyan"], decision="allow")\n# prefix_rule(pattern=["${entry}", "team", "create"], decision="prompt")\n`)
    console.log = (...a) => said.push(a.join(' '))
    try {
      assert.equal(main([], home, ROOT, {}, { node, tmpRoots: [] }), 0)
    } finally {
      console.log = log0
    }
    assert.match(said.join('\n'), /no line that asks|create を毎回聞く行がありません/)
    writeFileSync(join(home, '.codex', 'rules', 'nyan-remote.rules'), 'prefix_rule(pattern=["nyan"], decision="allow")\n')
    assert.equal(readFileSync(join(home, '.codex', 'rules', 'nyan-remote.rules'), 'utf8'), 'prefix_rule(pattern=["nyan"], decision="allow")\n')
    assert.equal(quiet(() => main(['--remove'], home, ROOT, {})), 0)
    assert.equal(existsSync(join(home, '.codex', 'rules', 'nyan-remote.rules')), true)
    // ours is removed with the skill and the copy; the user's other rules stay
    writeFileSync(join(home, '.codex', 'rules', 'nyan-remote.rules'), ruleText(entry))
    assert.equal(quiet(() => main([], home, ROOT, {}, { node, tmpRoots: [] })), 0)
    assert.equal(quiet(() => main(['--remove'], home, ROOT, {})), 0)
    assert.equal(existsSync(join(home, '.codex', 'rules', 'nyan-remote.rules')), false)
    assert.equal(existsSync(join(home, '.codex', '.codex', 'nyan-remote')), false)
    assert.equal(existsSync(join(home, '.codex', 'skills', 'nyan-team', 'SKILL.md')), false)
    assert.equal(existsSync(join(home, '.codex', 'rules', 'default.rules')), true)
    // ★ and our config line with it (the header we added too: nothing else was in it)
    assert.equal(readFileSync(cfg, 'utf8'), '')
    // ⚠️ a `nyan-remote` folder that is not ours: left alone, and no rule points into it
    mkdirSync(join(home, '.codex', '.codex', 'nyan-remote'), { recursive: true })
    writeFileSync(join(home, '.codex', '.codex', 'nyan-remote', 'nyan'), '#!/bin/sh\necho mine\n')
    assert.equal(quiet(() => main([], home, ROOT, {}, { node, tmpRoots: [] })), 0)
    assert.equal(readFileSync(join(home, '.codex', '.codex', 'nyan-remote', 'nyan'), 'utf8'), '#!/bin/sh\necho mine\n')
    assert.equal(existsSync(join(home, '.codex', 'rules', 'nyan-remote.rules')), false)
    assert.equal(quiet(() => main(['--remove'], home, ROOT, {})), 0)
    assert.equal(existsSync(join(home, '.codex', '.codex', 'nyan-remote', 'nyan')), true)
    rmSync(join(home, '.codex', '.codex', 'nyan-remote'), { recursive: true })
    // ⚠️⚠️ an installed copy folder moved into a workspace and linked back: the next update drops the old rule (r13 #1)
    assert.equal(quiet(() => main([], home, ROOT, {}, { node, tmpRoots: [] })), 0)
    assert.equal(existsSync(join(home, '.codex', 'rules', 'nyan-remote.rules')), true)
    const ws = join(home, 'ws')
    mkdirSync(ws)
    const { renameSync: mv } = await import('node:fs')
    mv(join(home, '.codex', '.codex'), join(ws, 'inner'))
    symlinkSync(join(ws, 'inner'), join(home, '.codex', '.codex'))
    assert.equal(quiet(() => main([], home, ROOT, {}, { node, tmpRoots: [] })), 0)
    assert.equal(existsSync(join(home, '.codex', 'rules', 'nyan-remote.rules')), false)
    assert.equal(existsSync(join(home, '.codex', 'skills', 'nyan-team', 'SKILL.md')), false)
    assert.equal(existsSync(join(ws, 'inner', 'nyan-remote', 'nyan')), true, 'nothing removed through the link')
    rmSync(join(home, '.codex', '.codex'))
    rmSync(ws, { recursive: true })
    // ⚠️ a linked inner `.codex` (it could lead into a workspace): never reused, written through, or removed through (r4 #2)
    const elsewhere = join(home, 'elsewhere')
    mkdirSync(join(elsewhere, 'nyan-remote'), { recursive: true })
    writeFileSync(join(elsewhere, 'nyan-remote', 'keep'), 'x')
    rmSync(join(home, '.codex', '.codex'), { recursive: true, force: true })
    symlinkSync(elsewhere, join(home, '.codex', '.codex'))
    assert.equal(quiet(() => main([], home, ROOT, {}, { node, tmpRoots: [] })), 0)
    assert.equal(existsSync(join(elsewhere, 'nyan-remote', 'nyan')), false)
    assert.equal(existsSync(join(home, '.codex', 'rules', 'nyan-remote.rules')), false)
    assert.equal(quiet(() => main(['--remove'], home, ROOT, {})), 0, 'left alone, and uninstall goes on (r14 #2)')
    assert.equal(existsSync(join(elsewhere, 'nyan-remote', 'keep')), true)
    rmSync(join(home, '.codex', '.codex'))
    // ⚠️ a Codex home inside a temp folder every sandbox may write: nothing placed (r4 #2)
    assert.equal(quiet(() => main([], home, ROOT, {}, { node, tmpRoots: [home] })), 0)
    assert.equal(existsSync(join(home, '.codex', '.codex', 'nyan-remote')), false)
    assert.equal(existsSync(join(home, '.codex', 'rules', 'nyan-remote.rules')), false)
    // ⚠️ a node inside such a temp folder: nothing placed either (r5 #1)
    const { dirname: dn } = await import('node:path')
    assert.equal(quiet(() => main([], home, ROOT, {}, { node, tmpRoots: [dn(node)] })), 0)
    assert.equal(existsSync(join(home, '.codex', '.codex', 'nyan-remote')), false)
    assert.equal(existsSync(join(home, '.codex', 'rules', 'nyan-remote.rules')), false)
    // ⚠️⚠️ only a real ~/.codex (r6 #1): another CODEX_HOME, or ~/.codex as a link (into a dotfiles folder), gets nothing
    const other = join(home, 'cx2')
    mkdirSync(other)
    assert.equal(quiet(() => main([], home, ROOT, { CODEX_HOME: other }, { node, tmpRoots: [] })), 0)
    assert.equal(existsSync(join(other, 'rules')), false)
    assert.equal(existsSync(join(other, '.codex')), false)
    assert.equal(existsSync(join(home, '.codex', 'rules', 'nyan-remote.rules')), false, 'nor ~/.codex when CODEX_HOME names another')
    // CODEX_HOME naming ~/.codex itself is fine
    assert.equal(quiet(() => main([], home, ROOT, { CODEX_HOME: join(home, '.codex') }, { node, tmpRoots: [] })), 0)
    assert.equal(existsSync(join(home, '.codex', 'rules', 'nyan-remote.rules')), true)
    assert.equal(quiet(() => main(['--remove'], home, ROOT, {})), 0)
    // ⚠️⚠️ an installed ~/.codex later moved into a dotfiles folder and linked back: the next update takes the old setup out
    //    (its rule still names the old path, which now leads into that folder / r7 #1)
    assert.equal(quiet(() => main([], home, ROOT, {}, { node, tmpRoots: [] })), 0)
    assert.equal(existsSync(join(home, '.codex', 'rules', 'nyan-remote.rules')), true)
    const dots = join(home, 'dotfiles', 'codex')
    mkdirSync(join(home, 'dotfiles'), { recursive: true })
    const { renameSync } = await import('node:fs')
    renameSync(join(home, '.codex'), dots)
    symlinkSync(dots, join(home, '.codex'))
    assert.equal(quiet(() => main([], home, ROOT, {}, { node, tmpRoots: [] })), 0)
    assert.equal(existsSync(join(dots, 'rules', 'nyan-remote.rules')), false)
    assert.equal(existsSync(join(dots, '.codex', 'nyan-remote')), false)
    assert.equal(existsSync(join(dots, 'skills', 'nyan-team', 'SKILL.md')), false)
    assert.equal(existsSync(join(dots, 'rules', 'default.rules')), true, 'the user\'s own rules stay')
    // ⚠️ the same when ~/.codex is moved (no link left) and CODEX_HOME names the new place (r8 #2)
    rmSync(join(home, '.codex'))
    renameSync(dots, join(home, '.codex'))
    assert.equal(quiet(() => main([], home, ROOT, {}, { node, tmpRoots: [] })), 0)
    assert.equal(existsSync(join(home, '.codex', 'rules', 'nyan-remote.rules')), true)
    const moved = join(home, 'moved-codex')
    renameSync(join(home, '.codex'), moved)
    assert.equal(quiet(() => main([], home, ROOT, { CODEX_HOME: moved }, { node, tmpRoots: [] })), 0)
    assert.equal(existsSync(join(moved, 'rules', 'nyan-remote.rules')), false)
    assert.equal(existsSync(join(moved, '.codex', 'nyan-remote')), false)
    assert.equal(existsSync(join(moved, 'skills', 'nyan-team', 'SKILL.md')), false)
    // ⚠️ a removal that must leave a home alone (others may change it) while our rule is still in it: said, and a failure (r9 #1)
    const loose2 = join(home, 'loose-codex')
    mkdirSync(join(loose2, 'rules'), { recursive: true })
    writeFileSync(join(loose2, 'rules', 'nyan-remote.rules'), ruleText('/x/nyan'))
    chmodSync(loose2, 0o777)
    assert.equal(quiet(() => main(['--remove'], home, ROOT, { CODEX_HOME: loose2 })), 1)
    chmodSync(loose2, 0o755)
    // ⚠️ our rule reached through a linked rules folder: left as is, but said and a failure (r10 #1)
    const linkedHome = join(home, 'linked-rules-codex')
    const rulesReal = join(home, 'dot-rules')
    mkdirSync(linkedHome)
    mkdirSync(rulesReal)
    writeFileSync(join(rulesReal, 'nyan-remote.rules'), ruleText('/x/nyan'))
    symlinkSync(rulesReal, join(linkedHome, 'rules'))
    assert.equal(quiet(() => main(['--remove'], home, ROOT, { CODEX_HOME: linkedHome })), 1)
    assert.equal(existsSync(join(rulesReal, 'nyan-remote.rules')), true)
    // ★ removal still looks at CODEX_HOME and ~/.codex (what an older version placed)
    mkdirSync(join(other, 'rules'))
    writeFileSync(join(other, 'rules', 'nyan-remote.rules'), ruleText('/x/nyan'))
    assert.equal(quiet(() => main(['--remove'], home, ROOT, { CODEX_HOME: other })), 0)
    assert.equal(existsSync(join(other, 'rules', 'nyan-remote.rules')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('★★ the Codex copy is self-contained: every import of a copied file is node: or another copied file', async () => {
  const { COPY_FILES } = await import('./install-skill.mjs')
  const { dirname: dn, normalize } = await import('node:path')
  for (const rel of COPY_FILES) {
    const text = readFileSync(join(ROOT, rel), 'utf8')
    const specs = [...text.matchAll(/(?:^|\n)\s*import\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? m[2])
    assert.ok(specs.length > 0 || rel.endsWith('i18n.ts'), rel)
    for (const spec of specs) {
      if (spec.startsWith('node:')) continue
      assert.ok(spec.startsWith('.'), `${rel} imports a package: ${spec}`)
      assert.ok(COPY_FILES.includes(normalize(join(dn(rel), spec))), `${rel} imports ${spec}, which is not copied`)
    }
  }
})

test('★ trustedNode: a real, plain file nobody else can change, under folders nobody else can change', async () => {
  const { trustedNode } = await import('./install-skill.mjs')
  const { realpathSync, chmodSync } = await import('node:fs')
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'nr-node-')))
  try {
    mkdirSync(join(d, 'bin'), { mode: 0o755 })
    writeFileSync(join(d, 'bin', 'node'), '', { mode: 0o755 })
    assert.equal(trustedNode(join(d, 'bin', 'node')), join(d, 'bin', 'node'))
    symlinkSync(join(d, 'bin', 'node'), join(d, 'link'))
    assert.equal(trustedNode(join(d, 'link')), join(d, 'bin', 'node'), 'pinned by its real path')
    chmodSync(join(d, 'bin', 'node'), 0o777)
    assert.equal(trustedNode(join(d, 'bin', 'node')), undefined)
    chmodSync(join(d, 'bin', 'node'), 0o755)
    chmodSync(join(d, 'bin'), 0o777)
    assert.equal(trustedNode(join(d, 'bin', 'node')), undefined)
    chmodSync(join(d, 'bin'), 0o755)
    mkdirSync(join(d, 'sp ace'))
    writeFileSync(join(d, 'sp ace', 'node'), '', { mode: 0o755 })
    assert.equal(trustedNode(join(d, 'sp ace', 'node')), undefined, 'only characters the launcher can carry')
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('★ a fresh Codex whose rules folder is a link (dotfiles): no skill, no copy, no rule (r15 #2)', async () => {
  const { trustedNode } = await import('./install-skill.mjs')
  const { realpathSync } = await import('node:fs')
  const node = trustedNode(process.execPath)
  if (!node) return
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'nr-skill-lr-')))
  try {
    mkdirSync(join(home, '.codex'))
    mkdirSync(join(home, 'dot-rules'))
    symlinkSync(join(home, 'dot-rules'), join(home, '.codex', 'rules'))
    assert.equal(quiet(() => main([], home, ROOT, {}, { node, tmpRoots: [] })), 0)
    assert.equal(existsSync(join(home, '.codex', 'skills', 'nyan-team', 'SKILL.md')), false)
    assert.equal(existsSync(join(home, '.codex', '.codex', 'nyan-remote')), false)
    assert.equal(existsSync(join(home, 'dot-rules', 'nyan-remote.rules')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('★ a rules folder Codex keeps read-only to us: no rule ⇒ no skill and no copy left (r16 #2)', async () => {
  const { trustedNode } = await import('./install-skill.mjs')
  const { realpathSync, chmodSync } = await import('node:fs')
  const node = trustedNode(process.execPath)
  if (!node || process.getuid?.() === 0) return
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'nr-skill-ro-')))
  try {
    mkdirSync(join(home, '.codex', 'rules'), { recursive: true })
    chmodSync(join(home, '.codex', 'rules'), 0o555)
    assert.equal(quiet(() => main([], home, ROOT, {}, { node, tmpRoots: [] })), 0)
    assert.equal(existsSync(join(home, '.codex', 'rules', 'nyan-remote.rules')), false)
    assert.equal(existsSync(join(home, '.codex', 'skills', 'nyan-team', 'SKILL.md')), false)
    assert.equal(existsSync(join(home, '.codex', '.codex', 'nyan-remote')), false)
  } finally {
    chmodSync(join(home, '.codex', 'rules'), 0o755)
    rmSync(home, { recursive: true, force: true })
  }
})

test('★★ Codex config: one marked line under [features], only ours ever written or removed (2026-11-28)', async () => {
  const { withFeature, withoutFeature, codexFeature, FEATURE_KEY } = await import('./install-skill.mjs')
  const ours = /^default_mode_request_user_input = true  # nyan-remote:managed/m
  // a file with no [features]: a marked header and our line at the end; removal gives the file back as it was
  const plain = 'model = "x"\n\n[tui]\nnotifications = true\n'
  const a = withFeature(plain)
  assert.equal(a.state, 'added')
  assert.match(a.text, ours)
  assert.ok(a.text.startsWith(plain))
  assert.equal(withoutFeature(a.text).text, plain)
  // an existing [features] keeps its keys; ours goes right under the header; removal keeps the header (theirs)
  const feat = 'model = "x"\n[features]\nweb_search = true\n[tui]\nx = 1\n'
  const b = withFeature(feat)
  assert.equal(b.state, 'added')
  assert.equal(b.text, `model = "x"\n[features]\n${b.text.split('\n')[2]}\nweb_search = true\n[tui]\nx = 1\n`)
  assert.match(b.text.split('\n')[2], ours)
  assert.equal(withoutFeature(b.text).text, feat)
  // already there: nothing
  assert.equal(withFeature(b.text).state, 'same')
  // the user's own setting of the key (true or false): left alone, never removed
  for (const own of ['[features]\ndefault_mode_request_user_input = false\n', '[features]\n  default_mode_request_user_input=true\n']) {
    assert.equal(withFeature(own).state, 'theirs')
    assert.equal(withoutFeature(own).removed, false)
  }
  // features written another way: left alone
  for (const other of ['features.web_search = true\n', 'features = { web_search = true }\n', '[features]\na = 1\n[features]\nb = 2\n']) assert.equal(withFeature(other).state, 'unsupported', other)
  // ⚠️ quoted spellings are the same table / key (codex review: a duplicate table or key made the file unreadable)
  const quoted = withFeature('["features"]\nweb_search = true\n')
  assert.equal(quoted.state, 'added')
  assert.equal(quoted.text.match(/features/g)?.length, 1)
  assert.equal(withFeature("['features']\n\"default_mode_request_user_input\" = false\n").state, 'theirs')
  assert.equal(withFeature("[features]\n'default_mode_request_user_input' = false\n").state, 'theirs')
  assert.equal(withFeature('"features".web_search = true\n').state, 'unsupported')
  // escapes in a quoted header or key may spell the same name: left alone (codex review)
  assert.equal(withFeature('["featur\\u0065s"]\nb = 1\n').state, 'unsupported')
  assert.equal(withFeature('[features]\n"default_mode_request_user_inpu\\u0074" = false\n').state, 'unsupported')
  // but ordinary quoted headers (Codex's own projects) are fine
  assert.equal(withFeature('[projects."/home/user"]\ntrust_level = "trusted"\n').state, 'added')
  // ⚠️ lines inside a multi-line string are text: never a header, a key, or our line to remove (codex review)
  const multi = 'developer_instructions = """\n[features]\ndefault_mode_request_user_input = true  # nyan-remote:managed\n"""\nmodel = "x"\n'
  const m = withFeature(multi)
  assert.equal(m.state, 'added')
  assert.ok(m.text.startsWith(multi))
  assert.equal(withoutFeature(multi).removed, false)
  assert.equal(withoutFeature(m.text).text, multi)
  // an escaped delimiter inside a basic multi-line string does not end it (codex review); a literal one has no escapes
  const esc = 'developer_instructions = """\nsay \\""" here\n[features]\n"""\n[features]\nb = 1\n'
  const e = withFeature(esc)
  assert.equal(e.state, 'added')
  assert.match(e.text.split('\n')[5], ours)
  const lit = "notes = '''\n[features]\n'''\n"
  assert.ok(withFeature(lit).text.startsWith(lit))
  // a `#` or quotes inside a one-line string do not open anything
  const one = 'a = "x # \\" y"\n[features]\nb = 1\n'
  assert.match(withFeature(one).text.split('\n')[2], ours)
  // our line reformatted (spaces) is still ours on removal (codex review)
  assert.equal(withoutFeature('[features]\ndefault_mode_request_user_input=true # nyan-remote:managed\nb = 1\n').text, '[features]\nb = 1\n')
  // [features.sub] is not [features]
  assert.equal(withFeature('[features.sub]\nx = 1\n').state, 'added')
  // empty file
  assert.match(withFeature('').text, /^\[features\]  # nyan-remote:managed\n/)
  // ⚠️ the file on disk: its mode kept, a linked one left alone
  const { realpathSync, statSync, chmodSync, lstatSync } = await import('node:fs')
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'nr-skill-cfg-')))
  try {
    const cx = join(home, '.codex')
    mkdirSync(cx, { mode: 0o700 })
    const cfg = join(cx, 'config.toml')
    writeFileSync(cfg, feat, { mode: 0o640 })
    chmodSync(cfg, 0o640)
    // ⚠️ under a narrow umask too (codex review: 0640 became 0600)
    const mask = process.umask(0o077)
    try {
      assert.equal(quiet(() => codexFeature(cx, false)), 'changed')
    } finally {
      process.umask(mask)
    }
    assert.equal(statSync(cfg).mode & 0o777, 0o640)
    assert.equal(quiet(() => codexFeature(cx, false)), 'same')
    assert.equal(quiet(() => codexFeature(cx, true)), 'changed')
    assert.equal(readFileSync(cfg, 'utf8'), feat)
    assert.equal(quiet(() => codexFeature(cx, true)), 'same')
    // a config.toml that is a link (dotfiles): untouched either way
    const dot = join(home, 'dot.toml')
    writeFileSync(dot, plain)
    rmSync(cfg)
    symlinkSync(dot, cfg)
    assert.equal(quiet(() => codexFeature(cx, false)), 'skipped')
    assert.equal(readFileSync(dot, 'utf8'), plain)
    assert.ok(lstatSync(cfg).isSymbolicLink())
    // a hard-linked config.toml: untouched (a rename would cut the link / codex review)
    const { linkSync } = await import('node:fs')
    rmSync(cfg)
    const hard = join(home, 'hard.toml')
    writeFileSync(hard, plain)
    linkSync(hard, cfg)
    assert.equal(quiet(() => codexFeature(cx, false)), 'skipped')
    assert.equal(readFileSync(hard, 'utf8'), plain)
    // a linked Codex home: untouched
    const away = join(home, 'away')
    mkdirSync(away, { mode: 0o700 })
    writeFileSync(join(away, 'config.toml'), plain)
    const linked = join(home, '.codex2')
    symlinkSync(away, linked)
    assert.equal(quiet(() => codexFeature(linked, false)), 'skipped')
    assert.equal(readFileSync(join(away, 'config.toml'), 'utf8'), plain)
    assert.ok(FEATURE_KEY)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
