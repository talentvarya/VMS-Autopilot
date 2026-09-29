import { describe, expect, it } from 'vitest';
import type { Grant, Role } from '@/lib/permissions';
import { runAgent, type AgentStore, type ApprovalRequestInput, type Principal } from '@/lib/agents/orchestrator';
import type { AgentDefinition, CreateContentDraftInput } from '@/lib/agents/types';

/**
 * Fast, DB-free routing/permission proof for the Content Agent. tests/db/seo-content-agents.test.ts
 * separately proves it against real Postgres and the real handoff chain.
 */
class FakeStore implements AgentStore {
  approvals: ApprovalRequestInput[] = [];
  drafts: (CreateContentDraftInput & { id: string; status: 'draft' | 'in_review' })[] = [];
  private n = 0;

  constructor(private readonly def: AgentDefinition) {}
  async findDefinition(workspaceId: string, agentKey: string) {
    return this.def.workspaceId === workspaceId && this.def.agentKey === agentKey ? this.def : null;
  }
  newId() {
    return `run-${++this.n}`;
  }
  async createApprovalRequest(input: ApprovalRequestInput) {
    this.approvals.push(input);
    return { id: `approval-${this.approvals.length}` };
  }
  async createContentDraft(_principal: Principal, input: CreateContentDraftInput) {
    const id = `draft-${this.drafts.length + 1}`;
    this.drafts.push({ ...input, id, status: 'draft' });
    return { id };
  }
  async submitContentDraftForReview(_principal: Principal, draftId: string) {
    const draft = this.drafts.find((d) => d.id === draftId);
    if (!draft) throw new Error('not found');
    draft.status = 'in_review';
  }
}

const definition = (overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({
  id: 'def-content', workspaceId: 'ws-acme', agentKey: 'content_agent', displayName: 'Content Agent',
  description: null, model: 'sandbox', systemPrompt: '',
  allowedTools: ['draft_article', 'submit_article_for_review'], enabled: true,
  ...overrides,
});
const principal = (role: Role, grants: Grant[] = []): Principal => ({ id: 'user-1', role, grants });

describe('draft_article - reuses the approved seo_geo:create Client default', () => {
  it('an ungranted Client can draft an article', async () => {
    const store = new FakeStore(definition());
    const result = await runAgent(store, principal('client'), {
      workspaceId: 'ws-acme', agentKey: 'content_agent', triggeredByKind: 'user',
      input: { task: 'draft_article', workspaceId: 'ws-acme', title: 'New hours', topic: 'open on Saturdays now' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('succeeded');
    expect(store.drafts).toHaveLength(1);
    expect(store.drafts[0].status).toBe('draft');
    expect(store.drafts[0].draftedByAgent).toBe(true);
  });

  it('links back to a source finding when one is given', async () => {
    const store = new FakeStore(definition());
    await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'content_agent', triggeredByKind: 'user',
      input: { task: 'draft_article', workspaceId: 'ws-acme', title: 'T', topic: 'X', sourceFindingId: 'finding-9' },
    });
    expect(store.drafts[0].sourceFindingId).toBe('finding-9');
  });
});

describe('submit_article_for_review', () => {
  it('moves the draft to in_review, and never further - there is no approve/publish tool here', async () => {
    const store = new FakeStore(definition());
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'content_agent', triggeredByKind: 'user',
      input: { task: 'draft_article', workspaceId: 'ws-acme', title: 'T', topic: 'X', submitForReview: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(store.drafts[0].status).toBe('in_review');
    expect(result.run.toolCalls.map((c) => c.toolName)).toEqual(['draft_article', 'submit_article_for_review']);
    expect(result.run.toolCalls.every((c) => c.toolName !== 'approve' && c.toolName !== 'publish_article')).toBe(true);
  });
});

describe('social repurposing is never automatic', () => {
  it('drafting an article proposes no handoff at all by default', async () => {
    const store = new FakeStore(definition());
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'content_agent', triggeredByKind: 'user',
      input: { task: 'draft_article', workspaceId: 'ws-acme', title: 'T', topic: 'X' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.handoffs).toHaveLength(0);
  });

  it('proposes the handoff only when explicitly asked, shaped as a ready-to-use repurpose_blog input', async () => {
    const store = new FakeStore(definition());
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'content_agent', triggeredByKind: 'user',
      input: {
        task: 'draft_article', workspaceId: 'ws-acme', title: 'Grand opening', topic: 'we are opening a new location',
        alsoRepurposeToSocial: true, repurposeChannels: [{ channelId: 'chan-1', network: 'facebook' }],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.handoffs).toHaveLength(1);
    expect(result.run.handoffs[0].toAgentKey).toBe('social_media_super_agent');
    expect(result.run.handoffs[0].payload).toMatchObject({ task: 'repurpose_blog', workspaceId: 'ws-acme', blogTitle: 'Grand opening' });
    // Unresolved here (no social_media_super_agent definition in this FakeStore) - the real
    // resolution is proven in tests/db/seo-content-agents.test.ts.
    expect(result.run.resolvedHandoffs[0].resolved).toBe(false);
  });

  it('does not propose the handoff if requested but no channels are given', async () => {
    const store = new FakeStore(definition());
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'content_agent', triggeredByKind: 'user',
      input: { task: 'draft_article', workspaceId: 'ws-acme', title: 'T', topic: 'X', alsoRepurposeToSocial: true, repurposeChannels: [] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.handoffs).toHaveLength(0);
  });
});
