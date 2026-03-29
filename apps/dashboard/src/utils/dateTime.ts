/**
 * Returns today's local date as "YYYY-MM-DD" in the given IANA timezone.
 */
export function todayInTz(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date())
}

/**
 * Returns the UTC Date object for the start of the given local day (00:00:00 local time).
 * @param dayKey - date string in "YYYY-MM-DD" format (local date in the given timezone)
 * @param timezone - IANA timezone string (e.g. "Pacific/Auckland")
 */
export function startOfLocalDay(dayKey: string, timezone: string): Date {
  return localDayBounds(dayKey, timezone).from
}

/**
 * Returns the UTC Date object for the end of the given local day (23:59:59 local time).
 * @param dayKey - date string in "YYYY-MM-DD" format (local date in the given timezone)
 * @param timezone - IANA timezone string (e.g. "Pacific/Auckland")
 */
export function endOfLocalDay(dayKey: string, timezone: string): Date {
  return localDayBounds(dayKey, timezone).to
}

/**
 * Formats a Date object as "YYYY-MM-DD" in the given IANA timezone.
 */
export function formatDayKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(date)
}

/**
 * Formats a UTC ISO string as "HH:mm" in the given IANA timezone.
 * Falls back to the browser's local timezone if timezone is not provided.
 */
export function formatTimeInTz(utcIso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(utcIso))
}

/**
 * Formats a local day key as a human-readable date string (e.g. "Mar 29, 2026")
 * in the given IANA timezone.
 */
export function formatDayDisplay(dayKey: string, timezone: string): string {
  const from = startOfLocalDay(dayKey, timezone)
  return new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(from)
}

/**
 * Computes the UTC Date bounds for a full local calendar day.
 *
 * Algorithm: start with UTC midnight as an initial guess, then iterate twice to
 * converge on the exact UTC millisecond that corresponds to local 00:00:00.
 * Two iterations are sufficient to account for any DST transitions.
 */
function localDayBounds(dayKey: string, timezone: string): { from: Date; to: Date } {
  const [year, month, day] = dayKey.split('-').map(Number)

  function getLocalParts(utcMs: number) {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(new Date(utcMs))

    return {
      year: Number(parts.find(p => p.type === 'year')?.value ?? '0'),
      month: Number(parts.find(p => p.type === 'month')?.value ?? '0'),
      day: Number(parts.find(p => p.type === 'day')?.value ?? '0'),
      hour: Number(parts.find(p => p.type === 'hour')?.value ?? '0'),
      minute: Number(parts.find(p => p.type === 'minute')?.value ?? '0'),
      second: Number(parts.find(p => p.type === 'second')?.value ?? '0'),
    }
  }

  // Initial guess: UTC midnight for the requested day
  let candidateMs = Date.UTC(year, month - 1, day, 0, 0, 0)

  // Iterate twice to converge: adjust by the delta between the local time
  // that the candidate maps to and our target local midnight.
  for (let i = 0; i < 2; i++) {
    const local = getLocalParts(candidateMs)
    const localMs = Date.UTC(
      local.year, local.month - 1, local.day,
      local.hour, local.minute, local.second
    )
    const targetMs = Date.UTC(year, month - 1, day, 0, 0, 0)
    candidateMs += targetMs - localMs
  }

  const from = new Date(candidateMs)
  // End of day: 23:59:59.999 = one millisecond before the next day
  const to = new Date(candidateMs + 86400 * 1000 - 1)
  return { from, to }
}
