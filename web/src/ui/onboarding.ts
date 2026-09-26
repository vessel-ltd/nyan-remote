// ★ First-run guide: install the app, then pair (2026-09-26 / user decision).
//
// ★ Shown only while this phone has **no connection yet** (after the first pairing it never shows again, so people who prefer
//   the browser are not nagged), and the install step only when opened in a **browser tab** (not from the home screen).
// ★★ Why the order matters on iPhone: an app added to the home screen keeps its data apart from Safari's tab, so pairing in the
//   tab first and installing afterwards leaves the installed app with no connection and no device key (pair again).
//   ⇒ iPhone: add to the home screen first, open it from there, then scan. (⚠️ Verify on a real iPhone when iOS changes.)
// ★ Android's Chrome shares data between the tab and the installed app, so the order is only a recommendation there.

export type Platform = 'ios' | 'android' | 'other'

/** ★ iPadOS reports a Mac user agent; touch points tell it apart */
export function platformOf(userAgent: string, maxTouchPoints = 0): Platform {
  if (/iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)) return 'ios'
  if (/Android/.test(userAgent)) return 'android'
  return 'other'
}

/** ★ Opened from the home screen (installed) rather than in a browser tab */
export function isStandalone(matches: (query: string) => boolean, iosStandalone?: boolean): boolean {
  return matches('(display-mode: standalone)') || iosStandalone === true
}

/**
 * ★ What the guide shows.
 * @returns undefined when nothing is shown (a connection exists), otherwise whether to include the install step and for which platform
 */
export function onboarding(connections: number, platform: Platform, standalone: boolean): { install: Platform | undefined } | undefined {
  if (connections > 0) return undefined
  // ⚠️ A desktop browser has no home screen step worth guiding; installed apps skip it too
  return { install: standalone || platform === 'other' ? undefined : platform }
}
