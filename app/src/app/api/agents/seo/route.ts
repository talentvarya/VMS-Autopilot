/**
 * Phase G.9 - the SEO/GEO Agent wired for real, through the SAME sandbox fixture engine the
 * SEO/GEO Audit page's own direct call already uses (lib/seo/engine.ts + fixtures) - never a
 * real website (lib/seo/sources.ts's LIVE_AUDITS_ENABLED stays false; see the safety test that
 * scans this folder for network code, tests/seo/safety.test.ts).
 *
 * queue_audit needs a `sites` row (workspace_id, origin, label, business_type) - this route
 * auto-creates or reuses one, restricted to a fixed set of known-fixture origins so this can
 * never be pointed at a real website.
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { runAgent } from '@/lib/agents/orchestrator';
import { createSupabaseAgentStore, ensureAgentDefinition } from '@/lib/agents/supabase-store';
import { resolveWorkspaceRole } from '@/lib/agents/resolve-principal';
import { FIXTURE_SITES } from '@/lib/seo/fixtures';

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
    const fixtureKey = typeof body.fixtureSite === 'string' ? body.fixtureSite : '';
    const fixture = FIXTURE_SITES.find(s => s.id === fixtureKey);
    if (!fixture) return NextResponse.json({ error: 'fixtureSite must be one of the sample sites' }, { status: 400 });

    const { data: existingSite } = await supabase.from('sites').select('id').eq('workspace_id', workspaceId).eq('origin', fixture.origin).maybeSingle();
    let siteId = existingSite?.id as string | undefined;
    if (!siteId) {
      const { data: newSite, error: siteError } = await supabase
        .from('sites')
        .insert({ workspace_id: workspaceId, origin: fixture.origin, label: fixture.label, business_type: fixture.businessType })
        .select('id')
        .single();
      if (siteError) return NextResponse.json({ error: siteError.message }, { status: 400 });
      siteId = newSite.id;
    }
    input = { ...body, siteId };
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
