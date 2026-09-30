import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { resolveWorkspaceRole } from '@/lib/agents/resolve-principal';

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const workspaceId = new URL(request.url).searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });

  const resolved = await resolveWorkspaceRole(supabase, user.id, workspaceId);
  if (!resolved) return NextResponse.json({ error: 'you do not have access to that client' }, { status: 403 });

  const service = createServiceClient();
  const { data } = await service
    .from('buffer_connections')
    .select('buffer_organization_id, connected_at')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  return NextResponse.json({ connected: !!data, connectedAt: data?.connected_at ?? null });
}
