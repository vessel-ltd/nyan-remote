import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { asBuildInfo, parseRelease, type BuildInfo } from '../../shared/release.ts'

export const AGENT_VERSION = '0.0.0-m0'

/**
 * ★★ This agent's version (2026-09-24 / what the screen uses to show "this machine is outdated ⇒ nyan update").
 *   Installer-based machines read `RELEASE` in the tree; git working trees use `git`. ⚠️ **Read only once, at startup**
 *   (the version of the code that is running now ⇒ a machine that ran `git pull` but did not restart is correctly reported as old).
 * ⚠️ undefined if it cannot be read (the screen shows no hint ⇒ fail-quiet).
 */
let cached: BuildInfo | undefined | null = null

// ⚠️ `.pathname` keeps `%20` (RELEASE cannot be read under paths with spaces or Japanese) ⇒ `fileURLToPath`
export function agentBuild(root = fileURLToPath(new URL('../..', import.meta.url))): BuildInfo | undefined {
  if (cached !== null) return cached
  cached = readBuild(root)
  return cached
}

function readBuild(root: string): BuildInfo | undefined {
  try {
    const rel = parseRelease(readFileSync(`${root}/RELEASE`, 'utf8'))
    if (rel) return rel
  } catch {
    // no RELEASE ⇒ a git working tree
  }
  try {
    const out = execFileSync('git', ['-C', root, 'log', '-1', '--format=%h%n%cI'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
    const [commit, committedAt] = out.trim().split('\n')
    return asBuildInfo({ commit, committedAt })
  } catch {
    return undefined
  }
}
