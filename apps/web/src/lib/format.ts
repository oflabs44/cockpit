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

/** "12d 4h", "4h 12m", "12m" — a duration, not a point in time (host uptime_s). */
export function formatDuration(totalSeconds: number): string {
  // A negative or non-finite report (clock skew, daemon bug) must not render "-2m"/"NaNm"
  // as if it were a fact.
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '—'

  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/** "8.0 GB" from a raw byte count (daemon reports bytes, per protocol.go's `Disk`/`HostCapacity`). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'

  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

/** A local exact time for immutable records. */
export function formatTimestamp(timestampMs: number | null): string {
  if (timestampMs === null) return 'Not recorded'

  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(timestampMs)
}

/** A recorded interval. Both boundaries must exist. */
export function formatTiming(startedAt: number | null, finishedAt: number | null): string {
  if (startedAt === null) return 'Not started'
  if (finishedAt === null) return 'Not finished'

  return formatDuration((finishedAt - startedAt) / 1000)
}
