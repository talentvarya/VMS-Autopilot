import { describe, expect, it } from 'vitest';
import type { Grant, Role } from '@/lib/permissions';
import { runAgent, type AgentStore, type ApprovalRequestInput, type Principal } from '@/lib/agents/orchestrator';
import type { AgentDefinition, DraftCampaignInput, UpdateCampaignBudgetInput } from '@/lib/agents/types';

class FakeStore implements AgentStore {
  approvals: ApprovalRequestInput[] = [];
  campaigns: (DraftCampaignInput & { id: string; status: 'draft' | 'in_review' })[] = [];
  budgetUpdates: UpdateCampaignBudgetInput[] = [];
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
  async draftCampaign(_principal: Principal, input: DraftCampaignInput) {
    const id = `campaign-${this.campaigns.length + 1}`;
    this.campaigns.push({ ...input, id, status: 'draft' });
    return { id };
  }
  async submitCampaignForReview(_principal: Principal, campaignId: string) {
    const c = this.campaigns.find((x) => x.id === campaignId);
    if (!c) throw new Error('not found');
    c.status = 'in_review';
  }
  async updateCampaignBudget(_principal: Principal, input: UpdateCampaignBudgetInput) {
    this.budgetUpdates.push(input);
  }
}

const definition: AgentDefinition = {
  id: 'def-paid-ads', workspaceId: 'ws-acme', agentKey: 'paid_ads_agent', displayName: 'Paid Ads Agent',
  description: null, model: 'sandbox', systemPrompt: '',
  allowedTools: ['draft_campaign', 'submit_campaign_for_review', 'update_campaign_budget', 'launch_campaign'],
  enabled: true,
};
const principal = (role: Role, grants: Grant[] = []): Principal => ({ id: 'user-1', role, grants });

describe('draft_campaign - paid_ads:create is never a Client default', () => {
  it('an ungranted Client cannot draft a campaign', async () => {
    const store = new FakeStore(definition);
    const result = await runAgent(store, principal('client'), {
      workspaceId: 'ws-acme', agentKey: 'paid_ads_agent', triggeredByKind: 'user',
      input: { task: 'draft_campaign', workspaceId: 'ws-acme', platform: 'meta', objective: 'awareness', name: 'Campaign' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('failed');
    expect(store.campaigns).toHaveLength(0);
  });

  it('an Admin can, and submitForReview chains a second tool call', async () => {
    const store = new FakeStore(definition);
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'paid_ads_agent', triggeredByKind: 'user',
      input: { task: 'draft_campaign', workspaceId: 'ws-acme', platform: 'meta', objective: 'awareness', name: 'Campaign', submitForReview: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('succeeded');
    expect(store.campaigns[0].status).toBe('in_review');
  });
});

describe('update_campaign_budget - sensitive per PRD 5.6, never spends anything real', () => {
  it('an Admin can change it directly', async () => {
    const store = new FakeStore(definition);
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'paid_ads_agent', triggeredByKind: 'user',
      input: { task: 'update_campaign_budget', workspaceId: 'ws-acme', campaignId: 'campaign-1', budgetAmount: 500, budgetPeriod: 'daily' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('succeeded');
    expect(store.budgetUpdates).toHaveLength(1);
  });

  it('a Team member granted paid_ads:publish_execute: needs approval, the budget is NOT changed yet', async () => {
    const store = new FakeStore(definition);
    const result = await runAgent(store, principal('team_member', [{ module: 'paid_ads', action: 'publish_execute' }]), {
      workspaceId: 'ws-acme', agentKey: 'paid_ads_agent', triggeredByKind: 'user',
      input: { task: 'update_campaign_budget', workspaceId: 'ws-acme', campaignId: 'campaign-1', budgetAmount: 500, budgetPeriod: 'daily' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('needs_approval');
    expect(store.budgetUpdates).toHaveLength(0);
    expect(store.approvals).toHaveLength(1);
  });
});

describe('launch_campaign - no apply() anywhere: proposing it never actually launches anything', () => {
  it('an Admin: decision is "allow", but nothing was applied (no apply() exists)', async () => {
    const store = new FakeStore(definition);
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'paid_ads_agent', triggeredByKind: 'user',
      input: { task: 'launch_campaign', workspaceId: 'ws-acme', campaignId: 'campaign-1' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('succeeded');
    expect(result.run.toolCalls[0].decision).toBe('allow');
    expect(result.run.toolCalls[0].toolOutput).toEqual({ ok: true }); // the generic placeholder - proves apply() never ran
  });

  it('a Client (or ungranted anyone): refused outright, files no approval either', async () => {
    const store = new FakeStore(definition);
    const result = await runAgent(store, principal('client'), {
      workspaceId: 'ws-acme', agentKey: 'paid_ads_agent', triggeredByKind: 'user',
      input: { task: 'launch_campaign', workspaceId: 'ws-acme', campaignId: 'campaign-1' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('failed');
  });
});
