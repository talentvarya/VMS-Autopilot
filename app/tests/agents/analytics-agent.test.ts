import { describe, expect, it } from 'vitest';
import { runAgent, type AgentStore, type ApprovalRequestInput, type Principal } from '@/lib/agents/orchestrator';
import type { AgentDefinition } from '@/lib/agents/types';

/** Routing proof: the Analytics Agent runs, is always read-only, and rejects bad input gracefully. */
class FakeStore implements AgentStore {
  approvals: ApprovalRequestInput[] = [];
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
}

const definition: AgentDefinition = {
  id: 'def-analytics', workspaceId: 'ws-acme', agentKey: 'analytics_reporting_agent', displayName: 'Analytics/Reporting Agent',
  description: null, model: 'sandbox', systemPrompt: '',
  allowedTools: ['summarize_seo_performance', 'summarize_social_activity', 'summarize_content_pipeline', 'summarize_agent_activity', 'compile_report'],
  enabled: true,
};
const principal = (role: Principal['role']): Principal => ({ id: 'user-1', role, grants: [] });

describe('Analytics Agent - always succeeds and never files an approval, for any role', () => {
  it('a Client can run it - reports:view is a default, and nothing here is ever sensitive', async () => {
    const store = new FakeStore(definition);
    const result = await runAgent(store, principal('client'), {
      workspaceId: 'ws-acme', agentKey: 'analytics_reporting_agent', triggeredByKind: 'user',
      input: { task: 'summarize_social_activity', posts: [{ status: 'draft', network: 'facebook' }] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('succeeded');
    expect(result.run.toolCalls[0].decision).toBe('allow');
    expect(store.approvals).toHaveLength(0);
  });
});

describe('Analytics Agent - malformed input is rejected gracefully, not a crash', () => {
  it('an unknown task returns ok:false with a clear reason, not a thrown exception', async () => {
    const store = new FakeStore(definition);
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'analytics_reporting_agent', triggeredByKind: 'user',
      input: { task: 'delete_everything' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/unknown Analytics Agent task/);
  });

  it('a malformed legacy request_analytics handoff (missing dateRange) is rejected, not silently patched', async () => {
    const store = new FakeStore(definition);
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'analytics_reporting_agent', triggeredByKind: 'agent',
      input: { metric: 'reach', channelIds: ['chan-1'] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/metric, dateRange and channelIds/);
  });

  it('a valid legacy request_analytics handoff succeeds and maps to summarize_social_activity', async () => {
    const store = new FakeStore(definition);
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'analytics_reporting_agent', triggeredByKind: 'agent',
      input: { metric: 'reach', dateRange: 'last_7_days', channelIds: ['chan-1'], posts: [] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('succeeded');
    expect(result.run.toolCalls[0].toolName).toBe('summarize_social_activity');
  });
});
