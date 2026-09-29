import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AnthropicCaptionProvider,
  LIVE_SOCIAL_CAPTION_AI_ENABLED,
  LiveCaptionAiDisabledError,
  SandboxCaptionProvider,
  createCaptionProvider,
} from '@/lib/agents/social/caption-ai-provider';
import { draftCaption } from '@/lib/agents/social/captions';

const env = (overrides: Record<string, string | undefined>) => overrides as unknown as NodeJS.ProcessEnv;

describe('LIVE_SOCIAL_CAPTION_AI_ENABLED - the committed switch itself', () => {
  it('is false in this commit - real AI calls are switched off by default', () => {
    expect(LIVE_SOCIAL_CAPTION_AI_ENABLED).toBe(false);
  });
});

describe('SandboxCaptionProvider - the pre-existing, unchanged, deterministic writer', () => {
  it('produces EXACTLY what draftCaption() already produces - zero behavior change', async () => {
    const provider = new SandboxCaptionProvider();
    const result = await provider.generateCaption({ network: 'facebook', topic: 'Our spring menu is here', callToAction: 'Book a table' });
    expect(result.text).toBe(draftCaption({ network: 'facebook', topic: 'Our spring menu is here', callToAction: 'Book a table' }));
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  it('reports zero cost - it never calls anything', async () => {
    const provider = new SandboxCaptionProvider();
    const result = await provider.generateCaption({ network: 'instagram', topic: 'New collection' });
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });
});

describe('createCaptionProvider - double-gated: the compile-time switch, then the environment tier', () => {
  it('with no overrides (the real, committed default): always returns the sandbox provider', () => {
    const provider = createCaptionProvider();
    expect(provider.kind).toBe('sandbox');
    expect(provider).toBeInstanceOf(SandboxCaptionProvider);
  });

  it('liveEnabled forced true, but the environment is development: still refused', () => {
    expect(() => createCaptionProvider({ liveEnabled: true, env: env({ APP_ENV: 'development' }) })).toThrow(LiveCaptionAiDisabledError);
  });

  it('liveEnabled forced true, but the environment is test: still refused', () => {
    expect(() => createCaptionProvider({ liveEnabled: true, env: env({ APP_ENV: 'test' }) })).toThrow(LiveCaptionAiDisabledError);
  });

  it('liveEnabled forced true AND environment is staging: returns the real provider', () => {
    const provider = createCaptionProvider({ liveEnabled: true, env: env({ APP_ENV: 'staging' }) });
    expect(provider.kind).toBe('anthropic');
    expect(provider).toBeInstanceOf(AnthropicCaptionProvider);
  });

  it('liveEnabled left false, even in staging: still the sandbox provider (both gates are required, not either)', () => {
    const provider = createCaptionProvider({ env: env({ APP_ENV: 'staging' }) });
    expect(provider.kind).toBe('sandbox');
  });
});

describe('AnthropicCaptionProvider - input limits are enforced before any network call is attempted', () => {
  it('refuses a topic that is too long, without needing a configured API key', async () => {
    const provider = new AnthropicCaptionProvider();
    const longTopic = 'x'.repeat(1001);
    await expect(provider.generateCaption({ network: 'facebook', topic: longTopic })).rejects.toThrow(/topic is too long/);
  });

  it('refuses a call-to-action that is too long, without needing a configured API key', async () => {
    const provider = new AnthropicCaptionProvider();
    await expect(
      provider.generateCaption({ network: 'facebook', topic: 'A normal topic', callToAction: 'x'.repeat(201) }),
    ).rejects.toThrow(/call to action is too long/);
  });

  it('a valid-length request without a configured key fails with a clear, non-network error', async () => {
    // Forced clean regardless of the ambient environment, so this never attempts a real call
    // even on a machine where a developer has a real ANTHROPIC_API_KEY set for the separate,
    // explicitly-opt-in real-provider test file (tests/ai/anthropic-live.test.ts).
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const provider = new AnthropicCaptionProvider();
    await expect(provider.generateCaption({ network: 'facebook', topic: 'A perfectly normal topic' })).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });
});
