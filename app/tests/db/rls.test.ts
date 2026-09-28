import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const ids = (r: { id: string }[]) => r.map((x) => x.id).sort();
const asAdmin = <T,>(fn: () => Promise<T>) => asUser(db, ID.agencyAdmin, fn);
const asClient = <T,>(fn: () => Promise<T>) => asUser(db, ID.clientNova, fn);
const asTeam = <T,>(fn: () => Promise<T>) => asUser(db, ID.teamMember, fn);

/** Admin gives the whole Nova client workspace a permission. */
const grantNova = (module: string, action: string, userId: string | null = null) =>
  asAdmin(() =>
    db.query(
      `insert into public.permission_grants (workspace_id, user_id, module, action)
       values ($1, $2, $3::public.permission_module, $4::public.permission_action)`,
      [ID.nova, userId, module, action],
    ),
  );

const decisionFor = async (userId: string, ws: string, module: string, action: string) =>
  asUser(db, userId, async () => {
    const [r] = await rows<{ c: boolean; h: boolean }>(
      db,
      `select private.can_do($1, $2::public.permission_module, $3::public.permission_action) c,
              private.holds($1, $2::public.permission_module, $3::public.permission_action) h`,
      [ws, module, action],
    );
    return r.c ? 'allow' : r.h ? 'needs_approval' : 'deny';
  });

const auditActions = (ws: string) =>
  asOwner(db, () => rows<{ action: string; result: string; actor_id: string | null; actor_role: string | null }>(
    db, `select action, result::text, actor_id, actor_role from public.audit_log where workspace_id = $1 order by id`, [ws]));

describe('not logged in', () => {
  it('cannot read or write anything', async () => {
    for (const table of [
      'profiles', 'workspaces', 'workspace_members', 'permission_grants', 'approval_requests',
      'audit_log', 'integrations', 'integration_credentials', 'workspace_settings',
      'permission_ceiling', 'permission_defaults', 'permission_sensitive',
    ]) {
      await expect(asUser(db, null, () => db.query(`select * from public.${table}`)), table).rejects.toThrow(/permission denied/);
    }
    await expect(
      asUser(db, null, () => db.query(`insert into public.workspaces (kind, name) values ('agency', 'x')`)),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('signing up', () => {
  it('creates a profile but grants no access to anything', async () => {
    const newUser = '00000000-0000-4000-8000-0000000000f1';
    await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, 'new@example.test', '{"full_name":"New Person"}')`, [newUser]);
    expect(await asOwner(db, () => rows(db, `select email, full_name from public.profiles where id = $1`, [newUser])))
      .toEqual([{ email: 'new@example.test', full_name: 'New Person' }]);

    await asUser(db, newUser, async () => {
      expect(await rows(db, `select id from public.workspaces`)).toEqual([]);
      expect(await rows(db, `select 1 from public.workspace_members`)).toEqual([]);
      expect(await rows(db, `select 1 from public.permission_grants`)).toEqual([]);
      expect(await rows(db, `select 1 from public.audit_log`)).toEqual([]);
      expect(await rows(db, `select 1 from public.integrations`)).toEqual([]);
      expect((await rows(db, `select id from public.profiles`)).length).toBe(1); // only themselves
    });
  });

  it('cannot add themselves to a workspace or create one', async () => {
    await expect(asUser(db, ID.outsider, () =>
      db.query(`insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'client')`, [ID.nova, ID.outsider]),
    )).rejects.toThrow(/row-level security/);
    await expect(asUser(db, ID.outsider, () =>
      db.query(`insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'admin')`, [ID.acme, ID.outsider]),
    )).rejects.toThrow(/row-level security/);
    await expect(asUser(db, ID.outsider, () =>
      db.query(`insert into public.workspaces (kind, parent_workspace_id, name) values ('client', $1, 'Sneaky')`, [ID.acme]),
    )).rejects.toThrow(/row-level security/);
  });
});

describe('every client, team member and admin sees only their own workspaces', () => {
  it('workspaces', async () => {
    const seen = (uid: string) => asUser(db, uid, async () => ids(await rows(db, `select id from public.workspaces`)));
    expect(await seen(ID.clientNova)).toEqual([ID.nova]);
    expect(await seen(ID.clientNova2)).toEqual([ID.nova]);
    expect(await seen(ID.clientBright)).toEqual([ID.bright]);
    expect(await seen(ID.agencyAdmin)).toEqual([ID.acme, ID.bright, ID.nova].sort());
    expect(await seen(ID.teamMember)).toEqual([ID.acme, ID.bright, ID.nova].sort());
    expect(await seen(ID.otherAgencyAdmin)).toEqual([ID.otherAgency, ID.otherClient].sort());
    expect(await seen(ID.outsider)).toEqual([]);
  });

  it('members and profiles', async () => {
    await asClient(async () => {
      expect((await rows<{ user_id: string }>(db, `select user_id from public.workspace_members`)).map((r) => r.user_id))
        .toEqual([ID.clientNova]); // not even their colleague clientNova2
      expect(ids(await rows(db, `select id from public.profiles`))).toEqual([ID.clientNova]);
    });
    await asAdmin(async () => {
      expect((await rows(db, `select 1 from public.workspace_members`)).length).toBe(6); // acme 3 + nova 2 + bright 1
      expect(ids(await rows(db, `select id from public.profiles`))).toEqual(
        [ID.agencyAdmin, ID.agencyAdmin2, ID.teamMember, ID.clientNova, ID.clientNova2, ID.clientBright].sort(),
      );
    });
  });

  it('a client of one workspace cannot touch a sibling workspace', async () => {
    const r = await asClient(() => db.query(`update public.workspaces set name = 'hacked' where id = $1 returning id`, [ID.bright]));
    expect(r.rows).toEqual([]);
    const r2 = await asClient(() => db.query(`update public.workspaces set name = 'hacked' where id = $1 returning id`, [ID.nova]));
    expect(r2.rows).toEqual([]); // not even their own: clients are not admins
    expect((await asOwner(db, () => rows(db, `select name from public.workspaces where id = $1`, [ID.nova])))[0].name).toBe('Nova Clinic');
  });
});

describe('only an Admin can grant, revoke or change permissions', () => {
  const insertGrant = (uid: string, ws: string = ID.nova, module = 'paid_ads', action = 'view', userId: string | null = null) =>
    asUser(db, uid, () =>
      db.query(
        `insert into public.permission_grants (workspace_id, user_id, module, action)
         values ($1, $2, $3::public.permission_module, $4::public.permission_action)`,
        [ws, userId, module, action],
      ),
    );

  it('a client cannot grant themselves anything', async () => {
    await expect(insertGrant(ID.clientNova)).rejects.toThrow(/row-level security/);
    await expect(insertGrant(ID.clientNova, ID.nova, 'paid_ads', 'view', ID.clientNova)).rejects.toThrow(/row-level security/);
  });

  it('a team member cannot grant', async () => {
    await expect(insertGrant(ID.teamMember)).rejects.toThrow(/row-level security/);
  });

  it("an Admin of another agency cannot grant on someone else's client", async () => {
    await expect(insertGrant(ID.otherAgencyAdmin)).rejects.toThrow(/row-level security/);
  });

  it('an Admin can grant, the client then gets it, and other workspaces do not', async () => {
    expect(await decisionFor(ID.clientNova, ID.nova, 'paid_ads', 'view')).toBe('deny');
    await grantNova('paid_ads', 'view');
    expect(await decisionFor(ID.clientNova, ID.nova, 'paid_ads', 'view')).toBe('allow');
    expect(await decisionFor(ID.clientNova2, ID.nova, 'paid_ads', 'view')).toBe('allow');
    expect(await decisionFor(ID.clientBright, ID.bright, 'paid_ads', 'view')).toBe('deny');
    expect(await decisionFor(ID.clientBright, ID.nova, 'paid_ads', 'view')).toBe('deny');
    const [g] = await asOwner(db, () => rows(db, `select granted_by from public.permission_grants`));
    expect(g.granted_by).toBe(ID.agencyAdmin);
  });

  it('a grant to one person does not reach their colleague', async () => {
    await grantNova('domains', 'view', ID.clientNova2);
    expect(await decisionFor(ID.clientNova2, ID.nova, 'domains', 'view')).toBe('allow');
    expect(await decisionFor(ID.clientNova, ID.nova, 'domains', 'view')).toBe('deny');
  });

  it('a client can see the grants that apply to them but not other workspaces', async () => {
    await grantNova('paid_ads', 'view');
    await asAdmin(() => db.query(
      `insert into public.permission_grants (workspace_id, module, action) values ($1, 'domains', 'view')`, [ID.bright]));
    await asClient(async () => {
      const seen = await rows<{ workspace_id: string }>(db, `select workspace_id from public.permission_grants`);
      expect(seen.map((r) => r.workspace_id)).toEqual([ID.nova]);
    });
  });

  it('an Admin cannot grant more than the role ceiling allows', async () => {
    await expect(insertGrant(ID.agencyAdmin, ID.nova, 'ai_assistant', 'edit')).rejects.toThrow(/can never be given/);
    await expect(insertGrant(ID.agencyAdmin, ID.nova, 'ai_assistant', 'publish_execute')).rejects.toThrow(/can never be given/);
    await expect(insertGrant(ID.agencyAdmin, ID.nova, 'website', 'publish_execute')).rejects.toThrow(/can never be given/);
    await expect(insertGrant(ID.agencyAdmin, ID.nova, 'settings', 'view')).rejects.toThrow(/can never be given/);
    await expect(insertGrant(ID.agencyAdmin, ID.nova, 'integrations', 'view')).rejects.toThrow(/can never be given/);
    await expect(insertGrant(ID.agencyAdmin, ID.nova, 'paid_ads', 'grant_permission')).rejects.toThrow(/can never be given/);
    await expect(insertGrant(ID.agencyAdmin, ID.nova, 'leads_crm', 'grant_permission', ID.teamMember)).rejects.toThrow(/can never be given/);
    await expect(insertGrant(ID.agencyAdmin, ID.nova, 'audit_log', 'view', ID.teamMember)).rejects.toThrow(/can never be given/);
    await expect(insertGrant(ID.agencyAdmin, ID.nova, 'paid_ads', 'manage_integration', ID.teamMember)).rejects.toThrow(/can never be given/);
  });

  it('rejects grants to an Admin, to a stranger, or on an agency workspace', async () => {
    await expect(insertGrant(ID.agencyAdmin, ID.nova, 'paid_ads', 'view', ID.agencyAdmin2)).rejects.toThrow(/already has every permission/);
    await expect(insertGrant(ID.agencyAdmin, ID.nova, 'paid_ads', 'view', ID.outsider)).rejects.toThrow(/no access/);
    await expect(insertGrant(ID.agencyAdmin, ID.acme, 'paid_ads', 'view')).rejects.toThrow(/client workspaces only/);
  });

  it('revoking removes access, is recorded, and cannot be repeated', async () => {
    await grantNova('paid_ads', 'view');
    const [{ id }] = await asOwner(db, () => rows<{ id: string }>(db, `select id from public.permission_grants`));
    // Not the client, not the team member.
    expect((await asClient(() => db.query(`update public.permission_grants set revoked_at = now() where id = $1 returning id`, [id]))).rows).toEqual([]);
    expect((await asTeam(() => db.query(`update public.permission_grants set revoked_at = now() where id = $1 returning id`, [id]))).rows).toEqual([]);
    expect(await decisionFor(ID.clientNova, ID.nova, 'paid_ads', 'view')).toBe('allow');

    await asAdmin(() => db.query(`update public.permission_grants set revoked_at = now() where id = $1`, [id]));
    expect(await decisionFor(ID.clientNova, ID.nova, 'paid_ads', 'view')).toBe('deny');
    const [g] = await asOwner(db, () => rows(db, `select revoked_by, revoked_at from public.permission_grants where id = $1`, [id]));
    expect(g.revoked_by).toBe(ID.agencyAdmin);
    expect(g.revoked_at).not.toBeNull();
    await expect(asAdmin(() => db.query(`update public.permission_grants set revoked_at = now() where id = $1`, [id]))).rejects.toThrow(/already revoked/);
    // and it can be granted again afterwards
    await grantNova('paid_ads', 'view');
    expect(await decisionFor(ID.clientNova, ID.nova, 'paid_ads', 'view')).toBe('allow');
  });

  it('a grant can never be edited or deleted', async () => {
    await grantNova('paid_ads', 'view');
    const [{ id }] = await asOwner(db, () => rows<{ id: string }>(db, `select id from public.permission_grants`));
    await expect(asAdmin(() => db.query(`update public.permission_grants set module = 'domains' where id = $1`, [id]))).rejects.toThrow(/permission denied/);
    await expect(asOwner(db, () => db.query(`update public.permission_grants set module = 'domains' where id = $1`, [id]))).rejects.toThrow(/cannot be edited/);
    await expect(asAdmin(() => db.query(`delete from public.permission_grants where id = $1`, [id]))).rejects.toThrow(/permission denied/);
  });

  it('the same grant cannot be active twice', async () => {
    await grantNova('paid_ads', 'view');
    await expect(grantNova('paid_ads', 'view')).rejects.toThrow(/duplicate key/);
  });
});

describe('memberships', () => {
  const add = (uid: string, ws: string, user: string, role: string) =>
    asUser(db, uid, () => db.query(`insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, $3::public.member_role)`, [ws, user, role]));

  it('clients and team members cannot add or promote anybody', async () => {
    await expect(add(ID.clientNova, ID.acme, ID.clientNova, 'admin')).rejects.toThrow(/row-level security/);
    await expect(add(ID.clientNova, ID.nova, ID.outsider, 'client')).rejects.toThrow(/row-level security/);
    await expect(add(ID.teamMember, ID.acme, ID.outsider, 'admin')).rejects.toThrow(/row-level security/);
    const promote = (uid: string) => asUser(db, uid, () =>
      db.query(`update public.workspace_members set role = 'admin' where user_id = $1 returning user_id`, [uid]));
    expect((await promote(ID.clientNova)).rows).toEqual([]);
    expect((await promote(ID.teamMember)).rows).toEqual([]);
    expect((await asOwner(db, () => rows(db, `select role::text from public.workspace_members where user_id = $1`, [ID.teamMember])))[0].role).toBe('team_member');
  });

  it("another agency's Admin has no power here", async () => {
    await expect(add(ID.otherAgencyAdmin, ID.nova, ID.outsider, 'client')).rejects.toThrow(/row-level security/);
    await expect(add(ID.otherAgencyAdmin, ID.acme, ID.outsider, 'team_member')).rejects.toThrow(/row-level security/);
  });

  it('an Admin can add people, with roles that fit the workspace kind', async () => {
    await add(ID.agencyAdmin, ID.acme, ID.outsider, 'team_member');
    expect((await auditActions(ID.acme)).map((a) => a.action)).toContain('member.added');
    await expect(add(ID.agencyAdmin, ID.acme, ID.clientBright, 'client')).rejects.toThrow(/not allowed in a agency workspace/);
    await expect(add(ID.agencyAdmin, ID.nova, ID.outsider, 'admin')).rejects.toThrow(/not allowed in a client workspace/);
    await expect(add(ID.agencyAdmin, ID.nova, ID.outsider, 'team_member')).rejects.toThrow(/not allowed in a client workspace/);
  });

  it('the last Admin of a workspace can never be removed or demoted', async () => {
    await asAdmin(() => db.query(`delete from public.workspace_members where workspace_id = $1 and user_id = $2`, [ID.acme, ID.agencyAdmin2]));
    await expect(asAdmin(() => db.query(`delete from public.workspace_members where workspace_id = $1 and user_id = $2`, [ID.acme, ID.agencyAdmin]))).rejects.toThrow(/last admin/);
    await expect(asAdmin(() => db.query(`update public.workspace_members set role = 'team_member' where workspace_id = $1 and user_id = $2`, [ID.acme, ID.agencyAdmin]))).rejects.toThrow(/last admin/);
  });

  it('removing a person removes their access at once', async () => {
    await grantNova('paid_ads', 'view');
    expect(await decisionFor(ID.clientNova, ID.nova, 'paid_ads', 'view')).toBe('allow');
    await asAdmin(() => db.query(`delete from public.workspace_members where workspace_id = $1 and user_id = $2`, [ID.nova, ID.clientNova]));
    expect(await decisionFor(ID.clientNova, ID.nova, 'paid_ads', 'view')).toBe('deny');
    await asClient(async () => expect(await rows(db, `select 1 from public.workspaces`)).toEqual([]));
  });
});

describe('workspaces', () => {
  it('an Admin can create a client workspace under their agency; it gets settings and is audited', async () => {
    const [{ id }] = await asAdmin(() => rows<{ id: string }>(db,
      `insert into public.workspaces (kind, parent_workspace_id, name, industry) values ('client', $1, 'Urban Eats', 'Food') returning id`, [ID.acme]));
    const [ws] = await asOwner(db, () => rows(db, `select created_by, kind::text from public.workspaces where id = $1`, [id]));
    expect(ws).toEqual({ created_by: ID.agencyAdmin, kind: 'client' });
    expect(await asAdmin(() => rows(db, `select workspace_id from public.workspace_settings where workspace_id = $1`, [id]))).toHaveLength(1);
    expect((await auditActions(id)).map((a) => a.action)).toContain('workspace.created');
  });

  it("cannot be created under another agency, by a client, or as a new agency", async () => {
    const create = (uid: string, kind: string, parent: string | null) => asUser(db, uid, () =>
      db.query(`insert into public.workspaces (kind, parent_workspace_id, name) values ($1::public.workspace_kind, $2, 'X')`, [kind, parent]));
    await expect(create(ID.agencyAdmin, 'client', ID.otherAgency)).rejects.toThrow(/row-level security/);
    await expect(create(ID.clientNova, 'client', ID.acme)).rejects.toThrow(/row-level security/);
    await expect(create(ID.teamMember, 'client', ID.acme)).rejects.toThrow(/row-level security/);
    await expect(create(ID.agencyAdmin, 'agency', null)).rejects.toThrow(/row-level security/);
    await expect(create(ID.agencyAdmin, 'client', ID.nova)).rejects.toThrow(/row-level security|must belong to an agency/);
  });

  it('kind and parent can never change', async () => {
    await expect(asAdmin(() => db.query(`update public.workspaces set kind = 'agency' where id = $1`, [ID.nova]))).rejects.toThrow(/permission denied/);
    await expect(asOwner(db, () => db.query(`update public.workspaces set parent_workspace_id = $1 where id = $2`, [ID.otherAgency, ID.nova]))).rejects.toThrow(/cannot be changed/);
  });

  it('only an Admin can rename, and workspaces cannot be deleted through the app', async () => {
    await asAdmin(() => db.query(`update public.workspaces set name = 'Nova Clinic Ltd' where id = $1`, [ID.nova]));
    expect((await asClient(() => db.query(`update public.workspaces set name = 'x' where id = $1 returning id`, [ID.nova]))).rows).toEqual([]);
    await expect(asAdmin(() => db.query(`delete from public.workspaces where id = $1`, [ID.nova]))).rejects.toThrow(/permission denied/);
  });
});

describe('approvals', () => {
  const request = (uid: string, ws: string, module: string, action: string, details: object = {}) =>
    asUser(db, uid, () => rows<{ id: string }>(db,
      `insert into public.approval_requests (workspace_id, module, action, title, details)
       values ($1, $2::public.permission_module, $3::public.permission_action, 'Change budget', $4::jsonb) returning id`,
      [ws, module, action, JSON.stringify(details)]));
  const decide = (uid: string, id: string, status: string, note: string | null = null) =>
    asUser(db, uid, () => db.query(
      `update public.approval_requests set status = $2::public.approval_status, decision_note = $3 where id = $1 returning id`, [id, status, note]));

  it('are created only for actions that genuinely need approval', async () => {
    // no permission at all
    await expect(request(ID.clientNova, ID.nova, 'paid_ads', 'edit')).rejects.toThrow(/does not need an approval request \(decision: deny\)/);
    // permitted directly - nothing to approve
    await expect(request(ID.clientNova, ID.nova, 'social', 'view')).rejects.toThrow(/decision: allow/);
    // a stranger
    await expect(request(ID.outsider, ID.nova, 'paid_ads', 'edit')).rejects.toThrow(/row-level security|does not need an approval request/);
  });

  it('go from a permitted-but-sensitive action to a pending request owned by the requester', async () => {
    await grantNova('paid_ads', 'edit');
    const [{ id }] = await request(ID.clientNova, ID.nova, 'paid_ads', 'edit', { budgetFrom: 100, budgetTo: 500 });
    const [row] = await asOwner(db, () => rows(db, `select requested_by, status::text, decided_by from public.approval_requests where id = $1`, [id]));
    expect(row).toEqual({ requested_by: ID.clientNova, status: 'pending', decided_by: null });
    expect((await auditActions(ID.nova)).find((a) => a.action === 'approval.requested')).toMatchObject({ result: 'pending_approval', actor_id: ID.clientNova });
  });

  it('cannot be forged: requester, status and decision are set by the server', async () => {
    await grantNova('paid_ads', 'edit');
    await expect(asClient(() => db.query(
      `insert into public.approval_requests (workspace_id, module, action, title, requested_by) values ($1, 'paid_ads', 'edit', 't', $2)`, [ID.nova, ID.agencyAdmin]),
    )).rejects.toThrow(/permission denied/);
    await expect(asClient(() => db.query(
      `insert into public.approval_requests (workspace_id, module, action, title, status) values ($1, 'paid_ads', 'edit', 't', 'approved')`, [ID.nova]),
    )).rejects.toThrow(/permission denied/);
  });

  it('are private to the requester and the workspace Admins', async () => {
    await grantNova('paid_ads', 'edit');
    const [{ id }] = await request(ID.clientNova, ID.nova, 'paid_ads', 'edit');
    const visible = (uid: string) => asUser(db, uid, async () => ids(await rows(db, `select id from public.approval_requests`)));
    expect(await visible(ID.clientNova)).toEqual([id]);
    expect(await visible(ID.agencyAdmin)).toEqual([id]);
    expect(await visible(ID.agencyAdmin2)).toEqual([id]);
    expect(await visible(ID.clientNova2)).toEqual([]);
    expect(await visible(ID.clientBright)).toEqual([]);
    expect(await visible(ID.teamMember)).toEqual([]);
    expect(await visible(ID.otherAgencyAdmin)).toEqual([]);
    // and nobody else can decide it
    expect((await decide(ID.otherAgencyAdmin, id, 'approved')).rows).toEqual([]);
    expect((await decide(ID.teamMember, id, 'approved')).rows).toEqual([]);
    expect((await decide(ID.clientNova2, id, 'approved')).rows).toEqual([]);
  });

  it('cannot be approved by the person who asked, only cancelled', async () => {
    await grantNova('paid_ads', 'edit');
    const [{ id }] = await request(ID.clientNova, ID.nova, 'paid_ads', 'edit');
    await expect(decide(ID.clientNova, id, 'approved')).rejects.toThrow(/only an Admin/);
    await expect(decide(ID.clientNova, id, 'rejected')).rejects.toThrow(/only an Admin/);
    await decide(ID.clientNova, id, 'cancelled');
    const [row] = await asOwner(db, () => rows(db, `select status::text, decided_by from public.approval_requests where id = $1`, [id]));
    expect(row).toEqual({ status: 'cancelled', decided_by: ID.clientNova });
    expect((await auditActions(ID.nova)).map((a) => a.action)).toContain('approval.cancelled');
  });

  it('are decided by an Admin exactly once, and the decision is recorded', async () => {
    await grantNova('paid_ads', 'edit');
    const [{ id }] = await request(ID.clientNova, ID.nova, 'paid_ads', 'edit');
    await decide(ID.agencyAdmin, id, 'approved', 'Looks fine');
    const [row] = await asOwner(db, () => rows(db, `select status::text, decided_by, decided_at, decision_note from public.approval_requests where id = $1`, [id]));
    expect(row).toMatchObject({ status: 'approved', decided_by: ID.agencyAdmin, decision_note: 'Looks fine' });
    expect(row.decided_at).not.toBeNull();
    await expect(decide(ID.agencyAdmin2, id, 'rejected')).rejects.toThrow(/already been decided/);
    await expect(decide(ID.clientNova, id, 'cancelled')).rejects.toThrow(/already been decided/);
    expect((await auditActions(ID.nova)).map((a) => a.action)).toContain('approval.approved');
  });

  it('cannot have their content changed after being asked', async () => {
    await grantNova('paid_ads', 'edit');
    const [{ id }] = await request(ID.clientNova, ID.nova, 'paid_ads', 'edit');
    await expect(asClient(() => db.query(`update public.approval_requests set title = 'Something else' where id = $1`, [id]))).rejects.toThrow(/permission denied/);
    await expect(asOwner(db, () => db.query(`update public.approval_requests set title = 'Something else' where id = $1`, [id]))).rejects.toThrow(/only the decision/);
  });

  it('work for team members too, who can never decide', async () => {
    await grantNova('domains', 'create', ID.teamMember);
    const [{ id }] = await request(ID.teamMember, ID.nova, 'domains', 'create');
    expect(id).toBeTruthy();
    await expect(decide(ID.teamMember, id, 'approved')).rejects.toThrow(/only an Admin/);
  });

  it('are forced by a workspace approval policy even for normally-direct actions', async () => {
    await grantNova('social', 'create');
    expect(await decisionFor(ID.clientNova, ID.nova, 'social', 'create')).toBe('allow');
    await asAdmin(() => db.query(`update public.workspace_settings set approval_policy = '["social:create"]' where workspace_id = $1`, [ID.nova]));
    expect(await decisionFor(ID.clientNova, ID.nova, 'social', 'create')).toBe('needs_approval');
    const [{ id }] = await request(ID.clientNova, ID.nova, 'social', 'create');
    expect(id).toBeTruthy();
  });
});

describe('the audit log', () => {
  it('records who did what, in which workspace, with the result', async () => {
    await grantNova('paid_ads', 'view');
    const log = await auditActions(ID.nova);
    expect(log).toContainEqual({ action: 'permission.granted', result: 'success', actor_id: ID.agencyAdmin, actor_role: 'admin' });
  });

  it('is readable only by Admins of that workspace', async () => {
    await grantNova('paid_ads', 'view');
    const count = (uid: string) => asUser(db, uid, async () => (await rows(db, `select 1 from public.audit_log`)).length);
    expect(await count(ID.agencyAdmin)).toBeGreaterThan(0);
    expect(await count(ID.clientNova)).toBe(0);
    expect(await count(ID.clientBright)).toBe(0);
    expect(await count(ID.teamMember)).toBe(0);
    expect(await count(ID.outsider)).toBe(0);
  });

  it('never shows one agency the history of another', async () => {
    await grantNova('paid_ads', 'view');
    const seenWorkspaces = (uid: string) => asUser(db, uid, async () =>
      [...new Set((await rows<{ workspace_id: string }>(db, `select workspace_id from public.audit_log`)).map((r) => r.workspace_id))].sort());
    expect(await seenWorkspaces(ID.otherAgencyAdmin)).toEqual([ID.otherAgency, ID.otherClient].sort());
    expect(await seenWorkspaces(ID.agencyAdmin)).toEqual([ID.acme, ID.bright, ID.nova].sort());
  });

  it('cannot be written to by anyone using the app', async () => {
    for (const uid of [ID.agencyAdmin, ID.clientNova, ID.teamMember]) {
      await expect(asUser(db, uid, () => db.query(
        `insert into public.audit_log (action, result) values ('fake', 'success')`))).rejects.toThrow(/permission denied/);
    }
  });

  it('cannot be edited, deleted or truncated - not even by the server or the owner', async () => {
    await grantNova('paid_ads', 'view');
    await expect(asService(db, () => db.query(`update public.audit_log set action = 'x'`))).rejects.toThrow(/permission denied/);
    await expect(asService(db, () => db.query(`delete from public.audit_log`))).rejects.toThrow(/permission denied/);
    await expect(asService(db, () => db.query(`truncate public.audit_log`))).rejects.toThrow(/permission denied/);
    await expect(asOwner(db, () => db.query(`update public.audit_log set action = 'x'`))).rejects.toThrow(/append-only/);
    await expect(asOwner(db, () => db.query(`delete from public.audit_log`))).rejects.toThrow(/append-only/);
    await expect(asOwner(db, () => db.query(`truncate public.audit_log`))).rejects.toThrow(/append-only/);
  });

  it('never stores a secret, even one hidden inside a request', async () => {
    await grantNova('paid_ads', 'edit');
    await asClient(() => db.query(
      `insert into public.approval_requests (workspace_id, module, action, title, details)
       values ($1, 'paid_ads', 'edit', 'Change', $2::jsonb)`,
      [ID.nova, JSON.stringify({ budget: 500, api_key: 'sk_live_SECRET123', nested: { accessToken: 'tok_SECRET456' } })]));
    const [{ meta }] = await asOwner(db, () => rows<{ meta: string }>(db,
      `select metadata::text as meta from public.audit_log where action = 'approval.requested'`));
    expect(meta).not.toContain('SECRET123');
    expect(meta).not.toContain('SECRET456');
    expect(meta).toContain('[redacted]');
    expect(meta).toContain('500');
  });

  it('records changes to settings and integrations too', async () => {
    await asAdmin(() => db.query(`update public.workspace_settings set ad_spend_monthly_cap = 5000 where workspace_id = $1`, [ID.nova]));
    await asAdmin(() => db.query(`insert into public.integrations (workspace_id, provider) values ($1, 'buffer')`, [ID.nova]));
    const actions = (await auditActions(ID.nova)).map((a) => a.action);
    expect(actions).toContain('settings.updated');
    expect(actions).toContain('integration.created');
  });
});

describe('integrations and credentials', () => {
  it('an Admin can record an integration but cannot mark it connected or forge its consent record', async () => {
    const [{ id }] = await asAdmin(() => rows<{ id: string }>(db,
      `insert into public.integrations (workspace_id, provider) values ($1, 'buffer') returning id`, [ID.nova]));
    for (const column of ['status', 'consent_given_by', 'consent_recorded_at', 'consent_version', 'connected_at']) {
      const value = column === 'status' ? `'connected'` : column === 'consent_given_by' ? `'${ID.clientNova}'` : column === 'consent_version' ? `'v1'` : 'now()';
      await expect(asAdmin(() => db.query(`update public.integrations set ${column} = ${value} where id = $1`, [id])), column)
        .rejects.toThrow(/permission denied/);
    }
  });

  it('only the server, completing a real OAuth connection, can mark it connected - and only with consent', async () => {
    const [{ id }] = await asAdmin(() => rows<{ id: string }>(db,
      `insert into public.integrations (workspace_id, provider) values ($1, 'buffer') returning id`, [ID.nova]));
    await expect(asService(db, () => db.query(`update public.integrations set status = 'connected' where id = $1`, [id])))
      .rejects.toThrow(/integration_connected_needs_consent/);
    await asService(db, () => db.query(
      `update public.integrations set status = 'connected', consent_given_by = $2, consent_recorded_at = now(), consent_version = 'v1', connected_at = now() where id = $1`,
      [id, ID.clientNova]));
    expect((await asAdmin(() => rows(db, `select status::text as s from public.integrations where id = $1`, [id])))[0].s).toBe('connected');
  });

  it('clients never see or change integrations', async () => {
    await asAdmin(() => db.query(`insert into public.integrations (workspace_id, provider) values ($1, 'buffer')`, [ID.nova]));
    expect(await asClient(() => rows(db, `select 1 from public.integrations`))).toEqual([]);
    await expect(asClient(() => db.query(`insert into public.integrations (workspace_id, provider) values ($1, 'meta_ads')`, [ID.nova]))).rejects.toThrow(/row-level security/);
    expect((await asClient(() => db.query(`delete from public.integrations returning 1`))).rows).toEqual([]);
  });

  it('a team member sees them only when allowed, and can never change them directly', async () => {
    await asAdmin(() => db.query(`insert into public.integrations (workspace_id, provider) values ($1, 'buffer')`, [ID.nova]));
    expect(await asTeam(() => rows(db, `select 1 from public.integrations`))).toEqual([]);
    await grantNova('integrations', 'view', ID.teamMember);
    expect(await asTeam(() => rows(db, `select 1 from public.integrations`))).toHaveLength(1);
    await expect(asTeam(() => db.query(`insert into public.integrations (workspace_id, provider) values ($1, 'meta_ads')`, [ID.nova]))).rejects.toThrow(/row-level security/);
    await grantNova('integrations', 'manage_integration', ID.teamMember); // sensitive => approval, not direct
    await expect(asTeam(() => db.query(`insert into public.integrations (workspace_id, provider) values ($1, 'meta_ads')`, [ID.nova]))).rejects.toThrow(/row-level security/);
  });

  it("an Admin of another agency cannot see them", async () => {
    await asAdmin(() => db.query(`insert into public.integrations (workspace_id, provider) values ($1, 'buffer')`, [ID.nova]));
    expect(await asUser(db, ID.otherAgencyAdmin, () => rows(db, `select 1 from public.integrations`))).toEqual([]);
  });

  it('credential references are unreachable from the app - only the server can touch them', async () => {
    const [{ id }] = await asAdmin(() => rows<{ id: string }>(db,
      `insert into public.integrations (workspace_id, provider) values ($1, 'buffer') returning id`, [ID.nova]));
    await asService(db, () => db.query(`insert into public.integration_credentials (integration_id, secret_ref) values ($1, 'vault:abc')`, [id]));
    expect(await asService(db, () => rows(db, `select secret_ref from public.integration_credentials`))).toEqual([{ secret_ref: 'vault:abc' }]);
    for (const uid of [ID.agencyAdmin, ID.teamMember, ID.clientNova, null]) {
      await expect(asUser(db, uid, () => db.query(`select * from public.integration_credentials`)), String(uid)).rejects.toThrow(/permission denied/);
      await expect(asUser(db, uid, () => db.query(`insert into public.integration_credentials (integration_id, secret_ref) values ($1, 'x')`, [id]))).rejects.toThrow(/permission denied/);
    }
  });
});

describe('workspace settings', () => {
  it('are visible and editable by Admins only', async () => {
    await asAdmin(() => db.query(`update public.workspace_settings set ad_spend_monthly_cap = 2500.50 where workspace_id = $1`, [ID.nova]));
    expect((await asAdmin(() => rows(db, `select ad_spend_monthly_cap::text as cap from public.workspace_settings where workspace_id = $1`, [ID.nova])))[0].cap).toBe('2500.50');
    expect(await asClient(() => rows(db, `select 1 from public.workspace_settings`))).toEqual([]);
    expect(await asTeam(() => rows(db, `select 1 from public.workspace_settings`))).toEqual([]);
    expect((await asClient(() => db.query(`update public.workspace_settings set ad_spend_monthly_cap = 999999 returning 1`))).rows).toEqual([]);
    expect(await asUser(db, ID.otherAgencyAdmin, () => rows(db, `select 1 from public.workspace_settings where workspace_id = $1`, [ID.nova]))).toEqual([]);
  });

  it('reject a negative spend cap and a malformed approval policy', async () => {
    await expect(asAdmin(() => db.query(`update public.workspace_settings set ad_spend_monthly_cap = -1 where workspace_id = $1`, [ID.nova]))).rejects.toThrow(/check constraint/);
    await expect(asAdmin(() => db.query(`update public.workspace_settings set approval_policy = '{"a":1}' where workspace_id = $1`, [ID.nova]))).rejects.toThrow(/check constraint/);
  });
});

describe('profiles', () => {
  it('a person can rename themselves but not change their email or anyone else', async () => {
    await asClient(() => db.query(`update public.profiles set full_name = 'Nova Owner' where id = $1`, [ID.clientNova]));
    expect((await asOwner(db, () => rows(db, `select full_name from public.profiles where id = $1`, [ID.clientNova])))[0].full_name).toBe('Nova Owner');
    await expect(asClient(() => db.query(`update public.profiles set email = 'x@evil.test' where id = $1`, [ID.clientNova]))).rejects.toThrow(/permission denied/);
    expect((await asClient(() => db.query(`update public.profiles set full_name = 'x' where id = $1 returning id`, [ID.clientNova2]))).rows).toEqual([]);
  });
});

describe('internal helper functions', () => {
  it('cannot be called by app users, except the few that policies need', async () => {
    await expect(asClient(() => db.query(`select private.role_of_user($1, $2)`, [ID.agencyAdmin, ID.acme]))).rejects.toThrow(/permission denied/);
    await expect(asClient(() => db.query(`select private.action_decision($1, 'paid_ads', 'view')`, [ID.nova]))).rejects.toThrow(/permission denied/);
    await expect(asClient(() => db.query(`select private.scrub_secrets('{}'::jsonb)`))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, null, () => db.query(`select private.effective_role($1)`, [ID.nova]))).rejects.toThrow(/permission denied/);
    // The ones that policies use only ever answer about the caller themself.
    expect((await asClient(() => rows(db, `select private.effective_role($1)::text as r`, [ID.nova])))[0].r).toBe('client');
    expect((await asClient(() => rows(db, `select private.effective_role($1)::text as r`, [ID.acme])))[0].r).toBeNull();
  });
});

describe('the server (service role) still works for background jobs', () => {
  it('can read across workspaces, which is why its key must never reach a browser', async () => {
    expect((await asService(db, () => rows(db, `select id from public.workspaces`))).length).toBe(5);
  });
});

// ---------------------------------------------------------------------------------------
// Hardening from the independent access-control review
// ---------------------------------------------------------------------------------------

describe('hardening: roles', () => {
  it('an Admin keeps full powers even if someone also gives them a lower direct membership', async () => {
    await db.query(`insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'client')`, [ID.nova, ID.agencyAdmin2]);
    expect(await decisionFor(ID.agencyAdmin2, ID.nova, 'settings', 'grant_permission')).toBe('allow');
    await asUser(db, ID.agencyAdmin2, async () => {
      expect((await rows(db, `select 1 from public.audit_log`)).length).toBeGreaterThan(0);
    });
  });
});

describe('hardening: approvals', () => {
  const ask = (uid: string) => asUser(db, uid, () => rows<{ id: string }>(db,
    `insert into public.approval_requests (workspace_id, module, action, title) values ($1, 'paid_ads', 'edit', 'Change') returning id`, [ID.nova]));

  it('a person removed from the workspace can no longer see or cancel their old requests', async () => {
    await grantNova('paid_ads', 'edit');
    const [{ id }] = await ask(ID.clientNova);
    await asAdmin(() => db.query(`delete from public.workspace_members where workspace_id = $1 and user_id = $2`, [ID.nova, ID.clientNova]));
    expect(await asClient(() => rows(db, `select 1 from public.approval_requests`))).toEqual([]);
    expect((await asClient(() => db.query(`update public.approval_requests set status = 'cancelled' where id = $1 returning id`, [id]))).rows).toEqual([]);
  });

  it('a requester cannot write a note that looks like an Admin decision', async () => {
    await grantNova('paid_ads', 'edit');
    const [{ id }] = await ask(ID.clientNova);
    await expect(asClient(() => db.query(`update public.approval_requests set decision_note = 'Pre-approved by Admin' where id = $1`, [id])))
      .rejects.toThrow(/only an Admin can write a decision note/);
    await asAdmin(() => db.query(`update public.approval_requests set decision_note = 'Checked budget' where id = $1`, [id]));
  });

  it('the server cannot decide anonymously: it must name a real Admin of that workspace', async () => {
    await grantNova('paid_ads', 'edit');
    const [{ id }] = await ask(ID.clientNova);
    await expect(asService(db, () => db.query(`update public.approval_requests set status = 'approved' where id = $1`, [id])))
      .rejects.toThrow(/must name the person/);
    await expect(asService(db, () => db.query(`update public.approval_requests set status = 'approved', decided_by = $2 where id = $1`, [id, ID.clientNova])))
      .rejects.toThrow(/must be an Admin/);
    await expect(asService(db, () => db.query(`update public.approval_requests set status = 'approved', decided_by = $2 where id = $1`, [id, ID.otherAgencyAdmin])))
      .rejects.toThrow(/must be an Admin/);
    await asService(db, () => db.query(`update public.approval_requests set status = 'approved', decided_by = $2 where id = $1`, [id, ID.agencyAdmin]));
    const [row] = await asOwner(db, () => rows(db, `select status::text, decided_by from public.approval_requests where id = $1`, [id]));
    expect(row).toEqual({ status: 'approved', decided_by: ID.agencyAdmin });
  });
});

describe('hardening: what the app API can read', () => {
  it('hides Admin-internal columns from everyone using the API, including the Admin', async () => {
    await asAdmin(() => db.query(`insert into public.permission_grants (workspace_id, module, action, note) values ($1, 'paid_ads', 'view', 'private admin note')`, [ID.nova]));
    for (const column of ['note', 'granted_by', 'revoked_by']) {
      await expect(asClient(() => db.query(`select ${column} from public.permission_grants`)), column).rejects.toThrow(/permission denied/);
      await expect(asAdmin(() => db.query(`select ${column} from public.permission_grants`)), column).rejects.toThrow(/permission denied/);
    }
    await expect(asClient(() => db.query(`select created_by from public.workspaces`))).rejects.toThrow(/permission denied/);
    await expect(asClient(() => db.query(`select * from public.permission_grants`))).rejects.toThrow(/permission denied/);
    // The audit log still records who granted it.
    expect((await auditActions(ID.nova)).some((a) => a.action === 'permission.granted' && a.actor_id === ID.agencyAdmin)).toBe(true);
  });

  it('the permission rules cannot be rewritten through any API key', async () => {
    for (const table of ['permission_ceiling', 'permission_defaults', 'permission_sensitive']) {
      await expect(asService(db, () => db.query(`delete from public.${table}`)), table).rejects.toThrow(/permission denied/);
      await expect(asAdmin(() => db.query(`delete from public.${table}`)), table).rejects.toThrow(/permission denied/);
    }
    await expect(asService(db, () => db.query(
      `insert into public.permission_ceiling (role, module, action) values ('client', 'ai_assistant', 'edit')`))).rejects.toThrow(/permission denied/);
  });
});

describe('hardening: secret scrubbing is identical in TypeScript and SQL', () => {
  it('redacts the same keys and values', async () => {
    const { scrubSecrets } = await import('@/lib/permissions');
    const samples = [
      { title: 'Change budget', budget: 500, ok: true, none: null },
      { api_key: 'x', nested: { accessToken: 'y', list: [{ password: 'p', label: 'l' }] } },
      { note: 'sk_live_abcdefgh12345', memo: 'eyJhbGciOiJIUzI1NiJ9.payload.sig', detail: 'Bearer abc.def', repo: 'ghp_abcdefghijklmnop' },
      { files: ['AKIAABCDEFGHIJKLMNOP', 'a normal sentence', 'skate park'], cookie: 'c', session_id: 's', jwt: 'j', dsn: 'd' },
      { mood: 'skate', bearing: 12, description: 'refresh rate is fine' },
    ];
    for (const sample of samples) {
      const [{ out }] = await asOwner(db, () => rows<{ out: unknown }>(db, `select private.scrub_secrets($1::jsonb) as out`, [JSON.stringify(sample)]));
      expect(out, JSON.stringify(sample)).toEqual(scrubSecrets(sample));
    }
  });
});
