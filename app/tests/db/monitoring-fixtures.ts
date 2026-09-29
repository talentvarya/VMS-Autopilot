import { executeAuditRun, failStaleRuns } from '@/lib/seo/run-audit';
import { failStalePublishing } from '@/lib/social/publish-worker';
import type {
  AgentDefinition,
  AgentStore,
  ApprovalRequestInput,
  Principal,
  QueueAuditInput,
  RecordHealthCheckInput,
  RepairStaleInput,
} from '@/lib/agents/types';
import { ID, asOwner, asService, asUser, rows, type Db } from './harness';

const AGENCY_OF: Record<string, string> = { [ID.nova]: ID.acme, [ID.bright]: ID.acme };
const queryable = (db: Db) => ({ query: (sql: string, params?: unknown[]) => db.query(sql, params) as never });

/**
 * A test-only AgentStore for Sub-phase D's Analytics/Monitoring agents, operating entirely on
 * REAL Postgres (PGlite) rows via the EXISTING sites/audit_runs/social_posts schema and the
 * EXISTING, unmodified failStaleRuns()/failStalePublishing() functions - not a simulation of
 * them. Every write runs AS the acting principal's own session where a human could write it
 * too, so the real RLS independently re-confirms the same decision the Orchestrator's decide()
 * already made.
 */
export class MonitoringFixtureStore implements AgentStore {
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

  async queueAudit(principal: Principal, input: QueueAuditInput) {
    const [{ id: runId }] = await asUser(this.db, principal.id, () =>
      rows<{ id: string }>(this.db, `insert into public.audit_runs (workspace_id, site_id) values ($1, $2) returning id`, [input.workspaceId, input.siteId]),
    );
    await asService(this.db, () => executeAuditRun(queryable(this.db), runId));
    return { runId };
  }

  async recordHealthCheck(principal: Principal, input: RecordHealthCheckInput) {
    const [{ id }] = await asUser(this.db, principal.id, () =>
      rows<{ id: string }>(this.db, `insert into public.health_checks (workspace_id, check_type, status, details) values ($1, $2, $3, $4) returning id`, [input.workspaceId, input.checkType, input.status, JSON.stringify(input.details ?? {})]),
    );
    return { id };
  }

  async repairStaleAudits(principal: Principal, input: RepairStaleInput) {
    const failedCount = await asService(this.db, () => failStaleRuns(queryable(this.db), input.olderThanMinutes));
    await asUser(this.db, principal.id, () =>
      this.db.query(`insert into public.health_checks (workspace_id, check_type, status, details) values ($1, 'stale_audits', $2, $3)`, [input.workspaceId, failedCount > 0 ? 'fail' : 'pass', JSON.stringify({ failedCount })]),
    );
    if (failedCount > 0) {
      await asUser(this.db, principal.id, () =>
        this.db.query(`insert into public.health_incidents (workspace_id, check_type, auto_repair_attempted, auto_repair_action, auto_repair_result) values ($1, 'stale_audits', true, 'check_stale_audits', $2)`, [input.workspaceId, JSON.stringify({ failedCount })]),
      );
    }
    return { failedCount };
  }

  async repairStaleSocialPublishing(principal: Principal, input: RepairStaleInput) {
    const failedCount = await asService(this.db, () => failStalePublishing(queryable(this.db), input.olderThanMinutes));
    await asUser(this.db, principal.id, () =>
      this.db.query(`insert into public.health_checks (workspace_id, check_type, status, details) values ($1, 'stale_social_publishing', $2, $3)`, [input.workspaceId, failedCount > 0 ? 'fail' : 'pass', JSON.stringify({ failedCount })]),
    );
    if (failedCount > 0) {
      await asUser(this.db, principal.id, () =>
        this.db.query(`insert into public.health_incidents (workspace_id, check_type, auto_repair_attempted, auto_repair_action, auto_repair_result) values ($1, 'stale_social_publishing', true, 'check_stale_social_publishing', $2)`, [input.workspaceId, JSON.stringify({ failedCount })]),
      );
    }
    return { failedCount };
  }

  async resumeFailedSocialPost(principal: Principal, postId: string) {
    await asUser(this.db, principal.id, () => this.db.query(`update public.social_posts set status = 'approved' where id = $1`, [postId]));
  }
}

export const readRow = <T = Record<string, any>>(db: Db, sql: string, params: unknown[] = []) => asOwner(db, () => rows<T>(db, sql, params));
