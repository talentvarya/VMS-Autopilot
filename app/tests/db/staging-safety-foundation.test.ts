import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ID, asOwner, asService, asUser, createDb, rows, seedFixture, useRollbackPerTest, type Db } from './harness';

/**
 * Phase F.1: hard AI usage/cost caps and Paid Ads monthly budget-cap enforcement, proven
 * against real Postgres rows. No real AI provider or ad account is involved anywhere - AI
 * usage rows here are exactly what a mock provider's "this call would have cost X" bookkeeping
 * would insert, and ad_campaigns.budget_amount is (as every earlier sub-phase already
 * established) a stored number, never a real spend.
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

const insertUsage = (workspaceId: string, costUsd: number) =>
  asService(db, () =>
    db.query(
      `insert into public.ai_usage_log (workspace_id, provider, model, input_tokens, output_tokens, estimated_cost_usd) values ($1, 'anthropic', 'claude-sandbox-mock', 100, 50, $2)`,
      [workspaceId, costUsd],
    ),
  );

describe('ai_usage_log - a NULL cap means unlimited, matching ad_spend_monthly_cap\'s own convention', () => {
  it('several inserts succeed with no cap columns set', async () => {
    await insertUsage(ID.nova, 1.5);
    await insertUsage(ID.nova, 2.5);
    await insertUsage(ID.nova, 3.5);
    const [{ count }] = await asOwner(db, () => rows<{ count: string }>(db, `select count(*)::text as count from public.ai_usage_log where workspace_id = $1`, [ID.nova]));
    expect(Number(count)).toBe(3);
  });
});

describe('ai_usage_log - hard daily call cap', () => {
  it('refuses the insert once the daily cap is reached, not merely warns', async () => {
    await asAdmin(() => db.query(`update public.workspace_settings set ai_daily_call_cap = 2 where workspace_id = $1`, [ID.nova]));
    await insertUsage(ID.nova, 0.1);
    await insertUsage(ID.nova, 0.1);
    await expect(insertUsage(ID.nova, 0.1)).rejects.toThrow(/daily AI usage cap/);
    const [{ count }] = await asOwner(db, () => rows<{ count: string }>(db, `select count(*)::text as count from public.ai_usage_log where workspace_id = $1`, [ID.nova]));
    expect(Number(count)).toBe(2);
  });

  it('a cap on one workspace never affects another', async () => {
    await asAdmin(() => db.query(`update public.workspace_settings set ai_daily_call_cap = 1 where workspace_id = $1`, [ID.nova]));
    await insertUsage(ID.nova, 0.1);
    await expect(insertUsage(ID.nova, 0.1)).rejects.toThrow(/daily AI usage cap/);
    await insertUsage(ID.bright, 0.1);
    await insertUsage(ID.bright, 0.1);
    const [{ count }] = await asOwner(db, () => rows<{ count: string }>(db, `select count(*)::text as count from public.ai_usage_log where workspace_id = $1`, [ID.bright]));
    expect(Number(count)).toBe(2);
  });
});

describe('ai_usage_log - hard monthly cost cap', () => {
  it('refuses an insert that would push the monthly total over the cap', async () => {
    await asAdmin(() => db.query(`update public.workspace_settings set ai_monthly_cost_cap_usd = 10.00 where workspace_id = $1`, [ID.nova]));
    await insertUsage(ID.nova, 4);
    await insertUsage(ID.nova, 4);
    await expect(insertUsage(ID.nova, 3)).rejects.toThrow(/monthly AI cost cap/);
    const [{ total }] = await asOwner(db, () => rows<{ total: string }>(db, `select coalesce(sum(estimated_cost_usd), 0)::text as total from public.ai_usage_log where workspace_id = $1`, [ID.nova]));
    expect(Number(total)).toBe(8);
  });

  it('an insert landing exactly on the cap is allowed, one cent over is not', async () => {
    await asAdmin(() => db.query(`update public.workspace_settings set ai_monthly_cost_cap_usd = 10.00 where workspace_id = $1`, [ID.nova]));
    await insertUsage(ID.nova, 10);
    await expect(insertUsage(ID.nova, 0.01)).rejects.toThrow(/monthly AI cost cap/);
  });
});

describe('ai_usage_log - Admin-only visibility, no insert/update/delete for anyone but the server', () => {
  it('an Admin sees usage rows, a Team member and a Client see none (RLS filters silently)', async () => {
    await insertUsage(ID.nova, 1);
    const asAdminRows = await asAdmin(() => rows<any>(db, `select id from public.ai_usage_log where workspace_id = $1`, [ID.nova]));
    expect(asAdminRows.length).toBe(1);
    const asTeamRows = await asTeam(() => rows<any>(db, `select id from public.ai_usage_log where workspace_id = $1`, [ID.nova]));
    expect(asTeamRows.length).toBe(0);
    const asClientRows = await asClient(() => rows<any>(db, `select id from public.ai_usage_log where workspace_id = $1`, [ID.nova]));
    expect(asClientRows.length).toBe(0);
  });

  it('a logged-in Admin cannot insert a usage row directly - only the service role can', async () => {
    await expect(asAdmin(() => db.query(`insert into public.ai_usage_log (workspace_id, provider, model, input_tokens, output_tokens, estimated_cost_usd) values ($1, 'anthropic', 'x', 1, 1, 0.01)`, [ID.nova]))).rejects.toThrow();
  });
});

describe('ad_campaigns - the monthly budget cap (workspace_settings.ad_spend_monthly_cap) is now enforced', () => {
  it('a NULL cap means unlimited, matching every other cap column\'s own convention', async () => {
    await asAdmin(() => db.query(`insert into public.ad_campaigns (workspace_id, platform, objective, name, budget_amount, budget_period) values ($1, 'meta', 'awareness', 'A', 50000, 'daily')`, [ID.nova]));
  });

  it('refuses a NEW campaign whose budget would push the workspace over its cap', async () => {
    await asAdmin(() => db.query(`update public.workspace_settings set ad_spend_monthly_cap = 1000 where workspace_id = $1`, [ID.nova]));
    await asAdmin(() => db.query(`insert into public.ad_campaigns (workspace_id, platform, objective, name, budget_amount, budget_period) values ($1, 'meta', 'awareness', 'A', 600, 'daily')`, [ID.nova]));
    await expect(
      asAdmin(() => db.query(`insert into public.ad_campaigns (workspace_id, platform, objective, name, budget_amount, budget_period) values ($1, 'meta', 'awareness', 'B', 500, 'daily')`, [ID.nova])),
    ).rejects.toThrow(/monthly ad-spend cap/);
  });

  it('refuses a BUDGET UPDATE that would push the workspace over its cap; a smaller update still succeeds', async () => {
    await asAdmin(() => db.query(`update public.workspace_settings set ad_spend_monthly_cap = 1000 where workspace_id = $1`, [ID.nova]));
    const [{ id }] = await asAdmin(() => rows<{ id: string }>(db, `insert into public.ad_campaigns (workspace_id, platform, objective, name, budget_amount, budget_period) values ($1, 'meta', 'awareness', 'A', 200, 'daily') returning id`, [ID.nova]));
    await asAdmin(() => db.query(`update public.ad_campaigns set budget_amount = 300 where id = $1`, [id]));
    await expect(asAdmin(() => db.query(`update public.ad_campaigns set budget_amount = 1500 where id = $1`, [id]))).rejects.toThrow(/monthly ad-spend cap/);
    const [row] = await asOwner(db, () => rows<any>(db, `select budget_amount from public.ad_campaigns where id = $1`, [id]));
    expect(Number(row.budget_amount)).toBe(300);
  });

  it('a cancelled campaign\'s budget is excluded from the cap sum', async () => {
    await asAdmin(() => db.query(`update public.workspace_settings set ad_spend_monthly_cap = 1000 where workspace_id = $1`, [ID.nova]));
    const [{ id: cancelledId }] = await asAdmin(() => rows<{ id: string }>(db, `insert into public.ad_campaigns (workspace_id, platform, objective, name, budget_amount, budget_period) values ($1, 'meta', 'awareness', 'A', 900, 'daily') returning id`, [ID.nova]));
    await asAdmin(() => db.query(`update public.ad_campaigns set status = 'cancelled' where id = $1`, [cancelledId]));
    // Without excluding the cancelled campaign this would total 1850 and be refused.
    await asAdmin(() => db.query(`insert into public.ad_campaigns (workspace_id, platform, objective, name, budget_amount, budget_period) values ($1, 'meta', 'awareness', 'B', 950, 'daily')`, [ID.nova]));
  });

  it('a cap on one workspace never affects another', async () => {
    await asAdmin(() => db.query(`update public.workspace_settings set ad_spend_monthly_cap = 100 where workspace_id = $1`, [ID.nova]));
    await asAdmin(() => db.query(`insert into public.ad_campaigns (workspace_id, platform, objective, name, budget_amount, budget_period) values ($1, 'meta', 'awareness', 'Big', 50000, 'daily')`, [ID.bright]));
  });

  it('the existing Sub-phase E permission trigger still runs first - an unauthorized budget change is refused before the cap is ever consulted', async () => {
    await asAdmin(() => db.query(`update public.workspace_settings set ad_spend_monthly_cap = 1000000 where workspace_id = $1`, [ID.nova]));
    await asAdmin(() =>
      db.query(`insert into public.permission_grants (workspace_id, user_id, module, action) values ($1, $2, 'paid_ads', 'create')`, [ID.nova, ID.teamMember]),
    );
    await asAdmin(() =>
      db.query(`insert into public.permission_grants (workspace_id, user_id, module, action) values ($1, $2, 'paid_ads', 'view')`, [ID.nova, ID.teamMember]),
    );
    const [{ id }] = await asTeam(() =>
      rows<{ id: string }>(db, `insert into public.ad_campaigns (workspace_id, platform, objective, name) values ($1, 'meta', 'awareness', 'Campaign') returning id`, [ID.nova]),
    );
    // Team member has no publish_execute grant - well under the (huge) cap, but still refused.
    await expect(asTeam(() => db.query(`update public.ad_campaigns set budget_amount = 1 where id = $1`, [id]))).rejects.toThrow(/needs an Admin/);
  });
});
