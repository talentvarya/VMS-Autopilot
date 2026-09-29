import { describe, expect, it } from 'vitest';
import type { Grant, Role } from '@/lib/permissions';
import { runAgent, type AgentStore, type ApprovalRequestInput, type Principal } from '@/lib/agents/orchestrator';
import type { AgentDefinition, DraftWebsitePlanInput } from '@/lib/agents/types';
import { checkDomainAvailability, suggestDomainNames } from '@/lib/agents/website/agent';

class FakeStore implements AgentStore {
  approvals: ApprovalRequestInput[] = [];
  plans: (DraftWebsitePlanInput & { id: string })[] = [];
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
  async draftWebsitePlan(_principal: Principal, input: DraftWebsitePlanInput) {
    const id = `project-${this.plans.length + 1}`;
    this.plans.push({ ...input, id });
    return { id };
  }
  async submitWebsitePlanForReview(_principal: Principal, _projectId: string) {}
}

const definition: AgentDefinition = {
  id: 'def-website', workspaceId: 'ws-acme', agentKey: 'website_domain_agent', displayName: 'Website/Domain Agent',
  description: null, model: 'sandbox', systemPrompt: '',
  allowedTools: ['draft_website_plan', 'submit_website_plan_for_review', 'research_domain_names', 'check_domain_availability', 'propose_domain_connection'],
  enabled: true,
};
const principal = (role: Role, grants: Grant[] = []): Principal => ({ id: 'user-1', role, grants });

describe('draft_website_plan - a Client can never attempt this, however it is granted', () => {
  it('is refused for a Client even WITH a (hypothetically) granted create permission', async () => {
    const store = new FakeStore(definition);
    const result = await runAgent(store, principal('client', [{ module: 'website', action: 'create' }]), {
      workspaceId: 'ws-acme', agentKey: 'website_domain_agent', triggeredByKind: 'user',
      input: { task: 'draft_website_plan', workspaceId: 'ws-acme', provider: 'vercel', title: 'New site', pages: [] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('failed'); // ceiling-blocked, not merely ungranted
    expect(store.plans).toHaveLength(0);
  });

  it('an Admin can draft one, and submitForReview chains a second tool call', async () => {
    const store = new FakeStore(definition);
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'website_domain_agent', triggeredByKind: 'user',
      input: { task: 'draft_website_plan', workspaceId: 'ws-acme', provider: 'vercel', title: 'New site', pages: [{ name: 'Home', sections: ['Hero', 'Contact'] }], submitForReview: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('succeeded');
    expect(result.run.toolCalls.map((c) => c.toolName)).toEqual(['draft_website_plan', 'submit_website_plan_for_review']);
  });
});

describe('domain research - pure, no permission, no real registrar', () => {
  it('research_domain_names returns suggestions across a few extensions', async () => {
    const store = new FakeStore(definition);
    const result = await runAgent(store, principal('client'), {
      workspaceId: 'ws-acme', agentKey: 'website_domain_agent', triggeredByKind: 'user',
      input: { task: 'research_domain_names', businessName: 'Acme Gym' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.run.output as any).suggestions.length).toBeGreaterThan(0);
    expect(result.run.toolCalls[0].decision).toBeNull();
  });

  it('check_domain_availability uses only a small fixture "taken" list, never a real lookup', () => {
    const availability = checkDomainAvailability(['example.com', 'a-totally-new-domain-12345.com']);
    expect(availability['example.com']).toBe(false);
    expect(availability['a-totally-new-domain-12345.com']).toBe(true);
  });

  it('suggestDomainNames is deterministic for the same input', () => {
    expect(suggestDomainNames('Acme Gym', ['fitness'])).toEqual(suggestDomainNames('Acme Gym', ['fitness']));
  });
});

describe('propose_domain_connection - sensitive, and has no apply() at all', () => {
  it('an Admin: decision is "allow", but nothing was actually connected (no apply() exists)', async () => {
    const store = new FakeStore(definition);
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'website_domain_agent', triggeredByKind: 'user',
      input: { task: 'propose_domain_connection', workspaceId: 'ws-acme', domain: 'acmegym.com' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.toolCalls[0].decision).toBe('allow');
    expect(result.run.toolCalls[0].toolOutput).toEqual({ ok: true });
  });

  it('an ungranted Client: refused outright (domains has no Client default at all)', async () => {
    const store = new FakeStore(definition);
    const result = await runAgent(store, principal('client'), {
      workspaceId: 'ws-acme', agentKey: 'website_domain_agent', triggeredByKind: 'user',
      input: { task: 'propose_domain_connection', workspaceId: 'ws-acme', domain: 'acmegym.com' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('failed');
  });

  it('a Client granted domains:create: needs approval, nothing is connected either way', async () => {
    const store = new FakeStore(definition);
    const result = await runAgent(store, principal('client', [{ module: 'domains', action: 'create' }]), {
      workspaceId: 'ws-acme', agentKey: 'website_domain_agent', triggeredByKind: 'user',
      input: { task: 'propose_domain_connection', workspaceId: 'ws-acme', domain: 'acmegym.com' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('needs_approval');
    expect(store.approvals).toHaveLength(1);
  });
});
