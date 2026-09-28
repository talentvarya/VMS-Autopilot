import { describe, expect, it } from 'vitest';
import { NETWORK_LIMITS, charLength } from '@/lib/social/networks';
import { draftCaption, draftForEachNetwork } from '@/lib/agents/social/captions';

describe('draftCaption', () => {
  it('stays within each network\'s own length limit, even for a very long topic', () => {
    const longTopic = 'This is a long caption sentence about our seasonal product launch. '.repeat(50);
    for (const network of Object.keys(NETWORK_LIMITS) as (keyof typeof NETWORK_LIMITS)[]) {
      const body = draftCaption({ network, topic: longTopic });
      expect(charLength(body)).toBeLessThanOrEqual(NETWORK_LIMITS[network].maxChars);
    }
  });

  it('includes the topic, a call to action and hashtags', () => {
    const body = draftCaption({ network: 'instagram', topic: 'New spring menu', callToAction: 'Book a table today.' });
    expect(body).toContain('New spring menu');
    expect(body).toContain('Book a table today.');
    expect(body).toContain('#');
  });

  it('respects an explicit hashtag list and Instagram\'s hard cap', () => {
    const many = Array.from({ length: 40 }, (_, i) => `tag${i}`);
    const body = draftCaption({ network: 'instagram', topic: 'x', hashtags: many });
    const used = body.match(/#\S+/g) ?? [];
    expect(used.length).toBeLessThanOrEqual(NETWORK_LIMITS.instagram.hashtagsHard!);
  });
});

describe('draftForEachNetwork', () => {
  it('produces one caption per requested network', () => {
    const result = draftForEachNetwork('Grand opening', ['x', 'linkedin']);
    expect(Object.keys(result)).toEqual(['x', 'linkedin']);
    expect(charLength(result.x)).toBeLessThanOrEqual(NETWORK_LIMITS.x.maxChars);
  });

  it('adapts differently per network once a length limit actually forces it', () => {
    const longTopic = 'Join us for our grand opening celebration this weekend with live music, food trucks and giveaways. '.repeat(3);
    const result = draftForEachNetwork(longTopic, ['x', 'linkedin']);
    expect(charLength(result.x)).toBeLessThanOrEqual(NETWORK_LIMITS.x.maxChars);
    expect(result.x).not.toBe(result.linkedin);
  });
});
