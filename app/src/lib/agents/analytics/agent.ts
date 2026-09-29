/**
 * The Analytics/Reporting Agent's own logic (Sub-phase D). Read-only, ALWAYS - not by
 * convention but structurally: this function does not even receive an AgentStore or a
 * Principal, so it is physically incapable of writing anything or proposing a permission
 * decision that could ever become an approval. Every tool call it produces either has no
 * `permission` at all reasons requires none, and none of them ever set an `apply()`.
 *
 * Every task is fed already-fetched, already-authorized data - the caller (whoever invokes
 * this agent) is responsible for having confirmed the requesting principal can already see
 * that data, exactly like every other read in this project. This agent never queries the
 * database itself.
 */

import type { AgentLogicResult, ProposedToolCall } from '../types';

export interface SeoPerformancePoint {
  overallScore: number | null;
  categoryScores: Record<string, number | null>;
}
export interface SocialActivityPost {
  status: string;
  network: string;
}
export interface ContentPipelineDraft {
  status: string;
}
export interface AgentActivityRun {
  agentKey: string;
  status: string;
}
export interface ReportSection {
  title: string;
  summary: string;
}

export type AnalyticsAgentTaskInput =
  | { task: 'summarize_seo_performance'; auditRuns: SeoPerformancePoint[] }
  | { task: 'summarize_social_activity'; posts: SocialActivityPost[]; metric?: string; dateRange?: string; channelIds?: string[] }
  | { task: 'summarize_content_pipeline'; drafts: ContentPipelineDraft[] }
  | { task: 'summarize_agent_activity'; runs: AgentActivityRun[] }
  | { task: 'compile_report'; sections: ReportSection[] };

/**
 * Sub-phase B's `request_analytics` handoff (`{metric, dateRange, channelIds}`) was written
 * before this agent existed, so it carries no `task` field. This is the ONE, narrowly-scoped
 * compatibility rule for it - approved explicitly, not a general "guess the task" fallback:
 *   - only applies when task is absent and `metric` is a string (the shape nothing else uses);
 *   - metric, dateRange and channelIds are all REQUIRED - a payload missing any of them is
 *     rejected, not silently patched;
 *   - maps to summarize_social_activity, nothing else.
 * Anything else that doesn't match a known task, or a known-task object with the wrong shape,
 * is rejected outright.
 */
function normalizeInput(raw: unknown): AnalyticsAgentTaskInput {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('the Analytics Agent needs an object as input');
  }
  const input = raw as Record<string, unknown>;

  if (input.task === undefined) {
    if (typeof input.metric !== 'string') {
      throw new Error('input has no "task" and is not a recognizable request_analytics handoff (needs a string "metric")');
    }
    if (typeof input.dateRange !== 'string' || !Array.isArray(input.channelIds)) {
      throw new Error('a legacy request_analytics handoff needs metric, dateRange and channelIds - one or more is missing');
    }
    return {
      task: 'summarize_social_activity',
      metric: input.metric,
      dateRange: input.dateRange,
      channelIds: input.channelIds as string[],
      posts: Array.isArray(input.posts) ? (input.posts as SocialActivityPost[]) : [],
    };
  }

  switch (input.task) {
    case 'summarize_seo_performance':
      if (!Array.isArray(input.auditRuns)) throw new Error('summarize_seo_performance needs an "auditRuns" array');
      return { task: 'summarize_seo_performance', auditRuns: input.auditRuns as SeoPerformancePoint[] };
    case 'summarize_social_activity':
      if (!Array.isArray(input.posts)) throw new Error('summarize_social_activity needs a "posts" array');
      return { task: 'summarize_social_activity', posts: input.posts as SocialActivityPost[], metric: input.metric as string | undefined, dateRange: input.dateRange as string | undefined, channelIds: input.channelIds as string[] | undefined };
    case 'summarize_content_pipeline':
      if (!Array.isArray(input.drafts)) throw new Error('summarize_content_pipeline needs a "drafts" array');
      return { task: 'summarize_content_pipeline', drafts: input.drafts as ContentPipelineDraft[] };
    case 'summarize_agent_activity':
      if (!Array.isArray(input.runs)) throw new Error('summarize_agent_activity needs a "runs" array');
      return { task: 'summarize_agent_activity', runs: input.runs as AgentActivityRun[] };
    case 'compile_report':
      if (!Array.isArray(input.sections)) throw new Error('compile_report needs a "sections" array');
      return { task: 'compile_report', sections: input.sections as ReportSection[] };
    default:
      throw new Error(`unknown Analytics Agent task: "${String(input.task)}"`);
  }
}

function count<T extends string>(items: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[item] = (out[item] ?? 0) + 1;
  return out;
}

export async function runAnalyticsAgent(rawInput: unknown): Promise<AgentLogicResult> {
  const input = normalizeInput(rawInput);
  const toolCalls: ProposedToolCall[] = [];
  let output: Record<string, unknown> = {};

  if (input.task === 'summarize_seo_performance') {
    const scores = input.auditRuns.map((r) => r.overallScore).filter((s): s is number => s !== null);
    const average = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
    toolCalls.push({ toolName: 'summarize_seo_performance', toolInput: { runCount: input.auditRuns.length }, permission: { module: 'reports', action: 'view' } });
    output = { averageScore: average, runCount: input.auditRuns.length, latest: input.auditRuns.at(-1) ?? null };
  } else if (input.task === 'summarize_social_activity') {
    toolCalls.push({ toolName: 'summarize_social_activity', toolInput: { postCount: input.posts.length, metric: input.metric, dateRange: input.dateRange, channelIds: input.channelIds }, permission: { module: 'reports', action: 'view' } });
    output = { byStatus: count(input.posts.map((p) => p.status)), byNetwork: count(input.posts.map((p) => p.network)), total: input.posts.length };
  } else if (input.task === 'summarize_content_pipeline') {
    toolCalls.push({ toolName: 'summarize_content_pipeline', toolInput: { draftCount: input.drafts.length }, permission: { module: 'reports', action: 'view' } });
    output = { byStatus: count(input.drafts.map((d) => d.status)), total: input.drafts.length };
  } else if (input.task === 'summarize_agent_activity') {
    toolCalls.push({ toolName: 'summarize_agent_activity', toolInput: { runCount: input.runs.length }, permission: { module: 'reports', action: 'view' } });
    output = { byAgent: count(input.runs.map((r) => r.agentKey)), byStatus: count(input.runs.map((r) => r.status)), total: input.runs.length };
  } else if (input.task === 'compile_report') {
    toolCalls.push({ toolName: 'compile_report', toolInput: { sectionCount: input.sections.length }, permission: { module: 'reports', action: 'view' } });
    output = { report: input.sections.map((s) => `## ${s.title}\n${s.summary}`).join('\n\n') };
  }

  return { output, toolCalls, handoffs: [] };
}
