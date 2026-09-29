/**
 * Phase G.7 - the Paid Ads Agent wired for real. Only ever drafts (status stays 'draft' or
 * moves to 'in_review') - there is no Meta/Google connection anywhere in this app, so nothing
 * can spend or reach a live platform. launch_campaign has no apply() in the agent's own logic
 * on purpose (see paid-ads/agent.ts) - proposing it only proves the permission path.
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { runAgent } from '@/lib/agents/orchestrator';
import { createSupabaseAgentStore, ensureAgentDefinition } from '@/lib/agents/supabase-store';
import { resolveWorkspaceRole } from '@/lib/agents/resolve-principal';

const AGENT_KEY = 'paid_ads_agent';
const ALLOWED_TOOLS = ['draft_campaign', 'submit_campaign_for_review', 'update_campaign_budget', 'launch_campaign'];

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : '';
  const task = body?.task;
  if (!workspaceId || !task) return NextResponse.json({ error: 'workspaceId and task are required' }, { status: 400 });

  const resolved = await resolveWorkspaceRole(supabase, user.id, workspaceId);
  if (!resolved) return NextResponse.json({ error: 'you do not have access to that client' }, { status: 403 });

  await ensureAgentDefinition(supabase, resolved.agencyWorkspaceId, AGENT_KEY, 'Paid Ads Agent', ALLOWED_TOOLS);
  const store = createSupabaseAgentStore(supabase);
  const outcome = await runAgent(store, { id: user.id, role: resolved.role, grants: [] }, {
    workspaceId,
    agentKey: AGENT_KEY,
    triggeredByKind: 'user',
    input: body,
  });

  if (!outcome.ok) return NextResponse.json({ error: outcome.reason }, { status: 400 });
  if (outcome.run.status === 'failed') {
    const firstError = outcome.run.toolCalls.find(c => c.applyError || c.decision === 'deny');
    return NextResponse.json({ error: firstError?.applyError ?? 'that action was refused' }, { status: 400 });
  }
  return NextResponse.json({ status: outcome.run.status, output: outcome.run.output, toolCalls: outcome.run.toolCalls });
}
