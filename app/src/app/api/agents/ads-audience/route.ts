/**
 * Phase G.9 - the Paid Ads Audience & Targeting Agent wired for real. All research is
 * deterministic and input-driven (never a real web/social lookup - see ads-audience/agent.ts).
 * finalize_audience_brief writes to ad_audience_briefs via the caller's own RLS-scoped session
 * (real authenticated insert/update grants on that table).
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { runAgent } from '@/lib/agents/orchestrator';
import { createSupabaseAgentStore, ensureAgentDefinition } from '@/lib/agents/supabase-store';
import { resolveWorkspaceRole } from '@/lib/agents/resolve-principal';

const AGENT_KEY = 'ads_audience_agent';
const ALLOWED_TOOLS = ['intake_business_profile', 'research_audience_signals', 'create_audience_hypotheses', 'finalize_audience_brief'];

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const task = body?.task;
  const businessProfile = body?.businessProfile;
  if (!task || !businessProfile?.name || !businessProfile?.industry || !businessProfile?.product) {
    return NextResponse.json({ error: 'task and a businessProfile (name, industry, product) are required' }, { status: 400 });
  }

  const needsWorkspace = task === 'finalize_audience_brief';
  const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : '';
  if (needsWorkspace && !workspaceId) return NextResponse.json({ error: 'workspaceId is required to finalize a brief' }, { status: 400 });

  let role: 'admin' | 'team_member' | 'client' = 'admin';
  let agencyWorkspaceId = '';
  let runWorkspaceId = workspaceId;

  if (needsWorkspace) {
    const resolved = await resolveWorkspaceRole(supabase, user.id, workspaceId);
    if (!resolved) return NextResponse.json({ error: 'you do not have access to that client' }, { status: 403 });
    role = resolved.role;
    agencyWorkspaceId = resolved.agencyWorkspaceId;
  } else {
    const { data: memberships } = await supabase.from('workspace_members').select('workspace_id, workspaces!inner(kind)').eq('user_id', user.id).eq('workspaces.kind', 'agency').limit(1);
    agencyWorkspaceId = memberships?.[0]?.workspace_id ?? '';
    if (!agencyWorkspaceId) return NextResponse.json({ error: 'no agency workspace found for this account yet' }, { status: 400 });
    runWorkspaceId = agencyWorkspaceId;
  }

  await ensureAgentDefinition(supabase, agencyWorkspaceId, AGENT_KEY, 'Paid Ads Audience & Targeting Agent', ALLOWED_TOOLS);
  const store = createSupabaseAgentStore(supabase);
  const outcome = await runAgent(store, { id: user.id, role, grants: [] }, {
    workspaceId: runWorkspaceId,
    agentKey: AGENT_KEY,
    triggeredByKind: 'user',
    input: body,
  });

  if (!outcome.ok) return NextResponse.json({ error: outcome.reason }, { status: 400 });
  if (outcome.run.status === 'failed') {
    const firstError = outcome.run.toolCalls.find(c => c.applyError || c.decision === 'deny');
    return NextResponse.json({ error: firstError?.applyError ?? 'that action was refused' }, { status: 400 });
  }
  return NextResponse.json({ status: outcome.run.status, output: outcome.run.output });
}
