// All time display goes through here.
//
// ⚠️ Slicing an ISO string with slice(11,16) shows UTC as-is (we actually shipped that bug).
//    Format with the device's time zone and locale, so the locale argument is [] (device default).

export function hhmm(iso?: string): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function hhmmss(iso?: string): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  return new Date(t).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** ★ Time with date (for things that cross days, e.g. a deadline 24h ahead / 2026-09-24) */
export function mdhhmm(iso?: string): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  return new Date(t).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
