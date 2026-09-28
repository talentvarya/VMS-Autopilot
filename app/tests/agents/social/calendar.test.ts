import { describe, expect, it } from 'vitest';
import { buildCalendarSlots } from '@/lib/agents/social/calendar';

const pillars = [
  { title: 'Pillar A', angle: 'a' },
  { title: 'Pillar B', angle: 'b' },
];

describe('buildCalendarSlots', () => {
  it('assigns one slot per day, in order', () => {
    const slots = buildCalendarSlots(pillars, '2026-10-01', 3);
    expect(slots.map((s) => s.plannedDate)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
  });

  it('cycles through the pillars when there are more days than pillars', () => {
    const slots = buildCalendarSlots(pillars, '2026-10-01', 4);
    expect(slots.map((s) => s.theme)).toEqual(['Pillar A', 'Pillar B', 'Pillar A', 'Pillar B']);
  });

  it('returns nothing for zero days or zero pillars', () => {
    expect(buildCalendarSlots(pillars, '2026-10-01', 0)).toEqual([]);
    expect(buildCalendarSlots([], '2026-10-01', 5)).toEqual([]);
  });

  it('crosses a month boundary correctly', () => {
    const slots = buildCalendarSlots(pillars, '2026-10-30', 3);
    expect(slots.map((s) => s.plannedDate)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01']);
  });
});
