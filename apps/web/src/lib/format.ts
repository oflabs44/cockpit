const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
]

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'narrow' })

/** "3d ago", "2m ago" — falls back to "just now" under a minute. */
export function formatAgo(timestampMs: number, now = Date.now()): string {
  const deltaMs = now - timestampMs
  for (const [unit, unitMs] of UNITS) {
    if (Math.abs(deltaMs) >= unitMs) {
      return rtf.format(-Math.round(deltaMs / unitMs), unit)
    }
  }

  return 'just now'
}
