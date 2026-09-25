// ★★ **The rename (`tmux-agent` → `nyan-remote`) was completed through stage 2+3 on 2026-09-19.**
//
// ★★ **What is protected now is only "what lives in the user's browser"** (CLAUDE.md §0).
//   ⇒ **Every machine-side name was changed to `nyan-remote`** (working tree, unit, state directory,
//     environment variables, auth header, rc markers, keystroke socket, escape hatch).
//   ⇒ **The browser side was not changed** (localStorage, IndexedDB, SW cache, notification tag).
//     ⚠️⚠️ Reason: the machine side is **something we make**, movable with `mv` and a reinstall, but
//        the browser side is **something the user holds**, and changing it
//        **loses the device's private key = re-pairing on every machine** (it is per origin, so it cannot be moved).
//
// ⚠️⚠️ If someone next **bulk-replaces the rest too**, one of these happens:
//    - the IndexedDB key changes and **this device's private key is lost** (= a different person; re-pair everything)
//    - the localStorage keys change and **the endpoint list and drafts disappear**
//    - the notification tag changes and **replacement of existing notifications breaks**
//    - the SW cache prefix changes and **old shells can no longer be cleaned up**
//
// ⚠️ The reverse (forgetting to switch to `nyan-remote`) is checked too: if an old name remains on the machine side,
//    **it mixes with pre-rename machines and breaks silently** (`legacyStateProblem` in `state.ts` refuses it).
//
// ⇒ **Writing it in the docs is not enough** (§2 "do not rely on your own comments"). Check it by machine.
//
// ★★ Still three layers:
//   ① names that must stay have not disappeared from the corpus (`MUST_KEEP` = **browser side**)
//   ② names that were supposed to change do not remain as "names with a real thing outside" (`MUST_NOT_APPEAR` = **old machine-side names**)
//   ③ ★ **check the values the implementation actually builds** (①② are string tables, so
//      **splitting like `['nyan-remote','endpoints','v1'].join('.')` evades them endlessly**)
//   ⚠️ ③ is the real one. Do not fall back to ①② only.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

// @ts-expect-error — plain .mjs (no types)
import { BEGIN, END, SHIM_MARK } from '../../scripts/install-relay.mjs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { legacyStateProblem, stateDir } from './state.ts'

const ROOT = new URL('../../', import.meta.url).pathname

/** ⚠️ This watcher itself holds forbidden words as strings, so it is not counted (it would fail itself) */
const SELF = 'agent/src/rename.test.ts'

/**
 * Reads every tracked text file.
 * ⚠️⚠️ **When it walked with `readdir`, names starting with `.` were dropped entirely**, so
 *    mutations in `.gitignore` / `.github/` **were always missed** (codex low #12).
 *    ⇒ `git ls-files` is authoritative (what is tracked is "the contents of this repository").
 */
function corpus(): string {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((r) => r && r !== SELF && r !== 'package-lock.json')
  return files
    .map((r) => {
      try {
        const s = readFileSync(join(ROOT, r), 'utf8')
        return s.includes('\0') ? '' : stripLegacy(s) // skip binaries
      } catch {
        return ''
      }
    })
    .join('\n')
}

/**
 * ★★ Removes **regions that intentionally write old names** (migration hints and migration-detecting code).
 *
 * ⚠️⚠️ Even after the rename, **migration cannot be explained without writing the old names**
 *    (`mv ~/.tmux-agent ~/.nyan-remote` / the names `legacyStateProblem()` looks for).
 * ⚠️⚠️ **This can become a hiding place**, so the check below **limits their count and length**
 *    (the more there are, the weaker the watcher).
 */
// ⚠️⚠️ **Do not write the marker names whole in prose** (hit in practice on 2026-09-19).
//    The watcher only checks "whether the text is present", so **explanatory text gets picked up as a marker**
//    (= treated as unclosed, and the file is skipped to the end).
//    ⇒ When explaining, write it **split**, like `…-BEGIN`.
const LEGACY_BEGIN = 'LEGACY-NAMES' + '-BEGIN'
const LEGACY_END = 'LEGACY-NAMES' + '-END'

function stripLegacy(s: string): string {
  const out: string[] = []
  let skipping = false
  for (const line of s.split('\n')) {
    if (line.includes(LEGACY_BEGIN)) {
      skipping = true
      continue
    }
    if (line.includes(LEGACY_END)) {
      skipping = false
      continue
    }
    if (!skipping) out.push(line)
  }
  return out.join('\n')
}

/**
 * ⚠️ Counts the regions themselves (they are removed from the corpus, so read the raw text).
 *
 * ★★ **Broken markers are picked up too** (2026-09-19 / codex round 10, medium #3).
 *   ⚠️⚠️ It used to count only "closed regions", so **an unclosed one**
 *      **skipped to the end of the file and was not even counted as a region**
 *      (= the count and length limits could be bypassed entirely).
 *   ⚠️⚠️ **Nesting** likewise: a later BEGIN overwrote the start position and a long region was counted as "0 lines".
 */
function legacyRegions(): Array<{ file: string; lines: number; broken?: string }> {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((r) => r && r !== SELF && r !== 'package-lock.json')
  const out: Array<{ file: string; lines: number; broken?: string }> = []
  for (const r of files) {
    let s: string
    try {
      s = readFileSync(join(ROOT, r), 'utf8')
    } catch {
      continue
    }
    if (s.includes('\0')) continue
    let open = -1
    s.split('\n').forEach((line, i) => {
      if (line.includes(LEGACY_BEGIN)) {
        // ⚠️⚠️ **nesting is rejected** (overwriting the start position turns a long region into "0 lines")
        if (open >= 0) out.push({ file: r, lines: i - open, broken: 'nested BEGIN' })
        open = i
      } else if (line.includes(LEGACY_END)) {
        // ⚠️⚠️ **an END with no matching BEGIN is rejected too** (a sign of a broken shape)
        if (open < 0) out.push({ file: r, lines: 0, broken: 'END with no matching BEGIN' })
        else out.push({ file: r, lines: i - open - 1 })
        open = -1
      }
    })
    // ⚠️⚠️ **unclosed** (= skipped to the end of the file; the most dangerous shape)
    if (open >= 0) {
      out.push({ file: r, lines: s.split('\n').length - open - 1, broken: 'unclosed BEGIN' })
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// ① Names that must stay (a real thing with the same name exists outside the repository)
//    ⚠️ Check **existence**, not counts (ordinary edits change the count, so a fixed number would be a false red)
// ─────────────────────────────────────────────────────────────────────────────
const MUST_KEEP: Array<[string, RegExp, string]> = [
  // ★★ Only **things the user's browser holds** are here (per origin, so they cannot be moved)
  ['endpoint list', /tmux-agent\.endpoints\.v1/, 'lost ⇒ register again'],
  ['device private key', /tmux-agent\.identity\.v1/, '⚠️⚠️ changed ⇒ a different person = re-pair on every machine'],
  ['list open/closed', /tmux-agent\.historyOpen/, 'display settings are lost'],
  ['drafts', /tmux-agent\.draft/, 'half-typed text is lost'],
  ['chosen cat', /tmux-agent\.status-cat\.v1/, 'the chosen cat reverts'],
  ['SW cache', /tmux-agent-shell-v\d/, 'decides old-cache cleanup (⚠️ the version may be bumped)'],
  ['test notification tag', /tmux-agent-test/, 'the key for notification replacement'],
  ['default notification tag', /data\.tag \|\| 'tmux-agent'/, '⚠️ replacement of existing notifications breaks'],
  ['history.state', /tmux-agent:deep/, '"back" does not work in an open tab'],
  ['VAPID subject', /example\.com\/tmux-agent/, 'do not touch; it was stuck for 3 days (§2)'],
  ['firewall Name', /-Name tmux-agent\b/, 'rule name already installed on Windows'],
  ['firewall display name', /-DisplayName "tmux-agent"/, 'same as above (do not allow a half-broken state)'],
]

test('★★★ names kept through the rename have not disappeared (a redone bulk replace fails here)', () => {
  const all = corpus()
  // ★ The firewall rule names are written only in the setup docs, which the public snapshot leaves out
  //   (scripts/publish-public.mjs) ⇒ check them only where those docs exist.
  const docsHere = existsSync(join(ROOT, 'docs', 'SETUP-AGENT.md'))
  const lost = MUST_KEEP.filter(([what, rx]) => (docsHere || !what.startsWith('firewall')) && !rx.test(all))
  assert.deepEqual(
    lost.map(([what, , why]) => `${what}: ${why}`),
    [],
    '⚠️⚠️ a name of something in the user\'s browser disappeared ⇒ device private keys, endpoints and notifications are lost',
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// ② New names do not appear as the names of "state outside the repository"
//    ⚠️ This is the real one (① passes as long as both names coexist)
//    ★ **Do not enumerate verbs** (checking only `restart|enable` let `status` / `stop` through).
//      Fail when `systemctl` / `journalctl` and the new name are on the same line.
// ─────────────────────────────────────────────────────────────────────────────
const MUST_NOT_APPEAR: Array<[string, RegExp, string]> = [
  // ★★ These are **old machine-side names** (all moved to `nyan-remote` on 2026-09-19).
  //   ⚠️ If they remain, they mix with pre-rename machines and break silently.
  ['state directory', /(?<![\w-])\.tmux-agent\b/, '~/.tmux-agent'],
  ['working tree', /(?:~|%h|\$HOME|\/home\/[a-z][\w.-]*)\/tmux-agent\b/, 'ExecStart=%h/tmux-agent/x'],
  ['unit settings', /(?:WorkingDirectory|ExecStart)=[^\n]*tmux-agent/, 'WorkingDirectory=%h/tmux-agent'],
  ['systemd / journal', /^[^\n]*(?:systemctl|journalctl)[^\n]*\btmux-agent\b/m, 'systemctl --user status tmux-agent'],
  ['unit name', /tmux-agent\.service/, 'tmux-agent.service'],
  ['environment variable', /TMUX_AGENT_[A-Z]/, 'TMUX_AGENT_STATE_DIR'],
  ['auth header', /x-tmux-agent-token/i, "header(req, 'x-tmux-agent-token')"],
  ['rc marker', /(?:>>>|<<<) tmux-agent relay|# tmux-agent: /, '# <<< tmux-agent relay <<<'],
  ['rc backup name', /tmux-?agent-backup-/, '.bashrc.tmux-agent-backup-'],
  ['shell variable', /_tmux_agent_path/, '_tmux_agent_path'],
  ['escape hatch', /tmux-agent-inflight/, 'tmux-agent-inflight.off'],
  ['keystroke socket location', /tmux-agent-\{os\.geteuid\(\)\}|tmux-agent-\$\{/, 'f"tmux-agent-{os.geteuid()}"'],
]

test('★★★ no old names remain on the machine side (rename leftovers fail here)', () => {
  const all = corpus()
  const leaked = MUST_NOT_APPEAR.filter(([, rx]) => rx.test(all)).map(([what]) => what)
  assert.deepEqual(
    leaked,
    [],
    '⚠️⚠️ old names remain on the machine side (mix with pre-rename machines and break silently / CLAUDE.md §0)',
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// ③ ★★ **Check the values the implementation actually builds** (string tables can be evaded by splitting / codex high #5)
// ─────────────────────────────────────────────────────────────────────────────

test('★★★ measured: the state directory is ~/.nyan-remote (⚠️ tables can be evaded by splitting, so check the return value)', () => {
  const before = process.env['NYAN_REMOTE_STATE_DIR']
  delete process.env['NYAN_REMOTE_STATE_DIR']
  try {
    assert.match(stateDir(), /\/\.nyan-remote$/, `stateDir() is ${stateDir()}`)
  } finally {
    if (before !== undefined) process.env['NYAN_REMOTE_STATE_DIR'] = before
  }
})

test('★★★★ measured: if old state exists and new does not, **refuse to start** (fail-closed)', async (t) => {
  // ⚠️⚠️ **This is the most important safeguard of the rename**. Without it, on a machine with old state the agent
  //    creates new state and **recreates** `vapid.json` and `device-key.json`
  //    = subscriptions and pairings are lost **unrecoverably** (CLAUDE.md §0).
  const dir = await mkdtemp(join(tmpdir(), 'nyan-rename-'))
  const home = process.env['HOME']
  const env = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['HOME'] = dir
  delete process.env['NYAN_REMOTE_STATE_DIR']
  t.after(async () => {
    if (home === undefined) delete process.env['HOME']
    else process.env['HOME'] = home
    if (env === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = env
    await rm(dir, { recursive: true, force: true })
  })
  /** ★ "state exists" = **there is content** (⚠️ merely creating the directory is not migrated) */
  const putState = async (name: string) => {
    await mkdir(join(dir, name), { recursive: true })
    await writeFile(join(dir, name, 'config.json'), '{}')
  }

  // ★ neither exists (= a clean machine) ⇒ allow
  assert.equal(await legacyStateProblem(), undefined, 'refuses on a clean machine')

  // ⚠️ only the old one exists ⇒ **refuse and explain how to move it**
  await putState('.tmux-agent')
  const problem = await legacyStateProblem()
  assert.ok(problem, '⚠️⚠️ allowed although old state exists (recreating kills subscriptions)')
  // ★ explain **how to move it**, with both old and new paths (= can be typed as is)
  assert.match(problem, /mv /, '★ does not say how to fix it (move)')
  assert.ok(problem.includes(join(dir, '.tmux-agent')), '★ does not say where to move from')
  assert.ok(problem.includes(join(dir, '.nyan-remote')), '★ does not say where to move to')

  // ⚠️⚠️ **merely creating the directory is not "migrated"** (codex round 10, medium #2).
  //    `install-relay.mjs` creates `~/.nyan-remote/bin/`, so doing things in the wrong order
  //    **passes with empty contents and creates new state while abandoning the old**.
  await mkdir(join(dir, '.nyan-remote', 'bin'), { recursive: true })
  assert.ok(
    await legacyStateProblem(),
    '⚠️⚠️ judged an empty directory as "migrated" (install-relay creates it first)',
  )

  // ★ passes once the contents have moved
  await putState('.nyan-remote')
  assert.equal(await legacyStateProblem(), undefined, 'refuses although it was moved')
})

test('★★★★ measured: the guard works even if the default destination is given explicitly (codex round 10, medium #2)', async (t) => {
  // ⚠️⚠️ it used to **pass unconditionally** whenever `NYAN_REMOTE_STATE_DIR` was set, so
  //    explicitly naming the default location bypassed the guard.
  const dir = await mkdtemp(join(tmpdir(), 'nyan-rename-'))
  const home = process.env['HOME']
  const env = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['HOME'] = dir
  t.after(async () => {
    if (home === undefined) delete process.env['HOME']
    else process.env['HOME'] = home
    if (env === undefined) delete process.env['NYAN_REMOTE_STATE_DIR']
    else process.env['NYAN_REMOTE_STATE_DIR'] = env
    await rm(dir, { recursive: true, force: true })
  })
  await mkdir(join(dir, '.tmux-agent'), { recursive: true })
  await writeFile(join(dir, '.tmux-agent', 'config.json'), '{}')

  // ⚠️ the default destination given explicitly ⇒ **not overlooked**
  process.env['NYAN_REMOTE_STATE_DIR'] = join(dir, '.nyan-remote')
  assert.ok(await legacyStateProblem(), '⚠️⚠️ bypassed by explicitly naming the default location')

  // ★ if you chose another place yourself it does not matter (= not a migration matter)
  process.env['NYAN_REMOTE_STATE_DIR'] = join(dir, 'どこか別の場所')
  assert.equal(await legacyStateProblem(), undefined, 'refuses although another place was chosen')
})

test('★★★ measured: refuse when the old environment variable arrives (a sign the installed shim is old)', async (t) => {
  const before = process.env['TMUX_AGENT_STATE_DIR']
  const now = process.env['NYAN_REMOTE_STATE_DIR']
  process.env['TMUX_AGENT_STATE_DIR'] = '/tmp/どこか'
  delete process.env['NYAN_REMOTE_STATE_DIR']
  t.after(() => {
    if (before === undefined) delete process.env['TMUX_AGENT_STATE_DIR']
    else process.env['TMUX_AGENT_STATE_DIR'] = before
    if (now !== undefined) process.env['NYAN_REMOTE_STATE_DIR'] = now
  })
  const problem = await legacyStateProblem()
  assert.ok(problem, '⚠️⚠️ silently ignored the old environment variable (runs out of step with old hooks)')
  assert.match(problem, /install-relay|install-permission-hook/, '★ does not say how to reinstall')
})

test('★★★★ wiring: startup checks `legacyStateProblem()` **before `loadConfig()`**', () => {
  // ⚠️⚠️ **The order is the point**. `loadConfig()` **creates and writes** `hookToken` if missing, so
  //    putting the guard after it leaves "a new empty one created although the old directory exists"
  //    = subscriptions and pairings are lost unrecoverably.
  // ⚠️ the guard function itself is checked by the behavioural tests above. Here only **whether it is called**
  //    (`index.ts` starts the server, so this is the one place we can only check by text).
  const src = readFileSync(join(ROOT, 'agent/src/index.ts'), 'utf8')
  const at = {
    guard: src.indexOf('await legacyStateProblem()'),
    config: src.indexOf('await loadConfig()'),
  }
  assert.ok(at.guard >= 0, '⚠️⚠️ startup does not call the guard (silently recreates old state)')
  assert.ok(at.config >= 0, 'loadConfig call not found (shape changed)')
  assert.ok(at.guard < at.config, '⚠️⚠️ the guard is after loadConfig (written first)')
  // ★★ **Check "it stops" in the written form** (2026-09-19 / codex round 10, low #5).
  //   ⚠️⚠️ it used to check only for `exitCode = 1`, so **a mutation removing `return` slipped through**
  //      (even with exitCode set, execution continued into `loadConfig()` and started the server).
  //   ⇒ check that **a `return` exists inside** the guard's branch.
  const block = /const legacy = await legacyStateProblem\(\)\n\s*if \(legacy\) \{([\s\S]*?)\n  \}/.exec(src)
  assert.ok(block, 'could not extract the guard branch (shape changed)')
  assert.match(block[1] ?? '', /\breturn\b/, '⚠️⚠️ continues even when the guard trips (no return)')
  assert.match(block[1] ?? '', /process\.exitCode = 1/, '⚠️ exit code not set')
})

test('★★ measured: all three rc markers use the new name (⚠️ run `--uninstall` on the old block before reinstalling)', () => {
  // ⚠️⚠️ with the rename, **an installed .bashrc is not fixed automatically**. If the new block goes in
  //    while the old one remains, **it is doubled**. ⇒ The procedure is "--uninstall with old → install with new".
  assert.equal(BEGIN, '# >>> nyan-remote relay >>>')
  assert.equal(END, '# <<< nyan-remote relay <<<')
  assert.match(SHIM_MARK, /^# nyan-remote: /)
})

test('★★★ measured: the header name notify.sh sends matches the one auth.ts reads', () => {
  // ★ this is a **paired** test independent of the rename. It fails if only one side changes.
  //   ⚠️ notify.sh is **installed by copying**, so fixing only one side
  //     causes "no notifications even after git pull" (the hardest cause to find).
  const sh = readFileSync(join(ROOT, 'hooks/notify.sh'), 'utf8')
  const auth = readFileSync(join(ROOT, 'agent/src/auth.ts'), 'utf8')
  const sent = sh.match(/-H "([\w-]+-Token): /i)
  const read = auth.match(/header\(req, '([\w-]+-token)'\)/i)
  assert.ok(sent, 'cannot read the header name notify.sh sends (shape changed)')
  assert.ok(read, 'cannot read the header name auth.ts reads (shape changed)')
  assert.equal(
    sent[1]!.toLowerCase(),
    read[1]!.toLowerCase(),
    '⚠️⚠️ the header the hook sends and the header the agent reads disagree (every installed hook fails)',
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// Checking the watcher itself
// ─────────────────────────────────────────────────────────────────────────────

test('★ check the decision itself (the watcher is not letting everything through)', () => {
  const all = corpus()
  assert.ok(all.length > 100_000, `only ${all.length} characters were read (scanning is broken)`)
  assert.ok(all.includes('nyan-remote'), 'not a single new name (the replacement itself is missing)')
  // ★★ **dotfiles are read too** (the `readdir` version dropped them entirely / codex low #12)
  assert.ok(all.includes('# 秘密情報は絶対にコミットしない'), '.gitignore contents are not in the corpus (dropping dotfiles)')
})

test('★★★ regions that "intentionally write old names" are few and short (not a hiding place for the watcher)', () => {
  // ⚠️⚠️ these regions are removed from the corpus = **anything written there is invisible to the watcher**.
  //    ⇒ **limit their count and length** (if you want to widen one, first doubt whether the old name is really needed).
  const regions = legacyRegions()
  assert.ok(regions.length > 0, 'no regions at all (did the migration hint disappear?)')
  // ⚠️⚠️ **a broken marker is an immediate fail** (unclosed, nested, orphan END).
  //    ★ an unclosed one drops the corpus **to the end of the file**, disabling the watcher entirely.
  assert.deepEqual(
    regions.filter((r) => r.broken).map((r) => `${r.file}: ${r.broken}`),
    [],
    '⚠️⚠️ a marker of an old-name region is broken (widens the range the watcher skips)',
  )
  assert.ok(
    regions.length <= 3,
    `⚠️⚠️ there are ${regions.length} old-name regions (the more there are, the weaker the watcher): ` +
      regions.map((r) => r.file).join(', '),
  )
  for (const r of regions) {
    assert.ok(r.lines <= 12, `⚠️⚠️ the region in ${r.file} is ${r.lines} lines (too long = a hiding place)`)
  }
})

test('★★ every forbidden pattern "actually catches" something (no dead branches / codex finding)', () => {
  // ⚠️⚠️ there was only one probe, so **setting the other 18 to `/a^/` stayed green**.
  //    ⇒ give each row an example "that should match" and check **all** of them.
  const dead = MUST_NOT_APPEAR.filter(([, rx, probe]) => !rx.test(probe)).map(([what]) => what)
  assert.deepEqual(dead, [], 'a forbidden pattern does not even catch its own example (the regex is dead)')
})
