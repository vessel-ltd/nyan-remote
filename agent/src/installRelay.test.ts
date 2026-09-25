// The PATH shim and the rc block (`scripts/install-relay.mjs`).
//
// ★★ Getting this wrong means **the user can no longer start claude** (the shim sits on the launch path).
//    So "the string was built" is not enough. **Actually run it and check the branches.**
//
// ⚠️ Six things to protect:
//   1. **Idempotent** (same result however many times it runs; neither the block nor PATH grows)
//   2. **Don't touch it when only one of the markers exists** (fail-closed)
//   3. **Change not a single character outside the block**
//   4. **Valid bash / zsh / sh syntax** (actually fed to `-n`)
//   5. ★ **fail-open works** (escape hatch, non-interactive, `-p`, no python3 -> plain claude)
//   6. ★★ **Never call itself** (if the shim finds itself via PATH lookup it execs forever)
//
// ⬜ The keystrokes themselves (the path that needs a tty) can't be tested here. See docs/VERIFY.md.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  BEGIN,
  END,
  absoluteClaudeCalls,
  applyBlock,
  checkerFor,
  binDirFor,
  buildBlock,
  buildWrapper,
  loginProfileFor,
  rcPathFor,
  ptyProbeArgv,
  shellFor,
  removeBlock,
  resolveRealClaude,
  // @ts-expect-error — plain .mjs (no types)
} from '../../scripts/install-relay.mjs'

const BIN = '/home/who/.nyan-remote/bin'
const RELAY = '/home/who/nyan-remote/scripts/relay.py'
const block = (): string => buildBlock(BIN) as string

test('buildBlock: only prepends to PATH; defines no function or alias', () => {
  const b = block()
  assert.ok(b.includes(`PATH="${BIN}\${PATH:+:$PATH}"`), 'puts the shim at the front of PATH')
  assert.ok(b.includes('case ":${PATH-}:"'), '⚠️ without the guard, reading the rc twice adds it twice')
  // ⚠️⚠️ The check starts with "**is it first**", not "is it present"
  //    (if `*":$dir:"*)` is the first branch, the .profile side becomes a no-op and can't fix the order)
  const firstBranch = b.split('case ":${PATH-}:" in')[1]?.trim().split('\n')[0] ?? ''
  assert.equal(firstBranch, `":${BIN}:"*) ;;`, `first branch is not "is it first": ${firstBranch}`)
  // ★ The actual effect is checked by the "comes first even in login shell order" test (below)
  // ★★ Not reverted to the function approach (`command claude` bypasses it, so it cannot work)
  assert.ok(!b.includes('claude()'), '⚠️⚠️ no shell function (command claude bypasses it)')
  assert.ok(!b.includes('unalias'), 'does not remove existing aliases')
  assert.ok(!b.includes('_claude_acct'), 'does not touch other people\'s definitions')
})

test('★★ applyBlock: running twice does not add a second block (idempotent)', () => {
  const rc = 'export PATH=$PATH:/x\nalias ll="ls -l"\n'
  const once = applyBlock(rc, block()) as string
  const twice = applyBlock(once, block()) as string
  assert.equal(once, twice)
  assert.equal(twice.split(BEGIN).length - 1, 1, 'only one block')
})

test('★ applyBlock: leaves everything outside the block alone / appends at the end (after things that touch PATH later)', () => {
  const rc = 'alias claude-r="_claude_acct r"\n'
  const out = applyBlock(rc, block()) as string
  assert.ok(out.startsWith(rc), 'the original lines stay at the top unchanged')
  assert.ok(out.indexOf(BEGIN) > out.indexOf('claude-r'), 'placed after existing definitions')
})

test('applyBlock: does not break an rc that does not end with a newline', () => {
  const out = applyBlock('export A=1', block()) as string
  assert.ok(out.startsWith('export A=1\n'))
})

test('★★ applyBlock: null when only one marker exists (do not touch = fail-closed)', () => {
  assert.equal(applyBlock(`x\n${BEGIN}\nこわれた\n`, block()), null)
  assert.equal(applyBlock(`x\n${END}\n`, block()), null)
})

test('removeBlock: removing restores the original (surrounding lines remain)', () => {
  const rc = 'A=1\nB=2\n'
  const out = applyBlock(rc, block()) as string
  assert.equal(removeBlock(out), rc)
  assert.equal(removeBlock('何も無い\n'), '何も無い\n', 'unchanged when absent')
  assert.equal(removeBlock(`${END}\n`), null, 'do not touch when only one marker')
})

test('★★ even with **two** blocks, none is left behind (Q1)', () => {
  // ⚠️ `indexOf` only sees **the first one**, so:
  //    - install left the old one (touching PATH twice)
  //    - `--uninstall` **left one** => a removed shim's directory stayed at the front of PATH
  // ⚠️ **Correction (2026-08-24 / codex)**: this used to say "claude could become 127", but
  //    that was **wrong**. `command -v` skips directories without an executable `claude`.
  //    => The real harm is just that **`--uninstall` doesn't fully remove it** (overstated before).
  const rc = 'A=1\n'
  const two = `${rc}\n${block()}\n\n${block()}\n`
  assert.equal(two.split(BEGIN).length - 1, 2, 'precondition: two blocks')

  const once = applyBlock(two, block()) as string
  assert.notEqual(once, null, '⚠️ if we refuse to touch two blocks, there is no way to remove them')
  assert.equal(once.split(BEGIN).length - 1, 1, 'install did not collapse into one')
  assert.equal(once.split(END).length - 1, 1)
  assert.ok(once.startsWith(rc), 'the original lines disappeared')
  // ★ Idempotent after collapsing
  assert.equal(applyBlock(once, block()), once, 'the collapsed form is not idempotent')

  // ★★ Removing leaves **none** (back to the original rc)
  assert.equal(removeBlock(two), rc, '⚠️ a block remains after removal')
  assert.equal(removeBlock(once), rc)
})

test('★★ malformed markers are left alone (nested / END first)', () => {
  // ⚠️ Even after adding "collapse if there are two", **forms with undefined meaning are not touched** (fail-closed)
  assert.equal(applyBlock(`${BEGIN}\n${BEGIN}\nx\n${END}\n`, block()), null, 'nested')
  assert.equal(removeBlock(`${BEGIN}\n${BEGIN}\nx\n${END}\n`), null, 'nested')
  assert.equal(applyBlock(`${END}\nx\n${BEGIN}\ny\n${END}\n`, block()), null, 'END first')
  assert.equal(removeBlock(`${END}\nx\n${BEGIN}\ny\n${END}\n`), null, 'END first')
  // The first is closed but the second is not
  assert.equal(applyBlock(`${block()}\n${BEGIN}\n`, block()), null, 'second not closed')
  assert.equal(removeBlock(`${block()}\n${BEGIN}\n`), null, 'second not closed')
})

test('★ round trip does not drop surrounding blank lines or join lines (R)', () => {
  // ⚠️ `removeBlock` squashed the preceding part with `replace(/\n+$/, '\n')`, so **trailing blank lines vanished**
  //    (it did not return to the uninstalled state = "removed, yet the rc changed")
  for (const rc of ['A=1\n', 'A=1\n\n', 'A=1\n\n\n', '', '\n']) {
    const on = applyBlock(rc, block()) as string
    assert.equal(removeBlock(on), rc, `changed by the round trip: ${JSON.stringify(rc)}`)
  }
  // ★ Even if moved to the middle by hand, removal **does not join lines**
  //   (eating both surrounding newlines yields `A=1B=2`)
  assert.equal(removeBlock(`A=1\n${block()}\nB=2\n`), 'A=1\nB=2\n')
  // ⚠️ An rc not ending with a newline gains one trailing newline after the round trip (normalized to a text file)
  assert.equal(removeBlock(applyBlock('export A=1', block()) as string), 'export A=1\n')
})

test('★★ markers only count as a block when they are the whole line (A7)', () => {
  // ⚠️ `indexOf` ignores line boundaries, so **the same string appearing once in the user's rc**
  //    was mistaken for the block and replaced (= the user's line disappeared)
  const inline = `echo "${BEGIN}"\n`
  const out = applyBlock(inline, block()) as string
  assert.notEqual(out, null)
  assert.ok(out.startsWith(inline), 'the original line disappeared')
  assert.equal(out.split(BEGIN).length - 1, 2, 'not the original line + a new block')
  assert.equal(removeBlock(out), inline, 'removing leaves only the original line')
  // An end marker that is only part of a line is also treated as absent (not null)
  const inlineEnd = `printf '%s' "${END}"\n`
  assert.notEqual(applyBlock(inlineEnd, block()), null, '⚠️ it has become untouchable')
  assert.equal(removeBlock(inlineEnd), inlineEnd)
})

test('★★ does not lose the block with CRLF or trailing whitespace after markers (B4)', () => {
  // ⚠️ An rc edited from a Windows editor on WSL becomes CRLF.
  //    `findMark` only allowed a newline right after the marker,
  //    => install **added a second block** and uninstall **left the old one**
  const plain = applyBlock('A=1\n', block()) as string
  for (const [why, rc] of [
    ['CRLF', plain.replace(/\n/g, '\r\n')],
    ['trailing whitespace after marker', plain.replace(BEGIN, `${BEGIN}  `).replace(END, `${END}\t`)],
  ] as const) {
    const again = applyBlock(rc, block())
    assert.notEqual(again, null, `${why}: became untouchable`)
    assert.equal((again as string).split(BEGIN).length - 1, 1, `${why}: a block was added`)
    const off = removeBlock(rc)
    assert.notEqual(off, null, `${why}: cannot remove`)
    assert.equal((off as string).split(BEGIN).length - 1, 0, `${why}: still present after removal`)
    assert.ok((off as string).startsWith('A=1'), `${why}: the original line disappeared`)
  }
})

test('★ ptyProbeArgv: script arguments take the per-OS form (5 / verify through relay on mac too)', () => {
  // ⚠️⚠️ mac used to be "skipped" = **we never once checked on mac that relay could be used**
  const p = '/Users/a b/.nyan-remote/bin/claude.tmp'
  // mac (BSD): `script -q /dev/null <command> [args...]` (⚠️ not quoted = does not go through a shell)
  assert.deepEqual(ptyProbeArgv('darwin', p, ['--version']), ['-q', '/dev/null', p, '--version'])
  // Linux (util-linux): `-c` is a single string, so quote it (so spaces don't split it)
  const linux = ptyProbeArgv('linux', p, ['--version'])
  assert.deepEqual(linux.slice(0, 1), ['-qec'])
  assert.equal(linux.at(-1), '/dev/null')
  assert.match(linux[1] as string, /^'\/Users\/a b\/.nyan-remote\/bin\/claude.tmp' '--version'$/)
})

test('★ ptyProbeArgv: on Linux the real script runs a path containing spaces without splitting it', { skip: process.platform !== 'linux' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pty probe '))
  try {
    const cmd = join(dir, 'say hi')
    await writeFile(cmd, '#!/bin/sh\necho "argv=$1"\n', { mode: 0o755 })
    const out = execFileSync('script', ptyProbeArgv('linux', cmd, ['--version']), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    assert.match(out, /argv=--version/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('★ checkerFor receives the **original name** (pin the call site mechanically / B4)', () => {
  // ⚠️ zsh isn't available in this environment, so **it can't be observed by behavior** (a mutant survived).
  //    => Pin the call site textually (same idea as `web/src/discipline.test.ts`).
  //    ⚠️ Passing `target` (the symlink destination) gives bash for `~/.zshrc -> ~/dotfiles/zshrc`
  const src = readFileSync(new URL('../../scripts/install-relay.mjs', import.meta.url), 'utf8')
  assert.match(src, /const checker = checkerFor\(path\)/, 'path is not passed to checkerFor')
  assert.doesNotMatch(src, /checkerFor\(target\)/, '⚠️ decided by the link destination name')
})

test('★ checkerFor: the syntax-check shell is chosen by the **original name** (B4)', () => {
  // ⚠️ It used to be chosen by the symlink **destination** name, so
  //    with `~/.zshrc -> ~/dotfiles/zshrc` (a common setup) **bash** was chosen,
  //    and bash rejected valid zsh syntax (`repeat 3; do …; done` etc.), making install impossible
  assert.equal(checkerFor('/home/x/.zshrc'), 'zsh')
  assert.equal(checkerFor('/home/x/.zprofile'), 'zsh')
  assert.equal(checkerFor('/home/x/.bashrc'), 'bash')
  assert.equal(checkerFor('/home/x/.profile'), 'bash')
})

test('★★ block: a path containing `$` or spaces goes into PATH verbatim (A7)', () => {
  // ⚠️ It used to be embedded raw, so `$USER` was expanded when the rc was read, and
  //    **a different directory than the one created** went into PATH (`$(…)` would have executed)
  const canary = '/tmp/nyan-remote-should-not-exist'
  rmSync(canary, { force: true }) // ⚠️ a leftover from a previous failure would mislead the next run
  const weird = '/tmp/あ い/$USER/`touch /tmp/nyan-remote-should-not-exist`/bin'
  const b = buildBlock(weird) as string
  const out = execFileSync(
    'bash',
    ['-c', `USER=だれか; PATH=/usr/bin:/bin\n${b}\nprintf %s "$PATH"`],
    { encoding: 'utf8' },
  )
  assert.equal(out.split(':')[0], weird, `expanded: ${out}`)
  assert.ok(!existsSync(canary), '⚠️⚠️ command substitution was executed')
})

test('★ block: does not fail in an rc with `set -u` (A7)', () => {
  const b = buildBlock(BIN) as string
  const out = execFileSync('bash', ['-c', `set -u\nunset PATH\n${b}\nprintf %s "$PATH"`], {
    encoding: 'utf8',
  })
  assert.equal(out, BIN, `broke when PATH was unset: ${JSON.stringify(out)}`)
})

test('rcPathFor: mac defaults to zsh (⚠️ writing to .bashrc is never read)', () => {
  assert.equal(rcPathFor('/bin/zsh', '/h', 'darwin'), '/h/.zshrc')
  assert.equal(rcPathFor('/bin/bash', '/h', 'linux'), '/h/.bashrc')
  assert.equal(rcPathFor(undefined, '/h', 'darwin'), '/h/.zshrc', 'if unknown, follow the OS convention')
  assert.equal(rcPathFor(undefined, '/h', 'linux'), '/h/.bashrc')
})

test('★★ loginProfileFor: the file read at login (runs **after** .bashrc)', () => {
  // ⚠️⚠️ Ubuntu's ~/.profile does "read .bashrc -> then prepend to PATH", so
  //    unless we put it here **the real binary wins in an actual terminal (login shell)** (measured 2026-08-23)
  const has = (...names: string[]) => (p: string) => names.some((n) => p.endsWith(n))
  assert.equal(loginProfileFor('/bin/bash', '/h', 'linux', has('.profile')), '/h/.profile')
  // bash reads only the first one that exists
  assert.equal(
    loginProfileFor('/bin/bash', '/h', 'linux', has('.bash_profile', '.profile')),
    '/h/.bash_profile',
    '⚠️ when .bash_profile exists, .profile is not read',
  )
  assert.equal(
    loginProfileFor('/bin/bash', '/h', 'linux', has('.bash_login', '.profile')),
    '/h/.bash_login',
  )
  // If none exists, create .profile (⚠️ creating .bash_profile would stop .profile from being read)
  assert.equal(loginProfileFor('/bin/bash', '/h', 'linux', () => false), '/h/.profile')
  // ★ zsh reads .zprofile -> .zshrc (.zshrc later), so nothing needs adding
  assert.equal(loginProfileFor('/bin/zsh', '/h', 'darwin', () => true), undefined)
  assert.equal(loginProfileFor(undefined, '/h', 'darwin', () => true), undefined)
})

test('binDirFor: same rule as relay.py (honors NYAN_REMOTE_STATE_DIR)', () => {
  assert.equal(binDirFor('/h', {}), '/h/.nyan-remote/bin')
  assert.equal(binDirFor('/h', { NYAN_REMOTE_STATE_DIR: '/s' }), '/s/bin')
})

test('★★ resolveRealClaude: searches excluding the shim directory (never picks itself as real)', () => {
  const exists = (p: string): boolean => p === '/opt/bin/claude' || p === '/h/.nyan-remote/bin/claude'
  // Even with the shim first in PATH, the real one comes from the next candidate
  assert.equal(
    resolveRealClaude('/h/.nyan-remote/bin:/opt/bin', '/h/.nyan-remote/bin', exists),
    '/opt/bin/claude',
  )
  assert.equal(resolveRealClaude('/nope', '/h/.nyan-remote/bin', exists), undefined)
  assert.equal(resolveRealClaude('', '/h/.nyan-remote/bin', exists), undefined)
})

test('★ absoluteClaudeCalls: picks up only calls that bypass the shim (report only, no fix)', () => {
  const found = absoluteClaudeCalls(
    [
      '# /usr/local/bin/claude はコメントなので無視',
      'alias claude-x="/home/k/.local/bin/claude"',
      'CLAUDE_CONFIG_DIR="$HOME/.claude-r" command claude "$@"',
      'alias claude-r="_claude_acct r"',
    ].join('\n'),
  ) as string[]
  assert.equal(found.length, 1, `too many / missed: ${JSON.stringify(found)}`)
  assert.ok(found[0]?.includes('.local/bin/claude'))
})

test('★★ absoluteClaudeCalls: does not miss **the most common forms** (Q4)', () => {
  // ⚠️⚠️ In real rc files the most common form is not an absolute path but `$HOME/...` and `~/...`.
  //    Missing those means "no ⚠️ shown so it's fine" = **silently falls to the inbox** forever.
  const hits = [
    'alias c1="$HOME/.local/bin/claude"',
    'alias c2="${HOME}/.claude/local/claude"',
    'alias c3="~/.local/bin/claude"',
    'exec /usr/local/bin/claude "$@"',
    '/opt/claude/bin/claude --version',
    'x=$(~/bin/claude --version)',
    '/opt/bin/claude>/dev/null', // ⚠️ a redirect is also a separator (`>` was missing)
    '~/bin/claude 2>&1 | head',
  ]
  for (const line of hits) {
    assert.deepEqual(absoluteClaudeCalls(line), [line], `missed: ${line}`)
  }
  const misses = [
    '# ~/.local/bin/claude はコメント',
    'export FOO=1  # 昔は $HOME/.local/bin/claude だった', // ★ no false positive from a trailing comment
    'CLAUDE_CONFIG_DIR="$HOME/.claude-r" command claude "$@"',
    'CLAUDE_CONFIG_DIR=$HOME/.claude claude', // ★ a config directory is not a call
    'alias claude-r="_claude_acct r"',
    'PATH="$HOME/.nyan-remote/bin:$PATH"',
    'alias c="$HOME/bin/claude-wrapper"', // ★ a different name (does not end in /claude)
  ]
  for (const line of misses) {
    assert.deepEqual(absoluteClaudeCalls(line), [], `false positive: ${line}`)
  }
  // ⚠️ A `#` inside quotes is **not a comment** (cutting there misses what follows).
  //    ⚠️⚠️ The example only means something if **the `#` is preceded by a space** (a mutant that
  //       removed quote tracking survived = the check was not observable)
  const quoted = 'alias c="echo \' # 注 \' ; ~/bin/claude"'
  assert.deepEqual(absoluteClaudeCalls(quoted), [quoted], 'cut at a # inside quotes')
})

// ─── From here on, we **actually run it** ───────────────────────────────

/** Create a temp directory with a fake real claude (echoes its args) and the shim */
function stage(opts: { realExists: boolean; realInPath: boolean; relayExists: boolean }): {
  dir: string
  shim: string
  realPath: string
  pathEnv: string
} {
  const dir = execFileSync('mktemp', ['-d', join(tmpdir(), 'nyan-remote-shim-XXXXXX')], {
    encoding: 'utf8',
  }).trim()
  const binDir = join(dir, 'bin')
  const realDir = join(dir, 'real')
  execFileSync('mkdir', ['-p', binDir, realDir])
  const realPath = join(realDir, 'claude')
  if (opts.realExists || opts.realInPath) {
    writeFileSync(realPath, '#!/bin/sh\necho "REAL $*"\n')
    chmodSync(realPath, 0o755)
  }
  const relay = join(dir, 'relay.py')
  // ★ Contents that make reaching it **visible** (not reached in non-tty tests; used by the pty tests)
  if (opts.relayExists) writeFileSync(relay, 'import sys\nprint("RELAY " + " ".join(sys.argv[1:]))\n')
  const shim = join(binDir, 'claude')
  // ⚠️ Even when real is "absent", **embed the path** (to exercise the re-search path)
  writeFileSync(shim, buildWrapper({ real: opts.realExists ? realPath : join(dir, 'gone'), relay }))
  chmodSync(shim, 0o755)
  // Put the shim **first** in PATH (if an infinite loop happens, it happens here)
  const pathEnv = [binDir, ...(opts.realInPath ? [realDir] : []), '/usr/bin', '/bin'].join(':')
  return { dir, shim, realPath, pathEnv }
}

const run = (shim: string, args: string[], env: Record<string, string>) =>
  spawnSync(shim, args, {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...env },
  })

test('★★ shim: non-interactive passes straight through to plain claude (fail-open)', async (t) => {
  const s = stage({ realExists: true, realInPath: false, relayExists: true })
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  const r = run(s.shim, ['--version'], { PATH: s.pathEnv })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'REAL --version')
})

test('★★ shim: escape hatch (NYAN_REMOTE_NO_RELAY=1) gives plain claude', async (t) => {
  const s = stage({ realExists: true, realInPath: false, relayExists: true })
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  const r = run(s.shim, ['-x'], { PATH: s.pathEnv, NYAN_REMOTE_NO_RELAY: '1' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'REAL -x')
})

test('★★ shim: `-p` / `--print` always pass through (a pty changes the output shape)', async (t) => {
  const s = stage({ realExists: true, realInPath: false, relayExists: true })
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  for (const flag of ['-p', '--print']) {
    const r = run(s.shim, [flag, 'hi'], { PATH: s.pathEnv })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.trim(), `REAL ${flag} hi`)
  }
})

test('★★ shim: if the embedded real one is gone, re-search PATH (excluding itself)', async (t) => {
  // ⚠️⚠️ Picking itself execs forever. If it dies by timeout this test goes red
  const s = stage({ realExists: false, realInPath: true, relayExists: true })
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  const r = run(s.shim, ['--version'], { PATH: s.pathEnv })
  assert.equal(r.signal, null, '⚠️ killed by timeout = it is calling itself')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'REAL --version', 'REAL only once')
})

test('★ shim: stops with 127 if no real one exists anywhere (not silently doing nothing)', async (t) => {
  const s = stage({ realExists: false, realInPath: false, relayExists: true })
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  const r = run(s.shim, ['--version'], { PATH: s.pathEnv, NYAN_LANG: 'ja' })
  assert.equal(r.signal, null, '⚠️ killed by timeout = it is calling itself')
  assert.equal(r.status, 127)
  assert.match(r.stderr, /本物の claude が見つかりません/)
  // ★ The language follows the current environment (Japanese only for a Japanese locale, otherwise English)
  const en = run(s.shim, ['--version'], { PATH: s.pathEnv })
  assert.equal(en.status, 127)
  assert.match(en.stderr, /the real claude was not found/)
  assert.doesNotMatch(en.stderr, /[\u3040-\u30ff\u4e00-\u9fff]/, '⚠️⚠️ Japanese appeared in an English environment')
  for (const [env, want] of [
    [{ LANG: 'ja_JP.UTF-8' }, /本物の/],
    [{ LANG: 'ja_JP.UTF-8', LC_ALL: 'C' }, /the real/],
    [{ LANG: 'en_US.UTF-8', LC_MESSAGES: 'ja_JP.UTF-8' }, /本物の/],
    [{ LANG: 'ja_JP.UTF-8', NYAN_LANG: 'en' }, /the real/],
  ] as const) {
    assert.match(run(s.shim, ['--version'], { PATH: s.pathEnv, ...env }).stderr, want, JSON.stringify(env))
  }
})

test('★ shim: passes through if relay.py is missing (start plain if it cannot be prepared)', async (t) => {
  const s = stage({ realExists: true, realInPath: false, relayExists: false })
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  const r = run(s.shim, ['--version'], { PATH: s.pathEnv })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'REAL --version')
})

// ⚠️⚠️ **The run tests so far are non-tty, so they pass through at `-t 0`.**
//    I.e. they never reach the `-p` branch (mutants did not fail them / measured 2026-08-23).
//    => **Open a pty and pin both directions.** This is the only test that shows "did it take the keystroke path".
const hasScript = spawnSync('script', ['--version']).status === 0

test('★★ shim: with a pty it goes through relay (only -p passes through)', { skip: !hasScript }, async (t) => {
  const s = stage({ realExists: true, realInPath: false, relayExists: true })
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  const pty = (cmd: string, env: Record<string, string> = {}) =>
    spawnSync('script', ['-qec', cmd, '/dev/null'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { PATH: s.pathEnv, ...env },
    })

  // Interactive (tty) -> handed to relay. ⚠️ The real path must be among relay's arguments
  const a = pty(`${s.shim} --version`)
  assert.match(a.stdout, /RELAY -- .*\/claude --version/, `did not go through relay: ${a.stdout}`)
  assert.doesNotMatch(a.stdout, /REAL/, '⚠️ passed through (the keystroke path dies)')

  // ★★ Even with a tty, `-p` passes through (a pty changes the output shape)
  const b = pty(`${s.shim} -p hi`)
  assert.match(b.stdout, /REAL -p hi/, `-p did not pass through: ${b.stdout}`)
  assert.doesNotMatch(b.stdout, /RELAY/, '⚠️⚠️ running -p through a pty breaks claude -p output')

  // ★★ The escape hatch only matters with a tty (without one it is indistinguishable from pass-through)
  const c = pty(`${s.shim} --version`, { NYAN_REMOTE_NO_RELAY: '1' })
  assert.match(c.stdout, /REAL --version/, `escape hatch not effective: ${c.stdout}`)
  assert.doesNotMatch(c.stdout, /RELAY/, '⚠️⚠️ goes through relay even with NYAN_REMOTE_NO_RELAY=1')
})

test('★★ shim: passes through without relay.py even with a pty (A8)', { skip: !hasScript }, async (t) => {
  // ⚠️ The "passes through if relay.py is missing" test above is **non-tty**, so `[ ! -t 0 ]` passed through first and
  //    the `[ ! -f "$relay" ]` branch was **never reached** (codex finding; a false green)
  const s = stage({ realExists: true, realInPath: false, relayExists: false })
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  const r = spawnSync('script', ['-qec', `${s.shim} --version`, '/dev/null'], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { PATH: s.pathEnv },
  })
  assert.match(r.stdout, /REAL --version/, `did not start plain: ${r.stdout}`)
  assert.doesNotMatch(r.stdout, /RELAY/, 'tries to go through a missing relay')
})

test('★★ shim: does not expand a PATH element that is a glob (B2)', async (t) => {
  // ⚠️⚠️ `for _ta_d in $PATH` is unquoted, so **pathname expansion happens** (review B2).
  //    With an element like `/opt/claude-*` in PATH, it could pick up `/opt/claude-evil/claude`,
  //    **which is not in PATH**, as the "real" one.
  const s2 = stage({ realExists: false, realInPath: true, relayExists: true })
  t.after(() => rm(s2.dir, { recursive: true, force: true }))
  const evilDir = join(s2.dir, 'evil', 'claude-evil')
  execFileSync('mkdir', ['-p', evilDir])
  writeFileSync(join(evilDir, 'claude'), '#!/bin/sh\necho "EVIL $*"\n')
  chmodSync(join(evilDir, 'claude'), 0o755)
  // ★ The PATH **element itself** is a glob (expanding it would hit evil)
  const pathEnv = [
    join(s2.dir, 'bin'),
    join(s2.dir, 'evil', 'claude-*'),
    join(s2.dir, 'real'),
    '/usr/bin',
    '/bin',
  ].join(':')
  const r = spawnSync(s2.shim, ['--version'], { encoding: 'utf8', timeout: 10_000, env: { PATH: pathEnv } })
  assert.doesNotMatch(r.stdout, /EVIL/, `⚠️⚠️ expanded the glob and picked another claude: ${r.stdout}`)
  assert.match(r.stdout, /REAL --version/, `did not reach the real one: ${r.stdout} ${r.stderr}`)
})

// ─── ★★ Loops (B1): **stop by count**. Exhaustively check mechanically that it "always ends in finite time" ───
//
// ⚠️⚠️ **A boolean guard cannot prevent it in principle** (measured 2026-08-24). Clearing the flag and running `exec claude`
//    returns to ourselves at the front of PATH, so merely having "another wrapper that re-invokes claude by name" in PATH
//    makes shim -> wrapper -> shim -> ... **loop forever** (through the relay, ptys pile up too).
// ⚠️ The test is built **without creating a pty** (a stub that only execs replaces relay).
//    Then the chain is **an exec loop in one process**, so the loop reproduces without hurting the machine.

/** Build a looping setup. The relay stub "execs its args as-is" = creates no pty */
function loopStage(kind: 'name' | 'abs' | 'copy' | 'alias'): {
  dir: string
  shim: string
  pathEnv: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-remote-loop-'))
  const binDir = join(dir, 'bin')
  const wrapDir = join(dir, 'wrap')
  execFileSync('mkdir', ['-p', binDir, wrapDir])
  const shim = join(binDir, 'claude')
  const relay = join(dir, 'relay.py')
  // ⚠️ Just takes `-- <real> <args...>` and execs (creates no pty)
  writeFileSync(relay, 'import os,sys\na=sys.argv[1:]\na=a[1:] if a and a[0]=="--" else a\nos.execvp(a[0],a)\n')
  const wrapper = join(wrapDir, 'claude')
  const body: Record<typeof kind, string> = {
    name: `#!/bin/sh\nexec claude "$@"\n`, // ★ re-invoke by name (the most common wrapper)
    abs: `#!/bin/sh\nexec ${shim} "$@"\n`, // call the shim by absolute path
    copy: '', // embed a copy of the shim as the real one (different inode, same contents)
    alias: '', // a symlink alias of the shim (same inode -> caught by -ef)
  }
  let real = wrapper
  if (kind === 'copy' || kind === 'alias') {
    real = join(wrapDir, 'claude')
  } else {
    writeFileSync(wrapper, body[kind])
    chmodSync(wrapper, 0o755)
  }
  writeFileSync(shim, buildWrapper({ real, relay }))
  chmodSync(shim, 0o755)
  if (kind === 'copy') {
    writeFileSync(real, readFileSync(shim, 'utf8'))
    chmodSync(real, 0o755)
  }
  if (kind === 'alias') symlinkSync(shim, real)
  return { dir, shim, pathEnv: [binDir, wrapDir, '/usr/bin', '/bin'].join(':') }
}

for (const kind of ['name', 'abs', 'copy', 'alias'] as const) {
  for (const mode of ['plain', 'escape-hatch', '-p'] as const) {
    test(`★★ always terminates even when looping (${kind} / ${mode})`, async (t) => {
      const s = loopStage(kind)
      t.after(() => rm(s.dir, { recursive: true, force: true }))
      const env: Record<string, string> = { PATH: s.pathEnv }
      if (mode === 'escape-hatch') env['NYAN_REMOTE_NO_RELAY'] = '1'
      const args = mode === '-p' ? ['-p', 'hi'] : ['--version']
      const r = spawnSync(s.shim, args, { encoding: 'utf8', timeout: 15_000, env })
      // ★ The verdict is the single point "did it finish without being killed" (not the output)
      assert.equal(r.signal, null, `⚠️⚠️ looping forever (killed by timeout / ${kind} / ${mode})`)
      // If it entered the loop: 127 + guidance; `alias` is caught by -ef and can start plain
      if (r.status !== 0) {
        assert.equal(r.status, 127, `unexpected exit code ${r.status}: ${r.stderr}`)
        assert.match(r.stderr, /循環|見つかりません|looping|not found/, `no reason shown: ${r.stderr}`)
      }
    })
  }
}

test('★★ loop guard: claude still starts with an overflowing value (B6)', async (t) => {
  // ⚠️⚠️ Passing a huge number to `[ "$x" -ge 8 ]` makes **dash die with "Illegal number"**
  //    = a single odd env var **prevents claude from starting** (a fail-closed accident).
  //    => Treat values with too many digits as 0 (do not block startup).
  const s2 = stage({ realExists: true, realInPath: false, relayExists: true })
  t.after(() => rm(s2.dir, { recursive: true, force: true }))
  for (const v of ['9'.repeat(30), '007', '-1', 'あ', '3']) {
    const r = run(s2.shim, ['--version'], { PATH: s2.pathEnv, _NYAN_REMOTE_SHIM: v })
    assert.equal(r.stdout.trim(), 'REAL --version', `cannot start with _NYAN_REMOTE_SHIM=${v}: ${r.stderr}`)
  }
})

test('★★ the count guard does not trigger without a loop (B1)', async (t) => {
  // ⚠️ Too small a limit breaks **normal nesting** (claude started from inside claude)
  const s = stage({ realExists: true, realInPath: false, relayExists: true })
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  for (const n of ['', '1', '2', '3']) {
    const env: Record<string, string> = { PATH: s.pathEnv }
    if (n) env['_NYAN_REMOTE_SHIM'] = n
    const r = run(s.shim, ['--version'], env)
    assert.equal(r.stdout.trim(), 'REAL --version', `cannot start at nesting level ${n || '0'}: ${r.stderr}`)
  }
})

test('★★ pty: claude started from inside a relayed session also goes through relay (A1/B1)', { skip: !hasScript }, async (t) => {
  // ⚠️⚠️ This is the core of A1. **With a boolean flag, inside a relayed session it always passed through**,
  //    so keystrokes did not work in that session and the screen gave no hint (measured 2026-08-23).
  const s = stage({ realExists: true, realInPath: false, relayExists: true })
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  const r = spawnSync('script', ['-qec', `${s.shim} --version`, '/dev/null'], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { PATH: s.pathEnv, _NYAN_REMOTE_SHIM: '1' }, // <- the parent is already relayed
  })
  assert.match(r.stdout, /RELAY -- .*\/claude --version/, `did not go through relay: ${r.stdout}`)
})

test('★★ the shim comes first even in login shell order (.profile grabs PATH afterwards)', async (t) => {
  // ⚠️⚠️ This is the trap hit on 2026-08-23. Ubuntu's ~/.profile does
  //     "read .bashrc -> then prepend to PATH", so
  //     just putting it in .bashrc means **the real one wins in an actual terminal**.
  //     Moreover a "do nothing if present" guard makes the .profile block a no-op.
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-login-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const rc = join(dir, 'bashrc')
  const profile = join(dir, 'profile')
  await writeFile(rc, applyBlock('', block()) as string)
  // Reproduce ~/.profile: read .bashrc -> prepend ~/.local/bin -> the same block at the end
  await writeFile(
    profile,
    `. ${rc}\nPATH="/opt/local/bin:$PATH"\n${applyBlock('', block()) as string}`,
  )
  const out = execFileSync('bash', ['-c', `PATH=/usr/bin:/bin; . ${profile}; printf %s "$PATH"`], {
    encoding: 'utf8',
  })
  assert.equal(out.split(':')[0], BIN, `shim is not first: ${out}`)
  // ★ However many times it is read: **exactly one, at the front** (hit a bug where reading .profile twice added more)
  const again = execFileSync(
    'bash',
    ['-c', `PATH=/usr/bin:/bin; . ${profile}; . ${profile}; . ${profile}; printf %s "$PATH"`],
    { encoding: 'utf8' },
  )
  const hits = again.split(':').filter((d) => d === BIN).length
  assert.equal(hits, 1, `duplicated: ${hits} entries / ${again}`)
  assert.equal(again.split(':')[0], BIN)
  // ⚠️ Did not break other PATH entries (only our own one is removed)
  assert.ok(again.includes('/opt/local/bin'), `removed another PATH entry: ${again}`)
  assert.ok(again.endsWith('/usr/bin:/bin'), `the tail changed: ${again}`)
})

test('★★ block: no empty entry (= cwd) even when PATH is empty; does not clobber user variables (Q2)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-q2-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const rc = join(dir, 'bashrc')
  await writeFile(rc, applyBlock('', block()) as string)

  // (a) ⚠️ With an empty PATH, `"${BIN}:$PATH"` gets a **trailing colon** = an empty entry = **cwd**.
  //     With cwd in PATH, a directory that happens to contain `./claude` could start something else.
  const empty = execFileSync('bash', ['-c', `PATH=; . ${rc}; printf %s "$PATH"`], {
    encoding: 'utf8',
  })
  assert.equal(empty, BIN, `created an empty entry: ${JSON.stringify(empty)}`)
  assert.ok(!empty.split(':').includes(''), '⚠️ an empty entry (cwd) got into PATH')

  // (b) The temp variables used on the "present but not first" path (remove and put in front)
  //     **must not clobber the user's variables**. ⚠️ Short names collide (`_ta` is plausibly used).
  //     ⚠️ However **`_nyan_remote_path` itself is reserved** (unavoidable; using it always clobbers it).
  //     Only two things are checked here: "don't take short names" and "clean up afterwards".
  const out = execFileSync(
    'bash',
    [
      '-c',
      `PATH=/usr/bin:${BIN}:/bin; _ta=わたしの値; _p=わたしの値2; . ${rc}; ` +
        `printf "%s|%s|%s|%s" "$PATH" "\${_ta-消えた}" "\${_p-消えた}" "\${!_tmux@}"`,
    ],
    { encoding: 'utf8' },
  )
  const [path, ta, up, leftover] = out.split('|')
  assert.equal(path, `${BIN}:/usr/bin:/bin`, `PATH reordering broke: ${path}`)
  assert.equal(ta, 'わたしの値', '⚠️ clobbered the user\'s `_ta`')
  assert.equal(up, 'わたしの値2', '⚠️ clobbered the user\'s `_p`')
  // ★ Clean up our own temp variables (leave none after reading the rc)
  assert.equal(leftover, '', `temp variables left over: ${leftover}`)
})

// ─── ★★ Infinite exec (3 variants found in the 2026-08-23 review; all reproduced by measurement) ───

/** Build the set with real files (mocks are not enough to test symlink and inode checks) */
function realStage(): { dir: string; binDir: string; realDir: string; shim: string } {
  const dir = mkdtempSync(join(tmpdir(), 'nyan-remote-loop-'))
  const binDir = join(dir, 'bin')
  const realDir = join(dir, 'real')
  execFileSync('mkdir', ['-p', binDir, realDir])
  writeFileSync(join(realDir, 'claude'), '#!/bin/sh\necho "REAL $*"\n')
  chmodSync(join(realDir, 'claude'), 0o755)
  writeFileSync(join(dir, 'relay.py'), 'import sys\nprint("RELAY " + " ".join(sys.argv[1:]))\n')
  return { dir, binDir, realDir, shim: join(binDir, 'claude') }
}

const putShim = (shim: string, real: string, relay: string): void => {
  writeFileSync(shim, buildWrapper({ real, relay }) as string)
  chmodSync(shim, 0o755)
}

test('★★ shim: does not keep calling itself when a PATH entry has a trailing slash', async (t) => {
  // ⚠️ It used to exclude itself by **string match** with `grep -vxF`, so `…/bin/` and `…/bin` were
  //    considered different, it picked itself, and got **exit 124 (infinite exec)** (measured)
  const s = realStage()
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  putShim(s.shim, join(s.dir, 'gone'), join(s.dir, 'relay.py')) // the real one is gone
  const r = spawnSync(s.shim, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { PATH: `${s.binDir}/:${s.realDir}:/usr/bin:/bin` }, // ★ trailing slash
  })
  assert.equal(r.signal, null, '⚠️⚠️ killed by timeout = it keeps calling itself')
  assert.equal(r.stdout.trim(), 'REAL --version')
})

test('★★ shim: escapes even when itself was embedded as the "real" one (re-entry guard)', async (t) => {
  // ⚠️⚠️ This was the **inescapable** form. `-x` is true so it never re-searched, and
  //    even `NYAN_REMOTE_NO_RELAY=1` could not escape because `exec "$real"` was itself (measured exit 124)
  const s = realStage()
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  putShim(s.shim, s.shim, join(s.dir, 'relay.py')) // ★ real = itself
  const r = spawnSync(s.shim, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { PATH: `${s.realDir}:/usr/bin:/bin` },
  })
  assert.equal(r.signal, null, '⚠️⚠️ killed by timeout = could not escape')
  assert.equal(r.stdout.trim(), 'REAL --version')
})

test('★★ resolveRealClaude: does not pick itself even with a symlink alias of the shim directory in PATH', async (t) => {
  // ⚠️ `resolve()` only **normalizes lexically**, so an alias is considered different.
  //    => Reinstalling **embeds the shim itself as the real one** (infinite exec from the next launch)
  const s = realStage()
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  putShim(s.shim, join(s.realDir, 'claude'), join(s.dir, 'relay.py'))
  const alias = join(s.dir, 'alias-bin')
  symlinkSync(s.binDir, alias)
  const picked = resolveRealClaude(`${alias}:${s.realDir}`, s.binDir) as string | undefined
  assert.equal(picked, join(s.realDir, 'claude'), `grabbed itself: ${picked}`)
})

test('★★ shim: falls back to plain claude when python3 "exists but does not run"', { skip: !hasScript }, async (t) => {
  // ⚠️ `command -v python3` **only checks existence**. pyenv / asdf shims "exist but do not run".
  //    After `exec python3` there is no way back to plain, so in measurement **claude never started once**
  const s = realStage()
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  putShim(s.shim, join(s.realDir, 'claude'), join(s.dir, 'relay.py'))
  const fakePy = join(s.dir, 'fakepy')
  execFileSync('mkdir', ['-p', fakePy])
  writeFileSync(join(fakePy, 'python3'), '#!/bin/sh\necho "pyenv: python3: not found" >&2\nexit 127\n')
  chmodSync(join(fakePy, 'python3'), 0o755)
  const r = spawnSync('script', ['-qec', `${s.shim} --version`, '/dev/null'], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { PATH: `${fakePy}:${s.binDir}:/usr/bin:/bin` },
  })
  assert.match(r.stdout, /REAL --version/, `claude did not start: ${r.stdout}`)
})

// ─── Syntax check (fed to real shells) ───────────────────────────

test('★★ the shim is valid sh syntax', () => {
  const dir = execFileSync('mktemp', ['-d'], { encoding: 'utf8' }).trim()
  const p = join(dir, 'shim')
  writeFileSync(p, buildWrapper({ real: "/opt/it's/claude", relay: RELAY }) as string)
  execFileSync('sh', ['-n', p], { stdio: 'pipe' })
  execFileSync('rm', ['-rf', dir])
})

for (const sh of ['bash', 'zsh']) {
  const available = spawnSync(sh, ['-c', 'exit 0']).status === 0
  test(`★★ the block is valid ${sh} syntax, and reading it twice adds only one PATH entry`, { skip: !available }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nyan-remote-rc-'))
    const path = join(dir, 'rc')
    await writeFile(path, applyBlock('alias claude-r="_claude_acct r"\n', block()) as string)
    execFileSync(sh, ['-n', path], { stdio: 'pipe' })
    // ★ Check the dedupe guard actually works (reading the string is not enough)
    const out = execFileSync(sh, ['-c', `PATH=/usr/bin:/bin; . ${path}; . ${path}; printf %s "$PATH"`], {
      encoding: 'utf8',
    })
    const hits = out.split(':').filter((d) => d === BIN).length
    assert.equal(hits, 1, `${hits} entries in PATH: ${out}`)
    await rm(dir, { recursive: true, force: true })
  })
}

// ★★ **The rc we write and the shell we inspect must not disagree** (2026-09-23 / the diagnostic lied on mac).
//
// ⚠️⚠️ `keys-status.mjs` inspected with hard-coded `bash`, so on mac (which writes `.zshrc`)
//   it said **"not reached" even though the shim worked** (the same screen showed "1 session can take keys ✅").
// => `shellFor` is derived from `rcPathFor`. Here we check **both agree for every combination**.
test('★★ shellFor always points to the same shell as rcPathFor', () => {
  const shells = ['/bin/zsh', '/usr/local/bin/zsh', '/bin/bash', '/opt/homebrew/bin/bash', '/usr/bin/fish', '', undefined]
  for (const os of ['darwin', 'linux']) {
    for (const sh of shells) {
      const rc = rcPathFor(sh, '/h', os)
      const want = rc.endsWith('.zshrc') ? 'zsh' : 'bash'
      assert.equal(shellFor(sh, os), want, `${os} / ${sh}: rc=${rc} but inspecting with ${shellFor(sh, os)}`)
    }
  }
  // ★ The real-machine form (mac default, $SHELL is zsh)
  assert.equal(shellFor('/bin/zsh', 'darwin'), 'zsh')
  // ⚠️ A mac with unknown $SHELL is also zsh (because the rc is written to .zshrc)
  assert.equal(shellFor(undefined, 'darwin'), 'zsh')
})

test('★★ keys-status.mjs does not hard-code the shell (⚠️ do not revert to the form that lied on mac)', () => {
  const src = readFileSync(new URL('../../scripts/keys-status.mjs', import.meta.url), 'utf8')
  // ⚠️ **Look only at executed lines** (don't pick up a `'bash'` mentioned in a comment / CLAUDE.md §2)
  const code = src
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n')
  assert.doesNotMatch(code, /execFileSync\(\s*'bash'/, '⚠️⚠️ launches bash hard-coded')
  assert.match(code, /shellFor\(/, 'the shell to inspect is not chosen by shellFor')
})
