import { describe, expect, it } from 'vitest';
import type { Grant, Role } from '@/lib/permissions';
import { runAgent, type Principal } from '@/lib/agents/orchestrator';
import type { AgentDefinition } from '@/lib/agents/types';
import { SocialStore } from '@/lib/social/store';
import { SocialAgentFixtureStore } from './social/fixtures';

/**
 * End-to-end proof that the Social Media Super Agent, run through the REAL Orchestrator
 * (src/lib/agents/orchestrator.ts) and a store backed by the REAL Phase 3 SocialStore, writes
 * genuine sandbox rows in "draft" and "in_review" status - the exact states a human's own
 * dashboard flow already uses - and never anything beyond that (no send, no publish, no
 * network call anywhere in this file or the code it exercises).
 */

const definition = (overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({
  id: 'def-social-1',
  workspaceId: 'ws-acme',
  agentKey: 'social_media_super_agent',
  displayName: 'Social Media Super Agent',
  description: null,
  model: 'sandbox-social',
  systemPrompt: '',
  allowedTools: [
    'research_strategy', 'generate_calendar', 'draft_post', 'submit_post_for_review',
    'draft_reply', 'submit_reply_for_review', 'video_script',
  ],
  enabled: true,
  ...overrides,
});

const principal = (role: Role, grants: Grant[] = [], id = 'user-1'): Principal => ({ id, role, grants });

function makeStore(defOverrides: Partial<AgentDefinition> = {}) {
  const socialStore = new SocialStore({
    now: () => new Date('2026-10-05T12:00:00.000Z'),
    plan: { tier: 'free', name: 'Free (test)', channelLimit: 5 },
    channels: [
      { id: 'chan-1', workspaceId: 'ws-acme', network: 'facebook', externalId: 'ext-fb', displayName: 'Acme FB', handle: 'acme', status: 'active' },
      { id: 'chan-2', workspaceId: 'ws-acme', network: 'linkedin', externalId: 'ext-li', displayName: 'Acme LI', handle: 'acme', status: 'active' },
    ],
  });
  return new SocialAgentFixtureStore([definition(defOverrides)], socialStore);
}

describe('draft_post', () => {
  it('an Admin: writes a REAL social_posts-shaped draft via the actual SocialStore', async () => {
    const store = makeStore();
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'social_media_super_agent', triggeredByKind: 'user',
      input: { task: 'draft_post', workspaceId: 'ws-acme', channelId: 'chan-1', network: 'facebook', topic: 'Our spring menu is here' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('succeeded');
    expect(store.socialStore.posts).toHaveLength(1);
    expect(store.socialStore.posts[0].status).toBe('draft');
    expect(store.socialStore.posts[0].body).toContain('Our spring menu is here');
    const draftCall = result.run.toolCalls.find((c) => c.toolName === 'draft_post')!;
    expect(draftCall.decision).toBe('allow');
    expect(draftCall.toolOutput).toMatchObject({ postId: store.socialStore.posts[0].id });
  });

  it('submitForReview: also moves the SAME post to "in_review" - the complete approval workflow, one step further', async () => {
    const store = makeStore();
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'social_media_super_agent', triggeredByKind: 'user',
      input: { task: 'draft_post', workspaceId: 'ws-acme', channelId: 'chan-1', network: 'facebook', topic: 'Grand opening', submitForReview: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('succeeded');
    expect(store.socialStore.posts[0].status).toBe('in_review');
    expect(result.run.toolCalls.map((c) => c.toolName)).toEqual(['draft_post', 'submit_post_for_review']);
    expect(result.run.toolCalls.every((c) => c.decision === 'allow')).toBe(true);
  });

  it('an ungranted Client: refused - no post is created', async () => {
    const store = makeStore();
    const result = await runAgent(store, principal('client'), {
      workspaceId: 'ws-acme', agentKey: 'social_media_super_agent', triggeredByKind: 'user',
      input: { task: 'draft_post', workspaceId: 'ws-acme', channelId: 'chan-1', network: 'facebook', topic: 'Anything' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('failed');
    expect(store.socialStore.posts).toHaveLength(0);
  });

  it('a Client granted social:create: allowed, same as a human with that same grant', async () => {
    const store = makeStore();
    const result = await runAgent(store, principal('client', [{ module: 'social', action: 'create' }]), {
      workspaceId: 'ws-acme', agentKey: 'social_media_super_agent', triggeredByKind: 'user',
      input: { task: 'draft_post', workspaceId: 'ws-acme', channelId: 'chan-1', network: 'facebook', topic: 'Anything' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('succeeded');
    expect(store.socialStore.posts).toHaveLength(1);
  });

  it('a brand-voice violation blocks the draft before any tool call is even proposed', async () => {
    const store = makeStore();
    store.brandVoice = { workspaceId: 'ws-acme', tone: null, prohibitedWords: ['guarantee'], examplePosts: [] };
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'social_media_super_agent', triggeredByKind: 'user',
      input: { task: 'draft_post', workspaceId: 'ws-acme', channelId: 'chan-1', network: 'facebook', topic: 'We guarantee amazing results' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.toolCalls).toHaveLength(0);
    expect(result.run.output).toMatchObject({ blocked: true });
    expect(store.socialStore.posts).toHaveLength(0);
  });

  it('attaches a sandbox image description when asked, with no real image generation', async () => {
    const store = makeStore();
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'social_media_super_agent', triggeredByKind: 'user',
      input: { task: 'draft_post', workspaceId: 'ws-acme', channelId: 'chan-1', network: 'facebook', topic: 'New collection', withImage: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(store.socialStore.posts[0].imageAlt).toContain('New collection');
  });

  it('a channel that does not exist makes the write fail cleanly (applyError), not silently', async () => {
    const store = makeStore();
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'social_media_super_agent', triggeredByKind: 'user',
      input: { task: 'draft_post', workspaceId: 'ws-acme', channelId: 'does-not-exist', network: 'facebook', topic: 'Anything' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('failed');
    const draftCall = result.run.toolCalls.find((c) => c.toolName === 'draft_post')!;
    expect(draftCall.applyError).toBeTruthy();
  });
});

describe('generate_calendar', () => {
  it('writes one calendar item per requested day', async () => {
    const store = makeStore();
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'social_media_super_agent', triggeredByKind: 'user',
      input: { task: 'generate_calendar', workspaceId: 'ws-acme', topic: 'seasonal promotions', startDate: '2026-10-06', days: 5 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('succeeded');
    expect(store.calendarItems).toHaveLength(5);
  });
});

describe('draft_reply', () => {
  it('creates a real reply draft, treating the interaction text as data', async () => {
    const store = makeStore();
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'social_media_super_agent', triggeredByKind: 'user',
      input: { task: 'draft_reply', workspaceId: 'ws-acme', interactionId: 'int-1', interactionBody: 'Do you deliver on weekends?' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(store.replyDrafts).toHaveLength(1);
    expect(store.replyDrafts[0].status).toBe('drafted');
    expect(store.replyDrafts[0].draftedByAgent).toBe(true);
  });

  it('submitForReview moves the same draft to in_review', async () => {
    const store = makeStore();
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'social_media_super_agent', triggeredByKind: 'user',
      input: { task: 'draft_reply', workspaceId: 'ws-acme', interactionId: 'int-1', interactionBody: 'Great service!', submitForReview: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(store.replyDrafts[0].status).toBe('in_review');
  });
});

describe('research_strategy and video_script - pure, no permission, nothing persisted', () => {
  it('research_strategy returns content pillars with decision null', async () => {
    const store = makeStore();
    const result = await runAgent(store, principal('client'), {
      workspaceId: 'ws-acme', agentKey: 'social_media_super_agent', triggeredByKind: 'user',
      input: { task: 'research_strategy', topic: 'loyalty programs' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('succeeded');
    expect(result.run.toolCalls[0].decision).toBeNull();
    expect((result.run.output as any).pillars).toHaveLength(3);
  });

  it('video_script returns a script, nothing written anywhere', async () => {
    const store = makeStore();
    const result = await runAgent(store, principal('client'), {
      workspaceId: 'ws-acme', agentKey: 'social_media_super_agent', triggeredByKind: 'user',
      input: { task: 'video_script', topic: 'behind the scenes', network: 'tiktok' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.run.output as any).script.hook.length).toBeGreaterThan(0);
    expect(store.socialStore.posts).toHaveLength(0);
  });
});

describe('handoffs - Orchestrator-mediated, not direct calls, and left unresolved (the receiving agents do not exist yet)', () => {
  it('request_analytics hands off to the Analytics/Reporting Agent', async () => {
    const store = makeStore();
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'social_media_super_agent', triggeredByKind: 'user',
      input: { task: 'request_analytics', metric: 'engagement_rate', channelIds: ['chan-1'] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.toolCalls).toHaveLength(0);
    expect(result.run.handoffs).toEqual([{ toAgentKey: 'analytics_reporting_agent', payload: { metric: 'engagement_rate', dateRange: undefined, channelIds: ['chan-1'] } }]);
  });

  it('propose_lead_handoff hands off to the Lead/CRM Agent', async () => {
    const store = makeStore();
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'social_media_super_agent', triggeredByKind: 'user',
      input: { task: 'propose_lead_handoff', interactionId: 'int-2', extractedContact: 'jordan@example.test', confidence: 0.8 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.handoffs[0].toAgentKey).toBe('lead_crm_agent');
  });
});
