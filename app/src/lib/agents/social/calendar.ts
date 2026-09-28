/**
 * Deterministic calendar-slot assignment: spreads a set of content pillars across a date range,
 * one theme per day, cycling if there are more days than pillars. No AI call.
 */

import type { ContentPillar } from './strategy';

export interface CalendarSlot {
  plannedDate: string; // ISO date, yyyy-mm-dd
  theme: string;
}

function addDays(startDate: string, days: number): string {
  const d = new Date(`${startDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function buildCalendarSlots(pillars: ContentPillar[], startDate: string, days: number): CalendarSlot[] {
  if (pillars.length === 0 || days <= 0) return [];
  const slots: CalendarSlot[] = [];
  for (let i = 0; i < days; i++) {
    slots.push({ plannedDate: addDays(startDate, i), theme: pillars[i % pillars.length].title });
  }
  return slots;
}
