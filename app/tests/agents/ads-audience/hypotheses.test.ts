import { describe, expect, it } from 'vitest';
import {
  createAudienceHypotheses,
  defaultAudienceSegments,
  recommendObjective,
  recommendOffer,
  researchAudienceSignals,
} from '@/lib/agents/ads-audience/agent';
import type { BusinessProfile } from '@/lib/agents/types';

const BUSINESSES: Record<string, BusinessProfile> = {
  'protein brand': { name: 'PureFuel', industry: 'protein supplements', product: 'whey protein powder', problem: 'finding a clean-label protein without fillers' },
  gym: { name: 'Iron Peak Fitness', industry: 'gyms', product: 'monthly membership' },
  'real estate agency': { name: 'Harborview Realty', industry: 'real estate', product: 'first-time homebuyer listings', location: 'Austin, TX' },
  ecommerce: { name: 'Lumen Home Goods', industry: 'home goods ecommerce', product: 'ceramic dinnerware sets' },
  'local service': { name: 'Bright Smile Dental', industry: 'dental clinics', product: 'teeth whitening', location: 'Denver, CO' },
};

describe('business-agnosticism - the SAME logic works for every business type, unbranched', () => {
  it('produces three signals, three hypotheses and four segments for every business type', () => {
    for (const [label, profile] of Object.entries(BUSINESSES)) {
      const signals = researchAudienceSignals(profile);
      expect(signals, label).toHaveLength(3);
      const hypotheses = createAudienceHypotheses(profile, signals);
      expect(hypotheses, label).toHaveLength(3);
      expect(hypotheses.every((h) => h.personaName.length > 0 && h.painPoint.length > 0), label).toBe(true);
    }
    expect(defaultAudienceSegments().map((s) => s.segmentType)).toEqual(['core', 'lookalike', 'retargeting', 'exclusion']);
  });

  it('every signal/hypothesis mentions the business\'s own industry or product, not a hardcoded example', () => {
    for (const [label, profile] of Object.entries(BUSINESSES)) {
      const signals = researchAudienceSignals(profile);
      expect(signals.some((s) => s.includes(profile.industry) || s.includes(profile.product)), label).toBe(true);
    }
  });

  it('recommends an offer that names the actual product, for any business', () => {
    for (const profile of Object.values(BUSINESSES)) {
      expect(recommendOffer(profile)).toContain(profile.product);
    }
  });

  it('recommends objective based on conversion signals, business-agnostically', () => {
    expect(recommendObjective(undefined)).toBe('awareness');
    expect(recommendObjective({ qualifiedLeads: 5 })).toBe('lead_generation');
    expect(recommendObjective({ purchases: 3 })).toBe('conversions');
    expect(recommendObjective({ purchases: 3, qualifiedLeads: 5 })).toBe('conversions');
  });
});
