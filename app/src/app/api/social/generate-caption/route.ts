/**
 * Phase G.6 - the first real call into the Social Media Super Agent: AI-written caption text
 * for the sandbox Composer. Everything about POSTING stays exactly as sandboxed as before (no
 * real channel, no live publish) - this route only ever returns text for the person to review
 * and edit before saving a draft, same as if they had typed it themselves.
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { generateCaptionText } from '@/lib/agents/social/agent';
import { AiUsageCapExceededError } from '@/lib/ai/usage-cap';
import { createSupabaseAgentStore, ensureAiUsageCapDefaults } from '@/lib/agents/supabase-store';
import { resolveRole } from '@/lib/permissions';
import { NETWORKS, type Network } from '@/lib/social/types';

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : '';
  const network = NETWORKS.includes(body?.network) ? (body.network as Network) : null;
  const topic = typeof body?.topic === 'string' ? body.topic.trim() : '';
  const callToAction = typeof body?.callToAction === 'string' && body.callToAction.trim() ? body.callToAction.trim() : undefined;
  if (!workspaceId || !network) return NextResponse.json({ error: 'a client and a network are required' }, { status: 400 });
  if (!topic) return NextResponse.json({ error: 'a topic is required' }, { status: 400 });

  // Resolve the caller's real role for this (client) workspace, the same way the database's
  // own role_of_user() does: a direct membership, or reaching down from their agency.
  const { data: workspace } = await supabase.from('workspaces').select('id, kind, parent_workspace_id').eq('id', workspaceId).maybeSingle();
  if (!workspace) return NextResponse.json({ error: 'that client was not found' }, { status: 404 });
  const { data: memberships } = await supabase.from('workspace_members').select('workspace_id, role').eq('user_id', user.id);
  const role = resolveRole(
    (memberships ?? []).map(m => ({ workspaceId: m.workspace_id, role: m.role })),
    { id: workspace.id, kind: workspace.kind, parentId: workspace.parent_workspace_id },
  );
  if (!role) return NextResponse.json({ error: 'you do not have access to that client' }, { status: 403 });

  try {
    await ensureAiUsageCapDefaults(workspaceId);
    const store = createSupabaseAgentStore();
    const text = await generateCaptionText(store, { id: user.id, role, grants: [] }, workspaceId, network, topic, callToAction);
    return NextResponse.json({ text });
  } catch (err) {
    if (err instanceof AiUsageCapExceededError) return NextResponse.json({ error: err.message }, { status: 429 });
    return NextResponse.json({ error: err instanceof Error ? err.message : 'could not generate a caption' }, { status: 502 });
  }
}
