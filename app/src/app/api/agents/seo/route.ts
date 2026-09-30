/**
 * Phase G.9 (fixture sites) + Phase G.16 (real websites) - the SEO/GEO Agent wired for real.
 *
 * queue_audit needs a `sites` row (workspace_id, origin, label, business_type, source) - this
 * route auto-creates or reuses one, in one of two ways:
 *   - `fixtureSite`: one of the 3 built-in sample sites (source='fixture', unchanged since G.9).
 *   - `useRealWebsite: true`: the caller's client workspace's own `website_url` (source='live') -
 *     validated again here with assertSafeUrl (defense in depth; the audit engine's own fetcher,
 *     live-fetch.ts, validates and DNS-pins it a second time before ever connecting).
 */

import { NextResponse } from 'next/server';
import { dbErrorResponse } from '@/lib/api/errors';
import { createClient } from '@/lib/supabase/server';
import { runAgent } from '@/lib/agents/orchestrator';
import { createSupabaseAgentStore, ensureAgentDefinition } from '@/lib/agents/supabase-store';
import { resolveWorkspaceRole } from '@/lib/agents/resolve-principal';
import { FIXTURE_SITES } from '@/lib/seo/fixtures';
import { UnsafeUrlError, assertSafeUrl } from '@/lib/seo/safe-url';

const AGENT_KEY = 'seo_geo_agent';
const ALLOWED_TOOLS = ['queue_audit', 'explain_findings', 'propose_fix', 'content_brief_handoff'];

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : '';
  const task = body?.task;
  if (!workspaceId || !task) return NextResponse.json({ error: 'workspaceId and task are required' }, { status: 400 });

  const resolved = await resolveWorkspaceRole(supabase, user.id, workspaceId);
  if (!resolved) return NextResponse.json({ error: 'you do not have access to that client' }, { status: 403 });

  await ensureAgentDefinition(supabase, resolved.agencyWorkspaceId, AGENT_KEY, 'SEO/GEO Agent', ALLOWED_TOOLS);

  let input = body;
  if (task === 'queue_audit' && !body.siteId) {
    if (body.useRealWebsite === true) {
      const { data: workspace, error: workspaceError } = await supabase.from('workspaces').select('name, website_url').eq('id', workspaceId).maybeSingle();
      if (workspaceError) return dbErrorResponse(workspaceError);
      if (!workspace?.website_url) return NextResponse.json({ error: 'this client has no website URL saved yet - add one on the Clients page first' }, { status: 400 });

      let origin: string;
      try {
        origin = assertSafeUrl(workspace.website_url).origin;
      } catch (err) {
        return NextResponse.json({ error: err instanceof UnsafeUrlError ? `this client's saved website address is not safe to audit: ${err.reason}` : 'this client\'s saved website address is invalid' }, { status: 400 });
      }

      const businessType = body.businessType === 'online' ? 'online' : 'local';
      const { data: existingSite } = await supabase.from('sites').select('id').eq('workspace_id', workspaceId).eq('origin', origin).maybeSingle();
      let siteId = existingSite?.id as string | undefined;
      if (!siteId) {
        const { data: newSite, error: siteError } = await supabase
          .from('sites')
          .insert({ workspace_id: workspaceId, origin, label: workspace.name, business_type: businessType, source: 'live' })
          .select('id')
          .single();
        if (siteError) return dbErrorResponse(siteError);
        siteId = newSite.id;
      }
      input = { ...body, siteId };
    } else {
      const fixtureKey = typeof body.fixtureSite === 'string' ? body.fixtureSite : '';
      const fixture = FIXTURE_SITES.find(s => s.id === fixtureKey);
      if (!fixture) return NextResponse.json({ error: 'fixtureSite must be one of the sample sites, or set useRealWebsite: true' }, { status: 400 });

      const { data: existingSite } = await supabase.from('sites').select('id').eq('workspace_id', workspaceId).eq('origin', fixture.origin).maybeSingle();
      let siteId = existingSite?.id as string | undefined;
      if (!siteId) {
        const { data: newSite, error: siteError } = await supabase
          .from('sites')
          .insert({ workspace_id: workspaceId, origin: fixture.origin, label: fixture.label, business_type: fixture.businessType })
          .select('id')
          .single();
        if (siteError) return dbErrorResponse(siteError);
        siteId = newSite.id;
      }
      input = { ...body, siteId };
    }
  }

  const store = createSupabaseAgentStore(supabase);
  const outcome = await runAgent(store, { id: user.id, role: resolved.role, grants: [] }, {
    workspaceId,
    agentKey: AGENT_KEY,
    triggeredByKind: 'user',
    input,
  });

  if (!outcome.ok) return NextResponse.json({ error: outcome.reason }, { status: 400 });
  if (outcome.run.status === 'failed') {
    const firstError = outcome.run.toolCalls.find(c => c.applyError || c.decision === 'deny');
    return NextResponse.json({ error: firstError?.applyError ?? 'that action was refused' }, { status: 400 });
  }

  // For queue_audit, also hand back the completed run's own results (score, findings) so the
  // UI doesn't need a second round trip to show anything.
  let run: unknown = null;
  const runId = (outcome.run.toolCalls[0]?.toolOutput as { runId?: string } | null)?.runId;
  if (runId) {
    const { data } = await supabase.from('audit_runs').select('id, status, overall_score, overall_note, category_scores, counts, error').eq('id', runId).maybeSingle();
    run = data;
  }

  return NextResponse.json({ status: outcome.run.status, output: outcome.run.output, run });
}
