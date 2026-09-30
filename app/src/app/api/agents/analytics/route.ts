/**
 * Phase G.9 - the Analytics/Reporting Agent wired for real. Structurally read-only: this
 * agent's own function takes no store and no principal (see analytics/agent.ts), so this
 * route's only job is to fetch real, already-authorized data (RLS-scoped, same session as
 * every other route) and hand it to the agent to summarize - it never writes anything.
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { runAnalyticsAgent } from '@/lib/agents/analytics/agent';
import { resolveWorkspaceRole } from '@/lib/agents/resolve-principal';

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const task = body?.task;
  if (task !== 'compile_agency_report') return NextResponse.json({ error: 'only "compile_agency_report" is supported here' }, { status: 400 });

  // Any real client workspace just to resolve the caller's own role/agency - reports are
  // agency-wide, not scoped to one client.
  const { data: memberships } = await supabase.from('workspace_members').select('workspace_id, workspaces!inner(kind)').eq('user_id', user.id).eq('workspaces.kind', 'agency').limit(1);
  const agencyWorkspaceId = memberships?.[0]?.workspace_id;
  if (!agencyWorkspaceId) return NextResponse.json({ error: 'no agency workspace found for this account yet' }, { status: 400 });
  const resolved = await resolveWorkspaceRole(supabase, user.id, agencyWorkspaceId);
  if (!resolved) return NextResponse.json({ error: 'you do not have access to your own agency workspace' }, { status: 403 });

  const [audits, leads, campaigns, healthIncidents] = await Promise.all([
    supabase.from('audit_runs').select('overall_score, category_scores').order('queued_at', { ascending: false }).limit(20),
    supabase.from('leads').select('status'),
    supabase.from('ad_campaigns').select('status'),
    supabase.from('health_incidents').select('id').is('closed_at', null),
  ]);

  const seoSection = await runAnalyticsAgent({
    task: 'summarize_seo_performance',
    auditRuns: (audits.data ?? []).map(r => ({ overallScore: r.overall_score, categoryScores: (r.category_scores as Record<string, number | null>) ?? {} })),
  });
  const leadsSection = await runAnalyticsAgent({ task: 'summarize_content_pipeline', drafts: (leads.data ?? []).map(l => ({ status: l.status })) });
  const campaignsSection = await runAnalyticsAgent({ task: 'summarize_content_pipeline', drafts: (campaigns.data ?? []).map(c => ({ status: c.status })) });

  const compiled = await runAnalyticsAgent({
    task: 'compile_report',
    sections: [
      { title: 'SEO/GEO Audits', summary: JSON.stringify(seoSection.output) },
      { title: 'Leads by Status', summary: JSON.stringify(leadsSection.output) },
      { title: 'Ad Campaigns by Status', summary: JSON.stringify(campaignsSection.output) },
      { title: 'Open Health Incidents', summary: String(healthIncidents.data?.length ?? 0) },
    ],
  });

  return NextResponse.json({
    report: compiled.output.report,
    seo: seoSection.output,
    leads: leadsSection.output,
    campaigns: campaignsSection.output,
    openIncidents: healthIncidents.data?.length ?? 0,
  });
}
