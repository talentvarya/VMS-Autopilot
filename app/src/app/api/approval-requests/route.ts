/**
 * Phase G.2 - real approval queue. RLS (approvals_select) already scopes this to requests
 * the caller may see: an agency Admin sees every request across their client workspaces,
 * a requester sees only their own. The database trigger (trg_approval_before) enforces who
 * may actually decide, so PATCH here only needs to attempt the update and surface its error.
 */

import { NextResponse } from 'next/server';
import { dbErrorResponse } from '@/lib/api/errors';
import { createClient } from '@/lib/supabase/server';

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const { data, error } = await supabase
    .from('approval_requests')
    .select('id, workspace_id, module, action, title, status, created_at, workspaces(name)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  if (error) return dbErrorResponse(error);
  return NextResponse.json({ approvals: data });
}

export async function PATCH(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const id = typeof body?.id === 'string' ? body.id : '';
  const status = body?.status === 'approved' || body?.status === 'rejected' ? body.status : null;
  if (!id || !status) return NextResponse.json({ error: 'id and status (approved/rejected) are required' }, { status: 400 });

  const { data, error } = await supabase
    .from('approval_requests')
    .update({ status })
    .eq('id', id)
    .select('id, status')
    .single();

  if (error) return dbErrorResponse(error);
  return NextResponse.json({ approval: data });
}
