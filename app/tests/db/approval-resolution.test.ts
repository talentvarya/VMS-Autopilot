import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveApproval } from '@/lib/agents/approvals';
import { runAgent, type Principal } from '@/lib/agents/orchestrator';
import type { AgentDefinition } from '@/lib/agents/types';
import type { Grant } from '@/lib/permissions';
import { AdsLeadsFixtureStore } from './ads-leads-fixtures';
import { ID, asOwner, asUser, createDb, rows, seedFixture, useRollbackPerTest, type Db } from './harness';

/**
 * Phase F.1: the general approval-resolution and resume-execution mechanism, proven end to
 * end against REAL Postgres rows - a real approval_requests row created by runAgent(), read
 * back and decided by resolveApproval(), with the underlying paid_ads budget change actually
 * applied for real once (and only once) an Admin approves it. Nothing here launches an ad or
 * spends anything - update_campaign_budget only ever writes a stored number.
 */

let db: Db;
beforeAll(async () => {
  db = await createDb();
  await seedFixture(db);
});
afterAll(async () => {
  await db.close();
});
useRollbackPerTest(() => db);

const asAdmin = <T,>(fn: () => Promise<T>) => asUser(db, ID.agencyAdmin, fn);
const asTeam = <T,>(fn: () => Promise<T>) => asUser(db, ID.teamMember, fn);
const admin = (): Principal => ({ id: ID.agencyAdmin, role: 'admin', grants: [] });
/**
 * runAgent()'s decide() reads `principal.grants` directly - it never queries the database - so
 * a DB-level test must pass the SAME grants here that it also inserted into permission_grants
 * (the DB insert is what lets the real RLS/triggers independently re-confirm the same
 * decision; this array is what lets the Orchestrator's own decide() reach it in the first place).
 */
const teamMember = (grants: Grant[] = []): Principal => ({ id: ID.teamMember, role: 'team_member', grants });
const PAID_ADS_TEAM_GRANTS: Grant[] = [
  { module: 'paid_ads', action: 'create' },
  { module: 'paid_ads', action: 'view' },
  { module: 'paid_ads', action: 'publish_execute' },
];

const grant = (workspaceId: string, module: string, action: string, userId: string) =>
  asAdmin(() => db.query(`insert into public.permission_grants (workspace_id, user_id, module, action) values ($1, $2, $3::public.permission_module, $4::public.permission_action)`, [workspaceId, userId, module, action]));

function definitions(): AgentDefinition[] {
  return [
    { id: 'def-paid-ads', workspaceId: ID.acme, agentKey: 'paid_ads_agent', displayName: 'Paid Ads Agent', description: null, model: 'sandbox', systemPrompt: '', allowedTools: ['draft_campaign', 'submit_campaign_for_review', 'update_campaign_budget', 'launch_campaign'], enabled: true },
  ];
}
const makeStore = () => new AdsLeadsFixtureStore(definitions(), db);

async function draftCampaignAsTeam(store: AdsLeadsFixtureStore) {
  const result = await runAgent(store, teamMember(PAID_ADS_TEAM_GRANTS), {
    workspaceId: ID.nova, agentKey: 'paid_ads_agent', triggeredByKind: 'user',
    input: { task: 'draft_campaign', workspaceId: ID.nova, platform: 'meta', objective: 'awareness', name: 'Campaign' },
  });
  if (!result.ok || result.run.status !== 'succeeded') throw new Error('setup: draft_campaign did not succeed');
  return (result.run.toolCalls[0].toolOutput as { campaignId: string }).campaignId;
}

describe('a needs_approval budget change resumes for real once an Admin approves it', () => {
  it('the budget is untouched while pending, then applied once approved', async () => {
    await grant(ID.nova, 'paid_ads', 'create', ID.teamMember);
    await grant(ID.nova, 'paid_ads', 'view', ID.teamMember);
    await grant(ID.nova, 'paid_ads', 'publish_execute', ID.teamMember);
    const store = makeStore();
    const campaignId = await draftCampaignAsTeam(store);

    const proposal = await runAgent(store, teamMember(PAID_ADS_TEAM_GRANTS), {
      workspaceId: ID.nova, agentKey: 'paid_ads_agent', triggeredByKind: 'user',
      input: { task: 'update_campaign_budget', workspaceId: ID.nova, campaignId, budgetAmount: 500, budgetPeriod: 'daily' },
    });
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.run.status).toBe('needs_approval');
    const approvalId = proposal.run.toolCalls[0].approvalId;
    expect(approvalId).toBeTruthy();

    const [beforeRow] = await asOwner(db, () => rows<any>(db, `select budget_amount from public.ad_campaigns where id = $1`, [campaignId]));
    expect(beforeRow.budget_amount).toBeNull();

    const outcome = await resolveApproval(store, admin(), ID.nova, approvalId!, 'approved');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.applied).toBe(true);

    const [afterRow] = await asOwner(db, () => rows<any>(db, `select budget_amount, budget_period from public.ad_campaigns where id = $1`, [campaignId]));
    expect(Number(afterRow.budget_amount)).toBe(500);
    expect(afterRow.budget_period).toBe('daily');
  });

  it('rejecting leaves the budget untouched, and the DB row records the rejection', async () => {
    await grant(ID.nova, 'paid_ads', 'create', ID.teamMember);
    await grant(ID.nova, 'paid_ads', 'view', ID.teamMember);
    await grant(ID.nova, 'paid_ads', 'publish_execute', ID.teamMember);
    const store = makeStore();
    const campaignId = await draftCampaignAsTeam(store);

    const proposal = await runAgent(store, teamMember(PAID_ADS_TEAM_GRANTS), {
      workspaceId: ID.nova, agentKey: 'paid_ads_agent', triggeredByKind: 'user',
      input: { task: 'update_campaign_budget', workspaceId: ID.nova, campaignId, budgetAmount: 500, budgetPeriod: 'daily' },
    });
    if (!proposal.ok) throw new Error('setup failed');
    const approvalId = proposal.run.toolCalls[0].approvalId!;

    const outcome = await resolveApproval(store, admin(), ID.nova, approvalId, 'rejected', 'budget too high for now');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.applied).toBe(false);

    const [row] = await asOwner(db, () => rows<any>(db, `select status::text from public.approval_requests where id = $1`, [approvalId]));
    expect(row.status).toBe('rejected');
    const [campaign] = await asOwner(db, () => rows<any>(db, `select budget_amount from public.ad_campaigns where id = $1`, [campaignId]));
    expect(campaign.budget_amount).toBeNull();
  });

  it('the real database trigger independently refuses a non-admin decision, even bypassing resolveApproval entirely', async () => {
    await grant(ID.nova, 'paid_ads', 'create', ID.teamMember);
    await grant(ID.nova, 'paid_ads', 'view', ID.teamMember);
    await grant(ID.nova, 'paid_ads', 'publish_execute', ID.teamMember);
    const store = makeStore();
    const campaignId = await draftCampaignAsTeam(store);
    const proposal = await runAgent(store, teamMember(PAID_ADS_TEAM_GRANTS), {
      workspaceId: ID.nova, agentKey: 'paid_ads_agent', triggeredByKind: 'user',
      input: { task: 'update_campaign_budget', workspaceId: ID.nova, campaignId, budgetAmount: 500, budgetPeriod: 'daily' },
    });
    if (!proposal.ok) throw new Error('setup failed');
    const approvalId = proposal.run.toolCalls[0].approvalId!;

    await expect(asTeam(() => db.query(`update public.approval_requests set status = 'approved' where id = $1`, [approvalId]))).rejects.toThrow(/only an Admin can approve or reject/);
  });

  it('an already-decided request cannot be decided again, at the resolveApproval layer', async () => {
    await grant(ID.nova, 'paid_ads', 'create', ID.teamMember);
    await grant(ID.nova, 'paid_ads', 'view', ID.teamMember);
    await grant(ID.nova, 'paid_ads', 'publish_execute', ID.teamMember);
    const store = makeStore();
    const campaignId = await draftCampaignAsTeam(store);
    const proposal = await runAgent(store, teamMember(PAID_ADS_TEAM_GRANTS), {
      workspaceId: ID.nova, agentKey: 'paid_ads_agent', triggeredByKind: 'user',
      input: { task: 'update_campaign_budget', workspaceId: ID.nova, campaignId, budgetAmount: 500, budgetPeriod: 'daily' },
    });
    if (!proposal.ok) throw new Error('setup failed');
    const approvalId = proposal.run.toolCalls[0].approvalId!;

    await resolveApproval(store, admin(), ID.nova, approvalId, 'approved');
    const second = await resolveApproval(store, admin(), ID.nova, approvalId, 'rejected');
    expect(second.ok).toBe(false);
  });

  it('approving a tool with no registered resume handler (launch_campaign) records the decision but launches nothing', async () => {
    await grant(ID.nova, 'paid_ads', 'create', ID.teamMember);
    await grant(ID.nova, 'paid_ads', 'view', ID.teamMember);
    await grant(ID.nova, 'paid_ads', 'publish_execute', ID.teamMember);
    const store = makeStore();
    const campaignId = await draftCampaignAsTeam(store);

    const proposal = await runAgent(store, teamMember(PAID_ADS_TEAM_GRANTS), {
      workspaceId: ID.nova, agentKey: 'paid_ads_agent', triggeredByKind: 'user',
      input: { task: 'launch_campaign', workspaceId: ID.nova, campaignId },
    });
    if (!proposal.ok) throw new Error('setup failed');
    expect(proposal.run.status).toBe('needs_approval');
    const approvalId = proposal.run.toolCalls[0].approvalId!;

    const outcome = await resolveApproval(store, admin(), ID.nova, approvalId, 'approved');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.applied).toBe(false);

    const [campaign] = await asOwner(db, () => rows<any>(db, `select status::text from public.ad_campaigns where id = $1`, [campaignId]));
    expect(campaign.status).toBe('draft');
  });
});
