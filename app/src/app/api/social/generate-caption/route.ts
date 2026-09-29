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
import { resolveWorkspaceRole } from '@/lib/agents/resolve-principal';
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

  const resolved = await resolveWorkspaceRole(supabase, user.id, workspaceId);
  if (!resolved) return NextResponse.json({ error: 'you do not have access to that client' }, { status: 403 });

  try {
    await ensureAiUsageCapDefaults(workspaceId);
    const store = createSupabaseAgentStore(supabase);
    const text = await generateCaptionText(store, { id: user.id, role: resolved.role, grants: [] }, workspaceId, network, topic, callToAction);
    return NextResponse.json({ text });
  } catch (err) {
    if (err instanceof AiUsageCapExceededError) return NextResponse.json({ error: err.message }, { status: 429 });
    return NextResponse.json({ error: err instanceof Error ? err.message : 'could not generate a caption' }, { status: 502 });
  }
}
