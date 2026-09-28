import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  ADMIN_ONLY_MODULES,
  MODULES,
  ROLES,
  aiModeFor,
  canAiExecute,
  canManagePermissions,
  ceilingActions,
  checkGrant,
  decide,
  defaultActions,
  inCeiling,
  isSensitive,
  resolveRole,
  type Action,
  type Grant,
  type Membership,
  type Module,
  type Principal,
  type Role,
  type WorkspaceRef,
} from '@/lib/permissions';

const admin: Principal = { role: 'admin', grants: [] };
const client = (grants: Grant[] = []): Principal => ({ role: 'client', grants });
const team = (grants: Grant[] = []): Principal => ({ role: 'team_member', grants });
const outsider: Principal = { role: null, grants: [] };
const g = (module: Module, action: Action): Grant => ({ module, action });

describe('Admin', () => {
  it('may do everything in a workspace they administer', () => {
    for (const m of MODULES) for (const a of ACTIONS) {
      expect(decide(admin, m, a).effect).toBe('allow');
    }
  });

  it('is asked to confirm sensitive actions and they are always audited', () => {
    const d = decide(admin, 'paid_ads', 'edit');
    expect(d).toMatchObject({ effect: 'allow', auditRequired: true, requiresConfirmation: true });
    expect(decide(admin, 'paid_ads', 'view')).toMatchObject({ auditRequired: false, requiresConfirmation: false });
  });
});

describe('a person with no access to the workspace', () => {
  it('is denied everything', () => {
    for (const m of MODULES) for (const a of ACTIONS) {
      expect(decide(outsider, m, a)).toMatchObject({ effect: 'deny', reason: 'not_a_member' });
    }
  });
});

describe('Client defaults (PRD access matrix)', () => {
  it('can view and run SEO/GEO audits and download reports, but not change anything', () => {
    expect(decide(client(), 'seo_geo', 'view').effect).toBe('allow');
    expect(decide(client(), 'seo_geo', 'create').effect).toBe('allow'); // run an audit
    expect(decide(client(), 'reports', 'view').effect).toBe('allow');
    expect(decide(client(), 'seo_geo', 'edit').effect).toBe('deny');
    expect(decide(client(), 'seo_geo', 'delete').effect).toBe('deny');
  });

  it('cannot apply SEO fixes unless an Admin grants a separate execution permission - and then only via approval', () => {
    expect(decide(client(), 'seo_geo', 'publish_execute')).toMatchObject({ effect: 'deny', reason: 'not_granted' });
    expect(decide(client([g('seo_geo', 'publish_execute')]), 'seo_geo', 'publish_execute').effect).toBe('needs_approval');
  });

  it('has Paid Ads and Domains disabled until an Admin grants them', () => {
    for (const m of ['paid_ads', 'domains'] as const) {
      expect(decide(client(), m, 'view')).toMatchObject({ effect: 'deny', reason: 'not_granted' });
      expect(decide(client(), m, 'create').effect).toBe('deny');
    }
    expect(decide(client([g('paid_ads', 'view')]), 'paid_ads', 'view').effect).toBe('allow');
  });

  it('needs approval for ad budget changes, launches, DNS changes and deletions even when granted', () => {
    const granted = client([
      g('paid_ads', 'edit'), g('paid_ads', 'publish_execute'), g('paid_ads', 'delete'),
      g('domains', 'edit'), g('domains', 'publish_execute'), g('domains', 'delete'),
    ]);
    for (const [m, a] of [
      ['paid_ads', 'edit'], ['paid_ads', 'publish_execute'], ['paid_ads', 'delete'],
      ['domains', 'edit'], ['domains', 'publish_execute'], ['domains', 'delete'],
    ] as const) {
      expect(decide(granted, m, a)).toMatchObject({ effect: 'needs_approval', auditRequired: true });
    }
  });

  it('can only preview the website and request changes - never edit or deploy it', () => {
    expect(decide(client(), 'website', 'view').effect).toBe('allow');
    expect(decide(client(), 'change_requests', 'create').effect).toBe('allow');
    const forged = client(ACTIONS.map((a) => g('website', a)));
    for (const a of ACTIONS.filter((x) => x !== 'view')) {
      expect(decide(forged, 'website', a)).toMatchObject({ effect: 'deny', reason: 'above_role_ceiling' });
    }
  });

  it('never sees agency control-centre areas, even with forged grants', () => {
    const forged = client(MODULES.flatMap((m) => ACTIONS.map((a) => g(m, a))));
    for (const m of [...ADMIN_ONLY_MODULES, 'integrations'] as const) {
      for (const a of ACTIONS) expect(decide(forged, m, a).effect).toBe('deny');
    }
  });

  it('billing is off until enabled', () => {
    expect(decide(client(), 'billing', 'view').effect).toBe('deny');
    expect(decide(client([g('billing', 'view')]), 'billing', 'view').effect).toBe('allow');
    expect(decide(client([g('billing', 'billing')]), 'billing', 'billing').effect).toBe('needs_approval');
  });
});

describe('AI assistant is read-only for everyone except Admin (non-negotiable)', () => {
  it('lets Client and Team member ask questions but nothing else, even with forged grants', () => {
    for (const p of [client(ACTIONS.map((a) => g('ai_assistant', a))), team(ACTIONS.map((a) => g('ai_assistant', a)))]) {
      expect(decide(p, 'ai_assistant', 'view').effect).toBe('allow');
      for (const a of ACTIONS.filter((x) => x !== 'view')) {
        expect(decide(p, 'ai_assistant', a).effect).toBe('deny');
      }
    }
  });

  it('reports the AI mode per role', () => {
    expect(aiModeFor('admin')).toBe('full');
    expect(aiModeFor('client')).toBe('read_only');
    expect(aiModeFor('team_member')).toBe('read_only');
    expect(aiModeFor(null)).toBe('none');
    expect(canAiExecute('admin')).toBe(true);
    expect(canAiExecute('client')).toBe(false);
    expect(canAiExecute('team_member')).toBe(false);
    expect(canAiExecute(null)).toBe(false);
  });
});

describe('Only Admin can grant, revoke or change permissions', () => {
  it('nobody else can ever hold grant_permission, on any module', () => {
    const forgedClient = client(MODULES.map((m) => g(m, 'grant_permission')));
    const forgedTeam = team(MODULES.map((m) => g(m, 'grant_permission')));
    for (const m of MODULES) {
      expect(decide(forgedClient, m, 'grant_permission').effect).toBe('deny');
      expect(decide(forgedTeam, m, 'grant_permission').effect).toBe('deny');
    }
  });

  it('canManagePermissions is Admin only', () => {
    expect(canManagePermissions('admin')).toBe(true);
    expect(canManagePermissions('team_member')).toBe(false);
    expect(canManagePermissions('client')).toBe(false);
    expect(canManagePermissions(null)).toBe(false);
  });

  it('checkGrant rejects anything above the ceiling and grants to Admins', () => {
    expect(checkGrant('client', 'paid_ads', 'view')).toEqual({ ok: true });
    expect(checkGrant('client', 'ai_assistant', 'edit')).toEqual({ ok: false, reason: 'above_role_ceiling' });
    expect(checkGrant('client', 'website', 'publish_execute')).toEqual({ ok: false, reason: 'above_role_ceiling' });
    expect(checkGrant('team_member', 'settings', 'view')).toEqual({ ok: false, reason: 'above_role_ceiling' });
    expect(checkGrant('team_member', 'leads_crm', 'grant_permission')).toEqual({ ok: false, reason: 'above_role_ceiling' });
    expect(checkGrant('admin', 'paid_ads', 'view')).toEqual({ ok: false, reason: 'admin_needs_no_grant' });
  });
});

describe('Team member', () => {
  it('starts with nothing', () => {
    for (const m of MODULES) for (const a of ACTIONS) {
      expect(decide(team(), m, a).effect).toBe('deny');
    }
  });

  it('gets exactly what an Admin grants, inside the ceiling', () => {
    const t = team([g('leads_crm', 'edit'), g('social', 'create'), g('leads_crm', 'delete')]);
    expect(decide(t, 'leads_crm', 'edit').effect).toBe('allow');
    expect(decide(t, 'social', 'create').effect).toBe('allow');
    expect(decide(t, 'leads_crm', 'delete').effect).toBe('needs_approval');
    expect(decide(t, 'leads_crm', 'view').effect).toBe('deny');
  });

  it('can manage integrations only on the integrations module, and only via approval', () => {
    expect(decide(team([g('integrations', 'manage_integration')]), 'integrations', 'manage_integration').effect).toBe('needs_approval');
    expect(decide(team([g('paid_ads', 'manage_integration')]), 'paid_ads', 'manage_integration').effect).toBe('deny');
  });

  it('can never touch settings, client management, audit log, health monitor or approvals decisions', () => {
    const forged = team(ADMIN_ONLY_MODULES.flatMap((m) => ACTIONS.map((a) => g(m, a))));
    for (const m of ADMIN_ONLY_MODULES) for (const a of ACTIONS) {
      expect(decide(forged, m, a).effect).toBe('deny');
    }
  });
});

describe('workspace-level approval policy', () => {
  it('lets an Admin force extra actions through approval', () => {
    const c = client([g('social', 'create')]);
    expect(decide(c, 'social', 'create').effect).toBe('allow');
    expect(decide(c, 'social', 'create', { approvalPolicy: ['social:create'] }).effect).toBe('needs_approval');
    expect(decide(c, 'social', 'view', { approvalPolicy: ['social:create'] }).effect).toBe('allow');
  });
});

describe('tenant isolation', () => {
  const acme: WorkspaceRef = { id: 'acme', kind: 'agency', parentId: null };
  const nova: WorkspaceRef = { id: 'nova', kind: 'client', parentId: 'acme' };
  const bright: WorkspaceRef = { id: 'bright', kind: 'client', parentId: 'acme' };
  const otherAgency: WorkspaceRef = { id: 'other', kind: 'agency', parentId: null };
  const otherClient: WorkspaceRef = { id: 'otherClient', kind: 'client', parentId: 'other' };
  const inAcme = (role: Role): Membership[] => [{ workspaceId: 'acme', role }];

  it('an agency Admin or Team member reaches their own client workspaces', () => {
    expect(resolveRole(inAcme('admin'), nova)).toBe('admin');
    expect(resolveRole(inAcme('admin'), bright)).toBe('admin');
    expect(resolveRole(inAcme('team_member'), nova)).toBe('team_member');
  });

  it('cannot reach another agency or its clients', () => {
    expect(resolveRole(inAcme('admin'), otherAgency)).toBeNull();
    expect(resolveRole(inAcme('admin'), otherClient)).toBeNull();
  });

  it('the most powerful role wins, so a lower direct membership cannot demote an agency Admin', () => {
    const both: Membership[] = [
      { workspaceId: 'acme', role: 'admin' },
      { workspaceId: 'nova', role: 'client' },
    ];
    expect(resolveRole(both, nova)).toBe('admin');
    expect(resolveRole([{ workspaceId: 'acme', role: 'team_member' }, { workspaceId: 'nova', role: 'client' }], nova)).toBe('team_member');
  });

  it('a client sees only their own workspace - not a sibling, not the agency', () => {
    const m: Membership[] = [{ workspaceId: 'nova', role: 'client' }];
    expect(resolveRole(m, nova)).toBe('client');
    expect(resolveRole(m, bright)).toBeNull();
    expect(resolveRole(m, acme)).toBeNull();
  });
});

describe('policy invariants over the whole matrix', () => {
  const everyGrant = (): Grant[] => MODULES.flatMap((m) => ACTIONS.map((a) => g(m, a)));

  it('defaults never exceed the ceiling', () => {
    for (const r of ROLES) for (const m of MODULES) {
      for (const a of defaultActions(r, m)) expect(inCeiling(r, m, a)).toBe(true);
    }
  });

  it('a non-admin never gets a direct "allow" for a sensitive action', () => {
    for (const role of ['client', 'team_member'] as const) {
      const p: Principal = { role, grants: everyGrant() };
      for (const m of MODULES) for (const a of ACTIONS) {
        if (isSensitive(m, a)) expect(decide(p, m, a).effect).not.toBe('allow');
      }
    }
  });

  it('nothing above the ceiling is ever permitted, even if every grant exists', () => {
    for (const role of ['client', 'team_member'] as const) {
      const p: Principal = { role, grants: everyGrant() };
      for (const m of MODULES) for (const a of ACTIONS) {
        if (!ceilingActions(role, m).includes(a)) expect(decide(p, m, a).effect).toBe('deny');
      }
    }
  });

  it('no grants means only defaults, and only defaults that are not sensitive are direct allows', () => {
    for (const role of ['client', 'team_member'] as const) {
      const p: Principal = { role, grants: [] };
      for (const m of MODULES) for (const a of ACTIONS) {
        const isDefault = defaultActions(role, m).includes(a);
        const effect = decide(p, m, a).effect;
        if (!isDefault) expect(effect).toBe('deny');
        else expect(effect).toBe(isSensitive(m, a) ? 'needs_approval' : 'allow');
      }
    }
  });

  it('every sensitive action is flagged for audit and confirmation when not denied', () => {
    for (const m of MODULES) for (const a of ACTIONS) {
      const d = decide(admin, m, a);
      expect(d.auditRequired).toBe(isSensitive(m, a));
      expect(d.requiresConfirmation).toBe(isSensitive(m, a));
    }
  });
});
