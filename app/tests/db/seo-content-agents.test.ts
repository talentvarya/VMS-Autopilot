import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAgent, type Principal } from '@/lib/agents/orchestrator';
import type { AgentDefinition } from '@/lib/agents/types';
import { SocialStore } from '@/lib/social/store';
import { SeoContentSocialFixtureStore, readRow } from './agent-fixtures';
import { ID, asOwner, createDb, rows, seedFixture, useRollbackPerTest, type Db } from './harness';

/**
 * The end-to-end proof for Sub-phase C: the SEO/GEO Agent and Content Agent operate on REAL
 * Postgres (PGlite) through the EXISTING, unmodified Phase 2 schema/engine and the NEW
 * content_drafts table, AND the Orchestrator's new handoff auto-resolution genuinely chains
 * SEO/GEO Agent -> Content Agent -> Social Media Super Agent - through the REAL orchestrator,
 * not a simulation of it - while leaving handoffs to not-yet-built agents unresolved.
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

const admin = (id = ID.agencyAdmin): Principal => ({ id, role: 'admin', grants: [] });
const client = (grants: Principal['grants'] = []): Principal => ({ id: ID.clientNova, role: 'client', grants });

async function makeSite(workspaceId = ID.nova) {
  const [{ id }] = await asOwner(db, () =>
    rows<{ id: string }>(db, `insert into public.sites (workspace_id, origin, label) values ($1, 'https://nova-clinic.example.test', 'Nova Clinic site') returning id`, [workspaceId]),
  );
  return id;
}

function definitions(): AgentDefinition[] {
  const base = { workspaceId: ID.acme, description: null, model: 'sandbox', systemPrompt: '', enabled: true };
  return [
    { id: 'def-seo', agentKey: 'seo_geo_agent', displayName: 'SEO/GEO Agent', allowedTools: ['queue_audit', 'explain_findings', 'propose_fix'], ...base },
    { id: 'def-content', agentKey: 'content_agent', displayName: 'Content Agent', allowedTools: ['draft_article', 'submit_article_for_review'], ...base },
    { id: 'def-social', agentKey: 'social_media_super_agent', displayName: 'Social Media Super Agent', allowedTools: ['draft_post', 'submit_post_for_review'], ...base },
  ];
}

/** A real finding id, from a real completed audit - content_drafts.source_finding_id is a
 * genuine foreign key, so a made-up id would correctly be refused. */
async function realFindingId(store: SeoContentSocialFixtureStore) {
  const siteId = await makeSite();
  const result = await runAgent(store, admin(), { workspaceId: ID.nova, agentKey: 'seo_geo_agent', triggeredByKind: 'user', input: { task: 'queue_audit', workspaceId: ID.nova, siteId } });
  if (!result.ok) throw new Error('setup failed');
  const runId = (result.run.toolCalls[0].toolOutput as any).runId;
  const [finding] = await readRow<{ id: string }>(db, `select id from public.audit_findings where run_id = $1 limit 1`, [runId]);
  return finding.id;
}

function makeStore() {
  const socialStore = new SocialStore({
    now: () => new Date('2026-10-05T12:00:00.000Z'),
    plan: { tier: 'free', name: 'Free (test)', channelLimit: 5 },
    channels: [{ id: 'chan-1', workspaceId: ID.nova, network: 'facebook', externalId: 'ext-fb', displayName: 'Nova FB', handle: 'nova', status: 'active' }],
  });
  return new SeoContentSocialFixtureStore(definitions(), db, socialStore);
}

describe('SEO/GEO Agent: queue_audit produces a REAL, scored audit through the unmodified Phase 2 engine', () => {
  it('as a Client (seo_geo:create is a default) - a real audit_runs row, completed, with real findings', async () => {
    const store = makeStore();
    const siteId = await makeSite();
    const result = await runAgent(store, client(), {
      workspaceId: ID.nova, agentKey: 'seo_geo_agent', triggeredByKind: 'user',
      input: { task: 'queue_audit', workspaceId: ID.nova, siteId },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('succeeded');
    const runId = (result.run.toolCalls[0].toolOutput as any).runId;
    const [run] = await readRow<any>(db, `select status::text, overall_score, engine_version from public.audit_runs where id = $1`, [runId]);
    expect(run.status).toBe('completed');
    expect(run.engine_version).toBeTruthy();
    const findings = await readRow(db, `select id from public.audit_findings where run_id = $1`, [runId]);
    expect(findings.length).toBeGreaterThan(0);
  });
});

describe('SEO/GEO Agent: propose_fix', () => {
  async function completedRunFinding() {
    const store = makeStore();
    const siteId = await makeSite();
    const result = await runAgent(store, admin(), { workspaceId: ID.nova, agentKey: 'seo_geo_agent', triggeredByKind: 'user', input: { task: 'queue_audit', workspaceId: ID.nova, siteId } });
    if (!result.ok) throw new Error('setup failed');
    const runId = (result.run.toolCalls[0].toolOutput as any).runId;
    const [finding] = await readRow<{ id: string }>(db, `select id from public.audit_findings where run_id = $1 limit 1`, [runId]);
    return { store, findingId: finding.id };
  }

  it('an Admin: fix is recorded directly, no approval needed', async () => {
    const { store, findingId } = await completedRunFinding();
    const result = await runAgent(store, admin(), { workspaceId: ID.nova, agentKey: 'seo_geo_agent', triggeredByKind: 'user', input: { task: 'propose_fix', workspaceId: ID.nova, findingId } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('succeeded');
    const [row] = await readRow<any>(db, `select fix_status::text, fixed_by from public.audit_findings where id = $1`, [findingId]);
    expect(row.fix_status).toBe('applied');
    expect(row.fixed_by).toBe(ID.agencyAdmin);
  });

  it('a Client granted seo_geo:publish_execute: needs approval, and the finding is NOT changed until then', async () => {
    const { store, findingId } = await completedRunFinding();
    const result = await runAgent(store, client([{ module: 'seo_geo', action: 'publish_execute' }]), { workspaceId: ID.nova, agentKey: 'seo_geo_agent', triggeredByKind: 'user', input: { task: 'propose_fix', workspaceId: ID.nova, findingId } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('needs_approval');
    const [row] = await readRow<any>(db, `select fix_status::text from public.audit_findings where id = $1`, [findingId]);
    expect(row.fix_status).toBe('open');
    expect(store.approvals).toHaveLength(1);
  });
});

describe('handoff auto-resolution: SEO/GEO Agent -> Content Agent', () => {
  it('resolves automatically into a real content_drafts row, linked back to the finding, still in "draft" status', async () => {
    const store = makeStore();
    const findingId = await realFindingId(store);
    const result = await runAgent(store, admin(), {
      workspaceId: ID.nova, agentKey: 'seo_geo_agent', triggeredByKind: 'user',
      input: { task: 'content_brief_handoff', workspaceId: ID.nova, findingId, title: 'Fix your missing meta descriptions', topic: 'why meta descriptions matter for click-through' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.resolvedHandoffs).toHaveLength(1);
    const handoff = result.run.resolvedHandoffs[0];
    expect(handoff.toAgentKey).toBe('content_agent');
    expect(handoff.resolved).toBe(true);
    expect(handoff.run?.status).toBe('succeeded');
    const draftId = (handoff.run!.toolCalls[0].toolOutput as any).draftId;
    const [row] = await readRow<any>(db, `select status::text, drafted_by_agent, source_finding_id from public.content_drafts where id = $1`, [draftId]);
    expect(row.status).toBe('draft');
    expect(row.drafted_by_agent).toBe(true);
    expect(row.source_finding_id).toBe(findingId);
    // "It must never approve or publish its own draft" - proven structurally: nothing in the
    // resolved run's own tool calls is anything other than draft_article, and the row's
    // status is exactly 'draft', never 'approved'.
    expect(handoff.run!.toolCalls.map((c) => c.toolName)).toEqual(['draft_article']);
  });

  it('does NOT cascade into a social repurposing handoff unless explicitly requested', async () => {
    const store = makeStore();
    const findingId = await realFindingId(store);
    const result = await runAgent(store, admin(), {
      workspaceId: ID.nova, agentKey: 'seo_geo_agent', triggeredByKind: 'user',
      input: { task: 'content_brief_handoff', workspaceId: ID.nova, findingId, title: 'Title', topic: 'Topic' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const contentRun = result.run.resolvedHandoffs[0].run!;
    expect(contentRun.handoffs).toHaveLength(0);
    expect(contentRun.resolvedHandoffs).toHaveLength(0);
  });
});

describe('handoff auto-resolution: SEO/GEO Agent -> Content Agent -> Social Media Super Agent (explicitly requested)', () => {
  it('chains all the way to a real sandbox social draft when the ORIGINAL request explicitly asks for it', async () => {
    const store = makeStore();
    const findingId = await realFindingId(store);
    const result = await runAgent(store, admin(), {
      workspaceId: ID.nova, agentKey: 'seo_geo_agent', triggeredByKind: 'user',
      input: {
        task: 'content_brief_handoff', workspaceId: ID.nova, findingId, title: 'New patient FAQ', topic: 'answers to the questions new patients ask most',
        alsoRepurposeToSocial: true, repurposeChannels: [{ channelId: 'chan-1', network: 'facebook' }],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const contentOutcome = result.run.resolvedHandoffs[0];
    expect(contentOutcome.resolved).toBe(true);
    const contentRun = contentOutcome.run!;
    expect(contentRun.resolvedHandoffs).toHaveLength(1);
    const socialOutcome = contentRun.resolvedHandoffs[0];
    expect(socialOutcome.toAgentKey).toBe('social_media_super_agent');
    expect(socialOutcome.resolved).toBe(true);
    expect(socialOutcome.run?.status).toBe('succeeded');

    // A real sandbox social draft now exists, never published, never sent.
    expect(store.socialStore.posts).toHaveLength(1);
    expect(store.socialStore.posts[0].status).toBe('draft');
    expect(store.socialStore.posts[0].body).toContain('New patient FAQ');
  });
});

describe('handoffs to agents that are not built yet stay unresolved, even now', () => {
  it('the Social Media Super Agent\'s analytics/lead-CRM handoffs are still left unresolved', async () => {
    const store = makeStore();
    const result = await runAgent(store, admin(), {
      workspaceId: ID.nova, agentKey: 'social_media_super_agent', triggeredByKind: 'user',
      input: { task: 'request_analytics', metric: 'reach' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.resolvedHandoffs).toHaveLength(1);
    expect(result.run.resolvedHandoffs[0]).toMatchObject({ toAgentKey: 'analytics_reporting_agent', resolved: false });
    expect(result.run.resolvedHandoffs[0].reason).toMatch(/no agent named/);
  });
});

describe('Content Agent: draft_article reuses the approved Client default, with its guardrails intact', () => {
  it('an ungranted Client can draft an article (seo_geo:create is already a default)', async () => {
    const store = makeStore();
    const result = await runAgent(store, client(), {
      workspaceId: ID.nova, agentKey: 'content_agent', triggeredByKind: 'user',
      input: { task: 'draft_article', workspaceId: ID.nova, title: 'Our new hours', topic: 'we are now open on Saturdays' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('succeeded');
    const draftId = (result.run.toolCalls[0].toolOutput as any).draftId;
    const [row] = await readRow<any>(db, `select status::text from public.content_drafts where id = $1`, [draftId]);
    expect(row.status).toBe('draft');
  });

  it('submitting for review reaches "in_review" - never "approved" - there is no tool that approves it', async () => {
    const store = makeStore();
    const result = await runAgent(store, admin(), {
      workspaceId: ID.nova, agentKey: 'content_agent', triggeredByKind: 'user',
      input: { task: 'draft_article', workspaceId: ID.nova, title: 'Title', topic: 'Topic', submitForReview: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const draftId = (result.run.toolCalls[0].toolOutput as any).draftId;
    const [row] = await readRow<any>(db, `select status::text from public.content_drafts where id = $1`, [draftId]);
    expect(row.status).toBe('in_review');
    // The real database itself refuses the agent's own principal approving it, exactly like
    // a human could never approve their own post or reply (see tests/db/content-agent.test.ts
    // for the full proof) - nothing in this run's own tool calls even attempts it.
    expect(result.run.toolCalls.map((c) => c.toolName)).toEqual(['draft_article', 'submit_article_for_review']);
  });
});
