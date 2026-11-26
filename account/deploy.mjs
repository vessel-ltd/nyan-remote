#!/usr/bin/env node
// ★ `npm run deploy` for the account Worker (2026-11-26 / codex):
//   ① apply D1 migrations ② ask D1 which are applied and stop if any file is missing (answering No to ① still exits 0)
//   ③ deploy ④ after the old version has drained, ask for a re-read of **every account with a Stripe customer**
//      (`sync_wanted + 1` = pending for the hourly upkeep, whatever its status): an old Worker still running during the
//      rollout may have written a stale state, and Checkouts handed out before this version have no watch.
//   ⚠️ Uses the wrangler of `relay/` (the account tree has no dependencies of its own). Profile: the one bound to this tree.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appliedFromJson, deployedVersion, missingMigrations } from './src/migrations.ts'

const cwd = fileURLToPath(new URL('.', import.meta.url))
const wrangler = fileURLToPath(new URL('../relay/node_modules/.bin/wrangler', import.meta.url))
const DB = 'nyan-account'
/** The Worker's name (`wrangler.jsonc`) */
const WORKER = 'nyan-account'
/** ⚠️ How long an old version may keep serving after a deploy (requests in flight; Stripe calls are cut at 10 s) */
const DRAIN_MS = 60_000

function step(args, capture = false, env = process.env) {
  const r = spawnSync(wrangler, args, { cwd, env, stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8' })
  if (r.status !== 0) {
    console.error(`✖ wrangler ${args.slice(0, 3).join(' ')} failed (exit ${r.status})`)
    process.exit(1)
  }
  return r.stdout ?? ''
}

step(['d1', 'migrations', 'apply', DB, '--remote'])
const applied = appliedFromJson(step(['d1', 'execute', DB, '--remote', '--json', '--command', 'SELECT name FROM d1_migrations'], true))
const missing = missingMigrations(readdirSync(new URL('./migrations/', import.meta.url)), applied)
if (missing.length) {
  console.error(`✖ Not deploying: D1 migrations not applied: ${missing.join(', ')}`)
  process.exit(1)
}
// ★ Confirm the deploy from wrangler's structured output (a declined prompt can exit 0 without deploying / codex)
const outDir = mkdtempSync(join(tmpdir(), 'nyan-account-deploy-'))
const outFile = join(outDir, 'out.ndjson')
let version
try {
  step(['deploy'], false, { ...process.env, WRANGLER_OUTPUT_FILE_PATH: outFile })
  version = deployedVersion((() => {
    try {
      return readFileSync(outFile, 'utf8')
    } catch {
      return ''
    }
  })(), WORKER)
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
if (!version) {
  console.error('✖ wrangler did not report a deployed version: nothing more was changed')
  process.exit(1)
}
console.log(`✔ Deployed version ${version}`)
console.log(`… waiting ${DRAIN_MS / 1000} s for the old version to drain, then asking for a re-read of every customer`)
await new Promise((ok) => setTimeout(ok, DRAIN_MS))
step(['d1', 'execute', DB, '--remote', '--command', 'UPDATE accounts SET sync_wanted = COALESCE(sync_wanted, 0) + 1 WHERE stripe_customer IS NOT NULL'])
console.log('✔ Deployed. The hourly upkeep re-reads every customer from Stripe over the next hours.')
