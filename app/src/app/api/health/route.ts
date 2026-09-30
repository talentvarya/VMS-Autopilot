/**
 * Phase G.2 - real AI Monitor list. RLS (health_checks_select / health_incidents_select)
 * scopes results to workspaces the caller holds 'health_monitor' view on. Open incidents
 * first (the actionable ones), then the most recent checks for context.
 */

import { NextResponse } from 'next/server';
import { dbErrorResponse } from '@/lib/api/errors';
import { createClient } from '@/lib/supabase/server';

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const [incidents, checks] = await Promise.all([
    supabase
      .from('health_incidents')
      .select('id, workspace_id, check_type, opened_at, closed_at, auto_repair_attempted, workspaces(name)')
      .is('closed_at', null)
      .order('opened_at', { ascending: false }),
    supabase
      .from('health_checks')
      .select('id, workspace_id, check_type, status, checked_at, workspaces(name)')
      .order('checked_at', { ascending: false })
      .limit(20),
  ]);

  if (incidents.error) return dbErrorResponse(incidents.error);
  if (checks.error) return dbErrorResponse(checks.error);
  return NextResponse.json({ incidents: incidents.data, checks: checks.data });
}
