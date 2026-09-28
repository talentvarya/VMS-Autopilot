import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACTIONS, CEILING_ROWS, MODULES, decide,
  type Action, type Effect, type Grant, type Module, type Principal, type Role,
} from '@/lib/permissions';
import { ID, asUser, createDb, rows, seedFixture, useRollbackPerTest, type Db } from './harness';

/**
 * The TypeScript policy (src/lib/permissions/policy.ts) and the SQL decision function
 * must give the same answer for EVERY role x module x action, with no grants, with every
 * possible grant, and with a workspace approval policy. If they ever disagree, the app and
 * the database would tell different stories about who may do what.
 */
describe('TypeScript policy and SQL policy agree', () => {
  let db: Db;
  beforeAll(async () => {
    db = await createDb();
    await seedFixture(db);
  });
  afterAll(async () => {
    await db.close();
  });
  useRollbackPerTest(() => db);

  /** What the database says, using only the functions app users are allowed to call. */
  async function sqlEffects(userId: string, workspace: string): Promise<Map<string, Effect>> {
    const out = new Map<string, Effect>();
    await asUser(db, userId, async () => {
      for (const m of MODULES) for (const a of ACTIONS) {
        const [r] = await rows<{ c: boolean; h: boolean }>(
          db,
          `select private.can_do($1, $2::public.permission_module, $3::public.permission_action) as c,
                  private.holds($1, $2::public.permission_module, $3::public.permission_action) as h`,
          [workspace, m, a],
        );
        out.set(`${m}:${a}`, r.c ? 'allow' : r.h ? 'needs_approval' : 'deny');
      }
    });
    return out;
  }

  function compare(sql: Map<string, Effect>, principal: Principal, approvalPolicy?: string[]) {
    const mismatches: string[] = [];
    for (const m of MODULES) for (const a of ACTIONS) {
      const ts = decide(principal, m, a, { approvalPolicy }).effect;
      const pg = sql.get(`${m}:${a}`);
      if (ts !== pg) mismatches.push(`${m}:${a} ts=${ts} sql=${pg}`);
    }
    return mismatches;
  }

  const principals: { name: string; user: string; role: Role | null }[] = [
    { name: 'Admin', user: ID.agencyAdmin, role: 'admin' },
    { name: 'Team member', user: ID.teamMember, role: 'team_member' },
    { name: 'Client of the workspace', user: ID.clientNova, role: 'client' },
    { name: 'Client of a different workspace', user: ID.clientBright, role: null },
    { name: 'Admin of a different agency', user: ID.otherAgencyAdmin, role: null },
    { name: 'Logged in but in no workspace', user: ID.outsider, role: null },
  ];

  it('agree with no grants', async () => {
    for (const p of principals) {
      expect(compare(await sqlEffects(p.user, ID.nova), { role: p.role, grants: [] }), p.name).toEqual([]);
    }
  });

  const ceilingGrants = (role: Role): Grant[] =>
    CEILING_ROWS.filter((r) => r[0] === role).map(([, module, action]) => ({ module, action }));

  it('agree when an Admin has granted everything the ceiling allows', async () => {
    await asUser(db, ID.agencyAdmin, async () => {
      await db.query(
        `insert into public.permission_grants (workspace_id, user_id, module, action)
         select $1, null, module, action from public.permission_ceiling where role = 'client'`,
        [ID.nova],
      );
      await db.query(
        `insert into public.permission_grants (workspace_id, user_id, module, action)
         select $1, $2, module, action from public.permission_ceiling where role = 'team_member'`,
        [ID.nova, ID.teamMember],
      );
    });
    expect(compare(await sqlEffects(ID.clientNova, ID.nova), { role: 'client', grants: ceilingGrants('client') })).toEqual([]);
    expect(compare(await sqlEffects(ID.teamMember, ID.nova), { role: 'team_member', grants: ceilingGrants('team_member') })).toEqual([]);
    // A grant on Nova must not leak to a client of another workspace.
    expect(compare(await sqlEffects(ID.clientBright, ID.nova), { role: null, grants: [] })).toEqual([]);
    expect(compare(await sqlEffects(ID.clientBright, ID.bright), { role: 'client', grants: [] })).toEqual([]);
  });

  it('agree when the workspace forces every action through approval', async () => {
    const everything = MODULES.flatMap((m: Module) => ACTIONS.map((a: Action) => `${m}:${a}`));
    await asUser(db, ID.agencyAdmin, async () => {
      await db.query(`update public.workspace_settings set approval_policy = $2::jsonb where workspace_id = $1`, [
        ID.nova, JSON.stringify(everything),
      ]);
      await db.query(
        `insert into public.permission_grants (workspace_id, user_id, module, action)
         select $1, null, module, action from public.permission_ceiling where role = 'client'`,
        [ID.nova],
      );
    });
    const sql = await sqlEffects(ID.clientNova, ID.nova);
    expect(compare(sql, { role: 'client', grants: ceilingGrants('client') }, everything)).toEqual([]);
    // With the policy on, even a plain default like viewing SEO now needs approval.
    expect(sql.get('seo_geo:view')).toBe('needs_approval');
    // Admin is never blocked by the policy.
    expect(compare(await sqlEffects(ID.agencyAdmin, ID.nova), { role: 'admin', grants: [] }, everything)).toEqual([]);
  });
});
