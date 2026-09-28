import { describe, expect, it } from 'vitest';
import { NETWORK_LIMITS, charLength, effectiveLength } from '@/lib/social/networks';
import { contentHash, sha256Hex } from '@/lib/social/hash';
import { POST_STATUSES, NETWORKS, LIMITS } from '@/lib/social/types';
import { TRANSITIONS, canTransition, isFinal, requirementFor } from '@/lib/social/state';
import { hasErrors, validatePost } from '@/lib/social/validate';

describe('fingerprint (SHA-256)', () => {
  it('matches the official test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('handles long text and non-Latin text', () => {
    expect(sha256Hex('a'.repeat(1000))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
    expect(sha256Hex('नमस्ते 😀')).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex('नमस्ते 😀')).not.toBe(sha256Hex('नमस्ते 😃'));
  });

  it('changes when the channel, the text or the picture description changes', () => {
    const base = contentHash('c1', 'Hello', null);
    expect(contentHash('c1', 'Hello', null)).toBe(base);
    expect(contentHash('c2', 'Hello', null)).not.toBe(base);
    expect(contentHash('c1', 'Hello!', null)).not.toBe(base);
    expect(contentHash('c1', 'Hello', 'a cat')).not.toBe(base);
    expect(contentHash('c1', 'Hello', '')).toBe(base); // no description = empty description
  });
});

describe('character counting', () => {
  it('counts what a person sees (an emoji is one character)', () => {
    expect(charLength('abc')).toBe(3);
    expect(charLength('😀😀')).toBe(2);
    expect(charLength('नमस्ते')).toBe(6);
  });
});

describe('the life of a post', () => {
  it('has a rule for every pair of statuses, and only the intended moves are possible', () => {
    const allowed: string[] = [];
    for (const from of POST_STATUSES) for (const to of POST_STATUSES) if (canTransition(from, to)) allowed.push(`${from}>${to}`);
    expect(allowed.sort()).toEqual([
      'approved>cancelled', 'approved>draft', 'approved>publishing', 'approved>scheduled',
      'draft>cancelled', 'draft>in_review',
      'failed>approved', 'failed>cancelled', 'failed>draft',
      'in_review>approved', 'in_review>cancelled', 'in_review>draft',
      'publishing>failed', 'publishing>published',
      'scheduled>approved', 'scheduled>cancelled', 'scheduled>publishing',
    ]);
  });

  it('nothing leaves published or cancelled', () => {
    for (const s of ['published', 'cancelled'] as const) {
      expect(isFinal(s)).toBe(true);
      expect(Object.keys(TRANSITIONS[s])).toEqual([]);
    }
  });

  it('only the server can start due posts or record the outcome', () => {
    expect(requirementFor('scheduled', 'publishing')).toBe('server');
    expect(requirementFor('publishing', 'published')).toBe('server');
    expect(requirementFor('publishing', 'failed')).toBe('server');
  });

  it('a post can never skip approval', () => {
    expect(canTransition('draft', 'approved')).toBe(false);
    expect(canTransition('draft', 'scheduled')).toBe(false);
    expect(canTransition('draft', 'publishing')).toBe(false);
    expect(canTransition('in_review', 'scheduled')).toBe(false);
    expect(canTransition('in_review', 'publishing')).toBe(false);
  });

  it('approving needs the approve permission; publishing and scheduling need publish/execute', () => {
    expect(requirementFor('in_review', 'approved')).toEqual(['approve']);
    for (const to of ['scheduled', 'publishing'] as const) expect(requirementFor('approved', to)).toEqual(['publish_execute']);
    expect(requirementFor('failed', 'approved')).toEqual(['publish_execute']);
  });
});

describe('checking a post before it goes anywhere', () => {
  const now = new Date('2025-04-24T09:00:00Z');
  const codes = (post: Parameters<typeof validatePost>[0]) => validatePost(post, now).map((i) => i.code);

  it('accepts a normal post', () => {
    expect(validatePost({ network: 'facebook', body: 'Our team is ready to see you. Book a check-up this week.' }, now)).toEqual([]);
  });

  it('refuses an empty post and hidden characters', () => {
    expect(codes({ network: 'x', body: '   ' })).toContain('body.empty');
    expect(codes({ network: 'x', body: 'hello\u0000world' })).toContain('body.control_chars');
  });

  it('knows each network’s length limit', () => {
    for (const n of NETWORKS) {
      const max = NETWORK_LIMITS[n].maxChars;
      if (max > 10000) continue;
      expect(codes({ network: n, body: 'a'.repeat(max) })).not.toContain('body.too_long');
      expect(codes({ network: n, body: 'a'.repeat(max + 1) })).toContain('body.too_long');
    }
    expect(codes({ network: 'x', body: 'a'.repeat(281) })).toContain('body.too_long');
    expect(codes({ network: 'x', body: '😀'.repeat(280) })).not.toContain('body.too_long');
  });

  it('warns near the limit, in plain words', () => {
    const issues = validatePost({ network: 'x', body: 'a'.repeat(270) }, now);
    expect(issues.find((i) => i.code === 'body.near_limit')!.level).toBe('warning');
    expect(issues.find((i) => i.code === 'body.near_limit')!.message).toContain('close to the X limit');
  });

  it('applies the hashtag rules: a hard limit on Instagram, advice elsewhere', () => {
    const tags = (n: number) => Array.from({ length: n }, (_, i) => `#tag${i}`).join(' ');
    expect(codes({ network: 'instagram', body: `Hello ${tags(31)}` })).toContain('hashtags.too_many');
    expect(codes({ network: 'instagram', body: `Hello ${tags(30)}` })).not.toContain('hashtags.too_many');
    expect(validatePost({ network: 'linkedin', body: `Hello ${tags(9)}` }, now).find((i) => i.code === 'hashtags.many')!.level).toBe('warning');
    expect(codes({ network: 'linkedin', body: `Hello ${tags(9)}` })).not.toContain('hashtags.too_many');
    expect(codes({ network: 'x', body: 'Hello #नमस्ते #café' })).not.toContain('hashtags.many');
  });

  it('flags leftover placeholders, all-capitals and many links as things to check, not errors', () => {
    const issues = validatePost({ network: 'facebook', body: 'HELLO EVERYONE WE ARE OPEN TODAY COME AND VISIT US [NAME] https://a.test https://b.test https://c.test https://d.test' }, now);
    expect(issues.map((i) => i.code)).toEqual(expect.arrayContaining(['body.placeholder', 'body.all_caps', 'links.many']));
    expect(hasErrors(issues)).toBe(false);
  });

  it('tells people that some networks need a picture', () => {
    const w = validatePost({ network: 'instagram', body: 'Hello' }, now).find((i) => i.code === 'media.needed')!;
    expect(w.level).toBe('warning');
    expect(validatePost({ network: 'facebook', body: 'Hello' }, now).some((i) => i.code === 'media.needed')).toBe(false);
  });

  it('enforces the scheduling window', () => {
    const at = (min: number) => new Date(now.getTime() + min * 60000).toISOString();
    expect(codes({ network: 'x', body: 'Hi', scheduledAt: at(2) })).toContain('schedule.too_soon');
    expect(codes({ network: 'x', body: 'Hi', scheduledAt: at(LIMITS.minLeadMinutes + 1) })).not.toContain('schedule.too_soon');
    expect(codes({ network: 'x', body: 'Hi', scheduledAt: at(-60) })).toContain('schedule.too_soon');
    expect(codes({ network: 'x', body: 'Hi', scheduledAt: at(LIMITS.maxDaysAhead * 1440 + 10) })).toContain('schedule.too_far');
    expect(codes({ network: 'x', body: 'Hi', scheduledAt: 'not a date' })).toContain('schedule.invalid');
  });

  it('never uses scary jargon in its messages', () => {
    const all = validatePost({ network: 'instagram', body: 'HELLO ' + '#a '.repeat(40) + 'TODO', scheduledAt: '2020-01-01T00:00:00Z' }, now);
    for (const i of all) expect(i.message).not.toMatch(/exception|null|undefined|regex|payload|token|error code/i);
  });
});

describe('effective length on X (a link always counts as 23 characters)', () => {
  it('shortens a long link the same way X does', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(300);
    expect(effectiveLength('x', `Check this out: ${longUrl}`)).toBe(charLength('Check this out: ') + 23);
    expect(effectiveLength('x', 'Two links: https://a.test/x https://b.test/y')).toBe(charLength('Two links:  ') + 23 * 2);
  });

  it('does not shorten links on any other network', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(300);
    expect(effectiveLength('facebook', `See: ${longUrl}`)).toBe(charLength(`See: ${longUrl}`));
  });

  it('a post that raw character counting would wrongly reject now passes, up to the real limit', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(300);
    const body = `Big sale this week: ${longUrl}`;
    expect(charLength(body)).toBeGreaterThan(280); // would have been wrongly rejected before this fix
    expect(validatePost({ network: 'x', body })).toEqual([]);
  });
});

describe('Google Business Profile specifics', () => {
  it('needs a picture, like YouTube and TikTok, unlike a plain status update', () => {
    const w = validatePost({ network: 'google_business', body: 'We are open this Saturday.' }).find((i) => i.code === 'media.needed')!;
    expect(w.level).toBe('warning');
    expect(w.message).toContain('will not accept this post without a picture');
  });

  it('tells people hashtags are not useful there, instead of a nonsensical "0 or fewer"', () => {
    const w = validatePost({ network: 'google_business', body: 'Open Saturday #openhouse' }).find((i) => i.code === 'hashtags.many')!;
    expect(w.message).not.toMatch(/0 or fewer/);
    expect(w.message).toContain('not clickable');
    expect(validatePost({ network: 'google_business', body: 'Open Saturday, no hashtags here' }).some((i) => i.code === 'hashtags.many')).toBe(false);
  });
});
