/**
 * VMS Autopilot Runtime-Agent Phase, Sub-phase A - shared vocabulary.
 *
 * Mirrors the tables and check constraints in
 * supabase/migrations/20260929000100_agents_foundation.sql. Nothing here calls any AI
 * provider, holds any key, or reaches any network - see echo-agent.ts for the one
 * (scripted, deterministic) agent that exists so far.
 */

import type { Action, Module } from '@/lib/permissions';

export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'needs_approval', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TRIGGERED_BY_KINDS = ['user', 'system', 'agent'] as const;
export type TriggeredByKind = (typeof TRIGGERED_BY_KINDS)[number];

export const TOOL_DECISIONS = ['allow', 'deny', 'needs_approval'] as const;
export type ToolDecision = (typeof TOOL_DECISIONS)[number];

/** Always sits on an AGENCY workspace - configured once, reused across that agency's clients. */
export interface AgentDefinition {
  id: string;
  workspaceId: string;
  agentKey: string;
  displayName: string;
  description: string | null;
  model: string;
  systemPrompt: string;
  allowedTools: readonly string[];
  enabled: boolean;
}

export interface AgentRun {
  id: string;
  workspaceId: string;
  agentDefinitionId: string | null;
  agentKey: string;
  triggeredBy: string | null;
  triggeredByKind: TriggeredByKind;
  status: RunStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  errorMessage: string | null;
}

/** What an agent's own logic proposes. A pure utility tool (nothing sensitive) omits `permission`. */
export interface ProposedToolCall {
  toolName: string;
  toolInput: Record<string, unknown>;
  permission?: { module: Module; action: Action };
}

/** A tool call after the Orchestrator has decided it. */
export interface ResolvedToolCall extends ProposedToolCall {
  toolOutput: Record<string, unknown> | null;
  decision: ToolDecision | null;
  onBehalfOf: string | null;
  approvalId?: string | null;
}

export interface Handoff {
  toAgentKey: string;
  payload: Record<string, unknown>;
}

/** What a scripted or (later) real agent hands back to the Orchestrator for one run. */
export interface AgentLogicResult {
  output: Record<string, unknown>;
  toolCalls: ProposedToolCall[];
  handoffs: Handoff[];
}
