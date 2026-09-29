/**
 * The Paid Ads Agent's own logic (Sub-phase E). Unlike seo_geo/social/website, Phase 1 made
 * BOTH `edit` and `publish_execute` sensitive for paid_ads ("budget change / pause, launch") -
 * a real, distinct-from-other-modules fact this file follows exactly: a plain rename needs
 * `edit` (still sensitive - always Admin in practice), a budget change needs
 * `publish_execute` specifically (the database's own trigger enforces this split), and
 * drafting/submitting reuse `create`, which Phase 1 never made sensitive for this module.
 *
 * `launch_campaign` has NO `apply()` at all - there is no real ad account to launch into.
 * Proposing it only ever proves the permission/approval path; nothing is ever launched.
 */

import type { AdCreativeInput, AdPlatform, AgentLogicResult, AgentStore, Handoff, Principal, ProposedToolCall } from '../types';

export type PaidAdsAgentInput =
  | {
      task: 'draft_campaign';
      workspaceId: string;
      platform: AdPlatform;
      objective: string;
      name: string;
      offer?: string;
      audienceBriefId?: string | null;
      audienceSummary?: string;
      budgetAmount?: number;
      budgetPeriod?: 'daily' | 'lifetime';
      creatives?: AdCreativeInput[];
      submitForReview?: boolean;
    }
  | { task: 'update_campaign_budget'; workspaceId: string; campaignId: string; budgetAmount: number; budgetPeriod: 'daily' | 'lifetime' }
  | { task: 'launch_campaign'; workspaceId: string; campaignId: string };

function defaultCreative(input: Extract<PaidAdsAgentInput, { task: 'draft_campaign' }>): AdCreativeInput[] {
  if (input.creatives && input.creatives.length > 0) return input.creatives;
  const offerLine = input.offer ? ` ${input.offer}.` : '';
  return [{ headline: input.name, body: `${input.objective} campaign.${offerLine}${input.audienceSummary ? ` Audience: ${input.audienceSummary}.` : ''}`, callToAction: 'Learn more' }];
}

export async function runPaidAdsAgent(input: PaidAdsAgentInput, store: AgentStore, principal: Principal): Promise<AgentLogicResult> {
  const toolCalls: ProposedToolCall[] = [];
  const handoffs: Handoff[] = [];
  let output: Record<string, unknown> = {};

  if (input.task === 'draft_campaign') {
    let createdId: string | null = null;
    toolCalls.push({
      toolName: 'draft_campaign',
      toolInput: { platform: input.platform, objective: input.objective, name: input.name },
      permission: { module: 'paid_ads', action: 'create' },
      apply: async () => {
        if (!store.draftCampaign) throw new Error('this store cannot draft a campaign');
        const { id } = await store.draftCampaign(principal, {
          workspaceId: input.workspaceId,
          audienceBriefId: input.audienceBriefId ?? null,
          platform: input.platform,
          objective: input.objective,
          name: input.name,
          budgetAmount: input.budgetAmount,
          budgetPeriod: input.budgetPeriod,
          creatives: defaultCreative(input),
        });
        createdId = id;
        return { campaignId: id };
      },
    });
    if (input.submitForReview) {
      toolCalls.push({
        toolName: 'submit_campaign_for_review',
        toolInput: {},
        permission: { module: 'paid_ads', action: 'create' },
        apply: async () => {
          if (!createdId) throw new Error('the campaign was never created, so it cannot be submitted for review');
          if (!store.submitCampaignForReview) throw new Error('this store cannot submit campaigns for review');
          await store.submitCampaignForReview(principal, createdId);
          return { campaignId: createdId, submitted: true };
        },
      });
    }
  } else if (input.task === 'update_campaign_budget') {
    toolCalls.push({
      toolName: 'update_campaign_budget',
      toolInput: { campaignId: input.campaignId, budgetAmount: input.budgetAmount, budgetPeriod: input.budgetPeriod },
      // Budget changes are their own sensitive action per PRD 5.6 - never charges anything real.
      permission: { module: 'paid_ads', action: 'publish_execute' },
      apply: async () => {
        if (!store.updateCampaignBudget) throw new Error('this store cannot update a campaign budget');
        await store.updateCampaignBudget(principal, { workspaceId: input.workspaceId, campaignId: input.campaignId, budgetAmount: input.budgetAmount, budgetPeriod: input.budgetPeriod });
        return { campaignId: input.campaignId, budgetAmount: input.budgetAmount };
      },
    });
  } else if (input.task === 'launch_campaign') {
    toolCalls.push({
      toolName: 'launch_campaign',
      toolInput: { campaignId: input.campaignId },
      permission: { module: 'paid_ads', action: 'publish_execute' },
      // No apply() - there is no live ad account to launch into. This only ever proves the
      // permission/approval path.
    });
    output = { note: 'launching a campaign is not implemented - no live ad account integration exists' };
  }

  return { output, toolCalls, handoffs };
}
