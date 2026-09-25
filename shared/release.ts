// ★★ Version stamp and the "is it older" decision (2026-09-24 / update prompts). The agent, the PWA and distribution all use this one file.
//
// A version has the shape of `RELEASE` (line 1 = short commit hash, line 2 = build time, line 3 = commit time).
//   ⚠️ Line 3 was added on 2026-09-24 (older RELEASE files lack it ⇒ compare by line 2).
//
// ⚠️⚠️ **Decide by "older", not by "different"**: a development machine (a git working tree) is often **newer** than the release.
//    Saying "please update" just because the version strings differ would be false.
// ⚠️⚠️ **If unsure, do not prompt** (unreadable dates, or not enough to compare ⇒ false). A wrong nag only erodes trust,
//    and not showing it leaves things as before (fail-quiet).
// ⚠️ These values come from outside (the distribution's RELEASE, the agent's /health), so **never throw, never fall back to defaults**.

export interface BuildInfo {
  /** Short commit hash (⚠️ ends with `+` if the working tree is dirty) */
  commit: string
  /** Commit time (ISO). ⚠️ May be missing */
  committedAt?: string
  /** Build time (ISO / when the tarball was made). ⚠️ Absent in a git working tree */
  builtAt?: string
}

const COMMIT = /^[0-9a-f]{7,40}\+?$/
const validDate = (s: unknown): s is string => typeof s === 'string' && s.length <= 40 && !Number.isNaN(Date.parse(s))

/** ★ Accept an outside value as a version stamp (undefined if the shape is wrong) */
export function asBuildInfo(v: unknown): BuildInfo | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const o = v as Record<string, unknown>
  if (typeof o['commit'] !== 'string' || !COMMIT.test(o['commit'])) return undefined
  return {
    commit: o['commit'],
    ...(validDate(o['committedAt']) ? { committedAt: o['committedAt'] } : {}),
    ...(validDate(o['builtAt']) ? { builtAt: o['builtAt'] } : {}),
  }
}

/** ★ Parse the contents of `RELEASE` */
export function parseRelease(text: unknown): BuildInfo | undefined {
  if (typeof text !== 'string' || text.length > 400) return undefined
  const [commit, builtAt, committedAt] = text.split('\n').map((l) => l.trim())
  return asBuildInfo({ commit, builtAt, committedAt })
}

/** ★ Write the contents of `RELEASE` (`scripts/pack.mjs`) */
export function formatRelease(b: Required<BuildInfo>): string {
  return `${b.commit}\n${b.builtAt}\n${b.committedAt}\n`
}

const bare = (c: string) => c.replace(/\+$/, '')

/**
 * ★★ Is `mine` older than `latest` (= should we prompt an update)?
 *   Compares the **commit time** (if both have it), otherwise the **build time** (if both have it). If neither, false.
 *   ⚠️ The same commit is not older (differing short-hash lengths still count as the same by prefix match).
 */
export function isBehind(mine: BuildInfo | undefined, latest: BuildInfo | undefined): boolean {
  if (!mine || !latest) return false
  const a = bare(mine.commit)
  const b = bare(latest.commit)
  if (a.startsWith(b) || b.startsWith(a)) return false
  const key: 'committedAt' | 'builtAt' | undefined =
    mine.committedAt && latest.committedAt ? 'committedAt' : mine.builtAt && latest.builtAt ? 'builtAt' : undefined
  if (!key) return false
  return Date.parse(mine[key]!) < Date.parse(latest[key]!)
}
