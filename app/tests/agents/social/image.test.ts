import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIVE_IMAGE_GEN_ENABLED, OpenAiImageProvider, SandboxImageProvider, createImageProvider } from '@/lib/agents/social/image';

const env = (overrides: Record<string, string | undefined>) => overrides as unknown as NodeJS.ProcessEnv;

describe('SandboxImageProvider', () => {
  it('generates a deterministic-shaped, non-empty image reference for a real prompt', async () => {
    const provider = new SandboxImageProvider();
    const result = await provider.generateImage({ prompt: 'a bright storefront' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.imageRef.length).toBeGreaterThan(0);
      expect(result.altText).toContain('storefront');
      expect(result.estimatedCostUsd).toBe(0);
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

describe('LIVE_IMAGE_GEN_ENABLED - the committed switch itself', () => {
  it('approved 2026-09-30 and true in this commit', () => {
    expect(LIVE_IMAGE_GEN_ENABLED).toBe(true);
  });
});

describe('createImageProvider - double-gated: the compile-time switch, then the environment tier', () => {
  it('with no overrides, running under the test runner (not staging/production): still the sandbox provider, even though the switch is now on - the environment gate protects local/test runs regardless', () => {
    const provider = createImageProvider();
    expect(provider.kind).toBe('sandbox');
    expect(provider).toBeInstanceOf(SandboxImageProvider);
  });

  it('liveEnabled forced true, but the environment is development: gracefully falls back to sandbox, never an error', () => {
    const provider = createImageProvider({ liveEnabled: true, env: env({ APP_ENV: 'development' }) });
    expect(provider.kind).toBe('sandbox');
  });

  it('liveEnabled forced true, but the environment is test: gracefully falls back to sandbox, never an error', () => {
    const provider = createImageProvider({ liveEnabled: true, env: env({ APP_ENV: 'test' }) });
    expect(provider.kind).toBe('sandbox');
  });

  it('liveEnabled true (the real, committed value) AND environment is staging: returns the real provider', () => {
    const provider = createImageProvider({ env: env({ APP_ENV: 'staging' }) });
    expect(provider.kind).toBe('openai');
    expect(provider).toBeInstanceOf(OpenAiImageProvider);
  });

  it('liveEnabled forced false, even in staging: still the sandbox provider (both gates are required, not either)', () => {
    const provider = createImageProvider({ liveEnabled: false, env: env({ APP_ENV: 'staging' }) });
    expect(provider.kind).toBe('sandbox');
  });
});

describe('OpenAiImageProvider - input limits and missing-key are caught before any network call', () => {
  it('refuses a prompt that is too long, without needing a configured API key', async () => {
    vi.stubEnv('Image_Generation_30_days_chatGPT', '');
    const provider = new OpenAiImageProvider();
    const result = await provider.generateImage({ prompt: 'x'.repeat(4001) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/too long/);
  });

  it('a valid-length request without a configured key fails with a clear, non-network error', async () => {
    vi.stubEnv('Image_Generation_30_days_chatGPT', '');
    const provider = new OpenAiImageProvider();
    await expect(provider.generateImage({ prompt: 'a normal prompt' })).rejects.toThrow(/Image_Generation_30_days_chatGPT/);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });
});
