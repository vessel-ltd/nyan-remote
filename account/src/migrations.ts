// ★ Which D1 migrations are not applied yet (2026-11-26 / `account/deploy.mjs`).
//   codex: answering No to `wrangler d1 migrations apply` still exits 0, so `apply && deploy` shipped a Worker whose columns
//   did not exist (webhooks 500, the hourly upkeep aborted). ⇒ ask D1 what is applied and compare with the files.

/** Migration files (`NNNN_name.sql`) that are not in `applied` (the `name` column of wrangler's `d1_migrations` table) */
export function missingMigrations(files: readonly string[], applied: readonly string[]): string[] {
  const done = new Set(applied)
  return files.filter((f) => /^\d{4}_.+\.sql$/.test(f) && !done.has(f)).sort()
}

/**
 * ★ Did `wrangler deploy` really deploy this Worker? Reads the structured output (`WRANGLER_OUTPUT_FILE_PATH`, one JSON
 *   object per line) for a `deploy` entry of `worker` with a version id (codex: answering No to a wrangler prompt can exit 0
 *   without deploying). ⚠️ Unreadable lines are skipped; no matching entry = not deployed.
 */
export function deployedVersion(ndjson: string, worker: string): string | undefined {
  for (const line of ndjson.split('\n')) {
    let o: unknown
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const e = o as Record<string, unknown> | null
    if (e?.['type'] === 'deploy' && e['worker_name'] === worker && typeof e['version_id'] === 'string' && e['version_id']) return e['version_id']
  }
  return undefined
}

/**
 * ★ The names in `wrangler d1 execute --json` output (`[{ results: [{ name }], success }]`).
 *   ⚠️ Anything else throws (a deploy must not go on from an answer it could not read).
 */
export function appliedFromJson(text: string): string[] {
  const start = text.indexOf('[')
  if (start < 0) throw new Error('no JSON in the wrangler output')
  const parsed: unknown = JSON.parse(text.slice(start))
  const first = Array.isArray(parsed) ? (parsed[0] as Record<string, unknown> | undefined) : undefined
  if (!first || first['success'] !== true || !Array.isArray(first['results'])) throw new Error('unexpected wrangler output')
  return (first['results'] as unknown[]).map((r) => {
    const name = (r as Record<string, unknown> | null)?.['name']
    if (typeof name !== 'string') throw new Error('unexpected migration row')
    return name
  })
}
