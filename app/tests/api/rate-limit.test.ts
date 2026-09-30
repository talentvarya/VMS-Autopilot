import { describe, expect, it } from 'vitest';
import { clientIp, isRateLimited } from '@/lib/api/rate-limit';

describe('isRateLimited', () => {
  it('allows requests under the window budget', () => {
    const key = 'test-under-budget';
    for (let i = 0; i < 60; i++) {
      expect(isRateLimited(key, 1_000)).toBe(false);
    }
  });

  it('blocks once a key exceeds the window budget', () => {
    const key = 'test-over-budget';
    for (let i = 0; i < 60; i++) isRateLimited(key, 1_000);
    expect(isRateLimited(key, 1_000)).toBe(true);
  });

  it('resets the count once the window has passed', () => {
    const key = 'test-window-reset';
    for (let i = 0; i < 60; i++) isRateLimited(key, 1_000);
    expect(isRateLimited(key, 1_000)).toBe(true);
    expect(isRateLimited(key, 1_000 + 60_000 + 1)).toBe(false);
  });

  it('tracks separate keys independently', () => {
    for (let i = 0; i < 60; i++) isRateLimited('test-key-a', 2_000);
    expect(isRateLimited('test-key-a', 2_000)).toBe(true);
    expect(isRateLimited('test-key-b', 2_000)).toBe(false);
  });
});

describe('clientIp', () => {
  it('reads the first address from x-forwarded-for', () => {
    const request = new Request('https://example.test/api/health', {
      headers: { 'x-forwarded-for': '203.0.113.5, 70.41.3.18' },
    });
    expect(clientIp(request)).toBe('203.0.113.5');
  });

  it('falls back to x-real-ip when x-forwarded-for is absent', () => {
    const request = new Request('https://example.test/api/health', { headers: { 'x-real-ip': '203.0.113.9' } });
    expect(clientIp(request)).toBe('203.0.113.9');
  });

  it('falls back to "unknown" when neither header is present', () => {
    const request = new Request('https://example.test/api/health');
    expect(clientIp(request)).toBe('unknown');
  });
});
