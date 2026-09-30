/**
 * Phase G.2 - real Paid Ads list. Read-only for now (no live spend, no Meta connection -
 * campaign rows only ever come from an Admin or an agent drafting inside this app). RLS
 * (ad_campaigns_select) scopes results to workspaces the caller holds 'paid_ads' view on.
 */

import { NextResponse } from 'next/server';
import { dbErrorResponse } from '@/lib/api/errors';
import { createClient } from '@/lib/supabase/server';

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const { data, error } = await supabase
    .from('ad_campaigns')
    .select('id, workspace_id, platform, objective, name, status, budget_amount, budget_period, created_at, workspaces(name)')
    .order('created_at', { ascending: false });

  if (error) return dbErrorResponse(error);
  return NextResponse.json({ rows: data });
}

const AD_PLATFORMS = ['meta', 'google'] as const;

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const workspaceId = typeof body?.workspace_id === 'string' ? body.workspace_id : '';
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const objective = typeof body?.objective === 'string' && body.objective.trim() ? body.objective.trim() : 'Awareness';
  const platform = AD_PLATFORMS.includes(body?.platform) ? body.platform : 'meta';
  if (!workspaceId) return NextResponse.json({ error: 'a client is required' }, { status: 400 });
  if (!name) return NextResponse.json({ error: 'a campaign name is required' }, { status: 400 });

  // No Meta/Google connection exists anywhere in this app - every campaign is created as
  // 'draft' (the table's own default) and never spends anything or reaches a real platform.
  const { data, error } = await supabase
    .from('ad_campaigns')
    .insert({ workspace_id: workspaceId, platform, objective, name })
    .select('id, workspace_id, platform, objective, name, status, budget_amount, budget_period, created_at, workspaces(name)')
    .single();

  if (error) return dbErrorResponse(error);
  return NextResponse.json({ row: data }, { status: 201 });
}
