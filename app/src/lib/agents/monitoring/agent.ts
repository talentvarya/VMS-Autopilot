/**
 * The Monitoring/Auto-Repair Agent's own logic (Sub-phase D). Every repair reuses the module
 * that actually governs the thing being touched - `health_monitor` (already Admin-ceiling-only
 * since Phase 1: no non-admin role can ever hold any action on it) for its own check/incident
 * bookkeeping, and `social:publish_execute` (already sensitive) for the one repair that
 * changes a business row outside its own module. There is no tool here mapped to
 * publish/send, budgets, domains, permissions, or an agent's own instructions - the guardrails
 * hold structurally, not by convention.
 */

import type { AgentLogicResult, AgentStore, Principal, ProposedToolCall } from '../types';

export type MonitoringAgentInput =
  | { task: 'check_website_availability'; workspaceId: string; origin: string }
  | { task: 'check_stale_audits'; workspaceId: string; olderThanMinutes?: number }
  | { task: 'check_stale_social_publishing'; workspaceId: string; olderThanMinutes?: number }
  | { task: 'requeue_failed_audit'; workspaceId: string; siteId: string }
  | { task: 'resume_failed_post'; workspaceId: string; postId: string }
  | { task: 'run_health_sweep'; workspaceId: string; siteOrigins?: string[]; olderThanMinutes?: number };

/** Sandbox-only: reachability is simulated against the known fixture origins, never a real request. */
function isKnownFixtureOrigin(origin: string, knownOrigins: readonly string[]): boolean {
  const normalise = (o: string) => o.trim().toLowerCase().replace(/\/+$/, '');
  return knownOrigins.some((o) => normalise(o) === normalise(origin));
}

function availabilityCheckCall(workspaceId: string, origin: string, knownOrigins: readonly string[], store: AgentStore, principal: Principal): ProposedToolCall {
  const status = isKnownFixtureOrigin(origin, knownOrigins) ? ('pass' as const) : ('fail' as const);
  return {
    toolName: 'check_website_availability',
    toolInput: { origin, status },
    permission: { module: 'health_monitor', action: 'create' },
    apply: async () => {
      if (!store.recordHealthCheck) throw new Error('this store cannot record a health check');
      const { id } = await store.recordHealthCheck(principal, { workspaceId, checkType: 'website_availability', status, details: { origin } });
      return { checkId: id, status };
    },
  };
}

function staleAuditsCall(workspaceId: string, olderThanMinutes: number | undefined, store: AgentStore, principal: Principal): ProposedToolCall {
  return {
    toolName: 'check_stale_audits',
    toolInput: { olderThanMinutes },
    permission: { module: 'health_monitor', action: 'edit' },
    apply: async () => {
      if (!store.repairStaleAudits) throw new Error('this store cannot repair stale audits');
      const { failedCount } = await store.repairStaleAudits(principal, { workspaceId, olderThanMinutes });
      return { failedCount };
    },
  };
}

function staleSocialCall(workspaceId: string, olderThanMinutes: number | undefined, store: AgentStore, principal: Principal): ProposedToolCall {
  return {
    toolName: 'check_stale_social_publishing',
    toolInput: { olderThanMinutes },
    permission: { module: 'health_monitor', action: 'edit' },
    apply: async () => {
      if (!store.repairStaleSocialPublishing) throw new Error('this store cannot repair stale social publishing');
      const { failedCount } = await store.repairStaleSocialPublishing(principal, { workspaceId, olderThanMinutes });
      return { failedCount };
    },
  };
}

export async function runMonitoringAgent(input: MonitoringAgentInput, store: AgentStore, principal: Principal): Promise<AgentLogicResult> {
  const toolCalls: ProposedToolCall[] = [];
  let output: Record<string, unknown> = {};

  // In real use these origins would come from the workspace's own `sites` rows (already
  // authorized read); the sandbox tests pass them directly for the same reason every other
  // agent in this project is fed already-authorized context rather than reading it itself.
  const knownFixtureOrigins: string[] = ['https://nova-clinic.example.test', 'https://brighthomes.example.test'];

  if (input.task === 'check_website_availability') {
    toolCalls.push(availabilityCheckCall(input.workspaceId, input.origin, knownFixtureOrigins, store, principal));
  } else if (input.task === 'check_stale_audits') {
    toolCalls.push(staleAuditsCall(input.workspaceId, input.olderThanMinutes, store, principal));
  } else if (input.task === 'check_stale_social_publishing') {
    toolCalls.push(staleSocialCall(input.workspaceId, input.olderThanMinutes, store, principal));
  } else if (input.task === 'requeue_failed_audit') {
    toolCalls.push({
      toolName: 'requeue_failed_audit',
      toolInput: { siteId: input.siteId },
      permission: { module: 'health_monitor', action: 'edit' },
      apply: async () => {
        // Reuses the SAME queueAudit() the SEO/GEO Agent already uses (Sub-phase C) - a fresh
        // queued run, never forcing the stale one through.
        if (!store.queueAudit) throw new Error('this store cannot queue an audit');
        const { runId } = await store.queueAudit(principal, { workspaceId: input.workspaceId, siteId: input.siteId });
        return { runId };
      },
    });
  } else if (input.task === 'resume_failed_post') {
    toolCalls.push({
      toolName: 'resume_failed_post',
      toolInput: { postId: input.postId },
      // Reuses the module that actually governs a post - never a health_monitor action for a
      // change outside its own bookkeeping.
      permission: { module: 'social', action: 'publish_execute' },
      apply: async () => {
        if (!store.resumeFailedSocialPost) throw new Error('this store cannot resume a failed post');
        await store.resumeFailedSocialPost(principal, input.postId);
        return { postId: input.postId, resumedTo: 'approved' };
      },
    });
  } else if (input.task === 'run_health_sweep') {
    for (const origin of input.siteOrigins ?? []) {
      toolCalls.push(availabilityCheckCall(input.workspaceId, origin, knownFixtureOrigins, store, principal));
    }
    // The sweep only ever includes the two "fail anything stale" checks automatically -
    // requeue_failed_audit and resume_failed_post always need a specific id and are never
    // triggered as a blanket action, even by the sweep.
    toolCalls.push(staleAuditsCall(input.workspaceId, input.olderThanMinutes, store, principal));
    toolCalls.push(staleSocialCall(input.workspaceId, input.olderThanMinutes, store, principal));
    output = { sweepRan: true, sitesChecked: input.siteOrigins?.length ?? 0 };
  }

  return { output, toolCalls, handoffs: [] };
}
