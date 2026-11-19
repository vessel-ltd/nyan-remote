import type { UsageResponse } from '../../../shared/types.ts'
import { discoverConfigDirs } from '../claude/configDirs.ts'
import { codexUsage } from '../codex/run.ts'
import { agyDir, agyUsage, readAgyFiles } from '../agy/sessions.ts'
import { config } from '../config.ts'
import { claudeUsage } from '../usage.ts'

/** ★ `GET /usage`: each Claude profile's and Codex home's plan limits, as last read (`usage.ts`) */
export async function usage(): Promise<UsageResponse> {
  const dirs = await discoverConfigDirs(config().configDirs)
  const [claude, codex, agyFiles] = await Promise.all([claudeUsage(dirs), codexUsage(), readAgyFiles(agyDir())])
  // ★ agy: the newest status line reading of any conversation (live or not: the quota is the account's / docs/AGY.md)
  const agy = agyUsage(agyFiles, Date.now())
  return { usage: [...claude, ...codex, ...(agy ? [agy] : [])] }
}
