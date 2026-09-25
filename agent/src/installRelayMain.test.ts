// Runs the installer's **whole main()** (`scripts/install-relay.mjs`).
//
// ★★ Why this is needed: `main()` is 190 lines and **had not a single test** (2026-08-23 review).
//    It holds the only path that can "hand the user back a broken shell", plus the fail-closed gates:
//      temp file → syntax check → **real-run verification** → rename / replace the rc only after all pass
//    ⇒ Breaking any of them left every pure-function test green.
//
// ★ Runs in a sandbox HOME (Node's `os.homedir()` looks at `$HOME` on POSIX).
//   ⚠️ **Never touch** the real `~/.bashrc` (checked by swapping HOME).

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  linkSync,
  lstatSync,
  statSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
// @ts-expect-error — plain .mjs (no types)
import { BEGIN, END } from '../../scripts/install-relay.mjs'

const INSTALLER = join(fileURLToPath(new URL('../../scripts/', import.meta.url)), 'install-relay.mjs')
const BASHRC = 'export FOO=1\nalias ll="ls -l"\n'
const PROFILE = '# profile\nif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi\nPATH="$HOME/.local/bin:$PATH"\n'

/**
 * Creates a sandbox HOME (with a fake claude; never touches the real one).
 *
 * With `noPython: true`, runs with **a PATH where no python3 is visible**
 * (creates a directory with symlinks to only the external commands needed).
 * ⚠️ Why: if python3 cannot run, the shim **execs the plain claude** (fail-open).
 *    The installer must not then claim it "went through the relay".
 */
function sandbox(
  opts: { noPython?: boolean; env?: Record<string, string>; stateDirUnder?: string } = {},
): {
  home: string
  run: (...args: string[]) => { status: number | null; out: string }
  childEnv: (extra?: Record<string, string>) => Record<string, string>
} {
  const home = mkdtempSync(join(tmpdir(), 'nyan-remote-home-'))
  mkdirSync(join(home, 'bin'))
  writeFileSync(join(home, 'bin', 'claude'), '#!/bin/sh\necho "2.1.999 (Fake Claude)"\n')
  chmodSync(join(home, 'bin', 'claude'), 0o755)
  writeFileSync(join(home, '.bashrc'), BASHRC)
  writeFileSync(join(home, '.profile'), PROFILE)
  const nodeDir = join(process.execPath, '..')
  // ★ The state dir can also be placed under a directory containing a space (for checking B2)
  const stateDir = join(home, opts.stateDirUnder ?? '', '.nyan-remote')
  let systemPath = '/usr/bin:/bin'
  if (opts.noPython) {
    const tools = join(home, 'tools')
    mkdirSync(tools)
    for (const cmd of ['sh', 'bash', 'script', 'cat', 'rm', 'mv']) {
      const found = execFileSync('sh', ['-c', `command -v ${cmd} || true`], { encoding: 'utf8' }).trim()
      if (found) symlinkSync(found, join(tools, cmd))
    }
    systemPath = tools
  }
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [INSTALLER, ...args], {
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        HOME: home,
        SHELL: '/bin/bash',
        PATH: `${join(home, 'bin')}:${nodeDir}:${systemPath}`,
        NYAN_REMOTE_STATE_DIR: stateDir,
        NYAN_LANG: 'ja', // ★ the messages are asserted in Japanese
        ...(opts.env ?? {}),
      },
    })
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
  }
  /** ★ An env of **the same shape** the installer uses for its check (⚠️ drops our own session's marker) */
  const childEnv = (extra: Record<string, string> = {}) => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: home,
      SHELL: '/bin/bash',
      PATH: `${join(home, 'bin')}:${nodeDir}:${systemPath}`,
      NYAN_REMOTE_STATE_DIR: stateDir,
      NYAN_LANG: 'ja',
      ...extra,
    }
    delete env['_NYAN_REMOTE_SHIM']
    return env
  }
  return { home, run, childEnv }
}

const count = (text: string, needle: string): number => text.split(needle).length - 1

/** Runs the installer against an existing sandbox HOME with extra env */
function runWith(home: string, extra: Record<string, string>): { status: number | null; out: string } {
  const nodeDir = join(process.execPath, '..')
  const r = spawnSync(process.execPath, [INSTALLER], {
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      HOME: home,
      SHELL: '/bin/bash',
      PATH: `${join(home, 'bin')}:${nodeDir}:/usr/bin:/bin`,
      NYAN_REMOTE_STATE_DIR: join(home, '.nyan-remote'),
      NYAN_LANG: 'ja',
      ...extra,
    },
  })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

test('★★ main(): install → idempotent → uninstall returns the rc byte-for-byte unchanged', (t) => {
  const sb = sandbox()
  const { home, run } = sb
  t.after(() => rmSync(home, { recursive: true, force: true }))

  // --dry-run writes nothing
  const dry = run('--dry-run')
  assert.equal(dry.status, 0, dry.out)
  assert.equal(readFileSync(join(home, '.bashrc'), 'utf8'), BASHRC, '--dry-run wrote something')
  assert.ok(!existsSync(join(home, '.nyan-remote', 'bin', 'claude')), '--dry-run placed the shim')

  // First run
  const first = run()
  assert.equal(first.status, 0, first.out)
  const shim = join(home, '.nyan-remote', 'bin', 'claude')
  assert.ok(existsSync(shim), 'shim was not placed')
  // ★ Output confirming it went all the way through the relay (no ✅ for a plain pass-through)
  assert.match(first.out, /relay を通して claude が起動しました/, first.out)
  // ★★ **Do not trust self-reporting** (codex finding). Open our own pty and look at the relay's registration.
  //    ⚠️ Unless `_NYAN_REMOTE_SHIM` is dropped, the re-entry guard misfires and the relay is skipped (A1)
  if (spawnSync('script', ['--version']).status === 0) {
    const relayLog = join(home, 'relay.log')
    const pty = spawnSync('script', ['-qec', `${shim} --version`, '/dev/null'], {
      encoding: 'utf8',
      timeout: 60_000,
      env: sb.childEnv({ RELAY_LOG: relayLog }),
    })
    assert.match(pty.stdout, /2\.1\.999/, `claude did not start: ${pty.stdout}`)
    const logged = existsSync(relayLog) ? readFileSync(relayLog, 'utf8') : ''
    assert.match(logged, /名乗り=あり/, `⚠️ the keystroke entry point was not created: ${JSON.stringify(logged)}`)
  }
  for (const f of ['.bashrc', '.profile']) {
    const body = readFileSync(join(home, f), 'utf8')
    assert.equal(count(body, BEGIN), 1, `${f} does not have exactly one block`)
    assert.ok(body.startsWith(f === '.bashrc' ? BASHRC : PROFILE), `${f}: original lines were broken`)
  }

  // Second run (idempotent)
  const second = run()
  assert.equal(second.status, 0, second.out)
  assert.match(second.out, /変更なし/, second.out)
  assert.equal(count(readFileSync(join(home, '.bashrc'), 'utf8'), BEGIN), 1, 'blocks multiplied')

  // Uninstall → **restored byte-for-byte**
  const off = run('--uninstall')
  assert.equal(off.status, 0, off.out)
  assert.equal(readFileSync(join(home, '.bashrc'), 'utf8'), BASHRC, '.bashrc was not restored')
  assert.equal(readFileSync(join(home, '.profile'), 'utf8'), PROFILE, '.profile was not restored')
  assert.ok(!existsSync(shim), 'shim is left behind')
})

test('★★ main(): does not touch an rc with only one of the delimiters (fail-closed)', (t) => {
  const { home, run } = sandbox()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const broken = `${BASHRC}${BEGIN}\nこわれている\n`
  writeFileSync(join(home, '.bashrc'), broken)
  const r = run()
  assert.notEqual(r.status, 0, 'finished successfully on a broken rc')
  assert.equal(readFileSync(join(home, '.bashrc'), 'utf8'), broken, 'rewrote the broken rc')
  assert.equal(readFileSync(join(home, '.profile'), 'utf8'), PROFILE, '⚠️ rewrote only one of them')
  assert.ok(!existsSync(join(home, '.nyan-remote', 'bin', 'claude')), '⚠️ placed only the shim')
})

test('★★ main(): does not install when there is no real claude', (t) => {
  const { home, run } = sandbox()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  rmSync(join(home, 'bin', 'claude'))
  const r = run()
  assert.notEqual(r.status, 0)
  assert.match(r.out, /claude が見つかりません/)
  assert.equal(readFileSync(join(home, '.bashrc'), 'utf8'), BASHRC, 'rewrote the rc')
})

test('★★ main(): does not install if the shim reports a different version than the real one (real-run gate)', (t) => {
  const { home, run } = sandbox()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  // ⚠️ A fake claude that returns a different version on every call = passes if the check compares "real vs real"
  writeFileSync(
    join(home, 'bin', 'claude'),
    '#!/bin/sh\necho "2.1.$(date +%N) (Fake)"\n',
  )
  chmodSync(join(home, 'bin', 'claude'), 0o755)
  const r = run()
  assert.notEqual(r.status, 0, 'installed despite mismatched versions')
  assert.match(r.out, /一致しません/)
  assert.equal(readFileSync(join(home, '.bashrc'), 'utf8'), BASHRC, 'rewrote the rc')
})

test('★ main(): bash can read the rc after installing (syntax not broken)', (t) => {
  const { home, run } = sandbox()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  assert.equal(run().status, 0)
  for (const f of ['.bashrc', '.profile']) {
    execFileSync('bash', ['-n', join(home, f)], { stdio: 'pipe' })
  }
  // ★ The shim comes first with **either file on its own** (actually sourced by bash).
  //   ⚠️ Checking only `.profile` is not enough: it takes the "present but not first" path (remove and prepend),
  //      so it **passes even if the `.bashrc` block appends to the end** (confirmed by mutation).
  const sourced = (file: string) =>
    execFileSync(
      'bash',
      ['-c', `HOME=${home}; PATH=/usr/bin:/bin; . ${join(home, file)}; printf %s "$PATH"`],
      { encoding: 'utf8' },
    )
  for (const file of ['.bashrc', '.profile']) {
    const out = sourced(file)
    assert.equal(out.split(':')[0], join(home, '.nyan-remote', 'bin'), `${file}: shim is not first: ${out}`)
  }
})

test('★★ main(): warns about invocations that bypass the shim by checking **both files**, even with `--dry-run` (Q4)', (t) => {
  const { home, run } = sandbox()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  // ⚠️⚠️ The warning only looked at `plans[0]` (= `.bashrc`), so **absolute-path invocations in
  //    `.profile` slipped through silently**. Install reports success but keystrokes do not work —
  //    exactly the symptom that burned 20 minutes on 2026-08-23.
  const offender = 'alias claude-old="$HOME/.local/bin/claude"'
  writeFileSync(join(home, '.profile'), `${PROFILE}${offender}\n`)

  // ⚠️ The check is "**one line shows both which file and the offending line**".
  //    ⚠️⚠️ At first `/絶対パス/` and `/\.profile/` were matched separately, but **both hit the
  //       shim's own comments and the `--- … .profile に足すもの ---` header and passed**
  //       (= a false green; not noticed until the check became an "observable difference")
  const warned = (out: string) =>
    out.split('\n').filter((l) => l.includes('.profile') && l.includes(offender))
  const HEAD = 'shim を通らない呼び方'

  // ★ Also shown with `--dry-run` (pointless unless noticed before installing)
  const dry = run('--dry-run')
  assert.equal(dry.status, 0, dry.out)
  assert.ok(dry.out.includes(HEAD), `no warning with --dry-run: ${dry.out}`)
  assert.equal(warned(dry.out).length, 1, `does not say which file and line: ${dry.out}`)

  const real = run()
  assert.equal(real.status, 0, real.out)
  assert.ok(real.out.includes(HEAD), `no warning on install: ${real.out}`)
  assert.equal(warned(real.out).length, 1, `install did not check .profile: ${real.out}`)

  // ★ **Not shown** when nothing matches (if it always shows, nobody reads it)
  const clean = sandbox()
  t.after(() => rmSync(clean.home, { recursive: true, force: true }))
  const quiet = clean.run()
  assert.equal(quiet.status, 0, quiet.out)
  assert.ok(!quiet.out.includes(HEAD), `warned although nothing matched: ${quiet.out}`)
})

test('★ main(): does not pile up backups (keeps the newest / R)', (t) => {
  const { home, run } = sandbox()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  // ⚠️ Repeating install/uninstall used to add a `.bashrc.nyan-remote-backup-<time>` every time
  for (let i = 0; i < 4; i++) {
    assert.equal(run().status, 0)
    assert.equal(run('--uninstall').status, 0)
  }
  const backups = readdirSync(home)
    .filter((f) => f.startsWith('.bashrc.nyan-remote-backup-'))
    .sort()
  assert.ok(backups.length <= 3, `piling up: ${backups.length}`)
  assert.ok(backups.length >= 1, '⚠️ must not delete them all (the recovery path would be lost)')
  // ★ Keep the **newest** (right before the last uninstall = the version with the block)
  const newest = readFileSync(join(home, backups[backups.length - 1] as string), 'utf8')
  assert.ok(newest.includes(BEGIN), `kept the older one: ${newest.slice(0, 80)}`)
})

// ⚠️ Needs a directory owned by someone else and not open to others (cannot be tested where none exists)
const otherOwned = (() => {
  try {
    const st = statSync('/root')
    return st.uid !== process.getuid?.() && !(st.mode & 0o022) ? '/root' : undefined
  } catch {
    return undefined
  }
})()

test(
  '★★ main(): refuses when the state dir is a symlink to someone else\'s directory (A7)',
  { skip: otherOwned ? false : 'no directory owned by another user found' },
  (t) => {
    const { home, run } = sandbox()
    t.after(() => rmSync(home, { recursive: true, force: true }))
    // ⚠️ The uid was read with `lstat` (the link itself), so **a symlink's uid is always "me"**,
    //    and a symlink to someone else's directory passed straight through (only to fail later with EACCES).
    symlinkSync(otherOwned as string, join(home, '.nyan-remote'))
    const r = run()
    assert.notEqual(r.status, 0, 'tried to install into someone else\'s directory')
    assert.match(r.out, /自分の所有ではありません/, `the check is not based on uid: ${r.out}`)
    assert.equal(readFileSync(join(home, '.bashrc'), 'utf8'), BASHRC, 'rewrote the rc')
  },
)

test('★★ main(): backup cleanup only touches names we created (A6)', (t) => {
  const { home, run } = sandbox()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  // ⚠️ Cleanup matched **only by prefix**, so a hand-made file sorting first alphabetically
  //    was deleted as "the oldest backup" (reproduced)
  const manual = join(home, '.bashrc.nyan-remote-backup-000-手で取った大事なもの')
  const note = join(home, '.bashrc.nyan-remote-backup-メモ.txt')
  writeFileSync(manual, 'たいせつ')
  writeFileSync(note, 'x')
  // ⚠️ Also leave a **symlink** that looks like our name alone (we always create via copyFile = regular file)
  const fake = join(home, '.bashrc.nyan-remote-backup-2000-01-01T00-00-00-000Z')
  symlinkSync(join(home, '.bashrc'), fake)

  for (let i = 0; i < 4; i++) {
    assert.equal(run().status, 0)
    assert.equal(run('--uninstall').status, 0)
  }
  assert.ok(existsSync(manual), '⚠️⚠️ deleted a hand-made backup')
  assert.equal(readFileSync(manual, 'utf8'), 'たいせつ')
  assert.ok(existsSync(note), '⚠️ deleted an unrelated file')
  assert.ok(lstatSync(fake).isSymbolicLink(), '⚠️ deleted the symlink')

  const iso = () =>
    readdirSync(home)
      .filter((f) => /^\.bashrc\.nyan-remote-backup-\d{4}-\d{2}-\d{2}T/.test(f))
      .sort()
  const before = iso()
  assert.equal(before.length, 4, `not exactly 4 entries with our name (3 + symlink): ${before.join(' ')}`)
  // ★ Creating one more removes **the oldest** and keeps the new one
  assert.equal(run().status, 0)
  const after = iso()
  assert.ok(!after.includes(before[1] as string), `kept the older one: ${after.join(' ')}`)
  assert.ok(after.length <= 4, `piling up: ${after.join(' ')}`)
})

test('★ main(): permissions of the state directory (R)', (t) => {
  const { home, run } = sandbox()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const stateDir = join(home, '.nyan-remote')
  // ⚠️ hookToken and the VAPID private key live here (the files are 0600, but
  //    with 0755 their names and sizes are visible to others). ⇒ Tighten it on install
  mkdirSync(stateDir, { recursive: true })
  chmodSync(stateDir, 0o755)
  assert.equal(run().status, 0)
  assert.equal(statSync(stateDir).mode & 0o777, 0o700, 'did not tighten the state directory')

  // ★★ **Refuse** if others can write it (bin could be swapped = the head of PATH hijacked)
  chmodSync(stateDir, 0o777)
  const bad = run()
  assert.notEqual(bad.status, 0, 'installed although others can write to it')
  assert.match(bad.out, /他人が書け|置き場にできません/, bad.out)
})

test('★★ main(): is not fooled by an inherited `_NYAN_REMOTE_SHIM` (A1)', (t) => {
  // ⚠️⚠️ **Running the installer inside a relayed session leaves this in the env** (measured).
  //    It used to be a boolean, so the re-entry guard misfired and **printed
  //    "✅ relay を通して claude が起動しました" although the relay never ran**.
  //    ⇒ Start the check's child "**the same way as a fresh terminal**" (do not carry our session's marker).
  //    ⚠️ It is now a counter guard, so only a value **above the limit** is observable
  //       (`1` would pass normally = a false green).
  const { home, run } = sandbox({ env: { _NYAN_REMOTE_SHIM: '99' } })
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const r = run()
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /relay を通して claude が起動しました/, `⚠️ the check carries the marker in:\n${r.out}`)
})

test('★★ main(): does not claim "went through the relay" without python3 (A1)', (t) => {
  const { home, run } = sandbox({ noPython: true })
  t.after(() => rmSync(home, { recursive: true, force: true }))
  // ⚠️⚠️ Measured (2026-08-23): installing with a PATH containing **no python3 at all** printed
  //    "✅ relay を通して claude が起動しました（打鍵の経路が生きています）".
  //    The relay did not run a single byte (the shim's `python3 -c ''` failed and it exec'd the plain claude).
  //    The cause was a **negative** check ("exec plainly" not printed & version included).
  //    ⇒ The symptom is "silently falls into the inbox" = **indistinguishable from the phone**.
  const r = run()
  assert.equal(r.status, 0, `plain startup works, so the install itself succeeds: ${r.out}`)
  assert.ok(
    !/relay を通して claude が起動しました/.test(r.out),
    `⚠️⚠️ said ✅ although the relay did not run:\n${r.out}`,
  )
  assert.match(r.out, /打鍵は使えません|relay を通せませんでした/, `no warning shown: ${r.out}`)
  // ★ Plain startup is not broken (the shim is placed)
  assert.ok(existsSync(join(home, '.nyan-remote', 'bin', 'claude')), 'shim was not placed')
})

test('★★ main(): does not install when the state dir path is invalid (B2)', (t) => {
  for (const [why, dir] of [
    ['contains a newline', '/tmp/x\nprintf 注入された\n#/s'],
    ['contains the PATH separator (:)', '/tmp/a:b/s'],
    ['not an absolute path', 'state'],
  ] as const) {
    const { home, run } = sandbox({ env: { NYAN_REMOTE_STATE_DIR: dir } })
    t.after(() => rmSync(home, { recursive: true, force: true }))
    // ⚠️⚠️ Newline: can **escape the block's comment line and embed commands in the rc** (it actually ran)
    // ⚠️ `:`: the shim can be placed, but PATH splits it in two and it is **never reached** (silently falls into the inbox)
    // ⚠️ Relative: works in the window used to install, but **points elsewhere in a terminal opened in another directory**
    const r = run()
    assert.notEqual(r.status, 0, `${why}: accepted`)
    assert.match(r.out, /置き場|使えません/, `${why}: no reason shown: ${r.out}`)
    assert.equal(readFileSync(join(home, '.bashrc'), 'utf8'), BASHRC, `${why}: rewrote the rc`)
  }
})

test('★★ main(): the relay check works even when the state dir path has a space (B2)', (t) => {
  const { home, run } = sandbox({ stateDirUnder: 'あ い' })
  t.after(() => rmSync(home, { recursive: true, force: true }))
  // ⚠️ The check is **a single string** `script -qec "<shim> --version"`, so
  //    a path with a space **split the command and always gave a false negative** (measured)
  const r = run()
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /relay を通して claude が起動しました/, `split at the space:\n${r.out}`)
})

test('★★ main(): rejects unknown arguments (Q3)', (t) => {
  const { home, run } = sandbox()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const untouched = () => {
    assert.equal(readFileSync(join(home, '.bashrc'), 'utf8'), BASHRC, 'rewrote the rc')
    assert.ok(!existsSync(join(home, '.nyan-remote', 'bin', 'claude')), 'placed the shim')
  }
  // ⚠️⚠️ Unknown arguments used to be silently ignored, so **a one-character typo like `--dry-runn`
  //    turned "not going to write" into a real install** (`args.includes('--dry-run')` is false).
  for (const bad of ['--dry-runn', '--DRY-RUN', '-dry-run', 'dry-run', '--uninstal']) {
    const r = run(bad)
    assert.notEqual(r.status, 0, `accepted ${bad}`)
    assert.match(r.out, /知らない引数/, r.out)
    assert.match(r.out, new RegExp(bad.replace(/[-]/g, '\\-')), `does not say which argument is wrong: ${r.out}`)
    untouched()
  }
  // ★ Valid combinations pass (and write nothing)
  const dryOff = run('--dry-run', '--uninstall')
  assert.equal(dryOff.status, 0, dryOff.out)
  untouched()
  const help = run('--help')
  assert.equal(help.status, 0, help.out)
  assert.match(help.out, /--dry-run/, help.out)
  untouched()
})

test('★★ main(): even with two blocks in the rc, none remain after uninstall (Q1)', (t) => {
  const { home, run } = sandbox()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  // ⚠️ **Correction (2026-08-23 / codex finding)**: this used to say "`command -v claude` may point at a removed path",
  //    which was **wrong**. `command -v` skips directories without an executable `claude`.
  //    ⇒ The real harm is that "**`--uninstall` does not remove everything**" (the removed path stays
  //      at the head of PATH). ★ **Doubt the "harm" you wrote yourself** (CLAUDE.md §2).
  assert.equal(run().status, 0)
  const bashrc = join(home, '.bashrc')
  const installed = readFileSync(bashrc, 'utf8')
  const dupBlock = installed.slice(installed.indexOf(BEGIN), installed.indexOf(END) + END.length)
  writeFileSync(bashrc, `${installed}\n${dupBlock}\n`)
  assert.equal(count(readFileSync(bashrc, 'utf8'), BEGIN), 2, 'precondition: two blocks')

  // Reinstalling collapses them into one
  const again = run()
  assert.equal(again.status, 0, again.out)
  assert.equal(count(readFileSync(bashrc, 'utf8'), BEGIN), 1, 'install did not collapse them into one')

  // ★ Uninstalling directly from the two-block state leaves none
  writeFileSync(bashrc, `${installed}\n${dupBlock}\n`)
  const off = run('--uninstall')
  assert.equal(off.status, 0, off.out)
  const left = readFileSync(bashrc, 'utf8')
  assert.equal(count(left, BEGIN), 0, `⚠️ a block remains after uninstall:\n${left}`)
  assert.equal(left, BASHRC, 'not restored')
  // ⚠️ **Actually source it with bash** and check the removed shim is not on PATH
  const path = execFileSync(
    'bash',
    ['-c', `HOME=${home}; PATH=/usr/bin:/bin; . ${bashrc}; printf %s "$PATH"`],
    { encoding: 'utf8' },
  )
  assert.ok(!path.includes('.nyan-remote'), `the removed shim is still on PATH: ${path}`)
})

test('★★ main(): if the second rc fails the syntax check, the first is not rewritten either (two-stage gate)', (t) => {
  const { home, run } = sandbox()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  // ⚠️ The user's `.profile` already has a syntax error (= only the second one fails).
  //    It used to "verify one file and writeFile immediately", so it printed "nothing changed"
  //    **with only `.bashrc` rewritten** (see the two-stage comment in install-relay.mjs).
  const brokenProfile = `${PROFILE}if true; then\n`
  writeFileSync(join(home, '.profile'), brokenProfile)
  const r = run()
  assert.notEqual(r.status, 0, 'finished successfully despite the syntax check failing')
  assert.match(r.out, /何も変えていません/, r.out)
  assert.equal(readFileSync(join(home, '.bashrc'), 'utf8'), BASHRC, '⚠️ only the first one was rewritten')
  assert.equal(readFileSync(join(home, '.profile'), 'utf8'), brokenProfile, 'rewrote .profile')
  // ⚠️ Leave no half-written temp files (the next install would fail on `wx`)
  const left = readdirSync(home).filter((f) => f.includes('nyan-remote-new-'))
  assert.deepEqual(left, [], `temp files left behind: ${left.join(' ')}`)
  // ★★ **The shim is not placed either** (A3). ⚠️ It used to install for real **before** the rc syntax check, so
  //    `~/.nyan-remote/bin/claude` remained while it said "nothing changed" (= a lie)
  assert.ok(!existsSync(join(home, '.nyan-remote', 'bin', 'claude')), '⚠️ placed only the shim')
  assert.deepEqual(
    readdirSync(join(home, '.nyan-remote', 'bin')).filter((f) => f.includes('.new-')),
    [],
    'temp shim left behind',
  )
})

test('★★ main(): if --uninstall cannot write the second rc, the first is not changed either (A2)', (t) => {
  const { home, run } = sandbox()
  // ⚠️ Cleanup: "make writable, then delete" (the wrong order makes rmSync hit EACCES)
  t.after(() => {
    try {
      chmodSync(join(home, 'ro'), 0o700)
    } catch {}
    rmSync(home, { recursive: true, force: true })
  })
  // ⚠️⚠️ Unlike install, uninstall used to **truncate/write the rc directly** (asymmetric).
  //    ⇒ Failing on the second left a **"half uninstalled" state with only the first removed**,
  //      and it crashed with a Node stack trace.
  // ★ How the failure is made: make `.profile` a symlink to a file inside **a non-writable directory**
  //   (as when dotfiles live somewhere read-only).
  const ro = join(home, 'ro')
  mkdirSync(ro)
  assert.equal(run().status, 0)
  const withBlock = readFileSync(join(home, '.profile'), 'utf8')
  writeFileSync(join(ro, 'profile'), withBlock)
  rmSync(join(home, '.profile'))
  symlinkSync(join(ro, 'profile'), join(home, '.profile'))
  const bashrcBefore = readFileSync(join(home, '.bashrc'), 'utf8')
  chmodSync(ro, 0o500) // not writable

  const off = run('--uninstall')
  assert.notEqual(off.status, 0, 'finished successfully although it cannot write')
  assert.equal(readFileSync(join(home, '.bashrc'), 'utf8'), bashrcBefore, '⚠️ only the first one was removed')
  assert.ok(readFileSync(join(ro, 'profile'), 'utf8').includes(BEGIN), 'the second one changed')
  assert.deepEqual(
    readdirSync(home).filter((f) => f.includes('nyan-remote-new-')),
    [],
    'temp files left behind',
  )
})

test('★★ main(): rolls back when replacement fails midway (B3)', (t) => {
  const { home, run } = sandbox()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  // ⚠️⚠️ A failure midway through the replacement (rename) **cannot be produced from outside**
  //    (if a tmp file could be created in the directory, rename works too). ⇒ Use **a test-only injection point**.
  //    It can really happen with e.g. "a symlink to another user's file in a sticky directory" (review B3).
  const r = run()
  assert.equal(r.status, 0, r.out)
  assert.equal(run('--uninstall').status, 0)

  // Make the second replacement (index 1) fail
  const bashrcBefore = readFileSync(join(home, '.bashrc'), 'utf8')
  const profileBefore = readFileSync(join(home, '.profile'), 'utf8')
  const failed = runWith(home, { NYAN_REMOTE_TEST_FAIL_COMMIT: '1' })
  assert.notEqual(failed.status, 0, 'finished successfully although it was made to fail')
  assert.match(failed.out, /元に戻しました|戻せませんでした/, `does not say what it did: ${failed.out}`)
  // ★ The first one is **restored** (never leave a half-installed state)
  assert.equal(readFileSync(join(home, '.bashrc'), 'utf8'), bashrcBefore, '⚠️ the first one was not restored')
  assert.equal(readFileSync(join(home, '.profile'), 'utf8'), profileBefore, 'the second one changed')
  // ★ Do not place the shim either (never a shim without the rc block)
  assert.ok(!existsSync(join(home, '.nyan-remote', 'bin', 'claude')), '⚠️ placed only the shim')
  assert.deepEqual(
    readdirSync(home).filter((f) => f.includes('nyan-remote-new-')),
    [],
    'temp files left behind',
  )
})

test('★★ main(): rollback does not delete an rc that was empty (B6)', (t) => {
  const { home, run } = sandbox()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  // ⚠️ `before` (the contents) was **also used as an existence flag**, so a **0-byte file**
  //    was judged "absent", no backup was taken, and the rollback **deleted it**
  writeFileSync(join(home, '.bashrc'), '')
  const r = runWith(home, { NYAN_REMOTE_TEST_FAIL_COMMIT: '1' })
  assert.notEqual(r.status, 0)
  assert.ok(existsSync(join(home, '.bashrc')), '⚠️⚠️ deleted an rc that was empty')
  assert.equal(readFileSync(join(home, '.bashrc'), 'utf8'), '', 'not restored to empty')
})

test('★★ main(): does not delete the backup needed for rollback first (B6)', (t) => {
  const { home, run } = sandbox()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  // ⚠️ Cleanup (keep only the newest 3) ran **in the middle of commit**, so with three
  //    future-dated backups **the backup just created was deleted as "the oldest"**,
  //    and the rollback failed with ENOENT (same if the clock goes backwards)
  for (const ms of ['000', '001', '002']) {
    writeFileSync(join(home, `.bashrc.nyan-remote-backup-2099-01-01T00-00-00-${ms}Z`), 'x')
  }
  const before = readFileSync(join(home, '.bashrc'), 'utf8')
  const r = runWith(home, { NYAN_REMOTE_TEST_FAIL_COMMIT: '1' })
  assert.notEqual(r.status, 0)
  assert.match(r.out, /元に戻しました/, `did not roll back: ${r.out}`)
  assert.doesNotMatch(r.out, /戻せませんでした/, r.out)
  assert.equal(readFileSync(join(home, '.bashrc'), 'utf8'), before, '⚠️ not restored')
})

test('★★ main(): does not crash silently when the shim cannot be placed (B6)', (t) => {
  const { home, run } = sandbox()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  // ⚠️ `rename(tmpShim, shimPath)` after replacing the rc was outside the try, so failing there
  //    **crashed with a stack trace** and left "only the rc changed"
  mkdirSync(join(home, '.nyan-remote', 'bin', 'claude'), { recursive: true }) // the shim's path is a directory
  const r = run()
  assert.notEqual(r.status, 0, 'finished successfully although it failed')
  assert.ok(!/at .*install-relay\.mjs/.test(r.out), `a stack trace was printed:\n${r.out}`)
  assert.match(r.out, /shim を置けませんでした/, `no reason shown: ${r.out}`)
  // ★ **Say** that the rc block is in place (= plain claude starts normally)
  assert.match(r.out, /rc|ブロック/, `does not report the rc state: ${r.out}`)
  assert.deepEqual(
    readdirSync(join(home, '.nyan-remote', 'bin')).filter((f) => f.includes('.new-')),
    [],
    'temp shim left behind',
  )
})

test('★★ main(): only deletes a shim we wrote ourselves (A2)', (t) => {
  const { home, run } = sandbox()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const binDir = join(home, '.nyan-remote', 'bin')
  const shim = join(binDir, 'claude')
  // ⚠️ When someone else's file sits at the same place (e.g. `bin` is a symlink to a shared directory),
  //    `--uninstall` **deleted an unrelated claude**
  mkdirSync(binDir, { recursive: true })
  writeFileSync(shim, '#!/bin/sh\necho 私は nyan-remote とは無関係\n')
  chmodSync(shim, 0o755)
  const off = run('--uninstall')
  assert.equal(off.status, 0, off.out)
  assert.ok(existsSync(shim), '⚠️⚠️ deleted a file we did not write')
  assert.match(off.out, /消していません|自分が置いたもの/, `no reason shown: ${off.out}`)

  // ★ Delete it if we wrote it
  assert.equal(run().status, 0)
  assert.ok(existsSync(shim))
  assert.equal(run('--uninstall').status, 0)
  assert.ok(!existsSync(shim), 'did not delete our own shim')
})

test('★★ main(): does not break when both rc files are the same file (A4)', (t) => {
  const { home, run } = sandbox()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  // ⚠️ A dotfiles setup where `.profile` is a symlink to `.bashrc`. Measured:
  //    **both temp file paths were identical**, and it exited 1 with a Node stack trace
  //    (it looks "failed" although it is actually installed)
  rmSync(join(home, '.profile'))
  symlinkSync(join(home, '.bashrc'), join(home, '.profile'))
  const r = run()
  assert.equal(r.status, 0, r.out)
  assert.ok(!/at .*install-relay\.mjs/.test(r.out), `a stack trace was printed:\n${r.out}`)
  const body = readFileSync(join(home, '.bashrc'), 'utf8')
  assert.equal(count(body, BEGIN), 1, `not exactly one block:\n${body}`)
  // ⚠️ Same file, so only one backup
  const backups = readdirSync(home).filter((f) => f.includes('.nyan-remote-backup-'))
  assert.equal(backups.length, 1, `extra backups were created: ${backups.join(' ')}`)
  // Uninstalling restores it
  assert.equal(run('--uninstall').status, 0)
  assert.equal(readFileSync(join(home, '.bashrc'), 'utf8'), BASHRC)
})

test('★★ main(): does not overwrite a dangling-symlink rc with a regular file (B4)', (t) => {
  const { home, run } = sandbox()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  // ⚠️ **Symlinks whose target does not exist yet** are common (e.g. before cloning dotfiles).
  //    `readFile`'s ENOENT used to be treated as "no rc", and `existsSync` is false too, so
  //    **the symlink itself was replaced by a regular file** (the link is lost)
  mkdirSync(join(home, 'dotfiles'))
  rmSync(join(home, '.profile'))
  symlinkSync(join(home, 'dotfiles', 'profile'), join(home, '.profile'))
  const r = run()
  assert.equal(r.status, 0, r.out)
  assert.ok(lstatSync(join(home, '.profile')).isSymbolicLink(), '⚠️ clobbered the symlink')
  assert.ok(existsSync(join(home, 'dotfiles', 'profile')), 'did not write to the link target')
  assert.ok(readFileSync(join(home, 'dotfiles', 'profile'), 'utf8').includes(BEGIN))
})

test('★★ main(): "the marker is present" is not enough to identify our shim (B5)', (t) => {
  const { home, run } = sandbox()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const binDir = join(home, '.nyan-remote', 'bin')
  mkdirSync(binDir, { recursive: true })
  const shim = join(binDir, 'claude')
  // ⚠️ A file for another purpose was deleted just because it **mentioned the marker string in a comment**
  writeFileSync(
    shim,
    ['#!/usr/bin/env node', '// 参考: # nyan-remote: 打鍵で渡す経路 と同じ仕組み', 'console.log(1)'].join('\n'),
  )
  chmodSync(shim, 0o755)
  const off = run('--uninstall')
  assert.equal(off.status, 0, off.out)
  assert.ok(existsSync(shim), '⚠️⚠️ deleted a file we did not write')
  assert.match(off.out, /消していません/, off.out)
})

test('★★ main(): files that are not ours do not use up the cleanup slots (B5)', (t) => {
  const { home, run } = sandbox()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  // ⚠️ A **future-dated symlink** shaped like our name took one of the "newest 3" slots,
  //    so only 2 real backups remained
  symlinkSync(join(home, '.bashrc'), join(home, '.bashrc.nyan-remote-backup-9999-12-31T23-59-59-999Z'))
  for (let i = 0; i < 4; i++) {
    assert.equal(run().status, 0)
    assert.equal(run('--uninstall').status, 0)
  }
  const real = readdirSync(home).filter(
    (f) => /^\.bashrc\.nyan-remote-backup-\d{4}-/.test(f) && lstatSync(join(home, f)).isFile(),
  )
  assert.equal(real.length, 3, `not exactly 3 real backups: ${real.length}`)
})

test('★★ main(): tightens the state dir when it is a symlink to our own 0755 directory (B5)', (t) => {
  const { home, run } = sandbox()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  // ⚠️ chmod was skipped for symlinks, so **the target stayed 0755**
  //    (fine to tighten if we own it; someone else's is refused by the uid check)
  const real = join(home, 'shared-state')
  mkdirSync(real)
  chmodSync(real, 0o755)
  symlinkSync(real, join(home, '.nyan-remote'))
  const r = run()
  assert.equal(r.status, 0, r.out)
  assert.equal(statSync(real).mode & 0o777, 0o700, 'did not tighten the link target')
  assert.ok(lstatSync(join(home, '.nyan-remote')).isSymbolicLink(), 'clobbered the symlink')
})

test('★★ main(): does not claim "the keystroke path is alive" when no registration is left (B5)', (t) => {
  const { home, run } = sandbox()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  // ⚠️ Even if the relay starts, **the agent cannot find it** unless it registers in `panes/`
  //    = keystrokes do not work. ⇒ "It started" alone is no ground for ✅.
  //    ★ Make `panes` a regular file so registration fails
  const stateDir = join(home, '.nyan-remote')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(stateDir, 'panes'), 'これはファイル')
  const r = run()
  assert.equal(r.status, 0, `plain startup works, so the install succeeds: ${r.out}`)
  assert.ok(!/打鍵の経路が生きています/.test(r.out), `⚠️ said ✅ although it could not register:\n${r.out}`)
  assert.match(r.out, /名乗/, `no reason shown: ${r.out}`)
})

test('★★ main(): writes only once when both rc files are hard links (B4)', (t) => {
  const { home, run } = sandbox()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  // ⚠️ `realpathSync` **cannot detect hard links** (it returns different path strings), so
  //    both were renamed from separate temp files and **the hard link was broken**
  rmSync(join(home, '.profile'))
  linkSync(join(home, '.bashrc'), join(home, '.profile'))
  const before = statSync(join(home, '.bashrc')).ino
  const r = run()
  assert.equal(r.status, 0, r.out)
  const a = statSync(join(home, '.bashrc'))
  const b = statSync(join(home, '.profile'))
  assert.equal(a.ino, b.ino, '⚠️ the hard link was broken')
  assert.notEqual(a.ino, before, 'not replaced at all')
  // ★★ Check **both contain it** (checking only the link lets a skipped side pass with old contents)
  for (const f of ['.bashrc', '.profile']) {
    const body = readFileSync(join(home, f), 'utf8')
    assert.equal(count(body, BEGIN), 1, `${f}: not exactly one block`)
  }
  // Uninstalling removes it from both and keeps the link
  assert.equal(run('--uninstall').status, 0)
  for (const f of ['.bashrc', '.profile']) {
    assert.equal(readFileSync(join(home, f), 'utf8'), BASHRC, `${f}: not restored`)
  }
  assert.equal(statSync(join(home, '.bashrc')).ino, statSync(join(home, '.profile')).ino, 'the link was broken')
})

test('★★ main(): rc permissions are not reduced by umask (A5)', (t) => {
  const { home, run } = sandbox()
  const prev = process.umask(0o077)
  t.after(() => {
    process.umask(prev)
    rmSync(home, { recursive: true, force: true })
  })
  // ⚠️ The mode of `writeFile(…, { mode })` is **reduced by umask** (measured: umask 077 + 0644 → 0600).
  //    ⇒ Replacing the rc **changes the user's permissions** (real harm with shared dotfiles)
  chmodSync(join(home, '.bashrc'), 0o644)
  assert.equal(run().status, 0)
  assert.equal(statSync(join(home, '.bashrc')).mode & 0o777, 0o644, 'install changed the permissions')
  assert.equal(run('--uninstall').status, 0)
  assert.equal(statSync(join(home, '.bashrc')).mode & 0o777, 0o644, 'uninstall changed the permissions')
})
