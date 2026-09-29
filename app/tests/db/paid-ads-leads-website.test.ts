import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAgent, type Principal } from '@/lib/agents/orchestrator';
import type { AgentDefinition } from '@/lib/agents/types';
import { AdsLeadsFixtureStore } from './ads-leads-fixtures';
import { ID, asOwner, asService, asUser, createDb, rows, seedFixture, useRollbackPerTest, type Db } from './harness';

/**
 * The end-to-end proof for Sub-phase E: real Postgres rows for all four new agents, the
 * lighter (but versioned, auditable, locked-once-final) ad_audience_briefs model, the full
 * approval rigor on ad_campaigns and website_projects, leads_crm's genuinely lighter-touch
 * permission shape, the Ads Audience -> Paid Ads handoff chain, and the revived
 * propose_lead_handoff (Sub-phase B) - including its valid/invalid/partial/cross-workspace
 * cases.
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
const asClient = <T,>(fn: () => Promise<T>) => asUser(db, ID.clientNova, fn);
const asTeam = <T,>(fn: () => Promise<T>) => asUser(db, ID.teamMember, fn);
const admin = (): Principal => ({ id: ID.agencyAdmin, role: 'admin', grants: [] });

const grant = (workspaceId: string, module: string, action: string, userId: string) =>
  asAdmin(() => db.query(`insert into public.permission_grants (workspace_id, user_id, module, action) values ($1, $2, $3::public.permission_module, $4::public.permission_action)`, [workspaceId, userId, module, action]));

function definitions(): AgentDefinition[] {
  const base = { workspaceId: ID.acme, description: null, model: 'sandbox', systemPrompt: '', enabled: true };
  return [
    { id: 'def-ads-audience', agentKey: 'ads_audience_agent', displayName: 'Paid Ads Audience & Targeting Agent', allowedTools: ['intake_business_profile', 'research_audience_signals', 'create_audience_hypotheses', 'finalize_audience_brief'], ...base },
    { id: 'def-paid-ads', agentKey: 'paid_ads_agent', displayName: 'Paid Ads Agent', allowedTools: ['draft_campaign', 'submit_campaign_for_review', 'update_campaign_budget', 'launch_campaign'], ...base },
    { id: 'def-leads', agentKey: 'lead_crm_agent', displayName: 'Lead/CRM Agent', allowedTools: ['capture_lead', 'qualify_lead', 'draft_follow_up'], ...base },
    { id: 'def-website', agentKey: 'website_domain_agent', displayName: 'Website/Domain Agent', allowedTools: ['draft_website_plan', 'submit_website_plan_for_review', 'research_domain_names', 'check_domain_availability', 'propose_domain_connection'], ...base },
    { id: 'def-social', agentKey: 'social_media_super_agent', displayName: 'Social Media Super Agent', allowedTools: ['draft_post'], ...base },
  ];
}
const makeStore = () => new AdsLeadsFixtureStore(definitions(), db);

const businessProfile = { name: 'Acme Gym', industry: 'gyms', product: 'monthly membership' };

async function makeChannelAndInteraction(body = 'Do you have a free trial?') {
  const [{ id: connectionId }] = await asService(db, () => rows<{ id: string }>(db, `insert into public.social_connections (workspace_id, plan_tier, plan_name, channel_limit) values ($1, 'free', 'Free (test)', 3) returning id`, [ID.nova]));
  const [{ id: channelId }] = await asService(db, () => rows<{ id: string }>(db, `insert into public.social_channels (connection_id, workspace_id, network, external_id, display_name) values ($1, $2, 'facebook', 'ext-fb', 'Nova FB') returning id`, [connectionId, ID.nova]));
  const [{ id: interactionId }] = await asService(db, () => rows<{ id: string }>(db, `insert into public.social_interactions (workspace_id, channel_id, kind, external_interaction_id, body_raw) values ($1, $2, 'comment', 'ext-1', $3) returning id`, [ID.nova, channelId, body]));
  return interactionId;
}

describe('ad_audience_briefs - the lighter model: versioned, auditable, locked once final', () => {
  it('drafting increments version, and finalizing locks it', async () => {
    const [{ id }] = await asAdmin(() =>
      rows<{ id: string }>(db, `insert into public.ad_audience_briefs (workspace_id, business_profile) values ($1, $2) returning id`, [ID.nova, JSON.stringify(businessProfile)]),
    );
    let row = (await asOwner(db, () => rows<any>(db, `select version, status::text from public.ad_audience_briefs where id = $1`, [id])))[0];
    expect(row.version).toBe(1);
    await asAdmin(() => db.query(`update public.ad_audience_briefs set recommended_offer = 'x' where id = $1`, [id]));
    row = (await asOwner(db, () => rows<any>(db, `select version from public.ad_audience_briefs where id = $1`, [id])))[0];
    expect(row.version).toBe(2);

    await asAdmin(() => db.query(`update public.ad_audience_briefs set status = 'final' where id = $1`, [id]));
    row = (await asOwner(db, () => rows<any>(db, `select status::text, finalized_by, finalized_at from public.ad_audience_briefs where id = $1`, [id])))[0];
    expect(row.status).toBe('final');
    expect(row.finalized_by).toBe(ID.agencyAdmin);
    expect(row.finalized_at).not.toBeNull();

    await expect(asAdmin(() => db.query(`update public.ad_audience_briefs set recommended_offer = 'changed' where id = $1`, [id]))).rejects.toThrow(/finalized audience brief is locked/);
  });

  it('is fully auditable - draft creation, each edit and finalization all reach audit_log', async () => {
    const [{ id }] = await asAdmin(() => rows<{ id: string }>(db, `insert into public.ad_audience_briefs (workspace_id, business_profile) values ($1, $2) returning id`, [ID.nova, JSON.stringify(businessProfile)]));
    await asAdmin(() => db.query(`update public.ad_audience_briefs set recommended_offer = 'x' where id = $1`, [id]));
    await asAdmin(() => db.query(`update public.ad_audience_briefs set status = 'final' where id = $1`, [id]));
    const events = (await asOwner(db, () => rows<{ action: string }>(db, `select action from public.audit_log where workspace_id = $1 and module = 'paid_ads' and target_type = 'ad_audience_briefs' order by id`, [ID.nova]))).map((e) => e.action);
    expect(events).toEqual(['ads.brief_created', 'ads.brief_updated', 'ads.brief_finalized']);
  });

  it('a final brief never launches ads, changes budgets or touches a live campaign - it has no such column or trigger path at all', async () => {
    const [{ id }] = await asAdmin(() => rows<{ id: string }>(db, `insert into public.ad_audience_briefs (workspace_id, business_profile) values ($1, $2) returning id`, [ID.nova, JSON.stringify(businessProfile)]));
    await asAdmin(() => db.query(`update public.ad_audience_briefs set status = 'final' where id = $1`, [id]));
    const columns = (await asOwner(db, () => rows<{ column_name: string }>(db, `select column_name from information_schema.columns where table_name = 'ad_audience_briefs'`))).map((c) => c.column_name);
    expect(columns).not.toContain('budget_amount');
    expect(columns).not.toContain('status_launched');
  });
});

describe('ad_campaigns - full rigor, and "the final brief is the approved input for campaign planning only"', () => {
  it('may only reference a FINAL brief, never a draft one', async () => {
    const [{ id: draftBrief }] = await asAdmin(() => rows<{ id: string }>(db, `insert into public.ad_audience_briefs (workspace_id, business_profile) values ($1, $2) returning id`, [ID.nova, JSON.stringify(businessProfile)]));
    await expect(
      asAdmin(() => db.query(`insert into public.ad_campaigns (workspace_id, audience_brief_id, platform, objective, name) values ($1, $2, 'meta', 'awareness', 'Campaign')`, [ID.nova, draftBrief])),
    ).rejects.toThrow(/may only reference a FINAL audience brief/);

    await asAdmin(() => db.query(`update public.ad_audience_briefs set status = 'final' where id = $1`, [draftBrief]));
    await expect(
      asAdmin(() => db.query(`insert into public.ad_campaigns (workspace_id, audience_brief_id, platform, objective, name) values ($1, $2, 'meta', 'awareness', 'Campaign')`, [ID.nova, draftBrief])),
    ).resolves.toBeTruthy();
  });

  it('a second person is required to approve (Admin excepted), and the hash freezes at approval', async () => {
    // paid_ads has no 'approve' in the Client ceiling at all (only Admin/Team member can ever
    // hold it), so this uses a Team member, exactly like the website_projects test below.
    await grant(ID.nova, 'paid_ads', 'create', ID.teamMember);
    await grant(ID.nova, 'paid_ads', 'view', ID.teamMember);
    const [{ id }] = await asTeam(() => rows<{ id: string }>(db, `insert into public.ad_campaigns (workspace_id, platform, objective, name) values ($1, 'meta', 'awareness', 'My campaign') returning id`, [ID.nova]));
    await asTeam(() => db.query(`update public.ad_campaigns set status = 'in_review' where id = $1`, [id]));
    await grant(ID.nova, 'paid_ads', 'approve', ID.teamMember);
    await expect(asTeam(() => db.query(`update public.ad_campaigns set status = 'approved' where id = $1`, [id]))).rejects.toThrow(/cannot approve one you wrote/);
    await asAdmin(() => db.query(`update public.ad_campaigns set status = 'approved' where id = $1`, [id]));
    const [row] = await asOwner(db, () => rows<any>(db, `select status::text, approved_hash from public.ad_campaigns where id = $1`, [id]));
    expect(row.status).toBe('approved');
    expect(row.approved_hash).not.toBeNull();
  });

  it('a budget change needs publish_execute specifically - edit alone is not enough', async () => {
    await grant(ID.nova, 'paid_ads', 'create', ID.teamMember);
    await grant(ID.nova, 'paid_ads', 'edit', ID.teamMember);
    await grant(ID.nova, 'paid_ads', 'view', ID.teamMember);
    const [{ id }] = await asTeam(() => rows<{ id: string }>(db, `insert into public.ad_campaigns (workspace_id, platform, objective, name) values ($1, 'meta', 'awareness', 'Campaign') returning id`, [ID.nova]));
    // The trigger actively raises rather than letting RLS silently match zero rows - proven
    // by rejecting, not by rowCount.
    await expect(asTeam(() => db.query(`update public.ad_campaigns set budget_amount = 100, budget_period = 'daily' where id = $1`, [id]))).rejects.toThrow(/needs an Admin/);
    // private.can_do() is false for any sensitive action performed by a non-admin, by design -
    // so even holding publish_execute does not let a Team member execute this directly; it only
    // makes them eligible for the application layer's approval flow (proven at the unit level in
    // paid-ads-agent.test.ts: "needs approval, the budget is NOT changed yet"). The actual write
    // happens under Admin authority once approved.
    await grant(ID.nova, 'paid_ads', 'publish_execute', ID.teamMember);
    await expect(asTeam(() => db.query(`update public.ad_campaigns set budget_amount = 100, budget_period = 'daily' where id = $1`, [id]))).rejects.toThrow(/needs an Admin/);
    await asAdmin(() => db.query(`update public.ad_campaigns set budget_amount = 100, budget_period = 'daily' where id = $1`, [id]));
    const [row] = await asOwner(db, () => rows<any>(db, `select budget_amount from public.ad_campaigns where id = $1`, [id]));
    expect(Number(row.budget_amount)).toBe(100);
  });

  it('there is no "active"/"launched" status in the enum at all', async () => {
    const values = (await rows<{ v: string }>(db, `select unnest(enum_range(null::public.ad_campaign_status))::text as v`)).map((r) => r.v);
    expect(values).toEqual(['draft', 'in_review', 'approved', 'cancelled']);
  });
});

describe('leads - the lightest-touch module: creating and qualifying are never sensitive', () => {
  it('an ungranted Client cannot capture a lead (leads_crm:create is never a default either)', async () => {
    await expect(asClient(() => db.query(`insert into public.leads (workspace_id, source) values ($1, 'form')`, [ID.nova]))).rejects.toThrow(/row-level security/);
  });

  it('a granted Client can capture and qualify a lead directly - never needs approval', async () => {
    await grant(ID.nova, 'leads_crm', 'create', ID.clientNova);
    await grant(ID.nova, 'leads_crm', 'edit', ID.clientNova);
    const [{ id }] = await asClient(() => rows<{ id: string }>(db, `insert into public.leads (workspace_id, source, name) values ($1, 'form', 'Jordan') returning id`, [ID.nova]));
    await asClient(() => db.query(`update public.leads set status = 'qualified' where id = $1`, [id]));
    const [row] = await asOwner(db, () => rows<any>(db, `select status::text from public.leads where id = $1`, [id]));
    expect(row.status).toBe('qualified');
  });

  it('preserves the source social interaction link, and refuses an interaction from another workspace', async () => {
    const interactionId = await makeChannelAndInteraction();
    const [{ id }] = await asAdmin(() => rows<{ id: string }>(db, `insert into public.leads (workspace_id, source, source_interaction_id) values ($1, 'social_dm', $2) returning id`, [ID.nova, interactionId]));
    const [row] = await asOwner(db, () => rows<any>(db, `select source_interaction_id from public.leads where id = $1`, [id]));
    expect(row.source_interaction_id).toBe(interactionId);

    await expect(
      asAdmin(() => db.query(`insert into public.leads (workspace_id, source, source_interaction_id) values ($1, 'social_dm', $2)`, [ID.bright, interactionId])),
    ).rejects.toThrow(/does not exist in this workspace/);
  });

  it('one interaction can only ever produce one lead (the unique index)', async () => {
    const interactionId = await makeChannelAndInteraction();
    await asAdmin(() => db.query(`insert into public.leads (workspace_id, source, source_interaction_id) values ($1, 'social_dm', $2)`, [ID.nova, interactionId]));
    await expect(asAdmin(() => db.query(`insert into public.leads (workspace_id, source, source_interaction_id) values ($1, 'social_dm', $2)`, [ID.nova, interactionId]))).rejects.toThrow();
  });
});

describe('website_projects - a Client can never draft one, however it is granted (view-only ceiling)', () => {
  it('refuses even a Client explicitly granted website:create', async () => {
    await expect(asClient(() => db.query(`insert into public.permission_grants (workspace_id, user_id, module, action) values ($1, $2, 'website', 'create')`, [ID.nova, ID.clientNova]))).rejects.toThrow();
    // The grant itself is refused by the ceiling check (can never be given) - confirm directly.
    await expect(
      asAdmin(() => db.query(`insert into public.permission_grants (workspace_id, user_id, module, action) values ($1, $2, 'website', 'create')`, [ID.nova, ID.clientNova])),
    ).rejects.toThrow(/can never be given/);
  });

  it('a Team member with a grant, or an Admin, can draft and approve one (second-approver rule still applies)', async () => {
    await grant(ID.nova, 'website', 'view', ID.teamMember);
    await grant(ID.nova, 'website', 'create', ID.teamMember);
    const [{ id }] = await asTeam(() =>
      rows<{ id: string }>(db, `insert into public.website_projects (workspace_id, provider, title, pages) values ($1, 'vercel', 'Acme Gym site', '[]') returning id`, [ID.nova]),
    );
    await asTeam(() => db.query(`update public.website_projects set status = 'in_review' where id = $1`, [id]));
    await grant(ID.nova, 'website', 'approve', ID.teamMember);
    await expect(asTeam(() => db.query(`update public.website_projects set status = 'approved' where id = $1`, [id]))).rejects.toThrow(/cannot approve one you wrote/);
    await asAdmin(() => db.query(`update public.website_projects set status = 'approved' where id = $1`, [id]));
    const [row] = await asOwner(db, () => rows<any>(db, `select status::text, approved_hash from public.website_projects where id = $1`, [id]));
    expect(row.status).toBe('approved');
    expect(row.approved_hash).not.toBeNull();
  });
});

describe('handoff: Paid Ads Audience & Targeting Agent -> Paid Ads Agent', () => {
  it('finalizing a brief with handoffToPaidAds resolves automatically into a real draft campaign', async () => {
    const store = makeStore();
    const result = await runAgent(store, admin(), {
      workspaceId: ID.nova, agentKey: 'ads_audience_agent', triggeredByKind: 'user',
      input: { task: 'finalize_audience_brief', workspaceId: ID.nova, businessProfile, handoffToPaidAds: true, campaignName: 'Acme Gym launch' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('succeeded');
    const briefId = (result.run.toolCalls[0].toolOutput as any).briefId;
    const [brief] = await asOwner(db, () => rows<any>(db, `select status::text from public.ad_audience_briefs where id = $1`, [briefId]));
    expect(brief.status).toBe('final');

    expect(result.run.resolvedHandoffs).toHaveLength(1);
    const handoff = result.run.resolvedHandoffs[0];
    expect(handoff.toAgentKey).toBe('paid_ads_agent');
    expect(handoff.resolved).toBe(true);
    expect(handoff.run?.status).toBe('succeeded');
    const campaignId = (handoff.run!.toolCalls[0].toolOutput as any).campaignId;
    const [campaign] = await asOwner(db, () => rows<any>(db, `select status::text, name from public.ad_campaigns where id = $1`, [campaignId]));
    expect(campaign.status).toBe('draft');
    expect(campaign.name).toBe('Acme Gym launch');
  });

  it('does NOT hand off unless explicitly requested', async () => {
    const store = makeStore();
    const result = await runAgent(store, admin(), {
      workspaceId: ID.nova, agentKey: 'ads_audience_agent', triggeredByKind: 'user',
      input: { task: 'finalize_audience_brief', workspaceId: ID.nova, businessProfile },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.handoffs).toHaveLength(0);
  });
});

describe('the revived propose_lead_handoff (Sub-phase B) - valid, invalid, partial and cross-workspace', () => {
  it('valid: resolves automatically into a real lead, linked back to the interaction', async () => {
    const store = makeStore();
    const interactionId = await makeChannelAndInteraction('Do you have beginner classes?');
    const result = await runAgent(store, admin(), {
      workspaceId: ID.nova, agentKey: 'social_media_super_agent', triggeredByKind: 'user',
      input: { task: 'propose_lead_handoff', interactionId, extractedContact: 'jordan@example.test', confidence: 0.9 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const handoff = result.run.resolvedHandoffs[0];
    expect(handoff.toAgentKey).toBe('lead_crm_agent');
    expect(handoff.resolved).toBe(true);
    expect(handoff.run?.status).toBe('succeeded');
    const leadId = (handoff.run!.toolCalls[0].toolOutput as any).leadId;
    const [lead] = await asOwner(db, () => rows<any>(db, `select source_interaction_id, contact from public.leads where id = $1`, [leadId]));
    expect(lead.source_interaction_id).toBe(interactionId);
    expect(lead.contact).toBe('jordan@example.test');
  });

  it('is idempotent: handing off the SAME interaction twice updates, never duplicates', async () => {
    const store = makeStore();
    const interactionId = await makeChannelAndInteraction();
    await runAgent(store, admin(), { workspaceId: ID.nova, agentKey: 'social_media_super_agent', triggeredByKind: 'user', input: { task: 'propose_lead_handoff', interactionId, extractedContact: 'first@example.test' } });
    await runAgent(store, admin(), { workspaceId: ID.nova, agentKey: 'social_media_super_agent', triggeredByKind: 'user', input: { task: 'propose_lead_handoff', interactionId, extractedContact: 'second@example.test' } });
    const leadsForInteraction = await asOwner(db, () => rows(db, `select id, contact from public.leads where source_interaction_id = $1`, [interactionId]));
    expect(leadsForInteraction).toHaveLength(1);
    expect((leadsForInteraction[0] as any).contact).toBe('second@example.test');
  });

  it('invalid: missing interactionId is rejected, no lead is created', async () => {
    const store = makeStore();
    const result = await runAgent(store, admin(), {
      workspaceId: ID.nova, agentKey: 'lead_crm_agent', triggeredByKind: 'agent',
      input: { extractedContact: 'x@example.test', workspaceId: ID.nova },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/interactionId/);
  });

  it('partial: a wrongly-typed optional field (confidence as a string) is rejected', async () => {
    const store = makeStore();
    const interactionId = await makeChannelAndInteraction();
    const result = await runAgent(store, admin(), {
      workspaceId: ID.nova, agentKey: 'lead_crm_agent', triggeredByKind: 'agent',
      input: { interactionId, confidence: 'high', workspaceId: ID.nova },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/"confidence"/);
  });

  it('cross-workspace: an interaction from a different workspace is refused, not silently linked', async () => {
    const store = makeStore();
    const interactionId = await makeChannelAndInteraction(); // belongs to ID.nova
    const result = await runAgent(store, admin(), {
      workspaceId: ID.bright, agentKey: 'lead_crm_agent', triggeredByKind: 'agent',
      input: { interactionId, workspaceId: ID.bright },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('failed');
    const applyError = result.run.toolCalls[0].applyError;
    expect(applyError).toMatch(/does not exist in this workspace/);
  });

  it('an unknown task name is rejected outright', async () => {
    const store = makeStore();
    const result = await runAgent(store, admin(), { workspaceId: ID.nova, agentKey: 'lead_crm_agent', triggeredByKind: 'user', input: { task: 'delete_everything', workspaceId: ID.nova } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/unknown Lead\/CRM Agent task/);
  });
});
