import type {
  AgentDefinition,
  AgentStore,
  ApprovalRequestInput,
  CaptureLeadFromInteractionInput,
  CaptureLeadInput,
  DraftCampaignInput,
  DraftFollowUpInput,
  DraftWebsitePlanInput,
  FinalizeAudienceBriefInput,
  Principal,
  QualifyLeadInput,
  UpdateCampaignBudgetInput,
} from '@/lib/agents/types';
import { ID, asUser, rows, type Db } from './harness';

const AGENCY_OF: Record<string, string> = { [ID.nova]: ID.acme, [ID.bright]: ID.acme };

/**
 * A test-only AgentStore for Sub-phase E, operating entirely on REAL Postgres (PGlite) rows
 * through the new ad_audience_briefs/ad_campaigns/ad_creatives/leads/lead_activities/
 * website_projects tables. Every write runs AS the acting principal's own session, so the
 * real RLS and triggers independently re-confirm the same decision the Orchestrator's
 * decide() already made.
 */
export class AdsLeadsFixtureStore implements AgentStore {
  approvals: ApprovalRequestInput[] = [];
  private n = 0;

  constructor(private readonly definitions: AgentDefinition[], private readonly db: Db) {}

  async findDefinition(workspaceId: string, agentKey: string) {
    return this.definitions.find((d) => d.agentKey === agentKey && (d.workspaceId === workspaceId || d.workspaceId === AGENCY_OF[workspaceId])) ?? null;
  }
  newId() {
    return `run-${++this.n}`;
  }
  async createApprovalRequest(input: ApprovalRequestInput) {
    this.approvals.push(input);
    return { id: `approval-${this.approvals.length}` };
  }

  async finalizeAudienceBrief(principal: Principal, input: FinalizeAudienceBriefInput) {
    const [{ id }] = await asUser(this.db, principal.id, () =>
      rows<{ id: string }>(
        this.db,
        `insert into public.ad_audience_briefs (workspace_id, business_profile, platform, hypotheses, segments, recommended_objective, recommended_offer, conversion_signals)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [input.workspaceId, JSON.stringify(input.businessProfile), input.platform, JSON.stringify(input.hypotheses), JSON.stringify(input.segments), input.recommendedObjective, input.recommendedOffer, JSON.stringify(input.conversionSignals ?? {})],
      ),
    );
    const [{ version }] = await asUser(this.db, principal.id, () =>
      rows<{ version: number }>(this.db, `update public.ad_audience_briefs set status = 'final' where id = $1 returning version`, [id]),
    );
    return { id, version };
  }

  async draftCampaign(principal: Principal, input: DraftCampaignInput) {
    const [{ id }] = await asUser(this.db, principal.id, () =>
      rows<{ id: string }>(
        this.db,
        `insert into public.ad_campaigns (workspace_id, audience_brief_id, platform, objective, name, budget_amount, budget_period) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [input.workspaceId, input.audienceBriefId ?? null, input.platform, input.objective, input.name, input.budgetAmount ?? null, input.budgetPeriod ?? null],
      ),
    );
    for (const creative of input.creatives ?? []) {
      await asUser(this.db, principal.id, () =>
        this.db.query(`insert into public.ad_creatives (campaign_id, workspace_id, headline, body, call_to_action, image_ref) values ($1, $2, $3, $4, $5, $6)`, [
          id, input.workspaceId, creative.headline, creative.body, creative.callToAction ?? null, creative.imageRef ?? null,
        ]),
      );
    }
    return { id };
  }

  async submitCampaignForReview(principal: Principal, campaignId: string) {
    await asUser(this.db, principal.id, () => this.db.query(`update public.ad_campaigns set status = 'in_review' where id = $1`, [campaignId]));
  }

  async updateCampaignBudget(principal: Principal, input: UpdateCampaignBudgetInput) {
    await asUser(this.db, principal.id, () =>
      this.db.query(`update public.ad_campaigns set budget_amount = $2, budget_period = $3 where id = $1`, [input.campaignId, input.budgetAmount, input.budgetPeriod]),
    );
  }

  async captureLead(principal: Principal, input: CaptureLeadInput) {
    const [{ id }] = await asUser(this.db, principal.id, () =>
      rows<{ id: string }>(
        this.db,
        `insert into public.leads (workspace_id, source, name, contact, notes, source_interaction_id) values ($1, $2, $3, $4, $5, $6) returning id`,
        [input.workspaceId, input.source, input.name ?? null, input.contact ?? null, input.notes ?? null, input.sourceInteractionId ?? null],
      ),
    );
    return { id };
  }

  /** Idempotent: the SAME interactionId always resolves to the SAME lead. */
  async captureLeadFromInteraction(principal: Principal, input: CaptureLeadFromInteractionInput) {
    const existing = await asUser(this.db, principal.id, () =>
      rows<{ id: string }>(this.db, `select id from public.leads where workspace_id = $1 and source_interaction_id = $2`, [input.workspaceId, input.interactionId]),
    );
    if (existing.length > 0) {
      await asUser(this.db, principal.id, () =>
        this.db.query(`update public.leads set contact = coalesce($2, contact), notes = $3 where id = $1`, [
          existing[0].id, input.extractedContact ?? null, `Detected again from a social comment/DM (confidence: ${input.confidence ?? 'unknown'})`,
        ]),
      );
      return { id: existing[0].id, created: false };
    }
    const [{ id }] = await asUser(this.db, principal.id, () =>
      rows<{ id: string }>(
        this.db,
        `insert into public.leads (workspace_id, source, contact, notes, source_interaction_id) values ($1, 'social_dm', $2, $3, $4) returning id`,
        [input.workspaceId, input.extractedContact ?? null, `Detected from a social comment/DM (confidence: ${input.confidence ?? 'unknown'})`, input.interactionId],
      ),
    );
    return { id, created: true };
  }

  async qualifyLead(principal: Principal, input: QualifyLeadInput) {
    await asUser(this.db, principal.id, () => this.db.query(`update public.leads set status = $2 where id = $1`, [input.leadId, input.status]));
  }

  async draftFollowUp(principal: Principal, input: DraftFollowUpInput) {
    const [{ id }] = await asUser(this.db, principal.id, () =>
      rows<{ id: string }>(this.db, `insert into public.lead_activities (lead_id, workspace_id, kind, body) values ($1, $2, 'follow_up_drafted', $3) returning id`, [input.leadId, input.workspaceId, input.body]),
    );
    return { id };
  }

  async draftWebsitePlan(principal: Principal, input: DraftWebsitePlanInput) {
    const [{ id }] = await asUser(this.db, principal.id, () =>
      rows<{ id: string }>(this.db, `insert into public.website_projects (workspace_id, provider, title, pages) values ($1, $2, $3, $4) returning id`, [input.workspaceId, input.provider, input.title, JSON.stringify(input.pages)]),
    );
    return { id };
  }

  async submitWebsitePlanForReview(principal: Principal, projectId: string) {
    await asUser(this.db, principal.id, () => this.db.query(`update public.website_projects set status = 'in_review' where id = $1`, [projectId]));
  }
}
