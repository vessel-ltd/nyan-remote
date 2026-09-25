// ★ Check the rules for the mac service (launchd) (⚠️ launchd cannot be tried on Linux = hit the pure functions)
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildPlist, isRunning, launchctlSteps, runningPid, runSteps, staysRunning } from './launchd.mjs'
import { hints, LAUNCHD_LABEL, launchdLogPath, launchdPlistPath, recentLogLines, serviceKind } from './lib/service.mjs'
import { setLang } from '../shared/i18n.ts'

// ★ Messages below are asserted in Japanese (pin the language)
setLang('ja')

const base = {
  homeDir: '/Users/k/nyan-remote',
  stateDir: '/Users/k/.nyan-remote',
  node: '/opt/homebrew/bin/node',
  log: '/Users/k/Library/Logs/nyan-remote/agent.log',
  home: '/Users/k',
}

/** Look up <key>k</key><string>v</string> in the plist (⚠️ naive, but enough since the builder is naive too) */
function value(plist, key) {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist)
  return m?.[1]
}

test('★★ plist: passes the absolute node path and the state directory to the agent', () => {
  const p = buildPlist(base)
  assert.equal(value(p, 'Label'), LAUNCHD_LABEL)
  // ⚠️⚠️ launchd's PATH has no Homebrew ⇒ it does not start unless passed via AGENT_NODE
  assert.equal(value(p, 'AGENT_NODE'), base.node)
  // ⚠️ The location the installer saw and the one the agent uses must be the same value (same as Environment= in the unit)
  assert.equal(value(p, 'NYAN_REMOTE_STATE_DIR'), base.stateDir)
  assert.equal(value(p, 'WorkingDirectory'), base.homeDir)
  // ★ PATH starts with node's directory (children calling node get the same version)
  assert.match(value(p, 'PATH') ?? '', /^\/opt\/homebrew\/bin:\/Users\/k\/\.local\/bin:/)
  assert.match(p, /<string>\/Users\/k\/nyan-remote\/scripts\/agent-service\.sh<\/string>/)
  assert.equal(value(p, 'StandardOutPath'), base.log)
  assert.equal(value(p, 'StandardErrorPath'), base.log)
})

test('★★★ plist: restarts on crash and starts at login', () => {
  const p = buildPlist(base)
  assert.match(p, /<key>KeepAlive<\/key>\s*<true\/>/)
  assert.match(p, /<key>RunAtLoad<\/key>\s*<true\/>/)
  assert.match(p, /<key>ThrottleInterval<\/key>\s*<integer>\d+<\/integer>/)
  // ⚠️ No dev backdoor in production
  assert.doesNotMatch(p, /NYAN_REMOTE_DEV/)
})

test('★★★ plist: escapes special characters in paths (& or < do not break the XML)', () => {
  const p = buildPlist({ ...base, homeDir: '/Users/a&b/<x>' })
  assert.match(p, /\/Users\/a&amp;b\/&lt;x&gt;/)
  assert.doesNotMatch(p, /a&b/)
})

test('★★★ plist: rejects relative paths (launchd cannot rely on a working directory)', () => {
  for (const k of Object.keys(base)) {
    assert.throws(() => buildPlist({ ...base, [k]: 'relative/path' }), new RegExp(k))
    assert.throws(() => buildPlist({ ...base, [k]: undefined }), new RegExp(k))
  }
})

test('★ plist: validates the shape with plutil when available (runs only on mac)', { skip: process.platform !== 'darwin' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'plist-'))
  try {
    const f = join(dir, 'a.plist')
    writeFileSync(f, buildPlist(base))
    assert.equal(spawnSync('plutil', ['-lint', f]).status, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★★ launchctl: when reinstalling, bootout first, then bootstrap (bootout may fail)', () => {
  const steps = launchctlSteps('install', 501, '/p.plist')
  assert.deepEqual(steps, [
    { argv: ['bootout', `gui/501/${LAUNCHD_LABEL}`], mayFail: true },
    { argv: ['bootstrap', 'gui/501', '/p.plist'], mayFail: false },
  ])
  // ⚠️ Stopping does not fail even if "not loaded" (first update, updating from no service)
  assert.deepEqual(launchctlSteps('stop', 501, '/p.plist'), [{ argv: ['bootout', `gui/501/${LAUNCHD_LABEL}`], mayFail: true, requireGone: true }])
  assert.deepEqual(launchctlSteps('restart', 501, '/p.plist'), [
    { argv: ['kickstart', '-k', `gui/501/${LAUNCHD_LABEL}`], mayFail: false },
  ])
  assert.throws(() => launchctlSteps('nope', 501, '/p.plist'))
})

test('★★★ running is read in the affirmative (state = running)', () => {
  assert.equal(isRunning(`gui/501/${LAUNCHD_LABEL} = {\n\tactive count = 1\n\tstate = running\n\tpid = 123\n}`), true)
  assert.equal(isRunning('\tstate = not running\n'), false)
  assert.equal(isRunning('\tstate = spawn scheduled\n'), false)
  assert.equal(isRunning(''), false)
})

test('★★ still running: only when the same pid is running twice (⚠️ never count something that dies right after start as success)', () => {
  const at = (pid) => `\tstate = running\n\tpid = ${pid}\n`
  assert.equal(runningPid(at(123)), 123)
  assert.equal(runningPid('\tstate = not running\n\tpid = 9\n'), undefined)
  assert.equal(staysRunning(at(123), at(123)), true)
  // ⚠️ KeepAlive restarted it = a different pid
  assert.equal(staysRunning(at(123), at(124)), false)
  assert.equal(staysRunning(at(123), '\tstate = spawn scheduled\n'), false)
  assert.equal(staysRunning('', ''), false)
})

test('★★ service type: mac is launchd only when the plist exists (otherwise instructions say npm start)', () => {
  const home = '/Users/k'
  assert.equal(serviceKind('darwin', home, (p) => p === launchdPlistPath(home)), 'launchd')
  assert.equal(serviceKind('darwin', home, () => false), 'none')
  assert.equal(serviceKind('linux', home, () => false), 'systemd')
  assert.equal(launchdPlistPath(home), `/Users/k/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`)
  assert.equal(launchdLogPath(home), '/Users/k/Library/Logs/nyan-remote/agent.log')
})

test('★★ instructions differ by service type (⚠️ never suggest systemctl / journalctl on mac)', () => {
  for (const kind of ['launchd', 'none']) {
    const h = hints(kind)
    for (const v of Object.values(h)) assert.doesNotMatch(v, /systemctl|journalctl/, `${kind}: ${v}`)
  }
  assert.match(hints('launchd').start, new RegExp(`kickstart -k gui/\\$\\(id -u\\)/${LAUNCHD_LABEL.replace(/\./g, '\\.')}`))
  assert.match(hints('launchd').logs, /~\/Library\/Logs\/nyan-remote\/agent\.log/)
  assert.match(hints('none').start, /npm start/)
  assert.match(hints('systemd').start, /systemctl --user start nyan-remote/)
})

test('★★ launchd logs are read from the tail only (the partial first line is dropped)', () => {
  const home = mkdtempSync(join(tmpdir(), 'svc-home-'))
  try {
    const log = launchdLogPath(home)
    spawnSync('mkdir', ['-p', join(home, 'Library', 'Logs', 'nyan-remote')])
    const filler = 'x'.repeat(100)
    const lines = Array.from({ length: 1000 }, (_, i) => `${i} ${filler}`)
    lines.push('[keys] 最後の送信')
    writeFileSync(log, lines.join('\n'))
    const got = recentLogLines('launchd', home)
    assert.equal(got.at(-1), '[keys] 最後の送信')
    // ⚠️ We started mid-file, so the first line is a complete line
    assert.match(got[0], /^\d+ x+$/)
    assert.ok(got.length < lines.length, 'read the whole file')
    // ⚠️ Empty if unreadable (do not stop the diagnosis)
    assert.deepEqual(recentLogLines('launchd', join(home, 'nope')), [])
    assert.deepEqual(recentLogLines('none', home), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

/** Fake launchctl: lingers for `goneAfter` prints after bootout / refuses bootstrap `failFirst` times */
function fakeLaunchctl({ goneAfter = 0, failFirst = 0, loaded = true } = {}) {
  const calls = []
  let present = loaded
  let prints = 0
  let bootstrapFails = failFirst
  const run = (argv) => {
    calls.push(argv.join(' '))
    const [verb] = argv
    if (verb === 'bootout') {
      if (!present) throw Object.assign(new Error('no such'), { stderr: 'Boot-out failed: 3' })
      prints = goneAfter
      return ''
    }
    if (verb === 'print') {
      if (!present) throw new Error('not found')
      if (prints-- <= 0) {
        present = false
        throw new Error('not found')
      }
      return 'state = running'
    }
    if (verb === 'bootstrap') {
      // ⚠️ Bootstrapping before bootout finishes gives 5 (as on a real machine)
      if (present || bootstrapFails-- > 0) throw Object.assign(new Error('x'), { stderr: 'Bootstrap failed: 5: Input/output error' })
      present = true
      return ''
    }
    return ''
  }
  return { run, calls }
}

test('★★ install: after bootout, waits until it is gone before bootstrap (⚠️ the real-machine "Bootstrap failed: 5")', async () => {
  const f = fakeLaunchctl({ goneAfter: 3 })
  const slept = []
  await runSteps(launchctlSteps('install', 501, '/p.plist'), { run: f.run, sleep: async (ms) => slept.push(ms), target: 't' })
  const i = f.calls.findIndex((c) => c.startsWith('bootstrap'))
  assert.ok(i > 0)
  // ⚠️ "gone" is observed before bootstrap (after the last print fails)
  assert.equal(f.calls.filter((c) => c.startsWith('print')).length, 4)
  assert.equal(f.calls.slice(i).filter((c) => c.startsWith('bootstrap')).length, 1, 'should pass in one attempt')
})

test('★★ install: if still refused, retries a few times and finally throws with a reason', async () => {
  const ok = fakeLaunchctl({ failFirst: 2 })
  await runSteps(launchctlSteps('install', 501, '/p.plist'), { run: ok.run, sleep: async () => {}, target: 't' })
  assert.equal(ok.calls.filter((c) => c.startsWith('bootstrap')).length, 3)
  const ng = fakeLaunchctl({ failFirst: 99 })
  await assert.rejects(
    runSteps(launchctlSteps('install', 501, '/p.plist'), { run: ng.run, sleep: async () => {}, target: 't' }),
    /Bootstrap failed: 5/,
  )
  assert.equal(ng.calls.filter((c) => c.startsWith('bootstrap')).length, 5)
})

test('★★★ install: does not stop even if not loaded (first time)', async () => {
  const f = fakeLaunchctl({ loaded: false })
  await runSteps(launchctlSteps('install', 501, '/p.plist'), { run: f.run, sleep: async () => {}, target: 't' })
  assert.ok(f.calls.some((c) => c.startsWith('bootstrap')))
})

test('★★ stop: throws if it does not fully stop, succeeds if it was never there (codex round 15, medium #3)', async () => {
  const steps = launchctlSteps('stop', 501, '/p.plist')
  // keeps lingering
  const stuck = fakeLaunchctl({ goneAfter: 999 })
  await assert.rejects(
    runSteps(steps, { run: stuck.run, sleep: async () => {}, target: 't' }),
    /止まりきりませんでした/,
  )
  // never there (first move from no service)
  const none = fakeLaunchctl({ loaded: false })
  await runSteps(steps, { run: none.run, sleep: async () => {}, target: 't' })
  // gone after a short wait
  const slow = fakeLaunchctl({ goneAfter: 3 })
  await runSteps(steps, { run: slow.run, sleep: async () => {}, target: 't' })
  // ★ Reinstall does not throw (the bootstrap retries after it pick it up)
  const stuck2 = fakeLaunchctl({ goneAfter: 999, failFirst: 0 })
  await assert.rejects(
    runSteps(launchctlSteps('install', 501, '/p.plist'), { run: stuck2.run, sleep: async () => {}, target: 't' }),
    /Bootstrap failed/,
  )
})

test('★★★★ English: the hints and errors have no Japanese when the language is en', () => {
  setLang('en')
  try {
    for (const k of ['launchd', 'none', 'systemd']) {
      for (const v of Object.values(hints(k))) assert.doesNotMatch(v, /[぀-ヿ一-鿿]/)
    }
    assert.throws(() => launchctlSteps('nope', 501, '/p.plist'), /^Error: Unknown action: nope$/)
    assert.throws(() => buildPlist({ ...base, node: 'rel' }), /must be an absolute path/)
  } finally {
    setLang('ja')
  }
})
