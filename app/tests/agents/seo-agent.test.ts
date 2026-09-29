import { describe, expect, it } from 'vitest';
import type { Grant, Role } from '@/lib/permissions';
import { runAgent, type AgentStore, type ApprovalRequestInput, type Principal } from '@/lib/agents/orchestrator';
import type { AgentDefinition, ProposeFixInput, QueueAuditInput } from '@/lib/agents/types';

/**
 * Fast, DB-free routing/permission proof for the SEO/GEO Agent. tests/db/seo-content-agents.test.ts
 * separately proves it against the REAL Phase 2 engine and real Postgres.
 */
class FakeStore implements AgentStore {
  approvals: ApprovalRequestInput[] = [];
  queuedAudits: QueueAuditInput[] = [];
  proposedFixes: ProposeFixInput[] = [];
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
  async queueAudit(_principal: Principal, input: QueueAuditInput) {
    this.queuedAudits.push(input);
    return { runId: `audit-${this.queuedAudits.length}` };
  }
  async proposeFix(_principal: Principal, input: ProposeFixInput) {
    this.proposedFixes.push(input);
  }
}

const definition = (overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({
  id: 'def-seo', workspaceId: 'ws-acme', agentKey: 'seo_geo_agent', displayName: 'SEO/GEO Agent',
  description: null, model: 'sandbox', systemPrompt: '',
  allowedTools: ['queue_audit', 'explain_findings', 'propose_fix'], enabled: true,
  ...overrides,
});
const principal = (role: Role, grants: Grant[] = []): Principal => ({ id: 'user-1', role, grants });

describe('queue_audit - seo_geo:create is a Client default', () => {
  it('an ungranted Client is allowed directly - no approval request', async () => {
    const store = new FakeStore(definition());
    const result = await runAgent(store, principal('client'), {
      workspaceId: 'ws-acme', agentKey: 'seo_geo_agent', triggeredByKind: 'user',
      input: { task: 'queue_audit', workspaceId: 'ws-acme', siteId: 'site-1' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('succeeded');
    expect(store.queuedAudits).toEqual([{ workspaceId: 'ws-acme', siteId: 'site-1' }]);
    expect(store.approvals).toHaveLength(0);
  });
});

describe('explain_findings - pure, no permission, nothing written', () => {
  it('summarizes findings already given as input', async () => {
    const store = new FakeStore(definition());
    const result = await runAgent(store, principal('client'), {
      workspaceId: 'ws-acme', agentKey: 'seo_geo_agent', triggeredByKind: 'user',
      input: { task: 'explain_findings', findings: [{ category: 'technical', severity: 'critical', code: 'x', title: 'x', evidence: '', recommendation: '' }] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.toolCalls[0].decision).toBeNull();
    expect((result.run.output as any).summary).toContain('critical');
  });
});

describe('propose_fix - seo_geo:publish_execute is sensitive', () => {
  it('an Admin: fix recorded directly', async () => {
    const store = new FakeStore(definition());
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'seo_geo_agent', triggeredByKind: 'user',
      input: { task: 'propose_fix', workspaceId: 'ws-acme', findingId: 'finding-1' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('succeeded');
    expect(store.proposedFixes).toHaveLength(1);
    expect(store.approvals).toHaveLength(0);
  });

  it('an ungranted Client: refused outright - publish_execute is not a Client default, so no grant means no approval queue either', async () => {
    const store = new FakeStore(definition());
    const result = await runAgent(store, principal('client'), {
      workspaceId: 'ws-acme', agentKey: 'seo_geo_agent', triggeredByKind: 'user',
      input: { task: 'propose_fix', workspaceId: 'ws-acme', findingId: 'finding-1' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('failed');
    expect(store.proposedFixes).toHaveLength(0);
    expect(store.approvals).toHaveLength(0);
  });

  it('a Client granted seo_geo:publish_execute: needs approval, the fix is NOT recorded yet', async () => {
    const store = new FakeStore(definition());
    const result = await runAgent(store, principal('client', [{ module: 'seo_geo', action: 'publish_execute' }]), {
      workspaceId: 'ws-acme', agentKey: 'seo_geo_agent', triggeredByKind: 'user',
      input: { task: 'propose_fix', workspaceId: 'ws-acme', findingId: 'finding-1' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('needs_approval');
    expect(store.proposedFixes).toHaveLength(0);
    expect(store.approvals).toHaveLength(1);
    expect(store.approvals[0]).toMatchObject({ module: 'seo_geo', action: 'publish_execute' });
  });
});

describe('content_brief_handoff - a handoff, not a tool call, and only ever explicit', () => {
  it('proposes a handoff shaped as a ready-to-use content_agent input, with no social cascade by default', async () => {
    const store = new FakeStore(definition());
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'seo_geo_agent', triggeredByKind: 'user',
      input: { task: 'content_brief_handoff', workspaceId: 'ws-acme', findingId: 'finding-1', title: 'Fix your title tags', topic: 'why title tags matter' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.toolCalls).toHaveLength(0);
    // Unresolved here because this FakeStore has no content_agent definition at all - the
    // real chain is proven in tests/db/seo-content-agents.test.ts.
    expect(result.run.resolvedHandoffs).toHaveLength(1);
    expect(result.run.resolvedHandoffs[0].resolved).toBe(false);
    expect(result.run.handoffs[0]).toEqual({
      toAgentKey: 'content_agent',
      payload: { task: 'draft_article', workspaceId: 'ws-acme', title: 'Fix your title tags', topic: 'why title tags matter', sourceFindingId: 'finding-1', alsoRepurposeToSocial: undefined, repurposeChannels: undefined },
    });
  });
});
