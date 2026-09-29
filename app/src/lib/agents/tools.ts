/**
 * The tool registry. A tool is the ONLY way an agent can ever propose to do anything - this
 * list, not prompt wording, is the real security boundary (see
 * docs/AGENT-RUNTIME-ARCHITECTURE.md, safety rule 5). An agent may only call a tool that is
 * both defined here AND listed in its own agent_definitions.allowed_tools.
 */

import type { Action, Module } from '@/lib/permissions';

export interface ToolDefinition {
  name: string;
  description: string;
  /** Present when calling this tool proposes an action the permission system must decide. */
  permission?: { module: Module; action: Action };
}

/**
 * Sub-phase A ships exactly three tools, all for the sandbox_echo demo agent, deliberately
 * mapped to EXISTING permission pairs from src/lib/permissions/policy.ts rather than
 * inventing a new one:
 *  - echo_message: pure utility, no permission attached, always allowed - proves the plumbing
 *    with zero risk.
 *  - propose_demo_action -> ai_assistant:publish_execute ("the AI executing a command").
 *    This pair is CEILING-blocked for everyone but Admin - no grant can ever unlock it (the
 *    PRD's "Client AI is read-only" rule). Proves an agent is refused outright, not merely
 *    sent for approval, when the action is one nobody but Admin may ever hold.
 *  - propose_grantable_demo_action -> paid_ads:publish_execute. An Admin can grant this to a
 *    Client or Team member, but because it is sensitive it always still needs an Admin's
 *    approval. Proves the "granted but still needs approval" path end to end.
 */
export const TOOLS: Record<string, ToolDefinition> = {
  echo_message: {
    name: 'echo_message',
    description: 'Repeats back the text it was given. No permission check.',
  },
  propose_demo_action: {
    name: 'propose_demo_action',
    description: 'A harmless stand-in for "the AI wants to execute something." Ceiling-blocked for everyone but Admin - no grant can ever unlock it.',
    permission: { module: 'ai_assistant', action: 'publish_execute' },
  },
  propose_grantable_demo_action: {
    name: 'propose_grantable_demo_action',
    description: "A harmless stand-in for a normally-grantable sensitive action (like a budget change). Even when granted, it still always needs an Admin's approval.",
    permission: { module: 'paid_ads', action: 'publish_execute' },
  },

  /**
   * Sub-phase B adds six tools for the Social Media Super Agent. All six reuse the SAME,
   * already-existing `social:create` action Phase 3 already uses for a human's own draft - no
   * new permission module or action is introduced anywhere. There is deliberately no
   * publish/send tool: this agent's own work stops at "submitted for review".
   */
  research_strategy: {
    name: 'research_strategy',
    description: 'Produces content pillars for a topic from the input given. No permission check - nothing is written.',
  },
  generate_calendar: {
    name: 'generate_calendar',
    description: 'Writes real social_content_calendar_items rows for a date range.',
    permission: { module: 'social', action: 'create' },
  },
  draft_post: {
    name: 'draft_post',
    description: 'Writes a real social_posts row in "draft" status - the exact same table and status a human\'s own new post uses.',
    permission: { module: 'social', action: 'create' },
  },
  submit_post_for_review: {
    name: 'submit_post_for_review',
    description: 'Moves a drafted post to "in_review" (pending approval) - the exact same Phase 3 state machine a human\'s own submission uses.',
    permission: { module: 'social', action: 'create' },
  },
  draft_reply: {
    name: 'draft_reply',
    description: 'Writes a real social_reply_drafts row for one interaction (comment/DM), in "drafted" status.',
    permission: { module: 'social', action: 'create' },
  },
  submit_reply_for_review: {
    name: 'submit_reply_for_review',
    description: 'Moves a drafted reply to "in_review" (pending approval).',
    permission: { module: 'social', action: 'create' },
  },
  video_script: {
    name: 'video_script',
    description: 'Produces a Reels/short-video script (text only - no video is rendered). No permission check - nothing is written.',
  },

  /**
   * Sub-phase C adds five tools for the SEO/GEO Agent and the Content Agent. All five reuse
   * the EXISTING `seo_geo` module's EXISTING actions from Phase 2 - no new permission module
   * or action anywhere. There is no tool here that approves or publishes anything: an article
   * draft goes exactly as far as "submitted for review", and a fix record is the only thing
   * "publish_execute" ever means for this module (it never touches a real website).
   */
  queue_audit: {
    name: 'queue_audit',
    description: 'Queues and completes a sandbox audit run through the EXISTING Phase 2 engine and fixture sites - never a real website.',
    permission: { module: 'seo_geo', action: 'create' },
  },
  explain_findings: {
    name: 'explain_findings',
    description: 'Summarizes already-fetched audit findings in plain language. No permission check - nothing is written.',
  },
  propose_fix: {
    name: 'propose_fix',
    description: 'Records that a recommendation was applied (Phase 2\'s own fix_status field). Never changes a real website. Sensitive - in practice only an Admin can do it directly.',
    permission: { module: 'seo_geo', action: 'publish_execute' },
  },
  draft_article: {
    name: 'draft_article',
    description: 'Writes a real content_drafts row in "draft" status. This agent has no tool that approves or publishes it.',
    permission: { module: 'seo_geo', action: 'create' },
  },
  submit_article_for_review: {
    name: 'submit_article_for_review',
    description: 'Moves a drafted article to "in_review" (pending approval).',
    permission: { module: 'seo_geo', action: 'create' },
  },

  /**
   * Sub-phase D adds ten tools for the Analytics/Reporting Agent and the Monitoring/Auto-Repair
   * Agent. The five Analytics tools all reuse `reports:view` (never sensitive, already a
   * Client default) purely so every read still shows up in the agent_tool_calls audit trail -
   * none of them ever sets `apply()`, so nothing they touch is ever written. The five
   * Monitoring tools each reuse the module that actually governs the thing being touched:
   * `health_monitor` (already Admin-ceiling-only since Phase 1 - no non-admin role can ever
   * hold any action on it) for the agent's own check/incident bookkeeping, and
   * `social:publish_execute` (already sensitive) for the one repair that changes a business
   * row outside its own module. There is no tool here mapped to publish/send, a budget, a
   * domain, a permission grant, or an agent's own system prompt.
   */
  summarize_seo_performance: {
    name: 'summarize_seo_performance',
    description: 'Summarizes already-fetched audit scores. Read-only.',
    permission: { module: 'reports', action: 'view' },
  },
  summarize_social_activity: {
    name: 'summarize_social_activity',
    description: 'Summarizes already-fetched social post activity. Read-only.',
    permission: { module: 'reports', action: 'view' },
  },
  summarize_content_pipeline: {
    name: 'summarize_content_pipeline',
    description: 'Summarizes already-fetched content draft activity. Read-only.',
    permission: { module: 'reports', action: 'view' },
  },
  summarize_agent_activity: {
    name: 'summarize_agent_activity',
    description: 'Summarizes already-fetched agent run activity. Read-only.',
    permission: { module: 'reports', action: 'view' },
  },
  compile_report: {
    name: 'compile_report',
    description: 'Combines already-produced summaries into one client-safe report. Read-only.',
    permission: { module: 'reports', action: 'view' },
  },
  check_website_availability: {
    name: 'check_website_availability',
    description: 'Sandbox-simulated reachability check against the known fixture sites. Never a real HTTP request.',
    permission: { module: 'health_monitor', action: 'create' },
  },
  check_stale_audits: {
    name: 'check_stale_audits',
    description: 'Calls the real, unmodified Phase 2 failStaleRuns() - fails audits stuck running too long. Never forces one through.',
    permission: { module: 'health_monitor', action: 'edit' },
  },
  check_stale_social_publishing: {
    name: 'check_stale_social_publishing',
    description: 'Calls the real, unmodified Phase 3 failStalePublishing() - fails posts stuck publishing too long. Never forces one through.',
    permission: { module: 'health_monitor', action: 'edit' },
  },
  requeue_failed_audit: {
    name: 'requeue_failed_audit',
    description: 'Queues a fresh audit run for a site, via the same queueAudit() the SEO/GEO Agent already uses. Never forces the old run through.',
    permission: { module: 'health_monitor', action: 'edit' },
  },
  resume_failed_post: {
    name: 'resume_failed_post',
    description: 'Moves a failed post back to "approved" only - never any further toward being sent. Uses the SAME sensitive action a human\'s own publish already needs.',
    permission: { module: 'social', action: 'publish_execute' },
  },

  /**
   * Sub-phase E adds sixteen tools across four agents, all reusing existing actions.
   * paid_ads is the one module where Phase 1 made BOTH edit and publish_execute sensitive
   * ("budget change / pause, launch") - update_campaign_budget and launch_campaign both
   * reflect that. leads_crm is the lightest-touch module in the system (nothing here is
   * sensitive except delete, which has no tool). A Client's ceiling for `website` is 'view'
   * only - draft_website_plan can never be attempted by a Client, however it is granted.
   * `launch_campaign` and `propose_domain_connection` have no apply() anywhere in this
   * project - no live ad account or registrar integration exists, so proposing either only
   * ever proves the permission/approval path.
   */
  intake_business_profile: {
    name: 'intake_business_profile',
    description: 'Records the structured business/product intake for audience research. No permission check - nothing is written.',
  },
  research_audience_signals: {
    name: 'research_audience_signals',
    description: 'Sandbox, business-agnostic research into customer intent and audience signals. No permission check - nothing is written.',
  },
  create_audience_hypotheses: {
    name: 'create_audience_hypotheses',
    description: 'Produces audience personas and core/lookalike/retargeting/exclusion segments. No permission check - nothing is written.',
  },
  finalize_audience_brief: {
    name: 'finalize_audience_brief',
    description: 'Writes a real ad_audience_briefs row and locks it - the approved input for campaign planning only. Never launches ads, changes a budget or touches a live account.',
    permission: { module: 'paid_ads', action: 'create' },
  },
  draft_campaign: {
    name: 'draft_campaign',
    description: 'Writes a real ad_campaigns row (+ creatives) in "draft" status. Needs an explicit grant - paid_ads:create is never a Client default.',
    permission: { module: 'paid_ads', action: 'create' },
  },
  submit_campaign_for_review: {
    name: 'submit_campaign_for_review',
    description: 'Moves a drafted campaign to "in_review" (pending approval).',
    permission: { module: 'paid_ads', action: 'create' },
  },
  update_campaign_budget: {
    name: 'update_campaign_budget',
    description: 'Changes a campaign\'s sandbox budget fields only - never spends anything real. Sensitive, per PRD 5.6.',
    permission: { module: 'paid_ads', action: 'publish_execute' },
  },
  launch_campaign: {
    name: 'launch_campaign',
    description: 'Proposes launching a campaign. No real ad account exists, so this has no effect even when allowed - it only proves the permission/approval path.',
    permission: { module: 'paid_ads', action: 'publish_execute' },
  },
  capture_lead: {
    name: 'capture_lead',
    description: 'Writes a real leads row (or, from a social interaction, creates/updates the one lead already linked to it - never a duplicate). Never sensitive.',
    permission: { module: 'leads_crm', action: 'create' },
  },
  qualify_lead: {
    name: 'qualify_lead',
    description: 'Changes a lead\'s status (new/contacted/qualified/converted/lost). Never sensitive.',
    permission: { module: 'leads_crm', action: 'edit' },
  },
  draft_follow_up: {
    name: 'draft_follow_up',
    description: 'Writes a drafted follow-up message to lead_activities. Never sent - there is no send tool anywhere in this project.',
    permission: { module: 'leads_crm', action: 'create' },
  },
  draft_website_plan: {
    name: 'draft_website_plan',
    description: 'Writes a real website_projects row in "draft" status. A Client can never attempt this - their ceiling for `website` is view-only.',
    permission: { module: 'website', action: 'create' },
  },
  submit_website_plan_for_review: {
    name: 'submit_website_plan_for_review',
    description: 'Moves a drafted website plan to "in_review" (pending approval).',
    permission: { module: 'website', action: 'create' },
  },
  research_domain_names: {
    name: 'research_domain_names',
    description: 'Sandbox name suggestions. No permission check - nothing is written, and no real registrar is ever contacted.',
  },
  check_domain_availability: {
    name: 'check_domain_availability',
    description: 'Sandbox heuristic against a small fixture "taken" list. No permission check, no real WHOIS/registrar call ever.',
  },
  propose_domain_connection: {
    name: 'propose_domain_connection',
    description: 'Proposes connecting a domain. No registrar integration exists, so this has no effect even when allowed - it only proves the permission/approval path.',
    permission: { module: 'domains', action: 'create' },
  },
};

export function toolDefinition(name: string): ToolDefinition | undefined {
  return TOOLS[name];
}
