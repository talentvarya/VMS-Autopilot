/**
 * Phase G.6/G.7 - the real (Supabase-backed) AgentStore.
 *
 * Takes the CALLER's own RLS-scoped session client (src/lib/supabase/server.ts) and uses it
 * for every write that table's own grants already allow `authenticated` to make directly
 * (leads, ad_campaigns, ad_creatives, website_projects, health_checks, agent_definitions,
 * approval_requests all have real authenticated insert/update grants - see the "Privileges"
 * section of their migrations) - so every one of these writes goes through the database's own
 * RLS exactly as if the person had made it by hand, not through any elevated access.
 *
 * Only recordAiUsage/recordAuditEvent use the service-role client, because ai_usage_log and
 * audit_log deliberately have NO insert grant for `authenticated` at all (see
 * 20260929000600_staging_safety_foundation.sql / 20260928000100_foundation_schema.sql) - a
 * person's own browser session must never be able to write its own AI-cost or audit record, or
 * the cap those tables enforce would be trivially bypassable.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createServiceClient } from '@/lib/supabase/service';
import type { AuditEvent } from '@/lib/permissions';
import { runAudit } from '@/lib/seo/engine';
import { createSource } from '@/lib/seo/sources';
import type { AgentDefinition, AgentStore } from './types';

export function createSupabaseAgentStore(supabase: SupabaseClient): AgentStore {
  return {
    newId: () => crypto.randomUUID(),

    findDefinition: async (workspaceId, agentKey): Promise<AgentDefinition | null> => {
      // Definitions always live on the AGENCY workspace ("configured once, reused across
      // every client") - agent_definition_governs_workspace() in the database expresses the
      // same rule for its own trigger check, so a run against a CLIENT workspace must look at
      // that client's parent agency, not the client's own (nonexistent) definitions.
      const { data: workspace } = await supabase.from('workspaces').select('kind, parent_workspace_id').eq('id', workspaceId).maybeSingle();
      const definitionWorkspaceId = workspace?.kind === 'client' && workspace.parent_workspace_id ? workspace.parent_workspace_id : workspaceId;

      const { data } = await supabase
        .from('agent_definitions')
        .select('id, workspace_id, agent_key, display_name, description, model, system_prompt, allowed_tools, enabled')
        .eq('workspace_id', definitionWorkspaceId)
        .eq('agent_key', agentKey)
        .maybeSingle();
      if (!data) return null;
      return {
        id: data.id,
        workspaceId: data.workspace_id,
        agentKey: data.agent_key,
        displayName: data.display_name,
        description: data.description,
        model: data.model,
        systemPrompt: data.system_prompt,
        allowedTools: (data.allowed_tools as string[]) ?? [],
        enabled: data.enabled,
      };
    },

    createApprovalRequest: async input => {
      const { data, error } = await supabase
        .from('approval_requests')
        .insert({
          workspace_id: input.workspaceId,
          requested_by: input.requestedBy,
          module: input.module,
          action: input.action,
          title: input.title,
          details: input.details,
        })
        .select('id')
        .single();
      if (error) throw error;
      return { id: data.id };
    },

    getAiUsageCapStatus: async workspaceId => {
      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);
      const startOfMonth = new Date();
      startOfMonth.setUTCDate(1);
      startOfMonth.setUTCHours(0, 0, 0, 0);

      const [settings, dailyCount, monthRows] = await Promise.all([
        supabase.from('workspace_settings').select('ai_daily_call_cap, ai_monthly_cost_cap_usd').eq('workspace_id', workspaceId).maybeSingle(),
        supabase.from('ai_usage_log').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId).gte('created_at', startOfDay.toISOString()),
        supabase.from('ai_usage_log').select('estimated_cost_usd').eq('workspace_id', workspaceId).gte('created_at', startOfMonth.toISOString()),
      ]);

      const monthlyCostUsd = (monthRows.data ?? []).reduce((sum: number, row: { estimated_cost_usd: number }) => sum + Number(row.estimated_cost_usd), 0);
      return {
        dailyCallCap: settings.data?.ai_daily_call_cap ?? null,
        monthlyCostCapUsd: settings.data?.ai_monthly_cost_cap_usd ?? null,
        dailyCallCount: dailyCount.count ?? 0,
        monthlyCostUsd,
      };
    },

    recordAiUsage: async input => {
      const service = createServiceClient();
      const { error } = await service.from('ai_usage_log').insert({
        workspace_id: input.workspaceId,
        agent_run_id: input.agentRunId ?? null,
        provider: input.provider,
        model: input.model,
        input_tokens: input.inputTokens,
        output_tokens: input.outputTokens,
        estimated_cost_usd: input.estimatedCostUsd,
      });
      if (error) throw error;
    },

    recordAuditEvent: async (event: AuditEvent) => {
      const service = createServiceClient();
      const { error } = await service.from('audit_log').insert({
        actor_id: event.actorId,
        actor_role: event.actorRole,
        workspace_id: event.workspaceId,
        module: event.module,
        action: event.action,
        target_type: event.targetType ?? null,
        target_id: event.targetId ?? null,
        result: event.result,
        approval_id: event.approvalId ?? null,
        approval_status: event.approvalStatus ?? null,
        metadata: event.metadata ?? {},
      });
      if (error) throw error;
    },

    // ---------- Leads/CRM Agent ----------------------------------------------------------

    captureLead: async (_principal, input) => {
      const { data, error } = await supabase
        .from('leads')
        .insert({
          workspace_id: input.workspaceId,
          source: input.source,
          name: input.name ?? null,
          contact: input.contact ?? null,
          notes: input.notes ?? null,
          source_interaction_id: input.sourceInteractionId ?? null,
          drafted_by_agent: true,
        })
        .select('id')
        .single();
      if (error) throw error;
      return { id: data.id };
    },

    captureLeadFromInteraction: async (_principal, input) => {
      const { data: existing } = await supabase.from('leads').select('id').eq('source_interaction_id', input.interactionId).maybeSingle();
      if (existing) return { id: existing.id, created: false };
      const { data, error } = await supabase
        .from('leads')
        .insert({
          workspace_id: input.workspaceId,
          source: 'social_dm',
          contact: input.extractedContact ?? null,
          source_interaction_id: input.interactionId,
          drafted_by_agent: true,
        })
        .select('id')
        .single();
      if (error) throw error;
      return { id: data.id, created: true };
    },

    qualifyLead: async (_principal, input) => {
      const { error } = await supabase.from('leads').update({ status: input.status }).eq('id', input.leadId);
      if (error) throw error;
    },

    draftFollowUp: async (_principal, input) => {
      const { data, error } = await supabase
        .from('lead_activities')
        .insert({ lead_id: input.leadId, workspace_id: input.workspaceId, kind: 'follow_up_drafted', body: input.body, drafted_by_agent: true })
        .select('id')
        .single();
      if (error) throw error;
      return { id: data.id };
    },

    // ---------- Paid Ads Agent ------------------------------------------------------------

    draftCampaign: async (_principal, input) => {
      const { data, error } = await supabase
        .from('ad_campaigns')
        .insert({
          workspace_id: input.workspaceId,
          audience_brief_id: input.audienceBriefId ?? null,
          platform: input.platform,
          objective: input.objective,
          name: input.name,
          budget_amount: input.budgetAmount ?? null,
          budget_period: input.budgetPeriod ?? null,
          drafted_by_agent: true,
        })
        .select('id')
        .single();
      if (error) throw error;
      if (input.creatives && input.creatives.length > 0) {
        const { error: creativesError } = await supabase.from('ad_creatives').insert(
          input.creatives.map(c => ({
            campaign_id: data.id,
            workspace_id: input.workspaceId,
            headline: c.headline,
            body: c.body,
            call_to_action: c.callToAction ?? null,
            image_ref: c.imageRef ?? null,
          })),
        );
        if (creativesError) throw creativesError;
      }
      return { id: data.id };
    },

    submitCampaignForReview: async (_principal, campaignId) => {
      const { error } = await supabase.from('ad_campaigns').update({ status: 'in_review' }).eq('id', campaignId);
      if (error) throw error;
    },

    updateCampaignBudget: async (_principal, input) => {
      const { error } = await supabase
        .from('ad_campaigns')
        .update({ budget_amount: input.budgetAmount, budget_period: input.budgetPeriod })
        .eq('id', input.campaignId);
      if (error) throw error;
    },

    // ---------- Website/Domain Agent -------------------------------------------------------

    draftWebsitePlan: async (_principal, input) => {
      const { data, error } = await supabase
        .from('website_projects')
        .insert({ workspace_id: input.workspaceId, provider: input.provider, title: input.title, pages: input.pages, drafted_by_agent: true })
        .select('id')
        .single();
      if (error) throw error;
      return { id: data.id };
    },

    submitWebsitePlanForReview: async (_principal, projectId) => {
      const { error } = await supabase.from('website_projects').update({ status: 'in_review' }).eq('id', projectId);
      if (error) throw error;
    },

    // ---------- Monitoring Agent (record only - see AI Monitor tab for the rest) -----------

    recordHealthCheck: async (_principal, input) => {
      const { data, error } = await supabase
        .from('health_checks')
        .insert({ workspace_id: input.workspaceId, check_type: input.checkType, status: input.status, details: input.details ?? {} })
        .select('id')
        .single();
      if (error) throw error;
      return { id: data.id };
    },

    /** Reimplements failStaleRuns()/failStalePublishing() (src/lib/seo/run-audit.ts,
     * src/lib/social/publish-worker.ts) using the service client's own query builder instead
     * of their raw-SQL Queryable interface - this app has no direct Postgres connection
     * string, only the Supabase REST API, so a supabase-js update() achieves the identical
     * effect (same status transition, same cutoff) without one. Service-role because these are
     * cross-workspace maintenance sweeps, not a single row a normal session would touch. */
    repairStaleAudits: async (_principal, input) => {
      const service = createServiceClient();
      const cutoff = new Date(Date.now() - (input.olderThanMinutes ?? 15) * 60_000).toISOString();
      const { data, error } = await service
        .from('audit_runs')
        .update({ status: 'failed', error: 'The audit took too long and was stopped.' })
        .eq('status', 'running')
        .lt('started_at', cutoff)
        .select('id');
      if (error) throw error;
      return { failedCount: data?.length ?? 0 };
    },

    repairStaleSocialPublishing: async (_principal, input) => {
      const service = createServiceClient();
      const cutoff = new Date(Date.now() - (input.olderThanMinutes ?? 15) * 60_000).toISOString();
      const { data, error } = await service
        .from('social_posts')
        .update({ status: 'failed', last_error: 'We could not confirm whether this was published. Please check the channel before trying again.' })
        .eq('status', 'publishing')
        .lt('updated_at', cutoff)
        .select('id');
      if (error) throw error;
      return { failedCount: data?.length ?? 0 };
    },

    resumeFailedSocialPost: async (_principal, postId) => {
      const { error } = await supabase.from('social_posts').update({ status: 'approved' }).eq('id', postId).eq('status', 'failed');
      if (error) throw error;
    },

    // ---------- SEO/GEO Agent --------------------------------------------------------------
    // Sandbox-only (createSource('fixture')) - the exact same safety boundary the SEO/GEO Audit
    // page's own direct engine call already respects. Real website audits stay switched off
    // (src/lib/seo/sources.ts, LIVE_AUDITS_ENABLED) until that is separately reviewed.

    queueAudit: async (_principal, input) => {
      const service = createServiceClient();

      const { data: site, error: siteError } = await service.from('sites').select('origin, business_type').eq('id', input.siteId).maybeSingle();
      if (siteError) throw siteError;
      if (!site) throw new Error('that site was not found');

      const { data: run, error: insertError } = await service
        .from('audit_runs')
        .insert({ workspace_id: input.workspaceId, site_id: input.siteId })
        .select('id')
        .single();
      if (insertError) throw insertError;

      const { data: claimed } = await service.from('audit_runs').update({ status: 'running', started_at: new Date().toISOString() }).eq('id', run.id).eq('status', 'queued').select('id');
      if (!claimed || claimed.length === 0) return { runId: run.id };

      try {
        const snapshot = await createSource('fixture').getSnapshot(site.origin);
        const result = runAudit(snapshot, { businessType: site.business_type as 'local' | 'online' });
        if (result.findings.length > 0) {
          const { error: findingsError } = await service.from('audit_findings').insert(
            result.findings.map(f => ({
              run_id: run.id,
              workspace_id: input.workspaceId,
              category: f.category,
              severity: f.severity,
              code: f.code,
              title: f.title,
              evidence: f.evidence,
              recommendation: f.recommendation,
            })),
          );
          if (findingsError) throw findingsError;
        }
        await service
          .from('audit_runs')
          .update({
            status: 'completed',
            finished_at: new Date().toISOString(),
            engine_version: result.engineVersion,
            overall_score: result.overallScore,
            overall_note: result.overallNote,
            category_scores: result.categoryScores,
            counts: result.counts,
          })
          .eq('id', run.id);
      } catch {
        await service.from('audit_runs').update({ status: 'failed', finished_at: new Date().toISOString(), error: 'The audit could not be completed. Please try again, or ask your agency.' }).eq('id', run.id);
      }
      return { runId: run.id };
    },

    proposeFix: async (_principal, input) => {
      const { error } = await supabase.from('audit_findings').update({ fix_status: 'applied', fix_note: input.note ?? null }).eq('id', input.findingId);
      if (error) throw error;
    },

    // ---------- Content Agent ---------------------------------------------------------------

    createContentDraft: async (_principal, input) => {
      const { data, error } = await supabase
        .from('content_drafts')
        .insert({ workspace_id: input.workspaceId, title: input.title, body: input.body, source_finding_id: input.sourceFindingId ?? null, drafted_by_agent: input.draftedByAgent })
        .select('id')
        .single();
      if (error) throw error;
      return { id: data.id };
    },

    submitContentDraftForReview: async (_principal, draftId) => {
      const { error } = await supabase.from('content_drafts').update({ status: 'in_review' }).eq('id', draftId);
      if (error) throw error;
    },

    // ---------- Ads Audience Agent -----------------------------------------------------------

    finalizeAudienceBrief: async (_principal, input) => {
      const { data, error } = await supabase
        .from('ad_audience_briefs')
        .insert({
          workspace_id: input.workspaceId,
          business_profile: input.businessProfile,
          platform: input.platform,
          hypotheses: input.hypotheses,
          segments: input.segments,
          recommended_objective: input.recommendedObjective,
          recommended_offer: input.recommendedOffer,
          conversion_signals: input.conversionSignals ?? {},
        })
        .select('id, version')
        .single();
      if (error) throw error;
      // finalize immediately (draft -> final) - a second update, since insert always lands as
      // 'draft' first (the table's own before-trigger enforces this).
      const { error: finalizeError } = await supabase.from('ad_audience_briefs').update({ status: 'final' }).eq('id', data.id);
      if (finalizeError) throw finalizeError;
      return { id: data.id, version: data.version };
    },
  };
}

/**
 * Auto-provisions an enabled agent_definitions row for this workspace + agent, the first time
 * it is used - so a fresh account can use an agent immediately instead of needing a manual
 * setup step. Never changes an existing row (a definition someone has since edited - a
 * different display name, a narrower allowedTools list - is left exactly as they set it).
 */
export async function ensureAgentDefinition(
  supabase: SupabaseClient,
  workspaceId: string,
  agentKey: string,
  displayName: string,
  allowedTools: readonly string[],
): Promise<void> {
  const { data } = await supabase.from('agent_definitions').select('id').eq('workspace_id', workspaceId).eq('agent_key', agentKey).maybeSingle();
  if (data) return;
  const { error } = await supabase.from('agent_definitions').insert({
    workspace_id: workspaceId,
    agent_key: agentKey,
    display_name: displayName,
    model: 'scripted',
    allowed_tools: allowedTools,
    enabled: true,
  });
  // A unique-constraint race (two requests provisioning at once) is fine to ignore - either
  // way a row now exists.
  if (error && error.code !== '23505') throw error;
}

/** A safe first-time default - mirrors the "5 daily calls, $1 monthly" cap approved for this
 * project's own staging AI verification earlier. Only ever writes when a cap is not already
 * set (never silently loosens a cap someone has since tightened or raised on purpose). */
export async function ensureAiUsageCapDefaults(workspaceId: string): Promise<void> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from('workspace_settings')
    .select('ai_daily_call_cap, ai_monthly_cost_cap_usd')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (!data) return;
  const update: Record<string, number> = {};
  if (data.ai_daily_call_cap == null) update.ai_daily_call_cap = 5;
  if (data.ai_monthly_cost_cap_usd == null) update.ai_monthly_cost_cap_usd = 1;
  if (Object.keys(update).length === 0) return;
  await supabase.from('workspace_settings').update(update).eq('workspace_id', workspaceId);
}
