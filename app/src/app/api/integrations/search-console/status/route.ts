import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { resolveWorkspaceRole } from '@/lib/agents/resolve-principal';
import { fetchVerifiedSites } from '@/lib/integrations/search-console';

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
    .from('search_console_connections')
    .select('site_url, access_token, connected_at')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (!data) return NextResponse.json({ connected: false });

  // Look up the LIVE permission level for the connected property, so "verified" reflects
  // Google's current record, not just whatever it was at connect time.
  let verified: boolean | null = null;
  try {
    const sites = await fetchVerifiedSites(data.access_token);
    const site = sites.find((s) => s.siteUrl === data.site_url);
    verified = !!site && site.permissionLevel !== 'siteUnverifiedUser';
  } catch {
    verified = null; // token likely needs a refresh - the performance route will surface that clearly
  }

  return NextResponse.json({ connected: true, siteUrl: data.site_url, verified, connectedAt: data.connected_at });
}
