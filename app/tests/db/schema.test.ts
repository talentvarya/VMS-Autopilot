import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACTIONS, APPROVAL_STATUSES, AUDIT_RESULTS, CEILING_ROWS, DEFAULT_ROWS, MODULES, ROLES, SENSITIVE_ROWS,
} from '@/lib/permissions';
import { createDb, rows, type Db } from './harness';

describe('database schema matches the TypeScript permission model', () => {
  let db: Db;
  beforeAll(async () => {
    db = await createDb();
  });
  afterAll(async () => {
    await db.close();
  });

  const labels = async (type: string) =>
    (await rows<{ l: string }>(db, `select unnest(enum_range(null::public.${type}))::text as l`)).map((r) => r.l);

  it('has the same enum values', async () => {
    expect(await labels('member_role')).toEqual([...ROLES]);
    expect(await labels('permission_action')).toEqual([...ACTIONS]);
    expect(await labels('permission_module')).toEqual([...MODULES]);
    expect(await labels('approval_status')).toEqual([...APPROVAL_STATUSES]);
    expect(await labels('audit_result')).toEqual([...AUDIT_RESULTS]);
  });

  it('has Row Level Security switched on for every table', async () => {
    const off = await rows(
      db,
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(off).toEqual([]);
  });

  it('seeded the lookup tables exactly from the TypeScript policy', async () => {
    const asSet = (r: { role?: string; module: string; action: string }[]) =>
      r.map((x) => [x.role, x.module, x.action].filter(Boolean).join('|')).sort();
    const ceiling = await rows<any>(db, `select role::text, module::text, action::text from public.permission_ceiling`);
    const defaults = await rows<any>(db, `select role::text, module::text, action::text from public.permission_defaults`);
    const sensitive = await rows<any>(db, `select module::text, action::text from public.permission_sensitive`);
    expect(asSet(ceiling)).toEqual(CEILING_ROWS.map((r) => r.join('|')).sort());
    expect(asSet(defaults)).toEqual(DEFAULT_ROWS.map((r) => r.join('|')).sort());
    expect(asSet(sensitive)).toEqual(SENSITIVE_ROWS.map((r) => r.join('|')).sort());
  });

  it('keeps the ceiling free of any client permission on the AI assistant beyond view', async () => {
    const r = await rows(
      db,
      `select 1 from public.permission_ceiling
        where module = 'ai_assistant' and role <> 'admin' and action <> 'view'`,
    );
    expect(r).toEqual([]);
  });

  it('never lists grant_permission in any non-admin ceiling', async () => {
    const r = await rows(db, `select 1 from public.permission_ceiling where action = 'grant_permission'`);
    expect(r).toEqual([]);
  });
});
