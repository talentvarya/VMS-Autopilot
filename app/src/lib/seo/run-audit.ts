import { runAudit } from './engine';
import { createSource, type SnapshotSource } from './sources';
import type { AuditSource } from './types';

/**
 * Server-side runner: takes a queued audit run, executes it, saves the results.
 *
 * It must be called with SERVER credentials (the service role) - the database refuses these
 * writes from anyone using the app, on purpose. It only ever READS a website snapshot; it can
 * never change a website. The database is reached through the tiny `Queryable` interface so the
 * same code runs against Supabase later and against the in-memory test database today.
 *
 * The CALLER must have checked that the person who asked is allowed to run this audit: this
 * function trusts the run id it is given.
 */

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface RunOutcome {
  runId: string;
  status: 'completed' | 'failed';
  error?: string;
}

/**
 * Only these errors have wording that is safe to show a Client. Anything else (a database
 * error, a future network error mentioning an internal address, ...) is replaced by a generic
 * sentence, because clients can read `audit_runs.error`. The detail belongs in the server log.
 */
const CLIENT_SAFE_ERRORS = new Set(['LiveAuditsDisabledError', 'UnknownSampleSiteError']);
export const GENERIC_AUDIT_ERROR = 'The audit could not be completed. Please try again, or ask your agency.';

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && CLIENT_SAFE_ERRORS.has(error.name)) return error.message.replace(/\s+/g, ' ').slice(0, 300);
  // TEMPORARY DEBUG - live audits have never been exercised against a real site before; show the
  // real cause once to diagnose (handles plain objects like PostgrestError too, not just Error
  // instances), then revert to GENERIC_AUDIT_ERROR.
  if (error instanceof Error) return `[DEBUG] ${error.name}: ${error.message}`.replace(/\s+/g, ' ').slice(0, 300);
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>;
    return `[DEBUG] ${String(e.code ?? '(no code)')}: ${String(e.message ?? JSON.stringify(e))}`.replace(/\s+/g, ' ').slice(0, 300);
  }
  return `[DEBUG] non-object error: ${String(error)}`.slice(0, 300) || GENERIC_AUDIT_ERROR;
}

export async function executeAuditRun(
  db: Queryable,
  runId: string,
  sourceFor: (kind: AuditSource) => SnapshotSource = createSource,
): Promise<RunOutcome> {
  const { rows } = await db.query<{ id: string; status: string; source: AuditSource; workspace_id: string; origin: string; business_type: 'local' | 'online' }>(
    `select r.id, r.status::text, r.source::text as source, r.workspace_id, s.origin, s.business_type
       from public.audit_runs r join public.sites s on s.id = r.site_id where r.id = $1`,
    [runId],
  );
  const run = rows[0];
  if (!run) throw new Error('That audit run does not exist.');
  if (run.status !== 'queued') throw new Error(`That audit run is ${run.status}, not queued.`);

  // Claim the run in ONE atomic step: if two workers race, exactly one gets it.
  const claimed = await db.query(`update public.audit_runs set status = 'running' where id = $1 and status = 'queued' returning id`, [runId]);
  if (claimed.rows.length === 0) throw new Error('That audit run was already picked up by another worker.');

  try {
    const snapshot = await sourceFor(run.source).getSnapshot(run.origin);
    const result = runAudit(snapshot, { businessType: run.business_type });

    // ONE statement saves every finding and completes the run, so a crash can never leave a
    // half-written report that looks finished.
    await db.query(
      `with saved as (
         insert into public.audit_findings (run_id, workspace_id, category, severity, code, title, evidence, recommendation)
         select $1::uuid, $2::uuid, f.category::public.finding_category, f.severity::public.finding_severity, f.code, f.title, f.evidence, f.recommendation
           from jsonb_to_recordset($3::jsonb) as f(category text, severity text, code text, title text, evidence text, recommendation text)
         returning 1
       )
       update public.audit_runs
          set status = 'completed', engine_version = $4, overall_score = $5, overall_note = $6,
              category_scores = $7::jsonb, counts = $8::jsonb
        where id = $1::uuid and status = 'running'
          and (select count(*) from saved) >= 0`,
      [
        runId, run.workspace_id, JSON.stringify(result.findings), result.engineVersion, result.overallScore,
        result.overallNote, JSON.stringify(result.categoryScores), JSON.stringify(result.counts),
      ],
    );
    return { runId, status: 'completed' };
  } catch (error) {
    const message = safeErrorMessage(error);
    // Nothing was saved (the save above is all-or-nothing); just record the failure.
    await db.query(`update public.audit_runs set status = 'failed', error = $2 where id = $1 and status = 'running'`, [runId, message]);
    return { runId, status: 'failed', error: message };
  }
}

/**
 * A worker that crashes after claiming a run would leave it "running" forever. Call this on a
 * schedule (for example every few minutes) to fail runs that have been running too long.
 */
export async function failStaleRuns(db: Queryable, olderThanMinutes = 15): Promise<number> {
  const { rows } = await db.query(
    `update public.audit_runs
        set status = 'failed', error = 'The audit took too long and was stopped.'
      where status = 'running' and started_at < now() - make_interval(mins => $1::int)
      returning id`,
    [olderThanMinutes],
  );
  return rows.length;
}
