import { describe, expect, it } from 'vitest';
import { checkBrandVoice, hasBlockingIssue } from '@/lib/agents/social/safety';
import type { BrandVoiceProfile } from '@/lib/agents/social/types';

const profile = (prohibitedWords: string[]): BrandVoiceProfile => ({
  workspaceId: 'ws-1',
  tone: 'friendly, plain-spoken',
  prohibitedWords,
  examplePosts: [],
});

describe('checkBrandVoice', () => {
  it('returns nothing when there is no profile at all', () => {
    expect(checkBrandVoice(null, 'anything goes here')).toEqual([]);
  });

  it('blocks a draft containing a prohibited word, case-insensitively', () => {
    const issues = checkBrandVoice(profile(['guarantee']), 'We GUARANTEE results in 7 days.');
    expect(hasBlockingIssue(issues)).toBe(true);
    expect(issues[0].code).toBe('prohibited_word');
  });

  it('does not block clean text', () => {
    const issues = checkBrandVoice(profile(['guarantee']), 'We are proud of our results.');
    expect(hasBlockingIssue(issues)).toBe(false);
  });

  it('ignores an empty prohibited-word entry rather than blocking everything', () => {
    const issues = checkBrandVoice(profile(['', '  ']), 'Perfectly ordinary caption.');
    expect(issues).toEqual([]);
  });
});
