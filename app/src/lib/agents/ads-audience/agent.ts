/**
 * The Paid Ads Audience & Targeting Agent's own logic (Sub-phase E). Business-agnostic by
 * construction: every function here works off the SAME generic {name, industry, product,
 * problem, location} shape whether the business is a protein brand, a gym, a real estate
 * agency, an ecommerce store or a local service - none of the logic branches on a specific
 * industry name.
 *
 * "Asking for basic business and product information" is realized as a required-input
 * contract (BusinessProfile), not a live chat loop - the same deterministic, scripted design
 * every agent in this project uses. Research is sandbox-only and input-driven, never a real
 * web/social lookup - the same posture as social/strategy.ts's researchStrategy().
 *
 * This agent NEVER launches an ad, changes a budget, or touches a live account: it has no
 * tool mapped to paid_ads:edit or paid_ads:publish_execute anywhere in this file. Its only
 * write (`finalize_audience_brief`) is paid_ads:create, which Phase 1 never made sensitive.
 */

import type {
  AdPlatform,
  AdCreativeInput,
  AgentLogicResult,
  AgentStore,
  AudienceHypothesis,
  AudienceSegment,
  AudienceSegmentType,
  BusinessProfile,
  ConversionSignals,
  Handoff,
  Principal,
  ProposedToolCall,
} from '../types';

export type AdsAudienceAgentInput =
  | { task: 'intake_business_profile'; businessProfile: BusinessProfile }
  | { task: 'research_audience_signals'; businessProfile: BusinessProfile }
  | { task: 'create_audience_hypotheses'; businessProfile: BusinessProfile; platform?: AdPlatform; conversionSignals?: ConversionSignals }
  | {
      task: 'finalize_audience_brief';
      workspaceId: string;
      businessProfile: BusinessProfile;
      platform?: AdPlatform;
      hypotheses?: AudienceHypothesis[];
      segments?: AudienceSegment[];
      recommendedObjective?: string;
      recommendedOffer?: string;
      conversionSignals?: ConversionSignals;
      /** Only ever set by the caller's own explicit request - this agent never decides to hand off on its own. */
      handoffToPaidAds?: boolean;
      campaignName?: string;
      creatives?: AdCreativeInput[];
    };

/** Deterministic, business-agnostic - never branches on a specific industry name. */
export function researchAudienceSignals(profile: BusinessProfile): string[] {
  const industry = profile.industry.trim();
  const product = profile.product.trim();
  const problem = profile.problem?.trim() || `common ${industry} problems`;
  return [
    `People actively searching for or comparing "${product}" within ${industry}.`,
    `People engaging with content about ${problem}.`,
    `People who already follow or engage with other ${industry} brands, pages or creators.`,
  ];
}

export function createAudienceHypotheses(profile: BusinessProfile, signals: string[]): AudienceHypothesis[] {
  const industry = profile.industry.trim();
  const product = profile.product.trim();
  return [
    { personaName: `The ${industry} researcher`, painPoint: profile.problem?.trim() || `finding the right ${product}`, signals: [signals[0]] },
    { personaName: 'The engaged follower', painPoint: `wants to stay current on ${industry}`, signals: [signals[2]] },
    { personaName: 'The value-conscious buyer', painPoint: `comparing value for ${product}`, signals: [signals[1]] },
  ];
}

export function defaultAudienceSegments(): AudienceSegment[] {
  const of = (segmentType: AudienceSegmentType, description: string): AudienceSegment => ({ segmentType, description });
  return [
    of('core', 'Interest and behavior targeting matching the hypotheses above'),
    of('lookalike', '1% lookalike audience built from existing customers or qualified leads'),
    of('retargeting', 'Website visitors and engaged profile followers from the last 30 days'),
    of('exclusion', 'Existing customers already converted, to avoid wasted spend'),
  ];
}

export function recommendObjective(signals?: ConversionSignals): string {
  if (signals?.purchases && signals.purchases > 0) return 'conversions';
  if (signals?.qualifiedLeads && signals.qualifiedLeads > 0) return 'lead_generation';
  return 'awareness';
}

export function recommendOffer(profile: BusinessProfile): string {
  return `Introductory offer on ${profile.product.trim()} for new customers`;
}

export async function runAdsAudienceAgent(input: AdsAudienceAgentInput, store: AgentStore, principal: Principal): Promise<AgentLogicResult> {
  const toolCalls: ProposedToolCall[] = [];
  const handoffs: Handoff[] = [];
  let output: Record<string, unknown> = {};

  if (input.task === 'intake_business_profile') {
    toolCalls.push({ toolName: 'intake_business_profile', toolInput: { name: input.businessProfile.name, industry: input.businessProfile.industry } });
    output = { received: input.businessProfile };
  } else if (input.task === 'research_audience_signals') {
    const signals = researchAudienceSignals(input.businessProfile);
    toolCalls.push({ toolName: 'research_audience_signals', toolInput: { industry: input.businessProfile.industry } });
    output = { signals };
  } else if (input.task === 'create_audience_hypotheses') {
    const signals = researchAudienceSignals(input.businessProfile);
    const hypotheses = createAudienceHypotheses(input.businessProfile, signals);
    const segments = defaultAudienceSegments();
    const objective = recommendObjective(input.conversionSignals);
    const offer = recommendOffer(input.businessProfile);
    toolCalls.push({ toolName: 'create_audience_hypotheses', toolInput: { industry: input.businessProfile.industry, platform: input.platform ?? 'meta' } });
    output = { hypotheses, segments, recommendedObjective: objective, recommendedOffer: offer, platform: input.platform ?? 'meta' };
  } else if (input.task === 'finalize_audience_brief') {
    const signals = researchAudienceSignals(input.businessProfile);
    const hypotheses = input.hypotheses ?? createAudienceHypotheses(input.businessProfile, signals);
    const segments = input.segments ?? defaultAudienceSegments();
    const objective = input.recommendedObjective ?? recommendObjective(input.conversionSignals);
    const offer = input.recommendedOffer ?? recommendOffer(input.businessProfile);
    const platform: AdPlatform = input.platform ?? 'meta';

    toolCalls.push({
      toolName: 'finalize_audience_brief',
      toolInput: { platform, hypothesisCount: hypotheses.length, segmentCount: segments.length },
      permission: { module: 'paid_ads', action: 'create' },
      apply: async () => {
        if (!store.finalizeAudienceBrief) throw new Error('this store cannot finalize an audience brief');
        const { id, version } = await store.finalizeAudienceBrief(principal, {
          workspaceId: input.workspaceId,
          businessProfile: input.businessProfile,
          platform,
          hypotheses,
          segments,
          recommendedObjective: objective,
          recommendedOffer: offer,
          conversionSignals: input.conversionSignals,
        });
        return { briefId: id, version };
      },
    });

    // The brief's row id does not exist yet at the moment this handoff is proposed (apply()
    // has not run), so the handoff carries the brief's CONTENT directly, shaped as ready-to-
    // use Paid Ads Agent input - exactly like every other handoff since Sub-phase C. A human
    // linking a campaign to a specific, already-finalized brief row can still do so directly
    // (ad_campaigns.audience_brief_id) - the database only requires that link to point at a
    // brief whose status is 'final'.
    if (input.handoffToPaidAds) {
      handoffs.push({
        toAgentKey: 'paid_ads_agent',
        payload: {
          task: 'draft_campaign',
          workspaceId: input.workspaceId,
          platform,
          objective,
          name: input.campaignName ?? `${input.businessProfile.name} - ${objective}`,
          offer,
          audienceSummary: hypotheses.map((h) => h.personaName).join(', '),
          creatives: input.creatives,
        },
      });
    }
    output = { hypotheses, segments, recommendedObjective: objective, recommendedOffer: offer, platform };
  }

  return { output, toolCalls, handoffs };
}
