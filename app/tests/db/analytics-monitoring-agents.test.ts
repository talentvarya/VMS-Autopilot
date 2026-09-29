import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAgent, type Principal } from '@/lib/agents/orchestrator';
import type { AgentDefinition } from '@/lib/agents/types';
import { MonitoringFixtureStore, readRow } from './monitoring-fixtures';
import { ID, asOwner, asService, asUser, createDb, rows, seedFixture, useRollbackPerTest, type Db } from './harness';

/**
 * The end-to-end proof for Sub-phase D: the Monitoring/Auto-Repair Agent's checks call the
 * REAL, unmodified failStaleRuns() (Phase 2) and failStalePublishing() (Phase 3) against
 * genuinely-stuck real Postgres rows, resume_failed_post stops at exactly "approved", and
 * Sub-phase B's long-unresolved request_analytics handoff finally resolves now that the
 * Analytics Agent exists.
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

const admin = (): Principal => ({ id: ID.agencyAdmin, role: 'admin', grants: [] });

function definitions(): AgentDefinition[] {
  const base = { workspaceId: ID.acme, description: null, model: 'sandbox', systemPrompt: '', enabled: true };
  return [
    { id: 'def-monitoring', agentKey: 'monitoring_auto_repair_agent', displayName: 'Monitoring/Auto-Repair Agent', allowedTools: ['check_website_availability', 'check_stale_audits', 'check_stale_social_publishing', 'requeue_failed_audit', 'resume_failed_post'], ...base },
    { id: 'def-analytics', agentKey: 'analytics_reporting_agent', displayName: 'Analytics/Reporting Agent', allowedTools: ['summarize_seo_performance', 'summarize_social_activity', 'summarize_content_pipeline', 'summarize_agent_activity', 'compile_report'], ...base },
    { id: 'def-social', agentKey: 'social_media_super_agent', displayName: 'Social Media Super Agent', allowedTools: ['draft_post'], ...base },
  ];
}

function makeStore() {
  return new MonitoringFixtureStore(definitions(), db);
}

async function makeSite() {
  const [{ id }] = await asOwner(db, () => rows<{ id: string }>(db, `insert into public.sites (workspace_id, origin, label) values ($1, 'https://nova-clinic.example.test', 'Nova Clinic site') returning id`, [ID.nova]));
  return id;
}

/** A real audit_runs row stuck in "running" for over an hour - exactly what failStaleRuns() looks for. */
async function makeStuckAuditRun(siteId: string) {
  const [{ id }] = await asUser(db, ID.agencyAdmin, () => rows<{ id: string }>(db, `insert into public.audit_runs (workspace_id, site_id) values ($1, $2) returning id`, [ID.nova, siteId]));
  await asService(db, () => db.query(`update public.audit_runs set status = 'running' where id = $1`, [id]));
  await asOwner(db, () => db.exec(`alter table public.audit_runs disable trigger audit_runs_before`));
  await asOwner(db, () => db.query(`update public.audit_runs set started_at = now() - interval '1 hour' where id = $1`, [id]));
  await asOwner(db, () => db.exec(`alter table public.audit_runs enable trigger audit_runs_before`));
  return id;
}

/** A real social_posts row stuck in "publishing" for over an hour - exactly what failStalePublishing() looks for. */
async function makeStuckPublishingPost() {
  const [{ id: connectionId }] = await asService(db, () => rows<{ id: string }>(db, `insert into public.social_connections (workspace_id, plan_tier, plan_name, channel_limit) values ($1, 'free', 'Free (test)', 3) returning id`, [ID.nova]));
  const [{ id: channelId }] = await asService(db, () => rows<{ id: string }>(db, `insert into public.social_channels (connection_id, workspace_id, network, external_id, display_name) values ($1, $2, 'facebook', 'ext-fb', 'Nova FB') returning id`, [connectionId, ID.nova]));
  const [{ id: postId }] = await asUser(db, ID.agencyAdmin, () => rows<{ id: string }>(db, `insert into public.social_posts (workspace_id, channel_id, body) values ($1, $2, 'Our weekend hours have changed.') returning id`, [ID.nova, channelId]));
  await asUser(db, ID.agencyAdmin, () => db.query(`update public.social_posts set status = 'in_review' where id = $1`, [postId]));
  await asUser(db, ID.agencyAdmin, () => db.query(`update public.social_posts set status = 'approved' where id = $1`, [postId]));
  await asUser(db, ID.agencyAdmin, () => db.query(`update public.social_posts set status = 'publishing' where id = $1`, [postId]));
  await asOwner(db, () => db.exec(`alter table public.social_posts disable trigger social_posts_before`));
  await asOwner(db, () => db.query(`update public.social_posts set updated_at = now() - interval '1 hour' where id = $1`, [postId]));
  await asOwner(db, () => db.exec(`alter table public.social_posts enable trigger social_posts_before`));
  return postId;
}

describe('check_stale_audits calls the REAL, unmodified Phase 2 failStaleRuns()', () => {
  it('a genuinely-stuck run is failed; a health_checks row and a health_incidents row are written', async () => {
    const store = makeStore();
    const siteId = await makeSite();
    const stuckId = await makeStuckAuditRun(siteId);
    const result = await runAgent(store, admin(), { workspaceId: ID.nova, agentKey: 'monitoring_auto_repair_agent', triggeredByKind: 'user', input: { task: 'check_stale_audits', workspaceId: ID.nova } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('succeeded');
    expect(result.run.toolCalls[0].toolOutput).toEqual({ failedCount: 1 });

    const [run] = await readRow<any>(db, `select status::text, error from public.audit_runs where id = $1`, [stuckId]);
    expect(run.status).toBe('failed');
    expect(run.error).toBe('The audit took too long and was stopped.');

    const [check] = await readRow<any>(db, `select status::text from public.health_checks where workspace_id = $1 and check_type = 'stale_audits'`, [ID.nova]);
    expect(check.status).toBe('fail');
    const incidents = await readRow(db, `select id from public.health_incidents where workspace_id = $1 and check_type = 'stale_audits'`, [ID.nova]);
    expect(incidents.length).toBeGreaterThan(0);
  });

  it('nothing stale: a "pass" health_checks row, no incident', async () => {
    const store = makeStore();
    const result = await runAgent(store, admin(), { workspaceId: ID.nova, agentKey: 'monitoring_auto_repair_agent', triggeredByKind: 'user', input: { task: 'check_stale_audits', workspaceId: ID.nova } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.toolCalls[0].toolOutput).toEqual({ failedCount: 0 });
    const [check] = await readRow<any>(db, `select status::text from public.health_checks where workspace_id = $1 and check_type = 'stale_audits'`, [ID.nova]);
    expect(check.status).toBe('pass');
    expect(await readRow(db, `select id from public.health_incidents where workspace_id = $1 and check_type = 'stale_audits'`, [ID.nova])).toHaveLength(0);
  });
});

describe('check_stale_social_publishing calls the REAL, unmodified Phase 3 failStalePublishing()', () => {
  it('a genuinely-stuck post is failed with the real error message, never forced to "published"', async () => {
    const store = makeStore();
    const postId = await makeStuckPublishingPost();
    const result = await runAgent(store, admin(), { workspaceId: ID.nova, agentKey: 'monitoring_auto_repair_agent', triggeredByKind: 'user', input: { task: 'check_stale_social_publishing', workspaceId: ID.nova } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.toolCalls[0].toolOutput).toEqual({ failedCount: 1 });
    const [post] = await readRow<any>(db, `select status::text, last_error from public.social_posts where id = $1`, [postId]);
    expect(post.status).toBe('failed');
    expect(post.last_error).toContain('could not confirm');
  });
});

describe('resume_failed_post stops at exactly "approved" - never any further', () => {
  it('an Admin resumes a real failed post back to approved', async () => {
    const store = makeStore();
    const postId = await makeStuckPublishingPost();
    await asService(db, () => db.query(`update public.social_posts set status = 'failed', last_error = 'x' where id = $1`, [postId]));
    const result = await runAgent(store, admin(), { workspaceId: ID.nova, agentKey: 'monitoring_auto_repair_agent', triggeredByKind: 'user', input: { task: 'resume_failed_post', workspaceId: ID.nova, postId } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('succeeded');
    const [post] = await readRow<any>(db, `select status::text from public.social_posts where id = $1`, [postId]);
    expect(post.status).toBe('approved');
  });
});

describe('the request_analytics handoff (Sub-phase B) finally resolves, now that the Analytics Agent exists', () => {
  it('resolves automatically, with no task field needed in the handoff payload', async () => {
    const store = makeStore();
    const result = await runAgent(store, admin(), {
      workspaceId: ID.nova, agentKey: 'social_media_super_agent', triggeredByKind: 'user',
      input: { task: 'request_analytics', metric: 'engagement_rate', dateRange: 'last_30_days', channelIds: ['chan-1'] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.resolvedHandoffs).toHaveLength(1);
    const handoff = result.run.resolvedHandoffs[0];
    expect(handoff.toAgentKey).toBe('analytics_reporting_agent');
    expect(handoff.resolved).toBe(true);
    expect(handoff.run?.status).toBe('succeeded');
    expect(handoff.run?.toolCalls[0].toolName).toBe('summarize_social_activity');
  });
});
