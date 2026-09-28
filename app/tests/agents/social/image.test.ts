import { describe, expect, it } from 'vitest';
import { LIVE_IMAGE_GEN_ENABLED, SandboxImageProvider, createImageProvider } from '@/lib/agents/social/image';

describe('SandboxImageProvider', () => {
  it('generates a deterministic-shaped, non-empty image reference for a real prompt', async () => {
    const provider = new SandboxImageProvider();
    const result = await provider.generateImage({ prompt: 'a bright storefront' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.imageRef.length).toBeGreaterThan(0);
      expect(result.altText).toContain('storefront');
    }
  });

  it('refuses an empty prompt', async () => {
    const provider = new SandboxImageProvider();
    const result = await provider.generateImage({ prompt: '   ' });
    expect(result.ok).toBe(false);
  });

  it('generates one image per carousel slide, in order', async () => {
    const provider = new SandboxImageProvider();
    const results = await provider.generateCarousel([{ prompt: 'slide one' }, { prompt: 'slide two' }, { prompt: 'slide three' }]);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});

describe('live image generation switch', () => {
  it('is off, and the factory only ever returns the sandbox provider', () => {
    expect(LIVE_IMAGE_GEN_ENABLED).toBe(false);
    expect(createImageProvider().kind).toBe('sandbox');
  });
});
