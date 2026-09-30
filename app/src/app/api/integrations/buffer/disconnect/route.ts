import { NextResponse } from 'next/server';
import { dbErrorResponse } from '@/lib/api/errors';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { resolveWorkspaceRole } from '@/lib/agents/resolve-principal';

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const workspaceId = body?.workspaceId;
  if (typeof workspaceId !== 'string' || !workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });

  const resolved = await resolveWorkspaceRole(supabase, user.id, workspaceId);
  if (!resolved) return NextResponse.json({ error: 'you do not have access to that client' }, { status: 403 });
  if (resolved.role !== 'admin') return NextResponse.json({ error: 'only an Admin can disconnect a Buffer account' }, { status: 403 });

  const service = createServiceClient();
  const { error } = await service.from('buffer_connections').delete().eq('workspace_id', workspaceId);
  if (error) return dbErrorResponse(error, 500);

  return NextResponse.json({ ok: true });
}
