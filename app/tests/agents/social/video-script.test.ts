import { describe, expect, it } from 'vitest';
import { draftVideoScript } from '@/lib/agents/social/video-script';

describe('draftVideoScript', () => {
  it('produces a hook, body, call to action and a non-empty shot list mentioning the topic', () => {
    const script = draftVideoScript({ topic: 'our new loyalty program', network: 'instagram' });
    expect(script.hook.length).toBeGreaterThan(0);
    expect(script.body).toContain('loyalty program');
    expect(script.callToAction.length).toBeGreaterThan(0);
    expect(script.shotList.length).toBeGreaterThanOrEqual(3);
  });
});
