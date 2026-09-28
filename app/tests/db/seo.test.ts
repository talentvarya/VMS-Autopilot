import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GENERIC_AUDIT_ERROR, executeAuditRun, failStaleRuns, type Queryable } from '@/lib/seo/run-audit';
import { runAudit } from '@/lib/seo/engine';
import { FIXTURE_SITES } from '@/lib/seo/fixtures';
import { AUDIT_SOURCES, CATEGORIES, FIX_STATUSES, RUN_STATUSES, SEVERITIES } from '@/lib/seo/types';
import { ID, asOwner, asService, asUser, createDb, rows, seedFixture, useRollbackPerTest, type Db } from './harness';

let db: Db;
beforeAll(async () => {
  db = await createDb();
  await seedFixture(db);
});
afterAll(async () => {
  await db.close();
});
useRollbackPerTest(() => db);

const asAdmin = <T,>(fn: () => Promise<T>) => asUser(db, ID.agencyAdmin, fn);
const asClient = <T,>(fn: () => Promise<T>) => asUser(db, ID.clientNova, fn);
const asTeam = <T,>(fn: () => Promise<T>) => asUser(db, ID.teamMember, fn);
const q: Queryable = { query: (sql, params) => db.query(sql, params) as never };

const NOVA_ORIGIN = 'https://nova-clinic.example.test';
const addSite = (ws: string = ID.nova, origin = NOVA_ORIGIN, label = 'Nova Clinic (sample)') =>
  asAdmin(() => rows<{ id: string }>(db, `insert into public.sites (workspace_id, origin, label) values ($1, $2, $3) returning id`, [ws, origin, label]));
const requestRun = (uid: string, ws: string, site: string) =>
  asUser(db, uid, () => rows<{ id: string }>(db, `insert into public.audit_runs (workspace_id, site_id) values ($1, $2) returning id`, [ws, site]));
const grant = (module: string, action: string, userId: string | null = null) =>
  asAdmin(() => db.query(`insert into public.permission_grants (workspace_id, user_id, module, action) values ($1, $2, $3::public.permission_module, $4::public.permission_action)`, [ID.nova, userId, module, action]));
const audit = (ws: string) => asOwner(db, () => rows<{ action: string; actor_role: string | null }>(db, `select action, actor_role from public.audit_log where workspace_id = $1 and module = 'seo_geo' order by id`, [ws]));

/** Set up Nova's site and a completed sample audit, run by the server. */
async function completedRun() {
  const [{ id: siteId }] = await addSite();
  const [{ id: runId }] = await requestRun(ID.clientNova, ID.nova, siteId);
  const outcome = await asService(db, () => executeAuditRun(q, runId));
  return { siteId, runId, outcome };
}

describe('schema matches the TypeScript vocabulary', () => {
  const labels = async (type: string) => (await rows<{ l: string }>(db, `select unnest(enum_range(null::public.${type}))::text as l`)).map((r) => r.l);
  it('has identical enum values', async () => {
    expect(await labels('audit_run_status')).toEqual([...RUN_STATUSES]);
    expect(await labels('audit_source')).toEqual([...AUDIT_SOURCES]);
    expect(await labels('finding_severity')).toEqual([...SEVERITIES]);
    expect(await labels('finding_category')).toEqual([...CATEGORIES]);
    expect(await labels('fix_status')).toEqual([...FIX_STATUSES]);
  });
  it('locks all three new tables with Row Level Security and gives anon nothing', async () => {
    const off = await rows(db, `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
    expect(off).toEqual([]);
    for (const t of ['sites', 'audit_runs', 'audit_findings']) {
      await expect(asUser(db, null, () => db.query(`select * from public.${t}`)), t).rejects.toThrow(/permission denied/);
    }
  });
});

describe('websites', () => {
  it('an Admin registers a client website; a Client cannot', async () => {
    const [{ id }] = await addSite();
    expect(id).toBeTruthy();
    await expect(asClient(() => db.query(`insert into public.sites (workspace_id, origin, label) values ($1, 'https://other.example.test', 'x')`, [ID.nova]))).rejects.toThrow(/row-level security/);
    await expect(asTeam(() => db.query(`insert into public.sites (workspace_id, origin, label) values ($1, 'https://other.example.test', 'x')`, [ID.nova]))).rejects.toThrow(/row-level security/);
    await expect(asUser(db, ID.otherAgencyAdmin, () => db.query(`insert into public.sites (workspace_id, origin, label) values ($1, 'https://other.example.test', 'x')`, [ID.nova]))).rejects.toThrow(/row-level security/);
  });

  it('a team member can add one only after an Admin allows editing SEO/GEO', async () => {
    await grant('seo_geo', 'view', ID.teamMember);
    await grant('seo_geo', 'edit', ID.teamMember);
    const [row] = await asTeam(() => rows(db, `insert into public.sites (workspace_id, origin, label) values ($1, 'https://team.example.test', 'Team added') returning label`, [ID.nova]));
    expect(row).toEqual({ label: 'Team added' });
  });

  it('only accepts a clean lower-case address with no path', async () => {
    for (const bad of ['https://Nova.example.test', 'https://nova.example.test/about', 'ftp://nova.example.test', 'nova.example.test', 'https://', 'https://a b.test', 'javascript:alert(1)']) {
      await expect(addSite(ID.nova, bad), bad).rejects.toThrow(/check constraint/);
    }
  });

  it('belongs to a client workspace and is unique per workspace', async () => {
    await expect(addSite(ID.acme)).rejects.toThrow(/client workspaces/);
    await addSite();
    await expect(addSite()).rejects.toThrow(/duplicate key/);
  });

  it('cannot be moved to another workspace or another address', async () => {
    const [{ id }] = await addSite();
    await expect(asAdmin(() => db.query(`update public.sites set origin = 'https://x.example.test' where id = $1`, [id]))).rejects.toThrow(/permission denied/);
    await expect(asOwner(db, () => db.query(`update public.sites set origin = 'https://x.example.test' where id = $1`, [id]))).rejects.toThrow(/cannot be changed/);
    await asAdmin(() => db.query(`update public.sites set label = 'Renamed' where id = $1`, [id]));
  });

  it('is visible only inside its own workspace', async () => {
    await addSite();
    await addSite(ID.bright, 'https://brighthomes.example.test', 'Bright');
    const seen = (uid: string) => asUser(db, uid, async () => (await rows<{ workspace_id: string }>(db, `select workspace_id from public.sites`)).map((r) => r.workspace_id));
    expect(await seen(ID.clientNova)).toEqual([ID.nova]);
    expect(await seen(ID.clientBright)).toEqual([ID.bright]);
    expect((await seen(ID.agencyAdmin)).sort()).toEqual([ID.bright, ID.nova].sort());
    expect(await seen(ID.otherAgencyAdmin)).toEqual([]);
    expect(await seen(ID.outsider)).toEqual([]);
    expect(await seen(ID.teamMember)).toEqual([]); // no SEO/GEO permission yet
  });
});

describe('requesting an audit - what a Client is allowed to do', () => {
  it('a Client can queue a sample audit, attributed to them', async () => {
    const [{ id: siteId }] = await addSite();
    const [{ id }] = await requestRun(ID.clientNova, ID.nova, siteId);
    const [run] = await asOwner(db, () => rows(db, `select status::text, source::text, requested_by, overall_score from public.audit_runs where id = $1`, [id]));
    expect(run).toEqual({ status: 'queued', source: 'fixture', requested_by: ID.clientNova, overall_score: null });
    expect((await audit(ID.nova)).map((a) => a.action)).toContain('audit.requested');
  });

  it('cannot pick a live audit, set a status, or write results', async () => {
    const [{ id: siteId }] = await addSite();
    for (const [column, value] of [['source', `'live'`], ['status', `'completed'`], ['overall_score', '99'], ['requested_by', `'${ID.agencyAdmin}'`], ['error', `'x'`]]) {
      await expect(asClient(() => db.query(
        `insert into public.audit_runs (workspace_id, site_id, ${column}) values ($1, $2, ${value})`, [ID.nova, siteId])), column).rejects.toThrow(/permission denied/);
    }
  });

  it('cannot audit a website of another workspace or another client', async () => {
    const [{ id: novaSite }] = await addSite();
    const [{ id: brightSite }] = await addSite(ID.bright, 'https://brighthomes.example.test', 'Bright');
    await expect(requestRun(ID.clientNova, ID.bright, brightSite)).rejects.toThrow(/row-level security/);
    await expect(requestRun(ID.clientNova, ID.nova, brightSite)).rejects.toThrow(/does not exist in this workspace/);
    await expect(requestRun(ID.clientBright, ID.nova, novaSite)).rejects.toThrow(/row-level security/);
    await expect(requestRun(ID.outsider, ID.nova, novaSite)).rejects.toThrow(/row-level security/);
    await expect(requestRun(ID.otherAgencyAdmin, ID.nova, novaSite)).rejects.toThrow(/row-level security/);
  });

  it('cannot audit an archived website', async () => {
    const [{ id: siteId }] = await addSite();
    await asAdmin(() => db.query(`update public.sites set archived_at = now() where id = $1`, [siteId]));
    await expect(requestRun(ID.clientNova, ID.nova, siteId)).rejects.toThrow(/does not exist in this workspace/);
  });

  it('is rate-limited: 5 per website and 20 per workspace per day', async () => {
    const [{ id: siteId }] = await addSite();
    for (let i = 0; i < 5; i++) await requestRun(ID.clientNova, ID.nova, siteId);
    await expect(requestRun(ID.clientNova, ID.nova, siteId)).rejects.toThrow(/limit reached for this website/);
    // spread across other sites to hit the workspace limit
    for (let s = 0; s < 3; s++) {
      const [{ id }] = await addSite(ID.nova, `https://site${s}.example.test`, `Site ${s}`);
      for (let i = 0; i < 5; i++) await requestRun(ID.clientNova, ID.nova, id);
    }
    const [{ id: last }] = await addSite(ID.nova, 'https://last.example.test', 'Last');
    await expect(requestRun(ID.clientNova, ID.nova, last)).rejects.toThrow(/limit reached for this workspace/);
    // another client workspace is unaffected
    const [{ id: b }] = await addSite(ID.bright, 'https://brighthomes.example.test', 'Bright');
    await requestRun(ID.clientBright, ID.bright, b);
  });

  it('cannot change or delete a run afterwards', async () => {
    const [{ id: siteId }] = await addSite();
    const [{ id }] = await requestRun(ID.clientNova, ID.nova, siteId);
    await expect(asClient(() => db.query(`update public.audit_runs set status = 'completed' where id = $1`, [id]))).rejects.toThrow(/permission denied/);
    await expect(asAdmin(() => db.query(`update public.audit_runs set overall_score = 100 where id = $1`, [id]))).rejects.toThrow(/permission denied/);
    await expect(asClient(() => db.query(`delete from public.audit_runs where id = $1`, [id]))).rejects.toThrow(/permission denied/);
    await expect(asAdmin(() => db.query(`delete from public.audit_runs where id = $1`, [id]))).rejects.toThrow(/permission denied/);
  });

  it('a team member needs an Admin to allow viewing and running', async () => {
    const [{ id: siteId }] = await addSite();
    await expect(requestRun(ID.teamMember, ID.nova, siteId)).rejects.toThrow(/row-level security/);
    await grant('seo_geo', 'view', ID.teamMember);
    await grant('seo_geo', 'create', ID.teamMember);
    await requestRun(ID.teamMember, ID.nova, siteId);
  });
});

describe('the server runs the audit', () => {
  it('completes the run, saves the same findings the engine produces, and records it', async () => {
    const { runId, outcome } = await completedRun();
    expect(outcome).toEqual({ runId, status: 'completed' });

    const expected = runAudit(FIXTURE_SITES[0].snapshot, { businessType: 'local' });
    const [run] = await asOwner(db, () => rows(db, `select status::text, overall_score, engine_version, started_at is not null as started, finished_at is not null as finished, counts from public.audit_runs where id = $1`, [runId]));
    expect(run).toMatchObject({ status: 'completed', overall_score: expected.overallScore, engine_version: expected.engineVersion, started: true, finished: true });
    expect(run.counts).toEqual(expected.counts);
    const saved = await asOwner(db, () => rows<{ code: string }>(db, `select code from public.audit_findings where run_id = $1`, [runId]));
    expect(saved.map((f) => f.code).sort()).toEqual(expected.findings.map((f) => f.code).sort());

    const actions = (await audit(ID.nova)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['site.added', 'audit.requested', 'audit.running', 'audit.completed']));
  });

  it('shows the finished report to the Client of that workspace only', async () => {
    const { runId } = await completedRun();
    const count = (uid: string) => asUser(db, uid, async () => (await rows(db, `select 1 from public.audit_findings where run_id = $1`, [runId])).length);
    expect(await count(ID.clientNova)).toBeGreaterThan(10);
    expect(await count(ID.clientNova2)).toBeGreaterThan(10);
    expect(await count(ID.agencyAdmin)).toBeGreaterThan(10);
    expect(await count(ID.clientBright)).toBe(0);
    expect(await count(ID.outsider)).toBe(0);
    expect(await count(ID.otherAgencyAdmin)).toBe(0);
    expect(await count(ID.teamMember)).toBe(0);
  });

  it('records a failure clearly, and never a half-finished report', async () => {
    const [{ id: siteId }] = await addSite(ID.nova, 'https://not-a-sample.example.test', 'Unknown');
    const [{ id }] = await requestRun(ID.clientNova, ID.nova, siteId);
    const outcome = await asService(db, () => executeAuditRun(q, id));
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/not one of the built-in sample sites/);
    const [run] = await asOwner(db, () => rows(db, `select status::text, error, finished_at is not null as finished from public.audit_runs where id = $1`, [id]));
    expect(run).toMatchObject({ status: 'failed', finished: true });
    expect(await asOwner(db, () => rows(db, `select 1 from public.audit_findings where run_id = $1`, [id]))).toEqual([]);
    expect((await audit(ID.nova)).map((a) => a.action)).toContain('audit.failed');
  });

  it('refuses to run a live audit while live audits are switched off', async () => {
    const [{ id: siteId }] = await addSite();
    const [{ id }] = await requestRun(ID.clientNova, ID.nova, siteId);
    // Only the server could ever set this (the app cannot); we do it as the owner to test the runner.
    await asOwner(db, () => db.query(`alter table public.audit_runs disable trigger audit_runs_before`));
    await asOwner(db, () => db.query(`update public.audit_runs set source = 'live' where id = $1`, [id]));
    await asOwner(db, () => db.query(`alter table public.audit_runs enable trigger audit_runs_before`));
    const outcome = await asService(db, () => executeAuditRun(q, id));
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/switched off/);
  });

  it('will not run the same audit twice, or one that does not exist', async () => {
    const { runId } = await completedRun();
    await expect(asService(db, () => executeAuditRun(q, runId))).rejects.toThrow(/completed, not queued/);
    await expect(asService(db, () => executeAuditRun(q, '99999999-9999-4999-8999-999999999999'))).rejects.toThrow(/does not exist/);
  });

  it('only moves forward through the allowed states, and finished runs are frozen', async () => {
    const [{ id: siteId }] = await addSite();
    const [{ id }] = await requestRun(ID.clientNova, ID.nova, siteId);
    const set = (sql: string) => asService(db, () => db.query(`update public.audit_runs set ${sql} where id = $1`, [id]));
    await expect(set(`status = 'completed'`)).rejects.toThrow(/cannot go from queued to completed/);
    await set(`status = 'running'`);
    await expect(set(`status = 'queued'`)).rejects.toThrow(/cannot go from running to queued/);
    await set(`status = 'completed', overall_score = 80`);
    await expect(set(`overall_score = 100`)).rejects.toThrow(/finished and cannot be changed/);
    await expect(set(`status = 'failed'`)).rejects.toThrow(/finished/);
  });

  it('rejects an impossible score', async () => {
    const [{ id: siteId }] = await addSite();
    const [{ id }] = await requestRun(ID.clientNova, ID.nova, siteId);
    await asService(db, () => db.query(`update public.audit_runs set status = 'running' where id = $1`, [id]));
    await expect(asService(db, () => db.query(`update public.audit_runs set status = 'completed', overall_score = 150 where id = $1`, [id]))).rejects.toThrow(/check constraint/);
  });
});

describe('findings can never be tampered with', () => {
  it('nobody using the app can add findings, and the server can only add them to a running audit of the right workspace', async () => {
    const { runId } = await completedRun();
    const insert = `insert into public.audit_findings (run_id, workspace_id, category, severity, code, title) values ($1, $2, 'geo', 'pass', 'fake.one', 'Fake')`;
    for (const uid of [ID.clientNova, ID.agencyAdmin, ID.teamMember]) {
      await expect(asUser(db, uid, () => db.query(insert, [runId, ID.nova]))).rejects.toThrow(/permission denied/);
    }
    await expect(asService(db, () => db.query(insert, [runId, ID.nova]))).rejects.toThrow(/running audit/); // completed run
    const [{ id: siteId }] = await addSite(ID.nova, 'https://second.example.test', 'Second');
    const [{ id: r2 }] = await requestRun(ID.clientNova, ID.nova, siteId);
    await asService(db, () => db.query(`update public.audit_runs set status = 'running' where id = $1`, [r2]));
    await expect(asService(db, () => db.query(insert, [r2, ID.bright]))).rejects.toThrow(/same workspace/);
    await asService(db, () => db.query(insert, [r2, ID.nova]));
  });

  it('cannot be edited even by the server - only the fix record can change', async () => {
    const { runId } = await completedRun();
    const [{ id }] = await asOwner(db, () => rows<{ id: string }>(db, `select id from public.audit_findings where run_id = $1 limit 1`, [runId]));
    for (const col of ["title = 'Rewritten'", "evidence = 'Rewritten'", "severity = 'pass'", "category = 'geo'", "code = 'x.y'", "recommendation = ''"]) {
      await expect(asService(db, () => db.query(`update public.audit_findings set ${col} where id = $1`, [id])), col).rejects.toThrow(/cannot be edited/);
    }
    await expect(asClient(() => db.query(`update public.audit_findings set title = 'x' where id = $1`, [id]))).rejects.toThrow(/permission denied/);
    await expect(asAdmin(() => db.query(`update public.audit_findings set severity = 'pass' where id = $1`, [id]))).rejects.toThrow(/permission denied/);
    await expect(asAdmin(() => db.query(`delete from public.audit_findings where id = $1`, [id]))).rejects.toThrow(/permission denied/);
  });
});

describe('applying a recommendation is Admin-only', () => {
  const pickFinding = (runId: string) => asOwner(db, async () => (await rows<{ id: string }>(db, `select id from public.audit_findings where run_id = $1 and severity <> 'pass' limit 1`, [runId]))[0].id);
  const fix = (uid: string, id: string, status: string, note: string | null = null) =>
    asUser(db, uid, () => db.query(`update public.audit_findings set fix_status = $2::public.fix_status, fix_note = $3 where id = $1 returning id`, [id, status, note]));

  it('an Admin records a fix; it is stamped and audited', async () => {
    const { runId } = await completedRun();
    const id = await pickFinding(runId);
    expect((await fix(ID.agencyAdmin, id, 'applied', 'Added the missing alt text')).rows).toHaveLength(1);
    const [f] = await asOwner(db, () => rows(db, `select fix_status::text, fix_note, fixed_by, fixed_at is not null as stamped from public.audit_findings where id = $1`, [id]));
    expect(f).toEqual({ fix_status: 'applied', fix_note: 'Added the missing alt text', fixed_by: ID.agencyAdmin, stamped: true });
    expect((await audit(ID.nova)).map((a) => a.action)).toContain('finding.fix_applied');
    await fix(ID.agencyAdmin, id, 'open');
    const [g] = await asOwner(db, () => rows(db, `select fixed_by, fixed_at from public.audit_findings where id = $1`, [id]));
    expect(g).toEqual({ fixed_by: null, fixed_at: null });
  });

  it('a Client can read the fix status but never change it', async () => {
    const { runId } = await completedRun();
    const id = await pickFinding(runId);
    expect((await fix(ID.clientNova, id, 'applied')).rows).toEqual([]);
    expect((await fix(ID.clientNova2, id, 'wont_fix')).rows).toEqual([]);
    expect((await asOwner(db, () => rows(db, `select fix_status::text from public.audit_findings where id = $1`, [id])))[0].fix_status).toBe('open');
  });

  it('not even a Client an Admin has trusted with "apply fixes" can do it directly - it needs approval', async () => {
    const { runId } = await completedRun();
    const id = await pickFinding(runId);
    await grant('seo_geo', 'publish_execute');
    expect((await fix(ID.clientNova, id, 'applied')).rows).toEqual([]); // still blocked: sensitive => approval
    const [{ id: approvalId }] = await asClient(() => rows<{ id: string }>(db,
      `insert into public.approval_requests (workspace_id, module, action, title) values ($1, 'seo_geo', 'publish_execute', 'Apply fix') returning id`, [ID.nova]));
    expect(approvalId).toBeTruthy();
  });

  it('a team member cannot either, and other agencies see nothing', async () => {
    const { runId } = await completedRun();
    const id = await pickFinding(runId);
    await grant('seo_geo', 'view', ID.teamMember);
    await grant('seo_geo', 'publish_execute', ID.teamMember);
    expect((await fix(ID.teamMember, id, 'applied')).rows).toEqual([]);
    expect((await fix(ID.otherAgencyAdmin, id, 'applied')).rows).toEqual([]);
  });

  it('the who-and-when stamps cannot be forged', async () => {
    const { runId } = await completedRun();
    const id = await pickFinding(runId);
    await expect(asAdmin(() => db.query(`update public.audit_findings set fixed_by = $2 where id = $1`, [id, ID.clientNova]))).rejects.toThrow(/permission denied/);
    await expect(asOwner(db, () => db.query(`update public.audit_findings set fixed_by = $2 where id = $1`, [id, ID.clientNova]))).rejects.toThrow(/set by the system/);
    await expect(asService(db, () => db.query(`update public.audit_findings set fix_status = 'applied' where id = $1`, [id]))).rejects.toThrow(/must name the Admin/);
  });
});

describe('hardening from the independent review', () => {
  it('a server-side fix record must name a real Admin of that workspace', async () => {
    const { runId } = await completedRun();
    const [{ id }] = await asOwner(db, () => rows<{ id: string }>(db, `select id from public.audit_findings where run_id = $1 and severity <> 'pass' limit 1`, [runId]));
    const set = (who: string) => asService(db, () => db.query(`update public.audit_findings set fix_status = 'applied', fixed_by = $2 where id = $1`, [id, who]));
    await expect(set(ID.clientNova)).rejects.toThrow(/must name the Admin/);
    await expect(set(ID.otherAgencyAdmin)).rejects.toThrow(/must name the Admin/);
    await expect(set(ID.teamMember)).rejects.toThrow(/must name the Admin/);
    await set(ID.agencyAdmin);
    const log = await asOwner(db, () => rows<{ metadata: { fixed_by: string } }>(db, `select metadata from public.audit_log where action = 'finding.fix_applied'`));
    expect(log[0].metadata.fixed_by).toBe(ID.agencyAdmin);
  });

  it('changing a fix note is written to the audit trail, not done silently', async () => {
    const { runId } = await completedRun();
    const [{ id }] = await asOwner(db, () => rows<{ id: string }>(db, `select id from public.audit_findings where run_id = $1 and severity <> 'pass' limit 1`, [runId]));
    await asAdmin(() => db.query(`update public.audit_findings set fix_status = 'applied', fix_note = 'first' where id = $1`, [id]));
    await asAdmin(() => db.query(`update public.audit_findings set fix_note = 'rewritten' where id = $1`, [id]));
    expect((await audit(ID.nova)).map((a) => a.action)).toEqual(expect.arrayContaining(['finding.fix_applied', 'finding.fix_note_changed']));
  });

  it('not even the server key can delete or empty audit data', async () => {
    const { runId, siteId } = await completedRun();
    await expect(asService(db, () => db.query(`delete from public.audit_findings where run_id = $1`, [runId]))).rejects.toThrow(/permission denied/);
    await expect(asService(db, () => db.query(`delete from public.audit_runs where id = $1`, [runId]))).rejects.toThrow(/permission denied/);
    await expect(asService(db, () => db.query(`delete from public.sites where id = $1`, [siteId]))).rejects.toThrow(/permission denied/);
    await expect(asService(db, () => db.query(`truncate public.audit_findings`))).rejects.toThrow(/permission denied/);
  });

  it('serialises audit requests per workspace so parallel requests cannot slip past the daily limit', async () => {
    // PGlite has a single connection, so genuine parallelism cannot be simulated here. What CAN be
    // checked is that the trigger takes a per-workspace lock before it counts; on a real Postgres
    // that makes simultaneous requests queue up. (Re-test with parallel requests on the test project.)
    const [{ def }] = await rows<{ def: string }>(db, `select pg_get_functiondef('private.trg_run_before'::regproc) as def`);
    expect(def).toContain('pg_advisory_xact_lock(hashtextextended(new.workspace_id::text, 0))');
    expect(def.indexOf('pg_advisory_xact_lock')).toBeLessThan(def.indexOf('count(*)'));
    // and the limit itself still counts exactly, one request after another
    const [{ id: siteId }] = await addSite();
    const results = [];
    for (let i = 0; i < 8; i++) results.push(await requestRun(ID.clientNova, ID.nova, siteId).then(() => 'ok', () => 'refused'));
    expect(results.filter((r) => r === 'ok')).toHaveLength(5);
    expect(results.filter((r) => r === 'refused')).toHaveLength(3);
  });
});

describe('the runner under stress (from the security review)', () => {
  it('two workers racing for one queued run: exactly one wins, the other stops without harming the run', async () => {
    const [{ id: siteId }] = await addSite();
    const [{ id: runId }] = await requestRun(ID.clientNova, ID.nova, siteId);
    let raced = false;
    // Worker B grabs the run in the gap between worker A reading it and claiming it.
    const racing: Queryable = {
      query: async (sql, params) => {
        if (!raced && sql.includes("set status = 'running'")) {
          raced = true;
          await db.query(`update public.audit_runs set status = 'running' where id = $1`, [runId]);
        }
        return db.query(sql, params) as never;
      },
    };
    // Assert INSIDE the session, so the winning worker's update is not rolled back with the error.
    await asService(db, async () => {
      await expect(executeAuditRun(racing, runId)).rejects.toThrow(/already picked up/);
    });
    const [run] = await asOwner(db, () => rows(db, `select status::text, error from public.audit_runs where id = $1`, [runId]));
    expect(run).toEqual({ status: 'running', error: null }); // untouched: not failed, not double-run
    expect(await asOwner(db, () => rows(db, `select 1 from public.audit_findings where run_id = $1`, [runId]))).toEqual([]);
  });

  it('never stores internal error detail where a Client can read it', async () => {
    const [{ id: siteId }] = await addSite();
    const [{ id }] = await requestRun(ID.clientNova, ID.nova, siteId);
    const leaky = () => ({ kind: 'fixture' as const, getSnapshot: async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2 Authorization: Bearer sk-live-abc123'); } });
    const outcome = await asService(db, () => executeAuditRun(q, id, leaky));
    expect(outcome).toMatchObject({ status: 'failed', error: GENERIC_AUDIT_ERROR });
    const seen = await asClient(() => rows<{ error: string }>(db, `select error from public.audit_runs where id = $1`, [id]));
    expect(seen[0].error).toBe(GENERIC_AUDIT_ERROR);
    for (const secret of ['10.0.0.5', 'hunter2', 'sk-live', 'Bearer', 'ECONNREFUSED']) expect(seen[0].error).not.toContain(secret);
  });

  it('fails a run whose worker crashed, and leaves fresh and finished runs alone', async () => {
    const [{ id: siteId }] = await addSite();
    const [{ id: stuck }] = await requestRun(ID.clientNova, ID.nova, siteId);
    const [{ id: fresh }] = await requestRun(ID.clientNova, ID.nova, siteId);
    const [{ id: queued }] = await requestRun(ID.clientNova, ID.nova, siteId);
    await asService(db, () => db.query(`update public.audit_runs set status = 'running' where id in ($1, $2)`, [stuck, fresh]));
    // Make one look like it has been running for an hour (owner only: the app can never do this).
    await asOwner(db, () => db.exec(`alter table public.audit_runs disable trigger audit_runs_before`));
    await asOwner(db, () => db.query(`update public.audit_runs set started_at = now() - interval '1 hour' where id = $1`, [stuck]));
    await asOwner(db, () => db.exec(`alter table public.audit_runs enable trigger audit_runs_before`));

    expect(await asService(db, () => failStaleRuns(q, 15))).toBe(1);
    const status = async (id: string) => (await asOwner(db, () => rows<{ s: string; error: string | null }>(db, `select status::text as s, error from public.audit_runs where id = $1`, [id])))[0];
    expect(await status(stuck)).toEqual({ s: 'failed', error: 'The audit took too long and was stopped.' });
    expect((await status(fresh)).s).toBe('running');
    expect((await status(queued)).s).toBe('queued');
  });
});
