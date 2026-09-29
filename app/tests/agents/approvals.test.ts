import { describe, expect, it } from 'vitest';
import { resolveApproval } from '@/lib/agents/approvals';
import type { AgentStore, ApprovalRequestInput, ApprovalRequestRecord, Principal, UpdateCampaignBudgetInput } from '@/lib/agents/types';

class FakeApprovalStore implements AgentStore {
  requests = new Map<string, ApprovalRequestRecord>();
  budgetUpdates: UpdateCampaignBudgetInput[] = [];
  private n = 0;

  async findDefinition() {
    return null;
  }
  newId() {
    return `id-${++this.n}`;
  }
  async createApprovalRequest(input: ApprovalRequestInput) {
    const id = `approval-${++this.n}`;
    this.requests.set(id, { id, workspaceId: input.workspaceId, requestedBy: input.requestedBy, module: input.module, action: input.action, title: input.title, details: input.details, status: 'pending' });
    return { id };
  }
  async getApprovalRequest(_workspaceId: string, approvalId: string) {
    return this.requests.get(approvalId) ?? null;
  }
  async decideApprovalRequest(approvalId: string, _decidedBy: string, status: 'approved' | 'rejected') {
    const record = this.requests.get(approvalId);
    if (!record) throw new Error('not found');
    record.status = status;
  }
  async updateCampaignBudget(_principal: Principal, input: UpdateCampaignBudgetInput) {
    this.budgetUpdates.push(input);
  }
}

const admin = (): Principal => ({ id: 'admin-1', role: 'admin', grants: [] });
const teamMember = (): Principal => ({ id: 'team-1', role: 'team_member', grants: [] });

async function pendingBudgetApproval(store: FakeApprovalStore) {
  const { id } = await store.createApprovalRequest({
    workspaceId: 'ws-acme',
    requestedBy: 'team-1',
    module: 'paid_ads',
    action: 'publish_execute',
    title: 'Paid Ads Agent: update_campaign_budget',
    details: { toolName: 'update_campaign_budget', toolInput: { campaignId: 'campaign-1', budgetAmount: 500, budgetPeriod: 'daily' }, agentKey: 'paid_ads_agent' },
  });
  return id;
}

describe('resolveApproval - only an Admin may decide, matching the DB trigger rule independently', () => {
  it('a non-admin is refused outright, and nothing is decided', async () => {
    const store = new FakeApprovalStore();
    const id = await pendingBudgetApproval(store);
    const outcome = await resolveApproval(store, teamMember(), 'ws-acme', id, 'approved');
    expect(outcome.ok).toBe(false);
    const record = await store.getApprovalRequest('ws-acme', id);
    expect(record?.status).toBe('pending');
  });
});

describe('resolveApproval - rejecting never executes anything', () => {
  it('marks the request rejected, applies nothing', async () => {
    const store = new FakeApprovalStore();
    const id = await pendingBudgetApproval(store);
    const outcome = await resolveApproval(store, admin(), 'ws-acme', id, 'rejected', 'not now');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.applied).toBe(false);
    expect(outcome.status).toBe('rejected');
    expect(store.budgetUpdates).toHaveLength(0);
    const record = await store.getApprovalRequest('ws-acme', id);
    expect(record?.status).toBe('rejected');
  });
});

describe('resolveApproval - approving a tool WITH a registered resume handler actually executes it', () => {
  it('update_campaign_budget resumes for real once approved', async () => {
    const store = new FakeApprovalStore();
    const id = await pendingBudgetApproval(store);
    const outcome = await resolveApproval(store, admin(), 'ws-acme', id, 'approved');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.applied).toBe(true);
    expect(outcome.result).toMatchObject({ campaignId: 'campaign-1', budgetAmount: 500, budgetPeriod: 'daily' });
    expect(store.budgetUpdates).toHaveLength(1);
    expect(store.budgetUpdates[0]).toMatchObject({ workspaceId: 'ws-acme', campaignId: 'campaign-1', budgetAmount: 500 });
    const record = await store.getApprovalRequest('ws-acme', id);
    expect(record?.status).toBe('approved');
  });
});

describe('resolveApproval - approving a tool with NO registered handler records the decision but executes nothing', () => {
  it('e.g. launch_campaign, which has no apply() at all either', async () => {
    const store = new FakeApprovalStore();
    const { id } = await store.createApprovalRequest({
      workspaceId: 'ws-acme',
      requestedBy: 'team-1',
      module: 'paid_ads',
      action: 'publish_execute',
      title: 'Paid Ads Agent: launch_campaign',
      details: { toolName: 'launch_campaign', toolInput: { campaignId: 'campaign-1' }, agentKey: 'paid_ads_agent' },
    });
    const outcome = await resolveApproval(store, admin(), 'ws-acme', id, 'approved');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.applied).toBe(false);
    expect(outcome.status).toBe('approved');
  });
});

describe('resolveApproval - edge cases', () => {
  it('an unknown approval id fails with a clear reason', async () => {
    const store = new FakeApprovalStore();
    const outcome = await resolveApproval(store, admin(), 'ws-acme', 'no-such-id', 'approved');
    expect(outcome.ok).toBe(false);
  });

  it('a request that was already decided cannot be decided again', async () => {
    const store = new FakeApprovalStore();
    const id = await pendingBudgetApproval(store);
    await resolveApproval(store, admin(), 'ws-acme', id, 'rejected');
    const second = await resolveApproval(store, admin(), 'ws-acme', id, 'approved');
    expect(second.ok).toBe(false);
    expect(store.budgetUpdates).toHaveLength(0);
  });

  it('a store that does not implement approval resolution fails clearly rather than throwing', async () => {
    const bareStore: AgentStore = { findDefinition: async () => null, newId: () => 'x', createApprovalRequest: async () => ({ id: 'a' }) };
    const outcome = await resolveApproval(bareStore, admin(), 'ws-acme', 'approval-1', 'approved');
    expect(outcome.ok).toBe(false);
  });

  it('a resume handler that throws is surfaced as a failure, and the decision was still recorded', async () => {
    class FailingStore extends FakeApprovalStore {
      async updateCampaignBudget(): Promise<void> {
        throw new Error('the underlying write failed');
      }
    }
    const store = new FailingStore();
    const id = await pendingBudgetApproval(store);
    const outcome = await resolveApproval(store, admin(), 'ws-acme', id, 'approved');
    expect(outcome.ok).toBe(false);
    const record = await store.getApprovalRequest('ws-acme', id);
    expect(record?.status).toBe('approved');
  });
});
