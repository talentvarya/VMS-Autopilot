/**
 * Phase G.2 - real Paid Ads list. Read-only for now (no live spend, no Meta connection -
 * campaign rows only ever come from an Admin or an agent drafting inside this app). RLS
 * (ad_campaigns_select) scopes results to workspaces the caller holds 'paid_ads' view on.
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const { data, error } = await supabase
    .from('ad_campaigns')
    .select('id, workspace_id, platform, objective, name, status, budget_amount, budget_period, created_at, workspaces(name)')
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ rows: data });
}
