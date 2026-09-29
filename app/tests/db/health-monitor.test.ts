import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ID, asOwner, asService, asUser, createDb, rows, seedFixture, useRollbackPerTest, type Db } from './harness';

/**
 * Proves, against real Postgres, that health_monitor stays exactly what Phase 1 already made
 * it: a module NO non-admin role can ever hold any action on, with or without a grant - not a
 * new rule invented for Sub-phase D, just reused.
 */

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

const audit = () =>
  asOwner(db, () => rows<{ action: string }>(db, `select action from public.audit_log where workspace_id = $1 and module = 'health_monitor' order by id`, [ID.nova]));

describe('health_monitor cannot be granted to anyone but an Admin, at all', () => {
  it('refuses a grant of health_monitor:view to a Client', async () => {
    await expect(
      asAdmin(() => db.query(`insert into public.permission_grants (workspace_id, user_id, module, action) values ($1, $2, 'health_monitor', 'view')`, [ID.nova, ID.clientNova])),
    ).rejects.toThrow(/can never be given/);
  });

  it('refuses a grant of health_monitor:edit to a Team member', async () => {
    await expect(
      asAdmin(() => db.query(`insert into public.permission_grants (workspace_id, user_id, module, action) values ($1, $2, 'health_monitor', 'edit')`, [ID.nova, ID.teamMember])),
    ).rejects.toThrow(/can never be given/);
  });
});

describe('health_checks', () => {
  it('an Admin can record one; a Client can never see it', async () => {
    const [{ id }] = await asAdmin(() => rows<{ id: string }>(db, `insert into public.health_checks (workspace_id, check_type, status, details) values ($1, 'website_availability', 'pass', '{}') returning id`, [ID.nova]));
    expect(await asAdmin(() => rows(db, `select id from public.health_checks where id = $1`, [id]))).toHaveLength(1);
    expect(await asClient(() => rows(db, `select id from public.health_checks where id = $1`, [id]))).toHaveLength(0);
    expect(await asTeam(() => rows(db, `select id from public.health_checks where id = $1`, [id]))).toHaveLength(0);
  });

  it('a Client or Team member cannot insert one', async () => {
    await expect(asClient(() => db.query(`insert into public.health_checks (workspace_id, check_type, status) values ($1, 'website_availability', 'pass')`, [ID.nova]))).rejects.toThrow(/row-level security/);
    await expect(asTeam(() => db.query(`insert into public.health_checks (workspace_id, check_type, status) values ($1, 'website_availability', 'pass')`, [ID.nova]))).rejects.toThrow(/row-level security/);
  });

  it('is audited, with a "failed" result for a fail-status check', async () => {
    await asAdmin(() => db.query(`insert into public.health_checks (workspace_id, check_type, status) values ($1, 'website_availability', 'fail')`, [ID.nova]));
    const [row] = await asOwner(db, () => rows<{ action: string; result: string }>(db, `select action, result::text from public.audit_log where workspace_id = $1 and module = 'health_monitor' order by id desc limit 1`, [ID.nova]));
    expect(row.action).toBe('health.check_fail');
    expect(row.result).toBe('failed');
  });
});

describe('health_incidents', () => {
  it('an Admin can open and later close one', async () => {
    const [{ id }] = await asAdmin(() =>
      rows<{ id: string }>(db, `insert into public.health_incidents (workspace_id, check_type, auto_repair_attempted, auto_repair_action) values ($1, 'stale_audits', true, 'check_stale_audits') returning id`, [ID.nova]),
    );
    let row = (await asOwner(db, () => rows<any>(db, `select closed_at, resolved_by from public.health_incidents where id = $1`, [id])))[0];
    expect(row.closed_at).toBeNull();

    await asAdmin(() => db.query(`update public.health_incidents set closed_at = now() where id = $1`, [id]));
    row = (await asOwner(db, () => rows<any>(db, `select closed_at, resolved_by, resolved_at from public.health_incidents where id = $1`, [id])))[0];
    expect(row.closed_at).not.toBeNull();
    expect(row.resolved_by).toBe(ID.agencyAdmin);
    expect(row.resolved_at).not.toBeNull();
  });

  it('refuses to change an incident that is already closed', async () => {
    const [{ id }] = await asAdmin(() => rows<{ id: string }>(db, `insert into public.health_incidents (workspace_id, check_type) values ($1, 'stale_audits') returning id`, [ID.nova]));
    await asAdmin(() => db.query(`update public.health_incidents set closed_at = now() where id = $1`, [id]));
    await expect(asAdmin(() => db.query(`update public.health_incidents set auto_repair_attempted = false where id = $1`, [id]))).rejects.toThrow(/already closed/);
  });

  it('history is never deleted, not even by the server', async () => {
    const [{ id }] = await asAdmin(() => rows<{ id: string }>(db, `insert into public.health_incidents (workspace_id, check_type) values ($1, 'stale_audits') returning id`, [ID.nova]));
    await expect(asService(db, () => db.query(`delete from public.health_incidents where id = $1`, [id]))).rejects.toThrow(/permission denied/);
  });

  it('opening and closing both reach the audit log', async () => {
    const [{ id }] = await asAdmin(() => rows<{ id: string }>(db, `insert into public.health_incidents (workspace_id, check_type) values ($1, 'stale_audits') returning id`, [ID.nova]));
    await asAdmin(() => db.query(`update public.health_incidents set closed_at = now() where id = $1`, [id]));
    const events = (await audit()).map((e) => e.action);
    expect(events).toEqual(expect.arrayContaining(['health.incident_opened', 'health.incident_closed']));
  });
});
