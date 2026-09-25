// ★ Was this run directly? (2026-09-24 / codex round 24, medium #2). ⚠️ Compare **real paths**:
//   comparing with `file://${argv[1]}` missed paths containing spaces or Japanese (`%20` etc. in a URL) and calls through a link
//   (Node loads the real path), so it **did nothing and exited 0**.
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function isMain(argv1, metaUrl) {
  try {
    return typeof argv1 === 'string' && realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl))
  } catch {
    return false
  }
}
