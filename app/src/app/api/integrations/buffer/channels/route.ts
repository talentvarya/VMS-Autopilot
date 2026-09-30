import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { resolveWorkspaceRole } from '@/lib/agents/resolve-principal';
import { fetchChannels, getValidBufferAccessToken } from '@/lib/integrations/buffer';

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const workspaceId = new URL(request.url).searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });

  const resolved = await resolveWorkspaceRole(supabase, user.id, workspaceId);
  if (!resolved) return NextResponse.json({ error: 'you do not have access to that client' }, { status: 403 });

  const service = createServiceClient();
  const connection = await getValidBufferAccessToken(service, workspaceId);
  if (!connection) return NextResponse.json({ error: 'Buffer is not connected for this client' }, { status: 400 });

  try {
    const channels = await fetchChannels(connection.accessToken, connection.organizationId);
    return NextResponse.json({ channels });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Could not load Buffer channels' }, { status: 502 });
  }
}
