/**
 * Phase G.9 - the Monitoring/Auto-Repair Agent wired for real. check_website_availability is
 * sandbox-only (reachability simulated against known fixture origins, never a real request -
 * see monitoring/agent.ts); check_stale_audits/check_stale_social_publishing call the real,
 * unmodified Phase 2/3 repair functions (reimplemented in supabase-store.ts without needing a
 * raw Postgres connection).
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { runAgent } from '@/lib/agents/orchestrator';
import { createSupabaseAgentStore, ensureAgentDefinition } from '@/lib/agents/supabase-store';
import { resolveWorkspaceRole } from '@/lib/agents/resolve-principal';

const AGENT_KEY = 'monitoring_auto_repair_agent';
const ALLOWED_TOOLS = ['check_website_availability', 'check_stale_audits', 'check_stale_social_publishing', 'requeue_failed_audit', 'resume_failed_post'];

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

  await ensureAgentDefinition(supabase, resolved.agencyWorkspaceId, AGENT_KEY, 'Monitoring/Auto-Repair Agent', ALLOWED_TOOLS);
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
