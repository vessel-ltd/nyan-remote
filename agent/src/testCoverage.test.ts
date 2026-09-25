// ★★ **Never create a test file that no runner picks up** (actually hit on 2026-08-24).
//
// ⚠️⚠️ I wrote `shared/head.test.ts` and saw green, but `npm test` only looked at
//    `agent/src/**` and `web/src/**`, so **5 tests had never run once**.
//    ⚠️ This is the worst form of "false green" (you think there are tests and there are **zero**).
//    And it was noticed by chance (investigated because a mutation did not fail). ⇒ **Check it by machine.**

import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const ROOT = new URL('../../', import.meta.url).pathname
const SKIP = new Set(['node_modules', 'dist', '.git', 'backups', '.claude'])

/** Collect every `*.test.ts` in the repository (relative paths) */
function collect(dir: string, rel = ''): string[] {
  const out: string[] = []
  for (const name of readdirSync(join(ROOT, dir))) {
    if (SKIP.has(name)) continue
    const r = rel ? `${rel}/${name}` : name
    const abs = join(ROOT, dir, name)
    if (statSync(abs).isDirectory()) out.push(...collect(join(dir, name), r))
    else if (name.endsWith('.test.ts')) out.push(r)
  }
  return out
}

/**
 * ★★ Collect only the globs that **really run from `npm test`** (2026-08-24 codex medium #1, #2).
 *
 * ⚠️⚠️ Rebuilt twice:
 *   1. First it "looked at every script" ⇒ **a mutation removing it from `test` stayed green**
 *   2. Next it "picked up `npm run` with a regex" ⇒ **a mutation changing `&&` to `||` stayed green**
 *      (measured: with `||`, shared did not run, yet the meta-test picked up the name and counted it as "runs")
 * ⇒ **Follow only complete commands separated by `&&`**. If `||` / `;` / `|` / `&` appear,
 *   **fail-closed** (give up interpreting and throw = never silently count it as "runs").
 */
class UnsupportedScript extends Error {}

function commandsOf(cmd: string): string[] {
  // ⚠️ control structures other than `&&` are not interpreted (a person looks when they appear)
  if (/(\|\||;|(?<!&)&(?!&)|\||`|\$\()/.test(cmd.replace(/&&/g, ''))) {
    throw new UnsupportedScript(cmd)
  }
  return cmd
    .split('&&')
    .map((c) => c.trim())
    .filter(Boolean)
}

function reachableGlobs(): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const visit = (workspace: string, script: string): void => {
    const key = `${workspace}#${script}`
    if (seen.has(key)) return
    seen.add(key)
    const pkgPath = workspace ? join(ROOT, workspace, 'package.json') : join(ROOT, 'package.json')
    let pkg: { scripts?: Record<string, string> }
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> }
    } catch {
      return
    }
    const cmd = pkg.scripts?.[script]
    if (!cmd) return
    for (const one of commandsOf(cmd)) {
      const test = /^node --test '([^']+)'$/.exec(one)
      if (test) {
        out.push(workspace ? `${workspace}/${test[1]!}` : test[1]!)
        continue
      }
      const run = /^npm run ([\w:-]+)(?:\s+--workspace\s+([\w-]+))?$/.exec(one)
      if (run) {
        visit(run[2] ?? workspace, run[1]!)
        continue
      }
      // ⚠️ unknown commands (`npm install` etc.) can be ignored, but
      //    **if it contains `node --test` in an unexpected shape**, give up interpreting
      if (one.includes('node --test')) throw new UnsupportedScript(one)
    }
  }
  visit('', 'test')
  return out
}

/** Whether it matches a glob (⚠️ `two stars` cross directory levels. Do not write an example with a closing mark on this line) */
function matches(glob: string, path: string): boolean {
  const re = new RegExp(
    `^${glob
      .split('/')
      .map((seg) => (seg === '**' ? '(?:.+)' : seg.replace(/\*/g, '[^/]*').replace(/\./g, '\\.')))
      .join('/')
      .replace('/(?:.+)/', '(?:/.+)?/')}$`,
  )
  return re.test(path)
}

test('★★★ every *.test.ts runs under npm test (no test that never runs)', () => {
  const files = collect('.')
  const gs = reachableGlobs()
  assert.ok(files.length > 20, `too few test files (not collected): ${files.length}`)
  assert.ok(gs.length >= 3, `globs not collected: ${JSON.stringify(gs)}`)
  // ★ this checks not "the script exists" but "**reachable from `npm test` via `&&`**".
  //   ⚠️ all three runners are connected (kills mutations removing any of them).
  //      ★ **this guard itself is inside the agent suite**, so if agent is removed
  //        the guard stops running too ⇒ it is also run directly at the start of the root `test`
  //        (`test:guard`). Both together protect it.
  for (const prefix of ['agent/', 'web/', 'shared/']) {
    assert.ok(
      gs.some((g) => g.startsWith(prefix)),
      `${prefix} tests are not reachable from npm test: ${JSON.stringify(gs)}`,
    )
  }
  const orphans = files.filter((f) => !gs.some((g) => matches(g, f)))
  assert.deepEqual(
    orphans,
    [],
    `⚠️⚠️ some tests are picked up by no runner (never run once):\n${orphans.join('\n')}\nglob: ${gs.join(' / ')}`,
  )
})

test('★★ joins other than `&&` are not counted as "runs" (fail-closed)', () => {
  // ⚠️⚠️ this is exactly the 2026-08-24 mutation: changing `A && B` to `A || B` means B does not run, yet
  //    the old implementation picked up the name and counted it as "runs".
  assert.deepEqual(commandsOf('npm run a && npm run b'), ['npm run a', 'npm run b'])
  for (const bad of [
    'npm run a || npm run b',
    'npm run a; npm run b',
    'npm run a & npm run b',
    'npm run a | tee log',
    'node --test `echo x`',
  ]) {
    assert.throws(() => commandsOf(bad), UnsupportedScript, `interpreted it anyway: ${bad}`)
  }
})

test('★ check the decision itself (glob matching is not broken)', () => {
  // ⚠️ the test above checks "no orphans", so it would be **green even if matching always returned true**.
  //    ⇒ pin the negative side of the match function too (closes a fail-open in the diagnostics)
  assert.equal(matches('agent/src/**/*.test.ts', 'agent/src/claude/keys.test.ts'), true)
  assert.equal(matches('agent/src/**/*.test.ts', 'agent/src/config.test.ts'), true)
  assert.equal(matches('shared/**/*.test.ts', 'shared/head.test.ts'), true)
  assert.equal(matches('agent/src/**/*.test.ts', 'web/src/ui/stop.test.ts'), false)
  assert.equal(matches('shared/**/*.test.ts', 'agent/src/config.test.ts'), false)
})
