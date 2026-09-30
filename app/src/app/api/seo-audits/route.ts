/**
 * Phase G.16 - real audit history + latest findings for a client's website(s). RLS
 * (sites_select/runs_select/findings_select) already scopes every query to workspaces the
 * caller holds 'seo_geo' view on.
 */

import { NextResponse } from 'next/server';
import { dbErrorResponse } from '@/lib/api/errors';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const workspaceId = new URL(request.url).searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });

  const { data: sites, error: sitesError } = await supabase
    .from('sites')
    .select('id, origin, label, business_type, source')
    .eq('workspace_id', workspaceId)
    .is('archived_at', null)
    .order('created_at', { ascending: false });
  if (sitesError) return dbErrorResponse(sitesError);

  const siteIds = (sites ?? []).map(s => s.id);
  if (siteIds.length === 0) return NextResponse.json({ sites: [], runs: [], findings: [] });

  const { data: runs, error: runsError } = await supabase
    .from('audit_runs')
    .select('id, site_id, status, queued_at, started_at, finished_at, overall_score, overall_note, category_scores, counts, error')
    .in('site_id', siteIds)
    .order('queued_at', { ascending: false })
    .limit(20);
  if (runsError) return dbErrorResponse(runsError);

  const latestCompleted = (runs ?? []).find(r => r.status === 'completed');
  let findings: unknown[] = [];
  if (latestCompleted) {
    const { data: findingsData, error: findingsError } = await supabase
      .from('audit_findings')
      .select('id, category, severity, code, title, evidence, recommendation, fix_status, fix_note')
      .eq('run_id', latestCompleted.id);
    if (findingsError) return dbErrorResponse(findingsError);
    findings = findingsData ?? [];
  }

  return NextResponse.json({ sites, runs, latestRunId: latestCompleted?.id ?? null, findings });
}
