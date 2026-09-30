/**
 * Phase G.10 - the rest of the Social Media Super Agent, run through the full Orchestrator:
 * research_strategy (pure computation) and generate_calendar (writes real, persisted calendar
 * slots to social_content_calendar_items - no channel needed). video_script is also pure
 * computation, handled the same way.
 *
 * draft_post/repurpose_blog/draft_reply are NOT reachable here on purpose: they all need a
 * real social_channels row, and that table has no insert grant for `authenticated` at all -
 * only a real OAuth connection could ever create one, which does not exist in this app (see
 * "Connect Buffer", permanently disabled in the sandbox Social Publishing page). Caption text
 * and flyer images are already available as real, standalone tools
 * (/api/social/generate-caption, /api/social/generate-image) for use in that sandbox instead.
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { runAgent } from '@/lib/agents/orchestrator';
import { createSupabaseAgentStore, ensureAgentDefinition } from '@/lib/agents/supabase-store';
import { resolveWorkspaceRole } from '@/lib/agents/resolve-principal';

const AGENT_KEY = 'social_media_super_agent';
const ALLOWED_TASKS = new Set(['research_strategy', 'generate_calendar', 'video_script']);
const ALLOWED_TOOLS = ['research_strategy', 'generate_calendar', 'video_script'];

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const task = body?.task;
  if (!ALLOWED_TASKS.has(task)) return NextResponse.json({ error: 'only research_strategy, generate_calendar and video_script are supported here' }, { status: 400 });

  const needsWorkspace = task === 'generate_calendar';
  const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : '';
  if (needsWorkspace && !workspaceId) return NextResponse.json({ error: 'workspaceId is required to generate a calendar' }, { status: 400 });

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

  await ensureAgentDefinition(supabase, agencyWorkspaceId, AGENT_KEY, 'Social Media Super Agent', ALLOWED_TOOLS);
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
