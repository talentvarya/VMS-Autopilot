/**
 * Phase G.14 - small IST (India Standard Time, UTC+5:30) time helpers for the calendar-approval
 * reminder job. No library, no external timezone database - IST has no daylight saving and a
 * fixed, whole-and-half-hour offset from UTC, so a plain offset add is exact and never drifts.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function istNow(now = new Date()): Date {
  return new Date(now.getTime() + IST_OFFSET_MS);
}

export function istHour(now = new Date()): number {
  return istNow(now).getUTCHours();
}

/** YYYY-MM-DD for the IST calendar date `daysAhead` days from now. */
export function istDateString(daysAhead: number, now = new Date()): string {
  const d = istNow(now);
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}
