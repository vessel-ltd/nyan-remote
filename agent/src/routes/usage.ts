import type { UsageResponse } from '../../../shared/types.ts'
import { discoverConfigDirs } from '../claude/configDirs.ts'
import { codexUsage } from '../codex/run.ts'
import { config } from '../config.ts'
import { claudeUsage } from '../usage.ts'

/** ★ `GET /usage`: each Claude profile's and Codex home's plan limits, as last read (`usage.ts`) */
export async function usage(): Promise<UsageResponse> {
  const dirs = await discoverConfigDirs(config().configDirs)
  const [claude, codex] = await Promise.all([claudeUsage(dirs), codexUsage()])
  return { usage: [...claude, ...codex] }
}
