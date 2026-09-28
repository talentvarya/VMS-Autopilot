import type { SocialPost } from './types';

/** Calendar helpers. Everything is in UTC so the same data always looks the same. */

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const monthLabel = (year: number, month0: number) => `${MONTHS[month0]} ${year}`;

/** "2025-04-24" for a date or ISO string, in UTC. */
export const dayKey = (value: Date | string) => new Date(value).toISOString().slice(0, 10);

export const timeLabel = (iso: string) => `${new Date(iso).toISOString().slice(11, 16)} UTC`;

export const dateLabel = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export const dateTimeLabel = (iso: string) => `${dateLabel(iso)}, ${timeLabel(iso)}`;

/** Weeks (Monday first) of a month; days outside the month are null. */
export function monthGrid(year: number, month0: number): (Date | null)[][] {
  const first = new Date(Date.UTC(year, month0, 1));
  const daysInMonth = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const offset = (first.getUTCDay() + 6) % 7; // Monday = 0
  const cells: (Date | null)[] = [...Array<null>(offset).fill(null)];
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(Date.UTC(year, month0, d)));
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (Date | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export const shiftMonth = (year: number, month0: number, by: number) => {
  const d = new Date(Date.UTC(year, month0 + by, 1));
  return { year: d.getUTCFullYear(), month0: d.getUTCMonth() };
};

/** The date a post belongs to on the calendar, or null if it has no date yet. */
export function calendarDate(post: SocialPost): string | null {
  if (post.status === 'published') return post.publishedAt;
  if (post.status === 'scheduled' || post.status === 'publishing') return post.scheduledAt ?? post.updatedAt;
  return null;
}

export function postsByDay(posts: readonly SocialPost[], year: number, month0: number) {
  const map = new Map<string, SocialPost[]>();
  for (const p of posts) {
    const at = calendarDate(p);
    if (!at) continue;
    const d = new Date(at);
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month0) continue;
    const key = dayKey(d);
    map.set(key, [...(map.get(key) ?? []), p].sort((a, b) => calendarDate(a)!.localeCompare(calendarDate(b)!)));
  }
  return map;
}
