import { describe, expect, it } from 'vitest';
import { researchStrategy } from '@/lib/agents/social/strategy';

describe('researchStrategy', () => {
  it('produces three deterministic content pillars for the same input', () => {
    const a = researchStrategy({ topic: 'dental checkups', audience: 'busy parents' });
    const b = researchStrategy({ topic: 'dental checkups', audience: 'busy parents' });
    expect(a).toEqual(b);
    expect(a).toHaveLength(3);
    expect(a.every((p) => p.title.length > 0 && p.angle.length > 0)).toBe(true);
  });

  it('falls back to a generic audience when none is given', () => {
    const pillars = researchStrategy({ topic: 'dental checkups' });
    expect(pillars[0].angle).toContain('your customers');
  });
});
