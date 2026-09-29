import { executeAuditRun } from '@/lib/seo/run-audit';
import type {
  AgentDefinition,
  AgentStore,
  AiUsageCapStatus,
  ApprovalRequestInput,
  CreateCalendarItemInput,
  CreateContentDraftInput,
  CreateSocialPostInput,
  CreateSocialReplyDraftInput,
  Principal,
  ProposeFixInput,
  QueueAuditInput,
  RecordAiUsageInput,
} from '@/lib/agents/types';
import type { AuditEvent } from '@/lib/permissions';
import type { BrandVoiceProfile } from '@/lib/agents/social/types';
import { SocialStore } from '@/lib/social/store';
import { ID, asOwner, asService, asUser, rows, type Db } from './harness';

const ID_ACME: string = ID.acme;
const ID_NOVA: string = ID.nova;
const ID_BRIGHT: string = ID.bright;

/**
 * A test-only AgentStore that proves the ENTIRE chain for real:
 *   - social posts go through the REAL Phase 3 SocialStore (as Sub-phase B already proved).
 *   - audits go through the REAL Phase 2 executeAuditRun() against the REAL PGlite database -
 *     genuine audit_runs and audit_findings rows, governed by the EXISTING, unmodified RLS
 *     and triggers from migration 20260928000400.
 *   - content drafts are written straight into the REAL content_drafts table, governed by the
 *     EXISTING, unmodified RLS and trigger from migration 20260929000300.
 * Every write runs AS the acting principal's own session (asUser) where a human could write
 * it too, so the real RLS independently re-confirms the same decision the Orchestrator's
 * decide() already made - never a service-role bypass standing in for that check.
 */
export class SeoContentSocialFixtureStore implements AgentStore {
  definitions: AgentDefinition[];
  approvals: ApprovalRequestInput[] = [];
  calendarItems: (CreateCalendarItemInput & { id: string })[] = [];
  replyDrafts: (CreateSocialReplyDraftInput & { id: string; status: 'drafted' | 'in_review' })[] = [];
  brandVoice: BrandVoiceProfile | null = null;
  private n = 0;

  constructor(
    definitions: AgentDefinition[],
    private readonly db: Db,
    public readonly socialStore: SocialStore,
  ) {
    this.definitions = definitions;
  }

  /**
   * Mirrors private.agent_definition_governs_workspace() (Sub-phase A): a definition on the
   * agency workspace also governs that agency's own client workspaces. This fixture's parent
   * lookup is hardcoded to what tests/db/harness.ts's seedFixture() actually sets up (Nova and
   * Bright are ID.acme's clients) - real production code would read this from `workspaces`.
   */
  async findDefinition(workspaceId: string, agentKey: string) {
    const AGENCY_OF: Record<string, string> = { [ID_NOVA]: ID_ACME, [ID_BRIGHT]: ID_ACME };
    return (
      this.definitions.find((d) => d.agentKey === agentKey && (d.workspaceId === workspaceId || d.workspaceId === AGENCY_OF[workspaceId])) ?? null
    );
  }
  newId() {
    return `run-${++this.n}`;
  }
  async createApprovalRequest(input: ApprovalRequestInput) {
    this.approvals.push(input);
    return { id: `approval-${this.approvals.length}` };
  }

  // -- social (delegates to the real Phase 3 SocialStore, exactly as Sub-phase B did) -------
  async createSocialPost(principal: Principal, input: CreateSocialPostInput) {
    const result = this.socialStore.createDraft(principal, { channelId: input.channelId, body: input.body, imageAlt: input.imageAlt ?? undefined, groupId: input.groupId ?? undefined });
    if (!result.ok) throw new Error(result.message);
    return { id: result.value.id };
  }
  async submitSocialPostForReview(principal: Principal, postId: string) {
    const result = this.socialStore.transition(principal, postId, 'in_review');
    if (!result.ok) throw new Error(result.message);
  }
  async createSocialReplyDraft(_principal: Principal, input: CreateSocialReplyDraftInput) {
    const id = `reply-${this.replyDrafts.length + 1}`;
    this.replyDrafts.push({ ...input, id, status: 'drafted' });
    return { id };
  }
  async submitSocialReplyForReview(_principal: Principal, draftId: string) {
    const draft = this.replyDrafts.find((r) => r.id === draftId);
    if (!draft) throw new Error('that reply draft does not exist');
    draft.status = 'in_review';
  }
  async createCalendarItem(_principal: Principal, input: CreateCalendarItemInput) {
    const id = `cal-${this.calendarItems.length + 1}`;
    this.calendarItems.push({ ...input, id });
    return { id };
  }
  async getBrandVoiceProfile() {
    return this.brandVoice;
  }

  // -- SEO/GEO (real Postgres: the EXISTING sites/audit_runs/audit_findings tables) ---------
  async queueAudit(principal: Principal, input: QueueAuditInput) {
    const [{ id: runId }] = await asUser(this.db, principal.id, () =>
      rows<{ id: string }>(this.db, `insert into public.audit_runs (workspace_id, site_id) values ($1, $2) returning id`, [input.workspaceId, input.siteId]),
    );
    await asService(this.db, () => executeAuditRun({ query: (sql, params) => this.db.query(sql, params) as never }, runId));
    return { runId };
  }
  async proposeFix(principal: Principal, input: ProposeFixInput) {
    await asUser(this.db, principal.id, () =>
      this.db.query(`update public.audit_findings set fix_status = 'applied', fix_note = $2 where id = $1`, [input.findingId, input.note ?? null]),
    );
  }

  // -- Content Agent (real Postgres: the new content_drafts table) --------------------------
  async createContentDraft(principal: Principal, input: CreateContentDraftInput) {
    const [{ id }] = await asUser(this.db, principal.id, () =>
      rows<{ id: string }>(
        this.db,
        `insert into public.content_drafts (workspace_id, title, body, source_finding_id, drafted_by_agent) values ($1, $2, $3, $4, $5) returning id`,
        [input.workspaceId, input.title, input.body, input.sourceFindingId ?? null, input.draftedByAgent],
      ),
    );
    return { id };
  }
  async submitContentDraftForReview(principal: Principal, draftId: string) {
    await asUser(this.db, principal.id, () => this.db.query(`update public.content_drafts set status = 'in_review' where id = $1`, [draftId]));
  }

  // -- Phase F.2: AI usage caps + the app-layer audit write (real Postgres: ai_usage_log /
  // audit_log, both from migration 20260929000600 / foundation_schema.sql) ------------------
  async getAiUsageCapStatus(workspaceId: string): Promise<AiUsageCapStatus> {
    const [settings] = await asOwner(this.db, () =>
      rows<{ ai_daily_call_cap: number | null; ai_monthly_cost_cap_usd: string | null }>(
        this.db,
        `select ai_daily_call_cap, ai_monthly_cost_cap_usd from public.workspace_settings where workspace_id = $1`,
        [workspaceId],
      ),
    );
    const [{ daily_count }] = await asOwner(this.db, () =>
      rows<{ daily_count: string }>(
        this.db,
        `select count(*)::text as daily_count from public.ai_usage_log where workspace_id = $1 and created_at >= date_trunc('day', now())`,
        [workspaceId],
      ),
    );
    const [{ monthly_cost }] = await asOwner(this.db, () =>
      rows<{ monthly_cost: string }>(
        this.db,
        `select coalesce(sum(estimated_cost_usd), 0)::text as monthly_cost from public.ai_usage_log where workspace_id = $1 and created_at >= date_trunc('month', now())`,
        [workspaceId],
      ),
    );
    return {
      dailyCallCap: settings?.ai_daily_call_cap ?? null,
      monthlyCostCapUsd: settings?.ai_monthly_cost_cap_usd != null ? Number(settings.ai_monthly_cost_cap_usd) : null,
      dailyCallCount: Number(daily_count),
      monthlyCostUsd: Number(monthly_cost),
    };
  }

  /** Only a REAL, successful call ever reaches here - the server-role write matches Phase F.1's own precedent for ai_usage_log. */
  async recordAiUsage(input: RecordAiUsageInput) {
    await asService(this.db, () =>
      this.db.query(
        `insert into public.ai_usage_log (workspace_id, agent_run_id, provider, model, input_tokens, output_tokens, estimated_cost_usd) values ($1, $2, $3, $4, $5, $6, $7)`,
        [input.workspaceId, input.agentRunId ?? null, input.provider, input.model, input.inputTokens, input.outputTokens, input.estimatedCostUsd],
      ),
    );
  }

  /** The app-layer audit write for an event the database itself never sees (src/lib/permissions/audit.ts). */
  async recordAuditEvent(event: AuditEvent) {
    await asService(this.db, () =>
      this.db.query(
        `insert into public.audit_log (actor_id, actor_role, workspace_id, module, action, target_type, target_id, result, approval_id, approval_status, metadata)
         values ($1, $2, $3, $4::public.permission_module, $5, $6, $7, $8::public.audit_result, $9, $10::public.approval_status, $11)`,
        [
          event.actorId, event.actorRole, event.workspaceId, event.module, event.action,
          event.targetType ?? null, event.targetId ?? null, event.result, event.approvalId ?? null,
          event.approvalStatus ?? null, JSON.stringify(event.metadata ?? {}),
        ],
      ),
    );
  }
}

/** Reads a row back as the database owner - convenience for assertions in tests. */
export const readRow = <T = Record<string, any>>(db: Db, sql: string, params: unknown[] = []) => asOwner(db, () => rows<T>(db, sql, params));
