// Timestamps for `npm run traffic -- --since/--until`.
//
// ⚠️⚠️ **The records' `at` is UTC** (`toISOString`), but the arguments are local time.
//    ⇒ Always convert here (on 2026-09-01 passing JST produced "0 records after the fix" / `149e2c7`).
// ⚠️ **Split out of `scripts/traffic.mjs`** so it can be tested
//    (2026-09-01 codex round 3: the mutation `+mo - 1` → `+mo` survived).

const SHAPE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::(\d{2})(?::(\d{2}))?)?)?$/

/**
 * Convert a local-time string to a UTC ISO string.
 *
 * @returns `{ iso, shown }`. `null` if unparseable or the date/time does not exist
 *   (⚠️ **never silently fall back to "all records"**; the caller stops with exit code 2)
 */
export function toUtcBound(raw) {
  const m = SHAPE.exec(raw)
  if (!m) return null
  const [, y, mo, d, hh, mi, ss] = m
  const p = [+y, +mo, +d, +(hh ?? 0), +(mi ?? 0), +(ss ?? 0)]
  const local = new Date(p[0], p[1] - 1, p[2], p[3], p[4], p[5], 0)
  // ⚠️⚠️ **`Date` normalizes silently** (`2026-02-31` → March 3 / `24:00` → next day /
  //    times skipped by DST → off by an hour). ⇒ **Check that the value round-trips unchanged**
  //    (`Number.isNaN` does not catch it / codex round 3, low #2).
  const back = [
    local.getFullYear(),
    local.getMonth() + 1,
    local.getDate(),
    local.getHours(),
    local.getMinutes(),
    local.getSeconds(),
  ]
  if (back.some((v, i) => v !== p[i])) return null
  return { iso: local.toISOString(), shown: raw }
}
