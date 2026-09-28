import { describe, expect, it } from 'vitest';
import type { Grant, Role } from '@/lib/permissions';
import { runAgent, type AgentStore, type ApprovalRequestInput, type Principal } from '@/lib/agents/orchestrator';
import type { AgentDefinition } from '@/lib/agents/types';

/**
 * An in-memory fake of AgentStore - the same style as SocialStore's fixtures (tests/social):
 * no database, no network, deterministic. tests/db/agents.test.ts separately proves the real
 * Postgres schema, triggers and RLS enforce the same rules for real.
 */
class FakeStore implements AgentStore {
  definitions: AgentDefinition[];
  approvals: ApprovalRequestInput[] = [];
  private n = 0;

  constructor(definitions: AgentDefinition[]) {
    this.definitions = definitions;
  }
  async findDefinition(workspaceId: string, agentKey: string) {
    return this.definitions.find((d) => d.workspaceId === workspaceId && d.agentKey === agentKey) ?? null;
  }
  newId() {
    return `run-${++this.n}`;
  }
  async createApprovalRequest(input: ApprovalRequestInput) {
    this.approvals.push(input);
    return { id: `approval-${this.approvals.length}` };
  }
}

const echoDefinition = (overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({
  id: 'def-1',
  workspaceId: 'ws-acme',
  agentKey: 'sandbox_echo',
  displayName: 'Sandbox Echo',
  description: null,
  model: 'sandbox-echo',
  systemPrompt: '',
  allowedTools: ['echo_message', 'propose_demo_action', 'propose_grantable_demo_action'],
  enabled: true,
  ...overrides,
});

const principal = (role: Role, grants: Grant[] = []): Principal => ({ id: 'user-1', role, grants });

describe('runAgent - routing', () => {
  it('refuses a request for an agent that is not configured for this workspace', async () => {
    const store = new FakeStore([]);
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'sandbox_echo', triggeredByKind: 'user', input: { message: 'hi' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no agent named/);
  });

  it('refuses a request for an agent that is switched off', async () => {
    const store = new FakeStore([echoDefinition({ enabled: false })]);
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'sandbox_echo', triggeredByKind: 'user', input: { message: 'hi' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/switched off/);
  });

  it("never runs a different workspace's definition of the same agent key", async () => {
    const store = new FakeStore([echoDefinition({ id: 'other', workspaceId: 'ws-other' })]);
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'sandbox_echo', triggeredByKind: 'user', input: { message: 'hi' },
    });
    expect(result.ok).toBe(false);
  });
});

describe('runAgent - a pure utility tool call needs no permission at all', () => {
  it('succeeds for every role, with no approval request created', async () => {
    for (const role of ['admin', 'team_member', 'client'] as const) {
      const store = new FakeStore([echoDefinition()]);
      const result = await runAgent(store, principal(role), {
        workspaceId: 'ws-acme', agentKey: 'sandbox_echo', triggeredByKind: 'user', input: { message: 'hello' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.run.status).toBe('succeeded');
      expect(result.run.toolCalls).toHaveLength(1);
      expect(result.run.toolCalls[0]).toMatchObject({ toolName: 'echo_message', decision: null, onBehalfOf: null });
      expect(result.run.output).toEqual({ echoed: 'hello' });
      expect(store.approvals).toHaveLength(0);
    }
  });
});

describe('runAgent - a ceiling-blocked action (ai_assistant:publish_execute - "Client AI is read-only")', () => {
  it('an Admin: allowed directly, no approval request, run succeeds', async () => {
    const store = new FakeStore([echoDefinition()]);
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'sandbox_echo', triggeredByKind: 'user',
      input: { message: 'do the thing', proposeDemoAction: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('succeeded');
    const demo = result.run.toolCalls.find((c) => c.toolName === 'propose_demo_action')!;
    expect(demo.decision).toBe('allow');
    expect(demo.onBehalfOf).toBe('user-1');
    expect(store.approvals).toHaveLength(0);
  });

  it('a Client or Team member: refused outright - no grant could ever unlock it, so no approval is filed either', async () => {
    for (const role of ['client', 'team_member'] as const) {
      // Even WITH a grant, the role ceiling itself caps ai_assistant at "view" - a grant for
      // publish_execute could never be created in the first place (checkGrant() would refuse
      // it). This proves the run fails outright rather than quietly waiting for an approval
      // that could never come.
      const store = new FakeStore([echoDefinition()]);
      const result = await runAgent(store, principal(role), {
        workspaceId: 'ws-acme', agentKey: 'sandbox_echo', triggeredByKind: 'user',
        input: { message: 'do the thing', proposeDemoAction: true },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.run.status).toBe('failed');
      const demo = result.run.toolCalls.find((c) => c.toolName === 'propose_demo_action')!;
      expect(demo.decision).toBe('deny');
      expect(store.approvals).toHaveLength(0);
    }
  });
});

describe('runAgent - a grantable sensitive action (paid_ads:publish_execute)', () => {
  it('an Admin: allowed directly', async () => {
    const store = new FakeStore([echoDefinition()]);
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'sandbox_echo', triggeredByKind: 'user',
      input: { message: 'raise the budget', proposeGrantableDemoAction: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('succeeded');
    expect(store.approvals).toHaveLength(0);
  });

  it('a Client or Team member with NO grant: denied - not yet given the capability at all', async () => {
    for (const role of ['client', 'team_member'] as const) {
      const store = new FakeStore([echoDefinition()]);
      const result = await runAgent(store, principal(role), {
        workspaceId: 'ws-acme', agentKey: 'sandbox_echo', triggeredByKind: 'user',
        input: { message: 'raise the budget', proposeGrantableDemoAction: true },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.run.status).toBe('failed');
      expect(store.approvals).toHaveLength(0);
    }
  });

  it('a Client or Team member WITH the grant: still needs Admin approval, a real approval request is filed, and nothing is applied yet', async () => {
    for (const role of ['client', 'team_member'] as const) {
      const store = new FakeStore([echoDefinition()]);
      const result = await runAgent(store, principal(role, [{ module: 'paid_ads', action: 'publish_execute' }]), {
        workspaceId: 'ws-acme', agentKey: 'sandbox_echo', triggeredByKind: 'user',
        input: { message: 'raise the budget', proposeGrantableDemoAction: true },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.run.status).toBe('needs_approval');
      const demo = result.run.toolCalls.find((c) => c.toolName === 'propose_grantable_demo_action')!;
      expect(demo.decision).toBe('needs_approval');
      expect(demo.toolOutput).toBeNull(); // never applied - only proposed
      expect(demo.approvalId).toBe('approval-1');
      expect(store.approvals).toHaveLength(1);
      expect(store.approvals[0]).toMatchObject({ module: 'paid_ads', action: 'publish_execute', requestedBy: 'user-1' });
    }
  });
});

describe('runAgent - a tool the agent is not allowed to use', () => {
  it('is refused, and the whole run fails rather than silently skipping it', async () => {
    const store = new FakeStore([echoDefinition({ allowedTools: ['echo_message'] })]); // demo tool NOT allowed
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'sandbox_echo', triggeredByKind: 'user',
      input: { message: 'do the thing', proposeDemoAction: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('failed');
    const demo = result.run.toolCalls.find((c) => c.toolName === 'propose_demo_action')!;
    expect(demo.decision).toBe('deny');
    expect(store.approvals).toHaveLength(0); // never even reaches the permission system
  });

  it('a tool that does not exist anywhere is refused the same way', async () => {
    const store = new FakeStore([echoDefinition()]);
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'sandbox_echo', triggeredByKind: 'user',
      input: { message: 'oops', proposeUnknownTool: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('failed');
    expect(result.run.toolCalls.find((c) => c.toolName === 'delete_everything')?.decision).toBe('deny');
  });
});

describe('runAgent - handoffs pass through untouched', () => {
  it('carries a proposed handoff onto the run record without acting on it', async () => {
    const store = new FakeStore([echoDefinition()]);
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'sandbox_echo', triggeredByKind: 'user',
      input: { message: 'pass it on', handoffTo: 'content_agent' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.handoffs).toEqual([{ toAgentKey: 'content_agent', payload: { fromMessage: 'pass it on' } }]);
  });
});

describe('runAgent - triggered_by_kind', () => {
  it('records the human as triggered_by only for a user-triggered run', async () => {
    const store = new FakeStore([echoDefinition()]);
    const asUser = await runAgent(store, principal('admin'), { workspaceId: 'ws-acme', agentKey: 'sandbox_echo', triggeredByKind: 'user', input: { message: 'hi' } });
    const asSystem = await runAgent(store, principal('admin'), { workspaceId: 'ws-acme', agentKey: 'sandbox_echo', triggeredByKind: 'system', input: { message: 'hi' } });
    expect(asUser.ok && asUser.run.triggeredBy).toBe('user-1');
    expect(asSystem.ok && asSystem.run.triggeredBy).toBeNull();
  });
});
