import { describe, expect, it } from 'vitest';
import type { Grant, Role } from '@/lib/permissions';
import { runAgent, type AgentStore, type ApprovalRequestInput, type Principal } from '@/lib/agents/orchestrator';
import type { AgentDefinition, FinalizeAudienceBriefInput } from '@/lib/agents/types';

class FakeStore implements AgentStore {
  approvals: ApprovalRequestInput[] = [];
  briefs: (FinalizeAudienceBriefInput & { id: string; version: number })[] = [];
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
  async finalizeAudienceBrief(_principal: Principal, input: FinalizeAudienceBriefInput) {
    const id = `brief-${this.briefs.length + 1}`;
    this.briefs.push({ ...input, id, version: 1 });
    return { id, version: 1 };
  }
}

const definition: AgentDefinition = {
  id: 'def-ads-audience', workspaceId: 'ws-acme', agentKey: 'ads_audience_agent', displayName: 'Paid Ads Audience & Targeting Agent',
  description: null, model: 'sandbox', systemPrompt: '',
  allowedTools: ['intake_business_profile', 'research_audience_signals', 'create_audience_hypotheses', 'finalize_audience_brief'],
  enabled: true,
};
const principal = (role: Role, grants: Grant[] = []): Principal => ({ id: 'user-1', role, grants });
const businessProfile = { name: 'PureFuel', industry: 'protein supplements', product: 'whey protein' };

describe('this agent never touches a live account, budget or launch action', () => {
  it('no tool call across any task is ever mapped to paid_ads:edit or paid_ads:publish_execute', async () => {
    const store = new FakeStore(definition);
    const tasks = [
      { task: 'intake_business_profile', businessProfile },
      { task: 'research_audience_signals', businessProfile },
      { task: 'create_audience_hypotheses', businessProfile },
      { task: 'finalize_audience_brief', workspaceId: 'ws-acme', businessProfile },
    ];
    for (const input of tasks) {
      const result = await runAgent(store, principal('admin'), { workspaceId: 'ws-acme', agentKey: 'ads_audience_agent', triggeredByKind: 'user', input });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      for (const call of result.run.toolCalls) {
        if (call.permission) expect(['create', 'view']).toContain(call.permission.action);
      }
    }
  });
});

describe('finalize_audience_brief - needs an explicit grant, not a Client default', () => {
  it('an ungranted Client cannot finalize a brief', async () => {
    const store = new FakeStore(definition);
    const result = await runAgent(store, principal('client'), {
      workspaceId: 'ws-acme', agentKey: 'ads_audience_agent', triggeredByKind: 'user',
      input: { task: 'finalize_audience_brief', workspaceId: 'ws-acme', businessProfile },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('failed');
    expect(store.briefs).toHaveLength(0);
  });

  it('a Client granted paid_ads:create can', async () => {
    const store = new FakeStore(definition);
    const result = await runAgent(store, principal('client', [{ module: 'paid_ads', action: 'create' }]), {
      workspaceId: 'ws-acme', agentKey: 'ads_audience_agent', triggeredByKind: 'user',
      input: { task: 'finalize_audience_brief', workspaceId: 'ws-acme', businessProfile },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('succeeded');
    expect(store.briefs).toHaveLength(1);
  });
});

describe('the Paid Ads handoff is only ever proposed when explicitly requested', () => {
  it('finalizing without handoffToPaidAds proposes no handoff', async () => {
    const store = new FakeStore(definition);
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'ads_audience_agent', triggeredByKind: 'user',
      input: { task: 'finalize_audience_brief', workspaceId: 'ws-acme', businessProfile },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.handoffs).toHaveLength(0);
  });

  it('finalizing WITH handoffToPaidAds proposes a ready-to-use draft_campaign handoff', async () => {
    const store = new FakeStore(definition);
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'ads_audience_agent', triggeredByKind: 'user',
      input: { task: 'finalize_audience_brief', workspaceId: 'ws-acme', businessProfile, handoffToPaidAds: true, campaignName: 'PureFuel launch' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.handoffs).toHaveLength(1);
    expect(result.run.handoffs[0].toAgentKey).toBe('paid_ads_agent');
    expect(result.run.handoffs[0].payload).toMatchObject({ task: 'draft_campaign', name: 'PureFuel launch', platform: 'meta' });
  });
});

describe('Meta is recommended first, but the platform field supports Google now and room for more later', () => {
  it('defaults to meta when unspecified', async () => {
    const store = new FakeStore(definition);
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'ads_audience_agent', triggeredByKind: 'user',
      input: { task: 'create_audience_hypotheses', businessProfile },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.run.output as any).platform).toBe('meta');
  });

  it('accepts an explicit google platform too', async () => {
    const store = new FakeStore(definition);
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'ads_audience_agent', triggeredByKind: 'user',
      input: { task: 'create_audience_hypotheses', businessProfile, platform: 'google' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.run.output as any).platform).toBe('google');
  });
});
