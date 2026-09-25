// ★★ The language rule lives in 5 places (TS, install.sh, agent-service.sh, the generated shim, relay.py).
//   ⇒ Run all of them against **the same input table** and fail on any disagreement (2026-09-24 / codex round 22, low #3).
//   Rule: if the **first non-empty value** of NYAN_LANG > LC_ALL > LC_MESSAGES > LANG starts with `ja`, Japanese; otherwise English.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { langFromEnv } from '../shared/i18n.ts'
import { buildWrapper } from './install-relay.mjs'

const ROOT = new URL('..', import.meta.url).pathname

const CASES = [
  [{}, 'en'],
  [{ LANG: 'C.UTF-8' }, 'en'],
  [{ LANG: 'ja_JP.UTF-8' }, 'ja'],
  [{ LANG: 'JA_JP' }, 'ja'],
  [{ LANG: 'ja_JP.UTF-8', LC_ALL: 'en_US.UTF-8' }, 'en'],
  [{ LANG: 'en_US.UTF-8', LC_MESSAGES: 'ja_JP.UTF-8' }, 'ja'],
  [{ LANG: 'ja_JP.UTF-8', LC_MESSAGES: '' }, 'ja'],
  [{ LANG: 'ja_JP.UTF-8', NYAN_LANG: 'en' }, 'en'],
  [{ LANG: 'C', NYAN_LANG: 'ja' }, 'ja'],
  [{ LANG: 'C', NYAN_LANG: 'ja_JP.UTF-8' }, 'ja'],
  [{ LANG: 'ja_JP.UTF-8', NYAN_LANG: 'fr' }, 'en'],
  [{ LANG: 'ja_JP.UTF-8', NYAN_LANG: '' }, 'ja'],
]

const clean = (env) => ({ PATH: process.env.PATH, ...env })

/** Cut out the shell's decision block (from `case "${NYAN_LANG:-…` to the `tr2() {` line) */
function shellBlock(file) {
  const src = readFileSync(join(ROOT, file), 'utf8')
  const start = src.indexOf('case "${NYAN_LANG:-')
  assert.ok(start > 0, `${file}: language decision not found`)
  return src.slice(start, src.indexOf('\n', src.indexOf('tr2() {', start)))
}

const IMPLS = {
  'shared/i18n.ts': (env) => langFromEnv(env),
  'install.sh': (env) => execFileSync('bash', ['-c', `set -euo pipefail\n${shellBlock('install.sh')}\ntr2 ja en`], { encoding: 'utf8', env: clean(env), stdio: ['ignore', 'pipe', 'ignore'] }),
  'agent-service.sh': (env) =>
    execFileSync('sh', ['-c', `set -eu\n${shellBlock('scripts/agent-service.sh')}\ntr2 ja en`], { encoding: 'utf8', env: clean(env), stdio: ['ignore', 'pipe', 'ignore'] }),
  shim: (env) => {
    const w = buildWrapper({ real: '/nonexistent', relay: '/nonexistent' })
    const fn = w.slice(w.indexOf('_ta_ja() {'), w.indexOf('\n}\n', w.indexOf('_ta_ja() {')) + 2)
    return execFileSync('sh', ['-c', `set -u\n${fn}\nif _ta_ja; then printf ja; else printf en; fi`], { encoding: 'utf8', env: clean(env), stdio: ['ignore', 'pipe', 'ignore'] })
  },
  'relay.py': (env) =>
    execFileSync('python3', ['-c', `import sys; sys.argv=['x']; import importlib.util as u; s=u.spec_from_file_location('r', ${JSON.stringify(join(ROOT, 'scripts/relay.py'))}); m=u.module_from_spec(s); s.loader.exec_module(m); print(m._lang(), end='')`], { encoding: 'utf8', env: clean(env), stdio: ['ignore', 'pipe', 'ignore'] }),
}

for (const [name, impl] of Object.entries(IMPLS)) {
  test(`★★ language rule: ${name} gives the same answers for the same input table`, () => {
    for (const [env, want] of CASES) assert.equal(impl(env), want, `${name} ${JSON.stringify(env)}`)
  })
}
