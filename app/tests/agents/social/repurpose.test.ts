import { describe, expect, it } from 'vitest';
import { NETWORK_LIMITS, charLength } from '@/lib/social/networks';
import { repurposeBlogPost } from '@/lib/agents/social/repurpose';

describe('repurposeBlogPost', () => {
  const blog = {
    title: '5 ways to prepare for tax season',
    body:
      'Tax season can feel overwhelming, with forms, deadlines, receipts, deductions and last-minute paperwork all piling up at once, faster than most small business owners can realistically keep track of without a clear plan in place. ' +
      'This guide breaks it down into five simple, practical steps you can start today, no accounting background required.',
  };

  it('produces one platform-adapted post per requested network, using the blog\'s own opening sentence', () => {
    const posts = repurposeBlogPost(blog, ['linkedin', 'x']);
    expect(Object.keys(posts)).toEqual(['linkedin', 'x']);
    expect(posts.linkedin).toContain('Tax season can feel overwhelming');
    expect(charLength(posts.x)).toBeLessThanOrEqual(NETWORK_LIMITS.x.maxChars);
    expect(posts.linkedin).not.toBe(posts.x);
  });

  it('falls back to the title when the body has no clear first sentence', () => {
    const posts = repurposeBlogPost({ title: 'Untitled update', body: '   ' }, ['facebook']);
    expect(posts.facebook).toContain('Untitled update');
  });
});
