// ★★ Update notices (2026-09-24 / user request): "the app is old ⇒ reload", "this machine is old ⇒ nyan update on the PC".
//   The decision is this one file (the screen is `UpdateBanner.tsx`). The comparison rule is `isBehind` in `shared/release.ts` (**only when older**).
//
// ⚠️⚠️ Not a notification (iPhone ignores tag replacement and they pile up / CLAUDE.md §2) ⇒ just a one-line banner in the list.
// ⚠️ Closed with ✕ ⇒ hidden for **24 hours** (shown again if still old). If the content changes, shown without waiting.
// ⚠️ Nothing is announced when unknown (distribution version unavailable, agent does not report a version = old agent).

import { asBuildInfo, isBehind, type BuildInfo } from '../../../shared/release.ts'

export interface MachineBuild {
  name: string
  /** `/health` `build` (⚠️ an external value ⇒ passed through `asBuildInfo` here) */
  build: unknown
}

export interface UpdatePlan {
  /** This app (PWA) is older than the distribution origin */
  app: boolean
  /** Machines running an older version than the distribution origin (sorted by name, no duplicates) */
  machines: string[]
  /** ★ Key that remembers the dismissal (different content = different key ⇒ shown again) */
  key: string
}

export function planUpdates(o: {
  self: BuildInfo | null | undefined
  latest: BuildInfo | undefined
  machines: readonly MachineBuild[]
}): UpdatePlan | undefined {
  if (!o.latest) return undefined
  const app = isBehind(o.self ?? undefined, o.latest)
  const machines = [...new Set(o.machines.filter((m) => isBehind(asBuildInfo(m.build), o.latest)).map((m) => m.name))].sort()
  if (!app && machines.length === 0) return undefined
  return { app, machines, key: `${o.latest.commit}|${app ? 'app' : ''}|${machines.join(',')}` }
}

/** ★ Where the dismissal mark is stored (⚠️ browser-side keys stay `tmux-agent.` / CLAUDE.md §0) */
export const UPDATE_DISMISSED_KEY = 'tmux-agent.update-dismissed.v1'

/**
 * ★★ How long ✕ hides it (2026-09-24 / user decision). "Not today" = if still old after 24 hours, show again.
 *   ⚠️ It used to be "never again for the same content" ⇒ close it and forget, and that machine silently stays old.
 *   ★ If the content changes (new version, more old machines), show without waiting (the key changes).
 */
export const UPDATE_SNOOZE_MS = 24 * 60 * 60 * 1000

/** ★ Shape of the dismissal mark (`{ key, at }`) */
export function dismissRecord(key: string, now: number): string {
  return JSON.stringify({ key, at: now })
}

/**
 * ★ Decide from the dismissal mark whether to hide now. ⚠️ Unreadable, old shape (bare key string) or a future time ⇒ **do not hide**
 *   (err on showing too much = never miss an update / a clock set back cannot hide it forever).
 */
export function isSnoozed(stored: string | null, key: string, now: number): boolean {
  if (!stored) return false
  try {
    const v = JSON.parse(stored) as { key?: unknown; at?: unknown }
    if (v?.key !== key || typeof v.at !== 'number') return false
    const age = now - v.at
    return age >= 0 && age < UPDATE_SNOOZE_MS
  } catch {
    return false
  }
}

/**
 * ★★ The one who asks the distribution origin for its version (2026-09-24 / codex round 23, low #5). **One for the whole app lifetime**.
 *   ⚠️⚠️ Keeping "last asked at" inside the banner component re-asked every time you returned to the list (the component is recreated)
 *      ⇒ the time, the answer and the in-flight promise live outside the component.
 * ⚠️ If fetching fails, return the previous answer (do not flash the banner on a momentary outage).
 */
export function releaseChecker(
  fetchLatest: () => Promise<BuildInfo | undefined>,
  everyMs: number,
  now: () => number = Date.now,
): { check: () => Promise<BuildInfo | undefined>; latest: () => BuildInfo | undefined } {
  let last = Number.NEGATIVE_INFINITY
  let latest: BuildInfo | undefined
  let inflight: Promise<BuildInfo | undefined> | undefined
  return {
    latest: () => latest,
    check: () => {
      if (inflight) return inflight
      // ⚠️ If the clock went back (`now < last`), ask again (waiting would skip a whole day by the amount set back / codex round 24, low #7)
      const age = now() - last
      if (age >= 0 && age < everyMs) return Promise.resolve(latest)
      last = now()
      inflight = fetchLatest()
        .then((r) => {
          if (r) latest = r
          return latest
        })
        .catch(() => latest)
        .finally(() => {
          inflight = undefined
        })
      return inflight
    },
  }
}
