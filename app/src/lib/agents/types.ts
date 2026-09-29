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

export interface QueueAuditInput {
  workspaceId: string;
  siteId: string;
}

export interface ProposeFixInput {
  workspaceId: string;
  findingId: string;
  note?: string;
}

export interface CreateContentDraftInput {
  workspaceId: string;
  title: string;
  body: string;
  sourceFindingId?: string | null;
  draftedByAgent: boolean;
}

export const HEALTH_CHECK_STATUSES = ['pass', 'fail'] as const;
export type HealthCheckStatus = (typeof HEALTH_CHECK_STATUSES)[number];

export interface RecordHealthCheckInput {
  workspaceId: string;
  checkType: string;
  status: HealthCheckStatus;
  details?: Record<string, unknown>;
}

export interface RepairStaleInput {
  workspaceId: string;
  olderThanMinutes?: number;
}

export const AD_PLATFORMS = ['meta', 'google'] as const;
export type AdPlatform = (typeof AD_PLATFORMS)[number];

export interface BusinessProfile {
  name: string;
  industry: string;
  product: string;
  pricePoint?: string;
  problem?: string;
  location?: string;
}

export interface AudienceHypothesis {
  personaName: string;
  painPoint: string;
  signals: string[];
  demographics?: string;
}

export const AUDIENCE_SEGMENT_TYPES = ['core', 'lookalike', 'retargeting', 'exclusion'] as const;
export type AudienceSegmentType = (typeof AUDIENCE_SEGMENT_TYPES)[number];

export interface AudienceSegment {
  segmentType: AudienceSegmentType;
  description: string;
}

export interface ConversionSignals {
  qualifiedLeads?: number;
  purchases?: number;
  topSource?: string;
}

export interface FinalizeAudienceBriefInput {
  workspaceId: string;
  businessProfile: BusinessProfile;
  platform: AdPlatform;
  hypotheses: AudienceHypothesis[];
  segments: AudienceSegment[];
  recommendedObjective: string;
  recommendedOffer: string;
  conversionSignals?: ConversionSignals;
}

export interface AdCreativeInput {
  headline: string;
  body: string;
  callToAction?: string;
  imageRef?: string | null;
}

export interface DraftCampaignInput {
  workspaceId: string;
  audienceBriefId?: string | null;
  platform: AdPlatform;
  objective: string;
  name: string;
  budgetAmount?: number;
  budgetPeriod?: 'daily' | 'lifetime';
  creatives?: AdCreativeInput[];
}

export interface UpdateCampaignBudgetInput {
  workspaceId: string;
  campaignId: string;
  budgetAmount: number;
  budgetPeriod: 'daily' | 'lifetime';
}

export const LEAD_SOURCES = ['form', 'whatsapp', 'social_dm', 'manual'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'converted', 'lost'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export interface CaptureLeadInput {
  workspaceId: string;
  source: LeadSource;
  name?: string | null;
  contact?: string | null;
  notes?: string | null;
  sourceInteractionId?: string | null;
}

export interface CaptureLeadFromInteractionInput {
  workspaceId: string;
  interactionId: string;
  extractedContact?: string;
  confidence?: number;
}

export interface QualifyLeadInput {
  workspaceId: string;
  leadId: string;
  status: LeadStatus;
}

export interface DraftFollowUpInput {
  workspaceId: string;
  leadId: string;
  body: string;
}

export const WEBSITE_PROVIDERS = ['vercel', 'lovable', 'emergent', 'google_ai_studio', 'other'] as const;
export type WebsiteProvider = (typeof WEBSITE_PROVIDERS)[number];

export interface WebsitePage {
  name: string;
  sections: string[];
}

export interface DraftWebsitePlanInput {
  workspaceId: string;
  provider: WebsiteProvider;
  title: string;
  pages: WebsitePage[];
}

/**
 * What the Orchestrator needs from the outside world. Sub-phase A tested it against a small
 * in-memory fake using only the first three methods; a real Supabase service-role client is a
 * drop-in replacement later without changing runAgent()'s own logic.
 *
 * Every `create*`/`submit*`/`queue*`/`propose*`/`getBrandVoiceProfile` method is OPTIONAL:
 * Sub-phase A's own agent (sandbox_echo) never calls any of them, so its existing tests and
 * behaviour are unaffected. An agent whose tool calls DO define `apply()` (see
 * ProposedToolCall) requires a store that implements the specific methods it calls.
 */
export interface AgentStore {
  findDefinition(workspaceId: string, agentKey: string): Promise<AgentDefinition | null>;
  newId(): string;
  createApprovalRequest(input: ApprovalRequestInput): Promise<{ id: string }>;
  /**
   * Every write method takes the FULL acting Principal (not just an id) so a real
   * implementation can scope its write exactly as that person's own session would (the same
   * posture Phase 3's own SocialStore already uses for `createDraft()`/`transition()`, and
   * Phase 2's own `sites`/`audit_runs` RLS already expects) - an agent-authored write goes
   * through precisely the same actor-checked path a human's own click already does.
   */
  createSocialPost?(principal: Principal, input: CreateSocialPostInput): Promise<{ id: string }>;
  submitSocialPostForReview?(principal: Principal, postId: string): Promise<void>;
  createSocialReplyDraft?(principal: Principal, input: CreateSocialReplyDraftInput): Promise<{ id: string }>;
  submitSocialReplyForReview?(principal: Principal, draftId: string): Promise<void>;
  createCalendarItem?(principal: Principal, input: CreateCalendarItemInput): Promise<{ id: string }>;
  getBrandVoiceProfile?(workspaceId: string): Promise<BrandVoiceProfile | null>;
  /** Queues AND completes a sandbox audit run through the EXISTING Phase 2 executeAuditRun(). */
  queueAudit?(principal: Principal, input: QueueAuditInput): Promise<{ runId: string }>;
  /** Only ever called once decide() has already confirmed 'allow' (i.e. the principal is Admin). */
  proposeFix?(principal: Principal, input: ProposeFixInput): Promise<void>;
  createContentDraft?(principal: Principal, input: CreateContentDraftInput): Promise<{ id: string }>;
  submitContentDraftForReview?(principal: Principal, draftId: string): Promise<void>;
  /** Sandbox-only: no real HTTP request is ever made. Writes a health_checks row. */
  recordHealthCheck?(principal: Principal, input: RecordHealthCheckInput): Promise<{ id: string }>;
  /** Calls the REAL, unmodified Phase 2 failStaleRuns() and records the result. */
  repairStaleAudits?(principal: Principal, input: RepairStaleInput): Promise<{ failedCount: number }>;
  /** Calls the REAL, unmodified Phase 3 failStalePublishing() and records the result. */
  repairStaleSocialPublishing?(principal: Principal, input: RepairStaleInput): Promise<{ failedCount: number }>;
  /** Moves a failed post back to 'approved' ONLY - never any further toward being sent. */
  resumeFailedSocialPost?(principal: Principal, postId: string): Promise<void>;
  /** Inserts, then immediately locks, a brief - the trigger always inserts as 'draft' first. */
  finalizeAudienceBrief?(principal: Principal, input: FinalizeAudienceBriefInput): Promise<{ id: string; version: number }>;
  draftCampaign?(principal: Principal, input: DraftCampaignInput): Promise<{ id: string }>;
  submitCampaignForReview?(principal: Principal, campaignId: string): Promise<void>;
  /** Only ever called once decide() has already confirmed 'allow' on paid_ads:publish_execute. */
  updateCampaignBudget?(principal: Principal, input: UpdateCampaignBudgetInput): Promise<void>;
  captureLead?(principal: Principal, input: CaptureLeadInput): Promise<{ id: string }>;
  /** Idempotent: the SAME interactionId always resolves to the SAME lead (create-or-update). */
  captureLeadFromInteraction?(principal: Principal, input: CaptureLeadFromInteractionInput): Promise<{ id: string; created: boolean }>;
  qualifyLead?(principal: Principal, input: QualifyLeadInput): Promise<void>;
  draftFollowUp?(principal: Principal, input: DraftFollowUpInput): Promise<{ id: string }>;
  draftWebsitePlan?(principal: Principal, input: DraftWebsitePlanInput): Promise<{ id: string }>;
  submitWebsitePlanForReview?(principal: Principal, projectId: string): Promise<void>;
}
