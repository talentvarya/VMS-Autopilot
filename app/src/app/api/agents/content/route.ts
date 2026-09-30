/**
 * Phase G.9 - the Content Agent wired for real. draft_article writes a content_drafts row via
 * the caller's own RLS-scoped session (real authenticated insert grant on that table) - no
 * service-role client needed. No tool here ever approves or publishes anything.
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { runAgent } from '@/lib/agents/orchestrator';
import { createSupabaseAgentStore, ensureAgentDefinition } from '@/lib/agents/supabase-store';
import { resolveWorkspaceRole } from '@/lib/agents/resolve-principal';

const AGENT_KEY = 'content_agent';
const ALLOWED_TOOLS = ['draft_article', 'submit_article_for_review'];

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : '';
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const topic = typeof body?.topic === 'string' ? body.topic.trim() : '';
  if (!workspaceId || !title || !topic) return NextResponse.json({ error: 'workspaceId, title and topic are required' }, { status: 400 });

  const resolved = await resolveWorkspaceRole(supabase, user.id, workspaceId);
  if (!resolved) return NextResponse.json({ error: 'you do not have access to that client' }, { status: 403 });

  await ensureAgentDefinition(supabase, resolved.agencyWorkspaceId, AGENT_KEY, 'Content Agent', ALLOWED_TOOLS);
  const store = createSupabaseAgentStore(supabase);
  const outcome = await runAgent(store, { id: user.id, role: resolved.role, grants: [] }, {
    workspaceId,
    agentKey: AGENT_KEY,
    triggeredByKind: 'user',
    input: { task: 'draft_article', workspaceId, title, topic, submitForReview: body.submitForReview === true },
  });

  if (!outcome.ok) return NextResponse.json({ error: outcome.reason }, { status: 400 });
  if (outcome.run.status === 'failed') {
    const firstError = outcome.run.toolCalls.find(c => c.applyError || c.decision === 'deny');
    return NextResponse.json({ error: firstError?.applyError ?? 'that action was refused' }, { status: 400 });
  }
  return NextResponse.json({ status: outcome.run.status, output: outcome.run.output });
}
