import { describe, expect, it } from 'vitest';
import type { Grant, Role } from '@/lib/permissions';
import { runAgent, type AgentStore, type ApprovalRequestInput, type Principal } from '@/lib/agents/orchestrator';
import type { AgentDefinition, QueueAuditInput, RecordHealthCheckInput, RepairStaleInput } from '@/lib/agents/types';

/**
 * Fast, DB-free routing/permission proof for the Monitoring/Auto-Repair Agent.
 * tests/db/health-monitor.test.ts and tests/db/analytics-monitoring-agents.test.ts separately
 * prove it against real Postgres, the real failStaleRuns()/failStalePublishing(), and the real
 * SocialStore.
 */
class FakeStore implements AgentStore {
  approvals: ApprovalRequestInput[] = [];
  healthChecks: RecordHealthCheckInput[] = [];
  staleAuditRepairs: RepairStaleInput[] = [];
  staleSocialRepairs: RepairStaleInput[] = [];
  queuedAudits: QueueAuditInput[] = [];
  resumedPosts: string[] = [];
  staleAuditFailedCount = 0;
  staleSocialFailedCount = 0;
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
  async recordHealthCheck(_principal: Principal, input: RecordHealthCheckInput) {
    this.healthChecks.push(input);
    return { id: `check-${this.healthChecks.length}` };
  }
  async repairStaleAudits(_principal: Principal, input: RepairStaleInput) {
    this.staleAuditRepairs.push(input);
    return { failedCount: this.staleAuditFailedCount };
  }
  async repairStaleSocialPublishing(_principal: Principal, input: RepairStaleInput) {
    this.staleSocialRepairs.push(input);
    return { failedCount: this.staleSocialFailedCount };
  }
  async queueAudit(_principal: Principal, input: QueueAuditInput) {
    this.queuedAudits.push(input);
    return { runId: `audit-${this.queuedAudits.length}` };
  }
  async resumeFailedSocialPost(_principal: Principal, postId: string) {
    this.resumedPosts.push(postId);
  }
}

const definition = (overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({
  id: 'def-monitoring', workspaceId: 'ws-acme', agentKey: 'monitoring_auto_repair_agent', displayName: 'Monitoring/Auto-Repair Agent',
  description: null, model: 'sandbox', systemPrompt: '',
  allowedTools: ['check_website_availability', 'check_stale_audits', 'check_stale_social_publishing', 'requeue_failed_audit', 'resume_failed_post'],
  enabled: true,
  ...overrides,
});
const principal = (role: Role, grants: Grant[] = []): Principal => ({ id: 'user-1', role, grants });

describe('check_website_availability - sandbox-simulated, no real HTTP request', () => {
  it('reports "pass" for a known fixture origin', async () => {
    const store = new FakeStore(definition());
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'monitoring_auto_repair_agent', triggeredByKind: 'user',
      input: { task: 'check_website_availability', workspaceId: 'ws-acme', origin: 'https://nova-clinic.example.test' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(store.healthChecks[0].status).toBe('pass');
  });

  it('reports "fail" for an origin the sandbox has never heard of', async () => {
    const store = new FakeStore(definition());
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'monitoring_auto_repair_agent', triggeredByKind: 'user',
      input: { task: 'check_website_availability', workspaceId: 'ws-acme', origin: 'https://unknown-site.example.test' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(store.healthChecks[0].status).toBe('fail');
  });
});

describe('check_stale_audits / check_stale_social_publishing - health_monitor:edit, Admin-ceiling-only', () => {
  it('an Admin can run them directly', async () => {
    const store = new FakeStore(definition());
    store.staleAuditFailedCount = 2;
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'monitoring_auto_repair_agent', triggeredByKind: 'user',
      input: { task: 'check_stale_audits', workspaceId: 'ws-acme' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('succeeded');
    expect(result.run.toolCalls[0].toolOutput).toEqual({ failedCount: 2 });
  });

  it('a Client can NEVER run one, even if granted - health_monitor has no ceiling for non-admins at all', async () => {
    const store = new FakeStore(definition());
    const result = await runAgent(store, principal('client', [{ module: 'health_monitor', action: 'edit' }]), {
      workspaceId: 'ws-acme', agentKey: 'monitoring_auto_repair_agent', triggeredByKind: 'user',
      input: { task: 'check_stale_social_publishing', workspaceId: 'ws-acme' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('failed');
    expect(store.staleSocialRepairs).toHaveLength(0);
  });
});

describe('requeue_failed_audit - reuses the SAME queueAudit() the SEO/GEO Agent already uses', () => {
  it('queues a fresh run, never forcing the old one through', async () => {
    const store = new FakeStore(definition());
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'monitoring_auto_repair_agent', triggeredByKind: 'user',
      input: { task: 'requeue_failed_audit', workspaceId: 'ws-acme', siteId: 'site-1' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(store.queuedAudits).toEqual([{ workspaceId: 'ws-acme', siteId: 'site-1' }]);
  });
});

describe('resume_failed_post - reuses social:publish_execute, the module that actually governs a post', () => {
  it('an Admin: resumed directly', async () => {
    const store = new FakeStore(definition());
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'monitoring_auto_repair_agent', triggeredByKind: 'user',
      input: { task: 'resume_failed_post', workspaceId: 'ws-acme', postId: 'post-1' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('succeeded');
    expect(store.resumedPosts).toEqual(['post-1']);
  });

  it('a Team member granted social:publish_execute: needs approval, the post is NOT resumed yet (a Client\'s ceiling for social never even includes publish_execute - "a Client can never publish, whatever is granted")', async () => {
    const store = new FakeStore(definition());
    const result = await runAgent(store, principal('team_member', [{ module: 'social', action: 'publish_execute' }]), {
      workspaceId: 'ws-acme', agentKey: 'monitoring_auto_repair_agent', triggeredByKind: 'user',
      input: { task: 'resume_failed_post', workspaceId: 'ws-acme', postId: 'post-1' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('needs_approval');
    expect(store.resumedPosts).toHaveLength(0);
    expect(store.approvals).toHaveLength(1);
  });
});

describe('run_health_sweep - only ever includes the two "fail anything stale" checks automatically', () => {
  it('never calls requeue_failed_audit or resume_failed_post on its own', async () => {
    const store = new FakeStore(definition());
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'monitoring_auto_repair_agent', triggeredByKind: 'user',
      input: { task: 'run_health_sweep', workspaceId: 'ws-acme', siteOrigins: ['https://nova-clinic.example.test'] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const toolNames = result.run.toolCalls.map((c) => c.toolName);
    expect(toolNames).toEqual(['check_website_availability', 'check_stale_audits', 'check_stale_social_publishing']);
    expect(toolNames).not.toContain('requeue_failed_audit');
    expect(toolNames).not.toContain('resume_failed_post');
  });
});
