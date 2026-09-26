// ★ The release gate on runtime dependencies (`scripts/lib/audit.mjs`).
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { auditArgs, auditEnv, auditVerdict, isolationArgs, lockMismatches, lsArgs, npmrcInRepo, PUBLIC_REGISTRY, requireAudit, unlistedInstalls } from './lib/audit.mjs'

const report = (vulns, names = []) =>
  JSON.stringify({ vulnerabilities: Object.fromEntries(names.map((n) => [n, {}])), metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, ...vulns } } })

test('★ nothing, or only low/info, passes', () => {
  assert.equal(auditVerdict(report({})).ok, true)
  assert.equal(auditVerdict(report({ low: 2, info: 1 }, ['x'])).ok, true)
})

test('★★ moderate, high or critical blocks', () => {
  for (const k of ['moderate', 'high', 'critical']) {
    const v = auditVerdict(report({ [k]: 1 }, ['web-push']))
    assert.equal(v.ok, false, k)
    assert.deepEqual(v.names, ['web-push'])
  }
})

test('★★ anything that is not a complete report is "unavailable", never a pass (codex: partial shapes read as clean)', () => {
  const bad = [
    '', 'npm ERR! network', 'null', '[]', '{}', '{"metadata":{}}',
    '{"metadata":{"vulnerabilities":{}}}',
    '{"metadata":{"vulnerabilities":[]}}',
    report({ high: 'bad' }), report({ high: -1 }), report({ high: 1.5 }),
    JSON.stringify({ error: { code: 'ENOAUDIT' }, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } } }),
  ]
  for (const out of bad) {
    const v = auditVerdict(out)
    assert.equal(v.ok, false, out)
    assert.equal(v.unavailable, true, out)
  }
})

test('★★ the selection is forced: explicit workspace flags, and no npm selection settings reach the child (codex)', () => {
  // ⚠️ every workspace is named (an .npmrc `workspace=web` survived a bare --workspaces and dropped the agent / codex round 2)
  assert.deepEqual(auditArgs(['agent', 'web']), ['audit', '--omit=dev', '--workspace', 'agent', '--workspace', 'web', '--include-workspace-root', '--json'])
  assert.throws(() => auditArgs([]))
  // ★★ none of the machine's npm configuration reaches the child, except network plumbing (codex rounds 2-6: one more setting each time)
  const env = auditEnv({ PATH: '/bin', HTTPS_PROXY: 'http://p', npm_config_workspaces: 'false', NPM_CONFIG_WORKSPACE: 'web', npm_config_offline: 'true', npm_config_userconfig: '/evil', npm_config_registry: 'https://r.example', npm_config_https_proxy: 'http://p', npm_config_cafile: '/ca.pem' })
  assert.deepEqual(Object.keys(env).sort(), ['HTTPS_PROXY', 'PATH', 'npm_config_cafile', 'npm_config_https_proxy'])
  assert.deepEqual(isolationArgs('/tmp/x', '/r'), ['--userconfig=/tmp/x/user.npmrc', '--globalconfig=/tmp/x/global.npmrc', '--prefix=/r', `--registry=${PUBLIC_REGISTRY}`, '--offline=false', '--prefer-online'])

  assert.deepEqual(npmrcInRepo('/r', ['agent', 'web'], (p) => p === '/r/web/.npmrc'), ['/r/web/.npmrc'])
})

test('★★ an installation that differs from the lockfile is caught before anything ships (codex: pack copies node_modules)', () => {
  const files = {
    [join('/r', 'package-lock.json')]: JSON.stringify({
      packages: {
        '': {},
        'node_modules/web-push': { version: '3.6.7' },
        'node_modules/preact': { version: '10.29.8' },
        'node_modules/vite': { version: '7.0.0', dev: true },
        'node_modules/agent': { link: true },
        'web/node_modules/preact': { version: '10.30.0' },
        'node_modules/fsevents': { version: '2.3.3', optional: true },
      },
    }),
    [join('/r', 'node_modules/web-push/package.json')]: '{"version":"3.6.6"}',
    [join('/r', 'node_modules/preact/package.json')]: '{"version":"10.29.8"}',
    [join('/r', 'web/node_modules/preact/package.json')]: '{"version":"10.29.9"}',
  }
  const read = (p) => {
    if (!(p in files)) throw new Error('ENOENT')
    return files[p]
  }
  assert.deepEqual(
    lockMismatches('/r', read),
    ['web-push: installed 3.6.6, lockfile 3.6.7', 'preact: installed 10.29.9, lockfile 10.30.0'],
    'dev entries, workspace links and an absent optional package are not mismatches; a workspace-local copy is checked (codex round 2)',
  )
  files[join('/r', 'node_modules/fsevents/package.json')] = '{"version":"2.3.2"}'
  assert.equal(lockMismatches('/r', read).length, 3, 'an optional package that is installed is still checked')
  delete files[join('/r', 'node_modules/preact/package.json')]
  assert.equal(lockMismatches('/r', read).length, 4, 'a missing required runtime package is a mismatch')
})

test('★★ a leftover install the lockfile does not list is caught (codex round 3: stale web/node_modules/preact)', () => {
  const lock = { packages: { '': {}, 'node_modules/preact': { version: '10.29.8' }, 'node_modules/@nyan-remote/web': { link: true } } }
  const ls = ['/r', '/r/node_modules/@nyan-remote/web', '/r/node_modules/preact', '/r/web/node_modules/preact', ''].join('\n')
  assert.deepEqual(unlistedInstalls('/r', ls, lock), ['web/node_modules/preact: installed but not in package-lock.json'])
  // ⚠️ depth and output format are forced (an inherited depth=0 / long=true broke the listing / codex round 4)
  assert.deepEqual(lsArgs(['agent', 'web']), ['ls', '--omit=dev', '--all', '--depth=Infinity', '--parseable', '--long=false', '--json=false', '--package-lock-only=false', '--workspace', 'agent', '--workspace', 'web', '--include-workspace-root'])
  assert.deepEqual(Object.keys(auditEnv({ npm_config_depth: '0', npm_config_long: 'true', NPM_CONFIG_JSON: 'true', HOME: '/h' })), ['HOME'])
})

test('★ requireAudit: reads the JSON though npm exits 1, stops on drift, errors and signals, and --skip-audit runs nothing', () => {
  const exit = process.exit
  const codes = []
  process.exit = (c) => { codes.push(c); throw new Error('exit') }
  const quiet = { log: console.log, error: console.error, warn: console.warn }
  console.log = console.error = console.warn = () => {}
  const pkg = JSON.stringify({ workspaces: ['agent', 'web'] })
  const clean = (p) => (p.endsWith('package-lock.json') ? JSON.stringify({ packages: {} }) : pkg)
  // ★ one fake npm: `ls` prints the tree (here just the root), `audit` prints the given report
  const npm = (auditOut, extra = {}, lsOut = '/r\n') => (_cmd, args) => (args[0] === 'ls' ? { stdout: lsOut, status: 0 } : { stdout: auditOut, status: 1, ...extra })
  try {
    requireAudit('/r', { read: clean, run: npm(report({ low: 1 })) })
    assert.throws(() => requireAudit('/r', { read: clean, run: npm(report({ high: 1 }, ['a'])) }))
    assert.throws(() => requireAudit('/r', { read: clean, run: npm('') }))
    assert.throws(() => requireAudit('/r', { read: clean, run: npm(report({}), { signal: 'SIGTERM' }) }))
    assert.throws(() => requireAudit('/r', { read: clean, run: npm(report({}), { error: new Error('ENOENT npm') }) }))
    // a drifted version, a leftover install, and an npm ls that prints nothing all stop before the audit
    const noAudit = (lsOut) => (_c, args) => { if (args[0] === 'ls') return { stdout: lsOut, status: 1 }; throw new Error('must not audit') }
    const drift = (p) => (p.endsWith('package-lock.json') ? JSON.stringify({ packages: { 'node_modules/x': { version: '2.0.0' } } }) : p.endsWith('/r/package.json') ? pkg : '{"version":"1.0.0"}')
    assert.throws(() => requireAudit('/r', { read: drift, run: noAudit('/r\n') }))
    assert.throws(() => requireAudit('/r', { read: clean, run: noAudit('/r\n/r/web/node_modules/preact\n') }))
    assert.throws(() => requireAudit('/r', { read: clean, run: noAudit('') }))
    // an .npmrc inside the repository could change what the audit looks at ⇒ stop before running npm
    assert.throws(() => requireAudit('/r', { read: clean, exists: (p) => p === join('/r', '.npmrc'), run: () => { throw new Error('must not run') } }))
    // every npm call carries the isolation flags
    const seen = []
    requireAudit('/r', { read: clean, run: (_c, args) => (seen.push(args), npm(report({}))(_c, args)) })
    assert.ok(seen.length === 2 && seen.every((a) => a.some((x) => x.startsWith('--userconfig=')) && a.some((x) => x.startsWith('--globalconfig=')) && a.includes(`--registry=${PUBLIC_REGISTRY}`)))
    // ★ installed: false (publish:public) runs only the audit: no node_modules reads, no npm ls
    const calls = []
    const lockOnly = (p) => { if (p.includes('node_modules')) throw new Error('must not read node_modules'); return clean(p) }
    requireAudit('/r', { installed: false, read: lockOnly, run: (_c, args) => (calls.push(args[0]), npm(report({}))(_c, args)) })
    assert.deepEqual(calls, ['audit'])
    requireAudit('/r', { skip: true, read: () => { throw new Error('must not read') }, run: () => { throw new Error('must not run') } })
    assert.deepEqual(codes, [1, 1, 1, 1, 1, 1, 1, 1])
  } finally {
    process.exit = exit
    Object.assign(console, quiet)
  }
})
