// Relay fail-open and cleanup (`scripts/relay.py`).
//
// ★★ What is protected here is **just one thing**: **the user can start claude**.
//
// ⚠️⚠️ In the 2026-08-23 review this was **broken in three ways** (all reproduced by measurement):
//   - computing `sock_path` was outside the try → a broken `XDG_RUNTIME_DIR` alone
//     gave a traceback, and **even `NYAN_REMOTE_NO_RELAY=1` did not save it**
//   - parsing `RELAY_MAX_BUF` came **after** the fork → an exception after starting the child (the registration remained)
//   - `SIGTERM` / `SIGHUP` were not caught → **the terminal was returned to the user's shell still in raw mode**
//
// ⚠️ The tests in this file need a pty (`script`). Without a tty, `-t 0` passes straight through first, so
//    **none of the setup branches is reached** (lesson from creating three "false greens" that same day).

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const RELAY = join(import.meta.dirname, '..', '..', 'scripts', 'relay.py')
const hasScript = spawnSync('script', ['--version']).status === 0
const hasPython = spawnSync('python3', ['-c', 'pass']).status === 0
const skip = !hasScript || !hasPython

/** Runs a one-line command inside a pty and returns everything it printed */
function inPty(cmd: string, env: Record<string, string> = {}): string {
  const r = spawnSync('script', ['-qec', cmd, '/dev/null'], {
    encoding: 'utf8',
    timeout: 30_000,
    // ★ The relay's log lines are asserted in Japanese (pin the language)
    env: { ...process.env, NYAN_LANG: 'ja', ...env },
  })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`
}

test('★★★ non-interactive + escape hatch: starts plainly even if XDG_RUNTIME_DIR is broken', { skip: !hasPython }, () => {
  // ⚠️ it used to give a traceback here, and **claude did not start even with the escape hatch set**
  const out = execFileSync('python3', [RELAY, '--', 'echo', 'PLAIN-OK'], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, XDG_RUNTIME_DIR: '/proc/self/nope', NYAN_REMOTE_NO_RELAY: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  assert.match(out, /PLAIN-OK/)
})

test('★★★ with a pty: starts plainly if the keystroke location cannot be prepared (does not block startup)', { skip }, () => {
  const out = inPty(`python3 ${RELAY} -- echo TTY-OK`, {
    XDG_RUNTIME_DIR: '/proc/self/nope',
    RELAY_DEBUG: '1',
  })
  assert.match(out, /TTY-OK/, `claude did not start: ${out}`)
  assert.match(out, /素で exec する/, 'no record of falling back to plain exec')
})

test('★★★ with a pty: starts plainly even if RELAY_MAX_BUF is not a number (decided before starting the child)', { skip }, () => {
  // ⚠️ it used to be parsed **after** `pty.fork()` and `register()`, so
  //    the exception skipped `finally` and **the registration and socket remained**
  const dir = mkdtempSync(join(tmpdir(), 'nyan-remote-badbuf-'))
  const out = inPty(`python3 ${RELAY} -- echo BUF-OK`, {
    RELAY_MAX_BUF: 'abc',
    RELAY_DEBUG: '1',
    NYAN_REMOTE_STATE_DIR: dir,
  })
  assert.match(out, /BUF-OK/, `claude did not start: ${out}`)
  assert.match(out, /素で exec する/)
  // no registration remains (not even the directory is created)
  const panes = spawnSync('ls', [join(dir, 'panes')], { encoding: 'utf8' })
  assert.notEqual(panes.status, 0, `a registration remains: ${panes.stdout}`)
})

test('★★★ the loop-guard marker is **kept** for the child (removing it brings back infinite loops / B1)', { skip }, () => {
  // ⚠️⚠️ on 2026-08-23 it was removed here (the boolean guard **misfired inside relayed sessions**,
  //    so claude started from there silently left the relay).
  //    ⇒ **removing it brings back infinite loops** (each stage shim → relay → another wrapper → shim
  //      looks like "the first time" and never hits the limit; measured: 9 of 12 combinations looped forever).
  // ⇒ the shim side became a **count**, so there is no need to remove it. **Never remove it here.**
  //    (with a count, claude inside a relayed session does not hit the limit either and properly goes through the relay)
  const out = inPty(`python3 ${RELAY} -- sh -c 'echo SHIM=[\${_NYAN_REMOTE_SHIM:-なし}]'`, {
    _NYAN_REMOTE_SHIM: '3',
  })
  assert.match(out, /SHIM=\[3\]/, `⚠️⚠️ the marker disappeared in the child (loops would not stop): ${out}`)
})

test('★★★ SIGTERM always restores the terminal (never returns it in raw mode)', { skip }, () => {
  // ⚠️⚠️ exactly the state CLAUDE.md describes as "leaking it returns the user's shell broken".
  //    ★ judged by measuring `stty` (look at the terminal's state, not the implementation's comments)
  const dir = mkdtempSync(join(tmpdir(), 'nyan-remote-sig-'))
  const pidFile = join(dir, 'child.pid')
  const runner = join(dir, 'run.sh')
  writeFileSync(
    runner,
    `#!/bin/bash
probe() { stty -a 2>/dev/null | tr ' ;' '\\n\\n' | grep -qx -- "-echo" && echo "raw" || echo "cooked"; }
echo "mae=$(probe)"
(
  for _ in $(seq 1 60); do [ -s "${pidFile}" ] && break; sleep 0.1; done
  sleep 0.3
  kill -TERM "$(cat "${pidFile}")" 2>/dev/null
) &
python3 ${RELAY} -- bash -c "echo \\$PPID > '${pidFile}'; sleep 30"
echo "code=$?"
wait
echo "ato=$(probe)"
`,
  )
  chmodSync(runner, 0o755)
  const out = inPty(runner, { NYAN_REMOTE_STATE_DIR: dir }).replace(/\r/g, '')
  assert.match(out, /mae=cooked/, `premise broken (raw from the start): ${out}`)
  assert.match(out, /ato=cooked/, `⚠️⚠️ the terminal was returned in raw mode: ${out}`)
  assert.match(out, /code=143/, `the SIGTERM exit code was not propagated: ${out}`)
})

test('★★ `-p` passes straight through even when relay.py is called directly', { skip }, () => {
  const withP = inPty(`python3 ${RELAY} -- echo -p X`, { RELAY_DEBUG: '1' })
  const without = inPty(`python3 ${RELAY} -- echo X`, { RELAY_DEBUG: '1' })
  assert.match(withP, /素で exec する/, '`-p` goes through the pty (the output shape changes)')
  assert.doesNotMatch(without, /素で exec する/, 'passes straight through without `-p`')
})

test('★★ a keystroke location open to others is not used (keystrokes given up, startup not blocked)', { skip }, () => {
  // ⚠️ `/tmp` is writable by anyone, so **a directory already placed there is not used without verification**
  const base = mkdtempSync(join(tmpdir(), 'nyan-remote-open-'))
  const euid = process.getuid?.() ?? 0
  const victim = join(base, `nyan-remote-${euid}`)
  execFileSync('mkdir', ['-m', '0777', victim])
  const out = inPty(`python3 ${RELAY} -- echo OPEN-OK`, {
    XDG_RUNTIME_DIR: base,
    RELAY_DEBUG: '1',
  })
  assert.match(out, /OPEN-OK/, `claude did not start: ${out}`)
  assert.match(out, /素で exec する/, 'uses a location open to others as is')
  // ⚠️ permissions were not rewritten (chmod used to hit the link target)
  const mode = execFileSync('stat', ['-c', '%a', victim], { encoding: 'utf8' }).trim()
  assert.equal(mode, '777', `changed the permissions of someone else's directory: ${mode}`)
})

test('★★★ Ctrl-Z is not passed to the child (over the relay the window gets stuck)', { skip: !hasPython }, (t) => {
  // ⚠️⚠️ **found in practice** on 2026-08-23. Claude Code stops itself on Ctrl-Z, but
  //    over the relay **the relay stays in the foreground**, so `fg` cannot be typed and the window gets stuck.
  //    ⇒ 0x1a is dropped and made a no-op (⚠️ termios is not touched).
  // ★ `script` cannot take input from the side, so **create the pty ourselves** and type into it.
  // ⚠️ write not a single backslash in the generated Python (escaping broke it once)
  const dir = mkdtempSync(join(tmpdir(), 'nyan-remote-ctrlz-'))
  const driver = join(dir, 'drive.py')
  writeFileSync(
    driver,
    [
      'import os, pty, select, subprocess, sys, time',
      'master, slave = pty.openpty()',
      "p = subprocess.Popen([sys.executable, sys.argv[1], '--', 'cat'], stdin=slave, stdout=slave,",
      '                     stderr=subprocess.DEVNULL, env=dict(os.environ))',
      'os.close(slave)',
      'time.sleep(0.8)',
      'os.write(master, bytes([0x1a]) + b"AB" + bytes([0x0d]))',
      'time.sleep(0.8)',
      'out = b""',
      'while select.select([master], [], [], 0.3)[0]:',
      '    try:',
      '        chunk = os.read(master, 4096)',
      '    except OSError:',
      '        break',
      '    if not chunk:',
      '        break',
      '    out += chunk',
      'p.terminate()',
      'try:',
      '    p.wait(timeout=5)',
      'except Exception:',
      '    p.kill()',
      'sys.stdout.write(repr(out))',
    ].join('\n'),
  )
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const seen = spawnSync('python3', [driver, RELAY], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, NYAN_REMOTE_STATE_DIR: dir },
  })
  const out = seen.stdout ?? ''
  assert.ok(out.includes('AB'), `typed characters did not reach the child: ${out}`)
  // ⚠️⚠️ **two** false greens were made here (2026-08-23). Checks that cannot tell the difference:
  //    - "0x1a is not in the output" … the child's tty **consumes it as a signal character**, so
  //      it does not appear in the output even if passed
  //    - "the child stopped" … the relay's pty is **a separate session**, so the child's process group
  //      is **orphaned**, and by POSIX **stop signals are discarded** (measured: both in state S).
  //      ⇒ even if claude shows "suspended", **it does not actually stop** (the window does not get stuck)
  // ⇒ the only distinguishing sign is **the `^Z` echo** (the child's tty showing the control character).
  assert.ok(!out.includes('^Z'), `⚠️ Ctrl-Z reaches the child's pty: ${out}`)
})
