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

const WEBSITE_PROVIDERS = ['vercel', 'lovable', 'emergent', 'google_ai_studio', 'other'] as const;

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const workspaceId = typeof body?.workspace_id === 'string' ? body.workspace_id : '';
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const provider = WEBSITE_PROVIDERS.includes(body?.provider) ? body.provider : 'other';
  if (!workspaceId) return NextResponse.json({ error: 'a client is required' }, { status: 400 });
  if (!title) return NextResponse.json({ error: 'a project title is required' }, { status: 400 });

  const { data, error } = await supabase
    .from('website_projects')
    .insert({ workspace_id: workspaceId, provider, title })
    .select('id, workspace_id, provider, title, status, created_at, workspaces(name)')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ row: data }, { status: 201 });
}
