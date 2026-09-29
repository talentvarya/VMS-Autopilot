import { describe, expect, it } from 'vitest';
import { generateCaptionText } from '@/lib/agents/social/agent';
import type { CaptionAiRequest, CaptionAiResult, CaptionProvider } from '@/lib/agents/social/caption-ai-provider';
import { draftCaption } from '@/lib/agents/social/captions';
import { AiUsageCapExceededError } from '@/lib/ai/usage-cap';
import type { AgentDefinition, Principal } from '@/lib/agents/types';
import { SocialAgentFixtureStore } from './fixtures';
import { SocialStore } from '@/lib/social/store';

/**
 * generateCaptionText's wiring, tested directly with a fake 'anthropic'-kind provider passed
 * via providerOverride - the only way to exercise the real-path logic (cap check, usage/
 * blocked-event logging, fail-loud, no retry) from a test, since createCaptionProvider() itself
 * always falls back to the sandbox writer outside staging/production (see
 * caption-ai-provider.test.ts), regardless of LIVE_SOCIAL_CAPTION_AI_ENABLED (Phase F.3:
 * approved and true). Production code (social/agent.ts's draft_post branch) never passes an
 * override - staging and production always go through the real factory and the real environment.
 */

function definition(): AgentDefinition {
  return {
    id: 'def-social-1', workspaceId: 'ws-acme', agentKey: 'social_media_super_agent', displayName: 'Social Media Super Agent',
    description: null, model: 'sandbox-social', systemPrompt: '', allowedTools: [], enabled: true,
  };
}

function makeStore() {
  const socialStore = new SocialStore({ now: () => new Date('2026-10-05T12:00:00.000Z'), plan: { tier: 'free', name: 'Free (test)', channelLimit: 5 }, channels: [] });
  return new SocialAgentFixtureStore([definition()], socialStore);
}

const admin = (): Principal => ({ id: 'admin-1', role: 'admin', grants: [] });
const ungrantedClient = (): Principal => ({ id: 'client-1', role: 'client', grants: [] });

class CountingFakeAnthropicProvider implements CaptionProvider {
  readonly kind = 'anthropic' as const;
  callCount = 0;
  constructor(private result: CaptionAiResult | (() => CaptionAiResult) = { text: 'a real AI caption', inputTokens: 120, outputTokens: 40 }) {}
  async generateCaption(_request: CaptionAiRequest): Promise<CaptionAiResult> {
    this.callCount += 1;
    return typeof this.result === 'function' ? this.result() : this.result;
  }
}

describe('generateCaptionText - permission gate always wins over any override', () => {
  it('an unauthorized principal gets the sandbox writer even when a real provider override is supplied', async () => {
    const store = makeStore();
    const fakeReal = new CountingFakeAnthropicProvider();
    const text = await generateCaptionText(store, ungrantedClient(), 'ws-acme', 'facebook', 'Our spring menu', undefined, fakeReal);
    expect(text).toBe(draftCaption({ network: 'facebook', topic: 'Our spring menu' }));
    expect(fakeReal.callCount).toBe(0);
  });

  it('an authorized principal (Admin) with an override DOES use the real provider', async () => {
    const store = makeStore();
    const fakeReal = new CountingFakeAnthropicProvider({ text: 'a real AI caption', inputTokens: 120, outputTokens: 40 });
    const text = await generateCaptionText(store, admin(), 'ws-acme', 'facebook', 'Our spring menu', undefined, fakeReal);
    expect(text).toBe('a real AI caption');
    expect(fakeReal.callCount).toBe(1);
  });
});

describe('generateCaptionText - AI usage/cost logging for a real call', () => {
  it('logs the real token counts and an estimated cost after a successful real call', async () => {
    const store = makeStore();
    const fakeReal = new CountingFakeAnthropicProvider({ text: 'caption', inputTokens: 200, outputTokens: 80 });
    await generateCaptionText(store, admin(), 'ws-acme', 'facebook', 'Topic', undefined, fakeReal);
    expect(store.aiUsageRecords).toHaveLength(1);
    expect(store.aiUsageRecords[0]).toMatchObject({ workspaceId: 'ws-acme', provider: 'anthropic', inputTokens: 200, outputTokens: 80 });
    expect(store.aiUsageRecords[0].estimatedCostUsd).toBeGreaterThan(0);
    expect(store.auditEvents).toHaveLength(0);
  });

  it('the sandbox path never logs AI usage at all', async () => {
    const store = makeStore();
    await generateCaptionText(store, admin(), 'ws-acme', 'facebook', 'Topic', undefined);
    expect(store.aiUsageRecords).toHaveLength(0);
  });
});

describe('generateCaptionText - fail-loud on a hard cap, no silent fallback, no retry', () => {
  it('a cap already at its limit: throws, the fake provider is NEVER called, and no usage row is written', async () => {
    const store = makeStore();
    store.aiUsageCapStatus = { dailyCallCap: 1, monthlyCostCapUsd: null, dailyCallCount: 1, monthlyCostUsd: 0 };
    const fakeReal = new CountingFakeAnthropicProvider();
    await expect(generateCaptionText(store, admin(), 'ws-acme', 'facebook', 'Topic', undefined, fakeReal)).rejects.toBeInstanceOf(AiUsageCapExceededError);
    expect(fakeReal.callCount).toBe(0);
    expect(store.aiUsageRecords).toHaveLength(0);
  });

  it('a cap-blocked call writes a clear audit event, never a usage record', async () => {
    const store = makeStore();
    store.aiUsageCapStatus = { dailyCallCap: null, monthlyCostCapUsd: 5, dailyCallCount: 0, monthlyCostUsd: 5 };
    const fakeReal = new CountingFakeAnthropicProvider();
    await expect(generateCaptionText(store, admin(), 'ws-acme', 'facebook', 'Topic', undefined, fakeReal)).rejects.toThrow();
    expect(store.aiUsageRecords).toHaveLength(0);
    expect(store.auditEvents).toHaveLength(1);
    expect(store.auditEvents[0]).toMatchObject({ result: 'denied', action: 'ai.caption_blocked', workspaceId: 'ws-acme' });
    expect(store.auditEvents[0].metadata).toMatchObject({ reason: expect.stringContaining('monthly AI cost cap') });
  });

  it('is never retried automatically - calling it once only ever attempts the provider once, blocked or not', async () => {
    const store = makeStore();
    store.aiUsageCapStatus = { dailyCallCap: 0, monthlyCostCapUsd: null, dailyCallCount: 0, monthlyCostUsd: 0 };
    const fakeReal = new CountingFakeAnthropicProvider();
    await expect(generateCaptionText(store, admin(), 'ws-acme', 'facebook', 'Topic', undefined, fakeReal)).rejects.toThrow();
    expect(fakeReal.callCount).toBe(0);
  });

  it('a real provider call that itself fails also fails loud - no fallback to sandbox text', async () => {
    const store = makeStore();
    const failingProvider: CaptionProvider = {
      kind: 'anthropic',
      generateCaption: async () => {
        throw new Error('the AI provider returned an error');
      },
    };
    await expect(generateCaptionText(store, admin(), 'ws-acme', 'facebook', 'Topic', undefined, failingProvider)).rejects.toThrow(/AI provider returned an error/);
    expect(store.aiUsageRecords).toHaveLength(0);
  });
});
