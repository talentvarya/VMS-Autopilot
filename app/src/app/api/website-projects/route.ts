/**
 * Phase G.2 - real Domains/Website Projects list. RLS (website_projects_select) scopes
 * results to workspaces the caller holds 'website' view on.
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const { data, error } = await supabase
    .from('website_projects')
    .select('id, workspace_id, provider, title, status, created_at, workspaces(name)')
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ rows: data });
}
