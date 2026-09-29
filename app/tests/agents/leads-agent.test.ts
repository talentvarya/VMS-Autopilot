import { describe, expect, it } from 'vitest';
import type { Grant, Role } from '@/lib/permissions';
import { runAgent, type AgentStore, type ApprovalRequestInput, type Principal } from '@/lib/agents/orchestrator';
import type { AgentDefinition, CaptureLeadFromInteractionInput, CaptureLeadInput, DraftFollowUpInput, QualifyLeadInput } from '@/lib/agents/types';

class FakeStore implements AgentStore {
  approvals: ApprovalRequestInput[] = [];
  leads: (CaptureLeadInput & { id: string; status: string })[] = [];
  leadsByInteraction = new Map<string, string>();
  qualifications: QualifyLeadInput[] = [];
  followUps: DraftFollowUpInput[] = [];
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
  async captureLead(_principal: Principal, input: CaptureLeadInput) {
    const id = `lead-${this.leads.length + 1}`;
    this.leads.push({ ...input, id, status: 'new' });
    return { id };
  }
  async captureLeadFromInteraction(_principal: Principal, input: CaptureLeadFromInteractionInput) {
    const existing = this.leadsByInteraction.get(input.interactionId);
    if (existing) return { id: existing, created: false };
    const id = `lead-${this.leads.length + 1}`;
    this.leads.push({ workspaceId: input.workspaceId, source: 'social_dm', contact: input.extractedContact, id, status: 'new' });
    this.leadsByInteraction.set(input.interactionId, id);
    return { id, created: true };
  }
  async qualifyLead(_principal: Principal, input: QualifyLeadInput) {
    this.qualifications.push(input);
    const lead = this.leads.find((l) => l.id === input.leadId);
    if (lead) lead.status = input.status;
  }
  async draftFollowUp(_principal: Principal, input: DraftFollowUpInput) {
    this.followUps.push(input);
    return { id: `activity-${this.followUps.length}` };
  }
}

const definition: AgentDefinition = {
  id: 'def-leads', workspaceId: 'ws-acme', agentKey: 'lead_crm_agent', displayName: 'Lead/CRM Agent',
  description: null, model: 'sandbox', systemPrompt: '',
  allowedTools: ['capture_lead', 'qualify_lead', 'draft_follow_up'], enabled: true,
};
const principal = (role: Role, grants: Grant[] = []): Principal => ({ id: 'user-1', role, grants });

describe('capture_lead / qualify_lead - never sensitive, the lightest-touch module', () => {
  it('an ungranted Client cannot capture a lead either (leads_crm:create is never a default)', async () => {
    const store = new FakeStore(definition);
    const result = await runAgent(store, principal('client'), {
      workspaceId: 'ws-acme', agentKey: 'lead_crm_agent', triggeredByKind: 'user',
      input: { task: 'capture_lead', workspaceId: 'ws-acme', source: 'form', name: 'Jordan' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('failed');
  });

  it('a granted Client can capture and qualify directly - never needs approval', async () => {
    const store = new FakeStore(definition);
    const result = await runAgent(store, principal('client', [{ module: 'leads_crm', action: 'create' }, { module: 'leads_crm', action: 'edit' }]), {
      workspaceId: 'ws-acme', agentKey: 'lead_crm_agent', triggeredByKind: 'user',
      input: { task: 'capture_lead', workspaceId: 'ws-acme', source: 'form', name: 'Jordan' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('succeeded');
    expect(store.approvals).toHaveLength(0);
  });

  it('draft_follow_up never sends anything - it only produces text', async () => {
    const store = new FakeStore(definition);
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'lead_crm_agent', triggeredByKind: 'user',
      input: { task: 'draft_follow_up', workspaceId: 'ws-acme', leadId: 'lead-1', context: 'asked about pricing' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(store.followUps).toHaveLength(1);
    expect((result.run.output as any).draftedBody.length).toBeGreaterThan(0);
  });
});

describe('the legacy propose_lead_handoff compatibility rule - fast unit proof', () => {
  it('valid: maps to capture_lead_from_interaction', async () => {
    const store = new FakeStore(definition);
    const result = await runAgent(store, principal('admin'), {
      workspaceId: 'ws-acme', agentKey: 'lead_crm_agent', triggeredByKind: 'agent',
      input: { workspaceId: 'ws-acme', interactionId: 'interaction-1', extractedContact: 'x@example.test', confidence: 0.7 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.toolCalls[0].toolName).toBe('capture_lead');
    expect(store.leads).toHaveLength(1);
  });

  it('invalid: no task and no interactionId is rejected', async () => {
    const store = new FakeStore(definition);
    const result = await runAgent(store, principal('admin'), { workspaceId: 'ws-acme', agentKey: 'lead_crm_agent', triggeredByKind: 'agent', input: { workspaceId: 'ws-acme', somethingElse: true } });
    expect(result.ok).toBe(false);
  });

  it('partial: interactionId present but workspaceId missing is rejected', async () => {
    const store = new FakeStore(definition);
    const result = await runAgent(store, principal('admin'), { workspaceId: 'ws-acme', agentKey: 'lead_crm_agent', triggeredByKind: 'agent', input: { interactionId: 'interaction-1' } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/workspaceId/);
  });

  it('unknown task is rejected outright', async () => {
    const store = new FakeStore(definition);
    const result = await runAgent(store, principal('admin'), { workspaceId: 'ws-acme', agentKey: 'lead_crm_agent', triggeredByKind: 'user', input: { task: 'send_email', workspaceId: 'ws-acme' } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/unknown Lead\/CRM Agent task/);
  });
});
