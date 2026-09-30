/**
 * Phase G.1 - the first real API route. Uses the SIGNED-IN USER's own Supabase session (see
 * src/lib/supabase/server.ts) - every query here goes through the database's own Row Level
 * Security exactly as it already does for a direct SQL client. Nothing here bypasses RLS.
 */

import { NextResponse } from 'next/server';
import { dbErrorResponse } from '@/lib/api/errors';
import { createClient } from '@/lib/supabase/server';

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  // RLS (workspaces_select) already narrows this to the caller's own agency's client
  // workspaces - the query itself does not need to know the agency id.
  const { data, error } = await supabase
    .from('workspaces')
    .select('id, name, industry, kind, created_at')
    .eq('kind', 'client')
    .is('archived_at', null)
    .order('created_at', { ascending: false });

  if (error) return dbErrorResponse(error);
  return NextResponse.json({ workspaces: data });
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const industry = typeof body?.industry === 'string' ? body.industry.trim() : null;
  if (!name) return NextResponse.json({ error: 'a client name is required' }, { status: 400 });

  // The caller's own agency workspace - RLS (workspaces_select) already limits this to
  // workspaces the caller actually belongs to.
  const { data: memberships, error: membershipError } = await supabase
    .from('workspace_members')
    .select('workspace_id, workspaces!inner(kind)')
    .eq('user_id', user.id)
    .eq('workspaces.kind', 'agency')
    .limit(1);

  if (membershipError) return dbErrorResponse(membershipError);
  const agencyWorkspaceId = memberships?.[0]?.workspace_id;
  if (!agencyWorkspaceId) {
    return NextResponse.json({ error: 'no agency workspace found for this account yet - see the one-time setup step' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('workspaces')
    .insert({ kind: 'client', parent_workspace_id: agencyWorkspaceId, name, industry })
    .select('id, name, industry, kind, created_at')
    .single();

  if (error) return dbErrorResponse(error);
  return NextResponse.json({ workspace: data }, { status: 201 });
}
