// ★★ Invariants of `install.sh` (2026-09-20 / distribution for ③).
//
// ⚠️⚠️ **This is the only shell script that runs on users' machines**, yet
//   ordinary tests never run a single line of it (the same hole as `relay/src/worker.ts`).
//   ⇒ **If it breaks, someone's machine breaks**, so at least **check the rules by machine**.
//
// ★ Mutations this hits:
//   ① keeps going when broken (removing `set -euo pipefail`)
//   ② asks for `sudo`
//   ③ installs without checking the old (pre-rename) state = **subscriptions and pairings are lost irrecoverably**
//   ④ silently overwrites an existing install
//   ⑤ installs the hooks without waiting for the agent to start (a race; hit in practice)
//   ⑥ half-installs on an unsupported OS
//   ㉒ does not pass node's absolute path to the mac service (launchd's PATH has no Homebrew)
//   ㉓ before an update, stops with a tool that does not match the service type
//   ⑦ writes a unit whose service gives up (where `StartLimitIntervalSec` goes)
//   ⑧ updates without confirming "is this a nyan-remote install" (breaks another directory)
//   ⑨ deletes the old tree on update (no way back)
//   ⑩ ⚠️⚠️ deletes the state directory (**irrecoverable**)
//   ⑫ places notify.sh after wiring (= not wired, no notifications at all)
//   ⑬ does not write the state directory into the unit (the checked location and the running one differ / codex medium #2)
//   ⑭ allows the state directory under the tree (moved away with the update / codex medium #3)
//   ⑯ ⚠️⚠️ the fetch origin disagrees with `shared/distribution.ts` (the 2026-09-21 move to our own domain)
//   ⑰ ⚠️⚠️ full-width characters right after `$VAR` (**actually stopped** on mac's bash 3.2)
// ★ ⑪⑮ (second-machine VAPID instructions, the private key temp file) **were retired on 2026-09-21**
//   (subscriptions are split into a scope per agent, so the step of copying keys by hand disappeared)

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { DISTRIBUTION_ORIGIN } from '../shared/distribution.ts'

const SH = readFileSync(new URL('../install.sh', import.meta.url), 'utf8')

/**
 * ★★ **Look only at "lines that execute"** (hit this **for the 5th time** on 2026-09-20).
 *
 * ⚠️⚠️ This file explains things at length in comments, so **mutations hit the comments and
 *    slip through** (even removing `legacyStateProblem()` entirely stayed green because the comment just before it
 *    had the same text). ⇒ **Strip comments before matching.**
 * ⚠️ Position-based checks (ordering) must also use indexes into `CODE` (`SH` would pick up comment positions).
 */
const CODE = SH.split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n')

test('★★ stops when broken (① lesson of 2026-09-19)', () => {
  // ⚠️⚠️ When steps were handed over as a list, one broken line was silently skipped and "it looked like it succeeded".
  assert.match(CODE, /^set -euo pipefail$/m, '⚠️⚠️ it keeps going on failure')
})

test('★★ never asks for `sudo` (②)', () => {
  // ⚠️ Everything goes under ~/ (systemd with --user). ⇒ Needing no admin rights is itself a promise.
  const lines = SH.split('\n').filter((l) => /\bsudo\b/.test(l) && !l.trim().startsWith('#'))
  assert.deepEqual(lines, [], '⚠️⚠️ uses sudo')
  assert.match(CODE, /systemctl --user/, 'does not use systemd with --user')
})

test('★★ stops if pre-rename state remains (③ never create something irrecoverable)', () => {
  // ⚠️⚠️ Creating new state without checking the old one **recreates and irrecoverably loses**
  //    `vapid.json` (subscriptions) and `device-key.json` (pairings) (CLAUDE.md §0).
  //
  // ★★ **Do not copy the old name here** (2026-09-20). The check calls the same
  //   `legacyStateProblem()` as the agent = one place to fix.
  //   ⚠️⚠️ Copying it would **add a range outside** the `rename.test.ts` guard (a hiding place).
  assert.match(CODE, /legacyStateProblem\(\)/, '⚠️⚠️ does not check the old state')
  // ⚠️ Check **before installing** (stopping after installing leaves a half install and blocks retrying)
  const at = {
    check: CODE.indexOf('legacyStateProblem()'),
    install: CODE.indexOf('mv "$TMP/nyan-remote" "$HOME_DIR"'),
  }
  assert.ok(at.install >= 0, 'does not place what was extracted')
  assert.ok(at.check < at.install, '⚠️⚠️ checks the old state after installing (half-installed)')
})

test('★★ never silently overwrites an existing install (④ requires an explicit signal)', () => {
  // ⚠️⚠️ An update path was added (2026-09-21), but **it must never overwrite silently**.
  //    It requires `NYAN_REMOTE_UPDATE=1` = never delete an existing install by accident.
  assert.match(CODE, /\[ -e "\$HOME_DIR" \]/, '⚠️⚠️ does not check for an existing install')
  assert.match(CODE, /NYAN_REMOTE_UPDATE:-.*= *"1"/, '⚠️⚠️ overwrites without an explicit signal')
  assert.match(CODE, /die "\$\(tr2 "\$HOME_DIR が既に在ります/, 'does not stop without the signal')
})

test('★★ an update confirms "it is a nyan-remote install" before touching it (⑧)', () => {
  // ⚠️⚠️ Never break **some other directory** of someone who mistyped `NYAN_REMOTE_HOME`
  assert.match(CODE, /\$HOME_DIR\/RELEASE/, '⚠️⚠️ replaces without checking the contents')
  assert.match(CODE, /\$HOME_DIR\/agent\/src\/index\.ts/, 'same as above (one check alone is thin)')
})

test('★★ an update never deletes the old tree (⑨ keep a way back)', () => {
  assert.match(CODE, /mv "\$HOME_DIR" "\$OLD"/, '⚠️⚠️ does not move the old tree aside')
  assert.doesNotMatch(CODE, /rm -rf "\$HOME_DIR"/, '⚠️⚠️ deletes the old tree (no way back)')
})

test('★★ not a single line deletes the state directory (⑩ never create something irrecoverable)', () => {
  // ⚠️⚠️ `~/.nyan-remote` holds vapid.json (subscriptions) and device-key.json (pairings), and
  //    recreating them is **irrecoverable** (CLAUDE.md §0). ⇒ The installer swaps **only the tree**.
  assert.doesNotMatch(CODE, /rm -rf[^\n]*STATE_DIR/, '⚠️⚠️ deletes the state directory')
  assert.doesNotMatch(CODE, /rm -rf[^\n]*\.nyan-remote/, 'same as above (hard-coded)')
})


test('★★ installs the hooks after the agent has started (⑤ a race hit in practice)', () => {
  // ⚠️⚠️ `install-permission-hook.mjs` reads the `hook-token` the agent creates, so
  //    running it right after starting the service finds **nothing yet** (hit with a throwaway HOME on 2026-09-20).
  // ⚠️ Look at **lines that execute** (picking up mentions in comments makes the order look reversed / hit for real)
  const at = {
    wait: CODE.indexOf('wait_state ||'),
    hook: CODE.indexOf('node "$HOME_DIR/scripts/install-permission-hook.mjs"'),
  }
  assert.ok(at.wait >= 0, '⚠️⚠️ does not wait for the agent to start')
  assert.ok(at.hook >= 0, 'does not install the hooks')
  assert.ok(at.wait < at.hook, '⚠️⚠️ installs the hooks before waiting (a race)')
  assert.match(CODE, /hook-token/, 'what it waits for is not written')
})

test('★★ writes a unit whose service never gives up (⑦ measured 2026-09-20)', () => {
  // ⚠️⚠️ `StartLimitIntervalSec` is **a `[Unit]` key**. Placed in `[Service]`, systemd
  //    **drops it** with `Unknown key … ignoring` = the default "5 times in 10 seconds" applies, and
  //    **after repeated crashes it gives up and silently stays down** (the warning appeared in practice on machine C).
  // ★ **Check within the section** (checking the whole file for presence catches no misplacement at all)
  const unit = CODE.slice(CODE.indexOf('[Unit]'), CODE.indexOf('UNITFILE2\n', CODE.indexOf('[Unit]')))
  assert.ok(unit.includes('[Unit]') && unit.includes('[Service]'), 'unit definition not found')
  const sections = { unit: unit.slice(0, unit.indexOf('[Service]')), service: unit.slice(unit.indexOf('[Service]')) }
  assert.match(sections.unit, /^StartLimitIntervalSec=/m, '⚠️⚠️ not in [Unit] (it gives up and stays down)')
  assert.doesNotMatch(sections.service, /^StartLimitIntervalSec=/m, '⚠️⚠️ in [Service] (systemd drops it)')
  assert.match(sections.service, /^Restart=always$/m, 'does not come back up after a crash')
})

test('★★ places notify.sh "before wiring" (⑫ otherwise no notifications at all)', () => {
  // ⚠️⚠️ `install-permission-hook.mjs` wires **only when notify.sh exists** (fail-closed).
  //    ⇒ Placing it afterwards means **nothing is wired** = **not a single** "turn finished" notification.
  //    Hit in practice on 2026-09-21 (test notifications arrive, so it is indistinguishable from a subscription problem).
  const at = {
    // ★ 2026-09-24: from `cp` to `install-notify.mjs` (replace only when it equals a shipped version / codex round 23, high #1)
    copy: CODE.indexOf('node "$HOME_DIR/scripts/install-notify.mjs"'),
    wire: CODE.indexOf('node "$HOME_DIR/scripts/install-permission-hook.mjs"'),
  }
  assert.ok(at.copy >= 0, 'does not place notify.sh')
  assert.ok(at.wire >= 0, 'does not wire the hooks')
  assert.ok(at.copy < at.wire, '⚠️⚠️ places notify.sh after wiring (no notifications)')
  // ⚠️⚠️ Do not go back to a silently overwriting `cp` (a notify.sh the user modified would be lost)
  assert.doesNotMatch(CODE, /cp "\$HOME_DIR\/hooks\/notify\.sh"/)
})

test('★★ writes the state directory into the unit (⑬ codex medium #2)', () => {
  // ⚠️⚠️ Without it, the location the installer checks and the one the agent uses **differ**
  //    = keys and registrations are recreated and **every registered device stops connecting**.
  //    ⚠️ Shell environment variables are not passed to processes started by systemctl.
  const unit = CODE.slice(CODE.indexOf('[Unit]'), CODE.indexOf('UNITFILE2\n', CODE.indexOf('[Unit]')))
  assert.match(
    unit,
    /^Environment=NYAN_REMOTE_STATE_DIR=\$STATE_DIR$/m,
    '⚠️⚠️ the unit does not carry the state directory (the checked location and the running one differ)',
  )
})

/** ★ install.sh's language decision and `tr2` (⚠️ needed when running a cut-out block. Run pinned to Japanese) */
const TR2_FN = (() => {
  const line = SH.split('\n').find((l) => l.startsWith('tr2() {'))
  assert.ok(line, '⚠️ tr2 not found (the test itself is outdated)')
  return `NYAN_L=ja\n${line}`
})()

/** ★ Body of install.sh's `phys` function (resolves to the real path / codex round 16, high #1) */
const PHYS_FN = (() => {
  const i = SH.indexOf('phys() {')
  return SH.slice(i, SH.indexOf('\n}\n', i) + 3)
})()

test('★★ stops if the state directory is inside the tree (⑭ codex medium #3, ⚠️ also through links or // / round 16, high #1)', async () => {
  // ⚠️⚠️ Updates mv the whole tree, so if it is under it **the keys and subscriptions get moved away too**.
  // ★ Run it in real bash (⚠️ a plain string prefix match missed "inside" through links or `//`)
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync, mkdirSync, symlinkSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const start = SH.indexOf('STATE_PHYS="$(phys "$STATE_DIR")"')
  assert.ok(start > 0, 'the real-path guard was not found (the test itself is outdated)')
  const second = SH.indexOf('esac', SH.indexOf('esac', start) + 4)
  const guard = SH.slice(start, second + 4)
  const base = mkdtempSync(join(tmpdir(), 'nyan-guard-'))
  try {
    mkdirSync(join(base, 'app', 'state'), { recursive: true })
    mkdirSync(join(base, 'elsewhere'), { recursive: true })
    symlinkSync(join(base, 'app'), join(base, 'link'))
    const run = (home, state) => {
      const script = `die() { echo "DIE: $*"; exit 1; }\n${TR2_FN}\n${PHYS_FN}\nHOME_DIR=${JSON.stringify(home)}\nSTATE_DIR=${JSON.stringify(state)}\n${guard}\necho OK`
      try {
        return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim()
      } catch (e) {
        return String(e.stdout).trim()
      }
    }
    assert.equal(run(join(base, 'app'), join(base, 'elsewhere', 's')), 'OK', '⚠️ stopped although unrelated')
    assert.match(run(join(base, 'app'), join(base, 'app', 'state')), /DIE: 状態ディレクトリ/)
    assert.match(run(join(base, 'app'), `${base}//app//state`), /DIE: 状態ディレクトリ/, '⚠️⚠️ missed it with //')
    assert.match(run(join(base, 'app'), join(base, 'link', 'state')), /DIE: 状態ディレクトリ/, '⚠️⚠️ missed it through a link')
    assert.match(run(join(base, 'link', 'state', 'x'), join(base, 'app')), /DIE: .*状態ディレクトリ .* の中にあります/, '⚠️ does not check the reverse (tree under the state)')
    // ★ Works even for paths that do not exist yet (first install)
    assert.match(run(join(base, 'app'), join(base, 'link', 'state', 'new', 'deep')), /DIE: 状態ディレクトリ/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})


test('★★ stops on an unsupported OS without half-installing (⑥)', () => {
  // ★ 2026-09-21: separated "does it run on this OS" from "how is it kept running".
  // ★ 2026-09-23: mac runs as a launchd service (`SVC=launchd`).
  //   ⚠️⚠️ The service type is held in a single `SVC` = the OS arms only decide `SVC`.
  const osCase = CODE.slice(CODE.indexOf('case "$(uname -s)"'), CODE.indexOf('esac', CODE.indexOf('case "$(uname -s)"')))
  assert.match(osCase, /Linux\)\s*\n\s*\[ -z "\$SERVICE" \] \|\| SVC=systemd/, 'the Linux service is not systemd')
  assert.match(osCase, /Darwin\)\s*\n\s*\[ -z "\$SERVICE" \] \|\| SVC=launchd/, 'the mac service is not launchd')
  assert.match(CODE, /未対応の OS/, 'does not stop on an unknown OS')
  // ⚠️ Require tools only when running as a service, and **only that type's tools** (check the subject too)
  assert.match(CODE, /case "\$SVC" in\s*\n\s*systemd\)\s*\n\s*command -v systemctl[^\n]*\|\|\s*\n\s*die/, 'the systemd requirement is not tied to SVC')
  assert.match(CODE, /\n\s*launchd\)\s*\n\s*command -v launchctl[^\n]*\|\|\s*\n\s*die/, 'does not check launchctl')
})

test('★★ the mac service passes node\'s absolute path to launchd.mjs (㉒ launchd\'s PATH has no Homebrew)', () => {
  // ⚠️⚠️ launchd passes only /usr/bin:/bin:/usr/sbin:/sbin as PATH ⇒ without it the agent does not start
  assert.match(
    CODE,
    /elif \[ "\$SVC" = launchd \]; then[\s\S]*?node "\$HOME_DIR\/scripts\/launchd\.mjs" install \\\n\s*--home-dir "\$HOME_DIR" --state-dir "\$STATE_DIR" --node "\$\(command -v node\)" \|\|\s*\n\s*die/,
    '⚠️⚠️ the launchd setup does not pass node\'s absolute path or the state directory (or does not stop on failure)',
  )
  // ⚠️ Never write the plist with a heredoc (the ⑱ hole / untestable)
  assert.doesNotMatch(SH, /<plist/, '⚠️ writes the plist in shell')
})

test('★★ before an update, stops with the tool matching the service type (㉓ it called systemctl on mac)', () => {
  const i = CODE.indexOf('mv "$HOME_DIR" "$OLD"')
  assert.ok(i > 0, 'the backup line was not found (the test itself is outdated)')
  const before = CODE.slice(0, i)
  const stop = before.lastIndexOf('case "$SVC" in')
  assert.ok(stop > before.lastIndexOf('pending.mjs'), '⚠️ stops before checking pending approvals')
  const arm = before.slice(stop)
  assert.match(arm, /systemd\) systemctl --user stop "\$UNIT"/, 'does not stop systemd')
  // ⚠️ Use the new tree's launchd.mjs (the old tree may not have it)
  assert.match(arm, /launchd\) node "\$TMP\/nyan-remote\/scripts\/launchd\.mjs" stop \|\|\s*\n\s*die/, 'does not stop launchd (⚠️⚠️ proceeds when it does not fully stop / codex round 15, medium #3)')
  // ⚠️ linger is systemd only
  assert.match(CODE, /if \[ "\$SVC" = systemd \]; then\s*\n\s*loginctl enable-linger/, 'linger is not tied to systemd')
})

test('★★★ checks the Node version (⚠️ TypeScript runs directly, so 24 or later is required)', () => {
  assert.match(CODE, /NODE_MAJOR/, 'does not check the Node version')
  assert.match(CODE, /-ge 24/, 'the required version is not 24')
})

test('★★ the fetch origin can be overridden (★ needed for testing before release)', () => {
  assert.match(CODE, /NYAN_REMOTE_TARBALL/, 'the fetch origin cannot be overridden')
  // ⚠️ The default is the official distribution origin (⚠️ if empty it stops with "nowhere to fetch from")
  assert.match(CODE, /NYAN_REMOTE_TARBALL:-https:\/\//, 'no default fetch origin')
})

test('★★ the fetch origin matches the distribution constant (⑯ ⚠️⚠️ the one place a copy remains)', () => {
  // ★★ **`install.sh` is shell, so it cannot import `shared/distribution.ts`** =
  //   **the only remaining place in this repo where "the same value is written twice"**.
  //   ⚠️⚠️ The symptom of a mismatch is "**`curl | bash` works, but installs an old version**",
  //      and **the person installing cannot tell** (not until they look at RELEASE).
  //   ⇒ Since it cannot be a convention, check it by machine (the substitute for CLAUDE.md "promote conventions to invariants").
  // ⚠️ In the 2026-09-21 move to our own domain, this was exactly the place nearly left behind.
  const m = CODE.match(/^TARBALL="\$\{NYAN_REMOTE_TARBALL:-(\S+?)\}"$/m)
  assert.ok(m, '⚠️ cannot read the default TARBALL value (if its shape changed, fix this check too)')
  assert.equal(
    m[1],
    `${DISTRIBUTION_ORIGIN}/nyan-remote.tar.gz`,
    '⚠️⚠️ install.sh\'s fetch origin disagrees with the distribution origin (shared/distribution.ts)',
  )
})

test('★★ no full-width character right after a variable (⑰ actually stopped on mac\'s bash 3.2)', () => {
  // ★★ **Hit on a real mac on 2026-09-21** (never happened on Linux):
  //     say "入れました: $HOME_DIR（版 …）"
  //   ⇒ it stopped with `/tmp/nyan-install.sh: line 125: HOME_DIR?: unbound variable`.
  //   ⚠️⚠️ **`HOME_DIR?`, not `HOME_DIR`** (= the name got longer). The bytes of the following full-width `（`
  //      appear to have been **swallowed into the variable name** (`?` is the byte the terminal could not display).
  //      ⚠️ bash 5.3 here **does not reproduce it**, so the conditions (bash 3.2 / locale) are unconfirmed.
  //        ⇒ **Avoid it by forbidding the shape, not by pinning down the cause** (`${VAR}` is unambiguous in every version).
  //   ★ This is typical of code that "runs on users' machines but never runs in tests":
  //     **no matter how often it runs on Linux, it does not show up** = the only way is to check the shape by machine.
  const bad = [...CODE.matchAll(/\$[A-Za-z_][A-Za-z0-9_]*[^\u0000-\u007F]/g)].map((m) => m[0])
  assert.deepEqual(
    bad,
    [],
    `⚠️⚠️ full-width character right after a variable (wrap it in \${…}): ${bad.join(' / ')}`,
  )
})

test('★★ no backquotes inside heredocs (⑱ they were executed on a real machine)', () => {
  // ★★ **On a real mac, 2026-09-21** (⚠️ **the same happened on Linux but we had skimmed past it**):
  //     [Unit]: command not found / [Service]: command not found / Unknown: command not found
  //   ⚠️⚠️ `<<UNITFILE2` is **unquoted**, so the body undergoes not only variable expansion but
  //      **command substitution (backquotes) too**. What was meant as a comment `[Unit]` **got executed**.
  //   ⚠️ It cannot be quoted (`<<'DELIM'`) — `$STATE_DIR` and `$HOME_DIR` must expand.
  //   ⇒ **Keep comments outside the heredoc** (= this check).
  //   ★ `$(…)` is equally dangerous, but a day may come when `$(…)` is used on purpose, so **only backquotes** are forbidden
  //     (⚠️ forbidding too much invites other workarounds).
  const bodies = [...SH.matchAll(/<<-?([A-Za-z_][A-Za-z0-9_]*)\n([\s\S]*?)\n\1$/gm)]
  assert.ok(bodies.length > 0, 'no heredoc found (the test itself is outdated)')
  for (const m of bodies) {
    assert.ok(
      !m[2].includes('`'),
      `⚠️⚠️ backquotes inside an unquoted heredoc (<<${m[1]}) = they get executed`,
    )
  }
})

test('★★ writes the unit only when running as a service (⑲ it was placed on mac)', () => {
  // ⚠️ It used to sit **outside** `if [ -n "$SERVICE" ]`, so even on mac it
  //    created `~/.config/systemd/user/` and wrote the unit (placing something unused).
  // ★ Check that "the writing line" and "the branch before it" are in the same construct
  //   (⚠️ check the subject too, not just the arm / lesson of 2026-09-21).
  const i = CODE.indexOf('mkdir -p "$HOME/.config/systemd/user"')
  assert.ok(i > 0, 'the line creating the unit was not found (the test itself is outdated)')
  const before = CODE.slice(0, i)
  const guard = before.lastIndexOf('if [ "$SVC" = systemd ]; then')
  const closed = before.lastIndexOf('\nfi')
  assert.ok(
    guard > closed,
    '⚠️⚠️ writes the systemd unit even without a service (places something unused on mac)',
  )
})

test('★★ no QR at the end of the install (⑳ 2026-09-23 user decision)', () => {
  // ⚠️ Every update showed a QR (an image window on mac), and the one-time token stayed alive for 5 minutes
  assert.doesNotMatch(CODE, /scripts\/pair\.mjs/, '⚠️⚠️ the installer calls pair.mjs')
  // ★ Print instructions instead (⚠️ otherwise nobody knows how to register)
  // ★ 2026-09-24: point to `nyan pair` (⚠️ also list the form with the path for machines where nyan could not be placed)
  // ★ 2026-09-25: our relay requires sign-in ⇒ `nyan login` is named **before** `nyan pair`
  assert.match(CODE, /tr2 '★ こちらの relay（既定）を使うなら、先にログイン（新しいシェルで）: nyan login'/, 'no nyan login hint')
  assert.ok(CODE.indexOf('nyan login') < CODE.indexOf(': nyan pair'), 'nyan login must come before nyan pair')
  assert.match(CODE, /printf '%s\\n' "\$\(tr2 '★ スマホを登録するには（新しいシェルで）: nyan pair' '★ To register a phone \(in a new shell\): nyan pair'\)"/, '登録の案内が無い')
  assert.match(CODE, /printf '%s\\n' "\$\(tr2 "   （nyan が使えないときは: cd \$\{HOME_DIR\} && npm run pair）" "   \(if nyan is not available: cd \$\{HOME_DIR\} && npm run pair\)"\)"/, '⚠️ nyan を置けなかった台の案内が無い')
})

test('★★ an update checks pending approvals before stopping the agent (㉑ never kill answerable approvals)', () => {
  // ⚠️⚠️ The git one-liner had `npm run pending`, but **this update path did not**
  //    = on machines installed via install.sh (machine C) it was skipped every time (2026-09-23).
  const check = CODE.indexOf('node "$TMP/nyan-remote/scripts/pending.mjs"')
  const stop = CODE.indexOf('systemctl --user stop "$UNIT"')
  assert.ok(check > 0, '⚠️⚠️ the update path does not check pending approvals')
  assert.ok(stop > check, '⚠️⚠️ stops the agent before checking (wrong order)')
  // ★ Stops on "pending (1)" (⚠️ check the case's subject too, not just the arm)
  assert.match(
    CODE,
    /case "\$rc" in[\s\S]*?\n\s*1\) die "\$\(tr2 '承認待ちがあります/,
    '⚠️⚠️ does not stop even with pending approvals',
  )
  // ⚠️ With the new tree's guard, look at **the state directory of the agent running now**
  assert.match(CODE, /NYAN_REMOTE_STATE_DIR="\$STATE_DIR" node "\$TMP\/nyan-remote\/scripts\/pending\.mjs"/)
})

test('★★ an update keeps only the most recent backup (㉔ 2026-09-23) and removes only removable shapes', async () => {
  // ★ Actually run it in bash (⚠️ the text alone cannot show "what gets removed")
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  // ★ The cleanup block (the `if [ -n "$UPDATING" ]` block containing `if SP="$(phys …`)
  const start = SH.lastIndexOf('if [ -n "$UPDATING" ]; then', SH.indexOf('if SP="$(phys "$STATE_DIR")"'))
  assert.ok(start > 0, 'the cleanup block was not found (the test itself is outdated)')
  const end = SH.indexOf('\nfi\n', start)
  const block = SH.slice(start, end + 4)
  const base = mkdtempSync(join(tmpdir(), 'nyan-old-'))
  try {
    const home = join(base, 'app')
    const tree = (d, withIndex = true) => {
      mkdirSync(join(d, 'agent', 'src'), { recursive: true })
      if (withIndex) writeFileSync(join(d, 'agent', 'src', 'index.ts'), '')
    }
    tree(home)
    tree(`${home}.old-20260101-000000`)
    tree(`${home}.old-20260202-000000`)
    tree(`${home}.old-20260303-000000`, false)
    tree(`${home}.old-junk`)
    tree(`${home}.old-20260404-000000`)
    mkdirSync(join(`${home}.old-20260404-000000`, 'state'), { recursive: true })
    // ⚠️⚠️ Mix links and // (codex round 16, high #1: a plain string comparison removed a backup containing the state)
    const { symlinkSync } = await import('node:fs')
    symlinkSync(home, `${home}.old-20260606-000000`)
    const script = `say() { :; }\n${TR2_FN}\n${PHYS_FN}\nHOME_DIR=${JSON.stringify(home)}\nOLD=${JSON.stringify(home + '.old-20260202-000000')}\nSTATE_DIR=${JSON.stringify(join(home + '.old-20260404-000000', 'state'))}\nUPDATING=1\n${block}`
    execFileSync('bash', ['-c', script])
    assert.equal(existsSync(`${home}.old-20260101-000000`), false, '⚠️ an old backup remains (they pile up)')
    assert.equal(existsSync(`${home}.old-20260202-000000`), true, '⚠️⚠️ removed this run\'s backup (no way back)')
    assert.equal(existsSync(home), true, '⚠️⚠️ removed the current tree')
    assert.equal(existsSync(`${home}.old-20260303-000000`), true, '⚠️ removed something that does not look like a nyan-remote tree')
    assert.equal(existsSync(`${home}.old-junk`), true, '⚠️ removed something not in the fixed shape')
    assert.equal(existsSync(`${home}.old-20260404-000000`), true, '⚠️⚠️ removed a backup containing the state directory (irrecoverable)')
    // ★ Also never remove it when the state is inside another backup "through a link, with //"
    // ⚠️ Create it here so the first cleanup does not remove it
    tree(`${home}.old-20260505-000000`)
    mkdirSync(join(`${home}.old-20260505-000000`, 'keys'), { recursive: true })
    symlinkSync(`${home}.old-20260505-000000`, join(base, 'alias'))
    const script2 = `say() { :; }\n${TR2_FN}\n${PHYS_FN}\nHOME_DIR=${JSON.stringify(home)}\nOLD=${JSON.stringify(home + '.old-20260202-000000')}\nSTATE_DIR=${JSON.stringify(base + '//alias//keys')}\nUPDATING=1\n${block}`
    execFileSync('bash', ['-c', script2])
    assert.equal(existsSync(`${home}.old-20260505-000000`), true, '⚠️⚠️ removed a backup containing state through a link (irrecoverable)')
    assert.equal(existsSync(home), true, '⚠️⚠️ removed the current tree via a backup that links to it')
    // ★★ Even when the tree itself is given through a link (HOME_DIR contains a link), never remove a backup containing the state
    //   ⚠️ Comparing without resolving the backups to real paths removes it here (the core of codex round 16, high #1)
    symlinkSync(base, join(base, 'via'))
    tree(`${home}.old-20260707-000000`)
    mkdirSync(join(`${home}.old-20260707-000000`, 'st'), { recursive: true })
    const viaHome = join(base, 'via', 'app')
    const script3 = `say() { :; }\n${TR2_FN}\n${PHYS_FN}\nHOME_DIR=${JSON.stringify(viaHome)}\nOLD=${JSON.stringify(viaHome + '.old-20260202-000000')}\nSTATE_DIR=${JSON.stringify(join(`${home}.old-20260707-000000`, 'st'))}\nUPDATING=1\n${block}`
    execFileSync('bash', ['-c', script3])
    assert.equal(existsSync(`${home}.old-20260707-000000`), true, '⚠️⚠️ removed a backup containing the state via a linked tree')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('★★★ Node can start even if the current directory is gone (a shell opened inside the tree / 2026-09-24)', async () => {
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const line = CODE.split('\n').find((l) => l.startsWith('pwd -P >/dev/null 2>&1 ||'))
  assert.ok(line, '⚠️⚠️ no remedy for a vanished current directory')
  // ⚠️ Place it before the first node (after it, it fails first)
  assert.ok(CODE.indexOf(line) < CODE.indexOf('command -v node'), '⚠️ the remedy comes after calling node')
  const home = mkdtempSync(join(tmpdir(), 'nyan-cwd-'))
  const gone = join(home, 'gone')
  const out = execFileSync(
    'bash',
    ['-c', `mkdir "${gone}" && cd "${gone}" && rmdir "${gone}" && ${line} && node -e 'process.stdout.write(process.cwd())'`],
    { env: { ...process.env, HOME: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  )
  assert.equal(out, home, '⚠️⚠️ starts Node in the vanished directory')
})

test('★★ language: Japanese only for Japanese locales, otherwise (unset, C) English (2026-09-24)', async () => {
  const { execFileSync } = await import('node:child_process')
  const start = SH.indexOf('case "${NYAN_LANG:-')
  assert.ok(start > 0, '⚠️ language decision not found (the test itself is outdated)')
  const end = SH.indexOf('\n', SH.indexOf('tr2() {', start))
  const block = SH.slice(start, end)
  const run = (env) =>
    execFileSync('bash', ['-c', `set -euo pipefail\n${block}\ntr2 JA EN`], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } })
  assert.equal(run({}), 'EN', '⚠️⚠️ Japanese with nothing set')
  assert.equal(run({ LANG: 'C.UTF-8' }), 'EN')
  assert.equal(run({ LANG: 'ja_JP.UTF-8' }), 'JA')
  assert.equal(run({ LANG: 'ja_JP.UTF-8', LC_ALL: 'en_US.UTF-8' }), 'EN', 'LC_ALL comes before LANG')
  assert.equal(run({ LANG: 'en_US.UTF-8', LC_MESSAGES: 'ja_JP.UTF-8' }), 'JA', 'LC_MESSAGES comes before LANG')
  assert.equal(run({ LANG: 'ja_JP.UTF-8', NYAN_LANG: 'en' }), 'EN', 'NYAN_LANG comes first')
  assert.equal(run({ NYAN_LANG: 'ja' }), 'JA')
  // ⚠️ Japanese text always goes through tr2 (never show Japanese to English users)
  const bare = CODE.split('\n').filter((l) => /(^|[;|&]\s*|\s)(say|die|printf|echo) /.test(l) && /[\u3040-\u30ff\u4e00-\u9fff]/.test(l) && !l.includes('tr2 '))
  assert.deepEqual(bare, [], '⚠️⚠️ Japanese text that bypasses tr2')
})
