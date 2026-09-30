import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { resolveWorkspaceRole } from '@/lib/agents/resolve-principal';
import { fetchSearchPerformance, getValidSearchConsoleAccessToken } from '@/lib/integrations/search-console';

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const workspaceId = new URL(request.url).searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });

  const resolved = await resolveWorkspaceRole(supabase, user.id, workspaceId);
  if (!resolved) return NextResponse.json({ error: 'you do not have access to that client' }, { status: 403 });

  const service = createServiceClient();
  const connection = await getValidSearchConsoleAccessToken(service, workspaceId);
  if (!connection) return NextResponse.json({ error: 'Search Console is not connected for this client' }, { status: 400 });

  try {
    const result = await fetchSearchPerformance(connection.accessToken, connection.siteUrl);
    return NextResponse.json({ siteUrl: connection.siteUrl, ...result });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Could not load Search Console performance' }, { status: 502 });
  }
}
