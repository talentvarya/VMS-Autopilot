/**
 * The SEO/GEO Agent's own logic (Sub-phase C). Operates ENTIRELY through Phase 2's own,
 * unmodified sites/audit_runs/audit_findings tables and its executeAuditRun() function - this
 * agent has no schema of its own at all. One task per run.
 */

import type { Finding } from '@/lib/seo/types';
import type { Network } from '@/lib/social/types';
import type { AgentLogicResult, AgentStore, Handoff, Principal, ProposedToolCall } from '../types';

export type SeoGeoAgentInput =
  | { task: 'queue_audit'; workspaceId: string; siteId: string }
  | { task: 'explain_findings'; findings: Finding[] }
  | { task: 'propose_fix'; workspaceId: string; findingId: string; note?: string }
  | {
      task: 'content_brief_handoff';
      workspaceId: string;
      findingId: string;
      title: string;
      topic: string;
      /** Only ever set by the ORIGINAL caller's own explicit request - never decided in here. */
      alsoRepurposeToSocial?: boolean;
      repurposeChannels?: { channelId: string; network: Network }[];
    };

function plainLanguageSummary(findings: Finding[]): string {
  if (findings.length === 0) return 'No findings to report.';
  const count = (level: string) => findings.filter((f) => f.severity === level).length;
  const critical = count('critical');
  const high = count('high');
  const parts: string[] = [];
  if (critical > 0) parts.push(`${critical} critical issue${critical === 1 ? '' : 's'} that need attention first`);
  if (high > 0) parts.push(`${high} high-priority issue${high === 1 ? '' : 's'}`);
  if (parts.length === 0) return 'Nothing urgent was found - a few smaller improvements are listed for later.';
  return `Found ${parts.join(' and ')}.`;
}

export async function runSeoGeoAgent(input: SeoGeoAgentInput, store: AgentStore, principal: Principal): Promise<AgentLogicResult> {
  const toolCalls: ProposedToolCall[] = [];
  const handoffs: Handoff[] = [];
  let output: Record<string, unknown> = {};

  if (input.task === 'queue_audit') {
    toolCalls.push({
      toolName: 'queue_audit',
      toolInput: { siteId: input.siteId },
      permission: { module: 'seo_geo', action: 'create' },
      apply: async () => {
        if (!store.queueAudit) throw new Error('this store cannot queue an audit');
        const { runId } = await store.queueAudit(principal, { workspaceId: input.workspaceId, siteId: input.siteId });
        return { runId };
      },
    });
  } else if (input.task === 'explain_findings') {
    toolCalls.push({ toolName: 'explain_findings', toolInput: { findingCount: input.findings.length } });
    output = { summary: plainLanguageSummary(input.findings) };
  } else if (input.task === 'propose_fix') {
    toolCalls.push({
      toolName: 'propose_fix',
      toolInput: { findingId: input.findingId, note: input.note },
      permission: { module: 'seo_geo', action: 'publish_execute' },
      apply: async () => {
        if (!store.proposeFix) throw new Error('this store cannot record a fix');
        await store.proposeFix(principal, { workspaceId: input.workspaceId, findingId: input.findingId, note: input.note });
        return { findingId: input.findingId, fixed: true };
      },
    });
  } else if (input.task === 'content_brief_handoff') {
    handoffs.push({
      toAgentKey: 'content_agent',
      payload: {
        task: 'draft_article',
        workspaceId: input.workspaceId,
        title: input.title,
        topic: input.topic,
        sourceFindingId: input.findingId,
        alsoRepurposeToSocial: input.alsoRepurposeToSocial,
        repurposeChannels: input.repurposeChannels,
      },
    });
    output = { handedOff: true };
  }

  return { output, toolCalls, handoffs };
}
