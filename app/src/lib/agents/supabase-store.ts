/**
 * Phase G.6 - the first real (Supabase-backed) AgentStore. Implements only what
 * generateCaptionText() (src/lib/agents/social/agent.ts) actually calls today:
 * findDefinition/createApprovalRequest (required by the AgentStore type; not on this call
 * path but implemented for real so future agent wiring can reuse this store unchanged),
 * getAiUsageCapStatus, recordAiUsage and recordAuditEvent.
 *
 * Uses the service-role client ONLY because ai_usage_log and audit_log have no insert grant
 * for `authenticated` on purpose (see supabase/migrations/20260929000600_staging_safety_
 * foundation.sql and 20260928000100_foundation_schema.sql) - a person's own browser session
 * must never be able to write its own AI-cost or audit record, or those safeguards would be
 * trivially bypassable. Every value written here is either supplied by already-verified
 * server-side logic (the caller's own resolved Principal) or a real Anthropic API response -
 * this store never lets a request body dictate who an action is attributed to.
 */

import { createServiceClient } from '@/lib/supabase/service';
import type { AuditEvent } from '@/lib/permissions';
import type { AgentDefinition, AgentStore } from './types';

export function createSupabaseAgentStore(): AgentStore {
  const supabase = createServiceClient();

  return {
    newId: () => crypto.randomUUID(),

    findDefinition: async (workspaceId, agentKey): Promise<AgentDefinition | null> => {
      const { data } = await supabase
        .from('agent_definitions')
        .select('id, workspace_id, agent_key, display_name, description, model, system_prompt, allowed_tools, enabled')
        .eq('workspace_id', workspaceId)
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

      const monthlyCostUsd = (monthRows.data ?? []).reduce((sum, row) => sum + Number(row.estimated_cost_usd), 0);
      return {
        dailyCallCap: settings.data?.ai_daily_call_cap ?? null,
        monthlyCostCapUsd: settings.data?.ai_monthly_cost_cap_usd ?? null,
        dailyCallCount: dailyCount.count ?? 0,
        monthlyCostUsd,
      };
    },

    recordAiUsage: async input => {
      const { error } = await supabase.from('ai_usage_log').insert({
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
      const { error } = await supabase.from('audit_log').insert({
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
  };
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
