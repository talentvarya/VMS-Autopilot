/**
 * Phase G.4 - the "..." menu on a client row. RLS (workspaces_update) only lets an Admin of
 * the workspace write to it, and only these three columns are grantable at all
 * (name, industry, archived_at) - see the privilege grant next to workspaces_update.
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const update: Record<string, string | null> = {};
  if (typeof body?.name === 'string' && body.name.trim()) update.name = body.name.trim();
  if (body?.archive === true) update.archived_at = new Date().toISOString();
  if (body?.archive === false) update.archived_at = null;
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('workspaces')
    .update(update)
    .eq('id', id)
    .select('id, name, industry, kind, created_at')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ workspace: data });
}
