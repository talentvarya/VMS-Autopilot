/**
 * VMS Autopilot Runtime-Agent Phase, Sub-phase A - shared vocabulary.
 *
 * Mirrors the tables and check constraints in
 * supabase/migrations/20260929000100_agents_foundation.sql. Nothing here calls any AI
 * provider, holds any key, or reaches any network - see echo-agent.ts for the one
 * (scripted, deterministic) agent that exists so far.
 */

import type { Action, Grant, Module, Role } from '@/lib/permissions';
import type { Network } from '@/lib/social/types';
import type { BrandVoiceProfile } from './social/types';

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
  /**
   * Optional: what to actually do once the Orchestrator has confirmed this call is allowed
   * (or, for a call with no `permission`, unconditionally). Only defined by agent logic that
   * needs to persist something real (e.g. the Social Media Super Agent's draft_post) - Sub-phase
   * A's own tools never set this, and their behaviour is completely unchanged by its existence.
   */
  apply?: () => Promise<Record<string, unknown>>;
}

/** A tool call after the Orchestrator has decided it. */
export interface ResolvedToolCall extends ProposedToolCall {
  toolOutput: Record<string, unknown> | null;
  decision: ToolDecision | null;
  onBehalfOf: string | null;
  approvalId?: string | null;
  /** Set only if `apply()` was called and threw - the tool was allowed but doing it failed. */
  applyError?: string;
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

// ---------------------------------------------------------------------------------------
// The Orchestrator's own contracts (kept here, not in orchestrator.ts, so agent logic
// modules - e.g. social/agent.ts - can depend on them without importing orchestrator.ts
// itself and creating a circular import).
// ---------------------------------------------------------------------------------------

/** The human (or system) this run is acting on behalf of. An agent never outranks this person. */
export interface Principal {
  id: string;
  role: Role;
  grants: readonly Grant[];
}

export interface RunRequest {
  workspaceId: string;
  agentKey: string;
  triggeredByKind: 'user' | 'system' | 'agent';
  input: Record<string, unknown>;
}

export interface ApprovalRequestInput {
  workspaceId: string;
  requestedBy: string;
  module: string;
  action: string;
  title: string;
  details: Record<string, unknown>;
}

export interface CreateSocialPostInput {
  workspaceId: string;
  channelId: string;
  body: string;
  imageAlt?: string | null;
  groupId?: string | null;
}

export interface CreateSocialReplyDraftInput {
  workspaceId: string;
  interactionId: string;
  body: string;
  draftedByAgent: boolean;
}

export interface CreateCalendarItemInput {
  workspaceId: string;
  plannedDate: string;
  theme: string;
  targetNetworks: readonly Network[];
  generatedByAgent: boolean;
}

/**
 * What the Orchestrator needs from the outside world. Sub-phase A tested it against a small
 * in-memory fake using only the first three methods; a real Supabase service-role client is a
 * drop-in replacement later without changing runAgent()'s own logic.
 *
 * The five `create*`/`submit*`/`getBrandVoiceProfile` methods are OPTIONAL: Sub-phase A's own
 * agent (sandbox_echo) never calls them, so its existing tests and behaviour are unaffected. An
 * agent whose tool calls DO define `apply()` (see ProposedToolCall) requires a store that
 * implements the specific methods it calls - see social/agent.ts.
 */
export interface AgentStore {
  findDefinition(workspaceId: string, agentKey: string): Promise<AgentDefinition | null>;
  newId(): string;
  createApprovalRequest(input: ApprovalRequestInput): Promise<{ id: string }>;
  /**
   * These five take the FULL acting Principal (not just an id) so a real implementation can
   * scope its write exactly as that person's own session would (the same posture Phase 3's
   * own SocialStore already uses for `createDraft()`/`transition()`) - an agent-authored write
   * goes through precisely the same actor-checked path a human's own click already does.
   */
  createSocialPost?(principal: Principal, input: CreateSocialPostInput): Promise<{ id: string }>;
  submitSocialPostForReview?(principal: Principal, postId: string): Promise<void>;
  createSocialReplyDraft?(principal: Principal, input: CreateSocialReplyDraftInput): Promise<{ id: string }>;
  submitSocialReplyForReview?(principal: Principal, draftId: string): Promise<void>;
  createCalendarItem?(principal: Principal, input: CreateCalendarItemInput): Promise<{ id: string }>;
  getBrandVoiceProfile?(workspaceId: string): Promise<BrandVoiceProfile | null>;
}
