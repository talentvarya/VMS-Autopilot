import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AnthropicCaptionProvider,
  LIVE_SOCIAL_CAPTION_AI_ENABLED,
  SandboxCaptionProvider,
  createCaptionProvider,
} from '@/lib/agents/social/caption-ai-provider';
import { draftCaption } from '@/lib/agents/social/captions';

const env = (overrides: Record<string, string | undefined>) => overrides as unknown as NodeJS.ProcessEnv;

describe('LIVE_SOCIAL_CAPTION_AI_ENABLED - the committed switch itself', () => {
  it('Phase F.3: approved and true in this commit', () => {
    expect(LIVE_SOCIAL_CAPTION_AI_ENABLED).toBe(true);
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
  it('with no overrides, running under the test runner (not staging/production): still the sandbox provider, even though the switch is now on - the environment gate protects local/test runs regardless', () => {
    const provider = createCaptionProvider();
    expect(provider.kind).toBe('sandbox');
    expect(provider).toBeInstanceOf(SandboxCaptionProvider);
  });

  it('liveEnabled forced true, but the environment is development: gracefully falls back to sandbox, never an error', () => {
    const provider = createCaptionProvider({ liveEnabled: true, env: env({ APP_ENV: 'development' }) });
    expect(provider.kind).toBe('sandbox');
  });

  it('liveEnabled forced true, but the environment is test: gracefully falls back to sandbox, never an error', () => {
    const provider = createCaptionProvider({ liveEnabled: true, env: env({ APP_ENV: 'test' }) });
    expect(provider.kind).toBe('sandbox');
  });

  it('liveEnabled true (the real, committed value) AND environment is staging: returns the real provider', () => {
    const provider = createCaptionProvider({ env: env({ APP_ENV: 'staging' }) });
    expect(provider.kind).toBe('anthropic');
    expect(provider).toBeInstanceOf(AnthropicCaptionProvider);
  });

  it('liveEnabled forced false, even in staging: still the sandbox provider (both gates are required, not either)', () => {
    const provider = createCaptionProvider({ liveEnabled: false, env: env({ APP_ENV: 'staging' }) });
    expect(provider.kind).toBe('sandbox');
  });

  it('liveEnabled true AND environment is production: also returns the real provider - production safety depends on ANTHROPIC_API_KEY never being configured there, not on this gate alone', () => {
    const provider = createCaptionProvider({ env: env({ APP_ENV: 'production' }) });
    expect(provider.kind).toBe('anthropic');
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
