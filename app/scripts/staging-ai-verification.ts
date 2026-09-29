/**
 * TEMPORARY, one-off Phase F.3 staging verification script - delete after use.
 *
 * Runs EXACTLY ONE real draft_post/caption-generation call through the existing runAgent() +
 * generateCaptionText() path, against the REAL staging Postgres database, as an Admin, so the
 * whole real-provider chain (permission gate -> AI usage cap pre-check -> real Anthropic call
 * -> usage logging -> a genuine sandbox social draft) can be confirmed once, for real, on
 * staging - something this repository's own test suite cannot do, because it only ever runs
 * against an in-memory PGlite database, never a real deployed one.
 *
 * What this script does NOT do, by construction:
 *   - It never sets submitForReview - the created post can only ever reach 'draft' status.
 *   - It never calls anything Meta/Buffer-shaped - src/lib/social/sources.ts's
 *     LIVE_SOCIAL_ENABLED is untouched and still false, so no such code even exists to call.
 *   - It never creates an agent_definitions row, a workspace, a user or a channel - all four
 *     IDs it needs must already exist in staging; you provide them (see the companion
 *     instructions), read-only, never anything this script invents.
 *   - It never reads, prints, or otherwise exposes ANTHROPIC_API_KEY or STAGING_DATABASE_URL -
 *     both are read only by the libraries that already need them (the Anthropic SDK reads the
 *     key itself; `pg` reads the connection string itself) and neither is ever logged here.
 *   - It never prints the generated caption text - only safe identifiers (run status, the new
 *     post's id, token counts, cost, provider name). Read the caption itself, if you want to,
 *     with the read-only SQL query in the companion instructions.
 *
 * Requires (all read from process.env, all supplied by YOU, none hardcoded or printed):
 *   APP_ENV              must be exactly "staging" - refuses to run otherwise.
 *   STAGING_DATABASE_URL a direct Postgres connection string to the staging Supabase project
 *                        (Project Settings -> Database -> Connection string -> URI).
 *   WORKSPACE_ID         an existing workspace's id.
 *   ADMIN_USER_ID        an existing user's id who already holds the Admin role in that
 *                        workspace (workspace_members.role = 'admin').
 *   CHANNEL_ID           an existing, active sandbox social_channels row in that workspace.
 *   TOPIC                optional - the caption's topic. Defaults to a clearly-labeled test
 *                        string if unset.
 *   NETWORK              optional - defaults to "facebook".
 *
 * Run with:  npx tsx scripts/staging-ai-verification.ts
 * (see the companion message in this conversation for the full setup checklist)
 */

import { Client } from 'pg';
import { runAgent, type Principal } from '../src/lib/agents/orchestrator';
import type {
  AgentDefinition,
  AgentStore,
  AiUsageCapStatus,
  ApprovalRequestInput,
  CreateSocialPostInput,
  RecordAiUsageInput,
} from '../src/lib/agents/types';
import type { AuditEvent } from '../src/lib/permissions';
import { NETWORKS, type Network } from '../src/lib/social/types';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

if (process.env.APP_ENV !== 'staging') {
  console.error('Refusing to run: APP_ENV must be exactly "staging". This script must never be run against development, test, or production.');
  process.exit(1);
}

const databaseUrl = requireEnv('STAGING_DATABASE_URL');
const workspaceId = requireEnv('WORKSPACE_ID');
const adminUserId = requireEnv('ADMIN_USER_ID');
const channelId = requireEnv('CHANNEL_ID');
const topic = process.env.TOPIC?.trim() || 'Staging AI verification test - safe to delete';
const requestedNetwork = process.env.NETWORK?.trim() || 'facebook';
if (!(NETWORKS as readonly string[]).includes(requestedNetwork)) {
  console.error(`NETWORK must be one of: ${NETWORKS.join(', ')} (got "${requestedNetwork}")`);
  process.exit(1);
}
const network = requestedNetwork as Network;

async function asRole<T>(client: Client, role: 'authenticated' | 'service_role', userId: string | null, fn: () => Promise<T>): Promise<T> {
  await client.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId ?? '']);
  await client.query(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await client.query('reset role');
    await client.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
}

class StagingVerificationStore implements AgentStore {
  private n = 0;
  constructor(private readonly client: Client) {}

  /** No real agent_definitions row is required - this is the one, fixed definition this script needs. */
  async findDefinition(): Promise<AgentDefinition | null> {
    return {
      id: 'staging-verification',
      workspaceId,
      agentKey: 'social_media_super_agent',
      displayName: 'Social Media Super Agent',
      description: null,
      model: 'staging-verification',
      systemPrompt: '',
      allowedTools: ['draft_post'],
      enabled: true,
    };
  }

  newId() {
    return `staging-verify-run-${++this.n}`;
  }

  async createApprovalRequest(input: ApprovalRequestInput) {
    const result = await asRole(this.client, 'authenticated', input.requestedBy, () =>
      this.client.query(
        `insert into public.approval_requests (workspace_id, module, action, title, details) values ($1, $2::public.permission_module, $3::public.permission_action, $4, $5) returning id`,
        [input.workspaceId, input.module, input.action, input.title, JSON.stringify(input.details)],
      ),
    );
    return { id: result.rows[0].id as string };
  }

  async createSocialPost(principal: Principal, input: CreateSocialPostInput) {
    const result = await asRole(this.client, 'authenticated', principal.id, () =>
      this.client.query(`insert into public.social_posts (workspace_id, channel_id, body) values ($1, $2, $3) returning id`, [
        input.workspaceId, input.channelId, input.body,
      ]),
    );
    return { id: result.rows[0].id as string };
  }

  async getAiUsageCapStatus(): Promise<AiUsageCapStatus> {
    const settings = await asRole(this.client, 'service_role', null, () =>
      this.client.query(`select ai_daily_call_cap, ai_monthly_cost_cap_usd from public.workspace_settings where workspace_id = $1`, [workspaceId]),
    );
    const daily = await asRole(this.client, 'service_role', null, () =>
      this.client.query(`select count(*)::text as daily_count from public.ai_usage_log where workspace_id = $1 and created_at >= date_trunc('day', now())`, [workspaceId]),
    );
    const monthly = await asRole(this.client, 'service_role', null, () =>
      this.client.query(`select coalesce(sum(estimated_cost_usd), 0)::text as monthly_cost from public.ai_usage_log where workspace_id = $1 and created_at >= date_trunc('month', now())`, [workspaceId]),
    );
    const row = settings.rows[0];
    return {
      dailyCallCap: row?.ai_daily_call_cap ?? null,
      monthlyCostCapUsd: row?.ai_monthly_cost_cap_usd != null ? Number(row.ai_monthly_cost_cap_usd) : null,
      dailyCallCount: Number(daily.rows[0].daily_count),
      monthlyCostUsd: Number(monthly.rows[0].monthly_cost),
    };
  }

  async recordAiUsage(input: RecordAiUsageInput) {
    await asRole(this.client, 'service_role', null, () =>
      this.client.query(
        `insert into public.ai_usage_log (workspace_id, agent_run_id, provider, model, input_tokens, output_tokens, estimated_cost_usd) values ($1, $2, $3, $4, $5, $6, $7)`,
        [input.workspaceId, input.agentRunId ?? null, input.provider, input.model, input.inputTokens, input.outputTokens, input.estimatedCostUsd],
      ),
    );
  }

  async recordAuditEvent(event: AuditEvent) {
    await asRole(this.client, 'service_role', null, () =>
      this.client.query(
        `insert into public.audit_log (actor_id, actor_role, workspace_id, module, action, target_type, target_id, result, approval_id, approval_status, metadata)
         values ($1, $2, $3, $4::public.permission_module, $5, $6, $7, $8::public.audit_result, $9, $10::public.approval_status, $11)`,
        [
          event.actorId, event.actorRole, event.workspaceId, event.module, event.action,
          event.targetType ?? null, event.targetId ?? null, event.result, event.approvalId ?? null,
          event.approvalStatus ?? null, JSON.stringify(event.metadata ?? {}),
        ],
      ),
    );
  }
}

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const store = new StagingVerificationStore(client);
    const principal: Principal = { id: adminUserId, role: 'admin', grants: [] };

    console.log('Running one draft_post call against staging...');
    const result = await runAgent(store, principal, {
      workspaceId,
      agentKey: 'social_media_super_agent',
      triggeredByKind: 'user',
      input: { task: 'draft_post', workspaceId, channelId, network, topic },
    });

    if (!result.ok) {
      console.error('runAgent did not complete:', result.reason);
      process.exitCode = 1;
      return;
    }

    console.log('run.status:', result.run.status);
    const draftCall = result.run.toolCalls.find((c) => c.toolName === 'draft_post');
    console.log('draft_post decision:', draftCall?.decision ?? null);
    console.log('draft_post applyError:', draftCall?.applyError ?? null);
    const postId = (draftCall?.toolOutput as { postId?: string } | null)?.postId ?? null;
    console.log('created post id:', postId);

    if (postId) {
      const statusRow = await asRole(client, 'service_role', null, () =>
        client.query(`select status::text as status from public.social_posts where id = $1`, [postId]),
      );
      console.log('post status (must be "draft"):', statusRow.rows[0]?.status ?? null);
    }

    const usageRow = await asRole(client, 'service_role', null, () =>
      client.query(
        `select provider, model, input_tokens, output_tokens, estimated_cost_usd from public.ai_usage_log where workspace_id = $1 order by created_at desc limit 1`,
        [workspaceId],
      ),
    );
    if (usageRow.rows[0]) {
      const u = usageRow.rows[0];
      console.log('most recent ai_usage_log row -> provider:', u.provider, '| model:', u.model, '| input_tokens:', u.input_tokens, '| output_tokens:', u.output_tokens, '| estimated_cost_usd:', u.estimated_cost_usd);
    } else {
      console.log('no ai_usage_log row was written (expected if the call was blocked by a cap, or if the real path was not reached).');
    }

    console.log('Done. The caption text itself was never printed - see the companion instructions for a read-only query to view it if you want to.');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('Script failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
