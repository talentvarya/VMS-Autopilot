/**
 * Phase G.7 - the Website/Domain Agent wired for real. research_domain_names and
 * check_domain_availability are pure computation (no store write, no real WHOIS/registrar
 * call - see website/agent.ts) so they work even without a workspaceId. draft_website_plan
 * and propose_domain_connection need one; propose_domain_connection has no apply() on purpose
 * (no registrar integration exists) - proposing it only proves the permission path.
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { runAgent } from '@/lib/agents/orchestrator';
import { createSupabaseAgentStore, ensureAgentDefinition } from '@/lib/agents/supabase-store';
import { resolveWorkspaceRole } from '@/lib/agents/resolve-principal';

const AGENT_KEY = 'website_domain_agent';
const ALLOWED_TOOLS = ['draft_website_plan', 'submit_website_plan_for_review', 'research_domain_names', 'check_domain_availability', 'propose_domain_connection'];

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const task = body?.task;
  const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : '';
  const needsWorkspace = task === 'draft_website_plan' || task === 'propose_domain_connection';
  if (!task || (needsWorkspace && !workspaceId)) return NextResponse.json({ error: 'task is required (and workspaceId, for a plan or domain connection)' }, { status: 400 });

  let role: 'admin' | 'team_member' | 'client' = 'admin';
  let agencyWorkspaceId = '';
  if (needsWorkspace) {
    const resolved = await resolveWorkspaceRole(supabase, user.id, workspaceId);
    if (!resolved) return NextResponse.json({ error: 'you do not have access to that client' }, { status: 403 });
    role = resolved.role;
    agencyWorkspaceId = resolved.agencyWorkspaceId;
    await ensureAgentDefinition(supabase, agencyWorkspaceId, AGENT_KEY, 'Website/Domain Agent', ALLOWED_TOOLS);
  } else {
    // Domain-name research needs no workspace at all - resolve the caller's own agency just
    // so the (workspace-scoped) agent_definitions row still has somewhere to live.
    const { data: memberships } = await supabase.from('workspace_members').select('workspace_id, workspaces!inner(kind)').eq('user_id', user.id).eq('workspaces.kind', 'agency').limit(1);
    agencyWorkspaceId = memberships?.[0]?.workspace_id ?? '';
    if (!agencyWorkspaceId) return NextResponse.json({ error: 'no agency workspace found for this account yet' }, { status: 400 });
    await ensureAgentDefinition(supabase, agencyWorkspaceId, AGENT_KEY, 'Website/Domain Agent', ALLOWED_TOOLS);
  }

  const store = createSupabaseAgentStore(supabase);
  const outcome = await runAgent(store, { id: user.id, role, grants: [] }, {
    workspaceId: workspaceId || agencyWorkspaceId,
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
