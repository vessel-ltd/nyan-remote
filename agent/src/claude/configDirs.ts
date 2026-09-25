import { homedir } from 'node:os'
import { join } from 'node:path'
import { readdir, readFile, stat } from 'node:fs/promises'

export interface ConfigDir {
  /** e.g. '.claude' / '.claude-r'. The basename of CLAUDE_CONFIG_DIR */
  account: string
  dir: string
  projectsDir: string
  /**
   * oauthAccount.emailAddress from .claude.json.
   * ⚠️ Stale values linger, so never use this for anything but display (ARCHITECTURE.md §10).
   * When a decision depends on it, use `claude auth status` (live).
   */
  loginCached?: string
}

const NAME = /^\.claude(-[A-Za-z0-9._-]+)?$/

/**
 * Decide which CLAUDE_CONFIG_DIRs to watch.
 * If explicit is null, automatically adopt every ~/.claude* that has a projects/ directory.
 */
export async function discoverConfigDirs(explicit: string[] | null): Promise<ConfigDir[]> {
  const candidates: string[] = []
  if (explicit && explicit.length > 0) {
    candidates.push(...explicit)
  } else {
    const home = homedir()
    let entries: string[] = []
    try {
      entries = await readdir(home)
    } catch {
      return []
    }
    for (const name of entries.sort()) {
      if (NAME.test(name)) candidates.push(join(home, name))
    }
  }

  const found: ConfigDir[] = []
  for (const dir of candidates) {
    const projectsDir = join(dir, 'projects')
    try {
      const s = await stat(projectsDir)
      if (!s.isDirectory()) continue
    } catch {
      continue
    }
    found.push({
      account: dir.split('/').filter(Boolean).pop() ?? dir,
      dir,
      projectsDir,
      loginCached: await readCachedLogin(dir),
    })
  }
  return found
}

async function readCachedLogin(dir: string): Promise<string | undefined> {
  const path = join(dir, '.claude.json')
  try {
    const s = await stat(path)
    // About 168KB is normal. Do not read abnormally large files
    if (s.size > 5 * 1024 * 1024) return undefined
    const parsed = JSON.parse(await readFile(path, 'utf8')) as {
      oauthAccount?: { emailAddress?: string }
    }
    return parsed.oauthAccount?.emailAddress
  } catch {
    return undefined
  }
}
